import { z } from "zod";
import type { WebSearchInput, WebSearchResponse, WebSearchResult } from "../shared/intelligence.ts";
import { getWebSearchRuntimeConfig, type WebSearchRuntimeConfig } from "./runtime-config.ts";

const webSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(500),
  topic: z.enum(["general", "news"]).default("general"),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  maxResults: z.number().int().min(1).max(8).default(5),
  includeDomains: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  excludeDomains: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
});

const tavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().catch("未命名来源"),
    url: z.string().url(),
    content: z.string().catch(""),
    score: z.number().optional(),
    published_date: z.string().nullish(),
  }).passthrough()).default([]),
}).passthrough();

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; response: WebSearchResponse }>();
const pendingSearches = new Map<string, Promise<WebSearchResponse>>();

function cloneSearchResponse(response: WebSearchResponse): WebSearchResponse {
  return {
    ...response,
    results: response.results.map((result) => ({ ...result })),
  };
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/search") ? normalized : `${normalized}/search`;
}

function sourceName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeResults(items: z.infer<typeof tavilyResponseSchema>["results"]): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of items) {
    const url = item.url.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title.trim() || sourceName(url),
      url,
      source: sourceName(url),
      snippet: item.content.trim().slice(0, 1_200),
      publishedAt: item.published_date?.trim() || undefined,
      score: item.score,
    });
  }
  return results;
}

export function hasWebSearchConfiguration(): boolean {
  return Boolean(getWebSearchRuntimeConfig().apiKey);
}

export function inferExplicitWebSearch(text: string): WebSearchInput | undefined {
  const normalized = text.trim();
  const explicit = /(?:联网|互联网|网上|网页|搜索引擎).{0,12}(?:搜索|查|检索|找)|(?:搜索|查|检索|找).{0,12}(?:联网|互联网|网上|网页|搜索引擎)/i.test(normalized);
  if (!explicit) return undefined;
  const query = normalized
    .replace(/^(?:请|帮我|麻烦你|你来|给我)*\s*(?:联网|互联网|网上|用搜索引擎)\s*(?:搜索|查询|查|检索|找一下)?\s*/i, "")
    .trim();
  const timeRange = /(?:今天|当天|24\s*小时)/.test(normalized) ? "day"
    : /(?:近\s*7\s*天|本周|这周)/.test(normalized) ? "week"
      : /(?:近\s*30\s*天|本月|这个月)/.test(normalized) ? "month"
        : undefined;
  return {
    query: query.length >= 2 ? query : normalized,
    topic: /(?:新闻|最新消息|最新动态|热点)/.test(normalized) ? "news" : "general",
    timeRange,
    maxResults: 6,
  };
}

export function needsDeepWebAnalysis(text: string): boolean {
  return /(?:分析|比较|对比|判断|建议|策略|方案|影响|风险|原因|结论|总结|值不值得|怎么做|如何做|优先级)/i.test(text);
}

export async function searchWeb(
  input: WebSearchInput,
  config: WebSearchRuntimeConfig = getWebSearchRuntimeConfig(),
): Promise<WebSearchResponse> {
  const parsed = webSearchInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("搜索条件不完整，请输入至少两个字。");
  if (!config.apiKey) throw new Error("互联网搜索尚未配置，请先在 Skill 管理中填写 Tavily API Key。");

  const cacheKey = JSON.stringify({ endpoint: endpoint(config.baseUrl), apiKey: config.apiKey, ...parsed.data });
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cloneSearchResponse(cached.response);
  if (cached) searchCache.delete(cacheKey);
  const pending = pendingSearches.get(cacheKey);
  if (pending) return cloneSearchResponse(await pending);

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: parsed.data.query,
        topic: parsed.data.topic,
        search_depth: "basic",
        max_results: parsed.data.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        ...(parsed.data.timeRange ? { time_range: parsed.data.timeRange } : {}),
        ...(parsed.data.includeDomains?.length ? { include_domains: parsed.data.includeDomains } : {}),
        ...(parsed.data.excludeDomains?.length ? { exclude_domains: parsed.data.excludeDomains } : {}),
      }),
      signal: controller.signal,
    });
      const text = await response.text();
      if (!response.ok) {
        let detail = "";
        try {
          const body = JSON.parse(text) as { detail?: { error?: string } | string; message?: string };
          detail = typeof body.detail === "string" ? body.detail : body.detail?.error ?? body.message ?? "";
        } catch {
          detail = text.slice(0, 180);
        }
        throw new Error(`联网搜索失败（${response.status}）${detail ? `：${detail}` : ""}`);
      }
      const providerResult = tavilyResponseSchema.safeParse(JSON.parse(text));
      if (!providerResult.success) throw new Error("搜索服务返回了无法识别的数据。");
      const result = {
        query: parsed.data.query,
        searchedAt: new Date().toISOString(),
        results: normalizeResults(providerResult.data.results),
      };
      searchCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, response: result });
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("联网搜索超时，请稍后重试。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })();
  pendingSearches.set(cacheKey, request);
  try {
    return cloneSearchResponse(await request);
  } finally {
    pendingSearches.delete(cacheKey);
  }
}

export function formatWebSearchForLlm(response: WebSearchResponse): string {
  if (!response.results.length) return `联网搜索“${response.query}”没有找到可用结果。`;
  const lines = response.results.map((result, index) => [
    `[来源${index + 1}] ${result.title}`,
    `网址：${result.url}`,
    `来源：${result.source}${result.publishedAt ? `，发布时间：${result.publishedAt}` : ""}`,
    `摘要：${result.snippet || "无摘要"}`,
  ].join("\n"));
  return `联网搜索主题：${response.query}\n检索时间：${response.searchedAt}\n${lines.join("\n\n")}\n\n回答时请区分事实与推断，并在结尾保留实际使用的来源标题和网址。`;
}

export function formatWebSearchForUser(response: WebSearchResponse): string {
  if (!response.results.length) return `没有找到与“${response.query}”相关的可靠结果。`;
  const results = response.results.slice(0, 6).map((result, index) => [
    `${index + 1}. ${result.title}`,
    result.snippet ? result.snippet.slice(0, 320) : "该来源没有提供摘要。",
    `来源：${result.source}${result.publishedAt ? `，${result.publishedAt}` : ""}`,
    `网址：${result.url}`,
  ].join("\n")).join("\n\n");
  return `已联网搜索“${response.query}”。以下是可进一步核对的来源：\n\n${results}`;
}

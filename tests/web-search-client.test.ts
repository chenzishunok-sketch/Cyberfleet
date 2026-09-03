import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWebSearchForLlm, inferExplicitWebSearch, needsDeepWebAnalysis, searchWeb } from "../server/web-search-client.ts";

describe("web search client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the supported Tavily search options and normalizes cited results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [
        {
          title: "TikTok Shop fee update",
          url: "https://seller.example.com/policy/fees",
          content: "The fee policy changed.",
          score: 0.91,
          published_date: "2026-07-20",
        },
        {
          title: "Duplicate",
          url: "https://seller.example.com/policy/fees",
          content: "Duplicate URL",
          score: 0.8,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await searchWeb({
      query: "TikTok Shop Thailand latest fees",
      topic: "news",
      timeRange: "month",
      maxResults: 6,
    }, {
      apiKey: "tvly-test-key",
      baseUrl: "https://api.tavily.test",
      source: "skill",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.test/search");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tvly-test-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: "TikTok Shop Thailand latest fees",
      topic: "news",
      time_range: "month",
      max_results: 6,
      include_raw_content: false,
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      source: "seller.example.com",
      publishedAt: "2026-07-20",
      url: "https://seller.example.com/policy/fees",
    });
    expect(formatWebSearchForLlm(result)).toContain("网址：https://seller.example.com/policy/fees");
  });

  it("fails clearly when the search key is missing", async () => {
    await expect(searchWeb({ query: "latest policy" }, {
      apiKey: "",
      baseUrl: "https://api.tavily.com",
      source: "missing",
    })).rejects.toThrow("互联网搜索尚未配置");
  });

  it("does not hide provider authentication errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      detail: { error: "Invalid API key" },
    }), { status: 401, headers: { "content-type": "application/json" } }));

    await expect(searchWeb({ query: "latest policy" }, {
      apiKey: "invalid",
      baseUrl: "https://api.tavily.com",
      source: "skill",
    })).rejects.toThrow("联网搜索失败（401）：Invalid API key");
  });

  it("recognizes an explicit natural-language web search request", () => {
    expect(inferExplicitWebSearch("请联网搜索 TikTok Shop 泰国站最新政策")).toMatchObject({
      query: "TikTok Shop 泰国站最新政策",
      maxResults: 6,
    });
    expect(inferExplicitWebSearch("查询店铺近 7 天订单")).toBeUndefined();
    expect(needsDeepWebAnalysis("请联网搜索最新政策并附来源")).toBe(false);
    expect(needsDeepWebAnalysis("请联网搜索并分析这项政策对利润的影响")).toBe(true);
  });

  it("reuses the same recent search instead of calling the provider twice", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "Cached result", url: "https://example.com/cache-test", content: "Cached content" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const config = { apiKey: "tvly-cache-test", baseUrl: "https://api.tavily.test", source: "skill" as const };

    const first = await searchWeb({ query: "unique cache behavior test" }, config);
    const second = await searchWeb({ query: "unique cache behavior test" }, config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});

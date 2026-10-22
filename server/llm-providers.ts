import { randomUUID } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmProviderSummary, LlmProvidersOverview, LlmProviderTestResult } from "../shared/contracts.ts";

const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const MASK_HINT = "*";

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  fastModel: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const llmProvidersStoreSchema = z.object({
  version: z.literal(1),
  activeId: z.string().nullable(),
  providers: z.array(providerSchema),
});

type LlmProvider = z.infer<typeof providerSchema>;

interface LlmProvidersStore {
  version: 1;
  activeId: string | null;
  providers: LlmProvider[];
}

export interface LlmProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
}

export interface LlmRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel: string;
  source: "provider" | "env" | "missing";
  providerName?: string;
}

const EMPTY_STORE: LlmProvidersStore = { version: 1, activeId: null, providers: [] };

export function llmProvidersStorePath(): string {
  const configured = process.env.LLM_PROVIDERS_STORE?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".data", "llm-providers.json");
}

export function maskSecret(value: string): string {
  if (!value) return "";
  return value.length > 4 ? `${value.slice(0, 2)}${MASK_HINT.repeat(value.length - 4)}${value.slice(-2)}` : MASK_HINT.repeat(4);
}

/** 供应商 Key 可能被上游错误信息回显，统一打码后再返回给前端 */
function sanitizeSecretText(text: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return text;
  return text.split(trimmed).join(maskSecret(trimmed));
}

// LLM 每次请求都要解析生效配置：按 mtime 缓存同步读盘，向导保存后立即生效
let storeCache: { mtimeMs: number; store: LlmProvidersStore } | undefined;

function readStoreSync(): LlmProvidersStore {
  const filePath = llmProvidersStorePath();
  if (!existsSync(filePath)) {
    storeCache = undefined;
    return EMPTY_STORE;
  }
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    if (!storeCache || storeCache.mtimeMs !== mtimeMs) {
      const parsed = llmProvidersStoreSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
      storeCache = { mtimeMs, store: parsed.success ? parsed.data : EMPTY_STORE };
    }
    return storeCache.store;
  } catch {
    storeCache = undefined;
    return EMPTY_STORE;
  }
}

async function writeStore(store: LlmProvidersStore): Promise<void> {
  const filePath = llmProvidersStorePath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    storeCache = { mtimeMs: statSync(filePath).mtimeMs, store };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    storeCache = undefined;
    throw error;
  }
}

function toSummary(provider: LlmProvider): LlmProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKeyMasked: maskSecret(provider.apiKey),
    model: provider.model,
    ...(provider.fastModel ? { fastModel: provider.fastModel } : {}),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Base URL 必须以 http(s):// 开头，例如 https://api.deepseek.com/v1。");
  }
  return trimmed;
}

/** 当前生效的大模型配置：激活的供应商 > .env > missing */
export function getLlmRuntimeConfig(): LlmRuntimeConfig {
  const store = readStoreSync();
  const active = store.activeId ? store.providers.find((provider) => provider.id === store.activeId) : undefined;
  if (active) {
    return {
      baseUrl: active.baseUrl.replace(/\/$/, ""),
      apiKey: active.apiKey,
      model: active.model,
      fastModel: active.fastModel?.trim() || active.model,
      source: "provider",
      providerName: active.name,
    };
  }

  const envApiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const envModel = process.env.LLM_MODEL?.trim() ?? "";
  if (envApiKey && envModel) {
    return {
      baseUrl: (process.env.LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL).replace(/\/$/, ""),
      apiKey: envApiKey,
      model: envModel,
      fastModel: process.env.LLM_FAST_MODEL?.trim() || envModel,
      source: "env",
    };
  }
  return { baseUrl: DEFAULT_LLM_BASE_URL, apiKey: "", model: "", fastModel: "", source: "missing" };
}

export function getLlmProvidersOverview(): LlmProvidersOverview {
  const store = readStoreSync();
  const config = getLlmRuntimeConfig();
  const connected = Boolean(config.apiKey && config.model) && process.env.DEMO_MODE !== "true";
  return {
    providers: store.providers.map(toSummary),
    activeId: store.activeId,
    source: config.source,
    connected,
    ...(config.source === "provider"
      ? { name: config.providerName, model: config.model }
      : config.source === "env"
        ? { name: ".env 配置", model: config.model }
        : {}),
    ...(config.source !== "missing"
      ? {
          baseUrl: config.baseUrl,
          ...(config.fastModel !== config.model ? { fastModel: config.fastModel } : {}),
        }
      : {}),
  };
}

/** 把当前 .env 的模型配置导入为界面可管理的服务（保留原 env 作为回落），并设为当前使用 */
export async function importEnvProvider(): Promise<LlmProviderSummary> {
  const config = getLlmRuntimeConfig();
  if (!config.apiKey || !config.model || config.source !== "env") {
    throw new Error("当前没有可导入的 .env 模型配置，请先在 .env 中配置 LLM_API_KEY 与 LLM_MODEL。");
  }
  return addProvider({
    name: ".env 导入",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.fastModel && config.fastModel !== config.model ? { fastModel: config.fastModel } : {}),
  });
}

export async function addProvider(input: LlmProviderInput): Promise<LlmProviderSummary> {
  const store = readStoreSync();
  const now = new Date().toISOString();
  const provider: LlmProvider = {
    id: randomUUID(),
    name: input.name.trim(),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey.trim(),
    model: input.model.trim(),
    ...(input.fastModel?.trim() ? { fastModel: input.fastModel.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
  // 第一个绑定的服务自动设为当前使用
  await writeStore({ version: 1, activeId: store.activeId ?? provider.id, providers: [...store.providers, provider] });
  return toSummary(provider);
}

export async function updateProvider(id: string, input: Partial<LlmProviderInput>): Promise<LlmProviderSummary> {
  const store = readStoreSync();
  const existing = store.providers.find((provider) => provider.id === id);
  if (!existing) throw new Error("没有找到这个模型服务。");
  // apiKey 留空或带回显掩码时保持原值，避免把脱敏串当成新密钥写入
  const apiKey = input.apiKey !== undefined && input.apiKey.trim() && !input.apiKey.includes(MASK_HINT)
    ? input.apiKey.trim()
    : existing.apiKey;
  const fastModel = input.fastModel !== undefined
    ? (input.fastModel.trim() || undefined)
    : existing.fastModel;
  const updated: LlmProvider = {
    ...existing,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.baseUrl?.trim() ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
    apiKey,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(fastModel ? { fastModel } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeStore({ ...store, providers: store.providers.map((provider) => provider.id === id ? updated : provider) });
  return toSummary(updated);
}

export async function removeProvider(id: string): Promise<void> {
  const store = readStoreSync();
  const providers = store.providers.filter((provider) => provider.id !== id);
  if (providers.length === store.providers.length) throw new Error("没有找到这个模型服务。");
  // 解绑当前使用的服务后回落到 .env 配置（如无则规则路由）
  await writeStore({ version: 1, activeId: store.activeId === id ? null : store.activeId, providers });
}

export async function activateProvider(id: string): Promise<LlmProviderSummary> {
  const store = readStoreSync();
  const provider = store.providers.find((item) => item.id === id);
  if (!provider) throw new Error("没有找到这个模型服务。");
  await writeStore({ ...store, activeId: id });
  return toSummary(provider);
}

/** 供测试连接端点复用已保存的完整凭证（含明文 Key，仅服务端内存使用） */
export function getStoredProvider(id: string): LlmProvider | undefined {
  return readStoreSync().providers.find((provider) => provider.id === id);
}

export async function testLlmProvider(input: { baseUrl: string; apiKey: string; model: string }): Promise<LlmProviderTestResult> {
  const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, latencyMs: 0, error: "Base URL 必须以 http(s):// 开头。" };
  if (!apiKey) return { ok: false, latencyMs: 0, error: "请先填写 API Key。" };
  if (!model) return { ok: false, latencyMs: 0, error: "请先填写模型名称。" };

  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "请只回复：连接成功" }], max_tokens: 16, temperature: 0 }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - startedAt;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    if (!response.ok) {
      const upstreamError = record.error;
      const message = upstreamError && typeof upstreamError === "object"
        ? String((upstreamError as Record<string, unknown>).message ?? `HTTP ${response.status}`)
        : typeof record.message === "string" ? record.message : `HTTP ${response.status}`;
      return { ok: false, latencyMs, error: sanitizeSecretText(message || `HTTP ${response.status}`, apiKey) };
    }
    const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message;
    const reply = message && typeof message === "object" ? String((message as Record<string, unknown>).content ?? "").trim() : "";
    return { ok: true, latencyMs, ...(reply ? { reply } : {}) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "连接失败。";
    return { ok: false, latencyMs: Date.now() - startedAt, error: sanitizeSecretText(`无法连接 ${baseUrl}：${detail}`, apiKey) };
  }
}

export async function listProviderModels(input: { baseUrl: string; apiKey: string }): Promise<{ models: string[]; error?: string }> {
  const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
  const apiKey = input.apiKey.trim();
  if (!/^https?:\/\//i.test(baseUrl) || !apiKey) return { models: [], error: "请先填写 Base URL 和 API Key。" };
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { models: [], error: `拉取模型列表失败（HTTP ${response.status}），可手动填写模型名。` };
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const data = Array.isArray(payload.data) ? payload.data as Array<Record<string, unknown>> : [];
    const models = data
      .map((item) => typeof item.id === "string" ? item.id : "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return { models };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "拉取失败。";
    return { models: [], error: sanitizeSecretText(`无法读取模型列表：${detail}，可手动填写模型名。`, apiKey) };
  }
}

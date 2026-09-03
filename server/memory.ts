import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MEMORY_PATH = join(__dirname, "..", ".data", "memory.json");
const MAX_CONTENT_LENGTH = 2_000;

function memoryPath(): string {
  return resolve(process.env.AGENT_MEMORY_PATH?.trim() || DEFAULT_MEMORY_PATH);
}

// ─── 记忆结构 ────────────────────────────────────────────────

export interface MemoryEntry {
  content: string;
  createdAt: string;
}

export interface AgentMemory {
  /** 用户偏好：如"关注退款率"、"经常查库存" */
  userPreferences: MemoryEntry[];
  /** 操作记录摘要：如"2024-07-27 补货 SKU-A 500件" */
  operationHistory: MemoryEntry[];
  /** 店铺观察：如"周末订单量通常翻倍" */
  shopInsights: MemoryEntry[];
}

const memoryEntrySchema = z.object({
  content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  createdAt: z.string().datetime(),
});

function sanitizeEntries(value: unknown, limit: number): MemoryEntry[] {
  if (!Array.isArray(value)) return [];

  const valid = value.flatMap((entry) => {
    const parsed = memoryEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });

  const seen = new Set<string>();
  return valid
    .slice()
    .reverse()
    .filter((entry) => {
      if (seen.has(entry.content)) return false;
      seen.add(entry.content);
      return true;
    })
    .reverse()
    .slice(-limit);
}

export function sanitizeMemory(value: unknown): AgentMemory {
  const source = value && typeof value === "object" ? value as Partial<Record<keyof AgentMemory, unknown>> : {};
  return {
    userPreferences: sanitizeEntries(source.userPreferences, 30),
    operationHistory: sanitizeEntries(source.operationHistory, 50),
    shopInsights: sanitizeEntries(source.shopInsights, 30),
  };
}

function normalizeContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const content = value.trim();
  return content && content.length <= MAX_CONTENT_LENGTH ? content : undefined;
}

// ─── 读写 ────────────────────────────────────────────────────

// loadMemory 在每次对话请求都会调用：按 mtime 缓存，避免重复读盘 + JSON 解析
let memoryCache: { mtimeMs: number; memory: AgentMemory } | undefined;

function readMemoryFromDisk(path: string): AgentMemory {
  return sanitizeMemory(JSON.parse(readFileSync(path, "utf-8")));
}

export function loadMemory(): AgentMemory {
  const path = memoryPath();
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (memoryCache && memoryCache.mtimeMs === mtimeMs) return memoryCache.memory;
    const memory = readMemoryFromDisk(path);
    memoryCache = { mtimeMs, memory };
    return memory;
  } catch {
    memoryCache = undefined;
    return { userPreferences: [], operationHistory: [], shopInsights: [] };
  }
}

export function saveMemory(memory: AgentMemory): void {
  const path = memoryPath();
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const sanitized = sanitizeMemory(memory);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(sanitized, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(temporaryPath, path);
  try {
    memoryCache = { mtimeMs: statSync(path).mtimeMs, memory: sanitized };
  } catch {
    memoryCache = undefined;
  }
}

// ─── 格式化为 LLM 可读的上下文 ────────────────────────────────

export function formatMemoryForPrompt(memory: AgentMemory): string {
  const validMemory = sanitizeMemory(memory);
  const sections: string[] = [];

  if (validMemory.userPreferences.length) {
    const items = validMemory.userPreferences.slice(-5).map((e) => e.content).join("；");
    sections.push(`用户偏好：${items}`);
  }
  if (validMemory.operationHistory.length) {
    const items = validMemory.operationHistory.slice(-5).map((e) => e.content).join("；");
    sections.push(`近期操作：${items}`);
  }
  if (validMemory.shopInsights.length) {
    const items = validMemory.shopInsights.slice(-5).map((e) => e.content).join("；");
    sections.push(`店铺观察：${items}`);
  }

  return sections.length
    ? `\n[长期记忆]\n${sections.join("\n")}\n`
    : "";
}

// ─── 记录操作到记忆 ──────────────────────────────────────────

export function recordOperation(summary: string): void {
  const content = normalizeContent(summary);
  if (!content) return;
  const memory = loadMemory();
  memory.operationHistory.push({ content, createdAt: new Date().toISOString() });
  saveMemory(memory);
}

// ─── 更新偏好（去重） ────────────────────────────────────────

export function addInsight(insight: string): void {
  const content = normalizeContent(insight);
  if (!content) return;
  const memory = loadMemory();
  // 避免重复
  if (memory.shopInsights.some((e) => e.content === content)) return;
  memory.shopInsights.push({ content, createdAt: new Date().toISOString() });
  saveMemory(memory);
}

export function addPreference(pref: string): void {
  const content = normalizeContent(pref);
  if (!content) return;
  const memory = loadMemory();
  if (memory.userPreferences.some((e) => e.content === content)) return;
  memory.userPreferences.push({ content, createdAt: new Date().toISOString() });
  saveMemory(memory);
}

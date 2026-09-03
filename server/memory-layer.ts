import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContext } from "../shared/digital-employees.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAYER_PATH = join(__dirname, "..", ".data", "memory-layer.json");

function layerPath(): string {
  return resolve(process.env.AGENT_MEMORY_LAYER_PATH?.trim() || DEFAULT_LAYER_PATH);
}

// ─── 类型定义 ──────────────────────────────────────────────────

export interface LayeredMemoryEntry {
  id: string;
  content: string;
  createdAt: string;
  /** 来源 Agent */
  sourceAgent: string;
  /** 记忆重要性 0-1，影响衰减和检索排序 */
  weight: number;
  /** 访问次数，每次被检索到时 +1 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessedAt?: string;
  /** 标签（用于分类过滤） */
  tags?: string[];
}

export interface AgentMemoryLayer {
  /** 私有记忆：按 Agent 隔离 */
  private: Record<string, LayeredMemoryEntry[]>;
  /** 共享记忆：所有 Agent 可读 */
  shared: LayeredMemoryEntry[];
}

// ─── TF-IDF 语义检索（轻量级，无外部依赖） ─────────────────────

/** 分词：中文按 2-gram，英文按单词 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ");
  const tokens: string[] = [];
  // 英文单词
  const englishWords = normalized.match(/[a-z]+/g) ?? [];
  tokens.push(...englishWords.filter((w) => w.length >= 2));
  // 中文 2-gram
  const chineseChars = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const segment of chineseChars) {
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.push(segment.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 计算文档的 TF 向量 */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  // 归一化
  const total = tokens.length || 1;
  for (const [key, value] of tf) {
    tf.set(key, value / total);
  }
  return tf;
}

/** 计算余弦相似度 */
function cosineSimilarity(vecA: Map<string, number>, vecB: Map<string, number>): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const allKeys = new Set([...vecA.keys(), ...vecB.keys()]);
  for (const key of allKeys) {
    const a = vecA.get(key) ?? 0;
    const b = vecB.get(key) ?? 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

// ─── 记忆衰减 ──────────────────────────────────────────────────

/** 根据年龄（天）计算衰减因子 */
function decayFactor(createdAt: string, weight: number): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  // 半衰期 30 天，重要性越高衰减越慢
  const halfLife = 30 * (0.5 + weight * 0.5);
  return Math.pow(0.5, ageDays / halfLife);
}

// ─── 持久化 ────────────────────────────────────────────────────

class MemoryLayerStore {
  private data: AgentMemoryLayer = { private: {}, shared: [] };
  private cache: AgentMemoryLayer | undefined;
  private lastLoadTime = 0;
  private readonly cacheTTL = 10_000; // 10 秒缓存
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor() {
    // 检索命中会更新访问计数，写盘做 2 秒合并；进程退出时同步落盘防丢
    process.on("exit", () => this.flush());
  }

  private load(): AgentMemoryLayer {
    // 10 秒内用缓存
    if (this.cache && Date.now() - this.lastLoadTime < this.cacheTTL) {
      return this.cache;
    }
    try {
      const path = layerPath();
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch {
      this.data = { private: {}, shared: [] };
    }
    this.cache = this.data;
    this.lastLoadTime = Date.now();
    return this.data;
  }

  private persist(): void {
    this.dirty = true;
    this.cache = this.data;
    this.lastLoadTime = Date.now();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 2_000);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.dirty) return;
    const path = layerPath();
    const dir = dirname(path);
    try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
    this.dirty = false;
  }

  /** 添加私有记忆（特定 Agent） */
  addPrivate(agent: string, content: string, tags?: string[]): void {
    if (!content?.trim()) return;
    const data = this.load();
    if (!data.private[agent]) data.private[agent] = [];
    const entry: LayeredMemoryEntry = {
      id: `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: content.slice(0, 2000),
      createdAt: new Date().toISOString(),
      sourceAgent: agent,
      weight: 0.7,
      accessCount: 0,
      tags,
    };
    data.private[agent].push(entry);
    // 限制每 Agent 最多 100 条
    if (data.private[agent].length > 100) {
      data.private[agent] = data.private[agent].slice(-100);
    }
    this.persist();
  }

  /** 添加共享记忆（所有 Agent 可读） */
  addShared(agent: string, content: string, tags?: string[]): void {
    if (!content?.trim()) return;
    const data = this.load();
    // 去重
    if (data.shared.some((e) => e.content === content)) return;
    const entry: LayeredMemoryEntry = {
      id: `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: content.slice(0, 2000),
      createdAt: new Date().toISOString(),
      sourceAgent: agent,
      weight: 0.8,
      accessCount: 0,
      tags,
    };
    data.shared.push(entry);
    // 限制共享记忆最多 200 条
    if (data.shared.length > 200) {
      data.shared = data.shared.slice(-200);
    }
    this.persist();
  }

  /**
   * 语义检索：根据查询文本检索相关记忆
   * 返回私有记忆 + 共享记忆的混合结果
   */
  retrieve(query: string, agent: string, limit = 5): LayeredMemoryEntry[] {
    const data = this.load();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const queryTf = termFrequency(queryTokens);

    const candidates: Array<{ entry: LayeredMemoryEntry; score: number }> = [];

    // 检索当前 Agent 的私有记忆
    const privateMemories = data.private[agent] ?? [];
    for (const entry of privateMemories) {
      const entryTf = termFrequency(tokenize(entry.content));
      const similarity = cosineSimilarity(queryTf, entryTf);
      if (similarity > 0.05) {
        const decay = decayFactor(entry.createdAt, entry.weight);
        const score = similarity * decay * (1 + entry.accessCount * 0.1);
        candidates.push({ entry, score });
      }
    }

    // 检索共享记忆
    for (const entry of data.shared) {
      const entryTf = termFrequency(tokenize(entry.content));
      const similarity = cosineSimilarity(queryTf, entryTf);
      if (similarity > 0.05) {
        const decay = decayFactor(entry.createdAt, entry.weight);
        const score = similarity * decay * (1 + entry.accessCount * 0.1) * 0.9; // 共享记忆略降权
        candidates.push({ entry, score });
      }
    }

    // 按分数排序，取 top N
    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, limit);

    // 更新访问计数（异步持久化）
    for (const { entry } of results) {
      entry.accessCount += 1;
      entry.lastAccessedAt = new Date().toISOString();
    }
    if (results.length > 0) this.persist();

    return results.map((r) => r.entry);
  }

  /** 格式化检索结果为 LLM 可读的上下文 */
  formatForPrompt(query: string, agent: string, limit = 5): string {
    const results = this.retrieve(query, agent, limit);
    if (results.length === 0) return "";

    const lines = results.map((entry, i) => {
      const age = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const ageLabel = age < 1 ? "今天" : age < 30 ? `${age}天前` : `${Math.round(age / 30)}个月前`;
      const scope = entry.sourceAgent === agent ? "私有" : "共享";
      return `${i + 1}. [${scope}·${ageLabel}] ${entry.content}`;
    });

    return `\n[语义检索记忆]\n${lines.join("\n")}\n`;
  }

  /** 获取所有记忆概览（用于 API） */
  overview(): {
    privateCount: number;
    sharedCount: number;
    agents: string[];
    totalAccessCount: number;
  } {
    const data = this.load();
    const agents = Object.keys(data.private);
    const privateCount = agents.reduce((sum, a) => sum + (data.private[a]?.length ?? 0), 0);
    const sharedCount = data.shared.length;
    const totalAccessCount = [
      ...Object.values(data.private).flat(),
      ...data.shared,
    ].reduce((sum, e) => sum + e.accessCount, 0);
    return { privateCount, sharedCount, agents, totalAccessCount };
  }

  /** 获取指定 Agent 的私有记忆（用于 API） */
  getPrivate(agent: string): LayeredMemoryEntry[] {
    const data = this.load();
    return (data.private[agent] ?? []).slice().reverse();
  }

  /** 获取所有共享记忆（用于 API） */
  getShared(): LayeredMemoryEntry[] {
    const data = this.load();
    return data.shared.slice().reverse();
  }

  /** 清空所有记忆（测试用） */
  clear(): void {
    this.data = { private: {}, shared: [] };
    this.dirty = true;
    this.flush();
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const memoryLayer = new MemoryLayerStore();

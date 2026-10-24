import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentContext } from "../shared/digital-employees.ts";
import { reflectOnResult, hasLlmConfiguration } from "./llm.ts";
import { memoryLayer } from "./memory-layer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOOP_PATH = join(__dirname, "..", ".data", "learning-loop.json");

function loopPath(): string {
  return resolve(process.env.AGENT_LEARNING_LOOP_PATH?.trim() || DEFAULT_LOOP_PATH);
}

// ─── 类型定义 ──────────────────────────────────────────────────

export interface DecisionRecord {
  id: string;
  /** 决策 Agent */
  agent: AgentContext;
  /** 决策的工具/动作 */
  action: string;
  /** 决策参数摘要 */
  argsSummary: string;
  /** 决策时的上下文/意图 */
  intent: string;
  /** 决策时间戳 */
  decidedAt: number;
}

export interface OutcomeRecord {
  decisionId: string;
  /** 执行是否成功 */
  success: boolean;
  /** 执行结果摘要 */
  resultSummary: string;
  /** 执行耗时（ms） */
  durationMs: number;
  /** 执行前数据快照（可选） */
  beforeSnapshot?: string;
  /** 执行后数据快照（可选） */
  afterSnapshot?: string;
  /** 执行时间戳 */
  executedAt: number;
}

export interface ReflectionRecord {
  decisionId: string;
  /** LLM 反思：是否达到预期 */
  meetsExpectation: boolean;
  /** 识别的风险 */
  risks: string[];
  /** 改进建议 */
  suggestion: string;
  /** 提取的经验教训（写入共享记忆） */
  lesson?: string;
  /** 反思时间戳 */
  reflectedAt: number;
}

export interface LearningLoopData {
  decisions: DecisionRecord[];
  outcomes: OutcomeRecord[];
  reflections: ReflectionRecord[];
}

// ─── 持久化 ────────────────────────────────────────────────────

const MAX_RECORDS = 300;

class LearningLoopStore {
  private data: LearningLoopData = { decisions: [], outcomes: [], reflections: [] };
  private loaded = false;
  private dirty = false;
  private lastSaveAt = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly saveDebounceMs = 2_000;

  constructor() {
    // ReAct 循环每步都会记录决策/结果；防抖窗口内的数据在进程退出时同步落盘
    process.on("exit", () => this.flush());
  }

  private load(): LearningLoopData {
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      const path = loopPath();
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        // 同上：null / 数组也能 parse 成功，但后续取 .decisions 会抛错；
        // 缺字段的老文件也要补齐，否则第一次 push 就崩
        const record = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Partial<LearningLoopData>;
        this.data = {
          decisions: Array.isArray(record.decisions) ? record.decisions : [],
          outcomes: Array.isArray(record.outcomes) ? record.outcomes : [],
          reflections: Array.isArray(record.reflections) ? record.reflections : [],
        };
      }
    } catch {
      this.data = { decisions: [], outcomes: [], reflections: [] };
    }
    return this.data;
  }

  private persist(): void {
    this.dirty = true;
    const now = Date.now();
    if (now - this.lastSaveAt < this.saveDebounceMs) {
      // 防抖窗口内：安排尾随写，保证最后一批变更也会落盘
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          this.flush();
        }, this.saveDebounceMs);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.flush();
  }

  private flush(): void {
    if (!this.dirty) return;
    const path = loopPath();
    const dir = dirname(path);
    try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
    this.dirty = false;
    this.lastSaveAt = Date.now();
  }

  /** 记录一个决策 */
  recordDecision(agent: AgentContext, action: string, argsSummary: string, intent: string): string {
    this.load();
    const id = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.data.decisions.push({
      id, agent, action, argsSummary, intent, decidedAt: Date.now(),
    });
    if (this.data.decisions.length > MAX_RECORDS) {
      this.data.decisions = this.data.decisions.slice(-MAX_RECORDS);
    }
    this.persist();
    return id;
  }

  /** 记录决策的执行结果 */
  recordOutcome(decisionId: string, success: boolean, resultSummary: string, durationMs: number, snapshots?: { before?: string; after?: string }): void {
    this.load();
    this.data.outcomes.push({
      decisionId, success, resultSummary, durationMs,
      beforeSnapshot: snapshots?.before,
      afterSnapshot: snapshots?.after,
      executedAt: Date.now(),
    });
    if (this.data.outcomes.length > MAX_RECORDS) {
      this.data.outcomes = this.data.outcomes.slice(-MAX_RECORDS);
    }
    this.persist();
  }

  /**
   * 对未反思的成功决策执行 LLM 反思。
   * 返回新增的反思记录数。
   */
  async runReflectionBatch(limit = 3): Promise<number> {
    if (!hasLlmConfiguration()) return 0;
    this.load();

    // 找出有结果但还没反思的决策
    const reflectedIds = new Set(this.data.reflections.map((r) => r.decisionId));
    const candidates = this.data.decisions
      .filter((d) => this.data.outcomes.some((o) => o.decisionId === d.id) && !reflectedIds.has(d.id))
      .slice(-limit);

    if (candidates.length === 0) return 0;

    let count = 0;
    for (const decision of candidates) {
      const outcome = this.data.outcomes.find((o) => o.decisionId === decision.id);
      if (!outcome) continue;

      try {
        const reflection = await reflectOnResult(
          `${decision.action}(${decision.argsSummary})`,
          outcome.beforeSnapshot ?? decision.intent,
          outcome.afterSnapshot ?? outcome.resultSummary,
        );

        // 提取经验教训（仅当有改进建议时）
        let lesson: string | undefined;
        if (reflection.suggestion && reflection.suggestion.length > 5) {
          lesson = `[${decision.action}] ${reflection.suggestion}`;
          // 写入共享记忆层，供所有 Agent 检索
          memoryLayer.addShared(decision.agent, lesson, ["lesson", decision.action]);
        }

        this.data.reflections.push({
          decisionId: decision.id,
          meetsExpectation: reflection.meetsExpectation,
          risks: reflection.risks,
          suggestion: reflection.suggestion,
          lesson,
          reflectedAt: Date.now(),
        });
        count += 1;
      } catch {
        // 反思失败，跳过该条
      }
    }

    if (this.data.reflections.length > MAX_RECORDS) {
      this.data.reflections = this.data.reflections.slice(-MAX_RECORDS);
    }
    this.persist();
    this.flush();
    return count;
  }

  /** 获取闭环学习概览（用于 API） */
  overview(): {
    decisions: number;
    outcomes: number;
    reflections: number;
    successRate: number;
    avgDurationMs: number;
    lessonsLearned: number;
    pendingReflection: number;
  } {
    this.load();
    const outcomes = this.data.outcomes;
    const successCount = outcomes.filter((o) => o.success).length;
    const avgDuration = outcomes.length
      ? Math.round(outcomes.reduce((sum, o) => sum + o.durationMs, 0) / outcomes.length)
      : 0;
    const reflectedIds = new Set(this.data.reflections.map((r) => r.decisionId));
    const pendingReflection = this.data.decisions.filter(
      (d) => outcomes.some((o) => o.decisionId === d.id) && !reflectedIds.has(d.id),
    ).length;
    return {
      decisions: this.data.decisions.length,
      outcomes: outcomes.length,
      reflections: this.data.reflections.length,
      successRate: outcomes.length ? Math.round((successCount / outcomes.length) * 100) : 0,
      avgDurationMs: avgDuration,
      lessonsLearned: this.data.reflections.filter((r) => r.lesson).length,
      pendingReflection,
    };
  }

  /** 获取最近 N 条决策+结果+反思（用于 API） */
  getRecent(limit = 20): Array<{
    decision: DecisionRecord;
    outcome?: OutcomeRecord;
    reflection?: ReflectionRecord;
  }> {
    this.load();
    const recentDecisions = this.data.decisions.slice(-limit).reverse();
    return recentDecisions.map((decision) => ({
      decision,
      outcome: this.data.outcomes.find((o) => o.decisionId === decision.id),
      reflection: this.data.reflections.find((r) => r.decisionId === decision.id),
    }));
  }

  /** 清空所有记录（测试用） */
  clear(): void {
    this.data = { decisions: [], outcomes: [], reflections: [] };
    this.dirty = true;
    this.flush();
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const learningLoop = new LearningLoopStore();

// ─── 便捷封装：追踪一次完整的决策→执行→反思 ───────────────────

/**
 * 追踪一次决策的执行结果。
 * 调用方在执行前调用 recordDecision 获得 decisionId，
 * 执行后调用此方法记录结果。
 *
 * 注意：反思是异步批量执行的，不会在此方法中同步触发，
 * 以避免阻塞用户响应。反思由 scheduler 定期触发。
 */
export function recordDecisionOutcome(
  agent: AgentContext,
  action: string,
  argsSummary: string,
  intent: string,
  result: { success: boolean; summary: string; durationMs: number; before?: string; after?: string },
): string {
  const decisionId = learningLoop.recordDecision(agent, action, argsSummary, intent);
  learningLoop.recordOutcome(decisionId, result.success, result.summary, result.durationMs, {
    before: result.before,
    after: result.after,
  });
  return decisionId;
}

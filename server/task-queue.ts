import { EventEmitter } from "node:events";
import type { AgentContext } from "../shared/digital-employees.ts";
import { agentRegistry } from "./agent-registry.ts";
import { agentBus } from "./agent-bus.ts";

// ─── 类型定义 ──────────────────────────────────────────────────

export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskRecord {
  id: string;
  /** 发起 Agent */
  agent: AgentContext;
  /** 任务描述（用于可观测性） */
  description: string;
  /** 优先级 */
  priority: TaskPriority;
  /** 当前状态 */
  status: TaskStatus;
  /** 入队时间戳 */
  enqueuedAt: number;
  /** 开始执行时间戳 */
  startedAt?: number;
  /** 完成时间戳 */
  completedAt?: number;
  /** 执行结果（成功时） */
  result?: unknown;
  /** 失败原因（失败时） */
  error?: string;
  /** 关联 ID（如对话 ID、工作流 ID） */
  correlationId?: string;
}

export interface TaskQueueOptions {
  /** 全局最大并发数 */
  maxConcurrency?: number;
  /** 每 Agent 最大并发数（避免单个 Agent 独占池） */
  maxPerAgent?: number;
  /** 队列最大长度（防止积压） */
  maxQueueSize?: number;
}

export interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** 历史完成任务总数 */
  totalCompleted: number;
  /** 平均执行时长（ms） */
  avgDurationMs: number;
  /** 当前活跃 Agent 数 */
  activeAgents: number;
  /** 全局并发上限 */
  maxConcurrency: number;
}

type TaskQueueEvents = {
  "task:queued": [TaskRecord];
  "task:started": [TaskRecord];
  "task:done": [TaskRecord];
  "task:failed": [TaskRecord];
  "task:cancelled": [TaskRecord];
};

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

// ─── 任务队列 + Agent 并发池 ───────────────────────────────────

/**
 * 轻量级并发执行池。
 *
 * 设计取舍：
 * - LLM/外部 API 调用属于 IO-bound，Worker Threads 收益有限且引入序列化开销，
 *   因此采用 Promise-pool 模式，在单进程事件循环内实现并发。
 * - 通过全局 + 每 Agent 双重并发上限，避免单 Agent 独占资源。
 * - 优先级队列：critical > high > normal > low，同级 FIFO。
 */
class TaskQueue extends EventEmitter {
  private readonly maxConcurrency: number;
  private readonly maxPerAgent: number;
  private readonly maxQueueSize: number;

  private queue: TaskRecord[] = [];
  private running = new Map<string, TaskRecord>();
  private history: TaskRecord[] = [];
  private readonly maxHistory = 200;

  private totalCompleted = 0;
  private totalDurationMs = 0;

  constructor(options: TaskQueueOptions = {}) {
    super();
    this.setMaxListeners(50);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.maxPerAgent = Math.max(1, options.maxPerAgent ?? 2);
    this.maxQueueSize = Math.max(16, options.maxQueueSize ?? 200);
  }

  /**
   * 提交一个任务到队列。
   * 返回 Promise，在任务执行完成时 resolve。
   */
  submit<T>(
    agent: AgentContext,
    description: string,
    executor: () => Promise<T>,
    options: { priority?: TaskPriority; correlationId?: string } = {},
  ): Promise<T> {
    const priority = options.priority ?? "normal";
    const task: TaskRecord = {
      id: `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent,
      description,
      priority,
      status: "queued",
      enqueuedAt: Date.now(),
      correlationId: options.correlationId,
    };

    if (this.queue.length >= this.maxQueueSize) {
      // 队列满，拒绝新任务
      return Promise.reject(new Error(`任务队列已满（${this.maxQueueSize}），请稍后再试。`));
    }

    return new Promise<T>((resolve, reject) => {
      // 把 executor 和 resolve/reject 绑定到任务上
      (task as TaskRecord & { _executor?: () => Promise<T>; _resolve?: (v: T) => void; _reject?: (e: unknown) => void })._executor = executor;
      (task as TaskRecord & { _executor?: () => Promise<T>; _resolve?: (v: T) => void; _reject?: (e: unknown) => void })._resolve = resolve;
      (task as TaskRecord & { _executor?: () => Promise<T>; _resolve?: (v: T) => void; _reject?: (e: unknown) => void })._reject = reject;

      // 按优先级插入队列
      this.insertByPriority(task);
      this.emit("task:queued", task);
      this.schedule();
    });
  }

  /** 按优先级插入队列（稳定排序：同优先级保持 FIFO） */
  private insertByPriority(task: TaskRecord): void {
    const weight = PRIORITY_WEIGHT[task.priority];
    let i = this.queue.length;
    while (i > 0 && PRIORITY_WEIGHT[this.queue[i - 1].priority] < weight) {
      i--;
    }
    this.queue.splice(i, 0, task);
  }

  /** 调度下一个可执行任务 */
  private schedule(): void {
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const next = this.pickNext();
      if (!next) break;
      void this.run(next);
    }
  }

  /** 选择下一个可执行任务（考虑每 Agent 并发上限） */
  private pickNext(): TaskRecord | undefined {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      const agentRunning = this.countRunningByAgent(task.agent);
      if (agentRunning < this.maxPerAgent) {
        this.queue.splice(i, 1);
        return task;
      }
    }
    return undefined;
  }

  private countRunningByAgent(agent: AgentContext): number {
    let count = 0;
    for (const task of this.running.values()) {
      if (task.agent === agent) count++;
    }
    return count;
  }

  private async run(task: TaskRecord): Promise<void> {
    const ext = task as TaskRecord & {
      _executor?: () => Promise<unknown>;
      _resolve?: (v: unknown) => void;
      _reject?: (e: unknown) => void;
    };

    task.status = "running";
    task.startedAt = Date.now();
    this.running.set(task.id, task);
    agentRegistry.startWork(task.agent, task.description);
    this.emit("task:started", task);

    try {
      const result = await ext._executor!();
      task.status = "done";
      task.result = result;
      task.completedAt = Date.now();
      this.totalCompleted += 1;
      this.totalDurationMs += task.completedAt - (task.startedAt ?? task.enqueuedAt);
      ext._resolve?.(result);
      this.emit("task:done", task);
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = Date.now();
      ext._reject?.(error);
      this.emit("task:failed", task);
    } finally {
      this.running.delete(task.id);
      agentRegistry.completeWork(task.agent);
      this.recordHistory(task);
      // 继续调度
      this.schedule();
    }
  }

  private recordHistory(task: TaskRecord): void {
    // 只记录元数据，不保留 executor/resolve/reject
    const { id, agent, description, priority, status, enqueuedAt, startedAt, completedAt, error, correlationId } = task;
    this.history.push({ id, agent, description, priority, status, enqueuedAt, startedAt, completedAt, error, correlationId });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /** 取消尚未开始的任务 */
  cancel(taskId: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx < 0) return false;
    const [task] = this.queue.splice(idx, 1);
    task.status = "cancelled";
    task.completedAt = Date.now();
    const ext = task as TaskRecord & { _reject?: (e: unknown) => void };
    ext._reject?.(new Error("任务已取消"));
    this.emit("task:cancelled", task);
    this.recordHistory(task);
    return true;
  }

  /** 获取当前队列快照 */
  getQueuedTasks(): TaskRecord[] {
    return [...this.queue];
  }

  /** 获取正在运行的任务快照 */
  getRunningTasks(): TaskRecord[] {
    return [...this.running.values()];
  }

  /** 获取历史记录（最近 N 条） */
  getHistory(limit = 50): TaskRecord[] {
    return this.history.slice(-limit);
  }

  /** 获取队列统计 */
  getStats(): QueueStats {
    const durations = this.history
      .filter((t) => t.status === "done" && t.startedAt && t.completedAt)
      .map((t) => (t.completedAt! - t.startedAt!));
    return {
      queued: this.queue.length,
      running: this.running.size,
      done: this.history.filter((t) => t.status === "done").length,
      failed: this.history.filter((t) => t.status === "failed").length,
      cancelled: this.history.filter((t) => t.status === "cancelled").length,
      totalCompleted: this.totalCompleted,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      activeAgents: new Set([...this.running.values()].map((t) => t.agent)).size,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /** 等待所有运行中任务完成（用于优雅关闭）；超时后放弃等待，避免卡死任务让进程退不出去 */
  async drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0) {
      if (Date.now() >= deadline) {
        console.error(`Task queue drain timed out after ${timeoutMs}ms with ${this.running.size} task(s) still running`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 清空队列（测试用） */
  clear(): void {
    for (const task of this.queue) {
      task.status = "cancelled";
      const ext = task as TaskRecord & { _reject?: (e: unknown) => void };
      ext._reject?.(new Error("队列已清空"));
      this.emit("task:cancelled", task);
    }
    this.queue = [];
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const taskQueue = new TaskQueue({
  maxConcurrency: Number(process.env.AGENT_TASK_CONCURRENCY ?? 4),
  maxPerAgent: Number(process.env.AGENT_TASK_PER_AGENT ?? 2),
  maxQueueSize: Number(process.env.AGENT_TASK_QUEUE_SIZE ?? 200),
});

// ─── 便捷方法：广播任务事件到 agentBus ─────────────────────────

/**
 * 把 taskQueue 的事件桥接到 agentBus，便于统一在 /api/agents 流中观察。
 */
export function bridgeTaskQueueToAgentBus(): void {
  taskQueue.on("task:queued", (task) => {
    agentBus.sendMessage(task.agent, task.agent, "notification", `任务已入队：${task.description}`, task.correlationId);
  });
  taskQueue.on("task:failed", (task) => {
    agentBus.sendMessage(task.agent, task.agent, "notification", `任务失败：${task.error ?? "未知错误"}`, task.correlationId);
  });
}

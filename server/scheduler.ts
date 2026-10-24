import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── 类型定义 ──────────────────────────────────────────────────

export type ScheduleTaskStatus = "active" | "paused" | "error";

export interface ScheduleTask {
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务描述 */
  description?: string;
  /** Cron 表达式（5 字段：分 时 日 月 周） */
  cron: string;
  /** 要执行的任务类型 */
  type: "read_only_query" | "proactive_inspection" | "report_generation" | "learning_reflection";
  /** 任务参数（如查询内容、报告模板等） */
  params: Record<string, unknown>;
  /** 目标 Agent */
  agent?: string;
  /** 状态 */
  status: ScheduleTaskStatus;
  /** 上次执行时间 */
  lastRunAt?: string;
  /** 上次执行结果 */
  lastResult?: {
    success: boolean;
    summary: string;
    insight?: string;
  };
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

export interface ScheduleRunLog {
  taskId: string;
  taskName: string;
  runAt: string;
  success: boolean;
  summary: string;
  insight?: string;
  durationMs: number;
}

type TaskExecutor = (task: ScheduleTask) => Promise<{ success: boolean; summary: string; insight?: string }>;

// ─── Cron 解析器（简化版，支持 5 字段） ────────────────────────

interface ParsedCron {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  // 处理 */N 步进
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
  }
  // 处理逗号分隔
  if (field.includes(",")) {
    return field.split(",").flatMap((part) => parseCronField(part.trim(), min, max));
  }
  // 处理范围 a-b
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  // 单个数字
  const num = Number(field);
  if (!Number.isNaN(num) && num >= min && num <= max) {
    return [num];
  }
  return [];
}

function parseCron(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6),
  };
}

function shouldRun(parsed: ParsedCron, date: Date): boolean {
  return (
    parsed.minute.includes(date.getMinutes()) &&
    parsed.hour.includes(date.getHours()) &&
    parsed.dayOfMonth.includes(date.getDate()) &&
    parsed.month.includes(date.getMonth() + 1) &&
    parsed.dayOfWeek.includes(date.getDay())
  );
}

// ─── 调度引擎 ──────────────────────────────────────────────────

export class SchedulerEngine {
  private tasks = new Map<string, ScheduleTask>();
  private executors = new Map<string, TaskExecutor>();
  private runLogs: ScheduleRunLog[] = [];
  private timer?: NodeJS.Timeout;
  /** 启动时那一次「立即 tick」的句柄；stop 时要能取消，否则停服后还会跑一轮任务 */
  private firstTick?: NodeJS.Timeout;
  private readonly maxLogs = 100;
  private storePath: string;
  /** 本轮 tick 是否还在执行。任务是一轮里顺序 await 的，整轮可能超过 60 秒 */
  private ticking = false;
  /** 每个任务的连续失败次数，达到阈值才停用；只在内存里，重启后重算 */
  private failureStreak = new Map<string, number>();

  constructor(explicitStorePath?: string) {
    // 允许指定存储路径：测试要能跑在临时目录里，不能往真实的 .data/scheduler-tasks.json 写
    this.storePath = explicitStorePath ?? join(process.cwd(), ".data", "scheduler-tasks.json");
  }

  /** 注册任务执行器 */
  registerExecutor(type: string, executor: TaskExecutor): void {
    this.executors.set(type, executor);
  }

  /** 创建调度任务 */
  create(input: Omit<ScheduleTask, "id" | "status" | "createdAt" | "updatedAt">): ScheduleTask {
    const task: ScheduleTask = {
      ...input,
      id: randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // 验证 cron 表达式
    if (!parseCron(task.cron)) {
      throw new Error(`无效的 cron 表达式：${task.cron}`);
    }
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  /** 暂停任务 */
  pause(taskId: string): ScheduleTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = "paused";
    task.updatedAt = new Date().toISOString();
    this.persist();
    return task;
  }

  /** 恢复任务 */
  resume(taskId: string): ScheduleTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.status = "active";
    task.updatedAt = new Date().toISOString();
    // 手动恢复意味着用户认为它可以再跑，把失败计数清零，否则下一次失败就又被停用
    this.failureStreak.delete(taskId);
    this.persist();
    return task;
  }

  /** 删除任务 */
  delete(taskId: string): boolean {
    const deleted = this.tasks.delete(taskId);
    if (deleted) this.persist();
    return deleted;
  }

  /** 列出所有任务 */
  list(): ScheduleTask[] {
    return Array.from(this.tasks.values());
  }

  /** 获取单个任务 */
  get(taskId: string): ScheduleTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 获取执行日志 */
  getLogs(limit?: number): ScheduleRunLog[] {
    const logs = [...this.runLogs].reverse();
    return limit ? logs.slice(0, limit) : logs;
  }

  /** 手动触发一次任务执行 */
  async runOnce(taskId: string): Promise<ScheduleRunLog | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return this.executeTask(task);
  }

  /** 启动调度循环（每分钟检查一次） */
  start(): void {
    if (this.timer) return;
    // 加载持久化数据
    this.load();
    // 每 60 秒检查一次
    this.timer = setInterval(() => this.tick(), 60_000);
    // 立即执行一次 tick（不阻塞）
    this.firstTick = setTimeout(() => {
      this.firstTick = undefined;
      void this.tick();
    }, 1000);
    console.log(`[Scheduler] 已启动，${this.tasks.size} 个任务，每分钟检查一次`);
  }

  /** 停止调度循环 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.firstTick) {
      clearTimeout(this.firstTick);
      this.firstTick = undefined;
    }
  }

  /** 检查并执行到期的任务。由内部定时器调用，测试也直接调它来验证并发守卫 */
  async tick(): Promise<void> {
    // setInterval 不会等上一轮跑完。一轮里要顺序 await 所有到期任务，
    // 只要有多个任务或单个任务超过 60 秒，下一轮就会撞进来把同一批任务再跑一遍——
    // 最后一次运行时间的检查是任务「跑完之后」才写的，挡不住这种情况。
    // 写类任务重复执行的后果是重复提交，所以这里直接跳过本轮。
    if (this.ticking) {
      console.warn("[Scheduler] 上一轮检查还没结束，跳过本次触发");
      return;
    }
    this.ticking = true;
    try {
      const now = new Date();
      const activeTasks = Array.from(this.tasks.values()).filter((t) => t.status === "active");
      for (const task of activeTasks) {
        const parsed = parseCron(task.cron);
        if (!parsed) continue;
        if (shouldRun(parsed, now)) {
          // 避免同一分钟内重复执行
          if (task.lastRunAt) {
            const lastRun = new Date(task.lastRunAt);
            if (lastRun.getTime() > now.getTime() - 60_000) continue;
          }
          await this.executeTask(task);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** 执行单个任务 */
  private async executeTask(task: ScheduleTask): Promise<ScheduleRunLog> {
    const startTime = Date.now();
    const executor = this.executors.get(task.type);
    let result: { success: boolean; summary: string; insight?: string };

    if (!executor) {
      result = { success: false, summary: `执行器 ${task.type} 未注册` };
    } else {
      try {
        result = await executor(task);
      } catch (error) {
        result = {
          success: false,
          summary: `执行异常：${error instanceof Error ? error.message : "未知错误"}`,
        };
      }
    }

    const durationMs = Date.now() - startTime;
    const runAt = new Date().toISOString();

    // 更新任务状态
    task.lastRunAt = runAt;
    task.lastResult = result;
    if (result.success) {
      this.failureStreak.delete(task.id);
    } else if (task.status === "active") {
      // 失败一次就置 error 是不对的：一次网络抖动就能把定时任务永久关掉，
      // 而且界面上只有一个「错误」标记，用户不会知道任务已经不再执行了。
      // 改成连续失败 5 次才停用——真坏的任务仍然会被停，偶发抖动则继续重试。
      const streak = (this.failureStreak.get(task.id) ?? 0) + 1;
      this.failureStreak.set(task.id, streak);
      if (streak >= 5) {
        task.status = "error";
        console.warn(`[Scheduler] 任务「${task.name}」连续失败 ${streak} 次，已停用`);
      }
    }
    task.updatedAt = runAt;
    this.persist();

    // 记录日志
    const log: ScheduleRunLog = {
      taskId: task.id,
      taskName: task.name,
      runAt,
      success: result.success,
      summary: result.summary,
      insight: result.insight,
      durationMs,
    };
    this.runLogs.push(log);
    if (this.runLogs.length > this.maxLogs) {
      this.runLogs = this.runLogs.slice(-this.maxLogs);
    }

    console.log(`[Scheduler] 任务 "${task.name}" ${result.success ? "完成" : "失败"} (${durationMs}ms)`);
    return log;
  }

  /** 持久化到文件 */
  private persist(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const data = {
        tasks: Array.from(this.tasks.values()),
        logs: this.runLogs.slice(-this.maxLogs),
      };
      // 先写临时文件再 rename：直接覆写时如果进程被杀在写一半，
      // 文件会变成半截 JSON，下次启动 load() 解析失败，所有定时任务静默消失。
      // memory / memory-layer / learning-loop 都是这么写的，只有这里漏了。
      const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(temporaryPath, this.storePath);
    } catch (error) {
      console.error("[Scheduler] 持久化失败：", error);
    }
  }

  /** 从文件加载 */
  private load(): void {
    try {
      if (!existsSync(this.storePath)) return;
      const data: unknown = JSON.parse(readFileSync(this.storePath, "utf-8"));
      if (!data || typeof data !== "object") {
        console.warn("[Scheduler] 任务文件格式异常，按空任务处理");
        return;
      }
      const store = data as { tasks?: unknown; logs?: unknown };
      let skipped = 0;
      // 单条坏数据只跳过它，不能让整批任务都读不出来
      if (Array.isArray(store.tasks)) {
        for (const item of store.tasks) {
          if (!item || typeof item !== "object") { skipped += 1; continue; }
          const task = item as ScheduleTask;
          if (typeof task.id !== "string" || typeof task.cron !== "string" || typeof task.name !== "string") { skipped += 1; continue; }
          this.tasks.set(task.id, task);
        }
      }
      if (Array.isArray(store.logs)) {
        this.runLogs = store.logs.filter((item): item is ScheduleRunLog =>
          Boolean(item) && typeof item === "object" && typeof (item as ScheduleRunLog).taskId === "string");
      }
      console.log(`[Scheduler] 已加载 ${this.tasks.size} 个任务，${this.runLogs.length} 条日志${skipped ? `，跳过 ${skipped} 条坏数据` : ""}`);
    } catch (error) {
      console.error("[Scheduler] 加载失败：", error);
    }
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const scheduler = new SchedulerEngine();

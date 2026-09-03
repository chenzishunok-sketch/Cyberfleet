import type { WorkflowStep } from "../shared/contracts.ts";

// 商品发布 / 秒杀 / KOL 建联三个步骤型工作流引擎共享的基础设施。
// 修改这里的行为会同时影响三个引擎，需整体回归 tests/*workflow*.test.ts。

export function initialSteps(stepLabels: Array<[string, string]>): WorkflowStep[] {
  return stepLabels.map(([id, label]) => ({ id, label, status: "pending" }));
}

/**
 * 更新 run 中指定步骤的状态。
 * options.labels + options.insertBefore 提供向后兼容：旧 run 缺少后来新增的步骤时，
 * 在锚点步骤前插入该步骤，避免历史任务无法推进。
 */
export function patchStep<T extends { steps: WorkflowStep[] }>(
  run: T,
  id: string,
  patch: Partial<WorkflowStep>,
  options?: { labels?: Array<[string, string]>; insertBefore?: string },
): T {
  if (!run.steps.some((step) => step.id === id) && options?.labels) {
    const next = [...run.steps];
    const insertIndex = options.insertBefore
      ? next.findIndex((step) => step.id === options.insertBefore)
      : -1;
    next.splice(insertIndex >= 0 ? insertIndex : next.length, 0, {
      id,
      label: options.labels.find(([stepId]) => stepId === id)?.[1] ?? id,
      status: "pending",
      ...patch,
    });
    return { ...run, steps: next };
  }
  return { ...run, steps: run.steps.map((step) => step.id === id ? { ...step, ...patch } : step) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

/** 同一 run 的变更串行化：approve/retry/verify 等入口若并发进入，会重复产生外部副作用 */
export class RunLockMap {
  private readonly locks = new Map<string, Promise<unknown>>();

  async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let current!: Promise<T>;
    current = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.locks.get(id) === current) this.locks.delete(id);
    });
    this.locks.set(id, current);
    return current;
  }
}

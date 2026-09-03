import { randomUUID } from "node:crypto";
import type { KolCreator, KolOutreachWorkflowRun, KolStats, WorkflowStep } from "../shared/contracts.ts";
import { kolBridge } from "./kol-bridge.ts";
import type { KolOutreachInput } from "./kol-intents.ts";
import { errorMessage, initialSteps, patchStep as patchStepBase, RunLockMap } from "./workflow-core.ts";
import { WorkflowStore, workflowStore } from "./workflow-store.ts";

export interface KolOutreachWorkflowTools {
  isConnected(): boolean;
  listCreators(query: { category?: string; minFollowers?: number; limit?: number }): Promise<KolCreator[]>;
  getStats(): Promise<KolStats>;
  execute(
    plan: Record<string, unknown>,
    onProgress: (progress: { group?: number; groupTotal?: number; done?: number; total?: number; status?: string }) => Promise<void>,
  ): Promise<Record<string, unknown>>;
}

const STEPS: Array<[string, string]> = [
  ["bridge", "检查达人浏览器桥接"],
  ["match", "筛选并锁定达人"],
  ["confirm", "确认建联方案"],
  ["execute", "分批发送达人邀约"],
  ["verify", "记录执行结果"],
];

function initialWorkflowSteps(): WorkflowStep[] {
  return initialSteps(STEPS);
}

function patchStep(run: KolOutreachWorkflowRun, id: string, patch: Partial<WorkflowStep>): KolOutreachWorkflowRun {
  return patchStepBase(run, id, patch);
}

function resultNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export const realKolOutreachTools: KolOutreachWorkflowTools = {
  isConnected: () => kolBridge.isConnected(),
  listCreators: (query) => kolBridge.listCreators(query),
  getStats: () => kolBridge.getStats(),
  execute: (plan, onProgress) => kolBridge.execute(plan, (progress) => onProgress((progress ?? {}) as Parameters<typeof onProgress>[0])),
};

export class KolOutreachWorkflowEngine {
  private readonly locks = new RunLockMap();

  constructor(
    private readonly store: WorkflowStore = workflowStore,
    private readonly tools: KolOutreachWorkflowTools = realKolOutreachTools,
  ) {}

  async list(): Promise<KolOutreachWorkflowRun[]> {
    return (await this.store.list()).filter((run): run is KolOutreachWorkflowRun => run.type === "kol_outreach");
  }

  async get(id: string): Promise<KolOutreachWorkflowRun | undefined> {
    const run = await this.store.get(id);
    return run?.type === "kol_outreach" ? run : undefined;
  }

  async create(input: KolOutreachInput): Promise<KolOutreachWorkflowRun> {
    if (!Number.isFinite(input.commissionRate) || input.commissionRate <= 0 || input.commissionRate > 100) {
      throw new Error("佣金比例必须大于 0 且不超过 100%。");
    }
    if (!Number.isInteger(input.totalTarget) || input.totalTarget <= 0 || input.totalTarget > 500) {
      throw new Error("单次建联人数必须是 1 到 500。");
    }
    if (!Number.isInteger(input.batchSize) || input.batchSize <= 0 || input.batchSize > 50) {
      throw new Error("每批人数必须是 1 到 50。");
    }
    const now = new Date().toISOString();
    const run: KolOutreachWorkflowRun = {
      id: randomUUID(),
      type: "kol_outreach",
      title: "TikTok 达人建联",
      status: "draft",
      filters: {
        ...(input.category?.trim() ? { category: input.category.trim() } : {}),
        ...(input.minFollowers ? { minFollowers: input.minFollowers } : {}),
      },
      commissionRate: input.commissionRate,
      ...(input.message?.trim() ? { message: input.message.trim() } : {}),
      batchSize: input.batchSize,
      requestedTarget: input.totalTarget,
      totalTarget: input.totalTarget,
      freeSample: input.freeSample,
      matchedCreators: [],
      selectedCreatorIds: [],
      steps: initialWorkflowSteps(),
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create(run);
    return this.prepare(run.id);
  }

  async retry(id: string): Promise<KolOutreachWorkflowRun> {
    return this.locks.withLock(id, () => this.retryUnlocked(id));
  }

  private async retryUnlocked(id: string): Promise<KolOutreachWorkflowRun> {
    const run = await this.requireRun(id);
    const executionStarted = Boolean(run.steps.find((step) => step.id === "execute")?.startedAt);
    if (executionStarted) {
      throw new Error("这次邀约可能已经部分发送。为避免重复联系达人，不能直接重试，请先查看插件中的邀约记录。");
    }
    if (run.status !== "failed" && run.status !== "waiting_input") throw new Error("这个任务当前不需要重试。");
    await this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      return {
        ...current,
        status: "draft",
        requiredInput: undefined,
        error: undefined,
        summary: "正在重新检查浏览器桥接和达人数据。",
        steps: current.steps.map((step) => ["bridge", "match"].includes(step.id)
          ? { ...step, status: "pending", detail: undefined, error: undefined, startedAt: undefined, completedAt: undefined }
          : step),
        updatedAt: new Date().toISOString(),
      };
    });
    return this.prepareUnlocked(id);
  }

  async approve(id: string): Promise<KolOutreachWorkflowRun> {
    return this.locks.withLock(id, () => this.approveUnlocked(id));
  }

  private async approveUnlocked(id: string): Promise<KolOutreachWorkflowRun> {
    let run = await this.requireRun(id);
    if (run.status !== "waiting_confirmation" || run.confirmationKind !== "kol_outreach") {
      throw new Error("这个达人任务还没有到确认执行步骤。");
    }
    if (!this.tools.isConnected()) {
      return this.waitForBridge(id);
    }

    const latest = await this.tools.listCreators({ ...run.filters, limit: 500 });
    const selected = latest.slice(0, run.requestedTarget);
    const selectedIds = selected.map((creator) => creator.id);
    if (JSON.stringify(selectedIds) !== JSON.stringify(run.selectedCreatorIds)) {
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        return patchStep({
          ...current,
          matchedCreators: latest,
          selectedCreatorIds: selectedIds,
          totalTarget: selected.length,
          summary: "达人库在确认前发生变化，已刷新名单，请重新确认后再发送。",
          updatedAt: new Date().toISOString(),
        }, "match", { status: "completed", detail: `重新锁定 ${selected.length} 位达人`, completedAt: new Date().toISOString() });
      });
    }

    run = await this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      let next = patchStep(current, "confirm", { status: "completed", detail: "已确认真实发送", completedAt: new Date().toISOString() });
      next = patchStep(next, "execute", { status: "running", detail: `正在分批发送 0 / ${current.totalTarget}`, startedAt: new Date().toISOString() });
      return { ...next, status: "running", error: undefined, updatedAt: new Date().toISOString() };
    });

    try {
      const result = await this.tools.execute({
        filters: run.filters,
        commissionRate: run.commissionRate,
        ...(run.message ? { message: run.message } : { messageTemplate: "last" }),
        batchSize: run.batchSize,
        totalTarget: run.totalTarget,
        freeSample: run.freeSample,
      }, async (progress) => {
        const done = resultNumber(progress.done);
        const total = resultNumber(progress.total) || run.totalTarget;
        await this.store.update<KolOutreachWorkflowRun>(id, (current) => {
          if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
          return patchStep({ ...current, updatedAt: new Date().toISOString() }, "execute", {
            status: "running",
            detail: `正在分批发送 ${done} / ${total}`,
          });
        });
      });
      const normalized = {
        success: resultNumber(result.success),
        failed: resultNumber(result.failed),
        skipped: resultNumber(result.skipped),
        ...(result.details ? { details: String(result.details) } : {}),
      };
      let statsAfter: KolStats | undefined;
      try { statsAfter = await this.tools.getStats(); } catch { /* 结果已由执行接口确认 */ }
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        let next = patchStep(current, "execute", {
          status: normalized.success > 0 ? "completed" : "failed",
          detail: normalized.details ?? `成功 ${normalized.success} · 失败 ${normalized.failed} · 跳过 ${normalized.skipped}`,
          ...(normalized.success > 0 ? { completedAt: new Date().toISOString() } : { error: "没有成功发送邀约。" }),
        });
        next = patchStep(next, "verify", {
          status: normalized.success > 0 ? "completed" : "failed",
          detail: statsAfter ? `插件当前累计邀约 ${statsAfter.totalInvited}` : "执行结果已由浏览器插件返回",
          ...(normalized.success > 0 ? { completedAt: new Date().toISOString() } : { error: "请检查插件中的邀约记录。" }),
        });
        return {
          ...next,
          status: normalized.success > 0 ? "completed" : "failed",
          result: normalized,
          ...(statsAfter ? { statsAfter } : {}),
          summary: `达人建联完成：成功 ${normalized.success}，失败 ${normalized.failed}，跳过 ${normalized.skipped}。`,
          error: normalized.success > 0 ? undefined : "没有成功发送邀约。",
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (error) {
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        return patchStep({
          ...current,
          status: "verification_pending",
          error: errorMessage(error),
          summary: "发送过程中连接中断，可能已有部分邀约成功；为避免重复发送，请先检查插件记录。",
          updatedAt: new Date().toISOString(),
        }, "execute", { status: "failed", error: errorMessage(error) });
      });
    }
  }

  async verify(id: string): Promise<KolOutreachWorkflowRun> {
    return this.locks.withLock(id, () => this.verifyUnlocked(id));
  }

  private async verifyUnlocked(id: string): Promise<KolOutreachWorkflowRun> {
    const run = await this.requireRun(id);
    if (!this.tools.isConnected()) return this.waitForBridge(id);
    try {
      const statsAfter = await this.tools.getStats();
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        return patchStep({
          ...current,
          statsAfter,
          summary: current.result
            ? `达人建联完成：成功 ${current.result.success}，失败 ${current.result.failed}，跳过 ${current.result.skipped}。`
            : `已读取插件记录：当前累计邀约 ${statsAfter.totalInvited}。`,
          updatedAt: new Date().toISOString(),
        }, "verify", { status: "completed", detail: `插件当前累计邀约 ${statsAfter.totalInvited}`, completedAt: new Date().toISOString() });
      });
    } catch (error) {
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        return { ...current, error: errorMessage(error), updatedAt: new Date().toISOString() };
      });
    }
  }

  async cancel(id: string): Promise<KolOutreachWorkflowRun> {
    return this.locks.withLock(id, () => this.cancelUnlocked(id));
  }

  private async cancelUnlocked(id: string): Promise<KolOutreachWorkflowRun> {
    const run = await this.requireRun(id);
    if (run.status === "running") throw new Error("邀约正在浏览器中发送，当前协议不能安全中止。请等待本批完成。");
    if (["completed", "cancelled"].includes(run.status)) return run;
    return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      return { ...current, status: "cancelled", summary: "达人建联任务已取消，没有继续发送。", updatedAt: new Date().toISOString() };
    });
  }

  private async prepare(id: string): Promise<KolOutreachWorkflowRun> {
    return this.locks.withLock(id, () => this.prepareUnlocked(id));
  }

  private async prepareUnlocked(id: string): Promise<KolOutreachWorkflowRun> {
    if (!this.tools.isConnected()) return this.waitForBridge(id);
    await this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      return patchStep({ ...current, status: "running", requiredInput: undefined, error: undefined, updatedAt: new Date().toISOString() }, "bridge", {
        status: "completed", detail: "浏览器插件已连接", completedAt: new Date().toISOString(),
      });
    });
    await this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      return patchStep({ ...current, updatedAt: new Date().toISOString() }, "match", { status: "running", detail: "正在读取真实达人库", startedAt: new Date().toISOString() });
    });
    try {
      const run = await this.requireRun(id);
      const creators = await this.tools.listCreators({ ...run.filters, limit: 500 });
      if (!creators.length) {
        return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
          if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
          return patchStep({
            ...current,
            status: "waiting_input",
            requiredInput: { kind: "creator_data", prompt: "插件已连接，但当前筛选没有匹配达人。请在扩展中采集达人或调整筛选条件后重试。" },
            summary: "等待真实达人数据。",
            updatedAt: new Date().toISOString(),
          }, "match", { status: "failed", error: "没有匹配到达人。" });
        });
      }
      const selected = creators.slice(0, run.requestedTarget);
      let statsBefore: KolStats | undefined;
      try { statsBefore = await this.tools.getStats(); } catch { /* 不阻断建联预览 */ }
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        const warnings = current.requestedTarget > selected.length
          ? [...new Set([...current.warnings, `仅匹配到 ${selected.length} 位达人，低于目标 ${current.requestedTarget} 位。`])]
          : current.warnings;
        let next = patchStep(current, "match", { status: "completed", detail: `已锁定 ${selected.length} 位达人`, completedAt: new Date().toISOString() });
        next = patchStep(next, "confirm", { status: "pending", detail: "等待确认真实发送" });
        return {
          ...next,
          status: "waiting_confirmation",
          matchedCreators: creators,
          selectedCreatorIds: selected.map((creator) => creator.id),
          totalTarget: selected.length,
          ...(statsBefore ? { statsBefore } : {}),
          confirmationKind: "kol_outreach",
          warnings,
          summary: `已匹配 ${selected.length} 位达人。确认后将通过浏览器插件分批真实发送邀约。`,
          updatedAt: new Date().toISOString(),
        };
      });
    } catch (error) {
      return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
        if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
        return patchStep({ ...current, status: "failed", error: errorMessage(error), updatedAt: new Date().toISOString() }, "match", { status: "failed", error: errorMessage(error) });
      });
    }
  }

  private waitForBridge(id: string): Promise<KolOutreachWorkflowRun> {
    return this.store.update<KolOutreachWorkflowRun>(id, (current) => {
      if (current.type !== "kol_outreach") throw new Error("任务类型不正确。");
      return patchStep({
        ...current,
        status: "waiting_input",
        requiredInput: { kind: "kol_bridge", prompt: "请打开已安装 KOL 扩展的 TikTok Shop 联盟页面，连接后点击重试。" },
        summary: "等待达人浏览器插件连接。",
        updatedAt: new Date().toISOString(),
      }, "bridge", { status: "failed", error: "浏览器插件未连接。" });
    });
  }

  private async requireRun(id: string): Promise<KolOutreachWorkflowRun> {
    const run = await this.get(id);
    if (!run) throw new Error("找不到这个达人建联任务。");
    return run;
  }
}

export const kolOutreachWorkflowEngine = new KolOutreachWorkflowEngine();
export const startKolOutreachWorkflow = (input: KolOutreachInput) => kolOutreachWorkflowEngine.create(input);

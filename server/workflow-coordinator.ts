import type { BusinessWorkflowRun, DagWorkflowRun } from "../shared/contracts.ts";
import { flashSaleWorkflowEngine } from "./flash-sale-workflow.ts";
import { kolOutreachWorkflowEngine } from "./kol-outreach-workflow.ts";
import { productPublishWorkflowEngine } from "./product-publish-workflow.ts";
import { workflowStore } from "./workflow-store.ts";
import { dagWorkflowEngine } from "./dag-workflow-engine.ts";
import { notifyDagFinished, notifyDagPendingApproval } from "./feishu-notify.ts";

/** 判断是否为 DAG 工作流 */
function isDagRun(run: BusinessWorkflowRun): run is DagWorkflowRun {
  return "nodeStates" in run && "definition" in run;
}

export const workflowCoordinator = {
  list: () => workflowStore.list(),
  get: (id: string) => workflowStore.get(id),

  async approve(id: string): Promise<BusinessWorkflowRun> {
    const run = await requireRun(id);
    if (isDagRun(run)) {
      const updated = await dagWorkflowEngine.approve(run);
      const saved = await workflowStore.update(id, () => updated);
      // 审批通过后继续执行：若遇到新的审批节点再推卡，结束则推结果
      if (saved.status === "waiting_confirmation") {
        void notifyDagPendingApproval(saved);
      } else if (saved.status === "completed" || saved.status === "failed") {
        void notifyDagFinished(saved);
      }
      return saved;
    }
    if (run.type === "flash_sale") return flashSaleWorkflowEngine.approve(id);
    if (run.type === "kol_outreach") return kolOutreachWorkflowEngine.approve(id);
    return productPublishWorkflowEngine.approve(id);
  },

  async retry(id: string): Promise<BusinessWorkflowRun> {
    const run = await requireRun(id);
    if (isDagRun(run)) {
      const updated = await dagWorkflowEngine.retry(run);
      return workflowStore.update(id, () => updated);
    }
    if (run.type === "flash_sale") return flashSaleWorkflowEngine.retry(id);
    if (run.type === "kol_outreach") return kolOutreachWorkflowEngine.retry(id);
    return productPublishWorkflowEngine.retry(id);
  },

  async verify(id: string): Promise<BusinessWorkflowRun> {
    const run = await requireRun(id);
    if (isDagRun(run)) return run; // DAG 工作流无需外部核验
    if (run.type === "flash_sale") return flashSaleWorkflowEngine.verify(id);
    if (run.type === "kol_outreach") return kolOutreachWorkflowEngine.verify(id);
    return productPublishWorkflowEngine.verify(id);
  },

  async cancel(id: string): Promise<BusinessWorkflowRun> {
    const run = await requireRun(id);
    if (isDagRun(run)) {
      const updated: DagWorkflowRun = { ...run, status: "cancelled", updatedAt: new Date().toISOString() };
      return workflowStore.update(id, () => updated);
    }
    if (run.type === "flash_sale") return flashSaleWorkflowEngine.cancel(id);
    if (run.type === "kol_outreach") return kolOutreachWorkflowEngine.cancel(id);
    return productPublishWorkflowEngine.cancel(id);
  },
};

async function requireRun(id: string): Promise<BusinessWorkflowRun> {
  const run = await workflowStore.get(id);
  if (!run) throw new Error("找不到这个业务任务。");
  return run;
}

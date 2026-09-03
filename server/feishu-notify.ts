import type { DagWorkflowRun } from "../shared/contracts.ts";
import { pushFeishuPost, type FeishuSendResult } from "./feishu-client.ts";

/**
 * 业务通知统一出口：DAG 审批卡 / 完成通知 / 日报推送。
 * 所有函数在飞书未配置时静默降级（返回 sent: false），不影响主流程。
 */

function nodeProgress(run: DagWorkflowRun): string {
  const done = run.nodeStates.filter((n) => n.state === "completed").length;
  return `已完成 ${done}/${run.nodeStates.length} 个节点`;
}

function runShortId(run: DagWorkflowRun): string {
  return run.id.slice(0, 8);
}

/** human_gate 进入等待确认时，向飞书推送审批提醒卡 */
export function notifyDagPendingApproval(run: DagWorkflowRun): Promise<FeishuSendResult> {
  const prompt = run.pendingConfirmation?.prompt ?? "等待人工确认";
  return pushFeishuPost(`【待审批】${run.title}`, [
    `${prompt}`,
    `${nodeProgress(run)} · 任务号 ${runShortId(run)}`,
    "",
    "请打开系统工作台，在任务中心点击「审核通过」继续，",
    "或在任务卡片中拒绝。聊天文本不会绕过审核直接写入。",
  ]);
}

/** DAG 工作流完成或失败时，向飞书推送结果通知 */
export function notifyDagFinished(run: DagWorkflowRun): Promise<FeishuSendResult> {
  if (run.status === "completed") {
    return pushFeishuPost(`【已完成】${run.title}`, [
      run.result?.summary ?? "工作流执行完成",
      `任务号 ${runShortId(run)}`,
    ]);
  }
  if (run.status === "failed") {
    return pushFeishuPost(`【执行失败】${run.title}`, [
      run.error ?? "工作流执行失败",
      `任务号 ${runShortId(run)}`,
      "",
      "可在工作台任务中心点击「重试」，系统只重跑失败节点。",
    ]);
  }
  return Promise.resolve({ sent: false, reason: `状态 ${run.status} 无需通知` });
}

/** 定时经营报告推送到飞书（日报 / 周报共用） */
export function notifyFeishuReport(
  title: string,
  lines: string[],
): Promise<FeishuSendResult> {
  return pushFeishuPost(title, lines);
}

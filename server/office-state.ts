import type { OfficeAgentStatus, OfficeSnapshot } from "../shared/contracts.ts";
import { DIGITAL_EMPLOYEES } from "../shared/digital-employees.ts";
import { actionPlanStore } from "./action-plan-store.ts";
import { agentRegistry } from "./agent-registry.ts";
import { taskQueue } from "./task-queue.ts";
import { workflowStore } from "./workflow-store.ts";

function startOfTodayMs(now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/**
 * 聚合办公室页面所需的全部真实状态：
 * - 每位数字员工的运行时状态（agentRegistry，未实例化的视为空闲）
 * - 任务队列 / 工作流 / 审批计划的实时统计
 * 供 GET /api/office 与 /api/agents/stream SSE 快照共用。
 */
export async function buildOfficeSnapshot(): Promise<OfficeSnapshot> {
  const liveById = new Map(agentRegistry.getSnapshot().map((agent) => [agent.id, agent]));

  const agents: OfficeAgentStatus[] = DIGITAL_EMPLOYEES.map((employee) => {
    const live = liveById.get(employee.id);
    return {
      id: employee.id,
      name: employee.name,
      state: live?.state ?? "idle",
      currentTask: live?.currentTask,
      readiness: employee.status,
    };
  });

  const queueStats = taskQueue.getStats();
  const todayStart = startOfTodayMs();
  const tasksDoneToday = taskQueue
    .getHistory(200)
    .filter((task) => task.status === "done" && typeof task.completedAt === "number" && task.completedAt >= todayStart)
    .length;

  const [workflowsCompletedToday, workflowsWaitingConfirmation] = await Promise.all([
    workflowStore.countCompletedToday(),
    workflowStore.countByStatus(["waiting_confirmation", "verification_pending"]),
  ]);
  const pendingActionPlans = actionPlanStore.countByStatus(["pending", "verification_pending"]);

  return {
    agents,
    stats: {
      running: queueStats.running,
      queued: queueStats.queued,
      completedToday: tasksDoneToday + workflowsCompletedToday,
      pendingApprovals: pendingActionPlans + workflowsWaitingConfirmation,
      activeAgents: agents.filter((agent) => agent.state === "working").length,
      readyAgents: DIGITAL_EMPLOYEES.filter((employee) => employee.status === "ready").length,
      plannedAgents: DIGITAL_EMPLOYEES.filter((employee) => employee.status === "planned").length,
    },
    generatedAt: new Date().toISOString(),
  };
}

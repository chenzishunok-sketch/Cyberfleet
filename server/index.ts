import { loadEnvFile } from "node:process";
import { createApp } from "./app.ts";
import { startKolBridge } from "./kol-bridge.ts";
import { actionPlanStore } from "./action-plan-store.ts";
import { backupWorkflowDatabase } from "./database-backup.ts";
import { workflowStore } from "./workflow-store.ts";
import { startFeishuBridge } from "./feishu-bridge.ts";
import { configureNetworkProxy } from "./network-proxy.ts";
import { scheduler } from "./scheduler.ts";
import { ensureDefaultScheduleTasks } from "./proactive-agent.ts";
import { bridgeTaskQueueToAgentBus, taskQueue } from "./task-queue.ts";
import { preloadFastMossTools } from "./mcp-client.ts";
import { preloadChuhaijiangTools } from "./chuhaijiang-client.ts";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const networkProxy = configureNetworkProxy();
if (networkProxy) console.log("System network proxy enabled for external APIs");

// 启动任务队列事件桥接（任务入队/失败通过 agentBus 广播）
bridgeTaskQueueToAgentBus();

const port = Number(process.env.PORT ?? 8793);
const host = process.env.HOST ?? "127.0.0.1";

// 优先启动 HTTP 服务，恢复与备份任务并行异步执行，缩短就绪时间
const app = createApp();
app.listen(port, host, () => {
  console.log(`跨境电商多Agent协同系统 API listening on http://${host}:${port}`);
});

// 数据库初始化单独成组：备份必须排在它们之后。
// 备份以只读连接打开源库，若与建表/中断恢复的写入事务并发，只读连接会撞上
// 正在写入的 WAL 而抛 "disk I/O error"，导致当日备份静默缺失。
const databaseReady = Promise.all([
  (async () => {
    const recovery = actionPlanStore.recoverInterruptedPlans();
    if (recovery.expired || recovery.verificationPending) {
      console.log(`Recovered action plans: ${recovery.verificationPending} awaiting verification, ${recovery.expired} expired`);
    }
  })(),
  (async () => {
    const workflowRecovery = await workflowStore.recoverInterruptedRuns();
    if (workflowRecovery.failed || workflowRecovery.verificationPending) {
      console.log(`Recovered workflows: ${workflowRecovery.verificationPending} awaiting verification, ${workflowRecovery.failed} ready to retry`);
    }
  })(),
  (async () => {
    ensureDefaultScheduleTasks();
    scheduler.start();
  })(),
]);

void databaseReady.then(() => backupWorkflowDatabase()).catch((error) => {
  console.error(`Workflow database backup failed: ${error instanceof Error ? error.message : String(error)}`);
});

void Promise.all([
  databaseReady,
  startKolBridge().then(() => {
    console.log(`KOL browser bridge listening on ws://127.0.0.1:${process.env.KOL_BRIDGE_PORT ?? 8794}`);
  }).catch((error) => {
    console.error(`KOL browser bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  }),
  startFeishuBridge().then((status) => {
    if (status.connected) console.log("Feishu mobile bridge connected");
    else if (status.configured) console.error(`Feishu mobile bridge failed: ${status.error ?? "unknown error"}`);
  }),
  preloadFastMossTools(),
  preloadChuhaijiangTools(),
]);

// 优雅关闭：等待任务队列排空
process.on("SIGTERM", () => {
  void taskQueue.drain().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void taskQueue.drain().finally(() => process.exit(0));
});

// 防止未捕获的 Promise rejection 导致进程崩溃
process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", reason instanceof Error ? reason.message : String(reason));
});
process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception]", err.message);
});

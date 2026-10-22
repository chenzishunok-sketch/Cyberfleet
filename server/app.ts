import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { installAuthGate, isAuthEnabled } from "./auth-gate.ts";
import type { ChatRequest, MessageArtifact, SkuPricingRecord } from "../shared/contracts.ts";
import { AGENT_CONTEXTS, type AgentContext } from "../shared/digital-employees.ts";
import { approveAction, handleChat, rejectAction } from "./orchestrator.ts";
import { agentRegistry } from "./agent-registry.ts";
import { getCollaborationOverview, agentBus } from "./agent-bus.ts";
import { buildOfficeSnapshot } from "./office-state.ts";
import { dagWorkflowEngine, listExecutors } from "./dag-workflow-engine.ts";
import { listDagTemplates, getDagTemplate } from "./dag-templates.ts";
import { workflowStore } from "./workflow-store.ts";
import { scheduler } from "./scheduler.ts";
import { getRecentInsights } from "./proactive-agent.ts";
import { memoryLayer } from "./memory-layer.ts";
import { taskQueue } from "./task-queue.ts";
import { learningLoop } from "./learning-loop.ts";
import { completeTikTokAuthorization, createTikTokAuthorizationUrl, getTikTokConnectionStatus, listBindings, removeBinding, selectAuthorizedShop } from "./tiktok-auth.ts";
import {
  activateProvider,
  addProvider,
  getLlmProvidersOverview,
  getStoredProvider,
  importEnvProvider,
  listProviderModels,
  removeProvider,
  testLlmProvider,
  updateProvider,
} from "./llm-providers.ts";
import { getTikTokCapabilities } from "./tiktok-capabilities.ts";
import { getCurrentDashboard } from "./tiktok-data.ts";
import { getFeishuConnectionStatus, hasFeishuConfiguration } from "./feishu-client.ts";
import { notifyDagFinished, notifyDagPendingApproval } from "./feishu-notify.ts";
import { getFeishuBridgeStatus } from "./feishu-bridge.ts";
import { hasMiaoshouConfiguration } from "./miaoshou-client.ts";
import { productPublishWorkflowEngine, startProductPublishWorkflow } from "./product-publish-workflow.ts";
import { startFlashSaleWorkflow } from "./flash-sale-workflow.ts";
import { kolBridge } from "./kol-bridge.ts";
import { startKolOutreachWorkflow } from "./kol-outreach-workflow.ts";
import { getTmapiItemDetailById, hasTmapiConfiguration, TmapiError } from "./tmapi-client.ts";
import { workflowCoordinator } from "./workflow-coordinator.ts";
import { pricingStore } from "./pricing-store.ts";
import { createPricingWorkbook, pricingCsv } from "./pricing-export.ts";
import { importPricingCsv } from "./pricing-import.ts";
import { calculateActualSettlement, calculateSkuPricingWithActivity } from "./pricing-engine.ts";
import { applyProductPricing, syncPricingFromTikTok } from "./pricing-sync.ts";
import { applySupplierPricing, previewSupplierPricing } from "./pricing-1688.ts";
import { contentAssetPath, contentOverview, createImageContent, createTextContent, createVideoContent } from "./content-service.ts";
import {
  getSkillsCatalog,
  installSkill,
  uninstallSkill,
  enableSkill,
  disableSkill,
  clearSkillConfig,
  updateSkillConfig,
} from "./skill-registry.ts";
import { testSkillConnection } from "./skill-connectors.ts";
import { intelligenceStore } from "./intelligence-store.ts";
import { KNOWLEDGE_CATEGORIES } from "../shared/intelligence.ts";
import { searchWeb } from "./web-search-client.ts";

const chatSchema: z.ZodType<ChatRequest> = z.object({
  message: z.string().trim().min(1).max(4000),
  storeId: z.string().min(1),
  mode: z.enum(["analysis", "execute"]).optional(),
  context: z.enum(AGENT_CONTEXTS).optional(),
  attachments: z.array(z.object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(255),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    dataUrl: z.string().max(5_600_000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),
  })).max(1).optional(),
  history: z
    .array(z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().max(8000),
      artifact: z.custom<MessageArtifact>().optional(),
    }))
    .max(20)
    .optional(),
});

const selectShopSchema = z.object({
  shopId: z.string().min(1).max(200),
  grantId: z.string().min(1).max(100).optional(),
});
const llmProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1).max(300),
  apiKey: z.string().trim().max(300).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  fastModel: z.string().trim().max(120).optional(),
});
// 编辑换绑允许只提交部分字段
const llmProviderUpdateSchema = llmProviderInputSchema.partial();
const llmProviderProbeSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  apiKey: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
});
const tmapiItemQuerySchema = z.object({
  language: z.enum(["en", "zh", "ru", "th", "pt", "es", "tr", "vi", "ja", "ko"]).optional(),
  scene: z.literal("drop_shipping").optional(),
  optimizeTitle: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});
const createWorkflowSchema = z.object({
  sourceUrl: z.string().trim().url().max(2000),
  shopId: z.string().trim().min(1).max(200).optional(),
  publishPrice: z.number().positive().optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  packageDimensions: z.object({ length: z.number().min(1), width: z.number().min(1), height: z.number().min(1) }).optional(),
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().min(1).max(10000).optional(),
});
const productInputSchema = createWorkflowSchema.pick({ publishPrice: true, packageDimensions: true, title: true, description: true }).extend({ publishPrice: z.number().positive() });
const pricingValueSchema = z.object({
  salePriceThb: z.number().positive().optional(),
  purchasePriceCny: z.number().nonnegative().optional(),
  weightKg: z.number().positive().optional(),
  exchangeRateCnyToThb: z.number().positive().optional(),
  domesticLogisticsCny: z.number().nonnegative().optional(),
  cloudWarehouseCny: z.number().nonnegative().optional(),
  buyerLocalDeliveryThb: z.number().nonnegative().optional(),
  advertisingThb: z.number().nonnegative().optional(),
  creatorCommissionRate: z.number().nonnegative().max(1).optional(),
  taxRate: z.number().nonnegative().max(1).optional(),
  categoryCommissionRate: z.number().nonnegative().max(1).optional(),
  merchantDiscountThb: z.number().nonnegative().optional(),
  platformSubsidyThb: z.number().nonnegative().optional(),
  platformActivityFeeThb: z.number().nonnegative().optional(),
}).partial();
const pricingInputSchema = z.object({
  defaults: z.object({
    exchangeRateCnyToThb: z.number().positive().optional(),
    domesticLogisticsCny: z.number().nonnegative().optional(),
    cloudWarehouseCny: z.number().nonnegative().optional(),
    buyerLocalDeliveryThb: z.number().nonnegative().optional(),
    advertisingThb: z.number().nonnegative().optional(),
    creatorCommissionRate: z.number().nonnegative().max(1).optional(),
  }).partial().optional(),
  skus: z.array(z.object({ skuKey: z.string().min(1), values: pricingValueSchema })).max(500).optional(),
  removedSkuKeys: z.array(z.string().min(1)).max(499).optional(),
});
const pricingRecordUpdateSchema = z.object({
  input: pricingValueSchema.optional(),
  actual: z.object({
    period: z.string().trim().max(20).optional(),
    soldQuantity: z.number().int().positive().optional(),
    tiktokSettlementThb: z.number().nonnegative().optional(),
    logisticsDeductionThb: z.number().nonnegative().optional(),
    advertisingThb: z.number().nonnegative().optional(),
    creatorCommissionThb: z.number().nonnegative().optional(),
  }).partial().optional(),
});
const productPricingSchema = z.object({
  values: z.object({
    purchasePriceCny: z.number().positive().optional(),
    weightKg: z.number().positive().optional(),
    exchangeRateCnyToThb: z.number().positive().optional(),
    domesticLogisticsCny: z.number().nonnegative().optional(),
    cloudWarehouseCny: z.number().nonnegative().optional(),
    buyerLocalDeliveryThb: z.number().nonnegative().optional(),
    advertisingThb: z.number().nonnegative().optional(),
    creatorCommissionRate: z.number().nonnegative().max(1).optional(),
    taxRate: z.number().nonnegative().max(1).optional(),
    categoryCommissionRate: z.number().nonnegative().max(1).optional(),
  }).partial().refine((values) => Object.keys(values).length > 0),
});
const supplierPricingSchema = z.object({ sourceUrl: z.string().trim().url().max(2000) });

type PricingScope = "all" | "store" | "inactive" | "draft";

function pricingScope(value: unknown): PricingScope {
  return value === "store" || value === "inactive" || value === "draft" ? value : "all";
}

function isActiveStoreRecord(record: SkuPricingRecord): boolean {
  return Boolean(record.tiktokProductId && record.tiktokSkuId)
    && (record.tiktokStatus === "ACTIVATE" || !record.tiktokStatus);
}

function pricingRecordsInScope(records: SkuPricingRecord[], scope: PricingScope): SkuPricingRecord[] {
  return records.filter((record) => scope === "store" ? isActiveStoreRecord(record)
    : scope === "inactive" ? Boolean(record.tiktokProductId && record.tiktokSkuId && record.tiktokStatus === "INACTIVE")
    : scope === "draft" ? !(record.tiktokProductId && record.tiktokSkuId)
      : true);
}
const flashSaleSchema = z.object({
  productId: z.string().trim().regex(/^\d{10,30}$/),
  activityTitle: z.string().trim().min(1).max(100),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  priceAmount: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
  currency: z.string().trim().min(3).max(3).optional(),
  skuIds: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
  skuQuantityLimit: z.number().int(),
  quantityPerUser: z.number().int(),
});
const kolCreatorQuerySchema = z.object({
  category: z.string().trim().max(80).optional(),
  minFollowers: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const kolWorkflowSchema = z.object({
  category: z.string().trim().max(80).optional(),
  minFollowers: z.number().int().nonnegative().optional(),
  commissionRate: z.number().positive().max(100),
  message: z.string().trim().max(2000).optional(),
  batchSize: z.number().int().min(1).max(50),
  totalTarget: z.number().int().min(1).max(500),
  freeSample: z.boolean(),
});
const contentCommonSchema = z.object({
  title: z.string().trim().max(120).optional(),
  prompt: z.string().trim().min(2).max(6000),
  project: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(120).optional(),
});
const contentImageDataSchema = z.string().max(8_000_000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
const contentTextSchema = contentCommonSchema.extend({
  kind: z.enum(["title", "listing", "script"]),
  language: z.string().trim().min(1).max(40).optional(),
});
const contentImageSchema = contentCommonSchema.extend({
  ratio: z.enum(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]),
  size: z.enum(["1K", "2K", "3K", "4K"]),
  images: z.array(contentImageDataSchema).max(4).optional(),
});
const contentVideoSchema = contentCommonSchema.extend({
  ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]),
  resolution: z.enum(["480p", "720p", "1080p"]),
  duration: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(18)]),
  assetIds: z.array(z.string().uuid()).max(8).optional(),
  images: z.array(contentImageDataSchema).max(2).optional(),
});
const intelligenceScopes = ["global", ...AGENT_CONTEXTS] as const;
const knowledgeSchema = z.object({
  title: z.string().trim().min(2).max(160),
  content: z.string().trim().min(10).max(100_000),
  category: z.enum(KNOWLEDGE_CATEGORIES),
  scope: z.enum(intelligenceScopes),
  source: z.string().trim().max(500).default("用户录入"),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});
const knowledgePatchSchema = knowledgeSchema.partial().refine((value) => Object.keys(value).length > 0);
const promptRuleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  instruction: z.string().trim().min(10).max(8_000),
  scope: z.enum(intelligenceScopes),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});
const promptRulePatchSchema = promptRuleSchema.partial().refine((value) => Object.keys(value).length > 0);
const knowledgeSearchSchema = z.object({
  q: z.string().trim().min(2).max(500),
  scope: z.enum(AGENT_CONTEXTS).default("general"),
});
const webSearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  topic: z.enum(["general", "news"]).optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).optional(),
  maxResults: z.number().int().min(1).max(8).optional(),
  includeDomains: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  excludeDomains: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));
  // 登录表单以 application/x-www-form-urlencoded 提交
  app.use(express.urlencoded({ extended: false }));

  // 访问口令门：仅在设置了 APP_PASSWORD 时启用，未设置则完全跳过（本地开发无影响）。
  // 必须早于业务路由与静态资源注册，才能拦住所有入口。
  installAuthGate(app);

  // 前端构建产物目录：仅生产模式（或显式指定 WEB_DIST）时同端口托管前端。
  // 开发模式刻意不托管，避免打开 8795 看到旧的 dist 误以为代码已生效。
  const webDistDir = process.env.WEB_DIST?.trim()
    || (process.env.NODE_ENV === "production" ? path.resolve(process.cwd(), "dist") : undefined);
  const webIndexFile = webDistDir && fs.existsSync(path.join(webDistDir, "index.html"))
    ? path.join(webDistDir, "index.html")
    : undefined;

  // health 端点短缓存：前端轮询频繁，连接状态无需实时计算（5s TTL）
  let healthCache: { at: number; payload: unknown } | undefined;
  const HEALTH_TTL_MS = 5000;
  // 任何写操作（POST/PUT/PATCH/DELETE）都使 health 缓存失效，保证状态变更后立即反映
  app.use((req, _res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") healthCache = undefined;
    next();
  });

  app.get("/", (_request, response) => {
    // 有构建产物时直接返回应用首页，否则回退到跳转 Vite dev server（本地开发）
    if (webIndexFile) {
      response.sendFile(webIndexFile);
      return;
    }
    response.redirect(getFrontendUrl());
  });

  app.get("/api/health", async (_request, response) => {
    const now = Date.now();
    if (healthCache && now - healthCache.at < HEALTH_TTL_MS) {
      response.set("Cache-Control", "private, max-age=5");
      response.json(healthCache.payload);
      return;
    }
    const tiktok = await getTikTokConnectionStatus();
    const demoMode = process.env.DEMO_MODE === "true";
    const llmOverview = getLlmProvidersOverview();
    const miaoshou = hasMiaoshouConfiguration();
    const tmapi = hasTmapiConfiguration();
    const feishu = demoMode
      ? { configured: hasFeishuConfiguration(), connected: false }
      : await getFeishuConnectionStatus();
    const feishuBridge = getFeishuBridgeStatus();
    const connections = {
      llm: llmOverview.connected,
      tiktok: !demoMode && tiktok.connected,
      miaoshou: !demoMode && miaoshou,
      tmapi: !demoMode && tmapi,
      feishu: !demoMode && feishu.connected,
      kolBridge: kolBridge.isConnected(),
    };
    const mode = demoMode ? "demo" : connections.llm && connections.tiktok ? "connected" : "setup";
    const payload = {
      ok: true,
      mode,
      connections,
      // 登录门是否生效。部署后可直接查这个字段，避免"以为有口令其实没有"
      auth: { enabled: isAuthEnabled() },
      tiktok,
      llm: {
        connected: llmOverview.connected,
        source: llmOverview.source,
        ...(llmOverview.name ? { name: llmOverview.name } : {}),
        ...(llmOverview.model ? { model: llmOverview.model } : {}),
      },
      miaoshou: { connected: !demoMode && miaoshou },
      tmapi: { connected: !demoMode && tmapi },
      feishu: { ...feishu, longConnection: feishuBridge.connected, bridgeState: feishuBridge.state },
    };
    healthCache = { at: now, payload };
    response.set("Cache-Control", "private, max-age=5");
    response.json(payload);
  });

  // ─── Agent 注册中心：实例状态与能力查询 ────────────────────────

  app.get("/api/agents", (_request, response) => {
    response.json({ agents: agentRegistry.getSnapshot() });
  });

  app.get("/api/agents/collaboration", (_request, response) => {
    response.json(getCollaborationOverview());
  });

  // ─── 办公室实时状态快照（聚合 Agent 状态 + 队列/工作流/审批统计）──

  app.get("/api/office", async (_request, response) => {
    try {
      response.json(await buildOfficeSnapshot());
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "读取办公室状态失败。" });
    }
  });

  app.get("/api/agents/messages", (request, response) => {
    const from = request.query.from as string | undefined;
    const to = request.query.to as string | undefined;
    const filter = {
      ...(from ? { from: from as AgentContext } : {}),
      ...(to ? { to: to as AgentContext } : {}),
    };
    response.json({ messages: agentBus.getMessageLog(Object.keys(filter).length > 0 ? filter : undefined) });
  });

  // ─── 任务队列 + Agent 并发池 ────────────────────────────────

  app.get("/api/tasks/stats", (_request, response) => {
    response.json(taskQueue.getStats());
  });

  app.get("/api/tasks/queued", (_request, response) => {
    response.json({ tasks: taskQueue.getQueuedTasks() });
  });

  app.get("/api/tasks/running", (_request, response) => {
    response.json({ tasks: taskQueue.getRunningTasks() });
  });

  app.get("/api/tasks/history", (request, response) => {
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    response.json({ tasks: taskQueue.getHistory(limit) });
  });

  app.post("/api/tasks/:id/cancel", (request, response) => {
    const ok = taskQueue.cancel(request.params.id);
    response.status(ok ? 200 : 404).json({ ok });
  });

  // ─── SSE：实时 Agent 协作拓扑 + 任务队列事件流 ──────────────

  app.get("/api/agents/stream", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    const send = (event: { type: string } & Record<string, unknown>) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 初始快照：当前 Agent 状态 + 队列统计 + 办公室聚合状态
    const sendSnapshot = async () => {
      try {
        send({
          type: "snapshot",
          agents: agentRegistry.getSnapshot(),
          queueStats: taskQueue.getStats(),
          runningTasks: taskQueue.getRunningTasks(),
          queuedTasks: taskQueue.getQueuedTasks().slice(0, 20),
          office: await buildOfficeSnapshot(),
        });
      } catch (error) {
        console.error(`Office snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void sendSnapshot();

    // 桥接 agentBus 事件
    const onMessage = (msg: unknown) => send({ type: "agent:message", message: msg });
    const onStateChanged = (event: unknown) => send({ type: "agent:state-changed", event });
    const onDelegation = (req: unknown) => send({ type: "agent:delegation", request: req });
    const onDelegationResult = (result: unknown) => send({ type: "agent:delegation-result", result });

    agentBus.on("agent:message", onMessage);
    agentBus.on("agent:state-changed", onStateChanged);
    agentBus.on("agent:delegation", onDelegation);
    agentBus.on("agent:delegation-result", onDelegationResult);

    // 桥接 taskQueue 事件
    const onTaskQueued = (task: unknown) => send({ type: "task:queued", task });
    const onTaskStarted = (task: unknown) => send({ type: "task:started", task });
    const onTaskDone = (task: unknown) => send({ type: "task:done", task });
    const onTaskFailed = (task: unknown) => send({ type: "task:failed", task });

    taskQueue.on("task:queued", onTaskQueued);
    taskQueue.on("task:started", onTaskStarted);
    taskQueue.on("task:done", onTaskDone);
    taskQueue.on("task:failed", onTaskFailed);

    // 定期推送快照（每 5 秒）
    const snapshotInterval = setInterval(() => {
      void sendSnapshot();
    }, 5_000);

    // 心跳（每 30 秒）
    const heartbeat = setInterval(() => {
      response.write(": heartbeat\n\n");
    }, 30_000);

    // 清理
    request.on("close", () => {
      clearInterval(snapshotInterval);
      clearInterval(heartbeat);
      agentBus.off("agent:message", onMessage);
      agentBus.off("agent:state-changed", onStateChanged);
      agentBus.off("agent:delegation", onDelegation);
      agentBus.off("agent:delegation-result", onDelegationResult);
      taskQueue.off("task:queued", onTaskQueued);
      taskQueue.off("task:started", onTaskStarted);
      taskQueue.off("task:done", onTaskDone);
      taskQueue.off("task:failed", onTaskFailed);
      response.end();
    });
  });

  // ─── DAG 工作流引擎 ──────────────────────────────────────────

  app.get("/api/dag/templates", (_request, response) => {
    response.json({ templates: listDagTemplates() });
  });

  app.get("/api/dag/executors", (_request, response) => {
    response.json({ executors: listExecutors() });
  });

  app.post("/api/dag/runs", (request, response) => {
    const { templateType, input, title } = request.body as { templateType: string; input?: Record<string, unknown>; title?: string };
    const template = getDagTemplate(templateType);
    if (!template) {
      response.status(400).json({ error: `未知的 DAG 模板类型：${templateType}` });
      return;
    }
    const run = dagWorkflowEngine.create(template, input ?? {}, title);
    void workflowStore.create(run).then(async (created) => {
      const executed = await dagWorkflowEngine.run(created);
      await workflowStore.update(created.id, () => executed);
      // 状态通知：进入人工审批时推飞书审批卡；完成/失败时推结果
      if (executed.status === "waiting_confirmation") {
        void notifyDagPendingApproval(executed);
      } else if (executed.status === "completed" || executed.status === "failed") {
        void notifyDagFinished(executed);
      }
    });
    response.status(202).json({ id: run.id, status: "started", message: "DAG 工作流已启动" });
  });

  // ─── 调度引擎 + 主动式 Agent ─────────────────────────────────

  app.get("/api/scheduler/tasks", (_request, response) => {
    response.json({ tasks: scheduler.list() });
  });

  app.post("/api/scheduler/tasks", (request, response) => {
    const { name, description, cron, type, params, agent } = request.body as {
      name: string; description?: string; cron: string;
      type: "read_only_query" | "proactive_inspection" | "report_generation" | "learning_reflection";
      params?: Record<string, unknown>; agent?: string;
    };
    try {
      const task = scheduler.create({ name, description, cron, type, params: params ?? {}, agent });
      response.status(201).json(task);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "创建任务失败" });
    }
  });

  app.post("/api/scheduler/tasks/:id/run", async (request, response) => {
    const log = await scheduler.runOnce(request.params.id);
    if (!log) { response.status(404).json({ error: "任务不存在" }); return; }
    response.json(log);
  });

  app.post("/api/scheduler/tasks/:id/pause", (request, response) => {
    const task = scheduler.pause(request.params.id);
    if (!task) { response.status(404).json({ error: "任务不存在" }); return; }
    response.json(task);
  });

  app.post("/api/scheduler/tasks/:id/resume", (request, response) => {
    const task = scheduler.resume(request.params.id);
    if (!task) { response.status(404).json({ error: "任务不存在" }); return; }
    response.json(task);
  });

  app.delete("/api/scheduler/tasks/:id", (request, response) => {
    const deleted = scheduler.delete(request.params.id);
    response.status(deleted ? 200 : 404).json({ deleted });
  });

  app.get("/api/scheduler/logs", (request, response) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    response.json({ logs: scheduler.getLogs(limit) });
  });

  app.get("/api/scheduler/insights", (request, response) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    response.json({ insights: getRecentInsights(limit) });
  });

  app.get("/api/content", async (_request, response) => {
    response.json(await contentOverview());
  });

  // ─── 智能中心：业务知识与提示词规则 ──────────────────────────

  app.get("/api/intelligence", (_request, response) => {
    response.json(intelligenceStore.overview());
  });

  app.get("/api/intelligence/search", (request, response) => {
    const parsed = knowledgeSearchSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "请输入至少两个字的测试问题。" });
      return;
    }
    response.json({ matches: intelligenceStore.searchKnowledge(parsed.data.q, parsed.data.scope) });
  });

  app.post("/api/intelligence/web-search", async (request, response) => {
    const parsed = webSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请输入至少两个字的搜索问题。" });
      return;
    }
    try {
      response.json(await searchWeb(parsed.data));
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "联网搜索失败。" });
    }
  });

  app.post("/api/intelligence/knowledge", (request, response) => {
    const parsed = knowledgeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "知识内容不完整，请检查标题、正文和适用范围。" });
      return;
    }
    response.status(201).json({ entry: intelligenceStore.createKnowledge(parsed.data) });
  });

  app.patch("/api/intelligence/knowledge/:id", (request, response) => {
    const parsed = knowledgePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "知识更新内容不正确。" });
      return;
    }
    const entry = intelligenceStore.updateKnowledge(request.params.id, parsed.data);
    if (!entry) {
      response.status(404).json({ error: "没有找到这条知识。" });
      return;
    }
    response.json({ entry });
  });

  app.delete("/api/intelligence/knowledge/:id", (request, response) => {
    if (!intelligenceStore.deleteKnowledge(request.params.id)) {
      response.status(404).json({ error: "没有找到这条知识。" });
      return;
    }
    response.json({ ok: true });
  });

  app.post("/api/intelligence/prompts", (request, response) => {
    const parsed = promptRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "提示词规则不完整。" });
      return;
    }
    response.status(201).json({ rule: intelligenceStore.createPromptRule(parsed.data) });
  });

  app.patch("/api/intelligence/prompts/:id", (request, response) => {
    const parsed = promptRulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "提示词规则更新内容不正确。" });
      return;
    }
    const rule = intelligenceStore.updatePromptRule(request.params.id, parsed.data);
    if (!rule) {
      response.status(404).json({ error: "没有找到这条提示词规则。" });
      return;
    }
    response.json({ rule });
  });

  app.delete("/api/intelligence/prompts/:id", (request, response) => {
    if (!intelligenceStore.deletePromptRule(request.params.id)) {
      response.status(409).json({ error: "系统内置规则不能删除，可以将它停用。" });
      return;
    }
    response.json({ ok: true });
  });

  app.get("/api/content/files/:fileName", (request, response) => {
    const path = contentAssetPath(request.params.fileName);
    if (!path) {
      response.status(404).json({ error: "素材不存在。" });
      return;
    }
    response.sendFile(path, { dotfiles: "allow" }, (error) => {
      if (error && !response.headersSent) response.status(404).json({ error: "素材文件不存在。" });
    });
  });

  // ─── 记忆分层：Agent 私有记忆 + 共享记忆层 ───────────────────

  app.get("/api/memory/overview", (_request, response) => {
    response.json(memoryLayer.overview());
  });

  app.get("/api/memory/shared", (_request, response) => {
    response.json(memoryLayer.getShared());
  });

  app.get("/api/memory/private/:agent", (request, response) => {
    const agent = request.params.agent;
    response.json(memoryLayer.getPrivate(agent));
  });

  app.post("/api/memory/search", (request, response) => {
    const { query, agent, limit } = (request.body ?? {}) as { query?: string; agent?: string; limit?: number };
    if (!query?.trim() || !agent?.trim()) {
      response.status(400).json({ error: "请提供 query 和 agent 参数。" });
      return;
    }
    response.json({ results: memoryLayer.retrieve(query, agent, Math.min(limit ?? 5, 20)) });
  });

  app.post("/api/memory/clear", (_request, response) => {
    memoryLayer.clear();
    response.json({ ok: true });
  });

  // ─── 闭环学习：决策追踪 + 结果回收 + LLM 反思 ───────────────

  app.get("/api/learning/overview", (_request, response) => {
    response.json(learningLoop.overview());
  });

  app.get("/api/learning/recent", (request, response) => {
    const limit = Math.min(Number(request.query.limit ?? 20), 100);
    response.json({ records: learningLoop.getRecent(limit) });
  });

  app.post("/api/learning/reflect", async (request, response) => {
    const { limit } = (request.body ?? {}) as { limit?: number };
    const count = await learningLoop.runReflectionBatch(Math.min(limit ?? 3, 10));
    response.json({ reflected: count, overview: learningLoop.overview() });
  });

  app.post("/api/content/text", async (request, response) => {
    const parsed = contentTextSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请完整填写文字创作要求。" });
      return;
    }
    try { response.json(await createTextContent(parsed.data)); }
    catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : "文字生成失败。" }); }
  });

  app.post("/api/content/images", async (request, response) => {
    const parsed = contentImageSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "图片生成参数不正确。" });
      return;
    }
    try { response.json(await createImageContent(parsed.data)); }
    catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : "图片生成失败。" }); }
  });

  app.post("/api/content/videos", async (request, response) => {
    const parsed = contentVideoSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "视频生成参数不正确。" });
      return;
    }
    try { response.status(202).json(await createVideoContent(parsed.data)); }
    catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : "视频任务创建失败。" }); }
  });

  app.get("/api/tmapi/1688/items/:itemId", async (request, response) => {
    const itemId = request.params.itemId;
    const query = tmapiItemQuerySchema.safeParse(request.query);
    if (!/^\d{6,20}$/.test(itemId) || !query.success) {
      response.status(400).json({ error: "1688 商品 ID 或查询参数不正确。" });
      return;
    }
    try {
      const data = await getTmapiItemDetailById(itemId, query.data);
      response.json({ data, source: "TMAPI" });
    } catch (error) {
      const status = error instanceof TmapiError && error.statusCode === 422 ? 400 : 502;
      response.status(status).json({ error: error instanceof Error ? error.message : "读取 1688 商品失败。" });
    }
  });

  app.get("/api/tiktok/authorize", (_request, response) => {
    try {
      const authorizationUrl = createTikTokAuthorizationUrl();
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("无法生成 TikTok Shop 授权安全参数。");
      response.setHeader("set-cookie", oauthStateCookie(state));
      response.redirect(authorizationUrl);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法开始 TikTok Shop 授权。" });
    }
  });

  app.get("/api/tiktok/callback", async (request, response) => {
    const queryValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
    const frontendUrl = getFrontendUrl();
    response.setHeader("set-cookie", oauthStateCookie("", 0));
    // OAuth 回调是 GET 但会改变授权状态，需显式失效 health 缓存
    healthCache = undefined;

    try {
      const result = await completeTikTokAuthorization({
        code: queryValue(request.query.auth_code) ?? queryValue(request.query.code),
        state: queryValue(request.query.state),
        browserState: readCookie(request.headers.cookie, "shop_pilot_tiktok_oauth_state"),
        error: queryValue(request.query.error),
      });
      const message = result.selectedShop
        ? `店铺 ${result.selectedShop.name} (${result.selectedShop.region}) 已完成授权，系统也已自动取得 shop cipher。`
        : `已授权 ${result.shops.length} 个店铺。请返回跨境电商多Agent协同系统，明确选择要操作的店铺。`;
      response.type("html").send(renderAuthorizationPage({
        title: "TikTok Shop 已连接",
        message,
        frontendUrl: `${frontendUrl}/?bind=tiktok&result=success`,
        success: true,
      }));
    } catch (error) {
      response.status(400).type("html").send(renderAuthorizationPage({
        title: "TikTok Shop 授权未完成",
        message: error instanceof Error ? error.message : "授权失败，请返回应用重新尝试。",
        frontendUrl: `${frontendUrl}/?bind=tiktok&result=error`,
        success: false,
      }));
    }
  });

  app.post("/api/tiktok/shop", async (request, response) => {
    const parsed = selectShopSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请选择一个已授权店铺。" });
      return;
    }
    try {
      const shop = await selectAuthorizedShop(parsed.data.shopId, parsed.data.grantId);
      response.json({ shop, tiktok: await getTikTokConnectionStatus() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法选择店铺。" });
    }
  });

  // ─── 多店铺绑定管理：列表 / 解绑 ─────────────────────────────

  app.get("/api/tiktok/bindings", async (_request, response) => {
    try {
      response.json({ bindings: await listBindings(), tiktok: await getTikTokConnectionStatus() });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "读取店铺绑定失败。" });
    }
  });

  app.delete("/api/tiktok/bindings/:grantId", async (request, response) => {
    const grantId = typeof request.params.grantId === "string" ? request.params.grantId : "";
    if (!grantId) {
      response.status(400).json({ error: "缺少绑定编号。" });
      return;
    }
    try {
      await removeBinding(grantId);
      healthCache = undefined;
      response.json({ ok: true, tiktok: await getTikTokConnectionStatus() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "解绑失败。" });
    }
  });

  app.get("/api/dashboard", async (_request, response) => {
    try {
      response.json(await getCurrentDashboard());
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "读取 TikTok Shop 数据失败。" });
    }
  });

  // ─── 大模型供应商绑定：列表 / 新增 / 换绑 / 解绑 / 切换 / 测试 ────

  app.get("/api/llm/providers", (_request, response) => {
    response.json(getLlmProvidersOverview());
  });

  app.post("/api/llm/providers", async (request, response) => {
    const parsed = llmProviderInputSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.model) {
      response.status(400).json({ error: "请填写服务名称、Base URL 和模型名称。" });
      return;
    }
    try {
      const provider = await addProvider({
        name: parsed.data.name,
        baseUrl: parsed.data.baseUrl,
        apiKey: parsed.data.apiKey ?? "",
        model: parsed.data.model,
        ...(parsed.data.fastModel ? { fastModel: parsed.data.fastModel } : {}),
      });
      response.json({ provider, overview: getLlmProvidersOverview() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "保存模型服务失败。" });
    }
  });

  app.put("/api/llm/providers/:id", async (request, response) => {
    const parsed = llmProviderUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "提交的模型服务信息不完整。" });
      return;
    }
    try {
      const provider = await updateProvider(request.params.id as string, parsed.data);
      response.json({ provider, overview: getLlmProvidersOverview() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "更新模型服务失败。" });
    }
  });

  app.delete("/api/llm/providers/:id", async (request, response) => {
    try {
      await removeProvider(request.params.id as string);
      response.json({ ok: true, overview: getLlmProvidersOverview() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "解绑模型服务失败。" });
    }
  });

  app.post("/api/llm/providers/:id/activate", async (request, response) => {
    try {
      const provider = await activateProvider(request.params.id as string);
      response.json({ provider, overview: getLlmProvidersOverview() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "切换模型服务失败。" });
    }
  });

  // 测试连接：带 id 且 apiKey 留空/带回显掩码时复用已保存的密钥
  app.post("/api/llm/providers/import-env", async (_request, response) => {
    try {
      const provider = await importEnvProvider();
      response.json({ provider, overview: getLlmProvidersOverview() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "导入 .env 配置失败。" });
    }
  });

  app.post("/api/llm/providers/test", async (request, response) => {
    const parsed = llmProviderProbeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请求参数不完整。" });
      return;
    }
    try {
      let { baseUrl, apiKey, model } = parsed.data;
      if (parsed.data.id) {
        const stored = getStoredProvider(parsed.data.id);
        if (!stored) {
          response.status(400).json({ error: "没有找到这个模型服务。" });
          return;
        }
        baseUrl = baseUrl || stored.baseUrl;
        if (!apiKey || apiKey.includes("*")) apiKey = stored.apiKey;
        model = model || stored.model;
      }
      const result = await testLlmProvider({ baseUrl: baseUrl ?? "", apiKey: apiKey ?? "", model: model ?? "" });
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "测试连接失败。" });
    }
  });

  app.post("/api/llm/providers/models", async (request, response) => {
    const parsed = llmProviderProbeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请求参数不完整。" });
      return;
    }
    try {
      let { baseUrl, apiKey } = parsed.data;
      if (parsed.data.id) {
        const stored = getStoredProvider(parsed.data.id);
        if (!stored) {
          response.status(400).json({ error: "没有找到这个模型服务。" });
          return;
        }
        baseUrl = baseUrl || stored.baseUrl;
        if (!apiKey || apiKey.includes("*")) apiKey = stored.apiKey;
      }
      response.json(await listProviderModels({ baseUrl: baseUrl ?? "", apiKey: apiKey ?? "" }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "读取模型列表失败。" });
    }
  });

  app.get("/api/capabilities", async (_request, response) => {
    try {
      response.json(await getTikTokCapabilities());
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "读取 TikTok Shop 权限状态失败。" });
    }
  });

  // ─── KOL 达人建联 ─────────────────────────────

  app.get("/api/kol/status", (_request, response) => {
    response.json(kolBridge.status());
  });

  app.get("/api/kol/creators", async (request, response) => {
    const parsed = kolCreatorQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "达人筛选条件不正确。" });
      return;
    }
    try {
      response.json({ creators: await kolBridge.listCreators(parsed.data), source: "browser_bridge" });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "无法读取达人库。" });
    }
  });

  app.get("/api/kol/stats", async (_request, response) => {
    try {
      response.json({ stats: await kolBridge.getStats(), source: "browser_bridge" });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "无法读取达人统计。" });
    }
  });

  app.get("/api/kol/overview", async (_request, response) => {
    const status = kolBridge.status();
    if (!status.connected) {
      response.json({ status, creators: [], stats: null });
      return;
    }
    try {
      const [creators, stats] = await Promise.all([
        kolBridge.listCreators({ limit: 200 }),
        kolBridge.getStats(),
      ]);
      response.json({ status, creators, stats });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "无法读取达人工作台。" });
    }
  });

  // ─── 本地发布任务 ─────────────────────────────

  app.get("/api/pricing", (request, response) => {
    const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId : undefined;
    const scope = pricingScope(request.query.scope);
    const records = workflowId ? pricingStore.listByWorkflow(workflowId) : pricingStore.list();
    response.json({ records: pricingRecordsInScope(records, scope) });
  });

  app.get("/api/pricing/history/:workflowId", (request, response) => {
    response.json({ records: pricingStore.history(request.params.workflowId) });
  });

  app.post("/api/pricing/sync", async (_request, response) => {
    try {
      response.json(await syncPricingFromTikTok());
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "无法同步 TikTok 商品。" });
    }
  });

  app.patch("/api/pricing/product/:productId", (request, response) => {
    const parsed = productPricingSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请至少填写一项有效成本；采购价、重量和汇率必须大于 0。" });
      return;
    }
    try {
      response.json(applyProductPricing(pricingStore, request.params.productId, parsed.data.values));
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "无法批量保存商品成本。" });
    }
  });

  app.post("/api/pricing/product/:productId/1688/preview", async (request, response) => {
    const parsed = supplierPricingSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请填写有效的 1688 商品链接。" });
      return;
    }
    try {
      const records = pricingStore.list().filter((record) => record.tiktokProductId === request.params.productId);
      if (!records.length) {
        response.status(404).json({ error: "找不到这个 TikTok 商品的 SKU 记录。" });
        return;
      }
      response.json({ preview: await previewSupplierPricing(records, parsed.data.sourceUrl) });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "1688 采购价识别失败。" });
    }
  });

  app.post("/api/pricing/product/:productId/1688/apply", async (request, response) => {
    const parsed = supplierPricingSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请填写有效的 1688 商品链接。" });
      return;
    }
    try {
      const records = pricingStore.list().filter((record) => record.tiktokProductId === request.params.productId);
      if (!records.length) {
        response.status(404).json({ error: "找不到这个 TikTok 商品的 SKU 记录。" });
        return;
      }
      const preview = await previewSupplierPricing(records, parsed.data.sourceUrl);
      const result = applySupplierPricing(pricingStore, preview, records);
      response.json({ ...result, preview });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "1688 采购价写入失败。" });
    }
  });

  app.patch("/api/pricing/:id", (request, response) => {
    const parsed = pricingRecordUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请检查成本、佣金和实际结算数据，数值不能小于 0。" });
      return;
    }
    const updated = pricingStore.update(request.params.id, (record) => {
      const input = { ...record.input, ...(parsed.data.input ?? {}) };
      const actualInput = parsed.data.actual ? { ...record.actualInput, ...parsed.data.actual } : record.actualInput;
      return {
        ...record,
        input,
        result: calculateSkuPricingWithActivity(input, record.activityPriceThb),
        actualInput,
        actualResult: actualInput ? calculateActualSettlement(input, actualInput) : undefined,
        fieldSources: {
          ...record.fieldSources,
          ...Object.fromEntries(Object.keys(parsed.data.input ?? {}).map((field) => [field, "manual" as const])),
        },
        missingFields: record.missingFields.filter((field) => !(field in (parsed.data.input ?? {}))),
        calculatedAt: new Date().toISOString(),
      };
    });
    if (!updated) {
      response.status(404).json({ error: "找不到这个 SKU 记录。" });
      return;
    }
    response.json({ record: updated });
  });

  app.get("/api/pricing/export.xlsx", (request, response) => {
    try {
      const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId : undefined;
      const scope = pricingScope(request.query.scope);
      const records = pricingRecordsInScope(workflowId ? pricingStore.listByWorkflow(workflowId) : pricingStore.list(), scope);
      const history = pricingRecordsInScope(workflowId ? pricingStore.history(workflowId) : pricingStore.historyAll(), scope);
      if (!records.length) {
        response.status(404).json({ error: "还没有可导出的 SKU 利润记录。" });
        return;
      }
      const path = createPricingWorkbook(records, history, workflowId ?? "all");
      response.download(path, "TikTok-Shop-SKU成本利润.xlsx");
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Excel 导出失败。" });
    }
  });

  app.get("/api/pricing/export.csv", (request, response) => {
    const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId : undefined;
    const scope = pricingScope(request.query.scope);
    const records = pricingRecordsInScope(workflowId ? pricingStore.listByWorkflow(workflowId) : pricingStore.list(), scope);
    if (!records.length) {
      response.status(404).json({ error: "还没有可导出的 SKU 利润记录。" });
      return;
    }
    response.type("text/csv; charset=utf-8").attachment("TikTok-Shop-SKU成本利润.csv").send(pricingCsv(records));
  });

  app.post("/api/pricing/import", (request, response) => {
    const csv = typeof request.body === "string" ? request.body : String(request.body ?? "");
    if (!csv.trim()) {
      response.status(400).json({ error: "CSV 内容为空。" });
      return;
    }
    try {
      const result = importPricingCsv(csv);
      if (result.records.length) pricingStore.upsert(result.records);
      response.json({
        imported: result.records.length,
        errors: result.errors,
        workflowId: result.workflowId,
        records: result.records,
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "CSV 导入失败。" });
    }
  });

  app.get("/api/workflows", async (_request, response) => {
    response.json({ runs: await workflowCoordinator.list() });
  });

  app.get("/api/workflows/:id", async (request, response) => {
    const run = await workflowCoordinator.get(request.params.id);
    if (!run) {
      response.status(404).json({ error: "找不到这个发布任务。" });
      return;
    }
    response.json({ run });
  });

  app.get("/api/workflows/:id/history", async (request, response) => {
    const run = await workflowCoordinator.get(request.params.id);
    if (!run) {
      response.status(404).json({ error: "找不到这个业务任务。" });
      return;
    }
    response.json({ events: await workflowStore.history(request.params.id) });
  });

  app.post("/api/workflows/product-publish", async (request, response) => {
    const parsed = createWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请输入完整的 1688 商品链接。" });
      return;
    }
    try {
      response.status(201).json({ run: await startProductPublishWorkflow(parsed.data) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法创建发布任务。" });
    }
  });

  app.post("/api/workflows/flash-sale", async (request, response) => {
    const parsed = flashSaleSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请完整填写商品 ID、活动时间、秒杀价、活动库存和每人限购。" });
      return;
    }
    try {
      response.status(201).json({ run: await startFlashSaleWorkflow(parsed.data) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法创建秒杀任务。" });
    }
  });

  app.post("/api/workflows/kol-outreach", async (request, response) => {
    const parsed = kolWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请检查达人筛选、佣金、目标人数和每批人数。" });
      return;
    }
    try {
      response.status(201).json({ run: await startKolOutreachWorkflow(parsed.data) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "无法创建达人建联任务。" });
    }
  });

  app.post("/api/workflows/:id/shop", async (request, response) => {
    const parsed = selectShopSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请选择一个店铺。" });
      return;
    }
    try {
      response.json({ run: await productPublishWorkflowEngine.selectShop(request.params.id, parsed.data.shopId) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "无法选择店铺。" });
    }
  });

  app.post("/api/workflows/:id/product-input", async (request, response) => {
    const parsed = productInputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请输入正确的发布售价；尺寸如填写，长宽高都必须大于 0。" });
      return;
    }
    try {
      response.json({ run: await productPublishWorkflowEngine.updateProductInput(request.params.id, parsed.data) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "无法保存商品输入。" });
    }
  });

  app.post("/api/workflows/:id/pricing", async (request, response) => {
    const parsed = pricingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "请检查 SKU 售价、成本、重量和费率，数值不能小于 0。" });
      return;
    }
    try {
      response.json({ run: await productPublishWorkflowEngine.updatePricingInput(request.params.id, parsed.data) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "无法保存 SKU 成本和利润。" });
    }
  });

  const workflowAction = (action: "approve" | "retry" | "verify" | "cancel") => async (
    request: express.Request,
    response: express.Response,
  ) => {
    try {
      response.json({ run: await workflowCoordinator[action](String(request.params.id)) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "任务操作失败。" });
    }
  };

  app.post("/api/workflows/:id/approve", workflowAction("approve"));
  app.post("/api/workflows/:id/retry", workflowAction("retry"));
  app.post("/api/workflows/:id/verify", workflowAction("verify"));
  app.post("/api/workflows/:id/cancel", workflowAction("cancel"));
  app.post("/api/workflows/:id/readiness", async (request, response) => {
    try {
      response.json({ run: await productPublishWorkflowEngine.recheckReadiness(String(request.params.id)) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "无法重新检查商品信息。" });
    }
  });

  // ─── Skill 管理 ─────────────────────────────────────────────

  app.get("/api/skills", async (_request, response) => {
    try {
      response.json(await getSkillsCatalog());
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : "读取 Skill 目录失败。" });
    }
  });

  app.post("/api/skills/:id/install", async (request, response) => {
    try {
      const status = await installSkill(request.params.id);
      response.json(status);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "安装失败。" });
    }
  });

  app.post("/api/skills/:id/uninstall", async (request, response) => {
    try {
      await uninstallSkill(request.params.id);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "卸载失败。" });
    }
  });

  app.post("/api/skills/:id/enable", async (request, response) => {
    try {
      const status = await enableSkill(request.params.id);
      response.json(status);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "启用失败。" });
    }
  });

  app.post("/api/skills/:id/disable", async (request, response) => {
    try {
      const status = await disableSkill(request.params.id);
      response.json(status);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "禁用失败。" });
    }
  });

  app.put("/api/skills/:id/config", async (request, response) => {
    const config = request.body?.config;
    if (!config || typeof config !== "object") {
      response.status(400).json({ error: "配置格式不正确。" });
      return;
    }
    try {
      const status = await updateSkillConfig(request.params.id, config as Record<string, string>);
      response.json(status);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "更新配置失败。" });
    }
  });

  // 连接测试：用当前生效配置（界面保存 > .env）发一次最小真实业务调用
  app.post("/api/skills/:id/test", async (request, response) => {
    const skillId = request.params.id as string;
    if (skillId === "tiktok-shop") {
      response.status(400).json({ error: "TikTok Shop 请在「TikTok Shop 店铺绑定」区完成授权与测试。" });
      return;
    }
    response.json(await testSkillConnection(skillId));
  });

  // 解绑：清除界面保存的配置，回落 .env
  app.delete("/api/skills/:id/config", async (request, response) => {
    try {
      await clearSkillConfig(request.params.id as string);
      response.json({ ok: true, catalog: await getSkillsCatalog() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "解绑失败。" });
    }
  });

  app.post("/api/chat", async (request, response) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "指令格式不正确。", details: parsed.error.flatten() });
      return;
    }

    // 内容协商：Accept: text/event-stream 走 SSE 流式，否则走 JSON（保持测试兼容）
    const wantsStream = (request.headers.accept ?? "").includes("text/event-stream");
    if (!wantsStream) {
      try {
        response.json(await handleChat(parsed.data));
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : "处理指令失败。" });
      }
      return;
    }

    // SSE 流式：步骤进度实时推送，最后推送 final 事件
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    const send = (event: { type: string } & Record<string, unknown>) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await handleChat(parsed.data, (e) => send(e));
      send({ type: "final", response: result });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : "处理指令失败。" });
    } finally {
      response.end();
    }
  });

  app.post("/api/actions/:id/approve", async (request, response) => {
    try {
      response.json(await approveAction(request.params.id));
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "执行失败。" });
    }
  });

  app.post("/api/actions/:id/reject", (request, response) => {
    try {
      response.json({ plan: rejectAction(request.params.id) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : "无法取消。" });
    }
  });

  app.post("/api/automations/:id/toggle", async (request, response) => {
    // 读当前数据源（真实模式为 TikTok 实时数据，演示模式为内置演示数据），
    // 不再固定使用演示数据里的自动任务，避免真实模式下操作到假对象。
    const current = await getCurrentDashboard();
    const automation = current.automations.find((item) => item.id === request.params.id);
    if (!automation) {
      response.status(404).json({ error: "未找到该自动任务。" });
      return;
    }
    automation.enabled = !automation.enabled;
    response.json({ automation });
  });

  // 生产单端口：若存在前端构建产物（npm run build 生成的 dist），由本服务直接托管，
  // 不再依赖 Vite dev server。云托管/演示环境只需要暴露一个端口。
  if (webIndexFile && webDistDir) {
    app.use(express.static(webDistDir, { index: false, maxAge: "1h" }));
    app.use((request, response, next) => {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      if (request.path === "/api" || request.path.startsWith("/api/")) return next();
      response.sendFile(webIndexFile);
    });
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error);
    response.status(500).json({ error: "服务暂时不可用，请稍后重试。" });
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function oauthStateCookie(value: string, maxAge = 15 * 60): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `shop_pilot_tiktok_oauth_state=${encodeURIComponent(value)}; Path=/api/tiktok; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function getFrontendUrl(): string {
  // 默认跟随 npm run dev 的 Vite 端口 5182；5180/5173 保留给历史部署
  const configured = process.env.FRONTEND_URL?.trim() || "http://localhost:5182";
  const url = new URL(configured);
  const allowedOrigins = new Set([
    "http://localhost:5182",
    "http://127.0.0.1:5182",
    "http://localhost:5180",
    "http://127.0.0.1:5180",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.ALLOWED_FRONTEND_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  if (!new Set(["http:", "https:"]).has(url.protocol) || !allowedOrigins.has(url.origin)) {
    throw new Error("FRONTEND_URL 不在允许的应用地址列表中。");
  }
  return url.origin;
}

function renderAuthorizationPage(input: { title: string; message: string; frontendUrl: string; success: boolean }): string {
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.message);
  const frontendUrl = escapeHtml(input.frontendUrl);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="1;url=${frontendUrl}" />
    <title>${title}</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f7;color:#25272b;font:16px/1.6 system-ui,sans-serif}
      main{width:min(520px,calc(100% - 40px));padding:32px;background:#fff;border:1px solid #e2e4e7;border-radius:8px;box-shadow:0 12px 36px rgba(20,24,32,.08)}
      h1{margin:0 0 12px;font-size:24px;letter-spacing:0}p{margin:0 0 22px;color:#666b73}a{color:${input.success ? "#087f72" : "#b42318"};font-weight:650}
    </style>
  </head>
  <body><main><h1>${title}</h1><p>${message}</p><a href="${frontendUrl}">返回跨境电商多Agent协同系统</a></main><script>window.setTimeout(function(){window.location.replace(${JSON.stringify(input.frontendUrl)})},800)</script></body>
</html>`;
}

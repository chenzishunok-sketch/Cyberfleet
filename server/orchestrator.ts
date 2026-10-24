import { createHash, randomUUID } from "node:crypto";
import type {
  ActionPlan,
  ChatStreamEmitter,
  ActionResponse,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FieldDiff,
  MessageArtifact,
  ProductRow,
  RunStep,
} from "../shared/contracts.ts";
import { handleDumateChat, isDumateConfigured, shouldRouteToDumate } from "./dumate-client.ts";
import { decideWithLlm, hasLlmConfiguration, reactLoop, extractMemories, reflectOnResult, summarizeWebResearch, summarizeLiveShopData, type AgentDecision, type ToolExecutorFn } from "./llm.ts";
import { loadMemory, formatMemoryForPrompt, addPreference, addInsight, recordOperation } from "./memory.ts";
import { memoryLayer } from "./memory-layer.ts";
import { recordDecisionOutcome } from "./learning-loop.ts";
import { cleanAssistantText, cleanFollowUps } from "./response-presentation.ts";
import { getTikTokOperationalData, type TikTokOperationalData } from "./tiktok-data.ts";
import {
  approveTikTokProductWrite,
  ActionVerificationPendingError,
  prepareTikTokProductWrite,
  rejectTikTokProductWrite,
  TikTokWritePreparationError,
  type TikTokProductWriteKind,
} from "./tiktok-product-writes.ts";
import { actionPlanStore } from "./action-plan-store.ts";
import { readStoredAuthorization } from "./tiktok-auth.ts";
import { inferTikTokSceneQuery, runTikTokSceneQuery, analyzeCategoryTrack, type TikTokSceneQuery } from "./tiktok-scenes.ts";
import { detectRegion, mentionsRegion } from "./tiktok-sites.ts";
import { inferMiaoshouSceneQuery, runMiaoshouSceneQuery, miaoshouSceneFollowUps, type MiaoshouSceneQuery } from "./miaoshou-scenes.ts";
import { inferTmapiItemIntent, runTmapiItemScene } from "./tmapi-scenes.ts";
import { hasTmapiConfiguration } from "./tmapi-client.ts";
import { callFastMossTool, getFastMossAbilityDescription, hasFastMossConfiguration } from "./mcp-client.ts";
import { callChuhaijiangTool } from "./chuhaijiang-client.ts";
import { productPublishWorkflowEngine, startProductPublishWorkflow, startPublishFromCollectBox } from "./product-publish-workflow.ts";
import { startFlashSaleWorkflow } from "./flash-sale-workflow.ts";
import { kolBridge } from "./kol-bridge.ts";
import { parseKolIntent } from "./kol-intents.ts";
import { startKolOutreachWorkflow } from "./kol-outreach-workflow.ts";
import { extract1688WorkflowInput, extractProductEditInput, parseFlashSaleIntent } from "./workflow-intents.ts";
import { workflowCoordinator } from "./workflow-coordinator.ts";

import { inferSourcingIntent, runSourcingSearch } from "./sourcing-agent.ts";
import { intelligenceStore } from "./intelligence-store.ts";
import { formatWebSearchForLlm, formatWebSearchForUser, hasWebSearchConfiguration, inferExplicitWebSearch, needsDeepWebAnalysis, searchWeb } from "./web-search-client.ts";
import { tryBuildVisualArtifact } from "./visual-analysis-engine.ts";
import { agentRegistry } from "./agent-registry.ts";
import { executeDelegation, registerDelegationHandler, getCollaborationOverview } from "./agent-bus.ts";
import { scheduler } from "./scheduler.ts";
import { isAgentContext, getDigitalEmployee, type AgentContext } from "../shared/digital-employees.ts";

const MIAOSHOU_WRITE_SCENES = new Set<MiaoshouSceneQuery>([
  "collect_item",
  "ai_match_category",
  "supplement_info",
  "claim_to_platform",
  "publish_to_tiktok",
]);
const MIAOSHOU_WRITE_LABELS: Partial<Record<MiaoshouSceneQuery, string>> = {
  collect_item: "采集1688商品到公共采集箱",
  ai_match_category: "匹配商品类目",
  supplement_info: "补全商品资料",
  claim_to_platform: "认领商品到TikTok采集箱",
  publish_to_tiktok: "发布商品到TikTok",
};
interface StoredMiaoshouAction {
  core: { id: string; kind: "miaoshou.operation"; expiresAt: string };
  status: ActionPlan["status"];
  plan: ActionPlan;
  scene: MiaoshouSceneQuery;
  query: string;
  history?: ChatRequest["history"];
}

function getMiaoshouAction(id: string): StoredMiaoshouAction | undefined {
  const stored = actionPlanStore.get<StoredMiaoshouAction>(id);
  return stored?.core.kind === "miaoshou.operation" ? stored : undefined;
}

function saveMiaoshouAction(stored: StoredMiaoshouAction, status: ActionPlan["status"]): void {
  stored.status = status;
  stored.plan.status = status;
  actionPlanStore.save(stored);
}

function nowLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function workflowReference(text: string): string | undefined {
  return text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0];
}

function asksAboutWorkflow(text: string): boolean {
  return /(任务|刚才).*(进度|到哪|状态|失败原因|确认|批准|继续|重试|核验)|(?:进度|到哪|状态|失败原因|确认|批准|继续|重试|核验).*(任务|刚才)/i.test(text);
}

async function workflowFromText(text: string) {
  const id = workflowReference(text);
  if (id) return workflowCoordinator.get(id);
  return (await workflowCoordinator.list())[0];
}

function workflowStatusText(run: Awaited<ReturnType<typeof workflowFromText>>): string {
  if (!run) return "目前没有可查询的业务任务。";
  const statusLabels: Record<string, string> = {
    draft: "准备中", running: "执行中", waiting_input: "等待补充信息", waiting_confirmation: "等待确认",
    verification_pending: "等待结果核验", completed: "已完成", failed: "执行失败", cancelled: "已取消",
  };
  if (run.type === "dag") {
    const active = run.nodeStates.find((node) => node.state === "running")
      ?? run.nodeStates.find((node) => node.state === "failed")
      ?? run.nodeStates.find((node) => node.state === "pending");
    const next = active ? (run.definition.nodes.find((node) => node.id === active.id)?.label ?? active.id) : "所有步骤已结束";
    const extra = run.error ?? "";
    return `任务 ${run.id} 当前状态：${statusLabels[run.status] ?? run.status}。当前步骤：${next}。${extra}`.trim();
  }
  const active = run.steps.find((step) => step.status === "running")
    ?? run.steps.find((step) => step.status === "failed")
    ?? run.steps.find((step) => step.status === "pending");
  const next = (active ? `${active.label}${active.detail ? `：${active.detail}` : ""}` : "所有步骤已结束").replace(/[。；]+$/, "");
  const extra = run.error ?? (run.summary && run.summary !== active?.detail ? run.summary : "");
  return `任务 ${run.id} 当前状态：${statusLabels[run.status] ?? run.status}。当前步骤：${next}。${extra}`.trim();
}

async function handleWorkflowNaturalLanguage(request: ChatRequest): Promise<ChatResponse | undefined> {
  const productInput = extractProductEditInput(request.message);
  if (productInput && (workflowReference(request.message) || /(?:任务|刚才)/i.test(request.message))) {
    const run = await workflowFromText(request.message);
    if (!run || run.type !== "product_publish") {
      return { message: message("没有找到正在等待商品资料的上架任务。"), runId: randomUUID() };
    }
    try {
      const next = await productPublishWorkflowEngine.updateProductInput(run.id, productInput);
      return {
        message: message(`已补充商品资料。${workflowStatusText(next)}`, { kind: "workflow", run: next }),
        runId: randomUUID(),
      };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "无法补充商品资料。", { kind: "workflow", run }), runId: randomUUID() };
    }
  }
  if (!asksAboutWorkflow(request.message)) return undefined;
  const run = await workflowFromText(request.message);
  if (!run) return { message: message("目前还没有业务任务。可以先创建供应商上架或秒杀任务。"), runId: randomUUID() };
  const wantsApproval = /(确认|批准).*(任务|刚才|继续)|(?:任务|刚才).*(确认|批准)/i.test(request.message);
  const wantsRetry = /(重试|继续).*(任务|刚才)|(?:任务|刚才).*(重试)/i.test(request.message);
  const wantsVerify = /(核验|回查).*(任务|刚才)|(?:任务|刚才).*(核验|回查)/i.test(request.message);
  if (wantsApproval || wantsRetry) {
    return {
      message: message(wantsApproval
        ? "请在任务卡片中核对操作范围，然后点击审核按钮继续。"
        : "请在任务卡片中点击重试按钮，系统会从失败步骤继续。", { kind: "workflow", run }),
      runId: randomUUID(),
    };
  }
  try {
    const next = wantsVerify
          ? await workflowCoordinator.verify(run.id)
          : run;
    const action = wantsVerify ? "已重新回查外部平台。" : "";
    return { message: message(`${action}${workflowStatusText(next)}`, { kind: "workflow", run: next }), runId: randomUUID() };
  } catch (error) {
    return { message: message(error instanceof Error ? error.message : "任务操作失败。", { kind: "workflow", run }), runId: randomUUID() };
  }
}

async function handleKolNaturalLanguage(request: ChatRequest): Promise<ChatResponse | undefined> {
  const intent = parseKolIntent(request.message, request.context === "kol");
  if (!intent) return undefined;
  if (intent.kind === "status") {
    const status = kolBridge.status();
    return {
      message: message(status.connected
        ? `达人浏览器插件已连接，桥接端口为 ${status.port}，可以读取真实达人并执行建联。`
        : `达人浏览器插件尚未连接。请打开安装了 KOL 扩展的 TikTok Shop 联盟页面；插件会自动连接端口 ${status.port}。`, undefined, undefined,
      status.connected ? ["查看达人库", "查看建联数据"] : []),
      runId: randomUUID(),
    };
  }
  if (intent.kind === "creators") {
    try {
      const creators = await kolBridge.listCreators({ category: intent.category, minFollowers: intent.minFollowers, limit: 100 });
      const rows = creators.slice(0, 50).map((creator) => ({
        creator: creator.nickname,
        handle: creator.handle ? `@${creator.handle}` : "-",
        followers: creator.followerCount.toLocaleString("zh-CN"),
        category: creator.category ?? "未分类",
        id: creator.id,
      }));
      return {
        message: message(
          creators.length ? `已从浏览器插件读取 ${creators.length} 位真实达人。` : "浏览器插件已连接，但当前筛选没有匹配达人。",
          {
            kind: "records",
            headline: "达人库",
            summary: creators.length > 50 ? `共 ${creators.length} 位，当前显示前 50 位。` : `共 ${creators.length} 位。`,
            columns: [
              { key: "creator", label: "达人" }, { key: "handle", label: "账号" }, { key: "followers", label: "粉丝" },
              { key: "category", label: "类目" }, { key: "id", label: "达人 ID" },
            ],
            rows,
            source: "KOL 浏览器插件 · 实时达人库",
            emptyLabel: "当前没有匹配达人",
          },
          undefined,
          ["查看建联数据", "检查达人插件连接状态"],
        ),
        runId: randomUUID(),
      };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "无法读取达人库。"), runId: randomUUID() };
    }
  }
  if (intent.kind === "stats") {
    try {
      const stats = await kolBridge.getStats();
      return {
        message: message("已从浏览器插件读取真实建联统计。", {
          kind: "records",
          headline: "达人建联数据",
          summary: `达人池 ${stats.totalCreators} 位，累计邀约 ${stats.totalInvited}，成功 ${stats.success}，待处理 ${stats.pending}，失败 ${stats.failed}。`,
          columns: [
            { key: "totalCreators", label: "达人池" }, { key: "totalInvited", label: "累计邀约" },
            { key: "success", label: "成功" }, { key: "pending", label: "待处理" }, { key: "failed", label: "失败" },
          ],
          rows: [{
            totalCreators: String(stats.totalCreators), totalInvited: String(stats.totalInvited), success: String(stats.success),
            pending: String(stats.pending), failed: String(stats.failed),
          }],
          source: "KOL 浏览器插件 · 实时统计",
        }, undefined, ["查看达人库", "检查达人插件连接状态"]),
        runId: randomUUID(),
      };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "无法读取建联统计。"), runId: randomUUID() };
    }
  }
  try {
    const run = await startKolOutreachWorkflow(intent.input);
    return {
      message: message("达人建联任务已创建。系统会先检查插件并锁定真实达人名单，确认前不会发送邀约。", { kind: "workflow", run }),
      runId: randomUUID(),
    };
  } catch (error) {
    return { message: message(error instanceof Error ? error.message : "无法创建达人建联任务。"), runId: randomUUID() };
  }
}

function createSteps(kind: "read" | "write" | "report" | "automation"): RunStep[] {
  const labels = {
    read: [
      // 不能写死演示店铺名：createSteps 也被真实采集审核卡使用（曾误显示 "Luma Living US"）
      ["确认数据范围", "已授权店铺 · 当前站点"],
      ["读取店铺数据", "订单、商品与库存"],
      ["完成确定性汇总", "已校验数据口径"],
    ],
    write: [
      ["检查操作权限", "运营角色 · 允许发起"],
      ["读取最新状态", "已获取商品当前值"],
      ["生成变更计划", "等待人工确认"],
    ],
    report: [
      ["读取报告范围", "过去 7 天"],
      ["汇总经营指标", "GMV、商品、退款与库存"],
      ["生成报告快照", "数据口径已锁定"],
    ],
    automation: [
      ["解析触发条件", "时间与店铺范围"],
      ["检查任务风险", "仅分析，不含写操作"],
      ["创建任务草稿", "启用前可试运行"],
    ],
  }[kind];

  return labels.map(([label, detail], index) => ({
    id: `${kind}-${index}`,
    label,
    detail,
    status: "done" as const,
  }));
}

function message(content: string, artifact?: MessageArtifact, steps?: RunStep[], followUps: string[] = [], originalQuestion = ""): ChatMessage {
  const suggestionPrompts = artifact?.kind === "suggestions" ? artifact.prompts : followUps;
  const normalizedFollowUps = cleanFollowUps(suggestionPrompts);
  // 不改写模型输出：质量门按固定模板重写，等于拿占位文案冒充模型回答，
  // 且会把「你能干嘛」这类闲聊的正常回答误判成「泛化能力清单」再替换成答非所问的兜底。
  const finalContent = cleanAssistantText(content);
  return {
    id: randomUUID(),
    role: "assistant",
    content: finalContent,
    timestamp: nowLabel(),
    artifact: artifact?.kind === "suggestions" ? undefined : artifact,
    steps,
    ...(normalizedFollowUps.length ? { followUps: normalizedFollowUps } : {}),
  };
}

function extractQuantity(text: string, fallback = 80): number {
  const match = text.match(/(?:库存|调整|修改|设|设置|改|补)(?:[^0-9]{0,12})(\d{1,6})/);
  return match ? Number(match[1]) : fallback;
}

function extractPrice(text: string, fallback = 39.99): number {
  const match = text.match(/(?:价格|售价|改价)(?:[^0-9]{0,12})(\d+(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : fallback;
}

function extractSkus(text: string): string[] {
  return [...text.matchAll(/LL[-\s]?[A-Z0-9-]+/gi)].map((match) => match[0].replace(/\s/g, "").toUpperCase());
}

async function createMiaoshouApproval(request: ChatRequest, scene: MiaoshouSceneQuery): Promise<ActionPlan> {
  const id = randomUUID();
  const actionLabel = MIAOSHOU_WRITE_LABELS[scene] ?? "修改采集商品数据";
  const target = request.message.match(/https?:\/\/[^\s]+|\b\d{6,20}\b/i)?.[0] ?? "当前采集商品";
  const diffs: FieldDiff[] = [{ target, field: "采集操作", before: "未执行", after: actionLabel }];
  const planBase = { id, scene, query: request.message, diffs, createdAt: Date.now() };
  // 店铺必须展示真实授权店铺，不能用演示 dashboard 的名字（曾误显示成 "Luma Living US"）
  const storeLabel = await miaoshouStoreLabel();
  const plan: ActionPlan = {
    id,
    tool: "miaoshou.operation",
    title: actionLabel,
    summary: "审核通过后才会调用采集上架接口。执行完成后会返回接口结果，不能重复提交同一审核计划。",
    store: storeLabel,
    risk: scene === "claim_to_platform" || scene === "publish_to_tiktok" ? "high" : "medium",
    diffs,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    status: "pending",
    planHash: createHash("sha256").update(JSON.stringify(planBase)).digest("hex").slice(0, 12),
  };
  actionPlanStore.save<StoredMiaoshouAction>({
    core: { id, kind: "miaoshou.operation", expiresAt: plan.expiresAt },
    status: "pending",
    plan,
    scene,
    query: request.message,
    history: request.history,
  });
  return plan;
}

/** 审核卡上展示的真实店铺名：优先 TikTok OAuth 授权店铺，查询失败时用中性描述，绝不显示演示店铺名 */
async function miaoshouStoreLabel(): Promise<string> {
  try {
    const stored = await readStoredAuthorization();
    const shops = (stored?.shops ?? []).map((shop) => ({
      name: String(shop.name ?? "").trim(),
      region: String(shop.region ?? "").trim().toUpperCase(),
    })).filter((shop) => shop.name);
    if (shops.length === 1) return shops[0].region ? `${shops[0].name} · ${shops[0].region}` : shops[0].name;
    if (shops.length > 1) return `${shops.length} 家授权店铺（${shops.map((s) => s.name).slice(0, 3).join("、")}等）`;
  } catch {
    // OAuth 状态读不到时走兜底描述
  }
  return "已授权采集上架店铺";
}

function asksForBestSellers(text: string): boolean {
  return /(什么|哪些|哪个).*(好卖|畅销|热销|卖得好)|好卖|畅销|爆款|热销|销量(?:最高|最好|排名)/i.test(text);
}

function asksForProductOperation(text: string): boolean {
  const mentionsOperation = /(上架|下架|发布商品|商品发布|停售|停用商品|启用商品)/i.test(text);
  const asksAbilityOrAction = /(可以|能否|能不能|是否|支持|会不会|帮我|请|如何|怎么|吗|么)/i.test(text);
  return mentionsOperation && asksAbilityOrAction;
}

function inferExplicitDecision(text: string): AgentDecision | undefined {
  const lower = text.toLowerCase();
  if (/(店铺|商店|shop).*(名字|名称|叫什么|站点|地区|币种|时区|哪个)/i.test(text)) {
    return { tool: "get_shop_info", args: {} };
  }
  if (/(库存|stock)/i.test(text) && /(改|调|补|设|更新|恢复|update)/i.test(text)) {
    return { tool: "prepare_inventory_update", args: { skus: extractSkus(text), quantity: extractQuantity(text) } };
  }
  if (/(价格|售价|改价|price)/i.test(text) && /(改|调|设|更新|恢复|update)/i.test(text)) {
    return { tool: "prepare_price_update", args: { skus: extractSkus(text), price: extractPrice(text) } };
  }
  if (/(周报|日报|报告|复盘|report)/i.test(text)) return { tool: "generate_operations_report", args: { days: lower.includes("30") ? 30 : 7 } };
  if (/(每天|每周|定时|自动|提醒|automation)/i.test(text)) return { tool: "create_readonly_automation", args: { task: text, schedule: "每天 09:00" } };
  if (asksForProductOperation(text)) {
    return { tool: "explain_product_operations", args: { includeBestSellers: asksForBestSellers(text), days: extractDays(text) } };
  }
  if (/(退款|退货|refund|return)/i.test(text)) {
    return { tool: "get_refund_summary", args: { days: extractDays(text) } };
  }
  if (/(订单|order)/i.test(text)) {
    return { tool: "get_order_summary", args: { days: extractDays(text) } };
  }
  if (/(gmv|销售额|成交额|客单价)/i.test(text)) {
    return { tool: "get_gmv_summary", args: { days: extractDays(text) } };
  }
  // ─── 市场/选品/类目意图识别（LLM 503 时必须能走真实数据，不能返回通用话术） ─────────────
  const hasMarketKeyword = /(市场|大盘|大盘数据|趋势|海外|跨境|国别|站点|海外市场|region|market)/i.test(text);
  const hasCategoryKeyword = /(类目|品类|行业|赛道|类别|好卖|热销|选品|适合|切入|机会|竞争|集中度|推荐品|爆品)/i.test(text)
    || /(家[纺织纺]|家纺|布艺|床上|四件套|床笠|床垫|枕套|被|毛毯|地毯|窗帘|毛巾|浴巾|美妆|护肤|精华|乳液|面霜|口红|面膜|防晒|香水|彩妆|3c|数码|手机|平板|耳机|充电|充电宝|相机|手表|智能|电子|服装|服饰|衣服|男装|女装|童装|鞋|靴|包|帽|袜|内衣|皮带|家居|家具|家装|建材|厨房|卫浴|收纳|餐具|灯|灯具|食品|零食|饮料|生鲜|保健品|维生素|咖啡|茶|母婴|婴儿|宝宝|孕妇|奶粉|纸尿裤|玩具|运动|健身|户外|跑步|瑜伽|露营|钓鱼)/i.test(text);
  const hasRegionKeyword = mentionsRegion(text);

  // ── 赛道分析意图：用户明确要分析某个类目/赛道的竞争格局 ──
  const wantsTrackAnalysis = /(分析|拆解|评估|调研|研究|看看|了解|讲讲|说说|介绍).*(类目|品类|行业|赛道|市场|格局|竞争|情况|状况|态势)|(类目|品类|行业|赛道).*(分析|拆解|评估|调研|研究|格局|竞争|情况|怎么样|如何)/i.test(text);
  // 注意：只匹配"品类/类目/赛道"维度的选品问题，避免把"哪些商品好卖"（本店商品查询）误判为赛道分析
  const wantsCategoryData = /((?:什么|哪些|哪个).*(?:品类|类目|赛道|行业|类别).*(?:好卖|热销|畅销|好做|怎么样|如何))|((?:好卖|热销|畅销|选品).*(?:品类|类目|赛道|行业|类别))|((?:想要|帮我|想|请).*(?:分析|看看|了解).*(?:家纺|美妆|3c|数码|服饰|家居|食品|母婴|运动))/i.test(text);

  // 市场名识别集中在 tiktok-sites.ts：识别不出就留空，由场景层回落到店铺自己的站点。
  if (wantsTrackAnalysis || wantsCategoryData || ((hasMarketKeyword || hasCategoryKeyword) && hasRegionKeyword)) {
    const region = detectRegion(text) ?? "";

    // 如果用户明确要分析赛道/类目 → 走深度分析（竞争格局+价格带+头部特征）
    if (wantsTrackAnalysis || wantsCategoryData || hasCategoryKeyword) {
      return { tool: "analyze_category_track", args: { category: text, region, days: extractDays(text) } };
    }
    // 其他市场查询 → 走全品类热销榜
    return { tool: "run_tiktok_scene_query", args: { scene: "market_products", region, days: extractDays(text) } };
  }
  if (asksForBestSellers(text)) {
    return { tool: "list_products", args: { focus: "top" } };
  }
  if (/(商品|sku|库存|滞销|热销|潜力|product)/i.test(text)) {
    const focus = /(多少|几个|全部|所有)/i.test(text) ? "all" : /热销/i.test(text) ? "top" : /滞销/i.test(text) ? "slow" : "low_stock";
    return { tool: "list_products", args: { focus } };
  }
  if (/(销售|数据|表现|昨天|最近|近\s*\d+|怎么样|overview)/i.test(text)) {
    return { tool: "get_sales_overview", args: { days: extractDays(text) } };
  }
  return undefined;
}

function inferDecision(text: string): AgentDecision {
  const explicit = inferExplicitDecision(text);
  if (explicit) return explicit;
  // 兜底：绝对不能返回"我可以查询经营数据"这种无价值话术。
  // 先试店铺经营概况（有真实数据），再用通用的"帮你先看店铺基础数据+近7天销售走势"的有信息回答
  const lower = text.toLowerCase();
  if (lower.length < 3) return { tool: "respond", args: { content: "请告诉我你的具体经营需求或查询目标，例如：看看日本市场家纺布艺类目、店铺最近7天销售情况、生成经营周报。" } };
  return { tool: "get_sales_overview", args: { days: 7 } };
}

const FAST_READ_TOOLS = new Set<AgentDecision["tool"]>([
  "get_shop_info",
  "get_sales_overview",
  "get_order_summary",
  "get_gmv_summary",
  "get_refund_summary",
  "list_products",
]);

/** 将自然语言调度描述解析为 5 字段 cron 表达式 */
function parseScheduleToCron(schedule?: string): string {
  if (!schedule) return "0 9 * * *"; // 默认每天 09:00
  const text = schedule.toLowerCase().trim();

  // 每天 HH:MM
  const dailyMatch = text.match(/(?:每天|每日|daily|every\s*day)?\s*(\d{1,2})[:：](\d{2})/);
  if (dailyMatch) {
    const h = Number(dailyMatch[1]);
    const m = Number(dailyMatch[2]);
    return `${m} ${h} * * *`;
  }
  // 每周X HH:MM
  const weekMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const weeklyMatch = text.match(/(?:每周|every\s*week)\s*([一二三四五六日天])\s*(\d{1,2})[:：](\d{2})?/);
  if (weeklyMatch) {
    const dow = weekMap[weeklyMatch[1]] ?? 1;
    const h = weeklyMatch[2] ? Number(weeklyMatch[2]) : 9;
    const m = weeklyMatch[3] ? Number(weeklyMatch[3]) : 0;
    return `${m} ${h} * * ${dow}`;
  }
  // 每 N 小时
  const hourlyMatch = text.match(/(?:每|every)\s*(\d+)\s*(?:小时|hour|hours)/);
  if (hourlyMatch) {
    const h = Number(hourlyMatch[1]);
    return `0 */${h} * * *`;
  }
  // 每小时
  if (/(?:每|every)\s*(?:小时|hour)/.test(text)) {
    return "0 * * * *";
  }
  // 每天 09:00 作为默认
  return "0 9 * * *";
}

function inferFastConversationResponse(text: string): string | undefined {
  const normalized = text.trim();
  if (/^(你好|您好|嗨|hi|hello)[！!，,。.?？\s]*$/i.test(normalized)) {
    return "你好，我可以帮你查询真实店铺数据、分析经营问题，也可以在你确认后执行上架、改价、库存和促销等任务。";
  }
  if (/(你能做什么|有哪些能力|可以做什么)/i.test(normalized) && normalized.length <= 40) {
    return "我可以查询店铺、商品、订单、利润、退款和市场数据，分析经营问题，并在你确认后执行上架、改价、库存、促销和达人建联任务。";
  }
  return undefined;
}

function inferFastReadDecision(text: string): AgentDecision | undefined {
  const decision = inferExplicitDecision(text);
  if (!decision || !FAST_READ_TOOLS.has(decision.tool)) return undefined;
  const asksForDecision = /(为什么|为何|原因|诊断|建议|策略|方案|决策|怎么办|怎么做|优化|预测|机会|风险|深度分析|复盘)/i.test(text);
  if (asksForDecision) return undefined;
  const asksForDirectRead = /(查看|查询|列出|统计|多少|概况|数据|当前|近\s*\d*\s*天|最近|过去|全部|所有|最低|最高|排行|名称|名字|币种|时区)/i.test(text);
  return asksForDirectRead ? decision : undefined;
}

function extractDays(text: string): number {
  const match = text.match(/(?:近|最近|过去)?\s*(\d{1,2})\s*天/);
  if (match) return Math.max(1, Math.min(90, Number(match[1])));
  if (/昨天/.test(text)) return 1;
  if (/(月报|本月|近一个月)/.test(text)) return 30;
  return 7;
}

function inferLiveProductWrite(text: string): TikTokProductWriteKind | undefined {
  if (/(库存|stock)/i.test(text) && /(改|调|补|设|更新|恢复|update|set|change)/i.test(text)) return "inventory.update";
  if (/(价格|售价|改价|price)/i.test(text) && /(改|调|设|更新|恢复|update|set|change)/i.test(text)) return "price.update";
  const activate = /(重新上架|恢复上架|上架|启用商品|激活商品|activate product)/i.test(text);
  const deactivate = /(下架|停售|停用商品|deactivate product|unlist product)/i.test(text);
  if (activate === deactivate) return undefined;
  return activate ? "product.activate" : "product.deactivate";
}

function liveProductWriteSteps(plan: ActionPlan): RunStep[] {
  return [
    { id: `write-${plan.id}-permission`, label: "检查操作权限", detail: `${plan.store} · TikTok Shop 官方接口`, status: "done" },
    { id: `write-${plan.id}-target`, label: "精确读取当前值", detail: `${plan.diffs.length} 项明确变更`, status: "done" },
    { id: `write-${plan.id}-approval`, label: "生成变更计划", detail: `等待人工确认 · ${plan.planHash}`, status: "done" },
  ];
}

function sceneQuerySteps(query: TikTokSceneQuery, requestedDays: number, source: string): RunStep[] {
  const labels: Record<TikTokSceneQuery, [string, string]> = {
    market_products: ["市场热销商品", `官方 Bestsellers · 近 ${requestedDays} 天`],
    market_creators: ["市场热销达人", `官方 Bestsellers · 近 ${requestedDays} 天`],
    market_videos: ["市场带货视频", `官方 Bestsellers · 近 ${requestedDays} 天`],
    market_lives: ["市场带货直播", `官方 Bestsellers · 近 ${requestedDays} 天`],
    shop_products: ["店铺商品表现", `TikTok Shop Analytics · 近 ${requestedDays} 天`],
    shop_videos: ["店铺短视频表现", `TikTok Shop Analytics · 近 ${requestedDays} 天`],
    shop_lives: ["店铺直播表现", `TikTok Shop Analytics · 近 ${requestedDays} 天`],
    product_diagnoses: ["商品信息质量诊断", "TikTok Shop Product API"],
    global_products: ["全球商品列表", "TikTok Shop 商品接口"],
    global_categories: ["全球商品类目", "TikTok Shop Product API"],
    seller_permissions: ["卖家权限", "TikTok Shop Seller API"],
    authorized_shops: ["已授权店铺", "TikTok Shop Authorization API"],
    shop_groups: ["店铺组", "TikTok Shop Seller API"],
    orders: ["订单列表", `TikTok Shop Order API · 近 ${requestedDays} 天`],
    pending_orders: ["待发货订单", "TikTok Shop Order API"],
    order_detail: ["订单详情", "TikTok Shop Order API"],
    order_price: ["订单价格明细", "TikTok Shop Order API"],
    promotions_overview: ["促销与优惠券", "TikTok Shop Promotion API"],
    promotions: ["促销活动", "TikTok Shop Promotion API"],
    coupons: ["优惠券", "TikTok Shop Promotion API"],
    packages: ["履约包裹", `TikTok Shop Fulfillment API · 近 ${requestedDays} 天`],
    combinable_packages: ["可合并包裹", "TikTok Shop Fulfillment API"],
    warehouses: ["仓库列表", "TikTok Shop Logistics API"],
    shipping_templates: ["物流模板", "TikTok Shop Logistics API"],
    order_tracking: ["订单物流轨迹", "TikTok Shop Logistics API"],
    tracking_validation: ["物流单号校验", "TikTok Shop Fulfillment API"],
    aftersales_requests: ["售后请求", "TikTok Shop Return & Refund API"],
    return_records: ["退货记录", "TikTok Shop Return & Refund API"],
    aftersale_eligibility: ["售后资格", "TikTok Shop Return & Refund API"],
    finance_statements: ["结算单", "TikTok Shop Finance API"],
    finance_withdrawals: ["提现与结算记录", "TikTok Shop Finance API"],
    finance_unsettled: ["未结算交易", "TikTok Shop Finance API"],
    finance_payments: ["付款记录", "TikTok Shop Finance API"],
    finance_order_transactions: ["订单财务流水", "TikTok Shop Finance API"],
  };
  const [scene, api] = labels[query];
  return [
    { id: `scene-${query}-scope`, label: "确认查询场景", detail: scene, status: "done" },
    { id: `scene-${query}-read`, label: "读取 TikTok Shop", detail: api, status: "done" },
    { id: `scene-${query}-result`, label: "整理真实结果", detail: source, status: "done" },
  ];
}

function miaoshouQuerySteps(query: MiaoshouSceneQuery): RunStep[] {
  const labels: Record<MiaoshouSceneQuery, [string, string]> = {
    collect_item: ["采集 1688 货源", "采集接口"],
    common_collect_box: ["公共采集箱", "商品接口"],
    tiktok_collect_box: ["TikTok 采集箱", "TK 采集接口"],
    tiktok_categories: ["TK 类目树", "类目接口"],
    ai_match_category: ["AI 类目匹配", "AI 接口"],
    supplement_info: ["补充信息", "AI 补充信息接口"],
    claim_to_platform: ["认领到平台采集箱", "认领接口"],
    miaoshou_shops: ["授权店铺", "店铺接口"],
    publish_to_tiktok: ["发布到 TK", "发布接口"],
    publish_records: ["发布记录", "发布记录接口"],
    price_templates: ["定价模板", "定价接口"],
    miaoshou_packages: ["包裹", "履约接口"],
    miaoshou_returns: ["退货退款", "售后接口"],
    miaoshou_purchase_orders: ["采购单", "采购接口"],
    miaoshou_inventory: ["库存", "仓储接口"],
  };
  const [scene, api] = labels[query];
  return [
    { id: `miaoshou-${query}-scope`, label: "确认采集场景", detail: scene, status: "done" },
    { id: `miaoshou-${query}-read`, label: "调用采集 API", detail: api, status: "done" },
    { id: `miaoshou-${query}-result`, label: "整理结果", detail: "采集上架服务", status: "done" },
  ];
}

function sceneFollowUps(
  query: TikTokSceneQuery,
  artifact: Extract<MessageArtifact, { kind: "records" }>,
  requestedDays: number,
  originalText: string,
): string[] {
  const first = artifact.rows[0];
  const orderId = first?.order_id ?? ((query === "orders" || query === "pending_orders" || query === "order_detail" || query === "order_price") ? first?.id : undefined);
  const returnId = first?.return_id ?? ((query === "aftersales_requests" || query === "return_records") ? first?.id : undefined);
  const sameRange = `近 ${requestedDays} 天`;
  const byScene: Record<TikTokSceneQuery, string[]> = {
    market_products: [`查看${sameRange}市场热销达人`, `查看${sameRange}热门带货视频`, "查看店铺商品表现排行"],
    market_creators: [`查看${sameRange}市场热销商品榜`, `查看${sameRange}热门带货视频`, "查看店铺短视频表现"],
    market_videos: [`查看${sameRange}市场热销商品榜`, `查看${sameRange}市场热销达人`, "查看店铺短视频表现"],
    market_lives: [`查看${sameRange}市场热销商品榜`, `查看${sameRange}市场热销达人`, "查看店铺直播表现"],
    shop_products: ["诊断在售商品信息质量", "查找库存不足的 SKU", `查看${sameRange}市场热销商品榜`],
    shop_videos: ["查看店铺直播表现", `查看${sameRange}热门带货视频`, "查看店铺商品表现排行"],
    shop_lives: ["查看店铺短视频表现", `查看${sameRange}热门带货直播`, "查看店铺商品表现排行"],
    product_diagnoses: ["查看全部商品和 SKU", "查看店铺商品表现排行", "查询卖家权限"],
    global_products: ["检查我的店铺是否支持全球商品", "查看全球商品类目列表", "查询卖家权限"],
    global_categories: ["查看全部全球商品", "检查我的店铺是否支持全球商品", "查询卖家权限"],
    seller_permissions: ["查看授权店铺列表", "查看全部全球商品", "查看仓库列表"],
    authorized_shops: ["查看店铺组", "查询卖家权限", "查看仓库列表"],
    shop_groups: ["查看授权店铺列表", "查询卖家权限"],
    orders: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 物流轨迹`, `按订单 ${orderId} 查询财务流水`]
      : ["查看最近 30 天订单", "查询待发货订单", "查看当前促销活动"],
    pending_orders: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 物流轨迹`, `查询订单 ${orderId} 价格明细`]
      : ["查看最近 30 天订单", "查看仓库列表", "查看可用物流模板"],
    order_detail: orderId
      ? [`查询订单 ${orderId} 价格明细`, `查询订单 ${orderId} 物流轨迹`, `按订单 ${orderId} 查询财务流水`]
      : ["查看最近 7 天订单", "查询待发货订单"],
    order_price: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 物流轨迹`, `按订单 ${orderId} 查询财务流水`]
      : ["查看最近 7 天订单", "查询待发货订单"],
    promotions_overview: ["查看进行中的促销活动", "查看优惠券列表", "分析最近 7 天店铺销售表现"],
    promotions: ["查看优惠券列表", "当前有哪些促销和优惠券", "分析最近 7 天店铺销售表现"],
    coupons: ["查看当前促销活动", "当前有哪些促销和优惠券", "分析最近 7 天店铺销售表现"],
    packages: ["查询可合并的包裹", "查看仓库列表", "查看可用物流模板"],
    combinable_packages: ["查看最近 7 天包裹", "查看仓库列表", "查看可用物流模板"],
    warehouses: ["查看可用物流模板", "查看最近 7 天包裹", "查找库存不足的 SKU"],
    shipping_templates: ["查看仓库列表", "查看最近 7 天包裹", "查询可合并的包裹"],
    order_tracking: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 价格明细`, `按订单 ${orderId} 查询财务流水`]
      : ["查看最近 7 天订单", "查询待发货订单"],
    tracking_validation: ["查看可用物流模板", "查看仓库列表"],
    aftersales_requests: returnId
      ? [`查询退货记录 ${returnId}`, "分析最近 7 天退款原因", "查看最近 7 天订单"]
      : ["分析最近 7 天退款原因", "查看最近 30 天订单", "查询待发货订单"],
    return_records: ["查询待处理售后", "分析最近 7 天退款原因", "查看最近 7 天订单"],
    aftersale_eligibility: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 物流轨迹`]
      : ["查看最近 7 天订单", "查询待处理售后"],
    finance_statements: ["查看提现记录", "查看未结算订单", "分析最近 7 天店铺销售表现"],
    finance_withdrawals: ["查看最近的结算单", "查看未结算订单", "分析最近 7 天店铺销售表现"],
    finance_unsettled: ["查看最近的结算单", "查看提现记录", "查看最近 7 天订单"],
    finance_payments: ["查看最近的结算单", "查看提现记录", "查看未结算订单"],
    finance_order_transactions: orderId
      ? [`按订单号 ${orderId} 查看完整订单`, `查询订单 ${orderId} 价格明细`]
      : ["查看最近 7 天订单", "查看最近的结算单"],
  };
  return cleanFollowUps(byScene[query], originalText);
}

function fallbackFollowUps(originalText: string): string[] {
  if (/(订单|物流|包裹)/i.test(originalText)) return ["查看最近 7 天订单", "查询待发货订单", "查看仓库列表"];
  if (/(商品|sku|库存|价格|上架|下架)/i.test(originalText)) return ["查看全部商品和 SKU", "查看店铺商品表现排行", "诊断在售商品信息质量"];
  if (/(退款|退货|售后)/i.test(originalText)) return ["查询待处理售后", "分析最近 7 天退款原因", "查看最近 7 天订单"];
  if (/(财务|结算|提现|gmv|销售额)/i.test(originalText)) return ["查看最近的结算单", "查看未结算订单", "分析最近 7 天店铺销售表现"];
  if (/(促销|优惠券|活动)/i.test(originalText)) return ["当前有哪些促销和优惠券", "分析最近 7 天店铺销售表现"];
  return [];
}

function decisionFollowUps(decision: AgentDecision, originalText: string): string[] {
  const suggestions: Partial<Record<AgentDecision["tool"], string[]>> = {
    get_shop_info: ["查询卖家权限", "查看授权店铺列表", "查看仓库列表"],
    get_sales_overview: ["查看店铺商品表现排行", "分析最近 7 天退款原因", "生成近 7 天经营报告"],
    get_order_summary: ["查询待发货订单", "分析最近 7 天退款原因", "查看当前促销活动"],
    get_gmv_summary: ["查看店铺商品表现排行", "最近什么商品好卖", "生成近 7 天经营报告"],
    get_refund_summary: ["查询待处理售后", "查看最近 7 天订单", "生成近 7 天经营报告"],
    explain_product_operations: ["查看全部商品和 SKU", "诊断在售商品信息质量", "查询卖家权限"],
    list_products: ["查看店铺商品表现排行", "诊断在售商品信息质量", "查看仓库列表"],
    generate_operations_report: ["查看店铺商品表现排行", "分析最近 7 天退款原因", "查找库存不足的 SKU"],
  };
  if (decision.tool === "respond") {
    return cleanFollowUps([...(decision.args.followUps ?? []), ...fallbackFollowUps(originalText)], originalText);
  }
  return cleanFollowUps(suggestions[decision.tool] ?? [], originalText);
}

function liveSteps(kind: "read" | "report", data: TikTokOperationalData): RunStep[] {
  const labels = kind === "report"
    ? [
        ["确认报告范围", `${data.shop.name} · 过去 ${data.days} 天`],
        ["读取 TikTok Shop", "订单、商品与退货退款接口"],
        ["生成报告快照", data.source],
      ]
    : [
        ["确认店铺范围", `${data.shop.name} · ${data.shop.region}`],
        ["读取 TikTok Shop", "官方 Open API"],
        ["完成数据汇总", data.source],
      ];
  return labels.map(([label, detail], index) => ({ id: `live-${kind}-${index}`, label, detail, status: "done" }));
}

type LiveSalesKind = "overview" | "orders" | "gmv" | "refunds";

function liveSalesArtifact(data: TikTokOperationalData, originalText: string, kind: LiveSalesKind): MessageArtifact {
  const metric = (label: string) => data.dashboard.metrics.find((item) => item.label === label);
  const gmvMetric = metric("支付 GMV");
  const orderMetric = metric("订单数");
  const averageMetric = metric("客单价");
  const returnMetric = metric("退货退款申请");
  const refundAmount = new Intl.NumberFormat("zh-CN", { style: "currency", currency: data.currency, maximumFractionDigits: 2 }).format(data.currentRefundAmount);
  const asksForReasons = /(原因|为什么|为何|分析|拆解|reason)/i.test(originalText);
  const inventoryTotal = data.allProducts.reduce((sum, product) => sum + product.stock, 0);

  if (kind === "orders") {
    return {
      kind: "analysis",
      headline: `订单接口近 ${data.days} 天返回 ${data.currentOrders} 个已支付订单。`,
      metrics: orderMetric ? [orderMetric] : [],
      series: [],
      currency: data.currency,
      insights: [
        { label: "本周期", text: `已支付订单 ${data.currentOrders} 个；前一周期为 ${data.previousOrders} 个。`, tone: data.currentOrders > data.previousOrders ? "positive" : "neutral" },
        { label: "统计口径", text: "订单数来自 TikTok Shop Search Orders；未支付和已取消订单不计入。", tone: "neutral" },
      ],
      source: data.source,
    };
  }

  if (kind === "gmv") {
    return {
      kind: "analysis",
      headline: `Analytics ${data.analyticsPeriod.startDate} 至 ${data.analyticsPeriod.endDate} 的支付 GMV 为 ${gmvMetric?.value ?? "--"}。`,
      metrics: [gmvMetric, averageMetric].filter((item): item is NonNullable<typeof item> => Boolean(item)),
      series: data.dashboard.salesSeries,
      currency: data.currency,
      insights: [
        { label: "GMV 口径", text: "金额来自 TikTok Shop Analytics，而不是用订单金额自行估算。", tone: "neutral" },
        { label: "订单参照", text: `订单接口近 ${data.days} 天滚动期返回 ${data.currentOrders} 个已支付订单；该口径可能比 Analytics 更新。`, tone: "neutral" },
      ],
      source: data.source,
    };
  }

  if (kind === "refunds") {
    const reasonCounts = new Map<string, number>();
    for (const item of data.currentReturnDetails) {
      const reason = (item.reasonText || item.reason).trim();
      if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const reasonSummary = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => `${reason}（${count} 个）`)
      .join("、");
    const reasonHeadline = data.currentReturns === 0
      ? `近 ${data.days} 天没有退货退款申请，因此没有退款原因可分析。`
      : reasonSummary
        ? `近 ${data.days} 天的主要退款原因是：${reasonSummary}。`
        : `近 ${data.days} 天有 ${data.currentReturns} 个退货退款申请，但 API 响应没有提供原因字段，不能编造原因。`;
    return {
      kind: "analysis",
      headline: asksForReasons
        ? reasonHeadline
        : `近 ${data.days} 天有 ${data.currentReturns} 个退货退款申请，Analytics 退款金额为 ${refundAmount}。`,
      metrics: returnMetric ? [returnMetric] : [],
      series: [],
      currency: data.currency,
      insights: asksForReasons
        ? [
            { label: "当前可验证", text: `退货退款列表共 ${data.currentReturns} 个申请，Analytics 退款金额为 ${refundAmount}。`, tone: "neutral" },
            {
              label: reasonSummary ? "原因分布" : "原因字段",
              text: reasonSummary || (data.currentReturns === 0 ? "报告期内没有申请，因此没有原因样本。" : "本次 API 响应没有可用原因字段；系统不会编造原因结论。"),
              tone: reasonSummary ? "neutral" : "warning",
            },
          ]
        : [
            { label: "申请数量", text: `本周期 ${data.currentReturns} 个，前一周期 ${data.previousReturns} 个。`, tone: data.currentReturns > data.previousReturns ? "warning" : "neutral" },
            { label: "退款金额", text: `TikTok Shop Analytics 返回 ${refundAmount}。`, tone: "neutral" },
          ],
      source: data.source,
    };
  }

  return {
    kind: "analysis",
    headline: data.currentOrders === 0
      ? `近 ${data.days} 天订单接口返回 0 个已支付订单，Analytics 支付 GMV 为 ${gmvMetric?.value ?? "0"}。`
      : `近 ${data.days} 天共有 ${data.currentOrders} 个已支付订单，Analytics 支付 GMV 为 ${gmvMetric?.value ?? "--"}。`,
    metrics: data.dashboard.metrics,
    series: data.dashboard.salesSeries,
    currency: data.currency,
    insights: [
      {
        label: "订单结果",
        text: `订单接口本周期返回 ${data.currentOrders} 个已支付订单，前一周期为 ${data.previousOrders} 个。`,
        tone: data.currentOrders > data.previousOrders ? "positive" : "neutral",
      },
      { label: "商品目录", text: `商品接口返回 ${data.totalProducts} 个商品，当前汇总库存为 ${inventoryTotal.toLocaleString("zh-CN")} 件。`, tone: "neutral" },
      { label: "退货退款", text: `本周期查询到 ${data.currentReturns} 个退货退款申请，前一周期为 ${data.previousReturns} 个。`, tone: data.currentReturns > data.previousReturns ? "warning" : "neutral" },
    ],
    source: data.source,
  };
}

function resolveProductFocus(originalText: string, requested?: string): string {
  if (/(多少|几个|全部|所有)/i.test(originalText)) return "all";
  if (/热销/i.test(originalText)) return "top";
  if (/滞销/i.test(originalText)) return "slow";
  if (/库存|缺货|低库存/i.test(originalText)) return "low_stock";
  return requested ?? "all";
}

function matchedProducts(data: TikTokOperationalData, originalText: string, requested?: string): ProductRow[] {
  const normalizedText = originalText.toLocaleLowerCase();
  const normalizedQuery = requested?.trim().toLocaleLowerCase();
  const skuMatches = data.skuRows.filter((sku) => {
    const sellerSku = sku.sellerSku.trim().toLocaleLowerCase();
    if (!sellerSku) return false;
    if (normalizedQuery) return sellerSku === normalizedQuery || sellerSku.includes(normalizedQuery);
    return sellerSku.length >= 3 && normalizedText.includes(sellerSku);
  });
  if (skuMatches.length) {
    return skuMatches.map((sku) => {
      const parent = data.allProducts.find((product) => product.id === sku.productId);
      const dailyUnits = sku.units / Math.max(data.days, 1);
      const daysOfStock = dailyUnits > 0 ? Math.floor(sku.stock / dailyUnits) : undefined;
      const status: ProductRow["status"] = sku.stock <= 5 || (daysOfStock !== undefined && daysOfStock <= 3)
        ? "risk"
        : sku.stock <= 20 || (daysOfStock !== undefined && daysOfStock <= 7)
          ? "low"
          : "healthy";
      return {
        id: `${sku.productId}:${sku.skuId}`,
        sku: sku.sellerSku,
        title: sku.productTitle,
        image: parent?.image ?? "",
        revenue: new Intl.NumberFormat("zh-CN", { style: "currency", currency: sku.currency || data.currency, maximumFractionDigits: 2 }).format(sku.revenue),
        units: sku.units,
        stock: sku.stock,
        daysOfStock,
        status,
      };
    });
  }
  return data.allProducts.filter((product) => {
    const sku = product.sku.trim().toLocaleLowerCase();
    const title = product.title.trim().toLocaleLowerCase();
    if (normalizedQuery) return sku === normalizedQuery || sku.includes(normalizedQuery) || title.includes(normalizedQuery);
    return sku.length >= 3 && normalizedText.includes(sku);
  });
}

function liveProductsArtifact(data: TikTokOperationalData, focus: string, originalText: string, requested?: string): MessageArtifact {
  let products = [...data.allProducts];
  const exactMatches = matchedProducts(data, originalText, requested);
  if (exactMatches.length) {
    const exactStock = exactMatches.reduce((sum, product) => sum + product.stock, 0);
    const exactLabel = exactMatches.length === 1 ? exactMatches[0].sku : `${exactMatches.length} 个匹配 SKU`;
    return {
      kind: "products",
      headline: `${exactLabel} 当前可售库存为 ${exactStock.toLocaleString("zh-CN")} 件。`,
      summary: `只显示与本次问题匹配的真实商品库存；销量和 GMV 来自近 ${data.days} 天订单。`,
      products: exactMatches,
      totalCount: exactMatches.length,
      source: data.source,
    };
  }
  if (requested?.trim()) {
    return {
      kind: "products",
      headline: `没有找到与“${requested.trim()}”匹配的商品或 SKU。`,
      summary: `TikTok Shop 商品接口当前返回 ${data.totalProducts} 个商品；本次没有用其他商品代替。`,
      products: [],
      totalCount: 0,
      source: data.source,
    };
  }
  if (focus === "top" && data.currentOrders === 0) {
    return {
      kind: "products",
      headline: `近 ${data.days} 天没有已支付订单，无法从真实店铺数据判断什么商品好卖。`,
      summary: "系统没有用库存高低冒充销量排名。当前应用也尚未接入市场大盘或竞品趋势数据源。",
      products: [],
      totalCount: 0,
      source: data.source,
    };
  }
  if (focus === "low_stock") products = products.filter((product) => product.status !== "healthy").sort((a, b) => a.stock - b.stock);
  if (focus === "top") products = products.filter((product) => product.units > 0).sort((a, b) => b.units - a.units || b.stock - a.stock);
  if (focus === "slow") products.sort((a, b) => a.units - b.units || b.stock - a.stock);
  if (focus === "all") products.sort((a, b) => a.title.localeCompare(b.title));
  const matchingCount = products.length;
  const displayLimit = 100;
  products = products.slice(0, displayLimit);

  const headline = focus === "top"
    ? products.length
      ? `近 ${data.days} 天店内销量最高的是 ${products[0].title}。`
      : `近 ${data.days} 天没有可用于热销排名的商品。`
    : focus === "low_stock"
    ? products.length
      ? `发现 ${products.length} 个需要关注库存的商品。`
      : `当前 ${data.totalProducts} 个商品中没有发现低库存商品。`
    : `TikTok Shop 当前共有 ${data.totalProducts} 个商品。`;
  let summary = data.currentOrders === 0
    ? `近 ${data.days} 天订单接口返回 0，无法按真实销量排名；下表的库存、SKU 和商品信息来自 TikTok Shop 商品接口。`
    : `下表结合近 ${data.days} 天真实订单与当前商品库存生成。`;
  if (matchingCount > displayLimit) summary += ` 匹配 ${matchingCount} 条，页面仅显示前 ${displayLimit} 条；CSV 也只包含当前显示结果。`;
  return { kind: "products", headline, summary, products, totalCount: data.totalProducts, source: data.source };
}

function liveReportArtifact(data: TikTokOperationalData, focus = "销售、商品和退货退款"): MessageArtifact {
  const noOrders = data.currentOrders === 0;
  return {
    kind: "report",
    title: `${data.shop.name} · ${data.days} 天经营报告`,
    period: `过去 ${data.days} 天 · ${data.dashboard.store.timezone}`,
    executiveSummary: noOrders
      ? `TikTok Shop 订单接口在报告期内返回 0 个订单。本报告不推测增长原因，重点记录 ${data.totalProducts} 个商品的当前状态和库存。`
      : `报告期内共有 ${data.currentOrders} 个订单，支付 GMV 为 ${data.dashboard.metrics[0]?.value ?? "--"}。`,
    sections: [
      { title: "销售表现", body: noOrders ? "报告期内没有查询到订单，因此 GMV、客单价和销量均按 0 展示。" : `订单数为 ${data.currentOrders}，前一周期为 ${data.previousOrders}。`, stat: `${data.currentOrders} 个订单` },
      { title: "商品与库存", body: `TikTok Shop 商品接口返回 ${data.totalProducts} 个商品。报告没有使用演示商品或模拟销量。`, stat: `${data.totalProducts} 个商品` },
      { title: "退货退款", body: `报告重点为${focus}。本周期查询到 ${data.currentReturns} 个退货退款申请。`, stat: `${data.currentReturns} 个申请` },
    ],
    source: data.source,
  };
}

// ─── 真实数据 → 事实表 → 模型写的回答 ───────────────────────────
// 以前查到数据后直接返回一句写死的模板话（"我已从 TikTok Shop 读取近 7 天…"），
// 气泡正文不是模型写的、也没有任何信息量。这里改成：先把真实数据整理成事实表，
// 再让模型基于事实表写回答；模型不可用时退化成纯数字事实句（只有数字，不含判断）。
function buildLiveFactSheet(data: TikTokOperationalData, extraFacts?: string): string {
  const money = (amount: number) => new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: data.currency,
    maximumFractionDigits: 2,
  }).format(amount);
  const metric = (label: string) => data.dashboard.metrics.find((item) => item.label === label);
  const metricLine = (label: string) => {
    const item = metric(label);
    if (!item) return `${label}：接口未返回`;
    return `${label}：${item.value}${item.delta ? `（较前一周期 ${item.delta}）` : ""}`;
  };
  const topProducts = [...data.allProducts].sort((a, b) => b.units - a.units).slice(0, 5);
  const inventory = data.allProducts.reduce((sum, product) => sum + product.stock, 0);
  const risky = data.allProducts.filter((product) => product.status !== "healthy").slice(0, 5);
  // 退款原因按接口原样聚合，不做归类改写
  const reasonCounts = new Map<string, number>();
  for (const detail of data.currentReturnDetails) {
    const label = (detail.reasonText || detail.reason || "接口未给出原因").trim();
    reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
  }
  const reasonLine = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => `${label} ×${count}`)
    .join("；");

  return [
    `店铺：${data.shop.name}；站点：${data.shop.region}；币种：${data.currency}；时区：${data.dashboard.store.timezone}`,
    `统计区间：近 ${data.days} 天；Analytics 区间 ${data.analyticsPeriod.startDate} 至 ${data.analyticsPeriod.endDate}（最新可用日 ${data.analyticsPeriod.latestAvailableDate}）`,
    `核心指标：${["支付 GMV", "订单数", "客单价", "退货退款申请"].map(metricLine).join("；")}`,
    `订单口径：Order API 近 ${data.days} 天已支付订单 ${data.currentOrders} 个，前一周期 ${data.previousOrders} 个；Analytics 订单 ${data.analyticsCurrentOrders} 个，前一周期 ${data.analyticsPreviousOrders} 个`,
    `退货退款：申请 ${data.currentReturns} 个（前一周期 ${data.previousReturns} 个），退款金额 ${money(data.currentRefundAmount)}（前一周期 ${money(data.previousRefundAmount)}）`,
    reasonLine ? `退款原因（本周期接口返回）：${reasonLine}` : "",
    `商品：在售 ${data.totalProducts} 个，SKU ${data.skuRows.length} 个，可售库存合计 ${inventory}`,
    topProducts.length
      ? `热销商品：${topProducts.map((product) => `${product.title.slice(0, 24)}（销量 ${product.units}，库存 ${product.stock}）`).join("；")}`
      : "热销商品：接口未返回",
    risky.length
      ? `库存异常：${risky.map((product) => `${product.title.slice(0, 20)}（库存 ${product.stock}，${product.status}）`).join("；")}`
      : "",
    extraFacts ?? "",
    `数据来源：${data.source}`,
  ].filter(Boolean).join("\n");
}

/** 模型不可用时的降级句：只陈述接口返回的数字，不含任何判断。 */
function liveFactHeadline(data: TikTokOperationalData): string {
  const metric = (label: string) => data.dashboard.metrics.find((item) => item.label === label);
  const gmv = metric("支付 GMV");
  const orders = metric("订单数");
  const average = metric("客单价");
  const returns = metric("退货退款申请");
  const parts = [
    gmv && `支付 GMV ${gmv.value}${gmv.delta ? `（${gmv.delta}）` : ""}`,
    orders && `订单 ${orders.value} 个${orders.delta ? `（${orders.delta}）` : ""}`,
    average && `客单价 ${average.value}`,
    returns && `退货退款申请 ${returns.value} 个`,
  ].filter(Boolean);
  return `近 ${data.days} 天（${data.shop.name} · ${data.shop.region}）：${parts.join("，")}。`;
}

async function composeLiveNarrative(data: TikTokOperationalData, originalText: string, extraFacts?: string): Promise<string> {
  if (!hasLlmConfiguration()) return liveFactHeadline(data);
  try {
    return await summarizeLiveShopData({ question: originalText, factSheet: buildLiveFactSheet(data, extraFacts) });
  } catch (error) {
    console.warn("经营解读生成失败，退回纯数字事实句：", error instanceof Error ? error.message : error);
    return liveFactHeadline(data);
  }
}

async function renderLiveDecision(decision: AgentDecision, originalText: string): Promise<ChatMessage> {
  if (decision.tool === "respond") {
    // LLM 偶发返回不带 content 的 respond 调用（content 为 undefined），
    // 直接传下去会在文本清洗时触发 "Cannot read properties of undefined (reading 'replace')"
    const content = typeof decision.args.content === "string" ? decision.args.content : "";
    const followUps = cleanFollowUps(decision.args.followUps ?? [], originalText);
    // respond 不携带 artifact，使用空 artifact 但仍触发质量检查
    return message(content, undefined, undefined, followUps, originalText);
  }
  if (decision.tool === "get_kol_bridge_status" || decision.tool === "list_kol_creators" || decision.tool === "get_kol_stats") {
    const prompt = decision.tool === "get_kol_bridge_status"
      ? "检查达人插件连接状态"
      : decision.tool === "get_kol_stats"
        ? "查看达人建联数据"
        : `${decision.args.category ?? ""} ${decision.args.minFollowers ? `粉丝大于${decision.args.minFollowers}` : ""} 查看达人库`;
    return (await handleKolNaturalLanguage({ message: prompt.trim(), storeId: "kol", mode: "execute", context: "kol" }))?.message
      ?? message("无法读取达人能力。");
  }
  if (decision.tool === "start_kol_outreach_workflow") return message("达人建联任务已经交由持久化任务中心处理。");
  if (decision.tool === "explain_product_operations" && !decision.args.includeBestSellers) {
    return message("商品上架、下架接口已经接通。请写出一个准确的商品名、商品 ID 或 SKU；系统会先生成审核卡片，得到你的确认后才提交。", {
      kind: "suggestions",
      prompts: ["查看全部商品库存", "最近什么商品好卖", "查询最近 7 天订单"],
    });
  }
  if (decision.tool === "prepare_inventory_update" || decision.tool === "prepare_price_update") {
    return message("库存和价格写接口已经接通，但这条指令缺少可安全生成审核卡片的准确 SKU 或目标值。请补充后重试。", {
      kind: "suggestions",
      prompts: ["查看全部商品库存", "查询近 7 天订单", "生成真实经营报告"],
    });
  }
  if (decision.tool === "create_readonly_automation") {
    // 通过调度器创建真实的定时任务
    const schedule = decision.args.schedule;
    const taskDesc = decision.args.task ?? "只读查询";
    const cron = parseScheduleToCron(schedule);
    const task = scheduler.create({
      name: taskDesc.slice(0, 40),
      description: taskDesc,
      cron,
      type: "read_only_query",
      params: { queryType: "sales_overview", days: 7 },
      agent: "general",
    });
    return message(`已创建定时任务「${task.name}」，调度规则：${cron}。任务 ID：${task.id}。任务会在下次到期时自动执行只读查询并推送结果。`, {
      kind: "suggestions",
      prompts: ["查看所有定时任务", "手动执行一次该任务"],
    });
  }

  const days = decision.tool === "get_sales_overview"
    || decision.tool === "get_order_summary"
    || decision.tool === "get_gmv_summary"
    || decision.tool === "get_refund_summary"
    || decision.tool === "explain_product_operations"
    || decision.tool === "generate_operations_report"
    ? Math.max(1, Math.min(90, Math.floor(decision.args.days ?? extractDays(originalText))))
    : 7;
  // ─── run_tiktok_scene_query：LLM 503 时类目查询仍能拿到真实数据 ─────
  if (decision.tool === "run_tiktok_scene_query") {
    const scene = String(decision.args.scene ?? "market_products") as TikTokSceneQuery;
    const regionArg = String(decision.args.region ?? "");
    const sceneDays = Math.max(1, Math.min(90, Number(decision.args.days) || 7));
    try {
      // region 只作为日志/标签用，真实 region 由 runTikTokSceneQuery 内部从已授权店铺读取
      const result = await runTikTokSceneQuery(scene, sceneDays, originalText);
      const fallbackArtifact: MessageArtifact = {
        kind: "records",
        headline: `${sceneDays}天${regionArg}市场热销商品`,
        summary: result.content.slice(0, 120),
        columns: [],
        rows: [],
        source: "TikTok Shop Bestsellers",
      };
      return message(result.content, result.artifact ?? fallbackArtifact, undefined, [], originalText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return message(`市场榜单查询未成功：${msg}。建议先用真实店铺销售数据判断经营健康度，再对比本地货源的优势品类切入。`, undefined, undefined, ["查询最近7天店铺销售情况", "生成经营周报"], originalText);
    }
  }

  // ─── analyze_category_track：赛道/类目深度分析（竞争格局+价格带+头部特征+进入建议） ─────
  if (decision.tool === "analyze_category_track") {
    const categoryText = String(decision.args.category ?? originalText);
    const regionArg = String(decision.args.region ?? "");
    const trackDays = Math.max(1, Math.min(90, Number(decision.args.days) || 7));
    try {
      const result = await analyzeCategoryTrack(categoryText, regionArg, trackDays, originalText);
      const artifact = result.artifact ?? {
        kind: "records" as const,
        headline: `赛道分析 · ${categoryText}`,
        summary: result.content.slice(0, 100),
        columns: [],
        rows: [],
        source: "TikTok Bestsellers + 类目匹配",
      };
      return message(result.content, artifact, undefined, [
        "生成该赛道选品方案",
        "分析本店商品在该赛道的竞争力",
        "查询该赛道相关达人资源",
      ], originalText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return message(`赛道分析未完成：${msg}。建议先确认 TikTok Shop 授权状态，或先用店铺销售数据判断经营健康度。`, undefined, undefined, ["查询最近7天店铺销售情况", "查看店铺热销商品"], originalText);
    }
  }
  const data = await getTikTokOperationalData(days);
  // 只在真的要用时才生成解读，避免 get_shop_info 这类不需要分析的场景白花一次模型调用
  let narrativeTask: Promise<string> | undefined;
  const narrative = (extraFacts?: string) => {
    if (extraFacts) return composeLiveNarrative(data, originalText, extraFacts);
    return (narrativeTask ??= composeLiveNarrative(data, originalText));
  };
  switch (decision.tool) {
    case "get_shop_info":
      return message(`当前连接的真实店铺是 ${data.shop.name}，站点为 ${data.dashboard.store.region} (${data.shop.region})，币种 ${data.currency}，时区 ${data.dashboard.store.timezone}。`, undefined, liveSteps("read", data));
    case "get_sales_overview":
      return message(await narrative(), liveSalesArtifact(data, originalText, "overview"), liveSteps("read", data));
    case "get_order_summary":
      return message(await narrative(), liveSalesArtifact(data, originalText, "orders"), liveSteps("read", data));
    case "get_gmv_summary":
      return message(await narrative(), liveSalesArtifact(data, originalText, "gmv"), liveSteps("read", data));
    case "get_refund_summary":
      return message(await narrative(), liveSalesArtifact(data, originalText, "refunds"), liveSteps("read", data));
    case "explain_product_operations":
      return message(
        `上架、下架接口已经接通；真正执行前仍需指定一个准确商品并确认变更计划。\n${await narrative()}`,
        liveProductsArtifact(data, "top", originalText),
        liveSteps("read", data),
      );
    case "list_products": {
      const focus = resolveProductFocus(originalText, decision.args.focus);
      // 用户点名了某个商品/SKU 时，把精确匹配到的商品事实一起交给模型，避免解读答偏
      const matched = matchedProducts(data, originalText, decision.args.query);
      const extraFacts = matched.length
        ? `本次问题精确匹配到的商品：${matched.map((product) => `${product.title}（SKU ${product.sku}，可售库存 ${product.stock}，近 ${data.days} 天销量 ${product.units}，销售额 ${product.revenue}）`).join("；")}`
        : undefined;
      return message(
        await narrative(extraFacts),
        liveProductsArtifact(data, focus, originalText, decision.args.query),
        liveSteps("read", data),
      );
    }
    case "generate_operations_report":
      return message(await narrative(), liveReportArtifact(data, decision.args.focus), liveSteps("report", data));
    default:
      return message("这项能力尚未接入真实 TikTok Shop 接口，本次没有返回演示结果。");
  }
}

// ─── 真实模式工具执行器（为 ReAct 循环服务） ──────────────────

function createLiveToolExecutor(request: ChatRequest): ToolExecutorFn {
  return async (decision: AgentDecision): Promise<string> => {
    const rawDays = "days" in decision.args ? (decision.args as { days?: number }).days : undefined;
    const days = rawDays ?? 7;
    switch (decision.tool) {
      case "get_shop_info": {
        const data = await getTikTokOperationalData(7);
        return `店铺：${data.shop.name}，站点：${data.shop.region}，币种：${data.currency}，时区：${data.dashboard.store.timezone}`;
      }
      case "get_sales_overview": {
        const d = Math.max(1, Math.min(90, Math.floor(days)));
        const data = await getTikTokOperationalData(d);
        return `近${d}天：${data.currentOrders}个已支付订单（前${d}天${data.previousOrders}个），${data.totalProducts}个商品，${data.currentReturns}个退货退款申请`;
      }
      case "get_order_summary": {
        const d = Math.max(1, Math.min(90, Math.floor(days)));
        const data = await getTikTokOperationalData(d);
        return `近${d}天已支付订单${data.currentOrders}个，前一周期${data.previousOrders}个${data.currentOrders > data.previousOrders ? "，订单量在增长" : data.currentOrders < data.previousOrders ? "，订单量在下降" : "，订单量持平"}`;
      }
      case "get_gmv_summary": {
        const data = await getTikTokOperationalData(Math.max(1, Math.min(90, Math.floor(days))));
        const gmv = data.dashboard.metrics.find((m) => m.label === "支付 GMV");
        const avg = data.dashboard.metrics.find((m) => m.label === "客单价");
        return `支付GMV：${gmv?.value ?? "--"}，客单价：${avg?.value ?? "--"}`;
      }
      case "get_refund_summary": {
        const d = Math.max(1, Math.min(90, Math.floor(days)));
        const data = await getTikTokOperationalData(d);
        return `近${d}天${data.currentReturns}个退货退款申请（前${d}天${data.previousReturns}个），退款金额${data.currentRefundAmount}`;
      }
      case "list_products": {
        const d = Math.max(1, Math.min(90, Math.floor(days)));
        const data = await getTikTokOperationalData(d);
        const focus = resolveProductFocus("", decision.args.focus);
        let products = [...data.allProducts];
        if (focus === "top") products = products.filter((p) => p.units > 0).sort((a, b) => b.units - a.units).slice(0, 10);
        else if (focus === "low_stock") products = products.filter((p) => p.status !== "healthy").sort((a, b) => a.stock - b.stock).slice(0, 10);
        else if (focus === "slow") products = products.sort((a, b) => a.units - b.units).slice(0, 10);
        else products = products.slice(0, 10);
        const list = products.map((p) => `${p.title}(${p.sku}:库存${p.stock},近${d}天售${p.units}件)`).join("；");
        return `共${data.totalProducts}个商品。${focus === "top" ? "热销前10" : focus === "low_stock" ? "低库存前10" : focus === "slow" ? "滞销前10" : "前10个"}：${list || "无匹配商品"}`;
      }
      case "explain_product_operations": {
        return "上架/下架接口已接通，执行时需指定准确商品并人工确认。";
      }
      case "generate_operations_report": {
        const d = Math.max(1, Math.min(90, Math.floor(days)));
        const data = await getTikTokOperationalData(d);
        return `近${d}天：${data.currentOrders}个订单，${data.totalProducts}个商品，${data.currentReturns}个退货退款`;
      }
      case "prepare_inventory_update":
      case "prepare_price_update":
        return "写操作需要通过专门的审批流程执行，不能在此直接完成。";
      case "create_readonly_automation": {
        const cron = parseScheduleToCron(decision.args.schedule);
        const task = scheduler.create({
          name: (decision.args.task ?? "只读查询").slice(0, 40),
          description: decision.args.task,
          cron,
          type: "read_only_query",
          params: { queryType: "sales_overview", days: 7 },
          agent: request.context ?? "general",
        });
        return `已创建定时任务「${task.name}」，调度规则：${cron}。任务 ID：${task.id}，下次到期时自动执行。`;
      }
      case "get_workflow_status": {
        const runs = decision.args.workflowId
          ? [await workflowCoordinator.get(decision.args.workflowId)].filter(Boolean)
          : (await workflowCoordinator.list()).filter((run) => !decision.args.workflowType || run.type === decision.args.workflowType).slice(0, 5);
        return runs.length ? runs.map((run) => workflowStatusText(run)).join("\n") : "没有找到匹配的业务任务。";
      }
      case "get_kol_bridge_status": {
        const status = kolBridge.status();
        return status.connected ? `达人浏览器插件已连接，端口 ${status.port}` : `达人浏览器插件未连接，等待端口 ${status.port}`;
      }
      case "list_kol_creators": {
        const creators = await kolBridge.listCreators(decision.args);
        return `匹配到 ${creators.length} 位真实达人：${creators.slice(0, 20).map((creator) => `${creator.nickname}(${creator.followerCount}粉丝)`).join("；") || "无"}`;
      }
      case "get_kol_stats": {
        const stats = await kolBridge.getStats();
        return `达人池${stats.totalCreators}位，累计邀约${stats.totalInvited}，成功${stats.success}，待处理${stats.pending}，失败${stats.failed}`;
      }
      case "start_kol_outreach_workflow": {
        const run = await startKolOutreachWorkflow(decision.args);
        return `已创建达人建联任务 ${run.id}，当前状态 ${run.status}。发送前仍会等待人工确认。`;
      }
      case "start_supplier_publish_workflow": {
        const dimensions = decision.args.packageLength && decision.args.packageWidth && decision.args.packageHeight
          ? { length: decision.args.packageLength, width: decision.args.packageWidth, height: decision.args.packageHeight }
          : undefined;
        const run = await startProductPublishWorkflow({
          sourceUrl: decision.args.sourceUrl,
          shopId: decision.args.shopId,
          publishPrice: decision.args.publishPrice,
          currency: decision.args.currency,
          packageDimensions: dimensions,
          title: decision.args.title,
          description: decision.args.description,
        });
        return `已创建供应商上架任务 ${run.id}，当前状态 ${run.status}。后续编辑保存和最终发布仍会分别等待确认。`;
      }
      case "start_flash_sale_workflow": {
        const run = await startFlashSaleWorkflow({ ...decision.args, currency: decision.args.currency ?? "JPY" });
        return `已创建秒杀任务 ${run.id}，当前状态 ${run.status}。只读预检通过后会等待确认创建活动。`;
      }
      case "approve_workflow": {
        return "请在任务卡片中核对内容并点击审核按钮；聊天文本不会绕过审核直接写入。";
      }
      case "retry_workflow": {
        return "请在任务卡片中点击重试按钮；系统会从失败步骤继续，并避免重复已完成的写入。";
      }
      case "verify_workflow":
        return workflowStatusText(await workflowCoordinator.verify(decision.args.workflowId));
      case "delegate_to_agent": {
        // 跨 Agent 委派：运营总监把子任务交给专业 Agent
        const targetAgent = decision.args.targetAgent as AgentContext;
        const task = decision.args.task;
        const taskContext = decision.args.context;
        if (!isAgentContext(targetAgent)) {
          return `无法委派：未知的目标 Agent "${targetAgent}"。`;
        }
        const fromAgent = request.context ?? "general";
        try {
          const result = await executeDelegation(fromAgent, targetAgent, task, taskContext, request.message.slice(0, 40), request.storeId);
          if (result.success) {
            return `[${getDigitalEmployee(targetAgent).name} 委派结果] ${result.content}`;
          }
          return `委派给 ${getDigitalEmployee(targetAgent).name} 失败：${result.content}`;
        } catch (error) {
          return `委派执行异常：${error instanceof Error ? error.message : "未知错误"}`;
        }
      }
      default: {
        // 处理 Skill 动态工具（如 miaoshou_query）
        const decisionAny = decision as unknown as { tool: string; args: Record<string, unknown> };
        if (decisionAny.tool === "miaoshou_query") {
          const scene = decisionAny.args.scene as string | undefined;
          const query = decisionAny.args.query as string | undefined;
          if (!scene) return "缺少 scene 参数。";
          try {
            const sceneQuery = scene as MiaoshouSceneQuery;
            const result = await runMiaoshouSceneQuery(sceneQuery, query ?? scene, request.history);
            return result.content;
          } catch (error) {
            return `采集查询失败：${error instanceof Error ? error.message : "未知错误"}`;
          }
        }
        if (decisionAny.tool === "web_search") {
          try {
            const result = await searchWeb({
              query: String(decisionAny.args.query ?? ""),
              topic: decisionAny.args.topic === "news" ? "news" : "general",
              timeRange: ["day", "week", "month", "year"].includes(String(decisionAny.args.timeRange))
                ? decisionAny.args.timeRange as "day" | "week" | "month" | "year"
                : undefined,
              maxResults: typeof decisionAny.args.maxResults === "number" ? decisionAny.args.maxResults : 5,
              includeDomains: Array.isArray(decisionAny.args.includeDomains) ? decisionAny.args.includeDomains.map(String) : undefined,
              excludeDomains: Array.isArray(decisionAny.args.excludeDomains) ? decisionAny.args.excludeDomains.map(String) : undefined,
            });
            return formatWebSearchForLlm(result);
          } catch (error) {
            return `联网搜索失败：${error instanceof Error ? error.message : "未知错误"}`;
          }
        }
        // 处理 FastMoss MCP 工具
        if (decisionAny.tool.startsWith("fastmoss_")) {
          try {
            const result = await callFastMossTool(decisionAny.tool, decisionAny.args);
            return result.isError ? `[FastMoss 错误] ${result.content}` : result.content;
          } catch (error) {
            return `FastMoss 调用失败：${error instanceof Error ? error.message : "未知错误"}`;
          }
        }
        // 处理日区选品 MCP 只读工具
        if (decisionAny.tool.startsWith("chuhaijiang_")) {
          try {
            const result = await callChuhaijiangTool(decisionAny.tool, decisionAny.args);
            return result.isError ? `[日区选品错误] ${result.content}` : result.content;
          } catch (error) {
            return `日区选品调用失败：${error instanceof Error ? error.message : "未知错误"}`;
          }
        }
        return "该工具尚未接入。";
      }
    }
  };
}

// ─── 委派处理器注册 ────────────────────────────────────────────
// 每个 Agent 注册自己的委派处理函数，当运营总监或其他 Agent 委派任务时被调用

let delegationHandlersRegistered = false;

function ensureDelegationHandlers(): void {
  if (delegationHandlersRegistered) return;
  delegationHandlersRegistered = true;

  // 通用委派处理器：用目标 Agent 的身份执行一个独立的查询/分析请求
  const agentContexts: AgentContext[] = ["product", "sourcing", "collection", "publishing", "kol", "content"];
  for (const agentCtx of agentContexts) {
    registerDelegationHandler(agentCtx, async (request) => {
      const employee = getDigitalEmployee(agentCtx);
      // 构造一个模拟的 ChatRequest 交给目标 Agent 处理
      const subRequest: ChatRequest = {
        message: request.task,
        storeId: request.storeId ?? "",
        context: agentCtx,
        history: request.context
          ? [{ role: "user", content: request.context }, { role: "assistant", content: "好的，我来处理。" }]
          : [],
      };
      try {
        const response = await handleChatInternal(subRequest);
        return {
          from: request.from,
          to: agentCtx,
          success: true,
          content: response.message.content,
          correlationId: request.correlationId,
          timestamp: Date.now(),
        };
      } catch (error) {
        return {
          from: request.from,
          to: agentCtx,
          success: false,
          content: `${employee.name} 执行任务时出错：${error instanceof Error ? error.message : "未知错误"}`,
          correlationId: request.correlationId,
          timestamp: Date.now(),
        };
      }
    });
  }
}

/** 内部调用 handleChat 的轻量封装（不触发重复的状态管理） */
async function handleChatInternal(request: ChatRequest): Promise<ChatResponse> {
  return handleChat(request);
}

// ─── 主入口 ──────────────────────────────────────────────────

export async function handleChat(request: ChatRequest, emit?: ChatStreamEmitter): Promise<ChatResponse> {
  // 所有路径（快路径早退、异常）都必须释放工作状态，否则 Agent 永久显示忙碌
  const context = request.context ?? "general";
  agentRegistry.startWork(context, request.message.slice(0, 80));
  try {
    return await runChat(request, emit);
  } finally {
    agentRegistry.completeWork(context);
  }
}

async function runChat(request: ChatRequest, emit?: ChatStreamEmitter): Promise<ChatResponse> {
  // 确保委派处理器已注册
  ensureDelegationHandlers();

  const context = request.context ?? "general";
  // 加载长期记忆（传统全量记忆 + 新分层语义检索）
  const memory = loadMemory();
  const memoryContext = formatMemoryForPrompt(memory);
  const semanticMemory = memoryLayer.formatForPrompt(request.message, context, 5);
  const intelligenceContext = intelligenceStore.buildPromptContext(request.message, context);
  const agentContext = memoryContext + semanticMemory + intelligenceContext;

  const fastConversationResponse = inferFastConversationResponse(request.message);
  if (fastConversationResponse) {
    return { message: message(fastConversationResponse), runId: randomUUID() };
  }

  const explicitWebSearch = inferExplicitWebSearch(request.message);
  if (explicitWebSearch) {
    if (!hasWebSearchConfiguration()) {
      return { message: message("互联网搜索尚未配置，请先在智能中心的“联网搜索”中完成配置。"), runId: randomUUID() };
    }
    try {
      const research = await searchWeb(explicitWebSearch);
      let content = formatWebSearchForUser(research);
      if (hasLlmConfiguration() && research.results.length && needsDeepWebAnalysis(request.message)) {
        try {
          content = await summarizeWebResearch(request.message, research);
        } catch {
          // 模型超时时仍返回可核对的真实搜索结果。
        }
      }
      return {
        message: message(content, undefined, [
          { id: "web-search", label: "联网检索", detail: `找到 ${research.results.length} 个公开来源`, status: "done" },
          { id: "source-check", label: "核对来源", detail: "优先保留官方和一手资料", status: "done" },
          { id: "web-summary", label: needsDeepWebAnalysis(request.message) ? "形成结论" : "整理结果", detail: needsDeepWebAnalysis(request.message) ? "已区分来源事实、分析判断和待确认信息" : "已保留来源摘要和原始网址", status: "done" },
        ]),
        runId: randomUUID(),
      };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "联网搜索失败。"), runId: randomUUID() };
    }
  }

  const workflowCommand = await handleWorkflowNaturalLanguage(request);
  if (workflowCommand) return workflowCommand;

  const kolCommand = await handleKolNaturalLanguage(request);
  if (kolCommand) return kolCommand;

  // 货源选品 Agent：上传图片或用自然语言发起 1688 同款搜索。
  const sourcingIntent = inferSourcingIntent(request);
  if (sourcingIntent) {
    if (!hasTmapiConfiguration()) {
      return { message: message("1688 货源数据尚未连接，请先在 Skill 管理中配置 1688 货源 Token。"), runId: randomUUID() };
    }
    try {
      const result = await runSourcingSearch(sourcingIntent);
      const responseMsg = message(
        result.content,
        result.artifact,
        result.artifact ? [
          { id: "image", label: "识别搜索图片", detail: "已上传并转换为 1688 可识别图片", status: "done" },
          { id: "search", label: "搜索1688同款", detail: `找到 ${result.artifact.totalCount} 个相似结果`, status: "done" },
          { id: "compare", label: "对比供应商", detail: `已补全 ${result.artifact.candidates.length} 个候选商品`, status: "done" },
          { id: "profit", label: "对比候选货源", detail: "已汇总采购价、起订量、销量、重量与供应商资质", status: "done" },
        ] : undefined,
      );
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "1688 以图搜货源失败。"), runId: randomUUID() };
    }
  }

  // 快速路径：只读的 1688 货源体检。放在采集前，先看真实 SKU 和采购价。
  const tmapiIntent = inferTmapiItemIntent(request.message);
  if (tmapiIntent && hasTmapiConfiguration()) {
    try {
      const result = await runTmapiItemScene(tmapiIntent);
      const responseMsg = message(
        result.content,
        result.artifact,
        [
          { id: "parse", label: "识别 1688 商品", detail: `商品 ID ${tmapiIntent.itemId}`, status: "done" },
          { id: "read", label: "读取货源数据", detail: "已核对 SKU、采购价、库存和重量", status: "done" },
          { id: "present", label: "生成商品体检", detail: "本次为只读查询，未修改采集上架或 TikTok 数据", status: "done" },
        ],
        [
          `把 https://detail.1688.com/offer/${tmapiIntent.itemId}.html 采集到采集箱`,
          `按一件代发场景重新读取 1688 商品 ID ${tmapiIntent.itemId}`,
        ],
      );
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    } catch (error) {
      return {
        message: message(error instanceof Error ? error.message : "无法读取 1688 货源数据。"),
        runId: randomUUID(),
      };
    }
  }

  // ── 快速路径：TikTok 秒杀任务 ──
  const flashSaleIntent = parseFlashSaleIntent(request.message);
  if (flashSaleIntent) {
    if (!flashSaleIntent.input) {
      return {
        message: message(`还缺少：${flashSaleIntent.missing.join("、")}。请补全后再发一次，我会先生成可核对的秒杀方案，不会立刻创建活动。`),
        runId: randomUUID(),
      };
    }
    try {
      const run = await startFlashSaleWorkflow(flashSaleIntent.input);
      const responseMsg = message("秒杀任务已创建。系统会先核对权限、商品 SKU 和实时库存，通过后在任务卡片中等待你确认。", { kind: "workflow", run });
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    } catch (error) {
      return { message: message(error instanceof Error ? error.message : "无法创建秒杀任务。"), runId: randomUUID() };
    }
  }

  // ── 快速路径：1688 到 TikTok 的完整发布任务 ──
  const productWorkflowInput = extract1688WorkflowInput(request.message);
  if (productWorkflowInput) {
    try {
      const run = await startProductPublishWorkflow(productWorkflowInput);
      const responseMsg = message("已生成上架任务审核卡。审核通过后才会开始采集和认领；保存商品编辑与最终发布仍会分别再次审核。", { kind: "workflow", run });
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    } catch (error) {
      return {
        message: message(error instanceof Error ? error.message : "无法创建发布任务。"),
        runId: randomUUID(),
      };
    }
  }

  // ── 快速路径：采集场景查询和单步操作 ──
  const miaoshouQuery = inferMiaoshouSceneQuery(request.message);
  if (miaoshouQuery) {
    if (miaoshouQuery === "publish_to_tiktok") {
      // 聊天里直接发布：复用 TikTok 采集箱里最近一件已认领、未发布的商品生成上架任务。
      // 不直接提交发布——保存商品编辑与最终发布仍会在任务卡片里分别审核。
      try {
        const run = await startPublishFromCollectBox();
        const responseMsg = message(
          `已基于 TikTok 采集箱商品 ${run.platformDetailId} 生成上架任务审核卡。审核通过后会自动补全资料并进入保存/发布确认；不会再重复采集或认领。`,
          { kind: "workflow", run },
        );
        void extractAndSaveMemory(request, responseMsg);
        return { message: responseMsg, runId: randomUUID() };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "采集箱查询失败。";
        return {
          message: message(`暂时无法在聊天里创建发布任务：${reason} 也可以粘贴 1688 链接，我会走完整的采集 → 认领 → 发布流程。`),
          runId: randomUUID(),
        };
      }
    }
    if (MIAOSHOU_WRITE_SCENES.has(miaoshouQuery)) {
      const plan = await createMiaoshouApproval(request, miaoshouQuery);
      return {
        message: message("这项操作会修改采集商品数据。我已生成审核卡片，审核通过后才会调用接口。", { kind: "approval", plan }, createSteps("write")),
        runId: randomUUID(),
      };
    }
    try {
      const result = await runMiaoshouSceneQuery(miaoshouQuery, request.message, request.history);
      const followUps = miaoshouSceneFollowUps(miaoshouQuery);
      const responseMsg = message(
        result.content,
        result.artifact,
        miaoshouQuerySteps(miaoshouQuery),
        followUps,
      );
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "采集上架 API 调用失败";
      const responseMsg = message(`采集上架接口调用遇到问题：${errorMsg}`, undefined, undefined, ["查看公共采集箱", "查看全部商品和 SKU"]);
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    }
  }

  // ── 快速路径：TikTok 场景查询（真实模式） ──
  // 排除 FastMoss 关键词，让含 FastMoss 的请求走 ReAct 循环调用 MCP 工具
  // 同时：如果用户明确问了某个类目/品类（如"家纺布艺""美妆"），也跳过快速路径，走 ReAct 让 FastMoss 的类目分析工具可用
  const isFastMossRequest = /fastmoss|fast.?moss/i.test(request.message);
  const hasCategoryIntent = /(?:类目|品类|行业|赛道|类别)/.test(request.message)
    || /(家[纺织]|家纺|布艺|床上用品|床品|床单|被套|枕套|枕头|抱枕|四件套|床垫|床笠|凉席|毛毯|地毯|地垫|窗帘|沙发布|毛巾|浴巾)/i.test(request.message)
    || /(美妆|护肤|化妆|精华|乳液|面霜|粉底|口红|唇釉|眉笔|眼影|腮红|香水|彩妆|面膜|防晒|卸妆|洁面)/i.test(request.message)
    || /(3c|数码|手机|平板|电脑|笔记本|耳机|音箱|充电器|移动电源|充电宝|摄像头|相机|游戏机|智能手表|手环)/i.test(request.message)
    || /(服装|服饰|衣服|男装|女装|童装|鞋|靴|包包|手袋|箱包|内衣|袜子|帽子|围巾|皮带)/i.test(request.message)
    || /(家居|家具|家装|建材|厨房|卫浴|收纳|餐具|椅子|桌子|沙发|衣柜|书柜|灯|灯具)/i.test(request.message)
    || /(食品|零食|饮料|生鲜|水果|蔬菜|保健品|维生素|蛋白粉|减肥|代餐|咖啡|茶|宠物食品)/i.test(request.message)
    || /(母婴|婴儿|宝宝|孕妇|奶粉|纸尿裤|奶瓶|玩具|积木|娃娃)/i.test(request.message)
    || /(运动|健身|户外|跑步|瑜伽|自行车|登山|露营|钓鱼|球|球拍)/i.test(request.message);
  if (!isFastMossRequest && !hasCategoryIntent) {
    const sceneQuery = inferTikTokSceneQuery(request.message);
    if (sceneQuery) {
      const requestedDays = extractDays(request.message);
      const result = await runTikTokSceneQuery(sceneQuery, requestedDays, request.message);
      const content = sceneQuery === "market_products" && asksForProductOperation(request.message)
        ? `商品上架和下架接口已经接通；执行时必须给出准确商品并人工确认。${result.content}`
        : result.content;
      const responseMsg = message(
          content,
          result.artifact,
          sceneQuerySteps(sceneQuery, requestedDays, result.artifact.source),
          sceneFollowUps(sceneQuery, result.artifact, requestedDays, request.message),
          request.message,
        );
      // 异步提取记忆
      void extractAndSaveMemory(request, responseMsg);
      return {
        message: responseMsg,
        runId: randomUUID(),
      };
    }

    const writeKind = inferLiveProductWrite(request.message);
    if (writeKind) {
      try {
        const plan = await prepareTikTokProductWrite(writeKind, request.message);
        return {
          message: message("这是写操作。我已精确读取当前值并生成不可变更的执行计划；只有确认后才会提交，并在提交前后再次回读验证。", { kind: "approval", plan }, liveProductWriteSteps(plan)),
          runId: randomUUID(),
        };
      } catch (error) {
        if (!(error instanceof TikTokWritePreparationError)) throw error;
        return {
          message: message(error.message, {
            kind: "suggestions",
            prompts: ["查看全部商品库存", "查询仓库列表", "查询卖家权限"],
          }),
          runId: randomUUID(),
        };
      }
    }

    const fastReadDecision = inferFastReadDecision(request.message);
    if (fastReadDecision) {
      // 这条路径要打十几次官方接口，中间没有别的反馈，
      // 先把"正在做什么"推给前端，避免用户面对一个转圈干等
      emit?.({ type: "step", step: { id: "live-active", label: toolLabel(fastReadDecision.tool), detail: "正在读取 TikTok Shop 真实数据…", status: "running" } });
      const responseMsg = await renderLiveDecision(fastReadDecision, request.message);
      if (!responseMsg.followUps?.length) responseMsg.followUps = decisionFollowUps(fastReadDecision, request.message);
      void extractAndSaveMemory(request, responseMsg);
      return { message: responseMsg, runId: randomUUID() };
    }
  }

  // ── 百度搭子（DuMate）对话路径 ──
  // 开启且配置后，非业务数据类对话交给搭子（普通聊天、知识问答、运营建议）；
  // 命中经营数据/写操作关键词的消息仍走原链路，保留真实数据查询与审批安全。
  if (isDumateConfigured() && shouldRouteToDumate(request.message)) {
    try {
      return await handleDumateChat(request, emit);
    } catch (error) {
      console.warn("DuMate 对话失败，回落到原有链路：", error);
    }
  }

  // ── ReAct 多步推理路径（真实模式 + LLM 可用时启用） ──
  let responseMessage: ChatMessage;

  if (hasLlmConfiguration()) {
    try {
      const rawToolExecutor = createLiveToolExecutor(request);
      // 用闭环学习追踪包装工具执行器：记录决策→结果→反思链路
      const toolExecutor: ToolExecutorFn = async (decision) => {
        const startTime = Date.now();
        const agent = (request.context ?? "general") as AgentContext;
        const argsSummary = JSON.stringify(decision.args).slice(0, 100);
        const intent = request.message.slice(0, 80);
        // 工具执行期间前端要能看到"正在查什么"，否则这段几十秒是空白的
        emit?.({ type: "step", step: { id: "react-active", label: toolLabel(decision.tool), detail: "正在读取真实数据…", status: "running" } });
        try {
          const result = await rawToolExecutor(decision);
          recordDecisionOutcome(agent, decision.tool, argsSummary, intent, {
            success: true,
            summary: result.slice(0, 200),
            durationMs: Date.now() - startTime,
          });
          return result;
        } catch (error) {
          recordDecisionOutcome(agent, decision.tool, argsSummary, intent, {
            success: false,
            summary: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startTime,
          });
          throw error;
        }
      };
      const { finalDecision, steps } = await reactLoop(request, toolExecutor, agentContext, 5, emit
        ? (decision, observation, index, failed) => {
            emit({ type: "step", step: { id: `react-${index}`, label: toolLabel(decision.tool), detail: observation.slice(0, 60) + (observation.length > 60 ? "..." : ""), status: failed ? "failed" : "done" } });
          }
        : undefined, emit
        ? (delta) => emit({ type: "content_delta", delta })
        : undefined);

      // 如果 LLM 最终选择了 respond（综合回答），优先使用 LLM 的回答内容
      // 只有当 LLM 没有调用 respond 时，才用最后一步的数据渲染丰富结果
      if (finalDecision.tool === "respond") {
        responseMessage = await renderLiveDecision(finalDecision, request.message);
      } else {
        const lastStepWithData = steps.filter((s) => s.observation).pop();
        const renderDecision = lastStepWithData?.decision ?? finalDecision;
        responseMessage = await renderLiveDecision(renderDecision, request.message);
      }

      // 添加 ReAct 推理步骤展示
      if (steps.length > 1) {
        const reactSteps: RunStep[] = steps
          .filter((s) => s.decision.tool !== "respond")
          .map((s, i) => ({
            id: `react-${i}`,
            label: toolLabel(s.decision.tool),
            detail: s.observation.slice(0, 60) + (s.observation.length > 60 ? "..." : ""),
            status: s.failed ? "failed" as const : "done" as const,
          }));
        if (reactSteps.length) {
          responseMessage.steps = [...reactSteps, ...(responseMessage.steps ?? [])];
        }
      }

      if (!responseMessage.followUps?.length && responseMessage.artifact?.kind !== "approval" && responseMessage.artifact?.kind !== "automation") {
        const followUps = decisionFollowUps(finalDecision, request.message);
        if (followUps.length) responseMessage.followUps = followUps;
      }
    } catch (error) {
      // 真实模式下不允许伪造回答：模型调用失败必须原样暴露给用户。
      // 以前的实现会静默降级到确定性兜底，界面看着有回答，其实不是模型输出的。
      const reason = error instanceof Error ? error.message : String(error);
      console.error("LLM 对话失败（真实模式，不再降级）:", reason);
      throw new Error(`大模型调用失败：${reason}`);
    }
  } else {
    // 演示模式，或真实模式下尚未配置大模型。
    // 这里走的是「关键词规则选工具 + 真实数据渲染」：数据仍然取自真实平台，
    // 只有"选哪个查询"是规则决定的，不构成编造，因此保留这条降级路径。
    responseMessage = await fallbackDecision(request, agentContext);
  }

  // 智能视觉增强：检测文本中的数据/结论/趋势模式，自动生成可视化 artifact
  // 对所有响应都尝试进行视觉增强（除了已明确有非 suggestions artifact 的情况）
  const existingArtifact = responseMessage.artifact;
  if (!existingArtifact || existingArtifact.kind === "suggestions") {
    const visualArtifact = tryBuildVisualArtifact(responseMessage.content, existingArtifact);
    if (visualArtifact) {
      responseMessage = { ...responseMessage, artifact: visualArtifact };
    }
  }

  // 异步提取并保存记忆（不阻塞响应）
  void extractAndSaveMemory(request, responseMessage);

  return { message: responseMessage, runId: randomUUID() };
}

// ─── 辅助函数 ─────────────────────────────────────────────────

function toolLabel(tool: AgentDecision["tool"]): string {
  const labels: Record<string, string> = {
    get_shop_info: "查询店铺信息",
    get_sales_overview: "查询销售数据",
    get_order_summary: "查询订单数据",
    get_gmv_summary: "查询 GMV",
    get_refund_summary: "查询退款数据",
    list_products: "查询商品列表",
    explain_product_operations: "检查商品操作能力",
    generate_operations_report: "生成经营报告",
    prepare_inventory_update: "准备库存修改",
    prepare_price_update: "准备价格修改",
    create_readonly_automation: "创建自动任务",
    get_workflow_status: "查询任务状态",
    start_supplier_publish_workflow: "创建供应商上架任务",
    start_flash_sale_workflow: "创建秒杀任务",
    get_kol_bridge_status: "检查达人插件",
    list_kol_creators: "读取达人库",
    get_kol_stats: "读取建联数据",
    start_kol_outreach_workflow: "创建达人建联任务",
    approve_workflow: "确认继续任务",
    retry_workflow: "重试任务",
    verify_workflow: "核验任务结果",
  };
  return labels[tool] ?? `执行 ${tool}`;
}

async function fallbackDecision(request: ChatRequest, providedContext?: string): Promise<ChatMessage> {
  let decision: AgentDecision;
  const explicitDecision = inferExplicitDecision(request.message);
  if (explicitDecision) {
    decision = explicitDecision;
  } else if (hasLlmConfiguration()) {
    try {
      const context = providedContext ?? formatMemoryForPrompt(loadMemory()) + intelligenceStore.buildPromptContext(request.message, request.context ?? "general");
      decision = await decideWithLlm(request, context);
    } catch (error) {
      console.warn("LLM routing failed; using deterministic fallback", error);
      decision = inferDecision(request.message);
    }
  } else {
    decision = inferDecision(request.message);
  }

  const msg = await renderLiveDecision(decision, request.message);
  if (!msg.followUps?.length && msg.artifact?.kind !== "approval" && msg.artifact?.kind !== "automation") {
    const followUps = decisionFollowUps(decision, request.message);
    if (followUps.length) msg.followUps = followUps;
  }
  return msg;
}

// 记忆提取节流：记忆是全局共享的，高频对话时避免每次都触发一次完整 LLM 调用占用配额
let lastMemoryExtractionAt = 0;
const MEMORY_EXTRACTION_THROTTLE_MS = 5 * 60 * 1000; // 5 分钟

async function extractAndSaveMemory(request: ChatRequest, response: ChatMessage): Promise<void> {
  // 节流：距上次提取不足 5 分钟则跳过，释放 LLM 配额给主对话流程
  if (Date.now() - lastMemoryExtractionAt < MEMORY_EXTRACTION_THROTTLE_MS) return;
  // 提前设置时间戳，避免 LLM 调用期间并发重复触发
  lastMemoryExtractionAt = Date.now();
  try {
    const messages = [
      ...(request.history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: request.message },
      { role: "assistant", content: response.content },
    ];
    const extracted = await extractMemories(messages);
    const agentCtx = request.context ?? "general";
    for (const pref of extracted.userPreferences) {
      addPreference(pref);
      memoryLayer.addPrivate(agentCtx, pref, ["preference"]);
    }
    for (const insight of extracted.shopInsights) {
      addInsight(insight);
      memoryLayer.addShared(agentCtx, insight, ["insight"]);
    }
    if (extracted.operationSummary) {
      recordOperation(extracted.operationSummary);
      memoryLayer.addPrivate(agentCtx, extracted.operationSummary, ["operation"]);
    }
  } catch {
    // 提取失败则重置时间戳，允许下次重试
    lastMemoryExtractionAt = 0;
  }
}

export async function approveAction(actionId: string): Promise<ActionResponse> {
  const miaoshouAction = getMiaoshouAction(actionId);
  if (miaoshouAction) {
    const { plan, scene, query, history } = miaoshouAction;
    if (miaoshouAction.status === "verification_pending") {
      return {
        actionStatus: "verification_pending",
        message: message("采集写入请求的最终结果仍需核对。系统不会重复提交，请先查询采集箱、发布记录或目标店铺的最新状态。"),
      };
    }
    if (plan.status !== "pending") throw new Error("该审核计划已经处理，不能重复提交。");
    if (new Date(plan.expiresAt).getTime() < Date.now()) {
      saveMiaoshouAction(miaoshouAction, "expired");
      throw new Error("审核计划已过期，请重新发送原指令获取最新计划。");
    }
    saveMiaoshouAction(miaoshouAction, "executing");
    try {
      const result = await runMiaoshouSceneQuery(scene, query, history);
      saveMiaoshouAction(miaoshouAction, "approved");
      const requestId = `miaoshou_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      try {
        recordOperation(`${plan.title}：${plan.diffs.map((diff) => `${diff.target} ${diff.after}`).join("；")}`);
      } catch {
        // 记忆记录失败不影响已经完成的采集操作。
      }
      return {
        message: message(result.content, {
          kind: "receipt",
          actionId,
          title: `${plan.title}已完成`,
          summary: "采集上架接口已经完成本次审核范围内的操作。该审核计划已锁定，不能重复提交。",
          requestId,
          completedAt: new Date().toISOString(),
          diffs: plan.diffs,
        }, createSteps("write"), miaoshouSceneFollowUps(scene)),
      };
    } catch (error) {
      saveMiaoshouAction(miaoshouAction, "verification_pending");
      return {
        actionStatus: "verification_pending",
        message: message(`采集写入请求可能已经生效，但暂时无法确认最终结果：${error instanceof Error ? error.message : "未知错误"}。系统已停止重复提交，请先查询最新状态。`),
      };
    }
  }
  let result;
  try {
    result = await approveTikTokProductWrite(actionId);
  } catch (error) {
    if (error instanceof ActionVerificationPendingError) {
      return { actionStatus: "verification_pending", message: message(error.message) };
    }
    throw error;
  }
  if (!result) throw new Error("找不到该执行计划，可能已经失效。");

  // 反思：评估操作结果
  let reflectionNote = "";
  try {
    const beforeDesc = result.plan.diffs.map((d) => `${d.target} ${d.field}: ${d.before}`).join("；");
    const afterDesc = result.plan.diffs.map((d) => `${d.target} ${d.field}: ${d.after}`).join("；");
    const reflection = await reflectOnResult(result.plan.title, beforeDesc, afterDesc);
    if (reflection.risks.length || reflection.suggestion) {
      reflectionNote = reflection.suggestion
        ? ` Agent 评估：${reflection.risks.length ? `存在风险（${reflection.risks.join("、")}）。` : ""}${reflection.suggestion}`
        : "";
    }
  } catch {
    // 反思失败不影响主流程
  }

  // 记录操作到长期记忆
  try {
    recordOperation(`${result.plan.title}：${result.plan.diffs.map((d) => `${d.target} ${d.field} ${d.before}→${d.after}`).join("；")}`);
  } catch { /* ignore */ }

  const receiptContent = `操作已提交 TikTok Shop，并已回读验证最新值。${reflectionNote}`;
  return {
    message: message(receiptContent, {
      kind: "receipt",
      actionId,
      title: `${result.plan.title}已完成`,
      summary: `成功完成 ${result.plan.diffs.length} 项明确变更。审批计划已锁定，不能重复提交。`,
      requestId: result.requestId,
      completedAt: result.completedAt,
      diffs: result.plan.diffs,
    }),
    dashboard: result.dashboard,
  };
}

export function rejectAction(actionId: string): ActionPlan {
  const miaoshouAction = getMiaoshouAction(actionId);
  if (miaoshouAction) {
    if (miaoshouAction.plan.status !== "pending") throw new Error("该审核计划已经处理。");
    saveMiaoshouAction(miaoshouAction, "rejected");
    return miaoshouAction.plan;
  }
  const plan = rejectTikTokProductWrite(actionId);
  if (!plan) throw new Error("找不到该执行计划。");
  return plan;
}

// 测试专用导出:暴露路由纯函数,供单元测试验证意图识别与文本提取
export const __test = {
  extractQuantity,
  extractPrice,
  extractSkus,
  extractDays,
  asksForBestSellers,
  asksForProductOperation,
  inferExplicitDecision,
  inferDecision,
  inferFastConversationResponse,
  inferFastReadDecision,
  inferLiveProductWrite,
  workflowReference,
  asksAboutWorkflow,
};

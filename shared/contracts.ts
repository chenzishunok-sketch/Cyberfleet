import type { AgentContext } from "./digital-employees.ts";

export type Trend = "up" | "down" | "flat";

export interface StoreContext {
  id: string;
  name: string;
  region: string;
  currency: string;
  timezone: string;
  connected: boolean;
}

export interface Metric {
  label: string;
  value: string;
  delta: string;
  trend: Trend;
  helper?: string;
}

export interface SalesPoint {
  date: string;
  sales: number;
  previous: number;
  orders: number;
}

export interface ProductRow {
  id: string;
  sku: string;
  title: string;
  image: string;
  revenue: string;
  units: number;
  stock: number;
  daysOfStock?: number;
  status: "healthy" | "low" | "risk";
}

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  scope: string;
  nextRun: string;
  lastResult: string;
  enabled: boolean;
  kind: "report" | "alert";
}

/**
 * 调度器里真实运行的定时任务。
 *
 * 这是定时任务的唯一数据源（/api/scheduler/tasks）。dashboard 快照里曾经还有一个
 * `automations` 字段，但它永远是空数组，界面读它才会出现「后台 5 个任务、界面 0 项」。
 * 那个字段已删除，避免再被误当成任务列表。
 */
export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  /** 5 字段 cron：分 时 日 月 周 */
  cron: string;
  type: "read_only_query" | "proactive_inspection" | "report_generation" | "learning_reflection";
  status: "active" | "paused" | "error";
  agent?: string;
  lastRunAt?: string;
  lastResult?: { success: boolean; summary: string; insight?: string };
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRunLog {
  taskId: string;
  taskName: string;
  runAt: string;
  success: boolean;
  summary: string;
  insight?: string;
  durationMs: number;
}

export interface ActivityItem {
  id: string;
  title: string;
  meta: string;
  status: "success" | "waiting" | "running" | "failed";
}

export interface DashboardSnapshot {
  dataSource: "tiktok" | "unavailable";
  store: StoreContext;
  metrics: Metric[];
  salesSeries: SalesPoint[];
  products: ProductRow[];
  activity: ActivityItem[];
  alerts: Array<{ id: string; level: "warning" | "info"; text: string }>;
  dataAsOf: string;
}

export interface RunStep {
  id: string;
  label: string;
  detail: string;
  status: "done" | "running" | "pending" | "failed";
}

export interface FieldDiff {
  target: string;
  field: string;
  before: string;
  after: string;
}

export type ActionPlanStatus = "pending" | "executing" | "verification_pending" | "approved" | "rejected" | "expired";

export interface ActionPlan {
  id: string;
  tool: "inventory.update" | "price.update" | "product.activate" | "product.deactivate" | "automation.create" | "miaoshou.operation";
  title: string;
  summary: string;
  store: string;
  risk: "low" | "medium" | "high";
  diffs: FieldDiff[];
  impactCount?: number;
  expiresAt: string;
  status: ActionPlanStatus;
  planHash: string;
}

export type WorkflowStatus =
  | "draft"
  | "running"
  | "waiting_input"
  | "waiting_confirmation"
  | "verification_pending"
  | "completed"
  | "failed"
  | "cancelled";

type WorkflowStepStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowStep {
  id: string;
  label: string;
  status: WorkflowStepStatus;
  detail?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowShopOption {
  id: string;
  name: string;
  site: string;
  /** 采集数字店铺 ID（TikTok OAuth 密文店铺需要先解析） */
  miaoshouShopId?: string;
}

export interface ChatImageAttachment {
  id: string;
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataUrl: string;
}

export interface SourcingCandidate {
  itemId: string;
  productUrl: string;
  title: string;
  imageUrl: string;
  supplierName: string;
  supplierLocation: string;
  supplierType: string;
  shopYears?: number;
  supplierScore?: number;
  recommendationScore: number;
  purchasePriceCny: number;
  minimumOrderQuantity: number;
  salesCount: number;
  ordersCount: number;
  repurchaseRate?: number;
  stock?: number;
  weightKg: number;
  weightEstimated: boolean;
  domesticShippingCny: number;
  /** 采购价 + 国内运费。跨境物流、平台佣金与税项不在此列——定价环节单独处理。 */
  landedCostCny: number;
  tags: string[];
  warnings: string[];
}

export interface ProductPublishWorkflowRun {
  id: string;
  type: "product_publish";
  title: string;
  status: WorkflowStatus;
  /** 1688 货源链接；从聊天「发布」意图基于采集箱商品创建的任务可能没有 */
  sourceUrl?: string;
  targetPlatform: "tiktok";
  shopId?: string;
  shopName?: string;
  shopSite?: string;
  /** 采集数字店铺 ID，由 OAuth 密文解析而来；采集 API 只接受数字 ID */
  miaoshouShopId?: string;
  targetLanguage?: string;
  sourceItemId?: string;
  commonDetailId?: string;
  platformDetailId?: string;
  tiktokProductId?: string;
  claimedToShop?: boolean;
  categoryId?: string;
  productTitle?: string;
  publishRequestId?: string;
  publishPrice?: number;
  currency?: string;
  packageDimensions?: { length: number; width: number; height: number };
  requestedTitle?: string;
  requestedDescription?: string;
  editPreview?: {
    skuCount: number;
    changes: Array<{ field: string; before: string; after: string }>;
  };
  confirmationKind?: "workflow_start" | "product_edit" | "product_publish";
  steps: WorkflowStep[];
  warnings: string[];
  readinessIssues?: string[];
  requiredInput?:
    | {
        kind: "shop";
        prompt: string;
        options: WorkflowShopOption[];
      }
    | {
        kind: "product_data";
        prompt: string;
        issues: string[];
      }
    | {
        kind: "product_edit";
        prompt: string;
        missing: Array<"publishPrice" | "packageDimensions">;
      };
  error?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlashSaleSku {
  id: string;
  sellerSku?: string;
  availableStock: number;
  /** 商品当前售价，用来判断秒杀价是否真的比原价低 */
  salePrice?: string;
}

/**
 * 活动商品层级。
 * - PRODUCT：整品一个秒杀价，商品全部 SKU 共用一个活动价（官方接口真机验证过的路径）
 * - VARIATION：按 SKU 分别定价，适合同一商品不同规格要给不同折扣的情况
 */
export type FlashSalePricingLevel = "PRODUCT" | "VARIATION";

export interface FlashSaleWorkflowRun {
  id: string;
  type: "flash_sale";
  title: string;
  status: WorkflowStatus;
  productId: string;
  productTitle?: string;
  shopId?: string;
  shopName?: string;
  shopRegion?: string;
  activityTitle: string;
  startAt: string;
  endAt: string;
  priceAmount: string;
  currency: string;
  pricingLevel: FlashSalePricingLevel;
  skuSelection: { mode: "all" } | { mode: "include"; skuIds: string[] };
  skuQuantityLimit: number;
  quantityPerUser: number;
  selectedSkus: FlashSaleSku[];
  activityId?: string;
  activityStatus?: string;
  createRequestId?: string;
  bindRequestId?: string;
  confirmationKind?: "flash_sale";
  steps: WorkflowStep[];
  warnings: string[];
  error?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KolCreator {
  id: string;
  oecId?: string;
  nickname: string;
  handle?: string;
  followerCount: number;
  category?: string;
  avatar?: string;
}

export interface KolStats {
  totalInvited: number;
  success: number;
  pending: number;
  failed: number;
  totalCreators: number;
  tasksTotal: number;
}

export interface KolOutreachWorkflowRun {
  id: string;
  type: "kol_outreach";
  title: string;
  status: WorkflowStatus;
  shopId?: string;
  filters: {
    category?: string;
    minFollowers?: number;
  };
  commissionRate: number;
  message?: string;
  batchSize: number;
  requestedTarget: number;
  totalTarget: number;
  freeSample: boolean;
  matchedCreators: KolCreator[];
  selectedCreatorIds: string[];
  result?: { success: number; failed: number; skipped: number; details?: string };
  statsBefore?: KolStats;
  statsAfter?: KolStats;
  confirmationKind?: "kol_outreach";
  steps: WorkflowStep[];
  warnings: string[];
  requiredInput?: {
    kind: "kol_bridge" | "creator_data";
    prompt: string;
  };
  error?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export type BusinessWorkflowRun = ProductPublishWorkflowRun | FlashSaleWorkflowRun | KolOutreachWorkflowRun | DagWorkflowRun;

// ─── DAG 工作流类型 ────────────────────────────────────────────

/** DAG 节点类型 */
export type DagNodeType = "task" | "gate" | "parallel" | "join" | "human_gate";

/** DAG 节点定义 */
export interface DagNodeDef {
  /** 节点唯一标识 */
  id: string;
  /** 节点类型 */
  type: DagNodeType;
  /** 显示标签 */
  label: string;
  /** 负责执行的 Agent 角色 */
  agent?: string;
  /** 任务节点：执行器名称（在 executor 注册表中查找） */
  executor?: string;
  /** 门控节点：条件表达式，决定走哪条边 */
  condition?: string;
  /** 并行节点：并行分支的节点 ID 列表 */
  branches?: string[][];
  /** 人工确认节点：确认类型 */
  confirmationKind?: string;
  /** 人工确认节点：提示文案 */
  prompt?: string;
}

/** DAG 边定义 */
export interface DagEdgeDef {
  /** 源节点 ID */
  from: string;
  /** 目标节点 ID */
  to: string;
  /** 条件表达式（仅 gate 节点的出边需要） */
  condition?: string;
}

/** DAG 工作流定义（模板） */
export interface DagDefinition {
  /** 工作流类型标识 */
  type: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 所有节点 */
  nodes: DagNodeDef[];
  /** 所有边 */
  edges: DagEdgeDef[];
  /** 入口节点 ID */
  entry: string;
}

/** DAG 节点运行时状态 */
export type DagNodeState = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting";

/** DAG 节点运行时实例 */
export interface DagNodeInstance {
  id: string;
  state: DagNodeState;
  detail?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  /** 节点输出数据（传给后续节点） */
  output?: Record<string, unknown>;
}

/** DAG 工作流运行实例 */
export interface DagWorkflowRun {
  id: string;
  type: "dag";
  title: string;
  status: WorkflowStatus;
  /** DAG 定义快照（运行时不可变） */
  definition: DagDefinition;
  /** 节点运行时状态 */
  nodeStates: DagNodeInstance[];
  /** 输入参数 */
  input: Record<string, unknown>;
  /** 当前活跃节点（正在执行或等待确认） */
  activeNodeId?: string;
  /** 等待确认的信息 */
  pendingConfirmation?: {
    nodeId: string;
    kind: string;
    prompt: string;
  };
  /** 执行结果 */
  result?: {
    success: boolean;
    summary: string;
    data?: Record<string, unknown>;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowHistoryItem {
  id: number;
  runId: string;
  stepId?: string;
  eventType: "created" | "updated" | "migrated";
  status: string;
  detail?: string;
  error?: string;
  snapshot: BusinessWorkflowRun;
  createdAt: string;
}

export interface WorkflowListResponse {
  runs: BusinessWorkflowRun[];
}

export type MessageArtifact =
  | {
      kind: "analysis";
      headline: string;
      metrics: Metric[];
      series: SalesPoint[];
      currency: string;
      insights: Array<{ label: string; text: string; tone: "positive" | "warning" | "neutral" }>;
      source: string;
    }
  | {
      kind: "products";
      headline: string;
      summary: string;
      products: ProductRow[];
      totalCount?: number;
      source: string;
    }
  | {
      kind: "records";
      headline: string;
      summary: string;
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, string>>;
      source: string;
      emptyLabel?: string;
    }
  | {
      kind: "sourcing_candidates";
      headline: string;
      summary: string;
      queryImageUrl: string;
      totalCount: number;
      candidates: SourcingCandidate[];
      /** 口径说明：告诉用户这些数字包含哪些成本、不包含哪些，避免被当成到手利润。 */
      costNote: string;
      source: string;
    }
  | {
      kind: "approval";
      plan: ActionPlan;
    }
  | {
      kind: "receipt";
      actionId: string;
      title: string;
      summary: string;
      requestId: string;
      requestLabel?: string;
      completedAt: string;
      diffs: FieldDiff[];
      verificationLabel?: string;
    }
  | {
      kind: "report";
      title: string;
      period: string;
      executiveSummary: string;
      sections: Array<{ title: string; body: string; stat?: string }>;
      source: string;
    }
  | {
      kind: "automation";
      automation: Automation;
      conditions: string[];
    }
  | {
      kind: "suggestions";
      prompts: string[];
    }
  | {
      kind: "workflow";
      run: BusinessWorkflowRun;
    }
  | {
      kind: "visual_analysis";
      headline: string;
      summary: string;
      sections: VisualSection[];
      source?: string;
    };

export type VisualSection =
  | {
      type: "callout";
      tone: "conclusion" | "judgment" | "recommendation" | "warning" | "info";
      title?: string;
      body: string;
    }
  | {
      type: "data_highlights";
      items: Array<{ label: string; value: string; unit?: string; trend?: "up" | "down" | "flat"; delta?: string; helper?: string }>;
    }
  | {
      type: "bar_chart";
      title?: string;
      items: Array<{ label: string; value: number; valueLabel: string; delta?: string }>;
      unit?: string;
    }
  | {
      type: "donut_chart";
      title?: string;
      segments: Array<{ label: string; value: number; color?: string }>;
      centerLabel?: string;
      centerValue?: string;
    }
  | {
      type: "radar_chart";
      title?: string;
      items: Array<{ label: string; value: number; max: number }>;
    }
  | {
      type: "sparkline_row";
      title?: string;
      items: Array<{ label: string; data: number[]; value: string; delta?: string }>;
    }
  | {
      type: "comparison_table";
      title?: string;
      columns?: Array<{ key: "primary" | "secondary"; label: string }>;
      items: Array<{ label: string; primaryValue: string; secondaryValue?: string; highlight?: boolean }>;
    }
  | {
      type: "insights";
      items: Array<{ tone: "positive" | "warning" | "neutral"; label: string; text: string }>;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  artifact?: MessageArtifact;
  steps?: RunStep[];
  followUps?: string[];
}

export interface ChatRequest {
  message: string;
  storeId: string;
  mode?: "analysis" | "execute";
  context?: AgentContext;
  attachments?: ChatImageAttachment[];
  history?: Array<Pick<ChatMessage, "role" | "content" | "artifact">>;
}

export interface ChatResponse {
  message: ChatMessage;
  runId: string;
}

// ─── 对话流式事件（SSE） ─────────────────────────────────────
// 推送顺序：step*(0..N) → content_delta*(0..M) → final | error
export type ChatStreamEvent =
  | { type: "step"; step: RunStep }
  | { type: "content_delta"; delta: string }
  // 清空已推送的流式正文：模型先回了一句「已分析」被判定为空壳、打回重写时，
  // 前端要把那半句擦掉再重新打字，否则两段会接在一起变成「已分析结论是…」
  | { type: "content_reset" }
  | { type: "final"; response: ChatResponse }
  | { type: "error"; message: string };

export type ChatStreamEmitter = (event: ChatStreamEvent) => void;

export interface ActionResponse {
  message: ChatMessage;
  dashboard?: DashboardSnapshot;
  actionStatus?: ActionPlanStatus;
}

export type TikTokCapabilityStatus =
  | "ready"
  | "confirmation_required"
  | "reauthorization_required"
  | "creator_authorization_required"
  | "eligibility_check_required"
  | "region_unavailable";

export interface TikTokOperationCapability {
  id: string;
  title: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scopeKeys: string[];
  effect: "query" | "task" | "write" | "destructive";
  status: TikTokCapabilityStatus;
  officialUrl: string;
}

export interface TikTokScopeCapability {
  key: string;
  label: string;
  sceneId: string;
  grantedInConsole: boolean;
  grantedInToken: boolean;
  status: TikTokCapabilityStatus;
  operationCount: number;
  note?: string;
}

export interface TikTokSceneCapability {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  status: TikTokCapabilityStatus;
  operationCount: number;
  queryCount: number;
  protectedCount: number;
  scopeKeys: string[];
  prompts: string[];
  note?: string;
  operations: TikTokOperationCapability[];
}

export interface TikTokCapabilitiesResponse {
  source: string;
  catalogAsOf: string;
  shopRegion?: string;
  totalOperations: number;
  sellerOperations: number;
  creatorOperations: number;
  readyQueries: number;
  protectedOperations: number;
  scenes: TikTokSceneCapability[];
  scopes: TikTokScopeCapability[];
  excludedScopes: Array<{ key: string; label: string; reason: string }>;
  warnings: string[];
}

// ─── TikTok 店铺绑定（多卖家账号 / 多国家店铺）───────────────

/** 一次 OAuth 授权 = 一个卖家账号绑定；其名下多国店铺随 shops 一起进入系统 */
export interface TikTokBindingSummary {
  grantId: string;
  sellerName?: string;
  sellerRegion?: string;
  /** connected: access token 有效；expired: access 过期但 refresh 仍可自动续；invalid: 需重新授权 */
  status: "connected" | "expired" | "invalid";
  /** access token 过期时间（unix 秒） */
  expiresAt?: number;
  shops: Array<{ id: string; name: string; region: string }>;
  /** 该绑定内被选为当前操作的店铺 */
  selectedShopId?: string;
  authorizedAt: string;
}

/** TikTok 连接状态：前后端唯一权威定义（服务端 tiktok-auth.ts 与前端 api.ts 共同消费） */
export interface TikTokConnectionStatus {
  status: "not_configured" | "ready_to_authorize" | "shop_selection_required" | "connected" | "expired";
  connected: boolean;
  shopName?: string;
  region?: string;
  expiresAt?: number;
  shops?: Array<{ id: string; name: string; region: string }>;
  /** 全部已绑定卖家账号（多店铺绑定管理）；旧字段 shopName/region 描述当前选中店铺 */
  bindings?: TikTokBindingSummary[];
}

// ─── 大模型供应商绑定（多服务商 / 全局切换）──────────────────

export interface LlmProviderSummary {
  id: string;
  name: string;
  baseUrl: string;
  /** 脱敏后的 API Key（前2+***+后2），仅用于回显确认 */
  apiKeyMasked: string;
  model: string;
  /** 可选快速模型：意图路由/摘要等轻任务用，留空=主模型 */
  fastModel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProvidersOverview {
  providers: LlmProviderSummary[];
  activeId: string | null;
  /** 当前生效来源：激活供应商 / .env / 未配置（规则路由） */
  source: "provider" | "env" | "missing";
  connected: boolean;
  /** 当前生效服务名（供应商名或 ".env 配置"）与模型 */
  name?: string;
  model?: string;
  /** 当前生效服务的 Base URL（供应商或 .env） */
  baseUrl?: string;
  /** 当前生效的快速模型（与主模型相同时不返回） */
  fastModel?: string;
}

export interface LlmProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  reply?: string;
}

// ─── Skill 管理系统 ────────────────────────────────────────────

export interface SkillConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  placeholder?: string;
}

type SkillCategory = "collection" | "fulfillment" | "analytics" | "custom";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  category: SkillCategory;
  configFields: SkillConfigField[];
  builtin: boolean;
  scenes: string[];
}

export interface SkillStatus {
  id: string;
  installed: boolean;
  enabled: boolean;
  configured: boolean;
  config: Record<string, string>;
  connectionState?: "connected" | "configured" | "not_configured";
  configSource?: "oauth" | "skill" | "env" | "none";
}

export interface SkillsCatalogResponse {
  skills: SkillDefinition[];
  statuses: SkillStatus[];
}

/** 连接器测试连接结果（真实调用一次上游业务接口） */
export interface SkillConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

// ─── 办公室实时状态（办公室页面消费的唯一数据契约）────────────

export interface OfficeAgentStatus {
  /** 对应 DigitalEmployee.id / 场景 AGENT_ROSTER.id */
  id: AgentContext;
  name: string;
  /** 后端运行时状态：idle 空闲 / working 工作中 / waiting 等待用户确认 */
  state: "idle" | "working" | "waiting";
  currentTask?: string;
  /** 员工就绪度（静态元数据） */
  readiness: "ready" | "foundation" | "planned";
}

export interface OfficeStats {
  /** 任务队列中正在执行的任务数 */
  running: number;
  /** 排队等待执行的任务数 */
  queued: number;
  /** 今日完成的业务任务数（队列任务 + 工作流） */
  completedToday: number;
  /** 等待人工确认的审批数（行动审批 + 工作流确认） */
  pendingApprovals: number;
  /** 当前正在工作的 Agent 数 */
  activeAgents: number;
  /** 就绪（ready）员工数 */
  readyAgents: number;
  /** 规划中（planned）员工数 */
  plannedAgents: number;
}

export interface OfficeSnapshot {
  agents: OfficeAgentStatus[];
  stats: OfficeStats;
  generatedAt: string;
}

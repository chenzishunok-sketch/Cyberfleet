import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgePercent,
  BarChart3,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Download,
  ExternalLink,
  FileBarChart,
  FileText,
  Globe2,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  PackageCheck,
  Plus,
  Puzzle,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  ShoppingBag,
  Store,
  TrendingUp,
  Truck,
  Warehouse,
  Workflow,
} from "lucide-react";
import type {
  Automation,
  DashboardSnapshot,
  SkillsCatalogResponse,
  SkillDefinition,
  SkillStatus,
  TikTokCapabilitiesResponse,
  TikTokCapabilityStatus,
  TikTokOperationCapability,
  TikTokSceneCapability,
} from "../../shared/contracts";
import { WorkflowCenter } from "./WorkflowCenter";
import type { TikTokConnectionStatus } from "../api";
import type { ViewId } from "./Sidebar";
import type { LucideIcon } from "lucide-react";

interface PageProps {
  dashboard: DashboardSnapshot;
  connections: { llm: boolean; tiktok: boolean };
  tiktokConnection: TikTokConnectionStatus;
  onToggleAutomation: (id: string) => void;
  onOpenChat: (prompt?: string) => void;
  onSelectTikTokShop: (shopId: string) => Promise<void>;
  capabilities?: TikTokCapabilitiesResponse;
  capabilitiesError?: string;
  selectedSceneId?: string;
  onSceneSelect: (sceneId: string) => void;
  skillsCatalog?: SkillsCatalogResponse;
  skillsError?: string;
  onRetrySkills: () => void;
  onOpenSkillManager: () => void;
  onOpenConversationManager: () => void;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>
  );
}

function downloadText(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AutomationRow({ automation, onToggle }: { automation: Automation; onToggle: () => void }) {
  return (
    <div className="automation-row">
      <span className={`large-list-icon large-list-icon--${automation.kind}`}>{automation.kind === "alert" ? <AlertTriangle size={18} /> : <FileBarChart size={18} />}</span>
      <div className="automation-primary"><strong>{automation.name}</strong><span>{automation.scope}</span></div>
      <div className="list-data"><span>运行规则</span><strong>{automation.schedule}</strong></div>
      <div className="list-data"><span>下次运行</span><strong>{automation.nextRun}</strong></div>
      <div className="list-data"><span>最近结果</span><strong className="success-text"><CheckCircle2 size={14} />{automation.lastResult}</strong></div>
      <button className={`switch ${automation.enabled ? "switch--on" : ""}`} role="switch" aria-checked={automation.enabled} aria-label={`${automation.enabled ? "停用" : "启用"}${automation.name}`} onClick={onToggle}><span /></button>
    </div>
  );
}

function AutomationsPage({ dashboard, onToggleAutomation, onOpenChat }: PageProps) {
  const [workflowTab, setWorkflowTab] = useState<"monitor" | "templates" | "builder">("monitor");
  const [query, setQuery] = useState("");
  const automations = dashboard.automations.filter((automation) => `${automation.name} ${automation.scope} ${automation.schedule}`.toLowerCase().includes(query.trim().toLowerCase()));
  const runningCount = dashboard.automations.filter((automation) => automation.enabled).length;
  const completedRuns = dashboard.activity.filter((activity) => activity.title.includes("自动") || activity.meta.includes("自动任务"));
  const successfulRuns = completedRuns.filter((activity) => activity.status === "success").length;
  return (
    <div className="page-content">
      <PageHeader eyebrow="WORKFLOWS" title="工作流" description="监控 Agent 执行、复用业务模板，并编排数字员工协作。" />
      <WorkflowCenter activeTab={workflowTab} onTabChange={setWorkflowTab} onOpenChat={onOpenChat} />
      {workflowTab === "monitor" && <>
        <div className="section-heading workflow-scheduled-heading"><div><h2>定时任务</h2><span>{automations.length} 项</span></div><button className="secondary-button" onClick={() => onOpenChat("创建一个新的自动运营任务")}><Plus size={16} />新建定时任务</button></div>
        <div className="summary-band">
          <div><span>运行中</span><strong>{runningCount}</strong></div><div><span>已有运行记录</span><strong>{completedRuns.length}</strong></div><div><span>成功率</span><strong>{completedRuns.length ? `${Math.round((successfulRuns / completedRuns.length) * 100)}%` : "--"}</strong></div><div><span>节省时间</span><strong>--</strong></div>
        </div>
        <div className="list-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" /></div></div>
        <div className="automation-table">{automations.map((automation) => <AutomationRow key={automation.id} automation={automation} onToggle={() => onToggleAutomation(automation.id)} />)}</div>
      </>}
    </div>
  );
}

function ReportsPage({ dashboard, onOpenChat }: PageProps) {
  const description = dashboard.dataSource === "tiktok"
    ? "报告只使用当前 TikTok Shop 真实数据，生成后可从对话中下载。"
    : dashboard.dataSource === "demo"
      ? "当前为演示模式，生成的报告不会代表真实店铺经营情况。"
      : "连接 TikTok Shop 后即可生成真实经营报告。";
  return (
    <div className="page-content">
      <PageHeader eyebrow="REPORTS" title="经营报告" description={description} action={<button className="primary-button" onClick={() => onOpenChat("生成一份近 7 天经营报告")}><Plus size={16} />生成报告</button>} />
      <div className="page-empty"><FileText size={25} /><h2>暂无已保存报告</h2><p>{dashboard.store.name} 还没有保存过经营报告。</p><button className="secondary-button" onClick={() => onOpenChat("生成一份近 7 天经营报告")}>生成第一份报告<ArrowRight size={15} /></button></div>
    </div>
  );
}

function ActivityPage({ dashboard }: PageProps) {
  const [query, setQuery] = useState("");
  const activities = useMemo(() => dashboard.activity, [dashboard.activity]);
  const filteredActivities = activities.filter((item) => `${item.title} ${item.meta} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const exportActivity = () => {
    const rows = [["执行内容", "执行编号", "时间", "结果"], ...activities.map((item) => [item.title, `run_${item.id.replace("act-", "20260727_")}`, item.meta, "成功"])];
    downloadText("execution-audit.csv", `\ufeff${rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n")}`, "text/csv;charset=utf-8");
  };
  return (
    <div className="page-content">
      <PageHeader eyebrow="AUDIT LOG" title="执行记录" description="查询、审批和店铺变更都保留完整审计记录。" action={<button className="secondary-button" onClick={exportActivity}><Download size={16} />导出记录</button>} />
      <div className="list-toolbar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索执行记录或请求编号" aria-label="搜索执行记录" /></div></div>
      <div className="audit-table">
        <div className="audit-row audit-row--header"><span>执行内容</span><span>发起人</span><span>类型</span><span>时间</span><span>结果</span></div>
        {filteredActivities.map((item) => { const isWrite = item.title.includes("调整"); return <div className="audit-row" key={item.id}><div className="audit-title"><span className={`audit-icon ${isWrite ? "audit-icon--write" : ""}`}>{isWrite ? <RefreshCcw size={16} /> : <Activity size={16} />}</span><div><strong>{item.title}</strong><small className="mono">run_{item.id}</small></div></div><span>{dashboard.store.name}</span><span className="type-chip">{isWrite ? "写操作" : "查询"}</span><span>{item.meta.split(" · ")[0]}</span><span className="success-text"><CheckCircle2 size={14} />成功</span></div>; })}
        {filteredActivities.length === 0 && <div className="page-empty page-empty--compact"><Activity size={23} /><h2>暂无真实执行记录</h2><p>查询和操作日志将在后端审计存储接通后显示。</p></div>}
      </div>
    </div>
  );
}

const skillIcons: Record<string, LucideIcon> = {
  "tiktok-shop": ShoppingBag,
  miaoshou: Boxes,
};

const sceneIcons: Record<string, LucideIcon> = {
  market: TrendingUp,
  analytics: BarChart3,
  catalog: ShoppingBag,
  global: Globe2,
  orders: PackageCheck,
  fulfillment: Truck,
  logistics: Warehouse,
  aftersales: RefreshCcw,
  finance: CircleDollarSign,
  promotions: BadgePercent,
  shop: Store,
};

const statusLabels: Record<TikTokCapabilityStatus, { label: string; description: string }> = {
  ready: { label: "可直接查询", description: "当前卖家令牌可直接调用" },
  confirmation_required: { label: "执行前确认", description: "涉及店铺变更，提交前必须人工确认" },
  reauthorization_required: { label: "需重新授权", description: "控制台已开通，但当前令牌尚未包含该权限" },
  creator_authorization_required: { label: "需达人授权", description: "该接口需要 creator access token，卖家令牌不能代替" },
  eligibility_check_required: { label: "需资格校验", description: "调用前需确认卖家类型、市场或全球商品资格" },
  region_unavailable: { label: "当前地区不可用", description: "该接口不支持当前店铺所在地区" },
};

function CapabilityStatus({ status, scope = false }: { status: TikTokCapabilityStatus; scope?: boolean }) {
  const meta = statusLabels[status];
  const label = scope && status === "ready" ? "令牌已授权" : meta.label;
  return <span className={`capability-status capability-status--${status}`} title={meta.description}>{status === "ready" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{label}</span>;
}

function operationType(operation: TikTokOperationCapability): string {
  if (operation.effect === "query") return "查询";
  if (operation.effect === "task") return "异步任务";
  if (operation.effect === "destructive") return "高风险操作";
  return "写操作";
}

function CapabilitiesPage({ capabilities, capabilitiesError, selectedSceneId, onSceneSelect, onOpenChat }: PageProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "protected" | "limited">("all");
  const selectedScene = useMemo<TikTokSceneCapability | undefined>(() => {
    if (!capabilities) return undefined;
    return capabilities.scenes.find((scene) => scene.id === selectedSceneId) ?? capabilities.scenes[0];
  }, [capabilities, selectedSceneId]);
  const sceneScopes = useMemo(() => {
    if (!capabilities || !selectedScene) return [];
    return capabilities.scopes.filter((scope) => selectedScene.scopeKeys.includes(scope.key));
  }, [capabilities, selectedScene]);
  const operations = useMemo(() => {
    if (!selectedScene) return [];
    const needle = query.trim().toLowerCase();
    return selectedScene.operations.filter((operation) => {
      const matchesQuery = !needle || `${operation.title} ${operation.path} ${operation.scopeKeys.join(" ")}`.toLowerCase().includes(needle);
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "ready" && operation.status === "ready")
        || (statusFilter === "protected" && operation.status === "confirmation_required")
        || (statusFilter === "limited" && operation.status !== "ready" && operation.status !== "confirmation_required");
      return matchesQuery && matchesStatus;
    });
  }, [query, selectedScene, statusFilter]);

  useEffect(() => {
    setQuery("");
    setStatusFilter("all");
  }, [selectedSceneId]);

  if (capabilitiesError) {
    return (
      <div className="page-content">
        <PageHeader eyebrow="API CAPABILITIES" title="API 能力" description="店铺数据仍可使用，但能力目录暂时没有加载成功。" />
        <div className="page-empty"><AlertTriangle size={25} /><h2>无法读取能力目录</h2><p>{capabilitiesError}</p></div>
      </div>
    );
  }

  if (!capabilities || !selectedScene) {
    return (
      <div className="page-content">
        <PageHeader eyebrow="API CAPABILITIES" title="API 能力" description="正在核对当前令牌、店铺地区和官方接口目录。" />
        <div className="page-empty"><LoaderCircle size={25} className="spin" /><h2>正在读取已开通场景</h2></div>
      </div>
    );
  }

  return (
    <div className="page-content capabilities-page">
      <PageHeader
        eyebrow="TIKTOK SHOP API"
        title={selectedScene.label}
        description={selectedScene.description}
        action={<button className="primary-button" onClick={() => onOpenChat(selectedScene.prompts[0])}><MessageSquareText size={16} />在对话中使用</button>}
      />

      <div className="capability-scene-tabs" aria-label="切换 API 场景">
        {capabilities.scenes.map((scene) => <button key={scene.id} className={scene.id === selectedScene.id ? "selected" : ""} onClick={() => onSceneSelect(scene.id)}>{scene.shortLabel}</button>)}
      </div>

      <div className="summary-band capability-summary">
        <div><span>官方接口目录</span><strong>{capabilities.totalOperations}</strong><small>{capabilities.sellerOperations} 个卖家接口</small></div>
        <div><span>当前场景接口</span><strong>{selectedScene.operationCount}</strong><small>{sceneScopes.length} 项权限范围</small></div>
        <div><span>只读查询</span><strong>{selectedScene.queryCount}</strong><small>符合条件时直接读取</small></div>
        <div><span>受保护操作</span><strong>{selectedScene.protectedCount}</strong><small>提交前人工确认</small></div>
      </div>

      {(selectedScene.note || sceneScopes.some((scope) => scope.note)) && (
        <div className="capability-notice"><KeyRound size={17} /><div><strong>使用条件</strong><p>{selectedScene.note ?? sceneScopes.find((scope) => scope.note)?.note}</p></div></div>
      )}

      <section className="capability-section">
        <div className="section-heading"><div><h2>常用指令</h2><span>缺少订单号等必要信息时会先向你确认</span></div></div>
        <div className="scene-prompt-grid">
          {selectedScene.prompts.map((prompt) => <button key={prompt} onClick={() => onOpenChat(prompt)}><span>{prompt}</span><ArrowRight size={15} /></button>)}
        </div>
      </section>

      <section className="capability-section">
        <div className="section-heading"><div><h2>权限范围</h2><span>{sceneScopes.length} 项</span></div></div>
        <div className="scope-list">
          {sceneScopes.map((scope) => (
            <div className="scope-row" key={scope.key}>
              <div><strong>{scope.label}</strong><code>{scope.key}</code>{scope.note && <small>{scope.note}</small>}</div>
              <span className="scope-operation-count">{scope.operationCount} 个接口</span>
              <CapabilityStatus status={scope.status} scope />
            </div>
          ))}
        </div>
      </section>

      <section className="capability-section">
        <div className="section-heading"><div><h2>官方接口</h2><span>{operations.length} / {selectedScene.operations.length}</span></div></div>
        <div className="capability-toolbar">
          <div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索接口名称、路径或权限" aria-label="搜索 API 接口" /></div>
          <div className="capability-filter" aria-label="筛选接口状态">
            {(["all", "ready", "protected", "limited"] as const).map((filter) => (
              <button key={filter} className={statusFilter === filter ? "selected" : ""} onClick={() => setStatusFilter(filter)}>{filter === "all" ? "全部" : filter === "ready" ? "可查询" : filter === "protected" ? "需确认" : "有条件"}</button>
            ))}
          </div>
        </div>
        <div className="operation-list">
          <div className="operation-row operation-row--header"><span>接口</span><span>类型</span><span>状态</span><span>文档</span></div>
          {operations.map((operation) => (
            <div className="operation-row" key={operation.id}>
              <div className="operation-main"><div><span className={`method-chip method-chip--${operation.method.toLowerCase()}`}>{operation.method}</span><strong>{operation.title}</strong></div><code>{operation.path}</code><small>{operation.scopeKeys.join(" · ")}</small></div>
              <span className={`operation-effect operation-effect--${operation.effect}`}>{operationType(operation)}</span>
              <CapabilityStatus status={operation.status} />
              <a className="operation-doc-link" href={operation.officialUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${operation.title} 官方文档`} title="打开官方文档"><ExternalLink size={16} /></a>
            </div>
          ))}
          {operations.length === 0 && <div className="operation-empty">没有符合当前筛选条件的接口。</div>}
        </div>
      </section>

      <div className="capability-catalog-footnote">
        <span>目录来源：{capabilities.source} · 更新于 {capabilities.catalogAsOf}</span>
        <span>{capabilities.excludedScopes.length} 项审核中权限未接入：{capabilities.excludedScopes.map((scope) => scope.label).join("、")}</span>
      </div>
    </div>
  );
}

function SettingsPage({
  dashboard,
  connections,
  tiktokConnection,
  onSelectTikTokShop,
  capabilities,
  capabilitiesError,
  onSceneSelect,
  skillsCatalog,
  skillsError,
  onRetrySkills,
  onOpenSkillManager,
  onOpenConversationManager,
}: PageProps) {
  const [selectedShopId, setSelectedShopId] = useState(tiktokConnection.shops?.[0]?.id ?? "");
  const [selectingShop, setSelectingShop] = useState(false);
  const isLiveTikTok = dashboard.dataSource === "tiktok";
  const tiktokLabel = dashboard.dataSource === "demo"
    ? "演示模式"
    : isLiveTikTok
      ? "实时数据"
    : tiktokConnection.status === "expired"
      ? "授权已过期"
      : tiktokConnection.status === "shop_selection_required"
        ? "请选择店铺"
      : tiktokConnection.status === "ready_to_authorize"
        ? "等待授权"
        : "尚未配置";
  const tiktokDetail = dashboard.dataSource === "demo"
    ? `${dashboard.store.name} · 演示数据`
    : tiktokConnection.shopName
      ? `${tiktokConnection.shopName}${tiktokConnection.region ? ` · ${tiktokConnection.region}` : ""}`
      : dashboard.store.name;
  const confirmShop = async () => {
    if (!selectedShopId || selectingShop) return;
    setSelectingShop(true);
    try {
      await onSelectTikTokShop(selectedShopId);
    } finally {
      setSelectingShop(false);
    }
  };

  return (
    <div className="page-content settings-page">
      <PageHeader eyebrow="SETTINGS" title="连接与权限" description="店铺连接、已开通场景、Skill 市场和操作策略均由服务端管理。" />
      <section className="settings-section"><div className="settings-heading"><h2>聊天记录</h2><p>管理左侧“最近”中的全部对话，也可以整理到不同项目中。</p></div><div className="connection-list">
        <div className="connection-item"><span className="connection-logo connection-logo--llm"><MessageSquareText size={21} /></span><div><strong>最近聊天</strong><span>搜索、重命名、归类或删除聊天记录</span></div><button className="secondary-button connection-button" onClick={onOpenConversationManager}>管理聊天<ArrowRight size={15} /></button></div>
      </div></section>
      <section className="settings-section"><div className="settings-heading"><h2>API 能力与连接</h2><p>在这里统一查看接口连接和已开通能力，凭证不会发送到浏览器。</p></div><div className="connection-list">
        <div className="connection-item"><span className="connection-logo connection-logo--shop"><Store size={21} /></span><div><strong>TikTok Shop API</strong><span>{tiktokDetail}</span></div><div className="connection-actions"><span className={`connection-status ${!isLiveTikTok ? "connection-status--demo" : ""}`}><i />{tiktokLabel}</span>{tiktokConnection.status === "shop_selection_required" && <div className="shop-picker"><select aria-label="选择 TikTok Shop 店铺" value={selectedShopId} disabled={selectingShop} onChange={(event) => setSelectedShopId(event.target.value)}>{tiktokConnection.shops?.map((shop) => <option key={shop.id} value={shop.id}>{shop.name} · {shop.region}</option>)}</select><button className="secondary-button connection-button" disabled={!selectedShopId || selectingShop} onClick={() => void confirmShop()}>{selectingShop ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{selectingShop ? "正在切换" : "确认店铺"}</button></div>}{!connections.tiktok && tiktokConnection.status !== "not_configured" && tiktokConnection.status !== "shop_selection_required" && dashboard.dataSource !== "demo" && <button className="secondary-button connection-button" onClick={() => window.location.assign("/api/tiktok/authorize")}>{tiktokConnection.status === "expired" ? "重新授权" : "连接店铺"}<ArrowRight size={15} /></button>}</div></div>
        <div className="connection-item"><span className="connection-logo connection-logo--llm"><Bot size={21} /></span><div><strong>LLM API</strong><span>OpenAI-compatible endpoint</span></div><span className={`connection-status ${!connections.llm ? "connection-status--demo" : ""}`}><i />{connections.llm ? "已连接" : "规则路由"}</span></div>
      </div></section>

      <section className="settings-section">
        <div className="settings-heading"><h2>已开通场景</h2><p>{capabilities ? `${capabilities.scenes.length} 个场景可用` : capabilitiesError ? "能力目录暂不可用" : "正在读取…"}</p></div>
        <div className="scene-nav-list settings-scene-list">
          {capabilities?.scenes.map((scene) => {
            const Icon = sceneIcons[scene.id] ?? Boxes;
            return (
              <button
                key={scene.id}
                className="scene-nav-item"
                onClick={() => onSceneSelect(scene.id)}
              >
                <Icon size={15} strokeWidth={1.8} />
                <span>{scene.shortLabel}</span>
                <i className={`scene-status-dot scene-status-dot--${scene.status}`} title={scene.status === "ready" ? "已开通" : "存在使用条件"} />
              </button>
            );
          })}
          {capabilitiesError && <span className="scene-nav-loading">{capabilitiesError}</span>}
          {!capabilities && !capabilitiesError && <span className="scene-nav-loading">正在读取 API 能力…</span>}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-heading"><h2>Skill 市场</h2><p>{skillsCatalog ? `${skillsCatalog.statuses.filter((s) => s.installed && s.enabled).length} 个 Skill 已启用` : skillsError ? "Skill 目录暂不可用" : "正在读取…"}</p></div>
        <div className="scene-nav-list settings-scene-list">
          {skillsCatalog?.skills.map((skill) => {
            const status = skillsCatalog.statuses.find((s) => s.id === skill.id);
            if (!status || !status.installed || !status.enabled) return null;
            const Icon = skillIcons[skill.id] ?? Puzzle;
            return (
              <div key={skill.id} className="scene-nav-item scene-nav-item--skill">
                <Icon size={15} strokeWidth={1.8} />
                <span>{skill.name}</span>
              </div>
            );
          })}
          <button className="scene-nav-item skill-sidebar-install" onClick={onOpenSkillManager}>
            <Plus size={15} strokeWidth={1.8} />
            <span>管理 Skill</span>
          </button>
          {skillsError && (
            <div className="skill-sidebar-error">
              <span className="scene-nav-loading">{skillsError}</span>
              <button className="skill-sidebar-retry" onClick={onRetrySkills}>重试</button>
            </div>
          )}
          {!skillsCatalog && !skillsError && <span className="scene-nav-loading">正在读取 Skill…</span>}
        </div>
      </section>

      <section className="settings-section"><div className="settings-heading"><h2>执行策略</h2><p>策略在每次工具调用前由服务端强制校验。</p></div><div className="policy-list">
        <div><span className="policy-icon"><Server size={18} /></span><div><strong>只读查询</strong><p>订单、商品、库存与经营指标</p></div><span className="policy-value">自动允许</span></div>
        <div><span className="policy-icon"><Workflow size={18} /></span><div><strong>可逆写操作</strong><p>修改库存、价格和商品状态</p></div><span className="policy-value policy-value--warning">每次确认</span></div>
        <div><span className="policy-icon"><ShieldCheck size={18} /></span><div><strong>高风险操作</strong><p>批量下架、取消订单与删除内容</p></div><span className="policy-value policy-value--blocked">管理员审批</span></div>
      </div></section>
    </div>
  );
}

export function AppPage({ view, ...props }: PageProps & { view: Exclude<ViewId, "chat" | "employees" | "intelligence" | "office" | "content_create" | "content_assets" | "content_tasks" | "kol_chat" | "kol_creators" | "kol_tasks" | "kol_data"> }) {
  if (view === "scenes") return <CapabilitiesPage {...props} />;
  if (view === "automations") return <AutomationsPage {...props} />;
  if (view === "reports") return <ReportsPage {...props} />;
  if (view === "activity") return <ActivityPage {...props} />;
  return <SettingsPage {...props} />;
}

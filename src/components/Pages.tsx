import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChartBig,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  Download,
  FileBarChart,
  FileText,
  Globe2,
  LoaderCircle,
  MessageSquare,
  MessageSquareText,
  PackageSearch,
  Plus,
  Radar,
  RefreshCcw,
  Search,
  Store,
} from "lucide-react";
import type {
  Automation,
  DashboardSnapshot,
  SkillsCatalogResponse,
  TikTokBindingSummary,
  LlmProviderSummary,
  LlmProvidersOverview,
  LlmProviderTestResult,
  SkillConnectionTestResult,
} from "../../shared/contracts";
import { WorkflowCenter } from "./WorkflowCenter";
import { api, API_BASE } from "../api";
import type { TikTokConnectionStatus } from "../api";
import { regionLabel } from "../region-labels";
import type { ViewId } from "./Sidebar";

interface PageProps {
  dashboard: DashboardSnapshot;
  connections: { llm: boolean; tiktok: boolean };
  tiktokConnection: TikTokConnectionStatus;
  onToggleAutomation: (id: string) => void;
  onOpenChat: (prompt?: string) => void;
  llmOverview?: LlmProvidersOverview;
  onLlmChanged: () => Promise<void>;
  onAddLlmProvider: () => void;
  onEditLlmProvider: (provider: LlmProviderSummary) => void;
  skillsCatalog?: SkillsCatalogResponse;
  onSkillsChanged: () => Promise<void>;
  onOpenConnectorWizard: (skillId: string) => void;
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

const BINDING_STATUS_LABELS: Record<TikTokBindingSummary["status"], string> = {
  connected: "已连接",
  expired: "授权过期",
  invalid: "需重新授权",
};

function bindingExpiryText(expiresAt: number | undefined): string {
  if (!expiresAt) return "";
  const days = Math.ceil((expiresAt * 1000 - Date.now()) / 86400000);
  if (days <= 0) return "令牌已过期，使用时会自动尝试刷新";
  return `令牌剩余约 ${days} 天有效期`;
}

function TikTokShopSection({
  tiktokConnection,
  onReauthorize,
}: {
  tiktokConnection: TikTokConnectionStatus;
  onReauthorize: () => void;
}) {
  const shop = tiktokConnection.bindings?.[0]?.shops?.[0];
  return (
    <section className="settings-section">
      <div className="settings-heading">
        <h2>TikTok Shop 店铺</h2>
        <p>本项目只经营一个授权店铺，页面与对话都使用它。</p>
      </div>
      <div className="binding-list">
        {shop ? (
          <div className="binding-shop-row">
            <Store size={18} />
            <div className="binding-shop-name">
              <strong>{shop.name}</strong>
              <small>{regionLabel(shop.region)}</small>
            </div>
            <span className="binding-current-chip"><Check size={12} />当前店铺</span>
            <button className="secondary-button connection-button" onClick={onReauthorize}><RefreshCcw size={14} />重新授权</button>
          </div>
        ) : (
          <div className="binding-empty">
            <Store size={22} />
            <div>
              <strong>还没有授权 TikTok Shop 店铺</strong>
              <span>完成授权后，即可在对话中查询和操作店铺。</span>
            </div>
            <button className="primary-button" onClick={onReauthorize}><Plus size={15} />连接店铺</button>
          </div>
        )}
      </div>
    </section>
  );
}

function LlmProviderCard({
  provider,
  isActive,
  connected,
  onChanged,
  onEdit,
}: {
  provider: LlmProviderSummary;
  isActive: boolean;
  connected: boolean;
  onChanged: () => Promise<void>;
  onEdit: (provider: LlmProviderSummary) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [testResult, setTestResult] = useState<LlmProviderTestResult>();
  const host = (() => { try { return new URL(provider.baseUrl).host; } catch { return provider.baseUrl; } })();

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      // 只带 id：服务端复用已保存的完整密钥
      setTestResult(await api.testLlmProvider({ id: provider.id }));
    } catch (error) {
      setTestResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : "测试失败。" });
    } finally {
      setTesting(false);
    }
  };

  const activate = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      await api.activateLlmProvider(provider.id);
      await onChanged();
    } finally {
      setSwitching(false);
    }
  };

  const remove = async () => {
    await api.deleteLlmProvider(provider.id);
    await onChanged();
  };

  return (
    <div className="binding-card">
      <div className="binding-card-header">
        <span className="connection-logo connection-logo--llm"><Bot size={19} /></span>
        <div className="binding-card-title">
          <strong>{provider.name}{isActive && <span className="binding-current-badge">当前使用</span>}</strong>
          <span>{host} · {provider.model}{provider.fastModel ? ` · 快速模型 ${provider.fastModel}` : ""} · Key {shortMask(provider.apiKeyMasked)}</span>
        </div>
        <span className={`binding-status ${isActive ? (connected ? "binding-status--connected" : "binding-status--expired") : ""}`}><i />{isActive ? (connected ? "已连接" : "未生效") : "未启用"}</span>
      </div>
      {testResult && (
        <p className={`llm-test-line ${testResult.ok ? "llm-test-line--ok" : "llm-test-line--fail"}`}>
          {testResult.ok
            ? <><CheckCircle2 size={13} />测试通过 · {testResult.latencyMs} ms{testResult.reply ? ` · ${testResult.reply}` : ""}</>
            : <><AlertTriangle size={13} />测试失败：{testResult.error}</>}
        </p>
      )}
      <div className="binding-card-actions">
        {isActive ? (
          <span className="binding-current-chip"><Check size={12} />使用中</span>
        ) : (
          <button className="secondary-button connection-button" disabled={switching} onClick={() => void activate()}>
            {switching ? <LoaderCircle size={14} className="spin" /> : null}
            {switching ? "切换中" : "设为当前"}
          </button>
        )}
        <button className="secondary-button connection-button" disabled={testing} onClick={() => void runTest()}>
          {testing ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}{testing ? "测试中" : "测试"}
        </button>
        <button className="secondary-button connection-button" onClick={() => onEdit(provider)}>编辑</button>
        {confirmingDelete ? (
          <div className="binding-unbind-confirm">
            <span><AlertTriangle size={13} />解绑后对话将回落到 .env 配置或规则路由。</span>
            <button className="secondary-button connection-button binding-unbind-button" onClick={() => { setConfirmingDelete(false); void remove(); }}>确认解绑</button>
            <button className="secondary-button connection-button" onClick={() => setConfirmingDelete(false)}>取消</button>
          </div>
        ) : (
          <button className="secondary-button connection-button binding-unbind-button" onClick={() => setConfirmingDelete(true)}>解绑</button>
        )}
      </div>
    </div>
  );
}

function LlmProvidersSection({
  overview,
  onChanged,
  onAdd,
  onEdit,
}: {
  overview?: LlmProvidersOverview;
  onChanged: () => Promise<void>;
  onAdd: () => void;
  onEdit: (provider: LlmProviderSummary) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();

  const importEnv = async () => {
    if (importing) return;
    setImporting(true);
    setImportError(undefined);
    try {
      await api.importLlmEnvProvider();
      await onChanged();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入 .env 配置失败。");
    } finally {
      setImporting(false);
    }
  };

  const envHost = (() => { try { return overview?.baseUrl ? new URL(overview.baseUrl).host : ""; } catch { return overview?.baseUrl ?? ""; } })();

  return (
    <section className="settings-section">
      <div className="settings-heading">
        <h2>大模型连接</h2>
        <p>{overview
          ? overview.connected
            ? `当前使用：${overview.name ?? "模型服务"} · ${overview.model ?? ""}。可绑定多个服务随时切换。`
            : overview.source === "env"
              ? "当前使用 .env 中的模型配置，可在下方绑定更多服务并切换。"
              : "尚未绑定模型服务，对话将使用本地规则路由。按向导绑定后即可使用 AI 能力。"
          : "正在读取模型服务…"}</p>
      </div>
      <div className="binding-list">
        {overview?.source === "env" && overview.connected && (
          <div className="binding-card">
            <div className="binding-card-header">
              <span className="connection-logo connection-logo--llm"><Bot size={19} /></span>
              <div className="binding-card-title">
                <strong>.env 配置<span className="binding-current-badge">当前使用</span></strong>
                <span>{envHost ? `${envHost} · ` : ""}{overview.model ?? ""}{overview.fastModel ? ` · 快速模型 ${overview.fastModel}` : ""}</span>
              </div>
              <span className="binding-status binding-status--connected"><i />已连接</span>
            </div>
            {importError && <p className="llm-test-line llm-test-line--fail"><AlertTriangle size={13} />{importError}</p>}
            <div className="binding-card-actions">
              <span className="binding-current-chip"><Check size={12} />使用中</span>
              <button className="secondary-button connection-button" disabled={importing} onClick={() => void importEnv()}>
                {importing ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{importing ? "导入中" : "导入为可管理服务"}
              </button>
            </div>
            <p className="wizard-note" style={{ margin: 0 }}>此服务来自项目 .env 文件，暂不能在这里编辑；导入后会成为一张普通服务卡片，可改名、换 Key、随时切换。</p>
          </div>
        )}
        {overview?.providers.map((provider) => (
          <LlmProviderCard
            key={provider.id}
            provider={provider}
            isActive={overview.activeId === provider.id}
            connected={overview.connected}
            onChanged={onChanged}
            onEdit={onEdit}
          />
        ))}
        {overview && (
          <button className="binding-add" onClick={onAdd}><Plus size={15} />添加模型服务</button>
        )}
      </div>
    </section>
  );
}

const CONNECTOR_ICONS: Record<string, typeof Boxes> = {
  miaoshou: Boxes,
  "tmapi-1688": PackageSearch,
  chuhaijiang: Radar,
  "web-search": Globe2,
  feishu: MessageSquare,
  fastmoss: BarChartBig,
};

const CONNECTOR_IDS = Object.keys(CONNECTOR_ICONS);

function shortMask(masked: string): string {
  return masked.length > 20 ? `${masked.slice(0, 10)}…${masked.slice(-6)}` : masked;
}

function BusinessConnectorCard({
  skill,
  status,
  onChanged,
  onConfigure,
}: {
  skill: { id: string; name: string; description: string };
  status: { configSource?: string; connectionState?: string; config: Record<string, string> };
  onChanged: () => Promise<void>;
  onConfigure: (skillId: string) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SkillConnectionTestResult>();
  const [confirmingUnbind, setConfirmingUnbind] = useState(false);
  const Icon = CONNECTOR_ICONS[skill.id] ?? Boxes;
  const boundViaUi = status.configSource === "skill";
  const fromEnv = status.configSource === "env";
  const secretField = skill.id === "feishu" ? "appSecret" : skill.id === "tmapi-1688" ? "apiToken" : "apiKey";
  const secretMasked = status.config[secretField] ?? status.config.appSecret ?? "";
  const urlField = status.config.baseUrl ?? status.config.mcpUrl;
  const host = (() => { try { return urlField ? new URL(urlField).host : ""; } catch { return urlField ?? ""; } })();

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      setTestResult(await api.skillConnectionTest(skill.id));
    } catch (error) {
      setTestResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : "测试失败。" });
    } finally {
      setTesting(false);
    }
  };

  const unbind = async () => {
    await api.clearSkillConfig(skill.id);
    await onChanged();
  };

  return (
    <div className="binding-card">
      <div className="binding-card-header">
        <span className="connection-logo connection-logo--llm"><Icon size={19} /></span>
        <div className="binding-card-title">
          <strong>{skill.name}{boundViaUi && <span className="binding-current-badge">已绑定</span>}</strong>
          <span>{skill.description}</span>
          {(host || secretMasked) && <span>{host}{host && secretMasked ? " · " : ""}{secretMasked ? shortMask(secretMasked) : ""}</span>}
        </div>
        <span className={`binding-status ${boundViaUi ? "binding-status--connected" : fromEnv ? "binding-status--expired" : ""}`}>
          <i />{boundViaUi ? "已绑定" : fromEnv ? ".env 配置" : "未绑定"}
        </span>
      </div>
      {fromEnv && <p className="binding-warning" style={{ background: "rgba(183, 93, 0, 0.08)", color: "var(--amber)" }}><AlertTriangle size={13} />当前生效的是 .env 配置；在向导中保存后改为界面管理。</p>}
      {testResult && (
        <p className={`llm-test-line ${testResult.ok ? "llm-test-line--ok" : "llm-test-line--fail"}`}>
          {testResult.ok
            ? <><CheckCircle2 size={13} />测试通过 · {testResult.latencyMs} ms{testResult.detail ? ` · ${testResult.detail}` : ""}</>
            : <><AlertTriangle size={13} />测试失败：{testResult.error}</>}
        </p>
      )}
      <div className="binding-card-actions">
        <button className="secondary-button connection-button" disabled={testing} onClick={() => void runTest()}>
          {testing ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}{testing ? "测试中" : "测试"}
        </button>
        <button className="secondary-button connection-button" onClick={() => onConfigure(skill.id)}>{boundViaUi ? "换绑" : "配置"}</button>
        {boundViaUi && (confirmingUnbind ? (
          <div className="binding-unbind-confirm">
            <span><AlertTriangle size={13} />解绑后回落到 .env 配置（如 .env 也没有则该连接不可用）。</span>
            <button className="secondary-button connection-button binding-unbind-button" onClick={() => { setConfirmingUnbind(false); void unbind(); }}>确认解绑</button>
            <button className="secondary-button connection-button" onClick={() => setConfirmingUnbind(false)}>取消</button>
          </div>
        ) : (
          <button className="secondary-button connection-button binding-unbind-button" onClick={() => setConfirmingUnbind(true)}>解绑</button>
        ))}
      </div>
    </div>
  );
}

function BusinessConnectorsSection({
  catalog,
  onChanged,
  onConfigure,
}: {
  catalog?: SkillsCatalogResponse;
  onChanged: () => Promise<void>;
  onConfigure: (skillId: string) => void;
}) {
  const statuses = catalog?.statuses ?? [];
  const connectors = (catalog?.skills ?? [])
    .filter((skill) => CONNECTOR_IDS.includes(skill.id))
    .map((skill) => ({ skill, status: statuses.find((item) => item.id === skill.id) }))
    .filter((item): item is { skill: typeof item.skill; status: NonNullable<typeof item.status> } => Boolean(item.status));
  const boundCount = connectors.filter((item) => item.status.configSource === "skill").length;

  return (
    <section className="settings-section">
      <div className="settings-heading">
        <h2>业务接口连接</h2>
        <p>{catalog
          ? `${boundCount} 个接口已通过界面绑定，全部接口保存后立即参与采集、上架、搜索、选品与通知等业务链路。`
          : "正在读取接口目录…"}</p>
      </div>
      <div className="binding-list">
        {connectors.map(({ skill, status }) => (
          <BusinessConnectorCard
            key={skill.id}
            skill={skill}
            status={status}
            onChanged={onChanged}
            onConfigure={onConfigure}
          />
        ))}
      </div>
    </section>
  );
}

function SettingsPage({
  dashboard,
  tiktokConnection,
  llmOverview,
  onLlmChanged,
  onAddLlmProvider,
  onEditLlmProvider,
  skillsCatalog,
  onSkillsChanged,
  onOpenConnectorWizard,
  onOpenConversationManager,
}: PageProps) {
  return (
    <div className="page-content settings-page">
      <PageHeader eyebrow="SETTINGS" title="连接与权限" description="店铺绑定与大模型连接在这里统一管理，凭证只保存在本机服务端。" />
      <section className="settings-section"><div className="settings-heading"><h2>聊天记录</h2><p>管理左侧“最近”中的全部对话，也可以整理到不同项目中。</p></div>
        <div className="binding-list">
          <div className="binding-card">
            <div className="binding-card-header">
              <span className="connection-logo connection-logo--llm"><MessageSquareText size={19} /></span>
              <div className="binding-card-title"><strong>最近聊天</strong><span>搜索、重命名、归类或删除聊天记录</span></div>
              <button className="secondary-button connection-button" onClick={onOpenConversationManager}>管理聊天<ArrowRight size={15} /></button>
            </div>
          </div>
        </div>
      </section>
      <TikTokShopSection
        tiktokConnection={tiktokConnection}
        onReauthorize={() => window.location.assign(API_BASE + "/api/tiktok/authorize")}
      />
      <LlmProvidersSection
        overview={llmOverview}
        onChanged={onLlmChanged}
        onAdd={onAddLlmProvider}
        onEdit={onEditLlmProvider}
      />
      <BusinessConnectorsSection
        catalog={skillsCatalog}
        onChanged={onSkillsChanged}
        onConfigure={onOpenConnectorWizard}
      />
    </div>
  );
}

export function AppPage({ view, ...props }: PageProps & { view: Exclude<ViewId, "chat" | "employees" | "intelligence" | "office" | "content_create" | "content_assets" | "content_tasks" | "kol_chat" | "kol_creators" | "kol_tasks" | "kol_data" | "scenes"> }) {
  if (view === "automations") return <AutomationsPage {...props} />;
  if (view === "reports") return <ReportsPage {...props} />;
  if (view === "activity") return <ActivityPage {...props} />;
  return <SettingsPage {...props} />;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  LoaderCircle,
  MessageSquareText,
  PlugZap,
  RefreshCw,
  Search,
  Send,
  UserSearch,
  Users,
} from "lucide-react";
import type { BusinessWorkflowRun, KolCreator, KolOutreachWorkflowRun, KolStats } from "../../shared/contracts";
import { api, type KolOverviewResponse } from "../api";
import type { ViewId } from "./Sidebar";
import { WorkflowRunCard } from "./WorkflowCenter";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function CreatorAvatar({ creator }: { creator: KolCreator }) {
  const [failed, setFailed] = useState(false);
  if (!creator.avatar || failed) return <span><Users size={16} /></span>;
  return <img src={creator.avatar} alt="" onError={() => setFailed(true)} />;
}

function PageHeader({ title, description, onOpenChat }: { title: string; description: string; onOpenChat?: () => void }) {
  return <div className="page-header"><div><span className="eyebrow">KOL AGENT</span><h1>{title}</h1><p>{description}</p></div>{onOpenChat && <button className="primary-button" onClick={onOpenChat}><MessageSquareText size={16} />在对话中使用</button>}</div>;
}

function BridgeEmpty({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return <div className="page-empty"><PlugZap size={25} /><h2>达人插件尚未就绪</h2><p>{message ?? "请打开安装了 KOL 扩展的 TikTok Shop 联盟页面。"}</p><button className="secondary-button" onClick={onRetry}><RefreshCw size={15} />重新检查</button></div>;
}

export function KolContextPanel({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  const [overview, setOverview] = useState<KolOverviewResponse>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setError(undefined);
    void api.kolOverview().then(setOverview).catch((value) => setError(value instanceof Error ? value.message : "达人工作台连接失败。"));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const stats = overview?.stats;
  return <aside className="context-panel kol-context-panel">
    <section className="context-section">
      <div className="context-section-title"><span>达人连接</span><span className={`live-label ${overview?.status.connected ? "" : "live-label--off"}`}><i />{overview?.status.connected ? "已连接" : "未连接"}</span></div>
      <dl className="context-list"><div><dt>桥接端口</dt><dd>{overview?.status.port ?? 8794}</dd></div><div><dt>达人池</dt><dd>{stats ? `${stats.totalCreators} 位` : "-"}</dd></div><div><dt>累计邀约</dt><dd>{stats ? stats.totalInvited : "-"}</dd></div><div><dt>待处理</dt><dd>{stats ? stats.pending : "-"}</dd></div></dl>
      {error && <div className="kol-inline-error"><AlertCircle size={14} />{error}</div>}
    </section>
    <section className="context-section">
      <div className="context-section-title"><span>快捷操作</span></div>
      <div className="kol-context-actions">
        <button onClick={() => onPrompt("查看达人库")}><UserSearch size={15} /><span>查看达人库</span></button>
        <button onClick={() => onPrompt("查看达人建联数据")}><BarChart3 size={15} /><span>查看建联数据</span></button>
        <button onClick={() => onPrompt("检查达人插件连接状态")}><PlugZap size={15} /><span>检查插件连接</span></button>
      </div>
    </section>
    <section className="context-section">
      <div className="context-section-title"><span>当前结果</span></div>
      {stats ? <div className="kol-mini-results"><div><CheckCircle2 size={14} /><span>成功</span><strong>{stats.success}</strong></div><div><Send size={14} /><span>失败</span><strong>{stats.failed}</strong></div></div> : <div className="context-empty">连接插件后显示真实数据</div>}
    </section>
  </aside>;
}

function CreatorsPage({ onOpenChat }: { onOpenChat: (prompt?: string) => void }) {
  const [creators, setCreators] = useState<KolCreator[]>([]);
  const [category, setCategory] = useState("");
  const [minFollowers, setMinFollowers] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const result = await api.kolCreators({
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(Number(minFollowers) > 0 ? { minFollowers: Number(minFollowers) } : {}),
        limit: 200,
      });
      setCreators(result.creators);
    } catch (value) {
      setError(value instanceof Error ? value.message : "无法读取达人库。");
    } finally { setLoading(false); }
  }, [category, minFollowers]);
  useEffect(() => { void load(); }, []);
  return <div className="page-content kol-page">
    <PageHeader title="达人库" description="浏览器插件实时返回的 TikTok 达人数据。" onOpenChat={() => onOpenChat("查看达人库")} />
    <div className="list-toolbar kol-filter-bar"><div className="search-field"><Search size={16} /><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="类目，例如美妆" aria-label="筛选达人类目" /></div><input className="kol-number-filter" inputMode="numeric" value={minFollowers} onChange={(event) => setMinFollowers(event.target.value)} placeholder="最低粉丝数" aria-label="最低粉丝数" /><button className="secondary-button" onClick={() => void load()} disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}查询</button></div>
    {error && <BridgeEmpty message={error} onRetry={() => void load()} />}
    {!error && loading && <div className="page-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取达人库</h2></div>}
    {!error && !loading && <div className="kol-creator-table"><div className="kol-creator-row kol-creator-row--header"><span>达人</span><span>粉丝</span><span>类目</span><span>达人 ID</span></div>{creators.map((creator) => <div className="kol-creator-row" key={creator.id}><div className="kol-creator-name"><CreatorAvatar creator={creator} /><div><strong>{creator.nickname}</strong><small>{creator.handle ? `@${creator.handle}` : "未提供账号名"}</small></div></div><strong>{compactNumber(creator.followerCount)}</strong><span>{creator.category || "未分类"}</span><code>{creator.id}</code></div>)}{creators.length === 0 && <div className="operation-empty">当前筛选没有匹配达人。</div>}</div>}
  </div>;
}

function TasksPage() {
  const [runs, setRuns] = useState<KolOutreachWorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setLoading(true); setError(undefined);
    void api.workflows().then(({ runs: all }) => setRuns(all.filter((run): run is KolOutreachWorkflowRun => run.type === "kol_outreach")))
      .catch((value) => setError(value instanceof Error ? value.message : "无法读取建联任务。"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const updateRun = (next: BusinessWorkflowRun) => {
    if (next.type !== "kol_outreach") return;
    setRuns((current) => current.map((run) => run.id === next.id ? next : run));
  };
  return <div className="page-content kol-page"><PageHeader title="建联任务" description="与总任务中心共用同一份记录，这里只显示达人 BD 任务。" />{error && <div className="workflow-error"><AlertCircle size={15} />{error}</div>}{loading && <div className="page-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取任务</h2></div>}{!loading && runs.length === 0 && <div className="page-empty"><Send size={24} /><h2>还没有建联任务</h2><p>在达人工作台中输入建联目标即可创建。</p></div>}<div className="workflow-run-list">{runs.map((run) => <WorkflowRunCard initialRun={run} key={run.id} onChange={updateRun} />)}</div></div>;
}

function DataPage({ onOpenChat }: { onOpenChat: (prompt?: string) => void }) {
  const [overview, setOverview] = useState<KolOverviewResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    setLoading(true); setError(undefined);
    void api.kolOverview().then(setOverview).catch((value) => setError(value instanceof Error ? value.message : "无法读取建联数据。"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const stats: KolStats | null = overview?.stats ?? null;
  const metrics = useMemo(() => stats ? [
    ["达人池", stats.totalCreators], ["累计邀约", stats.totalInvited], ["邀约成功", stats.success],
    ["待处理", stats.pending], ["失败", stats.failed], ["插件任务", stats.tasksTotal],
  ] as const : [], [stats]);
  return <div className="page-content kol-page"><PageHeader title="建联数据" description="数据直接来自当前登录的 KOL 浏览器插件。" onOpenChat={() => onOpenChat("分析达人建联数据")} />{error && <BridgeEmpty message={error} onRetry={load} />}{!error && loading && <div className="page-empty"><LoaderCircle className="spin" size={24} /><h2>正在读取建联数据</h2></div>}{!error && !loading && !stats && <BridgeEmpty onRetry={load} />}{stats && <><div className="summary-band kol-summary-band">{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><section className="kol-data-detail"><div className="section-heading"><div><h2>执行结果</h2><span>浏览器插件实时汇总</span></div></div><div className="kol-result-bars"><div><span>成功</span><progress max={Math.max(stats.totalInvited, 1)} value={stats.success} /><strong>{stats.success}</strong></div><div><span>待处理</span><progress max={Math.max(stats.totalInvited, 1)} value={stats.pending} /><strong>{stats.pending}</strong></div><div><span>失败</span><progress max={Math.max(stats.totalInvited, 1)} value={stats.failed} /><strong>{stats.failed}</strong></div></div></section></>}</div>;
}

export function KolPage({ view, onOpenChat }: { view: Extract<ViewId, "kol_creators" | "kol_tasks" | "kol_data">; onOpenChat: (prompt?: string) => void }) {
  if (view === "kol_creators") return <CreatorsPage onOpenChat={onOpenChat} />;
  if (view === "kol_tasks") return <TasksPage />;
  return <DataPage onOpenChat={onOpenChat} />;
}

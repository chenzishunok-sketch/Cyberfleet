import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  BookOpen,
  BrainCircuit,
  Check,
  Clock3,
  ExternalLink,
  FileUp,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AGENT_CONTEXTS, DIGITAL_EMPLOYEES, type AgentContext } from "../../shared/digital-employees";
import type {
  IntelligenceOverview,
  IntelligenceScope,
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeMatch,
  PromptRule,
  WebSearchResponse,
  WebSearchTimeRange,
  WebSearchTopic,
} from "../../shared/intelligence";
import type { SkillsCatalogResponse } from "../../shared/contracts";
import { api } from "../api";

const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  business_rule: "业务规则",
  platform_policy: "平台政策",
  product: "商品资料",
  supplier: "供应商",
  operations: "运营经验",
  content: "内容规范",
  case: "优秀案例",
  glossary: "术语口径",
};

const SCOPE_LABELS: Record<IntelligenceScope, string> = {
  global: "全部 Agent",
  ...Object.fromEntries(DIGITAL_EMPLOYEES.map((employee) => [employee.id, employee.shortName])) as Record<AgentContext, string>,
};

interface KnowledgeDraft {
  title: string;
  content: string;
  category: KnowledgeCategory;
  scope: IntelligenceScope;
  source: string;
  tags: string;
  priority: number;
}

interface PromptDraft {
  name: string;
  instruction: string;
  scope: IntelligenceScope;
  priority: number;
}

const EMPTY_KNOWLEDGE: KnowledgeDraft = {
  title: "",
  content: "",
  category: "business_rule",
  scope: "global",
  source: "用户录入",
  tags: "",
  priority: 50,
};

const EMPTY_PROMPT: PromptDraft = {
  name: "",
  instruction: "",
  scope: "global",
  priority: 50,
};

function scopeOptions() {
  return ["global", ...AGENT_CONTEXTS] as IntelligenceScope[];
}

interface IntelligenceCenterProps {
  skillsCatalog?: SkillsCatalogResponse;
  onOpenSkillManager?: () => void;
}

export function IntelligenceCenter({ skillsCatalog, onOpenSkillManager }: IntelligenceCenterProps) {
  const [overview, setOverview] = useState<IntelligenceOverview>();
  const [tab, setTab] = useState<"knowledge" | "prompts" | "web">("knowledge");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [knowledgeDraft, setKnowledgeDraft] = useState<KnowledgeDraft>();
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string>();
  const [promptDraft, setPromptDraft] = useState<PromptDraft>();
  const [editingPromptId, setEditingPromptId] = useState<string>();
  const [testQuery, setTestQuery] = useState("");
  const [testScope, setTestScope] = useState<AgentContext>("general");
  const [matches, setMatches] = useState<KnowledgeMatch[]>();
  const [testing, setTesting] = useState(false);
  const [webQuery, setWebQuery] = useState("");
  const [webTopic, setWebTopic] = useState<WebSearchTopic>("general");
  const [webTimeRange, setWebTimeRange] = useState<WebSearchTimeRange | "">("");
  const [webResults, setWebResults] = useState<WebSearchResponse>();
  const [webSearching, setWebSearching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const webSearchStatus = skillsCatalog?.statuses.find((status) => status.id === "web-search");
  const webSearchReady = Boolean(webSearchStatus?.configured && webSearchStatus.enabled);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setOverview(await api.intelligenceOverview());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "智能中心暂时无法加载。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const filteredKnowledge = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview?.knowledge ?? [];
    return (overview?.knowledge ?? []).filter((entry) => `${entry.title} ${entry.content} ${entry.source} ${entry.tags.join(" ")}`.toLowerCase().includes(normalized));
  }, [overview?.knowledge, query]);

  const filteredPromptRules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview?.promptRules ?? [];
    return (overview?.promptRules ?? []).filter((rule) => `${rule.name} ${rule.instruction}`.toLowerCase().includes(normalized));
  }, [overview?.promptRules, query]);

  const openKnowledge = (entry?: KnowledgeEntry) => {
    setPromptDraft(undefined);
    setEditingPromptId(undefined);
    setEditingKnowledgeId(entry?.id);
    setKnowledgeDraft(entry ? {
      title: entry.title,
      content: entry.content,
      category: entry.category,
      scope: entry.scope,
      source: entry.source,
      tags: entry.tags.join("、"),
      priority: entry.priority,
    } : { ...EMPTY_KNOWLEDGE });
  };

  const openPrompt = (rule?: PromptRule) => {
    setKnowledgeDraft(undefined);
    setEditingKnowledgeId(undefined);
    setEditingPromptId(rule?.id);
    setPromptDraft(rule ? {
      name: rule.name,
      instruction: rule.instruction,
      scope: rule.scope,
      priority: rule.priority,
    } : { ...EMPTY_PROMPT });
  };

  const saveKnowledge = async () => {
    if (!knowledgeDraft?.title.trim() || knowledgeDraft.content.trim().length < 10 || saving) return;
    setSaving(true);
    setError(undefined);
    const input = {
      ...knowledgeDraft,
      title: knowledgeDraft.title.trim(),
      content: knowledgeDraft.content.trim(),
      source: knowledgeDraft.source.trim() || "用户录入",
      tags: knowledgeDraft.tags.split(/[、,，\n]/).map((tag) => tag.trim()).filter(Boolean),
    };
    try {
      if (editingKnowledgeId) await api.updateKnowledge(editingKnowledgeId, input);
      else await api.createKnowledge(input);
      setKnowledgeDraft(undefined);
      setEditingKnowledgeId(undefined);
      setNotice(editingKnowledgeId ? "知识已更新，后续相关问题会使用新内容。" : "知识已加入，后续相关问题会自动检索。");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "知识保存失败。");
    } finally {
      setSaving(false);
    }
  };

  const savePrompt = async () => {
    if (!promptDraft?.name.trim() || promptDraft.instruction.trim().length < 10 || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      if (editingPromptId) await api.updatePromptRule(editingPromptId, promptDraft);
      else await api.createPromptRule(promptDraft);
      setPromptDraft(undefined);
      setEditingPromptId(undefined);
      setNotice(editingPromptId ? "提示词规则已更新。" : "提示词规则已启用。");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "提示词规则保存失败。");
    } finally {
      setSaving(false);
    }
  };

  const importTextFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 500_000) {
      setError("单个文本文件请控制在 500 KB 以内，可拆分后分别导入。");
      return;
    }
    try {
      const content = await file.text();
      openKnowledge();
      setKnowledgeDraft({
        ...EMPTY_KNOWLEDGE,
        title: file.name.replace(/\.[^.]+$/, ""),
        content,
        source: file.name,
      });
    } catch {
      setError("无法读取这个文件。目前支持 TXT、Markdown、CSV 和 JSON 文本。");
    }
  };

  const testRetrieval = async () => {
    if (testQuery.trim().length < 2 || testing) return;
    setTesting(true);
    setError(undefined);
    try {
      const result = await api.searchKnowledge(testQuery.trim(), testScope);
      setMatches(result.matches);
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "检索测试失败。");
    } finally {
      setTesting(false);
    }
  };

  const runWebSearch = async () => {
    if (webQuery.trim().length < 2 || webSearching || !webSearchReady) return;
    setWebSearching(true);
    setError(undefined);
    try {
      setWebResults(await api.webSearch({
        query: webQuery.trim(),
        topic: webTopic,
        timeRange: webTimeRange || undefined,
        maxResults: 6,
      }));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "联网搜索失败。");
    } finally {
      setWebSearching(false);
    }
  };

  const toggleKnowledge = async (entry: KnowledgeEntry) => {
    await api.updateKnowledge(entry.id, { enabled: !entry.enabled });
    await load();
  };

  const togglePrompt = async (rule: PromptRule) => {
    await api.updatePromptRule(rule.id, { enabled: !rule.enabled });
    await load();
  };

  if (loading) return <div className="intelligence-loading"><LoaderCircle className="spin" size={22} /><span>正在读取智能配置</span></div>;

  return (
    <div className="intelligence-page">
      <header className="intelligence-header">
        <div><span className="eyebrow">AGENT INTELLIGENCE</span><h1>智能中心</h1><p>把你的业务知识、判断标准和优秀案例变成所有数字员工能够检索和遵循的长期能力。</p></div>
        {tab === "web" ? <button className="secondary-button" onClick={onOpenSkillManager}><Globe2 size={16} />搜索设置</button> : <button className="primary-button" onClick={() => tab === "knowledge" ? openKnowledge() : openPrompt()}><Plus size={16} />{tab === "knowledge" ? "添加知识" : "添加规则"}</button>}
      </header>

      <section className="intelligence-stats" aria-label="智能中心概况">
        <div><BookOpen size={18} /><span>有效知识</span><strong>{overview?.stats.enabledKnowledgeCount ?? 0}</strong></div>
        <div><BrainCircuit size={18} /><span>提示词规则</span><strong>{overview?.stats.enabledPromptRuleCount ?? 0}</strong></div>
        <div><Globe2 size={18} /><span>联网搜索</span><strong>{webSearchReady ? "已连接" : "待配置"}</strong></div>
      </section>

      <section className="intelligence-guide">
        <div><Sparkles size={18} /><div><strong>优先提供这些内容</strong><p>经营规则与默认值、平台口径、商品与供应商资料、成功或失败案例，以及你认可的分析样例。</p></div></div>
        <span>真实店铺数据仍从 API 读取，知识库负责补充经验和判断依据。</span>
      </section>

      <div className="intelligence-toolbar">
        <div className="intelligence-tabs" role="tablist">
          <button className={tab === "knowledge" ? "active" : ""} onClick={() => { setTab("knowledge"); setQuery(""); }}>知识库</button>
          <button className={tab === "prompts" ? "active" : ""} onClick={() => { setTab("prompts"); setQuery(""); }}>提示词规则</button>
          <button className={tab === "web" ? "active" : ""} onClick={() => { setTab("web"); setQuery(""); }}>联网搜索</button>
        </div>
        {tab !== "web" && <label className="intelligence-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "knowledge" ? "搜索知识" : "搜索规则"} /></label>}
        {tab === "knowledge" && <><input ref={fileInput} hidden type="file" accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json" onChange={(event) => void importTextFile(event)} /><button className="secondary-button" onClick={() => fileInput.current?.click()}><FileUp size={15} />导入文本</button></>}
      </div>

      {error && <div className="intelligence-message intelligence-message--error"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="关闭"><X size={14} /></button></div>}
      {notice && <div className="intelligence-message intelligence-message--success"><Check size={15} /><span>{notice}</span></div>}

      {knowledgeDraft && <KnowledgeForm draft={knowledgeDraft} editing={Boolean(editingKnowledgeId)} saving={saving} onChange={setKnowledgeDraft} onCancel={() => setKnowledgeDraft(undefined)} onSave={() => void saveKnowledge()} />}
      {promptDraft && <PromptForm draft={promptDraft} editing={Boolean(editingPromptId)} saving={saving} onChange={setPromptDraft} onCancel={() => setPromptDraft(undefined)} onSave={() => void savePrompt()} />}

      {tab === "knowledge" ? (
        <>
          <section className="retrieval-tester">
            <div><strong>测试 Agent 会找到什么</strong><span>输入一个真实问题，检查会被送进 LLM 的相关知识。</span></div>
            <div className="retrieval-controls"><input value={testQuery} onChange={(event) => setTestQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void testRetrieval(); }} placeholder="例如：泰国店铺如何判断商品是否值得上架？" /><select value={testScope} onChange={(event) => setTestScope(event.target.value as AgentContext)}>{AGENT_CONTEXTS.map((scope) => <option value={scope} key={scope}>{SCOPE_LABELS[scope]}</option>)}</select><button className="secondary-button" disabled={testQuery.trim().length < 2 || testing} onClick={() => void testRetrieval()}>{testing ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}测试检索</button></div>
            {matches && <div className="retrieval-results">{matches.length ? matches.map((match) => <div key={match.entry.id}><span>{CATEGORY_LABELS[match.entry.category]}</span><strong>{match.entry.title}</strong><small>相关度 {Math.round(match.score)}</small></div>) : <p>没有匹配到知识。可以补充相关资料或增加更明确的标题和标签。</p>}</div>}
          </section>
          <div className="knowledge-list">
            {filteredKnowledge.map((entry) => <KnowledgeRow key={entry.id} entry={entry} onEdit={() => openKnowledge(entry)} onToggle={() => void toggleKnowledge(entry)} onDelete={async () => { if (!window.confirm(`删除“${entry.title}”？`)) return; await api.deleteKnowledge(entry.id); await load(); }} />)}
            {!filteredKnowledge.length && <EmptyState icon={<BookOpen size={21} />} title="还没有业务知识" description="先加入一条经营规则或优秀案例，Agent 才能在相关问题中使用它。" action="添加第一条知识" onAction={() => openKnowledge()} />}
          </div>
        </>
      ) : tab === "prompts" ? (
        <div className="knowledge-list">
          {filteredPromptRules.map((rule) => <PromptRow key={rule.id} rule={rule} onEdit={() => openPrompt(rule)} onToggle={() => void togglePrompt(rule)} onDelete={async () => { if (rule.builtin || !window.confirm(`删除“${rule.name}”？`)) return; await api.deletePromptRule(rule.id); await load(); }} />)}
          {!filteredPromptRules.length && <EmptyState icon={<BrainCircuit size={21} />} title="没有符合条件的提示词规则" description="规则用于约束 Agent 如何分析和表达，不用于存放行业资料。" action="添加规则" onAction={() => openPrompt()} />}
        </div>
      ) : (
        <section className="web-search-panel">
          <div className="web-search-head">
            <span className={`web-search-state ${webSearchReady ? "web-search-state--ready" : ""}`}><span />{webSearchReady ? "搜索服务已连接" : "搜索服务待配置"}</span>
            <div><strong>搜索最新的公开信息</strong><p>用于平台政策、市场趋势、竞品动态和行业资料。店铺订单、商品和成本仍优先读取真实 API。</p></div>
          </div>
          {!webSearchReady ? (
            <div className="web-search-setup"><Globe2 size={22} /><div><strong>还差一个搜索密钥</strong><p>打开 Skill 管理，在“互联网搜索”中填写 Tavily API Key。密钥只保存在本地服务端。</p></div><button className="primary-button" onClick={onOpenSkillManager}>去配置</button></div>
          ) : (
            <>
              <div className="web-search-controls">
                <label className="web-search-query"><Search size={17} /><input value={webQuery} onChange={(event) => setWebQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runWebSearch(); }} placeholder="例如：TikTok Shop 泰国站 2026 年最新佣金政策" /></label>
                <select value={webTopic} onChange={(event) => setWebTopic(event.target.value as WebSearchTopic)} aria-label="搜索类型"><option value="general">综合资料</option><option value="news">近期新闻</option></select>
                <select value={webTimeRange} onChange={(event) => setWebTimeRange(event.target.value as WebSearchTimeRange | "")} aria-label="时间范围"><option value="">不限时间</option><option value="day">近 24 小时</option><option value="week">近 7 天</option><option value="month">近 30 天</option><option value="year">近 1 年</option></select>
                <button className="primary-button" disabled={webQuery.trim().length < 2 || webSearching} onClick={() => void runWebSearch()}>{webSearching ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{webSearching ? "搜索中" : "搜索"}</button>
              </div>
              {webResults && <div className="web-search-results"><div className="web-search-results-head"><strong>{webResults.results.length ? `找到 ${webResults.results.length} 个来源` : "没有找到结果"}</strong><span><Clock3 size={13} />{new Date(webResults.searchedAt).toLocaleString("zh-CN", { hour12: false })}</span></div>{webResults.results.map((result) => <article key={result.url} className="web-result"><div><span>{result.source}</span>{result.publishedAt && <span>{result.publishedAt}</span>}</div><a href={result.url} target="_blank" rel="noreferrer"><strong>{result.title}</strong><ExternalLink size={14} /></a><p>{result.snippet || "该来源没有提供摘要，可打开原网页查看。"}</p></article>)}</div>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function KnowledgeForm({ draft, editing, saving, onChange, onCancel, onSave }: { draft: KnowledgeDraft; editing: boolean; saving: boolean; onChange: (draft: KnowledgeDraft) => void; onCancel: () => void; onSave: () => void }) {
  return <section className="intelligence-editor"><div className="intelligence-editor-head"><div><strong>{editing ? "编辑知识" : "添加业务知识"}</strong><span>标题和标签越明确，Agent 越容易在正确的问题中找到它。</span></div><button className="icon-button" onClick={onCancel} aria-label="关闭"><X size={16} /></button></div><div className="intelligence-form-grid">
    <label className="wide"><span>标题</span><input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="例如：泰国店铺商品利润判断规则" /></label>
    <label><span>类型</span><select value={draft.category} onChange={(event) => onChange({ ...draft, category: event.target.value as KnowledgeCategory })}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <label><span>适用范围</span><select value={draft.scope} onChange={(event) => onChange({ ...draft, scope: event.target.value as IntelligenceScope })}>{scopeOptions().map((scope) => <option value={scope} key={scope}>{SCOPE_LABELS[scope]}</option>)}</select></label>
    <label><span>来源</span><input value={draft.source} onChange={(event) => onChange({ ...draft, source: event.target.value })} placeholder="文件名、网址或经验来源" /></label>
    <label><span>标签</span><input value={draft.tags} onChange={(event) => onChange({ ...draft, tags: event.target.value })} placeholder="利润、泰国、上架（用逗号分隔）" /></label>
    <label className="wide"><span>知识正文</span><textarea rows={8} value={draft.content} onChange={(event) => onChange({ ...draft, content: event.target.value })} placeholder="写清楚适用条件、判断方法、默认值、例外情况和数据来源。" /></label>
  </div><div className="intelligence-editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={!draft.title.trim() || draft.content.trim().length < 10 || saving} onClick={onSave}>{saving && <LoaderCircle className="spin" size={15} />}{saving ? "保存中" : "保存并启用"}</button></div></section>;
}

function PromptForm({ draft, editing, saving, onChange, onCancel, onSave }: { draft: PromptDraft; editing: boolean; saving: boolean; onChange: (draft: PromptDraft) => void; onCancel: () => void; onSave: () => void }) {
  return <section className="intelligence-editor"><div className="intelligence-editor-head"><div><strong>{editing ? "编辑提示词规则" : "添加提示词规则"}</strong><span>描述 Agent 应该怎样思考和回答，不要把商品资料写在这里。</span></div><button className="icon-button" onClick={onCancel} aria-label="关闭"><X size={16} /></button></div><div className="intelligence-form-grid">
    <label><span>规则名称</span><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="例如：选品建议必须比较利润" /></label>
    <label><span>适用范围</span><select value={draft.scope} onChange={(event) => onChange({ ...draft, scope: event.target.value as IntelligenceScope })}>{scopeOptions().map((scope) => <option value={scope} key={scope}>{SCOPE_LABELS[scope]}</option>)}</select></label>
    <label className="wide"><span>工作要求</span><textarea rows={6} value={draft.instruction} onChange={(event) => onChange({ ...draft, instruction: event.target.value })} placeholder="例如：推荐候选商品时必须同时说明采购成本、预计利润、数据缺口和不推荐的原因。" /></label>
  </div><div className="intelligence-editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={!draft.name.trim() || draft.instruction.trim().length < 10 || saving} onClick={onSave}>{saving && <LoaderCircle className="spin" size={15} />}{saving ? "保存中" : "保存并启用"}</button></div></section>;
}

function KnowledgeRow({ entry, onEdit, onToggle, onDelete }: { entry: KnowledgeEntry; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  return <article className={`knowledge-row ${entry.enabled ? "" : "knowledge-row--disabled"}`}><span className="knowledge-icon"><BookOpen size={18} /></span><div className="knowledge-main"><div><span className="knowledge-category">{CATEGORY_LABELS[entry.category]}</span><span>{SCOPE_LABELS[entry.scope]}</span></div><strong>{entry.title}</strong><p>{entry.content}</p><small>{entry.source || "用户录入"}{entry.tags.length ? ` · ${entry.tags.join(" · ")}` : ""}</small></div><div className="knowledge-actions"><button className={`switch ${entry.enabled ? "switch--on" : ""}`} role="switch" aria-checked={entry.enabled} aria-label={`${entry.enabled ? "停用" : "启用"}${entry.title}`} onClick={onToggle}><span /></button><button className="icon-button" onClick={onEdit} title="编辑" aria-label="编辑"><Pencil size={15} /></button><button className="icon-button knowledge-delete" onClick={onDelete} title="删除" aria-label="删除"><Trash2 size={15} /></button></div></article>;
}

function PromptRow({ rule, onEdit, onToggle, onDelete }: { rule: PromptRule; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  return <article className={`knowledge-row ${rule.enabled ? "" : "knowledge-row--disabled"}`}><span className="knowledge-icon"><BrainCircuit size={18} /></span><div className="knowledge-main"><div><span className="knowledge-category">{rule.builtin ? "系统基础" : "自定义"}</span><span>{SCOPE_LABELS[rule.scope]}</span><span>优先级 {rule.priority}</span></div><strong>{rule.name}</strong><p>{rule.instruction}</p></div><div className="knowledge-actions"><button className={`switch ${rule.enabled ? "switch--on" : ""}`} role="switch" aria-checked={rule.enabled} aria-label={`${rule.enabled ? "停用" : "启用"}${rule.name}`} onClick={onToggle}><span /></button><button className="icon-button" onClick={onEdit} title="编辑" aria-label="编辑"><Pencil size={15} /></button>{!rule.builtin && <button className="icon-button knowledge-delete" onClick={onDelete} title="删除" aria-label="删除"><Trash2 size={15} /></button>}</div></article>;
}

function EmptyState({ icon, title, description, action, onAction }: { icon: ReactNode; title: string; description: string; action: string; onAction: () => void }) {
  return <div className="intelligence-empty"><span>{icon}</span><strong>{title}</strong><p>{description}</p><button className="secondary-button" onClick={onAction}><Plus size={15} />{action}</button></div>;
}

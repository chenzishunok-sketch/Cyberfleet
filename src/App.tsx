import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import type { ActionPlanStatus, ChatImageAttachment, ChatMessage, DashboardSnapshot, RunStep, SkillsCatalogResponse } from "../shared/contracts";
import { getDigitalEmployee, type AgentContext } from "../shared/digital-employees";
import { api, type HealthResponse, type LlmProviderSummary, type LlmProvidersOverview, type TikTokConnectionStatus } from "./api";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { ConversationManager } from "./components/ConversationManager";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppPage } from "./components/Pages";
import type { ConnectionWizardStep } from "./components/ConnectionWizard";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { chatStreaming } from "./streaming-store";
import {
  addConversation,
  addProject,
  deleteConversation,
  deleteProject,
  ensureStoreConversation,
  moveConversation,
  readConversationState,
  renameConversation,
  renameProject,
  selectConversation,
  updateConversationMessages,
  writeConversationState,
  type Conversation,
  type ConversationState,
  type ConversationWorkspace,
} from "./conversation-store";

const OfficePage = lazy(() =>
  import("./components/OfficePage").then(({ OfficePage: Component }) => ({ default: Component })),
);
const AgentTopology = lazy(() =>
  import("./components/AgentTopology").then(({ AgentTopology: Component }) => ({ default: Component })),
);
const ContentCenter = lazy(() =>
  import("./components/ContentCenter").then(({ ContentCenter: Component }) => ({ default: Component })),
);
const DigitalEmployees = lazy(() =>
  import("./components/DigitalEmployees").then(({ DigitalEmployees: Component }) => ({ default: Component })),
);
const KolPage = lazy(() =>
  import("./components/KolWorkspace").then(({ KolPage: Component }) => ({ default: Component })),
);
const IntelligenceCenter = lazy(() =>
  import("./components/IntelligenceCenter").then(({ IntelligenceCenter: Component }) => ({ default: Component })),
);
const SkillManager = lazy(() =>
  import("./components/SkillManager").then(({ SkillManager: Component }) => ({ default: Component })),
);
const ConnectionWizard = lazy(() =>
  import("./components/ConnectionWizard").then(({ ConnectionWizard: Component }) => ({ default: Component })),
);
const LlmWizard = lazy(() =>
  import("./components/LlmWizard").then(({ LlmWizard: Component }) => ({ default: Component })),
);
const ConnectorWizard = lazy(() =>
  import("./components/ConnectorWizard").then(({ ConnectorWizard: Component }) => ({ default: Component })),
);

function initialMessage(snapshot: DashboardSnapshot): ChatMessage {
  const content = snapshot.dataSource === "tiktok"
    ? "今天想先处理什么？"
    : "TikTok Shop 尚未连接，请先前往设置完成授权。";
  const followUps = snapshot.dataSource === "tiktok"
    ? snapshot.alerts.some((alert) => /(没有.*订单|订单.*没有|0.*订单)/.test(alert.text))
      ? ["最近什么商品好卖", "查看当前促销活动", "查看全部商品库存"]
      : ["分析最近 7 天店铺销售表现", "查找库存不足的 SKU", "生成近 7 天经营报告"]
    : [];
  return {
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `welcome-${Date.now()}`,
    role: "assistant",
    content,
    timestamp: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
    ...(followUps.length ? { followUps } : {}),
  };
}

function agentInitialMessage(snapshot: DashboardSnapshot, workspace: ConversationWorkspace): ChatMessage {
  if (workspace === "general") return initialMessage(snapshot);
  const employee = getDigitalEmployee(workspace);
  return {
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `kol-welcome-${Date.now()}`,
    role: "assistant",
    content: employee.welcome,
    timestamp: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
    followUps: [...employee.followUps],
  };
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardSnapshot>();
  const [conversationState, setConversationState] = useState<ConversationState>();
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [sendingConversationIds, setSendingConversationIds] = useState<string[]>([]);
  const [busyActionId, setBusyActionId] = useState<string>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [connections, setConnections] = useState<HealthResponse["connections"]>({ llm: false, tiktok: false, miaoshou: false, tmapi: false, kolBridge: false });
  const [tiktokConnection, setTikTokConnection] = useState<TikTokConnectionStatus>({ status: "not_configured", connected: false });
  const [toast, setToast] = useState<{ tone: "success" | "error" | "info"; text: string }>();
  const [dashboardError, setDashboardError] = useState<string>();
  const [conversationManagerOpen, setConversationManagerOpen] = useState(false);
  const [managerProjectId, setManagerProjectId] = useState<string>();
  const [skillsCatalog, setSkillsCatalog] = useState<SkillsCatalogResponse>();
  const [skillsError, setSkillsError] = useState<string>();
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [connectionWizardOpen, setConnectionWizardOpen] = useState(false);
  const [connectionWizardStep, setConnectionWizardStep] = useState<ConnectionWizardStep>("guide");
  const [llmOverview, setLlmOverview] = useState<LlmProvidersOverview>();
  const [llmWizardOpen, setLlmWizardOpen] = useState(false);
  const [llmWizardEditing, setLlmWizardEditing] = useState<LlmProviderSummary>();
  const [connectorWizardId, setConnectorWizardId] = useState<string>();
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  const storageWarningShown = useRef(false);

  const loadWorkspace = useCallback(async () => {
    setDashboardError(undefined);
    try {
      const [snapshot, health] = await Promise.all([api.dashboard(), api.health()]);
      setDashboard(snapshot);
      setConversationState((current) => current
        ? ensureStoreConversation(current, snapshot.store.id, initialMessage(snapshot))
        : readConversationState(snapshot.store.id, initialMessage(snapshot)));
      setConnections(health.connections);
      setTikTokConnection(health.tiktok);
      return true;
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "无法加载店铺数据，请稍后重试。");
      return false;
    }
  }, []);

  const loadSkills = useCallback(async () => {
    setSkillsError(undefined);
    try {
      const result = await api.skills();
      setSkillsCatalog(result);
    } catch (error) {
      console.error("Failed to load skills:", error);
      setSkillsError(error instanceof Error ? error.message : "加载 Skill 失败");
    }
  }, []);

  const loadLlmProviders = useCallback(async () => {
    try {
      setLlmOverview(await api.llmProviders());
    } catch (error) {
      console.error("Failed to load LLM providers:", error);
    }
  }, []);

  // 大模型保存/切换后：刷新概览 + 健康状态（缓存已由写请求失效）
  const refreshLlm = useCallback(async () => {
    await Promise.all([loadLlmProviders(), loadWorkspace()]);
  }, [loadLlmProviders, loadWorkspace]);

  // 业务接口绑定保存/测试后：刷新 Skill 目录 + 健康状态（采集上架/1688 货源/飞书等连接状态在 health 中）
  const refreshSkills = useCallback(async () => {
    await Promise.all([loadSkills(), loadWorkspace()]);
  }, [loadSkills, loadWorkspace]);

  useEffect(() => {
    void loadWorkspace();
    // OAuth 回调经服务端中转页带 ?bind=tiktok&result=... 跳回前端：提示结果并清掉参数
    const params = new URLSearchParams(window.location.search);
    if (params.get("bind") === "tiktok") {
      const result = params.get("result");
      window.history.replaceState({}, "", window.location.pathname);
      if (result === "success") {
        setToast({ tone: "success", text: "TikTok Shop 授权成功，店铺已连接。" });
        void loadWorkspace();
      } else if (result === "error") {
        setToast({ tone: "error", text: "TikTok Shop 授权未完成，请在设置页重新发起授权。" });
      }
    }
  }, [loadWorkspace]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    void loadLlmProviders();
  }, [loadLlmProviders]);

  useEffect(() => {
    if (!conversationState) return;
    if (!writeConversationState(conversationState) && !storageWarningShown.current) {
      storageWarningShown.current = true;
      setToast({ tone: "error", text: "聊天记录暂时无法保存，请检查浏览器存储空间。" });
    }
  }, [conversationState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const storeId = dashboard?.store.id;
  const storeConversations = useMemo(() => !storeId || !conversationState
    ? []
    : conversationState.conversations.filter((conversation) => conversation.storeId === storeId), [conversationState, storeId]);
  const storeProjects = useMemo(() => !storeId || !conversationState
    ? []
    : conversationState.projects.filter((project) => project.storeId === storeId), [conversationState, storeId]);
  const activeConversationId = storeId ? conversationState?.activeConversationByStore[storeId] ?? "" : "";
  const activeConversation = storeConversations.find((conversation) => conversation.id === activeConversationId);
  const messages = activeConversation?.messages ?? [];
  const activeProject = storeProjects.find((project) => project.id === activeConversation?.projectId);
  const sending = sendingConversationIds.includes(activeConversationId);

  useEffect(() => {
    if (!activeConversation || (activeView !== "chat" && activeView !== "kol_chat")) return;
    const expectedView = activeConversation.workspace === "kol" ? "kol_chat" : "chat";
    if (activeView !== expectedView) setActiveView(expectedView);
  }, [activeConversation?.id, activeConversation?.workspace, activeView]);

  // 稳定回调：ChatWorkspace 是 memo 组件，读取最新状态走 ref，避免每次渲染都传入新函数
  const activeConversationRef = useRef<Conversation | undefined>(undefined);
  activeConversationRef.current = activeConversation;
  const activeConversationIdRef = useRef("");
  activeConversationIdRef.current = activeConversationId;
  const dashboardStateRef = useRef<DashboardSnapshot | undefined>(undefined);
  dashboardStateRef.current = dashboard;
  const conversationStateRef = useRef<ConversationState | undefined>(undefined);
  conversationStateRef.current = conversationState;
  const sendingConversationIdsRef = useRef<string[]>([]);
  sendingConversationIdsRef.current = sendingConversationIds;

  const sendMessage = useCallback(async (text: string, attachments: ChatImageAttachment[] = []) => {
    const dashboard = dashboardStateRef.current;
    const activeConversation = activeConversationRef.current;
    const normalizedText = text.trim() || (attachments.length ? "帮我找这张图片的1688同款" : "");
    if (!dashboard || !conversationStateRef.current || !activeConversation || sendingConversationIdsRef.current.includes(activeConversation.id) || !normalizedText) return;
    const targetConversationId = activeConversation.id;
    const requestHistory = activeConversation.messages.slice(-8).map(({ role, content, artifact }) => ({ role, content, artifact }));
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: attachments.length ? `${normalizedText}\n已上传图片：${attachments[0].name}` : normalizedText,
      timestamp: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
    };
    setConversationState((current) => current
      ? updateConversationMessages(current, targetConversationId, (currentMessages) => [...currentMessages, userMessage])
      : current);
    setSendingConversationIds((current) => [...current, targetConversationId]);
    const controller = chatStreaming.begin(targetConversationId);
    try {
      const response = await api.chatStream({
        message: normalizedText,
        storeId: dashboard.store.id,
        context: activeConversation.workspace,
        ...(attachments.length ? { attachments } : {}),
        history: requestHistory,
      }, (event) => {
        if (event.type === "step") chatStreaming.addStep(event.step);
        else if (event.type === "content_delta") chatStreaming.appendContent(event.delta);
        else if (event.type === "content_reset") chatStreaming.resetContent();
      }, controller.signal);
      setConversationState((current) => current
        ? updateConversationMessages(current, targetConversationId, (currentMessages) => [...currentMessages, response.message])
        : current);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      // 限定会话：切会话时这个 catch 会被触发，但此时流式状态可能已经属于新会话
      const partial = chatStreaming.end(targetConversationId)?.content.trim();
      if (aborted) {
        // 用户主动停止：保留已生成的部分内容
        if (partial) {
          const partialMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `${partial}\n\n（已停止生成）`,
            timestamp: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
          };
          setConversationState((current) => current
            ? updateConversationMessages(current, targetConversationId, (currentMessages) => [...currentMessages, partialMessage])
            : current);
        }
      } else {
        setToast({ tone: "error", text: error instanceof Error ? error.message : "处理指令失败。" });
      }
    } finally {
      chatStreaming.end(targetConversationId);
      setSendingConversationIds((current) => current.filter((conversationId) => conversationId !== targetConversationId));
    }
  }, []);

  const stopStreaming = useCallback(() => {
    chatStreaming.stop();
  }, []);

  useEffect(() => {
    if (!pendingPrompt || !activeConversation || sendingConversationIds.includes(activeConversation.id)) return;
    const prompt = pendingPrompt;
    setPendingPrompt(undefined);
    void sendMessage(prompt);
  }, [activeConversation?.id, pendingPrompt]);

  const updatePlanStatus = (conversationId: string, actionId: string, status: ActionPlanStatus) => {
    setConversationState((current) => current
      ? updateConversationMessages(current, conversationId, (currentMessages) => currentMessages.map((chatMessage) => {
        if (chatMessage.artifact?.kind !== "approval" || chatMessage.artifact.plan.id !== actionId) return chatMessage;
        return { ...chatMessage, artifact: { ...chatMessage.artifact, plan: { ...chatMessage.artifact.plan, status } } };
      }))
      : current);
  };

  const approveAction = useCallback(async (actionId: string) => {
    const targetConversationId = activeConversationIdRef.current;
    if (!targetConversationId) return;
    setBusyActionId(actionId);
    try {
      const result = await api.approve(actionId);
      const actionStatus = result.actionStatus ?? "approved";
      updatePlanStatus(targetConversationId, actionId, actionStatus);
      setConversationState((current) => current
        ? updateConversationMessages(current, targetConversationId, (currentMessages) => [...currentMessages, result.message])
        : current);
      if (result.dashboard) setDashboard(result.dashboard);
      setToast(actionStatus === "verification_pending"
        ? { tone: "info", text: "写入请求可能已经生效，系统已停止重复提交，请稍后重新核验。" }
        : { tone: "success", text: "操作已完成并通过回读验证。" });
    } catch (error) {
      setToast({ tone: "error", text: error instanceof Error ? error.message : "执行失败。" });
    } finally {
      setBusyActionId(undefined);
    }
  }, []);

  const rejectAction = useCallback(async (actionId: string) => {
    const targetConversationId = activeConversationIdRef.current;
    if (!targetConversationId) return;
    setBusyActionId(actionId);
    try {
      await api.reject(actionId);
      updatePlanStatus(targetConversationId, actionId, "rejected");
      setToast({ tone: "success", text: "执行计划已取消，没有修改店铺。" });
    } catch (error) {
      setToast({ tone: "error", text: error instanceof Error ? error.message : "无法取消计划。" });
    } finally {
      setBusyActionId(undefined);
    }
  }, []);

  const openAddLlmWizard = () => {
    setLlmWizardEditing(undefined);
    setLlmWizardOpen(true);
  };

  const openEditLlmWizard = (provider: LlmProviderSummary) => {
    setLlmWizardEditing(provider);
    setLlmWizardOpen(true);
  };

  const openConnectorWizard = (skillId: string) => {
    setConnectorWizardId(skillId);
  };

  const newConversation = (projectId?: string, workspace: ConversationWorkspace = "general") => {
    if (!dashboard) return;
    setConversationState((current) => current
      ? addConversation(current, dashboard.store.id, agentInitialMessage(dashboard, workspace), projectId, workspace)
      : readConversationState(dashboard.store.id, initialMessage(dashboard)));
    setActiveView(workspace === "kol" ? "kol_chat" : "chat");
    setConversationManagerOpen(false);
  };

  const openConversation = (conversationId: string) => {
    const conversation = storeConversations.find((item) => item.id === conversationId);
    setConversationState((current) => current ? selectConversation(current, conversationId) : current);
    setActiveView(conversation?.workspace === "kol" ? "kol_chat" : "chat");
    setConversationManagerOpen(false);
  };

  const openKolWorkspace = (prompt?: string) => {
    const latest = [...storeConversations]
      .filter((conversation) => conversation.workspace === "kol")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) openConversation(latest.id);
    else newConversation(undefined, "kol");
    if (prompt) setPendingPrompt(prompt);
  };

  const openAgentWorkspace = (workspace: AgentContext, prompt?: string) => {
    const latest = [...storeConversations]
      .filter((conversation) => conversation.workspace === workspace)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) openConversation(latest.id);
    else newConversation(undefined, workspace);
    if (prompt) setPendingPrompt(prompt);
  };

  const changeView = (view: ViewId) => {
    if (view === "chat" && activeConversation?.workspace !== "general") {
      const latest = [...storeConversations]
        .filter((conversation) => conversation.workspace === "general")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest) openConversation(latest.id);
      else newConversation();
      return;
    }
    if (view === "kol_chat") {
      openKolWorkspace();
      return;
    }
    setActiveView(view);
  };

  const openConversationManager = (projectId?: string) => {
    setManagerProjectId(projectId);
    setConversationManagerOpen(true);
    setMobileOpen(false);
  };

  const createProject = (name: string) => {
    if (!dashboard) return;
    setConversationState((current) => current ? addProject(current, dashboard.store.id, name) : current);
  };

  const removeConversation = (conversationId: string) => {
    if (!dashboard) return;
    if (sendingConversationIds.includes(conversationId) || (conversationId === activeConversationId && busyActionId)) {
      setToast({ tone: "error", text: "这条聊天仍有任务正在处理，请完成后再删除。" });
      return;
    }
    setConversationState((current) => current
      ? deleteConversation(current, conversationId, initialMessage(dashboard))
      : current);
    setToast({ tone: "success", text: "聊天已删除。" });
  };

  const openChat = (prompt?: string) => {
    changeView("chat");
    if (prompt) setPendingPrompt(prompt);
  };

  if (dashboardError) {
    return (
      <main className="app-loading app-load-error" role="alert" aria-live="assertive">
        <span className="load-error-icon"><AlertCircle size={22} /></span>
        <h1>暂时无法加载店铺数据</h1>
        <p>{dashboardError}</p>
        <button className="primary-button" onClick={() => void loadWorkspace()}>重新加载</button>
      </main>
    );
  }

  if (!dashboard || !conversationState || !activeConversation) {
    return <div className="app-loading" role="status" aria-live="polite"><div className="brand-mark"><LoaderCircle size={20} className="spin" /></div><strong>正在连接运营工作台</strong></div>;
  }

  const liveConnections = { ...connections, tiktok: dashboard.dataSource === "tiktok" };

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        onChange={changeView}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        storeName={dashboard.store.name}
        activeConversationId={activeConversationId}
        activeWorkspace={activeConversation.workspace}
        conversations={storeConversations}
        onNewConversation={newConversation}
        onOpenConversationManager={() => openConversationManager()}
        onConversationSelect={openConversation}
      />
      <div className="main-column">
        <Topbar onMenu={() => setMobileOpen(true)} />
      <ErrorBoundary>
      <Suspense fallback={<div className="office-page" />}>
        {activeView === "chat" || activeView === "kol_chat" ? (
          <div className="work-area">
            <ChatWorkspace
              messages={messages}
              sending={sending}
              conversationId={activeConversation.id}
              busyActionId={busyActionId}
              conversationTitle={activeConversation.title}
              projectName={activeProject?.name}
              workspace={activeConversation.workspace}
              onSend={sendMessage}
              onApprove={approveAction}
              onReject={rejectAction}
              onStopStreaming={stopStreaming}
            />
          </div>
        ) : activeView === "employees" ? (
          <DigitalEmployees connections={connections} onOpenAgent={(workspace) => workspace === "content" ? setActiveView("content_create") : openAgentWorkspace(workspace)} />
        ) : activeView === "intelligence" ? (
          <IntelligenceCenter skillsCatalog={skillsCatalog} onOpenSkillManager={() => setSkillManagerOpen(true)} />
        ) : activeView === "content_create" || activeView === "content_assets" || activeView === "content_tasks" ? (
          <ContentCenter section={activeView === "content_create" ? "create" : activeView === "content_assets" ? "assets" : "tasks"} />
        ) : activeView === "office" ? (
          <Suspense fallback={<div className="office-page" />}>
            <OfficePage onSelectAgent={changeView} />
          </Suspense>
        ) : activeView === "topology" ? (
          <Suspense fallback={<div className="page-content" />}>
            <AgentTopology />
          </Suspense>
        ) : activeView === "kol_creators" || activeView === "kol_tasks" || activeView === "kol_data" ? (
          <KolPage view={activeView} onOpenChat={openKolWorkspace} />
        ) : (
          <AppPage
            view={activeView}
            dashboard={dashboard}
            connections={liveConnections}
            tiktokConnection={tiktokConnection}
            onNotify={setToast}
            onOpenChat={openChat}
            llmOverview={llmOverview}
            onLlmChanged={refreshLlm}
            onAddLlmProvider={openAddLlmWizard}
            onEditLlmProvider={openEditLlmWizard}
            skillsCatalog={skillsCatalog}
            onSkillsChanged={refreshSkills}
            onOpenConnectorWizard={openConnectorWizard}
            onOpenConversationManager={() => openConversationManager()}
          />
        )}
      </Suspense>
      </ErrorBoundary>
      </div>
      <ConversationManager
        open={conversationManagerOpen}
        initialProjectId={managerProjectId}
        activeConversationId={activeConversationId}
        conversations={storeConversations}
        projects={storeProjects}
        onClose={() => setConversationManagerOpen(false)}
        onSelectConversation={openConversation}
        onNewConversation={newConversation}
        onCreateProject={createProject}
        onRenameProject={(projectId, name) => setConversationState((current) => current ? renameProject(current, projectId, name) : current)}
        onDeleteProject={(projectId) => {
          setConversationState((current) => current ? deleteProject(current, projectId) : current);
          setToast({ tone: "success", text: "项目已删除，项目内聊天已移到未归类。" });
        }}
        onRenameConversation={(conversationId, name) => setConversationState((current) => current ? renameConversation(current, conversationId, name) : current)}
        onMoveConversation={(conversationId, projectId) => setConversationState((current) => current ? moveConversation(current, conversationId, projectId) : current)}
        onDeleteConversation={removeConversation}
      />
      {skillManagerOpen && skillsCatalog && (
        <Suspense fallback={<div />}>
        <SkillManager
          catalog={skillsCatalog}
          onClose={() => setSkillManagerOpen(false)}
          onCatalogChange={setSkillsCatalog}
        />
        </Suspense>
      )}
      {connectionWizardOpen && (
        <Suspense fallback={<div />}>
          <ConnectionWizard
            initialStep={connectionWizardStep}
            onClose={() => setConnectionWizardOpen(false)}
            tiktokConnection={tiktokConnection}
            onRefresh={async () => {
              await loadWorkspace();
            }}
          />
        </Suspense>
      )}
      {llmWizardOpen && (
        <Suspense fallback={<div />}>
          <LlmWizard
            editing={llmWizardEditing}
            onClose={() => setLlmWizardOpen(false)}
            onSaved={refreshLlm}
          />
        </Suspense>
      )}
      {connectorWizardId && skillsCatalog && (() => {
        const skill = skillsCatalog.skills.find((item) => item.id === connectorWizardId);
        const skillStatus = skillsCatalog.statuses.find((item) => item.id === connectorWizardId);
        if (!skill || !skillStatus) return null;
        return (
          <Suspense fallback={<div />}>
            <ConnectorWizard
              skill={skill}
              status={skillStatus}
              onClose={() => setConnectorWizardId(undefined)}
              onSaved={refreshSkills}
            />
          </Suspense>
        );
      })()}
      {toast && <div className={`toast toast--${toast.tone}`}>{toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}<span>{toast.text}</span><button aria-label="关闭" onClick={() => setToast(undefined)}><X size={15} /></button></div>}
    </div>
  );
}

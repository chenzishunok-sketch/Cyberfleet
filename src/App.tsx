import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import type { ActionPlanStatus, ChatImageAttachment, ChatMessage, DashboardSnapshot, RunStep, TikTokCapabilitiesResponse, SkillsCatalogResponse } from "../shared/contracts";
import { getDigitalEmployee, type AgentContext } from "../shared/digital-employees";
import { api, type HealthResponse, type TikTokConnectionStatus } from "./api";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { ConversationManager } from "./components/ConversationManager";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppPage } from "./components/Pages";
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
const PricingWorkspace = lazy(() =>
  import("./components/PricingWorkspace").then(({ PricingWorkspace: Component }) => ({ default: Component })),
);
const SkillManager = lazy(() =>
  import("./components/SkillManager").then(({ SkillManager: Component }) => ({ default: Component })),
);

function initialMessage(snapshot: DashboardSnapshot): ChatMessage {
  const content = snapshot.dataSource === "tiktok"
    ? "今天想先处理什么？"
    : snapshot.dataSource === "demo"
      ? "当前处于演示模式，页面数据不是实际店铺数据。"
      : "TikTok Shop 尚未连接，请先前往设置完成授权。";
  const followUps = snapshot.dataSource === "tiktok"
    ? snapshot.alerts.some((alert) => /(没有.*订单|订单.*没有|0.*订单)/.test(alert.text))
      ? ["最近什么商品好卖", "查看当前促销活动", "查看全部商品库存"]
      : ["分析最近 7 天店铺销售表现", "查找库存不足的 SKU", "生成近 7 天经营报告"]
    : snapshot.dataSource === "demo"
      ? ["分析最近 7 天销售表现", "查看全部商品库存"]
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
  const [capabilities, setCapabilities] = useState<TikTokCapabilitiesResponse>();
  const [capabilitiesError, setCapabilitiesError] = useState<string>();
  const [selectedSceneId, setSelectedSceneId] = useState<string>();
  const [conversationManagerOpen, setConversationManagerOpen] = useState(false);
  const [managerProjectId, setManagerProjectId] = useState<string>();
  const [skillsCatalog, setSkillsCatalog] = useState<SkillsCatalogResponse>();
  const [skillsError, setSkillsError] = useState<string>();
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
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

  const loadCapabilities = useCallback(async () => {
    setCapabilitiesError(undefined);
    try {
      const result = await api.capabilities();
      setCapabilities(result);
      setSelectedSceneId((current) => result.scenes.some((scene) => scene.id === current) ? current : result.scenes[0]?.id);
    } catch (error) {
      setCapabilitiesError(error instanceof Error ? error.message : "无法加载 API 能力目录。");
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

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

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
      }, controller.signal);
      setConversationState((current) => current
        ? updateConversationMessages(current, targetConversationId, (currentMessages) => [...currentMessages, response.message])
        : current);
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const partial = chatStreaming.end()?.content.trim();
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
      chatStreaming.end();
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

  const toggleAutomation = useCallback(async (automationId: string) => {
    try {
      const result = await api.toggleAutomation(automationId);
      setDashboard((current) => current ? { ...current, automations: current.automations.map((item) => item.id === automationId ? result.automation : item) } : current);
      setConversationState((current) => current ? {
        ...current,
        conversations: current.conversations.map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((chatMessage) => {
            if (chatMessage.artifact?.kind !== "automation" || chatMessage.artifact.automation.id !== automationId) return chatMessage;
            return { ...chatMessage, artifact: { ...chatMessage.artifact, automation: result.automation } };
          }),
        })),
      } : current);
      setToast({ tone: "success", text: result.automation.enabled ? "自动任务已启用。" : "自动任务已暂停。" });
    } catch (error) {
      setToast({ tone: "error", text: error instanceof Error ? error.message : "更新任务失败。" });
    }
  }, []);

  const selectTikTokShop = async (shopId: string) => {
    try {
      const result = await api.selectTikTokShop(shopId);
      setTikTokConnection(result.tiktok);
      setConnections((current) => ({ ...current, tiktok: result.tiktok.connected }));
      const refreshed = await loadWorkspace();
      void loadCapabilities();
      if (refreshed) {
        setToast({ tone: "success", text: `已切换到 ${result.tiktok.shopName ?? "TikTok Shop 店铺"}，数据已刷新。` });
      } else {
        setToast({ tone: "error", text: "店铺已选择，但新店铺数据加载失败，请点击重试。" });
      }
    } catch (error) {
      setToast({ tone: "error", text: error instanceof Error ? error.message : "选择店铺失败。" });
    }
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
              onToggleAutomation={toggleAutomation}
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
        ) : activeView === "pricing" ? (
          <PricingWorkspace />
        ) : (
          <AppPage
            view={activeView}
            dashboard={dashboard}
            connections={liveConnections}
            tiktokConnection={tiktokConnection}
            onToggleAutomation={toggleAutomation}
            onOpenChat={openChat}
            onSelectTikTokShop={selectTikTokShop}
            capabilities={capabilities}
            capabilitiesError={capabilitiesError}
            selectedSceneId={selectedSceneId}
            onSceneSelect={setSelectedSceneId}
            skillsCatalog={skillsCatalog}
            skillsError={skillsError}
            onRetrySkills={loadSkills}
            onOpenSkillManager={() => setSkillManagerOpen(true)}
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
      {toast && <div className={`toast toast--${toast.tone}`}>{toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}<span>{toast.text}</span><button aria-label="关闭" onClick={() => setToast(undefined)}><X size={15} /></button></div>}
    </div>
  );
}

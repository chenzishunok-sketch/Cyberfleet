import {
  BarChart3,
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  CircleDollarSign,
  FileImage,
  History,
  MessageSquareText,
  Plus,
  Images,
  ListTodo,
  Settings,
  Send,
  UserSearch,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Conversation } from "../conversation-store";
import { formatConversationTime } from "../conversation-store";
import type { AgentContext } from "../../shared/digital-employees";

export type ViewId = "chat" | "employees" | "intelligence" | "office" | "topology" | "content_create" | "content_assets" | "content_tasks" | "kol_chat" | "kol_creators" | "kol_tasks" | "kol_data" | "automations" | "pricing" | "reports" | "activity" | "settings";

interface SidebarProps {
  activeView: ViewId;
  onChange: (view: ViewId) => void;
  mobileOpen: boolean;
  onClose: () => void;
  storeName: string;
  activeConversationId: string;
  activeWorkspace: AgentContext;
  conversations: Conversation[];
  onNewConversation: () => void;
  onOpenConversationManager: () => void;
  onConversationSelect: (conversationId: string) => void;
}

type ExpandableGroup = "content" | "kol" | "workflow";

function groupForView(view: ViewId): ExpandableGroup | undefined {
  if (view.startsWith("content_")) return "content";
  if (view === "kol_creators" || view === "kol_tasks" || view === "kol_data") return "kol";
  if (view === "automations" || view === "activity") return "workflow";
  return undefined;
}

export function Sidebar({
  activeView,
  onChange,
  mobileOpen,
  onClose,
  storeName,
  activeConversationId,
  activeWorkspace,
  conversations,
  onNewConversation,
  onOpenConversationManager,
  onConversationSelect,
}: SidebarProps) {
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<ExpandableGroup | undefined>(() => groupForView(activeView));
  const lastContentView = useRef<ViewId>(activeView.startsWith("content_") ? activeView : "content_create");
  const lastKolView = useRef<ViewId>(groupForView(activeView) === "kol" ? activeView : "kol_creators");
  const lastWorkflowView = useRef<ViewId>(groupForView(activeView) === "workflow" ? activeView : "automations");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("cyberfleet.sidebar.width"));
    return Number.isFinite(stored) && stored >= 220 && stored <= 320 ? stored : 248;
  });
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef({ pointerX: 0, width: 248 });

  useEffect(() => {
    window.localStorage.setItem("cyberfleet.sidebar.width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const group = groupForView(activeView);
    if (!group) return;
    setExpandedGroup(group);
    if (group === "content") lastContentView.current = activeView;
    if (group === "kol") lastKolView.current = activeView;
    if (group === "workflow") lastWorkflowView.current = activeView;
  }, [activeView]);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const next = resizeStartRef.current.width + event.clientX - resizeStartRef.current.pointerX;
      setSidebarWidth(Math.min(320, Math.max(220, next)));
    };
    const stop = () => setResizing(false);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizing]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = { pointerX: event.clientX, width: sidebarWidth };
    setResizing(true);
  };

  const select = (view: ViewId) => {
    onChange(view);
    onClose();
  };

  const openConversation = (conversationId: string) => {
    onConversationSelect(conversationId);
    onClose();
  };

  const recentConversations = conversations
    .filter((conversation) => conversation.title !== "新对话")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);

  const toggleGroup = (group: ExpandableGroup) => {
    if (expandedGroup === group) {
      setExpandedGroup(undefined);
      return;
    }
    setExpandedGroup(group);
    if (group === "content") select(lastContentView.current);
    else if (group === "kol") select(lastKolView.current);
    else if (group === "workflow") select(lastWorkflowView.current);
  };

  return (
    <>
      {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航遮罩" onClick={onClose} />}
      <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""} ${resizing ? "sidebar--resizing" : ""}`} style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
        <div className="brand-row">
          <div className="brand-lockup" aria-hidden="true">
            {/* Logo intentionally removed per user request */}
          </div>
          <button className="icon-button sidebar-close" aria-label="关闭导航" title="关闭导航" onClick={onClose}><X size={18} /></button>
        </div>

        <button className="sidebar-new-chat" onClick={() => {
          onNewConversation();
          onClose();
        }}><Plus size={17} /><span>新任务</span></button>

        <div className="sidebar-scroll">
          <div className="sidebar-section sidebar-recents">
            <button
              className="sidebar-collapse-toggle"
              aria-expanded={!recentsCollapsed}
              aria-controls="recent-conversations-list"
              onClick={() => setRecentsCollapsed((collapsed) => !collapsed)}
            >
              <span>最近任务</span>
              <ChevronDown size={15} className={`sidebar-collapse-chevron ${recentsCollapsed ? "sidebar-collapse-chevron--collapsed" : ""}`} />
            </button>
            {!recentsCollapsed && (
              <div className="conversation-list" id="recent-conversations-list">
                {recentConversations.map((conversation) => (
                  <button
                    className={`conversation-item ${(activeView === "chat" || activeView === "kol_chat") && activeConversationId === conversation.id ? "conversation-item--active" : ""}`}
                    key={conversation.id}
                    onClick={() => openConversation(conversation.id)}
                  >
                    <span className="conversation-title">{conversation.workspace !== "general" && <Bot size={13} />}{conversation.title}</span>
                    <span className="conversation-meta">{formatConversationTime(conversation.updatedAt)}</span>
                  </button>
                ))}
                {!recentConversations.length && <span className="sidebar-recents-empty">还没有最近任务</span>}
                <button className="sidebar-view-all" onClick={() => { onOpenConversationManager(); onClose(); }}><History size={14} /><span>查看全部</span><ChevronRight size={14} /></button>
              </div>
            )}
          </div>

          <nav className="main-nav" aria-label="主导航">
            <section className="sidebar-nav-section" aria-labelledby="sidebar-work-label">
              <span className="sidebar-nav-label" id="sidebar-work-label">工作</span>
              <button className={`nav-item ${activeView === "chat" && activeWorkspace === "general" ? "nav-item--active" : ""}`} onClick={() => select("chat")}><MessageSquareText size={18} strokeWidth={1.8} /><span>工作台</span></button>
              <button className={`nav-item ${activeView === "pricing" ? "nav-item--active" : ""}`} onClick={() => select("pricing")}><CircleDollarSign size={18} strokeWidth={1.8} /><span>商品管理</span></button>
              <div className="sidebar-nav-group">
                <button className={`nav-item sidebar-nav-toggle ${activeView.startsWith("content_") ? "nav-item--active-parent" : ""}`} aria-expanded={expandedGroup === "content"} onClick={() => toggleGroup("content")}><FileImage size={18} strokeWidth={1.8} /><span>内容中心</span><ChevronDown size={15} className={`sidebar-collapse-chevron ${expandedGroup === "content" ? "" : "sidebar-collapse-chevron--collapsed"}`} /></button>
                {expandedGroup === "content" && <div className="sidebar-subnav">
                  <button className={`nav-item ${activeView === "content_create" ? "nav-item--active" : ""}`} onClick={() => select("content_create")}><SparklesIcon /><span>创作工作台</span></button>
                  <button className={`nav-item ${activeView === "content_assets" ? "nav-item--active" : ""}`} onClick={() => select("content_assets")}><Images size={16} /><span>资产库</span></button>
                  <button className={`nav-item ${activeView === "content_tasks" ? "nav-item--active" : ""}`} onClick={() => select("content_tasks")}><ListTodo size={16} /><span>创作任务</span></button>
                </div>}
              </div>
              <div className="sidebar-nav-group">
                <button className={`nav-item sidebar-nav-toggle ${groupForView(activeView) === "kol" ? "nav-item--active-parent" : ""}`} aria-expanded={expandedGroup === "kol"} onClick={() => toggleGroup("kol")}><Users size={18} strokeWidth={1.8} /><span>达人管理</span><ChevronDown size={15} className={`sidebar-collapse-chevron ${expandedGroup === "kol" ? "" : "sidebar-collapse-chevron--collapsed"}`} /></button>
                {expandedGroup === "kol" && <div className="sidebar-subnav">
                  <button className={`nav-item ${activeView === "kol_creators" ? "nav-item--active" : ""}`} onClick={() => select("kol_creators")}><UserSearch size={16} /><span>达人库</span></button>
                  <button className={`nav-item ${activeView === "kol_tasks" ? "nav-item--active" : ""}`} onClick={() => select("kol_tasks")}><Send size={16} /><span>建联任务</span></button>
                  <button className={`nav-item ${activeView === "kol_data" ? "nav-item--active" : ""}`} onClick={() => select("kol_data")}><BarChart3 size={16} /><span>建联数据</span></button>
                </div>}
              </div>
            </section>

            <section className="sidebar-nav-section" aria-labelledby="sidebar-team-label">
              <span className="sidebar-nav-label" id="sidebar-team-label">团队</span>
              <button className={`nav-item ${activeView === "office" ? "nav-item--active" : ""}`} onClick={() => select("office")}><Building2 size={18} strokeWidth={1.8} /><span>办公室</span></button>
              <button className={`nav-item ${activeView === "employees" || activeView === "kol_chat" || (activeView === "chat" && activeWorkspace !== "general") ? "nav-item--active" : ""}`} onClick={() => select("employees")}><Bot size={18} strokeWidth={1.8} /><span>数字员工</span></button>
              <div className="sidebar-nav-group">
                <button className={`nav-item sidebar-nav-toggle ${groupForView(activeView) === "workflow" ? "nav-item--active-parent" : ""}`} aria-expanded={expandedGroup === "workflow"} onClick={() => toggleGroup("workflow")}><Workflow size={18} strokeWidth={1.8} /><span>工作流</span><ChevronDown size={15} className={`sidebar-collapse-chevron ${expandedGroup === "workflow" ? "" : "sidebar-collapse-chevron--collapsed"}`} /></button>
                {expandedGroup === "workflow" && <div className="sidebar-subnav">
                  <button className={`nav-item ${activeView === "automations" ? "nav-item--active" : ""}`} onClick={() => select("automations")}><Workflow size={16} /><span>流程中心</span></button>
                  <button className={`nav-item ${activeView === "activity" ? "nav-item--active" : ""}`} onClick={() => select("activity")}><History size={16} /><span>执行记录</span></button>
                </div>}
              </div>
            </section>
          </nav>
        </div>

        <div className="sidebar-footer">
          <button className={`nav-item ${activeView === "settings" ? "nav-item--active" : ""}`} onClick={() => select("settings")}><Settings size={18} strokeWidth={1.8} /><span>设置</span></button>
        </div>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={320}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setSidebarWidth((current) => Math.min(320, Math.max(220, current + (event.key === "ArrowRight" ? 8 : -8))));
          }}
        />
      </aside>
    </>
  );
}

function SparklesIcon() {
  return <FileImage size={16} />;
}

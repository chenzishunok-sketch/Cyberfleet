import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Folder,
  FolderPlus,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ChatProject, Conversation } from "../conversation-store";
import { formatConversationTime } from "../conversation-store";

interface ConversationManagerProps {
  open: boolean;
  initialProjectId?: string;
  activeConversationId: string;
  conversations: Conversation[];
  projects: ChatProject[];
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: (projectId?: string) => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRenameConversation: (conversationId: string, name: string) => void;
  onMoveConversation: (conversationId: string, projectId?: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}

type ProjectFilter = "all" | "unfiled" | string;

export function ConversationManager({
  open,
  initialProjectId,
  activeConversationId,
  conversations,
  projects,
  onClose,
  onSelectConversation,
  onNewConversation,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onRenameConversation,
  onMoveConversation,
  onDeleteConversation,
}: ConversationManagerProps) {
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [search, setSearch] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [editingConversationId, setEditingConversationId] = useState<string>();
  const [nameDraft, setNameDraft] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState<string>();
  const [deletingConversationId, setDeletingConversationId] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProjectFilter(initialProjectId && projects.some((project) => project.id === initialProjectId) ? initialProjectId : "all");
    setSearch("");
    setCreatingProject(false);
    setEditingProjectId(undefined);
    setEditingConversationId(undefined);
    setDeletingProjectId(undefined);
    setDeletingConversationId(undefined);
  }, [initialProjectId, open, projects]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  const sortedConversations = useMemo(() => [...conversations]
    .filter((conversation) => {
      if (projectFilter === "unfiled" && conversation.projectId) return false;
      if (projectFilter !== "all" && projectFilter !== "unfiled" && conversation.projectId !== projectFilter) return false;
      return !search.trim() || conversation.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    })
    .sort((a, b) => b.updatedAt - a.updatedAt), [conversations, projectFilter, search]);

  if (!open) return null;

  const selectedProject = projects.find((project) => project.id === projectFilter);
  const heading = projectFilter === "all" ? "全部聊天" : projectFilter === "unfiled" ? "未归类" : selectedProject?.name ?? "聊天";

  const submitProject = () => {
    if (!projectDraft.trim()) return;
    onCreateProject(projectDraft);
    setProjectDraft("");
    setCreatingProject(false);
  };

  const saveProjectName = (projectId: string) => {
    if (nameDraft.trim()) onRenameProject(projectId, nameDraft);
    setEditingProjectId(undefined);
    setNameDraft("");
  };

  const saveConversationName = (conversationId: string) => {
    if (nameDraft.trim()) onRenameConversation(conversationId, nameDraft);
    setEditingConversationId(undefined);
    setNameDraft("");
  };

  return (
    <div className="conversation-manager-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="conversation-manager" role="dialog" aria-modal="true" aria-labelledby="conversation-manager-title">
        <header className="conversation-manager-header">
          <div>
            <span className="eyebrow">工作空间</span>
            <h2 id="conversation-manager-title">管理项目和聊天</h2>
          </div>
          <button className="icon-button" aria-label="关闭管理窗口" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="conversation-manager-body">
          <aside className="project-manager-pane" aria-label="项目">
            <div className="manager-section-heading">
              <span>项目</span>
              <button className="text-icon-button" aria-label="新建项目" title="新建项目" onClick={() => setCreatingProject(true)}><FolderPlus size={16} /></button>
            </div>

            <button className={`project-filter-row ${projectFilter === "all" ? "project-filter-row--active" : ""}`} onClick={() => setProjectFilter("all")}>
              <MessageSquareText size={16} /><span>全部聊天</span><small>{conversations.length}</small>
            </button>
            <button className={`project-filter-row ${projectFilter === "unfiled" ? "project-filter-row--active" : ""}`} onClick={() => setProjectFilter("unfiled")}>
              <Folder size={16} /><span>未归类</span><small>{conversations.filter((item) => !item.projectId).length}</small>
            </button>

            {creatingProject && (
              <div className="inline-name-editor">
                <input
                  autoFocus
                  value={projectDraft}
                  maxLength={40}
                  aria-label="项目名称"
                  placeholder="项目名称"
                  onChange={(event) => setProjectDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitProject();
                    if (event.key === "Escape") setCreatingProject(false);
                  }}
                />
                <button aria-label="保存项目" title="保存" onClick={submitProject}><Check size={14} /></button>
                <button aria-label="取消新建" title="取消" onClick={() => setCreatingProject(false)}><X size={14} /></button>
              </div>
            )}

            <div className="project-filter-list">
              {projects.map((project) => (
                <div className={`project-filter-row project-filter-row--managed ${projectFilter === project.id ? "project-filter-row--active" : ""}`} key={project.id}>
                  {editingProjectId === project.id ? (
                    <div className="inline-name-editor inline-name-editor--project">
                      <input
                        autoFocus
                        value={nameDraft}
                        maxLength={40}
                        aria-label="修改项目名称"
                        onChange={(event) => setNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveProjectName(project.id);
                          if (event.key === "Escape") setEditingProjectId(undefined);
                        }}
                      />
                      <button aria-label="保存项目名称" title="保存" onClick={() => saveProjectName(project.id)}><Check size={13} /></button>
                    </div>
                  ) : (
                    <>
                      <button className="project-filter-main" onClick={() => setProjectFilter(project.id)}>
                        <Folder size={16} /><span>{project.name}</span><small>{conversations.filter((item) => item.projectId === project.id).length}</small>
                      </button>
                      <button className="manager-row-action" aria-label={`重命名项目 ${project.name}`} title="重命名" onClick={() => {
                        setEditingProjectId(project.id);
                        setNameDraft(project.name);
                      }}><Pencil size={13} /></button>
                      <button className="manager-row-action manager-row-action--danger" aria-label={`删除项目 ${project.name}`} title="删除" onClick={() => setDeletingProjectId(project.id)}><Trash2 size={13} /></button>
                    </>
                  )}
                  {deletingProjectId === project.id && (
                    <div className="inline-delete-confirm">
                      <span>聊天将移到未归类</span>
                      <button onClick={() => {
                        onDeleteProject(project.id);
                        setDeletingProjectId(undefined);
                        if (projectFilter === project.id) setProjectFilter("unfiled");
                      }}>确认删除</button>
                      <button aria-label="取消删除项目" title="取消" onClick={() => setDeletingProjectId(undefined)}><X size={13} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </aside>

          <main className="chat-manager-pane">
            <div className="chat-manager-toolbar">
              <h3>{heading}</h3>
              <div className="chat-manager-controls">
                <label className="manager-search">
                  <Search size={15} />
                  <input value={search} aria-label="搜索聊天" placeholder="搜索聊天" onChange={(event) => setSearch(event.target.value)} />
                </label>
                <button className="secondary-button" onClick={() => onNewConversation(selectedProject?.id)}><Plus size={15} />新建聊天</button>
              </div>
            </div>

            <div className="managed-conversation-list">
              {sortedConversations.map((conversation) => (
                <div className={`managed-conversation-row ${conversation.id === activeConversationId ? "managed-conversation-row--active" : ""}`} key={conversation.id}>
                  <MessageSquareText size={17} />
                  <div className="managed-conversation-copy">
                    {editingConversationId === conversation.id ? (
                      <div className="inline-name-editor">
                        <input
                          autoFocus
                          value={nameDraft}
                          maxLength={40}
                          aria-label="修改聊天名称"
                          onChange={(event) => setNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") saveConversationName(conversation.id);
                            if (event.key === "Escape") setEditingConversationId(undefined);
                          }}
                        />
                        <button aria-label="保存聊天名称" title="保存" onClick={() => saveConversationName(conversation.id)}><Check size={14} /></button>
                      </div>
                    ) : (
                      <button className="managed-conversation-open" onClick={() => onSelectConversation(conversation.id)}>
                        <strong>{conversation.title}</strong>
                        <span>{formatConversationTime(conversation.updatedAt)} · {conversation.messages.filter((message) => message.role !== "system").length} 条消息</span>
                      </button>
                    )}
                  </div>
                  <select
                    value={conversation.projectId ?? ""}
                    aria-label={`移动聊天 ${conversation.title}`}
                    title="移动到项目"
                    onChange={(event) => onMoveConversation(conversation.id, event.target.value || undefined)}
                  >
                    <option value="">未归类</option>
                    {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
                  </select>
                  <button className="manager-row-action" aria-label={`重命名聊天 ${conversation.title}`} title="重命名" onClick={() => {
                    setEditingConversationId(conversation.id);
                    setNameDraft(conversation.title);
                  }}><Pencil size={14} /></button>
                  <button className="manager-row-action manager-row-action--danger" aria-label={`删除聊天 ${conversation.title}`} title="删除" onClick={() => setDeletingConversationId(conversation.id)}><Trash2 size={14} /></button>
                  {deletingConversationId === conversation.id && (
                    <div className="inline-delete-confirm inline-delete-confirm--chat">
                      <span>删除这条聊天？</span>
                      <button onClick={() => {
                        onDeleteConversation(conversation.id);
                        setDeletingConversationId(undefined);
                      }}>确认删除</button>
                      <button aria-label="取消删除聊天" title="取消" onClick={() => setDeletingConversationId(undefined)}><X size={13} /></button>
                    </div>
                  )}
                </div>
              ))}
              {!sortedConversations.length && <div className="managed-conversation-empty">没有符合条件的聊天</div>}
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}

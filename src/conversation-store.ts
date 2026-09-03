import type { ChatMessage } from "../shared/contracts";
import { isAgentContext, type AgentContext } from "../shared/digital-employees";

export const CONVERSATION_STORAGE_KEY = "shoppilot.workspace.v2";

const MAX_CONVERSATIONS = 40;
const MAX_MESSAGES_PER_CONVERSATION = 120;

export interface ChatProject {
  id: string;
  storeId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type ConversationWorkspace = AgentContext;

export interface Conversation {
  id: string;
  storeId: string;
  title: string;
  projectId?: string;
  workspace: ConversationWorkspace;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationState {
  version: 1;
  activeConversationByStore: Record<string, string>;
  projects: ChatProject[];
  conversations: Conversation[];
}

function makeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanName(value: string, fallback: string, maxLength = 40): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, maxLength);
}

export function conversationTitleFromMessage(message: string): string {
  const cleaned = message
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s*#>-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "新对话";
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned;
}

function expireUnsafePlans(message: ChatMessage): ChatMessage {
  if (message.artifact?.kind !== "approval") return message;
  const status = message.artifact.plan.status;
  if (status !== "pending" && status !== "executing") return message;
  const nextStatus = status === "executing"
    ? "verification_pending"
    : new Date(message.artifact.plan.expiresAt).getTime() < Date.now() ? "expired" : "pending";
  if (nextStatus === status) return message;
  return {
    ...message,
    artifact: {
      ...message.artifact,
      plan: { ...message.artifact.plan, status: nextStatus },
    },
  };
}

function replaceLegacyWelcome(message: ChatMessage): ChatMessage {
  return message.role === "assistant" && message.content.startsWith("已连接真实店铺 ")
    ? { ...message, content: "今天想先处理什么？" }
    : message;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatMessage>;
  return typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system")
    && typeof candidate.content === "string"
    && typeof candidate.timestamp === "string";
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createConversation(
  storeId: string,
  welcomeMessage: ChatMessage,
  projectId?: string,
  now = Date.now(),
  workspace: ConversationWorkspace = "general",
): Conversation {
  return {
    id: makeId(),
    storeId,
    title: "新对话",
    ...(projectId ? { projectId } : {}),
    workspace,
    messages: [welcomeMessage],
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialConversationState(storeId: string, welcomeMessage: ChatMessage, now = Date.now()): ConversationState {
  const conversation = createConversation(storeId, welcomeMessage, undefined, now);
  return {
    version: 1,
    activeConversationByStore: { [storeId]: conversation.id },
    projects: [],
    conversations: [conversation],
  };
}

export function restoreConversationState(raw: string | null, storeId: string, welcomeMessage: ChatMessage): ConversationState {
  if (!raw) return createInitialConversationState(storeId, welcomeMessage);

  try {
    const parsed = JSON.parse(raw) as Partial<ConversationState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.conversations)) {
      return createInitialConversationState(storeId, welcomeMessage);
    }

    const projects = parsed.projects.flatMap((project) => {
      if (!project || typeof project !== "object") return [];
      const candidate = project as Partial<ChatProject>;
      if (typeof candidate.id !== "string" || typeof candidate.storeId !== "string" || typeof candidate.name !== "string") return [];
      const now = Date.now();
      return [{
        id: candidate.id,
        storeId: candidate.storeId,
        name: cleanName(candidate.name, "未命名项目"),
        createdAt: isFiniteTimestamp(candidate.createdAt) ? candidate.createdAt : now,
        updatedAt: isFiniteTimestamp(candidate.updatedAt) ? candidate.updatedAt : now,
      }];
    });
    const projectIds = new Set(projects.map((project) => project.id));

    const conversations = parsed.conversations.flatMap((conversation) => {
      if (!conversation || typeof conversation !== "object") return [];
      const candidate = conversation as Partial<Conversation>;
      if (typeof candidate.id !== "string" || typeof candidate.storeId !== "string" || !Array.isArray(candidate.messages)) return [];
      const messages = candidate.messages.filter(isMessage).slice(-MAX_MESSAGES_PER_CONVERSATION).map(expireUnsafePlans).map(replaceLegacyWelcome);
      if (!messages.length) return [];
      const now = Date.now();
      return [{
        id: candidate.id,
        storeId: candidate.storeId,
        title: cleanName(typeof candidate.title === "string" ? candidate.title : "", "新对话"),
        ...(typeof candidate.projectId === "string" && projectIds.has(candidate.projectId) ? { projectId: candidate.projectId } : {}),
        workspace: isAgentContext(candidate.workspace) ? candidate.workspace : "general",
        messages,
        createdAt: isFiniteTimestamp(candidate.createdAt) ? candidate.createdAt : now,
        updatedAt: isFiniteTimestamp(candidate.updatedAt) ? candidate.updatedAt : now,
      }];
    }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);

    const activeConversationByStore = Object.fromEntries(
      Object.entries(parsed.activeConversationByStore ?? {}).filter(([entryStoreId, conversationId]) =>
        typeof conversationId === "string"
        && conversations.some((conversation) => conversation.id === conversationId && conversation.storeId === entryStoreId)),
    );
    const currentStoreConversations = conversations.filter((conversation) => conversation.storeId === storeId);
    if (!currentStoreConversations.length) {
      const conversation = createConversation(storeId, welcomeMessage);
      conversations.unshift(conversation);
      activeConversationByStore[storeId] = conversation.id;
    } else if (!activeConversationByStore[storeId]) {
      activeConversationByStore[storeId] = currentStoreConversations[0].id;
    }

    return { version: 1, activeConversationByStore, projects, conversations };
  } catch {
    return createInitialConversationState(storeId, welcomeMessage);
  }
}

export function readConversationState(storeId: string, welcomeMessage: ChatMessage): ConversationState {
  if (typeof window === "undefined") return createInitialConversationState(storeId, welcomeMessage);
  return restoreConversationState(window.localStorage.getItem(CONVERSATION_STORAGE_KEY), storeId, welcomeMessage);
}

export function writeConversationState(state: ConversationState): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function ensureStoreConversation(state: ConversationState, storeId: string, welcomeMessage: ChatMessage): ConversationState {
  const storeConversations = state.conversations.filter((conversation) => conversation.storeId === storeId);
  const currentActiveId = state.activeConversationByStore[storeId];
  if (storeConversations.some((conversation) => conversation.id === currentActiveId)) return state;
  if (storeConversations.length) {
    return {
      ...state,
      activeConversationByStore: { ...state.activeConversationByStore, [storeId]: storeConversations[0].id },
    };
  }
  return addConversation(state, storeId, welcomeMessage);
}

export function addConversation(
  state: ConversationState,
  storeId: string,
  welcomeMessage: ChatMessage,
  projectId?: string,
  workspace: ConversationWorkspace = "general",
): ConversationState {
  const validProjectId = projectId && state.projects.some((project) => project.id === projectId && project.storeId === storeId) ? projectId : undefined;
  const conversation = createConversation(storeId, welcomeMessage, validProjectId, Date.now(), workspace);
  return {
    ...state,
    activeConversationByStore: { ...state.activeConversationByStore, [storeId]: conversation.id },
    conversations: [conversation, ...state.conversations].slice(0, MAX_CONVERSATIONS),
  };
}

export function selectConversation(state: ConversationState, conversationId: string): ConversationState {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return state;
  return {
    ...state,
    activeConversationByStore: { ...state.activeConversationByStore, [conversation.storeId]: conversationId },
  };
}

export function updateConversationMessages(
  state: ConversationState,
  conversationId: string,
  updater: (messages: ChatMessage[]) => ChatMessage[],
): ConversationState {
  const now = Date.now();
  return {
    ...state,
    conversations: state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      const messages = updater(conversation.messages).slice(-MAX_MESSAGES_PER_CONVERSATION);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return {
        ...conversation,
        title: conversation.title === "新对话" && firstUserMessage
          ? conversationTitleFromMessage(firstUserMessage.content)
          : conversation.title,
        messages,
        updatedAt: now,
      };
    }),
  };
}

export function renameConversation(state: ConversationState, conversationId: string, name: string): ConversationState {
  return {
    ...state,
    conversations: state.conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, title: cleanName(name, conversation.title), updatedAt: Date.now() }
      : conversation),
  };
}

export function moveConversation(state: ConversationState, conversationId: string, projectId?: string): ConversationState {
  const conversationToMove = state.conversations.find((conversation) => conversation.id === conversationId);
  if (!conversationToMove) return state;
  const validProjectId = projectId && state.projects.some((project) => project.id === projectId && project.storeId === conversationToMove.storeId)
    ? projectId
    : undefined;
  return {
    ...state,
    conversations: state.conversations.map((conversation) => conversation.id === conversationId
      ? { ...conversation, ...(validProjectId ? { projectId: validProjectId } : { projectId: undefined }), updatedAt: Date.now() }
      : conversation),
  };
}

export function deleteConversation(
  state: ConversationState,
  conversationId: string,
  welcomeMessage: ChatMessage,
): ConversationState {
  const removed = state.conversations.find((conversation) => conversation.id === conversationId);
  if (!removed) return state;
  const remaining = state.conversations.filter((conversation) => conversation.id !== conversationId);
  const sameStoreRemaining = remaining.filter((conversation) => conversation.storeId === removed.storeId);
  if (!sameStoreRemaining.length) {
    const replacement = createConversation(removed.storeId, welcomeMessage);
    return {
      ...state,
      activeConversationByStore: { ...state.activeConversationByStore, [removed.storeId]: replacement.id },
      conversations: [replacement, ...remaining],
    };
  }
  return {
    ...state,
    activeConversationByStore: state.activeConversationByStore[removed.storeId] === conversationId
      ? { ...state.activeConversationByStore, [removed.storeId]: sameStoreRemaining[0].id }
      : state.activeConversationByStore,
    conversations: remaining,
  };
}

export function addProject(state: ConversationState, storeId: string, name: string): ConversationState {
  const now = Date.now();
  const baseName = cleanName(name, "新项目");
  const existingNames = new Set(state.projects.filter((project) => project.storeId === storeId).map((project) => project.name));
  let uniqueName = baseName;
  let suffix = 2;
  while (existingNames.has(uniqueName)) {
    uniqueName = `${baseName.slice(0, 34)} ${suffix}`;
    suffix += 1;
  }
  return {
    ...state,
    projects: [...state.projects, { id: makeId(), storeId, name: uniqueName, createdAt: now, updatedAt: now }],
  };
}

export function renameProject(state: ConversationState, projectId: string, name: string): ConversationState {
  return {
    ...state,
    projects: state.projects.map((project) => project.id === projectId
      ? { ...project, name: cleanName(name, project.name), updatedAt: Date.now() }
      : project),
  };
}

export function deleteProject(state: ConversationState, projectId: string): ConversationState {
  return {
    ...state,
    projects: state.projects.filter((project) => project.id !== projectId),
    conversations: state.conversations.map((conversation) => conversation.projectId === projectId
      ? { ...conversation, projectId: undefined, updatedAt: Date.now() }
      : conversation),
  };
}

export function formatConversationTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (isYesterday) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

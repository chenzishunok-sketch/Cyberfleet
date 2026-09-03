import { useSyncExternalStore } from "react";
import type { RunStep } from "../shared/contracts";

// 流式输出状态放在 React 外部的独立 store：
// 每个 token 只触发订阅了该 store 的聊天组件重渲染，
// 不再让 App 根组件（及其全部子树）逐 token 重渲染。
export interface ChatStreamingState {
  conversationId: string;
  steps: RunStep[];
  content: string;
}

const IDLE: ChatStreamingState = { conversationId: "", steps: [], content: "" };

let active: ChatStreamingState | undefined;
let activeController: AbortController | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}

export const chatStreaming = {
  /** 开始一轮流式输出，返回本轮请求的 AbortController */
  begin(conversationId: string): AbortController {
    activeController?.abort();
    activeController = new AbortController();
    active = { conversationId, steps: [], content: "" };
    emit();
    return activeController;
  },

  addStep(step: RunStep): void {
    if (!active) return;
    active = { ...active, steps: [...active.steps, step] };
    emit();
  },

  appendContent(delta: string): void {
    if (!active) return;
    active = { ...active, content: active.content + delta };
    emit();
  },

  /** 用户主动停止：中断请求，已生成内容仍可在 end() 时取回 */
  stop(): void {
    activeController?.abort();
  },

  /** 结束本轮流式输出，返回本轮状态（含部分生成内容）供调用方落账 */
  end(): ChatStreamingState | undefined {
    const finished = active;
    active = undefined;
    activeController = undefined;
    emit();
    return finished;
  },
};

/** 订阅指定会话的流式状态；其它会话的流返回 undefined，不渲染 */
export function useChatStreaming(conversationId: string): ChatStreamingState | undefined {
  const current = useSyncExternalStore(subscribe, () => active ?? IDLE);
  return current.conversationId === conversationId ? current : undefined;
}

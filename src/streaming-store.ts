import { useSyncExternalStore } from "react";
import type { RunStep } from "../shared/contracts";

// 流式输出状态放在 React 外部的独立 store：
// 每个 token 只触发订阅了该 store 的聊天组件重渲染，
// 不再让 App 根组件（及其全部子树）逐 token 重渲染。
export interface ChatStreamingState {
  conversationId: string;
  steps: RunStep[];
  /** 正在执行的那几步。一次 ReAct 可能并行查多个接口，所以是列表而不是单条 */
  activity: RunStep[];
  content: string;
}

const IDLE: ChatStreamingState = { conversationId: "", steps: [], activity: [], content: "" };

/** 后端用这两个固定 id 推「进行中」的临时步骤，不进入历史步骤列表 */
export const ACTIVE_STEP_IDS = new Set(["live-active", "react-active"]);
const MAX_ACTIVITY = 4;

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
    active = { conversationId, steps: [], activity: [], content: "" };
    emit();
    return activeController;
  },

  addStep(step: RunStep): void {
    if (!active) return;
    // 临时步骤只更新「当前在做什么」，不写进历史
    if (ACTIVE_STEP_IDS.has(step.id)) {
      if (active.activity.some((item) => item.label === step.label)) return;
      active = { ...active, activity: [...active.activity, step].slice(-MAX_ACTIVITY) };
      emit();
      return;
    }
    // 正式步骤到达，说明同名的那一步已经结束
    let consumed = false;
    const activity = active.activity.filter((item) => {
      if (!consumed && item.label === step.label) {
        consumed = true;
        return false;
      }
      return true;
    });
    const exists = active.steps.some((item) => item.id === step.id);
    active = {
      ...active,
      steps: exists ? active.steps.map((item) => (item.id === step.id ? step : item)) : [...active.steps, step],
      activity,
    };
    emit();
  },

  appendContent(delta: string): void {
    if (!active) return;
    active = { ...active, content: active.content + delta, activity: [] };
    emit();
  },

  /** 丢弃已推送的正文：模型先回了一句空壳、被打回重写时用，避免两段文字接在一起 */
  resetContent(): void {
    if (!active || !active.content) return;
    active = { ...active, content: "" };
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

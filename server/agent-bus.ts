import { EventEmitter } from "node:events";
import type { AgentContext } from "../shared/digital-employees.ts";
import { agentRegistry, type AgentInstance } from "./agent-registry.ts";

// ─── 事件类型 ──────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  from: AgentContext;
  to: AgentContext;
  type: "task" | "query" | "result" | "notification";
  content: string;
  /** 关联的任务/对话 ID */
  correlationId?: string;
  timestamp: number;
}

export interface AgentStateEvent {
  agentId: AgentContext;
  state: "idle" | "working" | "waiting";
  task?: string;
  timestamp: number;
}

export interface DelegationRequest {
  from: AgentContext;
  to: AgentContext;
  task: string;
  /** 委派上下文：原始用户消息、历史等 */
  context?: string;
  /** 发起委派请求所属店铺，透传给被委派 Agent 的模拟请求 */
  storeId?: string;
  correlationId?: string;
}

export interface DelegationResult {
  from: AgentContext;
  to: AgentContext;
  success: boolean;
  content: string;
  correlationId?: string;
  timestamp: number;
}

// ─── Agent 事件总线事件表 ─────────────────────────────────────

type AgentBusEvents = {
  "agent:message": [AgentMessage];
  "agent:state-changed": [AgentStateEvent];
  "agent:delegation": [DelegationRequest];
  "agent:delegation-result": [DelegationResult];
};

// ─── Agent 事件总线 ────────────────────────────────────────────

class AgentBus extends EventEmitter {
  private messageLog: AgentMessage[] = [];
  private readonly maxLogSize = 200;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** 发送消息：一个 Agent 向另一个 Agent 发送消息 */
  sendMessage(from: AgentContext, to: AgentContext, type: AgentMessage["type"], content: string, correlationId?: string): AgentMessage {
    const message: AgentMessage = {
      id: `${from}-${to}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      to,
      type,
      content,
      correlationId,
      timestamp: Date.now(),
    };
    this.messageLog.push(message);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog = this.messageLog.slice(-this.maxLogSize);
    }
    this.emit("agent:message", message);
    return message;
  }

  /** 广播状态变更 */
  broadcastStateChange(agentId: AgentContext, state: AgentStateEvent["state"], task?: string): void {
    const event: AgentStateEvent = { agentId, state, task, timestamp: Date.now() };
    this.emit("agent:state-changed", event);
  }

  /** 发起委派：一个 Agent 请求另一个 Agent 执行任务 */
  delegate(request: DelegationRequest): void {
    this.emit("agent:delegation", request);
  }

  /** 报告委派结果 */
  reportDelegationResult(result: DelegationResult): void {
    this.emit("agent:delegation-result", result);
  }

  /** 获取消息日志（用于审计/可观测性） */
  getMessageLog(filter?: { from?: AgentContext; to?: AgentContext }): AgentMessage[] {
    if (!filter) return [...this.messageLog];
    return this.messageLog.filter(
      (m) =>
        (!filter.from || m.from === filter.from) &&
        (!filter.to || m.to === filter.to),
    );
  }

  /** 获取两个 Agent 之间的对话记录 */
  getConversation(a: AgentContext, b: AgentContext): AgentMessage[] {
    return this.messageLog.filter(
      (m) => (m.from === a && m.to === b) || (m.from === b && m.to === a),
    );
  }

  /** 清空日志（测试用） */
  clearLog(): void {
    this.messageLog = [];
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const agentBus = new AgentBus();

// ─── 委派执行器：处理跨 Agent 任务委派 ─────────────────────────

/**
 * 委派处理器注册表。
 * 每个 Agent 可以注册自己的委派处理函数，
 * 当其他 Agent 向它委派任务时被调用。
 */
type DelegationHandler = (request: DelegationRequest) => Promise<DelegationResult>;

const delegationHandlers = new Map<AgentContext, DelegationHandler>();

/**
 * 注册 Agent 的委派处理器。
 * 当其他 Agent 向该 Agent 委派任务时，调用此处理器。
 */
export function registerDelegationHandler(agentId: AgentContext, handler: DelegationHandler): void {
  delegationHandlers.set(agentId, handler);
}

/**
 * 执行跨 Agent 委派。
 * 1. 通过 agentBus 广播委派请求
 * 2. 调用目标 Agent 的委派处理器
 * 3. 广播委派结果
 * 4. 返回结果
 */
export async function executeDelegation(
  from: AgentContext,
  to: AgentContext,
  task: string,
  context?: string,
  correlationId?: string,
  storeId?: string,
): Promise<DelegationResult> {
  const request: DelegationRequest = { from, to, task, context, correlationId, storeId };
  agentBus.delegate(request);

  // 标记目标 Agent 开始工作
  agentRegistry.startWork(to, task.slice(0, 80));

  const handler = delegationHandlers.get(to);
  let result: DelegationResult;

  if (handler) {
    try {
      result = await handler(request);
    } catch (error) {
      result = {
        from,
        to,
        success: false,
        content: `委派执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        correlationId,
        timestamp: Date.now(),
      };
    }
  } else {
    // 没有注册处理器的 Agent，返回提示
    result = {
      from,
      to,
      success: false,
      content: `Agent ${to} 尚未注册委派处理器，无法执行委派任务。`,
      correlationId,
      timestamp: Date.now(),
    };
  }

  // 标记目标 Agent 工作完成
  agentRegistry.completeWork(to);

  // 发送结果消息
  agentBus.sendMessage(to, from, "result", result.content, correlationId);
  agentBus.reportDelegationResult(result);

  return result;
}

/**
 * 获取所有活跃 Agent 的协作概览。
 * 用于 API 端点 /api/agents/collaboration
 */
export function getCollaborationOverview(): {
  activeAgents: AgentInstance[];
  recentMessages: AgentMessage[];
  delegationHandlers: AgentContext[];
} {
  return {
    activeAgents: agentRegistry.getActiveAgents(),
    recentMessages: agentBus.getMessageLog().slice(-20),
    delegationHandlers: Array.from(delegationHandlers.keys()),
  };
}

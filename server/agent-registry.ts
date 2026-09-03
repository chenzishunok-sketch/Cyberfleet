import type { AgentContext, DigitalEmployee } from "../shared/digital-employees.ts";
import { getDigitalEmployee } from "../shared/digital-employees.ts";
import { agentBus } from "./agent-bus.ts";

// ─── Agent 运行时状态 ──────────────────────────────────────────

export type AgentState = "idle" | "working" | "waiting";

export interface AgentInstance {
  /** Agent 身份标识，对应 DigitalEmployee.id */
  readonly id: AgentContext;
  /** Agent 元数据声明（静态） */
  readonly employee: DigitalEmployee;
  /** 当前运行时状态 */
  state: AgentState;
  /** 最近一次活跃时间戳 */
  lastActiveAt: number;
  /** 当前正在处理的任务描述（用于可观测性） */
  currentTask?: string;
  /** 已处理的对话轮次 */
  turnCount: number;
  /** 累计 LLM token 消耗（粗略估计，用于成本追踪） */
  tokenUsage: number;
}

// ─── Agent 注册中心 ────────────────────────────────────────────

class AgentRegistry {
  private instances = new Map<AgentContext, AgentInstance>();

  /** 获取或创建 Agent 实例 */
  getInstance(context: AgentContext): AgentInstance {
    let instance = this.instances.get(context);
    if (!instance) {
      const employee = getDigitalEmployee(context);
      instance = {
        id: context,
        employee,
        state: "idle",
        lastActiveAt: Date.now(),
        turnCount: 0,
        tokenUsage: 0,
      };
      this.instances.set(context, instance);
    }
    return instance;
  }

  /** 标记 Agent 开始工作 */
  startWork(context: AgentContext, task: string): AgentInstance {
    const instance = this.getInstance(context);
    instance.state = "working";
    instance.currentTask = task;
    instance.lastActiveAt = Date.now();
    instance.turnCount += 1;
    agentBus.broadcastStateChange(context, "working", task);
    return instance;
  }

  /** 标记 Agent 工作完成 */
  completeWork(context: AgentContext): AgentInstance {
    const instance = this.getInstance(context);
    instance.state = "idle";
    instance.currentTask = undefined;
    instance.lastActiveAt = Date.now();
    agentBus.broadcastStateChange(context, "idle");
    return instance;
  }

  /** 标记 Agent 等待用户输入 */
  setWaiting(context: AgentContext, task: string): AgentInstance {
    const instance = this.getInstance(context);
    instance.state = "waiting";
    instance.currentTask = task;
    instance.lastActiveAt = Date.now();
    agentBus.broadcastStateChange(context, "waiting", task);
    return instance;
  }

  /** 记录 token 消耗 */
  recordTokenUsage(context: AgentContext, tokens: number): void {
    const instance = this.getInstance(context);
    instance.tokenUsage += tokens;
  }

  /**
   * 获取 Agent 允许使用的工具名称列表。
   * "*" 表示拥有全部工具权限（仅运营总监）。
   */
  getAllowedToolNames(context: AgentContext): readonly string[] {
    return this.getInstance(context).employee.allowedTools;
  }

  /**
   * 按 Agent 能力过滤工具定义。
   * 输入完整的工具定义数组，返回该 Agent 有权使用的子集。
   */
  filterToolsForAgent<T extends { function: { name: string } }>(
    context: AgentContext,
    allTools: readonly T[],
  ): T[] {
    const allowed = this.getAllowedToolNames(context);
    if (allowed.includes("*")) {
      return [...allTools];
    }
    const allowedSet = new Set(allowed);
    return allTools.filter((tool) => allowedSet.has(tool.function.name));
  }

  /**
   * 生成 Agent 能力描述文本，注入到 system prompt 中。
   * 告诉 LLM 当前角色拥有哪些工具，以及哪些超出其职责范围。
   */
  getCapabilityPrompt(context: AgentContext): string {
    const instance = this.getInstance(context);
    const { employee } = instance;
    const allowed = employee.allowedTools;

    const toolList = allowed.includes("*")
      ? "全部工具（运营总监拥有完整权限）"
      : allowed.join("、");

    const stateHint =
      instance.state === "working"
        ? `当前正在处理：${instance.currentTask ?? "任务执行中"}`
        : instance.state === "waiting"
          ? `当前等待用户输入：${instance.currentTask ?? "等待确认"}`
          : "当前空闲，可以接受新任务";

    return `\n[Agent 实例信息]
身份：${employee.name}
职责：${employee.description}
可用工具：${toolList}
运行状态：${stateHint}
已处理轮次：${instance.turnCount}

注意：你只能使用上述列出的工具。如果用户请求超出你的工具范围，请告知用户并建议切换到运营总监 Agent 处理。`;
  }

  /** 列出所有已实例化的 Agent */
  listInstances(): AgentInstance[] {
    return Array.from(this.instances.values());
  }

  /** 获取当前正在工作的 Agent 列表 */
  getActiveAgents(): AgentInstance[] {
    return this.listInstances().filter((a) => a.state === "working");
  }

  /** 获取系统概览快照（用于 API 端点 / 可观测性） */
  getSnapshot(): Array<{
    id: AgentContext;
    name: string;
    state: AgentState;
    currentTask?: string;
    turnCount: number;
    tokenUsage: number;
    lastActiveAt: number;
  }> {
    return this.listInstances().map((a) => ({
      id: a.id,
      name: a.employee.name,
      state: a.state,
      currentTask: a.currentTask,
      turnCount: a.turnCount,
      tokenUsage: a.tokenUsage,
      lastActiveAt: a.lastActiveAt,
    }));
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const agentRegistry = new AgentRegistry();

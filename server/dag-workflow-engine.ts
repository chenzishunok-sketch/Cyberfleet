import { randomUUID } from "node:crypto";
import type {
  DagDefinition,
  DagNodeDef,
  DagNodeInstance,
  DagWorkflowRun,
  WorkflowStatus,
} from "../shared/contracts.ts";

// ─── 执行器注册表 ──────────────────────────────────────────────

/**
 * 任务执行器函数签名。
 * 接收输入数据和上下文，返回输出数据。
 */
export type DagExecutorFn = (
  input: Record<string, unknown>,
  context: DagExecutionContext,
) => Promise<Record<string, unknown>>;

export interface DagExecutionContext {
  runId: string;
  /** 所有已完成节点的输出数据（按节点 ID 索引） */
  outputs: Record<string, Record<string, unknown>>;
  /** 原始输入参数 */
  input: Record<string, unknown>;
}

const executors = new Map<string, DagExecutorFn>();

/** 注册任务执行器 */
export function registerExecutor(name: string, fn: DagExecutorFn): void {
  executors.set(name, fn);
}

/** 获取已注册的执行器名称列表 */
export function listExecutors(): string[] {
  return Array.from(executors.keys());
}

// ─── 条件评估器 ────────────────────────────────────────────────

/**
 * 简单条件评估器。
 * 支持的表达式格式：
 * - "output.field == value"  等值比较
 * - "output.field != value"  不等比较
 * - "output.field > value"   大于
 * - "output.field < value"   小于
 * - "true"                   恒真
 * - "false"                  恒假
 */
function evaluateCondition(
  condition: string,
  outputs: Record<string, Record<string, unknown>>,
): boolean {
  const trimmed = condition.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // 解析 "nodeId.field OP value" 格式
  const match = trimmed.match(/^(\w+)\.(\w+)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
  if (!match) {
    // 默认：非空字符串为真
    return trimmed.length > 0;
  }
  const [, nodeId, field, op, valueStr] = match;
  const nodeOutput = outputs[nodeId];
  if (!nodeOutput) return false;
  const actual = nodeOutput[field];
  const expected = valueStr.trim().replace(/^["']|["']$/g, "");

  switch (op) {
    case "==": return String(actual) === expected;
    case "!=": return String(actual) !== expected;
    case ">": return Number(actual) > Number(expected);
    case "<": return Number(actual) < Number(expected);
    case ">=": return Number(actual) >= Number(expected);
    case "<=": return Number(actual) <= Number(expected);
    default: return false;
  }
}

// ─── DAG 引擎 ──────────────────────────────────────────────────

class DagWorkflowEngine {
  /** 从定义创建一个新的 DAG 运行实例 */
  create(definition: DagDefinition, input: Record<string, unknown>, title?: string): DagWorkflowRun {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      type: "dag",
      title: title ?? definition.name,
      status: "draft",
      definition,
      nodeStates: definition.nodes.map((node) => ({
        id: node.id,
        state: "pending" as DagNodeInstance["state"],
      })),
      input,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 执行 DAG 工作流。
   * 从入口节点开始，按拓扑顺序执行。
   * 遇到 human_gate 节点时暂停，返回等待确认。
   */
  async run(run: DagWorkflowRun): Promise<DagWorkflowRun> {
    let current = { ...run, nodeStates: [...run.nodeStates], status: "running" as WorkflowStatus };
    current = this.touch(current);

    const entryNode = this.getNode(current.definition, current.definition.entry);
    if (!entryNode) {
      return this.fail(current, `入口节点 ${current.definition.entry} 不存在`);
    }

    // 从入口节点开始执行
    current = await this.executeNode(current, entryNode);
    return current;
  }

  /**
   * 批准 human_gate 节点，继续执行。
   */
  async approve(run: DagWorkflowRun): Promise<DagWorkflowRun> {
    if (!run.pendingConfirmation) {
      return run;
    }
    let current = { ...run, nodeStates: [...run.nodeStates] };
    const { nodeId } = run.pendingConfirmation;
    const node = this.getNode(current.definition, nodeId);
    if (!node) {
      return this.fail(current, `节点 ${nodeId} 不存在`);
    }

    // 标记 human_gate 完成
    current = this.setNodeState(current, nodeId, "completed", { detail: "用户已确认" });
    current.pendingConfirmation = undefined;
    // 恢复执行状态，否则 executeNext 会被 waiting_confirmation 拦截
    current.status = "running";
    current = this.touch(current);

    // 继续执行后续节点
    current = await this.executeNext(current, node);
    return current;
  }

  /** 重试失败节点 */
  async retry(run: DagWorkflowRun): Promise<DagWorkflowRun> {
    const failedNode = run.nodeStates.find((n) => n.state === "failed");
    if (!failedNode) return run;

    let current = { ...run, nodeStates: [...run.nodeStates], status: "running" as WorkflowStatus };
    current = this.setNodeState(current, failedNode.id, "pending");
    current.error = undefined;
    current = this.touch(current);

    const node = this.getNode(current.definition, failedNode.id);
    if (!node) return current;
    current = await this.executeNode(current, node);
    return current;
  }

  // ─── 内部方法 ────────────────────────────────────────────────

  private touch(run: DagWorkflowRun): DagWorkflowRun {
    return { ...run, updatedAt: new Date().toISOString() };
  }

  private getNode(def: DagDefinition, nodeId: string): DagNodeDef | undefined {
    return def.nodes.find((n) => n.id === nodeId);
  }

  private getNodeInstance(run: DagWorkflowRun, nodeId: string): DagNodeInstance | undefined {
    return run.nodeStates.find((n) => n.id === nodeId);
  }

  private setNodeState(
    run: DagWorkflowRun,
    nodeId: string,
    state: DagNodeInstance["state"],
    patch?: Partial<DagNodeInstance>,
  ): DagWorkflowRun {
    const nodeStates = run.nodeStates.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            state,
            ...(patch ?? {}),
            ...(state === "running" ? { startedAt: new Date().toISOString() } : {}),
            ...(state === "completed" || state === "failed" ? { completedAt: new Date().toISOString() } : {}),
          }
        : n,
    );
    return { ...run, nodeStates };
  }

  private getOutputs(run: DagWorkflowRun): Record<string, Record<string, unknown>> {
    const outputs: Record<string, Record<string, unknown>> = {};
    for (const node of run.nodeStates) {
      if (node.output) outputs[node.id] = node.output;
    }
    return outputs;
  }

  private fail(run: DagWorkflowRun, error: string): DagWorkflowRun {
    return { ...this.touch(run), status: "failed", error };
  }

  private complete(run: DagWorkflowRun, summary: string): DagWorkflowRun {
    // 防御：存在失败节点时不得把整体状态覆盖为 completed，避免「completed + 节点 failed」矛盾
    if (run.nodeStates.some((n) => n.state === "failed")) {
      return this.fail(run, "工作流中存在失败节点，整体未完成");
    }
    return {
      ...this.touch(run),
      status: "completed",
      result: { success: true, summary },
    };
  }

  /** 执行单个节点 */
  private async executeNode(
    run: DagWorkflowRun,
    node: DagNodeDef,
    options?: { followOutEdges?: boolean },
  ): Promise<DagWorkflowRun> {
    let current = this.setNodeState(run, node.id, "running");
    current.activeNodeId = node.id;
    current = this.touch(current);

    try {
      switch (node.type) {
        case "task": {
          const executor = node.executor ? executors.get(node.executor) : undefined;
          if (!executor) {
            return this.fail(current, `执行器 ${node.executor ?? "(未指定)"} 未注册`);
          }
          const outputs = this.getOutputs(current);
          const result = await executor(current.input, { runId: current.id, outputs, input: current.input });
          current = this.setNodeState(current, node.id, "completed", { output: result, detail: `执行完成` });
          break;
        }
        case "gate": {
          // 评估条件，决定走哪条边
          current = this.setNodeState(current, node.id, "completed", { detail: "条件评估完成" });
          break;
        }
        case "parallel": {
          // 并行执行所有分支
          if (!node.branches) {
            return this.fail(current, `并行节点 ${node.id} 缺少 branches 定义`);
          }
          const branchResults = await Promise.all(
            node.branches.map(async (branchNodeIds) => {
              let branchRun = current;
              // 分支节点执行时不沿出边继续（followOutEdges: false），
              // 分支链的推进完全由 branches 数组控制，避免分支节点各自把 join/gate 重跑一遍
              for (const branchNodeId of branchNodeIds) {
                const branchNode = this.getNode(current.definition, branchNodeId);
                if (!branchNode) continue;
                branchRun = await this.executeNode(branchRun, branchNode, { followOutEdges: false });
              }
              // 检查整条分支链上所有节点的执行结果，任一失败即分支失败
              for (const branchNodeId of branchNodeIds) {
                const branchState = branchRun.nodeStates.find((n) => n.id === branchNodeId);
                if (branchState?.state === "failed") {
                  return { branchNodeId, success: false, run: branchRun };
                }
              }
              return { branchNodeId: branchNodeIds[branchNodeIds.length - 1], success: true, run: branchRun };
            }),
          );
          // 更新当前 run 的节点状态：每个分支 run 都携带全部节点的初始 pending 状态，
          // 只有该节点所属分支的执行结果是非 pending，因此逐分支查找非 pending 实例
          const updatedNodeStates = current.nodeStates.map((n) => {
            for (const { run: branchRun } of branchResults) {
              if (!branchRun) continue;
              const branchNodeState = branchRun.nodeStates.find((ns) => ns.id === n.id);
              if (branchNodeState && branchNodeState.state !== "pending") return branchNodeState;
            }
            return n;
          });
          current = { ...current, nodeStates: updatedNodeStates };
          // 任一分支失败即整体失败：合并结果时禁止吞掉失败继续推进
          const failedBranch = branchResults.find((r) => !r.success);
          if (failedBranch) {
            current = this.setNodeState(current, node.id, "failed", {
              error: `分支 ${failedBranch.branchNodeId} 执行失败`,
            });
            const failedState = current.nodeStates.find((n) => n.id === failedBranch.branchNodeId && n.state === "failed");
            const reason = failedState?.error ? `：${failedState.error}` : "";
            return this.fail(current, `并行节点 ${node.label} 的分支 ${failedBranch.branchNodeId} 执行失败${reason}`);
          }
          current = this.setNodeState(current, node.id, "completed", { detail: `${node.branches.length} 个并行分支完成` });
          break;
        }
        case "join": {
          current = this.setNodeState(current, node.id, "completed", { detail: "汇聚完成" });
          break;
        }
        case "human_gate": {
          // 暂停，等待用户确认
          current = this.setNodeState(current, node.id, "waiting", { detail: node.prompt ?? "等待用户确认" });
          current.status = "waiting_confirmation";
          current.pendingConfirmation = {
            nodeId: node.id,
            kind: node.confirmationKind ?? "default",
            prompt: node.prompt ?? "请确认是否继续",
          };
          current = this.touch(current);
          return current;
        }
      }
    } catch (error) {
      current = this.setNodeState(current, node.id, "failed", {
        error: error instanceof Error ? error.message : "未知错误",
      });
      return this.fail(current, `节点 ${node.label} 执行失败：${error instanceof Error ? error.message : "未知错误"}`);
    }

    // 继续执行下一个节点（parallel 分支内的节点不沿出边继续，由分支循环统一推进）
    if (options?.followOutEdges === false) {
      return current;
    }
    return this.executeNext(current, node);
  }

  /** 执行后续节点 */
  private async executeNext(run: DagWorkflowRun, completedNode: DagNodeDef): Promise<DagWorkflowRun> {
    // 如果已经失败或等待确认，不再继续
    if (run.status === "failed" || run.status === "waiting_confirmation") {
      return run;
    }

    // 找到当前节点的出边
    const outEdges = run.definition.edges.filter((e) => e.from === completedNode.id);
    if (outEdges.length === 0) {
      // 没有后续节点，工作流完成
      return this.complete(run, `工作流 ${run.title} 执行完成`);
    }

    // 如果是 gate 节点，评估条件选择分支
    if (completedNode.type === "gate") {
      const outputs = this.getOutputs(run);
      for (const edge of outEdges) {
        if (edge.condition && evaluateCondition(edge.condition, outputs)) {
          const nextNode = this.getNode(run.definition, edge.to);
          if (nextNode) {
            return this.executeNode(run, nextNode);
          }
        }
      }
      // 没有条件匹配，走无条件边
      const defaultEdge = outEdges.find((e) => !e.condition);
      if (defaultEdge) {
        const nextNode = this.getNode(run.definition, defaultEdge.to);
        if (nextNode) return this.executeNode(run, nextNode);
      }
      return this.complete(run, `条件门控 ${completedNode.label} 无匹配分支，工作流结束`);
    }

    // 普通节点：执行所有出边指向的节点（通常只有一个）
    for (const edge of outEdges) {
      const nextNode = this.getNode(run.definition, edge.to);
      if (nextNode) {
        // 跳过已完成或已跳过的节点
        const nextState = this.getNodeInstance(run, nextNode.id)?.state;
        if (nextState === "completed" || nextState === "skipped") continue;
        return this.executeNode(run, nextNode);
      }
    }

    // 所有后续节点已完成
    return this.complete(run, `工作流 ${run.title} 执行完成`);
  }
}

// ─── 单例导出 ──────────────────────────────────────────────────

export const dagWorkflowEngine = new DagWorkflowEngine();

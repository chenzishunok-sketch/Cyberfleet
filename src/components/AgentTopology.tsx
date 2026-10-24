import { useEffect, useRef, useState } from "react";
import { Activity, Radio, Zap } from "lucide-react";
import { DIGITAL_EMPLOYEES, getDigitalEmployee, type AgentContext } from "../../shared/digital-employees";
import { API_BASE } from "../api";

// ─── 事件类型 ──────────────────────────────────────────────────

interface AgentSnapshot {
  id: AgentContext;
  name: string;
  state: "idle" | "working" | "waiting";
  currentTask?: string;
  turnCount: number;
  tokenUsage: number;
  lastActiveAt: number;
}

interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  totalCompleted: number;
  avgDurationMs: number;
  activeAgents: number;
  maxConcurrency: number;
}

interface TaskRecord {
  id: string;
  agent: AgentContext;
  description: string;
  priority: string;
  status: string;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

interface AgentMessage {
  id: string;
  from: AgentContext;
  to: AgentContext;
  type: string;
  content: string;
  timestamp: number;
}

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

// ─── 拓扑布局 ──────────────────────────────────────────────────

const VIEWBOX = 600;
const CENTER = VIEWBOX / 2;
const RADIUS = 200;

interface NodePosition {
  agent: AgentContext;
  x: number;
  y: number;
}

const topologyNodes: NodePosition[] = DIGITAL_EMPLOYEES.map((employee) => {
  if (employee.id === "general") {
    return { agent: employee.id, x: CENTER, y: CENTER };
  }
  // 非 general 的 Agent 围成圆形
  const others = DIGITAL_EMPLOYEES.filter((e) => e.id !== "general");
  const idx = others.indexOf(employee);
  const angle = (idx / others.length) * Math.PI * 2 - Math.PI / 2;
  return {
    agent: employee.id,
    x: CENTER + RADIUS * Math.cos(angle),
    y: CENTER + RADIUS * Math.sin(angle),
  };
});

// ─── 组件 ──────────────────────────────────────────────────────

interface AgentTopologyProps {
  /** 是否展开（当作为独立页面时为 true） */
  embedded?: boolean;
}

export function AgentTopology({ embedded = false }: AgentTopologyProps) {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [runningTasks, setRunningTasks] = useState<TaskRecord[]>([]);
  const [queuedTasks, setQueuedTasks] = useState<TaskRecord[]>([]);
  const [recentEvents, setRecentEvents] = useState<Array<{ type: string; text: string; time: number }>>([]);
  const [activeEdges, setActiveEdges] = useState<Map<string, number>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(API_BASE + "/api/agents/stream");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StreamEvent;
        handleEvent(data);
      } catch {
        // 忽略解析错误
      }
    };

    es.onerror = () => {
      // EventSource 会自动重连
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addRecentEvent(type: string, text: string): void {
    setRecentEvents((prev) => {
      const next = [{ type, text, time: Date.now() }, ...prev].slice(0, 30);
      return next;
    });
  }

  function pulseEdge(from: AgentContext, to: AgentContext): void {
    const key = `${from}->${to}`;
    setActiveEdges((prev) => {
      const next = new Map(prev);
      next.set(key, Date.now());
      return next;
    });
    // 2 秒后清除
    setTimeout(() => {
      setActiveEdges((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }, 2000);
  }

  function handleEvent(data: StreamEvent): void {
    switch (data.type) {
      case "snapshot": {
        setAgents((data.agents as AgentSnapshot[]) ?? []);
        setQueueStats((data.queueStats as QueueStats) ?? null);
        setRunningTasks((data.runningTasks as TaskRecord[]) ?? []);
        setQueuedTasks((data.queuedTasks as TaskRecord[]) ?? []);
        break;
      }
      case "agent:message": {
        const msg = data.message as AgentMessage;
        if (msg && msg.from && msg.to) {
          pulseEdge(msg.from, msg.to);
          addRecentEvent("message", `${getDigitalEmployee(msg.from).shortName} → ${getDigitalEmployee(msg.to).shortName}：${msg.content.slice(0, 50)}`);
        }
        break;
      }
      case "agent:state-changed": {
        const event = data.event as { agentId: AgentContext; state: string; task?: string };
        if (event) {
          const labels: Record<string, string> = { idle: "空闲", working: "开始工作", waiting: "等待输入" };
          addRecentEvent("state", `${getDigitalEmployee(event.agentId).shortName} ${labels[event.state] ?? event.state}${event.task ? `：${event.task.slice(0, 40)}` : ""}`);
        }
        break;
      }
      case "agent:delegation": {
        const req = data.request as { from: AgentContext; to: AgentContext; task: string };
        if (req) {
          pulseEdge(req.from, req.to);
          addRecentEvent("delegation", `${getDigitalEmployee(req.from).shortName} 委派 → ${getDigitalEmployee(req.to).shortName}：${req.task.slice(0, 40)}`);
        }
        break;
      }
      case "task:queued": {
        const task = data.task as TaskRecord;
        if (task) addRecentEvent("queued", `任务入队：${task.description.slice(0, 50)}`);
        break;
      }
      case "task:started": {
        const task = data.task as TaskRecord;
        if (task) addRecentEvent("started", `开始执行：${task.description.slice(0, 50)}`);
        break;
      }
      case "task:done": {
        const task = data.task as TaskRecord;
        if (task) addRecentEvent("done", `任务完成：${task.description.slice(0, 50)}`);
        break;
      }
      case "task:failed": {
        const task = data.task as TaskRecord;
        if (task) addRecentEvent("failed", `任务失败：${task.description.slice(0, 50)}${task.error ? `（${task.error.slice(0, 30)}）` : ""}`);
        break;
      }
    }
  }

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const now = Date.now();

  return (
    <main className="page-content topology-page">
      <header className="topology-header">
        <div>
          <h1>Agent 协作拓扑</h1>
          <p>实时展示数字员工的协作状态、消息流和任务执行进度。</p>
        </div>
        <div className="topology-live-badge">
          <Radio size={14} className="topology-live-pulse" />
          <span>实时</span>
        </div>
      </header>

      <div className={`topology-grid ${embedded ? "embedded" : ""}`}>
        {/* 左侧：SVG 拓扑图 */}
        <section className="topology-canvas-section">
          <div className="topology-canvas-wrapper">
            <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} className="topology-svg" role="img" aria-label="Agent 协作拓扑图">
              <defs>
                <marker id="arrow-topology" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M1 1 L7 4 L1 7 Z" fill="var(--brand, #6366f1)" />
                </marker>
              </defs>

              {/* 静态连接线（general 到所有其他 Agent） */}
              {topologyNodes
                .filter((n) => n.agent !== "general")
                .map((node) => {
                  const center = topologyNodes.find((n) => n.agent === "general")!;
                  return (
                    <line
                      key={`static-${node.agent}`}
                      x1={center.x}
                      y1={center.y}
                      x2={node.x}
                      y2={node.y}
                      className="topology-edge-static"
                    />
                  );
                })}

              {/* 活跃边（消息流） */}
              {[...activeEdges.entries()].map(([key, timestamp]) => {
                const [fromId, toId] = key.split("->") as [AgentContext, AgentContext];
                const from = topologyNodes.find((n) => n.agent === fromId);
                const to = topologyNodes.find((n) => n.agent === toId);
                if (!from || !to) return null;
                const age = now - timestamp;
                const opacity = Math.max(0.2, 1 - age / 2000);
                return (
                  <line
                    key={`active-${key}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    className="topology-edge-active"
                    style={{ opacity }}
                    markerEnd="url(#arrow-topology)"
                  />
                );
              })}

              {/* Agent 节点 */}
              {topologyNodes.map((node) => {
                const employee = getDigitalEmployee(node.agent);
                const snapshot = agentMap.get(node.agent);
                const state = snapshot?.state ?? "idle";
                const isCenter = node.agent === "general";
                const r = isCenter ? 42 : 32;
                return (
                  <g key={node.agent} transform={`translate(${node.x}, ${node.y})`}>
                    <circle
                      r={r}
                      className={`topology-node topology-node-${state}`}
                    />
                    {state === "working" && (
                      <circle r={r + 6} className="topology-node-pulse" />
                    )}
                    <text
                      y={r + 16}
                      textAnchor="middle"
                      className="topology-node-label"
                    >
                      {employee.shortName}
                    </text>
                    {snapshot?.currentTask && state === "working" && (
                      <text
                        y={r + 30}
                        textAnchor="middle"
                        className="topology-node-task"
                      >
                        {snapshot.currentTask.slice(0, 12)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {/* 图例 */}
          <div className="topology-legend">
            <span className="topology-legend-item">
              <span className="topology-legend-dot topology-node-idle" /> 空闲
            </span>
            <span className="topology-legend-item">
              <span className="topology-legend-dot topology-node-working" /> 工作中
            </span>
            <span className="topology-legend-item">
              <span className="topology-legend-dot topology-node-waiting" /> 等待中
            </span>
            <span className="topology-legend-item">
              <span className="topology-legend-line" /> 消息流
            </span>
          </div>
        </section>

        {/* 右侧：任务队列 + 事件流 */}
        <aside className="topology-sidebar">
          {/* 任务队列统计 */}
          <div className="topology-card">
            <div className="topology-card-header">
              <Zap size={16} />
              <h3>任务队列</h3>
            </div>
            {queueStats ? (
              <div className="topology-stats-grid">
                <div className="topology-stat">
                  <span className="topology-stat-value topology-stat-running">{queueStats.running}</span>
                  <span className="topology-stat-label">执行中</span>
                </div>
                <div className="topology-stat">
                  <span className="topology-stat-value topology-stat-queued">{queueStats.queued}</span>
                  <span className="topology-stat-label">排队</span>
                </div>
                <div className="topology-stat">
                  <span className="topology-stat-value topology-stat-done">{queueStats.done}</span>
                  <span className="topology-stat-label">已完成</span>
                </div>
                <div className="topology-stat">
                  <span className="topology-stat-value topology-stat-failed">{queueStats.failed}</span>
                  <span className="topology-stat-label">失败</span>
                </div>
                <div className="topology-stat topology-stat-wide">
                  <span className="topology-stat-value">{queueStats.maxConcurrency}</span>
                  <span className="topology-stat-label">并发上限</span>
                </div>
                <div className="topology-stat topology-stat-wide">
                  <span className="topology-stat-value">{queueStats.avgDurationMs}ms</span>
                  <span className="topology-stat-label">平均耗时</span>
                </div>
              </div>
            ) : (
              <p className="topology-empty">等待数据...</p>
            )}

            {/* 正在执行的任务 */}
            {runningTasks.length > 0 && (
              <div className="topology-task-list">
                <h4>正在执行</h4>
                {runningTasks.slice(0, 5).map((task) => (
                  <div key={task.id} className="topology-task-item topology-task-running">
                    <span className="topology-task-agent">{getDigitalEmployee(task.agent).shortName}</span>
                    <span className="topology-task-desc">{task.description.slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 排队中的任务 */}
            {queuedTasks.length > 0 && (
              <div className="topology-task-list">
                <h4>排队等待</h4>
                {queuedTasks.slice(0, 5).map((task) => (
                  <div key={task.id} className="topology-task-item topology-task-queued">
                    <span className="topology-task-agent">{getDigitalEmployee(task.agent).shortName}</span>
                    <span className="topology-task-desc">{task.description.slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 实时事件流 */}
          <div className="topology-card topology-event-feed">
            <div className="topology-card-header">
              <Activity size={16} />
              <h3>事件流</h3>
            </div>
            {recentEvents.length === 0 ? (
              <p className="topology-empty">等待事件...</p>
            ) : (
              <ul className="topology-event-list">
                {recentEvents.map((event, index) => (
                  <li key={index} className={`topology-event topology-event-${event.type}`}>
                    <span className="topology-event-time">
                      {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(event.time)}
                    </span>
                    <span className="topology-event-text">{event.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

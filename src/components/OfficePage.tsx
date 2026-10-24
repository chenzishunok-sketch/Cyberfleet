import { useEffect, useRef, useState } from "react";
import { Activity, Check, Clock3, LoaderCircle, UsersRound } from "lucide-react";
import type { OfficeSnapshot } from "../../shared/contracts";
import type { AgentState } from "@/types/agent";
import { api, API_BASE } from "../api";
import type { ViewId } from "./Sidebar";
import { OfficeScene } from "@/scene/OfficeScene";

/** 后端运行时状态 → 场景动画状态 */
function toSceneState(state: OfficeSnapshot["agents"][number]["state"]): AgentState {
  if (state === "working") return "working";
  if (state === "waiting") return "thinking";
  return "idle";
}

/** 点击数字员工时跳转到其对应工作台（无法映射的员工回到数字员工中心） */
const AGENT_HOME_VIEW: Partial<Record<string, ViewId>> = {
  general: "chat",
  kol: "kol_chat",
  content: "content_create",
};

export function OfficePage({ onSelectAgent }: { onSelectAgent?: (view: ViewId) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const initializedRef = useRef(false);
  const liveEnabledRef = useRef(false);
  const lastPushedRef = useRef(new Map<string, string>());
  const selectAgentRef = useRef(onSelectAgent);
  selectAgentRef.current = onSelectAgent;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);

  // 场景初始化
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new OfficeScene({
      onAgentClick: (event) => {
        const view = AGENT_HOME_VIEW[event.agent.id] ?? "employees";
        selectAgentRef.current?.(view);
      },
    });
    sceneRef.current = scene;
    let disposed = false;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;

      if (!initializedRef.current) {
        initializedRef.current = true;
        void scene.init(host, width, height)
          .then(() => {
            if (!disposed) setStatus("ready");
          })
          .catch((error) => {
            console.error("办公室动画加载失败", error);
            if (!disposed) setStatus("error");
          });
        return;
      }

      scene.resize(width, height);
    });

    observer.observe(host);
    return () => {
      disposed = true;
      observer.disconnect();
      initializedRef.current = false;
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  // 真实数据：初始拉取 + SSE 订阅（与 Agent 拓扑图共用同一条事件流）
  useEffect(() => {
    let disposed = false;

    api.office()
      .then((initial) => {
        if (!disposed) setSnapshot(initial);
      })
      .catch((error) => {
        console.error("办公室状态加载失败", error);
      });

    const source = new EventSource(API_BASE + "/api/agents/stream");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as {
          type: string;
          office?: OfficeSnapshot;
          event?: { agentId: string; state: "idle" | "working" | "waiting"; task?: string };
        };
        if (event.type === "snapshot" && event.office) {
          setSnapshot(event.office);
        } else if (event.type === "agent:state-changed" && event.event) {
          const change = event.event;
          setSnapshot((previous) =>
            previous
              ? {
                  ...previous,
                  agents: previous.agents.map((agent) =>
                    agent.id === change.agentId
                      ? { ...agent, state: change.state, currentTask: change.task }
                      : agent,
                  ),
                }
              : previous,
          );
        }
      } catch {
        // 忽略无法解析的心跳/非 JSON 帧
      }
    };

    return () => {
      disposed = true;
      source.close();
    };
  }, []);

  // 把真实状态同步进场景：进入实时模式，关闭演示交接动画
  useEffect(() => {
    const scene = sceneRef.current;
    if (!snapshot || status !== "ready" || !scene) return;

    if (!liveEnabledRef.current) {
      liveEnabledRef.current = true;
      scene.setLiveMode(true);
    }

    for (const agent of snapshot.agents) {
      const sceneState = toSceneState(agent.state);
      const task = agent.state === "idle" ? undefined : agent.currentTask;
      const fingerprint = `${sceneState}|${task ?? ""}`;
      if (lastPushedRef.current.get(agent.id) === fingerprint) continue;
      lastPushedRef.current.set(agent.id, fingerprint);
      scene.setAgentState(agent.id, sceneState, task);
    }
  }, [snapshot, status]);

  const stats = snapshot?.stats;
  const overview = [
    {
      label: "运行中",
      value: String(stats?.running ?? 0),
      note: stats && stats.queued > 0 ? `${stats.queued} 项排队中` : `${stats?.activeAgents ?? 0} 位员工正在工作`,
      icon: Activity,
      tone: "active",
    },
    {
      label: "今日完成",
      value: String(stats?.completedToday ?? 0),
      note: "队列任务 + 业务工作流",
      icon: Check,
      tone: "success",
    },
    {
      label: "等待确认",
      value: String(stats?.pendingApprovals ?? 0),
      note: (stats?.pendingApprovals ?? 0) > 0 ? "需要你的审批" : "没有待审批事项",
      icon: Clock3,
      tone: "waiting",
    },
    {
      label: "数字员工",
      value: String(snapshot?.agents.length ?? 0),
      note: `${stats?.readyAgents ?? 0} 位可用 · ${stats?.plannedAgents ?? 0} 位规划中`,
      icon: UsersRound,
      tone: "neutral",
    },
  ] as const;

  const updatedAt = snapshot
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(
        new Date(snapshot.generatedAt),
      )
    : undefined;

  return (
    <div className="page-content office-page">
      <div className="page-header office-page-header">
        <div>
          <span className="eyebrow">DIGITAL OFFICE</span>
          <h1>办公室</h1>
          <p>数字员工协作状态</p>
        </div>
        <span className="office-live"><i />{snapshot?.agents.length ?? 0} 位数字员工</span>
      </div>
      <section className="office-overview" aria-label="数字员工工作概览">
        <div className="office-overview-heading">
          <span>工作概览</span>
          <small>{updatedAt ? `实时数据 · 更新于 ${updatedAt}` : "正在连接实时数据…"}</small>
        </div>
        <div className="office-overview-grid">
          {overview.map((item) => {
            const Icon = item.icon;
            return (
              <article className={`office-stat office-stat--${item.tone}`} key={item.label}>
                <div className="office-stat-label"><Icon size={15} strokeWidth={1.8} /><span>{item.label}</span></div>
                <strong>{item.value}</strong>
                <p>{item.note}</p>
              </article>
            );
          })}
        </div>
      </section>
      <div className="office-stage-shell">
        <div ref={hostRef} className="office-canvas" aria-label="数字员工办公室动画" />
        {status === "loading" && <div className="office-stage-state"><LoaderCircle className="spin" size={20} /><span>正在进入办公室</span></div>}
        {status === "error" && <div className="office-stage-state office-stage-state--error">办公室动画暂时无法加载</div>}
      </div>
    </div>
  );
}

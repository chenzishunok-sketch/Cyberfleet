import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { RunStep } from "../../shared/contracts";

/**
 * 等待期的执行轨迹面板。
 *
 * 把"黑盒等待"变成"看得见的进展"：
 *  - 已完成步骤逐条落下
 *  - 正在执行的步骤有呼吸点、扫光条，并行时能同时看到多条
 *  - 顶部秒表 + 分段提示，等待越久说得越具体，缓解"是不是卡死了"的焦虑
 *  - 一旦开始出字，整块收起，把注意力交还给正文
 */

/** 按已等待时长切换说法。只描述所处阶段，不编造具体动作。 */
function stageHint(seconds: number, activeCount: number): string {
  if (activeCount > 1) return `正在并行读取 ${activeCount} 项数据`;
  if (activeCount === 1) {
    if (seconds < 8) return "正在读取真实数据";
    if (seconds < 20) return "数据量较大，正在分页读取";
    return "仍在读取，商品较多的店铺会慢一些";
  }
  if (seconds < 4) return "正在理解你的问题";
  if (seconds < 12) return "正在读取店铺数据";
  if (seconds < 25) return "正在核对订单与商品明细";
  return "正在整理结论与建议";
}

function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startedAt = useRef(Date.now());
  useEffect(() => {
    if (!running) {
      setSeconds(0);
      return;
    }
    startedAt.current = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [running]);
  return seconds;
}

interface AgentTraceProps {
  steps: RunStep[];
  activity?: RunStep[];
}

export function AgentTrace({ steps, activity = [] }: AgentTraceProps) {
  const seconds = useElapsedSeconds(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [steps.length, activity.length]);

  return (
    <div className="agent-trace" role="status" aria-live="polite">
      <div className="agent-trace-head">
        <span className="agent-trace-pulse" aria-hidden="true" />
        <span className="agent-trace-title">{stageHint(seconds, activity.length)}</span>
        <span className="agent-trace-timer">{seconds > 0 ? `${seconds}s` : ""}</span>
      </div>

      <div className="agent-trace-bar" aria-hidden="true">
        <span className="agent-trace-bar-fill" />
      </div>

      <div className="agent-trace-list" ref={listRef}>
        {steps.map((step) => (
          <div className={`trace-row trace-row--${step.status}`} key={step.id}>
            <span className="trace-icon">
              {step.status === "failed" ? <AlertCircle size={12} /> : <Check size={12} />}
            </span>
            <span className="trace-label">{step.label}</span>
            {step.detail && (
              <span className="trace-detail">{step.detail.replace(/。请告知用户并建议替代方案。$/, "。").slice(0, 40)}</span>
            )}
          </div>
        ))}

        {activity.map((step) => (
          <div className="trace-row trace-row--running" key={`active-${step.label}`}>
            <span className="trace-icon"><Loader2 size={12} className="spin" /></span>
            <span className="trace-label">{step.label}</span>
            <span className="trace-detail">{step.detail}</span>
            <span className="trace-shimmer" aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  );
}

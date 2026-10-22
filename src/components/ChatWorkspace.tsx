import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { ArrowRight, ArrowUp, ArrowUpRight, BarChart3, CheckCircle2, ChevronDown, CircleDollarSign, ClipboardCheck, ImagePlus, LoaderCircle, PackageSearch, Percent, Square, Workflow, X, XCircle } from "lucide-react";
import type { ChatImageAttachment, ChatMessage, RunStep } from "../../shared/contracts";
import { getDigitalEmployee, type AgentContext } from "../../shared/digital-employees";
import { useChatStreaming } from "../streaming-store";
import { ArtifactRenderer } from "./ArtifactRenderer";

interface ChatWorkspaceProps {
  messages: ChatMessage[];
  sending: boolean;
  /** 当前会话 ID：流式输出按会话匹配，避免切到别的会话时串流渲染 */
  conversationId: string;
  busyActionId?: string;
  conversationTitle: string;
  projectName?: string;
  workspace?: AgentContext;
  onSend: (text: string, attachments?: ChatImageAttachment[]) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onToggleAutomation: (id: string) => void;
  onStopStreaming?: () => void;
}

const WORKBENCH_ACTIONS = [
  { title: "检查今日经营重点", description: "汇总销售、库存与需要优先处理的问题", prompt: "检查当前最需要处理的经营问题", icon: ClipboardCheck },
  { title: "分析近 7 天销售", description: "查看销售额、订单和商品表现变化", prompt: "分析最近 7 天店铺销售表现", icon: BarChart3 },
  { title: "检查商品库存", description: "查看全部商品并识别库存不足的 SKU", prompt: "查看全部商品库存", icon: PackageSearch },
  { title: "排查亏损商品", description: "找出预计利润不足或可能亏损的商品", prompt: "找出预计亏损的商品", icon: CircleDollarSign },
  { title: "查看当前促销", description: "检查正在进行和即将开始的店铺活动", prompt: "查看当前促销活动", icon: Percent },
  { title: "查看最近任务", description: "了解数字员工任务的最新执行进度", prompt: "查看最近业务任务", icon: Workflow },
] as const;

function timeGreeting(hour: number): string {
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

const StructuredMessageText = memo(function StructuredMessageText({ content }: { content: string }) {
  const lines = content.split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+\.\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      nodes.push(<ol key={`list-${index}`}>{items.map((item) => <li key={item}>{item}</li>)}</ol>);
      continue;
    }
    if (/^[-•]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-•]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      nodes.push(<ul key={`ul-${index}`}>{items.map((item) => <li key={item}>{item}</li>)}</ul>);
      continue;
    }
    if (/^(?:结论|总结|判断|建议|注意|事实层面|推断层面|我的建议|我建议|核心观点|但要注意|需要注意|风险|不过)[：:，]\s*(.+)/.test(line)) {
      const match = line.match(/^(?:结论|总结|判断|建议|注意|事实层面|推断层面|我的建议|我建议|核心观点|但要注意|需要注意|风险|不过)[：:，]\s*(.+)/);
      const isInfo = /事实层面|推断层面/.test(line);
      const isConclusion = /结论|总结/.test(line);
      const isRecommendation = /建议|我的建议|我建议/.test(line);
      const isWarning = /注意|但要注意|需要注意|风险|不过/.test(line);
      const tone = isConclusion ? "conclusion" : isRecommendation ? "recommendation" : isWarning ? "warning" : isInfo ? "info" : "judgment";
      const label = isConclusion ? "结论" : isRecommendation ? "建议" : isWarning ? "注意" : isInfo ? "分析" : "判断";
      nodes.push(
        <div key={`callout-${index}`} className={`message-callout message-callout--${tone}`}>
          <strong>{label}</strong>
          <span>{match?.[1]}</span>
        </div>
      );
      index += 1;
      continue;
    }
    if (line.endsWith("：") && line.length <= 36) {
      nodes.push(<h4 key={`heading-${index}`}>{line.slice(0, -1)}</h4>);
    } else {
      nodes.push(<p key={`paragraph-${index}`}>{line}</p>);
    }
    index += 1;
  }

  return <div className="message-copy">{nodes}</div>;
});

function RunSteps({ steps, open }: { steps: RunStep[]; open?: boolean }) {
  const completed = steps.filter((step) => step.status === "done").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const SummaryIcon = failed ? XCircle : CheckCircle2;
  return (
    <details className="run-steps" open={open}>
      <summary><SummaryIcon size={15} />已完成 {completed} 个步骤{failed > 0 ? `，失败 ${failed} 个步骤` : ""}<ChevronDown size={14} /></summary>
      <div className="step-list">
        {steps.map((step) => {
          const Icon = step.status === "failed" ? XCircle : step.status === "done" ? CheckCircle2 : LoaderCircle;
          return <div className="step-row" key={step.id}><span className={step.status === "failed" ? "step-error" : "step-check"}><Icon size={14} /></span><span>{step.label}</span><small>{step.detail.replace(/。请告知用户并建议替代方案。$/, "。")}</small></div>;
        })}
      </div>
    </details>
  );
}

function isConnectionNotice(message: ChatMessage): boolean {
  return message.role === "assistant"
    && message.content.startsWith("已连接真实店铺 ")
    && message.content.includes("TikTok Shop Open API");
}

export const ChatWorkspace = memo(function ChatWorkspace({ messages, sending, conversationId, busyActionId, conversationTitle, projectName, workspace = "general", onSend, onApprove, onReject, onToggleAutomation, onStopStreaming }: ChatWorkspaceProps) {
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<ChatImageAttachment>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [draggingImage, setDraggingImage] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const nearBottomRef = useRef(true);
  const streaming = useChatStreaming(conversationId);
  const streamingSteps = streaming?.steps;
  const streamingContent = streaming?.content;
  const visibleMessages = useMemo(() => messages.filter((message) => !isConnectionNotice(message)), [messages]);
  // 窗口化：只渲染最近 50 条消息，避免超长对话时 DOM 过多导致渲染卡顿
  const MESSAGE_WINDOW = 50;
  const hiddenCount = Math.max(0, visibleMessages.length - MESSAGE_WINDOW);
  const windowedMessages = useMemo(() => visibleMessages.slice(-MESSAGE_WINDOW), [visibleMessages]);
  const latestAssistantId = useMemo(() => [...visibleMessages].reverse().find((item) => item.role === "assistant")?.id, [visibleMessages]);
  const employee = getDigitalEmployee(workspace);
  const allowImage = workspace === "general" || workspace === "sourcing";
  const showWorkbenchHome = workspace === "general" && !visibleMessages.some((message) => message.role === "user") && !sending;
  const greeting = timeGreeting(new Date().getHours());

  const handleListScroll = () => {
    const list = listRef.current;
    if (!list) return;
    // 距底部不足 80px 视为"正在跟随"，流式输出才继续自动滚动；用户回翻历史时不打扰
    nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  };

  useEffect(() => {
    if (!nearBottomRef.current) return;
    if (messages.length > 1 || sending) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, sending, streamingContent?.length]);

  const submit = () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;
    setInput("");
    const selected = attachment;
    setAttachment(undefined);
    setAttachmentError(undefined);
    onSend(text, selected ? [selected] : undefined);
  };

  const selectImage = (file?: File) => {
    if (!file) return;
    const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(mimeType)) {
      setAttachmentError("请选择 JPG、PNG 或 WebP 图片。");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setAttachmentError("图片需要小于 4MB。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setAttachment({
        id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `image-${Date.now()}`,
        name: file.name || "选品图片",
        mimeType: mimeType as ChatImageAttachment["mimeType"],
        dataUrl: reader.result,
      });
      setAttachmentError(undefined);
    };
    reader.onerror = () => setAttachmentError("无法读取这张图片。");
    reader.readAsDataURL(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingImage(false);
    if (allowImage) selectImage(event.dataTransfer.files[0]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowImage) return;
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"))?.getAsFile();
    if (image) selectImage(image);
  };

  const composerShell = (
    <div className={`composer-shell ${showWorkbenchHome ? "composer-shell--home" : ""}`}>
      <div
        className={`composer ${draggingImage ? "composer--dragging" : ""}`}
        onDragEnter={(event) => { if (allowImage) { event.preventDefault(); setDraggingImage(true); } }}
        onDragOver={(event) => { if (allowImage) event.preventDefault(); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImage(false); }}
        onDrop={handleDrop}
      >
        {attachment && (
          <div className="composer-image-preview">
            <img src={attachment.dataUrl} alt="待搜索的产品" />
            <div><strong>{attachment.name}</strong><span>1688 同款搜索</span></div>
            <button type="button" className="icon-button" aria-label="移除图片" title="移除图片" onClick={() => setAttachment(undefined)}><X size={15} /></button>
          </div>
        )}
        {attachmentError && <div className="composer-image-error">{attachmentError}</div>}
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            // 中文输入法的回车用于确认候选词；部分浏览器只通过 keyCode 229 标识。
            if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={showWorkbenchHome ? 3 : 2}
          placeholder={showWorkbenchHome ? "描述你想完成的任务…" : employee.placeholder}
          aria-label="输入运营指令"
        />
        <div className="composer-footer">
          <div className="composer-actions composer-actions-left">
            {allowImage && <>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-hidden="true" tabIndex={-1} onChange={(event) => { selectImage(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              <button type="button" className="icon-button attachment-button" aria-label="上传图片搜索1688同款" title="上传图片搜索1688同款" onClick={() => fileInputRef.current?.click()}><ImagePlus size={17} /></button>
            </>}
          </div>
          <div className="composer-actions composer-actions-right">
            {sending && streaming && (
              <button type="button" className="icon-button stop-button" aria-label="停止生成" title="停止生成" onClick={onStopStreaming}><Square size={15} /></button>
            )}
            <button className="send-button" aria-label="发送" title="发送" disabled={(!input.trim() && !attachment) || sending} onClick={submit}><ArrowUp size={18} /></button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <main className={`chat-workspace ${showWorkbenchHome ? "chat-workspace--home" : ""}`}>
      {showWorkbenchHome ? (
        <div className="workbench-home">
          <section className="workbench-welcome" aria-labelledby="workbench-greeting">
            <img className="workbench-team" src="/assets/workbench/digital-employee-team.png" alt="跨境电商多Agent协同系统 数字员工团队" />
            <h1 id="workbench-greeting">{greeting}，今天想先处理什么？</h1>
            <p>告诉我你的经营目标，我会安排合适的数字员工一起完成。</p>
            {composerShell}
          </section>
          <section className="workbench-actions" aria-labelledby="workbench-actions-title">
            <div className="workbench-section-heading">
              <h2 id="workbench-actions-title">常用任务</h2>
            </div>
            <div className="workbench-action-grid">
              {WORKBENCH_ACTIONS.map((action) => {
                const Icon = action.icon;
                return (
                  <button key={action.title} className="workbench-action-card" onClick={() => onSend(action.prompt)}>
                    <span className="workbench-action-icon"><Icon size={17} strokeWidth={1.7} /></span>
                    <strong>{action.title}</strong>
                    <p>{action.description}</p>
                    <ArrowUpRight size={15} className="workbench-action-arrow" />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : (
        <>
      <div className="message-list" ref={listRef} onScroll={handleListScroll} aria-live="polite">
        <div className="conversation-heading">
          <div><span className="eyebrow">{projectName ? `${employee.shortName} · ${projectName}` : `${employee.shortName} · 对话`}</span>{conversationTitle !== "新对话" && <h1>{conversationTitle}</h1>}</div>
        </div>
        {hiddenCount > 0 && (
          <div className="message-window-notice">以上还有 {hiddenCount} 条消息未渲染，如需查看请滚动到顶部或搜索历史记录</div>
        )}
        {windowedMessages.map((chatMessage) => (
          <article className={`message message--${chatMessage.role}`} key={chatMessage.id}>
            <div className="message-body">
              <div className="message-meta"><strong>{chatMessage.role === "assistant" ? `跨境电商 · ${employee.shortName}` : "你"}</strong><span>{chatMessage.timestamp}</span></div>
              {chatMessage.role === "assistant"
                ? <StructuredMessageText content={chatMessage.content} />
                : <div className="message-copy">{chatMessage.content}</div>}
              {chatMessage.steps && (
                <RunSteps steps={chatMessage.steps} />
              )}
              {chatMessage.artifact && (
                <ArtifactRenderer
                  artifact={chatMessage.artifact}
                  busyActionId={busyActionId}
                  onApprove={onApprove}
                  onReject={onReject}
                  onPrompt={onSend}
                  onToggleAutomation={onToggleAutomation}
                />
              )}
              {!sending && chatMessage.id === latestAssistantId && chatMessage.followUps && chatMessage.followUps.length > 0 && (
                <div className="follow-up-block" aria-label="相关下一步">
                  <span className="follow-up-label">接下来可以继续</span>
                  <div className="follow-up-actions">
                    {chatMessage.followUps.map((prompt) => (
                      <button key={prompt} onClick={() => onSend(prompt)}>
                        <span>{prompt}</span><ArrowRight size={14} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </article>
        ))}
        {sending && (
          <article className="message message--assistant loading-message">
            <div className="message-body">
              <div className="message-meta"><strong>跨境电商 · {employee.shortName}</strong></div>
              {streamingContent ? (
                <div className="message-copy streaming-text">{streamingContent}<span className="typing-cursor" /></div>
              ) : (
                <div className="agent-working"><LoaderCircle size={16} className="spin" /><span>{employee.workingLabel}</span></div>
              )}
              {streamingSteps && streamingSteps.length > 0 && (
                <RunSteps steps={streamingSteps} open />
              )}
            </div>
          </article>
        )}
      </div>
          {composerShell}
        </>
      )}
    </main>
  );
});

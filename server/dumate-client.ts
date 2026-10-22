/**
 * 百度搭子（DuMate）最小接入客户端
 *
 * 定位：只接管“对话”（普通聊天、知识问答、运营建议），不暴露业务工具。
 * 业务数据查询与写操作仍走 CyberFleet 原有链路（真实 TikTok 数据 + 审批卡），
 * 从而在“前端 UI 完全不动”的前提下，让百度搭子成为工作台的第二个对话大脑。
 *
 * 依赖的搭子接口（均需 API Key，Bearer 鉴权，见 API 参考《认证鉴权》）：
 *   POST /api/v1/sessions                      创建会话（绑定 Agent）
 *   GET  /api/v1/sessions/{id}/events/stream   SSE 订阅事件流
 *   POST /api/v1/sessions/{id}/events          发送事件（user.message）
 *
 * 说明：API 参考里“创建会话”一页的标题 URL 写的是 qianfan.baidubce.com，
 * 但其请求示例与其余接口一致为 api.dumate.cn/api/v1/sessions，这里统一用 baseUrl。
 */
import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, ChatStreamEmitter } from "../shared/contracts.ts";

const DEFAULT_BASE_URL = "https://api.dumate.cn";

interface DumateConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  agentId: string;
  /** 单轮对话最长时间（秒） */
  timeoutMs: number;
}

export function getDumateConfig(): DumateConfig {
  const enabled = process.env.DUMATE_ENABLED?.trim().toLowerCase() === "true";
  const timeoutSec = Number.parseInt(process.env.DUMATE_TIMEOUT_SECONDS?.trim() ?? "90", 10);
  return {
    enabled,
    baseUrl: (process.env.DUMATE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    apiKey: process.env.DUMATE_API_KEY?.trim() ?? "",
    agentId: process.env.DUMATE_AGENT_ID?.trim() ?? "",
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 90_000,
  };
}

export function isDumateConfigured(): boolean {
  const config = getDumateConfig();
  return config.enabled && Boolean(config.apiKey) && Boolean(config.agentId);
}

/** 业务关键词：命中则留在原链路（真实数据/写操作），避免把经营查询交给不会查数据的搭子 */
const BUSINESS_PATTERN =
  /(?:销售|订单|GMV|成交|退款|退货|库存|缺货|补货|利润|成本|定价|商品|SKU|报告|日报|周报|月报|复盘|秒杀|上架|下架|发布|采集|妙手|达人|1688|货源|选品|类目|竞品|店铺|汇率|物流|流量|转化|客单价|热销|滞销|经营|表现|趋势|占比|涨跌|汇总|统计|近\d+天|\d+天|上周|本周|上月|本月|昨天|今天|卖得|调价|改价)/i;

export function shouldRouteToDumate(message: string): boolean {
  return !BUSINESS_PATTERN.test(message);
}

// ─── 会话管理 ────────────────────────────────────────────────
// 单用户本地系统：按 storeId 缓存一个常驻会话，进程内即可（重启后由搭子平台保留历史）

const sessionCache = new Map<string, string>();

async function createDumateSession(): Promise<string> {
  const config = getDumateConfig();
  const response = await fetch(`${config.baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent: { id: config.agentId } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`创建搭子会话失败（HTTP ${response.status}）：${detail.slice(0, 200)}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const session = (data.session ?? data) as Record<string, unknown>;
  const id = typeof session.id === "string" ? session.id : undefined;
  if (!id) throw new Error("创建搭子会话失败：响应中没有会话 id。");
  return id;
}

async function getOrCreateSession(storeId: string): Promise<string> {
  const cached = sessionCache.get(storeId);
  if (cached) return cached;
  const sessionId = await createDumateSession();
  sessionCache.set(storeId, sessionId);
  return sessionId;
}

// ─── 发送用户消息 ────────────────────────────────────────────

async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  const config = getDumateConfig();
  const response = await fetch(`${config.baseUrl}/api/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "user.message",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`发送消息失败（HTTP ${response.status}）：${detail.slice(0, 200)}`);
  }
}

// ─── SSE 事件流 ──────────────────────────────────────────────

interface DumateStreamEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface DumateTurnResult {
  text: string;
  reasoningSeen: boolean;
}

/**
 * 订阅一次会话事件流并驱动单轮对话：
 * 连接建立（server.connected）后发送消息，累计 text 片段增量，
 * 在收到 session.status = idle 或 server.disposed / 流结束时返回本轮文本。
 */
async function runDumateTurn(
  sessionId: string,
  messageText: string,
  emit?: ChatStreamEmitter,
): Promise<DumateTurnResult> {
  const config = getDumateConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/api/v1/sessions/${sessionId}/events/stream`, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`订阅搭子事件流失败（HTTP ${response.status}）。`);
    }

    const textParts = new Map<string, string>();
    const partTypes = new Map<string, string>();
    const reasoningPartIds = new Set<string>();
    let sendError: Error | null = null;
    let turnDone = false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!turnDone) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        // 超时或连接被对端中断：保留已收到的部分文本继续收尾
        break;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw) continue;
        let event: DumateStreamEvent;
        try {
          event = JSON.parse(raw) as DumateStreamEvent;
        } catch {
          continue;
        }
        const properties = event.properties ?? {};

        if (event.type === "server.connected") {
          // 连接就绪后立即发送用户消息，避免漏掉早期事件；失败则中断本轮
          sendUserMessage(sessionId, messageText).catch((error) => {
            sendError = error instanceof Error ? error : new Error(String(error));
            controller.abort();
          });
          continue;
        }

        if (event.type === "message.part.updated") {
          const part = properties.part as { id?: string; type?: string; text?: string } | undefined;
          if (part?.id && (part.type === "text" || part.type === "reasoning")) {
            partTypes.set(part.id, part.type);
            textParts.set(part.id, part.text ?? "");
          }
          continue;
        }

        if (event.type === "message.part.delta") {
          const deltaProps = properties as { partID?: string; field?: string; delta?: string };
          const partId = deltaProps.partID;
          const delta = deltaProps.delta ?? "";
          if (!partId || deltaProps.field !== "text") continue;
          const partType = partTypes.get(partId) ?? "text";
          if (partType === "reasoning") {
            if (!reasoningPartIds.has(partId)) {
              reasoningPartIds.add(partId);
              emit?.({ type: "step", step: { id: `dumate-${partId}`, label: "搭子思考中", detail: "", status: "done" } });
            }
            continue;
          }
          const current = textParts.get(partId) ?? "";
          textParts.set(partId, current + delta);
          if (emit) emit({ type: "content_delta", delta });
          continue;
        }

        if (event.type === "session.status") {
          const status = properties.status as { type?: string } | undefined;
          if (status?.type === "idle") {
            turnDone = true;
            break;
          }
          continue;
        }

        if (event.type === "server.disposed") {
          turnDone = true;
          break;
        }
      }
    }

    // 发送失败必须上报，避免“空回复”掩盖问题
    if (sendError) throw sendError;

    // 拼接本轮所有 text 片段（Map 保持插入顺序）
    const finalText = Array.from(textParts.values())
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n\n");
    return { text: finalText, reasoningSeen: reasoningPartIds.size > 0 };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 对外入口 ────────────────────────────────────────────────

export async function handleDumateChat(request: ChatRequest, emit?: ChatStreamEmitter): Promise<ChatResponse> {
  if (!isDumateConfigured()) {
    throw new Error("百度搭子未启用：请配置 DUMATE_ENABLED=true 及 DUMATE_API_KEY / DUMATE_AGENT_ID。");
  }

  const sessionId = await getOrCreateSession(request.storeId);
  const { text } = await runDumateTurn(sessionId, request.message, emit);

  const content = text.trim() || "（搭子没有返回内容，请重试。）";
  return {
    message: {
      id: randomUUID(),
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
    },
    runId: randomUUID(),
  };
}

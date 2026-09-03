interface FeishuTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

const REQUEST_TIMEOUT_MS = 15_000;

export interface FeishuConnectionStatus {
  configured: boolean;
  connected: boolean;
  error?: string;
}

let tokenCache: { value: string; expiresAt: number } | undefined;

function getFeishuConfig() {
  return {
    appId: process.env.FEISHU_APP_ID?.trim() ?? "",
    appSecret: process.env.FEISHU_APP_SECRET?.trim() ?? "",
    baseUrl: (process.env.FEISHU_BASE_URL?.trim() || "https://open.feishu.cn/open-apis").replace(/\/$/, ""),
  };
}

export function hasFeishuConfiguration(): boolean {
  const { appId, appSecret } = getFeishuConfig();
  return Boolean(appId && appSecret);
}

async function getTenantAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;

  const { appId, appSecret, baseUrl } = getFeishuConfig();
  if (!appId || !appSecret) throw new Error("飞书应用尚未配置。");

  const response = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json() as FeishuTokenResponse;
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || `飞书连接失败（${response.status}）。`);
  }

  tokenCache = {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, (payload.expire ?? 7200) - 300) * 1000,
  };
  return tokenCache.value;
}

export async function getFeishuConnectionStatus(): Promise<FeishuConnectionStatus> {
  if (!hasFeishuConfiguration()) return { configured: false, connected: false };
  try {
    await getTenantAccessToken();
    return { configured: true, connected: true };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : "飞书连接失败。",
    };
  }
}

export function clearFeishuTokenCache(): void {
  tokenCache = undefined;
}

// ─── 消息发送（主动推送：审批卡 / 日报） ────────────────────────

export type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id" | "email";

export interface FeishuNotifyTarget {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
}

export interface FeishuSendResult {
  sent: boolean;
  reason?: string;
}

/**
 * 解析主动推送的接收目标。
 * 优先 FEISHU_NOTIFY_CHAT_ID（群），其次 FEISHU_NOTIFY_USER_ID（个人 open_id）。
 */
export function getFeishuNotifyTarget(): FeishuNotifyTarget | undefined {
  const chatId = process.env.FEISHU_NOTIFY_CHAT_ID?.trim();
  if (chatId) return { receiveId: chatId, receiveIdType: "chat_id" };
  const userId = process.env.FEISHU_NOTIFY_USER_ID?.trim();
  if (userId) return { receiveId: userId, receiveIdType: "user_id" };
  return undefined;
}

async function sendFeishuMessage(
  target: FeishuNotifyTarget,
  msgType: "text" | "post",
  content: Record<string, unknown>,
): Promise<void> {
  const token = await getTenantAccessToken();
  const { baseUrl } = getFeishuConfig();
  const response = await fetch(
    `${baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: target.receiveId,
        msg_type: msgType,
        content: JSON.stringify(content),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const payload = await response.json() as { code?: number; msg?: string };
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || `飞书消息发送失败（${response.status}）。`);
  }
}

/**
 * 推送富文本（post）消息：标题 + 多行正文。
 * 飞书未配置或未设置接收人时静默降级，不抛错。
 */
export async function pushFeishuPost(title: string, lines: string[]): Promise<FeishuSendResult> {
  if (!hasFeishuConfiguration()) return { sent: false, reason: "飞书应用未配置" };
  const target = getFeishuNotifyTarget();
  if (!target) return { sent: false, reason: "未设置 FEISHU_NOTIFY_CHAT_ID / FEISHU_NOTIFY_USER_ID" };
  try {
    await sendFeishuMessage(target, "post", {
      zh_cn: {
        title,
        content: lines.filter((line) => line.trim()).map((line) => [{ tag: "text", text: line }]),
      },
    });
    return { sent: true };
  } catch (error) {
    console.warn(`Feishu post push failed: ${error instanceof Error ? error.message : String(error)}`);
    return { sent: false, reason: error instanceof Error ? error.message : "发送失败" };
  }
}

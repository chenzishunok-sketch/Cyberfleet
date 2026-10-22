import { createLarkChannel, Domain, LoggerLevel, type LarkChannel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { dashboard } from "./data.ts";
import { getFeishuRuntimeConfig } from "./runtime-config.ts";
import { handleChat } from "./orchestrator.ts";

export interface FeishuBridgeStatus {
  configured: boolean;
  connected: boolean;
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "failed";
  error?: string;
}

let channel: LarkChannel | undefined;
let status: FeishuBridgeStatus = { configured: false, connected: false, state: "disabled" };

function credentials() {
  const config = getFeishuRuntimeConfig();
  return { appId: config.appId, appSecret: config.appSecret };
}

async function replyToMessage(message: NormalizedMessage): Promise<void> {
  if (!channel || !message.content.trim()) return;
  try {
    const result = await handleChat({
      message: message.content.trim(),
      storeId: dashboard.store.id,
      mode: "analysis",
    });
    await channel.send(message.chatId, { markdown: result.message.content }, { replyTo: message.messageId });
  } catch (error) {
    console.error(`Feishu message handling failed: ${error instanceof Error ? error.message : String(error)}`);
    await channel.send(message.chatId, { text: "这次任务处理失败，请稍后重试。" }, { replyTo: message.messageId }).catch(() => undefined);
  }
}

export async function startFeishuBridge(): Promise<FeishuBridgeStatus> {
  const { appId, appSecret } = credentials();
  if (!appId || !appSecret) {
    status = { configured: false, connected: false, state: "disabled" };
    return status;
  }
  if (channel && status.connected) return status;

  status = { configured: true, connected: false, state: "connecting" };
  channel = createLarkChannel({
    appId,
    appSecret,
    domain: Domain.Feishu,
    transport: "websocket",
    source: "cyberfleet",
    loggerLevel: LoggerLevel.warn,
    handshakeTimeoutMs: 15_000,
    policy: { dmMode: "open", requireMention: true },
  });
  channel.on("message", (message) => {
    void replyToMessage(message);
  });
  channel.on("reconnecting", () => {
    status = { configured: true, connected: false, state: "reconnecting" };
  });
  channel.on("reconnected", () => {
    status = { configured: true, connected: true, state: "connected" };
  });
  channel.on("error", (error) => {
    status = { configured: true, connected: false, state: "failed", error: error.message };
    console.error(`Feishu bridge failed: ${error.message}`);
  });

  try {
    await channel.connect();
    status = { configured: true, connected: true, state: "connected" };
  } catch (error) {
    status = {
      configured: true,
      connected: false,
      state: "failed",
      error: error instanceof Error ? error.message : "飞书长连接失败。",
    };
  }
  return status;
}

export function getFeishuBridgeStatus(): FeishuBridgeStatus {
  return { ...status };
}

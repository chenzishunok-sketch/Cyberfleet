import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { KolCreator, KolStats } from "../shared/contracts.ts";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (name: string, data: unknown) => void | Promise<void>;
  timer: NodeJS.Timeout;
}

interface BridgeMessage {
  type?: string;
  clientType?: string;
  requestId?: string;
  name?: string;
  data?: unknown;
  payload?: unknown;
  error?: string;
}

function bridgePort(): number {
  const configured = Number(process.env.KOL_BRIDGE_PORT ?? 8794);
  return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : 8794;
}

class KolBridge {
  private server?: WebSocketServer;
  private extension?: WebSocket;
  private sequence = 0;
  private readonly pending = new Map<string, PendingCall>();

  async start(port = bridgePort()): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port });
      const fail = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", fail);
      server.once("listening", () => {
        server.off("error", fail);
        this.server = server;
        resolve();
      });
      server.on("connection", (socket) => this.attach(socket));
    });
  }

  isConnected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  status() {
    return { connected: this.isConnected(), port: bridgePort() };
  }

  async listCreators(query: { category?: string; minFollowers?: number; limit?: number } = {}): Promise<KolCreator[]> {
    const value = await this.call<unknown>("list_creators", { query }, 15_000);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const id = String(item.id ?? item.oecId ?? "").trim();
      if (!id) return [];
      return [{
        id,
        ...(item.oecId ? { oecId: String(item.oecId) } : {}),
        nickname: String(item.nickname ?? item.handle ?? id),
        ...(item.handle ? { handle: String(item.handle) } : {}),
        followerCount: Number(item.followerCount ?? 0) || 0,
        ...(item.category ? { category: String(item.category) } : {}),
        ...(item.avatar ? { avatar: String(item.avatar) } : {}),
      }];
    });
  }

  async getStats(): Promise<KolStats> {
    const value = await this.call<Record<string, unknown>>("get_stats", {}, 15_000);
    const number = (key: string) => Number(value?.[key] ?? 0) || 0;
    return {
      totalInvited: number("totalInvited"),
      success: number("success"),
      pending: number("pending"),
      failed: number("failed"),
      totalCreators: number("totalCreators"),
      tasksTotal: number("tasksTotal"),
    };
  }

  execute(
    plan: Record<string, unknown>,
    onProgress: (progress: unknown) => void | Promise<void>,
  ): Promise<Record<string, unknown>> {
    return this.call("execute", { plan }, 300_000, (name, data) => {
      if (name === "progress") return onProgress(data);
    });
  }

  private attach(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: "hello", server: "shop-pilot" }));
    socket.on("message", (raw) => this.onMessage(socket, raw));
    socket.on("close", () => {
      if (this.extension !== socket) return;
      this.extension = undefined;
      this.rejectPending(new Error("达人浏览器桥接已断开。"));
    });
  }

  private onMessage(socket: WebSocket, raw: RawData): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw.toString()) as BridgeMessage;
    } catch {
      return;
    }
    if (message.type === "register" && message.clientType === "extension") {
      if (this.extension && this.extension !== socket) this.extension.close();
      this.extension = socket;
      socket.send(JSON.stringify({ type: "registered", ok: true }));
      return;
    }
    if (!message.requestId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "event") {
      void pending.onEvent?.(message.name ?? "", message.data);
      return;
    }
    if (message.type !== "response") return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.payload);
  }

  private call<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
    onEvent?: PendingCall["onEvent"],
  ): Promise<T> {
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("达人浏览器桥接未连接，请打开 TikTok Shop 联盟页面并保持 KOL 扩展运行。"));
    }
    const requestId = `kol-${Date.now()}-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("达人浏览器桥接响应超时。"));
      }, timeout);
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, onEvent, timer });
      socket.send(JSON.stringify({ type: "request", requestId, method, params }));
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const kolBridge = new KolBridge();
export const startKolBridge = () => kolBridge.start();

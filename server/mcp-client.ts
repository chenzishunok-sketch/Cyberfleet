/**
 * FastMoss MCP 客户端
 * 通过 Model Context Protocol 连接 FastMoss TikTok 数据分析服务
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getFastMossRuntimeConfig } from "./runtime-config.ts";

// ─── 类型定义 ─────────────────────────────────────────────────

interface McpToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface McpToolResult {
  content: string;
  isError: boolean;
}

// ─── 单例客户端 ───────────────────────────────────────────────

let client: Client | null = null;
let transport: SSEClientTransport | StreamableHTTPClientTransport | null = null;
let cachedTools: McpToolDefinition[] | null = null;
let connectPromise: Promise<void> | null = null;

function getMcpUrl(): string {
  const { apiKey, mcpUrl } = getFastMossRuntimeConfig();
  if (!apiKey) throw new Error("缺少 FastMoss API Key 配置");
  // 如果 URL 已经包含 query 参数，则追加；否则新建
  const separator = mcpUrl.includes("?") ? "&" : "?";
  return `${mcpUrl}${separator}api_key=${apiKey}`;
}

async function connectClient(): Promise<void> {
  if (client && cachedTools) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const url = getMcpUrl();
    const urlObj = new URL(url);

    client = new Client(
      { name: "cyberfleet", version: "1.0.0" },
      { capabilities: {} },
    );

    // 带超时的连接（最多 8 秒）
    const connectWithTimeout = (transportInstance: SSEClientTransport | StreamableHTTPClientTransport) =>
      Promise.race([
        client!.connect(transportInstance),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("MCP 连接超时 (8s)")), 8000),
        ),
      ]);

    // 优先尝试 StreamableHTTP，失败则回退 SSE
    try {
      transport = new StreamableHTTPClientTransport(urlObj);
      await connectWithTimeout(transport);
      console.log("[FastMoss MCP] 已连接 (StreamableHTTP)");
    } catch (err) {
      console.warn("[FastMoss MCP] StreamableHTTP 连接失败，尝试 SSE:", (err as Error).message);
      try {
        client = new Client(
          { name: "cyberfleet", version: "1.0.0" },
          { capabilities: {} },
        );
        transport = new SSEClientTransport(urlObj);
        await connectWithTimeout(transport);
        console.log("[FastMoss MCP] 已连接 (SSE)");
      } catch (err2) {
        console.error("[FastMoss MCP] SSE 也失败:", (err2 as Error).message);
        client = null;
        transport = null;
        throw new Error(`FastMoss MCP 连接失败: ${(err2 as Error).message}`);
      }
    }

    // 列出并缓存工具（也带超时）
    const toolsResult = await Promise.race([
      client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("listTools 超时 (5s)")), 5000),
      ),
    ]);
    cachedTools = toolsResult.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: `fastmoss_${tool.name}`,
        description: tool.description ?? `FastMoss ${tool.name}`,
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
    }));
    console.log(`[FastMoss MCP] 发现 ${cachedTools.length} 个工具`);
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

// ─── 公共 API ─────────────────────────────────────────────────

/** 检查是否配置了 FastMoss */
export function hasFastMossConfiguration(): boolean {
  return getFastMossRuntimeConfig().source !== "missing";
}

/** 换绑/解绑后调用：丢弃旧的 MCP 连接与工具缓存，下次使用时按新凭证重建 */
export function resetFastMossConnection(): void {
  void transport?.close().catch(() => undefined);
  client = null;
  transport = null;
  cachedTools = null;
  connectPromise = null;
}

/** 连接测试探针：真实建连 + listTools（零消耗），失败抛出真实原因 */
export async function probeFastMossConnection(): Promise<number> {
  if (!hasFastMossConfiguration()) throw new Error("FastMoss MCP 尚未配置，请先填写 MCP 地址和 API Key。");
  await connectClient();
  return cachedTools?.length ?? 0;
}

/** 获取 FastMoss MCP 提供的所有工具定义（OpenAI function calling 格式） */
export async function getFastMossTools(): Promise<McpToolDefinition[]> {
  if (!hasFastMossConfiguration()) return [];
  if (cachedTools) return cachedTools; // 已缓存直接返回，避免每次请求都连
  try {
    await connectClient();
    return cachedTools ?? [];
  } catch (error) {
    console.error("[FastMoss MCP] 获取工具列表失败:", (error as Error).message);
    return [];
  }
}

/** 预加载 FastMoss 工具（启动时调用，失败不阻塞） */
export async function preloadFastMossTools(): Promise<void> {
  if (!hasFastMossConfiguration()) return;
  try {
    await connectClient();
    console.log(`[FastMoss MCP] 预加载完成，${cachedTools?.length ?? 0} 个工具可用`);
  } catch (error) {
    console.warn("[FastMoss MCP] 预加载失败（不影响启动，后续请求会重试）:", (error as Error).message);
  }
}

/** 调用 FastMoss MCP 工具 */
export async function callFastMossTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (!hasFastMossConfiguration()) return { content: "未配置 FastMoss API", isError: true };

  try {
    await connectClient();
    if (!client) throw new Error("MCP 客户端未初始化");

    // 去掉 fastmoss_ 前缀，还原原始工具名
    const originalName = toolName.replace(/^fastmoss_/, "");

    const result = await client.callTool({
      name: originalName,
      arguments: args,
    });

    // 提取文本内容
    const contentParts = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const text = contentParts
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n") ?? JSON.stringify(result);

    return {
      content: text,
      isError: Boolean((result as { isError?: boolean }).isError),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "FastMoss MCP 调用失败";
    console.error("[FastMoss MCP] 调用失败:", msg);
    return { content: `FastMoss 工具调用失败: ${msg}`, isError: true };
  }
}

/** 获取 FastMoss 能力描述（注入 system prompt） */
export async function getFastMossAbilityDescription(): Promise<string> {
  const tools = await getFastMossTools();
  if (tools.length === 0) return "";

  const toolNames = tools.map((t) => t.function.name.replace(/^fastmoss_/, ""));
  return `\n\nFastMoss MCP 能力（TikTok 数据分析）：提供 ${tools.length} 个工具 [${toolNames.join(", ")}]，可用于查询 TikTok 爆品、达人、店铺、直播、视频等数据分析。工具名称以 fastmoss_ 开头。`;
}

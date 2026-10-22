/**
 * 出海匠（Chuhaijiang）MCP 客户端
 * 通过 Model Context Protocol 连接出海匠 TikTok 电商数据服务（美区六维数据 + 达人库 + 蓝海指数）。
 *
 * 认证：API Key 模式（sk_live_ 开头），经 X-API-Key 请求头传给
 * 出海匠 MCP Gateway（https://mcp.gateway.chuhaijiang.com/mcp，streamable HTTP）。
 *
 * 权限边界：只向 Agent 暴露只读工具（search/get_detail/get_related/amazon/account_info 等）。
 * 写操作与消耗类工具（ai_generate/canvas/video_editor/social_publish/social_messages/social_tools/upload_file）
 * 不进入工具列表，后续如需使用必须走 ActionPlan 审批闭环。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getChuhaijiangRuntimeConfig } from "./runtime-config.ts";

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

/** 只读工具：允许 Agent 直接调用（不产生外部影响、不消耗 credits） */
const READ_ONLY_TOOLS = new Set([
  "search",
  "get_detail",
  "get_related",
  "amazon",
  "check_task",
  "canvas_tasks",
  "assets",
  "social_accounts",
  "social_comments",
  "social_analytics",
  "social_seller",
  "account_info",
]);

// ─── 单例客户端 ───────────────────────────────────────────────

let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let cachedTools: McpToolDefinition[] | null = null;
let connectPromise: Promise<void> | null = null;

async function connectClient(): Promise<void> {
  if (client && cachedTools) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const { apiKey, baseUrl } = getChuhaijiangRuntimeConfig();
    if (!apiKey) throw new Error("出海匠 API Key 尚未配置。");
    const urlObj = new URL(baseUrl);

    client = new Client(
      { name: "kuajing-multi-agent", version: "0.9.0" },
      { capabilities: {} },
    );

    transport = new StreamableHTTPClientTransport(urlObj, {
      requestInit: {
        headers: { "X-API-Key": apiKey },
      },
    });

    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("出海匠 MCP 连接超时 (10s)")), 10_000),
      ),
    ]);

    const toolsResult = await Promise.race([
      client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("出海匠 listTools 超时 (8s)")), 8_000),
      ),
    ]);

    cachedTools = toolsResult.tools
      .filter((tool) => READ_ONLY_TOOLS.has(tool.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: `chuhaijiang_${tool.name}`,
          description: tool.description ?? `出海匠 ${tool.name}`,
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        },
      }));
    console.log(`[出海匠 MCP] 已连接，发现 ${toolsResult.tools.length} 个工具，暴露 ${cachedTools.length} 个只读工具`);
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

function hasChuhaijiangConfiguration(): boolean {
  return getChuhaijiangRuntimeConfig().source !== "missing";
}

/** 换绑/解绑后调用：丢弃旧的 MCP 连接与工具缓存，下次使用时按新凭证重建 */
export function resetChuhaijiangConnection(): void {
  void transport?.close().catch(() => undefined);
  client = null;
  transport = null;
  cachedTools = null;
  connectPromise = null;
}

/** 连接测试探针：真实建连 + listTools（零消耗），失败抛出真实原因 */
export async function probeChuhaijiangConnection(): Promise<number> {
  if (!hasChuhaijiangConfiguration()) throw new Error("出海匠 API Key 尚未配置。");
  await connectClient();
  return cachedTools?.length ?? 0;
}

/** 获取出海匠只读工具定义（OpenAI function calling 格式） */
export async function getChuhaijiangTools(): Promise<McpToolDefinition[]> {
  if (!hasChuhaijiangConfiguration()) return [];
  if (cachedTools) return cachedTools;
  try {
    await connectClient();
    return cachedTools ?? [];
  } catch (error) {
    console.error("[出海匠 MCP] 获取工具列表失败:", (error as Error).message);
    return [];
  }
}

/** 预加载出海匠工具（启动时调用，失败不阻塞） */
export async function preloadChuhaijiangTools(): Promise<void> {
  if (!hasChuhaijiangConfiguration()) return;
  try {
    await connectClient();
    console.log(`[出海匠 MCP] 预加载完成，${cachedTools?.length ?? 0} 个只读工具可用`);
  } catch (error) {
    console.warn("[出海匠 MCP] 预加载失败（不影响启动，后续请求会重试）:", (error as Error).message);
  }
}

/** 调用出海匠 MCP 工具（仅限只读工具） */
export async function callChuhaijiangTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (!hasChuhaijiangConfiguration()) {
    return { content: "未配置出海匠 API Key", isError: true };
  }

  // 去掉 chuhaijiang_ 前缀，还原原始工具名
  const originalName = toolName.replace(/^chuhaijiang_/, "");
  if (!READ_ONLY_TOOLS.has(originalName)) {
    return {
      content: `出海匠工具 ${originalName} 涉及写操作或 credits 消耗，必须走审批闭环，不能直接调用。`,
      isError: true,
    };
  }

  try {
    await connectClient();
    if (!client) throw new Error("出海匠 MCP 客户端未初始化");

    const result = await client.callTool({ name: originalName, arguments: args });

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
    const msg = error instanceof Error ? error.message : "出海匠 MCP 调用失败";
    console.error("[出海匠 MCP] 调用失败:", msg);
    return { content: `出海匠工具调用失败: ${msg}`, isError: true };
  }
}

/** 获取出海匠能力描述（注入 system prompt） */
export async function getChuhaijiangAbilityDescription(): Promise<string> {
  const tools = await getChuhaijiangTools();
  if (tools.length === 0) return "";

  const toolNames = tools.map((t) => t.function.name.replace(/^chuhaijiang_/, ""));
  return `\n\n出海匠 MCP 能力（TikTok 美区选品数据）：提供 ${tools.length} 个只读工具 [${toolNames.join(", ")}]，用于查询 TikTok Shop 美区爆品、达人、视频、店铺、广告、直播数据与 Amazon 交叉验证。工具名称以 chuhaijiang_ 开头。`;
}

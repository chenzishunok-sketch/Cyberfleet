import type { ChatRequest } from "../shared/contracts.ts";
import type { WebSearchResponse } from "../shared/intelligence.ts";
import { z } from "zod";
import { getDigitalEmployee } from "../shared/digital-employees.ts";
import { formatMemoryForPrompt } from "./memory.ts";
import { getLlmRuntimeConfig } from "./llm-providers.ts";
import { getSkillTools, getSkillAbilityDescriptions } from "./skill-registry.ts";
import { getFastMossAbilityDescription, getFastMossTools } from "./mcp-client.ts";
import { getChuhaijiangAbilityDescription } from "./chuhaijiang-client.ts";
import { intelligenceStore } from "./intelligence-store.ts";
import { agentRegistry } from "./agent-registry.ts";
import { isShellAnswer, normalizeAssistantText } from "./response-presentation.ts";

export type AgentDecision =
  | { tool: "get_shop_info"; args: Record<string, never> }
  | { tool: "get_sales_overview"; args: { days?: number } }
  | { tool: "get_order_summary"; args: { days?: number } }
  | { tool: "get_gmv_summary"; args: { days?: number } }
  | { tool: "get_refund_summary"; args: { days?: number } }
  | { tool: "explain_product_operations"; args: { includeBestSellers?: boolean; days?: number } }
  | { tool: "list_products"; args: { focus?: string; query?: string } }
  | { tool: "prepare_inventory_update"; args: { skus?: string[]; quantity?: number } }
  | { tool: "prepare_price_update"; args: { skus?: string[]; price?: number } }
  | { tool: "generate_operations_report"; args: { days?: number; focus?: string } }
  | { tool: "create_readonly_automation"; args: { schedule?: string; task?: string } }
  | { tool: "run_tiktok_scene_query"; args: { scene?: string; region?: string; days?: number } }
  | { tool: "analyze_category_track"; args: { category?: string; region?: string; days?: number } }
  | { tool: "get_workflow_status"; args: { workflowId?: string; workflowType?: "product_publish" | "flash_sale" | "kol_outreach" } }
  | { tool: "get_kol_bridge_status"; args: Record<string, never> }
  | { tool: "list_kol_creators"; args: { category?: string; minFollowers?: number; limit?: number } }
  | { tool: "get_kol_stats"; args: Record<string, never> }
  | { tool: "start_kol_outreach_workflow"; args: { category?: string; minFollowers?: number; commissionRate: number; message?: string; batchSize: number; totalTarget: number; freeSample: boolean } }
  | { tool: "start_supplier_publish_workflow"; args: { sourceUrl: string; shopId?: string; publishPrice?: number; currency?: string; packageLength?: number; packageWidth?: number; packageHeight?: number; title?: string; description?: string } }
  | { tool: "start_flash_sale_workflow"; args: { productId: string; activityTitle: string; startAt: string; endAt: string; priceAmount: string; currency?: string; skuQuantityLimit: number; quantityPerUser: number; skuIds?: string[] } }
  | { tool: "approve_workflow"; args: { workflowId: string } }
  | { tool: "retry_workflow"; args: { workflowId: string } }
  | { tool: "verify_workflow"; args: { workflowId: string } }
  | { tool: "delegate_to_agent"; args: { targetAgent: string; task: string; context?: string } }
  | { tool: "respond"; args: { content: string; followUps?: string[] } };

const tools = [
  {
    type: "function",
    function: {
      name: "get_shop_info",
      description: "查询当前已连接店铺的名称、站点、币种、时区和授权状态。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sales_overview",
      description: "查询综合销售概览；仅在用户同时询问多项经营指标或笼统询问经营表现时使用。",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 90 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workflow_status",
      description: "查询本地业务任务的当前步骤、等待项、错误和结果。用户问任务进度、刚才任务到哪或失败原因时使用。",
      parameters: {
        type: "object",
        properties: {
          workflowId: { type: "string", description: "任务编号；用户没给时省略，系统返回最近任务。" },
          workflowType: { type: "string", enum: ["product_publish", "flash_sale", "kol_outreach"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_kol_bridge_status",
      description: "检查 KOL 达人浏览器插件是否已连接，可以用于真实读取达人和发送邀约。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_kol_creators",
      description: "通过浏览器插件读取真实 TikTok 达人库并按类目或最低粉丝数筛选。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          minFollowers: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_kol_stats",
      description: "读取浏览器插件中的真实达人数量、邀约、成功、待处理和失败统计。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_kol_outreach_workflow",
      description: "创建持久化达人建联任务，先读取并锁定真实达人，再通过任务卡片等待人工审核后分批发送。",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          minFollowers: { type: "integer", minimum: 0 },
          commissionRate: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          message: { type: "string" },
          batchSize: { type: "integer", minimum: 1, maximum: 50 },
          totalTarget: { type: "integer", minimum: 1, maximum: 500 },
          freeSample: { type: "boolean" },
        },
        required: ["commissionRate", "batchSize", "totalTarget", "freeSample"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_supplier_publish_workflow",
      description: "创建从 1688 采集、采集编辑到 TikTok 发布的持久化任务。只有用户明确要求上架时使用；任务会先返回审核卡片。",
      parameters: {
        type: "object",
        properties: {
          sourceUrl: { type: "string" }, shopId: { type: "string" }, publishPrice: { type: "number", exclusiveMinimum: 0 }, currency: { type: "string" },
          packageLength: { type: "number", exclusiveMinimum: 0 }, packageWidth: { type: "number", exclusiveMinimum: 0 }, packageHeight: { type: "number", exclusiveMinimum: 0 },
          title: { type: "string", description: "准备保存到 TikTok 的商品标题；没有可靠内容时不要编造。" },
          description: { type: "string", description: "准备保存到 TikTok 的商品描述；没有可靠内容时不要编造。" },
        },
        required: ["sourceUrl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_flash_sale_workflow",
      description: "创建 TikTok SKU 秒杀任务。只有商品、时间、价格、库存和限购完整时使用；真实创建前必须经过任务卡片审核。",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string" }, activityTitle: { type: "string" }, startAt: { type: "string", description: "带时区的 ISO 时间" }, endAt: { type: "string", description: "带时区的 ISO 时间" },
          priceAmount: { type: "string" }, currency: { type: "string" }, skuQuantityLimit: { type: "integer" }, quantityPerUser: { type: "integer" }, skuIds: { type: "array", items: { type: "string" } },
        },
        required: ["productId", "activityTitle", "startAt", "endAt", "priceAmount", "skuQuantityLimit", "quantityPerUser"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "approve_workflow",
      description: "识别用户希望继续等待确认的任务。真实写入必须引导用户点击任务卡片中的审核按钮，不能通过文本直接批准。",
      parameters: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "retry_workflow",
      description: "识别用户希望从失败步骤恢复任务。应展示任务卡片，由用户点击重试按钮，不能通过文本直接执行。",
      parameters: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_workflow",
      description: "重新读取外部平台，核验已经提交的商品发布或秒杀活动结果。",
      parameters: { type: "object", properties: { workflowId: { type: "string" } }, required: ["workflowId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_summary",
      description: "只查询订单数量、订单变化或某段时间是否有订单。",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 90 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gmv_summary",
      description: "只查询 GMV、销售额、成交额或客单价。",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 90 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_refund_summary",
      description: "查询退货退款申请数量或退款金额；如果用户问退款原因，也用这个工具并由系统说明原因明细是否可用。",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 90 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_product_operations",
      description: "回答是否支持上架、下架、发布、停售商品等能力；若同一句还问什么好卖，将 includeBestSellers 设为 true。",
      parameters: {
        type: "object",
        properties: {
          includeBestSellers: { type: "boolean" },
          days: { type: "integer", minimum: 1, maximum: 90 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_products",
      description: "查询商品表现、销量和库存风险。",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", enum: ["top", "low_stock", "slow", "all"] },
          query: { type: "string", description: "用户明确给出的商品名、商品 ID 或 SKU；没有则省略。" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_inventory_update",
      description: "准备库存修改计划。只生成差异预览，绝不直接执行。",
      parameters: {
        type: "object",
        properties: {
          skus: { type: "array", items: { type: "string" }, maxItems: 50 },
          quantity: { type: "integer", minimum: 1, maximum: 99999 },
        },
        required: ["quantity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_price_update",
      description: "准备商品价格修改计划。只生成差异预览，绝不直接执行。",
      parameters: {
        type: "object",
        properties: {
          skus: { type: "array", items: { type: "string" }, maxItems: 50 },
          price: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_operations_report",
      description: "生成日报、周报或经营复盘。",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", minimum: 1, maximum: 90 },
          focus: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_readonly_automation",
      description: "创建只读分析、报告或告警自动任务的草稿。",
      parameters: {
        type: "object",
        properties: { schedule: { type: "string" }, task: { type: "string" } },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_agent",
      description: "将子任务委派给指定的专业 Agent 执行。仅运营总监 Agent 可用；用于跨领域协作时把具体执行交给专业角色。",
      parameters: {
        type: "object",
        properties: {
          targetAgent: {
            type: "string",
            enum: ["product", "pricing", "sourcing", "collection", "publishing", "kol", "content"],
            description: "目标 Agent 标识",
          },
          task: { type: "string", description: "委派给目标 Agent 的具体任务描述" },
          context: { type: "string", description: "补充上下文信息（原始需求、约束条件等）" },
        },
        required: ["targetAgent", "task"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "respond",
      description: "仅当其他业务工具都不匹配时，用简洁的纯文本回答，并给出最多 3 个与当前问题直接相关的下一步问题。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "直接回答，使用简短中文段落，不使用 Markdown、星号、井号或横线项目符号。" },
          followUps: { type: "array", items: { type: "string" }, maxItems: 3, description: "确实有帮助时提供 1 至 3 个具体下一步问题；不需要时返回空数组。" },
        },
        required: ["content", "followUps"],
        additionalProperties: false,
      },
    },
  },
];

// ─── ReAct 循环相关类型 ──────────────────────────────────────

interface ReactStepResult {
  decision: AgentDecision;
  observation: string;
  failed?: boolean;
}

export type ToolExecutorFn = (decision: AgentDecision) => Promise<string>;

// ─── 底层 LLM 调用（内部复用） ────────────────────────────────

type ChatMessage = Record<string, unknown>;

interface LlmCallOptions {
  messages: ChatMessage[];
  systemPrompt: string;
  toolDefs?: unknown[];
  toolChoice?: string;
  model?: string;
  maxTokens?: number;
  // 流式模式：逐 token 回调，用于最终回答的打字机效果
  stream?: boolean;
  onToken?: (delta: string) => void;
  // 强制模型以 JSON 对象返回（OpenAI response_format）
  responseFormat?: "json";
  // DeepSeek v4 思考开关：显式 "disabled" 用于简单结构化生成任务——
  // 思考会挤占 max_tokens 预算，把正文截成空/半截（finish_reason=length）
  thinking?: "disabled";
}

export function fastModel(): string | undefined {
  return getLlmRuntimeConfig().fastModel || undefined;
}

function needsDeliberateReasoning(text: string): boolean {
  return /(?:分析|诊断|复盘|报告|比较|对比|判断|建议|策略|方案|原因|风险|利润|决策|优先级|预测|为什么|如何|怎么提升)/i.test(text);
}

export async function callLlmRaw(options: LlmCallOptions): Promise<{
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  assistantMessage?: ChatMessage;
  allToolCalls?: Array<{ name: string; args: Record<string, unknown>; callId: string }>;
}> {
  const runtime = getLlmRuntimeConfig();
  if (!runtime.apiKey || !runtime.model) {
    throw new Error("尚未绑定大模型服务。请到设置的「大模型连接」完成绑定，或在 .env 中配置 LLM_API_KEY / LLM_MODEL。");
  }
  const baseUrl = runtime.baseUrl;
  const allMessages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...options.messages,
  ];

  const body: Record<string, unknown> = {
    model: options.model ?? runtime.model,
    temperature: 0.1,
    messages: allMessages,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.toolDefs) body.tools = options.toolDefs;
  if (options.toolChoice) body.tool_choice = options.toolChoice;
  if (options.stream) body.stream = true;
  if (options.responseFormat === "json") body.response_format = { type: "json_object" };

  // DeepSeek v4 默认开启思考模式，而思考模式不支持 tool_choice（服务端直接 400：
  // "Thinking mode does not support this tool_choice"）。本应用的意图路由与 ReAct
  // 循环依赖 tool_choice 强制工具调用，所以这些请求显式关闭思考；未指定 tool_choice
  // 的纯生成请求保留默认思考，兼顾回答质量与成本。
  if (/api\.deepseek\.com/i.test(baseUrl) && (options.toolChoice || options.thinking === "disabled")) {
    body.thinking = { type: "disabled" };
  }

  // 503/429 重试：最多 3 次，指数退避
  const maxRetries = 3;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json",
        ...(options.stream ? { accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });

    if (response.ok) {
      // 成功：处理响应（流式或非流式）
      if (options.stream && response.body) {
        let content = "";
        const toolCallBuffers: Array<{ id: string; name: string; args: string }> = [];
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            let chunk: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
            try { chunk = JSON.parse(data); } catch { continue; }
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              content += delta.content;
              options.onToken?.(delta.content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCallBuffers[tc.index]) toolCallBuffers[tc.index] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
                if (tc.id) toolCallBuffers[tc.index].id = tc.id;
                if (tc.function?.name) toolCallBuffers[tc.index].name = tc.function.name;
                if (tc.function?.arguments) toolCallBuffers[tc.index].args += tc.function.arguments;
              }
            }
          }
        }

        const calls = toolCallBuffers.filter((c) => c.id || c.name);
        if (calls.length > 0) {
          const parsed = calls.map((call) => {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.args) as Record<string, unknown>; } catch { /* ignore */ }
            return { name: call.name, args, callId: call.id };
          });
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: content || null,
            tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args } })),
          };
          return {
            content: content || undefined,
            toolName: parsed[0].name,
            toolArgs: parsed[0].args,
            toolCallId: parsed[0].callId,
            assistantMessage,
            allToolCalls: parsed,
          };
        }

        return { content: content || undefined };
      }

      // 非流式模式
      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
          };
        }>;
      };

      const msg = payload.choices?.[0]?.message;
      const calls = msg?.tool_calls ?? [];

      if (calls.length > 0) {
        const parsed = calls.map((call) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }
          return { name: call.function.name, args, callId: call.id };
        });
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: msg?.content ?? null,
          tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } })),
        };
        return {
          content: msg?.content,
          toolName: parsed[0].name,
          toolArgs: parsed[0].args,
          toolCallId: parsed[0].callId,
          assistantMessage,
          allToolCalls: parsed,
        };
      }

      return { content: msg?.content };
    }

    // 失败：检查是否可重试
    const errorText = await response.text().catch(() => "");
    lastError = new Error(`LLM request failed (${response.status}): ${errorText.slice(0, 200)}`);
    if (response.status !== 503 && response.status !== 429 && response.status !== 502) {
      throw lastError; // 非瞬时错误，直接抛出
    }
  }

  throw lastError!;
}

export async function generateContentText(input: {
  prompt: string;
  kind: "title" | "listing" | "script";
  language?: string;
  sku?: string;
}): Promise<string> {
  if (!hasLlmConfiguration()) throw new Error("文字大模型尚未连接，请先在 .env 配置现有 LLM。");
  const kindLabel = input.kind === "title" ? "TikTok Shop 商品标题" : input.kind === "listing" ? "商品卖点与 Listing" : "带货短视频脚本";
  const intelligenceContext = intelligenceStore.buildPromptContext(input.prompt, "content");
  const result = await callLlmRaw({
    messages: [{ role: "user", content: input.prompt }],
    systemPrompt: `你是跨境电商内容创作专家。请生成${kindLabel}，目标语言为${input.language || "日语"}。${input.sku ? `关联 SKU：${input.sku}。` : ""}内容要真实、清晰、可直接使用，不要编造没有提供的产品参数。只输出成品内容。${intelligenceContext}`,
    maxTokens: 2_200,
  });
  const content = result.content?.trim();
  if (!content) throw new Error("文字模型没有返回内容。");
  return content;
}

export async function summarizeWebResearch(question: string, research: WebSearchResponse): Promise<string> {
  if (!hasLlmConfiguration()) throw new Error("文字大模型尚未连接。");
  const evidence = research.results.slice(0, 6).map((result, index) => [
    `[来源${index + 1}] ${result.title}`,
    `网址：${result.url}`,
    `站点：${result.source}${result.publishedAt ? `，日期：${result.publishedAt}` : ""}`,
    `摘要：${result.snippet.slice(0, 520)}`,
  ].join("\n")).join("\n\n");
  const result = await callLlmRaw({
    messages: [{ role: "user", content: `用户问题：${question}\n\n联网检索结果：\n${evidence}` }],
    systemPrompt: `你是跨境电商研究助手。只能使用给定的检索结果回答，不得编造费率、日期或政策。优先采信平台官方或一手来源；第三方内容只能作参考。先给结论，再简要区分“可核实事实”“分析判断”和“待确认信息”。最后列出实际使用的来源标题和完整网址。总长度控制在 600 个中文字以内，不要使用 Markdown 链接。`,
    model: fastModel(),
    maxTokens: 700,
    thinking: "disabled",
  });
  const content = result.content?.trim();
  if (!content) throw new Error("模型没有返回联网分析。");
  return content;
}

/**
 * 用真实店铺数据写一段给用户看的回答。
 * 只允许引用调用方传入的事实表，不允许编造；模型不可用时由调用方决定怎么降级。
 * 存在的意义：以前「查到数据」这一步会直接返回一句写死的模板话，正文不是模型写的。
 */
export async function summarizeLiveShopData(input: {
  question: string;
  factSheet: string;
}): Promise<string> {
  const result = await callLlmRaw({
    messages: [{
      role: "user",
      content: `用户问题：${input.question}\n\n真实数据（全部来自平台官方接口，任何数字都不得改动，也不得换算货币）：\n${input.factSheet}`,
    }],
    systemPrompt: `你是 TikTok Shop 店铺运营分析师。请直接用中文回答用户提出的这个问题。

硬性要求：
- 只能使用「真实数据」里的数字与事实。数据里没有的，就说“当前接口没有返回这项数据”，绝不猜测或补全
- 第一句必须直接给结论。禁止出现“我已读取数据”“请查看上方结果”“任务完成”“已为你汇总”这类空话
- 结论之后给依据，再从数据里能看出的问题给 1~2 条可执行建议
- 数字原样引用，不做汇率换算、不做四舍五入、不改变量纲
- 纯中文段落，不用 Markdown 标题、加粗和表格；可以用“①②③”分点
- 全文 120~260 个汉字`,
    model: fastModel(),
    maxTokens: 700,
    thinking: "disabled",
  });
  const content = result.content?.trim();
  if (!content) throw new Error("模型没有返回经营解读。");
  return content;
}

// ─── 单步意图路由（原有功能，增加记忆支持） ────────────────────

export function hasLlmConfiguration(): boolean {
  const config = getLlmRuntimeConfig();
  return Boolean(config.apiKey && config.model);
}

function agentRolePrompt(request: ChatRequest): string {
  const context = request.context ?? "general";
  const employee = getDigitalEmployee(context);
  const capabilityPrompt = agentRegistry.getCapabilityPrompt(context);
  return `\n当前数字员工身份：${employee.name}。主要职责：${employee.description} 优先处理本职责内的任务；遇到跨领域目标时可以调用共享工具和持久化业务流程协同完成，不要让用户手工在多个 Agent 之间搬运信息。${capabilityPrompt}`;
}

export async function decideWithLlm(request: ChatRequest, memoryContext?: string): Promise<AgentDecision> {
  const memory = memoryContext ?? "";
  const skillAbility = await getSkillAbilityDescriptions();
  const fastmossAbility = await getFastMossAbilityDescription();
  const chuhaijiangAbility = await getChuhaijiangAbilityDescription();
  const skillTools = await getSkillTools();
  const fastmossTools = await getFastMossTools();
  // 按 Agent 能力过滤工具集：非运营总监只看到自己有权使用的工具
  const context = request.context ?? "general";
  const allTools = [...tools, ...skillTools, ...fastmossTools];
  const filteredTools = agentRegistry.filterToolsForAgent(context, allTools as Array<{ function: { name: string } }>);
  const result = await callLlmRaw({
    messages: [
      ...(request.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: request.message },
    ],
    // 稳定前缀优先：ROUTER_SYSTEM_PROMPT + skillAbility + fastmossAbility 大多数请求不变，
    // 放前面可命中 LLM 供应商 prefix cache，减少 prefill 延迟；随请求变化的 role/memory 放后面
    systemPrompt: ROUTER_SYSTEM_PROMPT + skillAbility + fastmossAbility + chuhaijiangAbility + agentRolePrompt(request) + memory,
    toolDefs: filteredTools,
    toolChoice: "required",
    model: fastModel(),
    maxTokens: 360,
  });

  if (result.toolName) {
    return { tool: result.toolName as AgentDecision["tool"], args: result.toolArgs ?? {} } as AgentDecision;
  }
  return { tool: "respond", args: { content: result.content ?? "请告诉我想查询的数据或要执行的店铺操作。", followUps: [] } };
}

// ─── ReAct 多步推理循环 ──────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `你是 TikTok Shop 的智能运营 Agent。你可以连续调用多个工具来获取数据，然后综合所有数据给出有价值的回答。

工作流程：
1. 分析用户的真实意图（是要查数据、要建议、还是要操作？）— 必须先明确，不能用工具来猜
2. 逐步调用工具获取所需数据
3. 根据所有步骤获取的数据，综合思考，用 respond 工具给出针对用户问题的完整回答

关键规则（强制，违反即失败）：
- respond 的 content 必须直接回答用户的问题，绝对禁止占位套话（如"我已读取数据"、"任务完成"、"请查看上方结果"、"如表格所示"等毫无信息量的句子）
- 如果用户要建议，必须基于数据给出具体的、可操作的建议（至少 2 条具体动作）
- 如果用户要分析，必须给出有深度的分析结论（趋势、问题、机会各至少 1 点），而不是罗列数字
- 如果用户问市场/选品，必须给出：竞争格局（头部集中/分散）+ 热门方向/品类关键词 + TOP3 样本 + 具体建议，4 要素缺 1 补 1
- 【类目匹配·最高优先】如果用户明确问某个类目/品类/赛道（如"家纺布艺在日本市场"、"美妆怎么样"）：
  - ① 读取榜单后先检查前 10 名里有没有该类目商品（通过标题/类目名关键词判断）
  - ② 如果命中不到 25%，绝对不能把其他类目的数据（香水、iPhone、服装等）硬套成该类目的竞争分析
  - ③ 必须在回答开头明确说明："当前官方 Bestsellers 返回的是全品类热销榜，XX 类命中不足 25%，不会拿无关数据误导你"，然后给出两条针对性建议：(a) 如何拿到该类目真正的榜单（类目树+类目ID+搜索接口），(b) 现有样本不足时的替代切入方案
  - ④ 标题写着"serum/parfum/iPhone/vivo/handbag/shirt"等明显不是用户问的类目时，绝对不能放进该类目的 TOP3 样本里
- 如果只有一张表格或纯列表数据，禁止只说"已展示"或"如上"；必须总结表格里最重要的 3 条结论，并给出下一步建议
- 回答使用简洁的中文段落，不使用 Markdown 格式；但可以用"①②③"或"第一/第二"组织要点
- 基于真实数据回答，不编造数字；当数据缺失时明确说明"数据未提供，无法判断"
- 用户询问最新政策、市场趋势、新闻、竞品或其他可能变化的公开信息时，如果 web_search 工具可用必须先搜索
- 使用联网结果时要区分"来源事实"和"你的判断"，并在回答结尾保留实际引用的来源标题、日期和完整网址
- 业务任务必须通过 workflow 工具创建和恢复，不要把多步写操作拆成无法恢复的临时调用
- 查询和分析可以直接运行；任何真实写入都必须先返回可核对的审核卡片，由用户点击按钮后执行
- 不存在分析/执行模式切换，不得要求用户切换模式，也不得通过聊天文本绕过审核按钮直接批准或重试写任务
- 缺少价格、时间、库存、店铺或商品编号时，必须询问用户，不能猜测
- 可以在同一步同时调用多个互不依赖的只读查询工具（如同时查销售和库存），减少往返；写操作仍必须单独调用
- 同一个只读工具在同一次对话里只调用一次。get_sales_overview 已经包含订单、GMV、退款、客单价四项指标，
  不要再用 get_order_summary、get_gmv_summary、get_refund_summary 重复取同一份数据；list_products 也不要反复调用。
  重复调用拿不到新数据，只会让用户多等几十秒
- 同一次对话里所有查询工具必须使用同一个 days。不同 days 会各自触发一次全量拉取，每次多等半分钟以上。
  用户没说天数时一律用 7；只有用户明确说"30 天""近一个月"才用 30
- 当收集到足够信息后，必须使用 respond 工具给出最终回答，不要只停留在查数据阶段
- 最终回答最低标准：长度不少于 80 个中文字；如果生成了更短的回答，视为回答不完整，需要补充分析和建议
- 如果你是运营总监 Agent，遇到需要专业领域执行的任务（如定价计算、达人筛选、上架发布），可以使用 delegate_to_agent 工具把子任务委派给对应的专业 Agent，然后基于委派结果给出综合回答`;

export async function reactLoop(
  request: ChatRequest,
  toolExecutor: ToolExecutorFn,
  memoryContext?: string,
  maxSteps = 5,
  onStep?: (decision: AgentDecision, observation: string, index: number, failed: boolean) => void,
  onToken?: (delta: string) => void,
  /** 丢弃已经推送的流式正文。空壳回答被打回重写时调用，避免两段文字接在一起 */
  onReset?: () => void,
): Promise<{ finalDecision: AgentDecision; steps: ReactStepResult[] }> {
  const memory = memoryContext ?? "";
  const messages: ChatMessage[] = [
    ...(request.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: request.message },
  ];

  // 动态加载已启用 Skill 的 tools，按 Agent 能力过滤
  const skillTools = await getSkillTools();
  const fastmossTools = await getFastMossTools();
  const context = request.context ?? "general";
  const allTools = [...tools, ...skillTools, ...fastmossTools];
  const filteredTools = agentRegistry.filterToolsForAgent(context, allTools as Array<{ function: { name: string } }>);
  const skillAbility = await getSkillAbilityDescriptions();
  const fastmossAbility = await getFastMossAbilityDescription();
  const chuhaijiangAbility = await getChuhaijiangAbilityDescription();

  const steps: ReactStepResult[] = [];
  // 主循环每一步只做一件事：决定下一批调哪个工具。这是分类任务，快模型足够。
  // 真正需要深思的是最后的总结，所以强模型留给那一步——
  // 以前这里让主循环也用强模型，「帮我分析店铺」这种请求光选工具就花掉十几秒。
  const summaryModel = needsDeliberateReasoning(request.message) ? undefined : fastModel();
  // 时间预算：没有这道闸，模型可以一路查下去，用户端能等到 100 秒以上还没出字。
  // 超出预算就跳出循环，直接进入「用已有数据总结」那一段，保证一定会给出回答。
  const budgetMs = Math.max(20_000, Number(process.env.REACT_BUDGET_MS ?? "") || 70_000);
  const startedAt = Date.now();
  // 空壳回答只打回一次。不设这个开关，模型如果反复回「已分析」，会一路重写到步数耗尽。
  let shellRetried = false;
  // 已经真正执行过的「工具 + 参数」组合，用于拦下重复查询
  const calledTools = new Set<string>();
  let redundantCalls = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (steps.length > 0 && Date.now() - startedAt > budgetMs) {
      console.warn(`[ReAct] 已用 ${Math.round((Date.now() - startedAt) / 1000)}s，超出 ${Math.round(budgetMs / 1000)}s 预算，提前收敛`);
      break;
    }
    const llmStartedAt = Date.now();
    const result = await callLlmRaw({
      messages,
      // 稳定前缀优先，命中 prefix cache；role/memory 放后面
      systemPrompt: AGENT_SYSTEM_PROMPT + skillAbility + fastmossAbility + chuhaijiangAbility + agentRolePrompt(request) + memory,
      toolDefs: filteredTools,
      toolChoice: "required",
      model: fastModel(),
      maxTokens: step === 0 ? 360 : 900,
    });
    // 耗时打点：用户体感「慢」时，只有这行能区分是模型慢还是接口慢
    console.info(`[perf] react step ${step + 1} llm=${Date.now() - llmStartedAt}ms tools=${result.allToolCalls?.length ?? (result.toolName ? 1 : 0)}`);

    // 模型这一步想「结束对话」时的正文：
    //  · 没调工具（无 toolName）→ 正文就是回答
    //  · 调了 respond → 回答在 toolArgs.content 里，不能读 result.content
    //    这个字段在 tool_calls 响应里恒为 undefined，读错就会拿兜底文案顶替模型的真实分析
    const inlineAnswer = !result.toolName || !result.toolCallId
      ? result.content
      : result.toolName === "respond"
        ? (typeof result.toolArgs?.content === "string" ? result.toolArgs.content : result.content)
        : undefined;

    if (inlineAnswer !== undefined) {
      const hasData = steps.some((s) => s.observation && !s.failed);
      if (hasData && isShellAnswer(inlineAnswer)) {
        if (!shellRetried) {
          // 已查到数据却只回「已分析」：这不是回答，是把几十秒的等待吞掉。
          // 不替它写（模板改写过一次，结果答非所问），而是把这句话摔回去让它自己重写。
          shellRetried = true;
          console.warn(`[ReAct] 第 ${step + 1} 步：已有 ${steps.length} 步数据，模型只回了「${inlineAnswer.trim().slice(0, 20)}」，要求重写`);
          messages.push({ role: "assistant", content: inlineAnswer.trim() || "（无内容）" });
          messages.push({ role: "user", content: SHELL_REWRITE_PROMPT });
          continue;
        }
        // 打回过一次还是空壳：不再跟它耗。用已查到的真实数据兜底，
        // 并明确告诉用户这是原始数据、不是模型结论 —— 无论如何不能把「已分析」透传出去。
        console.warn(`[ReAct] 第 ${step + 1} 步：重写后仍是空壳「${inlineAnswer.trim().slice(0, 20)}」，改用数据兜底`);
        const fallback = summarizeCollectedData(steps);
        if (onToken) await streamOutExisting(fallback, onToken);
        const fallbackDecision: AgentDecision = { tool: "respond", args: { content: fallback, followUps: [] } };
        steps.push({ decision: fallbackDecision, observation: "" });
        return { finalDecision: fallbackDecision, steps };
      }
      const decision: AgentDecision = {
        tool: "respond",
        args: {
          content: typeof inlineAnswer === "string" ? inlineAnswer : "",
          followUps: Array.isArray(result.toolArgs?.followUps) ? result.toolArgs.followUps as string[] : [],
        },
      };
      // 主循环里 tool_choice 是 required，模型只能把回答塞进 tool call 的 arguments，
      // delta.content 恒为空 —— 前端一个字都收不到，用户等几十秒后整段突然出现。
      // 这里把已经生成好的文字分块推下去，等待期间至少能看到在出字。
      if (onToken) await streamOutExisting(normalizeAssistantText(decision.args.content), onToken);
      steps.push({ decision, observation: "" });
      return { finalDecision: decision, steps };
    }

    const decision = { tool: result.toolName as AgentDecision["tool"], args: result.toolArgs ?? {} } as AgentDecision;

    // 并行执行：LLM 可能在一步返回多个互不依赖的只读工具调用
    const allCalls = result.allToolCalls ?? [{ name: result.toolName!, args: result.toolArgs ?? {}, callId: result.toolCallId! }];
    if (result.assistantMessage) {
      messages.push(result.assistantMessage);
    }

    const observations = await Promise.all(allCalls.map(async (call) => {
      const callDecision = { tool: call.name as AgentDecision["tool"], args: call.args } as AgentDecision;
      let observation: string;
      let failed = false;
      // 同一个工具 + 同一组参数重复调用拿不到任何新数据，只会让用户多等一轮。
      // 真实场景：分析类请求里模型查完销售额又去查经营报告（同一份数据源），白等 7 秒。
      // 这里不真跑，改成一句提示塞回去，模型下一步基本都会直接给结论。
      const callKey = `${call.name}:${JSON.stringify(call.args ?? {})}`;
      if (calledTools.has(callKey)) {
        redundantCalls += 1;
        observation = "这个查询刚刚已经做过，结果就在上面的工具返回里，没有新数据。不要重复调用，请直接基于已有数据回答用户。";
        steps.push({ decision: callDecision, observation, failed: false });
        onStep?.(callDecision, observation, steps.length - 1, false);
        messages.push({ role: "tool", tool_call_id: call.callId, content: observation });
        return observation;
      }
      calledTools.add(callKey);
      try {
        observation = await toolExecutor(callDecision);
      } catch (error) {
        failed = true;
        observation = `工具执行出错：${error instanceof Error ? error.message : "未知错误"}。请告知用户并建议替代方案。`;
      }
      steps.push({ decision: callDecision, observation, failed });
      onStep?.(callDecision, observation, steps.length - 1, failed);
      messages.push({
        role: "tool",
        tool_call_id: call.callId,
        content: `工具 ${call.name} 的执行结果：\n${observation}`,
      });
      return observation;
    }));

    // 连续两次被提示「已经查过」说明模型在原地打转，再让它试一步只会更慢，直接去总结
    if (redundantCalls >= 2) {
      console.warn("[ReAct] 模型在重复查询已有数据，提前进入总结");
      break;
    }

    // 单工具时保持 decision 指向该工具；多工具时 decision 指向第一个（用于后续渲染）
    void observations;
  }

  // ── 最终总结 ──
  // 这一步不给工具：回答只需要文字，不需要再调一次接口。
  // 以前这里是 tool_choice: "required"，模型只能把回答塞进 respond 的 arguments，
  // 而 arguments 走的是 tool_calls 而不是 delta.content —— 流式一个字都推不出来，
  // 前端只能干等几十秒；最后的 finalResult.content 同样是 undefined（正文在 toolArgs 里），
  // 于是退回「已完成分析。」这句兜底。用户看到的就是"只说已分析、不给结果"。
  messages.push({
    role: "user",
    content: "查询阶段已经结束。现在不要调用任何工具，直接用文字回答用户最初的问题：第一句给结论，再说依据，最后给 1~2 条具体建议。只输出回答正文。",
  });

  const finalSystemPrompt = AGENT_SYSTEM_PROMPT + skillAbility + fastmossAbility + chuhaijiangAbility + memory;
  let answer = "";

  try {
    const summarizeStartedAt = Date.now();
    const finalResult = await callLlmRaw({
      messages,
      systemPrompt: finalSystemPrompt,
      model: summaryModel,
      maxTokens: 900,
      // 没有 tool_choice 时 DeepSeek v4 默认开思考模式，这里显式关掉：总结要的是快
      thinking: "disabled",
      stream: Boolean(onToken),
      onToken,
    });
    answer = finalResult.content?.trim() ?? "";
    console.info(`[perf] react summary llm=${Date.now() - summarizeStartedAt}ms chars=${answer.length}`);
  } catch (error) {
    // 总结失败不该把整轮对话打成错误：前面查到的数据还在，下面会用它兜底
    console.warn("[ReAct] 最终总结失败，改用已查到的数据兜底：", error instanceof Error ? error.message : error);
  }

  const hasData = steps.some((s) => s.observation && !s.failed);

  // 空壳回答不接受：已经查到数据却只回一句「已分析」，等于把用户的等待吞掉。
  // 处理方式是把它打回让模型自己重写，不是拿固定模板替它写（模板改写做过一次，结果答非所问）。
  if (hasData && isShellAnswer(answer)) {
    console.warn(`[ReAct] 最终总结是空壳「${answer.slice(0, 20)}」，要求重写`);
    onReset?.();
    try {
      const retry = await callLlmRaw({
        messages: [...messages, { role: "user", content: SHELL_REWRITE_PROMPT }],
        systemPrompt: finalSystemPrompt,
        model: summaryModel,
        maxTokens: 900,
        thinking: "disabled",
        stream: Boolean(onToken),
        onToken,
      });
      const retried = retry.content?.trim() ?? "";
      if (!isShellAnswer(retried)) answer = retried;
    } catch (error) {
      console.warn("[ReAct] 重写最终总结失败：", error instanceof Error ? error.message : error);
    }
  }

  if (isShellAnswer(answer)) answer = summarizeCollectedData(steps);

  const finalDecision: AgentDecision = { tool: "respond", args: { content: answer, followUps: [] } };
  steps.push({ decision: finalDecision, observation: "" });
  return { finalDecision, steps };
}

/**
 * 把一段已经生成好的文字按小块推给前端。
 *
 * 用在模型已经一次性给出整段回答、但正文藏在 tool call arguments 里的场合：
 * 真流式拿不到 token，又不能让用户对着空白等几十秒，所以按 16 字一块补发。
 * 推的是模型原文，不改一个字，最终落账仍以 final 事件里的完整消息为准。
 */
async function streamOutExisting(text: string, onToken: (delta: string) => void): Promise<void> {
  if (!text) return;
  const chunkSize = 16;
  // 总时长控制在 1.2 秒以内：块越多等越久，长回答按比例放大块大小
  const delay = Math.max(4, Math.min(14, Math.round(1_200 / Math.ceil(text.length / chunkSize))));
  for (let index = 0; index < text.length; index += chunkSize) {
    onToken(text.slice(index, index + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** 空壳回答打回时用的指令。只描述「这个回答不合格」，不提示具体该写什么内容 */const SHELL_REWRITE_PROMPT = "你上一条回答只是在确认动作，没有给用户任何可用内容。用户要的是结果本身。请直接基于上面工具返回的真实数据回答：第一句给结论，再说依据，最后给 1~2 条具体建议。禁止再说「已分析」「已完成」「请查看上方」这类话。";

/** 工具名 → 用户看得懂的数据名称，兜底列数据时用 */
const TOOL_ANSWER_LABELS: Record<string, string> = {
  get_shop_info: "店铺信息",
  get_sales_overview: "销售概览",
  get_order_summary: "订单汇总",
  get_gmv_summary: "GMV 汇总",
  get_refund_summary: "退款汇总",
  list_products: "商品列表",
  explain_product_operations: "商品操作能力",
  generate_operations_report: "经营报告",
  run_tiktok_scene_query: "TikTok 场景查询",
  analyze_category_track: "类目赛道分析",
  get_workflow_status: "任务状态",
  get_kol_bridge_status: "达人插件状态",
  list_kol_creators: "达人库",
  get_kol_stats: "建联数据",
};

/**
 * 模型始终没给出结论时的最后一道兜底：把已经查到的真实数据原样列出来，并说明这不是分析结论。
 * 宁可给一份标明来源的原始数据，也不要再回一句「已完成分析」把数据吞掉。
 */
function summarizeCollectedData(steps: ReactStepResult[]): string {
  const withData = steps.filter((s) => s.observation && !s.failed);
  if (!withData.length) {
    return "这次没有取到可用数据，也没有生成结论。请换一种更具体的问法，或稍后重试。";
  }
  const blocks = withData.slice(-3).map((s) => {
    const label = TOOL_ANSWER_LABELS[s.decision.tool] ?? s.decision.tool;
    return `【${label}】\n${s.observation.slice(0, 800)}`;
  });
  return `这次模型只回了一句确认，没有给出分析结论。下面是已经查到的真实数据，可以直接核对；也可以点重试，让我把它们整理成结论。\n\n${blocks.join("\n\n")}`;
}

// ─── 记忆提取 ──────────────────────────────────────────────────

export interface ExtractedMemories {
  userPreferences: string[];
  shopInsights: string[];
  operationSummary?: string;
}

const extractedMemoriesSchema = z.object({
  userPreferences: z.array(z.string().trim().min(1).max(500)).default([]),
  shopInsights: z.array(z.string().trim().min(1).max(1_000)).default([]),
  operationSummary: z.string().trim().max(1_000).optional(),
});

export async function extractMemories(messages: Array<{ role: string; content: string }>): Promise<ExtractedMemories> {
  try {
    const result = await callLlmRaw({
      messages: [
        {
          role: "user",
          content: `分析以下对话，提取值得长期记住的信息。

规则：
- userPreferences：用户表达的偏好（如"我更关注退款"、"我经常查库存"）
- shopInsights：关于店铺运营的可复用观察（如"周末订单多"、"某SKU滞销"）
- operationSummary：如果执行了操作，用一句话总结（如"将SKU-A库存补至500"）
- 没有值得记住的信息时，返回空数组
- 不要记住临时查询细节，只记有长期价值的信息
- 数组中的每一项必须直接是字符串，不能返回对象

请以 JSON 格式返回：{"userPreferences":[],"shopInsights":[],"operationSummary":""}`,
        },
        ...messages.slice(-10),
      ],
      systemPrompt: "你是记忆提取器。只提取有长期价值的信息，忽略临时查询。返回纯 JSON。",
    });

    const text = (result.content ?? "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    if (!text) return { userPreferences: [], shopInsights: [] };

    const parsed = extractedMemoriesSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { userPreferences: [], shopInsights: [] };
    return {
      userPreferences: parsed.data.userPreferences,
      shopInsights: parsed.data.shopInsights,
      operationSummary: parsed.data.operationSummary || undefined,
    };
  } catch {
    return { userPreferences: [], shopInsights: [] };
  }
}

// ─── 反思 ──────────────────────────────────────────────────────

interface ReflectionResult {
  meetsExpectation: boolean;
  risks: string[];
  suggestion: string;
}

export async function reflectOnResult(
  operationDescription: string,
  beforeData: string,
  afterData: string,
): Promise<ReflectionResult> {
  try {
    const result = await callLlmRaw({
      messages: [
        {
          role: "user",
          content: `请评估以下店铺操作的结果。

操作描述：${operationDescription}
操作前数据：${beforeData}
操作后数据：${afterData}

请评估：
1. 操作是否达到了预期效果？
2. 是否存在潜在风险？
3. 有什么后续建议？

以 JSON 返回：{"meetsExpectation":true/false,"risks":["风险1"],"suggestion":"建议"}`,
        },
      ],
      systemPrompt: "你是运营反思助手。客观评估操作效果，指出风险，给出建议。返回纯 JSON。",
    });

    const text = (result.content ?? "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    if (!text) return { meetsExpectation: true, risks: [], suggestion: "" };

    return JSON.parse(text) as ReflectionResult;
  } catch {
    return { meetsExpectation: true, risks: [], suggestion: "" };
  }
}

const ROUTER_SYSTEM_PROMPT =
  "你是 TikTok Shop 运营助手的意图路由器。必须选择最具体的一个工具：店铺名称或站点用 get_shop_info；只问订单用 get_order_summary；只问 GMV、销售额或客单价用 get_gmv_summary；退货、退款或退款原因用 get_refund_summary；同时问多项经营指标或笼统问经营表现才用 get_sales_overview；询问能否上架、下架、发布或停售商品用 explain_product_operations，同句还问什么好卖时设置 includeBestSellers=true；商品数量、商品列表、指定 SKU 库存、好卖、畅销、热销或滞销用 list_products，并把明确的 SKU 或商品关键词放进 query；报告用 generate_operations_report；没有匹配业务工具时调用 respond。所有写操作只能调用 prepare 工具，不能声称已经执行。respond 的 content 只写简洁业务中文，不使用 Markdown、星号、井号、横线列表或表格；先直接回答，再给必要说明。followUps 只提供与当前回答直接相关且系统能够处理的问题，最多 3 条，不为凑数量而生成。调用 respond 的 content 必须真正回答用户的问题，禁止输出占位套话（例如“我已读取数据”、“任务完成”、“请查看上方结果”等）；若有查询数据，必须基于数据给出结论、洞察或建议，而不是复述过程。";

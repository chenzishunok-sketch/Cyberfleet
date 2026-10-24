import { afterEach, describe, expect, it, vi } from "vitest";
import { callLlmRaw, reactLoop, type AgentDecision } from "../server/llm.ts";

vi.mock("../server/skill-registry.ts", () => ({ getSkillTools: async () => [], getSkillAbilityDescriptions: async () => "" }));
vi.mock("../server/mcp-client.ts", () => ({ getFastMossTools: async () => [], getFastMossAbilityDescription: async () => "" }));
vi.mock("../server/chuhaijiang-client.ts", async () => {
  const actual = await vi.importActual<typeof import("../server/chuhaijiang-client.ts")>("../server/chuhaijiang-client.ts");
  return { ...actual, getChuhaijiangAbilityDescription: async () => "" };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function enableLlm() {
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_MODEL", "test-model");
  vi.stubEnv("LLM_BASE_URL", "https://api.deepseek.com/v1");
}

/** 把若干 SSE 片段包成一个流式响应，模拟模型逐片吐 arguments */
function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(`data: ${part}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 第一个分片带工具名，后续分片只带 arguments 增量 */
function toolChunk(name: string, argsPiece: string, first = false): string {
  return JSON.stringify({
    choices: [{ delta: { tool_calls: [{
      index: 0,
      ...(first ? { id: `call-${name}`, type: "function", function: { name, arguments: argsPiece } } : { function: { arguments: argsPiece } }),
    }] } }],
  });
}

// 这一组守的是体感问题：模型把回答写在 respond 的 arguments 里，
// 而 arguments 是边生成边到达的（实测一次回答 300 多片）。
// 以前要等整段收完才推给前端，用户白等好几秒才看到第一个字。
describe("回答正文的增量流式", () => {
  const ANSWER = "库存还有 4053 件，其中 3 个 SKU 低于安全线。建议今天先补毛绒毯，其余按周补货即可。";

  it("模型写 respond 时，arguments 里的正文被逐片推出去", async () => {
    enableLlm();
    const args = JSON.stringify({ content: ANSWER, followUps: [] });
    // 故意切成 4 段，每段都断在中文中间
    const pieces = [args.slice(0, 18), args.slice(18, 40), args.slice(40, 62), args.slice(62)];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sseResponse(
      pieces.map((piece, index) => toolChunk("respond", piece, index === 0)),
    ));

    const deltas: string[] = [];
    const result = await callLlmRaw({
      messages: [{ role: "user", content: "库存还有多少" }],
      systemPrompt: "test",
      toolDefs: [{ type: "function", function: { name: "respond", parameters: { type: "object" } } }],
      toolChoice: "required",
      stream: true,
      onRespondDelta: (delta) => deltas.push(delta),
    });

    // 关键：不是一次性拿到，而是分多次推出去
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(ANSWER);
    // 完整结果仍然正确，流式只是提前展示，不影响落账
    expect(result.toolName).toBe("respond");
    expect(result.toolArgs?.content).toBe(ANSWER);
  });

  it("调用数据类工具时不推正文（工具参数不是给用户看的）", async () => {
    enableLlm();
    const args = JSON.stringify({ days: 7 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sseResponse([toolChunk("get_sales_overview", args, true)]));

    const deltas: string[] = [];
    await callLlmRaw({
      messages: [{ role: "user", content: "看下最近七天" }],
      systemPrompt: "test",
      toolDefs: [{ type: "function", function: { name: "get_sales_overview", parameters: { type: "object" } } }],
      toolChoice: "required",
      stream: true,
      onRespondDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual([]);
  });

  it("reactLoop 不会把同一段回答推两遍", async () => {
    enableLlm();
    const args = JSON.stringify({ content: ANSWER, followUps: [] });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(sseResponse([
      toolChunk("respond", args.slice(0, 20), true),
      toolChunk("respond", args.slice(20)),
    ]));

    const tokens: string[] = [];
    const result = await reactLoop(
      { message: "库存还有多少", storeId: "test-store" },
      async () => "不该被调用",
      "",
      3,
      undefined,
      (delta) => tokens.push(delta),
    );

    const answerOf = (decision: AgentDecision) => (decision.tool === "respond" ? String(decision.args.content) : "");
    expect(answerOf(result.finalDecision)).toBe(ANSWER);
    // 推给前端的内容必须正好是这一段，不能是两段拼在一起
    expect(tokens.join("")).toBe(ANSWER);
  });
});

// 搜索类工具一次能返回几十 KB 的 JSON，原样塞回上下文会让每一步都变慢变贵。
// 这组守的是：喂给模型的被截断，但 steps 里给前端渲染的仍是全文。
describe("工具结果进模型上下文的截断", () => {
  const LONG_RESULT = `{"total":10000,"items":[${Array.from({ length: 200 }, (_, i) => `{"id":"${i}","name":"商品${i}"}`).join(",")}]}`;

  it("超长工具结果只把前 1200 字喂给模型，并注明省略了多少", async () => {
    enableLlm();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(sseResponse([toolChunk("chuhaijiang_search", "{\"keyword\":\"毯子\"}", true)]));
    fetchMock.mockResolvedValueOnce(sseResponse([toolChunk("respond", JSON.stringify({ content: "查到很多货源。", followUps: [] }), true)]));

    const result = await reactLoop(
      { message: "帮我找货源", storeId: "test-store" },
      async () => LONG_RESULT,
      "",
      3,
      undefined,
      () => {}, // 传 onToken 才会走流式请求，否则内部改走非流式 JSON 解析
    );

    // 第二次请求的 messages 里带着工具结果——它才是真正花 token 的那一份
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    const toolMessage = secondBody.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    const content = String(toolMessage?.content ?? "");
    expect(content).toContain("已省略后");
    expect(content.length).toBeLessThan(1_400);

    // 但给前端/兜底用的 steps 必须保留全文，否则渲染出来的数据会缺一半
    expect(result.steps[0]?.observation).toBe(LONG_RESULT);
  });

  it("正常长度的工具结果原样保留，不加省略说明", async () => {
    enableLlm();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(sseResponse([toolChunk("get_sales_overview", "{\"days\":7}", true)]));
    fetchMock.mockResolvedValueOnce(sseResponse([toolChunk("respond", JSON.stringify({ content: "近七天 GMV 52 万日元。", followUps: [] }), true)]));

    await reactLoop({ message: "看下最近七天", storeId: "test-store" }, async () => "近7天：支付GMV JP¥529,128", "", 3, undefined, () => {});

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    const toolMessage = secondBody.messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content ?? "")).toContain("JP¥529,128");
    expect(String(toolMessage?.content ?? "")).not.toContain("已省略");
  });
});

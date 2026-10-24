import { afterEach, describe, expect, it, vi } from "vitest";
import { reactLoop, type AgentDecision } from "../server/llm.ts";

/** 联合类型按 tool 收窄后再取正文，避免直接访问 args.content 报类型错 */
function answerOf(decision: AgentDecision): string {
  return decision.tool === "respond" ? String(decision.args.content ?? "") : "";
}

vi.mock("../server/skill-registry.ts", () => ({ getSkillTools: async () => [], getSkillAbilityDescriptions: async () => "" }));
vi.mock("../server/mcp-client.ts", () => ({ getFastMossTools: async () => [], getFastMossAbilityDescription: async () => "" }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const REAL_DATA = "近7天：支付GMV JP¥566,604，客单价 JP¥2,905.66，183个已支付订单，106个商品，6个退货退款申请";

const toolReply = (name: string, args: object) => new Response(JSON.stringify({ choices: [{ message: {
  role: "assistant", content: null,
  tool_calls: [{ id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
} }] }));

function enableLlm() {
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_MODEL", "test-model");
}

// —— 这一组守的是线上真实反馈：「我让他分析，他给我已分析，也不展示结果」——
// 已经查到数据，模型却只回一句「已分析」，绝不能原样发给用户。
describe("reactLoop 不接受空壳回答", () => {
  it("模型只回「已分析」时打回重写，最终给出模型重写后的完整回答", async () => {
    enableLlm();
    const fullAnswer = "近7天订单从366单掉到183单，属于腰斩。建议先补毛绒毯库存，再清理零动销的大库存 SKU。";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolReply("get_sales_overview", { days: 7 }))
      .mockResolvedValueOnce(toolReply("respond", { content: "已分析", followUps: [] }))
      .mockResolvedValueOnce(toolReply("respond", { content: fullAnswer, followUps: [] }));

    const result = await reactLoop({ message: "帮我分析一下这个店铺", storeId: "test-store" }, async () => REAL_DATA, "", 4);

    expect(result.finalDecision.tool).toBe("respond");
    expect(answerOf(result.finalDecision)).toBe(fullAnswer);
    // 打回用的是第二次请求，所以模型一共被调了 3 次（取工具 + 空壳 + 重写）
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("重写后仍是空壳时，用已查到的真实数据兜底，绝不把「已分析」发给用户", async () => {
    enableLlm();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolReply("get_sales_overview", { days: 7 }))
      .mockResolvedValueOnce(toolReply("respond", { content: "已分析", followUps: [] }))
      .mockResolvedValueOnce(toolReply("respond", { content: "分析完成", followUps: [] }));

    const result = await reactLoop({ message: "帮我分析一下这个店铺", storeId: "test-store" }, async () => REAL_DATA, "", 4);

    const content = answerOf(result.finalDecision);
    expect(content).not.toBe("已分析");
    expect(content).not.toBe("分析完成");
    // 兜底必须带上真实数据，并且说清楚这不是模型结论
    expect(content).toContain("没有给出分析结论");
    expect(content).toContain("JP¥566,604");
  });

  it("没有查到任何数据时，空壳回答不触发重写（没有数据可依据，重写也是空转）", async () => {
    enableLlm();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(toolReply("respond", { content: "已分析", followUps: [] }));

    const result = await reactLoop({ message: "帮我分析一下这个店铺", storeId: "test-store" }, async () => REAL_DATA, "", 4);

    // 一次就返回，不会为了没有数据可用的场景多花一次模型调用
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(answerOf(result.finalDecision)).toBe("已分析");
  });
});

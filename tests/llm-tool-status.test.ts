import { afterEach, expect, it, vi } from "vitest";
import { reactLoop } from "../server/llm.ts";

vi.mock("../server/skill-registry.ts", () => ({ getSkillTools: async () => [], getSkillAbilityDescriptions: async () => "" }));
vi.mock("../server/mcp-client.ts", () => ({ getFastMossTools: async () => [], getFastMossAbilityDescription: async () => "" }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("preserves failed tool status in both streamed events and final step history", async () => {
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_MODEL", "test-model");
  const toolReply = (name: string, args: object) => new Response(JSON.stringify({ choices: [{ message: {
    role: "assistant", content: null,
    tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } }] }));
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(toolReply("get_shop_info", {}))
    .mockResolvedValueOnce(toolReply("respond", { content: "查询失败，请重新授权。", followUps: [] }));
  const onStep = vi.fn();
  const result = await reactLoop({ message: "查询店铺", storeId: "test-store" }, async () => { throw new Error("invalid params"); }, "", 2, onStep);
  expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_shop_info" }), expect.stringContaining("invalid params"), 0, true);
  expect(result.steps[0]).toMatchObject({ failed: true, observation: expect.stringContaining("invalid params") });
  expect(result.finalDecision.tool).toBe("respond");
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractMemories } from "../server/llm.ts";

function mockLlmContent(content: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
}

describe("LLM memory extraction", () => {
  // callLlmRaw 在缺少模型配置时会直接抛错（不再发出无凭证请求），这里补齐配置
  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "test-llm-key");
    vi.stubEnv("LLM_MODEL", "test-llm-model");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("accepts only the documented string format", async () => {
    mockLlmContent({
      userPreferences: ["关注利润"],
      shopInsights: ["库存偏高"],
      operationSummary: "生成了经营诊断",
    });

    await expect(extractMemories([{ role: "user", content: "分析店铺" }])).resolves.toEqual({
      userPreferences: ["关注利润"],
      shopInsights: ["库存偏高"],
      operationSummary: "生成了经营诊断",
    });
  });

  it("rejects object entries returned by the model", async () => {
    mockLlmContent({
      userPreferences: [{ preference: "错误对象" }],
      shopInsights: [{ insight: "错误对象" }],
      operationSummary: "",
    });

    await expect(extractMemories([{ role: "user", content: "分析店铺" }])).resolves.toEqual({
      userPreferences: [],
      shopInsights: [],
    });
  });
});

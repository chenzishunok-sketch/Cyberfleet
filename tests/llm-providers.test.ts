import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.ts";
import { getLlmRuntimeConfig } from "../server/llm-providers.ts";

describe("LLM provider bindings", () => {
  const app = createApp();
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(os.tmpdir(), "llm-providers-"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(testDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDERS_STORE", path.join(testDirectory, "llm-providers.json"));
    vi.stubEnv("SKILLS_STORE", path.join(testDirectory, "skills.json"));
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "test-app-key");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "test-app-secret");
    vi.stubEnv("TIKTOK_SHOP_TOKEN_STORE", path.join(testDirectory, "authorization.json"));
    vi.stubEnv("WORKFLOW_DATABASE", path.join(testDirectory, "workflows.sqlite"));
    vi.stubEnv("ACTION_PLAN_DATABASE", path.join(testDirectory, "action-plans.sqlite"));
    vi.stubEnv("INTELLIGENCE_DATABASE", path.join(testDirectory, "intelligence.sqlite"));
    vi.stubEnv("AGENT_MEMORY_PATH", path.join(testDirectory, "memory.json"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(path.join(testDirectory, "llm-providers.json"), { force: true });
  });

  it("starts unbound and reports the missing source", async () => {
    const overview = await request(app).get("/api/llm/providers").expect(200);
    expect(overview.body).toMatchObject({ providers: [], activeId: null, source: "missing", connected: false });
    expect(getLlmRuntimeConfig()).toMatchObject({ source: "missing", apiKey: "" });

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.connections.llm).toBe(false);
  });

  it("adds a provider, auto-activates it and reflects in health", async () => {
    const added = await request(app).post("/api/llm/providers").send({
      name: "DeepSeek 主力",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-test-12345678",
      model: "deepseek-chat",
    }).expect(200);
    // 尾部斜杠被归一化，Key 以脱敏形式回显（前2+全掩码+后2）
    expect(added.body.provider).toMatchObject({ baseUrl: "https://api.deepseek.com/v1", apiKeyMasked: "sk************78", model: "deepseek-chat" });
    expect(added.body.overview).toMatchObject({ activeId: added.body.provider.id, source: "provider", connected: true, name: "DeepSeek 主力", model: "deepseek-chat" });

    expect(getLlmRuntimeConfig()).toMatchObject({ source: "provider", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test-12345678", model: "deepseek-chat", fastModel: "deepseek-chat" });

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.connections.llm).toBe(true);
    expect(health.body.llm).toMatchObject({ connected: true, source: "provider", name: "DeepSeek 主力", model: "deepseek-chat" });
  });

  it("rejects invalid base urls and incomplete payloads", async () => {
    const missingModel = await request(app).post("/api/llm/providers").send({ name: "x", baseUrl: "https://api.test" }).expect(400);
    expect(missingModel.body.error).toContain("模型名称");

    const badUrl = await request(app).post("/api/llm/providers").send({ name: "x", baseUrl: "ftp://api.test", apiKey: "k", model: "m" }).expect(400);
    expect(badUrl.body.error).toContain("http(s)");
  });

  it("keeps the stored api key when an update leaves it blank or masked", async () => {
    const added = await request(app).post("/api/llm/providers").send({
      name: "Kimi", baseUrl: "https://api.moonshot.cn/v1", apiKey: "sk-kimi-99990000", model: "moonshot-v1-8k",
    }).expect(200);

    const updated = await request(app).put(`/api/llm/providers/${added.body.provider.id}`).send({
      name: "Kimi 长文本", apiKey: "", model: "moonshot-v1-32k",
    }).expect(200);
    expect(updated.body.provider).toMatchObject({ name: "Kimi 长文本", model: "moonshot-v1-32k", apiKeyMasked: "sk************00" });

    // 回显的掩码值提交回来不应被当成新密钥
    const remasked = await request(app).put(`/api/llm/providers/${added.body.provider.id}`).send({ apiKey: updated.body.provider.apiKeyMasked }).expect(200);
    expect(remasked.body.provider.apiKeyMasked).toBe("sk************00");

    expect(getLlmRuntimeConfig().apiKey).toBe("sk-kimi-99990000");
  });

  it("tests connectivity with the stored key when the request only references the id", async () => {
    const added = await request(app).post("/api/llm/providers").send({
      name: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "glm-secret-key-00112233", model: "glm-4.5",
    }).expect(200);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "连接成功" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const ok = await request(app).post("/api/llm/providers/test").send({ id: added.body.provider.id, apiKey: "gl****33" }).expect(200);
    expect(ok.body).toMatchObject({ ok: true });
    expect(typeof ok.body.latencyMs).toBe("number");
    expect(ok.body.reply).toContain("连接成功");
    // 掩码 Key 被替换为已保存的完整密钥
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer glm-secret-key-00112233");

    // 上游错误（如 Key 无效）透传真实原因且不回显完整密钥
    fetchMock.mockRestore();
    const failMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Incorrect API key provided: glm-secret-key-00112233" },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const failed = await request(app).post("/api/llm/providers/test").send({ id: added.body.provider.id }).expect(200);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.error).toContain("Incorrect API key");
    expect(failed.body.error).not.toContain("glm-secret-key-00112233");
    failMock.mockRestore();
  });

  it("lists models from the upstream catalog", async () => {
    const added = await request(app).post("/api/llm/providers").send({
      name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-abc", model: "openai/gpt-4o-mini",
    }).expect(200);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-3.5-sonnet" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const models = await request(app).post("/api/llm/providers/models").send({ id: added.body.provider.id }).expect(200);
    expect(models.body.models).toEqual(["anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"]);
  });

  it("imports the .env configuration as a manageable provider and rejects when absent", async () => {
    vi.stubEnv("LLM_API_KEY", "env-secret-key-44556677");
    vi.stubEnv("LLM_MODEL", "env-model");
    vi.stubEnv("LLM_BASE_URL", "https://env.provider.test/v1");

    const imported = await request(app).post("/api/llm/providers/import-env").expect(200);
    expect(imported.body.provider).toMatchObject({ name: ".env 导入", baseUrl: "https://env.provider.test/v1", model: "env-model", apiKeyMasked: "en*******************77" });
    expect(imported.body.overview).toMatchObject({ activeId: imported.body.provider.id, source: "provider", baseUrl: "https://env.provider.test/v1" });

    // 导入后原 .env 仍作为回落来源
    await request(app).delete(`/api/llm/providers/${imported.body.provider.id}`).expect(200);
    expect(getLlmRuntimeConfig()).toMatchObject({ source: "env", model: "env-model" });
  });

  it("rejects env import when no env model configuration exists", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    const rejected = await request(app).post("/api/llm/providers/import-env").expect(400);
    expect(rejected.body.error).toContain(".env");
  });

  it("activates another provider and falls back to env after unbinding the active one", async () => {
    vi.stubEnv("LLM_API_KEY", "env-secret-key");
    vi.stubEnv("LLM_MODEL", "env-model");

    const first = await request(app).post("/api/llm/providers").send({
      name: "A 服务", baseUrl: "https://a.test/v1", apiKey: "sk-a", model: "model-a",
    }).expect(200);
    const second = await request(app).post("/api/llm/providers").send({
      name: "B 服务", baseUrl: "https://b.test/v1", apiKey: "sk-b", model: "model-b",
    }).expect(200);
    // 首个自动激活，第二个不会抢占
    expect(first.body.overview.activeId).toBe(first.body.provider.id);
    expect(second.body.overview.activeId).toBe(first.body.provider.id);

    const activated = await request(app).post(`/api/llm/providers/${second.body.provider.id}/activate`).expect(200);
    expect(activated.body.overview.activeId).toBe(second.body.provider.id);
    expect(getLlmRuntimeConfig()).toMatchObject({ source: "provider", model: "model-b" });

    await request(app).delete(`/api/llm/providers/${second.body.provider.id}`).expect(200);
    // 解绑当前服务后回落 .env 配置
    expect(getLlmRuntimeConfig()).toMatchObject({ source: "env", apiKey: "env-secret-key", model: "env-model", baseUrl: "https://api.openai.com/v1" });

    const overview = await request(app).get("/api/llm/providers").expect(200);
    expect(overview.body).toMatchObject({ activeId: null, source: "env", connected: true });
    expect(overview.body.providers).toHaveLength(1);

    const missing = await request(app).delete(`/api/llm/providers/${second.body.provider.id}`).expect(400);
    expect(missing.body.error).toContain("没有找到");
  });
});

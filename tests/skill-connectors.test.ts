import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.ts";

describe("business connector bindings", () => {
  const app = createApp();
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(os.tmpdir(), "skill-connectors-"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(testDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("SKILLS_STORE", path.join(testDirectory, "skills.json"));
    vi.stubEnv("LLM_PROVIDERS_STORE", path.join(testDirectory, "llm-providers.json"));
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
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
  });

  async function miaoshouStatus() {
    const catalog = await request(app).get("/api/skills").expect(200);
    return catalog.body.statuses.find((status: { id: string }) => status.id === "miaoshou");
  }

  it("saves connector credentials via the config endpoint with masking", async () => {
    await request(app).put("/api/skills/miaoshou/config").send({
      config: { appKey: "ms-app-key-0011", appSecret: "ms-app-secret-2233", baseUrl: "" },
    }).expect(200);

    const status = await miaoshouStatus();
    expect(status.configSource).toBe("skill");
    expect(status.configured).toBe(true);
    expect(status.connectionState).toBe("configured");
    expect(status.config.appKey).toBe("ms-app-key-0011");
    expect(status.config.appSecret).toMatch(/^ms\*+33$/);
  });

  it("keeps the stored secret when the masked value is resubmitted", async () => {
    const before = await miaoshouStatus();
    await request(app).put("/api/skills/miaoshou/config").send({
      config: { appKey: "ms-app-key-0011", appSecret: before.config.appSecret },
    }).expect(200);

    const after = await miaoshouStatus();
    expect(after.config.appSecret).toBe(before.config.appSecret);
  });

  it("disconnect falls back to env configuration and rejects when nothing is stored", async () => {
    vi.stubEnv("MIAOSHOU_APP_KEY", "env-miaoshou-key");
    vi.stubEnv("MIAOSHOU_APP_SECRET", "env-miaoshou-secret");

    const removed = await request(app).delete("/api/skills/miaoshou/config").expect(200);
    expect(removed.body.ok).toBe(true);
    const status = await miaoshouStatus();
    expect(status.configSource).toBe("env");
    expect(status.configured).toBe(true);

    const replay = await request(app).delete("/api/skills/miaoshou/config").expect(400);
    expect(replay.body.error).toContain(".env");
  });

  it("miaoshou connection test passes through the real probe endpoint", async () => {
    vi.stubEnv("MIAOSHOU_APP_KEY", "env-miaoshou-key");
    vi.stubEnv("MIAOSHOU_APP_SECRET", "env-miaoshou-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: "success",
      data: { result: [{ id: 1 }] },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await request(app).post("/api/skills/miaoshou/test").expect(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.detail).toContain("鉴权通过");
    // 探针请求必须带妙手签名头
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("x-app-key")).toBe("env-miaoshou-key");
    expect(headers.get("x-sign")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tmapi connection test surfaces the real upstream error mapping", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "bad-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 401,
      message: "token error",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await request(app).post("/api/skills/tmapi-1688/test").expect(200);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain("Token 无效");
  });

  it("feishu connection test uses the saved credentials and reports failures", async () => {
    await request(app).put("/api/skills/feishu/config").send({
      config: { appId: "cli_test_app", appSecret: "feishu-secret-9988" },
    }).expect(200);

    const okMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      tenant_access_token: "tenant-token",
      expire: 7200,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const ok = await request(app).post("/api/skills/feishu/test").expect(200);
    expect(ok.body.ok).toBe(true);
    const body = JSON.parse(String(okMock.mock.calls[0][1]?.body));
    // 测试必须用刚保存的凭证（token 缓存已被端点清空）
    expect(body.app_id).toBe("cli_test_app");
    expect(body.app_secret).toBe("feishu-secret-9988");

    okMock.mockRestore();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 10003,
      msg: "invalid app_id",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const failed = await request(app).post("/api/skills/feishu/test").expect(200);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.error).toContain("invalid app_id");
  });

  it("rejects tests for unconfigured connectors and for tiktok-shop", async () => {
    vi.stubEnv("CHUHAIJIANG_API_KEY", "");
    const unconfigured = await request(app).post("/api/skills/chuhaijiang/test").expect(200);
    expect(unconfigured.body.ok).toBe(false);
    expect(unconfigured.body.error).toContain("尚未配置");

    const tiktok = await request(app).post("/api/skills/tiktok-shop/test").expect(400);
    expect(tiktok.body.error).toContain("店铺绑定");
  });
});

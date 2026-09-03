import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFeishuTokenCache, getFeishuConnectionStatus } from "../server/feishu-client.ts";

describe("Feishu client", () => {
  afterEach(() => {
    clearFeishuTokenCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("verifies configured application credentials without exposing the token", async () => {
    vi.stubEnv("FEISHU_APP_ID", "cli_test");
    vi.stubEnv("FEISHU_APP_SECRET", "secret_test");
    vi.stubEnv("FEISHU_BASE_URL", "https://open.feishu.test/open-apis");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      tenant_access_token: "tenant-token",
      expire: 7200,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(getFeishuConnectionStatus()).resolves.toEqual({ configured: true, connected: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.test/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

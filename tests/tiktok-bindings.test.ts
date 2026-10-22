import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindingsStorePath,
  completeTikTokAuthorization,
  createTikTokAuthorizationUrl,
  getAuthorizedTikTokClient,
  getTikTokConnectionStatus,
  listBindings,
  readBindings,
  readStoredAuthorization,
  removeBinding,
  selectAuthorizedShop,
} from "../server/tiktok-auth.ts";

const now = Math.floor(Date.now() / 1000);

function sellerToken(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-a1",
    access_token_expire_in: now + 604800,
    refresh_token: "refresh-a1",
    refresh_token_expire_in: now + 31536000,
    user_type: 0,
    seller_name: "Seller A",
    seller_base_region: "CN",
    open_id: "open-a",
    granted_scopes: ["seller.authorization.info"],
    ...overrides,
  };
}

function shop(id: string, name: string, region: string, cipher: string) {
  return { id, name, region, cipher };
}

/** 走一遍真实 OAuth 链路（token 交换 + 店铺列表均由 mock fetch 提供） */
async function authorizeRound(options: { code: string; token: Record<string, unknown>; shops: Array<Record<string, unknown>> }) {
  const url = createTikTokAuthorizationUrl();
  const state = new URL(url).searchParams.get("state") ?? "";
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: "Success", data: options.token }), { status: 200, headers: { "content-type": "application/json" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: "Success", data: { shops: options.shops } }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    return await completeTikTokAuthorization({ code: options.code, state, browserState: state });
  } finally {
    fetchMock.mockRestore();
  }
}

describe("TikTok multi-store bindings", () => {
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(os.tmpdir(), "tiktok-bindings-"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(testDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "test-app-key");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "test-app-secret");
    vi.stubEnv("TIKTOK_SHOP_TOKEN_STORE", path.join(testDirectory, "bindings.json"));
    vi.stubEnv("SKILLS_STORE", path.join(testDirectory, "skills.json"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(path.join(testDirectory, "bindings.json"), { force: true });
    await rm(path.join(testDirectory, "bindings.json.v1.bak"), { force: true });
  });

  it("reports ready_to_authorize before any binding exists", async () => {
    await expect(getTikTokConnectionStatus()).resolves.toEqual({ status: "ready_to_authorize", connected: false });
  });

  it("migrates a v1 authorization file in place and keeps a backup", async () => {
    const storePath = bindingsStorePath();
    await writeFile(storePath, JSON.stringify({
      version: 1,
      accessToken: "legacy-access",
      accessTokenExpiresAt: now + 604800,
      refreshToken: "legacy-refresh",
      refreshTokenExpiresAt: now + 31536000,
      grantedScopes: ["seller.authorization.info"],
      shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")],
      selectedShopCipher: "cipher-th",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const store = await readBindings();
    expect(store.version).toBe(2);
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]).toMatchObject({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
    expect(store.selected).toEqual({ grantId: store.grants[0].grantId, shopId: "shop-th" });
    // 旧文件内容保留备份，可回滚
    await expect(readFile(`${storePath}.v1.bak`, "utf8")).resolves.toContain("legacy-access");
  });

  it("binds a new seller account and auto-selects its single shop", async () => {
    const result = await authorizeRound({ code: "code-a", token: sellerToken(), shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")] });
    expect(result.selectedShop?.id).toBe("shop-th");

    const bindings = await listBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ sellerName: "Seller A", status: "connected", selectedShopId: "shop-th" });
    expect(bindings[0].grantId).toEqual(expect.any(String));

    await expect(getTikTokConnectionStatus()).resolves.toMatchObject({ status: "connected", connected: true, shopName: "Mikolo", region: "TH" });
    await expect(readStoredAuthorization()).resolves.toMatchObject({ accessToken: "access-a1", selectedShopCipher: "cipher-th" });
  });

  it("re-authorizing the same seller replaces its grant instead of duplicating", async () => {
    await authorizeRound({ code: "code-a1", token: sellerToken(), shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")] });
    await authorizeRound({
      code: "code-a2",
      token: sellerToken({ access_token: "access-a2", refresh_token: "refresh-a2", seller_name: "Seller A Renamed" }),
      shops: [shop("shop-th", "Mikolo", "TH", "cipher-th-2")],
    });

    const store = await readBindings();
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0]).toMatchObject({ accessToken: "access-a2", sellerName: "Seller A Renamed" });
    // 换绑当前账号时保持原选中店铺
    expect(store.selected).toEqual({ grantId: store.grants[0].grantId, shopId: "shop-th" });
  });

  it("adds a second seller as a separate grant and switches the active shop across grants", async () => {
    await authorizeRound({ code: "code-a", token: sellerToken(), shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")] });
    await authorizeRound({
      code: "code-b",
      token: sellerToken({ open_id: "open-b", seller_name: "Seller B", access_token: "access-b1", refresh_token: "refresh-b1" }),
      shops: [shop("shop-us", "US Shop", "US", "cipher-us")],
    });

    const store = await readBindings();
    expect(store.grants).toHaveLength(2);
    // 已有选中店铺时，新绑定不抢占当前选择
    expect(store.selected?.shopId).toBe("shop-th");

    await selectAuthorizedShop("shop-us");
    await expect(getTikTokConnectionStatus()).resolves.toMatchObject({ status: "connected", shopName: "US Shop", region: "US" });
    await expect(readStoredAuthorization()).resolves.toMatchObject({ accessToken: "access-b1" });
  });

  it("requires an explicit shop selection when a grant returns multiple country shops", async () => {
    await authorizeRound({
      code: "code-a",
      token: sellerToken(),
      shops: [shop("shop-us", "US Shop", "US", "cipher-us"), shop("shop-gb", "UK Shop", "GB", "cipher-gb")],
    });

    const status = await getTikTokConnectionStatus();
    expect(status.status).toBe("shop_selection_required");
    expect(status.shops).toHaveLength(2);
    expect(status.bindings).toHaveLength(1);
    expect(status.bindings?.[0].selectedShopId).toBeUndefined();

    await selectAuthorizedShop("shop-gb");
    await expect(getTikTokConnectionStatus()).resolves.toMatchObject({ status: "connected", shopName: "UK Shop", region: "GB" });
  });

  it("unbinds a grant and clears the selection when the removed one was active", async () => {
    await authorizeRound({ code: "code-a", token: sellerToken(), shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")] });
    await authorizeRound({
      code: "code-b",
      token: sellerToken({ open_id: "open-b", seller_name: "Seller B", access_token: "access-b1", refresh_token: "refresh-b1" }),
      shops: [shop("shop-us", "US Shop", "US", "cipher-us")],
    });

    const bindings = await listBindings();
    const sellerB = bindings.find((binding) => binding.sellerName === "Seller B");
    expect(sellerB).toBeDefined();

    await selectAuthorizedShop("shop-us", sellerB!.grantId);
    await removeBinding(sellerB!.grantId);

    const store = await readBindings();
    expect(store.grants).toHaveLength(1);
    expect(store.selected).toBeNull();
    await expect(getTikTokConnectionStatus()).resolves.toMatchObject({ status: "shop_selection_required", connected: false });
    await expect(removeBinding("missing-grant")).rejects.toThrow("没有找到");
  });

  it("uses the wizard-configured service_id in the authorization link even when .env pins an old one", async () => {
    vi.stubEnv("TIKTOK_SHOP_AUTH_URL", "https://services.tiktokshop.com/open/authorize?service_id=1111111111111111111");
    await writeFile(path.join(testDirectory, "skills.json"), JSON.stringify({
      "tiktok-shop": { installed: true, enabled: true, config: { appKey: "k", appSecret: "s", serviceId: "7678553331228559111" } },
    }));
    try {
      const url = new URL(createTikTokAuthorizationUrl());
      expect(url.searchParams.get("service_id")).toBe("7678553331228559111");
      expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refreshes expired tokens through token/refresh and persists rotated credentials", async () => {
    await authorizeRound({ code: "code-expired", token: sellerToken(), shops: [shop("shop-jp", "Cashio", "JP", "cipher-jp")] });
    const store = await readBindings();
    store.grants[0].accessTokenExpiresAt = now - 100;
    await writeFile(bindingsStorePath(), JSON.stringify(store));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://auth.tiktok-shops.com");
      expect(url.pathname).toBe("/api/v2/token/refresh");
      expect(url.searchParams.get("grant_type")).toBe("refresh_token");
      expect(url.searchParams.get("refresh_token")).toBe("refresh-a1");
      expect(url.searchParams.has("auth_code")).toBe(false);
      return new Response(JSON.stringify({ code: 0, data: sellerToken({ access_token: "access-new", refresh_token: "refresh-new" }) }));
    });
    // 并发读取共享一次刷新，不能重复轮换令牌。
    const clients = await Promise.all([getAuthorizedTikTokClient(), getAuthorizedTikTokClient()]);
    expect(clients.every(Boolean)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readBindings()).grants[0]).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-new" });
    await getAuthorizedTikTokClient();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives per-binding token status without network calls", async () => {
    await writeFile(bindingsStorePath(), JSON.stringify({
      version: 2,
      selected: { grantId: "grant-expired", shopId: "shop-th" },
      grants: [
        {
          grantId: "grant-expired",
          accessToken: "token-expired",
          accessTokenExpiresAt: now - 100,
          refreshToken: "refresh-valid",
          refreshTokenExpiresAt: now + 31536000,
          sellerName: "Expired Seller",
          grantedScopes: ["seller.authorization.info"],
          shops: [shop("shop-th", "Mikolo", "TH", "cipher-th")],
          authorizedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          grantId: "grant-invalid",
          accessToken: "token-invalid",
          accessTokenExpiresAt: now - 200,
          refreshToken: "refresh-invalid",
          refreshTokenExpiresAt: now - 100,
          sellerName: "Invalid Seller",
          grantedScopes: ["seller.authorization.info"],
          shops: [shop("shop-jp", "JP Shop", "JP", "cipher-jp")],
          authorizedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }));

    const bindings = await listBindings();
    expect(bindings.map((binding) => binding.status)).toEqual(["expired", "invalid"]);
    // 不触发网络刷新：绑定列表接口保持纯本地计算
    await expect(listBindings()).resolves.toHaveLength(2);
  });
});

import request from "supertest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.ts";
import { getAuthorizedTikTokClient } from "../server/tiktok-auth.ts";
import { TikTokShopClient } from "../server/tiktok-client.ts";
import { clearTikTokDataCache } from "../server/tiktok-data.ts";
import { inferTikTokSceneQuery } from "../server/tiktok-scenes.ts";
import { inferMiaoshouSceneQuery } from "../server/miaoshou-scenes.ts";
import { cleanAssistantText } from "../server/response-presentation.ts";

describe("ShopPilot API", () => {
  const app = createApp();
  let authTestDirectory: string;

  beforeAll(async () => {
    authTestDirectory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-auth-"));
  });

  beforeEach(() => {
    vi.stubEnv("FRONTEND_URL", "http://localhost:5173");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("TMAPI_API_TOKEN", "");
    vi.stubEnv("FEISHU_APP_ID", "");
    vi.stubEnv("FEISHU_APP_SECRET", "");
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "");
    vi.stubEnv("TIKTOK_SHOP_ACCESS_TOKEN", "");
    vi.stubEnv("TIKTOK_SHOP_SHOP_CIPHER", "");
    vi.stubEnv("TIKTOK_SHOP_TOKEN_STORE", path.join(authTestDirectory, "authorization.json"));
    vi.stubEnv("SKILLS_STORE", path.join(authTestDirectory, "skills.json"));
    vi.stubEnv("LLM_PROVIDERS_STORE", path.join(authTestDirectory, "llm-providers.json"));
    vi.stubEnv("WORKFLOW_DATABASE", path.join(authTestDirectory, "workflows.sqlite"));
    vi.stubEnv("ACTION_PLAN_DATABASE", path.join(authTestDirectory, "action-plans.sqlite"));
    vi.stubEnv("INTELLIGENCE_DATABASE", path.join(authTestDirectory, "intelligence.sqlite"));
    vi.stubEnv("AGENT_MEMORY_PATH", path.join(authTestDirectory, "memory.json"));
  });

  afterEach(async () => {
    clearTikTokDataCache();
    vi.restoreAllMocks();
    await rm(path.join(authTestDirectory, "authorization.json"), { force: true });
    await rm(path.join(authTestDirectory, "skills.json"), { force: true });
    await rm(path.join(authTestDirectory, "llm-providers.json"), { force: true });
    await rm(path.join(authTestDirectory, "memory.json"), { force: true });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(authTestDirectory, { recursive: true, force: true });
  });

  it("publishes the complete active-scope capability catalog without credentials", async () => {
    const response = await request(app).get("/api/capabilities").expect(200);

    expect(response.body).toMatchObject({
      totalOperations: 164,
      sellerOperations: 157,
      creatorOperations: 7,
    });
    expect(response.body.scenes).toHaveLength(11);
    expect(response.body.scopes).toHaveLength(23);
    expect(response.body.excludedScopes.map((scope: { key: string }) => scope.key)).toEqual([
      "seller.customer_service",
      "seller.redeem_info.write",
    ]);
    const operations = response.body.scenes.flatMap((scene: { operations: Array<Record<string, unknown>> }) => scene.operations);
    expect(new Set(operations.map((operation: { id: string }) => operation.id)).size).toBe(164);
    expect(operations.filter((operation: { status: string }) => operation.status === "creator_authorization_required")).toHaveLength(7);
    expect(operations.some((operation: { method: string }) => operation.method === "PUT")).toBe(true);
    expect(operations.some((operation: { method: string }) => operation.method === "DELETE")).toBe(true);
    expect(operations.every((operation: { officialUrl: string }) => operation.officialUrl.startsWith("https://partner.tiktokshop.com/docv2/page/"))).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/accessToken|refreshToken|appSecret|shopCipher/);
    expect(operations.flatMap((operation: { scopeKeys: string[] }) => operation.scopeKeys)).not.toContain("serller.product.optimize");
  });

  it("signs and sends PUT and DELETE request bodies through the TikTok transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ code: 0, message: "Success", data: {} }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "transport-key",
      appSecret: "transport-secret",
      accessToken: "transport-token",
      shopCipher: "transport-shop",
    });

    await client.request("/promotion/202309/activities/activity-1", { method: "PUT", body: { title: "Updated" } });
    await client.request("/promotion/202309/activities/activity-1/products", { method: "DELETE", body: { product_ids: ["product-1"] } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get("app_key")).toBe("transport-key");
      expect(url.searchParams.get("shop_cipher")).toBe("transport-shop");
      expect(url.searchParams.get("sign")).toMatch(/^[a-f0-9]{64}$/);
      expect(new Headers(init?.headers).get("x-tts-access-token")).toBe("transport-token");
      expect(init?.body).toEqual(expect.any(String));
    }
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PUT");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("routes colloquial and combined scene questions to distinct TikTok APIs", () => {
    expect(inferTikTokSceneQuery("最近什么商品好卖")).toBe("market_products");
    expect(inferTikTokSceneQuery("查询店铺里哪些商品最好卖")).toBe("shop_products");
    expect(inferTikTokSceneQuery("查看近 7 天热门带货视频")).toBe("market_videos");
    expect(inferTikTokSceneQuery("查看近 7 天热门带货直播")).toBe("market_lives");
    expect(inferTikTokSceneQuery("查看当前店铺仓库")).toBe("warehouses");
    expect(inferTikTokSceneQuery("查看未结算订单")).toBe("finance_unsettled");
    expect(inferTikTokSceneQuery("当前有哪些促销和优惠券")).toBe("promotions_overview");
  });

  it("only routes ambiguous inventory and after-sales reads to Miaoshou when ERP is explicit", () => {
    expect(inferMiaoshouSceneQuery("查看全部商品库存")).toBeUndefined();
    expect(inferMiaoshouSceneQuery("查看最近退货退款")).toBeUndefined();
    expect(inferMiaoshouSceneQuery("查看妙手库存列表")).toBe("miaoshou_inventory");
    expect(inferMiaoshouSceneQuery("查询 ERP 退货列表")).toBe("miaoshou_returns");
    expect(inferMiaoshouSceneQuery("查看妙手包裹列表")).toBe("miaoshou_packages");
  });

  it("cleans Markdown noise while preserving business identifiers and negative values", () => {
    const content = cleanAssistantText("****\n**诊断优先级**\n- 先看 REAL-SKU-01\n- 对比 2026-07-25 的 -3.1%\n---");
    expect(content).toBe("诊断优先级：\n1. 先看 REAL-SKU-01\n2. 对比 2026-07-25 的 -3.1%");
    expect(content).not.toMatch(/\*\*|^[-*]\s/m);
  });

  it("uses live TikTok data for dashboard and returns different answers by intent", async () => {
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "test-app-key");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "test-app-secret");
    const now = Math.floor(Date.now() / 1000);
    await writeFile(path.join(authTestDirectory, "authorization.json"), JSON.stringify({
      version: 1,
      accessToken: "live-access-token",
      accessTokenExpiresAt: now + 604800,
      refreshToken: "live-refresh-token",
      refreshTokenExpiresAt: now + 31536000,
      userType: 0,
      grantedScopes: ["seller.authorization.info", "seller.product.basic", "seller.product.write", "seller.order.info", "data.shop_analytics.public.read", "data.bestselling.public.read"],
      shops: [{ id: "shop-real", name: "Real Shop", region: "JP", cipher: "real-cipher" }],
      selectedShopCipher: "real-cipher",
      updatedAt: new Date().toISOString(),
    }));

    let realStock = 8;
    const productSearchBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
      const url = new URL(String(input));
      const json = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Success", data }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/product/202502/products/search") {
        productSearchBodies.push(JSON.parse(String(init.body ?? "{}")));
        return json({ total_count: 1, next_page_token: "", products: [{
          id: "product-real",
          title: "真实商品",
          status: "ACTIVATE",
          skus: [
            { id: "sku-real", seller_sku: "REAL-SKU", inventory: [{ quantity: realStock }], price: { currency: "JPY", sale_price: "99" } },
            { id: "sku-blue", seller_sku: "REAL-BLUE", inventory: [{ quantity: 3 }], price: { currency: "JPY", sale_price: "109" } },
          ],
        }] });
      }
      if (url.pathname === "/order/202309/orders/search") return json({ total_count: 0, next_page_token: "", orders: [] });
      if (url.pathname === "/return_refund/202309/returns/search") return json({
        total_count: 1,
        next_page_token: "",
        return_orders: [{ return_id: "return-real", order_id: "order-real", return_status: "COMPLETED", return_reason_text: "商品与描述不符" }],
      });
      if (url.pathname === "/analytics/202509/shop/performance") return json({
        latest_available_date: "2026-07-25",
        performance: { intervals: [{
          start_date: "2026-07-25",
          end_date: "2026-07-25",
          sales: { orders_count: 1, gmv: { overall: { amount: "100", currency: "JPY" } }, refunds: { amount: "0", currency: "JPY" } },
        }] },
      });
      if (url.pathname === "/analytics/202511/products/bestselling") return json({ products: [{
        rank: 1,
        name: "真实市场热销商品",
        gmv_range: "JPY1000~JPY2000",
        shop_name: "真实市场店铺",
        rating: "4.9",
      }] });
      if (url.pathname === "/product/202309/products/product-real") {
        return json({
          id: "product-real",
          title: "真实商品",
          status: "ACTIVATE",
          skus: [
            { id: "sku-real", seller_sku: "REAL-SKU", inventory: [{ warehouse_id: "warehouse-real", quantity: realStock }], price: { currency: "JPY", sale_price: "99" } },
            { id: "sku-blue", seller_sku: "REAL-BLUE", inventory: [{ warehouse_id: "warehouse-real", quantity: 3 }], price: { currency: "JPY", sale_price: "109" } },
          ],
          main_images: [{ thumb_urls: ["https://example.test/product.jpg"] }],
        });
      }
      if (url.pathname === "/product/202309/inventory/search") {
        return json({ inventory: [{ product_id: "product-real", skus: [
          { id: "sku-real", seller_sku: "REAL-SKU", total_available_quantity: realStock },
          { id: "sku-blue", seller_sku: "REAL-BLUE", total_available_quantity: 3 },
        ] }] });
      }
      if (url.pathname === "/product/202309/products/product-real/inventory/update") {
        const payload = JSON.parse(String(init.body));
        realStock = payload.skus[0].inventory[0].quantity;
        return new Response(JSON.stringify({ code: 0, message: "Success", request_id: "inventory-request-real", data: { errors: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected TikTok API path: ${url.pathname}`);
    });

    const liveDashboard = await request(app).get("/api/dashboard").expect(200);
    expect(liveDashboard.body).toMatchObject({
      dataSource: "tiktok",
      store: { id: "shop-real", name: "Real Shop", region: "日本", currency: "JPY" },
      products: [{ id: "product-real", title: "真实商品", sku: "2 个 SKU", stock: 11, units: 0 }],
    });
    expect(liveDashboard.body.metrics.find((metric: { label: string; value: string }) => metric.label === "支付 GMV").value).toContain("100");
    expect(liveDashboard.body.metrics.find((metric: { label: string; value: string }) => metric.label === "订单数").value).toBe("0");
    expect(liveDashboard.body.salesSeries.at(-1).date).toBe("7/25");
    expect(productSearchBodies).toContainEqual({ status: "ACTIVATE" });

    const productAnswer = await request(app).post("/api/chat").send({ message: "我的店铺有多少个商品", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(productAnswer.body.message.artifact).toMatchObject({ kind: "products", totalCount: 1, headline: "TikTok Shop 当前共有 1 个商品。" });
    expect(productAnswer.body.message.artifact.products[0].title).toBe("真实商品");

    const compositeAnswer = await request(app).post("/api/chat").send({
      message: "你可以上架下架商品吗，或者告诉我最近什么好卖",
      storeId: "shop-real",
      mode: "analysis",
    }).expect(200);
    expect(compositeAnswer.body.message.content).toContain("官方 市场热销商品榜");
    expect(compositeAnswer.body.message.artifact).toMatchObject({
      kind: "records",
      headline: "7 天市场热销商品",
      rows: [{ rank: "1", name: "真实市场热销商品", gmv_range: "JPY1000~JPY2000" }],
    });
    expect(compositeAnswer.body.message.followUps).toHaveLength(3);
    expect(compositeAnswer.body.message.followUps).toContain("查看近 7 天市场热销达人");

    const bestSellerAnswer = await request(app).post("/api/chat").send({ message: "最近什么好卖", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(bestSellerAnswer.body.message.content).toContain("官方 市场热销商品榜");
    expect(bestSellerAnswer.body.message.artifact).toMatchObject({ kind: "records", rows: [{ name: "真实市场热销商品" }] });

    const colloquialBestSellerAnswer = await request(app).post("/api/chat").send({ message: "最近什么商品好卖", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(colloquialBestSellerAnswer.body.message.artifact).toMatchObject({ kind: "records", rows: [{ name: "真实市场热销商品" }] });

    const listingCapabilityAnswer = await request(app).post("/api/chat").send({ message: "你能帮我下架商品吗", storeId: "shop-real", mode: "execute" }).expect(200);
    expect(listingCapabilityAnswer.body.message.content).toContain("明确的商品目标");
    expect(listingCapabilityAnswer.body.message.artifact).toBeUndefined();
    expect(listingCapabilityAnswer.body.message.followUps).toEqual(["查看全部商品库存", "查询仓库列表", "查询卖家权限"]);

    const orderAnswer = await request(app).post("/api/chat").send({ message: "最近 7 天有多少订单", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(orderAnswer.body.message.artifact).toMatchObject({
      kind: "records",
      headline: "近 7 天订单",
      rows: [],
    });
    expect(orderAnswer.body.message.artifact.summary).toContain("本次返回 0 条");
    expect(orderAnswer.body.message.followUps).toEqual(["查看最近 30 天订单", "查询待发货订单", "查看当前促销活动"]);
    expect(orderAnswer.body.message.followUps).not.toEqual(bestSellerAnswer.body.message.followUps);

    const gmvAnswer = await request(app).post("/api/chat").send({ message: "最近 7 天 GMV 是多少", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(gmvAnswer.body.message.artifact.headline).toContain("100");
    expect(gmvAnswer.body.message.artifact.metrics.map((metric: { label: string }) => metric.label)).toEqual(["支付 GMV", "客单价"]);
    expect(gmvAnswer.body.message.artifact.series.at(-1).date).toBe("7/25");

    const skuAnswer = await request(app).post("/api/chat").send({ message: "REAL-SKU 库存多少", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(skuAnswer.body.message.artifact).toMatchObject({
      kind: "products",
      headline: "REAL-SKU 当前可售库存为 8 件。",
      products: [{ sku: "REAL-SKU", stock: 8 }],
    });

    const refundReasonAnswer = await request(app).post("/api/chat").send({ message: "分析最近 7 天退款原因", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(refundReasonAnswer.body.message.artifact.headline).toContain("商品与描述不符（1 个）");
    expect(refundReasonAnswer.body.message.artifact.series).toEqual([]);

    const shopAnswer = await request(app).post("/api/chat").send({ message: "我的店铺叫什么", storeId: "shop-real", mode: "analysis" }).expect(200);
    expect(shopAnswer.body.message.content).toContain("Real Shop");
    expect(shopAnswer.body.message.artifact).toBeUndefined();

    const writeAnswer = await request(app).post("/api/chat").send({ message: "将 REAL-SKU 库存修改为 7", storeId: "shop-real", mode: "execute" }).expect(200);
    expect(writeAnswer.body.message.artifact).toMatchObject({
      kind: "approval",
      plan: {
        tool: "inventory.update",
        status: "pending",
        diffs: [{ target: "REAL-SKU", before: "8", after: "7" }],
      },
    });
    expect(writeAnswer.body.message.followUps).toBeUndefined();
    const livePlanId = writeAnswer.body.message.artifact.plan.id;
    const liveApproval = await request(app).post(`/api/actions/${livePlanId}/approve`).expect(200);
    expect(liveApproval.body.message.artifact).toMatchObject({ kind: "receipt", requestId: "inventory-request-real" });
    expect(liveApproval.body.dashboard.products[0].stock).toBe(10);
    await request(app).post(`/api/actions/${livePlanId}/approve`).expect(409);
  });

  it("completes TikTok OAuth and stores the authorized shop cipher", async () => {
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "test-app-key");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "test-app-secret");

    const authorization = await request(app).get("/api/tiktok/authorize").expect(302);
    const authorizationUrl = new URL(authorization.headers.location);
    const state = authorizationUrl.searchParams.get("state");
    const oauthCookie = authorization.headers["set-cookie"][0].split(";")[0];
    expect(authorizationUrl.origin).toBe("https://services.tiktokshop.com");
    expect(authorizationUrl.searchParams.get("service_id")).toBe("7660083559697663764");
    expect(state).toMatch(/^[a-f0-9]{64}$/);

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        message: "Success",
        data: {
          access_token: "test-access-token",
          access_token_expire_in: Math.floor(Date.now() / 1000) + 604800,
          refresh_token: "test-refresh-token",
          refresh_token_expire_in: Math.floor(Date.now() / 1000) + 31536000,
          user_type: 0,
          seller_name: "Test Shop",
          seller_base_region: "US",
          granted_scopes: ["seller.authorization.info"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        message: "Success",
        data: { shops: [{ id: "shop-1", name: "Test Shop", region: "US", cipher: "test-shop-cipher" }] },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: "Success", data: { products: [] } }), { status: 200, headers: { "content-type": "application/json" } }));

    await request(app)
      .get(`/api/tiktok/callback?auth_code=test-auth-code&state=${state}`)
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const callback = await request(app)
      .get(`/api/tiktok/callback?auth_code=test-auth-code&state=${state}`)
      .set("Cookie", oauthCookie)
      .expect(200);
    expect(callback.text).toContain("TikTok Shop 已连接");
    // 中转页跳回前端时携带绑定结果参数，供前端提示并刷新绑定列表
    expect(callback.text).toContain("bind=tiktok");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const tokenUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(tokenUrl.hostname).toBe("auth.tiktok-shops.com");
    expect(tokenUrl.searchParams.get("grant_type")).toBe("authorized_code");
    expect(tokenUrl.searchParams.get("auth_code")).toBe("test-auth-code");

    const shopUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(shopUrl.pathname).toBe("/authorization/202309/shops");
    expect(shopUrl.searchParams.has("shop_cipher")).toBe(false);

    const stored = JSON.parse(await readFile(path.join(authTestDirectory, "authorization.json"), "utf8"));
    expect(stored.version).toBe(2);
    expect(stored.grants).toHaveLength(1);
    expect(stored.grants[0]).toMatchObject({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      sellerName: "Test Shop",
      shops: [{ name: "Test Shop", region: "US", cipher: "test-shop-cipher" }],
    });
    expect(stored.selected).toEqual({ grantId: stored.grants[0].grantId, shopId: "shop-1" });

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.tiktok).toMatchObject({ status: "connected", connected: true, shopName: "Test Shop", region: "US" });

    const client = await getAuthorizedTikTokClient();
    expect(client).not.toBeNull();
    await client!.request("/product/202309/products", { query: { page_size: "1" } });
    const authorizedCall = fetchMock.mock.calls[2];
    const authorizedUrl = new URL(String(authorizedCall[0]));
    expect(authorizedUrl.searchParams.get("shop_cipher")).toBe("test-shop-cipher");
    expect(new Headers(authorizedCall[1]?.headers).get("x-tts-access-token")).toBe("test-access-token");

    await request(app)
      .get(`/api/tiktok/callback?auth_code=replayed-code&state=${state}`)
      .set("Cookie", oauthCookie)
      .expect(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("starts authorization with app credentials saved from the skill store", async () => {
    vi.stubEnv("TIKTOK_SHOP_APP_KEY", "");
    vi.stubEnv("TIKTOK_SHOP_APP_SECRET", "");
    await writeFile(path.join(authTestDirectory, "skills.json"), JSON.stringify({
      "tiktok-shop": { installed: true, enabled: true, config: { appKey: "skill-app-key", appSecret: "skill-app-secret" } },
    }));

    const authorization = await request(app).get("/api/tiktok/authorize").expect(302);
    expect(new URL(authorization.headers.location).searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);

    const catalog = await request(app).get("/api/skills").expect(200);
    const tiktok = catalog.body.statuses.find((status: { id: string }) => status.id === "tiktok-shop");
    // App Key 非密码字段原样回显；App Secret 脱敏且全文不得出现原始值
    expect(tiktok.config.appKey).toBe("skill-app-key");
    expect(tiktok.config.appSecret).toMatch(/^sk\*+et$/);
    expect(JSON.stringify(catalog.body)).not.toContain("skill-app-secret");
  });
});

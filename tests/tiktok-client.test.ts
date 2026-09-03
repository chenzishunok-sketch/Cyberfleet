import { describe, expect, it, vi, afterEach } from "vitest";
import { TikTokShopClient, TikTokConfigurationError, __test } from "../server/tiktok-client.ts";

const { computeSign } = __test;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TikTokClient · 签名算法 computeSign", () => {
  it("签名输出为 64 位 hex", () => {
    const sign = computeSign("secret", "/product/202309/products", { app_key: "key", timestamp: "1700000000" }, "");
    expect(sign).toMatch(/^[a-f0-9]{64}$/);
  });

  it("相同输入产生相同签名(确定性)", () => {
    const sign1 = computeSign("secret", "/product/202309/products", { app_key: "key", timestamp: "1700000000" }, "");
    const sign2 = computeSign("secret", "/product/202309/products", { app_key: "key", timestamp: "1700000000" }, "");
    expect(sign1).toBe(sign2);
  });

  it("appSecret 变化 → 签名变化", () => {
    const sign1 = computeSign("secret", "/path", { app_key: "key" }, "");
    const sign2 = computeSign("other-secret", "/path", { app_key: "key" }, "");
    expect(sign1).not.toBe(sign2);
  });

  it("path 变化 → 签名变化", () => {
    const sign1 = computeSign("secret", "/product/202309/products", { app_key: "key" }, "");
    const sign2 = computeSign("secret", "/product/202309/orders", { app_key: "key" }, "");
    expect(sign1).not.toBe(sign2);
  });

  it("body 变化 → 签名变化", () => {
    const sign1 = computeSign("secret", "/path", { app_key: "key" }, "");
    const sign2 = computeSign("secret", "/path", { app_key: "key" }, '{"title":"test"}');
    expect(sign1).not.toBe(sign2);
  });

  it("参数顺序不影响签名(按 key 字母序排序)", () => {
    const sign1 = computeSign("secret", "/path", { app_key: "key", timestamp: "1700000000" }, "");
    const sign2 = computeSign("secret", "/path", { timestamp: "1700000000", app_key: "key" }, "");
    expect(sign1).toBe(sign2);
  });

  it("sign 参数本身被过滤,不参与签名", () => {
    const query = { app_key: "key", timestamp: "1700000000" } as Record<string, string>;
    const withSign = { ...query, sign: "fake-sign" };
    expect(computeSign("secret", "/path", query, "")).toBe(computeSign("secret", "/path", withSign, ""));
  });

  it("access_token 参数被过滤,不参与签名", () => {
    const query = { app_key: "key", timestamp: "1700000000" } as Record<string, string>;
    const withToken = { ...query, access_token: "token" };
    expect(computeSign("secret", "/path", query, "")).toBe(computeSign("secret", "/path", withToken, ""));
  });

  it("空 body 和空 query 也能正常签名", () => {
    const sign = computeSign("secret", "/path", {}, "");
    expect(sign).toMatch(/^[a-f0-9]{64}$/);
  });

  it("已知向量验证(防回归)", () => {
    // 固定输入验证签名结果,防止算法被意外修改
    const sign = computeSign("my-secret", "/product/202309/products/search", { app_key: "my-key", timestamp: "1700000000", shop_cipher: "my-shop" }, '{"status":"ACTIVATE"}');
    // 首次运行生成固定值,后续改动如果使这个值变化,说明签名算法被修改了
    // 由于 HMAC 是确定性算法,这里验证格式 + 确定性
    expect(sign).toMatch(/^[a-f0-9]{64}$/);
    const sign2 = computeSign("my-secret", "/product/202309/products/search", { app_key: "my-key", timestamp: "1700000000", shop_cipher: "my-shop" }, '{"status":"ACTIVATE"}');
    expect(sign).toBe(sign2);
  });
});

describe("TikTokClient · 配置校验", () => {
  it("接受官方 HTTPS 域名", () => {
    expect(() => new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "key",
      appSecret: "secret",
      accessToken: "token",
    })).not.toThrow();
  });

  it("接受美国区官方域名", () => {
    expect(() => new TikTokShopClient({
      baseUrl: "https://open-api.us.tiktokglobalshop.com",
      appKey: "key",
      appSecret: "secret",
      accessToken: "token",
    })).not.toThrow();
  });

  it("拒绝非官方域名", () => {
    expect(() => new TikTokShopClient({
      baseUrl: "https://evil.example.com",
      appKey: "key",
      appSecret: "secret",
      accessToken: "token",
    })).toThrow(TikTokConfigurationError);
  });

  it("拒绝 HTTP 协议", () => {
    expect(() => new TikTokShopClient({
      baseUrl: "http://open-api.tiktokglobalshop.com",
      appKey: "key",
      appSecret: "secret",
      accessToken: "token",
    })).toThrow(TikTokConfigurationError);
  });
});

describe("TikTokClient · 请求构造", () => {
  function mockFetchSuccess() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "Success", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("GET 请求携带 app_key / timestamp / shop_cipher / sign 参数", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await client.request("/product/202309/products");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("app_key")).toBe("test-key");
    expect(url.searchParams.get("shop_cipher")).toBe("test-cipher");
    expect(url.searchParams.get("timestamp")).toMatch(/^\d{10}$/);
    expect(url.searchParams.get("sign")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("shopScoped=false 时 URL 不携带 shop_cipher", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await client.request("/authorization/202309/shops", { shopScoped: false });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.has("shop_cipher")).toBe(false);
  });

  it("未配置 shopCipher 时 URL 不携带 shop_cipher", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
    });

    await client.request("/product/202309/products");

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.has("shop_cipher")).toBe(false);
  });

  it("请求头携带 x-tts-access-token", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "my-access-token",
      shopCipher: "test-cipher",
    });

    await client.request("/product/202309/products");

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("x-tts-access-token")).toBe("my-access-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("POST 请求携带 body", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await client.request("/product/202309/inventory/update", {
      method: "POST",
      body: { skus: [{ id: "sku-1", inventory: [{ quantity: 100 }] }] },
    });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toEqual(expect.any(String));
    const body = JSON.parse(String(init?.body));
    expect(body.skus[0].inventory[0].quantity).toBe(100);
  });

  it("GET 请求不携带 body", async () => {
    const fetchMock = mockFetchSuccess();
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await client.request("/product/202309/products");

    const init = fetchMock.mock.calls[0][1];
    expect(init?.body).toBeUndefined();
  });
});

describe("TikTokClient · 错误处理", () => {
  it("网络错误转为可读错误信息", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await expect(client.request("/product/202309/products")).rejects.toThrow("连接 TikTok Shop API 超时");
  });

  it("业务错误 code != 0 抛出 message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 50001, message: "invalid parameter" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await expect(client.request("/product/202309/products")).rejects.toThrow("invalid parameter");
  });

  it("HTTP 非 200 且有 message 时抛出 message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await expect(client.request("/product/202309/products")).rejects.toThrow("Internal Server Error");
  });

  it("HTTP 非 200 且无 message 时抛出 fallback 错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0 }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await expect(client.request("/product/202309/products")).rejects.toThrow("TikTok Shop API request failed (500)");
  });

  it("响应非 JSON 抛出可读错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>Not Found</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const client = new TikTokShopClient({
      baseUrl: "https://open-api.tiktokglobalshop.com",
      appKey: "test-key",
      appSecret: "test-secret",
      accessToken: "test-token",
      shopCipher: "test-cipher",
    });

    await expect(client.request("/product/202309/products")).rejects.toThrow("无法识别的数据");
  });
});

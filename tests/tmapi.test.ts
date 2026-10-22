import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTmapiCache, convertTmapiImageUrl, getTmapiItemDetailById, searchTmapiItemsByImage, TmapiError } from "../server/tmapi-client.ts";
import { inferTmapiItemIntent, runTmapiItemScene } from "../server/tmapi-scenes.ts";

const itemResponse = {
  code: 200,
  msg: "success",
  data: {
    item_id: 648795280915,
    title: "测试商品",
    currency: "CNY",
    price_info: { price_min: "12.50", price_max: "15.00" },
    sale_info: { sale_quantity_90days: 88 },
    stock: 120,
    is_sold_out: false,
    shop_info: { shop_name: "测试供应商" },
    skus: [{
      skuid: "sku-1",
      props_names: "颜色:黑色;尺码:M",
      sale_price: "12.50",
      stock: 20,
      package_info: { weight: 0.4, length: 20, width: 10, height: 5 },
    }],
  },
};

describe("TMAPI 1688 integration", () => {
  afterEach(() => {
    clearTmapiCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads the token only on the server and requests item detail", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "test-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(itemResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const item = await getTmapiItemDetailById("648795280915", { language: "th", scene: "drop_shipping" });

    expect(item.title).toBe("测试商品");
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.pathname).toBe("/1688/item_detail");
    expect(requestedUrl.searchParams.get("item_id")).toBe("648795280915");
    expect(requestedUrl.searchParams.get("language")).toBe("th");
    expect(requestedUrl.searchParams.get("scene")).toBe("drop_shipping");
    // TMAPI 鉴权走 apikey 请求头，token 不应出现在 query 里（放 query 会被 401 拒）
    expect(requestedUrl.searchParams.get("apiToken")).toBeNull();
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("apikey")).toBe("test-token");
  });

  it("turns a 1688 link into a readable SKU report", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "test-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(itemResponse), { status: 200 }));
    const intent = inferTmapiItemIntent("帮我分析这个日本一件代发商品 https://detail.1688.com/offer/648795280915.html");

    expect(intent).toEqual({ itemId: "648795280915", options: { language: "ja", scene: "drop_shipping" } });
    const result = await runTmapiItemScene(intent!);
    expect(result.content).toContain("采购价 12.50-15.00 CNY");
    expect(result.artifact.rows[0]).toMatchObject({ sku_id: "sku-1", weight_kg: "0.4", dimensions_cm: "20x10x5" });
  });

  it("does not hijack a direct Miaoshou publishing request", () => {
    expect(inferTmapiItemIntent("把 https://detail.1688.com/offer/648795280915.html 采集到妙手并发布到 TikTok")).toBeUndefined();
  });

  it("returns a clear message for an invalid token", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "bad-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ message: "No API key found in request" }), { status: 401 }));

    await expect(getTmapiItemDetailById("648795280915")).rejects.toMatchObject({
      message: "1688 货源 Token 无效或未配置。",
      statusCode: 401,
    } satisfies Partial<TmapiError>);
  });

  it("converts a public image and searches 1688 candidates", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "test-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, msg: "success", data: "/search/converted.jpg" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 200,
        msg: "success",
        data: {
          page: 1,
          total_count: 1,
          items: [{
            item_id: 865301188483,
            title: "同款收纳盒",
            img: "https://cbu01.alicdn.com/search.jpg",
            price: "1.25",
            moq: 1,
            sale_info: { sale_quantity_int: 32500, orders_count: 585 },
            shop_info: { company_name: "测试工厂", is_factory: true, shop_years: 3 },
          }],
        },
      }), { status: 200 }));

    const converted = await convertTmapiImageUrl("https://images.example.com/query.jpg");
    const result = await searchTmapiItemsByImage(converted, { pageSize: 6, supportDropshipping: true, factoryOnly: true });

    expect(converted).toBe("/search/converted.jpg");
    expect(result.total_count).toBe(1);
    expect(result.items[0]).toMatchObject({ title: "同款收纳盒", moq: 1 });
    const convertUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(convertUrl.pathname).toBe("/1688/tools/image/convert_url");
    const searchUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(searchUrl.pathname).toBe("/1688/search/image");
    expect(searchUrl.searchParams.get("support_dropshipping")).toBe("true");
    expect(searchUrl.searchParams.get("is_factory")).toBe("true");
  });

  it("distinguishes an inaccessible image from invalid request parameters", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "test-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: 422,
      msg: "Invalid image url, access failed",
    }), { status: 422 }));

    await expect(convertTmapiImageUrl("https://images.example.com/missing.jpg")).rejects.toMatchObject({
      message: "1688 货源无法访问临时图片链接，已返回图片读取失败。",
      statusCode: 422,
    } satisfies Partial<TmapiError>);
  });
});

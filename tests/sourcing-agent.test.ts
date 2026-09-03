import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatImageAttachment } from "../shared/contracts.ts";
import { inferSourcingIntent, runSourcingSearch } from "../server/sourcing-agent.ts";
import { clearTmapiCache } from "../server/tmapi-client.ts";

const image: ChatImageAttachment = {
  id: "image-1",
  name: "product.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};

describe("货源选品 Agent", () => {
  afterEach(() => {
    clearTmapiCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("识别上传图片、售价和选品筛选条件", () => {
    const intent = inferSourcingIntent({
      message: "帮我找1688同款，只看工厂，采购价不超过5元，售价199THB，目标利润率25%",
      attachments: [image],
    });

    expect(intent).toMatchObject({
      image,
      requestedSalePriceThb: 199,
      targetMargin: 0.25,
      maxPurchasePriceCny: 5,
      factoryOnly: true,
      supportDropshipping: true,
    });
  });

  it("完成图片上传、TMAPI搜索、商品补全和利润估算", async () => {
    vi.stubEnv("TMAPI_API_TOKEN", "test-token");
    vi.stubEnv("TMAPI_BASE_URL", "http://api.tmapi.test");
    vi.stubEnv("SOURCING_IMAGE_UPLOAD_URL", "https://upload.example.test/image");
    let convertAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (url.hostname === "upload.example.test") {
        return json({ success: true, files: [{ url: "https://images.example.test/product.png" }] });
      }
      if (url.hostname === "paste.c-net.org") {
        return new Response("https://paste.c-net.org/WorkingImage", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/1688/tools/image/convert_url") {
        convertAttempts += 1;
        if (convertAttempts === 1) {
          return new Response(JSON.stringify({ code: 422, msg: "Invalid image url, access failed" }), { status: 422 });
        }
        return json({ code: 200, msg: "success", data: "/search/product.png" });
      }
      if (url.pathname === "/1688/search/image") {
        return json({
          code: 200,
          msg: "success",
          data: {
            total_count: 88,
            items: [{
              item_id: 865301188483,
              product_url: "https://detail.1688.com/offer/865301188483.html",
              title: "收纳盒同款",
              img: "https://cbu01.alicdn.com/candidate.jpg",
              price: "2.50",
              moq: 1,
              item_repurchase_rate: "40%",
              sale_info: { sale_quantity_int: 12000, orders_count: 320 },
              shop_info: {
                company_name: "义乌测试工厂",
                is_factory: true,
                location: ["浙江", "金华"],
                shop_years: 5,
                score_info: { composite_new_score: "4.7" },
              },
              tags: ["7天无理由"],
            }],
          },
        });
      }
      if (url.pathname === "/1688/item_detail") {
        return json({
          code: 200,
          msg: "success",
          data: {
            item_id: 865301188483,
            title: "收纳盒同款详情",
            stock: 5000,
            delivery_info: { delivery_fee: 3, unit_weight: 0.4 },
            skus: [{ skuid: "sku-1", sale_price: "2.50", stock: 5000, package_info: { weight: 0.4 } }],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const intent = inferSourcingIntent({ message: "帮我找这张图的1688同款", attachments: [image] });
    const result = await runSourcingSearch(intent!);

    expect(result.artifact).toMatchObject({
      kind: "sourcing_candidates",
      // 优先使用用户上传的原始 dataUrl，不依赖外部临时图床（可能不可访问）
      queryImageUrl: image.dataUrl,
      totalCount: 88,
      candidates: [{
        itemId: "865301188483",
        supplierName: "义乌测试工厂",
        supplierType: "生产工厂",
        purchasePriceCny: 2.5,
        weightKg: 0.4,
        weightEstimated: false,
        domesticShippingCny: 3,
      }],
    });
    const candidate = result.artifact!.candidates[0];
    expect(candidate.salePriceThb).toBe(candidate.suggestedSalePriceThb);
    expect(candidate.expectedMargin).toBeGreaterThanOrEqual(0.19);
    expect(candidate.expectedProfitThb).toBeGreaterThan(0);
    expect(candidate.warnings).toEqual([]);
    expect(convertAttempts).toBe(2);
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).hostname === "paste.c-net.org")).toBe(true);
  });
});

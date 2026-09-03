import { describe, expect, it } from "vitest";
import { extract1688WorkflowInput, extractPricingUpdate, extractProductEditInput, parseFlashSaleIntent } from "../server/workflow-intents.ts";

describe("Workflow natural-language intents", () => {
  it("extracts supplier publish price, shop and package dimensions", () => {
    expect(extract1688WorkflowInput("把 https://detail.1688.com/offer/594316268188.html 上架到 TikTok，店铺ID 16047893，发布价 999 THB，尺寸 42x20x3")).toMatchObject({
      sourceUrl: "https://detail.1688.com/offer/594316268188.html",
      shopId: "16047893",
      publishPrice: 999,
      currency: "THB",
      packageDimensions: { length: 42, width: 20, height: 3 },
    });
  });

  it("extracts natural shop, labeled dimensions, title and description", () => {
    expect(extract1688WorkflowInput("执行上架：把 https://detail.1688.com/offer/1033835549328.html 发布到 TikTok 店铺 16047893，售价 299 THB，折叠包裹尺寸为长 30 cm、宽 25 cm、高 5 cm。商品标题使用：泰文测试标题。商品描述使用：泰文测试描述。"))
      .toMatchObject({
        sourceUrl: "https://detail.1688.com/offer/1033835549328.html",
        shopId: "16047893",
        publishPrice: 299,
        currency: "THB",
        packageDimensions: { length: 30, width: 25, height: 5 },
        title: "泰文测试标题",
        description: "泰文测试描述",
      });
  });

  it("extracts missing product input without requiring the source URL again", () => {
    expect(extractProductEditInput("给任务补充售价 99 THB，包裹尺寸 32×22×14，商品标题：泰文标题。商品描述：泰文描述。"))
      .toEqual({
        publishPrice: 99,
        packageDimensions: { length: 32, width: 22, height: 14 },
        title: "泰文标题",
        description: "泰文描述",
      });
  });

  it("extracts editable pricing defaults from natural language", () => {
    expect(extractPricingUpdate("刚才任务当地配送 79，国内物流 3，云仓 2，广告费 10，达人佣金 15%，全部 SKU 售价 139"))
      .toEqual({
        defaults: { domesticLogisticsCny: 3, cloudWarehouseCny: 2, buyerLocalDeliveryThb: 79, advertisingThb: 10, creatorCommissionRate: 0.15 },
        skuValues: { salePriceThb: 139 },
      });
  });

  it("extracts tax and platform commission percentages", () => {
    expect(extractPricingUpdate("全部商品税率改成 24.12%，平台佣金 10.7%"))
      .toEqual({
        defaults: {},
        skuValues: { taxRate: 0.2412, categoryCommissionRate: 0.107 },
      });
  });

  it("turns a complete Chinese flash-sale request into exact workflow input", () => {
    const parsed = parseFlashSaleIntent("给商品ID 1736564041031648641 创建秒杀，2026-08-01 10:00 到 2026-08-01 18:00，秒杀价 299 THB，活动库存 50，每人限购 2，活动名称：八月秒杀");
    expect(parsed?.missing).toEqual([]);
    expect(parsed?.input).toMatchObject({
      productId: "1736564041031648641",
      priceAmount: "299",
      currency: "THB",
      skuQuantityLimit: 50,
      quantityPerUser: 2,
      activityTitle: "八月秒杀",
    });
  });

  it("lists missing high-impact flash-sale fields instead of guessing", () => {
    const parsed = parseFlashSaleIntent("给商品 1736564041031648641 创建秒杀");
    expect(parsed?.input).toBeUndefined();
    expect(parsed?.missing).toContain("秒杀价");
    expect(parsed?.missing).toContain("每人限购（1-99 或 -1）");
  });
});

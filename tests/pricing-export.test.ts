import { describe, expect, it } from "vitest";
import { pricingCsv } from "../server/pricing-export.ts";
import { calculateActualSettlement, calculateSkuPricing } from "../server/pricing-engine.ts";
import type { SkuPricingRecord } from "../shared/contracts.ts";

describe("pricing export", () => {
  it("includes estimated inputs and actual settlement for every SKU", () => {
    const input = { salePriceThb: 120, purchasePriceCny: 3, weightKg: 0.4, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const actualInput = { period: "2026-07", soldQuantity: 2, tiktokSettlementThb: 150, logisticsDeductionThb: 20 };
    const record: SkuPricingRecord = { id: "r1", workflowId: "w1", sourceItemId: "1688-1", platformDetailId: "m1", tiktokProductId: "t1", tiktokSkuId: "ts1", skuKey: "sku-1", skuName: "白色", currency: "THB", activityPriceThb: 99, input, result: calculateSkuPricing(input), actualInput, actualResult: calculateActualSettlement(input, actualInput), fieldSources: {}, missingFields: [], calculatedAt: "2026-07-29T00:00:00.000Z" };
    const csv = pricingCsv([record]);
    expect(csv).toContain("TikTok实际结算THB");
    expect(csv).toContain("实际利润THB");
    expect(csv).toContain("活动价THB");
    expect(csv).toContain("预估利润CNY");
    expect(csv).toContain('"t1","ts1"');
    expect(csv).toContain('"2026-07","2","150","20"');
  });
});

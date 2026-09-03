import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkuPricingRecord } from "../shared/contracts.ts";
import { calculateActualSettlement, calculateSkuPricing } from "../server/pricing-engine.ts";
import { PricingStore } from "../server/pricing-store.ts";

describe("SKU pricing history", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-pricing-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("keeps the latest SKU record and append-only pricing snapshots", () => {
    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    const input = { salePriceThb: 120, purchasePriceCny: 3, weightKg: 0.4, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const record: SkuPricingRecord = { id: "r1", workflowId: "w1", sourceItemId: "648795280915", skuKey: ";白色;大号;", skuName: "白色 / 大号", currency: "THB", input, result: calculateSkuPricing(input), fieldSources: { purchasePriceCny: "1688" }, missingFields: [], calculatedAt: "2026-07-29T00:00:00.000Z" };
    store.upsert([record]);
    const next = { ...record, input: { ...input, salePriceThb: 139 }, result: calculateSkuPricing({ ...input, salePriceThb: 139 }), calculatedAt: "2026-07-29T01:00:00.000Z" };
    store.upsert([next]);
    expect(store.listByWorkflow("w1")).toHaveLength(1);
    expect(store.listByWorkflow("w1")[0].input.salePriceThb).toBe(139);
    expect(store.history("w1")).toHaveLength(2);
    const settled = store.update("r1", (current) => {
      const actualInput = { soldQuantity: 2, tiktokSettlementThb: 150, logisticsDeductionThb: 20 };
      return { ...current, actualInput, actualResult: calculateActualSettlement(current.input, actualInput), calculatedAt: "2026-07-29T02:00:00.000Z" };
    });
    expect(settled?.actualResult?.actualProfitThb).toBe(62.1);
    expect(store.history("w1")).toHaveLength(3);
  });
});

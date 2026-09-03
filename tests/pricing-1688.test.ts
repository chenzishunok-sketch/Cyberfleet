import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkuPricingRecord } from "../shared/contracts.ts";
import type { TmapiItemDetail } from "../server/tmapi-client.ts";
import { applySupplierPricing, buildSupplierPricingPreview } from "../server/pricing-1688.ts";
import { calculateSkuPricing } from "../server/pricing-engine.ts";
import { PricingStore } from "../server/pricing-store.ts";

const input = {
  salePriceThb: 99, purchasePriceCny: 0, weightKg: 0.4, exchangeRateCnyToThb: 4.8503,
  domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0,
  creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1,
  transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0,
  platformSubsidyThb: 0, platformActivityFeeThb: 0,
};

function record(id: string, skuId: string, skuName: string): SkuPricingRecord {
  return {
    id, workflowId: "workflow-1", sourceItemId: "1688-old", tiktokProductId: "product-1", tiktokSkuId: skuId,
    skuKey: skuId, skuName, currency: "THB", input, result: calculateSkuPricing(input), fieldSources: {},
    missingFields: ["purchasePriceCny"], calculatedAt: "2026-08-02T00:00:00.000Z",
  };
}

function detail(skus: Array<Record<string, unknown>>): TmapiItemDetail {
  return { item_id: "648795280915", title: "供应商商品", price_info: { price_min: 5 }, skus } as TmapiItemDetail;
}

describe("1688 SKU pricing recognition", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-1688-pricing-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("matches exact SKU ids with high confidence", () => {
    const preview = buildSupplierPricingPreview(
      [record("r-red", "source-red", "红色"), record("r-blue", "source-blue", "蓝色")],
      detail([
        { skuid: "source-red", props_names: "红色", sale_price: "3.20" },
        { skuid: "source-blue", props_names: "蓝色", sale_price: "4.10" },
      ]),
      "https://detail.1688.com/offer/648795280915.html",
    );
    expect(preview).toMatchObject({ matchedCount: 2, requiresConfirmation: false });
    expect(preview.matches.map((match) => [match.sourceSkuId, match.purchasePriceCny, match.method])).toEqual([
      ["source-blue", 4.1, "exact"], ["source-red", 3.2, "exact"],
    ]);
  });

  it("uses one shared supplier price for all unmatched SKUs", () => {
    const preview = buildSupplierPricingPreview(
      [record("r-1", "target-1", "红色"), record("r-2", "target-2", "蓝色")],
      detail([
        { skuid: "source-1", props_names: "大号", sale_price: "6.80" },
        { skuid: "source-2", props_names: "小号", sale_price: "6.80" },
      ]),
      "https://detail.1688.com/offer/648795280915.html",
    );
    expect(preview.matches.every((match) => match.method === "shared_price")).toBe(true);
    expect(preview.matches.every((match) => match.confidence === "high" && match.purchasePriceCny === 6.8)).toBe(true);
  });

  it("marks sequence fallback for confirmation and writes the source to each SKU", () => {
    const records = [record("r-1", "target-1", "红色"), record("r-2", "target-2", "蓝色")];
    const sourceUrl = "https://detail.1688.com/offer/648795280915.html";
    const preview = buildSupplierPricingPreview(records, detail([
      { skuid: "source-1", props_names: "大号", sale_price: "2.50" },
      { skuid: "source-2", props_names: "小号", sale_price: "3.50" },
    ]), sourceUrl);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.matches.every((match) => match.method === "sequence")).toBe(true);

    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    store.upsert(records);
    const result = applySupplierPricing(store, preview, records);
    expect(result).toMatchObject({ updated: 2, linked: 2 });
    expect(store.get("r-1")).toMatchObject({ sourceItemId: "648795280915", sourceUrl, input: { purchasePriceCny: 2.5 }, fieldSources: { purchasePriceCny: "1688" }, missingFields: [] });
    expect(store.get("r-2")?.input.purchasePriceCny).toBe(3.5);
  });

  it("keeps the supplier link even when no SKU price can be matched", () => {
    const records = [record("r-1", "target-1", "红色")];
    const sourceUrl = "https://detail.1688.com/offer/648795280915.html";
    const preview = buildSupplierPricingPreview(records, detail([
      { skuid: "source-1", props_names: "供应商规格一", sale_price: "2.50" },
      { skuid: "source-2", props_names: "供应商规格二", sale_price: "3.50" },
    ]), sourceUrl);
    expect(preview.matchedCount).toBe(0);

    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    store.upsert(records);
    const result = applySupplierPricing(store, preview, records);
    expect(result).toMatchObject({ updated: 0, linked: 1 });
    expect(store.get("r-1")).toMatchObject({ sourceItemId: "648795280915", sourceUrl, input: { purchasePriceCny: 0 }, missingFields: ["purchasePriceCny"] });
  });
});

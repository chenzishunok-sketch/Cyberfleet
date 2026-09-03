import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateSkuPricing, calculateSkuPricingWithActivity } from "../server/pricing-engine.ts";
import { applyProductPricing, syncCatalogRows } from "../server/pricing-sync.ts";
import { PricingStore } from "../server/pricing-store.ts";
import type { SkuPricingRecord } from "../shared/contracts.ts";

describe("TikTok catalog pricing sync", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-sync-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("creates missing SKU records without overwriting manual prices", () => {
    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    const input = { salePriceThb: 139, purchasePriceCny: 3, weightKg: 0.4, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const manualInput = { ...input, taxRate: 0.2, categoryCommissionRate: 0.25 };
    const existing: SkuPricingRecord = { id: "r1", workflowId: "w1", tiktokProductId: "p1", tiktokSkuId: "s1", skuKey: "s1", skuName: "白色", currency: "THB", input: manualInput, result: calculateSkuPricing(manualInput), fieldSources: { salePriceThb: "manual", taxRate: "manual", categoryCommissionRate: "manual" }, missingFields: [], calculatedAt: "2026-07-29T00:00:00.000Z" };
    const inactive: SkuPricingRecord = { ...existing, id: "old", workflowId: "old-workflow", shopId: "shop-1", tiktokProductId: "old-product", tiktokSkuId: "old-sku", skuKey: "old-sku", skuName: "历史 SKU" };
    const draft: SkuPricingRecord = { id: "draft-1", workflowId: "draft-workflow", sourceItemId: "1688-1", skuKey: "draft", skuName: "上架草稿", currency: "THB", input, result: calculateSkuPricing(input), fieldSources: {}, missingFields: ["purchasePriceCny", "weightKg"], calculatedAt: "2026-07-29T00:00:00.000Z" };
    store.upsert([existing, inactive, draft]);
    const rows = [
      { productId: "p1", productTitle: "商品一", productStatus: "ACTIVATE", productImageUrl: "https://example.test/p1.jpg", categoryId: "852744", categoryName: "กระเป๋าเก็บของ", categoryPath: "บ้าน > กระเป๋าเก็บของ", skuId: "s1", skuName: "สีน้ำเงิน / 240 ลิตร", sellerSku: "SELLER-1", price: 999, activityPrice: 64.68, currency: "THB", stock: 8, committedStock: 1, units: 0, revenue: 0 },
      { productId: "p2", productTitle: "商品二", productStatus: "ACTIVATE", categoryId: "600686", categoryName: "ตะกร้าเก็บของ", categoryPath: "บ้าน > ตะกร้าเก็บของ", skuId: "s2", skuName: "สีเหลือง / 180 ลิตร", sellerSku: "SELLER-2", price: 199, currency: "THB", stock: 5, committedStock: 0, units: 0, revenue: 0 },
    ];
    const result = syncCatalogRows(store, rows, "shop-1");
    expect(result).toMatchObject({ totalSkus: 2, created: 1, updated: 2, unchanged: 0, missingCost: 1, inactiveProducts: 1, inactiveSkus: 1, matchedCategoryProducts: 2, unmatchedCategoryProducts: 0 });
    expect(store.get("r1")).toMatchObject({
      tiktokStatus: "ACTIVATE",
      productImageUrl: "https://example.test/p1.jpg",
      availableStock: 8,
      committedStock: 1,
      activityPriceThb: 64.68,
      skuName: "สีน้ำเงิน / 240 ลิตร",
      categoryId: "852744",
      categoryName: "Storage Bags",
      input: { salePriceThb: 139, taxRate: 0.2, categoryCommissionRate: 0.25 },
      fieldSources: { salePriceThb: "manual", taxRate: "manual", categoryCommissionRate: "manual" },
    });
    expect(store.get("r1")?.result).toEqual(calculateSkuPricingWithActivity(manualInput, 64.68));
    expect(store.get("tiktok:s2")).toMatchObject({
      tiktokStatus: "ACTIVATE",
      productTitle: "商品二",
      categoryId: "600686",
      categoryName: "Storage Baskets",
      input: { taxRate: 0.1556, categoryCommissionRate: 0.107 },
      fieldSources: { taxRate: "category_rule", categoryCommissionRate: "category_rule" },
      missingFields: ["purchasePriceCny", "weightKg"],
    });
    expect(store.get("old")?.tiktokStatus).toBe("INACTIVE");
    expect(store.get("draft-1")?.tiktokStatus).toBeUndefined();
    expect(syncCatalogRows(store, rows, "shop-1")).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
  });

  it("fills leaf category rules into existing TikTok SKU records", () => {
    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    const input = { salePriceThb: 199, purchasePriceCny: 0, weightKg: 0.001, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const existing: SkuPricingRecord = { id: "r1", workflowId: "w1", tiktokProductId: "p1", tiktokSkuId: "s1", skuKey: "s1", skuName: "s1", currency: "THB", input, result: calculateSkuPricing(input), fieldSources: { salePriceThb: "tiktok", taxRate: "default", categoryCommissionRate: "default" }, missingFields: ["purchasePriceCny", "weightKg", "taxRate", "categoryCommissionRate"], calculatedAt: "2026-07-29T00:00:00.000Z" };
    store.upsert([existing]);

    const result = syncCatalogRows(store, [{ productId: "p1", productTitle: "商品一", productStatus: "ACTIVATE", categoryId: "852744", categoryName: "กระเป๋าเก็บของ", categoryPath: "บ้าน > กระเป๋าเก็บของ", skuId: "s1", skuName: "สีน้ำเงิน / 240 ลิตร", sellerSku: "SELLER-1", price: 199, currency: "THB", stock: 8, committedStock: 0, units: 0, revenue: 0 }], "shop-1");

    expect(result).toMatchObject({ updated: 1, matchedCategoryProducts: 1, unmatchedCategoryProducts: 0 });
    expect(store.get("r1")).toMatchObject({
      categoryId: "852744",
      categoryName: "Storage Bags",
      input: { taxRate: 0.2412, categoryCommissionRate: 0.107 },
      fieldSources: { taxRate: "category_rule", categoryCommissionRate: "category_rule" },
      missingFields: ["purchasePriceCny", "weightKg"],
    });
  });

  it("applies shared costs to one product while keeping per-SKU overrides available", () => {
    const store = new PricingStore(path.join(directory, "pricing.sqlite"));
    const input = { salePriceThb: 199, purchasePriceCny: 0, weightKg: 0.001, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const makeRecord = (id: string, productId: string, skuId: string): SkuPricingRecord => ({
      id, workflowId: `workflow-${productId}`, tiktokProductId: productId, tiktokSkuId: skuId,
      skuKey: skuId, skuName: skuId, currency: "THB", input: { ...input }, result: calculateSkuPricing(input),
      fieldSources: { purchasePriceCny: "default", weightKg: "default" },
      missingFields: ["purchasePriceCny", "weightKg", "taxRate", "categoryCommissionRate"],
      calculatedAt: "2026-07-29T00:00:00.000Z",
    });
    store.upsert([makeRecord("r1", "p1", "s1"), makeRecord("r2", "p1", "s2"), makeRecord("r3", "p2", "s3")]);

    const result = applyProductPricing(store, "p1", {
      purchasePriceCny: 5,
      weightKg: 0.3,
      advertisingThb: 12,
      creatorCommissionRate: 0.1,
    });

    expect(result.updated).toBe(2);
    expect(store.get("r1")).toMatchObject({
      input: { purchasePriceCny: 5, weightKg: 0.3, advertisingThb: 12, creatorCommissionRate: 0.1 },
      fieldSources: { purchasePriceCny: "manual", weightKg: "manual", advertisingThb: "manual", creatorCommissionRate: "manual" },
      missingFields: ["taxRate", "categoryCommissionRate"],
    });
    expect(store.get("r2")?.input.purchasePriceCny).toBe(5);
    expect(store.get("r3")?.input.purchasePriceCny).toBe(0);

    store.update("r1", (record) => ({ ...record, input: { ...record.input, purchasePriceCny: 7 } }));
    expect(store.get("r1")?.input.purchasePriceCny).toBe(7);
    expect(store.get("r2")?.input.purchasePriceCny).toBe(5);
  });
});

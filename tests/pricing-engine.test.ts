import { describe, expect, it } from "vitest";
import { calculateActualSettlement, calculateSkuPricing, calculateSkuPricingWithActivity } from "../server/pricing-engine.ts";
import { findThailandCommissionRule, findThailandTaxRule } from "../server/pricing-rules.ts";

const baseInput = {
  salePriceThb: 99,
  purchasePriceCny: 3,
  weightKg: 0.4,
  exchangeRateCnyToThb: 4.8503,
  domesticLogisticsCny: 2.5,
  cloudWarehouseCny: 1.5,
  buyerLocalDeliveryThb: 79,
  advertisingThb: 0,
  creatorCommissionRate: 0,
  taxRate: 0.1556,
  categoryCommissionRate: 0.107,
  crossBorderThbPer10g: 1,
  transactionRate: 0.0321,
  infrastructureFeeThb: 1.07,
  growthSupportRate: 0.0803,
  merchantDiscountThb: 0,
  platformSubsidyThb: 0,
  platformActivityFeeThb: 0,
};

describe("Thailand SKU pricing", () => {
  it("calculates all cost layers and flags a loss-making SKU", () => {
    const result = calculateSkuPricing(baseInput);
    expect(result).toMatchObject({
      purchaseCostThb: 14.55,
      domesticLogisticsThb: 12.13,
      cloudWarehouseThb: 7.28,
      crossBorderLogisticsThb: 40,
      expectedRevenueThb: 178,
      expectedCostThb: 189.11,
      expectedProfitThb: -11.11,
      profitable: false,
    });
    expect(result.breakEvenPriceThb).toBeGreaterThan(99);
    expect(calculateSkuPricing({ ...baseInput, salePriceThb: result.breakEvenPriceThb }).expectedProfitThb).toBeCloseTo(0, 1);
  });

  it("uses the active promotion price for estimated profit", () => {
    const regular = calculateSkuPricing({ ...baseInput, salePriceThb: 199 });
    const promoted = calculateSkuPricingWithActivity({ ...baseInput, salePriceThb: 199 }, 99);
    expect(promoted).toEqual(calculateSkuPricing(baseInput));
    expect(promoted.expectedProfitThb).toBeLessThan(regular.expectedProfitThb);
  });

  it("uses TikTok leaf category rules from the supplied workbook", () => {
    const tax = findThailandTaxRule("600686");
    expect(tax).toMatchObject({ categoryName: "Storage Baskets", compositeRate: 0.1556 });
    expect(findThailandCommissionRule(tax?.categoryName, tax?.path)).toMatchObject({ rate: 0.107 });
    expect(findThailandTaxRule("852744")).toMatchObject({ categoryName: "Storage Bags", compositeRate: 0.2412 });
  });

  it("calculates actual SKU profit only after settlement quantity and logistics are present", () => {
    expect(calculateActualSettlement(baseInput, { soldQuantity: 2, tiktokSettlementThb: 150 })).toBeUndefined();
    expect(calculateActualSettlement(baseInput, {
      soldQuantity: 2,
      tiktokSettlementThb: 150,
      logisticsDeductionThb: 20,
      advertisingThb: 5,
      creatorCommissionThb: 3,
    })).toMatchObject({
      baseCostThb: 67.9,
      actualCostThb: 95.9,
      actualProfitThb: 54.1,
      actualMargin: 0.3606,
      profitable: true,
    });
  });
});

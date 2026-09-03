import type {
  PricingRecordSummary,
  SkuActualSettlementInput,
  SkuActualSettlementResult,
  SkuPricingInput,
  SkuPricingRecord,
  SkuPricingResult,
} from "../shared/contracts.ts";

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function finiteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 不能小于 0。`);
}

export function calculateSkuPricing(input: SkuPricingInput): SkuPricingResult {
  for (const [field, value] of Object.entries(input)) finiteNonNegative(value, field);
  if (input.salePriceThb <= 0) throw new Error("SKU 售价必须大于 0。");
  if (input.weightKg <= 0) throw new Error("SKU 重量必须大于 0。");
  if (input.exchangeRateCnyToThb <= 0) throw new Error("人民币兑泰铢汇率必须大于 0。");

  const purchaseCostThb = input.purchasePriceCny * input.exchangeRateCnyToThb;
  const domesticLogisticsThb = input.domesticLogisticsCny * input.exchangeRateCnyToThb;
  const cloudWarehouseThb = input.cloudWarehouseCny * input.exchangeRateCnyToThb;
  const crossBorderLogisticsThb = (input.weightKg * 1000 / 10) * input.crossBorderThbPer10g;
  const itemRevenue = input.salePriceThb - input.merchantDiscountThb + input.platformSubsidyThb;
  const expectedRevenueThb = itemRevenue + input.buyerLocalDeliveryThb;
  const preTaxItemRevenue = itemRevenue / (1 + input.taxRate);
  const categoryCommissionThb = preTaxItemRevenue * input.categoryCommissionRate;
  const transactionFeeThb = expectedRevenueThb * input.transactionRate;
  const growthSupportFeeThb = preTaxItemRevenue * input.growthSupportRate;
  const taxThb = preTaxItemRevenue * input.taxRate;
  const creatorCommissionThb = preTaxItemRevenue * input.creatorCommissionRate;

  const expectedCostThb = purchaseCostThb
    + domesticLogisticsThb
    + cloudWarehouseThb
    + crossBorderLogisticsThb
    + input.buyerLocalDeliveryThb
    + categoryCommissionThb
    + transactionFeeThb
    + input.infrastructureFeeThb
    + growthSupportFeeThb
    + taxThb
    + input.advertisingThb
    + creatorCommissionThb
    + input.platformActivityFeeThb;
  const expectedProfitThb = expectedRevenueThb - expectedCostThb;
  const expectedMargin = expectedRevenueThb > 0 ? expectedProfitThb / expectedRevenueThb : 0;

  const itemProportionalRate = (input.categoryCommissionRate + input.growthSupportRate + input.taxRate + input.creatorCommissionRate) / (1 + input.taxRate);
  const saleContributionRate = 1 - input.transactionRate - itemProportionalRate;
  const fixedCosts = purchaseCostThb
    + domesticLogisticsThb
    + cloudWarehouseThb
    + crossBorderLogisticsThb
    + input.buyerLocalDeliveryThb
    + input.infrastructureFeeThb
    + input.advertisingThb
    + input.platformActivityFeeThb;
  const itemRevenueAdjustment = -input.merchantDiscountThb + input.platformSubsidyThb;
  const localDeliveryContribution = input.buyerLocalDeliveryThb * (1 - input.transactionRate);
  const breakEvenPriceThb = saleContributionRate > 0
    ? Math.max(0, (fixedCosts - itemRevenueAdjustment * saleContributionRate - localDeliveryContribution) / saleContributionRate)
    : Number.POSITIVE_INFINITY;

  return {
    purchaseCostThb: round(purchaseCostThb),
    domesticLogisticsThb: round(domesticLogisticsThb),
    cloudWarehouseThb: round(cloudWarehouseThb),
    crossBorderLogisticsThb: round(crossBorderLogisticsThb),
    localDeliveryThb: round(input.buyerLocalDeliveryThb),
    categoryCommissionThb: round(categoryCommissionThb),
    transactionFeeThb: round(transactionFeeThb),
    infrastructureFeeThb: round(input.infrastructureFeeThb),
    growthSupportFeeThb: round(growthSupportFeeThb),
    taxThb: round(taxThb),
    advertisingThb: round(input.advertisingThb),
    creatorCommissionThb: round(creatorCommissionThb),
    platformActivityFeeThb: round(input.platformActivityFeeThb),
    expectedRevenueThb: round(expectedRevenueThb),
    expectedCostThb: round(expectedCostThb),
    expectedProfitThb: round(expectedProfitThb),
    expectedMargin: round(expectedMargin, 4),
    breakEvenPriceThb: round(breakEvenPriceThb),
    profitable: expectedProfitThb >= 0,
  };
}

export function calculateSkuPricingWithActivity(
  input: SkuPricingInput,
  activityPriceThb?: number,
): SkuPricingResult {
  const effectivePrice = activityPriceThb !== undefined && Number.isFinite(activityPriceThb) && activityPriceThb > 0
    ? activityPriceThb
    : input.salePriceThb;
  return calculateSkuPricing(effectivePrice === input.salePriceThb ? input : { ...input, salePriceThb: effectivePrice });
}

export function calculateActualSettlement(
  pricing: SkuPricingInput,
  actual: SkuActualSettlementInput,
): SkuActualSettlementResult | undefined {
  for (const [field, value] of Object.entries(actual)) {
    if (field === "period" || value === undefined) continue;
    finiteNonNegative(Number(value), field);
  }
  if (!actual.soldQuantity || actual.tiktokSettlementThb === undefined || actual.logisticsDeductionThb === undefined) {
    return undefined;
  }
  const unitBaseCostThb = (pricing.purchasePriceCny + pricing.domesticLogisticsCny + pricing.cloudWarehouseCny)
    * pricing.exchangeRateCnyToThb;
  const baseCostThb = unitBaseCostThb * actual.soldQuantity;
  const actualCostThb = baseCostThb
    + actual.logisticsDeductionThb
    + (actual.advertisingThb ?? 0)
    + (actual.creatorCommissionThb ?? 0);
  const actualProfitThb = actual.tiktokSettlementThb - actualCostThb;
  return {
    baseCostThb: round(baseCostThb),
    actualCostThb: round(actualCostThb),
    actualProfitThb: round(actualProfitThb),
    actualMargin: round(actual.tiktokSettlementThb > 0 ? actualProfitThb / actual.tiktokSettlementThb : 0, 4),
    profitable: actualProfitThb >= 0,
  };
}

export function summarizePricing(records: SkuPricingRecord[]): PricingRecordSummary {
  const profits = records.map((record) => record.result.expectedProfitThb);
  const margins = records.map((record) => record.result.expectedMargin);
  return {
    totalSkus: records.length,
    profitableSkus: records.filter((record) => record.result.profitable).length,
    lossSkus: records.filter((record) => !record.result.profitable).length,
    minProfitThb: profits.length ? Math.min(...profits) : 0,
    maxProfitThb: profits.length ? Math.max(...profits) : 0,
    minMargin: margins.length ? Math.min(...margins) : 0,
  };
}

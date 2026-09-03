import type { SkuPricingInput, SkuPricingRecord } from "../shared/contracts.ts";
import { calculateActualSettlement, calculateSkuPricingWithActivity } from "./pricing-engine.ts";
import {
  findThailandCommissionRule,
  findThailandTaxRule,
  THAILAND_PRELIMINARY_RATES,
  THAILAND_PRICING_DEFAULTS,
} from "./pricing-rules.ts";
import { pricingDefaults } from "./pricing-source.ts";
import { PricingStore, pricingStore } from "./pricing-store.ts";
import { getTikTokOperationalData, type TikTokSkuRow } from "./tiktok-data.ts";

export interface PricingSyncResult {
  records: SkuPricingRecord[];
  totalProducts: number;
  totalSkus: number;
  created: number;
  updated: number;
  unchanged: number;
  missingCost: number;
  inactiveProducts: number;
  inactiveSkus: number;
  matchedCategoryProducts: number;
  unmatchedCategoryProducts: number;
}

export type ProductPricingValues = Partial<Pick<SkuPricingInput,
  | "purchasePriceCny" | "weightKg" | "exchangeRateCnyToThb" | "domesticLogisticsCny"
  | "cloudWarehouseCny" | "buyerLocalDeliveryThb" | "advertisingThb" | "creatorCommissionRate"
  | "taxRate" | "categoryCommissionRate"
>>;

export function applyProductPricing(
  store: PricingStore,
  productId: string,
  values: ProductPricingValues,
): { records: SkuPricingRecord[]; updated: number } {
  const records = store.list();
  const targets = records.filter((record) => record.tiktokProductId === productId);
  if (!targets.length) throw new Error("找不到这个 TikTok 商品的 SKU 记录。");
  if (!Object.keys(values).length) throw new Error("请至少填写一个需要批量修改的成本字段。");
  const now = new Date().toISOString();
  const fields = Object.keys(values);
  const next = records.map((record) => {
    if (record.tiktokProductId !== productId) return record;
    const input = { ...record.input, ...values };
    return {
      ...record,
      input,
      result: calculateSkuPricingWithActivity(input, record.activityPriceThb),
      actualResult: record.actualInput ? calculateActualSettlement(input, record.actualInput) : undefined,
      fieldSources: { ...record.fieldSources, ...Object.fromEntries(fields.map((field) => [field, "manual" as const])) },
      missingFields: record.missingFields.filter((field) => !fields.includes(field)),
      calculatedAt: now,
    };
  });
  store.upsert(next);
  return { records: next, updated: targets.length };
}

export function applySkuPricing(
  store: PricingStore,
  recordIds: string[],
  values: ProductPricingValues,
): { records: SkuPricingRecord[]; updated: number } {
  const targets = new Set(recordIds);
  if (!targets.size) throw new Error("没有可修改的 SKU 记录。");
  if (!Object.keys(values).length) throw new Error("请至少提供一个需要修改的成本字段。");
  const current = store.list();
  if (current.filter((record) => targets.has(record.id)).length !== targets.size) {
    throw new Error("部分 SKU 记录已经变化，请重新生成审核计划。");
  }
  const fields = Object.keys(values);
  const now = new Date().toISOString();
  const records = current.map((record) => {
    if (!targets.has(record.id)) return record;
    const input = { ...record.input, ...values };
    return {
      ...record,
      input,
      result: calculateSkuPricingWithActivity(input, record.activityPriceThb),
      actualResult: record.actualInput ? calculateActualSettlement(input, record.actualInput) : undefined,
      fieldSources: { ...record.fieldSources, ...Object.fromEntries(fields.map((field) => [field, "manual" as const])) },
      missingFields: record.missingFields.filter((field) => !fields.includes(field)),
      calculatedAt: now,
    };
  });
  store.upsert(records);
  return { records, updated: targets.size };
}

export function syncCatalogRows(
  store: PricingStore,
  rows: TikTokSkuRow[],
  shopId: string,
): Omit<PricingSyncResult, "totalProducts"> {
  const current = store.list();
  const byTikTokSku = new Map(current.flatMap((record) => record.tiktokSkuId ? [[record.tiktokSkuId, record] as const] : []));
  const now = new Date().toISOString();
  const defaults = pricingDefaults();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const matchedCategoryProducts = new Set<string>();
  const unmatchedCategoryProducts = new Set<string>();

  for (const row of rows) {
    const existing = byTikTokSku.get(row.skuId);
    const categoryId = row.categoryId ?? existing?.categoryId;
    const taxRule = findThailandTaxRule(categoryId);
    const commissionRule = findThailandCommissionRule(taxRule?.categoryName, taxRule?.path);
    const categoryName = taxRule?.categoryName ?? row.categoryName ?? existing?.categoryName;
    const categoryPath = taxRule?.path ?? row.categoryPath ?? existing?.categoryPath;
    if (taxRule && commissionRule) {
      matchedCategoryProducts.add(row.productId);
      unmatchedCategoryProducts.delete(row.productId);
    } else if (!matchedCategoryProducts.has(row.productId)) {
      unmatchedCategoryProducts.add(row.productId);
    }
    if (existing) {
      const syncPrice = existing.fieldSources.salePriceThb !== "manual" && Number.isFinite(row.price) && Number(row.price) > 0;
      const syncTax = Boolean(taxRule) && existing.fieldSources.taxRate !== "manual";
      const syncCommission = Boolean(commissionRule) && existing.fieldSources.categoryCommissionRate !== "manual";
      const salePriceThb = syncPrice ? Number(row.price) : existing.input.salePriceThb;
      const taxRate = syncTax ? taxRule!.compositeRate : existing.input.taxRate;
      const categoryCommissionRate = syncCommission ? commissionRule!.rate : existing.input.categoryCommissionRate;
      const activityPriceThb = row.activityPrice !== undefined && Number.isFinite(row.activityPrice) && row.activityPrice > 0
        ? row.activityPrice
        : undefined;
      const inputChanged = salePriceThb !== existing.input.salePriceThb
        || taxRate !== existing.input.taxRate
        || categoryCommissionRate !== existing.input.categoryCommissionRate;
      const activityChanged = activityPriceThb !== existing.activityPriceThb;
      const input = inputChanged ? { ...existing.input, salePriceThb, taxRate, categoryCommissionRate } : existing.input;
      const fieldSources = {
        ...existing.fieldSources,
        ...(syncPrice ? { salePriceThb: "tiktok" as const } : {}),
        ...(syncTax ? { taxRate: "category_rule" as const } : {}),
        ...(syncCommission ? { categoryCommissionRate: "category_rule" as const } : {}),
      };
      const missingFields = existing.missingFields.filter((field) =>
        !(field === "taxRate" && taxRule) && !(field === "categoryCommissionRate" && commissionRule));
      const changed = existing.productTitle !== row.productTitle
        || existing.productImageUrl !== row.productImageUrl
        || existing.availableStock !== row.stock
        || existing.committedStock !== row.committedStock
        || activityChanged
        || existing.skuName !== row.skuName
        || existing.sellerSku !== row.sellerSku
        || existing.shopId !== shopId
        || existing.tiktokProductId !== row.productId
        || existing.categoryId !== categoryId
        || existing.categoryName !== categoryName
        || existing.categoryPath !== categoryPath
        || existing.tiktokStatus !== "ACTIVATE"
        || inputChanged
        || fieldSources.taxRate !== existing.fieldSources.taxRate
        || fieldSources.categoryCommissionRate !== existing.fieldSources.categoryCommissionRate
        || missingFields.join("\0") !== existing.missingFields.join("\0");
      if (!changed) { unchanged += 1; continue; }
      const next = {
        ...existing,
        shopId,
        tiktokProductId: row.productId,
        tiktokSkuId: row.skuId,
        tiktokStatus: "ACTIVATE" as const,
        productTitle: row.productTitle,
        productImageUrl: row.productImageUrl,
        availableStock: row.stock,
        committedStock: row.committedStock,
        activityPriceThb,
        skuName: row.skuName,
        sellerSku: row.sellerSku,
        categoryId,
        categoryName,
        categoryPath,
        input,
        result: inputChanged || activityChanged ? calculateSkuPricingWithActivity(input, activityPriceThb) : existing.result,
        actualResult: inputChanged && existing.actualInput ? calculateActualSettlement(input, existing.actualInput) : existing.actualResult,
        fieldSources,
        missingFields,
        calculatedAt: now,
      };
      const index = current.findIndex((record) => record.id === existing.id);
      current[index] = next;
      byTikTokSku.set(row.skuId, next);
      updated += 1;
      continue;
    }

    const salePriceThb = Number.isFinite(row.price) && Number(row.price) > 0 ? Number(row.price) : 0.01;
    const input: SkuPricingInput = {
      salePriceThb,
      purchasePriceCny: 0,
      weightKg: 0.001,
      exchangeRateCnyToThb: defaults.exchangeRateCnyToThb,
      domesticLogisticsCny: defaults.domesticLogisticsCny,
      cloudWarehouseCny: defaults.cloudWarehouseCny,
      buyerLocalDeliveryThb: defaults.buyerLocalDeliveryThb,
      advertisingThb: defaults.advertisingThb,
      creatorCommissionRate: defaults.creatorCommissionRate,
      taxRate: taxRule?.compositeRate ?? THAILAND_PRELIMINARY_RATES.taxRate,
      categoryCommissionRate: commissionRule?.rate ?? THAILAND_PRELIMINARY_RATES.categoryCommissionRate,
      crossBorderThbPer10g: THAILAND_PRICING_DEFAULTS.crossBorderThbPer10g,
      transactionRate: THAILAND_PRICING_DEFAULTS.transactionRate,
      infrastructureFeeThb: THAILAND_PRICING_DEFAULTS.infrastructureFeeThb,
      growthSupportRate: THAILAND_PRICING_DEFAULTS.growthSupportRate,
      merchantDiscountThb: 0,
      platformSubsidyThb: 0,
      platformActivityFeeThb: 0,
    };
    const record: SkuPricingRecord = {
      id: `tiktok:${row.skuId}`,
      workflowId: `tiktok-sync:${row.productId}`,
      shopId,
      tiktokProductId: row.productId,
      tiktokSkuId: row.skuId,
      tiktokStatus: "ACTIVATE",
      productTitle: row.productTitle,
      productImageUrl: row.productImageUrl,
      availableStock: row.stock,
      committedStock: row.committedStock,
      activityPriceThb: row.activityPrice,
      categoryId,
      categoryName,
      categoryPath,
      skuKey: row.skuId,
      skuName: row.skuName || row.sellerSku || row.skuId,
      sellerSku: row.sellerSku,
      currency: "THB",
      input,
      result: calculateSkuPricingWithActivity(input, row.activityPrice),
      fieldSources: {
        salePriceThb: row.price ? "tiktok" : "default",
        purchasePriceCny: "default",
        weightKg: "default",
        taxRate: taxRule ? "category_rule" : "default",
        categoryCommissionRate: commissionRule ? "category_rule" : "default",
        exchangeRateCnyToThb: "default",
        domesticLogisticsCny: "default",
        cloudWarehouseCny: "default",
        buyerLocalDeliveryThb: "default",
        advertisingThb: "default",
        creatorCommissionRate: "default",
      },
      missingFields: [
        ...(!row.price ? ["salePriceThb"] : []),
        "purchasePriceCny", "weightKg",
        ...(!taxRule ? ["taxRate"] : []),
        ...(!commissionRule ? ["categoryCommissionRate"] : []),
      ],
      calculatedAt: now,
    };
    current.push(record);
    byTikTokSku.set(row.skuId, record);
    created += 1;
  }

  const syncedSkuIds = new Set(rows.map((row) => row.skuId));
  for (let index = 0; index < current.length; index += 1) {
    const record = current[index];
    if (record.shopId !== shopId || !record.tiktokProductId || !record.tiktokSkuId || syncedSkuIds.has(record.tiktokSkuId)) continue;
    if (record.tiktokStatus === "INACTIVE") continue;
    current[index] = { ...record, tiktokStatus: "INACTIVE", calculatedAt: now };
    updated += 1;
  }
  if (created || updated) store.upsert(current);
  const syncedRecords = current.filter((record) => record.shopId === shopId && record.tiktokStatus === "ACTIVATE");
  const inactiveRecords = current.filter((record) => record.shopId === shopId && record.tiktokStatus === "INACTIVE");
  return {
    records: current,
    totalSkus: rows.length,
    created,
    updated,
    unchanged,
    missingCost: syncedRecords.filter((record) => record.missingFields.length > 0).length,
    inactiveProducts: new Set(inactiveRecords.map((record) => record.tiktokProductId)).size,
    inactiveSkus: inactiveRecords.length,
    matchedCategoryProducts: matchedCategoryProducts.size,
    unmatchedCategoryProducts: unmatchedCategoryProducts.size,
  };
}

export async function syncPricingFromTikTok(): Promise<PricingSyncResult> {
  const data = await getTikTokOperationalData(7);
  return {
    ...syncCatalogRows(pricingStore, data.skuRows, data.dashboard.store.id),
    totalProducts: data.totalProducts,
  };
}

import type {
  PricingDefaults,
  PricingFieldSource,
  ProductPublishWorkflowRun,
  SkuPricingInput,
  SkuPricingRecord,
} from "../shared/contracts.ts";
import { miaoshouGetTikTokShopCollectItemInfo, resolveMiaoshouShopId } from "./miaoshou-client.ts";
import { calculateSkuPricing } from "./pricing-engine.ts";
import {
  findThailandCommissionRule,
  findThailandTaxRule,
  THAILAND_PRICING_DEFAULTS,
} from "./pricing-rules.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function skuValueNames(item: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  const groups = Array.isArray(item.skuPropertyList) ? item.skuPropertyList : [];
  for (const groupValue of groups) {
    const group = asRecord(groupValue);
    const values = Array.isArray(group?.attrValueList) ? group.attrValueList : [];
    for (const value of values) {
      const entry = asRecord(value);
      const id = String(entry?.attrValueId ?? "").trim();
      const name = String(entry?.attrValue ?? "").trim();
      if (id && name) result.set(id, name);
    }
  }
  return result;
}

function skuName(key: string, names: Map<string, string>): string {
  const parts = key.split(";").filter(Boolean).map((part) => names.get(part) ?? part);
  return parts.length ? parts.join(" / ") : key;
}

export function pricingDefaults(): PricingDefaults {
  return {
    exchangeRateCnyToThb: THAILAND_PRICING_DEFAULTS.exchangeRateCnyToThb,
    domesticLogisticsCny: THAILAND_PRICING_DEFAULTS.domesticLogisticsCny,
    cloudWarehouseCny: THAILAND_PRICING_DEFAULTS.cloudWarehouseCny,
    buyerLocalDeliveryThb: THAILAND_PRICING_DEFAULTS.buyerLocalDeliveryThb,
    advertisingThb: THAILAND_PRICING_DEFAULTS.advertisingThb,
    creatorCommissionRate: THAILAND_PRICING_DEFAULTS.creatorCommissionRate,
  };
}

export async function fetchWorkflowPricing(run: Pick<ProductPublishWorkflowRun,
  "id" | "sourceItemId" | "commonDetailId" | "platformDetailId" | "shopId" | "publishPrice"
  | "miaoshouShopId" | "shopName" | "shopSite"
>): Promise<{ defaults: PricingDefaults; records: SkuPricingRecord[] }> {
  if (!run.platformDetailId || !run.shopId) throw new Error("任务缺少妙手商品或店铺编号，无法读取 SKU 成本。");
  // shopId 可能是 TikTok OAuth 密文，必须先解析为妙手数字店铺 ID，
  // 否则 Number() 得到 NaN，请求体会变成非法 JSON，妙手网关报“detailId 必填”
  let shopIdNum = Number(run.miaoshouShopId || run.shopId);
  if (!Number.isFinite(shopIdNum) || shopIdNum <= 0) {
    const resolved = await resolveMiaoshouShopId(run.shopId, {
      region: run.shopSite,
      shopName: run.shopName,
    });
    shopIdNum = Number(resolved);
  }
  if (!Number.isFinite(shopIdNum) || shopIdNum <= 0) {
    throw new Error("无法把 TikTok 店铺解析为妙手店铺编号，无法读取 SKU 成本。请确认妙手已授权该店铺后重试。");
  }
  const response = await miaoshouGetTikTokShopCollectItemInfo(Number(run.platformDetailId), shopIdNum);
  const item = asRecord(asRecord(response.data)?.shopCollectItemInfo);
  if (!item) throw new Error("妙手没有返回商品详情，无法建立 SKU 利润记录。");
  const categoryId = String(item.cid ?? "").trim() || undefined;
  const taxRule = findThailandTaxRule(categoryId);
  const commissionRule = findThailandCommissionRule(taxRule?.categoryName, taxRule?.path);
  const defaults = pricingDefaults();
  const names = skuValueNames(item);
  const now = new Date().toISOString();
  const skuMap = asRecord(item.skuMap) ?? {};
  const records = Object.entries(skuMap).flatMap(([key, value]) => {
    const sku = asRecord(value);
    if (!sku || sku.isDelete === "1") return [];
    const purchasePriceCny = positive(sku.originPrice ?? sku.oriPrice ?? sku.price) ?? 0;
    const salePriceThb = positive(run.publishPrice) ?? positive(sku.priceIncludeVat ?? sku.price) ?? 0;
    const weightKg = positive(sku.weight ?? item.weight) ?? 0;
    const input: SkuPricingInput = {
      salePriceThb,
      purchasePriceCny,
      weightKg,
      exchangeRateCnyToThb: defaults.exchangeRateCnyToThb,
      domesticLogisticsCny: defaults.domesticLogisticsCny,
      cloudWarehouseCny: defaults.cloudWarehouseCny,
      buyerLocalDeliveryThb: defaults.buyerLocalDeliveryThb,
      advertisingThb: defaults.advertisingThb,
      creatorCommissionRate: defaults.creatorCommissionRate,
      taxRate: taxRule?.compositeRate ?? 0,
      categoryCommissionRate: commissionRule?.rate ?? 0,
      crossBorderThbPer10g: THAILAND_PRICING_DEFAULTS.crossBorderThbPer10g,
      transactionRate: THAILAND_PRICING_DEFAULTS.transactionRate,
      infrastructureFeeThb: THAILAND_PRICING_DEFAULTS.infrastructureFeeThb,
      growthSupportRate: THAILAND_PRICING_DEFAULTS.growthSupportRate,
      merchantDiscountThb: 0,
      platformSubsidyThb: 0,
      platformActivityFeeThb: 0,
    };
    const missingFields = [
      ...(!purchasePriceCny ? ["purchasePriceCny"] : []),
      ...(!salePriceThb ? ["salePriceThb"] : []),
      ...(!weightKg ? ["weightKg"] : []),
      ...(!taxRule ? ["taxRate"] : []),
      ...(!commissionRule ? ["categoryCommissionRate"] : []),
    ];
    if (missingFields.includes("salePriceThb")) input.salePriceThb = 0.01;
    if (missingFields.includes("weightKg")) input.weightKg = 0.001;
    const fieldSources: Record<string, PricingFieldSource> = {
      salePriceThb: run.publishPrice ? "manual" : "miaoshou",
      purchasePriceCny: "1688",
      weightKg: "miaoshou",
      taxRate: taxRule ? "category_rule" : "default",
      categoryCommissionRate: commissionRule ? "category_rule" : "default",
      exchangeRateCnyToThb: "default",
      domesticLogisticsCny: "default",
      cloudWarehouseCny: "default",
      buyerLocalDeliveryThb: "default",
      advertisingThb: "default",
      creatorCommissionRate: "default",
    };
    return [{
      id: `${run.id}:${Buffer.from(key).toString("base64url")}`,
      workflowId: run.id,
      sourceItemId: run.sourceItemId,
      commonDetailId: run.commonDetailId,
      platformDetailId: run.platformDetailId,
      shopId: run.shopId,
      skuKey: key,
      skuName: skuName(key, names),
      sellerSku: String(sku.itemNum ?? "").trim() || undefined,
      categoryId,
      categoryName: taxRule?.categoryName,
      categoryPath: taxRule?.path,
      currency: "THB" as const,
      input,
      result: calculateSkuPricing(input),
      fieldSources,
      missingFields,
      calculatedAt: now,
    }];
  });
  if (!records.length) throw new Error("商品没有可计算利润的有效 SKU。");
  return { defaults, records };
}

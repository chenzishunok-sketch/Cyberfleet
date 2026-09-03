import type { SkuPricingRecord, SupplierPricingPreview, SupplierSkuPriceMatch } from "../shared/contracts.ts";
import { getTmapiItemDetailByUrl, type TmapiItemDetail } from "./tmapi-client.ts";
import { calculateSkuPricingWithActivity } from "./pricing-engine.ts";
import type { PricingStore } from "./pricing-store.ts";

function normalized(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function positivePrice(value: unknown): number | undefined {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

function sourceSkuName(sku: Record<string, unknown>, index: number): string {
  return String(sku.props_names ?? sku.sku_name ?? sku.name ?? `供应商 SKU ${index + 1}`).trim();
}

function sourceSkuPrice(sku: Record<string, unknown>, fallback?: number): number | undefined {
  return positivePrice(sku.sale_price) ?? positivePrice(sku.origin_price) ?? fallback;
}

function supplierVariants(detail: TmapiItemDetail): Array<{ id: string; name: string; price: number }> {
  const fallback = positivePrice(detail.price_info?.price_min) ?? positivePrice(detail.price_info?.price);
  return (detail.skus ?? []).flatMap((raw, index) => {
    const sku = raw as Record<string, unknown>;
    const price = sourceSkuPrice(sku, fallback);
    if (!price) return [];
    return [{
      id: String(sku.skuid ?? sku.sku_id ?? `source-${index + 1}`),
      name: sourceSkuName(sku, index),
      price,
    }];
  });
}

function targetValues(record: SkuPricingRecord): string[] {
  return [record.tiktokSkuId, record.sellerSku, record.skuKey, record.skuName].map(normalized).filter(Boolean);
}

export function buildSupplierPricingPreview(
  records: SkuPricingRecord[],
  detail: TmapiItemDetail,
  sourceUrl: string,
): SupplierPricingPreview {
  const targets = records.filter((record) => record.tiktokProductId && record.tiktokSkuId)
    .sort((left, right) => String(left.tiktokSkuId).localeCompare(String(right.tiktokSkuId)));
  const variants = supplierVariants(detail);
  const fallback = positivePrice(detail.price_info?.price_min) ?? positivePrice(detail.price_info?.price);
  const sourceList = variants.length ? variants : fallback ? [{ id: String(detail.item_id), name: "商品统一采购价", price: fallback }] : [];
  const matches: SupplierSkuPriceMatch[] = [];
  const used = new Set<number>();

  for (const target of targets) {
    const values = targetValues(target);
    const exactIndex = sourceList.findIndex((source, index) => !used.has(index)
      && values.some((value) => value === normalized(source.id) || value === normalized(source.name)));
    if (exactIndex < 0) continue;
    used.add(exactIndex);
    const source = sourceList[exactIndex];
    matches.push({
      recordId: target.id,
      targetSkuId: target.tiktokSkuId!,
      targetSkuName: target.skuName,
      sourceSkuId: source.id,
      sourceSkuName: source.name,
      purchasePriceCny: source.price,
      method: "exact",
      confidence: "high",
    });
  }

  if (matches.length !== targets.length) {
    const uniquePrices = new Set(sourceList.map((source) => source.price));
    if (uniquePrices.size === 1) {
      const source = sourceList[0];
      for (const target of targets.filter((record) => !matches.some((match) => match.recordId === record.id))) {
        matches.push({
          recordId: target.id,
          targetSkuId: target.tiktokSkuId!,
          targetSkuName: target.skuName,
          sourceSkuId: source.id,
          sourceSkuName: source.name,
          purchasePriceCny: source.price,
          method: "shared_price",
          confidence: "high",
        });
      }
    } else if (sourceList.length === targets.length) {
      const matchedIds = new Set(matches.map((match) => match.recordId));
      const remainingTargets = targets.filter((record) => !matchedIds.has(record.id));
      const remainingSources = sourceList.filter((_source, index) => !used.has(index));
      remainingTargets.forEach((target, index) => {
        const source = remainingSources[index];
        if (!source) return;
        matches.push({
          recordId: target.id,
          targetSkuId: target.tiktokSkuId!,
          targetSkuName: target.skuName,
          sourceSkuId: source.id,
          sourceSkuName: source.name,
          purchasePriceCny: source.price,
          method: "sequence",
          confidence: "medium",
        });
      });
    }
  }

  return {
    sourceUrl,
    sourceItemId: String(detail.item_id),
    sourceTitle: detail.title ?? `1688 商品 ${detail.item_id}`,
    targetSkuCount: targets.length,
    sourceSkuCount: sourceList.length,
    matchedCount: matches.length,
    requiresConfirmation: matches.some((match) => match.method === "sequence"),
    matches,
  };
}

export async function previewSupplierPricing(records: SkuPricingRecord[], sourceUrl: string): Promise<SupplierPricingPreview> {
  const detail = await getTmapiItemDetailByUrl(sourceUrl, { scene: "drop_shipping", language: "zh" });
  return buildSupplierPricingPreview(records, detail, sourceUrl);
}

export function applySupplierPricing(
  store: PricingStore,
  preview: SupplierPricingPreview,
  targets?: SkuPricingRecord[],
): { records: SkuPricingRecord[]; updated: number; linked: number } {
  const byId = new Map(preview.matches.map((match) => [match.recordId, match]));
  const targetIds = new Set((targets ?? preview.matches).map((record) => "recordId" in record ? record.recordId : record.id));
  const current = store.list();
  let updated = 0;
  let linked = 0;
  const next = current.map((record) => {
    if (!targetIds.has(record.id)) return record;
    const match = byId.get(record.id);
    linked += 1;
    if (!match) {
      return {
        ...record,
        sourceItemId: preview.sourceItemId,
        sourceUrl: preview.sourceUrl,
        calculatedAt: new Date().toISOString(),
      };
    }
    const input = { ...record.input, purchasePriceCny: match.purchasePriceCny };
    const missingFields = record.missingFields.filter((field) => field !== "purchasePriceCny");
    updated += 1;
    return {
      ...record,
      sourceItemId: preview.sourceItemId,
      sourceUrl: preview.sourceUrl,
      input,
      result: calculateSkuPricingWithActivity(input, record.activityPriceThb),
      fieldSources: { ...record.fieldSources, purchasePriceCny: "1688" as const },
      missingFields,
      calculatedAt: new Date().toISOString(),
    };
  });
  if (linked) store.upsert(next);
  return { records: next, updated, linked };
}

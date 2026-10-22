import type { MessageArtifact } from "../shared/contracts.ts";
import {
  getTmapiItemDetailById,
  type TmapiItemDetail,
  type TmapiItemDetailOptions,
  type TmapiLanguage,
} from "./tmapi-client.ts";

export interface TmapiItemIntent {
  itemId: string;
  options: TmapiItemDetailOptions;
}

export interface TmapiItemSceneResult {
  content: string;
  artifact: Extract<MessageArtifact, { kind: "records" }>;
  item: TmapiItemDetail;
}

const LANGUAGE_PATTERNS: Array<[RegExp, TmapiLanguage]> = [
  [/(?:越南|越南语|vietnamese)/i, "vi"],
  [/(?:俄罗斯|俄语|russian)/i, "ru"],
  [/(?:西班牙|西班牙语|spanish)/i, "es"],
  [/(?:日本|日语|japanese)/i, "ja"],
  [/(?:韩国|韩语|korean)/i, "ko"],
  [/(?:英文|英语|english)/i, "en"],
];

function sourceItemId(text: string): string | undefined {
  const pathId = text.match(/(?:detail\.)?1688\.com\/offer\/(\d{6,20})\.html/i)?.[1];
  if (pathId) return pathId;
  const queryId = text.match(/[?&]offerId=(\d{6,20})/i)?.[1];
  if (queryId) return queryId;
  return text.match(/(?:1688\s*(?:商品)?\s*(?:ID|编号)?\s*[:：]?[\s#-]*)(\d{6,20})/i)?.[1];
}

export function inferTmapiItemIntent(text: string): TmapiItemIntent | undefined {
  const itemId = sourceItemId(text);
  if (!itemId) return undefined;

  const isWriteRequest = /(采集|认领|发布|上架|铺货|搬到|导入到).*(妙手|tiktok|\btk\b|采集箱|店铺)|(妙手|tiktok|\btk\b).*(采集|认领|发布|上架|铺货)/i.test(text);
  const isReadRequest = /(分析|详情|信息|查询|读取|看看|看一下|检查|体检|采购价|价格|sku|库存|重量|起订|供应商|值不值|适不适合|一件代发)/i.test(text);
  const containsProductUrl = /(?:detail\.)?1688\.com\/offer\/\d{6,20}\.html/i.test(text);
  if (isWriteRequest && !isReadRequest) return undefined;
  if (!isReadRequest && !containsProductUrl) return undefined;

  const language = LANGUAGE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? "zh";
  return {
    itemId,
    options: {
      language,
      ...(/一件代发|代发|drop.?shipping/i.test(text) ? { scene: "drop_shipping" as const } : {}),
      ...(/优化标题|翻译标题/i.test(text) ? { optimizeTitle: true } : {}),
    },
  };
}

function textValue(value: unknown, fallback = "--"): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function priceRange(item: TmapiItemDetail): string {
  const minimum = item.price_info?.price_min ?? item.price_info?.price;
  const maximum = item.price_info?.price_max ?? item.price_info?.price;
  if (minimum === undefined || minimum === null) return "--";
  return String(minimum) === String(maximum) ? String(minimum) : `${minimum}-${maximum}`;
}

function skuRows(item: TmapiItemDetail): Array<Record<string, string>> {
  return (item.skus ?? []).slice(0, 100).map((sku) => {
    const pkg = sku.package_info;
    const dimensions = [pkg?.length, pkg?.width, pkg?.height].every((value) => typeof value === "number" && value > 0)
      ? `${pkg?.length}x${pkg?.width}x${pkg?.height}`
      : "--";
    return {
      sku_id: textValue(sku.skuid),
      specification: textValue(sku.props_names, "默认款"),
      price: textValue(sku.sale_price),
      stock: textValue(sku.stock),
      weight_kg: textValue(pkg?.weight && pkg.weight > 0 ? pkg.weight : item.delivery_info?.unit_weight),
      dimensions_cm: dimensions,
    };
  });
}

export async function runTmapiItemScene(intent: TmapiItemIntent): Promise<TmapiItemSceneResult> {
  const item = await getTmapiItemDetailById(intent.itemId, intent.options);
  const rows = skuRows(item);
  const currency = item.currency ?? "CNY";
  const stock = textValue(item.stock);
  const sales90 = textValue(item.sale_info?.sale_quantity_90days ?? item.sale_count);
  const title = item.title || `1688 商品 ${intent.itemId}`;
  const missingWeight = (item.skus ?? []).length > 0 && (item.skus ?? []).every((sku) => !sku.package_info?.weight && !item.delivery_info?.unit_weight);
  const notices = [
    item.is_sold_out ? "商品已售罄" : undefined,
    missingWeight ? "未返回可用重量" : undefined,
  ].filter(Boolean);
  const noticeText = notices.length ? ` 需注意：${notices.join("、")}。` : "";

  return {
    item,
    content: `已读取真实 1688 货源数据：${title}。采购价 ${priceRange(item)} ${currency}，库存 ${stock}，近 90 天销量 ${sales90}，共 ${item.skus?.length ?? 0} 个 SKU。${noticeText}这里的运费不包含中国到日本的跨境物流。`,
    artifact: {
      kind: "records",
      headline: title,
      summary: `1688 商品 ${intent.itemId} · ${item.shop_info?.shop_name ?? "供应商未返回"} · 采购价 ${priceRange(item)} ${currency} · 库存 ${stock}`,
      columns: [
        { key: "sku_id", label: "SKU ID" },
        { key: "specification", label: "规格" },
        { key: "price", label: `采购价 (${currency})` },
        { key: "stock", label: "库存" },
        { key: "weight_kg", label: "重量 (kg)" },
        { key: "dimensions_cm", label: "长宽高 (cm)" },
      ],
      rows,
      source: `1688 货源 · GET /1688/item_detail · ${intent.itemId}`,
      emptyLabel: "该商品没有返回 SKU 记录。",
    },
  };
}

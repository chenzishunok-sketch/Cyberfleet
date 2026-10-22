import type { FlashSaleWorkflowInput } from "./flash-sale-workflow.ts";

export function extractProductEditInput(text: string): {
  publishPrice: number;
  packageDimensions?: { length: number; width: number; height: number };
  title?: string;
  description?: string;
} | undefined {
  const price = text.match(/(?:发布价|售价|定价|价格)\s*(?:为|是|:|：)?\s*(\d+(?:\.\d{1,2})?)/i)?.[1];
  if (!price) return undefined;
  const compactDimensions = text.match(/(?:包裹尺寸|尺寸|长宽高)?\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  const labeledDimensions = text.match(/长\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)?\s*[、,，\s]+宽\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)?\s*[、,，\s]+高\s*(\d+(?:\.\d+)?)\s*(?:cm|厘米)?/i);
  const dimensions = compactDimensions ?? labeledDimensions;
  const title = text.match(/商品标题\s*(?:(?:使用|为|是)\s*)?[:：]?\s*[“"]?([^\n。；”"]{2,255})/i)?.[1]?.trim();
  const description = text.match(/商品描述\s*(?:(?:使用|为|是)\s*)?[:：]?\s*[“"]?([^\n。；”"]{2,10000})/i)?.[1]?.trim();
  return {
    publishPrice: Number(price),
    ...(dimensions ? { packageDimensions: { length: Number(dimensions[1]), width: Number(dimensions[2]), height: Number(dimensions[3]) } } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

export function extract1688WorkflowInput(text: string): {
  sourceUrl: string;
  shopId?: string;
  publishPrice?: number;
  currency?: string;
  packageDimensions?: { length: number; width: number; height: number };
  title?: string;
  description?: string;
} | undefined {
  const sourceUrl = text.match(/https:\/\/(?:[a-z0-9-]+\.)*1688\.com\/[^\s<>"，。）)]+/i)?.[0];
  if (!sourceUrl || !/(发布|上架|铺货|搬到|一键|全流程|tiktok|\btk\b)/i.test(text)) return undefined;
  const productInput = extractProductEditInput(text);
  const shopId = text.match(/(?:店铺(?:\s*ID)?|shop\s*id)\s*(?:为|是|:|：)?\s*(\d+)/i)?.[1];
  const currency = text.match(/\b(JPY|USD|CNY|VND|MYR|PHP|SGD|IDR|GBP)\b/i)?.[1]?.toUpperCase();
  return {
    sourceUrl,
    ...(shopId ? { shopId } : {}),
    ...(currency ? { currency } : {}),
    ...(productInput ?? {}),
  };
}

function absoluteTimes(text: string): string[] {
  const values = [...text.matchAll(/(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)[ T日]\s*([0-2]?\d)(?::|点)([0-5]\d)?/g)];
  return values.map((match) => {
    const [, year, month, day, hour, minute = "00"] = match;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`).toISOString();
  });
}

export function parseFlashSaleIntent(text: string): { input?: FlashSaleWorkflowInput; missing: string[] } | undefined {
  if (!/(秒杀|flash\s*sale|闪购)/i.test(text)) return undefined;
  const productId = text.match(/(?:商品\s*ID|product\s*id|商品)\s*(?:为|是|:|：)?\s*(\d{10,30})/i)?.[1]
    ?? text.match(/\b(\d{16,30})\b/)?.[1];
  const priceAmount = text.match(/(?:秒杀价|活动价|价格)\s*(?:为|是|:|：)?\s*(\d+(?:\.\d{1,2})?)/i)?.[1];
  const skuQuantity = text.match(/(?:活动库存|秒杀库存|每个\s*SKU\s*库存)\s*(?:为|是|:|：)?\s*(-?\d+)/i)?.[1];
  const perUser = text.match(/(?:每人限购|限购)\s*(?:为|是|:|：)?\s*(-?\d+)/i)?.[1];
  const times = absoluteTimes(text);
  const currency = text.match(/\b(JPY|USD|CNY|VND|MYR|PHP|SGD|IDR|GBP)\b/i)?.[1]?.toUpperCase();
  const title = text.match(/(?:活动名称|活动标题)\s*(?:为|是|:|：)\s*[“"]?([^\n，”"]{2,80})/i)?.[1]?.trim();
  const skuList = text.match(/(?:SKU\s*ID|SKU)\s*(?:为|是|:|：)?\s*([\d,，\s]+)/i)?.[1]
    ?.split(/[,，\s]+/).filter((value) => /^\d+$/.test(value));
  const missing: string[] = [];
  if (!productId) missing.push("商品 ID");
  if (times.length < 2) missing.push("明确的开始和结束时间（例如 2026-07-30 10:00 到 2026-07-30 20:00）");
  if (!priceAmount) missing.push("秒杀价");
  if (skuQuantity === undefined) missing.push("每个 SKU 的活动库存（1-99 或 -1）");
  if (perUser === undefined) missing.push("每人限购（1-99 或 -1）");
  if (missing.length || !productId || !priceAmount || skuQuantity === undefined || perUser === undefined) return { missing };
  return {
    missing: [],
    input: {
      productId,
      activityTitle: title || `FlashSale-${productId.slice(-6)}-${Date.now().toString().slice(-6)}`,
      startAt: times[0],
      endAt: times[1],
      priceAmount,
      currency: currency || "JPY",
      skuIds: skuList?.length ? skuList : undefined,
      skuQuantityLimit: Number(skuQuantity),
      quantityPerUser: Number(perUser),
    },
  };
}

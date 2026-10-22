import type {
  ChatImageAttachment,
  ChatRequest,
  MessageArtifact,
  SourcingCandidate,
} from "../shared/contracts.ts";
import {
  convertTmapiImageUrl,
  getTmapiItemDetailById,
  searchTmapiItemsByImage,
  type TmapiImageSearchItem,
  type TmapiItemDetail,
} from "./tmapi-client.ts";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CANDIDATE_LIMIT = 6;
const DEFAULT_WEIGHT_KG = 0.5;

export interface SourcingIntent {
  image?: ChatImageAttachment;
  imageUrl?: string;
  maxPurchasePriceCny?: number;
  minimumSales?: number;
  factoryOnly: boolean;
  verifiedSupplier: boolean;
  supportDropshipping: boolean;
  sort: "default" | "sales" | "price_up" | "price_down";
}

export interface SourcingSearchResult {
  content: string;
  artifact?: Extract<MessageArtifact, { kind: "sourcing_candidates" }>;
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function imageUrlFromText(text: string): string | undefined {
  return [...text.matchAll(/https?:\/\/[^\s<>"，。）)]+/gi)]
    .map((match) => match[0])
    .find((url) => !/(^|\.)1688\.com$/i.test(new URL(url).hostname));
}

export function inferSourcingIntent(request: Pick<ChatRequest, "message" | "attachments">): SourcingIntent | undefined {
  const text = request.message.trim();
  const image = request.attachments?.[0];
  const hasSourcingLanguage = /(以图搜|图片.*(?:找|搜).*(?:同款|货源|1688)|(?:找|搜).*(?:1688同款|同款货源|供应商)|帮我找这个产品的?1688同款)/i.test(text);
  if (!image && !hasSourcingLanguage) return undefined;

  const maxPurchasePriceCny = positiveNumber(text.match(/(?:采购价|进货价|货源价).{0,8}(?:不超过|低于|最高)?\s*(\d+(?:\.\d+)?)\s*(?:元|CNY)/i)?.[1]);
  const minimumSales = positiveNumber(text.match(/(?:销量|成交).{0,8}(?:超过|大于|最少)?\s*(\d+)/i)?.[1]);
  const sort = /价格从低|低价优先/i.test(text)
    ? "price_up" as const
    : /价格从高/i.test(text)
      ? "price_down" as const
      : /销量优先|销量排序/i.test(text)
        ? "sales" as const
        : "default" as const;
  return {
    image,
    imageUrl: image ? undefined : imageUrlFromText(text),
    maxPurchasePriceCny,
    minimumSales,
    factoryOnly: /只看工厂|工厂货源|生产厂家/i.test(text),
    verifiedSupplier: /实力卖家|实力供应商/i.test(text),
    supportDropshipping: !/不限一件代发|不要求一件代发/i.test(text),
    sort,
  };
}

function decodeImage(attachment: ChatImageAttachment): { bytes: Uint8Array; mimeType: string } {
  const match = attachment.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("图片格式不支持，请使用 JPG、PNG 或 WebP。");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("图片大小需要在 4MB 以内。");
  return { bytes: new Uint8Array(buffer), mimeType: match[1] };
}

type TemporaryUploadKind = "raw" | "uguu";

interface TemporaryUploadProvider {
  name: string;
  endpoint: string;
  kind: TemporaryUploadKind;
  attempts: number;
}

function temporaryUploadProviders(): TemporaryUploadProvider[] {
  const configured = process.env.SOURCING_IMAGE_UPLOAD_URL?.trim();
  const providers: TemporaryUploadProvider[] = [];
  if (configured) {
    let kind: TemporaryUploadKind = "uguu";
    try {
      if (new URL(configured).hostname.toLowerCase() === "paste.c-net.org") kind = "raw";
    } catch {
      // The upload request will return a useful error for an invalid custom URL.
    }
    providers.push({ name: "自定义图片通道", endpoint: configured, kind, attempts: 1 });
  }
  providers.push({ name: "图片直传通道", endpoint: "https://paste.c-net.org/", kind: "raw", attempts: 1 });
  providers.push({ name: "备用临时图片通道", endpoint: "https://uguu.se/upload.php", kind: "uguu", attempts: 2 });
  return providers.filter((provider, index, all) => all.findIndex((item) => item.endpoint === provider.endpoint) === index);
}

async function uploadTemporaryImage(attachment: ChatImageAttachment, provider: TemporaryUploadProvider): Promise<string> {
  const { bytes, mimeType } = decodeImage(attachment);
  const imageBuffer = new Uint8Array(bytes.byteLength);
  imageBuffer.set(bytes);
  let response: Response;
  try {
    if (provider.kind === "raw") {
      response = await fetch(provider.endpoint, {
        method: "POST",
        headers: { "content-type": mimeType, accept: "text/plain" },
        body: imageBuffer,
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      const form = new FormData();
      form.set("files[]", new Blob([imageBuffer.buffer], { type: mimeType }), attachment.name || "sourcing-image.jpg");
      response = await fetch(provider.endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    }
  } catch (error) {
    throw new Error(`${provider.name}上传失败：${error instanceof Error ? error.message : "网络异常"}`);
  }
  if (provider.kind === "raw") {
    const url = (await response.text()).trim();
    if (!response.ok || !/^https?:\/\//i.test(url)) throw new Error(`${provider.name}没有返回可访问的图片链接。`);
    return url;
  }
  const payload = await response.json().catch(() => undefined) as { success?: boolean; files?: Array<{ url?: string }> } | undefined;
  const url = payload?.files?.[0]?.url;
  if (!response.ok || !payload?.success || !url) throw new Error(`${provider.name}没有返回可访问的图片链接。`);
  return url;
}

function isAlibabaImage(url: string): boolean {
  try {
    return /(^|\.)alicdn\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function saleCount(item: TmapiImageSearchItem): number {
  return positiveNumber(item.sale_info?.sale_quantity_int ?? item.sale_info?.sale_quantity) ?? 0;
}

function repurchaseRate(item: TmapiImageSearchItem): number | undefined {
  const value = item.item_repurchase_rate?.match(/\d+(?:\.\d+)?/)?.[0];
  return value ? Number(value) / 100 : undefined;
}

function supplierScore(item: TmapiImageSearchItem): number | undefined {
  return positiveNumber(item.shop_info?.score_info?.composite_new_score ?? item.goods_score ?? item.rating_star);
}

function recommendationScore(item: TmapiImageSearchItem, index: number, count: number): number {
  const relevance = 35 * (1 - index / Math.max(count, 1));
  const sales = Math.min(25, Math.log10(saleCount(item) + 1) * 6);
  const repurchase = (repurchaseRate(item) ?? 0) * 20;
  const factory = item.shop_info?.is_factory ? 10 : 0;
  const experience = Math.min(5, (positiveNumber(item.shop_info?.shop_years) ?? 0) / 2);
  const organic = item.is_ad ? 0 : 5;
  return Math.round(Math.min(100, relevance + sales + repurchase + factory + experience + organic));
}

function minimumPurchasePrice(item: TmapiImageSearchItem, detail?: TmapiItemDetail): number {
  const values = [
    ...(detail?.skus ?? []).map((sku) => positiveNumber(sku.sale_price)),
    positiveNumber(detail?.price_info?.price_min ?? detail?.price_info?.price),
    positiveNumber(item.price_info?.sale_price ?? item.price),
  ].filter((value): value is number => value !== undefined);
  return values.length ? Math.min(...values) : 0.01;
}

function conservativeWeight(detail?: TmapiItemDetail): { weightKg: number; estimated: boolean } {
  const skuWeights = (detail?.skus ?? []).map((sku) => positiveNumber(sku.package_info?.weight)).filter((value): value is number => value !== undefined);
  const itemWeight = positiveNumber(detail?.delivery_info?.unit_weight);
  const weight = skuWeights.length ? Math.max(...skuWeights) : itemWeight;
  return weight ? { weightKg: weight, estimated: false } : { weightKg: DEFAULT_WEIGHT_KG, estimated: true };
}

function candidateFrom(
  item: TmapiImageSearchItem,
  detail: TmapiItemDetail | undefined,
  score: number,
): SourcingCandidate {
  const purchasePriceCny = minimumPurchasePrice(item, detail);
  const weight = conservativeWeight(detail);
  const reportedShipping = detail?.delivery_info?.delivery_fee;
  const hasShipping = typeof reportedShipping === "number" && reportedShipping >= 0;
  const domesticShippingCny = hasShipping ? reportedShipping : 0;
  // 到岸成本只算采购价 + 国内运费：跨境物流、平台佣金和税项随站点与类目变化，
  // 在定价环节才确定，这里不预估，免得候选表里的数字被当成到手利润。
  const landedCostCny = purchasePriceCny + domesticShippingCny;
  const itemId = String(item.item_id);
  const warnings = [
    ...(weight.estimated ? ["重量未返回，暂按 0.5kg 估算"] : []),
    ...(!detail ? ["商品详情读取失败，暂用搜索结果估算"] : []),
    ...(detail?.is_sold_out ? ["商品已售罄"] : []),
    ...(hasShipping ? [] : ["国内运费未返回，到岸成本暂未计入"]),
  ];
  return {
    itemId,
    productUrl: item.product_url ?? `https://detail.1688.com/offer/${itemId}.html`,
    title: detail?.title ?? item.title ?? `1688 商品 ${itemId}`,
    imageUrl: item.img ?? detail?.main_imgs?.[0] ?? "",
    supplierName: item.shop_info?.company_name ?? item.shop_info?.login_id ?? detail?.shop_info?.shop_name ?? "供应商未返回",
    supplierLocation: (item.shop_info?.location ?? item.delivery_info?.area_from ?? []).filter(Boolean).join(" ") || detail?.delivery_info?.location || "--",
    supplierType: item.shop_info?.is_factory ? "生产工厂" : item.shop_info?.biz_type || "批发商",
    shopYears: positiveNumber(item.shop_info?.shop_years),
    supplierScore: supplierScore(item),
    recommendationScore: score,
    purchasePriceCny,
    minimumOrderQuantity: positiveNumber(item.moq) ?? positiveNumber(item.quantity_begin) ?? 1,
    salesCount: saleCount(item),
    ordersCount: item.sale_info?.orders_count ?? 0,
    repurchaseRate: repurchaseRate(item),
    stock: detail?.stock ?? undefined,
    weightKg: weight.weightKg,
    weightEstimated: weight.estimated,
    domesticShippingCny,
    landedCostCny,
    tags: [
      ...(item.shop_info?.is_factory ? ["工厂"] : []),
      ...(item.shop_info?.is_super_factory ? ["超级工厂"] : []),
      ...(item.tags ?? []),
    ].slice(0, 4),
    warnings,
  };
}

export async function runSourcingSearch(intent: SourcingIntent): Promise<SourcingSearchResult> {
  if (!intent.image && !intent.imageUrl) {
    return { content: "请上传一张产品图片，或在消息中粘贴一个公开图片链接。我会搜索1688同款并自动对比成本。" };
  }
  let publicImageUrl = intent.imageUrl ?? "";
  let searchImageUrl: string | undefined;
  if (intent.image) {
    const errors: string[] = [];
    for (const provider of temporaryUploadProviders()) {
      for (let attempt = 0; attempt < provider.attempts; attempt += 1) {
        try {
          publicImageUrl = await uploadTemporaryImage(intent.image, provider);
          searchImageUrl = await convertTmapiImageUrl(publicImageUrl);
          break;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "图片通道失败");
        }
      }
      if (searchImageUrl) break;
    }
    if (!searchImageUrl) {
      const lastError = errors.at(-1) ?? "图片转链失败";
      throw new Error(`1688 货源无法读取临时图片。系统已自动切换图片通道，最后一次失败原因：${lastError}`);
    }
  } else {
    searchImageUrl = isAlibabaImage(publicImageUrl) ? publicImageUrl : await convertTmapiImageUrl(publicImageUrl);
  }
  const search = await searchTmapiItemsByImage(searchImageUrl, {
    pageSize: 12,
    sort: intent.sort,
    priceEnd: intent.maxPurchasePriceCny,
    supportDropshipping: intent.supportDropshipping,
    factoryOnly: intent.factoryOnly || undefined,
    verifiedSupplier: intent.verifiedSupplier || undefined,
  });
  const filtered = search.items.filter((item) => !intent.minimumSales || saleCount(item) >= intent.minimumSales);
  const scored = filtered.map((item, index) => ({ item, score: recommendationScore(item, index, filtered.length) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, CANDIDATE_LIMIT);
  const details = await Promise.allSettled(scored.map(({ item }) => getTmapiItemDetailById(String(item.item_id), { scene: "drop_shipping", language: "zh" })));
  const candidates = scored.map(({ item, score }, index) => candidateFrom(
    item,
    details[index].status === "fulfilled" ? details[index].value : undefined,
    score,
  ));
  const totalCount = intent.minimumSales ? filtered.length : search.total_count ?? filtered.length;
  const costNote = "到岸成本只含采购价和国内运费；跨境物流、平台佣金与税项随站点和类目变化，需要定价时单独计算。";
  if (!candidates.length) {
    return { content: `已完成图片搜索，但当前筛选条件没有匹配商品。${intent.factoryOnly ? "可以取消“只看工厂”后再试。" : "可以换一张主体更清晰的图片。"}` };
  }
  return {
    content: `已完成1688以图搜和货源初选，从 ${search.total_count ?? candidates.length} 个结果中补全了 ${candidates.length} 个候选商品的供应商、SKU价格、重量和国内运费。${costNote}`,
    artifact: {
      kind: "sourcing_candidates",
      headline: "1688 同款货源候选",
      summary: `已对比 ${candidates.length} 个候选的采购价、起订量、销量与供应商资质`,
      queryImageUrl: intent.image?.dataUrl ?? publicImageUrl,
      totalCount,
      candidates,
      costNote,
      source: "1688 货源图片搜索·商品详情·采购价与供应商对比",
    },
  };
}

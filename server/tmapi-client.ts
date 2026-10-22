import { z } from "zod";
import { Agent } from "undici";
import { getTmapiRuntimeConfig } from "./runtime-config.ts";

const packageInfoSchema = z.object({
  weight: z.number().nullable().optional(),
  length: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
}).passthrough();

const skuSchema = z.object({
  skuid: z.union([z.string(), z.number()]).optional(),
  sale_price: z.union([z.string(), z.number()]).nullable().optional(),
  origin_price: z.union([z.string(), z.number()]).nullable().optional(),
  stock: z.number().nullable().optional(),
  props_names: z.string().optional(),
  sale_count: z.number().nullable().optional(),
  package_info: packageInfoSchema.nullable().optional(),
}).passthrough();

const itemDetailSchema = z.object({
  item_id: z.union([z.string(), z.number()]),
  product_url: z.string().optional(),
  title: z.string().optional(),
  category_id: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  offer_unit: z.string().optional(),
  product_props: z.array(z.record(z.string(), z.unknown())).optional(),
  main_imgs: z.array(z.string()).optional(),
  video_url: z.string().nullable().optional(),
  detail_url: z.string().nullable().optional(),
  sale_count: z.union([z.string(), z.number()]).nullable().optional(),
  sale_info: z.object({ sale_quantity_90days: z.number().nullable().optional() }).passthrough().optional(),
  price_info: z.object({
    price: z.union([z.string(), z.number()]).nullable().optional(),
    price_min: z.union([z.string(), z.number()]).nullable().optional(),
    price_max: z.union([z.string(), z.number()]).nullable().optional(),
  }).passthrough().optional(),
  tiered_price_info: z.object({
    begin_num: z.number().nullable().optional(),
    prices: z.array(z.object({
      beginAmount: z.union([z.string(), z.number()]),
      price: z.union([z.string(), z.number()]),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  shop_info: z.object({
    shop_name: z.string().optional(),
    shop_url: z.string().optional(),
    seller_login_id: z.string().optional(),
    seller_user_id: z.union([z.string(), z.number()]).optional(),
    seller_member_id: z.string().optional(),
  }).passthrough().optional(),
  delivery_info: z.object({
    location: z.string().optional(),
    delivery_fee: z.number().nullable().optional(),
    unit_weight: z.number().nullable().optional(),
  }).passthrough().optional(),
  service_tags: z.array(z.string()).optional(),
  sku_props: z.array(z.unknown()).optional(),
  skus: z.array(skuSchema).optional(),
  is_sold_out: z.boolean().optional(),
  stock: z.number().nullable().optional(),
  promotions: z.array(z.unknown()).optional(),
}).passthrough();

const responseSchema = z.object({
  code: z.union([z.string(), z.number()]),
  msg: z.string().optional(),
  message: z.string().optional(),
  data: z.unknown(),
}).passthrough();

const imageSearchItemSchema = z.object({
  item_id: z.union([z.string(), z.number()]),
  product_url: z.string().optional(),
  title: z.string().optional(),
  img: z.string().optional(),
  category_path: z.array(z.union([z.string(), z.number()])).optional(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  price_info: z.object({
    sale_price: z.union([z.string(), z.number()]).nullable().optional(),
    origin_price: z.union([z.string(), z.number()]).nullable().optional(),
  }).passthrough().optional(),
  moq: z.union([z.string(), z.number()]).nullable().optional(),
  quantity_begin: z.union([z.string(), z.number()]).nullable().optional(),
  sale_info: z.object({
    sale_quantity: z.union([z.string(), z.number()]).nullable().optional(),
    sale_quantity_int: z.number().nullable().optional(),
    orders_count: z.number().nullable().optional(),
  }).passthrough().optional(),
  delivery_info: z.object({ area_from: z.array(z.string()).optional() }).passthrough().optional(),
  item_repurchase_rate: z.string().nullable().optional(),
  goods_score: z.union([z.string(), z.number()]).nullable().optional(),
  rating_star: z.union([z.string(), z.number()]).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  shop_info: z.object({
    login_id: z.string().optional(),
    member_id: z.string().optional(),
    company_name: z.string().optional(),
    shop_url: z.string().optional(),
    biz_type: z.string().optional(),
    is_factory: z.boolean().optional(),
    is_super_factory: z.boolean().optional(),
    location: z.array(z.string()).optional(),
    shop_years: z.union([z.string(), z.number()]).nullable().optional(),
    factory_inspection: z.boolean().optional(),
    score_info: z.object({ composite_new_score: z.union([z.string(), z.number()]).nullable().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  is_ad: z.boolean().optional(),
}).passthrough();

const imageSearchResultSchema = z.object({
  page: z.number().optional(),
  page_size: z.number().optional(),
  has_next_page: z.boolean().optional(),
  total_count: z.number().optional(),
  items: z.array(imageSearchItemSchema).default([]),
}).passthrough();

const convertedImageSchema = z.union([
  z.string(),
  z.object({
    url: z.string().optional(),
    img_url: z.string().optional(),
    image_url: z.string().optional(),
  }).passthrough(),
]);

export type TmapiItemDetail = z.infer<typeof itemDetailSchema>;
export type TmapiImageSearchItem = z.infer<typeof imageSearchItemSchema>;
export type TmapiImageSearchResult = z.infer<typeof imageSearchResultSchema>;
export type TmapiLanguage = "en" | "zh" | "ru" | "th" | "pt" | "es" | "tr" | "vi" | "ja" | "ko";

export interface TmapiItemDetailOptions {
  scene?: "drop_shipping";
  optimizeTitle?: boolean;
  language?: TmapiLanguage;
}

export interface TmapiImageSearchOptions {
  page?: number;
  pageSize?: number;
  sort?: "default" | "sales" | "price_up" | "price_down";
  priceStart?: number;
  priceEnd?: number;
  supportDropshipping?: boolean;
  factoryOnly?: boolean;
  verifiedSupplier?: boolean;
  freeShipping?: boolean;
  newArrival?: boolean;
}

export interface TmapiKeywordSearchOptions {
  page?: number;
  pageSize?: number;
  sort?: "default" | "sales" | "price_up" | "price_down";
  moq?: number;
  priceStart?: number;
  priceEnd?: number;
  newArrival?: boolean;
  supportDropshipping?: boolean;
  freeShipping?: boolean;
  superFactoryOnly?: boolean;
}

export class TmapiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "TmapiError";
  }
}

const detailCache = new Map<string, { expiresAt: number; data: TmapiItemDetail }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const directHttpDispatcher = new Agent({ connect: { timeout: 20_000 } });

export function hasTmapiConfiguration(): boolean {
  return Boolean(getTmapiRuntimeConfig().apiToken);
}

export function clearTmapiCache(): void {
  detailCache.clear();
}

function errorMessage(status: number, fallback: string): string {
  const messages: Record<number, string> = {
    401: "1688 货源 Token 无效或未配置。",
    417: "1688 货源暂时无法读取这个商品，请稍后重试。",
    422: "1688 货源请求参数不正确。",
    439: "1688 货源套餐已过期或余额不足。",
    499: "1688 货源读取超时，请重试。",
    500: "1688 货源服务发生异常。",
    503: "1688 货源当前请求过多，请稍后重试。",
  };
  if (status === 422 && /invalid image url[,: ]+access failed/i.test(fallback)) {
    return "1688 货源无法访问临时图片链接，已返回图片读取失败。";
  }
  if (status === 422 && /not an image type/i.test(fallback)) {
    return "1688 货源读取到的临时链接不是图片文件。";
  }
  return messages[status] ?? fallback;
}

async function tmapiRequest<S extends z.ZodTypeAny>(path: string, init: RequestInit, query: URLSearchParams, dataSchema: S): Promise<z.output<S>> {
  const { apiToken, baseUrl } = getTmapiRuntimeConfig();
  if (!apiToken) throw new TmapiError("1688 货源数据 API 尚未配置。");

  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  // 1688 货源数据接口鉴权走 `apikey` 请求头，不是 query 参数 `apiToken`。
  // 实测把 token 放 query 会返回 401 {"code":4013,"message":"unauthorized"}，
  // 放 header 才返回 200。参数名用 snake_case（item_id），与官方一致。
  url.search = query.toString();

  let response: Response;
  try {
    // 1688 货源数据接口目前使用 HTTP。macOS 系统代理可能把它错误转发到 HTTPS 端口，
    // 因此只对该 HTTP 请求使用直连；其他外部服务仍沿用全局代理配置。
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        apikey: apiToken,
      },
      signal: AbortSignal.timeout(65_000),
      ...(url.protocol === "http:" ? { dispatcher: directHttpDispatcher } : {}),
    } as RequestInit & { dispatcher?: Agent });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TmapiError("1688 货源读取超时，请重试。", 499);
    }
    throw new TmapiError(`无法连接 1688 货源数据服务：${error instanceof Error ? error.message : "未知错误"}`);
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TmapiError("1688 货源返回了无法识别的数据。", response.status);
  }

  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const requestId = typeof record.request_id === "string" ? record.request_id : undefined;
  const remoteMessage = typeof record.message === "string"
    ? record.message
    : typeof record.msg === "string" ? record.msg : `1688 货源请求失败 (${response.status})`;
  if (!response.ok) throw new TmapiError(errorMessage(response.status, remoteMessage), response.status, requestId);

  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success || Number(parsed.data.code) !== 200) {
    const businessCode = parsed.success ? Number(parsed.data.code) : response.status;
    throw new TmapiError(errorMessage(businessCode, remoteMessage), businessCode, requestId);
  }
  const data = dataSchema.safeParse(parsed.data.data);
  if (!data.success) throw new TmapiError("1688 货源返回的数据结构已变化，请更新接口适配。", 502, requestId);
  return data.data;
}

function cacheKey(itemId: string, options: TmapiItemDetailOptions): string {
  return JSON.stringify([itemId, options.scene ?? "", options.optimizeTitle ?? false, options.language ?? "zh"]);
}

export async function getTmapiItemDetailById(
  itemId: string,
  options: TmapiItemDetailOptions = {},
): Promise<TmapiItemDetail> {
  if (!/^\d{6,20}$/.test(itemId)) throw new TmapiError("1688 商品 ID 格式不正确。", 422);
  const key = cacheKey(itemId, options);
  const cached = detailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const query = new URLSearchParams({ item_id: itemId });
  if (options.scene) query.set("scene", options.scene);
  if (options.optimizeTitle !== undefined) query.set("optimize_title", String(options.optimizeTitle));
  if (options.language) query.set("language", options.language);
  const data = await tmapiRequest("1688/item_detail", { method: "GET" }, query, itemDetailSchema);
  detailCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data });
  return data;
}

export async function getTmapiItemDetailByUrl(
  productUrl: string,
  options: TmapiItemDetailOptions = {},
): Promise<TmapiItemDetail> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    throw new TmapiError("1688 商品链接格式不正确。", 422);
  }
  if (!/(^|\.)1688\.com$/i.test(parsedUrl.hostname)) throw new TmapiError("请提供 1688 商品链接。", 422);

  const body = {
    url: productUrl,
    ...(options.scene ? { scene: options.scene } : {}),
    ...(options.optimizeTitle !== undefined ? { optimize_title: options.optimizeTitle } : {}),
    ...(options.language ? { language: options.language } : {}),
  };
  return tmapiRequest("1688/item_detail_by_url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, new URLSearchParams(), itemDetailSchema);
}

export async function convertTmapiImageUrl(imageUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new TmapiError("图片链接格式不正确。", 422);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TmapiError("图片链接必须使用 HTTP 或 HTTPS。", 422);
  const data = await tmapiRequest("1688/tools/image/convert_url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: imageUrl, search_api_endpoint: "/search/image" }),
  }, new URLSearchParams(), convertedImageSchema);
  const converted = typeof data === "string" ? data : data.url ?? data.img_url ?? data.image_url;
  if (!converted) throw new TmapiError("1688 货源没有返回可用的图片搜索地址。", 502);
  return converted;
}

export async function searchTmapiItemsByImage(
  imageUrl: string,
  options: TmapiImageSearchOptions = {},
): Promise<TmapiImageSearchResult> {
  if (!imageUrl.trim()) throw new TmapiError("请提供搜索图片。", 422);
  const query = new URLSearchParams({
    img_url: imageUrl,
    page: String(options.page ?? 1),
    page_size: String(Math.min(20, Math.max(1, options.pageSize ?? 12))),
    sort: options.sort ?? "default",
  });
  if (options.priceStart !== undefined) query.set("price_start", String(options.priceStart));
  if (options.priceEnd !== undefined) query.set("price_end", String(options.priceEnd));
  if (options.supportDropshipping !== undefined) query.set("support_dropshipping", String(options.supportDropshipping));
  if (options.factoryOnly !== undefined) query.set("is_factory", String(options.factoryOnly));
  if (options.verifiedSupplier !== undefined) query.set("verified_supplier", String(options.verifiedSupplier));
  if (options.freeShipping !== undefined) query.set("free_shipping", String(options.freeShipping));
  if (options.newArrival !== undefined) query.set("new_arrival", String(options.newArrival));
  return tmapiRequest("1688/search/image", { method: "GET" }, query, imageSearchResultSchema);
}

/**
 * 1688 关键词搜索货源（1688 货源 /1688/search/items）。
 * 响应 items[] 与图搜结构一致（复用 imageSearchItemSchema），可直接接采集。
 */
export async function searchTmapiItemsByKeyword(
  keyword: string,
  options: TmapiKeywordSearchOptions = {},
): Promise<TmapiImageSearchResult> {
  const trimmed = keyword.trim();
  if (!trimmed) throw new TmapiError("请提供搜索关键词。", 422);
  const query = new URLSearchParams({
    keyword: trimmed,
    page: String(options.page ?? 1),
    page_size: String(Math.min(20, Math.max(1, options.pageSize ?? 12))),
    sort: options.sort ?? "default",
  });
  if (options.moq !== undefined) query.set("moq", String(options.moq));
  if (options.priceStart !== undefined) query.set("price_start", String(options.priceStart));
  if (options.priceEnd !== undefined) query.set("price_end", String(options.priceEnd));
  if (options.newArrival !== undefined) query.set("new_arrival", String(options.newArrival));
  if (options.supportDropshipping !== undefined) query.set("support_dropshipping", String(options.supportDropshipping));
  if (options.freeShipping !== undefined) query.set("free_shipping", String(options.freeShipping));
  if (options.superFactoryOnly !== undefined) query.set("is_super_factory", String(options.superFactoryOnly));
  return tmapiRequest("1688/search/items", { method: "GET" }, query, imageSearchResultSchema);
}

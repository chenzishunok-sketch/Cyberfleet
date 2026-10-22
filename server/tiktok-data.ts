import { z } from "zod";
import type { DashboardSnapshot, Metric, ProductRow, SalesPoint, Trend } from "../shared/contracts.ts";
import { getAuthorizedTikTokClient, getTikTokConnectionStatus, readStoredAuthorization, type AuthorizedShop } from "./tiktok-auth.ts";
import type { TikTokShopClient } from "./tiktok-client.ts";

const skuSchema = z.object({
  id: z.string(),
  seller_sku: z.string().optional().default(""),
  sales_attributes: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    value_id: z.string().optional(),
    value_name: z.string().optional(),
  }).passthrough()).optional().default([]),
  inventory: z.array(z.object({ quantity: z.number(), warehouse_id: z.string().optional() }).passthrough()).optional().default([]),
  price: z.object({ currency: z.string().optional(), sale_price: z.string().optional() }).passthrough().optional(),
}).passthrough();

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  create_time: z.number().optional(),
  update_time: z.number().optional(),
  skus: z.array(skuSchema).optional().default([]),
}).passthrough();

const productSearchSchema = z.object({
  code: z.number(),
  data: z.object({
    next_page_token: z.string().optional().default(""),
    total_count: z.number().optional(),
    products: z.array(productSchema).optional().default([]),
  }).optional(),
}).passthrough();

const productDetailSchema = z.object({
  code: z.number(),
  data: productSchema.extend({
    main_images: z.array(z.object({
      thumb_urls: z.array(z.string()).optional().default([]),
      urls: z.array(z.string()).optional().default([]),
    }).passthrough()).optional().default([]),
    category_chains: z.array(z.object({
      id: z.string(),
      is_leaf: z.boolean().optional().default(false),
      local_name: z.string().optional().default(""),
      parent_id: z.string().optional(),
    }).passthrough()).optional().default([]),
  }).optional(),
}).passthrough();

const promotionActivitySchema = z.object({
  id: z.string().optional(),
  activity_id: z.string().optional(),
  status: z.string().optional().default(""),
  begin_time: z.union([z.string(), z.number()]).optional(),
  end_time: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const promotionSearchSchema = z.object({
  code: z.number(),
  data: z.object({ activities: z.array(promotionActivitySchema).optional().default([]) }).optional(),
}).passthrough();

const promotionDetailSchema = z.object({
  code: z.number(),
  data: promotionActivitySchema.extend({
    products: z.array(z.object({
      id: z.string(),
      skus: z.array(z.object({
        id: z.string(),
        activity_price: z.object({
          amount: z.union([z.string(), z.number()]).optional(),
          currency: z.string().optional(),
        }).passthrough().optional(),
      }).passthrough()).optional().default([]),
    }).passthrough()).optional().default([]),
  }).optional(),
}).passthrough();

const orderLineSchema = z.object({
  product_id: z.string().optional(),
  sku_id: z.string().optional(),
  seller_sku: z.string().optional(),
  product_name: z.string().optional(),
  sale_price: z.string().optional(),
  currency: z.string().optional(),
  quantity: z.number().optional(),
}).passthrough();

const orderSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  create_time: z.number().optional(),
  payment: z.object({ total_amount: z.string().optional(), currency: z.string().optional() }).passthrough().optional(),
  line_items: z.array(orderLineSchema).optional().default([]),
}).passthrough();

const orderSearchSchema = z.object({
  code: z.number(),
  data: z.object({
    next_page_token: z.string().optional().default(""),
    total_count: z.number().optional(),
    orders: z.array(orderSchema).optional().default([]),
  }).optional(),
}).passthrough();

const returnLineItemSchema = z.object({
  product_id: z.string().optional(),
  sku_id: z.string().optional(),
  seller_sku: z.string().optional(),
  return_reason: z.unknown().optional(),
  return_reason_text: z.string().optional(),
}).passthrough();

const returnOrderSchema = z.object({
  return_id: z.string().optional(),
  id: z.string().optional(),
  order_id: z.string().optional(),
  return_status: z.string().optional(),
  status: z.string().optional(),
  return_type: z.string().optional(),
  return_reason: z.unknown().optional(),
  return_reason_text: z.string().optional(),
  create_time: z.number().optional(),
  update_time: z.number().optional(),
  return_line_items: z.array(returnLineItemSchema).optional().default([]),
}).passthrough();

const returnSearchSchema = z.object({
  code: z.number(),
  data: z.object({
    next_page_token: z.string().optional().default(""),
    total_count: z.number().optional(),
    return_orders: z.array(returnOrderSchema).optional().default([]),
  }).optional(),
}).passthrough();

const inventorySearchSchema = z.object({
  code: z.number(),
  data: z.object({
    inventory: z.array(z.object({
      product_id: z.string(),
      skus: z.array(z.object({
        id: z.string(),
        seller_sku: z.string().optional(),
        total_available_quantity: z.number().optional().default(0),
        total_committed_quantity: z.number().optional().default(0),
      }).passthrough()).optional().default([]),
    }).passthrough()).optional().default([]),
  }).optional(),
}).passthrough();

const analyticsSalesSchema = z.object({
  orders_count: z.number().optional().default(0),
  items_sold: z.number().optional().default(0),
  gmv: z.object({
    overall: z.object({ amount: z.string().optional().default("0"), currency: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  refunds: z.object({ amount: z.string().optional().default("0"), currency: z.string().optional() }).passthrough().optional(),
}).passthrough();

const analyticsResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    latest_available_date: z.string().optional(),
    performance: z.object({
      intervals: z.array(z.object({
        start_date: z.string(),
        end_date: z.string(),
        sales: analyticsSalesSchema.optional().default({}),
      }).passthrough()).optional().default([]),
    }).optional(),
  }).optional(),
}).passthrough();

type TikTokProduct = z.output<typeof productSchema>;
type TikTokOrder = z.output<typeof orderSchema>;
type TikTokReturnOrder = z.output<typeof returnOrderSchema>;
type AnalyticsInterval = z.output<typeof analyticsResponseSchema>["data"] extends infer Data
  ? Data extends { performance?: infer Performance }
    ? Performance extends { intervals: infer Intervals }
      ? Intervals extends Array<infer Interval> ? Interval : never
      : never
    : never
  : never;

export interface TikTokSkuRow {
  productId: string;
  productTitle: string;
  productStatus: string;
  productImageUrl?: string;
  categoryId?: string;
  categoryName?: string;
  categoryPath?: string;
  skuId: string;
  skuName: string;
  sellerSku: string;
  activityPrice?: number;
  price?: number;
  currency: string;
  stock: number;
  committedStock: number;
  units: number;
  revenue: number;
}

interface TikTokReturnDetail {
  returnId: string;
  orderId: string;
  status: string;
  type: string;
  reason: string;
  reasonText: string;
  createTime?: number;
  updateTime?: number;
  productIds: string[];
  skuIds: string[];
  sellerSkus: string[];
}

interface TikTokPaginationStatus {
  complete: boolean;
  pages: number;
  reason?: "repeated_page_token" | "page_limit_reached" | "inconsistent_total" | "empty_page_with_token";
}

export interface TikTokOperationalData {
  dashboard: DashboardSnapshot;
  allProducts: ProductRow[];
  skuRows: TikTokSkuRow[];
  totalProducts: number;
  days: number;
  currentGmv: number;
  previousGmv: number;
  /** Paid orders returned by the Order API for the rolling current period. */
  currentOrders: number;
  /** Paid orders returned by the Order API for the equal rolling comparison period. */
  previousOrders: number;
  analyticsCurrentOrders: number;
  analyticsPreviousOrders: number;
  currentReturns: number;
  previousReturns: number;
  currentReturnDetails: TikTokReturnDetail[];
  previousReturnDetails: TikTokReturnDetail[];
  currentRefundAmount: number;
  previousRefundAmount: number;
  analyticsPeriod: { startDate: string; endDate: string; latestAvailableDate: string };
  pagination: {
    products: TikTokPaginationStatus;
    orders: TikTokPaginationStatus;
    currentOrders: TikTokPaginationStatus;
    previousOrders: TikTokPaginationStatus;
    currentReturns: TikTokPaginationStatus;
    previousReturns: TikTokPaginationStatus;
  };
  currency: string;
  shop: AuthorizedShop;
  source: string;
}

const regionMetadata: Record<string, { label: string; currency: string; timezone: string }> = {
  // 日本站是当前唯一的经营站点。时区必须准确：这里的 timezone 会用于
  // 「最近 N 天」的日界锚定，回落 UTC 会让每天的数据窗口偏移 9 小时。
  JP: { label: "日本", currency: "JPY", timezone: "Asia/Tokyo" },
  US: { label: "美国", currency: "USD", timezone: "America/Los_Angeles" },
  GB: { label: "英国", currency: "GBP", timezone: "Europe/London" },
  SG: { label: "新加坡", currency: "SGD", timezone: "Asia/Singapore" },
  MY: { label: "马来西亚", currency: "MYR", timezone: "Asia/Kuala_Lumpur" },
  PH: { label: "菲律宾", currency: "PHP", timezone: "Asia/Manila" },
  VN: { label: "越南", currency: "VND", timezone: "Asia/Ho_Chi_Minh" },
  ID: { label: "印度尼西亚", currency: "IDR", timezone: "Asia/Jakarta" },
};

const cache = new Map<string, { expiresAt: number; promise: Promise<TikTokOperationalData> }>();
const MAX_PAGINATION_PAGES = 1_000;

// 商品详情（主图/类目/SKU 规格名）短期不会变，但接口是逐个商品查的：
// 一家 104 个商品的店，一次汇总就要打 104 次，是整体耗时里最大的一块。
// 缓存后同一批商品在 TTL 内不再重复请求。
const PRODUCT_METADATA_TTL_MS = Math.max(0, Number(process.env.TIKTOK_PRODUCT_META_TTL_MS ?? "") || 10 * 60 * 1000);
const MAX_PRODUCT_METADATA_ENTRIES = 10_000;
// 商品详情这类逐项查询的并发上限。TikTok 对单店铺 QPS 有限制，默认 8 是稳妥值。
const API_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.TIKTOK_API_CONCURRENCY ?? "") || 8));
const productMetadataCache = new Map<string, { value: ProductMetadata; expiresAt: number }>();

function readProductMetadataCache(productId: string): ProductMetadata | undefined {
  const hit = productMetadataCache.get(productId);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    productMetadataCache.delete(productId);
    return undefined;
  }
  return hit.value;
}

function writeProductMetadataCache(productId: string, value: ProductMetadata): void {
  if (PRODUCT_METADATA_TTL_MS <= 0) return;
  if (productMetadataCache.size >= MAX_PRODUCT_METADATA_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of productMetadataCache) {
      if (entry.expiresAt <= now) productMetadataCache.delete(key);
    }
    if (productMetadataCache.size >= MAX_PRODUCT_METADATA_ENTRIES) productMetadataCache.clear();
  }
  productMetadataCache.set(productId, { value, expiresAt: Date.now() + PRODUCT_METADATA_TTL_MS });
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  pagination: TikTokPaginationStatus;
}

interface InventorySkuSnapshot {
  id: string;
  sellerSku: string;
  available: number;
  committed: number;
}

interface ProductMetadata {
  image: string;
  categoryId?: string;
  categoryName?: string;
  categoryPath?: string;
  skuNames?: Map<string, string>;
}

type InventoryByProduct = Map<string, Map<string, InventorySkuSnapshot>>;

function parseResponse<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown, label: string): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`TikTok Shop ${label}返回的数据格式不完整。`);
  return parsed.data;
}

async function searchProducts(client: TikTokShopClient): Promise<{ products: TikTokProduct[]; total: number; pagination: TikTokPaginationStatus }> {
  const products: TikTokProduct[] = [];
  let pageToken = "";
  let total = 0;
  let pages = 0;
  const seenTokens = new Set<string>();

  while (pages < MAX_PAGINATION_PAGES) {
    const response = await client.request<unknown>("/product/202502/products/search", {
      retry: 2,
      method: "POST",
      query: { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
      body: { status: "ACTIVATE" },
    });
    const payload = parseResponse(productSearchSchema, response, "商品列表");
    const batch = payload.data?.products ?? [];
    products.push(...batch);
    total = payload.data?.total_count ?? products.length;
    pages += 1;
    const nextPageToken = payload.data?.next_page_token ?? "";
    if (!nextPageToken) {
      const complete = products.length >= total;
      return { products, total, pagination: { complete, pages, ...(!complete ? { reason: "inconsistent_total" as const } : {}) } };
    }
    if (batch.length === 0) {
      return { products, total, pagination: { complete: false, pages, reason: "empty_page_with_token" } };
    }
    if (seenTokens.has(nextPageToken)) {
      return { products, total, pagination: { complete: false, pages, reason: "repeated_page_token" } };
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return { products, total, pagination: { complete: false, pages, reason: "page_limit_reached" } };
}

async function searchOrders(client: TikTokShopClient, start: number, end: number): Promise<PaginatedResult<TikTokOrder>> {
  const orders: TikTokOrder[] = [];
  let pageToken = "";
  let total = 0;
  let pages = 0;
  const seenTokens = new Set<string>();

  while (pages < MAX_PAGINATION_PAGES) {
    const response = await client.request<unknown>("/order/202309/orders/search", {
      retry: 2,
      method: "POST",
      query: { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
      body: { create_time_ge: start, create_time_lt: end },
    });
    const payload = parseResponse(orderSearchSchema, response, "订单列表");
    const batch = payload.data?.orders ?? [];
    orders.push(...batch);
    total = payload.data?.total_count ?? orders.length;
    pages += 1;
    const nextPageToken = payload.data?.next_page_token ?? "";
    if (!nextPageToken) {
      const complete = orders.length >= total;
      return { items: orders, total, pagination: { complete, pages, ...(!complete ? { reason: "inconsistent_total" as const } : {}) } };
    }
    if (batch.length === 0) {
      return { items: orders, total, pagination: { complete: false, pages, reason: "empty_page_with_token" } };
    }
    if (seenTokens.has(nextPageToken)) {
      return { items: orders, total, pagination: { complete: false, pages, reason: "repeated_page_token" } };
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return { items: orders, total, pagination: { complete: false, pages, reason: "page_limit_reached" } };
}

async function searchReturns(client: TikTokShopClient, start: number, end: number): Promise<PaginatedResult<TikTokReturnOrder>> {
  const returns: TikTokReturnOrder[] = [];
  let pageToken = "";
  let total = 0;
  let pages = 0;
  const seenTokens = new Set<string>();

  while (pages < MAX_PAGINATION_PAGES) {
    const response = await client.request<unknown>("/return_refund/202309/returns/search", {
      retry: 2,
      method: "POST",
      query: { page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) },
      body: { create_time_ge: start, create_time_lt: end },
    });
    const payload = parseResponse(returnSearchSchema, response, "退货退款列表");
    const batch = payload.data?.return_orders ?? [];
    returns.push(...batch);
    total = payload.data?.total_count ?? returns.length;
    pages += 1;
    const nextPageToken = payload.data?.next_page_token ?? "";
    if (!nextPageToken) {
      const complete = returns.length >= total;
      return { items: returns, total, pagination: { complete, pages, ...(!complete ? { reason: "inconsistent_total" as const } : {}) } };
    }
    if (batch.length === 0) {
      return { items: returns, total, pagination: { complete: false, pages, reason: "empty_page_with_token" } };
    }
    if (seenTokens.has(nextPageToken)) {
      return { items: returns, total, pagination: { complete: false, pages, reason: "repeated_page_token" } };
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return { items: returns, total, pagination: { complete: false, pages, reason: "page_limit_reached" } };
}

async function searchInventory(client: TikTokShopClient, productIds: string[]): Promise<InventoryByProduct> {
  const inventory = new Map<string, Map<string, InventorySkuSnapshot>>();
  for (let index = 0; index < productIds.length; index += 100) {
    const batch = productIds.slice(index, index + 100);
    if (!batch.length) continue;
    const response = await client.request<unknown>("/product/202309/inventory/search", {
      method: "POST",
      retry: 2,
      body: { product_ids: batch },
    });
    const payload = parseResponse(inventorySearchSchema, response, "库存列表");
    for (const product of payload.data?.inventory ?? []) {
      inventory.set(product.product_id, new Map(product.skus.map((sku) => [sku.id, {
        id: sku.id,
        sellerSku: sku.seller_sku ?? "",
        available: sku.total_available_quantity,
        committed: sku.total_committed_quantity,
      }])));
    }
  }
  return inventory;
}

async function getShopPerformance(client: TikTokShopClient, startDate: string, endDate: string): Promise<{ intervals: AnalyticsInterval[]; latestAvailableDate?: string }> {
  const response = await client.request<unknown>("/analytics/202509/shop/performance", {
    query: { start_date_ge: startDate, end_date_lt: endDate, granularity: "1D", currency: "LOCAL" },
    retry: 2,
  });
  const payload = parseResponse(analyticsResponseSchema, response, "店铺经营指标");
  return {
    intervals: (payload.data?.performance?.intervals ?? []) as AnalyticsInterval[],
    latestAvailableDate: payload.data?.latest_available_date,
  };
}

interface AnchoredAnalytics {
  intervals: AnalyticsInterval[];
  latestAvailableDate: string;
  currentStartDate: string;
  previousStartDate: string;
  endDateExclusive: string;
}

function shiftDateKey(value: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`TikTok Shop Analytics 返回了无效日期：${value || "空值"}。`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

async function getAnchoredShopPerformance(client: TikTokShopClient, days: number, now: number, timezone: string): Promise<AnchoredAnalytics> {
  const today = dateKey(now, timezone);
  const probeStartDate = shiftDateKey(today, -(days * 2 - 1));
  const probeEndDateExclusive = shiftDateKey(today, 1);
  const probe = await getShopPerformance(client, probeStartDate, probeEndDateExclusive);
  if (!probe.latestAvailableDate) {
    throw new Error("TikTok Shop Analytics 未返回 latest_available_date，无法确认真实数据截止日期。");
  }

  const latestAvailableDate = shiftDateKey(probe.latestAvailableDate, 0);
  const currentStartDate = shiftDateKey(latestAvailableDate, -(days - 1));
  const previousStartDate = shiftDateKey(latestAvailableDate, -(days * 2 - 1));
  const endDateExclusive = shiftDateKey(latestAvailableDate, 1);
  const probeCoversPeriod = probeStartDate <= previousStartDate && probeEndDateExclusive >= endDateExclusive;
  const exact = probeCoversPeriod
    ? probe
    : await getShopPerformance(client, previousStartDate, endDateExclusive);

  return {
    intervals: exact.intervals.filter((interval) => interval.start_date >= previousStartDate && interval.start_date < endDateExclusive),
    latestAvailableDate,
    currentStartDate,
    previousStartDate,
    endDateExclusive,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadProductMetadata(client: TikTokShopClient, products: TikTokProduct[]): Promise<Map<string, ProductMetadata>> {
  const result = new Map<string, ProductMetadata>();
  const missing: TikTokProduct[] = [];
  for (const product of products) {
    const cached = readProductMetadataCache(product.id);
    if (cached) result.set(product.id, cached);
    else missing.push(product);
  }
  if (!missing.length) return result;

  const entries = await mapWithConcurrency(missing, API_CONCURRENCY, async (product): Promise<[string, ProductMetadata]> => {
    try {
      const response = await client.request<unknown>(`/product/202309/products/${product.id}`, { retry: 2 });
      const detail = parseResponse(productDetailSchema, response, "商品详情").data;
      const image = detail?.main_images?.[0]?.thumb_urls?.[0] ?? detail?.main_images?.[0]?.urls?.[0] ?? "";
      const chains = detail?.category_chains ?? [];
      const leaf = chains.find((category) => category.is_leaf) ?? chains.at(-1);
      const skuNames = new Map((detail?.skus ?? []).flatMap((sku) => {
        const name = sku.sales_attributes.map((attribute) => attribute.value_name?.trim()).filter(Boolean).join(" / ");
        return name ? [[sku.id, name] as const] : [];
      }));
      return [product.id, {
        image,
        categoryId: leaf?.id,
        categoryName: leaf?.local_name || undefined,
        categoryPath: chains.map((category) => category.local_name).filter(Boolean).join(" > ") || undefined,
        skuNames,
      }];
    } catch {
      // 单个商品失败不写缓存：否则一次网络抖动会把空图钉住整个 TTL
      return [product.id, { image: "" }];
    }
  });
  for (const [productId, value] of entries) {
    if (value.image || value.categoryId || value.categoryName || value.skuNames?.size) {
      writeProductMetadataCache(productId, value);
    }
    result.set(productId, value);
  }
  return result;
}

function currentPromotion(activity: z.output<typeof promotionActivitySchema>, now: number): boolean {
  const status = activity.status.toUpperCase();
  if (["ENDED", "EXPIRED", "DEACTIVATED", "CANCELLED", "CANCELED", "NOT_START"].includes(status)) return false;
  const begin = Number(activity.begin_time ?? 0);
  const end = Number(activity.end_time ?? 0);
  return (!begin || begin <= now) && (!end || end >= now);
}

async function loadActiveActivityPrices(client: TikTokShopClient): Promise<Map<string, number>> {
  try {
    const search = await client.request<unknown>("/promotion/202309/activities/search", {
      method: "POST",
      retry: 2,
      body: { page_size: 50 },
    });
    const now = Math.floor(Date.now() / 1000);
    const activities = (parseResponse(promotionSearchSchema, search, "促销活动列表").data?.activities ?? [])
      .filter((activity) => currentPromotion(activity, now));
    const details = await mapWithConcurrency(activities, API_CONCURRENCY, async (activity) => {
      const activityId = activity.id ?? activity.activity_id;
      if (!activityId) return undefined;
      const response = await client.request<unknown>(`/promotion/202309/activities/${encodeURIComponent(activityId)}`, { retry: 2 });
      return parseResponse(promotionDetailSchema, response, "促销活动详情").data;
    });
    const prices = new Map<string, number>();
    for (const detail of details) {
      for (const product of detail?.products ?? []) {
        for (const sku of product.skus) {
          const amount = Number(sku.activity_price?.amount);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          const current = prices.get(sku.id);
          if (current === undefined || amount < current) prices.set(sku.id, amount);
        }
      }
    }
    return prices;
  } catch {
    return new Map();
  }
}

function isPaidOrder(order: TikTokOrder): boolean {
  return !new Set(["UNPAID", "CANCELLED", "CANCELED"]).has(order.status ?? "");
}

function deltaMetric(current: number, previous: number): { delta: string; trend: Trend } {
  if (previous === 0 && current === 0) return { delta: "0%", trend: "flat" };
  if (previous === 0) return { delta: "新增", trend: "up" };
  const change = ((current - previous) / previous) * 100;
  return { delta: `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`, trend: change > 0 ? "up" : change < 0 ? "down" : "flat" };
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function dateKey(timestampSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestampSeconds * 1000));
}

function dateLabel(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return `${month}/${day}`;
}

function buildSeries(intervals: AnalyticsInterval[], days: number, currentStartDate: string): SalesPoint[] {
  const totals = new Map(intervals.map((interval) => [interval.start_date, {
    sales: Number(interval.sales.gmv?.overall?.amount ?? 0) || 0,
    orders: interval.sales.orders_count,
  }]));
  return Array.from({ length: days }, (_, index) => {
    const currentDate = shiftDateKey(currentStartDate, index);
    const previousDate = shiftDateKey(currentDate, -days);
    const current = totals.get(currentDate) ?? { sales: 0, orders: 0 };
    const previous = totals.get(previousDate) ?? { sales: 0, orders: 0 };
    return { date: dateLabel(currentDate), sales: current.sales, previous: previous.sales, orders: current.orders };
  });
}

function buildProductRows(products: TikTokProduct[], orders: TikTokOrder[], metadata: Map<string, ProductMetadata>, inventory: InventoryByProduct, activityPrices: Map<string, number>, days: number, currency: string): { productRows: ProductRow[]; skuRows: TikTokSkuRow[] } {
  const productSales = new Map<string, { units: number; revenue: number }>();
  const skuSales = new Map<string, { units: number; revenue: number }>();
  for (const order of orders.filter(isPaidOrder)) {
    for (const item of order.line_items) {
      if (!item.product_id) continue;
      const current = productSales.get(item.product_id) ?? { units: 0, revenue: 0 };
      const quantity = item.quantity ?? 1;
      current.units += quantity;
      current.revenue += Number(item.sale_price ?? 0) * quantity || 0;
      productSales.set(item.product_id, current);
      const skuKey = item.sku_id ? `id:${item.sku_id}` : item.seller_sku ? `seller:${item.seller_sku}` : "";
      if (skuKey) {
        const skuCurrent = skuSales.get(skuKey) ?? { units: 0, revenue: 0 };
        skuCurrent.units += quantity;
        skuCurrent.revenue += Number(item.sale_price ?? 0) * quantity || 0;
        skuSales.set(skuKey, skuCurrent);
      }
    }
  }

  const skuRows: TikTokSkuRow[] = [];
  const productRows = products.map((product) => {
    const productMetadata = metadata.get(product.id);
    const sales = productSales.get(product.id) ?? { units: 0, revenue: 0 };
    const productInventory = inventory.get(product.id);
    const stock = productInventory
      ? [...productInventory.values()].reduce((sum, sku) => sum + sku.available, 0)
      : product.skus.reduce((sum, sku) => sum + sku.inventory.reduce((skuSum, item) => skuSum + item.quantity, 0), 0);
    const dailyUnits = sales.units / Math.max(days, 1);
    const daysOfStock = dailyUnits > 0 ? Math.floor(stock / dailyUnits) : undefined;
    const status: ProductRow["status"] = stock <= 5 || (daysOfStock !== undefined && daysOfStock <= 3)
      ? "risk"
      : stock <= 20 || (daysOfStock !== undefined && daysOfStock <= 7)
        ? "low"
        : "healthy";
    for (const sku of product.skus) {
      const inventorySku = productInventory?.get(sku.id);
      const skuResult = skuSales.get(`id:${sku.id}`) ?? (sku.seller_sku ? skuSales.get(`seller:${sku.seller_sku}`) : undefined) ?? { units: 0, revenue: 0 };
      skuRows.push({
        productId: product.id,
        productTitle: product.title,
        productStatus: product.status,
        productImageUrl: productMetadata?.image,
        categoryId: productMetadata?.categoryId,
        categoryName: productMetadata?.categoryName,
        categoryPath: productMetadata?.categoryPath,
        skuId: sku.id,
        skuName: productMetadata?.skuNames?.get(sku.id) || sku.seller_sku || inventorySku?.sellerSku || sku.id,
        sellerSku: sku.seller_sku || inventorySku?.sellerSku || sku.id,
        activityPrice: activityPrices.get(sku.id),
        price: sku.price?.sale_price === undefined ? undefined : Number(sku.price.sale_price),
        currency: sku.price?.currency ?? currency,
        stock: inventorySku?.available ?? sku.inventory.reduce((sum, item) => sum + item.quantity, 0),
        committedStock: inventorySku?.committed ?? 0,
        units: skuResult.units,
        revenue: skuResult.revenue,
      });
    }
    const skuLabel = product.skus.length === 1
      ? product.skus[0].seller_sku || product.skus[0].id
      : `${product.skus.length} 个 SKU`;
    return {
      id: product.id,
      sku: skuLabel,
      title: product.title,
      image: productMetadata?.image ?? "",
      revenue: formatCurrency(sales.revenue, currency),
      units: sales.units,
      stock,
      daysOfStock,
      status,
    };
  });
  return { productRows, skuRows };
}

function reasonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["reason_text", "reason", "name", "code"]) {
    if (typeof object[key] === "string") return object[key];
  }
  return "";
}

function normalizeReturns(returns: TikTokReturnOrder[]): TikTokReturnDetail[] {
  return returns.map((item) => {
    const lineReason = item.return_line_items.map((line) => line.return_reason_text || reasonValue(line.return_reason)).find(Boolean) ?? "";
    return {
      returnId: item.return_id ?? item.id ?? "",
      orderId: item.order_id ?? "",
      status: item.return_status ?? item.status ?? "UNKNOWN",
      type: item.return_type ?? "",
      reason: reasonValue(item.return_reason) || lineReason,
      reasonText: item.return_reason_text || lineReason,
      createTime: item.create_time,
      updateTime: item.update_time,
      productIds: [...new Set(item.return_line_items.flatMap((line) => line.product_id ? [line.product_id] : []))],
      skuIds: [...new Set(item.return_line_items.flatMap((line) => line.sku_id ? [line.sku_id] : []))],
      sellerSkus: [...new Set(item.return_line_items.flatMap((line) => line.seller_sku ? [line.seller_sku] : []))],
    };
  });
}

function requireCompletePagination(label: string, pagination: TikTokPaginationStatus): void {
  if (pagination.complete) return;
  const reason = pagination.reason === "repeated_page_token"
    ? "API 重复返回同一个 next_page_token"
    : pagination.reason === "empty_page_with_token"
      ? "API 返回空分页但仍提供 next_page_token"
      : pagination.reason === "inconsistent_total"
        ? "API 返回的 total_count 大于实际分页条目数"
        : `已达到 ${MAX_PAGINATION_PAGES} 页安全上限`;
  throw new Error(`TikTok Shop ${label}分页未完整读取（${reason}），本次不展示可能不完整的数据。`);
}

function combinePagination(...statuses: TikTokPaginationStatus[]): TikTokPaginationStatus {
  const incomplete = statuses.find((status) => !status.complete);
  return {
    complete: !incomplete,
    pages: statuses.reduce((sum, status) => sum + status.pages, 0),
    ...(incomplete?.reason ? { reason: incomplete.reason } : {}),
  };
}

function selectedShop(authorization: Awaited<ReturnType<typeof readStoredAuthorization>>): AuthorizedShop {
  const shop = authorization?.shops.find((item) => item.cipher === authorization.selectedShopCipher);
  if (!shop) throw new Error("没有找到当前选择的 TikTok Shop 店铺，请重新授权或选择店铺。");
  return shop;
}

function emptyDashboard(name = "未连接 TikTok Shop", region = "--"): DashboardSnapshot {
  return {
    dataSource: "unavailable",
    store: { id: "not-connected", name, region, currency: "--", timezone: "--", connected: false },
    metrics: [],
    salesSeries: [],
    products: [],
    automations: [],
    activity: [],
    alerts: [{ id: "connect-shop", level: "info", text: "请先在设置中连接 TikTok Shop" }],
    dataAsOf: "尚未连接",
  };
}

async function fetchOperationalData(days: number): Promise<TikTokOperationalData> {
  const client = await getAuthorizedTikTokClient();
  if (!client) throw new Error("TikTok Shop 尚未连接。");
  const authorization = await readStoredAuthorization();
  const shop = selectedShop(authorization);
  const metadata = regionMetadata[shop.region] ?? { label: shop.region, currency: "JPY", timezone: "Asia/Tokyo" };
  const now = Math.floor(Date.now() / 1000);
  const currentStart = now - days * 86400;
  const previousStart = now - days * 2 * 86400;

  const [productResult, currentOrderResult, previousOrderResult, currentReturnResult, previousReturnResult, analytics] = await Promise.all([
    searchProducts(client),
    searchOrders(client, currentStart, now),
    searchOrders(client, previousStart, currentStart),
    searchReturns(client, currentStart, now),
    searchReturns(client, previousStart, currentStart),
    getAnchoredShopPerformance(client, days, now, metadata.timezone),
  ]);
  requireCompletePagination("商品", productResult.pagination);
  requireCompletePagination("本期订单", currentOrderResult.pagination);
  requireCompletePagination("上期订单", previousOrderResult.pagination);
  requireCompletePagination("本期退货退款", currentReturnResult.pagination);
  requireCompletePagination("上期退货退款", previousReturnResult.pagination);

  const { products, total } = productResult;
  const [productMetadata, inventory, activityPrices] = await Promise.all([
    loadProductMetadata(client, products),
    searchInventory(client, products.map((product) => product.id)),
    loadActiveActivityPrices(client),
  ]);
  const analyticsCurrency = analytics.intervals.find((interval) => interval.sales.gmv?.overall?.currency)?.sales.gmv?.overall?.currency;
  const currency = analyticsCurrency ?? products.flatMap((product) => product.skus).find((sku) => sku.price?.currency)?.price?.currency ?? metadata.currency;
  const currentPeriodOrders = currentOrderResult.items.filter(isPaidOrder);
  const previousPeriodOrders = previousOrderResult.items.filter(isPaidOrder);
  const currentIntervals = analytics.intervals.filter((interval) => interval.start_date >= analytics.currentStartDate && interval.start_date < analytics.endDateExclusive);
  const previousIntervals = analytics.intervals.filter((interval) => interval.start_date >= analytics.previousStartDate && interval.start_date < analytics.currentStartDate);
  const sumAnalytics = (intervals: AnalyticsInterval[]) => intervals.reduce((summary, interval) => ({
    gmv: summary.gmv + (Number(interval.sales.gmv?.overall?.amount ?? 0) || 0),
    orders: summary.orders + interval.sales.orders_count,
    refunds: summary.refunds + (Number(interval.sales.refunds?.amount ?? 0) || 0),
  }), { gmv: 0, orders: 0, refunds: 0 });
  const currentAnalytics = sumAnalytics(currentIntervals);
  const previousAnalytics = sumAnalytics(previousIntervals);
  const currentGmv = currentAnalytics.gmv;
  const previousGmv = previousAnalytics.gmv;
  const currentAverage = currentAnalytics.orders ? currentGmv / currentAnalytics.orders : 0;
  const previousAverage = previousAnalytics.orders ? previousGmv / previousAnalytics.orders : 0;
  const { productRows: allProducts, skuRows } = buildProductRows(products, currentPeriodOrders, productMetadata, inventory, activityPrices, days, currency);
  const currentOrders = currentPeriodOrders.length;
  const previousOrders = previousPeriodOrders.length;
  const currentReturns = currentReturnResult.total;
  const previousReturns = previousReturnResult.total;
  const gmvDelta = deltaMetric(currentGmv, previousGmv);
  const orderDelta = deltaMetric(currentOrders, previousOrders);
  const averageDelta = deltaMetric(currentAverage, previousAverage);
  const returnDelta = deltaMetric(currentReturns, previousReturns);
  const analyticsHelper = `${analytics.currentStartDate} 至 ${analytics.latestAvailableDate} · 较前 ${days} 天`;
  const orderHelper = `订单接口近 ${days} 天 · 较前 ${days} 天`;
  const returnHelper = `退货退款接口近 ${days} 天 · 较前 ${days} 天`;
  const metrics: Metric[] = [
    { label: "支付 GMV", value: formatCurrency(currentGmv, currency), ...gmvDelta, helper: analyticsHelper },
    { label: "订单数", value: currentOrders.toLocaleString("zh-CN"), ...orderDelta, helper: orderHelper },
    { label: "客单价", value: formatCurrency(currentAverage, currency), ...averageDelta, helper: analyticsHelper },
    { label: "退货退款申请", value: currentReturns.toLocaleString("zh-CN"), ...returnDelta, helper: returnHelper },
  ];
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    timeZone: metadata.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  const lowStockCount = allProducts.filter((product) => product.status !== "healthy").length;
  const alerts: DashboardSnapshot["alerts"] = [];
  if (lowStockCount) alerts.push({ id: "low-stock", level: "warning", text: `${lowStockCount} 个商品存在库存风险` });
  if (currentOrders === 0) alerts.push({ id: "no-orders", level: "info", text: `近 ${days} 天订单接口没有查询到已支付订单` });
  if (currentReturns) alerts.push({ id: "returns", level: "info", text: `近 ${days} 天有 ${currentReturns} 个退货退款申请` });
  const source = `TikTok Shop Open API · ${shop.name} (${shop.region}) · 订单/退货接口近 ${days} 天 · Analytics ${analytics.currentStartDate} 至 ${analytics.latestAvailableDate} · 读取于 ${timestamp}`;
  const dashboard: DashboardSnapshot = {
    dataSource: "tiktok",
    store: { id: shop.id, name: shop.name, region: metadata.label, currency, timezone: metadata.timezone, connected: true },
    metrics,
    salesSeries: buildSeries(analytics.intervals, days, analytics.currentStartDate),
    products: [...allProducts].sort((a, b) => a.stock - b.stock).slice(0, 4),
    automations: [],
    activity: [],
    alerts,
    dataAsOf: timestamp,
  };

  return {
    dashboard,
    allProducts,
    skuRows,
    totalProducts: total,
    days,
    currentGmv,
    previousGmv,
    currentOrders,
    previousOrders,
    analyticsCurrentOrders: currentAnalytics.orders,
    analyticsPreviousOrders: previousAnalytics.orders,
    currentReturns,
    previousReturns,
    currentReturnDetails: normalizeReturns(currentReturnResult.items),
    previousReturnDetails: normalizeReturns(previousReturnResult.items),
    currentRefundAmount: currentAnalytics.refunds,
    previousRefundAmount: previousAnalytics.refunds,
    analyticsPeriod: {
      startDate: analytics.currentStartDate,
      endDate: analytics.latestAvailableDate,
      latestAvailableDate: analytics.latestAvailableDate,
    },
    pagination: {
      products: productResult.pagination,
      orders: combinePagination(currentOrderResult.pagination, previousOrderResult.pagination),
      currentOrders: currentOrderResult.pagination,
      previousOrders: previousOrderResult.pagination,
      currentReturns: currentReturnResult.pagination,
      previousReturns: previousReturnResult.pagination,
    },
    currency,
    shop,
    source,
  };
}

// 整份经营快照的复用时长。
// 一次多步推理（ReAct）里模型会反复调用销售/订单/退款/GMV 这几个工具，
// 每个工具都落到同一份快照上。原来只有 30 秒，模型每走一步几乎都要重新拉一遍
// 全量数据（约 12 秒），一次对话因此能拖到 100 秒以上。
// 平台本身的数据就有 T+1 延迟，几分钟内复用不会让结论失真。
const SNAPSHOT_TTL_MS = Math.max(30_000, Number(process.env.TIKTOK_SNAPSHOT_TTL_MS ?? "") || 5 * 60 * 1000);

export async function getTikTokOperationalData(days = 7): Promise<TikTokOperationalData> {
  const authorization = await readStoredAuthorization();
  const shop = selectedShop(authorization);
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  const key = `${shop.id}:${safeDays}`;
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const promise = fetchOperationalData(safeDays).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: Date.now() + SNAPSHOT_TTL_MS, promise });
  return promise;
}

export async function getCurrentDashboard(): Promise<DashboardSnapshot> {
  if (process.env.DEMO_MODE === "true") {
    const { cloneDashboard } = await import("./data.ts");
    return cloneDashboard();
  }
  const status = await getTikTokConnectionStatus();
  if (!status.connected) return emptyDashboard(status.shopName, status.region);
  return (await getTikTokOperationalData(7)).dashboard;
}

export function clearTikTokDataCache(): void {
  cache.clear();
  productMetadataCache.clear();
}

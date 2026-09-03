import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionPlan, DashboardSnapshot, FieldDiff } from "../shared/contracts.ts";
import { getAuthorizedTikTokClient, readStoredAuthorization } from "./tiktok-auth.ts";
import { clearTikTokDataCache, getCurrentDashboard } from "./tiktok-data.ts";
import type { TikTokShopClient } from "./tiktok-client.ts";
import { actionPlanStore } from "./action-plan-store.ts";

export type TikTokProductWriteKind = "inventory.update" | "price.update" | "product.activate" | "product.deactivate";

const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PRODUCT_PAGES = 1_000;

const skuSchema = z.object({
  id: z.string().min(1),
  seller_sku: z.string().optional().default(""),
  inventory: z.array(z.object({
    warehouse_id: z.string().optional(),
    quantity: z.number().int().nonnegative(),
  }).passthrough()).optional().default([]),
  price: z.object({
    currency: z.string().optional(),
    amount: z.string().optional(),
    sale_price: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const productSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  update_time: z.number().optional(),
  skus: z.array(skuSchema).optional().default([]),
}).passthrough();

const productSearchSchema = z.object({
  data: z.object({
    products: z.array(productSchema).optional().default([]),
    next_page_token: z.string().optional().default(""),
    total_count: z.number().optional(),
  }).optional(),
}).passthrough();

const productDetailSchema = z.object({ data: productSchema.optional() }).passthrough();

type Product = z.output<typeof productSchema>;
type Sku = z.output<typeof skuSchema>;

type InventorySnapshot = {
  kind: "inventory.update";
  productId: string;
  skuId: string;
  sellerSku: string;
  warehouses: Array<{ warehouseId: string; quantity: number }>;
};

type PriceSnapshot = {
  kind: "price.update";
  productId: string;
  skuId: string;
  sellerSku: string;
  amount: string;
  currency: string;
};

type LifecycleSnapshot = {
  kind: "product.activate" | "product.deactivate";
  productId: string;
  title: string;
  status: string;
};

type WriteSnapshot = InventorySnapshot | PriceSnapshot | LifecycleSnapshot;

interface ImmutablePlanCore {
  id: string;
  kind: TikTokProductWriteKind;
  title: string;
  summary: string;
  storeId: string;
  storeName: string;
  risk: ActionPlan["risk"];
  diffs: FieldDiff[];
  expiresAt: string;
  snapshotJson: string;
  payloadJson: string;
  canonicalJson: string;
  planHash: string;
}

interface StoredPlan {
  core: Readonly<ImmutablePlanCore>;
  status: ActionPlan["status"];
}

interface TikTokProductWriteResult {
  plan: ActionPlan;
  requestId: string;
  completedAt: string;
  dashboard: DashboardSnapshot;
}

export class TikTokWritePreparationError extends Error {}

export class ActionVerificationPendingError extends Error {
  constructor(message: string, public readonly plan: ActionPlan) {
    super(message);
    this.name = "ActionVerificationPendingError";
  }
}

function parseProductSearch(value: unknown) {
  const parsed = productSearchSchema.safeParse(value);
  if (!parsed.success) throw new Error("TikTok Shop 商品列表返回的数据格式不完整。");
  return parsed.data.data;
}

function parseProductDetail(value: unknown): Product {
  const parsed = productDetailSchema.safeParse(value);
  if (!parsed.success || !parsed.data.data) throw new Error("TikTok Shop 商品详情返回的数据格式不完整。");
  return parsed.data.data;
}

async function readAllProducts(client: TikTokShopClient): Promise<Product[]> {
  const products: Product[] = [];
  const seenTokens = new Set<string>();
  let pageToken = "";

  for (let page = 0; page < MAX_PRODUCT_PAGES; page += 1) {
    const response = await client.request<unknown>("/product/202502/products/search", {
      method: "POST",
      query: { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
      body: {},
    });
    const data = parseProductSearch(response);
    const batch = data?.products ?? [];
    products.push(...batch);
    const nextToken = data?.next_page_token ?? "";
    if (!nextToken) {
      const total = data?.total_count ?? products.length;
      if (products.length < total) throw new Error("TikTok Shop 商品分页未完整读取，本次不会执行写操作。");
      return products;
    }
    if (!batch.length || seenTokens.has(nextToken)) throw new Error("TikTok Shop 商品分页异常，本次不会执行写操作。");
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new Error("TikTok Shop 商品数量超过安全分页上限，本次不会执行写操作。");
}

async function readProduct(client: TikTokShopClient, productId: string): Promise<Product> {
  return parseProductDetail(await client.request<unknown>(`/product/202309/products/${encodeURIComponent(productId)}`));
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function mentionsIdentifier(text: string, value: string): boolean {
  const query = normalized(value);
  if (!query || (query.length < 2 && !/^\d{8,}$/.test(query))) return false;
  if (/^\d+$/.test(query) && query.length < 8) return false;
  const source = text.toLocaleLowerCase();
  let offset = source.indexOf(query);
  while (offset >= 0) {
    const before = offset === 0 ? "" : source[offset - 1];
    const afterIndex = offset + query.length;
    const after = afterIndex >= source.length ? "" : source[afterIndex];
    const identifierCharacter = /[a-z0-9_-]/;
    if ((!before || !identifierCharacter.test(before)) && (!after || !identifierCharacter.test(after))) return true;
    offset = source.indexOf(query, offset + 1);
  }
  return false;
}

function mentionsTitle(text: string, title: string): boolean {
  const query = normalized(title);
  if (query.length < 2 || (/^\d+$/.test(query) && query.length < 8)) return false;
  return text.toLocaleLowerCase().includes(query);
}

function deduplicate<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function exactTarget(products: Product[], text: string, kind: TikTokProductWriteKind): { product: Product; sku?: Sku } {
  const productMatches = products.filter((product) => mentionsIdentifier(text, product.id) || mentionsTitle(text, product.title));
  const skuMatches = products.flatMap((product) => product.skus
    .filter((sku) => mentionsIdentifier(text, sku.id) || mentionsIdentifier(text, sku.seller_sku))
    .map((sku) => ({ product, sku })));

  if (kind === "product.activate" || kind === "product.deactivate") {
    const candidates = deduplicate([
      ...productMatches,
      ...skuMatches.map((match) => match.product),
    ], (product) => product.id);
    if (!candidates.length) throw new TikTokWritePreparationError("没有找到明确的商品目标。请在指令中写出完整商品名、商品 ID 或 SKU。");
    if (candidates.length > 1) throw new TikTokWritePreparationError(`指令同时匹配 ${candidates.length} 个商品。请只写一个准确的商品 ID。`);
    return { product: candidates[0] };
  }

  const candidates = [...skuMatches];
  if (!candidates.length) {
    for (const product of productMatches) {
      if (product.skus.length !== 1) {
        throw new TikTokWritePreparationError(`商品“${product.title}”有 ${product.skus.length} 个 SKU。请写出要修改的准确 SKU。`);
      }
      candidates.push({ product, sku: product.skus[0] });
    }
  }
  const unique = deduplicate(candidates, (candidate) => `${candidate.product.id}:${candidate.sku.id}`);
  if (!unique.length) throw new TikTokWritePreparationError("没有找到明确的 SKU。请在指令中写出完整 Seller SKU、SKU ID，或只有一个 SKU 的完整商品名。");
  if (unique.length > 1) throw new TikTokWritePreparationError(`指令同时匹配 ${unique.length} 个 SKU。为避免误改，请每次只指定一个准确 SKU。`);
  return unique[0];
}

function requestedQuantity(text: string): number {
  const match = text.match(/(?:库存|stock)(?:[^0-9]{0,24})(\d{1,6})(?!\d)/i);
  if (!match) throw new TikTokWritePreparationError("请明确写出目标库存，例如“将 REAL-SKU 库存修改为 20”。");
  const quantity = Number(match[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99_999) {
    throw new TikTokWritePreparationError("库存必须是 1 到 99999 之间的整数；如需停售，请使用下架商品指令。");
  }
  return quantity;
}

function requestedPrice(text: string): string {
  const match = text.match(/(?:价格|售价|改价|price)(?:[^0-9]{0,24})(\d+(?:\.\d{1,2})?)(?![\d.])/i);
  if (!match) throw new TikTokWritePreparationError("请明确写出目标价格，例如“将 REAL-SKU 价格修改为 99.00”。");
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999) throw new TikTokWritePreparationError("价格必须是大于 0 的有效金额，且最多保留两位小数。");
  return match[1];
}

function requestedCurrency(text: string): string | undefined {
  const beforeAmount = text.match(/(?:价格|售价|改价|price)[^0-9]{0,24}\b([A-Z]{3})\s*\d/i)?.[1];
  const afterAmount = text.match(/\d+(?:\.\d{1,2})?\s*([A-Z]{3})\b/)?.[1];
  return (beforeAmount ?? afterAmount)?.toUpperCase();
}

function createStoredPlan(input: Omit<ImmutablePlanCore, "id" | "expiresAt" | "canonicalJson" | "planHash">): ActionPlan {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString();
  const canonicalJson = JSON.stringify({ id, expiresAt, ...input });
  const planHash = createHash("sha256").update(canonicalJson).digest("hex").slice(0, 12);
  const core = Object.freeze({ id, expiresAt, ...input, canonicalJson, planHash });
  const stored: StoredPlan = { core, status: "pending" };
  actionPlanStore.save(stored);
  return publicPlan(stored);
}

function publicPlan(stored: StoredPlan): ActionPlan {
  const { core } = stored;
  return {
    id: core.id,
    tool: core.kind,
    title: core.title,
    summary: core.summary,
    store: core.storeName,
    risk: core.risk,
    diffs: structuredClone(core.diffs),
    expiresAt: core.expiresAt,
    status: stored.status,
    planHash: core.planHash,
  };
}

async function writeContext(kind: TikTokProductWriteKind) {
  const authorization = await readStoredAuthorization();
  const shop = authorization?.shops.find((item) => item.cipher === authorization.selectedShopCipher);
  if (!authorization || !shop) throw new TikTokWritePreparationError("没有找到当前授权店铺，请重新授权或选择店铺。");
  const requiredScope = kind === "inventory.update" || kind === "price.update" ? "seller.product.write" : "seller.product.basic";
  if (!authorization.grantedScopes.includes(requiredScope)) throw new TikTokWritePreparationError(`当前授权缺少 ${requiredScope}，请重新授权后再试。`);
  const client = await getAuthorizedTikTokClient();
  if (!client) throw new TikTokWritePreparationError("TikTok Shop 尚未连接。");
  return { client, shop };
}

export async function prepareTikTokProductWrite(kind: TikTokProductWriteKind, text: string): Promise<ActionPlan> {
  const { client, shop } = await writeContext(kind);
  const catalog = await readAllProducts(client);
  const target = exactTarget(catalog, text, kind);
  const detail = await readProduct(client, target.product.id);

  if (kind === "inventory.update") {
    const sku = detail.skus.find((item) => item.id === target.sku?.id);
    if (!sku) throw new TikTokWritePreparationError("商品详情中没有找到目标 SKU，本次不会修改库存。");
    if (!sku.inventory.length || sku.inventory.some((item) => !item.warehouse_id)) {
      throw new TikTokWritePreparationError("商品详情没有返回完整仓库库存，本次不会修改库存。");
    }
    const warehouses = sku.inventory.map((item) => ({ warehouseId: item.warehouse_id as string, quantity: item.quantity }));
    if (new Set(warehouses.map((item) => item.warehouseId)).size !== warehouses.length) {
      throw new TikTokWritePreparationError("商品详情返回了重复仓库库存，本次不会修改库存。");
    }
    const requestedWarehouse = warehouses.filter((item) => mentionsIdentifier(text, item.warehouseId));
    if (warehouses.length > 1 && requestedWarehouse.length !== 1) {
      throw new TikTokWritePreparationError(`该 SKU 分布在 ${warehouses.length} 个仓库。请在指令中写出一个准确的仓库 ID；系统会保留其他仓库数量。`);
    }
    const warehouse = requestedWarehouse[0] ?? warehouses[0];
    const quantity = requestedQuantity(text);
    if (quantity === warehouse.quantity) throw new TikTokWritePreparationError(`仓库 ${warehouse.warehouseId} 的库存已经是 ${quantity}，不需要重复修改。`);
    const nextWarehouses = warehouses.map((item) => ({ ...item, quantity: item.warehouseId === warehouse.warehouseId ? quantity : item.quantity }));
    const snapshot: InventorySnapshot = { kind, productId: detail.id, skuId: sku.id, sellerSku: sku.seller_sku || sku.id, warehouses };
    const payload = { skus: [{ id: sku.id, inventory: nextWarehouses.map((item) => ({ warehouse_id: item.warehouseId, quantity: item.quantity })) }] };
    return createStoredPlan({
      kind,
      title: "调整商品库存",
      summary: `只修改 ${snapshot.sellerSku} 在仓库 ${warehouse.warehouseId} 的库存；提交时会携带并保护全部 ${warehouses.length} 个仓库的当前数量。`,
      storeId: shop.id,
      storeName: shop.name,
      risk: "medium",
      diffs: [{ target: snapshot.sellerSku, field: `可售库存（仓库 ${warehouse.warehouseId}）`, before: String(warehouse.quantity), after: String(quantity) }],
      snapshotJson: JSON.stringify(snapshot),
      payloadJson: JSON.stringify(payload),
    });
  }

  if (kind === "price.update") {
    const sku = detail.skus.find((item) => item.id === target.sku?.id);
    const currentAmount = sku?.price?.sale_price ?? sku?.price?.amount;
    const currency = sku?.price?.currency;
    if (!sku || currentAmount === undefined || !currency) throw new TikTokWritePreparationError("商品详情没有返回目标 SKU 的完整价格和币种，本次不会改价。");
    const explicitCurrency = requestedCurrency(text);
    if (explicitCurrency && explicitCurrency !== currency.toUpperCase()) {
      throw new TikTokWritePreparationError(`目标 SKU 使用 ${currency}，但指令写的是 ${explicitCurrency}。币种不一致，本次不会改价。`);
    }
    const amount = requestedPrice(text);
    if (sameAmount(amount, currentAmount)) throw new TikTokWritePreparationError(`SKU ${sku.seller_sku || sku.id} 的价格已经是 ${currentAmount} ${currency}，不需要重复修改。`);
    const snapshot: PriceSnapshot = { kind, productId: detail.id, skuId: sku.id, sellerSku: sku.seller_sku || sku.id, amount: currentAmount, currency };
    const globalSeller = /CROSS_BORDER|GLOBAL/i.test(shop.sellerType ?? "");
    const payload = { skus: [{ id: sku.id, price: { amount, ...(globalSeller ? { sale_price: amount } : {}), currency } }] };
    return createStoredPlan({
      kind,
      title: "调整商品价格",
      summary: `只修改 SKU ${snapshot.sellerSku} 的 ${currency} 售价；批准前后都会重新读取 TikTok Shop 商品详情。`,
      storeId: shop.id,
      storeName: shop.name,
      risk: "high",
      diffs: [{ target: snapshot.sellerSku, field: `销售价格（${currency}）`, before: currentAmount, after: amount }],
      snapshotJson: JSON.stringify(snapshot),
      payloadJson: JSON.stringify(payload),
    });
  }

  const desiredActive = kind === "product.activate";
  if ((desiredActive && isActive(detail.status)) || (!desiredActive && isSellerDeactivated(detail.status))) {
    throw new TikTokWritePreparationError(`商品“${detail.title}”已经是${desiredActive ? "上架" : "下架"}状态，不需要重复操作。`);
  }
  if (desiredActive && !isActivationEligible(detail.status)) {
    throw new TikTokWritePreparationError(`商品当前状态为 ${detail.status}；官方上架接口只接受 SELLER_DEACTIVATED 或 PLATFORM_DEACTIVATED 商品。`);
  }
  if (!desiredActive && !isActive(detail.status)) {
    throw new TikTokWritePreparationError(`商品当前状态为 ${detail.status}；官方下架接口只接受 ACTIVATE 商品。`);
  }
  const snapshot: LifecycleSnapshot = { kind, productId: detail.id, title: detail.title, status: detail.status };
  return createStoredPlan({
    kind,
    title: desiredActive ? "上架商品" : "下架商品",
    summary: `只操作商品“${detail.title}”（${detail.id}）；批准时会确认商品状态没有变化。`,
    storeId: shop.id,
    storeName: shop.name,
    risk: desiredActive ? "medium" : "high",
    diffs: [{ target: detail.title, field: "商品状态", before: detail.status, after: desiredActive ? "PENDING（审核通过后上架）" : "SELLER_DEACTIVATED" }],
    snapshotJson: JSON.stringify(snapshot),
    payloadJson: JSON.stringify({ product_ids: [detail.id] }),
  });
}

function sameAmount(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) ? leftNumber === rightNumber : left === right;
}

function isActive(status: string): boolean {
  return status.toUpperCase() === "ACTIVATE";
}

function isSellerDeactivated(status: string): boolean {
  return status.toUpperCase() === "SELLER_DEACTIVATED";
}

function isActivationEligible(status: string): boolean {
  return new Set(["SELLER_DEACTIVATED", "PLATFORM_DEACTIVATED"]).has(status.toUpperCase());
}

function isActivationAccepted(status: string): boolean {
  return new Set(["PENDING", "ACTIVATE"]).has(status.toUpperCase());
}

function verifyUnchanged(snapshot: WriteSnapshot, detail: Product): void {
  if (snapshot.kind === "inventory.update") {
    const sku = detail.skus.find((item) => item.id === snapshot.skuId);
    if (!sku) throw new Error("批准前回读时找不到目标 SKU，执行已停止。");
    const current = sku.inventory.map((item) => ({ warehouseId: item.warehouse_id ?? "", quantity: item.quantity }));
    const expected = [...snapshot.warehouses].sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
    const actual = current.sort((a, b) => a.warehouseId.localeCompare(b.warehouseId));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("审批期间仓库库存已经变化。为避免覆盖新值，执行已停止，请重新生成计划。");
    return;
  }
  if (snapshot.kind === "price.update") {
    const sku = detail.skus.find((item) => item.id === snapshot.skuId);
    if (!sku || !sameAmount(sku.price?.sale_price ?? sku.price?.amount ?? "", snapshot.amount) || sku.price?.currency !== snapshot.currency) {
      throw new Error("审批期间商品价格或币种已经变化。为避免覆盖新值，执行已停止，请重新生成计划。");
    }
    return;
  }
  if (detail.status !== snapshot.status) throw new Error("审批期间商品状态已经变化。执行已停止，请重新生成计划。");
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const errors = (data as { errors?: unknown }).errors;
  if (!errors) return undefined;
  const values = Array.isArray(errors) ? errors : [errors];
  const messages = values.flatMap((error) => {
    if (typeof error === "string") return [error];
    if (!error || typeof error !== "object") return [];
    const item = error as Record<string, unknown>;
    const code = typeof item.code === "string" || typeof item.code === "number" ? String(item.code) : "";
    const message = typeof item.message === "string" ? item.message : typeof item.reason === "string" ? item.reason : "";
    return code || message ? [`${code ? `[${code}] ` : ""}${message || "TikTok Shop 拒绝该商品操作"}`] : [];
  });
  return messages.length ? messages.join("；") : undefined;
}

function verifyOutcome(snapshot: WriteSnapshot, payload: unknown, detail: Product): void {
  if (snapshot.kind === "inventory.update") {
    const desired = (payload as { skus: Array<{ inventory: Array<{ warehouse_id: string; quantity: number }> }> }).skus[0].inventory;
    const sku = detail.skus.find((item) => item.id === snapshot.skuId);
    const actual = new Map((sku?.inventory ?? []).map((item) => [item.warehouse_id, item.quantity]));
    if (desired.some((item) => actual.get(item.warehouse_id) !== item.quantity)) throw new Error("库存写入后回读值与计划不一致，计划已锁定，请在查询最新库存后人工核对。");
    return;
  }
  if (snapshot.kind === "price.update") {
    const desired = (payload as { skus: Array<{ price: { amount: string; sale_price?: string; currency: string } }> }).skus[0].price;
    const sku = detail.skus.find((item) => item.id === snapshot.skuId);
    if (!sku || !sameAmount(sku.price?.sale_price ?? sku.price?.amount ?? "", desired.sale_price ?? desired.amount) || sku.price?.currency !== desired.currency) {
      throw new Error("价格写入后回读值与计划不一致，计划已锁定，请在查询最新价格后人工核对。");
    }
    return;
  }
  if (snapshot.kind === "product.activate" && !isActivationAccepted(detail.status)) throw new Error("上架请求返回成功，但商品状态回读未进入 PENDING 或 ACTIVATE。计划已锁定，请人工核对。");
  if (snapshot.kind === "product.deactivate" && !isSellerDeactivated(detail.status)) throw new Error("下架请求返回成功，但商品状态回读未变为 SELLER_DEACTIVATED。计划已锁定，请人工核对。");
}

function endpoint(kind: TikTokProductWriteKind, productId: string): string {
  if (kind === "inventory.update") return `/product/202309/products/${encodeURIComponent(productId)}/inventory/update`;
  if (kind === "price.update") return `/product/202309/products/${encodeURIComponent(productId)}/prices/update`;
  return kind === "product.activate" ? "/product/202309/products/activate" : "/product/202309/products/deactivate";
}

export async function approveTikTokProductWrite(actionId: string): Promise<TikTokProductWriteResult | undefined> {
  const stored = actionPlanStore.get<StoredPlan>(actionId);
  if (!stored) return undefined;
  if (stored.status === "verification_pending") {
    try {
      const { client, shop } = await writeContext(stored.core.kind);
      if (shop.id !== stored.core.storeId) throw new Error("当前选择的店铺与审批计划不一致。");
      const snapshot = JSON.parse(stored.core.snapshotJson) as WriteSnapshot;
      const payload = JSON.parse(stored.core.payloadJson) as unknown;
      verifyOutcome(snapshot, payload, await readProduct(client, snapshot.productId));
      stored.status = "approved";
      actionPlanStore.save(stored);
      clearTikTokDataCache();
      return {
        plan: publicPlan(stored),
        requestId: `verify_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        completedAt: new Date().toISOString(),
        dashboard: await getCurrentDashboard(),
      };
    } catch {
      throw new ActionVerificationPendingError("店铺当前值仍未能确认。系统没有重复提交写入，请稍后再次核验。", publicPlan(stored));
    }
  }
  if (stored.status !== "pending") throw new Error("该执行计划已处理，不能重复提交。");
  if (new Date(stored.core.expiresAt).getTime() < Date.now()) {
    stored.status = "expired";
    actionPlanStore.save(stored);
    throw new Error("执行计划已过期，请重新生成以获取最新数据。");
  }
  if (createHash("sha256").update(stored.core.canonicalJson).digest("hex").slice(0, 12) !== stored.core.planHash) {
    stored.status = "rejected";
    actionPlanStore.save(stored);
    throw new Error("执行计划完整性校验失败，本次不会修改店铺。");
  }
  stored.status = "executing";
  actionPlanStore.save(stored);
  let writeAttempted = false;

  try {
    const { client, shop } = await writeContext(stored.core.kind);
    if (shop.id !== stored.core.storeId) throw new Error("当前选择的店铺与审批计划不一致，执行已停止。");
    const snapshot = JSON.parse(stored.core.snapshotJson) as WriteSnapshot;
    const payload = JSON.parse(stored.core.payloadJson) as unknown;
    const before = await readProduct(client, snapshot.productId);
    verifyUnchanged(snapshot, before);

    writeAttempted = true;
    const response = await client.request<unknown>(endpoint(stored.core.kind, snapshot.productId), { method: "POST", body: payload });
    const nestedError = nestedErrorMessage(response);
    if (nestedError) throw new Error(`TikTok Shop 未执行全部商品操作：${nestedError}`);

    const after = await readProduct(client, snapshot.productId);
    verifyOutcome(snapshot, payload, after);
    stored.status = "approved";
    actionPlanStore.save(stored);
    clearTikTokDataCache();
    const dashboard = await getCurrentDashboard();
    const requestId = typeof (response as { request_id?: unknown })?.request_id === "string"
      ? (response as { request_id: string }).request_id
      : `tts_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return { plan: publicPlan(stored), requestId, completedAt: new Date().toISOString(), dashboard };
  } catch (error) {
    if (stored.status === "executing") {
      stored.status = writeAttempted ? "verification_pending" : "rejected";
      actionPlanStore.save(stored);
    }
    if (writeAttempted) {
      throw new ActionVerificationPendingError(
        `写入请求已经发送，但暂时无法确认最终结果：${error instanceof Error ? error.message : "未知错误"}。系统不会自动重复提交。`,
        publicPlan(stored),
      );
    }
    throw error;
  }
}

export function rejectTikTokProductWrite(actionId: string): ActionPlan | undefined {
  const stored = actionPlanStore.get<StoredPlan>(actionId);
  if (!stored) return undefined;
  if (stored.status !== "pending") throw new Error("该执行计划已处理。");
  stored.status = "rejected";
  actionPlanStore.save(stored);
  return publicPlan(stored);
}

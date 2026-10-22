import { randomUUID } from "node:crypto";
import type {
  FlashSalePricingLevel,
  FlashSaleSku,
  FlashSaleWorkflowRun,
  WorkflowStep,
} from "../shared/contracts.ts";
import { getAuthorizedTikTokClient, readStoredAuthorization } from "./tiktok-auth.ts";
import { errorMessage, initialSteps, patchStep as patchStepBase, RunLockMap } from "./workflow-core.ts";
import { WorkflowStore, workflowStore } from "./workflow-store.ts";

export interface FlashSaleWorkflowInput {
  productId: string;
  activityTitle: string;
  startAt: string;
  endAt: string;
  priceAmount: string;
  currency?: string;
  /**
   * 活动商品层级。不传时按意图推断：给了 SKU 子集就按 SKU 定价（VARIATION），
   * 没给就当整品一个价（PRODUCT，官方接口真机验证过的路径）。
   */
  pricingLevel?: FlashSalePricingLevel;
  skuIds?: string[];
  skuQuantityLimit: number;
  quantityPerUser: number;
}

interface FlashSaleProduct {
  id: string;
  title: string;
  status: string;
  skus: FlashSaleSku[];
}

interface FlashSaleActivity {
  id: string;
  status?: string;
  products: Array<{
    id: string;
    priceAmount?: string;
    quantityLimit?: number;
    quantityPerUser?: number;
    skus: Array<{
      id: string;
      priceAmount?: string;
      currency?: string;
      quantityLimit?: number;
      quantityPerUser?: number;
    }>;
  }>;
}

export interface FlashSaleWorkflowTools {
  context(): Promise<{ shopId?: string; shopName?: string; region?: string; scopes: string[] }>;
  product(productId: string): Promise<FlashSaleProduct>;
  createActivity(input: FlashSaleWorkflowInput & { pricingLevel: FlashSalePricingLevel }): Promise<{ activityId: string; status?: string; requestId?: string }>;
  bindProduct(input: { activityId: string; productId: string; level: FlashSalePricingLevel; skuIds: string[]; priceAmount: string; quantityLimit: number; quantityPerUser: number }): Promise<{ requestId?: string }>;
  activity(activityId: string): Promise<FlashSaleActivity>;
}

const STEP_LABELS = [
  ["precheck", "检查权限、商品和库存"],
  ["confirm", "确认秒杀方案"],
  ["create_activity", "创建秒杀活动"],
  ["bind_skus", "绑定商品和 SKU"],
  ["verify", "回查活动结果"],
] as const;

function initialWorkflowSteps(level: FlashSalePricingLevel = "PRODUCT"): WorkflowStep[] {
  return initialSteps(STEP_LABELS.map(([id, label]) => [
    id,
    id === "bind_skus" && level === "PRODUCT" ? "绑定商品并设置活动价" : label,
  ] as [string, string]));
}

function patchStep(run: FlashSaleWorkflowRun, id: string, patch: Partial<WorkflowStep>): FlashSaleWorkflowRun {
  return patchStepBase(run, id, patch);
}

/** 旧记录没有 pricingLevel 字段，读出来时补成已验证过的 PRODUCT，避免建活动时漏传层级。 */
function normalizeRun(run: FlashSaleWorkflowRun): FlashSaleWorkflowRun {
  return run.pricingLevel ? run : { ...run, pricingLevel: "PRODUCT" };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function dataRecord(value: unknown): Record<string, unknown> {
  return record(record(value)?.data) ?? record(value) ?? {};
}

function requestId(value: unknown): string | undefined {
  const raw = record(value)?.request_id ?? record(value)?.requestId;
  return raw === undefined ? undefined : String(raw);
}

function availableStock(sku: Record<string, unknown>): number {
  const inventories = Array.isArray(sku.inventory) ? sku.inventory : Array.isArray(sku.inventories) ? sku.inventories : [];
  return inventories.reduce((total, item) => total + Math.max(0, Number(record(item)?.quantity ?? 0) || 0), 0);
}

/**
 * 从商品详情的 SKU 里取售价。优先 price.sale_price（实际售卖价）；
 * 只有 sale_price 完全没返回时才退到 tax_exclusive_price —— 两者经常差一个数量级
 * （实测同一 SKU sale_price 6373、tax_exclusive_price 547），混用会让价格提示误报。
 */
function skuSalePrice(sku: Record<string, unknown>): string | undefined {
  const price = record(sku.price);
  const saleRaw = price?.sale_price ?? sku.sale_price;
  const sale = Number(saleRaw);
  if (Number.isFinite(sale) && sale > 0) return String(sale);
  // 明确返回了 sale_price 但不可用（0/空），就认定这个 SKU 没有可比售价，不再拿含税价顶替
  if (saleRaw !== undefined && saleRaw !== null && saleRaw !== "") return undefined;
  const taxRaw = price?.tax_exclusive_price ?? sku.tax_exclusive_price;
  const tax = Number(taxRaw);
  return Number.isFinite(tax) && tax > 0 ? String(tax) : undefined;
}

/** 从活动详情的商品节点里取活动价（整品级优先，兼容 amount 嵌套与直接给数值两种返回）。 */
function activityPriceOf(value: Record<string, unknown>): string | undefined {
  for (const key of ["activity_price", "product_activity_price", "price"]) {
    const slot = value[key];
    if (slot === undefined || slot === null) continue;
    const inner = record(slot);
    const amount = inner?.amount ?? inner?.sale_price ?? (typeof slot === "object" ? undefined : slot);
    if (amount !== undefined && amount !== null && String(amount) !== "") return String(amount);
  }
  for (const key of ["activity_price_amount", "product_activity_price_amount"]) {
    if (value[key] !== undefined && value[key] !== null) return String(value[key]);
  }
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 没显式指定层级时按意图推断：给了 SKU 子集说明要分 SKU 定价，否则整品一个价。 */
function inferPricingLevel(input: FlashSaleWorkflowInput): FlashSalePricingLevel {
  return input.pricingLevel ?? (input.skuIds?.length ? "VARIATION" : "PRODUCT");
}

export interface ActivityProductInput {
  productId: string;
  level: FlashSalePricingLevel;
  skuIds: string[];
  priceAmount: string;
  quantityLimit: number;
  quantityPerUser: number;
}

/**
 * 挂商品请求里的单个商品节点。
 * 整品级只认一个 activity_price_amount，结构里不能出现 skus —— 带上会被平台判成结构错误；
 * 按 SKU 定价才逐条下发 skus。
 */
export function activityProductBody(input: ActivityProductInput): Record<string, unknown> {
  if (input.level === "VARIATION") {
    return {
      id: input.productId,
      quantity_limit: -1,
      quantity_per_user: -1,
      skus: input.skuIds.map((id) => ({
        id,
        activity_price_amount: input.priceAmount,
        quantity_limit: input.quantityLimit,
        quantity_per_user: input.quantityPerUser,
      })),
    };
  }
  return {
    id: input.productId,
    activity_price_amount: input.priceAmount,
    quantity_limit: input.quantityLimit,
    quantity_per_user: input.quantityPerUser,
  };
}

function validLimit(value: number): boolean {
  return value === -1 || (Number.isInteger(value) && value >= 1 && value <= 99);
}

export const realFlashSaleWorkflowTools: FlashSaleWorkflowTools = {
  async context() {
    const stored = await readStoredAuthorization();
    if (!stored) {
      const client = await getAuthorizedTikTokClient();
      if (!client) throw new Error("TikTok Shop 尚未连接，不能创建秒杀活动。");
      return { scopes: [] };
    }
    const shop = stored.shops.find((item) => item.cipher === stored.selectedShopCipher);
    if (!shop) throw new Error("请先选择要操作的 TikTok 店铺。");
    // 不在这里按 grantedScopes 硬拦：实测授权返回的 granted_scopes 只回报
    // seller.authorization.info 一个值，而商品读取接口实际可用，说明这个字段不可靠。
    // 权限够不够交给平台判定，缺权限时引擎会把返回的报错如实带出来。
    return { shopId: shop.id, shopName: shop.name, region: shop.region, scopes: stored.grantedScopes };
  },

  async product(productId) {
    const client = await getAuthorizedTikTokClient();
    if (!client) throw new Error("TikTok Shop 尚未连接。");
    const response = await client.request<unknown>(`/product/202309/products/${encodeURIComponent(productId)}`);
    const raw = dataRecord(response);
    const product = record(raw.product) ?? raw;
    const skus = Array.isArray(product.skus) ? product.skus.flatMap((value) => {
      const sku = record(value);
      if (!sku?.id) return [];
      return [{
        id: String(sku.id),
        sellerSku: sku.seller_sku ? String(sku.seller_sku) : undefined,
        availableStock: availableStock(sku),
        salePrice: skuSalePrice(sku),
      }];
    }) : [];
    return {
      id: String(product.id ?? productId),
      title: String(product.title ?? "未命名商品"),
      status: String(product.status ?? "UNKNOWN"),
      skus,
    };
  },

  async createActivity(input) {
    const client = await getAuthorizedTikTokClient();
    if (!client) throw new Error("TikTok Shop 尚未连接。");
    const response = await client.request<unknown>("/promotion/202309/activities", {
      method: "POST",
      body: {
        title: input.activityTitle,
        activity_type: "FLASHSALE",
        // 建活动时就定好层级：PRODUCT、VARIATION 决定第 15 步挂商品时能不能带 skus
        product_level: input.pricingLevel,
        duration_type: "NORMAL",
        begin_time: Math.floor(new Date(input.startAt).getTime() / 1000),
        end_time: Math.floor(new Date(input.endAt).getTime() / 1000),
        participation_limit: [{ type: "BUYER_NO_LIMIT" }],
        target_user_info: { user_type: "ALL_USER" },
      },
    });
    const data = dataRecord(response);
    const activityId = String(data.activity_id ?? "");
    if (!activityId) throw new Error("TikTok 已接收创建请求，但没有返回活动 ID。");
    return { activityId, status: data.status ? String(data.status) : undefined, requestId: requestId(response) };
  },

  async bindProduct(input) {
    const client = await getAuthorizedTikTokClient();
    if (!client) throw new Error("TikTok Shop 尚未连接。");
    const response = await client.request<unknown>(`/promotion/202309/activities/${encodeURIComponent(input.activityId)}/products`, {
      method: "PUT",
      // activity_id 必须回写在 body 里，只放在 URL 上会被判成 ActivityId is a required field
      body: { activity_id: input.activityId, products: [activityProductBody(input)] },
    });
    const total = optionalNumber(dataRecord(response).total_count);
    if (total !== undefined && total < 1) throw new Error("TikTok 已接收挂商品请求，但没有商品计入活动。");
    return { requestId: requestId(response) };
  },

  async activity(activityId) {
    const client = await getAuthorizedTikTokClient();
    if (!client) throw new Error("TikTok Shop 尚未连接。");
    const response = await client.request<unknown>(`/promotion/202309/activities/${encodeURIComponent(activityId)}`);
    const data = dataRecord(response);
    const products = Array.isArray(data.products) ? data.products.flatMap((value) => {
      const product = record(value);
      if (!product?.id) return [];
      const skus = Array.isArray(product.skus) ? product.skus.flatMap((skuValue) => {
        const sku = record(skuValue);
        if (!sku?.id) return [];
        const price = record(sku.activity_price);
        return [{
          id: String(sku.id),
          priceAmount: price?.amount === undefined ? skuSalePrice(sku) : String(price.amount),
          currency: price?.currency === undefined ? undefined : String(price.currency),
          quantityLimit: sku.quantity_limit === undefined ? undefined : Number(sku.quantity_limit),
          quantityPerUser: sku.quantity_per_user === undefined ? undefined : Number(sku.quantity_per_user),
        }];
      }) : [];
      return [{
        id: String(product.id),
        priceAmount: activityPriceOf(product),
        quantityLimit: optionalNumber(product.quantity_limit),
        quantityPerUser: optionalNumber(product.quantity_per_user),
        skus,
      }];
    }) : [];
    return { id: String(data.activity_id ?? activityId), status: data.status ? String(data.status) : undefined, products };
  },
};

export class FlashSaleWorkflowEngine {
  private readonly locks = new RunLockMap();

  constructor(
    private readonly store: WorkflowStore = workflowStore,
    private readonly tools: FlashSaleWorkflowTools = realFlashSaleWorkflowTools,
  ) {}

  async list(): Promise<FlashSaleWorkflowRun[]> {
    return (await this.store.list()).flatMap((run) => run.type === "flash_sale" ? [normalizeRun(run)] : []);
  }

  async get(id: string): Promise<FlashSaleWorkflowRun | undefined> {
    const run = await this.store.get(id);
    return run?.type === "flash_sale" ? normalizeRun(run) : undefined;
  }

  async create(input: FlashSaleWorkflowInput): Promise<FlashSaleWorkflowRun> {
    const pricingLevel = inferPricingLevel(input);
    this.validateInput(input, pricingLevel);
    const now = new Date().toISOString();
    const run: FlashSaleWorkflowRun = {
      id: randomUUID(),
      type: "flash_sale",
      title: "TikTok Shop 秒杀活动",
      status: "draft",
      productId: input.productId.trim(),
      activityTitle: input.activityTitle.trim(),
      startAt: new Date(input.startAt).toISOString(),
      endAt: new Date(input.endAt).toISOString(),
      priceAmount: input.priceAmount.trim(),
      currency: input.currency?.trim().toUpperCase() || "JPY",
      pricingLevel,
      skuSelection: input.skuIds?.length ? { mode: "include", skuIds: [...new Set(input.skuIds)] } : { mode: "all" },
      skuQuantityLimit: input.skuQuantityLimit,
      quantityPerUser: input.quantityPerUser,
      selectedSkus: [],
      steps: initialWorkflowSteps(pricingLevel),
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.store.create(run);
  }

  async run(id: string): Promise<FlashSaleWorkflowRun> {
    return this.locks.withLock(id, async () => {
      let run = await this.requireRun(id);
      if (run.status !== "draft") return run;
      run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({ ...current, status: "running", error: undefined }, "precheck", {
        status: "running", detail: "正在读取授权、商品 SKU 和实时库存", startedAt: new Date().toISOString(), error: undefined,
      }));
      try {
        const context = await this.tools.context();
        const product = await this.tools.product(run.productId);
        if (!new Set(["ACTIVATE", "ACTIVE"]).has(product.status.toUpperCase())) {
          throw new Error(`商品当前状态为 ${product.status}，只有已上架商品才能加入秒杀。`);
        }
        if (!product.skus.length) throw new Error("商品没有可用 SKU，无法创建秒杀活动。");
        const wanted = run.skuSelection.mode === "all"
          ? product.skus
          : run.skuSelection.skuIds.map((id) => product.skus.find((sku) => sku.id === id)).filter((sku): sku is FlashSaleSku => Boolean(sku));
        if (run.skuSelection.mode === "include" && wanted.length !== run.skuSelection.skuIds.length) {
          throw new Error("指定的部分 SKU 不属于这个商品，请重新读取商品后选择。");
        }
        // 整品级活动价作用于商品全部 SKU，参与范围必须按整品算，不能只核用户点选的那几个
        const selected = run.pricingLevel === "PRODUCT" ? product.skus : wanted;
        if (run.skuQuantityLimit !== -1) {
          const short = selected.filter((sku) => sku.availableStock < run.skuQuantityLimit);
          if (short.length) throw new Error(`活动库存 ${run.skuQuantityLimit} 超过 ${short.length} 个 SKU 的可售库存。`);
        }
        const warnings = run.warnings.filter((item) => !item.startsWith("秒杀价 ") && !item.startsWith("授权回报"));
        if (context.scopes.length && !context.scopes.includes("seller.promotion.write")) {
          warnings.push(`授权回报的范围里没有 seller.promotion.write（共回报 ${context.scopes.length} 个 scope），建活动可能被平台拒绝；真报了权限错，请到 Partner Center 补权限后重新授权。`);
        }
        const activityPrice = Number(run.priceAmount);
        const priced = selected.flatMap((sku) => {
          const value = Number(sku.salePrice);
          return Number.isFinite(value) && value > 0 ? [value] : [];
        });
        const notLower = priced.filter((value) => activityPrice >= value);
        if (notLower.length) {
          // 不拦流程：平台才是最终判据，但审批前必须让人看到这一条
          warnings.push(`秒杀价 ${run.priceAmount} 不低于 ${notLower.length} 个 SKU 的当前售价（最低 ${Math.min(...notLower)} ${run.currency}），平台一般会以「活动价未低于售价」拒收；建议先把售价改到划线价再建活动。`);
        }
        run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
          ...current,
          status: "waiting_confirmation",
          shopId: context.shopId,
          shopName: context.shopName,
          shopRegion: context.region,
          productTitle: product.title,
          selectedSkus: selected,
          confirmationKind: "flash_sale",
          warnings,
          summary: current.pricingLevel === "PRODUCT"
            ? `已核对 ${product.title} 的 ${selected.length} 个 SKU 库存。确认后将创建整品秒杀：全部 SKU 统一活动价 ${current.priceAmount} ${current.currency}。`
            : `已核对 ${selected.length} 个 SKU。确认后将创建活动并绑定商品，活动价 ${current.priceAmount} ${current.currency}。`,
        }, "precheck", {
          status: "completed", detail: `${product.title} · ${selected.length} 个 SKU 库存通过`, completedAt: new Date().toISOString(),
        }));
        return patchStep(run, "confirm", { status: "pending", detail: "等待你确认创建真实秒杀活动" });
      } catch (error) {
        return this.fail(id, "precheck", error);
      }
    });
  }

  async approve(id: string): Promise<FlashSaleWorkflowRun> {
    return this.locks.withLock(id, async () => {
      let run = await this.requireRun(id);
      if (run.status !== "waiting_confirmation" || !run.selectedSkus.length) throw new Error("这个秒杀任务还没有通过发布前检查。");
      run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => {
        const confirmed = patchStep({ ...current, status: "running", error: undefined }, "confirm", {
          status: "completed", detail: "已确认创建", completedAt: new Date().toISOString(),
        });
        return current.activityId ? confirmed : patchStep(confirmed, "create_activity", {
          status: "running", detail: "正在创建空秒杀活动", startedAt: new Date().toISOString(),
        });
      });

      if (!run.activityId) {
        try {
          const created = await this.tools.createActivity({
            productId: run.productId, activityTitle: run.activityTitle, startAt: run.startAt, endAt: run.endAt,
            priceAmount: run.priceAmount, currency: run.currency, skuQuantityLimit: run.skuQuantityLimit,
            quantityPerUser: run.quantityPerUser, pricingLevel: run.pricingLevel,
            skuIds: run.skuSelection.mode === "include" ? run.skuSelection.skuIds : undefined,
          });
          run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
            ...current, activityId: created.activityId, activityStatus: created.status, createRequestId: created.requestId,
          }, "create_activity", { status: "completed", detail: `活动 ID ${created.activityId}`, completedAt: new Date().toISOString() }));
        } catch (error) {
          return this.fail(id, "create_activity", error);
        }
      }

      try {
        run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep(current, "bind_skus", {
          status: "running",
          detail: current.pricingLevel === "PRODUCT"
            ? `正在挂商品并设置整品活动价 ${current.priceAmount}`
            : `正在绑定 ${current.selectedSkus.length} 个 SKU`,
          startedAt: new Date().toISOString(), error: undefined,
        }));
        const bound = await this.tools.bindProduct({
          activityId: run.activityId!, productId: run.productId, level: run.pricingLevel,
          skuIds: run.selectedSkus.map((sku) => sku.id),
          priceAmount: run.priceAmount, quantityLimit: run.skuQuantityLimit, quantityPerUser: run.quantityPerUser,
        });
        await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({ ...current, bindRequestId: bound.requestId }, "bind_skus", {
          status: "completed",
          detail: current.pricingLevel === "PRODUCT" ? "商品已挂入活动并设置整品活动价" : "商品和 SKU 已绑定",
          completedAt: new Date().toISOString(),
        }));
      } catch (error) {
        return this.fail(id, "bind_skus", error, `活动 ${run.activityId} 已创建，但商品绑定失败。活动 ID 已保留，可直接重试绑定。`);
      }
      return this.verifyUnlocked(id);
    });
  }

  async verify(id: string): Promise<FlashSaleWorkflowRun> {
    return this.locks.withLock(id, () => this.verifyUnlocked(id));
  }

  async retry(id: string): Promise<FlashSaleWorkflowRun> {
    const run = await this.requireRun(id);
    if (run.status !== "failed") throw new Error("只有失败的秒杀任务可以重试。");
    const failed = run.steps.find((step) => step.status === "failed")?.id;
    if (failed === "bind_skus" && run.activityId) {
      await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({ ...current, status: "waiting_confirmation", error: undefined }, "bind_skus", { status: "pending", error: undefined, detail: "准备重新绑定" }));
      return this.approve(id);
    }
    await this.store.update<FlashSaleWorkflowRun>(id, (current) => ({ ...current, status: "draft", error: undefined, steps: initialWorkflowSteps(current.pricingLevel) }));
    return this.run(id);
  }

  async cancel(id: string): Promise<FlashSaleWorkflowRun> {
    return this.locks.withLock(id, async () => {
      const run = await this.requireRun(id);
      if (run.activityId) throw new Error(`活动 ${run.activityId} 已经在 TikTok 创建，不能只取消本地任务；请先处理该活动。`);
      return this.store.update<FlashSaleWorkflowRun>(id, (current) => ({ ...current, status: "cancelled", summary: "任务已取消，没有创建 TikTok 活动。" }));
    });
  }

  private async verifyUnlocked(id: string): Promise<FlashSaleWorkflowRun> {
    let run = await this.requireRun(id);
    if (!run.activityId) throw new Error("任务还没有活动 ID，无法核验。");
    const activityId = run.activityId;
    run = await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({ ...current, status: "running" }, "verify", {
      status: "running", detail: "正在回查活动详情", startedAt: new Date().toISOString(), error: undefined,
    }));
    try {
      const activity = await this.tools.activity(activityId);
      const product = activity.products.find((item) => item.id === run.productId);
      const matched = this.matches(run, product);
      const passed = matched === true;
      return this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
        ...current, status: passed ? "completed" : "verification_pending", activityStatus: activity.status,
        summary: passed
          ? current.pricingLevel === "PRODUCT"
            ? `秒杀活动已创建并核验完成。活动 ID：${current.activityId}，整品活动价 ${current.priceAmount} ${current.currency}，覆盖商品全部 SKU。`
            : `秒杀活动已创建并核验完成。活动 ID：${current.activityId}，共 ${current.selectedSkus.length} 个 SKU。`
          : matched === false
            ? `活动 ${current.activityId} 已创建，但回查到的活动价或限购信息还未完全一致，请稍后重新核验。`
            : `活动 ${current.activityId} 已创建，但平台没有返回可用于核对的活动价字段，请到 TikTok 后台确认活动是否生效。`,
      }, "verify", {
        status: passed ? "completed" : "pending",
        detail: passed
          ? "活动、价格、库存和限购均已核对"
          : matched === false ? "TikTok 数据尚未完全同步" : "平台未返回活动价字段，需人工确认",
        ...(passed ? { completedAt: new Date().toISOString() } : {}),
      }));
    } catch (error) {
      return this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
        ...current, status: "verification_pending", error: undefined,
        summary: `活动 ${current.activityId} 已创建并完成绑定，但暂时无法回查详情。`,
        warnings: [...current.warnings.filter((item) => !item.startsWith("回查失败：")), `回查失败：${errorMessage(error)}`],
      }, "verify", { status: "pending", detail: "等待重新核验", error: errorMessage(error) }));
    }
  }

  /**
   * 回查判据。整品级先看商品节点的活动价，平台没返回该字段时退到逐 SKU 比对；
   * 两条路都拿不到数据就返回 "unknown" —— 不把「查不到」当成「已生效」。
   */
  private matches(
    run: FlashSaleWorkflowRun,
    product: FlashSaleActivity["products"][number] | undefined,
  ): boolean | "unknown" {
    if (!product) return false;
    const samePrice = (value: string | undefined) => {
      if (value === undefined) return false;
      const actual = Number(value);
      const expected = Number(run.priceAmount);
      // 平台可能回 "1416" 而我们记的是 "1416.00"，按数值比而不是按字符串比
      return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 0.005;
    };
    const limitOk = (value: number | undefined) => value === undefined || value === run.skuQuantityLimit;
    const perUserOk = (value: number | undefined) => value === undefined || value === run.quantityPerUser;

    if (run.pricingLevel === "PRODUCT") {
      if (product.priceAmount !== undefined) {
        return samePrice(product.priceAmount) && limitOk(product.quantityLimit) && perUserOk(product.quantityPerUser);
      }
      if (product.skus.length) return product.skus.every((sku) => samePrice(sku.priceAmount));
      return "unknown";
    }
    if (!product.skus.length) return "unknown";
    return run.selectedSkus.every((selected) => {
      const sku = product.skus.find((item) => item.id === selected.id);
      return samePrice(sku?.priceAmount)
        && sku?.quantityLimit === run.skuQuantityLimit
        && sku?.quantityPerUser === run.quantityPerUser;
    });
  }

  private validateInput(input: FlashSaleWorkflowInput, pricingLevel: FlashSalePricingLevel): void {
    if (!/^\d{10,30}$/.test(input.productId.trim())) throw new Error("请输入 TikTok 商品 ID。 ");
    if (!input.activityTitle.trim()) throw new Error("请输入秒杀活动名称。");
    const start = new Date(input.startAt).getTime();
    const end = new Date(input.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("秒杀开始和结束时间格式不正确。");
    if (start <= Date.now()) throw new Error("秒杀开始时间必须晚于当前时间。");
    if (end <= start) throw new Error("秒杀结束时间必须晚于开始时间。");
    if (!/^\d+(?:\.\d{1,2})?$/.test(input.priceAmount.trim()) || Number(input.priceAmount) <= 0) throw new Error("秒杀价必须是大于 0 的数字，最多两位小数。");
    if (!validLimit(input.skuQuantityLimit)) throw new Error("每个 SKU 的活动库存只能是 1-99，或 -1（不限）。");
    if (!validLimit(input.quantityPerUser)) throw new Error("每人限购只能是 1-99，或 -1（不限）。");
    if (pricingLevel === "PRODUCT" && input.skuIds?.length) {
      throw new Error("整品秒杀价作用于商品全部 SKU，不能同时指定 SKU 子集；要按 SKU 分别定价请把活动层级设为 VARIATION。");
    }
    if (pricingLevel === "VARIATION" && !input.skuIds?.length) {
      throw new Error("按 SKU 定价需要先指定参与的 SKU；整品一个价请用 PRODUCT 层级。");
    }
  }

  private async fail(id: string, stepId: string, error: unknown, summary?: string): Promise<FlashSaleWorkflowRun> {
    const message = errorMessage(error);
    return this.store.update<FlashSaleWorkflowRun>(id, (run) => patchStep({ ...run, status: "failed", error: message, ...(summary ? { summary } : {}) }, stepId, {
      status: "failed", detail: "执行失败，可修正后重试", error: message,
    }));
  }

  private async requireRun(id: string): Promise<FlashSaleWorkflowRun> {
    const run = await this.store.get(id);
    if (!run || run.type !== "flash_sale") throw new Error("找不到这个秒杀任务。");
    return normalizeRun(run);
  }
}

export const flashSaleWorkflowEngine = new FlashSaleWorkflowEngine();

export async function startFlashSaleWorkflow(input: FlashSaleWorkflowInput): Promise<FlashSaleWorkflowRun> {
  const run = await flashSaleWorkflowEngine.create(input);
  void flashSaleWorkflowEngine.run(run.id).catch(() => undefined);
  return run;
}

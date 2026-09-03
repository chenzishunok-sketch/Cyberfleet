import { randomUUID } from "node:crypto";
import type { FlashSaleSku, FlashSaleWorkflowRun, WorkflowStep } from "../shared/contracts.ts";
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
  createActivity(input: FlashSaleWorkflowInput): Promise<{ activityId: string; status?: string; requestId?: string }>;
  bindProduct(input: { activityId: string; productId: string; skuIds: string[]; priceAmount: string; quantityLimit: number; quantityPerUser: number }): Promise<{ requestId?: string }>;
  activity(activityId: string): Promise<FlashSaleActivity>;
}

const STEP_LABELS = [
  ["precheck", "检查权限、商品和库存"],
  ["confirm", "确认秒杀方案"],
  ["create_activity", "创建秒杀活动"],
  ["bind_skus", "绑定商品和 SKU"],
  ["verify", "回查活动结果"],
] as const;

function initialWorkflowSteps(): WorkflowStep[] {
  return initialSteps(STEP_LABELS.map(([id, label]) => [id, label] as [string, string]));
}

function patchStep(run: FlashSaleWorkflowRun, id: string, patch: Partial<WorkflowStep>): FlashSaleWorkflowRun {
  return patchStepBase(run, id, patch);
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
    if (!stored.grantedScopes.includes("seller.promotion.write")) {
      throw new Error("当前 TikTok 授权缺少促销修改权限 seller.promotion.write，请重新授权后再试。");
    }
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
      return [{ id: String(sku.id), sellerSku: sku.seller_sku ? String(sku.seller_sku) : undefined, availableStock: availableStock(sku) }];
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
        product_level: "VARIATION",
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
      body: {
        activity_id: input.activityId,
        products: [{
          id: input.productId,
          quantity_limit: -1,
          quantity_per_user: -1,
          skus: input.skuIds.map((id) => ({
            id,
            activity_price_amount: input.priceAmount,
            quantity_limit: input.quantityLimit,
            quantity_per_user: input.quantityPerUser,
          })),
        }],
      },
    });
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
          priceAmount: price?.amount === undefined ? undefined : String(price.amount),
          currency: price?.currency === undefined ? undefined : String(price.currency),
          quantityLimit: sku.quantity_limit === undefined ? undefined : Number(sku.quantity_limit),
          quantityPerUser: sku.quantity_per_user === undefined ? undefined : Number(sku.quantity_per_user),
        }];
      }) : [];
      return [{ id: String(product.id), skus }];
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
    return (await this.store.list()).filter((run): run is FlashSaleWorkflowRun => run.type === "flash_sale");
  }

  async get(id: string): Promise<FlashSaleWorkflowRun | undefined> {
    const run = await this.store.get(id);
    return run?.type === "flash_sale" ? run : undefined;
  }

  async create(input: FlashSaleWorkflowInput): Promise<FlashSaleWorkflowRun> {
    this.validateInput(input);
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
      currency: input.currency?.trim().toUpperCase() || "THB",
      skuSelection: input.skuIds?.length ? { mode: "include", skuIds: [...new Set(input.skuIds)] } : { mode: "all" },
      skuQuantityLimit: input.skuQuantityLimit,
      quantityPerUser: input.quantityPerUser,
      selectedSkus: [],
      steps: initialWorkflowSteps(),
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
        if (!product.skus.length) throw new Error("商品没有可用 SKU，无法创建 SKU 级秒杀。");
        const selected = run.skuSelection.mode === "all"
          ? product.skus
          : run.skuSelection.skuIds.map((id) => product.skus.find((sku) => sku.id === id)).filter((sku): sku is FlashSaleSku => Boolean(sku));
        if (run.skuSelection.mode === "include" && selected.length !== run.skuSelection.skuIds.length) {
          throw new Error("指定的部分 SKU 不属于这个商品，请重新读取商品后选择。");
        }
        if (run.skuQuantityLimit !== -1) {
          const short = selected.filter((sku) => sku.availableStock < run.skuQuantityLimit);
          if (short.length) throw new Error(`活动库存 ${run.skuQuantityLimit} 超过 ${short.length} 个 SKU 的可售库存。`);
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
          summary: `已核对 ${selected.length} 个 SKU。确认后将创建活动并绑定商品，活动价 ${current.priceAmount} ${current.currency}。`,
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
            quantityPerUser: run.quantityPerUser,
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
          status: "running", detail: `正在绑定 ${current.selectedSkus.length} 个 SKU`, startedAt: new Date().toISOString(), error: undefined,
        }));
        const bound = await this.tools.bindProduct({
          activityId: run.activityId!, productId: run.productId, skuIds: run.selectedSkus.map((sku) => sku.id),
          priceAmount: run.priceAmount, quantityLimit: run.skuQuantityLimit, quantityPerUser: run.quantityPerUser,
        });
        await this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({ ...current, bindRequestId: bound.requestId }, "bind_skus", {
          status: "completed", detail: "商品和 SKU 已绑定", completedAt: new Date().toISOString(),
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
    await this.store.update<FlashSaleWorkflowRun>(id, (current) => ({ ...current, status: "draft", error: undefined, steps: initialWorkflowSteps() }));
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
      const byId = new Map((product?.skus ?? []).map((sku) => [sku.id, sku]));
      const exact = run.selectedSkus.every((selected) => {
        const sku = byId.get(selected.id);
        return sku?.priceAmount === run.priceAmount
          && sku.quantityLimit === run.skuQuantityLimit
          && sku.quantityPerUser === run.quantityPerUser;
      });
      return this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
        ...current, status: exact ? "completed" : "verification_pending", activityStatus: activity.status,
        summary: exact
          ? `秒杀活动已创建并核验完成。活动 ID：${current.activityId}，共 ${current.selectedSkus.length} 个 SKU。`
          : `活动 ${current.activityId} 已创建，但回查到的 SKU 价格或限购信息还未完全一致，请稍后重新核验。`,
      }, "verify", { status: exact ? "completed" : "pending", detail: exact ? "活动、价格、库存和限购均已核对" : "TikTok 数据尚未完全同步", ...(exact ? { completedAt: new Date().toISOString() } : {}) }));
    } catch (error) {
      return this.store.update<FlashSaleWorkflowRun>(id, (current) => patchStep({
        ...current, status: "verification_pending", error: undefined,
        summary: `活动 ${current.activityId} 已创建并完成绑定，但暂时无法回查详情。`,
        warnings: [...current.warnings.filter((item) => !item.startsWith("回查失败：")), `回查失败：${errorMessage(error)}`],
      }, "verify", { status: "pending", detail: "等待重新核验", error: errorMessage(error) }));
    }
  }

  private validateInput(input: FlashSaleWorkflowInput): void {
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
    return run;
  }
}

export const flashSaleWorkflowEngine = new FlashSaleWorkflowEngine();

export async function startFlashSaleWorkflow(input: FlashSaleWorkflowInput): Promise<FlashSaleWorkflowRun> {
  const run = await flashSaleWorkflowEngine.create(input);
  void flashSaleWorkflowEngine.run(run.id).catch(() => undefined);
  return run;
}

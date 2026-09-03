import { createHash, randomUUID } from "node:crypto";
import type { ActionPlan, ChatRequest, SkuPricingInput, SkuPricingRecord } from "../shared/contracts.ts";
import { ActionPlanStore, actionPlanStore } from "./action-plan-store.ts";
import { applySkuPricing, type ProductPricingValues } from "./pricing-sync.ts";
import { PricingStore, pricingStore } from "./pricing-store.ts";

type PricingField = keyof ProductPricingValues;

interface StoredPricingAction {
  core: { id: string; kind: "pricing.update"; expiresAt: string; planHash: string };
  status: ActionPlan["status"];
  plan: ActionPlan;
  recordIds: string[];
  values: ProductPricingValues;
  before: Record<string, Partial<Record<PricingField, number>>>;
}

const FIELD_META: Record<PricingField, { label: string; unit: string }> = {
  purchasePriceCny: { label: "采购价", unit: " CNY" },
  weightKg: { label: "单件重量", unit: " kg" },
  exchangeRateCnyToThb: { label: "人民币兑泰铢", unit: "" },
  domesticLogisticsCny: { label: "国内物流", unit: " CNY" },
  cloudWarehouseCny: { label: "云仓成本", unit: " CNY" },
  buyerLocalDeliveryThb: { label: "当地配送", unit: " THB" },
  advertisingThb: { label: "广告费", unit: " THB" },
  creatorCommissionRate: { label: "达人佣金", unit: "%" },
  taxRate: { label: "税率", unit: "%" },
  categoryCommissionRate: { label: "平台佣金", unit: "%" },
};

function fieldValue(record: SkuPricingRecord, field: PricingField): number {
  return record.input[field] as number;
}

function displayValue(field: PricingField, value: number): string {
  const meta = FIELD_META[field];
  const shown = meta.unit === "%" ? value * 100 : value;
  return `${Number(shown.toFixed(4))}${meta.unit}`;
}

function sameValue(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

function actionHash(input: Pick<StoredPricingAction, "recordIds" | "values" | "before">): string {
  return createHash("sha256").update(JSON.stringify({
    recordIds: input.recordIds,
    values: input.values,
    before: input.before,
  })).digest("hex").slice(0, 12);
}

function referencedIds(text: string): string[] {
  return [...new Set(text.match(/\b[\w-]{5,40}\b/g) ?? [])];
}

function targetRecords(request: ChatRequest, records: SkuPricingRecord[], defaultRecords = records): SkuPricingRecord[] {
  const text = request.message;
  const explicit = referencedIds(text);
  const exact = records.filter((record) => explicit.some((id) =>
    [record.id, record.tiktokProductId, record.tiktokSkuId, record.sellerSku, record.skuKey, record.sourceItemId, record.platformDetailId]
      .some((value) => value?.toLowerCase() === id.toLowerCase())));
  if (exact.length) {
    const productIds = new Set(exact.map((record) => record.tiktokProductId).filter(Boolean));
    const mentionsSku = /SKU(?:\s*ID)?/i.test(text);
    if (!mentionsSku && productIds.size === 1) {
      const productId = [...productIds][0];
      return records.filter((record) => record.tiktokProductId === productId);
    }
    return exact;
  }

  if (/(全部|所有|全店|统一)/i.test(text)) return defaultRecords;

  const titleMatches = records.filter((record) => record.productTitle && text.includes(record.productTitle));
  if (titleMatches.length) return titleMatches;

  if (/(这个|该|当前|刚才).*(商品|SKU)/i.test(text)) {
    for (const entry of [...(request.history ?? [])].reverse()) {
      const historyText = `${entry.content}\n${JSON.stringify(entry.artifact ?? {})}`;
      const historyIds = referencedIds(historyText);
      const historyMatches = records.filter((record) => historyIds.some((id) =>
        id === record.tiktokProductId || id === record.tiktokSkuId || id === record.sellerSku || id === record.skuKey));
      const productIds = new Set(historyMatches.map((record) => record.tiktokProductId).filter(Boolean));
      if (productIds.size === 1) {
        const productId = [...productIds][0];
        return records.filter((record) => record.tiktokProductId === productId);
      }
    }
  }
  return [];
}

function validateValues(values: ProductPricingValues): void {
  const entries = Object.entries(values) as Array<[PricingField, number]>;
  if (!entries.length) throw new Error("没有识别到需要修改的成本。请说明字段和新值。");
  for (const [field, value] of entries) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${FIELD_META[field].label}不能小于 0。`);
    if (["purchasePriceCny", "weightKg", "exchangeRateCnyToThb"].includes(field) && value <= 0) {
      throw new Error(`${FIELD_META[field].label}必须大于 0。`);
    }
    if (["creatorCommissionRate", "taxRate", "categoryCommissionRate"].includes(field) && value > 1) {
      throw new Error(`${FIELD_META[field].label}不能超过 100%。`);
    }
  }
}

export class PricingAgent {
  constructor(
    private readonly records = pricingStore,
    private readonly plans = actionPlanStore,
  ) {}

  prepare(request: ChatRequest, values: ProductPricingValues): ActionPlan {
    validateValues(values);
    const allRecords = this.records.list();
    const wantsDrafts = /(?:上架|商品|SKU)?草稿|待上架|未发布|1688/i.test(request.message);
    const wantsInactive = /非在售|已下架|下架商品|停用商品|已删除商品/i.test(request.message);
    const defaultRecords = allRecords.filter((record) => wantsDrafts
      ? !(record.tiktokProductId && record.tiktokSkuId)
      : wantsInactive
        ? Boolean(record.tiktokProductId && record.tiktokSkuId && record.tiktokStatus === "INACTIVE")
        : Boolean(record.tiktokProductId && record.tiktokSkuId)
          && (record.tiktokStatus === "ACTIVATE" || !record.tiktokStatus));
    const targets = targetRecords(request, allRecords, defaultRecords);
    if (!targets.length) {
      throw new Error("请告诉我要修改哪个商品。可以提供商品或 SKU 编号，或明确说“全部在售商品”“全部非在售商品”或“全部上架草稿”。");
    }
    const recordIds = targets.map((record) => record.id).sort();
    const fields = Object.keys(values) as PricingField[];
    const before = Object.fromEntries(targets.map((record) => [record.id,
      Object.fromEntries(fields.map((field) => [field, fieldValue(record, field)]))])) as StoredPricingAction["before"];
    const id = randomUUID();
    const hashInput = { recordIds, values, before };
    const planHash = actionHash(hashInput);
    const products = new Set(targets.map((record) => record.tiktokProductId ?? record.workflowId));
    const targetLabel = targets.length === 1
      ? targets[0].skuName
      : products.size === 1 ? `${targets[0].productTitle ?? targets[0].tiktokProductId} · ${targets.length} 个 SKU` : `全部 ${targets.length} 个 SKU`;
    const diffs = fields.map((field) => {
      const current = [...new Set(targets.map((record) => fieldValue(record, field)))];
      return {
        target: targetLabel,
        field: FIELD_META[field].label,
        before: current.length === 1 ? displayValue(field, current[0]) : "各 SKU 不同",
        after: displayValue(field, values[field] as number),
      };
    });
    const plan: ActionPlan = {
      id,
      tool: "pricing.update",
      title: "修改 SKU 成本设置",
      summary: "审核通过后只更新本地利润台账并重新计算，不会修改 TikTok 店铺价格、库存或商品状态。",
      store: "本地 SKU 台账",
      risk: targets.length > 50 ? "medium" : "low",
      diffs,
      impactCount: targets.length,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: "pending",
      planHash,
    };
    this.plans.save<StoredPricingAction>({
      core: { id, kind: "pricing.update", expiresAt: plan.expiresAt, planHash },
      status: "pending",
      plan,
      recordIds,
      values,
      before,
    });
    return plan;
  }

  get(id: string): StoredPricingAction | undefined {
    const stored = this.plans.get<StoredPricingAction>(id);
    return stored?.core.kind === "pricing.update" ? stored : undefined;
  }

  approve(id: string): { plan: ActionPlan; updated: number; requestId: string; completedAt: string } {
    const stored = this.get(id);
    if (!stored) throw new Error("找不到该成本修改计划。");
    if (stored.status !== "pending") throw new Error("该成本修改计划已经处理，不能重复提交。");
    if (new Date(stored.core.expiresAt).getTime() < Date.now()) {
      this.save(stored, "expired");
      throw new Error("成本修改计划已过期，请重新发送原指令。");
    }
    if (stored.core.planHash !== actionHash(stored)) throw new Error("成本修改计划完整性校验失败。");
    for (const recordId of stored.recordIds) {
      const current = this.records.get(recordId);
      if (!current) throw new Error("SKU 台账已经变化，请重新生成审核计划。");
      for (const [field, value] of Object.entries(stored.before[recordId]) as Array<[PricingField, number]>) {
        if (!sameValue(fieldValue(current, field), value)) throw new Error("审批期间 SKU 成本已经变化，请重新生成审核计划。");
      }
    }
    this.save(stored, "executing");
    try {
      const result = applySkuPricing(this.records, stored.recordIds, stored.values);
      this.save(stored, "approved");
      return {
        plan: stored.plan,
        updated: result.updated,
        requestId: `local_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.save(stored, "verification_pending");
      throw error;
    }
  }

  reject(id: string): ActionPlan | undefined {
    const stored = this.get(id);
    if (!stored) return undefined;
    if (stored.status !== "pending") throw new Error("该成本修改计划已经处理。");
    this.save(stored, "rejected");
    return stored.plan;
  }

  private save(stored: StoredPricingAction, status: ActionPlan["status"]): void {
    stored.status = status;
    stored.plan.status = status;
    this.plans.save(stored);
  }
}

export const pricingAgent = new PricingAgent();

export function editablePricingValues(input: { defaults: Partial<SkuPricingInput>; skuValues: Partial<SkuPricingInput> }): ProductPricingValues {
  const merged = { ...input.defaults, ...input.skuValues };
  const allowed = Object.keys(FIELD_META) as PricingField[];
  return Object.fromEntries(allowed.flatMap((field) => merged[field] === undefined ? [] : [[field, merged[field]]])) as ProductPricingValues;
}

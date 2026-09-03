import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionPlanStore } from "../server/action-plan-store.ts";
import { PricingAgent } from "../server/pricing-agent.ts";
import { calculateSkuPricing } from "../server/pricing-engine.ts";
import { PricingStore } from "../server/pricing-store.ts";
import type { SkuPricingInput, SkuPricingRecord } from "../shared/contracts.ts";

describe("Product management agent", () => {
  let directory: string;
  let records: PricingStore;
  let agent: PricingAgent;

  const input: SkuPricingInput = {
    salePriceThb: 199, purchasePriceCny: 5, weightKg: 0.3, exchangeRateCnyToThb: 4.8503,
    domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79,
    advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107,
    crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07,
    growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0,
  };

  const record = (id: string, productId: string, skuId: string): SkuPricingRecord => ({
    id, workflowId: `workflow-${productId}`, tiktokProductId: productId, tiktokSkuId: skuId,
    productTitle: `商品 ${productId}`, skuKey: skuId, skuName: skuId, currency: "THB",
    input: { ...input }, result: calculateSkuPricing(input), fieldSources: {}, missingFields: [],
    calculatedAt: "2026-07-29T00:00:00.000Z",
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-pricing-agent-"));
    records = new PricingStore(path.join(directory, "pricing.sqlite"));
    records.upsert([
      record("r1", "1736564041031648641", "1736564041031714177"),
      record("r2", "1736564041031648641", "1736564041031714178"),
      record("r3", "1736564041031648642", "1736564041031714179"),
      { ...record("inactive-1", "1736564041031648643", "1736564041031714180"), tiktokStatus: "INACTIVE" },
      {
        ...record("draft-1", "draft", "draft-sku"),
        workflowId: "draft-workflow",
        sourceItemId: "796658717915",
        tiktokProductId: undefined,
        tiktokSkuId: undefined,
        productTitle: "待上架商品",
      },
    ]);
    agent = new PricingAgent(records, new ActionPlanStore(path.join(directory, "actions.sqlite")));
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("requires approval before changing every SKU under one product", () => {
    const plan = agent.prepare({
      message: "把商品 1736564041031648641 的广告费改成 20 THB，达人佣金改成 15%",
      storeId: "shop-1",
    }, { advertisingThb: 20, creatorCommissionRate: 0.15 });

    expect(plan).toMatchObject({ tool: "pricing.update", status: "pending", impactCount: 2 });
    expect(records.get("r1")?.input.advertisingThb).toBe(0);

    const result = agent.approve(plan.id);
    expect(result.updated).toBe(2);
    expect(records.get("r1")?.input).toMatchObject({ advertisingThb: 20, creatorCommissionRate: 0.15 });
    expect(records.get("r2")?.input.advertisingThb).toBe(20);
    expect(records.get("r3")?.input.advertisingThb).toBe(0);
    expect(() => agent.approve(plan.id)).toThrow("不能重复提交");
  });

  it("targets only store SKU records with a generic all-products instruction", () => {
    const plan = agent.prepare({ message: "达人佣金统一改成 10%", storeId: "shop-1" }, { creatorCommissionRate: 0.1 });
    expect(plan.impactCount).toBe(3);
    agent.approve(plan.id);
    expect(records.list().filter((item) => item.tiktokSkuId && item.tiktokStatus !== "INACTIVE")
      .every((item) => item.input.creatorCommissionRate === 0.1)).toBe(true);
    expect(records.get("inactive-1")?.input.creatorCommissionRate).toBe(0);
    expect(records.get("draft-1")?.input.creatorCommissionRate).toBe(0);
  });

  it("targets draft records only when the instruction explicitly says drafts", () => {
    const plan = agent.prepare({ message: "全部上架草稿的达人佣金改成 8%", storeId: "shop-1" }, { creatorCommissionRate: 0.08 });
    expect(plan.impactCount).toBe(1);
    agent.approve(plan.id);
    expect(records.get("draft-1")?.input.creatorCommissionRate).toBe(0.08);
    expect(records.get("r1")?.input.creatorCommissionRate).toBe(0);
  });

  it("targets inactive records only when explicitly requested", () => {
    const plan = agent.prepare({ message: "全部非在售商品的达人佣金改成 6%", storeId: "shop-1" }, { creatorCommissionRate: 0.06 });
    expect(plan.impactCount).toBe(1);
    agent.approve(plan.id);
    expect(records.get("inactive-1")?.input.creatorCommissionRate).toBe(0.06);
    expect(records.get("r1")?.input.creatorCommissionRate).toBe(0);
  });

  it("stops approval when a selected SKU changed after the card was created", () => {
    const plan = agent.prepare({ message: "商品 1736564041031648641 国内物流改成 3 元", storeId: "shop-1" }, { domesticLogisticsCny: 3 });
    records.update("r1", (current) => ({ ...current, input: { ...current.input, domesticLogisticsCny: 4 } }));
    expect(() => agent.approve(plan.id)).toThrow("审批期间 SKU 成本已经变化");
  });
});

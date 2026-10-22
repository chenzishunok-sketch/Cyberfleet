import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityProductBody, FlashSaleWorkflowEngine, type FlashSaleWorkflowTools } from "../server/flash-sale-workflow.ts";
import { WorkflowStore } from "../server/workflow-store.ts";

function input() {
  return {
    productId: "1736564041031648641",
    activityTitle: "Summer Flash Sale",
    startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    priceAmount: "299",
    currency: "JPY",
    skuQuantityLimit: 50,
    quantityPerUser: 2,
  };
}

function tools(overrides: Partial<FlashSaleWorkflowTools> = {}): FlashSaleWorkflowTools {
  return {
    context: vi.fn().mockResolvedValue({ shopId: "shop-jp", shopName: "Japan Store", region: "JP", scopes: ["seller.promotion.write"] }),
    product: vi.fn().mockResolvedValue({ id: "1736564041031648641", title: "Test Product", status: "ACTIVATE", skus: [
      { id: "sku-1", sellerSku: "BLACK", availableStock: 80 },
      { id: "sku-2", sellerSku: "WHITE", availableStock: 60 },
    ] }),
    createActivity: vi.fn().mockResolvedValue({ activityId: "activity-1", status: "NOT_START", requestId: "create-request" }),
    bindProduct: vi.fn().mockResolvedValue({ requestId: "bind-request" }),
    activity: vi.fn().mockResolvedValue({ id: "activity-1", status: "NOT_START", products: [{ id: "1736564041031648641", skus: [
      { id: "sku-1", priceAmount: "299", currency: "JPY", quantityLimit: 50, quantityPerUser: 2 },
      { id: "sku-2", priceAmount: "299", currency: "JPY", quantityLimit: 50, quantityPerUser: 2 },
    ] }] }),
    ...overrides,
  };
}

describe("Flash sale workflow", () => {
  let directory: string;
  let store: WorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-flash-sale-"));
    store = new WorkflowStore(path.join(directory, "runs.json"));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("checks product and inventory, waits for confirmation, then verifies the activity", async () => {
    const fakeTools = tools();
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    const ready = await engine.run(created.id);
    expect(ready).toMatchObject({ status: "waiting_confirmation", productTitle: "Test Product", confirmationKind: "flash_sale" });
    expect(ready.selectedSkus).toHaveLength(2);
    expect(fakeTools.createActivity).not.toHaveBeenCalled();

    const completed = await engine.approve(created.id);
    expect(completed).toMatchObject({ status: "completed", activityId: "activity-1", activityStatus: "NOT_START" });
    expect(fakeTools.createActivity).toHaveBeenCalledTimes(1);
    expect(fakeTools.bindProduct).toHaveBeenCalledTimes(1);
  });

  it("keeps the activity id when binding fails and retries only the binding step", async () => {
    const bindProduct = vi.fn().mockRejectedValueOnce(new Error("SKU conflict")).mockResolvedValueOnce({ requestId: "bind-request-2" });
    const fakeTools = tools({ bindProduct });
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    await engine.run(created.id);

    const failed = await engine.approve(created.id);
    expect(failed).toMatchObject({ status: "failed", activityId: "activity-1", error: "SKU conflict" });
    expect(failed.summary).toContain("活动 activity-1 已创建");

    const completed = await engine.retry(created.id);
    expect(completed.status).toBe("completed");
    expect(fakeTools.createActivity).toHaveBeenCalledTimes(1);
    expect(bindProduct).toHaveBeenCalledTimes(2);
  });

  it("stops before confirmation when requested inventory exceeds a SKU's stock", async () => {
    const fakeTools = tools();
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create({ ...input(), skuQuantityLimit: 99 });
    const failed = await engine.run(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("超过");
    expect(fakeTools.createActivity).not.toHaveBeenCalled();
  });

  it("prices the whole product by default and sends no skus in the bind payload", async () => {
    const fakeTools = tools();
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    expect(created.pricingLevel).toBe("PRODUCT");
    await engine.run(created.id);
    const completed = await engine.approve(created.id);
    expect(completed.status).toBe("completed");
    expect(fakeTools.createActivity).toHaveBeenCalledWith(expect.objectContaining({ pricingLevel: "PRODUCT" }));
    expect(fakeTools.bindProduct).toHaveBeenCalledWith(expect.objectContaining({ level: "PRODUCT", priceAmount: "299" }));
    // 整品级 body 不能带 skus：带上会被平台判成结构错误
    const body = activityProductBody({ productId: "1736564041031648641", level: "PRODUCT", skuIds: ["sku-1"], priceAmount: "299", quantityLimit: 50, quantityPerUser: 2 });
    expect(body).toEqual({ id: "1736564041031648641", activity_price_amount: "299", quantity_limit: 50, quantity_per_user: 2 });
    expect(body).not.toHaveProperty("skus");
  });

  it("switches to per-SKU pricing when SKUs are given and keeps the sku payload", async () => {
    const fakeTools = tools();
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create({ ...input(), skuIds: ["sku-2"] });
    expect(created.pricingLevel).toBe("VARIATION");
    await engine.run(created.id);
    const completed = await engine.approve(created.id);
    expect(completed.status).toBe("completed");
    expect(fakeTools.bindProduct).toHaveBeenCalledWith(expect.objectContaining({ level: "VARIATION", skuIds: ["sku-2"] }));
    expect(activityProductBody({ productId: "1736564041031648641", level: "VARIATION", skuIds: ["sku-2"], priceAmount: "299", quantityLimit: 50, quantityPerUser: 2 })).toEqual({
      id: "1736564041031648641",
      quantity_limit: -1,
      quantity_per_user: -1,
      skus: [{ id: "sku-2", activity_price_amount: "299", quantity_limit: 50, quantity_per_user: 2 }],
    });
  });

  it("refuses a SKU subset when the activity is priced per product", async () => {
    const engine = new FlashSaleWorkflowEngine(store, tools());
    await expect(engine.create({ ...input(), pricingLevel: "PRODUCT", skuIds: ["sku-1"] })).rejects.toThrow("不能同时指定 SKU 子集");
  });

  it("warns before approval when the activity price is not below the current sale price", async () => {
    const fakeTools = tools({
      product: vi.fn().mockResolvedValue({ id: "1736564041031648641", title: "Test Product", status: "ACTIVATE", skus: [
        { id: "sku-1", sellerSku: "BLACK", availableStock: 80, salePrice: "299" },
        { id: "sku-2", sellerSku: "WHITE", availableStock: 60, salePrice: "299" },
      ] }),
    });
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    const ready = await engine.run(created.id);
    expect(ready.status).toBe("waiting_confirmation");
    expect(ready.warnings.join(" ")).toContain("不低于");
  });

  it("verifies the whole-product activity price from the product node", async () => {
    const fakeTools = tools({
      activity: vi.fn().mockResolvedValue({ id: "activity-1", status: "NOT_START", products: [
        { id: "1736564041031648641", priceAmount: "299", quantityLimit: 50, quantityPerUser: 2, skus: [] },
      ] }),
    });
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    await engine.run(created.id);
    const finished = await engine.approve(created.id);
    expect(finished.status).toBe("completed");
    expect(finished.summary).toContain("整品活动价");
  });

  it("does not claim success when the platform returns nothing to compare", async () => {
    const fakeTools = tools({
      activity: vi.fn().mockResolvedValue({ id: "activity-1", status: "NOT_START", products: [
        { id: "1736564041031648641", skus: [] },
      ] }),
    });
    const engine = new FlashSaleWorkflowEngine(store, fakeTools);
    const created = await engine.create(input());
    await engine.run(created.id);
    const finished = await engine.approve(created.id);
    expect(finished.status).toBe("verification_pending");
    expect(finished.summary).toContain("没有返回可用于核对的活动价字段");
  });
});

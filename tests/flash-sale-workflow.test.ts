import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashSaleWorkflowEngine, type FlashSaleWorkflowTools } from "../server/flash-sale-workflow.ts";
import { WorkflowStore } from "../server/workflow-store.ts";

function input() {
  return {
    productId: "1736564041031648641",
    activityTitle: "Summer Flash Sale",
    startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    priceAmount: "299",
    currency: "THB",
    skuQuantityLimit: 50,
    quantityPerUser: 2,
  };
}

function tools(overrides: Partial<FlashSaleWorkflowTools> = {}): FlashSaleWorkflowTools {
  return {
    context: vi.fn().mockResolvedValue({ shopId: "shop-th", shopName: "Thailand Store", region: "TH", scopes: ["seller.promotion.write"] }),
    product: vi.fn().mockResolvedValue({ id: "1736564041031648641", title: "Test Product", status: "ACTIVATE", skus: [
      { id: "sku-1", sellerSku: "BLACK", availableStock: 80 },
      { id: "sku-2", sellerSku: "WHITE", availableStock: 60 },
    ] }),
    createActivity: vi.fn().mockResolvedValue({ activityId: "activity-1", status: "NOT_START", requestId: "create-request" }),
    bindProduct: vi.fn().mockResolvedValue({ requestId: "bind-request" }),
    activity: vi.fn().mockResolvedValue({ id: "activity-1", status: "NOT_START", products: [{ id: "1736564041031648641", skus: [
      { id: "sku-1", priceAmount: "299", currency: "THB", quantityLimit: 50, quantityPerUser: 2 },
      { id: "sku-2", priceAmount: "299", currency: "THB", quantityLimit: 50, quantityPerUser: 2 },
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
});

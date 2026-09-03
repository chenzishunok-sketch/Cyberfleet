import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProductPublishWorkflowEngine,
  type ProductPublishWorkflowTools,
} from "../server/product-publish-workflow.ts";
import type { ProductPublishWorkflowRun } from "../shared/contracts.ts";
import { WorkflowStore } from "../server/workflow-store.ts";
import { PricingStore } from "../server/pricing-store.ts";
import { calculateSkuPricing } from "../server/pricing-engine.ts";

describe("Product publishing workflow", () => {
  let directory: string;
  let store: WorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-workflow-"));
    store = new WorkflowStore(path.join(directory, "runs.json"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("does not write to Miaoshou until the start card is approved", async () => {
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-start", commonDetailId: "10000" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20000" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/100000.html" });
    expect(created.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      "运营总监 · 检查连接并选择店铺",
      "采集 Agent · 采集 1688 商品",
      "定价 Agent · 计算 SKU 成本和利润",
      "上架 Agent · 发布到 TikTok 店铺",
    ]));

    const approval = await engine.requestStartApproval(created.id);
    expect(approval).toMatchObject({ status: "waiting_confirmation", confirmationKind: "workflow_start" });
    expect(tools.listShops).not.toHaveBeenCalled();
    expect(tools.collect).not.toHaveBeenCalled();

    const started = await engine.approve(created.id);
    expect(tools.listShops).toHaveBeenCalledTimes(1);
    expect(tools.collect).toHaveBeenCalledTimes(1);
    expect(tools.claimToTikTok).toHaveBeenCalledTimes(1);
    expect(started).toMatchObject({ status: "waiting_confirmation", confirmationKind: "product_publish" });
  });

  it("waits for shop selection and confirmation, then persists a verified result", async () => {
    let verificationCount = 0;
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([
        { id: "shop-th", name: "Thailand Store", site: "TH" },
        { id: "shop-us", name: "US Store", site: "US" },
      ]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-1", commonDetailId: "10001" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20001" }),
      enrich: vi.fn().mockResolvedValue({ categoryId: "30001", warnings: [] }),
      diagnose: vi.fn().mockResolvedValue({ productTitle: "Test product", categoryId: "30001", blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({ requestId: "publish-1" }),
      verify: vi.fn().mockImplementation(async () => {
        verificationCount += 1;
        return verificationCount === 1
          ? { matched: false, summary: "发布记录还在生成。" }
          : { matched: true, summary: "已核验发布记录。" };
      }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);

    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/123456.html" });
    const needsShop = await engine.run(created.id);
    expect(needsShop.status).toBe("waiting_input");
    expect(needsShop.requiredInput?.kind).toBe("shop");
    if (needsShop.requiredInput?.kind !== "shop") throw new Error("应该等待选择店铺。");
    expect(needsShop.requiredInput.options).toHaveLength(2);
    expect(tools.collect).not.toHaveBeenCalled();

    const needsConfirmation = await engine.selectShop(created.id, "shop-th");
    expect(needsConfirmation.status).toBe("waiting_confirmation");
    expect(needsConfirmation).toMatchObject({
      shopId: "shop-th",
      shopSite: "TH",
      targetLanguage: "th",
      commonDetailId: "10001",
      platformDetailId: "20001",
      categoryId: "30001",
    });
    expect(tools.publish).not.toHaveBeenCalled();

    const submitted = await engine.approve(created.id);
    expect(submitted.status).toBe("verification_pending");
    expect(tools.publish).toHaveBeenCalledTimes(1);

    const completed = await engine.verify(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.steps.every((step) => step.status === "completed")).toBe(true);
    expect(tools.publish).toHaveBeenCalledTimes(1);

    const reloaded = await new WorkflowStore(path.join(directory, "runs.json")).get(created.id);
    expect(reloaded).toMatchObject({ status: "completed", publishRequestId: "publish-1" });
  });

  it("retries only the failed part and keeps earlier progress", async () => {
    let collectionCount = 0;
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-us", name: "US Store", site: "US" }]),
      collect: vi.fn().mockImplementation(async () => {
        collectionCount += 1;
        if (collectionCount === 1) throw new Error("采集服务暂时忙");
        return { sourceItemId: "source-2", commonDetailId: "10002" };
      }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20002" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);

    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/654321.html" });
    const failed = await engine.run(created.id);
    expect(failed).toMatchObject({ status: "failed", error: "采集服务暂时忙" });
    expect(failed.steps.find((step) => step.id === "prepare")?.status).toBe("completed");
    expect(failed.steps.find((step) => step.id === "collect")?.status).toBe("failed");

    const resumed = await engine.retry(created.id);
    expect(resumed.status).toBe("waiting_confirmation");
    expect(tools.listShops).toHaveBeenCalledTimes(1);
    expect(tools.collect).toHaveBeenCalledTimes(2);
    expect(tools.claimToTikTok).toHaveBeenCalledTimes(1);
  });

  it("rechecks a pending publish before offering a confirmed resubmission", async () => {
    let verificationCount = 0;
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-pending", commonDetailId: "10005" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20005" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({ requestId: "publish-pending" }),
      verify: vi.fn().mockImplementation(async () => {
        verificationCount += 1;
        return verificationCount < 3
          ? { matched: false, summary: "仍未上架。" }
          : { matched: true, summary: "重新提交后已上架。" };
      }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/333333.html" });
    const ready = await engine.run(created.id);
    expect(ready.status).toBe("waiting_confirmation");

    const pending = await engine.approve(created.id);
    expect(pending.status).toBe("verification_pending");
    expect(tools.publish).toHaveBeenCalledTimes(1);

    const awaitingResubmit = await engine.retry(created.id);
    expect(awaitingResubmit).toMatchObject({
      status: "waiting_confirmation",
      confirmationKind: "product_publish",
    });
    expect(awaitingResubmit.summary).toContain("不会重复采集或认领");
    expect(tools.collect).toHaveBeenCalledTimes(1);
    expect(tools.claimToTikTok).toHaveBeenCalledTimes(1);
    expect(tools.publish).toHaveBeenCalledTimes(1);

    const completed = await engine.approve(created.id);
    expect(completed.status).toBe("completed");
    expect(tools.publish).toHaveBeenCalledTimes(2);
    expect(tools.collect).toHaveBeenCalledTimes(1);
    expect(tools.claimToTikTok).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when a publish has remained unverified for over 24 hours", async () => {
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-timeout", commonDetailId: "10006" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20006" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({ requestId: "publish-timeout" }),
      verify: vi.fn().mockResolvedValue({ matched: false, summary: "仍未上架。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/444444.html" });
    await engine.run(created.id);
    const pending = await engine.approve(created.id);
    expect(pending.status).toBe("verification_pending");

    await store.update<ProductPublishWorkflowRun>(created.id, (run) => ({
      ...run,
      steps: run.steps.map((step) => step.id === "publish"
        ? { ...step, completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }
        : step),
    }));
    const expired = await engine.verify(created.id);

    expect(expired).toMatchObject({ status: "failed", error: "发布结果核验超时" });
    expect(expired.steps.find((step) => step.id === "verify")?.status).toBe("failed");
  });

  it("blocks publishing until missing product data is fixed and rechecked", async () => {
    let diagnosisCount = 0;
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-3", commonDetailId: "10003" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20003" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      diagnose: vi.fn().mockImplementation(async () => {
        diagnosisCount += 1;
        return diagnosisCount === 1
          ? { blockingIssues: ["包裹尺寸未填写。"], warnings: [] }
          : { blockingIssues: [], warnings: [] };
      }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);

    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/111111.html" });
    const blocked = await engine.run(created.id);
    expect(blocked.status).toBe("waiting_input");
    expect(blocked.requiredInput).toMatchObject({ kind: "product_data", issues: ["包裹尺寸未填写。"] });
    expect(blocked.steps.find((step) => step.id === "validate")?.status).toBe("failed");
    expect(tools.publish).not.toHaveBeenCalled();

    const ready = await engine.recheckReadiness(created.id);
    expect(ready.status).toBe("waiting_confirmation");
    expect(ready.steps.find((step) => step.id === "validate")?.status).toBe("completed");
    expect(tools.collect).toHaveBeenCalledTimes(1);
    expect(tools.claimToTikTok).toHaveBeenCalledTimes(1);
  });

  it("previews and confirms a full-detail edit before the final publish confirmation", async () => {
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-4", commonDetailId: "10004" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20004" }),
      claimToShop: vi.fn().mockResolvedValue(undefined),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      prepareEdit: vi.fn().mockResolvedValue({ skuCount: 2, changes: [{ field: "全部 2 个 SKU 售价", before: "10 / 12", after: "999" }] }),
      saveEdit: vi.fn().mockResolvedValue(undefined),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({ requestId: "publish-4" }),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/222222.html", publishPrice: 999 });

    const editConfirmation = await engine.run(created.id);
    expect(editConfirmation).toMatchObject({ status: "waiting_confirmation", confirmationKind: "product_edit", publishPrice: 999 });
    expect(tools.saveEdit).not.toHaveBeenCalled();
    expect(tools.publish).not.toHaveBeenCalled();

    const publishConfirmation = await engine.approve(created.id);
    expect(tools.saveEdit).toHaveBeenCalledTimes(1);
    expect(publishConfirmation).toMatchObject({ status: "waiting_confirmation", confirmationKind: "product_publish" });
    expect(tools.publish).not.toHaveBeenCalled();

    const completed = await engine.approve(created.id);
    expect(completed.status).toBe("completed");
    expect(tools.publish).toHaveBeenCalledTimes(1);
  });

  it("asks for package dimensions before the edit is saved", async () => {
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-dimensions", commonDetailId: "10007" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20007" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      prepareEdit: vi.fn().mockResolvedValue({ skuCount: 2, changes: [], missingPackageDimensions: true }),
      saveEdit: vi.fn().mockResolvedValue(undefined),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/777777.html", publishPrice: 99 });

    const waiting = await engine.run(created.id);

    expect(waiting).toMatchObject({
      status: "waiting_input",
      requiredInput: { kind: "product_edit", missing: ["packageDimensions"] },
      summary: "已保留 2 个 SKU，等待补充包裹尺寸。",
    });
    expect(tools.saveEdit).not.toHaveBeenCalled();
  });

  it("creates one persistent profit record per SKU before editing the product", async () => {
    const pricingDb = path.join(directory, "runs.json");
    const skuPricingStore = new PricingStore(pricingDb);
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "648795280915", commonDetailId: "10006" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20006" }),
      enrich: vi.fn().mockResolvedValue({ categoryId: "600686", warnings: [] }),
      preparePricing: vi.fn().mockImplementation(async (run) => {
        const input = { salePriceThb: 99, purchasePriceCny: 3, weightKg: 0.4, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
        return { defaults: { exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0 }, records: [{ id: `${run.id}:sku-1`, workflowId: run.id, sourceItemId: run.sourceItemId, platformDetailId: run.platformDetailId, shopId: run.shopId, skuKey: ";white;large;", skuName: "白色 / 大号", categoryId: "600686", categoryName: "Storage Baskets", currency: "THB" as const, input, result: calculateSkuPricing(input), fieldSources: { purchasePriceCny: "1688" as const, weightKg: "miaoshou" as const }, missingFields: [], calculatedAt: new Date().toISOString() }] };
      }),
      prepareEdit: vi.fn().mockResolvedValue({ skuCount: 1, changes: [] }),
      saveEdit: vi.fn().mockResolvedValue(undefined),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools, skuPricingStore);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/648795280915.html" });
    const needsPricing = await engine.run(created.id);
    expect(needsPricing).toMatchObject({ status: "waiting_input", requiredInput: { kind: "pricing" }, pricingSummary: { totalSkus: 1, lossSkus: 1 } });
    expect(skuPricingStore.listByWorkflow(created.id)).toHaveLength(1);

    const editPreview = await engine.updatePricingInput(created.id, { skus: [{ skuKey: ";white;large;", values: { salePriceThb: 139 } }] });
    expect(editPreview).toMatchObject({ status: "waiting_confirmation", confirmationKind: "product_edit", pricingConfirmed: true });
    expect(tools.prepareEdit).toHaveBeenCalledWith(expect.objectContaining({ skuPrices: { ";white;large;": 139 } }));
    expect(skuPricingStore.history(created.id)).toHaveLength(2);
  });

  it("removes selected SKUs from the pricing records and the Miaoshou edit preview", async () => {
    const skuPricingStore = new PricingStore(path.join(directory, "sku-removal.sqlite"));
    const input = { salePriceThb: 199, purchasePriceCny: 3, weightKg: 0.4, exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0, taxRate: 0.1556, categoryCommissionRate: 0.107, crossBorderThbPer10g: 1, transactionRate: 0.0321, infrastructureFeeThb: 1.07, growthSupportRate: 0.0803, merchantDiscountThb: 0, platformSubsidyThb: 0, platformActivityFeeThb: 0 };
    const tools: ProductPublishWorkflowTools = {
      listShops: vi.fn().mockResolvedValue([{ id: "shop-th", name: "Thailand Store", site: "TH" }]),
      collect: vi.fn().mockResolvedValue({ sourceItemId: "source-skus", commonDetailId: "10008" }),
      claimToTikTok: vi.fn().mockResolvedValue({ platformDetailId: "20008" }),
      enrich: vi.fn().mockResolvedValue({ warnings: [] }),
      preparePricing: vi.fn().mockImplementation(async (run) => ({
        defaults: { exchangeRateCnyToThb: 4.8503, domesticLogisticsCny: 2.5, cloudWarehouseCny: 1.5, buyerLocalDeliveryThb: 79, advertisingThb: 0, creatorCommissionRate: 0 },
        records: ["keep", "remove"].map((skuKey) => ({
          id: `${run.id}:${skuKey}`, workflowId: run.id, sourceItemId: run.sourceItemId,
          platformDetailId: run.platformDetailId, shopId: run.shopId, skuKey, skuName: skuKey,
          currency: "THB" as const, input, result: calculateSkuPricing(input), fieldSources: {},
          missingFields: [], calculatedAt: new Date().toISOString(),
        })),
      })),
      prepareEdit: vi.fn().mockResolvedValue({ skuCount: 1, changes: [] }),
      saveEdit: vi.fn().mockResolvedValue(undefined),
      diagnose: vi.fn().mockResolvedValue({ blockingIssues: [], warnings: [] }),
      publish: vi.fn().mockResolvedValue({}),
      verify: vi.fn().mockResolvedValue({ matched: true, summary: "已核验。" }),
    };
    const engine = new ProductPublishWorkflowEngine(store, tools, skuPricingStore);
    const created = await engine.create({ sourceUrl: "https://detail.1688.com/offer/888888.html" });
    await engine.run(created.id);

    const preview = await engine.updatePricingInput(created.id, { removedSkuKeys: ["remove"] });

    expect(preview.pricingSkus?.map((record) => record.skuKey)).toEqual(["keep"]);
    expect(preview.pricingSummary?.totalSkus).toBe(1);
    expect(tools.prepareEdit).toHaveBeenCalledWith(expect.objectContaining({ selectedSkuKeys: ["keep"] }));
    expect(skuPricingStore.listByWorkflow(created.id).map((record) => record.skuKey)).toEqual(["keep"]);
  });
});

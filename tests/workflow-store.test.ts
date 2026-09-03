import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductPublishWorkflowRun } from "../shared/contracts.ts";
import { WorkflowStore } from "../server/workflow-store.ts";

function run(id = "workflow-1"): ProductPublishWorkflowRun {
  const now = new Date().toISOString();
  return {
    id,
    type: "product_publish",
    title: "1688 商品发布到 TikTok",
    status: "draft",
    sourceUrl: "https://detail.1688.com/offer/123456.html",
    targetPlatform: "tiktok",
    steps: [{ id: "prepare", label: "检查连接", status: "pending" }],
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("SQLite workflow store", () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-sqlite-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("persists current state and an append-only event history", async () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const store = new WorkflowStore(databasePath);
    const created = await store.create(run());
    await store.update<ProductPublishWorkflowRun>(created.id, (current) => ({
      ...current,
      status: "running",
      steps: current.steps.map((step) => ({ ...step, status: "running", detail: "正在读取授权", startedAt: new Date().toISOString() })),
    }));

    const reopened = new WorkflowStore(databasePath);
    expect(await reopened.get(created.id)).toMatchObject({ status: "running" });
    const events = await reopened.history(created.id);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventType: "created", status: "draft" });
    expect(events[1]).toMatchObject({ eventType: "updated", status: "running", stepId: "prepare", detail: "正在读取授权" });
  });

  it("migrates the old JSON task file once without deleting it", async () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const legacyPath = path.join(directory, "workflow-runs.json");
    await writeFile(legacyPath, JSON.stringify({ version: 1, runs: [run("legacy-1")] }), "utf8");

    const store = new WorkflowStore(databasePath, legacyPath);
    expect(await store.get("legacy-1")).toMatchObject({ id: "legacy-1", status: "draft" });
    expect((await store.history("legacy-1"))[0]).toMatchObject({ eventType: "migrated", detail: "从旧版 JSON 任务记录迁移" });

    const reopened = new WorkflowStore(databasePath, legacyPath);
    expect(await reopened.list()).toHaveLength(1);
    expect(await reopened.history("legacy-1")).toHaveLength(1);
  });

  it("recovers interrupted workflows without replaying remote writes", async () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const store = new WorkflowStore(databasePath);
    await store.create({
      ...run("publish-interrupted"),
      status: "running",
      shopId: "shop-th",
      platformDetailId: "detail-1",
      steps: [{ id: "publish", label: "发布", status: "running" }],
    });
    await store.create({
      ...run("prepare-interrupted"),
      status: "running",
      steps: [{ id: "prepare", label: "准备", status: "running" }],
    });

    expect(await store.recoverInterruptedRuns()).toEqual({ failed: 1, verificationPending: 1 });
    expect(await store.get("publish-interrupted")).toMatchObject({ status: "verification_pending", steps: [{ status: "pending" }] });
    expect(await store.get("prepare-interrupted")).toMatchObject({ status: "failed", steps: [{ status: "failed" }] });
  });
});

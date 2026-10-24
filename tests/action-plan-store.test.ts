import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionPlanStore } from "../server/action-plan-store.ts";

describe("SQLite action plan store", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-actions-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("keeps immutable write plans and their approval state across store instances", () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const pending = {
      core: { id: "plan-1", kind: "price.update", expiresAt: new Date(Date.now() + 60_000).toISOString(), payloadJson: "{}", planHash: "hash-1" },
      status: "pending",
    };
    new ActionPlanStore(databasePath).save(pending);
    const reopened = new ActionPlanStore(databasePath);
    expect(reopened.get<typeof pending>("plan-1")).toEqual(pending);

    reopened.save({ ...pending, status: "approved" });
    expect(new ActionPlanStore(databasePath).get<typeof pending>("plan-1")?.status).toBe("approved");
  });

  it("expires stale approvals and marks interrupted writes for verification", () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const store = new ActionPlanStore(databasePath);
    const expired = {
      core: { id: "expired", kind: "miaoshou.operation", expiresAt: "2026-01-01T00:00:00.000Z" },
      status: "pending",
      plan: { status: "pending" },
    };
    const interrupted = {
      core: { id: "interrupted", kind: "price.update", expiresAt: "2027-01-01T00:00:00.000Z" },
      status: "executing",
    };
    store.save(expired);
    store.save(interrupted);

    expect(store.recoverInterruptedPlans(new Date("2026-07-29T00:00:00.000Z").getTime())).toEqual({
      expired: 1,
      verificationPending: 1,
      skipped: 0,
    });
    expect(store.get<typeof expired>("expired")).toMatchObject({ status: "expired", plan: { status: "expired" } });
    expect(store.get<typeof interrupted>("interrupted")?.status).toBe("verification_pending");
  });

  it("一条损坏的记录不会阻断其他计划的恢复", () => {
    const databasePath = path.join(directory, "workflows.sqlite");
    const store = new ActionPlanStore(databasePath);
    store.save({
      core: { id: "bad", kind: "price.update", expiresAt: "2027-01-01T00:00:00.000Z" },
      status: "executing",
    });
    store.save({
      core: { id: "good", kind: "price.update", expiresAt: "2027-01-01T00:00:00.000Z" },
      status: "executing",
    });
    // 直接把 payload 改坏，模拟旧版本写进去的结构已经对不上
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE action_plans SET payload = ? WHERE id = ?").run("{ not json", "bad");
    raw.close();

    const summary = new ActionPlanStore(databasePath).recoverInterruptedPlans(Date.now());
    expect(summary.skipped).toBe(1);
    expect(summary.verificationPending).toBe(1);
    // 关键：坏数据后面的那条照样恢复，不会因为一条脏数据整批丢掉
    expect(store.get<{ status: string }>("good")?.status).toBe("verification_pending");
    expect(store.get("bad")).toBeUndefined();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KolCreator, KolStats } from "../shared/contracts.ts";
import { KolOutreachWorkflowEngine, type KolOutreachWorkflowTools } from "../server/kol-outreach-workflow.ts";
import { WorkflowStore } from "../server/workflow-store.ts";

const creators: KolCreator[] = [
  { id: "creator-1", nickname: "Beauty One", followerCount: 180_000, category: "美妆" },
  { id: "creator-2", nickname: "Beauty Two", followerCount: 130_000, category: "美妆" },
];

const beforeStats: KolStats = { totalInvited: 20, success: 12, pending: 6, failed: 2, totalCreators: 2, tasksTotal: 3 };
const afterStats: KolStats = { ...beforeStats, totalInvited: 22, success: 14, tasksTotal: 4 };

function input() {
  return {
    category: "美妆",
    minFollowers: 100_000,
    commissionRate: 15,
    message: "Hello creator",
    batchSize: 1,
    totalTarget: 2,
    freeSample: true,
  };
}

describe("KOL outreach workflow", () => {
  let directory: string;
  let databasePath: string;
  let store: WorkflowStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "shop-pilot-kol-"));
    databasePath = path.join(directory, "workflows.sqlite");
    store = new WorkflowStore(databasePath);
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("locks real creator ids, waits for confirmation and persists the execution result", async () => {
    let statsReads = 0;
    const tools: KolOutreachWorkflowTools = {
      isConnected: () => true,
      listCreators: vi.fn().mockResolvedValue(creators),
      getStats: vi.fn().mockImplementation(async () => (++statsReads === 1 ? beforeStats : afterStats)),
      execute: vi.fn().mockImplementation(async (_plan, onProgress) => {
        await onProgress({ done: 1, total: 2, group: 1, groupTotal: 2 });
        await onProgress({ done: 2, total: 2, group: 2, groupTotal: 2 });
        return { success: 2, failed: 0, skipped: 0, details: "2 invitations sent" };
      }),
    };
    const engine = new KolOutreachWorkflowEngine(store, tools);

    const ready = await engine.create(input());
    expect(ready).toMatchObject({
      status: "waiting_confirmation",
      confirmationKind: "kol_outreach",
      selectedCreatorIds: ["creator-1", "creator-2"],
      totalTarget: 2,
    });
    expect(tools.execute).not.toHaveBeenCalled();

    const completed = await engine.approve(ready.id);
    expect(completed).toMatchObject({ status: "completed", result: { success: 2, failed: 0, skipped: 0 } });
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(completed.steps.every((step) => step.status === "completed")).toBe(true);

    const reloaded = await new WorkflowStore(databasePath).get(ready.id);
    expect(reloaded).toMatchObject({ status: "completed", type: "kol_outreach", result: { success: 2 } });
  });

  it("waits when the browser extension is offline and resumes without losing the task", async () => {
    let connected = false;
    const tools: KolOutreachWorkflowTools = {
      isConnected: () => connected,
      listCreators: vi.fn().mockResolvedValue(creators),
      getStats: vi.fn().mockResolvedValue(beforeStats),
      execute: vi.fn(),
    };
    const engine = new KolOutreachWorkflowEngine(store, tools);

    const waiting = await engine.create(input());
    expect(waiting).toMatchObject({ status: "waiting_input", requiredInput: { kind: "kol_bridge" } });
    expect(tools.listCreators).not.toHaveBeenCalled();

    connected = true;
    const resumed = await engine.retry(waiting.id);
    expect(resumed).toMatchObject({ status: "waiting_confirmation", selectedCreatorIds: ["creator-1", "creator-2"] });
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("refreshes a changed creator list and asks for confirmation again", async () => {
    const listCreators = vi.fn()
      .mockResolvedValueOnce(creators)
      .mockResolvedValueOnce([creators[1], creators[0]]);
    const tools: KolOutreachWorkflowTools = {
      isConnected: () => true,
      listCreators,
      getStats: vi.fn().mockResolvedValue(beforeStats),
      execute: vi.fn(),
    };
    const engine = new KolOutreachWorkflowEngine(store, tools);
    const ready = await engine.create(input());

    const refreshed = await engine.approve(ready.id);
    expect(refreshed.status).toBe("waiting_confirmation");
    expect(refreshed.selectedCreatorIds).toEqual(["creator-2", "creator-1"]);
    expect(refreshed.summary).toContain("重新确认");
    expect(tools.execute).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const testDataDirectory = mkdtempSync(path.join(os.tmpdir(), "cyberfleet-tests-"));

process.env.WORKFLOW_DATABASE = path.join(testDataDirectory, "workflows.sqlite");
process.env.ACTION_PLAN_DATABASE = path.join(testDataDirectory, "action-plans.sqlite");
process.env.INTELLIGENCE_DATABASE = path.join(testDataDirectory, "intelligence.sqlite");
process.env.AGENT_MEMORY_PATH = path.join(testDataDirectory, "memory.json");
process.env.WORKFLOW_STORE = path.join(testDataDirectory, "workflow-runs.json");
process.env.TIKTOK_SHOP_TOKEN_STORE = path.join(testDataDirectory, "authorization.json");

afterAll(() => {
  rmSync(testDataDirectory, { recursive: true, force: true });
});

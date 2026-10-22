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
// 技能凭证（含 TikTok App Key/Secret）也隔离到临时目录，避免读到开发机的 .data/skills.json
process.env.SKILLS_STORE = path.join(testDataDirectory, "skills.json");
// 大模型供应商绑定同样隔离，测试统一走 .env 兜底路径
process.env.LLM_PROVIDERS_STORE = path.join(testDataDirectory, "llm-providers.json");

afterAll(() => {
  rmSync(testDataDirectory, { recursive: true, force: true });
});

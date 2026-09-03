import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { addPreference, loadMemory, recordOperation, saveMemory, type AgentMemory } from "../server/memory.ts";

describe("agent memory", () => {
  let testDirectory: string;
  let testMemoryPath: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    testMemoryPath = path.join(testDirectory, "memory.json");
  });

  beforeEach(async () => {
    vi.stubEnv("AGENT_MEMORY_PATH", testMemoryPath);
    await rm(testMemoryPath, { force: true });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("ignores malformed entries instead of injecting them into prompts", async () => {
    const createdAt = new Date().toISOString();
    await writeFile(testMemoryPath, JSON.stringify({
      userPreferences: [
        { content: "  保留真实文字  ", createdAt },
        { content: { preference: "对象不能写入" }, createdAt },
        { content: "", createdAt },
      ],
      operationHistory: [{ content: "有效操作", createdAt }],
      shopInsights: "不是数组",
    }));

    expect(loadMemory()).toEqual({
      userPreferences: [{ content: "保留真实文字", createdAt }],
      operationHistory: [{ content: "有效操作", createdAt }],
      shopInsights: [],
    });
  });

  it("validates, deduplicates and limits data before saving", async () => {
    const createdAt = new Date().toISOString();
    saveMemory({
      userPreferences: [
        { content: "同一偏好", createdAt },
        { content: "同一偏好", createdAt },
        { content: { preference: "错误对象" }, createdAt },
      ],
      operationHistory: [],
      shopInsights: [],
    } as unknown as AgentMemory);

    const saved = JSON.parse(await readFile(testMemoryPath, "utf-8"));
    expect(saved.userPreferences).toEqual([{ content: "同一偏好", createdAt }]);
  });

  it("uses the configured test file and rejects invalid runtime values", async () => {
    recordOperation("  测试操作  ");
    addPreference({ preference: "错误对象" } as unknown as string);

    expect(loadMemory()).toEqual({
      userPreferences: [],
      operationHistory: [{ content: "测试操作", createdAt: expect.any(String) }],
      shopInsights: [],
    });
    expect(await readFile(testMemoryPath, "utf-8")).toContain("测试操作");
  });
});

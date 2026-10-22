import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { contentAssetPath, createImageContent } from "../server/content-service.ts";
import { contentStore } from "../server/content-store.ts";

let savedPath: string | undefined;
beforeEach(() => { vi.stubEnv("AGNES_API_KEY", "test-image-key"); vi.stubEnv("AGNES_BASE_URL", "https://apihub.agnes-ai.com"); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (savedPath) await rm(savedPath, { force: true }); savedPath = undefined; });

it("stores a generated image and records the actual model and task settings", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://example.com/test-output.png" }] })))
    .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
  const { task, asset } = await createImageContent({ prompt: "白底商品图", title: "集成验证", ratio: "1:1", size: "1K" });
  savedPath = contentAssetPath(asset.fileName!);
  expect(task).toMatchObject({ status: "completed", progress: 100, assetId: asset.id, settings: { model: "agnes-image-2.0-flash", dimensions: "1024x1024" } });
  expect(asset).toMatchObject({ model: "agnes-image-2.0-flash", mimeType: "image/png" });
  expect(asset.url).toMatch(/^\/api\/content\/files\/.+\.png$/);
  expect(contentStore.getAsset(asset.id)).toEqual(asset);
});

it("retains a failed task when image generation fails", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "image quota exceeded" } }), { status: 429 }));
  await expect(createImageContent({ prompt: "失败任务验证", ratio: "1:1", size: "1K" })).rejects.toThrow("image quota exceeded");
  expect(contentStore.listTasks().find(task => task.prompt === "失败任务验证")).toMatchObject({ status: "failed", error: expect.stringContaining("image quota exceeded") });
});

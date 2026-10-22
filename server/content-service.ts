import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContentAsset, ContentOverview, ContentTask } from "../shared/content.ts";
import { generateContentText } from "./llm.ts";
import { getLlmRuntimeConfig } from "./llm-providers.ts";
import { createAgnesVideo, generateAgnesImage, getAgnesVideo, hasAgnesConfiguration } from "./agnes-client.ts";
import { contentStore } from "./content-store.ts";

const ASSET_DIRECTORY = join(process.cwd(), ".data", "content-assets");
const activeRefreshes = new Set<string>();

interface CommonInput { title?: string; prompt: string; project?: string; sku?: string }

function createTask(type: ContentTask["type"], input: CommonInput, settings: ContentTask["settings"]): ContentTask {
  const now = new Date().toISOString();
  return contentStore.saveTask({
    id: randomUUID(), type, status: "in_progress", progress: 5,
    title: input.title?.trim() || input.prompt.slice(0, 30), prompt: input.prompt,
    project: input.project?.trim() || undefined, sku: input.sku?.trim() || undefined,
    settings, createdAt: now, updatedAt: now,
  });
}

function updateTask(task: ContentTask, change: Partial<ContentTask>): ContentTask {
  return contentStore.saveTask({ ...task, ...change, updatedAt: new Date().toISOString() });
}

async function saveRemoteAsset(input: CommonInput & { type: "image" | "video"; sourceUrl: string; model: string; ratio?: string }): Promise<ContentAsset> {
  const response = await fetch(input.sourceUrl, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`生成完成，但素材下载失败（${response.status}）。`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 300 * 1024 * 1024) throw new Error("生成素材超过 300MB，已停止下载。");
  const mimeType = response.headers.get("content-type")?.split(";")[0] || (input.type === "image" ? "image/png" : "video/mp4");
  const extension = mimeType.includes("webp") ? ".webp" : mimeType.includes("jpeg") ? ".jpg" : mimeType.includes("png") ? ".png" : mimeType.includes("quicktime") ? ".mov" : extname(new URL(input.sourceUrl).pathname) || ".mp4";
  const id = randomUUID();
  const fileName = `${id}${extension}`;
  await mkdir(ASSET_DIRECTORY, { recursive: true });
  await writeFile(join(ASSET_DIRECTORY, fileName), Buffer.from(await response.arrayBuffer()));
  return contentStore.saveAsset({
    id, type: input.type, title: input.title?.trim() || input.prompt.slice(0, 30), prompt: input.prompt,
    project: input.project?.trim() || undefined, sku: input.sku?.trim() || undefined,
    url: `/api/content/files/${fileName}`, sourceUrl: input.sourceUrl, mimeType, fileName,
    ratio: input.ratio, model: input.model, createdAt: new Date().toISOString(),
  });
}

export async function createTextContent(input: CommonInput & { kind: "title" | "listing" | "script"; language?: string }): Promise<{ task: ContentTask; asset: ContentAsset }> {
  const task = createTask("text", input, { kind: input.kind, language: input.language ?? "泰语" });
  try {
    const content = await generateContentText(input);
    const asset = contentStore.saveAsset({
      id: randomUUID(), type: "text", title: task.title, prompt: input.prompt, project: input.project, sku: input.sku,
      content, model: getLlmRuntimeConfig().model || "existing-llm", createdAt: new Date().toISOString(),
    });
    return { task: updateTask(task, { status: "completed", progress: 100, assetId: asset.id }), asset };
  } catch (error) {
    updateTask(task, { status: "failed", progress: 100, error: error instanceof Error ? error.message : "文字生成失败。" });
    throw error;
  }
}

export async function createImageContent(input: CommonInput & { ratio: string; size: string; images?: string[] }): Promise<{ task: ContentTask; asset: ContentAsset }> {
  const task = createTask("image", input, { ratio: input.ratio, size: input.size, references: input.images?.length ?? 0 });
  try {
    const result = await generateAgnesImage(input);
    updateTask(task, { progress: 80 });
    const asset = await saveRemoteAsset({ ...input, type: "image", sourceUrl: result.url, model: "agnes-image-2.1-flash" });
    return { task: updateTask(task, { status: "completed", progress: 100, assetId: asset.id }), asset };
  } catch (error) {
    updateTask(task, { status: "failed", progress: 100, error: error instanceof Error ? error.message : "图片生成失败。" });
    throw error;
  }
}

async function publishDataUrl(dataUrl: string, fileName: string): Promise<string> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("参考图片格式不正确。");
  const endpoint = process.env.CONTENT_PUBLIC_UPLOAD_URL?.trim() || "https://tmpfiles.org/api/v1/upload";
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), fileName);
  const response = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({})) as { data?: { url?: string }; url?: string };
  if (!response.ok) throw new Error(`参考图片临时上传失败（${response.status}）。`);
  const url = body.data?.url ?? body.url;
  if (!url) throw new Error("临时图片服务没有返回访问地址。");
  return url.includes("tmpfiles.org/") ? url.replace("tmpfiles.org/", "tmpfiles.org/dl/") : url;
}

export async function createVideoContent(input: CommonInput & { ratio: string; resolution: string; duration: number; assetIds?: string[]; images?: string[] }): Promise<{ task: ContentTask }> {
  const task = createTask("video", input, { ratio: input.ratio, resolution: input.resolution, duration: input.duration, references: (input.assetIds?.length ?? 0) + (input.images?.length ?? 0) });
  try {
    const assetUrls = (input.assetIds ?? []).map((id) => contentStore.getAsset(id)?.sourceUrl).filter((url): url is string => Boolean(url));
    const uploadedUrls = await Promise.all((input.images ?? []).map((image, index) => publishDataUrl(image, `reference-${index + 1}.png`)));
    const created = await createAgnesVideo({ ...input, images: [...assetUrls, ...uploadedUrls].slice(0, 8) });
    const saved = updateTask(task, { providerTaskId: created.id, status: created.status, progress: Math.max(10, created.progress) });
    void refreshVideoTask(saved.id);
    return { task: saved };
  } catch (error) {
    updateTask(task, { status: "failed", progress: 100, error: error instanceof Error ? error.message : "视频任务创建失败。" });
    throw error;
  }
}

export async function refreshVideoTask(taskId: string): Promise<ContentTask | undefined> {
  if (activeRefreshes.has(taskId)) return contentStore.getTask(taskId);
  const task = contentStore.getTask(taskId);
  if (!task?.providerTaskId || task.status === "completed" || task.status === "failed") return task;
  activeRefreshes.add(taskId);
  try {
    const remote = await getAgnesVideo(task.providerTaskId);
    if (remote.status === "failed") return updateTask(task, { status: "failed", progress: 100, error: remote.error || "Agnes 视频生成失败。" });
    if (remote.status !== "completed" || !remote.url) return updateTask(task, { status: remote.status, progress: Math.max(task.progress, remote.progress) });
    const asset = await saveRemoteAsset({ ...task, type: "video", sourceUrl: remote.url, model: "agnes-video-v2.0", ratio: String(task.settings.ratio ?? "9:16") });
    return updateTask(task, { status: "completed", progress: 100, assetId: asset.id });
  } catch (error) {
    return updateTask(task, { error: error instanceof Error ? error.message : "查询视频进度失败。" });
  } finally {
    activeRefreshes.delete(taskId);
  }
}

export async function contentOverview(): Promise<ContentOverview> {
  const pending = contentStore.listTasks().filter((task) => task.type === "video" && !["completed", "failed"].includes(task.status));
  await Promise.all(pending.slice(0, 10).map((task) => refreshVideoTask(task.id)));
  return { configured: hasAgnesConfiguration(), assets: contentStore.listAssets(), tasks: contentStore.listTasks() };
}

export function contentAssetPath(fileName: string): string | undefined {
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|mp4|mov)$/i.test(fileName)) return undefined;
  return join(ASSET_DIRECTORY, fileName);
}

import { AGNES_IMAGE_MODEL, contentImageDimensions } from "../shared/content.ts";

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com";

interface AgnesImageResult { url: string }
interface AgnesVideoTask { id: string; status: "queued" | "in_progress" | "completed" | "failed"; progress: number; url?: string; error?: string }

function configuration() {
  const apiKey = process.env.AGNES_API_KEY?.trim();
  if (!apiKey) throw new Error("Agnes API 密钥尚未配置。");
  return { apiKey, baseUrl: (process.env.AGNES_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "") };
}

async function request(path: string, init: RequestInit, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const { apiKey, baseUrl } = configuration();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
  if (!response.ok) {
    const error = body.error;
    const detail = String(error && typeof error === "object" ? (error as { message?: unknown }).message ?? body.message ?? "未知错误" : error ?? body.message ?? text).slice(0, 400);
    throw new Error(`Agnes 请求失败（${response.status}）：${detail || "未知错误"}`);
  }
  return body;
}

export function hasAgnesConfiguration(): boolean {
  return Boolean(process.env.AGNES_API_KEY?.trim());
}

export async function generateAgnesImage(input: { prompt: string; ratio: string; size: string; images?: string[] }): Promise<AgnesImageResult> {
  const body = await request("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({
      model: AGNES_IMAGE_MODEL,
      prompt: input.prompt,
      size: contentImageDimensions(input.ratio, input.size),
      extra_body: {
        response_format: "url",
        ...(input.images?.length ? { image: input.images } : {}),
      },
    }),
  }, 360_000);
  const data = Array.isArray(body.data) ? body.data[0] as Record<string, unknown> | undefined : undefined;
  const url = typeof data?.url === "string" && data.url ? data.url
    : typeof data?.b64_json === "string" && data.b64_json ? `data:image/png;base64,${data.b64_json}`
    : typeof body.url === "string" && body.url ? body.url : undefined;
  if (!url) throw new Error("Agnes 图片生成成功，但没有返回图片地址。");
  return { url };
}

function videoDimensions(ratio: string, resolution: string): { width: number; height: number } {
  const long = resolution === "1080p" ? 1920 : resolution === "720p" ? 1280 : 854;
  const short = resolution === "1080p" ? 1080 : resolution === "720p" ? 720 : 480;
  if (ratio === "9:16") return { width: short, height: long };
  if (ratio === "1:1") return { width: short, height: short };
  if (ratio === "4:3") return { width: Math.round(short * 4 / 3), height: short };
  if (ratio === "3:4") return { width: short, height: Math.round(short * 4 / 3) };
  return { width: long, height: short };
}

export async function createAgnesVideo(input: { prompt: string; ratio: string; resolution: string; duration: number; images?: string[] }): Promise<AgnesVideoTask> {
  const dimensions = videoDimensions(input.ratio, input.resolution);
  const frames = Math.min(441, Math.max(81, Math.round((input.duration * 24 - 1) / 8) * 8 + 1));
  const keyframes = (input.images?.length ?? 0) > 1;
  const body = await request("/v1/videos", {
    method: "POST",
    body: JSON.stringify({
      model: "agnes-video-v2.0",
      prompt: input.prompt,
      ...dimensions,
      num_frames: frames,
      frame_rate: 24,
      mode: keyframes ? "keyframes" : "ti2vid",
      ...(input.images?.length === 1 ? { image: input.images[0] } : {}),
      ...(keyframes ? { extra_body: { mode: "keyframes", image: input.images } } : {}),
    }),
  });
  const id = String(body.video_id ?? body.task_id ?? body.id ?? "");
  if (!id) throw new Error("Agnes 视频任务已提交，但没有返回任务编号。");
  return { id, status: normalizeStatus(body.status), progress: Number(body.progress ?? 0) };
}

export async function getAgnesVideo(id: string): Promise<AgnesVideoTask> {
  const body = await request(`/agnesapi?video_id=${encodeURIComponent(id)}`, { method: "GET" });
  const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {};
  return {
    id,
    status: normalizeStatus(body.status),
    progress: Number(body.progress ?? (body.status === "completed" ? 100 : 0)),
    url: typeof metadata.url === "string" ? metadata.url : typeof body.url === "string" ? body.url : undefined,
    error: typeof body.error === "string" ? body.error : typeof body.message === "string" && body.status === "failed" ? body.message : undefined,
  };
}

function normalizeStatus(value: unknown): AgnesVideoTask["status"] {
  return value === "completed" || value === "failed" || value === "in_progress" ? value : "queued";
}

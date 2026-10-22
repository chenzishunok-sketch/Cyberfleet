export type ContentAssetType = "text" | "image" | "video";
export const AGNES_IMAGE_MODEL = "agnes-image-2.0-flash";

/** 界面的清晰度表示长边像素，供应商 API 接收明确的宽 x 高。 */
export function contentImageDimensions(ratio: string, size: string): string {
  const ratios: Record<string, [number, number]> = {
    "1:1": [1, 1], "3:4": [3, 4], "4:3": [4, 3], "9:16": [9, 16],
    "16:9": [16, 9], "2:3": [2, 3], "3:2": [3, 2], "21:9": [21, 9],
  };
  const pixels: Record<string, number> = { "1K": 1024, "2K": 2048, "3K": 3072, "4K": 4096 };
  const pair = ratios[ratio];
  const edge = pixels[size];
  if (!pair || !edge) throw new Error("图片比例或清晰度不支持。");
  const scale = edge / Math.max(...pair);
  return `${Math.round(pair[0] * scale)}x${Math.round(pair[1] * scale)}`;
}
type ContentTaskStatus = "queued" | "in_progress" | "completed" | "failed";

export interface ContentAsset {
  id: string;
  type: ContentAssetType;
  title: string;
  prompt: string;
  project?: string;
  sku?: string;
  content?: string;
  url?: string;
  sourceUrl?: string;
  mimeType?: string;
  fileName?: string;
  ratio?: string;
  model: string;
  createdAt: string;
}

export interface ContentTask {
  id: string;
  type: ContentAssetType;
  status: ContentTaskStatus;
  progress: number;
  title: string;
  prompt: string;
  project?: string;
  sku?: string;
  providerTaskId?: string;
  assetId?: string;
  error?: string;
  settings: Record<string, string | number | string[]>;
  createdAt: string;
  updatedAt: string;
}

export interface ContentOverview {
  configured: boolean;
  assets: ContentAsset[];
  tasks: ContentTask[];
}

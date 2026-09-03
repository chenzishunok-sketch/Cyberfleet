export type ContentAssetType = "text" | "image" | "video";
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

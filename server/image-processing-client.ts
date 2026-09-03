/**
 * 妙手 ERP 图像处理客户端（6 端点）
 * 契约来源：miaoshouerp-image-processing skill（miaoshou_image_processing.py，2026-08）。
 *
 * 6 端点：
 * - remove            AI 智能去水印/Logo/文字/牛皮癣
 * - white-bg          AI 白底图抠图（imageScene 1-5）
 * - search-watermarks TikTok 水印模板搜索
 * - watermark         应用水印模板
 * - languages         图片翻译支持语言配置（空 body）
 * - translate         图片文字翻译
 *
 * 权限边界：remove / white-bg / watermark / translate 四个处理操作会消耗 AI 配额，
 * 属于「消耗类写操作」，必须走 ActionPlan 审批闭环（预览→确认→执行），不能由 Agent 直接调用。
 * search-watermarks / languages 为只读端点，可直接调用。
 */
import { miaoshouRequest, hasMiaoshouConfiguration } from "./miaoshou-client.ts";

export function hasMiaoshouImageProcessingConfiguration(): boolean {
  return hasMiaoshouConfiguration();
}

/** 校验图片 URL 列表：必须是绝对 HTTP(S) 地址，去重 */
function validateImageUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`图片地址必须是绝对 HTTP(S) URL：${raw}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`图片地址必须是绝对 HTTP(S) URL：${raw}`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
  }
  if (!urls.length) throw new Error("至少需要一张图片 URL。");
  return urls;
}

/** 从各处理接口响应中提取成功产出的图片 URL（与 Python derived_image_urls 对齐） */
export function extractDerivedImageUrls(response: unknown): string[] {
  const data = (response as { data?: unknown })?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  const keys = ["imgMattingList", "imageRemovalUrlResultList", "watermarkDetail", "translateImageUrlResultList"];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (String(entry.result ?? "").toLowerCase() !== "success") continue;
      const url = entry.newImageUrl ?? entry.watermarkImageUrl;
      if (typeof url === "string" && /^https?:\/\//.test(url) && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

/** 1. AI 智能去除水印/Logo/文字/牛皮癣（消耗配额，走审批） */
export async function miaoshouImageRemove(
  imageUrls: string[],
  options: {
    source: "collect_box" | "collect_box_add" | "common_collect_box" | "common_collect_box_add" | "item" | "item_add";
    collectBoxDetailId?: number;
    commonCollectBoxDetailId?: number;
    platform?: string;
    removeWatermark?: boolean;
    removeLogo?: boolean;
    removeText?: boolean;
    removePsoriasis?: boolean;
    removeAreas: Array<"background" | "subject">;
  },
) {
  const targets = [options.removeWatermark, options.removeLogo, options.removeText, options.removePsoriasis];
  if (!targets.some(Boolean)) throw new Error("至少选择一种去除目标（水印/Logo/文字/牛皮癣）。");

  const trace: Record<string, unknown> = { imageRemovalSource: options.source };
  if (options.collectBoxDetailId != null) trace.collectBoxDetailId = options.collectBoxDetailId;
  if (options.commonCollectBoxDetailId != null) trace.commonCollectBoxDetailId = options.commonCollectBoxDetailId;
  if (options.platform) trace.platform = options.platform;

  return miaoshouRequest("/open/v1/product/common/image_removal/remove_image", {
    imageUrls: validateImageUrls(imageUrls),
    traceInfo: trace,
    removeConfig: {
      isRemoveWatermark: options.removeWatermark ? 1 : 0,
      isRemoveLogo: options.removeLogo ? 1 : 0,
      isRemoveText: options.removeText ? 1 : 0,
      isRemovePsoriasis: options.removePsoriasis ? 1 : 0,
      removeAreas: [...new Set(options.removeAreas)],
    },
  }, { retry: false });
}

/** 2. AI 白底图抠图（消耗配额，走审批）。imageScene 1-5，按商品品类选择 */
export async function miaoshouImageWhiteBg(imageUrls: string[], imageScene: number) {
  if (!Number.isInteger(imageScene) || imageScene < 1 || imageScene > 5) {
    throw new Error("imageScene 必须是 1-5 的整数（商品品类场景）。");
  }
  return miaoshouRequest("/open/v1/product/picture/matting/auto_ai_matting_multi", {
    imgUrls: validateImageUrls(imageUrls),
    imageScene,
  }, { retry: false });
}

/** 3. 搜索 TikTok 水印模板（只读） */
export async function miaoshouSearchWatermarks(options: {
  subtype: "normal" | "byLayer";
  pageNo?: number;
  pageSize?: number;
  watermarkIds?: string[];
  name?: string;
}) {
  const payload: Record<string, unknown> = {
    watermarkSubType: options.subtype,
    pageNo: options.pageNo ?? 1,
    pageSize: options.pageSize ?? 20,
  };
  if (options.watermarkIds?.length) payload.watermarkIds = [...new Set(options.watermarkIds)].join(",");
  if (options.name?.trim()) payload.watermarkName = options.name.trim();
  return miaoshouRequest("/open/v1/product/item/tiktok/watermark/search_watermark_list", payload);
}

/** 4. 应用水印模板（消耗配额，走审批） */
export async function miaoshouApplyWatermark(
  imageUrls: string[],
  watermarkId: string,
  options: { autoMatchImageSize?: boolean; collectBoxDetailId?: number } = {},
) {
  if (!watermarkId) throw new Error("必须提供水印模板 watermarkId。");
  const payload: Record<string, unknown> = {
    imageUrls: validateImageUrls(imageUrls),
    watermarkId,
    isAutoMatchImageSize: options.autoMatchImageSize !== false,
  };
  if (options.collectBoxDetailId != null) payload.collectBoxDetailId = options.collectBoxDetailId;
  return miaoshouRequest("/open/v1/product/item/tiktok/watermark/watermark_images", payload, { retry: false });
}

/** 5. 获取图片翻译支持语言配置（只读，空 body） */
export async function miaoshouGetTranslateLanguages() {
  return miaoshouRequest("/open/v1/product/common/translate/get_support_language_config", null);
}

/** 6. 图片文字翻译（消耗配额，走审批） */
export async function miaoshouTranslateImage(
  imageUrls: string[],
  sourceLang: string,
  targetLang: string,
  platform: string,
  options: { excludeProductText?: boolean; excludeBrand?: boolean } = {},
) {
  if (!sourceLang || !targetLang || !platform) {
    throw new Error("图片翻译必须提供 sourceLang、targetLang 和翻译平台 platform。");
  }
  const payload: Record<string, unknown> = {
    imageUrls: validateImageUrls(imageUrls),
    sourceLang,
    targetLang,
    translatePlatform: platform,
  };
  const exclusions: string[] = [];
  if (options.excludeProductText) exclusions.push("textInTheProduct");
  if (options.excludeBrand) exclusions.push("brand");
  if (exclusions.length) payload.noTranslateImageTextOptions = exclusions;
  return miaoshouRequest("/open/v1/product/common/translate/translate_image", payload, { retry: false });
}

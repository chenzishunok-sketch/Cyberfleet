import { createHmac } from "node:crypto";
import { getMiaoshouRuntimeConfig } from "./runtime-config.ts";
import { getLlmRuntimeConfig } from "./llm-providers.ts";
import { callLlmRaw, fastModel } from "./llm.ts";
import { TIKTOK_SITES, languageLabel, titleLengthHint } from "./tiktok-sites.ts";

export function hasMiaoshouConfiguration(): boolean {
  const config = getMiaoshouRuntimeConfig();
  return Boolean(config.appKey && config.appSecret);
}

export interface MiaoshouResponse<T = unknown> {
  result: string;
  code: string;
  message: string;
  data: T;
}

class MiaoshouApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(`妙手 API ${path} 返回 ${statusCode}: ${responseBody.slice(0, 200)}`);
    this.name = "MiaoshouApiError";
  }
}

function computeSignature(
  appSecret: string,
  path: string,
  timestamp: string,
  appKey: string,
  bodyJson: string,
): string {
  const message = appSecret + path + timestamp + appKey + bodyJson + appSecret;
  return createHmac("sha256", appSecret).update(message).digest("hex");
}

/**
 * 紧凑 JSON 序列化，与 Python json.dumps(separators=(',',':'), ensure_ascii=False) 一致。
 * 签名包含 body JSON，格式不一致（空格/编码）会导致签名验证失败。
 */
function compactStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => compactStringify(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => JSON.stringify(k) + ":" + compactStringify(v));
    return "{" + entries.join(",") + "}";
  }
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
/** 频率超限需要等到下一个计时窗口，退避要明显长于普通重试 */
const RATE_LIMIT_BACKOFF_MS = 3_000;
/** 店铺列表按站点扇出时每批几个站点。妙手的 QPS 限制很紧，实测并发 3 个就会超限，只能是串行 */
const SHOP_LIST_BATCH_SIZE = 1;
const SHOP_LIST_BATCH_GAP_MS = 120;
const REQUEST_TIMEOUT_MS = 20_000;

async function miaoshouRequestOnce<T = unknown>(
  path: string,
  body: Record<string, unknown> | null,
): Promise<MiaoshouResponse<T>> {
  const { appKey, appSecret, baseUrl } = getMiaoshouRuntimeConfig();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // 使用与 Python separators=(',',':') 一致的紧凑 JSON（无空格）；null 表示空 body（签名用空串）
  const bodyJson = body == null ? "" : compactStringify(body);
  const sign = computeSignature(appSecret, path, timestamp, appKey, bodyJson);

  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-key": appKey,
      "x-timestamp": timestamp,
      "x-sign": sign,
    },
    body: bodyJson,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new MiaoshouApiError(path, response.status, text);
  }

  // 检查 Content-Type，防止 API 返回 HTML 错误页
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!contentType.includes("json") && text.trimStart().startsWith("<")) {
    console.error(`[miaoshou] ${path} 返回了 HTML 而非 JSON（前200字符）:`, text.slice(0, 200));
    throw new Error(`妙手 API ${path} 返回了非 JSON 响应（可能是网关错误或服务不可用），请稍后重试。`);
  }

  let json: MiaoshouResponse<T>;
  try {
    json = JSON.parse(text) as MiaoshouResponse<T>;
  } catch (parseErr) {
    console.error(`[miaoshou] ${path} JSON 解析失败（前200字符）:`, text.slice(0, 200));
    throw new Error(`妙手 API ${path} 响应格式异常，请稍后重试。`);
  }
  // "没有符合条件的数据" 是正常空结果，不是错误
  const isEmptyResult = json.message === "没有符合条件的数据" && Array.isArray(json.data) && json.data.length === 0;
  if (!isEmptyResult && json.result !== "success" && json.code !== "success") {
    throw new Error(`妙手 API ${path} 业务错误: ${json.message || json.code}`);
  }
  return json;
}

/**
 * 带重试的妙手 API 请求。
 * 当 API 返回 HTML 错误页或网络异常时，自动重试最多 3 次。
 */
export async function miaoshouRequest<T = unknown>(
  path: string,
  body: Record<string, unknown> | null,
  options: { retry?: boolean } = {},
): Promise<MiaoshouResponse<T>> {
  if (!hasMiaoshouConfiguration()) {
    throw new Error("妙手 API 尚未配置 AppKey / AppSecret。");
  }

  let lastError: Error | undefined;
  const maxAttempts = options.retry === false ? 1 : MAX_RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await miaoshouRequestOnce<T>(path, body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isHtmlError = lastError.message.includes("非 JSON 响应") || lastError.message.includes("响应格式异常");
      const isNetworkError = lastError.message.includes("fetch") || lastError instanceof TypeError;
      // 频率超限虽然被妙手当"业务错误"返回，但它是暂时性的、可重试的。
      // 旧实现把它归入"业务错误不重试"，于是调用方（尤其是轮询里的空 catch）
      // 会把"被限流"静默当成"没有数据"。
      const isRateLimited = lastError.message.includes("频率超限");
      if (!isHtmlError && !isNetworkError && !isRateLimited) {
        throw lastError;
      }
      const delay = isRateLimited ? RATE_LIMIT_BACKOFF_MS * attempt : RETRY_DELAY_MS * attempt;
      console.warn(`[miaoshou] ${path} 第${attempt}次请求失败: ${lastError.message}，${attempt < maxAttempts ? `${delay}ms 后重试` : "已达最大重试次数"}`);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new Error(`妙手 API ${path} 请求失败。`);
}

// ─── 便捷方法：常用妙手接口 ─────────────────────────────────

/** 通过货源链接采集货源 */
export async function miaoshouFetchItem(sourceUrl: string, platform = "1688") {
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/fetch_item", {
    collectLinks: [sourceUrl],
    platform,
  }, { retry: false });
}

/** 等待采集完成（轮询公共采集箱，直到找到匹配的 item_id） */
function numericId(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function miaoshouWaitForCollection(
  sourceItemIds: string[],
  maxWaitMs = 30000,
  pollIntervalMs = 3000,
): Promise<Array<{ sourceItemId: string; detailId: string }>> {
  const deadline = Date.now() + maxWaitMs;
  const found = new Map<string, string>();

  while (Date.now() < deadline) {
    const remaining = sourceItemIds.filter((id) => !found.has(id));
    if (remaining.length === 0) break;

    for (const targetId of remaining) {
      try {
        // 用货源编号让服务端过滤，而不是拉回第一页再本地扫描：公共采集箱通常已经堆了几十上百条
        // 历史记录，目标的 success 行经常不在第一页，本地扫描会把它误判成"尚未进入公共采集箱"。
        const result = await miaoshouGetCommonCollectBoxList(1, 20, targetId);
        const data = result.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>> } | undefined;
        const list = data?.detailList ?? data?.list ?? [];

        for (const item of list) {
          const collectionStatus = String(item.status ?? item.collectStatus ?? "").trim().toLowerCase();
          if (collectionStatus !== "success" && collectionStatus !== "collectsuccess") continue;
          // 公共采集箱主键为 commonCollectBoxDetailId，货源 ID 可能在顶层或 sourceList 中
          const detailId = String(item.commonCollectBoxDetailId ?? item.detail_id ?? item.id ?? "").trim();
          if (!detailId) continue;

          const sourceList = item.sourceList as Array<Record<string, unknown>> | undefined;
          const candidates = new Set(
            [
              String(item.item_id ?? item.sourceItemId ?? "").trim(),
              ...(sourceList?.map((entry) => String(entry.sourceItemId ?? "").trim()) ?? []),
            ].filter(Boolean),
          );
          // 货源编号必须精确匹配。空字符串或模糊包含会把其他商品误认成目标商品。
          if (!candidates.has(targetId.trim())) continue;

          // 同一货源可能存在多条记录，取编号最大的那条（最新的）而不是第一次遇到的。
          const previous = found.get(targetId);
          if (!previous || numericId(detailId) > numericId(previous)) found.set(targetId, detailId);
        }
      } catch {
        // 轮询期间 API 错误不中断，继续等待
      }
    }

    if (found.size < sourceItemIds.length) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return sourceItemIds.map((id) => ({ sourceItemId: id, detailId: found.get(id) ?? "" }));
}

/** 获取公共采集箱列表 — 需要 filter 对象；传 sourceItemIdKeyword 时交给服务端按货源编号过滤 */
export async function miaoshouGetCommonCollectBoxList(page = 1, pageSize = 20, sourceItemIdKeyword?: string) {
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list", {
    pageNo: page,
    pageSize,
    filter: {
      // "collectSucess" 是妙手自己的枚举拼写（少一个 c），不要"纠正"成 collectSuccess
      tabPaneName: sourceItemIdKeyword ? "collectSucess" : "all",
      ...(sourceItemIdKeyword ? { sourceItemIdKeyword } : {}),
    },
  });
}

/** 获取 TK 采集箱列表 — 需要 filter 对象 */
export async function miaoshouGetTikTokCollectBoxList(page = 1, pageSize = 20, status?: "notPublished" | "timingPublish" | "published") {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/search_collect_box_detail_list", {
    pageNo: page,
    pageSize,
    filter: {
      sourceItemIdKeyword: "",
      ...(status ? { status } : {}),
    },
  });
}

/** 获取TK类目列表 */
export async function miaoshouGetTikTokCategoryTree(site: string) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/get_category_tree_by_site", {
    site,
  });
}

/** AI匹配类目 */
export async function miaoshouAiMatchCategory(itemIds: string[], shopIds: string[]) {
  if (itemIds.length !== 1) throw new Error("妙手 AI 类目匹配目前每次只支持一个商品。");
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/ai_match_cid_by_shop_ids", {
    collectBoxDetailId: itemIds[0],
    shopIds: shopIds.map(Number),
  }, { retry: false });
}

/** AI属性匹配 */
export async function miaoshouAiMatchAttribute(itemId: string, categoryId: string, site: string) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/ai_match_product_attribute", {
    collectBoxDetailId: itemId,
    cid: categoryId,
    site,
  }, { retry: false });
}

/**
 * 获取店铺数据列表。
 * API 要求 site 必须是真实站点代码（如 JP/TH/US/MY），不接受空字符串。
 * site="all" 时逐批查询全部站点并合并结果——站点列表见 `tiktok-sites.ts`。
 */
export async function miaoshouGetShopList(platform = "tiktok", site = "all") {
  if (site && site !== "all") {
    return miaoshouRequest("/open/v1/product/shop/shop/get_shop_list", {
      platform,
      site,
      pageNo: 1,
      pageSize: 100,
    });
  }
  // site="all"：分批并发查询每个站点后合并。
  // 一次全部打出去会撞「账户接口每秒请求频率超限」，触发 3s/6s 退避，反而比串行还慢，
  // 所以按 3 个一批、批间留一点间隔。
  const allShops: Array<Record<string, unknown>> = [];
  const seenShopIds = new Set<string>();
  for (let index = 0; index < TIKTOK_SITES.length; index += SHOP_LIST_BATCH_SIZE) {
    const batch = TIKTOK_SITES.slice(index, index + SHOP_LIST_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (siteCode) => {
        try {
          return await miaoshouRequest("/open/v1/product/shop/shop/get_shop_list", {
            platform,
            site: siteCode,
            pageNo: 1,
            pageSize: 100,
          });
        } catch {
          return null;
        }
      }),
    );
    for (const result of results) {
      if (!result) continue;
      const data = result.data as { shopList?: Array<Record<string, unknown>> } | undefined;
      for (const shop of data?.shopList ?? []) {
        const shopId = String(shop.shopId ?? "");
        if (shopId && !seenShopIds.has(shopId)) {
          seenShopIds.add(shopId);
          allShops.push(shop);
        }
      }
    }
    if (index + SHOP_LIST_BATCH_SIZE < TIKTOK_SITES.length) {
      await new Promise((resolve) => setTimeout(resolve, SHOP_LIST_BATCH_GAP_MS));
    }
  }
  return {
    result: "success",
    code: "success",
    message: "",
    data: { shopList: allShops } as unknown,
  } as MiaoshouResponse<unknown>;
}

/**
 * 探测账号下有店铺的站点。
 *
 * 按 `TIKTOK_SITES` 顺序串行探测、命中即返回——日本站排在首位，
 * 单店铺账号通常一次请求就能拿到，不必每次九路扇出，也就不会撞 QPS 限流。
 * 用于「查类目树」这类必须先知道 site 才能调的接口。
 */
export async function miaoshouResolveSite(platform = "tiktok"): Promise<string | undefined> {
  for (const site of TIKTOK_SITES) {
    try {
      const response = await miaoshouRequest<{ shopList?: Array<Record<string, unknown>> }>(
        "/open/v1/product/shop/shop/get_shop_list",
        { platform, site, pageNo: 1, pageSize: 10 },
      );
      if ((response?.data?.shopList ?? []).length > 0) return site;
    } catch {
      // 该站点没有店铺或接口临时失败，继续试下一个
    }
  }
  return undefined;
}

/**
 * 直接解析 TikTok OAuth shopId → 妙手 shopId。
 * 只请求单个站点（避免 site=all 的频率限制），按名称 + 站点双条件匹配。
 * 若传入的已经是数字 ID，则直接返回（幂等）。
 */
export async function resolveMiaoshouShopId(
  oauthShopIdOrCipher: string,
  opts?: { region?: string; shopName?: string },
): Promise<string | undefined> {
  const raw = String(oauthShopIdOrCipher ?? "").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return raw;

  const { region, shopName } = opts ?? {};

  const trySite = async (site: string): Promise<string | undefined> => {
    try {
      const response = await miaoshouRequest<{ shopList?: Array<Record<string, unknown>> }>(
        "/open/v1/product/shop/shop/get_shop_list",
        { platform: "tiktok", site, pageNo: 1, pageSize: 100 },
      );
      const shops = response?.data?.shopList ?? [];
      if (!shops.length) return undefined;
      for (const shop of shops) {
        const id = String(shop.shopId ?? "");
        if (!id) continue;
        const msShopName = String(shop.shopNick ?? shop.shopName ?? shop.platformShopName ?? "");
        const msSite = String(shop.site ?? "").toUpperCase();
        if (shopName && msShopName && msShopName === shopName) return id;
        if (region && msSite === region.toUpperCase() && !shopName) return id;
      }
      if (!region && !shopName && shops.length === 1) return String(shops[0].shopId ?? "");
      return undefined;
    } catch {
      return undefined;
    }
  };

  if (region) {
    return trySite(region.toUpperCase());
  }

  // 没有站点信息时按统一站点表顺序试探（日本站排首位，单店账号一次命中）
  for (const site of TIKTOK_SITES) {
    const found = await trySite(site);
    if (found) return found;
  }
  return undefined;
}

/** 认领商品到平台采集箱（从公共采集箱 → TK/Shopee 等） */
export async function miaoshouClaimToPlatform(detailIds: number[], platform: string, serialNumber = 1) {
  const detailList = detailIds.map((detailId) => ({
    detailId,
    platform,
    serialNumber,
  }));
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/claimed", {
    detailSerialNumberPlatformList: detailList,
  }, { retry: false });
}

/** 获取 TikTok 采集箱店铺模式商品详情 */
export async function miaoshouGetTikTokShopCollectItemInfo(detailId: number, shopId: number) {
  if (!Number.isFinite(detailId) || !Number.isFinite(shopId)) {
    throw new Error("妙手店铺或商品编号无效（可能是 TikTok OAuth 店铺未关联妙手店铺），无法读取采集箱商品详情。");
  }
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/get_shop_collect_item_info", {
    detailId,
    shopId,
  });
}

/** 使用最新 ossMd5 保存完整的 TikTok 店铺模式商品详情 */
export async function miaoshouSaveTikTokShopCollectItemInfo(
  detailId: number,
  shopId: number,
  ossMd5: string,
  shopCollectItemInfo: Record<string, unknown>,
) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/save_shop_collect_item_info", {
    ossMd5,
    detailId,
    shopId,
    shopCollectItemInfo,
  }, { retry: false });
}

/** 获取 TikTok 类目必填属性和合规要求 */
export async function miaoshouGetTikTokCategoryMetadata(site: string, categoryId: number, shopIds: number[]) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/get_category_metadata", {
    site,
    cid: categoryId,
    shopIds,
  });
}

/** 发布产品到TK店铺 */
export async function miaoshouPublishToTikTok(detailIds: number[], shopIds: number[]) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/save_move_collect_task", {
    detailIds,
    shopIds,
  }, { retry: false });
}

/** 认领商品到预发布店铺（发布前必须先认领） */
export async function miaoshouClaimToShop(detailIds: number[], shopIds: number[]) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/claim_to_shop", {
    detailIds,
    shopIds,
  }, { retry: false });
}

/** 发布记录列表 */
export async function miaoshouGetPublishRecords(page = 1, pageSize = 20) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/move_collect/search_move_collect_list", {
    pageNo: page,
    pageSize,
  });
}

/** 获取定价模板列表 */
export async function miaoshouGetPriceTemplates(site?: string) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/price_template/get_price_template_list", {
    pageNo: 1,
    pageSize: 20,
    ...(site ? { site } : {}),
  });
}

/** 产品翻译（2026-08 契约：collectItemInfo 数组 + isTranslateSku* 开关，均必填） */
export async function miaoshouTranslateItem(itemId: string, shopId: number, targetLanguage: string) {
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/translate_collect_item_info", {
    collectItemInfo: [{ detailId: Number(itemId), shopId }],
    sourceLanguage: "zh",
    targetLanguage,
    isTranslateSkuItemNum: 1,
    isTranslateSkuProperty: 1,
  }, { retry: false });
}

/**
 * AI 生成商品标题和描述（notes）。
 * 使用本地 LLM 生成内容，然后保存回妙手采集箱，供发布时使用。
 * 不再依赖妙手 AI 资源包。
 */
export async function miaoshouAiGenerateProductInfo(itemId: string, shopId: number, language?: string) {
  const detail = await miaoshouGetTikTokShopCollectItemInfo(Number(itemId), shopId);
  const info = asRecord((detail.data as { shopCollectItemInfo?: unknown })?.shopCollectItemInfo);
  const rawTitle = String(info?.title ?? "").trim();
  const rawDesc = String(info?.description ?? info?.desc ?? "").trim();
  const attributes = info?.attributes ? JSON.stringify(info.attributes) : "";

  if (!rawTitle && !rawDesc) throw new Error("妙手没有返回商品信息，无法生成标题和描述。");

  const targetLanguage = (language ?? "en").trim().toLowerCase();
  const languageName = languageLabel(targetLanguage);
  const systemPrompt = `你是一个专业的跨境电商商品文案专家。根据商品原始信息，生成适合 TikTok Shop 的${languageName}标题和商品描述（notes）。
要求：
- 标题：简洁有力，包含核心关键词，${titleLengthHint(targetLanguage)}
- 描述（notes）：突出卖点、材质、尺寸、使用场景，3-5 句话
- 全文只能用${languageName}，不要混入中文或英文词（品牌名、型号除外）
- 不得出现工厂、批发、跨境、代发等面向采购方而非消费者的词
以 JSON 格式返回：{"title": "...", "notes": "..."}`;

  const userContent = [
    rawTitle ? `原始标题：${rawTitle}` : "",
    rawDesc ? `原始描述：${rawDesc}` : "",
    attributes ? `属性：${attributes}` : "",
  ].filter(Boolean).join("\n");

  // 尝试调用 LLM，如果快速模型失败则切换到主模型
  const fastModelName = fastModel();
  const mainModelName = getLlmRuntimeConfig().model || undefined;
  let result: { content?: string } | undefined;
  let lastError: Error | undefined;

  for (const modelName of [fastModelName, mainModelName].filter(Boolean)) {
    try {
      result = await callLlmRaw({
        systemPrompt,
        messages: [{ role: "user", content: userContent }],
        model: modelName,
        maxTokens: 500,
      });
      if (result.content) break; // 成功则跳出
    } catch (error) {
      lastError = error as Error;
      // 继续尝试下一个模型
    }
  }

  if (!result?.content) {
    // LLM 完全失败，抛出明确错误
    throw new Error(
      `LLM 服务暂时不可用（${lastError?.message ?? "未知错误"}）。请稍后重试，或手动编辑标题和描述。`,
    );
  }

  let generated: { title?: string; notes?: string };
  try {
    // 尝试解析 JSON（LLM 可能返回 markdown 代码块）
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, result.content];
    generated = JSON.parse(jsonMatch[1].trim());
  } catch {
    // 如果不是 JSON，尝试从文本中提取
    const titleMatch = result.content.match(/(?:标题|title)[：:]\s*(.+)/i);
    const notesMatch = result.content.match(/(?:描述|notes|description)[：:]\s*([\s\S]+)/i);
    generated = {
      title: titleMatch?.[1]?.trim(),
      notes: notesMatch?.[1]?.trim(),
    };
  }

  if (!generated.title && !generated.notes) {
    throw new Error(`LLM 生成内容无法解析：${result.content.slice(0, 100)}`);
  }

  // 保存回妙手采集箱
  const ossMd5 = String(info?.ossMd5 ?? "");
  const updatedInfo = { ...info };
  if (generated.title) updatedInfo.title = generated.title;
  if (generated.notes) updatedInfo.notes = generated.notes;

  if (ossMd5) {
    await miaoshouSaveTikTokShopCollectItemInfo(Number(itemId), shopId, ossMd5, updatedInfo);
  }

  return { title: generated.title, notes: generated.notes };
}

/** 获取包裹列表 */
export async function miaoshouGetPackageList(page = 1, pageSize = 20) {
  return miaoshouRequest("/open/v1/order/package/fetch/search_package_list", {
    page,
    pageSize,
  });
}

/** 获取退货退款列表 */
export async function miaoshouGetReturnList(page = 1, pageSize = 20) {
  return miaoshouRequest("/open/v1/order/after_sales/fetch/order_return_list", {
    page,
    pageSize,
    platform: "tiktok",
  });
}

/** 获取采购单列表 */
export async function miaoshouGetPurchaseOrderList(page = 1, pageSize = 20) {
  return miaoshouRequest("/open/v1/ewm/goods_purchase_order/goods_purchase_order/fetch/search_goods_purchase_order_page", {
    page,
    pageSize,
  });
}

/** 获取商品库存列表 */
export async function miaoshouGetInventoryList(page = 1, pageSize = 20) {
  return miaoshouRequest("/open/v1/ewm/storage/warehouse/fetch/search_goods_sku_warehouse_page", {
    page,
    pageSize,
  });
}

// ─── 公共采集箱 CRUD（2026-08 契约：common-collectbox-manage skill）──────────

/** 获取公共采集箱商品详情（含 ossMd5，编辑前必须先调用） */
export async function miaoshouGetCommonCollectBoxDetail(commonCollectBoxDetailId: number) {
  if (!Number.isFinite(commonCollectBoxDetailId)) throw new Error("采集箱商品 ID 无效。");
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail", {
    commonCollectBoxDetailId,
  });
}

/** 新建商品到公共采集箱（title 必填） */
export async function miaoshouAddCommonCollectBoxDetail(product: {
  title: string;
  itemNum?: string;
  notesText?: string;
  notes?: string;
  price?: number;
  stock?: number;
  weight?: number;
  imgUrls?: string[];
  sourceList?: Array<Record<string, unknown>>;
}) {
  if (!product.title?.trim()) throw new Error("新建采集箱商品必须提供 title。");
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/add_common_collect_box_detail", {
    ...product,
  }, { retry: false });
}

/**
 * 编辑公共采集箱商品。
 * 必须携带 get_common_collect_box_detail 返回的最新 ossMd5，否则后端拒绝覆盖。
 */
export async function miaoshouEditCommonCollectBoxDetail(
  commonCollectBoxDetailId: number,
  editCommonCollectBoxDetail: Record<string, unknown>,
  ossMd5: string,
) {
  if (!Number.isFinite(commonCollectBoxDetailId)) throw new Error("采集箱商品 ID 无效。");
  if (!ossMd5) throw new Error("编辑采集箱商品必须先读取详情获取最新 ossMd5。");
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/edit_common_collect_box_detail", {
    commonCollectBoxDetailId,
    editCommonCollectBoxDetail,
    ossMd5,
  }, { retry: false });
}

/** 批量删除公共采集箱商品 */
export async function miaoshouBatchDeleteCommonCollectBoxDetail(commonCollectBoxDetailIds: number[]) {
  if (!commonCollectBoxDetailIds.length) throw new Error("删除采集箱商品至少需要一个 ID。");
  return miaoshouRequest("/open/v1/product/common_collect_box/common_collect_box/batch_delete_common_collect_box_detail", {
    commonCollectBoxDetailIds,
  }, { retry: false });
}

/** 获取店铺仓库列表（发布时选择发货仓库） */
export async function miaoshouGetShopWarehouseList(shopIds: number[]) {
  if (!shopIds.length) throw new Error("查询仓库列表至少需要一个店铺 ID。");
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/get_shop_warehouse_list", {
    shopIds,
  });
}

/** 获取店铺欧盟责任人（GPSR 合规）列表 */
export async function miaoshouGetResponsiblePersonList(shopId: number, refresh = 0) {
  if (!Number.isFinite(shopId)) throw new Error("店铺 ID 无效。");
  return miaoshouRequest("/open/v1/product/collect_box/tiktok/collect_box/get_responsible_person_list", {
    shopId,
    refresh,
  });
}

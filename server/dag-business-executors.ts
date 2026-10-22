/**
 * DAG 真实业务执行器 —— 五能力源业务闭环
 *
 * 把出海匠（TikTok 市场情报）、TMAPI（1688 货源）、妙手 ERP（采集/认领/翻译/发布）
 * 的真实 API 能力注册为 DAG 执行器，供 dag-templates.ts 的「选品上架闭环」模板使用。
 *
 * 权限边界（与审批闭环约定一致）：
 * - chuhaijiang_search / tmapi_search：只读数据查询，可直接执行
 * - miaoshou_collect：写操作（写入公共采集箱），但仅影响内部采集箱，风险低，模板中
 *   位于用户已确认的选品决策之后
 * - miaoshou_claim / miaoshou_ai_match / miaoshou_content：改写采集箱数据，模板中位于
 *   选品确认之后
 * - miaoshou_publish：发布到 TikTok 店铺（对外可见操作），模板中必须紧跟在
 *   human_gate 审批节点之后，用户在审批卡确认后才执行
 *
 * 所有执行器约定：真实 API 调用失败时抛错，节点标记 failed，运营可对失败节点重试
 * （DAG 引擎 retry 只重跑失败节点，不会重复执行已完成的写操作）。
 */

import type { DagExecutionContext } from "./dag-workflow-engine.ts";
import { registerExecutor } from "./dag-workflow-engine.ts";
import {
  miaoshouFetchItem,
  miaoshouWaitForCollection,
  miaoshouClaimToPlatform,
  miaoshouClaimToShop,
  miaoshouAiMatchCategory,
  miaoshouAiMatchAttribute,
  miaoshouTranslateItem,
  miaoshouAiGenerateProductInfo,
  miaoshouPublishToTikTok,
  miaoshouGetShopList,
} from "./miaoshou-client.ts";
import { searchTmapiItemsByKeyword } from "./tmapi-client.ts";
import { callChuhaijiangTool } from "./chuhaijiang-client.ts";
import { getChuhaijiangRuntimeConfig } from "./runtime-config.ts";

// ─── 小工具 ────────────────────────────────────────────────────

const str = (v: unknown): string => String(v ?? "").trim();

const toNumbers = (v: unknown): number[] => {
  const arr = Array.isArray(v) ? v : v !== undefined && v !== null ? [v] : [];
  return arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
};

/** 简单延时（妙手 OpenAPI 对账号有每秒请求频率限制） */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 自动解析妙手 TikTok 店铺（运营未显式提供 shopIds 时兜底）。
 * 按常见站点顺序查询，返回第一个非空站点的店铺 ID 与站点代码。
 */
async function resolveMiaoshouShop(): Promise<{ shopIds: number[]; site: string } | undefined> {
  const prioritySites = ["TH", "US", "MY", "PH", "SG", "VN", "ID", "UK"];
  for (const site of prioritySites) {
    try {
      const result = await miaoshouGetShopList("tiktok", site);
      const shops = ((result.data ?? {}) as { shopList?: Array<Record<string, unknown>> }).shopList ?? [];
      const ids = shops
        .map((s) => Number(s.shopId))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length) return { shopIds: ids, site };
    } catch {
      // 该站点无权限或失败，继续查下一站
    }
    await sleep(1200);
  }
  return undefined;
}

/** 从 DAG 初始输入或指定上游节点输出中取值（input 优先，其次按 nodeIds 顺序） */
function pick(ctx: DagExecutionContext, field: string, nodeIds: string[]): unknown {
  if (ctx.input[field] !== undefined) return ctx.input[field];
  for (const nodeId of nodeIds) {
    const out = ctx.outputs[nodeId];
    if (out && out[field] !== undefined) return out[field];
  }
  return undefined;
}

/** 从上游搜索节点输出中提取 1688 商品链接 */
function extractSourceUrls(ctx: DagExecutionContext, nodeIds: string[]): string[] {
  const urls: string[] = [];
  for (const nodeId of nodeIds) {
    const items = ctx.outputs[nodeId]?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const rec = (it ?? {}) as Record<string, unknown>;
      const u = str(rec.product_url ?? rec.item_url ?? rec.itemUrl ?? rec.url ?? rec.source_url);
      if (u) urls.push(u);
    }
  }
  return urls;
}

// ─── 只读数据源 ────────────────────────────────────────────────

/** 出海匠 TikTok 美区市场情报搜索（只读）。未配置 Key 时降级跳过，不阻塞闭环。 */
registerExecutor("chuhaijiang_search", async (input, ctx) => {
  const keyword = str(pick(ctx, "keyword", []));
  if (!keyword) throw new Error("请提供搜索关键词。");
  // 出海匠 search 的 limit 硬上限为 10，超出时服务端仍返回 isError=false，只在正文里带 error
  const limit = Math.min(10, Math.max(1, Math.trunc(Number(pick(ctx, "limit", []) ?? 10)) || 10));
  // 出海匠 search 必填 entity + country；默认搜美区爆品，允许入参覆盖
  const entity = str(pick(ctx, "entity", []) ?? input.entity ?? "products");
  const country = str(pick(ctx, "country", []) ?? input.country ?? "us");

  const { apiKey } = getChuhaijiangRuntimeConfig();
  if (!apiKey) {
    return { skipped: true, reason: "出海匠 API Key 未配置", found: false, items: [], count: 0 };
  }

  const result = await callChuhaijiangTool("chuhaijiang_search", { keyword, limit, entity, country });
  if (result.isError) throw new Error(result.content);

  let items: unknown[] = [];
  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown> | unknown[];
    // 参数校验失败时出海匠返回 { error, invalid_param } 且 isError=false，必须显式上抛，
    // 否则会被当成“无搜索结果”，工作流静默走空结果分支
    if (Array.isArray(parsed)) {
      items = parsed;
    } else {
      if (typeof parsed?.error === "string" && parsed.error.trim()) {
        throw new Error(`出海匠返回错误：${parsed.error}`);
      }
      const nestedData = parsed?.data;
      const nestedItems = nestedData && typeof nestedData === "object" ? (nestedData as Record<string, unknown>).items : undefined;
      const rawItems = parsed?.items ?? nestedItems ?? nestedData ?? [];
      items = Array.isArray(rawItems) ? rawItems : [];
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("出海匠返回错误")) throw error;
    items = [];
  }
  return {
    keyword,
    source: "chuhaijiang",
    found: items.length > 0,
    items,
    count: items.length,
    summary: `出海匠返回 ${items.length} 条 TikTok 选品情报`,
  };
});

/** TMAPI 1688 关键词搜索货源（只读） */
registerExecutor("tmapi_search", async (input, ctx) => {
  const keyword = str(pick(ctx, "keyword", []));
  if (!keyword) throw new Error("请提供搜索关键词。");
  const pageSize = Number(pick(ctx, "pageSize", []) ?? 12);

  const result = await searchTmapiItemsByKeyword(keyword, {
    pageSize: Math.min(20, Math.max(1, Math.trunc(pageSize) || 12)),
    ...(input.supportDropshipping ? { supportDropshipping: Boolean(input.supportDropshipping) } : {}),
    ...(input.freeShipping ? { freeShipping: Boolean(input.freeShipping) } : {}),
  });

  const items = result.items ?? [];
  return {
    keyword,
    source: "tmapi_1688",
    found: items.length > 0,
    items,
    count: items.length,
    totalCount: result.total_count ?? items.length,
    summary: `1688 货源搜索返回 ${items.length} 条（共 ${result.total_count ?? items.length} 条）`,
  };
});

// ─── 妙手 ERP 写操作链 ─────────────────────────────────────────

/** 第 1 步：采集货源到妙手公共采集箱，轮询等待采集完成，返回 detailIds */
registerExecutor("miaoshou_collect", async (input, ctx) => {
  const rawUrls = pick(ctx, "sourceUrls", []);
  let sourceUrls = Array.isArray(rawUrls) ? rawUrls.map(str).filter(Boolean) : [];
  if (!sourceUrls.length) {
    sourceUrls = extractSourceUrls(ctx, ["tmapi_search", "chuhaijiang_search"]);
  }
  if (!sourceUrls.length) {
    throw new Error("未找到可采集的 1688 商品链接：请在 sourceUrls 中提供，或先执行搜索步骤。");
  }
  // 妙手 OpenAPI 账号级限流（每秒约 1 次），默认每次最多采集 3 个，可被入参 maxCollect 覆盖
  const maxCollect = Number(pick(ctx, "maxCollect", []) ?? input.maxCollect ?? 3);
  const limitedUrls = sourceUrls.slice(0, Math.max(1, Math.min(10, Math.trunc(maxCollect) || 3)));
  const platform = str(pick(ctx, "sourcePlatform", [])) || "1688";

  const collected: Array<{ sourceUrl: string; sourceItemId: string; detailId: string }> = [];
  for (const [idx, url] of limitedUrls.entries()) {
    if (idx > 0) await sleep(1500); // 每个采集请求间隔 ≥1.5s，避免触发频率限制
    const fetched = await miaoshouFetchItem(url, platform);
    const data = (fetched.data ?? {}) as Record<string, unknown>;
    // API 返回 { sourceItemIdAndDetailIdMap: { "1688_id": detailId } }
    const map = (data.sourceItemIdAndDetailIdMap ?? {}) as Record<string, unknown>;
    const sourceIds = Object.keys(map);
    if (!sourceIds.length) {
      collected.push({ sourceUrl: url, sourceItemId: "", detailId: "" });
      continue;
    }
    const waitResult = await miaoshouWaitForCollection(sourceIds, 30000, 3000);
    for (const w of waitResult) {
      collected.push({ sourceUrl: url, sourceItemId: w.sourceItemId, detailId: w.detailId });
    }
  }

  const detailIds = collected
    .map((c) => Number(c.detailId))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!detailIds.length) {
    throw new Error("采集未完成：30 秒内没有商品入库，请检查 1688 链接是否有效。");
  }
  return {
    collected,
    detailIds,
    detailIdCount: detailIds.length,
    summary: `已采集 ${detailIds.length} 个商品到妙手公共采集箱`,
  };
});

/** 第 2 步：认领商品到 TikTok 平台采集箱 */
registerExecutor("miaoshou_claim", async (input, ctx) => {
  const detailIds = toNumbers(pick(ctx, "detailIds", ["miaoshou_collect"]));
  if (!detailIds.length) throw new Error("没有可认领的商品 detailId，请先完成采集。");
  const platform = str(pick(ctx, "targetPlatform", [])) || "tiktok";

  const result = await miaoshouClaimToPlatform(detailIds, platform);
  // 认领后 detailId 会变化：claimed 接口返回 platformCollectBoxDetailIdMap[platform][公共id] = 平台采集箱新id，
  // 下游编辑/认领到店铺/发布必须使用平台采集箱的新 detailId（公共采集箱的旧 id 会查不到产品）。
  const claimData = (result.data ?? {}) as Record<string, unknown>;
  const platformMap = (claimData.platformCollectBoxDetailIdMap ?? {}) as Record<string, unknown>;
  const platformBucket = (platformMap[platform] ?? platformMap.tiktok ?? platformMap) as Record<string, unknown> | undefined;
  const platformDetailIds: number[] = [];
  if (platformBucket && typeof platformBucket === "object") {
    for (const v of Object.values(platformBucket)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) platformDetailIds.push(n);
    }
  }
  const effectiveDetailIds = platformDetailIds.length ? platformDetailIds : detailIds;
  return {
    claimed: true,
    detailIds: effectiveDetailIds,
    sourceDetailIds: detailIds,
    platform,
    raw: JSON.stringify(result.data ?? {}).slice(0, 500),
    summary: `已认领 ${detailIds.length} 个商品到 ${platform.toUpperCase()} 采集箱`,
  };
});

/** 第 3 步：认领到预发布店铺 + AI 匹配类目和属性 */
registerExecutor("miaoshou_ai_match", async (input, ctx) => {
  const detailIds = toNumbers(pick(ctx, "detailIds", ["miaoshou_claim", "miaoshou_collect"]));
  let shopIds = toNumbers(pick(ctx, "shopIds", []));
  let site = str(pick(ctx, "site", []));
  if (!shopIds.length) {
    const resolved = await resolveMiaoshouShop();
    if (resolved) {
      shopIds = resolved.shopIds;
      if (!site) site = resolved.site;
    }
  }
  if (!detailIds.length) throw new Error("没有商品 detailId。");
  if (!shopIds.length) {
    throw new Error("没有店铺 shopId：妙手账号下未找到 TikTok 店铺，请先在妙手后台授权店铺，或在指令中提供店铺编号。");
  }
  site = site || "US";

  const itemId = String(detailIds[0]);

  await miaoshouClaimToShop(detailIds, shopIds);

  const aim = await miaoshouAiMatchCategory([itemId], shopIds.map(String));
  const d = (aim.data ?? {}) as Record<string, unknown>;
  const cid = str(d.category_id ?? d.cid ?? d.categoryId);

  let attributeMatched = false;
  if (cid) {
    await miaoshouAiMatchAttribute(itemId, cid, site);
    attributeMatched = true;
  }

  return {
    claimedToShop: true,
    shopIds,
    site,
    cid,
    attributeMatched,
    summary: `已认领到店铺并完成 AI 类目匹配（cid=${cid || "--"}，属性匹配=${attributeMatched ? "是" : "否"}）`,
  };
});

/** 第 4 步：商品翻译 + AI 生成标题描述 */
registerExecutor("miaoshou_content", async (input, ctx) => {
  const detailIds = toNumbers(pick(ctx, "detailIds", ["miaoshou_claim", "miaoshou_collect"]));
  let shopIds = toNumbers(pick(ctx, "shopIds", ["miaoshou_ai_match"]));
  if (!shopIds.length) {
    const resolved = await resolveMiaoshouShop();
    if (resolved) shopIds = resolved.shopIds;
  }
  const shopId = shopIds[0];
  if (!detailIds.length || !shopId) {
    throw new Error("缺少 detailId 或 shopId：请先完成采集并提供店铺编号。");
  }
  const itemId = String(detailIds[0]);
  const lang = str(pick(ctx, "targetLanguage", [])) || "en";

  await miaoshouTranslateItem(itemId, shopId, lang);
  await miaoshouAiGenerateProductInfo(itemId, shopId, lang);

  return {
    itemId,
    shopId,
    lang,
    translated: true,
    copyGenerated: true,
    summary: `已完成翻译（→${lang}）和 AI 标题/描述生成`,
  };
});

/** 第 5 步：发布到 TikTok 店铺。模板中必须位于 human_gate 审批节点之后。 */
registerExecutor("miaoshou_publish", async (input, ctx) => {
  const detailIds = toNumbers(pick(ctx, "detailIds", ["miaoshou_claim", "miaoshou_collect"]));
  let shopIds = toNumbers(pick(ctx, "shopIds", ["miaoshou_ai_match", "miaoshou_content"]));
  if (!shopIds.length) {
    const resolved = await resolveMiaoshouShop();
    if (resolved) shopIds = resolved.shopIds;
  }
  if (!detailIds.length || !shopIds.length) {
    throw new Error("缺少 detailId 或 shopId：无法发布。");
  }

  const result = await miaoshouPublishToTikTok(detailIds, shopIds);
  return {
    published: true,
    detailIds,
    shopIds,
    raw: JSON.stringify(result.data ?? {}).slice(0, 500),
    summary: `已提交发布任务：${detailIds.length} 个商品 → ${shopIds.length} 个店铺`,
  };
});

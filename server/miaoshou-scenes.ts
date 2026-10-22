import type { MessageArtifact } from "../shared/contracts.ts";
import { languageForSite } from "./tiktok-sites.ts";
import {
  hasMiaoshouConfiguration,
  miaoshouFetchItem,
  miaoshouGetCommonCollectBoxList,
  miaoshouGetTikTokCollectBoxList,
  miaoshouGetTikTokCategoryTree,
  miaoshouAiMatchCategory,
  miaoshouAiMatchAttribute,
  miaoshouTranslateItem,
  miaoshouAiGenerateProductInfo,
  miaoshouGetShopList,
  miaoshouResolveSite,
  miaoshouPublishToTikTok,
  miaoshouGetPublishRecords,
  miaoshouGetPriceTemplates,
  miaoshouGetPackageList,
  miaoshouGetReturnList,
  miaoshouGetPurchaseOrderList,
  miaoshouGetInventoryList,
  miaoshouClaimToPlatform,
  miaoshouClaimToShop,
  miaoshouWaitForCollection,
} from "./miaoshou-client.ts";

export type MiaoshouSceneQuery =
  | "collect_item"
  | "common_collect_box"
  | "tiktok_collect_box"
  | "tiktok_categories"
  | "ai_match_category"
  | "supplement_info"
  | "claim_to_platform"
  | "miaoshou_shops"
  | "publish_to_tiktok"
  | "publish_records"
  | "price_templates"
  | "miaoshou_packages"
  | "miaoshou_returns"
  | "miaoshou_purchase_orders"
  | "miaoshou_inventory";

export interface MiaoshouSceneResult {
  content: string;
  artifact: Extract<MessageArtifact, { kind: "records" }>;
}

/** 从文本中提取1688链接 */
function extract1688Url(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s]+1688[^\s]*/i) ?? text.match(/detail\.1688\.com\/offer\/\d+/i);
  return match?.[0];
}

/** 推断采集上架场景查询 */
export function inferMiaoshouSceneQuery(text: string): MiaoshouSceneQuery | undefined {
  // 采集相关（有 URL 直接采集，无 URL 也匹配以便提示用户）
  if (/(采集|抓取|爬取|拉取).*(1688|货源|链接)|1688.*采集|货源.*采集/i.test(text)) {
    return "collect_item";
  }
  // 发布意图先行判断：消息里同时出现「认领」和「发布到店铺/tiktok」时，认领只是修饰语，
  // 真实意图是发布（如「把 TikTok 采集箱里最近认领的商品发布到店铺」）。
  const publishIntentText = /(发布|上架|铺货).*(tk|tiktok|店铺)|上架.*(tk|tiktok)/i.test(text);
  // 认领相关（采集后认领到平台采集箱）
  if (!publishIntentText && /(认领|claim|搬品|搬到|转到|导入到).*(tk|tiktok|平台|采集箱|店铺)|认领/i.test(text)) return "claim_to_platform";
  // TK 采集箱（优先于公共采集箱匹配）
  if (/(tk|tiktok).*(采集箱|采集)/i.test(text) && /(查看|查询|列表)/i.test(text)) return "tiktok_collect_box";
  if (/(采集箱|公共采集|collect box)/i.test(text) && /(查看|查询|列表|有哪些|多少)/i.test(text)) return "common_collect_box";
  if (/((类目|分类|category).*(查看|查询|列表|有哪些)|(查看|查询|列表|有哪些).*(类目|分类|category))/i.test(text) && /(采集上架|采集|tk|tiktok)/i.test(text)) return "tiktok_categories";
  if (/(补充信息|补充资料|完善信息|完善商品|匹配类目|匹配属性|生成标题|生成描述|翻译商品|商品翻译)|(?:ai匹配|智能匹配|自动匹配).*(?:类目|分类|属性|信息)/i.test(text)) return "supplement_info";

  // 发布相关（publishIntentText 已在上面算过，避免与认领判断口径不一致）
  if (publishIntentText) {
    if (/(记录|状态|结果|进度)/i.test(text)) return "publish_records";
    return "publish_to_tiktok";
  }
  if (/(发布记录|上架记录|铺货记录|发布状态)/i.test(text)) return "publish_records";
  if (/(定价模板|价格模板|pricing template)/i.test(text)) return "price_templates";

  // 采集上架店铺
  if (/((?:采集上架|妙手).*店铺|店铺.*(?:采集上架|妙手)|授权.*(?:采集上架|妙手)|(?:采集上架|妙手).*授权)/i.test(text)) return "miaoshou_shops";

  // 库存、包裹和售后在 TikTok 与采集上架都有同名能力。只有明确指定采集上架/ERP 时才走采集上架，
  // 避免普通的"查看店铺库存/退款"被错误分配到供应链侧。
  const explicitErpContext = /(采集上架|妙手|erp)/i.test(text);
  if (explicitErpContext && /(包裹|运单|package)/i.test(text) && /(查看|查询|列表)/i.test(text)) return "miaoshou_packages";
  if (explicitErpContext && /(退货|退款|售后|return)/i.test(text) && /(查看|查询|列表)/i.test(text)) return "miaoshou_returns";
  if (/(采购单|采购|补货|进货|1688.*采购)/i.test(text) && /(查看|查询|列表)/i.test(text)) return "miaoshou_purchase_orders";
  if (explicitErpContext && /(库存|仓储|warehouse|stock)/i.test(text) && /(查看|查询|列表)/i.test(text)) return "miaoshou_inventory";

  return undefined;
}

function recordsArtifact(input: {
  headline: string;
  records: Array<Record<string, unknown>>;
  columns: Array<{ key: string; label: string }>;
  source: string;
  summary?: string;
  emptyLabel?: string;
}): Extract<MessageArtifact, { kind: "records" }> {
  const rows = input.records.slice(0, 100).map((record) =>
    Object.fromEntries(input.columns.map(({ key }) => {
      const value = record[key];
      if (value === undefined || value === null || value === "") return [key, "--"];
      if (typeof value === "object") return [key, JSON.stringify(value).slice(0, 80)];
      return [key, String(value)];
    }))
  );
  return {
    kind: "records",
    headline: input.headline,
    summary: input.summary ?? `共 ${input.records.length} 条记录。`,
    columns: input.columns.map(({ key, label }) => ({ key, label })),
    rows,
    source: input.source,
    emptyLabel: input.emptyLabel,
  };
}

function formatTime(timestamp: unknown): string {
  if (!timestamp) return "--";
  const num = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (Number.isNaN(num)) return String(timestamp);
  const ms = num > 1_000_000_000_000 ? num : num * 1000;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 判断值是否为有效数字 ID（排除 "未映射"、"待入库"、"--"、空字符串等） */
function isValidId(val: unknown): val is string | number {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (!s || s === "--" || s === "未映射" || s === "待入库" || s === "认领失败") return false;
  const num = Number(s);
  return !Number.isNaN(num) && num > 0;
}

/** 将值转为数字 ID，无效则返回 0 */
function toId(val: unknown): number {
  if (!isValidId(val)) return 0;
  return Number(String(val).trim());
}

/**
 * 从对话历史中提取 TK 采集箱 detail ID（用于发布）。
 * 只认领结果中的 platform_detail_id、TK 采集箱列表中的 collectBoxDetailId。
 */
function extractTiktokDetailIdsFromHistory(history?: Array<{ role: string; content: string; artifact?: unknown }>): number[] {
  if (!history) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const artifact = msg.artifact as { kind?: string; rows?: Array<Record<string, unknown>> } | undefined;
    if (artifact?.kind === "records" && artifact.rows?.length) {
      const ids: number[] = [];
      for (const row of artifact.rows) {
        if (row.type === "店铺") continue;
        if (row.shopId !== undefined || row.shop_id !== undefined) continue;
        // 发布只认 TK 采集箱 ID
        const val = row.platform_detail_id ?? row.collectBoxDetailId;
        const num = toId(val);
        if (num > 0) ids.push(num);
      }
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

/**
 * 从对话历史中提取公共采集箱 detail ID（用于认领）。
 * 认领结果中的 detail_id、公共采集箱列表中的 commonCollectBoxDetailId。
 */
function extractDetailIdsFromHistory(history?: Array<{ role: string; content: string; artifact?: unknown }>): number[] {
  if (!history) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const artifact = msg.artifact as { kind?: string; rows?: Array<Record<string, unknown>> } | undefined;
    if (artifact?.kind === "records" && artifact.rows?.length) {
      const ids: number[] = [];
      for (const row of artifact.rows) {
        // 跳过店铺行（组合列表中有 type="店铺" 的行）
        if (row.type === "店铺") continue;
        if (row.shopId !== undefined || row.shop_id !== undefined || row["店铺 ID"] !== undefined) continue;
        // 认领用公共采集箱 ID：优先 platform_detail_id（认领结果），其次 commonCollectBoxDetailId（采集结果）
        // 用 || 而非 ?? ，这样 "未映射" 等无效字符串也会被跳过
        const val = row.platform_detail_id || row.commonCollectBoxDetailId || row.collectBoxDetailId || row.detail_id || row.item_id || row["采集箱 ID"] || row["商品 ID"];
        const num = toId(val);
        if (num > 0) ids.push(num);
      }
      if (ids.length > 0) return ids;
    }
  }
  // 兆底：从 content 文本中提取数字（仅限明确的 detailId= 格式）
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    // 只匹配 "detailId=数字" 或 "detail_id=数字" 格式，避免误抓
    const matches = msg.content.match(/detail_?id[=：:]\s*(\d{6,12})/gi);
    if (matches && matches.length > 0) {
      return matches
        .map((m) => Number(m.match(/\d+/)?.[0] ?? "0"))
        .filter((n) => n > 100000 && n < 99999999999);
    }
  }
  return [];
}

/** 从对话历史中提取店铺 ID（支持多种 artifact 格式） */
function extractShopIdsFromHistory(history?: Array<{ role: string; content: string; artifact?: unknown }>): number[] {
  if (!history) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const artifact = msg.artifact as { kind?: string; rows?: Array<Record<string, unknown>> } | undefined;
    if (artifact?.kind === "records" && artifact.rows?.length) {
      const ids: number[] = [];
      for (const row of artifact.rows) {
        // 支持组合列表中的店铺行（type="店铺"）
        if (row.type === "店铺") {
          const val = row.id ?? row.shopId ?? row.shop_id ?? row["店铺 ID"];
          if (val) {
            const num = Number(val);
            if (!Number.isNaN(num) && num > 0) ids.push(num);
          }
          continue;
        }
        // 支持单独的店铺列表（有 shopId 字段的行）
        const val = row.shopId ?? row.shop_id ?? row["店铺 ID"];
        if (val) {
          const num = Number(val);
          if (!Number.isNaN(num) && num > 0) ids.push(num);
        }
      }
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

function isPermissionError(msg: string): boolean {
  return msg.includes("无权限") || msg.includes("应用无权限");
}

/** 类目表最多展示的叶子节点数：TikTok 站点类目动辄上千条，全量塞进表格会拖垮界面 */
const MAX_CATEGORY_ROWS = 200;

interface FlatCategory {
  id: unknown;
  name: string;
  path: string;
  isLeaf: boolean;
}

/**
 * 递归展平 `cateTree`。
 * 采集上架返回的是嵌套 children（对象 map），且 `isLastLevel` 是字符串 "1"/"0"——
 * 直接当布尔用会让所有类目都变成叶子（"0" 在 JS 里是真值）。
 */
function flattenCategoryTree(tree: Record<string, unknown>): FlatCategory[] {
  const out: FlatCategory[] = [];
  const walk = (node: unknown, parentPath: string) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const name = String(record.nameChinese ?? record.name ?? "").trim();
    if (!name) return;
    const path = parentPath ? `${parentPath} > ${name}` : name;
    out.push({
      id: record.cid,
      name,
      path,
      isLeaf: String(record.isLastLevel ?? "0").trim() === "1",
    });
    const children = record.children;
    const list = Array.isArray(children)
      ? children
      : children && typeof children === "object"
        ? Object.values(children as Record<string, unknown>)
        : [];
    for (const child of list) walk(child, path);
  };
  for (const root of Object.values(tree)) walk(root, "");
  return out;
}

async function supplementInfoFlow(
  history: Array<{ role: string; content: string; artifact?: unknown }> | undefined,
  _originalText: string,
  now: string,
): Promise<MiaoshouSceneResult> {
  // 补充信息需要 TK 采集箱 ID（认领后才有），不能用公共采集箱 ID
  let detailIds = extractTiktokDetailIdsFromHistory(history);
  let shopIds = extractShopIdsFromHistory(history);

  let site = "";
  try {
    const shopRes = await miaoshouGetShopList("tiktok", "all");
    const list = (shopRes.data as { shopList?: Array<Record<string, unknown>> }).shopList ?? [];
    if (!shopIds.length && list.length === 1) {
      const id = Number(list[0].shopId);
      if (!Number.isNaN(id) && id > 0) shopIds = [id];
    }
    const matched = shopIds.length ? list.find((s) => Number(s.shopId) === shopIds[0]) : list[0];
    if (matched) site = String(matched.site ?? "");
  } catch {
    // 店铺查询失败不阻断
  }
  // 站点 → 语言走统一映射：不要在场景层写死语言，否则站点一换文案就跑偏
  const lang = languageForSite(site);

  if (!detailIds.length) {
    return {
      content: "补充信息需要先有 TikTok 采集箱中的商品。请先采集 1688 链接，再认领到 TikTok 采集箱。",
      artifact: recordsArtifact({
        headline: "补充信息",
        records: [],
        columns: [{ key: "info", label: "说明" }],
        source: `采集上架服务 · ${now}`,
        emptyLabel: "请先采集并认领商品到 TikTok 采集箱。",
      }),
    };
  }

  const itemId = String(detailIds[0]);
  const shopIdStrs = shopIds.map(String);
  const rows: Array<Record<string, string>> = [];
  const pushRow = (step: string, status: string, detail: string) =>
    rows.push({ step, status, detail: detail.slice(0, 120) });
  let permBlocked = false;

  let cid = "";
  try {
    const aim = await miaoshouAiMatchCategory([itemId], shopIdStrs);
    const d = aim.data as Record<string, unknown> | undefined;
    cid = String(
      (d as { category_id?: string; cid?: string; categoryId?: string })?.category_id ??
      (d as { cid?: string })?.cid ??
      "",
    );
    pushRow("AI 类目匹配", "成功", `category_id=${cid || "--"} ${JSON.stringify(d ?? {}).slice(0, 80)}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (isPermissionError(msg)) permBlocked = true;
    pushRow("AI 类目匹配", "失败", msg);
  }

  if (cid) {
    try {
      const aam = await miaoshouAiMatchAttribute(itemId, cid, site);
      pushRow("AI 属性匹配", "成功", JSON.stringify(aam.data ?? {}).slice(0, 100));
    } catch (e) {
      const msg = (e as Error).message;
      if (isPermissionError(msg)) permBlocked = true;
      pushRow("AI 属性匹配", "失败", msg);
    }
  }

  const numericShopId = Number(shopIds[0]);
  if (!Number.isFinite(numericShopId) || numericShopId <= 0) {
    pushRow("商品翻译 / AI 生成", "跳过", "未找到采集上架店铺编号，请先授权店铺");
  } else {
  try {
    const tr = await miaoshouTranslateItem(itemId, numericShopId, lang);
    pushRow("商品翻译", "成功", `目标语言=${lang} ${JSON.stringify(tr.data ?? {}).slice(0, 80)}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (isPermissionError(msg)) permBlocked = true;
    pushRow("商品翻译", "失败", msg);
  }

  try {
    const gi = await miaoshouAiGenerateProductInfo(itemId, numericShopId, lang);
    pushRow("AI 生成标题描述", "成功", JSON.stringify(gi ?? {}).slice(0, 100));
  } catch (e) {
    const msg = (e as Error).message;
    if (isPermissionError(msg)) permBlocked = true;
    pushRow("AI 生成标题描述", "失败", msg);
  }
  }

  const summary = permBlocked
    ? "部分接口在采集上架服务未授权（应用无权限）。请到 采集上架服务 → 开放平台 → 应用管理 → 接口权限，勾选：AI 类目匹配、AI 属性匹配、商品翻译、AI 生成商品信息，保存后重试。"
    : `已对商品 ${itemId} 执行补充信息（类目 / 属性 / 翻译 / 标题描述）。`;

  return {
    content: summary,
    artifact: recordsArtifact({
      headline: "补充信息",
      records: rows,
      columns: [
        { key: "step", label: "步骤" },
        { key: "status", label: "状态" },
        { key: "detail", label: "详情" },
      ],
      source: `采集上架服务 · AI 补充信息 · ${now}`,
      emptyLabel: "未执行任何补充信息步骤。",
    }),
  };
}

/** 执行采集上架场景查询 */
export async function runMiaoshouSceneQuery(
  query: MiaoshouSceneQuery,
  originalText: string,
  history?: Array<{ role: string; content: string; artifact?: unknown }>,
): Promise<MiaoshouSceneResult> {
  if (!hasMiaoshouConfiguration()) {
    return {
      content: "采集上架服务 尚未配置，无法执行此操作。",
      artifact: recordsArtifact({
        headline: "采集上架服务 未配置",
        records: [],
        columns: [{ key: "info", label: "信息" }],
        source: "采集上架服务",
        emptyLabel: "请先在 .env 中配置 MIAOSHOU_APP_KEY 和 MIAOSHOU_APP_SECRET。",
      }),
    };
  }

  const now = new Date().toLocaleString("zh-CN", { hour12: false });

  switch (query) {
    case "collect_item": {
      const url = extract1688Url(originalText);
      if (!url) {
        return {
          content: "请提供 1688 商品链接，我来帮你采集。",
          artifact: recordsArtifact({
            headline: "采集货源",
            records: [],
            columns: [{ key: "info", label: "说明" }],
            source: "采集上架服务",
            emptyLabel: "请在指令中粘贴 1688 商品链接。",
          }),
        };
      }
      const result = await miaoshouFetchItem(url);
      const data = result.data as Record<string, unknown> | undefined;
      // API 返回 { sourceItemIdAndDetailIdMap: { "1688_id": detailId } }
      const map = (data?.sourceItemIdAndDetailIdMap ?? {}) as Record<string, unknown>;
      const entries = Object.entries(map);
      const sourceIds = entries.map(([id]) => id);

      // 等待采集真正完成（轮询公共采集箱）
      let finalRecords: Array<Record<string, string>> = [];
      let waitMsg = "";
      if (sourceIds.length > 0) {
        const waitResult = await miaoshouWaitForCollection(sourceIds, 30000, 3000);
        finalRecords = waitResult.map((r) => ({
          commonCollectBoxDetailId: r.detailId || "待入库",
          source_item_id: r.sourceItemId,
          source_url: url,
          status: r.detailId ? "采集成功" : "采集中...",
        }));
        const successCount = waitResult.filter((r) => r.detailId).length;
        waitMsg = successCount === sourceIds.length
          ? `已采集 ${sourceIds.length} 个商品到公共采集箱。`
          : `采集请求已提交，${successCount}/${sourceIds.length} 个已入库，其余仍在处理中。`;
      } else {
        waitMsg = "采集请求已提交，但未返回映射结果。";
      }

      return {
        content: waitMsg,
        artifact: recordsArtifact({
          headline: "采集结果",
          records: finalRecords.length > 0 ? finalRecords : entries.map(([sourceId, detailId]) => ({
            commonCollectBoxDetailId: String(detailId),
            source_item_id: sourceId,
            source_url: url,
            status: "采集成功",
          })),
          columns: [
            { key: "commonCollectBoxDetailId", label: "采集箱 ID" },
            { key: "source_item_id", label: "1688 商品 ID" },
            { key: "source_url", label: "来源链接" },
            { key: "status", label: "状态" },
          ],
          source: `采集上架服务 · fetch_item · ${now}`,
          emptyLabel: "采集请求已提交，结果可能需要一些时间处理。",
        }),
      };
    }

    case "common_collect_box": {
      const result = await miaoshouGetCommonCollectBoxList();
      const data = result.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
      // API 返回字段为 detailList（参考 Python collectbox_crud.py）
      const list = data?.detailList ?? data?.list ?? [];
      return {
        content: `已读取采集上架公共采集箱，共 ${data?.total ?? list.length} 个商品。`,
        artifact: recordsArtifact({
          headline: "公共采集箱",
          records: list,
          columns: [
            { key: "commonCollectBoxDetailId", label: "采集箱 ID" },
            { key: "title", label: "商品名称" },
            { key: "price", label: "价格" },
            { key: "status", label: "状态" },
            { key: "gmtCreate", label: "采集时间" },
          ],
          source: `采集上架服务 · get_common_collect_box_list · ${now}`,
          emptyLabel: "采集箱为空，请先采集 1688 商品链接。",
        }),
      };
    }

    case "tiktok_collect_box": {
      const result = await miaoshouGetTikTokCollectBoxList();
      const data = result.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
      // API 返回字段为 detailList（经实际验证确认）
      const list = data?.detailList ?? data?.list ?? [];
      const count = data?.total ?? list.length;
      return {
        content: count
          ? `TikTok 采集箱里有 ${count} 个商品，可以直接进入发布流程。`
          : "TikTok 采集箱是空的。商品要先从公共采集箱认领过来才会出现在这里，认领之后才能做类目匹配和发布。",
        artifact: recordsArtifact({
          headline: "TikTok 采集箱",
          records: list,
          columns: [
            { key: "collectBoxDetailId", label: "采集箱 ID" },
            { key: "title", label: "商品名称" },
            { key: "category_name", label: "类目" },
            { key: "status", label: "状态" },
            { key: "create_time", label: "创建时间" },
          ],
          source: `采集上架服务 · search_collect_box_detail_list · ${now}`,
          emptyLabel: "TikTok 采集箱为空，请先从公共采集箱认领商品。",
        }),
      };
    }

    case "tiktok_categories": {
      // 类目站点必须跟随店铺实际站点，不能写死
      const site = await miaoshouResolveSite();
      if (!site) {
        return {
          content: "没有从采集上架读到已授权的 TikTok 店铺，无法确定该用哪个站点的类目树。请先在采集上架后台完成店铺授权。",
          artifact: recordsArtifact({
            headline: "TikTok 类目列表",
            records: [],
            columns: [{ key: "info", label: "说明" }],
            source: `采集上架服务 · ${now}`,
            emptyLabel: "采集上架账号下没有可用的 TikTok 店铺。",
          }),
        };
      }
      const result = await miaoshouGetTikTokCategoryTree(site);
      const data = result.data as { cateTree?: Record<string, unknown> } | undefined;
      const all = flattenCategoryTree(data?.cateTree ?? {});
      const leaves = all.filter((node) => node.isLeaf);
      const categories = leaves.slice(0, MAX_CATEGORY_ROWS).map((node) => ({
        id: node.id,
        name: node.name,
        path: node.path,
        isLeaf: "是",
      }));
      const truncated = leaves.length > MAX_CATEGORY_ROWS
        ? `，仅展示前 ${MAX_CATEGORY_ROWS} 个`
        : "";
      return {
        content: `已读取 ${site} 站类目树：共 ${all.length} 个类目，其中末级类目 ${leaves.length} 个${truncated}。末级类目才是选品时可以填的 cid。`,
        artifact: recordsArtifact({
          headline: `TikTok 类目列表 · ${site}`,
          records: categories,
          columns: [
            { key: "id", label: "类目 ID" },
            { key: "name", label: "类目名称" },
            { key: "path", label: "类目路径" },
            { key: "isLeaf", label: "末级" },
          ],
          source: `采集上架服务 · get_category_tree_by_site(${site}) · ${now}`,
          emptyLabel: "未返回类目数据。",
        }),
      };
    }

    case "ai_match_category":
    case "supplement_info": {
      return await supplementInfoFlow(history, originalText, now);
    }

    case "claim_to_platform": {
      // 优先从对话历史的 artifact 表格中提取 detail_id
      let detailIds = extractDetailIdsFromHistory(history);
      // 如果历史中没有，再从当前消息文本中提取
      if (!detailIds.length) {
        const idMatches = originalText.match(/\d{4,}/g);
        detailIds = idMatches ? idMatches.map(Number).filter((n) => n > 0) : [];
      }
    
      // 推断目标平台，默认 tiktok
      let targetPlatform = "tiktok";
      if (/(shopee|虾皮)/i.test(originalText)) targetPlatform = "shopee";
      else if (/(lazada|来赞达)/i.test(originalText)) targetPlatform = "lazada";
      else if (/(amazon|亚马逊)/i.test(originalText)) targetPlatform = "amazon";
      else if (/(temu)/i.test(originalText)) targetPlatform = "temu";
      else if (/(ozon)/i.test(originalText)) targetPlatform = "ozon";
    
      if (!detailIds.length) {
        // 没有 ID，查公共采集箱
        try {
          const boxResult = await miaoshouGetCommonCollectBoxList(1, 20);
          const boxData = boxResult.data as Record<string, unknown> | undefined;
          // API 返回字段为 detailList（参考 Python collectbox_crud.py）
          const boxList = (boxData?.detailList as Array<Record<string, unknown>>) 
            ?? (boxData?.list as Array<Record<string, unknown>>) 
            ?? (Array.isArray(boxData) ? boxData : [])
            ?? [];
          if (boxList.length > 0) {
            // 只自动使用公共采集箱中最近 1 个商品（避免认领错误商品）
            const autoIds = boxList.slice(0, 1).map((item) => {
              // 公共采集箱主键为 commonCollectBoxDetailId（参考 Python）
              const id = item.commonCollectBoxDetailId ?? item.detail_id ?? item.detailId ?? item.item_id ?? item.itemId ?? item.id;
              return id ? Number(id) : 0;
            }).filter((n) => n > 0);
            if (autoIds.length > 0) {
              detailIds = autoIds;
            } else {
              return {
                content: `公共采集箱有 ${boxList.length} 个商品，但无法提取 ID。请提供 detail ID，例如：认领 12345 到 TikTok。`,
                artifact: recordsArtifact({
                  headline: "公共采集箱 — 请选择要认领的商品",
                  records: boxList,
                  columns: [
                    { key: "item_id", label: "商品 ID" },
                    { key: "title", label: "商品名称" },
                    { key: "source_platform", label: "货源平台" },
                    { key: "price", label: "价格" },
                  ],
                  source: `采集上架服务 · 等待认领指令 · ${now}`,
                  emptyLabel: "公共采集箱为空，请先采集 1688 链接。",
                }),
              };
            }
          }
        } catch (err) {
          console.error("[claim] 查询公共采集箱失败:", err);
        }
      }
    
      if (!detailIds.length) {
        return {
          content: "认领需要提供公共采集箱中的商品 detail ID。请先采集 1688 链接，然后告诉我要认领哪些商品。",
          artifact: recordsArtifact({
            headline: "认领商品到平台采集箱",
            records: [],
            columns: [{ key: "info", label: "说明" }],
            source: "采集上架服务",
            emptyLabel: "请提供要认领的商品 detail ID，例如：认领 12345 到 TikTok。",
          }),
        };
      }
    
      // 尝试认领
      async function tryClaim(ids: number[]): Promise<{ success: boolean; records: Array<Record<string, string>>; isCollectionError: boolean; rawError?: string }> {
        try {
          const claimResult = await miaoshouClaimToPlatform(ids, targetPlatform);
          const claimData = claimResult.data as Record<string, unknown> | undefined;
          const platformMap = (claimData?.platformCollectBoxDetailIdMap ?? {}) as Record<string, Record<string, unknown>>;
          // 大小写不敏感匹配 platform key（API 可能返回 "tiktok"/"TikTok"/"TK"）
          const platformData = Object.entries(platformMap).find(
            ([key]) => key.toLowerCase().includes(targetPlatform.toLowerCase()),
          )?.[1] ?? {};
    
          const records = ids.map((id) => ({
            detail_id: String(id),
            platform: targetPlatform,
            platform_detail_id: platformData[String(id)] ? String(platformData[String(id)]) : "未映射",
            status: platformData[String(id)] ? "认领成功" : "认领失败",
          }));
          return { success: true, records, isCollectionError: false };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : "未知错误";
          const isCollectionError = errMsg.includes("未采集成功") || errMsg.includes("不存在");
          return { success: false, records: [], isCollectionError, rawError: errMsg };
        }
      }
    
      let claimResult = await tryClaim(detailIds);
    
      // 如果是因为采集未完成导致失败，去公共采集箱找真实的 detail ID 再重试
      if (!claimResult.success && claimResult.isCollectionError) {
        // 轮询公共采集箱，找到已入库的商品的真实 detail_id
        const sourceIds = detailIds.map(String);
        const collected = await miaoshouWaitForCollection(sourceIds, 45000, 3000);
        const realDetailIds = collected
          .filter((r) => r.detailId)
          .map((r) => Number(r.detailId));
    
        if (realDetailIds.length > 0) {
          // 用公共采集箱中的真实 detail_id 重新认领
          claimResult = await tryClaim(realDetailIds);
          // 更新记录中的 detail_id 为真实值
          if (claimResult.success) {
            for (const record of claimResult.records) {
              const matched = collected.find((c) => String(Number(record.detail_id)) === c.detailId || record.detail_id === c.detailId);
              if (matched) record.detail_id = matched.detailId;
            }
          }
        }
      }
    
      if (claimResult.success) {
        const successCount = claimResult.records.filter((r) => r.status === "认领成功").length;
        return {
          content: `已将 ${detailIds.length} 个商品认领到 ${targetPlatform} 采集箱，成功 ${successCount} 个。`,
          artifact: recordsArtifact({
            headline: `认领结果 → ${targetPlatform}`,
            records: claimResult.records,
            columns: [
              { key: "detail_id", label: "公共采集箱 ID" },
              { key: "platform_detail_id", label: "平台采集箱 ID" },
              { key: "platform", label: "目标平台" },
              { key: "status", label: "状态" },
            ],
            source: `采集上架服务 · claimed · ${now}`,
            emptyLabel: "认领请求已提交，但未返回映射结果。",
          }),
        };
      } else {
        const friendlyMsg = claimResult.isCollectionError
          ? `商品尚未采集完成，无法认领。请稍等几分钟后再试，或先查看公共采集箱确认商品状态。`
          : claimResult.rawError ?? "认领失败，请检查商品 ID 是否正确。";
        return {
          content: `认领失败：${friendlyMsg}`,
          artifact: recordsArtifact({
            headline: "认领失败",
            records: [{ error: friendlyMsg, detail_ids: detailIds.join(",") }],
            columns: [
              { key: "detail_ids", label: "商品 ID" },
              { key: "error", label: "错误信息" },
            ],
            source: `采集上架服务 · claimed · ${now}`,
          }),
        };
      }
    }

    case "miaoshou_shops": {
      // site="all" 遍历所有 TikTok 站点（API 不接受空字符串）
      const result = await miaoshouGetShopList("tiktok", "all");
      const data = result.data as { shopList?: Array<Record<string, unknown>> } | undefined;
      const list = data?.shopList ?? [];
      if (!list.length) {
        return {
          content: "采集上架账号下还没有授权任何 TikTok 店铺，所以采集、认领、发布这些操作暂时都做不了。请先到采集上架后台完成店铺授权，再回来查询。",
          artifact: recordsArtifact({
            headline: "采集上架授权店铺",
            records: [],
            columns: [{ key: "info", label: "说明" }],
            source: `采集上架服务 · get_shop_list · ${now}`,
            emptyLabel: "采集上架尚未授权任何店铺。",
          }),
        };
      }
      const names = list
        .map((shop) => {
          const name = String(shop.platformShopName ?? shop.shopName ?? shop.shopNick ?? "").trim();
          const site = String(shop.siteName ?? shop.site ?? "").trim();
          return name ? `${name}（${site || "站点未知"}）` : "";
        })
        .filter(Boolean);
      const abnormal = list.filter((shop) => String(shop.status ?? "normal").toLowerCase() !== "normal");
      const statusNote = abnormal.length
        ? `其中 ${abnormal.length} 个店铺状态异常（${abnormal.map((s) => String(s.status ?? "")).join("、")}），需要去采集上架后台确认授权。`
        : "授权状态全部正常。";
      const detail = list
        .map((shop) => {
          const id = String(shop.shopId ?? "");
          const status = String(shop.status ?? "normal");
          const expire = String(shop.gmtExpire ?? "");
          return `店铺编号 ${id}，状态 ${status}${expire ? `，采集上架侧授权到期 ${expire}` : ""}`;
        })
        .join("；");
      return {
        content: `采集上架账号下已授权 ${list.length} 个 TikTok 店铺：${names.join("、")}。${detail}。${statusNote}采集、认领、发布都会落到这个店铺。`,
        artifact: recordsArtifact({
          headline: "采集上架授权店铺",
          records: list,
          columns: [
            { key: "shopId", label: "店铺 ID" },
            { key: "platformShopName", label: "店铺" },
            { key: "siteName", label: "站点" },
            { key: "platform", label: "平台" },
            { key: "status", label: "状态" },
            { key: "gmtExpire", label: "过期时间" },
          ],
          source: `采集上架服务 · get_shop_list · ${now}`,
          emptyLabel: "采集上架尚未授权任何店铺。",
        }),
      };
    }

    case "publish_to_tiktok": {
      // 从历史中提取 TK 采集箱 detail IDs（发布需要 TK 采集箱 ID，不能用公共采集箱 ID）
      let detailIds = extractTiktokDetailIdsFromHistory(history);
      // 从文本中提取 shop IDs（如 "发布到店铺 12345"）
      const shopIdMatches = originalText.match(/(?:店铺|shop)[^\d]*(\d{4,})/gi) ?? [];
      let shopIds = shopIdMatches.map((m) => Number(m.match(/\d+/)?.[0])).filter((n) => n > 0);
      // 如果文本中没有 shop ID，从历史 artifact 中提取
      if (!shopIds.length) {
        shopIds = extractShopIdsFromHistory(history);
      }
      // 如果历史中没有 detail IDs，从文本中提取（如 "发布商品 12345"）
      if (!detailIds.length) {
        const detailIdMatches = originalText.match(/(?:商品|detail|采集箱|发布)[^\d]*(\d{6,12})/gi) ?? [];
        detailIds = detailIdMatches.map((m) => Number(m.match(/\d+/)?.[0])).filter((n) => n > 100000);
      }

      if (!detailIds.length || !shopIds.length) {
        // 缺少参数，先查 TikTok 采集箱和店铺列表（分开查询，互不影响）
        let boxList: Array<Record<string, unknown>> = [];
        let shopList: Array<Record<string, unknown>> = [];
        let boxError = "";
        let shopError = "";

        const [boxSettled, shopSettled] = await Promise.allSettled([
          miaoshouGetTikTokCollectBoxList(1, 20),
          miaoshouGetShopList("tiktok", "all"),
        ]);

        if (boxSettled.status === "fulfilled") {
          const boxData = boxSettled.value.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
          boxList = boxData?.detailList ?? boxData?.list ?? [];
        } else {
          boxError = boxSettled.reason instanceof Error ? boxSettled.reason.message : "采集箱查询失败";
          console.error("[publish] TK采集箱查询失败:", boxError);
        }

        if (shopSettled.status === "fulfilled") {
          const shopData = shopSettled.value.data as { shopList?: Array<Record<string, unknown>> } | undefined;
          shopList = shopData?.shopList ?? [];
        } else {
          shopError = shopSettled.reason instanceof Error ? shopSettled.reason.message : "店铺查询失败";
          console.error("[publish] 店铺查询失败:", shopError);
        }

        // 如果两个都失败了，才返回错误
        if (boxError && shopError) {
          return {
            content: `查询采集箱和店铺均失败。采集箱：${boxError}；店铺：${shopError}。请提供商品 detail ID 和店铺 ID，例如：发布商品 12345 到店铺 67890。`,
            artifact: recordsArtifact({
              headline: "发布到 TikTok",
              records: [{ collectBox_error: boxError, shop_error: shopError }],
              columns: [{ key: "collectBox_error", label: "采集箱错误" }, { key: "shop_error", label: "店铺错误" }],
              source: "采集上架服务",
              emptyLabel: "请提供商品 detail ID 和店铺 ID。",
            }),
          };
        }

        // 自动填充：如果只有一个店铺，自动使用它
        if (!shopIds.length && shopList.length === 1) {
          const autoShopId = Number(shopList[0].shopId);
          if (!Number.isNaN(autoShopId) && autoShopId > 0) {
            shopIds = [autoShopId];
          }
        }

        // 自动填充：如果有 detailIds 且 shopIds 现在也有了，直接走发布流程
        if (detailIds.length && shopIds.length) {
          // 不 return，继续往下走进入认领+发布流程
        } else {
          const errorMsg = boxError ? `采集箱查询异常：${boxError}` : shopError ? `店铺查询异常：${shopError}` : "";
          return {
            content: errorMsg
              ? `以下是当前 TikTok 采集箱和已授权店铺（${errorMsg}）。`
              : `发布到 TikTok 需要指定采集箱中的商品和目标店铺。以下是当前 TikTok 采集箱和已授权店铺：`,
            artifact: recordsArtifact({
              headline: "TikTok 采集箱 & 已授权店铺",
              records: [
                ...boxList.map((item) => ({
                  type: "商品",
                  id: item.collectBoxDetailId ?? item.item_id ?? "--",
                  name: item.title ?? "--",
                  status: item.status ?? "--",
                })),
                ...shopList.map((shop) => ({
                  type: "店铺",
                  id: shop.shopId ?? "--",
                  name: shop.shopNick ?? shop.shopName ?? "--",
                  status: shop.site ?? "--",
                })),
              ],
              columns: [
                { key: "type", label: "类型" },
                { key: "id", label: "ID" },
                { key: "name", label: "名称" },
                { key: "status", label: "状态/站点" },
              ],
              source: `采集上架服务 · ${now}`,
              emptyLabel: boxList.length === 0 && shopList.length === 0
                ? "采集箱和店铺列表均为空。请先采集商品并授权店铺。"
                : boxList.length === 0
                  ? "采集箱为空，请先采集商品。"
                  : "暂无已授权店铺。",
            }),
          };
        }
      }

      // 先认领到店铺，再发布
      try {
        const claimResult = await miaoshouClaimToShop(detailIds, shopIds);
        const claimData = claimResult.data as Record<string, unknown> | undefined;
        const claimSuccess = (claimData?.result ?? claimResult.result) === "success";

        if (!claimSuccess) {
          const errMsg = (claimData?.message as string) ?? "认领失败";
          return {
            content: `认领到店铺失败：${errMsg}。请检查商品是否已在 TikTok 采集箱中，以及店铺 ID 是否正确。`,
            artifact: recordsArtifact({
              headline: "认领到店铺失败",
              records: detailIds.map((id) => ({ detail_id: String(id), status: "认领失败" })),
              columns: [{ key: "detail_id", label: "商品 ID" }, { key: "status", label: "状态" }],
              source: `采集上架服务 · ${now}`,
              emptyLabel: "认领失败。",
            }),
          };
        }

        // 认领成功，执行发布
        const publishResult = await miaoshouPublishToTikTok(detailIds, shopIds);
        const publishData = publishResult.data as Record<string, unknown> | undefined;
        const publishSuccess = (publishData?.result ?? publishResult.result) === "success";

        return {
          content: publishSuccess
            ? `已将 ${detailIds.length} 个商品发布到 ${shopIds.length} 个 TikTok 店铺。`
            : `认领成功但发布失败：${(publishData?.message as string) ?? "未知错误"}。`,
          artifact: recordsArtifact({
            headline: publishSuccess ? "发布结果 → TikTok" : "发布失败",
            records: detailIds.map((id) => ({
              detail_id: String(id),
              shop_ids: shopIds.join(", "),
              status: publishSuccess ? "发布成功" : "发布失败",
            })),
            columns: [
              { key: "detail_id", label: "商品 ID" },
              { key: "shop_ids", label: "店铺 ID" },
              { key: "status", label: "状态" },
            ],
            source: `采集上架服务 · publish · ${now}`,
            emptyLabel: "发布请求已提交。",
          }),
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "未知错误";
        const hint = msg.includes("未选择类目")
          ? "该商品尚未匹配类目，请先执行「补充信息 / AI 匹配类目」后再发布。"
          : "请检查商品和店铺 ID 是否正确。";
        return {
          content: `发布失败：${msg}。${hint}`,
          artifact: recordsArtifact({
            headline: "发布失败",
            records: [],
            columns: [{ key: "info", label: "说明" }],
            source: "采集上架服务",
            emptyLabel: `错误：${msg}`,
          }),
        };
      }
    }

    case "publish_records": {
      let list: Array<Record<string, unknown>> = [];
      let total = 0;
      try {
        const result = await miaoshouGetPublishRecords();
        const data = result.data as { moveCollectDetailList?: Array<Record<string, unknown>>; total?: number } | undefined;
        list = data?.moveCollectDetailList ?? [];
        total = data?.total ?? list.length;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (msg.includes("无权限")) {
          return {
            content: "发布记录功能需要在采集上架服务后台申请对应接口权限。请在采集上架服务 → 开放平台 → 应用管理中勾选「采集箱搬品记录」接口权限。",
            artifact: recordsArtifact({
              headline: "TikTok 发布记录",
              records: [],
              columns: [{ key: "info", label: "说明" }],
              source: "采集上架服务",
              emptyLabel: "接口权限未开通。",
            }),
          };
        }
        throw error;
      }
      return {
        content: `已读取发布记录，共 ${total} 条。`,
        artifact: recordsArtifact({
          headline: "TikTok 发布记录",
          records: list,
          columns: [
            { key: "task_id", label: "任务 ID" },
            { key: "item_title", label: "商品" },
            { key: "shop_name", label: "店铺" },
            { key: "status", label: "状态" },
            { key: "create_time", label: "创建时间" },
          ],
          source: `采集上架服务 · search_move_collect_list · ${now}`,
          emptyLabel: "暂无发布记录。",
        }),
      };
    }

    case "price_templates": {
      let list: Array<Record<string, unknown>> = [];
      try {
        const result = await miaoshouGetPriceTemplates();
        const data = result.data as { priceTemplateList?: Array<Record<string, unknown>> } | undefined;
        list = data?.priceTemplateList ?? [];
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (msg.includes("无权限")) {
          return {
            content: "定价模板功能需要在采集上架服务后台申请对应接口权限。请在采集上架服务 → 开放平台 → 应用管理中勾选「定价模板」接口权限。",
            artifact: recordsArtifact({
              headline: "TikTok 定价模板",
              records: [],
              columns: [{ key: "info", label: "说明" }],
              source: "采集上架服务",
              emptyLabel: "接口权限未开通。",
            }),
          };
        }
        throw error;
      }
      return {
        content: `已读取定价模板，共 ${list.length} 个。`,
        artifact: recordsArtifact({
          headline: "TikTok 定价模板",
          records: list,
          columns: [
            { key: "template_id", label: "模板 ID" },
            { key: "template_name", label: "模板名称" },
            { key: "site", label: "站点" },
            { key: "is_default", label: "默认" },
          ],
          source: `采集上架服务 · get_price_template_list · ${now}`,
          emptyLabel: "暂无定价模板。",
        }),
      };
    }

    case "miaoshou_packages": {
      const result = await miaoshouGetPackageList();
      const data = result.data as { orderPackageList?: Array<Record<string, unknown>>; total?: number } | undefined;
      const list = data?.orderPackageList ?? [];
      return {
        content: `已读取采集上架包裹列表，共 ${data?.total ?? list.length} 个。`,
        artifact: recordsArtifact({
          headline: "采集上架包裹",
          records: list,
          columns: [
            { key: "package_id", label: "包裹 ID" },
            { key: "order_id", label: "订单 ID" },
            { key: "tracking_no", label: "物流单号" },
            { key: "status", label: "状态" },
            { key: "create_time", label: "创建时间" },
          ],
          source: `采集上架服务 · search_package_list · ${now}`,
          emptyLabel: "暂无包裹。",
        }),
      };
    }

    case "miaoshou_returns": {
      let list: Array<Record<string, unknown>> = [];
      let total = 0;
      try {
        const result = await miaoshouGetReturnList();
        const data = result.data as { returnList?: Array<Record<string, unknown>>; total?: number } | undefined;
        list = data?.returnList ?? [];
        total = data?.total ?? list.length;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (msg.includes("无权限")) {
          return {
            content: "退货退款功能需要在采集上架服务后台申请对应接口权限。请在采集上架服务 → 开放平台 → 应用管理中勾选「售后退货」接口权限。",
            artifact: recordsArtifact({
              headline: "采集上架退货退款",
              records: [],
              columns: [{ key: "info", label: "说明" }],
              source: "采集上架服务",
              emptyLabel: "接口权限未开通。",
            }),
          };
        }
        throw error;
      }
      return {
        content: `已读取采集上架退货退款列表，共 ${total} 条。`,
        artifact: recordsArtifact({
          headline: "采集上架退货退款",
          records: list,
          columns: [
            { key: "return_id", label: "退货 ID" },
            { key: "order_id", label: "订单 ID" },
            { key: "reason", label: "原因" },
            { key: "status", label: "状态" },
            { key: "create_time", label: "创建时间" },
          ],
          source: `采集上架服务 · order_return_list · ${now}`,
          emptyLabel: "暂无退货退款记录。",
        }),
      };
    }

    case "miaoshou_purchase_orders": {
      const result = await miaoshouGetPurchaseOrderList();
      const data = result.data as { goodsPurchaseOrderList?: Array<Record<string, unknown>>; total?: number } | undefined;
      const list = data?.goodsPurchaseOrderList ?? [];
      return {
        content: `已读取采集上架采购单列表，共 ${data?.total ?? list.length} 条。`,
        artifact: recordsArtifact({
          headline: "采集上架采购单",
          records: list,
          columns: [
            { key: "order_id", label: "采购单 ID" },
            { key: "supplier_name", label: "供应商" },
            { key: "total_amount", label: "总金额" },
            { key: "status", label: "状态" },
            { key: "create_time", label: "创建时间" },
          ],
          source: `采集上架服务 · search_goods_purchase_order_page · ${now}`,
          emptyLabel: "暂无采购单。",
        }),
      };
    }

    case "miaoshou_inventory": {
      const result = await miaoshouGetInventoryList();
      const data = result.data as { goodsSkuWarehouseList?: Array<Record<string, unknown>>; total?: number } | undefined;
      const list = data?.goodsSkuWarehouseList ?? [];
      return {
        content: `已读取采集上架库存列表，共 ${data?.total ?? list.length} 条。`,
        artifact: recordsArtifact({
          headline: "采集上架库存",
          records: list,
          columns: [
            { key: "sku", label: "SKU" },
            { key: "goods_name", label: "商品名称" },
            { key: "warehouse_name", label: "仓库" },
            { key: "stock", label: "库存" },
            { key: "safe_stock", label: "安全库存" },
          ],
          source: `采集上架服务 · search_goods_sku_warehouse_page · ${now}`,
          emptyLabel: "暂无库存数据。",
        }),
      };
    }
  }
}

/** 采集上架场景查询后的建议 follow-ups */
export function miaoshouSceneFollowUps(query: MiaoshouSceneQuery): string[] {
  const followUps: Record<MiaoshouSceneQuery, string[]> = {
    collect_item: ["查看公共采集箱", "认领到 TikTok 采集箱", "查看 TikTok 采集箱"],
    claim_to_platform: ["查看 TikTok 采集箱", "发布到 TikTok 店铺", "查看发布记录"],
    common_collect_box: ["认领到 TikTok 采集箱", "采集新的 1688 链接", "查看 TikTok 采集箱"],
    tiktok_collect_box: ["查看公共采集箱", "发布到 TikTok 店铺", "查看定价模板"],
    tiktok_categories: ["查看 TikTok 采集箱", "AI 匹配类目", "查看定价模板"],
    ai_match_category: ["查看 TikTok 采集箱", "查看类目列表", "发布到 TikTok 店铺"],
    supplement_info: ["发布到 TikTok 店铺", "查看 TikTok 采集箱", "查看类目列表"],
    miaoshou_shops: ["查看 TikTok 采集箱", "查看发布记录", "查看定价模板"],
    publish_to_tiktok: ["查看发布记录", "查看 TikTok 采集箱", "查看已授权店铺"],
    publish_records: ["查看 TikTok 采集箱", "查看定价模板", "查看最近 7 天订单"],
    price_templates: ["查看 TikTok 采集箱", "查看已授权店铺", "查看全部商品和 SKU"],
    miaoshou_packages: ["查看采购单列表", "查看最近 7 天包裹", "查看退货退款"],
    miaoshou_returns: ["查看包裹列表", "查看最近 7 天退货退款", "查看采购单"],
    miaoshou_purchase_orders: ["查看库存列表", "查看供应商", "查看包裹列表"],
    miaoshou_inventory: ["查看采购单", "查看包裹列表", "查看全部商品和 SKU"],
  };
  return followUps[query] ?? [];
}


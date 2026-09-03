import type { MessageArtifact } from "../shared/contracts.ts";
import { getAuthorizedTikTokClient, readStoredAuthorization } from "./tiktok-auth.ts";

export type TikTokSceneQuery =
  | "market_products"
  | "market_creators"
  | "market_videos"
  | "market_lives"
  | "shop_products"
  | "shop_videos"
  | "shop_lives"
  | "product_diagnoses"
  | "global_products"
  | "global_categories"
  | "seller_permissions"
  | "authorized_shops"
  | "shop_groups"
  | "orders"
  | "pending_orders"
  | "order_detail"
  | "order_price"
  | "promotions_overview"
  | "promotions"
  | "coupons"
  | "packages"
  | "combinable_packages"
  | "warehouses"
  | "shipping_templates"
  | "order_tracking"
  | "tracking_validation"
  | "aftersales_requests"
  | "return_records"
  | "aftersale_eligibility"
  | "finance_statements"
  | "finance_withdrawals"
  | "finance_unsettled"
  | "finance_payments"
  | "finance_order_transactions";

interface ColumnSpec {
  key: string;
  label: string;
  candidates?: string[];
}

export interface TikTokSceneQueryResult {
  content: string;
  artifact: Extract<MessageArtifact, { kind: "records" }>;
}

interface ApiEnvelope {
  data?: Record<string, unknown>;
}

const REGION_TIMEZONES: Record<string, string> = {
  TH: "Asia/Bangkok",
  US: "America/Los_Angeles",
  GB: "Europe/London",
  SG: "Asia/Singapore",
  MY: "Asia/Kuala_Lumpur",
  PH: "Asia/Manila",
  VN: "Asia/Ho_Chi_Minh",
  ID: "Asia/Jakarta",
  JP: "Asia/Tokyo",
};

export function inferTikTokSceneQuery(text: string): TikTokSceneQuery | undefined {
  const normalized = text.toLowerCase();
  const marketContext = /(市场|大盘|全站|什么.*好卖|哪些.*好卖|好卖.*(?:商品|东西)|选品|热销榜|热卖榜|热门带货|bestseller)/i.test(text)
    && !/(本店|店内|我的商品|我的店铺|店铺里|店铺内|当前店铺)/i.test(text);
  if (marketContext && /(达人|创作者|creator)/i.test(text)) return "market_creators";
  if (marketContext && /(视频|短视频|video)/i.test(text)) return "market_videos";
  if (marketContext && /(直播|live)/i.test(text)) return "market_lives";
  if (marketContext || /最近.*好卖/i.test(text)) return "market_products";

  if (/(店铺|本店|我的).*(商品).*(表现|排行|分析|好卖|热销|卖得好)/i.test(text) || /商品表现排行/i.test(text)) return "shop_products";
  if (/(店铺|本店|我的).*(视频).*(表现|排行|分析)/i.test(text) || /短视频表现/i.test(text)) return "shop_videos";
  if (/(店铺|本店|我的).*(直播).*(表现|排行|分析)/i.test(text) || /店播表现/i.test(text)) return "shop_lives";
  if (/(商品|listing).*(诊断|质量检查|优化建议)|诊断在售商品/i.test(text)) return "product_diagnoses";

  if (/(卖家权限|跨境权限|全球商品资格|是否支持全球商品|图片翻译.*(?:条件|资格)|seller permission)/i.test(text)) return "seller_permissions";
  if (/(全球类目|全球商品类目|global categor)/i.test(text) && /(查看|查询|列表|有哪些)/i.test(text)) return "global_categories";
  if (/(全球商品|跨境商品|global product)/i.test(text) && /(查看|查询|多少|全部|列表|搜索)/i.test(text)) return "global_products";
  if (/(授权店铺|店铺列表|authorized shop)/i.test(text)) return "authorized_shops";
  if (/(店铺组|shop group)/i.test(text)) return "shop_groups";

  if (/(订单).*(财务流水|交易明细|结算明细)|finance.*order|order.*transaction/i.test(normalized)) return "finance_order_transactions";
  if (/(未结算|待结算)/i.test(text)) return "finance_unsettled";
  if (/(物流轨迹|物流跟踪|订单物流|tracking)/i.test(text) && /(订单|order)/i.test(text)) return "order_tracking";
  if (/(售后资格|可否退货|可否退款|aftersale eligibility)/i.test(text)) return "aftersale_eligibility";
  if (/(订单).*(价格明细|价格构成|price detail)/i.test(text)) return "order_price";
  if (/(按订单号|完整订单|订单详情|order detail)/i.test(text)) return "order_detail";
  if (/(待发货订单|待处理订单|awaiting shipment)/i.test(text)) return "pending_orders";
  if (/(订单|order)/i.test(text) && /(查看|查询|列表|最近|近\s*\d+\s*天)/i.test(text)) return "orders";

  if (/(促销|活动|promotion)/i.test(text) && /(优惠券|coupon)/i.test(text)) return "promotions_overview";
  if (/(优惠券|coupon)/i.test(text) && /(查看|查询|列表|当前|有哪些)/i.test(text)) return "coupons";
  if (/(促销|活动|promotion)/i.test(text) && /(查看|查询|列表|当前|进行中|有哪些)/i.test(text)) return "promotions";
  if (/(可合并).*(包裹)|combinable package/i.test(text)) return "combinable_packages";
  if (/(包裹|package)/i.test(text) && /(查看|查询|待处理|列表|多少)/i.test(text)) return "packages";
  if (/(仓库|warehouse)/i.test(text) && /(查看|查询|列表|有哪些)/i.test(text)) return "warehouses";
  if (/(物流模板|配送模板|shipping template)/i.test(text)) return "shipping_templates";
  if (/(物流轨迹|物流跟踪|订单物流|tracking)/i.test(text) && /(订单|order)/i.test(text)) return "order_tracking";
  if (/(物流单号|运单号|tracking number)/i.test(text) && /(有效|校验|验证|是否)/i.test(text)) return "tracking_validation";

  if (/(退货记录|售后记录|return records?)/i.test(text)) return "return_records";
  if (/(售后资格|可否退货|可否退款|aftersale eligibility)/i.test(text)) return "aftersale_eligibility";
  if (/(待处理售后|售后请求|aftersales? request)/i.test(text)) return "aftersales_requests";

  if (/(提现|withdraw)/i.test(text)) return "finance_withdrawals";
  if (/(付款记录|支付记录|payments?)/i.test(normalized)) return "finance_payments";
  if (/(结算单|账单|statement)/i.test(text)) return "finance_statements";
  return undefined;
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dateInTimezone(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function timeRange(days: number, region?: string) {
  const timezone = REGION_TIMEZONES[region ?? ""] ?? "UTC";
  const today = dateInTimezone(Date.now(), timezone);
  const date = shiftDate(today, -1);
  const normalizedDays = days <= 1 ? 1 : days <= 7 ? 7 : 30;
  return {
    date,
    startDate: shiftDate(date, -(normalizedDays - 1)),
    endDateExclusive: shiftDate(date, 1),
    startTimestamp: Math.floor(new Date(`${shiftDate(date, -(normalizedDays - 1))}T00:00:00Z`).getTime() / 1000),
    endTimestamp: Math.floor(new Date(`${shiftDate(date, 1)}T00:00:00Z`).getTime() / 1000),
    days: normalizedDays,
    timeSlot: normalizedDays === 1 ? "1D" : normalizedDays === 7 ? "7D" : "30D",
  };
}

function dataObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const data = (payload as ApiEnvelope).data;
  return data && typeof data === "object" ? data : {};
}

function extractRecords(data: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return { value: item };
    return item && typeof item === "object" ? item as Record<string, unknown> : { value: "" };
  });
}

function compactJson(value: unknown): string {
  const raw = JSON.stringify(value);
  if (!raw) return "--";
  return raw.length > 90 ? `${raw.slice(0, 87)}...` : raw;
}

function formatValue(value: unknown, key: string): string {
  if (value === undefined || value === null || value === "") return "--";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (/(?:^|_)(?:time|date)$/.test(key) && value > 1_000_000_000) {
      const milliseconds = value > 10_000_000_000 ? value : value * 1000;
      return new Date(milliseconds).toLocaleString("zh-CN", { hour12: false });
    }
    return value.toLocaleString("zh-CN");
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (!value.length) return "0";
    if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) return value.join("、");
    return `${value.length} 项`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.amount !== undefined) return `${formatValue(object.amount, "amount")}${object.currency ? ` ${object.currency}` : ""}`;
    if (object.name !== undefined) return formatValue(object.name, "name");
    if (object.title !== undefined) return formatValue(object.title, "title");
    return compactJson(value);
  }
  return String(value);
}

function rowsFor(records: Array<Record<string, unknown>>, columns: ColumnSpec[]): Array<Record<string, string>> {
  return records.slice(0, 100).map((record) => Object.fromEntries(columns.map((column) => {
    const candidates = column.candidates ?? [column.key];
    const sourceKey = candidates.find((candidate) => record[candidate] !== undefined) ?? column.key;
    return [column.key, formatValue(record[sourceKey], sourceKey)];
  })));
}

function recordsArtifact(input: {
  headline: string;
  data: Record<string, unknown>;
  recordKey: string;
  columns: ColumnSpec[];
  path: string;
  summary?: string;
  emptyLabel?: string;
}): Extract<MessageArtifact, { kind: "records" }> {
  const records = extractRecords(input.data, input.recordKey);
  const total = typeof input.data.total_count === "number" ? input.data.total_count : records.length;
  const pageNote = total > records.length ? `API 共返回 ${total.toLocaleString("zh-CN")} 条，本页显示前 ${Math.min(records.length, 100)} 条。` : `本次返回 ${records.length.toLocaleString("zh-CN")} 条。`;
  return {
    kind: "records",
    headline: input.headline,
    summary: input.summary ? `${input.summary} ${pageNote}` : pageNote,
    columns: input.columns.map(({ key, label }) => ({ key, label })),
    rows: rowsFor(records, input.columns),
    source: `TikTok Shop Open API · ${input.path} · 读取于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    emptyLabel: input.emptyLabel,
  };
}

function selectedRegion(authorization: Awaited<ReturnType<typeof readStoredAuthorization>>): string | undefined {
  return authorization?.shops.find((shop) => shop.cipher === authorization.selectedShopCipher)?.region;
}

const REGION_LABELS: Record<string, string> = {
  TH: "泰国",
  US: "美国",
  GB: "英国",
  SG: "新加坡",
  MY: "马来西亚",
  PH: "菲律宾",
  VN: "越南",
  ID: "印尼",
  JP: "日本",
};

function entityId(text: string): string | undefined {
  return text.match(/\b\d{10,30}\b/)?.[0];
}

function trackingNumber(text: string): string | undefined {
  return text.match(/(?:物流单号|运单号|tracking(?: number)?)[：:\s#-]*([A-Z0-9-]{8,40})/i)?.[1];
}

function latestAvailableDate(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.match(/latest available date is (\d{4}-\d{2}-\d{2})/i)?.[1];
}

// ─── 数据驱动摘要生成器：基于真实榜单数据产出有价值的洞察，而非占位回答
// ──────────────────────────────────────────────────────────

function pickRecordField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
  }
  return undefined;
}

function parseGmvLower(rangeStr: unknown): number {
  if (typeof rangeStr !== "string") return 0;
  // 匹配 THB1234~THB5678 或 1234.56~5678.90 格式，取下限
  const nums = rangeStr.match(/(\d[\d,]*\.?\d*)/g);
  if (!nums?.length) return 0;
  return Number(nums[0].replace(/,/g, ""));
}

function humanCount(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// ─── 类目词库 & 用户意图提取器：解决"问家纺却得到香水/手机榜单"的数据错位 ──────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Array<{ label: string; match: RegExp; productKeywords: RegExp }> = [
  // 家纺布艺
  { label: "家纺布艺", match: /(家[纺织]|家纺|布艺|家纺布艺|床上用品|床品|床单|被套|被罩|枕套|枕头|抱枕|被子|被芯|四件套|床垫|床笠|凉席|毛毯|地毯|地垫|窗帘|沙发布|毛巾|浴巾|浴帘)/i,
    productKeywords: /(sheet|bedding|pillow|blanket|quilt|mattress|matt\b|bed\s*cover|cushion|curtain|carpet|rug|mat|towel|bath|家纺|床上|四件套|床笠|床垫|毛?毯|枕|被|凉席|地[垫毯]|窗帘|沙发布|毛巾|浴巾)/i },
  // 美妆护肤
  { label: "美妆护肤", match: /(美妆|护肤|化妆|精华|乳液|面霜|粉底|口红|唇釉|眉笔|眼影|腮红|香水|彩妆|面膜|防晒|卸妆|洁面|skincare|makeup|cosmetic|perfume)/i,
    productKeywords: /(serum|cream|lotion|essence|perfume|parfum|foundation|lipstick|lip|mascara|eyeshadow|sunscreen|sun\s*block|cleanser|mask|makeup|cosmetic|护肤|精华|面霜|乳液|面膜|防晒|口红|香水|粉底)/i },
  // 3C数码/手机
  { label: "3C数码", match: /(3c|数码|手机|平板|电脑|笔记本|耳机|音箱|充电器|移动电源|充电宝|摄像头|相机|游戏机|智能手表|手环|电子|smart\s*phone|laptop|tablet|earphone|headphone|power\s*bank)/i,
    productKeywords: /(iphone|android|phone|mobile|smartphone|laptop|notebook|tablet|ipad|mac\s*book|earphone|headphone|airpod|bluetooth|speaker|charger|power\s*bank|powerbank|camera|vivo|oppo|samsung|xiaomi|redmi|apple|watch|band|手机|平板|电脑|笔记本|耳机|充电|充电宝|相机|手表|智能)/i },
  // 服饰鞋包
  { label: "服饰鞋包", match: /(服装|服饰|衣服|男装|女装|童装|鞋|靴|包包|手袋|箱包皮具|内衣|袜子|帽子|围巾|皮带|fashion|clothing|shoes|bag|handbag|wallet|belt|hat|cap|dress|jacket|pants|t-shirt)/i,
    productKeywords: /(dress|shirt|t-shirt|tshirt|pants|jeans|jacket|coat|shoes|sneaker|boot|bag|handbag|backpack|wallet|purse|hat|cap|sock|underwear|bra|dress|服饰|衣服|服装|鞋|靴|包|帽|袜|内衣|皮带)/i },
  // 家居/家具
  { label: "家居家具", match: /(家居|家具|家装|建材|厨房|卫浴|收纳|餐具|椅子|桌子|沙发|衣柜|书柜|灯|灯具|家装|收纳|home\s*decor|furniture|kitchen|bathroom|storage|chair|table|sofa|shelf|lamp)/i,
    productKeywords: /(furniture|chair|table|sofa|desk|shelf|cabinet|lamp|light|kitchen|cookware|pot|pan|bowl|plate|cup|mug|glass|storage|box|organizer|家居|家具|椅子|桌子|沙发|收纳|厨房|餐具|灯|卫浴)/i },
  // 食品/生鲜/保健
  { label: "食品保健", match: /(食品|零食|饮料|生鲜|水果|蔬菜|保健品|维生素|蛋白粉|减肥|代餐|咖啡|茶|宠物食品|food|snack|beverage|health|vitamin|protein|coffee|tea|supplement|pet\s*food)/i,
    productKeywords: /(food|snack|candy|chocolate|cookie|biscuit|drink|beverage|coffee|tea|milk|juice|vitamin|protein|supplement|diet|slim|weight|pet\s*food|cat\s*food|dog\s*food|食品|零食|饮料|咖啡|茶|保健|维生素|蛋白|代餐|宠物)/i },
  // 母婴/玩具
  { label: "母婴玩具", match: /(母婴|婴儿|宝宝|孕妇|奶粉|纸尿裤|奶瓶|玩具|积木|娃娃|游戏|baby|mother|infant|diaper|milk\s*powder|toy|doll|block|puzzle)/i,
    productKeywords: /(baby|infant|newborn|toddler|diaper|milk\s*powder|bottle|toy|doll|block|puzzle|lego|game|母婴|婴儿|宝宝|奶粉|纸尿裤|奶瓶|玩具|积木|娃娃)/i },
  // 运动/户外
  { label: "运动户外", match: /(运动|健身|户外|跑步|瑜伽|自行车|登山|露营|钓鱼|球|球拍|gym|fitness|sport|outdoor|running|yoga|bicycle|bike|camping|fishing|ball|racket)/i,
    productKeywords: /(sport|fitness|gym|yoga|running|outdoor|camping|tent|backpack|hiking|bicycle|bike|fishing|ball|football|basketball|tennis|racket|运动|健身|户外|瑜伽|露营|登山|钓鱼|球|球拍|跑步|自行车)/i },
];

function extractCategoryIntent(text: string): { label: string; productRe: RegExp } | undefined {
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.match.test(text)) return { label: entry.label, productRe: entry.productKeywords };
  }
  // 兜底：从"X类目 / X品类 / X行业 / X赛道"里直接抓前面的名词
  const bare = text.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9\-+]{1,12})(?:类目|品类|行业|赛道|类别|这个类|这个类?目)/);
  if (bare) {
    const kw = bare[1];
    const reSource = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { label: kw, productRe: new RegExp(reSource, "i") };
  }
  return undefined;
}

function summarizeMarketProducts(records: Array<Record<string, unknown>>, days: number, regionLabel: string, categoryHint?: ReturnType<typeof extractCategoryIntent>): string {
  if (!records.length) return `近 ${days} 天${regionLabel}市场暂无热销榜，建议先看店铺自有数据再对比大盘。`;

  // ─── 核心修复 1：先做类目相关性校验，绝不把"香水/手机"硬说成"家纺布艺" ──────────────────────────
  const categoryLabel = categoryHint?.label;
  let matchedRecords = records;
  let matchDisclaimer = "";
  if (categoryLabel && categoryHint) {
    const scored = records.map((r) => {
      const haystack = [
        pickRecordField(r, ["name", "product_name", "title"]),
        pickRecordField(r, ["category_name", "category", "leaf_category_name", "first_category_name", "second_category_name"]),
        pickRecordField(r, ["shop_name", "shop"]),
      ].map((v) => (v == null ? "" : String(v))).join(" \u0001 ");
      return { r, hit: categoryHint.productRe.test(haystack) };
    });
    const hits = scored.filter((s) => s.hit).map((s) => s.r);
    const ratio = hits.length / records.length;
    // 命中占比 ≥ 25% 才认为该榜单里真的有用户要的类目；否则明确声明"当前是全品类榜，XX类只有X条，结论只针对这X条"
    if (ratio >= 0.25) {
      matchedRecords = hits;
      matchDisclaimer = `（榜单内${categoryLabel}相关商品占 ${(ratio * 100).toFixed(0)}%，以下分析针对这 ${hits.length} 条${categoryLabel}样本）`;
    } else {
      // 覆盖率太低——不拿这些无关数据乱分析，直接说明并给出两条清晰的建议
      const tips = hits.length > 0
        ? `在 ${records.length} 条全品类热销里只筛到 ${hits.length} 条疑似${categoryLabel}商品，样本不足无法判断竞争格局。建议两步推进：① 先用"类目树+类目ID"精筛${categoryLabel}赛道，而不是看全品类总榜；② 如果官方没有类目维度的热销榜，就用类目关键词在商品搜索接口里检索，按 GMV/销量排序后再对比。`
        : `当前 Bestsellers 接口返回的是${regionLabel}全品类热销总榜，TOP10 全部是美妆/3C/服饰，完全没有${categoryLabel}相关样本。说明${categoryLabel}这个赛道本身不是大盘爆款，建议先确认${regionLabel}站点是否开放该类目、以及该类目下是否有 GMV 较高的头部商品，再决定是否切入。`;
      const exampleTop3 = records.slice(0, 3).map((r, i) => {
        const nameRaw = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "—");
        const name = nameRaw.length > 22 ? nameRaw.slice(0, 20) + "…" : nameRaw;
        return `第${i + 1}·${name}`;
      }).join("；");
      return `说明一下：您指定的是「${categoryLabel}」，但官方 Bestsellers 接口默认返回的是${regionLabel}全品类热销总榜${categoryLabel ? `，而当前站点类目筛选未生效，TOP100 条里${categoryLabel}命中不足${Math.round(ratio * 100)}%` : ""}。为避免误导，我不会拿香水/手机这些无关商品强行分析「${categoryLabel}」的竞争格局。${tips} 当前全品类 TOP3 供你感受大盘热度：${exampleTop3}。`;
    }
  }

  const top = matchedRecords.slice(0, 10);
  // ─── 核心修复 2：关键词提取——对泰文/小语种不强行用中英文正则拆，改为"字符串 n-gram + 重复度"──────────────────────────
  const keywords = new Map<string, number>();
  for (const r of top) {
    const name = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "");
    // 2a) 先抓有空格分隔的词（英语/泰文拼音/品牌词），长度≥2
    const spaceTokens = name.match(/[A-Za-z\u0E00-\u0E7F][A-Za-z0-9\u0E00-\u0E7F\-+]{1,}/g) ?? [];
    for (const m of spaceTokens) {
      const low = m.toLowerCase();
      if (/\b(the|and|for|with|eau|de|parfum|plus|fist|care|1|of|ml|g|mg|pc|pack|set)\b/i.test(low)) continue;
      if (low.length < 2) continue;
      keywords.set(low, (keywords.get(low) ?? 0) + 1);
    }
    // 2b) 中文词：连续 2-6 字的中文字符
    const zhTokens = name.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
    for (const m of zhTokens) {
      keywords.set(m, (keywords.get(m) ?? 0) + 1);
    }
    // 2c) 小语种兜底：泰文/越南文/印尼文 3-gram（只统计重复出现的片段）
    const scriptMatch = name.match(/[\u0E00-\u0E7F\u1E00-\u1EFF\u00C0-\u024F]{3,}/g);
    if (scriptMatch) {
      for (const blob of scriptMatch) {
        for (let i = 0; i <= blob.length - 4; i++) {
          const gram = blob.slice(i, i + 4);
          keywords.set(gram, (keywords.get(gram) ?? 0) + 1);
        }
      }
    }
  }
  const hotTerms = [...keywords.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w);
  // 过滤掉 n-gram 产生的乱码式片段：纯符号或字符重复太多
  const validHotTerms = hotTerms.filter((w) => {
    if (!w) return false;
    const chars = [...w];
    const unique = new Set(chars);
    return unique.size >= Math.max(2, Math.ceil(chars.length * 0.5));
  });

  // GMV 分布
  const gmvs = matchedRecords.map((r) => parseGmvLower(pickRecordField(r, ["gmv_range"]))).filter(Boolean);
  const totalEstimate = gmvs.length ? gmvs.reduce((a, b) => a + b, 0) : 0;
  const headGmv = gmvs.slice(0, 3).reduce((a, b) => a + b, 0);
  const concentration = totalEstimate > 0 ? (headGmv / totalEstimate) : 0;

  // 评分
  const ratings = matchedRecords
    .map((r) => Number(pickRecordField(r, ["rating"])))
    .filter((v): v is number => Number.isFinite(v) && v > 0);
  const avgRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const avgRatingText = avgRating > 0 ? `，平均评分 ${avgRating.toFixed(1)} / 5` : "";

  // TOP3 摘要（明确标注"样本数/类目覆盖"，避免让人误以为是该类目完整榜）
  const top3 = top
    .slice(0, 3)
    .map((r, i) => {
      const nameRaw = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "—");
      const name = nameRaw.length > 22 ? nameRaw.slice(0, 20) + "…" : nameRaw;
      const gmv = pickRecordField(r, ["gmv_range"]);
      const shop = pickRecordField(r, ["shop_name", "shop"]);
      return `第${i + 1}·${name}${shop ? `(${shop})` : ""}${gmv ? `（GMV ${gmv}）` : ""}`;
    })
    .join("；");

  const concentrationText = concentration >= 0.35
    ? `头部集中度较高（TOP3 占榜单下限 ${(concentration * 100).toFixed(0)}%），切入需差异化`
    : concentration >= 0.2 ? `头部集中度中等（TOP3 占榜单下限 ${(concentration * 100).toFixed(0)}%），机会尚在`
    : `竞争较分散（TOP3 仅占榜单下限 ${(concentration * 100).toFixed(0)}%），适合中小卖家试水`;

  const hotTopics = validHotTerms.length ? `，热门方向：${validHotTerms.join("、")}` : "";
  const scope = categoryLabel ? `${categoryLabel}类目相关` : "市场";

  // ─── 核心修复 3：建议和结论针对"是否命中类目"分别给出，不再一句"研究头部"敷衍 ─────────────
  let suggestion: string;
  if (categoryLabel && matchDisclaimer) {
    suggestion = `针对${categoryLabel}赛道的三条建议：① 优先拿这 ${matchedRecords.length} 条样本反向找它们所属的叶子类目 ID，再用类目 ID 重拉官方热销或搜索榜；② 对比 TOP3 的价格带、卖点话术（主图前 3 张+标题前 10 字）和评分，找比你现有货源有 10% 以上优势的切入位置；③ 如果样本太少说明该类目本身不是大盘爆款，需要配合达人种草或短视频内容打爆，不能纯靠自然流量。`;
  } else {
    suggestion = "选品切入的三步建议：① 先拿 TOP3 反查其所属叶子类目和价格带，确认你的货源能不能在该价格带做到 30% 毛利；② 评分低于 4.5 的头部商品是你优先赶超的对手位；③ 如果赛道品牌集中度高，就挑价格带中间段（GMV 区间下限的 60%-80%）做差异化 SKU，别硬刚头部。";
  }

  return `官方 市场热销商品榜：近 ${days} 天${regionLabel}${scope}热销样本共 ${matchedRecords.length} 个${avgRatingText}${matchDisclaimer ? " " + matchDisclaimer : ""}。${concentrationText}${hotTopics}。TOP3：${top3}。${suggestion}`;
}

function summarizeMarketCreators(records: Array<Record<string, unknown>>, days: number, regionLabel: string): string {
  if (!records.length) return `近 ${days} 天${regionLabel}市场暂无达人热销榜，建议先明确你要做的品类再筛选匹配达人。`;
  const top = records.slice(0, 10);
  const followers = top
    .map((r) => Number(pickRecordField(r, ["followers_count", "followers"])))
    .filter((v): v is number => Number.isFinite(v) && v > 0);
  const likes = top
    .map((r) => Number(pickRecordField(r, ["likes_count", "likes"])))
    .filter((v): v is number => Number.isFinite(v) && v > 0);
  const avgFollowers = followers.length ? followers.reduce((a, b) => a + b, 0) / followers.length : 0;
  const avgLikes = likes.length ? likes.reduce((a, b) => a + b, 0) / likes.length : 0;

  const top3 = top.slice(0, 3).map((r, i) => {
    const nick = String(pickRecordField(r, ["nick_name", "user_name", "name"]) ?? "达人");
    const fans = humanCount(pickRecordField(r, ["followers_count", "followers"]));
    const likesCount = humanCount(pickRecordField(r, ["likes_count", "likes"]));
    const gmv = pickRecordField(r, ["gmv_range"]);
    return `第${i + 1}·${nick}（${fans}粉 / ${likesCount}赞${gmv ? ` / GMV ${gmv}` : ""}）`;
  }).join("；");

  const profile = avgFollowers >= 500_000
    ? "以腰部以上达人为主"
    : avgFollowers >= 50_000 ? "以腰尾部达人为主" : "以素人/KOC 为主";
  return `近 ${days} 天${regionLabel}市场热销达人共 ${records.length} 位，${profile}。头部达人平均 ${humanCount(avgFollowers)} 粉丝，平均获赞 ${humanCount(avgLikes)}。TOP3：${top3}。建议先锁定粉丝画像与你品类匹配度高的 2-3 位达人再谈合作。`;
}

function summarizeMarketVideos(records: Array<Record<string, unknown>>, days: number, regionLabel: string): string {
  if (!records.length) return `近 ${days} 天${regionLabel}市场暂无热门带货视频，建议先研究同类商品再参考竞品内容。`;
  const views = records.map((r) => Number(pickRecordField(r, ["views"]))).filter((v): v is number => Number.isFinite(v) && v > 0);
  const avgViews = views.length ? views.reduce((a, b) => a + b, 0) / views.length : 0;
  const top3 = records.slice(0, 3).map((r, i) => {
    const nick = String(pickRecordField(r, ["nick_name", "creator_nick_name", "name"]) ?? "达人");
    const v = humanCount(pickRecordField(r, ["views"]));
    const likes = humanCount(pickRecordField(r, ["likes"]));
    return `第${i + 1}·${nick}（${v}播放 / ${likes}赞）`;
  }).join("；");
  return `近 ${days} 天${regionLabel}市场热门带货视频共 ${records.length} 条，平均播放 ${humanCount(avgViews)}。TOP3：${top3}。建议分析这 3 条视频的脚本结构、卖点和开头 3 秒钩子再拍同款。`;
}

function summarizeMarketLives(records: Array<Record<string, unknown>>, days: number, regionLabel: string): string {
  if (!records.length) return `近 ${days} 天${regionLabel}市场暂无热门带货直播，建议先按你的商品类型搜同品类直播排期。`;
  const top3 = records.slice(0, 3).map((r, i) => {
    const title = String(pickRecordField(r, ["title", "name"]) ?? "直播");
    const titleShort = title.length > 20 ? title.slice(0, 18) + "…" : title;
    const creator = String(pickRecordField(r, ["creator_nick_name", "nick_name", "creator_name"]) ?? "主播");
    const gmv = pickRecordField(r, ["gmv_range"]);
    const duration = pickRecordField(r, ["duration"]);
    return `第${i + 1}·${titleShort}（${creator}${gmv ? ` / ${gmv}` : ""}${duration ? ` / 时长${duration}` : ""}）`;
  }).join("；");
  return `近 ${days} 天${regionLabel}市场热门带货直播共 ${records.length} 场。TOP3：${top3}。建议抓取头部主播的排品节奏、话术结构与留人手段再优化自己的直播脚本。`;
}

function summarizeShop(records: Array<Record<string, unknown>>, days: number, label: string): string {
  if (!records.length) return `近 ${days} 天店铺暂无${label}数据，建议先确认店铺后台是否有曝光订单。`;
  return `近 ${days} 天店铺${label}共 ${records.length} 项已展示。按表格排名靠前的即为当前核心流量/销量来源，优先优化靠前几项再扩大曝光。`;
}

function summarizeProductDiagnoses(records: Array<Record<string, unknown>>): string {
  if (!records.length) return `当前在售商品均未命中官方诊断项，整体资料质量不错，可以加大投放力度。`;
  const needFix = records.length;
  const sample = records
    .slice(0, 3)
    .map((r) => {
      const title = String(pickRecordField(r, ["product_title", "title"]) ?? "商品");
      const t = title.length > 16 ? title.slice(0, 14) + "…" : title;
      const issues = pickRecordField(r, ["diagnoses", "issues"]);
      return `${t}：${issues ? String(issues).split(/[,，]/).slice(0, 2).join("、") || "需优化" : ""}`;
    })
    .join("；");
  return `共 ${needFix} 个在售商品命中了官方诊断项。示例：${sample}。建议优先处理排名最靠前的 3-5 个商品再复测质量分。`;
}

export async function runTikTokSceneQuery(query: TikTokSceneQuery, requestedDays = 7, originalText = ""): Promise<TikTokSceneQueryResult> {
  const [client, authorization] = await Promise.all([getAuthorizedTikTokClient(), readStoredAuthorization()]);
  if (!client) throw new Error("TikTok Shop 尚未完成授权，无法读取真实场景数据。");
  const range = timeRange(requestedDays, selectedRegion(authorization));

  if (query.startsWith("market_")) {
    const config = {
      market_products: {
        path: "/analytics/202511/products/bestselling",
        key: "products",
        label: "市场热销商品",
        columns: [
          { key: "rank", label: "排名" }, { key: "name", label: "商品" }, { key: "gmv_range", label: "GMV 区间" },
          { key: "shop_name", label: "店铺" }, { key: "rating", label: "评分" },
        ],
      },
      market_creators: {
        path: "/analytics/202511/creators/bestselling",
        key: "creators",
        label: "市场热销达人",
        columns: [
          { key: "rank", label: "排名" }, { key: "nick_name", label: "达人", candidates: ["nick_name", "user_name"] },
          { key: "gmv_range", label: "GMV 区间" }, { key: "followers_count", label: "粉丝" }, { key: "likes_count", label: "获赞" },
        ],
      },
      market_videos: {
        path: "/analytics/202511/videos/bestselling",
        key: "videos",
        label: "市场热门带货视频",
        columns: [
          { key: "rank", label: "排名" }, { key: "nick_name", label: "达人" }, { key: "gmv_range", label: "GMV 区间" },
          { key: "views", label: "播放" }, { key: "likes", label: "点赞" }, { key: "comments", label: "评论" },
        ],
      },
      market_lives: {
        path: "/analytics/202511/lives/bestselling",
        key: "lives",
        label: "市场热门带货直播",
        columns: [
          { key: "rank", label: "排名" }, { key: "title", label: "直播" }, { key: "creator_nick_name", label: "达人", candidates: ["creator_nick_name", "creator_name"] },
          { key: "gmv_range", label: "GMV 区间" }, { key: "start_time", label: "开播时间" }, { key: "duration", label: "时长" },
        ],
      },
    }[query as "market_products" | "market_creators" | "market_videos" | "market_lives"];
    const bestsellersQuery = (date: string) => ({
      date,
      time_slot: range.timeSlot,
      currency: "LOCAL",
      ...(query === "market_creators" ? { author_type: "AFFILIATE" } : {}),
    });
    let effectiveDate = range.date;
    let payload: unknown;
    try {
      payload = await client.request<unknown>(config.path, { query: bestsellersQuery(effectiveDate) });
    } catch (error) {
      const availableDate = latestAvailableDate(error);
      if (!availableDate) throw error;
      effectiveDate = availableDate;
      payload = await client.request<unknown>(config.path, { query: bestsellersQuery(effectiveDate) });
    }
    const dataObj = dataObject(payload);
    const artifact = recordsArtifact({
      headline: `${range.days} 天${config.label}`,
      data: dataObj,
      recordKey: config.key,
      columns: config.columns,
      path: config.path,
      summary: `榜单截止 ${effectiveDate}。官方 Bestsellers 只返回排名和 GMV 区间，不会把区间伪装成精确成交额。`,
      emptyLabel: "该时间范围内没有返回榜单记录。",
    });
    const records = extractRecords(dataObj, config.key);
    const region = selectedRegion(authorization);
    const regionLabel = region ? (REGION_LABELS[region] ?? region) : "";
    let summary = "";
    const categoryHint = query === "market_products" ? extractCategoryIntent(originalText) : undefined;
    if (query === "market_products") {
      summary = summarizeMarketProducts(records, range.days, regionLabel, categoryHint);
    } else if (query === "market_creators") {
      summary = summarizeMarketCreators(records, range.days, regionLabel);
    } else if (query === "market_videos") {
      summary = summarizeMarketVideos(records, range.days, regionLabel);
    } else if (query === "market_lives") {
      summary = summarizeMarketLives(records, range.days, regionLabel);
    } else {
      summary = `近 ${range.days} 天${regionLabel}${config.label}共 ${records.length} 条记录已展示。`;
    }
    return { content: summary, artifact };
  }

  if (query === "shop_products" || query === "shop_videos" || query === "shop_lives") {
    const config = {
      shop_products: {
        path: "/analytics/202605/shop_products/performance",
        key: "products",
        label: "店铺商品表现",
        columns: [
          { key: "id", label: "商品 ID" }, { key: "total_performance", label: "整体表现" },
          { key: "seller_live_performance", label: "店播" }, { key: "seller_video_performance", label: "短视频" },
          { key: "seller_product_card_performance", label: "商品卡" },
        ],
      },
      shop_videos: {
        path: "/analytics/202605/shop_videos/performance",
        key: "videos",
        label: "店铺短视频表现",
        columns: [
          { key: "id", label: "视频 ID" }, { key: "title", label: "视频" }, { key: "username", label: "账号" },
          { key: "gmv", label: "GMV" }, { key: "items_sold", label: "销量" }, { key: "views", label: "播放" },
        ],
      },
      shop_lives: {
        path: "/analytics/202509/shop_lives/performance",
        key: "live_stream_sessions",
        label: "店铺直播表现",
        columns: [
          { key: "id", label: "直播 ID" }, { key: "title", label: "直播" }, { key: "username", label: "账号" },
          { key: "start_time", label: "开播" }, { key: "end_time", label: "结束" }, { key: "sales_performance", label: "销售表现" },
        ],
      },
    }[query];
    const analyticsQuery = (startDate: string, endDateExclusive: string) => ({
      start_date_ge: startDate,
      end_date_lt: endDateExclusive,
      page_size: "50",
      currency: "LOCAL",
    });
    let startDate = range.startDate;
    let endDateExclusive = range.endDateExclusive;
    let payload: unknown;
    try {
      payload = await client.request<unknown>(config.path, { query: analyticsQuery(startDate, endDateExclusive) });
    } catch (error) {
      const availableDate = latestAvailableDate(error);
      if (!availableDate) throw error;
      startDate = shiftDate(availableDate, -(range.days - 1));
      endDateExclusive = shiftDate(availableDate, 1);
      payload = await client.request<unknown>(config.path, { query: analyticsQuery(startDate, endDateExclusive) });
    }
    const shopData = dataObject(payload);
    const artifact = recordsArtifact({
      headline: `近 ${range.days} 天${config.label}`,
      data: shopData,
      recordKey: config.key,
      columns: config.columns,
      path: config.path,
      summary: `数据区间 ${startDate} 至 ${shiftDate(endDateExclusive, -1)}。`,
    });
    const records = extractRecords(shopData, config.key);
    return { content: summarizeShop(records, range.days, config.label), artifact };
  }

  if (query === "product_diagnoses") {
    const searchPath = "/product/202502/products/search";
    const searchPayload = await client.request<unknown>(searchPath, { method: "POST", query: { page_size: "20" }, body: { status: "ACTIVATE" } });
    const products = extractRecords(dataObject(searchPayload), "products");
    const productIds = products.map((product) => product.id).filter((id): id is string => typeof id === "string").slice(0, 20);
    const path = "/product/202405/products/diagnoses";
    if (!productIds.length) {
      return {
        content: "当前没有可诊断的在售商品。",
        artifact: recordsArtifact({ headline: "商品信息质量诊断", data: { diagnoses: [] }, recordKey: "diagnoses", columns: [{ key: "product_id", label: "商品 ID" }, { key: "diagnoses", label: "诊断结果" }], path, emptyLabel: "当前没有可诊断的在售商品。" }),
      };
    }
    const payload = await client.request<unknown>(path, { query: { product_ids: productIds.join(",") } });
    const diagData = dataObject(payload);
    const artifact = recordsArtifact({
      headline: `在售商品信息质量诊断（前 ${productIds.length} 个）`,
      data: diagData,
      recordKey: "diagnoses",
      columns: [
        { key: "product_id", label: "商品 ID" }, { key: "product_title", label: "商品", candidates: ["product_title", "title"] },
        { key: "diagnoses", label: "诊断项", candidates: ["diagnoses", "issues"] }, { key: "suggestions", label: "建议" },
      ],
      path,
      emptyLabel: "TikTok Shop 没有返回需要改进的商品诊断项。",
    });
    const diagRecords = extractRecords(diagData, "diagnoses");
    return { content: summarizeProductDiagnoses(diagRecords), artifact };
  }

  if (query === "global_products") {
    const path = "/product/202312/global_products/search";
    const payload = await client.request<unknown>(path, { method: "POST", query: { page_size: "50" }, body: {}, shopScoped: false });
    const artifact = recordsArtifact({
      headline: "全球商品列表",
      data: dataObject(payload),
      recordKey: "global_products",
      columns: [
        { key: "id", label: "全球商品 ID" }, { key: "title", label: "商品" }, { key: "status", label: "状态" },
        { key: "skus", label: "SKU" }, { key: "create_time", label: "创建时间" }, { key: "update_time", label: "更新时间" },
      ],
      path,
      emptyLabel: "当前卖家没有返回全球商品，或店铺不具备全球商品资格。",
    });
    return { content: "我已调用全球商品搜索接口，并按 API 原样展示结果。", artifact };
  }

  if (query === "global_categories") {
    const path = "/product/202309/global_categories";
    const payload = await client.request<unknown>(path, { shopScoped: false });
    const artifact = recordsArtifact({
      headline: "全球商品类目",
      data: dataObject(payload),
      recordKey: "categories",
      columns: [
        { key: "id", label: "类目 ID" }, { key: "local_name", label: "类目", candidates: ["local_name", "name"] },
        { key: "parent_id", label: "父类目" }, { key: "is_leaf", label: "叶子类目" }, { key: "permission_statuses", label: "权限状态" },
      ],
      path,
      emptyLabel: "当前卖家没有返回全球商品类目。",
    });
    return { content: "我已读取全球商品类目。", artifact };
  }

  if (query === "seller_permissions") {
    const path = "/seller/202309/permissions";
    const payload = await client.request<unknown>(path, { shopScoped: false });
    const data = dataObject(payload);
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const artifact = recordsArtifact({
      headline: `卖家权限共 ${permissions.length} 项`,
      data: { permissions },
      recordKey: "permissions",
      columns: [{ key: "value", label: "权限" }],
      path,
      emptyLabel: "TikTok Shop 没有返回额外卖家权限。",
    });
    return { content: "我已读取 seller permissions；全球商品操作会以这份结果做资格校验。", artifact };
  }

  if (query === "authorized_shops" || query === "shop_groups") {
    const isGroups = query === "shop_groups";
    const path = isGroups ? "/seller/202601/shop_groups" : "/authorization/202309/shops";
    const payload = await client.request<unknown>(path, { shopScoped: false });
    const artifact = recordsArtifact({
      headline: isGroups ? "店铺组" : "已授权店铺",
      data: dataObject(payload),
      recordKey: isGroups ? "shop_groups" : "shops",
      columns: isGroups
        ? [{ key: "id", label: "店铺组 ID" }, { key: "name", label: "店铺组" }, { key: "shops", label: "店铺" }, { key: "create_time", label: "创建时间" }]
        : [{ key: "id", label: "店铺 ID" }, { key: "name", label: "店铺" }, { key: "region", label: "站点" }, { key: "seller_type", label: "卖家类型" }],
      path,
      emptyLabel: isGroups ? "当前没有返回店铺组。" : "当前没有返回已授权店铺。",
    });
    return { content: `我已读取${isGroups ? "店铺组" : "已授权店铺列表"}。`, artifact };
  }

  if (query === "orders" || query === "pending_orders" || query === "order_detail" || query === "order_price") {
    const orderId = entityId(originalText);
    if ((query === "order_detail" || query === "order_price") && !orderId) {
      const path = query === "order_price" ? "/order/202407/orders/{order_id}/price_detail" : "/order/202507/orders";
      return {
        content: "这项查询需要明确的 TikTok Shop 订单号。",
        artifact: recordsArtifact({
          headline: query === "order_price" ? "查询订单价格明细" : "查询完整订单",
          data: { records: [] },
          recordKey: "records",
          columns: [{ key: "order_id", label: "订单 ID" }],
          path,
          summary: "请在指令中带上订单号，例如：查询订单 1234567890123456789 的价格明细。",
          emptyLabel: "尚未提供订单号，本次没有调用详情接口。",
        }),
      };
    }

    if (query === "order_price") {
      const path = `/order/202407/orders/${encodeURIComponent(orderId!)}/price_detail`;
      const payload = await client.request<unknown>(path);
      const data = dataObject(payload);
      const artifact = recordsArtifact({
        headline: `订单 ${orderId} 价格明细`, data: { records: [data] }, recordKey: "records",
        columns: [
          { key: "order_id", label: "订单 ID", candidates: ["order_id", "id"] }, { key: "payment", label: "支付金额" },
          { key: "product_price", label: "商品金额" }, { key: "shipping_fee", label: "运费" }, { key: "tax", label: "税费" }, { key: "discount", label: "优惠" },
        ],
        path,
      });
      return { content: "我已读取订单价格构成；结果未包含买家姓名、电话或地址。", artifact };
    }

    if (query === "order_detail") {
      const path = "/order/202507/orders";
      const payload = await client.request<unknown>(path, { query: { ids: orderId! } });
      const artifact = recordsArtifact({
        headline: `订单 ${orderId} 详情`, data: dataObject(payload), recordKey: "orders",
        columns: [
          { key: "id", label: "订单 ID" }, { key: "status", label: "状态" }, { key: "payment", label: "支付" },
          { key: "line_items", label: "商品行" }, { key: "packages", label: "包裹" }, { key: "create_time", label: "创建时间" },
        ],
        path,
        summary: "只展示运营必要字段，买家姓名、电话和地址不会发送给 LLM。",
      });
      return { content: "我已读取完整订单，并在展示前移除买家个人信息。", artifact };
    }

    const path = "/order/202309/orders/search";
    const payload = await client.request<unknown>(path, {
      method: "POST",
      query: { page_size: "50", sort_field: "create_time", sort_order: "DESC" },
      body: {
        create_time_ge: range.startTimestamp,
        create_time_lt: range.endTimestamp,
        ...(query === "pending_orders" ? { order_status: "AWAITING_SHIPMENT" } : {}),
      },
    });
    const artifact = recordsArtifact({
      headline: query === "pending_orders" ? "待发货订单" : `近 ${range.days} 天订单`,
      data: dataObject(payload), recordKey: "orders",
      columns: [
        { key: "id", label: "订单 ID" }, { key: "status", label: "状态" }, { key: "payment", label: "支付" },
        { key: "line_items", label: "商品行" }, { key: "packages", label: "包裹" }, { key: "create_time", label: "创建时间" },
      ],
      path,
      summary: "只展示运营必要字段，买家个人信息不会发送给 LLM。",
      emptyLabel: query === "pending_orders" ? "当前没有待发货订单。" : "该时间范围内没有返回订单。",
    });
    return { content: `我已读取${query === "pending_orders" ? "待发货" : `近 ${range.days} 天`}订单。`, artifact };
  }

  if (query === "promotions_overview") {
    const activityPath = "/promotion/202309/activities/search";
    const couponPath = "/promotion/202406/coupons/search";
    const [activityPayload, couponPayload] = await Promise.all([
      client.request<unknown>(activityPath, { method: "POST", body: { page_size: 50 } }),
      client.request<unknown>(couponPath, { method: "POST", query: { page_size: "50" }, body: {} }),
    ]);
    const activities = extractRecords(dataObject(activityPayload), "activities").map((item) => ({ ...item, record_type: "促销活动" }));
    const coupons = extractRecords(dataObject(couponPayload), "coupons").map((item) => ({ ...item, record_type: "优惠券" }));
    const artifact = recordsArtifact({
      headline: "促销活动与优惠券",
      data: { records: [...activities, ...coupons] },
      recordKey: "records",
      columns: [
        { key: "record_type", label: "类型" }, { key: "id", label: "ID" }, { key: "title", label: "名称" },
        { key: "status", label: "状态" }, { key: "begin_time", label: "开始", candidates: ["begin_time", "start_time"] },
        { key: "end_time", label: "结束", candidates: ["end_time", "expire_time"] },
      ],
      path: `${activityPath} + ${couponPath}`,
      summary: `促销活动 ${activities.length} 条，优惠券 ${coupons.length} 条。`,
      emptyLabel: "当前没有返回促销活动或优惠券。",
    });
    return { content: "我已分别读取当前促销活动和优惠券。", artifact };
  }

  if (query === "promotions" || query === "coupons") {
    const isCoupon = query === "coupons";
    const path = isCoupon ? "/promotion/202406/coupons/search" : "/promotion/202309/activities/search";
    const payload = await client.request<unknown>(path, {
      method: "POST",
      ...(isCoupon ? { query: { page_size: "50" } } : {}),
      body: isCoupon ? {} : { page_size: 50 },
    });
    const artifact = recordsArtifact({
      headline: isCoupon ? "优惠券列表" : "促销活动列表",
      data: dataObject(payload),
      recordKey: isCoupon ? "coupons" : "activities",
      columns: isCoupon
        ? [{ key: "id", label: "优惠券 ID" }, { key: "title", label: "优惠券" }, { key: "display_type", label: "展示方式" }, { key: "status", label: "状态" }, { key: "create_time", label: "创建时间" }]
        : [{ key: "id", label: "活动 ID" }, { key: "title", label: "活动" }, { key: "activity_type", label: "类型" }, { key: "status", label: "状态" }, { key: "begin_time", label: "开始" }, { key: "end_time", label: "结束" }],
      path,
      emptyLabel: isCoupon ? "当前没有返回优惠券。" : "当前没有返回促销活动。",
    });
    return { content: `我已读取 TikTok Shop 当前${isCoupon ? "优惠券" : "促销活动"}。`, artifact };
  }

  if (query === "combinable_packages") {
    const path = "/fulfillment/202309/combinable_packages/search";
    const payload = await client.request<unknown>(path, { query: { page_size: "50" } });
    const artifact = recordsArtifact({
      headline: "可合并包裹",
      data: dataObject(payload),
      recordKey: "combinable_packages",
      columns: [
        { key: "id", label: "包裹 ID" }, { key: "order_id", label: "订单 ID" }, { key: "status", label: "状态" },
        { key: "shipping_provider_name", label: "承运商" }, { key: "tracking_number", label: "物流单号" }, { key: "create_time", label: "创建时间" },
      ],
      path,
      emptyLabel: "当前没有可合并的包裹。",
    });
    return { content: "我已调用官方可合并包裹查询；合包属于写操作，仍需另行确认。", artifact };
  }

  if (query === "packages") {
    const path = "/fulfillment/202309/packages/search";
    const payload = await client.request<unknown>(path, {
      method: "POST",
      query: { page_size: "50", sort_field: "order_pay_time", sort_order: "DESC" },
      body: { create_time_ge: range.startTimestamp, create_time_lt: range.endTimestamp },
    });
    const artifact = recordsArtifact({
      headline: `近 ${range.days} 天包裹列表`,
      data: dataObject(payload),
      recordKey: "packages",
      columns: [
        { key: "id", label: "包裹 ID" }, { key: "status", label: "状态" }, { key: "tracking_number", label: "物流单号" },
        { key: "shipping_provider_name", label: "承运商" }, { key: "orders", label: "订单" }, { key: "create_time", label: "创建时间" },
      ],
      path,
      emptyLabel: "该时间范围内没有返回包裹。",
    });
    return { content: "我已读取 TikTok Shop 履约包裹。", artifact };
  }

  if (query === "warehouses") {
    const path = "/logistics/202309/warehouses";
    const payload = await client.request<unknown>(path);
    const artifact = recordsArtifact({
      headline: "仓库列表",
      data: dataObject(payload),
      recordKey: "warehouses",
      columns: [
        { key: "id", label: "仓库 ID" }, { key: "name", label: "仓库" }, { key: "type", label: "类型" },
        { key: "effect_status", label: "状态" }, { key: "is_default", label: "默认" }, { key: "address", label: "地址" },
      ],
      path,
      emptyLabel: "TikTok Shop 没有返回仓库。",
    });
    return { content: "我已读取当前店铺可用仓库。", artifact };
  }

  if (query === "shipping_templates") {
    const path = "/logistics/202510/seller_templates";
    const payload = await client.request<unknown>(path);
    const artifact = recordsArtifact({
      headline: "可用物流模板",
      data: dataObject(payload),
      recordKey: "templates",
      columns: [
        { key: "id", label: "模板 ID" }, { key: "name", label: "模板" }, { key: "is_default", label: "默认" },
        { key: "status", label: "状态" }, { key: "unavailable_reasons", label: "不可用原因" },
      ],
      path,
      emptyLabel: "当前没有返回可用物流模板。",
    });
    return { content: "我已读取当前店铺的可用物流模板。", artifact };
  }

  if (query === "order_tracking") {
    const orderId = entityId(originalText);
    const path = orderId ? `/logistics/202604/orders/${encodeURIComponent(orderId)}/tracking` : "/logistics/202604/orders/{order_id}/tracking";
    if (!orderId) {
      return {
        content: "查询物流轨迹需要明确的订单号。",
        artifact: recordsArtifact({ headline: "查询订单物流轨迹", data: { records: [] }, recordKey: "records", columns: [{ key: "order_id", label: "订单 ID" }], path, summary: "请在指令中带上 TikTok Shop 订单号。", emptyLabel: "尚未提供订单号，本次没有调用物流轨迹接口。" }),
      };
    }
    const payload = await client.request<unknown>(path);
    const data = dataObject(payload);
    const records = extractRecords(data, "tracking").length ? extractRecords(data, "tracking") : extractRecords(data, "tracking_events");
    const artifact = recordsArtifact({
      headline: `订单 ${orderId} 物流轨迹`, data: { records }, recordKey: "records",
      columns: [
        { key: "update_time", label: "时间", candidates: ["update_time", "event_time"] }, { key: "description", label: "轨迹", candidates: ["description", "event"] },
        { key: "location", label: "地点" }, { key: "status", label: "状态" }, { key: "tracking_number", label: "物流单号" },
      ],
      path,
      emptyLabel: "该订单当前没有返回物流轨迹。",
    });
    return { content: "我已读取订单物流轨迹。", artifact };
  }

  if (query === "tracking_validation") {
    const number = trackingNumber(originalText);
    const path = "/fulfillment/202508/tts_tracking_validation";
    if (!number) {
      return {
        content: "校验物流单号需要在指令中提供具体单号。",
        artifact: recordsArtifact({ headline: "校验物流单号", data: { records: [] }, recordKey: "records", columns: [{ key: "tracking_number", label: "物流单号" }], path, summary: "例如：验证物流单号 ABC123456789 是否有效。", emptyLabel: "尚未提供物流单号，本次没有调用校验接口。" }),
      };
    }
    const payload = await client.request<unknown>(path, { query: { tracking_number: number } });
    const artifact = recordsArtifact({
      headline: `物流单号 ${number} 校验结果`, data: { records: [dataObject(payload)] }, recordKey: "records",
      columns: [{ key: "tracking_number", label: "物流单号" }, { key: "is_tts_tracking", label: "TikTok 物流" }, { key: "is_valid", label: "有效" }, { key: "reason", label: "说明" }], path,
    });
    return { content: "我已调用 TikTok Shop 物流单号校验接口。", artifact };
  }

  if (query === "aftersales_requests" || query === "return_records" || query === "aftersale_eligibility") {
    const id = entityId(originalText);
    if ((query === "return_records" || query === "aftersale_eligibility") && !id) {
      const path = query === "return_records" ? "/return_refund/202309/returns/{return_id}/records" : "/return_refund/202602/orders/{order_id}/aftersale_eligibility";
      return {
        content: `查询${query === "return_records" ? "退货记录" : "售后资格"}需要明确的${query === "return_records" ? "退货" : "订单"}编号。`,
        artifact: recordsArtifact({ headline: query === "return_records" ? "查询退货记录" : "查询售后资格", data: { records: [] }, recordKey: "records", columns: [{ key: "id", label: "编号" }], path, summary: "请在指令中带上具体编号。", emptyLabel: "尚未提供编号，本次没有调用详情接口。" }),
      };
    }

    if (query === "return_records") {
      const path = `/return_refund/202309/returns/${encodeURIComponent(id!)}/records`;
      const payload = await client.request<unknown>(path);
      const artifact = recordsArtifact({
        headline: `退货 ${id} 处理记录`, data: dataObject(payload), recordKey: "records",
        columns: [{ key: "event", label: "事件", candidates: ["event", "type"] }, { key: "status", label: "状态" }, { key: "reason", label: "原因" }, { key: "create_time", label: "时间" }],
        path,
        summary: "备注和媒体等可能包含个人信息的字段不会发送给 LLM。",
      });
      return { content: "我已读取退货处理记录，并只展示运营必要字段。", artifact };
    }

    if (query === "aftersale_eligibility") {
      const path = `/return_refund/202602/orders/${encodeURIComponent(id!)}/aftersale_eligibility`;
      const payload = await client.request<unknown>(path);
      const data = dataObject(payload);
      const records = extractRecords(data, "line_items").length ? extractRecords(data, "line_items") : [data];
      const artifact = recordsArtifact({
        headline: `订单 ${id} 售后资格`, data: { records }, recordKey: "records",
        columns: [{ key: "sku_id", label: "SKU ID" }, { key: "order_line_item_id", label: "订单行" }, { key: "eligible_request_types", label: "可申请类型" }, { key: "reasons", label: "可用原因" }], path,
      });
      return { content: "我已读取订单售后资格。", artifact };
    }

    const path = "/return_refund/202603/aftersales/search";
    const payload = await client.request<unknown>(path, {
      method: "POST",
      body: {
        filters: { time: { create_time: { min_unix_time_inclusive: range.startTimestamp, max_unix_time_exclusive: range.endTimestamp } } },
        sort: { sort_field: "CREATE_TIME", sort_order: "DESC" },
        pagination: { page_size: 50 },
      },
    });
    const artifact = recordsArtifact({
      headline: "售后请求", data: dataObject(payload), recordKey: "aftersales_requests",
      columns: [{ key: "id", label: "售后 ID" }, { key: "order_id", label: "订单 ID" }, { key: "request_type", label: "类型" }, { key: "status", label: "状态" }, { key: "reason", label: "原因" }, { key: "create_time", label: "创建时间" }],
      path,
      emptyLabel: "当前没有返回售后请求。",
    });
    return { content: "我已读取售后请求，并排除买家个人信息字段。", artifact };
  }

  if (query === "finance_order_transactions") {
    const orderId = entityId(originalText);
    const path = orderId ? `/finance/202501/orders/${encodeURIComponent(orderId)}/statement_transactions` : "/finance/202501/orders/{order_id}/statement_transactions";
    if (!orderId) {
      return {
        content: "按订单查询财务流水需要明确的订单号。",
        artifact: recordsArtifact({ headline: "按订单查询财务流水", data: { transactions: [] }, recordKey: "transactions", columns: [{ key: "order_id", label: "订单 ID" }], path, summary: "请在指令中带上具体订单号。", emptyLabel: "尚未提供订单号，本次没有调用财务明细接口。" }),
      };
    }
    const payload = await client.request<unknown>(path);
    const artifact = recordsArtifact({
      headline: `订单 ${orderId} 财务流水`, data: dataObject(payload), recordKey: "transactions",
      columns: [{ key: "id", label: "交易 ID" }, { key: "type", label: "类型" }, { key: "revenue_amount", label: "收入" }, { key: "fee_amount", label: "费用" }, { key: "settlement_amount", label: "结算额" }, { key: "currency", label: "币种" }],
      path,
      summary: "财务明细仅在当前会话展示，不会写入聊天日志之外的业务日志。",
    });
    return { content: "我已读取该订单的财务流水。", artifact };
  }

  const financeConfig = {
    finance_statements: {
      path: "/finance/202309/statements",
      key: "statements",
      label: "结算单",
      query: { sort_field: "statement_time", sort_order: "DESC", page_size: "50" },
      columns: [
        { key: "id", label: "结算单 ID" }, { key: "statement_time", label: "结算时间" }, { key: "settlement_amount", label: "结算金额" },
        { key: "currency", label: "币种" }, { key: "payment_status", label: "付款状态" }, { key: "payment_time", label: "付款时间" },
      ],
    },
    finance_withdrawals: {
      path: "/finance/202309/withdrawals",
      key: "withdrawals",
      label: "提现与结算记录",
      query: { types: "WITHDRAW,SETTLE,TRANSFER,REVERSE", page_size: "50" },
      columns: [
        { key: "id", label: "记录 ID" }, { key: "type", label: "类型" }, { key: "amount", label: "金额" },
        { key: "currency", label: "币种" }, { key: "status", label: "状态" }, { key: "create_time", label: "创建时间" },
      ],
    },
    finance_unsettled: {
      path: "/finance/202507/orders/unsettled",
      key: "transactions",
      label: "未结算交易",
      query: { sort_field: "order_create_time", sort_order: "DESC", page_size: "50" },
      columns: [
        { key: "order_id", label: "订单 ID" }, { key: "type", label: "类型" }, { key: "status", label: "状态" },
        { key: "est_settlement_amount", label: "预计结算" }, { key: "currency", label: "币种" }, { key: "unsettled_reason", label: "未结算原因" },
      ],
    },
    finance_payments: {
      path: "/finance/202605/payments",
      key: "payments",
      label: "付款记录",
      query: { sort_field: "create_time", sort_order: "DESC", page_size: "50" },
      columns: [
        { key: "id", label: "付款 ID" }, { key: "status", label: "状态" }, { key: "amount", label: "金额" },
        { key: "settlement_amount", label: "结算金额" }, { key: "create_time", label: "创建时间" }, { key: "paid_time", label: "付款时间" },
      ],
    },
  }[query as "finance_statements" | "finance_withdrawals" | "finance_unsettled" | "finance_payments"];
  if (!financeConfig) throw new Error("这个场景查询尚未配置。");
  const financeQuery = Object.fromEntries(
    Object.entries(financeConfig.query).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const payload = await client.request<unknown>(financeConfig.path, { query: financeQuery });
  const artifact = recordsArtifact({
    headline: financeConfig.label,
    data: dataObject(payload),
    recordKey: financeConfig.key,
    columns: financeConfig.columns,
    path: financeConfig.path,
    emptyLabel: `当前没有返回${financeConfig.label}。`,
  });
  return { content: `我已读取 TikTok Shop ${financeConfig.label}。`, artifact };
}

// ─── 赛道/类目深度分析：返回竞争格局、价格带、头部特征、进入建议 ──────────────────────────────

export async function analyzeCategoryTrack(
  categoryQuery: string,
  region: string,
  days: number,
  originalText: string,
): Promise<{ content: string; artifact: Extract<MessageArtifact, { kind: "records" }> | null }> {
  const [client, authorization] = await Promise.all([getAuthorizedTikTokClient(), readStoredAuthorization()]);
  if (!client) throw new Error("TikTok Shop 尚未完成授权，无法读取真实赛道数据。");

  const regionLabel = REGION_LABELS[region] ?? region;
  const categoryIntent = extractCategoryIntent(categoryQuery) ?? extractCategoryIntent(originalText);
  const categoryLabel = categoryIntent?.label ?? categoryQuery;

  const range = timeRange(days, selectedRegion(authorization));

  // ① 拉取全品类 Bestsellers 作为样本池
  const config = {
    path: "/analytics/202511/products/bestselling",
    key: "products",
    label: "市场热销商品",
    columns: [
      { key: "rank", label: "排名" },
      { key: "name", label: "商品" },
      { key: "gmv_range", label: "GMV 区间" },
      { key: "shop_name", label: "店铺" },
      { key: "rating", label: "评分" },
    ],
  };
  let effectiveDate = range.date;
  let payload: unknown;
  try {
    payload = await client.request<unknown>(config.path, {
      query: { date: effectiveDate, time_slot: range.timeSlot, currency: "LOCAL" },
    });
  } catch (error) {
    const availableDate = latestAvailableDate(error);
    if (!availableDate) throw error;
    effectiveDate = availableDate;
    payload = await client.request<unknown>(config.path, {
      query: { date: effectiveDate, time_slot: range.timeSlot, currency: "LOCAL" },
    });
  }

  const dataObj = dataObject(payload);
  const allRecords = extractRecords(dataObj, config.key);

  // ② 按类目过滤样本
  const matchedRecords: Array<Record<string, unknown>> = [];
  if (categoryIntent) {
    for (const r of allRecords) {
      const haystack = [
        pickRecordField(r, ["name", "product_name", "title"]),
        pickRecordField(r, ["category_name", "category", "leaf_category_name"]),
        pickRecordField(r, ["shop_name", "shop"]),
      ].map((v) => (v == null ? "" : String(v))).join(" \u0001 ");
      if (categoryIntent.productRe.test(haystack)) {
        matchedRecords.push(r);
      }
    }
  }

  const matchCount = matchedRecords.length;
  const hitRate = allRecords.length ? (matchCount / allRecords.length) * 100 : 0;

  // ─── ③ 深度分析 ──────────────────────────────────────────────────────

  // 3a. GMV 分布分析 → 价格带定位
  const gmvs = matchedRecords.map((r) => parseGmvLower(pickRecordField(r, ["gmv_range"]))).filter((v) => v > 0);
  const sortedGmvs = [...gmvs].sort((a, b) => a - b);
  const priceBandAnalysis = (() => {
    if (!sortedGmvs.length) return null;
    const median = sortedGmvs[Math.floor(sortedGmvs.length / 2)];
    const lowerBand = sortedGmvs.filter((g) => g <= median * 0.7);
    const midBand = sortedGmvs.filter((g) => g > median * 0.7 && g <= median * 1.3);
    const upperBand = sortedGmvs.filter((g) => g > median * 1.3);
    const fmt = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M+` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K+` : `${Math.round(v)}+`;
    return {
      median,
      lower: lowerBand.length,
      mid: midBand.length,
      upper: upperBand.length,
      total: sortedGmvs.length,
      fmtLower: lowerBand.length ? fmt(lowerBand[lowerBand.length - 1]) : "—",
      fmtMid: midBand.length ? fmt(midBand[Math.floor(midBand.length / 2)]) : "—",
      fmtUpper: upperBand.length ? fmt(upperBand[0]) : "—",
    };
  })();

  // 3b. 头部集中度分析 → 竞争格局
  const concentrationAnalysis = (() => {
    if (gmvs.length < 3) return null;
    const totalGmv = gmvs.reduce((a, b) => a + b, 0);
    const top3Gmv = gmvs.slice(0, 3).reduce((a, b) => a + b, 0);
    const top5Gmv = gmvs.slice(0, 5).reduce((a, b) => a + b, 0);
    const cr3 = totalGmv > 0 ? (top3Gmv / totalGmv) * 100 : 0;
    const cr5 = totalGmv > 0 ? (top5Gmv / totalGmv) * 100 : 0;
    let structure: string;
    if (cr3 >= 60) structure = "高度集中型：头部品牌/店铺牢牢掌控市场，新卖家切入难度大";
    else if (cr3 >= 40) structure = "中度集中型：头部有优势但尚未垄断，新卖家有差异化切入空间";
    else if (cr3 >= 25) structure = "分散竞争型：头部集中度不高，适合中小卖家通过细分差异化切入";
    else structure = "碎片化市场：没有明显头部，新卖家切入门槛低，适合白牌或细分选品";
    return { cr3, cr5, structure };
  })();

  // 3c. 店铺/品牌特征 → 头部是谁
  const shopAnalysis = (() => {
    if (!matchedRecords.length) return null;
    const shopGmv = new Map<string, { gmv: number; count: number }>();
    for (const r of matchedRecords) {
      const shop = String(pickRecordField(r, ["shop_name", "shop"]) ?? "未知店铺");
      const gmv = parseGmvLower(pickRecordField(r, ["gmv_range"]));
      const existing = shopGmv.get(shop) ?? { gmv: 0, count: 0 };
      shopGmv.set(shop, { gmv: existing.gmv + gmv, count: existing.count + 1 });
    }
    const topShops = [...shopGmv.entries()]
      .sort((a, b) => b[1].gmv - a[1].gmv)
      .slice(0, 5)
      .map(([shop, data]) => ({
        shop,
        gmv: data.gmv,
        count: data.count,
        isTop: data.count >= 2,
      }));
    return { totalShops: shopGmv.size, topShops };
  })();

  // 3d. 爆款共性特征 → 卖点/风格
  const featureAnalysis = (() => {
    if (!matchedRecords.length) return null;
    const topRecords = matchedRecords.slice(0, Math.min(10, matchedRecords.length));
    const features = new Map<string, number>();
    for (const r of topRecords) {
      const name = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "");
      const tokens = name.match(/[A-Za-z\u0E00-\u0E7F][A-Za-z0-9\u0E00-\u0E7F\-+]{1,}/g) ?? [];
      for (const t of tokens) {
        const low = t.toLowerCase();
        if (/\b(the|and|for|with|eau|de|parfum|plus|care|of|ml|g|mg|pc|pack|set)\b/i.test(low)) continue;
        if (low.length < 2) continue;
        features.set(low, (features.get(low) ?? 0) + 1);
      }
    }
    const hotFeatures = [...features.entries()]
      .filter(([, c]) => c >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w]) => w);
    const avgRating = topRecords
      .map((r) => Number(pickRecordField(r, ["rating"])))
      .filter((v) => Number.isFinite(v) && v > 0);
    const avgR = avgRating.length ? avgRating.reduce((a, b) => a + b, 0) / avgRating.length : 0;
    return { hotFeatures, avgRating: avgR };
  })();

  // ─── ④ 组装结论 ──────────────────────────────────────────────────────

  // 4a. 样本充足（≥10）→ 深度分析
  if (matchCount >= 10) {
    const priceBandText = priceBandAnalysis
      ? `中位 GMV 区间约 ${priceBandAnalysis.fmtMid}\n` +
        `低价带（≤${priceBandAnalysis.fmtLower}）：${priceBandAnalysis.lower} 款，占比 ${((priceBandAnalysis.lower / priceBandAnalysis.total) * 100).toFixed(0)}%\n` +
        `中价带：${priceBandAnalysis.mid} 款，占比 ${((priceBandAnalysis.mid / priceBandAnalysis.total) * 100).toFixed(0)}%\n` +
        `高价带（≥${priceBandAnalysis.fmtUpper}）：${priceBandAnalysis.upper} 款，占比 ${((priceBandAnalysis.upper / priceBandAnalysis.total) * 100).toFixed(0)}%`
      : `${categoryLabel}相关商品 GMV 数据有限，暂无法划分价格带`;

    const concText = concentrationAnalysis
      ? `TOP3 集中度 ${concentrationAnalysis.cr3?.toFixed(0) ?? "0"}%\n` +
        `TOP5 集中度 ${concentrationAnalysis.cr5.toFixed(0)}%\n` +
        `赛道结构：${concentrationAnalysis.structure}`
      : `相关样本不足 3 条，暂无法判断头部集中度`;

    const shopText = shopAnalysis && shopAnalysis.topShops.length
      ? `参与店铺 ${shopAnalysis.totalShops} 家，头部 5 家：\n${shopAnalysis.topShops.map((s, i) => `${i + 1}. ${s.shop}${s.isTop ? `（${s.count} 款上榜）` : ""}`).join("\n")}`
      : `样本中未识别出多产品布局的头部店铺`;

    const featureText = featureAnalysis
      ? `热门关键词：${featureAnalysis.hotFeatures.join("、") || "暂无明显共性"}\n平均评分：${featureAnalysis.avgRating.toFixed(1)} / 5`
      : `爆款特征：暂无法提取`;

    // 进入建议
    let entryAdvice: string;
    if (concentrationAnalysis && priceBandAnalysis) {
      if (concentrationAnalysis.cr3 >= 50) {
        entryAdvice = `赛道头部集中度较高，${Math.round(concentrationAnalysis.cr3)}% 的 GMV 集中在 TOP3\n建议避开正面竞争，从中低价格带（${priceBandAnalysis.fmtLower}附近）找细分差异\n或用达人种草+短视频内容打爆一个细分卖点`;
      } else if (concentrationAnalysis.cr3 >= 30) {
        entryAdvice = `赛道有一定头部但未垄断\n建议瞄准价格带中段（${priceBandAnalysis.fmtMid}附近）做差异化 SKU\n同时参考头部商品的主图风格和评分短板，在评分/卖点上超越对手`;
      } else {
        entryAdvice = `赛道集中度较低，中小卖家有切入机会\n建议选择 ${priceBandAnalysis.fmtMid} 价格带附近，用 1-2 款差异化 SKU 测试市场\n配合 KOL 种草快速积累销量和评价`;
      }
    } else {
      entryAdvice = `由于样本有限，建议先用"类目关键词+搜索"方式在 TikTok 商品搜索接口中检索 ${categoryLabel}\n拿到更全的样本后再做深度分析`;
    }

    const top3Preview = matchedRecords.slice(0, 3).map((r, i) => {
      const nameRaw = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "—");
      const name = nameRaw.length > 22 ? nameRaw.slice(0, 20) + "…" : nameRaw;
      const shop = String(pickRecordField(r, ["shop_name", "shop"]) ?? "");
      const gmv = String(pickRecordField(r, ["gmv_range"]) ?? "");
      return `${i + 1}. ${name}${shop ? `（${shop}）` : ""}${gmv ? ` · GMV ${gmv}` : ""}`;
    }).join("\n");

    const content =
      `结论：${regionLabel}${categoryLabel}赛道基于近 ${days} 天 ${matchCount} 条真实样本分析（命中率 ${hitRate.toFixed(0)}%）。市场规模为${priceBandAnalysis?.total || matchCount}款在售头部商品，${concentrationAnalysis ? concentrationAnalysis.structure : "竞争格局暂不明朗"}。\n\n` +
      `核心观点：${categoryLabel}赛道在 ${regionLabel} 的市场特征——头部${concentrationAnalysis ? (concentrationAnalysis.cr3?.toFixed(0) ?? "0") + "%集中于TOP3" : "集中度待确认"}，价格带中位${priceBandAnalysis?.fmtMid || "待确认"}，爆款平均评分${featureAnalysis?.avgRating.toFixed(1) || "4.5"}。\n\n` +
      `判断：赛道${(concentrationAnalysis?.cr3 ?? 0) >= 50 ? "头部集中度高，切入口径要避开正面竞争" : (concentrationAnalysis?.cr3 ?? 0) >= 30 ? "头部有优势但尚存机会，建议差异化切入" : "格局分散，中小卖家可先行尝试"}。价格带上，低价带适合走量但利润薄，高价带需强差异化卖点支撑，中价带为新卖家折中选择。\n\n` +
      `我的分析：\n📊 竞争格局\n${concText}\n\n💰 价格带分布\n${priceBandText}\n\n🏆 头部店铺/品牌\n${shopText}\n\n🔥 爆款共性特征\n${featureText}\n\n💡 进入建议\n${entryAdvice}\n\n📌 TOP3 样本预览：\n${top3Preview}\n\n建议下一步：先锁定价格带区间（低/中/高），再针对 TOP3 对手的主图风格、评分短板和话术进行差异化定位。`;

    // 构建 artifact
    const artifact = recordsArtifact({
      headline: `${categoryLabel}赛道 · 近 ${days} 天头部样本`,
      data: { [config.key]: matchedRecords.slice(0, 20) },
      recordKey: config.key,
      columns: config.columns,
      path: config.path,
      summary: `赛道分析：共 ${matchCount} 条 ${categoryLabel} 相关样本，命中率 ${hitRate.toFixed(0)}%。已分析竞争格局、价格带和头部特征。`,
      emptyLabel: "该赛道暂无匹配样本。",
    });

    return { content, artifact };
  }

  // 4b. 样本稀疏（<10）→ 诚实告知 + 行动建议
  if (matchCount > 0) {
    const samplePreview = matchedRecords.slice(0, Math.min(5, matchCount)).map((r, i) => {
      const nameRaw = String(pickRecordField(r, ["name", "product_name", "title"]) ?? "—");
      const name = nameRaw.length > 20 ? nameRaw.slice(0, 18) + "…" : nameRaw;
      return `${i + 1}. ${name}`;
    }).join("\n");

    const content =
      `结论：${regionLabel}${categoryLabel}赛道当前样本不足（仅 ${matchCount}/${allRecords.length} 命中，${hitRate.toFixed(1)}%）。仅凭现有样本无法给出客观的竞争格局判断，但可以为你提供后续深挖路径。\n\n` +
      `核心观点：${categoryLabel} 在 ${regionLabel} 不是大盘爆品类目。最佳做法不是根据仅有的 ${matchCount} 条样本下结论，而是先用类目 ID 或关键词搜索拿到更全的赛道样本池，再做价格带和评分分析。\n\n` +
      `判断：样本稀疏 ${matchCount}/${allRecords.length} 有两种可能——一是 ${categoryLabel} 本身在 ${regionLabel} 就是小众赛道，二是全品类热销榜只看总榜、无法按类目维度筛选。无论哪种，当前样本都不足以支撑客观的赛道竞争格局判断，不能拿仅有的样本去硬推市场机会。\n\n` +
      `我的分析：\n📋 仅有的 ${matchCount} 条样本：\n${samplePreview}\n\n⚠️ 样本稀疏可能的原因：\n1. ${categoryLabel} 在 ${regionLabel} 站点本身不是大盘爆款类目\n2. 当前热销榜未按类目筛选，全品类头部被美妆/3C/服饰等类目占据\n\n💡 建议分步推进：\n1. 先用"类目树+类目 ID"精筛 ${categoryLabel} 赛道（如果知道叶子类目 ID），直接用类目 ID 拉取官方热销榜或搜索榜\n2. 如果官方没有类目维度的热销榜，就在商品搜索接口用 ${categoryLabel} 关键词检索，按销量/GMV 排序后再对比价格带和评分\n3. 如果以上方法都拿不到足够样本，说明 ${categoryLabel} 在 ${regionLabel} 不是热门赛道，建议换品类或用达人种草+短视频内容打爆一个细分卖点\n\n建议下一步：先把类目 ID 或 1-3 个关键词给我，我直接搜索更全的样本后再给你完整赛道分析。`;

    const artifact = recordsArtifact({
      headline: `${categoryLabel}赛道 · 近 ${days} 天样本（仅 ${matchCount} 条）`,
      data: { [config.key]: matchedRecords.slice(0, 10) },
      recordKey: config.key,
      columns: config.columns,
      path: config.path,
      summary: `样本稀疏（${matchCount}/${allRecords.length}，命中率 ${hitRate.toFixed(1)}%），已标注说明。`,
      emptyLabel: "该赛道暂无匹配样本。",
    });

    return { content, artifact };
  }

  // 4c. 零命中 → 明确说明 + 行动方案
  const content =
    `结论：${regionLabel}${categoryLabel}赛道在全品类热销榜 TOP${allRecords.length} 中没有命中任何样本。这意味着 ${categoryLabel} 在当前站点不是头部热销方向，或者需要通过类目 ID/关键词搜索才能拿到有效样本。\n\n` +
    `核心观点：${categoryLabel} 赛道在 ${regionLabel} 站点没有进入全品类热销总榜 TOP${allRecords.length}。建议先通过关键词搜索或类目树 ID 验证该类目是否开放，再判断是"换赛道"还是"做内容打爆"。\n\n` +
    `判断：全品类热销榜 TOP${allRecords.length} 中零命中，通常意味着两种情况：要么该类目在本地区确实不属于热门消费方向，要么需要通过特定的类目 ID/搜索关键词才能筛选。两种情况的进入策略完全不同——前者建议放弃该类目，后者需要深挖细分样本。\n\n` +
    `我的分析：\n这通常意味着：\n1. ${categoryLabel} 在 ${regionLabel} 站点当前不是热销赛道（未进入全品类 TOP${allRecords.length}）\n2. ${categoryLabel} 可能需要通过特定类目 ID 才能筛选，全品类热销榜不直接展示该类目\n\n💡 建议行动方案：\n1. 确认 ${regionLabel} 站点是否开放 ${categoryLabel} 经营权限（调用"全球商品类目"接口查看）\n2. 如果你已有具体的叶子类目 ID，可以直接用类目 ID 拉取热销榜或搜索榜\n3. 如果没有类目 ID，用 ${categoryLabel} 关键词在 TikTok 商品搜索接口中检索，按销量排序后分析价格带和竞争格局\n4. 如果以上都无法获取有效样本，说明 ${categoryLabel} 在当前站点不是热门切入方向，建议选择其他品类或站点\n\n建议下一步：把你想验证的类目关键词（中英文各 1-2 个）发给我，或者告诉我你是否已有类目树 ID，我直接用搜索接口拿到该类目真实在售样本后再给你做客观赛道分析。`;

  const artifact = recordsArtifact({
    headline: `${categoryLabel}赛道 · 样本为零`,
    data: { [config.key]: [] },
    recordKey: config.key,
    columns: config.columns,
    path: config.path,
    summary: `全品类 TOP${allRecords.length} 中无 ${categoryLabel} 相关商品。`,
    emptyLabel: "未找到相关样本。",
  });

  return { content, artifact };
}

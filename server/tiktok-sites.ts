/**
 * TikTok Shop 站点与语言的唯一来源。
 *
 * 之前站点列表散在三处（采集店铺扇出、店铺 ID 解析、发布流程语言映射），
 * 各自新增站点时容易漏改——日本站就因此长期缺席：采集账号下只有 JP 店铺，
 * 而扇出列表里没有 JP，店铺列表永远是空的；即使店铺被解析出来，
 * 语言映射又会回落到 en，日语商品被写成英文。
 *
 * 当前项目只经营日本市场，所以 JP 是唯一的第一等站点：
 * 探测顺序、语言、标题长度、未知站点回落全部指向日本。
 */

/** 站点探测顺序：JP 排首位，顺序探测时一次命中。 */
export const TIKTOK_SITES = [
  "JP",
  "VN",
  "MY",
  "PH",
  "SG",
  "ID",
  "US",
  "UK",
] as const;

/** 项目当前唯一经营的站点。所有「不知道用哪个站点」的地方都用它。 */
export const PRIMARY_SITE = "JP";
export const PRIMARY_LANGUAGE = "ja";

/** 站点 → 商品文案目标语言（ISO 639-1）。 */
export const SITE_LANGUAGE: Record<string, string> = {
  JP: "ja",
  VN: "vi",
  MY: "ms",
  ID: "id",
  PH: "en",
  SG: "en",
  US: "en",
  UK: "en",
  GB: "en",
};

/** 站点 → 中文名，用于界面提示。 */
export const SITE_LABEL: Record<string, string> = {
  JP: "日本",
  VN: "越南",
  MY: "马来西亚",
  ID: "印尼",
  PH: "菲律宾",
  SG: "新加坡",
  US: "美国",
  UK: "英国",
  GB: "英国",
};

/** 语言 → 中文名，用于提示词里说明要写成哪种语言。 */
const LANGUAGE_LABEL: Record<string, string> = {
  ja: "日语",
  vi: "越南语",
  ms: "马来语",
  id: "印尼语",
  en: "英语",
};

/**
 * 目标语言推荐标题长度（字符）。
 * 日语标题习惯用空格分词、信息密度低，40~60 字符最稳；
 * 英语标题关键词可堆叠，可以放到 120 字符。
 */
const TITLE_LENGTH: Record<string, [number, number]> = {
  ja: [40, 60],
  vi: [50, 90],
  ms: [50, 90],
  id: [50, 90],
  en: [60, 120],
};

/**
 * 站点代码 → 目标语言。未知站点回落到日语——
 * 项目只做日本市场，回落到英语会直接产出错的文案。
 * 调用方仍应优先用 `miaoshouResolveSite()` 拿到真实站点，不要依赖这个回落。
 */
export function languageForSite(site: string | undefined | null): string {
  const key = String(site ?? "").trim().toUpperCase();
  return SITE_LANGUAGE[key] ?? PRIMARY_LANGUAGE;
}

export function languageLabel(language: string | undefined | null): string {
  return LANGUAGE_LABEL[String(language ?? "").trim().toLowerCase()] ?? LANGUAGE_LABEL.ja;
}

export function titleLengthHint(language: string | undefined | null): string {
  const key = String(language ?? "").trim().toLowerCase();
  const [min, max] = TITLE_LENGTH[key] ?? TITLE_LENGTH[PRIMARY_LANGUAGE];
  return `${min}~${max} 个字符`;
}

export function isKnownSite(site: string | undefined | null): boolean {
  return Boolean(SITE_LANGUAGE[String(site ?? "").trim().toUpperCase()]);
}

/**
 * 自然语言里的市场提法 → 站点代码。顺序敏感，靠前的先匹配。
 * 只收录 TikTok Shop 真正开放的市场：韩国、中东等地没有站点。
 */
const REGION_MENTIONS: Array<[string, RegExp]> = [
  ["JP", /(日本|japan|\bjp\b)/i],
  ["ID", /(印尼|indonesia)/i],
  ["MY", /(马来|malaysia)/i],
  ["PH", /(菲律宾|philippine)/i],
  ["VN", /(越南|vietnam)/i],
  ["SG", /(新加坡|singapore)/i],
  ["GB", /(英国|\buk\b|\bgb\b)/i],
  // 不要用 \bus\b：英文里 us 是常用词，会误判
  ["US", /(美国|\busa\b)/i],
];

/** 从用户原话里识别目标市场；识别不出返回 undefined，由调用方回落到店铺自己的站点。 */
export function detectRegion(text: string): string | undefined {
  for (const [site, pattern] of REGION_MENTIONS) {
    if (pattern.test(text)) return site;
  }
  return undefined;
}

/** 用户原话里是否提到过任何一个市场名。 */
export function mentionsRegion(text: string): boolean {
  return REGION_MENTIONS.some(([, pattern]) => pattern.test(text));
}

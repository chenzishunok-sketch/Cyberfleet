/** TikTok 卖家区域代码 → 中文名（绑定卡片与向导共用） */
export const REGION_LABELS: Record<string, string> = {
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

export function regionLabel(region: string | undefined): string {
  if (!region) return "--";
  return REGION_LABELS[region.toUpperCase()] ?? region;
}

import rules from "../data/pricing/thailand-rules.json" with { type: "json" };

export interface ThailandTaxRule {
  categoryId: string;
  categoryName: string;
  compositeRate: number;
  dutyRate: number;
  vatRate: number;
  originalCompositeRate: number;
  path: string;
}

export interface ThailandCommissionRule {
  industry: string;
  categoryName: string;
  path: string;
  rate: number;
  effectiveDate: string;
}

const taxByCategoryId = new Map(rules.taxes.map((rule) => [rule.categoryId, rule as ThailandTaxRule]));
const commissionByCategoryName = new Map<string, ThailandCommissionRule[]>();
for (const rule of rules.commissions as ThailandCommissionRule[]) {
  const key = rule.categoryName.trim().toLowerCase();
  commissionByCategoryName.set(key, [...(commissionByCategoryName.get(key) ?? []), rule]);
}

export const THAILAND_PRICING_DEFAULTS = rules.defaults;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export const THAILAND_PRELIMINARY_RATES = {
  taxRate: median(rules.taxes.map((rule) => rule.compositeRate)),
  categoryCommissionRate: median(rules.commissions.map((rule) => rule.rate)),
};

export function findThailandTaxRule(categoryId?: string): ThailandTaxRule | undefined {
  return categoryId ? taxByCategoryId.get(String(categoryId)) : undefined;
}

export function findThailandCommissionRule(categoryName?: string, categoryPath?: string): ThailandCommissionRule | undefined {
  if (!categoryName) return undefined;
  const matches = commissionByCategoryName.get(categoryName.trim().toLowerCase()) ?? [];
  if (matches.length <= 1 || !categoryPath) return matches[0];
  const normalizedPath = categoryPath.toLowerCase();
  return matches.find((rule) => normalizedPath.endsWith(rule.path.toLowerCase())) ?? matches[0];
}

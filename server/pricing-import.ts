import { randomUUID } from "node:crypto";
import type { PricingFieldSource, SkuPricingInput, SkuPricingRecord } from "../shared/contracts.ts";
import { calculateSkuPricingWithActivity } from "./pricing-engine.ts";
import {
  findThailandCommissionRule,
  findThailandTaxRule,
  THAILAND_PRICING_DEFAULTS,
  THAILAND_PRELIMINARY_RATES,
} from "./pricing-rules.ts";

/** CSV 导入所需的列定义(中文表头,与导出 CSV 一致) */
const COLUMN_MAP: Record<string, string[]> = {
  skuKey: ["SKU键", "sku_key", "skuKey"],
  skuName: ["SKU名称", "sku_name", "skuName"],
  salePriceThb: ["售价THB", "sale_price_thb", "salePriceThb"],
  purchasePriceCny: ["采购价CNY", "purchase_price_cny", "purchasePriceCny"],
  weightKg: ["重量kg", "weight_kg", "weightKg"],
  categoryId: ["类目ID", "category_id", "categoryId"],
  activityPriceThb: ["活动价THB", "activity_price_thb", "activityPriceThb"],
  domesticLogisticsCny: ["国内物流CNY", "domestic_logistics_cny", "domesticLogisticsCny"],
  cloudWarehouseCny: ["云仓CNY", "cloud_warehouse_cny", "cloudWarehouseCny"],
  buyerLocalDeliveryThb: ["当地配送THB", "buyer_local_delivery_thb", "buyerLocalDeliveryThb"],
  advertisingThb: ["广告THB", "advertising_thb", "advertisingThb"],
  creatorCommissionRate: ["达人佣金率", "creator_commission_rate", "creatorCommissionRate"],
};

type ImportField = keyof typeof COLUMN_MAP;

const REQUIRED_FIELDS: ImportField[] = ["skuKey", "skuName", "salePriceThb", "purchasePriceCny", "weightKg"];

export interface PricingImportRow {
  rowNumber: number;
  skuKey: string;
  skuName: string;
  input: SkuPricingInput;
  activityPriceThb?: number;
  categoryId?: string;
  missingFields: string[];
}

export interface PricingImportResult {
  records: SkuPricingRecord[];
  errors: Array<{ row: number; skuKey: string; error: string }>;
  workflowId: string;
}

/** 解析 CSV 文本为行数组,处理引号和转义 */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return [];
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        current.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && clean[i + 1] === "\n") i++;
        current.push(field);
        rows.push(current);
        current = [];
        field = "";
      } else {
        field += char;
      }
    }
  }
  if (field || current.length) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((row) => row.some((cell) => cell.trim()));
}

/** 构建表头到字段索引的映射 */
function buildHeaderIndex(headers: string[]): Map<ImportField, number> {
  const index = new Map<ImportField, number>();
  const normalized = headers.map((h) => h.trim());
  for (const [field, aliases] of Object.entries(COLUMN_MAP) as Array<[ImportField, string[]]>) {
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) {
        index.set(field, i);
        break;
      }
    }
  }
  return index;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value || !value.trim()) return undefined;
  const num = Number(value.trim());
  return Number.isFinite(num) ? num : undefined;
}

/** 解析 CSV 文本为导入行,不执行算价 */
export function parsePricingCsv(text: string): { rows: PricingImportRow[]; errors: Array<{ row: number; skuKey: string; error: string }>; workflowId: string } {
  const csvRows = parseCsv(text);
  if (csvRows.length < 2) {
    return { rows: [], errors: [], workflowId: "" };
  }

  const headerIndex = buildHeaderIndex(csvRows[0]);

  // 校验必需列
  const missingColumns = REQUIRED_FIELDS.filter((field) => !headerIndex.has(field));
  if (missingColumns.length) {
    throw new Error(`CSV 缺少必需列: ${missingColumns.map((f) => COLUMN_MAP[f][0]).join(", ")}`);
  }

  const workflowId = `csv-import-${Date.now()}`;
  const rows: PricingImportRow[] = [];
  const errors: Array<{ row: number; skuKey: string; error: string }> = [];

  for (let i = 1; i < csvRows.length; i++) {
    const cells = csvRows[i];
    const rowNumber = i + 1;
    const get = (field: ImportField): string | undefined => {
      const idx = headerIndex.get(field);
      return idx !== undefined ? cells[idx]?.trim() : undefined;
    };

    const skuKey = get("skuKey") ?? "";
    const skuName = get("skuName") ?? "";

    if (!skuKey) {
      errors.push({ row: rowNumber, skuKey: "", error: "SKU键为空" });
      continue;
    }

    const salePriceThb = parseNumber(get("salePriceThb"));
    const purchasePriceCny = parseNumber(get("purchasePriceCny"));
    const weightKg = parseNumber(get("weightKg"));

    if (salePriceThb === undefined || salePriceThb <= 0) {
      errors.push({ row: rowNumber, skuKey, error: "售价THB 必须为正数" });
      continue;
    }
    if (purchasePriceCny === undefined || purchasePriceCny < 0) {
      errors.push({ row: rowNumber, skuKey, error: "采购价CNY 不能为负" });
      continue;
    }
    if (weightKg === undefined || weightKg <= 0) {
      errors.push({ row: rowNumber, skuKey, error: "重量kg 必须为正数" });
      continue;
    }
    const creatorCommissionRate = parseNumber(get("creatorCommissionRate"));
    if (creatorCommissionRate !== undefined && creatorCommissionRate > 1) {
      errors.push({ row: rowNumber, skuKey, error: "达人佣金率需用小数表示（10% 应填 0.1），当前值会被当成超过 100%" });
      continue;
    }

    const categoryId = get("categoryId")?.trim() || undefined;
    const taxRule = findThailandTaxRule(categoryId);
    const commissionRule = findThailandCommissionRule(taxRule?.categoryName, taxRule?.path);

    const input: SkuPricingInput = {
      salePriceThb,
      purchasePriceCny,
      weightKg,
      exchangeRateCnyToThb: THAILAND_PRICING_DEFAULTS.exchangeRateCnyToThb,
      domesticLogisticsCny: parseNumber(get("domesticLogisticsCny")) ?? THAILAND_PRICING_DEFAULTS.domesticLogisticsCny,
      cloudWarehouseCny: parseNumber(get("cloudWarehouseCny")) ?? THAILAND_PRICING_DEFAULTS.cloudWarehouseCny,
      buyerLocalDeliveryThb: parseNumber(get("buyerLocalDeliveryThb")) ?? THAILAND_PRICING_DEFAULTS.buyerLocalDeliveryThb,
      advertisingThb: parseNumber(get("advertisingThb")) ?? THAILAND_PRICING_DEFAULTS.advertisingThb,
      creatorCommissionRate: creatorCommissionRate ?? THAILAND_PRICING_DEFAULTS.creatorCommissionRate,
      taxRate: taxRule?.compositeRate ?? THAILAND_PRELIMINARY_RATES.taxRate,
      categoryCommissionRate: commissionRule?.rate ?? THAILAND_PRELIMINARY_RATES.categoryCommissionRate,
      crossBorderThbPer10g: THAILAND_PRICING_DEFAULTS.crossBorderThbPer10g,
      transactionRate: THAILAND_PRICING_DEFAULTS.transactionRate,
      infrastructureFeeThb: THAILAND_PRICING_DEFAULTS.infrastructureFeeThb,
      growthSupportRate: THAILAND_PRICING_DEFAULTS.growthSupportRate,
      merchantDiscountThb: 0,
      platformSubsidyThb: 0,
      platformActivityFeeThb: 0,
    };

    const missingFields: string[] = [];
    if (!purchasePriceCny) missingFields.push("purchasePriceCny");
    if (!weightKg) missingFields.push("weightKg");

    rows.push({
      rowNumber,
      skuKey,
      skuName,
      input,
      activityPriceThb: parseNumber(get("activityPriceThb")),
      categoryId,
      missingFields,
    });
  }

  return { rows, errors, workflowId };
}

/** 执行 CSV 导入:解析 + 算价 + 构建 SkuPricingRecord */
export function importPricingCsv(text: string): PricingImportResult {
  const { rows, errors, workflowId } = parsePricingCsv(text);
  const records: SkuPricingRecord[] = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    try {
      const result = calculateSkuPricingWithActivity(row.input, row.activityPriceThb);
      const fieldSources: Record<string, PricingFieldSource> = {
        salePriceThb: "csv",
        purchasePriceCny: "csv",
        weightKg: "csv",
        exchangeRateCnyToThb: "default",
        domesticLogisticsCny: "csv",
        cloudWarehouseCny: "csv",
        buyerLocalDeliveryThb: "csv",
        advertisingThb: "csv",
        creatorCommissionRate: "csv",
        taxRate: row.categoryId ? "category_rule" : "default",
        categoryCommissionRate: row.categoryId ? "category_rule" : "default",
        crossBorderThbPer10g: "default",
        transactionRate: "default",
        infrastructureFeeThb: "default",
        growthSupportRate: "default",
        merchantDiscountThb: "default",
        platformSubsidyThb: "default",
        platformActivityFeeThb: "default",
      };

      records.push({
        id: randomUUID(),
        workflowId,
        skuKey: row.skuKey,
        skuName: row.skuName,
        categoryId: row.categoryId,
        currency: "THB",
        input: row.input,
        result,
        activityPriceThb: row.activityPriceThb,
        fieldSources,
        missingFields: row.missingFields,
        calculatedAt: now,
      });
    } catch (error) {
      errors.push({
        row: row.rowNumber,
        skuKey: row.skuKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { records, errors, workflowId };
}

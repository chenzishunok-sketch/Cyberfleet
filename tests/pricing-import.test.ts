import { describe, expect, it } from "vitest";
import { importPricingCsv, parsePricingCsv } from "../server/pricing-import.ts";

const VALID_CSV = `SKU键,SKU名称,售价THB,采购价CNY,重量kg
LL-A01,白色S码,99,15,0.3
LL-A02,白色M码,109,15,0.35
LL-A03,黑色L码,119,16,0.4`;

const CSV_WITH_OPTIONAL = `SKU键,SKU名称,售价THB,采购价CNY,重量kg,类目ID,活动价THB,国内物流CNY,达人佣金率
LL-B01,测试商品,89,12,0.25,501,79,3,0.1`;

const CSV_WITH_ERRORS = `SKU键,SKU名称,售价THB,采购价CNY,重量kg
LL-C01,正常商品,99,15,0.3
,空SKU,99,15,0.3
LL-C03,售价为零,0,15,0.3
LL-C04,重量为零,99,15,0`;

describe("PricingImport · CSV 解析", () => {
  it("解析有效 CSV 返回正确行数", () => {
    const { rows, errors } = parsePricingCsv(VALID_CSV);
    expect(rows).toHaveLength(3);
    expect(errors).toHaveLength(0);
    expect(rows[0].skuKey).toBe("LL-A01");
    expect(rows[0].skuName).toBe("白色S码");
    expect(rows[0].input.salePriceThb).toBe(99);
    expect(rows[0].input.purchasePriceCny).toBe(15);
    expect(rows[0].input.weightKg).toBe(0.3);
  });

  it("可选列正确映射", () => {
    const { rows } = parsePricingCsv(CSV_WITH_OPTIONAL);
    expect(rows).toHaveLength(1);
    expect(rows[0].categoryId).toBe("501");
    expect(rows[0].activityPriceThb).toBe(79);
    expect(rows[0].input.domesticLogisticsCny).toBe(3);
    expect(rows[0].input.creatorCommissionRate).toBe(0.1);
  });

  it("缺列时抛出错误", () => {
    const bad = `SKU键,SKU名称\nLL-A01,白色`;
    expect(() => parsePricingCsv(bad)).toThrow("缺少必需列");
  });

  it("空 CSV 返回空结果", () => {
    const { rows, errors } = parsePricingCsv("");
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("只有表头返回空行", () => {
    const { rows } = parsePricingCsv("SKU键,SKU名称,售价THB,采购价CNY,重量kg");
    expect(rows).toHaveLength(0);
  });

  it("错误行收集到 errors 数组", () => {
    const { rows, errors } = parsePricingCsv(CSV_WITH_ERRORS);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(errors[0].error).toContain("SKU键为空");
    expect(errors[1].error).toContain("售价");
    expect(errors[2].error).toContain("重量");
  });

  it("生成唯一 workflowId", () => {
    const { workflowId } = parsePricingCsv(VALID_CSV);
    expect(workflowId).toMatch(/^csv-import-\d+$/);
  });

  it("BOM 头被正确处理", () => {
    const bom = `\uFEFF${VALID_CSV}`;
    const { rows } = parsePricingCsv(bom);
    expect(rows).toHaveLength(3);
  });

  it("引号包裹的字段正确解析", () => {
    const quoted = `SKU键,SKU名称,售价THB,采购价CNY,重量kg\nLL-D01,"含,逗号",99,15,0.3`;
    const { rows } = parsePricingCsv(quoted);
    expect(rows[0].skuName).toBe("含,逗号");
  });

  it("英文列名也能识别", () => {
    const en = `sku_key,sku_name,sale_price_thb,purchase_price_cny,weight_kg\nLL-E01,test,99,15,0.3`;
    const { rows } = parsePricingCsv(en);
    expect(rows).toHaveLength(1);
    expect(rows[0].skuKey).toBe("LL-E01");
  });
});

describe("PricingImport · 算价与记录构建", () => {
  it("importPricingCsv 返回完整 SkuPricingRecord", () => {
    const { records, errors } = importPricingCsv(VALID_CSV);
    expect(records).toHaveLength(3);
    expect(errors).toHaveLength(0);
    expect(records[0].id).toBeTruthy();
    expect(records[0].workflowId).toMatch(/^csv-import-/);
    expect(records[0].currency).toBe("THB");
    expect(records[0].result.expectedProfitThb).toBeDefined();
    expect(records[0].result.expectedMargin).toBeDefined();
    expect(records[0].calculatedAt).toBeTruthy();
  });

  it("活动价正确参与算价", () => {
    const { records } = importPricingCsv(CSV_WITH_OPTIONAL);
    expect(records[0].activityPriceThb).toBe(79);
    expect(records[0].result).toBeDefined();
  });

  it("fieldSources 标记数据来源", () => {
    const { records } = importPricingCsv(CSV_WITH_OPTIONAL);
    const fs = records[0].fieldSources;
    expect(fs.salePriceThb).toBe("csv");
    expect(fs.exchangeRateCnyToThb).toBe("default");
    expect(fs.taxRate).toBe("category_rule");
  });

  it("错误行不影响有效行算价", () => {
    const { records, errors } = importPricingCsv(CSV_WITH_ERRORS);
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(3);
    expect(records[0].skuKey).toBe("LL-C01");
  });

  it("未提供类目ID时使用中位数税率", () => {
    const { records } = importPricingCsv(VALID_CSV);
    expect(records[0].fieldSources.taxRate).toBe("default");
    expect(records[0].input.taxRate).toBeGreaterThan(0);
  });

  it("提供类目ID时匹配真实税率", () => {
    const { records } = importPricingCsv(CSV_WITH_OPTIONAL);
    expect(records[0].fieldSources.taxRate).toBe("category_rule");
    expect(records[0].input.taxRate).toBeGreaterThan(0);
  });
});

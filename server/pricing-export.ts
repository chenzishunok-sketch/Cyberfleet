import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SkuPricingRecord } from "../shared/contracts.ts";

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "all";
}

/** Excel worker 依赖 @oai/artifact-tool，按“当前 Node + 项目 node_modules → 专用运行时”的顺序探测可用组合 */
function resolveExcelRuntime(): { node: string; modulesDir: string } | undefined {
  const candidates = [
    { node: process.execPath, modulesDir: join(process.cwd(), "node_modules") },
    {
      node: join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node"),
      modulesDir: join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules"),
    },
  ];
  return candidates.find((candidate) => existsSync(candidate.node) && existsSync(join(candidate.modulesDir, "@oai", "artifact-tool")));
}

export function createPricingWorkbook(records: SkuPricingRecord[], history: SkuPricingRecord[], scope = "all"): string {
  const outputDir = resolve(process.cwd(), "outputs", "sku-pricing");
  const signature = createHash("sha256").update(JSON.stringify({ version: 2, records, history })).digest("hex").slice(0, 16);
  const outputPath = join(outputDir, `SKU成本利润-${safeName(scope)}-${signature}.xlsx`);
  mkdirSync(outputDir, { recursive: true });
  if (existsSync(outputPath)) return outputPath;

  const runtime = resolveExcelRuntime();
  if (!runtime) throw new Error("Excel 导出组件（@oai/artifact-tool）未安装，请改用 CSV 导出。");

  const temp = mkdtempSync(join(tmpdir(), "shop-pilot-pricing-"));
  try {
    const inputPath = join(temp, "input.json");
    const workerPath = join(temp, basename(new URL("./pricing-export-worker.mjs", import.meta.url).pathname));
    writeFileSync(inputPath, JSON.stringify({ records, history, generatedAt: new Date().toISOString() }), "utf8");
    copyFileSync(new URL("./pricing-export-worker.mjs", import.meta.url), workerPath);
    symlinkSync(runtime.modulesDir, join(temp, "node_modules"), "dir");
    const result = spawnSync(runtime.node, [workerPath, inputPath, outputPath], {
      cwd: temp,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Excel 导出失败。");
    readFileSync(outputPath);
    return outputPath;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function pricingCsv(records: SkuPricingRecord[]): string {
  const rows = [[
    "任务ID", "1688商品ID", "1688采购链接", "妙手商品ID", "TikTok商品ID", "TikTok SKU ID", "SKU键", "SKU名称", "类目ID",
    "售价THB", "活动价THB", "采购价CNY", "重量kg", "国内物流CNY", "云仓CNY", "当地配送THB", "广告THB", "达人佣金率",
    "预估成本THB", "预估利润THB", "预估利润CNY", "利润率", "保本售价THB", "结算月份", "结算销量", "TikTok实际结算THB",
    "实际物流扣费THB", "实际广告THB", "实际达人佣金THB", "实际总成本THB", "实际利润THB", "实际利润率", "计算时间",
  ], ...records.map((record) => [
    record.workflowId, record.sourceItemId ?? "", record.sourceUrl ?? "", record.platformDetailId ?? "", record.tiktokProductId ?? "", record.tiktokSkuId ?? "",
    record.skuKey, record.skuName, record.categoryId ?? "", record.input.salePriceThb, record.activityPriceThb ?? "", record.input.purchasePriceCny, record.input.weightKg,
    record.input.domesticLogisticsCny, record.input.cloudWarehouseCny, record.input.buyerLocalDeliveryThb, record.input.advertisingThb,
    record.input.creatorCommissionRate, record.result.expectedCostThb, record.result.expectedProfitThb,
    record.result.expectedProfitThb / record.input.exchangeRateCnyToThb, record.result.expectedMargin,
    record.result.breakEvenPriceThb, record.actualInput?.period ?? "", record.actualInput?.soldQuantity ?? "",
    record.actualInput?.tiktokSettlementThb ?? "", record.actualInput?.logisticsDeductionThb ?? "", record.actualInput?.advertisingThb ?? "",
    record.actualInput?.creatorCommissionThb ?? "", record.actualResult?.actualCostThb ?? "", record.actualResult?.actualProfitThb ?? "",
    record.actualResult?.actualMargin ?? "", record.calculatedAt,
  ])];
  const cell = (value: unknown) => `"${String(value).replace(/"/g, '""')}"`;
  return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\n")}`;
}

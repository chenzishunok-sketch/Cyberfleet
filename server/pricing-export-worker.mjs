import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("缺少导出输入或输出路径。");
const { records, history, generatedAt } = JSON.parse(await fs.readFile(inputPath, "utf8"));
const workbook = Workbook.create();
const sheet = workbook.worksheets.add("SKU成本利润");
const headers = [
  "计算时间", "任务ID", "1688商品ID", "1688采购链接", "妙手商品ID", "店铺ID", "SKU键", "SKU名称", "类目ID", "类目名称",
  "售价THB", "采购价CNY", "汇率", "重量kg", "国内物流CNY", "云仓CNY", "当地配送THB", "广告THB", "达人佣金率",
  "综合税率", "平台佣金率", "跨境费/10g", "交易费率", "基础设施费THB", "增长支持费率", "商家折扣THB", "平台补贴THB", "活动费THB",
  "采购成本THB", "国内物流THB", "云仓THB", "跨境物流THB", "预估收入THB", "税前商品收入THB", "平台佣金THB", "交易费THB",
  "增长支持费THB", "税费THB", "达人佣金THB", "预估总成本THB", "预估利润THB", "利润率", "保本售价THB", "状态", "TikTok商品ID", "TikTok SKU ID",
  "结算月份", "结算销量", "TikTok实际结算THB", "实际物流扣费THB", "实际广告THB", "实际达人佣金THB",
  "实际基础成本THB", "实际总成本THB", "实际利润THB", "实际利润率", "实际状态", "活动价THB", "预估利润CNY",
];
sheet.getRange(`A1:BG${Math.max(records.length + 1, 2)}`).clear({ contents: true });
sheet.getRange("A1:BG1").values = [headers];
if (records.length) {
  const inputRows = records.map((record) => {
    const i = record.input;
    return [
      record.calculatedAt, record.workflowId, record.sourceItemId ?? "", record.sourceUrl ?? "", record.platformDetailId ?? "", record.shopId ?? "",
      record.skuKey, record.skuName, record.categoryId ?? "", record.categoryName ?? "", i.salePriceThb, i.purchasePriceCny,
      i.exchangeRateCnyToThb, i.weightKg, i.domesticLogisticsCny, i.cloudWarehouseCny, i.buyerLocalDeliveryThb,
      i.advertisingThb, i.creatorCommissionRate, i.taxRate, i.categoryCommissionRate, i.crossBorderThbPer10g,
      i.transactionRate, i.infrastructureFeeThb, i.growthSupportRate, i.merchantDiscountThb, i.platformSubsidyThb,
      i.platformActivityFeeThb,
    ];
  });
  sheet.getRange(`A2:AB${records.length + 1}`).values = inputRows;
  const formulas = records.map((_record, index) => {
    const row = index + 2;
    return [
      `=L${row}*M${row}`,
      `=O${row}*M${row}`,
      `=P${row}*M${row}`,
      `=N${row}*1000/10*V${row}`,
      `=IF(BF${row}<>"",BF${row},K${row})-Z${row}+AA${row}+Q${row}`,
      `=(IF(BF${row}<>"",BF${row},K${row})-Z${row}+AA${row})/(1+T${row})`,
      `=AH${row}*U${row}`,
      `=AG${row}*W${row}`,
      `=AH${row}*Y${row}`,
      `=AH${row}*T${row}`,
      `=AH${row}*S${row}`,
      `=SUM(AC${row}:AF${row})+Q${row}+AI${row}+AJ${row}+X${row}+AK${row}+AL${row}+R${row}+AM${row}+AB${row}`,
      `=AG${row}-AN${row}`,
      `=IFERROR(AO${row}/AG${row},0)`,
      `=MAX(0,((AC${row}+AD${row}+AE${row}+AF${row}+Q${row}+X${row}+R${row}+AB${row})-(-Z${row}+AA${row})*(1-W${row}-(U${row}+Y${row}+T${row}+S${row})/(1+T${row}))-Q${row}*(1-W${row}))/(1-W${row}-(U${row}+Y${row}+T${row}+S${row})/(1+T${row})))`,
      `=IF(AO${row}>=0,"盈利","亏损")`,
    ];
  });
  sheet.getRange(`AC2:AR${records.length + 1}`).formulas = formulas;
  sheet.getRange(`AS2:AT${records.length + 1}`).values = records.map((record) => [record.tiktokProductId ?? "", record.tiktokSkuId ?? ""]);
  sheet.getRange(`AU2:AZ${records.length + 1}`).values = records.map((record) => [
    record.actualInput?.period ?? "", record.actualInput?.soldQuantity ?? "", record.actualInput?.tiktokSettlementThb ?? "",
    record.actualInput?.logisticsDeductionThb ?? "", record.actualInput?.advertisingThb ?? "", record.actualInput?.creatorCommissionThb ?? "",
  ]);
  sheet.getRange(`BA2:BE${records.length + 1}`).formulas = records.map((_record, index) => {
    const row = index + 2;
    return [
      `=IF(OR(AV${row}="",AW${row}="",AX${row}=""),"",(AC${row}+AD${row}+AE${row})*AV${row})`,
      `=IF(BA${row}="","",BA${row}+AX${row}+AY${row}+AZ${row})`,
      `=IF(BB${row}="","",AW${row}-BB${row})`,
      `=IF(BC${row}="","",IFERROR(BC${row}/AW${row},0))`,
      `=IF(BC${row}="","待录入",IF(BC${row}>=0,"盈利","亏损"))`,
    ];
  });
  sheet.getRange(`BF2:BF${records.length + 1}`).values = records.map((record) => [record.activityPriceThb ?? ""]);
  sheet.getRange(`BG2:BG${records.length + 1}`).formulas = records.map((_record, index) => {
    const row = index + 2;
    return [`=IF(AO${row}="","",AO${row}/M${row})`];
  });
}
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:BG1").format = { fill: "#17695F", font: { bold: true, color: "#FFFFFF" }, rowHeight: 28 };
sheet.getRange(`A2:BG${Math.max(records.length + 1, 2)}`).format.rowHeight = 22;
sheet.getRange(`A2:A${Math.max(records.length + 1, 2)}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
sheet.getRange(`C2:C${Math.max(records.length + 1, 2)}`).format.numberFormat = "0";
sheet.getRange(`E2:E${Math.max(records.length + 1, 2)}`).format.numberFormat = "0";
sheet.getRange(`K2:K${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange(`L2:R${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange(`S2:U${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00%";
sheet.getRange(`V2:X${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange(`Y2:Y${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00%";
sheet.getRange(`Z2:AQ${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange(`AP2:AP${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00%";
sheet.getRange(`AS2:AT${Math.max(records.length + 1, 2)}`).format.numberFormat = "0";
sheet.getRange(`AV2:AV${Math.max(records.length + 1, 2)}`).format.numberFormat = "0";
sheet.getRange(`AW2:BC${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange(`BD2:BD${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00%";
sheet.getRange(`BF2:BG${Math.max(records.length + 1, 2)}`).format.numberFormat = "0.00";
sheet.getRange("A:A").format.columnWidth = 20;
sheet.getRange("B:C").format.columnWidth = 17;
sheet.getRange("D:D").format.columnWidth = 38;
sheet.getRange("E:F").format.columnWidth = 17;
sheet.getRange("G:G").format.columnWidth = 26;
sheet.getRange("H:AR").format.columnWidth = 14;
sheet.getRange("AS:AT").format.columnWidth = 20;
sheet.getRange("AU:BG").format.columnWidth = 16;

const historySheet = workbook.worksheets.add("定价历史");
historySheet.getRange("A1:L1").values = [["计算时间", "任务ID", "1688商品ID", "妙手商品ID", "SKU键", "SKU名称", "售价THB", "活动价THB", "预估利润THB", "预估利润CNY", "利润率", "数据来源"]];
if (history.length) historySheet.getRange(`A2:L${history.length + 1}`).values = history.map((record) => [
  record.calculatedAt, record.workflowId, record.sourceItemId ?? "", record.platformDetailId ?? "", record.skuKey,
  record.skuName, record.input.salePriceThb, record.activityPriceThb ?? "", record.result.expectedProfitThb,
  record.result.expectedProfitThb / record.input.exchangeRateCnyToThb, record.result.expectedMargin,
  Object.entries(record.fieldSources).map(([field, source]) => `${field}:${source}`).join("; "),
]);
historySheet.freezePanes.freezeRows(1);
historySheet.getRange("A1:L1").format = { fill: "#2E3236", font: { bold: true, color: "#FFFFFF" }, rowHeight: 28 };
historySheet.getRange("A:A").format.columnWidth = 20;
historySheet.getRange("B:F").format.columnWidth = 20;
historySheet.getRange("L:L").format.columnWidth = 48;
historySheet.getRange(`G2:J${Math.max(history.length + 1, 2)}`).format.numberFormat = "0.00";
historySheet.getRange(`K2:K${Math.max(history.length + 1, 2)}`).format.numberFormat = "0.00%";
historySheet.getRange(`A2:A${Math.max(history.length + 1, 2)}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
historySheet.getRange(`C2:D${Math.max(history.length + 1, 2)}`).format.numberFormat = "0";

const notes = workbook.worksheets.add("口径说明");
notes.getRange("A1:B12").values = [
  ["项目", "说明"],
  ["导出时间", generatedAt],
  ["利润类型", "预估利润与实际利润分开记录；实际利润按 TikTok 结算金额减采购、国内物流、云仓、实际物流、广告和达人佣金计算。"],
  ["当地配送", "默认 79 THB/件，可在项目卡片修改。"],
  ["国内物流", "默认 2.5 CNY/件，可修改。"],
  ["云仓", "默认 1.5 CNY/件，可修改。"],
  ["广告", "默认 0 THB/件，保留手工填写入口。"],
  ["达人佣金", "默认 0%，保留手工填写入口。"],
  ["税率", "优先按 TikTok 叶子类目 ID 匹配最新版泰国综合税率表。"],
  ["平台佣金", "优先按叶子类目名称和完整路径匹配 NonMall 佣金表。"],
  ["采购价和重量", "优先从妙手采集箱关联的 1688 SKU 自动取得。"],
  ["保本售价", "使预估利润等于 0 的理论售价；实际经营建议保留风险余量。"],
];
notes.getRange("A1:B1").format = { fill: "#17695F", font: { bold: true, color: "#FFFFFF" }, rowHeight: 28 };
notes.getRange("A:A").format.columnWidth = 18;
notes.getRange("B:B").format.columnWidth = 72;
notes.getRange("A2:A12").format.font = { bold: true, color: "#3E4549" };
notes.getRange("B2:B12").format.wrapText = true;
notes.getRange("B2").format.numberFormat = "yyyy-mm-dd hh:mm:ss";

await fs.mkdir(new URL(".", `file://${outputPath}`).pathname, { recursive: true }).catch(() => undefined);
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, recordCount: records.length, historyCount: history.length }));

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { findFirstEmptyRow, writePricingRow } from "./feishu-sheets.ts";

/**
 * 发布完成 → 自动重新定价（算成本 → 写飞书总表 V/Y）。
 *
 * 定价算价复用项目内 scripts/tmap_pricing.py（TMAP 抓 1688 详情 → 算成本 → 生成 V/Y 载荷），
 * 飞书写入复用 feishu-sheets.ts 的 writePricingRow（lark-cli --as bot 复制样式 + 写入 + 校验）。
 *
 * 触发：发布核验成功拿到 TikTok 商品 ID 后，自动为对应 1688 商品算价并写进飞书总表，
 * 供下一步「按 V 定价报名秒杀」读取。
 */

export interface PricingAutostartResult {
  priced: boolean;
  reason?: string;
  feishuRow?: number;
  priceJpy?: number;
  originalPriceJpy?: number;
  category?: string;
  formulaStatus?: string;
  formulaErrors?: number;
}

/** 定价脚本路径（复制进项目内，随项目走，避免依赖工作区外部 skill 目录） */
function pricingScriptPath(): string {
  // scripts/tmap_pricing.py，相对项目根（process.cwd() 即 Cyberfleet 根）
  return join(process.cwd(), "scripts", "tmap_pricing.py");
}

/** 从定价脚本 run 输出的 JSON 里提取 V/Y（脚本把算价结果打印到 stdout 末尾的 JSON） */
function extractPriceFromScriptOutput(stdout: string): { priceJpy?: number; originalPriceJpy?: number } {
  // 脚本 stdout 最后一段是一个 JSON 对象，含 calc.V / calc.Y
  try {
    const obj = JSON.parse(stdout.trim().split("\n载荷已生成")[0].trim()) as { calc?: { V?: number; Y?: number } };
    return { priceJpy: obj.calc?.V, originalPriceJpy: obj.calc?.Y };
  } catch {
    return {};
  }
}

/**
 * 从商品标题关键词推断飞书 C 列的类目中文名（发布流程只有类目 ID，没有中文名）。
 * 推断失败返回空串，C 列留空由用户在飞书里补，不影响定价计算。
 */
export function inferCategoryFromTitle(title: string | undefined): string {
  if (!title) return "";
  const t = title;
  if (/宠物|猫|狗|猫粮|狗粮|猫砂|猫窝|鱼缸|仓鼠|鸟笼/.test(t)) return "宠物用品";
  if (/床|被|枕|四件套|毛毯|地毯|毛巾|浴巾|窗帘|沙发|靠垫|地垫/.test(t)) return "家纺布艺";
  if (/袜|手套|帽|围巾|发饰|耳环|项链|手链|胸针|发夹|腰带/.test(t)) return "服饰配件";
  if (/收纳|置物|挂钩|垃圾桶|厨房|餐具|水杯|保鲜盒|饭盒/.test(t)) return "家居日用";
  return "";
}

/**
 * 发布后自动定价：抓 1688 详情算成本，把 V（定价）/Y（原价）写进飞书总表首个空白行。
 * 失败不抛错（发布已成功，定价是附加步骤），原因带进返回值。
 */
export async function autostartPricingAfterPublish(input: {
  sourceUrl?: string;
  productTitle?: string;
  category?: string;
  goodsType?: "普货" | "特货";
  /** 发布流程里已知的包裹尺寸（长宽高 cm），TMAP 详情缺尺寸时用作兜底 */
  packageDimensions?: { length: number; width: number; height: number };
  /** 发布流程里已知的实重（kg），TMAP 详情缺重量时用作兜底 */
  weightKg?: number;
}): Promise<PricingAutostartResult> {
  const { sourceUrl, productTitle, goodsType } = input;
  if (!sourceUrl) return { priced: false, reason: "发布任务没有 1688 链接，无法自动定价。" };
  // 类目名：显式传入优先，否则从商品标题关键词推断；推断不出留空（不影响定价计算）
  const category = input.category || inferCategoryFromTitle(productTitle);

  // 1) 查首个空白行
  let row: number;
  try {
    row = findFirstEmptyRow();
  } catch (error) {
    return { priced: false, reason: `查飞书空白行失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 2) 跑定价脚本生成载荷（临时文件）；发布流程已知尺寸时传给 --size 兜底
  // 注意：1×1×1 是采集箱发布的占位尺寸，不是真实尺寸，不能传
  const payloadPath = join(process.cwd(), ".data", `tmap_writes_row${row}.json`);
  const dims = input.packageDimensions;
  const dimsValid = Boolean(dims
    && [dims.length, dims.width, dims.height].every((v) => Number.isFinite(v) && v > 0)
    && Math.max(dims!.length, dims!.width, dims!.height) > 2);
  const sizeArg = dimsValid && dims ? `${dims.length}*${dims.width}*${dims.height}` : "";
  const weight = input.weightKg;
  const weightArg = weight && Number.isFinite(weight) && weight > 0 ? String(weight) : "";
  let stdout = "";
  try {
    stdout = execFileSync(
      "python3",
      ["scripts/tmap_pricing.py", "run", "--url", sourceUrl, "--row", String(row),
        ...(category ? ["--category", category] : []),
        ...(sizeArg ? ["--size", sizeArg] : []),
        ...(weightArg ? ["--weight", weightArg] : []),
        "--goods-type", goodsType ?? "普货",
        "--output", payloadPath],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (error) {
    return { priced: false, reason: `定价脚本执行失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 3) 读取生成的载荷并写入飞书
  const { readFileSync } = await import("node:fs");
  let writes: Array<Record<string, unknown>>;
  try {
    writes = JSON.parse(readFileSync(payloadPath, "utf8")) as Array<Record<string, unknown>>;
  } catch (error) {
    return { priced: false, reason: `读取定价载荷失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(writes) || !writes.length) {
    return { priced: false, reason: "定价脚本没有生成有效写入载荷。" };
  }

  const { priceJpy, originalPriceJpy } = extractPriceFromScriptOutput(stdout);

  try {
    const result = writePricingRow(row, writes as never[]);
    if (result.failed > 0) {
      return { priced: false, reason: `飞书写入部分失败（${result.failed}/${result.succeeded + result.failed}），请检查飞书表格。` };
    }
    return {
      priced: true,
      feishuRow: row,
      priceJpy,
      originalPriceJpy,
      category: category || "",
      formulaStatus: result.formulaStatus,
      formulaErrors: result.formulaErrors,
    };
  } catch (error) {
    return { priced: false, reason: `写飞书定价失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

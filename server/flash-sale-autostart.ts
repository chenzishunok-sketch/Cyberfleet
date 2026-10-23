import { extract1688ItemId, readPricingRowByItemId } from "./feishu-sheets.ts";
import { startFlashSaleWorkflow } from "./flash-sale-workflow.ts";

/**
 * 发布完成 → 自动报名秒杀 的衔接逻辑。
 *
 * 闭环：发布流程核验成功拿到 TikTok 商品 ID（PID）后，自动：
 *   1. 从发布任务的 1688 链接提取 item_id；
 *   2. 读飞书定价总表，找到 B 列 = item_id 的行；
 *   3. 取该行 V 列（定价）当秒杀价、Y 列（商品原价）当划线价（用于校验/提示）；
 *   4. 用 PID + V 定价报名 TikTok 秒杀活动，时间 = 日本当下时间 + 3 分钟。
 */

/** 报名秒杀的活动持续时间（分钟），开始 = 当下 + startDelay，结束 = 开始 + duration */
const START_DELAY_MIN = 3;
const DURATION_MIN = 60;

/** 秒杀默认限购：库存 -1（不限）、每人 -1（不限），沿用秒杀引擎默认口径 */
const SKU_QUANTITY_LIMIT = -1;
const QUANTITY_PER_USER = -1;

/**
 * 「日本当下时间 + startDelay 分钟」对应的绝对时刻。
 * 时间戳是绝对时刻、与时区无关：日本当地「现在」与服务器「现在」是同一时刻，
 * 因此直接用 Date.now() 加偏移即可，无需再叠加时区偏移。
 */
export function startAfterNow(startDelayMin: number, nowMs: number = Date.now()): Date {
  const d = new Date(nowMs);
  d.setMinutes(d.getMinutes() + startDelayMin);
  return d;
}

export interface FlashSaleAutostartResult {
  started: boolean;
  reason?: string;
  flashSaleRunId?: string;
  priceJpy?: number;
  originalPriceJpy?: number;
  feishuRow?: number;
  startAt?: string;
  endAt?: string;
}

/**
 * 发布完成后自动报名秒杀。失败不抛错（发布本身已成功，秒杀报名是附加步骤），
 * 把原因带进返回值，由调用方决定如何呈现。
 */
export async function autostartFlashSaleAfterPublish(input: {
  tiktokProductId: string;
  sourceUrl?: string;
  shopName?: string;
}): Promise<FlashSaleAutostartResult> {
  const { tiktokProductId, sourceUrl } = input;
  if (!tiktokProductId) return { started: false, reason: "没有拿到 TikTok 商品 ID，无法报名秒杀。" };
  if (!sourceUrl) return { started: false, reason: "发布任务没有 1688 链接，无法定位飞书定价行。" };

  const itemId = extract1688ItemId(sourceUrl);
  if (!itemId) return { started: false, reason: "无法从 1688 链接提取商品编号，跳过秒杀报名。" };

  let pricing;
  try {
    pricing = readPricingRowByItemId(itemId);
  } catch (error) {
    return { started: false, reason: `读取飞书定价表失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!pricing) {
    return { started: false, reason: `飞书定价表里没有找到商品 ${itemId} 对应的行，跳过秒杀报名。` };
  }
  if (!pricing.priceJpy || pricing.priceJpy <= 0) {
    return { started: false, reason: `飞书定价表第 ${pricing.row} 行定价（V 列）为空或无效，跳过秒杀报名。` };
  }

  const start = startAfterNow(START_DELAY_MIN);
  const end = new Date(start.getTime() + DURATION_MIN * 60 * 1000);

  const startAt = start.toISOString();
  const endAt = end.toISOString();
  const priceAmount = String(pricing.priceJpy);

  try {
    const run = await startFlashSaleWorkflow({
      productId: tiktokProductId,
      activityTitle: `秒杀-${itemId.slice(-6)}-${Date.now().toString().slice(-6)}`,
      startAt,
      endAt,
      priceAmount,
      currency: "JPY",
      skuQuantityLimit: SKU_QUANTITY_LIMIT,
      quantityPerUser: QUANTITY_PER_USER,
    });
    return {
      started: true,
      flashSaleRunId: run.id,
      priceJpy: pricing.priceJpy,
      originalPriceJpy: pricing.originalPriceJpy,
      feishuRow: pricing.row,
      startAt,
      endAt,
    };
  } catch (error) {
    return { started: false, reason: `报名秒杀失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

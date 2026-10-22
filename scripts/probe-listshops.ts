/**
 * 只读探针：直接调用上架工作流的 listShops()，核对 OAuth 店铺与妙手店铺的映射结果。
 * 用法：npx tsx scripts/probe-listshops.ts
 */
import { loadEnvFile } from "node:process";
loadEnvFile();

import { realProductPublishWorkflowTools } from "../server/product-publish-workflow.ts";

async function main() {
  const shops = await realProductPublishWorkflowTools.listShops();
  console.log(`listShops() 返回 ${shops.length} 家：`);
  for (const shop of shops) {
    console.log("  " + JSON.stringify(shop));
  }

  const cashio = shops.find((shop) => shop.name === "Cashio" || shop.site === "JP");
  console.log("\nCashio 条目:", JSON.stringify(cashio));
  console.log("miaoshouShopId =", JSON.stringify(cashio?.miaoshouShopId), "（期望 8536938）");
  console.log(
    cashio?.miaoshouShopId
      ? "✅ listShops 能解析出妙手店铺 ID"
      : "❌ listShops 未能解析出妙手店铺 ID —— 这就是 claim 步骤拿不到数字 ID 的源头",
  );
}

main().catch((error) => {
  console.error("探测中断:", error);
  process.exit(1);
});

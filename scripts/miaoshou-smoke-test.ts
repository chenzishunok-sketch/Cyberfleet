import { loadEnvFile } from "node:process";
loadEnvFile();

import {
  hasMiaoshouConfiguration,
  miaoshouFetchItem,
  miaoshouWaitForCollection,
  miaoshouGetCommonCollectBoxList,
  miaoshouClaimToPlatform,
  miaoshouGetTikTokCollectBoxList,
  miaoshouGetShopList,
  miaoshouAiMatchCategory,
  miaoshouAiMatchAttribute,
  miaoshouTranslateItem,
  miaoshouAiGenerateProductInfo,
  miaoshouClaimToShop,
  miaoshouPublishToTikTok,
  miaoshouGetPublishRecords,
} from "../server/miaoshou-client.ts";

const URL_1688 = "https://detail.1688.com/offer/1033835549328.html";
const STEP = (n: string, msg: string) => console.log(`\n===== 步骤${n}: ${msg} =====`);

function snap(obj: unknown, max = 600): string {
  try {
    return JSON.stringify(obj).slice(0, max);
  } catch {
    return String(obj).slice(0, max);
  }
}

async function main() {
  console.log("配置检查: hasMiaoshouConfiguration =", hasMiaoshouConfiguration());

  // 步骤0：读取已授权店铺（拿到发布目标 shopId）
  STEP("0", "读取已授权店铺 + TK采集箱（只读）");
  const shopRes = await miaoshouGetShopList("tiktok", "all");
  const shopList = (shopRes.data as { shopList?: Array<Record<string, unknown>> }).shopList ?? [];
  console.log("店铺列表:", snap(shopList, 800));
  if (!shopList.length) throw new Error("妙手未授权任何 TikTok 店铺，无法发布。");
  const shopId = Number(shopList[0].shopId);
  const shopName = String(shopList[0].shopNick ?? shopList[0].shopName ?? "");
  console.log(`选定目标店铺: shopId=${shopId} name=${shopName}`);

  // 步骤1：采集
  STEP("1", `采集 1688: ${URL_1688}`);
  const fetchRes = await miaoshouFetchItem(URL_1688, "1688");
  console.log("fetch_item 返回:", snap(fetchRes, 500));
  const map = ((fetchRes.data as Record<string, unknown>)?.sourceItemIdAndDetailIdMap ?? {}) as Record<string, unknown>;
  const sourceIds = Object.keys(map);
  console.log("sourceIds:", sourceIds, "detailMap:", snap(map, 300));
  if (!sourceIds.length) throw new Error("采集未返回 sourceItemIdAndDetailIdMap，可能链接无效或采集失败。");

  // 等待采集入库
  const wait = await miaoshouWaitForCollection(sourceIds, 40000, 3000);
  console.log("wait_for_collection:", snap(wait, 400));
  const commonDetailId = Number(wait.find((w) => w.detailId)?.detailId ?? map[sourceIds[0]] ?? 0);
  if (!commonDetailId) throw new Error("采集后未在公共采集箱找到 detailId。");
  console.log("公共采集箱 detailId =", commonDetailId);

  // 步骤2：认领到 TK 平台采集箱
  STEP("2", `认领到 TikTok 采集箱 (detailId=${commonDetailId})`);
  const claimRes = await miaoshouClaimToPlatform([commonDetailId], "tiktok", 1);
  console.log("claim_to_platform 返回:", snap(claimRes, 500));
  const platformMap = ((claimRes.data as Record<string, unknown>)?.platformCollectBoxDetailIdMap ?? {}) as Record<string, Record<string, unknown>>;
  const tkMap = platformMap["tiktok"] ?? {};
  const platformDetailId = Number(tkMap[String(commonDetailId)] ?? 0);
  console.log("TK 采集箱 platformDetailId =", platformDetailId);
  if (!platformDetailId) {
    // 兜底：从 TK 采集箱列表找最近一条
    const tkBox = await miaoshouGetTikTokCollectBoxList(1, 5);
    const list = (tkBox.data as { detailList?: Array<Record<string, unknown>> }).detailList ?? [];
    console.log("TK采集箱列表前5:", snap(list, 500));
    const found = list[0];
    if (found) {
      const alt = Number(found.collectBoxDetailId ?? found.detail_id ?? 0);
      if (alt) console.log("兜底使用 TK 采集箱 detailId =", alt);
    }
  }

  // 步骤3：补充信息（AI 类目匹配 / 属性 / 翻译 / AI生成标题描述）
  // 这几步在对话场景里未被接入，此处直接调用 API 验证可用性
  STEP("3", "补充信息：AI 类目匹配 / 翻译 / AI 生成标题描述");
  const itemId = String(platformDetailId || commonDetailId);
  console.log("使用 item_id =", itemId);
  try {
    const aim = await miaoshouAiMatchCategory([itemId], [String(shopId)]);
    console.log("[3a] ai_match_category OK:", snap(aim, 500));
    const aimData = aim.data as Record<string, unknown> | undefined;
    const cid = String((aimData as { category_id?: string; cid?: string })?.category_id ?? (aimData as { cid?: string })?.cid ?? "");
    if (cid) {
      try {
        const aam = await miaoshouAiMatchAttribute(itemId, cid);
        console.log("[3b] ai_match_attribute OK:", snap(aam, 400));
      } catch (e) {
        console.log("[3b] ai_match_attribute 失败:", (e as Error).message);
      }
    }
  } catch (e) {
    console.log("[3a] ai_match_category 失败:", (e as Error).message);
  }
  try {
    const tr = await miaoshouTranslateItem(itemId, "th");
    console.log("[3c] translate OK:", snap(tr, 400));
  } catch (e) {
    console.log("[3c] translate 失败:", (e as Error).message);
  }
  try {
    const gi = await miaoshouAiGenerateProductInfo(itemId, "th");
    console.log("[3d] ai_generate_product_info OK:", snap(gi, 500));
  } catch (e) {
    console.log("[3d] ai_generate_product_info 失败:", (e as Error).message);
  }

  // 步骤4：发布上架（先认领到店铺，再发布）
  const pubId = platformDetailId || commonDetailId;
  STEP("4", `发布到 TikTok 店铺 (detailId=${pubId}, shopId=${shopId})`);
  try {
    const cs = await miaoshouClaimToShop([pubId], [shopId]);
    console.log("[4a] claim_to_shop 返回:", snap(cs, 400));
  } catch (e) {
    console.log("[4a] claim_to_shop 失败:", (e as Error).message);
  }
  try {
    const pb = await miaoshouPublishToTikTok([pubId], [shopId]);
    console.log("[4b] publish_to_tiktok 返回:", snap(pb, 500));
    const pSuccess = ((pb.data as Record<string, unknown>)?.result ?? pb.result) === "success";
    console.log("发布结果:", pSuccess ? "成功" : "需检查");
  } catch (e) {
    console.log("[4b] publish_to_tiktok 失败:", (e as Error).message);
  }

  // 步骤5：查发布记录确认
  STEP("5", "查发布记录确认");
  try {
    const rec = await miaoshouGetPublishRecords(1, 5);
    console.log("发布记录:", snap(rec, 600));
  } catch (e) {
    console.log("发布记录查询失败:", (e as Error).message);
  }

  console.log("\n===== 全链路执行完毕 =====");
}

main().catch((e) => {
  console.error("\n全链路中断:", e?.message ?? e);
  process.exit(1);
});

/**
 * 只读探针：核实某个 1688 货源商品在妙手公共采集箱中的真实状态。
 *
 * 背景：product_publish 工作流的 collect 步骤历史上把「已采集过（skip）」误判成
 * 「尚未进入公共采集箱」，理由是旧的探测逻辑只拉公共采集箱第 1 页且只认
 * success/collectsuccess 两个枚举；而妙手对重复采集的链接只产出一条
 * status="skip"、"不含 payload" 的行。
 *
 * 本脚本只调用 list 类只读接口，不采集、不认领、不发布。
 * 用法：npx tsx scripts/probe-collect-box.ts [sourceItemId]
 */
import { loadEnvFile } from "node:process";
loadEnvFile();

import {
  hasMiaoshouConfiguration,
  miaoshouGetCommonCollectBoxList,
  miaoshouWaitForCollection,
  miaoshouGetTikTokCollectBoxList,
} from "../server/miaoshou-client.ts";

const DEFAULT_SOURCE_ITEM_ID = "989886496136";
const sourceItemId = process.argv[2] ?? DEFAULT_SOURCE_ITEM_ID;

function head(label: string) {
  console.log(`\n===== ${label} =====`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 妙手对同账户有每秒请求频率限制，且频率超限返回的是「业务错误」，
 * 请求层不会重试。探测时按固定间隔排队，并对频率超限做退避重试。
 */
async function paced<T>(label: string, fn: () => Promise<T>, minGapMs = 2_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - started;
      if (elapsed < minGapMs) await sleep(minGapMs - elapsed);
      return result;
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("频率超限") && attempt <= 5) {
        const wait = 3_000 * attempt;
        console.log(`  ⏳ ${label} 命中频率限制，${wait}ms 后重试（第 ${attempt} 次）`);
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }
}

/** 打印列表里每行的关键字段，不做任何过滤，方便看清真实枚举 */
function dumpRows(list: Array<Record<string, unknown>>) {
  if (!list.length) {
    console.log("  （空列表）");
    return;
  }
  list.forEach((item, i) => {
    const sourceList = item.sourceList as Array<Record<string, unknown>> | undefined;
    const sourceIds = (sourceList ?? []).map((s) => String(s.sourceItemId ?? "")).filter(Boolean);
    console.log(
      `  [${i}] status=${JSON.stringify(item.status ?? item.collectStatus)}` +
        ` detailId=${item.commonCollectBoxDetailId ?? item.detail_id ?? item.id ?? "-"}` +
        ` item_id=${item.item_id ?? "-"}` +
        ` sourceItemIds=${sourceIds.length ? sourceIds.join(",") : "-"}` +
        (item.reason ? ` reason=${JSON.stringify(item.reason)}` : ""),
    );
  });
}

async function main() {
  console.log("配置检查: hasMiaoshouConfiguration =", hasMiaoshouConfiguration());
  console.log("目标货源编号:", sourceItemId);

  // ① 不加过滤，看第一页原始数据 —— 确认真实 status 枚举长什么样
  head("① 公共采集箱第 1 页（无过滤，观察真实枚举）");
  const all = await paced("①", () => miaoshouGetCommonCollectBoxList(1, 20));
  const allData = all.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
  const allList = allData?.detailList ?? allData?.list ?? [];
  console.log("  total =", allData?.total ?? "(未返回)");
  dumpRows(allList);
  const statuses = new Set(allList.map((i) => String(i.status ?? i.collectStatus ?? "")));
  console.log("  本页出现的 status 取值:", [...statuses].map((s) => JSON.stringify(s)).join(" ") || "(无)");

  // ② 服务端按货源编号过滤 —— 这是修复后的新路径
  head(`② 按货源编号过滤查询（修复后的新路径）sourceItemIdKeyword=${sourceItemId}`);
  const filtered = await paced("②", () => miaoshouGetCommonCollectBoxList(1, 20, sourceItemId));
  const fData = filtered.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
  const fList = fData?.detailList ?? fData?.list ?? [];
  console.log("  total =", fData?.total ?? "(未返回)");
  dumpRows(fList);

  // ③ 走修复后的等待函数 —— 观察它到底认不认这些行
  head("③ miaoshouWaitForCollection(sourceItemId, 20s, 3s) —— 上线后的真实判定");
  const started = Date.now();
  const wait = await miaoshouWaitForCollection([sourceItemId], 20_000, 3_000);
  console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("  返回值:", JSON.stringify(wait));
  const hit = wait.find((w) => w.sourceItemId === sourceItemId && w.detailId);
  console.log("  判定:", hit ? `✅ 可直接复用，detailId=${hit.detailId}（无需重新采集）` : "❌ 未找到可复用记录，旧逻辑会继续走到重新采集");

  // ④ 顺带看一眼 TK 平台采集箱，确认有没有残留的认领记录
  head("④ TikTok 采集箱（只读，确认是否有残留）");
  try {
    const tk = await paced("④", () => miaoshouGetTikTokCollectBoxList(1, 10));
    const tData = tk.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>>; total?: number } | undefined;
    const tList = tData?.detailList ?? tData?.list ?? [];
    console.log("  total =", tData?.total ?? "(未返回)");
    tList.forEach((item, i) => {
      console.log(
        `  [${i}] status=${JSON.stringify(item.status)}` +
          ` collectBoxDetailId=${item.collectBoxDetailId ?? item.detail_id ?? "-"}` +
          ` title=${String(item.title ?? item.productTitle ?? "").slice(0, 40)}`,
      );
    });
    if (!tList.length) console.log("  （TK 采集箱为空）");
  } catch (e) {
    console.log("  查询失败:", (e as Error).message);
  }

  // ⑤ 复现「修复前」的探测逻辑，验证它今天还会不会漏判
  head("⑤ 复现修复前的探测逻辑（同上第 1 页 size=50，本地扫描）");
  {
    const legacy = await paced("⑤", () => miaoshouGetCommonCollectBoxList(1, 50));
    const lData = legacy.data as { detailList?: Array<Record<string, unknown>>; list?: Array<Record<string, unknown>> } | undefined;
    const lList = lData?.detailList ?? lData?.list ?? [];
    console.log("  实际返回行数 =", lList.length);
    let hitIndex = -1;
    let hitDetailId = "";
    lList.forEach((item, index) => {
      const collectionStatus = String(item.status ?? item.collectStatus ?? "").trim().toLowerCase();
      if (collectionStatus !== "success" && collectionStatus !== "collectsuccess") return;
      const detailId = String(item.commonCollectBoxDetailId ?? item.detail_id ?? item.id ?? "");
      const sourceList = item.sourceList as Array<Record<string, unknown>> | undefined;
      const fromList = sourceList?.map((s) => String(s.sourceItemId ?? "").trim()).filter(Boolean) ?? [];
      const itemId = String(item.item_id ?? item.sourceItemId ?? "");
      const matched =
        (itemId.trim() && itemId.trim() === sourceItemId.trim()) ||
        fromList.some((sid) => sid === sourceItemId.trim());
      if (matched && hitIndex < 0) {
        hitIndex = index;
        hitDetailId = detailId;
      }
    });
    console.log(
      hitIndex >= 0
        ? `  旧逻辑命中位置 = 第 ${hitIndex} 行，detailId=${hitDetailId} → 说明今天旧逻辑也不会漏判`
        : "  旧逻辑未命中 → 说明第 1 页确实不含目标 success 行",
    );
  }

  console.log("\n===== 只读探测完毕（未做任何采集/认领/发布）=====");
}

main().catch((e) => {
  console.error("\n探测中断:", e?.message ?? e);
  process.exit(1);
});

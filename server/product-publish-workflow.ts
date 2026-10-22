import { randomUUID } from "node:crypto";
import type {
  ProductPublishWorkflowRun,
  WorkflowShopOption,
  WorkflowStep,
} from "../shared/contracts.ts";
import { PRIMARY_LANGUAGE, PRIMARY_SITE, languageForSite } from "./tiktok-sites.ts";
import {
  hasMiaoshouConfiguration,
  miaoshouAiGenerateProductInfo,
  miaoshouAiMatchAttribute,
  miaoshouAiMatchCategory,
  miaoshouClaimToPlatform,
  miaoshouClaimToShop,
  miaoshouFetchItem,
  miaoshouGetPublishRecords,
  miaoshouGetShopList,
  miaoshouGetShopWarehouseList,
  miaoshouResolveSite,
  miaoshouGetTikTokCollectBoxList,
  miaoshouGetTikTokCategoryMetadata,
  miaoshouGetTikTokShopCollectItemInfo,
  miaoshouPublishToTikTok,
  miaoshouSaveTikTokShopCollectItemInfo,
  miaoshouTranslateItem,
  miaoshouWaitForCollection,
  resolveMiaoshouShopId,
} from "./miaoshou-client.ts";
import { errorMessage, initialSteps as buildInitialSteps, patchStep as patchWorkflowStep, RunLockMap } from "./workflow-core.ts";
import { WorkflowStore, workflowStore } from "./workflow-store.ts";
import { getAuthorizedTikTokClient, readStoredAuthorization } from "./tiktok-auth.ts";

export interface ProductPublishWorkflowTools {
  listShops(): Promise<WorkflowShopOption[]>;
  collect(sourceUrl: string): Promise<{ sourceItemId: string; commonDetailId: string; reused?: boolean }>;
  claimToTikTok(commonDetailId: string): Promise<{ platformDetailId: string }>;
  claimToShop?(platformDetailId: string, shopId: string, opts?: { region?: string; shopName?: string }): Promise<void>;
  enrich(input: {
    platformDetailId: string;
    shopId: string;
    targetLanguage: string;
    shopName?: string;
    region?: string;
  }): Promise<{ categoryId?: string; warnings: string[]; resolvedShopId?: string }>;
  prepareEdit?(input: {
    platformDetailId: string;
    shopId: string;
    publishPrice: number;
    skuPrices?: Record<string, number>;
    selectedSkuKeys?: string[];
    packageDimensions?: { length: number; width: number; height: number };
    title?: string;
    description?: string;
  }): Promise<{ skuCount: number; changes: Array<{ field: string; before: string; after: string }>; missingPackageDimensions?: boolean }>;
  saveEdit?(input: {
    platformDetailId: string;
    shopId: string;
    publishPrice: number;
    skuPrices?: Record<string, number>;
    selectedSkuKeys?: string[];
    packageDimensions?: { length: number; width: number; height: number };
    title?: string;
    description?: string;
    site?: string;
  }): Promise<void>;
  diagnose(input: {
    platformDetailId: string;
    shopId: string;
    site: string;
  }): Promise<{ productTitle?: string; categoryId?: string; blockingIssues: string[]; warnings: string[] }>;
  publish(input: { platformDetailId: string; shopId: string }): Promise<{ requestId?: string }>;
  verify(input: {
    platformDetailId: string;
    shopId: string;
    publishedAfter?: string;
    workflowCreatedAt?: string;
  }): Promise<{ matched: boolean; summary: string; productId?: string; productTitle?: string; skuIds?: string[]; skus?: Array<{ id: string; sellerSku?: string }> }>;
}

const STEP_LABELS: Array<[WorkflowStep["id"], string]> = [
  ["prepare", "运营总监 · 检查连接并选择店铺"],
  ["collect", "采集 Agent · 采集 1688 商品"],
  ["claim", "上架 Agent · 认领到 TikTok 采集箱"],
  ["enrich", "上架 Agent · 补全类目、属性和文案"],
  ["edit", "上架 Agent · 保存售价和商品资料"],
  ["validate", "上架 Agent · 检查发布必填项"],
  ["confirm", "运营总监 · 确认发布信息"],
  ["publish", "上架 Agent · 发布到 TikTok 店铺"],
  ["verify", "上架 Agent · 核验发布结果"],
];

const PUBLISH_VERIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// 采集上架服务采集是异步的，且对已采集过的链接会返回没有 payload 的 skip 行，等待要给足。
const COLLECT_REUSE_WAIT_MS = 20_000;
const COLLECT_WAIT_MS = 90_000;
const COLLECT_POLL_INTERVAL_MS = 3_000;

function publishVerificationExpired(run: ProductPublishWorkflowRun): boolean {
  const submittedAt = run.steps.find((step) => step.id === "publish")?.completedAt
    ?? run.steps.find((step) => step.id === "publish")?.startedAt
    ?? run.createdAt;
  const submittedTime = new Date(submittedAt).getTime();
  return Number.isFinite(submittedTime) && Date.now() - submittedTime > PUBLISH_VERIFICATION_TIMEOUT_MS;
}

function initialWorkflowSteps(): WorkflowStep[] {
  return buildInitialSteps(STEP_LABELS.map(([id, label]) => [id, label] as [string, string]));
}

function patchStep(
  run: ProductPublishWorkflowRun,
  id: WorkflowStep["id"],
  patch: Partial<WorkflowStep>,
): ProductPublishWorkflowRun {
  // 旧 run 可能缺少后来新增的步骤（如 pricing/edit），缺失时插到 edit 之前补齐
  return patchWorkflowStep(run, id, patch, { labels: STEP_LABELS.map(([id, label]) => [id, label] as [string, string]), insertBefore: "edit" });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findValue(value: unknown, keys: Set<string>): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, item] of Object.entries(record)) {
    if (keys.has(key) && (typeof item === "string" || typeof item === "number")) return String(item);
  }
  for (const item of Object.values(record)) {
    const found = findValue(item, keys);
    if (found) return found;
  }
  return undefined;
}

function successfulResponse(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return true;
  const nestedResult = asRecord(record.data)?.result;
  const result = nestedResult ?? record.result ?? record.code;
  return result === undefined || result === "success" || result === 0 || result === "0";
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function positiveNumber(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function sourceItemIdFrom1688Url(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    return url.pathname.match(/\/offer\/(\d+)\.html/i)?.[1] ?? url.searchParams.get("offerId") ?? undefined;
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function includesCollectBoxItem(response: unknown, platformDetailId: string): boolean {
  const data = asRecord(asRecord(response)?.data);
  const list = data?.detailList ?? data?.list;
  return Array.isArray(list) && list.some((item) => {
    const record = asRecord(item);
    return String(record?.collectBoxDetailId ?? record?.detailId ?? "") === platformDetailId;
  });
}

async function findRecentTikTokProduct(createdAfter?: string): Promise<{ productId: string; productTitle: string; skuIds: string[]; skus: Array<{ id: string; sellerSku?: string }> } | undefined> {
  const client = await getAuthorizedTikTokClient();
  if (!client) return undefined;
  const response = await client.request<unknown>("/product/202502/products/search", {
    method: "POST",
    query: { page_size: "100" },
    body: {},
  });
  const products = asRecord(asRecord(response)?.data)?.products;
  const threshold = createdAfter ? Math.floor(new Date(createdAfter).getTime() / 1000) - 60 : 0;
  const recent = (Array.isArray(products) ? products : [])
    .map(asRecord)
    .filter((product): product is Record<string, unknown> => Boolean(product) && Number(product?.create_time ?? 0) >= threshold)
    .sort((a, b) => Number(b.create_time ?? 0) - Number(a.create_time ?? 0));
  const productId = String(recent[0]?.id ?? "").trim();
  if (!productId) return undefined;
  const detail = await client.request<unknown>(`/product/202309/products/${productId}`, { method: "GET" });
  const product = asRecord(asRecord(detail)?.data) ?? {};
  const skus = Array.isArray(product.skus) ? product.skus : [];
  return {
    productId,
    productTitle: String(product.title ?? recent[0]?.title ?? "").trim(),
    skuIds: skus.map((sku) => String(asRecord(sku)?.id ?? "")).filter(Boolean),
    skus: skus.flatMap((sku) => {
      const record = asRecord(sku);
      const id = String(record?.id ?? "").trim();
      if (!id) return [];
      const sellerSku = String(record?.seller_sku ?? "").trim();
      return [sellerSku ? { id, sellerSku } : { id }];
    }),
  };
}

function isValidNumericShopId(value: string | undefined): value is string {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

async function ensureMiaoshouShopId(
  shopId: string | undefined,
  opts?: { region?: string; shopName?: string },
): Promise<string> {
  if (!shopId) throw new Error("缺少店铺 ID，无法调用采集上架服务 API。请重新选择店铺。");
  if (isValidNumericShopId(shopId)) return shopId;
  const resolved = await resolveMiaoshouShopId(shopId, opts);
  if (isValidNumericShopId(resolved)) return resolved;
  throw new Error(
    `缺少有效的采集上架服务店铺 ID（当前值: ${shopId}）。请重新选择店铺，或检查 TikTok OAuth 与采集上架服务的店铺是否已关联。`,
  );
}

/**
 * 查询店铺在采集上架服务中的生效仓库，优先返回默认仓库，其次第一个生效仓库。
 * 返回 undefined 表示该店铺没有可用仓库（此时保存/发布应让上游给出明确错误）。
 */
async function resolveShopWarehouseId(shopId: string): Promise<string | undefined> {
  const response = await miaoshouGetShopWarehouseList([Number(shopId)]);
  const shopWarehouses = asRecord(response.data)?.shopWarehouseList;
  if (!Array.isArray(shopWarehouses)) return undefined;
  for (const shopWarehouse of shopWarehouses) {
    const warehouseList = asRecord(shopWarehouse)?.warehouseList;
    if (!Array.isArray(warehouseList) || !warehouseList.length) continue;
    const active: Record<string, unknown>[] = [];
    for (const w of warehouseList) {
      const record = asRecord(w);
      if (record && String(record.warehouseEffectStatus ?? "1") === "1") active.push(record);
    }
    if (!active.length) continue;
    const defaultWarehouse = active.find((w) => String(w.isDefault) === "1");
    const chosen = defaultWarehouse ?? active[0];
    const warehouseId = String(chosen.warehouseId ?? "").trim();
    if (warehouseId) return warehouseId;
  }
  return undefined;
}

/**
 * 给待保存商品详情补齐 SKU 的仓库库存映射（shopIdToWarehouseIdAndStockMap）。
 * 认领到 TikTok 采集箱后该字段通常为空，但采集上架服务保存商品时要求「店铺仓库已选择」，
 * 缺少会报「店铺【X】仓库未选择」。这里用店铺默认仓库 + 每个 SKU 当前库存填充。
 */
async function fillSkuWarehouseMap(item: Record<string, unknown>, resolvedShopId: string): Promise<void> {
  const skuMap = asRecord(item.skuMap);
  if (!skuMap) return;
  const warehouseId = await resolveShopWarehouseId(resolvedShopId);
  if (!warehouseId) return; // 店铺无仓库，交由上游报错，不静默填占位值
  for (const skuValue of Object.values(skuMap)) {
    const sku = asRecord(skuValue);
    if (!sku || sku.isDelete === "1") continue;
    const existing = asRecord(sku.shopIdToWarehouseIdAndStockMap);
    const shopMap = existing && asRecord(existing[resolvedShopId]);
    if (shopMap && Object.keys(shopMap).length) continue; // 已有仓库映射，不覆盖
    const stock = Number(sku.stock) >= 0 ? String(sku.stock) : "0";
    sku.shopIdToWarehouseIdAndStockMap = {
      ...(existing ?? {}),
      [resolvedShopId]: { [warehouseId]: stock },
    };
  }
}

/**
 * 补齐类目的必填商品属性。
 * enrich 步骤的 AI 属性匹配（ai_match_product_attribute）并不保证把每个必填属性都填上，
 * 漏填的必填属性会直接导致保存报「产品属性【X】必填」。这里在保存前回读类目元数据，
 * 找出 isMandatory 但商品属性里缺失、或已填但 valueId 为空的属性，用枚举值补上。
 *
 * 选择策略：优先找 valueNameAlias/name 与中文「中国/针织/棉」等常见值匹配的枚举项，
 * 否则取第一个枚举值兜底。属性值结构参考 { id, name, valueNameAlias }。
 */
async function fillMissingMandatoryAttributes(
  item: Record<string, unknown>,
  resolvedShopId: string,
  site: string,
): Promise<{ filled: string[] }> {
  const categoryId = String(item.cid ?? "").trim();
  if (!categoryId) return { filled: [] };

  let metadata: Record<string, unknown> | undefined;
  try {
    const response = await miaoshouGetTikTokCategoryMetadata(site, Number(categoryId), [Number(resolvedShopId)]);
    metadata = asRecord(asRecord(response.data)?.categoryMetadata);
  } catch {
    return { filled: [] }; // 元数据拿不到时不阻塞保存，交由上游报错
  }

  const attrList = Array.isArray(metadata?.categoryProductAttrList) ? metadata.categoryProductAttrList : [];
  if (!attrList.length) return { filled: [] };

  const productAttributes = Array.isArray(item.productAttributes) ? item.productAttributes : [];
  const existingByAttrId = new Map<string, Record<string, unknown>>();
  for (const attribute of productAttributes) {
    const record = asRecord(attribute);
    const attrId = String(record?.attributeId ?? record?.attrId ?? "").trim();
    if (attrId && record) existingByAttrId.set(attrId, record);
  }

  const filled: string[] = [];
  for (const raw of attrList) {
    const attribute = asRecord(raw);
    if (!attribute) continue;
    if (!isEnabledFlag(attribute.isMandatory) && !isEnabledFlag(attribute.mandatory)) continue;
    const attrId = String(attribute.attrId ?? attribute.attributeId ?? "").trim();
    if (!attrId) continue;
    const nameAlias = String(attribute.attributeNameAlias ?? attribute.attributeName ?? attribute.name ?? "").trim();

    const existing = existingByAttrId.get(attrId);
    if (existing) {
      // 已填属性，但 valueId 为 null（AI 只填了文本没落到枚举 ID）时，补上 valueId
      const values = Array.isArray(existing.attributeValues) ? existing.attributeValues : [];
      const needsValueId = values.some((v) => {
        const rec = asRecord(v);
        return rec && !String(rec.valueId ?? "").trim();
      });
      if (!needsValueId) continue;
    }

    const valueList = Array.isArray(attribute.valueList) ? attribute.valueList
      : Array.isArray(attribute.values) ? attribute.values
        : Array.isArray(attribute.attributeValueList) ? attribute.attributeValueList : [];
    if (!valueList.length) continue;

    const pickValue = (): Record<string, unknown> | undefined => {
      const candidates = valueList.map(asRecord).filter((v): v is Record<string, unknown> => Boolean(v));
      if (!candidates.length) return undefined;
      const idOf = (rec: Record<string, unknown>) => String(rec.id ?? rec.valueId ?? "").trim();
      const nameOf = (rec: Record<string, unknown>) =>
        [rec.valueNameAlias, rec.name].map((s) => String(s ?? "")).find((s) => s.trim());
      // 按中文名匹配常见取值
      const preferred = ["中国", "针织", "棉", "编织", "ポリアミド", "ナイロン"];
      for (const keyword of preferred) {
        const hit = candidates.find((c) => nameOf(c)?.includes(keyword));
        if (hit && idOf(hit)) return hit;
      }
      return candidates.find((c) => idOf(c));
    };

    const chosen = pickValue();
    if (!chosen) continue;
    const chosenId = String(chosen.id ?? chosen.valueId ?? "").trim();
    const chosenName = [chosen.valueNameAlias, chosen.name].map((s) => String(s ?? "")).find((s) => s.trim()) ?? "";

    if (existing) {
      const values = Array.isArray(existing.attributeValues) ? existing.attributeValues : [];
      for (const value of values) {
        const rec = asRecord(value);
        if (rec && !String(rec.valueId ?? "").trim()) rec.valueId = chosenId;
      }
    } else {
      productAttributes.push({
        attributeId: attrId,
        attributeName: nameAlias || String(attribute.attributeName ?? attribute.name ?? ""),
        attributeValues: [{ valueName: chosenName, valueId: chosenId }],
      });
      existingByAttrId.set(attrId, asRecord(productAttributes[productAttributes.length - 1])!);
    }
    filled.push(nameAlias || attrId);
  }

  if (filled.length) item.productAttributes = productAttributes;
  return { filled };
}

export const realProductPublishWorkflowTools: ProductPublishWorkflowTools = {
  async listShops() {
    const shops: WorkflowShopOption[] = [];
    const seenIds = new Set<string>();
    const miaoshouIdByOAuthId = new Map<string, string>();

    // 1) 从采集上架服务拉取店铺列表（优先 site=all，失败则回退到按 region 单独请求）
    let miaoshouShopsList: Array<Record<string, unknown>> = [];
    if (hasMiaoshouConfiguration()) {
      // 只查 OAuth 已授权店铺所在的站点——一个店铺一个请求。
      // 之前这里用 site=all 扇出全部站点，日本单店账号会连打 9 个请求，
      // 直接撞上采集上架服务「账户接口每秒请求频率超限」，要靠 3s/6s 退避才恢复，反而更慢。
      try {
        const stored = await readStoredAuthorization();
        const regions = new Set<string>();
        for (const shop of stored?.shops ?? []) {
          const region = (shop.region || "").toUpperCase();
          if (region) regions.add(region);
        }
        if (!regions.size) {
          const resolved = await miaoshouResolveSite();
          if (resolved) regions.add(resolved);
        }
        for (const region of regions) {
          try {
            const response = await miaoshouGetShopList("tiktok", region);
            const arr = asRecord(response.data)?.shopList;
            if (Array.isArray(arr)) miaoshouShopsList.push(...arr);
          } catch {
            // 单站点失败跳过，不阻断整个列表
          }
        }
      } catch (err) {
        console.warn(`[listShops] 采集上架服务店铺获取失败:`, (err as Error).message);
      }
    }

    // 2) 优先从 TikTok 官方 OAuth 已授权的店铺获取
    try {
      const stored = await readStoredAuthorization();
      if (stored?.shops?.length) {
        for (const shop of stored.shops) {
          const oauthId = shop.cipher || shop.id;
          if (!oauthId || seenIds.has(oauthId)) continue;
          const region = (shop.region || "").toUpperCase();
          const name = shop.name || "";
          // 店铺名称是唯一可靠的身份标识，必须先在全部采集上架服务店铺中按名称精确匹配。
          // 旧实现把「名称匹配」和「站点匹配」写成 OR 并 break，采集上架服务返回 [Mizora JP, Cashio]
          // 时第一个条目靠 site=JP 命中就直接返回，导致 Cashio 被解析成 Mizora JP —— 会发错店铺。
          let miaoshouShopId: string | undefined;
          if (name) {
            const byName = miaoshouShopsList.find((ms) => {
              const msShopName = String(ms.shopNick ?? ms.shopName ?? ms.platformShopName ?? "");
              return msShopName !== "" && msShopName === name;
            });
            if (byName) miaoshouShopId = String(byName.shopId ?? "");
          }
          // 名称对不上时，只有当该站点下只有唯一一家采集上架服务店铺才允许按站点兜底；
          // 多家店时宁可留空让用户显式选择，也不要猜错店铺。
          if (!miaoshouShopId && region) {
            const onSite = miaoshouShopsList.filter((ms) => String(ms.site ?? "").toUpperCase() === region);
            if (onSite.length === 1) miaoshouShopId = String(onSite[0].shopId ?? "");
          }
          // 最终兜底：用 resolveMiaoshouShopId 独立解析
          if (!miaoshouShopId) {
            miaoshouShopId = await resolveMiaoshouShopId(oauthId, { region, shopName: name });
          }
          if (miaoshouShopId) miaoshouIdByOAuthId.set(oauthId, miaoshouShopId);
          seenIds.add(oauthId);
          shops.push({
            id: oauthId,
            name: shop.name || `店铺 ${oauthId}`,
            site: region || "--",
            miaoshouShopId,
          });
        }
      }
    } catch (err) {
      console.warn(`[listShops] TikTok OAuth 读取失败:`, (err as Error).message);
    }

    // 3) 采集上架服务独有的店铺（OAuth 中没有的）也加入列表
    const miaoshouIdsFromOAuth = new Set(miaoshouIdByOAuthId.values());
    for (const item of miaoshouShopsList) {
      const shop = asRecord(item);
      const id = shop?.shopId;
      if (id === undefined || id === null || String(id).trim() === "") continue;
      const strId = String(id);
      if (seenIds.has(strId)) continue;
      if (miaoshouIdsFromOAuth.has(strId)) continue;
      seenIds.add(strId);
      shops.push({
        id: strId,
        name: String(shop?.shopNick ?? shop?.shopName ?? shop?.platformShopName ?? `店铺 ${id}`),
        site: String(shop?.site ?? shop?.siteName ?? "--").toUpperCase(),
        miaoshouShopId: strId,
      });
    }

    console.log(`[listShops] total shops=${shops.length} OAuthMiaoshouMap=${miaoshouIdByOAuthId.size}`);
    if (!shops.length) {
      throw new Error("没有找到可用的 TikTok 店铺。请先完成 TikTok Shop OAuth 授权，确认后再重试。");
    }
    return shops;
  },

  async collect(sourceUrl) {
    // 采集上架服务不会为已采集过的链接创建副本：重复调用 fetch_item 只会得到一条
    // status="skip"、reason="产品已经采集过。" 且**不含任何商品数据**的行，
    // 认领它会报「存在未采集成功的产品」，看起来像货源被封，其实是自造的重复行。
    // 所以先按货源编号复用已有的 success 记录，确实没有时才真正采集。
    const expectedSourceItemId = sourceItemIdFrom1688Url(sourceUrl);
    if (expectedSourceItemId) {
      const existing = await miaoshouWaitForCollection([expectedSourceItemId], COLLECT_REUSE_WAIT_MS, COLLECT_POLL_INTERVAL_MS);
      const existingDetailId = existing.find((item) => item.sourceItemId === expectedSourceItemId && item.detailId)?.detailId;
      if (existingDetailId) return { sourceItemId: expectedSourceItemId, commonDetailId: existingDetailId, reused: true };
    }

    const response = await miaoshouFetchItem(sourceUrl, "1688");
    const map = asRecord(asRecord(response.data)?.sourceItemIdAndDetailIdMap) ?? {};
    const [sourceItemId] = Object.keys(map);
    if (!sourceItemId) throw new Error("采集上架服务没有返回货源商品编号，请检查 1688 链接是否有效。");
    // fetch_item 可能映射到 skip/处理中记录，必须等公共采集箱出现同货源的 success 记录。
    const waitResult = await miaoshouWaitForCollection([sourceItemId], COLLECT_WAIT_MS, COLLECT_POLL_INTERVAL_MS);
    const commonDetailId = waitResult.find((item) => item.sourceItemId === sourceItemId && item.detailId)?.detailId;
    if (!commonDetailId) {
      throw new Error(
        "采集结果不可读：采集上架服务可能返回了一条重复采集产生的 skip 记录（不含商品数据）。" +
        "重复重试不会修复它，反而会继续消耗采集额度；请到采集上架服务后台确认该货源状态，或换一个尚未采集过的链接。",
      );
    }
    return { sourceItemId, commonDetailId };
  },

  async claimToTikTok(commonDetailId) {
    const response = await miaoshouClaimToPlatform([Number(commonDetailId)], "tiktok", 1);
    const data = asRecord(response.data);
    const platformMap = asRecord(data?.platformCollectBoxDetailIdMap);
    const tiktokMapEntry = Object.entries(platformMap ?? {}).find(([key]) => /tiktok|^tk$/i.test(key));
    const tiktokMap = asRecord(tiktokMapEntry?.[1]);
    const platformDetailId = String(tiktokMap?.[commonDetailId] ?? "");
    if (!platformDetailId) throw new Error("商品已提交认领，但采集上架服务没有返回 TikTok 采集箱编号。请查询采集箱后重试。");
    return { platformDetailId };
  },

  async claimToShop(platformDetailId, shopId, opts) {
    // 必须把 region / shopName 传下去：TikTok OAuth 的 shopId 是 cipher（ROW_...），
    // 只能靠名称或站点才能解析成采集上架服务数字店铺 ID。漏传时 resolveMiaoshouShopId 会退化到
    // 站点优先级列表逐个试探，既慢又可能解析失败。
    const numericShopId = Number(await ensureMiaoshouShopId(shopId, opts));
    const response = await miaoshouClaimToShop([Number(platformDetailId)], [numericShopId]);
    if (!successfulResponse(response)) throw new Error("采集上架服务未能把商品关联到目标店铺。");
  },

  async enrich({ platformDetailId, shopId, targetLanguage, shopName, region }) {
    const warnings: string[] = [];
    let categoryId: string | undefined;
    const resolvedShopId = await ensureMiaoshouShopId(shopId, { region, shopName });
    try {
      const category = await miaoshouAiMatchCategory([platformDetailId], [resolvedShopId]);
      categoryId = findValue(category.data, new Set(["category_id", "categoryId", "cid"]));
    } catch (error) {
      warnings.push(`类目自动匹配失败：${errorMessage(error)}`);
    }

    for (let attempt = 0; !categoryId && attempt < 6; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        const detail = await miaoshouGetTikTokShopCollectItemInfo(Number(platformDetailId), Number(resolvedShopId));
        categoryId = String(asRecord(asRecord(detail.data)?.shopCollectItemInfo)?.cid ?? "").trim() || undefined;
      } catch {
      }
    }

    if (categoryId) {
      try {
        await miaoshouAiMatchAttribute(platformDetailId, categoryId, region ?? PRIMARY_SITE);
      } catch (error) {
        warnings.push(`属性自动匹配失败：${errorMessage(error)}`);
      }
    } else {
      warnings.push("采集上架服务没有返回类目编号，属性自动匹配已跳过；发布前请留意类目是否完整。");
    }

    // 采集上架服务限频 1 次/秒，写接口之间保持间隔
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    try {
      await miaoshouTranslateItem(platformDetailId, Number(resolvedShopId), targetLanguage);
    } catch (error) {
      warnings.push(`商品翻译失败：${errorMessage(error)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    try {
      await miaoshouAiGenerateProductInfo(platformDetailId, Number(resolvedShopId), targetLanguage);
    } catch (error) {
      warnings.push(`标题和描述生成失败：${errorMessage(error)}`);
    }

    return { categoryId, warnings, resolvedShopId };
  },

  async prepareEdit({ platformDetailId, shopId, publishPrice, skuPrices, selectedSkuKeys, packageDimensions, title, description }) {
    const resolvedShopId = await ensureMiaoshouShopId(shopId);
    const response = await miaoshouGetTikTokShopCollectItemInfo(Number(platformDetailId), Number(resolvedShopId));
    const data = asRecord(response.data);
    const item = asRecord(data?.shopCollectItemInfo);
    if (!item) throw new Error("采集上架服务没有返回完整商品详情，无法生成编辑预览。");
    const skuMap = asRecord(item.skuMap) ?? {};
    const activeEntries = Object.entries(skuMap).filter(([, value]) => {
      const sku = asRecord(value);
      return Boolean(sku) && sku?.isDelete !== "1";
    });
    const selectedSet = selectedSkuKeys ? new Set(selectedSkuKeys) : undefined;
    const activeSkus = activeEntries
      .filter(([skuKey]) => !selectedSet || selectedSet.has(skuKey))
      .map(([, value]) => asRecord(value))
      .filter((sku): sku is Record<string, unknown> => Boolean(sku));
    if (!activeSkus.length) throw new Error("至少需要保留一个待发布 SKU。");
    const prices = activeSkus.map((sku) => String(sku?.price ?? "未设置"));
    const localDisplayPrices = activeSkus.map((sku) => String(sku?.priceIncludeVat ?? "未设置"));
    const targetPrices = Object.values(skuPrices ?? {});
    const targetPriceText = targetPrices.length ? [...new Set(targetPrices)].sort((a, b) => a - b).join(" / ") : String(publishPrice);
    const changes: Array<{ field: string; before: string; after: string }> = [{
      field: `全部 ${activeSkus.length} 个 SKU 售价`,
      before: [...new Set(prices)].join(" / "),
      after: targetPriceText,
    }, {
      field: `全部 ${activeSkus.length} 个 SKU 本地展示价`,
      before: [...new Set(localDisplayPrices)].join(" / "),
      after: targetPriceText,
    }];
    const removedSkuCount = activeEntries.length - activeSkus.length;
    if (removedSkuCount > 0) changes.unshift({
      field: "SKU 数量",
      before: String(activeEntries.length),
      after: `${activeSkus.length}（移除 ${removedSkuCount} 个）`,
    });
    if (packageDimensions) changes.push({
      field: "包裹尺寸（厘米）",
      before: `${item.packageLength || "-"} x ${item.packageWidth || "-"} x ${item.packageHeight || "-"}`,
      after: `${packageDimensions.length} x ${packageDimensions.width} x ${packageDimensions.height}`,
    });
    if (title?.trim() && title.trim() !== String(item.title ?? "").trim()) {
      changes.push({ field: "标题", before: String(item.title ?? "未填写"), after: title.trim() });
    }
    if (description?.trim() && description.trim() !== String(item.notes ?? "").trim()) {
      changes.push({ field: "描述", before: String(item.notes ?? "未填写").slice(0, 120), after: description.trim().slice(0, 120) });
    }
    if (!String(item.deliveryOptionSetType ?? "").trim()) {
      changes.push({ field: "发货方式", before: "未设置", after: "使用店铺默认设置" });
    }
    const missingPackageDimensions = !packageDimensions
      && (!positiveNumber(item.packageLength) || Number(item.packageLength) < 1
        || !positiveNumber(item.packageWidth) || Number(item.packageWidth) < 1
        || !positiveNumber(item.packageHeight) || Number(item.packageHeight) < 1);
    return { skuCount: activeSkus.length, changes, missingPackageDimensions };
  },

  async saveEdit({ platformDetailId, shopId, publishPrice, skuPrices, selectedSkuKeys, packageDimensions, title, description, site }) {
    const resolvedShopId = await ensureMiaoshouShopId(shopId);
    const response = await miaoshouGetTikTokShopCollectItemInfo(Number(platformDetailId), Number(resolvedShopId));
    const data = asRecord(response.data);
    const original = asRecord(data?.shopCollectItemInfo);
    const ossMd5 = String(data?.ossMd5 ?? "").trim();
    if (!original || !ossMd5) throw new Error("采集上架服务没有返回最新完整商品详情或 ossMd5，已停止保存。");
    const item = structuredClone(original);
    const skuMap = asRecord(item.skuMap) ?? {};
    const selectedSet = selectedSkuKeys ? new Set(selectedSkuKeys) : undefined;
    let skuCount = 0;
    for (const [skuKey, skuValue] of Object.entries(skuMap)) {
      const sku = asRecord(skuValue);
      if (!sku || sku.isDelete === "1") continue;
      if (selectedSet && !selectedSet.has(skuKey)) {
        sku.isDelete = "1";
        continue;
      }
      const targetPrice = skuPrices?.[skuKey] ?? publishPrice;
      sku.price = targetPrice;
      sku.priceIncludeVat = targetPrice;
      skuCount += 1;
    }
    if (!skuCount) throw new Error("商品没有可编辑的 SKU，已停止保存。");
    if (packageDimensions) {
      item.packageLength = Math.ceil(packageDimensions.length);
      item.packageWidth = Math.ceil(packageDimensions.width);
      item.packageHeight = Math.ceil(packageDimensions.height);
    }
    if (Number(item.packageLength) < 1 || Number(item.packageWidth) < 1 || Number(item.packageHeight) < 1) {
      throw new Error("请先填写实际包裹长、宽、高，每项至少为 1 厘米。");
    }
    if (title?.trim()) item.title = title.trim();
    if (description?.trim()) item.notes = description.trim();
    if (!String(item.deliveryOptionSetType ?? "").trim()) item.deliveryOptionSetType = "default";
    if (!String(item.sizeChart ?? "").trim()) {
      delete item.sizeChart;
      delete item.sizeChartType;
    }
    // 仓库库存映射：认领到 TikTok 采集箱后，SKU 的 shopIdToWarehouseIdAndStockMap 通常是空的，
    // 而采集上架服务保存商品时要求「店铺仓库已选择」。这里查询店铺生效仓库并选默认仓库，
    // 给每个待保存 SKU 填上仓库库存映射，否则保存会报「仓库未选择」。
    await fillSkuWarehouseMap(item, resolvedShopId);
    // 补齐类目必填商品属性：AI 属性匹配可能漏掉必填项（如「织造方法」），漏填会导致保存报错。
    await fillMissingMandatoryAttributes(item, resolvedShopId, site ?? PRIMARY_SITE);
    await miaoshouSaveTikTokShopCollectItemInfo(Number(platformDetailId), Number(resolvedShopId), ossMd5, item);
  },

  async diagnose({ platformDetailId, shopId, site }) {
    const resolvedShopId = await ensureMiaoshouShopId(shopId);
    const response = await miaoshouGetTikTokShopCollectItemInfo(Number(platformDetailId), Number(resolvedShopId));
    const data = asRecord(response.data);
    const item = asRecord(data?.shopCollectItemInfo);
    if (!item) throw new Error("采集上架服务没有返回该商品的店铺详情，无法做发布前检查。");

    const blockingIssues: string[] = [];
    const warnings: string[] = [];
    const images = Array.isArray(item.imgUrls) ? item.imgUrls : [];
    const skuMap = asRecord(item.skuMap) ?? {};
    const activeSkus = Object.values(skuMap)
      .map(asRecord)
      .filter((sku): sku is Record<string, unknown> => Boolean(sku) && sku?.isDelete !== "1");

    if (!String(item.title ?? "").trim()) blockingIssues.push("商品标题未填写。");
    if (!String(item.notes ?? "").trim()) blockingIssues.push("商品描述未填写。");
    if (!images.length) blockingIssues.push("商品图片未上传。");
    if (!String(item.cid ?? "").trim()) blockingIssues.push("未选择 TikTok 类目。");
    if (!positiveNumber(item.weight)) blockingIssues.push("商品重量必须大于 0。");
    if (!activeSkus.length) blockingIssues.push("商品没有可发布的 SKU。");
    if (activeSkus.some((sku) => !positiveNumber(sku.price))) blockingIssues.push("存在未填售价的 SKU。");
    if (activeSkus.some((sku) => !positiveNumber(sku.priceIncludeVat))) blockingIssues.push("存在未填本地展示价的 SKU。");
    if (activeSkus.some((sku) => !Number.isFinite(Number(sku.stock)) || Number(sku.stock) < 0)) blockingIssues.push("存在库存无效的 SKU。");
    if (activeSkus.some((sku) => !positiveNumber(sku.weight))) blockingIssues.push("存在未填重量的 SKU。");
    if (activeSkus.some((sku) => {
      const shopWarehouses = asRecord(asRecord(sku.shopIdToWarehouseIdAndStockMap)?.[resolvedShopId]);
      return !shopWarehouses || Object.keys(shopWarehouses).length === 0;
    })) blockingIssues.push("存在未配置仓库库存的 SKU。");
    if (!["0", "1"].includes(String(item.isCodOpen ?? ""))) warnings.push("货到付款设置不完整。");
    if (!String(item.deliveryOptionSetType ?? "").trim()) warnings.push("采集上架服务以空值回传店铺默认发货方式；发布时将沿用店铺设置。");
    const dimensionsMissing = !positiveNumber(item.packageLength) || !positiveNumber(item.packageWidth) || !positiveNumber(item.packageHeight);
    if (dimensionsMissing) blockingIssues.push("包裹长、宽、高未填写。");

    const categoryId = String(item.cid ?? "").trim();
    if (categoryId) {
      try {
        const metadataResponse = await miaoshouGetTikTokCategoryMetadata(site, Number(categoryId), [Number(resolvedShopId)]);
        const metadata = asRecord(asRecord(metadataResponse.data)?.categoryMetadata);
        const config = asRecord(metadata?.categoryConfig) ?? {};
        if (isEnabledFlag(config.manufacturerIsRequired) && (!Array.isArray(item.manufacturerIds) || !item.manufacturerIds.length)) {
          blockingIssues.push("当前类目要求选择制造商。");
        }
        if (isEnabledFlag(config.responsiblePersonIsRequired) && (!Array.isArray(item.responsiblePersonIds) || !item.responsiblePersonIds.length)) {
          blockingIssues.push("当前类目要求选择责任人。");
        }

        const selectedProductAttributes = new Set(
          (Array.isArray(item.productAttributes) ? item.productAttributes : [])
            .map((attribute) => String(asRecord(attribute)?.attributeId ?? "")),
        );
        const missingRequiredAttributes = (Array.isArray(metadata?.categoryProductAttrList) ? metadata.categoryProductAttrList : [])
          .map(asRecord)
          .filter((attribute) => attribute && isEnabledFlag(attribute.isMandatory) && !selectedProductAttributes.has(String(attribute.attrId ?? attribute.attributeId ?? "")))
          .map((attribute) => String(attribute?.attributeNameAlias ?? attribute?.name ?? "必填属性"));
        if (missingRequiredAttributes.length) blockingIssues.push(`缺少必填商品属性：${missingRequiredAttributes.join("、")}。`);
      } catch (error) {
        blockingIssues.push(`无法确认当前类目的必填要求：${errorMessage(error)}`);
      }
    }

    return {
      productTitle: String(item.title ?? "").trim() || undefined,
      categoryId: categoryId || undefined,
      blockingIssues: unique(blockingIssues),
      warnings: unique(warnings),
    };
  },

  async publish({ platformDetailId, shopId }) {
    const resolvedShopId = await ensureMiaoshouShopId(shopId);
    const detailIds = [Number(platformDetailId)];
    const shopIds = [Number(resolvedShopId)];
    const published = await miaoshouPublishToTikTok(detailIds, shopIds);
    if (!successfulResponse(published)) throw new Error("采集上架服务没有接受商品发布请求。");
    return {
      requestId: findValue(published, new Set(["request_id", "requestId", "task_id", "taskId"])),
    };
  },

  async verify({ platformDetailId, shopId, publishedAfter, workflowCreatedAt }) {
    try {
      const response = await miaoshouGetPublishRecords(1, 20);
      const serialized = JSON.stringify(response.data ?? response);
      const matched = serialized.includes(platformDetailId) && serialized.includes(shopId);
      if (matched) {
        const linked = await findRecentTikTokProduct(workflowCreatedAt ?? publishedAfter).catch(() => undefined);
        return { matched: true, summary: linked ? `已经在 TikTok 店铺找到并关联商品 ${linked.productId}。` : "已经在采集上架服务发布记录中找到对应商品和店铺。", ...linked };
      }
    } catch {
      // 某些采集上架服务应用没有发布记录权限，继续直接回读 TikTok 店铺。
    }

    // 发布记录权限未开通时，采集箱的状态分组仍可以提供明确进度。
    // 妙手发布是异步的，刚提交时商品会先停留在「未发布」分组，落库需要几十秒到几分钟；
    // 只查一次就判「等待核验」会造成大量误报，这里在窗口内轮询等它落到「已发布」。
    const VERIFY_WAIT_TOTAL_MS = 90_000;
    const VERIFY_WAIT_INTERVAL_MS = 12_000;
    const verifyDeadline = Date.now() + VERIFY_WAIT_TOTAL_MS;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    let sawPending = false;
    while (Date.now() < verifyDeadline) {
      const pendingResponse = await miaoshouGetTikTokCollectBoxList(1, 100, "notPublished");
      if (!includesCollectBoxItem(pendingResponse, platformDetailId)) break;
      sawPending = true;
      await new Promise((resolve) => setTimeout(resolve, VERIFY_WAIT_INTERVAL_MS));
    }
    if (sawPending) {
      // 等待期结束后仍停在「未发布」，或刚好挪出未发布分组，都再查一次已发布分组确认。
      const publishedResponse = await miaoshouGetTikTokCollectBoxList(1, 100, "published");
      if (includesCollectBoxItem(publishedResponse, platformDetailId)) {
        const linked = await findRecentTikTokProduct(workflowCreatedAt ?? publishedAfter).catch(() => undefined);
        return { matched: true, summary: linked ? `已经在采集上架服务“已发布”列表和 TikTok 店铺找到商品 ${linked.productId}。` : "已经在采集上架服务“已发布”列表中找到该商品。", ...linked };
      }
      if (Date.now() >= verifyDeadline) {
        return {
          matched: false,
          summary: "采集上架服务已接受发布请求，但该商品发布后 90 秒内仍停在“未发布”列表，还没有上架到 TikTok。可稍后点击「重新核验发布结果」。",
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const publishedResponse = await miaoshouGetTikTokCollectBoxList(1, 100, "published");
    if (includesCollectBoxItem(publishedResponse, platformDetailId)) {
      const linked = await findRecentTikTokProduct(workflowCreatedAt ?? publishedAfter).catch(() => undefined);
      return { matched: true, summary: linked ? `已经在采集上架服务“已发布”列表和 TikTok 店铺找到商品 ${linked.productId}。` : "已经在采集上架服务“已发布”列表中找到该商品。", ...linked };
    }

    const client = await getAuthorizedTikTokClient();
    if (!client) throw new Error("TikTok Shop 未连接，无法直接核验发布结果。");
    const response = await client.request<unknown>("/product/202502/products/search", {
      method: "POST",
      query: { page_size: "100" },
      body: {},
    });
    const products = asRecord(asRecord(response)?.data)?.products;
    const threshold = (workflowCreatedAt ?? publishedAfter) ? Math.floor(new Date(workflowCreatedAt ?? publishedAfter!).getTime() / 1000) - 60 : Number.POSITIVE_INFINITY;
    const recentProducts = Array.isArray(products) ? products.flatMap((item) => {
      const product = asRecord(item);
      const createdAt = Number(product?.create_time ?? 0);
      if (!product || !Number.isFinite(createdAt) || createdAt < threshold) return [];
      return [{
        id: String(product.id ?? "--"),
        title: String(product.title ?? "未命名商品"),
        status: String(product.status ?? "UNKNOWN"),
      }];
    }) : [];
    return recentProducts.length
      ? {
          matched: true,
          summary: `已直接在 TikTok 店铺找到本次提交后新增的商品：${recentProducts.map((item) => `${item.title}（${item.status}，${item.id}）`).join("；")}`,
          productId: recentProducts[0].id,
          productTitle: recentProducts[0].title,
        }
      : {
          matched: false,
          summary: "采集上架服务已接受发布请求，但 TikTok 店铺中还没有出现本次提交后的新商品，可以稍后重新核验。",
        };
  },
};

export class ProductPublishWorkflowEngine {
  private readonly locks = new RunLockMap();

  constructor(
    private readonly store: WorkflowStore = workflowStore,
    private readonly tools: ProductPublishWorkflowTools = realProductPublishWorkflowTools,
  ) {}

  async list(): Promise<ProductPublishWorkflowRun[]> {
    return (await this.store.list()).filter((run): run is ProductPublishWorkflowRun => run.type === "product_publish");
  }

  async get(id: string): Promise<ProductPublishWorkflowRun | undefined> {
    const run = await this.store.get(id);
    return run?.type === "product_publish" ? run : undefined;
  }

  async create(input: {
    sourceUrl?: string;
    /** 已认领到 TikTok 采集箱的商品编号；聊天里直接说「发布」时复用采集箱最近的商品 */
    platformDetailId?: string;
    shopId?: string;
    publishPrice?: number;
    currency?: string;
    packageDimensions?: { length: number; width: number; height: number };
    title?: string;
    description?: string;
  }): Promise<ProductPublishWorkflowRun> {
    if (!input.sourceUrl && !input.platformDetailId) {
      throw new Error("请提供 1688 商品链接，或先在聊天里完成采集和认领。");
    }
    let url: URL | undefined;
    if (input.sourceUrl) {
      try {
        url = new URL(input.sourceUrl);
      } catch {
        throw new Error("请输入完整的 1688 商品链接。");
      }
      if (url.protocol !== "https:" || !/(^|\.)1688\.com$/i.test(url.hostname)) {
        throw new Error("当前发布流程只接受 1688 的 HTTPS 商品链接。");
      }
    }
    if (input.publishPrice !== undefined && (!Number.isFinite(input.publishPrice) || input.publishPrice <= 0)) {
      throw new Error("发布售价必须是大于 0 的数字。");
    }
    if (input.packageDimensions && Object.values(input.packageDimensions).some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("包裹长、宽、高都必须是大于 0 的数字。");
    }
    const now = new Date().toISOString();
    const run: ProductPublishWorkflowRun = {
      id: randomUUID(),
      type: "product_publish",
      title: input.platformDetailId && !input.sourceUrl ? "TikTok 采集箱商品发布" : "1688 商品发布到 TikTok",
      status: "draft",
      ...(url ? { sourceUrl: url.toString() } : {}),
      ...(input.platformDetailId ? { platformDetailId: input.platformDetailId } : {}),
      targetPlatform: "tiktok",
      ...(input.shopId ? { shopId: input.shopId } : {}),
      ...(input.publishPrice !== undefined ? { publishPrice: input.publishPrice } : {}),
      currency: input.currency?.trim().toUpperCase() || "JPY",
      ...(input.packageDimensions ? { packageDimensions: input.packageDimensions } : {}),
      ...(input.title?.trim() ? { requestedTitle: input.title.trim() } : {}),
      ...(input.description?.trim() ? { requestedDescription: input.description.trim() } : {}),
      steps: initialWorkflowSteps(),
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.store.create(run);
  }

  async run(id: string): Promise<ProductPublishWorkflowRun> {
    return this.locks.withLock(id, () => this.advance(id));
  }

  async requestStartApproval(id: string): Promise<ProductPublishWorkflowRun> {
    return this.locks.withLock(id, async () => this.update(id, (run) => {
      if (run.status !== "draft" || run.steps.some((step) => step.status === "completed" || step.status === "running")) {
        throw new Error("这个任务已经开始，不能重复生成开始审核。");
      }
      return patchStep({
        ...run,
        status: "waiting_confirmation",
        confirmationKind: "workflow_start",
        summary: "确认后将开始采集1688商品、认领到采集上架服务TikTok采集箱并补全商品资料；不会直接发布到TikTok。",
      }, "prepare", { status: "pending", detail: "等待审核后开始任务" });
    }));
  }

  async selectShop(id: string, shopId: string): Promise<ProductPublishWorkflowRun> {
    await this.locks.withLock(id, async () => {
      await this.update(id, (run) => {
        if (run.status !== "waiting_input" || run.requiredInput?.kind !== "shop") {
          throw new Error("这个任务当前不需要选择店铺。");
        }
        const shop = run.requiredInput.options.find((option) => option.id === shopId);
        if (!shop) throw new Error("请选择任务列出的店铺。");
        return {
          ...run,
          status: "draft",
          shopId: shop.id,
          shopName: shop.name,
          shopSite: shop.site,
          targetLanguage: languageForSite(shop.site),
          requiredInput: undefined,
          error: undefined,
        };
      });
    });
    return this.run(id);
  }

  async recheckReadiness(id: string): Promise<ProductPublishWorkflowRun> {
    await this.locks.withLock(id, async () => {
      await this.update(id, (run) => {
        if (run.status !== "waiting_input" || run.requiredInput?.kind !== "product_data") {
          throw new Error("这个任务当前不需要重新检查商品信息。");
        }
        return patchStep({
          ...run,
          status: "draft",
          requiredInput: undefined,
          readinessIssues: undefined,
          error: undefined,
        }, "validate", {
          status: "pending",
          detail: "准备重新检查",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
      });
    });
    return this.run(id);
  }

  async updateProductInput(id: string, input: {
    publishPrice: number;
    packageDimensions?: { length: number; width: number; height: number };
    title?: string;
    description?: string;
  }): Promise<ProductPublishWorkflowRun> {
    if (!Number.isFinite(input.publishPrice) || input.publishPrice <= 0) throw new Error("发布售价必须大于 0。");
    if (input.packageDimensions && Object.values(input.packageDimensions).some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("包裹长、宽、高都必须大于 0。");
    }
    await this.locks.withLock(id, async () => this.update(id, (run) => {
      if (run.status !== "waiting_input" || run.requiredInput?.kind !== "product_edit") {
        throw new Error("这个任务当前不需要填写售价。");
      }
      return patchStep({
        ...run,
        status: "draft",
        publishPrice: input.publishPrice,
        ...(input.packageDimensions ? { packageDimensions: input.packageDimensions } : {}),
        ...(input.title?.trim() ? { requestedTitle: input.title.trim() } : {}),
        ...(input.description?.trim() ? { requestedDescription: input.description.trim() } : {}),
        requiredInput: undefined,
        error: undefined,
      }, "edit", { status: "pending", detail: "准备生成编辑预览", error: undefined });
    }));
    return this.run(id);
  }

  async approve(id: string): Promise<ProductPublishWorkflowRun> {
    const pending = await this.requireRun(id);
    if (pending.status === "waiting_confirmation" && pending.confirmationKind === "workflow_start") {
      await this.locks.withLock(id, async () => this.update(id, (run) => ({
        ...run,
        status: "draft",
        confirmationKind: undefined,
        summary: "开始审核已通过，正在执行采集、认领和资料补全。",
        error: undefined,
      })));
      return this.run(id);
    }
    if (pending.status === "waiting_confirmation" && pending.confirmationKind === "product_edit") {
      const saved = await this.locks.withLock(id, async () => {
        const run = await this.requireRun(id);
        if (!run.platformDetailId || !run.shopId || !run.publishPrice || !this.tools.saveEdit) {
          throw new Error("任务缺少商品、店铺或售价，不能保存编辑。");
        }
        await this.update(id, (current) => patchStep({ ...current, status: "running", error: undefined }, "edit", {
          status: "running", detail: "正在读取最新详情并完整保存", startedAt: new Date().toISOString(), error: undefined,
        }));
        try {
          await this.tools.saveEdit({
            platformDetailId: run.platformDetailId,
            shopId: run.shopId,
            publishPrice: run.publishPrice,
            packageDimensions: run.packageDimensions,
            title: run.requestedTitle,
            description: run.requestedDescription,
            site: run.shopSite,
          });
          return this.update(id, (current) => patchStep({
            ...current, status: "draft", confirmationKind: undefined, requiredInput: undefined,
          }, "edit", { status: "completed", detail: "已用最新完整详情保存", completedAt: new Date().toISOString() }));
        } catch (error) {
          return this.fail(id, "edit", error);
        }
      });
      return saved.status === "draft" ? this.run(id) : saved;
    }
    return this.locks.withLock(id, async () => {
      let run = await this.requireRun(id);
      // 必须卡死"发布确认"这一种确认卡：开始审核通过后任务是 draft/running，
      // 排队等锁的重复 approve 不能在锁内把新产生的发布确认卡顺手确认掉
      if (run.status !== "waiting_confirmation" || run.confirmationKind !== "product_publish" || !run.platformDetailId || !run.shopId) {
        throw new Error(run.status === "draft" || run.status === "running"
          ? "任务已通过开始审核，正在执行采集和认领，无需重复审核。"
          : run.status === "failed"
            ? "任务在执行中失败，请在任务卡片上点击「重试失败步骤」。"
            : "这个任务还没有到发布确认步骤。");
      }
      const platformDetailId = run.platformDetailId;
      const shopId = run.miaoshouShopId || run.shopId;

      run = await this.update(id, (current) => {
        const confirmed = patchStep(current, "confirm", {
          status: "completed",
          detail: "已确认发布",
          completedAt: new Date().toISOString(),
        });
        return patchStep({ ...confirmed, status: "running", error: undefined }, "publish", {
          status: "running",
          detail: `正在发布到 ${current.shopName ?? current.shopId}`,
          startedAt: new Date().toISOString(),
          error: undefined,
        });
      });

      try {
        const result = await this.tools.publish({ platformDetailId, shopId });
        run = await this.update(id, (current) => patchStep({
          ...current,
          publishRequestId: result.requestId,
        }, "publish", {
          status: "completed",
          detail: "采集上架服务已接受发布请求",
          completedAt: new Date().toISOString(),
        }));
      } catch (error) {
        return this.fail(id, "publish", error);
      }

      return this.verifyUnlocked(id);
    });
  }

  async verify(id: string): Promise<ProductPublishWorkflowRun> {
    return this.locks.withLock(id, () => this.verifyUnlocked(id));
  }

  async retry(id: string): Promise<ProductPublishWorkflowRun> {
    const pending = await this.requireRun(id);
    if (pending.status === "verification_pending") {
      const checked = await this.verify(id);
      if (checked.status === "completed") return checked;
      return this.locks.withLock(id, async () => {
        const current = await this.requireRun(id);
        if (current.status !== "verification_pending") return current;
        let reset = patchStep({
          ...current,
          status: "waiting_confirmation",
          confirmationKind: "product_publish",
          summary: "再次核验仍未上架，等待确认后重新提交发布；不会重复采集或认领商品。",
          error: undefined,
        }, "confirm", {
          status: "pending",
          detail: "等待确认重新提交发布",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
        reset = patchStep(reset, "publish", {
          status: "pending",
          detail: "确认后重新提交",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
        return this.update(id, () => patchStep(reset, "verify", {
          status: "pending",
          detail: "重新发布后再核验",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        }));
      });
    }
    const run = await this.locks.withLock(id, async () => {
      const current = await this.requireRun(id);
      if (current.status !== "failed") throw new Error("只有失败的任务可以重试。");
      const failedStep = current.steps.find((step) => step.status === "failed");
      if (!failedStep) throw new Error("没有找到需要重试的步骤。");
      return this.update(id, (stored) => patchStep({
        ...stored,
        status: failedStep.id === "publish" ? "waiting_confirmation" : "draft",
        error: undefined,
      }, failedStep.id, {
        status: "pending",
        error: undefined,
        detail: failedStep.id === "publish" ? "请重新确认后再次发布" : "准备重试",
        startedAt: undefined,
        completedAt: undefined,
      }));
    });
    return run.status === "draft" ? this.run(id) : run;
  }

  async cancel(id: string): Promise<ProductPublishWorkflowRun> {
    return this.locks.withLock(id, async () => this.update(id, (run) => {
      if (run.status === "completed" || run.status === "cancelled") return run;
      return { ...run, status: "cancelled", summary: "任务已取消，后续步骤不会继续执行。" };
    }));
  }

  private async advance(id: string): Promise<ProductPublishWorkflowRun> {
    let run = await this.requireRun(id);
    if (run.status !== "draft") return run;

    // 补救：如果旧任务没有 miaoshouShopId，通过独立解析接口自动补全（不依赖 listShops，避免频率限制）
    if (run.shopId && !run.miaoshouShopId) {
      try {
        const resolved = await resolveMiaoshouShopId(run.shopId, {
          region: run.shopSite,
          shopName: run.shopName,
        });
        if (isValidNumericShopId(resolved)) {
          run = await this.update(id, (current) => ({
            ...current,
            miaoshouShopId: resolved,
          }));
        }
      } catch { /* 静默跳过，后续 ensureMiaoshouShopId 会重试或给出明确错误 */ }
    }

    run = await this.update(id, (current) => ({ ...current, status: "running", error: undefined }));
    let currentStep: WorkflowStep["id"] = "prepare";

    try {
      if (run.steps.find((step) => step.id === "prepare")?.status !== "completed") {
        run = await this.startStep(id, "prepare", "正在读取授权店铺");
        const shops = await this.tools.listShops();
        if (!shops.length) throw new Error("没有找到可用的 TikTok 店铺。请先完成 TikTok Shop OAuth 授权。");
        let shop = run.shopId ? shops.find((item) => item.id === run.shopId) : undefined;
        if (!shop && shops.length === 1) shop = shops[0];
        if (!shop) {
          return this.update(id, (current) => patchStep({
            ...current,
            status: "waiting_input",
            requiredInput: {
              kind: "shop",
              prompt: "请选择这次要发布到哪个 TikTok 店铺。",
              options: shops,
            },
          }, "prepare", { status: "pending", detail: "等待选择店铺", startedAt: undefined }));
        }
        run = await this.update(id, (current) => patchStep({
          ...current,
          shopId: shop.id,
          shopName: shop.name,
          shopSite: shop.site,
          miaoshouShopId: shop.miaoshouShopId,
          targetLanguage: languageForSite(shop.site),
          requiredInput: undefined,
        }, "prepare", {
          status: "completed",
          detail: `${shop.name} · ${shop.site}`,
          completedAt: new Date().toISOString(),
        }));
      }

      currentStep = "collect";
      // 从聊天「发布」意图创建的任务自带已认领的采集箱商品：直接复用，跳过采集
      if (run.platformDetailId && run.steps.find((step) => step.id === "collect")?.status !== "completed") {
        run = await this.update(id, (current) => patchStep(current, "collect", {
          status: "completed",
          detail: `复用 TikTok 采集箱商品 ${current.platformDetailId}，跳过采集`,
          completedAt: new Date().toISOString(),
        }));
      }
      if (!run.commonDetailId && !run.platformDetailId) {
        run = await this.startStep(id, "collect", "正在采集商品并等待进入公共采集箱");
        const collected = await this.tools.collect(run.sourceUrl!);
        run = await this.update(id, (current) => patchStep({
          ...current,
          sourceItemId: collected.sourceItemId,
          commonDetailId: collected.commonDetailId,
        }, "collect", {
          status: "completed",
          detail: collected.reused
            ? `复用已有采集记录 ${collected.commonDetailId}`
            : `公共采集箱 ID ${collected.commonDetailId}`,
          completedAt: new Date().toISOString(),
        }));
      }

      currentStep = "claim";
      if (!run.platformDetailId) {
        run = await this.startStep(id, "claim", "正在认领到 TikTok 采集箱");
        const claimed = await this.tools.claimToTikTok(run.commonDetailId!);
        run = await this.update(id, (current) => patchStep({
          ...current,
          platformDetailId: claimed.platformDetailId,
        }, "claim", {
          status: "completed",
          detail: `TikTok 采集箱 ID ${claimed.platformDetailId}`,
          completedAt: new Date().toISOString(),
        }));
      }

      if (this.tools.claimToShop && !run.claimedToShop) {
        run = await this.startStep(id, "claim", "正在关联到目标店铺");
        const shopIdForMiaoshou = run.miaoshouShopId || run.shopId!;
        await this.tools.claimToShop(run.platformDetailId!, shopIdForMiaoshou, {
          region: run.shopSite,
          shopName: run.shopName,
        });
        run = await this.update(id, (current) => patchStep({ ...current, claimedToShop: true }, "claim", {
          status: "completed",
          detail: `已认领到 ${current.shopName ?? current.shopId} · TikTok 采集箱 ID ${current.platformDetailId}`,
          completedAt: new Date().toISOString(),
        }));
      }

      currentStep = "enrich";
      if (run.steps.find((step) => step.id === "enrich")?.status !== "completed") {
        run = await this.startStep(id, "enrich", "正在匹配类目、属性并生成商品文案");
        const shopIdForMiaoshou = run.miaoshouShopId || run.shopId!;
        const enriched = await this.tools.enrich({
          platformDetailId: run.platformDetailId!,
          shopId: shopIdForMiaoshou,
          targetLanguage: run.targetLanguage ?? PRIMARY_LANGUAGE,
          shopName: run.shopName,
          region: run.shopSite,
        });
        run = await this.update(id, (current) => patchStep({
          ...current,
          categoryId: enriched.categoryId,
          // 解析成功的采集上架服务数字店铺 ID 回写任务，后续定价/发布步骤直接使用，避免重复解析或 NaN
          miaoshouShopId: enriched.resolvedShopId ?? current.miaoshouShopId,
          warnings: [...current.warnings, ...enriched.warnings],
        }, "enrich", {
          status: "completed",
          detail: enriched.warnings.length ? `已尝试自动补全，${enriched.warnings.length} 项未完成` : "类目、属性和文案已补全",
          completedAt: new Date().toISOString(),
        }));
      }

      currentStep = "edit";
      if (!this.tools.prepareEdit && run.steps.some((step) => step.id === "edit") && run.steps.find((step) => step.id === "edit")?.status !== "completed") {
        run = await this.update(id, (current) => patchStep(current, "edit", {
          status: "completed", detail: "当前工具未启用编辑保存", completedAt: new Date().toISOString(),
        }));
      }
      if (this.tools.prepareEdit && run.steps.some((step) => step.id === "edit") && run.steps.find((step) => step.id === "edit")?.status !== "completed") {
        if (!run.publishPrice) {
          return this.update(id, (current) => patchStep({
            ...current,
            status: "waiting_input",
            requiredInput: { kind: "product_edit", prompt: "请输入要发布到 TikTok 的 SKU 售价。包裹尺寸只有在你掌握真实数据时再填写。", missing: ["publishPrice"] },
            summary: "商品已经采集、认领并完成自动补全，等待你填写售价后生成编辑预览。",
          }, "edit", { status: "pending", detail: "等待填写售价" }));
        }
        // 先取出售价再 startStep：run 会被重新赋值，窄化会因此丢失
        const publishPrice = run.publishPrice;
        const shopIdForMiaoshou = run.miaoshouShopId || run.shopId!;
        run = await this.startStep(id, "edit", "正在读取最新商品详情并生成变更预览");
        const preview = await this.tools.prepareEdit({
          platformDetailId: run.platformDetailId!,
          shopId: shopIdForMiaoshou,
          publishPrice,
          packageDimensions: run.packageDimensions,
          title: run.requestedTitle,
          description: run.requestedDescription,
        });
        if (preview.missingPackageDimensions) {
          return this.update(id, (current) => patchStep({
            ...current,
            status: "waiting_input",
            requiredInput: {
              kind: "product_edit",
              prompt: "采集上架服务要求填写实际包裹尺寸。请补充长、宽、高后再生成编辑预览。",
              missing: ["packageDimensions"],
            },
            editPreview: undefined,
            summary: `已保留 ${preview.skuCount} 个 SKU，等待补充包裹尺寸。`,
          }, "edit", { status: "pending", detail: "等待填写包裹尺寸", startedAt: undefined, error: undefined }));
        }
        return this.update(id, (current) => patchStep({
          ...current,
          status: "waiting_confirmation",
          confirmationKind: "product_edit",
          editPreview: preview,
          summary: `已生成 ${preview.skuCount} 个 SKU 的编辑预览。确认后才会把完整商品详情保存到采集上架服务。`,
        }, "edit", { status: "pending", detail: "等待确认保存商品编辑", startedAt: undefined }));
      }

      currentStep = "validate";
      if (run.steps.find((step) => step.id === "validate")?.status !== "completed") {
        run = await this.startStep(id, "validate", "正在检查类目、SKU、物流和仓库信息");
        const shopIdForMiaoshou = run.miaoshouShopId || run.shopId!;
        const readiness = await this.tools.diagnose({
          platformDetailId: run.platformDetailId!,
          shopId: shopIdForMiaoshou,
          site: run.shopSite ?? PRIMARY_SITE,
        });
        run = await this.update(id, (current) => patchStep({
          ...current,
          productTitle: readiness.productTitle ?? current.productTitle,
          categoryId: readiness.categoryId ?? current.categoryId,
          readinessIssues: readiness.blockingIssues,
          warnings: unique([...current.warnings, ...readiness.warnings]),
        }, "validate", {
          status: readiness.blockingIssues.length ? "failed" : "completed",
          detail: readiness.blockingIssues.length
            ? `发现 ${readiness.blockingIssues.length} 项必填信息缺失`
            : readiness.warnings.length ? `必填项已通过，${readiness.warnings.length} 项建议可选优化` : "发布必填项已通过",
          completedAt: new Date().toISOString(),
        }));
        if (readiness.blockingIssues.length) {
          return this.update(id, (current) => ({
            ...current,
            status: "waiting_input",
            summary: "商品已经采集并认领，但发布必填信息还不完整。补全后可以从这里重新检查。",
            requiredInput: {
              kind: "product_data",
              prompt: "请先在采集上架服务 TikTok 采集箱补全以下信息。",
              issues: readiness.blockingIssues,
            },
          }));
        }
      }

      return this.update(id, (current) => patchStep({
        ...current,
        status: "waiting_confirmation",
        confirmationKind: "product_publish",
        summary: current.warnings.length
          ? "商品已经采集并认领，但自动补全存在未完成项。请查看提示后再确认发布。"
          : "商品已经采集、认领并完成自动补全，请确认后发布到目标店铺。",
      }, "confirm", {
        status: "pending",
        detail: "等待你确认发布",
      }));
    } catch (error) {
      return this.fail(id, currentStep, error);
    }
  }

  private async verifyUnlocked(id: string): Promise<ProductPublishWorkflowRun> {
    let run = await this.requireRun(id);
    if (!run.platformDetailId || !run.shopId) throw new Error("任务缺少商品或店铺编号，无法核验。");
    const platformDetailId = run.platformDetailId;
    const shopId = run.shopId;
    run = await this.update(id, (current) => patchStep({ ...current, status: "running" }, "verify", {
      status: "running",
      detail: "正在查询采集上架服务发布记录",
      startedAt: new Date().toISOString(),
      error: undefined,
    }));
    try {
      const publishedAfter = run.steps.find((step) => step.id === "publish")?.startedAt;
      const verification = await this.tools.verify({ platformDetailId, shopId, publishedAfter, workflowCreatedAt: run.createdAt });
      const expired = !verification.matched && publishVerificationExpired(run);
      const updated = await this.update(id, (current) => patchStep({
        ...current,
        status: verification.matched ? "completed" : expired ? "failed" : "verification_pending",
        summary: expired
          ? "发布请求已超过 24 小时仍未核验到上架结果。任务已停止自动等待，可以检查采集上架服务失败原因后重试。"
          : verification.summary,
        error: expired ? "发布结果核验超时" : undefined,
        tiktokProductId: verification.productId ?? current.tiktokProductId,
        productTitle: verification.productTitle ?? current.productTitle,
        warnings: current.warnings.filter((warning) => {
          if (warning.startsWith("发布结果核验失败：")) return false;
          if (verification.productId && /类目自动匹配失败|没有返回类目编号/.test(warning)) return false;
          if (verification.productTitle && /[\u0E00-\u0E7F]/.test(verification.productTitle) && /商品翻译失败|标题和描述生成失败/.test(warning)) return false;
          return true;
        }),
      }, "verify", {
        status: verification.matched ? "completed" : expired ? "failed" : "pending",
        detail: expired ? "超过 24 小时仍未上架，可检查后重试" : verification.summary,
        error: expired ? "发布结果核验超时" : undefined,
        ...(verification.matched ? { completedAt: new Date().toISOString() } : {}),
      }));
      return updated;
    } catch (error) {
      return this.update(id, (current) => patchStep({
        ...current,
        status: "verification_pending",
        summary: "发布请求已经提交，但暂时无法读取发布记录。",
        warnings: [
          ...current.warnings.filter((warning) => !warning.startsWith("发布结果核验失败：")),
          `发布结果核验失败：${errorMessage(error)}`,
        ],
      }, "verify", { status: "pending", detail: "等待重新核验", error: errorMessage(error) }));
    }
  }

  private async startStep(id: string, stepId: WorkflowStep["id"], detail: string): Promise<ProductPublishWorkflowRun> {
    return this.update(id, (run) => patchStep({ ...run, status: "running", error: undefined }, stepId, {
      status: "running",
      detail,
      error: undefined,
      startedAt: new Date().toISOString(),
    }));
  }

  private async fail(id: string, stepId: WorkflowStep["id"], error: unknown): Promise<ProductPublishWorkflowRun> {
    const message = errorMessage(error);
    return this.update(id, (run) => patchStep({ ...run, status: "failed", error: message }, stepId, {
      status: "failed",
      error: message,
      detail: "执行失败，可修正后重试",
    }));
  }

  private async requireRun(id: string): Promise<ProductPublishWorkflowRun> {
    const run = await this.store.get(id);
    if (!run || run.type !== "product_publish") throw new Error("找不到这个发布任务。");
    return run;
  }

  private update(
    id: string,
    updater: (run: ProductPublishWorkflowRun) => ProductPublishWorkflowRun,
  ): Promise<ProductPublishWorkflowRun> {
    return this.store.update<ProductPublishWorkflowRun>(id, updater);
  }
}

export const productPublishWorkflowEngine = new ProductPublishWorkflowEngine();

export async function startProductPublishWorkflow(input: {
  sourceUrl?: string;
  platformDetailId?: string;
  shopId?: string;
  publishPrice?: number;
  currency?: string;
  packageDimensions?: { length: number; width: number; height: number };
  title?: string;
  description?: string;
}): Promise<ProductPublishWorkflowRun> {
  const run = await productPublishWorkflowEngine.create(input);
  return productPublishWorkflowEngine.requestStartApproval(run.id);
}

/**
 * 聊天「发布到 TikTok 店铺」入口：复用 TikTok 采集箱里最近一件已认领、未发布的商品
 * 创建上架任务（跳过采集和认领），审核卡交给用户确认后走补全 → 保存 → 发布 → 核验。
 */
export async function startPublishFromCollectBox(): Promise<ProductPublishWorkflowRun> {
  const response = await miaoshouGetTikTokCollectBoxList(1, 20, "notPublished");
  const data = asRecord(asRecord(response)?.data);
  const list = Array.isArray(data?.detailList) ? data.detailList : Array.isArray(data?.list) ? data.list : [];
  const latest = list
    .map((item) => asRecord(item))
    .find((record): record is Record<string, unknown> => {
      if (!record) return false;
      const detailId = String(record.collectBoxDetailId ?? record.detailId ?? "").trim();
      return Boolean(detailId) && detailId !== "0";
    });
  const platformDetailId = latest ? String(latest.collectBoxDetailId ?? latest.detailId ?? "").trim() : "";
  if (!platformDetailId) {
    throw new Error("TikTok 采集箱里没有已认领、未发布的商品。请先粘贴 1688 链接完成采集和认领，或直接在采集上架服务里认领。");
  }
  return startProductPublishWorkflow({ platformDetailId });
}

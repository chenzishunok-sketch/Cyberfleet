import type {
  TikTokCapabilitiesResponse,
  TikTokCapabilityStatus,
  TikTokOperationCapability,
  TikTokSceneCapability,
  TikTokScopeCapability,
} from "../shared/contracts.ts";
import { readStoredAuthorization, tokenStorePath } from "./tiktok-auth.ts";
import { TIKTOK_OPERATIONS, type TikTokOperationDefinition } from "./tiktok-operation-catalog.ts";
import { stat } from "node:fs/promises";

interface ActiveScopeDefinition {
  key: string;
  label: string;
  sceneId: string;
  tokenKeys?: string[];
  note?: string;
}

interface SceneDefinition {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  prompts: string[];
  note?: string;
}

const ACTIVE_SCOPES: ActiveScopeDefinition[] = [
  { key: "data.bestselling.public.read", label: "市场热销榜", sceneId: "market" },
  { key: "seller.finance.info", label: "财务信息", sceneId: "finance" },
  { key: "seller.fulfillment.basic", label: "基础履约", sceneId: "fulfillment" },
  { key: "seller.global_product.category.info", label: "全球商品类目", sceneId: "global" },
  { key: "seller.global_product.delete", label: "删除全球商品", sceneId: "global" },
  { key: "seller.global_product.info", label: "全球商品信息", sceneId: "global" },
  { key: "seller.global_product.write", label: "修改全球商品", sceneId: "global" },
  { key: "seller.shop.info", label: "全球店铺信息", sceneId: "shop" },
  {
    key: "creator.data.live.read.public",
    label: "达人直播数据",
    sceneId: "analytics",
    note: "官方 7 个直播间接口要求 creator access token（user_type=1），不能使用当前卖家令牌。",
  },
  { key: "seller.logistics", label: "物流基础", sceneId: "logistics" },
  { key: "seller.order.info", label: "订单信息", sceneId: "orders" },
  { key: "seller.fulfillment.package.write", label: "拆包与合包", sceneId: "fulfillment" },
  { key: "seller.product.basic", label: "商品基础", sceneId: "catalog" },
  { key: "seller.product.delete", label: "商品删除与恢复", sceneId: "catalog" },
  {
    key: "seller.global_product.image_trans_task",
    label: "商品图片翻译",
    sceneId: "global",
    note: "权限已开通；官方当前把两条图片翻译接口登记在 Product Optimization 范围，并仅支持跨欧盟销售卖家。",
  },
  { key: "seller.product.write", label: "商品修改", sceneId: "catalog" },
  {
    key: "seller.product.optimize",
    label: "商品优化",
    sceneId: "catalog",
    tokenKeys: ["seller.product.optimize", "serller.product.optimize"],
    note: "TikTok 当前返回的 scope key 拼写为 serller.product.optimize，系统已做兼容。",
  },
  { key: "seller.promotion.info", label: "促销信息", sceneId: "promotions" },
  { key: "seller.promotion.write", label: "促销修改", sceneId: "promotions" },
  { key: "seller.return_refund.basic", label: "退货与退款", sceneId: "aftersales" },
  { key: "seller.authorization.info", label: "授权店铺信息", sceneId: "shop" },
  { key: "data.shop_analytics.public.read", label: "店铺经营分析", sceneId: "analytics" },
  { key: "seller.delivery.status.write", label: "更新妥投状态", sceneId: "fulfillment" },
];

const SCENES: SceneDefinition[] = [
  {
    id: "market",
    label: "市场选品",
    shortLabel: "市场选品",
    description: "市场热销商品、达人、短视频和直播榜单",
    prompts: ["查看近 7 天市场热销商品榜", "查看近 7 天市场热销达人", "查看近 7 天热门带货视频", "查看近 7 天热门带货直播"],
  },
  {
    id: "analytics",
    label: "经营与内容分析",
    shortLabel: "经营分析",
    description: "店铺、商品、SKU、短视频与店播表现",
    prompts: ["分析最近 7 天店铺销售表现", "查看店铺商品表现排行", "查看店铺短视频表现", "查看店铺直播表现"],
    note: "店铺直播分析可直接使用卖家令牌；指定达人直播间的 7 个深度接口需要另做达人授权。",
  },
  {
    id: "catalog",
    label: "本店商品",
    shortLabel: "本店商品",
    description: "商品、SKU、类目、价格、库存、上下架和优化",
    prompts: ["查看全部商品和 SKU", "诊断在售商品信息质量", "查找库存不足的 SKU", "查看店铺商品表现排行"],
  },
  {
    id: "global",
    label: "全球商品",
    shortLabel: "全球商品",
    description: "全球商品、跨站点发布、全球类目和图片翻译",
    prompts: ["检查我的店铺是否支持全球商品", "查看全部全球商品", "查看全球商品类目列表", "检查图片翻译使用条件"],
    note: "全球商品接口是否可执行取决于卖家类型和目标市场，执行前会读取 seller permissions 校验。",
  },
  {
    id: "orders",
    label: "订单中心",
    shortLabel: "订单中心",
    description: "订单查询、明细、价格构成和 POD 信息",
    prompts: ["查看最近 7 天订单", "查询待发货订单", "查询订单价格明细（需提供订单号）", "按订单号查看完整订单（需提供订单号）"],
  },
  {
    id: "fulfillment",
    label: "履约与包裹",
    shortLabel: "履约包裹",
    description: "包裹查询、发货、拆合包、面单和妥投状态",
    prompts: ["查看最近 7 天包裹", "查询可合并的包裹", "查看仓库列表", "查看可用物流模板"],
  },
  {
    id: "logistics",
    label: "仓库与物流",
    shortLabel: "仓库物流",
    description: "仓库、配送方式、承运商和物流轨迹",
    prompts: ["查看仓库列表", "查看可用物流模板", "查询订单物流轨迹（需提供订单号）", "检查物流单号是否有效（需提供单号）"],
  },
  {
    id: "aftersales",
    label: "售后退款",
    shortLabel: "售后退款",
    description: "取消、退货、退款、售后审核与 RMA",
    prompts: ["查看最近 7 天退货退款", "分析最近 7 天退款原因", "查询待处理售后", "查询订单售后资格（需提供订单号）"],
  },
  {
    id: "finance",
    label: "财务结算",
    shortLabel: "财务结算",
    description: "结算单、提现、付款和未结算交易",
    prompts: ["查看最近的结算单", "查看提现记录", "查看未结算订单", "按订单查询财务流水（需提供订单号）"],
  },
  {
    id: "promotions",
    label: "促销活动",
    shortLabel: "促销活动",
    description: "活动与优惠券查询、创建、修改和停用",
    prompts: ["查看当前促销活动", "查看进行中的促销活动", "查看优惠券列表", "当前有哪些促销和优惠券"],
  },
  {
    id: "shop",
    label: "店铺与权限",
    shortLabel: "店铺权限",
    description: "授权店铺、店铺组、卖家权限和全球仓库",
    prompts: ["我的店铺叫什么", "查看卖家权限", "查看授权店铺列表", "查看店铺组"],
  },
];

const EXCLUDED_SCOPES = [
  { key: "seller.customer_service", label: "Customer Service", reason: "仍在审核中，未接入。" },
  { key: "seller.redeem_info.write", label: "Manage Seller Redeem Info Callback", reason: "仍在审核中，未接入。" },
];

const GLOBAL_SCOPE_PREFIX = "seller.global_product.";

function tokenKeys(scope: ActiveScopeDefinition): string[] {
  return scope.tokenKeys ?? [scope.key];
}

function operationUsesScope(operation: TikTokOperationDefinition, scope: ActiveScopeDefinition): boolean {
  if (scope.key === "seller.global_product.image_trans_task") return /Image Translation/i.test(operation.title);
  return tokenKeys(scope).some((key) => operation.scopes.includes(key));
}

function operationSceneId(operation: TikTokOperationDefinition): string {
  if (operation.scopes.includes("data.bestselling.public.read")) return "market";
  if (operation.scopes.some((scope) => scope === "data.shop_analytics.public.read" || scope === "creator.data.live.read.public")) return "analytics";
  if (/Image Translation/i.test(operation.title) || operation.scopes.some((scope) => scope.startsWith(GLOBAL_SCOPE_PREFIX))) return "global";
  if (operation.category === "Products") return "catalog";
  if (operation.category === "Promotion") return "promotions";
  if (operation.category === "Orders") return "orders";
  if (operation.category === "Fulfillment") return "fulfillment";
  if (operation.category === "Logistics") return "logistics";
  if (operation.category === "Return and refund") return "aftersales";
  if (operation.category === "Finance") return "finance";
  return "shop";
}

function hasOperationToken(operation: TikTokOperationDefinition, grantedScopes: Set<string>): boolean {
  return operation.scopes.some((scope) => {
    if (scope === "serller.product.optimize") {
      return grantedScopes.has(scope) || grantedScopes.has("seller.product.optimize");
    }
    return grantedScopes.has(scope);
  });
}

function operationStatus(operation: TikTokOperationDefinition, grantedScopes: Set<string>, region?: string): TikTokCapabilityStatus {
  if (operation.credential === "creator") return "creator_authorization_required";
  if (!hasOperationToken(operation, grantedScopes)) return "reauthorization_required";
  if (region !== "US" && operation.path.startsWith("/analytics/202606/shop_performances")) return "region_unavailable";
  if (operation.scopes.some((scope) => scope.startsWith(GLOBAL_SCOPE_PREFIX)) || /Image Translation/i.test(operation.title)) {
    return "eligibility_check_required";
  }
  return operation.effect === "query" ? "ready" : "confirmation_required";
}

function scopeStatus(scope: ActiveScopeDefinition, granted: boolean): TikTokCapabilityStatus {
  if (scope.key === "creator.data.live.read.public") return "creator_authorization_required";
  if (!granted) return "reauthorization_required";
  if (scope.key.startsWith(GLOBAL_SCOPE_PREFIX)) return "eligibility_check_required";
  return "ready";
}

function sceneStatus(operations: TikTokOperationCapability[]): TikTokCapabilityStatus {
  if (operations.some((operation) => operation.status === "ready" || operation.status === "confirmation_required")) return "ready";
  if (operations.some((operation) => operation.status === "eligibility_check_required")) return "eligibility_check_required";
  if (operations.some((operation) => operation.status === "creator_authorization_required")) return "creator_authorization_required";
  if (operations.some((operation) => operation.status === "region_unavailable")) return "region_unavailable";
  return "reauthorization_required";
}

// capabilities 长缓存：数据在授权不变时完全一致，用授权文件 mtime 做失效检测
let capabilitiesCache: { mtimeMs: number; data: TikTokCapabilitiesResponse } | undefined;

export async function getTikTokCapabilities(): Promise<TikTokCapabilitiesResponse> {
  // 读取授权文件 mtime，变了才重算；文件不存在时 mtimeMs=0 会强制重算
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(tokenStorePath())).mtimeMs;
  } catch {
    // 文件不存在：清空缓存，走全量计算
    capabilitiesCache = undefined;
  }
  if (capabilitiesCache && capabilitiesCache.mtimeMs === mtimeMs) {
    return capabilitiesCache.data;
  }
  const data = await computeTikTokCapabilities();
  capabilitiesCache = { mtimeMs, data };
  return data;
}

async function computeTikTokCapabilities(): Promise<TikTokCapabilitiesResponse> {
  const stored = await readStoredAuthorization();
  const grantedScopes = new Set(stored?.grantedScopes ?? []);
  const selectedShop = stored?.shops.find((shop) => shop.cipher === stored.selectedShopCipher);
  const region = selectedShop?.region;

  const operationCapabilities = TIKTOK_OPERATIONS.map<TikTokOperationCapability>((operation) => ({
    id: operation.id,
    title: operation.title,
    method: operation.method,
    path: operation.path,
    scopeKeys: operation.scopes.map((scope) => scope === "serller.product.optimize" ? "seller.product.optimize" : scope),
    effect: operation.effect,
    status: operationStatus(operation, grantedScopes, region),
    officialUrl: operation.officialUrl,
  }));

  const scopeCapabilities = ACTIVE_SCOPES.map<TikTokScopeCapability>((scope) => {
    const granted = tokenKeys(scope).some((key) => grantedScopes.has(key));
    const operationCount = TIKTOK_OPERATIONS.filter((operation) => operationUsesScope(operation, scope)).length;
    return {
      key: scope.key,
      label: scope.label,
      sceneId: scope.sceneId,
      grantedInConsole: true,
      grantedInToken: granted,
      status: scopeStatus(scope, granted),
      operationCount,
      note: scope.note,
    };
  });

  const scenes = SCENES.map<TikTokSceneCapability>((scene) => {
    const operations = operationCapabilities.filter((operation) => {
      const source = TIKTOK_OPERATIONS.find((item) => item.id === operation.id);
      return source ? operationSceneId(source) === scene.id : false;
    });
    const sceneScopes = scopeCapabilities.filter((scope) => scope.sceneId === scene.id).map((scope) => scope.key);
    return {
      id: scene.id,
      label: scene.label,
      shortLabel: scene.shortLabel,
      description: scene.description,
      status: sceneStatus(operations),
      operationCount: operations.length,
      queryCount: operations.filter((operation) => operation.effect === "query").length,
      protectedCount: operations.filter((operation) => operation.effect !== "query").length,
      scopeKeys: sceneScopes,
      prompts: scene.prompts,
      note: scene.note,
      operations,
    };
  });

  const warnings = [
    "达人直播间的 7 个深度接口需要 creator access token，当前卖家授权不能调用。",
    "TikTok 官方把图片翻译接口登记在拼写为 serller.product.optimize 的范围下，系统已按官方返回值兼容。",
    "全球商品与图片翻译还会受卖家类型、目标市场和跨境资格限制，执行前必须校验 seller permissions。",
    ...(region && region !== "US" ? ["SPS 202606 的 5 个店铺诊断接口仅支持美国店，当前店铺不显示为可执行。"] : []),
  ];

  return {
    source: "TikTok Shop Partner Center API Reference V2",
    catalogAsOf: "2026-07-27",
    shopRegion: region,
    totalOperations: operationCapabilities.length,
    sellerOperations: operationCapabilities.filter((operation) => !operation.scopeKeys.includes("creator.data.live.read.public")).length,
    creatorOperations: operationCapabilities.filter((operation) => operation.scopeKeys.includes("creator.data.live.read.public")).length,
    readyQueries: operationCapabilities.filter((operation) => operation.status === "ready").length,
    protectedOperations: operationCapabilities.filter((operation) => operation.status === "confirmation_required").length,
    scenes,
    scopes: scopeCapabilities,
    excludedScopes: EXCLUDED_SCOPES,
    warnings,
  };
}

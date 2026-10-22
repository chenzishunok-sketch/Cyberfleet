import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TikTokShopClient } from "./tiktok-client.ts";
import { getTikTokAppRuntimeConfig } from "./runtime-config.ts";
import type { TikTokBindingSummary, TikTokConnectionStatus } from "../shared/contracts.ts";

const DEFAULT_SERVICE_ID = "7660083559697663764";
const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_WINDOW_SECONDS = 5 * 60;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TIKTOK_BASE_URL = "https://open-api.tiktokglobalshop.com";
const DEFAULT_TIKTOK_TOKEN_URL = "https://auth.tiktok-shops.com/api/v2/token/get";
const DEFAULT_TIKTOK_AUTH_URL = (serviceId: string) => `https://services.tiktokshop.com/open/authorize?service_id=${serviceId}`;
const oauthStates = new Map<string, number>();
// 每个 grant 独立单飞刷新，避免多账号绑定后互相阻塞或重复刷新
const refreshPromises = new Map<string, Promise<TikTokGrant>>();

const tokenDataSchema = z.object({
  access_token: z.string().min(1),
  access_token_expire_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expire_in: z.number().int().positive(),
  open_id: z.string().optional(),
  seller_name: z.string().optional(),
  seller_base_region: z.string().optional(),
  user_type: z.number().int().optional(),
  granted_scopes: z.array(z.string()).optional(),
});

const tokenResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional().default(""),
  request_id: z.string().optional(),
  data: tokenDataSchema.optional(),
});

const authorizedShopsResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional().default(""),
  request_id: z.string().optional(),
  data: z.object({
    shops: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      region: z.string().min(1),
      seller_type: z.string().optional(),
      cipher: z.string().min(1),
      code: z.string().optional(),
    })).optional(),
  }).optional(),
});

// v1：单授权文件（一个卖家账号）。仅用于读取旧文件并迁移到 v2 绑定存储。
const storedAuthorizationSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.number().int().positive(),
  openId: z.string().optional(),
  sellerName: z.string().optional(),
  sellerRegion: z.string().optional(),
  userType: z.number().int().optional(),
  grantedScopes: z.array(z.string()),
  shops: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    region: z.string().min(1),
    sellerType: z.string().optional(),
    cipher: z.string().min(1),
    code: z.string().optional(),
  })).min(1),
  selectedShopCipher: z.string().min(1).optional(),
  updatedAt: z.string().min(1),
});

// v2：多绑定存储。一次 OAuth 授权 = 一条 grant（一个卖家账号），名下多国店铺随 shops 进入。
const authorizedShopSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.string().min(1),
  sellerType: z.string().optional(),
  cipher: z.string().min(1),
  code: z.string().optional(),
});

const grantSchema = z.object({
  grantId: z.string().min(1),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.number().int().positive(),
  openId: z.string().optional(),
  sellerName: z.string().optional(),
  sellerRegion: z.string().optional(),
  userType: z.number().int().optional(),
  grantedScopes: z.array(z.string()),
  shops: z.array(authorizedShopSchema).min(1),
  authorizedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const bindingsStoreSchema = z.object({
  version: z.literal(2),
  selected: z.object({ grantId: z.string().min(1), shopId: z.string().min(1) }).nullable(),
  grants: z.array(grantSchema),
});

type TikTokTokenData = z.infer<typeof tokenDataSchema>;

export interface AuthorizedShop {
  id: string;
  name: string;
  region: string;
  sellerType?: string;
  cipher: string;
  code?: string;
}

/** 一条绑定（一个卖家账号的 OAuth grant） */
export interface TikTokGrant {
  grantId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  openId?: string;
  sellerName?: string;
  sellerRegion?: string;
  userType?: number;
  grantedScopes: string[];
  shops: AuthorizedShop[];
  authorizedAt: string;
  updatedAt: string;
}

export interface TikTokBindingsStore {
  version: 2;
  selected: { grantId: string; shopId: string } | null;
  grants: TikTokGrant[];
}

/**
 * 旧调用方兼容视图：把「当前选中的 grant」投影成 v1 单授权结构，
 * tiktok-data / scenes / writes / workflows 等下游模块无需感知多绑定模型。
 */
export interface StoredTikTokAuthorization {
  version: 1;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  openId?: string;
  sellerName?: string;
  sellerRegion?: string;
  userType?: number;
  grantedScopes: string[];
  shops: AuthorizedShop[];
  selectedShopCipher?: string;
  updatedAt: string;
}

export type { TikTokConnectionStatus };

function requireAppCredentials() {
  const config = getTikTokAppRuntimeConfig();
  if (!config.appKey || !config.appSecret) {
    throw new Error("请先在设置的“绑定新店铺”向导或 .env 中配置 TikTok Shop 应用密钥。");
  }
  return { appKey: config.appKey, appSecret: config.appSecret };
}

export function bindingsStorePath(): string {
  const configured = process.env.TIKTOK_SHOP_TOKEN_STORE?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".data", "tiktok-bindings.json");
}

/** 兼容旧调用方（能力目录用 mtime 探测授权变更）：指向 v2 绑定存储文件 */
export function tokenStorePath(): string {
  return bindingsStorePath();
}

function legacyTokenStorePath(): string {
  return path.resolve(process.cwd(), ".data", "tiktok-authorization.json");
}

function validateFutureExpiry(value: number, label: string): number {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(value) || value <= now) throw new Error(`${label}无效或已经过期，请重新授权。`);
  return value;
}

function pruneStates() {
  const threshold = Date.now() - STATE_TTL_MS;
  for (const [state, createdAt] of oauthStates) {
    if (createdAt < threshold) oauthStates.delete(state);
  }
}

export function createTikTokAuthorizationUrl(): string {
  const appConfig = getTikTokAppRuntimeConfig();
  if (!appConfig.appKey || !appConfig.appSecret) {
    throw new Error("请先在设置的“绑定新店铺”向导或 .env 中配置 TikTok Shop 应用密钥。");
  }
  pruneStates();
  const state = randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now());

  // 向导里配置的 Service ID 优先：固定走官方授权页，覆盖 .env 里的旧 AUTH_URL / SERVICE_ID
  const wizardServiceId = appConfig.serviceId?.trim();
  const configured = wizardServiceId ? DEFAULT_TIKTOK_AUTH_URL(wizardServiceId) : process.env.TIKTOK_SHOP_AUTH_URL;
  const serviceId = wizardServiceId || process.env.TIKTOK_SHOP_SERVICE_ID || DEFAULT_SERVICE_ID;
  const url = new URL(configured ?? DEFAULT_TIKTOK_AUTH_URL(serviceId));
  const allowedHosts = new Set(["services.tiktokshop.com", "services.us.tiktokshop.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.pathname !== "/open/authorize") {
    throw new Error("TikTok Shop 授权链接不正确。");
  }
  const resolvedServiceId = url.searchParams.get("service_id") || serviceId;
  if (!/^\d+$/.test(resolvedServiceId)) throw new Error("TikTok Shop service_id 格式不正确。");
  url.searchParams.set("service_id", resolvedServiceId);
  url.searchParams.set("state", state);
  return url.toString();
}

function consumeState(state: string | undefined, browserState: string | undefined) {
  pruneStates();
  if (!state || !browserState || state !== browserState) {
    throw new Error("授权安全校验失败，请从应用的连接按钮重新授权。");
  }
  const createdAt = oauthStates.get(state);
  oauthStates.delete(state);
  if (!createdAt || Date.now() - createdAt > STATE_TTL_MS) throw new Error("授权请求已经过期，请重新开始授权。");
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${label}返回了无法识别的数据，请稍后重试。`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${label}返回的数据格式不完整，请稍后重试。`);
  return parsed.data;
}

async function requestToken(parameters: Record<string, string>): Promise<TikTokTokenData> {
  const { appKey, appSecret } = requireAppCredentials();
  const url = new URL(process.env.TIKTOK_SHOP_TOKEN_URL ?? DEFAULT_TIKTOK_TOKEN_URL);
  // 换取授权码与刷新令牌是两个端点，刷新不能继续请求 /token/get。
  if (parameters.grant_type === "refresh_token") {
    url.pathname = url.pathname.replace(/\/token\/get\/?$/, "/token/refresh");
  }
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("app_secret", appSecret);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error("连接 TikTok Shop 授权服务超时，请重新尝试。");
  }
  const payload = await parseJsonResponse(response, tokenResponseSchema, "TikTok Shop 授权服务");
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message || `TikTok Shop Token 请求失败 (${response.status})`);
  }
  validateFutureExpiry(payload.data.access_token_expire_in, "Access Token 过期时间");
  validateFutureExpiry(payload.data.refresh_token_expire_in, "Refresh Token 过期时间");
  if (payload.data.user_type !== undefined && payload.data.user_type !== 0) {
    throw new Error("当前授权账号不是 Seller 店铺账号，请使用 TikTok Shop 卖家账号授权。");
  }
  if (payload.data.granted_scopes && !payload.data.granted_scopes.includes("seller.authorization.info")) {
    throw new Error("应用缺少 seller.authorization.info 权限，暂时无法读取授权店铺。");
  }
  return payload.data;
}

async function exchangeAuthorizationCode(authCode: string): Promise<TikTokTokenData> {
  return requestToken({ auth_code: authCode, grant_type: "authorized_code" });
}

async function getAuthorizedShops(accessToken: string): Promise<AuthorizedShop[]> {
  const { appKey, appSecret } = requireAppCredentials();
  const client = new TikTokShopClient({
    baseUrl: process.env.TIKTOK_SHOP_BASE_URL ?? DEFAULT_TIKTOK_BASE_URL,
    appKey,
    appSecret,
    accessToken,
  });
  const response = await client.request<unknown>("/authorization/202309/shops", { shopScoped: false });
  const payload = authorizedShopsResponseSchema.safeParse(response);
  if (!payload.success) throw new Error("TikTok Shop 店铺列表返回的数据格式不完整。");
  return (payload.data.data?.shops ?? []).map((shop) => ({
    id: shop.id,
    name: shop.name,
    region: shop.region,
    sellerType: shop.seller_type,
    cipher: shop.cipher,
    code: shop.code,
  }));
}

async function saveBindingsFile(store: TikTokBindingsStore): Promise<void> {
  const filePath = bindingsStorePath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  try {
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function emptyBindingsStore(): TikTokBindingsStore {
  return { version: 2, selected: null, grants: [] };
}

function grantFromLegacy(authorization: z.infer<typeof storedAuthorizationSchema>): TikTokGrant {
  return {
    grantId: randomUUID(),
    accessToken: authorization.accessToken,
    accessTokenExpiresAt: authorization.accessTokenExpiresAt,
    refreshToken: authorization.refreshToken,
    refreshTokenExpiresAt: authorization.refreshTokenExpiresAt,
    openId: authorization.openId,
    sellerName: authorization.sellerName,
    sellerRegion: authorization.sellerRegion,
    userType: authorization.userType,
    grantedScopes: authorization.grantedScopes,
    shops: authorization.shops,
    authorizedAt: authorization.updatedAt,
    updatedAt: authorization.updatedAt,
  };
}

/** v1 → v2 迁移。旧文件保留不删（仅同路径覆盖时先留 .v1.bak），可随时回滚。 */
async function migrateLegacyAuthorization(legacy: z.infer<typeof storedAuthorizationSchema>, sourcePath: string): Promise<TikTokBindingsStore> {
  const grant = grantFromLegacy(legacy);
  const selectedShop = legacy.selectedShopCipher
    ? legacy.shops.find((item) => item.cipher === legacy.selectedShopCipher)
    : undefined;
  const store: TikTokBindingsStore = {
    version: 2,
    selected: selectedShop ? { grantId: grant.grantId, shopId: selectedShop.id } : null,
    grants: [grant],
  };
  if (path.resolve(sourcePath) === bindingsStorePath()) {
    await copyFile(sourcePath, `${sourcePath}.v1.bak`).catch(() => undefined);
  }
  await saveBindingsFile(store);
  return store;
}

async function readLegacyAuthorizationFile(candidate: string): Promise<z.infer<typeof storedAuthorizationSchema> | null> {
  try {
    const parsed = storedAuthorizationSchema.safeParse(JSON.parse(await readFile(candidate, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function loadBindings(): Promise<TikTokBindingsStore> {
  let raw: string;
  try {
    raw = await readFile(bindingsStorePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error("本地 TikTok Shop 绑定文件损坏，请重新授权。");
      throw error;
    }
    raw = "";
  }

  if (raw.trim()) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error("本地 TikTok Shop 绑定文件损坏，请重新授权。");
    }
    const asV2 = bindingsStoreSchema.safeParse(parsedJson);
    if (asV2.success) return asV2.data;
    // 目标路径本身就是 v1 旧文件（如 TIKTOK_SHOP_TOKEN_STORE 指向旧授权文件）：原位迁移
    const asV1 = storedAuthorizationSchema.safeParse(parsedJson);
    if (asV1.success) return migrateLegacyAuthorization(asV1.data, bindingsStorePath());
    throw new Error("本地 TikTok Shop 绑定文件无效，请重新授权。");
  }

  // 全新环境：探测默认位置的 v1 旧授权文件并导入（仅当未用 TIKTOK_SHOP_TOKEN_STORE 重定向存储时）
  if (!process.env.TIKTOK_SHOP_TOKEN_STORE?.trim()) {
    const legacy = await readLegacyAuthorizationFile(legacyTokenStorePath());
    if (legacy) return migrateLegacyAuthorization(legacy, legacyTokenStorePath());
  }
  return emptyBindingsStore();
}

export async function readBindings(): Promise<TikTokBindingsStore> {
  return loadBindings();
}

export async function saveBindings(store: TikTokBindingsStore): Promise<void> {
  await saveBindingsFile(store);
}

/** 当前选中 grant 的 v1 兼容视图；未选择店铺时返回 null */
export async function readStoredAuthorization(): Promise<StoredTikTokAuthorization | null> {
  const store = await readBindings();
  if (!store.selected) return null;
  const active = store.grants.find((item) => item.grantId === store.selected?.grantId);
  if (!active) return null;
  const shop = active.shops.find((item) => item.id === store.selected?.shopId);
  return {
    version: 1,
    accessToken: active.accessToken,
    accessTokenExpiresAt: active.accessTokenExpiresAt,
    refreshToken: active.refreshToken,
    refreshTokenExpiresAt: active.refreshTokenExpiresAt,
    openId: active.openId,
    sellerName: active.sellerName,
    sellerRegion: active.sellerRegion,
    userType: active.userType,
    grantedScopes: active.grantedScopes,
    shops: active.shops,
    selectedShopCipher: shop?.cipher,
    updatedAt: active.updatedAt,
  };
}

async function refreshGrant(grant: TikTokGrant): Promise<TikTokGrant> {
  if (grant.refreshTokenExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error("TikTok Shop Refresh Token 已过期，请重新授权。");
  const token = await requestToken({ refresh_token: grant.refreshToken, grant_type: "refresh_token" });
  const refreshed: TikTokGrant = {
    ...grant,
    accessToken: token.access_token,
    accessTokenExpiresAt: token.access_token_expire_in,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: token.refresh_token_expire_in,
    openId: token.open_id ?? grant.openId,
    sellerName: token.seller_name ?? grant.sellerName,
    sellerRegion: token.seller_base_region ?? grant.sellerRegion,
    userType: token.user_type ?? grant.userType,
    grantedScopes: token.granted_scopes ?? grant.grantedScopes,
    updatedAt: new Date().toISOString(),
  };
  const store = await readBindings();
  await saveBindingsFile({
    ...store,
    grants: store.grants.map((item) => item.grantId === refreshed.grantId ? refreshed : item),
  });
  return refreshed;
}

async function ensureFreshGrant(grant: TikTokGrant): Promise<TikTokGrant> {
  const now = Math.floor(Date.now() / 1000);
  if (grant.accessTokenExpiresAt > now + REFRESH_WINDOW_SECONDS) return grant;
  let promise = refreshPromises.get(grant.grantId);
  if (!promise) {
    promise = refreshGrant(grant).finally(() => refreshPromises.delete(grant.grantId));
    refreshPromises.set(grant.grantId, promise);
  }
  return promise;
}

function findExistingGrantIndex(store: TikTokBindingsStore, token: TikTokTokenData, shops: AuthorizedShop[]): number {
  if (token.open_id) {
    const byOpenId = store.grants.findIndex((grant) => grant.openId === token.open_id);
    if (byOpenId >= 0) return byOpenId;
  }
  // token 未返回 open_id 时按店铺归属判断：同一店铺再次授权视为同一卖家的换绑
  const shopIds = new Set(shops.map((shop) => shop.id));
  return store.grants.findIndex((grant) => grant.shops.some((shop) => shopIds.has(shop.id)));
}

export async function completeTikTokAuthorization(input: { code?: string; state?: string; browserState?: string; error?: string }): Promise<{ shops: AuthorizedShop[]; selectedShop?: AuthorizedShop }> {
  consumeState(input.state, input.browserState);
  if (input.error) throw new Error(input.error === "auth_denied" ? "你取消了 TikTok Shop 授权，店铺没有发生变化。" : `TikTok Shop 授权失败：${input.error}`);
  if (!input.code || input.code === "null") throw new Error("TikTok Shop 没有返回授权码，请重新授权。");

  const token = await exchangeAuthorizationCode(input.code);
  const shops = await getAuthorizedShops(token.access_token);
  if (!shops.length) throw new Error("授权成功，但没有返回可用店铺。请确认应用已启用 seller.authorization.info 权限。");

  const store = await readBindings();
  const nowIso = new Date().toISOString();
  const existingIndex = findExistingGrantIndex(store, token, shops);
  let grantId: string;
  let authorizedAt: string;
  if (existingIndex >= 0) {
    // 换绑：同一卖家账号重新授权，替换原 grant 的令牌与店铺清单
    grantId = store.grants[existingIndex].grantId;
    authorizedAt = store.grants[existingIndex].authorizedAt;
  } else {
    grantId = randomUUID();
    authorizedAt = nowIso;
  }
  const grant: TikTokGrant = {
    grantId,
    accessToken: token.access_token,
    accessTokenExpiresAt: token.access_token_expire_in,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: token.refresh_token_expire_in,
    openId: token.open_id,
    sellerName: token.seller_name,
    sellerRegion: token.seller_base_region,
    userType: token.user_type,
    grantedScopes: token.granted_scopes ?? [],
    shops,
    authorizedAt,
    updatedAt: nowIso,
  };
  const grants = existingIndex >= 0
    ? store.grants.map((item, index) => index === existingIndex ? grant : item)
    : [...store.grants, grant];

  // 选中策略：无选中时单店自动选中；换绑当前账号时尽量保持原选中店铺
  let selected = store.selected;
  if (!selected) {
    const autoShop = shops.length === 1 ? shops[0] : undefined;
    selected = autoShop ? { grantId, shopId: autoShop.id } : null;
  } else if (selected.grantId === grantId) {
    const kept = shops.find((shop) => shop.id === selected?.shopId) ?? shops[0];
    selected = kept ? { grantId, shopId: kept.id } : null;
  }

  await saveBindingsFile({ version: 2, selected, grants });
  refreshPromises.delete(grantId);
  const selectedShop = selected?.shopId ? shops.find((shop) => shop.id === selected?.shopId) : undefined;
  return { shops, selectedShop };
}

export async function selectAuthorizedShop(shopId: string, grantId?: string): Promise<AuthorizedShop> {
  const store = await readBindings();
  let target: { grant: TikTokGrant; shop: AuthorizedShop } | undefined;
  if (grantId) {
    const grant = store.grants.find((item) => item.grantId === grantId);
    const shop = grant?.shops.find((item) => item.id === shopId);
    if (grant && shop) target = { grant, shop };
  }
  if (!target) {
    for (const grant of store.grants) {
      const shop = grant.shops.find((item) => item.id === shopId);
      if (shop) {
        target = { grant, shop };
        break;
      }
    }
  }
  if (!target) throw new Error("没有找到这个已授权店铺。");
  await saveBindingsFile({ ...store, selected: { grantId: target.grant.grantId, shopId: target.shop.id } });
  return target.shop;
}

export async function removeBinding(grantId: string): Promise<void> {
  const store = await readBindings();
  const grants = store.grants.filter((item) => item.grantId !== grantId);
  if (grants.length === store.grants.length) throw new Error("没有找到这个店铺绑定。");
  const selected = store.selected?.grantId === grantId ? null : store.selected;
  await saveBindingsFile({ version: 2, selected, grants });
  refreshPromises.delete(grantId);
}

export function bindingSummaries(store: TikTokBindingsStore): TikTokBindingSummary[] {
  const now = Math.floor(Date.now() / 1000);
  return store.grants.map((grant) => {
    const status: TikTokBindingSummary["status"] = grant.accessTokenExpiresAt > now
      ? "connected"
      : grant.refreshTokenExpiresAt > now ? "expired" : "invalid";
    return {
      grantId: grant.grantId,
      ...(grant.sellerName ? { sellerName: grant.sellerName } : {}),
      ...(grant.sellerRegion ? { sellerRegion: grant.sellerRegion } : {}),
      status,
      expiresAt: grant.accessTokenExpiresAt,
      shops: grant.shops.map(({ id, name, region }) => ({ id, name, region })),
      selectedShopId: store.selected?.grantId === grant.grantId ? store.selected.shopId : undefined,
      authorizedAt: grant.authorizedAt,
    };
  });
}

export async function listBindings(): Promise<TikTokBindingSummary[]> {
  const store = await readBindings();
  return bindingSummaries(store);
}

export async function getAuthorizedTikTokClient(): Promise<TikTokShopClient | null> {
  const store = await readBindings();
  if (!store.grants.length) return TikTokShopClient.fromEnv();
  const active = store.selected ? store.grants.find((item) => item.grantId === store.selected?.grantId) : undefined;
  if (!active) throw new Error("请先在设置中选择要操作的 TikTok Shop 店铺。");
  const fresh = await ensureFreshGrant(active);
  const shop = fresh.shops.find((item) => item.id === store.selected?.shopId);
  if (!shop) throw new Error("已授权多个 TikTok Shop 店铺，请先选择要操作的店铺。");
  const { appKey, appSecret } = requireAppCredentials();
  return new TikTokShopClient({
    baseUrl: process.env.TIKTOK_SHOP_BASE_URL ?? DEFAULT_TIKTOK_BASE_URL,
    appKey,
    appSecret,
    accessToken: fresh.accessToken,
    shopCipher: shop.cipher,
  });
}

export async function getTikTokConnectionStatus(): Promise<TikTokConnectionStatus> {
  const appConfig = getTikTokAppRuntimeConfig();
  if (!appConfig.appKey || !appConfig.appSecret) return { status: "not_configured", connected: false };

  const store = await readBindings();
  const bindings = bindingSummaries(store);
  if (!store.grants.length) {
    const envConnected = Boolean(process.env.TIKTOK_SHOP_ACCESS_TOKEN && process.env.TIKTOK_SHOP_SHOP_CIPHER);
    return envConnected ? { status: "connected", connected: true } : { status: "ready_to_authorize", connected: false };
  }

  const active = store.selected ? store.grants.find((item) => item.grantId === store.selected?.grantId) : undefined;
  if (!active) {
    // 已有绑定但还没选择店铺；单绑定时沿用旧的 shops 列表供选择器直接使用
    const single = store.grants.length === 1 ? store.grants[0] : undefined;
    return {
      status: "shop_selection_required",
      connected: false,
      ...(single ? { expiresAt: single.accessTokenExpiresAt, shops: single.shops.map(({ id, name, region }) => ({ id, name, region })) } : {}),
      bindings,
    };
  }

  let fresh: TikTokGrant;
  try {
    fresh = await ensureFreshGrant(active);
  } catch {
    const shop = active.shops.find((item) => item.id === store.selected?.shopId);
    return { status: "expired", connected: false, shopName: shop?.name, region: shop?.region, expiresAt: active.accessTokenExpiresAt, bindings };
  }

  const shop = fresh.shops.find((item) => item.id === store.selected?.shopId);
  if (!shop) {
    return {
      status: "shop_selection_required",
      connected: false,
      expiresAt: fresh.accessTokenExpiresAt,
      shops: fresh.shops.map(({ id, name, region }) => ({ id, name, region })),
      bindings,
    };
  }
  return { status: "connected", connected: true, shopName: shop.name, region: shop.region, expiresAt: fresh.accessTokenExpiresAt, bindings };
}

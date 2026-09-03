import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TikTokShopClient } from "./tiktok-client.ts";

const DEFAULT_SERVICE_ID = "7660083559697663764";
const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_WINDOW_SECONDS = 5 * 60;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TIKTOK_BASE_URL = "https://open-api.tiktokglobalshop.com";
const DEFAULT_TIKTOK_TOKEN_URL = "https://auth.tiktok-shops.com/api/v2/token/get";
const DEFAULT_TIKTOK_AUTH_URL = (serviceId: string) => `https://services.tiktokshop.com/open/authorize?service_id=${serviceId}`;
const oauthStates = new Map<string, number>();
let refreshPromise: Promise<StoredTikTokAuthorization> | null = null;

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

type TikTokTokenData = z.infer<typeof tokenDataSchema>;

export interface AuthorizedShop {
  id: string;
  name: string;
  region: string;
  sellerType?: string;
  cipher: string;
  code?: string;
}

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

export interface TikTokConnectionStatus {
  status: "not_configured" | "ready_to_authorize" | "shop_selection_required" | "connected" | "expired";
  connected: boolean;
  shopName?: string;
  region?: string;
  expiresAt?: number;
  shops?: Array<{ id: string; name: string; region: string }>;
}

function requireAppCredentials() {
  const appKey = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("请先在 .env 中配置 TikTok Shop 应用密钥和应用密码。");
  return { appKey, appSecret };
}

export function tokenStorePath(): string {
  const configured = process.env.TIKTOK_SHOP_TOKEN_STORE?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), ".data", "tiktok-authorization.json");
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
  requireAppCredentials();
  pruneStates();
  const state = randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now());

  const configured = process.env.TIKTOK_SHOP_AUTH_URL;
  const serviceId = process.env.TIKTOK_SHOP_SERVICE_ID ?? DEFAULT_SERVICE_ID;
  const url = new URL(configured ?? DEFAULT_TIKTOK_AUTH_URL(serviceId));
  const allowedHosts = new Set(["services.tiktokshop.com", "services.us.tiktokshop.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.pathname !== "/open/authorize") {
    throw new Error("TikTok Shop 授权链接不正确。");
  }
  const resolvedServiceId = url.searchParams.get("service_id") ?? serviceId;
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

async function saveAuthorization(authorization: StoredTikTokAuthorization): Promise<void> {
  const filePath = tokenStorePath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  try {
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(authorization, null, 2)}\n`, "utf8");
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

export async function readStoredAuthorization(): Promise<StoredTikTokAuthorization | null> {
  try {
    const raw = await readFile(tokenStorePath(), "utf8");
    const parsed = storedAuthorizationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("本地 TikTok Shop 授权文件无效，请重新授权。");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("本地 TikTok Shop 授权文件损坏，请重新授权。");
    throw error;
  }
}

async function refreshAuthorization(stored: StoredTikTokAuthorization): Promise<StoredTikTokAuthorization> {
  if (stored.refreshTokenExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error("TikTok Shop Refresh Token 已过期，请重新授权。");
  const token = await requestToken({ refresh_token: stored.refreshToken, grant_type: "refresh_token" });
  const refreshed: StoredTikTokAuthorization = {
    ...stored,
    accessToken: token.access_token,
    accessTokenExpiresAt: token.access_token_expire_in,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt: token.refresh_token_expire_in,
    openId: token.open_id ?? stored.openId,
    sellerName: token.seller_name ?? stored.sellerName,
    sellerRegion: token.seller_base_region ?? stored.sellerRegion,
    userType: token.user_type ?? stored.userType,
    grantedScopes: token.granted_scopes ?? stored.grantedScopes,
    updatedAt: new Date().toISOString(),
  };
  await saveAuthorization(refreshed);
  return refreshed;
}

async function ensureFreshAuthorization(stored: StoredTikTokAuthorization): Promise<StoredTikTokAuthorization> {
  const now = Math.floor(Date.now() / 1000);
  if (stored.accessTokenExpiresAt > now + REFRESH_WINDOW_SECONDS) return stored;
  if (!refreshPromise) {
    refreshPromise = refreshAuthorization(stored).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function completeTikTokAuthorization(input: { code?: string; state?: string; browserState?: string; error?: string }): Promise<{ shops: AuthorizedShop[]; selectedShop?: AuthorizedShop }> {
  consumeState(input.state, input.browserState);
  if (input.error) throw new Error(input.error === "auth_denied" ? "你取消了 TikTok Shop 授权，店铺没有发生变化。" : `TikTok Shop 授权失败：${input.error}`);
  if (!input.code || input.code === "null") throw new Error("TikTok Shop 没有返回授权码，请重新授权。");

  const token = await exchangeAuthorizationCode(input.code);
  const shops = await getAuthorizedShops(token.access_token);
  if (!shops.length) throw new Error("授权成功，但没有返回可用店铺。请确认应用已启用 seller.authorization.info 权限。");
  const selectedShop = shops.length === 1 ? shops[0] : undefined;
  await saveAuthorization({
    version: 1,
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
    selectedShopCipher: selectedShop?.cipher,
    updatedAt: new Date().toISOString(),
  });
  refreshPromise = null;
  return { shops, selectedShop };
}

export async function selectAuthorizedShop(shopId: string): Promise<AuthorizedShop> {
  const stored = await readStoredAuthorization();
  if (!stored) throw new Error("尚未完成 TikTok Shop 授权。");
  const shop = stored.shops.find((item) => item.id === shopId);
  if (!shop) throw new Error("没有找到这个已授权店铺。");
  await saveAuthorization({ ...stored, selectedShopCipher: shop.cipher, updatedAt: new Date().toISOString() });
  return shop;
}

export async function getAuthorizedTikTokClient(): Promise<TikTokShopClient | null> {
  const stored = await readStoredAuthorization();
  if (!stored) return TikTokShopClient.fromEnv();
  const fresh = await ensureFreshAuthorization(stored);
  if (!fresh.selectedShopCipher) throw new Error("已授权多个 TikTok Shop 店铺，请先选择要操作的店铺。");
  const { appKey, appSecret } = requireAppCredentials();
  return new TikTokShopClient({
    baseUrl: process.env.TIKTOK_SHOP_BASE_URL ?? DEFAULT_TIKTOK_BASE_URL,
    appKey,
    appSecret,
    accessToken: fresh.accessToken,
    shopCipher: fresh.selectedShopCipher,
  });
}

export async function getTikTokConnectionStatus(): Promise<TikTokConnectionStatus> {
  const appConfigured = Boolean(process.env.TIKTOK_SHOP_APP_KEY && process.env.TIKTOK_SHOP_APP_SECRET);
  if (!appConfigured) return { status: "not_configured", connected: false };

  const stored = await readStoredAuthorization();
  if (!stored) {
    const envConnected = Boolean(process.env.TIKTOK_SHOP_ACCESS_TOKEN && process.env.TIKTOK_SHOP_SHOP_CIPHER);
    return envConnected ? { status: "connected", connected: true } : { status: "ready_to_authorize", connected: false };
  }

  let fresh: StoredTikTokAuthorization;
  try {
    fresh = await ensureFreshAuthorization(stored);
  } catch {
    const selected = stored.shops.find((item) => item.cipher === stored.selectedShopCipher);
    return { status: "expired", connected: false, shopName: selected?.name, region: selected?.region, expiresAt: stored.accessTokenExpiresAt };
  }

  if (!fresh.selectedShopCipher) {
    return {
      status: "shop_selection_required",
      connected: false,
      expiresAt: fresh.accessTokenExpiresAt,
      shops: fresh.shops.map(({ id, name, region }) => ({ id, name, region })),
    };
  }
  const shop = fresh.shops.find((item) => item.cipher === fresh.selectedShopCipher);
  return { status: "connected", connected: true, shopName: shop?.name, region: shop?.region, expiresAt: fresh.accessTokenExpiresAt };
}

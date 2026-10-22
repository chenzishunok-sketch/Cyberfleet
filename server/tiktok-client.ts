import { createHmac } from "node:crypto";

const REQUEST_TIMEOUT_MS = 15_000;

export interface TikTokClientConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  accessToken: string;
  shopCipher?: string;
}

interface TikTokRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string>;
  shopScoped?: boolean;
  /**
   * 网络超时 / 限流 / 5xx 时的重试次数。默认 0。
   * 只有幂等的只读查询应该传这个值；写操作保持 0，避免重复提交。
   */
  retry?: number;
}

export class TikTokConfigurationError extends Error {}

/** 可安全重试的临时性失败（网络超时、限流、服务端 5xx）。 */
export class TikTokTransientError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TikTok Shop 签名算法:
 * 1. 过滤 sign 和 access_token 参数
 * 2. 按 key 字母序排序
 * 3. 拼接 keyvalue 对
 * 4. base = appSecret + path + params + body + appSecret
 * 5. HMAC-SHA256(appSecret, base) → hex
 */
function computeSign(
  appSecret: string,
  path: string,
  query: Record<string, string>,
  body: string,
): string {
  const params = Object.entries(query)
    .filter(([key]) => key !== "sign" && key !== "access_token")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  const base = `${appSecret}${path}${params}${body}${appSecret}`;
  return createHmac("sha256", appSecret).update(base).digest("hex");
}

/**
 * Transport-only TikTok Shop client. Domain services should normalize the
 * versioned API responses before exposing them to agent tools.
 */
export class TikTokShopClient {
  constructor(private readonly config: TikTokClientConfig) {
    const baseUrl = new URL(config.baseUrl);
    const allowedHosts = new Set(["open-api.tiktokglobalshop.com", "open-api.us.tiktokglobalshop.com"]);
    if (baseUrl.protocol !== "https:" || !allowedHosts.has(baseUrl.hostname)) {
      throw new TikTokConfigurationError("TikTok Shop API 地址必须使用官方 HTTPS 域名。");
    }
  }

  static fromEnv(): TikTokShopClient | null {
    const appKey = process.env.TIKTOK_SHOP_APP_KEY;
    const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
    const accessToken = process.env.TIKTOK_SHOP_ACCESS_TOKEN;
    const shopCipher = process.env.TIKTOK_SHOP_SHOP_CIPHER;

    if (!appKey || !appSecret || !accessToken || !shopCipher) return null;

    return new TikTokShopClient({
      baseUrl: process.env.TIKTOK_SHOP_BASE_URL ?? "https://open-api.tiktokglobalshop.com",
      appKey,
      appSecret,
      accessToken,
      shopCipher,
    });
  }

  async request<T>(path: string, options: TikTokRequestOptions = {}): Promise<T> {
    const retries = Math.max(0, Math.min(3, Math.floor(options.retry ?? 0)));
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestOnce<T>(path, options);
      } catch (error) {
        lastError = error;
        if (attempt === retries || !(error instanceof TikTokTransientError)) break;
        // 指数退避 + 抖动，避免多个并发请求在同一时刻一起重试
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(path: string, options: TikTokRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const query = {
      app_key: this.config.appKey,
      timestamp,
      ...(options.shopScoped !== false && this.config.shopCipher ? { shop_cipher: this.config.shopCipher } : {}),
      ...(options.query ?? {}),
    };
    const body = options.body ? JSON.stringify(options.body) : "";
    const sign = this.sign(path, query, body);
    const url = new URL(path, this.config.baseUrl);

    Object.entries({ ...query, sign }).forEach(([key, value]) => url.searchParams.set(key, value));

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-tts-access-token": this.config.accessToken,
        },
        body: method === "GET" || !body ? undefined : body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TikTokTransientError("连接 TikTok Shop API 超时，请稍后重试。");
    }

    let payload: T & { code?: number; message?: string; request_id?: string };
    try {
      payload = (await response.json()) as T & { code?: number; message?: string; request_id?: string };
    } catch {
      throw new Error("TikTok Shop API 返回了无法识别的数据。");
    }
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      const message = payload.message ?? `TikTok Shop API request failed (${response.status})`;
      if (response.status === 429 || response.status >= 500) throw new TikTokTransientError(message);
      throw new Error(message);
    }
    return payload;
  }

  private sign(path: string, query: Record<string, string>, body: string): string {
    return computeSign(this.config.appSecret, path, query, body);
  }
}

// 测试专用导出:暴露签名算法,供单元测试验证
export const __test = { computeSign };

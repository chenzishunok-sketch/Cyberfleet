import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * 轻量登录门。
 *
 * 设计原则：
 * - 只有配置了 APP_PASSWORD 才启用；未配置时完全跳过（本地开发零影响）。
 * - 全部校验在服务端完成，密钥与口令只从环境变量读取，绝不写进仓库。
 * - 会话用 HMAC 签名的时间戳票据，无状态，浏览器持有 HttpOnly Cookie。
 * - 改密码即让所有旧会话失效（密钥由密码派生）。
 * - 未登录时：页面请求跳登录页，API 请求返回 401 JSON。
 */

const LOGIN_PATH = "/__auth/login";
const LOGOUT_PATH = "/__auth/logout";
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME?.trim() || "cyberfleet_session";
const SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL?.trim() || 12 * 60 * 60);
// 免鉴权路径：登录页本身、健康检查（供托管平台探活，只暴露连接布尔值）
const PUBLIC_PATHS = new Set([LOGIN_PATH, LOGOUT_PATH, "/api/health", "/favicon.ico"]);

// 登录失败限流：同一 IP 10 分钟内最多 10 次失败
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; resetAt: number }>();

function configuredPassword(): string {
  return process.env.APP_PASSWORD?.trim() ?? "";
}

function sessionSecret(): string {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  // 无独立密钥时由口令派生：换口令即换密钥，旧票据自动作废
  return createHmac("sha256", "cyberfleet-auth-gate-v1").update(configuredPassword()).digest("hex");
}

function sign(expiresAt: number): string {
  return createHmac("sha256", sessionSecret()).update(String(expiresAt)).digest("base64url");
}

function issueToken(): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sign(expiresAt)}`;
}

function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  const [expiresPart, signature] = token.split(".");
  if (!expiresPart || !signature) return false;
  const expiresAt = Number(expiresPart);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  const expected = Buffer.from(sign(expiresAt));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function passwordMatches(input: string): boolean {
  const expected = Buffer.from(configuredPassword());
  const actual = Buffer.from(input);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function isSecureRequest(request: Request): boolean {
  if (request.secure) return true;
  // 反向代理（如云托管）终止 TLS 时，靠转发头判断，避免 Secure Cookie 被浏览器丢弃
  return (request.headers["x-forwarded-proto"] ?? "").toString().split(",")[0].trim() === "https";
}

function buildCookie(request: Request, token: string, maxAge: number): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function sanitizeNext(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  // 只接受站内绝对路径，挡住 //evil.com 这类开放重定向
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function clientKey(request: Request): string {
  const forwarded = (request.headers["x-forwarded-for"] ?? "").toString().split(",")[0].trim();
  return forwarded || request.ip || "unknown";
}

function isRateLimited(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c] as string);
}

function renderLoginPage(options: { next: string; error?: string; locked?: boolean }): string {
  const errorBlock = options.locked
    ? '<p class="error">尝试次数过多，请 10 分钟后再试。</p>'
    : options.error
      ? `<p class="error">${escapeHtml(options.error)}</p>`
      : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>登录 · 跨境电商多Agent协同系统</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111113;color:#e8e8ea;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  main{width:min(380px,calc(100% - 40px));padding:36px 32px;background:#1a1a1e;
       border:1px solid #2a2a30;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:24px}
  .dot{width:10px;height:10px;border-radius:50%;background:#4ade80;box-shadow:0 0 12px #4ade80}
  h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.2px}
  p.sub{margin:0 0 22px;color:#8b8b95;font-size:13px}
  label{display:block;margin-bottom:8px;font-size:13px;color:#a8a8b3}
  input[type=password]{width:100%;padding:11px 13px;border-radius:9px;border:1px solid #33333c;
       background:#0f0f12;color:#e8e8ea;font-size:15px;outline:none;transition:border-color .15s}
  input[type=password]:focus{border-color:#5b5bd6}
  button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:9px;cursor:pointer;
       background:#5b5bd6;color:#fff;font-size:15px;font-weight:600;transition:background .15s}
  button:hover{background:#6e6ee0}
  .error{margin:0 0 16px;padding:9px 12px;border-radius:8px;background:#2a1618;color:#ff9b9b;
       border:1px solid #48232a;font-size:13px}
  footer{margin-top:20px;color:#5f5f6a;font-size:12px;text-align:center}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="dot"></span><h1>跨境电商多Agent协同系统</h1></div>
  <p class="sub">该工作台包含店铺经营数据与写操作权限，请先验证身份。</p>
  ${errorBlock}
  <form method="post" action="${LOGIN_PATH}">
    <input type="hidden" name="next" value="${escapeHtml(options.next)}" />
    <label for="password">访问口令</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required placeholder="请输入访问口令" />
    <button type="submit">进入工作台</button>
  </form>
  <footer>会话有效期 ${Math.round(SESSION_TTL_SECONDS / 3600)} 小时</footer>
</main>
</body>
</html>`;
}

export function isAuthEnabled(): boolean {
  return configuredPassword().length > 0;
}

/**
 * 注册登录相关路由与鉴权中间件。
 * 必须在业务路由、静态资源之前调用。
 */
export function installAuthGate(app: Express): void {
  if (!isAuthEnabled()) return;

  app.get(LOGIN_PATH, (request: Request, response: Response) => {
    const next = sanitizeNext(request.query.next);
    if (isValidToken(readCookie(request.headers.cookie, COOKIE_NAME))) {
      response.redirect(next);
      return;
    }
    response.set("Cache-Control", "no-store").type("html").send(renderLoginPage({ next }));
  });

  app.post(LOGIN_PATH, (request: Request, response: Response) => {
    const next = sanitizeNext(request.body?.next);
    const key = clientKey(request);

    if (isRateLimited(key)) {
      response.status(429).type("html").send(renderLoginPage({ next, locked: true }));
      return;
    }

    const submitted = typeof request.body?.password === "string" ? request.body.password : "";
    if (!passwordMatches(submitted)) {
      recordFailure(key);
      response.status(401).type("html").send(renderLoginPage({ next, error: "口令不正确，请重试。" }));
      return;
    }

    failures.delete(key);
    response.set("Set-Cookie", buildCookie(request, issueToken(), SESSION_TTL_SECONDS));
    response.redirect(next);
  });

  app.post(LOGOUT_PATH, (request: Request, response: Response) => {
    response.set("Set-Cookie", buildCookie(request, "", 0));
    response.redirect(LOGIN_PATH);
  });

  const gate: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    const path = request.path;
    if (PUBLIC_PATHS.has(path)) return next();
    if (isValidToken(readCookie(request.headers.cookie, COOKIE_NAME))) return next();

    if (path === "/api" || path.startsWith("/api/")) {
      response.status(401).json({ error: "未登录或会话已过期，请先登录。" });
      return;
    }
    const target = request.method === "GET" ? request.originalUrl : "/";
    response.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(target)}`);
  };

  app.use(gate);
}

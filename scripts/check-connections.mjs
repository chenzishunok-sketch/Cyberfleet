#!/usr/bin/env node
/**
 * 连接体检：逐个平台确认「是否配置」与「是否连通」。
 *
 * 用法：先 npm run dev 启动本地服务，再另开一个终端执行 npm run check:conn
 * 退出码：0 = 关键项就绪；1 = 还有关键项未配置（真实模式 / LLM）
 *
 * 只读本地 /api/health，不发任何写请求，不会影响店铺。
 */

const port = process.env.PORT?.trim() || "8795";
const base = process.env.HEALTH_BASE?.trim() || `http://127.0.0.1:${port}`;
const url = `${base}/api/health`;

const ICON = { ok: "✅", warn: "⚠️ ", bad: "❌" };

function line(status, name, detail, hint) {
  const prefix = `${ICON[status]} ${name.padEnd(12, " ")}`;
  const hintText = hint && status !== "ok" ? `\n               → ${hint}` : "";
  console.log(`${prefix} ${detail}${hintText}`);
}

async function main() {
  let health;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (error) {
    console.log(`${ICON.bad} 连不上本地服务 ${url}`);
    console.log("               → 先在项目目录执行 npm run dev，等服务起来再测");
    console.log(`               → (${error instanceof Error ? error.message : String(error)})`);
    process.exit(1);
  }

  const mode = health.mode ?? "unknown";
  const llm = health.llm ?? {};
  const tiktok = health.tiktok ?? {};
  const miaoshou = health.miaoshou ?? {};
  const tmapi = health.tmapi ?? {};
  const feishu = health.feishu ?? {};
  const auth = health.auth ?? {};

  console.log("");
  console.log("── 连接体检 ───────────────────────────────────────");

  line("ok", "运行模式", `真实模式（${mode}）`);

  line(llm.connected ? "ok" : "bad", "LLM 接口",
    llm.connected
      ? `${llm.name ?? llm.source ?? "已配置"}${llm.model ? ` / ${llm.model}` : ""}`
      : "未配置或不可用（Agent 无法工作）",
    "填 .env 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，或到设置页用向导添加");

  line(tiktok.connected ? "ok" : "warn", "TikTok Shop",
    tiktok.connected
      ? `${tiktok.shopName ?? "已连接"}${tiktok.region ? ` / ${tiktok.region}` : ""}`
      : `未连接（${tiktok.status ?? "unknown"}）`,
    "先填 TIKTOK_SHOP_APP_KEY / APP_SECRET，再到「设置 → 绑定新店铺」完成 OAuth 授权");

  line(miaoshou.connected ? "ok" : "warn", "妙手 ERP",
    miaoshou.connected ? "已连接" : "未配置（浏览不受影响，采集/上架不可用）",
    "填 MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET");

  line(tmapi.connected ? "ok" : "warn", "TMAPI 1688",
    tmapi.connected ? "已连接" : "未配置（1688 搜货源不可用）",
    "填 TMAPI_API_TOKEN");

  line(feishu.configured ? "ok" : "warn", "飞书",
    feishu.configured
      ? `已配置${feishu.connected ? "，长连接正常" : "，长连接未建立"}`
      : "未配置（审批通知推不到手机）",
    "填 FEISHU_APP_ID / FEISHU_APP_SECRET");

  console.log("");
  if (auth.enabled) {
    line("ok", "访问口令", "已开启（本机打开也要登录）");
  } else {
    line("warn", "访问口令", "未开启（仅本机运行可以接受）",
      "若要公网访问，在 .env 设置 APP_PASSWORD 后重新发布");
  }

  const criticalOk = mode !== "demo" && Boolean(llm.connected);
  console.log("");
  if (criticalOk) {
    console.log(`${ICON.ok} 关键项就绪：真实模式 + LLM 可用，可以开始真实调用了。`);
  } else {
    console.log(`${ICON.bad} 还有关键项没配好，先按上面的提示补齐再试。`);
  }
  console.log("");
  process.exit(criticalOk ? 0 : 1);
}

void main();

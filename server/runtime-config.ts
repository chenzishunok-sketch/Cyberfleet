import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface StoredSkillState {
  config?: Record<string, string>;
}

interface SkillsStore {
  [skillId: string]: StoredSkillState | undefined;
}

export interface TikTokAppRuntimeConfig {
  appKey: string;
  appSecret: string;
  /** 服务市场 Service ID，决定授权页；向导配置优先于 .env 的 TIKTOK_SHOP_SERVICE_ID */
  serviceId: string;
  source: "skill" | "env" | "missing";
}

export interface MiaoshouRuntimeConfig {
  appKey: string;
  appSecret: string;
  baseUrl: string;
  source: "skill" | "env" | "missing";
}

export interface TmapiRuntimeConfig {
  apiToken: string;
  baseUrl: string;
  source: "skill" | "env" | "missing";
}

export interface WebSearchRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  source: "skill" | "env" | "missing";
}

export interface ChuhaijiangRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  source: "skill" | "env" | "missing";
}

export interface FeishuRuntimeConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  source: "skill" | "env" | "missing";
}

export interface FastMossRuntimeConfig {
  apiKey: string;
  mcpUrl: string;
  source: "skill" | "env" | "missing";
}

// 每次对话都可能读取技能凭据：按 mtime 缓存，避免重复同步读盘解析
let skillsCache: { mtimeMs: number; store: SkillsStore } | undefined;

function skillsStorePath(): string {
  // SKILLS_STORE 供测试隔离使用；默认仍是项目 .data/skills.json
  const configured = process.env.SKILLS_STORE?.trim();
  return configured || join(process.cwd(), ".data", "skills.json");
}

function storedSkillConfig(skillId: string): Record<string, string> {
  const path = skillsStorePath();
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!skillsCache || skillsCache.mtimeMs !== mtimeMs) {
      skillsCache = { mtimeMs, store: JSON.parse(readFileSync(path, "utf8")) as SkillsStore };
    }
    return skillsCache.store[skillId]?.config ?? {};
  } catch {
    skillsCache = undefined;
    return {};
  }
}

/**
 * TikTok Shop 开发者应用凭证（App Key / App Secret）。
 * 优先读设置页向导保存的 skill 配置，回退 .env；向导保存后无需重启即可发起授权。
 */
export function getTikTokAppRuntimeConfig(): TikTokAppRuntimeConfig {
  const stored = storedSkillConfig("tiktok-shop");
  const storedAppKey = stored.appKey?.trim();
  const storedAppSecret = stored.appSecret?.trim();
  const storedServiceId = stored.serviceId?.trim() ?? "";
  if (storedAppKey && storedAppSecret) {
    return { appKey: storedAppKey, appSecret: storedAppSecret, serviceId: storedServiceId, source: "skill" };
  }

  const appKey = process.env.TIKTOK_SHOP_APP_KEY?.trim() ?? "";
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET?.trim() ?? "";
  return {
    appKey,
    appSecret,
    // 向导里只补填 Service ID 时同样生效（凭证继续走 .env）
    serviceId: storedServiceId || process.env.TIKTOK_SHOP_SERVICE_ID?.trim() || "",
    source: appKey && appSecret ? "env" : "missing",
  };
}

export function getMiaoshouRuntimeConfig(): MiaoshouRuntimeConfig {
  const stored = storedSkillConfig("miaoshou");
  const storedAppKey = stored.appKey?.trim();
  const storedAppSecret = stored.appSecret?.trim();
  if (storedAppKey && storedAppSecret) {
    return {
      appKey: storedAppKey,
      appSecret: storedAppSecret,
      baseUrl: stored.baseUrl?.trim() || "https://openapi-erp.91miaoshou.com",
      source: "skill",
    };
  }

  const appKey = process.env.MIAOSHOU_APP_KEY?.trim() ?? "";
  const appSecret = process.env.MIAOSHOU_APP_SECRET?.trim() ?? "";
  return {
    appKey,
    appSecret,
    baseUrl: process.env.MIAOSHOU_BASE_URL?.trim() || "https://openapi-erp.91miaoshou.com",
    source: appKey && appSecret ? "env" : "missing",
  };
}

export function getTmapiRuntimeConfig(): TmapiRuntimeConfig {
  const stored = storedSkillConfig("tmapi-1688");
  const storedApiToken = stored.apiToken?.trim();
  if (storedApiToken) {
    return {
      apiToken: storedApiToken,
      baseUrl: stored.baseUrl?.trim() || "http://api.tmapi.top",
      source: "skill",
    };
  }

  const apiToken = process.env.TMAPI_API_TOKEN?.trim() ?? "";
  return {
    apiToken,
    baseUrl: process.env.TMAPI_BASE_URL?.trim() || "http://api.tmapi.top",
    source: apiToken ? "env" : "missing",
  };
}

export function getWebSearchRuntimeConfig(): WebSearchRuntimeConfig {
  const stored = storedSkillConfig("web-search");
  const storedApiKey = stored.apiKey?.trim();
  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      baseUrl: stored.baseUrl?.trim() || "https://api.tavily.com",
      source: "skill",
    };
  }

  const apiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
  return {
    apiKey,
    baseUrl: process.env.TAVILY_BASE_URL?.trim() || "https://api.tavily.com",
    source: apiKey ? "env" : "missing",
  };
}

/**
 * 出海匠 MCP 凭据（sk_live_ 开头的 API Key）。
 * 端点固定为出海匠 MCP Gateway：https://mcp.gateway.chuhaijiang.com/mcp（streamable HTTP）
 */
export function getChuhaijiangRuntimeConfig(): ChuhaijiangRuntimeConfig {
  const stored = storedSkillConfig("chuhaijiang");
  const storedApiKey = stored.apiKey?.trim();
  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      baseUrl: stored.baseUrl?.trim() || "https://mcp.gateway.chuhaijiang.com/mcp",
      source: "skill",
    };
  }

  const apiKey = process.env.CHUHAIJIANG_API_KEY?.trim() ?? "";
  return {
    apiKey,
    baseUrl: process.env.CHUHAIJIANG_MCP_URL?.trim() || "https://mcp.gateway.chuhaijiang.com/mcp",
    source: apiKey ? "env" : "missing",
  };
}

export function getFeishuRuntimeConfig(): FeishuRuntimeConfig {
  const stored = storedSkillConfig("feishu");
  const storedAppId = stored.appId?.trim();
  const storedAppSecret = stored.appSecret?.trim();
  if (storedAppId && storedAppSecret) {
    return {
      appId: storedAppId,
      appSecret: storedAppSecret,
      baseUrl: stored.baseUrl?.trim() || "https://open.feishu.cn/open-apis",
      source: "skill",
    };
  }

  const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
  return {
    appId,
    appSecret,
    baseUrl: process.env.FEISHU_BASE_URL?.trim() || "https://open.feishu.cn/open-apis",
    source: appId && appSecret ? "env" : "missing",
  };
}

export function getFastMossRuntimeConfig(): FastMossRuntimeConfig {
  const stored = storedSkillConfig("fastmoss");
  const storedApiKey = stored.apiKey?.trim();
  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      mcpUrl: stored.mcpUrl?.trim() || "https://mcp.fastmoss.com/mcp",
      source: "skill",
    };
  }

  const apiKey = process.env.FASTMOSS_API_KEY?.trim() ?? "";
  return {
    apiKey,
    mcpUrl: process.env.FASTMOSS_MCP_URL?.trim() || "https://mcp.fastmoss.com/mcp",
    source: apiKey ? "env" : "missing",
  };
}

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface StoredSkillState {
  config?: Record<string, string>;
}

interface SkillsStore {
  [skillId: string]: StoredSkillState | undefined;
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

// 每次对话都可能读取技能凭据：按 mtime 缓存，避免重复同步读盘解析
let skillsCache: { mtimeMs: number; store: SkillsStore } | undefined;

function storedSkillConfig(skillId: string): Record<string, string> {
  const path = join(process.cwd(), ".data", "skills.json");
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

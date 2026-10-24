import { chmod, readFile, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path, { join } from "node:path";
import type {
  SkillDefinition,
  SkillStatus,
  SkillsCatalogResponse,
  SkillConfigField,
} from "../shared/contracts.ts";
import { getFastMossTools, resetFastMossConnection } from "./mcp-client.ts";
import { getChuhaijiangTools, resetChuhaijiangConnection } from "./chuhaijiang-client.ts";
import { clearFeishuTokenCache } from "./feishu-client.ts";
import {
  getChuhaijiangRuntimeConfig,
  getFastMossRuntimeConfig,
  getFeishuRuntimeConfig,
  getMiaoshouRuntimeConfig,
  getTikTokAppRuntimeConfig,
  getTmapiRuntimeConfig,
  getWebSearchRuntimeConfig,
} from "./runtime-config.ts";
import { getTikTokConnectionStatus } from "./tiktok-auth.ts";

// ─── 内置 Skill 定义 ──────────────────────────────────────────

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "tiktok-shop",
    name: "TikTok Shop",
    description: "TikTok Shop 官方 API，提供商品、订单、履约、财务、促销、售后等全链路运营能力。",
    icon: "ShoppingBag",
    version: "1.0.0",
    category: "analytics",
    configFields: [
      { key: "appKey", label: "App Key", type: "text", required: true, placeholder: "TikTok Shop Partner Center 的 App Key" },
      { key: "appSecret", label: "App Secret", type: "password", required: true, placeholder: "TikTok Shop Partner Center 的 App Secret" },
      { key: "serviceId", label: "Service ID", type: "text", required: false, placeholder: "应用市场服务 ID（纯数字），决定授权页；留空用默认" },
    ],
    builtin: true,
    scenes: [
      "market", "analytics", "catalog", "global", "orders",
      "fulfillment", "logistics", "aftersales", "finance", "promotions", "shop",
    ],
  },
  {
    id: "miaoshou",
    name: "货源采集与上架",
    description: "提供 1688 货源采集、AI 类目匹配、产品翻译、一键上架 TikTok、采购管理等能力。",
    icon: "PackagePlus",
    version: "1.0.0",
    category: "collection",
    configFields: [
      { key: "appKey", label: "App Key", type: "text", required: true, placeholder: "采集上架服务 App Key" },
      { key: "appSecret", label: "App Secret", type: "password", required: true, placeholder: "采集上架服务 App Secret" },
      { key: "baseUrl", label: "API 地址", type: "url", required: false, placeholder: "采集上架服务 API 地址" },
    ],
    builtin: true,
    scenes: [
      "collect_item", "common_collect_box", "tiktok_collect_box",
      "tiktok_categories", "ai_match_category", "supplement_info", "claim_to_platform",
      "miaoshou_shops",
      "publish_to_tiktok", "publish_records", "price_templates",
      "miaoshou_packages", "miaoshou_returns", "miaoshou_purchase_orders", "miaoshou_inventory",
    ],
  },
  {
    id: "tmapi-1688",
    name: "1688 货源数据",
    description: "1688 商品数据，用于读取真实商品详情、SKU、采购价、库存、重量和供应商信息。",
    icon: "PackageSearch",
    version: "1.0.0",
    category: "collection",
    configFields: [
      { key: "apiToken", label: "API Token", type: "password", required: true, placeholder: "1688 货源数据 API Token" },
      { key: "baseUrl", label: "API 地址", type: "url", required: false, placeholder: "1688 货源数据 API 地址" },
    ],
    builtin: true,
    scenes: ["item_detail", "item_detail_by_url", "supplier_product_snapshot"],
  },
  {
    id: "web-search",
    name: "互联网搜索",
    description: "联网检索最新平台政策、市场趋势、竞品和行业资料，回答保留标题、时间和原始网址。",
    icon: "Globe2",
    version: "1.0.0",
    category: "analytics",
    configFields: [
      { key: "apiKey", label: "Tavily API Key", type: "password", required: true, placeholder: "tvly-..." },
      { key: "baseUrl", label: "API 地址", type: "url", required: false, placeholder: "https://api.tavily.com" },
    ],
    builtin: true,
    scenes: ["web_search", "news_search", "policy_research", "competitor_research"],
  },
  {
    id: "chuhaijiang",
    name: "日区选品数据",
    description: "TikTok 日区电商数据（MCP），提供爆品搜索、商品详情、关联商品、达人、视频、店铺、广告、直播数据与 Amazon 交叉验证。",
    icon: "Radar",
    version: "1.0.0",
    category: "analytics",
    configFields: [
      { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk_live_..." },
      { key: "baseUrl", label: "MCP 地址", type: "url", required: false, placeholder: "MCP 网关地址" },
    ],
    builtin: true,
    scenes: [
      "chuhaijiang_search", "chuhaijiang_detail", "chuhaijiang_related", "chuhaijiang_amazon",
    ],
  },
  {
    id: "feishu",
    name: "飞书",
    description: "飞书企业自建应用：DAG 审批与结果通知、定时日报推送、飞书消息机器人（长连接）。消息接收人（FEISHU_NOTIFY_CHAT_ID）仍在 .env 配置。",
    icon: "MessageSquare",
    version: "1.0.0",
    category: "fulfillment",
    configFields: [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "cli_ 开头的应用 ID" },
      { key: "appSecret", label: "App Secret", type: "password", required: true, placeholder: "飞书开放平台应用密钥" },
      { key: "baseUrl", label: "API 地址", type: "url", required: false, placeholder: "https://open.feishu.cn/open-apis" },
    ],
    builtin: true,
    scenes: ["feishu_notify", "feishu_report", "feishu_bridge"],
  },
  {
    id: "fastmoss",
    name: "FastMoss 数据分析",
    description: "FastMoss TikTok 数据分析 MCP：爆品、达人、店铺、直播、视频等数据分析工具，注入对话与选品流程。",
    icon: "BarChartBig",
    version: "1.0.0",
    category: "analytics",
    configFields: [
      { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "FastMoss 数据平台 API Key" },
      { key: "mcpUrl", label: "MCP 地址", type: "url", required: false, placeholder: "https://mcp.fastmoss.com/mcp" },
    ],
    builtin: true,
    scenes: ["fastmoss_tools"],
  },
];

// ─── 持久化存储 ───────────────────────────────────────────────

interface StoredSkillState {
  installed: boolean;
  enabled: boolean;
  config: Record<string, string>;
}

interface SkillsStore {
  [skillId: string]: StoredSkillState;
}

const DATA_DIR = join(process.cwd(), ".data");
// 每次调用时解析（而非模块加载时固化），与 runtime-config 的 SKILLS_STORE 语义保持一致，测试隔离才生效
function skillsFilePath(): string {
  return process.env.SKILLS_STORE?.trim() || join(DATA_DIR, "skills.json");
}

// 内存缓存：对话流程每次都会调用 getEnabledSkills/getSkillTools，
// 原实现每次都读盘 5+ 次 I/O。缓存后只有首次或写后才读盘。
let cachedStore: SkillsStore | undefined;
let storeReadPromise: Promise<SkillsStore> | undefined;

async function readStore(): Promise<SkillsStore> {
  if (cachedStore) return cachedStore;
  if (storeReadPromise) return storeReadPromise;
  storeReadPromise = (async () => {
    try {
      const content = await readFile(skillsFilePath(), "utf-8");
      const parsed: unknown = JSON.parse(content);
      // JSON.parse 成功不代表是我们要的结构：文件里是 null / 数组时照样解析得动，
      // 但后面 store[key] 会直接抛 TypeError。只认普通对象。
      cachedStore = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SkillsStore) : {};
    } catch {
      cachedStore = {};
    }
    storeReadPromise = undefined;
    return cachedStore;
  })();
  return storeReadPromise;
}

async function writeStore(store: SkillsStore): Promise<void> {
  const skillsFile = skillsFilePath();
  const directory = path.dirname(skillsFile);
  const temporaryPath = `${skillsFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await mkdir(directory, { recursive: true });
  // 先写临时文件再原子替换：skills.json 里存着第三方密钥，
  // 直接覆盖时进程被杀会留下半个 JSON，下次启动所有连接器配置全丢。
  try {
    const file = await open(temporaryPath, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, skillsFile);
    await chmod(skillsFile, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  // 落盘成功后才更新缓存：写失败时不能假装已经保存
  cachedStore = store;
  // 配置变更后清除能力描述和工具缓存，下次读取时重建
  cachedSkillTools = undefined;
  cachedAbilityDesc = undefined;
  // 连接器模块级缓存同步失效：换绑/解绑后下一条业务请求立即使用新凭证
  clearFeishuTokenCache();
  resetChuhaijiangConnection();
  resetFastMossConnection();
}

// ─── 核心逻辑 ─────────────────────────────────────────────────

function isConfigured(skill: SkillDefinition, config: Record<string, string>): boolean {
  return skill.configFields
    .filter((field) => field.required)
    .every((field) => Boolean(config[field.key]?.trim()));
}

function getStoredState(store: SkillsStore, skillId: string): StoredSkillState {
  return store[skillId] ?? { installed: false, enabled: false, config: {} };
}

function maskConfig(skill: SkillDefinition, config: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const field of skill.configFields) {
    const value = config[field.key];
    if (!value) {
      masked[field.key] = "";
    } else if (field.type === "password") {
      masked[field.key] = value.length > 4 ? `${value.slice(0, 2)}${"*".repeat(value.length - 4)}${value.slice(-2)}` : "****";
    } else {
      masked[field.key] = value;
    }
  }
  return masked;
}

export async function getSkillsCatalog(): Promise<SkillsCatalogResponse> {
  const store = await readStore();
  const miaoshouConfig = getMiaoshouRuntimeConfig();
  const tmapiConfig = getTmapiRuntimeConfig();
  const webSearchConfig = getWebSearchRuntimeConfig();
  const chuhaijiangConfig = getChuhaijiangRuntimeConfig();
  const tiktokConnection = await getTikTokConnectionStatus().catch(() => ({ connected: false as const }));

  const statuses = BUILTIN_SKILLS.map((skill) => {
    const storedEntry = store[skill.id];
    const stored = getStoredState(store, skill.id);
    const enabled = skill.builtin ? (storedEntry?.enabled !== false) : stored.enabled;
    if (skill.id === "tiktok-shop") {
      const appConfig = getTikTokAppRuntimeConfig();
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured: tiktokConnection.connected,
        config: maskConfig(skill, { appKey: appConfig.appKey, appSecret: appConfig.appSecret, serviceId: appConfig.serviceId }),
        connectionState: tiktokConnection.connected ? "connected" as const : "not_configured" as const,
        configSource: tiktokConnection.connected
          ? "oauth" as const
          : appConfig.source === "missing" ? "none" as const : appConfig.source,
      };
    }
    if (skill.id === "miaoshou") {
      const effectiveConfig = {
        appKey: miaoshouConfig.appKey,
        appSecret: miaoshouConfig.appSecret,
        baseUrl: miaoshouConfig.baseUrl,
      };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: miaoshouConfig.source === "missing" ? "none" as const : miaoshouConfig.source,
      };
    }
    if (skill.id === "tmapi-1688") {
      const effectiveConfig = { apiToken: tmapiConfig.apiToken, baseUrl: tmapiConfig.baseUrl };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: tmapiConfig.source === "missing" ? "none" as const : tmapiConfig.source,
      };
    }
    if (skill.id === "web-search") {
      const effectiveConfig = { apiKey: webSearchConfig.apiKey, baseUrl: webSearchConfig.baseUrl };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: webSearchConfig.source === "missing" ? "none" as const : webSearchConfig.source,
      };
    }
    if (skill.id === "chuhaijiang") {
      const effectiveConfig = { apiKey: chuhaijiangConfig.apiKey, baseUrl: chuhaijiangConfig.baseUrl };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: chuhaijiangConfig.source === "missing" ? "none" as const : chuhaijiangConfig.source,
      };
    }
    if (skill.id === "feishu") {
      const feishuConfig = getFeishuRuntimeConfig();
      const effectiveConfig = { appId: feishuConfig.appId, appSecret: feishuConfig.appSecret, baseUrl: feishuConfig.baseUrl };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: feishuConfig.source === "missing" ? "none" as const : feishuConfig.source,
      };
    }
    if (skill.id === "fastmoss") {
      const fastMossConfig = getFastMossRuntimeConfig();
      const effectiveConfig = { apiKey: fastMossConfig.apiKey, mcpUrl: fastMossConfig.mcpUrl };
      const configured = isConfigured(skill, effectiveConfig);
      return {
        id: skill.id,
        installed: true,
        enabled,
        configured,
        config: maskConfig(skill, effectiveConfig),
        connectionState: configured ? "configured" as const : "not_configured" as const,
        configSource: fastMossConfig.source === "missing" ? "none" as const : fastMossConfig.source,
      };
    }
    return {
      id: skill.id,
      installed: skill.builtin ? true : stored.installed,
      enabled,
      configured: skill.configFields.length === 0 || isConfigured(skill, stored.config),
      config: maskConfig(skill, stored.config),
    };
  });

  return { skills: BUILTIN_SKILLS, statuses };
}

export async function installSkill(skillId: string): Promise<SkillStatus> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);

  const store = await readStore();
  store[skillId] = {
    ...getStoredState(store, skillId),
    installed: true,
    enabled: true,
  };
  await writeStore(store);

  const status = getStoredState(store, skillId);
  return {
    id: skillId,
    installed: true,
    enabled: status.enabled,
    configured: skill.configFields.length === 0 || isConfigured(skill, status.config),
    config: maskConfig(skill, status.config),
  };
}

export async function uninstallSkill(skillId: string): Promise<void> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);
  if (skill.builtin) throw new Error("内置 Skill 不能卸载，只能禁用。");

  const store = await readStore();
  delete store[skillId];
  await writeStore(store);
}

export async function enableSkill(skillId: string): Promise<SkillStatus> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);

  const store = await readStore();
  store[skillId] = { ...getStoredState(store, skillId), installed: true, enabled: true };
  await writeStore(store);

  const status = getStoredState(store, skillId);
  return {
    id: skillId,
    installed: true,
    enabled: true,
    configured: skill.configFields.length === 0 || isConfigured(skill, status.config),
    config: maskConfig(skill, status.config),
  };
}

export async function disableSkill(skillId: string): Promise<SkillStatus> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);

  const store = await readStore();
  store[skillId] = { ...getStoredState(store, skillId), enabled: false };
  await writeStore(store);

  const status = getStoredState(store, skillId);
  return {
    id: skillId,
    installed: status.installed,
    enabled: false,
    configured: skill.configFields.length === 0 || isConfigured(skill, status.config),
    config: maskConfig(skill, status.config),
  };
}

/** 解绑：清除界面保存的配置，回落 .env（保留启用状态）；连接器缓存随 writeStore 一并失效 */
export async function clearSkillConfig(skillId: string): Promise<void> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);
  if (skillId === "tiktok-shop") throw new Error("TikTok 店铺请在「店铺绑定」区管理。");

  const store = await readStore();
  const entry = store[skillId];
  if (!entry || Object.keys(entry.config ?? {}).length === 0) {
    throw new Error("该服务没有界面保存的配置（当前生效的是 .env 配置，如需更换请在 .env 中修改）。");
  }
  store[skillId] = { ...getStoredState(store, skillId), config: {} };
  await writeStore(store);
}

export async function updateSkillConfig(
  skillId: string,
  config: Record<string, string>,
): Promise<SkillStatus> {
  const skill = BUILTIN_SKILLS.find((s) => s.id === skillId);
  if (!skill) throw new Error(`未知 Skill：${skillId}`);

  const store = await readStore();
  const existingEntry = store[skillId];
  const current = getStoredState(store, skillId);
  let runtimeBaseline: Record<string, string> = {};
  if (skillId === "tiktok-shop") {
    const runtime = getTikTokAppRuntimeConfig();
    if (runtime.source !== "missing" || runtime.serviceId) {
      runtimeBaseline = { appKey: runtime.appKey, appSecret: runtime.appSecret, serviceId: runtime.serviceId };
    }
  }
  if (skillId === "miaoshou") {
    const runtime = getMiaoshouRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { appKey: runtime.appKey, appSecret: runtime.appSecret, baseUrl: runtime.baseUrl };
    }
  }
  if (skillId === "tmapi-1688") {
    const runtime = getTmapiRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { apiToken: runtime.apiToken, baseUrl: runtime.baseUrl };
    }
  }
  if (skillId === "web-search") {
    const runtime = getWebSearchRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl };
    }
  }
  if (skillId === "chuhaijiang") {
    const runtime = getChuhaijiangRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl };
    }
  }
  if (skillId === "feishu") {
    const runtime = getFeishuRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { appId: runtime.appId, appSecret: runtime.appSecret, baseUrl: runtime.baseUrl };
    }
  }
  if (skillId === "fastmoss") {
    const runtime = getFastMossRuntimeConfig();
    if (runtime.source !== "missing") {
      runtimeBaseline = { apiKey: runtime.apiKey, mcpUrl: runtime.mcpUrl };
    }
  }
  const filteredUpdates: Record<string, string> = Object.fromEntries(Object.entries(config).filter(([key, value]) => {
    const field = skill.configFields.find((item) => item.key === key);
    return !(field?.type === "password" && (!value.trim() || value.includes("*")));
  }));
  const merged = { ...runtimeBaseline, ...current.config, ...filteredUpdates };

  // 清除空值
  for (const key of Object.keys(merged)) {
    if (!merged[key]?.trim()) delete merged[key];
  }

  store[skillId] = {
    ...current,
    installed: skill.builtin ? true : current.installed,
    enabled: skill.builtin ? existingEntry?.enabled !== false : current.enabled,
    config: merged,
  };
  await writeStore(store);

  const status = getStoredState(store, skillId);
  return {
    id: skillId,
    installed: status.installed,
    enabled: status.enabled,
    configured: skill.configFields.length === 0 || isConfigured(skill, merged),
    config: maskConfig(skill, merged),
  };
}

// ─── 运行时查询 ───────────────────────────────────────────────

interface EnabledSkillInfo {
  definition: SkillDefinition;
  config: Record<string, string>;
}

export async function getEnabledSkills(): Promise<EnabledSkillInfo[]> {
  const store = await readStore();
  const result: EnabledSkillInfo[] = [];
  const miaoshouConfig = getMiaoshouRuntimeConfig();
  const tmapiConfig = getTmapiRuntimeConfig();
  const webSearchConfig = getWebSearchRuntimeConfig();
  const chuhaijiangConfig = getChuhaijiangRuntimeConfig();
  const feishuConfig = getFeishuRuntimeConfig();
  const fastMossConfig = getFastMossRuntimeConfig();
  const tiktokConnection = await getTikTokConnectionStatus().catch(() => ({ connected: false as const }));

  for (const skill of BUILTIN_SKILLS) {
    const storedEntry = store[skill.id];
    const stored = getStoredState(store, skill.id);
    const installed = skill.builtin ? true : stored.installed;
    const enabled = skill.builtin ? (storedEntry?.enabled !== false) : stored.enabled;
    const effectiveConfig = skill.id === "miaoshou"
      ? { appKey: miaoshouConfig.appKey, appSecret: miaoshouConfig.appSecret, baseUrl: miaoshouConfig.baseUrl }
      : skill.id === "tmapi-1688"
        ? { apiToken: tmapiConfig.apiToken, baseUrl: tmapiConfig.baseUrl }
        : skill.id === "web-search"
          ? { apiKey: webSearchConfig.apiKey, baseUrl: webSearchConfig.baseUrl }
          : skill.id === "chuhaijiang"
            ? { apiKey: chuhaijiangConfig.apiKey, baseUrl: chuhaijiangConfig.baseUrl }
            : skill.id === "feishu"
              ? { appId: feishuConfig.appId, appSecret: feishuConfig.appSecret, baseUrl: feishuConfig.baseUrl }
              : skill.id === "fastmoss"
                ? { apiKey: fastMossConfig.apiKey, mcpUrl: fastMossConfig.mcpUrl }
                : stored.config;
    const configured = skill.id === "tiktok-shop"
      ? tiktokConnection.connected
      : skill.configFields.length === 0 || isConfigured(skill, effectiveConfig);

    if (installed && enabled && configured) {
      result.push({ definition: skill, config: effectiveConfig });
    }
  }

  return result;
}

// 对话流程中 getSkillTools/getSkillAbilityDescriptions 每步 ReAct 都调用，
// 内部 getEnabledSkills 会调 getTikTokConnectionStatus（文件 I/O + 可能刷新 token）。
// 短 TTL 缓存避免同一次对话内重复计算，skill 配置变更时 60s 内自动过期。
let cachedSkillTools: { at: number; value: unknown[] } | undefined;
let cachedAbilityDesc: { at: number; value: string } | undefined;
const SKILL_CACHE_TTL_MS = 60_000;

/** 聚合所有已启用 Skill 的 tools 定义（含 MCP 工具），供 LLM 使用 */
export async function getSkillTools(): Promise<unknown[]> {
  const now = Date.now();
  if (cachedSkillTools && now - cachedSkillTools.at < SKILL_CACHE_TTL_MS) {
    return cachedSkillTools.value;
  }
  const enabledSkills = await getEnabledSkills();
  const skillTools: unknown[] = [];

  for (const { definition } of enabledSkills) {
    if (definition.id === "miaoshou") {
      skillTools.push({
        type: "function",
        function: {
          name: "miaoshou_query",
          description: "查询采集上架数据，包括 1688 采集、商品上架、采购管理、库存查询等。",
          parameters: {
            type: "object",
            properties: {
              scene: {
                type: "string",
                description: "查询场景：collect_item, common_collect_box, tiktok_collect_box, tiktok_categories, ai_match_category, supplement_info, claim_to_platform, miaoshou_shops, publish_to_tiktok, publish_records, price_templates, miaoshou_packages, miaoshou_returns, miaoshou_purchase_orders, miaoshou_inventory",
              },
              query: {
                type: "string",
                description: "查询参数（如 1688 链接、商品 ID 等）",
              },
            },
            required: ["scene"],
          },
        },
      });
    }
    if (definition.id === "web-search") {
      skillTools.push({
        type: "function",
        function: {
          name: "web_search",
          description: "联网搜索公开信息。用户询问‘最新、当前、近期、今天’的政策、市场、趋势、新闻、竞品或行业资料时必须使用。这是只读工具；不用于查询店铺内部订单和商品数据。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "完整、明确的搜索问题。" },
              topic: { type: "string", enum: ["general", "news"], description: "政策和行业资料用 general；近期新闻用 news。" },
              timeRange: { type: "string", enum: ["day", "week", "month", "year"], description: "用户有明确时效要求时使用。" },
              maxResults: { type: "integer", minimum: 1, maximum: 8 },
              includeDomains: { type: "array", items: { type: "string" }, maxItems: 10 },
              excludeDomains: { type: "array", items: { type: "string" }, maxItems: 10 },
            },
            required: ["query"],
          },
        },
      });
    }
    // 未来可以添加更多 Skill 的工具定义
  }

  // 合并 FastMoss MCP 工具
  try {
    const mcpTools = await getFastMossTools();
    skillTools.push(...mcpTools);
  } catch {
    // MCP 工具加载失败不影响其他工具
  }

  // 合并日区选品 MCP 只读工具
  try {
    const chuhaijiangTools = await getChuhaijiangTools();
    skillTools.push(...chuhaijiangTools);
  } catch {
    // 日区选品工具加载失败不影响其他工具
  }

  cachedSkillTools = { at: now, value: skillTools };
  return skillTools;
}

/** 获取已启用 Skill 的能力描述，用于注入 system prompt */
export async function getSkillAbilityDescriptions(): Promise<string> {
  const now = Date.now();
  if (cachedAbilityDesc && now - cachedAbilityDesc.at < SKILL_CACHE_TTL_MS) {
    return cachedAbilityDesc.value;
  }
  const enabledSkills = await getEnabledSkills();
  if (enabledSkills.length === 0) {
    cachedAbilityDesc = { at: now, value: "" };
    return "";
  }

  const descriptions = enabledSkills.map(({ definition }) => {
    return `${definition.name}：${definition.description} 提供的场景：${definition.scenes.join(", ")}`;
  });

  const value = "\n\n已启用的 Skill 能力：\n" + descriptions.join("\n");
  cachedAbilityDesc = { at: now, value };
  return value;
}

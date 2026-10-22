import { getChuhaijiangRuntimeConfig, getFastMossRuntimeConfig, getFeishuRuntimeConfig, getMiaoshouRuntimeConfig, getTmapiRuntimeConfig, getWebSearchRuntimeConfig } from "./runtime-config.ts";
import { miaoshouRequest } from "./miaoshou-client.ts";
import { searchTmapiItemsByKeyword } from "./tmapi-client.ts";
import { searchWeb } from "./web-search-client.ts";
import { clearFeishuTokenCache, getFeishuConnectionStatus } from "./feishu-client.ts";
import { probeChuhaijiangConnection } from "./chuhaijiang-client.ts";
import { probeFastMossConnection } from "./mcp-client.ts";

export interface SkillConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

/**
 * 用当前生效配置（界面保存 > .env）对连接器发一次最小真实业务调用。
 * 妙手/TMAPI/搜索会消耗少量套餐额度；出海匠/FastMoss 走 MCP listTools 零消耗；飞书取 token 零消耗。
 */
export async function testSkillConnection(skillId: string): Promise<SkillConnectionTestResult> {
  const startedAt = Date.now();
  const latency = () => Date.now() - startedAt;
  try {
    switch (skillId) {
      case "miaoshou": {
        if (getMiaoshouRuntimeConfig().source === "missing") throw new Error("妙手 ERP 尚未配置，请先填写 App Key 和 App Secret。");
        await miaoshouRequest("/open/v1/product/collect_box/tiktok/price_template/get_price_template_list", { pageNo: 1, pageSize: 1 }, { retry: false });
        return { ok: true, latencyMs: latency(), detail: "妙手 API 鉴权通过，采集与上架流程可以正常调用。" };
      }
      case "tmapi-1688": {
        if (getTmapiRuntimeConfig().source === "missing") throw new Error("TMAPI 尚未配置，请先填写 API Token。");
        const result = await searchTmapiItemsByKeyword("数据线", { pageSize: 1 });
        const count = Array.isArray(result.items) ? result.items.length : 0;
        return { ok: true, latencyMs: latency(), detail: `TMAPI 连接成功，测试搜索返回 ${count} 个商品（消耗 1 次调用额度）。` };
      }
      case "web-search": {
        if (getWebSearchRuntimeConfig().source === "missing") throw new Error("联网搜索尚未配置，请先填写 Tavily API Key。");
        const result = await searchWeb({ query: "TikTok Shop", maxResults: 1 });
        const count = Array.isArray(result.results) ? result.results.length : 0;
        return { ok: true, latencyMs: latency(), detail: `联网搜索可用，测试搜索返回 ${count} 条结果（消耗 1 次搜索额度）。` };
      }
      case "chuhaijiang": {
        if (getChuhaijiangRuntimeConfig().source === "missing") throw new Error("出海匠 API Key 尚未配置。");
        const count = await probeChuhaijiangConnection();
        return { ok: true, latencyMs: latency(), detail: `出海匠 MCP 连接成功，${count} 个只读选品工具可用（零消耗）。` };
      }
      case "fastmoss": {
        if (getFastMossRuntimeConfig().source === "missing") throw new Error("FastMoss MCP 尚未配置，请先填写 API Key。");
        const count = await probeFastMossConnection();
        return { ok: true, latencyMs: latency(), detail: `FastMoss MCP 连接成功，${count} 个数据分析工具可用（零消耗）。` };
      }
      case "feishu": {
        const config = getFeishuRuntimeConfig();
        if (!config.appId || !config.appSecret) throw new Error("飞书尚未配置，请先填写 App ID 和 App Secret。");
        // 清掉旧 token 缓存，确保测的是刚保存的凭证
        clearFeishuTokenCache();
        const status = await getFeishuConnectionStatus();
        if (!status.connected) throw new Error(status.error ?? "飞书连接失败。");
        return { ok: true, latencyMs: latency(), detail: "飞书应用凭证有效（tenant_access_token 获取成功）。" };
      }
      default:
        throw new Error("该连接不支持连接测试。");
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: latency(),
      error: error instanceof Error ? error.message : "连接测试失败。",
    };
  }
}

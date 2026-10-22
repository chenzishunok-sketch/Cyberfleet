import { describe, expect, it, afterEach } from "vitest";
import { isDumateConfigured, shouldRouteToDumate } from "../server/dumate-client.ts";

describe("DuMate 客户端 · 配置判定", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    saved.__proto__ = Object.create(null);
    for (const key of Object.getOwnPropertyNames(saved)) delete saved[key];
  });

  function withEnv(env: Record<string, string>) {
    for (const key of Object.keys(env)) {
      saved[key] = process.env[key];
      process.env[key] = env[key];
    }
  }

  it("未开启时判定为未配置", () => {
    withEnv({ DUMATE_ENABLED: "false", DUMATE_API_KEY: "", DUMATE_AGENT_ID: "" });
    expect(isDumateConfigured()).toBe(false);
  });

  it("开启但缺 API Key 或 Agent ID 时判定为未配置", () => {
    withEnv({ DUMATE_ENABLED: "true", DUMATE_API_KEY: "ak-1", DUMATE_AGENT_ID: "" });
    expect(isDumateConfigured()).toBe(false);
    withEnv({ DUMATE_ENABLED: "true", DUMATE_API_KEY: "", DUMATE_AGENT_ID: "agt-1" });
    expect(isDumateConfigured()).toBe(false);
  });

  it("开启且 API Key / Agent ID 齐全时判定为已配置", () => {
    withEnv({ DUMATE_ENABLED: "true", DUMATE_API_KEY: "ak-1", DUMATE_AGENT_ID: "agt-1" });
    expect(isDumateConfigured()).toBe(true);
  });
});

describe("DuMate 客户端 · 对话路由", () => {
  it("经营数据/写操作类消息留在原链路（业务关键词命中）", () => {
    const businessQueries = [
      "看看店铺最近7天销售情况",
      "查询昨天的订单",
      "店铺GMV是多少",
      "哪些SKU库存不足",
      "生成经营周报",
      "帮我改一下A商品的定价",
      "分析一下日本市场家纺布艺类目",
      "汇总上周退款",
      "秒杀活动创建",
      "导出利润表",
    ];
    for (const query of businessQueries) {
      expect(shouldRouteToDumate(query), query).toBe(false);
    }
  });

  it("普通对话/知识/建议类消息交给搭子", () => {
    const casualQueries = [
      "你好，介绍一下你自己",
      "跨境电商运营有什么技巧？",
      "帮我写一段产品推广文案",
      "什么是TikTok Shop？",
      "你觉得最近有什么运营思路",
    ];
    for (const query of casualQueries) {
      expect(shouldRouteToDumate(query), query).toBe(true);
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntelligenceStore } from "../server/intelligence-store.ts";

describe("Agent intelligence store", () => {
  let directory: string;
  let store: IntelligenceStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cyberfleet-intelligence-"));
    store = new IntelligenceStore(path.join(directory, "intelligence.sqlite"));
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("retrieves relevant knowledge for the active Agent scope", () => {
    const global = store.createKnowledge({
      title: "泰国商品上架利润规则",
      content: "商品预计净利润小于零时不建议上架；成本缺失时只能标记为待确认。",
      category: "business_rule",
      scope: "global",
      source: "经营规则",
      tags: ["泰国", "利润", "上架"],
    });
    store.createKnowledge({
      title: "商品资料命名约定",
      content: "商品名称需要保留品牌、品类和核心规格。",
      category: "product",
      scope: "product",
      source: "商品规范",
      tags: ["商品"],
    });
    store.createKnowledge({
      title: "达人邀约话术",
      content: "邀约中需要说明样品和佣金条件。",
      category: "operations",
      scope: "kol",
      source: "BD 经验",
      tags: ["达人"],
    });

    const generalMatches = store.searchKnowledge("泰国商品上架应该如何判断利润", "general");
    expect(generalMatches[0].entry.id).toBe(global.id);
    expect(generalMatches.some((match) => match.entry.scope === "kol")).toBe(false);
    expect(store.searchKnowledge("达人邀约需要说明什么", "general").some((match) => match.entry.scope === "kol")).toBe(true);

    const productMatches = store.searchKnowledge("商品名称应该怎么写", "product");
    expect(productMatches.some((match) => match.entry.scope === "product")).toBe(true);
  });

  it("injects enabled prompt rules and cited knowledge into the LLM context", () => {
    store.createKnowledge({
      title: "保本价计算口径",
      content: "保本价必须包含采购、物流、税费和平台佣金。",
      category: "business_rule",
      scope: "pricing",
      source: "财务口径 V1",
      tags: ["保本价", "定价"],
    });
    const custom = store.createPromptRule({
      name: "定价方案比较",
      instruction: "定价建议至少比较保本价和目标利润价。",
      scope: "pricing",
      priority: 80,
    });

    const context = store.buildPromptContext("帮我计算这个 SKU 的保本价", "pricing");
    expect(context).toContain("经营决策输出标准");
    expect(context).toContain("定价建议至少比较保本价和目标利润价");
    expect(context).toContain("保本价计算口径");
    expect(context).toContain("财务口径 V1");

    store.updatePromptRule(custom.id, { enabled: false });
    expect(store.buildPromptContext("帮我计算这个 SKU 的保本价", "pricing")).not.toContain("定价建议至少比较保本价和目标利润价");
  });

  it("keeps built-in prompt rules recoverable while allowing custom rules to be deleted", () => {
    const overview = store.overview();
    expect(overview.stats.enabledPromptRuleCount).toBe(3);
    expect(store.deletePromptRule(overview.promptRules[0].id)).toBe(false);

    const custom = store.createPromptRule({
      name: "供应商风险",
      instruction: "供应商建议必须说明交期和起订量风险。",
      scope: "sourcing",
    });
    expect(store.deletePromptRule(custom.id)).toBe(true);
  });
});

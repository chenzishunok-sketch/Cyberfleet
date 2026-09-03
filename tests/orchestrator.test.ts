import { describe, expect, it } from "vitest";
import { __test } from "../server/orchestrator.ts";

const {
  extractQuantity,
  extractPrice,
  extractSkus,
  extractDays,
  asksForBestSellers,
  asksForProductOperation,
  inferExplicitDecision,
  inferDecision,
  inferFastConversationResponse,
  inferFastReadDecision,
  inferLiveProductWrite,
  workflowReference,
  asksAboutWorkflow,
} = __test;

describe("Orchestrator · 文本数值提取", () => {
  it("extractQuantity 从库存修改语句中提取数量", () => {
    expect(extractQuantity("把 LL-A01 的库存改成 200")).toBe(200);
    expect(extractQuantity("补货 50 件")).toBe(50);
    expect(extractQuantity("设置库存为 9999")).toBe(9999);
  });

  it("extractQuantity 无匹配时返回 fallback", () => {
    expect(extractQuantity("查看一下库存")).toBe(80);
    expect(extractQuantity("查看一下库存", 10)).toBe(10);
  });

  it("extractPrice 从改价语句中提取价格", () => {
    expect(extractPrice("把价格改成 39.9")).toBe(39.9);
    expect(extractPrice("售价调整为 100")).toBe(100);
  });

  it("extractPrice 无匹配时返回 fallback", () => {
    expect(extractPrice("看看价格")).toBe(39.99);
    expect(extractPrice("看看价格", 50)).toBe(50);
  });

  it("extractSkus 提取 LL 开头的 SKU 编码", () => {
    expect(extractSkus("给 LL-A01 和 LL-B02 改库存")).toEqual(["LL-A01", "LL-B02"]);
    expect(extractSkus("LLA03 补货 100")).toEqual(["LLA03"]);
    expect(extractSkus("没有 SKU 的文本")).toEqual([]);
  });

  it("extractDays 提取天数并限制范围 1-90", () => {
    expect(extractDays("近 7 天的数据")).toBe(7);
    expect(extractDays("最近 30 天")).toBe(30);
    expect(extractDays("昨天的订单")).toBe(1);
    expect(extractDays("本月报表")).toBe(30);
    expect(extractDays("近 99 天")).toBe(90);
    expect(extractDays("看看数据")).toBe(7);
  });
});

describe("Orchestrator · 意图识别辅助函数", () => {
  it("asksForBestSellers 识别爆款询问", () => {
    expect(asksForBestSellers("哪些商品好卖")).toBe(true);
    expect(asksForBestSellers("最近的爆款")).toBe(true);
    expect(asksForBestSellers("销量排名")).toBe(true);
    expect(asksForBestSellers("查看库存")).toBe(false);
  });

  it("asksForProductOperation 需同时提到操作和能力询问", () => {
    expect(asksForProductOperation("可以上架商品吗")).toBe(true);
    expect(asksForProductOperation("帮我下架这个商品")).toBe(true);
    expect(asksForProductOperation("上架")).toBe(false);
  });

  it("asksAboutWorkflow 识别工作流状态查询", () => {
    expect(asksAboutWorkflow("刚才的任务进度到哪了")).toBe(true);
    expect(asksAboutWorkflow("任务的失败原因")).toBe(true);
    expect(asksAboutWorkflow("查看库存")).toBe(false);
  });

  it("workflowReference 提取 UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(workflowReference(`任务 ${uuid} 的状态`)).toBe(uuid);
    expect(workflowReference("没有 UUID 的文本")).toBeUndefined();
  });
});

describe("Orchestrator · 核心路由 inferExplicitDecision", () => {
  it("店铺信息查询路由到 get_shop_info", () => {
    expect(inferExplicitDecision("店铺叫什么名字")).toEqual({ tool: "get_shop_info", args: {} });
    expect(inferExplicitDecision("shop 的站点是哪个")).toEqual({ tool: "get_shop_info", args: {} });
  });

  it("库存修改路由到 prepare_inventory_update", () => {
    const decision = inferExplicitDecision("把 LL-A01 库存改成 200");
    expect(decision?.tool).toBe("prepare_inventory_update");
    expect(decision?.args).toMatchObject({ skus: ["LL-A01"], quantity: 200 });
  });

  it("改价路由到 prepare_price_update", () => {
    const decision = inferExplicitDecision("把 LL-A01 价格改成 39.9");
    expect(decision?.tool).toBe("prepare_price_update");
    expect(decision?.args).toMatchObject({ skus: ["LL-A01"], price: 39.9 });
  });

  it("报告生成路由到 generate_operations_report,30 天识别", () => {
    expect(inferExplicitDecision("生成本月周报")?.tool).toBe("generate_operations_report");
    expect(inferExplicitDecision("生成 30 天的复盘报告")).toMatchObject({ tool: "generate_operations_report", args: { days: 30 } });
  });

  it("退款查询路由到 get_refund_summary", () => {
    expect(inferExplicitDecision("近 7 天的退款情况")?.tool).toBe("get_refund_summary");
  });

  it("订单查询路由到 get_order_summary", () => {
    expect(inferExplicitDecision("看看最近 7 天订单")?.tool).toBe("get_order_summary");
  });

  it("GMV 查询路由到 get_gmv_summary", () => {
    expect(inferExplicitDecision("近 7 天的 GMV")?.tool).toBe("get_gmv_summary");
  });

  it("爆款询问路由到 list_products focus=top", () => {
    expect(inferExplicitDecision("哪些商品好卖")).toEqual({ tool: "list_products", args: { focus: "top" } });
  });

  it("滞销询问路由到 list_products focus=slow", () => {
    expect(inferExplicitDecision("滞销商品有哪些")).toEqual({ tool: "list_products", args: { focus: "slow" } });
  });

  it("无法识别时返回 undefined", () => {
    expect(inferExplicitDecision("random text without keywords")).toBeUndefined();
  });
});

describe("Orchestrator · inferDecision 兜底", () => {
  it("无法识别时兜底为店铺经营概况（有真实数据，而非空话术）", () => {
    const decision = inferDecision("random text");
    expect(decision.tool).toBe("get_sales_overview");
    if (decision.tool === "get_sales_overview") {
      expect(decision.args.days).toBe(7);
    }
  });

  it("能识别时返回显式决策", () => {
    expect(inferDecision("看看订单").tool).toBe("get_order_summary");
  });
});

describe("Orchestrator · 快速路径识别", () => {
  it("inferFastConversationResponse 识别寒暄", () => {
    expect(inferFastConversationResponse("你好")).toBeTruthy();
    expect(inferFastConversationResponse("hi")).toBeTruthy();
    expect(inferFastConversationResponse("你能做什么")).toBeTruthy();
  });

  it("inferFastConversationResponse 非寒暄返回 undefined", () => {
    expect(inferFastConversationResponse("查看库存")).toBeUndefined();
  });

  it("inferFastReadDecision 简单读查询走快速路径", () => {
    expect(inferFastReadDecision("店铺叫什么名字")?.tool).toBe("get_shop_info");
    expect(inferFastReadDecision("查询近 7 天订单")?.tool).toBe("get_order_summary");
  });

  it("inferFastReadDecision 深度分析不走快速路径(交给 LLM)", () => {
    expect(inferFastReadDecision("为什么订单下降了,帮我诊断原因")).toBeUndefined();
    expect(inferFastReadDecision("库存优化建议")).toBeUndefined();
  });

  it("inferFastReadDecision 写操作不走快速路径", () => {
    expect(inferFastReadDecision("把库存改成 200")).toBeUndefined();
  });
});

describe("Orchestrator · 写操作识别 inferLiveProductWrite", () => {
  it("库存修改识别为 inventory.update", () => {
    expect(inferLiveProductWrite("把库存改成 200")).toBe("inventory.update");
    expect(inferLiveProductWrite("补库存 50 件")).toBe("inventory.update");
  });

  it("改价识别为 price.update", () => {
    expect(inferLiveProductWrite("把价格改成 39.9")).toBe("price.update");
    expect(inferLiveProductWrite("调整售价为 100")).toBe("price.update");
  });

  it("上架识别为 product.activate", () => {
    expect(inferLiveProductWrite("重新上架这个商品")).toBe("product.activate");
    expect(inferLiveProductWrite("启用商品")).toBe("product.activate");
  });

  it("下架识别为 product.deactivate", () => {
    expect(inferLiveProductWrite("下架这个商品")).toBe("product.deactivate");
    expect(inferLiveProductWrite("停售商品")).toBe("product.deactivate");
  });

  it("非写操作返回 undefined", () => {
    expect(inferLiveProductWrite("查看库存")).toBeUndefined();
    expect(inferLiveProductWrite("看看订单")).toBeUndefined();
  });
});

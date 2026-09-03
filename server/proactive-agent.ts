import type { ScheduleTask } from "./scheduler.ts";
import { scheduler } from "./scheduler.ts";
import { getTikTokOperationalData } from "./tiktok-data.ts";
import { agentBus } from "./agent-bus.ts";
import { agentRegistry } from "./agent-registry.ts";
import { hasLlmConfiguration, callLlmRaw, fastModel } from "./llm.ts";
import { learningLoop } from "./learning-loop.ts";
import { notifyFeishuReport } from "./feishu-notify.ts";

// ─── 主动推送结果 ──────────────────────────────────────────────

export interface ProactiveInsight {
  taskId: string;
  taskName: string;
  timestamp: string;
  /** 洞察标题 */
  headline: string;
  /** 洞察摘要 */
  summary: string;
  /** 建议行动 */
  recommendations?: string[];
  /** 严重级别 */
  severity: "info" | "warning" | "critical";
  /** 关联数据 */
  data?: Record<string, unknown>;
}

const recentInsights: ProactiveInsight[] = [];
const MAX_INSIGHTS = 50;

/** 获取最近的主动洞察 */
export function getRecentInsights(limit?: number): ProactiveInsight[] {
  const insights = [...recentInsights].reverse();
  return limit ? insights.slice(0, limit) : insights;
}

// ─── 巡检执行器 ────────────────────────────────────────────────

/**
 * 只读查询执行器：执行预定义的只读查询并返回结果摘要。
 */
scheduler.registerExecutor("read_only_query", async (task) => {
  const queryType = String(task.params.queryType ?? "sales_overview");
  const days = Number(task.params.days ?? 7);
  const agentCtx = (task.agent ?? "general") as Parameters<typeof agentRegistry.getInstance>[0];

  agentRegistry.startWork(agentCtx, `定时查询：${task.name}`);
  try {
    const data = await getTikTokOperationalData(Math.min(90, Math.max(1, days)));
    let summary = "";

    switch (queryType) {
      case "sales_overview":
        summary = `近${days}天：${data.currentOrders}个订单（前${days}天${data.previousOrders}个），${data.totalProducts}个商品，${data.currentReturns}个退货`;
        break;
      case "low_stock":
        summary = data.allProducts.filter((p) => p.status !== "healthy").map((p) => `${p.title}(${p.sku}):库存${p.stock}`).slice(0, 10).join("；") || "没有低库存商品";
        break;
      case "gmv_summary": {
        const gmv = data.dashboard.metrics.find((m) => m.label === "支付 GMV");
        summary = `近${days}天支付GMV：${gmv?.value ?? "--"}，${data.currentOrders}个订单`;
        break;
      }
      default:
        summary = `近${days}天：${data.currentOrders}个订单，${data.totalProducts}个商品`;
    }

    const insight = await generateInsightWithLlm(task.name, summary, data);

    // 广播洞察
    const proactiveInsight: ProactiveInsight = {
      taskId: task.id,
      taskName: task.name,
      timestamp: new Date().toISOString(),
      headline: insight?.headline ?? `${task.name} 完成`,
      summary: insight?.summary ?? summary,
      recommendations: insight?.recommendations,
      severity: insight?.severity ?? "info",
      data: { queryType, days, orderCount: data.currentOrders, productCount: data.totalProducts },
    };
    recentInsights.push(proactiveInsight);
    if (recentInsights.length > MAX_INSIGHTS) {
      recentInsights.splice(0, recentInsights.length - MAX_INSIGHTS);
    }

    // 通过事件总线广播
    agentBus.sendMessage(
      agentCtx,
      "general",
      "notification",
      `[主动洞察] ${proactiveInsight.headline}：${proactiveInsight.summary}`,
      task.id,
    );

    return {
      success: true,
      summary: proactiveInsight.summary,
      insight: proactiveInsight.headline,
    };
  } finally {
    agentRegistry.completeWork(agentCtx);
  }
});

/**
 * 主动巡检执行器：检查多个数据维度，发现异常时推送告警。
 */
scheduler.registerExecutor("proactive_inspection", async (task) => {
  const agentCtx = "general";
  agentRegistry.startWork(agentCtx, `主动巡检：${task.name}`);
  try {
    const data = await getTikTokOperationalData(7);
    const issues: string[] = [];

    // 检查 1：订单量骤降
    if (data.previousOrders > 0 && data.currentOrders < data.previousOrders * 0.7) {
      issues.push(`订单量下降 ${Math.round((1 - data.currentOrders / data.previousOrders) * 100)}%（从${data.previousOrders}降至${data.currentOrders}）`);
    }

    // 检查 2：退货率过高
    if (data.currentOrders > 0 && data.currentReturns > data.currentOrders * 0.15) {
      issues.push(`退货率 ${Math.round((data.currentReturns / data.currentOrders) * 100)}%，超过 15% 阈值`);
    }

    // 检查 3：低库存商品
    const lowStockProducts = data.allProducts.filter((p) => p.status !== "healthy");
    if (lowStockProducts.length > 0) {
      issues.push(`${lowStockProducts.length} 个商品库存不足`);
    }

    const severity: ProactiveInsight["severity"] =
      issues.length >= 2 ? "critical" : issues.length === 1 ? "warning" : "info";

    const summary = issues.length > 0
      ? `发现 ${issues.length} 个需要关注的问题：${issues.join("；")}`
      : `巡检完成，近 7 天数据正常：${data.currentOrders}个订单，${data.totalProducts}个商品`;

    const proactiveInsight: ProactiveInsight = {
      taskId: task.id,
      taskName: task.name,
      timestamp: new Date().toISOString(),
      headline: severity === "info" ? "巡检正常" : severity === "warning" ? "发现预警" : "需要立即关注",
      summary,
      recommendations: issues.length > 0 ? ["建议查看详细数据", "根据问题优先级逐项处理"] : undefined,
      severity,
      data: { issues, orderCount: data.currentOrders, productCount: data.totalProducts },
    };
    recentInsights.push(proactiveInsight);
    if (recentInsights.length > MAX_INSIGHTS) {
      recentInsights.splice(0, recentInsights.length - MAX_INSIGHTS);
    }

    // 通过事件总线广播
    agentBus.sendMessage(
      agentCtx,
      "general",
      "notification",
      `[巡检${severity === "info" ? "正常" : severity === "warning" ? "预警" : "告警"}] ${summary}`,
      task.id,
    );

    return {
      success: true,
      summary,
      insight: proactiveInsight.headline,
    };
  } finally {
    agentRegistry.completeWork(agentCtx);
  }
});

/**
 * 报告生成执行器：生成周期性经营报告。
 */
scheduler.registerExecutor("report_generation", async (task) => {
  const agentCtx = "general";
  agentRegistry.startWork(agentCtx, `生成报告：${task.name}`);
  try {
    const days = Number(task.params.days ?? 7);
    const data = await getTikTokOperationalData(Math.min(90, Math.max(1, days)));
    const gmv = data.dashboard.metrics.find((m) => m.label === "支付 GMV")?.value ?? "--";
    const previousDelta = data.previousOrders > 0
      ? `较前${days}天${Math.round((data.currentOrders / data.previousOrders - 1) * 100)}%`
      : "（无上期对比）";

    const summary = `经营周报（近${days}天）：${data.currentOrders}个订单，${data.totalProducts}个商品，${data.currentReturns}个退货，GMV ${gmv}`;

    const proactiveInsight: ProactiveInsight = {
      taskId: task.id,
      taskName: task.name,
      timestamp: new Date().toISOString(),
      headline: `${days}天经营报告`,
      summary,
      severity: "info",
      data: {
        orderCount: data.currentOrders,
        productCount: data.totalProducts,
        returnCount: data.currentReturns,
      },
    };
    recentInsights.push(proactiveInsight);
    if (recentInsights.length > MAX_INSIGHTS) {
      recentInsights.splice(0, recentInsights.length - MAX_INSIGHTS);
    }

    // 推送到飞书（未配置时静默降级）
    void notifyFeishuReport(`【${task.name}】近${days}天经营报告`, [
      `订单 ${data.currentOrders} 个（${previousDelta}）`,
      `退货 ${data.currentReturns} 个`,
      `在售商品 ${data.totalProducts} 个`,
      `支付 GMV：${gmv}`,
      "",
      "详细数据请查看系统工作台。",
    ]);

    return {
      success: true,
      summary,
      insight: proactiveInsight.headline,
    };
  } finally {
    agentRegistry.completeWork(agentCtx);
  }
});

// ─── LLM 洞察生成（可选，需要 LLM 配置） ───────────────────────

async function generateInsightWithLlm(
  taskName: string,
  dataSummary: string,
  _data: unknown,
): Promise<{ headline: string; summary: string; recommendations?: string[]; severity: "info" | "warning" | "critical" } | undefined> {
  if (!hasLlmConfiguration()) return undefined;

  try {
    const result = await callLlmRaw({
      systemPrompt: "你是一个电商经营分析助手。根据数据摘要，用一句话给出核心洞察（headline），用 2-3 句话给出摘要（summary），并给出 1-3 条建议（recommendations）。同时判断严重级别：info/warning/critical。以 JSON 格式返回：{\"headline\":\"\",\"summary\":\"\",\"recommendations\":[],\"severity\":\"info\"}",
      messages: [
        { role: "user", content: `任务：${taskName}\n数据摘要：${dataSummary}\n\n请分析数据并给出洞察。` },
      ],
      model: fastModel(),
      maxTokens: 300,
      responseFormat: "json",
    });

    if (result.content) {
      try {
        return JSON.parse(result.content);
      } catch {
        return undefined;
      }
    }
  } catch {
    // LLM 调用失败不影响调度任务完成
  }
  return undefined;
}

// ─── 启动时注册默认调度任务 ────────────────────────────────────

export function ensureDefaultScheduleTasks(): void {
  const existing = scheduler.list();

  // 每日 18:00 经营日报：增量补齐（既有环境也会补建，缺失才创建）
  if (!existing.some((task) => task.name === "每日经营日报")) {
    scheduler.create({
      name: "每日经营日报",
      description: "每天下午 6 点生成当日经营日报并推送到飞书",
      cron: "0 18 * * *",
      type: "report_generation",
      params: { days: 1 },
      agent: "general",
    });
  }

  if (existing.length > 0) return;

  // 每日 09:00 低库存检查
  scheduler.create({
    name: "每日低库存检查",
    description: "每天上午 9 点检查商品库存，发现低库存商品时推送告警",
    cron: "0 9 * * *",
    type: "read_only_query",
    params: { queryType: "low_stock", days: 7 },
    agent: "product",
  });

  // 每日 09:30 经营数据巡检
  scheduler.create({
    name: "每日经营巡检",
    description: "每天上午 9:30 自动巡检经营数据，发现异常时推送告警",
    cron: "30 9 * * *",
    type: "proactive_inspection",
    params: { days: 7 },
    agent: "general",
  });

  // 每周一 10:00 生成周报
  scheduler.create({
    name: "每周经营周报",
    description: "每周一上午 10 点生成最近 7 天经营报告",
    cron: "0 10 * * 1",
    type: "report_generation",
    params: { days: 7 },
    agent: "general",
  });

  // 每 2 小时执行一次闭环学习反思
  scheduler.create({
    name: "闭环学习反思",
    description: "定期对未反思的决策结果执行 LLM 反思，提取经验教训写入共享记忆",
    cron: "0 */2 * * *",
    type: "learning_reflection",
    params: { limit: 5 },
    agent: "general",
  });

  console.log(`[ProactiveAgent] 已注册 ${scheduler.list().length} 个默认调度任务`);
}

// ─── 闭环学习反思执行器 ────────────────────────────────────────

scheduler.registerExecutor("learning_reflection", async (task) => {
  const limit = Number(task.params.limit ?? 5);
  const reflected = await learningLoop.runReflectionBatch(limit);
  const overview = learningLoop.overview();
  return {
    success: true,
    summary: `本次反思 ${reflected} 条决策，累计 ${overview.reflections} 条反思、${overview.lessonsLearned} 条经验教训`,
    insight: reflected > 0 ? `新增 ${reflected} 条反思` : undefined,
  };
});

import type { DagDefinition } from "../shared/contracts.ts";
import { registerExecutor } from "./dag-workflow-engine.ts";
// 加载真实业务执行器（日区选品 / 1688 货源 / 采集上架服务），确保执行器先于模板注册
import "./dag-business-executors.ts";

// ─── DAG 模板注册表 ────────────────────────────────────────────

const dagTemplates = new Map<string, DagDefinition>();

export function registerDagTemplate(def: DagDefinition): void {
  dagTemplates.set(def.type, def);
}

export function getDagTemplate(type: string): DagDefinition | undefined {
  return dagTemplates.get(type);
}

export function listDagTemplates(): DagDefinition[] {
  return Array.from(dagTemplates.values());
}

// ─── 内置执行器 ────────────────────────────────────────────────

/** 日志执行器：只记录消息，不执行真实操作。用于演示和测试。 */
registerExecutor("log", async (input, ctx) => {
  const message = String(input.message ?? input.task ?? "(无消息)");
  return { logged: true, message, runId: ctx.runId };
});

/** 数据传递执行器：把输入直接作为输出传递 */
registerExecutor("pass_through", async (input) => {
  return { ...input };
});

/** 延迟执行器：模拟耗时操作 */
registerExecutor("delay", async (input) => {
  const ms = Number(input.delayMs ?? 100);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { delayed: ms };
});

// ─── 内置 DAG 模板 ─────────────────────────────────────────────

/**
 * 模板 1：多 Agent 协作选品分析
 *
 * 展示 DAG 的核心能力：
 * - 并行执行（选品 Agent 查货源 + 定价 Agent 估利润）
 * - 条件分支（利润是否达标）
 * - 人工确认（最终是否采纳）
 *
 * 流程图：
 *   start → parallel_analyze ┬─ sourcing_search（选品 Agent 查 1688 货源）
 *                            └─ pricing_estimate（定价 Agent 估算利润）
 *           → join_results → check_profit（利润是否达标？）
 *                               ├─ yes → notify_recommend（生成推荐报告）
 *                               └─ no  → notify_reject（生成否决报告）
 *           → human_confirm（用户确认是否采纳）→ done
 */
registerDagTemplate({
  type: "collaborative_sourcing",
  name: "多 Agent 协作选品分析",
  description: "选品 Agent 和定价 Agent 并行分析，条件分支判断利润，人工确认最终结果",
  entry: "start",
  nodes: [
    {
      id: "start",
      type: "task",
      label: "初始化选品任务",
      executor: "pass_through",
    },
    {
      id: "parallel_analyze",
      type: "parallel",
      label: "并行分析（选品 + 定价）",
      branches: [
        ["sourcing_search"],
        ["pricing_estimate"],
      ],
    },
    {
      id: "sourcing_search",
      type: "task",
      label: "选品 Agent · 搜索 1688 货源",
      agent: "sourcing",
      executor: "log",
    },
    {
      id: "pricing_estimate",
      type: "task",
      label: "定价 Agent · 估算利润",
      agent: "pricing",
      executor: "log",
    },
    {
      id: "join_results",
      type: "join",
      label: "汇总分析结果",
    },
    {
      id: "check_profit",
      type: "gate",
      label: "利润是否达标",
      condition: "pricing_estimate.profitable",
    },
    {
      id: "notify_recommend",
      type: "task",
      label: "生成推荐报告",
      executor: "log",
    },
    {
      id: "notify_reject",
      type: "task",
      label: "生成否决报告",
      executor: "log",
    },
    {
      id: "human_confirm",
      type: "human_gate",
      label: "用户确认",
      confirmationKind: "sourcing_decision",
      prompt: "选品分析已完成，是否采纳推荐结果？",
    },
    {
      id: "done",
      type: "task",
      label: "完成",
      executor: "pass_through",
    },
  ],
  edges: [
    { from: "start", to: "parallel_analyze" },
    { from: "parallel_analyze", to: "join_results" },
    { from: "join_results", to: "check_profit" },
    { from: "check_profit", to: "notify_recommend", condition: "true" },
    { from: "check_profit", to: "notify_reject" },
    { from: "notify_recommend", to: "human_confirm" },
    { from: "notify_reject", to: "done" },
    { from: "human_confirm", to: "done" },
  ],
});

/**
 * 模板 2：达人选品内容流水线
 *
 * 展示跨领域 Agent 协作：
 * - 运营总监选择目标商品
 * - 达人 BD Agent 筛选匹配达人（并行）
 * - 内容 Agent 生成素材（并行）
 * - 汇总后人工确认
 */
registerDagTemplate({
  type: "kol_content_pipeline",
  name: "达人选品内容流水线",
  description: "达人 BD 和内容 Agent 并行准备，汇总后人工确认",
  entry: "select_product",
  nodes: [
    {
      id: "select_product",
      type: "task",
      label: "运营总监 · 选择目标商品",
      agent: "general",
      executor: "pass_through",
    },
    {
      id: "parallel_prepare",
      type: "parallel",
      label: "并行准备（达人筛选 + 内容创作）",
      branches: [
        ["kol_match"],
        ["content_create"],
      ],
    },
    {
      id: "kol_match",
      type: "task",
      label: "达人 BD Agent · 筛选匹配达人",
      agent: "kol",
      executor: "log",
    },
    {
      id: "content_create",
      type: "task",
      label: "内容 Agent · 生成商品素材",
      agent: "content",
      executor: "log",
    },
    {
      id: "join_prepare",
      type: "join",
      label: "汇总准备结果",
    },
    {
      id: "human_review",
      type: "human_gate",
      label: "运营总监 · 审核确认",
      confirmationKind: "kol_content_review",
      prompt: "达人匹配和内容素材已准备完成，是否继续执行？",
    },
    {
      id: "execute",
      type: "task",
      label: "执行推广计划",
      executor: "log",
    },
  ],
  edges: [
    { from: "select_product", to: "parallel_prepare" },
    { from: "parallel_prepare", to: "join_prepare" },
    { from: "join_prepare", to: "human_review" },
    { from: "human_review", to: "execute" },
  ],
});

// ─── 真实业务模板 ─────────────────────────────────────────────

/**
 * 模板 3：选品上架闭环（五能力源真实数据）
 *
 * 业务流程（运营实际走法）：
 *   1. 日区选品（TikTok 日区爆品情报）+ 1688 货源数据（1688 货源）并行搜索同一关键词
 *   2. 任一数据源有结果即进入采集；双源皆空则提醒换词
 *   3. 采集货源 → 认领到 TikTok 采集箱 → AI 类目/属性匹配 → 翻译 + AI 文案
 *   4. human_gate 人工审批（发布前的最终确认，即审批闭环）
 *   5. 审批通过后发布到 TikTok 店铺
 *
 * 输入参数（DAG input）：
 *   keyword: string         搜索关键词（必填）
 *   sourceUrls?: string[]   可选的直接 1688 链接（跳过搜索阶段，无结果时兜底）
 *   shopIds?: (string|number)[]  采集上架店铺编号（必填，用于认领/翻译/发布）
 *   site?: string           TikTok 站点，默认 US
 *   targetLanguage?: string 翻译目标语言，默认 en
 *
 * 任一真实 API 调用失败时对应节点标记 failed，可单独重试该节点。
 */
registerDagTemplate({
  type: "product_launch_closed_loop",
  name: "选品上架闭环",
  description: "日区选品 + 1688 双源选品 → 采集/认领/AI匹配/翻译 → 人工审批 → 发布 TikTok，真实 API 全链路",
  entry: "start",
  nodes: [
    {
      id: "start",
      type: "task",
      label: "初始化选品任务",
      executor: "pass_through",
    },
    {
      id: "parallel_search",
      type: "parallel",
      label: "并行搜索（日区选品情报 + 1688 货源）",
      branches: [
        ["chuhaijiang_search"],
        ["tmapi_search"],
      ],
    },
    {
      id: "chuhaijiang_search",
      type: "task",
      label: "日区选品 · TikTok 日区爆品情报搜索",
      agent: "product",
      executor: "chuhaijiang_search",
    },
    {
      id: "tmapi_search",
      type: "task",
      label: "1688 货源 · 关键词搜索",
      agent: "sourcing",
      executor: "tmapi_search",
    },
    {
      id: "join_search",
      type: "join",
      label: "汇总双源搜索结果",
    },
    {
      id: "check_found",
      type: "gate",
      label: "搜索是否有结果",
    },
    {
      id: "miaoshou_collect",
      type: "task",
      label: "采集上架 · 采集货源到公共采集箱",
      agent: "sourcing",
      executor: "miaoshou_collect",
    },
    {
      id: "notify_no_result",
      type: "task",
      label: "双源均无结果，提醒换词",
      executor: "log",
    },
    {
      id: "miaoshou_claim",
      type: "task",
      label: "采集上架 · 认领到 TikTok 采集箱",
      agent: "sourcing",
      executor: "miaoshou_claim",
    },
    {
      id: "miaoshou_ai_match",
      type: "task",
      label: "采集上架 · AI 类目 + 属性匹配",
      agent: "publishing",
      executor: "miaoshou_ai_match",
    },
    {
      id: "miaoshou_content",
      type: "task",
      label: "采集上架 · 商品翻译 + AI 标题描述",
      agent: "content",
      executor: "miaoshou_content",
    },
    {
      id: "human_approve",
      type: "human_gate",
      label: "发布前人工审批",
      confirmationKind: "publish_approval",
      prompt: "选品、采集、认领、AI 匹配和文案已完成。请核对商品信息，确认后发布到 TikTok 店铺。",
    },
    {
      id: "miaoshou_publish",
      type: "task",
      label: "采集上架 · 发布到 TikTok 店铺",
      agent: "publishing",
      executor: "miaoshou_publish",
    },
    {
      id: "done",
      type: "task",
      label: "完成",
      executor: "pass_through",
    },
  ],
  edges: [
    { from: "start", to: "parallel_search" },
    { from: "parallel_search", to: "join_search" },
    { from: "join_search", to: "check_found" },
    { from: "check_found", to: "miaoshou_collect", condition: "tmapi_search.found == true" },
    { from: "check_found", to: "miaoshou_collect", condition: "chuhaijiang_search.found == true" },
    { from: "check_found", to: "notify_no_result" },
    { from: "miaoshou_collect", to: "miaoshou_claim" },
    { from: "notify_no_result", to: "done" },
    { from: "miaoshou_claim", to: "miaoshou_ai_match" },
    { from: "miaoshou_ai_match", to: "miaoshou_content" },
    { from: "miaoshou_content", to: "human_approve" },
    { from: "human_approve", to: "miaoshou_publish" },
    { from: "miaoshou_publish", to: "done" },
  ],
});

/**
 * 模板 4：采集上架 7 步上架（已知 1688 链接直接上架）
 *
 * 用于运营已经选好货源链接的场景，跳过搜索阶段，直接走采集上架 7 步：
 *   ① 采集 → ② 认领 → ③ AI 类目/属性 → ④ 翻译 + AI 文案
 *   → ⑤ 人工审批 → ⑥ 发布 → ⑦ 完成
 *
 * 输入参数（DAG input）：
 *   sourceUrls: string[]      1688 商品链接（必填）
 *   shopIds?: (string|number)[]  采集上架店铺编号（必填）
 *   site?: string             默认 US
 *   targetLanguage?: string   默认 en
 */
registerDagTemplate({
  type: "miaoshou_7step_publish",
  name: "采集上架 7 步",
  description: "已知 1688 链接：采集 → 认领 → AI 类目/属性 → 翻译/AI 文案 → 人工审批 → 发布 → 完成",
  entry: "start",
  nodes: [
    {
      id: "start",
      type: "task",
      label: "初始化上架任务",
      executor: "pass_through",
    },
    {
      id: "collect",
      type: "task",
      label: "① 采集货源到公共采集箱",
      agent: "sourcing",
      executor: "miaoshou_collect",
    },
    {
      id: "claim",
      type: "task",
      label: "② 认领到 TikTok 采集箱",
      agent: "sourcing",
      executor: "miaoshou_claim",
    },
    {
      id: "ai_match",
      type: "task",
      label: "③ AI 类目 + 属性匹配",
      agent: "publishing",
      executor: "miaoshou_ai_match",
    },
    {
      id: "content",
      type: "task",
      label: "④ 商品翻译 + AI 标题描述",
      agent: "content",
      executor: "miaoshou_content",
    },
    {
      id: "human_approve",
      type: "human_gate",
      label: "⑤ 发布前人工审批",
      confirmationKind: "publish_approval",
      prompt: "商品已采集并完成 AI 匹配与文案生成。请核对后确认发布。",
    },
    {
      id: "publish",
      type: "task",
      label: "⑥ 发布到 TikTok 店铺",
      agent: "publishing",
      executor: "miaoshou_publish",
    },
    {
      id: "done",
      type: "task",
      label: "⑦ 完成",
      executor: "pass_through",
    },
  ],
  edges: [
    { from: "start", to: "collect" },
    { from: "collect", to: "claim" },
    { from: "claim", to: "ai_match" },
    { from: "ai_match", to: "content" },
    { from: "content", to: "human_approve" },
    { from: "human_approve", to: "publish" },
    { from: "publish", to: "done" },
  ],
});

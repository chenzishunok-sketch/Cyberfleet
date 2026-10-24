import type { MessageArtifact, VisualSection } from "../shared/contracts.js";

interface DetectionResult {
  headline?: string;
  summary?: string;
  sections: VisualSection[];
  confidence: number;
}

const CONCLUSION_PATTERNS = [
  /^(?:结论|总结|总体来看|综上|核心观点)[：:，]\s*(.+)/m,
  /^(?:我的判断|我的核心观点|我的分析)[^。\n]{0,10}[，,\s]\s*(.+)/m,
  /^(?:我认为|我判断)[^。\n]{0,10}[，,\s]\s*(.+)/m,
];

const JUDGMENT_PATTERNS = [
  /(?:我的判断|我认为|核心判断|我的观点)[是为][：:，]\s*(.+)/g,
  /(?:推断层面|分析|判断)[：:，]\s*(.+)/g,
  /(?:这说明|这意味着|表明)[^。\n]{0,10}[，,\s]\s*(.+)/g,
];

const RECOMMENDATION_PATTERNS = [
  /(?:建议下一步|下一步建议|行动建议|推荐)[^。\n]{0,20}[：:，]\s*(.+)/g,
  /(?:所以我的建议|我的建议)[^。\n]{0,30}[，,\s]\s*(.+)/g,
  /(?:建议|下一步)[^。\n]{0,20}[，,\s]\s*(.+)/g,
];

const WARNING_PATTERNS = [
  /(?:但要注意|需要注意|注意|风险)[^。\n]{0,20}[，,\s]\s*(.+)/g,
  /(?:风险|警示|警告)[：:，]\s*(.+)/g,
];

const OPENING_PATTERNS = [
  /^(?:我建议|我的判断|我的观点|首先|总体|核心|我的核心观点)[^。\n]{0,30}[，,\s]\s*(.+)/m,
];

const DATA_NUMBER_PATTERN = /([\d,]+\.?\d*)\s*(M|B|K|万|千)?\s*(日元|人民币|美元|欧元|英镑|件|个|%|)?/g;
const CURRENCY_PATTERN = /([\u0E00-\u0E7F¥$€£])\s*([\d,.]+)\s*(M|B|K|万|千)?/g;
const PERCENT_PATTERN = /([\d.]+)\s*%/g;
const TREND_PATTERN = /(同比|环比)?\s*(上升|下降|增长|减少|降低|下滑|上涨|持平)\s*([\d.]+)\s*%/g;
const SUBJECT_CONTEXT_PATTERN = /([^\s，。,；；\n]{2,20})(?:规模|销量|GMV|销售额|占比|增长率|市场)?/;

/**
 * 从数字前面的上下文里提取一个「干净的中文指标词」作为卡片标签。
 * 返回 null 表示上下文不是指标词（是句子片段/外文碎片/标点尾巴），该数字不应做成指标卡。
 * 之前这里抓「货币/百分号前任意 2-16 个字符」且兜底 `${currency} 规模`，
 * 结果出现「¥ 规模」「JP」「P¥」「建议今天就能发起一轮小批量建联：从」「天是」这类垃圾标签。
 */
function extractMetricLabel(beforeText: string): string | null {
  // 取紧挨数字前的最后一段连续非空白非标点文本
  const candidate = beforeText.match(/([^\s，。,；;；：:、（）()【】\[\]{}"'%¥$€£฿\d]{2,12})$/)?.[1] ?? "";
  if (!candidate) return null;
  // 必须包含至少 2 个中文字符（纯外文缩写如 JP/P 不算指标词）
  const cjkCount = (candidate.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  if (cjkCount < 2) return null;
  // 去掉结尾挂在句子里蹭进来的虚词（"过去7天是3.4%" 的「天是」→「天」不足 2 字即弃）
  const trimmed = candidate.replace(/[是为的与和或从到在把将使了]/g, "");
  if ((trimmed.match(/[\u4e00-\u9fa5]/g) ?? []).length < 2) return null;
  return trimmed;
}

export function detectVisualPatterns(text: string): DetectionResult {
  const sections: VisualSection[] = [];
  let confidence = 0;

  // 1. 结论 / 总起句
  let conclusionFound = false;
  for (const pattern of CONCLUSION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const body = (match[1] ?? match[0]).trim();
      if (body.length >= 10) {
        sections.push({
          type: "callout",
          tone: "conclusion",
          title: "核心观点",
          body: body.slice(0, 600),
        });
        confidence += 0.25;
        conclusionFound = true;
        break;
      }
    }
  }
  // 1b. Fallback：如果没找到结论，尝试用开篇句式
  if (!conclusionFound) {
    for (const pattern of OPENING_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const body = (match[1] ?? match[0]).trim();
        if (body.length >= 15) {
          sections.push({
            type: "callout",
            tone: "conclusion",
            title: "核心观点",
            body: body.slice(0, 600),
          });
          confidence += 0.2;
          conclusionFound = true;
          break;
        }
      }
    }
  }

  // 2. 判断 / 分析
  const judgments: string[] = [];
  for (const pattern of JUDGMENT_PATTERNS) {
    let m: RegExpExecArray | null;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : "g");
    while ((m = regex.exec(text)) !== null && judgments.length < 4) {
      const body = (m[1] ?? m[0]).trim();
      if (body.length >= 15) judgments.push(body.slice(0, 400));
    }
  }
  if (judgments.length > 0) {
    sections.push({
      type: "callout",
      tone: "judgment",
      title: "分析判断",
      body: judgments.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    });
    confidence += 0.2;
  }

  // 3. 建议 / 行动
  const recommendations: string[] = [];
  for (const pattern of RECOMMENDATION_PATTERNS) {
    let m: RegExpExecArray | null;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : "g");
    while ((m = regex.exec(text)) !== null && recommendations.length < 4) {
      const body = (m[1] ?? m[0]).trim();
      if (body.length >= 15) recommendations.push(body.slice(0, 400));
    }
  }
  if (recommendations.length > 0) {
    sections.push({
      type: "callout",
      tone: "recommendation",
      title: "行动建议",
      body: recommendations.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    });
    confidence += 0.2;
  }

  // 4. 风险 / 注意事项
  const warnings: string[] = [];
  for (const pattern of WARNING_PATTERNS) {
    let m: RegExpExecArray | null;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : "g");
    while ((m = regex.exec(text)) !== null && warnings.length < 3) {
      const body = (m[1] ?? m[0]).trim();
      if (body.length >= 15) warnings.push(body.slice(0, 400));
    }
  }
  if (warnings.length > 0) {
    sections.push({
      type: "callout",
      tone: "warning",
      title: "风险提示",
      body: warnings.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    });
    confidence += 0.15;
  }

  // 5. 数据高亮（带货币符号的）
  const dataCards: Array<{ label: string; value: string; unit?: string; trend?: "up" | "down" | "flat"; delta?: string }> = [];
  let cm: RegExpExecArray | null;
  const currencyRegex = new RegExp(CURRENCY_PATTERN.source, "g");
  while ((cm = currencyRegex.exec(text)) !== null && dataCards.length < 4) {
    const currency = cm[1];
    const value = cm[2];
    const unit = cm[3] ?? "";
    const beforeText = text.substring(Math.max(0, cm.index - 100), cm.index);
    const label = extractMetricLabel(beforeText);
    // 没有干净的中文指标词就不要硬造卡片——「¥ 规模」「JP」这种标签比没有卡更糟
    if (!label) continue;

    let trend: "up" | "down" | "flat" | undefined;
    let delta: string | undefined;
    const afterText = text.substring(cm.index, cm.index + 150);
    const upMatch = afterText.match(/(上升|增长|上涨|增长了)\s*([\d.]+)\s*%/);
    const downMatch = afterText.match(/(下降|减少|降低|下滑)\s*([\d.]+)\s*%/);
    if (upMatch) { trend = "up"; delta = `+${upMatch[2]}%`; }
    else if (downMatch) { trend = "down"; delta = `-${downMatch[2]}%`; }

    dataCards.push({
      label,
      value: `${value}${unit}`,
      unit: currency,
      trend,
      delta,
    });
  }

  // 6. 百分比数据（不带货币符号的业务指标）
  let pm: RegExpExecArray | null;
  const percentRegex = new RegExp(PERCENT_PATTERN.source, "g");
  const percentItems: Array<{ label: string; value: string; trend?: "up" | "down" | "flat"; delta?: string }> = [];
  while ((pm = percentRegex.exec(text)) !== null && percentItems.length < 4) {
    const pct = pm[1];
    const beforeText = text.substring(Math.max(0, pm.index - 100), pm.index);
    const label = extractMetricLabel(beforeText);
    // 抓不到干净指标词（比如「建议…从 20%」「过去 7 天是 3.4%」这类句子尾巴）就跳过该百分比
    if (!label) continue;

    let trend: "up" | "down" | "flat" | undefined;
    let delta: string | undefined;
    const afterText = text.substring(pm.index, pm.index + 80);
    if (/上升|增长|上涨/.test(afterText)) { trend = "up"; delta = `+${pct}%`; }
    else if (/下降|减少|降低|下滑/.test(afterText)) { trend = "down"; delta = `-${pct}%`; }
    else if (/持平|稳定|基本/.test(afterText)) { trend = "flat"; delta = `${pct}%`; }

    // 只收集看起来像业务指标的百分比，过滤掉年份等
    const num = parseFloat(pct);
    if (num > 0 && num < 1000) {
      percentItems.push({ label, value: `${pct}%`, trend, delta });
    }
  }

  // 合并数据卡片：同名标签只保留第一个，避免同一指标重复出卡
  const seenLabels = new Set<string>();
  const allDataItems = [...dataCards, ...percentItems].filter((item) => {
    const key = item.label.replace(/\s+/g, "");
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });
  if (allDataItems.length > 0) {
    sections.push({
      type: "data_highlights",
      items: allDataItems.slice(0, 6),
    });
    confidence += 0.15;
  }

  // 7. 趋势条形图
  const trendItems: Array<{ label: string; value: number; valueLabel: string; delta: string }> = [];
  let tm: RegExpExecArray | null;
  const trendRegex = new RegExp(TREND_PATTERN.source, "g");
  while ((tm = trendRegex.exec(text)) !== null && trendItems.length < 6) {
    const direction = tm[2];
    const pct = parseFloat(tm[3]);
    const isDown = /下降|减少|降低|下滑/.test(direction);
    const beforeText = text.substring(Math.max(0, tm.index - 80), tm.index);
    const contextMatch = beforeText.match(/([^\s，。,；;]{2,20})(?=(?:同比|环比)?\s*(?:上升|下降))/);
    const label = contextMatch ? contextMatch[1].replace(/^(?:在|对于|关于|就)/, "").slice(0, 16) : "指标变化";
    trendItems.push({
      label,
      value: isDown ? -pct : pct,
      valueLabel: `${isDown ? "-" : "+"}${pct}%`,
      delta: `${isDown ? "↓" : "↑"} ${pct}%`,
    });
  }

  if (trendItems.length >= 2) {
    const sorted = [...trendItems].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 6);
    sections.push({
      type: "bar_chart",
      title: "关键指标变化",
      items: sorted.map((t) => ({
        label: t.label,
        value: Math.abs(t.value),
        valueLabel: t.valueLabel,
        delta: t.delta,
      })),
      unit: "%",
    });
    confidence += 0.15;
  }

  // 8. 推断 / 分析段
  const inferenceMatch = text.match(/(?:推断层面|分析|说明|这意味着|这说明|表明)[：:，]\s*([\s\S]*?)(?=\n\n|\n(?=[^ \t])|$)/);
  if (inferenceMatch && inferenceMatch[1].trim().length >= 30) {
    sections.push({
      type: "callout",
      tone: "info",
      title: "深度分析",
      body: inferenceMatch[1].trim().slice(0, 300),
    });
    confidence += 0.1;
  }

  return {
    sections,
    confidence,
  };
}

export function tryBuildVisualArtifact(
  content: string,
  existingArtifact?: MessageArtifact,
): MessageArtifact | undefined {
  if (existingArtifact && existingArtifact.kind !== "suggestions") {
    return undefined;
  }

  const result = detectVisualPatterns(content);

  if (result.confidence < 0.15 || result.sections.length === 0) {
    return undefined;
  }

  // 只有文字类 callout、没有任何可“可视化”的数据段时，不应生成 visual_analysis 卡片：
  // 否则会出现“标题是一整句话、数据格 rows=0”的空壳，用户看到的是个没有图的图表卡。
  const hasVisualSection = result.sections.some(
    (section) => section.type === "data_highlights" || section.type === "bar_chart" || section.type === "donut_chart",
  );
  if (!hasVisualSection) {
    return undefined;
  }

  const textOnlySections = result.sections.filter((s) => s.type !== "callout" || (s.title !== "核心结论" && s.title !== "行动建议"));
  const summary =
    textOnlySections.length > 0
      ? content
          .replace(/【[^】]+】/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 2)
          .join(" ")
          .slice(0, 200)
      : content.slice(0, 200);

  const conclusionSection = result.sections.find((s) => s.type === "callout" && s.tone === "conclusion") as { body?: string } | undefined;
  // 标题应是短小概括，不能是一整句话、也不能带数据。截到首个标点，再去掉数字/货币符号/百分比，
  // 避免出现“本季度 GMV ¥1,234,567 较…”这种把一句话当标题的情况。
  const headline = conclusionSection?.body
    ?.replace(/[。；！？!?].*$/, "")
    .replace(/[¥$€£฿]|[\d,.]+%?|[%]|[\d,.]+(?:M|B|K|万|千|亿)?/g, "")
    .replace(/\s+/g, "")
    .slice(0, 16)
    || "数据分析洞察";

  return {
    kind: "visual_analysis",
    headline,
    summary,
    sections: result.sections,
    source: "智能分析自动生成",
  };
}

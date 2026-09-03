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

const DATA_NUMBER_PATTERN = /([\d,]+\.?\d*)\s*(M|B|K|万|千)?\s*(泰铢|人民币|美元|欧元|英镑|件|个|%|)?/g;
const CURRENCY_PATTERN = /([\u0E00-\u0E7F¥$€£])\s*([\d,.]+)\s*(M|B|K|万|千)?/g;
const PERCENT_PATTERN = /([\d.]+)\s*%/g;
const TREND_PATTERN = /(同比|环比)?\s*(上升|下降|增长|减少|降低|下滑|上涨|持平)\s*([\d.]+)\s*%/g;
const SUBJECT_CONTEXT_PATTERN = /([^\s，。,；；\n]{2,20})(?:规模|销量|GMV|销售额|占比|增长率|市场)?/;

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
    const contextMatch = beforeText.match(/([^\s，。,；;]{2,16})(?=(?:\s*)[฿¥$€£])/);
    const label = contextMatch ? contextMatch[1] : `${currency} 规模`;

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
    const contextMatch = beforeText.match(/([^\s，。,；;]{2,20}?)(?=(?:同比|环比|增长|下降|上升|减少|持平)?\s*[\d.]+%?)/);
    const label = contextMatch ? contextMatch[1] : `指标 ${pct}%`;

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

  // 合并数据卡片
  const allDataItems = [...dataCards, ...percentItems];
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
  const recommendationSection = result.sections.find((s) => s.type === "callout" && s.tone === "recommendation") as { body?: string } | undefined;
  const headline =
    conclusionSection?.body?.slice(0, 40)
    ?? recommendationSection?.body?.slice(0, 40)
    ?? "数据分析洞察";

  return {
    kind: "visual_analysis",
    headline,
    summary,
    sections: result.sections,
    source: "智能分析自动生成",
  };
}

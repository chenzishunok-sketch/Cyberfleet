function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*{2,}/g, "")
    .trim();
}

/**
 * Convert LLM Markdown into concise plain text without damaging dates, SKUs or negative values.
 * 空输入返回空串——需要「空就替代」的调用方自己给兜底文案。
 * 之前它直接返回占位句，结果这个占位句被当成"用户问题"塞进了别的模板里。
 */
export function normalizeAssistantText(input: string | undefined | null): string {
  // 上游（LLM respond 参数等）可能传来 undefined/null，这里必须兜底，否则 .replace 直接崩
  const source = String(input ?? "").replace(/\r\n?/g, "\n").replace(/```[^\n]*\n?/g, "");
  const output: string[] = [];
  let listIndex = 0;

  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      listIndex = 0;
      if (output.length && output.at(-1) !== "") output.push("");
      continue;
    }
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) continue;
    if (/^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.includes("-")) continue;

    const boldHeading = trimmed.match(/^\*{2,}(.+?)\*{2,}$/);
    if (boldHeading) {
      listIndex = 0;
      const heading = cleanInlineMarkdown(boldHeading[1]).replace(/[：:]$/, "");
      if (heading) output.push(`${heading}：`);
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      listIndex = 0;
      const text = cleanInlineMarkdown(heading[1]).replace(/[：:]$/, "");
      if (text) output.push(`${text}：`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      const text = cleanInlineMarkdown(bullet[1]);
      if (text) output.push(`${++listIndex}. ${text}`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)、]\s*(.+)$/);
    if (ordered) {
      const text = cleanInlineMarkdown(ordered[1]);
      if (text) output.push(`${++listIndex}. ${text}`);
      continue;
    }

    listIndex = 0;
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed.split("|").map((cell) => cleanInlineMarkdown(cell)).filter(Boolean);
      if (cells.length) output.push(cells.join("；"));
      continue;
    }

    const text = cleanInlineMarkdown(trimmed.replace(/^>\s?/, ""));
    if (text) output.push(text);
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 对外展示用：空内容给一句可读的兜底，避免气泡空着。 */
export function cleanAssistantText(input: string): string {
  return normalizeAssistantText(input) || "这条请求没有生成可展示的内容，请换一种说法再试。";
}

// ─── 空壳回答判定 ─────────────────────────────────────────────
// 只判断「这句话是不是等于没回答」，不评价回答好坏。
// 区别很重要：以前这里有一套 judgeResponseQuality，会按「字数够不够 / 有没有命中关键词 /
// 类目对不对得上」给回答打分，分数低就用固定模板整段重写。结果「你能干嘛」这类正常闲聊
// 被判成「泛化能力清单」，改写成答非所问的兜底，用户反馈"答非所问"。
// 现在只在 ReAct 已经查到数据、模型却只回一句「已分析」时拦下来，让模型自己重写，不替它写。

const SHELL_REPLIES: RegExp[] = [
  // 「已分析」「已完成多步分析」「任务完成」「处理成功」「已生成」——只有动作，没有内容
  /^(?:已经?)?(?:完成|结束|成功|搞定|生成|输出|准备|返回|展示|呈现|处理|分析|查询|读取|获取|整理|汇总)[了好]?(?:多步)?(?:分析|查询|任务|步骤|处理|工作|数据|结果|内容)?[。.！!]?$/,
  // 「分析完成」「查询完毕」——词序反过来，上面那条抓不到
  /^(?:分析|查询|处理|读取|获取|整理|汇总|生成)(?:已|已经)?(?:完成|结束|完毕|好了)[。.！!]?$/,
  // 「任务完成」「操作已完成」「数据处理完毕」
  /^(?:任务|操作|工作|处理|查询|分析|数据|记录)(?:已|已经)?(?:完成|结束|完毕|成功|好了)[。.！!]?$/,
  // 「我已读取数据」「已调用接口」——占了位但没说是什么
  /^(?:我)?已(?:读取|调用|获取|查看|检查|查询|生成)[^。！？.!?]{0,20}(?:接口|数据|记录|结果|步骤)?[。.]?$/,
  // 「请查看上方结果」「见上方」——把东西推给一个并不存在的"上方"
  /^(?:请|可以)?(?:查看|见|参考|参阅|核对)(?:上一?步?的?)?(?:上方|上面|以上)?(?:结果|数据|内容|表格)[。.]?$/,
  /^请(?:查看|见)(?:上方|上面|以上)[^。！？.!?]{0,10}[。.]?$/,
  // 「好的」「收到」——纯应答
  /^(?:好的|收到|明白了?|OK)[。.，,！!]?$/i,
  // 模型偶发把工具名当回答吐出来
  /^respond[。.]?$/i,
];

/**
 * 这句话是不是「空壳回答」——只有动作确认，没有任何可读内容。
 *
 * 只拦这几种确定无信息量的形态，不做长度门槛：用户问「库存多少」，模型答「4053 件」
 * 虽然只有 5 个字，但它是完整回答，不能拦。
 */
export function isShellAnswer(content: string | undefined | null): boolean {
  const text = String(content ?? "").trim();
  if (!text) return true;
  // 多行内容一律不算空壳：有换行说明不止一句确认
  if (text.includes("\n")) return false;
  return SHELL_REPLIES.some((pattern) => pattern.test(text));
}

export function cleanFollowUps(prompts: string[], originalText = ""): string[] {
  const current = originalText.replace(/\s+/g, "").toLocaleLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];

  for (const prompt of prompts) {
    const cleaned = cleanAssistantText(prompt).replace(/\n+/g, " ").replace(/^\d+\.\s*/, "").trim();
    const key = cleaned.replace(/\s+/g, "").toLocaleLowerCase();
    if (!cleaned || cleaned.length > 80 || key === current || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length === 3) break;
  }
  return result;
}

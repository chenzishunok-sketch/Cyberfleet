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
export function normalizeAssistantText(input: string): string {
  const source = input.replace(/\r\n?/g, "\n").replace(/```[^\n]*\n?/g, "");
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

// ─── 回答质量校验：过滤空泛/占位/答非所问的回答，并给出兜底
// ──────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; severity: "high" | "medium"; tip: string }> = [
  // ─── 通用万能话术（最高优先级，必须第一个被命中） ────────────────────────────
  { pattern: /^我可以查询经营数据[、，,]定位商品与库存问题[、，,]生成报告[、，,]或为店铺操作创建待确认的执行计划[。.]?$/, severity: "high", tip: "万能介绍话术" },
  { pattern: /^我可以(?:为您|帮您)?(?:查询|获取|调用|处理|分析|查看|提供)[^。！？.!?]{0,80}(?:或|，|、|,)[^。！？.!?]{0,80}(?:任务|计划|能力|服务|操作|报告|建议)[。.]?$/, severity: "high", tip: "泛化能力清单" },
  // ─── 占位描述类 ────────────────────────────────────────────────────────────
  { pattern: /^我已(?:读取|调用|获取|查看|检查|查询|先读取|生成)[^。！？.!?]{0,40}(?:接口|数据|榜|记录|结果|榜单|步骤|任务|了)?[。.]?$/, severity: "high", tip: "占位描述" },
  { pattern: /^(?:已)?(?:完成|结束|成功|搞定|生成|输出|准备|返回|展示|呈现)[了好]?(?:多步)?(?:分析|查询|任务|步骤|处理|工作)?[。.]?$/, severity: "high", tip: "任务完成话术" },
  { pattern: /^请?(?:查看|见|参考|参阅|核对|看|查看上方|见上方|如上|如图|如表格)[^。！？.!?]{0,30}(?:所示|结果|数据|表格|卡片|内容)?[。.]?$/, severity: "high", tip: "推卸查看话术" },
  { pattern: /^(?:如[下上]|如上所述|如上|以下|下面|如下|根据以上|基于以上)[^。！？.!?]{0,25}（?(?:内容)?(?:所示|显示|如下|所[述示]|总结)?[。.]?$/, severity: "medium", tip: "方向推卸话术" },
  { pattern: /^好的[。，,、.\s]*$|^收到[。，,、.\s]*$|^明白了?[。，,、.\s]*$|^OK[。.，,\s]*$/i, severity: "high", tip: "空泛确认" },
  { pattern: /^这(?:张|个|些|份)?(?:表格|卡片|列表|数据|榜单|内容)?(?:已经|已)?(?:展示|呈现|列出|生成|返回)?(?:给你|在下方|在上面)?[。.]?$/, severity: "high", tip: "推卸展示" },
  { pattern: /任务完成[。.！!]?$|操作已(?:完成|执行)[。.！!]?$/, severity: "high", tip: "结束话术" },
];

/**
 * 判断回答内容的质量：
 *  - 纯占位（"我已读取数据"、"请查看上方结果"等）直接返回 poor
 *  - 太短且没有信息量返回 poor
 *  - 其他情况按长度和内容特征分级
 */
export function judgeResponseQuality(content: string, originalQuestion = ""): {
  quality: "excellent" | "good" | "poor";
  reasons: string[];
  suggestion?: string;
} {
  const text = cleanAssistantText(content);
  const stripped = text.replace(/\s+/g, "");
  const reasons: string[] = [];

  // 1. 检查占位话术
  for (const { pattern, tip } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(text.trim())) {
      reasons.push(`检测到占位话术：${tip}`);
      break;
    }
  }

  // 2. 长度检查：中文内容 < 40 字视为信息不足
  const cnCharCount = (stripped.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const hasNumbers = /\d/.test(stripped);
  if (cnCharCount < 30) reasons.push(`中文内容仅 ${cnCharCount} 字，信息量不足（建议≥60字）`);

  // 3. 没有数字也没有建议，视为纯描述
  const hasSuggestionVerb = /(建议|优先|应该|需要|可以|考虑|不妨|推荐|尝试|接下来|下一步|行动|选品|切入)/.test(text);
  const hasConclusion = /(因此|所以|综上|结论|可见|显然|判断|认为|说明|反映|表明|表现)/.test(text);
  if (!hasNumbers && !hasSuggestionVerb && !hasConclusion) {
    reasons.push("回答中没有给出数据、结论或建议，可能只是复述过程");
  }

  // 4. 答非所问初判：如果原问题含有关键词但回答完全不包含
  const questionKeywords = originalQuestion
    .replace(/[的了是在我有没有与和对为呢吗啊就都吧你要去呢]/g, " ")
    .match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9\-+]{2,}/g) ?? [];
  if (questionKeywords.length && originalQuestion.length) {
    const questionKeySet = new Set(questionKeywords.map((k) => k.toLowerCase()));
    const answerTextLower = text.toLowerCase();
    let matched = 0;
    for (const kw of questionKeySet) {
      if (answerTextLower.includes(kw.toLowerCase())) matched++;
    }
    const hitRate = questionKeySet.size > 0 ? matched / questionKeySet.size : 0;
    if (hitRate < 0.3 && questionKeySet.size >= 2) {
      reasons.push(`回答中仅命中了原问题关键词的 ${Math.round(hitRate * 100)}%，可能答非所问`);
    }
  }

  // 5. 类目/数据错位检测：原问题明确提了"X类目/X品类"，但回答里出现了明显不相关品类（如问家纺却出现 iPhone / 香水 / serum）
  if (/(类目|品类|行业|赛道|好卖|热销|选品|市场)/.test(originalQuestion)) {
    const questionCategory = originalQuestion.match(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9\-+]{1,10})(?:类目|品类|行业|赛道)/)?.[1]
      ?? (/家[纺织纺]|家纺|布艺|床上|四件套|床|枕|被|窗帘|地毯|沙发布|毛巾|浴巾/.test(originalQuestion) ? "家纺布艺" : undefined)
      ?? (/美妆|护肤|化妆|精华|乳液|面霜|口红|面膜|防晒|卸妆|洁面|香水|彩妆/.test(originalQuestion) ? "美妆护肤" : undefined)
      ?? (/3c|数码|手机|平板|电脑|笔记本|耳机|充电|充电宝|相机|手表|智能|电子/.test(originalQuestion) ? "3C数码" : undefined)
      ?? (/服饰|衣服|服装|鞋|靴|包|帽|袜|内衣|皮带|男装|女装|童装/.test(originalQuestion) ? "服饰鞋包" : undefined);
    if (questionCategory) {
      const unrelatedHits = [
        { re: /\b(iphone|vivo|oppo|samsung|xiaomi|redmi|android|手机|平板|笔记本|电脑|earphone|airpod)\b/i, label: "3C数码/手机" },
        { re: /\b(serum|perfume|parfum|cream|lotion|essence|lipstick|mascara|sunscreen|精华|乳液|面霜|香水|面膜|口红|粉底)\b/i, label: "美妆护肤" },
        { re: /\b(bedding|sheet|pillow|mattress|blanket|quilt|curtain|carpet|家纺|床上|四件套|床笠|床垫|枕套|被|毛毯|地毯|窗帘|毛巾|浴巾)\b/i, label: "家纺布艺" },
        { re: /\b(shoes|sneaker|dress|shirt|jacket|pants|bag|handbag|服装|鞋|靴|包|衣服|服饰)\b/i, label: "服饰鞋包" },
      ];
      const unrelated = unrelatedHits.filter(({ re }) => re.test(text) && !new RegExp(questionCategory, "i").test(text));
      if (unrelated.length > 0 && !new RegExp(questionCategory).test(text)) {
        reasons.push(`你问的是「${questionCategory}」，但回答里出现了「${unrelated.map((u) => u.label).join("、")}」相关内容且完全没提${questionCategory}，数据结论可能错位`);
      }
    }
  }

  // 判定等级
  if (reasons.length >= 2 || reasons.some((r) => r.includes("占位话术") || r.includes("推卸"))) {
    return {
      quality: "poor",
      reasons,
      suggestion: "补充：基于已有数据给出具体结论、3 条要点分析和至少 2 条可操作建议；避免只用过程话术占位。",
    };
  }
  if (reasons.length === 1) return { quality: "good", reasons };
  return { quality: "excellent", reasons };
}

/**
 * 针对低质量回答给出兜底补充文案。结合场景（原问题 + 已知 artifact 数量）给出通用分析/建议兜底，
 * 让用户即使 LLM 回答放水也能看到有用内容。
 */
export function enrichPoorResponse(
  originalText: string,
  userQuestion: string,
  options: {
    artifactHint?: string;
    recordCount?: number;
    sceneLabel?: string;
  } = {},
): string {
  const existing = normalizeAssistantText(originalText);
  const { artifactHint = "", recordCount = 0, sceneLabel = "" } = options;
  const hints: string[] = [];

  // 场景兜底：市场/选品类
  if (/(市场|大盘|全站|热销|畅销|好卖|爆款|选品|什么好卖|热卖)/i.test(userQuestion)) {
    if (recordCount) hints.push(`当前榜单共 ${recordCount} 条记录，排名越靠前代表该时间窗 GMV 表现越强。`);
    hints.push("竞争判断：先看前 3 名与 4-10 名的差距——如果差距悬殊，说明赛道头部集中，新卖家切入要先找差异化定位；如果差距不大，说明仍有空位。");
    hints.push("方向筛选：优先看价格带与评价分。价格低于中位数的商品需要高周转支撑，高于中位数的商品需要有差异化卖点或更强的内容与达人资源。");
    hints.push("下一步建议：① 从 TOP10 中挑出与你现有货源或供应链最匹配的 2-3 个作为对标；② 结合店铺已有商品的库存、评价分、价格带，决定是切入同款、做差异化卖点，还是先观望。");
  } else if (/(店铺|本店|我的|店内|商品|SKU).*(表现|数据|分析|排行|诊断)/i.test(userQuestion) || /(商品表现|店铺数据|SKU 排行|诊断)/i.test(userQuestion)) {
    if (recordCount) hints.push(`当前展示 ${recordCount} 项店铺数据，排名靠前的即为你当前的核心流量/GMV 来源，优先投入资源。`);
    hints.push("结构判断：先看前 3 项的占比是否过高（>50%）。如果是，说明收入依赖单一 SKU，短期安全但长期脆弱；如果分布均衡，说明商品结构健康。");
    hints.push("下一步建议：① 头部 SKU 补库存、扩曝光、盯退款率；② 腰部 SKU 用店播/短视频冲量做孵化；③ 尾部不动销 SKU 清库存或优化标题/主图后复测。");
  } else if (/(达人|creator|创作者|主播|KOC|KOL)/i.test(userQuestion)) {
    if (recordCount) hints.push(`当前共 ${recordCount} 位达人，按 GMV 排序；粉丝规模≠转化能力，优先看粉赞比和挂链商品是否匹配。`);
    hints.push("筛选建议：先按品类匹配（美妆找美妆达人，不要跨品类投），再看粉丝量级：5k-50k 的腰尾部/KOC 性价比通常最高，大主播适合品牌曝光不适合利润款。");
    hints.push("下一步建议：① 挑出粉丝画像与价格带最匹配的 3-5 位达人；② 先发样品+脚本，让达人出 1 条挂车短视频测数据；③ 数据好的再谈专场或长期佣金合作。");
  } else {
    // 通用兜底：不知道用户在问什么场景，就不要假设成榜单/选品。
    // 以前这里直接给"排名靠前即表现最强""对标 TOP10"这类话术，
    // 结果"查待发货订单"也被答成选品分析，属于答非所问。
    if (recordCount) hints.push(`本次从官方接口取回 ${recordCount} 条记录，完整字段见下方表格。`);
    if (sceneLabel) hints.push(`本次查询对象：${sceneLabel}。`);
    hints.push("我没有足够信息替你下结论。如果表格里已有你要的字段，可以直接按列核对；如果需要进一步分析，请告诉我关注哪个维度（时间、商品、状态或金额）。");
  }

  const sceneText = sceneLabel ? `（${sceneLabel}）` : "";
  const head = existing && !PLACEHOLDER_PATTERNS.some(({ pattern }) => pattern.test(existing.trim()))
    ? existing + "\n\n"
    : "";
  // artifactHint 自带句号时不要再补一个，否则会出现「共 1 条记录。。」
  const hintText = artifactHint.trim().replace(/[。．.]+$/, "");
  const footer = hintText ? `\n\n注：${hintText}。` : "";
  return `${head}关于你问的「${normalizeAssistantText(userQuestion).replace(/\s+/g, " ").slice(0, 60) || "当前查询"}」${sceneText}，补充要点如下：
${hints.map((h, i) => `${i + 1}. ${h}`).join("\n")}${footer}`.trim();
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

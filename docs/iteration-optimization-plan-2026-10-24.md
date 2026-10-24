# Cyberfleet 迭代与优化方案

> 生成时间：2026-10-24　|　基于代码实测取证，非泛泛而谈
> 项目定位：面向 TikTok Shop 日本市场（Cashio）的对话式跨境电商多 Agent 运营工作台

---

## 一、现状体检（实测数据）

| 维度 | 实测结果 |
|---|---|
| 代码规模 | 约 36,000 行（server 23,221 行 / 64 文件，src 48 文件） |
| 测试 | 32 文件 / **199 用例全过**，tsc 严格类型干净 |
| 依赖 | TypeScript 全栈 + React 19 + Vite 8 + Express 5 + SQLite |
| CI | **无**（`.github/` 不存在） |
| 鉴权 | `auth-gate.ts` 存在但默认关闭（需配 `APP_PASSWORD`） |
| 凭证安全 | `.env` / `.data` 已正确 gitignore ✅ |
| 最重文件 | `orchestrator.ts` **2240 行**（含约 50 个函数，横跨 5 类职责） |

**架构分层**（server 侧）：

```
路由层   llm.ts（意图路由 decideWithLlm + ReAct reactLoop）+ inferDecision 确定性兜底
编排层   orchestrator.ts ← 核心大脑（2240 行）
工作流   dag-workflow-engine + 三业务流（发布/秒杀/达人）
连接器   TikTok / 妙手 ERP / 1688-TMAP / 出海匠 / 飞书
持久化   workflow-store / memory-layer / intelligence-store / action-plan-store
```

---

## 二、优先级矩阵

| 优先级 | 事项 | 影响 | 成本 | 风险 |
|---|---|---|---|---|
| **P0-1** | 清理演示模式死代码与错误地区数据 | 中 | 低 | 低 |
| **P0-2** | `orchestrator.ts` 拆分 | 高 | 中 | 中 |
| **P0-3** | 1688 尺寸缺失的产品级兜底 | **高（业务断链）** | 中 | 低 |
| P1-1 | 可观测性（结构化日志 + 错误追踪） | 高 | 中 | 低 |
| P1-2 | 响应性能优化（首字时间） | 高 | 中 | 低 |
| P1-3 | 真实链路测试补齐 | 中 | 中 | 低 |
| P2-1 | 多店铺 / 多用户边界收敛 | 中 | 高 | 中 |
| P2-2 | CI + 部署文档 | 中 | 低 | 低 |
| P2-3 | 鉴权默认加固 | 中 | 低 | 低 |

---

## 三、P0-1：清理演示模式死代码与错误地区数据

### 问题（实测证据）

`server/data.ts`（110 行）是一份**硬编码的美国站演示快照**，含 `Luma Living US` / `USD` / `UTC-7` / `$43.99` 等。它至今仍被 `orchestrator.ts` 引用：

- `orchestrator.ts:382-384` — `salesArtifact()` 用 `dashboard.metrics` / `dashboard.store.currency`
- `orchestrator.ts:419` — `createPlan()` 审批计划写入 `store: dashboard.store.id`
- `orchestrator.ts:425` — `store: dashboard.store.name`（即 "Luma Living US"）
- `orchestrator.ts:408-416` — 计划 diff 用演示商品 `$43.99` / `[42,86,18]`

`createPlan` 仅被 `renderDecision`（orchestrator.ts:684/688）调用，而 `renderDecision` **只在 `DEMO_MODE === "true"` 时执行**（`orchestrator.ts:2033-2034`）。项目 `.env` 实际是 `DEMO_MODE=false`。

**结论**：这是一段**只在演示模式跑的死代码，且里面的数据仍是美国站口径**，与项目已确立的「只经营日本市场」定位直接冲突。历史上已因它出过一次真 bug（审核卡显示 "Luma Living US"）。留着是持续的地雷。

### 修改方案

1. **判定保留范围**：确认 `DEMO_MODE` 是否还需要（README 说「配置连接后页面只使用真实数据」）。
   - 若不再需要演示 → **整体删除** `server/data.ts` 及 `salesArtifact` / `productsArtifact` / `createPlan` 等仅演示使用的函数，同步删掉 `renderDecision` 分支与相关测试。
   - 若需保留（给客户演示）→ **把演示数据改成日本站口径**：店铺名改 Cashio、币种 JPY、时区 `Asia/Tokyo`、价格改 `¥` 整数（日本站无小数）。
2. **加静态守卫**：在 `data.ts` 顶部注释 + 一处运行时断言，禁止非 DEMO 模式引用：
   ```ts
   // 仅供 DEMO_MODE=true 使用；真实链路严禁引用
   if (process.env.DEMO_MODE === "true" && /US|USD|UTC-7/.test(JSON.stringify(dashboard))) {
     console.warn("[data.ts] 演示数据仍是美国站口径，需更新为日本站");
   }
   ```
3. **清理引用**：`orchestrator.ts` 中所有 `dashboard.*` 引用集中到一个 `demo/` 目录模块，主流程零引用。

### 验收标准

- 全项目 grep `Luma|USD|UTC-7|\$43\.99` 在**非演示代码路径**为 0
- `tsc -b` 干净、199 测试全过
- DEMO_MODE=true 启动时演示数据为日本站口径

### 风险

低。删除前先确认是否有人用演示模式做客户演示——**建议先问一句再删**。

---

## 四、P0-2：`orchestrator.ts` 拆分（2240 行 → 5 个模块）

### 问题（实测证据）

`orchestrator.ts` 内含约 50 个函数，职责横跨 5 类，函数名实测分布：

| 职责 | 代表函数（行号） |
|---|---|
| 意图推断 | `inferExplicitDecision:533`、`inferDecision:593`、`inferFastReadDecision:658`、`asksForBestSellers:523` |
| Artifact 构造 | `salesArtifact:378`、`productsArtifact:394`、`liveSalesArtifact:906`、`liveReportArtifact:1115` |
| 审批计划 | `createPlan:405`、`createMiaoshouApproval:442`、`extractQuantity:364` |
| 消息渲染 | `message:287`、`renderDecision:667`、`renderLiveDecision:1209`、`finalQualityGate:329` |
| 工具执行 | `createLiveToolExecutor:1361`、`ensureDelegationHandlers:1555` |

**后果**：改动一处牵连全局（今天修「答非所问」就是在 2240 行里定位质量门）。新人接手成本高，回归风险大。

### 修改方案（渐进式，不一次性大爆炸）

按依赖顺序抽出 5 个模块，**每抽一个跑一次全量测试**：

```
server/orchestrator/          ← 新目录
  index.ts                    主编排（保留 handleChat 等入口，目标 <400 行）
  intent.ts                   ← 抽出 inferExplicitDecision / inferDecision / asksForBestSellers / extractDays
  artifacts.ts                ← salesArtifact / productsArtifact / liveSalesArtifact / liveProductsArtifact / liveReportArtifact
  approval.ts                 ← createPlan / createMiaoshouApproval / extractQuantity / extractPrice / extractSkus
  render.ts                   ← message / renderDecision / finalQualityGate / cleanFollowUps 相关
  tools.ts                    ← createLiveToolExecutor / ensureDelegationHandlers
```

**执行步骤**：
1. 先抽**最独立**的 `artifacts.ts`（纯构造函数，无跨模块副作用）
2. 再抽 `intent.ts`（纯函数 + 正则，易测）
3. 再抽 `approval.ts`
4. 再抽 `render.ts`（注意 `message()` 依赖 `judgeResponseQuality`，需一并迁移）
5. 最后 `tools.ts`
6. 原 `orchestrator.ts` 改为 re-export 门面，保证外部 import 不变

**关键约束**：
- 保持 `server/orchestrator.ts` 的对外导出签名不变（其他文件 import 它），内部转发到子模块，避免一次性改所有引用
- 每步 `npx tsc -b && npx vitest run` 必须全绿才继续

### 验收标准

- `orchestrator/index.ts` < 400 行
- 199 测试全过、tsc 干净
- 外部 import 路径无需改动（门面转发）

### 风险

**中**。这是纯重构，不改行为。最大的坑是 `message()` 的质量门逻辑（今天刚修过）——抽出时务必保留 `DEMO_MODE === "true"` 守卫，否则「答非所问」bug 会复发。**建议抽完立刻用「你能干嘛」这类闲聊真机验证一次。**

---

## 五、P0-3：1688 尺寸缺失的产品级兜底（业务闭环断点）

### 问题（实测证据 · 客观数据缺口）

发布→定价→秒杀闭环中，**定价环节会断**。根因：1688 帽子类等商家普遍不填外箱尺寸。

实测两件商品都缺：
- `1081643977104`（貂皮帽子）：TMAP `package_info` 全 None、`product_props` 无尺寸、妙手采集箱 `1×1×1` 占位
- `727326032966`（另一款）：同样全缺

链条断点：缺尺寸 → 算不出体积重 `J` → 计费重 `L` 断 → 物流价 `Q` 断 → 成本 `T` 断 → **定价公式 `V = T/(rate×(1-comm-margin))` 完全算不出来**。

代码里目前的处理是「失败原因写进 `run.warnings`」，即**告诉用户失败了，但没有给出路**。

### 修改方案（三层兜底，从好到次）

**第 1 层：按类目建立尺寸模板库**（推荐，性价比最高）
```ts
// server/product-dimension-templates.ts
export const CATEGORY_DIMENSION_TEMPLATES: Record<string, { l:number; w:number; h:number; note:string }> = {
  "帽子":   { l: 30, w: 25, h: 15, note: "帽类常规外箱估算" },
  "袜子":   { l: 27, w: 17, h: 3,  note: "服饰小件袋装估算" },
  "手套":   { l: 25, w: 18, h: 3,  note: "" },
  // ...按已成交品类的实际外箱尺寸持续补充
};
```
在 `pricing-autostart.ts` 的 `autostartPricingAfterPublish` 里：TMAP 拿不到尺寸 → 用 `inferCategoryFromTitle()` 推出的类目查模板 → 命中则用模板尺寸并在飞书行标注「尺寸为类目估算值」。

**第 2 层：允许用户在卡片上补尺寸**
定价失败时，卡片不只显示「无法定价」，而是渲染一个**输入框**：「请补充外箱尺寸（长×宽×高 cm）」，用户填完直接重跑定价。把死路变成一步交互。

**第 3 层：重量反推兜底**
妙手 `info.weight` 是真实的（如 0.1kg）。可建一个「重量 → 估算体积」的经验系数表（服装轻泡货约 1kg≈6000cm³），作为最后兜底，同样标注为估算值。

### 验收标准

- 用 `1081643977104` 跑一遍：定价不再报「无法获取尺寸」，能用类目模板算出 V/Y
- 飞书写入行有「估算」标记，用户一眼能看出哪些是实测哪些是估算
- 定价失败卡片出现补尺寸输入框

### 风险

低。关键是**必须标注估算值**，不能让估算价冒充实测价误导经营决策。

---

## 六、P1-1：可观测性（当前是黑盒）

### 问题

今天排查 bug 时，服务日志只有 21 行启动信息——**真实请求链路、LLM 耗时、第三方 API 失败全都不可见**。全靠 `console.warn` 零散输出。排查成本极高。

### 修改方案

1. **结构化日志**
   ```ts
   // server/logger.ts
   export const log = {
     info: (event: string, data?: Record<string, unknown>) => ...,
     warn: (event: string, data?: Record<string, unknown>) => ...,
     error: (event: string, err: unknown, data?: Record<string, unknown>) => ...,
   };
   ```
   统一替换散落的 `console.warn`，输出 JSON 行（含时间戳、event、traceId）。

2. **请求 traceId**：每个 `/api/chat` 请求生成 `traceId`，贯穿 LLM 调用 → 工具执行 → 响应，日志里能串成一条链。

3. **关键埋点**（必须有）：
   - LLM：每次调用的 model、耗时、token、是否重试、是否超时
   - 第三方：TikTok / 妙手 / TMAP / 飞书 每次调用的耗时与成败
   - ReAct：每步耗时、是否触发预算收敛
   - 定价/秒杀自动链路：每步结果（今天就是靠这条日志定位到断链的）

4. **`/api/health` 补全**：目前不报出海匠状态（历史遗留），补齐全部连接器。

### 验收标准

- 一次对话能在日志里完整还原调用链
- 出 bug 时 5 分钟内能定位到具体是哪一跳

---

## 七、P1-2：响应性能优化

### 问题（实测证据）

`server/llm.ts` 实测配置：
- `llm.ts:430` — 单次请求 `AbortSignal.timeout(45_000)`
- `llm.ts:414` — `maxRetries = 3`，指数退避（1s/2s/4s，上限 5s）
- `llm.ts:724` — ReAct 预算 `budgetMs` 默认 **70 秒**，最多 5 步

**最坏耗时推算**：一次提问若上游抖动，单步 `45s + 退避` 可到 ~50s，5 步 + 重试最坏可达 **数分钟**——这就是你反馈的「时快时慢、要等好几分钟」的机制来源。

### 修改方案

1. **区分快慢请求设超时**
   - 意图路由（`decideWithLlm`，maxTokens 360）→ 超时降到 **15s**
   - 最终回答（ReAct 收敛后）→ 保持 45s
   - 关键：**意图路由不该让用户等 45 秒**

2. **重试只对可重试错误**：429/503/网络超时才重试；4xx（参数错、鉴权失败）**立即失败不重试**，避免白等 3 轮。

3. **首字时间**：ReAct 第 0 步用 fastModel + 已开启流式 `onToken`，继续保证「先出字再查数据」。

4. **预算可调**：把 `REACT_BUDGET_MS` 写进 `.env.example` 并默认降到 **45s**（70s 对对话场景偏长）。

5. **并发**：`decideWithLlm` / `reactLoop` 开头的 5 个能力描述加载（`getSkillTools` 等，llm.ts:711-718）**已经串行 await**，虽然已有内存缓存，但首次仍串行——改 `Promise.all`。

### 验收标准

- 一次普通提问 P95 < 15s
- 上游 5xx 时快速失败并给出明确提示，不再静默重试 3 轮

### 风险

低。改超时前先确认 DeepSeek 正常响应耗时区间，别把超时设得比正常响应还短。

---

## 八、P1-3 / P2 项（简述）

### P1-3 真实链路测试补齐
当前 199 测试多为单元/集成，**缺少「图片→发布→定价→秒杀」的端到端真实链路测试**（历史遗留已多次提到未真机验证）。
方案：加一组 `tests/e2e-live.test.ts`，用 `.env` 真实凭证跑只读链路 + 一个很短的测试活动，用 `describe.skipIf(!process.env.RUN_LIVE)` 控制，默认不跑。

### P2-1 多店铺 / 多用户边界收敛
README 明确「单用户、无多租户」，但代码已支持多 TikTok 账号绑定。二者边界会持续模糊。
方案：要么**明确砍掉**多账号（减复杂度），要么**补完整**（店铺选择器贯穿所有写操作，审批卡强制显示目标店铺）。建议先砍——真实只经营 Cashio 一家店。

### P2-2 CI
无 CI，靠人肉 `npm run typecheck && npm test`。
方案：加 `.github/workflows/ci.yml`，push/PR 时跑 typecheck + vitest + build。**成本低、收益明确，建议顺手做。**

### P2-3 鉴权默认加固
`auth-gate.ts` 写得不错（HMAC 票据、限流、HttpOnly Cookie），但**默认不启用**。
方案：在 `.env.example` 加显著注释，README 增加「公网部署前必须设 `APP_PASSWORD`」的警告段落。若曾计划公网部署（`pangjian.xyz/cyberfleet/`），**这条必须做**。

---

## 九、建议执行顺序

```
第 1 周  P0-1（清理演示死代码，先确认是否还需要演示模式）
        P0-3（尺寸模板库 —— 直接打通业务闭环，见效最快）
        顺手做 P2-2（CI）

第 2 周  P1-1（可观测性）—— 有了日志，后面重构才敢下手

第 3 周  P0-2（orchestrator 拆分）—— 渐进式，每步跑测试

第 4 周  P1-2（性能）+ P1-3（e2e）+ P2-1/P2-3
```

**核心原则**：先补可观测性再动刀重构；先打通业务闭环再优化代码美观度。

---

## 十、不建议现在动的

- **换框架 / 换语言 / 上微服务**：当前 36k 行单体的复杂度，远没到需要拆服务的程度，收益为负。
- **大改数据库**：SQLite 对单用户本地场景完全够用。
- **重写 LLM 路由为 Agent 框架（LangChain 等）**：现有 `decideWithLlm + reactLoop` 已跑通且可控，引入框架只会增加不确定性和 token 成本。

---

*本文档基于 2026-10-24 代码实测。文中行号均来自当时代码，改动前请以实际文件为准复核。*

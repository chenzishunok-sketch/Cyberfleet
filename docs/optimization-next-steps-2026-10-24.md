# Cyberfleet 深度体检与下一步优化建议

> 生成时间：2026-10-24 夜　|　全部结论来自代码、构建产物、运行日志的实测，不是推测
> 与上午那份 `iteration-optimization-plan-2026-10-24.md` 的关系：那份的 P0-1（演示模式）、P2-1（多店铺）已完成，
> P1-2（响应性能）做了第一轮。本文只写**现在还没解决、且投入产出比最高**的部分。

---

## 一、体检数据

| 维度 | 实测 |
|---|---|
| 代码规模 | 35,071 行（server 23,044 / 63 文件；src 10,839 / 48 文件；shared 1,188 / 5 文件） |
| 测试 | 36 文件 / 3,799 行 / **206 用例全过**，`tsc -b` 干净，零 `any`、零 TODO |
| 接口 | 86 个路由（GET 39 / POST 38 / DELETE 5 / PATCH 2 / PUT 2），42 个写接口中 21 处 zod 校验 |
| 持久化 | 1 个 SQLite（13MB，9 张表）+ **5 个 JSON 文件**（learning-loop 264KB / memory-layer 98KB / scheduler / skills / memory） |
| 前端产物 | 入口 148KB + react 180KB + CSS 160KB（gzip 合计约 130KB）；**另有 pixi 712KB 被首屏预加载** |
| 外部依赖 | 19 处 `fetch`，17 处显式超时（其余 2 处是 SSE 长连接，合理） |
| 可观测性 | 74 条 `console.*`，**0 个请求链路 ID**，无错误追踪 |
| 工程护栏 | **无 CI、无 ESLint/Prettier、无 `engines` 声明** |
| 运行日志实测 | 工具调用 8–874ms（很快）；**LLM 单步 0.9–8.6s，一次复杂提问 4 步合计约 17s** |

---

## 二、最该先做的五件事（按投入产出排序）

### ① 对话慢和贵的真正原因：上下文在每一步都被重发一遍

**证据**
- `server/llm.ts:41` 定义 **23 个工具**，整个数组约 8,981 字符 ≈ **5,600 tokens**，每次 ReAct 迭代都随 `toolDefs` 重发（`llm.ts:750`）。
- 工具结果进 `messages` 时**没有任何长度上限**（`llm.ts:838-841`），`list_products` 这类工具一次可能返回几千字。
- `AGENT_SYSTEM_PROMPT` 1,794 字符 ≈ 1,100 tokens，同样每步重发。
- 结果：第 4 步的耗时是 5.8–6.5s，第 2 步只要 0.9s —— **越往后越慢，因为它要重新读完前面所有工具返回**。
- 日志里一次提问出现 `step1 tools=4 → step2 tools=3 → step3 tools=1 → step4 tools=1`，共 9 次工具调用。

**怎么改（按收益排序）**
1. 工具返回结果进模型上下文前**截断到 1,200 字**并标注「共 N 条，已省略 M 条」，完整数据仍留在 `steps` 里供最终回答使用。这是改动最小、收益最大的一刀。
2. 工具按场景分组，只下发当前意图需要的子集（`agentRegistry.filterToolsForAgent` 已有骨架，把粒度从「按 Agent」细化到「按意图」）。目标：常态只发 8–10 个工具，省 3,000+ tokens/步。
3. 第 3 步之后禁止再调新工具，强制收敛（现在靠 70s 预算兜底，太粗）。

**预期**：复杂提问 17s → 8–10s；单次提问 token 成本下降 40% 左右。

---

### ② 聊天记录只存在浏览器里，换个设备就没了

**证据**：`src/conversation-store.ts` 全部走 `localStorage`，上限 40 个会话（`MAX_CONVERSATIONS`），后端没有任何会话接口。
写失败会弹一次 toast（`App.tsx:190`，这点做得对），但**数据本身没有归宿**。

**影响**：清缓存 / 换浏览器 / 换电脑 = 历史全丢；也没法做跨端、分享、审计。
**怎么改**：`workflow.sqlite` 里加 `conversations` / `messages` 两张表，前端改为「本地缓存 + 服务端为准」的双写；保留 40 条上限做本地裁剪。工作量约 1 天，属于「补基础设施」性质。

---

### ③ 首屏被塞了 712KB 的 3D 办公室资源

**证据**：`dist/index.html` 里有 `<link rel="modulepreload" href=".../pixi-*.js">`，而 pixi 只被 3D 办公室页用到（`src/scene/*`，20 文件 / 3,387 行），该页面本身已经是 `lazy()` 加载的。
另有一次对照实验：把 pixi 从 `manualChunks` 移除后，预加载列表换成了 recharts（349KB）—— 说明是打包器的预加载策略在「帮着」把大依赖提前拉。

**怎么改**：用 `build.modulePreload.resolveDependencies` 把 `pixi` / `recharts` 从首屏预加载里过滤掉；或给办公室页单独开一个入口。
**预期**：首屏可交互时间在弱网下明显改善，移动端流量省 700KB。

---

### ④ 数据存了两套，备份只管了一半，而且不清理

**证据**
- 业务数据一边在 SQLite（`workflow_runs` 13 行、`workflow_events` 539 行、`action_plans` 30 行、`content_*` 10 行），一边在 JSON（学习回路 264KB、记忆层 98KB、定时任务、技能库、记忆）。
- `server/database-backup.ts` 每天备份 `workflows.sqlite`，**没有任何保留期清理**：`.data/backups` 已经 12MB，按天线性增长（一年 4GB+）。
- JSON 那 5 个文件**完全不在备份范围内**；`skills.json` 存着第三方密钥，`scheduler-tasks.json` 是唯一的任务定义来源。
- `.data` 里还残留一个 `scheduler-tasks.json.69519.tmp`（进程在 rename 前被杀），说明原子写缺少启动时清理。

**怎么改**
1. 备份函数加保留策略：保留最近 7 天 + 每月 1 号，其余删掉（10 行代码）。
2. 把 5 个 JSON 也纳入每日备份（打包成一个 tar.gz 即可）。
3. 启动时清理 `.data/*.tmp`（超过 1 小时的）。
4. 中期：把 `learning-loop` / `memory-layer` 这两个持续增长的大文件迁进 SQLite，JSON 只留配置类小文件。

---

### ⑤ 没有 CI，改完靠手动跑测试

**证据**：无 `.github/`，无 ESLint/Prettier 配置，`package.json` 没有 `engines`（而项目用了 Node 22+ 才有的 `node:sqlite`，新同事用 Node 20 会直接起不来）。
另外 63 个 server 模块里有 **25 个没有任何单测直接引用**，包括 `auth-gate`、`task-queue`、`dag-workflow-engine`、`workflow-coordinator`、`memory-layer`、`learning-loop`（后两个今天刚加固过，但没有回归用例）。

**怎么改**：GitHub Actions 一个 yml，`npm ci && npm run typecheck && npm test && npm run build`，10 分钟内能跑完；顺手加 `engines: { node: ">=22.5" }` 和 ESLint（`no-floating-promises` 这一条就能抓出不少隐患）。

---

## 三、第二梯队（值得做，但不着急）

| 事项 | 现状 | 建议 |
|---|---|---|
| 页面没有 URL | `activeView` 只是内存状态，刷新立刻回到对话框，页面无法收藏/分享 | 改成 hash 路由（`#/workflows`），半天工作量 |
| 两套工作流引擎 | `workflow-core` 支撑发布/秒杀/达人三条流水线，`dag-workflow-engine` 又支撑模板与协调器，审批/重试/状态机各写一遍 | 先画清边界，把三条流水线逐步迁到 DAG 上；不迁就在文档里写死「新流程一律用 DAG」 |
| `orchestrator.ts` 2,028 行 / 51 个函数 | 仍是最大单体 | 按「意图推断 / 工具执行 / 消息渲染 / artifact」拆四个文件，先拆纯函数部分 |
| 可观测性 | 只有 `console.log`，出问题靠翻 PM2 日志 | 结构化日志 + 一个 `requestId` 串起 HTTP → LLM → 工具；再上错误追踪 |
| 无接口限流 | 写接口没有频率限制（`auth-gate` 只保护登录） | 对 `/api/chat`、`/api/workflows/*` 加简单令牌桶，防手抖连点 |
| 回答质量无度量 | 没有评测集，「改好了」全靠肉眼 | 建 20 条黄金问题（含期望事实），每次改 prompt 前后跑一遍对比 |

---

## 四、建议的推进顺序

```
第 1 天  ① 工具结果截断 + 意图级工具子集     ← 用户体感最明显
第 2 天  ⑤ CI + engines + ESLint            ← 后面所有改动的安全网
第 3 天  ④ 备份保留期 + JSON 纳入备份 + tmp 清理
第 4-5 天 ② 会话上云（SQLite 两张表）
第 6 天  ③ 首屏预加载瘦身 + hash 路由
之后     第三节的第二梯队（工作流收敛 / orchestrator 拆分 / 可观测性）
```

判断标准：①② 做完，用户能直接感觉到「变快、历史不丢」；④⑤ 做完，团队能少踩坑；③ 是体验分。

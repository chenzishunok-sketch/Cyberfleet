# 出海匠接入 + 全量 API 能力与业务场景梳理

> 生成时间：2026-10-23 03:48 · 出海匠 API Key 已写入 `Cyberfleet/.env` 并真机验证通过

---

## 一、出海匠接入结果

### 1. 已完成

| 项 | 值 |
|---|---|
| Key 写入位置 | `Cyberfleet/.env` → `CHUHAIJIANG_API_KEY=<已配置>` |
| MCP 网关 | `https://mcp.gateway.chuhaijiang.com/mcp`（streamable HTTP） |
| 真机连接 | ✅ 成功，21 个工具全部发现 |
| 暴露给 Agent | ✅ 12 个**只读**工具（写操作/消耗类工具被隔离，需审批） |
| 账号状态 | app_id `1328` · **余额 826.2 credits** · tier `payg` · active |
| 数据实测 | ✅ `search(products/us/gloves)` 返回 10000 条，含真实 GMV/销量/评分 |

### 2. 暴露的 12 个只读工具（`chuhaijiang_` 前缀）

| 工具 | 能力 | 关键参数 |
|---|---|---|
| `search` | 万能入口：搜商品/达人/视频/店铺/广告/直播 | `entity`(products/creators/videos/shops/ads/livestreams)、`country`、`keyword`、`category`、`sort`、`limit` |
| `get_detail` | 单实体深挖：评分/SKU/渠道数据 | `entity`、`id`、`country`、`include` |
| `get_related` | 关系网：谁在卖/谁在推/买家评价/竞品 | `entity`、`id`、`relation`(creators/videos/buyers/competitors)、`country` |
| `amazon` | Amazon 交叉验证：长期需求/评论痛点/价格锚定 | `action`(search)、`marketplace` |
| `check_task` | 查询 ai_generate 任务状态 | `task_id` |
| `canvas_tasks` | 查询画布生成任务状态 | `action`、`params` |
| `assets` | 浏览/加载画布素材 | `action`、`params` |
| `social_accounts` | 已连接的社媒账号与授权 | `action`、`params` |
| `social_comments` | 读/同步/回/隐藏/删评论 | `action`、`params` |
| `social_analytics` | 社媒表现：KPI/趋势/爆款视频/爆款商品 | `action`、`params` |
| `social_seller` | 自有 TikTok Shop 报告/类目/库存/订单 | `action`、`params`（需 seller 授权） |
| `account_info` | 当前额度与套餐查询 | 无 |

### 3. 隔离边界（安全设计）

出海匠有 21 个工具，但只暴露 12 个只读的。以下**不进入** Agent 工具列表，必须走 ActionPlan 审批闭环才能用：

- `ai_generate`（视频/图片生成，消耗 credits）
- `canvas`（画布生成）
- `video_editor`
- `social_publish`（发帖）
- `social_messages`（私信）
- `social_tools` / `upload_file`

理由：这些要么消耗套餐额度，要么是外部写操作，直接暴露给 LLM 有失控风险。

---

## 二、本轮修复的一个真实缺口

**问题**：`getChuhaijiangAbilityDescription()` 这个函数定义好了，但**从未被调用**。导致出海匠的 12 个工具虽然进了 LLM 的 tool 列表，但 system prompt 里没有任何关于"什么时候该用出海匠"的描述——对比 FastMoss 是配齐的（`getFastMossAbilityDescription()` 挂在路由器和 ReAct 循环里），出海匠是缺的。

**修复**：`server/llm.ts` 三处注入，和 FastMoss 对齐：

```ts
// ① 路由器（decideWithLlm）system prompt
systemPrompt: ROUTER_SYSTEM_PROMPT + skillAbility + fastmossAbility + chuhaijiangAbility + ...

// ② ReAct 多步循环 system prompt（两处）
systemPrompt: AGENT_SYSTEM_PROMPT + skillAbility + fastmossAbility + chuhaijiangAbility + ...
```

现在 LLM 能明确知道：出海匠提供 `search/get_detail/get_related/amazon/...` 12 个工具，用于 TikTok 日区选品。

---

## 三、全部 API 能力全景

### 3.1 六类外部数据源（真实 API）

| 数据源 | 状态 | 业务场景 | 触发词示例 |
|---|---|---|---|
| **TikTok Shop 官方** | ✅ | 店铺商品/订单/秒杀/库存/改价/上下架 | "店铺表现"、"库存"、"改价"、"秒杀" |
| **妙手 ERP** | ✅ | 1688 采集/认领/图片翻译/类目/上架 | "采集"、"上架到 TikTok" |
| **TMAPI 1688** | ✅ | 1688 货源详情/SKU/采购价/库存/重量 | "1688 货源"、"采购价" |
| **出海匠 MCP** | ✅ 本轮接入 | TikTok 日区选品/达人/视频/广告/直播/Amazon 交叉验证 | "日区爆品"、"达人"、"竞品分析" |
| **FastMoss MCP** | 待配置 | TikTok 数据分析（爆品/达人/店铺/直播） | "数据分析"、"选品" |
| **LLM (DeepSeek)** | ✅ | 意图路由、记忆抽取、ReAct 推理、内容生成 | （底层） |

### 3.2 未接通（配置缺失）

| 数据源 | 缺什么 |
|---|---|
| 飞书 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 为空 |
| KOL 达人桥 | `ws://127.0.0.1:8796` 未连 |
| 联网搜索 Tavily | `TAVILY_API_KEY` 为空 |
| Agnes 多模态 | `AGNES_API_KEY` 为空 |
| DuMate 搭子对话 | `DUMATE_ENABLED=false` |

---

## 四、工作流怎么串起来

### 4.1 核心链路（已跑通的 15 步）

```
TMAP 1688 取数 → 飞书算价(V/Y) → 妙手采集 → 占位参数 → 图片翻译
→ 认领(TikTok detailId) → 类目匹配 → 编辑载荷 → 保存 → 发布
→ 确认 PID → 改价到 Y → 建秒杀壳 → 挂商品 → 回查
```

### 4.2 出海匠加入后的完整商业闭环

```
[选品层]  出海匠 search(日区爆品) + TMAPI(1688货源)   ← 本轮接通
          ↓ 双源交叉：TikTok 需求 × 1688 供给
[定价层]  飞书总表算 V(定价) / Y(划线价)
          ↓
[上架层]  妙手采集→认领→翻译→类目→上架
          ↓
[运营层]  TikTok 官方改价 / 建秒杀
          ↓
[增长层]  出海匠 get_related(谁在推) / amazon(交叉验证) / social_analytics(社媒复盘)
```

**已有的 DAG 模板**已经把出海匠串进去了（`server/dag-templates.ts` 第 240 行起）：

```
start → [chuhaijiang_search ∥ tmapi_search]（并行双源搜索）
      → join → 有结果? → miaoshou_collect → miaoshou_claim
      → miaoshou_ai_match(类目+属性) → miaoshou_translate → 审批 → 发布
```

### 4.3 出海匠的典型业务场景

| 场景 | 用哪些工具 | 产出 |
|---|---|---|
| 日区选品 | `search(products)` → `get_detail` → `amazon` | 爆品 + 需求验证 + 价格锚定 |
| 竞品分析 | `get_related(products, id, competitors)` | 竞品清单 |
| 达人建联 | `search(creators)` → `get_related(products, id, creators)` | 谁在推这个品、带货效果 |
| 社媒复盘 | `social_analytics` | KPI / 爆款视频 / 爆款商品 |
| 自有店铺看板 | `social_seller` | 报告 / 类目 / 库存 / 订单 |

---

## 五、自然语言调用方式

### 5.1 路由机制

消息进入 `/api/chat` → `orchestrator` 依次尝试快速路径：

```
1. TMAPI 意图（"读取1688商品ID xxx"）
2. 秒杀意图（"给商品xxx创建秒杀"）
3. 上架意图（"把[1688链接]上架到TikTok"）
4. 妙手场景查询
5. TikTok 场景查询 / 写操作（改价/库存/上下架）
6. DuMate 搭子（若开启）
7. ReAct 多步推理（出海匠/FastMoss 工具在这里被调用）
```

### 5.2 出海匠的触发

出海匠工具走 **ReAct 多步推理**，由 DeepSeek 判断意图后自动调用 `chuhaijiang_*`。**只有"运营总监 Agent"能调**（`allowedTools: ["*"]`），其他 Agent 是白名单制，没列出出海匠。

**能直接触发的问法**（运营总监对话里）：

- "帮我找日区近 7 天最火的护肤爆品"
- "查一下这个 TikTok 商品有多少达人带货、效果怎么样"
- "这个品在 Amazon 上的长期需求和评论痛点是什么"
- "分析一下我店铺的社媒表现"

### 5.3 需注意的两个门槛

1. **秒杀必须写明确的绝对起止时间**（"2026-10-23 03:40 到 07:40"），写"现在+3分钟"解析不了。
2. **本地是 `DEMO_MODE=false` 真实模式**，对话框可直接触发；**云端线上仍是 `DEMO_MODE=true` 旧版**，出海匠这些能力线上未同步。

---

## 六、验证结果

| 检查 | 结果 |
|---|---|
| 出海匠 MCP 连接 | ✅ 21 工具 / 暴露 12 只读 |
| `account_info` 实调 | ✅ 余额 826.2 credits |
| `search(products/us/gloves)` 实调 | ✅ 10000 条真实数据 |
| `tsc -b` 类型检查 | ✅ 干净 |
| `vitest` 全量 | ✅ 29 文件 / 187 测试全过 |
| 能力描述注入 | ✅ 271 字符，12 工具名全列 |

## 七、遗留事项

1. **线上重新发布**：出海匠接入 + 秒杀层级 + TMAP 凭证层 + pipeline 修复，都还没同步到云端（云端仍是 DEMO_MODE 旧版）。
2. **`/api/health` 未报出海匠状态**：`connections` 对象里没有 `chuhaijiang` 字段（FastMoss 也没有），功能不受影响，但面板上"连接状态"看不到出海匠。如需展示，要改 `app.ts` 的 health 组装。
3. **密钥轮换**：本轮又在对话里明文出现了出海匠 key，连同之前的 TMAP/DeepSeek/GitHub/妙手，建议全部轮换。

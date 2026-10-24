# 跨境电商多Agent协同系统

一个面向 TikTok Shop 运营团队的对话式 Web 工作台。运营人员可以用自然语言查询经营数据、定位商品问题、生成报告，并通过审批卡安全地执行店铺写操作。

## 当前版本

当前版本面向本地单用户真实运营：

- 读取 TikTok Shop 店铺、订单、商品、库存、售后、财务、促销和经营分析数据
- 读取 TMAPI 1688 商品详情并支持以图搜索同款货源
- 通过妙手完成 1688 采集、TikTok 认领、商品编辑、发布和结果回查
- 选品结果按候选商品给出采购价、起订量、销量、重量和到岸成本（采购价 + 国内运费），不做跨站点利润预估
- 上架流程保存 1688、妙手、TikTok 的编号映射，售价在「保存售价和商品资料」步骤一次填清
- 数字员工中心统一提供运营总监、商品管理、选品、采集、上架和达人 BD Agent；专属会话统一归入“最近”，运营总监复用持久化任务中心协调跨 Agent 流程
- 项目当前只经营日本市场：站点、语言、币种、时区均以日本站为准（`server/tiktok-sites.ts` 是唯一站点来源）
- 支持库存、改价、上下架、秒杀和达人建联审批任务
- 只经营一个授权 TikTok Shop 店铺：设置页可完成授权与重新授权，页面和对话都使用这个店铺。旧的单店授权文件首次启动时自动迁移（原文件保留为 `.v1.bak` 备份）
- 查询自动执行；所有真实写入都必须通过审核卡确认
- 写入前校验最新值，写入后回查；网络中断时进入“等待核验”，不会自动重复提交
- 任务、审批、利润记录保存在本地 SQLite，每日首次启动自动备份

本项目只使用**真实平台数据**，没有演示模式。配置连接后页面只展示真实数据；接口失败会明确报错，不会静默回退到假数据。所有平台凭证只在服务端读取。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

打开 [http://localhost:5182](http://localhost:5182)。API 服务运行在 `http://localhost:8795`；直接打开 `8795` 也会自动跳转到网页。

> 端口可在 `.env` 中调整：`PORT`（API，默认 8795）、`KOL_BRIDGE_PORT`（达人建联 WebSocket，默认 8788，须与浏览器扩展 `bridge-page-relay.js` 里的 `BRIDGE_URL` 一致）、`npm run dev` 中 Vite 的前端端口固定为 5182。改完后用 `npm run kill` 清理旧进程。

构建与测试：

```bash
npm run typecheck
npm test
npm run build
```

## 接入 LLM

应用支持 OpenAI-compatible 的 Chat Completions + tool calling 接口：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-key
LLM_MODEL=your-model
```

LLM 只负责把自然语言路由为结构化工具调用。它不会直接拿到 TikTok Shop 凭证，也不能跳过服务端审批策略。模型调用失败时会回退到确定性规则路由。

## 接入 TikTok Shop

```dotenv
TIKTOK_SHOP_BASE_URL=https://open-api.tiktokglobalshop.com
TIKTOK_SHOP_APP_KEY=your-app-key
TIKTOK_SHOP_APP_SECRET=your-app-secret
TIKTOK_SHOP_SERVICE_ID=7660083559697663764
TIKTOK_SHOP_AUTH_URL=https://services.tiktokshop.com/open/authorize?service_id=7660083559697663764
```

在 TikTok Shop Partner Center 中，把重定向链接设置为：

```text
http://localhost:8795/api/tiktok/callback
```

然后打开应用的“设置 → 连接与权限”，点击“连接店铺”。授权完成后，后端会自动换取 access token、读取授权店铺并保存 `shop cipher`，不需要手工寻找这两个值。开发凭证保存在 `.env`，授权令牌保存在本地 `.data/tiktok-authorization.json`，这两个文件都不应提交到代码仓库。

当前真实数据使用以下官方接口：

- `GET /analytics/202509/shop/performance`：GMV、订单、退款金额与日趋势
- `POST /order/202309/orders/search`：订单和商品销量明细
- `POST /return_refund/202309/returns/search`：退货退款申请数量
- `POST /product/202502/products/search`：商品和 SKU
- `POST /product/202309/inventory/search`：可售库存

不要把重定向链接设置为临时收包网站或其他第三方域名，因为授权码会发送到这个地址。正式部署时，应把本地地址替换为你自己服务器上的 HTTPS 回调地址。

[`server/tiktok-client.ts`](./server/tiktok-client.ts) 已封装服务端签名、访问令牌头、查询参数和错误处理。TikTok Shop 的端点版本、地区权限和响应字段会随应用授权范围变化，因此生产接入时应在该 transport 上增加稳定的领域适配层：

- `OrdersService`：分页读取订单并归一化金额、状态与时间字段
- `CatalogService`：商品、SKU 与上下架状态
- `InventoryService`：读取最新库存、准备差异、提交后回读
- `AnalyticsService`：用确定性代码聚合 GMV、退款率和商品贡献

当前 UI 与编排器使用 canonical contracts，位于 [`shared/contracts.ts`](./shared/contracts.ts)。接入真实端点时无需改变前端消息和审批组件。

## 执行边界

- 只读工具可以自动执行；库存与价格修改必须人工确认。
- 审批绑定店铺、具体差异、计划哈希和 15 分钟有效期。
- 同一计划不能重复提交；执行中断后只回查结果，不会再次写入。
- 完成后生成 API 请求编号和执行回执。
- 本项目按本地单用户设计，暂不包含注册、登录、多租户和高并发架构。
- 高风险批量下架、取消订单和删除内容目前没有开放给 Agent。

## 版本迭代与 GitHub 管理

本项目已初始化独立 Git 仓库，支持语义化版本号 + 更新日志 + 一键打版。

### 🔼 三个一键打版命令（根据改动大小选一个）

```bash
cd new-instance/

# 小修小改 (0.1.0 → 0.1.1)：修复 bug、微调文案、优化性能
npm run version:patch

# 加新功能 (0.1.0 → 0.2.0)：新增 Agent、新工作流、新连接器、新页面
npm run version:minor

# 大版本变更 (0.1.0 → 1.0.0)：架构升级、不兼容改动、正式上线
npm run version:major
```

执行后会自动完成 4 件事：
1. 升级 `package.json` 里的 `version`
2. 在 `CHANGELOG.md` 顶部插入本次版本的更新摘要（自动从最近提交分类为「新增/修复/优化/文档」）
3. 生成一次 Git 提交：`release: vX.Y.Z`
4. 打一个 Git 标签：`vX.Y.Z`（用于 GitHub Releases）

最后手动执行一行，把新版本推到 GitHub：

```bash
git push origin main --tags
```

### ☁️ 首次上传到 GitHub（只需做一次）

**方式 A：网页版，不用装工具（推荐新手）**

1. 浏览器打开 <https://github.com/new>，登录你的 GitHub 账号
2. Repository name 填 `CyberFleet-TRAE`（或你喜欢的名字）
3. Private / Public 选 **Private**（不要公开密钥虽然已隔离，但不要公开代码）
4. 下面 4 个复选框**全部不勾选**（不要初始化 README / .gitignore / license）
5. 点击 **Create repository**
6. 创建后，复制页面中间显示的命令（类似下面的，以 `…or push an existing repository from the command line` 这一行下方为准），粘贴到终端运行：
   ```bash
   cd new-instance/
   git branch -M main
   git remote add origin https://github.com/你的Github用户名/CyberFleet-TRAE.git
   git push -u origin main --tags
   ```

**方式 B：GitHub CLI（更快，适合以后频繁用）**

```bash
# 1. 安装 gh（如果已经装过跳过）
brew install gh

# 2. 登录 GitHub（按提示选 HTTPS，用浏览器登录一次即可）
gh auth login

# 3. 一键创建仓库 + 推送
cd new-instance/
gh repo create CyberFleet-TRAE --private --source=. --push
```

上传成功后，打开 `https://github.com/你的Github用户名/CyberFleet-TRAE/tags` 就能看到 `v0.1.0` 这个版本标签，点进去可以直接下载对应版本的 zip。

### 📥 回滚到旧版本（万一改坏了）

```bash
# 看所有历史版本
git tag -l

# 回到 v0.1.0 的代码（先 commit / stash 好当前未提交的改动）
git checkout v0.1.0
```

### 🔐 安全提示

- `.env`（真实密钥）和 `.data/`（TikTok 授权令牌 + SQLite）**已配置不进 Git**，永远不会推到 GitHub
- 新同事拉取仓库后，本地执行 `cp .env.example .env` 填自己的密钥，再跑一次连接店铺即可
- 如果不小心把 `.env` 加到 Git，赶紧执行：`git rm --cached .env && echo ".env" >> .gitignore`，然后再提交修正

## 目录

```text
src/                 React 运营工作台
server/app.ts        HTTP API 与输入校验
server/orchestrator.ts  工具路由、审批计划和执行回执
server/workflow-store.ts SQLite 业务任务和执行历史
server/tiktok-sites.ts 站点、语言、币种映射的唯一定义
server/database-backup.ts 每日本地数据库备份
server/llm.ts        OpenAI-compatible 工具选择
server/tiktok-client.ts TikTok Shop transport 与签名
shared/contracts.ts  前后端共享契约
scripts/version-release.mjs  一键打版脚本(version:patch/minor/major)
tests/               API 集成测试
CHANGELOG.md         版本变更记录(自动生成)
```

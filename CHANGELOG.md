# Changelog


所有显著的版本变更都会记录在本文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-08-06

### 新增功能
- 定价引擎 CSV 批量导入:运营可一次性导入数百个 SKU 算价,无需逐个手动修改
  - 新增 `POST /api/pricing/import` 端点,接受 CSV 文本,返回算价结果
  - 支持中英文列名(SKU键/sku_key、售价THB/sale_price_thb 等),与导出 CSV 格式兼容
  - 必需列:SKU键、SKU名称、售价THB、采购价CNY、重量kg
  - 可选列:类目ID、活动价THB、国内物流CNY、云仓CNY、当地配送THB、广告THB、达人佣金率
  - 税率/佣金自动匹配:提供类目ID时用真实税率,未提供时用中位数兜底
  - 错误行不阻断:逐行收集错误,有效行正常算价返回
  - PricingFieldSource 新增 `csv` 来源标记
- 新增 `server/pricing-import.ts`:CSV 解析 + 记录构建 + 算价
- 新增 `tests/pricing-import.test.ts`:16 个用例覆盖解析/算价/错误处理/列名兼容

### 优化 / 调整
- 测试总数 152 → 168

## [0.4.1] - 2026-08-06

### 新增功能
- tiktok-client 签名算法单测:新增 tests/tiktok-client.test.ts,25 个用例覆盖签名算法(确定性/参数过滤/排序/变化检测)、配置校验(域名白名单/HTTPS 强制)、请求构造(GET/POST body/shop_cipher 注入)、错误处理(网络超时/业务错误/HTTP 非 200/非 JSON 响应)
- 签名算法提取:将 TikTokShopClient 的 private sign 方法提取为模块级 computeSign 函数,通过 __test 导出供测试验证

### 优化 / 调整
- 测试类型化:tests/server.test.js → .ts 迁移,补全 strict 模式下的类型标注(变量/回调参数/非空断言),新增 @types/supertest 依赖
- 测试总数 127 → 152

## [0.4.0] - 2026-08-06

### 新增功能
- orchestrator 核心路由测试:新增 tests/orchestrator.test.ts,32 个用例覆盖意图识别(inferExplicitDecision/inferDecision)、写操作识别(inferLiveProductWrite)、快速路径(inferFastReadDecision/inferFastConversationResponse)、文本提取(extractQuantity/extractPrice/extractSkus/extractDays)、工作流识别(workflowReference/asksAboutWorkflow),测试总数 95 → 127
- 测试导出:orchestrator.ts 末尾新增 __test 导出块,暴露 13 个路由纯函数供单元测试验证,不改变运行时行为

## [0.3.1] - 2026-08-06

### 问题修复
- 端口不一致:统一后端 API 默认端口为 8793(.env.example / server/index.ts / vite.config.ts 代理三者一致),修复代理指向不存在的端口导致前端请求失败
- 端口不一致:统一 KOL 浏览器桥默认端口为 8794(server/index.ts 日志 / kol-bridge.ts 实际监听 / KolWorkspace.tsx 前端显示 / .env.example 四者一致),修复日志输出与实际监听端口不符
- 端口不一致:更新 README.md 中的端口引用(5173→5180,8787→8793)
- tiktok-auth.ts 硬编码 URL:授权 URL / token URL / baseUrl 默认值提取为模块常量,支持环境变量覆盖(TIKTOK_SHOP_TOKEN_URL),消除两处重复硬编码

### 优化 / 调整
- 代码规范:提取外部 API 客户端超时魔法数字为命名常量(tiktok-client / feishu-client / miaoshou-client / tiktok-auth 的 REQUEST_TIMEOUT_MS / TOKEN_REQUEST_TIMEOUT_MS)

## [0.3.0] - 2026-08-06

### 优化 / 调整
- 代码整理:删除 demo/ 整个目录(独立演示模式启动器,日常开发不用)
- 代码整理:删除 run-copy.mjs(8795 端口合并启动脚本,未在 scripts 中注册)
- 代码整理:删除 src/types/officeAction.ts(4 个类型文件,从未被任何文件 import)
- 代码整理:删除 src/components/ContextPanel.tsx(孤立组件,从未被引用)
- 代码整理:删除 src/scene/systems/movementFacing.ts 的 isHorizontalWalk 函数(从未被调用)
- 代码整理:删除 tiktok-capabilities.ts 中 findTikTokOperation 死 export
- 代码整理:删除 miaoshou-client.ts 中 miaoshouAiMatting / miaoshouGetCommonCollectBoxDetail 两个死 export
- 代码整理:删除 skill-registry.ts 中 getSkillConfigRaw / getSkillScenes 两个死 export
- 性能优化:移除 server/miaoshou-scenes.ts 中 16 处 console.log 调试残留(减少 stdout 写入)
- 代码规范:移除 16 个多余的 export 关键字(类型/常量仅在文件内部使用,无需对外暴露)
- 代码整理:tests/miaoshou-full-chain.ts 冒烟脚本移至 scripts/miaoshou-smoke-test.ts(符合脚本目录约定)
- 代码整理:删除项目分析报告.md(历史遗留文档,分析的是另一个项目 shop-pilot 旧版本)
- 结构整理:移除 src/types/ 目录,类型统一内聚在 types/agent.ts 与相关模块内
- 代码规范:提取外部 API 客户端超时魔法数字为命名常量(tiktok-client / feishu-client / miaoshou-client / tiktok-auth 的 REQUEST_TIMEOUT_MS / TOKEN_REQUEST_TIMEOUT_MS)

## [0.1.0] - 2026-08-06

### 新增功能

- 项目独立副本(从 CyberFleet-TRAE 复制,全新端口组,与原项目互不干扰)
  - 前端端口: 5180 (原项目 4000)
  - 后端 API 端口: 8793 (原项目 8787)
  - KOL 浏览器桥端口: 8794 (原项目 8788)
  - 合并版端口: 8795
- React 19 + Vite 8 + Express 5 + TypeScript 严格模式
- 9 个数字员工 + 运营总监跨 Agent 协调
- TikTok Shop 泰国店授权 (Mikolo TH,22 项权限)
- 3 个持久化可恢复工作流: 商品上架 / 秒杀活动 / 达人 BD 邀约
- 定价引擎: 泰国叶子类目税率与佣金规则自动匹配,18 入参 17 项成本拆解,Excel/CSV 导出
- PixiJS 8 2.5D 办公室场景 + Spine 角色动画,9 个工位协作环
- SQLite 持久化: 工作流历史 + 审批计划 + 智能中心(知识库/提示词/网页搜索)
- 审批闭环: ActionPlan 防篡改 planHash、15 分钟有效、防重放、回读核验、等待核验态
- 外部连接器: TikTok Shop / 妙手 ERP / TMAPI 1688 / KOL 浏览器桥 / 飞书 lark-cli / Agnes / Tavily
- 智能中心: 8 类知识库, 提示词按 scope 优先级注入, LLM 需要时自动 Tavily 搜索
- Feishu 移动审批桥 + lark-cli 命令行
- 30+ vitest + supertest 测试用例(分模块)

### 问题修复

- 新项目与原项目端口完全错开,避免监听冲突
- 新项目独立 SQLite 与独立授权文件,数据完全隔离
- 启动时自动校验密钥存在性与连通性,给出明确连接状态提示

### 优化 / 调整

- 将新项目 new-instance 置于父项目工作目录内,解决 TRAE 安全沙盒子进程写临时文件权限问题
- 敏感文件全部加入 .gitignore(.env / .data/ / node_modules/ / dist / .idea / .vscode)
- 父项目 .gitignore 已忽略 new-instance/ 子目录,避免误提交到父仓库


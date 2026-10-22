# API 接入缺口核对

核对时间：2026-10-22。依据：当前项目代码、本地生效配置、已保存 TikTok 授权，以及用户提供的飞书《第三方Agent跨境电商实践与应用》。

源文档：https://pcnb163keq9w.feishu.cn/wiki/NVY6wraGTi39Slk6AcYcBIpMnLd

本次只读核对，不替换现有凭证、不发布商品、不发送通知。凭证存在不等于 API 实时可用；TikTok 状态来自本地授权和能力目录，未逐个调用远端验证。

## 1. 配置缺口

| 服务 | 本地配置 | 文档覆盖 | 结论 |
| --- | --- | --- | --- |
| TikTok Shop | 界面配置完整，已有卖家授权；当前站点 JP | 授权流程、业务端点、App Key / Secret | 文档中的两项凭证与本地一致，无需补填 |
| 妙手 ERP | 界面配置完整 | Apifox 文档入口、访问密码、应用凭证、采集到上架流程 | 文档中的两项应用凭证与本地一致，无需补填 |
| TMAPI 1688 | 环境配置已有 Token | 商品详情接口文档、API Token | 已取得资料；当前生效 Token 未在文档原文匹配到，保留现有值，候选凭证待验证 |
| 出海匠 | 环境配置已有 API Key | quick-start 文档、API Key | 已取得资料；当前生效 Key 未在文档原文匹配到，保留现有值，候选凭证待验证 |
| 飞书应用 | 环境配置已有 App ID / Secret；本次已成功读取知识库节点和文档正文 | CLI 安装与能力说明 | 应用凭证不缺；本次读取证明其对该文档具备访问权限 |
| 飞书主动通知 | 接收群 ID / 用户 ID 均为空 | 未提供可用接收目标 | 缺 FEISHU_NOTIFY_CHAT_ID 或 FEISHU_NOTIFY_USER_ID；这是通知目标配置，非新增 API |
| FastMoss MCP | 已有连接器，缺 API Key | 未提供 | 明确缺 FASTMOSS_API_KEY；端点已有默认值，不能从这篇文档补齐 |
| 大模型 | 已激活供应商，Key 和模型均存在 | 未提供 | 不缺必要配置，未测试模型调用 |
| Tavily 联网搜索 | 界面配置已有 Key | 未提供 | 不缺必要配置，未测试搜索调用 |
| Agnes 图片/视频生成 | 环境配置已有 Key | 未提供 | 不缺必要配置，未测试生成调用 |
| DuMate | 未启用，Key / Agent ID 为空 | 未提供 | 可选功能；若要启用，需 DUMATE_API_KEY、DUMATE_AGENT_ID 及 DUMATE_ENABLED=true |

配置来源判断按代码实际优先级：界面保存配置优先于 .env；大模型使用已激活供应商优先于 .env。报告不含凭证明文。

## 2. TikTok 权限与接口缺口

当前能力目录共 164 个接口，按本地保存授权与 JP 站点计算：

| 状态 | 数量 | 含义 |
| --- | ---: | --- |
| ready | 85 | 本地权限与站点检查通过的查询接口；未逐项验证远端可用性 |
| confirmation_required | 54 | 写操作按系统设计需要审批，并非缺 API |
| eligibility_check_required | 13 | 全球商品和图片翻译需进一步核对卖家、市场及跨境资格 |
| creator_authorization_required | 7 | 缺独立达人授权，卖家令牌无法替代；权限为 creator.data.live.read.public |
| region_unavailable | 5 | 目录标记的 SPS 202606 店铺诊断接口仅支持 US，当前 JP 站点不满足条件 |

目录另明确排除了以下能力：

- seller.customer_service：客服能力，代码标记为仍在审核中、未接入。
- seller.redeem_info.write：卖家核销信息回调，代码标记为仍在审核中、未接入。

上述审核状态来自代码说明，尚未访问 Partner Center 核实最新进度。飞书文档没有提供这两类接口的完整请求与响应资料，也没有达人令牌，因此无法仅凭该文档补齐。

接口目录中的条目存在，不代表业务编排已经为每条接口提供完整工作流。后续实施时还需核对路由、参数校验、审批和结果回查。

## 3. 从文档取得的接入资料

- TikTok：授权域名 https://auth.tiktok-shops.com/api/v2；业务域名 https://open-api.tiktokglobalshop.com；取授权店铺示例 GET /authorization/202309/shops；商品查询示例 POST /product/202309/products/search。
- 妙手 ERP：Apifox 文档入口及访问资料；公共采集箱 → TikTok 采集箱 → 站点底稿 → 店铺版本 → 发布 → 结果回查的流程说明。
- TMAPI：https://tmapi.top/zh-cn/docs/ali/item-detail/get-item-detail-by-id 及文档内 Token。
- 出海匠：https://openapi-doc.chuhaijiang.com/quick-start 及文档内 API Key。
- 飞书 CLI：https://www.feishu.cn/feishu-cli；文档另列有 CLI 安装资料。

文档中的示例并非最新 API 版本证明；例如项目商品搜索已使用 202502 版本，不能照文档的 202309 示例降级。签名、授权和错误处理也应以官方规范与验证结果为准，不能执行文档中建议的猜测式签名调整。

文档列出的 HTML 能力手册、商品主数据表和知识库条目，本次正文未提供其完整内容；本报告没有假定已阅读这些附件或建立飞书数据表连接。

## 4. 建议实施顺序

1. 若需要 FastMoss，补充其 API Key；该文档没有此值。项目也已接入出海匠，可先使用现有选品数据源。
2. 若需要日报和审批主动推送，确定目标群/用户后补飞书接收 ID；不自动选择或发送到任何会话。
3. 对 TMAPI、出海匠先做当前配置的只读连通测试；失败后再测试文档中的候选凭证，成功后才考虑切换。
4. 若需要达人直播深度分析，另建达人授权和令牌管理；若需要客服/核销，先核实应用审核与权限，再补领域接口和工作流。
5. 对全球商品/图片翻译校验卖家资格；JP 不适用的 US 专属接口不作为缺失密钥处理。

## 5. 证据位置

- server/runtime-config.ts：各连接器生效配置与回退规则。
- server/skill-registry.ts：连接器字段和能力清单。
- server/skill-connectors.ts：现有连接测试入口；部分测试消耗套餐额度，本次未执行。
- server/tiktok-capabilities.ts：权限、地区与达人授权限制。
- server/tiktok-operation-catalog.ts：164 个接口目录。
- server/llm-providers.ts：大模型配置优先级。
- server/feishu-client.ts：飞书应用鉴权与主动通知目标解析。

源文档正文已保存在被 Git 忽略的 .data/api-source-document.txt，权限为仅当前用户可读写；其中含凭证，不能提交到仓库。公开报告仅记录状态与文档入口。

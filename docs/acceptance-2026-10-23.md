# 全链路验收记录 · 2026-10-23

一句话结论：**15 步全链路一次跑通，商品已上架（ACTIVATE / APPROVED），秒杀活动已挂商品并等待开始。**

## 一、输入

| 项 | 值 |
|---|---|
| 1688 商品 | `https://detail.1688.com/offer/1071287326904.html`（可爱小熊猫毛绒针织五指手套） |
| 飞书定价总表 | `https://acni2t3spk0q.feishu.cn/wiki/IJXbwLyNUiJjFjk2z8Fccyn9nDe`（写入「总表」第 12 行） |
| TMAP 凭证 | 已写入 `Cyberfleet/.env` 的 `TMAPI_API_TOKEN` 与技能页 `.data/skills.json` |
| 店铺 | 日本站，仓库 `7517970149146117906`（中国直发仓） |

## 二、结果

| 项 | 值 |
|---|---|
| TikTok PID | `1738147492999431232` |
| 商品状态 | `ACTIVATE`，审核 `APPROVED` |
| SKU 数 | 2（ブラック / ホワイト，均 フリーサイズ） |
| 划线价（Y） | 3,202 JPY |
| 秒杀价（V） | 1,281 JPY |
| 活动 ID | `7699574247228098324` |
| 活动层级 | `PRODUCT`（整品一个价） |
| 活动时间 | 2026-10-23 03:27:24 → 07:27:24（begin = 建活动时刻 + 180s） |
| 活动商品 | `total_count=1`，`activity_price=1281 JPY`，库存 / 限购 = `-1`（不限） |
| 类目 | `906120`｜时尚配饰 > 服饰配件 > 手套｜ファッション手袋 |
| 包裹 | 25×18×3 cm / 0.05 kg |
| 商品标题 | レディース パンダ柄 もこもこニット手袋 スマホ対応 2本指出し 防寒保温 自転車・通学用 |

## 三、逐步记录

| # | 步骤 | 结果 |
|---|---|---|
| 1 | TMAP 取数 | item 1071287326904；采购价 5.80 CNY；实重 0.05 kg；国内运费 2.6 CNY；近 90 天售出 630 件 |
| 2 | 尺寸补全 | TMAP `skus[].package_info = null`、24 条属性里无尺寸 → 按手套常规包装取 25×18×3，并在结果 `assumptions` 标明 |
| 3 | 飞书算价 | 计费重 J = 25×18×3/8000 = 0.16875 kg（体积重大于实重，L 取 J）→ **V=1,281 / Y=3,202**，写入总表第 12 行 |
| 4 | 妙手采集 | 公共采集箱 `detailId 4085545190` |
| 5 | 占位参数 | SPU/SKU 9999/9999/1.0/1×1×1（发布必填，上架后由官方 API 改真实值） |
| 6 | 图片翻译 | 13/13 返回原 URL —— 人工下载核验，主图 7 + 详情图 6 全为纯产品图，无中文，服务行为正确 |
| 7 | 认领 | TikTok 侧 detailId `3474826715`（从 `platformCollectBoxDetailIdMap` 取） |
| 8 | 类目 | 手套类目树命中 10 个，锁定 `906120` |
| 9 | 编辑载荷 | 标题 46 字符、6 个属性、SKU 日译、7 张详情图、weight 0.05、pkg 25×18×3、warehouse 7517970149146117906 |
| 10 | 保存 | 成功，新 ossMd5 `qMN1iOniBDw+GHeGCC63FA==` |
| 11 | 发布 | 已提交（妙手侧异步队列） |
| 12 | 确认 PID | **`1738147492999431232`**｜ACTIVATE｜APPROVED｜2 SKU |
| 13 | 改价 | 2 个 SKU → **3,202 JPY**，回查 `sale_price: "3202"` 生效 |
| 14 | 建秒杀壳 | **`7699574247228098324`**｜PRODUCT｜NOT_START｜begin 03:27:24 / end 07:27:24 |
| 15 | 挂商品 | `code=0, total_count=1`；回查 `activity_price: {"amount":"1281","currency":"JPY"}` |

商品属性（cid 906120）：

```
[100701] 梱包材/材质      mandatory  → 1000007  プラスチック
[101095] 製織方法/织造方法 mandatory → 1005845  編み物
[100336] 原産国/原产地    mandatory  → 1000850  中国
[100445] ジェンダー/性别              → 1001450  女性
[100401] 洗浄方法/洗涤说明            → 1001195  手洗いのみ
[100438] 手袋の種類/手套类型          → 1001391  コンバーチブル手袋
```

## 四、本轮跑出来的缺陷与修复

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `tmap_pricing.py` 报错文案让传 `--size`，但参数根本没注册 | 补 `--size` / `--weight` 参数，解析后写入结果并在 `assumptions` 标注「手工给定」 |
| 2 | 计费重用了 `max(J, 1.5K)`，与飞书 L 列 `IF(J>1.5*K, J, K)` 不一致，轻抛货会多算运费 | 改为 `l = j if j > 1.5*k else k` |
| 3 | TMAP 已返回 `delivery_info.delivery_fee = 2.6`，脚本不读，国内运费算 0 | 按飞书口径记入 P 列（本轮手工传 `--domestic 2.6`，待脚本自动读取） |
| 4 | `pipeline.py` 认领把**公共箱 ID**当 TikTok 侧 ID 写进 state，后续类目/编辑/发布全报「商品已被删除」 | 改为从响应 `platformCollectBoxDetailIdMap` 取值，取不到直接抛错 |
| 5 | `pipeline.py` 建编辑载荷不覆盖重量/尺寸，1 kg / 1×1×1 占位值会带上架 | 新增 `weight` / `pkg` 参数，同时覆盖 SPU 与每个 SKU 的 weight |
| 6 | `flash-sale-workflow.ts` 建活动只支持逐 SKU 下发，整品级必失败 | 新增 `pricingLevel: PRODUCT \| VARIATION` 双层级，`activityProductBody()` 按层级产 body，互斥校验 |
| 7 | `grantedScopes` 只回报 `seller.authorization.info` 一个值，`context()` 按它硬拦会误杀 | 删掉硬拦，改为审批前提示性警告；权限够不够交给平台判定 |
| 8 | `skuSalePrice` 把 `tax_exclusive_price`（547）当售价，与 `sale_price`（6373）差一个数量级，价格提示误报 | 优先 `sale_price`，完全没返回时才退到含税价 |
| 9 | 套件文档写「第 13 步改价到 V」，与已验证实例（在售价 3540 / 活动价 1416）矛盾 | 全套件口径改为「在售价 = 划线价 Y，秒杀价 = 定价 V」，`pitfalls.md` 新增第 14 条 |

## 五、验证

- `npx tsc -b --force` 干净
- `npx vitest run`：28 文件 / 183 用例全过（秒杀层级新增 6 个）
- `npm run build` 成功
- `suite_doctor.py`：全部通过，可开工

## 六、待确认 / 遗留风险

1. **尺寸 25×18×3 cm 是估算值**。TMAP 与妙手都没有该商品的包装数据，体积重 0.16875 kg 直接决定物流档位，进而决定 V=1,281。若实际外箱更大，V 会上浮。
2. **秒杀活动库存与限购设为 `-1`（不限）**。用户规则只规定了「开始时间 = 建立时刻 + 3 分钟、秒杀价 = 定价 V」，未规定库存与限购，采用「不限」保底。
3. **`seller.promotion.write` 权限**：活动创建成功说明实际可用，但 `grantedScopes` 字段不可信，建议到 Partner Center 核对 scope 配置。
4. **线上仍是 `DEMO_MODE=true` 旧版本**，本轮全部改动未同步到云端。
5. **密钥轮换**：TMAP key、DeepSeek key、GitHub token、妙手 secret 均在对话中出现过，建议全部轮换。

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doubao-tmap-1688-pricing — TMAP 1688 商品详情抓取 + 跨境电商定价计算 + 飞书表格写入载荷生成

工作流（一条命令完成"抓取 -> 解析主推SKU -> 成本/定价计算 -> 生成表格写入载荷"）：
  python3 tmap_pricing.py run --url "https://detail.1688.com/offer/XXX.html" \
      --row 12 [--target-margin 0.22] [--main-sku min] [--goods-type 普货] [--sheet-name 总表] \
      [--output writes_row12.json]

  python3 tmap_pricing.py fetch --url "https://detail.1688.com/offer/XXX.html"   # 仅抓取+计算，不生成载荷
  python3 tmap_pricing.py payload --row 12 --data <fetched.json> --output writes_row12.json  # 由已抓取结果生成载荷

写入飞书表格用 lark-cli（见 SKILL.md 工作流），身份一律 --as bot（bot 含 write_only 权限；user token 已过期）：
  lark-cli sheets +csv-get --as bot   确认目标行为空
  lark-cli sheets +range-copy --as bot --paste-type formats   从上一行复制样式
  lark-cli sheets +cells-set --as bot --writes - < writes_row12.json
  lark-cli sheets +csv-get / +formula-verify --as bot   回读验证

凭证：~/.tmap_credentials.json（{"api_key": "ak_live_..."}）或环境变量 TMAP_API_KEY。
base = http://api.tmapi.top，认证 head: apikey。

定价口径（与飞书「【最终】商品基础信息」总表公式一致）：
  J体积重 = G*H*I/8000 ; L计费重 = MAX(J, 1.5*K)
  Q国际物流(JPY) = 价卡档位费 + 计费重*每kg费（普货/特货）
  R = Q*汇率 ; T成本(CNY) = N采购 + P国内物流 + O云仓耗材 + R
  V定价(JPY) = T / (汇率 * (1 - 佣金率 - 目标毛利率))   ← 反推
  Y划线价 = round(V * 2.5)
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

DEFAULT_BASE_URL = "http://api.tmapi.top"


def base_url() -> str:
    """TMAP 网关地址：环境变量 > 项目 .env > 技能页配置 > 默认值（HTTP，非 HTTPS）。"""
    url = os.environ.get("TMAP_BASE_URL") or os.environ.get("TMAPI_BASE_URL")
    if not url:
        env = read_env_file(os.path.join(project_home(), ".env"))
        url = env.get("TMAP_BASE_URL") or env.get("TMAPI_BASE_URL") or ""
    if not url:
        url = (read_skill_config("tmapi-1688").get("baseUrl") or "").strip()
    return (url or DEFAULT_BASE_URL).rstrip("/")
# 飞书「直邮物流价卡」子表口径（上限kg, 每件费JPY, 每kg费JPY）
PRICE_CARD = {
    "普货": ([(0.5, 545, 340), (1, 560, 340), (2, 590, 340), (5, 590, 405),
              (10, 590, 415), (20, 590, 425), (30, 590, 435)]),
    "特货": ([(0.5, 555, 400), (1, 580, 420), (2, 610, 420), (5, 610, 510),
              (10, 610, 525), (20, 610, 535), (30, 610, 545)]),
}
DEFAULTS = {
    "rate_jpy2cny": 0.0423,     # 日元汇率 A2（JPY -> CNY）
    "commission": 0.09,         # 平台佣金费率 D 列
    "cloud_fee": 3.5,           # 云仓耗材 O 列（CNY）
    "domestic": 0.0,            # 国内物流 P 列（CNY）
    "affiliate": 0.10,          # 达人佣金率 AL 列
    "marketing": 0.035,         # 智能营销费率 AR 列
    "target_margin": 0.22,      # 目标毛利率（定价反推基准）
}


# ---------------------------------------------------------------------------
# 凭证
# ---------------------------------------------------------------------------

# Cyberfleet 项目目录：项目 .env 里已有 TMAPI 配置时优先复用，
# 免得同一个 key 在两处各存一份、改了一边另一边还是旧的。
# 本脚本已复制进 Cyberfleet/scripts/，默认定位到脚本自身所在项目的上一级目录，
# 再用 CYBERFLEET_HOME 覆盖；硬编码路径仅作兜底（迁移到别的机器也能自定位）。
def _default_project_home() -> str:
    # scripts/tmap_pricing.py 的父目录的父目录 = 项目根
    return str(Path(__file__).resolve().parent.parent)


DEFAULT_PROJECT_HOME = _default_project_home()


def project_home() -> str:
    return os.environ.get("CYBERFLEET_HOME", DEFAULT_PROJECT_HOME)


def read_env_file(path: str) -> dict:
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def read_skill_config(skill_id: str) -> dict:
    """Cyberfleet 技能页把凭证存在 .data/skills.json，和 App 读同一份，免得分叉。"""
    path = Path(project_home()) / ".data" / "skills.json"
    if not path.exists():
        return {}
    try:
        store = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    entry = store.get(skill_id) or {}
    return entry.get("config") or {}


def load_api_key() -> str:
    key = os.environ.get("TMAP_API_KEY", "")
    if not key:
        # 项目内优先：TMAP_API_KEY（本套件口径）与 TMAPI_API_TOKEN（Cyberfleet 口径）都认
        env = read_env_file(os.path.join(project_home(), ".env"))
        key = env.get("TMAP_API_KEY") or env.get("TMAPI_API_TOKEN") or ""
    if not key:
        key = (read_skill_config("tmapi-1688").get("apiToken") or "").strip()
    if not key:
        for p in (Path.home() / ".tmap_credentials.json",
                  Path(__file__).resolve().parent.parent / "resources" / "config.json"):
            if p.exists():
                try:
                    key = json.loads(p.read_text(encoding="utf-8")).get("api_key", "")
                except Exception:
                    pass
                if key:
                    break
    if not key:
        raise SystemExit(
            "ERROR: 未配置 TMAP api_key。四选一：\n"
            f"  1) 在 {project_home()}/.env 里填 TMAPI_API_TOKEN=ak_live_...\n"
            "  2) 在 Cyberfleet 技能页给「TMAPI 1688」填 API Token（存 .data/skills.json）\n"
            "  3) export TMAP_API_KEY=ak_live_...\n"
            '  4) 写入 ~/.tmap_credentials.json = {"api_key": "ak_live_..."}（chmod 600）'
        )
    return key


# ---------------------------------------------------------------------------
# TMAP 抓取
# ---------------------------------------------------------------------------

def extract_item_id(url: str) -> str:
    m = re.search(r"offer/(\d+)", url)
    if m:
        return m.group(1)
    if url.isdigit():
        return url
    raise SystemExit(f"ERROR: 无法从 URL 提取 item_id: {url}")


def fetch_detail(item_id: str, optimize_title: bool = True) -> dict:
    url = (f"{base_url()}/1688/item_detail?item_id={item_id}&language=zh"
           f"&optimize_title={'true' if optimize_title else 'false'}&scene=drop_shipping")
    req = urllib.request.Request(url, headers={"apikey": load_api_key()})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    if raw.get("code") != 200 or not raw.get("data"):
        raise RuntimeError(f"TMAP 抓取失败: code={raw.get('code')} msg={raw.get('msg')}")
    return raw["data"]


def parse_props(data: dict) -> dict:
    """product_props 为 dict 数组（键=属性名），摊平成 {属性名: 值}。"""
    out = {}
    for p in (data.get("product_props") or []):
        for k, v in p.items():
            out[k] = v
    return out


def parse_size_from_props(props: dict) -> tuple:
    """从颜色/规格属性里提取第一个 W*H*D cm 尺寸，如 'M：48*40*29cm' -> (48,40,29)。"""
    for key in ("颜色", "规格", "尺寸"):
        val = str(props.get(key, ""))
        m = re.search(r"(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)", val)
        if m:
            return (float(m.group(1)), float(m.group(2)), float(m.group(3)))
    return (None, None, None)


def pick_main_sku(data: dict, rule: str, props: dict) -> dict:
    """从 SKU 列表选主推款。rule: min=最低价款(默认) | max=最高价款 | 包含子串（如 '大号'）。"""
    skus = data.get("skus") or []
    if not skus:
        raise RuntimeError("该商品无 SKU 明细，无法定价")
    if rule and rule not in ("min", "max"):
        cands = [s for s in skus if rule in str(s.get("props_names", ""))]
        if not cands:
            raise SystemExit(f"ERROR: 未找到包含 '{rule}' 的 SKU")
        skus = cands
    skus = sorted(skus, key=lambda s: float(s.get("sale_price", 0)))
    main = skus[0] if rule != "max" else skus[-1]
    return main


# ---------------------------------------------------------------------------
# 定价计算
# ---------------------------------------------------------------------------

def logistics_cost(weight_kg: float, goods_type: str) -> float:
    """价卡：档位费 + 计费重*每kg费（JPY）。超 30kg 视为超限。"""
    tiers = PRICE_CARD.get(goods_type)
    if not tiers:
        raise SystemExit(f"ERROR: 未知货物类型 {goods_type}，可选 普货/特货")
    for cap, base, per_kg in tiers:
        if weight_kg <= cap:
            return base + weight_kg * per_kg
    return -1  # 超限


def compute(data: dict, opts: dict) -> dict:
    """返回 {商品摘要, 主推SKU, 计算链, 写入值}。"""
    props = parse_props(data)
    main = pick_main_sku(data, opts["main_sku"], props)
    pinfo = main.get("package_info") or {}
    assumed = []

    # 尺寸：SKU package_info 优先，其次颜色/规格属性，最后手工 --size
    g, h, i = (pinfo.get("length"), pinfo.get("width"), pinfo.get("height"))
    if not all((g, h, i)):
        g, h, i = parse_size_from_props(props)
    if not all((g, h, i)) and opts.get("size"):
        parts = re.split(r"[*xX×\s]+", str(opts["size"]).strip())
        if len(parts) == 3:
            try:
                g, h, i = (float(p) for p in parts)
            except ValueError:
                g = h = i = None
            else:
                assumed.append("尺寸由 --size 手工给定")
    if not all((g, h, i)):
        raise SystemExit("ERROR: 无法获取尺寸（SKU 与属性均无），请手动提供 --size '长*宽*高'")

    n = float(main.get("sale_price", data.get("price_info", {}).get("price", 0)))
    k = float(pinfo.get("weight") or 0) or float((data.get("delivery_info") or {}).get("unit_weight") or 0)
    if not k and opts.get("weight"):
        k = float(opts["weight"])
        assumed.append("实重由 --weight 手工给定")
    if not k:
        raise SystemExit("ERROR: 无法获取重量（SKU 无 package_info.weight），请手动提供 --weight")
    rate = float(opts["rate"]); comm = float(opts["commission"]); margin = float(opts["target_margin"])
    cloud = float(opts["cloud_fee"]); domestic = float(opts["domestic"])

    j = g * h * i / 8000
    # 与飞书总表 L 列口径保持一致：IF(J > 1.5K, J, K)。
    # 不能写成 max(J, 1.5K) —— 轻抛货在 J 落在 (K, 1.5K) 区间时，表里取 K，max 会多算。
    l = j if j > 1.5 * k else k
    q = logistics_cost(l, opts["goods_type"])
    r = q * rate
    t = n + domestic + cloud + r
    v = round(t / (rate * (1 - comm - margin)))
    y = round(v * 2.5)

    price_info = data.get("price_info") or {}
    result = {
        "item_id": data.get("item_id"),
        "title": data.get("title"),
        "category_id": data.get("category_id"),
        "props": props,
        "price_range": [price_info.get("price_min"), price_info.get("price_max")],
        "stock": data.get("stock"),
        "shop": (data.get("shop_info") or {}).get("shop_name"),
        "location": (data.get("delivery_info") or {}).get("location"),
        "skus_total": len(data.get("skus") or []),
        "main_sku": {
            "props_names": main.get("props_names"),
            "sale_price": n,
            "stock": main.get("stock"),
            "weight": k,
            "size": [g, h, i],
        },
        "calc": {
            "N": round(n, 2), "K": k, "G": g, "H": h, "I": i,
            "J": round(j, 3), "L": round(l, 3),
            "Q": q if q > 0 else "超限", "R": round(r, 2), "T": round(t, 2),
            "V": v, "Y": y,
            "rate": rate, "commission": comm, "target_margin": margin,
            "cloud_fee": cloud, "domestic": domestic,
        },
        # 哪些数字是人工给的、不是货源返回的：写表时要一起告知使用者
        "assumptions": assumed,
        "writes_values": {
            "B": str(data.get("item_id")), "C": opts["category"],
            "D": comm, "E": opts["goods_type"], "F": f"{int(g)}*{int(h)}*{int(i)}",
            "G": g, "H": h, "I": i, "K": k, "N": n, "O": cloud, "P": domestic,
            "V": v, "Y": y, "AL": opts["affiliate"], "AR": opts["marketing"],
            "AD": 0, "AF": 0, "AG": 0, "AH": 0, "AT": 0, "AU": 0,
        },
    }
    return result


# ---------------------------------------------------------------------------
# 生成飞书写入载荷（43 项：值 + 公式，行号 = --row）
# ---------------------------------------------------------------------------

def build_payload(res: dict, row: int, sheet_name: str) -> list:
    w = res["writes_values"]
    items = []

    def wc(cell, value=None, formula=None, fmt=None):
        obj = {}
        if formula:
            obj["formula"] = formula
        if value is not None:
            obj["value"] = value
        if fmt:
            obj["cell_styles"] = {"number_format": fmt}
        items.append({"sheet_name": sheet_name, "range": cell, "cells": [[obj]]})

    wc(f"B{row}", w["B"], fmt="@")
    wc(f"C{row}", w["C"])
    wc(f"D{row}", w["D"], fmt="0%")
    wc(f"E{row}", w["E"])
    wc(f"F{row}", w["F"])
    wc(f"G{row}", w["G"]); wc(f"H{row}", w["H"]); wc(f"I{row}", w["I"])
    wc(f"K{row}", w["K"])
    wc(f"N{row}", w["N"])
    wc(f"O{row}", w["O"]); wc(f"P{row}", w["P"])
    wc(f"V{row}", w["V"], fmt="#,##0"); wc(f"Y{row}", w["Y"], fmt="#,##0")
    wc(f"AD{row}", 0); wc(f"AF{row}", 0); wc(f"AG{row}", 0); wc(f"AH{row}", 0)
    wc(f"AL{row}", w["AL"], fmt="0%"); wc(f"AR{row}", w["AR"], fmt="0.00%")
    wc(f"AT{row}", 0); wc(f"AU{row}", 0)

    formulas = {
        "J": f"=G{row}*H{row}*I{row}/8000",
        "L": f"=IF(J{row}>1.5*K{row},J{row},K{row})",
        "Q": (f'=IFERROR(IF(E{row}="特货",XLOOKUP(L{row},\'直邮物流价卡\'!$C$11:$C$17,\'直邮物流价卡\'!$D$11:$D$17,"",1,1)'
              f'+L{row}*XLOOKUP(L{row},\'直邮物流价卡\'!$C$11:$C$17,\'直邮物流价卡\'!$E$11:$E$17,"",1,1),'
              f'XLOOKUP(L{row},\'直邮物流价卡\'!$C$4:$C$10,\'直邮物流价卡\'!$D$4:$D$10,"",1,1)'
              f'+L{row}*XLOOKUP(L{row},\'直邮物流价卡\'!$C$4:$C$10,\'直邮物流价卡\'!$E$4:$E$10,"",1,1)),"超限")'),
        "R": f"=Q{row}*'日元汇率'!A2",
        "T": f"=N{row}+P{row}+O{row}+R{row}",
        "W": f"=V{row}*'日元汇率'!A2",
        "Z": f"=1-(V{row}/Y{row})",
        "AB": f"=V{row}-AD{row}-AF{row}",
        "AE": f"=AD{row}*'日元汇率'!A2",
        "AI": f"=D{row}*((AB{row}+AF{row})-(AG{row}-AH{row}))",
        "AJ": f"=AI{row}*'日元汇率'!A2",
        "AM": f"=V{row}*AL{row}",
        "AN": f"=AM{row}*'日元汇率'!A2",
        "AP": f"=AR{row}*(AB{row}+AF{row})",
        "AQ": f"=AP{row}*'日元汇率'!A2",
        "AW": f"=W{row}-AE{row}-T{row}-AJ{row}",
        "AX": f"=AW{row}/'日元汇率'!A2",
        "AY": f"=AW{row}/W{row}",
        "BA": f"=AW{row}-AN{row}-AQ{row}-AT{row}",
        "BB": f"=BA{row}/'日元汇率'!A2",
        "BC": f"=BA{row}/W{row}",
    }
    for col, f in formulas.items():
        items.append({"sheet_name": sheet_name, "range": f"{col}{row}", "cells": [[{"formula": f}]]})
    return items


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="TMAP 1688 抓取 + 跨境定价 + 飞书载荷生成")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_fetch = sub.add_parser("fetch", help="抓取+计算，输出 JSON")
    p_fetch.add_argument("--url", required=True)
    p_fetch.add_argument("--main-sku", default="min", help="min|max|包含子串")
    p_fetch.add_argument("--goods-type", default="普货", choices=["普货", "特货"])
    p_fetch.add_argument("--target-margin", type=float, default=DEFAULTS["target_margin"])
    p_fetch.add_argument("--rate", type=float, default=DEFAULTS["rate_jpy2cny"])
    p_fetch.add_argument("--commission", type=float, default=DEFAULTS["commission"])
    p_fetch.add_argument("--cloud-fee", type=float, default=DEFAULTS["cloud_fee"])
    p_fetch.add_argument("--domestic", type=float, default=DEFAULTS["domestic"])
    p_fetch.add_argument("--affiliate", type=float, default=DEFAULTS["affiliate"])
    p_fetch.add_argument("--marketing", type=float, default=DEFAULTS["marketing"])
    p_fetch.add_argument("--category", default="", help="写入表格 C 列类目名")
    p_fetch.add_argument("--size", default="", help="手工指定外箱尺寸 '长*宽*高' cm（TMAP 无包装信息时必填）")
    p_fetch.add_argument("--weight", type=float, default=0.0, help="手工指定实重 kg")
    p_fetch.add_argument("--optimize-title", action="store_true", default=True)
    p_fetch.add_argument("--output", default="", help="保存抓取结果 JSON 路径")

    p_run = sub.add_parser("run", help="抓取+计算+生成飞书写入载荷（推荐）")
    p_run.add_argument("--url", required=True)
    p_run.add_argument("--row", type=int, required=True, help="飞书总表目标行号（先确认该行空白）")
    p_run.add_argument("--sheet-name", default="总表")
    p_run.add_argument("--output", default="", help="载荷 JSON 输出路径（默认 tmap_writes_row<N>.json）")
    # run 复用 fetch 的全部参数（手动补齐）
    for name, kw in [("--main-sku", dict(default="min")), ("--goods-type", dict(default="普货", choices=["普货", "特货"])),
                     ("--target-margin", dict(type=float, default=DEFAULTS["target_margin"])),
                     ("--rate", dict(type=float, default=DEFAULTS["rate_jpy2cny"])),
                     ("--commission", dict(type=float, default=DEFAULTS["commission"])),
                     ("--cloud-fee", dict(type=float, default=DEFAULTS["cloud_fee"])),
                     ("--domestic", dict(type=float, default=DEFAULTS["domestic"])),
                     ("--affiliate", dict(type=float, default=DEFAULTS["affiliate"])),
                     ("--marketing", dict(type=float, default=DEFAULTS["marketing"])),
                     ("--category", dict(default="")),
                     ("--size", dict(default="")), ("--weight", dict(type=float, default=0.0)),
                     ("--optimize-title", dict(action="store_true", default=True))]:
        p_run.add_argument(name, **kw)

    p_payload = sub.add_parser("payload", help="由已抓取结果生成载荷")
    p_payload.add_argument("--data", required=True, help="fetch 输出的 JSON 路径")
    p_payload.add_argument("--row", type=int, required=True)
    p_payload.add_argument("--sheet-name", default="总表")
    p_payload.add_argument("--output", default="")

    args = ap.parse_args()

    def opts_from(a) -> dict:
        """fetch 与 run 共用同一套算价参数，避免两处各抄一遍漏字段。"""
        return {
            "main_sku": a.main_sku, "goods_type": a.goods_type, "target_margin": a.target_margin,
            "rate": a.rate, "commission": a.commission, "cloud_fee": a.cloud_fee,
            "domestic": a.domestic, "affiliate": a.affiliate, "marketing": a.marketing,
            "category": a.category, "size": a.size, "weight": a.weight,
        }

    if args.cmd == "fetch":
        res = compute(fetch_detail(extract_item_id(args.url), args.optimize_title), opts_from(args))
        print(json.dumps(res, ensure_ascii=False, indent=1))
        if args.output:
            Path(args.output).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        return 0

    if args.cmd == "run":
        res = compute(fetch_detail(extract_item_id(args.url), args.optimize_title), opts_from(args))
        payload = build_payload(res, args.row, args.sheet_name)
        out = args.output or f"tmap_writes_row{args.row}.json"
        Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(res, ensure_ascii=False, indent=1))
        print(f"\n载荷已生成: {out} ({len(payload)} 项)。下一步: lark-cli sheets +cells-set --as bot --writes - < {out}")
        return 0

    if args.cmd == "payload":
        res = json.loads(Path(args.data).read_text(encoding="utf-8"))
        payload = build_payload(res, args.row, args.sheet_name)
        out = args.output or f"tmap_writes_row{args.row}.json"
        Path(out).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"载荷已生成: {out} ({len(payload)} 项)")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

from __future__ import annotations

import json
import re

from db import connect


PROVINCES = [
    "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建",
    "江西", "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏",
    "陕西", "甘肃", "青海", "宁夏", "新疆",
]

REGION_ALIASES = {
    "鲁": "山东",
    "豫": "河南",
    "黔": "贵州",
    "粤": "广东",
    "苏": "江苏",
    "浙": "浙江",
    "沪": "上海",
    "京": "北京",
    "津": "天津",
    "川": "四川",
    "蜀": "四川",
    "渝": "重庆",
    "皖": "安徽",
    "闽": "福建",
    "赣": "江西",
    "冀": "河北",
    "晋": "山西",
    "辽": "辽宁",
    "吉": "吉林",
    "陕": "陕西",
    "秦": "陕西",
    "甘": "甘肃",
    "陇": "甘肃",
    "青": "青海",
    "宁": "宁夏",
    "新": "新疆",
    "桂": "广西",
    "琼": "海南",
}

INDUSTRY_RULES = [
    ("城投", r"城投|城市建设|城市开发|交通投资|轨道交通|基础设施|水务|国资|建投|产投|文旅"),
    ("煤炭", r"煤|矿业|焦煤|焦化|能源股份|大有能源|盘江|陕西煤业"),
    ("钢铁", r"钢|钢铁|特钢|铁合金"),
    ("有色金属", r"锂|铜|铝|铅|锌|镍|钴|钨|钼|稀土|有色|矿产|中矿"),
    ("电力设备", r"光伏|风电|电池|储能|新能源|电力设备|太阳能|组件"),
    ("公用事业", r"电力|热电|燃气|供水|环保能源|发电|水电"),
    ("环保", r"环保|环能|固废|污水|再生资源|节能"),
    ("交通运输", r"港口|航运|海运|物流|机场|铁路|高速|公路|船舶|海通发展"),
    ("房地产", r"地产|房地产|置业|城建发展|园区开发"),
    ("建筑工程", r"建筑|建设|工程|施工|基建|路桥|隧道|中铁|中交|中建"),
    ("医药生物", r"医药|医疗|生物|药业|制药|健康|医院|诊断"),
    ("基础化工", r"化工|农药|材料|新材|石化|化学|橡胶|塑料"),
    ("机械设备", r"机械|装备|重工|机床|设备|电气|智能装备"),
    ("电子", r"电子|半导体|芯片|显示|光电|科技|数据|通信|软件"),
    ("汽车", r"汽车|汽配|车辆|客车|物流车|零部件"),
    ("食品饮料", r"食品|饮料|酒|葡萄酒|乳业|牧业|肉制品"),
    ("农林牧渔", r"农业|农牧|养殖|饲料|种业|渔业|林业"),
    ("纺织服饰", r"纺织|服饰|服装|鞋|家纺"),
    ("商贸零售", r"商贸|商业|百货|零售|供应链"),
    ("传媒互联网", r"传媒|文化|影视|出版|游戏|互联网"),
    ("综合", r"控股|集团|投资发展"),
]


def main() -> None:
    conn = connect()
    rows = conn.execute("select id, subject_name, title, summary, snippets, region, industry, notes from records").fetchall()
    updated = 0
    for row in rows:
        haystack = build_haystack(row)
        region = row["region"]
        industry = row["industry"]
        inferred_region = infer_region(haystack)
        inferred_industry = infer_industry(haystack)
        next_region = region if region and region != "待补充" else inferred_region
        next_industry = industry if industry and industry != "待补充" else inferred_industry
        if next_region != region or next_industry != industry:
            notes = row["notes"] or ""
            marker = "主体画像为规则推断，待正式主体库复核"
            if marker not in notes:
                notes = f"{notes}；{marker}" if notes else marker
            conn.execute(
                "update records set region=?, industry=?, notes=?, updated_at=current_timestamp where id=?",
                (next_region, next_industry, notes, row["id"]),
            )
            updated += 1
    conn.commit()
    print(json.dumps({"updated": updated}, ensure_ascii=False))


def build_haystack(row) -> str:
    snippets = row["snippets"] or "[]"
    try:
        snippet_text = " ".join(json.loads(snippets))
    except Exception:
        snippet_text = snippets
    return " ".join([
        row["subject_name"] or "",
        row["title"] or "",
        row["summary"] or "",
        snippet_text,
    ])


def infer_region(text: str) -> str:
    for province in PROVINCES:
        if province in text:
            return province
    for alias, province in REGION_ALIASES.items():
        if re.search(rf"(^|[^一-龥]){alias}[^一-龥]?(?:股|能|煤|钢|电|投|建|药|化|酒|新材|高速)", text):
            return province
    return "待补充"


def infer_industry(text: str) -> str:
    for industry, pattern in INDUSTRY_RULES:
        if re.search(pattern, text):
            return industry
    return "待补充"


if __name__ == "__main__":
    main()

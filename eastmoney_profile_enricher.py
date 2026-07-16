from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

from db import connect


API_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
CONTROLLER_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax"
QUOTE_LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get"
TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q="
REPORT_NAME = "RPT_F10_BASIC_ORGINFO"
FIELDS = [
    "SECUCODE",
    "SECURITY_CODE",
    "SECURITY_NAME_ABBR",
    "ORG_NAME",
    "INDUSTRYCSRC1",
    "PROVINCE",
    "REG_ADDRESS",
    "ADDRESS",
    "ORG_WEB",
    "TRADE_MARKET",
    "SECURITY_TYPE",
    "ORG_PROFILE",
]
PROFILE_COLUMNS = [
    "stock_code",
    "secucode",
    "subject_name",
    "org_name",
    "csrc_industry",
    "province",
    "registered_address",
    "office_address",
    "website",
    "trade_market",
    "security_type",
    "actual_controller",
    "enterprise_nature",
    "enterprise_nature_basis",
    "market_cap",
    "market_cap_date",
    "market_cap_source",
    "profile_source",
    "fetched_at",
]


SCHEMA = """
create table if not exists subject_profiles (
  stock_code text primary key,
  secucode text,
  subject_name text,
  org_name text,
  csrc_industry text,
  province text,
  registered_address text,
  office_address text,
  website text,
  trade_market text,
  security_type text,
  actual_controller text,
  enterprise_nature text,
  enterprise_nature_basis text,
  market_cap real,
  market_cap_date text,
  market_cap_source text,
  profile_source text,
  fetched_at text
);

create index if not exists idx_subject_profiles_province on subject_profiles(province);
create index if not exists idx_subject_profiles_csrc_industry on subject_profiles(csrc_industry);
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich listed-company profiles with public F10 data.")
    parser.add_argument("--sleep", type=float, default=0.12)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-age-hours", type=int, default=24)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--snapshot", type=Path, default=Path(__file__).resolve().parent / "data" / "profiles.json")
    args = parser.parse_args()

    conn = connect()
    conn.executescript(SCHEMA)
    ensure_profile_columns(conn)
    import_snapshot(conn, args.snapshot)
    codes = load_stock_codes(conn)
    if args.limit:
        codes = codes[: args.limit]
    fetched = 0
    updated_profiles = 0
    missing = []

    tasks = [
        (code, get_profile(conn, code))
        for code in codes
        if args.force or needs_refresh(conn, code, args.max_age_hours)
    ]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        results = executor.map(fetch_profile_task, tasks)
        for code, profile in results:
            fetched += 1
            if profile:
                upsert_profile(conn, profile)
                updated_profiles += 1
            else:
                missing.append(code)
            if fetched % 25 == 0:
                conn.commit()
            time.sleep(args.sleep)

    conn.commit()
    updated_market_caps = refresh_market_caps(conn, codes)
    conn.commit()
    updated_records = apply_profiles(conn)
    conn.commit()
    print(json.dumps({
        "status": "success",
        "stock_codes": len(codes),
        "fetched": fetched,
        "updated_profiles": updated_profiles,
        "updated_market_caps": updated_market_caps,
        "updated_records": updated_records,
        "missing": missing[:30],
        "missing_count": len(missing),
    }, ensure_ascii=False))


def fetch_profile_task(task: tuple[str, dict]) -> tuple[str, dict | None]:
    code, previous = task
    return code, fetch_profile(code, previous)


def import_snapshot(conn: sqlite3.Connection, path: Path) -> int:
    if not path.exists():
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    profiles = payload.get("profiles") if isinstance(payload, dict) else payload
    if not isinstance(profiles, list):
        return 0
    imported = 0
    for profile in profiles:
        if isinstance(profile, dict) and profile.get("stock_code"):
            upsert_profile(conn, profile)
            imported += 1
    conn.commit()
    return imported


def ensure_profile_columns(conn: sqlite3.Connection) -> None:
    existing = {
        row["name"]
        for row in conn.execute("pragma table_info(subject_profiles)").fetchall()
    }
    column_types = {
        "actual_controller": "text",
        "enterprise_nature": "text",
        "enterprise_nature_basis": "text",
        "market_cap": "real",
        "market_cap_date": "text",
        "market_cap_source": "text",
    }
    for column, column_type in column_types.items():
        if column not in existing:
            conn.execute(f"alter table subject_profiles add column {column} {column_type}")
    conn.commit()


def load_stock_codes(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        select distinct stock_code
        from records
        where stock_code is not null
          and length(stock_code)=6
          and stock_code glob '[0-9]*'
        order by stock_code
        """
    ).fetchall()
    return [row["stock_code"] for row in rows]


def get_profile(conn: sqlite3.Connection, stock_code: str) -> dict:
    row = conn.execute("select * from subject_profiles where stock_code=? limit 1", (stock_code,)).fetchone()
    return dict(row) if row else {}


def needs_refresh(conn: sqlite3.Connection, stock_code: str, max_age_hours: int) -> bool:
    profile = get_profile(conn, stock_code)
    if not profile:
        return True
    required = ["csrc_industry", "province", "actual_controller", "enterprise_nature", "enterprise_nature_basis"]
    if any(profile.get(field) in (None, "", 0) for field in required):
        return True
    try:
        fetched_at = datetime.strptime(profile.get("fetched_at") or "", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return True
    return fetched_at < datetime.now() - timedelta(hours=max_age_hours)


def fetch_profile(stock_code: str, previous: dict | None = None) -> dict | None:
    previous = previous or {}
    basic = fetch_basic_profile(stock_code)
    if not basic and not previous:
        return None
    profile = {column: previous.get(column) for column in PROFILE_COLUMNS}
    profile.update({key: value for key, value in (basic or {}).items() if value not in (None, "")})
    controller = fetch_controller(stock_code)
    if controller:
        profile["actual_controller"] = controller
    elif not profile.get("actual_controller"):
        profile["actual_controller"] = "未披露"
    profile["stock_code"] = stock_code
    profile["secucode"] = profile.get("secucode") or to_secucode(stock_code)
    nature, basis = classify_enterprise_nature(
        profile.get("actual_controller") or "",
        profile.pop("org_profile", "") or "",
    )
    profile["enterprise_nature"] = nature
    profile["enterprise_nature_basis"] = basis
    profile["profile_source"] = "东方财富公司资料及股东研究"
    profile["fetched_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return profile


def fetch_basic_profile(stock_code: str) -> dict | None:
    secucode = to_secucode(stock_code)
    params = {
        "reportName": REPORT_NAME,
        "columns": ",".join(FIELDS),
        "filter": f'(SECUCODE="{secucode}")',
        "pageNumber": "1",
        "pageSize": "1",
    }
    payload = fetch_json(f"{API_URL}?{urllib.parse.urlencode(params)}")
    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        return None
    row = rows[0]
    return {
        "stock_code": row.get("SECURITY_CODE") or stock_code,
        "secucode": row.get("SECUCODE") or secucode,
        "subject_name": row.get("SECURITY_NAME_ABBR") or "",
        "org_name": row.get("ORG_NAME") or "",
        "csrc_industry": row.get("INDUSTRYCSRC1") or "",
        "province": row.get("PROVINCE") or "",
        "registered_address": row.get("REG_ADDRESS") or "",
        "office_address": row.get("ADDRESS") or "",
        "website": normalize_website(row.get("ORG_WEB") or ""),
        "trade_market": row.get("TRADE_MARKET") or "",
        "security_type": row.get("SECURITY_TYPE") or "",
        "org_profile": row.get("ORG_PROFILE") or "",
    }


def fetch_controller(stock_code: str) -> str:
    params = urllib.parse.urlencode({"code": to_market_code(stock_code)})
    payload = fetch_json(f"{CONTROLLER_URL}?{params}")
    rows = (payload or {}).get("sjkzr") or []
    return str(rows[0].get("HOLDER_NAME") or "").strip() if rows else ""


def refresh_market_caps(conn: sqlite3.Connection, stock_codes: list[str]) -> int:
    updated = 0
    market_date = datetime.now().date().isoformat()
    requested = set(stock_codes)
    params = urllib.parse.urlencode({
        "pn": "1",
        "pz": "6000",
        "po": "1",
        "np": "1",
        "fltt": "2",
        "invt": "2",
        "fid": "f3",
        "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
        "fields": "f12,f14,f20",
    })
    payload = fetch_quote_json(f"{QUOTE_LIST_URL}?{params}")
    rows = ((payload or {}).get("data") or {}).get("diff") or []
    for row in rows:
        stock_code = str(row.get("f12") or "")
        if stock_code not in requested:
            continue
        try:
            market_cap = float(row.get("f20") or 0)
        except (TypeError, ValueError):
            continue
        if market_cap:
            cur = conn.execute(
                "update subject_profiles set market_cap=?, market_cap_date=?, market_cap_source=? where stock_code=?",
                (market_cap, market_date, "东方财富公开行情", stock_code),
            )
            updated += max(cur.rowcount, 0)
    if updated < len(requested):
        updated += refresh_market_caps_from_tencent(conn, requested, market_date)
    return updated


def refresh_market_caps_from_tencent(conn: sqlite3.Connection, stock_codes: set[str], market_date: str) -> int:
    updated = 0
    codes = sorted(stock_codes)
    for index in range(0, len(codes), 50):
        batch = codes[index:index + 50]
        symbols = ",".join(to_tencent_symbol(code) for code in batch)
        request = urllib.request.Request(
            f"{TENCENT_QUOTE_URL}{urllib.parse.quote(symbols, safe=',')}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                text = response.read().decode("gb18030", errors="replace")
        except Exception:
            continue
        for line in text.splitlines():
            match = re.search(r'="(.*)";', line)
            if not match:
                continue
            fields = match.group(1).split("~")
            if len(fields) <= 45:
                continue
            stock_code = fields[2]
            try:
                market_cap = float(fields[45]) * 100_000_000
            except (TypeError, ValueError):
                continue
            if stock_code in stock_codes and market_cap:
                cur = conn.execute(
                    "update subject_profiles set market_cap=?, market_cap_date=?, market_cap_source=? where stock_code=?",
                    (market_cap, market_date, "腾讯证券公开行情", stock_code),
                )
                updated += max(cur.rowcount, 0)
        time.sleep(0.1)
    return updated


def fetch_quote_json(url: str) -> dict | None:
    try:
        completed = subprocess.run(
            ["curl", "--retry", "3", "--retry-all-errors", "--retry-delay", "2", "--fail", "--silent", "--show-error", "--max-time", "30", url],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def fetch_json(url: str) -> dict | None:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8-sig"))
    except Exception:
        return None


def classify_enterprise_nature(controller: str, org_profile: str = "") -> tuple[str, str]:
    value = re.sub(r"\s+", "", controller or "")
    profile = re.sub(r"\s+", "", org_profile or "")
    if re.search(r"央企上市|中央企业控股|央企控股|中央企业旗下", profile):
        return "中央国企", "公司简介明确表述为央企或中央企业控股"
    if re.search(r"地方国有|地方国企|省属国企|市属国企|区属国企", profile):
        return "地方国企", "公司简介明确表述为地方国企"
    if re.search(r"民营上市|民营控股|民营企业", profile):
        return "民营企业", "公司简介明确表述为民营企业"
    if re.search(r"无实际控制人|無實際控制人|无控股股东", profile):
        return "公众企业", "公司简介明确表述无实际控制人"
    if not value or value in {"--", "未披露", "无实际控制人", "無實際控制人"}:
        return "公众企业", "公开资料未披露实际控制人"
    if re.search(r"国务院|中央人民政府|财政部|中央汇金|中央军委|国家.*委员会", value):
        return "中央国企", "实际控制人为中央政府或中央国资机构"
    if re.search(
        r"国家开发投资集团|国家电力投资集团|国家能源投资集团|"
        r"中国(?:东方航空|中信|五矿|供销|化学工程|医药|华电|宝武钢铁|广核|建筑|投资|机械工业|烟草|电影|石油天然气|航天科技|航空工业|邮政|长江三峡|国新控股|诚通|保利)"
        r"|招商局集团|华润集团|中粮集团|鞍钢集团",
        value,
    ):
        return "中央国企", "实际控制人为中央企业集团"
    if re.search(r"省|市|区|县|自治州|自治区|特别行政区", value) and re.search(r"人民政府|国有资产|财政厅|财政局|国资委", value):
        return "地方国企", "实际控制人为地方政府或地方国资机构"
    if re.search(r"国有资产监督管理委员会|国有资本运营", value):
        return "地方国企", "实际控制人为地方国资机构"
    if re.search(
        r"上海临港经济发展|北京电子控股|北京能源集团|山东重工集团|广东省粤科金融|"
        r"济南产业发展投资|陕西煤业化工|首都文化科技|江苏省吴中经济技术发展|"
        r"苏州市吴中金融控股|苏州市越旺集团|苏州市滨湖集团",
        value,
    ):
        return "地方国企", "实际控制人为地方国有企业集团"
    if re.search(r"香港|澳门|新加坡|日本|美国|英国|荷兰|开曼|BVI|LIMITED|LTD", value, re.I):
        return "外资企业", "实际控制人名称显示为境外主体"
    return "民营企业", "按实际控制人名称规则判定，需结合年报复核"


def to_secucode(stock_code: str) -> str:
    if stock_code.startswith(("8", "4")) or stock_code.startswith("920"):
        return f"{stock_code}.BJ"
    if stock_code.startswith(("6", "9")):
        return f"{stock_code}.SH"
    return f"{stock_code}.SZ"


def to_market_code(stock_code: str) -> str:
    suffix = "BJ" if stock_code.startswith(("8", "4", "920")) else "SH" if stock_code.startswith(("6", "9")) else "SZ"
    return f"{suffix}{stock_code}"


def to_tencent_symbol(stock_code: str) -> str:
    if stock_code.startswith(("8", "4", "920")):
        return f"bj{stock_code}"
    if stock_code.startswith(("6", "9")):
        return f"sh{stock_code}"
    return f"sz{stock_code}"


def normalize_website(value: str) -> str:
    website = value.strip()
    if not website:
        return ""
    if not re.match(r"^https?://", website, re.I):
        website = f"https://{website}"
    return website


def upsert_profile(conn: sqlite3.Connection, profile: dict) -> None:
    payload = {column: profile.get(column) for column in PROFILE_COLUMNS}
    columns = list(payload.keys())
    placeholders = ",".join("?" for _ in columns)
    updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != "stock_code")
    conn.execute(
        f"""
        insert into subject_profiles ({','.join(columns)})
        values ({placeholders})
        on conflict(stock_code) do update set {updates}
        """,
        [payload[column] for column in columns],
    )


def apply_profiles(conn: sqlite3.Connection) -> int:
    cur = conn.execute(
        """
        update records
        set
          region = coalesce((select nullif(province, '') from subject_profiles where subject_profiles.stock_code=records.stock_code), region),
          industry = coalesce((select nullif(csrc_industry, '') from subject_profiles where subject_profiles.stock_code=records.stock_code), industry),
          notes = case
            when stock_code in (select stock_code from subject_profiles)
             and (notes is null or notes = '')
            then '地区和行业来自东方财富公司资料：注册地省份、证监会行业分类'
            when stock_code in (select stock_code from subject_profiles)
             and instr(notes, '东方财富公司资料') = 0
            then notes || '；地区和行业来自东方财富公司资料：注册地省份、证监会行业分类'
            else notes
          end,
          updated_at = current_timestamp
        where stock_code in (select stock_code from subject_profiles)
        """
    )
    return int(cur.rowcount)


if __name__ == "__main__":
    main()

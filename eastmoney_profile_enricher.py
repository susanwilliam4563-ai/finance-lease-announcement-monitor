from __future__ import annotations

import argparse
import json
import sqlite3
import time
import urllib.parse
import urllib.request
from datetime import datetime

from db import connect


API_URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
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
  profile_source text,
  fetched_at text
);

create index if not exists idx_subject_profiles_province on subject_profiles(province);
create index if not exists idx_subject_profiles_csrc_industry on subject_profiles(csrc_industry);
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich A-share records with CSRC industry and registered province.")
    parser.add_argument("--sleep", type=float, default=0.12)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    conn = connect()
    conn.executescript(SCHEMA)
    codes = load_stock_codes(conn)
    if args.limit:
        codes = codes[: args.limit]
    fetched = 0
    updated_profiles = 0
    updated_records = 0
    missing = []

    for code in codes:
        if not args.force and has_profile(conn, code):
            continue
        profile = fetch_profile(code)
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
    updated_records = apply_profiles(conn)
    conn.commit()
    print(json.dumps({
        "status": "success",
        "stock_codes": len(codes),
        "fetched": fetched,
        "updated_profiles": updated_profiles,
        "updated_records": updated_records,
        "missing": missing[:30],
        "missing_count": len(missing),
    }, ensure_ascii=False))


def load_stock_codes(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        select distinct stock_code
        from records
        where stock_code is not null
          and stock_code!=''
          and (region in ('', '待补充') or industry in ('', '待补充'))
        order by stock_code
        """
    ).fetchall()
    return [row["stock_code"] for row in rows]


def has_profile(conn: sqlite3.Connection, stock_code: str) -> bool:
    row = conn.execute("select 1 from subject_profiles where stock_code=? limit 1", (stock_code,)).fetchone()
    return bool(row)


def fetch_profile(stock_code: str) -> dict | None:
    secucode = to_secucode(stock_code)
    params = {
        "reportName": REPORT_NAME,
        "columns": ",".join(FIELDS),
        "filter": f'(SECUCODE="{secucode}")',
        "pageNumber": "1",
        "pageSize": "1",
    }
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None
    rows = ((payload.get("result") or {}).get("data") or [])
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
        "website": row.get("ORG_WEB") or "",
        "trade_market": row.get("TRADE_MARKET") or "",
        "security_type": row.get("SECURITY_TYPE") or "",
        "profile_source": "东方财富公司资料",
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def to_secucode(stock_code: str) -> str:
    if stock_code.startswith(("8", "4")) or stock_code.startswith("920"):
        return f"{stock_code}.BJ"
    if stock_code.startswith(("6", "9")):
        return f"{stock_code}.SH"
    return f"{stock_code}.SZ"


def upsert_profile(conn: sqlite3.Connection, profile: dict) -> None:
    columns = list(profile.keys())
    placeholders = ",".join("?" for _ in columns)
    updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != "stock_code")
    conn.execute(
        f"""
        insert into subject_profiles ({",".join(columns)})
        values ({placeholders})
        on conflict(stock_code) do update set {updates}
        """,
        [profile[column] for column in columns],
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

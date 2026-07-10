from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = Path(os.getenv("FINANCE_LEASE_DB_PATH", DATA_DIR / "finance_lease_monitor.sqlite3"))


SCHEMA = """
create table if not exists records (
  id text primary key,
  subject_name text not null,
  subject_type text not null,
  stock_code text,
  bond_code text,
  region text,
  industry text,
  announcement_date text not null,
  title text not null,
  source text not null,
  source_url text,
  pdf_url text,
  matched_keywords text not null,
  matched_position text,
  announcement_type text,
  lease_role text,
  amount text,
  term text,
  counterparty text,
  leased_asset text,
  related_party text,
  guarantee_or_collateral text,
  summary text,
  risk_labels text not null,
  review_status text,
  snippets text not null,
  attention_level text,
  notes text,
  raw_payload text,
  created_at text default current_timestamp,
  updated_at text default current_timestamp
);

create table if not exists refresh_runs (
  id integer primary key autoincrement,
  source text not null,
  start_date text not null,
  end_date text not null,
  status text not null,
  message text,
  fetched_count integer default 0,
  kept_count integer default 0,
  started_at text default current_timestamp,
  finished_at text
);

create index if not exists idx_records_date on records(announcement_date);
create index if not exists idx_records_subject on records(subject_name);
create index if not exists idx_records_source on records(source);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def encode_list(value: list[str] | str | None) -> str:
    if isinstance(value, list):
      return json.dumps(value, ensure_ascii=False)
    if not value:
      return "[]"
    return json.dumps([item.strip() for item in str(value).replace("，", "、").split("、") if item.strip()], ensure_ascii=False)


def decode_list(value: str | None) -> list[str]:
    if not value:
      return []
    try:
      data = json.loads(value)
      return data if isinstance(data, list) else []
    except json.JSONDecodeError:
      return [value]


def upsert_record(conn: sqlite3.Connection, record: dict) -> None:
    columns = [
        "id",
        "subject_name",
        "subject_type",
        "stock_code",
        "bond_code",
        "region",
        "industry",
        "announcement_date",
        "title",
        "source",
        "source_url",
        "pdf_url",
        "matched_keywords",
        "matched_position",
        "announcement_type",
        "lease_role",
        "amount",
        "term",
        "counterparty",
        "leased_asset",
        "related_party",
        "guarantee_or_collateral",
        "summary",
        "risk_labels",
        "review_status",
        "snippets",
        "attention_level",
        "notes",
        "raw_payload",
    ]
    payload = dict(record)
    payload["matched_keywords"] = encode_list(payload.get("matched_keywords"))
    payload["risk_labels"] = encode_list(payload.get("risk_labels"))
    payload["snippets"] = encode_list(payload.get("snippets"))
    payload["raw_payload"] = json.dumps(payload.get("raw_payload") or {}, ensure_ascii=False)
    values = [payload.get(column, "") for column in columns]
    placeholders = ",".join("?" for _ in columns)
    updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != "id")
    conn.execute(
        f"""
        insert into records ({",".join(columns)})
        values ({placeholders})
        on conflict(id) do update set {updates}, updated_at=current_timestamp
        """,
        values,
    )


def rows_to_records(rows: list[sqlite3.Row]) -> list[dict]:
    records = []
    for row in rows:
        item = dict(row)
        item["matched_keywords"] = decode_list(item.get("matched_keywords"))
        item["risk_labels"] = decode_list(item.get("risk_labels"))
        item["snippets"] = decode_list(item.get("snippets"))
        item.pop("raw_payload", None)
        item.pop("created_at", None)
        item.pop("updated_at", None)
        records.append(item)
    return records

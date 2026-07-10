from __future__ import annotations

import argparse
import json
from pathlib import Path

from cninfo_updater import EXTRACTOR_VERSION
from db import DB_PATH, connect, upsert_record


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild the SQLite working database from a public JSON snapshot.")
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--reset", action="store_true", required=True)
    args = parser.parse_args()

    payload = json.loads(args.snapshot.read_text(encoding="utf-8"))
    records = payload.get("records") or []
    if not isinstance(records, list):
        raise ValueError("snapshot records must be a list")

    if DB_PATH.exists():
        DB_PATH.unlink()
    conn = connect()
    for record in records:
        item = dict(record)
        item["raw_payload"] = {"_extractor_version": EXTRACTOR_VERSION}
        upsert_record(conn, item)
    conn.commit()
    print(json.dumps({"status": "success", "imported": len(records)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

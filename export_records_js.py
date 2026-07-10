from __future__ import annotations

import json
import hashlib
from datetime import date
from pathlib import Path

from db import connect, rows_to_records


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    data_dir = base_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = connect()
    rows = conn.execute("select * from records order by announcement_date desc, subject_name asc").fetchall()
    records = rows_to_records(rows)
    generated_at = conn.execute("select datetime('now', 'localtime')").fetchone()[0]
    records_path = data_dir / "records.json"
    records_generated_at = generated_at
    if records_path.exists():
        try:
            previous = json.loads(records_path.read_text(encoding="utf-8"))
            if previous.get("records") == records:
                records_generated_at = previous.get("generated_at") or generated_at
        except (OSError, json.JSONDecodeError):
            pass
    payload = {
        "generated_at": records_generated_at,
        "count": len(rows),
        "records": records,
    }
    js = "window.FINANCE_LEASE_RECORDS = "
    js += json.dumps(payload, ensure_ascii=False)
    js += ";\n"
    (data_dir / "records.js").write_text(js, encoding="utf-8")
    records_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    latest = conn.execute("select * from refresh_runs order by id desc limit 1").fetchone()
    latest_success = conn.execute(
        "select * from refresh_runs where status='success' order by id desc limit 1"
    ).fetchone()
    earliest = min((item["announcement_date"] for item in records), default=None)
    newest = max((item["announcement_date"] for item in records), default=None)
    data_as_of = latest_success["end_date"] if latest_success else newest
    source_counts = {
        row["source"]: row["count"]
        for row in conn.execute("select source, count(*) as count from records group by source").fetchall()
    }
    revision_source = f"{generated_at}|{len(records)}|{data_as_of}|{latest_success['finished_at'] if latest_success else ''}"
    status = {
        "deployment_mode": "static",
        "generated_at": generated_at,
        "revision": hashlib.sha256(revision_source.encode("utf-8")).hexdigest()[:16],
        "record_count": len(records),
        "earliest_announcement_date": earliest,
        "latest_announcement_date": newest,
        "history_start_date": "2021-01-01",
        "latest_run": dict(latest) if latest else None,
        "latest_successful_run": dict(latest_success) if latest_success else None,
        "data_as_of": data_as_of,
        "days_since_check": (date.today() - date.fromisoformat(data_as_of)).days if data_as_of else None,
        "source_counts": source_counts,
        "page_poll_interval_seconds": 60,
        "auto_refresh": {
            "enabled": True,
            "interval_minutes": 60,
            "running": False,
            "last_finished_at": generated_at,
            "next_run_at": None,
        },
    }
    (data_dir / "status.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"exported {len(rows)} records to {data_dir}")


if __name__ == "__main__":
    main()

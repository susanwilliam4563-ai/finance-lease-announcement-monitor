from __future__ import annotations

import json
import hashlib
from datetime import date, timedelta
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
    previous = None
    if records_path.exists():
        try:
            previous = json.loads(records_path.read_text(encoding="utf-8"))
            previous_order = {
                item.get("id"): index
                for index, item in enumerate(previous.get("records") or [])
                if item.get("id")
            }
            records.sort(
                key=lambda item: (
                    -date.fromisoformat(item["announcement_date"]).toordinal(),
                    item["subject_name"],
                    (0, previous_order[item["id"]])
                    if item["id"] in previous_order
                    else (1, item["id"]),
                )
            )
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

    recent_cutoff = (date.today() - timedelta(days=89)).isoformat()
    recent_records = [item for item in records if item["announcement_date"] >= recent_cutoff]
    recent_payload = {
        "generated_at": generated_at,
        "count": len(recent_records),
        "scope": "recent-90-days",
        "start_date": recent_cutoff,
        "records": recent_records,
    }
    (data_dir / "recent.json").write_text(
        json.dumps(recent_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    years_dir = data_dir / "years"
    years_dir.mkdir(parents=True, exist_ok=True)
    years: dict[str, list[dict]] = {}
    for item in records:
        years.setdefault(item["announcement_date"][:4], []).append(item)
    for year, year_records in years.items():
        year_payload = {
            "generated_at": generated_at,
            "count": len(year_records),
            "year": year,
            "records": year_records,
        }
        (years_dir / f"{year}.json").write_text(
            json.dumps(year_payload, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
    manifest = {
        "generated_at": generated_at,
        "total_count": len(records),
        "recent": {
            "file": "recent.json",
            "count": len(recent_records),
            "start_date": recent_cutoff,
        },
        "years": [
            {"year": year, "count": len(years[year]), "file": f"years/{year}.json"}
            for year in sorted(years, reverse=True)
        ],
    }
    (data_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
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
    recent_runs = conn.execute("select * from refresh_runs order by id desc limit 50").fetchall()
    consecutive_failures = 0
    for run in recent_runs:
        if run["status"] == "success":
            break
        consecutive_failures += 1
    days_since_check = (date.today() - date.fromisoformat(data_as_of)).days if data_as_of else None
    latest_failed = bool(latest and latest["status"] == "failed")
    freshness_state = "red" if latest_failed or (days_since_check is not None and days_since_check > 2) else "yellow" if days_since_check and days_since_check > 1 else "green"
    expected_sources = [
        "巨潮资讯",
        "上海证券交易所",
        "深圳证券交易所",
        "北京证券交易所",
        "港交所披露易",
        "上市公司官网",
    ]
    source_statuses = []
    for source in expected_sources:
        connected = source in source_counts
        source_statuses.append({
            "source": source,
            "connected": connected,
            "state": freshness_state if connected else "unconnected",
            "record_count": source_counts.get(source, 0),
            "last_checked_at": latest["finished_at"] if connected and latest else None,
            "last_success_at": latest_success["finished_at"] if connected and latest_success else None,
            "latest_announcement_date": newest if connected else None,
        })
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
        "days_since_check": days_since_check,
        "freshness_state": freshness_state,
        "consecutive_failures": consecutive_failures,
        "source_counts": source_counts,
        "source_statuses": source_statuses,
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

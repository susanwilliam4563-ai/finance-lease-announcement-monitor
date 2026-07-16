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

    profile_rows = []
    if conn.execute("select 1 from sqlite_master where type='table' and name='subject_profiles'").fetchone():
        profile_rows = [dict(row) for row in conn.execute("select * from subject_profiles order by stock_code").fetchall()]
    profiles_payload = {
        "generated_at": generated_at,
        "count": len(profile_rows),
        "profiles": profile_rows,
    }
    (data_dir / "profiles.json").write_text(
        json.dumps(profiles_payload, ensure_ascii=False, indent=2) + "\n",
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
    source_statuses = build_source_statuses(conn, source_counts, profile_rows)
    direct_runs = [item for item in source_statuses if item["mode"] == "direct"]
    successful_end_dates = [item["checked_through"] for item in direct_runs if item.get("checked_through")]
    if successful_end_dates:
        data_as_of = min(successful_end_dates)
    days_since_check = (date.today() - date.fromisoformat(data_as_of)).days if data_as_of else None
    failure_streaks = {
        item["source"]: source_failure_streak(conn, item["source"])
        for item in direct_runs
    }
    consecutive_failures = max(failure_streaks.values(), default=0)
    freshness_state = "red" if any(item["state"] == "red" for item in direct_runs) else "yellow" if days_since_check and days_since_check > 1 else "green"
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
        "source_failure_streaks": failure_streaks,
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


def build_source_statuses(conn, source_counts: dict[str, int], profiles: list[dict]) -> list[dict]:
    run_rows = conn.execute(
        """
        select r.* from refresh_runs r
        join (select source, max(id) as id from refresh_runs group by source) latest on latest.id=r.id
        """
    ).fetchall()
    runs = {row["source"]: dict(row) for row in run_rows}
    market_counts = {
        "上海证券交易所": conn.execute("select count(*) as count from records where source='巨潮资讯' and stock_code glob '6*'").fetchone()["count"],
        "深圳证券交易所": conn.execute("select count(*) as count from records where source='巨潮资讯' and (stock_code glob '0*' or stock_code glob '2*' or stock_code glob '3*')").fetchone()["count"],
        "北京证券交易所": conn.execute("select count(*) as count from records where source='巨潮资讯' and (stock_code glob '4*' or stock_code glob '8*' or stock_code glob '920*')").fetchone()["count"],
    }
    latest_dates = {
        "巨潮资讯": latest_record_date(conn, "source=?", ("巨潮资讯",)),
        "上海证券交易所": latest_record_date(conn, "source='巨潮资讯' and stock_code glob '6*'"),
        "深圳证券交易所": latest_record_date(conn, "source='巨潮资讯' and (stock_code glob '0*' or stock_code glob '2*' or stock_code glob '3*')"),
        "北京证券交易所": latest_record_date(conn, "source='巨潮资讯' and (stock_code glob '4*' or stock_code glob '8*' or stock_code glob '920*')"),
        "港交所披露易": latest_record_date(conn, "source=?", ("港交所披露易",)),
    }
    cninfo_run = runs.get("巨潮资讯")
    statuses = [source_status("巨潮资讯", "direct", source_counts.get("巨潮资讯", 0), cninfo_run, latest_dates["巨潮资讯"])]
    for source in ("上海证券交易所", "深圳证券交易所", "北京证券交易所"):
        statuses.append(source_status(source, "covered", market_counts[source], cninfo_run, latest_dates[source]))
    statuses.append(source_status("港交所披露易", "direct", source_counts.get("港交所披露易", 0), runs.get("港交所披露易"), latest_dates["港交所披露易"]))
    website_count = sum(1 for profile in profiles if profile.get("website"))
    statuses.append({
        "source": "上市公司官网",
        "mode": "reference",
        "connected": website_count > 0,
        "state": "green" if website_count else "unconnected",
        "record_count": website_count,
        "last_checked_at": max((profile.get("fetched_at") or "" for profile in profiles), default="") or None,
        "last_success_at": max((profile.get("fetched_at") or "" for profile in profiles), default="") or None,
        "latest_announcement_date": None,
        "checked_through": None,
    })
    statuses.append({
        "source": "互联网/公众号",
        "mode": "unconnected",
        "connected": False,
        "state": "unconnected",
        "record_count": source_counts.get("互联网/公众号", 0),
        "last_checked_at": None,
        "last_success_at": None,
        "latest_announcement_date": None,
        "checked_through": None,
    })
    return statuses


def latest_record_date(conn, where: str, params: tuple = ()) -> str | None:
    row = conn.execute(f"select max(announcement_date) as date from records where {where}", params).fetchone()
    return row["date"] if row else None


def source_failure_streak(conn, source: str) -> int:
    rows = conn.execute(
        "select status from refresh_runs where source=? order by id desc limit 100",
        (source,),
    ).fetchall()
    streak = 0
    for row in rows:
        if row["status"] == "success":
            break
        if row["status"] == "failed":
            streak += 1
    return streak


def source_status(source: str, mode: str, record_count: int, run: dict | None, latest_date: str | None) -> dict:
    connected = bool(run and run.get("status") == "success")
    checked_through = run.get("end_date") if connected else None
    days = (date.today() - date.fromisoformat(checked_through)).days if checked_through else None
    state = "red" if run and run.get("status") == "failed" else "yellow" if connected and days and days > 1 else "green" if connected else "unconnected"
    return {
        "source": source,
        "mode": mode,
        "connected": connected,
        "state": state,
        "record_count": record_count,
        "last_checked_at": run.get("finished_at") if run else None,
        "last_success_at": run.get("finished_at") if connected else None,
        "latest_announcement_date": latest_date,
        "checked_through": checked_through,
    }


if __name__ == "__main__":
    main()

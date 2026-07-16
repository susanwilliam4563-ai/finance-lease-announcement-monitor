from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from db import connect, rows_to_records
from export_records_js import build_source_statuses, source_failure_streak


BASE_DIR = Path(__file__).resolve().parent
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8765"))
HISTORY_START_DATE = "2021-01-01"
AUTO_REFRESH_ENABLED = os.getenv("AUTO_REFRESH_ENABLED", "1").lower() not in {"0", "false", "no"}
AUTO_REFRESH_INTERVAL_MINUTES = int(os.getenv("AUTO_REFRESH_INTERVAL_MINUTES", "60"))
AUTO_REFRESH_STARTUP_DELAY_SECONDS = int(os.getenv("AUTO_REFRESH_STARTUP_DELAY_SECONDS", "10"))
AUTO_REFRESH_SKIP_PDF = os.getenv("AUTO_REFRESH_SKIP_PDF", "0").lower() not in {"0", "false", "no"}
MANUAL_REFRESH_ENABLED = os.getenv("MANUAL_REFRESH_ENABLED", "1").lower() not in {"0", "false", "no"}
PAGE_POLL_INTERVAL_SECONDS = int(os.getenv("PAGE_POLL_INTERVAL_SECONDS", "60"))
REFRESH_LOCK = threading.Lock()
AUTO_REFRESH_STATE = {
    "enabled": AUTO_REFRESH_ENABLED,
    "interval_minutes": AUTO_REFRESH_INTERVAL_MINUTES,
    "skip_pdf": AUTO_REFRESH_SKIP_PDF,
    "running": False,
    "last_started_at": None,
    "last_finished_at": None,
    "last_status": None,
    "last_message": None,
    "next_run_at": None,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/records":
            self.send_json(records_payload())
            return
        if parsed.path == "/api/status":
            self.send_json(status_payload())
            return
        if parsed.path == "/health":
            self.send_json({"status": "ok", "time": datetime.now().isoformat(timespec="seconds")})
            return
        if parsed.path in {"/", "/index.html", "/styles.css", "/app.js"} or parsed.path.startswith("/data/"):
            return super().do_GET()
        self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/refresh":
            if not MANUAL_REFRESH_ENABLED:
                self.send_json({"status": "forbidden", "message": "手动刷新未开放；服务端会自动更新。"}, status=403)
                return
            params = parse_qs(parsed.query)
            start = params.get("start", [None])[0]
            end = params.get("end", [date.today().isoformat()])[0]
            skip_pdf = params.get("skip_pdf", ["0"])[0] in {"1", "true", "yes"}
            if not start:
                start = default_refresh_start()
            result = guarded_refresh(start, end, skip_pdf=skip_pdf, trigger="manual")
            self.send_json(result, status=200 if result["status"] in {"success", "skipped"} else 500)
            return
        self.send_error(404)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def records_payload() -> dict:
    conn = connect()
    rows = conn.execute("select * from records order by announcement_date desc, subject_name asc").fetchall()
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "records": rows_to_records(rows),
        "count": len(rows),
        "source": "local-sqlite",
    }


def status_payload() -> dict:
    conn = connect()
    latest = conn.execute("select * from refresh_runs order by id desc limit 1").fetchone()
    latest_success = conn.execute(
        "select * from refresh_runs where status='success' order by id desc limit 1"
    ).fetchone()
    total = conn.execute("select count(*) as count from records").fetchone()["count"]
    earliest = conn.execute("select min(announcement_date) as date from records").fetchone()["date"]
    newest = conn.execute("select max(announcement_date) as date from records").fetchone()["date"]
    source_counts = {
        row["source"]: row["count"]
        for row in conn.execute("select source, count(*) as count from records group by source").fetchall()
    }
    profile_rows = []
    if conn.execute("select 1 from sqlite_master where type='table' and name='subject_profiles'").fetchone():
        profile_rows = [dict(row) for row in conn.execute("select * from subject_profiles").fetchall()]
    source_statuses = build_source_statuses(conn, source_counts, profile_rows)
    direct_sources = [item for item in source_statuses if item["mode"] == "direct"]
    checked_dates = [item["checked_through"] for item in direct_sources if item.get("checked_through")]
    data_as_of = min(checked_dates) if checked_dates else (latest_success["end_date"] if latest_success else newest)
    days_since_check = None
    if data_as_of:
        days_since_check = (date.today() - date.fromisoformat(data_as_of)).days
    failure_streaks = {item["source"]: source_failure_streak(conn, item["source"]) for item in direct_sources}
    failures = max(failure_streaks.values(), default=0)
    freshness_state = "red" if any(item["state"] == "red" for item in direct_sources) else "yellow" if days_since_check and days_since_check > 1 else "green"
    revision_source = f"{total}|{data_as_of}|{latest_success['finished_at'] if latest_success else ''}"
    return {
        "revision": hashlib.sha256(revision_source.encode("utf-8")).hexdigest()[:16],
        "record_count": total,
        "earliest_announcement_date": earliest,
        "latest_announcement_date": newest,
        "history_start_date": HISTORY_START_DATE,
        "latest_run": dict(latest) if latest else None,
        "latest_successful_run": dict(latest_success) if latest_success else None,
        "data_as_of": data_as_of,
        "days_since_check": days_since_check,
        "freshness_state": freshness_state,
        "consecutive_failures": failures,
        "source_failure_streaks": failure_streaks,
        "source_counts": source_counts,
        "source_statuses": source_statuses,
        "page_poll_interval_seconds": PAGE_POLL_INTERVAL_SECONDS,
        "manual_refresh_enabled": MANUAL_REFRESH_ENABLED,
        "auto_refresh": dict(AUTO_REFRESH_STATE),
    }


def default_refresh_start() -> str:
    conn = connect()
    count = conn.execute("select count(*) as count from records").fetchone()["count"]
    if count == 0:
        return HISTORY_START_DATE
    return (date.today() - timedelta(days=14)).isoformat()


def run_refresh(start: str, end: str, skip_pdf: bool = False) -> dict:
    cninfo_cmd = [sys.executable, str(BASE_DIR / "cninfo_updater.py"), "--start", start, "--end", end]
    hkex_cmd = [sys.executable, str(BASE_DIR / "hkex_updater.py"), "--start", start, "--end", end]
    if skip_pdf:
        cninfo_cmd.append("--skip-pdf")
        hkex_cmd.append("--skip-pdf")
    cninfo_completed = subprocess.run(cninfo_cmd, cwd=str(BASE_DIR), text=True, capture_output=True, timeout=1800)
    hkex_completed = subprocess.run(hkex_cmd, cwd=str(BASE_DIR), text=True, capture_output=True, timeout=1800)
    profile_completed = subprocess.run(
        [sys.executable, str(BASE_DIR / "eastmoney_profile_enricher.py")],
        cwd=str(BASE_DIR),
        text=True,
        capture_output=True,
        timeout=900,
    )
    export_completed = subprocess.run(
        [sys.executable, str(BASE_DIR / "export_records_js.py")],
        cwd=str(BASE_DIR),
        text=True,
        capture_output=True,
        timeout=120,
    )
    collectors = {
        "巨潮资讯": process_result(cninfo_completed),
        "港交所披露易": process_result(hkex_completed),
    }
    successful_collectors = sum(1 for item in collectors.values() if item["status"] == "success")
    result = {
        "status": "success" if successful_collectors and export_completed.returncode == 0 else "failed",
        "collectors": collectors,
        "message": f"{successful_collectors}/2 collectors succeeded",
    }
    result["profile_status"] = "success" if profile_completed.returncode == 0 else "failed"
    result["profile_stdout"] = profile_completed.stdout.strip().splitlines()[-1:] or []
    result["export_status"] = "success" if export_completed.returncode == 0 else "failed"
    return result


def process_result(completed: subprocess.CompletedProcess) -> dict:
    try:
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
    except Exception:
        payload = {}
    return {
        "status": "success" if completed.returncode == 0 else "failed",
        "result": payload,
        "stderr": completed.stderr.strip(),
    }


def guarded_refresh(start: str, end: str, skip_pdf: bool, trigger: str) -> dict:
    if not REFRESH_LOCK.acquire(blocking=False):
        return {
            "status": "skipped",
            "message": "已有刷新任务正在执行",
            "trigger": trigger,
        }
    started_at = datetime.now()
    AUTO_REFRESH_STATE.update(
        {
            "running": True,
            "last_started_at": started_at.isoformat(timespec="seconds"),
            "last_status": "running",
            "last_message": f"{trigger} refresh {start} to {end}",
        }
    )
    try:
        result = run_refresh(start, end, skip_pdf=skip_pdf)
        AUTO_REFRESH_STATE.update(
            {
                "last_status": result.get("status"),
                "last_message": result.get("message") or result.get("stderr") or result.get("status"),
            }
        )
        result["trigger"] = trigger
        return result
    except Exception as error:
        AUTO_REFRESH_STATE.update({"last_status": "failed", "last_message": str(error)})
        return {"status": "failed", "message": str(error), "trigger": trigger}
    finally:
        AUTO_REFRESH_STATE.update(
            {
                "running": False,
                "last_finished_at": datetime.now().isoformat(timespec="seconds"),
            }
        )
        REFRESH_LOCK.release()


def auto_refresh_loop() -> None:
    if not AUTO_REFRESH_ENABLED or AUTO_REFRESH_INTERVAL_MINUTES <= 0:
        AUTO_REFRESH_STATE["next_run_at"] = None
        return
    startup_delay = max(0, AUTO_REFRESH_STARTUP_DELAY_SECONDS)
    AUTO_REFRESH_STATE["next_run_at"] = (datetime.now() + timedelta(seconds=startup_delay)).isoformat(timespec="seconds")
    time.sleep(startup_delay)
    while True:
        start = default_refresh_start()
        end = date.today().isoformat()
        guarded_refresh(start, end, skip_pdf=AUTO_REFRESH_SKIP_PDF, trigger="auto")
        next_run = datetime.now() + timedelta(minutes=AUTO_REFRESH_INTERVAL_MINUTES)
        AUTO_REFRESH_STATE["next_run_at"] = next_run.isoformat(timespec="seconds")
        time.sleep(AUTO_REFRESH_INTERVAL_MINUTES * 60)


def start_auto_refresh_thread() -> None:
    if not AUTO_REFRESH_ENABLED or AUTO_REFRESH_INTERVAL_MINUTES <= 0:
        return
    thread = threading.Thread(target=auto_refresh_loop, name="auto-refresh", daemon=True)
    thread.start()


def main() -> None:
    connect().close()
    start_auto_refresh_thread()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    display_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    print(f"http://{display_host}:{PORT}/")
    if AUTO_REFRESH_ENABLED and AUTO_REFRESH_INTERVAL_MINUTES > 0:
        print(f"auto refresh every {AUTO_REFRESH_INTERVAL_MINUTES} minutes")
    server.serve_forever()


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from html.parser import HTMLParser

from cninfo_updater import extract_pdf_text
from db import connect, upsert_record


SEARCH_URL = "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh"
SITE_ROOT = "https://www1.hkexnews.hk"
KEYWORDS = ["融資租賃", "售後回租", "售後租回", "金融租賃"]
EXTRACTOR_VERSION = 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch HKEX finance lease announcements by official title search.")
    parser.add_argument("--start", default=(date.today() - timedelta(days=14)).isoformat())
    parser.add_argument("--end", default=date.today().isoformat())
    parser.add_argument("--keywords", default=",".join(KEYWORDS))
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--skip-pdf", action="store_true")
    parser.add_argument("--max-months", type=int, default=0)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    if end < start:
        raise ValueError("end date must not be earlier than start date")
    keywords = [item.strip() for item in args.keywords.split(",") if item.strip()]
    conn = connect()
    run_id = start_run(conn, args.start, args.end)
    fetched = 0
    kept = 0
    seen: dict[str, dict] = {}
    try:
        ranges = list(month_ranges(start, end))
        if args.max_months:
            ranges = ranges[: args.max_months]
        tasks = [
            (keyword, range_start, range_end)
            for range_start, range_end in ranges
            for keyword in keywords
        ]
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            results = executor.map(search_task, tasks)
            for keyword, items in results:
                for item in items:
                    fetched += 1
                    key = item["id"]
                    bucket = seen.setdefault(key, {"item": item, "query_keywords": set()})
                    bucket["query_keywords"].add(keyword)
                time.sleep(args.sleep)
        for key, bucket in seen.items():
            existing_status = record_status(conn, key)
            if existing_status == "已复核官方公告" or (args.skip_pdf and existing_status):
                continue
            record = build_record(bucket["item"], sorted(bucket["query_keywords"]), skip_pdf=args.skip_pdf)
            upsert_record(conn, record)
            kept += 1
        finish_run(conn, run_id, "success", f"fetched={fetched} kept={kept}", fetched, kept)
        conn.commit()
        print(json.dumps({"status": "success", "fetched": fetched, "kept": kept}, ensure_ascii=False))
    except Exception as exc:
        finish_run(conn, run_id, "failed", str(exc), fetched, kept)
        conn.commit()
        raise


def month_ranges(start: date, end: date):
    cursor = start
    while cursor <= end:
        next_month = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        range_end = min(end, next_month - timedelta(days=1))
        yield cursor, range_end
        cursor = range_end + timedelta(days=1)


def search_task(task: tuple[str, date, date]) -> tuple[str, list[dict]]:
    keyword, start, end = task
    last_error = None
    for attempt in range(3):
        try:
            return keyword, search_titles(keyword, start, end)
        except Exception as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"HKEX title search failed for {keyword} {start}..{end}: {last_error}")


def search_titles(keyword: str, start: date, end: date) -> list[dict]:
    payload = {
        "lang": "ZH",
        "category": "0",
        "market": "SEHK",
        "searchType": "0",
        "documentType": "-1",
        "t1code": "-2",
        "t2Gcode": "-2",
        "t2code": "-2",
        "stockId": "",
        "from": start.strftime("%Y%m%d"),
        "to": end.strftime("%Y%m%d"),
        "title": keyword,
    }
    request = urllib.request.Request(
        SEARCH_URL,
        data=urllib.parse.urlencode(payload).encode("utf-8"),
        headers={
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Referer": "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        html = response.read().decode("utf-8", errors="replace")
    parser = HKEXResultParser()
    parser.feed(html)
    return parser.records


class HKEXResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict] = []
        self.row: dict | None = None
        self.field = ""
        self.capture_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "tr":
            self.row = {"release_time": "", "stock_code": "", "stock_name": "", "title": "", "href": ""}
        elif tag == "td" and self.row is not None:
            if "release-time" in classes:
                self.field = "release_time"
            elif "stock-short-code" in classes:
                self.field = "stock_code"
            elif "stock-short-name" in classes:
                self.field = "stock_name"
            else:
                self.field = ""
        elif tag == "a" and self.row is not None:
            href = attributes.get("href") or ""
            if "/listedco/listconews/" in href:
                self.row["href"] = urllib.parse.urljoin(SITE_ROOT, href)
                self.capture_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self.capture_title = False
        elif tag == "td":
            self.field = ""
        elif tag == "tr" and self.row is not None:
            item = finalize_row(self.row)
            if item:
                self.records.append(item)
            self.row = None

    def handle_data(self, data: str) -> None:
        if self.row is None:
            return
        if self.capture_title:
            self.row["title"] += f" {data}"
        elif self.field:
            self.row[self.field] += f" {data}"


def finalize_row(row: dict) -> dict | None:
    href = row.get("href") or ""
    if not href:
        return None
    release_time = clean_field(row.get("release_time") or "", "發放時間:")
    stock_code = clean_field(row.get("stock_code") or "", "股份代號:")
    stock_name = clean_field(row.get("stock_name") or "", "股份簡稱:")
    title = clean_field(row.get("title") or "")
    date_match = re.search(r"(\d{2})/(\d{2})/(\d{4})", release_time)
    if not date_match or not stock_code or not stock_name or not title:
        return None
    announcement_date = f"{date_match.group(3)}-{date_match.group(2)}-{date_match.group(1)}"
    source_key = re.search(r"/(\d{13})_c\.(?:pdf|htm)", href, re.I)
    stable_id = source_key.group(1) if source_key else hashlib.sha1(href.encode("utf-8")).hexdigest()[:20]
    return {
        "id": f"hkex:{stable_id}",
        "stock_code": stock_code,
        "stock_name": stock_name,
        "title": title,
        "announcement_date": announcement_date,
        "release_time": release_time,
        "href": href,
    }


def build_record(item: dict, query_keywords: list[str], skip_pdf: bool) -> dict:
    title = item["title"]
    text = ""
    pdf_error = ""
    if item["href"].lower().endswith(".pdf") and not skip_pdf:
        try:
            text = extract_pdf_text(item["href"])
        except Exception as exc:
            pdf_error = str(exc)
    haystack = f"{title}\n{text}"
    matched = sorted(set(query_keywords + [keyword for keyword in KEYWORDS if keyword in haystack]))
    amount = extract_amount(haystack)
    term = extract_term(haystack)
    counterparty = extract_counterparty(haystack)
    lease_role = "出租人" if re.search(r"作為出租人|作为出租人", haystack) else "承租人" if re.search(r"承租人", haystack) else "交易对手"
    related_party = "是" if re.search(r"關連交易|关联交易", haystack) else "未披露"
    guarantee = "提供担保" if re.search(r"擔保|担保", haystack) else "资产抵押" if re.search(r"抵押|質押|质押", haystack) else "未披露"
    risk_labels = []
    if re.search(r"售後回租|售后回租|售後租回|售后租回", haystack):
        risk_labels.append("售后回租")
    if related_party == "是":
        risk_labels.append("关联交易")
    if guarantee != "未披露":
        risk_labels.append(guarantee)
    if not re.search(r"利率|租賃利率|租赁利率", haystack):
        risk_labels.append("利率未披露")
    announcement_type = "售后回租" if "售后回租" in risk_labels else "融资租赁交易"
    snippets = build_snippets(title, text, matched)
    return {
        "id": item["id"],
        "subject_name": item["stock_name"],
        "subject_type": "港股上市公司",
        "stock_code": item["stock_code"],
        "bond_code": "",
        "region": "待补充",
        "industry": "待补充",
        "announcement_date": item["announcement_date"],
        "title": title,
        "source": "港交所披露易",
        "source_url": item["href"],
        "pdf_url": item["href"] if item["href"].lower().endswith(".pdf") else "",
        "matched_keywords": matched,
        "matched_position": "标题+正文" if text else "标题",
        "announcement_type": announcement_type,
        "lease_role": lease_role,
        "amount": amount or "未披露",
        "term": term or "未披露",
        "counterparty": counterparty or "未披露",
        "leased_asset": "未披露",
        "related_party": related_party,
        "guarantee_or_collateral": guarantee,
        "summary": summarize(item["stock_name"], announcement_type, amount, term, counterparty, lease_role),
        "risk_labels": sorted(set(risk_labels)),
        "review_status": "已复核官方公告" if text else ("待补充正文" if skip_pdf or pdf_error else "仅公告元数据"),
        "snippets": snippets,
        "attention_level": "B" if amount or related_party == "是" else "C",
        "notes": "；".join(part for part in ["披露易官方标题搜索", pdf_error] if part),
        "raw_payload": {**item, "_extractor_version": EXTRACTOR_VERSION},
    }


def extract_amount(text: str) -> str:
    patterns = [
        r"(?:融資金額|代價|本金|租賃付款|租赁付款)[^。；\n]{0,30}?([0-9,.]+)\s*(億港元|百萬港元|萬港元|港元|億元|萬元)",
        r"([0-9,.]+)\s*(億港元|百萬港元|萬港元|港元|億元|萬元)[^。；\n]{0,30}?(?:融資租賃|融资租赁|租賃付款)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return f"{match.group(1)}{match.group(2)}"
    return ""


def extract_term(text: str) -> str:
    match = re.search(r"(?:租賃期|租赁期|租賃期限|租赁期限)[^。；\n]{0,15}?([0-9]+(?:\.[0-9]+)?)\s*(年|個月|个月|月)", text)
    return f"{match.group(1)}{match.group(2)}" if match else ""


def extract_counterparty(text: str) -> str:
    patterns = [
        r"(?:承租人|出租人|賣方|卖方|交易對方|交易对方)[：:]\s*([^，。；\n]{2,60})",
        r"與([^，。；\n]{2,60}?(?:有限公司|租賃|租赁))(?:訂立|签订|簽訂)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return re.sub(r"\s+", "", match.group(1))[:60]
    return ""


def build_snippets(title: str, text: str, keywords: list[str]) -> list[str]:
    snippets = [f"[标题] {title}"]
    for keyword in keywords[:5]:
        index = text.find(keyword)
        if index >= 0:
            snippets.append(f"[正文] {text[max(0, index - 70):index + len(keyword) + 120]}")
    return snippets[:6]


def summarize(name: str, announcement_type: str, amount: str, term: str, counterparty: str, lease_role: str) -> str:
    parts = [f"{name}公告涉及{announcement_type}", f"角色为{lease_role}"]
    if amount:
        parts.append(f"金额{amount}")
    if term:
        parts.append(f"期限{term}")
    if counterparty:
        parts.append(f"交易对手为{counterparty}")
    return "，".join(parts) + "。"


def clean_field(value: str, prefix: str = "") -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if prefix and text.startswith(prefix):
        text = text[len(prefix):].strip()
    return text


def record_status(conn, record_id: str) -> str:
    row = conn.execute("select review_status from records where id=? limit 1", (record_id,)).fetchone()
    return str(row["review_status"] or "") if row else ""


def start_run(conn, start_date: str, end_date: str) -> int:
    cur = conn.execute(
        "insert into refresh_runs(source,start_date,end_date,status,message) values (?,?,?,?,?)",
        ("港交所披露易", start_date, end_date, "running", ""),
    )
    conn.commit()
    return int(cur.lastrowid)


def finish_run(conn, run_id: int, status: str, message: str, fetched: int, kept: int) -> None:
    conn.execute(
        "update refresh_runs set status=?, message=?, fetched_count=?, kept_count=?, finished_at=current_timestamp where id=?",
        (status, message, fetched, kept, run_id),
    )


if __name__ == "__main__":
    main()

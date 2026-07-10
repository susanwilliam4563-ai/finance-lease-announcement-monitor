from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from db import connect, upsert_record


QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
STATIC_ROOT = "https://static.cninfo.com.cn/"
DETAIL_URL = "https://www.cninfo.com.cn/new/disclosure/detail"

KEYWORDS = [
    "融资租赁",
    "融资性售后回租",
    "售后回租",
    "售后租回",
    "金融租赁",
    "融资租赁合同",
    "融资租赁业务",
    "租赁融资",
]

CONFIRM_TERMS = [
    "融资租赁",
    "售后回租",
    "售后租回",
    "融资性售后回租",
    "金融租赁",
    "融资租赁合同",
    "融资租赁业务",
    "承租人",
    "出租人",
    "租赁物",
    "租赁期限",
]

COLUMNS = ["szse", "sse", "bj"]
EXTRACTOR_VERSION = 2


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch CNINFO finance lease announcements.")
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--end", default=date.today().isoformat())
    parser.add_argument("--keywords", default=",".join(KEYWORDS))
    parser.add_argument("--sleep", type=float, default=0.25)
    parser.add_argument("--max-pages", type=int, default=0)
    parser.add_argument("--skip-pdf", action="store_true")
    parser.add_argument("--refresh-existing", action="store_true")
    args = parser.parse_args()

    keywords = [item.strip() for item in args.keywords.split(",") if item.strip()]
    conn = connect()
    run_id = start_run(conn, args.start, args.end)
    fetched = 0
    kept = 0
    seen: dict[str, dict] = {}
    try:
        for keyword in keywords:
            for column in COLUMNS:
                for item in query_keyword(keyword, column, args.start, args.end, args.sleep, args.max_pages):
                    fetched += 1
                    raw_id = str(item.get("announcementId") or stable_hash(item))
                    key = f"cninfo:{raw_id}"
                    bucket = seen.setdefault(key, {"item": item, "query_keywords": set()})
                    bucket["query_keywords"].add(keyword)
        for key, bucket in seen.items():
            existing_status, extractor_version = record_review_state(conn, key)
            extraction_is_current = extractor_version >= EXTRACTOR_VERSION
            if existing_status and not args.refresh_existing and (
                args.skip_pdf or (existing_status == "已复核官方公告" and extraction_is_current)
            ):
                continue
            record = build_record(key, bucket["item"], sorted(bucket["query_keywords"]), skip_pdf=args.skip_pdf)
            if record:
                upsert_record(conn, record)
                kept += 1
        finish_run(conn, run_id, "success", f"fetched={fetched} kept={kept}", fetched, kept)
        conn.commit()
        print(json.dumps({"status": "success", "fetched": fetched, "kept": kept}, ensure_ascii=False))
    except Exception as exc:
        finish_run(conn, run_id, "failed", str(exc), fetched, kept)
        conn.commit()
        raise


def query_keyword(keyword: str, column: str, start: str, end: str, sleep_seconds: float, max_pages: int):
    page = 1
    while True:
        payload = {
            "pageNum": str(page),
            "pageSize": "30",
            "column": column,
            "tabName": "fulltext",
            "plate": "",
            "stock": "",
            "searchkey": keyword,
            "secid": "",
            "category": "",
            "trade": "",
            "seDate": f"{start}~{end}",
            "sortName": "time",
            "sortType": "desc",
            "isHLtitle": "true",
        }
        data = post_form(QUERY_URL, payload)
        items = data.get("announcements") or []
        if not items:
            break
        for item in items:
            item["_query_column"] = column
            yield item
        total = int(data.get("totalAnnouncement") or 0)
        if page * 30 >= total:
            break
        if max_pages and page >= max_pages:
            break
        page += 1
        time.sleep(sleep_seconds)


def post_form(url: str, payload: dict) -> dict:
    body = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch",
            "Origin": "https://www.cninfo.com.cn",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def build_record(record_id: str, item: dict, query_keywords: list[str], skip_pdf: bool) -> dict | None:
    title = clean(item.get("announcementTitle") or "")
    stock_code = clean(item.get("secCode") or "")
    stock_name = clean(item.get("secName") or "")
    adjunct_url = item.get("adjunctUrl") or ""
    pdf_url = urllib.parse.urljoin(STATIC_ROOT, adjunct_url) if adjunct_url else ""
    announcement_id = str(item.get("announcementId") or record_id.split(":", 1)[-1])
    announcement_date = parse_date(item)
    source_url = f"{DETAIL_URL}?stockCode={stock_code}&announcementId={announcement_id}" if stock_code else pdf_url
    text = ""
    pdf_error = ""
    if pdf_url and not skip_pdf:
        try:
            text = extract_pdf_text(pdf_url)
        except Exception as exc:
            pdf_error = str(exc)
    haystack = f"{title}\n{text}\n{json.dumps(item, ensure_ascii=False)}"
    matched_keywords = [keyword for keyword in KEYWORDS if keyword in haystack]
    if query_keywords:
        matched_keywords = sorted(set(matched_keywords + query_keywords))
    if not query_keywords and not any(term in haystack for term in CONFIRM_TERMS):
        return None
    amount = first_match(haystack, [
        r"(?:融资(?:总额|金额|额度)?|合同金额|担保金额)[^，。；\n]{0,20}?不超过\s*([0-9,.]+)\s*(亿元|万元)",
        r"(?:融资(?:总额|金额|额度)?|合同金额|担保金额)[^，。；\n]{0,20}?([0-9,.]+)\s*(亿元|万元)",
        r"([0-9,.]+)\s*(亿元|万元)[^，。；\n]{0,24}?(?:融资租赁|售后回租|金融租赁|担保)",
    ])
    term = first_match(haystack, [
        r"(?:融资期限|租赁期限|租赁期|业务期限)[^，。；\n]{0,12}?([0-9]+(?:\.[0-9]+)?|[一二三四五六七八九十]+)\s*(年|个月|月)",
        r"期限为\s*([0-9]+(?:\.[0-9]+)?|[一二三四五六七八九十]+)\s*(年|个月|月)",
    ])
    counterparty = extract_counterparty(haystack)
    announcement_type = classify_type(title, haystack)
    lease_role = "担保方" if "担保" in title else "承租人"
    related_party = "是" if "关联交易" in haystack else "未披露"
    guarantee = "提供担保" if "担保" in haystack else ("资产抵押" if "抵押" in haystack or "质押" in haystack else "未披露")
    risk_labels = score_labels(title, haystack, amount, term, related_party, guarantee)
    level = score_level(risk_labels)
    matched_position = matched_where(title, text, matched_keywords)
    snippets = build_snippets(title, text, matched_keywords)
    return {
        "id": record_id,
        "subject_name": stock_name or "待识别主体",
        "subject_type": "A股上市公司",
        "stock_code": stock_code,
        "bond_code": "",
        "region": "待补充",
        "industry": "待补充",
        "announcement_date": announcement_date,
        "title": title,
        "source": "巨潮资讯",
        "source_url": source_url,
        "pdf_url": pdf_url,
        "matched_keywords": matched_keywords,
        "matched_position": matched_position,
        "announcement_type": announcement_type,
        "lease_role": lease_role,
        "amount": amount or "未披露",
        "term": term or "未披露",
        "counterparty": counterparty or "未披露",
        "leased_asset": "未披露",
        "related_party": related_party,
        "guarantee_or_collateral": guarantee,
        "summary": summarize(stock_name, announcement_type, amount, term, counterparty, related_party, guarantee),
        "risk_labels": risk_labels,
        "review_status": "已复核官方公告" if text else ("待补充正文" if pdf_error or skip_pdf else "仅公告元数据"),
        "snippets": snippets,
        "attention_level": level,
        "notes": pdf_error,
        "raw_payload": {**item, "_extractor_version": EXTRACTOR_VERSION},
    }


def extract_pdf_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read()
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    chunks = []
    for page in reader.pages[:20]:
        chunks.append(page.extract_text() or "")
    return clean("\n".join(chunks))[:50000]


def record_review_state(conn, record_id: str) -> tuple[str, int]:
    row = conn.execute(
        "select review_status, raw_payload from records where id=? limit 1",
        (record_id,),
    ).fetchone()
    if not row:
        return "", 0
    try:
        payload = json.loads(row["raw_payload"] or "{}")
        version = int(payload.get("_extractor_version") or 0)
    except (TypeError, ValueError, json.JSONDecodeError):
        version = 0
    return str(row["review_status"] or ""), version


def parse_date(item: dict) -> str:
    value = item.get("announcementTime") or item.get("announcementDate")
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000).date().isoformat()
    text = str(value or "")
    match = re.search(r"20\d{2}-\d{2}-\d{2}", text)
    return match.group(0) if match else date.today().isoformat()


def classify_type(title: str, text: str) -> str:
    if "售后回租" in text or "售后租回" in text:
        return "售后回租"
    if "担保" in title:
        return "担保公告"
    if "关联交易" in title:
        return "关联交易"
    return "融资租赁交易"


def score_labels(title: str, text: str, amount: str, term: str, related_party: str, guarantee: str) -> list[str]:
    labels = set()
    if "售后回租" in text or "售后租回" in text:
        labels.add("售后回租")
    if related_party == "是":
        labels.add("关联交易")
    if "子公司" in title or "孙公司" in title or "控股子公司" in title:
        labels.add("子公司承租")
    if "担保" in guarantee or "担保" in title:
        labels.add("对外担保")
    if "抵押" in text or "质押" in text:
        labels.add("资产抵押")
    if "亿元" in amount or re.search(r"[1-9][0-9]{4,}万元", amount):
        labels.add("大额融资")
    if term in {"12个月", "1年"}:
        labels.add("期限较短")
    if "利率" not in text:
        labels.add("利率未披露")
    return sorted(labels)


def score_level(labels: list[str]) -> str:
    score = 0
    for label in labels:
        score += {"售后回租": 2, "关联交易": 2, "对外担保": 2, "资产抵押": 2, "大额融资": 2}.get(label, 1)
    if score >= 6:
        return "A"
    if score >= 3:
        return "B"
    return "C"


def matched_where(title: str, text: str, keywords: list[str]) -> str:
    in_title = any(keyword in title for keyword in keywords)
    in_body = any(keyword in text for keyword in keywords)
    if in_title and in_body:
        return "标题+正文"
    if in_title:
        return "标题"
    if in_body:
        return "正文"
    return "元数据"


def build_snippets(title: str, text: str, keywords: list[str]) -> list[str]:
    snippets = []
    for keyword in keywords[:6]:
        if keyword in title:
            snippets.append(f"[标题] {title}")
        idx = text.find(keyword)
        if idx >= 0:
            start = max(0, idx - 70)
            end = min(len(text), idx + len(keyword) + 110)
            snippets.append(f"[正文] {text[start:end]}")
    return snippets[:6]


def summarize(name: str, announcement_type: str, amount: str, term: str, counterparty: str, related_party: str, guarantee: str) -> str:
    parts = [f"{name or '该主体'}公告涉及{announcement_type}"]
    if amount:
        parts.append(f"金额{amount}")
    if term:
        parts.append(f"期限{term}")
    if counterparty:
        parts.append(f"交易对手为{counterparty}")
    if related_party == "是":
        parts.append("构成关联交易")
    if guarantee != "未披露":
        parts.append(f"涉及{guarantee}")
    return "，".join(parts) + "。"


def extract_counterparty(text: str) -> str:
    patterns = [
        r"拟与([^，。；\n（）()]{2,40}?(?:融资租赁|金融租赁|租赁|银行|公司))",
        r"与([^，。；\n（）()]{2,40}?(?:融资租赁|金融租赁|租赁|银行|公司))(?:（以下简称[^）]{1,30}）|\(以下简称[^)]{1,30}\))?(?=开展|办理|签订|签署|合作|进行|通过)",
        r"与([^，。；\n]{2,40}?(?:融资租赁|金融租赁|租赁|银行|公司))(?=开展|办理|签订|签署|合作|进行|通过)",
        r"(?:出租人|交易对方|交易对手|债权人)[:：]\s*([^，。；\n]{2,40})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return re.sub(r"\s+", "", match.group(1)).split("以下简称")[0][:40]
    return ""


def first_match(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return f"{match.group(1)}{match.group(2) if len(match.groups()) > 1 else ''}"
    return ""


def clean(text: str) -> str:
    normalized = re.sub(r"\s+", " ", re.sub(r"</?em>", "", text or "")).strip()
    return re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", normalized)


def stable_hash(item: dict) -> str:
    return hashlib.sha1(json.dumps(item, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def start_run(conn, start_date: str, end_date: str) -> int:
    cur = conn.execute(
        "insert into refresh_runs(source,start_date,end_date,status,message) values (?,?,?,?,?)",
        ("巨潮资讯", start_date, end_date, "running", ""),
    )
    conn.commit()
    return int(cur.lastrowid)


def finish_run(conn, run_id: int, status: str, message: str, fetched: int, kept: int) -> None:
    conn.execute(
        "update refresh_runs set status=?, message=?, fetched_count=?, kept_count=?, finished_at=current_timestamp where id=?",
        (status, message, fetched, kept, run_id),
    )


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()

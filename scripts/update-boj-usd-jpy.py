"""Refresh the app's USD/JPY reference from the Bank of Japan daily release."""

import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from typing import TypedDict
from urllib.parse import urljoin

INDEX_URL = "https://www.boj.or.jp/statistics/market/forex/fxdaily/index.htm"
PDF_URL = re.compile(r"https://www\.boj\.or\.jp/statistics/market/forex/fxdaily/fxlist/fx([0-9]{6})\.pdf")
REPORT_DATE = re.compile(r"([0-9]{4})\s*年\s*([0-9]{1,2})\s*月\s*([0-9]{1,2})\s*日")
CENTRAL_RATE = re.compile(
    r"<\s*中心相場\s*>\s*(?:\(\s*Central rate\s*\)\s*)?"
    r"([0-9]{1,3}\.[0-9]{2})\s+(?=前営業日\s*出来高)"
)
REFERENCE_PATH = Path(__file__).resolve().parents[1] / "src/lib/boj-usd-jpy.json"


class Reference(TypedDict):
    yenPerDollar: float
    asOf: str
    source: str


def document_date(url: str) -> date:
    match = PDF_URL.fullmatch(url)
    if match is None:
        raise ValueError("Expected an official Bank of Japan daily PDF URL")
    digits = match[1]
    return date(2000 + int(digits[:2]), int(digits[2:4]), int(digits[4:]))


class DailyReports(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls: set[str] = set()

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for key, value in attrs:
                if key == "href" and value:
                    url = urljoin(INDEX_URL, value)
                    if PDF_URL.fullmatch(url):
                        self.urls.add(url)


def latest_document(html: str) -> tuple[date, str]:
    reports = DailyReports()
    reports.feed(html)
    reports.close()
    if not reports.urls:
        raise ValueError("The Bank of Japan index has no daily report links")
    url = max(reports.urls, key=document_date)
    return document_date(url), url


def parse_rate_text(text: str, published_on: date) -> float:
    normalized = unicodedata.normalize("NFKC", text)
    dates = REPORT_DATE.findall(normalized)
    if len(dates) != 1 or date(*map(int, dates[0])) != published_on:
        raise ValueError("The report date does not match its official PDF URL")
    rates = CENTRAL_RATE.findall(normalized)
    if len(rates) != 1 or float(rates[0]) <= 0:
        raise ValueError("Expected one positive USD/JPY central rate in the report")
    return float(rates[0])


def pdf_rate(pdf_bytes: bytes, published_on: date) -> float:
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("The Bank of Japan daily report is not a PDF")
    import pymupdf

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as report:
        if len(report) != 1 or report.needs_pass:
            raise ValueError("Expected a readable one-page Bank of Japan report")
        return parse_rate_text(report[0].get_text(sort=True), published_on)


def fetch_boj(url: str) -> bytes:
    return subprocess.run(
        [
            "curl", "-q", "--fail", "--silent", "--show-error", "--proto", "=https",
            "--connect-timeout", "5", "--max-time", "12", "--retry", "2",
            "--retry-max-time", "25", "--max-filesize", "1048576", "--", url,
        ],
        check=True, stdout=subprocess.PIPE, timeout=40,
    ).stdout


def read_reference(path: Path) -> Reference:
    saved = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(saved, dict) or set(saved) != {"asOf", "source", "yenPerDollar"}:
        raise ValueError("Invalid saved exchange rate")
    rate = saved["yenPerDollar"]
    if (
        type(rate) not in (int, float) or not 0 < rate < 1000
        or not isinstance(saved["source"], str)
        or saved["asOf"] != document_date(saved["source"]).isoformat()
    ):
        raise ValueError("Invalid saved exchange rate")
    return saved


def update_reference(path: Path, fetch=fetch_boj) -> bool:
    current = read_reference(path)
    published_on, url = latest_document(fetch(INDEX_URL).decode("utf-8"))
    if published_on.isoformat() < current["asOf"]:
        return False
    reference: Reference = {
        "yenPerDollar": pdf_rate(fetch(url), published_on),
        "asOf": published_on.isoformat(),
        "source": url,
    }
    if reference == current:
        return False
    # Validate before replacing the last successful snapshot on the same filesystem.
    with tempfile.TemporaryDirectory(dir=path.parent) as scratch:
        temporary = Path(scratch) / path.name
        temporary.write_text(json.dumps(reference, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    return True


def main() -> int:
    try:
        changed = update_reference(REFERENCE_PATH)
        rate = read_reference(REFERENCE_PATH)
    except (OSError, RuntimeError, ValueError, ImportError, subprocess.SubprocessError) as error:
        print(f"Bank of Japan rate update failed: {error}", file=sys.stderr)
        return 1
    action = "Updated" if changed else "Kept"
    print(f"{action} BOJ USD/JPY reference: {rate['asOf']} {rate['yenPerDollar']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

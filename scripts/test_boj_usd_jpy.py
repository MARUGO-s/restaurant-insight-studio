import importlib.util
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import Mock, patch

importer_spec = importlib.util.spec_from_file_location(
    "boj_usd_jpy", Path(__file__).with_name("update-boj-usd-jpy.py")
)
importer = importlib.util.module_from_spec(importer_spec)
importer_spec.loader.exec_module(importer)


def report_url(day: str, host: str = "www.boj.or.jp") -> str:
    return f"https://{host}/statistics/market/forex/fxdaily/fxlist/fx{day}.pdf"


def links(*urls: str) -> bytes:
    return "".join(f'<a href="{url}">PDF</a>' for url in urls).encode("utf-8")


class BankOfJapanParserTests(unittest.TestCase):
    def test_selects_latest_official_daily_pdf(self):
        page = links("./fxlist/fx261119.pdf", report_url("261118"),
                     report_url("261120", "example.com"))
        self.assertEqual(importer.latest_document(page.decode("utf-8")),
                         (date(2026, 11, 19), report_url("261119")))

    def test_rejects_index_without_official_daily_pdfs(self):
        with self.assertRaisesRegex(ValueError, "no daily report"):
            importer.latest_document(links(report_url("261119", "example.com")).decode())

    def test_extracts_only_the_usd_jpy_central_rate(self):
        layout = """2026年11月19日
        17:00時点      159.69–71
        レンジ          159.75
                        159.28
        ＜中心相場＞
              (Central rate)
                   １５９．５９

        前営業日出来高
        円インデックス 73.57
        """
        self.assertEqual(importer.parse_rate_text(layout, date(2026, 11, 19)), 159.59)
        with self.assertRaisesRegex(ValueError, "report date"):
            importer.parse_rate_text(layout, date(2026, 11, 20))
        with self.assertRaisesRegex(ValueError, "one positive"):
            importer.parse_rate_text(layout.replace("１５９．５９", "159.59 1.09"), date(2026, 11, 19))
        with self.assertRaisesRegex(ValueError, "one positive"):
            importer.parse_rate_text(layout.replace("１５９．５９", "0.00"), date(2026, 11, 19))

    def test_rejects_non_pdf_response(self):
        with self.assertRaisesRegex(ValueError, "not a PDF"):
            importer.pdf_rate(b"<html>not a report</html>", date(2026, 11, 19))


class BankOfJapanUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.path = Path(self.temp_dir.name) / "boj-usd-jpy.json"
        self.saved = {"yenPerDollar": 159.59, "asOf": "2026-11-19", "source": report_url("261119")}
        self.original = json.dumps(self.saved).encode("utf-8")
        self.path.write_bytes(self.original)

    def test_newer_date_is_published_even_when_the_rate_is_equal(self):
        latest = report_url("261120")
        fetch = Mock(side_effect=[links(latest), b"%PDF-new"])
        with patch.object(importer, "pdf_rate", return_value=159.59) as read_pdf:
            self.assertTrue(importer.update_reference(self.path, fetch))
        read_pdf.assert_called_once_with(b"%PDF-new", date(2026, 11, 20))
        self.assertEqual(importer.read_reference(self.path), {
            "yenPerDollar": 159.59, "asOf": "2026-11-20", "source": latest,
        })

    def test_same_date_correction_replaces_the_saved_rate(self):
        fetch = Mock(side_effect=[links(self.saved["source"]), b"%PDF-corrected"])
        with patch.object(importer, "pdf_rate", return_value=159.61):
            self.assertTrue(importer.update_reference(self.path, fetch))
        self.assertEqual(importer.read_reference(self.path), {**self.saved, "yenPerDollar": 159.61})

    def test_same_snapshot_keeps_the_file_untouched(self):
        fetch = Mock(side_effect=[links(self.saved["source"]), b"%PDF-same"])
        with patch.object(importer, "pdf_rate", return_value=159.59):
            self.assertFalse(importer.update_reference(self.path, fetch))
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_older_index_does_not_roll_back_the_reference(self):
        fetch = Mock(return_value=links(report_url("261118")))
        self.assertFalse(importer.update_reference(self.path, fetch))
        fetch.assert_called_once_with(importer.INDEX_URL)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_bad_report_leaves_the_reference_untouched(self):
        fetch = Mock(side_effect=[links(report_url("261120")), b"<html>error page</html>"])
        with self.assertRaisesRegex(ValueError, "not a PDF"):
            importer.update_reference(self.path, fetch)
        self.assertEqual(self.path.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()

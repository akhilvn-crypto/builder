"""Test-report building: Zephyr executions -> the ISO test-case workbook (one Executed-On/Result pair per execution, IST) and the test report.

A local mock of the Zephyr Scale Cloud v2 read endpoints stands in for the real service. The mock deliberately returns two items per page
whatever ``maxResults`` says, so paging is exercised. The workbooks are read back with openpyxl.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from helpers import PLUGIN, SCRIPTS

try:
    import openpyxl
except ImportError:  # the command asks the user before installing it; the tests need it
    openpyxl = None

SCRIPT = SCRIPTS / "zephyr-reports.py"
TOKEN = "zs-test-token-0123456789abcdef"
BASE = "https://api.test/v2"


def execution(i, case, cycle, status, when, by="acc-1", comment=None):
    return {"id": i, "testCase": {"self": f"{BASE}/testcases/RD-T{case}/versions/1", "id": 100 + case},
            "testCycle": {"self": f"{BASE}/testcycles/RD-R{cycle}", "id": 10 + cycle},
            "testExecutionStatus": {"self": f"{BASE}/statuses/{status}", "id": status}, "actualEndDate": when, "executedById": by,
            "comment": comment, "automated": True}


class Mock:
    def __init__(self):
        self.requests: list = []
        self.statuses = {1: "Not Executed", 2: "In Progress", 3: "Pass", 4: "Fail", 5: "Blocked"}
        self.cycles = [{"id": 11, "key": "RD-R1", "name": "Automation run yesterday"}, {"id": 12, "key": "RD-R2", "name": "Automation run today"}]
        self.cases = [
            {"id": 101, "key": "RD-T1", "name": "Login with valid user", "objective": "Source test case TC-1 (US-1-testcase.md)",
             "precondition": "<ul><li>A user exists</li><li>The app is open</li></ul>", "priority": {"id": 1}, "owner": {"accountId": "acc-9"}, "folder": {"id": 7}},
            {"id": 102, "key": "RD-T2", "name": "Cart total updates", "objective": "Verify the cart total after adding two items", "precondition": None,
             "priority": {"id": 2}, "owner": {"accountId": "acc-9"}},
            {"id": 103, "key": "RD-T3", "name": "Logout", "objective": "Source test case TC-3 (US-2-testcase.md)", "precondition": None, "priority": {"id": 1}},
        ]
        self.steps = {
            "RD-T1": [{"inline": {"description": "Open the login page", "testData": "Url: env:APP_URL", "expectedResult": ""}},
                      {"inline": {"description": "Sign in", "testData": "User: u1<br>Url: env:APP_URL", "expectedResult": "The dashboard is shown"}}],
            "RD-T2": [{"inline": {"description": "Add two items", "expectedResult": "<b>Expected results:</b><ul><li>Total is 5</li></ul>"}}],
        }
        self.links = {"RD-T1": [9001], "RD-T2": [9001, 9100], "RD-T3": [9002]}
        # yesterday (R1): all pass; today (R2): T1 pass, T2 fail, T3 only a placeholder. T3's pass is 20:00Z = 01:30 IST the next day.
        self.executions = [
            execution(1, 1, 1, 3, "2026-11-07T09:00:00Z"), execution(2, 2, 1, 3, "2026-11-07T09:05:00Z", by="acc-2"),
            execution(3, 3, 1, 3, "2026-11-07T20:00:00Z"),
            execution(4, 1, 2, 3, "2026-11-08T09:02:05Z", comment="Everything behaved as the test case describes."),
            execution(5, 2, 2, 4, "2026-11-08T09:03:00Z", by="acc-2", comment="<p>After adding the second item the cart total still showed 4.</p>"),
            execution(6, 3, 2, 1, None, by=None),
        ]
        self.fail_prefix: dict = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_port}/v2"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def writes(self):
        return [r for r in self.requests if r[0] != "GET"]

    def _handler(self):
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, payload=None):
                data = json.dumps(payload).encode() if payload is not None else b""
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _page(self, items, q):
                start = int((q.get("startAt") or ["0"])[0])
                chunk = items[start:start + 2]  # two per page, whatever maxResults asks for
                return self._send(200, {"startAt": start, "maxResults": 2, "total": len(items), "isLast": start + 2 >= len(items), "values": chunk})

            def _handle(self, method):
                u = urlparse(self.path)
                q = parse_qs(u.query)
                mock.requests.append((method, u.path))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self._send(401, {"message": f"bad token {TOKEN}"})
                for prefix, code in mock.fail_prefix.items():
                    if u.path.startswith("/v2" + prefix):
                        return self._send(code, {"message": "boom"})
                p = u.path[3:]
                parts = p.split("/")
                if p == "/healthcheck":
                    return self._send(200, {"status": "ok"})
                if p == "/projects":
                    return self._send(200, {"values": []})
                if p == "/projects/RD":
                    return self._send(200, {"id": 1, "key": "RD"})
                if p.startswith("/projects/"):
                    return self._send(404, {"message": "no"})
                if p == "/statuses":
                    return self._send(200, {"values": [{"id": i, "name": n} for i, n in mock.statuses.items()]})
                if p == "/priorities":
                    return self._send(200, {"values": [{"id": 1, "name": "High"}, {"id": 2, "name": "Normal"}]})
                if p == "/folders":
                    return self._send(200, {"values": [{"id": 6, "name": "Auth", "parentId": None}, {"id": 7, "name": "Login", "parentId": 6}]})
                if p == "/testcycles":
                    return self._page(mock.cycles, q)
                if p == "/testcases":
                    return self._page(mock.cases, q)
                if p == "/testexecutions":
                    return self._page(mock.executions, q)
                if parts[1] == "testcases" and len(parts) == 4 and parts[3] == "teststeps":
                    return self._page(mock.steps.get(parts[2], []), q)
                if parts[1] == "testcases" and len(parts) == 4 and parts[3] == "links":
                    return self._send(200, {"issues": [{"issueId": i, "type": "COVERAGE"} for i in mock.links.get(parts[2], [])]})
                return self._send(404, {"message": "unknown " + p})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            do_PUT = do_DELETE = do_POST

        return H


@unittest.skipUnless(openpyxl, "openpyxl is not installed")
class ReportTests(unittest.TestCase):
    def setUp(self):
        self.mock = Mock()
        self.addCleanup(self.mock.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        (self.root / "automation").mkdir()
        self.env = {"ZEPHYR_BASE_URL": self.mock.url, "ZEPHYR_API_TOKEN": TOKEN}
        records = {f"f::TC-{i}": {"caseId": f"TC-{i}", "zephyrKey": f"RD-T{i}", "projectKey": "RD", "storyKey": "RD-10" if i < 3 else "RD-11",
                                  "storyIssueId": 9001 if i < 3 else 9002} for i in (1, 2, 3)}
        self.write("test-design/state/zephyr-publishing.json", json.dumps({"version": 1, "records": records}))
        self.lookup = self.write("lookup.json", json.dumps({
            "users": {"acc-1": "Akhil V Nair", "acc-2": "Priya S", "acc-9": "Anju K U"},
            "issues": {"9001": {"key": "RD-10", "summary": "Shopping cart", "type": "Story"}, "9002": {"key": "RD-11", "summary": "Sign out", "type": "Story"},
                       "9100": {"key": "RD-99", "summary": "Cart total wrong", "type": "Bug"}}}))

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def cli(self, *args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith("ZEPHYR_")}
        e.update(self.env if env is None else env)
        proc = subprocess.run([sys.executable, str(SCRIPT), args[0], "--root", str(self.root), "--project", "RD", *map(str, args[1:])],
                              capture_output=True, text=True, encoding="utf-8", env=e)
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        return proc.returncode, out

    def fetch_and_build(self, *cycles, lookup=True, fetch_args=None):
        code, out = self.cli("fetch", *(fetch_args or sum((["--cycle", c] for c in cycles), [])))
        self.assertEqual(code, 0, out)
        code, out = self.cli("build", *(["--lookup-file", self.lookup] if lookup else []))
        self.assertEqual(code, 0, out)
        return out

    def book(self, out, which):
        return openpyxl.load_workbook(self.root / out["files"][which])

    def case_rows(self, ws):
        """Test-case sheet rows keyed by Test Case ID."""
        rows = {}
        for r in ws.iter_rows(min_row=2):
            if r[0].value and r[1].value:
                rows[r[0].value] = r
        return rows

    # ---- reading Zephyr

    def test_preflight_checks_zephyr_the_library_templates_and_the_output_folder(self):
        code, out = self.cli("preflight")
        self.assertEqual(code, 0, out)
        names = {c["check"] for c in out["checks"]}
        self.assertTrue({"zephyr", "openpyxl", "template", "output-folder"} <= names, names)
        self.assertTrue((self.root / "Test artifacts ISO").is_dir())
        code, out = self.cli("preflight", env={})
        self.assertEqual(code, 2)
        self.assertEqual(out["error"]["code"], "CONFIG_MISSING")

    def test_cycles_lists_activity_newest_first_and_follows_paging(self):
        code, out = self.cli("cycles")
        self.assertEqual(code, 0, out)
        self.assertEqual([c["key"] for c in out["cycles"]], ["RD-R2", "RD-R1"])
        r2 = out["cycles"][0]
        self.assertEqual((r2["executions"], r2["executed"]), (3, 2))  # the placeholder is not an execution
        self.assertEqual(r2["results"], {"PASS": 1, "FAIL": 1})
        self.assertEqual(r2["lastExecutedAt"], "08-11-2026 14:33:00 IST")
        self.assertGreater(self.mock.requests.count(("GET", "/v2/testexecutions")), 1)  # six executions, two per page

    def test_zephyr_is_only_ever_read(self):
        self.fetch_and_build("RD-R2")
        self.assertEqual(self.mock.writes(), [])

    def test_fetch_needs_a_cycle_and_rejects_unknown_or_empty_ones(self):
        code, out = self.cli("fetch")
        self.assertEqual(out["error"]["code"], "NO_CYCLE")
        code, out = self.cli("fetch", "--cycle", "RD-R77")
        self.assertEqual(out["error"]["code"], "CYCLE_NOT_FOUND")
        self.mock.cycles.append({"id": 13, "key": "RD-R3", "name": "Empty"})
        code, out = self.cli("fetch", "--cycle", "RD-R3")
        self.assertEqual((code, out["error"]["code"]), (4, "NO_EXECUTIONS"))

    def test_fetch_names_what_it_still_needs_from_jira(self):
        code, out = self.cli("fetch", "--cycle", "RD-R2")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["needsLookup"]["accountIds"], ["acc-1", "acc-2", "acc-9"])
        issue_ids = {str(i.get("issueId")) for i in out["needsLookup"]["issues"]}
        self.assertIn("9100", issue_ids)  # linked to RD-T2 but no key / type known
        self.assertEqual(out["testCases"], 3)

    # ---- the test-case workbook

    def test_each_execution_gets_a_date_time_in_ist_and_a_result_so_yesterday_and_today_sit_side_by_side(self):
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testCases")["Testcases"]
        head = {c.value: c.column_letter for c in ws[1] if c.value}
        self.assertEqual([c.value for c in ws[1]][:14][0], "Test Case ID")
        self.assertIn("Execution 1\nExecuted On\n(dd-mm-yyyy hh:mm:ss IST)", head)
        self.assertIn("Execution 2\nResult", head)
        self.assertNotIn("Execution 3\nResult", head)
        rows = self.case_rows(ws)
        t2 = {ws.cell(row=1, column=c.column).value.replace("\n", " "): c.value for c in rows["TC-2"] if c.value is not None}
        self.assertEqual(t2["Execution 1 Executed On (dd-mm-yyyy hh:mm:ss IST)"], "07-11-2026 14:35:00 IST")
        self.assertEqual(t2["Execution 1 Result"], "PASS")
        self.assertEqual(t2["Execution 2 Executed On (dd-mm-yyyy hh:mm:ss IST)"], "08-11-2026 14:33:00 IST")
        self.assertEqual(t2["Execution 2 Result"], "FAIL")
        self.assertEqual(rows["TC-2"][7].value, "FAIL")  # column H: the latest result
        self.assertEqual(rows["TC-2"][15].value, "REGRESSION: PASS (07-11-2026) -> FAIL (08-11-2026)")

    def test_the_ist_date_is_used_even_when_utc_is_still_the_day_before(self):
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testCases")["Testcases"]
        t3 = self.case_rows(ws)["TC-3"]
        self.assertEqual(t3[16].value, "08-11-2026 01:30:00 IST")  # 2026-11-07T20:00:00Z
        self.assertEqual(t3[12].value, "08-11-2026")

    def test_a_not_executed_placeholder_is_not_an_execution(self):
        out = self.fetch_and_build("RD-R2")
        t3 = self.case_rows(self.book(out, "testCases")["Testcases"])["TC-3"]
        self.assertEqual(t3[7].value, "PASS")           # its only real run
        self.assertIsNone(t3[18].value)                  # no second execution pair for it
        self.assertEqual(t3[15].value, "First execution (PASS)")

    def test_template_columns_are_filled_from_zephyr(self):
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testCases")["Testcases"]
        t1 = self.case_rows(ws)["TC-1"]
        v = [c.value for c in t1]
        self.assertEqual(v[1], "Login with valid user")
        self.assertIsNone(v[2])                          # the publisher's provenance line is not a description
        self.assertEqual(v[3], "1. A user exists\n2. The app is open")
        self.assertEqual(v[4], "1. Open the login page\n2. Sign in")
        self.assertEqual(v[5], "Url: env:APP_URL\nUser: u1")  # per-step data, each line once
        self.assertEqual(v[6], "2. The dashboard is shown")
        self.assertEqual(v[9], "Anju K U")               # Created By from the owner
        self.assertIsNone(v[10])                         # Reviewed By is a sign-off: left empty
        self.assertEqual(v[11], "Akhil V Nair")          # Executed By (latest)
        self.assertEqual(v[12], "07-11-2026\n08-11-2026")
        self.assertEqual(v[14], "RD-T1")
        self.assertEqual(self.case_rows(ws)["TC-2"][13].value, "RD-99")  # the defect linked to the case
        self.assertEqual(self.case_rows(ws)["TC-2"][6].value, "1. Total is 5")  # the publisher's "Expected results:" label is dropped

    def test_cases_are_grouped_under_their_story_in_blue_section_rows(self):
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testCases")["Testcases"]
        sections = [(r[0].row, r[0].value) for r in ws.iter_rows(min_row=2) if r[0].value and not r[1].value]
        self.assertEqual([s[1] for s in sections], ["RD-10 - Shopping cart", "RD-11 - Sign out"])
        merged = {str(m) for m in ws.merged_cells.ranges}
        self.assertIn(f"A{sections[0][0]}:C{sections[0][0]}", merged)
        self.assertEqual(ws.cell(row=sections[0][0], column=1).fill.fgColor.rgb, "FF4A86E8")

    def test_the_template_look_survives(self):
        out = self.fetch_and_build("RD-R2")
        wb = self.book(out, "testCases")
        self.assertEqual(wb.sheetnames, ["Document Control", "Version History", "Testcases", "Test Suite"])
        ws = wb["Testcases"]
        self.assertEqual(ws.freeze_panes, "D2")
        self.assertTrue(ws["A1"].font.b)
        self.assertEqual(ws["A3"].border.left.style, "thin")
        self.assertEqual(wb["Document Control"]["E7"].value, "ET/FQA02/A/05092023")  # the controlled document ID stays
        self.assertEqual(wb["Document Control"]["E6"].value, "Test Cases - RD")
        colours = {r.formula[0] for cf in ws.conditional_formatting for r in cf.rules if r.type == "cellIs"}
        self.assertTrue({'"PASS"', '"FAIL"'} <= colours)
        self.assertTrue(any("REGRESSION" in (r.formula[0] if r.formula else "") for cf in ws.conditional_formatting for r in cf.rules))
        self.assertTrue(ws.data_validations.dataValidation)

    def test_the_test_suite_sheet_has_one_block_per_cycle(self):
        out = self.fetch_and_build("RD-R1", "RD-R2")
        ws = self.book(out, "testCases")["Test Suite"]
        titles = [c.value for c in ws["A"] if c.value and str(c.value).startswith("TestSuite")]
        self.assertEqual(titles, ["TestSuite : Automation run yesterday (RD-R1)", "TestSuite : Automation run today (RD-R2)"])
        statuses = [c.value for c in ws["E"] if c.value in ("PASS", "FAIL", "PENDING")]
        self.assertEqual(statuses, ["PASS", "PASS", "PASS", "PASS", "FAIL", "PENDING"])

    # ---- the report workbook

    def test_the_report_has_a_block_per_cycle_and_the_templates_counters(self):
        out = self.fetch_and_build("RD-R1", "RD-R2")
        wb = self.book(out, "testReport")
        self.assertEqual(wb.sheetnames, ["Document Control", "Version History", "Report Template"])
        ws = wb["Report Template"]
        self.assertEqual(ws["F5"].value, '=COUNTIF($F$13:$F1001,"PASS")')  # the template's own range, as long as the rows fit
        self.assertEqual(ws["F10"].value, '=COUNTIF($F$13:$F1001,"BLOCKED")')
        self.assertEqual(ws["D3"].value, "Akhil V Nair, Priya S")
        self.assertIsNone(ws["D4"].value)                # "Overall testing by lead" is a sign-off
        self.assertEqual(ws["A13"].value, "TestSuite : ")
        self.assertEqual(ws["B13"].value, "Automation run yesterday (RD-R1)")
        self.assertEqual(ws["G13"].value, "Execution Date : 07-11-2026 to 08-11-2026")
        heads = [c.value for c in ws[14]][:7]
        self.assertEqual(heads, ["#", "User Story #", "User Story Description", "Test Cases/Test Scenarios", "Testcase #", "Status", "Comments"])
        # counts, as the workbook's formulas will compute them
        status = [c.value for c in ws["F"][14:] if c.value in ("PASS", "FAIL", "IN PROGRESS", "BLOCKED", "UNEXECUTED")]
        self.assertEqual(status, ["PASS", "PASS", "PASS", "PASS", "FAIL", "UNEXECUTED"])

    def test_a_failure_row_carries_story_defect_actual_result_and_the_regression_note(self):
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testReport")["Report Template"]
        row = next(r for r in ws.iter_rows(min_row=15) if r[4].value == "TC-2")
        self.assertEqual((row[1].value, row[2].value, row[3].value), ("RD-10", "Shopping cart", "Cart total updates"))
        self.assertEqual(row[5].value, "FAIL")
        self.assertIn("Defect: RD-99", row[6].value)
        self.assertIn("After adding the second item the cart total still showed 4.", row[6].value)
        self.assertIn("Regression: passed on 07-11-2026.", row[6].value)

    def test_the_report_totals_cover_every_row_even_in_a_big_project(self):
        self.mock.cases += [{"id": 200 + i, "key": f"RD-T{200 + i}", "name": f"Bulk {i}", "objective": "x"} for i in range(1100)]
        self.mock.executions += [execution(100 + i, 200 + i, 2, 3, "2026-11-08T10:00:00Z") for i in range(1100)]
        out = self.fetch_and_build("RD-R2")
        ws = self.book(out, "testReport")["Report Template"]
        last = max(c.row for c in ws["F"] if c.value)
        end = int(re.search(r"\$F(\d+),", ws["F5"].value).group(1))
        self.assertGreater(end, last)

    # ---- names, files and safety

    def test_without_a_lookup_people_are_left_empty_and_listed_never_invented(self):
        out = self.fetch_and_build("RD-R2", lookup=False)
        self.assertEqual(out["needsLookup"]["accountIds"], ["acc-1", "acc-2", "acc-9"])
        t1 = self.case_rows(self.book(out, "testCases")["Testcases"])["TC-1"]
        self.assertIsNone(t1[9].value)
        self.assertIsNone(t1[11].value)
        self.assertEqual(t1[13].value, None)             # no defect key is known, none is made up
        self.assertEqual(t1[0].value, "TC-1")            # the local publish state still gives the case its ID

    def test_a_bug_recorded_by_an_earlier_update_run_needs_no_lookup(self):
        self.write("automation/execution-results/archive/ER-1.json", json.dumps({"bugs": {"TC-2": {"key": "RD-98", "issueId": 9100, "state": "created"}}}))
        out = self.fetch_and_build("RD-R2", lookup=False)
        self.assertEqual(self.case_rows(self.book(out, "testCases")["Testcases"])["TC-2"][13].value, "RD-98")

    def test_files_land_under_test_artifacts_iso_and_a_rebuild_archives_instead_of_overwriting(self):
        out = self.fetch_and_build("RD-R2")
        self.assertEqual(out["folder"], "Test artifacts ISO")
        self.assertEqual(out["files"]["testCases"], "Test artifacts ISO/RD - Test Cases.xlsx")
        self.assertRegex(out["files"]["testReport"], r"^Test artifacts ISO/RD - Test Report - RD-R2 - \d\d-\d\d-\d{4}\.xlsx$")
        self.assertEqual(out["archived"], [])
        first = (self.root / out["files"]["testCases"]).read_bytes()
        again = self.fetch_and_build("RD-R2")
        self.assertEqual(len(again["archived"]), 2)
        for a in again["archived"]:
            self.assertIn("(replaced ", a)
            self.assertTrue((self.root / a).is_file())
        self.assertEqual(sorted(p.name for p in (self.root / "Test artifacts ISO").iterdir() if p.is_file()),
                         sorted([Path(out["files"]["testCases"]).name, Path(again["files"]["testReport"]).name]))
        self.assertTrue(first)

    def test_a_rebuild_keeps_the_sign_offs_people_typed_into_the_workbooks(self):
        out = self.fetch_and_build("RD-R2")
        cases_file, report_file = self.root / out["files"]["testCases"], self.root / out["files"]["testReport"]
        wb = openpyxl.load_workbook(cases_file)
        ws = wb["Testcases"]
        row = next(r for r in ws.iter_rows(min_row=2) if r[0].value == "TC-2")
        row[10].value = "Shally"
        wb.save(cases_file)
        wb = openpyxl.load_workbook(report_file)
        wb["Report Template"]["D4"].value = "Sanu"
        wb.save(report_file)
        again = self.fetch_and_build("RD-R2")
        self.assertEqual(again["testCases"]["reviewedByKept"], 1)
        self.assertTrue(again["report"]["leadSignOffKept"])
        rows = self.case_rows(self.book(again, "testCases")["Testcases"])
        self.assertEqual(rows["TC-2"][10].value, "Shally")
        self.assertIsNone(rows["TC-1"][10].value)
        self.assertEqual(self.book(again, "testReport")["Report Template"]["D4"].value, "Sanu")

    def test_a_new_execution_adds_a_pair_of_columns_on_the_next_build(self):
        out = self.fetch_and_build("RD-R2")
        self.assertEqual(out["testCases"]["executionColumnPairs"], 2)
        self.mock.executions.append(execution(7, 2, 2, 3, "2026-11-09T05:00:00Z", by="acc-1"))  # fixed, executed the day after
        out = self.fetch_and_build("RD-R2")
        self.assertEqual(out["testCases"]["executionColumnPairs"], 3)
        t2 = self.case_rows(self.book(out, "testCases")["Testcases"])["TC-2"]
        self.assertEqual(t2[15].value, "FIXED: FAIL (08-11-2026) -> PASS (09-11-2026)")
        self.assertEqual([c["kind"] for c in out["changesSincePrevious"]], ["fixed"])

    def test_the_build_reports_regressions_first(self):
        out = self.fetch_and_build("RD-R2")
        self.assertEqual([(c["testCase"], c["kind"]) for c in out["changesSincePrevious"]], [("TC-2", "regression")])
        self.assertIn("Reviewed By (test-case sheet)", out["leftBlankOnPurpose"])

    def test_unknown_zephyr_statuses_are_shown_as_written_with_a_warning(self):
        self.mock.statuses[6] = "Skipped by QA"
        self.mock.executions.append(execution(8, 1, 2, 6, "2026-11-08T12:00:00Z"))
        out = self.fetch_and_build("RD-R2")
        self.assertTrue(any("Skipped by QA" in w for w in out["warnings"]), out["warnings"])
        self.assertEqual(self.case_rows(self.book(out, "testCases")["Testcases"])["TC-1"][7].value, "SKIPPED BY QA")

    def test_the_output_folder_cannot_leave_the_project(self):
        self.fetch_and_build("RD-R2")
        outside = self.root.parent / "elsewhere"
        code, out = self.cli("build", "--out-dir", outside)
        self.assertEqual((code, out["error"]["code"]), (5, "OUTSIDE_PROJECT"))
        self.assertFalse(outside.exists())
        code, out = self.cli("build", "--lookup-file", self.lookup, "--out-dir", "Custom folder")  # inside the project is fine
        self.assertEqual(code, 0, out)
        self.assertEqual(out["folder"], "Custom folder")

    def test_build_needs_fetched_data_for_the_same_project(self):
        code, out = self.cli("build")
        self.assertEqual((code, out["error"]["code"]), (4, "FILE_MISSING"))

    def test_a_workbook_locked_by_excel_is_reported_and_nothing_is_lost(self):
        out = self.fetch_and_build("RD-R2")
        target = self.root / out["files"]["testCases"]
        before = target.read_bytes()
        real_replace = os.replace
        # simulate the lock: moving the existing file to the archive fails on Windows while Excel holds it open
        sys.path.insert(0, str(SCRIPTS))
        import importlib.util
        spec = importlib.util.spec_from_file_location("zr_under_test", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)

        def locked(src, dst):
            if Path(src) == target:
                raise PermissionError("locked")
            return real_replace(src, dst)
        mod.os.replace = locked
        try:
            with self.assertRaises(mod.ExecError) as cm:
                mod.install(target, self.root / "Test artifacts ISO" / "archive")
        finally:
            mod.os.replace = real_replace
        self.assertEqual(cm.exception.code, "FILE_IN_USE")
        self.assertEqual(target.read_bytes(), before)

    def test_the_token_never_reaches_a_file_or_the_output(self):
        out = self.fetch_and_build("RD-R2")
        for p in self.root.rglob("*"):
            if p.is_file() and p.suffix in (".json", ".jsonl"):
                self.assertNotIn(TOKEN, p.read_text(encoding="utf-8"), p.name)
        self.mock.fail_prefix["/testexecutions"] = 401
        code, out = self.cli("fetch", "--cycle", "RD-R2")
        self.assertEqual((code, out["error"]["code"]), (2, "AUTH"))


class TextHelpers(unittest.TestCase):
    """Zephyr keeps rich text as HTML and times in UTC; the workbooks want plain lines and IST."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        spec = importlib.util.spec_from_file_location("zr_helpers", SCRIPT)
        cls.m = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.m
        spec.loader.exec_module(cls.m)

    def test_html_becomes_plain_numbered_lines(self):
        self.assertEqual(self.m.html_text("<ul><li>A user exists</li><li>The app is open</li></ul>"), "1. A user exists\n2. The app is open")
        self.assertEqual(self.m.html_text("a<br>b &amp; c<p>d</p>"), "a\nb & c\nd")
        self.assertEqual(self.m.html_text(None), "")

    def test_expected_results_combine_per_step_and_overall_without_repeating_numbers(self):
        steps = [{"expectedResult": ""}, {"expectedResult": "The dashboard is shown<br><b>Expected results:</b><ul><li>A</li><li>B</li></ul>"}]
        self.assertEqual(self.m.expected_text(steps), "Step 2: The dashboard is shown\n1. A\n2. B")
        self.assertEqual(self.m.expected_text([{"expectedResult": "One"}, {"expectedResult": "Two"}]), "1. One\n2. Two")
        self.assertEqual(self.m.expected_text([]), "")

    def test_times_are_shown_in_ist_whatever_form_zephyr_sends(self):
        stamp = lambda v: self.m.ist_stamp(self.m.parse_ts(v))  # noqa: E731
        self.assertEqual(stamp("2026-11-08T09:02:05Z"), "08-11-2026 14:32:05 IST")
        self.assertEqual(stamp("2026-11-08T09:02:05.123+0000"), "08-11-2026 14:32:05 IST")
        self.assertEqual(stamp("2026-11-08T14:32:05+05:30"), "08-11-2026 14:32:05 IST")
        self.assertEqual(stamp("2026-11-07T20:00:00Z"), "08-11-2026 01:30:00 IST")  # already the next day in India
        self.assertEqual(stamp(None), "date not recorded")
        self.assertEqual(stamp("not a date"), "date not recorded")

    def test_zephyr_status_names_map_to_the_templates_words(self):
        c = self.m.canonical_status
        self.assertEqual([c(n)[0] for n in ("Pass", "Passed", "Fail", "In Progress", "Blocked", "Not Executed", None)],
                         ["PASS", "PASS", "FAIL", "IN PROGRESS", "BLOCKED", "NOT RUN", "NOT RUN"])
        self.assertEqual(c("Skipped by QA"), ("SKIPPED BY QA", False))


class ScriptShape(unittest.TestCase):
    def test_the_script_only_reads_zephyr_and_never_runs_tests_or_calls_jira(self):
        src = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("subprocess", src)
        self.assertNotIn("atlassian", src.lower())
        self.assertNotRegex(src, r'zp\.http\(cfg, "(POST|PUT|PATCH|DELETE)"')

    def test_the_bundled_templates_are_the_ones_the_script_looks_for(self):
        for name in ("testcases-template.xlsx", "test-report-template.xlsx"):
            self.assertTrue((PLUGIN / "templates" / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()

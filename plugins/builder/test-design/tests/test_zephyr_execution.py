"""Execution-result publishing: mapping, classification, Zephyr executions, bugs and links, recovery without duplicates.

A local mock of the Zephyr Scale Cloud v2 endpoints stands in for the real service (no credentials needed); the Jira connector is
simulated by calling bug-start / bug-record exactly as the command does after it creates an issue.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from helpers import SCRIPTS

SCRIPT = SCRIPTS / "zephyr-execution.py"
TOKEN = "zs-test-token-0123456789abcdef"
PIPELINE_RUN = "20261108-101500-abc123"


class Mock:
    """In-memory Zephyr Scale. ``fail`` maps 'METHOD path-prefix' -> list of status codes returned once each."""

    def __init__(self):
        self.requests: list = []
        self.fail: dict = {}
        self.projects = {"RD"}
        self.statuses = ["Not Executed", "In Progress", "Pass", "Fail", "Blocked"]
        self.statuses_supported = True
        self.cycles = {"RD-R1": {"id": 1, "key": "RD-R1", "name": "Sprint 1"}}
        self.executions: list = []
        self.attachments: list = []
        self.case_links: dict = {}
        self.cases = {f"RD-T{i}" for i in range(1, 10)}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_port}/v2"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def count(self, method, prefix):
        return sum(1 for m, p, _ in self.requests if m == method and p.startswith(prefix))

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

            def _handle(self, method):
                path = self.path.split("?")[0]
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                ctype = self.headers.get("Content-Type", "")
                body = json.loads(raw) if raw and ctype.startswith("application/json") else None
                mock.requests.append((method, path, body))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self._send(401, {"message": f"bad token {TOKEN}"})
                for k, codes in mock.fail.items():
                    m, _, prefix = k.partition(" ")
                    if m == method and path.startswith("/v2" + prefix) and codes:
                        return self._send(codes.pop(0), {"message": "boom"})
                p = path[3:]
                parts = p.split("/")
                if p == "/healthcheck":
                    return self._send(200, {"status": "ok"})
                if p == "/projects":
                    return self._send(200, {"values": []})
                if p.startswith("/projects/"):
                    return self._send(200, {"id": 1, "key": parts[2]}) if parts[2] in mock.projects else self._send(404, {"message": "no"})
                if p == "/statuses":
                    return self._send(200, {"values": [{"name": n} for n in mock.statuses]}) if mock.statuses_supported else self._send(404, {})
                if p == "/testcycles" and method == "GET":
                    return self._send(200, {"values": list(mock.cycles.values()), "isLast": True})
                if p == "/testcycles" and method == "POST":
                    key = f"RD-R{len(mock.cycles) + 1}"
                    mock.cycles[key] = {"id": 10 + len(mock.cycles), "key": key, "name": body["name"]}
                    return self._send(201, {"id": mock.cycles[key]["id"], "key": key})
                if parts[1] == "testcycles" and len(parts) == 3:
                    return self._send(200, mock.cycles[parts[2]]) if parts[2] in mock.cycles else self._send(404, {"message": "no"})
                if p == "/testexecutions" and method == "POST":
                    mock.executions.append(body)
                    return self._send(201, {"id": 500 + len(mock.executions)})
                if parts[1] == "testexecutions" and len(parts) == 4 and parts[3] == "attachments":
                    mock.attachments.append((parts[2], len(raw)))
                    return self._send(201, {"id": len(mock.attachments)})
                if parts[1] == "testcases" and len(parts) == 3:
                    return self._send(200, {"key": parts[2]}) if parts[2] in mock.cases else self._send(404, {"message": "no"})
                if parts[1] == "testcases" and len(parts) >= 4 and parts[3] == "links":
                    links = mock.case_links.setdefault(parts[2], [])
                    if len(parts) == 4:
                        return self._send(200, {"issues": [{"issueId": i} for i in links]})
                    links.append(body["issueId"])
                    return self._send(201, {})
                return self._send(404, {"message": "unknown"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        return H


def attempt(status="failed", message=None, attachments=(), duration=1200):
    return {"retry": 0, "status": status, "durationMs": duration, "attachments": [dict(name=n, contentType=c, path=p) for n, c, p in attachments],
            "errors": [{"message": message, "stack": "stack " + message, "location": {"file": "tests/a.spec.ts", "line": 5}}] if message else []}


def result(tid, outcome, project="chromium", attempts=None):
    return {"key": f"{tid}@{project}", "testId": tid, "title": f"title of {tid}", "file": "tests/a.spec.ts", "line": 3, "project": project,
            "outcome": outcome, "attempts": attempts if attempts is not None else [attempt("passed" if outcome == "passed" else "failed")]}


def failure(tid, category, confidence, by="heuristic", rationale=None, signals=("sig",)):
    return {"key": f"{tid}@chromium", "testId": tid, "category": category, "confidence": confidence, "classifiedBy": by, "rationale": rationale, "signals": list(signals)}


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.mock = Mock()
        self.addCleanup(self.mock.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        (self.root / "automation").mkdir()
        self.env = {"ZEPHYR_BASE_URL": self.mock.url, "ZEPHYR_API_TOKEN": TOKEN}
        records = {f"test-design/test-cases/US-1-testcase.md::TC-{i}": {"sourceFile": "test-design/test-cases/US-1-testcase.md", "caseId": f"TC-{i}",
                   "zephyrKey": f"RD-T{i}", "projectKey": "RD", "stages": {"created": True}} for i in range(1, 9) if i != 6}
        self.write("test-design/state/zephyr-publishing.json", json.dumps({"version": 1, "records": records}))
        self.shots = {}
        for name in ("shot.png", "run.webm"):
            p = self.root / "automation" / "test-results" / PIPELINE_RUN / "initial" / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"x" * 100)
        ev = lambda: [("screenshot", "image/png", f"test-results/{PIPELINE_RUN}/initial/shot.png"), ("video", "video/webm", f"test-results/{PIPELINE_RUN}/initial/run.webm")]
        self.tests = [
            result("TC-1", "passed"),
            result("TC-2", "failed", attempts=[attempt(message="Expected: 5 Received: 4", attachments=ev())]),
            result("TC-3", "failed", attempts=[attempt(message="locator not found")]),
            result("TC-4", "failed", attempts=[attempt(message="Expected: a Received: b")]),
            result("TC-5", "skipped", attempts=[attempt("skipped")]),
            result("TC-6", "passed"),
            result("TC-7", "failed", attempts=[attempt(message="net::ERR_CONNECTION_REFUSED")]),
            result("TC-8", "flaky", attempts=[attempt(message="first try failed"), attempt("passed")]),
        ]
        self.failures = [failure("TC-2", "application_defect", "high", "agent", "Cart total is wrong: shows 4, spec says 5"),
                         failure("TC-3", "script_defect", "medium"), failure("TC-4", "application_defect", "medium"),
                         failure("TC-7", "environment_issue", "high")]
        self.write("dependencies/runs/%s/execution-results.json" % PIPELINE_RUN, json.dumps(
            {"schemaVersion": 1, "runId": PIPELINE_RUN, "label": "initial", "executedAt": "2026-11-08T10:20:30.456Z", "runnerError": None, "tests": self.tests}))
        self.write("dependencies/runs/%s/failure-analysis.json" % PIPELINE_RUN, json.dumps(
            {"failures": self.failures, "blocked": []}))
        self.write("dependencies/runs/%s/test-specs.json" % PIPELINE_RUN, json.dumps({"specs": [
            {"id": "TC-2", "steps": [{"index": 1, "action": "Open the cart", "expected": None}, {"index": 2, "action": "Add item", "expected": "Total shows 5"}],
             "expectedResults": ["The cart total is 5"], "priority": "High", "preconditions": ["A user exists"]}]}))
        self.write("dependencies/runs/%s/manifest.json" % PIPELINE_RUN, json.dumps({"config": {"app": {"baseUrl": "https://app.test", "environment": "staging"}}}))
        self.scope_file = self.write("scope.json", json.dumps({"tests": [{"testId": f"TC-{i}"} for i in range(1, 9)]}))

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def cli(self, *args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith("ZEPHYR_")}
        e.update(self.env if env is None else env)
        proc = subprocess.run([sys.executable, str(SCRIPT), args[0], "--root", str(self.root), *map(str, args[1:])], capture_output=True, text=True, encoding="utf-8", env=e)
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        return proc.returncode, out

    def begin(self, *extra):
        code, out = self.cli("begin", "--project", "RD", "--cycle", "RD-R1", "--scope-file", self.scope_file, "--scope-text", "all of US-1", "--only-mapped", *extra)
        self.assertEqual(code, 0, out)
        return out

    def run_state(self):
        return json.loads((self.root / "automation" / "execution-results" / "execution-run.json").read_text(encoding="utf-8"))

    def history(self):
        p = self.root / "automation" / "execution-results" / "execution-history.jsonl"
        return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()]

    def captured(self):
        self.begin()
        code, out = self.cli("capture", "--pipeline-run", PIPELINE_RUN)
        self.assertEqual(code, 0, out)
        return out

    # ---- preflight / mapping / begin

    def test_preflight_checks_connectivity_project_and_status_names(self):
        code, out = self.cli("preflight", "--project", "RD")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["statuses"]["fail"], "Fail")
        self.mock.statuses = ["Not Executed", "Passed"]
        code, out = self.cli("preflight", "--project", "RD")
        self.assertEqual(code, 2)
        self.assertTrue(any("Pass" in e for e in out["errors"]), out["errors"])
        code, out = self.cli("preflight", "--project", "RD", "--status-pass", "Passed", "--status-fail", "Passed")
        self.assertEqual(code, 0, out)
        self.assertEqual(set(out["statuses"]), {"pass", "fail"})  # nothing else is ever sent, so nothing else is checked

    def test_preflight_stops_on_missing_configuration_and_unknown_project(self):
        code, out = self.cli("preflight", "--project", "RD", env={})
        self.assertEqual(code, 2)
        self.assertEqual(out["error"]["code"], "CONFIG_MISSING")
        code, out = self.cli("preflight", "--project", "ZZ")
        self.assertEqual(out["error"]["code"], "PROJECT_NOT_FOUND")

    def test_unverifiable_statuses_are_a_warning_not_a_failure(self):
        self.mock.statuses_supported = False
        code, out = self.cli("preflight", "--project", "RD")
        self.assertEqual(code, 0)
        self.assertTrue(out["warnings"])

    def test_mapping_comes_from_the_published_state_and_never_guesses(self):
        recs = json.loads((self.root / "test-design/state/zephyr-publishing.json").read_text())
        recs["records"]["other.md::TC-3"] = {"sourceFile": "other.md", "caseId": "TC-3", "zephyrKey": "RD-T9", "projectKey": "RD", "stages": {}}
        (self.root / "test-design/state/zephyr-publishing.json").write_text(json.dumps(recs))
        code, out = self.cli("map", "--project", "RD", "--tests", "TC-1,TC-3,TC-6,untagged:tests/a.spec.ts:x")
        self.assertEqual(code, 1)
        self.assertEqual(out["mapped"]["TC-1"], {"zephyrKey": "RD-T1", "source": "published-state"})
        kinds = {p["testId"]: p["problem"] for p in out["problems"]}
        self.assertEqual(kinds, {"TC-3": "ambiguous", "TC-6": "missing", "untagged:tests/a.spec.ts:x": "untagged"})

    def test_a_hand_mapping_is_verified_and_used_but_cannot_override_a_conflict(self):
        code, out = self.cli("map", "--project", "RD", "--tests", "TC-6", "--set", "TC-6=RD-T6")
        self.assertEqual((code, out["mapped"]["TC-6"]["source"]), (0, "manual"))
        code, out = self.cli("map", "--project", "RD", "--tests", "TC-6", "--set", "TC-6=RD-T99")
        self.assertEqual(out["error"]["code"], "NOT_FOUND")
        code, out = self.cli("map", "--project", "RD", "--tests", "TC-1", "--set", "TC-1=RD-T2")
        self.assertEqual(out["problems"][0]["problem"], "ambiguous")

    def test_begin_refuses_an_incomplete_mapping_and_creates_nothing(self):
        code, out = self.cli("begin", "--project", "RD", "--new-cycle", "Run 1", "--scope-file", self.scope_file, "--scope-text", "x")
        self.assertEqual(code, 2)
        self.assertEqual(out["error"]["code"], "MAPPING_INCOMPLETE")
        self.assertEqual(self.mock.count("POST", "/v2/testcycles"), 0)
        self.assertFalse((self.root / "automation/execution-results/execution-run.json").exists())

    def test_begin_creates_a_new_cycle_or_checks_an_existing_one(self):
        code, out = self.cli("begin", "--project", "RD", "--new-cycle", "Run 1", "--scope-file", self.scope_file, "--scope-text", "x", "--only-mapped")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["testCycle"]["key"], "RD-R2")
        self.assertEqual(out["scope"]["notRun"], ["TC-6"])
        code, out = self.cli("begin", "--project", "RD", "--cycle", "RD-R7", "--scope-file", self.scope_file, "--scope-text", "x", "--only-mapped")
        self.assertEqual(code, 2)  # an unfinished run exists
        self.assertEqual(out["error"]["code"], "RUN_IN_PROGRESS")

    def test_a_cycle_that_does_not_exist_is_refused(self):
        code, out = self.cli("begin", "--project", "RD", "--cycle", "RD-R7", "--scope-file", self.scope_file, "--scope-text", "x", "--only-mapped")
        self.assertEqual((code, out["error"]["code"]), (2, "NOT_FOUND"))

    def test_a_lost_cycle_create_reply_is_not_repeated(self):
        self.mock.fail["POST /testcycles"] = [500]
        code, out = self.cli("begin", "--project", "RD", "--new-cycle", "Run 1", "--scope-file", self.scope_file, "--scope-text", "x", "--only-mapped")
        self.assertEqual(code, 2)
        self.assertIn("resolve", out["error"]["message"])
        code, out = self.cli("capture", "--pipeline-run", PIPELINE_RUN)
        self.assertEqual(out["error"]["code"], "CYCLE_NOT_READY")
        code, out = self.cli("resolve", "--cycle", "RD-R1")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.mock.count("POST", "/v2/testcycles"), 1)

    # ---- classification

    def test_every_result_gets_the_right_zephyr_status_and_only_confirmed_defects_get_bugs(self):
        out = self.captured()
        plan = {p["key"].split("@")[0]: p for p in out["plan"]}
        self.assertEqual(plan["TC-1"]["zephyrStatus"], "Pass")
        self.assertEqual((plan["TC-2"]["label"], plan["TC-2"]["zephyrStatus"], plan["TC-2"]["bugEligible"]), ("application_defect", "Fail", True))
        self.assertEqual((plan["TC-3"]["label"], plan["TC-3"]["zephyrStatus"], plan["TC-3"]["bugEligible"]), ("automation_issue", None, False))
        self.assertEqual((plan["TC-4"]["label"], plan["TC-4"]["bugEligible"]), ("needs_investigation", False))
        self.assertEqual((plan["TC-5"]["label"], plan["TC-5"]["zephyrStatus"]), ("skipped", None))
        self.assertEqual((plan["TC-7"]["label"], plan["TC-7"]["bugEligible"]), ("infrastructure_issue", False))
        self.assertEqual((plan["TC-8"]["label"], plan["TC-8"]["zephyrStatus"]), ("flaky", None))
        sent = {k.split("@")[0] for k, r in self.run_state()["tests"].items() if r["execution"]["state"] == "pending"}
        self.assertEqual(sent, {"TC-1", "TC-2"})  # a pass and a confirmed defect: the only results Zephyr hears about
        withheld = {k.split("@")[0] for k, r in self.run_state()["tests"].items() if r["execution"]["state"] == "withheld"}
        self.assertEqual(withheld, {"TC-3", "TC-4", "TC-5", "TC-7", "TC-8"})
        self.assertNotIn("TC-6@chromium", [p["key"] for p in out["plan"] if p["zephyrKey"]])
        self.assertEqual(list(self.run_state()["bugs"]), ["TC-2"])

    def test_a_user_can_confirm_an_investigation_and_a_bug_follows(self):
        self.captured()
        code, out = self.cli("classify", "--test", "TC-4", "--category", "application_defect", "--confidence", "high", "--rationale", "Verified in the UI: wrong total")
        self.assertEqual((code, out["label"], out["zephyrStatus"], out["bugEligible"]), (0, "application_defect", "Fail", True))
        self.assertIn("TC-4", self.run_state()["bugs"])
        code, out = self.cli("classify", "--test", "TC-4", "--category", "script_defect", "--confidence", "high", "--rationale", "actually a locator")
        self.assertNotIn("TC-4", self.run_state()["bugs"])

    # ---- publishing

    def test_publish_sends_each_result_once_and_a_second_publish_sends_nothing(self):
        self.captured()
        code, out = self.cli("publish")
        self.assertEqual(code, 0, out)
        sent = {e["testCaseKey"]: e for e in self.mock.executions}
        self.assertEqual(len(self.mock.executions), 2)  # TC-1 passed, TC-2 is a confirmed defect; flaky / script / environment / skipped are withheld
        self.assertEqual(sorted(sent), ["RD-T1", "RD-T2"])
        self.assertEqual(sent["RD-T2"]["statusName"], "Fail")
        self.assertEqual(sent["RD-T2"]["testCycleKey"], "RD-R1")
        self.assertEqual(sent["RD-T2"]["actualEndDate"], "2026-11-08T10:20:30Z")
        self.assertEqual(sent["RD-T2"]["executionTime"], 1200)
        self.assertIn("Expected 5 but found 4.", sent["RD-T2"]["comment"])
        self.assertIn("Total shows 5", sent["RD-T2"]["comment"])
        self.assertIn("staging", sent["RD-T2"]["comment"])
        self.assertIn("Chromium", sent["RD-T2"]["comment"])
        self.assertIn("Ran this check in Chromium", sent["RD-T1"]["comment"])
        self.assertIn("Actual result:", sent["RD-T1"]["comment"])  # a pass records what was observed too
        self.assertEqual(len(self.mock.attachments), 2)
        code, out = self.cli("publish")
        self.assertEqual(code, 0)
        self.assertEqual(len(self.mock.executions), 2)
        self.assertEqual(len(self.mock.attachments), 2)
        self.assertEqual(out["publishing"]["notPublishedNoMapping"], 1)
        self.assertEqual(out["publishing"]["withheld"], 5)

    def test_a_pass_records_the_observed_result_hand_written_or_from_the_expected_results(self):
        self.captured()
        code, out = self.cli("narrate", "--test", "TC-1", "--actual", "The cart total read 5 after the second item was added.")
        self.assertEqual(code, 0, out)
        self.cli("publish")
        sent = {e["testCaseKey"]: e for e in self.mock.executions}
        self.assertIn("<b>Actual result:</b> The cart total read 5 after the second item was added.", sent["RD-T1"]["comment"])
        self.assertNotIn("Everything behaved", sent["RD-T1"]["comment"])

    def test_attachments_that_the_deployment_does_not_support_never_fail_the_result(self):
        self.mock.fail["POST /testexecutions/"] = [404, 404]
        self.captured()
        code, out = self.cli("publish")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["evidenceUpload"], "unsupported")
        self.assertEqual(out["publishing"]["published"], 2)
        self.assertTrue(all(e["state"] in ("unsupported",) for r in self.run_state()["tests"].values() for e in r["evidence"] if e["state"] != "skipped"))

    def test_a_server_error_blocks_that_result_and_it_is_never_created_twice(self):
        self.mock.fail["POST /testexecutions"] = [500]
        self.captured()
        code, out = self.cli("publish")
        self.assertEqual(code, 1)
        self.assertEqual(out["publishing"]["unknownOutcome"], 1)
        self.assertEqual(out["publishing"]["published"], 1)
        before = len(self.mock.executions)
        code, out = self.cli("publish")  # blocked results are not retried on their own
        self.assertEqual(len(self.mock.executions), before)
        blocked = next(k for k, r in self.run_state()["tests"].items() if r["execution"]["state"] == "blocked")
        code, out = self.cli("resolve", "--test", blocked, "--retry")
        self.assertEqual(code, 0, out)
        code, out = self.cli("publish")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.mock.executions), before + 1)

    def test_a_clean_failure_is_retried_and_published_results_are_kept(self):
        self.mock.fail["POST /testexecutions"] = [400]
        self.captured()
        code, out = self.cli("publish")
        self.assertEqual((code, out["publishing"]["failed"], out["publishing"]["published"]), (1, 1, 1))
        code, out = self.cli("publish")
        self.assertEqual((code, out["publishing"]["published"]), (0, 2))
        self.assertEqual(len(self.mock.executions), 2)

    def test_an_expired_token_stops_cleanly_and_the_rest_stays_pending(self):
        self.captured()
        code, out = self.cli("publish", env={**self.env, "ZEPHYR_API_TOKEN": "wrong-token-value"})
        self.assertEqual(code, 1)
        self.assertEqual(out["publishing"]["published"], 0)
        self.assertEqual(self.mock.executions, [])
        code, out = self.cli("publish")
        self.assertEqual(code, 0)

    # ---- bugs

    def test_bug_draft_is_built_from_recorded_facts_and_names_what_is_missing(self):
        self.captured()
        code, out = self.cli("bug-drafts")
        d = out["drafts"][0]
        self.assertEqual(d["testId"], "TC-2")
        self.assertEqual(d["summary"], "title of TC-2: Expected 5 but found 4")
        for text in ("1. Open the cart", "Total shows 5", "The cart total is 5", "Expected 5 but found 4.", "RD-T2", "RD-R1", "staging", "Before you start: A user exists",
                     "**Steps to reproduce**", "**Actual result**"):
            self.assertIn(text, d["description"])
        for robot in ("Marker", "Information not available", "Classified by", "Pipeline run", "Automation test ID", "Not available"):
            self.assertNotIn(robot, d["description"])
        self.assertEqual(d["priority"], "High")
        self.assertIn("build/version", d["notAvailable"])  # the person is told; the Jira text simply leaves it out
        self.assertEqual(d["labels"], [d["marker"]])
        self.assertTrue(d["marker"].startswith("ab-er-"))
        self.assertFalse(d["writtenByHand"])
        self.assertTrue(d["needsWriting"])

    def test_a_bug_without_a_spec_says_so_instead_of_inventing_steps(self):
        (self.root / f"dependencies/runs/{PIPELINE_RUN}/test-specs.json").write_text(json.dumps({"specs": []}))
        self.captured()
        d = self.cli("bug-drafts")[1]["drafts"][0]
        self.assertIn("See test case RD-T2 in Zephyr.", d["description"])
        self.assertNotIn("Expected result", d["description"])  # nothing recorded, so no section and no invented text
        self.assertIn("steps to reproduce", d["notAvailable"])
        self.assertIn("expected result", d["notAvailable"])
        self.assertIsNone(d["priority"])
        self.assertTrue(d["priorityNote"])

    def test_the_bug_is_created_once_and_linking_is_retried_without_a_second_bug(self):
        self.captured()
        self.cli("publish")
        self.assertEqual(self.cli("bug-start", "--test", "TC-2")[0], 0)
        self.assertEqual(self.cli("bug-start", "--test", "TC-2")[1]["error"]["code"], "BUG_EXISTS")  # an unknown-outcome creation is never repeated blindly
        code, out = self.cli("bug-drafts")
        self.assertEqual(out["drafts"], [])
        self.assertEqual(out["needsCheck"][0]["testId"], "TC-2")
        self.assertIn("labels =", out["needsCheck"][0]["message"])
        self.assertEqual(self.cli("bug-record", "--test", "TC-2", "--key", "RD-77", "--issue-id", "10077")[0], 0)
        self.mock.fail["POST /testcases/RD-T2/links"] = [500]
        code, out = self.cli("link-bugs")
        self.assertEqual(code, 1)
        self.assertEqual(out["details"][0]["link"]["state"], "failed")
        self.assertEqual(self.run_state()["bugs"]["TC-2"]["key"], "RD-77")
        code, out = self.cli("link-bugs")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.mock.case_links["RD-T2"], [10077])
        code, out = self.cli("link-bugs")  # nothing left to do
        self.assertEqual(self.mock.case_links["RD-T2"], [10077])
        self.assertEqual(self.cli("bug-record", "--test", "TC-2", "--key", "RD-78", "--issue-id", "1")[1]["error"]["code"], "BUG_EXISTS")

    def test_a_failed_bug_creation_can_be_retried_and_a_declined_bug_is_final(self):
        self.captured()
        self.cli("bug-start", "--test", "TC-2")
        self.assertEqual(self.cli("bug-failed", "--test", "TC-2", "--error", "required field missing")[0], 0)
        self.assertEqual([d["testId"] for d in self.cli("bug-drafts")[1]["drafts"]], ["TC-2"])  # a clean failure may be retried
        self.cli("classify", "--test", "TC-4", "--category", "application_defect", "--confidence", "high", "--rationale", "seen")
        self.assertEqual(self.cli("bug-decline", "--test", "TC-4", "--reason", "known issue")[0], 0)
        self.assertEqual([d["testId"] for d in self.cli("bug-drafts")[1]["drafts"]], ["TC-2"])

    def test_bugs_from_earlier_updates_are_offered_so_a_duplicate_can_be_avoided(self):
        self.captured()
        self.cli("publish")
        self.cli("bug-start", "--test", "TC-2")
        self.cli("bug-record", "--test", "TC-2", "--key", "RD-77", "--issue-id", "10077")
        self.cli("link-bugs")
        self.begin()  # the first update is complete, so it is archived and a new one starts
        self.cli("capture", "--pipeline-run", PIPELINE_RUN)
        draft = self.cli("bug-drafts")[1]["drafts"][0]
        self.assertEqual([b["bugKey"] for b in draft["previousBugs"]], ["RD-77"])

    # ---- report, history, archive

    def test_the_report_separates_execution_from_publishing_and_a_finished_run_is_archived_not_overwritten(self):
        self.captured()
        self.cli("publish")
        self.cli("bug-start", "--test", "TC-2")
        self.cli("bug-record", "--test", "TC-2", "--key", "RD-77", "--issue-id", "10077")
        self.cli("classify", "--test", "TC-4", "--category", "inconclusive", "--confidence", "low", "--rationale", "x")
        code, out = self.cli("report", "--write")
        self.assertEqual(code, 1)
        self.assertTrue(any("RD-77" in o for o in out["open"]))
        self.cli("link-bugs")
        code, out = self.cli("report", "--write")
        self.assertEqual((code, out["complete"]), (0, True))
        e = out["execution"]
        self.assertEqual((e["total"], e["passed"], e["failedApplication"], e["automationIssues"], e["infrastructureIssues"], e["flaky"], e["skipped"]), (8, 2, 1, 1, 1, 1, 1))
        self.assertEqual(out["bugs"]["linked"], 1)
        self.assertEqual(out["publishing"]["published"], 2)
        self.assertEqual(out["publishing"]["withheld"], 5)
        self.assertTrue((self.root / out["reportFile"]).is_file())
        self.assertTrue((self.root / out["htmlReportFile"]).is_file())
        first = self.run_state()["updateRunId"]
        self.begin()
        self.assertNotEqual(self.run_state()["updateRunId"], first)
        self.assertTrue((self.root / f"automation/execution-results/archive/{first}.json").is_file())
        events = [h["event"] for h in self.history()]
        for ev in ("run_begun", "captured", "execution_created", "bug_created", "bug_linked", "run_archived"):
            self.assertIn(ev, events)
        text = (self.root / "automation/execution-results/execution-history.jsonl").read_text()
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("Authorization", text)

    # ---- withheld results, plain-words text, HTML report

    def test_withheld_results_are_never_sent_but_stay_in_the_local_record(self):
        self.captured()
        self.cli("publish")
        self.assertEqual(sorted(e["testCaseKey"] for e in self.mock.executions), ["RD-T1", "RD-T2"])
        state = self.run_state()["tests"]
        for tid in ("TC-3", "TC-4", "TC-5", "TC-7", "TC-8"):
            rec = state[f"{tid}@chromium"]
            self.assertEqual(rec["execution"]["state"], "withheld", tid)
            self.assertIsNone(rec["zephyrStatus"])
            self.assertTrue(rec["reason"])
        self.assertEqual(self.cli("report")[1]["open"], ["bug for TC-2 (pending)"])  # holding results back is not an unfinished job; the bug still is

    def test_a_confirmed_investigation_moves_from_withheld_to_sent_and_back(self):
        self.captured()
        code, out = self.cli("classify", "--test", "TC-4", "--category", "application_defect", "--confidence", "high", "--rationale", "Checked in the UI: wrong total")
        self.assertEqual((code, out["sentToZephyr"], out["zephyrStatus"]), (0, True, "Fail"))
        code, out = self.cli("classify", "--test", "TC-4", "--category", "script_defect", "--confidence", "high", "--rationale", "it was the locator")
        self.assertEqual((code, out["sentToZephyr"]), (0, False))
        self.cli("classify", "--test", "TC-4", "--category", "application_defect", "--confidence", "high", "--rationale", "Checked again: wrong total")
        self.cli("publish")
        self.assertEqual(sorted(e["testCaseKey"] for e in self.mock.executions), ["RD-T1", "RD-T2", "RD-T4"])
        code, out = self.cli("classify", "--test", "TC-4", "--category", "script_defect", "--confidence", "high", "--rationale", "too late")
        self.assertEqual(out["error"]["code"], "ALREADY_PUBLISHED")

    def test_a_hand_written_account_reaches_the_zephyr_note_and_the_bug(self):
        self.captured()
        code, out = self.cli("narrate", "--test", "TC-2", "--actual", "After adding the second item the cart total still showed 4 instead of 5.",
                             "--summary", "Cart total does not update after adding a second item")
        self.assertEqual(code, 0, out)
        self.cli("publish")
        comment = next(e for e in self.mock.executions if e["testCaseKey"] == "RD-T2")["comment"]
        self.assertIn("After adding the second item the cart total still showed 4 instead of 5.", comment)
        self.assertNotIn("Expected 5 but found 4", comment)
        d = self.cli("bug-drafts")[1]["drafts"][0]
        self.assertEqual(d["summary"], "Cart total does not update after adding a second item")
        self.assertIn("**Actual result**\nAfter adding the second item", d["description"])
        self.assertTrue(d["writtenByHand"])
        self.assertIsNone(d["needsWriting"])
        self.assertEqual(self.cli("narrate", "--test", "TC-2", "--actual", "Changed my mind about what happened here")[1]["error"]["code"], "ALREADY_PUBLISHED")

    def test_text_that_looks_pasted_from_the_tool_is_refused(self):
        self.captured()
        for bad in ("Error: expect(locator).toHaveText(expected) failed", "Locator: getByTestId('total') did not match", "x", "Timeout 5000ms\nCall log: waiting for it"):
            code, out = self.cli("narrate", "--test", "TC-2", "--actual", bad)
            self.assertEqual(code, 2, bad)
            self.assertIn(out["error"]["code"], ("NARRATIVE_ROBOTIC", "NARRATIVE_EMPTY"))
        self.assertEqual(self.cli("narrate", "--test", "TC-2", "--summary", "first line\nsecond line is not a title")[1]["error"]["code"], "SUMMARY_FORMAT")
        self.assertEqual(self.run_state()["tests"]["TC-2@chromium"]["narrative"], {})

    def test_plain_error_rewrites_playwright_messages_without_inventing_anything(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("ze_under_test", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        pe = mod.plain_error
        self.assertEqual(pe('Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected string: "Total: 5"\n'
                            'Received string: "Total: 4"\nTimeout: 5000ms\n\nCall log:\n  - waiting for it'), 'Expected "Total: 5" but found "Total: 4".')
        self.assertEqual(pe("Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Saved')\nExpected: visible\nReceived: <element(s) not found>"),
                         "The element that should be on the page was not visible.")
        self.assertEqual(pe("\x1b[31mTest timeout of 30000ms exceeded.\x1b[39m"), "The page did not reach the expected state in time.")
        self.assertEqual(pe(None), "")
        self.assertFalse(mod.ROBOTIC.search(pe("Expected: 5 Received: 4")))

    def test_the_html_report_shows_every_result_including_the_ones_not_sent(self):
        msg = "locator <b>#save</b> not found" + " " + TOKEN
        self.tests[2]["attempts"] = [attempt(message=msg)]
        self.write("dependencies/runs/%s/execution-results.json" % PIPELINE_RUN, json.dumps(
            {"schemaVersion": 1, "runId": PIPELINE_RUN, "label": "initial", "executedAt": "2026-11-08T10:20:30.456Z", "runnerError": None, "tests": self.tests}))
        self.captured()
        self.cli("publish")
        code, out = self.cli("report", "--write")
        page = (self.root / out["htmlReportFile"]).read_text(encoding="utf-8")
        self.assertTrue(page.startswith("<!doctype html>"))
        for needle in ("Not sent to Zephyr (5)", "TC-3", "TC-4", "TC-5", "TC-7", "TC-8", "Script / test-data issue", "Environment issue", "Flaky", "Needs investigation",
                       "Skipped", "not recorded in Zephyr", "Sent</span> &middot; RD-T2", "All results", "Full error", "test-results/" + PIPELINE_RUN + "/initial/shot.png",
                       "reports/" + PIPELINE_RUN + "/initial/html/index.html", "locator &lt;b&gt;#save&lt;/b&gt; not found"):
            self.assertIn(needle, page, needle)
        self.assertNotIn("<b>#save</b>", page)  # the error text is escaped, never rendered
        self.assertNotIn(TOKEN, page)
        self.assertIn("5 result(s) were deliberately not sent", " ".join(out["recovery"]))

    def test_abandon_keeps_the_record_and_deletes_nothing_remote(self):
        self.captured()
        code, out = self.cli("abandon", "--reason", "wrong cycle")
        self.assertEqual(code, 0)
        self.assertTrue((self.root / "automation/execution-results/archive").is_dir())
        self.assertFalse((self.root / "automation/execution-results/execution-run.json").exists())

    def test_nothing_is_captured_when_the_runner_produced_no_results(self):
        self.begin()
        (self.root / f"dependencies/runs/{PIPELINE_RUN}/execution-results.json").write_text(json.dumps({"runnerError": "no report", "tests": []}))
        code, out = self.cli("capture", "--pipeline-run", PIPELINE_RUN)
        self.assertEqual((code, out["error"]["code"]), (2, "NOTHING_EXECUTED"))

    def test_a_second_pipeline_run_cannot_be_mixed_into_an_update(self):
        self.captured()
        self.write("dependencies/runs/other/execution-results.json", "{}")
        code, out = self.cli("capture", "--pipeline-run", "other")
        self.assertEqual(out["error"]["code"], "CAPTURE_EXISTS")


MOBILE_RUN = "20261109-101500-android-smoke"


class MobileExecutionTests(unittest.TestCase):
    """The same publishing flow for Maestro runs (--surface mobile): state under mobile-automation/, device facts in the notes, no tool words."""

    def setUp(self):
        self.mock = Mock()
        self.addCleanup(self.mock.stop)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        (self.root / "mobile-automation").mkdir()
        self.env = {"ZEPHYR_BASE_URL": self.mock.url, "ZEPHYR_API_TOKEN": TOKEN}
        records = {f"test-design/test-cases/US-1-testcase.md::TC-{i}": {"sourceFile": "test-design/test-cases/US-1-testcase.md", "caseId": f"TC-{i}",
                   "zephyrKey": f"RD-T{i}", "projectKey": "RD", "stages": {"created": True}} for i in range(1, 9) if i != 6}
        self.write("test-design/state/zephyr-publishing.json", json.dumps({"version": 1, "records": records}))
        self.rid = MOBILE_RUN
        self.shot = f"artifacts/{self.rid}/2-tc-2/screenshot-failed.png"
        for rel in (self.shot, f"artifacts/{self.rid}/2-tc-2/recording.mp4", f"artifacts/{self.rid}/1-tc-1/final.png", f"artifacts/{self.rid}/1-tc-1/recording.mp4"):
            self.write("mobile-automation/" + rel, "x" * 100)
        self.write_run(physical=True)
        self.write("mobile-automation/state/test-specs.json", json.dumps({"cases": [
            {"id": "TC-2", "title": "Cart total updates", "priority": "High", "preconditions": ["A user exists"],
             "steps": [{"n": 1, "text": "Open the cart"}, {"n": 2, "text": "Add a second item", "expected": "Total shows 5"}], "expected": ["The cart total is 5"]}]}))
        self.scope_file = self.write("scope.json", json.dumps({"tests": [{"testId": f"TC-{i}"} for i in (1, 2, 3, 4, 5, 7, 8)]}))

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def flow(self, tid, status, **extra):
        base = {"flow": f"flows/a/{tid.lower()}.yaml", "testCase": tid, "name": f"[{tid}] flow", "tags": ["smoke"], "status": status, "exitCode": 0 if status == "passed" else 1,
                "timedOut": False, "durationMs": 4200, "artifacts": []}
        base.update(extra)
        return base

    def failed(self, tid, category, confidence="low", reason="r", **extra):
        return self.flow(tid, "failed", category=category, confidence=confidence, needsConfirmation=confidence != "high", reason=reason, excerpt="last log line", **extra)

    def write_run(self, physical=True, status="completed", results=None):
        shot = [f"artifacts/{self.rid}/2-tc-2/screenshot-failed.png", f"artifacts/{self.rid}/2-tc-2/recording.mp4", f"artifacts/{self.rid}/2-tc-2/maestro.log"]
        results = results if results is not None else [
            self.flow("TC-1", "passed", artifacts=[f"artifacts/{self.rid}/1-tc-1/final.png", f"artifacts/{self.rid}/1-tc-1/recording.mp4"]),
            self.failed("TC-2", "application", reason="An expected outcome was not observed after the earlier steps succeeded.", artifacts=shot,
                        failedCommand={"name": "assert", "description": "Assert that \"Total: 5\" is visible", "message": "Assertion is false: \"Total: 5\" is visible", "source": "log"}),
            self.failed("TC-3", "automation", "medium", reason="The element the flow tried to use was not found on screen."),
            self.failed("TC-4", "application", "low", reason="An expected outcome was not observed."),
            self.failed("TC-5", "device", "high", reason="Maestro could not talk to the device."),
            self.flow("TC-7", "not_run", reason="Not run: the device became unavailable during the run."),
            self.flow("TC-8", "skipped", reason="ios-only flow, run is on android"),
        ]
        self.write(f"mobile-automation/reports/{self.rid}/run.json", json.dumps({
            "runId": self.rid, "status": status, "outcome": "failed", "finishedAt": "2026-11-09T10:20:30.456Z", "platform": "android", "environment": "staging",
            "device": {"id": "R5CT1234ABC", "model": "Pixel 7", "manufacturer": "Google", "osVersion": "14", "kind": "physical" if physical else "emulator", "physical": physical},
            "app": {"id": "com.example.app", "versionName": "2.3.1", "versionCode": "45"}, "maestro": {"version": "1.39.0"}}))
        self.write(f"mobile-automation/reports/{self.rid}/results.json", json.dumps(results))

    def cli(self, *args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith("ZEPHYR_")}
        e.update(self.env if env is None else env)
        proc = subprocess.run([sys.executable, str(SCRIPT), args[0], "--root", str(self.root), "--surface", "mobile", *map(str, args[1:])],
                              capture_output=True, text=True, encoding="utf-8", env=e)
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        return proc.returncode, out

    def begin(self):
        code, out = self.cli("begin", "--project", "RD", "--cycle", "RD-R1", "--scope-file", self.scope_file, "--scope-text", "smoke on android")
        self.assertEqual(code, 0, out)

    def captured(self, *extra, run_id=None):
        self.begin()
        code, out = self.cli("capture", "--run-id", run_id or self.rid, *extra)
        self.assertEqual(code, 0, out)
        return out

    def state(self):
        return json.loads((self.root / "mobile-automation" / "execution-results" / "execution-run.json").read_text(encoding="utf-8"))

    def test_results_land_in_the_mobile_folder_and_only_a_pass_and_a_confirmed_defect_are_sent(self):
        out = self.captured()
        self.assertTrue((self.root / "mobile-automation" / "execution-results" / "execution-run.json").is_file())
        self.assertFalse((self.root / "automation").exists())
        plan = {p["key"].split("@")[0]: p for p in out["plan"]}
        self.assertEqual(plan["TC-1"]["zephyrStatus"], "Pass")
        self.assertEqual((plan["TC-2"]["label"], plan["TC-2"]["zephyrStatus"], plan["TC-2"]["bugEligible"]), ("needs_investigation", None, False))  # a screen assertion needs a person's eyes
        self.assertEqual(plan["TC-3"]["label"], "automation_issue")
        self.assertEqual(plan["TC-5"]["label"], "infrastructure_issue")
        self.assertEqual((plan["TC-7"]["label"], plan["TC-7"]["zephyrStatus"]), ("skipped", None))
        self.assertIn("device became unavailable", plan["TC-7"]["reason"])
        self.assertEqual(plan["TC-8"]["label"], "skipped")
        self.assertEqual(self.state()["surface"], "mobile")
        self.assertEqual(self.state()["environment"]["device"], "Google Pixel 7")
        self.assertEqual(self.state()["environment"]["buildVersion"], "2.3.1 (build 45)")
        code, rep = self.cli("report")
        self.assertEqual(rep["execution"]["passed"], 1)
        self.assertEqual(rep["locations"]["mobileRun"], f"mobile-automation/reports/{self.rid}/")

    def test_a_confirmed_defect_is_sent_with_the_device_in_the_note_and_gets_a_bug_in_plain_words(self):
        self.captured()
        code, out = self.cli("classify", "--test", "TC-2", "--category", "application_defect", "--confidence", "high",
                             "--rationale", "Screenshot shows the cart total reading 4 after the second item", "--by", "agent")
        self.assertEqual(code, 0, out)
        code, out = self.cli("narrate", "--test", "TC-2", "--actual", "After adding the second item the cart total still showed 4 instead of 5.",
                             "--summary", "Cart total does not update after adding a second item")
        self.assertEqual(code, 0, out)
        code, out = self.cli("publish")
        self.assertEqual(code, 0, out)
        sent = {x["testCaseKey"]: x for x in self.mock.executions}
        self.assertEqual(set(sent), {"RD-T1", "RD-T2"})
        self.assertEqual(sent["RD-T2"]["statusName"], "Fail")
        note = sent["RD-T2"]["comment"]
        self.assertIn("Google Pixel 7", note)
        self.assertIn("Android 14", note)
        self.assertIn("2.3.1", note)
        self.assertIn("staging", note)
        self.assertIn("After adding the second item", note)
        for word in ("Maestro", "yaml", "tapOn", "assert", "TC-2", MOBILE_RUN, "emulator"):
            self.assertNotIn(word, note, word)
        # evidence: the failure screenshot and one recording for the defect, only a screenshot for the pass (no recording of a pass)
        self.assertEqual(len(self.mock.attachments), 3)
        code, drafts = self.cli("bug-drafts")
        d = drafts["drafts"][0]
        self.assertEqual(d["summary"], "Cart total does not update after adding a second item")
        body = d["description"]
        self.assertIn("- Device: Google Pixel 7", body)
        self.assertIn("- OS: Android 14", body)
        self.assertIn("- App: com.example.app", body)
        self.assertIn("`mobile-automation/" + self.shot + "`", body)
        self.assertNotIn("build/version", d["notAvailable"])
        self.assertEqual(d["labels"], [self.state()["bugs"]["TC-2"]["marker"]])
        for word in ("Maestro", "yaml", "Assertion is false"):
            self.assertNotIn(word, body, word)

    def test_without_a_hand_written_account_the_failed_step_is_rephrased_never_pasted(self):
        self.captured()
        self.cli("classify", "--test", "TC-2", "--category", "application_defect", "--confidence", "high", "--rationale", "screen shows 4", "--by", "agent")
        code, drafts = self.cli("bug-drafts")
        d = drafts["drafts"][0]
        self.assertIn('Expected "Total: 5" to be shown on the screen, but it was not.', d["description"])
        self.assertNotIn("Assertion is false", d["description"])
        self.assertIsNotNone(d["needsWriting"])

    def test_a_run_on_an_emulator_is_not_recorded_unless_it_is_explicitly_allowed(self):
        self.write_run(physical=False)
        out = self.captured()
        plan = {p["key"].split("@")[0]: p for p in out["plan"]}
        self.assertEqual((plan["TC-1"]["label"], plan["TC-1"]["zephyrStatus"]), ("not_physical_device", None))
        self.assertFalse(out["physicalDevice"])
        self.cli("abandon", "--reason", "retry")
        out = self.captured("--allow-emulator")
        self.assertEqual({p["key"].split("@")[0]: p for p in out["plan"]}["TC-1"]["zephyrStatus"], "Pass")
        self.cli("publish")
        self.assertIn("emulator/simulator", self.mock.executions[0]["comment"])

    def test_a_confirmation_survives_capturing_the_same_run_again(self):
        self.captured()
        self.cli("classify", "--test", "TC-2", "--category", "application_defect", "--confidence", "high", "--rationale", "screen shows 4", "--by", "agent")
        code, out = self.cli("capture", "--run-id", self.rid)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.state()["tests"]["TC-2@android"]["label"], "application_defect")
        code, out = self.cli("capture", "--run-id", "another-run")
        self.assertEqual(out["error"]["code"], "CAPTURE_EXISTS")

    def test_unusable_runs_are_refused_before_anything_is_recorded(self):
        self.begin()
        code, out = self.cli("capture", "--run-id", "nope")
        self.assertEqual(out["error"]["code"], "MOBILE_RUN_MISSING")
        self.write_run(status="running")
        code, out = self.cli("capture", "--run-id", self.rid)
        self.assertEqual(out["error"]["code"], "RUN_NOT_FINISHED")
        self.write_run(results=[self.flow("TC-7", "not_run", reason="x")])
        code, out = self.cli("capture", "--run-id", self.rid)
        self.assertEqual(out["error"]["code"], "NOTHING_EXECUTED")
        self.write_run(results=[self.flow("TC-1", "passed"), self.flow("TC-1", "passed")])
        code, out = self.cli("capture", "--run-id", self.rid)
        self.assertEqual(out["error"]["code"], "DUPLICATE_TEST_ID")
        code, out = self.cli("capture")
        self.assertEqual(out["error"]["code"], "RUN_REQUIRED")

    def test_text_that_looks_pasted_from_maestro_is_refused(self):
        self.captured()
        for text in ("Assertion is false: \"Total: 5\" is visible", "Element not found: Text Matching Regex: Pay", "The tapOn step failed", "flows/a/tc-2.yaml failed"):
            code, out = self.cli("narrate", "--test", "TC-2", "--actual", text)
            self.assertEqual(out["error"]["code"], "NARRATIVE_ROBOTIC", text)
        code, out = self.cli("narrate", "--test", "TC-2", "--actual", "The cart total still showed 4 after adding a second item.")
        self.assertEqual(code, 0, out)

    def test_the_html_report_names_the_device_links_the_mobile_report_and_lists_what_was_held_back(self):
        self.captured()
        self.cli("publish")
        code, rep = self.cli("report", "--write")
        page = (self.root / "mobile-automation" / "execution-results" / "reports" / f"{rep['updateRunId']}.html").read_text(encoding="utf-8")
        self.assertIn("<th>Device</th>", page)
        self.assertIn("<th>Maestro</th>", page)
        self.assertIn("Google Pixel 7 (Android)", page)
        self.assertIn(f"../../reports/{self.rid}/report.html", page)
        self.assertIn("Not sent to Zephyr", page)
        self.assertIn("TC-3", page)
        md = (self.root / "mobile-automation" / "execution-results" / "reports" / f"{rep['updateRunId']}.md").read_text(encoding="utf-8")
        self.assertIn("(mobile)", md)
        self.assertIn("| Maestro |", md)
        self.assertFalse((self.root / "automation").exists())


if __name__ == "__main__":
    unittest.main()

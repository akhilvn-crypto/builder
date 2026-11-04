"""Zephyr Scale publishing: file checks, mapping, safe retries, no duplicates, no secrets in output.

A local mock of the Zephyr Scale Cloud v2 endpoints stands in for the real service, so the whole HTTP
flow (create -> steps -> link, partial failure, retry) runs for real without credentials.
"""
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from helpers import FIXTURES, SCRIPTS, TempProject, case, td

SCRIPT = SCRIPTS / "zephyr-publish.py"
TOKEN = "zs-test-token-0123456789abcdef"


class Mock:
    """Minimal in-memory Zephyr Scale. ``fail`` maps 'METHOD path-prefix' -> list of status codes to return once each."""

    def __init__(self):
        self.cases: dict = {}
        self.requests: list = []
        self.fail: dict = {}
        self.auth_ok = True
        self.projects = {"RD"}
        self.seq = 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.url = f"http://127.0.0.1:{self.server.server_port}/v2"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def count(self, method, prefix):
        return sum(1 for m, p, _, _ in self.requests if m == method and p.startswith(prefix))

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
                body = None
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    body = json.loads(self.rfile.read(n))
                mock.requests.append((method, path, body, self.headers.get("Authorization")))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}" or not mock.auth_ok:
                    return self._send(401, {"message": f"bad token {TOKEN}"})
                for k, codes in mock.fail.items():
                    m, _, prefix = k.partition(" ")
                    if m == method and path.startswith("/v2" + prefix) and codes:
                        return self._send(codes.pop(0), {"message": "boom"})
                p = path[3:]
                if p == "/healthcheck":
                    return self._send(200, {"status": "ok"})
                if p == "/projects":
                    return self._send(200, {"values": []})
                if p.startswith("/projects/"):
                    key = p.split("/")[2]
                    return self._send(200, {"id": 1, "key": key}) if key in mock.projects else self._send(404, {"message": "no"})
                if p == "/testcases" and method == "POST":
                    mock.seq += 1
                    key = f"{body['projectKey']}-T{mock.seq}"
                    mock.cases[key] = {"body": body, "steps": [], "links": []}
                    return self._send(201, {"id": 100 + mock.seq, "key": key})
                parts = p.split("/")
                if len(parts) >= 4 and parts[1] == "testcases" and parts[2] in mock.cases:
                    c = mock.cases[parts[2]]
                    if parts[3] == "teststeps":
                        if method == "GET":
                            return self._send(200, {"total": len(c["steps"]), "values": c["steps"]})
                        c["steps"] += body["items"]
                        return self._send(201, {})
                    if parts[3] == "links" and len(parts) == 4:
                        return self._send(200, {"issues": [{"issueId": i} for i in c["links"]]})
                    if parts[3] == "links" and parts[4] == "issues":
                        c["links"].append(body["issueId"])
                        return self._send(201, {})
                return self._send(404, {"message": "unknown"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        return H


def cli(*args, env=None, cwd=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith("ZEPHYR_")}
    e.update(env or {})
    proc = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True,
                          encoding="utf-8", env=e, cwd=cwd)
    out = json.loads(proc.stdout) if proc.stdout.strip() else {}
    return proc.returncode, out, proc.stdout + proc.stderr


CASES = ("# Login\nUser Story ID: US-001\n\n"
         + case("TC-1", "Sign in", step="Enter {email} in the Email field",
                extra="Priority: High\nTags: smoke, ui test\n\n### Preconditions\n- An account exists\n\n### Test Data\n- email: env:USER_EMAIL\n- plan: Premium")
         + "\n" + case("TC-2", "Sign out", step="Click Sign out", expected='The page shows "Login"'))


class ZephyrBase(TempProject):
    def setUp(self):
        super().setUp()
        self.mock = Mock()
        self.addCleanup(self.mock.stop)
        self.file = self.write("test-design/test-cases/US-001-testcase.md", CASES)
        self.env = {"ZEPHYR_BASE_URL": self.mock.url, "ZEPHYR_API_TOKEN": TOKEN}

    def pub(self, *extra, file=None):
        return cli("publish", "--root", self.root, "--file", file or self.file, "--project", "RD",
                   "--story-key", "RD-7", "--story-issue-id", "10007", *extra, env=self.env)


class FileChecks(ZephyrBase):
    def test_valid_file(self):
        code, out, _ = cli("check-file", self.file)
        self.assertEqual((code, out["ok"], out["cases"], out["storyIds"]), (0, True, 2, ["US-001"]), out)

    def test_missing_file(self):
        code, out, _ = cli("check-file", self.root / "nope-testcase.md")
        self.assertEqual((code, out["error"]["code"]), (4, "FILE_MISSING"))

    def test_file_without_cases(self):
        f = self.write("test-design/test-cases/US-009-testcase.md", "# Login\nUser Story ID: US-009\n")
        code, out, _ = cli("check-file", f)
        self.assertEqual(code, 1)

    def test_unsupported_format_stops_publish(self):
        f = self.write("test-design/test-cases/US-002-testcase.md", "# Login\nUser Story ID: US-002\n\n## TC-1: x\n")
        code, out, _ = self.pub(file=f)
        self.assertEqual((code, out["error"]["code"]), (2, "FILE_INVALID"))
        self.assertEqual(self.mock.cases, {})


class Config(ZephyrBase):
    def test_missing_config_is_explained(self):
        code, out, _ = cli("check-config", "--root", self.root)
        self.assertEqual((code, out["error"]["code"]), (2, "CONFIG_MISSING"))

    def test_env_file_is_read_and_token_never_printed(self):
        self.write(".env", f"ZEPHYR_BASE_URL={self.mock.url}\nZEPHYR_API_TOKEN='{TOKEN}'  \n")
        code, out, raw = cli("check-config", "--root", self.root)
        self.assertEqual((code, out["tokenConfigured"]), (0, True))
        self.assertNotIn(TOKEN, raw)

    def test_data_center_url_is_refused(self):
        code, out, _ = cli("check-config", "--root", self.root,
                           env={"ZEPHYR_BASE_URL": "https://jira.corp.example/rest/atm/1.0", "ZEPHYR_API_TOKEN": "x"})
        self.assertEqual(out["error"]["code"], "DEPLOYMENT_UNSUPPORTED")

    def test_plain_http_to_remote_host_is_refused(self):
        code, out, _ = cli("check-config", "--root", self.root,
                           env={"ZEPHYR_BASE_URL": "http://api.example.com/v2", "ZEPHYR_API_TOKEN": "x"})
        self.assertEqual(out["error"]["code"], "BASE_URL_INSECURE")

    def test_zephyr_check_ok_bad_token_and_unknown_project(self):
        code, out, _ = cli("check-zephyr", "--root", self.root, "--project", "RD", env=self.env)
        self.assertEqual((code, out["ok"]), (0, True), out)
        code, out, _ = cli("check-zephyr", "--root", self.root, "--project", "ZZ", env=self.env)
        self.assertEqual(out["error"]["code"], "PROJECT_NOT_FOUND")
        code, out, raw = cli("check-zephyr", "--root", self.root, "--project", "RD",
                             env={**self.env, "ZEPHYR_API_TOKEN": "wrong-token-value"})
        self.assertEqual(out["error"]["code"], "AUTH")


class Mapping(ZephyrBase):
    def test_conversion(self):
        code, out, _ = cli("convert", self.file)
        c1, c2 = out["cases"]
        self.assertEqual(c1["testcase"]["name"], "Sign in")
        self.assertIn("An account exists", c1["testcase"]["precondition"])
        self.assertEqual(c1["testcase"]["labels"], ["smoke", "ui_test"])
        step = c1["steps"][0]["inline"]
        self.assertIn("email: env:USER_EMAIL", step["testData"])
        self.assertIn("plan: Premium", step["testData"])  # unused-by-steps data is kept, on step 1
        self.assertIn("Welcome", step["expectedResult"])  # overall expected results kept
        self.assertEqual([u["field"] for u in c1["unmapped"]], ["Priority", "Module"])
        self.assertEqual(c2["steps"][0]["inline"]["description"], "Click Sign out")

    def test_inline_expected_is_per_step(self):
        f = self.write("test-design/test-cases/US-003-testcase.md",
                       "# M\nUser Story ID: US-003\n\n## TC-9: t\n\n### Steps\n1. Open it\n2. Click Go -> Expected: Done shows\n")
        _, out, _ = cli("convert", f)
        s = out["cases"][0]["steps"]
        self.assertNotIn("expectedResult", s[0]["inline"])
        self.assertEqual(s[1]["inline"]["expectedResult"], "Done shows")


class Publishing(ZephyrBase):
    def test_happy_path_creates_steps_links_and_leaves_source_untouched(self):
        before = td.sha256_file(self.file)
        code, out, raw = self.pub()
        self.assertEqual(code, 0, out)
        self.assertEqual(out["summary"]["created"], 2)
        self.assertEqual(out["summary"]["linked"], 2)
        self.assertEqual([c["zephyrKey"] for c in out["cases"]], ["RD-T1", "RD-T2"])
        self.assertEqual(self.mock.cases["RD-T1"]["links"], [10007])
        self.assertEqual(len(self.mock.cases["RD-T1"]["steps"]), 1)
        self.assertEqual(self.mock.cases["RD-T1"]["body"]["projectKey"], "RD")
        self.assertEqual(td.sha256_file(self.file), before)
        self.assertTrue(all(a == f"Bearer {TOKEN}" for _, _, _, a in self.mock.requests))
        state = (self.root / "test-design/state/zephyr-publishing.json").read_text()
        audit = (self.root / "test-design/state/zephyr-publishing-audit.jsonl").read_text()
        for blob in (raw, state, audit):
            self.assertNotIn(TOKEN, blob)

    def test_rerun_creates_nothing_twice(self):
        self.pub()
        n = self.mock.count("POST", "/v2/testcases")
        code, out, _ = self.pub()
        self.assertEqual(code, 0)
        self.assertEqual(self.mock.count("POST", "/v2/testcases"), n)
        self.assertEqual(len(self.mock.cases), 2)
        self.assertEqual(out["summary"]["reused"], 2)

    def test_link_failure_keeps_key_and_retries_link_only(self):
        self.mock.fail["POST /testcases/RD-T1/links"] = [500]
        code, out, _ = self.pub()
        self.assertEqual(code, 1)
        first = out["cases"][0]
        self.assertEqual((first["status"], first["zephyrKey"]), ("created_not_linked", "RD-T1"))
        self.assertEqual(out["cases"][1]["status"], "linked")  # one failure does not stop the others
        code, out, _ = self.pub()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.mock.cases), 2)  # no duplicate
        self.assertEqual(self.mock.cases["RD-T1"]["links"], [10007])
        self.assertEqual(len(self.mock.cases["RD-T1"]["steps"]), 1)  # steps not added again

    def test_existing_link_is_not_duplicated(self):
        self.pub()
        state_path = self.root / "test-design/state/zephyr-publishing.json"
        st = json.loads(state_path.read_text())
        for r in st["records"].values():
            r["stages"].pop("linked")  # simulate a lost local record after a successful link
        state_path.write_text(json.dumps(st))
        self.pub()
        self.assertEqual(self.mock.cases["RD-T1"]["links"], [10007])

    def test_unknown_create_outcome_is_never_retried_blindly(self):
        self.mock.fail["POST /testcases"] = [500]
        code, out, _ = self.pub()
        self.assertEqual(out["cases"][0]["status"], "blocked")
        self.assertEqual(len(self.mock.cases), 1)  # TC-2 went through
        code, out, _ = self.pub()
        self.assertEqual(out["cases"][0]["status"], "blocked")  # still not recreated
        self.assertEqual(len(self.mock.cases), 1)
        code, out, _ = cli("resolve", "--root", self.root, "--file", self.file, "--case", "TC-1", "--retry")
        self.assertEqual(code, 0)
        code, out, _ = self.pub()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(self.mock.cases), 2)

    def test_rejected_create_is_a_clean_failure_and_retryable(self):
        self.mock.fail["POST /testcases"] = [400]
        code, out, _ = self.pub()
        self.assertEqual(out["cases"][0]["status"], "failed")
        code, out, _ = self.pub()
        self.assertEqual(code, 0, out)

    def test_bad_token_stops_before_any_write(self):
        self.mock.auth_ok = False
        code, out, raw = self.pub()
        self.assertEqual(out["error"]["code"], "AUTH")
        self.assertEqual(self.mock.count("POST", "/v2/testcases"), 0)
        self.assertNotIn(TOKEN, raw)

    def test_unknown_project_stops_before_any_write(self):
        self.mock.projects = set()
        code, out, _ = self.pub()
        self.assertEqual(out["error"]["code"], "PROJECT_NOT_FOUND")
        self.assertEqual(self.mock.count("POST", "/v2/testcases"), 0)

    def test_dependency_needs_a_decision(self):
        f = self.write("test-design/test-cases/US-004-testcase.md",
                       "# M\nUser Story ID: US-004\n\n" + case("TC-A", "First") + "\n"
                       + case("TC-B", "Second", step="Open b", extra="Depends on: TC-A"))
        code, out, _ = self.pub(file=f)
        statuses = {c["id"]: c["status"] for c in out["cases"]}
        self.assertEqual(statuses, {"TC-A": "linked", "TC-B": "blocked"})
        code, out, _ = self.pub("--accept-unmapped", "Depends on", file=f)
        self.assertEqual(code, 0, out)

    def test_story_must_belong_to_project(self):
        code, out, _ = cli("publish", "--root", self.root, "--file", self.file, "--project", "RD",
                           "--story-key", "XX-1", "--story-issue-id", "1", env=self.env)
        self.assertEqual(out["error"]["code"], "STORY_PROJECT_MISMATCH")

    def test_case_is_not_republished_to_another_project(self):
        self.pub()
        self.mock.projects.add("QA")
        code, out, _ = cli("publish", "--root", self.root, "--file", self.file, "--project", "QA",
                           "--story-key", "QA-1", "--story-issue-id", "5", env=self.env)
        self.assertEqual(out["cases"][0]["status"], "failed")
        self.assertEqual(len(self.mock.cases), 2)

    def test_dry_run_needs_no_credentials_and_sends_nothing(self):
        code, out, _ = cli("publish", "--root", self.root, "--file", self.file, "--project", "RD",
                           "--story-key", "RD-7", "--story-issue-id", "10007", "--dry-run")
        self.assertEqual((code, out["cases"][0]["action"]), (0, "would-create"))
        self.assertEqual(self.mock.requests, [])
        self.assertFalse((self.root / "test-design/state/zephyr-publishing.json").exists())

    def test_status_lists_records(self):
        self.pub()
        _, out, _ = cli("status", "--root", self.root)
        self.assertEqual([r["zephyrKey"] for r in out["records"]], ["RD-T1", "RD-T2"])


if __name__ == "__main__":
    unittest.main()

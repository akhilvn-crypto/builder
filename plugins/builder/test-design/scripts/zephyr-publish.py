#!/usr/bin/env python3
"""Publish one saved test-case file to Zephyr Scale (Cloud, REST API v2) and link each case to a Jira story.

This tool is independent of test-case generation. It never edits the Markdown file, never deletes or
overwrites a remote test case, and never prints or stores the API token. Jira is *not* contacted here:
the command (``commands/publish-zephyr.md``) uses the existing Jira connector for project listing, issue
validation and the numeric issue ID, then passes ``--story-key`` / ``--story-issue-id`` to ``publish``.

    zephyr-publish.py check-file   FILE
    zephyr-publish.py check-config --root R
    zephyr-publish.py check-zephyr --root R --project KEY
    zephyr-publish.py convert      FILE                          (offline preview of what would be sent)
    zephyr-publish.py publish      --root R --file FILE --project KEY --story-key K --story-issue-id N
                                   [--accept-unmapped FIELD ...] [--dry-run]
    zephyr-publish.py status       --root R [--file FILE]
    zephyr-publish.py resolve      --root R --file FILE --case ID (--key ZEPHYR-KEY | --retry)

Configuration (process environment first, then ``<root>/.env``)::

    ZEPHYR_BASE_URL=https://api.zephyrscale.smartbear.com/v2
    ZEPHYR_API_TOKEN=...            # sent as "Authorization: Bearer"

State (inside ``<root>/test-design/state/``): ``zephyr-publishing.json`` maps every source case to its
Zephyr key and the stages completed (created / steps / linked); ``zephyr-publishing-audit.jsonl`` is an
append-only event log. A retry reads them and never creates a case twice.

Exit codes: 0 ok, 1 findings or some cases not fully published, 2 usage/configuration, 4 missing,
5 outside the output folder, 6 I/O.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402

STATE_NAME = "zephyr-publishing.json"
AUDIT_NAME = "zephyr-publishing-audit.jsonl"
STATE_VERSION = 1
TIMEOUT = 30
MAX_RETRIES_429 = 3
NAME_LIMIT = 255
# Source fields with no Zephyr Scale counterpart in the case-creation API.
INFORMATIONAL_UNMAPPED = ("Priority", "Module")
DECISION_UNMAPPED = ("Depends on",)  # changes how the test must be run, so the user decides


# --------------------------------------------------------------------------- errors / redaction

class PublishError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = td.EXIT_USAGE):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code


class ZephyrError(Exception):
    """An HTTP or network failure. ``ambiguous`` means a write may or may not have happened."""

    def __init__(self, code: str, message: str, status: Optional[int] = None, ambiguous: bool = False):
        super().__init__(message)
        self.code, self.status, self.ambiguous = code, status, ambiguous


def redact(text: str, cfg: Optional["Config"] = None) -> str:
    if cfg and cfg.token:
        text = text.replace(cfg.token, "***")
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}", r"\1***", text)
    return text


# --------------------------------------------------------------------------- configuration

class Config:
    def __init__(self, base_url: str, token: str, source: dict):
        self.base_url, self.token, self.source = base_url, token, source

    def public(self) -> dict:
        return {"baseUrl": self.base_url, "tokenConfigured": bool(self.token), **self.source}


def parse_env_file(path: Path) -> dict:
    out: dict = {}
    for raw in td.read_text(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        out[key.strip()] = value
    return out


def _env_file_ignored(root: Path, env_path: Path) -> Optional[bool]:
    """True/False when git can tell, None when the root is not a git repository or git is missing."""
    try:
        r = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", str(env_path)],
                           capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode == 0:
        return True
    if r.returncode == 1:
        return False
    return None


def validate_base_url(url: str) -> str:
    u = urllib.parse.urlparse(url)
    local = (u.hostname or "") in ("localhost", "127.0.0.1", "::1")
    if u.scheme != "https" and not (u.scheme == "http" and local):
        raise PublishError("BASE_URL_INSECURE",
                           "ZEPHYR_BASE_URL must start with https:// (the API token is sent with every request).")
    if not u.hostname or u.username or u.password:
        raise PublishError("BASE_URL_INVALID",
                           "ZEPHYR_BASE_URL must be a plain URL like https://api.zephyrscale.smartbear.com/v2 "
                           "(no user name or password inside it).")
    if "/rest/atm" in u.path or "/rest/tests" in u.path:
        raise PublishError("DEPLOYMENT_UNSUPPORTED",
                           "This looks like a Zephyr Scale Data Center / Server URL (/rest/atm/...). Only the Zephyr "
                           "Scale Cloud REST API v2 is supported by this command. No data was sent.")
    return url.rstrip("/")


def load_config(root: Path) -> Config:
    env_path = Path(root) / ".env"
    file_vals = parse_env_file(env_path) if env_path.is_file() else {}
    src = {}
    vals = {}
    for key in ("ZEPHYR_BASE_URL", "ZEPHYR_API_TOKEN"):
        if os.environ.get(key):
            vals[key], src[key] = os.environ[key], "environment"
        elif file_vals.get(key):
            vals[key], src[key] = file_vals[key], ".env"
    missing = [k for k in ("ZEPHYR_BASE_URL", "ZEPHYR_API_TOKEN") if k not in vals]
    if missing:
        raise PublishError("CONFIG_MISSING",
                           f"{' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} not set. Add "
                           f"{'it' if len(missing) == 1 else 'them'} to {env_path} (make sure that file is git-ignored) "
                           "or to your environment. Create the token in Jira: your profile > Zephyr Scale API Access Tokens.")
    return Config(validate_base_url(vals["ZEPHYR_BASE_URL"]), vals["ZEPHYR_API_TOKEN"],
                  {"sources": src, "envFile": str(env_path) if env_path.is_file() else None})


# --------------------------------------------------------------------------- HTTP

def http(cfg: Config, method: str, path: str, body: Any = None, query: Optional[dict] = None) -> tuple[int, Any]:
    url = cfg.base_url + path + (("?" + urllib.parse.urlencode(query)) if query else "")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {cfg.token}", "Accept": "application/json",
               "User-Agent": "builder/zephyr-publish"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    is_write = method.upper() != "GET"
    for attempt in range(MAX_RETRIES_429 + 1):
        req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                return resp.status, _json_or_none(raw)
        except urllib.error.HTTPError as e:
            raw = e.read()
            if e.code == 429 and attempt < MAX_RETRIES_429:  # nothing was processed; safe to wait and retry
                time.sleep(min(int(e.headers.get("Retry-After", "2") or 2), 60))
                continue
            raise _http_error(cfg, e.code, _json_or_none(raw), is_write)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise ZephyrError("NETWORK", f"Could not reach Zephyr Scale: {redact(str(reason), cfg)}",
                              ambiguous=is_write)
    raise ZephyrError("RATE_LIMITED", "Zephyr Scale kept answering 'too many requests'. Wait a minute and run the command again.", 429)


def _json_or_none(raw: bytes) -> Any:
    if not raw.strip():
        return None
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None


def _http_error(cfg: Config, status: int, payload: Any, is_write: bool) -> ZephyrError:
    detail = ""
    if isinstance(payload, dict):
        detail = str(payload.get("message") or payload.get("errorMessage") or "")
    detail = redact(detail, cfg)[:300]
    suffix = f": {detail}" if detail else ""
    if status == 401:
        return ZephyrError("AUTH", "Zephyr Scale rejected the API token (401). It may be wrong, expired or revoked. "
                           "Generate a new token and update ZEPHYR_API_TOKEN.", status)
    if status == 403:
        return ZephyrError("FORBIDDEN", f"Zephyr Scale says this token is not allowed to do that (403){suffix}", status)
    if status == 404:
        return ZephyrError("NOT_FOUND", f"Zephyr Scale could not find that resource (404){suffix}", status)
    if status == 400 or status == 422:
        return ZephyrError("BAD_REQUEST", f"Zephyr Scale rejected the data ({status}){suffix}", status)
    if status >= 500:
        return ZephyrError("SERVER", f"Zephyr Scale had an internal error ({status}){suffix}", status, ambiguous=is_write)
    return ZephyrError("HTTP", f"Unexpected answer from Zephyr Scale ({status}){suffix}", status, ambiguous=is_write)


# --------------------------------------------------------------------------- reading + converting the Markdown

def read_cases(path: Path) -> tuple[td.Doc, dict]:
    """Parse and validate the file. Returns (doc, report); raises PublishError for unusable files."""
    p = Path(path)
    if not p.is_file():
        raise PublishError("FILE_MISSING", f"Test-case file not found: {p}. Check the path (for example "
                           "test-design/test-cases/US-001-testcase.md).", td.EXIT_MISSING)
    if not os.access(p, os.R_OK):
        raise PublishError("FILE_UNREADABLE", f"Cannot read {p}. Check the file permissions.", td.EXIT_IO)
    try:
        text = td.read_text(p)
    except (OSError, UnicodeDecodeError) as e:
        raise PublishError("FILE_UNREADABLE", f"Cannot read {p.name} as UTF-8 text ({type(e).__name__}).", td.EXIT_IO)
    doc = td.parse_test_cases(text)
    story_id = td.story_id_from_filename(p.name)
    findings = td.validate_doc(doc, story_id=story_id) if story_id else td.validate_doc(doc)
    report = td.validation_report(doc, findings, p.name)
    return doc, report


def _vars_in(*texts: Optional[str]) -> list[str]:
    seen: list[str] = []
    for t in texts:
        for name in td._VAR_RE.findall(t or ""):
            if name not in seen:
                seen.append(name)
    return seen


def _html_list(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{html.escape(i, quote=False)}</li>" for i in items) + "</ul>"


def _data_line(item: td.DataItem) -> str:
    # env:NAME is a reference, never a value; it is published exactly as written.
    return f"{item.name}: {item.raw}"


def convert_case(doc: td.Doc, case: td.Case, file_name: str) -> dict:
    """Map one parsed case to the Zephyr Scale payloads. Nothing is dropped silently: see ``unmapped``."""
    notes: list[str] = []
    unmapped: list[dict] = []

    labels: list[str] = []
    for tag in case.tags:
        label = re.sub(r"\s+", "_", tag)
        if label != tag:
            notes.append(f"tag '{tag}' sent as label '{label}' (labels cannot contain spaces)")
        if label not in labels:
            labels.append(label)

    testcase: dict = {"name": case.title,
                      "objective": html.escape(f"Source test case {case.id} ({file_name})", quote=False)}
    if case.preconditions:
        testcase["precondition"] = _html_list(case.preconditions)
    if labels:
        testcase["labels"] = labels

    if case.fields.get("Priority"):
        unmapped.append({"field": "Priority", "value": case.fields["Priority"], "decisionRequired": False,
                         "reason": "Zephyr priority names are configured per project; not set automatically"})
    if case.module:
        unmapped.append({"field": "Module", "value": case.module, "decisionRequired": False,
                         "reason": "Zephyr uses folders; the case is created in the project root folder"})
    if case.depends_on:
        unmapped.append({"field": "Depends on", "value": ", ".join(case.depends_on), "decisionRequired": True,
                         "reason": "Zephyr Scale has no test-case dependencies; the required run order would be lost"})

    # Steps: each step carries the Test Data variables it uses; data no step uses goes on the first step.
    used_anywhere: set[str] = set()
    steps: list[dict] = []
    for s in case.steps:
        names = [n for n in _vars_in(s.text, s.expected) if n in case.data]
        used_anywhere.update(names)
        steps.append({"description": html.escape(s.text, quote=False),
                      "testData": "<br>".join(html.escape(_data_line(case.data[n]), quote=False) for n in names),
                      "expectedResult": html.escape(s.expected, quote=False) if s.expected else ""})
    extra = [n for n in case.data if n not in used_anywhere]
    if extra and steps:
        lines = [html.escape(_data_line(case.data[n]), quote=False) for n in extra]
        steps[0]["testData"] = "<br>".join(([steps[0]["testData"]] if steps[0]["testData"] else []) + lines)
        notes.append("Test Data not used by any step was added to step 1: " + ", ".join(extra))
    if case.expected and steps:
        overall = "<b>Expected results:</b>" + _html_list([t for _, t in case.expected])
        last = steps[-1]
        last["expectedResult"] = (last["expectedResult"] + "<br>" if last["expectedResult"] else "") + overall
        notes.append("Expected Results (overall) were added to the last step's expected result "
                     "(Zephyr Scale keeps expected results per step)")

    items = [{"inline": {k: v for k, v in st.items() if v or k == "description"}} for st in steps]
    problems = []
    if len(case.title) > NAME_LIMIT:
        problems.append(f"title is {len(case.title)} characters; Zephyr Scale allows {NAME_LIMIT}. Shorten it in the Markdown")
    return {"caseId": case.id, "title": case.title, "testcase": testcase, "steps": items,
            "unmapped": unmapped, "notes": notes, "problems": problems,
            "contentSha256": td.sha256_text("\n".join(doc.case_text(case)))}


# --------------------------------------------------------------------------- state + audit

def _state_path(root: Path) -> Path:
    return td.confine(root, f"{td.OUTPUT_DIRNAME}/state/{STATE_NAME}")


def _audit_path(root: Path) -> Path:
    return td.confine(root, f"{td.OUTPUT_DIRNAME}/state/{AUDIT_NAME}")


def load_state(root: Path) -> dict:
    p = _state_path(root)
    if not p.is_file():
        return {"version": STATE_VERSION, "records": {}}
    try:
        st = json.loads(td.read_text(p))
    except ValueError:
        raise PublishError("STATE_CORRUPT", f"{p.name} is not valid JSON. It was not changed. Fix or move it "
                           "aside (you may lose the record of what was already published, so check Zephyr for "
                           "duplicates first).", td.EXIT_MISSING)
    if not isinstance(st, dict) or not isinstance(st.get("records"), dict):
        raise PublishError("STATE_CORRUPT", f"{p.name} has an unexpected shape. It was not changed.", td.EXIT_MISSING)
    return st


def save_state(root: Path, state: dict) -> None:
    data = (json.dumps(state, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        td.safe_write(root, _state_path(root), data, allow_overwrite=True, backup=False)
    except td.SafeOpError as e:
        raise PublishError(e.code, str(e), e.exit_code)


def audit(root: Path, event: str, **fields: Any) -> None:
    entry = {"ts": td.utc_now(), "event": event, **{k: v for k, v in fields.items() if v is not None}}
    p = _audit_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "ab") as fh:
        fh.write((json.dumps(entry, ensure_ascii=True) + "\n").encode("utf-8"))


def source_key(root: Path, file: Path, case_id: str) -> tuple[str, str]:
    f = Path(file).resolve()
    try:
        rel = f.relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        rel = f.as_posix()
    return f"{rel}::{case_id}", rel


# --------------------------------------------------------------------------- Zephyr operations

def zephyr_preflight(cfg: Config, project_key: str) -> dict:
    steps = []
    try:
        http(cfg, "GET", "/healthcheck")
        steps.append({"check": "connectivity", "ok": True})
    except ZephyrError as e:
        if e.code == "NETWORK":
            raise
        steps.append({"check": "connectivity", "ok": True, "note": "server answered"})
    http(cfg, "GET", "/projects", query={"maxResults": 1})  # 401 -> AUTH
    steps.append({"check": "token", "ok": True})
    try:
        _, proj = http(cfg, "GET", f"/projects/{urllib.parse.quote(project_key, safe='')}")
    except ZephyrError as e:
        if e.code == "NOT_FOUND":
            raise ZephyrError("PROJECT_NOT_FOUND",
                              f"Project {project_key} is not available in Zephyr Scale. Check that Zephyr Scale is enabled "
                              "for that Jira project (Project settings > Apps) and that your token's user can open it.",
                              404)
        raise
    steps.append({"check": "project", "ok": True})
    return {"steps": steps, "project": {"key": (proj or {}).get("key", project_key), "id": (proj or {}).get("id")}}


def _ensure_steps(cfg: Config, key: str, items: list[dict]) -> str:
    """Add the steps once. Returns 'added' or 'present'. Never overwrites steps that exist."""
    k = urllib.parse.quote(key, safe="")
    _, existing = http(cfg, "GET", f"/testcases/{k}/teststeps", query={"maxResults": 100})
    total = (existing or {}).get("total", len((existing or {}).get("values", [])))
    if total == 0:
        http(cfg, "POST", f"/testcases/{k}/teststeps", {"mode": "APPEND", "items": items})
        return "added"
    if total == len(items):
        return "present"
    raise ZephyrError("STEPS_MISMATCH",
                      f"{key} already has {total} step(s) in Zephyr but the Markdown has {len(items)}. Nothing was changed; "
                      "compare the case in Zephyr with the file and decide which is right.")


def _ensure_link(cfg: Config, key: str, issue_id: int) -> str:
    k = urllib.parse.quote(key, safe="")
    _, links = http(cfg, "GET", f"/testcases/{k}/links")
    for item in (links or {}).get("issues", []) or []:
        if str(item.get("issueId")) == str(issue_id):
            return "present"
    http(cfg, "POST", f"/testcases/{k}/links/issues", {"issueId": issue_id})
    return "added"


# --------------------------------------------------------------------------- publish

def publish(root: Path, file: Path, project_key: str, story_key: str, issue_id: int,
            accept_unmapped: set[str], dry_run: bool) -> dict:
    doc, report = read_cases(file)
    if not report["ok"]:
        raise PublishError("FILE_INVALID", f"{Path(file).name} does not follow the supported test-case format "
                           f"({report['summary']['errors']} error(s)). Run /builder:validate-test-cases first.", td.EXIT_USAGE)
    cfg = None if dry_run else load_config(root)
    converted = [convert_case(doc, c, Path(file).name) for c in doc.cases]
    state = load_state(root)
    out_cases: list[dict] = []
    accepted = {a.lower() for a in accept_unmapped}

    if not dry_run:
        try:
            zephyr_preflight(cfg, project_key)
        except ZephyrError as e:
            raise PublishError(e.code, str(e), td.EXIT_USAGE)

    for conv in converted:
        cid = conv["caseId"]
        skey, rel = source_key(root, file, cid)
        rec = state["records"].get(skey)
        item: dict = {"id": cid, "title": conv["title"], "unmapped": conv["unmapped"], "notes": conv["notes"],
                      "zephyrKey": rec.get("zephyrKey") if rec else None, "action": None, "steps": None,
                      "linked": False, "status": "pending", "error": None}
        out_cases.append(item)

        if conv["problems"]:
            item.update(status="failed", error="; ".join(conv["problems"]))
            continue
        blocked = [u["field"] for u in conv["unmapped"] if u["decisionRequired"] and u["field"].lower() not in accepted]
        if blocked and not (rec and rec.get("zephyrKey")):
            item.update(status="blocked", error="Needs your decision before publishing: " + ", ".join(
                f"'{u['field']}: {u['value']}' cannot be mapped ({u['reason']})" for u in conv["unmapped"]
                if u["field"] in blocked) + ". Re-run with --accept-unmapped to publish without it.")
            continue
        if dry_run:
            item.update(action="would-reuse" if rec and rec.get("zephyrKey") else "would-create", status="dry-run")
            continue

        if rec:
            if rec.get("projectKey") != project_key:
                item.update(status="failed", error=f"Already published to Zephyr project {rec.get('projectKey')} as "
                            f"{rec.get('zephyrKey')}; not creating a second copy in {project_key}.")
                continue
            if rec.get("storyKey") not in (None, story_key) and rec.get("stages", {}).get("linked"):
                item.update(status="failed", error=f"{rec.get('zephyrKey')} is already linked to {rec['storyKey']}, "
                            f"not {story_key}. Links are never changed automatically; change it in Zephyr if intended.")
                continue
            if not rec.get("zephyrKey"):
                item.update(status="blocked", error="An earlier attempt may have created this case in Zephyr, but the "
                            f"outcome is unknown. Search Zephyr project {project_key} for the name \"{conv['title']}\", then run: "
                            f"resolve --file ... --case {cid} --key <ZEPHYR-KEY>  (or --retry if it does not exist).")
                continue
        else:
            rec = {"sourceFile": rel, "caseId": cid, "title": conv["title"], "projectKey": project_key,
                   "storyKey": story_key, "storyIssueId": issue_id, "stages": {}, "zephyrKey": None}
            state["records"][skey] = rec

        rec["publishedContentSha256"] = rec.get("publishedContentSha256") or conv["contentSha256"]
        item["contentChangedSincePublish"] = rec["publishedContentSha256"] != conv["contentSha256"]
        stages = rec.setdefault("stages", {})

        try:
            if not rec.get("zephyrKey"):
                rec.update(storyKey=story_key, storyIssueId=issue_id, createStartedAt=td.utc_now())
                save_state(root, state)  # recorded *before* the request: a lost reply is detected, not duplicated
                audit(root, "create_started", caseId=cid, project=project_key)
                try:
                    _, created = http(cfg, "POST", "/testcases", {"projectKey": project_key, **conv["testcase"]})
                except ZephyrError as e:
                    if not e.ambiguous:
                        rec.pop("createStartedAt", None)
                        if not rec.get("zephyrKey"):
                            state["records"].pop(skey, None)
                        save_state(root, state)
                    raise
                zkey = (created or {}).get("key")
                if not zkey:
                    raise ZephyrError("BAD_RESPONSE", "Zephyr Scale created the case but returned no key.", ambiguous=True)
                rec.update(zephyrKey=zkey, zephyrId=(created or {}).get("id"), createdAt=td.utc_now())
                rec.pop("createStartedAt", None)
                stages["created"] = True
                item["action"] = "created"
                save_state(root, state)
                audit(root, "created", caseId=cid, zephyrKey=zkey)
            else:
                item["action"] = "reused"
            item["zephyrKey"] = rec["zephyrKey"]

            if not stages.get("steps"):
                item["steps"] = _ensure_steps(cfg, rec["zephyrKey"], conv["steps"])
                stages["steps"] = True
                save_state(root, state)
                audit(root, "steps_" + item["steps"], caseId=cid, zephyrKey=rec["zephyrKey"])
            else:
                item["steps"] = "present"

            if not stages.get("linked"):
                result = _ensure_link(cfg, rec["zephyrKey"], issue_id)
                stages["linked"] = True
                rec.update(storyKey=story_key, storyIssueId=issue_id, linkedAt=td.utc_now())
                save_state(root, state)
                audit(root, "linked" if result == "added" else "link_present", caseId=cid,
                      zephyrKey=rec["zephyrKey"], storyKey=story_key)
            item["linked"] = True
            item["status"] = "linked"
            rec.pop("lastError", None)
            save_state(root, state)
        except ZephyrError as e:
            msg = redact(str(e), cfg)
            if e.ambiguous and not rec.get("zephyrKey"):
                msg += " The case may or may not exist in Zephyr; it will not be created again until you resolve it."
                item["status"] = "blocked"
            else:
                item["status"] = "created_not_linked" if rec.get("zephyrKey") else "failed"
            item["error"] = msg
            if rec.get("zephyrKey") or e.ambiguous:
                rec["lastError"] = {"code": e.code, "message": msg, "at": td.utc_now()}
                save_state(root, state)
            audit(root, "error", caseId=cid, zephyrKey=rec.get("zephyrKey"), code=e.code, status=e.status)
            if e.code in ("AUTH", "RATE_LIMITED") or (e.code == "NETWORK" and not rec.get("zephyrKey")):
                for later in converted[len(out_cases):]:  # the same fault would repeat; stop cleanly
                    out_cases.append({"id": later["caseId"], "title": later["title"], "zephyrKey": None, "action": None,
                                      "steps": None, "linked": False, "status": "pending",
                                      "error": "Not attempted because of the earlier error", "unmapped": later["unmapped"],
                                      "notes": later["notes"]})
                break
    return _summary(file, project_key, story_key, issue_id, out_cases, dry_run)


def _summary(file: Path, project_key: str, story_key: str, issue_id: int, cases: list[dict], dry_run: bool) -> dict:
    count = lambda s: sum(1 for c in cases if c["status"] == s)  # noqa: E731
    summary = {"processed": len(cases), "created": sum(1 for c in cases if c["action"] == "created"),
               "reused": sum(1 for c in cases if c["action"] == "reused"), "linked": count("linked"),
               "createdNotLinked": count("created_not_linked"), "failed": count("failed"),
               "blocked": count("blocked"), "pending": count("pending")}
    recovery = []
    if summary["createdNotLinked"]:
        recovery.append("Cases created but not linked keep their Zephyr key; run the same command again and only the "
                        "missing steps/links are retried (nothing is created twice).")
    if summary["failed"]:
        recovery.append("Fix the reported cause for each failed case (usually the Markdown or Zephyr project settings), then run the command again.")
    if summary["blocked"]:
        recovery.append("Blocked cases need a decision from you (see each message); nothing was created for them without it.")
    if summary["pending"]:
        recovery.append("Pending cases were not attempted; run the command again.")
    ok = dry_run or (summary["linked"] == len(cases) and cases != [])
    return {"ok": ok, "dryRun": dry_run, "file": Path(file).name, "projectKey": project_key, "storyKey": story_key,
            "storyIssueId": issue_id, "summary": summary, "cases": cases, "recovery": recovery}


# --------------------------------------------------------------------------- commands

def cmd_check_file(a) -> int:
    doc, report = read_cases(Path(a.file))
    story_ids = sorted({c.story_id for c in doc.cases if c.story_id})
    td.emit({"ok": report["ok"], "file": Path(a.file).name, "cases": len(doc.cases), "storyIds": story_ids,
             "summary": report["summary"],
             "caseList": [{"id": c.id, "title": c.title, "steps": len(c.steps)} for c in doc.cases],
             "findings": [f for f in report["findings"] if f["severity"] == "error"][:20]})
    return td.EXIT_OK if report["ok"] and doc.cases else td.EXIT_FINDINGS


def cmd_check_config(a) -> int:
    root = Path(a.root).resolve()
    cfg = load_config(root)
    pub = cfg.public()
    env_path = root / ".env"
    warnings = []
    if pub["envFile"]:
        ignored = _env_file_ignored(root, env_path)
        if ignored is False:
            warnings.append(f"{env_path.name} is not git-ignored. Add it to .gitignore so the token is never committed.")
    if not cfg.base_url.rstrip("/").endswith("/v2"):
        warnings.append("ZEPHYR_BASE_URL does not end in /v2 (Cloud default: https://api.zephyrscale.smartbear.com/v2).")
    td.emit({"ok": True, **pub, "warnings": warnings})
    return td.EXIT_OK


def cmd_check_zephyr(a) -> int:
    root = Path(a.root).resolve()
    cfg = load_config(root)
    try:
        res = zephyr_preflight(cfg, a.project)
    except ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": redact(str(e), cfg)}})
        return td.EXIT_USAGE
    td.emit({"ok": True, **res})
    return td.EXIT_OK


def cmd_convert(a) -> int:
    doc, report = read_cases(Path(a.file))
    td.emit({"ok": report["ok"], "file": Path(a.file).name, "formatErrors": report["summary"]["errors"],
             "cases": [convert_case(doc, c, Path(a.file).name) for c in doc.cases]})
    return td.EXIT_OK if report["ok"] else td.EXIT_FINDINGS


def cmd_publish(a) -> int:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*-\d+", a.story_key):
        raise PublishError("STORY_KEY_FORMAT", f"'{a.story_key}' is not a Jira issue key like PROJ-101.")
    if not re.fullmatch(r"\d+", str(a.story_issue_id)):
        raise PublishError("ISSUE_ID_FORMAT", "--story-issue-id must be the numeric Jira issue ID (for example 10352), "
                           "not the key.")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", a.project):
        raise PublishError("PROJECT_KEY_FORMAT", f"'{a.project}' is not a valid project key.")
    if not a.story_key.upper().startswith(a.project.upper() + "-"):
        raise PublishError("STORY_PROJECT_MISMATCH", f"{a.story_key} does not belong to project {a.project}.")
    res = publish(Path(a.root).resolve(), Path(a.file), a.project, a.story_key, int(a.story_issue_id),
                  set(a.accept_unmapped or []), a.dry_run)
    td.emit(res)
    return td.EXIT_OK if res["ok"] else td.EXIT_FINDINGS


def cmd_status(a) -> int:
    root = Path(a.root).resolve()
    state = load_state(root)
    recs = list(state["records"].values())
    if a.file:
        _, rel = source_key(root, Path(a.file), "x")
        recs = [r for r in recs if r.get("sourceFile") == rel]
    td.emit({"ok": True, "records": [
        {k: r.get(k) for k in ("sourceFile", "caseId", "title", "projectKey", "zephyrKey", "storyKey", "stages", "lastError")}
        for r in recs]})
    return td.EXIT_OK


def cmd_resolve(a) -> int:
    root = Path(a.root).resolve()
    state = load_state(root)
    skey, _ = source_key(root, Path(a.file), a.case)
    rec = state["records"].get(skey)
    if not rec:
        raise PublishError("NO_RECORD", f"No publishing record for {a.case} in that file.", td.EXIT_MISSING)
    if rec.get("zephyrKey"):
        raise PublishError("ALREADY_RESOLVED", f"{a.case} already maps to {rec['zephyrKey']}.", td.EXIT_USAGE)
    if a.key:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*-T\d+", a.key):
            raise PublishError("KEY_FORMAT", "A Zephyr test-case key looks like PROJ-T123.")
        rec.update(zephyrKey=a.key, stages={"created": True}, resolvedAt=td.utc_now())
    else:
        state["records"].pop(skey)
    rec.pop("createStartedAt", None)
    rec.pop("lastError", None)
    save_state(root, state)
    audit(root, "resolved", caseId=a.case, zephyrKey=a.key, mode="adopt" if a.key else "retry")
    td.emit({"ok": True, "caseId": a.case, "zephyrKey": a.key, "mode": "adopt" if a.key else "retry"})
    return td.EXIT_OK


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check-file"); p.add_argument("file"); p.set_defaults(fn=cmd_check_file)
    p = sub.add_parser("check-config"); p.add_argument("--root", required=True); p.set_defaults(fn=cmd_check_config)
    p = sub.add_parser("check-zephyr"); p.add_argument("--root", required=True); p.add_argument("--project", required=True)
    p.set_defaults(fn=cmd_check_zephyr)
    p = sub.add_parser("convert"); p.add_argument("file"); p.set_defaults(fn=cmd_convert)
    p = sub.add_parser("publish")
    p.add_argument("--root", required=True); p.add_argument("--file", required=True)
    p.add_argument("--project", required=True); p.add_argument("--story-key", required=True)
    p.add_argument("--story-issue-id", required=True)
    p.add_argument("--accept-unmapped", action="append", metavar="FIELD")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_publish)
    p = sub.add_parser("status"); p.add_argument("--root", required=True); p.add_argument("--file"); p.set_defaults(fn=cmd_status)
    p = sub.add_parser("resolve")
    p.add_argument("--root", required=True); p.add_argument("--file", required=True); p.add_argument("--case", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--key"); g.add_argument("--retry", action="store_true")
    p.set_defaults(fn=cmd_resolve)
    a = ap.parse_args(argv)
    try:
        return a.fn(a)
    except PublishError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return e.exit_code
    except td.SafeOpError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return e.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

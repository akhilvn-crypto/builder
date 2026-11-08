#!/usr/bin/env python3
"""Build the ISO test-case workbook and the test-report workbook from the test executions recorded in Zephyr Scale (Cloud, REST API v2).

Used only by ``/builder:build-test-reports``. It is read-only towards Zephyr (GET requests only), never runs tests, never edits test
cases, never contacts Jira (the command resolves names through the Jira connector and hands them over in a lookup file) and never prints
or stores the API token. Connection settings and the HTTP layer are the ones ``zephyr-execution.py`` / ``zephyr-publish.py`` use.

    zephyr-reports.py preflight --root R --project KEY [--out-dir D]
    zephyr-reports.py cycles    --root R --project KEY [--limit N]
    zephyr-reports.py fetch     --root R --project KEY (--cycle KEY ... | --all-cycles)
    zephyr-reports.py build     --root R --project KEY [--lookup-file F] [--cycle KEY ...] [--out-dir D]
                                [--testcases-template F] [--report-template F]

``fetch`` reads Zephyr into a snapshot (``<root>/automation/execution-results/report-build/zephyr-snapshot.json``) and lists the Jira account
and issue IDs it still has no name for (``needsLookup``). ``build`` works offline from that snapshot, an optional lookup file
(``{"users": {"<accountId>": "Name"}, "issues": {"<numeric id>": {"key": "PROJ-1", "summary": "...", "type": "Story"}}}``) and what the project
already knows locally (publish state: case IDs and stories; update runs: bug keys), and writes two workbooks into ``<root>/Test artifacts ISO/``
by filling copies of the bundled templates. A file that already exists is moved to ``archive/`` first, never overwritten.

The test-case workbook keeps one pair of columns per execution of each test case: when it was executed (date and time, IST) and the result,
so an earlier pass and a later failure are visible side by side.

Exit codes: 0 ok, 2 usage / configuration / Zephyr failure, 4 missing input, 5 outside the project folder.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import importlib.util
import json
import math
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import td_common as td  # noqa: E402


def _load(alias: str, file: str):
    spec = importlib.util.spec_from_file_location(alias, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[alias] = mod
    spec.loader.exec_module(mod)
    return mod


ze = _load("zephyr_execution_shared", "zephyr-execution.py")
zp = ze.zp  # one copy of the Zephyr settings / HTTP layer / error classes
ExecError = ze.ExecError

IST = dt.timezone(dt.timedelta(hours=5, minutes=30), "IST")
OUT_DIRNAME = "Test artifacts ISO"
WORK_DIRNAME = "report-build"
SNAPSHOT_NAME = "zephyr-snapshot.json"
SNAPSHOT_VERSION = 1
TEMPLATE_DIR = HERE.parent / "templates"
TESTCASES_TEMPLATE = "testcases-template.xlsx"
REPORT_TEMPLATE = "test-report-template.xlsx"
PAGE = 500
MAX_PAGES = 200
CASE_RE = r"/testcases/([A-Za-z][A-Za-z0-9_]*-T\d+)"
CYCLE_RE = r"/testcycles/([A-Za-z][A-Za-z0-9_]*-R\d+)"
ID_RE = r"/(\d+)(?:/|$)"
NOT_RUN = "NOT RUN"
CASE_SHEET_STATUS = {NOT_RUN: "PENDING"}      # the test-case template's word for "not executed yet"
REPORT_SHEET_STATUS = {NOT_RUN: "UNEXECUTED"}  # the test-report template's word
STATUS_COLOURS = {"PASS": "B7E1CD", "FAIL": "E06666", "IN PROGRESS": "6FA8DC", "BLOCKED": "FFFF00", "PENDING": "FFFFFF", "UNEXECUTED": "FFFFFF"}
CASE_COLUMNS = 14   # the template's own columns A..N
EXTRA_COLUMNS = 2   # Zephyr key, latest-vs-previous
SECTION_FILL = "4A86E8"


# --------------------------------------------------------------------------- small helpers

def results_work_dir(root: Path) -> Path:
    return ze.results_dir(root) / WORK_DIRNAME


def parse_ts(value: Any) -> Optional[dt.datetime]:
    """Zephyr timestamps (ISO 8601, usually ...Z) -> aware UTC datetime, or None when absent / unreadable."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    s = re.sub(r"Z$", "+00:00", s)
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s)
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d.replace(tzinfo=dt.timezone.utc) if d.tzinfo is None else d.astimezone(dt.timezone.utc)


def ist_stamp(d: Optional[dt.datetime]) -> str:
    return d.astimezone(IST).strftime("%d-%m-%Y %H:%M:%S IST") if d else "date not recorded"


def ist_date(d: dt.datetime) -> str:
    return d.astimezone(IST).strftime("%d-%m-%Y")


def now_ist_stamp() -> str:
    return dt.datetime.now(IST).strftime("%Y%m%d-%H%M%S")


def strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s)


def html_text(value: Any) -> str:
    """Zephyr stores rich text as HTML; the workbooks want plain lines. Lists are numbered the way the templates number steps."""
    import html as _html
    if not value or not isinstance(value, str):
        return ""

    def numbered(m):
        items = [strip_tags(i).strip() for i in re.findall(r"(?is)<li[^>]*>(.*?)</li>", m.group(3))]
        return "\n" + "\n".join(f"{n}. {t}" for n, t in enumerate([i for i in items if i], 1)) + "\n"

    t = re.sub(r"(?is)<(ul|ol)([^>]*)>(.*?)</\1>", numbered, value)
    t = re.sub(r"(?i)<\s*br\s*/?>", "\n", t)
    t = re.sub(r"(?i)<\s*(p|div|h\d|tr)(\s[^>]*)?>|</\s*(p|div|h\d|tr)\s*>", "\n", t)
    t = _html.unescape(strip_tags(t))
    lines = [ln.rstrip() for ln in t.replace("\r", "").split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln.strip() or (out and out[-1].strip()):
            out.append(ln)
    return "\n".join(out).strip()


def expected_text(steps: list[dict]) -> str:
    """Expected Result column. Steps may carry their own expectation; the case's overall expectations were appended by the publisher to the
    last step under an "Expected results:" label, which is dropped here (the list underneath is kept as it is)."""
    per_step: list[tuple[int, str]] = []
    overall: list[str] = []
    for i, s in enumerate(steps, 1):
        text = html_text(s.get("expectedResult"))
        m = re.search(r"(?im)^expected results:\s*$", text)
        if m:
            head, tail = text[:m.start()], text[m.end():]
            overall += [ln for ln in tail.split("\n") if ln.strip()]
            text = head.strip()
        if text:
            per_step.append((i, text))
    if overall and per_step:
        return "\n".join([f"Step {i}: {t}" for i, t in per_step] + overall)
    if per_step:
        return "\n".join(f"{i}. {t}" for i, t in per_step)
    return "\n".join(overall)


def natural_key(text: str):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", text or "")]


def key_from(obj: Any, pattern: str) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    if isinstance(obj.get("key"), str) and obj["key"]:
        return obj["key"]
    m = re.search(pattern, str(obj.get("self") or ""))
    return m.group(1) if m else None


def id_from(obj: Any) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    if obj.get("id") is not None:
        return str(obj["id"])
    m = re.search(ID_RE, str(obj.get("self") or ""))
    return m.group(1) if m else None


def canonical_status(name: Optional[str]) -> tuple[str, bool]:
    """(canonical status, known). The two templates share PASS / FAIL / IN PROGRESS / BLOCKED; 'not executed' differs per template."""
    n = (name or "").strip().lower()
    if n in ("pass", "passed", "passing", "success", "successful"):
        return "PASS", True
    if n in ("fail", "failed", "failure"):
        return "FAIL", True
    if n in ("in progress", "in-progress", "inprogress", "running", "wip"):
        return "IN PROGRESS", True
    if n in ("blocked", "block"):
        return "BLOCKED", True
    if n in ("", "not executed", "unexecuted", "not run", "not started", "pending", "unexecuted (default)"):
        return NOT_RUN, True
    return (name or "").strip().upper(), False


def paged(cfg, path: str, query: dict) -> tuple[list, bool]:
    """All 'values' of a Zephyr list endpoint. Returns (values, truncated)."""
    out: list = []
    start = 0
    for _ in range(MAX_PAGES):
        _, data = zp.http(cfg, "GET", path, query={**query, "maxResults": PAGE, "startAt": start})
        values = data.get("values") if isinstance(data, dict) else (data if isinstance(data, list) else [])
        values = [v for v in (values or []) if isinstance(v, dict)]
        out += values
        last = data.get("isLast") if isinstance(data, dict) and "isLast" in data else len(values) < PAGE
        if not values or last:
            return out, False
        start += len(values)
    return out, True


def optional_paged(cfg, path: str, query: dict) -> Optional[list]:
    try:
        return paged(cfg, path, query)[0]
    except zp.ZephyrError as e:
        if e.code in ("AUTH", "NETWORK", "RATE_LIMITED"):
            raise
        return None


# --------------------------------------------------------------------------- local knowledge (no network)

def local_knowledge(root: Path, project: str) -> dict:
    """What the project already records: source case IDs and stories (publish state), bug keys (update runs). Nothing here is guessed."""
    cases: dict[str, dict] = {}
    issues: dict[str, dict] = {}
    try:
        records = list(zp.load_state(root)["records"].values())
    except zp.PublishError:
        records = []
    for r in records:
        if r.get("projectKey") != project or not r.get("zephyrKey"):
            continue
        cases[r["zephyrKey"]] = {"caseId": r.get("caseId"), "storyKey": r.get("storyKey"), "storyIssueId": r.get("storyIssueId")}
        if r.get("storyIssueId") and r.get("storyKey"):
            issues.setdefault(str(r["storyIssueId"]), {"key": r["storyKey"], "role": "story"})
    runs = []
    cur = ze.results_dir(root) / ze.RUN_NAME
    if cur.is_file():
        runs.append(cur)
    arch = ze.results_dir(root) / "archive"
    if arch.is_dir():
        runs += sorted(arch.glob("*.json"))
    for p in runs:
        try:
            run = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for bug in ((run.get("bugs") or {}) if isinstance(run, dict) else {}).values():
            if isinstance(bug, dict) and bug.get("key") and bug.get("issueId"):
                issues[str(bug["issueId"])] = {"key": bug["key"], "role": "bug"}
    return {"cases": cases, "issues": issues}


def read_lookup(path: Optional[str]) -> dict:
    if not path:
        return {"users": {}, "issues": {}}
    data = ze.read_json_file(Path(path), "lookup file")
    if not isinstance(data, dict):
        raise ExecError("FILE_INVALID", f"The lookup file must be a JSON object with \"users\" and \"issues\": {path}")
    users = {str(k): str(v) for k, v in (data.get("users") or {}).items() if isinstance(v, str) and v.strip()}
    issues = {str(k): v for k, v in (data.get("issues") or {}).items() if isinstance(v, dict)}
    return {"users": users, "issues": issues}


# --------------------------------------------------------------------------- Zephyr access (GET only)

def _norm_execution(v: dict, statuses: dict, case_ids: dict, cycle_ids: dict) -> Optional[dict]:
    tc = v.get("testCase")
    case_key = key_from(tc, CASE_RE) or case_ids.get(id_from(tc) or "")
    cycle = v.get("testCycle")
    cycle_key = key_from(cycle, CYCLE_RE) or cycle_ids.get(id_from(cycle) or "")
    if not case_key:
        return None
    st = v.get("testExecutionStatus")
    sid = id_from(st)
    name = (st.get("name") if isinstance(st, dict) else None) or statuses.get(sid or "")
    return {"id": v.get("id"), "caseKey": case_key, "cycleKey": cycle_key, "status": name, "statusId": sid,
            "executedAt": v.get("actualEndDate") or v.get("actualStartDate"), "executedById": v.get("executedById"),
            "comment": html_text(v.get("comment")), "automated": v.get("automated")}


def read_executions(cfg, project: str) -> dict:
    """Everything the report builder needs from Zephyr except the per-case details."""
    zp.zephyr_preflight(cfg, project)
    warnings: list[str] = []
    st_vals = optional_paged(cfg, "/statuses", {"projectKey": project, "statusType": "TEST_EXECUTION"})
    statuses = {str(v["id"]): v.get("name") for v in (st_vals or []) if v.get("id") is not None}
    if st_vals is None:
        warnings.append("Zephyr Scale did not list the execution statuses, so results may show as unknown.")
    cycles, cut = paged(cfg, "/testcycles", {"projectKey": project})
    if cut:
        warnings.append("The list of Test Cycles was cut off after %d pages." % MAX_PAGES)
    cycle_ids = {str(c["id"]): c.get("key") for c in cycles if c.get("id") is not None and c.get("key")}
    cases, cut = paged(cfg, "/testcases", {"projectKey": project})
    if cut:
        warnings.append("The list of test cases was cut off after %d pages." % MAX_PAGES)
    case_ids = {str(c["id"]): c.get("key") for c in cases if c.get("id") is not None and c.get("key")}
    raw, cut = paged(cfg, "/testexecutions", {"projectKey": project})
    if cut:
        warnings.append("The list of test executions was cut off after %d pages; older executions may be missing." % MAX_PAGES)
    executions, dropped = [], 0
    for v in raw:
        e = _norm_execution(v, statuses, case_ids, cycle_ids)
        if e:
            executions.append(e)
        else:
            dropped += 1
    if dropped:
        warnings.append(f"{dropped} execution(s) could not be tied to a test case and were left out.")
    return {"statuses": statuses, "cycles": cycles, "cases": cases, "executions": executions, "warnings": warnings}


def cycle_activity(data: dict) -> list[dict]:
    rows = []
    by_cycle: dict[str, list] = {}
    for e in data["executions"]:
        by_cycle.setdefault(e["cycleKey"] or "", []).append(e)
    for c in data["cycles"]:
        ex = by_cycle.get(c.get("key") or "", [])
        real = [e for e in ex if canonical_status(e["status"])[0] != NOT_RUN]
        stamps = [d for d in (parse_ts(e["executedAt"]) for e in real) if d]
        counts: dict[str, int] = {}
        for e in real:
            s = canonical_status(e["status"])[0]
            counts[s] = counts.get(s, 0) + 1
        rows.append({"key": c.get("key"), "name": c.get("name"), "executions": len(ex), "executed": len(real), "results": counts,
                     "lastExecutedAt": ist_stamp(max(stamps)) if stamps else None, "_sort": max(stamps).isoformat() if stamps else ""})
    rows.sort(key=lambda r: (r["_sort"], natural_key(r["key"] or "")), reverse=True)
    for r in rows:
        r.pop("_sort")
    return rows


# --------------------------------------------------------------------------- the model both workbooks are written from

def is_bug(info: dict) -> bool:
    t = str(info.get("type") or "").lower()
    if t:
        return "bug" in t or "defect" in t
    return info.get("role") == "bug"


def build_model(snap: dict, lookup: dict, local: dict, only_cycles: Optional[list[str]] = None) -> dict:
    warnings: list[str] = list(snap.get("warnings") or [])
    users = lookup["users"]
    issues: dict[str, dict] = {}
    for iid, info in local["issues"].items():
        issues[iid] = dict(info)
    for iid, info in lookup["issues"].items():
        issues[iid] = {**issues.get(iid, {}), **{k: v for k, v in info.items() if v}}
    by_key = {v["key"]: v for v in issues.values() if v.get("key")}  # lookups may be keyed by Jira key instead of numeric ID
    for k, info in lookup["issues"].items():
        if not k.isdigit():
            by_key[k] = {**by_key.get(k, {}), **info}
    selected = [c for c in (only_cycles or snap["selectedCycles"])]
    cycles = {c["key"]: c for c in snap["cycles"] if c.get("key")}
    missing = [c for c in selected if c not in cycles]
    if missing:
        raise ExecError("CYCLE_NOT_IN_SNAPSHOT", f"Test Cycle(s) {', '.join(missing)} are not in the fetched data. Run `fetch` again with them.")
    unresolved_users: set[str] = set()
    unresolved_issues: dict[str, dict] = {}
    unknown_statuses: set[str] = set()

    def person(account_id: Optional[str]) -> str:
        if not account_id:
            return ""
        if account_id in users:
            return users[account_id]
        unresolved_users.add(account_id)
        return ""

    execs_by_case: dict[str, list[dict]] = {}
    for e in snap["executions"]:
        status, known = canonical_status(e["status"])
        if not known:
            unknown_statuses.add(e["status"] or "")
        d = parse_ts(e["executedAt"])
        execs_by_case.setdefault(e["caseKey"], []).append({**e, "canon": status, "when": d, "by": None})
    selected_set = set(selected)
    case_keys = sorted({e["caseKey"] for e in snap["executions"] if e["cycleKey"] in selected_set}, key=natural_key)
    cases: dict[str, dict] = {}
    for key in case_keys:
        zc = snap["cases"].get(key) or {"key": key, "name": key, "steps": [], "issueIds": []}
        loc = local["cases"].get(key) or {}
        execs = sorted(execs_by_case.get(key, []), key=lambda e: (e["when"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc), int(e["id"]) if str(e["id"]).isdigit() else 0))
        for e in execs:
            e["by"] = person(e["executedById"])
        real = [e for e in execs if e["canon"] != NOT_RUN]
        stories, bugs, others, unresolved = [], [], [], []
        for iid in zc.get("issueIds") or []:
            info = issues.get(str(iid))
            if not info or not info.get("key"):
                unresolved.append(str(iid))
                unresolved_issues.setdefault(str(iid), {"issueId": str(iid), "need": "key, summary and type"})
                continue
            full = {**by_key.get(info["key"], {}), **info}
            (bugs if is_bug(full) else stories).append(full)
        story = stories[0] if stories else ({"key": loc["storyKey"], **(issues.get(str(loc.get("storyIssueId"))) or {})} if loc.get("storyKey") else None)
        if story and not story.get("summary"):
            unresolved_issues.setdefault(str(loc.get("storyIssueId") or story.get("key")), {"issueId": loc.get("storyIssueId"), "key": story.get("key"), "need": "summary"})
        story_text = ""
        if story:
            full_story = {**by_key.get(story.get("key"), {}), **story}
            story_text = full_story.get("summary") or ""
            story = full_story
        steps = zc.get("steps") or []
        steps_text = "\n".join(f"{i}. {html_text(s.get('description'))}" for i, s in enumerate(steps, 1) if html_text(s.get("description")))
        data_lines: list[str] = []
        for s in steps:
            for ln in html_text(s.get("testData")).split("\n"):
                if ln.strip() and ln.strip() not in data_lines:
                    data_lines.append(ln.strip())
        expected = expected_text(steps)
        objective = html_text(zc.get("objective"))
        source = re.match(r"(?i)^source test case\s+(\S+)", objective)
        if source:  # the publisher's provenance line ("Source test case TC-001 (file)"): an ID, not a description
            loc = {**loc, "caseId": loc.get("caseId") or source.group(1)}
            objective = ""
        section = (f"{story['key']} - {story['summary']}" if story and story.get("summary") else story["key"]) if story and story.get("key") else (zc.get("folder") or "Test cases")
        cases[key] = {
            "key": key, "caseId": loc.get("caseId") or key, "title": zc.get("name") or key, "description": objective,
            "preconditions": html_text(zc.get("precondition")), "steps": steps_text, "data": "\n".join(data_lines), "expected": expected,
            "priority": zc.get("priority") or "", "createdBy": person(zc.get("ownerId")), "storyKey": (story or {}).get("key") or "",
            "storyText": story_text, "section": section, "defects": sorted({b["key"] for b in bugs}, key=natural_key),
            "otherIssues": sorted({s["key"] for s in stories[1:]}, key=natural_key), "unresolvedIssues": unresolved,
            "history": real, "all": execs,
        }

    def status_of(group: list[dict]) -> str:
        real_ = [e for e in group if e["canon"] != NOT_RUN]
        return real_[-1]["canon"] if real_ else NOT_RUN

    for c in cases.values():
        c["latest"] = status_of(c["all"])
        c["trend"], c["trendKind"] = trend(c["history"])
    blocks = []
    for ck in selected:
        rows = []
        for c in cases.values():
            in_cycle = [e for e in c["all"] if e["cycleKey"] == ck]
            if not in_cycle:
                continue
            real_in = [e for e in in_cycle if e["canon"] != NOT_RUN]
            last = real_in[-1] if real_in else None
            note = ""
            if last:
                idx = next(i for i, e in enumerate(c["history"]) if e is last)
                prev = c["history"][idx - 1] if idx > 0 else None  # the execution just before this one, whichever cycle it was in
                if prev and prev["canon"] == "PASS" and last["canon"] == "FAIL":
                    note = "Regression: passed on %s." % (ist_date(prev["when"]) if prev["when"] else "an earlier run")
                elif prev and prev["canon"] == "FAIL" and last["canon"] == "PASS":
                    note = "Fixed: failed on %s, passes now." % (ist_date(prev["when"]) if prev["when"] else "an earlier run")
            rows.append({"case": c, "status": last["canon"] if last else NOT_RUN, "execution": last, "note": note})
        rows.sort(key=lambda r: (natural_key(r["case"]["storyKey"] or "~"), natural_key(r["case"]["key"])))
        stamps = [r["execution"]["when"] for r in rows if r["execution"] and r["execution"]["when"]]
        blocks.append({"cycle": cycles[ck], "rows": rows, "from": min(stamps) if stamps else None, "to": max(stamps) if stamps else None,
                       "executors": sorted({r["execution"]["by"] for r in rows if r["execution"] and r["execution"]["by"]})})
    if unknown_statuses:
        warnings.append("Zephyr statuses without an equivalent in the templates are shown as written: " + ", ".join(sorted(f'"{s}"' for s in unknown_statuses)) + ".")
    return {"project": snap["project"], "cases": cases, "blocks": blocks, "selected": selected, "warnings": warnings,
            "unresolved": {"accountIds": sorted(unresolved_users), "issues": sorted(unresolved_issues.values(), key=lambda i: str(i.get("issueId") or i.get("key")))}}


def trend(real: list[dict]) -> tuple[str, str]:
    if not real:
        return "Not executed yet", "none"
    if len(real) == 1:
        return "First execution (%s)" % real[0]["canon"], "first"
    p, last = real[-2], real[-1]
    pd_, ld = (ist_date(p["when"]) if p["when"] else "?"), (ist_date(last["when"]) if last["when"] else "?")
    if p["canon"] == last["canon"]:
        return "No change (%s)" % last["canon"], "same"
    if p["canon"] == "PASS" and last["canon"] == "FAIL":
        return f"REGRESSION: PASS ({pd_}) -> FAIL ({ld})", "regression"
    if p["canon"] == "FAIL" and last["canon"] == "PASS":
        return f"FIXED: FAIL ({pd_}) -> PASS ({ld})", "fixed"
    return f"CHANGED: {p['canon']} ({pd_}) -> {last['canon']} ({ld})", "changed"


# --------------------------------------------------------------------------- workbook writing

def require_openpyxl():
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        raise ExecError("OPENPYXL_MISSING", "The Python package openpyxl is needed to write the Excel workbooks and is not installed. "
                        "Install it (python -m pip install \"openpyxl>=3.1\") after you approve it, then run the command again.", td.EXIT_MISSING)
    import openpyxl
    return openpyxl


def est_height(ws, row_cells: list[tuple[str, Any]], minimum: float = 15.75) -> float:
    lines = 1
    for col, value in row_cells:
        if value is None or value == "":
            continue
        width = (ws.column_dimensions[col].width if col in ws.column_dimensions else None) or 8.43
        n = sum(max(1, math.ceil(len(part) / max(1.0, width * 1.05))) for part in str(value).split("\n"))
        lines = max(lines, n)
    return min(409.0, max(minimum, lines * 15.0))


def clear_below(ws, first_row: int) -> None:
    for r in [r for r in list(ws.merged_cells.ranges) if r.max_row >= first_row]:
        ws.unmerge_cells(str(r))
    if ws.max_row >= first_row:
        ws.delete_rows(first_row, ws.max_row - first_row + 1)
    for r in [r for r in ws.row_dimensions if r >= first_row]:
        del ws.row_dimensions[r]  # delete_rows does not move row heights; stale ones would size the new rows wrongly


def reset_rules(ws) -> None:
    from openpyxl.formatting.formatting import ConditionalFormattingList
    from openpyxl.worksheet.datavalidation import DataValidationList
    ws.conditional_formatting = ConditionalFormattingList()
    ws.data_validations = DataValidationList()


def add_status_rules(ws, ranges: list[str], status_list: str, flag_blank_white: bool) -> None:
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.styles import PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    sq = " ".join(ranges)
    for word, colour in STATUS_COLOURS.items():
        if word in ("PENDING", "UNEXECUTED") and not flag_blank_white:
            continue
        ws.conditional_formatting.add(sq, CellIsRule(operator="equal", formula=[f'"{word}"'], fill=PatternFill(start_color=colour, end_color=colour, fill_type="solid")))
    dv = DataValidation(type="list", formula1=f'"{status_list}"', allow_blank=True, showErrorMessage=False)
    ws.add_data_validation(dv)
    for r in ranges:
        dv.add(r)


def fill_document_control(wb, title: str, description: str) -> None:
    if "Document Control" in wb.sheetnames:
        ws = wb["Document Control"]
        ws["E6"].value = title
        ws["E8"].value = description


def previous_reviewers(path: Path) -> dict[str, str]:
    """'Reviewed By' (column K) that people typed into the test-case workbook that is about to be replaced, by Test Case ID. It is a sign-off,
    not Zephyr data, so a rebuild must not wipe it (the old file is archived as well)."""
    if not path.is_file():
        return {}
    openpyxl = require_openpyxl()
    try:
        ws = openpyxl.load_workbook(path, read_only=True)["Testcases"]
        return {str(r[0]).strip(): str(r[10]).strip() for r in ws.iter_rows(min_row=2, max_col=11, values_only=True)
                if r[0] and r[1] and r[10] and str(r[10]).strip()}
    except (OSError, KeyError, ValueError):
        return {}


def previous_lead(path: Path) -> Optional[str]:
    """'Overall testing by lead' (D4) typed into the report that is about to be replaced."""
    if not path.is_file():
        return None
    openpyxl = require_openpyxl()
    try:
        v = openpyxl.load_workbook(path, read_only=True)["Report Template"]["D4"].value
        return str(v).strip() if v and str(v).strip() else None
    except (OSError, KeyError, ValueError):
        return None


def write_testcases_workbook(model: dict, template: Path, dest: Path, generated_at: str, reviewers: Optional[dict] = None) -> dict:
    openpyxl = require_openpyxl()
    from copy import copy
    from openpyxl.comments import Comment
    from openpyxl.formatting.rule import FormulaRule
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter as L
    wb = openpyxl.load_workbook(template)
    if "Testcases" not in wb.sheetnames:
        raise ExecError("TEMPLATE_INVALID", f"{template.name} has no 'Testcases' sheet.", td.EXIT_MISSING)
    ws = wb["Testcases"]
    proto = {"head": copy(ws["H1"]._style), "head_left": copy(ws["A1"]._style), "section": copy(ws["A2"]._style), "section_rest": copy(ws["D2"]._style),
             "data": copy(ws["A3"]._style)}
    cases = list(model["cases"].values())
    n_exec = max([len(c["history"]) for c in cases] + [0])
    total_cols = CASE_COLUMNS + EXTRA_COLUMNS + 2 * n_exec
    reset_rules(ws)
    clear_below(ws, 2)
    # header row: the template's columns A..N, then Zephyr key and trend, then one (Executed On, Result) pair per execution
    extra_head = ["Zephyr\nTest Case", "Latest vs\nPrevious Result"]
    for i in range(n_exec):
        extra_head += [f"Execution {i + 1}\nExecuted On\n(dd-mm-yyyy hh:mm:ss IST)", f"Execution {i + 1}\nResult"]
    for j, text in enumerate(extra_head, CASE_COLUMNS + 1):
        c = ws.cell(row=1, column=j, value=text)
        c._style = copy(proto["head"])
    ws.column_dimensions["M"].width = max(ws.column_dimensions["M"].width or 0, 15.6)
    for letter, width in (("O", 13), ("P", 34)):
        ws.column_dimensions[letter].width = width
    for i in range(n_exec):
        ws.column_dimensions[L(CASE_COLUMNS + EXTRA_COLUMNS + 1 + 2 * i)].width = 26
        ws.column_dimensions[L(CASE_COLUMNS + EXTRA_COLUMNS + 2 + 2 * i)].width = 12
    for letter, width in (("H", 12), ("I", 30), ("J", 12), ("K", 12), ("L", 14), ("N", 16)):
        ws.column_dimensions[letter].width = max(ws.column_dimensions[letter].width or 0, width)
    ws.row_dimensions[1].height = 63 if n_exec else 31.5
    row = 2
    result_cols: list[str] = []
    last_section = None
    for c in sorted(cases, key=lambda c: (natural_key(c["section"]), natural_key(c["key"]))):
        if c["section"] != last_section:
            last_section = c["section"]
            ws.cell(row=row, column=1, value=c["section"])._style = copy(proto["section"])
            for j in range(2, total_cols + 1):
                ws.cell(row=row, column=j)._style = copy(proto["section"] if j <= 3 else proto["section_rest"])
            ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
            merged_width = sum(ws.column_dimensions[x].width or 8.43 for x in "ABC")
            ws.row_dimensions[row].height = min(409.0, max(15.75, 15.0 * math.ceil(len(c["section"]) / (merged_width * 1.05))))
            row += 1
        last_exec = c["history"][-1] if c["history"] else None
        dates = []
        for e in c["history"]:
            if e["when"] and ist_date(e["when"]) not in dates:
                dates.append(ist_date(e["when"]))
        values = [c["caseId"], c["title"], c["description"], c["preconditions"], c["steps"], c["data"], c["expected"],
                  CASE_SHEET_STATUS.get(c["latest"], c["latest"]), (last_exec or {}).get("comment", "")[:800], c["createdBy"], (reviewers or {}).get(c["caseId"], ""),
                  (last_exec or {}).get("by", ""), "\n".join(dates), "\n".join(c["defects"]), c["key"], c["trend"]]
        for i in range(n_exec):
            if i < len(c["history"]):
                e = c["history"][i]
                values += [ist_stamp(e["when"]), CASE_SHEET_STATUS.get(e["canon"], e["canon"])]
            else:
                values += ["", ""]
        for j, v in enumerate(values, 1):
            cell = ws.cell(row=row, column=j, value=v if v != "" else None)
            cell._style = copy(proto["data"])
        for i, e in enumerate(c["history"]):
            cell = ws.cell(row=row, column=CASE_COLUMNS + EXTRA_COLUMNS + 1 + 2 * i)
            who = e["by"] or "not recorded"
            cell.comment = Comment(f"Test Cycle: {e['cycleKey'] or 'unknown'}\nExecuted by: {who}", "Zephyr Scale", width=220, height=60)
        ws.row_dimensions[row].height = est_height(ws, [(L(j), v) for j, v in enumerate(values, 1)])
        row += 1
    last_row = max(row - 1, 2)
    result_cols = ["H"] + [L(CASE_COLUMNS + EXTRA_COLUMNS + 2 + 2 * i) for i in range(n_exec)]
    add_status_rules(ws, [f"{col}2:{col}{last_row}" for col in result_cols], "PASS,FAIL,IN PROGRESS,PENDING,BLOCKED", True)
    ws.conditional_formatting.add(f"P2:P{last_row}", FormulaRule(formula=['ISNUMBER(SEARCH("REGRESSION",P2))'], fill=PatternFill(start_color="F4CCCC", end_color="F4CCCC", fill_type="solid"),
                                                                font=Font(bold=True, color="990000")))
    ws.conditional_formatting.add(f"P2:P{last_row}", FormulaRule(formula=['ISNUMBER(SEARCH("FIXED",P2))'], fill=PatternFill(start_color="D9EAD3", end_color="D9EAD3", fill_type="solid")))
    ws.freeze_panes = "D2"
    suite_rows = write_suite_sheet(wb, model, generated_at)
    fill_document_control(wb, f"Test Cases - {model['project']}", f"Test cases of Zephyr Scale project {model['project']} with every recorded execution (IST). Generated {generated_at}.")
    wb.calculation.fullCalcOnLoad = True
    save_atomic(wb, dest)
    return {"testCases": len(cases), "executionColumnPairs": n_exec, "suiteRows": suite_rows}


def write_suite_sheet(wb, model: dict, generated_at: str) -> int:
    """The template's 'Test Suite' sheet: one block per Test Cycle, one row per test case with that cycle's status."""
    if "Test Suite" not in wb.sheetnames:
        return 0
    from copy import copy
    ws = wb["Test Suite"]
    proto = {k: [copy(ws.cell(row=r, column=c)._style) for c in range(1, 8)] for k, r in (("title", 1), ("head", 2), ("row", 3))}
    status_style = copy(ws["D3"]._style)
    reset_rules(ws)
    clear_below(ws, 1)
    row, written = 1, 0
    for block in model["blocks"]:
        cyc = block["cycle"]
        for j in range(1, 8):
            ws.cell(row=row, column=j)._style = copy(proto["title"][j - 1] if j in (1, 7) else proto["title"][1])
        ws.cell(row=row, column=1, value=f"TestSuite : {cyc.get('name') or cyc.get('key')} ({cyc.get('key')})")
        ws.cell(row=row, column=7, value="Execution Date : " + date_range(block))
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
        row += 1
        for j, h in enumerate(["Testcase #", "Functional Areas", "Description", "Issue key", "Status", "Priority", "Comments"], 1):
            ws.cell(row=row, column=j, value=h)._style = copy(proto["head"][j - 1])
        row += 1
        first = row
        for n, r in enumerate(block["rows"], 1):
            c = r["case"]
            comment = "; ".join(x for x in (("Defects: " + ", ".join(c["defects"])) if c["defects"] else "", r["note"]) if x)
            vals = [n, c["storyText"] or c["section"], c["title"], c["storyKey"], CASE_SHEET_STATUS.get(r["status"], r["status"]), c["priority"], comment]
            for j, v in enumerate(vals, 1):
                cell = ws.cell(row=row, column=j, value=v if v != "" else None)
                cell._style = copy(status_style if j == 5 else proto["row"][j - 1])
            ws.row_dimensions[row].height = est_height(ws, [(chr(64 + j), v) for j, v in enumerate(vals, 1)])
            row += 1
            written += 1
        if row > first:
            add_status_rules(ws, [f"E{first}:E{row - 1}"], "PASS,FAIL,IN PROGRESS,PENDING,BLOCKED", True)
        row += 1
    return written


def date_range(block: dict) -> str:
    if not block["from"]:
        return "not recorded"
    a, b = ist_date(block["from"]), ist_date(block["to"])
    return a if a == b else f"{a} to {b}"


def write_report_workbook(model: dict, template: Path, dest: Path, generated_at: str, lead: Optional[str] = None) -> dict:
    openpyxl = require_openpyxl()
    from copy import copy
    from openpyxl.worksheet.datavalidation import DataValidation
    wb = openpyxl.load_workbook(template)
    if "Report Template" not in wb.sheetnames:
        raise ExecError("TEMPLATE_INVALID", f"{template.name} has no 'Report Template' sheet.", td.EXIT_MISSING)
    if "Report templates" in wb.sheetnames:
        del wb["Report templates"]  # the older layout of the same report; the generated file uses the current one only
    ws = wb["Report Template"]
    proto = {k: [copy(ws.cell(row=r, column=c)._style) for c in range(1, 8)] for k, r in (("title", 13), ("head", 14), ("row", 15))}
    status_style = copy(ws["E15"]._style)
    reset_rules(ws)
    clear_below(ws, 13)
    ws.column_dimensions["B"].width = 14  # holds Jira keys such as PROJ-1234; the template leaves this column at the default
    blocks = model["blocks"]
    stamps = [d for b in blocks for d in (b["from"], b["to"]) if d]
    names = [b["cycle"].get("name") or b["cycle"].get("key") for b in blocks]
    ws["B2"].value = names[0] if len(names) == 1 else f"{model['project']} - {len(names)} Test Cycles ({', '.join(b['cycle'].get('key') for b in blocks)})"
    ws["F2"].value = date_range({"from": min(stamps), "to": max(stamps)} if stamps else {"from": None, "to": None})
    ws["D3"].value = ", ".join(sorted({n for b in blocks for n in b["executors"]})) or None
    ws["D4"].value = lead  # a sign-off typed by a person into the report being replaced; otherwise left empty
    row, written = 13, 0
    for block in blocks:
        cyc = block["cycle"]
        for j in range(1, 8):
            ws.cell(row=row, column=j)._style = copy(proto["title"][j - 1])
        ws.cell(row=row, column=1, value="TestSuite : ")
        ws.cell(row=row, column=2, value=f"{cyc.get('name') or cyc.get('key')} ({cyc.get('key')})")
        ws.cell(row=row, column=7, value="Execution Date : " + date_range(block))
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=6)
        row += 1
        for j, h in enumerate(["#", "User Story #", "User Story Description", "Test Cases/Test Scenarios", "Testcase #", "Status", "Comments"], 1):
            ws.cell(row=row, column=j, value=h)._style = copy(proto["head"][j - 1])
        row += 1
        for n, r in enumerate(block["rows"], 1):
            c = r["case"]
            ex = r["execution"]
            bits = []
            if c["defects"]:
                bits.append("Defect: " + ", ".join(c["defects"]))
            if r["status"] == "FAIL" and ex and ex.get("comment"):
                bits.append(ex["comment"][:300])
            if r["note"]:
                bits.append(r["note"])
            vals = [n, c["storyKey"], c["storyText"], c["title"], c["caseId"], REPORT_SHEET_STATUS.get(r["status"], r["status"]), "\n".join(bits)]
            for j, v in enumerate(vals, 1):
                cell = ws.cell(row=row, column=j, value=v if v != "" else None)
                cell._style = copy(status_style if j == 6 else proto["row"][j - 1])
            ws.row_dimensions[row].height = est_height(ws, [(chr(64 + j), v) for j, v in enumerate(vals, 1)])
            row += 1
            written += 1
        row += 1
    last = max(row - 1, 15)
    end = max(1001, last + 50)
    for r in range(5, 12):
        cell = ws.cell(row=r, column=6)
        if isinstance(cell.value, str) and cell.value.startswith("="):
            cell.value = re.sub(r"\$F\$13:\$F\d+", f"$F$13:$F{end}", cell.value)
    add_status_rules(ws, [f"F14:F{last}"], "PASS,FAIL,IN PROGRESS,UNEXECUTED,BLOCKED", True)
    fill_document_control(wb, f"Test Report - {model['project']}", f"Test report of Zephyr Scale project {model['project']} from the Test Cycles listed in the report. Generated {generated_at}.")
    wb.calculation.fullCalcOnLoad = True
    save_atomic(wb, dest)
    return {"testCycles": len(blocks), "rows": written}


def save_atomic(wb, dest: Path) -> None:
    """Write ``<dest>.new``; ``install`` puts it in place once every workbook of the build has been written."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    new = dest.with_name(dest.name + ".new")
    try:
        wb.save(new)
    except OSError as e:
        new.unlink(missing_ok=True)
        raise ExecError("WRITE_FAILED", f"Could not write {dest.name}: {e}", td.EXIT_IO)


def install(dest: Path, archive_dir: Path) -> Optional[Path]:
    """Move the freshly written ``<dest>.new`` into place; an existing file goes to archive/ first. Nothing is ever overwritten."""
    new = dest.with_name(dest.name + ".new")
    archived = None
    if dest.exists():
        archive_dir.mkdir(parents=True, exist_ok=True)
        stamp = now_ist_stamp()
        for n in range(100):
            archived = archive_dir / f"{dest.stem} (replaced {stamp}{'' if n == 0 else '-' + str(n)}){dest.suffix}"
            if not archived.exists():
                break
        try:
            os.replace(dest, archived)
        except PermissionError:
            new.unlink(missing_ok=True)
            raise ExecError("FILE_IN_USE", f"{dest.name} is open in Excel (or locked by another program). Close it and run the command again; "
                            "the build is repeatable and reads Zephyr's data, not the old workbook.", td.EXIT_USAGE)
    os.replace(new, dest)
    return archived


# --------------------------------------------------------------------------- commands

def out_dir_for(root: Path, a) -> Path:
    d = Path(a.out_dir) if getattr(a, "out_dir", None) else Path(root) / OUT_DIRNAME
    return ze._confined(root, d if d.is_absolute() else Path(root) / d)


def snapshot_path(root: Path) -> Path:
    return results_work_dir(root) / SNAPSHOT_NAME


def cmd_preflight(a) -> int:
    root = Path(a.root).resolve()
    cfg = ze.config_for(root)
    checks, problems = [], []
    try:
        res = zp.zephyr_preflight(cfg, a.project)
        checks.append({"check": "zephyr", "ok": True, "steps": res["steps"]})
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": zp.redact(str(e), cfg)}})
        return td.EXIT_USAGE
    try:
        import openpyxl
        checks.append({"check": "openpyxl", "ok": True, "version": openpyxl.__version__})
    except ImportError:
        problems.append({"code": "OPENPYXL_MISSING", "message": "The Python package openpyxl (Excel files) is not installed. Ask the user to approve "
                         "`python -m pip install \"openpyxl>=3.1\"`, install it, then check again."})
    for name in (TESTCASES_TEMPLATE, REPORT_TEMPLATE):
        p = Path(getattr(a, "testcases_template", None) or TEMPLATE_DIR / name) if name == TESTCASES_TEMPLATE else Path(getattr(a, "report_template", None) or TEMPLATE_DIR / name)
        if p.is_file():
            checks.append({"check": "template", "ok": True, "file": p.name})
        else:
            problems.append({"code": "TEMPLATE_MISSING", "message": f"Template not found: {p}"})
    out = out_dir_for(root, a)
    try:
        out.mkdir(parents=True, exist_ok=True)
        probe = out / ".write-test"
        probe.write_bytes(b"")
        probe.unlink()
        checks.append({"check": "output-folder", "ok": True, "folder": out.relative_to(root).as_posix()})
    except OSError as e:
        problems.append({"code": "OUTPUT_NOT_WRITABLE", "message": f"Cannot write to {out}: {e}"})
    td.emit({"ok": not problems, "checks": checks, "problems": problems, "config": cfg.public()})
    return td.EXIT_OK if not problems else td.EXIT_USAGE


def cmd_cycles(a) -> int:
    root = Path(a.root).resolve()
    cfg = ze.config_for(root)
    try:
        data = read_executions(cfg, a.project)
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": zp.redact(str(e), cfg)}})
        return td.EXIT_USAGE
    rows = cycle_activity(data)
    td.emit({"ok": True, "project": a.project, "cycles": rows[: a.limit], "shown": min(len(rows), a.limit), "total": len(rows),
             "withExecutions": sum(1 for r in rows if r["executed"]), "warnings": data["warnings"]})
    return td.EXIT_OK


def cmd_fetch(a) -> int:
    root = Path(a.root).resolve()
    cfg = ze.config_for(root)
    try:
        data = read_executions(cfg, a.project)
        keys = {c.get("key") for c in data["cycles"]}
        selected = sorted(keys - {None}, key=natural_key) if a.all_cycles else list(dict.fromkeys(a.cycle or []))
        if not selected:
            raise ExecError("NO_CYCLE", "Choose at least one Test Cycle (--cycle KEY) or --all-cycles.")
        unknown = [c for c in selected if c not in keys]
        if unknown:
            raise ExecError("CYCLE_NOT_FOUND", f"Test Cycle(s) not found in project {a.project}: {', '.join(unknown)}.")
        if a.all_cycles:  # an empty cycle has nothing to report
            have = {e["cycleKey"] for e in data["executions"]}
            selected = [c for c in selected if c in have]
        in_scope = {e["caseKey"] for e in data["executions"] if e["cycleKey"] in set(selected)}
        if not in_scope:
            raise ExecError("NO_EXECUTIONS", "The selected Test Cycle(s) hold no test executions, so there is nothing to report.", td.EXIT_MISSING)
        priorities = {str(v["id"]): v.get("name") for v in (optional_paged(cfg, "/priorities", {"projectKey": a.project}) or []) if v.get("id") is not None}
        folder_rows = optional_paged(cfg, "/folders", {"projectKey": a.project, "folderType": "TEST_CASE"}) or []
        folders = {str(f["id"]): f for f in folder_rows if f.get("id") is not None}

        def folder_path(fid: Optional[str]) -> str:
            parts, seen = [], set()
            while fid and fid in folders and fid not in seen:
                seen.add(fid)
                parts.append(folders[fid].get("name") or "")
                fid = str(folders[fid]["parentId"]) if folders[fid].get("parentId") is not None else None
            return "/".join(reversed([p for p in parts if p]))

        listed = {c["key"]: c for c in data["cases"] if c.get("key")}
        cases: dict[str, dict] = {}
        for key in sorted(in_scope, key=natural_key):
            c = listed.get(key)
            if not c or "name" not in c:
                _, c = zp.http(cfg, "GET", f"/testcases/{key}")
                c = c or {"key": key}
            k = urllib.parse.quote(key, safe="")
            steps, _ = paged(cfg, f"/testcases/{k}/teststeps", {})
            _, links = zp.http(cfg, "GET", f"/testcases/{k}/links")
            owner = c.get("owner")
            prio = c.get("priority") if isinstance(c.get("priority"), dict) else {}
            cases[key] = {
                "key": key, "id": c.get("id"), "name": c.get("name"), "objective": c.get("objective"), "precondition": c.get("precondition"),
                "priority": priorities.get(id_from(prio) or "") or prio.get("name") or None,
                "ownerId": (owner.get("accountId") if isinstance(owner, dict) else owner) or None, "labels": c.get("labels") or [],
                "folder": folder_path(id_from(c.get("folder"))), "createdOn": c.get("createdOn"),
                "steps": [{"description": (s.get("inline") or {}).get("description"), "testData": (s.get("inline") or {}).get("testData"),
                           "expectedResult": (s.get("inline") or {}).get("expectedResult")} for s in steps],
                "issueIds": [i.get("issueId") for i in ((links or {}).get("issues") or []) if isinstance(i, dict) and i.get("issueId") is not None],
            }
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": zp.redact(str(e), cfg)}})
        return td.EXIT_USAGE
    executions = [e for e in data["executions"] if e["caseKey"] in in_scope]
    snap = {"version": SNAPSHOT_VERSION, "fetchedAt": td.utc_now(), "project": a.project, "statuses": data["statuses"], "selectedCycles": selected,
            "cycles": [{"key": c.get("key"), "id": c.get("id"), "name": c.get("name")} for c in data["cycles"]],
            "executions": executions, "cases": cases, "warnings": data["warnings"]}
    ze._atomic_write(ze._confined(root, snapshot_path(root)), (json.dumps(snap, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    model = build_model(snap, read_lookup(None), local_knowledge(root, a.project))
    ze.history(root, "report_data_fetched", project=a.project, cycles=selected, testCases=len(cases), executions=len(executions))
    td.emit({"ok": True, "project": a.project, "selectedCycles": selected, "testCases": len(cases), "executions": len(executions),
             "snapshot": snapshot_path(root).relative_to(root).as_posix(), "needsLookup": model["unresolved"], "warnings": model["warnings"]})
    return td.EXIT_OK


def cmd_build(a) -> int:
    root = Path(a.root).resolve()
    snap = ze.read_json_file(snapshot_path(root), "fetched Zephyr data (run `fetch` first)")
    if not isinstance(snap, dict) or snap.get("version") != SNAPSHOT_VERSION or snap.get("project") != a.project:
        raise ExecError("SNAPSHOT_MISMATCH", f"The fetched data is not for project {a.project}. Run `fetch` again.", td.EXIT_MISSING)
    require_openpyxl()
    model = build_model(snap, read_lookup(a.lookup_file), local_knowledge(root, a.project), a.cycle or None)
    t_cases = Path(a.testcases_template) if a.testcases_template else TEMPLATE_DIR / TESTCASES_TEMPLATE
    t_report = Path(a.report_template) if a.report_template else TEMPLATE_DIR / REPORT_TEMPLATE
    for p in (t_cases, t_report):
        if not p.is_file():
            raise ExecError("TEMPLATE_MISSING", f"Template not found: {p}", td.EXIT_MISSING)
    out = out_dir_for(root, a)
    out.mkdir(parents=True, exist_ok=True)
    generated_at = dt.datetime.now(IST).strftime("%d-%m-%Y %H:%M:%S IST")
    safe = lambda s: re.sub(r'[<>:"/\\|?*]', "_", s).strip()  # noqa: E731
    keys = [b["cycle"]["key"] for b in model["blocks"]]
    cycle_label = keys[0] if len(keys) == 1 else ("_".join(keys) if len(keys) <= 3 else f"{len(keys)} cycles")
    f_cases = out / safe(f"{a.project} - Test Cases.xlsx")
    f_report = out / safe(f"{a.project} - Test Report - {cycle_label} - {dt.datetime.now(IST).strftime('%d-%m-%Y')}.xlsx")
    reviewers, lead = previous_reviewers(f_cases), previous_lead(f_report)
    c_info = write_testcases_workbook(model, t_cases, f_cases, generated_at, reviewers)
    r_info = write_report_workbook(model, t_report, f_report, generated_at, lead)
    c_info["reviewedByKept"] = sum(1 for c in model["cases"].values() if c["caseId"] in reviewers)
    r_info["leadSignOffKept"] = bool(lead)
    archived = [p for p in (install(f_cases, out / "archive"), install(f_report, out / "archive")) if p]
    changes = [{"testCase": c["caseId"], "zephyrKey": c["key"], "title": c["title"], "change": c["trend"], "kind": c["trendKind"]}
               for c in model["cases"].values() if c["trendKind"] in ("regression", "fixed", "changed")]
    counts: dict[str, int] = {}
    for b in model["blocks"]:
        for r in b["rows"]:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
    ze.history(root, "reports_built", project=a.project, cycles=keys, testCases=len(model["cases"]), files=[f_cases.name, f_report.name])
    rel = lambda p: p.relative_to(root).as_posix()  # noqa: E731
    td.emit({"ok": True, "project": a.project, "generatedAt": generated_at, "folder": rel(out),
             "files": {"testCases": rel(f_cases), "testReport": rel(f_report)}, "archived": [rel(p) for p in archived],
             "testCases": c_info, "report": r_info, "results": counts,
             "perCycle": [{"cycle": b["cycle"]["key"], "name": b["cycle"].get("name"), "rows": len(b["rows"]), "executionDate": date_range(b),
                           "results": {s: sum(1 for r in b["rows"] if r["status"] == s) for s in sorted({r["status"] for r in b["rows"]})}} for b in model["blocks"]],
             "changesSincePrevious": sorted(changes, key=lambda c: (c["kind"] != "regression", natural_key(c["zephyrKey"]))),
             "needsLookup": model["unresolved"], "warnings": model["warnings"],
             "leftBlankOnPurpose": ["Reviewed By (test-case sheet)", "Overall testing by lead (report)"],
             "note": "Those two are sign-offs, not Zephyr data: they stay empty unless a person typed them into the workbook being replaced, in which case they are kept."})
    return td.EXIT_OK


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *args):
        p = sub.add_parser(name)
        p.add_argument("--root", required=True)
        p.add_argument("--project", required=True)
        for flags, kw in args:
            p.add_argument(*flags if isinstance(flags, tuple) else (flags,), **kw)
        p.set_defaults(fn=fn)

    folder = [("--out-dir", {}), ("--testcases-template", {}), ("--report-template", {})]
    add("preflight", cmd_preflight, *folder)
    add("cycles", cmd_cycles, ("--limit", {"type": int, "default": 25}))
    add("fetch", cmd_fetch, ("--cycle", {"action": "append"}), ("--all-cycles", {"action": "store_true"}))
    add("build", cmd_build, ("--lookup-file", {}), ("--cycle", {"action": "append"}), *folder)
    a = ap.parse_args(argv)
    try:
        return a.fn(a)
    except ExecError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return e.exit_code
    except zp.PublishError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return e.exit_code
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return td.EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())

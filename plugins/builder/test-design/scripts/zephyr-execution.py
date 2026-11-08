#!/usr/bin/env python3
"""Publish Playwright execution results to Zephyr Scale (Cloud, REST API v2) and keep Jira bugs and their links recoverable.

Used only by ``/builder:update-execution-result``. It never runs tests, never edits test code or test cases, never deletes or
overwrites a remote record, and never prints or stores the API token. Jira is *not* contacted here: the command uses the existing
Jira connector to create the bug, then reports the key and numeric issue ID to ``bug-record``; this script links that bug to the
Zephyr test case. Zephyr connection settings, the HTTP layer and the case<->bug link call are shared with ``zephyr-publish.py``.

    zephyr-execution.py preflight   --root R --project KEY [--status-* NAME ...]
    zephyr-execution.py cycles      --root R --project KEY [--name TEXT] [--limit N]
    zephyr-execution.py map         --root R --project KEY (--scope-file F | --tests A,B) [--set TC-1=PROJ-T101]
    zephyr-execution.py begin       --root R --project KEY (--cycle KEY | --new-cycle NAME) --scope-file F --scope-text TEXT
                                    [--only-mapped] [--status-* NAME ...]
    zephyr-execution.py capture     --root R --pipeline-run RUN_ID
    zephyr-execution.py classify    --root R --test KEY --category C --confidence H|M|L --rationale TEXT [--by user]
    zephyr-execution.py narrate     --root R --test KEY|ID [--actual TEXT] [--summary TEXT]
    zephyr-execution.py publish     --root R
    zephyr-execution.py bug-drafts  --root R
    zephyr-execution.py bug-start|bug-record|bug-failed|bug-reset|bug-decline   --root R --test TEST_ID [...]
    zephyr-execution.py link-bugs   --root R
    zephyr-execution.py resolve     --root R (--cycle KEY | --retry-cycle | --test RESULT_KEY (--execution-id ID | --retry))
    zephyr-execution.py status|report --root R [--write]
    zephyr-execution.py abandon     --root R --reason TEXT

``--root`` is the project folder (it holds automation/, dependencies/ and test-design/).

Local state (``<root>/automation/execution-results/``): ``execution-run.json`` is the current update run (what was run, what is
published, which bug exists, which link is done); ``execution-history.jsonl`` is an append-only event log; a finished or
abandoned run is moved to ``archive/<id>.json``, never overwritten. Every remote write is recorded *before* the request, so a lost
reply is detected and never repeated blindly.

Exit codes: 0 ok, 1 some operations are not complete (see ``recovery``), 2 usage / configuration / preflight failure, 4 missing.
"""
from __future__ import annotations

import argparse
import datetime
import html
import importlib.util
import json
import mimetypes
import os
import platform
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import td_common as td  # noqa: E402


def _load_publisher():
    spec = importlib.util.spec_from_file_location("zephyr_publish_shared", HERE / "zephyr-publish.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


zp = _load_publisher()

RESULTS_DIRNAME = "execution-results"
RUN_NAME = "execution-run.json"
HISTORY_NAME = "execution-history.jsonl"
MAPPING_NAME = "test-mapping.json"
RUN_VERSION = 1
EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_STATUSES = {"pass": "Pass", "fail": "Fail"}  # only a trustworthy verdict reaches Zephyr; everything else is withheld (see decide)
BROWSER_NAMES = {"chromium": "Chromium", "firefox": "Firefox", "webkit": "WebKit"}
CASE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-T\d+$")
CYCLE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-R\d+$")
# Failure classes the engine's triage can name (failure-classifier.ts) -> the label this tool reports.
LABELS = {
    "application_defect": "application_defect", "script_defect": "automation_issue", "environment_issue": "infrastructure_issue",
    "test_data_or_precondition": "automation_issue", "flaky_or_intermittent": "flaky", "inconclusive": "needs_investigation",
}
CATEGORIES = tuple(LABELS)


class ExecError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = td.EXIT_USAGE):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code


# --------------------------------------------------------------------------- local state

def results_dir(root: Path) -> Path:
    return Path(root).resolve() / "automation" / RESULTS_DIRNAME


def _confined(root: Path, p: Path) -> Path:
    rp, rr = p.resolve(), Path(root).resolve()
    if rr != rp and rr not in rp.parents:
        raise ExecError("OUTSIDE_PROJECT", f"{p} is outside the project folder.", td.EXIT_CONFINED)
    return rp


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def load_run(root: Path, required: bool = True) -> Optional[dict]:
    p = results_dir(root) / RUN_NAME
    if not p.is_file():
        if required:
            raise ExecError("NO_RUN", "There is no update run in progress. Start one with `begin` (the command does this after the preflight).", td.EXIT_MISSING)
        return None
    try:
        run = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        raise ExecError("STATE_CORRUPT", f"{p.name} is not valid JSON. It was not changed. Move it aside only after checking Zephyr and Jira "
                        "for what was already created (executions, bugs).", td.EXIT_MISSING)
    if not isinstance(run, dict) or not isinstance(run.get("tests"), dict):
        raise ExecError("STATE_CORRUPT", f"{p.name} has an unexpected shape. It was not changed.", td.EXIT_MISSING)
    return run


def save_run(root: Path, run: dict) -> None:
    run["updatedAt"] = td.utc_now()
    _atomic_write(_confined(root, results_dir(root) / RUN_NAME), (json.dumps(run, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def history(root: Path, event: str, run: Optional[dict] = None, **fields: Any) -> None:
    entry = {"ts": td.utc_now(), "event": event, **({"updateRunId": run["updateRunId"]} if run else {}),
             **{k: v for k, v in fields.items() if v is not None}}
    p = _confined(root, results_dir(root) / HISTORY_NAME)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "ab") as fh:
        fh.write((json.dumps(entry, ensure_ascii=True) + "\n").encode("utf-8"))


def read_history(root: Path) -> list[dict]:
    p = results_dir(root) / HISTORY_NAME
    out = []
    if p.is_file():
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def archive_run(root: Path, run: dict, reason: str) -> Path:
    run["archivedAt"], run["archiveReason"] = td.utc_now(), reason
    dest = results_dir(root) / "archive" / f"{run['updateRunId']}.json"
    _atomic_write(_confined(root, dest), (json.dumps(run, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    history(root, "run_archived", run, reason=reason)
    (results_dir(root) / RUN_NAME).unlink(missing_ok=True)
    return dest


def read_json_file(path: Path, what: str, required: bool = True) -> Optional[Any]:
    if not path.is_file():
        if required:
            raise ExecError("FILE_MISSING", f"{what} not found: {path}", td.EXIT_MISSING)
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise ExecError("FILE_INVALID", f"{what} is not valid JSON: {path}", td.EXIT_MISSING)


# --------------------------------------------------------------------------- Zephyr access

def config_for(root: Path):
    try:
        return zp.load_config(Path(root).resolve())
    except zp.PublishError as e:
        raise ExecError(e.code, str(e))


def zcall(cfg, fn, *args, **kw):
    try:
        return fn(cfg, *args, **kw)
    except zp.ZephyrError as e:
        raise e


def execution_statuses(cfg, project: str) -> Optional[list[str]]:
    """Names of the test-execution statuses of the project, or None when the server does not list them."""
    try:
        _, data = zp.http(cfg, "GET", "/statuses", query={"projectKey": project, "statusType": "TEST_EXECUTION", "maxResults": 200})
    except zp.ZephyrError as e:
        if e.code in ("AUTH", "NETWORK"):
            raise
        return None
    values = (data or {}).get("values") if isinstance(data, dict) else None
    return [v.get("name") for v in values if isinstance(v, dict) and v.get("name")] if values is not None else None


def effective_statuses(a) -> dict:
    out = dict(DEFAULT_STATUSES)
    for k in out:
        v = getattr(a, "status_" + k, None)
        if v:
            out[k] = v
    return out


def check_statuses(names: Optional[list[str]], wanted: dict) -> tuple[list[str], list[str]]:
    """(errors, warnings): every wanted Zephyr status must exist in the project."""
    if names is None:
        return [], ["Zephyr Scale did not list the execution statuses, so the status names could not be checked in advance: "
                    + ", ".join(sorted(set(wanted.values())))]
    have = {n.lower() for n in names}
    errors = [f"Zephyr status \"{v}\" (used for {k}) does not exist in this project. Available: {', '.join(names)}. "
              f"Pass --status-{k} with one of them." for k, v in wanted.items() if v.lower() not in have]
    return errors, []


# --------------------------------------------------------------------------- mapping automated test -> Zephyr case

def _publish_records(root: Path) -> list[dict]:
    try:
        return list(zp.load_state(Path(root).resolve())["records"].values())
    except zp.PublishError as e:
        raise ExecError(e.code, str(e), e.exit_code)


def _handoff_cases(root: Path) -> dict:
    h = read_json_file(Path(root).resolve() / "dependencies" / "state" / "design-handoff.json", "design handoff", required=False)
    return (h or {}).get("cases", {}) if isinstance(h, dict) else {}


def load_overrides(root: Path) -> dict:
    d = read_json_file(results_dir(root) / MAPPING_NAME, MAPPING_NAME, required=False)
    return {k: v for k, v in (d or {}).items() if isinstance(v, str)} if isinstance(d, dict) else {}


def build_mapping(root: Path, project: str, test_ids: list[str]) -> dict:
    """Every test ID -> its Zephyr test-case key, from what was published (never from titles). Missing or ambiguous is reported, not guessed."""
    records = _publish_records(root)
    handoff = _handoff_cases(root)
    overrides = load_overrides(root)
    by_case: dict[str, list[dict]] = {}
    for r in records:
        by_case.setdefault(r.get("caseId", ""), []).append(r)
    mapped: dict[str, dict] = {}
    problems: list[dict] = []
    for tid in dict.fromkeys(test_ids):
        if tid.startswith("untagged:"):
            problems.append({"testId": tid, "problem": "untagged", "message": "The test title has no [ID], so it cannot be tied to a Zephyr test case. "
                             "Titles of pipeline-generated tests start with [<test case ID>]."})
            continue
        recs = by_case.get(tid, [])
        keys = {r["zephyrKey"] for r in recs if r.get("zephyrKey") and r.get("projectKey") == project}
        other = {r["zephyrKey"] for r in recs if r.get("zephyrKey") and r.get("projectKey") != project}
        if len(keys) > 1 and tid in handoff:  # the same ID published from several files: the design file decides
            keys = {r["zephyrKey"] for r in recs if r.get("zephyrKey") and r.get("projectKey") == project
                    and r.get("sourceFile") == handoff[tid].get("designFile")} or keys
        manual = overrides.get(tid)
        if manual and keys and manual not in keys:
            problems.append({"testId": tid, "problem": "ambiguous", "message": f"{tid} was mapped by hand to {manual} but the published state says "
                             f"{', '.join(sorted(keys))}. Remove the hand mapping or fix the state."})
        elif manual:
            mapped[tid] = {"zephyrKey": manual, "source": "manual"}
        elif len(keys) == 1:
            mapped[tid] = {"zephyrKey": next(iter(keys)), "source": "published-state"}
        elif len(keys) > 1:
            problems.append({"testId": tid, "problem": "ambiguous", "message": f"{tid} maps to several Zephyr test cases ({', '.join(sorted(keys))}). "
                             f"Decide which is right and set it with `map --set {tid}=<KEY>`."})
        else:
            unknown = [r for r in recs if not r.get("zephyrKey")]
            why = ("it was published to Zephyr project " + ", ".join(sorted(other)) + " only") if other else \
                  ("its earlier publish has an unknown outcome") if unknown else "it was never published to Zephyr"
            problems.append({"testId": tid, "problem": "missing", "message": f"No Zephyr test case is recorded for {tid}: {why}. Publish its test-case "
                             f"file first, or set the key with `map --set {tid}=<KEY>`."})
    return {"mapped": mapped, "problems": problems}


def scope_test_ids(path: Path) -> list[str]:
    d = read_json_file(path, "scope file")
    tests = d.get("tests") if isinstance(d, dict) else None
    if not isinstance(tests, list) or not tests:
        raise ExecError("SCOPE_EMPTY", "The scope file lists no tests. Check the file/tag you chose (`pipeline.ts exec list ...` shows what a scope selects).")
    return [t["testId"] for t in tests if isinstance(t, dict) and t.get("testId")]


# --------------------------------------------------------------------------- classification of one result

def _withheld(label: str, reason: str, needs_investigation: bool = False) -> dict:
    return {"label": label, "zephyrStatus": None, "publish": False, "bugEligible": False, "needsInvestigation": needs_investigation, "reason": reason}


def decide(outcome: str, failure: Optional[dict], blocked_by: Optional[list[str]], statuses: dict) -> dict:
    """Playwright result + the failure analysis -> label, Zephyr status, reason, bug eligibility.

    Only two kinds of result are sent to Zephyr: a pass, and a failure confirmed as an application defect (that one also gets a bug).
    Flaky runs, script / test-data / login problems, environment problems, skips and failures nobody has classified yet say nothing
    reliable about the product, so they are *withheld*: not sent, but kept in the local state and shown in the HTML report with the reason.
    """
    if outcome == "passed":
        return {"label": "passed", "zephyrStatus": statuses["pass"], "publish": True, "reason": None, "bugEligible": False, "needsInvestigation": False}
    if outcome == "skipped":
        why = f"Skipped because a test it depends on did not pass: {', '.join(blocked_by)}" if blocked_by else "Skipped by Playwright"
        return _withheld("skipped", why + ". It did not run, so there is no result to record.")
    if outcome == "flaky":
        return _withheld("flaky", "Failed first and passed only on retry. An unstable run says nothing reliable about the application, so it is not recorded in Zephyr.")
    cat = (failure or {}).get("category", "inconclusive")
    conf = (failure or {}).get("confidence", "low")
    by = (failure or {}).get("classifiedBy")
    signals = "; ".join((failure or {}).get("signals") or [])
    confirmed = cat == "application_defect" and by in ("agent", "user") and bool((failure or {}).get("rationale")) and conf in ("high", "medium")
    if cat == "application_defect" and confirmed:
        return {"label": "application_defect", "zephyrStatus": statuses["fail"], "publish": True, "bugEligible": True, "needsInvestigation": False,
                "reason": f"Confirmed application defect ({by}): {failure['rationale']}"}
    if cat == "application_defect":
        return _withheld("needs_investigation", "The failure looks like an application defect but nobody has confirmed it with evidence yet, so it is not recorded in Zephyr "
                         "and no bug is created. Confirm or reject it, then the result can be sent.", True)
    if cat == "script_defect":
        return _withheld("automation_issue", "Automation script problem (locator or script), not an application defect, so it is not recorded in Zephyr" + (f": {signals}" if signals else "."))
    if cat == "test_data_or_precondition":
        return _withheld("automation_issue", "Test data, precondition or login problem, not an application defect, so it is not recorded in Zephyr" + (f": {signals}" if signals else "."))
    if cat == "environment_issue":
        return _withheld("infrastructure_issue", "Environment or infrastructure problem, not an application defect, so it is not recorded in Zephyr" + (f": {signals}" if signals else "."))
    if cat == "flaky_or_intermittent":
        return _withheld("flaky", "Intermittent failure. An unstable run says nothing reliable about the application, so it is not recorded in Zephyr.")
    return _withheld("needs_investigation", "The evidence does not show whether this is an application, automation or environment problem, so it is not recorded in Zephyr "
                     "and no bug is created. It needs a look.", True)


# --------------------------------------------------------------------------- plain-words text

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
ROBOTIC = re.compile(r"expect\(|Call log:|Locator:|getBy[A-Z]\w*\(|page\.locator|\n\s+at .+:\d+:\d+|\bwaitFor|\x1b\[|TimeoutError|AssertionError|\bab-er-")


def strip_id(title: str) -> str:
    """'[TC-2] Cart total updates' -> 'Cart total updates' (the ID belongs to the test case, not to a sentence)."""
    return re.sub(r"^\s*\[[^\]]+\]\s*[-:–—]?\s*", "", title or "").strip() or (title or "").strip()


def browser_name(project: str) -> str:
    return BROWSER_NAMES.get((project or "").lower(), project or "the browser")


def plain_error(message: Optional[str]) -> str:
    """A Playwright error in plain words, for use only when nobody wrote the actual result by hand. Never invents: it rephrases what is there."""
    if not message:
        return ""
    text = ANSI.sub("", message).replace(chr(13), "")
    text = text.split("Call log:")[0].strip()
    if re.search(r"toBeVisible|toBeAttached", text) and re.search(r"element\(s\) not found|not visible|hidden|Expected: visible", text, re.I):
        return "The element that should be on the page was not visible."
    if re.search(r"toBeHidden|not\.toBeVisible", text):
        return "The element was still visible when it should have gone away."
    if "toHaveURL" in text:
        return "The page ended up on a different address than expected."
    if re.search(r"strict mode violation", text):
        return "More than one element matched where only one was expected."
    exp = re.search(r"Expected(?: string| pattern| substring)?:\s*(.+?)\s*(?:$|\s+Received\b)", text, re.M)
    got = re.search(r"Received(?: string| pattern)?:\s*(.+?)\s*$", text, re.M)
    if exp and got:
        return f"Expected {exp.group(1).strip()} but found {got.group(1).strip()}."
    if re.search(r"Timeout \d+ms exceeded|Test timeout of \d+ms exceeded", text):
        return "The page did not reach the expected state in time."
    first = next((ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().lower().startswith(("error:", "locator:", "timeout:"))), "")
    return _clip(first or text.splitlines()[0].strip(), 300)


def check_narrative(text: str) -> str:
    t = (text or "").strip()
    if len(t) < 8:
        raise ExecError("NARRATIVE_EMPTY", "Write what actually happened in a sentence or two of plain words.")
    if len(t) > 1500:
        raise ExecError("NARRATIVE_LONG", "Keep it short: a few sentences (1500 characters at most).")
    if ROBOTIC.search(t):
        raise ExecError("NARRATIVE_ROBOTIC", "That reads like a pasted Playwright error (expect(...), Locator, Call log, stack lines, tool names). Describe what a person "
                        "using the application saw instead, in plain words.")
    return t


# --------------------------------------------------------------------------- reading the pipeline run

def _first_failed_attempt(t: dict) -> dict:
    return next((a for a in t.get("attempts", []) if a.get("errors")), (t.get("attempts") or [{}])[0] if t.get("attempts") else {})


def _evidence(root: Path, t: dict, nonpass: bool) -> list[dict]:
    out, seen = [], set()
    for a in t.get("attempts", []):
        for att in a.get("attachments", []):
            name = att.get("name", "")
            p = att.get("path")
            if not p or p in seen or name not in ("screenshot", "video", "trace"):
                continue
            seen.add(p)
            candidate = Path(root).resolve() / "automation" / p
            abs_path = _confined(root, candidate) if candidate.is_file() else None
            item = {"path": p, "name": name, "contentType": att.get("contentType", "application/octet-stream"), "state": "pending", "note": None}
            if abs_path is None:
                item.update(state="missing", note="File not found on disk")
            elif name == "trace" and not nonpass:
                item.update(state="skipped", note="Trace of a passing test is not uploaded")
            elif abs_path.stat().st_size > EVIDENCE_MAX_BYTES:
                item.update(state="skipped", note=f"Larger than {EVIDENCE_MAX_BYTES // (1024 * 1024)} MB; kept locally")
            else:
                item["bytes"] = abs_path.stat().st_size
            out.append(item)
    return out


def capture(root: Path, run: dict, pipeline_run: str) -> dict:
    rroot = Path(root).resolve()
    rdir = rroot / "dependencies" / "runs" / pipeline_run
    if not rdir.is_dir():
        raise ExecError("PIPELINE_RUN_MISSING", f"Pipeline run {pipeline_run} not found at {rdir}.", td.EXIT_MISSING)
    results = read_json_file(rdir / "execution-results.json", "execution results")
    if results.get("runnerError") and not results.get("tests"):
        raise ExecError("NOTHING_EXECUTED", f"The runner produced no results: {results['runnerError']}. Nothing was captured or published.")
    analysis = read_json_file(rdir / "failure-analysis.json", "failure analysis", required=False) or {}
    failures = {f["key"]: f for f in analysis.get("failures", [])}
    blocked = {b["key"]: b.get("blockedBy", []) for b in analysis.get("blocked", [])}
    specs_doc = read_json_file(rdir / "test-specs.json", "test specs", required=False) or {}
    specs = {s["id"]: s for s in specs_doc.get("specs", []) if isinstance(s, dict) and "id" in s}
    manifest = read_json_file(rdir / "manifest.json", "run manifest", required=False) or {}
    app = ((manifest.get("config") or {}).get("app")) or {}
    test_ids = [t["testId"] for t in results["tests"]]
    mapping = build_mapping(root, run["project"]["key"], test_ids)
    problems = {p["testId"]: p for p in mapping["problems"]}
    run["pipelineRunId"], run["pipelineLabel"] = pipeline_run, results.get("label", "initial")
    run["executedAt"] = results.get("executedAt")
    run["environment"] = {"os": f"{platform.system()} {platform.release()}".strip(), "browsers": sorted({t["project"] for t in results["tests"]}),
                          "baseUrl": app.get("baseUrl"), "applicationEnvironment": app.get("environment"),
                          "buildVersion": None, "note": "Build/version is not recorded by the pipeline."}
    refreshed = 0
    for t in results["tests"]:
        key = t["key"]
        existing = run["tests"].get(key)
        if existing and existing["execution"]["state"] not in ("pending", "withheld"):
            continue  # already published (or being published): its recorded classification is frozen
        spec = specs.get(t["testId"], {})
        failed_at = _first_failed_attempt(t)
        err = (failed_at.get("errors") or [{}])[0]
        decision = decide(t["outcome"], failures.get(key), blocked.get(key), run["statuses"])
        m = mapping["mapped"].get(t["testId"])
        rec = {
            "key": key, "testId": t["testId"], "title": t["title"], "file": t["file"], "line": t.get("line"), "project": t["project"],
            "zephyrKey": m["zephyrKey"] if m else None, "mappingSource": m["source"] if m else None,
            "mappingProblem": problems.get(t["testId"]) if decision["publish"] else None,
            "playwright": {"outcome": t["outcome"], "attempts": len(t.get("attempts", [])),
                           "durationMs": sum(int(a.get("durationMs", 0)) for a in t.get("attempts", [])),
                           "finalAttemptStatus": (t.get("attempts") or [{}])[-1].get("status")},
            "classification": {"category": (failures.get(key) or {}).get("category"), "confidence": (failures.get(key) or {}).get("confidence"),
                               "classifiedBy": (failures.get(key) or {}).get("classifiedBy"), "rationale": (failures.get(key) or {}).get("rationale"),
                               "signals": (failures.get(key) or {}).get("signals", [])},
            "label": decision["label"], "zephyrStatus": decision["zephyrStatus"], "reason": decision["reason"],
            "bugEligible": decision["bugEligible"] and m is not None, "needsInvestigation": decision["needsInvestigation"],
            "error": {"message": err.get("message"), "stack": err.get("stack"), "location": err.get("location")} if err.get("message") else None,
            "spec": {"steps": spec.get("steps", []), "expectedResults": spec.get("expectedResults", []), "priority": spec.get("priority"),
                     "preconditions": spec.get("preconditions", [])} if spec else None,
            "evidence": _evidence(root, t, t["outcome"] != "passed"),
            "execution": {"state": "withheld" if not decision["publish"] else ("pending" if m else "unmapped"), "id": None, "error": None},
            "narrative": (existing or {}).get("narrative") or {},
        }
        run["tests"][key] = rec
        refreshed += 1
    # one bug per failing test case (a failure in several browsers is still one defect)
    for rec in run["tests"].values():
        if rec["bugEligible"] and rec["testId"] not in run["bugs"]:
            run["bugs"][rec["testId"]] = {"testId": rec["testId"], "zephyrKey": rec["zephyrKey"], "state": "pending", "key": None, "issueId": None,
                                          "marker": f"ab-{run['updateRunId'].lower()}-{re.sub(r'[^A-Za-z0-9_-]', '-', rec['testId']).lower()}",
                                          "link": {"state": "none"}, "resultKeys": []}
    for tid in [t for t, b in run["bugs"].items() if b["state"] == "pending" and not any(r["testId"] == t and r["bugEligible"] for r in run["tests"].values())]:
        del run["bugs"][tid]  # reclassified since: no confirmed defect any more
    for bug in run["bugs"].values():
        bug["resultKeys"] = sorted(k for k, r in run["tests"].items() if r["testId"] == bug["testId"] and r["bugEligible"])
    run["captured"] = True
    run["capturedAt"] = td.utc_now()
    return {"tests": len(results["tests"]), "refreshed": refreshed, "runnerError": results.get("runnerError"),
            "unmapped": sorted(r["testId"] for r in run["tests"].values() if r["execution"]["state"] == "unmapped")}


# --------------------------------------------------------------------------- publishing executions

def _clip(text: Optional[str], n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _when(run: dict) -> str:
    raw = run.get("executedAt") or ""
    try:
        d = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return f"{d.day} {d.strftime('%b %Y')}"
    except ValueError:
        return ""


def _where(run: dict, rec: dict) -> str:
    """'Chromium on Windows 10 against staging (https://app.test) on 8 Nov 2026' - what a tester would write, not a field list."""
    env = run.get("environment", {})
    app = env.get("applicationEnvironment")
    url = env.get("baseUrl")
    s = browser_name(rec["project"]) + (f" on {env['os']}" if env.get("os") else "")
    if app or url:
        s += " against " + (app or "the test site") + (f" ({url})" if url else "")
    when = _when(run)
    return s + (f" on {when}" if when else "")


def actual_text(rec: dict, cfg=None) -> str:
    """What happened, in plain words: the hand-written actual result when there is one, else the error rephrased."""
    said = ((rec.get("narrative") or {}).get("actual") or "").strip()
    text = said or plain_error((rec.get("error") or {}).get("message"))
    return zp.redact(text, cfg) if text else ""


def expected_text(rec: dict) -> str:
    spec = rec.get("spec") or {}
    lines = [s["expected"] for s in spec.get("steps") or [] if s.get("expected")] + list(spec.get("expectedResults") or [])
    return "; ".join(dict.fromkeys(x.strip().rstrip(".") for x in lines if x and x.strip()))


def execution_comment(run: dict, rec: dict, cfg) -> str:
    """The note on the Zephyr execution. Written like a tester's note: what happened and where, no tool names, run IDs or raw errors."""
    where = html.escape(_where(run, rec))
    if rec["label"] == "passed":
        # A pass records what was observed too, not only that nothing went wrong: the hand-written account when there is one, else the
        # test case's own expected results (the run completed every step and its checks held, so they are what was seen).
        said = ((rec.get("narrative") or {}).get("actual") or "").strip()
        exp = expected_text(rec)
        observed = zp.redact(said, cfg) if said else (f"Every step went through and the application showed what the test case expects: {exp}." if exp
                                                      else "Every step went through and the application behaved as the test case describes.")
        return f"Ran this check in {where}.<br><br><b>Actual result:</b> {html.escape(observed)}"
    parts = []
    actual = actual_text(rec, cfg)
    parts.append("<b>Actual result:</b> " + html.escape(actual or "The check failed, but no detail was captured."))
    exp = expected_text(rec)
    if exp:
        parts.append("<b>Expected:</b> " + html.escape(exp) + ".")
    parts.append(f"Seen in {where}.")
    return "<br><br>".join(parts)


def multipart_upload(cfg, path: str, file_path: Path, content_type: str) -> tuple[int, Any]:
    boundary = "----ab" + secrets.token_hex(12)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_path.name}\"\r\nContent-Type: {content_type}\r\n\r\n").encode() \
        + file_path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(cfg.base_url + path, data=body, method="POST", headers={
        "Authorization": f"Bearer {cfg.token}", "Accept": "application/json", "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "builder/zephyr-execution"})
    try:
        with urllib.request.urlopen(req, timeout=zp.TIMEOUT * 4) as resp:
            return resp.status, zp._json_or_none(resp.read())
    except urllib.error.HTTPError as e:
        raise zp._http_error(cfg, e.code, zp._json_or_none(e.read()), True)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise zp.ZephyrError("NETWORK", f"Could not reach Zephyr Scale: {zp.redact(str(getattr(e, 'reason', e)), cfg)}", ambiguous=True)


def upload_evidence(root: Path, run: dict, rec: dict, cfg) -> None:
    caps = run.setdefault("capabilities", {})
    ref = rec["execution"].get("key") or rec["execution"]["id"]
    for ev in rec["evidence"]:
        if ev["state"] != "pending":
            continue
        if caps.get("evidenceUpload") == "unsupported":
            ev.update(state="unsupported", note="This Zephyr Scale deployment did not accept attachments on executions; the file stays in the pipeline run folder")
            continue
        try:
            multipart_upload(cfg, f"/testexecutions/{urllib.parse.quote(str(ref), safe='')}/attachments", Path(root).resolve() / "automation" / ev["path"],
                             mimetypes.guess_type(ev["path"])[0] or ev["contentType"])
            ev.update(state="uploaded", note=None)
            caps["evidenceFailures"] = 0
        except zp.ZephyrError as e:
            if e.status in (404, 405, 501):
                caps["evidenceUpload"] = "unsupported"
                ev.update(state="unsupported", note="Attachments on executions are not supported by this Zephyr Scale deployment; the file stays in the pipeline run folder")
            else:
                ev.update(state="failed", note=zp.redact(str(e), cfg)[:300])
                caps["evidenceFailures"] = caps.get("evidenceFailures", 0) + 1
                if caps["evidenceFailures"] >= 3:
                    caps["evidenceUpload"] = "unsupported"
            if e.code in ("AUTH", "RATE_LIMITED"):
                break
        history(root, "evidence_" + ev["state"], run, resultKey=rec["key"], path=ev["path"], code=None)
        save_run(root, run)


def publish(root: Path, run: dict) -> dict:
    if not run.get("captured"):
        raise ExecError("NOT_CAPTURED", "Nothing to publish yet: capture the pipeline run's results first.")
    cfg = config_for(root)
    project, cycle = run["project"]["key"], run["cycle"]
    if cycle.get("state") != "ready":
        raise ExecError("CYCLE_NOT_READY", "The Test Cycle is not confirmed (an earlier create had an unknown outcome). Use `resolve --cycle KEY` or `--retry-cycle`.")
    stop = False
    for rec in sorted(run["tests"].values(), key=lambda r: r["key"]):
        ex = rec["execution"]
        if stop or ex["state"] in ("unmapped", "withheld"):
            continue  # withheld: not a trustworthy verdict, kept out of Zephyr (shown in the report)
        if ex["state"] == "blocked":
            continue
        if ex["state"] != "done":
            body = {"projectKey": project, "testCaseKey": rec["zephyrKey"], "testCycleKey": cycle["key"], "statusName": rec["zephyrStatus"],
                    "comment": execution_comment(run, rec, cfg), "executionTime": rec["playwright"]["durationMs"]}
            if run.get("executedAt"):  # Zephyr wants yyyy-MM-dd'T'HH:mm:ss'Z' (no fractional seconds)
                body["actualEndDate"] = re.sub(r"\.\d+", "", run["executedAt"]) if run["executedAt"].endswith("Z") else run["executedAt"]
            ex.update(state="started", startedAt=td.utc_now(), error=None)
            save_run(root, run)  # recorded before the request: a lost reply is detected, not repeated
            history(root, "execution_started", run, resultKey=rec["key"], zephyrKey=rec["zephyrKey"], cycle=cycle["key"])
            try:
                _, created = zp.http(cfg, "POST", "/testexecutions", body)
                eid = (created or {}).get("id")
                ekey = (created or {}).get("key")
                if eid is None and not ekey:
                    raise zp.ZephyrError("BAD_RESPONSE", "Zephyr Scale answered without an execution ID.", ambiguous=True)
                ex.update(state="done", id=eid, key=ekey, publishedAt=td.utc_now(), error=None)
                history(root, "execution_created", run, resultKey=rec["key"], zephyrKey=rec["zephyrKey"], executionId=eid, status=rec["zephyrStatus"])
            except zp.ZephyrError as e:
                msg = zp.redact(str(e), cfg)
                if e.ambiguous:
                    ex.update(state="blocked", error=msg + " It may or may not exist in Zephyr; it will not be created again until you resolve it.")
                else:
                    ex.update(state="failed", error=msg)
                history(root, "execution_error", run, resultKey=rec["key"], code=e.code, status=e.status, ambiguous=e.ambiguous)
                if e.code in ("AUTH", "RATE_LIMITED", "NETWORK"):
                    stop = True
                save_run(root, run)
                continue
            save_run(root, run)
        if ex["state"] == "done" and any(e["state"] == "pending" for e in rec["evidence"]):
            upload_evidence(root, run, rec, cfg)
    save_run(root, run)
    return {"published": sum(1 for r in run["tests"].values() if r["execution"]["state"] == "done")}


# --------------------------------------------------------------------------- bugs

def bug_description(run: dict, rec: dict, bug: dict) -> tuple[str, list[str]]:
    """Markdown for the Jira bug, written the way a tester files one. Only recorded facts are used; a section with nothing recorded is left
    out (and named in the returned list so the command can tell the person), never filled with invented text."""
    missing: list[str] = []
    env = run.get("environment", {})
    spec = rec.get("spec") or {}
    steps = spec.get("steps") or []
    pre = spec.get("preconditions") or []
    zkey, cycle = rec["zephyrKey"], run["cycle"].get("key")
    actual = actual_text(rec)
    expected = [x.strip() for x in dict.fromkeys([s["expected"] for s in steps if s.get("expected")] + list(spec.get("expectedResults") or [])) if x and x.strip()]
    shots = [e for e in rec["evidence"] if e["state"] != "missing"]
    browsers = ", ".join(browser_name(b) for b in sorted({r["project"] for r in run["tests"].values() if r["testId"] == rec["testId"]})) or browser_name(rec["project"])

    md = [f"Found while running the automated regression check for \"{strip_id(rec['title'])}\"."]
    if steps:
        md.append("**Steps to reproduce**\n" + (("Before you start: " + "; ".join(pre).rstrip(".") + ".\n\n") if pre else "")
                  + "\n".join(f"{n}. {s['action'].strip()}" for n, s in enumerate(steps, 1)))
    else:
        md.append(f"**Steps to reproduce**\nSee test case {zkey} in Zephyr.")
        missing.append("steps to reproduce")
    if expected:
        md.append("**Expected result**\n" + ("\n".join(f"- {x}" for x in expected) if len(expected) > 1 else expected[0]))
    else:
        missing.append("expected result")
    if actual:
        md.append("**Actual result**\n" + actual)
    else:
        md.append("**Actual result**\nThe check failed, but no further detail was captured.")
        missing.append("actual result")
    where = [f"- Browser: {browsers}"] + ([f"- OS: {env['os']}"] if env.get("os") else []) \
        + ([f"- Environment: {env['applicationEnvironment']}" + (f" ({env['baseUrl']})" if env.get("baseUrl") else "")] if env.get("applicationEnvironment")
           else ([f"- URL: {env['baseUrl']}"] if env.get("baseUrl") else []))
    if env.get("buildVersion"):
        where.append(f"- Build: {env['buildVersion']}")
    else:
        missing.append("build/version")
    md.append("**Environment**\n" + "\n".join(where))
    if shots:
        md.append("**Evidence**\n" + "\n".join(f"- {e['name'].capitalize()}: `{e['path']}`" for e in shots))
    else:
        missing.append("screenshot/video/trace")
    if not spec.get("priority"):
        missing.append("priority (set by triage)")
    md.append(f"**Related**\nTest case {zkey}" + (f", Test Cycle {cycle}" if cycle else "") + ".")
    return "\n\n".join(md), missing


def bug_drafts(root: Path, run: dict) -> dict:
    earlier: dict[str, list[dict]] = {}
    for ev in read_history(root):
        if ev.get("event") == "bug_created" and ev.get("updateRunId") != run["updateRunId"]:
            earlier.setdefault(ev.get("testId", ""), []).append({"bugKey": ev.get("bugKey"), "updateRunId": ev.get("updateRunId")})
    drafts, check = [], []
    for tid, bug in sorted(run["bugs"].items()):
        if bug["state"] in ("created", "declined"):
            continue
        if bug["state"] != "creating" and not bug["resultKeys"]:
            continue
        rec = run["tests"][bug["resultKeys"][0]] if bug["resultKeys"] else None
        if bug["state"] == "creating":
            check.append({"testId": tid, "marker": bug["marker"], "message": "An earlier attempt may have created this bug but the outcome was not recorded. Search Jira for the "
                          f"marker label before creating anything: labels = \"{bug['marker']}\". If found run bug-record with its key; otherwise run bug-reset."})
            continue
        nar = rec.get("narrative") or {}
        short = plain_error((rec.get("error") or {}).get("message")).splitlines()[0] if (rec.get("error") or {}).get("message") else ""
        summary = _clip(nar.get("summary") or (f"{strip_id(rec['title'])}: {short.rstrip('.')}" if short else strip_id(rec["title"])), 240)
        description, missing = bug_description(run, rec, bug)
        prio = (rec.get("spec") or {}).get("priority")
        wrote = bool(nar.get("summary")) and bool(nar.get("actual"))
        drafts.append({"testId": tid, "resultKey": rec["key"], "zephyrKey": rec["zephyrKey"], "summary": summary, "description": description, "contentFormat": "markdown",
                       "labels": [bug["marker"]], "priority": prio, "priorityNote": None if prio else "No priority recorded for this test: leave it to the project's default / triage",
                       "notAvailable": missing, "marker": bug["marker"], "previousBugs": earlier.get(tid, []),
                       "writtenByHand": wrote,
                       "needsWriting": None if wrote else "The title and the actual result were not written by hand, so they are the error text rephrased. Write them with "
                                                          "`narrate --test <resultKey> --summary ... --actual ...` from the evidence, then run bug-drafts again."})
    return {"drafts": drafts, "needsCheck": check}


def _bug(run: dict, test_id: str) -> dict:
    bug = run["bugs"].get(test_id)
    if not bug:
        raise ExecError("NO_BUG", f"{test_id} has no bug in this update run (only confirmed application defects get one).", td.EXIT_MISSING)
    return bug


def link_bugs(root: Path, run: dict) -> dict:
    cfg = None
    done = failed = 0
    for bug in sorted(run["bugs"].values(), key=lambda b: b["testId"]):
        if bug["state"] != "created" or bug["link"].get("state") == "done":
            continue
        cfg = cfg or config_for(root)
        try:
            result = zp._ensure_link(cfg, bug["zephyrKey"], int(bug["issueId"]))
            bug["link"] = {"state": "done", "result": result, "at": td.utc_now(), "error": None}
            history(root, "bug_linked", run, testId=bug["testId"], bugKey=bug["key"], zephyrKey=bug["zephyrKey"], result=result)
            done += 1
        except zp.ZephyrError as e:
            bug["link"] = {"state": "failed", "error": zp.redact(str(e), cfg), "at": td.utc_now()}
            history(root, "bug_link_error", run, testId=bug["testId"], bugKey=bug["key"], code=e.code, status=e.status)
            failed += 1
            if e.code in ("AUTH", "RATE_LIMITED", "NETWORK"):
                save_run(root, run)
                break
        save_run(root, run)
    return {"linked": done, "failed": failed}


# --------------------------------------------------------------------------- completeness + report

def operations_open(run: dict) -> list[str]:
    todo = []
    if not run.get("captured"):
        todo.append("results of the pipeline run have not been captured")
    for rec in run["tests"].values():
        st = rec["execution"]["state"]
        if st in ("pending", "started", "failed"):
            todo.append(f"publish {rec['key']} ({st})")
        elif st == "blocked":
            todo.append(f"resolve the unknown outcome of {rec['key']}")
    for bug in run["bugs"].values():
        if bug["state"] in ("pending", "creating", "failed"):
            todo.append(f"bug for {bug['testId']} ({bug['state']})")
        elif bug["state"] == "created" and bug["link"].get("state") != "done":
            todo.append(f"link {bug['key']} to {bug['zephyrKey']}")
    return todo


def build_report(root: Path, run: dict) -> dict:
    tests = list(run["tests"].values())
    c = lambda pred: sum(1 for r in tests if pred(r))  # noqa: E731
    executed = {
        "total": len(tests), "passed": c(lambda r: r["label"] == "passed"), "failedApplication": c(lambda r: r["label"] == "application_defect"),
        "automationIssues": c(lambda r: r["label"] == "automation_issue"), "infrastructureIssues": c(lambda r: r["label"] == "infrastructure_issue"),
        "flaky": c(lambda r: r["label"] == "flaky"), "needsInvestigation": c(lambda r: r["label"] == "needs_investigation"),
        "skipped": c(lambda r: r["label"] == "skipped"),
    }
    pub = {"published": c(lambda r: r["execution"]["state"] == "done"), "failed": c(lambda r: r["execution"]["state"] == "failed"),
           "unknownOutcome": c(lambda r: r["execution"]["state"] == "blocked"), "pending": c(lambda r: r["execution"]["state"] in ("pending", "started")),
           "notPublishedNoMapping": c(lambda r: r["execution"]["state"] == "unmapped"), "withheld": c(lambda r: r["execution"]["state"] == "withheld")}
    bugs = list(run["bugs"].values())
    bug_sum = {"eligible": len(bugs), "created": sum(1 for b in bugs if b["state"] == "created"), "declined": sum(1 for b in bugs if b["state"] == "declined"),
               "notCreated": sum(1 for b in bugs if b["state"] in ("pending", "creating", "failed")),
               "linked": sum(1 for b in bugs if b["link"].get("state") == "done"),
               "linkFailed": sum(1 for b in bugs if b["link"].get("state") == "failed"),
               "createdNotLinked": sum(1 for b in bugs if b["state"] == "created" and b["link"].get("state") != "done")}
    recovery = []
    if pub["failed"] or pub["pending"]:
        recovery.append("Run `publish` again: only the results that are not in Zephyr are sent; tests are not run again.")
    if pub["unknownOutcome"]:
        recovery.append("Some executions have an unknown outcome (lost reply). Check the Test Cycle in Zephyr, then `resolve --test <key> --execution-id <ID>` (it exists) or `--retry` (it does not).")
    if pub["notPublishedNoMapping"]:
        recovery.append("Tests without a Zephyr test case were not published: " + ", ".join(sorted(r["testId"] for r in tests if r["execution"]["state"] == "unmapped")) + ". Fix the mapping, then start a new update.")
    if bug_sum["notCreated"]:
        recovery.append("Bugs not created yet: run `bug-drafts` and create them with the Jira connector (nothing is created twice).")
    if bug_sum["createdNotLinked"]:
        recovery.append("Bugs exist but are not linked to their Zephyr test case: run `link-bugs` (the bugs are not created again).")
    if pub["withheld"]:
        recovery.append(f"{pub['withheld']} result(s) were deliberately not sent to Zephyr (flaky, script or environment problems, skipped, or not yet classified). "
                        "They are in the HTML report with the reason for each. A failure you confirm as an application defect with `classify` can still be sent.")
    ev: dict[str, int] = {}
    for r in tests:
        for e in r["evidence"]:
            ev[e["state"]] = ev.get(e["state"], 0) + 1
    rows = [{"testId": r["testId"], "project": r["project"], "title": r["title"], "zephyrKey": r["zephyrKey"], "playwright": r["playwright"]["outcome"], "classification": r["label"],
             "zephyrStatus": r["zephyrStatus"], "execution": r["execution"]["state"], "withheldReason": r["reason"] if r["execution"]["state"] == "withheld" else None, "executionId": r["execution"].get("id"), "reason": r["reason"],
             "error": r["execution"].get("error"), "mappingProblem": (r.get("mappingProblem") or {}).get("message"),
             "bug": (run["bugs"].get(r["testId"]) or {}).get("key") if r["bugEligible"] else None,
             "bugLink": (run["bugs"].get(r["testId"]) or {}).get("link", {}).get("state") if r["bugEligible"] else None} for r in sorted(tests, key=lambda r: r["key"])]
    pr = run.get("pipelineRunId")
    return {"updateRunId": run["updateRunId"], "project": run["project"]["key"], "scope": run["scope"], "testCycle": run["cycle"],
            "execution": executed, "publishing": pub, "bugs": bug_sum, "evidence": ev, "tests": rows, "recovery": recovery,
            "needsAttention": [r["testId"] for r in tests if r["label"] == "needs_investigation"], "open": operations_open(run),
            "complete": not operations_open(run),
            "locations": {"state": f"automation/{RESULTS_DIRNAME}/{RUN_NAME}", "history": f"automation/{RESULTS_DIRNAME}/{HISTORY_NAME}",
                          "pipelineRun": f"dependencies/runs/{pr}/" if pr else None,
                          "playwrightReports": f"automation/reports/{pr}/" if pr else None, "evidence": f"automation/test-results/{pr}/" if pr else None},
            "note": "Test execution and result publishing are separate: the 'execution' block says how the tests went, the 'publishing' and 'bugs' blocks say what reached Zephyr and Jira."}


def report_markdown(rep: dict) -> str:
    e, p, b = rep["execution"], rep["publishing"], rep["bugs"]
    lines = [f"# Execution result update {rep['updateRunId']}", "", f"- Zephyr project: {rep['project']}", f"- Test Cycle: {rep['testCycle'].get('key')} ({rep['testCycle'].get('name')})",
             f"- Scope: {rep['scope'].get('text')}", "",
             "## Test execution", f"Total {e['total']} · passed {e['passed']} · application failures {e['failedApplication']} · automation issues {e['automationIssues']} · "
             f"infrastructure issues {e['infrastructureIssues']} · flaky {e['flaky']} · needs investigation {e['needsInvestigation']} · skipped {e['skipped']}", "",
             "## Publishing to Zephyr", f"Published {p['published']} · not sent on purpose {p['withheld']} · failed {p['failed']} · unknown outcome {p['unknownOutcome']} · pending {p['pending']} · no mapping {p['notPublishedNoMapping']}", "",
             "## Jira bugs", f"Eligible {b['eligible']} · created {b['created']} · declined {b['declined']} · not created {b['notCreated']} · linked to Zephyr {b['linked']} · link failed {b['linkFailed']}", "",
             "| Test | Zephyr | Playwright | Class | Zephyr status | Published | Bug | Link |", "|---|---|---|---|---|---|---|---|"]
    for r in rep["tests"]:
        lines.append(f"| {r['testId']} ({r['project']}) | {r['zephyrKey'] or '-'} | {r['playwright']} | {r['classification']} | {r['zephyrStatus'] or 'not sent'} | {r['execution']} | {r['bug'] or '-'} | {r['bugLink'] or '-'} |")
    if rep["recovery"]:
        lines += ["", "## Recovery"] + [f"- {x}" for x in rep["recovery"]]
    lines += ["", "## Locations"] + [f"- {k}: {v}" for k, v in rep["locations"].items() if v]
    return "\n".join(lines) + "\n"


LABEL_TEXT = {"passed": "Passed", "application_defect": "Application defect", "automation_issue": "Script / test-data issue", "infrastructure_issue": "Environment issue",
              "flaky": "Flaky", "needs_investigation": "Needs investigation", "skipped": "Skipped"}
STATE_TEXT = {"done": "Sent to Zephyr", "pending": "Waiting to be sent", "started": "Sending", "failed": "Send failed", "blocked": "Unknown outcome - check Zephyr",
              "unmapped": "No Zephyr test case", "withheld": "Not sent to Zephyr"}


def report_html(rep: dict, run: dict, cfg=None) -> str:
    """One self-contained HTML page: every result, including the ones deliberately kept out of Zephyr, with the reason and the raw error."""
    e = html.escape
    red = (lambda s: zp.redact(s, cfg)) if cfg else (lambda s: s)
    pr = run.get("pipelineRunId")
    recs = sorted(run["tests"].values(), key=lambda r: r["key"])
    withheld = [r for r in recs if r["execution"]["state"] == "withheld"]

    def ev_links(r):
        out = [f'<a href="../../{e(ev["path"])}">{e(ev["name"])}</a>' for ev in r["evidence"] if ev["state"] != "missing"]
        return " &middot; ".join(out) or "&ndash;"

    def zephyr_cell(r):
        st = r["execution"]["state"]
        if st == "done":
            return f'<span class="ok">Sent</span> &middot; {e(r["zephyrKey"] or "")} &middot; {e(r["zephyrStatus"] or "")}'
        return f'<span class="{"hold" if st == "withheld" else "warn"}">{e(STATE_TEXT.get(st, st))}</span>'

    rows = []
    for r in recs:
        bug = run["bugs"].get(r["testId"]) if r["bugEligible"] else None
        bug_cell = e(bug["key"]) if bug and bug.get("key") else ("&ndash;" if not bug else "not filed yet")
        tries = f' ({r["playwright"]["attempts"]} tries)' if r["playwright"]["attempts"] > 1 else ""
        detail = ""
        if r["playwright"]["outcome"] in ("failed", "flaky"):
            raw_err = ANSI.sub("", red(((r.get("error") or {}).get("message")) or ""))
            detail = (f'<details><summary>Details</summary><p><b>What happened:</b> {e(actual_text(r, cfg) or "no detail captured")}</p>'
                      + (f'<pre>{e(raw_err)}</pre>' if raw_err else "") + f'<p class="meta">Evidence: {ev_links(r)}</p></details>')
        rows.append(f'<tr><td><b>{e(r["testId"])}</b><br>{e(strip_id(r["title"]))}{detail}</td><td>{e(browser_name(r["project"]))}</td>'
                    f'<td>{e(r["playwright"]["outcome"])}{tries}</td>'
                    f'<td><span class="tag {e(r["label"])}">{e(LABEL_TEXT.get(r["label"], r["label"]))}</span></td><td>{zephyr_cell(r)}</td><td>{bug_cell}</td></tr>')
    held = []
    for r in withheld:
        raw = ANSI.sub("", red(((r.get("error") or {}).get("message")) or ""))
        said = ""
        if r["playwright"]["outcome"] != "skipped":
            said = f'<p><b>What happened:</b> {e(actual_text(r, cfg) or "no detail captured")}</p>'
        why = (r.get("classification") or {}).get("rationale")
        held.append(f'<div class="card"><h3>{e(r["testId"])} &middot; {e(browser_name(r["project"]))} '
                    f'<span class="tag {e(r["label"])}">{e(LABEL_TEXT.get(r["label"], r["label"]))}</span></h3><p>{e(strip_id(r["title"]))}</p>'
                    f'<p><b>Why it was not sent to Zephyr:</b> {e(red(r["reason"] or ""))}</p>' + said
                    + (f'<p><b>How it was classified:</b> {e(red(why))}</p>' if why else "")
                    + (f'<details><summary>Full error</summary><pre>{e(raw)}</pre></details>' if raw else "")
                    + f'<p class="meta">Evidence: {ev_links(r)} &middot; {e(r["file"])}:{e(str(r.get("line") or "?"))}</p></div>')
    x, p, b = rep["execution"], rep["publishing"], rep["bugs"]
    cards = "".join(f'<div class="stat"><div class="n">{n}</div><div class="l">{e(l)}</div></div>' for n, l in (
        (x["total"], "Tests run"), (x["passed"], "Passed"), (x["failedApplication"], "Application defects"),
        (p["withheld"], "Not sent to Zephyr"), (p["published"], "Sent to Zephyr"), (b["created"], "Bugs filed")))
    link = f' <a href="../../reports/{e(pr)}/initial/html/index.html">Playwright HTML report</a>' if pr else ""
    css = ("body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}main{max-width:1100px;margin:0 auto;padding:24px 16px}"
           "h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}.sub{color:#5b6475;margin:0 0 18px}"
           ".stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.stat{background:#fff;border:1px solid #dde1e8;border-radius:8px;padding:12px}"
           ".n{font-size:26px;font-weight:600}.l{color:#5b6475;font-size:13px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde1e8}"
           "th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e8ebf0;vertical-align:top}th{background:#eef0f4;font-size:13px}"
           ".tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#e8ebf0}.tag.passed{background:#d9f2e0}.tag.application_defect{background:#fbd9d9}"
           ".tag.flaky,.tag.automation_issue,.tag.infrastructure_issue{background:#fdecc8}.tag.needs_investigation{background:#dce6fb}.ok{color:#1b7a3d}.hold{color:#8a5a00}.warn{color:#b3261e}"
           ".card{background:#fff;border:1px solid #dde1e8;border-left:4px solid #e0a82e;border-radius:6px;padding:4px 14px 10px;margin:10px 0}.card h3{font-size:15px;margin:10px 0 2px}"
           ".card p{margin:6px 0}.meta{color:#5b6475;font-size:13px}pre{white-space:pre-wrap;background:#f1f3f6;padding:10px;border-radius:6px;font-size:12px;overflow:auto}"
           "a{color:#1a56c4}@media(prefers-color-scheme:dark){body{background:#14171d;color:#e4e7ee}.stat,table,.card{background:#1d222b;border-color:#333b49}th{background:#262c37}"
           "td{border-color:#2c3340}.l,.sub,.meta{color:#9aa4b5}pre{background:#12151a}a{color:#7fb0ff}.tag{background:#2c3340}}")
    held_html = f"<h2>Not sent to Zephyr ({len(withheld)})</h2>" + "".join(held) if held else "<h2>Not sent to Zephyr</h2><p>Nothing was held back.</p>"
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>Execution results {e(run['updateRunId'])}</title><style>{css}</style></head><body><main>"
            f"<h1>Execution results</h1><p class=\"sub\">Zephyr project {e(rep['project'])} &middot; Test Cycle {e(str(rep['testCycle'].get('key')))} "
            f"({e(str(rep['testCycle'].get('name')))}) &middot; {e(rep['scope'].get('text') or '')} &middot; {e(_when(run))} &middot; "
            f"update {e(run['updateRunId'])}</p><div class=\"stats\">{cards}</div>"
            "<p class=\"sub\" style=\"margin-top:12px\">Only passes and confirmed application defects are recorded in Zephyr. Flaky runs, script or test-data problems, "
            "environment problems, skipped tests and failures nobody has classified yet are kept out of it; they are listed here with the reason." + link + "</p>"
            + held_html
            + "<h2>All results</h2><table><thead><tr><th>Test</th><th>Browser</th><th>Playwright</th><th>Classification</th><th>Zephyr</th><th>Bug</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table></main></body></html>\n")


# --------------------------------------------------------------------------- commands

def _status_args(p):
    for k in DEFAULT_STATUSES:
        p.add_argument(f"--status-{k}", dest=f"status_{k}", metavar="NAME")


def cmd_preflight(a) -> int:
    root = Path(a.root).resolve()
    cfg = config_for(root)
    try:
        res = zp.zephyr_preflight(cfg, a.project)
        wanted = effective_statuses(a)
        errors, warnings = check_statuses(execution_statuses(cfg, a.project), wanted)
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": zp.redact(str(e), cfg)}})
        return td.EXIT_USAGE
    env_path = root / ".env"
    if env_path.is_file() and zp._env_file_ignored(root, env_path) is False:
        warnings.append(".env is not git-ignored. Add it to .gitignore so the token is never committed.")
    out = {"ok": not errors, "zephyr": res, "statuses": wanted, "errors": errors, "warnings": warnings, "config": cfg.public()}
    td.emit(out)
    return td.EXIT_OK if not errors else td.EXIT_USAGE


def cmd_cycles(a) -> int:
    cfg = config_for(Path(a.root))
    values, start = [], 0
    try:
        while len(values) < 500:
            _, data = zp.http(cfg, "GET", "/testcycles", query={"projectKey": a.project, "maxResults": 100, "startAt": start})
            page = (data or {}).get("values", []) if isinstance(data, dict) else []
            values += page
            if not page or (data or {}).get("isLast", len(page) < 100):
                break
            start += len(page)
    except zp.ZephyrError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": zp.redact(str(e), cfg)}})
        return td.EXIT_USAGE
    items = [{"key": v.get("key"), "name": v.get("name"), "status": (v.get("status") or {}).get("id") if isinstance(v.get("status"), dict) else v.get("status")} for v in values]
    if a.name:
        items = [i for i in items if a.name.lower() in (i["name"] or "").lower()]
    items.sort(key=lambda i: int(re.sub(r"\D", "", (i["key"] or "0").split("-")[-1]) or 0), reverse=True)
    td.emit({"ok": True, "cycles": items[: a.limit], "shown": min(len(items), a.limit), "matching": len(items)})
    return td.EXIT_OK


def cmd_map(a) -> int:
    root = Path(a.root).resolve()
    if a.set:
        tid, _, key = a.set.partition("=")
        if not tid or not CASE_KEY.match(key) or not key.upper().startswith(a.project.upper() + "-"):
            raise ExecError("KEY_FORMAT", f"Use --set <TEST-ID>=<{a.project}-T123>: a Zephyr test-case key of project {a.project}.")
        cfg = config_for(root)
        try:
            zp.http(cfg, "GET", f"/testcases/{urllib.parse.quote(key, safe='')}")
        except zp.ZephyrError as e:
            raise ExecError(e.code, f"Could not confirm {key} in Zephyr: {zp.redact(str(e), cfg)}")
        current = load_overrides(root)
        current[tid] = key
        _atomic_write(_confined(root, results_dir(root) / MAPPING_NAME), (json.dumps(current, indent=2, sort_keys=True) + "\n").encode())
        history(root, "mapping_set", testId=tid, zephyrKey=key)
    ids = scope_test_ids(Path(a.scope_file)) if a.scope_file else [t for t in (a.tests or "").split(",") if t]
    if not ids:
        raise ExecError("SCOPE_EMPTY", "Give --scope-file (output of `exec list`) or --tests.")
    m = build_mapping(root, a.project, ids)
    td.emit({"ok": not m["problems"], "project": a.project, "mapped": m["mapped"], "problems": m["problems"], "total": len(set(ids))})
    return td.EXIT_OK if not m["problems"] else td.EXIT_FINDINGS


def cmd_begin(a) -> int:
    root = Path(a.root).resolve()
    if not (root / "automation").is_dir():
        raise ExecError("NOT_SCAFFOLDED", f"{root / 'automation'} does not exist. Run /builder:init (or /builder:do-automation) first.", td.EXIT_MISSING)
    existing = load_run(root, required=False)
    if existing:
        if operations_open(existing):
            raise ExecError("RUN_IN_PROGRESS", f"Update run {existing['updateRunId']} is not finished ({len(operations_open(existing))} open operation(s)). Resume it "
                            "(publish / bug-drafts / link-bugs), or run `abandon --reason ...` to set it aside (its record is kept in the archive).")
        archive_run(root, existing, "finished")
    ids = scope_test_ids(Path(a.scope_file))
    mapping = build_mapping(root, a.project, ids)
    if mapping["problems"] and not a.only_mapped:
        td.emit({"ok": False, "error": {"code": "MAPPING_INCOMPLETE", "message": "Some tests in the scope have no single, stable Zephyr test case. Nothing was started."},
                 "problems": mapping["problems"]})
        return td.EXIT_USAGE
    cfg = config_for(root)
    statuses = effective_statuses(a)
    try:
        zp.zephyr_preflight(cfg, a.project)
        errors, _ = check_statuses(execution_statuses(cfg, a.project), statuses)
        if errors:
            raise ExecError("STATUS_UNKNOWN", " ".join(errors))
        run = {"version": RUN_VERSION, "updateRunId": f"ER-{td.utc_now().replace('-', '').replace(':', '').replace('T', '-')[:15]}-{secrets.token_hex(2)}",
               "createdAt": td.utc_now(), "project": {"key": a.project}, "scope": {"text": a.scope_text, "testIds": sorted(set(ids)),
               "onlyMapped": bool(a.only_mapped), "notRun": sorted(p["testId"] for p in mapping["problems"])},
               "statuses": statuses, "cycle": {}, "tests": {}, "bugs": {}, "captured": False, "capabilities": {}}
        if a.cycle:
            if not CYCLE_KEY.match(a.cycle) or not a.cycle.upper().startswith(a.project.upper() + "-"):
                raise ExecError("CYCLE_KEY_FORMAT", f"A Test Cycle key looks like {a.project}-R12.")
            _, cyc = zp.http(cfg, "GET", f"/testcycles/{urllib.parse.quote(a.cycle, safe='')}")
            run["cycle"] = {"key": a.cycle, "id": (cyc or {}).get("id"), "name": (cyc or {}).get("name"), "created": False, "state": "ready"}
            save_run(root, run)
        else:
            run["cycle"] = {"name": a.new_cycle, "created": True, "state": "creating"}
            save_run(root, run)  # recorded before the request
            try:
                _, cyc = zp.http(cfg, "POST", "/testcycles", {"projectKey": a.project, "name": a.new_cycle,
                                                              "description": f"Created by Automation Builder for update run {run['updateRunId']}."})
            except zp.ZephyrError as e:
                if not e.ambiguous:
                    (results_dir(root) / RUN_NAME).unlink(missing_ok=True)
                raise
            run["cycle"].update(key=(cyc or {}).get("key"), id=(cyc or {}).get("id"), state="ready")
            if not run["cycle"]["key"]:
                run["cycle"]["state"] = "creating"
                save_run(root, run)
                raise zp.ZephyrError("BAD_RESPONSE", "Zephyr Scale created the cycle but returned no key.", ambiguous=True)
            save_run(root, run)
        history(root, "run_begun", run, project=a.project, cycle=run["cycle"].get("key"), createdCycle=run["cycle"]["created"], scope=a.scope_text)
    except zp.ZephyrError as e:
        msg = zp.redact(str(e), cfg)
        if e.ambiguous:
            msg += (" The Test Cycle may or may not exist. Check Zephyr for a cycle named \"%s\", then run `resolve --cycle <KEY>` (it exists) or `resolve --retry-cycle`." % a.new_cycle)
        td.emit({"ok": False, "error": {"code": e.code, "message": msg}})
        return td.EXIT_USAGE
    td.emit({"ok": True, "updateRunId": run["updateRunId"], "testCycle": run["cycle"], "scope": run["scope"], "statuses": statuses,
             "mappingProblems": mapping["problems"]})
    return td.EXIT_OK


def cmd_capture(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    if run["cycle"].get("state") != "ready":
        raise ExecError("CYCLE_NOT_READY", "The Test Cycle is not confirmed yet. Use `resolve --cycle KEY` or `--retry-cycle` first.")
    if run.get("captured") and run.get("pipelineRunId") != a.pipeline_run:
        raise ExecError("CAPTURE_EXISTS", f"This update already holds the results of pipeline run {run['pipelineRunId']}. Finish it (or `abandon`) and begin a new update for another run.")
    info = capture(root, run, a.pipeline_run)
    save_run(root, run)
    history(root, "captured", run, pipelineRunId=a.pipeline_run, tests=info["tests"])
    rep = build_report(root, run)
    td.emit({"ok": True, **info, "execution": rep["execution"], "plan": [{"key": r["key"], "zephyrKey": r["zephyrKey"], "label": r["label"], "zephyrStatus": r["zephyrStatus"],
                                                                        "bugEligible": r["bugEligible"], "reason": r["reason"]} for r in sorted(run["tests"].values(), key=lambda r: r["key"])]})
    return td.EXIT_OK


def cmd_classify(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    rec = run["tests"].get(a.test) or next((r for r in run["tests"].values() if r["testId"] == a.test), None)
    if not rec:
        raise ExecError("NO_TEST", f"No test {a.test} in this update run.", td.EXIT_MISSING)
    if a.category not in CATEGORIES:
        raise ExecError("CATEGORY", f"--category must be one of {', '.join(CATEGORIES)}.")
    if not a.rationale.strip():
        raise ExecError("RATIONALE", "A rationale citing the evidence is required.")
    if rec["execution"]["state"] not in ("pending", "withheld", "unmapped"):
        raise ExecError("ALREADY_PUBLISHED", f"{rec['key']} is already published ({rec['execution']['state']}); its classification is final for this update.")
    if rec["playwright"]["outcome"] != "failed":
        raise ExecError("NOT_FAILED", "Only a failed result can be reclassified.")
    conf = {"high": "high", "h": "high", "medium": "medium", "m": "medium", "low": "low", "l": "low"}.get(a.confidence.lower())
    if not conf:
        raise ExecError("CONFIDENCE", "--confidence must be high, medium or low.")
    rec["classification"].update(category=a.category, confidence=conf, classifiedBy=a.by, rationale=a.rationale.strip())
    d = decide("failed", rec["classification"], None, run["statuses"])
    if d["publish"] and not rec["zephyrKey"]:  # it was withheld before, so its mapping was never looked at
        m = build_mapping(root, run["project"]["key"], [rec["testId"]])
        if m["mapped"].get(rec["testId"]):
            rec.update(zephyrKey=m["mapped"][rec["testId"]]["zephyrKey"], mappingSource=m["mapped"][rec["testId"]]["source"], mappingProblem=None)
        else:
            rec["mappingProblem"] = m["problems"][0] if m["problems"] else None
    rec.update(label=d["label"], zephyrStatus=d["zephyrStatus"], reason=d["reason"], needsInvestigation=d["needsInvestigation"], bugEligible=d["bugEligible"] and rec["zephyrKey"] is not None)
    rec["execution"]["state"] = "withheld" if not d["publish"] else ("pending" if rec["zephyrKey"] else "unmapped")
    if not d["publish"]:
        rec["mappingProblem"] = None
    if rec["bugEligible"] and rec["testId"] not in run["bugs"]:
        run["bugs"][rec["testId"]] = {"testId": rec["testId"], "zephyrKey": rec["zephyrKey"], "state": "pending", "key": None, "issueId": None,
                                      "marker": f"ab-{run['updateRunId'].lower()}-{re.sub(r'[^A-Za-z0-9_-]', '-', rec['testId']).lower()}", "link": {"state": "none"}, "resultKeys": [rec["key"]]}
    elif not rec["bugEligible"] and rec["testId"] in run["bugs"] and run["bugs"][rec["testId"]]["state"] == "pending":
        del run["bugs"][rec["testId"]]
    save_run(root, run)
    history(root, "classified", run, resultKey=rec["key"], category=a.category, by=a.by)
    td.emit({"ok": True, "key": rec["key"], "label": rec["label"], "zephyrStatus": rec["zephyrStatus"], "sentToZephyr": rec["execution"]["state"] != "withheld",
             "execution": rec["execution"]["state"], "bugEligible": rec["bugEligible"]})
    return td.EXIT_OK


def cmd_narrate(a) -> int:
    """Record the plain-words account of a failure (and, for a bug, its title) written by hand from the evidence."""
    root = Path(a.root).resolve()
    run = load_run(root)
    recs = [run["tests"][a.test]] if a.test in run["tests"] else [r for r in run["tests"].values() if r["testId"] == a.test]
    if not recs:
        raise ExecError("NO_TEST", f"No test {a.test} in this update run.", td.EXIT_MISSING)
    if not a.actual and not a.summary:
        raise ExecError("NARRATIVE_EMPTY", "Give --actual (what happened) and/or --summary (the bug title).")
    try:
        cfg = config_for(root)
    except ExecError:
        cfg = None
    actual = zp.redact(check_narrative(a.actual), cfg) if a.actual else None
    summary = None
    if a.summary:
        summary = zp.redact(check_narrative(a.summary), cfg)
        if "\n" in summary or len(summary) > 240:
            raise ExecError("SUMMARY_FORMAT", "The bug title is one line, at most 240 characters.")
    for rec in recs:
        if actual and rec["execution"]["state"] in ("started", "done", "blocked"):
            raise ExecError("ALREADY_PUBLISHED", f"{rec['key']} is already in Zephyr; its note is final.")
        bug = run["bugs"].get(rec["testId"])
        if summary and bug and bug["state"] in ("created", "creating"):
            raise ExecError("BUG_EXISTS", f"{rec['testId']} already has a bug (or one being created); its title can no longer change here.")
    for rec in recs:
        nar = rec.setdefault("narrative", {})
        if actual:
            nar["actual"] = actual
        if summary:
            nar["summary"] = summary
        nar["by"], nar["at"] = "agent", td.utc_now()
    save_run(root, run)
    history(root, "narrated", run, resultKeys=",".join(r["key"] for r in recs))
    td.emit({"ok": True, "results": [r["key"] for r in recs], "actual": bool(actual), "summary": bool(summary)})
    return td.EXIT_OK


def cmd_publish(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    publish(root, run)
    rep = build_report(root, run)
    td.emit({"ok": rep["publishing"]["failed"] == 0 and rep["publishing"]["unknownOutcome"] == 0 and rep["publishing"]["pending"] == 0, "publishing": rep["publishing"],
             "evidence": rep["evidence"], "evidenceUpload": run.get("capabilities", {}).get("evidenceUpload", "supported-or-untried"),
             "tests": [{k: r[k] for k in ("testId", "project", "zephyrKey", "zephyrStatus", "execution", "executionId", "error")} for r in rep["tests"]], "recovery": rep["recovery"]})
    return td.EXIT_OK if rep["publishing"]["failed"] + rep["publishing"]["unknownOutcome"] + rep["publishing"]["pending"] == 0 else td.EXIT_FINDINGS


def cmd_bug_drafts(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    td.emit({"ok": True, **bug_drafts(root, run)})
    return td.EXIT_OK


def cmd_bug_start(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    bug = _bug(run, a.test)
    if bug["state"] in ("created", "creating"):
        raise ExecError("BUG_EXISTS", f"{a.test} already has a bug ({bug.get('key') or 'creation started, outcome unknown'}). Nothing is created twice.")
    bug.update(state="creating", startedAt=td.utc_now(), error=None)
    save_run(root, run)  # recorded before the Jira call
    history(root, "bug_create_started", run, testId=a.test, marker=bug["marker"])
    td.emit({"ok": True, "testId": a.test, "state": "creating", "marker": bug["marker"]})
    return td.EXIT_OK


def cmd_bug_record(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    bug = _bug(run, a.test)
    if bug["state"] == "created" and bug["key"] != a.key:
        raise ExecError("BUG_EXISTS", f"{a.test} already has bug {bug['key']}; refusing to replace it with {a.key}.")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*-\d+", a.key):
        raise ExecError("BUG_KEY_FORMAT", f"'{a.key}' is not a Jira issue key like PROJ-123.")
    if not re.fullmatch(r"\d+", str(a.issue_id)):
        raise ExecError("ISSUE_ID_FORMAT", "--issue-id must be the numeric Jira issue ID (from the connector's create/get result), not the key.")
    bug.update(state="created", key=a.key, issueId=int(a.issue_id), createdAt=td.utc_now(), error=None)
    bug["link"] = bug["link"] if bug["link"].get("state") == "done" else {"state": "pending"}
    save_run(root, run)
    history(root, "bug_created", run, testId=a.test, bugKey=a.key, issueId=int(a.issue_id))
    td.emit({"ok": True, "testId": a.test, "bugKey": a.key, "link": "pending: run link-bugs"})
    return td.EXIT_OK


def cmd_bug_failed(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    bug = _bug(run, a.test)
    if bug["state"] == "created":
        raise ExecError("BUG_EXISTS", f"{a.test} already has bug {bug['key']}.")
    bug.update(state="failed", error=_clip(a.error, 500))
    save_run(root, run)
    history(root, "bug_create_error", run, testId=a.test)
    td.emit({"ok": True, "testId": a.test, "state": "failed"})
    return td.EXIT_OK


def cmd_bug_reset(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    bug = _bug(run, a.test)
    if bug["state"] == "created":
        raise ExecError("BUG_EXISTS", f"{a.test} already has bug {bug['key']}; it cannot be reset.")
    bug.update(state="pending", error=None)
    save_run(root, run)
    history(root, "bug_reset", run, testId=a.test)
    td.emit({"ok": True, "testId": a.test, "state": "pending"})
    return td.EXIT_OK


def cmd_bug_decline(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    bug = _bug(run, a.test)
    if bug["state"] in ("created", "creating"):
        raise ExecError("BUG_EXISTS", f"{a.test} already has a bug (or a creation of unknown outcome); it cannot be declined.")
    bug.update(state="declined", declinedReason=_clip(a.reason, 300))
    save_run(root, run)
    history(root, "bug_declined", run, testId=a.test)
    td.emit({"ok": True, "testId": a.test, "state": "declined"})
    return td.EXIT_OK


def cmd_link_bugs(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    res = link_bugs(root, run)
    rep = build_report(root, run)
    td.emit({"ok": res["failed"] == 0 and rep["bugs"]["createdNotLinked"] == 0, **res, "bugs": rep["bugs"],
             "details": [{"testId": b["testId"], "bugKey": b["key"], "zephyrKey": b["zephyrKey"], "link": b["link"]} for b in run["bugs"].values() if b["state"] == "created"]})
    return td.EXIT_OK if rep["bugs"]["createdNotLinked"] == 0 else td.EXIT_FINDINGS


def cmd_resolve(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    if a.cycle or a.retry_cycle:
        cyc = run["cycle"]
        if cyc.get("state") == "ready":
            raise ExecError("ALREADY_RESOLVED", f"The Test Cycle is already {cyc.get('key')}.")
        if a.cycle:
            if not CYCLE_KEY.match(a.cycle):
                raise ExecError("CYCLE_KEY_FORMAT", "A Test Cycle key looks like PROJ-R12.")
            cyc.update(key=a.cycle, state="ready", adopted=True)
        else:
            archive_run(root, run, "cycle create retried")
            td.emit({"ok": True, "mode": "retry-cycle", "next": "Run `begin` again with --new-cycle; the unfinished record was archived."})
            return td.EXIT_OK
        save_run(root, run)
        history(root, "cycle_resolved", run, cycle=a.cycle)
        td.emit({"ok": True, "testCycle": cyc})
        return td.EXIT_OK
    rec = run["tests"].get(a.test)
    if not rec:
        raise ExecError("NO_TEST", f"No result {a.test} (use the full key such as TC-1@chromium).", td.EXIT_MISSING)
    if rec["execution"]["state"] != "blocked":
        raise ExecError("NOT_BLOCKED", f"{a.test} is not waiting for a decision (state: {rec['execution']['state']}).")
    if a.execution_id:
        rec["execution"].update(state="done", id=a.execution_id, resolvedAt=td.utc_now(), error=None, adopted=True)
    else:
        rec["execution"].update(state="pending", error=None)
    save_run(root, run)
    history(root, "execution_resolved", run, resultKey=a.test, executionId=a.execution_id, mode="adopt" if a.execution_id else "retry")
    td.emit({"ok": True, "key": a.test, "state": rec["execution"]["state"]})
    return td.EXIT_OK


def cmd_status(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root, required=False)
    if not run:
        td.emit({"ok": True, "run": None, "message": "No update run in progress."})
        return td.EXIT_OK
    rep = build_report(root, run)
    td.emit({"ok": True, "updateRunId": run["updateRunId"], "pipelineRunId": run.get("pipelineRunId"), "captured": run["captured"], "complete": rep["complete"], "open": rep["open"],
             "testCycle": run["cycle"], "execution": rep["execution"], "publishing": rep["publishing"], "bugs": rep["bugs"]})
    return td.EXIT_OK


def cmd_report(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    rep = build_report(root, run)
    if a.write:
        dest = results_dir(root) / "reports" / f"{run['updateRunId']}.md"
        _atomic_write(_confined(root, dest), report_markdown(rep).encode("utf-8"))
        rep["reportFile"] = f"automation/{RESULTS_DIRNAME}/reports/{run['updateRunId']}.md"
        try:
            cfg = config_for(root)
        except ExecError:
            cfg = None
        hdest = results_dir(root) / "reports" / f"{run['updateRunId']}.html"
        _atomic_write(_confined(root, hdest), report_html(rep, run, cfg).encode("utf-8"))
        rep["htmlReportFile"] = f"automation/{RESULTS_DIRNAME}/reports/{run['updateRunId']}.html"
    td.emit({"ok": True, **rep})
    return td.EXIT_OK if rep["complete"] else td.EXIT_FINDINGS


def cmd_abandon(a) -> int:
    root = Path(a.root).resolve()
    run = load_run(root)
    dest = archive_run(root, run, "abandoned: " + _clip(a.reason, 200))
    td.emit({"ok": True, "archived": str(dest.relative_to(root).as_posix()), "note": "Nothing was deleted in Zephyr or Jira."})
    return td.EXIT_OK


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *args, status=False):
        p = sub.add_parser(name)
        p.add_argument("--root", required=True)
        for spec in args:
            flags, kw = spec[0], spec[1]
            p.add_argument(*flags if isinstance(flags, tuple) else (flags,), **kw)
        if status:
            _status_args(p)
        p.set_defaults(fn=fn)
        return p

    proj = ("--project", {"required": True})
    add("preflight", cmd_preflight, proj, status=True)
    add("cycles", cmd_cycles, proj, ("--name", {}), ("--limit", {"type": int, "default": 20}))
    add("map", cmd_map, proj, ("--scope-file", {}), ("--tests", {}), ("--set", {}))
    p = add("begin", cmd_begin, proj, ("--scope-file", {"required": True}), ("--scope-text", {"required": True}), ("--only-mapped", {"action": "store_true"}), status=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--cycle")
    g.add_argument("--new-cycle")
    add("capture", cmd_capture, ("--pipeline-run", {"required": True}))
    add("classify", cmd_classify, ("--test", {"required": True}), ("--category", {"required": True}), ("--confidence", {"required": True}),
        ("--rationale", {"required": True}), ("--by", {"default": "user", "choices": ["user", "agent"]}))
    add("narrate", cmd_narrate, ("--test", {"required": True}), ("--actual", {}), ("--summary", {}))
    add("publish", cmd_publish)
    add("bug-drafts", cmd_bug_drafts)
    add("bug-start", cmd_bug_start, ("--test", {"required": True}))
    add("bug-record", cmd_bug_record, ("--test", {"required": True}), ("--key", {"required": True}), ("--issue-id", {"required": True}))
    add("bug-failed", cmd_bug_failed, ("--test", {"required": True}), ("--error", {"required": True}))
    add("bug-reset", cmd_bug_reset, ("--test", {"required": True}))
    add("bug-decline", cmd_bug_decline, ("--test", {"required": True}), ("--reason", {"required": True}))
    add("link-bugs", cmd_link_bugs)
    p = add("resolve", cmd_resolve, ("--cycle", {}), ("--retry-cycle", {"action": "store_true"}), ("--test", {}), ("--execution-id", {}), ("--retry", {"action": "store_true"}))
    add("status", cmd_status)
    add("report", cmd_report, ("--write", {"action": "store_true"}))
    add("abandon", cmd_abandon, ("--reason", {"required": True}))
    a = ap.parse_args(argv)
    if a.cmd == "resolve" and not (a.cycle or a.retry_cycle or (a.test and (a.execution_id or a.retry))):
        ap.error("resolve needs --cycle KEY, --retry-cycle, or --test KEY with --execution-id ID / --retry")
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

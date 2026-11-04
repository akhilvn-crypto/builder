"""Shared helpers for the story worker pool (``story-run.py`` and ``story-worker.py``).

The pool runs one reusable ``story-worker`` agent per story, a few at a time, each in a fresh
context. Two scripts split the work along the ownership rule of the design:

* ``story-run.py``    - used by the orchestrator only. The *sole writer* of ``workflow.json``,
                        ``traceability.json``, ``audit.jsonl`` and ``state/analysis/``.
* ``story-worker.py`` - used by a worker only. It may write its own ``<story>-testcase.md`` and its
                        own ``state/results/<story>.result.json`` and nothing else.

Standard library only. Exit codes are those of ``td_common``.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import td_common as td  # noqa: E402


def _load_script(module_name: str, file_name: str):
    """Import a hyphenated CLI script so its tested helpers are reused, not copied."""
    spec = importlib.util.spec_from_file_location(module_name, HERE / file_name)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


sas = _load_script("story_analysis_state", "story-analysis-state.py")

DEFAULT_CONCURRENCY = 5
MAX_CONCURRENCY = 5
DEFAULT_MAX_ATTEMPTS = 2          # the first try plus one retry
DEFAULT_LEASE_MINUTES = 30
RESULTS_DIR = f"{td.OUTPUT_DIRNAME}/state/results"
TRACEABILITY = f"{td.OUTPUT_DIRNAME}/state/traceability.json"
STANDARDS_FILE = "test-design/rules/worker-standards.md"
TERMINAL = ("saved", "skipped", "failed")
TIME_FMT = "%Y-%m-%dT%H:%M:%SZ"


# --------------------------------------------------------------------------- time

def now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0)


def iso(t: _dt.datetime) -> str:
    return t.strftime(TIME_FMT)


def parse_time(value: str | None) -> _dt.datetime | None:
    if not value:
        return None
    try:
        return _dt.datetime.strptime(value, TIME_FMT).replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------------------- paths

def check_story_id(story_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", story_id or "") or ".." in story_id:
        raise td.SafeOpError("BAD_STORY_ID", f"Story ID '{story_id}' cannot be used as a file name.", td.EXIT_USAGE)
    return story_id


def result_rel(story_id: str) -> str:
    return f"{RESULTS_DIR}/{check_story_id(story_id)}.result.json"


def result_path(root: Path, story_id: str) -> Path:
    return td.confine(root, result_rel(story_id))


def read_json(path: Path, what: str):
    try:
        return json.loads(td.read_text(path))
    except OSError:
        raise td.SafeOpError("UNREADABLE", f"Cannot read {what} ({path.name}).", td.EXIT_MISSING)
    except ValueError:
        raise td.SafeOpError("STATE_CORRUPT", f"{what} ({path.name}) is not valid JSON. It was not changed; explain this to the "
                             "user and ask how to proceed.", td.EXIT_MISSING)


def read_result(root: Path, story_id: str) -> dict | None:
    """The worker's result file, or None when the worker never wrote one. A malformed file raises."""
    p = result_path(root, story_id)
    if not p.is_file():
        return None
    data = read_json(p, "the worker result")
    errs = td.validate_json(data, td.load_schema("story-worker-result"))
    if errs:
        raise td.SafeOpError("RESULT_INVALID", f"The worker result for '{story_id}' does not match its schema: " + "; ".join(errs[:3]),
                             td.EXIT_FINDINGS)
    return data


def write_json(root: Path, target: str, value: dict, *, allow_overwrite: bool = True, expect_sha: str | None = None) -> dict:
    data = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return td.safe_write(root, td.confine(root, target), data, expect_sha=expect_sha,
                         allow_overwrite=allow_overwrite and expect_sha is None, backup=False)


# --------------------------------------------------------------------------- design rules

def design_rules_sha256() -> str:
    """Fingerprint of the design rules a story's cases are generated under.

    The rule files and the test-case template, line endings normalised, so a checkout with CRLF
    does not look like a rule change. When this changes, finished stories are flagged for the
    reconcile question; they are never regenerated automatically.
    """
    base = td.SCHEMA_DIR.parent
    files = sorted((base / "rules").glob("*.md")) + [base / "templates" / "test-cases.template.md"]
    h = hashlib.sha256()
    for f in files:
        if f.is_file():
            h.update(f.name.encode("utf-8") + b"\0")
            h.update(td.read_text(f).replace("\r\n", "\n").encode("utf-8") + b"\0")
    return h.hexdigest()


# --------------------------------------------------------------------------- scripts as subprocesses

def run_script(script: str, *args: str) -> tuple[int, dict]:
    """Run a sibling CLI script and parse its JSON output (one source of truth for validation and saving)."""
    proc = subprocess.run([sys.executable, str(HERE / script), *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    try:
        data = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        data = {"ok": False, "error": {"code": "SCRIPT_OUTPUT", "message": f"{script} did not print JSON: {proc.stderr.strip()[:200]}"}}
    return proc.returncode, data


def compact_findings(report: dict, limit: int = 12) -> list[dict]:
    out = []
    for f in report.get("findings", [])[:limit]:
        item = {"code": f.get("code", "?"), "severity": f.get("severity", "error"), "message": str(f.get("message", ""))[:240]}
        if f.get("caseId"):
            item["caseId"] = f["caseId"]
        out.append(item)
    return out


def validation_block(report: dict) -> dict:
    s = report.get("summary", {})
    errors, warnings = int(s.get("errors", 0)), int(s.get("warnings", 0))
    status = "failed" if errors else ("passed_with_warnings" if warnings else "passed")
    return {"status": status, "errors": errors, "warnings": warnings, "findings": compact_findings(report)}


def normalise_meta(raw) -> dict[str, dict]:
    """The generator's metadata file as ``{case id: metadata}``. Accepts a list, ``{"cases": [...]}`` or an id-keyed object."""
    items: list[dict] = []
    if isinstance(raw, dict) and isinstance(raw.get("cases"), list):
        items = raw["cases"]
    elif isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        return {k: {kk: vv for kk, vv in v.items() if kk != "id"} for k, v in raw.items() if isinstance(v, dict)}
    out: dict[str, dict] = {}
    for it in items:
        if isinstance(it, dict) and it.get("id"):
            out[it["id"]] = {k: v for k, v in it.items() if k != "id"}
    return out


def compact_reply(result: dict) -> dict:
    """The few fields the orchestrator needs; the worker prints exactly this as its final answer."""
    keys = ("storyId", "status", "attempt")
    out = {k: result[k] for k in keys if k in result}
    out["resultPath"] = result_rel(result["storyId"])
    for k in ("outputFile", "testCaseIds", "validation", "dependenciesUsed", "clarifications", "decision", "error", "uncovered"):
        if result.get(k):
            out[k] = result[k]
    if "testCaseIds" in result:
        out["caseCount"] = len(result["testCaseIds"])
    if "validation" in out:
        out["validation"] = {k: out["validation"][k] for k in ("status", "errors", "warnings")}
    return out

#!/usr/bin/env python3
"""Deterministic support for isolated, one-story-at-a-time story analysis.

The orchestrator starts a fresh ``story-analyser`` invocation for every story. This script builds
that invocation's minimal input, guards the isolation contract, validates what comes back and keeps
the per-story checkpoint, so a malformed or partial analysis can never reach coverage design.

    story-analysis-state.py plan        --root R [--apply]
    story-analysis-state.py begin       --root R --story-id S --output FILE [--rule-id ID ...]
                                        [--dependency ID ...] [--no-auto-dependencies] [--max-excerpt-chars N]
    story-analysis-state.py check-input --input FILE
    story-analysis-state.py complete    --root R --story-id S --input FILE --result FILE [--worker-ref REF]
    story-analysis-state.py fail        --root R --story-id S --reason TEXT [--worker-ref REF]
    story-analysis-state.py show        --root R --story-id S
    story-analysis-state.py check-audit --root R

``plan`` classifies every story (reuse a saved analysis, analyse, or skip) and, with ``--apply``,
invalidates only the analyses whose story, shared-rule or dependency fingerprint changed. ``begin``
writes the worker input (outside the project, e.g. the session scratch folder) and marks the story
``in_progress``. ``complete`` validates the worker output against ``test-design/schemas/story-analysis.schema.json``
and persists it to ``test-design/state/analysis/<story>.json``; an invalid result is recorded as a story
failure and nothing is persisted. ``check-audit`` verifies the audit trail shows one worker at a time and
no reused worker session.

Source stories are only read; every write is confined to ``<root>/test-design/``. Output is JSON.
Exit codes: 0 ok, 1 invalid / findings, 2 usage, 3 conflict, 4 missing/corrupt state, 5 outside the output
folder, 6 I/O error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402

SCHEMA_VERSION = 2
ANALYSIS_DIR = f"{td.OUTPUT_DIRNAME}/state/analysis"
WORKFLOW = f"{td.OUTPUT_DIRNAME}/state/workflow.json"
AUDIT = f"{td.OUTPUT_DIRNAME}/state/audit.jsonl"
DEFAULT_MAX_EXCERPT = 1200
MAX_EXCERPT_LIMIT = 4000

INPUT_KEYS = ("run_id", "story_id", "story_content", "relevant_shared_rules", "dependency_context",
              "analysis_instructions", "output_schema_version")

ANALYSIS_INSTRUCTIONS = (
    "Analyse exactly one story: the one in story_content. Follow the story-analysis skill. Use only the "
    "supplied story, relevant_shared_rules and dependency_context (read-only reference). You cannot see any "
    "other story, analysis or conversation; never look for one. Do not invent behaviour; record missing "
    "information under ambiguities, blocking only when it stops an assertable expected result. Return one "
    "JSON object matching the output schema (version 2) and nothing else, then finish."
)

HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(\S.*?)[ \t]*#*[ \t]*$")


# --------------------------------------------------------------------------- state access

def _wf_path(root: Path) -> Path:
    return td.confine(root, WORKFLOW)


def load_workflow(root: Path) -> tuple[dict, str]:
    p = _wf_path(root)
    if not p.is_file():
        raise td.SafeOpError("STATE_MISSING", f"{WORKFLOW} not found under {root}; start a run first.", td.EXIT_MISSING)
    try:
        return json.loads(td.read_text(p)), td.sha256_file(p)
    except ValueError:
        raise td.SafeOpError("STATE_CORRUPT", f"{p.name} is not valid JSON. It was not changed; explain this to the user "
                             "and ask how to proceed.", td.EXIT_MISSING)


def save_workflow(root: Path, wf: dict, expect_sha: str) -> None:
    wf["updatedAt"] = td.utc_now()
    errs = td.validate_json(wf, td.load_schema("workflow-state"))
    if errs:
        raise td.SafeOpError("SCHEMA", "workflow state would not match its schema; nothing was written: " + "; ".join(errs[:3]),
                             td.EXIT_FINDINGS)
    data = (json.dumps(wf, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    td.safe_write(root, _wf_path(root), data, expect_sha=expect_sha, backup=False)


def append_audit(root: Path, entry: dict) -> None:
    entry = {"ts": td.utc_now(), **entry}
    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    if td.contains_secret(line):
        raise td.SafeOpError("SECRET_DETECTED", "The audit entry looks like it contains a secret; nothing was written.",
                             td.EXIT_FINDINGS)
    target = td.confine(root, AUDIT)
    target.parent.mkdir(parents=True, exist_ok=True)
    prefix = ""
    if target.is_file() and target.stat().st_size:
        prefix = "" if target.read_bytes().endswith(b"\n") else "\n"
    with open(target, "ab") as fh:
        fh.write((prefix + line + "\n").encode("utf-8"))


def read_audit(root: Path) -> list[dict]:
    p = td.confine(root, AUDIT)
    if not p.is_file():
        return []
    out = []
    for raw in td.read_text(p).splitlines():
        if raw.strip():
            try:
                out.append(json.loads(raw))
            except ValueError:
                raise td.SafeOpError("STATE_CORRUPT", f"{p.name} contains a line that is not valid JSON.", td.EXIT_MISSING)
    return out


def record_path(root: Path, story_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", story_id) or ".." in story_id:
        raise td.SafeOpError("BAD_STORY_ID", f"Story ID '{story_id}' cannot be used as a file name.", td.EXIT_USAGE)
    return td.confine(root, f"{ANALYSIS_DIR}/{story_id}.json")


# --------------------------------------------------------------------------- sources

def _abs(root: Path, p: str) -> Path:
    q = Path(p)
    return q if q.is_absolute() else Path(root) / q


def _story_entry(wf: dict, story_id: str) -> dict:
    entry = wf.get("stories", {}).get(story_id)
    if entry is None:
        raise td.SafeOpError("UNKNOWN_STORY", f"Story '{story_id}' is not in workflow.json.", td.EXIT_USAGE)
    return entry


def load_story(root: Path, wf: dict, story_id: str) -> tuple[td.Story, str]:
    """Current content of one story, read from its source file (never from a stale snapshot)."""
    entry = _story_entry(wf, story_id)
    rel = entry.get("sourceFile")
    if not rel:
        raise td.SafeOpError("UNKNOWN_SOURCE", f"Story '{story_id}' has no sourceFile in workflow.json.", td.EXIT_MISSING)
    f = _abs(root, rel)
    if not f.is_file():
        raise td.SafeOpError("SOURCE_MISSING", f"Source file for '{story_id}' not found: {f}", td.EXIT_MISSING)
    text = td.read_text(f)
    for s in td.split_stories(text, f.stem):
        if s.id == story_id:
            lines = text.splitlines()
            return s, "\n".join(lines[s.start - 1:s.end])
    raise td.SafeOpError("STORY_NOT_FOUND", f"Story '{story_id}' is no longer in {rel}.", td.EXIT_MISSING)


def parse_shared_rules(path: Path) -> dict[str, dict]:
    """Split a shared-rules Markdown file into rules, one per heading (id = slug of the heading)."""
    text = td.read_text(path)
    lines = text.splitlines()
    heads: list[tuple[int, int, str]] = []
    in_fence = False
    for i, raw in enumerate(lines):
        if td.FENCE_RE.match(raw):
            in_fence = not in_fence
            continue
        m = None if in_fence else HEADING_RE.match(raw)
        if m:
            heads.append((i, len(m.group(1)), m.group(2)))
    rules: dict[str, dict] = {}
    if not heads:
        body = [l for l in lines]
        if "".join(body).strip():
            rules["all"] = {"title": path.stem, "text": "\n".join(body).strip(),
                            "sha256": td.sha256_text(td._normalise_for_hash(body))}
        return rules
    for n, (idx, level, title) in enumerate(heads):
        end = len(lines)
        for j_idx, j_level, _ in heads[n + 1:]:
            if j_level <= level:
                end = j_idx
                break
        body = lines[idx:end]
        while body and not body[-1].strip():
            body.pop()
        rid = td.slug(title).lower() or f"rule-{n + 1}"
        base, k = rid, 2
        while rid in rules:
            rid, k = f"{base}-{k}", k + 1
        rules[rid] = {"title": title, "text": "\n".join(body).strip(),
                      "sha256": td.sha256_text(td._normalise_for_hash(body))}
    return rules


def load_rules(root: Path, wf: dict) -> dict[str, dict]:
    rel = wf.get("sharedRulesFile")
    if not rel:
        return {}
    p = _abs(root, rel)
    if not p.is_file():
        raise td.SafeOpError("SHARED_RULES_MISSING", f"sharedRulesFile '{rel}' not found.", td.EXIT_MISSING)
    return parse_shared_rules(p)


def excerpt_of(content: str, limit: int) -> str:
    if len(content) <= limit:
        return content
    cut = content[:limit]
    cut = cut[:cut.rfind("\n")] if "\n" in cut else cut
    return cut.rstrip() + "\n[...excerpt truncated; the rest of that story is not needed here]"


def input_fingerprint(story_sha: str, rules: dict[str, str], deps: dict[str, str]) -> str:
    canon = json.dumps({"story": story_sha, "rules": dict(sorted(rules.items())), "deps": dict(sorted(deps.items()))},
                       sort_keys=True, separators=(",", ":"))
    return td.sha256_text(canon)


def detect_dependencies(content: str, story_id: str, known: list[str]) -> list[str]:
    return [sid for sid in known if sid != story_id and re.search(rf"(?<![A-Za-z0-9_-]){re.escape(sid)}(?![A-Za-z0-9_-])", content)]


# --------------------------------------------------------------------------- input contract

def input_violations(inp: object) -> list[str]:
    """Everything a worker input must satisfy so that it carries one story and nothing else."""
    if not isinstance(inp, dict):
        return ["$: the worker input must be a JSON object"]
    errs = td.validate_json(inp, td.load_schema("story-analysis-input"))
    if errs:
        return errs
    out: list[str] = []
    sid = inp["story_id"]
    stories = td.split_stories(inp["story_content"], sid)
    ids = [s.id for s in stories]
    if len(stories) != 1:
        out.append(f"story_content must hold exactly one story, found {len(stories)}: {ids}")
    elif stories[0].id != sid and not stories[0].id_inferred:
        out.append(f"story_content is story '{stories[0].id}', not the requested '{sid}'")
    seen = set()
    for i, d in enumerate(inp["dependency_context"]):
        if d["story_id"] == sid:
            out.append(f"dependency_context[{i}] is the story itself")
        if d["story_id"] in seen:
            out.append(f"dependency_context[{i}]: '{d['story_id']}' is supplied twice")
        seen.add(d["story_id"])
        if len(d["excerpt"]) > MAX_EXCERPT_LIMIT + 200:
            out.append(f"dependency_context[{i}]: excerpt is longer than a small excerpt should be")
        if len([s for s in td.split_stories(d["excerpt"], d["story_id"]) if not s.id_inferred]) > 1:
            out.append(f"dependency_context[{i}]: excerpt spans more than one story")
    rule_ids = [r["rule_id"] for r in inp["relevant_shared_rules"]]
    if len(set(rule_ids)) != len(rule_ids):
        out.append("relevant_shared_rules contains a duplicate rule_id")
    if td.contains_secret(text_of(inp)):
        out.append("the input appears to contain a secret or token; remove it before invoking a worker")
    return out


# --------------------------------------------------------------------------- output contract

def text_of(value: object) -> str:
    """Every string in a JSON value, unescaped, so secret detection sees the real text."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(text_of(v) for v in value.values())
    if isinstance(value, list):
        return "\n".join(text_of(v) for v in value)
    return ""


def strip_fence(text: str) -> str:
    t = text.replace("\r\n", "\n").strip()
    m = re.fullmatch(r"```(?:json)?[ \t]*\n(.*)\n```", t, flags=re.S)
    return m.group(1).strip() if m else t


def result_violations(result: object, expected_story_id: str) -> list[str]:
    if not isinstance(result, dict):
        return ["$: the worker result must be one JSON object"]
    errs = td.validate_json(result, td.load_schema("story-analysis"))
    if errs:
        return errs
    out: list[str] = []
    if result["story_id"] != expected_story_id:
        out.append(f"story_id is '{result['story_id']}' but this invocation was for '{expected_story_id}'")
    if result["analysis_complete"] is not True:
        out.append("analysis_complete is not true; a partial analysis is never passed downstream")
    labels = [x["label"] for key in ("acceptance_criteria_interpretation", "business_rules",
                                     "relevant_non_functional_expectations") for x in result.get(key, [])]
    dup = sorted({l for l in labels if labels.count(l) > 1})
    if dup:
        out.append(f"labels are not unique: {dup}")
    if result.get("testable", True):
        if not result["behaviour_to_validate"]:
            out.append("behaviour_to_validate is empty for a testable story")
    elif not result.get("not_testable_reason"):
        out.append("testable is false but not_testable_reason is missing")
    if any(a.get("blocking") for a in result.get("ambiguities", [])) and not result.get("testable", True):
        out.append("a story reported as not testable must not also raise blocking ambiguities")
    if td.contains_secret(text_of(result)):
        out.append("the result appears to contain a secret or token; reference an env: variable name instead")
    return out


def labels_of(result: dict) -> list[str]:
    return [x["label"] for key in ("acceptance_criteria_interpretation", "business_rules",
                                   "relevant_non_functional_expectations") for x in result.get(key, [])]


# --------------------------------------------------------------------------- commands

def cmd_plan(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load_workflow(root)
    rules = load_rules(root, wf)
    rows, changed = [], False
    for sid, st in wf.get("stories", {}).items():
        an = st.get("analysis") or {}
        row = {"storyId": sid, "storySaved": st.get("status") == "saved"}
        status = an.get("status")
        if st.get("status") == "skipped":
            row.update(action="skip", reasons=["story_skipped"])
        elif status in (None, "not_started", "in_progress", "failed"):
            if status is None and st.get("status") == "saved":
                row.update(action="skip", reasons=["saved_before_isolated_analysis"])
            else:
                reason = {"failed": "previous_attempt_failed", "in_progress": "interrupted"}.get(status, "not_started")
                row.update(action="analyse", reasons=[reason] + ([f"invalidated:{r}" for r in an.get("invalidatedBy", [])]))
                if status == "failed" and an.get("failure"):
                    row["failure"] = an["failure"]["reason"]
        else:  # completed
            reasons: list[str] = []
            try:
                cur, _ = load_story(root, wf, sid)
                if cur.sha256 != an.get("sourceSha256"):
                    reasons.append("story_changed")
            except td.SafeOpError as e:
                reasons.append("story_missing" if e.code in ("STORY_NOT_FOUND", "SOURCE_MISSING") else e.code.lower())
            for rid, old in (an.get("sharedRules") or {}).items():
                if rid not in rules:
                    reasons.append(f"shared_rule_removed:{rid}")
                elif rules[rid]["sha256"] != old:
                    reasons.append(f"shared_rule_changed:{rid}")
            for did, old in (an.get("dependencies") or {}).items():
                try:
                    d, _ = load_story(root, wf, did)
                    if d.sha256 != old:
                        reasons.append(f"dependency_changed:{did}")
                except td.SafeOpError:
                    reasons.append(f"dependency_missing:{did}")
            rp = record_path(root, sid)
            rec_ok = False
            if rp.is_file():
                try:
                    rec = json.loads(td.read_text(rp))
                    rec_ok = (not td.validate_json(rec, td.load_schema("story-analysis-record"))
                              and rec["inputFingerprint"] == an.get("inputFingerprint") and rec["storyId"] == sid)
                except ValueError:
                    rec_ok = False
            if not rec_ok:
                reasons.append("saved_result_missing_or_invalid")
            if reasons:
                row.update(action="invalidated", reasons=reasons)
                if a.apply:
                    st["analysis"] = {"status": "not_started", "attempts": an.get("attempts", 0), "invalidatedBy": reasons}
                    changed = True
                    append_audit(root, {"event": "analysis_invalidated", "storyId": sid, "reasons": reasons})
            else:
                row.update(action="reuse", reasons=[], resultPath=an.get("resultPath"))
        rows.append(row)
    if changed:
        save_workflow(root, wf, sha)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["action"]] = counts.get(r["action"], 0) + 1
    td.emit({"ok": True, "runId": wf.get("runId"), "applied": bool(a.apply and changed), "counts": counts, "stories": rows})
    return td.EXIT_OK


def cmd_begin(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load_workflow(root)
    sid = a.story_id
    entry = _story_entry(wf, sid)
    if entry.get("status") == "skipped":
        raise td.SafeOpError("STORY_SKIPPED", f"Story '{sid}' was skipped; it is not analysed.", td.EXIT_USAGE)
    limit = min(a.max_excerpt_chars, MAX_EXCERPT_LIMIT)
    story, content = load_story(root, wf, sid)
    all_rules = load_rules(root, wf)
    unknown = [r for r in a.rule_id if r not in all_rules]
    if unknown:
        raise td.SafeOpError("UNKNOWN_RULE", f"Shared rule(s) not found in sharedRulesFile: {unknown}. "
                             f"Available: {sorted(all_rules)}", td.EXIT_USAGE)
    dep_ids = list(dict.fromkeys(a.dependency))
    if not a.no_auto_dependencies:
        for d in detect_dependencies(content, sid, [k for k in wf["stories"] if k != sid]):
            if d not in dep_ids:
                dep_ids.append(d)
    deps, dep_fp = [], {}
    for did in dep_ids:
        if did == sid or did not in wf["stories"]:
            raise td.SafeOpError("UNKNOWN_DEPENDENCY", f"Dependency '{did}' is not another story of this run.", td.EXIT_USAGE)
        dstory, dcontent = load_story(root, wf, did)
        deps.append({"story_id": did, "title": dstory.title, "excerpt": excerpt_of(dcontent, limit), "read_only": True})
        dep_fp[did] = dstory.sha256
    rule_fp = {r: all_rules[r]["sha256"] for r in a.rule_id}
    inp = {
        "run_id": wf["runId"], "story_id": sid, "story_content": content,
        "relevant_shared_rules": [{"rule_id": r, "title": all_rules[r]["title"], "text": all_rules[r]["text"]} for r in a.rule_id],
        "dependency_context": deps, "analysis_instructions": ANALYSIS_INSTRUCTIONS, "output_schema_version": SCHEMA_VERSION,
    }
    errs = input_violations(inp)
    if errs:
        td.emit({"ok": False, "error": {"code": "INPUT_CONTRACT", "message": "The worker input breaks the isolation contract; "
                                        "no worker was started."}, "errors": errs})
        return td.EXIT_FINDINGS
    out = Path(a.output).resolve()
    if out.is_relative_to(td.output_dir(root)):
        raise td.SafeOpError("BAD_OUTPUT", "Write the worker input to the session scratch folder, not into test-design/.", td.EXIT_USAGE)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(inp, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    attempt = (entry.get("analysis") or {}).get("attempts", 0) + 1
    fp = input_fingerprint(story.sha256, rule_fp, dep_fp)
    entry["analysis"] = {"status": "in_progress", "attempts": attempt, "sourceSha256": story.sha256, "sharedRules": rule_fp,
                         "dependencies": dep_fp, "inputFingerprint": fp, "startedAt": td.utc_now()}
    save_workflow(root, wf, sha)
    append_audit(root, {"event": "analysis_started", "runId": wf["runId"], "storyId": sid, "attempt": attempt,
                        "inputFingerprint": fp, "sharedRules": list(rule_fp), "dependencies": list(dep_fp)})
    td.emit({"ok": True, "storyId": sid, "attempt": attempt, "inputPath": str(out), "inputFingerprint": fp,
             "sharedRules": list(rule_fp), "dependencies": list(dep_fp), "storyChars": len(content)})
    return td.EXIT_OK


def cmd_check_input(a) -> int:
    p = Path(a.input)
    if not p.is_file():
        raise td.SafeOpError("INPUT_MISSING", f"{p} not found", td.EXIT_MISSING)
    try:
        inp = json.loads(td.read_text(p))
    except ValueError:
        td.emit({"ok": False, "errors": ["the worker input is not valid JSON"]})
        return td.EXIT_FINDINGS
    errs = input_violations(inp)
    td.emit({"ok": not errs, "errors": errs})
    return td.EXIT_FINDINGS if errs else td.EXIT_OK


def _record_failure(root: Path, wf: dict, sha: str, sid: str, reason: str, worker_ref: str | None) -> None:
    entry = _story_entry(wf, sid)
    an = entry.get("analysis") or {"status": "failed", "attempts": 1}
    an.update(status="failed", failure={"reason": reason[:500], "at": td.utc_now()})
    an.pop("invalidatedBy", None)
    entry["analysis"] = an
    save_workflow(root, wf, sha)
    ev = {"event": "analysis_failed", "storyId": sid, "attempt": an.get("attempts", 1), "reason": reason[:300]}
    if worker_ref:
        ev["workerRef"] = worker_ref
    append_audit(root, ev)


def cmd_complete(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load_workflow(root)
    sid = a.story_id
    entry = _story_entry(wf, sid)
    an = entry.get("analysis") or {}
    if an.get("status") != "in_progress":
        raise td.SafeOpError("NOT_IN_PROGRESS", f"Story '{sid}' has no analysis in progress; run 'begin' first.", td.EXIT_CONFLICT)
    try:
        inp = json.loads(td.read_text(Path(a.input)))
    except (OSError, ValueError):
        raise td.SafeOpError("INPUT_UNREADABLE", f"Cannot read the worker input {a.input}.", td.EXIT_MISSING)
    problems: list[str] = []
    if inp.get("story_id") != sid:
        problems.append(f"the supplied input is for '{inp.get('story_id')}', not '{sid}'")
    try:
        raw = td.read_text(Path(a.result))
    except OSError:
        raise td.SafeOpError("RESULT_UNREADABLE", f"Cannot read the worker result {a.result}.", td.EXIT_MISSING)
    result = None
    try:
        result = json.loads(strip_fence(raw))
    except ValueError:
        problems.append("the worker result is not valid JSON")
    if result is not None:
        problems += result_violations(result, sid)
    if not problems:
        try:
            cur, _ = load_story(root, wf, sid)
            if cur.sha256 != an.get("sourceSha256"):
                problems.append("the story changed while it was being analysed; analyse it again")
        except td.SafeOpError as e:
            problems.append(e.code.lower())
    if problems:
        _record_failure(root, wf, sha, sid, "; ".join(problems), a.worker_ref)
        td.emit({"ok": False, "error": {"code": "INVALID_WORKER_OUTPUT", "message": "The analysis was rejected and is not passed "
                 "downstream; the story is marked failed and can be retried alone with /builder:design-resume."}, "errors": problems})
        return td.EXIT_FINDINGS
    record = {"version": 1, "storyId": sid, "runId": wf["runId"], "inputFingerprint": an["inputFingerprint"],
              "completedAt": td.utc_now(), "result": result}
    rp = record_path(root, sid)
    data = (json.dumps(record, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    td.safe_write(root, rp, data, allow_overwrite=True, backup=False)
    rel = f"{ANALYSIS_DIR}/{sid}.json"
    an.update(status="completed", resultPath=rel, completedAt=record["completedAt"])
    an.pop("failure", None)
    an.pop("invalidatedBy", None)
    entry["analysis"] = an
    entry["lastCompletedStage"] = "analyse"
    save_workflow(root, wf, sha)
    ev = {"event": "analysis_completed", "storyId": sid, "attempt": an.get("attempts", 1), "inputFingerprint": an["inputFingerprint"]}
    if a.worker_ref:
        ev["workerRef"] = a.worker_ref
    append_audit(root, ev)
    blocking = [x["question"] for x in result.get("ambiguities", []) if x["blocking"]]
    td.emit({"ok": True, "storyId": sid, "resultPath": rel, "testable": result.get("testable", True),
             "criteriaLabels": labels_of(result), "blockingAmbiguities": len(blocking)})
    return td.EXIT_OK


def cmd_fail(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load_workflow(root)
    _record_failure(root, wf, sha, a.story_id, a.reason, a.worker_ref)
    td.emit({"ok": True, "storyId": a.story_id, "status": "failed"})
    return td.EXIT_OK


def cmd_show(a) -> int:
    root = Path(a.root).resolve()
    wf, _ = load_workflow(root)
    an = (_story_entry(wf, a.story_id).get("analysis") or {})
    if an.get("status") != "completed":
        raise td.SafeOpError("NO_COMPLETED_ANALYSIS", f"Story '{a.story_id}' has no completed analysis (status: {an.get('status', 'none')}).",
                             td.EXIT_MISSING)
    rp = record_path(root, a.story_id)
    if not rp.is_file():
        raise td.SafeOpError("RESULT_MISSING", f"The saved analysis for '{a.story_id}' is missing; analyse the story again.", td.EXIT_MISSING)
    try:
        rec = json.loads(td.read_text(rp))
    except ValueError:
        raise td.SafeOpError("STATE_CORRUPT", f"{rp.name} is not valid JSON.", td.EXIT_MISSING)
    errs = td.validate_json(rec, td.load_schema("story-analysis-record"))
    if errs or rec["inputFingerprint"] != an.get("inputFingerprint"):
        raise td.SafeOpError("RESULT_INVALID", f"The saved analysis for '{a.story_id}' does not match its checkpoint; analyse the story again.",
                             td.EXIT_FINDINGS)
    td.emit({"ok": True, "storyId": a.story_id, "result": rec["result"]})
    return td.EXIT_OK


def cmd_check_audit(a) -> int:
    root = Path(a.root).resolve()
    findings: list[str] = []
    active: str | None = None
    refs: dict[str, str] = {}
    started = ended = 0
    for ev in read_audit(root):
        kind = ev.get("event")
        if kind == "analysis_started":
            started += 1
            key = f"{ev.get('storyId')}#{ev.get('attempt')}"
            if active is not None:
                findings.append(f"{key} started while {active} was still running (workers must run one at a time)")
            active = key
        elif kind in ("analysis_completed", "analysis_failed"):
            ended += 1
            key = f"{ev.get('storyId')}#{ev.get('attempt')}"
            if active != key:
                findings.append(f"{key} ended but {active or 'no worker'} was the active one")
            active = None
            ref = ev.get("workerRef")
            if ref:
                if ref in refs and refs[ref] != key:
                    findings.append(f"worker session '{ref}' was used for both {refs[ref]} and {key} (context reused)")
                refs[ref] = key
    td.emit({"ok": not findings, "started": started, "ended": ended, "stillRunning": active, "workerRefsSeen": len(refs),
             "findings": findings})
    return td.EXIT_FINDINGS if findings else td.EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan"); p.add_argument("--root", required=True); p.add_argument("--apply", action="store_true"); p.set_defaults(fn=cmd_plan)
    p = sub.add_parser("begin"); p.add_argument("--root", required=True); p.add_argument("--story-id", required=True)
    p.add_argument("--output", required=True); p.add_argument("--rule-id", action="append", default=[])
    p.add_argument("--dependency", action="append", default=[]); p.add_argument("--no-auto-dependencies", action="store_true")
    p.add_argument("--max-excerpt-chars", type=int, default=DEFAULT_MAX_EXCERPT); p.set_defaults(fn=cmd_begin)
    p = sub.add_parser("check-input"); p.add_argument("--input", required=True); p.set_defaults(fn=cmd_check_input)
    p = sub.add_parser("complete"); p.add_argument("--root", required=True); p.add_argument("--story-id", required=True)
    p.add_argument("--input", required=True); p.add_argument("--result", required=True); p.add_argument("--worker-ref", default=None)
    p.set_defaults(fn=cmd_complete)
    p = sub.add_parser("fail"); p.add_argument("--root", required=True); p.add_argument("--story-id", required=True)
    p.add_argument("--reason", required=True); p.add_argument("--worker-ref", default=None); p.set_defaults(fn=cmd_fail)
    p = sub.add_parser("show"); p.add_argument("--root", required=True); p.add_argument("--story-id", required=True); p.set_defaults(fn=cmd_show)
    p = sub.add_parser("check-audit"); p.add_argument("--root", required=True); p.set_defaults(fn=cmd_check_audit)
    return ap


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.fn(args)
    except td.SafeOpError as e:
        td.emit({"ok": False, "error": {"code": e.code, "message": str(e)}})
        return e.exit_code
    except td.SchemaError as e:
        td.emit({"ok": False, "error": {"code": "SCHEMA_UNKNOWN", "message": str(e)}})
        return td.EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())

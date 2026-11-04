#!/usr/bin/env python3
"""Scheduler and central result manager for the story worker pool. Used by the orchestrator only.

    story-run.py configure   --root R [--concurrency N] [--max-attempts N] [--lease-minutes N] [--depends S=D[,D...] ...]
    story-run.py plan        --root R [--stories S,S] [--reclaim] [--retry-failed] [--regenerate S,S] [--adopt S,S]
    story-run.py next        --root R --run-dir DIR [--slots N] [--stories S,S] [--rules S=a,b ...] [--rules-auto]
                             [--reclaim] [--retry-failed] [--regenerate S,S] [--adopt S,S]
    story-run.py ingest      --root R --story-id S [--worker-ref REF] [--tokens N] [--duration-ms N] [--file-handled | --commit-staged]
    story-run.py fail        --root R --story-id S --reason TEXT [--worker-ref REF] [--tokens N] [--duration-ms N]
    story-run.py clarify     --root R --story-id S --question TEXT --answer TEXT [--declined]
    story-run.py resolve     --root R --story-id S --action adopt|retry|skip
    story-run.py trace-patch --root R --story-id S --output FILE [--remove ID ...]
    story-run.py status      --root R
    story-run.py check-pool  --root R [--apply]

The orchestrator is the **sole writer** of ``workflow.json``, ``traceability.json``, ``audit.jsonl`` and
``state/analysis/``. A worker (``story-worker.py``) writes only its own test-case file and its own
``state/results/<story>.result.json``; ``ingest`` validates that result and the file it names, then
updates the shared state. Nothing is regenerated automatically: a finished story whose source, shared
rules or design rules changed is reported ``stale`` and left alone until the user decides.

Story states in ``plan``: done, stale, regenerate, dispatch, retry, running, interrupted, awaiting_user,
exhausted, blocked_untracked_output, blocked_dependency, waiting_dependency, skipped.

Output is JSON. Exit codes: 0 ok, 1 invalid / findings, 2 usage, 3 conflict, 4 missing/corrupt state,
5 outside the output folder, 6 I/O error.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pool_common as pc  # noqa: E402

td = pc.td
sas = pc.sas

WORKER_INSTRUCTIONS = (
    "Process exactly one story: the one in story_content. Follow the story-worker agent instructions: analyse, design coverage, "
    "generate, validate, save this story's own test-case file, and return the compact result. Use only this input, the standards "
    "file and the plugin's rules; you cannot see any other story, analysis, test-case file or conversation. Never invent behaviour. "
    "Write only your own test-case file and your own result file."
)


# --------------------------------------------------------------------------- state helpers

def load(root: Path) -> tuple[dict, str]:
    return sas.load_workflow(root)


def save(root: Path, wf: dict, sha: str) -> str:
    sas.save_workflow(root, wf, sha)
    return td.sha256_file(sas._wf_path(root))


def audit(root: Path, **entry) -> None:
    sas.append_audit(root, entry)


def settings(wf: dict) -> dict:
    s = wf.get("scheduler") or {}
    return {"concurrency": s.get("concurrency", pc.DEFAULT_CONCURRENCY), "maxAttempts": s.get("maxAttempts", pc.DEFAULT_MAX_ATTEMPTS),
            "leaseMinutes": s.get("leaseMinutes", pc.DEFAULT_LEASE_MINUTES)}


def csv(values: list[str] | None) -> list[str]:
    return [x.strip() for v in (values or []) for x in v.split(",") if x.strip()]


def pairs(values: list[str] | None, what: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for v in values or []:
        if "=" not in v:
            raise td.SafeOpError("USAGE", f"{what} expects STORY=VALUE[,VALUE], got '{v}'.", td.EXIT_USAGE)
        k, _, rest = v.partition("=")
        out.setdefault(k.strip(), []).extend(csv([rest]))
    return out


def story(wf: dict, sid: str) -> dict:
    pc.check_story_id(sid)
    return sas._story_entry(wf, sid)


def apply_settings(wf: dict, a, first_run: bool = False) -> bool:
    s = wf.setdefault("scheduler", {})
    before = json.dumps(s, sort_keys=True)
    conc = getattr(a, "concurrency", None)
    if conc is not None:
        if not 1 <= conc <= pc.MAX_CONCURRENCY:
            raise td.SafeOpError("CONCURRENCY_LIMIT", f"Concurrency must be 1 to {pc.MAX_CONCURRENCY}; start with {pc.DEFAULT_CONCURRENCY} "
                                 "and raise it only after benchmarking.", td.EXIT_USAGE)
        s["concurrency"] = conc
    if getattr(a, "max_attempts", None) is not None:
        if not 1 <= a.max_attempts <= 5:
            raise td.SafeOpError("USAGE", "--max-attempts must be 1 to 5.", td.EXIT_USAGE)
        s["maxAttempts"] = a.max_attempts
    if getattr(a, "lease_minutes", None) is not None:
        s["leaseMinutes"] = max(1, a.lease_minutes)
    s.setdefault("concurrency", pc.DEFAULT_CONCURRENCY)
    s.setdefault("maxAttempts", pc.DEFAULT_MAX_ATTEMPTS)
    s.setdefault("leaseMinutes", pc.DEFAULT_LEASE_MINUTES)
    s.setdefault("designRulesSha256", pc.design_rules_sha256())
    s.setdefault("runtimeParallelism", "unverified")
    s.setdefault("startedAt", td.utc_now())
    for sid, deps in pairs(getattr(a, "depends", None), "--depends").items():
        st = story(wf, sid)
        for d in deps:
            if d == sid or d not in wf["stories"]:
                raise td.SafeOpError("UNKNOWN_DEPENDENCY", f"'{d}' is not another story of this run.", td.EXIT_USAGE)
        st["dependsOn"] = list(dict.fromkeys(deps))
    return json.dumps(s, sort_keys=True) != before or bool(getattr(a, "depends", None))


# --------------------------------------------------------------------------- dependency graph

def components(wf: dict) -> tuple[dict[str, list[str]], list[list[str]]]:
    """Declared dependencies among this run's stories and the cycles they form (Tarjan)."""
    graph = {sid: [d for d in st.get("dependsOn", []) if d in wf["stories"]] for sid, st in wf["stories"].items()}
    index, low, on, stack, out, n = {}, {}, set(), [], [], [0]

    def visit(v: str) -> None:
        index[v] = low[v] = n[0]; n[0] += 1; stack.append(v); on.add(v)
        for w in graph[v]:
            if w not in index:
                visit(w); low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop(); on.discard(w); comp.append(w)
                if w == v:
                    break
            if len(comp) > 1 or v in graph[v]:
                out.append(sorted(comp))

    sys.setrecursionlimit(max(1000, len(graph) * 4))
    for v in graph:
        if v not in index:
            visit(v)
    return graph, out


# --------------------------------------------------------------------------- classification

def stale_reasons(root: Path, wf: dict, sid: str, st: dict, rules: dict, current_rules: str) -> tuple[list[str], list[str]]:
    reasons: list[str] = []
    notes: list[str] = []
    tf = st.get("testCaseFile") or {}
    try:
        cur, _ = sas.load_story(root, wf, sid)
        if tf.get("sourceSha256") and cur.sha256 != tf["sourceSha256"]:
            reasons.append("story_changed")
    except td.SafeOpError as e:
        reasons.append("story_missing" if e.code in ("STORY_NOT_FOUND", "SOURCE_MISSING") else e.code.lower())
    an = st.get("analysis") or {}
    for rid, old in (an.get("sharedRules") or {}).items():
        if rid not in rules:
            reasons.append(f"shared_rule_removed:{rid}")
        elif rules[rid]["sha256"] != old:
            reasons.append(f"shared_rule_changed:{rid}")
    for did, old in (an.get("dependencies") or {}).items():
        try:
            d, _ = sas.load_story(root, wf, did)
            if d.sha256 != old:
                reasons.append(f"dependency_changed:{did}")
        except td.SafeOpError:
            reasons.append(f"dependency_missing:{did}")
    if tf.get("designRulesSha256") and tf["designRulesSha256"] != current_rules:
        reasons.append("design_rules_changed")
    if tf.get("path"):
        f = td.confine(root, tf["path"])
        if not f.is_file():
            reasons.append("output_missing")
        elif tf.get("sha256") and td.sha256_file(f) != tf["sha256"]:
            notes.append("edited_since_save")
    return reasons, notes


def output_plan(root: Path, st: dict, sid: str, adopt: set[str], regenerate: set[str]) -> dict:
    """How a worker may write this story's file: create, append (recorded file), stage_only, or blocked."""
    f = td.confine(root, td.testcase_rel_path(sid))
    rec = (st.get("testCaseFile") or {}).get("sha256")
    ex = st.get("execution") or {}
    if sid in regenerate:
        if not f.is_file():
            return {"mode": "create"}
        return {"mode": "stage_only", "expect_sha256": rec}
    if not f.is_file():
        return {"blocked": "output_missing"} if rec else {"mode": "create"}
    if rec:
        return {"mode": "append", "expect_sha256": rec}
    if sid in adopt or ex.get("adopt"):
        return {"mode": "append", "adopt_existing": True}
    return {"blocked": "blocked_untracked_output"}


def classify(root: Path, wf: dict, a, rules: dict, only: set[str] | None) -> list[dict]:
    cfg = settings(wf)
    current_rules = pc.design_rules_sha256()
    regenerate, adopt = set(csv(getattr(a, "regenerate", None))), set(csv(getattr(a, "adopt", None)))
    reclaim, retry_failed = bool(getattr(a, "reclaim", False)), bool(getattr(a, "retry_failed", False))
    graph, cycles = components(wf)
    cyclic = {s for c in cycles for s in c}
    t = pc.now()
    rows = []
    for sid, st in wf["stories"].items():
        if only is not None and sid not in only:
            continue
        ex = st.get("execution") or {}
        attempts = ex.get("attempts", 0)
        row: dict = {"storyId": sid, "status": st.get("status"), "attempts": attempts}
        status = st.get("status")
        if status == "skipped":
            row["state"] = "skipped"
        elif status == "saved":
            reasons, notes = stale_reasons(root, wf, sid, st, rules, current_rules)
            if sid in regenerate:
                row.update(state="regenerate", reasons=reasons)
            else:
                row.update(state="stale" if reasons else "done", reasons=reasons)
            if notes:
                row["notes"] = notes
        elif status == "running":
            lease = pc.parse_time(ex.get("leaseExpiresAt"))
            row["state"] = "interrupted" if (reclaim or lease is None or lease <= t) else "running"
        elif status == "needs_clarification":
            row.update(state="awaiting_user", awaiting=ex.get("awaiting"))
        elif status == "failed" and not retry_failed:
            row.update(state="exhausted", error=(ex.get("lastError") or {}).get("message"))
        else:  # pending, failed with --retry-failed, or a story left mid-stage by the sequential flow
            if status == "failed":
                attempts = 0
                row["attempts"] = 0
            row["state"] = "retry" if attempts > 0 else "dispatch"
            if attempts >= cfg["maxAttempts"]:
                row.update(state="exhausted", error=(ex.get("lastError") or {}).get("message"))
        if row["state"] in ("dispatch", "retry", "regenerate"):
            op = output_plan(root, st, sid, adopt, regenerate)
            if "blocked" in op:
                row["state"] = "blocked_untracked_output" if op["blocked"] == "blocked_untracked_output" else "awaiting_user"
                row["reasons"] = [op["blocked"]]
            else:
                row["mode"] = op["mode"]
            if row["state"] in ("dispatch", "retry"):
                waiting, failed_dep = [], []
                for d in graph.get(sid, []):
                    if sid in cyclic and d in cyclic:
                        continue
                    ds = wf["stories"][d].get("status")
                    if ds in ("saved", "skipped"):
                        continue
                    (failed_dep if ds == "failed" else waiting).append(d)
                if failed_dep:
                    row.update(state="blocked_dependency", waitingFor=failed_dep)
                elif waiting:
                    row.update(state="waiting_dependency", waitingFor=waiting)
        rows.append(row)
    return rows


def dispatch_of(ex: dict) -> int:
    """Unique id of the latest worker run of a story. ``attempts`` is the retry budget and can be reset; this never is."""
    return ex.get("dispatchCount") or ex.get("attempts", 0)


def counts(rows: list[dict]) -> dict:
    out: dict[str, int] = {}
    for r in rows:
        out[r["state"]] = out.get(r["state"], 0) + 1
    return out


# --------------------------------------------------------------------------- worker input

def auto_rules(content: str, rules: dict) -> list[str]:
    low = content.lower()
    return [rid for rid, r in rules.items() if len(r["title"]) >= 3 and (r["title"].lower() in low or rid in low)]


def build_input(root: Path, wf: dict, sid: str, rule_ids: list[str], op: dict, attempt: int, run_dir: Path) -> tuple[dict, dict]:
    st = story(wf, sid)
    s, content = sas.load_story(root, wf, sid)
    all_rules = sas.load_rules(root, wf)
    unknown = [r for r in rule_ids if r not in all_rules]
    if unknown:
        raise td.SafeOpError("UNKNOWN_RULE", f"Shared rule(s) not found in sharedRulesFile: {unknown}. Available: {sorted(all_rules)}", td.EXIT_USAGE)
    dep_ids = list(dict.fromkeys(st.get("dependsOn", [])))
    for d in sas.detect_dependencies(content, sid, [k for k in wf["stories"] if k != sid]):
        if d not in dep_ids:
            dep_ids.append(d)
    deps, dep_fp = [], {}
    for did in dep_ids:
        ds, dc = sas.load_story(root, wf, did)
        deps.append({"story_id": did, "title": ds.title, "excerpt": sas.excerpt_of(dc, sas.DEFAULT_MAX_EXCERPT), "read_only": True})
        dep_fp[did] = ds.sha256
    rule_fp = {r: all_rules[r]["sha256"] for r in rule_ids}
    fp = sas.input_fingerprint(s.sha256, rule_fp, dep_fp)
    scratch = run_dir / "work" / f"{sid}-a{attempt}"
    out = {"path": td.testcase_rel_path(sid), "mode": op["mode"]}
    if op.get("expect_sha256"):
        out["expect_sha256"] = op["expect_sha256"]
    if op.get("adopt_existing"):
        out["adopt_existing"] = True
    inp = {
        "run_id": wf["runId"], "story_id": sid, "story_content": content,
        "relevant_shared_rules": [{"rule_id": r, "title": all_rules[r]["title"], "text": all_rules[r]["text"]} for r in rule_ids],
        "dependency_context": deps, "analysis_instructions": WORKER_INSTRUCTIONS, "output_schema_version": sas.SCHEMA_VERSION,
        "worker_contract": {
            "schema_version": 1, "attempt": attempt, "project_root": str(root), "scratch_dir": str(scratch),
            "result_path": pc.result_rel(sid), "output": out, "traceability_path": pc.TRACEABILITY, "standards_file": pc.STANDARDS_FILE,
            "source_sha256": s.sha256, "input_fingerprint": fp,
            "confirmed_decisions": [{k: d[k] for k in ("question", "answer", "declined") if k in d} for d in st.get("clarifications", [])],
        },
    }
    meta = {"sourceSha256": s.sha256, "sharedRules": rule_fp, "dependencies": dep_fp, "inputFingerprint": fp}
    return inp, meta


# --------------------------------------------------------------------------- traceability

def build_trace_patch(root: Path, wf: dict, sid: str, r: dict, remove: list[str] | None = None) -> dict:
    st = story(wf, sid)
    try:
        title = sas.load_story(root, wf, sid)[0].title
    except td.SafeOpError:
        title = (r.get("analysis") or {}).get("title") or sid
    entry = {"sourceFile": st.get("sourceFile") or "unknown", "title": title or sid}
    if r["status"] == "not_testable":
        entry["status"] = "no_testable_behaviour"
        return {"version": 1, "stories": {sid: entry}, "cases": {}}
    entry.update(criteria=r.get("criteria", []), status="analysed", testCaseFile=td.testcase_rel_path(sid))
    cases: dict = dict((r.get("trace") or {}).get("cases", {}))
    for rid in remove or []:
        cases[rid] = None
    return {"version": 1, "stories": {sid: entry}, "cases": cases}


def merge_traceability(root: Path, patch: dict) -> str:
    target = td.confine(root, pc.TRACEABILITY)
    current, sha = {}, None
    if target.is_file():
        current, sha = pc.read_json(target, "traceability.json"), td.sha256_file(target)
    merged = td.merge_patch(current, patch)
    merged["updatedAt"] = td.utc_now()
    errs = td.validate_json(merged, td.load_schema("traceability"))
    if errs:
        raise td.SafeOpError("SCHEMA", "traceability would not match its schema; nothing was written: " + "; ".join(errs[:3]), td.EXIT_FINDINGS)
    data = (json.dumps(merged, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return td.safe_write(root, target, data, expect_sha=sha, allow_overwrite=sha is None, backup=False)["sha256"]


# --------------------------------------------------------------------------- recording outcomes

def record_analysis(root: Path, wf: dict, sid: str, r: dict) -> dict | None:
    """Persist the worker's analysis as the sequential flow did (state/analysis/<story>.json), after re-validating it centrally."""
    st = story(wf, sid)
    an = st.get("analysis") or {}
    if not r.get("analysis") or an.get("status") != "in_progress":
        return None
    problems = sas.result_violations(r["analysis"], sid)
    if problems:
        return {"problems": problems}
    rec = {"version": 1, "storyId": sid, "runId": wf["runId"], "inputFingerprint": an["inputFingerprint"], "completedAt": td.utc_now(),
           "result": r["analysis"]}
    td.safe_write(root, sas.record_path(root, sid), (json.dumps(rec, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
                  allow_overwrite=True, backup=False)
    an.update(status="completed", resultPath=f"{sas.ANALYSIS_DIR}/{sid}.json", completedAt=rec["completedAt"])
    an.pop("failure", None); an.pop("invalidatedBy", None)
    st["analysis"] = an
    st["lastCompletedStage"] = "analyse"
    return None


def fail_story(root: Path, wf: dict, sid: str, code: str, message: str) -> dict:
    """Consume the attempt: retry while attempts remain, otherwise the story is failed."""
    st = story(wf, sid)
    ex = st.setdefault("execution", {})
    attempts = ex.get("attempts", 1)
    final = attempts >= settings(wf)["maxAttempts"]
    st["status"] = "failed" if final else "pending"
    if ex.get("mode") == "stage_only" and st.get("testCaseFile"):
        st["status"] = "saved"  # a failed regeneration never demotes a story whose file is intact
    ex.update(lastError={"code": code, "message": message[:500], "at": td.utc_now()}, awaiting=None)
    ex.pop("leaseExpiresAt", None)
    an = st.get("analysis") or {}
    if an.get("status") == "in_progress":
        an.update(status="failed", failure={"reason": f"{code}: {message[:300]}", "at": td.utc_now()})
        st["analysis"] = an
    st["updatedAt"] = td.utc_now()
    return {"retry": not final, "final": final, "attempts": attempts}


def refresh_outputs(root: Path, wf: dict) -> None:
    files = [s["testCaseFile"] for s in wf["stories"].values() if s.get("status") == "saved" and s.get("testCaseFile")]
    tc = wf.setdefault("outputs", {}).setdefault("testCases", {})
    tc.update(directory="test-design/test-cases", fileNamePattern="<USER_STORY_ID>-testcase.md", fileCount=len(files),
              caseCount=sum(f.get("caseCount", 0) for f in files), updatedAt=td.utc_now())
    t = td.confine(root, pc.TRACEABILITY)
    if t.is_file():
        wf["outputs"].setdefault("traceability", {"path": pc.TRACEABILITY})["sha256"] = td.sha256_file(t)


def ingest_story(root: Path, wf: dict, sid: str, *, worker_ref: str | None, tokens: int | None, duration_ms: int | None,
                 mode: str = "normal") -> dict:
    """Validate one worker's result and its output, then update the shared state. Idempotent per attempt.

    ``mode``: normal (the story is running), file_handled (the user resolved a ``needs_decision`` by hand and the file is
    now right), commit_staged (the user agreed to replace the story's file with the staged draft and it was replaced).
    """
    st = story(wf, sid)
    ex = st.setdefault("execution", {})
    handled = mode == "file_handled"
    if mode == "normal":
        if st.get("status") == "saved":
            return {"storyId": sid, "outcome": "already_saved", "ok": True}
        if st.get("status") != "running":
            raise td.SafeOpError("NOT_RUNNING", f"Story '{sid}' is {st.get('status')}, not running; nothing to ingest.", td.EXIT_CONFLICT)
    elif handled:
        if not (st.get("status") == "needs_clarification" and ex.get("awaiting") == "decision"):
            raise td.SafeOpError("NOT_AWAITING", f"Story '{sid}' is not waiting for a decision.", td.EXIT_CONFLICT)
    elif st.get("status") not in ("saved", "pending"):
        raise td.SafeOpError("NOT_STAGED", f"Story '{sid}' is {st.get('status')}; there is no staged draft to commit.", td.EXIT_CONFLICT)
    try:
        r = pc.read_result(root, sid)
    except td.SafeOpError as e:
        if e.code not in ("RESULT_INVALID", "STATE_CORRUPT") or mode != "normal":
            raise
        res = fail_story(root, wf, sid, "RESULT_INVALID", str(e))
        audit(root, event="worker_finished", storyId=sid, attempt=dispatch_of(ex), status="invalid_result",
              outcome="retry" if res["retry"] else "failed")
        return {"storyId": sid, "ok": False, "outcome": "retry" if res["retry"] else "failed",
                "error": {"code": "RESULT_INVALID", "message": str(e)[:300]}}
    if r is None or r["status"] == "running":
        return {"storyId": sid, "outcome": "no_result", "ok": False}
    if mode == "commit_staged" and r["status"] != "staged":
        raise td.SafeOpError("NOT_STAGED", f"Story '{sid}' has no staged draft (its last result is '{r['status']}').", td.EXIT_CONFLICT)
    an = st.get("analysis") or {}
    if r["runId"] != wf["runId"] or r["attempt"] != dispatch_of(ex) or (
            an.get("inputFingerprint") and r.get("inputFingerprint") != an["inputFingerprint"]):
        return {"storyId": sid, "outcome": "stale_result", "ok": False,
                "message": "the result file belongs to a different run, attempt or input"}
    if tokens is not None or duration_ms is not None:
        m = st.setdefault("metrics", {})
        m["tokens"] = (tokens if tokens is not None else m.get("tokens", 0))
        m["durationMs"] = (duration_ms if duration_ms is not None else m.get("durationMs", 0))
        m["attempts"] = ex.get("attempts", 1)
    if worker_ref:
        ex["workerRef"] = worker_ref[:120]
    status = r["status"]
    base_event = {"event": "worker_finished", "storyId": sid, "attempt": r["attempt"], "status": status,
                  "startedAt": r.get("startedAt"), "finishedAt": r.get("finishedAt")}
    if worker_ref:
        base_event["workerRef"] = worker_ref[:120]
    out: dict = {"storyId": sid, "workerStatus": status, "ok": True}

    def failed(code: str, message: str, **extra) -> dict:
        res = fail_story(root, wf, sid, code, message)
        audit(root, **base_event, outcome="failed", error=code)
        return {**out, "ok": False, "outcome": "retry" if res["retry"] else "failed", "error": {"code": code, "message": message[:300]}, **extra}

    if r.get("analysis"):
        bad = record_analysis(root, wf, sid, r)
        if bad:
            return failed("ANALYSIS_INVALID", "; ".join(bad["problems"][:3]))

    if status == "failed":
        e = r.get("error") or {"code": "WORKER_FAILED", "message": "the worker reported a failure"}
        res = failed(e["code"], e["message"])
        if r.get("validation"):
            res["validation"] = {k: r["validation"][k] for k in ("status", "errors", "warnings") if k in r["validation"]}
        return res

    if status == "not_testable":
        merge_traceability(root, build_trace_patch(root, wf, sid, r))
        st.update(status="skipped", updatedAt=td.utc_now())
        ex.update(awaiting=None); ex.pop("leaseExpiresAt", None)
        audit(root, **base_event, outcome="skipped")
        audit(root, event="story_skipped", storyId=sid, reason="no_testable_behaviour")
        return {**out, "outcome": "skipped", "reason": (r.get("analysis") or {}).get("not_testable_reason", "no testable behaviour")}

    if status == "needs_clarification":
        qs = r.get("clarifications", [])
        st.update(status="needs_clarification", clarification="; ".join(q["question"] for q in qs)[:900], updatedAt=td.utc_now())
        ex.update(awaiting="clarification", questions=qs); ex.pop("leaseExpiresAt", None)
        audit(root, **base_event, outcome="needs_clarification")
        return {**out, "outcome": "needs_clarification", "questions": qs}

    if status == "needs_decision" and not handled:
        d = r.get("decision") or {"code": "DECISION", "message": "the worker needs a decision"}
        st.update(status="needs_clarification", updatedAt=td.utc_now())
        ex.update(awaiting="decision", decision=d); ex.pop("leaseExpiresAt", None)
        audit(root, **base_event, outcome="needs_decision", code=d.get("code"))
        return {**out, "outcome": "needs_decision", "decision": d, "testCaseIds": r.get("testCaseIds", [])}

    if status == "staged" and mode != "commit_staged":
        st["updatedAt"] = td.utc_now()
        ex.update(awaiting=None); ex.pop("leaseExpiresAt", None)
        if st.get("testCaseFile"):  # a regenerated story keeps its saved file until the user agrees to replace it
            st["status"] = "saved"
        else:
            st["status"] = "pending"
        audit(root, **base_event, outcome="staged")
        return {**out, "outcome": "staged", "decision": r.get("decision"), "testCaseIds": r.get("testCaseIds", []),
                "validation": r.get("validation"), "uncovered": r.get("uncovered", [])}

    # ---- saved / saving / needs_decision after the file was handled by hand / staged and committed: verify the file
    rel = td.testcase_rel_path(sid)
    f = td.confine(root, rel)
    intended = (r.get("testCaseIds") or []) if status == "staged" else (r.get("added") or r.get("testCaseIds") or [])
    if not f.is_file():
        return failed("OUTPUT_MISSING", f"{rel} does not exist although the worker reported {status}")
    doc = td.parse_test_cases(td.read_text(f))
    ids_in_file = [c.id for c in doc.cases if c.id]
    if status in ("saving", "needs_decision", "staged") and not all(i in ids_in_file for i in intended):
        if mode == "commit_staged":
            raise td.SafeOpError("NOT_COMMITTED", f"{rel} does not hold the staged cases yet; replace the file first.", td.EXIT_CONFLICT)
        return failed("SAVE_INCOMPLETE", "the worker stopped before its cases reached the file; the story will be run again")
    actual = td.sha256_file(f)
    edited = bool(r.get("outputFile", {}).get("sha256")) and r["outputFile"]["sha256"] != actual
    trace = td.confine(root, pc.TRACEABILITY)
    vargs = [str(f), "--story-id", sid, "--check-file-name"] + (["--traceability", str(trace)] if trace.is_file() else [])
    code, report = pc.run_script("validate-test-cases.py", *vargs)
    validation = pc.validation_block(report)
    if code != td.EXIT_OK or validation["errors"]:
        return failed("CENTRAL_VALIDATION", f"{rel} has {validation['errors']} validation error(s)", validation=validation)
    if r.get("validation"):  # keep the worker's own warnings (uncovered criteria, ...) alongside the central ones
        seen = {(x["code"], x.get("caseId")) for x in validation["findings"]}
        extra = [x for x in r["validation"].get("findings", []) if x["severity"] == "warning" and (x["code"], x.get("caseId")) not in seen]
        validation["findings"] = (validation["findings"] + extra)[:12]
        validation["warnings"] = sum(1 for x in validation["findings"] if x["severity"] == "warning") or validation["warnings"]
        if validation["warnings"] and validation["status"] == "passed":
            validation["status"] = "passed_with_warnings"
    remove: list[str] = []
    if mode == "commit_staged" and trace.is_file():  # cases the replaced file no longer has are dropped from the mapping
        remove = [cid for cid, m in pc.read_json(trace, "traceability.json").get("cases", {}).items()
                  if sid in m.get("storyIds", []) and cid not in ids_in_file]
    merge_traceability(root, build_trace_patch(root, wf, sid, {**r, "trace": r.get("trace") or {"cases": {}}}, remove))
    tcode, treport = pc.run_script("validate-traceability.py", "--test-cases", str(f), "--traceability", str(trace))
    if tcode != td.EXIT_OK:
        return failed("TRACEABILITY", "; ".join(x.get("message", "")[:120] for x in treport.get("findings", [])[:3]) or "traceability check failed",
                      validation=validation)
    now_s = td.utc_now()
    st.update(status="saved", lastCompletedStage="save", testCaseIds=ids_in_file, updatedAt=now_s, validation=validation)
    st["testCaseFile"] = {"path": rel, "sha256": actual, "caseCount": len(ids_in_file), "sourceSha256": an.get("sourceSha256", r.get("sourceSha256", "")),
                          "designRulesSha256": pc.design_rules_sha256(), "updatedAt": now_s}
    st.pop("clarification", None)
    ex.update(awaiting=None, questions=[], decision=None); ex.pop("leaseExpiresAt", None); ex.pop("lastError", None); ex.pop("adopt", None)
    refresh_outputs(root, wf)
    audit(root, **base_event, outcome="saved", cases=len(ids_in_file))
    if mode == "commit_staged":
        audit(root, event="story_regenerated", storyId=sid, cases=len(ids_in_file), removed=len(remove), file=rel)
    else:
        audit(root, event="story_saved", storyId=sid, cases=r.get("added") or ids_in_file, file=rel)
    res = {**out, "outcome": "saved", "file": rel, "caseCount": len(ids_in_file), "added": len(r.get("added") or []), "validation": {
        k: validation[k] for k in ("status", "errors", "warnings")}, "uncovered": r.get("uncovered", [])}
    if edited or r.get("userEditsDetected"):
        res["userEditsDetected"] = True
    if not r.get("added") and status == "saved" and mode == "normal":
        res["note"] = "the cases were already in the file; nothing new was appended"
    return res


def reconcile_running(root: Path, wf: dict, a, rows: list[dict]) -> list[dict]:
    """Interrupted workers: adopt what they finished (result file plus output), release the rest for a retry."""
    done = []
    for row in rows:
        if row["state"] != "interrupted":
            continue
        sid = row["storyId"]
        try:
            res = ingest_story(root, wf, sid, worker_ref=None, tokens=None, duration_ms=None)
        except td.SafeOpError as e:
            res = {"storyId": sid, "outcome": "no_result", "ok": False, "message": str(e)}
        if res["outcome"] in ("no_result", "stale_result"):
            fr = fail_story(root, wf, sid, "INTERRUPTED", "the worker did not report a result before its lease ended")
            audit(root, event="worker_finished", storyId=sid, attempt=dispatch_of(story(wf, sid).get("execution", {})), status="interrupted",
                  outcome="retry" if fr["retry"] else "failed")
            res = {"storyId": sid, "outcome": "retry" if fr["retry"] else "failed", "ok": False, "reason": "interrupted"}
        else:
            res["reconciled"] = True
        done.append(res)
    return done


# --------------------------------------------------------------------------- commands

def _only(a) -> set[str] | None:
    s = csv([a.stories] if getattr(a, "stories", None) else None)
    return set(s) if s else None


def _rules(root: Path, wf: dict) -> dict:
    return sas.load_rules(root, wf) if wf.get("sharedRulesFile") else {}


def cmd_configure(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    changed = apply_settings(wf, a)
    if changed:
        save(root, wf, sha)
    _, cycles = components(wf)
    td.emit({"ok": True, "scheduler": wf["scheduler"], "dependencyCycles": cycles})
    return td.EXIT_OK


def cmd_plan(a) -> int:
    root = Path(a.root).resolve()
    wf, _ = load(root)
    rows = classify(root, wf, a, _rules(root, wf), _only(a))
    _, cycles = components(wf)
    td.emit({"ok": True, "runId": wf["runId"], "scheduler": {**settings(wf), "designRulesChanged": bool(
        wf.get("scheduler", {}).get("designRulesSha256") and wf["scheduler"]["designRulesSha256"] != pc.design_rules_sha256())},
        "counts": counts(rows), "dependencyCycles": cycles, "stories": rows})
    return td.EXIT_OK


def cmd_next(a) -> int:
    root = Path(a.root).resolve()
    run_dir = Path(a.run_dir).resolve()
    if run_dir.is_relative_to(td.output_dir(root)):
        raise td.SafeOpError("BAD_OUTPUT", "Use the session scratch folder for --run-dir, not test-design/.", td.EXIT_USAGE)
    wf, sha = load(root)
    apply_settings(wf, a)
    rules = _rules(root, wf)
    only = _only(a)
    rows = classify(root, wf, a, rules, only)
    reconciled = reconcile_running(root, wf, a, rows)
    if reconciled:
        rows = classify(root, wf, a, rules, only)
    cfg = settings(wf)
    running = sum(1 for s in wf["stories"].values() if s.get("status") == "running")
    free = max(0, cfg["concurrency"] - running)
    slots = min(a.slots, free) if a.slots else free
    rule_map = pairs(a.rules, "--rules")
    regenerate, adopt = set(csv(a.regenerate)), set(csv(a.adopt))
    dispatched, t = [], pc.now()
    for row in rows:
        if len(dispatched) >= slots:
            break
        if row["state"] not in ("dispatch", "retry", "regenerate"):
            continue
        sid = row["storyId"]
        st = story(wf, sid)
        ex = st.setdefault("execution", {})
        op = output_plan(root, st, sid, adopt, regenerate)
        _, content = sas.load_story(root, wf, sid)
        rule_ids = rule_map.get(sid) or ex.get("ruleIds") or (auto_rules(content, rules) if a.rules_auto else [])
        if row["state"] == "regenerate" or st.get("status") == "failed":
            ex["attempts"] = 0  # an explicit regenerate or --retry-failed starts a fresh, bounded attempt budget
        attempt = ex["dispatchCount"] = dispatch_of(ex) + 1
        ex["attempts"] = ex.get("attempts", 0) + 1
        inp, meta = build_input(root, wf, sid, rule_ids, op, attempt, run_dir)
        errs = sas.input_violations({k: inp[k] for k in sas.INPUT_KEYS})
        if errs:
            raise td.SafeOpError("INPUT_CONTRACT", f"The worker input for '{sid}' breaks the isolation contract: " + "; ".join(errs[:3]), td.EXIT_FINDINGS)
        path = run_dir / "inputs" / f"{sid}.input.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(inp, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        ex.update(mode=op["mode"], ruleIds=rule_ids, dispatchedAt=iso_now(t),
                  leaseExpiresAt=pc.iso(t + _dt.timedelta(minutes=cfg["leaseMinutes"])), awaiting=None)
        ex.pop("lastError", None); ex.pop("workerRef", None)
        if op.get("adopt_existing"):
            ex["adopt"] = True
        st["status"] = "running"
        st["analysis"] = {"status": "in_progress", "attempts": attempt, "sourceSha256": meta["sourceSha256"], "sharedRules": meta["sharedRules"],
                          "dependencies": meta["dependencies"], "inputFingerprint": meta["inputFingerprint"], "startedAt": iso_now(t)}
        st["updatedAt"] = iso_now(t)
        audit(root, event="worker_dispatched", runId=wf["runId"], storyId=sid, attempt=attempt, mode=op["mode"],
              inputFingerprint=meta["inputFingerprint"], concurrency=cfg["concurrency"])
        dispatched.append({"storyId": sid, "attempt": attempt, "attemptsUsed": ex["attempts"], "mode": op["mode"], "inputPath": str(path), "prompt": (
            f"Process exactly one story. Worker input file: {path}\nFollow your instructions. Your final answer is only the compact "
            f"JSON that `story-worker.py complete` prints.")})
    wf["status"] = "in_progress"
    wf["inProgressOperation"] = {"name": "worker_pool", "storyId": None, "startedAt": iso_now(t)} if (dispatched or running) else None
    save(root, wf, sha)
    after = classify(root, wf, a, rules, only)
    waiting = [{"storyId": r["storyId"], "state": r["state"], **({"waitingFor": r["waitingFor"]} if r.get("waitingFor") else {})}
               for r in after if r["state"] in ("waiting_dependency", "blocked_dependency", "blocked_untracked_output", "awaiting_user", "exhausted")]
    pending = sum(1 for r in after if r["state"] in ("dispatch", "retry", "regenerate", "waiting_dependency"))
    td.emit({"ok": True, "dispatched": dispatched, "reconciled": reconciled, "running": running + len(dispatched),
             "concurrency": cfg["concurrency"], "freeSlots": max(0, free - len(dispatched)), "queued": pending, "attention": waiting,
             "done": not (dispatched or running or pending)})
    return td.EXIT_OK


def iso_now(t=None) -> str:
    return pc.iso(t or pc.now())


def cmd_ingest(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    mode = "commit_staged" if a.commit_staged else ("file_handled" if a.file_handled else "normal")
    res = ingest_story(root, wf, a.story_id, worker_ref=a.worker_ref, tokens=a.tokens, duration_ms=a.duration_ms, mode=mode)
    if res["outcome"] in ("no_result", "stale_result"):
        res["next"] = "run `story-run.py fail` for this story (worker produced no usable result)"
    elif res["outcome"] != "already_saved":
        wf["lastCompletedOperation"] = {"name": "ingest", "storyId": a.story_id, "completedAt": td.utc_now()}
        if not any(s.get("status") == "running" for s in wf["stories"].values()):
            wf["inProgressOperation"] = None
        save(root, wf, sha)
    td.emit(res)
    return td.EXIT_OK if res.get("ok") else td.EXIT_FINDINGS


def cmd_fail(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    st = story(wf, a.story_id)
    if st.get("status") != "running":
        raise td.SafeOpError("NOT_RUNNING", f"Story '{a.story_id}' is {st.get('status')}, not running.", td.EXIT_CONFLICT)
    ex = st.setdefault("execution", {})
    if a.tokens is not None or a.duration_ms is not None:
        st["metrics"] = {"tokens": a.tokens or 0, "durationMs": a.duration_ms or 0, "attempts": ex.get("attempts", 1)}
    res = fail_story(root, wf, a.story_id, "WORKER_CRASH", a.reason)
    ev = {"event": "worker_finished", "storyId": a.story_id, "attempt": dispatch_of(ex), "status": "crashed", "outcome": "retry" if res["retry"] else "failed"}
    if a.worker_ref:
        ev["workerRef"] = a.worker_ref[:120]
    audit(root, **ev)
    if not any(s.get("status") == "running" for s in wf["stories"].values()):
        wf["inProgressOperation"] = None
    save(root, wf, sha)
    td.emit({"ok": True, "storyId": a.story_id, "outcome": "retry" if res["retry"] else "failed", "attempts": res["attempts"]})
    return td.EXIT_OK


def cmd_clarify(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    st = story(wf, a.story_id)
    ex = st.setdefault("execution", {})
    if st.get("status") != "needs_clarification" or ex.get("awaiting") != "clarification":
        raise td.SafeOpError("NOT_AWAITING", f"Story '{a.story_id}' is not waiting for a clarification.", td.EXIT_CONFLICT)
    if td.contains_secret(a.answer):
        raise td.SafeOpError("SECRET_DETECTED", "The answer looks like it contains a secret; use an env: reference instead.", td.EXIT_FINDINGS)
    entry = {"question": a.question, "answer": a.answer, "at": td.utc_now()}
    if a.declined:
        entry["declined"] = True
    st.setdefault("clarifications", []).append(entry)
    answered = {re.sub(r"\s+", " ", c["question"]).strip().lower() for c in st["clarifications"]}
    open_q = [q for q in ex.get("questions", []) if re.sub(r"\s+", " ", q["question"]).strip().lower() not in answered]
    ex["questions"] = open_q
    if not open_q:  # all answered: the story runs again; a clarification is not a retry
        st["status"] = "pending"
        ex.update(awaiting=None, attempts=max(0, ex.get("attempts", 1) - 1))
        st.pop("clarification", None)
    st["updatedAt"] = td.utc_now()
    audit(root, event="clarification_answered", storyId=a.story_id, question=a.question[:300], declined=bool(a.declined))
    save(root, wf, sha)
    td.emit({"ok": True, "storyId": a.story_id, "remainingQuestions": len(open_q), "status": st["status"]})
    return td.EXIT_OK


def cmd_resolve(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    st = story(wf, a.story_id)
    ex = st.setdefault("execution", {})
    if st.get("status") != "needs_clarification" or ex.get("awaiting") != "decision":
        raise td.SafeOpError("NOT_AWAITING", f"Story '{a.story_id}' is not waiting for a decision.", td.EXIT_CONFLICT)
    if a.action == "skip":
        st["status"] = "skipped"
    else:
        st["status"] = "pending"
        ex["attempts"] = max(0, ex.get("attempts", 1) - 1)
        if a.action == "adopt":
            ex["adopt"] = True
    ex.update(awaiting=None, decision=None)
    st["updatedAt"] = td.utc_now()
    audit(root, event="decision_recorded", storyId=a.story_id, action=a.action)
    save(root, wf, sha)
    td.emit({"ok": True, "storyId": a.story_id, "status": st["status"]})
    return td.EXIT_OK


def cmd_trace_patch(a) -> int:
    root = Path(a.root).resolve()
    wf, _ = load(root)
    r = pc.read_result(root, a.story_id)
    if r is None or r["status"] not in ("saved", "saving", "staged", "needs_decision", "not_testable"):
        raise td.SafeOpError("NO_RESULT", f"Story '{a.story_id}' has no finished worker result to build a patch from.", td.EXIT_MISSING)
    patch = build_trace_patch(root, wf, a.story_id, r, a.remove)
    out = Path(a.output).resolve()
    if out.is_relative_to(td.output_dir(root)):
        raise td.SafeOpError("BAD_OUTPUT", "Write the patch to the session scratch folder.", td.EXIT_USAGE)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(patch, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    td.emit({"ok": True, "patchPath": str(out), "cases": len(patch.get("cases", {}))})
    return td.EXIT_OK


def cmd_status(a) -> int:
    root = Path(a.root).resolve()
    wf, _ = load(root)
    by: dict[str, int] = {}
    tokens = ms = 0
    rows = []
    for sid, st in wf["stories"].items():
        by[st.get("status", "?")] = by.get(st.get("status", "?"), 0) + 1
        m = st.get("metrics") or {}
        tokens += m.get("tokens", 0); ms += m.get("durationMs", 0)
        ex = st.get("execution") or {}
        row = {"storyId": sid, "status": st.get("status"), "cases": (st.get("testCaseFile") or {}).get("caseCount", len(st.get("testCaseIds", [])))}
        if ex.get("attempts"):
            row["attempts"] = ex["attempts"]
        if ex.get("lastError"):
            row["error"] = ex["lastError"]["code"]
        if ex.get("awaiting"):
            row["awaiting"] = ex["awaiting"]
        rows.append(row)
    started = pc.parse_time((wf.get("scheduler") or {}).get("startedAt") or wf.get("createdAt"))
    elapsed = int((pc.now() - started).total_seconds()) if started else None
    td.emit({"ok": True, "runId": wf["runId"], "scheduler": {**settings(wf), "runtimeParallelism": (wf.get("scheduler") or {}).get("runtimeParallelism", "unverified")},
             "byStatus": by, "stories": rows,
             "cost": {"workerTokens": tokens, "sumOfWorkerSeconds": round(ms / 1000, 1), "wallClockSecondsSinceStart": elapsed,
                      "note": "tokens and elapsed time are measured separately; parallel workers shorten elapsed time but do not reduce total tokens"}})
    return td.EXIT_OK


def cmd_check_pool(a) -> int:
    root = Path(a.root).resolve()
    wf, sha = load(root)
    cfg = settings(wf)
    findings: list[str] = []
    active: dict[str, int] = {}
    peak = 0
    refs: dict[str, str] = {}
    dispatched = finished = 0
    for ev in sas.read_audit(root):
        key = f"{ev.get('storyId')}#{ev.get('attempt')}"
        if ev.get("event") == "worker_dispatched":
            dispatched += 1
            active[key] = 1
            peak = max(peak, len(active))
            if len(active) > cfg["concurrency"]:
                findings.append(f"{len(active)} workers were running at once; the limit is {cfg['concurrency']}")
        elif ev.get("event") == "worker_finished":
            finished += 1
            active.pop(key, None)
            ref = ev.get("workerRef")
            if ref:
                if ref in refs and refs[ref] != key:
                    findings.append(f"worker session '{ref}' was used for both {refs[ref]} and {key} (context reused)")
                refs[ref] = key
    spans = []
    for sid in wf["stories"]:
        try:
            r = pc.read_result(root, sid)
        except td.SafeOpError:
            continue
        s, e = (pc.parse_time(r.get("startedAt")), pc.parse_time(r.get("finishedAt"))) if r else (None, None)
        if s and e:
            spans.append((s, e, sid))
    overlap = 0
    events = sorted([(s, 1) for s, _, _ in spans] + [(e, -1) for _, e, _ in spans], key=lambda x: (x[0], x[1]))
    cur = 0
    for _, d in events:
        cur += d
        overlap = max(overlap, cur)
    if overlap >= 2:
        verdict, msg = "parallel", f"Workers overlapped in time (up to {overlap} at once): the runtime runs isolated workers concurrently."
    elif len(spans) >= 2 and peak >= 2:
        verdict = "sequential"
        msg = ("Workers were dispatched together but never overlapped: this runtime appears to run them one after another. "
               "Report this limitation to the user and use --concurrency 1; do not claim parallel execution.")
    else:
        verdict, msg = "unverified", "Not enough finished workers to tell whether the runtime runs them concurrently."
    if a.apply:
        s = wf.setdefault("scheduler", {})
        s["runtimeParallelism"], s["observedConcurrency"] = verdict, overlap
        save(root, wf, sha)
    td.emit({"ok": not findings, "dispatched": dispatched, "finished": finished, "stillRunning": len(active), "peakDispatched": peak,
             "observedOverlap": overlap, "runtimeParallelism": verdict, "message": msg, "workerRefsSeen": len(refs), "findings": findings})
    return td.EXIT_FINDINGS if findings else td.EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, *, schedule: bool = False):
        p.add_argument("--root", required=True)
        if schedule:
            p.add_argument("--stories"); p.add_argument("--reclaim", action="store_true"); p.add_argument("--retry-failed", action="store_true")
            p.add_argument("--regenerate", action="append"); p.add_argument("--adopt", action="append")
        return p

    p = common(sub.add_parser("configure")); p.add_argument("--concurrency", type=int); p.add_argument("--max-attempts", type=int)
    p.add_argument("--lease-minutes", type=int); p.add_argument("--depends", action="append"); p.set_defaults(fn=cmd_configure)
    p = common(sub.add_parser("plan"), schedule=True); p.set_defaults(fn=cmd_plan)
    p = common(sub.add_parser("next"), schedule=True); p.add_argument("--run-dir", required=True); p.add_argument("--slots", type=int)
    p.add_argument("--rules", action="append"); p.add_argument("--rules-auto", action="store_true"); p.add_argument("--concurrency", type=int)
    p.add_argument("--max-attempts", type=int); p.add_argument("--lease-minutes", type=int); p.add_argument("--depends", action="append")
    p.set_defaults(fn=cmd_next)
    p = common(sub.add_parser("ingest")); p.add_argument("--story-id", required=True); p.add_argument("--worker-ref")
    p.add_argument("--tokens", type=int); p.add_argument("--duration-ms", type=int); p.add_argument("--file-handled", action="store_true")
    p.add_argument("--commit-staged", action="store_true"); p.set_defaults(fn=cmd_ingest)
    p = common(sub.add_parser("fail")); p.add_argument("--story-id", required=True); p.add_argument("--reason", required=True)
    p.add_argument("--worker-ref"); p.add_argument("--tokens", type=int); p.add_argument("--duration-ms", type=int); p.set_defaults(fn=cmd_fail)
    p = common(sub.add_parser("clarify")); p.add_argument("--story-id", required=True); p.add_argument("--question", required=True)
    p.add_argument("--answer", required=True); p.add_argument("--declined", action="store_true"); p.set_defaults(fn=cmd_clarify)
    p = common(sub.add_parser("resolve")); p.add_argument("--story-id", required=True)
    p.add_argument("--action", required=True, choices=["adopt", "retry", "skip"]); p.set_defaults(fn=cmd_resolve)
    p = common(sub.add_parser("trace-patch")); p.add_argument("--story-id", required=True); p.add_argument("--output", required=True)
    p.add_argument("--remove", action="append", default=[]); p.set_defaults(fn=cmd_trace_patch)
    p = common(sub.add_parser("status")); p.set_defaults(fn=cmd_status)
    p = common(sub.add_parser("check-pool")); p.add_argument("--apply", action="store_true"); p.set_defaults(fn=cmd_check_pool)
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

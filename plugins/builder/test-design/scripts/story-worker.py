#!/usr/bin/env python3
"""Worker-side commands of the story worker pool. Used by one ``story-worker`` agent for one story.

    story-worker.py check-input --input FILE
    story-worker.py begin       --input FILE
    story-worker.py complete    --input FILE --analysis FILE [--draft FILE --meta FILE] [--conditions FILE]

A worker owns exactly two files: its story's ``test-design/test-cases/<story>-testcase.md`` and its
``test-design/state/results/<story>.result.json``. These commands never write ``workflow.json``,
``traceability.json``, ``audit.jsonl`` or ``state/analysis/``: those belong to the orchestrator
(``story-run.py``), which ingests the result file afterwards.

``begin``    validates the worker input (one story, nothing else) and marks the result file ``running``.
``complete`` validates the analysis, the draft and its metadata with the same deterministic checks the
             sequential flow used, saves the draft into the story's own file (never replacing or
             adopting anything without the orchestrator's say-so), writes the result file and prints the
             compact reply the worker returns as its final answer. It stops, without saving, when the
             story is not testable, a blocking question is open, or the file needs a user decision.

Output is JSON. Exit codes: 0 ok (including "needs the user"), 1 failed / invalid, 2 usage, 3 conflict,
4 missing, 5 outside the output folder, 6 I/O error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pool_common as pc  # noqa: E402

td = pc.td
sas = pc.sas

BASE_KEYS = ("run_id", "story_id", "story_content", "relevant_shared_rules", "dependency_context",
             "analysis_instructions", "output_schema_version")


# --------------------------------------------------------------------------- input contract

def input_violations(inp: object) -> list[str]:
    if not isinstance(inp, dict):
        return ["$: the worker input must be a JSON object"]
    errs = td.validate_json(inp, td.load_schema("story-worker-input"))
    if errs:
        return errs
    out = list(sas.input_violations({k: inp[k] for k in BASE_KEYS}))
    sid, c = inp["story_id"], inp["worker_contract"]
    try:
        if c["result_path"] != pc.result_rel(sid):
            out.append(f"worker_contract.result_path must be {pc.result_rel(sid)}")
        if c["output"]["path"] != td.testcase_rel_path(sid):
            out.append(f"worker_contract.output.path must be {td.testcase_rel_path(sid)}")
    except td.SafeOpError as e:
        out.append(str(e))
    root = Path(c["project_root"])
    scratch = Path(c["scratch_dir"])
    if not root.is_dir():
        out.append("worker_contract.project_root is not a folder")
    elif scratch.resolve().is_relative_to(td.output_dir(root)):
        out.append("worker_contract.scratch_dir must be outside test-design/")
    if c["output"]["mode"] == "append" and not (c["output"].get("expect_sha256") or c["output"].get("adopt_existing")):
        out.append("output.mode append needs expect_sha256 or an adopted file")
    if c["output"]["mode"] == "create" and (c["output"].get("expect_sha256") or c["output"].get("adopt_existing")):
        out.append("output.mode create cannot expect or adopt an existing file")
    if td.contains_secret(sas.text_of(c["confirmed_decisions"])):
        out.append("confirmed_decisions appear to contain a secret or token")
    return out


def load_input(path: str) -> dict:
    p = Path(path)
    inp = pc.read_json(p, "the worker input")
    errs = input_violations(inp)
    if errs:
        raise td.SafeOpError("INPUT_CONTRACT", "The worker input breaks the isolation contract: " + "; ".join(errs[:4]), td.EXIT_FINDINGS)
    return inp


# --------------------------------------------------------------------------- result file

class Result:
    """Builds the worker result; every exit goes through ``finish`` so a result file always exists."""

    def __init__(self, inp: dict, started: str):
        c = inp["worker_contract"]
        self.inp, self.root = inp, Path(c["project_root"]).resolve()
        self.data: dict = {"version": 1, "storyId": inp["story_id"], "runId": inp["run_id"], "attempt": c["attempt"],
                           "startedAt": started, "sourceSha256": c["source_sha256"], "inputFingerprint": c["input_fingerprint"],
                           "dependenciesUsed": [d["story_id"] for d in inp["dependency_context"]]}

    def write(self, status: str, final: bool = True, **fields) -> dict:
        self.data.update(fields)
        self.data["status"] = status
        if final:
            self.data["finishedAt"] = pc.iso(pc.now())
        errs = td.validate_json(self.data, td.load_schema("story-worker-result"))
        if errs:
            raise td.SafeOpError("RESULT_INVALID", "internal: the result would not match its schema: " + "; ".join(errs[:3]), td.EXIT_IO)
        try:
            pc.write_json(self.root, pc.result_rel(self.data["storyId"]), self.data)
        except td.SafeOpError as e:
            if e.code != "SECRET_DETECTED":
                raise
            # never persist or echo the secret-looking content; record that the attempt failed instead
            self.data = {k: self.data[k] for k in ("version", "storyId", "runId", "attempt", "startedAt", "sourceSha256", "inputFingerprint")}
            self.data.update(status="failed", finishedAt=pc.iso(pc.now()),
                             error={"code": "SECRET_DETECTED", "message": "The output looked like it contained a secret; nothing was recorded. Use env: references."})
            pc.write_json(self.root, pc.result_rel(self.data["storyId"]), self.data)
        return self.data

    def finish(self, status: str, **fields) -> tuple[int, dict]:
        data = self.write(status, **fields)
        return (td.EXIT_FINDINGS if data["status"] == "failed" else td.EXIT_OK), pc.compact_reply(data)

    def fail(self, code: str, message: str, **fields) -> tuple[int, dict]:
        return self.finish("failed", error={"code": code, "message": message[:600]}, **fields)


# --------------------------------------------------------------------------- commands

def cmd_check_input(a) -> int:
    p = Path(a.input)
    if not p.is_file():
        raise td.SafeOpError("INPUT_MISSING", f"{p} not found", td.EXIT_MISSING)
    try:
        errs = input_violations(json.loads(td.read_text(p)))
    except ValueError:
        errs = ["the worker input is not valid JSON"]
    td.emit({"ok": not errs, "errors": errs})
    return td.EXIT_FINDINGS if errs else td.EXIT_OK


def cmd_begin(a) -> int:
    inp = load_input(a.input)
    c = inp["worker_contract"]
    res = Result(inp, pc.iso(pc.now()))
    prior = pc.read_result(res.root, inp["story_id"])
    if prior and prior["status"] in ("saved", "staged") and prior["attempt"] == c["attempt"]:
        raise td.SafeOpError("ALREADY_DONE", f"Story '{inp['story_id']}' attempt {c['attempt']} already finished; do not run it again.",
                             td.EXIT_CONFLICT)
    res.write("running", final=False)
    Path(c["scratch_dir"]).mkdir(parents=True, exist_ok=True)
    td.emit({"ok": True, "storyId": inp["story_id"], "attempt": c["attempt"], "startedAt": res.data["startedAt"],
             "scratchDir": c["scratch_dir"], "outputMode": c["output"]["mode"], "outputPath": c["output"]["path"],
             "decisions": len(c["confirmed_decisions"])})
    return td.EXIT_OK


def _started_at(root: Path, sid: str, attempt: int) -> str:
    try:
        prior = pc.read_result(root, sid)
    except td.SafeOpError:
        prior = None
    if prior and prior["attempt"] == attempt and prior.get("startedAt"):
        return prior["startedAt"]
    return pc.iso(pc.now())


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _meta_problems(sid: str, meta: dict[str, dict], draft_ids: list[str], labels: list[str]) -> list[str]:
    out = []
    for cid in draft_ids:
        if cid not in meta:
            out.append(f"{cid}: no metadata entry (every case needs title, storyIds and covers)")
    for cid in draft_ids:
        m = meta.get(cid)
        if m is None:
            continue
        m.setdefault("storyIds", [sid])
        for e in td.validate_json(m, td.load_schema("test-case-metadata")):
            out.append(f"{cid}: {e}")
        if m.get("storyIds") != [sid]:
            out.append(f"{cid}: storyIds must be [{sid!r}] (one story per file)")
        for cov in m.get("covers", []):
            story, _, label = cov.partition("#")
            if story != sid or label not in labels:
                out.append(f"{cid}: covers '{cov}' is not a criterion of {sid} ({labels})")
    return out


def _validate_draft(root: Path, inp: dict, draft: Path, scratch: Path) -> tuple[Path, dict]:
    """Validate the draft exactly as the sequential flow did, trying the formatting-only fix once."""
    c, sid = inp["worker_contract"], inp["story_id"]
    out_file = td.confine(root, c["output"]["path"])
    base = ["--story-id", sid]
    trace = td.confine(root, pc.TRACEABILITY)
    if trace.is_file():
        base += ["--traceability", str(trace)]
    if c["output"]["mode"] == "append" and out_file.is_file():
        base += ["--existing", str(out_file)]
    code, report = pc.run_script("validate-test-cases.py", str(draft), *base)
    if code == td.EXIT_OK:
        return draft, report
    fixed = scratch / f"{sid}.fixed.md"
    fcode, _ = pc.run_script("validate-test-cases.py", str(draft), *base, "--fix-safe", "--fix-output", str(fixed))
    if fcode in (td.EXIT_OK, td.EXIT_FINDINGS) and fixed.is_file():
        code2, report2 = pc.run_script("validate-test-cases.py", str(fixed), *base)
        if code2 == td.EXIT_OK:
            return fixed, report2
    return draft, report


def _coverage(res: Result, labels: list[str], meta: dict[str, dict], excluded: dict[str, str], declared: list[dict]) -> tuple[list[dict], list[dict]]:
    """Criteria covered by this draft or by the story's earlier saved cases; the rest go to ``uncovered``."""
    covered = {cov.partition("#")[2] for m in meta.values() for cov in m.get("covers", [])}
    trace = td.confine(res.root, pc.TRACEABILITY)
    if trace.is_file():
        try:
            for m in json.loads(td.read_text(trace)).get("cases", {}).values():
                if res.data["storyId"] in m.get("storyIds", []):
                    covered |= {cov.partition("#")[2] for cov in m.get("covers", [])}
        except (ValueError, AttributeError):
            pass
    uncovered = {d["label"]: d["reason"] for d in declared}
    for lab, why in excluded.items():
        uncovered.setdefault(lab, why)
    warnings = []
    for lab in labels:
        if lab in covered:
            uncovered.pop(lab, None)
        elif lab not in uncovered:
            uncovered[lab] = "no case covers it"
            warnings.append({"code": "CRITERION_UNCOVERED", "severity": "warning",
                             "message": f"{lab} is not covered by any case and was not declared uncovered"})
    return [{"label": k, "reason": v[:300]} for k, v in uncovered.items() if k in labels], warnings


def _declared_uncovered(path: str | None) -> list[dict]:
    if not path:
        return []
    raw = pc.read_json(Path(path), "the conditions file")
    items = raw.get("uncovered", []) if isinstance(raw, dict) else []
    out = []
    for it in items:
        if isinstance(it, dict) and it.get("label"):
            out.append({"label": str(it["label"]), "reason": str(it.get("reason") or "not covered")})
        elif isinstance(it, str):
            out.append({"label": it, "reason": "declared uncovered by coverage design"})
    return out


def cmd_complete(a) -> int:
    inp = load_input(a.input)
    sid, c = inp["story_id"], inp["worker_contract"]
    res = Result(inp, _started_at(Path(c["project_root"]).resolve(), sid, c["attempt"]))
    root, scratch = res.root, Path(c["scratch_dir"])
    scratch.mkdir(parents=True, exist_ok=True)

    def emit(pair: tuple[int, dict]) -> int:
        td.emit({"ok": pair[0] == td.EXIT_OK, **pair[1]})
        return pair[0]

    # ---- 1. the analysis
    try:
        analysis = json.loads(sas.strip_fence(td.read_text(Path(a.analysis))))
    except (OSError, ValueError):
        return emit(res.fail("ANALYSIS_INVALID", "The analysis file is missing or is not valid JSON."))
    problems = sas.result_violations(analysis, sid)
    if problems:
        return emit(res.fail("ANALYSIS_INVALID", "; ".join(problems)))
    labels = sas.labels_of(analysis)
    res.data.update(analysis=analysis, criteria=labels)
    if analysis.get("testable", True) is False:
        return emit(res.finish("not_testable"))

    decisions = c["confirmed_decisions"]
    answered = {_norm(d["question"]) for d in decisions}
    excluded: dict[str, str] = {}
    for d in decisions:
        if d.get("declined"):
            for amb in analysis.get("ambiguities", []):
                if _norm(amb["question"]) == _norm(d["question"]):
                    for lab in amb.get("blocks", []):
                        excluded[lab] = "the user declined to answer: " + amb["question"][:200]
    open_q = [x for x in analysis.get("ambiguities", []) if x["blocking"] and _norm(x["question"]) not in answered]
    if open_q:
        return emit(res.finish("needs_clarification", clarifications=[
            {"question": x["question"], **({"blockedCriteria": x["blocks"]} if x.get("blocks") else {})} for x in open_q]))

    # ---- 2. the draft
    draft, meta_path = Path(a.draft) if a.draft else None, Path(a.meta) if a.meta else None
    if not draft or not draft.is_file() or not meta_path or not meta_path.is_file():
        return emit(res.fail("DRAFT_MISSING", "The draft and its metadata file are required for a testable story."))
    checked, report = _validate_draft(root, inp, draft, scratch)
    validation = pc.validation_block(report)
    doc = td.parse_test_cases(td.read_text(checked))
    target = td.confine(root, c["output"]["path"])
    errors = [f for f in report.get("findings", []) if f.get("severity") == "error"]
    saved_ids = {x.id for x in td.parse_test_cases(td.read_text(target)).cases} if target.is_file() and c["output"]["mode"] == "append" else set()
    if errors and saved_ids and all(f.get("code") == "DUPLICATE_ID" and f.get("caseId") in saved_ids for f in errors):
        # the only problem is that these cases are already saved: identical = a resumed run, different = the user's call
        old = td.parse_test_cases(td.read_text(target))
        blocks = {x.id: [l.rstrip() for l in td.case_block(old, x)] for x in old.cases if x.id}
        same = all(blocks.get(x.id) == [l.rstrip() for l in td.case_block(doc, x)] for x in doc.cases if x.id in saved_ids)
        if same and all(x.id in saved_ids for x in doc.cases if x.id):
            return emit(res.finish("saved", outputFile={"path": c["output"]["path"], "sha256": td.sha256_file(target), "caseCount": len(old.cases)},
                                   added=[], testCaseIds=[x.id for x in old.cases if x.id], criteria=labels,
                                   validation={"status": "passed", "errors": 0, "warnings": 0, "findings": []},
                                   trace={"cases": {cid: m for cid, m in pc.normalise_meta(json.loads(td.read_text(meta_path))).items() if cid in saved_ids}}))
        return emit(res.finish("needs_decision", decision={
            "code": "ID_CONFLICT", "message": "Some cases in the draft have the same ID as saved cases but different content; only the user can choose "
                                              "to keep the saved ones or replace them.", "draftPath": str(checked), "metaPath": str(meta_path)}, testCaseIds=[x.id for x in doc.cases if x.id]))
    if validation["errors"]:
        return emit(res.fail("VALIDATION", f"The draft has {validation['errors']} validation error(s); nothing was saved.",
                             validation=validation))
    draft_ids = [x.id for x in doc.cases if x.id]
    try:
        meta = pc.normalise_meta(json.loads(td.read_text(meta_path)))
    except (OSError, ValueError):
        return emit(res.fail("META_INVALID", "The metadata file is missing or is not valid JSON.", validation=validation))
    meta_errs = _meta_problems(sid, meta, draft_ids, labels)
    if meta_errs:
        return emit(res.fail("META_INVALID", "; ".join(meta_errs[:6]), validation=validation))
    uncovered, cov_warnings = _coverage(res, labels, meta, excluded, _declared_uncovered(a.conditions))
    if cov_warnings:
        validation["warnings"] += len(cov_warnings)
        validation["findings"] = (validation["findings"] + cov_warnings)[:12]
        validation["status"] = "passed_with_warnings"
    trace = {"cases": {cid: meta[cid] for cid in draft_ids}}
    common = dict(validation=validation, trace=trace, uncovered=uncovered, testCaseIds=draft_ids, added=draft_ids)

    # ---- 3. save into this story's own file, or stop for the orchestrator
    out = c["output"]
    if out["mode"] == "stage_only":
        return emit(res.finish("staged", decision={"code": "STAGED", "message": "Validated draft ready for the dry run; the orchestrator replaces the file only after the user agrees.",
                                                    "draftPath": str(checked), "metaPath": str(meta_path)}, **common))
    res.write("saving", final=False, **common)  # the intent survives a crash between the save and the result file
    args = ["merge-cases", "--root", str(root), "--target", out["path"], "--source", str(checked), "--story-id", sid]
    if out["mode"] == "append":
        if out.get("expect_sha256"):
            args += ["--expect-sha256", out["expect_sha256"]]
        elif out.get("adopt_existing"):
            args.append("--adopt-existing")
    code, j = pc.run_script("safe-file-operations.py", *args)
    if code == td.EXIT_OK:
        final_doc = td.parse_test_cases(td.read_text(target))
        extra = {"userEditsDetected": True} if j.get("userEditsDetected") else {}
        return emit(res.finish("saved", outputFile={"path": out["path"], "sha256": td.sha256_file(target), "caseCount": len(final_doc.cases)},
                               **{**common, "added": j.get("added", []), "testCaseIds": [x.id for x in final_doc.cases if x.id]}, **extra))
    err = j.get("error", {})
    ecode = err.get("code", "SAVE_FAILED")
    if ecode == "ID_CONFLICT" and target.is_file():
        old = td.parse_test_cases(td.read_text(target))
        blocks = {x.id: [l.rstrip() for l in td.case_block(old, x)] for x in old.cases if x.id}
        if all(blocks.get(x.id) == [l.rstrip() for l in td.case_block(doc, x)] for x in doc.cases if x.id):
            return emit(res.finish("saved", outputFile={"path": out["path"], "sha256": td.sha256_file(target), "caseCount": len(old.cases)},
                                   **{**common, "added": [], "testCaseIds": [x.id for x in old.cases if x.id]}))
    if code in (td.EXIT_CONFLICT, td.EXIT_MISSING):
        return emit(res.finish("needs_decision", decision={"code": ecode, "message": str(err.get("message", ""))[:400],
                                                            "draftPath": str(checked), "metaPath": str(meta_path)}, **common))
    return emit(res.fail(ecode, str(err.get("message", "The test-case file could not be saved."))))


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check-input"); p.add_argument("--input", required=True); p.set_defaults(fn=cmd_check_input)
    p = sub.add_parser("begin"); p.add_argument("--input", required=True); p.set_defaults(fn=cmd_begin)
    p = sub.add_parser("complete"); p.add_argument("--input", required=True); p.add_argument("--analysis", required=True)
    p.add_argument("--draft"); p.add_argument("--meta"); p.add_argument("--conditions"); p.set_defaults(fn=cmd_complete)
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

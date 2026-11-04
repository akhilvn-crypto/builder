#!/usr/bin/env python3
"""Safe, confined file operations for generated Test Design artefacts.

Every write stays inside ``<root>/test-design/`` (so source stories and the plugin are never
touched), uses a temp file + atomic replace, refuses to overwrite without permission or a
matching hash, keeps a backup of anything it replaces under ``state/backups/`` and verifies the
result by reading it back.

    safe-file-operations.py check-access --root R [--source FILE ...]
    safe-file-operations.py hash FILE...
    safe-file-operations.py write        --root R --target T --source FILE [--expect-sha256 H | --allow-overwrite]
                                         [--schema NAME] [--validate-cases] [--no-backup]
    safe-file-operations.py merge-cases  --root R --target T --source DRAFT [--expect-sha256 H] [--on-conflict fail|skip]
                                         [--require-story-id] [--story-id S [--adopt-existing]]
    safe-file-operations.py replace-case --root R --target T --id ID --source DRAFT --expect-sha256 H --yes
    safe-file-operations.py regenerate-story-file --root R --story-id S --source DRAFT --expect-sha256 H
                                         [--yes [--accept-user-edits]]
    safe-file-operations.py split-legacy --root R [--yes]
    safe-file-operations.py merge-json   --root R --target T --patch-file P [--schema NAME] [--create] [--touch FIELD]
    safe-file-operations.py append-jsonl --root R --target T (--entry JSON | --entry-file F)

``merge-cases`` appends validated cases to the end of their module section (same module name and
``User Story ID``) in the target and leaves every existing byte untouched (user edits survive). ``replace-case`` swaps one case and needs ``--yes``,
which the caller may pass only after the user agreed. All commands print JSON.

Test cases live in one file per story, ``test-design/test-cases/<USER_STORY_ID>-testcase.md``. With
``--story-id S``, ``merge-cases`` insists on that exact target, accepts only S's cases, refuses IDs that
belong to other stories (read from traceability.json, never from another test-case file) and will not append to
a file this run never recorded unless ``--adopt-existing`` says the user agreed. ``regenerate-story-file``
replaces one story's whole file: without ``--yes`` it only reports what would be kept, added, removed and
changed; with ``--yes`` it writes (backup kept), and ``--accept-user-edits`` is also needed when the file was
edited since it was last recorded. ``split-legacy`` turns an old consolidated ``test-cases.md`` into per-story
files (dry run unless ``--yes``; the old file is moved to ``state/backups/``, never deleted).
Exit codes: 0 ok, 1 validation findings, 2 usage, 3 conflict/exists, 4 missing/corrupt, 5 outside
the output folder, 6 I/O error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402


def _summ(report: dict) -> dict:
    return {"errors": report["summary"]["errors"], "warnings": report["summary"]["warnings"],
            "findings": report["findings"]}


def cmd_check_access(a) -> int:
    root = Path(a.root).resolve()
    out = td.output_dir(root)
    res = {"root": td.check_dir_access(root, probe=False),
           "outputDir": td.check_dir_access(out, probe=True)}
    res["sources"] = []
    for s in a.source:
        p = Path(s)
        ok = p.is_file() and os.access(p, os.R_OK)
        res["sources"].append({"path": str(p), "readable": ok})
    ok = res["outputDir"]["writable"] and res["outputDir"]["readable"] and all(x["readable"] for x in res["sources"])
    td.emit({"ok": ok, **res})
    return td.EXIT_OK if ok else td.EXIT_IO


def cmd_hash(a) -> int:
    out = {}
    for f in a.files:
        p = Path(f)
        out[f] = td.sha256_file(p) if p.is_file() else None
    td.emit({"ok": True, "hashes": out})
    return td.EXIT_OK


def _read_source(path: str) -> bytes:
    p = Path(path)
    if not p.is_file():
        raise td.SafeOpError("SOURCE_MISSING", f"Source file not found: {p}", td.EXIT_MISSING)
    return p.read_bytes()


def cmd_write(a) -> int:
    data = _read_source(a.source)
    if a.schema:
        try:
            value = json.loads(data.decode("utf-8-sig"))
        except ValueError:
            raise td.SafeOpError("INVALID_JSON", "Content is not valid JSON", td.EXIT_FINDINGS)
        errs = td.validate_json(value, td.load_schema(a.schema))
        if errs:
            td.emit({"ok": False, "error": {"code": "SCHEMA", "message": "Content does not match the schema"}, "errors": errs})
            return td.EXIT_FINDINGS
    if a.validate_cases:
        doc = td.parse_test_cases(data.decode("utf-8-sig"))
        report = td.validation_report(doc, td.validate_doc(doc, None, require_story_id=a.require_story_id))
        if not report["ok"]:
            td.emit({"ok": False, "error": {"code": "VALIDATION", "message": "Test cases failed validation; nothing was written"},
                     **_summ(report)})
            return td.EXIT_FINDINGS
    res = td.safe_write(Path(a.root), Path(a.target), data, expect_sha=a.expect_sha256,
                        allow_overwrite=a.allow_overwrite, backup=not a.no_backup)
    td.emit({"ok": True, **res})
    return td.EXIT_OK


TRACEABILITY = f"{td.OUTPUT_DIRNAME}/state/traceability.json"


def _foreign_ids(root: Path, story_id: str) -> dict:
    """IDs the traceability index assigns to other stories (empty when there is no index yet)."""
    p = td.confine(root, TRACEABILITY)
    if not p.is_file():
        return {}
    try:
        return td.foreign_case_ids(json.loads(td.read_text(p)), story_id)
    except ValueError:
        raise td.SafeOpError("STATE_CORRUPT", f"{p.name} is not valid JSON. It was not changed; "
                             "explain this to the user and ask how to proceed.", td.EXIT_MISSING)


def _story_target(root: Path, story_id: str, target: Path) -> Path:
    want = td.confine(root, td.testcase_rel_path(story_id))
    if target != want:
        raise td.SafeOpError("WRONG_TARGET", f"Story {story_id}'s test cases belong in {td.testcase_rel_path(story_id)}, "
                             f"not {target.name}.", td.EXIT_USAGE)
    return want


def cmd_merge_cases(a) -> int:
    root = Path(a.root)
    target = td.confine(root, a.target)
    foreign = None
    if a.story_id:
        _story_target(root, a.story_id, target)
        foreign = _foreign_ids(root, a.story_id)
        if target.is_file() and not a.expect_sha256 and not a.adopt_existing:
            raise td.SafeOpError("EXISTS_UNTRACKED",
                                 f"{target.name} already exists but this run has not recorded it. Show the user what it holds and ask "
                                 "whether to append to it; only then repeat with --adopt-existing. Nothing was written.",
                                 td.EXIT_CONFLICT)
    src_text = _read_source(a.source).decode("utf-8-sig")
    src = td.parse_test_cases(src_text)
    target_text = td.read_text(target) if target.is_file() else ""
    if a.expect_sha256 and not target.is_file():
        raise td.SafeOpError("MISSING", f"{target.name} is missing although a previous hash was expected; "
                             "ask the user how to proceed.", td.EXIT_MISSING)
    current_sha = td.sha256_file(target) if target.is_file() else None
    user_edits = bool(a.expect_sha256 and current_sha and current_sha != a.expect_sha256)

    existing = td.parse_test_cases(target_text) if target_text.strip() else None
    existing_ids = {c.id for c in existing.cases if c.id} if existing else set()
    conflicts = sorted({c.id for c in src.cases if c.id and c.id in existing_ids})
    skipped: list[str] = []
    if conflicts:
        if a.on_conflict == "fail":
            td.emit({"ok": False, "error": {"code": "ID_CONFLICT",
                                            "message": "These IDs already exist in the target; nothing was written. "
                                                       "Ask the user whether to skip or replace them."},
                     "conflicts": conflicts})
            return td.EXIT_CONFLICT
        keep = [c for c in src.cases if c.id not in conflicts]
        src_text = _rebuild(src, keep) if keep else ""
        src = td.parse_test_cases(src_text)
        skipped = conflicts

    if skipped and not src.cases:
        td.emit({"ok": True, "added": [], "skippedExisting": skipped, "note": "Every draft case already exists; nothing to add"})
        return td.EXIT_OK
    report = td.validation_report(src, td.validate_doc(src, existing, require_story_id=a.require_story_id,
                                                       story_id=a.story_id, foreign_ids=foreign))
    if not report["ok"]:
        td.emit({"ok": False, "error": {"code": "VALIDATION", "message": "Draft failed validation; nothing was written"},
                 **_summ(report)})
        return td.EXIT_FINDINGS

    merged, placed = td.merge_cases_text(target_text, src)
    data = merged.encode("utf-8")
    res = td.safe_write(root, target, data, expect_sha=current_sha, allow_overwrite=current_sha is None, backup=True)
    final = td.parse_test_cases(merged)
    new_ids = {c.id for c in src.cases}
    final_report = td.validation_report(final, td.validate_doc(final, foreign_ids=foreign))
    td.emit({"ok": True, **res, "added": [c.id for c in src.cases], "skippedExisting": skipped,
             "placement": placed, "userEditsDetected": user_edits,
             "totalCases": len(final.cases),
             "warnings": [f for f in final_report["findings"] if f.get("caseId") in new_ids and f["severity"] == "warning"],
             "fileWideErrors": final_report["summary"]["errors"]})
    return td.EXIT_OK


def _rebuild(doc: td.Doc, keep: list) -> str:
    """Re-emit only the kept cases (used when --on-conflict skip drops some)."""
    out: list[str] = []
    last_mod = object()
    for c in keep:
        if (c.module, c.story_id) != last_mod:
            if c.module:
                out += ([""] if out else []) + td.module_header(c.module, c.story_id)
            last_mod = (c.module, c.story_id)
        out += [""] + td.case_block(doc, c) if out else td.case_block(doc, c)
    return doc.newline.join(out) + doc.newline


def cmd_replace_case(a) -> int:
    if not a.yes:
        raise td.SafeOpError("CONSENT_REQUIRED", "replace-case needs --yes, passed only after the user agreed to replace this case",
                             td.EXIT_USAGE)
    root = Path(a.root)
    target = td.confine(root, a.target)
    if not target.is_file():
        raise td.SafeOpError("MISSING", f"{target.name} does not exist", td.EXIT_MISSING)
    text = td.read_text(target)
    doc = td.parse_test_cases(text)
    old = doc.by_id().get(a.id)
    if not old:
        raise td.SafeOpError("CASE_NOT_FOUND", f"{a.id} is not in {target.name}", td.EXIT_MISSING)
    src = td.parse_test_cases(_read_source(a.source).decode("utf-8-sig"))
    if len(src.cases) != 1 or src.cases[0].id != a.id:
        raise td.SafeOpError("SOURCE_MISMATCH", f"The draft must contain exactly one case with ID {a.id}", td.EXIT_USAGE)
    rest = td.parse_test_cases(td.remove_case_text(text, a.id))
    report = td.validation_report(src, td.validate_doc(src, rest))
    if not report["ok"]:
        td.emit({"ok": False, "error": {"code": "VALIDATION", "message": "Replacement failed validation; nothing was written"},
                 **_summ(report)})
        return td.EXIT_FINDINGS
    block = td.case_block(src, src.cases[0])
    lines = doc.lines[:old.start] + block + doc.lines[old.end:]
    res = td.safe_write(root, target, (doc.newline.join(lines) + doc.newline).encode("utf-8"),
                        expect_sha=a.expect_sha256, backup=True)
    td.emit({"ok": True, **res, "replaced": a.id})
    return td.EXIT_OK


def _case_digest(doc: td.Doc) -> dict:
    return {c.id: td.case_signature(c) for c in doc.cases if c.id}


def cmd_regenerate_story_file(a) -> int:
    """Replace one story's whole file with a freshly generated draft, only with consent (dry run by default)."""
    root = Path(a.root)
    target = td.confine(root, td.testcase_rel_path(a.story_id))
    if not target.is_file():
        raise td.SafeOpError("MISSING", f"{target.name} does not exist; save the story's first cases with merge-cases instead.",
                             td.EXIT_MISSING)
    old = td.parse_test_cases(td.read_text(target))
    src = td.parse_test_cases(_read_source(a.source).decode("utf-8-sig"))
    foreign = _foreign_ids(root, a.story_id)
    report = td.validation_report(src, td.validate_doc(src, None, story_id=a.story_id, foreign_ids=foreign))
    if not report["ok"]:
        td.emit({"ok": False, "error": {"code": "VALIDATION", "message": "Draft failed validation; nothing was written"},
                 **_summ(report)})
        return td.EXIT_FINDINGS
    current_sha = td.sha256_file(target)
    edited = current_sha != a.expect_sha256
    before, after = _case_digest(old), _case_digest(src)
    diff = {"kept": sorted(i for i in after if i in before and before[i] == after[i]),
            "changed": sorted(i for i in after if i in before and before[i] != after[i]),
            "added": sorted(i for i in after if i not in before),
            "removed": sorted(i for i in before if i not in after)}
    summary = {"storyId": a.story_id, "file": td.testcase_rel_path(a.story_id), "userEditsDetected": edited,
               "currentSha256": current_sha, "casesBefore": len(old.cases), "casesAfter": len(src.cases), **diff}
    if not a.yes:
        td.emit({"ok": True, "dryRun": True,
                 "note": "Nothing was written. Show this to the user; repeat with --yes only after they agree.", **summary})
        return td.EXIT_OK
    if edited and not a.accept_user_edits:
        td.emit({"ok": False, "error": {"code": "USER_EDITS", "message": f"{target.name} was edited since it was last recorded; "
                 "regenerating would replace those edits (a backup is kept). Tell the user, and repeat with --accept-user-edits only "
                 "if they agree. Nothing was written."}, **summary})
        return td.EXIT_CONFLICT
    data = (src.newline.join(src.lines) + src.newline).encode("utf-8")
    res = td.safe_write(root, target, data, expect_sha=current_sha, backup=True)
    td.emit({"ok": True, **res, **summary, "dryRun": False})
    return td.EXIT_OK


def cmd_split_legacy(a) -> int:
    """Split the old consolidated test-cases.md into per-story files (dry run unless --yes)."""
    root = Path(a.root)
    legacy = td.confine(root, f"{td.OUTPUT_DIRNAME}/{td.TESTCASE_DIRNAME}/{td.LEGACY_TESTCASE_FILE}")
    if not legacy.is_file():
        raise td.SafeOpError("MISSING", f"There is no {td.LEGACY_TESTCASE_FILE} to split.", td.EXIT_MISSING)
    doc = td.parse_test_cases(td.read_text(legacy))
    problems: list[str] = []
    if not doc.modules:
        problems.append("the file has no '# Module' sections")
    elif any(l.strip() for l in doc.lines[:doc.modules[0].line_idx]):
        problems.append("there is text before the first '# Module' heading")
    by_story: dict[str, list[td.ModuleSpan]] = {}
    for m in doc.modules:
        if not m.story_id:
            problems.append(f"module '{m.name}' (line {m.line_idx + 1}) has no valid 'User Story ID:', so its cases cannot be attributed")
        else:
            by_story.setdefault(m.story_id, []).append(m)
    for sid in by_story:
        try:
            rel = td.testcase_rel_path(sid)
        except td.SafeOpError as e:
            problems.append(str(e))
            continue
        if td.confine(root, rel).exists():
            problems.append(f"{rel} already exists; it would not be overwritten")
    if problems:
        td.emit({"ok": False, "error": {"code": "CANNOT_SPLIT", "message": "The legacy file was not split and nothing was written. "
                 "Resolve these first (add the missing 'User Story ID:' lines by hand, or move the existing files)."},
                 "problems": problems})
        return td.EXIT_CONFLICT
    plan, outputs = [], {}
    for sid, spans in by_story.items():
        chunk: list[str] = []
        for m in spans:
            part = doc.lines[m.line_idx:m.end_idx]
            while part and not part[-1].strip():
                part.pop()
            chunk += ([""] if chunk else []) + part
        text = doc.newline.join(chunk) + doc.newline
        plan.append({"storyId": sid, "file": td.testcase_rel_path(sid), "caseIds": [c.id for c in td.parse_test_cases(text).cases]})
        outputs[sid] = text
    n_split = sum(len(p["caseIds"]) for p in plan)
    if n_split != len(doc.cases):
        raise td.SafeOpError("SPLIT_MISMATCH", f"Splitting would keep {n_split} of {len(doc.cases)} cases; nothing was written.", td.EXIT_IO)
    if not a.yes:
        td.emit({"ok": True, "dryRun": True, "note": "Nothing was written. Show this to the user; repeat with --yes only after they agree. "
                 "The old file is moved to state/backups/, not deleted.", "legacyCases": len(doc.cases), "files": plan})
        return td.EXIT_OK
    written, traceability_patch, workflow_patch = [], {}, {}
    for p in plan:
        sid = p["storyId"]
        res = td.safe_write(root, td.testcase_rel_path(sid), outputs[sid].encode("utf-8"), backup=False)
        written.append({"storyId": sid, "file": p["file"], "sha256": res["sha256"], "caseCount": len(p["caseIds"])})
        traceability_patch[sid] = {"testCaseFile": p["file"]}
        workflow_patch[sid] = {"testCaseFile": {"path": p["file"], "sha256": res["sha256"], "caseCount": len(p["caseIds"]),
                                                "updatedAt": td.utc_now()}}
    bdir = td.output_dir(root) / "state" / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    stamp = td._dt.datetime.now(td._dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    kept = bdir / f"{td.LEGACY_TESTCASE_FILE}.{stamp}.migrated.bak"
    td.shutil.copy2(legacy, kept)
    if td.sha256_file(kept) != td.sha256_file(legacy):
        raise td.SafeOpError("READBACK_FAILED", "The backup of the legacy file does not match; it was left in place.", td.EXIT_IO)
    legacy.unlink()
    td.emit({"ok": True, "dryRun": False, "files": written, "legacyBackup": str(kept),
             "traceabilityPatch": {"stories": traceability_patch}, "workflowPatch": {"stories": workflow_patch}})
    return td.EXIT_OK


def cmd_merge_json(a) -> int:
    root = Path(a.root)
    target = td.confine(root, a.target)
    try:
        patch = json.loads(td.read_text(Path(a.patch_file)))
    except (OSError, ValueError):
        raise td.SafeOpError("PATCH_UNREADABLE", f"Cannot read a JSON patch from {a.patch_file}", td.EXIT_USAGE)
    sha = None
    if target.is_file():
        try:
            current = json.loads(td.read_text(target))
        except ValueError:
            raise td.SafeOpError("STATE_CORRUPT", f"{target.name} is not valid JSON. It was not changed; "
                                 "explain this to the user and ask how to proceed.", td.EXIT_MISSING)
        sha = td.sha256_file(target)
    elif a.create:
        current = {}
    else:
        raise td.SafeOpError("MISSING", f"{target.name} does not exist (use --create to start it)", td.EXIT_MISSING)
    merged = td.merge_patch(current, patch)
    if a.touch and isinstance(merged, dict):
        merged[a.touch] = td.utc_now()
    if a.schema:
        errs = td.validate_json(merged, td.load_schema(a.schema))
        if errs:
            td.emit({"ok": False, "error": {"code": "SCHEMA", "message": "Result does not match the schema; nothing was written"},
                     "errors": errs})
            return td.EXIT_FINDINGS
    data = (json.dumps(merged, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    res = td.safe_write(root, target, data, expect_sha=sha, allow_overwrite=sha is None, backup=a.backup)
    td.emit({"ok": True, **res})
    return td.EXIT_OK


def cmd_append_jsonl(a) -> int:
    root = Path(a.root)
    target = td.confine(root, a.target)
    raw = a.entry if a.entry else td.read_text(Path(a.entry_file)) if a.entry_file else None
    if raw is None:
        raise td.SafeOpError("USAGE", "Give --entry JSON or --entry-file F", td.EXIT_USAGE)
    try:
        entry = json.loads(raw)
    except ValueError:
        raise td.SafeOpError("INVALID_JSON", "The audit entry is not valid JSON", td.EXIT_USAGE)
    if not isinstance(entry, dict):
        raise td.SafeOpError("INVALID_JSON", "The audit entry must be a JSON object", td.EXIT_USAGE)
    entry.setdefault("ts", td.utc_now())
    line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    if td.contains_secret(line):
        raise td.SafeOpError("SECRET_DETECTED", "The audit entry looks like it contains a secret; use env: names only. Nothing was written.",
                             td.EXIT_FINDINGS)
    target.parent.mkdir(parents=True, exist_ok=True)
    prefix = ""
    if target.is_file() and target.stat().st_size:
        with open(target, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            prefix = "" if fh.read(1) == b"\n" else "\n"
    try:
        with open(target, "ab") as fh:
            fh.write((prefix + line + "\n").encode("utf-8"))
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as e:
        raise td.SafeOpError("IO_ERROR", f"Could not append to {target.name}: {type(e).__name__}", td.EXIT_IO)
    last = td.read_text(target).rstrip("\n").splitlines()[-1]
    if last != line:
        raise td.SafeOpError("READBACK_FAILED", "Read-back of the appended audit line failed", td.EXIT_IO)
    td.emit({"ok": True, "path": str(target), "entry": entry})
    return td.EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("check-access")
    p.add_argument("--root", required=True)
    p.add_argument("--source", action="append", default=[])
    p.set_defaults(fn=cmd_check_access)

    p = sub.add_parser("hash")
    p.add_argument("files", nargs="+")
    p.set_defaults(fn=cmd_hash)

    p = sub.add_parser("write")
    p.add_argument("--root", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--expect-sha256")
    p.add_argument("--allow-overwrite", action="store_true")
    p.add_argument("--schema")
    p.add_argument("--validate-cases", action="store_true")
    p.add_argument("--require-story-id", action="store_true", help="with --validate-cases: also require 'User Story ID:'")
    p.add_argument("--no-backup", action="store_true")
    p.set_defaults(fn=cmd_write)

    p = sub.add_parser("merge-cases")
    p.add_argument("--root", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--expect-sha256")
    p.add_argument("--on-conflict", choices=["fail", "skip"], default="fail")
    p.add_argument("--require-story-id", action="store_true",
                   help="reject a draft whose module sections lack a 'User Story ID:' line")
    p.add_argument("--story-id", help="target must be <S>-testcase.md and the draft may hold only story S (implies --require-story-id)")
    p.add_argument("--adopt-existing", action="store_true",
                   help="with --story-id and no --expect-sha256: append to a file this run never recorded (only after the user agreed)")
    p.set_defaults(fn=cmd_merge_cases)

    p = sub.add_parser("regenerate-story-file")
    p.add_argument("--root", required=True)
    p.add_argument("--story-id", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--expect-sha256", required=True, help="the hash recorded for the file; a different current hash means user edits")
    p.add_argument("--yes", action="store_true", help="write the file (omit for a dry run that only reports the differences)")
    p.add_argument("--accept-user-edits", action="store_true", help="also required when the file was edited since it was recorded")
    p.set_defaults(fn=cmd_regenerate_story_file)

    p = sub.add_parser("split-legacy")
    p.add_argument("--root", required=True)
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_split_legacy)

    p = sub.add_parser("replace-case")
    p.add_argument("--root", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--expect-sha256", required=True)
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_replace_case)

    p = sub.add_parser("merge-json")
    p.add_argument("--root", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--patch-file", required=True)
    p.add_argument("--schema")
    p.add_argument("--create", action="store_true")
    p.add_argument("--touch", help="top-level field to set to the current UTC time (e.g. updatedAt)")
    p.add_argument("--backup", action="store_true")
    p.set_defaults(fn=cmd_merge_json)

    p = sub.add_parser("append-jsonl")
    p.add_argument("--root", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--entry")
    p.add_argument("--entry-file")
    p.set_defaults(fn=cmd_append_jsonl)
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

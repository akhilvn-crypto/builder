#!/usr/bin/env python3
"""Validate test-case Markdown against the canonical contract.

    validate-test-cases.py FILE [--existing FILE] [--external-id ID ...] [--strict] [--require-story-id]
                                [--story-id S [--check-file-name] [--traceability traceability.json]]
    validate-test-cases.py FILE --fix-safe --fix-output PATH
    validate-test-cases.py --dir test-design/test-cases [--strict]

Checks structure, unique IDs, expected results, ``{variable}`` declarations, ``env:`` references,
secret-looking values, dependencies (existing + acyclic), implementation detail in steps and
duplicate scenarios, and the optional module-level ``User Story ID:`` line (format, one per module,
required only with ``--require-story-id``). ``--existing`` supplies already-saved cases: their IDs are valid dependency
targets and are checked for duplicates. Prints a JSON report; exit 1 when there are errors
(or any finding with ``--strict``). ``--fix-safe`` writes a formatting-only normalised copy to
``--fix-output`` and never edits FILE.

One file per story (``<USER_STORY_ID>-testcase.md``):

* ``--story-id S`` asserts FILE holds only story S (every module carries ``User Story ID: S``) and implies
  ``--require-story-id``. ``--check-file-name`` also requires the file to be called ``S-testcase.md``.
  ``--traceability`` supplies the IDs that belong to *other* stories, so an ID is never reused across files
  and a dependency never points into another story's file, without opening any other test-case file.
* ``--dir`` validates every ``*-testcase.md`` in a folder, each against its own story, then the rules that
  only exist across files (an ID used in two files). A legacy consolidated ``test-cases.md`` is validated
  as before and reported with a warning. This is the only mode that reads more than one test-case file.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402


def _load_json(path: Path, label: str) -> dict:
    try:
        return json.loads(td.read_text(path))
    except (OSError, ValueError):
        raise td.fail("STATE_CORRUPT", f"{label} is not valid JSON ({path.name}). Ask the user how to proceed.", td.EXIT_MISSING)


def validate_directory(directory: Path, strict: bool) -> tuple[dict, int]:
    """Validate each per-story file on its own, then the cross-file rules."""
    parsed: list[tuple[Path, str | None, td.Doc, bool]] = []  # (path, story, doc, legacy)
    notes: list[td.Finding] = []
    for p in sorted(directory.glob("*.md")):
        sid = td.story_id_from_filename(p.name)
        legacy = p.name == td.LEGACY_TESTCASE_FILE
        if sid is None and not legacy:
            notes.append(td.Finding("UNRECOGNISED_FILE", "warning",
                                    f"'{p.name}' is not named <USER_STORY_ID>-testcase.md, so it is not a per-story test-case file"))
            continue
        if legacy:
            notes.append(td.Finding("LEGACY_CONSOLIDATED_FILE", "warning",
                                    "test-cases.md is the old consolidated file. Split it into per-story files "
                                    "(safe-file-operations.py split-legacy) so each story can be consumed on its own"))
        parsed.append((p, sid, td.parse_test_cases(td.read_text(p)), legacy))

    lowered: dict[str, str] = {}
    for p, sid, _, _ in parsed:
        if sid and lowered.setdefault(sid.lower(), p.name) != p.name:
            notes.append(td.Finding("STORY_FILE_COLLISION", "error",
                                    f"'{p.name}' and '{lowered[sid.lower()]}' differ only by letter case; "
                                    "they are the same file on many systems"))

    owner: dict[str, str] = {}  # case id -> file name (first seen)
    dup: dict[str, list[str]] = {}
    for p, _, doc, _ in parsed:
        for c in doc.cases:
            if c.id:
                if c.id in owner and owner[c.id] != p.name:
                    dup.setdefault(c.id, [owner[c.id]]).append(p.name)
                owner.setdefault(c.id, p.name)

    files, findings = [], [dict(f.as_dict(), file=None) for f in notes]
    n_cases = 0
    n_err = sum(1 for f in notes if f.severity == "error")
    n_warn = sum(1 for f in notes if f.severity == "warning")
    for p, sid, doc, legacy in parsed:
        # IDs owned by other files, named by their story. An ID that is in both files is reported once,
        # below, as DUPLICATE_ID_ACROSS_FILES, so it is left out here.
        own = {c.id for c in doc.cases if c.id}
        foreign = {cid: (td.story_id_from_filename(f) or f) for cid, f in owner.items() if f != p.name and cid not in own}
        fl = td.validate_doc(doc, None, None, story_id=sid, foreign_ids=foreign) if sid else td.validate_doc(doc)
        rep = td.validation_report(doc, fl, p.name)
        files.append({"file": p.name, "storyId": sid, "legacy": legacy, "cases": rep["summary"]["cases"],
                      "errors": rep["summary"]["errors"], "warnings": rep["summary"]["warnings"], "ok": rep["ok"]})
        findings += [dict(f, file=p.name) for f in rep["findings"]]
        n_cases += rep["summary"]["cases"]
        n_err += rep["summary"]["errors"]
        n_warn += rep["summary"]["warnings"]
    for cid, names in sorted(dup.items()):
        findings.append({"code": "DUPLICATE_ID_ACROSS_FILES", "severity": "error", "caseId": cid, "file": None,
                         "message": f"ID {cid} appears in {', '.join(sorted(set(names)))}; IDs must be unique across files"})
        n_err += 1
    if not parsed:
        findings.append({"code": "NO_TESTCASE_FILES", "severity": "error", "file": None,
                         "message": f"No *{td.TESTCASE_SUFFIX} files found in {directory}"})
        n_err += 1
    report = {"directory": str(directory), "ok": n_err == 0,
              "summary": {"files": len(parsed), "cases": n_cases, "errors": n_err, "warnings": n_warn},
              "files": files, "findings": findings}
    failing = n_err + (n_warn if strict else 0)
    return report, td.EXIT_FINDINGS if failing else td.EXIT_OK


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--dir", help="validate every <USER_STORY_ID>-testcase.md in this folder (and cross-file rules)")
    ap.add_argument("--existing", help="this story's saved test-case file to check IDs, dependencies and duplicates against")
    ap.add_argument("--external-id", action="append", default=[], help="extra valid dependency ID (repeatable)")
    ap.add_argument("--strict", action="store_true", help="treat warnings as failures")
    ap.add_argument("--require-story-id", action="store_true",
                    help="error when a module has no 'User Story ID:' line (for newly generated drafts; "
                         "older files without the field validate without this flag)")
    ap.add_argument("--story-id", help="the file must hold only this story's cases (implies --require-story-id)")
    ap.add_argument("--check-file-name", action="store_true", help="with --story-id: the file must be named <story>-testcase.md")
    ap.add_argument("--traceability", help="with --story-id: traceability.json, for IDs that belong to other stories")
    ap.add_argument("--fix-safe", action="store_true", help="write a formatting-only fixed copy to --fix-output")
    ap.add_argument("--fix-output")
    args = ap.parse_args()

    if args.dir:
        if args.file:
            raise td.fail("USAGE", "Give either FILE or --dir, not both", td.EXIT_USAGE)
        d = Path(args.dir)
        if not d.is_dir():
            raise td.fail("DIR_MISSING", f"{d} is not a directory", td.EXIT_MISSING)
        report, code = validate_directory(d, args.strict)
        td.emit(report)
        return code
    if not args.file:
        raise td.fail("USAGE", "Give FILE or --dir DIR", td.EXIT_USAGE)

    path = Path(args.file)
    if not path.is_file():
        raise td.fail("FILE_MISSING", f"{path} does not exist", td.EXIT_MISSING)
    text = td.read_text(path)

    if args.fix_safe:
        if not args.fix_output:
            raise td.fail("USAGE", "--fix-safe needs --fix-output PATH (the input file is never edited)", td.EXIT_USAGE)
        out = Path(args.fix_output).resolve()
        if out == path.resolve():
            raise td.fail("USAGE", "--fix-output must differ from the input file", td.EXIT_USAGE)
        fixed, fixes = td.fix_safe(text)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(fixed.encode("utf-8"))
        text = fixed
        fix_info = {"fixesApplied": fixes, "fixedFile": str(out)}
    else:
        fix_info = {}

    existing = None
    if args.existing:
        ep = Path(args.existing)
        if ep.is_file():
            existing = td.parse_test_cases(td.read_text(ep))
    foreign = None
    if args.traceability:
        if not args.story_id:
            raise td.fail("USAGE", "--traceability needs --story-id", td.EXIT_USAGE)
        tp = Path(args.traceability)
        foreign = td.foreign_case_ids(_load_json(tp, "traceability.json"), args.story_id) if tp.is_file() else None
    doc = td.parse_test_cases(text)
    findings = td.validate_doc(doc, existing, set(args.external_id), require_story_id=args.require_story_id,
                               story_id=args.story_id, foreign_ids=foreign)
    if args.check_file_name:
        if not args.story_id:
            raise td.fail("USAGE", "--check-file-name needs --story-id", td.EXIT_USAGE)
        want = td.testcase_filename(args.story_id)
        if path.name != want:
            findings.append(td.Finding("FILE_NAME_MISMATCH", "error", f"The file for story {args.story_id} must be named {want}, not {path.name}"))
    report = td.validation_report(doc, findings, str(path))
    report.update(fix_info)
    td.emit(report)
    failing = report["summary"]["errors"] + (report["summary"]["warnings"] if args.strict else 0)
    return td.EXIT_FINDINGS if failing else td.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check story-to-test mappings in traceability.json against the saved test cases.

    validate-traceability.py --test-cases FILE --traceability traceability.json
                             [--story-id S] [--fingerprints source-fingerprints.json]
    validate-traceability.py --test-cases-dir test-design/test-cases --traceability traceability.json
                             [--story-id S] [--fingerprints source-fingerprints.json]

Errors: schema violations, a test case with no mapping or no story, a mapping to a story that is
not tracked, a ``covers`` entry that names an unknown story/criterion, and (per-story files) a case
that is mapped to a story other than the one its file is named for, or a story whose recorded
``testCaseFile`` is not the file that was checked.
Warnings: mappings whose case is no longer in the file, stories (or criteria) with no covering
case, stories missing from the source fingerprints, a recorded test-case file that is missing, a case
whose module-level ``User Story ID`` is not among the stories it is mapped to. Exit 1 on errors.

``--story-id S`` checks one story only: pass that story's own file (``--test-cases``) and nothing else is
read, so one story can be checked without opening the rest of the suite. ``--test-cases-dir`` reads every
``<USER_STORY_ID>-testcase.md`` (and a legacy ``test-cases.md``) and is the suite-wide check.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402


def load_json(path: Path, label: str) -> dict:
    if not path.is_file():
        raise td.fail("FILE_MISSING", f"{label} not found: {path}", td.EXIT_MISSING)
    try:
        return json.loads(td.read_text(path))
    except ValueError:
        raise td.fail("STATE_CORRUPT", f"{label} is not valid JSON ({path.name}). Ask the user how to proceed.", td.EXIT_MISSING)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--test-cases")
    ap.add_argument("--test-cases-dir")
    ap.add_argument("--story-id", help="check only this story (with --test-cases: that story's own file)")
    ap.add_argument("--traceability", required=True)
    ap.add_argument("--fingerprints")
    args = ap.parse_args()

    if bool(args.test_cases) == bool(args.test_cases_dir):
        raise td.fail("USAGE", "Give exactly one of --test-cases FILE or --test-cases-dir DIR", td.EXIT_USAGE)

    # (file name, parsed doc, story the file is named for or None)
    docs: list[tuple[str, td.Doc, str | None]] = []
    scan_dir: Path | None = None
    if args.test_cases:
        tc_path = Path(args.test_cases)
        if not tc_path.is_file():
            raise td.fail("FILE_MISSING", f"Test-case file not found: {tc_path}", td.EXIT_MISSING)
        docs.append((tc_path.name, td.parse_test_cases(td.read_text(tc_path)), td.story_id_from_filename(tc_path.name)))
    else:
        scan_dir = Path(args.test_cases_dir)
        if not scan_dir.is_dir():
            raise td.fail("DIR_MISSING", f"Test-case folder not found: {scan_dir}", td.EXIT_MISSING)
        for p in sorted(scan_dir.glob("*.md")):
            sid = td.story_id_from_filename(p.name)
            if sid or p.name == td.LEGACY_TESTCASE_FILE:
                if args.story_id and sid != args.story_id:
                    continue
                docs.append((p.name, td.parse_test_cases(td.read_text(p)), sid))
    trace = load_json(Path(args.traceability), "traceability.json")

    findings: list[td.Finding] = []

    def err(code, msg, cid=None):
        findings.append(td.Finding(code, "error", msg, None, cid))

    def warn(code, msg, cid=None):
        findings.append(td.Finding(code, "warning", msg, None, cid))

    for e in td.validate_json(trace, td.load_schema("traceability")):
        err("SCHEMA", e)

    all_stories = trace.get("stories", {}) if isinstance(trace.get("stories"), dict) else {}
    all_mapped = trace.get("cases", {}) if isinstance(trace.get("cases"), dict) else {}
    # A per-story file checked on its own is scoped to its story, so the other stories' mappings are not
    # reported as stale just because their files were not opened.
    scope = args.story_id or (docs[0][2] if args.test_cases and docs else None)
    stories = {k: v for k, v in all_stories.items() if not scope or k == scope}
    # when scoped to one story only its own cases are in play; anything else belongs to files not opened here
    mapped = {k: v for k, v in all_mapped.items()
              if not scope or (isinstance(v, dict) and scope in v.get("storyIds", []))}
    file_ids = [c.id for _, d, _ in docs for c in d.cases if c.id]

    for fname, doc, fstory in docs:
        for c in doc.cases:
            if not c.id:
                err("ORPHAN_CASE", f"Test case '{c.title}' ({fname}, line {c.line}) has no ID, so it cannot be mapped to a story")
            elif c.id not in all_mapped:
                err("ORPHAN_CASE", f"{c.id} is in {fname} but has no entry in traceability.json", c.id)
        for c in doc.cases:
            meta = all_mapped.get(c.id) if c.id else None
            sids = meta.get("storyIds", []) if isinstance(meta, dict) else []
            if fstory and sids and fstory not in sids:
                err("FILE_STORY_MISMATCH",
                    f"{c.id} is in {fname} (story {fstory}) but traceability.json maps it to {', '.join(sids)}", c.id)
            elif c.story_id and sids and c.story_id not in sids:
                warn("STORY_ID_MISMATCH",
                     f"{c.id} sits under 'User Story ID: {c.story_id}' but traceability.json maps it to "
                     f"{', '.join(sids)}", c.id)
        if fstory:
            recorded = all_stories.get(fstory, {}).get("testCaseFile") if isinstance(all_stories.get(fstory), dict) else None
            if recorded and Path(recorded).name != fname:
                err("TESTCASE_FILE_MISMATCH", f"Story {fstory} records its test cases in {recorded}, but {fname} was checked")
    for cid in mapped:
        if cid not in file_ids:
            warn("STALE_MAPPING", f"{cid} is mapped in traceability.json but no longer in the test-case file(s) checked", cid)

    if scan_dir is not None:  # a recorded per-story file that is gone
        present = {n for n, _, _ in docs}
        for sid, s in stories.items():
            rec = s.get("testCaseFile") if isinstance(s, dict) else None
            if rec and s.get("status") != "no_testable_behaviour" and Path(rec).name not in present:
                warn("TESTCASE_FILE_MISSING", f"Story {sid} records {rec}, which was not found in {scan_dir.name}")

    covered_by_story: dict[str, set[str]] = {}
    covered_criteria: set[str] = set()
    for cid, meta in mapped.items():
        sids = meta.get("storyIds", []) if isinstance(meta, dict) else []
        if not sids:
            err("NO_STORY", f"{cid} maps to no source story", cid)
        for sid in sids:
            covered_by_story.setdefault(sid, set()).add(cid)
            if sid not in all_stories:
                err("UNKNOWN_STORY", f"{cid} maps to story {sid}, which is not tracked in traceability.json", cid)
        for ref in meta.get("covers", []) if isinstance(meta, dict) else []:
            sid, _, crit = ref.partition("#")
            if sid not in all_stories or crit not in all_stories[sid].get("criteria", []):
                err("BAD_COVERS", f"{cid} covers '{ref}', which is not a known story criterion", cid)
            else:
                covered_criteria.add(ref)

    total_criteria = 0
    for sid, s in stories.items():
        if s.get("status") == "no_testable_behaviour":
            continue
        if sid not in covered_by_story:
            warn("STORY_UNCOVERED", f"Story {sid} has no test case")
        for crit in s.get("criteria", []):
            total_criteria += 1
            if f"{sid}#{crit}" not in covered_criteria and sid in covered_by_story:
                warn("CRITERION_UNCOVERED", f"{sid} criterion {crit} is not covered by any test case")

    if args.fingerprints:
        fp = load_json(Path(args.fingerprints), "source-fingerprints.json")
        known = {sid for f in fp.get("files", {}).values() for sid in f.get("stories", {})}
        for sid in stories:
            if sid not in known:
                warn("SOURCE_STORY_MISSING", f"Story {sid} is tracked but not found in the source fingerprints")

    n_err = sum(f.severity == "error" for f in findings)
    n_warn = len(findings) - n_err
    td.emit({
        "ok": n_err == 0,
        "summary": {"filesChecked": len(docs), "casesInFile": len(file_ids),
                    "casesMapped": sum(1 for i in file_ids if i in all_mapped),
                    "storiesTracked": len(stories), "storiesWithCases": sum(1 for s in stories if s in covered_by_story),
                    "criteria": total_criteria, "criteriaCovered": len(covered_criteria), "errors": n_err, "warnings": n_warn},
        "findings": [f.as_dict() for f in findings],
    })
    return td.EXIT_FINDINGS if n_err else td.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

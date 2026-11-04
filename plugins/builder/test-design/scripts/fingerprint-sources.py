#!/usr/bin/env python3
"""Hash story files (whole file and per story) and detect changes since a previous snapshot.

    fingerprint-sources.py snapshot FILE... [--root DIR] [--output PATH]
    fingerprint-sources.py compare  FILE... --previous source-fingerprints.json [--traceability traceability.json]
                                    [--workflow workflow.json]

``snapshot`` prints the fingerprint JSON, or writes it to ``--output`` (which must be inside
``<root>/test-design/``). ``compare`` reports changed/added/removed files and stories and,
with ``--traceability``, the generated test cases and the per-story test-case files linked to the
affected stories (``affectedTestCaseFiles``).

With ``--workflow`` it also checks each story against the fingerprint recorded when *its own* test-case file
was generated (``stories.<id>.testCaseFile.sourceSha256``) and lists ``staleTestCaseFiles``: exactly the files
to regenerate, each with a reason (``story_changed``, ``story_removed``), plus ``fileMissing`` /
``editedSinceGenerated`` from the file's recorded hash. This baseline is per story, so refreshing the run's
snapshot after regenerating one story never hides that another story is still stale.
Source files are only ever read. Exit codes: 0 no change / snapshot written, 1 changes found, 4 missing input.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402


def snapshot(files: list[Path], root: Path) -> dict:
    out: dict = {"version": 1, "createdAt": td.utc_now(), "root": str(root), "files": {}}
    for f in files:
        data = f.read_bytes()
        text = data.decode("utf-8-sig")
        rel = os.path.relpath(f, root).replace("\\", "/")
        stories = td.split_stories(text, f.stem)
        out["files"][rel] = {
            "sha256": td.sha256_bytes(data), "sizeBytes": len(data),
            "stories": {s.id: {"sha256": s.sha256, "title": s.title, "startLine": s.start, "endLine": s.end}
                        for s in stories},
        }
    return out


def compare(prev: dict, now: dict, trace: dict | None, wf: dict | None = None, root: Path | None = None) -> dict:
    pf, nf = prev.get("files", {}), now["files"]
    files = {"changed": [], "added": [], "removed": [], "unchanged": []}
    for rel in sorted(set(pf) | set(nf)):
        if rel not in pf:
            files["added"].append(rel)
        elif rel not in nf:
            files["removed"].append(rel)
        elif pf[rel]["sha256"] != nf[rel]["sha256"]:
            files["changed"].append(rel)
        else:
            files["unchanged"].append(rel)

    def story_map(snap_files: dict) -> dict:
        m: dict = {}
        for rel, info in snap_files.items():
            for sid, s in info["stories"].items():
                m[sid] = {"sha256": s["sha256"], "file": rel, "title": s["title"]}
        return m

    ps, ns = story_map(pf), story_map(nf)
    stories = {
        "changed": sorted(s for s in ps if s in ns and ps[s]["sha256"] != ns[s]["sha256"]),
        "added": sorted(s for s in ns if s not in ps),
        "removed": sorted(s for s in ps if s not in ns),
    }
    affected: dict[str, list[str]] = {}
    if trace:
        for cid, meta in trace.get("cases", {}).items():
            for sid in meta.get("storyIds", []):
                if sid in stories["changed"] or sid in stories["removed"]:
                    affected.setdefault(sid, []).append(cid)
    affected_files: dict[str, str] = {}
    if trace:
        for sid in sorted(set(stories["changed"]) | set(stories["removed"])):
            rec = (trace.get("stories", {}).get(sid) or {}).get("testCaseFile")
            if rec:
                affected_files[sid] = rec
    stale: list[dict] = []
    if wf:
        for sid, st in sorted((wf.get("stories") or {}).items()):
            tf = st.get("testCaseFile")
            if not tf:
                continue
            row: dict = {"storyId": sid, "file": tf["path"], "reasons": []}
            if sid not in ns:
                row["reasons"].append("story_removed")
            elif tf.get("sourceSha256") and tf["sourceSha256"] != ns[sid]["sha256"]:
                row["reasons"].append("story_changed")
            fp = (root / tf["path"]) if root else None
            row["fileMissing"] = bool(fp is not None and not fp.is_file())
            row["editedSinceGenerated"] = bool(fp is not None and fp.is_file() and tf.get("sha256")
                                               and td.sha256_file(fp) != tf["sha256"])
            if row["reasons"] or row["fileMissing"]:
                stale.append(row)
                affected_files.setdefault(sid, tf["path"])
    changed = any(files[k] for k in ("changed", "added", "removed")) or any(stories.values()) or bool(stale)
    return {"ok": True, "sourcesChanged": changed, "files": files, "stories": stories,
            "affectedTestCases": {k: sorted(v) for k, v in sorted(affected.items())},
            "affectedTestCaseFiles": dict(sorted(affected_files.items())),
            "staleTestCaseFiles": stale}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("files", nargs="+")
    s.add_argument("--root", default=None)
    s.add_argument("--output", default=None)
    c = sub.add_parser("compare")
    c.add_argument("files", nargs="+")
    c.add_argument("--previous", required=True)
    c.add_argument("--root", default=None)
    c.add_argument("--traceability", default=None)
    c.add_argument("--workflow", default=None, help="workflow.json: also report per-story test-case files made from an older story")
    args = ap.parse_args()

    paths = [Path(f).resolve() for f in args.files]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise td.fail("SOURCE_MISSING", "Source file(s) not found: " + ", ".join(missing), td.EXIT_MISSING)
    root = Path(args.root).resolve() if args.root else Path(os.path.commonpath([str(p.parent) for p in paths]))

    if getattr(args, "workflow", None) and not args.root:
        raise td.fail("USAGE", "--workflow needs --root (the project root its test-case paths are relative to)", td.EXIT_USAGE)
    now = snapshot(paths, root)
    if args.cmd == "snapshot":
        if args.output:
            try:
                res = td.safe_write(root, Path(args.output), (json.dumps(now, indent=2) + "\n").encode("utf-8"),
                                    allow_overwrite=True)
            except td.SafeOpError as e:
                raise td.fail(e.code, str(e), e.exit_code)
            td.emit({"ok": True, "written": res["path"], "sha256": res["sha256"], "files": len(now["files"])})
        else:
            td.emit(now)
        return td.EXIT_OK

    prev_path = Path(args.previous)
    if not prev_path.is_file():
        raise td.fail("PREVIOUS_MISSING", f"No previous fingerprint file at {prev_path}", td.EXIT_MISSING)
    try:
        prev = json.loads(td.read_text(prev_path))
        trace = json.loads(td.read_text(Path(args.traceability))) if args.traceability else None
        wf = json.loads(td.read_text(Path(args.workflow))) if args.workflow else None
    except (ValueError, OSError) as e:
        raise td.fail("STATE_CORRUPT", f"Cannot read state JSON: {type(e).__name__}. Ask the user how to proceed.", td.EXIT_MISSING)
    result = compare(prev, now, trace, wf, root)
    td.emit(result)
    return td.EXIT_FINDINGS if result["sourcesChanged"] else td.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

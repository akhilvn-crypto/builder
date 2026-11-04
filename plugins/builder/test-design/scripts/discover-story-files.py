#!/usr/bin/env python3
"""Resolve a user-supplied story location to Markdown story files.

    discover-story-files.py INPUT [--cwd DIR] [--search-root DIR ...] [--root DIR]

INPUT may be a Markdown file, a directory, or a bare file/folder name. Read-only: nothing is
created or modified. Prints JSON; ``status`` is ``found``, ``ambiguous`` or ``not_found``.
Exit codes: 0 found, 3 ambiguous, 4 not found, 2 usage.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".idea", ".vscode"}
MAX_FILES = 500
MAX_BYTES = 5 * 1024 * 1024


def is_generated_output(d: Path) -> bool:
    """A previous run's ``test-design/`` folder must never be read back as stories."""
    return d.name == td.OUTPUT_DIRNAME and ((d / "state").is_dir() or (d / "test-cases").is_dir())


def walk(base: Path, include_hidden: bool) -> tuple[list[Path], dict]:
    md: list[Path] = []
    skipped: list[str] = []
    non_md = 0
    for dirpath, dirnames, filenames in os.walk(base):
        keep = []
        for d in sorted(dirnames):
            full = Path(dirpath) / d
            if d in SKIP_DIRS or (d.startswith(".") and not include_hidden) or is_generated_output(full):
                skipped.append(str(full))
            else:
                keep.append(d)
        dirnames[:] = keep
        for f in sorted(filenames):
            if f.lower().endswith(".md"):
                md.append(Path(dirpath) / f)
            else:
                non_md += 1
    return md, {"nonMarkdownCount": non_md, "skippedDirectories": skipped[:10]}


def describe(path: Path, base: Path) -> dict:
    entry = {"path": str(path), "relPath": os.path.relpath(path, base), "sizeBytes": path.stat().st_size}
    if entry["sizeBytes"] > MAX_BYTES:
        entry.update(readable=False, note="larger than 5 MB; not scanned", stories=[])
        return entry
    try:
        text = td.read_text(path)
    except (OSError, UnicodeDecodeError) as e:
        entry.update(readable=False, note=f"cannot read: {type(e).__name__}", stories=[])
        return entry
    stories = td.split_stories(text, path.stem)
    entry.update(readable=True, storyCount=len(stories),
                 stories=[{"id": s.id, "title": s.title, "line": s.start, "idInferred": s.id_inferred} for s in stories])
    return entry


def resolve(raw: str, cwd: Path, search_roots: list[Path]) -> tuple[str, list[Path]]:
    """Return (how, matches). ``how`` is 'path' when the input named an existing path."""
    cleaned = raw.strip().strip('"').strip("'")
    p = Path(os.path.expanduser(cleaned))
    bases = [None] if p.is_absolute() else [cwd] + search_roots
    for b in bases:
        cand = p if b is None else (b / p)
        if cand.exists():
            return "path", [cand.resolve()]
    if p.is_absolute() or len(p.parts) > 1:
        return "none", []
    # bare name: search by file name, file stem, or folder name
    wanted = {cleaned.lower(), cleaned.lower() + ".md"}
    matches: list[Path] = []
    for base in [cwd] + search_roots:
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in sorted(dirnames)
                           if d not in SKIP_DIRS and not d.startswith(".") and not is_generated_output(Path(dirpath) / d)]
            for d in dirnames:
                if d.lower() == cleaned.lower():
                    matches.append((Path(dirpath) / d).resolve())
            for f in filenames:
                if f.lower() in wanted:
                    matches.append((Path(dirpath) / f).resolve())
            if len(matches) > 20:
                break
    seen, uniq = set(), []
    for m in matches:
        if m not in seen:
            seen.add(m)
            uniq.append(m)
    return "name", uniq


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="Markdown file, directory, or bare name")
    ap.add_argument("--cwd", default=os.getcwd(), help="base for relative paths (default: current directory)")
    ap.add_argument("--search-root", action="append", default=[], help="extra base to resolve/search (repeatable)")
    ap.add_argument("--include-hidden", action="store_true", help="also descend into dot-folders")
    args = ap.parse_args()

    cwd = Path(args.cwd).resolve()
    roots = [Path(r).resolve() for r in args.search_root]
    how, matches = resolve(args.input, cwd, roots)
    result: dict = {"ok": True, "input": args.input, "cwd": str(cwd), "notes": []}

    if not matches:
        result.update(status="not_found", candidates=[],
                      notes=[f"Nothing matched '{args.input}' under {cwd}" + (f" or {len(roots)} extra root(s)" if roots else "")])
        td.emit(result)
        return td.EXIT_MISSING
    if len(matches) > 1:
        result.update(status="ambiguous", kind="name", matches=[str(m) for m in matches[:20]], candidates=[],
                      notes=["The name matches more than one file or folder; ask the user which one."])
        td.emit(result)
        return td.EXIT_CONFLICT

    target = matches[0]
    excluded = {"nonMarkdownCount": 0, "skippedDirectories": [], "nonMarkdownSample": []}
    if target.is_file():
        kind, base = "file", target.parent
        if target.suffix.lower() != ".md":
            result.update(status="not_found", kind=kind, resolved=str(target), candidates=[], excluded=excluded,
                          notes=[f"{target.name} is not a Markdown (.md) file; only .md stories are supported."])
            td.emit(result)
            return td.EXIT_MISSING
        files = [target]
    else:
        kind, base = "directory", target
        files, ex = walk(target, args.include_hidden)
        excluded.update(ex)
        if how == "name":
            result["notes"].append("Resolved a bare name to this folder.")
    truncated = len(files) > MAX_FILES
    files = files[:MAX_FILES]

    candidates = [describe(f, base) for f in files]
    ids: dict[str, list[str]] = {}
    for c in candidates:
        for s in c.get("stories", []):
            ids.setdefault(s["id"], []).append(c["relPath"])
    duplicates = {k: v for k, v in ids.items() if len(v) > 1}
    out_dir = td.output_dir(base)
    result.update(
        status="found", kind=kind, resolved=str(target), candidates=candidates, truncated=truncated,
        excluded=excluded, duplicateStoryIds=duplicates,
        inferredStoryIds=[c["relPath"] for c in candidates if any(s["idInferred"] for s in c.get("stories", []))],
        projectRootSuggestion=str(base), outputDir=str(out_dir),
        existingOutput={"exists": out_dir.exists(),
                        "testCases": (out_dir / "test-cases" / td.LEGACY_TESTCASE_FILE).is_file()
                        or any((out_dir / td.TESTCASE_DIRNAME).glob(f"*{td.TESTCASE_SUFFIX}")),
                        "testCaseFiles": len(list((out_dir / td.TESTCASE_DIRNAME).glob(f"*{td.TESTCASE_SUFFIX}"))),
                        "legacyConsolidatedFile": (out_dir / td.TESTCASE_DIRNAME / td.LEGACY_TESTCASE_FILE).is_file(),
                        "state": (out_dir / "state" / "workflow.json").is_file()},
        access={"rootReadable": os.access(base, os.R_OK), "rootWritable": os.access(base, os.W_OK)},
    )
    if not candidates:
        result["notes"].append("No Markdown files were found.")
        result["status"] = "not_found"
        td.emit(result)
        return td.EXIT_MISSING
    if len(candidates) > 1:
        result["notes"].append("Several Markdown files found; ask the user which to process.")
    td.emit(result)
    return td.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

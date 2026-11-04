#!/usr/bin/env python3
"""Derive deterministic ``AUTO-xxxxxxxx`` IDs for test cases that have no supplied ID.

    generate-stable-id.py --story US-001 --title "Valid user can sign in"
    generate-stable-id.py --batch cases.json [--traceability traceability.json] [--regenerate-story S]

The scenario key is the sorted source story IDs plus the normalised title (case, spacing and
punctuation are ignored), so the same scenario always gets the same ID. Once written into a
test-case heading the ID is never recomputed, so renaming a case later does not change it.
``--batch`` reads ``[{"storyIds": ["US-001"], "title": "..."}]`` and prints one result per entry.
With ``--traceability``, an ID already used by the same scenario is reported as ``exists`` and an
ID already used by a different scenario is re-derived with a deterministic salt.
``--regenerate-story S`` is for rebuilding story S's test-case file: the IDs S already owns are not treated as
taken, so an unchanged scenario gets its old ID back (``exists`` is false and the ID is reused); IDs of other
stories stay taken.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import td_common as td  # noqa: E402


def scenario_key(story_ids: list[str], title: str) -> str:
    stories = sorted({s.strip().upper() for s in story_ids if s.strip()})
    return "|".join(stories) + "|" + td.normalize_title(title)


def derive(key: str, taken: dict[str, str]) -> dict:
    """taken maps id -> scenarioKey of IDs already in use."""
    salt = 0
    while True:
        digest = td.sha256_text(key if salt == 0 else f"{key}#{salt}")[:8]
        cid = f"AUTO-{digest}"
        owner = taken.get(cid)
        if owner is None:
            return {"id": cid, "scenarioKey": key, "exists": False, "collisionResolved": salt > 0}
        if owner == key:
            return {"id": cid, "scenarioKey": key, "exists": True, "collisionResolved": salt > 0}
        salt += 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--story", action="append", default=[], help="source story ID (repeatable)")
    ap.add_argument("--title")
    ap.add_argument("--batch", help="JSON file with a list of {storyIds, title}")
    ap.add_argument("--traceability", help="traceability.json whose case IDs must not be reused")
    ap.add_argument("--regenerate-story", metavar="S",
                    help="with --traceability: IDs mapped to story S may be reused (its file is being regenerated)")
    args = ap.parse_args()

    taken: dict[str, str] = {}
    if args.traceability:
        p = Path(args.traceability)
        if p.is_file():
            try:
                data = json.loads(td.read_text(p))
            except ValueError:
                raise td.fail("STATE_CORRUPT", "traceability.json is not valid JSON", td.EXIT_MISSING)
            taken = {cid: m.get("scenarioKey", "") for cid, m in data.get("cases", {}).items()
                     if not (args.regenerate_story and args.regenerate_story in m.get("storyIds", []))}

    if args.batch:
        try:
            items = json.loads(td.read_text(Path(args.batch)))
        except (OSError, ValueError):
            raise td.fail("BATCH_UNREADABLE", f"Cannot read batch file {args.batch}", td.EXIT_MISSING)
        results = []
        for it in items:
            if not it.get("title") or not it.get("storyIds"):
                raise td.fail("BATCH_INVALID", "Every entry needs 'title' and a non-empty 'storyIds'", td.EXIT_USAGE)
            r = derive(scenario_key(it["storyIds"], it["title"]), taken)
            taken.setdefault(r["id"], r["scenarioKey"])  # later entries must not reuse this ID
            results.append(r)
        td.emit({"ok": True, "results": results})
        return td.EXIT_OK

    if not args.story or not args.title:
        raise td.fail("USAGE", "Give --story (at least once) and --title, or --batch FILE", td.EXIT_USAGE)
    td.emit({"ok": True, **derive(scenario_key(args.story, args.title), taken)})
    return td.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

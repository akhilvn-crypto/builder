import json
import unittest

from helpers import FIXTURES, TempProject, run, td


class SplitStories(unittest.TestCase):
    def test_ba_style_headings_split_into_stories(self):
        text = (FIXTURES / "stories" / "auth" / "login.md").read_text(encoding="utf-8")
        stories = td.split_stories(text, "login")
        self.assertEqual([s.id for s in stories], ["US-001", "US-002"])
        self.assertEqual(stories[0].title, "Registered user login")
        self.assertFalse(any(s.id_inferred for s in stories))
        self.assertLess(stories[0].end, stories[1].start)

    def test_story_ends_at_next_story_not_at_its_own_subheadings(self):
        text = "## US-001 — A\n### Notes\nbody\n## US-002 — B\nmore\n"
        s = td.split_stories(text)
        self.assertEqual((s[0].start, s[0].end), (1, 3))
        self.assertEqual(s[1].start, 4)

    def test_file_without_story_ids_is_one_inferred_story(self):
        stories = td.split_stories("# Basket\nUsers add items.\n", "no-ids")
        self.assertEqual(len(stories), 1)
        self.assertTrue(stories[0].id_inferred)
        self.assertEqual(stories[0].id, "NO-IDS")

    def test_headings_inside_code_fences_are_ignored(self):
        text = "## US-001 — Real\n```\n## US-002 — Fake\n```\n"
        self.assertEqual([s.id for s in td.split_stories(text)], ["US-001"])

    def test_hash_ignores_line_endings_and_trailing_space(self):
        a = td.split_stories("## US-001 — A\nbody\n")[0].sha256
        b = td.split_stories("## US-001 — A  \r\nbody\r\n")[0].sha256
        self.assertEqual(a, b)


class DiscoverCli(TempProject):
    def test_directory_is_searched_recursively_and_junk_excluded(self):
        code, out = run("discover-story-files.py", self.root / "stories")
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "found")
        rel = sorted(c["relPath"].replace("\\", "/") for c in out["candidates"])
        self.assertEqual(rel, ["auth/login.md", "no-ids.md", "profile.md"])
        self.assertEqual(out["excluded"]["nonMarkdownCount"], 1)  # notes.txt
        self.assertTrue(any("node_modules" in d for d in out["excluded"]["skippedDirectories"]))
        self.assertEqual(out["projectRootSuggestion"], str(self.root / "stories"))
        self.assertEqual(out["inferredStoryIds"], ["no-ids.md"])

    def test_file_input_uses_parent_as_root(self):
        code, out = run("discover-story-files.py", self.root / "stories" / "profile.md")
        self.assertEqual(out["kind"], "file")
        self.assertEqual(out["projectRootSuggestion"], str(self.root / "stories"))
        self.assertEqual(len(out["candidates"]), 1)

    def test_non_markdown_file_is_rejected(self):
        code, out = run("discover-story-files.py", self.root / "stories" / "notes.txt")
        self.assertEqual((code, out["status"]), (4, "not_found"))

    def test_relative_path_resolves_against_cwd(self):
        code, out = run("discover-story-files.py", "stories", cwd=self.root)
        self.assertEqual(out["status"], "found")

    def test_bare_name_finds_file_by_stem(self):
        code, out = run("discover-story-files.py", "login", "--cwd", self.root)
        self.assertEqual(out["status"], "found")
        self.assertTrue(out["resolved"].endswith("login.md"))

    def test_ambiguous_bare_name_asks_user(self):
        self.write("stories/other/login.md", "## US-050 — Other login\n")
        code, out = run("discover-story-files.py", "login", "--cwd", self.root)
        self.assertEqual((code, out["status"]), (3, "ambiguous"))
        self.assertEqual(len(out["matches"]), 2)

    def test_unknown_name_is_not_found(self):
        code, out = run("discover-story-files.py", "nothing-here", "--cwd", self.root)
        self.assertEqual((code, out["status"]), (4, "not_found"))

    def test_previous_output_folder_is_never_read_back_as_stories(self):
        self.write("stories/test-design/state/workflow.json", "{}")
        self.write("stories/test-design/test-cases/test-cases.md", "# X\n## TC-1: t\n")
        code, out = run("discover-story-files.py", self.root / "stories")
        paths = [c["relPath"] for c in out["candidates"]]
        self.assertFalse(any("test-cases.md" in p for p in paths))
        self.assertTrue(out["existingOutput"]["exists"])

    def test_duplicate_story_ids_are_reported(self):
        self.write("stories/copy.md", "## US-010 — Copy of the profile story\n")
        code, out = run("discover-story-files.py", self.root / "stories")
        self.assertIn("US-010", out["duplicateStoryIds"])

    def test_discovery_does_not_modify_sources_or_create_output(self):
        before = {p: p.read_bytes() for p in (self.root / "stories").rglob("*") if p.is_file()}
        run("discover-story-files.py", self.root / "stories")
        after = {p: p.read_bytes() for p in (self.root / "stories").rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse((self.root / "stories" / "test-design").exists())


class FingerprintCli(TempProject):
    def snapshot(self, *names):
        files = [self.root / "stories" / n for n in names]
        code, out = run("fingerprint-sources.py", "snapshot", *files, "--root", self.root,
                        "--output", "test-design/state/source-fingerprints.json")
        self.assertEqual(code, 0, out)
        return self.root / "test-design" / "state" / "source-fingerprints.json", files

    def test_unchanged_sources_report_no_change(self):
        fp, files = self.snapshot("auth/login.md", "profile.md")
        code, out = run("fingerprint-sources.py", "compare", *files, "--previous", fp, "--root", self.root)
        self.assertEqual((code, out["sourcesChanged"]), (0, False))

    def test_one_changed_story_is_identified_with_its_test_cases(self):
        fp, files = self.snapshot("auth/login.md", "profile.md")
        trace = self.write("trace.json", json.dumps({"version": 1, "stories": {}, "cases": {
            "AUTO-aaaaaaaa": {"title": "t", "storyIds": ["US-001"]},
            "AUTO-bbbbbbbb": {"title": "t", "storyIds": ["US-002"]}}}))
        login = files[0]
        login.write_text(login.read_text(encoding="utf-8").replace("15 minutes", "30 minutes", 1), encoding="utf-8")
        code, out = run("fingerprint-sources.py", "compare", *files, "--previous", fp, "--root", self.root,
                        "--traceability", trace)
        self.assertEqual(code, 1)
        self.assertEqual(out["stories"]["changed"], ["US-001"])
        self.assertEqual(out["files"]["changed"], ["stories/auth/login.md"])
        self.assertEqual(out["affectedTestCases"], {"US-001": ["AUTO-aaaaaaaa"]})

    def test_added_story_and_removed_file(self):
        fp, files = self.snapshot("auth/login.md", "profile.md")
        with files[1].open("a", encoding="utf-8") as fh:
            fh.write("\n## US-011 — New story\nbody\n")
        code, out = run("fingerprint-sources.py", "compare", files[1], "--previous", fp, "--root", self.root)
        self.assertEqual(out["stories"]["added"], ["US-011"])
        self.assertEqual(out["files"]["removed"], ["stories/auth/login.md"])

    def test_corrupt_previous_snapshot_is_reported_not_assumed(self):
        bad = self.write("test-design/state/source-fingerprints.json", "{not json")
        code, out = run("fingerprint-sources.py", "compare", self.root / "stories" / "profile.md",
                        "--previous", bad, "--root", self.root)
        self.assertEqual((code, out["error"]["code"]), (4, "STATE_CORRUPT"))

    def test_snapshot_output_outside_output_dir_is_refused(self):
        code, out = run("fingerprint-sources.py", "snapshot", self.root / "stories" / "profile.md",
                        "--root", self.root, "--output", "stories/profile.md")
        self.assertEqual((code, out["error"]["code"]), (5, "OUTSIDE_OUTPUT_DIR"))
        self.assertIn("US-010", (self.root / "stories" / "profile.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

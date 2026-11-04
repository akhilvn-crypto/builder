"""One test-case file per user story: <USER_STORY_ID>-testcase.md.

Covers naming, story scoping, cross-file ID rules, saving, consented regeneration of a single file,
traceability, source-change detection, migration of the old consolidated file and the guarantee that
processing one story never opens another story's file.
"""
import json
import unittest
from pathlib import Path

from helpers import TempProject, case, run, td

SAFE = "safe-file-operations.py"
VALIDATE = "validate-test-cases.py"
TRACE = "validate-traceability.py"
FINGERPRINT = "fingerprint-sources.py"
RELDIR = "test-design/test-cases"


def draft(sid, *blocks, module="Login"):
    return f"# {module}\nUser Story ID: {sid}\n\n" + "\n".join(blocks)


class Naming(unittest.TestCase):
    def test_file_name_round_trip(self):
        self.assertEqual(td.testcase_filename("US-001"), "US-001-testcase.md")
        self.assertEqual(td.testcase_rel_path("PROJ-12"), "test-design/test-cases/PROJ-12-testcase.md")
        self.assertEqual(td.story_id_from_filename("US-001-testcase.md"), "US-001")

    def test_other_names_are_not_story_files(self):
        for name in ("test-cases.md", "US-001.md", "US-001-testcase.txt", "-testcase.md", "notes-testcase.md.bak"):
            self.assertIsNone(td.story_id_from_filename(name), name)

    def test_unsafe_story_ids_are_refused(self):
        for bad in ("", "../x", "a/b", "a\\b", "US..1", "US 1", "US-1:x"):
            with self.assertRaises(td.SafeOpError, msg=bad):
                td.testcase_filename(bad)


class StoryScopedValidation(TempProject):
    def v(self, text, *extra, name="d.md"):
        return run(VALIDATE, self.write(name, text), *extra)

    def test_file_holding_only_its_story_is_valid(self):
        code, out = self.v(draft("US-001", case("TC-1", "A")), "--story-id", "US-001")
        self.assertEqual((code, out["ok"]), (0, True), out)

    def test_other_story_in_the_file_is_an_error(self):
        text = draft("US-001", case("TC-1", "A")) + "\n" + draft("US-002", case("TC-2", "B", step="Open b"))
        code, out = self.v(text, "--story-id", "US-001")
        self.assertEqual(code, 1)
        self.assertIn("FILE_STORY_MISMATCH", {f["code"] for f in out["findings"]})

    def test_missing_story_line_is_an_error_in_story_mode(self):
        code, out = self.v("# Login\n\n" + case("TC-1", "A"), "--story-id", "US-001")
        self.assertIn("STORY_ID_MISSING", {f["code"] for f in out["findings"]})

    def test_check_file_name(self):
        text = draft("US-001", case("TC-1", "A"))
        code, out = self.v(text, "--story-id", "US-001", "--check-file-name")
        self.assertIn("FILE_NAME_MISMATCH", {f["code"] for f in out["findings"]})
        good = self.write("test-design/test-cases/US-001-testcase.md", text)
        self.assertEqual(run(VALIDATE, good, "--story-id", "US-001", "--check-file-name")[0], 0)

    def trace(self, mapping):
        p = self.write("t.json", json.dumps({"version": 1, "stories": {}, "cases": {
            cid: {"title": "x", "storyIds": [sid]} for cid, sid in mapping.items()}}))
        return p

    def test_id_used_by_another_story_is_rejected_using_only_the_index(self):
        t = self.trace({"TC-1": "US-002"})
        code, out = self.v(draft("US-001", case("TC-1", "A")), "--story-id", "US-001", "--traceability", t)
        self.assertEqual(code, 1)
        self.assertIn("DUPLICATE_ID", {f["code"] for f in out["findings"]})

    def test_own_ids_in_the_index_are_fine(self):
        t = self.trace({"TC-1": "US-001"})
        self.assertEqual(self.v(draft("US-001", case("TC-1", "A")), "--story-id", "US-001", "--traceability", t)[0], 0)

    def test_dependency_into_another_storys_file_is_rejected(self):
        t = self.trace({"TC-9": "US-002"})
        code, out = self.v(draft("US-001", case("TC-1", "A", extra="Depends on: TC-9")),
                           "--story-id", "US-001", "--traceability", t)
        self.assertIn("DEPENDENCY_CROSS_FILE", {f["code"] for f in out["findings"]})

    def test_dependency_inside_the_file_is_fine(self):
        text = draft("US-001", case("TC-1", "A"), case("TC-2", "B", step="Open b", extra="Depends on: TC-1"))
        self.assertEqual(self.v(text, "--story-id", "US-001")[0], 0)

    def test_traceability_without_story_id_is_a_usage_error(self):
        code, out = self.v(draft("US-001", case("TC-1", "A")), "--traceability", self.trace({}))
        self.assertEqual(code, 2)


class DirectoryValidation(TempProject):
    def put(self, sid, text, name=None):
        return self.write(f"{RELDIR}/{name or td.testcase_filename(sid)}", text)

    def vdir(self, *extra):
        return run(VALIDATE, "--dir", self.root / RELDIR, *extra)

    def test_clean_folder(self):
        self.put("US-001", draft("US-001", case("TC-1", "A")))
        self.put("US-002", draft("US-002", case("TC-2", "B", step="Open b"), module="Billing"))
        code, out = self.vdir()
        self.assertEqual((code, out["ok"]), (0, True), out)
        self.assertEqual(out["summary"]["files"], 2)
        self.assertEqual(out["summary"]["cases"], 2)
        self.assertEqual([f["storyId"] for f in out["files"]], ["US-001", "US-002"])

    def test_same_id_in_two_files_is_an_error(self):
        self.put("US-001", draft("US-001", case("TC-1", "A")))
        self.put("US-002", draft("US-002", case("TC-1", "B", step="Open b")))
        code, out = self.vdir()
        self.assertEqual(code, 1)
        self.assertIn("DUPLICATE_ID_ACROSS_FILES", {f["code"] for f in out["findings"]})

    def test_file_with_another_storys_cases_is_an_error(self):
        self.put("US-001", draft("US-002", case("TC-1", "A")))
        code, out = self.vdir()
        self.assertEqual(code, 1)
        hit = [f for f in out["findings"] if f["code"] == "FILE_STORY_MISMATCH"]
        self.assertEqual(hit[0]["file"], "US-001-testcase.md")

    def test_findings_name_their_file(self):
        self.put("US-001", draft("US-001", case("TC-1", "A")))
        self.put("US-002", draft("US-002", "## TC-2: T\n\n### Steps\n1. Click #go\n"))
        code, out = self.vdir()
        self.assertEqual(code, 1)
        bad = [f for f in out["findings"] if f["severity"] == "error"]
        self.assertTrue(bad and all(f["file"] == "US-002-testcase.md" for f in bad))
        self.assertEqual([f["ok"] for f in out["files"]], [True, False])

    def test_dependency_across_files_is_unusable_on_its_own(self):
        self.put("US-001", draft("US-001", case("TC-1", "A")))
        self.put("US-002", draft("US-002", case("TC-2", "B", step="Open b", extra="Depends on: TC-1")))
        code, out = self.vdir()
        self.assertIn("DEPENDENCY_CROSS_FILE", {f["code"] for f in out["findings"]})

    def test_legacy_file_is_validated_and_flagged(self):
        self.put("x", draft("US-001", case("TC-1", "A")), name="test-cases.md")
        code, out = self.vdir()
        self.assertEqual(code, 0)
        self.assertIn("LEGACY_CONSOLIDATED_FILE", {f["code"] for f in out["findings"]})

    def test_unrecognised_file_is_a_warning_only(self):
        self.put("US-001", draft("US-001", case("TC-1", "A")))
        self.put("x", "# notes\n", name="scratch.md")
        code, out = self.vdir()
        self.assertEqual(code, 0)
        self.assertIn("UNRECOGNISED_FILE", {f["code"] for f in out["findings"]})

    def test_empty_folder_is_an_error(self):
        (self.root / RELDIR).mkdir(parents=True)
        self.assertEqual(self.vdir()[0], 1)

    def test_file_and_dir_together_is_a_usage_error(self):
        (self.root / RELDIR).mkdir(parents=True)
        self.assertEqual(run(VALIDATE, "x.md", "--dir", self.root / RELDIR)[0], 2)


class Saving(TempProject):
    def merge(self, sid, text, *extra, target=None, name=None):
        d = self.write(name or f"d-{sid}.md", text)
        return run(SAFE, "merge-cases", "--root", self.root, "--target", target or td.testcase_rel_path(sid),
                   "--source", d, "--story-id", sid, *extra)

    def test_first_save_creates_only_that_storys_file(self):
        code, out = self.merge("US-001", draft("US-001", case("TC-1", "A")))
        self.assertEqual((code, out["ok"], out["added"]), (0, True, ["TC-1"]), out)
        self.assertTrue(self.story_path("US-001").is_file())
        self.assertEqual([p.name for p in (self.root / RELDIR).iterdir()], ["US-001-testcase.md"])

    def test_two_stories_make_two_files_each_with_only_its_cases(self):
        self.merge("US-001", draft("US-001", case("TC-1", "A")))
        self.merge("US-002", draft("US-002", case("TC-2", "B", step="Open b")))
        d1 = td.parse_test_cases(self.story_path("US-001").read_text(encoding="utf-8"))
        d2 = td.parse_test_cases(self.story_path("US-002").read_text(encoding="utf-8"))
        self.assertEqual([(c.id, c.story_id) for c in d1.cases], [("TC-1", "US-001")])
        self.assertEqual([(c.id, c.story_id) for c in d2.cases], [("TC-2", "US-002")])

    def test_format_is_the_existing_contract(self):
        self.merge("US-001", draft("US-001", case("TC-1", "A")))
        text = self.story_path("US-001").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# Login\nUser Story ID: US-001\n\n## TC-1: A\n"))

    def test_wrong_target_is_refused(self):
        for target in ("test-design/test-cases/test-cases.md", "test-design/test-cases/US-002-testcase.md",
                       "test-design/other/US-001-testcase.md"):
            code, out = self.merge("US-001", draft("US-001", case("TC-1", "A")), target=target)
            self.assertEqual((code, out["error"]["code"]), (2, "WRONG_TARGET"), target)
        self.assertFalse((self.root / RELDIR).exists())

    def test_draft_for_another_story_is_refused(self):
        code, out = self.merge("US-001", draft("US-002", case("TC-1", "A")))
        self.assertEqual((code, out["error"]["code"]), (1, "VALIDATION"))
        self.assertIn("FILE_STORY_MISMATCH", {f["code"] for f in out["findings"]})
        self.assertFalse(self.story_path("US-001").exists())

    def test_draft_without_story_line_is_refused(self):
        code, out = self.merge("US-001", "# Login\n\n" + case("TC-1", "A"))
        self.assertEqual(code, 1)

    def test_existing_untracked_file_is_not_appended_to_silently(self):
        self.write(f"{RELDIR}/US-001-testcase.md", draft("US-001", case("TC-9", "Mine")))
        before = self.story_path("US-001").read_bytes()
        code, out = self.merge("US-001", draft("US-001", case("TC-1", "A")))
        self.assertEqual((code, out["error"]["code"]), (3, "EXISTS_UNTRACKED"))
        self.assertEqual(self.story_path("US-001").read_bytes(), before)

    def test_adopting_an_existing_file_appends_and_keeps_it(self):
        self.write(f"{RELDIR}/US-001-testcase.md", draft("US-001", case("TC-9", "Mine")))
        code, out = self.merge("US-001", draft("US-001", case("TC-1", "A", step="Open a")), "--adopt-existing")
        self.assertEqual(code, 0, out)
        ids = [c.id for c in td.parse_test_cases(self.story_path("US-001").read_text(encoding="utf-8")).cases]
        self.assertEqual(ids, ["TC-9", "TC-1"])

    def test_append_with_recorded_hash_keeps_hand_edits(self):
        _, first = self.merge("US-001", draft("US-001", case("TC-1", "A")))
        p = self.story_path("US-001")
        p.write_text(p.read_text(encoding="utf-8").replace("Open the page", "Open it (edited)"), encoding="utf-8")
        code, out = self.merge("US-001", draft("US-001", case("TC-2", "B", step="Open b")), "--expect-sha256", first["sha256"])
        self.assertEqual(code, 0, out)
        self.assertTrue(out["userEditsDetected"])
        self.assertIn("(edited)", p.read_text(encoding="utf-8"))

    def test_id_owned_by_another_story_is_refused_via_the_index(self):
        self.write("test-design/state/traceability.json", json.dumps(
            {"version": 1, "stories": {}, "cases": {"TC-1": {"title": "x", "storyIds": ["US-002"]}}}))
        code, out = self.merge("US-001", draft("US-001", case("TC-1", "A")))
        self.assertEqual(code, 1)
        self.assertIn("DUPLICATE_ID", {f["code"] for f in out["findings"]})
        self.assertFalse(self.story_path("US-001").exists())

    def test_saving_one_story_never_touches_another_storys_file(self):
        self.merge("US-001", draft("US-001", case("TC-1", "A")))
        snap = self.story_path("US-001").read_bytes()
        mtime = self.story_path("US-001").stat().st_mtime_ns
        self.merge("US-002", draft("US-002", case("TC-2", "B", step="Open b")))
        self.assertEqual(self.story_path("US-001").read_bytes(), snap)
        self.assertEqual(self.story_path("US-001").stat().st_mtime_ns, mtime)

    def test_saving_story_b_does_not_parse_story_a_file(self):
        """A corrupt neighbouring file cannot affect, or be read by, the story being saved."""
        self.merge("US-001", draft("US-001", case("TC-1", "A")))
        self.story_path("US-001").write_bytes(b"\xff\xfe not even utf-8 \x00")
        code, out = self.merge("US-002", draft("US-002", case("TC-2", "B", step="Open b")))
        self.assertEqual(code, 0, out)


class Regeneration(TempProject):
    def setUp(self):
        super().setUp()
        self.d = self.write("d1.md", draft("US-001", case("TC-1", "A"), case("TC-2", "B", step="Open b")))
        _, out = run(SAFE, "merge-cases", "--root", self.root, "--target", td.testcase_rel_path("US-001"),
                     "--source", self.d, "--story-id", "US-001")
        self.sha = out["sha256"]
        # a neighbour that must stay untouched
        run(SAFE, "merge-cases", "--root", self.root, "--target", td.testcase_rel_path("US-002"),
            "--source", self.write("d2.md", draft("US-002", case("TC-7", "Z", step="Open z"))), "--story-id", "US-002")
        self.neighbour = self.story_path("US-002").read_bytes()

    def regen(self, text, *extra, sha=None):
        d = self.write("new.md", text)
        return run(SAFE, "regenerate-story-file", "--root", self.root, "--story-id", "US-001", "--source", d,
                   "--expect-sha256", sha or self.sha, *extra)

    NEW = draft("US-001", case("TC-1", "A", step="Open the new page"), case("TC-3", "C", step="Open c"))

    def test_default_is_a_dry_run_that_reports_the_difference(self):
        before = self.story_path("US-001").read_bytes()
        code, out = self.regen(self.NEW)
        self.assertEqual((code, out["dryRun"]), (0, True), out)
        self.assertEqual((out["changed"], out["added"], out["removed"], out["kept"]), (["TC-1"], ["TC-3"], ["TC-2"], []))
        self.assertEqual(self.story_path("US-001").read_bytes(), before)

    def test_unchanged_cases_are_reported_as_kept(self):
        code, out = self.regen(draft("US-001", case("TC-1", "A"), case("TC-2", "B", step="Open b")))
        self.assertEqual((out["kept"], out["changed"], out["added"], out["removed"]), (["TC-1", "TC-2"], [], [], []))

    def test_yes_replaces_only_this_file_and_keeps_a_backup(self):
        before = self.story_path("US-001").read_text(encoding="utf-8")
        code, out = self.regen(self.NEW, "--yes")
        self.assertEqual(code, 0, out)
        ids = [c.id for c in td.parse_test_cases(self.story_path("US-001").read_text(encoding="utf-8")).cases]
        self.assertEqual(ids, ["TC-1", "TC-3"])
        self.assertEqual(td.read_text(Path(out["backup"])), before)
        self.assertEqual(self.story_path("US-002").read_bytes(), self.neighbour)

    def test_hand_edits_need_a_second_explicit_yes(self):
        p = self.story_path("US-001")
        p.write_text(p.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        snap = p.read_bytes()
        code, out = self.regen(self.NEW, "--yes")
        self.assertEqual((code, out["error"]["code"], out["userEditsDetected"]), (3, "USER_EDITS", True))
        self.assertEqual(p.read_bytes(), snap)
        code, out = self.regen(self.NEW, "--yes", "--accept-user-edits")
        self.assertEqual(code, 0, out)

    def test_draft_for_another_story_is_refused(self):
        code, out = self.regen(draft("US-002", case("TC-1", "A")), "--yes")
        self.assertEqual((code, out["error"]["code"]), (1, "VALIDATION"))

    def test_invalid_draft_is_never_written(self):
        before = self.story_path("US-001").read_bytes()
        code, out = self.regen(draft("US-001", "## TC-1: T\n\n### Steps\n1. Click #go\n"), "--yes")
        self.assertEqual(code, 1)
        self.assertEqual(self.story_path("US-001").read_bytes(), before)

    def test_missing_file_points_to_merge_cases(self):
        self.story_path("US-001").unlink()
        code, out = self.regen(self.NEW, "--yes")
        self.assertEqual((code, out["error"]["code"]), (4, "MISSING"))

    def test_yes_is_required_to_write(self):
        before = self.story_path("US-001").read_bytes()
        self.regen(self.NEW)
        self.assertEqual(self.story_path("US-001").read_bytes(), before)


class StableIdsOnRegeneration(TempProject):
    def ids(self, *extra):
        batch = self.write("b.json", json.dumps([{"storyIds": ["US-001"], "title": "Valid user can sign in"}]))
        trace = self.write("tr.json", json.dumps({"version": 1, "stories": {}, "cases": {}}))
        return batch, trace

    def test_regenerating_reuses_the_ids_the_story_already_owns(self):
        batch, _ = self.ids()
        _, first = run("generate-stable-id.py", "--batch", batch)
        cid = first["results"][0]["id"]
        trace = self.write("tr.json", json.dumps({"version": 1, "stories": {}, "cases": {
            cid: {"title": "Valid user can sign in", "storyIds": ["US-001"], "scenarioKey": first["results"][0]["scenarioKey"]}}}))
        _, plain = run("generate-stable-id.py", "--batch", batch, "--traceability", trace)
        self.assertTrue(plain["results"][0]["exists"])
        _, regen = run("generate-stable-id.py", "--batch", batch, "--traceability", trace, "--regenerate-story", "US-001")
        self.assertEqual((regen["results"][0]["id"], regen["results"][0]["exists"]), (cid, False))

    def test_other_storys_ids_stay_taken(self):
        batch, _ = self.ids()
        _, first = run("generate-stable-id.py", "--batch", batch)
        r = first["results"][0]
        trace = self.write("tr.json", json.dumps({"version": 1, "stories": {}, "cases": {
            r["id"]: {"title": "x", "storyIds": ["US-009"], "scenarioKey": "other"}}}))
        _, out = run("generate-stable-id.py", "--batch", batch, "--traceability", trace, "--regenerate-story", "US-001")
        self.assertNotEqual(out["results"][0]["id"], r["id"])


class Traceability(TempProject):
    def setup_two(self):
        for sid, cid, title in (("US-001", "TC-1", "A"), ("US-002", "TC-2", "B")):
            run(SAFE, "merge-cases", "--root", self.root, "--target", td.testcase_rel_path(sid), "--story-id", sid,
                "--source", self.write(f"d-{sid}.md", draft(sid, case(cid, title, step=f"Open {title}"))))
        trace = {"version": 1,
                 "stories": {"US-001": {"sourceFile": "s.md", "criteria": ["AC-1"], "testCaseFile": td.testcase_rel_path("US-001")},
                             "US-002": {"sourceFile": "s.md", "criteria": ["AC-1"], "testCaseFile": td.testcase_rel_path("US-002")}},
                 "cases": {"TC-1": {"title": "A", "storyIds": ["US-001"], "covers": ["US-001#AC-1"]},
                           "TC-2": {"title": "B", "storyIds": ["US-002"], "covers": ["US-002#AC-1"]}}}
        self.trace_path = self.write("test-design/state/traceability.json", json.dumps(trace))
        return trace

    def codes(self, out):
        return {f["code"] for f in out["findings"]}

    def test_suite_wide_check_is_clean(self):
        self.setup_two()
        code, out = run(TRACE, "--test-cases-dir", self.root / RELDIR, "--traceability", self.trace_path)
        self.assertEqual((code, out["ok"], out["summary"]["filesChecked"]), (0, True, 2), out)
        self.assertEqual(out["findings"], [])

    def test_one_story_is_checked_from_its_own_file_alone(self):
        self.setup_two()
        code, out = run(TRACE, "--test-cases", self.story_path("US-001"), "--traceability", self.trace_path)
        self.assertEqual((code, out["summary"]["filesChecked"], out["summary"]["storiesTracked"]), (0, 1, 1), out)
        self.assertEqual(out["findings"], [])

    def test_explicit_story_id_filter_in_dir_mode_opens_only_that_file(self):
        self.setup_two()
        self.story_path("US-002").write_bytes(b"\xff\xfe broken")
        code, out = run(TRACE, "--test-cases-dir", self.root / RELDIR, "--traceability", self.trace_path, "--story-id", "US-001")
        self.assertEqual((code, out["summary"]["filesChecked"]), (0, 1), out)

    def test_case_in_the_wrong_storys_file(self):
        t = self.setup_two()
        t["cases"]["TC-2"]["storyIds"] = ["US-001"]
        self.trace_path.write_text(json.dumps(t), encoding="utf-8")
        code, out = run(TRACE, "--test-cases-dir", self.root / RELDIR, "--traceability", self.trace_path)
        self.assertEqual(code, 1)
        self.assertIn("FILE_STORY_MISMATCH", self.codes(out))

    def test_recorded_file_that_is_missing(self):
        self.setup_two()
        self.story_path("US-002").unlink()
        code, out = run(TRACE, "--test-cases-dir", self.root / RELDIR, "--traceability", self.trace_path)
        self.assertIn("TESTCASE_FILE_MISSING", self.codes(out))
        self.assertIn("STALE_MAPPING", self.codes(out))

    def test_mapping_recorded_for_a_different_file_name(self):
        t = self.setup_two()
        t["stories"]["US-001"]["testCaseFile"] = "test-design/test-cases/US-009-testcase.md"
        self.trace_path.write_text(json.dumps(t), encoding="utf-8")
        code, out = run(TRACE, "--test-cases", self.story_path("US-001"), "--traceability", self.trace_path)
        self.assertEqual(code, 1)
        self.assertIn("TESTCASE_FILE_MISMATCH", self.codes(out))

    def test_unmapped_case_in_a_story_file(self):
        t = self.setup_two()
        del t["cases"]["TC-1"]
        self.trace_path.write_text(json.dumps(t), encoding="utf-8")
        code, out = run(TRACE, "--test-cases", self.story_path("US-001"), "--traceability", self.trace_path)
        self.assertIn("ORPHAN_CASE", self.codes(out))

    def test_schema_accepts_test_case_file_and_rejects_nonsense(self):
        schema = td.load_schema("traceability")
        ok = {"version": 1, "stories": {"US-1": {"sourceFile": "a.md", "testCaseFile": "test-design/test-cases/US-1-testcase.md"}}, "cases": {}}
        self.assertEqual(td.validate_json(ok, schema), [])
        bad = json.loads(json.dumps(ok))
        bad["stories"]["US-1"]["testCaseFile"] = "test-design\\test-cases\\test-cases.md"
        self.assertNotEqual(td.validate_json(bad, schema), [])


class SourceChangeDetection(TempProject):
    def setup(self):
        story_file = self.root / "stories" / "auth" / "login.md"
        snap_code, snap = run(FINGERPRINT, "snapshot", story_file, "--root", self.root)
        self.prev = self.write("test-design/state/source-fingerprints.json", json.dumps(snap))
        stories = {sid: info["sha256"] for sid, info in snap["files"]["stories/auth/login.md"]["stories"].items()}
        files = {}
        wf_stories = {}
        for sid in ("US-001", "US-002"):
            rel = td.testcase_rel_path(sid)
            self.write(rel, draft(sid, case(f"TC-{sid[-1]}", "A")))
            files[sid] = rel
            wf_stories[sid] = {"status": "saved", "sourceFile": "stories/auth/login.md",
                               "testCaseFile": {"path": rel, "sha256": td.sha256_file(self.root / rel),
                                                "caseCount": 1, "sourceSha256": stories[sid]}}
        self.wf = {"version": 1, "stories": wf_stories}
        self.wf_path = self.write("test-design/state/workflow.json", json.dumps(self.wf))
        self.story_file = story_file
        return files

    def compare(self):
        return run(FINGERPRINT, "compare", self.story_file, "--previous", self.prev, "--root", self.root,
                   "--workflow", self.wf_path)

    def test_nothing_changed(self):
        self.setup()
        code, out = self.compare()
        self.assertEqual((code, out["sourcesChanged"], out["staleTestCaseFiles"]), (0, False, []), out)

    def test_changing_one_story_marks_only_its_file_stale(self):
        files = self.setup()
        text = self.story_file.read_text(encoding="utf-8")
        self.story_file.write_text(text.replace("locks the account for 15 minutes", "locks the account for 30 minutes", 1),
                                   encoding="utf-8")
        code, out = self.compare()
        self.assertEqual(code, 1)
        self.assertIn("US-001", [r["storyId"] for r in out["staleTestCaseFiles"]], out)
        stale = {r["storyId"]: r for r in out["staleTestCaseFiles"]}
        self.assertEqual(stale["US-001"]["file"], files["US-001"])
        self.assertEqual(stale["US-001"]["reasons"], ["story_changed"])
        self.assertNotIn("US-002", stale)
        self.assertEqual(list(out["affectedTestCaseFiles"]), ["US-001"])

    def test_staleness_survives_a_refreshed_run_snapshot(self):
        """Regenerating story A must not hide that story B's file is still out of date."""
        self.setup()
        text = self.story_file.read_text(encoding="utf-8")
        text = text.replace("locks the account for 15 minutes", "locks the account for 30 minutes", 1)
        self.story_file.write_text(text, encoding="utf-8")
        run(FINGERPRINT, "snapshot", self.story_file, "--root", self.root, "--output", "test-design/state/source-fingerprints.json")
        code, out = self.compare()
        self.assertEqual([r["storyId"] for r in out["staleTestCaseFiles"]], ["US-001"])
        self.assertEqual(code, 1)

    def test_missing_and_edited_files_are_reported(self):
        files = self.setup()
        (self.root / files["US-001"]).unlink()
        p = self.root / files["US-002"]
        p.write_text(p.read_text(encoding="utf-8") + "\n<!-- note -->\n", encoding="utf-8")
        code, out = self.compare()
        stale = {r["storyId"]: r for r in out["staleTestCaseFiles"]}
        self.assertTrue(stale["US-001"]["fileMissing"])
        self.assertNotIn("US-002", stale)  # edited but its story did not change: not stale

    def test_workflow_needs_a_root(self):
        self.setup()
        code, out = run(FINGERPRINT, "compare", self.story_file, "--previous", self.prev, "--workflow", self.wf_path)
        self.assertEqual((code, out["error"]["code"]), (2, "USAGE"))

    def test_traceability_names_the_file_of_a_changed_story(self):
        self.setup()
        trace = self.write("tr.json", json.dumps({"version": 1, "stories": {
            "US-001": {"sourceFile": "s", "testCaseFile": td.testcase_rel_path("US-001")}},
            "cases": {"TC-1": {"title": "A", "storyIds": ["US-001"]}}}))
        self.story_file.write_text(self.story_file.read_text(encoding="utf-8").replace("15 minutes", "20 minutes", 1), encoding="utf-8")
        code, out = run(FINGERPRINT, "compare", self.story_file, "--previous", self.prev, "--root", self.root, "--traceability", trace)
        self.assertEqual(out["affectedTestCaseFiles"], {"US-001": td.testcase_rel_path("US-001")})
        self.assertEqual(out["affectedTestCases"], {"US-001": ["TC-1"]})


class WorkflowSchema(unittest.TestCase):
    def wf(self, story, outputs=None):
        return {"version": 1, "runId": "run-20260101-000000", "status": "in_progress", "projectRoot": "/p",
                "sourceFiles": ["s.md"], "currentPhase": "save", "stories": {"US-001": story},
                "outputs": outputs or {}, "createdAt": "x", "updatedAt": "x"}

    def test_story_test_case_file_is_recorded(self):
        w = self.wf({"status": "saved", "testCaseFile": {"path": "test-design/test-cases/US-001-testcase.md", "sha256": "ab",
                                                          "caseCount": 3, "sourceSha256": "cd", "updatedAt": "t"}},
                    {"testCases": {"directory": "test-design/test-cases", "fileNamePattern": "<USER_STORY_ID>-testcase.md",
                                   "fileCount": 1, "caseCount": 3}})
        self.assertEqual(td.validate_json(w, td.load_schema("workflow-state")), [])

    def test_a_test_case_file_needs_a_path(self):
        w = self.wf({"status": "saved", "testCaseFile": {"sha256": "ab"}})
        self.assertNotEqual(td.validate_json(w, td.load_schema("workflow-state")), [])

    def test_runs_recorded_before_this_change_still_validate(self):
        w = self.wf({"status": "saved"}, {"testCases": {"path": "test-design/test-cases/test-cases.md", "sha256": "ab", "caseCount": 2}})
        self.assertEqual(td.validate_json(w, td.load_schema("workflow-state")), [])

    def test_template_matches_the_schema_shape(self):
        tpl = json.loads((Path(__file__).resolve().parent.parent / "templates" / "test-design-state.template.json").read_text(encoding="utf-8"))
        self.assertEqual(tpl["outputs"]["testCases"]["fileNamePattern"], "<USER_STORY_ID>-testcase.md")
        self.assertNotIn("test-cases.md", json.dumps(tpl))


class LegacyMigration(TempProject):
    LEGACY = ("# Login\nUser Story ID: US-001\n\n" + case("TC-1", "A") + "\n" + case("TC-2", "B", step="Open b")
              + "\n# Billing\nUser Story ID: US-002\n\n" + case("TC-3", "C", step="Open c")
              + "\n# Login\nUser Story ID: US-001\n\n" + case("TC-4", "D", step="Open d"))

    def legacy(self, text=None):
        return self.write(f"{RELDIR}/test-cases.md", text or self.LEGACY)

    def split(self, *extra):
        return run(SAFE, "split-legacy", "--root", self.root, *extra)

    def test_dry_run_writes_nothing(self):
        p = self.legacy()
        before = p.read_bytes()
        code, out = self.split()
        self.assertEqual((code, out["dryRun"], out["legacyCases"]), (0, True, 4), out)
        self.assertEqual({f["storyId"]: f["caseIds"] for f in out["files"]}, {"US-001": ["TC-1", "TC-2", "TC-4"], "US-002": ["TC-3"]})
        self.assertEqual(p.read_bytes(), before)
        self.assertFalse(self.story_path("US-001").exists())

    def test_yes_splits_by_story_keeps_every_case_and_backs_up_the_old_file(self):
        p = self.legacy()
        original = p.read_text(encoding="utf-8")
        code, out = self.split("--yes")
        self.assertEqual(code, 0, out)
        self.assertFalse(p.exists())
        self.assertEqual(td.read_text(Path(out["legacyBackup"])), original)
        d1 = td.parse_test_cases(self.story_path("US-001").read_text(encoding="utf-8"))
        d2 = td.parse_test_cases(self.story_path("US-002").read_text(encoding="utf-8"))
        self.assertEqual([c.id for c in d1.cases], ["TC-1", "TC-2", "TC-4"])
        self.assertEqual([c.id for c in d2.cases], ["TC-3"])
        self.assertTrue(all(c.story_id == "US-001" for c in d1.cases))
        self.assertEqual(run(VALIDATE, "--dir", self.root / RELDIR)[0], 0)

    def test_hand_edits_inside_a_section_are_preserved_byte_for_byte(self):
        self.legacy(self.LEGACY.replace("Open the page", "Open the page (my edit)", 1))
        self.split("--yes")
        self.assertIn("(my edit)", self.story_path("US-001").read_text(encoding="utf-8"))

    def test_patches_for_the_state_files_are_ready_to_use(self):
        self.legacy()
        _, out = self.split("--yes")
        self.assertEqual(out["traceabilityPatch"]["stories"]["US-001"]["testCaseFile"], td.testcase_rel_path("US-001"))
        tf = out["workflowPatch"]["stories"]["US-002"]["testCaseFile"]
        self.assertEqual((tf["path"], tf["caseCount"], tf["sha256"]), (td.testcase_rel_path("US-002"), 1, td.sha256_file(self.story_path("US-002"))))
        errs = td.validate_json({"version": 1, "runId": "run-20260101-000000", "status": "in_progress", "projectRoot": "/p",
                                 "sourceFiles": ["s"], "currentPhase": "save", "createdAt": "x", "updatedAt": "x",
                                 "stories": {k: {"status": "saved", **v} for k, v in out["workflowPatch"]["stories"].items()}},
                                td.load_schema("workflow-state"))
        self.assertEqual(errs, [])

    def test_a_module_without_a_story_id_blocks_the_split(self):
        p = self.legacy("# Login\n\n" + case("TC-1", "A"))
        before = p.read_bytes()
        code, out = self.split("--yes")
        self.assertEqual((code, out["error"]["code"]), (3, "CANNOT_SPLIT"))
        self.assertEqual(p.read_bytes(), before)
        self.assertFalse(self.story_path("US-001").exists())

    def test_an_existing_story_file_is_never_overwritten(self):
        p = self.legacy()
        mine = self.write(f"{RELDIR}/US-002-testcase.md", draft("US-002", case("TC-99", "Mine")))
        before = mine.read_bytes()
        code, out = self.split("--yes")
        self.assertEqual((code, out["error"]["code"]), (3, "CANNOT_SPLIT"))
        self.assertEqual(mine.read_bytes(), before)
        self.assertTrue(p.exists())
        self.assertFalse(self.story_path("US-001").exists())  # all or nothing

    def test_no_legacy_file(self):
        (self.root / RELDIR).mkdir(parents=True)
        self.assertEqual(self.split()[0], 4)


class Discovery(TempProject):
    def discover(self):
        return run("discover-story-files.py", self.root / "stories", "--cwd", self.root)[1]["existingOutput"]

    def test_per_story_files_count_as_existing_output(self):
        self.write(f"stories/{RELDIR}/US-001-testcase.md", draft("US-001", case("TC-1", "A")))
        eo = self.discover()
        self.assertEqual((eo["testCases"], eo["testCaseFiles"], eo["legacyConsolidatedFile"]), (True, 1, False))

    def test_legacy_file_is_flagged(self):
        self.write(f"stories/{RELDIR}/test-cases.md", draft("US-001", case("TC-1", "A")))
        eo = self.discover()
        self.assertEqual((eo["testCases"], eo["testCaseFiles"], eo["legacyConsolidatedFile"]), (True, 0, True))


if __name__ == "__main__":
    unittest.main()

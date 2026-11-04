"""Module-level ``User Story ID:`` field: parsing, validation, merge placement, traceability, back-compat."""
import json
import unittest

from helpers import FIXTURES, TempProject, case, run, td

SAFE = "safe-file-operations.py"


def module(name="Login", sid="US-001", *blocks):
    head = f"# {name}\n" + (f"User Story ID: {sid}\n" if sid is not None else "") + "\n"
    return head + "\n".join(blocks)


def errors(text, **kw):
    doc = td.parse_test_cases(text)
    return {f.code for f in td.validate_doc(doc, **kw) if f.severity == "error"}


class Parsing(unittest.TestCase):
    def test_story_id_is_inherited_by_every_case_in_the_module(self):
        t = module("Login", "US-001", case("TC-1", "A"), case("TC-2", "B", step="Open b"))
        doc = td.parse_test_cases(t)
        self.assertEqual([c.story_id for c in doc.cases], ["US-001", "US-001"])
        self.assertEqual(doc.modules[0].story_id, "US-001")
        self.assertEqual(errors(t), set())

    def test_blank_line_between_heading_and_field_is_accepted(self):
        t = "# Login\n\nUser Story ID: US-001\n\n" + case("TC-1", "A")
        self.assertEqual(td.parse_test_cases(t).cases[0].story_id, "US-001")
        self.assertEqual(errors(t), set())

    def test_same_module_name_repeated_for_two_stories(self):
        t = (module("Login", "US-001", case("TC-1", "A")) + "\n"
             + module("Login", "US-002", case("TC-2", "B", step="Open b")))
        doc = td.parse_test_cases(t)
        self.assertEqual([(c.module, c.story_id) for c in doc.cases], [("Login", "US-001"), ("Login", "US-002")])
        self.assertEqual(errors(t), set())

    def test_fields_after_the_story_id_are_unaffected(self):
        t = module("Login", "US-001", case("TC-1", "A", extra="Priority: High\nTags: smoke"))
        doc = td.parse_test_cases(t)
        self.assertEqual(doc.cases[0].fields, {"Priority": "High", "Tags": "smoke"})
        self.assertEqual(errors(t), set())

    def test_crlf_file(self):
        t = module("Login", "US-001", case("TC-1", "A")).replace("\n", "\r\n")
        self.assertEqual(td.parse_test_cases(t).cases[0].story_id, "US-001")
        self.assertEqual(errors(t), set())


class Validation(unittest.TestCase):
    def test_malformed_ids(self):
        for bad in ("-US", "US/001", "<id>", "US-001!"):
            self.assertIn("STORY_ID_FORMAT", errors(module("M", bad, case("TC-1", "A"))), bad)
        self.assertIn("STORY_ID_MULTIPLE", errors(module("M", "US 001", case("TC-1", "A"))))

    def test_empty_value(self):
        self.assertIn("STORY_ID_EMPTY", errors("# M\nUser Story ID:\n\n" + case("TC-1", "A")))

    def test_several_ids_in_one_module_point_to_repeating_the_heading(self):
        t = module("M", "US-001, US-002", case("TC-1", "A"))
        self.assertIn("STORY_ID_MULTIPLE", errors(t))
        msg = next(f.message for f in td.validate_doc(td.parse_test_cases(t)) if f.code == "STORY_ID_MULTIPLE")
        self.assertIn("repeat", msg)

    def test_duplicate_line_in_one_module(self):
        t = "# M\nUser Story ID: US-001\nUser Story ID: US-002\n\n" + case("TC-1", "A")
        self.assertIn("DUPLICATE_FIELD", errors(t))

    def test_field_inside_a_case_is_rejected(self):
        t = module("M", "US-001", case("TC-1", "A", extra="User Story ID: US-001"))
        self.assertIn("STORY_ID_PLACEMENT", errors(t))

    def test_field_before_any_module_heading_is_rejected(self):
        self.assertIn("STORY_ID_PLACEMENT", errors("User Story ID: US-001\n\n" + case("TC-1", "A")))

    def test_field_after_a_case_cannot_switch_story_mid_module(self):
        # it lands inside the case's last section, so it is rejected (as a non-bullet line), not applied
        t = "# M\n\n" + case("TC-1", "A") + "\nUser Story ID: US-002\n"
        self.assertTrue(errors(t))
        self.assertEqual({c.story_id for c in td.parse_test_cases(t).cases}, {None})

    def test_story_id_text_inside_a_section_is_not_a_field(self):
        t = module("M", "US-001", case("TC-1", "A", expected="User Story ID: US-009 is shown in the header"))
        self.assertEqual(errors(t), set())

    def test_required_flag(self):
        legacy = "# M\n\n" + case("TC-1", "A")
        self.assertEqual(errors(legacy), set())  # optional by default
        self.assertEqual(errors(legacy, require_story_id=True), {"STORY_ID_MISSING"})
        self.assertEqual(errors(module("M", "US-001", case("TC-1", "A")), require_story_id=True), set())

    def test_required_flag_flags_moduleless_cases_and_only_the_module_missing_it(self):
        t = case("TC-0", "Loose") + "\n" + module("A", "US-001", case("TC-1", "B", step="Open b")) + "\n# C\n\n" + \
            case("TC-2", "C", step="Open c")
        doc = td.parse_test_cases(t)
        fs = [f for f in td.validate_doc(doc, require_story_id=True) if f.code == "STORY_ID_MISSING"]
        self.assertEqual(sorted(f.case_id or "module C" for f in fs), ["TC-0", "module C"])

    def test_bad_value_not_reported_twice_when_required(self):
        t = module("M", "US 001", case("TC-1", "A"))
        codes = [f.code for f in td.validate_doc(td.parse_test_cases(t), require_story_id=True)]
        self.assertNotIn("STORY_ID_MISSING", codes)

    def test_existing_fixtures_still_valid(self):
        text = (FIXTURES / "valid-cases.md").read_text(encoding="utf-8")
        self.assertEqual(errors(text), set())

    def test_fix_safe_keeps_the_field_directly_under_the_heading(self):
        fixed, _ = td.fix_safe(module("Login", "US-001", case("TC-1", "A")))
        self.assertTrue(fixed.startswith("# Login\nUser Story ID: US-001\n"))

    def test_report_exposes_story_id(self):
        doc = td.parse_test_cases(module("Login", "US-001", case("TC-1", "A")))
        rep = td.validation_report(doc, td.validate_doc(doc))
        self.assertEqual(rep["cases"][0]["storyId"], "US-001")


class CliAndMerge(TempProject):
    def validate(self, text, *extra):
        return run("validate-test-cases.py", self.write("t.md", text), *extra)

    def merge(self, text, *extra):
        return run(SAFE, "merge-cases", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                   "--source", self.write("d.md", text), *extra)

    def saved(self):
        return self.cases_path.read_text(encoding="utf-8")

    def test_validate_cli_require_flag(self):
        legacy = "# M\n\n" + case("TC-1", "A")
        self.assertEqual(self.validate(legacy)[0], 0)
        code, out = self.validate(legacy, "--require-story-id")
        self.assertEqual(code, 1)
        self.assertEqual([f["code"] for f in out["findings"]], ["STORY_ID_MISSING"])

    def test_new_section_is_written_with_its_story_id(self):
        code, out = self.merge(module("Login", "US-001", case("TC-1", "A")), "--require-story-id")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["placement"]["perStory"], {"US-001": ["TC-1"]})
        self.assertTrue(self.saved().startswith("# Login\nUser Story ID: US-001\n\n## TC-1"))

    def test_merge_requires_story_id_when_asked(self):
        code, out = self.merge("# Login\n\n" + case("TC-1", "A"), "--require-story-id")
        self.assertEqual((code, out["error"]["code"]), (1, "VALIDATION"))
        self.assertFalse(self.cases_path.exists())

    def test_merge_without_flag_still_accepts_legacy_drafts(self):
        code, out = self.merge("# Login\n\n" + case("TC-1", "A"))
        self.assertEqual(code, 0, out)
        self.assertNotIn("User Story ID", self.saved())

    def test_same_story_appends_to_its_own_section(self):
        self.merge(module("Login", "US-001", case("TC-1", "A")) + "\n" + module("Login", "US-002", case("TC-2", "B", step="Open b")))
        code, out = self.merge(module("Login", "US-001", case("TC-3", "C", step="Open c")))
        self.assertEqual(code, 0, out)
        doc = td.parse_test_cases(self.saved())
        self.assertEqual([(c.id, c.story_id) for c in doc.cases],
                         [("TC-1", "US-001"), ("TC-3", "US-001"), ("TC-2", "US-002")])
        self.assertEqual(self.saved().count("# Login"), 2)
        self.assertEqual(out["placement"]["newModules"], [])

    def test_new_story_in_existing_module_gets_its_own_section_and_old_bytes_survive(self):
        self.merge(module("Login", "US-001", case("TC-1", "A")))
        before = self.saved()
        code, out = self.merge(module("Login", "US-002", case("TC-2", "B", step="Open b")))
        self.assertEqual(code, 0, out)
        after = self.saved()
        self.assertTrue(after.startswith(before.rstrip("\n")))
        doc = td.parse_test_cases(after)
        self.assertEqual([(c.module, c.story_id) for c in doc.cases], [("Login", "US-001"), ("Login", "US-002")])
        self.assertEqual(out["placement"]["newModules"], ["Login"])

    def test_legacy_section_is_never_attributed_to_a_story(self):
        self.merge("# Login\n\n" + case("TC-1", "A"))
        before = self.saved()
        code, out = self.merge(module("Login", "US-001", case("TC-2", "B", step="Open b")))
        self.assertEqual(code, 0, out)
        doc = td.parse_test_cases(self.saved())
        self.assertEqual([(c.id, c.story_id) for c in doc.cases], [("TC-1", None), ("TC-2", "US-001")])
        self.assertTrue(self.saved().startswith(before.rstrip("\n")))

    def test_case_added_to_a_section_whose_heading_has_no_cases_yet(self):
        # an empty section: insertion must land below the User Story ID line, not between it and the heading
        target = self.root / "test-design" / "test-cases"
        target.mkdir(parents=True)
        (target / "test-cases.md").write_text("# Login\nUser Story ID: US-001\n", encoding="utf-8")
        code, out = self.merge(module("Login", "US-001", case("TC-1", "A")))
        self.assertEqual(code, 0, out)
        self.assertTrue(self.saved().startswith("# Login\nUser Story ID: US-001\n"))
        self.assertEqual(td.parse_test_cases(self.saved()).cases[0].story_id, "US-001")

    def test_skip_conflict_rebuild_keeps_story_ids(self):
        self.merge(module("Login", "US-001", case("TC-1", "A")))
        draft = module("Login", "US-001", case("TC-1", "A")) + "\n" + module("Login", "US-002", case("TC-2", "B", step="Open b"))
        code, out = self.merge(draft, "--on-conflict", "skip")
        self.assertEqual((code, out["added"]), (0, ["TC-2"]))
        doc = td.parse_test_cases(self.saved())
        self.assertEqual([(c.id, c.story_id) for c in doc.cases], [("TC-1", "US-001"), ("TC-2", "US-002")])

    def test_moduleless_case_still_goes_under_general(self):
        code, out = self.merge(case("TC-1", "A"))
        self.assertEqual(out["placement"]["general"], ["TC-1"])
        self.assertIn("# General\n", self.saved())


class TraceabilityCrossCheck(TempProject):
    def check(self, md, story_ids):
        trace = {"version": 1, "stories": {s: {"sourceFile": "a.md", "criteria": ["AC-1"]} for s in ("US-001", "US-002")},
                 "cases": {"TC-1": {"title": "A", "storyIds": story_ids, "covers": []}}}
        code, out = run("validate-traceability.py", "--test-cases", self.write("tc.md", md),
                        "--traceability", self.write("tr.json", json.dumps(trace)))
        return {f["code"] for f in out["findings"]}

    def test_matching_story_id_is_quiet(self):
        self.assertNotIn("STORY_ID_MISMATCH", self.check(module("M", "US-001", case("TC-1", "A")), ["US-001"]))

    def test_mismatch_warns(self):
        self.assertIn("STORY_ID_MISMATCH", self.check(module("M", "US-002", case("TC-1", "A")), ["US-001"]))

    def test_case_mapped_to_several_stories_matches_any(self):
        self.assertNotIn("STORY_ID_MISMATCH", self.check(module("M", "US-002", case("TC-1", "A")), ["US-001", "US-002"]))

    def test_legacy_file_without_field_is_quiet(self):
        self.assertNotIn("STORY_ID_MISMATCH", self.check("# M\n\n" + case("TC-1", "A"), ["US-001"]))


if __name__ == "__main__":
    unittest.main()

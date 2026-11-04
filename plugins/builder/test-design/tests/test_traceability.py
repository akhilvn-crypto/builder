import json
import unittest

from helpers import TempProject, case, run, td


def trace(cases=None, stories=None):
    return {"version": 1,
            "stories": stories if stories is not None else {
                "US-001": {"sourceFile": "a.md", "criteria": ["AC-1", "AC-2"]}},
            "cases": cases or {}}


class Traceability(TempProject):
    def check(self, cases_md, trace_obj, fingerprints=None):
        md = self.write("tc.md", cases_md)
        tr = self.write("tr.json", json.dumps(trace_obj))
        args = ["--test-cases", md, "--traceability", tr]
        if fingerprints:
            args += ["--fingerprints", self.write("fp.json", json.dumps(fingerprints))]
        code, out = run("validate-traceability.py", *args)
        return code, out, {f["code"] for f in out.get("findings", [])}

    MD = "# M\n\n" + case("TC-1", "A") + "\n" + case("TC-2", "B", step="Open b")

    def test_fully_mapped_and_covered(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"], "covers": ["US-001#AC-1"]},
                   "TC-2": {"title": "B", "storyIds": ["US-001"], "covers": ["US-001#AC-2"]}})
        code, out, found = self.check(self.MD, t)
        self.assertEqual((code, found), (0, set()))
        self.assertEqual(out["summary"]["criteriaCovered"], 2)

    def test_case_without_mapping_is_an_error(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"], "covers": ["US-001#AC-1", "US-001#AC-2"]}})
        code, out, found = self.check(self.MD, t)
        self.assertEqual(code, 1)
        self.assertIn("ORPHAN_CASE", found)

    def test_case_without_id_is_orphaned(self):
        md = "# M\n\n## Untitled thing\n\n### Steps\n1. Open\n\n### Expected Results\n- The page shows \"Hi\"\n"
        code, out, found = self.check(md, trace())
        self.assertIn("ORPHAN_CASE", found)

    def test_mapping_with_no_story_fails_schema_and_logic(self):
        t = trace({"TC-1": {"title": "A", "storyIds": []}, "TC-2": {"title": "B", "storyIds": ["US-001"]}})
        code, out, found = self.check(self.MD, t)
        self.assertEqual(code, 1)
        self.assertIn("SCHEMA", found)
        self.assertIn("NO_STORY", found)

    def test_unknown_story_reference(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-404"]}, "TC-2": {"title": "B", "storyIds": ["US-001"]}})
        code, out, found = self.check(self.MD, t)
        self.assertIn("UNKNOWN_STORY", found)

    def test_bad_covers_reference(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"], "covers": ["US-001#AC-99"]},
                   "TC-2": {"title": "B", "storyIds": ["US-001"]}})
        code, out, found = self.check(self.MD, t)
        self.assertIn("BAD_COVERS", found)

    def test_stale_mapping_and_uncovered_criterion_are_warnings(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"], "covers": ["US-001#AC-1"]},
                   "TC-2": {"title": "B", "storyIds": ["US-001"]},
                   "TC-9": {"title": "Gone", "storyIds": ["US-001"]}})
        code, out, found = self.check(self.MD, t)
        self.assertEqual(code, 0)
        self.assertEqual(found, {"STALE_MAPPING", "CRITERION_UNCOVERED"})

    def test_story_without_cases_warns_unless_not_testable(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"]}, "TC-2": {"title": "B", "storyIds": ["US-001"]}},
                  stories={"US-001": {"sourceFile": "a.md"}, "US-002": {"sourceFile": "a.md"},
                           "US-003": {"sourceFile": "a.md", "status": "no_testable_behaviour"}})
        code, out, found = self.check(self.MD, t)
        msgs = " ".join(f["message"] for f in out["findings"])
        self.assertIn("US-002", msgs)
        self.assertNotIn("US-003", msgs)

    def test_story_missing_from_sources_warns(self):
        t = trace({"TC-1": {"title": "A", "storyIds": ["US-001"]}, "TC-2": {"title": "B", "storyIds": ["US-001"]}})
        fp = {"files": {"a.md": {"stories": {"US-777": {}}}}}
        code, out, found = self.check(self.MD, t, fp)
        self.assertIn("SOURCE_STORY_MISSING", found)

    def test_corrupt_traceability_is_reported(self):
        md = self.write("tc.md", self.MD)
        tr = self.write("tr.json", "{oops")
        code, out = run("validate-traceability.py", "--test-cases", md, "--traceability", tr)
        self.assertEqual((code, out["error"]["code"]), (4, "STATE_CORRUPT"))


class SchemaSubset(unittest.TestCase):
    def test_workflow_template_shape(self):
        sample = {"version": 1, "runId": "run-20260101-000000", "status": "in_progress", "projectRoot": "/p",
                  "sourceFiles": ["a.md"], "currentPhase": "discover", "currentStoryId": None,
                  "stories": {"US-001": {"status": "pending"}}, "createdAt": "x", "updatedAt": "x"}
        schema = td.load_schema("workflow-state")
        self.assertEqual(td.validate_json(sample, schema), [])
        sample["status"] = "bogus"
        sample["extra"] = 1
        errs = td.validate_json(sample, schema)
        self.assertEqual(len(errs), 2)

    def test_booleans_are_not_integers(self):
        self.assertTrue(td.validate_json(True, {"type": "integer"}))

    def test_ref_to_sibling_schema(self):
        errs = td.validate_json({"version": 1, "stories": {}, "cases": {"X": {"title": "t"}}}, td.load_schema("traceability"))
        self.assertTrue(any("storyIds" in e for e in errs))

    def test_template_file_matches_schema_structure(self):
        from helpers import PLUGIN
        tpl = json.loads((PLUGIN / "templates" / "test-design-state.template.json").read_text(encoding="utf-8"))
        errs = td.validate_json(tpl, td.load_schema("workflow-state"))
        # The template holds <placeholders>, so only the runId pattern may differ.
        self.assertEqual([e for e in errs if "runId" not in e], [])


if __name__ == "__main__":
    unittest.main()

"""Coverage depth: the design rules no longer ask for a minimal set, the analysis can carry the inputs, roles and
states the sweep needs, and ``story-worker.py coverage`` flags a shallow draft before it is saved (advisory only)."""
import json
import unittest

from helpers import PLUGIN, PLUGIN_ROOT, TempProject, case, run, td

WORKER = "story-worker.py"

ANALYSIS = {
    "story_id": "US-201", "story_summary": "A user registers", "behaviour_to_validate": ["Valid data registers", "Short password is rejected"],
    "acceptance_criteria_interpretation": [{"label": "AC-1", "text": "Valid data registers the user"},
                                           {"label": "AC-2", "text": "A password shorter than 8 characters is rejected"}],
    "business_rules": [{"label": "BR-1", "text": "Password must have at least 8 characters"}],
    "inputs": [{"name": "Email", "required": True, "governed_by": ["AC-1"]},
               {"name": "Password", "required": True, "constraints": ["minimum 8 characters"], "governed_by": ["AC-2", "BR-1"]}],
    "roles": ["Visitor", "Admin"],
    "analysis_complete": True,
}


def block(cid, title, extra="", step="Enter {Email} and {Password} in the form"):
    return case(cid, title, step=step, expected=f"Outcome of {title}", extra=extra)


class CoverageDepth(TempProject):
    def run_cov(self, blocks, metas, conditions=None):
        analysis = self.write("scratch/analysis.json", json.dumps(ANALYSIS))
        draft = self.write("scratch/draft.md", "# Registration\nUser Story ID: US-201\n\n" + "\n".join(blocks))
        meta = self.write("scratch/draft.meta.json", json.dumps([
            {"id": cid, "title": t, "module": "Registration", "storyIds": ["US-201"], "covers": covers, "techniques": techs, "scenarioKey": cid}
            for cid, t, covers, techs in metas]))
        args = ["coverage", "--analysis", analysis, "--draft", draft, "--meta", meta]
        if conditions is not None:
            args += ["--conditions", self.write("scratch/conditions.json", json.dumps(conditions))]
        return run(WORKER, *args)

    def test_a_shallow_draft_is_flagged_with_what_is_missing(self):
        code, r = self.run_cov([block("TC-1", "Register with valid data")], [("TC-1", "Register with valid data", ["US-201#AC-1"], ["positive"])])
        self.assertEqual(code, 0)
        self.assertTrue(r["advisory"])
        self.assertEqual(r["missing"], ["AC-2", "BR-1"])
        codes = {s["code"] for s in r["signals"]}
        self.assertTrue({"LOW_VOLUME", "NO_NEGATIVE", "NO_BOUNDARY", "NO_DERIVED", "NO_ROLE_CASES"} <= codes, codes)
        self.assertIn({"kind": "role", "name": "Admin"}, r["untouched"])

    def test_a_deep_draft_has_no_signals_and_counts_each_basis(self):
        cases = [
            ("TC-1", "Register with valid data", ["US-201#AC-1"], ["positive"], ""),
            ("TC-2", "Reject a 7 character password", ["US-201#AC-2", "US-201#BR-1"], ["negative", "boundary"], "Tags: boundary, negative\nPriority: High"),
            ("TC-3", "Accept an 8 character password", ["US-201#BR-1"], ["boundary"], "Tags: boundary, derived\nPriority: High"),
            ("TC-4", "Reject an empty Email", ["US-201#AC-1"], ["negative"], "Tags: negative, derived\nPriority: High"),
            ("TC-5", "Admin registers a Visitor", ["US-201#AC-1"], ["role"], "Tags: role\nPriority: Medium"),
            ("TC-6", "Reject a 7 character Password after a double submit", ["US-201#AC-2"], ["negative"], "Tags: robustness\nPriority: Low"),
            ("TC-7", "Visitor cannot reach the admin page", ["US-201#AC-1"], ["permission"], "Tags: role\nPriority: Medium"),
        ]
        code, r = self.run_cov([block(c, t, extra=e) for c, t, _, _, e in cases], [(c, t, cov, tech) for c, t, cov, tech, _ in cases])
        self.assertEqual(code, 0)
        self.assertEqual(r["signals"], [], r["signals"])
        self.assertEqual((r["thin"], r["missing"], r["untouched"]), ([], [], []))
        self.assertEqual(r["byBasis"], {"stated": 4, "derived": 2, "robustness": 1})
        self.assertEqual(r["perCriterion"]["AC-1"], 4)

    def test_a_criterion_declared_uncovered_is_not_reported_as_missing(self):
        _, r = self.run_cov([block("TC-1", "Register with valid data")], [("TC-1", "Register with valid data", ["US-201#AC-1"], ["positive"])],
                            conditions={"uncovered": [{"label": "AC-2", "reason": "needs email delivery"}, {"label": "BR-1", "reason": "x"}]})
        self.assertEqual(r["missing"], [])

    def test_the_check_is_read_only(self):
        self.run_cov([block("TC-1", "Register with valid data")], [("TC-1", "Register with valid data", ["US-201#AC-1"], ["positive"])])
        self.assertFalse((self.root / "test-design").exists())


class AnalysisCarriesTheSweepInputs(unittest.TestCase):
    def test_the_new_optional_fields_validate_and_unknown_ones_still_do_not(self):
        self.assertEqual(td.validate_json(ANALYSIS, td.load_schema("story-analysis")), [])
        bad = dict(ANALYSIS, inputs=[{"name": "Email", "governed_by": ["XX-1"]}])
        self.assertTrue(td.validate_json(bad, td.load_schema("story-analysis")))
        self.assertTrue(td.validate_json(dict(ANALYSIS, surprise=1), td.load_schema("story-analysis")))


class DesignRulesAskForDepth(unittest.TestCase):
    def read(self, rel):
        return (PLUGIN_ROOT / rel).read_text(encoding="utf-8").lower()

    def test_nothing_still_asks_for_a_minimal_set(self):
        for rel in ("skills/test-coverage-design/SKILL.md", "agents/test-coverage-designer.md", "agents/story-worker.md",
                    "test-design/rules/test-design-principles.md", "test-design/rules/worker-standards.md"):
            text = self.read(rel)
            for phrase in ("minimum sufficient", "aim for the minimum", "cheapest technique", "fewest scenarios", "minimal, non-duplicative"):
                self.assertNotIn(phrase, text, f"{rel} still says '{phrase}'")

    def test_the_worker_runs_the_depth_check_and_keeps_the_no_invention_rule(self):
        worker = self.read("agents/story-worker.md")
        self.assertIn("story-worker.py coverage", worker)
        self.assertIn("never invent", worker)
        skill = self.read("skills/test-coverage-design/SKILL.md")
        for needle in ("derived", "robustness", "universal invariant", "completeness sweep", "never guess one"):
            self.assertIn(needle, skill)


if __name__ == "__main__":
    unittest.main()

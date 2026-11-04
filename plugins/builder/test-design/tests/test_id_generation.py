import json
import re
import unittest

from helpers import TempProject, run


class StableIds(TempProject):
    def gen(self, *args):
        code, out = run("generate-stable-id.py", *args)
        self.assertEqual(code, 0, out)
        return out

    def test_format(self):
        out = self.gen("--story", "US-001", "--title", "Valid user can sign in")
        self.assertRegex(out["id"], r"^AUTO-[0-9a-f]{8}$")

    def test_deterministic_across_runs(self):
        a = self.gen("--story", "US-001", "--title", "Valid user can sign in")
        b = self.gen("--story", "US-001", "--title", "Valid user can sign in")
        self.assertEqual(a["id"], b["id"])

    def test_known_value_never_changes(self):
        # Pins the algorithm: sha256("US-001|valid user can sign in")[:8]. Changing it would
        # re-ID every previously generated case.
        self.assertEqual(self.gen("--story", "US-001", "--title", "Valid user can sign in")["id"], "AUTO-ea4e94fb")

    def test_case_spacing_and_punctuation_do_not_matter(self):
        a = self.gen("--story", "US-001", "--title", "Valid user can sign in")
        b = self.gen("--story", "us-001", "--title", "  VALID user, can sign-in!! ")
        self.assertEqual(a["id"], b["id"])

    def test_different_story_or_title_gives_different_id(self):
        base = self.gen("--story", "US-001", "--title", "Valid user can sign in")["id"]
        self.assertNotEqual(base, self.gen("--story", "US-002", "--title", "Valid user can sign in")["id"])
        self.assertNotEqual(base, self.gen("--story", "US-001", "--title", "Invalid user cannot sign in")["id"])

    def test_story_order_does_not_matter(self):
        a = self.gen("--story", "US-001", "--story", "US-002", "--title", "Journey")
        b = self.gen("--story", "US-002", "--story", "US-001", "--title", "Journey")
        self.assertEqual(a["id"], b["id"])

    def test_batch_mode(self):
        batch = self.write("b.json", json.dumps([{"storyIds": ["US-001"], "title": "One"},
                                                 {"storyIds": ["US-001"], "title": "Two"}]))
        code, out = run("generate-stable-id.py", "--batch", batch)
        ids = [r["id"] for r in out["results"]]
        self.assertEqual(len(set(ids)), 2)

    def test_existing_scenario_is_reported_as_existing(self):
        first = self.gen("--story", "US-001", "--title", "One")
        trace = self.write("t.json", json.dumps({"cases": {first["id"]: {"scenarioKey": first["scenarioKey"]}}}))
        again = self.gen("--story", "US-001", "--title", "One", "--traceability", trace)
        self.assertTrue(again["exists"])
        self.assertEqual(again["id"], first["id"])

    def test_collision_with_a_different_scenario_is_salted_deterministically(self):
        first = self.gen("--story", "US-001", "--title", "One")
        trace = self.write("t.json", json.dumps({"cases": {first["id"]: {"scenarioKey": "SOMETHING|else"}}}))
        a = self.gen("--story", "US-001", "--title", "One", "--traceability", trace)
        b = self.gen("--story", "US-001", "--title", "One", "--traceability", trace)
        self.assertNotEqual(a["id"], first["id"])
        self.assertTrue(a["collisionResolved"])
        self.assertEqual(a["id"], b["id"])
        self.assertRegex(a["id"], r"^AUTO-[0-9a-f]{8}$")

    def test_missing_arguments_are_a_usage_error(self):
        code, out = run("generate-stable-id.py", "--story", "US-001")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()

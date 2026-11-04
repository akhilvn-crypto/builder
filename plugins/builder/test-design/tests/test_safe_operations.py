import json
import unittest

from helpers import TempProject, case, run, td

SAFE = "safe-file-operations.py"


def draft(*blocks, module="Login"):
    return f"# {module}\n\n" + "\n".join(blocks)


class SafeOperations(TempProject):
    def merge(self, text, *extra, name="d.md"):
        d = self.write(name, text)
        return run(SAFE, "merge-cases", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                   "--source", d, *extra)

    def sha(self):
        return td.sha256_file(self.cases_path)

    # ---- merge-cases
    def test_first_merge_creates_file_without_backup(self):
        code, out = self.merge(draft(case("TC-1", "A")))
        self.assertEqual((code, out["ok"], out["added"], out["backup"]), (0, True, ["TC-1"], None))
        self.assertTrue(self.cases_path.is_file())

    def test_second_merge_appends_to_existing_module_and_keeps_backup(self):
        self.merge(draft(case("TC-1", "A")))
        before = self.cases_path.read_text(encoding="utf-8")
        code, out = self.merge(draft(case("TC-2", "B", step="Open b")), "--expect-sha256", self.sha())
        self.assertEqual(code, 0, out)
        after = self.cases_path.read_text(encoding="utf-8")
        self.assertTrue(after.startswith(before.rstrip("\n")))  # existing text untouched, new case appended
        self.assertEqual(after.count("# Login"), 1)
        self.assertIsNotNone(out["backup"])
        self.assertEqual(td.read_text(__import__("pathlib").Path(out["backup"])), before)

    def test_case_is_inserted_at_end_of_its_own_module_not_end_of_file(self):
        self.merge(draft(case("TC-1", "A")) + "\n# Other\n\n" + case("TC-5", "Z", step="Open z"))
        self.merge(draft(case("TC-2", "B", step="Open b")))
        doc = td.parse_test_cases(self.cases_path.read_text(encoding="utf-8"))
        self.assertEqual([(c.id, c.module) for c in doc.cases],
                         [("TC-1", "Login"), ("TC-2", "Login"), ("TC-5", "Other")])

    def test_new_module_appended(self):
        self.merge(draft(case("TC-1", "A")))
        code, out = self.merge(draft(case("TC-2", "B", step="Open b"), module="Billing"))
        self.assertEqual(out["placement"]["newModules"], ["Billing"])

    def test_moduleless_case_goes_under_general(self):
        code, out = self.merge(case("TC-1", "A"))
        self.assertEqual(out["placement"]["general"], ["TC-1"])
        self.assertIn("# General", self.cases_path.read_text(encoding="utf-8"))

    def test_hand_edits_survive_and_are_reported(self):
        self.merge(draft(case("TC-1", "A")))
        known = self.sha()
        edited = self.cases_path.read_text(encoding="utf-8").replace("Open the page", "Open the sign-in page  (edited by hand)")
        self.cases_path.write_text(edited, encoding="utf-8")
        code, out = self.merge(draft(case("TC-2", "B", step="Open b")), "--expect-sha256", known)
        self.assertEqual(code, 0, out)
        self.assertTrue(out["userEditsDetected"])
        self.assertIn("edited by hand", self.cases_path.read_text(encoding="utf-8"))

    def test_id_conflict_fails_without_writing(self):
        self.merge(draft(case("TC-1", "A")))
        snap = self.cases_path.read_bytes()
        code, out = self.merge(draft(case("TC-1", "Changed", step="Open different")))
        self.assertEqual((code, out["error"]["code"], out["conflicts"]), (3, "ID_CONFLICT", ["TC-1"]))
        self.assertEqual(self.cases_path.read_bytes(), snap)

    def test_conflict_skip_adds_only_new_cases(self):
        self.merge(draft(case("TC-1", "A")))
        code, out = self.merge(draft(case("TC-1", "A"), case("TC-2", "B", step="Open b")), "--on-conflict", "skip")
        self.assertEqual((code, out["added"], out["skippedExisting"]), (0, ["TC-2"], ["TC-1"]))
        self.assertEqual(self.cases_path.read_text(encoding="utf-8").count("## TC-1"), 1)

    def test_conflict_skip_with_everything_existing_is_a_noop(self):
        self.merge(draft(case("TC-1", "A")))
        snap = self.cases_path.read_bytes()
        code, out = self.merge(draft(case("TC-1", "A")), "--on-conflict", "skip")
        self.assertEqual((code, out["added"]), (0, []))
        self.assertEqual(self.cases_path.read_bytes(), snap)

    def test_invalid_draft_is_never_written(self):
        code, out = self.merge(draft("## TC-1: T\n\n### Steps\n1. Click #go\n"))
        self.assertEqual((code, out["error"]["code"]), (1, "VALIDATION"))
        self.assertFalse(self.cases_path.exists())
        self.assertGreater(out["errors"], 0)

    def test_draft_dependency_may_target_a_saved_case(self):
        self.merge(draft(case("TC-1", "A")))
        code, out = self.merge(draft(case("TC-2", "B", step="Open b", extra="Depends on: TC-1")))
        self.assertEqual(code, 0, out)

    def test_target_changed_by_someone_else_between_read_and_write(self):
        self.merge(draft(case("TC-1", "A")))
        code, out = self.merge(draft(case("TC-2", "B", step="Open b")), "--expect-sha256", "0" * 64)
        # The hash differs: appending is still safe (nothing is overwritten) and is flagged.
        self.assertTrue(out["userEditsDetected"])

    def test_deleted_output_is_not_assumed_complete(self):
        code, out = self.merge(draft(case("TC-1", "A")), "--expect-sha256", "a" * 64)
        self.assertEqual((code, out["error"]["code"]), (4, "MISSING"))

    def test_crlf_target_keeps_crlf(self):
        self.merge(draft(case("TC-1", "A")))
        raw = self.cases_path.read_bytes().replace(b"\n", b"\r\n")
        self.cases_path.write_bytes(raw)
        self.merge(draft(case("TC-2", "B", step="Open b")))
        data = self.cases_path.read_bytes()
        self.assertEqual(data.count(b"\n"), data.count(b"\r\n"))

    # ---- replace-case
    def test_replace_case_needs_consent_and_hash(self):
        self.merge(draft(case("TC-1", "A")))
        d = self.write("r.md", draft(case("TC-1", "A v2", step="Open the new page")))
        base = ["replace-case", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                "--id", "TC-1", "--source", d, "--expect-sha256", self.sha()]
        code, out = run(SAFE, *base)
        self.assertEqual((code, out["error"]["code"]), (2, "CONSENT_REQUIRED"))
        self.assertIn("## TC-1: A\n", self.cases_path.read_text(encoding="utf-8"))
        code, out = run(SAFE, *base, "--yes")
        self.assertEqual(code, 0, out)
        text = self.cases_path.read_text(encoding="utf-8")
        self.assertIn("A v2", text)
        self.assertNotIn("## TC-1: A\n", text)
        self.assertIsNotNone(out["backup"])

    def test_replace_case_leaves_other_cases_alone(self):
        self.merge(draft(case("TC-1", "A"), case("TC-2", "B", step="Open b")))
        d = self.write("r.md", draft(case("TC-1", "A v2", step="Open the new page")))
        run(SAFE, "replace-case", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
            "--id", "TC-1", "--source", d, "--expect-sha256", self.sha(), "--yes")
        doc = td.parse_test_cases(self.cases_path.read_text(encoding="utf-8"))
        self.assertEqual([c.id for c in doc.cases], ["TC-1", "TC-2"])
        self.assertEqual(doc.cases[1].title, "B")

    def test_replace_with_stale_hash_refused(self):
        self.merge(draft(case("TC-1", "A")))
        d = self.write("r.md", draft(case("TC-1", "A v2", step="Open the new page")))
        code, out = run(SAFE, "replace-case", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                        "--id", "TC-1", "--source", d, "--expect-sha256", "f" * 64, "--yes")
        self.assertEqual((code, out["error"]["code"]), (3, "CONFLICT"))

    def test_replace_unknown_id(self):
        self.merge(draft(case("TC-1", "A")))
        d = self.write("r.md", draft(case("TC-7", "X")))
        code, out = run(SAFE, "replace-case", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                        "--id", "TC-7", "--source", d, "--expect-sha256", self.sha(), "--yes")
        self.assertEqual((code, out["error"]["code"]), (4, "CASE_NOT_FOUND"))

    # ---- write
    def test_write_refuses_existing_target_without_permission(self):
        a = self.write("a.json", "{}")
        args = ["write", "--root", self.root, "--target", "test-design/state/x.json", "--source", a]
        self.assertEqual(run(SAFE, *args)[0], 0)
        code, out = run(SAFE, *args)
        self.assertEqual((code, out["error"]["code"]), (3, "EXISTS"))
        self.assertEqual(run(SAFE, *args, "--allow-overwrite")[0], 0)

    def test_write_validates_cases_before_writing(self):
        bad = self.write("bad.md", "# M\n## TC-1: T\n")
        code, out = run(SAFE, "write", "--root", self.root, "--target", "test-design/test-cases/test-cases.md",
                        "--source", bad, "--validate-cases")
        self.assertEqual((code, out["error"]["code"]), (1, "VALIDATION"))
        self.assertFalse(self.cases_path.exists())

    def test_write_rejects_secret_content(self):
        s = self.write("s.md", "token = abcdef123456\n")
        code, out = run(SAFE, "write", "--root", self.root, "--target", "test-design/state/n.md", "--source", s)
        self.assertEqual((code, out["error"]["code"]), (1, "SECRET_DETECTED"))
        self.assertNotIn("abcdef123456", json.dumps(out))

    # ---- confinement
    def test_cannot_write_outside_output_dir(self):
        story = self.root / "stories" / "profile.md"
        before = story.read_bytes()
        a = self.write("a.md", "# replaced\n")
        for target in ("stories/profile.md", "../escape.md", str(story), "test-design/../stories/profile.md"):
            code, out = run(SAFE, "write", "--root", self.root, "--target", target, "--source", a, "--allow-overwrite")
            self.assertEqual((code, out["error"]["code"]), (5, "OUTSIDE_OUTPUT_DIR"), target)
        self.assertEqual(story.read_bytes(), before)
        self.assertFalse((self.root.parent / "escape.md").exists())

    # ---- merge-json
    def patch(self, target, obj, *extra):
        p = self.write("p.json", json.dumps(obj))
        return run(SAFE, "merge-json", "--root", self.root, "--target", target, "--patch-file", p, *extra)

    WF = {"version": 1, "runId": "run-20260101-000000", "status": "in_progress", "projectRoot": "/p",
          "sourceFiles": ["a.md"], "currentPhase": "discover", "currentStoryId": None,
          "stories": {"US-001": {"status": "pending"}}, "createdAt": "t", "updatedAt": "t"}

    def test_merge_json_create_update_and_delete_key(self):
        t = "test-design/state/workflow.json"
        code, out = self.patch(t, self.WF, "--create", "--schema", "workflow-state")
        self.assertEqual(code, 0, out)
        code, out = self.patch(t, {"currentPhase": "design", "stories": {"US-001": {"status": "saved"}}, "currentStoryId": "US-001"},
                               "--schema", "workflow-state", "--touch", "updatedAt")
        self.assertEqual(code, 0, out)
        data = json.loads((self.root / t).read_text(encoding="utf-8"))
        self.assertEqual((data["currentPhase"], data["stories"]["US-001"]["status"], data["projectRoot"]),
                         ("design", "saved", "/p"))
        self.assertNotEqual(data["updatedAt"], "t")
        code, out = self.patch(t, {"currentStoryId": None}, "--schema", "workflow-state")
        self.assertEqual(code, 0, out)

    def test_merge_json_rejects_schema_violations_without_writing(self):
        t = "test-design/state/workflow.json"
        self.patch(t, self.WF, "--create", "--schema", "workflow-state")
        snap = (self.root / t).read_bytes()
        code, out = self.patch(t, {"status": "nonsense"}, "--schema", "workflow-state")
        self.assertEqual((code, out["error"]["code"]), (1, "SCHEMA"))
        self.assertEqual((self.root / t).read_bytes(), snap)

    def test_corrupt_state_is_never_overwritten(self):
        t = self.write("test-design/state/workflow.json", "{broken")
        code, out = self.patch("test-design/state/workflow.json", {"status": "completed"})
        self.assertEqual((code, out["error"]["code"]), (4, "STATE_CORRUPT"))
        self.assertEqual(t.read_text(encoding="utf-8"), "{broken")

    def test_merge_json_missing_target_needs_create(self):
        code, out = self.patch("test-design/state/workflow.json", {"a": 1})
        self.assertEqual((code, out["error"]["code"]), (4, "MISSING"))

    # ---- audit log
    def test_append_jsonl_appends_lines_and_adds_timestamp(self):
        for i in range(2):
            code, out = run(SAFE, "append-jsonl", "--root", self.root, "--target", "test-design/state/audit.jsonl",
                            "--entry", json.dumps({"event": "story_saved", "storyId": f"US-00{i}"}))
            self.assertEqual(code, 0, out)
        lines = (self.root / "test-design/state/audit.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("ts", json.loads(lines[0]))

    def test_append_jsonl_repairs_missing_trailing_newline(self):
        p = self.write("test-design/state/audit.jsonl", '{"event":"a"}')
        run(SAFE, "append-jsonl", "--root", self.root, "--target", "test-design/state/audit.jsonl", "--entry", '{"event":"b"}')
        self.assertEqual(len(p.read_text(encoding="utf-8").splitlines()), 2)

    def test_audit_entry_with_secret_is_refused(self):
        code, out = run(SAFE, "append-jsonl", "--root", self.root, "--target", "test-design/state/audit.jsonl",
                        "--entry", json.dumps({"event": "x", "password": "hunter2hunter2"}))
        self.assertEqual((code, out["error"]["code"]), (1, "SECRET_DETECTED"))
        self.assertFalse((self.root / "test-design/state/audit.jsonl").exists())

    # ---- access + hash
    def test_check_access_and_hash(self):
        code, out = run(SAFE, "check-access", "--root", self.root, "--source", self.root / "stories" / "profile.md")
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertFalse((self.root / "test-design").exists())  # probing must not create the output folder
        code, out = run(SAFE, "check-access", "--root", self.root, "--source", self.root / "nope.md")
        self.assertEqual((code, out["ok"]), (6, False))
        f = self.write("h.txt", "abc")
        code, out = run(SAFE, "hash", f, self.root / "missing")
        self.assertEqual(out["hashes"][str(f)], td.sha256_text("abc"))
        self.assertIsNone(out["hashes"][str(self.root / "missing")])


if __name__ == "__main__":
    unittest.main()

"""Isolated story analysis: minimal worker input, output validation, checkpoints, resume, selective invalidation.

These tests cover everything the plugin's scripts can guarantee deterministically. Whether the Claude runtime
really gives each ``story-analyser`` call a fresh context is a property of how the orchestrator invokes it
(one ``Agent`` call per story, never continued); the static tests at the bottom pin that contract in the agent
definitions and the audit test checks the evidence the orchestrator leaves behind.
"""
import hashlib
import json
import re
import unittest

from helpers import PLUGIN, PLUGIN_ROOT, TempProject, run, td

SHOP = """# Shop

## US-101 - Sign in to the shop

As a shopper I want to sign in so that I can see my orders.

**Acceptance Criteria:**
- Valid credentials open the orders page.
- A wrong password shows "Invalid email or password".

## US-102 - View order history

As a signed-in shopper I want to see past orders.

**Acceptance Criteria:**
- The orders page lists the five most recent orders.

**Dependencies:** US-101 (Sign in to the shop): the shopper must be signed in first.
"""

CART = """# Cart

## US-103 - Add item to cart

As a shopper I want to add an item to the cart.

**Acceptance Criteria:**
- Adding an item increases the cart count by one.
"""

RULES = """# Shared rules

## Password policy

Passwords are 8 to 64 characters.

## Currency

All prices are shown in EUR.
"""

STORIES = {"US-101": "stories/shop.md", "US-102": "stories/shop.md", "US-103": "stories/cart.md"}


def valid_result(sid, **over):
    r = {"story_id": sid, "story_summary": f"Summary of {sid}", "behaviour_to_validate": [f"Behaviour of {sid}"],
         "acceptance_criteria_interpretation": [{"label": "AC-1", "text": "Does the thing"}],
         "analysis_complete": True}
    r.update(over)
    return r


class IsolatedAnalysis(TempProject):
    def setUp(self):
        super().setUp()
        self.write("stories/shop.md", SHOP)
        self.write("stories/cart.md", CART)
        self.write("stories/rules.md", RULES)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.set_workflow()

    # ---- helpers
    @property
    def wf_path(self):
        return self.root / "test-design" / "state" / "workflow.json"

    def set_workflow(self, rules_file=None, statuses=None):
        wf = {"version": 1, "runId": "run-20260101-120000", "status": "in_progress", "projectRoot": str(self.root),
              "sourceFiles": ["stories/shop.md", "stories/cart.md"], "currentPhase": "analyse", "currentStoryId": None,
              "stories": {sid: {"status": (statuses or {}).get(sid, "pending"), "sourceFile": f, "testCaseIds": []}
                          for sid, f in STORIES.items()},
              "createdAt": "2026-01-01T12:00:00Z", "updatedAt": "2026-01-01T12:00:00Z"}
        if rules_file:
            wf["sharedRulesFile"] = rules_file
        self.assertEqual(td.validate_json(wf, td.load_schema("workflow-state")), [])
        self.wf_path.parent.mkdir(parents=True, exist_ok=True)
        self.wf_path.write_text(json.dumps(wf, indent=2), encoding="utf-8")

    def wf(self):
        return json.loads(self.wf_path.read_text(encoding="utf-8"))

    def cli(self, cmd, *args):
        return run("story-analysis-state.py", cmd, "--root", self.root, *args)

    def begin(self, sid, *args):
        out = self.scratch / f"input-{sid}.json"
        code, res = self.cli("begin", "--story-id", sid, "--output", out, *args)
        self.assertEqual(code, 0, res)
        return json.loads(out.read_text(encoding="utf-8")), out, res

    def finish(self, sid, inp_path, result, worker_ref=None):
        rf = self.scratch / f"result-{sid}.json"
        rf.write_text(result if isinstance(result, str) else json.dumps(result), encoding="utf-8")
        extra = ["--worker-ref", worker_ref] if worker_ref else []
        return self.cli("complete", "--story-id", sid, "--input", inp_path, "--result", rf, *extra)

    def analyse(self, sid, *args, ref=None):
        inp, path, _ = self.begin(sid, *args)
        code, res = self.finish(sid, path, valid_result(sid), ref or f"worker-{sid}")
        self.assertEqual(code, 0, res)
        return inp

    def plan(self, *args):
        code, res = self.cli("plan", *args)
        self.assertEqual(code, 0, res)
        return {r["storyId"]: r for r in res["stories"]}, res

    def audit(self):
        p = self.root / "test-design" / "state" / "audit.jsonl"
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()] if p.is_file() else []

    def sha(self, p):
        return hashlib.sha256(p.read_bytes()).hexdigest()


class WorkerInput(IsolatedAnalysis):
    def test_input_holds_exactly_one_story_and_the_contract_keys(self):
        inp, _, res = self.begin("US-101")
        self.assertEqual(set(inp), {"run_id", "story_id", "story_content", "relevant_shared_rules", "dependency_context",
                                    "analysis_instructions", "output_schema_version"})
        self.assertEqual(inp["output_schema_version"], 2)
        self.assertEqual(inp["relevant_shared_rules"], [])
        self.assertEqual(inp["dependency_context"], [])
        self.assertIn("Valid credentials open the orders page", inp["story_content"])
        for other in ("US-102", "US-103", "five most recent orders", "Adding an item"):
            self.assertNotIn(other, inp["story_content"])
        self.assertEqual(res["dependencies"], [])

    def test_a_story_in_the_middle_of_a_file_does_not_include_its_neighbours(self):
        inp, _, _ = self.begin("US-102", "--no-auto-dependencies")
        self.assertIn("five most recent orders", inp["story_content"])
        self.assertNotIn("Valid credentials", inp["story_content"])
        self.assertEqual(inp["dependency_context"], [])

    def test_explicit_dependency_is_a_small_read_only_excerpt_and_nothing_else(self):
        inp, _, res = self.begin("US-102")
        self.assertEqual(res["dependencies"], ["US-101"])
        (dep,) = inp["dependency_context"]
        self.assertEqual((dep["story_id"], dep["read_only"]), ("US-101", True))
        self.assertIn("Valid credentials", dep["excerpt"])
        self.assertNotIn("US-103", json.dumps(inp))
        self.assertNotIn("Adding an item", json.dumps(inp))

    def test_excerpt_is_truncated_to_the_limit(self):
        self.write("stories/shop.md", SHOP.replace("- Valid credentials open the orders page.",
                                                   "\n".join(f"- Extra criterion number {i} of the sign-in." for i in range(80))))
        inp, _, _ = self.begin("US-102", "--max-excerpt-chars", "300")
        self.assertLessEqual(len(inp["dependency_context"][0]["excerpt"]), 400)
        self.assertIn("truncated", inp["dependency_context"][0]["excerpt"])

    def test_previous_analysis_never_reaches_the_next_worker(self):
        _, path, _ = self.begin("US-101")
        self.finish("US-101", path, valid_result("US-101", story_summary="UNIQUE-ANALYSIS-MARKER-7731"))
        # US-101 is the dependency of US-102, but only its source excerpt is given, never its analysis
        inp, _, _ = self.begin("US-102")
        blob = json.dumps(inp)
        self.assertNotIn("UNIQUE-ANALYSIS-MARKER-7731", blob)
        self.assertNotIn("behaviour_to_validate", blob)

    def test_only_selected_shared_rules_are_passed(self):
        self.set_workflow(rules_file="stories/rules.md")
        inp, _, res = self.begin("US-101", "--rule-id", "password-policy")
        self.assertEqual([r["rule_id"] for r in inp["relevant_shared_rules"]], ["password-policy"])
        self.assertIn("8 to 64", inp["relevant_shared_rules"][0]["text"])
        self.assertNotIn("EUR", json.dumps(inp))

    def test_unknown_rule_or_dependency_is_refused_and_no_worker_state_is_written(self):
        self.set_workflow(rules_file="stories/rules.md")
        for args in (["--rule-id", "nope"], ["--dependency", "US-999"]):
            code, res = self.cli("begin", "--story-id", "US-101", "--output", self.scratch / "x.json", *args)
            self.assertEqual(code, 2, res)
        self.assertNotIn("analysis", self.wf()["stories"]["US-101"])

    def test_input_must_not_be_written_into_the_output_folder(self):
        code, res = self.cli("begin", "--story-id", "US-101", "--output", self.root / "test-design" / "x.json")
        self.assertEqual((code, res["error"]["code"]), (2, "BAD_OUTPUT"))

    def test_source_stories_are_never_modified(self):
        before = {p.name: self.sha(p) for p in (self.root / "stories").glob("*.md")}
        for sid in STORIES:
            self.analyse(sid)
        self.assertEqual({p.name: self.sha(p) for p in (self.root / "stories").glob("*.md")}, before)


class IsolationGuard(IsolatedAnalysis):
    def check(self, mutate):
        inp, path, _ = self.begin("US-102")
        mutate(inp)
        path.write_text(json.dumps(inp), encoding="utf-8")
        return run("story-analysis-state.py", "check-input", "--input", path)

    def test_untouched_input_passes(self):
        code, res = self.check(lambda i: None)
        self.assertEqual((code, res["errors"]), (0, []))

    def test_workflow_state_or_transcripts_are_rejected(self):
        for extra in ("workflow_state", "previous_transcript", "all_stories"):
            code, res = self.check(lambda i, k=extra: i.update({k: {"x": 1}}))
            self.assertEqual(code, 1, extra)
            self.assertTrue(any(extra in e for e in res["errors"]), res)

    def test_two_stories_in_one_input_are_rejected(self):
        code, res = self.check(lambda i: i.update(story_content=i["story_content"] + "\n\n" + CART.split("\n", 2)[2]))
        self.assertEqual(code, 1)
        self.assertTrue(any("exactly one story" in e for e in res["errors"]), res)

    def test_content_of_a_different_story_is_rejected(self):
        code, res = self.check(lambda i: i.update(story_id="US-103"))
        self.assertEqual(code, 1)
        self.assertTrue(any("not the requested" in e for e in res["errors"]), res)

    def test_dependency_excerpt_spanning_stories_or_the_story_itself_is_rejected(self):
        code, res = self.check(lambda i: i["dependency_context"][0].update(excerpt=SHOP))
        self.assertEqual(code, 1)
        code, res = self.check(lambda i: i["dependency_context"][0].update(story_id="US-102"))
        self.assertEqual(code, 1)

    def test_writable_dependency_is_rejected(self):
        code, _ = self.check(lambda i: i["dependency_context"][0].update(read_only=False))
        self.assertEqual(code, 1)

    def test_secret_in_input_is_rejected(self):
        code, res = self.check(lambda i: i.update(story_content=i["story_content"] + '\n"password": "hunter2hunter2"\n'))
        self.assertEqual(code, 1)
        self.assertTrue(any("secret" in e for e in res["errors"]), res)


class OutputValidation(IsolatedAnalysis):
    def rejected(self, result, why=None):
        inp, path, _ = self.begin("US-101")
        code, res = self.finish("US-101", path, result)
        self.assertEqual(code, 1, res)
        self.assertEqual(res["error"]["code"], "INVALID_WORKER_OUTPUT")
        if why:
            self.assertTrue(any(why in e for e in res["errors"]), res["errors"])
        an = self.wf()["stories"]["US-101"]["analysis"]
        self.assertEqual(an["status"], "failed")
        self.assertNotIn("resultPath", an)
        self.assertNotEqual(self.wf()["stories"]["US-101"].get("lastCompletedStage"), "analyse")
        self.assertFalse((self.root / "test-design" / "state" / "analysis" / "US-101.json").exists())
        self.assertEqual(self.audit()[-1]["event"], "analysis_failed")

    def test_valid_result_is_persisted_and_checkpointed(self):
        inp, path, _ = self.begin("US-101")
        code, res = self.finish("US-101", path, valid_result("US-101", business_rules=[{"label": "BR-1", "text": "Rule"}]))
        self.assertEqual(code, 0, res)
        self.assertEqual(res["criteriaLabels"], ["AC-1", "BR-1"])
        st = self.wf()["stories"]["US-101"]
        self.assertEqual((st["analysis"]["status"], st["lastCompletedStage"]), ("completed", "analyse"))
        rec = json.loads((self.root / st["analysis"]["resultPath"].replace("test-design/", "test-design/", 1)).read_text(encoding="utf-8"))
        self.assertEqual(td.validate_json(rec, td.load_schema("story-analysis-record")), [])
        code, shown = self.cli("show", "--story-id", "US-101")
        self.assertEqual((code, shown["result"]["story_id"]), (0, "US-101"))

    def test_fenced_json_is_accepted(self):
        _, path, _ = self.begin("US-101")
        code, _ = self.finish("US-101", path, "```json\n" + json.dumps(valid_result("US-101")) + "\n```")
        self.assertEqual(code, 0)

    def test_malformed_and_prose_outputs_are_rejected(self):
        self.rejected("Here is my analysis: it looks fine.", "not valid JSON")

    def test_result_for_another_story_is_rejected(self):
        self.rejected(valid_result("US-102"), "this invocation was for")

    def test_missing_required_field_is_rejected(self):
        r = valid_result("US-101")
        del r["story_summary"]
        self.rejected(r, "story_summary")

    def test_partial_analysis_is_rejected(self):
        self.rejected(valid_result("US-101", analysis_complete=False), "analysis_complete")

    def test_unknown_field_and_bad_label_are_rejected(self):
        self.rejected(valid_result("US-101", full_transcript="..."), "full_transcript")

    def test_bad_label_is_rejected(self):
        self.rejected(valid_result("US-101", acceptance_criteria_interpretation=[{"label": "X1", "text": "t"}]), "pattern")

    def test_duplicate_labels_are_rejected(self):
        self.rejected(valid_result("US-101", acceptance_criteria_interpretation=[{"label": "AC-1", "text": "a"}, {"label": "AC-1", "text": "b"}]),
                      "not unique")

    def test_testable_story_needs_behaviour(self):
        self.rejected(valid_result("US-101", behaviour_to_validate=[]), "behaviour_to_validate")

    def test_not_testable_needs_a_reason_and_may_have_no_behaviour(self):
        self.rejected(valid_result("US-101", behaviour_to_validate=[], testable=False), "not_testable_reason")

    def test_not_testable_with_reason_is_accepted(self):
        _, path, _ = self.begin("US-101")
        code, res = self.finish("US-101", path, valid_result("US-101", behaviour_to_validate=[], acceptance_criteria_interpretation=[],
                                                              testable=False, not_testable_reason="placeholder heading only"))
        self.assertEqual((code, res["testable"]), (0, False))

    def test_secret_in_result_is_rejected(self):
        self.rejected(valid_result("US-101", messages=['"password": "hunter2hunter2"']), "secret")

    def test_blocking_ambiguity_is_reported_not_swallowed(self):
        _, path, _ = self.begin("US-101")
        amb = [{"question": "How long is the lock?", "blocking": True, "blocks": ["AC-2"]}, {"question": "Colour?", "blocking": False}]
        code, res = self.finish("US-101", path, valid_result("US-101", ambiguities=amb))
        self.assertEqual((code, res["blockingAmbiguities"]), (0, 1))

    def test_story_changed_during_analysis_is_rejected(self):
        _, path, _ = self.begin("US-101")
        self.write("stories/shop.md", SHOP.replace("Valid credentials open", "Valid credentials now open"))
        code, res = self.finish("US-101", path, valid_result("US-101"))
        self.assertEqual(code, 1)
        self.assertTrue(any("changed while" in e for e in res["errors"]), res)

    def test_complete_without_begin_is_refused(self):
        rf = self.scratch / "r.json"
        rf.write_text(json.dumps(valid_result("US-101")), encoding="utf-8")
        code, res = self.cli("complete", "--story-id", "US-101", "--input", rf, "--result", rf)
        self.assertEqual((code, res["error"]["code"]), (3, "NOT_IN_PROGRESS"))

    def test_worker_crash_is_recorded_as_a_story_failure(self):
        self.begin("US-101")
        code, _ = self.cli("fail", "--story-id", "US-101", "--reason", "worker timed out")
        self.assertEqual(code, 0)
        an = self.wf()["stories"]["US-101"]["analysis"]
        self.assertEqual((an["status"], an["failure"]["reason"]), ("failed", "worker timed out"))

    def test_schema_documents_the_agreed_fields(self):
        props = set(td.load_schema("story-analysis")["properties"])
        for key in ("story_id", "story_summary", "behaviour_to_validate", "acceptance_criteria_interpretation", "business_rules",
                    "preconditions", "dependencies", "relevant_non_functional_expectations", "test_design_considerations",
                    "ambiguities", "analysis_complete"):
            self.assertIn(key, props)


class ResumeAndInvalidation(IsolatedAnalysis):
    def test_fresh_run_plans_every_story(self):
        rows, res = self.plan()
        self.assertEqual({r["action"] for r in rows.values()}, {"analyse"})
        self.assertEqual(res["counts"], {"analyse": 3})

    def test_failed_story_is_retried_alone_and_completed_stories_are_not_redone(self):
        self.analyse("US-101")
        self.analyse("US-103")
        _, path, _ = self.begin("US-102")
        self.finish("US-102", path, "not json")
        record = self.root / "test-design" / "state" / "analysis" / "US-101.json"
        before = (self.sha(record), self.wf()["stories"]["US-101"]["analysis"]["attempts"])
        rows, _ = self.plan()
        self.assertEqual({k: v["action"] for k, v in rows.items()}, {"US-101": "reuse", "US-102": "analyse", "US-103": "reuse"})
        self.assertIn("previous_attempt_failed", rows["US-102"]["reasons"])
        self.analyse("US-102")
        self.assertEqual((self.sha(record), self.wf()["stories"]["US-101"]["analysis"]["attempts"]), before)
        self.assertEqual(self.wf()["stories"]["US-102"]["analysis"]["attempts"], 2)
        rows, res = self.plan()
        self.assertEqual(res["counts"], {"reuse": 3})

    def test_interrupted_analysis_is_redone(self):
        self.begin("US-101")
        rows, _ = self.plan()
        self.assertEqual((rows["US-101"]["action"], rows["US-101"]["reasons"]), ("analyse", ["interrupted"]))

    def test_changed_story_invalidates_it_and_its_dependants_only(self):
        for sid in STORIES:
            self.analyse(sid)
        self.write("stories/shop.md", SHOP.replace("A wrong password shows", "A wrong password displays"))
        rows, res = self.plan("--apply")
        self.assertEqual(rows["US-101"]["action"], "invalidated")
        self.assertIn("story_changed", rows["US-101"]["reasons"])
        self.assertEqual(rows["US-102"]["action"], "invalidated")
        self.assertEqual(rows["US-102"]["reasons"], ["dependency_changed:US-101"])
        self.assertEqual(rows["US-103"]["action"], "reuse")
        wf = self.wf()
        self.assertEqual(wf["stories"]["US-101"]["analysis"]["status"], "not_started")
        self.assertEqual(wf["stories"]["US-103"]["analysis"]["status"], "completed")
        self.assertTrue(any(e["event"] == "analysis_invalidated" and e["storyId"] == "US-101" for e in self.audit()))
        rows, _ = self.plan()
        self.assertEqual({k: v["action"] for k, v in rows.items()}, {"US-101": "analyse", "US-102": "analyse", "US-103": "reuse"})

    def test_plan_without_apply_changes_nothing(self):
        self.analyse("US-103")
        self.write("stories/cart.md", CART.replace("by one", "by two"))  # US-103 text changes
        before = self.sha(self.wf_path)
        rows, res = self.plan()
        self.assertEqual((rows["US-103"]["action"], res["applied"]), ("invalidated", False))
        self.assertEqual(self.sha(self.wf_path), before)

    def test_adding_a_new_story_below_an_analysed_one_invalidates_nothing(self):
        for sid in STORIES:
            self.analyse(sid)
        self.write("stories/cart.md", CART + "\n## US-104 - New story\n\nSomething new.\n")
        _, res = self.plan()
        self.assertEqual(res["counts"], {"reuse": 3})

    def test_shared_rule_change_invalidates_only_stories_that_used_it(self):
        self.set_workflow(rules_file="stories/rules.md")
        self.analyse("US-101", "--rule-id", "password-policy")
        self.analyse("US-102", "--no-auto-dependencies")
        self.analyse("US-103", "--rule-id", "currency")
        self.write("stories/rules.md", RULES.replace("8 to 64", "10 to 64"))
        rows, _ = self.plan("--apply")
        self.assertEqual(rows["US-101"]["reasons"], ["shared_rule_changed:password-policy"])
        self.assertEqual((rows["US-102"]["action"], rows["US-103"]["action"]), ("reuse", "reuse"))

    def test_removed_shared_rule_invalidates_its_users(self):
        self.set_workflow(rules_file="stories/rules.md")
        self.analyse("US-103", "--rule-id", "currency")
        self.write("stories/rules.md", "# Shared rules\n\n## Password policy\n\nPasswords are 8 to 64 characters.\n")
        rows, _ = self.plan()
        self.assertEqual(rows["US-103"]["reasons"], ["shared_rule_removed:currency"])

    def test_formatting_only_change_to_shared_rules_file_keeps_analyses(self):
        self.set_workflow(rules_file="stories/rules.md")
        self.analyse("US-103", "--rule-id", "currency")
        self.write("stories/rules.md", RULES.replace("Currency\n", "Currency   \n").replace("EUR.", "EUR.  "))
        rows, _ = self.plan()
        self.assertEqual(rows["US-103"]["action"], "reuse")

    def test_missing_or_tampered_saved_result_is_not_reused(self):
        self.analyse("US-103")
        rec = self.root / "test-design" / "state" / "analysis" / "US-103.json"
        data = json.loads(rec.read_text(encoding="utf-8"))
        data["inputFingerprint"] = "0" * 64
        rec.write_text(json.dumps(data), encoding="utf-8")
        rows, _ = self.plan()
        self.assertEqual(rows["US-103"]["action"], "invalidated")
        self.assertIn("saved_result_missing_or_invalid", rows["US-103"]["reasons"])
        rec.unlink()
        code, res = self.cli("show", "--story-id", "US-103")
        self.assertEqual((code, res["error"]["code"]), (4, "RESULT_MISSING"))

    def test_story_saved_by_an_older_version_is_left_alone(self):
        self.set_workflow(statuses={"US-101": "saved"})
        rows, _ = self.plan()
        self.assertEqual((rows["US-101"]["action"], rows["US-101"]["reasons"]), ("skip", ["saved_before_isolated_analysis"]))
        self.assertEqual(rows["US-102"]["action"], "analyse")

    def test_skipped_story_is_not_analysed(self):
        self.set_workflow(statuses={"US-103": "skipped"})
        rows, _ = self.plan()
        self.assertEqual(rows["US-103"]["action"], "skip")

    def test_removed_story_is_reported(self):
        self.analyse("US-103")
        self.write("stories/cart.md", "# Cart\n\n## US-999 - Other\n\nx\n")
        rows, _ = self.plan()
        self.assertEqual((rows["US-103"]["action"], rows["US-103"]["reasons"][0]), ("invalidated", "story_missing"))

    def test_corrupt_state_is_reported_and_left_alone(self):
        self.wf_path.write_text("{ not json", encoding="utf-8")
        code, res = self.cli("plan")
        self.assertEqual((code, res["error"]["code"]), (4, "STATE_CORRUPT"))
        self.assertEqual(self.wf_path.read_text(encoding="utf-8"), "{ not json")


class SequentialEvidence(IsolatedAnalysis):
    def test_end_to_end_three_stories_one_worker_each(self):
        seen = {}

        def fake_worker(input_path):
            """A worker only ever sees its own input file."""
            inp = json.loads(input_path.read_text(encoding="utf-8"))
            others = [s for s in STORIES if s != inp["story_id"]]
            text = json.dumps(inp)
            seen[inp["story_id"]] = {o for o in others if o in text}
            return valid_result(inp["story_id"], story_summary=f"{inp['story_id']} only")

        rows, _ = self.plan()
        for sid, row in rows.items():
            self.assertEqual(row["action"], "analyse")
            inp, path, _ = self.begin(sid)
            code, res = self.finish(sid, path, fake_worker(path), f"agent-{sid}")
            self.assertEqual(code, 0, res)
            self.assertEqual(run("story-analysis-state.py", "check-input", "--input", path)[0], 0)
        # only the declared dependency (US-101 for US-102) ever appears in another story's input
        self.assertEqual(seen, {"US-101": set(), "US-102": {"US-101"}, "US-103": set()})
        code, audit = self.cli("check-audit")
        self.assertEqual((code, audit["findings"], audit["started"], audit["ended"], audit["workerRefsSeen"]), (0, [], 3, 3, 3))
        rows, res = self.plan()
        self.assertEqual(res["counts"], {"reuse": 3})
        for sid in STORIES:
            code, shown = self.cli("show", "--story-id", sid)
            self.assertEqual(shown["result"]["story_summary"], f"{sid} only")

    def test_audit_flags_two_workers_running_at_once(self):
        self.begin("US-101")
        self.begin("US-102")
        code, res = self.cli("check-audit")
        self.assertEqual(code, 1)
        self.assertTrue(any("one at a time" in f for f in res["findings"]), res)

    def test_audit_flags_a_reused_worker_session(self):
        for sid in ("US-101", "US-102"):
            self.analyse(sid, "--no-auto-dependencies", ref="same-session")
        code, res = self.cli("check-audit")
        self.assertEqual(code, 1)
        self.assertTrue(any("context reused" in f for f in res["findings"]), res)

    def test_audit_holds_ids_and_counts_but_no_story_text_or_analysis(self):
        self.analyse("US-101")
        blob = (self.root / "test-design" / "state" / "audit.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("Valid credentials", blob)
        self.assertNotIn("Summary of US-101", blob)

    def test_no_transcript_is_stored_anywhere(self):
        self.analyse("US-101")
        files = [p.relative_to(self.root / "test-design").as_posix() for p in (self.root / "test-design").rglob("*") if p.is_file()]
        self.assertEqual(sorted(files), ["state/analysis/US-101.json", "state/audit.jsonl", "state/workflow.json"])


class PluginContract(unittest.TestCase):
    """The definitions that make 'fresh context per story' the only way the orchestrator can call the worker."""

    def read(self, rel):
        return (PLUGIN_ROOT / rel).read_text(encoding="utf-8")

    def frontmatter(self, rel):
        m = re.match(r"---\n(.*?)\n---\n", self.read(rel), re.S)
        return dict(l.split(":", 1) for l in m.group(1).splitlines() if ":" in l)

    def test_a_single_reusable_worker_definition_exists(self):
        agents = {p.name for p in (PLUGIN_ROOT / "agents").glob("*.md")}
        design = {"story-analyser.md", "test-case-generator.md", "test-case-quality-checker.md",
                  "test-coverage-designer.md", "test-design-orchestrator.md"}
        self.assertTrue(design <= agents, design - agents)
        # no per-story agents: the design agents are exactly these five
        self.assertFalse({a for a in agents if a.startswith("story-")} - {"story-analyser.md"})

    def test_worker_cannot_spawn_agents_or_write(self):
        tools = {t.strip() for t in self.frontmatter("agents/story-analyser.md")["tools"].split(",")}
        self.assertFalse(tools & {"Agent", "Write", "Edit", "Bash", "SendMessage"}, tools)

    def test_worker_definition_enforces_one_story_per_invocation(self):
        text = self.read("agents/story-analyser.md").replace("*", "")
        for phrase in ("exactly one story", "fresh", "never go looking", "one JSON object", "other story"):
            self.assertIn(phrase, text)

    def test_orchestrator_invokes_one_fresh_worker_per_story_sequentially(self):
        text = self.read("agents/test-design-orchestrator.md").replace("*", "")
        for phrase in ("story-analysis-state.py", "fresh", "SendMessage", "one worker at a time", "sequential", "Never continue an earlier worker"):
            self.assertIn(phrase, text)
        self.assertNotIn("the paths of the other stories", text)

    def test_orchestrator_does_not_resume_or_fork_workers(self):
        text = self.read("agents/test-design-orchestrator.md")
        self.assertRegex(text, r"(?is)never\W+continue an earlier worker with .SendMessage")
        self.assertRegex(text, r"(?is)never use the .fork. agent type")

    def test_marketplace_and_manifest_versions_match(self):
        manifest = json.loads(self.read(".claude-plugin/plugin.json"))
        market = json.loads((PLUGIN_ROOT.parent.parent / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        (entry,) = [p for p in market["plugins"] if p["name"] == manifest["name"]]
        self.assertEqual(entry["version"], manifest["version"])
        self.assertEqual(manifest["name"], "builder")


if __name__ == "__main__":
    unittest.main()

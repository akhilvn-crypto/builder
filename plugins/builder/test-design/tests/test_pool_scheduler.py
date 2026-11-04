"""The story worker pool: bounded scheduling, worker isolation and ownership, central result ingestion,
retries, crash reconciliation, change detection and the evidence for concurrent execution.

The LLM's part of a worker (analysis, draft, metadata) is simulated here; everything deterministic around it is real.
Whether the Claude runtime really runs the workers concurrently in isolated contexts cannot be shown by a script alone:
``check-pool`` reads the evidence the run leaves behind, and the static tests pin the contract in the agent definitions.
"""
import hashlib
import json
import re
import time
import unittest
from pathlib import Path

from helpers import PLUGIN, PLUGIN_ROOT, TempProject, case, run, td

RUN, WORKER, SAFE = "story-run.py", "story-worker.py", "safe-file-operations.py"

SHOP = """# Shop

## US-101 - Sign in to the shop

As a shopper I want to sign in.

**Acceptance Criteria:**
- Valid credentials open the orders page.

## US-102 - View order history

As a signed-in shopper I want to see past orders.

**Acceptance Criteria:**
- The orders page lists the five most recent orders.

**Dependencies:** US-101 (Sign in to the shop): the shopper must be signed in first.
"""
CART = "# Cart\n\n## US-103 - Add item to cart\n\nAs a shopper I want to add an item.\n\n**Acceptance Criteria:**\n- Adding an item increases the cart count by one.\n"
EXTRA = "# Extra\n\n## US-104 - Wishlist\n\nAs a shopper I want a wishlist.\n\n**Acceptance Criteria:**\n- Adding an item to the wishlist shows it in the list.\n"
RULES = "# Shared rules\n\n## Currency\n\nAll prices are shown in EUR.\n"
STORIES = {"US-101": "stories/shop.md", "US-102": "stories/shop.md", "US-103": "stories/cart.md", "US-104": "stories/extra.md"}
SIGNED = "run-20260101-120000"


def analysis(sid, **over):
    r = {"story_id": sid, "title": f"Story {sid}", "story_summary": f"Summary of {sid}", "behaviour_to_validate": [f"Behaviour of {sid}"],
         "acceptance_criteria_interpretation": [{"label": "AC-1", "text": "Does the thing"}], "analysis_complete": True}
    r.update(over)
    return r


def draft_md(sid, *ids, module="Shop"):
    blocks = [case(cid, f"Scenario {cid}", step=f"Open the page for {cid}") for cid in ids]
    return f"# {module}\nUser Story ID: {sid}\n\n" + "\n".join(blocks)


def meta_json(sid, *ids, covers=None):
    return [{"id": cid, "title": f"Scenario {cid}", "module": "Shop", "storyIds": [sid],
             "covers": [f"{sid}#AC-1"] if covers is None else covers, "techniques": ["positive"], "scenarioKey": f"k-{cid}"} for cid in ids]


class Pool(TempProject):
    def setUp(self):
        super().setUp()
        self.write("stories/shop.md", SHOP)
        self.write("stories/cart.md", CART)
        self.write("stories/extra.md", EXTRA)
        self.write("stories/rules.md", RULES)
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.state = self.root / "test-design" / "state"
        self.write_workflow()

    # ---- fixtures
    def write_workflow(self, rules=None):
        wf = {"version": 1, "runId": SIGNED, "status": "in_progress", "projectRoot": str(self.root),
              "sourceFiles": sorted(set(STORIES.values())), "currentPhase": "generate", "currentStoryId": None,
              "stories": {sid: {"status": "pending", "sourceFile": f, "testCaseIds": []} for sid, f in STORIES.items()},
              "createdAt": "2026-01-01T12:00:00Z", "updatedAt": "2026-01-01T12:00:00Z"}
        if rules:
            wf["sharedRulesFile"] = rules
        self.assertEqual(td.validate_json(wf, td.load_schema("workflow-state")), [])
        (self.state).mkdir(parents=True, exist_ok=True)
        (self.state / "workflow.json").write_text(json.dumps(wf, indent=2), encoding="utf-8")

    def wf(self):
        return json.loads((self.state / "workflow.json").read_text(encoding="utf-8"))

    def set_wf(self, mutate):
        wf = self.wf()
        mutate(wf)
        self.assertEqual(td.validate_json(wf, td.load_schema("workflow-state")), [])
        (self.state / "workflow.json").write_text(json.dumps(wf, indent=2), encoding="utf-8")

    def audit(self):
        p = self.state / "audit.jsonl"
        return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()] if p.is_file() else []

    def trace(self):
        return json.loads((self.state / "traceability.json").read_text(encoding="utf-8"))

    def rc(self, cmd, *args, ok=True):
        code, out = run(RUN, cmd, "--root", self.root, *args)
        if ok:
            self.assertEqual(code, 0, out)
        return code, out

    def nxt(self, *args, ok=True):
        return self.rc("next", "--run-dir", self.scratch, *args, ok=ok)[1]

    def sha(self, p):
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()

    def out_file(self, sid):
        return self.root / "test-design" / "test-cases" / f"{sid}-testcase.md"

    def tree(self):
        out = self.root / "test-design"
        return {p.relative_to(out).as_posix(): self.sha(p) for p in out.rglob("*") if p.is_file()} if out.exists() else {}

    # ---- a simulated worker
    def worker(self, d, *, analysis_obj=None, ids=None, covers=None, draft_text=None, complete=True, conditions=None):
        """Run one dispatched story the way the agent would; returns (exit code, compact reply)."""
        sid, inp = d["storyId"], d["inputPath"]
        code, res = run(WORKER, "begin", "--input", inp)
        self.assertEqual(code, 0, res)
        w = Path(res["scratchDir"])
        w.mkdir(parents=True, exist_ok=True)
        ids = ids or [f"{sid}-T1"]
        (w / "analysis.json").write_text(json.dumps(analysis_obj or analysis(sid)), encoding="utf-8")
        (w / "draft.md").write_text(draft_text if draft_text is not None else draft_md(sid, *ids), encoding="utf-8")
        (w / "draft.meta.json").write_text(json.dumps(meta_json(sid, *ids, covers=covers)), encoding="utf-8")
        args = ["--input", inp, "--analysis", w / "analysis.json", "--draft", w / "draft.md", "--meta", w / "draft.meta.json"]
        if conditions is not None:
            (w / "conditions.json").write_text(json.dumps(conditions), encoding="utf-8")
            args += ["--conditions", w / "conditions.json"]
        return run(WORKER, "complete", *args)

    def run_all(self, d_list, **kw):
        return [self.worker(d, **kw) for d in d_list]

    def finish(self, sid, **kw):
        """Dispatch (if needed), run the worker and ingest; returns the ingest output."""
        out = self.nxt("--stories", sid)
        d = next(x for x in out["dispatched"] if x["storyId"] == sid)
        self.worker(d, **kw)
        return self.rc("ingest", "--story-id", sid, ok=False)[1]


class Scheduling(Pool):
    def test_concurrency_is_bounded_and_the_next_story_starts_when_a_slot_frees(self):
        out = self.nxt("--concurrency", "2")
        self.assertEqual([d["storyId"] for d in out["dispatched"]], ["US-101", "US-102"])
        self.assertEqual((out["running"], out["freeSlots"], out["queued"]), (2, 0, 2))
        self.assertEqual(self.nxt()["dispatched"], [])          # no free slot: nothing starts
        self.worker(out["dispatched"][0])
        self.rc("ingest", "--story-id", "US-101")
        out2 = self.nxt()
        self.assertEqual([d["storyId"] for d in out2["dispatched"]], ["US-103"])   # exactly the freed slot is refilled
        self.assertEqual(out2["running"], 2)

    def test_default_is_five_and_more_than_five_is_refused(self):
        out = self.nxt()
        self.assertEqual(len(out["dispatched"]), len(STORIES))     # the fixture has 4 stories, below the default of 5
        self.assertEqual(self.wf()["scheduler"]["concurrency"], 5)
        code, res = self.rc("configure", "--concurrency", "6", ok=False)
        self.assertEqual((code, res["error"]["code"]), (2, "CONCURRENCY_LIMIT"))
        self.rc("configure", "--concurrency", "5")
        self.assertEqual(self.wf()["scheduler"]["concurrency"], 5)

    def test_a_mentioned_dependency_does_not_delay_a_story_but_a_declared_one_does(self):
        self.rc("configure", "--concurrency", "5", "--depends", "US-103=US-101")
        out = self.nxt()
        ids = [d["storyId"] for d in out["dispatched"]]
        self.assertEqual(ids, ["US-101", "US-102", "US-104"])    # US-102 only mentions US-101: no waiting; US-103 declared: waits
        self.assertEqual(out["attention"], [{"storyId": "US-103", "state": "waiting_dependency", "waitingFor": ["US-101"]}])
        us102 = json.loads(Path(next(d for d in out["dispatched"] if d["storyId"] == "US-102")["inputPath"]).read_text(encoding="utf-8"))
        self.assertEqual([x["story_id"] for x in us102["dependency_context"]], ["US-101"])   # compact read-only excerpt, not a history
        self.worker(out["dispatched"][0])
        self.rc("ingest", "--story-id", "US-101")
        self.assertEqual([d["storyId"] for d in self.nxt()["dispatched"]], ["US-103"])

    def test_dependency_cycles_are_reported_and_do_not_deadlock(self):
        _, res = self.rc("configure", "--depends", "US-101=US-102", "--depends", "US-102=US-101")
        self.assertEqual(res["dependencyCycles"], [["US-101", "US-102"]])
        self.assertEqual([d["storyId"] for d in self.nxt()["dispatched"]], ["US-101", "US-102", "US-103", "US-104"])

    def test_a_story_whose_dependency_failed_is_blocked_not_run(self):
        self.rc("configure", "--concurrency", "1", "--max-attempts", "1", "--depends", "US-102=US-101")
        self.worker(self.nxt()["dispatched"][0], draft_text="not a test case")
        self.assertEqual(self.rc("ingest", "--story-id", "US-101", ok=False)[1]["outcome"], "failed")
        out = self.nxt()
        self.assertEqual([d["storyId"] for d in out["dispatched"]], ["US-103"])
        self.assertIn({"storyId": "US-102", "state": "blocked_dependency", "waitingFor": ["US-101"]}, out["attention"])

    def test_plan_is_read_only(self):
        before = self.tree()
        _, res = self.rc("plan")
        self.assertEqual(res["counts"], {"dispatch": 4})
        self.assertEqual(self.tree(), before)


class WorkerIsolationAndOwnership(Pool):
    def test_a_worker_input_holds_one_story_and_the_contract_only(self):
        out = self.nxt("--concurrency", "2")
        inp = json.loads(Path(out["dispatched"][0]["inputPath"]).read_text(encoding="utf-8"))
        self.assertEqual(set(inp), {"run_id", "story_id", "story_content", "relevant_shared_rules", "dependency_context",
                                    "analysis_instructions", "output_schema_version", "worker_contract"})
        self.assertIn("US-101", inp["story_content"])
        for other in ("US-102", "US-103", "US-104"):
            self.assertNotIn(other, inp["story_content"])
        c = inp["worker_contract"]
        self.assertEqual(c["output"], {"path": "test-design/test-cases/US-101-testcase.md", "mode": "create"})
        self.assertEqual(c["result_path"], "test-design/state/results/US-101.result.json")
        self.assertEqual(run(WORKER, "check-input", "--input", out["dispatched"][0]["inputPath"])[0], 0)
        self.assertIn("Worker input file", out["dispatched"][0]["prompt"])
        self.assertLess(len(out["dispatched"][0]["prompt"]), 400)   # the orchestrator hands over a reference, not the story

    def test_the_input_guard_rejects_a_second_story_or_a_foreign_output_or_a_secret(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        good = json.loads(Path(d["inputPath"]).read_text(encoding="utf-8"))

        def bad(mutate):
            inp = json.loads(json.dumps(good))
            mutate(inp)
            p = self.scratch / "bad.json"
            p.write_text(json.dumps(inp), encoding="utf-8")
            code, res = run(WORKER, "check-input", "--input", p)
            self.assertEqual(code, 1, res)

        bad(lambda i: i.update(story_content=i["story_content"] + "\n## US-102 - Another\n\nText.\n"))
        bad(lambda i: i["worker_contract"]["output"].update(path="test-design/test-cases/US-102-testcase.md"))
        bad(lambda i: i["worker_contract"].update(scratch_dir=str(self.root / "test-design" / "x")))
        bad(lambda i: i["worker_contract"].update(extra="whole workflow"))
        bad(lambda i: i["worker_contract"]["output"].update(mode="append"))
        bad(lambda i: i["worker_contract"]["confirmed_decisions"].append({"question": "q", "answer": "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}))

    def test_a_worker_writes_only_its_own_two_files(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        before = self.tree()
        code, reply = self.worker(d)
        self.assertEqual((code, reply["status"]), (0, "saved"), reply)
        after = self.tree()
        changed = {k for k in after if before.get(k) != after[k]}
        self.assertEqual(changed, {"test-cases/US-101-testcase.md", "state/results/US-101.result.json"})
        for shared in ("state/workflow.json", "state/audit.jsonl"):
            self.assertEqual(before.get(shared), after.get(shared), shared)
        self.assertNotIn("state/traceability.json", after)
        self.assertFalse((self.state / "analysis").exists())

    def test_the_compact_reply_carries_only_what_the_orchestrator_needs(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        _, reply = self.worker(d, ids=["US-101-T1", "US-101-T2"])
        self.assertEqual(set(reply) - {"uncovered"}, {"ok", "storyId", "status", "attempt", "resultPath", "outputFile", "testCaseIds", "caseCount",
                                                     "validation"})
        self.assertEqual((reply["caseCount"], reply["testCaseIds"]), (2, ["US-101-T1", "US-101-T2"]))
        self.assertLess(len(json.dumps(reply)), 700)

    def test_workers_running_as_parallel_processes_do_not_interfere_with_each_other(self):
        from concurrent.futures import ThreadPoolExecutor
        out = self.nxt("--concurrency", "4")
        self.assertEqual(len(out["dispatched"]), 4)
        before = self.tree()
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda d: self.worker(d, ids=[f"{d['storyId']}-T1", f"{d['storyId']}-T2"]), out["dispatched"]))
        self.assertEqual([(c, r["status"]) for c, r in replies], [(0, "saved")] * 4)
        after = self.tree()
        changed = {k for k in after if before.get(k) != after[k]}
        self.assertEqual(changed, {f"{p}/{s}{e}" for s in STORIES for p, e in (("test-cases", "-testcase.md"),) } |
                         {f"state/results/{s}.result.json" for s in STORIES})
        self.assertEqual(before.get("state/workflow.json"), after.get("state/workflow.json"))   # still untouched until the orchestrator ingests
        for d in out["dispatched"]:
            self.rc("ingest", "--story-id", d["storyId"])
        wf = self.wf()["stories"]
        self.assertEqual({s: wf[s]["testCaseFile"]["caseCount"] for s in STORIES}, {s: 2 for s in STORIES})
        t = self.trace()
        self.assertEqual(len(t["cases"]), 8)
        self.assertEqual(sorted(t["stories"]), sorted(STORIES))

    def test_a_worker_that_already_finished_cannot_be_started_again(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d)
        code, res = run(WORKER, "begin", "--input", d["inputPath"])
        self.assertEqual((code, res["error"]["code"]), (3, "ALREADY_DONE"))


class CentralResultManager(Pool):
    def test_ingest_validates_and_records_everything_in_the_shared_state(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d, ids=["US-101-T1", "US-101-T2"])
        _, res = self.rc("ingest", "--story-id", "US-101", "--worker-ref", "agent-a1", "--tokens", "12345", "--duration-ms", "8000")
        self.assertEqual((res["outcome"], res["caseCount"]), ("saved", 2))
        s = self.wf()["stories"]["US-101"]
        self.assertEqual((s["status"], s["lastCompletedStage"], s["testCaseIds"]), ("saved", "save", ["US-101-T1", "US-101-T2"]))
        tf = s["testCaseFile"]
        self.assertEqual((tf["path"], tf["caseCount"], tf["sha256"]), ("test-design/test-cases/US-101-testcase.md", 2, self.sha(self.out_file("US-101"))))
        self.assertEqual(tf["designRulesSha256"], self.wf()["scheduler"]["designRulesSha256"])
        self.assertEqual(s["analysis"]["status"], "completed")
        self.assertEqual(tf["sourceSha256"], s["analysis"]["sourceSha256"])
        self.assertEqual(s["metrics"], {"tokens": 12345, "durationMs": 8000, "attempts": 1})
        t = self.trace()
        self.assertEqual(sorted(t["cases"]), ["US-101-T1", "US-101-T2"])
        self.assertEqual(t["stories"]["US-101"]["criteria"], ["AC-1"])
        self.assertEqual(t["cases"]["US-101-T1"]["covers"], ["US-101#AC-1"])
        self.assertTrue((self.state / "analysis" / "US-101.json").is_file())
        events = [(e["event"], e.get("status")) for e in self.audit()]
        self.assertEqual(events[:2], [("worker_dispatched", None), ("worker_finished", "saved")])
        self.assertIn(("story_saved", None), events)
        self.assertEqual(self.wf()["outputs"]["testCases"]["fileCount"], 1)
        self.assertIsNone(self.wf()["inProgressOperation"])

    def test_ingest_twice_changes_nothing(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d)
        self.rc("ingest", "--story-id", "US-101")
        before = self.tree()
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["outcome"], "already_saved")
        self.assertEqual(self.tree(), before)

    def test_whole_suite_validates_once_at_the_end(self):
        for _ in range(2):
            out = self.nxt("--concurrency", "5")
            for d in out["dispatched"]:
                self.worker(d)
                self.rc("ingest", "--story-id", d["storyId"])
        self.assertEqual({s["status"] for s in self.wf()["stories"].values()}, {"saved"})
        code, res = run("validate-test-cases.py", "--dir", self.root / "test-design" / "test-cases")
        self.assertEqual((code, res["summary"]["errors"]), (0, 0), res)
        code, res = run("validate-traceability.py", "--test-cases-dir", self.root / "test-design" / "test-cases", "--traceability", self.state / "traceability.json")
        self.assertEqual(code, 0, res)
        self.assertEqual(self.wf()["outputs"]["testCases"]["fileCount"], 4)

    def test_a_story_that_is_not_testable_is_skipped_and_recorded(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d, analysis_obj=analysis("US-101", testable=False, not_testable_reason="Purely visual", behaviour_to_validate=[]))
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["outcome"], "skipped")
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "skipped")
        self.assertEqual(self.trace()["stories"]["US-101"]["status"], "no_testable_behaviour")
        self.assertFalse(self.out_file("US-101").exists())

    def test_coverage_gaps_are_deterministic_warnings_not_silent(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        two = analysis("US-101", acceptance_criteria_interpretation=[{"label": "AC-1", "text": "a"}, {"label": "AC-2", "text": "b"}])
        _, reply = self.worker(d, analysis_obj=two)
        self.assertEqual(reply["validation"]["status"], "passed_with_warnings")
        self.assertEqual(reply["uncovered"], [{"label": "AC-2", "reason": "no case covers it"}])
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["validation"]["warnings"], 1)

    def test_declared_uncovered_criteria_keep_their_reason(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        two = analysis("US-101", acceptance_criteria_interpretation=[{"label": "AC-1", "text": "a"}, {"label": "AC-2", "text": "b"}])
        _, reply = self.worker(d, analysis_obj=two, conditions={"uncovered": [{"label": "AC-2", "reason": "needs a payment sandbox"}]})
        self.assertEqual(reply["uncovered"], [{"label": "AC-2", "reason": "needs a payment sandbox"}])

    def test_metadata_that_does_not_match_the_analysis_is_refused(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        code, reply = self.worker(d, covers=["US-101#AC-9"])
        self.assertEqual((code, reply["status"], reply["error"]["code"]), (1, "failed", "META_INVALID"))
        self.assertFalse(self.out_file("US-101").exists())

    def test_formatting_only_problems_are_fixed_deterministically(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        messy = draft_md("US-101", "US-101-T1").replace("1. Open", "1.  Open").replace("\n- The", "\n*   The") + "   \n"
        code, reply = self.worker(d, draft_text=messy)
        self.assertEqual((code, reply["status"]), (0, "saved"), reply)


class Clarifications(Pool):
    QUESTION = "What is the maximum number of login attempts?"

    def blocking(self):
        return analysis("US-101", ambiguities=[{"question": self.QUESTION, "blocking": True, "blocks": ["AC-1"]}])

    def test_a_blocking_question_pauses_only_that_story_and_the_answer_reaches_its_next_worker(self):
        out = self.nxt("--concurrency", "2")
        _, reply = self.worker(out["dispatched"][0], analysis_obj=self.blocking())
        self.assertEqual(reply["status"], "needs_clarification")
        self.assertEqual(reply["clarifications"], [{"question": self.QUESTION, "blockedCriteria": ["AC-1"]}])
        self.assertFalse(self.out_file("US-101").exists())
        self.worker(out["dispatched"][1])
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["outcome"], "needs_clarification")
        self.rc("ingest", "--story-id", "US-102")
        wf = self.wf()["stories"]
        self.assertEqual((wf["US-101"]["status"], wf["US-102"]["status"]), ("needs_clarification", "saved"))
        nxt = self.nxt("--concurrency", "5")
        self.assertNotIn("US-101", [d["storyId"] for d in nxt["dispatched"]])      # waits for the user
        self.assertIn("awaiting_user", [a["state"] for a in nxt["attention"]])
        _, c = self.rc("clarify", "--story-id", "US-101", "--question", self.QUESTION, "--answer", "Five attempts")
        self.assertEqual((c["remainingQuestions"], c["status"]), (0, "pending"))
        self.assertEqual(self.wf()["stories"]["US-101"]["execution"]["attempts"], 0)   # an answer is not a retry
        d = next(x for x in self.nxt("--stories", "US-101")["dispatched"])
        inp = json.loads(Path(d["inputPath"]).read_text(encoding="utf-8"))
        self.assertEqual(inp["worker_contract"]["confirmed_decisions"], [{"question": self.QUESTION, "answer": "Five attempts"}])
        _, reply = self.worker(d, analysis_obj=self.blocking())     # the same question no longer blocks
        self.assertEqual(reply["status"], "saved")
        self.assertIn("clarification_answered", [e["event"] for e in self.audit()])

    def test_a_declined_question_excludes_the_criterion_and_says_so(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d, analysis_obj=self.blocking())
        self.rc("ingest", "--story-id", "US-101")
        self.rc("clarify", "--story-id", "US-101", "--question", self.QUESTION, "--answer", "(declined)", "--declined")
        d = self.nxt("--stories", "US-101")["dispatched"][0]
        _, reply = self.worker(d, analysis_obj=self.blocking(), covers=[])
        self.assertEqual(reply["status"], "saved")
        self.assertEqual(reply["uncovered"][0]["label"], "AC-1")
        self.assertIn("declined", reply["uncovered"][0]["reason"])

    def test_clarify_refuses_a_secret_and_a_story_that_is_not_waiting(self):
        code, res = self.rc("clarify", "--story-id", "US-101", "--question", "q", "--answer", "a", ok=False)
        self.assertEqual((code, res["error"]["code"]), (3, "NOT_AWAITING"))


class RetriesAndRecovery(Pool):
    def test_a_failing_story_is_retried_a_bounded_number_of_times_and_others_continue(self):
        self.rc("configure", "--concurrency", "2")
        out = self.nxt()
        self.worker(out["dispatched"][0], draft_text="garbage")
        self.worker(out["dispatched"][1])
        _, bad = self.rc("ingest", "--story-id", "US-101", ok=False)
        self.assertEqual((bad["outcome"], bad["error"]["code"]), ("retry", "VALIDATION"))
        self.rc("ingest", "--story-id", "US-102")                                  # the other worker is unaffected
        s = self.wf()["stories"]
        self.assertEqual((s["US-101"]["status"], s["US-102"]["status"]), ("pending", "saved"))
        d = next(x for x in self.nxt()["dispatched"] if x["storyId"] == "US-101")
        self.assertEqual(d["attempt"], 2)
        self.worker(d, draft_text="garbage again")
        _, bad = self.rc("ingest", "--story-id", "US-101", ok=False)
        self.assertEqual(bad["outcome"], "failed")
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "failed")
        self.assertEqual(self.wf()["stories"]["US-101"]["execution"]["lastError"]["code"], "VALIDATION")
        self.assertEqual(self.nxt("--stories", "US-101")["dispatched"], [])             # exhausted: not run again by itself
        again = self.nxt("--retry-failed", "--stories", "US-101")                       # only on request, with a fresh budget
        self.assertEqual([(x["storyId"], x["attempt"], x["attemptsUsed"]) for x in again["dispatched"]], [("US-101", 3, 1)])

    def test_a_crashed_worker_is_released_for_one_retry(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        _, res = self.rc("fail", "--story-id", "US-101", "--reason", "timed out", "--worker-ref", "agent-x")
        self.assertEqual((res["outcome"], self.wf()["stories"]["US-101"]["status"]), ("retry", "pending"))
        self.assertEqual(self.nxt("--stories", "US-101")["dispatched"][0]["attempt"], 2)

    def test_a_result_from_an_earlier_attempt_is_never_ingested_for_a_later_one(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d, draft_text="garbage")
        self.rc("ingest", "--story-id", "US-101", ok=False)           # attempt 1 failed -> retry
        d2 = self.nxt("--stories", "US-101")["dispatched"][0]         # attempt 2 dispatched; its worker has not reported yet
        _, res = self.rc("ingest", "--story-id", "US-101", ok=False)
        self.assertEqual(res["outcome"], "stale_result")
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "running")

    def test_an_interrupted_worker_that_finished_its_file_is_adopted_not_rerun(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d)                                                  # worker saved its file and result ...
        # ... but the orchestrator died before ingesting: the next session reclaims it
        out = self.nxt("--reclaim", "--stories", "US-101")
        self.assertEqual(out["dispatched"], [])
        self.assertEqual([(r["storyId"], r["outcome"]) for r in out["reconciled"]], [("US-101", "saved")])
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "saved")
        self.assertIn("US-101-T1", self.trace()["cases"])

    def test_a_crash_between_saving_the_file_and_writing_the_result_is_reconciled_from_the_file(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d)
        rp = self.state / "results" / "US-101.result.json"
        r = json.loads(rp.read_text(encoding="utf-8"))
        r["status"] = "saving"                                           # the intent was recorded, the final result never was
        for k in ("outputFile", "finishedAt"):
            r.pop(k)
        rp.write_text(json.dumps(r), encoding="utf-8")
        out = self.nxt("--reclaim", "--stories", "US-101")
        self.assertEqual([(x["storyId"], x["outcome"]) for x in out["reconciled"]], [("US-101", "saved")])
        self.assertEqual(self.wf()["stories"]["US-101"]["testCaseFile"]["sha256"], self.sha(self.out_file("US-101")))

    def test_a_crash_before_the_cases_reached_the_file_retries_without_touching_anything(self):
        d = self.nxt("--concurrency", "1")["dispatched"][0]
        self.worker(d)
        self.out_file("US-101").unlink()
        rp = self.state / "results" / "US-101.result.json"
        r = json.loads(rp.read_text(encoding="utf-8"))
        r["status"] = "saving"
        rp.write_text(json.dumps(r), encoding="utf-8")
        out = self.nxt("--reclaim", "--stories", "US-101")
        self.assertEqual([(x["storyId"], x["outcome"]) for x in out["reconciled"]], [("US-101", "retry")])
        self.assertEqual([x["attempt"] for x in out["dispatched"]], [2])

    def test_an_expired_lease_releases_a_silent_worker(self):
        self.nxt("--concurrency", "1")
        self.set_wf(lambda w: w["stories"]["US-101"]["execution"].update(leaseExpiresAt="2020-01-01T00:00:00Z"))
        out = self.nxt()
        self.assertEqual([(x["storyId"], x["reason"]) for x in out["reconciled"]], [("US-101", "interrupted")])

    def test_a_live_lease_is_left_alone(self):
        self.nxt("--concurrency", "1")
        _, plan = self.rc("plan")
        self.assertEqual(plan["counts"].get("running"), 1)


class OutputSafety(Pool):
    def test_an_existing_file_nobody_recorded_is_never_appended_to_without_a_yes(self):
        mine = draft_md("US-101", "US-101-HAND", module="Hand written")
        self.write("test-design/test-cases/US-101-testcase.md", mine)
        before = self.sha(self.out_file("US-101"))
        out = self.nxt("--concurrency", "5")
        self.assertNotIn("US-101", [d["storyId"] for d in out["dispatched"]])
        self.assertIn({"storyId": "US-101", "state": "blocked_untracked_output"}, out["attention"])
        adopted = self.nxt("--stories", "US-101", "--adopt", "US-101")["dispatched"][0]
        self.assertEqual(adopted["mode"], "append")
        _, reply = self.worker(adopted)
        self.assertEqual(reply["status"], "saved", reply)
        text = self.out_file("US-101").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(mine.rstrip()))                      # the user's text is untouched
        self.assertIn("US-101-T1", text)
        self.assertNotEqual(self.sha(self.out_file("US-101")), before)

    def test_a_worker_never_decides_for_the_user_when_the_file_needs_a_decision(self):
        self.write("test-design/test-cases/US-101-testcase.md", draft_md("US-101", "US-101-T1", module="Old"))
        d = self.nxt("--stories", "US-101", "--adopt", "US-101")["dispatched"][0]
        before = self.sha(self.out_file("US-101"))
        # same ID, different content than what is saved: a conflict only the user can settle
        code, reply = self.worker(d, draft_text=draft_md("US-101", "US-101-T1").replace("Open the page", "Open another page"))
        self.assertEqual((code, reply["status"]), (0, "needs_decision"), reply)
        self.assertEqual(reply["decision"]["code"], "ID_CONFLICT")
        self.assertEqual(self.sha(self.out_file("US-101")), before)
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual((res["outcome"], self.wf()["stories"]["US-101"]["status"]), ("needs_decision", "needs_clarification"))
        self.rc("resolve", "--story-id", "US-101", "--action", "skip")
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "skipped")

    def test_identical_cases_already_in_the_file_count_as_saved_not_conflicting(self):
        self.finish("US-101")
        self.set_wf(lambda w: w["stories"]["US-101"].update(status="pending"))     # as if the state update had been lost
        self.set_wf(lambda w: w["stories"]["US-101"]["execution"].update(attempts=0))
        d = self.nxt("--stories", "US-101")["dispatched"][0]
        self.assertEqual(d["mode"], "append")
        _, reply = self.worker(d)
        self.assertEqual((reply["status"], self.wf()["stories"]["US-101"]["status"]), ("saved", "running"))
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["outcome"], "saved")

    def test_a_saved_story_is_never_rerun_by_a_retry_or_a_plain_next(self):
        self.finish("US-101")
        h = self.sha(self.out_file("US-101"))
        out = self.nxt("--concurrency", "5", "--retry-failed")
        self.assertNotIn("US-101", [d["storyId"] for d in out["dispatched"]])
        self.assertEqual(self.sha(self.out_file("US-101")), h)

    def test_appending_to_a_recorded_file_keeps_existing_bytes(self):
        self.finish("US-101")
        first = self.out_file("US-101").read_text(encoding="utf-8")
        self.set_wf(lambda w: w["stories"]["US-101"].update(status="pending"))
        d = self.nxt("--stories", "US-101")["dispatched"][0]
        self.assertEqual(d["mode"], "append")
        _, reply = self.worker(d, ids=["US-101-T2"])
        self.assertEqual(reply["status"], "saved", reply)
        text = self.out_file("US-101").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(first.rstrip()))
        self.assertEqual(reply["caseCount"], 2)

    def test_regeneration_is_staged_and_only_replaces_the_file_after_an_explicit_commit(self):
        self.finish("US-101")
        h = self.sha(self.out_file("US-101"))
        p = self.root / "stories" / "shop.md"
        p.write_text(p.read_text(encoding="utf-8").replace("Valid credentials open the orders page.", "Valid credentials open the account page."), encoding="utf-8")
        _, plan = self.rc("plan")
        row = {r["storyId"]: r for r in plan["stories"]}
        self.assertEqual((row["US-101"]["state"], row["US-101"]["reasons"]), ("stale", ["story_changed"]))
        self.assertEqual(row["US-102"]["state"], "dispatch")
        self.assertNotIn("US-101", [d["storyId"] for d in self.nxt("--concurrency", "5")["dispatched"]])
        d = self.nxt("--stories", "US-101", "--regenerate", "US-101")["dispatched"][0]
        self.assertEqual(d["mode"], "stage_only")
        _, reply = self.worker(d, ids=["US-101-T1", "US-101-T9"])
        self.assertEqual(reply["status"], "staged", reply)
        self.assertEqual(self.sha(self.out_file("US-101")), h)                       # nothing replaced
        _, res = self.rc("ingest", "--story-id", "US-101")
        self.assertEqual(res["outcome"], "staged")
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "saved")          # the old file stays valid until the user agrees
        draft = res["decision"]["draftPath"]
        # the user agreed to the dry run: the orchestrator replaces the file with the existing safe operation ...
        code, rep = run(SAFE, "regenerate-story-file", "--root", self.root, "--story-id", "US-101", "--source", draft,
                        "--expect-sha256", h, "--yes")
        self.assertEqual(code, 0, rep)
        self.assertNotEqual(self.sha(self.out_file("US-101")), h)
        # ... and the result manager records it, dropping the mapping of cases that are gone
        _, c = self.rc("ingest", "--story-id", "US-101", "--commit-staged")
        self.assertEqual(c["outcome"], "saved")
        s = self.wf()["stories"]["US-101"]
        self.assertEqual(s["testCaseFile"]["sha256"], self.sha(self.out_file("US-101")))
        _, plan = self.rc("plan", "--stories", "US-101")
        self.assertEqual(plan["stories"][0]["state"], "done")
        self.assertIn("US-101-T9", self.trace()["cases"])
        self.assertIn("story_regenerated", [e["event"] for e in self.audit()])

    def test_commit_staged_before_the_file_was_replaced_is_refused(self):
        self.finish("US-101")
        d = self.nxt("--stories", "US-101", "--regenerate", "US-101")["dispatched"][0]
        self.worker(d, ids=["US-101-T1", "US-101-T9"])
        self.rc("ingest", "--story-id", "US-101")
        code, res = self.rc("ingest", "--story-id", "US-101", "--commit-staged", ok=False)
        self.assertEqual((code, res["error"]["code"]), (3, "NOT_COMMITTED"))

    def test_a_failed_regeneration_does_not_demote_a_saved_story(self):
        self.finish("US-101")
        d = self.nxt("--stories", "US-101", "--regenerate", "US-101")["dispatched"][0]
        self.worker(d, draft_text="garbage")
        self.rc("ingest", "--story-id", "US-101", ok=False)
        self.assertEqual(self.wf()["stories"]["US-101"]["status"], "saved")


class ChangeDetection(Pool):
    def test_only_the_changed_story_is_flagged(self):
        for sid in ("US-101", "US-103"):
            self.finish(sid)
        p = self.root / "stories" / "cart.md"
        p.write_text(p.read_text(encoding="utf-8") + "\n- The cart total updates.\n", encoding="utf-8")
        _, plan = self.rc("plan", "--stories", "US-101,US-103")
        self.assertEqual({r["storyId"]: r["state"] for r in plan["stories"]}, {"US-101": "done", "US-103": "stale"})

    def test_a_change_to_a_dependency_story_flags_the_story_that_used_it(self):
        self.finish("US-102")                                              # analysed with US-101 as context
        p = self.root / "stories" / "shop.md"
        p.write_text(p.read_text(encoding="utf-8").replace("Valid credentials open the orders page.", "Valid credentials open the account page."), encoding="utf-8")
        _, plan = self.rc("plan", "--stories", "US-102")
        self.assertEqual(plan["stories"][0]["reasons"], ["dependency_changed:US-101"])

    def test_a_shared_rule_change_flags_only_the_stories_that_used_it(self):
        self.write_workflow(rules="stories/rules.md")
        d = self.nxt("--concurrency", "5", "--rules", "US-103=currency")["dispatched"]
        for x in d:
            self.worker(x)
            self.rc("ingest", "--story-id", x["storyId"])
        rules = self.root / "stories" / "rules.md"
        rules.write_text(rules.read_text(encoding="utf-8").replace("EUR", "USD"), encoding="utf-8")
        _, plan = self.rc("plan")
        states = {r["storyId"]: r["state"] for r in plan["stories"]}
        self.assertEqual(states, {"US-101": "done", "US-102": "done", "US-103": "stale", "US-104": "done"})

    def test_a_design_rules_change_flags_finished_stories_but_regenerates_nothing(self):
        self.finish("US-101")
        self.set_wf(lambda w: w["stories"]["US-101"]["testCaseFile"].update(designRulesSha256="0" * 64))
        h = self.sha(self.out_file("US-101"))
        _, plan = self.rc("plan", "--stories", "US-101")
        self.assertEqual((plan["stories"][0]["state"], plan["stories"][0]["reasons"]), ("stale", ["design_rules_changed"]))
        self.assertEqual(self.nxt("--stories", "US-101")["dispatched"], [])
        self.assertEqual(self.sha(self.out_file("US-101")), h)

    def test_a_hand_edit_is_noted_not_treated_as_a_reason_to_regenerate(self):
        self.finish("US-101")
        with open(self.out_file("US-101"), "a", encoding="utf-8", newline="\n") as fh:
            fh.write("\n")
        _, plan = self.rc("plan", "--stories", "US-101")
        self.assertEqual((plan["stories"][0]["state"], plan["stories"][0].get("notes")), ("done", ["edited_since_save"]))

    def test_a_deleted_output_is_reported_not_silently_regenerated(self):
        self.finish("US-101")
        self.out_file("US-101").unlink()
        _, plan = self.rc("plan", "--stories", "US-101")
        self.assertEqual((plan["stories"][0]["state"], plan["stories"][0]["reasons"]), ("stale", ["output_missing"]))


class RuntimeEvidence(Pool):
    def stamp(self, sid, start, end):
        rp = self.state / "results" / f"{sid}.result.json"
        r = json.loads(rp.read_text(encoding="utf-8"))
        r["startedAt"], r["finishedAt"] = start, end
        rp.write_text(json.dumps(r), encoding="utf-8")

    def two_workers(self):
        out = self.nxt("--concurrency", "2")
        for d in out["dispatched"]:
            self.worker(d)
            self.rc("ingest", "--story-id", d["storyId"], "--worker-ref", f"agent-{d['storyId']}")
        return out

    def test_overlapping_workers_prove_concurrent_isolated_execution(self):
        self.two_workers()
        self.stamp("US-101", "2026-01-01T12:00:00Z", "2026-01-01T12:00:30Z")
        self.stamp("US-102", "2026-01-01T12:00:05Z", "2026-01-01T12:00:40Z")
        _, res = self.rc("check-pool", "--apply")
        self.assertEqual((res["runtimeParallelism"], res["observedOverlap"], res["findings"]), ("parallel", 2, []))
        self.assertEqual(self.wf()["scheduler"]["runtimeParallelism"], "parallel")

    def test_workers_that_never_overlap_are_reported_as_a_runtime_limitation(self):
        self.two_workers()
        self.stamp("US-101", "2026-01-01T12:00:00Z", "2026-01-01T12:00:10Z")
        self.stamp("US-102", "2026-01-01T12:00:10Z", "2026-01-01T12:00:20Z")
        _, res = self.rc("check-pool", "--apply")
        self.assertEqual(res["runtimeParallelism"], "sequential")
        self.assertIn("--concurrency 1", res["message"])
        self.assertEqual(self.wf()["scheduler"]["runtimeParallelism"], "sequential")

    def test_one_worker_session_used_for_two_stories_is_a_finding(self):
        out = self.nxt("--concurrency", "2")
        for d in out["dispatched"]:
            self.worker(d)
            self.rc("ingest", "--story-id", d["storyId"], "--worker-ref", "same-session")
        code, res = self.rc("check-pool", ok=False)
        self.assertEqual(code, 1)
        self.assertTrue(any("context reused" in f for f in res["findings"]))

    def test_nothing_is_claimed_before_there_is_evidence(self):
        self.nxt("--concurrency", "2")
        _, res = self.rc("check-pool")
        self.assertEqual(res["runtimeParallelism"], "unverified")

    def test_cost_is_reported_as_tokens_and_elapsed_time_separately(self):
        for d in self.nxt("--concurrency", "2")["dispatched"]:
            self.worker(d)
            self.rc("ingest", "--story-id", d["storyId"], "--tokens", "1000", "--duration-ms", "4000")
        _, res = self.rc("status")
        self.assertEqual((res["cost"]["workerTokens"], res["cost"]["sumOfWorkerSeconds"]), (2000, 8.0))
        self.assertIn("do not reduce total tokens", res["cost"]["note"])


class StaticContract(unittest.TestCase):
    """The agent and orchestrator definitions say what the scripts enforce."""

    def read(self, rel):
        return (PLUGIN_ROOT / rel).read_text(encoding="utf-8")

    def test_the_worker_is_one_reusable_definition_that_cannot_reach_shared_state_or_other_agents(self):
        w = self.read("agents/story-worker.md")
        tools = re.search(r"^tools:\s*(.+)$", w, re.M).group(1)
        self.assertNotIn("Agent", tools)
        self.assertNotIn("AskUserQuestion", tools)
        for forbidden in ("workflow.json", "traceability.json", "audit.jsonl"):
            self.assertIn(forbidden, w)      # named, as things it never writes
        self.assertIn("story-worker.py", w)
        self.assertNotRegex(w, r"story-run\.py (next|ingest|fail|clarify|resolve)")   # the orchestrator's commands are not the worker's

    def test_the_orchestrator_runs_a_bounded_pool_of_fresh_workers_and_reports_runtime_limits(self):
        o = self.read("agents/test-design-orchestrator.md")
        low = o.lower()
        for needle in ("story-run.py next", "story-run.py ingest", "check-pool", "builder:story-worker", "concurrency",
                       "never** continue", "do not simulate parallelism", "sole writer"):
            self.assertIn(needle.lower(), low, needle)
        self.assertNotIn("Execution is **sequential**", o)

    def test_standards_file_exists_and_is_short(self):
        s = PLUGIN / "rules" / "worker-standards.md"
        self.assertTrue(s.is_file())
        self.assertLess(len(s.read_text(encoding="utf-8")), 4500)


if __name__ == "__main__":
    unittest.main()

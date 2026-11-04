---
name: generate-tests
description: Parse test cases (your own, or the ones test design generated), explore the app as needed, then generate and review Playwright tests — without executing them.
argument-hint: "[test-case path] | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:generate-tests

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/builder:init` first (it scaffolds the framework; it installs nothing).

Same orchestrator role, shared modules and configuration as `/builder:playwright-pipeline`; only the scope is smaller.
Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (asking the user in Claude Code and Cowork).

0. **Which test cases** (new run only; skip when resuming, the run already knows):
   - A path in `$ARGUMENTS` is the answer, exactly as before; the design output is not consulted.
   - No path: `node dependencies/engine/cli/pipeline.ts design status`. If it reports no `test-design/` output or no saved story,
     carry on exactly as before with the configured test-case path. Otherwise the test cases that the design stages generated are
     there for you; the user does not have to supply them:
     1. If the saved configuration already points at other test cases that exist (`input.testCasesPath` is not
        `input/test-cases/design`), ask which to use: *Use the test cases from test design (Recommended)* / *Keep using the test cases at
        `<that path>`*. If they pick the second, carry on as before.
     2. Check the design output is current: run `fingerprint-sources.py compare` as `/builder:design-status` does. Stories
        listed as stale (their text changed after the test cases were generated) are named to the user, who chooses: continue with the
        saved test cases (recommended only if the change is irrelevant), or stop and run `/builder:design-resume` first.
        Stories not yet `saved` are named too, with `/builder:design-resume`; they are left out. If the user wants only some
        stories, pass `--story`.
     3. Hand the cases over: `pl design handoff [--story …]` (dry run), tell the user in two or three lines what is handed over and which
        cases are **manual** (with the reason; they are not automated) or **blocked**, then `pl design handoff … --apply`. A conflict
        (a hand-edited imported copy) is shown and asked about; never overwritten or deleted by you.
     4. The test-case path of this run is `input/test-cases/design` (`--path` to `input validate` and `specs parse`, the test-analyst, and
        `input.testCasesPath` in the configuration).
1. Start: `node dependencies/engine/cli/pipeline.ts run create --command generate-tests` (add `--design` when the test cases come from test
   design, so the run keeps the link and `report build`/`design trace` can show the story → … → script chain), or resume:
   `run resume <run-id>`, or `run resume --command generate-tests` for the newest unfinished run; show its `checkpoint` first, as in
   playwright-pipeline (and, when it has a `design` block with `current: false`, say that the design output changed since the run was
   created and offer `pl design attach <runId>`).
   Out-of-scope stages are pre-marked `skipped`.
2. Run these stages exactly as described in [../playwright-pipeline/stages.md](../playwright-pipeline/stages.md):
   `preflight` → `configuration` → `input_validation` → `test_analysis` → `application_exploration` →
   `test_generation` → `script_review` → `finalization`.
   An optional path in `$ARGUMENTS` is passed as `--path` to `input validate` and to the test-analyst.
3. `finalization`: there is no summary to count, so just complete the stage after `node dependencies/engine/cli/pipeline.ts run finalize <runId>`.

Finish with: run id and status, generated files (from `generation-manifest.json`), excluded/blocked specs with
reasons, review findings still open (non-critical), and the next step: `/builder:run-tests`.

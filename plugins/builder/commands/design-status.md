---
description: Show the current test-design run and the hand-over to automation - phase, per-story progress, case counts, validation outcome, whether the stories changed since generation, and whether the test cases handed to automation are current. Read-only.
argument-hint: "[project root]"
disable-model-invocation: true
---

# /builder:design-status

Arguments: `$ARGUMENTS`

Read-only: write nothing.

1. Load the `workflow-resume` skill (`${CLAUDE_PLUGIN_ROOT}/skills/workflow-resume/SKILL.md`) and follow its "Locate the run" and
   "Status report" sections. Project root: `$ARGUMENTS` if given, otherwise the nearest ancestor of the working directory containing
   `test-design/state/workflow.json`. If none is found, say so and ask for the project root.
2. Show run id and status, current phase and story, a per-story table (story ID, status, analysis status, saved scenarios yes/no,
   test-case file, cases, validation), totals, unresolved clarifications and output paths.
3. Check source drift with `fingerprint-sources.py compare ... --root <root> --traceability <root>/test-design/state/traceability.json
   --workflow <root>/test-design/state/workflow.json` and list changed, added or removed stories, the cases linked to them and the stale
   story files (`staleTestCaseFiles`). Run `story-analysis-state.py plan --root <root>` (without `--apply`) and list the stories whose
   saved analysis would be rerun or is invalidated, with the reason. Run `story-run.py plan --root <root>` and `story-run.py status --root <root>`
   (both read-only) for the worker pool: stories running, waiting, awaiting the user, blocked or out of retries, stories flagged `stale`
   (story, shared rule, dependency or design rules changed), the concurrency in use, whether the runtime ran workers in parallel, and the cost
   as tokens and elapsed time separately. If the state file is missing or corrupt, explain exactly what is
   wrong; do not repair it.
4. If the project has the automation engine (`dependencies/engine/cli/pipeline.ts`), run
   `node dependencies/engine/cli/pipeline.ts design status` and add: which stories were handed to automation, whether that hand-over is
   still current (design files and imported copies unchanged), and the latest `design-test-n-automation` run (`run list`).
5. End with the next step: `/builder:design-resume` for an incomplete run, `/builder:validate-test-cases`,
   `/builder:design-test-n-automation` or `/builder:generate-tests` for a complete one.

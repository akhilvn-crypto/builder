---
name: heal-tests
description: Analyze failed tests from an earlier run, repair eligible script defects with bounded, guarded attempts, validate the repairs and report.
argument-hint: "<source-run-id> | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:heal-tests

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/builder:init` first (it scaffolds the framework; it installs nothing).

Same orchestrator role, shared modules and configuration as `/builder:playwright-pipeline`.
Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (asking the user in Claude Code and Cowork).

1. If `$ARGUMENTS` starts with `resume`, skip this step: the source run is already stored in the resumed run's manifest.
   Otherwise the source run is `$ARGUMENTS`, or else the newest run from `node dependencies/engine/cli/pipeline.ts run list` whose
   `execution-results.json` has failed tests (check with `run show`). If there is none, say so and stop.
   Confirm the source run id with the user before healing.
2. Start: `node dependencies/engine/cli/pipeline.ts run create --command heal-tests --from-run <sourceRunId>` (or resume: `run resume <run-id>`, or `run resume --command heal-tests` for the newest unfinished run; show its `checkpoint` first, as in playwright-pipeline).
   The source run is read, never modified.
3. Run these stages exactly as described in [../playwright-pipeline/stages.md](../playwright-pipeline/stages.md):
   `preflight` → `configuration` → `failure_triage` → `healing` → `regression_validation` → `report_generation` →
   `finalization`.
   - `failure_triage`: `triage run <runId>` reads the source run's results automatically.
   - `healing`: `agents plan <runId> healing`, then **failure-healer** Phase B per eligible test. The attempt limit is per test per run.
   - `regression_validation`: run `exec run <runId> --label regression --test-file <each healed file>` yourself (no agent).

Finish with the stages.md summary, focusing on: healed tests (with diffs from `healing-log.json`), tests left failing
and why (application defects are not healed), and attempts used.

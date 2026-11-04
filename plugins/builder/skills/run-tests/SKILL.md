---
name: run-tests
description: Execute existing Playwright tests, collect evidence, classify failures and produce the report — no generation and no healing.
argument-hint: "[test file or folder ...] | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:run-tests

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/builder:init` first (it scaffolds the framework; it installs nothing).

Same orchestrator role, shared modules and configuration as `/builder:playwright-pipeline`.
Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (asking the user in Claude Code and Cowork).

1. Start: `node dependencies/engine/cli/pipeline.ts run create --command run-tests` (or resume: `run resume <run-id>`, or `run resume --command run-tests` for the newest unfinished run; show its `checkpoint` first, as in playwright-pipeline).
2. Run these stages exactly as described in [../playwright-pipeline/stages.md](../playwright-pipeline/stages.md):
   `preflight` → `configuration` → `execution` → `failure_triage` → `report_generation` → `finalization`.
   - `execution`: run `exec run <runId> --label initial` yourself (no agent), passing each path from `$ARGUMENTS` as
     `--test-file` (none = every `*.spec.*` under `tests/`, pipeline-generated and handwritten).
   - `failure_triage`: `triage run`, then `agents plan <runId> failure_triage`; **failure-healer** Phase A only for the failures it lists. No edits in this command.
3. Tests without a `[ID]` title appear as `untagged:<file>:<title>`. That's expected for handwritten tests.

Finish with the summary from stages.md. If there are eligible script defects, suggest
`/builder:heal-tests <runId>`.

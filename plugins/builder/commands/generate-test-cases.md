---
description: Detailed user stories to validated test cases in one flow - story discovery, story analysis, test design, test-case generation, validation and traceability, with a bounded pool of fresh story workers (5 at a time by default). Saves one file per story under test-design/test-cases/. Stops there; no automation is started. Re-running it resumes an interrupted run.
argument-hint: "[stories folder | story file | file name] [--story US-001,US-002] [--concurrency 1-5] [--retry-failed]"
disable-model-invocation: true
---

# /builder:generate-test-cases

The whole test-design flow for the stories in `stories/` (or the location you give), with nothing after it: story discovery, story
analysis, coverage design, test-case generation, validation, and story traceability. Use it to review the test cases before anything is
automated. `/builder:design-test-n-automation` does the same work and then carries on to Playwright scripts and execution.
`/builder:do-automation` automates test cases you already have.

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**; do not
hand the user conversation to a subagent. Read the rules it names. Python 3.9+ is needed for the design scripts: if none of `python`,
`python3`, `py -3` runs, say so and ask before installing anything.

`SCOPE` = `all`, run by the orchestrator's worker pool: one fresh `story-worker` per story, at most `--concurrency N` at once (default 5, at most 5; 1 runs them one after another). Story location: the first argument that is not a flag, else `stories/` if it exists (offered as the recommended
answer), else ask. `STORIES` = the IDs after `--story`, else all stories (the one-question confirmation lets the user narrow them).

**Resuming.** If a previous run exists (`test-design/state/workflow.json`), do not start over. Load the `workflow-resume` skill and
follow it exactly: read the checkpoint, verify output hashes and source fingerprints, classify every story, and present a short summary
(done, incomplete, affected by source changes, new, with case counts and validation outcome). A story that stopped after analysis or test
design continues from there. For stories that changed since generation, ask story by story whether to keep, regenerate that story's
file (dry run first) or skip; never regenerate, replace or delete anything without that yes. If the checkpoint or outputs are missing
or corrupt, explain the problem and ask how to proceed; never assume the work was completed. Then continue the worker pool for the
incomplete stories only, starting with `story-run.py next --reclaim` (it adopts what an interrupted worker had finished and releases
the rest; stories already `saved` and unchanged are never rerun). `--retry-failed` gives a story that exhausted its retries a fresh,
bounded retry budget; use it only when the user asks. If nothing is incomplete, say so and report the summary. There is no separate
status or resume command.

Finish with the orchestrator's summary. Next steps to mention: `/builder:generate-tests` (automates these cases; you do not supply
them) or `/builder:design-test-n-automation`. This command never publishes anything.

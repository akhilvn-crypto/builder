---
description: Test design in one go - a bounded pool of fresh story workers (3 at a time by default) analyses your user stories, designs the coverage, generate validated test cases (one file per story under test-design/test-cases/) and keep story traceability. Stops there; no automation is started.
argument-hint: "[stories folder | story file | file name] [--story US-001,US-002] [--concurrency 1-5]"
disable-model-invocation: true
---

# /builder:design-test-cases

Story discovery, story analysis, test design and test-case generation for the stories in `stories/` (or the location you give), with
nothing after them. Use it to review the test cases before anything is automated. `/builder:design-test-n-automation` does
the same work and then carries on to Playwright scripts and execution. The commands `analyse-stories`, `design-tests` and
`generate-test-cases` run one stage each.

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**; do not
hand the user conversation to a subagent. Read the rules it names. Python 3.9+ is needed for the design scripts: if none of `python`,
`python3`, `py -3` runs, say so and ask before installing anything.

`SCOPE` = `all`, run by the orchestrator's worker pool: one fresh `story-worker` per story, at most `--concurrency N` at once (default 3, at most 5; 1 runs them one after another). Story location: the first argument that is not a flag, else `stories/` if it exists (offered as the recommended
answer), else ask. `STORIES` = the IDs after `--story`, else all stories (the one-question confirmation lets the user narrow them).
If a previous run exists, offer to resume it (`workflow-resume`) rather than starting over.

Finish with the orchestrator's summary. Next steps to mention: `/builder:automation-readiness`,
`/builder:generate-tests` (automates these cases; you do not supply them), `/builder:design-test-n-automation`.
This command never publishes anything.

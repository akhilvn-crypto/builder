---
description: Test-case generation only - turn the saved scenarios into structured test cases in the canonical Markdown format, validate them, check coverage and traceability, and save one file per story under test-design/test-cases/.
argument-hint: "[--story US-001,US-002]"
disable-model-invocation: true
---

# /builder:generate-test-cases

Stages 4-5 of the test design: writes the cases (stable IDs, declared test data, concise steps, observable expected results), validates
them with the deterministic checks, has the quality checker verify coverage of every criterion and rule, and saves each story's file
and its traceability. A case that fails validation is never saved. Needs the analysis and the scenarios from the earlier stages; if
either is missing or stale for a story, that story is skipped with the command to run.

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**; do not
hand the user conversation to a subagent. Read the rules it names. Python 3.9+ is needed for the design scripts: if none of `python`,
`python3`, `py -3` runs, say so and ask before installing anything.

`SCOPE` = `generate`; project root and `STORIES` as in `/builder:design-tests`. Existing cases and files are never
overwritten without an explicit yes (a changed story is handled through the `workflow-resume` "Reconcile" question).

Next: `/builder:automation-readiness`, then `/builder:generate-tests`.

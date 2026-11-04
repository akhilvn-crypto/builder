---
description: Test design only - from the saved story analyses, choose the techniques (positive, negative, boundary, equivalence, decision table, state transition, end-to-end, non-functional) and the test scenarios that cover every acceptance criterion and rule. Saves the scenarios; writes no test cases yet.
argument-hint: "[--story US-001,US-002]"
disable-model-invocation: true
---

# /builder:design-tests

Stage 3 of the test design. Needs the analyses from `/builder:analyse-stories` (or from a full run): for every selected story
it checks that the saved analysis exists and is still current, then runs the `test-coverage-designer` and saves the resulting
scenarios (technique, the criteria each one covers, priority, dependencies) under `test-design/state/conditions/`, together with the
criteria that cannot be covered and why. If an analysis is missing or stale for a story, that story is skipped with the command to run.

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**; do not
hand the user conversation to a subagent. Read the rules it names. Python 3.9+ is needed for the design scripts: if none of `python`,
`python3`, `py -3` runs, say so and ask before installing anything.

`SCOPE` = `design`. Find the project root as `/builder:design-status` does (the nearest folder containing
`test-design/state/workflow.json`); do not ask for a story location. `STORIES` = the IDs after `--story`, else every analysed story that
is not yet designed or whose saved scenarios are stale.

Next: `/builder:generate-test-cases`.

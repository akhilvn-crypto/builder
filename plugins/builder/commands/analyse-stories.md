---
description: Story discovery and story analysis only - read the stories in stories/ (or the location you give) and analyse each in its own fresh worker. Saves the validated analyses; designs nothing yet.
argument-hint: "[stories folder | story file | file name] [--story US-001,US-002]"
disable-model-invocation: true
---

# /builder:analyse-stories

Stages 1-2 of the test design: finds the stories, then analyses each one on its own (acceptance criteria, business rules,
preconditions, dependencies, ambiguities) and saves the validated result under `test-design/state/analysis/`. Blocking questions a story
leaves open are asked here, one at a time. Nothing else is produced.

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**; do not
hand the user conversation to a subagent. Read the rules it names. Python 3.9+ is needed for the design scripts: if none of `python`,
`python3`, `py -3` runs, say so and ask before installing anything.

`SCOPE` = `analyse`. Story location and `STORIES` as in `/builder:design-test-cases`. A story whose saved analysis is still
current (its text, the shared rules it used and the stories it depends on are unchanged) is reused without starting a worker; one that
changed is analysed again, in a fresh worker, and its saved test cases (if any) are never touched.

Next: `/builder:design-tests`.

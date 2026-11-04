---
description: Resume an interrupted test-design run safely - verifies the checkpoint, output hashes and source fingerprints, continues only unfinished stories, and asks before reconciling stories that changed. Never regenerates or overwrites existing test cases on its own.
argument-hint: "[project root]"
disable-model-invocation: true
---

# /builder:design-resume

Arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/agents/test-design-orchestrator.md` (if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) and **act as that orchestrator in this conversation**.

Load the `workflow-resume` skill and follow it exactly: locate the run (`$ARGUMENTS` as the project root if given), read the checkpoint,
verify output hashes and source fingerprints, classify every story, and present a short summary of what is done, incomplete, affected by
source changes, and new. A story that stopped after analysis or after test design continues from there. For stories that changed since
generation, ask story by story whether to keep, regenerate that story's file (dry run first) or skip; never regenerate, replace or delete
anything without that yes. If the checkpoint or outputs are missing or corrupt, explain the problem and ask how to proceed; never assume
the work was completed. Then continue the per-story loop (`SCOPE` = `all`) for the incomplete stories only and finish with the
orchestrator's summary. If nothing is incomplete, say so and point to `/builder:validate-test-cases`.

To resume a whole `/builder:design-test-n-automation` workflow, use that command with `resume`.

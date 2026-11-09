---
name: mobile-heal-flows
description: Repair selector failures from an earlier mobile run with bounded, evidence-proven, audited changes (an id/text/label that moved on the same control), re-run the repaired flows and report. Never heals application defects, hand-written flows, or behaviour changes, and never retargets a selector to a different element.
argument-hint: "<source-run-id>"
disable-model-invocation: true
---

# /builder:mobile-heal-flows

The mobile counterpart of `/builder:heal-tests`, deliberately narrower: Maestro flows are repaired only when **the same control has a new identifier or label**.
Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first, then [../maestro-execution/SKILL.md](../maestro-execution/SKILL.md) ("Repairing a selector") and
[../maestro-framework/SKILL.md](../maestro-framework/SKILL.md). `MCLI` = `node mobile-automation/tools/maestro-cli.mjs` from the project root.

> **Setup:** if `mobile-automation/state/scaffold.json` is missing, stop and point to `/builder:mobile-init`. Healing needs the device and app that produced the failure.

1. **Source run.** `$ARGUMENTS`, else the newest from `MCLI report list` that has failed flows. Confirm the run id with the user. Read `reports/<runId>/results.json`; the run is never modified.
2. **Eligible flows** = `status: failed`, `category: automation`, flow still starting with `# @builder:generated`. Show the rest with the reason they are not repaired:
   application (report to the app team), device/environment (fix and re-run), hand-written flow (the user's), `needsConfirmation` ones you have not confirmed yet (confirm from the
   screenshot first, `maestro-execution`), anything where the screen or navigation differs from the test case (review the test case, show the old and new screen).
3. For each eligible flow, **one after another**, delegate to `builder:maestro-flow-healer` (Phase B) with the run id, the flow and the failure record. It uses `heal start / check / finish`;
   the attempt limit is 2 per flow per run, an edit that breaks a rule is reverted by the CLI, a failed re-run restores the original.
4. Verify its claims: `MCLI heal status <runId>`, then `MCLI run --platform <p> --flow <file> --label heal` for each repaired flow if the agent did not (the re-run is what counts).
5. `MCLI report build` for the re-run, `MCLI map plan` (a repaired generated flow stays `unchanged`).

Finish with: repaired flows (old → new selector, the evidence file, the rationale), flows left failing and why, attempts used, and `state/healing-log.json` as the audit trail.
Never hand-edit selectors yourself, never weaken or delete an assertion, never mark `optional`, never call a flaky pass a pass.

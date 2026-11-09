---
name: maestro-execution
description: Running Maestro flows through the mobile CLI (one flow, a feature, a suite, everything), the evidence each run keeps, failure classification into application, automation, device and environment, bounded selector repair, and report building. Use when executing mobile tests, reading results or triaging failures.
user-invocable: false
---

# Running Maestro flows, evidence and failures

CLI: `MCLI` = `node mobile-automation/tools/maestro-cli.mjs …` (JSON on stdout, progress on stderr; exit 0 ran, 2 not ready, 1 error).
Prerequisites and devices: [../maestro-setup/SKILL.md](../maestro-setup/SKILL.md). Conventions: [../maestro-framework/SKILL.md](../maestro-framework/SKILL.md).

## Choosing what to run

`MCLI run --platform android|ios` plus one or more of `--flow <file>`, `--test <ID>`, `--feature <name>`, `--tag <t>`, `--suite smoke|critical|regression`,
`--all` (combined as a union). Options: `--env <name>` (default `environments.default`), `--device <id>`, `--label <text>`, `--fail-fast`, `--timeout <sec>`,
`--allow-emulator`, `--plan` (resolve everything, start no flow), `--strict` (exit 1 if any flow failed — for CI). Platform-specific flows
(`*.ios.yaml`, tag `ios-only`) are skipped on the other platform and listed as skipped. Cadence: smoke on PR/build, critical after deployment, regression nightly.

Before any flow starts the run: validates the selected flows (errors stop it), resolves every `${VARIABLE}` (missing names are reported, never values),
chooses the device (**never guessing between physical devices**, refusing emulator-only unless `--allow-emulator`), and verifies Maestro can read the
device and the app is installed. A `needsInput` reply says which answer is missing: relay it, do not work around it.

## What a run keeps

`reports/<runId>/`: `run.json` (platform, OS, device id/model/kind/transport, app id + version/build, environment, scope, Maestro version, timestamp, outcome),
`results.json`, `summary.md`, `summary.json`, `coverage.json`, `report.html`, `junit.xml` (per `reporting.formats`).
`artifacts/<runId>/<NN-flow>/`: `maestro.log` (secret values redacted), Maestro's debug output and screenshots, `hierarchy-at-failure.json`, a device
screenshot on Android failures. One folder per flow: **a failed flow never erases or stops the others**, and earlier evidence is kept.
`state/device-validation.json` is updated by every run (physical + a passing `smoke` flow = validated).

A run on an emulator/simulator is stamped as such in the reports and **never** counts as validation. If the device disappears mid-run the flow is a
`device` failure, the rest are `not_run`, the run is `incomplete`, and what already passed is kept.

## Failure categories (every failed flow has exactly one)

| Category | Typical evidence | What to do |
|---|---|---|
| **application** | an assertion about the expected outcome failed after the earlier steps worked; the app crashed or hung | confirm on the screenshot, then report as an application defect (steps, expected, actual, evidence). Never "fix" the flow. |
| **automation** | element not found by an action, YAML/command errors, unresolved variable, wrong appId | fix the flow or the config; selector problems → healer rules below |
| **device** | no/offline/unauthorised device, driver or gRPC connection lost, storage full | fix the device (`devices`, `device verify`), run again; do not retry blindly |
| **environment** | app not installed or cannot launch, backend/network unreachable, missing build | fix the build/install/backend; say which |

Each result carries `confidence` and `needsConfirmation`. A **low-confidence** reading (all assertion failures start there, as do timeouts and
unknown errors) must be confirmed before it is reported as an application defect: read the screenshot (Read tool) and the log excerpt, and the
failure command from `results.json`. If the screen is as expected but the element differs → automation; if the screen is wrong → application. If you
cannot tell, say `unclassified` and show the evidence. Do not turn an uncertain failure into a confident one in the summary.
`builder:maestro-flow-healer` Phase A can do this confirmation for several failures; the main session does it for one or two.

## Repairing a selector (bounded, guarded, audited)

Only for `automation` failures where the **same control** now has another identifier/label. Eligible: flows that still start with `# @builder:generated`.
Never for: hand-written flows, application defects, device/environment failures, navigation or behaviour changes (review the test case first),
or any change that adds/removes/weakens an assertion.

1. `MCLI inspect hierarchy --platform p --device d --name <screen>` on the screen the flow stopped on (or use `hierarchy-at-failure.json`).
2. `MCLI heal start <runId> --flow <file>` (snapshot; **2 attempts per flow per run**).
3. Edit only the `id` / `text` / `label` value of the selector that failed, to a value present in that hierarchy.
4. `MCLI heal check <runId> --flow <file> --evidence <hierarchy.json> --rationale "<what changed in the app and why it is the same control>"`.
   It reverts the edit by itself if anything other than such a value changed, a value is not on the real screen, or the evidence/rationale is missing.
5. Run the flow again (`run --flow <file> --label heal`), then `MCLI heal finish <runId> --flow <file> --result passed|failed --rerun <newRunId>`
   (a failed re-run restores the original). Everything is logged in `state/healing-log.json`.
If the control is gone or the navigation differs, stop: show the test case and the new screen to the user instead.

## Reports

`MCLI report build [runId]` rebuilds the reports of a run (default latest); `report list`; `report coverage [runId]` — every test case as automated
(with its result in this run) or not automated with the reason (`manual`, `needs_clarification`, `no_flow`, `blocked`, `flow_missing`);
`report formats [--set html,junit]` changes which optional reports are produced. Give the user the paths, not the contents.
Final messages: separate *tests passed* from *validated on a physical device*, list failures by category, state what is unconfirmed, and never call a
run successful unless `outcome` is `passed` and no flow was `not_run`.

---
name: mobile-run-tests
description: Run existing Maestro flows on a device — one flow, a test case, a feature, a suite (smoke, critical, regression) or everything — collect evidence, classify failures as application, automation, device or environment, and build the reports. No generation and no edits.
argument-hint: "[flow | --test ID | --feature name | --suite smoke|critical|regression | --all] [--platform android|ios] [--env name] [--device id]"
disable-model-invocation: true
---

# /builder:mobile-run-tests

The mobile counterpart of `/builder:run-tests`. Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) (asking the user, project root) and
[../maestro-execution/SKILL.md](../maestro-execution/SKILL.md) + [../maestro-setup/SKILL.md](../maestro-setup/SKILL.md) first.
`MCLI` = `node mobile-automation/tools/maestro-cli.mjs` from the project root.

> **Setup:** if `mobile-automation/state/scaffold.json` is missing, tell the user to run `/builder:mobile-init` / `/builder:build-mobile-automation`. A sandbox without USB access
> (Claude Cowork) cannot run on a phone: say so and stop.

1. **Scope.** From `$ARGUMENTS` (a flow path, `--test`, `--feature`, `--suite`, `--all`); if empty, ask: *Smoke suite (Recommended)* / *Critical* / *Regression* / *A single flow or test case*.
   **Platform:** `--platform`, else the single platform in scope, else ask. `MCLI run … --plan` first resolves flows, device, app version, variables and skipped platform-specific
   flows without starting anything; show it in two lines.
2. **Answer what the plan needs** (each is a `needsInput` reply, never worked around): `device` (several physical devices: ask which), `physical_device` (only an emulator or nothing: show
   `connectSteps`; running on an emulator needs the user's explicit *Run on the emulator anyway* and is labelled not-validation), `app_install` (offer `app install … --approved`
   only after a yes), `env` (names to add to `mobile-automation/.env`; wait), `platform`, `scope`. Validation errors in a flow are shown as file:line; this command does not edit flows.
3. **Run:** `MCLI run <scope flags> --platform <p> [--env <e>] [--device <id>] [--label <text>]`. It runs the flows one by one and keeps every flow's evidence.
4. **Triage** failures as [maestro-execution](../maestro-execution/SKILL.md) says: show category, confidence, failed command and evidence paths; confirm low-confidence ones from
   the screenshot and `hierarchy-at-failure.json` before saying "application defect"; this command makes no edits.
5. `MCLI validation status` if the run was a smoke run, so the user hears whether the platform is now validated on a physical device.

Finish with: run id, outcome, counts, per-flow results, failures by category, device (model, OS, kind), app build, environment, Maestro version, and the paths
`mobile-automation/reports/<runId>/report.html` / `summary.md` / `junit.xml` and `artifacts/<runId>/`. If any failure is an `automation` selector problem suggest
`/builder:mobile-heal-flows <runId>`; application defects are for the app team. Never call a run successful unless `outcome` is `passed`.

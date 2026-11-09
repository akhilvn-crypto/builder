---
description: Guided end-to-end Maestro mobile automation for the Flutter app. Discovers the project, checks Maestro/Android/iOS prerequisites (asking before installing anything), scaffolds mobile-automation/, turns supplied test cases into Maestro YAML flows with traceability, validates them, and proves the framework with a smoke flow on a real physical device.
argument-hint: "[test-case path] [--platform android|ios|both] [--app <flutter dir>] [--env <name>]"
disable-model-invocation: true
---

# /builder:build-mobile-automation

Builds and validates the Maestro mobile framework for the Flutter app in one guided flow. It is the mobile counterpart of
`/builder:do-automation`: it carries on step to step without asking "shall I continue?" and stops only for a choice that is the
user's, an install or device change that needs approval, a missing secret value, or a blocker. It is safe to run again: every step
looks at what already exists (scaffold, configuration, test cases, flows, validation) and only does what is missing or changed.

Arguments: `$ARGUMENTS`

You (the main session) are the orchestrator; this cannot run in a subagent because it asks questions and delegates to
`builder:maestro-flow-generator`. Mobile automation is **separate** from the Playwright framework: it never reads or changes
`automation/` or `dependencies/`.

## Read first

Read from the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes, using `scripts/mobile-init.mjs` as the file to find):

1. `skills/playwright-pipeline/environment.md`: how to ask the user (dialog or numbered chat question), project root, Cowork.
2. `skills/maestro-setup/SKILL.md`: preflight, installation approvals, devices, physical-device validation.
3. `skills/maestro-framework/SKILL.md`: structure, selectors, test design rules, test-case mapping.
4. `skills/maestro-execution/SKILL.md`: running, evidence, failure classification, reports.

Command shorthands (run from the project root `<root>`; quote paths; POSIX shell in Claude Code and Cowork alike):

- `PCLI` = `node "${CLAUDE_PLUGIN_ROOT}/template/mobile/tools/maestro-cli.mjs" --root "<root>"`: the plugin's copy, for discovery and
  preflight **before** the project has its own.
- `MCLI` = `node mobile-automation/tools/maestro-cli.mjs`: the project's copy, used for everything once step 2 has scaffolded it
  (it is the same code; CI uses it too). Every reply is JSON; exit 0 ok, 2 something is missing (see `needsInput`/`issues`), 1 error.

**Cowork:** a sandbox cannot see USB devices or run Android/iOS tooling. Do steps 1–3, 5 and 6 (discovery, scaffold and configuration, test
cases, flow generation and validation) if useful, say plainly that device steps need Claude Code on the machine the phone is
plugged into, and finish with the summary. Never report device validation from there.

## Ground rules

- Never invent: test cases, steps, expected results, app IDs, URLs, credentials or selectors. A step you cannot map to a real
  element becomes a recorded request or a blocked case, never a guess.
- **No installs and no device changes without a yes for that specific item.** Maestro, Java, Android SDK/adb, Xcode, installing the
  app build on the phone, USB debugging, certificates, signing. Explain what and why first. Record every decision with
  `MCLI setup record --tool <name> --action installed|declined|present --command "<what ran>"`.
- Never edit application code. Needed accessibility changes are documented (`semantics add`) for the Flutter team.
- Never mark the framework validated from an emulator/simulator run. Only a passing `smoke`-tagged flow on a real phone counts, per
  platform in scope (`MCLI validation status`).
- Secrets: names only in chat and reports; values live in `mobile-automation/.env`, which the user fills in. Never ask for a value in chat.
- Print one progress line per step: `[n/8] <step> … <status> — <short note>`.

## Step 1 — Project, prerequisites and answers (read-only until step 2: nothing is changed yet)

0. **Root.** Resolve `<root>` as environment.md says and `cd "<root>"` before every command.
1. `PCLI discover [--app <dir from $ARGUMENTS>]`. Report in a few lines: the Flutter app (root, name, version), Android application
   ID(s) and flavors, iOS bundle ID(s), build artifacts found (path, age), existing tests (integration_test, `.maestro/`), how many
   accessibility identifiers the Dart code already exposes (`accessibility.identifiers`), test-design output found, and whether a
   mobile framework already exists. If `ambiguous` or no app was found, ask which folder is the app (never choose). Flavors or an
   `applicationIdSuffix` change the installed ID: ask which variant is under test.
2. **Platforms in scope.** From `--platform`, else ask: *Android (Recommended if you have a phone)* / *iOS* / *Both*. iOS physical
   devices need a Mac with Xcode and a signed build; on another host say so now and ask whether to keep iOS in scope as *declared
   but blocked* (it is then reported as not validated, never skipped silently).
3. `PCLI preflight --platform <p> [--platform <q>]`. Show a compact table (tool, status, version, why it is needed). For every
   `missing` item follow `maestro-setup` "Missing prerequisites": explain the purpose, give the install hint, and ask permission
   **one dependency at a time**; act only on a yes, exactly as approved, then run preflight again. Required-but-declined items stop
   the flow as `blocked` with what to do. The Maestro capabilities in `capabilities` (which flags this installed version has) are
   what execution relies on; do not assume flags it does not list.

4. **What cannot be discovered.** Ask only for what is missing, in one grouped call (dialog or numbered chat question; confirm discovered values rather than retyping):
Android application ID / iOS bundle ID (confirm the discovered one), the variant and **build artifact** to test (APK / `.app` /
`.ipa`; offer the discovered builds; if none exists offer `flutter build apk --debug` as something the user may approve, never run
it unasked), the target **environment** name and any non-secret values its flows need (URLs: only ones the user gives you, for an
authorised test environment), and where the **test cases** are (`$ARGUMENTS` path, else `test-design/test-cases/`, else ask in chat;
Markdown in the canonical format or CSV; for Excel point to the pipeline's `input import` or an export to CSV).

`[1/8] discovery and prerequisites … done — <app>, <platforms>, <n> missing/approved`

## Step 2 — Scaffold and configuration

1. If `mobile-automation/state/scaffold.json` is absent: `node "${CLAUDE_PLUGIN_ROOT}/scripts/mobile-init.mjs" --root "<root>" --dry-run`, summarise
   `created`, then run it for real. If it exists and warns that `tools/` is older than the plugin, offer `--update` (it refreshes only
   `tools/`; the user's files are never touched). Exit 2 with `needsInput: "root"` → use one of `candidateRoots`.
2. `MCLI config save --json '<patch>'` with the answers (platforms enabled + identifiers + artifact, `environments.default`,
   `app.root`, `flows.appIdMode` stays `env` unless a previous run proved otherwise). Show `issues` if any and ask for just those.
   Write the environment file with the values the user gave: `mobile-automation/config/environments/<env>.json` (non-secret only).
3. `MCLI setup record --verified` stores the verified tool versions and Maestro capabilities.

`[2/8] scaffold and configuration … done — mobile-automation/, config valid`

## Step 3 — Test cases and change detection

1. `MCLI cases parse [--source <path>]`. Report total, valid, **needs clarification** (with reasons), **manual** (needs a person), and
   `problems`. No usable test case → `blocked`: ask the user to supply some; do not write scenarios yourself.
2. `MCLI env sync`: adds the secret/variable names the cases reference to `.env` and `.env.example` (empty). Tell the user the names;
   they fill the values in `mobile-automation/.env` themselves. Check with `MCLI env check` before a run.
3. `MCLI map plan`: what to generate, regenerate, review (hand-edited flows are never overwritten) and skip, and why.
   `MCLI identifiers scan --write` catalogues the accessibility identifiers the app already exposes.

`[3/8] test cases … done — <n> cases, <g> to generate, <m> manual`

## Step 4 — Physical device (before generating, so selectors can be read from the real screen)

Follow `maestro-setup` "Physical device". `MCLI devices --platform <p>`:

- A physical, authorised device → continue. Several → ask which (never guess). Only an emulator/simulator, or nothing → say
  exactly that, show `connectSteps` (or the device's `fix` steps for `unauthorized`/`offline`), **do not change device settings
  yourself**, and offer: *I connected a phone, check again* / *Continue without a device for now* (generation and validation go on;
  step 7 will then report device validation as **not done**).
- `MCLI device verify --platform <p> [--device <id>]` must pass (authorised, Maestro reads the screen, app installed). App missing:
  show the artifact and device, ask *Install it on this device?* and on a yes `MCLI app install --platform <p> --device <id> --artifact <path> --approved`.
  Never claim the app is runnable because the device is listed.

`[4/8] physical device … <status> — <model, OS, app version | not available: reason>`

## Step 5 — Generate the flows (representative flow first)

1. **Representative flow.** Pick one automatable case, preferring `smoke`-tagged and highest priority. Delegate it to
   `builder:maestro-flow-generator` (brief: the test case IDs, `deviceId` if step 4 passed, `platform`). Then
   `MCLI validate --flow <file>` and `MCLI map register --test <ID> --flow <file>` (the agent does these; verify). With a device,
   run it now (`MCLI run --platform <p> --test <ID> --label first`); a failure is triaged by `maestro-execution` before going on —
   most early failures are selectors or variables and are cheaper to fix on one flow than on forty.
2. **The rest**, one agent call per module (feature folder), sequentially (they share `flows/common/`). Give each only its test IDs.
   After each: `MCLI validate` for those flows, then check that `map register` was done for every file (`MCLI map status`).
3. `MCLI semantics list`: the Flutter accessibility changes requested so far.

`[5/8] flows … done — <n> generated, <b> blocked, <s> accessibility requests`

## Step 6 — Validate

`MCLI validate --maestro`. Errors block: show the file:line list and fix generated flows through the generator (never by hand-editing
user-owned flows, never by weakening an assertion or adding `optional`). Warnings are reported, not hidden. Run `MCLI map plan` once
more: everything should be `unchanged`.

`[6/8] validation … <status> — <errors> errors, <warnings> warnings`

## Step 7 — Smoke on the physical device, evidence and failure handling

Needs step 4 to have passed; otherwise `[7/8] … blocked` with the reason and the steps to connect a device (the framework is
**not** validated, and you say so).

1. `MCLI env check`; any `missing` names → tell the user which names to add to `mobile-automation/.env` and wait (names only).
2. `MCLI run --platform <p> --suite smoke [--env <name>] [--device <id>]` per platform in scope that has a physical device. Progress
   lines are on stderr. Show per flow result, then the category of each failure (application / automation / device / environment).
3. Triage as `maestro-execution` says: confirm low-confidence readings from the screenshot and `hierarchy-at-failure.json`; selector
   problems may go to `builder:maestro-flow-healer` (bounded; or tell the user to run `/builder:mobile-heal-flows <runId>`); application
   defects are reported, never "fixed"; device and environment problems are explained with the fix, not retried blindly.
4. `MCLI validation status`. A platform is **validated** only when a smoke flow passed on a physical device.

`[7/8] smoke on device … <status> — <passed>/<total>, run <runId>`

## Step 8 — CI readiness and summary

The CLI already is the CI command (`mobile-automation/README.md` lists the smoke / critical / regression stages and what the runner
needs). Do not configure CI or install anything for it without approval.

Final summary (short, in this order): what was created (`mobile-automation/`, config valid), **validation status per platform**
(validated on a physical device: model, OS, app build, run id; or *not validated* and exactly why), flows generated and the test-case
traceability (`MCLI report coverage`: N of M test cases have a flow, the others with their reason), the smoke run result and report
paths (`reports/<runId>/report.html`, `summary.md`, `junit.xml`; evidence in `artifacts/<runId>/`), failures by category, the Flutter
accessibility changes requested (`mobile-automation/docs/semantics-requests.md`), what is still waiting on the user (secret values,
a device, a declined install, test cases needing clarification), and the next commands: `/builder:mobile-run-tests`,
`/builder:mobile-heal-flows`, `/builder:mobile-generate-flows`, `/builder:mobile-reports`.

`[8/8] CI readiness and summary … done`

Never say the framework is complete or validated unless `validation status` says `fullyValidated: true`. Say what is true instead.

---
name: maestro-framework
description: Conventions for the Maestro mobile framework in mobile-automation/ — structure, ownership of flows, selector strategy for Flutter accessibility ids, how test cases map to flows with traceability, independent tests, test data and secrets, tags and suites, Android/iOS differences. Use when generating, reviewing or repairing Maestro flows.
user-invocable: false
---

# Maestro mobile framework conventions

The project's own copy of these rules, with an example, is `mobile-automation/docs/flow-conventions.md`. This skill is what the
generator and healer follow. CLI: `MCLI` = `node mobile-automation/tools/maestro-cli.mjs …` from the project root.

## Structure (adapt to the repository; never duplicate an existing one)

```
mobile-automation/
  tools/                 plugin-managed CLI (refreshed only by mobile-init --update)
  config/mobile.config.json   approved settings, no secrets (written only by `config save`)
  config/environments/<env>.json   non-secret per-environment values  → -e NAME=value → ${NAME}
  flows/common/          reusable subflows: launch-app, sign-in, navigation. Never run on their own.
  flows/<feature>/       one test flow per test case
  tests/<suite>.yaml     smoke / critical / regression: includeTags, excludeTags
  test-data/  docs/  state/  reports/<runId>/  artifacts/<runId>/<flow>/
  .env (git-ignored)     secrets → ${MAESTRO_<NAME>}
```

Maestro YAML flows are the tests. Keep each one focused; share journeys with `runFlow`; keep the test's intent and **its assertions in
its own file**. No generic abstraction layer over Maestro commands.

## Ownership and regeneration

A flow starting with `# @builder:generated …` is pipeline-owned: it may be regenerated when its test case changes, and repaired by the
healer. A flow without that line (hand-written, or the line removed) is never overwritten: `map plan` says `review`. `flows/common/*`
are created once and are the user's afterwards. Never delete a flow; a retired test case's flow is reported, not removed.

## Test cases → flows (traceability)

- Sources: Markdown in the canonical test-case format (`test-design/test-cases/*-testcase.md`, what test design writes) or CSV. `MCLI cases parse`
  normalises them into `state/test-specs.json` with a hash of each case's text. Read the case there; do not re-read and reinterpret the Markdown.
- One flow per automatable case: `flows/<feature-slug>/<id-lower>-<title-slug>.yaml`, feature = the case's module. Header comment
  `# testCase: <ID>` and `# source: <file>`; `name: "[<ID>] <title>"`. Register with `MCLI map register --test <ID> --flow <path>`
  (records the case hash and the flow hash; `map plan` uses them to find what changed and what a person edited).
- **Manual** (tag `manual`) and **needs-clarification** cases get no flow; `map register --status manual|blocked --reason "<why>"` keeps
  the reason. Never fill a gap in a case with an invented step or expected result: record it as blocked and say what is missing.
- Never copy secret values anywhere. `env:NAME` in a case → `${MAESTRO_NAME}`; `literal:value` → the value with a `# literal` comment
  (a deliberately fake or fixed value); a plain value → inline if ordinary, `inputRandomText`/`inputRandomEmail` when it must be unique.

## From steps to commands

| Step shape | Flow |
|---|---|
| "Open the app / login page" | `runFlow: ../common/launch-app.yaml` (+ `common/…` for navigation); every flow starts from a known state |
| "Tap / click X" | `tapOn` with the best selector for X |
| "Enter {v} in the Y field" | `tapOn` the field, then `inputText: <value or ${MAESTRO_…}>` (`hideKeyboard` if it covers the next target) |
| "Scroll to X" | `scrollUntilVisible` with the selector |
| inline `-> Expected:` / each Expected Result | one `assertVisible` / `assertNotVisible` / `assertTrue` per observable outcome, in this flow |
| a slow transition | `extendedWaitUntil` with a timeout on the element that proves it finished, never a fixed sleep |

A result that cannot be asserted through the UI (an email sent, a database row) is not asserted by guessing: record it as outside the flow.
A flow with no assertion is invalid; an assertion marked `optional` is invalid; never delete or soften one to get a pass.

## Selectors

Maestro finds elements through the accessibility tree. In order: (1) `id` = the Flutter `Semantics(identifier:)`; (2) a stable,
unambiguous label/text; (3) combined/scoped (`below`, `childOf`, text + enabled…); (4) `index` only with `# index: reason: …`;
(5) `point` only with `# coordinates: reason: …`. Flutter `Key` values are **not** accessibility ids.

Where selectors come from, in order of trust: `state/identifiers.json` / `identifiers scan` (ids found in the Dart code), `inspect hierarchy`
on the real screen (needs the app on a device), text quoted in the test case. Never invent an id. When a control has no stable id:
`MCLI semantics add --screen … --control … --suggested-id <snake_case_id> --reason … --test <ID>` → `docs/semantics-requests.md`, then use the
best honest provisional selector (the quoted text) with `# semantics-request: SEM-n` above the step; if there is nothing to select by,
the case is blocked. This asks the Flutter team to expose the control; it never hides the gap behind a fragile selector.

When a selector stops matching, decide first whether only the identifier changed or the business flow changed (healer rules in `maestro-execution`).

## Independent tests, data and state

- Each flow runs alone: it starts clean (`launch-app` clears state) and creates or signs in to what it needs through a shared subflow.
  A case with `Depends on:` is made independent by a subflow that sets up the prerequisite, never by relying on run order.
- Preconditions that need data (an account, a record) come from supported APIs/fixtures or `.env`; no shared mutable accounts hard-coded.
  If a precondition cannot be set up from the app or the config, the case is blocked with that reason.
- Secrets only as `${MAESTRO_NAME}`; environment values only in `config/environments/<env>.json`; neither in a flow, report or chat.

## Tags and suites

`regression` on every flow; `smoke` from the case's tags; `critical` for priority Critical and `high` for High; `security` and a feature
tag from the case. `android-only` / `ios-only` restrict a flow; `wip` keeps it out of suites. Suites in `tests/`: smoke (PR/build),
critical (post-deploy: critical+high), regression (nightly). Classification (tags) is separate from parallelism (`--device`) and from
platform configuration (`config`).

## Android and iOS

Share flows where behaviour matches (`appId: ${APP_ID}` is supplied per platform). `back` / `pressKey: Back` are Android-only and
`clearKeychain` is iOS-only: isolate them with `runFlow: { when: { platform: Android }, file: … }` or `*.android.yaml` / `*.ios.yaml`.
Do not assume one flow is identical on both.

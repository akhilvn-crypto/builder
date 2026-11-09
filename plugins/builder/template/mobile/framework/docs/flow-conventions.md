# Flow conventions

The rules every flow in `flows/` follows. `maestro-cli.mjs validate` enforces the ones that can be checked by a machine.

## Layout

```
flows/common/**          reusable subflows (launch app, sign in, open a section). Never run on their own.
flows/<feature>/*.yaml   one focused test flow per test case: tc-001-valid-user-can-sign-in.yaml
flows/<feature>/x.android.yaml, x.ios.yaml   a flow that only makes sense on one platform
tests/<suite>.yaml       suite definitions (includeTags / excludeTags): smoke, critical, regression
config/                  mobile.config.json (no secrets) and environments/<env>.json
test-data/               small non-secret fixtures
reports/<runId>/         summary.md, report.html, junit.xml, results.json, run.json   (git-ignored)
artifacts/<runId>/<flow>/  maestro.log, screenshots, Maestro debug output, hierarchy at failure   (git-ignored)
state/                   traceability.json (committed), scaffold.json, device validation and setup records
```

## A test flow

```yaml
# @builder:generated — owned by the pipeline (regenerated from its test case). Delete this line to take ownership.
# testCase: TC-001
# source: test-design/test-cases/US-001-testcase.md
appId: ${APP_ID}
name: "[TC-001] Valid user can sign in"
tags:
  - smoke
  - regression
  - critical
  - authentication
---
- runFlow: ../common/launch-app.yaml
- tapOn:
    id: login_email_field
- inputText: ${MAESTRO_TEST_USER_EMAIL}
- tapOn:
    id: login_password_field
- inputText: ${MAESTRO_TEST_USER_PASSWORD}
- tapOn:
    id: login_submit_button
- assertVisible:
    id: home_dashboard_title
```

- The `# testCase:` comment is the link back to the source test case. Test names carry the ID.
- `appId: ${APP_ID}`: the runner supplies the Android application ID or the iOS bundle ID for the platform it runs on.
  If your Maestro version does not accept variables in `appId`, set `flows.appIdMode` to `literal` (single shared identifier only).
- Each flow is independent: it starts the app clean (`launch-app`) and creates or signs in to what it needs. Never rely on
  another flow having run first.
- Keep intent and assertions in the test flow. Subflows do actions (launch, sign in, navigate); the expected results of the test case
  are asserted in the flow that owns them, one `assert*` per expected result.
- Wait for state, not time: `assertVisible` and `extendedWaitUntil` retry until the timeout. No fixed sleeps.

## Selectors, in order of preference

1. `id:` — the Flutter `Semantics(identifier: …)` exposed as accessibility id (resource-id on Android, accessibility identifier on iOS).
2. A stable, unambiguous visible `text:` / accessibility label.
3. A combined or scoped selector (`text` + `below`, `childOf`, …).
4. `index:` only when the order is stable — with `# index: reason: <why>` above it.
5. `point:` (coordinates) only as a last resort — with `# coordinates: reason: <why>`.

Flutter `Key` values are not visible to Maestro. If a control has no id, do not hide that with a fragile selector: record it with
`maestro-cli.mjs semantics add …` (→ `docs/semantics-requests.md`), use the best provisional selector and add
`# semantics-request: SEM-n` above the step. Inspect the real screen with `maestro-cli.mjs inspect hierarchy` (or Maestro Studio).

When a selector stops matching: first decide whether only the identifier changed or the business flow changed. Only the first is
a selector repair (proven against the real hierarchy, `heal start/check/finish`). If screens or navigation changed, review the
test case before touching the flow. Never retarget a selector to a different element to make it pass.

## Data and secrets

- Secrets and real accounts: `.env` → `${MAESTRO_<NAME>}` in the flow. A test case's `env:TEST_USER_PASSWORD` becomes
  `${MAESTRO_TEST_USER_PASSWORD}`. Never type a secret literally; the validator rejects it.
- Environment values (URLs, regions): `config/environments/<env>.json` → `${NAME}`.
- Ordinary test data: a plain value in the flow's `env:` header, or generated at run time (`inputRandomText`, `inputRandomEmail`)
  so a second run does not collide.

## Tags

`smoke`, `regression`, `critical`, `high`, `security`, plus a feature tag. The generator tags every flow `regression`; the test case's
own tags and priority add the others (Critical → `critical`, High → `high`). `android-only` / `ios-only` restrict a flow to a platform.
`wip` keeps a flow out of every suite. Suites select by tag in `tests/*.yaml`; running by tag is also possible with Maestro's own
`--include-tags` when the installed version supports it (`preflight` reports that).

## Android and iOS

Share a flow whenever behaviour matches. `back` and `pressKey: Back` are Android-only, `clearKeychain` is iOS-only: put them behind
`runFlow: { when: { platform: Android }, file: … }` or in a `*.android.yaml` / `*.ios.yaml` flow.

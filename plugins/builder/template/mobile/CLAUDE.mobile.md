<!-- builder-mobile:start -->
# Builder — Maestro mobile automation (plugin: builder)

Mobile automation for the Flutter app lives in **`mobile-automation/`** (Maestro YAML flows). It is separate from the Playwright
`automation/` + `dependencies/` folders and never touches them. `mobile-automation/tools/` is the plugin-managed CLI
(`node mobile-automation/tools/maestro-cli.mjs help`); everything else is the project's own.

Commands: `/builder:build-mobile-automation` (discover → prerequisites → scaffold → flows → validate → physical-device smoke → summary),
`mobile-init`, `mobile-generate-flows`, `mobile-run-tests`, `mobile-heal-flows`, `mobile-reports`.

## Hard rules

- **Maestro is the engine; YAML flows are the tests.** No Appium. Never edit application code.
- **No unapproved installs or device changes.** Maestro, Java, the Android SDK, Xcode, an app build on a phone, certificates, signing,
  USB debugging: explain what and why, ask, then act. Record decisions with `setup record`.
- Never invent test cases, steps, expected results, app IDs, URLs or credentials. Flows come from supplied test cases
  (`test-design/test-cases/*.md`, Markdown or CSV); a case that cannot be automated is recorded as blocked/manual with the reason.
- Selectors: accessibility `id` first, then a stable label/text, then a scoped or combined selector, `index` only with a written
  reason, coordinates only as a last resort with `# coordinates: reason: …`. A control without a stable id becomes a request
  (`semantics add`) for a Flutter `Semantics(identifier: …)`, not a fragile selector. Flutter `Key`s are not accessibility ids.
- Never weaken an assertion, mark it `optional`, or delete one to get a pass. Every test flow asserts its expected results itself.
- Secrets live in `mobile-automation/.env` (git-ignored) and are used as `${MAESTRO_NAME}`; environment values in
  `config/environments/<env>.json`. Never write either into a flow, a report or chat.
- A flow starting with `# @builder:generated` is pipeline-owned (regenerated or repaired by it). Remove the line to take it over.
  Hand-written flows are never overwritten. A repair may only change an id/text/label to a value proven on the real screen.
- **Physical device first.** Mobile automation is validated only by a passing smoke flow on a real phone for each platform in scope;
  emulator/simulator runs are reported as such and never as validation. iOS needs a Mac, Xcode and a signed build.
- Classify every failure: application, automation, device or environment. Do not call an assertion failure an app defect until the
  screenshot confirms it.
<!-- builder-mobile:end -->

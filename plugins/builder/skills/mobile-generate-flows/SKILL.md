---
name: mobile-generate-flows
description: Turn supplied test cases (test-design output, Markdown or CSV) into validated Maestro YAML flows with traceability — without running them. Detects changed test cases, never overwrites hand-edited flows, records blocked and manual cases with the reason, and lists Flutter accessibility changes needed.
argument-hint: "[test-case path] [--story ids] [--regenerate-changed]"
disable-model-invocation: true
---

# /builder:mobile-generate-flows

The mobile counterpart of `/builder:generate-tests`: parse → plan → generate → validate → register, with no execution. Read
[../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) (asking the user, project root) and
[../maestro-framework/SKILL.md](../maestro-framework/SKILL.md) first. `MCLI` = `node mobile-automation/tools/maestro-cli.mjs` from the project root.

> **Setup:** if `mobile-automation/state/scaffold.json` is missing, stop and tell the user to run `/builder:mobile-init` (or `/builder:build-mobile-automation`).
> If `MCLI config check` is not `valid`, send them to `/builder:build-mobile-automation`: flows need the application ID and platform.

1. **Which test cases.** A path in `$ARGUMENTS` is the answer. Otherwise the saved sources (`config.testCases.sources`), otherwise `test-design/test-cases/` if it exists,
   otherwise ask in chat (Markdown in the canonical format, or CSV). `MCLI cases parse [--source <path>]`; report total / valid / needs clarification (with reasons) / manual /
   `problems` (duplicate IDs, unreadable files, unknown `Depends on`). Nothing usable → stop and ask; never write test cases yourself.
   `--story US-001` restricts the work to cases of those stories (`storyId` in `state/test-specs.json`).
2. **Plan.** `MCLI map plan`. Tell the user in two or three lines: N new, N changed since their flow was generated (`regenerate`, only for untouched generated flows), N
   `review` (hand-edited flows, or removed cases: shown, never overwritten or deleted), N unchanged, N manual, N blocked. `--regenerate-changed` is the consent to regenerate
   the `regenerate` ones; without it, ask once before regenerating anything.
3. `MCLI env sync` (adds the variable names the cases reference to `.env`/`.env.example`; tell the user the names, never values) and `MCLI identifiers scan --write`.
4. **Generate** with `builder:maestro-flow-generator`: one call per module (feature folder), sequentially (they share `flows/common/`), each with only its test IDs, the
   action (`generate` / `regenerate`), the platform(s) from the config and, when the user has a verified device with the app, its `deviceId` so selectors can be read from
   the real screen ([../maestro-setup/SKILL.md](../maestro-setup/SKILL.md) "Physical device"). The first call takes one representative `smoke` case.
5. **Check the agent's claims.** `MCLI validate --flow <each file>` (errors must be zero), `MCLI map status` (every generated case registered), `MCLI map plan` (generated ones now
   `unchanged`). Errors go back to the generator with the finding list (max 3 rounds); never edit a user-owned flow to make validation pass and never weaken an assertion.
6. `MCLI semantics list` for the Flutter accessibility requests.

Finish with: flows written/regenerated (paths), cases blocked or manual with reasons, cases needing review, the accessibility requests (`mobile-automation/docs/semantics-requests.md`),
validation warnings still open, and the next step: `/builder:mobile-run-tests` (needs a device) or `/builder:build-mobile-automation` for the device validation.

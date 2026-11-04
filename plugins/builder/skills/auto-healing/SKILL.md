---
name: auto-healing
description: The safe, bounded repair workflow for confirmed script defects — attempt reservation, snapshot, minimal patch, assertion guard, typecheck, targeted rerun, audit record and automatic revert. Use when healing failed generated tests.
user-invocable: false
---

# Auto-healing workflow

Heal only failures where `failure-analysis.json` says `healingEligible: true` (a `script_defect` with high or medium
confidence, confirmed with evidence). The CLI enforces the limit (`healing.maxAttemptsPerTest`, at most 2 per test
per run) and refuses ineligible tests.

## One attempt

```bash
# 1. reserve an attempt + snapshot the file (refused when the limit is reached → report unresolved)
node dependencies/engine/cli/pipeline.ts heal begin <runId> <testId> --test-file tests/<file>.spec.ts
#    → { attempt, remaining, snapshot, rerunLabel }

# 2. minimal edit with the Edit tool: change only the broken locator/step, using current UI evidence

# 3. guard: the patch must not weaken assertions (exit 2 = violations)
node dependencies/engine/cli/pipeline.ts heal check <runId> <testId> --attempt <n> --test-file <file>

# 4. static check
(cd automation && npm run typecheck)

# 5. targeted rerun with no retries (skip if steps 3–4 failed)
node dependencies/engine/cli/pipeline.ts exec run <runId> --label <rerunLabel> --test-id <testId> --test-file <file> --retries 0

# 6. record (always, even after a guard failure); reverts the file unless outcome = healed
node dependencies/engine/cli/pipeline.ts heal record <runId> <testId> --attempt <n> --test-file <file> \
  --rationale "<what changed and the evidence>" --evidence <path> [--evidence <path>]
```

If the typecheck (step 4) fails, fix that within the same attempt or go straight to `heal record`, which reverts.
After `still_failing`, a second attempt needs **new** evidence or a different hypothesis. If you have neither, stop.

## What the guard enforces (`engine/pipeline/healing-guard.ts`)
- Matcher calls (`.toHaveText('X')`, `.not.toBeVisible()`, …) and their arguments are unchanged; the `expect(` count
  doesn't drop. The **subject** locator inside `expect(...)` may change.
- No added `test.skip/fixme/only/fail`, `waitForTimeout`, `catch`, `expect.soft`, `@ts-ignore`.
- The `[testId]` title prefix is kept. More than 25 changed lines is flagged as not minimal.

## Examples
- Button renamed "Login" → "Sign in" (fresh snapshot shows `button "Sign in"`): change the locator. ✅
- Heading text differs from the spec's expected text: **application defect**. Don't touch the assertion. ❌
- Strict-mode violation, two "Save" buttons: scope the locator to the dialog/region. ✅
- Service returns 503: environment issue, no edit. ❌

## Afterwards
`node dependencies/engine/cli/pipeline.ts heal finish <runId>` lists the healed files. Regression validation reruns every test in
those files (`exec run <runId> --label regression --test-file <f>...`). A healed test that fails regression is
reported as failed. Commits, shared test data and files without the `@builder:generated` header (handwritten tests) need explicit user approval.

---
description: Automation readiness only - judge which test cases can be automated with Playwright, what each needs first (preconditions, test data, environment values, dependencies, application workflows), and which must stay manual, with the reason. Reads the test cases from test design (or any path); writes nothing.
argument-hint: "[--story US-001,US-002] [--path <test-case file or folder>] [--override-manual ID,ID]"
disable-model-invocation: true
---

# /builder:automation-readiness

The readiness stage of the workflow, on its own. It is deterministic (a documented rule table in
`dependencies/engine/pipeline/readiness.ts`, no agent), so the same cases always give the same answer, and it changes nothing: it
neither imports test cases nor creates a run. `/builder:design-test-n-automation` and `/builder:generate-tests`
run the same assessment when they hand the cases over.

Arguments: `$ARGUMENTS`

Read [environment.md](../skills/playwright-pipeline/environment.md). If `dependencies/engine/cli/pipeline.ts` does not exist, stop and
tell the user to run `/builder:init` first. Run every command from the project root.

1. **Which cases.**
   - `--path <p>` (a file or folder of test cases in any supported format, relative to `dependencies/` or the project root):
     `node dependencies/engine/cli/pipeline.ts design readiness --path "<p>"`.
   - Otherwise the saved test cases of the design stages: `node dependencies/engine/cli/pipeline.ts design readiness [--story <ids>]`.
     If it says there is no `test-design/` output, offer `/builder:design-test-cases` (or `--path` for cases written by hand).
     Stories whose design is not saved yet are listed under `notHandedOver` with the command that finishes them.
   - `--override-manual ID,ID` is passed through when the user names cases they want automated anyway.
2. **Report** in this order, short:
   - Counts: automatable / automatable with prerequisites / manual / blocked, of the total.
   - **Manual** cases: id, title, and each reason in the rule's own words (CAPTCHA, a code sent outside the browser, a real mailbox,
     hardware, a subjective result, elapsed days, load or security tooling, declared manual). Say these are **not** handed to
     automation and are listed as manual in the final report; the user can still choose to automate one (`--override-manual`), and you
     must say honestly that such a case will usually need a test-environment workaround.
   - **Blocked** cases: id and what the case lacks (missing steps, expected result, undefined data...). The user fixes the test case
     (for design output: `/builder:design-resume` or edit the story's file), they are not manual.
   - **Prerequisites** of the automatable ones, grouped, not per case when many repeat: preconditions to arrange, dependency chains
     (they run in order; a failure blocks the rest), environment variable **names** with no value yet (to put in `automation/.env`;
     never ask for or print a value), data the cases create (cleanup applies), and the workflows seen (authentication, pages to open).
3. **Next step:** `/builder:generate-tests` (it hands the cases over by itself, generates the scripts and stops before
   execution) or `/builder:design-test-n-automation` for the whole way. Nothing was installed or changed.

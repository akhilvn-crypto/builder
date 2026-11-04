---
name: execution-and-diagnostics
description: Running Playwright Test through the pipeline CLI, execution labels, normalized result files, evidence (screenshots, video, trace, diagnostics) and failure classification categories. Use when executing tests, reading results, or triaging failures.
user-invocable: false
---

# Execution and diagnostics

## Running
`node dependencies/engine/cli/pipeline.ts exec run <runId> --label <label> [--test-file f]... [--test-id ID]... [--project p]... [--retries n]`

- Spawns the project-local Playwright CLI (in `automation/`) with `PIPELINE_RUN_ID`/`PIPELINE_LABEL`, so output goes to
  the framework folders: `automation/reports/<runId>/<label>/` (raw `results.json`, `html/`, `junit.xml`,
  `allure-results/`, `runner.log`) and `automation/test-results/<runId>/<label>/` (screenshots, videos, traces).
- The runner runs under a supervisor (`engine/tools/supervise.ts`): a timeout stops the whole process tree (browsers, workers, a web server
  the config starts), not just the runner, and anything the runner leaves running when it ends is stopped. What it started is listed in
  `dependencies/runs/<runId>/processes.json`, so `cleanup run <runId>` can still stop it if the supervisor itself was killed. A timeout is a
  `runnerError` ("timed out after …"); `runner.log` ends with a `[supervise]` line saying what was stopped. Only processes found below the
  runner are touched, never other browsers or servers on the machine.
- Normalized results stay with the run state in `dependencies/runs/<runId>/`: `execution-results.json` (label
  `initial`), `regression-results.json` (`regression`), `reruns/<label>.json` (anything else, e.g. `heal-TC-2-1`).
  Evidence and report paths in them are relative to `automation/` (e.g. `test-results/<runId>/initial/…/trace.zip`).
- `--test-id` greps titles starting with `[ID]`. Healing reruns use `--retries 0`, so a retry can't mask the result.
- Workers: `execution.workers` unset means a conservative 2 (not Playwright's CPU-based default); `execution.isolation` caps it (`serial` = 1;
  `per-worker-accounts` = the number of `NAME_1..NAME_N` accounts in `automation/.env`) and decides whether tests inside one file may run in
  parallel. The plan, with the reason for every limit, is in the `exec run` output (`executionPlan`), in the normalized results, and available
  beforehand from `exec plan <runId>`. The generated `playwright.config.*` carries the same defaults for a plain `npx playwright test`.
- Saved login (`auth.approach: storage-state`): before the run the pipeline checks the saved state (exists, well-formed, same origin, young
  enough, cookies not expired, accepted by the app when `auth.state.probePath` is set). The setup project runs first in every case: when the state
  looked usable it asks the application once and signs in again only if the session is refused (`authState.gate`: `reused` or `signed_in`);
  otherwise it signs in. A test that still ends on a login page (`finalUrl`, recorded by the diagnostics fixture) or fails as logged out is listed in
  `authState.lostLoginTests` and classified `test_data_or_precondition`: after a fresh sign-in that means the account, a session that ends early, or
  another test signing in or out as the same account. If a session the setup accepted is still rejected mid-run, it is discarded and the run repeated
  once (`authState.recovered`). A login that fails is a `runnerError` ("authentication setup failed"), not a pile of test failures.
  `auth check` explains the decision without printing secrets; `auth clear` removes the saved session.
- Order: tests tagged `@own-session` (they sign in themselves) run in the `own-session` project after all the others; dependent tests run in order
  in one serial group, and a test skipped because a test it depends on failed is listed under `blockedByDependency` in `triage run`, not counted as a
  failure of its own. `exec plan` shows both under `executionPlan.session`.
- Exit 0 = the runner worked (tests may still have failed). Exit 2 = `runnerError` (config error, crash, no tests,
  missing browser). That is an environment/config problem, never a test result. The execution stage is then `failed`.

## Outcomes
`passed` (first attempt) · `failed` · `flaky` (failed, then passed on retry: **never** counted as passed) · `skipped`.
Result key = `<testId>@<project>`.

## Reading evidence
1. `errors[0].message` and the call log: what was awaited, and whether the locator resolved ("locator resolved to …").
2. Screenshot at failure: did the page load, is there an error banner or a login redirect?
3. Trace (`cd automation && npx playwright show-trace <zip>`, or read actions/snapshots) for timing and navigation issues.
4. `diagnostics` attachment: console errors, page errors, failed requests, HTTP 5xx.
5. With the `evidence-pdf` reporter configured, each attempt also has a `final` screenshot attachment and a `step-evidence-log` JSON
   (per step: title, status, duration, error) in its attachments, plus Playwright's `video` (evidence.video is `on`). The first failed
   step in that log, the final screenshot and the video are usually the quickest way to see where a test diverged.

## Categories (`triage run`, then confirmed by the failure-healer)
| Category | Typical evidence | Heal? |
|---|---|---|
| `script_defect` | strict-mode violation; locator resolves to nothing while the control is visibly present under another name; script error | yes (high/medium confidence only) |
| `application_defect` | element found but value differs from the spec ("Expected … Received …"); control genuinely missing | no: keep failing, report |
| `environment_issue` | DNS/connection refused, 5xx, browser not installed | no |
| `test_data_or_precondition` | missing env var, expired auth state, missing seed data | no |
| `flaky_or_intermittent` | passed only on retry | no: report as flaky |
| `inconclusive` | no clear signal | no: report |

The heuristic is a starting point. Overrides need a rationale citing the evidence (`triage classify`).

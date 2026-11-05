# Stage playbook (shared by /builder:playwright-pipeline, /builder:design-test-n-automation, /builder:generate-tests, /builder:run-tests, /builder:heal-tests)

CLI: `node dependencies/engine/cli/pipeline.ts …` (abbreviated `pl` below), run from the project root. JSON on stdout; exit 0 ok, 2 not ready/invalid, 1 error.
Whenever a stage says "ask the user" (including relaying an agent's questions), do it as [environment.md](environment.md) describes: the
AskUserQuestion dialog when it works, a numbered chat question and a stop-and-wait when it does not (Claude Code and Claude Cowork alike).

Two sibling folders. `automation/` is the Playwright framework only; `dependencies/` holds the engine, test-case input and
run state. Paths follow one rule:

| Kind | Relative to | Examples |
|---|---|---|
| test files, page objects, evidence, reports | `automation/` | `tests/x.spec.ts`, `test-results/<runId>/initial/…`, `reports/<runId>/initial/html/index.html` |
| test-case input (`input.testCasesPath`, `--path`, `--input`) | `dependencies/` | `input/test-cases`, `input/test-cases/login.md` |
| run artifacts (registered with `--artifact name=path`) | the run directory `dependencies/runs/<runId>/` | `test-specs.json`, `exploration/exploration.json`, `summary.json` |

A path written from the project root (`automation/tests/x.spec.ts`, `dependencies/input/test-cases/login.md`) is
accepted and normalized by the CLI. Package installs and `npx` tools run inside `automation/` (`cd automation && …`).
Generated code uses the language chosen at init (`language` in the run config).

**Runs that start from test design.** The design stages (`/builder:generate-test-cases`; contract in
`agents/test-design-orchestrator.md`) write one validated Markdown file per story under `test-design/test-cases/` with their own
checkpoint in `test-design/state/`. They are not stages of the run: they come first, like importing test cases does, and keep their own
resumable state. `pl design handoff --apply` is the bridge: it checks the design output is unchanged since the design run recorded it,
judges automation readiness (`pl design readiness`; a documented rule table, no agent), imports the cases that can be automated into
`dependencies/input/test-cases/design/` and keeps the cases that need a person out (listed with the reason), and records
`dependencies/state/design-handoff.json` (story, criterion, scenario and case links). `pl run create … --design` (always on for
`/builder:design-test-n-automation`) snapshots that file into the run as `design-handoff.json`. From there the 13 stages are
exactly the ones below; the differences are only that the test-case path is `input/test-cases/design` and not asked, that
`design-test-n-automation` runs must register `designHandoff` when `test_analysis` completes (refused if the imported cases changed since
the hand-over) and `traceabilityReport` + `traceabilityMarkdown` when `report_generation` completes (`pl report build` writes them; `pl design
trace <runId>` rebuilds them), and that `pl run resume` prints a `design` block (`current`, `issues`). `pl design attach <runId>` refreshes a
run's snapshot after the hand-over was redone. Nothing here publishes anything; `/builder:publish-zephyr` is a separate manual command.

Every stage follows the same pattern:

```
pl run stage <runId> <stage> running
…work…
pl run stage <runId> <stage> completed --artifact <name>=<relPath> [...]   # validated by the CLI
```

`completed` is refused (`kind: "contract"`) when a required artifact is missing or invalid; the error lists exactly
what's wrong. Fix the cause and complete again, or set `blocked`/`failed` with `--message`. Never hand-edit artifacts
to pass a contract.

- **blocked**: needs the user (missing info, declined install, clarification). Stop and say how to resume.
- **failed**: an operation errored (runner crash, report generation failed). Stop and show the error.
- A failing **test** is not a failing stage.

Delegate with the Agent tool (`subagent_type` = `builder:<agent name>`, e.g. `builder:test-analyst`). Give the agent the `runId` and only the inputs
listed. Agents return a summary. Verify their claims with the CLI validators before completing the stage.

**Agents only where judgment is needed.** Before delegating a stage that may use an agent, ask the CLI:
`pl agents plan <runId> <stage>` → `{agent, invocations, reason, commands, briefs}`.
- `agent: null` → no agent: run the listed `commands` (if any) and go on; the reason is recorded.
- `agent: "<name>"` → delegate `invocations` times (parallel generation batches count separately), giving each agent **only**
  its run id and its brief (`briefs[]`, JSON under `dependencies/runs/<runId>/briefs/`). No logs, no earlier conversation.
- After each agent call: `pl agents record <runId> <stage> --agent <name> [--input-tokens n --output-tokens n]` (tokens only when
  you know them; they are never estimated). `pl agents show <runId>` summarizes.
**Test data the run created.** Tests register what they create with the `cleanup` fixture. With `cleanup.mode` `test` each test removes its own data
when it finishes; with `sweep` nothing is removed until the pipeline sweeps once every test has finished, by itself, after `execution`, `healing` and `regression_validation` and whenever a stage fails, blocks or is cancelled, and again in
`pl run finalize`. The reply carries a `data` block (`created`, `removed`, `leftovers`, `needsUi`, `lines`) only when the run created data.
- `needsUi > 0`: run `pl cleanup data <runId>` and give its `uiTasks` (a bounded list) to the **data-cleaner** agent, which removes each one
  in the UI and reports it with `pl cleanup resolve`. Do this once, after the last stage that runs tests; it is the only time that agent runs.
- `leftovers > 0`: **tell the user which records are still there and how they can be deleted** (the `lines`; the same list is in `summary.md`
  under "Test data"). Do not fail or block the run for them, and never describe the environment as clean.
- Cleanup only happens when the config has `cleanup.mode` `test` or `sweep` and the environment is on `cleanup.allowedEnvironments`
  (never production); otherwise everything created is listed as left behind, with the reason. `pl cleanup data <runId> --dry-run` shows
  what a sweep would do; `pl cleanup status <runId>` the counts.
**Automation coverage (every run, every command).** `pl report build` also writes `dependencies/runs/<runId>/automation-coverage.json` and the page
`automation/reports/<runId>/automation-coverage/index.html`: every test case the user brought, **automated** (a script exists and Playwright ran it; the
result column says passed / failed / flaky / healed) or **not automated** with a reason code, the cause in the record's own words and the next step.
Reasons: `manual` (readiness rules), `needs_clarification`, `invalid`, `not_in_run`, `not_generated` (the generator's exclusion text), `skipped`,
`not_run` (runner error), `run_stopped` (names the stage that blocked or failed). It also lists input the parser could not turn into cases at all.
It is a join of records the pipeline already keeps, so it is the only source for "how many cases were automated": never work the numbers out from
`summary.json` (which only knows cases that became specs) or from memory. Its reply is the `coverage` block of `report build` (`total`, `automated`,
`notAutomated`, `automatedPercent`, `byReason`, `html`). When a run **stops before `report_generation`** (a `blocked` or `failed` stage, or the user
cancelling), run `pl report coverage <runId>` anyway and give the page: the cases that never got a script are exactly what the user will ask about.
It is derived data and never fails a stage.

Always deterministic, no planning needed: preflight, configuration, input_validation, execution, regression_validation,
report_generation, finalization. Running tests is a CLI call; a runner error is reported, not "fixed" by an agent.

**Know what is already built.** Right after `specs parse` (stage 4), run `pl ledger plan <runId>`. Per test case it says what this run must
redo and why: `unchanged`, `re-review`, `redesign` (keep the evidence, only rebuild the test, e.g. after a plugin update changed the generator
rules), `explore` (the case or its evidence changed) or `new`. `work` counts what that costs (explorer snapshots, generator batches, reviewer
tests) and `causes` groups the reasons. Tell the user in one or two lines, e.g. "12 tests: 9 unchanged, 2 need redesign only after the plugin
update, 1 new". It is a preview from the same deciders the stages use: the stages still decide for real and nothing is skipped because of it.
A `redesign` test is not re-explored, and its generator brief points at the version already in the file to edit in place. `pl ledger show`
lists every automated test with where its evidence, test file and last execution are (`--test-id <id>` for one). The ledger updates itself when
`script_review` and `report_generation` complete and in `run finalize`.

**Reuse across runs.** `specs parse`, `generate plan`, `review static` and `review plan` consult the artifact cache
(`dependencies/state/artifact-cache/`): an artifact is reused only if everything it was derived from is unchanged (inputs and
column mappings, parser/schema, the plugin's generator/reviewer rules, the framework files a test imports, application evidence)
and it was validated; corrupt or edited entries are rejected. `--no-cache` bypasses it for one command, `generate plan --force`
regenerates everything. `pl cache status <runId>` shows hits and the reason for every rebuild. Execution results are **never** reused.

**Nothing left running.** The pipeline stops what it starts, without you doing anything: the Playwright runner and the report tools run under
a supervisor (a timeout stops the whole process tree, and leftovers are stopped when the command ends), and `pl run stage …` / `pl run resume` /
`pl run finalize` run `cleanup run <runId>` themselves when exploration ends, when any stage fails, blocks or is cancelled, on resume and at
finalization. It closes the run's `playwright-cli` session (named `explore-<runId>`) and stops what is left of its browser; it touches only
processes recorded for the run or sessions whose name contains the run id, never the user's own browsers or servers. A stage reply with a
`cleanup` block tells you what it stopped; `stillRunning` non-empty means something could not be stopped: report those process names and
pids to the user, do not claim the machine is clean. `pl cleanup run <runId> [--dry-run]` does it on demand; `pl cleanup all [--dry-run]` clears
leftovers of earlier crashed or abandoned runs (only when no pipeline is running). Never use `playwright-cli close-all` / `kill-all`.

| # | Stage | Inputs | Work | Complete with | Notes / failure |
|---|---|---|---|---|---|
| 1 | `preflight` | — | pipeline-setup skill §1 | — | Node too old → `failed` |
| 2 | `configuration` | preflight | pipeline-setup §2–3 (ask only missing fields, one approval per dependency); `pl run set-config <runId>` while running, **before** `run stage … completed` (completing without it is refused with `kind: "contract"`; run `set-config`, then complete the same run — never create a new run to get past it) | — | install declined / info missing → `blocked` |
| 3 | `input_validation` | config, `input/test-cases` (already imported before the run was created; see the skill's "Start or resume") | `pl input validate <runId> [--path p]` (the imported files; reads `.md`, `.csv`, `.xlsx`; the report shows how each CSV/sheet was read and the cases per module) | `inputValidation=input-validation.json` | exit 2 → show `report.errors`. An unrecognised spreadsheet layout is not the user's mistake: `pl input inspect`, then ask which header is which field and save it with `pl input map` (test-case-parser skill) instead of asking them to reformat. Otherwise `blocked` |
| 4 | `test_analysis` | input-validation | `pl specs parse <runId>` (cached; it also moves credentials, usernames and emails found in the test cases into `automation/.env`: relay its `env` block yourself, see "Credentials" below), then `pl agents plan <runId> test_analysis`. Agent **test-analyst** only when it names one (ambiguous cases, or a table that was skipped, left columns out, had two equally good columns for a field, or had columns read from their content). `specs parse` writes the canonical test cases (`canonical-test-cases.json`) and projects `test-specs.json` from them; `pl specs check <runId>` re-verifies that and lists the cases that are not automatable. Then `pl ledger plan <runId>` (see "Know what is already built") | `canonicalCases=canonical-test-cases.json` and `testSpecs=test-specs.json` (both); a `design-test-n-automation` run also `designHandoff=design-handoff.json` | relay its clarification questions to the user (AskUserQuestion), including column-mapping questions for a layout it could not read or read with two candidate columns (`ambiguous_column_mapping` holds back every case of that table until `input map` names one); never ask for credentials the test cases already contain. An `inferred_columns` warning is not a question unless the reading looks wrong: mention it and offer `input map` to confirm. If they fix the source, re-run the stage. If no case is `valid`/`warning` → `blocked`. Cases still needing clarification proceed as `blocked` tests; never edit `test-specs.json` by hand |
| 5 | `application_exploration` | test-specs, config | First `pl env check <runId>`: exit 2 → set the stage `blocked` and tell the user which names to fill in `automation/.env` (the `action` text), then stop. Then `pl explore plan <runId>`; when it lists `pagesToRevalidate`, run `pl explore snapshot <runId>` first: it takes the one snapshot per saved page itself (headless, navigation only, no agent) and revalidates every page that checks out; pages it cannot prove (redirected, a locator not on the page as loaded, `unavailable`) are left untouched for the explorer and `pagesLeft` names them. Then `pl agents plan <runId> application_exploration`: Agent **application-explorer** only for specs that must be explored or revalidated (the brief lists `knownPages`: saved pages a spec to explore probably visits; the explorer confirms them with one snapshot and refers to them as `saved:<key>` instead of re-observing them; when every spec is `reuse` (revalidated in this run) or `covered` (unchanged, with a still-current generated test: no snapshot needed), run `pl explore assemble <runId>` yourself (no fresh.json is needed then); `pl explore plan <runId> --revalidate` forces snapshots instead of `covered`); before delegating, ask the user about any destructive step the specs require and pass the answer on | `exploration=exploration/exploration.json` (written by `pl explore assemble`) | app unreachable/login fails → `blocked` (environment). `exploration.tool = none` → `skipped` with reason; the generator then marks locators low-confidence |
| 6 | `test_generation` | specs, exploration | `pl generate plan <runId>` (per test: generate or reuse, with reasons; one batch per module file), `pl agents plan <runId> test_generation`, then one Agent **playwright-generator** per batch, **in parallel**: each batch owns its module file (`tests/<moduleSlug>.spec.<ext>`, from `specs modules`) and writes `generation/manifest-<batchId>.json`. Then `pl generate assemble <runId>` and `pl generate validate <runId>` | `generationManifest=generation-manifest.json`, `generationReport=generation-report.md` | `assemble` refuses two batches that wrote the same file, test or shared file: rerun those batches one after another. Nothing to generate → no agent, just `assemble` |
| 7 | `script_review` | generated files | `pl review static <runId>` (the typecheck is cached), `pl review plan <runId>`, `pl agents plan <runId> script_review`. Agent **test-reviewer** only for tests without a valid earlier review. Critical findings or typecheck errors → **playwright-generator** fixes (pass the findings; one writer per file) → `review static` again. Max 3 rounds. Before completing: `pl review seal <runId>` (records what passed so the next run can skip it) | `reviewReport=review-report.json` | still failing after 3 rounds → `failed`, list the findings. `seal` refuses while a needed semantic review was not recorded, or a skipped test changed (`review plan` again) |
| 8 | `execution` | reviewed tests | You, directly: `pl exec run <runId> --label initial` (all generated tests, or the paths given); `pl exec plan <runId>` first shows the workers/isolation and the saved-login decision. No agent | `executionResults=execution-results.json` | `runnerError` → `failed` (not a test failure); a failed login setup is a `runnerError` too |
| 9 | `failure_triage` | execution results (this run or `sourceRunId`) | `pl triage run <runId>`, then `pl agents plan <runId> failure_triage`: Agent **failure-healer** Phase A only for the failures it lists (not high-confidence clear-cut ones) | `failureAnalysis=failure-analysis.json` | no failures → still complete (empty analysis) |
| 10 | `healing` | failure analysis | no eligible failures → `skipped` ("no eligible script defects"). Else `pl agents plan <runId> healing`, then Agent **failure-healer** Phase B per eligible test, one after another (tests in the same file never in parallel) | `healingLog=healing-log.json` | the healer must run `pl heal finish`. A healed test's cache entry is updated automatically |
| 11 | `regression_validation` | healing log | nothing healed → `skipped`. Else you, directly: `pl exec run <runId> --label regression --test-file <each healed file>` (no agent) | `regressionResults=regression-results.json` | runner error → `failed` |
| 12 | `report_generation` | everything above | `pl report build <runId>` (also builds the `extent` and `evidence-pdf` reports when chosen) | `summary=summary.json`, `summaryMarkdown=summary.md`, `automationCoverage=automation-coverage.json` (optional but always register it: it is validated when present); a `design-test-n-automation` run also `traceabilityReport=traceability-report.json`, `traceabilityMarkdown=traceability-report.md` | exit 2 (reporter failed / runner error) → `failed` with the reporter details; read `reportGeneration` (reporters that did not produce their files) separately from `counts` (test outcomes); the summary files still exist for the user. `evidence-pdf` with status `missing_dependency` (Chromium / `@playwright/test`): ask for approval for that dependency, record it, then run `pl report build` again |
| 13 | `finalization` | summary | `pl run finalize <runId>` (its `cleanup` block is the final check that nothing of the run is still running) | — | refused until counts are recorded |

### Credentials

Credentials, emails and usernames are never asked for in chat. `pl specs parse` takes them from the test cases, writes
them to `automation/.env` and puts only variable names in `test-specs.json`. Tell the user in one line what happened
(names only, e.g. "Added TEST_EMAIL and TEST_PASSWORD to automation/.env from the test cases"). The only time you involve
the user is when `env.missing` / `env check` lists names with no value anywhere: say which names to fill in `automation/.env`
(the empty entries are already there), mark the stage `blocked`, and give the resume command. After they confirm, run
`pl env check <runId>` again before continuing. Execution (stage 8) is gated the same way if `env check` still exits 2.
If `env.keptExisting` is non-empty, mention it: the value already in `.env` is used instead of the one in the test case.

Progress line after each stage: `[n/13] <stage> … <status> — <short note>`.

Final message: run id and status (`pl run show <runId>`); **the automation coverage first** (below); the counts table (total / passed / failed /
flaky(recovered) / healed / blocked / skipped / unresolved); failure categories; healing attempts; unresolved tests
with reasons; paths to `dependencies/runs/<runId>/summary.md`, the HTML report (`automation/reports/<runId>/initial/html/index.html`), the Allure report if any, the Extent report if chosen (`automation/reports/<runId>/extent-report/index.html`), the evidence PDF if chosen (`automation/reports/<runId>/evidence-report/evidence-report.pdf`; also name any evidence gaps its status detail reports), and the evidence folder `automation/test-results/<runId>/`.
**Automation coverage** (from `report build`'s `coverage` block or `pl report coverage <runId>`): "N of M test cases automated (x%): P passing, F failing/flaky/healed",
then, for the K that were not automated, one line per reason with its count and the meaning (`REASON_MEANING` in `automation-coverage.ts`, repeated on the page), then each
not-automated case as `<id> — <reason label>: <the reason's detail>` (at most 15, then "and N more on the page"; the page lists all of them with the next step), and
`inputProblems` if any. End with the page path `automation/reports/<runId>/automation-coverage/index.html`. A failing script is still an automated case: say that
it needs attention, not that it is missing. Say nothing about coverage that the report does not contain.
Add what was reused (`pl cache status <runId>`) and which stages needed no agent (`pl agents show <runId>`).
Say which test data is still there (`pl run finalize`'s `data` block, or `pl cleanup status <runId>`): how many records were created and removed, and each
leftover with how it can be deleted; if the run created none, say nothing about it.
Say whether anything was left running: from `pl run finalize`'s `cleanup` block (`stopped`, `sessions`, and `stillRunning`, which must be empty
for "nothing left running").
To judge a change to the pipeline or its settings, run the same suite again and `pl run compare <baselineRunId> <runId>`: it checks that no test went missing or got worse before it believes a speed-up.
Never call a run successful unless its status is `completed`, and never present a flaky pass as a pass.

---
description: Run selected Playwright tests, publish the results that say something reliable about the application (passes and confirmed application defects) to a Zephyr Scale Test Cycle in plain, human-written wording, and create and link Jira bugs for confirmed defects. Flaky, script, environment and unclassified failures are not sent to Zephyr but are listed with their reasons in an HTML report. A separate, manually invoked QA action - no pipeline or workflow ever runs it. Runs Playwright, Jira and Zephyr preflight checks first, never fabricates results, and never duplicates executions or bugs.
argument-hint: "[test file | folder | --tag @smoke | --story US-001 | --all] | resume"
disable-model-invocation: true
---

# /builder:update-execution-result

Arguments: `$ARGUMENTS`

**Manual invocation only.** A QA action the user starts by typing it. `/builder:do-automation`, `/builder:design-test-n-automation`, `/builder:generate-test-cases`, every other command, the orchestrators and every agent never run it, never offer to run it on their own and never pass it a scope. If you reached this command from any other workflow rather than from the user typing it, stop and say so.

The plugin is named `builder`, so the command is `/builder:update-execution-result` (the specification calls it `/automation-builder:update-execution-result`). It does not generate or change test cases or tests, and it never fixes the application. It does not heal tests either: the failure-healer is used for Phase A (confirming classifications) only.

You (the main session) are the orchestrator: you ask the questions, call the Jira connector, and delegate failure confirmation to a subagent.

## Read first

Read from the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as [environment.md](../skills/playwright-pipeline/environment.md) describes):

1. `skills/playwright-pipeline/environment.md`: how to ask the user in Claude Code and Cowork, where the project root is.
2. `skills/execution-result-publishing/SKILL.md` (it cannot be loaded any other way): the exact script calls (`ER`), status mapping, bug rules and recovery. `PY` is the first of `python`, `python3`, `py -3` that runs; `SCRIPTS` is `${CLAUDE_PLUGIN_ROOT}/test-design/scripts`. `pl` = `node dependencies/engine/cli/pipeline.ts`, always run from the project root with `cd "<root>"`.
3. `skills/execution-and-diagnostics/SKILL.md` for how results and failure categories are read.

Project root `<root>` = the folder holding `automation/` and `dependencies/`. If `dependencies/engine/cli/pipeline.ts` is missing, stop and tell the user to run `/builder:init` (or `/builder:do-automation`). Never print the Zephyr token. At the first failed check **stop**, say in plain words what is wrong and the concrete steps to fix it, and do not run later stages.

If `$ARGUMENTS` starts with `resume`, go to **Resume**.

## Stage A: Preflight (nothing is executed or published yet)

1. **Playwright.** `pl preflight` must report ready and `pl config check` a valid configuration (otherwise point to `/builder:playwright-pipeline`, which sets it up). A missing dependency is offered for approval **one at a time** and installed only after a yes, as `pipeline-setup` describes; this command never installs on its own.
2. **Jira connector.** Confirm the Atlassian/Jira connector is available and authenticated (for example by listing accessible Atlassian resources and taking the `cloudId`). If not, stop: tell the user to connect and authenticate the connector. Do not ask for Jira credentials.
3. **Project.** List the Jira projects the user can access (`listJiraProjects`; use `discover` for the exact operation if needed), show key and name, and ask which one holds the Zephyr project and the bugs. Never choose for them, even with a single project. This is `<KEY>`.
4. **Zephyr.** `ER preflight --project <KEY>` checks the settings, reachability, token, project access and that the status names exist. Relay `warnings`. Only two Zephyr statuses are ever sent, Pass and Fail. If `errors` name one that is missing, show the available names and ask which to use; pass them as `--status-pass` / `--status-fail` from here on (to `preflight` again, then `begin`).
5. **Scope.** From `$ARGUMENTS`: a path (file or folder) -> `--test-file`; `--tag @x` -> `--tag`; `--story US-001` -> the case IDs of that story from `dependencies/state/design-handoff.json` (`stories.<id>.caseIds`) as `--test-id`; `--all` -> everything. If nothing was given, ask what to execute: an individual test file, a directory, a story's tests, a tag, or the full suite. Then `mkdir -p automation/execution-results` and `pl exec list <scope flags> > automation/execution-results/scope.json`. Exit 2 means the scope selects nothing or Playwright could not list: show `error`, stop. Tell the user how many tests it selects (and any `untagged` / `duplicateIds`).
6. **Mapping.** `ER map --project <KEY> --scope-file automation/execution-results/scope.json`. If `problems` is empty, go on. Otherwise show each problem with its message and ask: *Stop and fix the mapping (Recommended)* or *Continue with only the mapped tests*. On the second, narrow the scope to the mapped test IDs (rebuild the scope flags with `--test-id`, run `pl exec list` again) and pass `--only-mapped` to `begin`; the unmapped tests are neither run nor published, and the report names them. A hand mapping is `ER map --project <KEY> --scope-file ... --set TC-1=<KEY>-T101`, only if the user gives you the key.
7. **Test Cycle.** Ask: *Create a new Test Cycle (Recommended)* / *Use an existing Test Cycle*. New: ask the name (suggest `Automation run <date> - <scope>`). Existing: `ER cycles --project <KEY> [--name TEXT]`, show the latest, let the user pick or type a key (`PROJ-R12`).
8. **Confirm.** Show one summary (project, N tests and the scope, application environment from the config, the Test Cycle, the Zephyr status names) and ask *Start* / *Change something*. Then `ER begin --project <KEY> (--cycle <K> | --new-cycle "<name>") --scope-file ... --scope-text "<scope in words>" [--only-mapped] [--status-pass N --status-fail N]`. `RUN_IN_PROGRESS` means an earlier update is unfinished: offer **Resume** or `ER abandon`.

## Stage B: Execute and capture

Run the same stages as `/builder:run-tests`, as `skills/playwright-pipeline/stages.md` describes them: `pl run create --command run-tests`, then `preflight`, `configuration`, `execution`, `failure_triage`, `report_generation`, `finalization` (update each with `pl run stage`).

- `execution`: `pl exec run <runId> --label initial` with the same scope flags as step A5 (and the narrowed `--test-id` list if you narrowed it). A `runnerError` (no tests ran, a crash, a failed login setup) fails the stage: **stop here, capture and publish nothing**, show the error and log path. Failing tests are not a runner error.
- `failure_triage`: `pl triage run <runId>`, then `pl agents plan <runId> failure_triage` and the **failure-healer** agent for Phase A only (confirm classifications with evidence via `triage classify`). Tell it: no healing, no edits, and mark `application_defect` only when the evidence shows the application misbehaves (wrong business result, crash, unexpected error / 5xx), with a rationale. Phase B never runs in this command.
- Then `ER capture --pipeline-run <runId>`. Show the plan table (test, Zephyr key, class, will it be sent to Zephyr, bug eligible). **Only a pass and a confirmed application defect are sent.** Flaky runs, script / locator / test-data / login problems, environment problems, skipped tests and failures nobody has classified are *held back*: they are not written to Zephyr, they stay in the local record and they appear in the HTML report with the reason. Say this plainly in the table ("not sent: flaky").
- Tests classed `needs_investigation` that look like application defects: show each with its error and evidence and ask which, if any, the user can confirm as application defects (multi-select; the default is none). For each confirmed: `ER classify --test <KEY> --category application_defect --confidence high --rationale "<what the user said>" --by user` (it is then sent as Fail and gets a bug draft). Never decide this for them. The ones left alone stay held back.
- **Write the accounts, in your own words, before publishing.** For every result that will be sent, passes included: a pass records what was observed, not only "nothing went wrong" (for a pass write what the page showed at the checked points, e.g. "The cart total read 5 after the second item was added and the confirmation banner appeared."; if you did not see the evidence, leave it and the script uses the test case's expected results). For every result that will be sent as Fail (and so for every bug), look at the evidence (read the error, the test specification and the screenshot with the Read tool) and record what a person using the application would have seen: `ER narrate --test <ID> --actual "<what happened>" --summary "<bug title>"`. Write it the way a tester writes it in a ticket:
  - one to three plain sentences, past tense, concrete values ("After adding the second item the cart total still showed 4 instead of 5.");
  - the title names the symptom in under about 100 characters ("Cart total does not update after adding a second item"), not the test name and not "X fails";
  - say only what the evidence shows; if the evidence does not show what the page looked like, say less rather than guess a cause;
  - no tool or framework words (Playwright, locator, selector, expect, timeout, assertion, stack), no test IDs, no run IDs, no "automated"/"AI"/"generated" wording. The script refuses text that looks like a pasted tool error.
  A passing result without an account still gets the "Actual result" line, built from the test case's expected results.

## Stage C: Publish to Zephyr

`ER publish`. It sends the passes and the confirmed defects to the selected Test Cycle (no execution is created twice; held-back results are skipped), then attaches the evidence it has. Show per test: Zephyr key, status, executed or not, and how many results were held back. Report evidence honestly (`uploaded`, `unsupported` = this deployment does not take attachments, `skipped`, `missing`). For `unknownOutcome` results explain that a reply was lost, ask the user to look at the Test Cycle in Zephyr, and run `ER resolve --test <RESULTKEY> --execution-id <ID>` (it is there) or `--retry` (it is not); then `ER publish` again. Exit code 1 means something is not published: read `recovery`.

## Stage D: Jira bugs and links

1. `ER bug-drafts`. For every `needsCheck` item search Jira first: `searchJiraIssuesUsingJql` with `labels = "<marker>"`. Found -> `ER bug-record --test <ID> --key <KEY> --issue-id <numeric id>`; not found -> `ER bug-reset --test <ID>`; then `ER bug-drafts` again.
2. No drafts -> say no application defect was confirmed and skip to Stage E.
3. A draft with `needsWriting` set was not written by hand yet: do Stage B's `narrate` for it first and run `ER bug-drafts` again. Show each draft: summary, priority (or the note that none is known), what is *not available* (tell the person; the Jira text just leaves those parts out and never invents them), and any `previousBugs` (look each up with the connector; if one is still open, ask whether to reuse it instead of filing another, and if reusing, record it with `bug-record` and do not create). Ask: create all / choose which / none (`ER bug-decline --test <ID> --reason ...` for the ones not created).
4. Look up the project's Bug issue type, its required fields and any template with the connector (`discover` for the field-metadata operation). Required values you cannot take from the draft are asked from the user; do not invent them.
5. Per bug, in this order: `ER bug-start --test <ID>` -> `createJiraIssue` (project `<KEY>`, the project's Bug type, `summary` and `description` exactly as drafted, `contentFormat: markdown`, `labels` exactly as drafted (the marker label only; add none of your own), `priority` only when the draft has one that Jira accepts, required `additional_fields`) -> take the numeric issue ID from the result (`getJiraIssue` if it is not in it) -> `ER bug-record --test <ID> --key <KEY-n> --issue-id <id>`. A clear rejection (validation error): `ER bug-failed --test <ID> --error "<message>"`, show it, and offer to fix and retry. A timeout or unclear failure: leave it (do **not** retry blindly); step 1 handles it on the next pass. Evidence files are attached only if the connector has an attachment operation; otherwise tell the user the paths listed in the bug must be attached by hand.
6. `ER link-bugs`. A link failure keeps the bug; run it again later (it never creates a bug).

## Stage E: Completion report

`ER report --write` (it writes the Markdown report and a self-contained **HTML report**, `htmlReportFile`), then show (keep it short, tables where they help):

- Scope, project, Test Cycle (key, name, new or existing), update run ID, pipeline run ID.
- **Test execution**: total, passed, application failures, automation issues, infrastructure issues, flaky, needs investigation, skipped. State plainly whether the *tests* passed.
- **Publishing**: per test the Zephyr key, status and published/failed/unknown; evidence counts; Jira bugs created (keys) and the Zephyr link status per bug.
- **Held back from Zephyr**: each test that was not sent, with its reason (flaky, script issue, environment, skipped, needs investigation). Tell the person the HTML report (`htmlReportFile`) lists every result including these, with the plain-words account, the full error and the evidence links, and that the Playwright HTML report is linked from it.
- Anything not published or not linked, with the recovery steps from `recovery` (and `/builder:update-execution-result resume`).
- Locations: `automation/execution-results/` (state, history, report), the Playwright reports and evidence folder from `locations`.

Always separate *test execution success* from *result publishing success*: green tests with failed publishing is not a clean finish, and failing tests that were published and bugged correctly is not a publishing failure. Results held back on purpose are neither: they are reported, not pending.

## Resume

`ER status`. No update run -> say so and offer a new one. Otherwise continue from what is open, **without running the tests again** unless `captured` is false and no pipeline run produced results:

- captured: skip Stage B; continue with `publish`, the bug steps, `link-bugs` (each only does what is missing).
- not captured but the pipeline run finished its `execution` stage: find it (`pl run list`, the newest `run-tests` run) and confirm with the user, then `ER capture --pipeline-run <id>`.
- `RUN_IN_PROGRESS` / unknown outcomes: handle as in Stages C and D.

Never edit `execution-run.json` or the history by hand, and never delete a Zephyr execution, cycle or Jira bug.

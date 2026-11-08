---
name: test-report-building
description: Build the ISO test-case workbook and the test-report workbook from the test executions recorded in Zephyr Scale (Cloud), into "Test artifacts ISO", with one Executed-On (IST) / Result column pair per execution so earlier and later results of a test case can be compared. Read-only towards Zephyr. Use in /builder:build-test-reports.
user-invocable: false
disable-model-invocation: true
---

# Test report building

Separate from test-case generation, from every pipeline command and from the commands that write to Zephyr: nothing here runs unless the user types `/builder:build-test-reports` (the model may not load this skill by itself; that command reads this file). `PY` / `SCRIPTS` as in `story-source-discovery`; `RP` = `PY SCRIPTS/zephyr-reports.py <subcommand> --root <project root> --project <KEY>`. All scripts print JSON; the Zephyr token never reaches you, a file or a message.

## Division of labour

- **`zephyr-reports.py` (deterministic):** reads Zephyr Scale with GET requests only (it can neither create nor change anything there), converts times to IST, decides statuses, and fills copies of the two bundled Excel templates. It shares the Zephyr settings (`ZEPHYR_BASE_URL`, `ZEPHYR_API_TOKEN` from the environment, else `<root>/.env`) and HTTP layer with the other Zephyr scripts. Zephyr Scale **Cloud** REST API v2 only.
- **Jira connector (you call it):** Zephyr only stores Atlassian account IDs and numeric issue IDs. You turn them into names, Jira keys, summaries and issue types and hand them over in a lookup file. No separate Jira credentials, ever. The script never contacts Jira.
- **You never edit a workbook.** A wrong workbook is fixed by building again.

## Script calls

| Purpose | Call |
|---|---|
| Zephyr config / token / project, openpyxl, templates, output folder | `RP preflight` |
| Test Cycles with how much was executed, newest first | `RP cycles [--limit N]` |
| Read Zephyr into a local snapshot | `RP fetch (--cycle KEY ... \| --all-cycles)` |
| Write both workbooks | `RP build [--lookup-file F] [--cycle KEY ...] [--out-dir D]` |

`RP preflight` also takes `--testcases-template F` / `--report-template F` (and so does `build`) to use other copies of the templates; the plugin carries the two ISO templates in `${CLAUDE_PLUGIN_ROOT}/test-design/templates/` (`testcases-template.xlsx`, `test-report-template.xlsx`).

Errors arrive as `{"ok": false, "error": {"code", "message"}}`; relay the message and the fix in plain words. Common: `CONFIG_MISSING`, `AUTH` (token wrong or expired), `PROJECT_NOT_FOUND`, `OPENPYXL_MISSING` (ask before installing), `NO_CYCLE`, `CYCLE_NOT_FOUND`, `NO_EXECUTIONS`, `FILE_MISSING` (build before fetch), `FILE_IN_USE` (a workbook is open in Excel: ask the user to close it, then build again), `TEMPLATE_MISSING`.

## The lookup file

`fetch` and `build` return `needsLookup`: `accountIds` (people) and `issues` (`issueId`, sometimes `key`, and what is `need`ed). Resolve them with the connector and write `<root>/automation/execution-results/report-build/lookup.json`:

```json
{"users":  {"<accountId>": "Display Name"},
 "issues": {"<numeric issue id>": {"key": "PROJ-12", "summary": "…", "type": "Story"}}}
```

- People: the connector's user lookup by account ID (`getPeopleInfo`; use `discover` for the exact operation if needed). Display names only; no e-mail addresses.
- Issues: `searchJiraIssuesUsingJql` with `id in (…)` (or `key in (…)`) asking for `summary` and `issuetype`; `getJiraIssue` for a single one. `type` is the Jira issue type name as returned (a type containing "Bug" or "Defect" makes the issue a defect of the test case; anything else is treated as its user story).
- Write only what the connector returned. An ID you cannot resolve stays out of the file and the workbook leaves that cell empty. Never guess a name, a key or a summary.

## What the workbooks contain

Output folder: `<root>/Test artifacts ISO/`.

**`<KEY> - Test Cases.xlsx`** (from the test-case template; a living file, rebuilt each time): sheets *Document Control*, *Version History* (untouched, apart from title and description), *Testcases* and *Test Suite*.
- *Testcases*: the template's columns A-N, one row per test case that has an execution in the selected Test Cycles, grouped under blue section rows (the story it covers, else its Zephyr folder). Test Case ID is the source case ID where the project knows it (else the Zephyr key). Status (H) is the **latest** result; Comments is that execution's note; Executed By and Executed On (M, all dates) come from the executions; Execution Defects are the Bug issues linked to the case (keys from the connector, or from bug records of earlier result updates).
- Then, added to the template: **Zephyr Test Case** (the key), **Latest vs Previous Result** (`REGRESSION: PASS (07-11-2026) -> FAIL (08-11-2026)`, `FIXED: …`, `No change (PASS)`, `First execution (…)`) and, **for every execution of every test case in order, two columns: `Execution n - Executed On (dd-mm-yyyy hh:mm:ss IST)` and `Execution n - Result`** (a cell note names the Test Cycle and the person). A run executed tomorrow adds a pair on the next build; earlier pairs never change. The history of a test case includes its executions in **all** Test Cycles of the project, not only the selected ones, so yesterday's result is there when only today's cycle is selected.
- *Test Suite*: one block per selected Test Cycle, one row per test case with its status in that cycle.

**`<KEY> - Test Report - <cycle(s)> - <dd-mm-yyyy>.xlsx`** (from the report template; one file per build, named by the Test Cycles and the build date): the *Report Template* sheet only (the older *Report templates* layout is dropped), the template's counters (formulas, recalculated by Excel on opening) over one block per selected Test Cycle: story key and summary, test case title, test case ID, status, comments (defects, the actual result of a failure, a regression note when the test case passed before).

Both files use the templates' words: PASS, FAIL, IN PROGRESS, BLOCKED, and PENDING (test-case workbook) / UNEXECUTED (report) for not executed. A Zephyr status the templates do not have is written as it is (upper-cased) and `build` warns about it.

### Rules the script enforces

- **A "Not Executed" entry is a placeholder, not an execution.** It gets no column pair and does not count as a previous result; a test case that only has placeholders is shown as PENDING / UNEXECUTED.
- **IST is fixed UTC+05:30.** Zephyr times are UTC; the date shown can differ from the UTC date (an execution at 20:00 UTC is 01:30 the next day in IST). An execution without a recorded time shows `date not recorded` and is never given a time.
- **Nothing is overwritten.** If a target file exists it is moved to `Test artifacts ISO/archive/<name> (replaced <yyyymmdd-hhmmss IST>).xlsx` first. Both workbooks are written completely before either replaces anything.
- **Sign-offs are kept, never invented.** *Reviewed By* and *Overall testing by lead* are not Zephyr data and stay empty; if a person typed them into the workbook being replaced they are carried over to the new one.
- **Document ID, author, reviewer and approver of the templates are not touched** (only title and description say what the document is and when it was generated).
- Local files: `automation/execution-results/report-build/zephyr-snapshot.json` (what was read from Zephyr; no token), `lookup.json` (names), and an event in `execution-history.jsonl`.

## Verified against

Zephyr Scale Cloud v2 endpoints read: `GET /healthcheck`, `/projects[/{key}]`, `/statuses`, `/priorities`, `/folders`, `/testcycles`, `/testcases`, `/testcases/{key}/teststeps`, `/testcases/{key}/links`, `/testexecutions` (all paged). Their shapes (an execution's `testCase` / `testCycle` / `testExecutionStatus` objects, `actualEndDate`, `executedById`) come from SmartBear's public API description as relayed by secondary sources; the unit tests run against a local mock and **no real tenant was available when this was written**. The first run on a real tenant is the real confirmation: check that the dates are the ones shown in Zephyr (the *Executed On* time comes from the execution's `actualEndDate`), that statuses map as expected, and that a test case's linked Bug appears under Execution Defects. Not read: step-level execution results, execution attachments and issue links stored on an execution rather than on the test case.

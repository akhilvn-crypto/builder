---
description: Read the test executions recorded in Zephyr Scale and build the ISO test-case workbook and the test-report workbook in the Emvigo templates, saved under "Test artifacts ISO". Every execution of a test case gets its own Executed On (IST date and time) and Result columns, so a test that passed yesterday and fails today is visible at a glance. A separate, manually invoked QA action - no pipeline or workflow ever runs it. Read-only towards Zephyr and Jira; runs no tests.
argument-hint: "[Test Cycle key ...] [--all]"
disable-model-invocation: true
---

# /builder:build-test-reports

Arguments: `$ARGUMENTS`

**Manual invocation only.** A QA action the user starts by typing it. `/builder:do-automation`, `/builder:design-test-n-automation`, `/builder:generate-test-cases`, every other command, the orchestrators and every agent never run it, never offer to run it on their own and never pass it a scope. If you reached this command from any other workflow rather than from the user typing it, stop and say so.

It only **reads**: Zephyr Scale (through the script) and Jira (through the connector, for names). It runs no tests, creates or changes nothing in Zephyr or Jira, and does not touch test cases or tests. Its only writes are the two Excel workbooks in `Test artifacts ISO/` and a few files under `automation/execution-results/report-build/`.

You (the main session) are the orchestrator: you ask the questions, call the Jira connector for names, and run the script.

## Read first

Read from the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as [environment.md](../skills/playwright-pipeline/environment.md) describes):

1. `skills/playwright-pipeline/environment.md`: how to ask the user in Claude Code and Cowork, where the project root is.
2. `skills/test-report-building/SKILL.md` (it cannot be loaded any other way): the exact script calls (`RP`), the lookup file, what the two workbooks contain and the rules the script enforces. `PY` is the first of `python`, `python3`, `py -3` that runs; `SCRIPTS` is `${CLAUDE_PLUGIN_ROOT}/test-design/scripts`.

Project root `<root>` = the folder the user's project lives in (the one holding `automation/`). The workbooks go to `<root>/Test artifacts ISO/`; the script creates that folder. Never print the Zephyr token. At the first failed check **stop**, say in plain words what is wrong and the concrete steps to fix it, and do not run later stages.

## Stage A: Preflight

1. **Project.** Confirm the Atlassian/Jira connector is available and authenticated (for example by listing accessible Atlassian resources and taking the `cloudId`). List the Jira projects the user can access (`listJiraProjects`; use `discover` for the exact operation if needed), show key and name, and ask which one holds the Zephyr project. Never choose for them, even with a single project. This is `<KEY>`. If the connector is not available, say that people's names, story titles and defect keys cannot be filled in and ask: *Stop and connect it (Recommended)* / *Continue without them* (then ask for `<KEY>` in chat and skip Stage D).
2. **Script checks.** `RP preflight`. It checks the Zephyr settings, reachability, token and project access, that `openpyxl` (Excel files) is installed, that both templates are there and that the output folder is writable. For `OPENPYXL_MISSING` ask for approval first (*Install openpyxl (Recommended)* / *Do not install*), install only that one package with `PY -m pip install "openpyxl>=3.1"` after a yes, then run the check again. Never install anything unasked. Any other problem: show the message, stop.

## Stage B: Which Test Cycles

`RP cycles --project <KEY>` lists the Test Cycles newest first with how many executions each holds, its results and when it was last executed (IST). Show it as a short table.

- If `$ARGUMENTS` names Test Cycle keys (`PROJ-R12`), use them (check they are in the list). `--all` means every Test Cycle that has executions.
- Otherwise ask: *The latest Test Cycle (Recommended)* / *Choose Test Cycles* / *All Test Cycles with executions*. For the middle option let the user type or pick the keys.

State clearly what this selects: the **Test Report** gets one block per selected Test Cycle; the **test-case workbook** lists the test cases that were executed in them, and shows **every** execution those test cases have in the project, also from Test Cycles that were not selected, so an earlier result is always next to the new one.

## Stage C: Read Zephyr

`RP fetch --project <KEY> --cycle <K> [--cycle <K2> ...]` (or `--all-cycles`). It reads the executions, the test cases (title, preconditions, steps, data, expected results, priority, owner, linked issues) and writes the snapshot. Tell the user how many test cases and executions it found and relay `warnings`. `NO_EXECUTIONS` means the selected Test Cycle(s) hold nothing to report: say so and offer another selection.

## Stage D: Names from Jira

Skip when the connector is not available. Otherwise, if `needsLookup` holds anything, resolve it with the connector as the skill's *The lookup file* section describes (people by account ID; issues by numeric ID: key, summary and issue type) and write `<root>/automation/execution-results/report-build/lookup.json` with the Write tool. Look up only what `needsLookup` lists, in as few connector calls as possible. Write only what the connector returned; what it could not resolve is left out of the file, never guessed.

## Stage E: Build

`RP build --project <KEY> [--lookup-file <root>/automation/execution-results/report-build/lookup.json]`. `FILE_IN_USE` means a workbook is open in Excel: ask the user to close it and run `build` again (the data does not need to be read again). Anything else: show the message, stop.

## Stage F: Report back (short)

- Where the files are: `files.testCases` and `files.testReport` (full paths), and `archived` if an earlier version was moved to `Test artifacts ISO/archive/`.
- Per Test Cycle (`perCycle`): number of test cases, execution date (IST) and the results. Total results (`results`).
- **Changes since the previous execution (`changesSincePrevious`)**, regressions first, as a table: test case, title, and the change (`REGRESSION: PASS (07-11-2026) -> FAIL (08-11-2026)`). If there are none, say that nothing changed.
- How many execution column pairs the test-case workbook has now (`testCases.executionColumnPairs`) and that each next build adds the new execution as a further pair.
- What is empty on purpose: *Reviewed By* and *Overall testing by lead* are sign-offs for a person (kept if they were typed into the previous workbook: say how many, `reviewedByKept` / `leadSignOffKept`). Anything still listed in `needsLookup` (names or Jira keys that could not be resolved) and any `warnings`.
- If the Test Report counters show zero, remind them that Excel calculates them when the file is opened.

Never edit the workbooks by hand to correct them: change the cause (the execution in Zephyr, the names) and build again. Never delete a file in `Test artifacts ISO/` or its `archive/`, and never delete or change anything in Zephyr or Jira.

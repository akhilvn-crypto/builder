---
name: mobile-reports
description: Show or change which optional reports the mobile runs produce (HTML report, JUnit XML), rebuild the reports of an earlier run, and show test-case coverage. summary.md, summary.json and coverage.json are always written. Runs no tests and installs nothing.
argument-hint: "[show | build [run-id] | list | coverage [run-id]]"
disable-model-invocation: true
---

# /builder:mobile-reports

The mobile counterpart of `/builder:reports`. Reports are built from what a run recorded; this command never runs a flow. Read
[../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (asking the user, project root). `MCLI` = `node mobile-automation/tools/maestro-cli.mjs`.

> **Setup:** if `mobile-automation/state/scaffold.json` is missing, point to `/builder:mobile-init`.

1. **Show.** `MCLI report formats` → which are on now: **HTML report** (`html`: self-contained page: result per flow, failure category and next step, device/app facts, failure screenshots,
   test-case coverage) and **JUnit XML** (`junit`: for CI test-result viewers). JSON/Markdown summaries and `coverage.json` are always produced. `$ARGUMENTS` = `show` stops here;
   `list` → `MCLI report list`; `coverage [run-id]` → `MCLI report coverage` (N of M test cases have a flow, the others with their reason).
2. **Change.** One multiSelect question with exactly the two options, labelled with their current state (the dialog cannot tick boxes in advance, say so): *Which reports do you want from now on?
   Anything you leave unpicked is turned off.* An empty answer is not a decision: ask *Turn off both?* before applying. Apply with `MCLI report formats --set html,junit` (or `--set none`). It
   applies to the next report build; reports already on disk stay.
3. **Rebuild.** `build [run-id]` (default latest) → `MCLI report build <runId>`; say which files were written and the paths.

Finish with the formats now on, where they are written (`mobile-automation/reports/<runId>/`), and that the optional ones apply to every later run too.

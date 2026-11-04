---
name: reports
description: Change which reports the pipeline produces (Playwright default report, Allure, Extent, Evidence PDF) at any time after setup. Shows what is on now, lets you turn reports off or add new ones, saves the choice; it applies from the next run.
argument-hint: "[show]"
disable-model-invocation: true
---

# /builder:reports

Setup asks which reports you want once. This command changes that choice whenever you like, without running the pipeline: turn a
report off, add another, or both in one go. It changes **only** the reports (and the evidence and report mode they imply); every
other setting stays as saved. It runs no tests and installs nothing by itself.

Arguments: `$ARGUMENTS` (`show` = only list what is on now and stop).

You (the main session) run this; it asks questions, so it cannot run in a subagent. Read
[../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (asking in Claude Code and Cowork, project root).
Every state change goes through `node dependencies/engine/cli/pipeline.ts`; never edit `automation/config/automation.config.json`
or `automation/playwright.config.*` by hand.

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/builder:init` first. If the project has no saved configuration yet (`config check` says `absent`), stop and tell
> them to run `/builder:playwright-pipeline` (or `do-automation`) once: the reports are chosen in its setup.

## 1. Show what is on now

Run `node dependencies/engine/cli/pipeline.ts config show` and read `config.reporters`. Show one compact list, in this order, using
these names (never `json`: it is always produced because the pipeline reads it):

| Report | `reporters` value |
|---|---|
| Playwright default report | `html` |
| Allure report | `allure` |
| Extent report | `extent` |
| Evidence PDF | `evidence-pdf` |

Mark each as **on** or **off**. `junit` may appear in an older config: mention it in one line as "kept as saved, no longer offered".
If `$ARGUMENTS` is `show`, stop here.

## 2. Ask for the new selection

One `AskUserQuestion` with a single **multiSelect** question and exactly these four options (never preselect any, never add
`None`). Label each option with its current state, e.g. `Allure report (on now)` / `Extent report (off now)`. The dialog cannot
tick boxes in advance, so say so in the question itself:

> *"Which reports do you want from now on? Pick every report you want; anything you leave unpicked is turned off."*

Option descriptions (same wording as setup):
- **Playwright default report**: the standard Playwright HTML report. Needs nothing.
- **Allure report**: needs `allure-playwright` and the Allure CLI, each approved separately.
- **Extent report**: one self-contained HTML file: dashboard, searchable test list, steps, errors, screenshots. Built by the
  pipeline, needs no package, and is **not** the ExtentReports library (that is Java/.NET; no maintained Playwright-for-Node
  version exists). Say that.
- **Evidence PDF**: one PDF with the executed steps, ONE video of each test's whole journey embedded, and ONE final-state
  screenshot. Cost: **every** test is video-recorded (passing ones too) and Chromium prints the PDF.

If the dialog is unavailable, use the numbered chat fallback from environment.md and show the current state as `[x]` / `[ ]`; ask the
user to reply with the numbers of the reports they want on (or `none`).

**An empty answer is not a decision.** If nothing was picked, ask one confirm question, *"Turn off all reports? Only the JSON
results the pipeline reads would be kept."* (*Yes, turn them all off* / *No, keep what I have*), and stop on *No*.

## 3. Preview, then confirm

Run (nothing is saved without `--apply`):

`node dependencies/engine/cli/pipeline.ts config reporter-update --reporters <comma list of the picked values, or none>`

- Unknown action (the CLI answers with the list of `config <…>` actions without `reporter-update`): the project's engine is older
  than this command. Tell the user to run `/builder:init --update` and then repeat this command; do nothing else.
- `issues` present (exit 2): show them and stop; change nothing and do not hand-edit around them.
- `changed: false`: say that this is already the current selection and nothing was changed. Stop.

Otherwise tell the user, briefly: what is **added**, what is **removed**, and each line of `changes` (the mode and evidence follow
from the selection: Evidence PDF → audit mode with video on for every test, Allure → full, otherwise standard), the software in
`reportPlan.missing` (named, not yet installed), and any `notes`. Then:

- If a removed Evidence PDF reset `evidence.video` and the resulting mode is not `standard` (Allure is still on), offer to keep
  recording every test (`--video on`); in `standard` that is not allowed, so do not offer it.
- If `unfinishedRuns` is not empty, say: *"These runs are not finished: <ids>. Each keeps the reports it started with, but
  Playwright's own report settings are refreshed from the saved choice, so a report you removed may show as failed when such a run
  builds its reports. New runs are not affected."* Offer to apply now anyway or cancel to finish those runs first.

Ask one confirm question: *Apply these changes (Recommended)* / *Cancel*. Never apply without the yes.

## 4. Apply

`node dependencies/engine/cli/pipeline.ts config reporter-update --reporters <same list> [--video on] --apply`

This saves through the same validation as `config save` and refreshes `automation/playwright.config.*`. Read the result:

- `applied: false` with `issues`: report them and stop.
- `playwrightConfig.status: "kept"`: the user edited that file by hand, so the new reports were **not** written into it. Show
  `detail` and let them choose: update it themselves, or `config render --force` (overwrites their edits; ask first).
- `reportPlan.missing` not empty: handle each missing item exactly as `pipeline-setup` §3 says: **one approval per dependency**,
  explain what it is for and the exact `installCommand` (run from inside `automation/`), install only on that yes, then re-run
  `preflight`, and record it with `deps record --dependency <id> --action installed|declined … ` (no `--run` when no run is active).
  Before proposing Allure, check the current official Allure guidance (Allure 3 CLI is the npm `allure` package; Allure 2 needs
  Java) and state the runtime requirement in the question. After `allure-playwright` is installed run
  `node dependencies/engine/cli/pipeline.ts config render`. If the user declines an item, the report stays selected but cannot be
  produced (it will show `missing_dependency`): say so, and that running this command again can turn it off.
- Evidence PDF: remind that Chromium prints it and every test is recorded; ffmpeg is optional and never installed without the user's
  yes (see `test-reporting`).

## 5. Say what happens next

Close in a few lines:
- The reports now on (names only, plus where they appear: `automation/reports/<runId>/…`, see `test-reporting`).
- **When it takes effect:** each run reads the saved choice when it starts (its `configuration` stage), so it applies from the **next**
  run (`/builder:run-tests`, `/builder:playwright-pipeline`, `/builder:do-automation`). Reports of runs that
  already finished are not rebuilt or removed. Reports the user turned off stay on disk where earlier runs wrote them.
- Anything still waiting on them (a declined install, a hand-edited `playwright.config`).

Never claim a report will be produced unless `reportPlan.missing` is empty. Never put secret values anywhere.

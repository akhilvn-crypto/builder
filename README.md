# Builder

A [Claude Code](https://claude.com/claude-code) plugin that turns your manual test cases into reviewed, executed
Playwright tests. You write the cases in Markdown, CSV or Excel and run one command. The plugin explores your app, generates
the tests, runs them, repairs broken *scripts* within strict limits, and produces the reports you chose.

Nothing is installed without your explicit yes, and secrets never leave `.env`.

**Mobile too.** For a Flutter app, `/builder:build-mobile-automation` builds a separate [Maestro](https://maestro.dev) framework in
`mobile-automation/` from the same kind of test cases and proves it with a smoke flow on a real phone (see
[Mobile automation with Maestro](#mobile-automation-with-maestro-builderbuild-mobile-automation)). It never touches the Playwright folders.

Start from test cases you already have, **or from detailed user stories**: `/builder:design-test-n-automation` designs the
test cases from your stories first and carries them through to executed, traceable Playwright tests (see
[From user stories to executed tests](#from-user-stories-to-executed-tests-builderdesign-test-n-automation)).

## What the pipeline does

`/builder:playwright-pipeline` runs 13 gated stages. A stage starts only when the one before it is complete.

| Phase | Stages | What happens |
|---|---|---|
| **Set up** | preflight, configuration | Read-only check of Node, Playwright and browsers. Asks only for what is missing (base URL, browsers, reporters, login) and saves your answers. |
| **Understand** | input_validation, test_analysis | Validates your test cases and normalizes them. Ambiguities become questions for you; steps and expected results are never invented. |
| **Build** | application_exploration, test_generation, script_review | Opens the real app to record durable locators, writes one Playwright test file per module, then reviews it (assertions match the spec, no secrets, sleeps or skips). |
| **Run** | execution, failure_triage | Runs the tests with screenshots, video and traces, then classifies each failure: script defect, application defect, environment, test data or flaky. |
| **Repair** | healing, regression_validation | Fixes **only** confirmed script defects, at most 2 attempts per test. A guard rejects any patch that weakens an assertion; patches that don't help are reverted. Healed tests are re-run. |
| **Report** | report_generation, finalization | Builds the reports you selected and a `summary.md`. Final outcomes: `passed`, `failed`, `flaky`, `healed`, `blocked`, `skipped`. |

Ground rules: application bugs are reported, never "fixed"; a test that only passes on retry is `flaky`, not `passed`;
tests are never skipped or weakened to get a green run.

## Installation

**Requirements:** [Claude Code](https://claude.com/claude-code) and a Node.js that can run `.ts` files natively
(Node 22.18+ does this out of the box). Git must be available, because Claude Code fetches the plugin from GitHub.

**1. Add the marketplace** (inside Claude Code):

```
/plugin marketplace add akhilvn-crypto/builder
```

The full URL works too: `/plugin marketplace add https://github.com/akhilvn-crypto/builder.git`.

**2. Install the plugin:**

```
/plugin install builder@builder-marketplace
```

Choose the scope when asked: *user* (all your projects), *project* (shared with the team through `.claude/settings.json`)
or *local* (only you, only this project).

**3. Load it and check:** restart Claude Code or run `/reload-plugins`, then run `/plugin` and open the **Installed** tab.
`builder` should be listed, and typing `/builder:` shows its commands.

**4. Scaffold each project you want to test** (once per project): see [Quick start](#quick-start).

*Install from the terminal instead:*

```bash
claude plugin marketplace add akhilvn-crypto/builder
claude plugin install builder@builder-marketplace
```

*Try a local checkout without publishing anything:*

```bash
git clone https://github.com/akhilvn-crypto/builder.git
claude --plugin-dir ./builder/plugins/builder
```

*Uninstall:* `/plugin uninstall builder@builder-marketplace`. Your `automation/` and `dependencies/` folders are never removed.

## Quick start

**1. Install the plugin:** see [Installation](#installation) above.

**2. Scaffold your project** (once). Open Claude Code in the project you want to test and run:

```
/builder:init
```

Claude asks whether you want **TypeScript or JavaScript** (fixed for the project afterwards) and creates two folders.
It never overwrites existing files and installs nothing.

```
automation/       the Playwright framework: pages/, tests/, helpers/, fixtures/, config/, playwright.config, .env.example
dependencies/     everything the pipeline needs: engine/, docs/, input/test-cases/, runs/, state/
```

**Or do steps 2 and 3 in one go:** `/builder:do-automation` asks the language, scaffolds the project and runs
every pipeline stage, stopping only for your choices and install approvals (see Commands).

**3. Run the pipeline:**

```
/builder:playwright-pipeline                    # asks where your test cases are
/builder:playwright-pipeline D:\QA\cases.xlsx   # or pass the path
```

On the first run Claude asks for the missing settings, and for approval before each install (`@playwright/test`,
browsers, `@playwright/cli`, Allure if chosen, `typescript` for TypeScript projects). Installs go into `automation/` and your
answers are saved for later runs. If you decline something, the run stops as `blocked` and tells you how to resume.

**4. Read the results** in `automation/reports/<run-id>/` and `dependencies/runs/<run-id>/summary.md`.

Want to see it work first? Run `/builder:init --with-demo`, start the demo app with `npm run demo:app` (in
`dependencies/`), then run the pipeline on `dependencies/demo/test-cases` with base URL `http://localhost:4173`. DEMO-1 and
DEMO-2 pass; DEMO-3 fails as an *application defect* by design, and the pipeline reports it without touching it.

## From user stories to executed tests (`/builder:design-test-n-automation`)

If you have detailed user stories (for example the `stories/detailed_stories.md` the BA plugins write) you do not have to write test
cases at all. One command goes the whole way and hands each stage's output to the next by itself:

**Story Discovery → Story Analysis → Test Design → Test Case Generation → Automation Readiness → Playwright Script Generation → Test Execution → Reporting**

```
/builder:design-test-n-automation                 # reads stories/ , asks only what is genuinely yours to decide
/builder:design-test-n-automation --story US-001,US-003
/builder:design-test-n-automation --concurrency 5   # story workers at once (default 5, at most 5; 1 = one after another)
/builder:design-test-n-automation resume          # continues where it stopped (design and automation both)
```

| Step | What happens | Output |
|---|---|---|
| Story discovery | Finds the Markdown stories (`stories/` is offered first), asks once which stories and which project root. | `test-design/state/` |
| Story analysis | Each story is analysed on its own, in a fresh worker that sees no other story. Questions a story leaves blocking are asked of you. | `test-design/state/analysis/` |
| Test design | Chooses techniques (positive, negative, boundary, equivalence, decision table, state transition, end-to-end, non-functional) and the scenarios that cover every acceptance criterion and rule. | `test-design/state/conditions/` (when run as its own stage) |
| Test-case generation | Writes structured cases with stable IDs, declared test data and observable expected results; every case is validated before it is saved. | `test-design/test-cases/<story>-testcase.md`, `traceability.json` |
| Automation readiness | A documented rule table judges every case: automatable, automatable with prerequisites (preconditions, `env:` values, dependencies, workflows), **manual** (CAPTCHA, SMS/e-mail codes, hardware, subjective results, elapsed days, load or security tooling), or blocked (the case is incomplete). Manual cases are listed with the reason and are not automated. | printed, and in `dependencies/state/design-handoff.json` |
| Hand-over | The automatable cases are imported into `dependencies/input/test-cases/design/`. You never point the pipeline at them. | `design-handoff.json` (snapshot in the run) |
| Scripts, execution, reports | The 13 stages above, unchanged, on those cases. | `dependencies/runs/<run-id>/`, `automation/reports/` |

Discovery, analysis, design and generation run as a **worker pool**: one lightweight orchestrator schedules up to 3 (configurable, at most 5) reusable `story-worker`s at a time,
a fresh isolated session per story. A worker gets only its own story, the shared rules it needs and small read-only excerpts of stories it depends on, then
analyses, designs, generates, validates and saves its own `<story>-testcase.md` and returns a compact result. The orchestrator is the only writer of
`workflow.json`, `traceability.json` and `audit.jsonl`: it ingests each result, re-validates the file, checkpoints it and starts the next story. A failed story
is retried a bounded number of times and never stops the others; an interrupted run resumes by adopting finished work and rerunning only what is incomplete;
a story whose source, shared rules or design rules changed is flagged for your decision and never regenerated on its own. Tokens and elapsed time are reported
separately: parallel workers shorten the wait, they do not reduce total tokens. If the runtime turns out to run the workers one after another, the run says so
(`check-pool`) and carries on at concurrency 1 instead of pretending.

Every test stays traceable: **Story → Acceptance Criterion → Test Scenario → Test Case → Automation Script → Execution Result**.
`dependencies/runs/<run-id>/traceability-report.md` shows, per story, each criterion with the cases that cover it and their results,
the criteria no case covers, cases without a script or result, and the cases left manual.

**Three commands for this part** (everything else is internal; the same agents, scripts and checks run behind each):

| Command | Does |
|---|---|
| `/builder:generate-test-cases [stories path] [--story ids] [--concurrency n] [--retry-failed]` | story discovery, analysis, test design, test-case generation and validation; saves one file per story; no automation. Re-run it to resume an interrupted run |
| `/builder:design-test-n-automation [stories path] [--story ids] [--language ..] \| resume` | the above plus automation readiness, Playwright scripts, execution and reports in one flow |
| `/builder:do-automation [test-case path] [--language ..] \| resume` | the separate automation flow for test cases you already have |

The finer steps remain available as `/builder:generate-tests` (script generation and review; with no path it finds the design's test
cases itself), `/builder:run-tests` and `/builder:heal-tests <run-id>` (execution, triage, reports; bounded healing).

Supplying your own test cases still works exactly as before (`playwright-pipeline <path>`, `generate-tests <path>`, `do-automation <path>`);
a path you give is always used and the design output is not consulted.

**Publishing is separate and manual.** `/builder:publish-zephyr <test-case file>` publishes one saved test-case file to
Zephyr Scale and links the cases to a Jira story. It is a QA action you type yourself. `design-test-n-automation` and every other
command, agent and stage never run it, prepare it or offer it (a test in `test-design/tests/test_integration_contract.py` guards that).
It needs the Atlassian connector and `ZEPHYR_BASE_URL` / `ZEPHYR_API_TOKEN`, as in the TDA plugin it came from.

**Requirements for the design stages:** Python 3.9+ on the machine (standard library only). If it is missing the command says so and
asks before installing anything. The automation stages need only Node, as before.

## Writing your test cases

Use Markdown, CSV or Excel (`.xlsx`) **in the column layout you already have**. Headers such as `TC No`, `Scenario`,
`Procedure` or `Expected Outcome` are matched flexibly, and if a layout isn't recognised Claude asks which column is which.
Your original file is only read, never changed; the pipeline converts the cases into its own Markdown (one file per case) in
`dependencies/input/test-cases/`. Each case needs an ID or title, steps and an expected result.

```markdown
## TC-001: Valid user can sign in
Tags: smoke, auth

### Test Data
- email: env:TEST_USER_EMAIL
- password: env:TEST_USER_PASSWORD

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the "Sign in" button

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"
```

### Test case template

Copy this for a new case. Only the ID or title, the steps and the expected results are required; delete the rest if you don't need it.

```markdown
# Login                                  <- optional: the module (several `#` headings in one file = several modules)

## TC-001: Valid user can sign in        <- ID is optional; without one a stable AUTO-xxxxxxxx ID is derived
Priority: High                           <- optional
Tags: smoke, auth                        <- optional, comma-separated
Depends on: TC-000                       <- optional: test IDs that must run first (they then run in order, in one serial group)

### Preconditions
- An active test account exists

### Test Data
- email: env:TEST_USER_EMAIL             <- env var NAME; the value lives in automation/.env
- password: env:TEST_USER_PASSWORD
- plan: Premium                          <- plain literal
- wrong_password: literal:wrong-pass-1   <- explicitly fake value, kept out of .env

### Steps
1. Open the login page
2. Enter {email} in the Email field      <- {name} must be defined in Test Data
3. Enter {password} in the Password field
4. Click the "Sign in" button -> Expected: The dashboard is displayed   <- optional inline expectation for a step

### Expected Results
- The heading "Dashboard" is visible
- The URL contains "/dashboard"
```

Using Excel or CSV instead? One row per case, with these columns. The names are matched flexibly, so keep your own.

| Column | Required | Also recognised as | Notes |
|---|---|---|---|
| Test Case ID | ID or title | `TC ID`, `Test Case No`, `Ref` | Must be unique; duplicates are flagged |
| Title | ID or title | `Scenario`, `Test Case Name`, `Summary` | |
| Module | no | `Feature`, `Functionality`, `Area`, `Component` | The sheet name is used without it |
| Preconditions | no | `Prerequisites`, `Precondition` | |
| Steps | **yes** | `Test Steps`, `Procedure`, `Action` | One step per line, numbered or not |
| Test Data | no | | `env:VAR`, `literal:value` or a plain value |
| Expected Result | **yes** | any header starting `Expected` | One result per line |
| Priority | no | | |
| Tags | no | `Tag`, `Labels`, `Keywords` | Comma-separated |
| Depends on | no | `Dependency`, `Dependencies`, `Prerequisite Test(s)`, `Blocked By` | Test IDs; separate several with comma, semicolon, "and" or new lines |

```csv
Test Case ID,Module,Title,Preconditions,Steps,Test Data,Expected Result,Priority,Tags,Depends on
TC-001,Login,Valid user can sign in,An active test account exists,"1. Open the login page
2. Enter {email} in the Email field
3. Enter {password} in the Password field
4. Click the ""Sign in"" button","email: env:TEST_USER_EMAIL
password: env:TEST_USER_PASSWORD","The heading ""Dashboard"" is visible
The URL contains ""/dashboard""",High,"smoke, auth",
TC-002,Login,Signed-in user can sign out,,"1. Click ""Sign out""",,The login page is shown,Medium,auth,TC-001
```

A case that is missing steps or expected results, uses an undefined `{name}`, or depends on an unknown ID is not generated until you
answer the question Claude asks about it. Any other layout is fine too: if it isn't recognised, Claude asks which column is which.

**Modules.** Cases are grouped into modules (a Markdown `# heading`, an Excel sheet name, or a `Module` column) and
generated as one file per module: `automation/tests/login.spec.ts`, `create-project.spec.ts`, and so on.

**Credentials.** Never put real secrets in config or tests. Credentials and emails found in your test cases are moved into
`automation/.env` as `TEST_<NAME>` variables automatically, and tests only reference the names. You only need to edit
`.env` when the pipeline lists a value it could not find. Write `literal:<value>` to keep a deliberately fake value (such as a
wrong password) out of `.env`.

## Commands

| Command | Does |
|---|---|
| `/builder:do-automation [path] [--language typescript|javascript] [--with-demo]` | Guided end to end: asks the language, scaffolds, then runs all 13 stages. Stops only for your choices, one-by-one install approvals, missing `.env` values and blockers. `resume [<run-id>]` continues. Works in Claude Code and Claude Cowork. |
| `/builder:design-test-n-automation [stories path] [--story ids] [--language ...]` | Stories to executed tests: story analysis, test design, test cases, automation readiness, hand-over, then the 13 stages and a traceability report. `resume` continues. Never publishes. |
| `/builder:init [--language typescript\|javascript] [--update] [--with-demo] [--force]` | Scaffold, update or migrate `automation/` and `dependencies/`. |
| `/builder:playwright-pipeline [path]` | The full 13-stage pipeline. |
| `/builder:generate-tests [path]` | Parse, explore, generate and review. Does not execute. |
| `/builder:run-tests [files...]` | Execute existing tests, triage failures, report. Edits nothing. |
| `/builder:heal-tests <run-id>` | Repair eligible script defects from an earlier run, re-validate, report. |
| `/builder:reports [show]` | Change which reports are produced (Playwright default report, Allure, Extent, Evidence PDF) at any time: shows what is on, lets you turn reports off or add new ones, saves it. Applies from the next run; runs no tests. |
| `/builder:build-mobile-automation [test-case path] [--platform android\|ios\|both] [--app dir] [--env name]` | Guided end to end for a Flutter app with **Maestro**: discovers the project, checks Maestro/Java/Android/iOS tooling (asks before installing anything), scaffolds `mobile-automation/`, turns test cases into Maestro YAML flows with traceability, validates them and runs a smoke flow on a **real physical device**. Safe to rerun. |
| `/builder:mobile-init [--update]` | Scaffold (or refresh the plugin-managed tools of) `mobile-automation/`. Installs nothing, touches no device. |
| `/builder:mobile-generate-flows [path]` | Test cases to validated Maestro flows; detects changed cases, never overwrites hand-edited flows. No execution. |
| `/builder:mobile-run-tests [flow \| --test ID \| --feature name \| --suite smoke\|critical\|regression \| --all]` | Run flows on a device, keep evidence per flow, classify failures (application / automation / device / environment), build reports. Edits nothing. |
| `/builder:mobile-heal-flows <run-id>` | Repair selector drift (same control, new id/label) proven against the real screen; bounded, audited, auto-reverted. |
| `/builder:mobile-reports [show]` | Show or change the optional mobile reports (HTML, JUnit), rebuild a run's reports, show test-case coverage. |

**Claude Code and Claude Cowork.** Choices are shown as a dialog (`AskUserQuestion`). Where that dialog does not appear, as can
happen in Cowork, Claude asks the same question as a numbered list in chat and waits for your reply; it never picks for you.
Installs are still approved one dependency at a time. Cowork needs a Node in its sandbox that runs `.ts` files natively, runs tests headless, and can only reach apps
the sandbox can reach. Details: `skills/playwright-pipeline/environment.md`.

**Resuming.** Run state is saved on disk, so a closed terminal, crash or declined install doesn't lose the run. Repeat the
command you started with, followed by `resume` (no run id needed): `/builder:playwright-pipeline resume`. It
continues the newest unfinished run of that command, skips completed stages, and re-runs any stage that was interrupted.
`node dependencies/engine/cli/pipeline.ts run resumable` lists the candidates.

**Day-to-day, outside Claude** (from `automation/`): `npm test` runs the tests as a recorded run with reports and evidence;
`npm run test:adhoc` is plain Playwright with nothing recorded, for debugging.

## Mobile automation with Maestro (`/builder:build-mobile-automation`)

A second, independent framework for the Flutter app: Maestro YAML flows in `mobile-automation/`, generated from the same canonical test
cases (Markdown from test design, or CSV), run through the Maestro CLI on real devices. It shares the conventions of the Playwright side
(simple structure, independent tests, stable selectors, deterministic runs, no installs without a yes, secrets in a git-ignored `.env`) and
**never reads or changes `automation/` or `dependencies/`**.

`/builder:build-mobile-automation` runs eight steps and stops only for your choices, install/device approvals, missing secret values and blockers:
discovery and prerequisites → scaffold and configuration → test cases (change detection) → physical device → flows (one representative flow first) →
validation → smoke on the device → CI readiness and summary. It is safe to run again.

- **Prerequisites** (Maestro, Java 17+, Android `adb`, Xcode on a Mac, optionally Flutter) are detected with versions; what the installed Maestro CLI supports is read from its own
  `--help`. Anything missing is explained and asked for **one at a time**; nothing is installed or changed on your machine or phone unasked.
- **Selectors** come from Flutter accessibility ids (`Semantics(identifier: …)`), the real screen (`maestro hierarchy`) or text the test case quotes. `Key` values are not
  accessibility ids. A control with no stable id becomes an entry in `mobile-automation/docs/semantics-requests.md` for the app team, not a hidden fragile selector. Coordinates
  and `index` need a written reason.
- **Traceability**: every flow carries `# testCase: <ID>`; `state/traceability.json` records the test case's and the flow's hashes, so a changed case is found and a hand-edited flow is
  never overwritten. Manual and unclear cases are listed with the reason, not guessed. `report coverage` shows N of M test cases have a flow.
- **Physical-device validation**: the framework counts as validated for a platform only when a `smoke` flow passed on a real phone (`validation status`). Emulator/simulator runs are
  labelled as such. iOS needs a Mac, Xcode, trust, Developer Mode and a signed build; on another host it is reported as blocked, never as done.
- **Runs** execute flow by flow: one failure never stops or erases the others. Each run records platform and OS, device, app id/version, environment, scope, Maestro version and outcome,
  and keeps a log, screenshots and the screen hierarchy per flow. Failures are classified as **application**, **automation**, **device** or **environment**; uncertain readings say so.
- **Repair** is limited to an id/text/label that moved on the same control, proven in the real hierarchy, two attempts per flow, reverted automatically if anything else changed.
- **Reports**: `summary.md`, `summary.json`, `coverage.json` always; `report.html` and `junit.xml` by choice (`/builder:mobile-reports`). CI uses the same CLI
  (`mobile-automation/README.md`: smoke on pull request, critical after deployment, regression nightly, `--strict` for a failing exit code).

```
mobile-automation/
  tools/          plugin-managed CLI (node mobile-automation/tools/maestro-cli.mjs help)
  config/         mobile.config.json (no secrets), environments/<env>.json
  flows/common/   reusable subflows (launch-app, …)        flows/<feature>/   one flow per test case
  tests/          smoke.yaml, critical.yaml, regression.yaml (suite definitions)
  test-data/  docs/  state/          reports/<runId>/  artifacts/<runId>/<flow>/   (reports and artifacts are git-ignored)
  .env (git-ignored)  .env.example  README.md
```

Plugin side: `scripts/mobile-init.mjs`, `template/mobile/` (tools, framework files, rules block), `skills/maestro-*` and `skills/mobile-*`, `agents/maestro-flow-generator.md`
and `agents/maestro-flow-healer.md`. Tests: `node --test plugins/builder/tests/mobile.test.mjs` (fake `maestro`/`adb`; no phone needed).

## Reports

Setup asks which reports you want. Only the ones you pick are built (JSON results are always kept):

- **Playwright default report**: the standard HTML report.
- **Allure report**: needs `allure-playwright` and the Allure CLI (offered for approval).
- **Extent report**: one self-contained HTML dashboard with charts, a searchable test list, steps, errors and screenshots. Built by the
  pipeline itself, with no package.
- **Evidence PDF**: for sign-off. One PDF with every executed step, a final-state screenshot and an embedded video per test.
  Needs Chromium; videos open in Acrobat/Reader, Foxit or PDF-XChange (browser viewers may not show attachments). Password
  fields are masked in screenshots; videos are not masked.

Outputs: reports in `automation/reports/<run-id>/`, screenshots/videos/traces in `automation/test-results/<run-id>/`, and
pipeline state (manifest, specs, exploration, healing log, `summary.md`) in `dependencies/runs/<run-id>/`.

## Safety and efficiency

- **No unapproved installs.** Every dependency is asked for separately, with the exact command, and logged.
- **Reuse only when provably unchanged.** Specs, generated tests, review results and exploration are reused across runs only while
  their inputs are identical (`cache status <run-id>` shows why anything was rebuilt). Execution results are never reused.
- **Agents only where judgment is needed;** everything deterministic runs through the CLI.
- **Nothing is left running.** Browsers and servers started by a run are stopped when it ends, fails or is resumed. Your own
  browsers and servers are never touched.
- **Team setup:** add the marketplace to a project's `.claude/settings.json` so everyone is offered the plugin:

  ```json
  {
    "extraKnownMarketplaces": {
      "builder-marketplace": {
        "source": { "source": "github", "repo": "akhilvn-crypto/builder" }
      }
    },
    "enabledPlugins": { "builder@builder-marketplace": true }
  }
  ```

## Updating the plugin

Updating has two parts: get the new plugin version, then refresh each project that uses it.

**1. Update the plugin** (inside Claude Code):

```
/plugin marketplace update builder-marketplace
/plugin update builder@builder-marketplace
```

The first command pulls the latest marketplace listing from GitHub; the second installs the newer plugin version if there is one.
Then restart Claude Code or run `/reload-plugins`. From the terminal:
`claude plugin marketplace update builder-marketplace` and `claude plugin update builder@builder-marketplace`.

You can also run `/plugin`, open the **Marketplaces** tab, select `builder-marketplace` and turn on **auto-update**, so Claude Code
updates the plugin at startup.

**2. Refresh each project** that was scaffolded earlier. Open Claude Code in that project and run:

```
/builder:init --update
```

This refreshes the engine files in `dependencies/`. Your config, tests, page objects and `playwright.config` are left alone.

**3. Check the version:** run `/plugin`, open **Installed** and look at the `builder` version. Compare it with the
`version` in `plugins/builder/.claude-plugin/plugin.json` on GitHub.

**Troubleshooting:** if an update does not show up, run `/plugin marketplace update builder-marketplace` again and restart
Claude Code. If it still does not, uninstall and reinstall:

```
/plugin uninstall builder@builder-marketplace
/plugin install builder@builder-marketplace
```

**Moving from older layouts.** Projects scaffolded by 0.2.x (everything inside `automation/`) are migrated by `/builder:init`:
it shows a dry run and moves files only after you confirm. 0.1.x projects (scaffolded at the project root) are left untouched
with a warning; move `config/`, `tests/` and `input/` by hand if you want to keep them.

**Coming from the old `automation-builder` name?** The plugin was renamed to `builder`, so commands are now `/builder:...`.
Uninstall the old one (`/plugin uninstall automation-builder@automation-builder-marketplace`), install `builder` as above, then
run `/builder:init --update` in your projects. In projects created under the old name, tests that start with
`// @automation-builder:generated` are no longer recognized as pipeline-owned (they are treated as handwritten and left alone).
Change that header to `// @builder:generated` to let the pipeline regenerate and heal them again, and do the same for the
`automation-builder:config` marker line in `automation/playwright.config.*` and the `<!-- automation-builder:start/end -->`
block in your `CLAUDE.md`.

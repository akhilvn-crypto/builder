# builder plugin

Agentic Playwright pipeline for Claude Code with on-disk, resumable run state.

Install: `/plugin marketplace add akhilvn-crypto/builder` then `/plugin install builder@builder-marketplace`.

## Commands

| Command | Does |
|---|---|
| `/builder:do-automation [path] [--language typescript|javascript] [--with-demo] | resume [<run-id>]` | guided end to end (`commands/do-automation.md`): asks the language, scaffolds, then runs all 13 stages; stops only for your choices, per-dependency install approvals, missing `.env` values and blockers. Runs are ordinary `playwright-pipeline` runs |
| `/builder:design-test-n-automation [stories path] [--story ids] [--language typescript|javascript] | resume [<run-id>]` | stories in `stories/` → analysis → test design → test cases → automation readiness → hand-over → the 13 stages → traceability report (`commands/design-test-n-automation.md`). The run is an ordinary pipeline run with a design snapshot; `run resume` reports whether the design is still current |
| `/builder:design-test-cases` \| `analyse-stories` \| `design-tests` \| `generate-test-cases` | the test-design stages, together or one by one (`agents/test-design-orchestrator.md`, `SCOPE`); each reads the previous stage's saved output after checking it is current |
| `/builder:design-resume` \| `design-status` \| `validate-test-cases` | resume an interrupted design run (changed stories are asked about, never regenerated automatically); read-only status incl. the hand-over; validate the saved cases |
| `/builder:automation-readiness [--story ids] [--path p]` | readiness report (automatable / with prerequisites / manual with reasons / blocked); read-only |
| `/builder:publish-zephyr <test-case file>` | **manual only**: publish one test-case file to Zephyr Scale and link it to a Jira story; never run by any workflow |
| `/builder:init [--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]` | asks TypeScript or JavaScript, then scaffolds (or updates/migrates) `automation/` (framework) and `dependencies/` (pipeline); installs nothing |
| `/builder:playwright-pipeline [path] \| resume [<run-id>]` | full 13-stage pipeline; first asks where your test cases are and converts them into `dependencies/input/test-cases/` |
| `/builder:generate-tests [path] \| resume [<run-id>]` | parse → explore → generate → review (no execution) |
| `/builder:run-tests [files...] \| resume [<run-id>]` | execute existing tests → triage → report (no edits) |
| `/builder:heal-tests <run-id> \| resume [<run-id>]` | repair eligible script defects → regression check → report |
| `/builder:reports [show]` | change which reports are produced (Playwright default report, Allure, Extent, Evidence PDF) after setup: shows what is on, turn reports off or add new ones, saves the choice for the next run; runs no tests, installs only what you approve one by one |

Every pipeline command takes `resume` with or without a run id. Bare `resume` continues the newest unfinished
(`in_progress`, `blocked` or `failed`) run of that command; `node dependencies/engine/cli/pipeline.ts run resumable` lists the
candidates. Details are in the root README, "Resuming a run".

Claude Code and Claude Cowork: choices use the `AskUserQuestion` dialog and fall back to a numbered chat question when the dialog does
not appear (`skills/playwright-pipeline/environment.md`, which also lists the Cowork specifics: plugin path lookup, Node, headless, reachability).

Knowledge skills (loaded automatically by Claude and the agents): `pipeline-setup`, `test-case-parser`,
`playwright-framework`, `application-exploration`, `test-data-management`, `execution-and-diagnostics`,
`auto-healing`, `test-reporting`.

Agents: `builder:test-analyst`, `application-explorer`, `playwright-generator`, `test-reviewer`,
`test-executor`, `failure-healer`, `data-cleaner`; for test design `story-analyser`, `test-coverage-designer`, `test-case-generator`,
`test-case-quality-checker` (workers that return structured results) and `test-design-orchestrator` (a contract the main session follows, not a subagent).

Test design (`test-design/` in the plugin) is the Python tooling of the TDA plugin, integrated rather than rebuilt: `rules/`, `schemas/`, `scripts/`, `templates/` and
its unittest suite (`python -m unittest discover -s tests -t tests` from `test-design/`). It writes `<project>/test-design/` and never touches your stories.
The engine side of the hand-over is `dependencies/engine/pipeline/design-handoff.ts`, `readiness.ts` and `traceability-report.ts` (CLI group `design`:
`status`, `readiness`, `handoff [--apply]`, `attach`, `trace`).

## How it fits together

`/builder:init` creates two sibling folders in the project, so the framework stays clean:

- **`automation/`** is the Playwright framework **only**, laid out as in `playwright_framework_structure.md`. It has its own
  `package.json` and `node_modules`.
- **`dependencies/`** holds everything else the pipeline needs: the engine, docs, the test-case input, run state and
  bookkeeping. It has no `node_modules`.

The host project is otherwise untouched apart from a rules block in the root `CLAUDE.md`. The init command **asks which
language** to use, TypeScript or JavaScript, and records the answer in `dependencies/state/scaffold.json`; it is never
defaulted and the project cannot be switched in place.

```
automation/                                  framework only
  pages/            tests/            helpers/        mandatory
  fixtures/         config/                                   reports/<run-id>/  test-results/<run-id>/    supporting
  auth/  test-data/                          created only when a test needs them
  playwright.config.{ts,js}  tsconfig.json | jsconfig.json  package.json  .gitignore  .env.example  README.md
dependencies/                                not framework
  engine/  docs/                             pipeline engine and reference (plugin-owned)
  input/test-cases/                          your Markdown / CSV / Excel test cases
  runs/<run-id>/                             per-run manifest, specs, exploration, healing log, summary (git-ignored)
  state/                                     scaffold.json, dependency-log.json
  package.json  tsconfig.json  [demo/  engine-tests/]
```

- **Pipeline** (TypeScript, run directly by Node as `node dependencies/engine/cli/pipeline.ts`; refreshed by `--update`):
  `dependencies/engine/`, `dependencies/docs/`, the tsconfigs.
- **Framework** (in the chosen language, yours to extend, created once): `playwright.config.*`, `fixtures/`, `pages/`, `helpers/`, `.env.example`, `README.md`.
- **`playwright.config.{ts,js}`** is an ordinary Playwright config (the same shape `npm init playwright` creates) with your approved
  settings written in as plain values, so it reads and edits like any Playwright project. The pipeline fills it when settings are
  saved and leaves it alone once you edit it by hand (`node dependencies/engine/cli/pipeline.ts config render --force` rewrites it
  from `automation.config.json`). `--update` never overwrites it.
- Playwright's own output is framework output: reporter files go to `automation/reports/<run-id>/<label>/` and
  screenshots/video/traces to `automation/test-results/<run-id>/<label>/`. Pipeline state (manifest, specs, exploration,
  healing log, `summary.md`) stays in `dependencies/runs/<run-id>/`.
- Merges `.gitignore` lines and npm scripts. Existing files are never overwritten without `--update` / `--force`.
- **Tests** all live in `automation/tests/`. A test file written by the pipeline starts with `// @builder:generated`;
  only such files are regenerated or healed. Delete the line to take a file over. Older `tests/generated` + `tests/handwritten`
  folders are flattened into `tests/` by `init`.
- **Migration:** a project scaffolded by 0.2.x (everything inside `automation/`) is detected by `init` and migrated:
  pipeline data moves to `dependencies/`, `utils/` becomes `helpers/`, `tests/setup/` becomes `auth/`, imports are rewritten, and
  the plugin-managed engine copies are replaced. `--dry-run` shows the plan first.
- **Evidence PDF:** choosing the `evidence-pdf` reporter makes Playwright record one video per test (`evidence.video` must be `on`) and the
  shared fixture log each `test.step` and take one final-state screenshot; `report build` then writes
  `automation/reports/<run-id>/evidence-report/evidence-report.pdf` (executed steps, one execution video **embedded in the PDF**, one
  final-state screenshot, expected results, per attempt) using the project's own Playwright + Chromium and a dependency-free PDF
  update (`engine/pipeline/pdf-embed.ts`): no extra package. **Video that plays inside the PDF** needs an `ffmpeg` with `libx264` already on the
  machine (PATH or `FFMPEG_PATH`; never installed by the plugin): each recording is converted to H.264 MP4 (`engine/pipeline/video-transcode.ts`)
  and stored behind a click-to-play player in the test's section (Adobe Acrobat / Reader; browser PDF viewers cannot play video in a PDF and
  show the MP4 in the Attachments panel). Without ffmpeg the videos are WebM file attachments (Acrobat/Reader, Foxit, PDF-XChange open them
  with another program) and the report says why, with the on-disk path printed as the fallback.
  `--update` refreshes an unmodified older `fixtures/test.*` (0.6.x, 0.8.x and 0.9.0 copies) so existing projects can adopt it; the evidence PDF belongs to
  `reporting.mode: audit` with `stepScreenshots` (the key's original name), and password fields are masked in the screenshot.
- **Nothing left running:** the test runner and the report tools run under `engine/tools/supervise.ts` (a timeout stops the whole process tree;
  leftovers are stopped when the command ends), and `pipeline.ts cleanup run <run-id>` closes the run's `playwright-cli` session
  (`explore-<run-id>`) and stops what is left of its browser. It runs by itself when exploration ends, when a stage fails/blocks/cancels, on
  `run resume` and in `run finalize`. Only processes recorded in `runs/<run-id>/processes.json` or sessions named with the run id are stopped
  (`engine/pipeline/process-cleanup.ts`, `engine/utils/process-tree.ts`); a process that cannot be stopped is reported, not hidden.
- **Test data cleanup (0.15.0):** tests ask for the opt-in `cleanup` fixture and register each record they create (`cleanup.register({ entity, identifier,
  undo })`); it is written to `runs/<run-id>/created-data/` first, undone after the test (also a failed or timed-out one), and `pipeline.ts cleanup data
  <run-id> [--dry-run]` sweeps what is left (automatically after execution/healing/regression and at finalization). A sweep removes a record through an
  API the user declared in `config.cleanup.entities` (endpoints are never guessed), or hands UI-only records to the `data-cleaner` agent; the rest is
  listed in `summary.md` ("Test data") with how to delete it by hand. Only ledger records, only with `cleanup.mode` `test` (each test removes its own data when it finishes) or `sweep` (tests delete nothing; one sweep once every test has finished — for `npm test` after the
  execution stage, for `npm run test:adhoc`/`test:ui` by `engine/cli/adhoc-run.ts`; a bare `npx playwright test` is not swept, its records wait for the next sweep), only in an
  allowed non-production environment, at most `cleanup.maxDeletesPerRun` (50) per sweep (`engine/pipeline/created-data.ts`, `data-cleanup.ts`).
  `init --update` refreshes an unmodified older `fixtures/test.*`; a customised one is left alone and the warning says how to add the fixture.
- The template is organized as `template/dependencies` (engine, docs, demo, engine tests) and
  `template/framework/{common,typescript,javascript}`; the language-specific twins must stay functionally identical.

## Doing less work, safely

Each run reuses what is provably unchanged, asks an agent only where judgment is needed, and keeps parallel work from colliding.
Mechanics, trade-offs and limits: `dependencies/docs/pipeline-efficiency.md` (scaffolded by `init`).

- **Cross-run cache** (`dependencies/state/artifact-cache/`): normalized specs, generated tests, review results and the typecheck are reused
  only while their inputs, the plugin version and the framework files each test imports are unchanged and the entry still validates.
  `cache status <runId>` lists every reuse/rebuild with its reason. Execution results are never reused.
- **Agents on demand:** `agents plan <runId> <stage>` decides in code whether a stage needs an agent and writes the bounded brief it gets.
- **Saved login state** is checked (age, cookies, origin, optional probe) before reuse, and the setup project runs first in every run: it asks the
  application once whether the saved session is still accepted and signs in again if not, so no test starts on a session that has ended. A session
  rejected mid-run is discarded and the run repeated once. `auth check` / `auth clear` explain and clean up.
- **Tests that sign in or out** (tag `@own-session`) start signed out and run after every test that shares the saved login, so signing in again as the same
  account cannot end a session another test is using. **Dependent test cases** (a "Depends on" column or line) run in order in one serial group; if one fails
  the later ones are reported as blocked by it, not as failures of their own.
- **Parallelism:** a conservative default of 2 workers, capped by `execution.isolation`; generation batches (one per module file) never share a
  file; all shared state updates are locked. `run compare <baseline> <candidate>` checks that no test went missing or got worse before it
  believes a speed-up.
- **Reports are your selection:** Playwright default report, Allure report, Extent report (pipeline-built HTML dashboard, no package) and Evidence PDF; JSON is always
  kept. Only the selected ones are built. `config reporter-preset --reporters html,extent` shows what a selection saves; missing software is proposed, never installed.
- **Report modes** follow from the selection and only bound the evidence volume: `standard` (failure-focused), `full` (Allure, failure videos), `audit` (the evidence PDF with one
  embedded video per test and step evidence). `config mode-preset <mode>` shows what a mode sets.

## Setup and installation approvals

On the first run the pipeline runs a read-only preflight, asks for missing settings (base URL, environment,
test-case path, browsers, evidence, reporters, auth) and saves them to `automation/config/automation.config.json`. The language is not asked again; it comes from the init choice. Every missing
dependency (`typescript` for TypeScript projects only, `@playwright/test`, browsers, `@playwright/cli`, Allure) is offered separately with the
exact command and installed only on an explicit yes, into `automation/`; decisions are logged in `dependencies/state/dependency-log.json`.

Secrets go in `automation/.env` (git-ignored; copy `.env.example`). Credentials, usernames and emails found in your test cases are moved there automatically (`TEST_<NAME>` variables; `literal:<value>` opts a fake value out); you only fill in values the pipeline reports as missing. The pipeline asks where your test cases are (any path; Excel, CSV or Markdown in your own column layout), converts them to its Markdown format, one file per module, and saves them in `dependencies/input/test-cases/` (`input import --from <path>`; your original is never changed). `specs parse` normalizes every case once into `canonical-test-cases.json` (a status per case: `valid`, `warning`, `needs_clarification`, `invalid`) and projects `test-specs.json` from it; two equally good columns for one field hold that table's cases until you pick one, and columns read from their content are used only at 90% confidence or better and reported. Known limits: step-level data does not survive the Markdown conversion (only case-level data does), and an unindented plain-text line in a Markdown case's steps or expected results can be read as metadata. Run state lives in `dependencies/runs/<run-id>/`; reports and evidence in `automation/reports/<run-id>/` and `automation/test-results/<run-id>/`.

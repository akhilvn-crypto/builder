---
name: test-reporting
description: Report selection (Playwright default report, Allure, Extent, Evidence PDF; JSON always), report generation and verification, final outcome rules and the run summary. Use for the report_generation and finalization stages or when changing reporters.
user-invocable: false
---

# Test reporting

## The four reports the user can choose
Setup asks which reports are wanted; only the selected ones are produced (and only their software is proposed):

| Choice | `reporters` value | Made by | Needs |
|---|---|---|---|
| Playwright default report | `html` | Playwright, while the tests run | nothing |
| Allure report | `allure` | `allure-playwright` while the tests run, `allure generate` in `report build` | `allure-playwright` + the Allure CLI (each approved separately) |
| Extent report | `extent` | `report build` (pipeline-built HTML) | nothing |
| Evidence PDF | `evidence-pdf` | `report build` (HTML printed to PDF, videos embedded) | Chromium, `evidence.video: "on"`, audit mode with step evidence |

`json` is always added (the pipeline reads raw JSON, not HTML) and never offered. `junit` is still a valid value in older configs but is
no longer offered. `config reporter-preset --reporters html,extent` turns a selection into the reporters/evidence/mode to save: the
mode follows from the selection (evidence PDF → `audit`, Allure → `full`, otherwise `standard`), so it is not asked separately.

## Where reporters are configured
Chosen in setup and changed later with `/builder:reports` (`config reporter-update --reporters <list> [--apply]` previews the
change, then saves it; the mode and evidence follow from the selection, everything else stays). Runs keep the reports they started with,
so a change applies from the next run. Stored only in `automation/config/automation.config.json` → `reporters` (changed through the pipeline-setup skill). The Playwright
reporter list is written into `automation/playwright.config.*` (`config save`, or `config render` after changing it) unless that
file was edited by hand. Reporter output goes to the framework's
`automation/reports/<runId>/<label>/` (never into `dependencies/`); the Extent report and the evidence PDF go to
`automation/reports/<runId>/extent-report/` and `.../evidence-report/`. `json` is mandatory.
Allure is written into the config only when `allure-playwright` is installed (approved); otherwise it is listed as
`missing_dependency`. After installing it run `config render` (`exec run` also does this before each run).

## The Extent report (`extent`)
One self-contained HTML file, `automation/reports/<runId>/extent-report/index.html`, in the style of an Extent Reports dashboard:
- **Dashboard:** counts, pass-rate ring chart, time in tests, per-module and failure-category tables, and a "needs attention" list that links to the tests.
- **Tests:** every test (also blocked ones, with the reason), a status filter and a search box, expand/collapse all. Per test: module,
  priority, tags, preconditions, the steps and expected results of the test case, and per attempt (initial, retries, regression)
  the status, time, errors and a screenshot. The *executed* steps appear only when the shared fixture recorded a step log (that
  happens when the evidence PDF is also selected); otherwise the page says the screenshot is the one Playwright recorded.
- **Environment:** run, environment, base URL, browsers. Light/dark switch; works on a phone; no network requests.
It is built by `report build` from the normalized execution results (same data as the evidence PDF), needs no package, and is
**not** the ExtentReports library (Java/.NET; no maintained Playwright-for-Node integration was found), so say that when handing it
over. Screenshots are embedded (larger than 5 MB are skipped with a note); videos are linked by relative path, never embedded. Text is
HTML-escaped and secrets are masked. Status in `reporters`: `generated` (detail: tests, steps, screenshots, size) or `failed`.

## Report modes
`reporting.mode` bounds how much is produced; it only constrains what the user selected. It is derived from the selection (see above) and does not require any particular report.

| Mode | Produces | For |
|---|---|---|
| `standard` | failure-focused screenshots/traces (no record-everything evidence); no Allure or evidence PDF | default development runs |
| `full` | any evidence settings; Allure allowed; video retained for failures | team testing and CI |
| `audit` | full + opt-in step evidence (step log + one final-state screenshot per test; `reporting.stepScreenshots`, the key's original name) and the optional `evidence-pdf` reporter (one embedded video per test) | formal sign-off |

`node dependencies/engine/cli/pipeline.ts config reporter-preset --reporters <list>` shows what to save for a selection of reports, and
`config mode-preset <mode> [--step-screenshots] [--evidence-pdf]` what a mode would set (nothing is saved by either);
`config report-plan` shows the configured reporters and the software they need (Allure adapter + CLI, Chromium for the PDF).
Missing software is proposed, never installed: ask for each item separately (pipeline-setup §3). Step evidence and the PDF stay
opt-in because they record a video of every test and add files to each one.

## The custom evidence report (`evidence-pdf`)
Chosen like any reporter. It is the one to offer when the user needs proof of what ran: **a PDF with, per test and per attempt
(retries and the regression run are separate sections), the executed steps (result, duration, error), ONE video of the complete
execution journey stored inside the PDF, and ONE screenshot of the final (or failure) state**, followed by the test case's
preconditions, steps and expected results. Cover page: run, environment, counts, contents, how to play the videos, and a list of
**evidence gaps**.

How it works:
- Playwright records one video per test: the reporter requires `evidence.video: "on"` (config validation rejects anything else).
- While tests run, the shared fixture (`fixtures/test.<ext>`, auto fixture `stepEvidence`) wraps `test.step`: every step
  records its outcome, duration and error (secrets masked), and a final-state screenshot is taken when the test ends. This only
  happens when `reporters` contains `evidence-pdf` (audit mode with `stepScreenshots`). Password inputs and `reporting.maskSelectors`
  are masked in the screenshot (not in the video).
  Tests that import `test` from `@playwright/test` directly, or that never call `test.step`, have no step log:
  they appear in the report with a gap note instead of silently missing (Playwright's own screenshot stands in for the final state).
- `report build` reads those logs and the `video` attachments from the execution results, writes
  `automation/reports/<runId>/evidence-report/evidence-report.html` (one self-contained file, screenshots embedded, each video a
  play-icon link) and prints it to `evidence-report.pdf` with the project's own `@playwright/test` + Chromium
  (`engine/tools/render-pdf.ts`). Chromium cannot embed media, so `engine/pipeline/pdf-embed.ts` then appends a PDF update that
  turns each link into an annotation holding the recording (and lists it in the Attachments panel); the result is read
  back and each video is compared byte for byte, and each in-page player is followed to the file it plays. No extra package is needed.
- **Playing inside the PDF.** Playwright records WebM, which no PDF viewer plays in a page. When an `ffmpeg` with `libx264` is already
  available (`FFMPEG_PATH`, else `ffmpeg` on the PATH; `engine/pipeline/video-transcode.ts`; Playwright's own ffmpeg cannot write H.264),
  `report build` converts each recording to H.264 MP4 (`reports/<runId>/evidence-report/videos/`), stores the MP4 in the PDF and puts a
  **player** (Screen annotation + Rendition action, a dark 16:9 box) in the test's Execution evidence section: click it and the video plays
  inside the page in **Adobe Acrobat / Reader**. Browser viewers (Chrome, Edge, Firefox) never play video inside a PDF: they show the
  Attachments panel, where the MP4 opens in any player. Reporter detail says `N play inside the PDF in Acrobat/Reader, M attachment only`.
- **Without ffmpeg** (or for a recording that fails to convert) the video stays a WebM *file attachment* (Acrobat/Reader, Foxit and PDF-XChange
  open it with another program) and the cover page and reporter detail say why. **Never install ffmpeg on your own**: when the user wants
  playback inside the PDF, tell them it needs an ffmpeg build with libx264 on the PATH (or `FFMPEG_PATH`), and install it only with their
  explicit yes for that dependency (record it with `deps record`); then run `report build` again. Fallback for any viewer: the recordings under
  `automation/test-results/<runId>/`, whose paths are printed in the PDF. Not verified in a real Acrobat here: say so when handing it over.
- Status in `reporters`: `generated` (detail says tests/steps/screenshots/videos embedded/size, and the number of evidence gaps),
  `missing_dependency` (`@playwright/test` or Chromium not installed: ask approval for that dependency, record it, run
  `report build` again) or `failed` (detail has the reason; also when the videos could not be embedded). A gap does not fail the report, but **tell the user about it**.
- Screenshots and videos show the page exactly as rendered, so values typed into visible fields appear in them; only password fields
  are masked, and only in the screenshot.

## Build and verify
`node dependencies/engine/cli/pipeline.ts report build <runId>`:
- Computes the final outcome per test: `passed`, `failed`, `flaky` (retry-only pass), `healed` (failed, guarded fix,
  rerun passed, regression didn't fail), `blocked` (not runnable: needs clarification, excluded, no result),
  `skipped`. A regression failure overrides everything.
- `unresolved` = blocked + failures that aren't confirmed application defects.
- Verifies each selected reporter's output for the `initial` execution: `results.json` parses, `html/index.html`
  exists, `junit.xml` is JUnit XML; for Allure it runs `allure generate` (project-local CLI, else global) and checks `index.html`;
  for `extent` it writes the HTML page from the `initial` (and `regression`) results and checks the file is not empty;
  for `evidence-pdf` it builds the PDF from the `initial` (and `regression`) results and checks it is a PDF.
- Writes `summary.json` and `summary.md` into the run directory (`dependencies/runs/<runId>/`) **even when a reporter failed**, so the failure is visible.
- Writes the **automation coverage** for every run, whatever reporters were chosen: `automation-coverage.json` in the run directory and the page
  `automation/reports/<runId>/automation-coverage/index.html` (one self-contained file). Every test case is *automated* (a script exists and
  Playwright ran it) or *not automated* with a reason code and the cause; see "Automation coverage" in `playwright-pipeline/stages.md`.
  It is derived data: a failure to write it is reported in the `coverage` block and never fails the report. Register it when completing the
  stage: `--artifact automationCoverage=automation-coverage.json`. For a run that stopped before this stage, `pl report coverage <runId>` builds it.
- Exit 2 if any reporter failed or the run had a runner error. Then set `report_generation` to `failed` with the
  reason. Never claim a report exists unless `status: generated`.
- Keeps report generation apart from test results: `reportGeneration` (`ok`, `failed[]`, duration, files, bytes) answers "could the
  reports be built", `counts` answers "how did the tests do". A broken reporter never changes a count and a failing test never marks
  a reporter failed. Only the reporters in `reporters` are verified or built. Everything is derived from the normalized execution
  results (`generatedFrom` records their hashes); each reporter's duration, file count and size are in `summary.json`.

## Finalization
`node dependencies/engine/cli/pipeline.ts run finalize <runId>` copies the counts onto the manifest and applies `retention.keepRuns`
(only when configured). Then complete `finalization`. The final message shows: counts table, failure categories,
healing attempts and results, unresolved tests with reasons, the automation coverage (automated vs not, with reasons; `automation/reports/<runId>/automation-coverage/index.html`), report paths (`automation/reports/<runId>/initial/html/index.html`,
the Allure report, the Extent report `automation/reports/<runId>/extent-report/index.html`, the evidence PDF `automation/reports/<runId>/evidence-report/evidence-report.pdf`,
`dependencies/runs/<runId>/summary.md`) and the evidence directory `automation/test-results/<runId>/`.

## Metrics
`run finalize` writes `metrics.json` into the run directory (derived from the manifest; failing to write it never blocks finalization);
`run metrics <runId>` shows it live: per-stage duration (summed over attempts), final status, attempts, interrupted attempts (process
died, distinct from an explicit `failed`), artifact count/size, execution retries and worker plan, healing attempts, report time,
cache hits/misses with the reason for every rebuild, and agent calls per stage (tokens only when reported). `run baseline [runId...]`
ranks stages by median completed duration. `run compare <baselineRunId> <candidateRunId>` compares two runs of the same suite: it first
checks that no test went missing or got worse (verdict `incorrect` otherwise, whatever the timing), then reports the per-stage time
difference. Metrics are evidence for choosing what to optimise, never inputs to a pass/fail decision.

## Sensitive data
Runner logs and error messages are redacted using the values of `auth.credentialEnvVars` (and the variables the pipeline created in `.env`), and credential-shaped text (authorization and cookie headers, JWTs, token/api-key pairs) is masked even when it is not a configured secret. Don't attach page dumps
containing personal data. Screenshots and videos follow the configured evidence modes, so prefer failure-only modes.

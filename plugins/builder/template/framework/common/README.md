# Test automation ({{LANGUAGE}} · Playwright Test)

This folder is the Playwright framework scaffolded by the `builder` plugin. It has its own `package.json`
and `node_modules`. It holds the framework and nothing else: the pipeline engine, docs, test-case input and run state
live in the sibling **`../dependencies/`** folder. Keep the two folders together (`fixtures/` imports the config loader
from `../dependencies/engine/`; `playwright.config.{{EXT}}` has no such link). Run every command below from this folder
(`cd automation`).

Language: **{{LANGUAGE}}** (chosen at `/builder:init`; fixed for this project).

## Layout

```
pages/                  Page Object Model classes: locators and page-specific actions (BasePage.{{EXT}} + one class per page)
tests/                  every test (*.spec.{{EXT}}). Files the pipeline wrote start with "// @builder:generated" and are
                        regenerated/healed by it; delete that line to take a file over. All other files are yours: never modified
helpers/                reusable utilities shared by tests and pages (test-data.{{EXT}}: requireEnv, requireWorkerEnv, uniqueSuffix, redact)
fixtures/               the shared `test` / `expect` (test.{{EXT}}) — import these, never @playwright/test directly
config/                 automation.config.json: approved, non-secret choices (base URL, browsers, evidence, reporters)
reports/<run-id>/       reporter output per pipeline run (html, json, allure, and extent-report/ with the Extent report, evidence-report/ with the evidence PDF); reports/adhoc/ for `npm run test:adhoc` (plain Playwright, no run; git-ignored)
test-results/<run-id>/  screenshots, video, traces per pipeline run; test-results/adhoc/ for `npm run test:adhoc` (git-ignored)
playwright.config.{{EXT}}   standard Playwright config; the pipeline fills it from config/automation.config.json, edit it freely (PW_BASE_URL, PW_RETRIES, PW_WORKERS override at run time)
package.json  .gitignore  .env.example  README.md
```

Created only when used (rule: no folder without a clear responsibility):

```
test-data/              non-sensitive test data (never credentials)
auth/                   login setup (*.setup.{{EXT}}) and the saved storage state (auth/storage-state.json, git-ignored);
                        created when the authentication approach is "storage-state"
```

Where the rest went (`../dependencies/`, not part of the framework):

```
engine/                 the pipeline engine (TypeScript run by Node). Plugin-managed: refresh it with
                        /builder:init --update instead of editing it
docs/                   test-case format and run-artifact reference
input/test-cases/       your test cases in the pipeline's Markdown format (imported from wherever you keep them)
runs/<run-id>/          per-run manifest, specs, exploration, healing log, summary (git-ignored)
state/                  scaffold.json (chosen language), dependency-log.json (approved installs)
```

## Daily use

| Task | Command |
|---|---|
| Run the whole pipeline (from the project root) | `/builder:playwright-pipeline` (asks where your test cases are and converts them into `dependencies/input/test-cases/`) |
| Run the tests and record a run (run folder in `dependencies/runs/<run-id>/`, results, failure triage, the chosen reports and evidence) | `npm test` · `npm test -- tests/login.spec.ts --project chromium --retries 0` |
| Same, with the browser window visible (still records the run, reports and evidence) | `npm run test:headed` |
| Run the tests directly, with no run recorded (debugging) | `npm run test:adhoc` · `npm run test:ui` (interactive UI mode) |
| Open the last plain-run HTML report | `npm run report` |
| Pipeline CLI (from `dependencies/`) | `npm run pipeline -- run list` |

## Writing tests by hand

Put them in `tests/<feature>.spec.{{EXT}}` (no generated header):

```{{FENCE}}
{{EXAMPLE}}
```

Conventions (the pipeline's reviewer enforces the same ones for generated tests):

- Import `test` and `expect` from `fixtures/test.{{EXT}}`; it adds failure diagnostics automatically.
- Start the title with `[<ID>] ` and add the `testId` annotation — results, triage and healing map back to it.
- Locators in this order: `getByRole` → `getByLabel` → `getByPlaceholder` / `getByText` → `getByTestId` →
  a scoped `locator()` with a comment. No XPath, no `waitForTimeout`, no `.only` / `.skip`.
- Page objects own locators and actions; assertions stay in the test. Generic, app-agnostic functions go in `helpers/`.
- Navigate with relative paths (`page.goto('/login')`); the base URL comes from config.
- Secrets: `requireEnv('NAME')` only. Real values live in `.env`, never in code, config or reports.
- Create data with `uniqueSuffix()` and clean up only what the test created.

## Configuration

Settings are chosen once with `/builder:playwright-pipeline` and stored in
`config/automation.config.json` (never edit it by hand). Precedence, low → high: built-in defaults →
config file → env vars (`PW_BASE_URL`, `PW_ENVIRONMENT`, `PW_BROWSERS`, `PW_WORKERS`, `PW_RETRIES`) → command arguments.

---
name: init
description: Scaffold the Builder into the current project — the Playwright framework in automation/ (pages, tests, helpers, fixtures, config) and everything else the pipeline needs in a sibling dependencies/ folder — in the language the user picks (TypeScript or JavaScript), migrate an older single-folder layout, or update the engine files to this plugin's version. Installs nothing.
argument-hint: "[--language typescript|javascript] [--update] [--with-demo] [--with-pipeline-tests] [--force]"
disable-model-invocation: true
---

# /builder:init

Sets up the current project so the pipeline commands can run. It creates **two sibling folders**:

- **`automation/`** — the Playwright framework and nothing else, laid out as in `playwright_framework_structure.md`:
  `pages/`, `tests/`, `helpers/` (mandatory), `fixtures/`, `config/`, and `reports/`, `test-results/` (generated), plus
  `playwright.config.*`, `package.json`, `.gitignore`, `.env.example`, `README.md`. It has its own `package.json` and
  `node_modules`; `test-data/` and `auth/` are created later, only if a test needs them.
- **`dependencies/`** — everything that is not framework: the pipeline `engine/`, `docs/`, the test-case `input/`,
  run state `runs/`, bookkeeping `state/`, and the optional demo app and engine tests. No `node_modules` here.

The host project's own files are untouched apart from a rules block in the root `CLAUDE.md`. The pipeline engine is
TypeScript run directly by Node (`node dependencies/engine/cli/pipeline.ts`); the Playwright framework is
TypeScript **or** JavaScript, as the user chooses.

## Steps

1. **Language — ask, never default.**
   - If `dependencies/state/scaffold.json` exists (or, in an older project, `automation/config/scaffold.json`), the
     language was already chosen (read `language` from it); do not ask and do not pass `--language`. It cannot be
     changed in place.
   - Otherwise, unless `$ARGUMENTS` already contains `--language`, ask (how to ask in Claude Code and Cowork, and the chat
     fallback when the dialog does not appear: [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md)): *"Which language should
     the Playwright framework and generated tests use?"* with options **TypeScript (Recommended)** — typed
     fixtures/page objects, compile-time checks of generated tests (needs the `typescript` dev dependency) — and
     **JavaScript** — plain ES modules with JSDoc types, no compiler. Say that the choice is fixed for the project.
   - Pass the answer as `--language typescript|javascript`.

   **Project root first.** Work out `<root>` as environment.md ("Where things are") describes. In Cowork the shell does not start in the
   attached folder, so always pass `--root "<root>"` (in Claude Code it may be left out when the launch folder is the project).

2. Show what will happen with a dry run (if `${CLAUDE_PLUGIN_ROOT}` is not expanded or the script is not there, locate the plugin
   as described in environment.md, "Where things are"):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --dry-run --language <choice> [--root "<root>"] $ARGUMENTS
   ```

   Summarize `created`, `overwritten`, `merged`, `moved`, `removed`, `rewritten` and `warnings` from the JSON.
   `overwritten` is non-empty only with `--update` (plugin-owned files: `dependencies/engine`, `dependencies/docs`,
   `dependencies/tsconfig.json`, `automation/tsconfig.json`/`jsconfig.json`) or `--force` (everything).
   `automation/playwright.config.*` is the user's file: created once, never refreshed by `--update` (only the old thin
   wrapper from plugin 0.6.x and earlier is replaced, with a warning).
   **`migratedFromLegacyLayout: true`** means the project was scaffolded by plugin 0.2.x with everything inside
   `automation/`. The script moves the pipeline's data out (`input/`, `output/runs/` → `dependencies/runs/`, `demo/`,
   `config/scaffold.json` and `config/dependency-log.json` → `dependencies/state/`), renames `utils/` to `helpers/`,
   moves `tests/setup/` to `auth/`, flattens `tests/generated/` + `tests/handwritten/` into `tests/` (generated specs get the ownership header), rewrites the affected imports in the user's own files, and **replaces** the
   plugin-managed copies of `engine/`, `docs/`, `tsconfig.engine.json` and `tests/pipeline/`.
   If anything would be overwritten, removed or moved, or a warning mentions an existing `package.json` problem or an
   older root-level install, tell the user and ask to confirm before step 3.
   Exit code 2 with `needsInput: "language"` means step 1 was skipped.

3. Run it for real (same arguments, without `--dry-run`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --language <choice> [--root "<root>"] $ARGUMENTS
   ```

   Exit code 2 with `needsInput: "root"` means the working directory is a Cowork session folder: rerun with `--root` set to one of
   `candidateRoots` (the user's attached folder). Afterwards confirm `projectRoot` in the JSON is the user's folder.

4. Report the result and the next step. Do **not** install anything here: `typescript` (TypeScript projects only),
   `@types/node`, `@playwright/test` and browsers are offered one by one, with explicit approval, by the
   preflight/configuration stages of `/builder:playwright-pipeline`. They install into `automation/`.
   After a migration, remind the user that runs moved to `dependencies/runs/` are history only (do not resume them) and to
   re-check any moved `auth/*.setup.*` file.

## What it creates

```
automation/                              the framework only
  pages/BasePage.*                       page objects
  tests/                                 all tests; pipeline-written files start with "// @builder:generated"
  helpers/test-data.*                    reusable utilities (requireEnv, uniqueSuffix, redact)
  fixtures/test.*                        shared test/expect
  config/                                automation.config.json (written by the pipeline setup)
  playwright.config.*  tsconfig.json (TypeScript) | jsconfig.json (JavaScript)
  package.json  .gitignore  .env.example  README.md
dependencies/                            not framework
  engine/  docs/                         pipeline engine and reference (plugin-managed)
  input/test-cases/                      your test cases, converted to the pipeline's Markdown by the pipeline
  runs/                                  per-run state (created by the pipeline, git-ignored)
  state/scaffold.json                    records the chosen language and plugin version
  package.json  tsconfig.json (TypeScript)  .gitignore
```

- Existing files are skipped; they are overwritten only with `--update` (plugin-owned files) or `--force` (all).
- `.gitignore` lines and `package.json` scripts are merged, never replaced. No dependencies are added.
- The project's root `CLAUDE.md` gets the pipeline's hard rules between `<!-- builder:start/end -->` markers.

Optional: `--with-demo` adds the local demo app (`npm run demo:app` in `dependencies/`) and demo test cases under
`dependencies/demo/`; `--with-pipeline-tests` adds the pipeline's own `node:test` suites in `dependencies/engine-tests/`
(`npm test` in `dependencies/`). In `automation/`, `npm test` runs the tests as a recorded `run-tests` run (run folder, reports, evidence);
`npm run test:adhoc` is plain Playwright with no run.

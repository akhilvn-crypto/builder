<!-- builder:start -->
# Builder — agentic Playwright pipeline (plugin: builder)

Two sibling folders: **`automation/`** is the Playwright framework and nothing else (own `package.json` and
`node_modules`; `pages/ tests/ helpers/ fixtures/ config/ reports/ test-results/`), **`dependencies/`** is everything the
pipeline needs (`engine/`, `docs/`, `input/test-cases/`, `runs/`, `state/`; no `node_modules`). Never put pipeline files in
`automation/` or framework files in `dependencies/`. Test files and page objects are named relative to `automation/`
("tests/login.spec.ts"); test-case input and run artifacts relative to `dependencies/` ("input/test-cases/login.md").
Files in `automation/tests/` starting with `// @builder:generated` are pipeline-owned; every other test file is
handwritten and never modified by the pipeline.

Commands: `/builder:do-automation` (init + the whole pipeline), `/builder:design-test-n-automation` (detailed stories in `stories/`
→ test design → test cases → automation readiness → Playwright scripts → execution → reports, the test cases handed forward by itself), `playwright-pipeline`,
`generate-tests`, `run-tests`, `heal-tests`, `reports` (change which reports are produced), `init --update`. The whole test design on its own
(stories → validated test cases, no automation; re-run to resume): `/builder:generate-test-cases`. `publish-zephyr` publishes one test-case file to Zephyr Scale/Jira and is a manual QA command only. Their
skills hold the stage playbook, framework conventions and config precedence; read them when you work on that part.

## Hard rules

- **No unapproved installs.** Never install packages, browsers, CLIs or skills without an explicit yes for
  *that specific* dependency. Installs run inside `automation/` (`cd automation && npm install …`). Record every
  decision with `node dependencies/engine/cli/pipeline.ts deps record ...`.
- Never invent base URLs, credentials, test steps or expected results.
- Test design output (`test-design/`: one `<story>-testcase.md` per story, `state/` for its checkpoint and traceability) is written only by the design
  stages (`agents/test-design-orchestrator.md`, Python scripts in the plugin) and only read by the automation stages: `pipeline.ts design handoff`
  checks it is current, judges automation readiness (manual cases are listed with the reason and not automated) and imports the rest into
  `dependencies/input/test-cases/design/`. Never edit a design file to make a test pass. **Never run `/builder:publish-zephyr`**, or any
  Jira/Zephyr call, from a pipeline, a stage command or on your own: the user types that command themselves.
- Test cases are normalized once into `canonical-test-cases.json`; `test-specs.json` is projected from it. Never edit either by hand
  (`specs check <runId>` verifies them). When two columns fit one field equally well, ask the user which header is meant and save it with
  `input map`; never pick one.
- Never write secrets to config, tests, logs or reports. Secrets live in `automation/.env` (git-ignored).
  Credentials/emails found in test cases are moved there by `specs parse` (don't ask the user for them); if a value is
  missing, tell the user which names to add to `automation/.env`, never ask for the value in chat.
- Never weaken/delete assertions or skip tests to get a pass. Retry-only passes are `flaky`, not `passed`.
- All pipeline state changes go through the CLI. Do not hand-edit manifests or the config file. CLI replies are short;
  `run show <runId>` prints the full manifest only when you need it.
- The language (TypeScript or JavaScript) is the user's choice, made once at `/builder:init` (stored in
  `dependencies/state/scaffold.json`). Never default it, never convert files to the other language.
- Keep `automation/` to the framework structure: no extra folders without a clear responsibility.
- Orchestration runs in the main session (`/builder:playwright-pipeline`); stage subagents return
  questions/blockers to it instead of asking the user.
- Leave nothing running: name browser sessions `explore-<runId>` / `heal-<runId>` and close them; the CLI stops the rest (`cleanup run <runId>`,
  automatic at stage end, resume and finalization). Only processes recorded for the run or sessions named with its run id are stopped;
  never `close-all`/`kill-all`, never a process chosen by name. Report `stillRunning` if the cleanup could not stop something.
- Test data: tests register what they create with the `cleanup` fixture (`cleanup.register({ entity, identifier, undo })`); the CLI removes what is
  left from the run's ledger (`cleanup data <runId>`, automatic after execution/healing/regression and at finalization), only when
  `cleanup.mode` allows it, only in an allowed non-production environment. Never delete anything that is not in the ledger, never in bulk, never guess a
  delete endpoint. Tell the user which records are still there and how they can be deleted; leftovers do not fail the run.
- Reuse earlier work only through the CLI's cache decisions (`cache status <runId>` says why something was rebuilt); execution results are
  never reused. Use agents only where `agents plan <runId> <stage>` says judgment is needed. Trust saved login state only after the pipeline
  validated it; `automation/auth/` and `.env` stay git-ignored. Workers follow `exec plan`; judge any speed-up with `run compare`.
<!-- builder:end -->

# Pipeline efficiency: behaviour, trade-offs and limits

How the pipeline avoids repeated work, uses agents sparingly, handles saved login state, runs things in parallel and controls
reporting volume. It describes what the code does, not what it measured: **no speed-up is claimed here**. Judge any change by
running the same suite twice and comparing (`run compare`, below).

CLI: `node dependencies/engine/cli/pipeline.ts` (`pl` below). Run state is in `dependencies/runs/<run-id>/`; caches in
`dependencies/state/` (git-ignored, local to the machine).

## 1. Run metrics and exploration reuse

- **Metrics:** every stage attempt is recorded in the manifest, so `run metrics <runId>` (also written to `metrics.json` by
  `run finalize`) reports duration, final status, attempts and interrupted attempts per stage, artifact sizes, retries, healing
  attempts, report time, cache decisions and agent calls. `run baseline` ranks stages by median completed duration.
- **Exploration reuse:** saved observations (`state/exploration-store/`, per base-URL origin) are evidence to re-check, not truth.
  `explore plan` decides per test case: `explore`, `revalidate` (one fresh snapshot confirms each saved role + name), `covered` or `reuse`.
  A changed test case, an unknown/stale/ambiguous locator or a locator that failed in execution is explored again; the reason is recorded.
  `covered` means the test case is unchanged, its saved evidence is consistent and verified, and its generated test is still current
  (cache hit on evidence, rules, imports and the reviewed source): nothing is explored or revalidated, because the run's own execution is the
  check and a locator that fails to resolve there makes the evidence stale. `explore plan --revalidate` (or `--no-cache`) turns this off for a run.
  Evidence is saved only if every locator a step names is listed in its page's elements, so a half-recorded step can no longer force a re-exploration.
  **Snapshots without an agent:** `explore snapshot <runId>` takes the revalidation snapshots itself (`engine/tools/aria-snapshot.ts --batch`, one
  headless browser, navigation only, under the process supervisor) and so a plugin or engine update with no application change costs no explorer
  call. The rule is unchanged - a snapshot from this run must show every needed locator exactly once - with two guards an agent's judgment would have
  supplied: the page must be the one asked for (a login redirect is never compared), and a locator not found is inconclusive, never stale (it may only
  appear after an interaction), so such a page is left for the explorer and nothing is invalidated. Only `explore revalidate` invalidates. Login
  state is used only when `auth-state.ts` accepts it; with `ui-login` a page behind the login is left for the explorer.
  **Known pages:** a test case that must be explored (new or changed) is no longer explored from nothing. The plan lists the saved pages it
  probably visits (`knownPages`: its own earlier pages, its module's pages, pages most cases share) and the explorer's brief carries their verified
  locators. The explorer confirms each page it reaches with one snapshot (`explore revalidate`) and points its steps at `saved:<page key>` instead of
  re-observing and re-listing the page; `explore assemble` accepts that only for a page revalidated in this run with every named locator `present`
  (otherwise it refuses with the reason). `reuse.seededPages` and the per-spec reason show what was taken from the store.

## 2. Cross-run artifact reuse

Entries live in `state/artifact-cache/<kind>/<name>.json`:

| Kind | Name | Reused instead of | Depends on |
|---|---|---|---|
| `specs` | hash of the input path | parsing the test-case files | content of every input file, the saved column mappings, parser source, test-spec schema |
| `generation` | test ID | calling the generator for that test | that test case, its application evidence, language and auth approach, the plugin version (generator rules), the framework files **that test imports**, and the test's own source block |
| `review` | test ID | the reviewer agent for that test | the test's source block, its test case and evidence, static-review rules, plugin version (reviewer rules), the framework files it imports |
| `typecheck` | `framework` | the TypeScript project check | every file `automation/tsconfig.json` includes (and the engine config code), TypeScript and Playwright versions; only a pass is cached |

Exploration observations keep their own store; their reuse is listed in the same per-run ledger. **Execution results are never cached.**
Credential values found in test cases are never cached: a cache hit leaves `.env` as the first parse wrote it (use `--no-cache` to
read the values again).

An entry is reused only when it parses, has the current schema, was validated, its payload still hashes to the recorded hash, every
recorded input and version equals the current one, and the caller's own check passes (a generated test is still in a pipeline-owned
file, exactly as it was reviewed). Otherwise the artifact is rebuilt and the reason recorded.

| Change | What is rebuilt |
|---|---|
| a test-case file or a column mapping | the parse, and only the tests whose own case changed (per-test fingerprint) |
| parser or test-spec schema (source change) | the parse |
| application evidence for one test | that test's generation and review |
| a fixture, page object or helper a test imports (directly or transitively) | the tests whose block uses it; another module's page object touches nothing |
| plugin update (new generator/reviewer rules) or `tsconfig` change | every generated test (and its review) |
| a generated test edited, removed, or its ownership header deleted | that test is regenerated (hand edits to pipeline-owned files are not preserved: take the file over by deleting the header line) |
| a healed test | its cache entry is moved to the healed source after the rerun passed |

`cache status <runId>` lists hits per kind and every rebuild with its reason; `cache inspect <kind> <name>` shows one entry's inputs and
versions. Flags: `--no-cache` on `specs parse`, `generate plan`, `review static|plan|seal`; `generate plan --force`.

**Generation flow:** `generate plan` (one batch per module file) → generator agent(s) only for tests marked `generate` → `generate assemble`
(merges the batch manifests and the reused tests into `generation-manifest.json`) → `generate validate` → review → `review seal` (the point
where tests become reusable: only validated and reviewed work is cached; sealing is refused if a test the plan skipped changed meanwhile).

### The test ledger: knowing what is already built before doing anything

`state/ledger/<origin>.json` (git-ignored, one file per base-URL origin, next to the observation store of the same name) has one entry per
automated test case: its title and module, the test-case file, **where its exploration evidence lives** (the run that observed it, the page
keys, the store file, the evidence hash), **the generated test file** (path, source hash, the plugin version and generator rules it was sealed
with), its review (reviewer rules), and **how it last ran** (last outcome, last run that passed, the last five outcomes).

It is an index, not a cache. The store, the artifact cache and the run directories stay the authority, and nothing is reused because the
ledger says so. It exists for two things:

- **`ledger plan <runId>`** (run right after `specs parse`) tells you, per test case and before any agent is chosen, what this run has to redo
  and why. It asks the same deciders the stages use, so the preview and the stages agree (a test covers: `unchanged`; `re-review` - only the
  review is redone; `redesign` - the evidence is kept and only the test is rebuilt, e.g. after a plugin update changed the generator rules;
  `explore` - the case or its evidence changed; `new`). Its `work` block counts the agent calls ahead: fresh explorations, snapshot-only
  revalidations, generator batches, reviewer tests; `causes` groups the reasons. A `redesign` test is never re-explored: the explorer takes one
  snapshot of the pages it uses, and the generator is pointed at the version already in the file (`redesign` in its brief: `previousFile`, `why`)
  and edits that test in place instead of writing it from scratch. A test whose case changed, or whose file was edited by hand, is written anew.
- **History for context.** `ledger show [<runId>] [--test-id <id>]` lists the automated tests, where their knowledge is, which pages are shared by
  which tests (so a new test case can see what already covers a page), and how each last ran. The last outcome never decides whether a test runs:
  execution results are not reused, and a failing last run changes no plan.

The ledger is written by `ledger update <runId>`, which runs by itself when `script_review` and `report_generation` complete and in `run finalize`
(a failure there never blocks a stage). A missing or corrupt ledger changes no decision (a corrupt one is rebuilt from the store and the cache; its
execution history is lost). Tests that are not in the current input stay in the ledger untouched, so running a subset of the cases forgets nothing.

## 3. Agents only where judgment is needed

`agents plan <runId> <stage>` decides in code and writes the brief the agent gets (`briefs/*.json`, bounded: lists are cut to 25 items and
the whole brief to 40 KB, with the cut reported).

| Stage | Runs without an agent when | Otherwise |
|---|---|---|
| test_analysis | every case parsed without ambiguity and every input table was read cleanly | test-analyst gets the ambiguous cases and the noted tables |
| application_exploration | every case has evidence revalidated in this run or is `covered` by a still-current generated test | explorer gets only cases to explore/revalidate |
| test_generation | every test is reusable | one generator per module batch, each with only its tests and evidence |
| script_review | every test has a valid earlier review | reviewer gets only the other tests |
| failure_triage | no failures, or all high-confidence from clear evidence | healer (Phase A) gets only the uncertain failures |
| healing | no eligible script defect | healer gets, per test, the failure, the test's own source block, its case and evidence |
| execution, regression_validation, report_generation, finalization, setup stages | always | (the CLI runs them) |

Invocations are recorded with `agents record` (tokens only when reported) and appear in `run metrics`. `review seal` refuses to record a
review as done if the plan required the reviewer and no invocation was recorded.

## 4. Saved login state

With `auth.approach: storage-state`, `exec run` first decides *reuse* or *refresh*. Reuse requires `auth/storage-state.json` to be
well-formed, created by the pipeline (a small record next to it holds only time, origin and variable names), for the same origin, no older
than `auth.state.maxAgeHours` (default 8), with not every cookie expired, and, when `auth.state.probePath` is set, accepted by the
application (one request with the state's cookies; only the status and redirect target are looked at). Otherwise the stale file is removed
and the setup project signs in.

**The setup project runs in every run, before any test.** When the state was judged usable the executor sets `PIPELINE_AUTH_STATE=reuse`; the setup
(`reuseOrSignIn` in `helpers/auth`) then asks the application once, in this run, whether the saved session is still accepted and
signs in again only if it is not (`authState.gate`: `reused` or `signed_in`). A session that ended since it was saved (expired, ended on the server,
cut by another sign-in) therefore never reaches a test, and this needs no `probePath`. A plain `npx playwright test` always signs in.

**Tests that sign in or out themselves** (tag `@own-session`, starting from `storageState: { cookies: [], origins: [] }`) run in the `own-session`
project, the teardown of `setup`: Playwright runs it after every project that depends on `setup` has finished, pass or fail. Signing in again as the
same account (a one-session-per-user app, a one-time code) can otherwise end the session another worker's test is using. A project can have only one
teardown, so with several browsers these tests run in the first browser only (`exec plan` says so).

**Dependent tests** run in order in one serial group on one worker; a failure skips the rest of the group, reported as blocked by the test that failed.

If the application still treats tests as logged out after the setup accepted the session, the run is diagnosed (`authState.diagnosis`), the state
discarded and the tests run again **once**. After a sign-in that just happened, no second run is made: a test that ends on a login page or fails as
logged out (`authState.lostLoginTests`; found from the page it ended on, `finalUrl`, as well as from its error text) is classified
`test_data_or_precondition` and never offered for healing. A failing login is a `runnerError`.

Limits: without a probe, the age/cookie check alone cannot tell that the application dropped a session, but the setup's check does. Apps that answer 200
with a login page are caught by the setup's check only if `check` asserts something a signed-in user sees. `auth.state.loggedOutPattern` replaces the generic heuristic.
Secrets: `.env` and `auth/storage-state*.json` must be git-ignored (preflight `secrets-ignored`); logs, errors and diagnostics mask configured
secrets and credential-shaped text.

## 5. Parallelism

- **Workers:** `execution.workers` unset means 2 (not Playwright's CPU-based default). The executor passes `PW_WORKERS` from the plan.
- **Isolation** (`execution.isolation`): `serial` = 1 worker; `shared-readonly` = tests never change shared data, tests in a file may run in
  parallel; `per-worker-accounts` = one login per worker (`NAME_1..NAME_N` in `automation/.env`, needs `ui-login`; workers are capped at the
  number of complete accounts). Unset: files in parallel, tests inside a file in order, with a warning when workers share one account. A shared
  storage-state session cannot be combined with per-worker accounts (validation rejects it).
- **Run state:** every read-modify-write of a manifest, the observation store, the cache ledger, agent usage, the healing log and the
  dependency log holds a per-file lock, so concurrent CLI processes cannot lose each other's updates.
- **Parallel generation:** one batch per module file, so batches own disjoint files. `generate assemble` refuses two batches that wrote the same
  file or test or changed the same shared file, and says to rerun them one after another. It detects this from the batch manifests; it cannot
  stop an agent from writing a file it does not own.
- **Measuring:** `run compare <baselineRunId> <candidateRunId>` returns `incorrect` if any baseline test went missing or got worse (including
  passed → flaky), `not_comparable` for unfinished runs or different commands, otherwise `faster`, `slower` or `similar` (within 10 %).

## 6. Reporting

`reporting.mode` is saved with the configuration and only constrains what the user chose:

| Mode | Requires / forbids | Intended for |
|---|---|---|
| `standard` | json; no allure/evidence-pdf; no record-everything video/screenshot/trace | development runs |
| `full` | json; allure allowed; any evidence settings | team testing and CI |
| `audit` | full; plus opt-in step evidence (`reporting.stepScreenshots`: step log + one final-state screenshot) and the `evidence-pdf` reporter (which needs step evidence and `evidence.video: "on"`: one embedded video per test) | sign-off |

The reports themselves (`html`, `allure`, `extent`, `evidence-pdf`) are the user's selection; the mode follows from it (`config reporter-preset --reporters ...` prints the matching
proposal, `extent` needs no software and no extra evidence). `config mode-preset <mode> [--step-screenshots] [--evidence-pdf]` prints a valid proposal; `config report-plan` lists the software the chosen
reporters need and what is missing. Nothing is installed without a separate approval. `report build` keeps `reportGeneration` (did each selected
reporter produce its files, how long, how many files and bytes) apart from `counts`, verifies the files exist before saying a report was
generated, builds only selected reporters, and records which result files the reports came from. The final-state screenshot masks password fields and
`reporting.maskSelectors`; visible page data is not masked, and the embedded videos are not masked at all.

## 7. Nothing left running

A test run starts browsers, workers and sometimes a web server; exploration starts a `playwright-cli` browser session (a detached daemon that
lives until someone closes it). Left alone, these pile up. The pipeline stops them, and only them:

- **Supervised commands.** The Playwright runner, the Allure generator and the PDF renderer run under `engine/tools/supervise.ts`. A timeout stops
  the whole process tree (a plain timeout stops only the direct child), and anything the command leaves behind is stopped when it ends. While it
  runs, what it started is recorded with its start time in `runs/<runId>/processes.json`, so a later cleanup can still find it if the supervisor
  itself was killed (closed terminal, Ctrl+C, crash). A pid alone is not trusted: pids are reused, so a recorded process counts only while its
  start time matches.
- **Browser sessions.** `cleanup run <runId>` asks `playwright-cli -s=<name> close` for each session whose name contains the run id, then stops
  whatever is still running of it and removes the browser's temporary profile folder. Sessions are named `explore-<runId>` / `heal-<runId>`.
- **When.** Automatically: when the exploration stage ends, when any stage fails, blocks or is cancelled, on `run resume`, and in `run finalize`
  (whose `cleanup` block is the final check). On demand: `cleanup run <runId> [--dry-run]`, and `cleanup all [--dry-run]` for the leftovers of
  earlier runs.
- **What it will not touch.** The user's own browsers, dev servers and editors; a `playwright-cli` session with another name; the demo app you
  started yourself; this process and its ancestors. Nothing is stopped by name alone.
- **Honest result.** After stopping, the processes are looked up again. `stillRunning` lists what could not be stopped (for example access
  denied) and `ok` is false; if the process list itself cannot be read the result says so instead of reporting success.

## 8. Test data the run created

Tests change the application under test; leaving that data behind makes the next run depend on it. The pipeline removes what a run created,
and says plainly what it could not remove.

- **Ledger first.** A test asks for the `cleanup` fixture and calls `cleanup.register({ entity, identifier, undo })` right after creating a
  record. The record is written to `runs/<runId>/created-data/<label>/` (one small file per test attempt, so parallel workers never contend)
  before anything is deleted: a test that fails, times out or is killed still leaves its trace. The explorer registers what it creates with
  `cleanup record`.
- **In the test.** After the test (also a failed or timed-out one) the fixture runs the `undo` functions, last-created first, each with a 20 s
  limit, then an optional `verify`. A cleanup problem is attached to the test (`data-cleanup`) and recorded; it never fails the test.
- **Sweep.** `cleanup data <runId> [--dry-run]` takes every ledger record that is not removed and removes it through what the user declared in
  `config.cleanup.entities`: an **API** call (`method`, `path` with `{id}`, headers from env var names, optional `verifyPath` that must answer
  404/410), or the **UI** through the `data-cleaner` agent (`ui.hint`; it reports each result with `cleanup resolve`). Endpoints are never guessed
  or scraped from traffic. It runs by itself after `execution`, `healing` and `regression_validation`, when a stage fails/blocks/cancels, and in
  `run finalize`; repeated sweeps are safe (removed records are skipped).
- **Guard.** Deleting needs `cleanup.mode` `test` (each test removes its own data; no sweep) or `sweep` (nothing removed until one sweep after every test has finished), an `app.environment` listed in `cleanup.allowedEnvironments`,
  and an environment that is not production (`prod`, `production`, `prd`, `live`, refused even if listed). At most `cleanup.maxDeletesPerRun`
  (default 50) API deletions per sweep; the rest are listed. An identifier must be plain characters (`A-Za-z0-9._:@-`) and the resulting URL must
  stay on the app's origin.
- **Honest result.** Statuses: `pending`, `deleted`, `verified_gone`, `failed`, `no_cleanup_path`, `needs_ui`, `blocked`. Whatever is not
  `deleted`/`verified_gone` is a *leftover*: it appears in the stage replies' `data` block, in `run finalize`, and in `summary.md` under "Test
  data" with the reason and how it can be deleted. Leftovers never fail or block a run. `data-cleanup.json` keeps the last 10 sweeps.
- **Static review.** A test that calls `uniqueSuffix()` without `cleanup.register(...)` gets the major finding `register-created-data`.

## Known limits

- Cleanup relies on the OS process list (PowerShell `Get-CimInstance` on Windows, `ps` elsewhere); on a machine where that cannot run, the
  supervisor still stops the command's own tree on a timeout, but leftovers cannot be found and the cleanup reports `unavailable`. The Windows
  path was exercised against real processes and a real `playwright-cli` session; the macOS/Linux path (`ps`, process groups) is covered by
  parsing tests only.
- Commands run through `env run` (the explorer's `fill`/`click` steps) are not supervised: a browser opened that way is found by its session
  name, not by lineage. Security software may flag tools that list and stop processes; if `engine/utils/process-tree.ts` is quarantined,
  allow-list the `dependencies/engine` folder.
- A fixture change touches every test (all tests import `test`); a page object or helper change touches only the tests whose block uses it
  (matched by the imported names). Static relative imports and re-exports are followed; dynamic `import()` and package imports are not.
- The generator and reviewer rules live in the plugin, so their "version" is a fingerprint of the rule files (the agent plus the framework and
  test-data skills) that `init` records in `state/scaffold.json` (`rules.generator`, `rules.reviewer`). A plugin update that leaves those files
  unchanged keeps every cached test and review, and so keeps `covered` exploration; one that changes them regenerates/re-reviews once. A project
  scaffolded before the fingerprints existed falls back to the plugin version (every update invalidates) until its next `init --update`.
- Test data cleanup removes only what the run registered. A test written without `cleanup.register` leaves its data unlisted (the review flags the
  common case, `uniqueSuffix()` without a registration, but cannot see every way to create a record). The API sweep sends the declared headers only; an
  app whose delete needs the browser session cookie needs a `ui` path. UI removal is done by an agent and is checked by a fresh snapshot, not proven.
  The sweep's HTTP check was exercised against a local server with real Playwright tests (pass, failure, timeout); no real application was used.
- Locks are advisory and assume short critical sections; a lock older than 30 s is treated as abandoned.
- The live probe, the evidence PDF and final-screenshot masking were exercised against a local demo app with the real Playwright; behaviour against
  other applications (SSO, SPA logins that answer 200) may differ.

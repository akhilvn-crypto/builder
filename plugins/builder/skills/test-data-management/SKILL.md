---
name: test-data-management
description: Rules for test data — env-var credential references, literal vs secret values, unique data per test, isolation, auth state, and cleanup. Use whenever test data, credentials, accounts or created records are involved.
user-invocable: false
---

# Test data management

## Credentials and secrets
- Specs reference secrets as `env:VAR_NAME`. Values live only in `automation/.env` (git-ignored) or the real environment.
  `automation/.env.example` lists names with empty values.
- In tests: `requireEnv('VAR_NAME')` from `helpers/test-data.<ext>`. It fails with a clear message when the
  variable is unset, and the failure is classified as `test_data_or_precondition`, not a script defect.
- Never write a secret into tests, config, logs, reports, exploration files, commit messages or chat output.
  `config.auth.credentialEnvVars` lists the variable **names** so runner logs and diagnostics get redacted; variables
  the pipeline creates itself (below) are tracked in `dependencies/state/managed-env.json` and redacted too.

### Credentials found in the test cases are moved to `.env` automatically
Do **not** ask the user to supply credentials, emails or usernames that the test cases already contain. `specs parse`:
- treats a Test Data literal as account data when its name is a password/token/secret/API-key field, a username/email
  field, or when the value is an email address; and replaces email addresses typed inside steps with a `{email}`
  placeholder backed by a new Test Data entry;
- names the variable `TEST_<DATA_NAME>` (e.g. `TEST_PASSWORD`, `TEST_EMAIL`), adding the case ID when two cases need the
  same name for different values (`TEST_PASSWORD_TC_2`); names the user wrote as `env:VAR` are never reused for a detected value;
- writes `VAR=value` to `automation/.env` (creating it, and a `.env` line in `automation/.gitignore`, if needed), adds the
  name only to `.env.example`, and keeps just the name in `test-specs.json`. A value already present in `.env` is never overwritten:
  the user's `.env` wins, and the command reports it as `keptExisting`;
- reports names only (`env.created`, `env.filled`, `env.keptExisting`, `env.missing`); values never appear in CLI output or chat.

Generated tests then read the value with `requireEnv('TEST_PASSWORD')` as always.

### When a value is missing, point the user to `.env`
A referenced variable with no value in `.env` or the environment (for example `env:TEST_ADMIN_EMAIL` written by the user,
or a field with no value at all) is `missing`. `specs parse` has already added an empty `NAME=` line for it. Run
`node dependencies/engine/cli/pipeline.ts env check <runId>`; if it exits 2, stop the stage as `blocked` and tell the user
**which names to fill in and where** (`automation/.env`), using the command's `action` text. Never ask for the value in chat,
never write a made-up one, and re-run `env check` after they say it is done.

### Opting out
`- password: literal:wrong-pass-1` marks an intentionally fake value (a wrong password for a negative test, an invalid
email): it stays in the spec as a literal. A value that cannot be stored in a `.env` file (multi-line, or containing all
of `'`, `"` and a backtick) stays `possible_secret_literal`; tell the user to put it in `.env` themselves and write `env:VAR_NAME`.

## Auth approaches (`config.auth.approach`)
- `none`: no login.
- `ui-login`: each test logs in through the UI with `requireEnv` credentials. Simplest; use while suites are small.
- `storage-state`: an `auth/auth.setup.<ext>` setup project saves `auth/storage-state.json` (git-ignored); browser projects depend on it and the
  setup runs in every run. It uses `reuseOrSignIn` (`helpers/auth`): when the pipeline has judged the saved state usable (`auth check`: age, origin,
  cookies, and the application's answer when `auth.state.probePath` is set) the setup still asks the application once (`check`) and signs in again only
  if the session is refused, so a session that ended since it was saved never reaches a test. The state is shared by all workers of a run, so it suits
  tests that do not change the account's data. A test that signs in or out itself must not share it: it is tagged `@own-session`, starts signed out and
  runs after the others. Never commit, copy or print the state file; `auth clear` removes it.
- Never share a mutable browser context between unrelated tests; use the `page` fixture.

## Isolation
- Each test creates what it needs, with `uniqueSuffix('order', testInfo.parallelIndex)`-style names, so parallel workers and reruns don't collide.
- Parallel tests that change shared server-side data need one account per worker (`execution.isolation: per-worker-accounts`, `ui-login`): put
  `NAME_1..NAME_N` next to `NAME` in `automation/.env` and read them with `requireWorkerEnv('NAME', testInfo.parallelIndex)`. The pipeline caps the
  worker count at the number of accounts and says so. Tests that cannot be isolated get `execution.isolation: serial`; tests that never change
  shared data may use `shared-readonly`.
- Never rely on another test's data or on execution order.
- Shared reference data (an existing product, a seeded account) must be named in the spec's preconditions.
  The pipeline doesn't create or modify shared data automatically.

## Cleanup — removing the data a run created

Config: `cleanup.mode` is one of two. `test`: each test removes what it created, right after that test finishes (its own `undo`; no sweep
afterwards). `sweep`: nothing is deleted while tests run; one sweep after **every** test has finished removes the records through the
declared API/UI path, so a later test can still use a record an earlier one created. No `cleanup` block = nothing is deleted (what the run
created is still listed). It is a user choice made in setup, never defaulted. `cleanup.allowedEnvironments` names the environments where deleting is allowed; a production
environment (`prod`, `production`, `prd`, `live`) is refused whatever the config says. Records are only ever removed from a **ledger** of what
the run itself registered (`dependencies/runs/<runId>/created-data/`): never by search, wildcard or "everything that looks like test data".

**In a test** (the generator does this; handwritten tests may too): ask for the `cleanup` fixture and register each record right after the test
creates it:

```ts
test('[TC-010] Create an order', { annotation: { type: 'testId', description: 'TC-010' } }, async ({ page, cleanup }) => {
  const name = uniqueSuffix('order', test.info().parallelIndex);
  // ...create the order through the UI...
  cleanup.register({
    entity: 'order', identifier: name,
    undo: async () => { /* delete it the way the app allows, e.g. the same page object's delete action */ },
    verify: async () => /* true when it is gone */ (await page.getByText(name).count()) === 0,   // optional
  });
  // ...assertions...
});
```
- Register **immediately after creating**, before assertions: the record is written to the ledger first, so a test that fails, times out or is
  killed still leaves a trace. `undo` runs after the test (also a failed one), last-created first; it must remove only that record.
- `identifier` is the unique name from `uniqueSuffix()` or the id the app returned (letters, digits and `. _ : @ -`). Never register a record
  the test did not create, and never a shared or seeded one.
- No way to remove it from inside the test? Register it **without** `undo`: in `sweep` mode the sweep may still remove it through
  `config.cleanup.entities`; in `test` mode (and otherwise) it is listed as left behind. Say so in the generation report.
- In `sweep` mode `undo` does not run (the record stays until the sweep), so the sweep needs `config.cleanup.entities` for every entity.
- A cleanup problem never fails the test: it is attached as `data-cleanup` and recorded in the ledger.

**After the run** (`pipeline.ts cleanup data <runId> [--dry-run]`, run by the pipeline after execution, healing and regression, on a failed run,
and at finalization): for every ledger record still not removed, in `sweep` mode only, in an allowed environment, at most
`cleanup.maxDeletesPerRun` (default 50):
- `config.cleanup.entities.<entity>.api` — `{ method, path: "/api/orders/{id}", headersFromEnv?, verifyPath? }`: one HTTP call to the app's own
  origin, headers from env var **names**. **Endpoints are never guessed or scraped:** they are declared by the user (or confirmed by them
  after the explorer saw the request). Cookie-only APIs that need the browser session cannot be called here; use `ui` for those.
- `config.cleanup.entities.<entity>.ui.hint` — how the record is removed in the UI (from the test case or the app). The record is handed to the
  `data-cleaner` agent, which removes it in a named browser session and reports each result with `cleanup resolve`.
- neither — the record is reported as left behind.

**Left behind is information, not a failure.** `run finalize`, the stage replies and `summary.md` ("Test data") list each record that could not
be removed with its entity, identifier, test and the way to delete it (`canBeDeletedBy`). Tell the user plainly which records can be deleted;
the run is not failed or blocked for them. Never claim data was cleaned that the ledger does not show as `deleted` or `verified_gone`.

- Delete only records the run created and registered. If no cleanup path exists, say so in the generation report. Never delete data you
  didn't create, and never run bulk deletes.
- Non-sensitive fixture data (JSON/CSV) goes in `automation/test-data/`, created only when a test needs it. Never put credentials there.
- Run state (`dependencies/runs/`) and run output (`automation/reports/<runId>/`, `automation/test-results/<runId>/`) is removed
  only by the explicit `retention.keepRuns` policy.

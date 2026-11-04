---
name: playwright-framework
description: Shared Playwright Test framework conventions for this project — the automation/ folder layout, the language-specific shared fixtures and page objects, test titles and IDs, locator and assertion rules, lifecycle, and what generated code may and may not touch. Use when writing, reviewing or repairing Playwright tests.
user-invocable: false
---

# Playwright framework conventions

One framework for every agent. Do not create parallel configs, fixtures or helpers.

Paths are relative to **`automation/`** (the framework, with its own `package.json`). The engine, test-case input and run state
live in the sibling `dependencies/`; never put them in `automation/`. `<ext>` is `ts` or `js`: the language chosen at
`/builder:init` (`language` in `dependencies/state/scaffold.json` and in `run show <runId>`).
**Write only that language.** Never mix, never convert.

## Layout

`pages/`, `tests/`, `helpers/` are mandatory; `fixtures/`, `config/`, `test-data/`, `auth/`, `reports/`, `test-results/` exist
only with a clear responsibility. No other top-level folders in `automation/`.

| Path | Owner | Notes |
|---|---|---|
| `playwright.config.<ext>` | framework (user-editable) | standard `defineConfig`, literal values written from `config/automation.config.json` by `config save`/`config render`; a hand-edited file is never overwritten without `--force`. Don't edit it from generated tests or healing |
| `fixtures/test.<ext>` | framework | exports `test`, `expect`; auto `diagnostics` fixture attaches console/page/network errors on failure; auto `stepEvidence` fixture (only with the `evidence-pdf` reporter) logs every `test.step` and takes one final-state screenshot, masking password fields; the video comes from Playwright (`evidence.video` on) |
| `helpers/test-data.<ext>` | framework | `requireEnv(name)`, `requireWorkerEnv(name, parallelIndex)`, `uniqueSuffix(prefix, workerIndex?)`, `redact()`; generic helpers only, page behaviour belongs in `pages/` |
| `test-data/` | humans | non-sensitive data files only, never credentials |
| `pages/BasePage.<ext>` | framework | base class (`path`, `open()`, `byTestId()`) |
| `pages/<Name>Page.<ext>` | generator | page objects extending `BasePage`, named for the page, shared across modules |
| `tests/<module>.spec.<ext>` | generator + humans | every test, **one file per module**. A pipeline-written file starts with `// @builder:generated` and is the only kind it regenerates or heals; files without it are handwritten and never modified. Never overwrite a file lacking the header: choose another name |
| `auth/*.setup.<ext>` | generator | only for `auth.approach = storage-state`: `reuseOrSignIn` (`helpers/auth`) re-checks the saved session in every run and signs in again only when the application refuses it; saves `auth/storage-state.json` (git-ignored, never commit) |
| `reports/`, `test-results/` | generated | output per run (`<runId>/<label>/`); never write source here |
| `../dependencies/engine/` | plugin | never edit |

TypeScript projects type-check with `npm run typecheck` (needs `@playwright/test`); JavaScript ones are syntax-checked and
reviewed statically. Import specifiers carry the real extension (`.ts` / `.js`). TypeScript uses only erasable syntax (no enums,
namespaces or parameter properties).

## Modules: one test file per module

Specs belong to modules (`module`/`moduleSlug` in `test-specs.json`). **Every module has its own file and a file holds one module
only.** Get the plan from `node dependencies/engine/cli/pipeline.ts specs modules <runId>`: per module the file to write
(`tests/<moduleSlug>.spec.<ext>`, or `tests/<moduleSlug>.generated.spec.<ext>` when a handwritten test has that name), the spec IDs
to generate and the ones to hold back. Use exactly those names. Wrap the tests in one `test.describe('<module name>', …)`.

## Saved login, signed-out tests and dependent tests

- With `storage-state`, the `setup` project always runs first and every browser project depends on it, so no test starts before the login exists.
- A test that signs in or out, or otherwise changes the session, starts signed out (`test.use({ storageState: { cookies: [], origins: [] } })`) and carries
  the tag `@own-session`. These run in the `own-session` project, which Playwright runs after every project that shares the saved login (pass or fail),
  so signing in again cannot end a session another test is using. With several browsers they run in the first one.
- Cases that depend on each other (`dependsOn`; `specs modules` lists the `chains`) are written in dependency order inside one
  `test.describe.serial(…)`: they run in order on one worker, and when one fails the later ones are skipped (reported as blocked). A chain across modules has
  its own file, `chain-<id>.spec.<ext>`, treated as a module of its own.

Page objects are named for the page (`LoginPage`, `ProjectFormPage`), not the module; two modules using one page import the one
class, and a cross-module flow uses the other module's page object, never a copy of its locators. `generate validate` fails
when a file mixes modules or a module is split over files.

## Page objects

- Use one when the same page's locators/actions appear in **two or more** tests, or one page has three or more interactions;
  otherwise keep locators inline.
- One class per page/component in `pages/<Name>Page.<ext>`, extending `BasePage`: `readonly` locator properties built from
  `this.page` in the standard locator order, and methods for user *actions* (`signIn()`, `addToCart()`).
- **Assertions never go in page objects**; they stay in the test, mirroring the spec's expected results.
- Build locators only from exploration evidence. Navigate with a relative `path`, never an absolute URL.
- List every page object added or changed in the generation manifest's `sharedFilesChanged`; the reviewer applies the
  line-level safety rules to it. The healer does **not** auto-patch page objects (shared): report the defect for user approval.

## Test shape

TypeScript (`tests/login.spec.ts`; the first line is the ownership header):

```ts
import { test, expect } from '../fixtures/test.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { requireEnv } from '../helpers/test-data.ts';

test.describe('Login', () => {            // one describe per file: the module's name
  test('[TC-001] Valid user can sign in', { annotation: { type: 'testId', description: 'TC-001' }, tag: ['@smoke'] }, async ({ page }) => {
    const login = new LoginPage(page);
    await test.step('Open the login page', async () => {
      await login.open();                                // BasePage.open() → page.goto(path) relative to baseURL
    });
    await test.step('Enter credentials', async () => {
      await login.signIn(requireEnv('TEST_USER_EMAIL'), requireEnv('TEST_USER_PASSWORD'));
    });
    // Expected: The heading "Dashboard" is visible
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
```

JavaScript is identical minus the types, with `.js` specifiers; page objects declare `path = '/login'` as a class field and use
JSDoc (`/** @param {string} email */`).

Rules:
- Title **starts with `[<testId>] `** and the `testId` annotation is set; results, triage and healing rely on it.
- Import `test`/`expect` from `fixtures/test.<ext>`, never from `@playwright/test`.
- One `test.step` per spec step, in the spec's wording; the spec's expected result as a comment above each assertion.
- With the `evidence-pdf` reporter (check `run show <runId>`), wrap each expected result's assertions in
  `await test.step('Expected: <expected result, spec wording>', async () => { … })` so the PDF lists that check, with its result,
  among the executed steps. The assertion itself is unchanged; only the wrapper is added. Without that reporter keep
  the comment-above-assertion form. Use `test.step` from the shared fixture, and never take screenshots or record video by hand:
  the fixture takes the final-state screenshot and Playwright records the video.
- Spec tags → Playwright `tag` (`@smoke`); priority may go in an annotation.
- Locators in order: `getByRole` (with name) → `getByLabel` → `getByPlaceholder`/`getByText` → `getByTestId` → a scoped
  `locator()` as a last resort, with a comment saying why. Never XPath, structural CSS or CLI refs (`e12`).
- Web-first assertions (`toBeVisible`, `toHaveText`, `toHaveURL`). No `waitForTimeout`; no `isVisible()` inside an `if`.
- Assertions match the spec's expected results exactly (same quoted text, same URL fragments); add none for unstated behaviour.
- No `.only`, `test.skip`, `test.fixme`, `test.fail`, `@ts-ignore`, or `force: true` (unless evidence is noted in a comment).
- Each test is independent: no order dependence, no shared mutable state, a fresh context per test.
- Create data with `uniqueSuffix()` and register every record with the `cleanup` fixture (`async ({ page, cleanup }) => { … cleanup.register({ entity,
  identifier, undo }) }`, see the test-data-management skill): the fixture removes it after the test, also a failed one, and the pipeline can sweep it
  after the run. A test that calls `uniqueSuffix()` without `cleanup.register(...)` gets the static finding `register-created-data`. Never delete
  data the test didn't create.

## Execution settings

`use.baseURL`, `video`, `screenshot`, `trace`, `retries`, `workers`, `timeout` and browser projects come from
`config/automation.config.json` (plus `PW_*` env overrides). Don't hard-code them in tests; change them via the pipeline-setup skill.

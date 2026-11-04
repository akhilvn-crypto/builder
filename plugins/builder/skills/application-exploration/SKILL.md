---
name: application-exploration
description: CLI-first application exploration with the official Playwright CLI (named session, accessibility snapshots, targeted interaction), the approved aria-snapshot fallback, evidence capture and translating observations into durable locators recorded in exploration.json. Use when exploring the app or re-checking current UI during healing.
user-invocable: false
---

# Application exploration

Exploration is **observation**, not the test runner and not a source of requirements.

## Tool selection

Read `exploration.tool` from the run config and the `@playwright/cli` preflight check.

| Situation | Do |
|---|---|
| `playwright-cli` and the CLI is installed (project or global) | use the Playwright CLI (below) |
| CLI missing, install not approved, `@playwright/test` + a browser installed | fallback: `node dependencies/engine/tools/aria-snapshot.ts` (read-only page snapshots) |
| neither | stop; the stage is `blocked`. Do not install anything or try other tools |

## Playwright CLI

Run the CLI from the **`dependencies/`** folder, not from `automation/`: it writes session files (`.playwright-cli/`)
into the current directory, and `automation/` must stay framework-only. A project-local install lives in
`automation/node_modules`, so call it by path (`../automation/node_modules/.bin/playwright-cli …`); a global install is
just `playwright-cli …`. Evidence goes to `runs/<runId>/exploration/…` (relative to `dependencies/`); `exploration.json`
records those files relative to the run directory (`exploration/<page>.aria.yml`).

Check the installed version's syntax first: `playwright-cli --help` (or the same with the project-local path). Don't assume flags. Typical flow:

1. Open a named, isolated session at the base URL, e.g. `playwright-cli -s=explore-<runId> open <baseUrl>`. The session name **must contain
   the run id** (`explore-<runId>`; a healing re-check uses `heal-<runId>`): that is how `cleanup run` knows the browser belongs to this
   run. A session with any other name is never closed for you, and it stays alive until someone closes it.
2. `snapshot` → read the accessibility tree (roles, names, element refs like `e12`).
3. For each ready spec, perform its steps in order using refs (`click e12`, `fill e5 "text"`), taking a snapshot after
   each state change. Never type a literal secret. Credential values live in `automation/.env` (filled in by
   `specs parse`; `env check <runId>` already confirmed every needed name has a value), and your shell does not load that file.
   Run the step through the pipeline CLI instead, which loads `.env` for that one command and masks the values in its
   output, and keep `$VAR` inside single quotes so the child shell expands it, not yours:
   `node ../dependencies/engine/cli/pipeline.ts env run -- sh -c 'playwright-cli -s=explore-<runId> fill e5 "$TEST_PASSWORD"'`
   (adjust the path to the CLI to where you run it from). Never print or echo a value to check it. Do not `source` the file.
4. Save evidence that matters into `dependencies/runs/<runId>/exploration/` (`<page>.aria.yml`, `<page>.png`).
   Don't save pages showing secrets or personal data.
   If a step **creates a record** (a form submit, "Add", "Create"), register it as you go so it can be removed with the run's other test data:
   `node dependencies/engine/cli/pipeline.ts cleanup record <runId> --entity <kind> --identifier <the unique name or id> --hint "<where it is deleted in the UI>"`.
   When you see a delete or remove control for it, put that in `--hint` (and in `uncertainties` if you did not use it). Use only the controls you saw;
   never guess a URL or API endpoint, and never delete anything to "see what happens" (see *Not permitted* in the explorer's brief).
5. Close the session (`close` / `session-stop` per `--help`). Always close it, even after an error. Then run
   `node dependencies/engine/cli/pipeline.ts cleanup run <runId>`: it closes any session of this run that is still open and stops what is
   left of its browser (`ok: true` and an empty `stillRunning` means nothing of the run is running). The pipeline also runs it by itself when
   the exploration stage ends, fails or is blocked, on `resume`, and at finalization, so a session you forgot or an interrupted exploration
   is not left behind. Never use `close-all` / `kill-all`: they also end browsers that are not this run's.

**Refs are temporary.** Translate each control you rely on into a durable locator from what the snapshot shows:
`- button "Sign in" [ref=e12]` → `getByRole('button', { name: 'Sign in' })`;
`- textbox "Email"` → `getByLabel('Email')`; a `data-testid` → `getByTestId('…')`. Confidence: **high** = unique
role+name or test id; **medium** = text/label that could repeat; **low** = needs scoping or position.

## Fallback: aria snapshot

`node dependencies/engine/tools/aria-snapshot.ts --url <baseUrl><path> --out runs/<runId>/exploration/<page>` (`--out` is relative to `dependencies/`) writes
`<page>.aria.yml` + `<page>.png` for one page (navigation only, no interaction). Use it for each page the steps
reach directly by URL. Record `tool: "aria-snapshot-fallback"` and mark specs needing interaction as `partial`,
with the reason in `uncertainties`.

## Reuse of earlier observations

Saved observations (`dependencies/state/exploration-store/`, per base-URL origin) are **evidence to re-check, not truth**. Start with
`node dependencies/engine/cli/pipeline.ts explore plan <runId> [--fresh|--revalidate]` → per ready spec: `explore`, `revalidate`, `covered` or
`reuse`, each with a reason, plus `groups` (specs by module, with the pages they share) and `pagesToRevalidate`. `--fresh` forces full
exploration; `--revalidate` (or `--no-cache`) turns `covered` off so saved evidence is revalidated with a snapshot instead.

| Plan says | Do |
|---|---|
| `explore` | explore it as described above (new/changed test case, unknown/stale/ambiguous locator, no store, corrupt store), starting from its `knownPages` (below) |
| `revalidate` | the orchestrator has normally run `explore snapshot <runId>` already (below), so only the pages in `pagesToRevalidate` that are still listed are yours. For each: reach it (same login/navigation the spec needs), take **one** accessibility snapshot into `runs/<runId>/exploration/<name>.aria.yml`, then `explore revalidate <runId> --page <url-or-path> --file exploration/<name>.aria.yml`. (In Git Bash pass the full URL: a bare `/login` is rewritten to a Windows path.) |
| `covered` | nothing to do: the test case is unchanged, its saved evidence is consistent and verified, and its generated test is still current (same evidence, rules and reviewed source). This run's execution is the check; a locator that fails to resolve there makes the evidence stale, so the next run explores it |
| `reuse` | nothing to do |

**`explore snapshot <runId>` (no agent).** For every page in `pagesToRevalidate` it opens the page headless with `engine/tools/aria-snapshot.ts`
(navigation only; saved login state is used only when `auth-state.ts` has just accepted it), takes the one snapshot, and applies the same
role + name check. It commits a page only when the browser landed on the page asked for (a login redirect or another route is never compared) and
every locator the waiting specs rely on is found exactly once; a page that looked incomplete is snapshotted once more after a longer settle. It **never
invalidates**: a locator that is not on the page as loaded may only appear after a click, so the page is left as it was, still `revalidate`, and
listed in `pagesLeft` with the reason. Those pages are yours to reach and snapshot with the steps above; `explore revalidate` stays the only
command that marks locators stale. If the tool cannot run (`unavailable`, e.g. no `@playwright/test` installed) every page is left for you.

`explore revalidate` looks for each saved control's role + accessible name in your fresh snapshot: exactly one match = still valid; none
or several = marked **stale with a reason** and the specs that rely on it become `explore`; controls without a role+name (test-id only)
cannot be proven and are never reused. Explore the shared pages of a module once and let every spec in the group point at them.

**Known pages (specs you must explore).** A new or changed test case rarely touches only new pages. Your brief lists `knownPages`: saved pages
(key, url, verified locators) that the `explore` specs probably visit (their own earlier pages, their module's pages, shared ones like login),
and each spec's `knownPages` names its keys. They are a hint, not evidence. For a known page your steps really reach: take one snapshot of it,
run `explore revalidate <runId> --page <key> --file <snapshot>`, and read which locators came back `present`. Then, in `fresh.json`, point the
step at it with `"pageId": "saved:<key>"` (e.g. `saved:/login`) and list only `present` locators in its `locators`. Do **not** list that page or
re-describe its elements under `pages`: assemble carries the revalidated page over, with this run's snapshot. Observe fresh only what is genuinely new
(a page not in `knownPages`, a control the digest lacks, a missing/ambiguous locator) and list that the usual way. `assemble` refuses a `saved:`
page that is not in the store, was not revalidated in this run, or whose locator is not `present`. Don't spend steps re-observing a page whose
saved locators already cover what the step needs.
Never copy a saved locator into your own record by hand, and never reuse CLI element refs (`e12`) across sessions.

## Safety

- Only the configured base URL (an authorized test environment). Don't follow links to other domains.
- No destructive or irreversible actions without explicit user authorization relayed by the orchestrator. Log them in `avoidedActions`.
- Stop on login failure, a 5xx, or an unreachable host, and report it as an environment/precondition problem.

## Record

Write what you **observed in this run** to `exploration/fresh.json` (schema in `engine/pipeline/exploration.ts`): pages (url, title,
evidence paths, elements with `candidateLocator` + confidence), per-spec steps with the observation and the locators used, and
`uncertainties`. List only pages you visited and only the specs you explored (`pages: []`, `specs: []` is fine when everything was reused; with no explorer at all, `explore assemble` works without a fresh.json when every spec is `reuse` or `covered`). Every locator in a step must be listed in that page's `elements`. Then
`node dependencies/engine/cli/pipeline.ts explore assemble <runId>` merges your observations with the revalidated saved evidence into
`exploration/exploration.json` (reused pages carry `provenance` and this run's snapshot), validates it, refuses if a ready spec has neither fresh
nor revalidated evidence, and updates the store. Finally `explore validate <runId>`.

After execution, `triage run` marks saved observations stale when their locator failed to resolve, and records why. Use
`explore invalidate <runId> --page <p> --reason <text> [--locator <expr>]` when you learn evidence is out of date.

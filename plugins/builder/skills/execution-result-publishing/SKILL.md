---
name: execution-result-publishing
description: Publish Playwright execution results to Zephyr Scale Cloud (passes and confirmed application defects only, in plain human wording), create Jira bugs for confirmed application defects and link them to the Zephyr test case, keep everything else out of Zephyr but visible in an HTML report, with preflight checks, local state and safe retries. Use in /builder:update-execution-result.
user-invocable: false
disable-model-invocation: true
---

# Execution result publishing

Separate from test-case generation, from every pipeline command and from `/builder:publish-zephyr`: nothing here runs unless the user types `/builder:update-execution-result` (the model may not load this skill by itself; that command reads this file). `PY` / `SCRIPTS` as in `story-source-discovery`; `ER` = `PY SCRIPTS/zephyr-execution.py <subcommand> --root <project root>`. All scripts print JSON; the Zephyr token never reaches you, a file or a message.

## Division of labour

- **Pipeline engine** (`node dependencies/engine/cli/pipeline.ts`, `pl`): runs the tests, normalizes results, triages failures. This command never edits tests.
- **Jira connector (you call it):** auth check, project list, bug creation (`createJiraIssue`), issue lookup for the numeric ID (`getJiraIssue`), duplicate search (`searchJiraIssuesUsingJql`). No separate Jira credentials, ever.
- **`zephyr-execution.py` (deterministic):** talks to Zephyr Scale, maps tests to cases, decides statuses and bug eligibility from recorded facts, writes the local state, links bugs to cases, builds the report. Connection settings and the HTTP layer are the ones `zephyr-publish.py` uses (`ZEPHYR_BASE_URL`, `ZEPHYR_API_TOKEN` from the environment, else `<root>/.env`; Zephyr Scale **Cloud** REST API v2 only).

## Script calls

| Purpose | Call |
|---|---|
| Config, server, token, project, status names | `ER preflight --project KEY [--status-pass N --status-fail N]` |
| What a scope selects (no run) | `pl exec list [--test-file F]... [--test-id ID]... [--tag @t]...` (save the JSON to a file) |
| Test -> Zephyr case, check or fix | `ER map --project KEY --scope-file F [--set TC-1=PROJ-T101]` |
| Existing Test Cycles | `ER cycles --project KEY [--name TEXT] [--limit N]` |
| Start an update run | `ER begin --project KEY (--cycle PROJ-R12 \| --new-cycle NAME) --scope-file F --scope-text TEXT [--only-mapped] [--status-pass N --status-fail N]` |
| Read the pipeline run's results | `ER capture --pipeline-run RUNID` |
| Record a person's decision on a failure | `ER classify --test KEY --category C --confidence high\|medium\|low --rationale TEXT --by user` |
| Plain-words account of a failure and the bug title | `ER narrate --test KEY\|ID [--actual TEXT] [--summary TEXT]` |
| Executions + evidence to Zephyr | `ER publish` |
| Bug drafts / ones to check first | `ER bug-drafts` |
| Around the Jira create call | `ER bug-start --test ID` -> (connector) -> `ER bug-record --test ID --key PROJ-9 --issue-id 10009` (or `bug-failed --test ID --error TEXT`, `bug-reset`, `bug-decline --test ID --reason TEXT`) |
| Link bugs to cases | `ER link-bugs` |
| Unknown outcome of a create | `ER resolve (--cycle KEY \| --retry-cycle \| --test RESULTKEY (--execution-id ID \| --retry))` |
| Progress / completion report | `ER status`, `ER report [--write]` (`--write` also writes the HTML report) |
| Set an unfinished update aside | `ER abandon --reason TEXT` (archives it; deletes nothing remote) |

Errors arrive as `{"ok": false, "error": {"code", "message"}}`; relay the message and the fix in plain words. Common: `CONFIG_MISSING`, `AUTH` (token wrong/expired), `PROJECT_NOT_FOUND`, `STATUS_UNKNOWN` (a Zephyr status name does not exist: offer the listed ones), `MAPPING_INCOMPLETE`, `SCOPE_EMPTY`, `RUN_IN_PROGRESS`, `NOTHING_EXECUTED`, `CYCLE_NOT_READY`, `BUG_EXISTS`.

## Mapping: automated test -> Zephyr test case

The test title starts with `[<test case ID>]`; the case was published (by `/builder:publish-zephyr`) and the publish state `test-design/state/zephyr-publishing.json` records `caseId -> Zephyr key` per project. That is the only source, plus a hand mapping you set with `map --set` (verified to exist in Zephyr; kept in `automation/execution-results/test-mapping.json`). Titles are never matched. Missing (never published, other project only, unknown outcome), ambiguous (several cases, or a hand mapping that disagrees) and untagged tests are reported, never guessed, and are not published.

## What reaches Zephyr, and what is held back

Only a result that says something reliable about the application is written to Zephyr. The two status names are Zephyr's defaults and configurable per run (`--status-pass`, `--status-fail`); `preflight`/`begin` check they exist in the project. No other status is ever sent.

| Result | Class | Sent to Zephyr | Bug |
|---|---|---|---|
| passed | passed | yes, `Pass` | no |
| failed, defect **confirmed** (failure-healer with rationale, or the person) | application_defect | yes, `Fail` | yes |
| failed, looks like a defect but unconfirmed, or inconclusive | needs_investigation | **no** (held back) | no |
| failed: script / locator / test data / login | automation_issue | **no** | no |
| failed: environment, network, browser | infrastructure_issue | **no** | no |
| flaky (passed only on retry) | flaky | **no** | no |
| skipped (also blocked by a dependency) | skipped | **no** | no |

A held-back result has `execution.state = withheld` in `execution-run.json`, keeps its reason, error and evidence, counts as `publishing.withheld` in the report, is **not** an open operation (the update can finish cleanly), and is listed in the HTML report. `classify` moves a failure between held back and sent (e.g. a person confirms a `needs_investigation` as a defect: it becomes `Fail` with a bug draft) until it has been published.

### Wording of what is sent

The execution comment reads like a tester's note, not a data dump. Pass: *Ran this check in Chromium on Windows 10 against staging (url) on 8 Nov 2026. Everything behaved as the test case describes.* Fail: **Actual result** (the account written with `narrate`, else the Playwright error rephrased in plain words by `plain_error`), **Expected** (from the test specification) and where it was seen. No test or run IDs, no stack traces, no tool names. `narrate` is how the command records what a person would have seen, in its own words from the evidence; it refuses text that looks like a pasted tool error (`expect(`, `Locator`, `Call log`, stack lines, ANSI) and is locked once the result is in Zephyr (the title, once its bug exists). Build/version is never recorded by the pipeline; the Jira text leaves it out and the command tells the person.

## Bugs

Only a **confirmed** application defect (class `application_defect`) gets a bug, one per test case (a failure in several browsers is one defect). `bug-drafts` builds it the way a tester files one: a short symptom title (`narrate --summary`), a line on where it was found, **Steps to reproduce** (preconditions, then the specification's steps), **Expected result**, **Actual result** (the account written with `narrate`), **Environment**, **Evidence** (paths) and **Related** (Zephyr case and Test Cycle). No run IDs, tool names, classification or marker text in the body. Anything not recorded is never invented: missing steps become "See test case KEY in Zephyr.", other missing parts are simply left out, and the draft's `notAvailable` list tells the command what to report to the person. A draft with `needsWriting` has no hand-written title/account yet: write them with `narrate` first. Priority is the test case's own priority when it has one; otherwise left to the project default and triage.

Use the project's configured Bug issue type, its required fields and template (look them up with the connector; ask the user for required values you cannot derive from recorded facts). Evidence files are listed in the description with their paths; attach them only if the connector offers an attachment operation (check with `discover`), otherwise say they must be attached by hand.

Each draft carries a unique **marker label** (`ab-er-...-<test id>`), the only label (nothing marks the bug as automated; the marker is what makes the duplicate check possible). Duplicate protection: `bug-start` records the attempt *before* the connector call; if the outcome is unknown, `bug-drafts` lists it under `needsCheck` and you search Jira (`labels = "<marker>"`) before creating anything. `previousBugs` lists bugs earlier updates created for the same test: check whether one is still open and ask the user whether to reuse it instead of filing another.

Linking uses the Zephyr test-case issue-link endpoint (`POST /testcases/{key}/links/issues` with the numeric issue ID), skipped when the link already exists. If linking fails the bug is kept and only the link is retried.

## Safety rules the script enforces

- Local state in `automation/execution-results/`: `execution-run.json` (the current update: per result the Zephyr status, execution state/ID, evidence, bug and link), `execution-history.jsonl` (append-only events: IDs, keys, codes; no tokens, no response bodies), `archive/<id>.json` (finished or abandoned updates, never overwritten), `reports/<id>.md` and `reports/<id>.html` (every result, including the held-back ones with reason, plain-words account, full error with the token redacted and escaped, evidence links, and a link to the Playwright HTML report).
- **Independent recovery:** capture, publish (per result), evidence (per file), bug creation, linking are separate states. Re-running `publish` sends only what is not in Zephyr; tests are never run again because publishing failed.
- **No duplicates:** a result is recorded as *started* before the POST; a lost reply (timeout / 5xx) makes it `blocked` and it is never re-sent until the user checks the Test Cycle in Zephyr and runs `resolve`. The same holds for creating a Test Cycle. Each update has its own cycle association; existing executions are never changed or deleted (only new ones are added).
- Evidence upload (`POST /testexecutions/{id}/attachments`, files up to 10 MB) is best effort: a deployment that does not accept it is detected once, reported as `unsupported`, and never fails a result.
- 429 answers are waited out; after an auth, rate-limit or network failure the rest is left `pending` instead of hammering the server.
- A failed result's classification is final once published. Nothing remote is ever deleted or overwritten.

## Mobile surface (`/builder:mobile-update-execution-result`)

The same script and rules, selected with `--surface mobile` on **every** call (`ER` then means `zephyr-execution.py <subcommand> --surface mobile --root <root>`). What changes:

- **State** lives in `mobile-automation/execution-results/` (same files, same recovery); `begin` needs `mobile-automation/`.
- **Scope**: `node mobile-automation/tools/maestro-cli.mjs scope ...` writes the same `{"tests":[{"testId"}]}` file `map` and `begin` read. A flow's test case is the `# testCase:` header; a flow without one is `untagged:<flow>` and is never published. Two flows for one test case in a run are refused (`DUPLICATE_TEST_ID`).
- **Capture**: `capture --run-id <mobile run> [--allow-emulator]` reads `mobile-automation/reports/<runId>/run.json` + `results.json` (a run still `running`, or one that executed no flow, is refused). Result key `TC-1@android`. Test case steps/expected/priority come from `mobile-automation/state/test-specs.json`.
- **Categories** (from the run, all start as heuristics): `application` -> candidate application defect, held back as *needs investigation* until the healer agent (Phase A) or the person confirms it with `classify`; `automation` -> script issue; `device` and `environment` -> infrastructure issue; `unclassified` -> needs investigation; `skipped` and `not_run` -> skipped with the run's own reason. There is no flaky class (no retries). A confirmation made with `classify` survives capturing the same run again.
- **Physical device only**: a run on an emulator/simulator is held back whole (`not_physical_device`) unless `capture --allow-emulator` (a decision only the user makes; notes and bugs then say "emulator/simulator").
- **Wording**: the execution note reads "Ran this check in the app (2.3.1 (build 45)) on Google Pixel 7 running Android 14 against staging on 9 Nov 2026."; the bug has Device / OS / App / Environment and a build, so `build/version` is not listed as missing when the run recorded the app version. Without a hand-written account, `plain_error_mobile` rephrases the failed step ("Expected \"Total: 5\" to be shown on the screen, but it was not.") from the run record and says nothing it does not know; Maestro words are refused in `narrate`.
- **Evidence**: up to 3 screenshots (failure screen first) and, for failures only, one screen recording per result; logs, Maestro debug files and the hierarchy stay on disk. Paths in bugs are shown as `mobile-automation/artifacts/<runId>/...`.
- Unverified: real Maestro log wording (`plain_error_mobile` patterns are loose and fall back to the run's plain-language reason for application failures, otherwise to nothing) and attachment acceptance by a real Zephyr deployment.

## Verified against

Jira connector operations used: `getAccessibleAtlassianResources`, `listJiraProjects`, `getJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue` (markdown description, labels, priority, additional fields). Zephyr Scale Cloud v2 endpoints used: `GET /healthcheck`, `GET /projects[/{key}]`, `GET /statuses`, `GET|POST /testcycles`, `GET /testcycles/{key}`, `POST /testexecutions`, `POST /testexecutions/{id}/attachments`, `GET /testcases/{key}`, `GET|POST /testcases/{key}/links[/issues]`. Their shapes come from SmartBear's public API description as relayed by secondary sources; the unit tests run against a local mock, and **no real tenant was available when this was written**. The first run against a real tenant is the real confirmation: pay particular attention to the status names, the attachment endpoint (treated as optional) and whether adding an execution to a cycle that already holds one for the same case behaves as expected.

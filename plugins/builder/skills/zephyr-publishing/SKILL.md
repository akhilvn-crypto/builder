---
name: zephyr-publishing
description: Publish one saved test-case Markdown file to Zephyr Scale Cloud and link each created case to a Jira story, with preflight checks, field mapping, local publishing state and safe retries. Use in /builder:publish-zephyr.
user-invocable: false
disable-model-invocation: true
---

# Zephyr Scale publishing

Separate from test-case generation and from every pipeline: nothing here runs unless the user types `/builder:publish-zephyr <file>` (the model may not load this skill by itself; that command reads this file). No workflow, agent or command calls it. One file per invocation. `PY` / `SCRIPTS` as in `story-source-discovery`. All scripts print JSON.

## Division of labour

- **Jira connector (you call it):** auth check, project list, story lookup, numeric issue ID. No separate Jira credentials, ever.
- **`test-design/scripts/zephyr-publish.py` (deterministic):** reads Zephyr settings, talks to Zephyr Scale, converts, keeps state. The token never reaches you, a file or a message.

## Configuration

`ZEPHYR_BASE_URL` and `ZEPHYR_API_TOKEN` come from the process environment, else from `<root>/.env`. Default Cloud base URL: `https://api.zephyrscale.smartbear.com/v2` (regional variants such as `https://eu.api.zephyrscale.smartbear.com/v2` are accepted as configured). The token is sent as `Authorization: Bearer`. Only **Zephyr Scale Cloud REST API v2** is supported; a Data Center / Server URL (`/rest/atm/...`) is refused with an explanation and nothing is sent. Plain `http://` is accepted only for localhost.

## Script calls

| Purpose | Call |
|---|---|
| Settings present? | `zephyr-publish.py check-config --root R` |
| Server, token, project | `zephyr-publish.py check-zephyr --root R --project KEY` |
| File usable? | `zephyr-publish.py check-file FILE` |
| What would be sent (offline) | `zephyr-publish.py convert FILE` |
| Publish / retry | `zephyr-publish.py publish --root R --file FILE --project KEY --story-key K --story-issue-id N [--accept-unmapped FIELD]` (add `--dry-run` for a no-network, no-write preview) |
| Recorded progress | `zephyr-publish.py status --root R [--file FILE]` |
| Settle an unknown create | `zephyr-publish.py resolve --root R --file FILE --case ID (--key PROJ-T123 \| --retry)` |

Error codes arrive as `{"ok": false, "error": {"code", "message"}}`; relay the message and fix steps in plain words. Common ones: `CONFIG_MISSING`, `BASE_URL_INSECURE`, `DEPLOYMENT_UNSUPPORTED`, `AUTH` (token wrong/expired), `PROJECT_NOT_FOUND` (Zephyr Scale not enabled for that Jira project, or the token's user cannot open it), `FILE_MISSING`, `FILE_INVALID` (run `validate-test-cases.py` on the file, or re-run `/builder:generate-test-cases`), `STORY_PROJECT_MISMATCH`, `STATE_CORRUPT`.

## Mapping (Markdown -> Zephyr Scale Cloud v2)

| Markdown | Zephyr field |
|---|---|
| `## ID: Title` title | `name` (max 255 characters; longer is a per-case failure, never truncated) |
| (format has no description) | `objective` = `Source test case <ID> (<file name>)`, so a case can be traced back |
| Preconditions | `precondition` (bullet list) |
| Tags | `labels` (spaces become `_`, reported in `notes`) |
| Steps (numbered, in order) | `teststeps` items, `inline.description` |
| Test Data | step `inline.testData`: the variables that step uses as `name: value`. Data no step uses goes on step 1. `env:NAME` stays a reference; values are never resolved |
| Inline `-> Expected:` | that step's `inline.expectedResult` |
| Expected Results (overall) | appended to the **last** step's expected result (Zephyr keeps expected results per step), reported in `notes` |

Not sent, always reported in `unmapped`: `Priority` (Zephyr priority names are per-project), the module name (Zephyr uses folders), and `Depends on`. `Depends on` has `decisionRequired: true`: the case is `blocked` until the user agrees to publish without it (`--accept-unmapped "Depends on"`). Do not decide that for them.

## Safety rules the script enforces

- Local record `test-design/state/zephyr-publishing.json`: key `<file>::<case ID>` -> Zephyr key, project, story, stages `created` / `steps` / `linked`. Written after every stage. Append-only log `zephyr-publishing-audit.jsonl` (IDs, keys, error codes; no tokens, no bodies).
- **No duplicates:** a recorded case is reused. The record is written *before* the create request; if the reply is lost (timeout / 5xx) the case is `blocked` and never re-created until the user checks Zephyr and runs `resolve`.
- **Create succeeded, later stage failed:** the key is kept; a retry only repeats the missing stage. Steps are added with `APPEND` and only when the case has none (a different count is `STEPS_MISMATCH`, left untouched); the link is skipped when Zephyr already shows it.
- Never overwrites, edits, deletes or re-links a remote case. A case already linked to another story, or published to another project, fails with an explanation. If the Markdown changed after publishing, `contentChangedSincePublish` is reported and the remote case is left as is.
- 429 answers are waited out (`Retry-After`) and retried; after an auth or network failure the rest of the file is reported `pending` instead of hammering the server.
- The source Markdown is only read.

## Verified against

Jira connector operations (verified live in this environment): `getAccessibleAtlassianResources`, `listJiraProjects`, `getJiraIssue` (returns numeric `id`, `issuetype`, `project.key`). Zephyr Scale Cloud v2 endpoints used: `GET /healthcheck`, `GET /projects`, `GET /projects/{key}`, `POST /testcases`, `GET|POST /testcases/{key}/teststeps`, `GET /testcases/{key}/links`, `POST /testcases/{key}/links/issues` (`{"issueId": <number>}`). These come from SmartBear's public API description as relayed by secondary sources; the unit tests run against a local mock of them, so the first run against a real tenant is the real confirmation.

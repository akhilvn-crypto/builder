---
description: Publish ONE saved test-case file to Zephyr Scale and link every created Zephyr test case to a Jira user story. A separate, manually invoked QA action - no pipeline or workflow ever runs it. Runs Jira and Zephyr preflight checks first and never duplicates, overwrites or deletes remote cases.
argument-hint: "<test-case-file>   e.g. test-design/test-cases/US-001-testcase.md"
disable-model-invocation: true
---

# /builder:publish-zephyr

Arguments: `$ARGUMENTS`

**Manual invocation only.** This is the publish command: a QA action the user starts by typing it. `/builder:design-test-n-automation`,
`/builder:generate-test-cases`, every other command, the orchestrator and every agent never run it, never offer to run it on
their own, and never pass it a file. If you reached this command from any other workflow rather than from the user typing it, stop and
say so.

Publishes exactly the one file named in the arguments. There is no bulk mode: if the argument is a folder, several files or empty, ask
for a single file path and stop.

1. Read the `zephyr-publishing` skill file (`${CLAUDE_PLUGIN_ROOT}/skills/zephyr-publishing/SKILL.md`; it cannot be loaded any other way). It holds the exact script calls, the
   field mapping and the error wording. `PY` is the first of `python`, `python3`, `py -3` that runs; `SCRIPTS` is
   `${CLAUDE_PLUGIN_ROOT}/test-design/scripts` (if the variable is not expanded, locate the plugin as
   [environment.md](../skills/playwright-pipeline/environment.md) describes).
2. Project root: the nearest ancestor of the file that contains `test-design/` (otherwise the working directory). State and audit files
   are written only under `<root>/test-design/state/`.
3. Work through the stages below **in order**. At the first failed check stop, say in plain words what is wrong and the concrete steps
   to fix it, and do not run later stages. Never print the Zephyr token.

## Stage A - Preflight (before anything is converted or published)

1. **Jira connector.** Confirm the Atlassian/Jira connector is available and authenticated (for example by listing accessible Atlassian
   resources and taking the `cloudId`). If it is not, stop: tell the user to connect/authenticate the Atlassian connector. Do not ask for
   Jira credentials or build any other Jira login.
2. **Projects.** List the Jira projects the connected user can access (connector operation `listJiraProjects`; use `discover` to find the
   exact operation name if needed, and page until done). Show key and name.
3. **Confirm the project.** Ask the user, with a question dialog, which project is the intended one; what they pick is the "confirmed Jira
   project". Never choose for them, even if only one exists: show it and ask for confirmation.
4. **Zephyr configuration.** `PY SCRIPTS/zephyr-publish.py check-config --root <root>`. Reports only whether `ZEPHYR_BASE_URL` /
   `ZEPHYR_API_TOKEN` are set and where they came from. Pass on any `warnings` (for example `.env` not git-ignored).
5. **Zephyr connectivity, token and project.** `PY SCRIPTS/zephyr-publish.py check-zephyr --root <root> --project <KEY>`. This proves the
   server is reachable, the token is accepted and the confirmed project is open in Zephyr Scale.
6. **The file.** `PY SCRIPTS/zephyr-publish.py check-file <file>`. It must exist, be readable, contain test cases and follow the canonical
   format. Show the case count and the story ID(s) found in the file.

## Stage B - Story mapping

1. Ask the user for the Jira user story key (for example `PROJ-101`). Mention that the file's own story ID (from step A6) is only a local
   label, not necessarily the Jira key.
2. Look it up with the Jira connector (`getJiraIssue`). If it does not exist or is not visible, stop with that explanation.
3. Check that `fields.project.key` equals the confirmed project. If not, stop and say which project the issue is in.
4. Check the issue type. `Story` passes. `Epic`, `Sub-task` and `Bug` do not: stop and explain. Any other type (for example `Task`): show
   it and ask the user to confirm it is the intended user story before continuing.
5. Take the numeric `id` of the issue (not the key). Show a one-line confirmation: key, summary, type, project, issue ID, and "Publish N
   test cases from `<file>`".

If any check fails stop here. **Nothing has been created in Zephyr yet.**

## Stage C - Convert and publish

1. Preview the conversion without network access: `PY SCRIPTS/zephyr-publish.py convert <file>`. Tell the user about every `unmapped`
   item. Items with `decisionRequired: true` (currently `Depends on`) change how a test must be run: ask the user whether to publish
   without them, and only if they agree add `--accept-unmapped "<Field>"` below. Informational items (`Priority`, `Module`) are only reported.
2. Publish: `PY SCRIPTS/zephyr-publish.py publish --root <root> --file <file> --project <KEY> --story-key <PROJ-101> --story-issue-id
   <id> [--accept-unmapped "<Field>"]`. Per case it creates (once), adds the steps (once), and links to the story (once), saving progress
   after every step. Exit code 1 means some cases are not fully published; read `cases` and `recovery`.
3. Never edit the Markdown file. Never delete, overwrite or re-link a remote case yourself. If a case's status is `blocked` because an
   earlier create had an unknown outcome, explain it and let the user check Zephyr; only after they tell you what they found run
   `zephyr-publish.py resolve --root <root> --file <file> --case <ID> --key <ZEPHYR-KEY>` (it exists) or `--retry` (it does not).
4. If some cases are `created_not_linked`, `failed` or `pending`, offer to run the same `publish` command again: it only retries the
   missing parts.

## Completion summary

Show: the source file, the confirmed Jira project, the story key, the number of cases processed, a table of case ID / title / Zephyr key /
created-or-reused / steps / link status, anything reported as unmapped or changed since publishing (`contentChangedSincePublish`: the
remote case was not updated), every failure with its recovery step, and where the state is kept
(`test-design/state/zephyr-publishing.json` and `zephyr-publishing-audit.jsonl`).

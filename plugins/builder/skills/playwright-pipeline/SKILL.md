---
name: playwright-pipeline
description: Run the full agentic Playwright pipeline — preflight, setup, test analysis, exploration, generation, review, execution, triage, bounded healing, and reporting — with on-disk run state.
argument-hint: "[test-case path] | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:playwright-pipeline — orchestrator

> **Project setup:** if `dependencies/engine/cli/pipeline.ts` does not exist, stop and tell the user to run
> `/builder:init` first (it scaffolds the framework; it installs nothing), or use `/builder:do-automation`,
> which scaffolds and then runs this whole pipeline.
>
> **Claude Code and Claude Cowork:** read [environment.md](environment.md) first. It says how to ask the user (dialog, or a numbered
> chat question when the dialog does not appear), where the plugin and project files are, and what differs in Cowork.

You (the main session) are the **pipeline orchestrator**. Orchestration runs in the main session, not in a
subagent, because it must ask the user setup/approval questions and delegate to stage subagents (subagents cannot
spawn subagents). This skill plays the `pipeline-orchestrator` role.

## Responsibilities and limits

- Own stage transitions; advance only after the CLI accepts a stage's outputs.
- Never invent test steps, expected results, base URLs or credentials.
- Credentials, emails and usernames that appear in the test cases are moved into `automation/.env` for you by
  `specs parse`; don't ask the user for them. Only when a value is missing, point the user to `automation/.env`
  (names, never values) and wait. Never ask for or echo a secret in chat.
- Never modify tests to force a pass. Never treat partial artifacts as valid.
- Pipeline state lives on disk. Use the CLI for every state change; never edit manifests or config by hand.
- Ask the user only for what is missing (pipeline-setup skill), one approval per dependency.
- Use agents only where `pl agents plan <runId> <stage>` says judgment is needed, and give each agent just its bounded brief. Run parsing,
  hashing, test execution, validation and report assembly yourself through the CLI. Reuse earlier work only through the CLI's cache
  decisions (`specs parse`, `generate plan`, `review plan`; `ledger plan` previews them all per test case); never decide yourself that an old artifact or an old test result is still good.

## Start or resume

- `$ARGUMENTS` starts with `resume` → continue a stopped run from its on-disk checkpoint:
  - `resume <run-id>` → `node dependencies/engine/cli/pipeline.ts run resume <run-id>`.
  - bare `resume` (no id) → `node dependencies/engine/cli/pipeline.ts run resume --command playwright-pipeline`, which picks the
    newest run that is `in_progress`, `blocked` or `failed` (never `completed`/`cancelled`).
  If `ok: false`, show the issues and stop (do not "fix" the manifest; with no resumable run, offer to start a new one).
  Otherwise show the `checkpoint` in 2–3 lines before doing anything: run id, stages already completed, the stage
  it resumes at and why it stopped (`reason`), and mention any `recovered` (interrupted) stages, which are re-run
  from scratch. If `others` is non-empty, say how many other resumable runs exist and that `resume <run-id>` picks
  a specific one (`run resumable` lists them). Then continue from `next`; completed stages are never repeated.
- Otherwise → a new run. **Ask where the test cases are before creating it**:
  0. **Test cases from test design.** If `$ARGUMENTS` holds no path and `node dependencies/engine/cli/pipeline.ts design status` shows
     saved stories (the user ran the design stages), offer them first, as a choice: *Use the N test cases from test design (Recommended)*
     / *Use other test cases*. On the first: check they are current and hand them over exactly as step 0 of
     [../generate-tests/SKILL.md](../generate-tests/SKILL.md) describes (`design handoff`, readiness, manual cases listed), use
     `input/test-cases/design` as the test-case path, skip steps 1-2 below, and create the run in step 3 with `--design`. With no design
     output this step does not exist; the flow below is unchanged.
  1. **Where are they?** If `$ARGUMENTS` holds a path, that is the answer. Otherwise ask. First look at
     `dependencies/input/test-cases/`: if it already holds supported files (`.md`, `.csv`, `.xlsx`), ask as a choice (dialog or numbered chat question, see environment.md)
     (*Use the N files already in `input/test-cases` (Recommended)* / *Import test cases from another path*; the user types the
     path via Other). If it is empty, ask in plain chat: "Where are your test cases? Give the path to a file (`.xlsx`, `.csv`
     or `.md`) or to a folder of them. Any location and any column layout is fine." Don't guess a path and don't search the
     disk for one.
  2. **Check how they will be grouped, then convert and save them.** The import fixes the modules (one test file each), so look
     first: `node dependencies/engine/cli/pipeline.ts input inspect --path "<path>"` (read-only; headers and counts, no values).
     If a table's section headings and its `titlePrefixes` disagree (headings such as "Functional testing" while the titles name
     the feature: "Home page - …"), ask which grouping they want and save it with `input map --module-from` (test-case-parser
     skill) before importing; don't pick silently. Then:
     `node dependencies/engine/cli/pipeline.ts input import --from "<path>"`. It reads the
     original (never changed), converts it to the pipeline's Markdown, one file per module, in `dependencies/input/test-cases/`,
     and moves any credentials, usernames and emails it finds into `automation/.env` (names only in the output). Skip this
     only when the user chose files already in `dependencies/input/` (a path inside it, or the existing files): the pipeline
     reads those as they are, so use that path as the test-case path and carry on.
     - Exit 0 → tell the user in 2–3 lines: how many cases and modules, the files written, and the `.env` names added
       (`env.created`). Mention `needsClarification` (cases that lack steps or expected results) and `renamedIds`
       (duplicate IDs in the source, renamed `-dupN`) so they can fix the source and re-import with `--overwrite`. If
       `othersInFolder` is not empty, say so: those files were already in `input/test-cases/` and the pipeline will read them
       too (e.g. modules from an earlier grouping); ask whether to keep them, and never delete them yourself.
     - Exit 2, files in `conflict` → files with those names already exist and differ. Ask whether to replace them
       (`--overwrite`) or import from somewhere else; never overwrite unasked.
     - Exit 2, unreadable layout → not the user's mistake: `input inspect --path "<path>"`, ask which header is which field,
       `input map`, then import again (test-case-parser skill). Other errors (missing path, `.xls`, protected workbook): show the
       message and ask for another path or file.
  3. `node dependencies/engine/cli/pipeline.ts run create --command playwright-pipeline --input input/test-cases` (`--input input/test-cases/design --design` for test cases from test design), note the
     `runId`, and use `input/test-cases` as the test-case path for this run (`--path` to `input validate`, `specs parse` and the
     test-analyst, and `input.testCasesPath` in the configuration stage: don't ask for it again).

## Run the stages

Follow [stages.md](stages.md) for all 13 stages in order. It defines each stage's inputs, the agent to delegate to,
the artifacts to register, and the failure behaviour.

## Finish

Print the final summary described at the end of stages.md, plus the run directory `dependencies/runs/<runId>/` (summary.md inside) and the report folder `automation/reports/<runId>/`.
If the run stopped early, give the exact resume command: `/builder:playwright-pipeline resume <runId>`.

---
description: Guided end-to-end automation. Asks the language, scaffolds the framework, then runs every pipeline stage in order, stopping only where you must decide or approve something.
argument-hint: "[test-case path] [--language typescript|javascript] [--with-demo] | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:do-automation

One command from an empty project to executed tests and reports: language choice, framework scaffolding, then all 13 pipeline
stages. It does what `/builder:init` and `/builder:playwright-pipeline` do, in one flow, so the user does not
have to chain them. The other commands (`generate-tests`, `run-tests`, `heal-tests`, `playwright-pipeline resume`) keep working on
the same project and the same runs.

Arguments: `$ARGUMENTS`

You (the main session) are the **pipeline orchestrator**; this cannot run in a subagent because it asks questions and delegates to
stage subagents.

## Read first

Read these three files from the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) before doing anything else, and follow them throughout:

1. `skills/playwright-pipeline/environment.md`: how to ask the user in Claude Code **and Claude Cowork** (dialog, or a numbered
   chat question when the dialog is unavailable), where files live, Cowork specifics.
2. `skills/playwright-pipeline/SKILL.md`: the orchestrator's responsibilities, "Start or resume", "Finish".
3. `skills/playwright-pipeline/stages.md`: the 13 stages, their artifacts, agents and failure behaviour.

Load `skills/init/SKILL.md` for phase 1 and `skills/pipeline-setup/SKILL.md` when you reach `preflight`/`configuration`.

## What "automatic" means

Tell the user this in four lines before starting: the phases (1 language and scaffold, 2 setup, 3 the 13 stages), that you will
carry on from stage to stage without asking "shall I continue?", and that you will stop only for (a) a choice that is theirs,
(b) a dependency install, which is approved **one dependency at a time** (that rule is not waived by this command), (c) a destructive
step or missing `automation/.env` value, (d) a blocker. Then do not narrate options; ask what is missing and move on.

Never invent base URLs, credentials, test steps or expected results. Never edit tests to force a pass. All state changes go through
`node dependencies/engine/cli/pipeline.ts`.

## Phase 0: resume

If `$ARGUMENTS` starts with `resume`, the project is already scaffolded: skip phase 1 (if
`dependencies/engine/cli/pipeline.ts` is missing, say so and continue as a new run instead) and follow the resume branch of
`playwright-pipeline/SKILL.md` ("Start or resume": `run resume <id>`, or bare `run resume --command playwright-pipeline`),
including the checkpoint summary. Runs started here are ordinary `playwright-pipeline` runs, so
`/builder:playwright-pipeline resume <run-id>` resumes them too.

## Phase 1: language and framework

0. **Project root.** Resolve `<root>` (the user's attached folder) as environment.md "Where things are" says, and `cd "<root>"` before
   every command. In Cowork the shell starts in a scratch folder, so nothing may be written until `<root>` is known; pass
   `--root "<root>"` to init.
1. Look for `<root>/dependencies/state/scaffold.json` (older projects: `automation/config/scaffold.json`).
   - **Present** → the language is fixed: read `language`, never ask, never pass `--language`. If its `pluginVersion` differs from the
     installed plugin's version (`.claude-plugin/plugin.json` in the plugin root), or the project still has the old single-folder
     layout (`automation/engine/` exists), run the init dry-run with `--update`, show it, and ask whether to update the engine now
     (*Update to the plugin's version (Recommended)* / *Keep the current files*); update only on a yes, following
     `skills/init/SKILL.md` steps 2–3. Same version → say nothing and go to phase 2.
   - **Absent** → ask the language, **never default it**: `--language typescript|javascript` in `$ARGUMENTS` is the answer;
     otherwise ask *"Which language should the Playwright framework and generated tests use?"* with **TypeScript (Recommended)**
     and **JavaScript**, and say the choice is fixed for the project.
2. Scaffold by following `skills/init/SKILL.md` steps 2–4 (dry run, summary, run for real). Pass init only `--language`, and
   `--with-demo` / `--with-pipeline-tests` if they appear in `$ARGUMENTS`; never the test-case path or `resume`. On a fresh project the
   dry run overwrites nothing, so go straight on; if it lists overwritten, removed or moved files or a `package.json` warning, show
   them and ask for confirmation first, as init does. Install nothing here.
3. Verify `dependencies/engine/cli/pipeline.ts` exists. Report in 2–3 lines what was created and the chosen language.

`[1/3] language and framework … done — <language>, automation/ + dependencies/`

## Phase 2 and 3: setup and the 13 stages

Follow `playwright-pipeline/SKILL.md` from "Start or resume" (new-run branch) to "Finish", using `stages.md` for every stage:

- The test-case path is the first question after scaffolding: the path in `$ARGUMENTS` (the first argument that is not a flag), else
  the flow in `SKILL.md` (existing files in `dependencies/input/test-cases/`, else ask in chat). Import and group them as it says,
  then `run create --command playwright-pipeline --input input/test-cases`.
- `preflight` and `configuration` follow `pipeline-setup`: ask only for what is missing in one grouped call (reports, evidence,
  browsers, base URL and environment, auth, cleanup), save the config right away, then offer each missing dependency for approval
  on its own. The language is **not** asked again.
- After that, run the stages back to back: `input_validation`, `test_analysis`, `application_exploration`, `test_generation`,
  `script_review`, `execution`, `failure_triage`, `healing`, `regression_validation`, `report_generation`, `finalization`.
  Delegate to agents only where `agents plan` names one; execution, regression and report building are yours, through the CLI.
- Print `[n/13] <stage> … <status> — <note>` after each stage.
- A `blocked` or `failed` stage stops the flow: say why, what the user must do, and the exact resume command
  `/builder:do-automation resume <runId>`. Do not skip a stage or hand-edit anything to get past it.

## Finish

Give the final summary defined at the end of `stages.md` (counts, failure categories, healing, unresolved tests, report and evidence
paths, what was reused, test data left behind, whether anything was left running), and the run directory
`dependencies/runs/<runId>/`. Never call a run successful unless its status is `completed`, and never present a flaky pass as a
pass. Close with the next steps: `/builder:run-tests` to re-run, `/builder:heal-tests <runId>` for eligible
script defects, `/builder:generate-tests` after adding test cases.

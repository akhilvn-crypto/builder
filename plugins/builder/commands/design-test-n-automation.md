---
description: Detailed user stories to executed Playwright tests in one flow - story discovery, story analysis, test design, test-case generation, automation readiness, script generation, execution and reporting. The generated test cases are handed forward automatically; you never supply them. Stops only where a decision is yours. Never publishes.
argument-hint: "[stories folder | story file] [--story US-001,US-002] [--concurrency 1-5] [--language typescript|javascript] | resume [<run-id>]"
disable-model-invocation: true
---

# /builder:design-test-n-automation

From the detailed stories in `stories/` to executed, reported Playwright tests:

**Story Discovery → Story Analysis → Test Design → Test Case Generation → Automation Readiness → Playwright Script Generation → Test Execution → Reporting**

and one traceable chain for every test: **Story → Acceptance Criterion → Test Scenario → Test Case → Automation Script → Execution Result**.

The test cases the design stages write (`test-design/test-cases/<story>-testcase.md`) are found and used by the automation stages by
themselves. Do **not** ask the user for a test-case path, a file or a format in this command. The design half can also be run alone
(`/builder:generate-test-cases`), and the automation half on test cases you already have (`/builder:do-automation`, or the single
steps `generate-tests`, `run-tests`, `heal-tests`); they use the same agents, scripts and checks as this command, and they read what
the earlier stages left, after checking it is current.

Arguments: `$ARGUMENTS`

You (the main session) are the **orchestrator** of both halves; this cannot run in a subagent because it asks questions and delegates to
subagents.

## Publishing is not part of this command

`/builder:publish-zephyr` is a separate QA action that only the user starts by typing it. Nothing in this command, in the
test-design orchestrator or in any agent runs it, prepares it, or offers to run it. Do not use the Atlassian/Jira connector here, and do
not mention publishing in your messages; the user knows the command and starts it when they decide to.

## Read first

Read these from the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as
[environment.md](../skills/playwright-pipeline/environment.md) describes) before doing anything else, and follow them throughout:

1. `skills/playwright-pipeline/environment.md`: asking the user in Claude Code **and Claude Cowork**, where files live.
2. `skills/playwright-pipeline/SKILL.md` and `skills/playwright-pipeline/stages.md`: the 13 automation stages (you are the pipeline
   orchestrator), their artifacts, agents and failure behaviour.
3. `agents/test-design-orchestrator.md` and `skills/workflow-resume/SKILL.md`: the design stages (you act as that orchestrator, here,
   in this conversation, with `SCOPE` = `all`).
4. `commands/do-automation.md` phase 1 (language and scaffold), `skills/init/SKILL.md`, `skills/pipeline-setup/SKILL.md`.

## What "automatic" means

Say this in four lines before starting: the three phases (1 project and language, 2 test design with readiness and hand-over,
3 the automation stages and reports), that you carry on from stage to stage without asking "shall I continue?", and that you stop only
for (a) a choice that is theirs (which stories, an unresolved question in a story, a story that changed since its test cases were
made, a manual test case they want automated anyway), (b) a dependency install, approved **one dependency at a time** (nothing is
installed without a yes, Python included), (c) a destructive step or a missing `automation/.env` value, (d) a blocker.

Never invent base URLs, credentials, test steps or expected results. Never edit tests to force a pass. All automation state changes go
through `node dependencies/engine/cli/pipeline.ts` (`pl` below); all design state changes go through the design scripts as the
orchestrator describes.

## Resume

If `$ARGUMENTS` starts with `resume`:

1. `pl design status` (project root = the folder holding `automation/` and `dependencies/`). Show in 3-4 lines where the work stopped:
   design run and its status, stories saved / unfinished, the latest `design-test-n-automation` run and its checkpoint.
2. **Design unfinished** (a story is not `saved`, other than ones skipped as untestable): follow `workflow-resume` for the design run
   (including its question for stories whose text changed since their test cases were generated: keep / regenerate that story's file
   / skip), then continue at phase 2 step 4.
3. **Design finished**: if `pl design status` says the hand-over is not current (a design file or an imported copy changed), redo it
   (phase 2 steps 5-6). If a run already exists, `pl run resume <runId>` (or bare `pl run resume --command design-test-n-automation`,
   which picks the newest `in_progress`, `blocked` or `failed` one) prints the `checkpoint` and a `design` block: when
   `design.current` is false run `pl design attach <runId>` after the hand-over so the run follows the new input, then tell the user the
   analysis stage will repeat. Show the checkpoint as `playwright-pipeline` does and continue at its `next` stage in phase 3.
4. Nothing to resume: say so and start a new run.

## Phase 1: project and language

Follow phase 1 of `commands/do-automation.md` (project root, language, scaffolding; never default the language; install nothing).
`--language` and `--with-demo` in `$ARGUMENTS` are used as that command does. Skip it when `dependencies/engine/cli/pipeline.ts`
exists (with the version/update check that command describes).

`[1/3] project and language … done — <language>`

## Phase 2: test design, readiness and hand-over

Print one line per step: `[design n/6] <step> … <status> — <note>`.

1. **Story discovery.** `SCOPE` = `all`. The location is the first argument that is not a flag, else `stories/` (offered as the
   recommended answer when it exists), else ask once. Follow the orchestrator's Phase 0-1 (and `story-source-discovery`): the story
   files, duplicate or inferred story IDs, and in **one** question the files, the story selection and the project root. `--story` in
   `$ARGUMENTS` is the selection; with no selection every eligible story is processed. An existing design run: summarise it and resume
   it, or start a new run that extends it (it never overwrites saved cases).
2. **Story analysis**, 3. **Test design**, 4. **Test-case generation:** the orchestrator's worker pool ("Phases 2-5 - Worker pool"):
   one fresh `story-worker` per story, at most `--concurrency N` at once (default 5, at most 5), each doing analysis, design, generation,
   validation and the save of its own story's file; the orchestrator ingests the compact results and updates the shared state. Blocking
   questions a story leaves open are asked here, between batches.
   Report each story in one line, as the orchestrator does. A story that cannot be completed is reported and left out of the hand-over;
   it never stops the stories that can. If **no** story ends up saved, stop (blocked) with why and
   `/builder:design-test-n-automation resume`.
   Then the orchestrator's Phase 5 checks (validators, source drift). Sources that changed *during* this run are reported.
5. **Automation readiness.** `pl design handoff [--story <saved ids>]` (without `--apply`: it judges and writes nothing). Show, briefly:
   counts (automatable / with prerequisites / manual / blocked); every **manual** case with its reason(s) in the rule's own words and
   the statement that it is not automated and will be listed as manual in the final report; every **blocked** case with what it lacks;
   the environment variable **names** that have no value yet (never ask for a value in chat); the cases that depend on others.
   Manual cases are not a question: carry on without them. Ask only if the user earlier said they want a particular case automated
   (`--override-manual <ids>`), and say honestly that it will usually need a test-environment workaround.
6. **Hand-over.** `pl design handoff [--story …] [--override-manual …] --apply`. It imports the cases that can be automated into
   `dependencies/input/test-cases/design/` (the design files are only read), writes the credentials it finds, if any, to
   `automation/.env` (names only in the output) and records `dependencies/state/design-handoff.json`. Exit 2 with `issues` about files
   that exist with content this hand-over did not write (a hand-edited imported copy): show them and ask whether to move them aside;
   never overwrite or delete them yourself. If no case can be automated (everything manual or blocked), stop (blocked) and say why.

Tell the user in two or three lines what was handed over (stories, number of cases, `inputPath`) and what was not.

## Phase 3: the automation stages

Follow `playwright-pipeline/SKILL.md` ("Run the stages") and `stages.md` for all 13 stages, with these differences, and nothing else
changed:

- **No test-case question, no import.** The test cases are the hand-over. Create the run with
  `pl run create --command design-test-n-automation` (it refuses unless the hand-over is current; it snapshots it into the run as
  `design-handoff.json`; the input is `input/test-cases/design`). Use `input/test-cases/design` as the test-case path everywhere
  `playwright-pipeline` says to use its folder: `--path` for `input validate` and `specs parse`, the test-analyst, and
  `input.testCasesPath` in the configuration. Do not ask for it.
- `preflight`, `configuration`: as `pipeline-setup` says (ask only what is missing, one grouped call; one approval per dependency; the
  language is not asked again).
- `test_analysis`: complete it with `--artifact canonicalCases=… --artifact testSpecs=… --artifact designHandoff=design-handoff.json`.
  A test case the automation parser still finds unclear (`needs_clarification`) is a blocked test, reported, not a question to the user
  about test-case files; relay a real column-mapping or clarification question only if the stage's rules say so.
- `test_generation` onward: unchanged, including bounded healing. Manual cases were never handed over, so no script is attempted for them.
- `report_generation`: `pl report build <runId>` also writes `traceability-report.json` and `.md` in the run directory (the chain
  Story → Criterion → Scenario → Case → Script → Result, criteria no case covers, cases without a script or result, cases left manual).
  Complete the stage with `--artifact summary=… --artifact summaryMarkdown=… --artifact traceabilityReport=traceability-report.json
  --artifact traceabilityMarkdown=traceability-report.md`.
- Print `[n/13] <stage> … <status> — <note>` after each stage. A `blocked` or `failed` stage stops the flow: say why, what the user must
  do, and the exact command `/builder:design-test-n-automation resume`.

`[3/3] automation … done`

## Finish

Give the final summary defined at the end of `stages.md` and add, in this order:

1. **Traceability** from `traceability-report.md`: stories and criteria with their state (passed / failing / flaky / incomplete / manual
   only / uncovered), and the gaps listed in the report. Path: `dependencies/runs/<runId>/traceability-report.md`.
2. **Left for manual execution:** each manual case with its reason (from the hand-over). **Blocked** cases: what to fix and where.
3. What was reused from earlier work, the design run id, and where the test cases are (`test-design/test-cases/`, one file per story).

Never call a run successful unless its status is `completed`, and never present a flaky pass as a pass. Close with the next steps:
`/builder:run-tests` to run again, `/builder:heal-tests <runId>` for eligible script defects,
and `/builder:design-test-n-automation resume` to pick the whole run up again.

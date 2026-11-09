---
description: Run selected Maestro flows on a physical phone (or take a mobile run that already finished), publish the results that say something reliable about the app (passes and confirmed application defects) to a Zephyr Scale Test Cycle in plain, human-written wording with the device and app build, and create and link Jira bugs for confirmed defects. Flaky-looking, script, device, environment and unclassified failures are not sent but are listed with their reasons in an HTML report. A separate, manually invoked QA action - no pipeline or workflow ever runs it. Never fabricates results, never duplicates executions or bugs.
argument-hint: "[flow | --test ID | --feature name | --suite smoke|critical|regression | --all] [--platform android|ios] [--run <run-id>] | resume"
disable-model-invocation: true
---

# /builder:mobile-update-execution-result

Arguments: `$ARGUMENTS`

**Manual invocation only.** The mobile counterpart of `/builder:update-execution-result`: a QA action the user starts by typing it. No other command, orchestrator or agent runs it, offers to run it, or passes it a scope. If you reached this from any other workflow rather than from the user typing it, stop and say so. It does not generate or change flows or test cases, never fixes the app, and does not repair flows (the flow healer is used for confirming classifications only).

You (the main session) are the orchestrator: you ask the questions, call the Jira connector, and delegate failure confirmation to a subagent.

## Read first

From the plugin root (`${CLAUDE_PLUGIN_ROOT}`; if the variable is not expanded, locate the plugin as [environment.md](../skills/playwright-pipeline/environment.md) describes):

1. `skills/playwright-pipeline/environment.md`: how to ask the user in Claude Code and Cowork, where the project root is.
2. `skills/execution-result-publishing/SKILL.md`: the script calls, what reaches Zephyr and what is held back, wording, bug rules, recovery. Everything there applies here; this file lists only what differs on mobile. `PY` is the first of `python`, `python3`, `py -3` that runs; `SCRIPTS` is `${CLAUDE_PLUGIN_ROOT}/test-design/scripts`; **`ER` = `PY SCRIPTS/zephyr-execution.py <subcommand> --surface mobile --root "<root>"`** (always `--surface mobile`: it moves the state to `mobile-automation/execution-results/` and reads Maestro runs).
3. `skills/maestro-execution/SKILL.md` (running, evidence, failure categories) and `skills/maestro-setup/SKILL.md` (devices, physical-device rule).

`MCLI` = `node mobile-automation/tools/maestro-cli.mjs`, run from the project root `<root>` (the folder that holds `mobile-automation/`). If `mobile-automation/state/scaffold.json` is missing, stop and point to `/builder:build-mobile-automation`. Never print the Zephyr token. At the first failed check **stop**, say in plain words what is wrong and the concrete steps to fix it, and do not run later stages.

**Cowork:** a sandbox cannot reach a phone. Without `--run <run-id>` say so and stop; with an already finished run you may do the publishing stages, and say where the run was made.

If `$ARGUMENTS` starts with `resume`, go to **Resume**.

## Stage A: Preflight (nothing is executed or published yet)

1. **Mobile framework.** `MCLI config check` must report a valid configuration; `MCLI preflight --platform <p>` must find Maestro (and adb for Android). Otherwise point to `/builder:build-mobile-automation`; this command installs nothing.
2. **Jira connector, project, Zephyr.** Exactly as `/builder:update-execution-result` Stage A steps 2-4: confirm the Atlassian/Jira connector is authenticated, list the Jira projects and ask which one is `<KEY>` (never choose for the user), then `ER preflight --project <KEY>` and relay `warnings`; a missing Pass/Fail status name is solved with `--status-pass/--status-fail`.
3. **Platform and scope.** `--platform`, else the single platform in scope, else ask. Scope from `$ARGUMENTS` (`flow`, `--test`, `--feature`, `--suite`, `--all`); if none, ask: *Smoke suite (Recommended)* / *Critical* / *Regression* / *A single flow or test case*. `MCLI scope --platform <p> <scope flags> > mobile-automation/execution-results/scope.json` (create the folder first). Exit 2 means the scope selects nothing: show `error`, stop. Tell the user how many test cases it selects, and any `untagged` flows (no `# testCase:` header: they cannot be tied to a Zephyr case) and `duplicateIds` (two flows for one test case: **stop**, one flow per test case).
   **A run that already finished:** with `--run <run-id>` (or when the user says the tests were already run), do not run again: `MCLI report list` to confirm the run, build the scope file from that run's own test cases (`mobile-automation/reports/<run-id>/results.json`, `testCase` of every flow; use `{"tests":[{"testId":"TC-1"},...]}`), and skip the device checks and Stage B's execution.
4. **Physical device.** Zephyr results are only recorded from a real phone. `MCLI devices --platform <p>` and `MCLI device verify --platform <p>` (the app must be on it, build visible). Only an emulator/simulator or nothing: show `connectSteps`, offer *I connected a phone, check again* / *Run on the emulator anyway (results stay out of Zephyr)* / *Stop*. On the second, the run is labelled and every result is held back from Zephyr (`not_physical_device`) unless the user later says to record emulator results (`capture --allow-emulator`, a decision only the user makes, stated in the summary). Several physical devices: ask which, never guess. Do not change device settings or install the app without a yes (`MCLI app install ... --approved`).
5. **Secrets.** `MCLI env check` for the scope's platform/environment; missing names are reported (names only) and the user fills `mobile-automation/.env`. Never ask for values in chat.
6. **Mapping.** `ER map --project <KEY> --scope-file mobile-automation/execution-results/scope.json`. Handle `problems` exactly as in the Playwright command (stop and fix, or continue with only the mapped tests: narrow the scope with `--test <ID>` flags, run `MCLI scope` again, pass `--only-mapped` to `begin`).
7. **Test Cycle and confirm.** As in the Playwright command (new cycle, or an existing one from `ER cycles`), then one summary: project, N test cases and scope, platform, **device (model, OS, physical)**, app build, environment name, the Test Cycle, the two status names. Ask *Start* / *Change something*, then `ER begin --project <KEY> (--cycle <K> | --new-cycle "<name>") --scope-file ... --scope-text "<scope in words>" [--only-mapped] [--status-pass N --status-fail N]`. `RUN_IN_PROGRESS` means an earlier update is unfinished: offer **Resume** or `ER abandon`.

## Stage B: Execute, triage, capture

- **Execute** (skipped for `--run`): `MCLI run <scope flags> --platform <p> [--env <e>] [--device <id>] --label zephyr`. Flows run one by one and keep their evidence; progress is on stderr. A `needsInput` reply (device, app_install, env, ...) is relayed, not worked around. If the run did not start (nothing executed) **stop: capture and publish nothing**. Failed flows are not a runner error. An `incomplete` run (device lost) is fine to capture: flows that did not run are held back as skipped.
- **Triage.** Each failed flow already has a category (application / automation / device / environment / unclassified) with confidence from the run. Read `maestro-execution` "Failure categories". Delegate confirmation of the `application` and `unclassified` ones to `builder:maestro-flow-healer` **Phase A only** (no edits, no healing; brief: run id, flow, `hierarchy-at-failure.json`, screenshot), or do one or two yourself with the Read tool on the screenshot. A failure is an application defect only when the screen shows the app misbehaving (wrong value, crash, unexpected error) while the flow's steps worked; if the screen is right and the selector is not, it is an automation issue. For each confirmed one: `ER classify --test <ID> --category application_defect --confidence high --rationale "<what the screenshot shows>" --by agent` (after `capture`, below). Anything unconfirmed stays *needs investigation* and is **held back**.
- **Capture.** `ER capture --run-id <runId> [--allow-emulator]`. Show the plan table (test, Zephyr key, class, will it be sent, bug eligible). Say plainly what is held back ("not sent: element not found, flow needs fixing"). **Only a pass and a confirmed application defect are sent.** Device failures, environment problems, script/selector problems, skipped and not-run flows, unclassified failures and (by default) emulator runs stay in the local record and the HTML report.
- For every `needs_investigation` that may be an application defect, show its error and evidence and ask which, if any, the user can confirm (multi-select; default none): `ER classify ... --by user`. Never decide for them. The agent's confirmations (above) are made *after* `capture`; run `ER classify` for each, then show the plan again.
- **Write the accounts, in your own words, before publishing**: exactly as in the Playwright command (`ER narrate --test <ID> --actual "..." --summary "..."` for every Fail and bug; for passes only when you saw the evidence). Write it as a tester would about what a person using the phone saw ("After adding the second item the cart total still showed 4 instead of 5."), under ~100 characters for the title, only what the screenshot/evidence shows. No tool words (Maestro, flow, YAML, tapOn, assertVisible, selector, ADB), no test or run IDs, no "automated"/"AI"/"generated". The script refuses text that looks like pasted tool output.

## Stage C-E: Publish, bugs, report, resume

Identical to `/builder:update-execution-result` Stages C, D and E and its Resume, with `ER` as defined above, and these differences:

- Executions carry the device, OS, app build and environment in their note; the Jira bug has **Device / OS / App / Environment** sections and a build (`versionName (build versionCode)`, from the run); screenshots and a screen recording are uploaded to the execution when the deployment accepts attachments (recordings only for failures), otherwise their paths (under `mobile-automation/artifacts/<runId>/`) are listed in the bug and must be attached by hand.
- `ER report --write` writes the Markdown and the self-contained **HTML report** to `mobile-automation/execution-results/reports/<id>.{md,html}` (every result including the held-back ones with reason, plain-words account, full log excerpt, evidence links, device facts, and a link to the Maestro run report `mobile-automation/reports/<runId>/report.html`).
- In the completion report separate three things: *tests passed* (the run), *validated on a physical device* (`MCLI validation status`, unchanged by this command), and *results published to Zephyr / bugs filed*. A green run whose results were all held back (emulator) is not a clean publish.
- **Resume**: `ER status`; not captured but a finished run exists: find it with `MCLI report list`, confirm with the user, `ER capture --run-id <id>`; otherwise continue with `publish`, the bug steps and `link-bugs` **without running flows again**.

Never edit `execution-run.json` or the history by hand, never delete a Zephyr execution, cycle or Jira bug, and never edit flows or the app from here.

# Test design → automation hand-over

Reference for `node dependencies/engine/cli/pipeline.ts design …` and for runs created with `--design` (always on for
`/builder:design-test-n-automation`). Code: `engine/pipeline/design-handoff.ts`, `readiness.ts`, `traceability-report.ts`.

## What the design stages leave (read-only for the pipeline)

```
test-design/
  test-cases/<story>-testcase.md      one validated Markdown file per story (canonical format; never edited by the pipeline)
  state/workflow.json                 the design run's checkpoint: per story status, file, sha256, source fingerprint
  state/traceability.json             case → story, covered criteria ("US-001#AC-2"), techniques, scenario key
  state/analysis/<story>.json         the story analysis (criterion texts)
  state/conditions/<story>.json       the designed scenarios (written by the design step, read by test-case generation)
```

## `design handoff [--story S,...] [--override-manual ID,...] [--apply]`

Without `--apply` it judges and reports; nothing is written. With `--apply` it:

1. refuses stories that are not `saved` in the design checkpoint and files that are missing; warns when a file was edited by hand after
   the design saved it (the edited version is handed over);
2. parses the chosen files together with the pipeline's own parser (an ID used in two files is an error) and assesses readiness;
3. imports every case except the **manual** ones into `dependencies/input/test-cases/design/<ID>.md`. An imported file this hand-over
   wrote earlier and nobody edited is replaced when its case changed and removed when the design dropped the case; a file someone edited
   is never overwritten or deleted (conflict → nothing written; dropped case → kept with a warning);
4. writes `dependencies/state/design-handoff.json`.

`design handoff` is idempotent. `design status` says whether the recorded hand-over is still current (design files and imported copies
match their recorded hashes). `pipeline.ts run create … --design` refuses a stale hand-over and snapshots the file into the run
(`design-handoff.json`); `run resume` prints `design: { current, issues }`; `design attach <runId>` refreshes the snapshot.

## Readiness verdicts (`design readiness`, deterministic)

| Verdict | Meaning | Handed to automation |
|---|---|---|
| `automatable` | nothing to arrange first | yes |
| `automatable_with_prerequisites` | preconditions, dependencies on other cases, or `env:` values with no value yet; the reasons say which | yes |
| `blocked` | the case is incomplete (no steps / expected result, undefined data…); a person clarifies it | yes (reported as a blocked test, never generated) |
| `manual` | a rule says a browser test cannot do it; reasons listed | **no**; listed in the traceability report |

Manual rules (`MANUAL_RULES` in `readiness.ts`): `captcha`, `out_of_band_code` (OTP / SMS / 2FA), `mailbox`, `physical_device`,
`real_device`, `subjective_judgement`, `long_elapsed_time`, `load_or_security_testing`, `declared_manual`, and a `manual` tag.
`--override-manual ID` automates a flagged case anyway (recorded as `manual_flag_overridden`). The rules look only at the text of the case.

## Traceability report (`design trace <runId>`, also written by `report build`)

`traceability-report.json` / `.md` in the run directory: **Story → Acceptance criterion → Test scenario → Test case → Automation
script → Execution result**. A case is `passed`, `failed`, `flaky`, `skipped`, `not_run` (script without result), `not_generated`,
`blocked` or `manual`; a criterion is `passed`, `failing`, `flaky`, `incomplete`, `manual_only` or `uncovered`. A healed test's
`regression` result is its latest word. Missing links are listed under `gaps`, never filled in.

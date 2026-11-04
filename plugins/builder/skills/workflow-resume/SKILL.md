---
name: workflow-resume
description: Read the checkpoint state, verify source fingerprints and output hashes, classify each story, and resume an interrupted Test Design run without duplicating completed work or overwriting output. Also reports status. Use when /builder:generate-test-cases (or the design phase of /builder:design-test-n-automation) finds an existing run.
user-invocable: false
---

# Workflow resume

State lives in `<root>/test-design/state/`: `workflow.json` (checkpoint, schema `test-design/schemas/workflow-state.schema.json`), `traceability.json`, `source-fingerprints.json`, `audit.jsonl`, `analysis/<story-id>.json` (the validated structured result of each story's isolated analysis; no worker transcripts) and `results/<story-id>.result.json` (the compact record the story's worker left: status, case IDs, hashes, the metadata `ingest` turns into traceability; it is how an interrupted worker's finished file is recognised). `workflow.json` also holds the pool settings (`scheduler`: concurrency, retry budget, lease, design-rules fingerprint) and, per story, `execution` (attempts, dispatch count, last error, what it awaits). The test cases themselves are in `<root>/test-design/test-cases/<USER_STORY_ID>-testcase.md`, one file per story, recorded on each story as `stories.<id>.testCaseFile` (`path`, `sha256`, `caseCount`, `sourceSha256` = the story fingerprint the file was generated from). `PY` / `SCRIPTS` as in `story-source-discovery`.

## Locate the run

Use a project root the user gave; otherwise the nearest ancestor of the working directory containing `test-design/state/workflow.json`. If none is found, say so and ask for the project root. Do not search the whole disk.

## Procedure

1. **Read `workflow.json`.** Missing or unparsable: stop. Explain exactly what is wrong (`state file missing` / `not valid JSON`), list what output files exist, and ask the user how to proceed (start over keeping the existing cases, repair by hand, or point to a backup in `state/backups/`). Never assume the run was complete and never rewrite a corrupt state file.
2. **Check outputs.** For each `saved` story, `PY SCRIPTS/safe-file-operations.py hash "<root>/<stories.S.testCaseFile.path>"` (several paths may go in one call) and `"<root>/test-design/state/traceability.json"`; compare with `stories.S.testCaseFile.sha256` and `outputs.traceability.sha256`. This reads hashes only, never the test cases.
   - A story's file missing although the story is `saved`: report it as a missing output for that story; ask. Do not regenerate silently.
   - Hash differs: that story's file was edited since the last checkpoint. Not an error. Keep appending only; mention it.
   - Run `validate-traceability.py --test-cases-dir "<root>/test-design/test-cases" --traceability ...` (or, for one story, `--test-cases <its file>`). A case present in a file but unmapped (`ORPHAN_CASE`) after a crash between steps: tell the user and offer to map it from its title and story if unambiguous, or leave it flagged.
   - `existingOutput.legacyConsolidatedFile` / a `test-cases.md` in the folder: see "Legacy consolidated file".
3. **Verify sources.** `PY SCRIPTS/fingerprint-sources.py compare <each selected source file> --previous "<root>/test-design/state/source-fingerprints.json" --root "<root>" --traceability "<root>/test-design/state/traceability.json" --workflow "<root>/test-design/state/workflow.json"`. Exit 1 means changes. Read `files`, `stories.changed|added|removed`, `affectedTestCases` (story -> case IDs), `affectedTestCaseFiles` (story -> its file) and `staleTestCaseFiles` (each story whose file was generated from an older version of the story, or is missing, with `reasons`, `fileMissing`, `editedSinceGenerated`). The stale list is the authority on which files need attention: it compares each story with the fingerprint recorded for its own file, so it stays correct even after the run's snapshot was refreshed. A source file that no longer exists is `removed`.
4. **Classify every story** in `workflow.json`:
   - `saved` and unchanged: done, skip.
   - `saved` and listed in `staleTestCaseFiles` (story changed or removed): **affected**. Do not touch its file. See "Reconcile". Stories not listed are untouched, whatever else changed.
   - `running` (a worker was dispatched and never ingested): **interrupted**. `PY SCRIPTS/story-run.py next --root "<root>" --reclaim` reconciles it: a finished result whose file is intact (or whose cases reached the file before the crash) is adopted and ingested, never rerun; otherwise it is released for a bounded retry. Nothing is regenerated and no valid file is overwritten (a retry appends to a recorded file, and stops for the user if the file is unrecorded or its cases differ).
   - `pending`, `analysing`, `designing`, `generating`, `validating`, `needs_clarification`, `failed`, or the story named by `inProgressOperation`: **incomplete**. Resume that story from its first unfinished stage (`lastCompletedStage`); drafts are transient, but a `completed` analysis with unchanged fingerprints is reused, not redone, and an analysis marked `in_progress` or `failed` is rerun in a fresh worker. If its file `test-design/test-cases/<story>-testcase.md` already exists with its cases mapped in `traceability.json`, validate it (`validate-test-cases.py <file> --story-id <story>`) and mark the story `saved` (recording `testCaseFile`) instead of regenerating.
   - In `stories.added` but not in `workflow.json`: **new**. Offer to add it.
5. **Check analyses.** `PY SCRIPTS/story-analysis-state.py plan --root "<root>"` (read-only, no `--apply`). Per story it says `reuse` (a completed analysis whose story, shared-rule and dependency fingerprints are unchanged), `analyse` (not started, interrupted, or failed, with the recorded reason), `invalidated` (what changed: `story_changed`, `shared_rule_changed:<id>`, `dependency_changed:<id>`, or a missing/invalid saved result), or `skip`. Only the listed stories are affected; unchanged completed analyses are never rerun. A story saved by an earlier plugin version has no analysis record and is left alone (`saved_before_isolated_analysis`).
   For the pool, `PY SCRIPTS/story-run.py plan --root "<root>"` (read-only) gives the same classification per story in one call: `done`, `stale` (with reasons: `story_changed`, `shared_rule_changed:<id>`, `dependency_changed:<id>`, `design_rules_changed`, `output_missing`), `dispatch`, `retry`, `running`, `interrupted`, `awaiting_user`, `blocked_untracked_output`, `blocked_dependency`, `waiting_dependency`, `exhausted` (out of retries; `--retry-failed` only when the user asks) and `skipped`. Only `stale` stories need the Reconcile question below; the rest is handled by the pool.
6. **Present a short summary**: counts per class, affected stories with their test case IDs, new stories, and any state problems. Then ask what to do.
7. **Continue** with the orchestrator's per-story loop for the incomplete (and approved new) stories only. Run `story-analysis-state.py plan --root "<root>" --apply` to record invalidations, then analyse each story that needs it with its own fresh worker, one at a time ("Isolated story analysis" in the orchestrator). A `failed` story is retried on its own; stories whose analysis is `reuse` use the saved result and start no worker. Update `sourceFiles`, the stories map and `source-fingerprints.json` (a fresh `snapshot --output`) only after the user decided on the changed stories.

## Reconcile changed stories (always ask first)

One story at a time. For each affected story show: what changed (story hash), its file name and the case IDs and titles in it (from `traceability.json`; do not open other stories' files). Options:

1. **Keep** the file as it is (record that the story changed after generation; it stays flagged stale in status).
2. **Regenerate this story's file**: re-analyse the story in a fresh worker (its analysis is already invalidated, and so are those of stories that used a changed shared rule or depend on it), generate a new draft for that story only, and follow "Regenerating one story's file" in the orchestrator: a dry run shows which case IDs are kept, changed, added and removed, and the file is replaced only after the user agrees to that. Hand edits to the file are listed and need their own yes. The previous file is backed up. No other story's file is read or written.
3. **Skip** for now (stays flagged in status).

Never regenerate, replace or delete a case or a file without the user choosing option 2 for that story and confirming the dry run. When several stories changed, handle each separately; the user may regenerate some and keep others.

## Legacy consolidated file

Runs made before one file per story kept every case in `test-design/test-cases/test-cases.md`. Never modify it silently and never write a new story's file for a story whose cases are still only in it (the IDs would then exist twice). Offer the migration once, in one question:

1. `PY SCRIPTS/safe-file-operations.py split-legacy --root "<root>"` (dry run): lists the per-story files and case IDs it would create. If it reports `CANNOT_SPLIT` (a module without `User Story ID:`, an existing story file in the way), show the problems; the user fixes them by hand, nothing was written.
2. On a yes, repeat with `--yes`. Each section moves to its story's file byte for byte; the old file is moved to `state/backups/` (path in `legacyBackup`), not deleted.
3. Apply the returned `traceabilityPatch` and `workflowPatch` with `merge-json` (`traceability.json` and `workflow.json`, `--touch updatedAt`; add `--schema` as usual) so every migrated story records its `testCaseFile`, then append audit `{"event":"legacy_split","files":n,"cases":n}`.
4. If the user declines, keep the legacy file, tell them `validate` will warn about it (`LEGACY_CONSOLIDATED_FILE`), and continue only with stories that have no cases in it yet.

## Status report (read-only)

Show: run ID and status, project root, current phase and story, the pool (`story-run.py status`: concurrency, whether the runtime ran workers in parallel, tokens and elapsed time reported separately, never as a saving), per-story status table (story ID, status, analysis status, test-case file and case count, validation outcome, and a stale marker when `staleTestCaseFiles` lists it), totals (stories processed / total, files and cases generated), unresolved clarifications, source drift (from step 3) and the output folder. Case counts and hashes come from `workflow.json`; do not open the test-case files to count them. Make no writes.

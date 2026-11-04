// Bounded, audited healing attempts. One attempt = begin (reserve + snapshot) -> agent patch ->
// check (guard) -> rerun -> record. Rejected or unsuccessful patches are reverted to the snapshot.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { withFileLock } from '../utils/lock.ts';
import { ARTIFACTS } from './artifact-manager.ts';
import type { ExecutionResults } from './execution.ts';
import type { FailureAnalysis, FailureEntry } from './failure-classifier.ts';
import { GENERATED_MARKER, TESTS_DIR, isPipelineOwned } from './generation.ts';
import { guardPatch, type GuardResult } from './healing-guard.ts';

export const HEALING_LOG_SCHEMA_VERSION = 1;
export const HEALING_OUTCOMES = ['healed', 'still_failing', 'rejected_by_guard'] as const;
export type HealingOutcome = (typeof HEALING_OUTCOMES)[number];

export interface HealingEntry {
  testId: string;
  attempt: number;
  file: string; // relative to automation/
  category: string;
  confidence: string;
  rationale: string; // why this is a script defect, citing evidence
  evidence: string[]; // project/run-relative paths the agent relied on
  before: string; // run-relative snapshot path
  diff: string;
  guard: Pick<GuardResult, 'ok' | 'violations' | 'warnings' | 'changedLines'>;
  rerun: { label: string; outcome: string | null; resultsFile: string | null };
  outcome: HealingOutcome;
  reverted: boolean;
  recordedAt: string;
}

export interface HealingLog {
  schemaVersion: typeof HEALING_LOG_SCHEMA_VERSION;
  entries: HealingEntry[];
}

export function healingLogPath(runDirectory: string): string {
  return path.join(runDirectory, ARTIFACTS.healingLog);
}

export function readHealingLog(runDirectory: string): HealingLog {
  const r = readJson(healingLogPath(runDirectory));
  if (!r.ok) {
    if (r.reason === 'not_found') return { schemaVersion: HEALING_LOG_SCHEMA_VERSION, entries: [] };
    throw new Error(r.message);
  }
  return r.value as HealingLog;
}

export function snapshotPath(runDirectory: string, testId: string, attempt: number, file: string): string {
  return path.join(runDirectory, ARTIFACTS.healingDir, testId.replace(/[^\w.-]/g, '_'), `attempt-${attempt}`, `before${path.extname(file)}`);
}

export function healLabel(testId: string, attempt: number): string {
  return `heal-${testId.replace(/[^\w.-]/g, '_')}-${attempt}`;
}

// Only pipeline-generated tests (under tests/, carrying the generated marker) may be patched automatically.
export function assertHealableFile(rootDir: string, file: string): void {
  if (isAbsoluteOrEscaping(file) || !file.replace(/\\/g, '/').startsWith(`${TESTS_DIR}/`)) {
    throw new Error(`"${file}" is not under ${TESTS_DIR}/; other files need explicit user approval to change`);
  }
  const abs = path.join(rootDir, file);
  if (!existsSync(abs)) throw new Error(`"${file}" does not exist`);
  if (!isPipelineOwned(readFileSync(abs, 'utf8'))) {
    throw new Error(`"${file}" has no "${GENERATED_MARKER}" header, so it is not pipeline-generated; handwritten tests need explicit user approval to change`);
  }
}

export function eligibleFailure(analysis: FailureAnalysis, testId: string): FailureEntry {
  const entries = analysis.failures.filter((f) => f.testId === testId);
  if (entries.length === 0) throw new Error(`${testId} has no recorded failure`);
  const eligible = entries.find((f) => f.healingEligible);
  if (!eligible) {
    const f = entries[0]!;
    throw new Error(`${testId} is not eligible for healing (${f.category}, ${f.confidence} confidence); leave it failing and report it`);
  }
  return eligible;
}

// Snapshot the file for a reserved attempt. The attempt number comes from recordHealingAttempt.
export function snapshotForAttempt(rootDir: string, runDirectory: string, testId: string, attempt: number, file: string): string {
  assertHealableFile(rootDir, file);
  const snap = snapshotPath(runDirectory, testId, attempt, file);
  mkdirSync(path.dirname(snap), { recursive: true });
  copyFileSync(path.join(rootDir, file), snap);
  return snap;
}

export function checkAttempt(rootDir: string, runDirectory: string, testId: string, attempt: number, file: string): GuardResult {
  const snap = snapshotPath(runDirectory, testId, attempt, file);
  if (!existsSync(snap)) throw new Error(`no snapshot for ${testId} attempt ${attempt}; run "heal begin" first`);
  return guardPatch(readFileSync(snap, 'utf8'), readFileSync(path.join(rootDir, file), 'utf8'), testId);
}

export function revertAttempt(rootDir: string, runDirectory: string, testId: string, attempt: number, file: string): void {
  const snap = snapshotPath(runDirectory, testId, attempt, file);
  if (!existsSync(snap)) throw new Error(`no snapshot for ${testId} attempt ${attempt}`);
  copyFileSync(snap, path.join(rootDir, file));
}

export interface RecordInput {
  testId: string;
  attempt: number;
  file: string;
  rationale: string;
  evidence: string[];
  failure: FailureEntry;
  rerun: ExecutionResults | null; // null when the guard rejected the patch (no rerun)
  rerunFile: string | null;
  now?: Date;
}

// Records the attempt and reverts the file unless it was healed.
export function recordAttempt(rootDir: string, runDirectory: string, input: RecordInput): HealingEntry {
  if (!input.rationale.trim()) throw new Error('a rationale citing evidence is required');
  const guard = checkAttempt(rootDir, runDirectory, input.testId, input.attempt, input.file);
  const rerunTests = input.rerun?.tests.filter((t) => t.testId === input.testId) ?? [];
  // Healed only if the guard passed and every project's rerun passed on the first attempt.
  const rerunPassed = rerunTests.length > 0 && rerunTests.every((t) => t.outcome === 'passed') && !input.rerun?.runnerError;
  let outcome: HealingOutcome;
  if (!guard.ok) outcome = 'rejected_by_guard';
  else if (rerunPassed) outcome = 'healed';
  else outcome = 'still_failing';

  const reverted = outcome !== 'healed';
  if (reverted) revertAttempt(rootDir, runDirectory, input.testId, input.attempt, input.file);

  const entry: HealingEntry = {
    testId: input.testId,
    attempt: input.attempt,
    file: input.file,
    category: input.failure.category,
    confidence: input.failure.confidence,
    rationale: input.rationale,
    evidence: input.evidence,
    before: toPosixRelative(runDirectory, snapshotPath(runDirectory, input.testId, input.attempt, input.file)),
    diff: guard.diff,
    guard: { ok: guard.ok, violations: guard.violations, warnings: guard.warnings, changedLines: guard.changedLines },
    rerun: {
      label: input.rerun?.label ?? healLabel(input.testId, input.attempt),
      outcome: rerunTests.length ? (rerunPassed ? 'passed' : rerunTests.map((t) => `${t.project}:${t.outcome}`).join(',')) : input.rerun?.runnerError ? 'runner_error' : null,
      resultsFile: input.rerunFile,
    },
    outcome,
    reverted,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
  // Two healers finishing at once must not drop each other's entries.
  withFileLock(`${healingLogPath(runDirectory)}.lock`, () => {
    const log = readHealingLog(runDirectory);
    if (log.entries.some((e) => e.testId === entry.testId && e.attempt === entry.attempt)) {
      throw new Error(`${entry.testId} attempt ${entry.attempt} is already recorded`);
    }
    writeJsonAtomic(healingLogPath(runDirectory), { ...log, entries: [...log.entries, entry] });
  });
  return entry;
}

// Ensure an (empty) healing log exists when the stage ran but nothing was eligible.
export function ensureHealingLog(runDirectory: string): void {
  if (!existsSync(healingLogPath(runDirectory))) writeJsonAtomic(healingLogPath(runDirectory), { schemaVersion: HEALING_LOG_SCHEMA_VERSION, entries: [] });
}

export function validateHealingLog(v: unknown, maxAttempts: number | null): string[] {
  if (typeof v !== 'object' || v === null) return ['healing log must be an object'];
  const l = v as Partial<HealingLog>;
  const issues: string[] = [];
  if (l.schemaVersion !== HEALING_LOG_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Array.isArray(l.entries)) return [...issues, 'entries must be an array'];
  const perTest = new Map<string, number>();
  for (const e of l.entries) {
    perTest.set(e.testId, Math.max(perTest.get(e.testId) ?? 0, e.attempt));
    if (!(HEALING_OUTCOMES as readonly unknown[]).includes(e.outcome)) issues.push(`${e.testId}#${e.attempt}: invalid outcome`);
    if (e.outcome === 'healed' && !e.guard?.ok) issues.push(`${e.testId}#${e.attempt}: marked healed but the guard failed`);
    if (e.outcome !== 'healed' && !e.reverted) issues.push(`${e.testId}#${e.attempt}: unsuccessful patch was not reverted`);
    if (!e.rationale) issues.push(`${e.testId}#${e.attempt}: rationale missing`);
  }
  if (maxAttempts !== null) {
    for (const [id, n] of perTest) if (n > maxAttempts) issues.push(`${id}: ${n} attempts exceeds the limit of ${maxAttempts}`);
  }
  return issues;
}

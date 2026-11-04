// Creates, loads, validates and updates run manifests (dependencies/runs/<run-id>/manifest.json).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateConfig, type AutomationConfig } from '../config/schema.ts';
import { readJson, sha256File, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { inputBaseDir } from '../utils/layout.ts';
import { withFileLock } from '../utils/lock.ts';
import { istIso } from '../utils/time.ts';
import { ARTIFACTS, EVIDENCE_DIR, REPORTS_DIR, RUN_ID_PATTERN, checkArtifactPath, runDir, runsDir } from './artifact-manager.ts';
import type { DependencyChange } from './dependency-log.ts';
import { StageContractError, checkStageOutputs } from './stage-contracts.ts';
import {
  COMMANDS, STAGES, applyTransition, deriveRunStatus, initialStages, isStageStatus, nextStage,
  recoverInterrupted, type Command, type RunStatus, type StageAttempt, type StageMap, type StageName, type StageStatus,
} from './state-manager.ts';

export const MANIFEST_SCHEMA_VERSION = 1;

export interface InputRef {
  path: string; // relative to dependencies/ (e.g. input/test-cases/login.md)
  sha256: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  flaky: number; // passed only after retry — never counted as passed
  healed: number;
  blocked: number;
  skipped: number;
  unresolved: number;
}

export interface RunManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  runId: string;
  command: Command;
  // /heal-tests and /run-tests may work from an earlier run's results. Absent in older manifests.
  sourceRunId?: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: RunStatus;
  currentStage: StageName | null;
  inputs: InputRef[];
  // Secret-free by schema. null until the `configuration` stage resolves a valid config.
  config: AutomationConfig | null;
  stages: StageMap;
  testCounts: TestCounts | null;
  artifacts: Record<string, string>; // name -> path relative to run dir
  setupChanges: DependencyChange[];
  healing: {
    maxAttemptsPerTest: number | null; // from config; null until configured
    attemptsByTest: Record<string, number>;
  };
  // Present on /design-test-n-automation runs: the test-design handoff this run was created from (a snapshot is in the run directory).
  design?: { handoffSha256: string; designRunId: string };
}

type Clock = () => Date;
const systemClock: Clock = () => new Date();

// The date and time in the id are IST (14:00:12 for 2026-10-19T08:30:12Z), so the folder name reads as local time.
export function generateRunId(now: Date = new Date()): string {
  const iso = istIso(now); // 2026-10-19T14:00:12
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `${date}-${time}-${randomBytes(3).toString('hex')}`;
}

export interface CreateRunOptions {
  command: Command;
  config?: AutomationConfig | null; // may be attached later via setRunConfig
  inputPaths?: string[]; // files or directories, relative to dependencies/ or absolute inside it
  sourceRunId?: string | null;
  clock?: Clock;
}

function requireValidConfig(config: unknown): AutomationConfig {
  const cfg = validateConfig(config);
  if (!cfg.ok) throw new Error(`invalid config: ${cfg.issues.map((i) => i.message).join('; ')}`);
  return cfg.config;
}

export function createRun(rootDir: string, opts: CreateRunOptions): RunManifest {
  const clock = opts.clock ?? systemClock;
  const config = opts.config == null ? null : requireValidConfig(opts.config);
  const inputs = (opts.inputPaths ?? []).flatMap((p) => hashInputs(inputBaseDir(rootDir), p));
  if (opts.sourceRunId) {
    const src = loadManifest(rootDir, opts.sourceRunId);
    if (!src.ok) throw new Error(`source run ${opts.sourceRunId} is invalid: ${src.issues.join('; ')}`);
  }

  mkdirSync(runsDir(rootDir), { recursive: true });
  let runId = '';
  for (let attempt = 0; ; attempt++) {
    runId = generateRunId(clock());
    try {
      mkdirSync(runDir(rootDir, runId)); // non-recursive: fails if the id already exists
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) throw err;
    }
  }

  const now = clock().toISOString();
  const stages = initialStages(opts.command);
  const manifest: RunManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    command: opts.command,
    sourceRunId: opts.sourceRunId ?? null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    status: deriveRunStatus(stages),
    currentStage: nextStage(stages),
    inputs,
    config,
    stages,
    testCounts: null,
    artifacts: {},
    setupChanges: [],
    healing: { maxAttemptsPerTest: config?.healing.maxAttemptsPerTest ?? null, attemptsByTest: {} },
  };
  saveManifest(rootDir, manifest);
  return manifest;
}

function hashInputs(baseDir: string, p: string): InputRef[] {
  const abs = path.resolve(baseDir, p);
  const rel = toPosixRelative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`input "${p}" is outside dependencies/`);
  const st = statSync(abs); // throws ENOENT with a clear path if missing
  if (st.isFile()) return [{ path: rel, sha256: sha256File(abs) }];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name))
    .sort()
    .map((f) => ({ path: toPosixRelative(baseDir, f), sha256: sha256File(f) }));
}

export function manifestPath(rootDir: string, runId: string): string {
  return path.join(runDir(rootDir, runId), ARTIFACTS.manifest);
}

export function saveManifest(rootDir: string, m: RunManifest): void {
  writeJsonAtomic(manifestPath(rootDir, m.runId), m);
}

// Every change to an existing manifest goes through here: the load -> change -> save cycle holds a per-run lock, so
// concurrent CLI processes (parallel workers, stage agents) cannot overwrite each other's updates. `change` must be
// quick and must not call the Playwright runner or an agent.
export function mutateManifestWith<R>(
  rootDir: string,
  runId: string,
  change: (m: RunManifest) => { manifest: RunManifest; result: R },
): { manifest: RunManifest; result: R } {
  return withFileLock(path.join(runDir(rootDir, runId), '.manifest.lock'), () => {
    const loaded = loadManifest(rootDir, runId);
    if (!loaded.ok) throw new Error(`manifest for ${runId} is invalid: ${loaded.issues.join('; ')}`);
    const out = change(loaded.manifest);
    if (out.manifest !== loaded.manifest) saveManifest(rootDir, out.manifest);
    return out;
  });
}

export function mutateManifest(rootDir: string, runId: string, change: (m: RunManifest) => RunManifest): RunManifest {
  return mutateManifestWith(rootDir, runId, (m) => ({ manifest: change(m), result: null })).manifest;
}

export type LoadManifestResult = { ok: true; manifest: RunManifest } | { ok: false; issues: string[] };

// Loads and fully validates a manifest. Never trust a manifest that fails validation.
export function loadManifest(rootDir: string, runId: string): LoadManifestResult {
  const r = readJson(manifestPath(rootDir, runId));
  if (!r.ok) return { ok: false, issues: [r.message] };
  const issues = validateManifest(r.value, runDir(rootDir, runId));
  if (issues.length > 0) return { ok: false, issues };
  const m = r.value as RunManifest;
  if (m.runId !== runId) return { ok: false, issues: [`manifest runId "${m.runId}" does not match directory "${runId}"`] };
  return { ok: true, manifest: m };
}

export function validateManifest(v: unknown, runDirectory: string): string[] {
  const issues: string[] = [];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['manifest must be a JSON object'];
  const m = v as Partial<RunManifest>;
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) issues.push(`unsupported manifest schemaVersion ${JSON.stringify(m.schemaVersion)}`);
  if (typeof m.runId !== 'string' || !RUN_ID_PATTERN.test(m.runId)) issues.push('runId is missing or malformed');
  if (!(COMMANDS as readonly unknown[]).includes(m.command)) issues.push(`unknown command ${JSON.stringify(m.command)}`);
  if (m.sourceRunId != null && (typeof m.sourceRunId !== 'string' || !RUN_ID_PATTERN.test(m.sourceRunId))) issues.push('sourceRunId is malformed');
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) issues.push('createdAt is missing or not a timestamp');
  if (m.config === undefined) {
    issues.push('config is missing (use null before the configuration stage)');
  } else if (m.config !== null) {
    const cfg = validateConfig(m.config);
    if (!cfg.ok) issues.push(...cfg.issues.map((i) => `config: ${i.message}`));
  } else if (m.stages?.configuration?.status === 'completed') {
    issues.push('configuration stage is completed but config is null');
  }
  if (typeof m.stages !== 'object' || m.stages === null) {
    issues.push('stages is missing');
  } else {
    for (const s of STAGES) {
      const rec = (m.stages as Partial<StageMap>)[s];
      if (!rec) issues.push(`stage "${s}" is missing`);
      else if (!isStageStatus(rec.status)) issues.push(`stage "${s}" has invalid status ${JSON.stringify(rec.status)}`);
      else if (!Array.isArray(rec.artifacts)) issues.push(`stage "${s}" artifacts must be an array`);
      else if (rec.attempts !== undefined) issues.push(...validateAttempts(s, rec.attempts));
    }
    for (const k of Object.keys(m.stages)) {
      if (!(STAGES as readonly string[]).includes(k)) issues.push(`unknown stage "${k}"`);
    }
    if (issues.length === 0 && m.status !== deriveRunStatus(m.stages as StageMap)) {
      issues.push(`status "${m.status}" is inconsistent with stage statuses (expected "${deriveRunStatus(m.stages as StageMap)}")`);
    }
  }
  if (typeof m.artifacts !== 'object' || m.artifacts === null) {
    issues.push('artifacts is missing');
  } else {
    for (const [name, rel] of Object.entries(m.artifacts)) {
      const err = checkArtifactPath(runDirectory, rel);
      if (err) issues.push(`artifact "${name}": ${err}`);
    }
  }
  if (!m.healing || typeof m.healing.attemptsByTest !== 'object') issues.push('healing record is missing');
  return issues;
}

function validateAttempts(stage: string, v: unknown): string[] {
  if (!Array.isArray(v)) return [`stage "${stage}" attempts must be an array`];
  return v.flatMap((a: Partial<StageAttempt> | null, i) => {
    const at = `stage "${stage}" attempt ${i + 1}`;
    if (typeof a !== 'object' || a === null) return [`${at} must be an object`];
    const start = Date.parse(a.startedAt as string);
    const end = Date.parse(a.endedAt as string);
    if (Number.isNaN(start) || Number.isNaN(end)) return [`${at} has an invalid timestamp`];
    const issues: string[] = [];
    if (end < start) issues.push(`${at} ends before it starts`);
    if (!['completed', 'failed', 'blocked', 'cancelled'].includes(a.status as string)) issues.push(`${at} has invalid status ${JSON.stringify(a.status)}`);
    if (typeof a.interrupted !== 'boolean') issues.push(`${at} interrupted must be a boolean`);
    return issues;
  });
}

function refresh(m: RunManifest, now: string): RunManifest {
  const status = deriveRunStatus(m.stages);
  const anyRunning = STAGES.some((s) => m.stages[s].status === 'running');
  return {
    ...m,
    status,
    currentStage: nextStage(m.stages),
    endedAt: status !== 'in_progress' && !anyRunning ? now : null,
  };
}

export interface UpdateStageOptions {
  message?: string;
  artifacts?: Record<string, string>; // name -> path relative to run dir; must exist
  clock?: Clock;
}

export function updateStage(
  rootDir: string,
  runId: string,
  stage: StageName,
  to: StageStatus,
  opts: UpdateStageOptions = {},
): RunManifest {
  const now = (opts.clock ?? systemClock)().toISOString();
  const newArtifacts = opts.artifacts ?? {};
  for (const [name, rel] of Object.entries(newArtifacts)) {
    const err = checkArtifactPath(runDir(rootDir, runId), rel);
    if (err) throw new Error(`cannot register artifact "${name}": ${err}`);
  }

  return mutateManifest(rootDir, runId, (m) => {
    // Without this check the manifest would be saved in a state its own validator rejects, and every later command on the run fails.
    if (stage === 'configuration' && to === 'completed' && m.config === null) {
      throw new StageContractError('stage "configuration" cannot complete: no config is attached to the run; run "run set-config <runId>" while the stage is running');
    }
    if (to === 'completed') {
      const issues = checkStageOutputs(stage, {
        rootDir, runDir: runDir(rootDir, runId), manifest: m, artifacts: { ...m.artifacts, ...newArtifacts },
      });
      if (issues.length > 0) {
        throw new StageContractError(`stage "${stage}" cannot complete: ${issues.join('; ')}`);
      }
    }

    const stages = applyTransition(m.stages, stage, to, now, opts.message ?? null);
    const rel = Object.values(newArtifacts);
    stages[stage] = { ...stages[stage], artifacts: [...new Set([...stages[stage].artifacts, ...rel])] };

    return refresh(
      { ...m, stages, artifacts: { ...m.artifacts, ...newArtifacts }, startedAt: m.startedAt ?? (to === 'running' ? now : null) },
      now,
    );
  });
}

// Where a run stopped, derived from the manifest alone, so a new session can pick up without the old chat.
export interface Checkpoint {
  runId: string;
  command: Command;
  status: RunStatus;
  completedStages: StageName[]; // done in order, up to the first unfinished stage
  resumeStage: StageName | null;
  resumeStageStatus: StageStatus | null; // pending (not started), blocked or failed
  reason: string | null; // why the resume stage stopped (its recorded message)
  lastActivity: string; // ISO time of the most recent stage change
}

export function describeCheckpoint(m: RunManifest): Checkpoint {
  const resumeStage = nextStage(m.stages);
  const completedStages = STAGES.filter((s) => m.stages[s].status === 'completed');
  const times = STAGES.flatMap((s) => [m.stages[s].startedAt, m.stages[s].endedAt]).filter((t): t is string => t !== null);
  return {
    runId: m.runId,
    command: m.command,
    status: m.status,
    completedStages,
    resumeStage,
    resumeStageStatus: resumeStage ? m.stages[resumeStage].status : null,
    reason: resumeStage ? m.stages[resumeStage].message : null,
    lastActivity: [m.createdAt, ...times].sort().at(-1)!,
  };
}

export type ResumeResult =
  | { ok: true; manifest: RunManifest; recovered: StageName[]; next: StageName | null; checkpoint: Checkpoint }
  | { ok: false; issues: string[] };

// Validate a run before resuming: recover stages left `running` by an interrupted process.
export function prepareResume(rootDir: string, runId: string, clock: Clock = systemClock): ResumeResult {
  const loaded = loadManifest(rootDir, runId);
  if (!loaded.ok) return loaded;
  const now = clock().toISOString();
  const { manifest: m, result: recovered } = mutateManifestWith(rootDir, runId, (current) => {
    const r = recoverInterrupted(current.stages, now);
    return { manifest: r.recovered.length > 0 ? refresh({ ...current, stages: r.stages }, now) : current, result: r.recovered };
  });
  if (m.status === 'cancelled' || m.status === 'completed') {
    return { ok: false, issues: [`run ${runId} is ${m.status} and cannot be resumed`] };
  }
  return { ok: true, manifest: m, recovered, next: nextStage(m.stages), checkpoint: describeCheckpoint(m) };
}

// Resumable runs (in_progress, blocked or failed), newest first. Run ids start with an IST timestamp (a fixed offset),
// so id order is creation order. Ids made before 0.14.0 are UTC, which is 5h30m earlier, so they still sort before newer ones. Unreadable manifests are skipped here; `run show <id>` reports them.
export function listResumable(rootDir: string, command?: Command): Checkpoint[] {
  const found: Checkpoint[] = [];
  for (const id of listRuns(rootDir).reverse()) {
    const loaded = loadManifest(rootDir, id);
    if (!loaded.ok) continue;
    const m = loaded.manifest;
    if (m.status === 'cancelled' || m.status === 'completed') continue;
    if (command && m.command !== command) continue;
    found.push(describeCheckpoint(m));
  }
  return found;
}

// Resume the newest resumable run. `others` lists the remaining candidates so the caller can say so.
export function resumeLatest(
  rootDir: string,
  command?: Command,
  clock: Clock = systemClock,
): (Extract<ResumeResult, { ok: true }> & { others: Checkpoint[] }) | { ok: false; issues: string[] } {
  const [latest, ...others] = listResumable(rootDir, command);
  if (!latest) return { ok: false, issues: [`no resumable run found${command ? ` for /${command}` : ''}; start a new one`] };
  const r = prepareResume(rootDir, latest.runId, clock);
  return r.ok ? { ...r, others } : r;
}

export function setTestCounts(rootDir: string, runId: string, counts: TestCounts): RunManifest {
  const errors = validateTestCounts(counts);
  if (errors.length > 0) throw new Error(`invalid test counts: ${errors.join('; ')}`);
  return mutateManifest(rootDir, runId, (m) => ({ ...m, testCounts: counts }));
}

export function validateTestCounts(c: TestCounts): string[] {
  const keys: (keyof TestCounts)[] = ['total', 'passed', 'failed', 'flaky', 'healed', 'blocked', 'skipped', 'unresolved'];
  const errors = keys.filter((k) => !Number.isInteger(c[k]) || c[k] < 0).map((k) => `${k} must be a non-negative integer`);
  if (errors.length > 0) return errors;
  // Every test has exactly one final outcome; `unresolved` overlaps failed/blocked and is not summed.
  const sum = c.passed + c.failed + c.flaky + c.healed + c.blocked + c.skipped;
  if (sum !== c.total) errors.push(`passed+failed+flaky+healed+blocked+skipped (${sum}) must equal total (${c.total})`);
  if (c.unresolved > c.failed + c.blocked) errors.push('unresolved cannot exceed failed + blocked');
  return errors;
}

// Attach the resolved config to a run. Only allowed while the configuration stage is running,
// so a run never silently switches configuration mid-way.
export function setRunConfig(rootDir: string, runId: string, config: AutomationConfig): RunManifest {
  const valid = requireValidConfig(config);
  return mutateManifest(rootDir, runId, (m) => {
    if (m.stages.configuration.status !== 'running') {
      throw new Error(`config can only be set while the configuration stage is running (it is ${m.stages.configuration.status})`);
    }
    return { ...m, config: valid, healing: { ...m.healing, maxAttemptsPerTest: valid.healing.maxAttemptsPerTest } };
  });
}

export class HealingLimitError extends Error {}

// Reserve one healing attempt for a test. Throws once the per-test cap is reached.
export function recordHealingAttempt(rootDir: string, runId: string, testId: string): { attempt: number; remaining: number } {
  return mutateManifestWith(rootDir, runId, (m) => {
    const max = m.healing.maxAttemptsPerTest;
    if (max === null) throw new Error('healing limit is unknown: run has no configuration yet');
    const used = m.healing.attemptsByTest[testId] ?? 0;
    if (used >= max) {
      throw new HealingLimitError(`healing limit reached for ${testId} (${used}/${max}); report as unresolved`);
    }
    const attempt = used + 1;
    return {
      manifest: { ...m, healing: { ...m.healing, attemptsByTest: { ...m.healing.attemptsByTest, [testId]: attempt } } },
      result: { attempt, remaining: max - attempt },
    };
  }).result;
}

export function recordSetupChange(rootDir: string, runId: string, change: DependencyChange): RunManifest {
  return mutateManifest(rootDir, runId, (m) => ({ ...m, setupChanges: [...m.setupChanges, change] }));
}

// Retention: only when config.retention.keepRuns is set (an explicit user policy). Deletes the oldest
// run directories beyond the limit; never the current run and never a run still in progress.
export function pruneRuns(rootDir: string, keepRuns: number | null, currentRunId: string): string[] {
  if (keepRuns === null) return [];
  const runs = listRuns(rootDir).filter((id) => id !== currentRunId);
  const excess = runs.length + 1 - keepRuns;
  if (excess <= 0) return [];
  const deleted: string[] = [];
  for (const id of runs) {
    if (deleted.length >= excess) break;
    const loaded = loadManifest(rootDir, id);
    if (loaded.ok && loaded.manifest.status === 'in_progress') continue;
    rmSync(runDir(rootDir, id), { recursive: true, force: true });
    // The run's Playwright output lives in the framework folders; retention covers it too.
    rmSync(path.join(rootDir, REPORTS_DIR, id), { recursive: true, force: true });
    rmSync(path.join(rootDir, EVIDENCE_DIR, id), { recursive: true, force: true });
    deleted.push(id);
  }
  return deleted;
}

export function listRuns(rootDir: string): string[] {
  try {
    return readdirSync(runsDir(rootDir)).filter((d) => RUN_ID_PATTERN.test(d)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

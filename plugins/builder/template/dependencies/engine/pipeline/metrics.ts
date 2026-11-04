// Run metrics, derived on demand from the manifest (stage attempts) and the artifacts on disk.
// Nothing is recorded during the run beyond the stage attempts the state machine already keeps,
// so collecting metrics adds no work to normal runs. Only things the pipeline can actually observe are
// reported; the rest are listed in `notCaptured` instead of being guessed.

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { readAgentUsage, summarizeUsage, type AgentMetrics } from './agent-planner.ts';
import { readLedger, summarizeLedger } from './artifact-cache.ts';
import { ARTIFACTS, EVIDENCE_DIR, REPORTS_DIR, runDir } from './artifact-manager.ts';
import type { ExecutionResults } from './execution.ts';
import type { ExplorationRecord } from './exploration.ts';
import { listRuns, loadManifest, type RunManifest } from './run-manager.ts';
import { STAGES, type StageName, type StageStatus } from './state-manager.ts';

export const METRICS_SCHEMA_VERSION = 1;

export interface StageMetric {
  stage: StageName;
  status: StageStatus;
  // Times the stage was started. >1 means it was retried or resumed.
  attempts: number;
  // Attempts that ended because the process died (recovered on resume), not by an explicit failure.
  interruptedAttempts: number;
  // Sum over all attempts, so a retried stage keeps the time of its earlier attempts. null = never started.
  durationMs: number | null;
  lastAttemptMs: number | null;
  inProgress: boolean; // currently running: durationMs includes time elapsed so far
  startedAt: string | null;
  endedAt: string | null;
  artifactCount: number;
  artifactBytes: number;
  message: string | null;
}

export interface ExecutionMetric {
  label: string;
  tests: number;
  retriedTests: number; // tests that needed more than one attempt
  retryAttempts: number; // total extra attempts across tests
  testTimeMs: number; // summed attempt durations as reported by Playwright (not wall clock)
  workers: number | null; // workers the run used (null for results written before the execution plan was recorded)
  isolation: string | null;
  authState: string | null; // reuse | refresh, and recovered when a rejected session was replaced
}

export interface ExplorationMetric {
  pages: number; // pages in the final record
  pagesFresh: number; // observed in this run
  pagesReused: number; // carried over from the observation store and revalidated in this run
  elementsReused: number;
  specs: number;
  specsReused: number;
  specsFresh: number;
}

export interface RunMetrics {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  runId: string;
  command: string;
  runStatus: string;
  generatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  wallClockMs: number | null;
  stageTimeMs: number; // sum of stage durations
  // wall clock not spent inside a stage: gaps between stages (orchestration, waiting on the user, resumes)
  betweenStagesMs: number | null;
  stages: StageMetric[];
  slowest: { stage: StageName; durationMs: number; shareOfStageTime: number }[];
  execution: ExecutionMetric[];
  exploration: ExplorationMetric | null; // null when the run has no exploration record
  // Reuse/rebuild decisions with reasons; null when the run made none (e.g. a run-tests run).
  cache: ReturnType<typeof summarizeLedger> | null;
  // Agent calls, and the stages that ran deterministically instead; null when no stage was planned.
  agents: AgentMetrics | null;
  healingAttempts: number;
  reportGenerationMs: number | null;
  artifacts: { files: number; bytes: number; reportsBytes: number; evidenceBytes: number };
  testCounts: RunManifest['testCounts'];
  notCaptured: string[];
}

// Things the plan asks for that the pipeline cannot observe. Listed so a baseline is not misread. Agent calls and cache
// decisions are reported by the CLI itself (agents.json, cache-decisions.json); tokens only when the orchestrator passes them.
function notCaptured(cache: unknown, agents: AgentMetrics | null): string[] {
  const out = ['browserActions'];
  if (!cache) out.push('artifactCacheHitsAndMisses');
  if (!agents) out.push('agentInvocations');
  if (!agents || agents.inputTokens === null) out.push('tokenUsage');
  return out;
}

function ms(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

function pathSize(abs: string): { files: number; bytes: number } {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { files: 0, bytes: 0 };
  }
  if (st.isFile()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const d of readdirSync(abs, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    files++;
    bytes += statSync(path.join(d.parentPath, d.name)).size;
  }
  return { files, bytes };
}

function stageMetric(name: StageName, rec: RunManifest['stages'][StageName], dir: string, now: string): StageMetric {
  const attempts = rec.attempts ?? [];
  const running = rec.status === 'running' && rec.startedAt !== null;
  let spans = attempts.map((a) => ms(a.startedAt, a.endedAt));
  let count = attempts.length;
  // Manifests written before attempts existed: fall back to the single recorded span.
  if (count === 0 && !running && rec.startedAt && rec.endedAt && rec.status !== 'skipped') {
    spans = [ms(rec.startedAt, rec.endedAt)];
    count = 1;
  }
  if (running) {
    spans = [...spans, ms(rec.startedAt!, now)];
    count += 1;
  }
  let artifactCount = 0;
  let artifactBytes = 0;
  for (const rel of rec.artifacts) {
    const size = pathSize(path.join(dir, rel));
    artifactCount += size.files;
    artifactBytes += size.bytes;
  }
  return {
    stage: name,
    status: rec.status,
    attempts: count,
    interruptedAttempts: attempts.filter((a) => a.interrupted).length,
    durationMs: spans.length > 0 ? spans.reduce((a, b) => a + b, 0) : null,
    lastAttemptMs: spans.length > 0 ? spans[spans.length - 1]! : null,
    inProgress: running,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    artifactCount,
    artifactBytes,
    message: rec.message,
  };
}

function executionMetric(dir: string, rel: string | undefined, label: string): ExecutionMetric | null {
  if (!rel) return null;
  const r = readJson(path.join(dir, rel));
  if (!r.ok) return null;
  const results = r.value as Partial<ExecutionResults>;
  if (!Array.isArray(results.tests)) return null;
  let retriedTests = 0;
  let retryAttempts = 0;
  let testTimeMs = 0;
  for (const t of results.tests) {
    const attempts = Array.isArray(t.attempts) ? t.attempts : [];
    if (attempts.length > 1) retriedTests++;
    retryAttempts += Math.max(0, attempts.length - 1);
    testTimeMs += attempts.reduce((sum, a) => sum + (typeof a.durationMs === 'number' ? a.durationMs : 0), 0);
  }
  const auth = results.authState ? `${results.authState.decision}${results.authState.recovered ? ' (recovered)' : ''}` : null;
  return {
    label: results.label ?? label, tests: results.tests.length, retriedTests, retryAttempts, testTimeMs,
    workers: results.executionPlan?.workers ?? null, isolation: results.executionPlan?.isolation ?? null, authState: auth,
  };
}

function explorationMetric(dir: string, rel: string | undefined): ExplorationMetric | null {
  if (!rel) return null;
  const r = readJson(path.join(dir, rel));
  if (!r.ok) return null;
  const rec = r.value as Partial<ExplorationRecord>;
  if (!Array.isArray(rec.pages) || !Array.isArray(rec.specs)) return null;
  const reused = rec.pages.filter((p) => p.provenance?.source === 'reused');
  // Records written without the reuse flow have no `reuse` block: everything in them was observed fresh.
  const specsReused = rec.reuse?.reusedSpecs.length ?? 0;
  return {
    pages: rec.pages.length,
    pagesFresh: rec.pages.length - reused.length,
    pagesReused: reused.length,
    elementsReused: reused.reduce((n, p) => n + (p.elements?.length ?? 0), 0),
    specs: rec.specs.length,
    specsReused,
    specsFresh: rec.specs.length - specsReused,
  };
}

export function buildRunMetrics(rootDir: string, manifest: RunManifest, now: Date = new Date()): RunMetrics {
  const dir = runDir(rootDir, manifest.runId);
  const nowIso = now.toISOString();
  const stages = STAGES.map((s) => stageMetric(s, manifest.stages[s], dir, nowIso));
  const stageTimeMs = stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const wallClockMs = manifest.startedAt ? ms(manifest.startedAt, manifest.endedAt ?? nowIso) : null;

  const timed = stages.filter((s) => s.durationMs !== null && s.durationMs > 0);
  const slowest = [...timed]
    .sort((a, b) => b.durationMs! - a.durationMs!)
    .slice(0, 3)
    .map((s) => ({ stage: s.stage, durationMs: s.durationMs!, shareOfStageTime: stageTimeMs > 0 ? round(s.durationMs! / stageTimeMs) : 0 }));

  const execution = [
    executionMetric(dir, manifest.artifacts.executionResults, 'initial'),
    executionMetric(dir, manifest.artifacts.regressionResults, 'regression'),
  ].filter((e): e is ExecutionMetric => e !== null);

  const total = pathSize(dir);
  const ledger = readLedger(dir);
  const cache = ledger.decisions.length > 0 ? summarizeLedger(ledger) : null;
  const usage = readAgentUsage(dir);
  const agents = usage.invocations.length > 0 || Object.keys(usage.decisions).length > 0 ? summarizeUsage(usage) : null;
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    runId: manifest.runId,
    command: manifest.command,
    runStatus: manifest.status,
    generatedAt: nowIso,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    wallClockMs,
    stageTimeMs,
    betweenStagesMs: wallClockMs === null ? null : Math.max(0, wallClockMs - stageTimeMs),
    stages,
    slowest,
    execution,
    exploration: explorationMetric(dir, manifest.artifacts.exploration),
    cache,
    agents,
    healingAttempts: Object.values(manifest.healing.attemptsByTest).reduce((a, b) => a + b, 0),
    reportGenerationMs: stages.find((s) => s.stage === 'report_generation')?.durationMs ?? null,
    artifacts: {
      files: total.files,
      bytes: total.bytes,
      // Playwright's own output lives in the framework folders, scoped per run.
      reportsBytes: pathSize(path.join(rootDir, REPORTS_DIR, manifest.runId)).bytes,
      evidenceBytes: pathSize(path.join(rootDir, EVIDENCE_DIR, manifest.runId)).bytes,
    },
    testCounts: manifest.testCounts,
    notCaptured: notCaptured(cache, agents),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Derived file, never an input to any decision: regenerate rather than trust an old copy.
export function writeRunMetrics(rootDir: string, manifest: RunManifest, now: Date = new Date()): { metrics: RunMetrics; file: string } {
  const metrics = buildRunMetrics(rootDir, manifest, now);
  const abs = path.join(runDir(rootDir, manifest.runId), ARTIFACTS.metrics);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeJsonAtomic(abs, metrics);
  return { metrics, file: ARTIFACTS.metrics };
}

// ---- baseline across runs ----

export interface StageBaseline {
  stage: StageName;
  runs: number; // runs where this stage completed, i.e. durations that are comparable
  medianMs: number;
  maxMs: number;
  totalMs: number;
  retriedRuns: number; // runs where the stage needed more than one attempt
  interruptedRuns: number;
}

export interface Baseline {
  schemaVersion: typeof METRICS_SCHEMA_VERSION;
  generatedAt: string;
  runs: { runId: string; command: string; status: string; wallClockMs: number | null }[];
  skippedRuns: { runId: string; reason: string }[];
  stages: StageBaseline[]; // slowest median first
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

// Aggregates stage durations over runs. Only completed stages feed the timings, so failed or interrupted
// attempts cannot make a stage look faster than it is; they are counted separately.
export function buildBaseline(rootDir: string, runIds?: string[], now: Date = new Date()): Baseline {
  const ids = runIds && runIds.length > 0 ? runIds : listRuns(rootDir);
  const runs: Baseline['runs'] = [];
  const skippedRuns: Baseline['skippedRuns'] = [];
  const durations = new Map<StageName, number[]>();
  const retried = new Map<StageName, number>();
  const interrupted = new Map<StageName, number>();

  for (const id of ids) {
    const loaded = loadManifest(rootDir, id);
    if (!loaded.ok) {
      skippedRuns.push({ runId: id, reason: loaded.issues.join('; ') });
      continue;
    }
    const m = buildRunMetrics(rootDir, loaded.manifest, now);
    runs.push({ runId: id, command: m.command, status: m.runStatus, wallClockMs: m.wallClockMs });
    for (const s of m.stages) {
      if (s.attempts > 1) retried.set(s.stage, (retried.get(s.stage) ?? 0) + 1);
      if (s.interruptedAttempts > 0) interrupted.set(s.stage, (interrupted.get(s.stage) ?? 0) + 1);
      if (s.status === 'completed' && s.lastAttemptMs !== null) {
        durations.set(s.stage, [...(durations.get(s.stage) ?? []), s.lastAttemptMs]);
      }
    }
  }

  const stages = STAGES.filter((s) => durations.has(s))
    .map((s): StageBaseline => {
      const d = durations.get(s)!;
      return {
        stage: s,
        runs: d.length,
        medianMs: median(d),
        maxMs: Math.max(...d),
        totalMs: d.reduce((a, b) => a + b, 0),
        retriedRuns: retried.get(s) ?? 0,
        interruptedRuns: interrupted.get(s) ?? 0,
      };
    })
    .sort((a, b) => b.medianMs - a.medianMs);

  return { schemaVersion: METRICS_SCHEMA_VERSION, generatedAt: now.toISOString(), runs, skippedRuns, stages };
}

// ---- comparing two runs ----

export interface RunComparison {
  baseline: { runId: string; command: string; wallClockMs: number | null; stageTimeMs: number; workers: number | null };
  candidate: { runId: string; command: string; wallClockMs: number | null; stageTimeMs: number; workers: number | null };
  correctness: {
    comparable: boolean;
    problems: string[]; // why the numbers cannot be read as a speed-up
    missingTests: string[]; // ran in the baseline, absent now
    addedTests: string[];
    worse: { key: string; from: string; to: string }[];
    better: { key: string; from: string; to: string }[];
  };
  stages: { stage: StageName; baselineMs: number | null; candidateMs: number | null; deltaMs: number | null; deltaPercent: number | null }[];
  totals: { stageTimeDeltaMs: number; stageTimeDeltaPercent: number | null; executionDeltaMs: number | null };
  verdict: 'faster' | 'slower' | 'similar' | 'incorrect' | 'not_comparable';
  summary: string;
}

// Rank used to tell a regression from an improvement.
const OUTCOME_RANK: Record<string, number> = { passed: 3, healed: 2, flaky: 1, skipped: 0, blocked: 0, failed: 0 };
const SIMILAR_WITHIN = 0.1;

// Final outcome per test: the run summary when it exists (healed, blocked), else the raw execution results.
function outcomesOf(rootDir: string, manifest: RunManifest): Map<string, string> | null {
  const dir = runDir(rootDir, manifest.runId);
  const summary = readJson(path.join(dir, ARTIFACTS.summary));
  if (summary.ok) {
    const tests = (summary.value as { tests?: { key: string; outcome: string }[] }).tests;
    if (Array.isArray(tests)) return new Map(tests.map((t) => [t.key, t.outcome]));
  }
  const rel = manifest.artifacts.executionResults;
  const exec = rel ? readJson(path.join(dir, rel)) : null;
  const tests = exec?.ok ? (exec.value as Partial<ExecutionResults>).tests : undefined;
  return Array.isArray(tests) ? new Map(tests.map((t) => [t.key, t.outcome])) : null;
}

// A faster run is only an improvement if it ran the same tests and none got worse. Anything else is reported as such,
// whatever the stopwatch says.
export function compareRuns(rootDir: string, baselineId: string, candidateId: string, now: Date = new Date()): RunComparison {
  const load = (id: string) => {
    const m = loadManifest(rootDir, id);
    if (!m.ok) throw new Error(`run ${id} is invalid: ${m.issues.join('; ')}`);
    return { manifest: m.manifest, metrics: buildRunMetrics(rootDir, m.manifest, now) };
  };
  const a = load(baselineId);
  const b = load(candidateId);
  const info = (x: ReturnType<typeof load>) => ({
    runId: x.manifest.runId, command: x.manifest.command, wallClockMs: x.metrics.wallClockMs, stageTimeMs: x.metrics.stageTimeMs,
    workers: x.metrics.execution[0]?.workers ?? null,
  });

  const problems: string[] = [];
  if (a.manifest.command !== b.manifest.command) problems.push(`different commands (/${a.manifest.command} vs /${b.manifest.command})`);
  for (const x of [a, b]) {
    if (x.manifest.status !== 'completed') problems.push(`run ${x.manifest.runId} is ${x.manifest.status}, not completed`);
  }
  const before = outcomesOf(rootDir, a.manifest);
  const after = outcomesOf(rootDir, b.manifest);
  if (!before || !after) problems.push('test outcomes are missing for one of the runs');

  const missingTests: string[] = [];
  const addedTests: string[] = [];
  const worse: RunComparison['correctness']['worse'] = [];
  const better: RunComparison['correctness']['better'] = [];
  if (before && after) {
    for (const [key, from] of before) {
      const to = after.get(key);
      if (to === undefined) { missingTests.push(key); continue; }
      const delta = (OUTCOME_RANK[to] ?? 0) - (OUTCOME_RANK[from] ?? 0);
      if (delta < 0) worse.push({ key, from, to });
      else if (delta > 0) better.push({ key, from, to });
    }
    for (const key of after.keys()) if (!before.has(key)) addedTests.push(key);
  }

  const stages = STAGES.map((stage) => {
    const x = a.metrics.stages.find((s) => s.stage === stage)!.durationMs;
    const y = b.metrics.stages.find((s) => s.stage === stage)!.durationMs;
    const deltaMs = x !== null && y !== null ? y - x : null;
    return { stage, baselineMs: x, candidateMs: y, deltaMs, deltaPercent: deltaMs !== null && x ? round(deltaMs / x) : null };
  });
  const stageDelta = b.metrics.stageTimeMs - a.metrics.stageTimeMs;
  const execA = a.metrics.stages.find((s) => s.stage === 'execution')!.durationMs;
  const execB = b.metrics.stages.find((s) => s.stage === 'execution')!.durationMs;
  const totals = {
    stageTimeDeltaMs: stageDelta,
    stageTimeDeltaPercent: a.metrics.stageTimeMs > 0 ? round(stageDelta / a.metrics.stageTimeMs) : null,
    executionDeltaMs: execA !== null && execB !== null ? execB - execA : null,
  };

  const incorrect = missingTests.length > 0 || worse.length > 0;
  let verdict: RunComparison['verdict'];
  let summary: string;
  if (incorrect) {
    verdict = 'incorrect';
    summary = `not an improvement: ${missingTests.length} test(s) no longer ran and ${worse.length} got worse, whatever the timing`;
  } else if (problems.length > 0) {
    verdict = 'not_comparable';
    summary = `cannot be compared: ${problems.join('; ')}`;
  } else if (totals.stageTimeDeltaPercent === null || Math.abs(totals.stageTimeDeltaPercent) <= SIMILAR_WITHIN) {
    verdict = 'similar';
    summary = `same tests, same outcomes, stage time within ${SIMILAR_WITHIN * 100}%`;
  } else {
    verdict = totals.stageTimeDeltaPercent < 0 ? 'faster' : 'slower';
    summary = `same tests, no outcome got worse; stage time ${totals.stageTimeDeltaPercent < 0 ? 'down' : 'up'} ${Math.abs(Math.round(totals.stageTimeDeltaPercent * 100))}%`;
  }
  if (better.length > 0 && verdict !== 'incorrect') summary += `; ${better.length} test(s) have a better outcome (check whether that is flakiness rather than the change)`;
  return {
    baseline: info(a), candidate: info(b),
    correctness: { comparable: problems.length === 0, problems, missingTests, addedTests, worse, better },
    stages, totals, verdict, summary,
  };
}

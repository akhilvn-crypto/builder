import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stageCommand } from '../engine/cli/stage-commands.ts';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import { buildBaseline, buildRunMetrics, writeRunMetrics } from '../engine/pipeline/metrics.ts';
import { createRun, loadManifest, manifestPath, prepareResume, updateStage, type RunManifest } from '../engine/pipeline/run-manager.ts';
import { applyTransition, initialStages, recoverInterrupted } from '../engine/pipeline/state-manager.ts';
import { tmpRoot, validConfig } from './helpers.ts';

const T0 = Date.parse('2026-10-19T08:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();

function load(root: string, runId: string): RunManifest {
  const r = loadManifest(root, runId);
  assert.ok(r.ok, JSON.stringify(r));
  return r.manifest;
}

test('each start->end span is kept as an attempt, so a retried stage keeps earlier durations', () => {
  let s = initialStages('run-tests');
  s = applyTransition(s, 'preflight', 'running', iso(0));
  s = applyTransition(s, 'preflight', 'failed', iso(4), 'node too old');
  s = applyTransition(s, 'preflight', 'running', iso(10));
  s = applyTransition(s, 'preflight', 'completed', iso(13));
  assert.deepEqual(s.preflight.attempts?.map((a) => [a.status, a.interrupted]), [['failed', false], ['completed', false]]);
  assert.equal(s.preflight.startedAt, iso(10), 'startedAt still describes the latest attempt');
});

test('pending transitions (skip/block before start) create no attempt', () => {
  let s = initialStages('run-tests');
  s = applyTransition(s, 'preflight', 'blocked', iso(1));
  assert.equal(s.preflight.attempts, undefined);
});

test('an interrupted attempt is distinguishable from an explicit failure', () => {
  let s = initialStages('run-tests');
  s = applyTransition(s, 'preflight', 'running', iso(0));
  s = applyTransition(s, 'preflight', 'failed', iso(2), 'runner crashed');
  s = applyTransition(s, 'preflight', 'running', iso(5));
  const r = recoverInterrupted(s, iso(9));
  const [explicit, interrupted] = r.stages.preflight.attempts!;
  assert.equal(explicit!.interrupted, false);
  assert.equal(explicit!.status, 'failed');
  assert.equal(interrupted!.interrupted, true);
  assert.equal(interrupted!.status, 'failed');
});

test('metrics report per-stage duration, final status and attempt counts', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests', clock: () => at(0) });
  updateStage(root, runId, 'preflight', 'running', { clock: () => at(0) });
  updateStage(root, runId, 'preflight', 'failed', { clock: () => at(3), message: 'boom' });
  updateStage(root, runId, 'preflight', 'running', { clock: () => at(10) });
  updateStage(root, runId, 'preflight', 'completed', { clock: () => at(17) });
  updateStage(root, runId, 'configuration', 'running', { clock: () => at(20) });

  const m = buildRunMetrics(root, load(root, runId), at(25));
  const pre = m.stages.find((s) => s.stage === 'preflight')!;
  assert.equal(pre.status, 'completed');
  assert.equal(pre.attempts, 2);
  assert.equal(pre.durationMs, 10_000, '3s failed attempt + 7s successful attempt');
  assert.equal(pre.lastAttemptMs, 7000);
  assert.equal(pre.interruptedAttempts, 0);

  const cfg = m.stages.find((s) => s.stage === 'configuration')!;
  assert.equal(cfg.inProgress, true);
  assert.equal(cfg.durationMs, 5000, 'elapsed so far');

  const skipped = m.stages.find((s) => s.stage === 'test_generation')!;
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.durationMs, null);

  assert.equal(m.stages.length, 13, 'every stage is listed');
  assert.equal(m.wallClockMs, 25_000);
  assert.equal(m.stageTimeMs, 15_000);
  assert.equal(m.betweenStagesMs, 10_000);
  assert.deepEqual(m.slowest.map((s) => s.stage), ['preflight', 'configuration']);
  assert.ok(m.notCaptured.includes('tokenUsage'), 'uncaptured metrics are named, not invented');
});

test('resumed interruptions show up in metrics and keep the run failed', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests', clock: () => at(0) });
  updateStage(root, runId, 'preflight', 'running', { clock: () => at(0) });
  const resumed = prepareResume(root, runId, () => at(8));
  assert.ok(resumed.ok);
  const m = buildRunMetrics(root, load(root, runId), at(9));
  const pre = m.stages.find((s) => s.stage === 'preflight')!;
  assert.equal(m.runStatus, 'failed');
  assert.equal(pre.interruptedAttempts, 1);
  assert.equal(pre.durationMs, 8000);
});

test('artifact count and size are summed per stage and for the run', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  writeFileSync(path.join(runDir(root, runId), 'preflight.json'), '12345');
  updateStage(root, runId, 'preflight', 'running');
  updateStage(root, runId, 'preflight', 'completed', { artifacts: { preflight: 'preflight.json' } });
  const m = buildRunMetrics(root, load(root, runId));
  const pre = m.stages.find((s) => s.stage === 'preflight')!;
  assert.equal(pre.artifactCount, 1);
  assert.equal(pre.artifactBytes, 5);
  assert.ok(m.artifacts.files >= 2 && m.artifacts.bytes > 5, 'run totals include the manifest');
});

test('manifests written before attempts existed still load and report a duration', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests', clock: () => at(0) });
  updateStage(root, runId, 'preflight', 'running', { clock: () => at(0) });
  updateStage(root, runId, 'preflight', 'completed', { clock: () => at(6) });
  const raw = JSON.parse(readFileSync(manifestPath(root, runId), 'utf8'));
  delete raw.stages.preflight.attempts;
  writeFileSync(manifestPath(root, runId), JSON.stringify(raw));
  const pre = buildRunMetrics(root, load(root, runId), at(7)).stages.find((s) => s.stage === 'preflight')!;
  assert.equal(pre.durationMs, 6000);
  assert.equal(pre.attempts, 1);
});

test('a manifest with malformed attempts is refused', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  const raw = JSON.parse(readFileSync(manifestPath(root, runId), 'utf8'));
  raw.stages.preflight.attempts = [{ startedAt: iso(5), endedAt: iso(1), status: 'completed', interrupted: false, message: null }];
  writeFileSync(manifestPath(root, runId), JSON.stringify(raw));
  const r = loadManifest(root, runId);
  assert.ok(!r.ok && r.issues.some((i) => /ends before it starts/.test(i)));
});

test('baseline ranks stages by median completed duration and ignores failed attempts', (t) => {
  const root = tmpRoot(t);
  const durations = [{ pre: 2, cfg: 10 }, { pre: 4, cfg: 30 }, { pre: 3, cfg: 20 }];
  const ids = durations.map(({ pre, cfg }) => {
    const { runId } = createRun(root, { command: 'run-tests', config: validConfig(), clock: () => at(0) });
    updateStage(root, runId, 'preflight', 'running', { clock: () => at(0) });
    updateStage(root, runId, 'preflight', 'completed', { clock: () => at(pre) });
    updateStage(root, runId, 'configuration', 'running', { clock: () => at(pre) });
    updateStage(root, runId, 'configuration', 'completed', { clock: () => at(pre + cfg) });
    return runId;
  });
  // A failed-then-retried stage: only the successful attempt (1s) counts toward the timing.
  const retry = createRun(root, { command: 'run-tests', clock: () => at(0) }).runId;
  updateStage(root, retry, 'preflight', 'running', { clock: () => at(0) });
  updateStage(root, retry, 'preflight', 'failed', { clock: () => at(50) });
  updateStage(root, retry, 'preflight', 'running', { clock: () => at(60) });
  updateStage(root, retry, 'preflight', 'completed', { clock: () => at(61) });

  const b = buildBaseline(root, [...ids, retry], at(100));
  assert.equal(b.stages[0]!.stage, 'configuration', 'slowest median first');
  assert.equal(b.stages[0]!.medianMs, 20_000);
  assert.equal(b.stages[0]!.maxMs, 30_000);
  const pre = b.stages.find((s) => s.stage === 'preflight')!;
  assert.equal(pre.runs, 4);
  assert.equal(pre.maxMs, 4000, 'the 50s failed attempt is not a completed duration');
  assert.equal(pre.retriedRuns, 1);
});

test('baseline reports unreadable runs instead of failing or trusting them', (t) => {
  const root = tmpRoot(t);
  const good = createRun(root, { command: 'run-tests' }).runId;
  const bad = createRun(root, { command: 'run-tests' }).runId;
  writeFileSync(manifestPath(root, bad), '{ truncated');
  const b = buildBaseline(root);
  assert.deepEqual(b.runs.map((r) => r.runId), [good]);
  assert.deepEqual(b.skippedRuns.map((r) => r.runId), [bad]);
});

test('execution metrics count retries from normalized results', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'run-tests' });
  const results = {
    label: 'initial',
    tests: [
      { attempts: [{ durationMs: 100 }] },
      { attempts: [{ durationMs: 200 }, { durationMs: 300 }] },
    ],
  };
  writeFileSync(path.join(runDir(root, runId), 'execution-results.json'), JSON.stringify(results));
  const manifest = { ...load(root, runId), artifacts: { executionResults: 'execution-results.json' } };
  const [e] = buildRunMetrics(root, manifest).execution;
  assert.deepEqual(e, { label: 'initial', tests: 2, retriedTests: 1, retryAttempts: 1, testTimeMs: 600, workers: null, isolation: null, authState: null });
});

test('writeRunMetrics writes metrics.json into the run directory', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'generate-tests' });
  const written = writeRunMetrics(root, load(root, runId));
  assert.equal(written.file, 'metrics.json');
  const onDisk = JSON.parse(readFileSync(path.join(runDir(root, runId), written.file), 'utf8'));
  assert.equal(onDisk.runId, runId);
  assert.equal(onDisk.schemaVersion, 1);
});

test('run finalize writes metrics and never lets a metrics failure block finalization', (t) => {
  const root = tmpRoot(t);
  const { runId } = createRun(root, { command: 'generate-tests' });
  const r = stageCommand(root, 'run', 'finalize', [runId], {});
  assert.equal(r.code, 0);
  assert.equal((r.value as { metrics: { file: string } }).metrics.file, 'metrics.json');
});

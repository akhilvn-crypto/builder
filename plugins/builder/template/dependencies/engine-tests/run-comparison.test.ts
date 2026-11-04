// Priority 6 measurement: "a faster run is not an improvement if it misses tests, trusts stale artifacts, suppresses
// failures, or weakens assertions". compareRuns checks correctness first and only then reads the stopwatch.

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stageCommand } from '../engine/cli/stage-commands.ts';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import { compareRuns } from '../engine/pipeline/metrics.ts';
import { createRun, saveManifest } from '../engine/pipeline/run-manager.ts';
import { STAGES } from '../engine/pipeline/state-manager.ts';
import { tmpRoot, validConfig } from './helpers.ts';

const T0 = Date.parse('2026-10-19T08:00:00.000Z');
let counter = 0;

// A run that finished: every stage of /run-tests took `seconds[stage]` seconds, and the summary lists the given outcomes.
function finishedRun(root: string, outcomes: Record<string, string>, seconds: { execution: number; other?: number }, opts: { status?: 'completed' | 'failed'; workers?: number } = {}) {
  const clock = () => new Date(T0 + counter++ * 1000);
  const m = createRun(root, { command: 'run-tests', clock, config: validConfig() });
  let t = T0 + counter * 1000;
  const stages = { ...m.stages };
  for (const s of STAGES) {
    if (stages[s].status === 'skipped') continue;
    const d = (s === 'execution' ? seconds.execution : seconds.other ?? 1) * 1000;
    const startedAt = new Date(t).toISOString();
    const endedAt = new Date(t + d).toISOString();
    t += d;
    stages[s] = { ...stages[s], status: 'completed', startedAt, endedAt, attempts: [{ startedAt, endedAt, status: 'completed', interrupted: false, message: null }] };
  }
  if (opts.status === 'failed') stages.execution = { ...stages.execution, status: 'failed' };
  const manifest = {
    ...m, stages, status: opts.status ?? 'completed', startedAt: new Date(T0).toISOString(), endedAt: new Date(t).toISOString(),
    artifacts: { executionResults: 'execution-results.json' },
  };
  const dir = runDir(root, m.runId);
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ tests: Object.entries(outcomes).map(([key, outcome]) => ({ key, outcome })) }));
  writeFileSync(path.join(dir, 'execution-results.json'), JSON.stringify({ label: 'initial', tests: [], executionPlan: { workers: opts.workers ?? 1, isolation: 'shared-readonly' } }));
  saveManifest(root, manifest);
  return m.runId;
}

const SUITE = { 'TC-1@chromium': 'passed', 'TC-2@chromium': 'passed', 'TC-3@chromium': 'failed' };

test('the same tests with the same outcomes in less time is faster', (t) => {
  const root = tmpRoot(t);
  const base = finishedRun(root, SUITE, { execution: 100 }, { workers: 1 });
  const cand = finishedRun(root, SUITE, { execution: 40 }, { workers: 3 });
  const c = compareRuns(root, base, cand);
  assert.equal(c.verdict, 'faster');
  assert.deepEqual([c.baseline.workers, c.candidate.workers], [1, 3]);
  assert.equal(c.totals.executionDeltaMs, -60_000);
  assert.equal(c.stages.find((s) => s.stage === 'execution')!.deltaMs, -60_000);
  assert.match(c.summary, /same tests, no outcome got worse; stage time down/);
  assert.equal(c.correctness.comparable, true);
});

test('a faster run that skipped a test, or made one worse, is not an improvement', (t) => {
  const root = tmpRoot(t);
  const base = finishedRun(root, SUITE, { execution: 100 });

  const dropped = finishedRun(root, { 'TC-1@chromium': 'passed', 'TC-3@chromium': 'failed' }, { execution: 10 });
  const d = compareRuns(root, base, dropped);
  assert.deepEqual([d.verdict, d.correctness.missingTests], ['incorrect', ['TC-2@chromium']]);

  const collided = finishedRun(root, { ...SUITE, 'TC-2@chromium': 'failed' }, { execution: 10 });
  const w = compareRuns(root, base, collided);
  assert.deepEqual([w.verdict, w.correctness.worse], ['incorrect', [{ key: 'TC-2@chromium', from: 'passed', to: 'failed' }]]);

  const flaky = finishedRun(root, { ...SUITE, 'TC-1@chromium': 'flaky' }, { execution: 10 });
  assert.equal(compareRuns(root, base, flaky).verdict, 'incorrect', 'passed -> flaky is a loss of reliability');

  const hiding = finishedRun(root, { ...SUITE, 'TC-3@chromium': 'passed' }, { execution: 10 });
  const h = compareRuns(root, base, hiding);
  assert.equal(h.verdict, 'faster');
  assert.match(h.summary, /1 test\(s\) have a better outcome \(check whether that is flakiness/);
});

test('similar timings, slower runs, unfinished runs and different commands are reported as what they are', (t) => {
  const root = tmpRoot(t);
  const base = finishedRun(root, SUITE, { execution: 100 });
  assert.equal(compareRuns(root, base, finishedRun(root, SUITE, { execution: 103 })).verdict, 'similar');
  assert.equal(compareRuns(root, base, finishedRun(root, SUITE, { execution: 180 })).verdict, 'slower');

  const failed = compareRuns(root, base, finishedRun(root, SUITE, { execution: 10 }, { status: 'failed' }));
  assert.equal(failed.verdict, 'not_comparable');
  assert.match(failed.summary, /is failed, not completed/);
  assert.equal(failed.correctness.comparable, false);

  assert.throws(() => compareRuns(root, base, '20260101-000000-abcdef'), /is invalid/);
});

test('CLI handler: run compare returns the same structured verdict', (t) => {
  const root = tmpRoot(t);
  const a = finishedRun(root, SUITE, { execution: 100 });
  const b = finishedRun(root, SUITE, { execution: 20 });
  const r = stageCommand(root, 'run', 'compare', [a, b], {});
  assert.equal(r.code, 0);
  assert.equal((r.value as { verdict: string }).verdict, 'faster');
});

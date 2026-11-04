import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STAGES, TransitionError, applyTransition, deriveRunStatus, initialStages, nextStage, recoverInterrupted,
  type StageMap,
} from '../engine/pipeline/state-manager.ts';

const NOW = '2026-10-19T08:00:00.000Z';

function advance(stages: StageMap, count: number): StageMap {
  let s = stages;
  for (const name of STAGES.slice(0, count)) {
    if (s[name].status !== 'pending') continue;
    s = applyTransition(s, name, 'running', NOW);
    s = applyTransition(s, name, 'completed', NOW);
  }
  return s;
}

test('full pipeline starts with all stages pending', () => {
  const s = initialStages('playwright-pipeline');
  assert.ok(STAGES.every((n) => s[n].status === 'pending'));
  assert.equal(deriveRunStatus(s), 'in_progress');
  assert.equal(nextStage(s), 'preflight');
});

test('focused commands skip out-of-scope stages explicitly', () => {
  const s = initialStages('run-tests');
  assert.equal(s.test_generation.status, 'skipped');
  assert.equal(s.test_generation.message, 'not part of /run-tests');
  assert.equal(s.execution.status, 'pending');
});

test('allowed transitions succeed and record timestamps', () => {
  let s = initialStages('playwright-pipeline');
  s = applyTransition(s, 'preflight', 'running', NOW);
  assert.equal(s.preflight.startedAt, NOW);
  s = applyTransition(s, 'preflight', 'completed', NOW);
  assert.equal(s.preflight.endedAt, NOW);
});

test('illegal transitions throw', () => {
  const s = initialStages('playwright-pipeline');
  assert.throws(() => applyTransition(s, 'preflight', 'completed', NOW), TransitionError, 'pending -> completed');
  const done = advance(s, 1);
  assert.throws(() => applyTransition(done, 'preflight', 'running', NOW), TransitionError, 'completed is terminal');
});

test('a stage cannot start before earlier stages finish', () => {
  const s = initialStages('playwright-pipeline');
  assert.throws(() => applyTransition(s, 'execution', 'running', NOW), /earlier stage\(s\) not finished: preflight/);
});

test('a stage cannot start while an earlier one is running', () => {
  let s = initialStages('playwright-pipeline');
  s = applyTransition(s, 'preflight', 'running', NOW);
  assert.throws(() => applyTransition(s, 'configuration', 'running', NOW), TransitionError);
});

test('blocked stage can resume; run status reflects blocked vs failed vs cancelled', () => {
  let s = advance(initialStages('playwright-pipeline'), 1);
  s = applyTransition(s, 'configuration', 'running', NOW);
  s = applyTransition(s, 'configuration', 'blocked', NOW, 'user declined @playwright/test install');
  assert.equal(deriveRunStatus(s), 'blocked');
  assert.equal(s.configuration.message, 'user declined @playwright/test install');
  s = applyTransition(s, 'configuration', 'running', NOW);
  assert.equal(deriveRunStatus(s), 'in_progress');
  s = applyTransition(s, 'configuration', 'failed', NOW);
  assert.equal(deriveRunStatus(s), 'failed');
  s = applyTransition(s, 'configuration', 'cancelled', NOW);
  assert.equal(deriveRunStatus(s), 'cancelled');
});

test('run is completed only when every stage is completed or skipped', () => {
  let s = initialStages('playwright-pipeline');
  s = advance(s, STAGES.length - 1);
  assert.equal(deriveRunStatus(s), 'in_progress', 'finalization still pending => partial run');
  s = advance(s, STAGES.length);
  assert.equal(deriveRunStatus(s), 'completed');
  assert.equal(nextStage(s), null);
});

test('healing may be skipped by policy without blocking completion', () => {
  let s = advance(initialStages('playwright-pipeline'), STAGES.indexOf('healing'));
  s = applyTransition(s, 'healing', 'skipped', NOW, 'no eligible script defects');
  s = applyTransition(s, 'regression_validation', 'skipped', NOW, 'nothing healed');
  s = advance(s, STAGES.length);
  assert.equal(deriveRunStatus(s), 'completed');
});

test('interrupted (running) stages are recovered as failed', () => {
  let s = advance(initialStages('playwright-pipeline'), 3);
  s = applyTransition(s, 'test_analysis', 'running', NOW);
  const r = recoverInterrupted(s, NOW);
  assert.deepEqual(r.recovered, ['test_analysis']);
  assert.equal(r.stages.test_analysis.status, 'failed');
  assert.match(r.stages.test_analysis.message ?? '', /interrupted/);
  assert.equal(deriveRunStatus(r.stages), 'failed');
  assert.equal(nextStage(r.stages), 'test_analysis');
});

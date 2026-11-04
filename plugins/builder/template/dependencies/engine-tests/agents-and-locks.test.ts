// Priority 4 (agents only where judgment is needed, with bounded inputs) and the Priority 6 safety net for parallel
// workers: several CLI processes updating the same run, cache ledger and agent usage must not lose each other's writes.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_BRIEF_BYTES, boundBrief, needsConfirmation, planAgentStage, readAgentUsage, recordInvocation, summarizeUsage, type PlannerInput,
} from '../engine/pipeline/agent-planner.ts';
import type { FailureAnalysis, FailureEntry } from '../engine/pipeline/failure-classifier.ts';
import type { GenerationPlan } from '../engine/pipeline/generation-reuse.ts';
import { LockTimeoutError, withFileLock } from '../engine/utils/lock.ts';
import { parseInputs, listInputFiles } from '../engine/pipeline/test-case-parser.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

function cliAsync(root: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--root', root]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---- locks ----

test('a file lock serializes work, is released afterwards, and times out instead of waiting forever', (t) => {
  const root = tmpRoot(t);
  const lock = path.join(root, 'x.lock');
  const order: string[] = [];
  withFileLock(lock, () => {
    order.push('outer');
    assert.throws(() => withFileLock(lock, () => order.push('inner'), { timeoutMs: 80 }), LockTimeoutError);
  });
  assert.deepEqual(order, ['outer']);
  assert.equal(existsSync(lock), false, 'released');
  assert.equal(withFileLock(lock, () => 'again'), 'again');
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false, 'released even when the work throws');
});

test('a lock left behind by a crashed process is broken once it is stale', (t) => {
  const root = tmpRoot(t);
  const lock = path.join(root, 'x.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ token: 'dead', pid: 1, at: 'x' }));
  assert.throws(() => withFileLock(lock, () => 1, { timeoutMs: 60, staleMs: 60_000 }), LockTimeoutError, 'a fresh lock is respected');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  assert.equal(withFileLock(lock, () => 'ran', { staleMs: 30_000 }), 'ran');
});

function runWithConfig(t: { after: (fn: () => void) => void }) {
  const root = tmpRoot(t);
  writeFile(root, 'cfg.json', JSON.stringify({ ...validConfig(), language: 'javascript' }));
  assert.equal(cli(root, 'config', 'save', '--file', path.join(root, 'cfg.json')).code, 0);
  const runId: string = cli(root, 'run', 'create', '--command', 'playwright-pipeline').json.runId;
  cli(root, 'run', 'stage', runId, 'preflight', 'running');
  cli(root, 'run', 'stage', runId, 'preflight', 'completed');
  cli(root, 'run', 'stage', runId, 'configuration', 'running');
  assert.equal(cli(root, 'run', 'set-config', runId).code, 0);
  return { root, runId };
}

test('parallel CLI processes cannot overwrite each other\'s manifest updates', async (t) => {
  const { root, runId } = runWithConfig(t);
  const ids = Array.from({ length: 10 }, (_, i) => `TC-${i + 1}`);
  const results = await Promise.all([
    ...ids.map((id) => cliAsync(root, 'run', 'healing-attempt', runId, id)),
    ...ids.map((id) => cliAsync(root, 'deps', 'record', '--dependency', `dep-${id}`, '--action', 'already_present', '--reason', 'parallel test', '--run', runId)),
  ]);
  for (const r of results) assert.equal(r.code, 0, r.stderr || r.stdout);

  const m = cli(root, 'run', 'show', runId).json.manifest;
  assert.deepEqual(Object.keys(m.healing.attemptsByTest).sort(), [...ids].sort(), 'every healing attempt survived');
  assert.deepEqual(Object.values(m.healing.attemptsByTest), ids.map(() => 1));
  assert.equal(m.setupChanges.length, 10, 'every setup change survived');
});

test('the healing limit holds when several workers ask for the same test at once', async (t) => {
  const { root, runId } = runWithConfig(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => cliAsync(root, 'run', 'healing-attempt', runId, 'TC-1')));
  const granted = results.filter((r) => r.code === 0);
  assert.equal(granted.length, 2, 'the cap of 2 cannot be exceeded by racing callers');
  assert.equal(cli(root, 'run', 'show', runId).json.manifest.healing.attemptsByTest['TC-1'], 2);
});

test('parallel agent reports and cache decisions are all kept', async (t) => {
  const { root, runId } = runWithConfig(t);
  const dir = path.join(dependenciesDir(root), 'runs', runId);
  const reports = await Promise.all(Array.from({ length: 8 }, () => cliAsync(root, 'agents', 'record', runId, 'test_generation', '--agent', 'playwright-generator', '--input-tokens', '100', '--output-tokens', '50')));
  for (const r of reports) assert.equal(r.code, 0, r.stderr);
  const usage = readAgentUsage(dir);
  assert.equal(usage.invocations.length, 8);
  const s = summarizeUsage(usage);
  assert.deepEqual([s.inputTokens, s.outputTokens], [800, 400]);
});

// ---- agent planning ----

const specsDoc = (md: string) => {
  const root = tmpRoot({ after: () => {} });
  writeDep(root, 'input/c.md', md);
  return parseInputs(dependenciesDir(root), listInputFiles(dependenciesDir(root), 'input')).document;
};

const CLEAN = `# Shop
## TC-1: Home
### Steps
1. Open the home page -> Expected: The heading "Home" is visible
`;
const UNCLEAR = `${CLEAN}
## TC-2: Vague
### Steps
1. Do something
`;

function input(over: Partial<PlannerInput>): PlannerInput {
  return {
    stage: 'test_analysis', rootDir: '.', specs: null, explorationPlan: null, exploration: null, generationPlan: null, generation: null,
    reviewPlan: null, reviewReport: null, analysis: null, attemptsByTest: {}, maxAttempts: 2, inputTables: null, ...over,
  };
}

test('deterministic stages never ask for an agent', () => {
  for (const stage of ['preflight', 'configuration', 'input_validation', 'execution', 'regression_validation', 'report_generation', 'finalization'] as const) {
    const { decision, briefs } = planAgentStage(input({ stage }));
    assert.equal(decision.agent, null, stage);
    assert.deepEqual(briefs, []);
    assert.ok(decision.reason.length > 10);
  }
});

test('test analysis needs an agent only for ambiguous cases, and the brief carries only those', () => {
  const clean = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN) }));
  assert.equal(clean.decision.agent, null);
  assert.match(clean.decision.reason, /without ambiguity/);

  const unclear = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(UNCLEAR) }));
  assert.equal(unclear.decision.agent, 'test-analyst');
  assert.equal(unclear.decision.invocations, 1);
  const content = unclear.briefs[0]!.content as { ambiguous: { id: string }[] };
  assert.deepEqual(content.ambiguous.map((s) => s.id), ['TC-2'], 'the clean case is not forwarded');
  assert.equal(JSON.stringify(content).includes('"Home"'), false);

  // A table the parser skipped or left columns out of may hide test content: that is a judgment call, so the analyst looks.
  const clean2 = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN), inputTables: [{ path: 'input/a.csv', sheet: null, status: 'ok', reason: null, ignoredColumns: [] }] }));
  assert.equal(clean2.decision.agent, null);
  const noted = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN), inputTables: [{ path: 'input/a.xlsx', sheet: 'Notes', status: 'skipped', reason: 'not a test-case table', ignoredColumns: [] }, { path: 'input/b.csv', sheet: null, status: 'ok', reason: null, ignoredColumns: ['Remarks'] }] }));
  assert.equal(noted.decision.agent, 'test-analyst');
  assert.equal((noted.briefs[0]!.content as { tables: unknown[] }).tables.length, 2);

  // Two equally good columns for a field, or columns read from their content, also need a person's judgment.
  const read = { path: 'input/c.xlsx', sheet: 'Cart', status: 'ok', reason: null, ignoredColumns: [] };
  const twoColumns = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN), inputTables: [{ ...read, ambiguous: [{ field: 'steps', headers: ['Steps', 'Test Steps'] }] }] }));
  assert.equal(twoColumns.decision.agent, 'test-analyst');
  const fromContent = planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN), inputTables: [{ ...read, inferred: [{ field: 'expected', header: 'Col D', confidence: 0.93 }] }] }));
  assert.equal(fromContent.decision.agent, 'test-analyst');
  assert.equal(planAgentStage(input({ stage: 'test_analysis', specs: specsDoc(CLEAN), inputTables: [{ ...read, ambiguous: [], inferred: [] }] })).decision.agent, null);
});

test('generation asks for one agent per batch, each given only its own tests and evidence', () => {
  const specs = specsDoc(`${CLEAN}\n## TC-3: Cart\n### Steps\n1. Open the cart -> Expected: The cart is empty\n`);
  const plan: GenerationPlan = {
    schemaVersion: 1, generatedAt: 'x', language: 'typescript', summary: { generate: 2, reuse: 0 }, specs: [],
    batches: [
      { batchId: 'b1', modules: ['Shop'], testIds: ['TC-1'], targetFile: 'tests/generated/a.spec.ts', manifest: 'generation/manifest-b1.json' },
      { batchId: 'b2', modules: ['Shop'], testIds: ['TC-3'], targetFile: 'tests/generated/b.spec.ts', manifest: 'generation/manifest-b2.json' },
    ],
  };
  const r = planAgentStage(input({ stage: 'test_generation', specs, generationPlan: plan }));
  assert.equal(r.decision.agent, 'playwright-generator');
  assert.equal(r.decision.invocations, 2);
  assert.deepEqual(r.decision.briefs, ['briefs/generation-b1.json', 'briefs/generation-b2.json']);
  const first = r.briefs[0]!.content as { testCases: { id: string }[]; targetFile: string };
  assert.deepEqual(first.testCases.map((c) => c.id), ['TC-1']);
  assert.equal(first.targetFile, 'tests/generated/a.spec.ts');

  const allReused = planAgentStage(input({ stage: 'test_generation', specs, generationPlan: { ...plan, batches: [], summary: { generate: 0, reuse: 3 } } }));
  assert.equal(allReused.decision.agent, null);
  assert.deepEqual(allReused.decision.commands, ['generate assemble']);
});

test('review needs the reviewer only for tests without a valid earlier review', () => {
  const reviewPlan = (action: 'review' | 'skip') => ({
    schemaVersion: 1 as const, generatedAt: 'x', filesToReview: action === 'review' ? ['tests/generated/a.spec.ts'] : [],
    summary: { review: action === 'review' ? 1 : 0, skip: action === 'review' ? 0 : 1 },
    tests: [{ testId: 'TC-1', module: 'Shop', file: 'tests/generated/a.spec.ts', action, reason: 'x', changed: [] }],
  });
  const specs = specsDoc(CLEAN);
  assert.equal(planAgentStage(input({ stage: 'script_review', specs, reviewPlan: reviewPlan('skip') })).decision.agent, null);
  const r = planAgentStage(input({ stage: 'script_review', specs, reviewPlan: reviewPlan('review') }));
  assert.equal(r.decision.agent, 'test-reviewer');
  assert.equal((r.briefs[0]!.content as { tests: unknown[] }).tests.length, 1);
});

function failure(over: Partial<FailureEntry>): FailureEntry {
  return {
    key: 'TC-1@chromium', testId: 'TC-1', title: '[TC-1] x', file: 'tests/a.spec.ts', line: 3, project: 'chromium', outcome: 'failed',
    category: 'script_defect', confidence: 'medium', signals: ['locator found no element'], errorExcerpt: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
    evidence: [], classifiedBy: 'heuristic', rationale: null, healingEligible: true, ...over,
  };
}

const analysis = (...failures: FailureEntry[]): FailureAnalysis => ({ schemaVersion: 1, analyzedAt: 'x', sourceRunId: 'r', sourceLabel: 'initial', failures });

test('triage asks an agent only about failures the heuristics are not sure about', () => {
  assert.equal(planAgentStage(input({ stage: 'failure_triage', analysis: analysis() })).decision.agent, null);
  const sure = failure({ key: 'TC-2@chromium', testId: 'TC-2', category: 'environment_issue', confidence: 'high', healingEligible: false });
  assert.equal(needsConfirmation(sure), false);
  assert.equal(planAgentStage(input({ stage: 'failure_triage', analysis: analysis(sure) })).decision.agent, null);

  const r = planAgentStage(input({ stage: 'failure_triage', specs: specsDoc(CLEAN), analysis: analysis(sure, failure({})) }));
  assert.equal(r.decision.agent, 'failure-healer');
  const content = r.briefs[0]!.content as { failures: { key: string; errorExcerpt: string }[] };
  assert.deepEqual(content.failures.map((f) => f.key), ['TC-1@chromium']);
  assert.equal(content.failures[0]!.errorExcerpt.split('\n').length, 8, 'the error excerpt is bounded');
  assert.equal(needsConfirmation(failure({ classifiedBy: 'agent', rationale: 'seen in the snapshot' })), false);
});

test('healing hands over the failing test block, not the whole file, and the attempts left', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'tests/a.spec.ts', `import { test, expect } from 'x';\n\ntest('[TC-1] one', async () => {\n  expect(1).toBe(1);\n});\n\ntest('[TC-9] other test with unrelated code', async () => {\n  expect(2).toBe(2);\n});\n`);
  const r = planAgentStage(input({ stage: 'healing', rootDir: root, specs: specsDoc(CLEAN), analysis: analysis(failure({})), attemptsByTest: { 'TC-1': 1 } }));
  assert.equal(r.decision.agent, 'failure-healer');
  const c = r.briefs[0]!.content as { attemptsRemaining: number; test: { source: string } };
  assert.equal(c.attemptsRemaining, 1);
  assert.match(c.test.source, /\[TC-1\] one/);
  assert.equal(c.test.source.includes('unrelated code') && !c.test.source.includes('[TC-9]'), false);
  assert.equal(planAgentStage(input({ stage: 'healing', analysis: analysis(failure({ healingEligible: false, category: 'application_defect' })) })).decision.agent, null);
});

test('a brief over the size limit is cut and marked rather than forwarded whole', () => {
  const big = { name: 'x', content: { failures: Array.from({ length: 400 }, (_, i) => ({ i, text: 'x'.repeat(400) })), keep: 'small' } };
  const { brief, truncated } = boundBrief(big);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(brief.content)) <= MAX_BRIEF_BYTES + 200);
  assert.equal((brief.content as { keep: string }).keep, 'small');
  assert.equal(boundBrief({ name: 'y', content: { a: [1] } }).truncated, false);
});

test('tokens are recorded only when reported, never guessed', (t) => {
  const root = tmpRoot(t);
  recordInvocation(root, { stage: 'script_review', agent: 'test-reviewer', inputTokens: null, outputTokens: null, brief: null });
  assert.deepEqual([summarizeUsage(readAgentUsage(root)).inputTokens, summarizeUsage(readAgentUsage(root)).invocations], [null, 1]);
});

test('CLI: planning writes the brief and decision; recording rejects the wrong agent for a stage', (t) => {
  const { root, runId } = runWithConfig(t);
  writeDep(root, 'input/test-cases/c.md', UNCLEAR);
  const parsed = cli(root, 'specs', 'parse', runId);
  assert.equal(parsed.json.cache.action, 'rebuild');
  const plan = cli(root, 'agents', 'plan', runId, 'test_analysis');
  assert.equal(plan.code, 0);
  assert.equal(plan.json.agent, 'test-analyst');
  assert.ok(existsSync(path.join(dependenciesDir(root), 'runs', runId, 'briefs', 'test-analysis.json')));
  assert.equal(cli(root, 'agents', 'plan', runId, 'execution').json.agent, null);

  const wrong = spawnSync(process.execPath, [CLI, 'agents', 'record', runId, 'test_analysis', '--agent', 'test-reviewer', '--root', root], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /handled by test-analyst/);
  assert.equal(cli(root, 'agents', 'record', runId, 'test_analysis', '--agent', 'test-analyst').code, 0);
  assert.equal(cli(root, 'agents', 'record', runId, 'test_analysis', '--agent', 'builder:test-analyst').code, 0, 'the plugin-qualified name is the same agent');
  const shown = cli(root, 'agents', 'show', runId).json;
  assert.equal(shown.invocations, 2);
  assert.deepEqual(shown.stagesRunDeterministically, ['execution']);
  const metrics = cli(root, 'run', 'metrics', runId).json;
  assert.equal(metrics.agents.invocations, 2);
  assert.equal(metrics.notCaptured.includes('agentInvocations'), false);
  assert.ok(metrics.notCaptured.includes('tokenUsage'));
  assert.equal(readFileSync(path.join(dependenciesDir(root), 'runs', runId, 'agents.json'), 'utf8').includes('inputTokens": null'), true);
});

test('CLI: the second specs parse is a cache hit and --no-cache bypasses it', (t) => {
  const { root, runId } = runWithConfig(t);
  writeDep(root, 'input/test-cases/c.md', CLEAN);
  assert.equal(cli(root, 'specs', 'parse', runId).json.cache.action, 'rebuild');
  const second = cli(root, 'specs', 'parse', runId);
  assert.equal(second.json.cache.action, 'reuse');
  assert.equal(second.json.counts.total, 1);
  assert.equal(cli(root, 'specs', 'parse', runId, '--no-cache').json.cache.action, 'rebuild');
  const status = cli(root, 'cache', 'status', runId).json;
  assert.deepEqual(status.byKind.specs, { hits: 0, misses: 1 }, 'the ledger holds the latest decision');
  const inspected = cli(root, 'cache', 'inspect', 'specs', status.rebuilt[0].name).json;
  assert.equal(inspected.status, 'ok');
  assert.equal(inspected.entry.validation.status, 'valid');
  assert.equal(JSON.stringify(inspected).includes('"steps"'), false, 'inspect shows metadata, not the payload');
});

// Drives the real CLI across runs of one project: the first builds and seals everything, the second reuses it without a
// generator or reviewer agent, the third changes one test case and only that test is regenerated and reviewed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_HEADER } from '../engine/pipeline/generation.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

function must(root: string, ...args: string[]) {
  const r = cli(root, ...args);
  assert.equal(r.code, 0, `${args.join(' ')} -> ${r.code}\n${JSON.stringify(r.json, null, 2)}\n${r.stderr}`);
  return r.json;
}

const CASES = (signInName: string) => `# Shop
## TC-1: Home page shows its heading
### Steps
1. Open the home page -> Expected: The heading "Home" is visible

## TC-2: Sign in button is available
### Steps
1. Open the login page -> Expected: A "${signInName}" button is visible
`;

const SPEC = (signInName: string, ext = 'js') => `${GENERATED_HEADER}
import { test, expect } from '../fixtures/test.${ext}';

test.describe('Shop', () => {
  test('[TC-1] Home page shows its heading', { annotation: { type: 'testId', description: 'TC-1' } }, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  });

  test('[TC-2] Sign in button is available', { annotation: { type: 'testId', description: 'TC-2' } }, async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: '${signInName}' })).toBeVisible();
  });
});
`;

const rmFile = (root: string, rel: string) => rmSync(path.join(root, rel), { force: true });
const runPath = (root: string, runId: string, rel: string) => path.join(dependenciesDir(root), 'runs', runId, rel);

function newRun(root: string): string {
  const runId: string = must(root, 'run', 'create', '--command', 'generate-tests').runId;
  must(root, 'run', 'stage', runId, 'preflight', 'running');
  must(root, 'run', 'stage', runId, 'preflight', 'completed');
  must(root, 'run', 'stage', runId, 'configuration', 'running');
  must(root, 'run', 'set-config', runId);
  return runId;
}

// What the generator agent leaves behind for one batch.
function agentWrites(root: string, runId: string, batch: { batchId: string; targetFile: string; testIds: string[] }, signInName: string) {
  writeFile(root, batch.targetFile, SPEC(signInName));
  writeFile(path.dirname(dependenciesDir(root)), `dependencies/runs/${runId}/generation/manifest-${batch.batchId}.json`, JSON.stringify({
    schemaVersion: 1, generatedAt: 'x', language: 'javascript', sharedFilesChanged: [], excluded: [],
    tests: batch.testIds.map((id) => ({ testId: id, file: batch.targetFile, title: `[${id}] t` })),
  }));
}

// Every decision of the run (the CLI's own summary lists only the rebuilds).
function ledger(root: string, runId: string): Record<string, string> {
  const file = runPath(root, runId, 'cache-decisions.json');
  if (!existsSync(file)) return {};
  const l = JSON.parse(readFileSync(file, 'utf8')) as { decisions: { kind: string; name: string; action: string }[] };
  return Object.fromEntries(l.decisions.map((d) => [`${d.kind}:${d.name}`, d.action]));
}

const EDITED_TS = [SPEC('Sign in', 'ts'), '// edited', ''].join('\n');

test('cross-run reuse through the CLI: build once, reuse unchanged work, rebuild only what changed', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(root, 'cfg.json', JSON.stringify({ ...validConfig(), language: 'javascript' }));
  must(root, 'config', 'save', '--file', path.join(root, 'cfg.json'));
  writeDep(root, 'input/test-cases/shop.md', CASES('Sign in'));

  // ---- run 1: nothing cached, everything is built, reviewed by the agent and sealed ----
  const r1 = newRun(root);
  assert.equal(must(root, 'specs', 'parse', r1).cache.action, 'rebuild');
  const plan1 = must(root, 'generate', 'plan', r1);
  assert.deepEqual(plan1.summary, { generate: 2, reuse: 0 });
  assert.deepEqual(plan1.batches.map((b: { targetFile: string }) => b.targetFile), ['tests/shop.spec.js'], 'one batch per module file');
  const g1 = must(root, 'agents', 'plan', r1, 'test_generation');
  assert.deepEqual([g1.agent, g1.invocations], ['playwright-generator', 1]);
  agentWrites(root, r1, plan1.batches[0], 'Sign in');
  must(root, 'agents', 'record', r1, 'test_generation', '--agent', 'playwright-generator');
  must(root, 'generate', 'assemble', r1);
  must(root, 'generate', 'validate', r1);
  must(root, 'review', 'static', r1);
  const review1 = must(root, 'review', 'plan', r1);
  assert.deepEqual(review1.summary, { review: 2, skip: 0 });
  const refused = cli(root, 'review', 'seal', r1);
  assert.equal(refused.code, 2, 'sealing before the reviewer ran is refused');
  assert.match(refused.json.issues.join(), /semantic review of TC-1, TC-2 has not happened/);
  must(root, 'agents', 'record', r1, 'script_review', '--agent', 'builder:test-reviewer');
  assert.deepEqual(must(root, 'review', 'seal', r1).sealed, ['TC-1', 'TC-2']);

  // ---- run 2: same inputs, no agent is needed for generation or review ----
  const r2 = newRun(root);
  assert.equal(must(root, 'specs', 'parse', r2).cache.action, 'reuse');
  const plan2 = must(root, 'generate', 'plan', r2);
  assert.deepEqual([plan2.summary, plan2.batches, plan2.reuse], [{ generate: 0, reuse: 2 }, [], ['TC-1', 'TC-2']]);
  const g2 = must(root, 'agents', 'plan', r2, 'test_generation');
  assert.equal(g2.agent, null, 'every generated test is unchanged and still valid');
  assert.deepEqual(g2.commands, ['generate assemble']);
  must(root, 'generate', 'assemble', r2);
  const manifest2 = JSON.parse(readFileSync(runPath(root, r2, 'generation-manifest.json'), 'utf8'));
  assert.deepEqual(manifest2.reuse, { generatedTests: [], reusedTests: ['TC-1', 'TC-2'] });
  assert.ok(existsSync(runPath(root, r2, 'generation-report.md')), 'a report exists even though no agent ran');
  must(root, 'generate', 'validate', r2);
  must(root, 'review', 'static', r2);
  assert.deepEqual(must(root, 'review', 'plan', r2).summary, { review: 0, skip: 2 });
  assert.equal(must(root, 'agents', 'plan', r2, 'script_review').agent, null);
  assert.deepEqual(must(root, 'review', 'seal', r2).sealed, ['TC-1', 'TC-2'], 'sealing needs no reviewer when nothing needed review');
  const decisions2 = ledger(root, r2);
  assert.deepEqual(Object.entries(decisions2).filter(([k]) => !k.startsWith('specs:')).sort(), [
    ['generation:TC-1', 'reuse'], ['generation:TC-2', 'reuse'], ['review:TC-1', 'reuse'], ['review:TC-2', 'reuse'],
  ]);
  assert.deepEqual(Object.entries(decisions2).filter(([k]) => k.startsWith('specs:')).map(([, v]) => v), ['reuse']);
  assert.equal(must(root, 'agents', 'show', r2).invocations, 0, 'run 2 made no agent call');
  const status2 = must(root, 'cache', 'status', r2);
  assert.deepEqual([status2.misses, status2.rebuilt], [0, []]);

  // ---- run 3: one test case changes; only its test is regenerated and reviewed ----
  writeDep(root, 'input/test-cases/shop.md', CASES('Log in'));
  const r3 = newRun(root);
  const parsed3 = must(root, 'specs', 'parse', r3);
  assert.equal(parsed3.cache.action, 'rebuild');
  assert.deepEqual(parsed3.cache.changed, ['inputs.input/test-cases/shop.md']);
  const plan3 = must(root, 'generate', 'plan', r3);
  assert.deepEqual([plan3.reuse, plan3.generate.map((g: { testId: string }) => g.testId)], [['TC-1'], ['TC-2']]);
  assert.match(plan3.generate[0].reason, /test case changed/);
  assert.deepEqual(plan3.batches[0].testIds, ['TC-2']);
  const g3 = must(root, 'agents', 'plan', r3, 'test_generation');
  const briefed = JSON.parse(readFileSync(runPath(root, r3, g3.briefs[0]), 'utf8'));
  assert.deepEqual(briefed.testCases.map((c: { id: string }) => c.id), ['TC-2'], 'the generator is given only the test case it must write');
  assert.ok(briefed.rules.some((r: string) => r.includes(GENERATED_HEADER)), 'and the ownership header it must keep');

  // The generator edits the module file for TC-2 only; TC-1's block is untouched.
  writeFile(root, plan3.batches[0].targetFile, SPEC('Log in'));
  writeFile(path.dirname(dependenciesDir(root)), `dependencies/runs/${r3}/generation/manifest-b1.json`, JSON.stringify({
    schemaVersion: 1, generatedAt: 'x', language: 'javascript', sharedFilesChanged: [], excluded: [],
    tests: [{ testId: 'TC-2', file: plan3.batches[0].targetFile, title: '[TC-2] t' }],
  }));
  const merged = must(root, 'generate', 'assemble', r3);
  assert.deepEqual(merged.reuse, { generatedTests: ['TC-2'], reusedTests: ['TC-1'] });
  must(root, 'generate', 'validate', r3);
  must(root, 'review', 'static', r3);
  const review3 = must(root, 'review', 'plan', r3);
  assert.deepEqual([review3.skip, review3.review.map((x: { testId: string }) => x.testId)], [['TC-1'], ['TC-2']]);
  assert.equal(must(root, 'agents', 'plan', r3, 'script_review').invocations, 1);

  // A corrupted entry is rejected and rebuilt, with the reason.
  const entry = path.join(dependenciesDir(root), 'state/artifact-cache/generation/TC-1.json');
  writeFile(path.dirname(dependenciesDir(root)), 'dependencies/state/artifact-cache/generation/TC-1.json', readFileSync(entry, 'utf8').slice(0, 30));
  const r4 = newRun(root);
  must(root, 'specs', 'parse', r4);
  const plan4 = must(root, 'generate', 'plan', r4);
  assert.ok(plan4.generate.some((g: { testId: string; reason: string }) => g.testId === 'TC-1' && /cached artifact rejected: .*not valid JSON/.test(g.reason)));
});

// The TypeScript project check is the slow part of script review: a pass is reused until a file it reads changes.
test('a passing typecheck is reused across runs and rerun when a checked file changes; a failing one is never kept', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'package.json', JSON.stringify({ type: 'module' }));
  // Stand-in compiler: records every invocation; fails while FAIL exists.
  writeFile(root, 'node_modules/typescript/bin/tsc', `const { appendFileSync, existsSync } = require('node:fs');
appendFileSync('tsc-calls.log', 'x\\n');
if (existsSync('FAIL')) { console.error('error TS2322'); process.exit(2); }
`);
  writeFile(root, 'node_modules/typescript/package.json', JSON.stringify({ version: '7.0.2' }));
  writeFile(root, 'cfg.json', JSON.stringify(validConfig()));
  must(root, 'config', 'save', '--file', path.join(root, 'cfg.json'));
  writeDep(root, 'input/test-cases/shop.md', CASES('Sign in'));
  const calls = () => (existsSync(path.join(root, 'tsc-calls.log')) ? readFileSync(path.join(root, 'tsc-calls.log'), 'utf8').trim().split('\n').length : 0);

  const prepare = (): string => {
    const runId = newRun(root);
    must(root, 'specs', 'parse', runId);
    const plan = must(root, 'generate', 'plan', runId);
    const file = 'tests/shop.spec.ts';
    writeFile(root, file, SPEC('Sign in', 'ts'));
    writeFile(path.dirname(dependenciesDir(root)), `dependencies/runs/${runId}/generation-manifest.json`, JSON.stringify({
      schemaVersion: 1, generatedAt: 'x', language: 'typescript', sharedFilesChanged: [], excluded: [],
      tests: ['TC-1', 'TC-2'].map((id) => ({ testId: id, file, title: `[${id}] t` })),
    }));
    assert.ok(plan.summary);
    return runId;
  };

  writeFile(root, 'FAIL', '');
  const failed = cli(root, 'review', 'static', prepare());
  assert.equal(failed.code, 2);
  assert.equal(failed.json.typecheck.ok, false);
  assert.equal(calls(), 1);
  rmFile(root, 'FAIL');

  const first = must(root, 'review', 'static', prepare());
  assert.equal(first.typecheck.cached, undefined, 'a failure was not cached, so the check ran again');
  assert.equal(calls(), 2);

  const second = must(root, 'review', 'static', prepare());
  assert.equal(second.typecheck.cached, true);
  assert.equal(calls(), 2, 'the compiler was not run again');
  const runId = prepare();
  assert.equal(ledger(root, runId)['typecheck:framework'], undefined);
  must(root, 'review', 'static', runId);
  assert.equal(ledger(root, runId)['typecheck:framework'], 'reuse');

  const edited = prepare();
  writeFile(root, 'tests/shop.spec.ts', EDITED_TS);
  const rebuilt = must(root, 'review', 'static', edited);
  assert.equal(rebuilt.typecheck.cached, undefined);
  assert.equal(calls(), 3, 'a changed file makes the compiler run again');
  const again = prepare();
  writeFile(root, 'tests/shop.spec.ts', EDITED_TS);
  assert.equal(must(root, 'review', 'static', again).typecheck.cached, true, 'the edited tree was cached after it passed');
  assert.equal(must(root, 'review', 'static', again, '--no-cache').typecheck.cached, undefined);
  assert.equal(calls(), 4, '--no-cache bypasses the cache');
});

// Test data the run created: the config rules, the ledger, the in-test undo (also when a test dies), the post-run sweep and the CLI.
// The sweep's HTTP calls are checked twice: with a fake and against a real local server (the helper process that makes the request).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { saveConfig } from '../engine/config/load-config.ts';
import { validateConfig, type AutomationConfig } from '../engine/config/schema.ts';
import { ARTIFACTS, runDir } from '../engine/pipeline/artifact-manager.ts';
import { startCleanup } from '../engine/pipeline/cleanup-fixture.ts';
import {
  CleanupSession, cleanupGuard, leftoverLines, readCreatedData, recordExternally, summarizeData, updateRecords, validateNewRecord,
} from '../engine/pipeline/created-data.ts';
import { adhocLedgerDir, briefOfSweep, dataSweepTrigger, readSweepHistory, resolveUrl, sweepAdhoc, sweepData, type Fetcher } from '../engine/pipeline/data-cleanup.ts';
import { sweepAfterAdhocRun } from '../engine/pipeline/adhoc-sweep.ts';
import { renderSummaryMarkdown, type RunSummary } from '../engine/pipeline/reporting.ts';
import { reviewSource } from '../engine/pipeline/static-review.ts';
import { tmpRoot, validConfig } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const ADHOC_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'adhoc-run.ts');
const RUN = '20261022-090000-abcdef';

function withCleanup(over: Partial<NonNullable<AutomationConfig['cleanup']>> = {}, env = 'qa'): AutomationConfig {
  const c = validConfig();
  return {
    ...c, app: { ...c.app, environment: env },
    cleanup: { mode: 'test', allowedEnvironments: ['qa'], entities: { order: { api: { method: 'DELETE', path: '/api/orders/{id}' } } }, ...over },
  };
}

function runFolder(root: string, runId = RUN): string {
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function session(dir: string | null, config: AutomationConfig | null, extra: Partial<ConstructorParameters<typeof CleanupSession>[0]> = {}): CleanupSession {
  return new CleanupSession({ runDirectory: dir, label: 'initial', testKey: 'orders.spec.ts:[TC-001] Create order', testId: 'TC-001', retry: 0, guard: cleanupGuard(config), ...extra });
}

// ---- configuration ----

test('cleanup config: valid, optional, and never production', () => {
  assert.equal(validateConfig(validConfig()).ok, true, 'absent cleanup keeps older configs valid');
  assert.equal(validateConfig(withCleanup()).ok, true);

  const bad = (config: unknown, needle: string) => {
    const r = validateConfig(config);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => i.message.includes(needle) || i.path.includes(needle)), JSON.stringify(r));
  };
  bad(withCleanup({ allowedEnvironments: ['qa', 'Production'] }), 'production');
  bad(withCleanup({ allowedEnvironments: [] }), 'at least one');
  bad({ ...withCleanup(), cleanup: { mode: 'test' } }, 'allowedEnvironments');
  bad({ ...withCleanup(), cleanup: { mode: 'sometimes', allowedEnvironments: ['qa'] } }, 'cleanup.mode');
  bad({ ...withCleanup(), cleanup: { mode: 'both', allowedEnvironments: ['qa'] } }, 'cleanup.mode');
  bad(withCleanup({ entities: { order: {} } }), 'needs an "api" or a "ui"');
  bad(withCleanup({ entities: { order: { api: { method: 'DELETE', path: '/api/orders' } } } }), '{id}');
  bad(withCleanup({ entities: { order: { api: { method: 'DELETE', path: 'https://evil.example/{id}' } } } }), 'api.path');
  bad(withCleanup({ entities: { order: { api: { method: 'DELETE', path: '//evil.example/{id}' } } } }), 'api.path');
  bad(withCleanup({ entities: { order: { api: { method: 'DELETE', path: '/api/{id}', headersFromEnv: { Authorization: 'token value' } } } } }), 'NAMES');
  bad(withCleanup({ entities: { order: { ui: { hint: ' ' } } } }), 'hint');
  for (const mode of ['sweep', 'test'] as const) assert.equal(validateConfig(withCleanup({ mode })).ok, true, mode);
});

test('configs saved by 0.15-0.17 keep working: in-test and in-test+sweep become "test", off drops the cleanup block', () => {
  for (const mode of ['in-test', 'in-test+sweep']) {
    const r = validateConfig({ ...withCleanup(), cleanup: { ...withCleanup().cleanup, mode } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.config.cleanup?.mode, 'test');
    assert.deepEqual(r.ok && r.config.cleanup?.entities, withCleanup().cleanup!.entities, 'the rest of the block is kept');
  }
  const off = validateConfig({ ...withCleanup(), cleanup: { mode: 'off', allowedEnvironments: [] } });
  assert.ok(off.ok, JSON.stringify(off));
  assert.equal(off.ok && 'cleanup' in off.config, false);
  assert.equal(validateConfig({ ...withCleanup(), cleanup: { mode: 'in-test', allowedEnvironments: [] } }).ok, false, 'a legacy mode still needs an environment');
});

test('the guard allows cleanup only when it is on, listed and not production', () => {
  assert.equal(cleanupGuard(null).allowed, false);
  assert.match(cleanupGuard(validConfig()).reason!, /not configured/);
  assert.match(cleanupGuard(withCleanup({}, 'staging')).reason!, /not in cleanup.allowedEnvironments/);
  assert.match(cleanupGuard(withCleanup({ allowedEnvironments: ['qa'] }, 'Production')).reason!, /production/);
  // a production name wins even if a hand-edited config lists it (the validator refuses such a file, the guard does not rely on that)
  const sneaky = withCleanup({}, 'prod');
  sneaky.cleanup!.allowedEnvironments = ['prod'];
  assert.equal(cleanupGuard(sneaky).allowed, false);
  assert.equal(cleanupGuard(withCleanup({}, 'QA')).allowed, true, 'environment names compare case-insensitively');
  for (const mode of ['sweep', 'test'] as const) assert.equal(cleanupGuard(withCleanup({ mode })).allowed, true, mode);
});

// ---- inside the test ----

test('registering writes the ledger before the undo; undo runs last-created first and records the outcome', async (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const config = withCleanup();
  const s = session(dir, config);
  const order: string[] = [];
  s.register({ entity: 'order', identifier: 'ord-1', undo: () => { order.push('ord-1'); } });
  assert.equal(readCreatedData(dir)[0]!.status, 'pending', 'on disk before anything is deleted');
  s.register({ entity: 'order', identifier: 'ord-2', undo: async () => { order.push('ord-2'); }, verify: () => true });
  s.register({ entity: 'note', identifier: 'note-1' });

  const outcome = await s.run();
  assert.deepEqual(order, ['ord-2', 'ord-1']);
  const byId = Object.fromEntries(readCreatedData(dir).map((r) => [r.identifier, r]));
  assert.equal(byId['ord-1']!.status, 'deleted');
  assert.equal(byId['ord-1']!.removedBy, 'test');
  assert.equal(byId['ord-2']!.status, 'verified_gone');
  assert.equal(byId['note-1']!.status, 'no_cleanup_path');
  assert.equal(outcome.length, 3);
  assert.equal(byId['ord-1']!.testId, 'TC-001');
  assert.equal(byId['ord-1']!.label, 'initial');
});

test('a failing or hanging undo is recorded and never throws; the others still run', async (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const s = session(dir, withCleanup(), { undoTimeoutMs: 50, redact: (x) => x.replaceAll('hunter2', '***') });
  const ran: string[] = [];
  s.register({ entity: 'order', identifier: 'a', undo: () => { ran.push('a'); } });
  s.register({ entity: 'order', identifier: 'b', undo: () => new Promise(() => {}) }); // never settles
  s.register({ entity: 'order', identifier: 'c', undo: () => { throw new Error('delete button not found, password hunter2'); } });
  s.register({ entity: 'order', identifier: 'd', undo: () => {}, verify: () => false });
  await s.run();
  const r = Object.fromEntries(readCreatedData(dir).map((x) => [x.identifier, x]));
  assert.deepEqual(ran, ['a']);
  assert.equal(r['c']!.status, 'failed');
  assert.ok(!r['c']!.error!.includes('hunter2'), 'secrets are redacted');
  assert.match(r['b']!.error!, /timed out/);
  assert.equal(r['d']!.status, 'failed');
  assert.match(r['d']!.error!, /still there/);
  assert.equal(r['a']!.status, 'deleted');
});

test('a test that dies before teardown still leaves its records pending in the ledger', (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const s = session(dir, withCleanup());
  s.register({ entity: 'order', identifier: 'ord-crash', undo: () => {} });
  // run() is never called: the worker was killed
  const left = readCreatedData(dir);
  assert.equal(left.length, 1);
  assert.equal(left[0]!.status, 'pending');
  assert.equal(summarizeData(left, withCleanup()).leftovers.length, 1);
});

test('nothing is deleted when cleanup is not configured, the environment is not allowed or it is production', async (t) => {
  for (const [config, why] of [
    [withCleanup({}, 'staging'), /not in cleanup.allowedEnvironments/],
    [validConfig(), /not configured/],
    [null, /missing or invalid/],
  ] as const) {
    const root = tmpRoot(t);
    const dir = runFolder(root);
    let called = false;
    const s = session(dir, config);
    s.register({ entity: 'order', identifier: 'x1', undo: () => { called = true; } });
    await s.run();
    assert.equal(called, false);
    const rec = readCreatedData(dir)[0]!;
    assert.equal(rec.status, 'blocked');
    assert.match(rec.error!, why);
  }
});

test('registration rejects unsafe entities and identifiers; outside a run nothing is written', async (t) => {
  assert.match(validateNewRecord({ entity: 'order', identifier: '../../etc/passwd' })!, /identifier/);
  assert.match(validateNewRecord({ entity: 'bad entity', identifier: 'ok' })!, /entity/);
  assert.equal(validateNewRecord({ entity: 'order', identifier: 'ord-w0-mgx3k1-a1b2c3' }), null);
  const s = session(null, withCleanup());
  assert.throws(() => s.register({ entity: 'order', identifier: 'a b' }), /identifier/);
  let called = false;
  s.register({ entity: 'order', identifier: 'plain', undo: () => { called = true; } });
  await s.run();
  assert.equal(called, true, 'undo still runs outside a pipeline run when the config allows it');
  const root = tmpRoot(t);
  assert.equal(existsSync(path.join(root, '..', 'dependencies', 'runs')), false);
});

test('startCleanup follows PIPELINE_RUN_ID and PIPELINE_LABEL and reads the saved config', async (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(saveConfig(root, withCleanup()), { ok: true });
  const dir = runFolder(root);
  const env = { PIPELINE_RUN_ID: RUN, PIPELINE_LABEL: 'regression' };
  const s = startCleanup(root, { file: 'C:\\x\\tests\\orders.spec.ts', title: '[TC-007] Create order', retry: 1 }, (x) => x, env);
  s.register({ entity: 'order', identifier: 'ord-7', undo: () => {} });
  await s.run();
  const rec = readCreatedData(dir)[0]!;
  assert.equal(rec.label, 'regression');
  assert.equal(rec.testId, 'TC-007');
  assert.equal(rec.retry, 1);
  assert.equal(rec.status, 'deleted');
  assert.ok(existsSync(path.join(dir, ARTIFACTS.createdData, 'regression')));
  assert.ok(rec.testKey!.includes('orders.spec.ts'));
  // no run id: plain Playwright, nothing written
  const plain = startCleanup(root, { file: 'a.spec.ts', title: 'no id', retry: 0 }, (x) => x, {});
  plain.register({ entity: 'order', identifier: 'p1', undo: () => {} });
  await plain.run();
  assert.equal(readCreatedData(dir).length, 1);
});

// ---- the sweep ----

interface Call { url: string; method: string; headers: Record<string, string> }

function fake(answers: (c: Call) => number): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, fetch: (req) => { calls.push({ url: req.url, method: req.method, headers: req.headers }); return { status: answers(calls.at(-1)!) }; } };
}

async function leftBehind(root: string, entries: { entity: string; identifier: string; hint?: string }[]): Promise<string> {
  const dir = runFolder(root);
  const s = session(dir, withCleanup());
  for (const e of entries) s.register({ entity: e.entity, identifier: e.identifier, hint: e.hint, undo: () => {} });
  // simulate a worker that died: the ledger keeps them pending
  return dir;
}

test('the sweep removes ledger records through the declared API, on the app origin, with headers from the environment', async (t) => {
  const root = tmpRoot(t);
  const dir = await leftBehind(root, [{ entity: 'order', identifier: 'ord-1' }, { entity: 'order', identifier: 'ord-2' }]);
  const config = withCleanup({ mode: 'sweep', entities: { order: { api: { method: 'DELETE', path: '/api/orders/{id}', headersFromEnv: { Authorization: 'SWEEP_TOKEN' }, verifyPath: '/api/orders/{id}' } } } });
  const f = fake((c) => (c.method === 'DELETE' ? (c.url.endsWith('ord-2') ? 404 : 204) : 404));
  const report = sweepData(root, RUN, config, { trigger: 'test', fetch: f.fetch, env: { SWEEP_TOKEN: 'Bearer s3cret' } });

  assert.equal(report.ran, true);
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), [
    'DELETE https://test.example.com/api/orders/ord-1', 'GET https://test.example.com/api/orders/ord-1',
    'DELETE https://test.example.com/api/orders/ord-2', 'GET https://test.example.com/api/orders/ord-2',
  ]);
  assert.equal(f.calls[0]!.headers.Authorization, 'Bearer s3cret');
  assert.deepEqual(readCreatedData(dir).map((r) => [r.status, r.removedBy]), [['verified_gone', 'api'], ['verified_gone', 'api']], 'a 404 on DELETE means already gone');
  assert.equal(report.summary.leftovers, 0);
  assert.equal(readSweepHistory(dir).length, 1);
  assert.ok(!JSON.stringify(readSweepHistory(dir)).includes('s3cret'));
});

test('an API failure, a missing variable, a record still present and the per-run cap are reported, not hidden', async (t) => {
  const root = tmpRoot(t);
  const dir = await leftBehind(root, [1, 2, 3, 4].map((n) => ({ entity: 'order', identifier: `ord-${n}` })));
  const config = withCleanup({ mode: 'sweep', maxDeletesPerRun: 3, entities: { order: { api: { method: 'DELETE', path: '/api/orders/{id}', headersFromEnv: { Authorization: 'SWEEP_TOKEN' }, verifyPath: '/api/orders/{id}' } } } });
  const answers: Record<string, number> = { 'DELETE ord-1': 500, 'DELETE ord-2': 200, 'GET ord-2': 200, 'DELETE ord-3': 204, 'GET ord-3': 404 };
  const f = fake((c) => answers[`${c.method} ${c.url.split('/').pop()}`] ?? 404);
  const noToken = sweepData(root, RUN, config, { trigger: 'test', fetch: f.fetch, env: {}, dryRun: false });
  assert.equal(f.calls.length, 0, 'no call without the header value');
  assert.ok(noToken.actions.slice(0, 3).every((a) => a.result === 'failed' && /SWEEP_TOKEN/.test(a.detail!)));

  const report = sweepData(root, RUN, config, { trigger: 'test', fetch: f.fetch, env: { SWEEP_TOKEN: 'x' } });
  const status = Object.fromEntries(readCreatedData(dir).map((r) => [r.identifier, r.status]));
  assert.deepEqual(status, { 'ord-1': 'failed', 'ord-2': 'failed', 'ord-3': 'verified_gone', 'ord-4': 'blocked' });
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 3, 'never more than maxDeletesPerRun');
  assert.equal(report.summary.leftovers, 3);
  assert.match(readCreatedData(dir).find((r) => r.identifier === 'ord-2')!.error!, /still answers 200/);
  assert.ok(report.leftoverLines.some((l) => l.includes('ord-4') && l.includes('limit')));
});

test('without sweep permission nothing is called and the leftovers are listed with how to delete them', async (t) => {
  const root = tmpRoot(t);
  const dir = await leftBehind(root, [{ entity: 'order', identifier: 'ord-1' }, { entity: 'invoice', identifier: 'inv-1', hint: 'Invoices > row > Delete' }]);
  for (const config of [withCleanup({ mode: 'test' }), withCleanup({ mode: 'sweep' }, 'staging'), withCleanup({ mode: 'sweep' }, 'production'), null]) {
    const f = fake(() => 204);
    const report = sweepData(root, RUN, config, { trigger: 'test', fetch: f.fetch });
    assert.equal(report.ran, false);
    assert.equal(f.calls.length, 0);
    assert.equal(report.summary.leftovers, 2);
    assert.ok(report.guard.reason);
  }
  const lines = sweepData(root, RUN, withCleanup({ mode: 'test' }), { trigger: 'test', fetch: fake(() => 204).fetch }).leftoverLines;
  assert.ok(lines.some((l) => l.includes('order "ord-1"') && l.includes('can be deleted: DELETE /api/orders/<identifier>')));
  assert.ok(lines.some((l) => l.includes('invoice "inv-1"') && l.includes('Invoices > row > Delete')));
  assert.equal(readCreatedData(dir).every((r) => r.status === 'pending'), true, 'a blocked sweep changes nothing');
});

test('UI-only records are handed to the agent, stay on its list until it reports, and a dry run changes nothing', async (t) => {
  const root = tmpRoot(t);
  const dir = await leftBehind(root, [{ entity: 'contact', identifier: 'con-1' }, { entity: 'mystery', identifier: 'm-1' }]);
  const config = withCleanup({ mode: 'sweep', entities: { contact: { ui: { hint: 'Contacts > open > Delete' } } } });
  const f = fake(() => 204);

  const dry = sweepData(root, RUN, config, { trigger: 'test', dryRun: true, fetch: f.fetch });
  assert.deepEqual(dry.uiTasks.map((u) => u.identifier), ['con-1']);
  assert.equal(readCreatedData(dir).every((r) => r.status === 'pending'), true);
  assert.equal(readSweepHistory(dir).length, 0, 'a dry run is not recorded');

  const real = sweepData(root, RUN, config, { trigger: 'test', fetch: f.fetch });
  assert.deepEqual(real.uiTasks, [{ id: readCreatedData(dir)[0]!.id, entity: 'contact', identifier: 'con-1', how: 'Contacts > open > Delete', testId: 'TC-001' }]);
  const status = Object.fromEntries(readCreatedData(dir).map((r) => [r.identifier, r.status]));
  assert.deepEqual(status, { 'con-1': 'needs_ui', 'm-1': 'no_cleanup_path' });
  assert.equal(f.calls.length, 0);

  // a second sweep (for example at finalization) still lists the UI task
  assert.equal(sweepData(root, RUN, config, { trigger: 'again', fetch: f.fetch }).uiTasks.length, 1);

  // the agent reports back
  const id = readCreatedData(dir)[0]!.id;
  assert.equal(updateRecords(dir, new Map([[id, { status: 'deleted', removedBy: 'ui-agent', error: null }]])), 1);
  const after = sweepData(root, RUN, config, { trigger: 'final', fetch: f.fetch });
  assert.equal(after.uiTasks.length, 0);
  assert.equal(after.summary.removed, 1);
  assert.equal(after.summary.leftovers, 1);
});

test('records already removed are left alone, and the identifier cannot leave the app origin', async (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const s = session(dir, withCleanup());
  s.register({ entity: 'order', identifier: 'done-1', undo: () => {} });
  await s.run();
  const f = fake(() => 204);
  const report = sweepData(root, RUN, withCleanup({ mode: 'sweep' }), { trigger: 'test', fetch: f.fetch });
  assert.equal(f.calls.length, 0);
  assert.equal(report.summary.removed, 1);
  assert.equal(briefOfSweep(report)!.leftovers, 0);

  assert.equal(resolveUrl('https://app.example.com', '/api/o/{id}', '../x'), null);
  assert.equal(resolveUrl('https://app.example.com', '/api/o/{id}', 'a/b'), null);
  assert.equal(resolveUrl('https://app.example.com/base', '/api/o/{id}', 'ok-1')!.href, 'https://app.example.com/api/o/ok-1');
  assert.equal(resolveUrl('https://app.example.com', '//evil.example.com/{id}', 'ok-1'), null, 'a protocol-relative path would change the host');
});

test('a run that created no data produces no brief and no history', (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const report = sweepData(root, RUN, withCleanup(), { trigger: 'test', fetch: fake(() => 204).fetch });
  assert.equal(briefOfSweep(report), null);
  assert.equal(existsSync(path.join(dir, ARTIFACTS.dataCleanup)), false);
});

test('the sweep runs after the stages that run tests and after any stage that stops the run', () => {
  assert.equal(dataSweepTrigger('execution', 'completed'), 'execution completed');
  assert.equal(dataSweepTrigger('regression_validation', 'completed'), 'regression_validation completed');
  assert.equal(dataSweepTrigger('healing', 'skipped'), 'healing skipped');
  assert.equal(dataSweepTrigger('test_generation', 'failed'), 'test_generation failed');
  assert.equal(dataSweepTrigger('execution', 'running'), null);
  assert.equal(dataSweepTrigger('script_review', 'completed'), null);
});

// ---- mode "sweep": delete only once every test has finished ----

test('mode "sweep": tests only register; nothing is deleted until the sweep', async (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const config = withCleanup({ mode: 'sweep' });
  assert.equal(validateConfig(config).ok, true);
  assert.equal(cleanupGuard(config).allowed, true);

  let undone = false;
  const s = session(dir, config);
  s.register({ entity: 'order', identifier: 'ord-keep', undo: () => { undone = true; } });
  const outcome = await s.run();
  assert.equal(undone, false, 'the test must not delete the record: a later test may still need it');
  assert.deepEqual(outcome, [], 'a record waiting for the sweep is not reported as a problem');
  assert.equal(readCreatedData(dir)[0]!.status, 'pending');

  const f = fake((c) => (c.method === 'DELETE' ? 204 : 404));
  const report = sweepData(root, RUN, config, { trigger: 'after all tests', fetch: f.fetch });
  assert.equal(report.ran, true);
  assert.deepEqual(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['DELETE /api/orders/ord-keep']);
  assert.equal(readCreatedData(dir)[0]!.status, 'deleted');
  assert.equal(readCreatedData(dir)[0]!.removedBy, 'api');
});

test('mode "test": each test undoes its own data when it ends, and there is no sweep afterwards', async (t) => {
  const root = tmpRoot(t);
  const dir = runFolder(root);
  const f = fake(() => 204);
  const config = withCleanup({ mode: 'test' });
  const a = session(dir, config);
  a.register({ entity: 'order', identifier: 'ord-a', undo: () => {} });
  a.register({ entity: 'order', identifier: 'ord-b' }); // no undo: the declared API is not used in this mode
  await a.run();
  assert.equal(readCreatedData(dir)[0]!.status, 'deleted');
  assert.equal(sweepData(root, RUN, config, { trigger: 't', fetch: f.fetch }).ran, false);
  assert.equal(f.calls.length, 0, 'no sweep: the record without an undo is listed, not deleted');
  assert.equal(readCreatedData(dir)[1]!.status, 'no_cleanup_path');
});

// ---- plain Playwright (npm run test:adhoc / test:ui): the ad hoc ledger and the sweep after the run ----

test('plain Playwright: records go to the ad hoc ledger and are swept after the run, not by the test', async (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(saveConfig(root, withCleanup({ mode: 'sweep' })), { ok: true });
  const ledger = adhocLedgerDir(root);
  const info = { file: 'tests/orders.spec.ts', title: '[TC-9] Create order', retry: 0 };

  let undone = false;
  const s = startCleanup(root, info, (x) => x, {});
  s.register({ entity: 'order', identifier: 'ord-adhoc', undo: () => { undone = true; } });
  await s.run();
  assert.equal(undone, false);
  assert.equal(readCreatedData(ledger)[0]!.status, 'pending', 'registered before any test ends, kept for the teardown');
  assert.equal(existsSync(path.join(root, '..', 'dependencies', 'runs')), false, 'no run folder is created for plain Playwright');

  // after the run: the sweep removes it through the declared API (fake HTTP here)
  const lines: string[] = [];
  const f = fake((c) => (c.method === 'DELETE' ? 204 : 404));
  sweepAfterAdhocRun(root, (l) => lines.push(l), { fetch: f.fetch });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['DELETE /api/orders/ord-adhoc']);
  assert.equal(readCreatedData(ledger)[0]!.status, 'deleted');
  assert.match(lines.join('\n'), /1 removed after the tests, 0 left/);

  // an entity with no declared way to be removed is reported instead of guessed
  assert.deepEqual(saveConfig(root, withCleanup({ mode: 'sweep', entities: {} })), { ok: true });
  const s2 = startCleanup(root, { ...info, title: '[TC-10] Other' }, (x) => x, {});
  s2.register({ entity: 'order', identifier: 'ord-nopath', undo: () => {} });
  await s2.run();
  const lines2: string[] = [];
  sweepAfterAdhocRun(root, (l) => lines2.push(l), { fetch: f.fetch });
  assert.equal(f.calls.length, 1, 'no further request');
  assert.match(lines2.join('\n'), /ord-nopath/);
  assert.match(lines2.join('\n'), /1 left/);

  // without a valid config nothing is attempted, and nothing throws
  assert.equal(sweepAdhoc(root, null, { trigger: 'no config', fetch: f.fetch }).ran, false);
  const quiet: string[] = [];
  sweepAfterAdhocRun(path.join(root, 'nowhere'), (l) => quiet.push(l));
  assert.deepEqual(quiet, []);
});

test('adhoc-run passes its arguments to playwright, then sweeps, and returns playwright\'s exit code', (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(saveConfig(root, withCleanup({ mode: 'sweep', entities: {} })), { ok: true });
  // the ledger already holds a record from an earlier plain run; a stand-in Playwright CLI just exits 3
  const ledger = adhocLedgerDir(root);
  const pre = startCleanup(root, { file: 'tests/a.spec.ts', title: '[TC-1] A', retry: 0 }, (x) => x, {});
  pre.register({ entity: 'order', identifier: 'ord-before', undo: () => {} });
  const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, 'process.stdout.write("ARGS " + process.argv.slice(2).join(" ") + "\\n"); process.exit(3);\n');
  const r = spawnSync(process.execPath, [ADHOC_CLI, '--ui', '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /ARGS test --ui/);
  assert.match(r.stdout, /ord-before/, 'the leftover is reported after the tests');
  assert.equal(readSweepHistory(ledger).length, 1);
});

test('summaries list what is left, bounded, with the way to delete it', () => {
  const config = withCleanup();
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `k.${i}`, entity: 'order', identifier: `ord-${i}`, hint: null, registeredAt: '2026-10-22T09:00:00.000Z', status: 'pending' as const, removedBy: null, error: null,
    updatedAt: '2026-10-22T09:00:00.000Z', file: 'f', source: 'test' as const, label: 'initial', testKey: 'k', testId: 'TC-1', retry: 0,
  }));
  const summary = summarizeData(many, config);
  assert.equal(summary.leftovers.length, 25);
  const lines = leftoverLines(summary, 5);
  assert.equal(lines.length, 6);
  assert.match(lines[5]!, /20 more/);
  assert.match(lines[0]!, /DELETE \/api\/orders\/<identifier>/);
});

// ---- real HTTP: the helper process that makes the request ----

test('the default request helper sends the method and header values to a real server and reads the status', async (t) => {
  const seen: { method?: string; url?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.statusCode = req.method === 'GET' ? 404 : 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const root = tmpRoot(t);
  const dir = await leftBehind(root, [{ entity: 'order', identifier: 'ord-real' }]);
  const base = withCleanup({ mode: 'sweep', entities: { order: { api: { method: 'DELETE', path: '/api/orders/{id}', headersFromEnv: { Authorization: 'SWEEP_TOKEN' }, verifyPath: '/api/orders/{id}' } } } });
  const config = { ...base, app: { ...base.app, baseUrl: `http://127.0.0.1:${port}` } };
  // The sweep's request helper is a synchronous child process, so the sweep itself runs in another process and this one serves HTTP.
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(CLI), '..', 'pipeline', 'data-cleanup.ts')).href;
  const script = [
    `import { sweepData } from ${JSON.stringify(moduleUrl)};`,
    `const r = sweepData(${JSON.stringify(root)}, ${JSON.stringify(RUN)}, ${JSON.stringify(config)}, { trigger: 'real', env: { SWEEP_TOKEN: 'Bearer real-token' } });`,
    'process.stdout.write(JSON.stringify(r.actions));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 0, stderr);
  assert.deepEqual(seen, [
    { method: 'DELETE', url: '/api/orders/ord-real', auth: 'Bearer real-token' },
    { method: 'GET', url: '/api/orders/ord-real', auth: 'Bearer real-token' },
  ]);
  assert.equal((JSON.parse(stdout) as { result: string }[])[0]!.result, 'verified_gone');
  assert.equal(readCreatedData(dir)[0]!.status, 'verified_gone');
});

// ---- the CLI ----

function cli(root: string, ...args: string[]): { code: number | null; json: any } {
  const r = spawnSync(process.execPath, [CLI, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, PW_ENVIRONMENT: '' } });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }; // an error is JSON on stderr with exit code 1
}

test('cleanup record / status / resolve / data work from the command line, and leftovers never fail the command', (t) => {
  const root = tmpRoot(t);
  runFolder(root);
  assert.deepEqual(saveConfig(root, withCleanup({ mode: 'test', entities: { contact: { ui: { hint: 'Contacts > Delete' } } } })), { ok: true });

  const rec = cli(root, 'cleanup', 'record', RUN, '--entity', 'contact', '--identifier', 'con-9', '--hint', 'Contacts > open > Delete');
  assert.equal(rec.code, 0, JSON.stringify(rec.json));
  assert.equal(cli(root, 'cleanup', 'record', RUN, '--entity', 'contact', '--identifier', '../x').code, 2);
  assert.equal(cli(root, 'cleanup', 'record', RUN, '--entity', 'contact').code, 1, 'a missing argument is a usage error');

  const status = cli(root, 'cleanup', 'status', RUN);
  assert.equal(status.json.total, 1);
  assert.equal(status.json.leftovers[0].canBeDeletedBy, 'Contacts > open > Delete');

  const data = cli(root, 'cleanup', 'data', RUN);
  assert.equal(data.code, 0, 'leftovers are information, not an error');
  assert.equal(data.json.ran, false);
  assert.match(data.json.guard.reason, /no sweep/);
  assert.equal(data.json.summary.leftovers, 1);

  assert.equal(cli(root, 'cleanup', 'resolve', RUN, rec.json.id, '--status', 'failed').code, 1, 'a failure needs a note');
  assert.equal(cli(root, 'cleanup', 'resolve', RUN, 'nope.1', '--status', 'deleted').code, 2);
  assert.equal(cli(root, 'cleanup', 'resolve', RUN, rec.json.id, '--status', 'deleted').code, 0);
  assert.equal(cli(root, 'cleanup', 'status', RUN).json.leftovers.length, 0);
});

test('run stage and run finalize print a data block with what is left, and a failing stage triggers the sweep', (t) => {
  const root = tmpRoot(t);
  const created = cli(root, 'run', 'create', '--command', 'playwright-pipeline');
  assert.equal(created.code, 0, JSON.stringify(created.json));
  const runId = created.json.runId as string;
  assert.deepEqual(saveConfig(root, withCleanup({ mode: 'test' })), { ok: true });

  assert.equal(cli(root, 'run', 'stage', runId, 'preflight', 'running').json.data, undefined, 'no data created: nothing printed');
  recordExternally(runDir(root, runId), { entity: 'contact', identifier: 'con-1', hint: 'Contacts > Delete' });
  const failed = cli(root, 'run', 'stage', runId, 'preflight', 'failed', '--message', 'x');
  assert.equal(failed.code, 0);
  assert.equal(failed.json.data.created, 1);
  assert.equal(failed.json.data.leftovers, 1);
  assert.match(failed.json.data.lines[0], /contact "con-1".*Contacts > Delete/);
  assert.ok(existsSync(path.join(runDir(root, runId), ARTIFACTS.dataCleanup)));
});

// ---- review rule and summary ----

test('the static review flags a test that makes unique data without registering it for cleanup', () => {
  const head = "import { test, expect } from '../fixtures/test.ts';\nimport { uniqueSuffix } from '../helpers/test-data.ts';\n";
  const without = `${head}test('[TC-001] Create order', async ({ page }) => {\n  const name = uniqueSuffix('order');\n  await expect(page).toHaveURL(/orders/);\n});\n`;
  const withReg = `${head}test('[TC-001] Create order', async ({ page, cleanup }) => {\n  const name = uniqueSuffix('order');\n  cleanup.register({ entity: 'order', identifier: name });\n  await expect(page).toHaveURL(/orders/);\n});\n`;
  const noData = `${head}test('[TC-002] Open orders', async ({ page }) => {\n  await expect(page).toHaveURL(/orders/);\n});\n`;
  const rules = (src: string) => reviewSource('tests/orders.spec.ts', src).map((f) => f.rule);
  assert.ok(rules(without).includes('register-created-data'));
  assert.ok(!rules(withReg).includes('register-created-data'));
  assert.ok(!rules(noData).includes('register-created-data'));
  assert.equal(reviewSource('tests/orders.spec.ts', without).find((f) => f.rule === 'register-created-data')!.severity, 'major');
});

test('the run summary lists test data that is still there and how to delete it', () => {
  const summary = {
    runId: RUN, command: 'run-tests', generatedAt: '2026-10-22T10:00:00.000Z', categories: {}, runnerError: null, mode: null,
    counts: { total: 0, passed: 0, failed: 0, flaky: 0, healed: 0, blocked: 0, skipped: 0, unresolved: 0 },
    healing: { attempts: 0, healed: 0, stillFailing: 0, rejectedByGuard: 0 }, tests: [], unresolved: [], reporters: [],
    reportGeneration: { ok: true, durationMs: 0, failed: [], bytes: 0, files: 0 }, paths: {},
    testData: {
      created: 3, removed: 2, truncated: 0,
      leftovers: [{ id: 'k.1', entity: 'invoice', identifier: 'inv-9', status: 'failed', testId: 'TC-004', reason: 'the delete button was not found', canBeDeletedBy: 'Invoices > row > Delete' }],
    },
  } as unknown as RunSummary;
  const md = renderSummaryMarkdown(summary);
  assert.match(md, /## Test data/);
  assert.match(md, /Created 3 record\(s\) · removed 2 · still there 1/);
  assert.match(md, /invoice "inv-9" \(TC-004\) — the delete button was not found; delete: Invoices > row > Delete/);
  assert.ok(!renderSummaryMarkdown({ ...summary, testData: undefined } as unknown as RunSummary).includes('## Test data'), 'no data created: no section');
});

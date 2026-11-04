// The test ledger: what it records for each automated test case, and that its up-front plan agrees with what the stages then decide.
// Scenario: two test cases are explored, generated, reviewed and run; then the plugin's generator rules change, a case changes,
// the evidence goes stale, and a new case arrives. Each time the ledger must name the cheapest honest amount of work.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stageCommand, updateLedgerAfterStage } from '../engine/cli/stage-commands.ts';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import { writeEntry } from '../engine/pipeline/artifact-cache.ts';
import type { ExplorationRecord } from '../engine/pipeline/exploration.ts';
import { GENERATED_HEADER, GENERATION_SCHEMA_VERSION, type GenerationManifest } from '../engine/pipeline/generation.ts';
import { generationInputs, ruleVersions, testBlockHash, testDependencyHash } from '../engine/pipeline/generation-reuse.ts';
import { reviewInputs, reviewVersions } from '../engine/pipeline/review-reuse.ts';
import { createRun } from '../engine/pipeline/run-manager.ts';
import { ledgerPath, loadLedger, worstOutcome, type TestLedger } from '../engine/pipeline/test-ledger.ts';
import { slugify, type TestSpec, type TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeDep, writeFile, writeRunSpecs } from './helpers.ts';

const BASE = 'https://test.example.com';
const SIGN_IN = "getByRole('button', { name: 'Sign in' })";
const EMAIL = "getByLabel('Email')";
const FILE = 'tests/auth.spec.ts';
const SNAPSHOT = '- textbox "Email"\n- button "Sign in" [ref=e12]\n';

function mkSpec(id: string, steps: string[]): TestSpec {
  return {
    id, title: `${id} title`, source: { path: 'input/test-cases/auth.md', line: 1, originalId: id, sheet: null }, suite: 'Auth', module: 'Auth', moduleSlug: slugify('Auth'), priority: null, tags: [],
    preconditions: [], steps: steps.map((action, i) => ({ index: i + 1, action, expected: null })),
    expectedResults: ['something observable'], testData: [], ambiguities: [], status: 'ready',
  };
}

const SPECS = () => [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in'])];

function newRun(root: string, specs: TestSpec[]): { runId: string; doc: TestSpecDocument } {
  const { runId } = createRun(root, { command: 'generate-tests', config: validConfig() });
  return { runId, doc: writeRunSpecs(root, runId, specs) };
}

function cmd(root: string, group: string, action: string, runId: string, values: Record<string, unknown> = {}) {
  const r = stageCommand(root, group, action, [runId], values);
  return { code: r.code, value: r.value as Record<string, any> };
}

// What the explorer writes after observing the login page for these test cases.
function writeFresh(root: string, runId: string, ids: string[]): void {
  writeDep(root, `runs/${runId}/exploration/login.aria.yml`, SNAPSHOT);
  const elements = [
    { role: 'button', name: 'Sign in', testId: null, candidateLocator: SIGN_IN, confidence: 'high', notes: null },
    { role: 'textbox', name: 'Email', testId: null, candidateLocator: EMAIL, confidence: 'high', notes: null },
  ];
  writeDep(root, `runs/${runId}/exploration/fresh.json`, JSON.stringify({
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: `explore-${runId}`, baseUrl: BASE,
    startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:05:00Z',
    pages: [{ id: 'login', url: `${BASE}/login`, title: 'Login', snapshot: 'exploration/login.aria.yml', screenshot: null, elements }],
    specs: ids.map((testId) => ({ testId, status: 'explored', uncertainties: [], notes: null, steps: [{ index: 1, observed: 'login form', pageId: 'login', locators: [EMAIL, SIGN_IN] }] })),
    avoidedActions: [],
  }));
}

const TESTS = (extra = '') => `${GENERATED_HEADER}
import { test, expect } from '../fixtures/test.ts';

test.describe('Auth', () => {
  test('[TC-1] TC-1 title', { annotation: { type: 'testId', description: 'TC-1' } }, async ({ page }) => {
    await page.goto('/login');${extra}
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('[TC-2] TC-2 title', { annotation: { type: 'testId', description: 'TC-2' } }, async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
`;

const readRecord = (root: string, runId: string): ExplorationRecord => JSON.parse(readFileSync(path.join(runDir(root, runId), 'exploration', 'exploration.json'), 'utf8'));
const ledgerTests = (root: string) => (loadLedger(root, BASE) as { ledger: TestLedger }).ledger.tests;

// The plugin version and rule fingerprints init records in dependencies/state/scaffold.json.
function scaffold(root: string, pluginVersion: string, generator: string, reviewer = 'r1'): void {
  writeDep(root, 'state/scaffold.json', JSON.stringify({ pluginVersion, language: 'typescript', rules: { generator, reviewer } }));
}

// What the generator, the reviewer and the review seal leave in the artifact cache for a test.
function seal(root: string, runId: string, doc: TestSpecDocument, id: string): void {
  const spec = doc.specs.find((s) => s.id === id)!;
  const record = readRecord(root, runId);
  writeEntry(root, {
    kind: 'generation', name: id, runId, by: 'test', inputs: generationInputs(spec, record, validConfig(), testDependencyHash(root, FILE, id)), versions: ruleVersions(root),
    payload: { testId: id, file: FILE, title: `[${id}] ${spec.title}`, testSha256: testBlockHash(root, FILE, id)! },
  });
  const manifest: GenerationManifest = {
    schemaVersion: GENERATION_SCHEMA_VERSION, generatedAt: 'x', language: 'typescript', tests: [{ testId: id, file: FILE, title: spec.title }], excluded: [], sharedFilesChanged: [],
  };
  writeEntry(root, {
    kind: 'review', name: id, runId, by: 'test', inputs: reviewInputs({ rootDir: root, specs: doc, record, config: validConfig(), generation: manifest }, id, FILE)!, versions: reviewVersions(root),
    payload: { testId: id, file: FILE, reviewedBy: 'static+reviewer' },
  });
}

function writeSummary(root: string, runId: string, generatedAt: string, outcomes: Record<string, string>): void {
  writeDep(root, `runs/${runId}/summary.json`, JSON.stringify({
    schemaVersion: 1, runId, generatedAt,
    tests: Object.entries(outcomes).map(([testId, outcome]) => ({ key: `${testId}@chromium`, testId, title: testId, project: 'chromium', outcome, category: null, note: null, evidence: [] })),
  }));
}

// First run: explored, generated, reviewed, sealed and (through the summary) executed.
function builtProject(t: Parameters<typeof tmpRoot>[0]) {
  const root = tmpRoot(t);
  scaffold(root, '1.0.0', 'g1');
  const first = newRun(root, SPECS());
  writeFresh(root, first.runId, ['TC-1', 'TC-2']);
  assert.equal(cmd(root, 'explore', 'assemble', first.runId).code, 0);
  writeFile(root, FILE, TESTS());
  for (const id of ['TC-1', 'TC-2']) seal(root, first.runId, first.doc, id);
  writeSummary(root, first.runId, '2026-10-21T10:00:00Z', { 'TC-1': 'passed', 'TC-2': 'passed' });
  return { root, first };
}

const plan = (root: string, specs: TestSpec[] = SPECS()) => cmd(root, 'ledger', 'plan', newRun(root, specs).runId);
const NONE = { explorer: { freshTests: 0, revalidateOnlyTests: 0 }, generatorBatches: 0, reviewerTests: 0 };

test('the ledger ties each test case to its evidence, its test file, its review and its last execution', (t) => {
  const { root, first } = builtProject(t);
  const updated = cmd(root, 'ledger', 'update', first.runId);
  assert.deepEqual([updated.code, updated.value.recorded, updated.value.tests], [0, ['TC-1', 'TC-2'], 2]);

  const tc2 = ledgerTests(root)['TC-2']!;
  assert.equal(tc2.exploration?.runId, first.runId);
  assert.deepEqual(tc2.exploration?.pages, ['/login']);
  assert.match(tc2.exploration?.store ?? '', /^dependencies\/state\/exploration-store\/[0-9a-f]{12}\.json$/, 'a pointer to the store, relative to the project');
  assert.equal(tc2.exploration?.evidenceHash?.length, 64);
  assert.deepEqual([tc2.generated?.file, tc2.generated?.pluginVersion, tc2.generated?.generatorRules, tc2.generated?.runId], [FILE, '1.0.0', 'g1', first.runId]);
  assert.deepEqual([tc2.review?.reviewedBy, tc2.review?.reviewerRules], ['static+reviewer', 'r1']);
  assert.deepEqual([tc2.lastExecution?.outcome, tc2.lastPassed?.runId, tc2.history.length], ['passed', first.runId, 1]);
  assert.ok(ledgerPath(root, BASE).includes(path.join('state', 'ledger')));

  const shown = cmd(root, 'ledger', 'show', first.runId).value;
  assert.deepEqual(shown.pages, { '/login': ['TC-1', 'TC-2'] }, 'the page index says which tests share a page');
  assert.equal(shown.listed[0].file, FILE);
  assert.equal(stageCommand(root, 'ledger', 'show', [first.runId], { 'test-id': ['TC-2'] }).code, 0);
  assert.equal(stageCommand(root, 'ledger', 'show', [first.runId], { 'test-id': ['TC-9'] }).code, 2);

  // Recording again with nothing new changes nothing.
  assert.deepEqual(cmd(root, 'ledger', 'update', first.runId).value.recorded, []);
});

test('nothing changed: every test is unchanged and the plan needs no explorer, generator or reviewer', (t) => {
  const { root, first } = builtProject(t);
  cmd(root, 'ledger', 'update', first.runId);
  const p = plan(root);
  assert.equal(p.code, 0, JSON.stringify(p.value));
  assert.deepEqual(p.value.summary, { unchanged: 2, 're-review': 0, redesign: 0, explore: 0, new: 0 });
  assert.deepEqual(p.value.work, NONE);
  assert.deepEqual([p.value.unchanged, p.value.needWork], [['TC-1', 'TC-2'], []]);
});

test('a plugin update that changes the generator rules redesigns the tests and only revalidates the evidence', (t) => {
  const { root, first } = builtProject(t);
  cmd(root, 'ledger', 'update', first.runId);
  scaffold(root, '1.1.0', 'g2'); // the plugin was updated; its generator rules differ

  const second = newRun(root, SPECS());
  const p = cmd(root, 'ledger', 'plan', second.runId).value;
  assert.deepEqual(p.summary, { unchanged: 0, 're-review': 0, redesign: 2, explore: 0, new: 0 });
  assert.deepEqual(p.work, { explorer: { freshTests: 0, revalidateOnlyTests: 2 }, generatorBatches: 1, reviewerTests: 2 }, 'no re-exploration: one snapshot of the known page, one generator batch');
  assert.deepEqual(Object.values(p.causes), [2], 'one cause, shared by both tests');
  assert.match(Object.keys(p.causes)[0]!, /generator rules changed/);
  assert.equal(p.needWork[0].builtWith, '1.0.0', 'the ledger remembers which plugin built the test');

  // The preview and the real stages agree: the exploration plan wants a snapshot, never a fresh exploration...
  assert.deepEqual(cmd(root, 'explore', 'plan', second.runId).value.summary, { explore: 0, revalidate: 2, reuse: 0, covered: 0 });
  writeDep(root, `runs/${second.runId}/exploration/login.aria.yml`, SNAPSHOT);
  assert.equal(cmd(root, 'explore', 'revalidate', second.runId, { page: '/login', file: 'exploration/login.aria.yml' }).code, 0);
  writeDep(root, `runs/${second.runId}/exploration/fresh.json`, JSON.stringify({
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: null, baseUrl: BASE, startedAt: 'x', endedAt: 'x', pages: [], specs: [], avoidedActions: [],
  }));
  const assembled = cmd(root, 'explore', 'assemble', second.runId);
  assert.equal(assembled.code, 0, JSON.stringify(assembled.value));

  // ...and generation rebuilds both tests, pointing the generator at the versions already in the file.
  assert.deepEqual(cmd(root, 'generate', 'plan', second.runId).value.summary, { generate: 2, reuse: 0 });
  const agents = stageCommand(root, 'agents', 'plan', [second.runId, 'test_generation'], {}).value as { briefs: string[] };
  const briefPath = agents.briefs[0]!;
  const brief = JSON.parse(readFileSync(path.join(runDir(root, second.runId), briefPath), 'utf8'));
  assert.deepEqual(Object.keys(brief.redesign), ['TC-1', 'TC-2']);
  assert.equal(brief.redesign['TC-1'].previousFile, FILE);
  assert.match(brief.redesign['TC-1'].why, /generator rules changed/);
  assert.ok(brief.rules.some((r: string) => /edit that test in place/.test(r)));
});

test('a changed test case is explored again, a new one is new, and stale evidence is explored again; neighbours stay unchanged', (t) => {
  const { root, first } = builtProject(t);
  cmd(root, 'ledger', 'update', first.runId);

  const changed = plan(root, [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in', 'check the error'])]).value;
  assert.deepEqual(changed.summary, { unchanged: 1, 're-review': 0, redesign: 0, explore: 1, new: 0 });
  assert.match(changed.needWork[0].why, /test case changed/);
  assert.deepEqual(changed.work, { explorer: { freshTests: 1, revalidateOnlyTests: 0 }, generatorBatches: 1, reviewerTests: 1 });

  const added = plan(root, [...SPECS(), mkSpec('TC-3', ['open login', 'sign out'])]).value;
  assert.deepEqual(added.summary, { unchanged: 2, 're-review': 0, redesign: 0, explore: 0, new: 1 });

  assert.equal(cmd(root, 'explore', 'invalidate', first.runId, { page: '/login', locator: SIGN_IN, reason: 'redesigned' }).code, 0);
  const stale = plan(root).value;
  assert.equal(stale.summary.explore, 2, 'a locator that no longer holds sends both tests back to exploration');
  assert.match(stale.needWork[0].why, /stale: .*redesigned/);
});

test('a test edited by hand is rebuilt; a changed reviewer rule only redoes the review', (t) => {
  const { root, first } = builtProject(t);
  cmd(root, 'ledger', 'update', first.runId);

  writeFile(root, FILE, TESTS('\n    await page.waitForTimeout(1);'));
  const edited = plan(root).value;
  assert.equal(edited.summary.redesign, 1, 'TC-1 was modified after it was reviewed');
  assert.equal(edited.summary.unchanged, 1, 'TC-2 block is untouched');

  writeFile(root, FILE, TESTS());
  scaffold(root, '1.0.0', 'g1', 'r2'); // only the reviewer rules changed
  const review = plan(root).value;
  assert.deepEqual(review.summary, { unchanged: 0, 're-review': 2, redesign: 0, explore: 0, new: 0 });
  assert.deepEqual(review.work, { explorer: { freshTests: 0, revalidateOnlyTests: 0 }, generatorBatches: 0, reviewerTests: 2 });
});

test('execution history is kept for context: the last pass survives a failure, a flaky run is not a pass, and nothing is skipped because of it', (t) => {
  const { root, first } = builtProject(t);
  cmd(root, 'ledger', 'update', first.runId);

  const second = newRun(root, SPECS());
  writeSummary(root, second.runId, '2026-10-22T10:00:00Z', { 'TC-1': 'failed', 'TC-2': 'flaky' });
  cmd(root, 'ledger', 'update', second.runId);
  const tests = ledgerTests(root);
  assert.deepEqual([tests['TC-1']!.lastExecution?.outcome, tests['TC-1']!.lastPassed?.runId, tests['TC-1']!.history.map((h) => h.outcome)], ['failed', first.runId, ['passed', 'failed']]);
  assert.deepEqual([tests['TC-2']!.lastExecution?.outcome, tests['TC-2']!.lastPassed?.runId], ['flaky', first.runId]);

  // A failing last run does not change what the next run must build: the ledger never decides to skip or to re-run anything.
  const next = plan(root).value;
  assert.deepEqual([next.summary.unchanged, next.needWork.length], [2, 0]);
  assert.equal(plan(root).value.unchanged.length, 2);

  assert.equal(worstOutcome(['passed', 'failed', 'flaky']), 'failed');
  assert.equal(worstOutcome(['passed', 'healed']), 'healed');
  assert.equal(worstOutcome([]), null);
});

test('the ledger is only an index: a corrupt or missing ledger changes no decision, and a corrupt one is rebuilt', (t) => {
  const { root, first } = builtProject(t);
  const without = plan(root).value;
  assert.equal(without.ledger.status, 'missing');
  assert.deepEqual(without.summary, { unchanged: 2, 're-review': 0, redesign: 0, explore: 0, new: 0 }, 'the caches and the store decide, not the ledger');

  cmd(root, 'ledger', 'update', first.runId);
  writeFileSync(ledgerPath(root, BASE), '{ not json');
  const corrupt = plan(root).value;
  assert.equal(corrupt.ledger.status, 'corrupt');
  assert.equal(corrupt.summary.unchanged, 2);
  const rebuilt = cmd(root, 'ledger', 'update', first.runId).value;
  assert.deepEqual([rebuilt.recorded, typeof rebuilt.rebuilt], [['TC-1', 'TC-2'], 'string']);
  assert.equal(loadLedger(root, BASE).status, 'ok');
});

test('finishing report generation records the run in the ledger by itself, and the ledger is per environment', (t) => {
  const { root, first } = builtProject(t);
  updateLedgerAfterStage(root, first.runId, 'application_exploration', 'completed');
  assert.equal(loadLedger(root, BASE).status, 'missing', 'only the stages that settle a test record it');
  updateLedgerAfterStage(root, first.runId, 'report_generation', 'running');
  assert.equal(loadLedger(root, BASE).status, 'missing');
  updateLedgerAfterStage(root, first.runId, 'report_generation', 'completed');
  assert.equal(loadLedger(root, BASE).status, 'ok');
  assert.notEqual(ledgerPath(root, BASE), ledgerPath(root, 'https://other.example.com'));
  assert.equal(loadLedger(root, 'https://other.example.com').status, 'missing');
});

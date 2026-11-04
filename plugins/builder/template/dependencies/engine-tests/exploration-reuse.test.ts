import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stageCommand } from '../engine/cli/stage-commands.ts';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import { writeEntry } from '../engine/pipeline/artifact-cache.ts';
import { validateExplorationRecord, type ExplorationRecord } from '../engine/pipeline/exploration.ts';
import { GENERATED_HEADER } from '../engine/pipeline/generation.ts';
import { explorationEvidenceHash, generationInputs, ruleVersions, testBlockHash, testDependencyHash } from '../engine/pipeline/generation-reuse.ts';
import { checkElements, parseAriaSnapshot } from '../engine/pipeline/exploration-reuse.ts';
import {
  invalidateFromFailures, loadStore, locatorsInError, pageKey, specFingerprint, storePath, type ObservationStore, type StoredPage,
} from '../engine/pipeline/exploration-store.ts';
import type { FailureAnalysis } from '../engine/pipeline/failure-classifier.ts';
import { buildRunMetrics } from '../engine/pipeline/metrics.ts';
import { createRun, loadManifest } from '../engine/pipeline/run-manager.ts';
import { slugify, type TestSpec, type TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeDep, writeFile, writeRunSpecs } from './helpers.ts';

const BASE = 'https://test.example.com';
const SIGN_IN = "getByRole('button', { name: 'Sign in' })";
const EMAIL = "getByLabel('Email')";
const LOGIN_SNAPSHOT = '- textbox "Email"\n- button "Sign in" [ref=e12]\n';

function mkSpec(id: string, steps: string[], suite: string | null = 'Auth'): TestSpec {
  return {
    id, title: `${id} title`, source: { path: 'input/cases.md', line: 1, originalId: id, sheet: null }, suite, module: suite ?? 'General', moduleSlug: slugify(suite ?? 'General'), priority: null, tags: [],
    preconditions: [], steps: steps.map((action, i) => ({ index: i + 1, action, expected: null })),
    expectedResults: ['something observable'], testData: [], ambiguities: [], status: 'ready',
  };
}

function newRun(root: string, specs: TestSpec[], config = validConfig()): string {
  const { runId } = createRun(root, { command: 'generate-tests', config });
  writeRunSpecs(root, runId, specs);
  return runId;
}

function call(root: string, action: string, runId: string, values: Record<string, unknown> = {}) {
  const r = stageCommand(root, 'explore', action, [runId], values);
  return { code: r.code, value: r.value as Record<string, any> };
}

// What the explorer would write after observing the login page for the given test cases.
function writeFresh(root: string, runId: string, specIds: string[], opts: { locators?: string[]; withEmail?: boolean; noPages?: boolean } = {}): void {
  const rel = `runs/${runId}`;
  writeDep(root, `${rel}/exploration/login.aria.yml`, LOGIN_SNAPSHOT);
  const elements = [
    { role: 'button', name: 'Sign in', testId: null, candidateLocator: SIGN_IN, confidence: 'high', notes: null },
    ...(opts.withEmail === false ? [] : [{ role: 'textbox', name: 'Email', testId: null, candidateLocator: EMAIL, confidence: 'high', notes: null }]),
  ];
  const record = {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: `explore-${runId}`, baseUrl: BASE,
    startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:05:00Z',
    pages: opts.noPages ? [] : [{ id: 'login', url: `${BASE}/login/`, title: 'Login', snapshot: 'exploration/login.aria.yml', screenshot: null, elements }],
    specs: specIds.map((testId) => ({
      testId, status: 'explored', uncertainties: [], notes: null,
      steps: [{ index: 1, observed: 'login form shown', pageId: 'login', locators: opts.locators ?? [EMAIL, SIGN_IN] }],
    })),
    avoidedActions: [],
  };
  writeDep(root, `${rel}/exploration/fresh.json`, JSON.stringify(record));
}

function writeSnapshot(root: string, runId: string, name: string, text: string): string {
  const rel = `exploration/${name}`;
  writeDep(root, `runs/${runId}/${rel}`, text);
  return rel;
}

function readRecord(root: string, runId: string): ExplorationRecord {
  return JSON.parse(readFileSync(path.join(runDir(root, runId), 'exploration', 'exploration.json'), 'utf8'));
}

// ---------- pure helpers ----------

test('aria snapshots are parsed for role and accessible name', () => {
  const nodes = parseAriaSnapshot('- heading "Home" [level=1]\n  - button "Say \\"hi\\"" [ref=e3]\n- link /Docs.*/\n- text: plain\n');
  assert.deepEqual(nodes, [
    { role: 'heading', name: 'Home' },
    { role: 'button', name: 'Say "hi"' },
    { role: 'link', name: null },
    { role: 'text', name: null },
  ]);
});

test('page identity ignores origin-less noise but never crosses origins', () => {
  assert.equal(pageKey(`${BASE}/login/?next=/a`, BASE), '/login');
  assert.equal(pageKey('/', BASE), '/');
  assert.equal(pageKey('/app#/orders', BASE), '/app#/orders');
  assert.equal(pageKey('/app#section', BASE), '/app');
  assert.equal(pageKey('https://other.example.com/login', BASE), null);
});

test('element checks distinguish present, missing, ambiguous and unprovable controls', () => {
  const el = (role: string | null, name: string | null, locator: string) => ({
    role, name, testId: null, candidateLocator: locator, confidence: 'high', notes: null,
    runId: 'r', observedAt: 'x', lastRevalidatedAt: null, status: 'verified', staleReason: null, staleAt: null,
  });
  const page = {
    key: '/p', url: '/p', title: null, evidence: { snapshot: null, screenshot: null },
    elements: [el('button', 'Save', 'a'), el('button', 'Gone', 'b'), el('link', 'Docs', 'c'), el(null, null, 'd'), { ...el('button', 'Old', 'e'), status: 'stale' }],
  } as unknown as StoredPage;
  const checks = checkElements(page, '- button "Save"\n- link "Docs"\n- link "Docs"\n');
  assert.deepEqual(Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.state])), {
    a: 'present', b: 'missing', c: 'ambiguous', d: 'unverifiable',
  });
});

test('a test case fingerprint changes when its steps change', () => {
  const a = mkSpec('TC-1', ['open /login']);
  assert.equal(specFingerprint(a), specFingerprint(mkSpec('TC-1', ['open /login'])));
  assert.notEqual(specFingerprint(a), specFingerprint(mkSpec('TC-1', ['open /login', 'click Sign in'])));
});

test('reused pages are only valid with proof of revalidation in this run', (t) => {
  const root = tmpRoot(t);
  const rec = {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: null, session: null, baseUrl: BASE, startedAt: '', endedAt: '',
    pages: [{ id: 'p', url: '/p', title: null, snapshot: null, screenshot: null, elements: [], provenance: { source: 'reused' } }],
    specs: [], avoidedActions: [],
  };
  const issues = validateExplorationRecord(rec, { runDir: root, specs: null });
  assert.ok(issues.some((i) => /no revalidatedAt/.test(i)));
  assert.ok(issues.some((i) => /no snapshot from this run/.test(i)));
});

// ---------- the full flow ----------

test('first run explores everything and saves observations; nothing is reused without a store', (t) => {
  const root = tmpRoot(t);
  const runId = newRun(root, [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in'])]);
  const plan = call(root, 'plan', runId).value;
  assert.deepEqual(plan.summary, { explore: 2, revalidate: 0, reuse: 0, covered: 0 });
  assert.equal(plan.store.status, 'missing');
  assert.deepEqual(plan.groups.map((g: any) => [g.module, g.specIds]), [['Auth', ['TC-1', 'TC-2']]]);

  writeFresh(root, runId, ['TC-1', 'TC-2']);
  const res = call(root, 'assemble', runId);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  const rec = readRecord(root, runId);
  assert.equal(rec.pages[0]!.provenance?.source, 'fresh');
  assert.deepEqual(rec.reuse?.freshSpecs, ['TC-1', 'TC-2']);

  const state = loadStore(root, BASE);
  assert.equal(state.status, 'ok');
  assert.ok(state.status === 'ok' && state.store.pages['/login']!.elements.length === 2);
  assert.ok(state.status === 'ok' && Object.keys(state.store.specs).join() === 'TC-1,TC-2');
});

test('unchanged test cases are reused only after a snapshot from the new run confirms the locators', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1', 'TC-2']);
  assert.equal(call(root, 'assemble', first).code, 0);

  const second = newRun(root, specs);
  const plan = call(root, 'plan', second).value;
  assert.deepEqual(plan.summary, { explore: 0, revalidate: 2, reuse: 0, covered: 0 }, 'saved evidence alone is not enough');
  assert.deepEqual(plan.pagesToRevalidate.map((p: any) => p.key), ['/login']);
  assert.deepEqual(plan.groups[0].sharedPages, ['/login'], 'both cases share one page');

  // Assembling before revalidating must refuse to reuse. (Nothing was visited, so fresh.json has no pages.)
  writeFresh(root, second, [], { noPages: true });
  const early = call(root, 'assemble', second);
  assert.equal(early.code, 2);
  assert.match(early.value.issues[0], /TC-1: saved evidence has not been revalidated/);

  const snap = writeSnapshot(root, second, 'login-recheck.aria.yml', LOGIN_SNAPSHOT);
  const rv = call(root, 'revalidate', second, { page: '/login', file: snap });
  assert.deepEqual(rv.value.summary, { explore: 0, revalidate: 0, reuse: 2, covered: 0 });

  const res = call(root, 'assemble', second);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  const rec = readRecord(root, second);
  assert.deepEqual(rec.reuse?.reusedSpecs, ['TC-1', 'TC-2']);
  assert.deepEqual(rec.reuse?.freshSpecs, []);
  const page = rec.pages[0]!;
  assert.equal(page.provenance?.source, 'reused');
  assert.equal(page.snapshot, snap, 'evidence is this run’s snapshot, not a path into the old run');
  assert.deepEqual(rec.specs.map((s) => [s.testId, s.steps[0]!.pageId]), [['TC-1', page.id], ['TC-2', page.id]]);
  assert.deepEqual(validateExplorationRecord(rec, { runDir: runDir(root, second), specs: null }), []);

  // Metrics report the reuse.
  const m = loadManifest(root, second);
  assert.ok(m.ok);
  const manifest = { ...m.manifest!, artifacts: { exploration: 'exploration/exploration.json' } };
  assert.deepEqual(buildRunMetrics(root, manifest).exploration, {
    pages: 1, pagesFresh: 0, pagesReused: 1, elementsReused: 2, specs: 2, specsReused: 2, specsFresh: 0,
  });
});

test('a changed test case is explored again while its unchanged neighbours are still reused', (t) => {
  const root = tmpRoot(t);
  const first = newRun(root, [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in'])]);
  writeFresh(root, first, ['TC-1', 'TC-2']);
  call(root, 'assemble', first);

  const second = newRun(root, [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in', 'sign out'])]);
  const plan = call(root, 'plan', second).value;
  const byId = Object.fromEntries(plan.specs.map((s: any) => [s.testId, s]));
  assert.equal(byId['TC-1'].action, 'revalidate');
  assert.equal(byId['TC-2'].action, 'explore');
  assert.match(byId['TC-2'].reason, /test case changed/);

  call(root, 'revalidate', second, { page: `${BASE}/login`, file: writeSnapshot(root, second, 's.aria.yml', LOGIN_SNAPSHOT) });
  writeFresh(root, second, ['TC-2']);
  assert.equal(call(root, 'assemble', second).code, 0);
  const rec = readRecord(root, second);
  assert.deepEqual(rec.reuse?.reusedSpecs, ['TC-1']);
  assert.deepEqual(rec.reuse?.freshSpecs, ['TC-2']);
  assert.equal(rec.pages.length, 1, 'the fresh observation of /login absorbs the reused page');
  assert.equal(rec.pages[0]!.provenance?.source, 'fresh');
  assert.equal(rec.specs.find((s) => s.testId === 'TC-1')!.steps[0]!.pageId, 'login', 'reused case remapped onto the fresh page');
});

test('a locator missing from the new snapshot is invalidated with a reason and forces re-exploration', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  const second = newRun(root, specs);
  const rv = call(root, 'revalidate', second, {
    page: '/login', file: writeSnapshot(root, second, 's.aria.yml', '- textbox "Email"\n- button "Log in"\n'),
  });
  assert.equal(rv.value.elements[SIGN_IN].state, 'missing');
  assert.equal(rv.value.elements[EMAIL].state, 'present');
  assert.deepEqual(rv.value.summary, { explore: 1, revalidate: 0, reuse: 0, covered: 0 });
  assert.match(rv.value.specs[0].reason, /is stale: revalidation \(.+\): no button named "Sign in" in the current snapshot/);

  const state = loadStore(root, BASE);
  assert.ok(state.status === 'ok');
  const stale = state.store.pages['/login']!.elements.find((e) => e.candidateLocator === SIGN_IN)!;
  assert.equal(stale.status, 'stale');
  assert.match(stale.staleReason!, new RegExp(`revalidation \\(${second}\\)`));

  // The invalidation outlives the run: a later run is told why it must explore.
  const third = newRun(root, specs);
  const plan = call(root, 'plan', third).value;
  assert.equal(plan.specs[0].action, 'explore');
  assert.match(plan.specs[0].reason, /is stale: revalidation/);

  // Exploring again replaces the stale element with a verified one.
  writeFresh(root, third, ['TC-1']);
  assert.equal(call(root, 'assemble', third).code, 0);
  const after = loadStore(root, BASE);
  assert.ok(after.status === 'ok' && after.store.pages['/login']!.elements.every((e) => e.status === 'verified'));
});

test('an ambiguous or unprovable locator is never reused', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  const second = newRun(root, specs);
  const rv = call(root, 'revalidate', second, {
    page: '/login', file: writeSnapshot(root, second, 's.aria.yml', '- textbox "Email"\n- button "Sign in"\n- button "Sign in"\n'),
  });
  assert.equal(rv.value.elements[SIGN_IN].state, 'ambiguous');
  assert.equal(rv.value.summary.explore, 1);
});

test('a corrupt store is rejected, reported and replaced rather than trusted', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  writeFileSync(storePath(root, BASE), '{ "schemaVersion": 1, "origin": "https://test.example.com", "pages": {');
  const second = newRun(root, specs);
  const plan = call(root, 'plan', second).value;
  assert.equal(plan.store.status, 'corrupt');
  assert.equal(plan.specs[0].action, 'explore');
  assert.equal(call(root, 'revalidate', second, { page: '/login', file: writeSnapshot(root, second, 's.aria.yml', LOGIN_SNAPSHOT) }).code, 2);

  writeFresh(root, second, ['TC-1']);
  assert.equal(call(root, 'assemble', second).code, 0);
  assert.equal(loadStore(root, BASE).status, 'ok', 'replaced by a valid store built from fresh evidence');

  // Structurally wrong but parseable content is also refused.
  const store = JSON.parse(readFileSync(storePath(root, BASE), 'utf8'));
  store.pages['/login'].key = '/other';
  writeFileSync(storePath(root, BASE), JSON.stringify(store));
  assert.equal(loadStore(root, BASE).status, 'corrupt');
});

test('evidence is per environment: another base URL starts empty', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  const other = validConfig();
  other.app.baseUrl = 'https://staging.example.com';
  const second = newRun(root, specs, other);
  const plan = call(root, 'plan', second).value;
  assert.equal(plan.store.status, 'missing');
  assert.equal(plan.summary.explore, 1);
});

test('--fresh forces exploration even when valid evidence exists', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  const second = newRun(root, specs);
  const plan = call(root, 'plan', second, { fresh: true }).value;
  assert.equal(plan.specs[0].action, 'explore');
  assert.match(plan.specs[0].reason, /fresh exploration was requested/);
  call(root, 'revalidate', second, { page: '/login', file: writeSnapshot(root, second, 's.aria.yml', LOGIN_SNAPSHOT) });
  assert.equal(call(root, 'plan', second).value.specs[0].action, 'explore', 'the choice sticks for the run');
});

test('evidence from another origin is never stored', (t) => {
  const root = tmpRoot(t);
  const first = newRun(root, [mkSpec('TC-1', ['open login'])]);
  writeFresh(root, first, ['TC-1']);
  const file = path.join(runDir(root, first), 'exploration', 'fresh.json');
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  rec.pages[0].url = 'https://elsewhere.example.com/login';
  writeFileSync(file, JSON.stringify(rec));
  assert.equal(call(root, 'assemble', first).code, 0);
  const state = loadStore(root, BASE);
  assert.ok(state.status === 'ok' && Object.keys(state.store.pages).length === 0 && Object.keys(state.store.specs).length === 0);
});

test('assemble refuses a fresh record that fails validation', (t) => {
  const root = tmpRoot(t);
  const first = newRun(root, [mkSpec('TC-1', ['open login'])]);
  writeFresh(root, first, ['TC-1'], { locators: ['e12'] });
  const res = call(root, 'assemble', first);
  assert.equal(res.code, 2);
  assert.match(res.value.issues.join(), /temporary CLI element reference/);
  assert.equal(loadStore(root, BASE).status, 'missing', 'nothing saved from an invalid record');
});

// ---------- execution feedback ----------

function storeWith(locator: string): ObservationStore {
  const el = {
    role: 'button', name: 'Sign in', testId: null, candidateLocator: locator, confidence: 'high', notes: null,
    runId: 'r', observedAt: 'x', lastRevalidatedAt: null, status: 'verified', staleReason: null, staleAt: null,
  };
  return {
    schemaVersion: 1, origin: BASE, updatedAt: 'x', specs: {}, invalidations: [],
    pages: { '/login': { key: '/login', url: '/login', title: null, evidence: { snapshot: null, screenshot: null }, elements: [el] } },
  } as unknown as ObservationStore;
}

function analysis(signals: string[], errorExcerpt: string): FailureAnalysis {
  return {
    schemaVersion: 1, analyzedAt: 'x', sourceRunId: '20261020-000000-aaaaaa', sourceLabel: 'initial',
    failures: [{ key: 'TC-1@chromium', testId: 'TC-1', signals, errorExcerpt }],
  } as unknown as FailureAnalysis;
}

test('locators are read from Playwright failure messages', () => {
  assert.deepEqual(locatorsInError("Locator: getByRole('button', { name: 'Sign in' })\nExpected: visible"), [SIGN_IN]);
  assert.deepEqual(locatorsInError("Call log:\n  - waiting for getByLabel('Email')\n"), [EMAIL]);
});

test('a locator that failed to resolve in execution makes its saved observation stale', () => {
  const err = `Error: expect(locator).toBeVisible() failed\n\nLocator: ${SIGN_IN}\nReceived: <element(s) not found>`;
  const r = invalidateFromFailures(storeWith(SIGN_IN), analysis(['locator found no element'], err), '2026-10-20T00:00:00Z');
  assert.equal(r.invalidated.length, 1);
  const el = r.store.pages['/login']!.elements[0]!;
  assert.equal(el.status, 'stale');
  assert.match(el.staleReason!, /execution \(20261020-000000-aaaaaa, TC-1\): locator found no element/);
  assert.equal(r.store.invalidations.length, 1);
});

test('assertion failures and unrelated locators do not invalidate observations', () => {
  const mismatch = analysis(['assertion value mismatch'], `Locator: ${SIGN_IN}\nExpected: "A"\nReceived: "B"`);
  assert.equal(invalidateFromFailures(storeWith(SIGN_IN), mismatch, 'x').invalidated.length, 0);
  const other = analysis(['locator found no element'], "Locator: getByRole('link', { name: 'Docs' })\n<element(s) not found>");
  assert.equal(invalidateFromFailures(storeWith(SIGN_IN), other, 'x').invalidated.length, 0);
});

test('manual invalidation records the reason and survives for the next run', (t) => {
  const root = tmpRoot(t);
  const specs = [mkSpec('TC-1', ['open login'])];
  const first = newRun(root, specs);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);

  const second = newRun(root, specs);
  const res = call(root, 'invalidate', second, { page: '/login', reason: 'login page was redesigned', locator: SIGN_IN });
  assert.equal(res.value.invalidatedElements, 1);
  const plan = call(root, 'plan', newRun(root, specs)).value;
  assert.match(plan.specs[0].reason, /login page was redesigned/);
  assert.equal(call(root, 'store', second).value.elements.stale, 1);
});

// ---------- consistency: a step may only name locators its page lists ----------

test('a step locator that its page does not list is rejected, and the validator says how to fix it', (t) => {
  const root = tmpRoot(t);
  const el = (loc: string) => ({ role: 'textbox', name: null, testId: null, candidateLocator: loc, confidence: 'high', notes: null });
  const record = (listed: string[]) => ({
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: null, session: null, baseUrl: BASE, startedAt: '', endedAt: '',
    pages: [{ id: 'otp', url: '/', title: null, snapshot: null, screenshot: null, elements: listed.map(el) }],
    specs: [{ testId: 'TC-1', status: 'explored', uncertainties: [], notes: null, steps: [{ index: 1, observed: 'six digit boxes', pageId: 'otp', locators: ["getByRole('textbox').nth(0)", "getByRole('textbox').nth(5)"] }] }],
    avoidedActions: [],
  });
  const issues = validateExplorationRecord(record(["getByRole('textbox').nth(0)"]), { runDir: root, specs: null });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /TC-1 step 1: locator getByRole\('textbox'\)\.nth\(5\) is not listed in the elements of page "otp"; add it there/);
  assert.deepEqual(validateExplorationRecord(record(["getByRole('textbox').nth(0)", "getByRole('textbox').nth(5)"]), { runDir: root, specs: null }), []);
});

test('assemble refuses an explorer record whose steps name unlisted locators, so the store never holds them', (t) => {
  const root = tmpRoot(t);
  const runId = newRun(root, [mkSpec('TC-1', ['open login'])]);
  writeFresh(root, runId, ['TC-1'], { withEmail: false }); // steps name EMAIL, the page lists only Sign in
  const res = call(root, 'assemble', runId);
  assert.equal(res.code, 2);
  assert.match(res.value.issues.join(), /not listed in the elements of page "login"/);
  assert.equal(loadStore(root, BASE).status, 'missing', 'nothing was saved');
});

// ---------- covered: a still-current generated test makes exploration unnecessary ----------

const SPEC_FILE = 'tests/auth.spec.ts';
const GENERATED = (extra = '') => `${GENERATED_HEADER}
import { test, expect } from '../fixtures/test.ts';

test.describe('Auth', () => {
  test('[TC-1] TC-1 title', { annotation: { type: 'testId', description: 'TC-1' } }, async ({ page }) => {
    await page.goto('/login');${extra}
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
`;

// What the generator and the review seal leave in the artifact cache for a test case.
function sealGenerated(root: string, runId: string, spec: TestSpec): void {
  const rec = readRecord(root, runId);
  writeEntry(root, {
    kind: 'generation', name: spec.id, runId, by: 'test',
    inputs: generationInputs(spec, rec, validConfig(), testDependencyHash(root, SPEC_FILE, spec.id)),
    versions: ruleVersions(root),
    payload: { testId: spec.id, file: SPEC_FILE, title: `[${spec.id}] ${spec.title}`, testSha256: testBlockHash(root, SPEC_FILE, spec.id)! },
  });
}

function firstRunWithGeneratedTest(root: string, spec: TestSpec): string {
  const first = newRun(root, [spec]);
  writeFresh(root, first, [spec.id]);
  assert.equal(call(root, 'assemble', first).code, 0);
  writeFile(root, SPEC_FILE, GENERATED());
  sealGenerated(root, first, spec);
  return first;
}

test('an unchanged test case with a still-current generated test is covered: no exploration, no revalidation, no explorer', (t) => {
  const root = tmpRoot(t);
  const spec = mkSpec('TC-1', ['open login']);
  const first = firstRunWithGeneratedTest(root, spec);

  const second = newRun(root, [spec]);
  const plan = call(root, 'plan', second).value;
  assert.deepEqual(plan.summary, { explore: 0, revalidate: 0, reuse: 0, covered: 1 });
  assert.deepEqual(plan.pagesToRevalidate, [], 'no snapshot is asked for');
  assert.match(plan.specs[0].reason, /generated test in tests\/auth\.spec\.ts is unchanged and still valid/);

  // No explorer ran, so there is no fresh.json: assemble builds the record from the store.
  const res = call(root, 'assemble', second);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  const rec = readRecord(root, second);
  assert.deepEqual(rec.reuse?.reusedSpecs, ['TC-1']);
  assert.deepEqual(rec.reuse?.coveredSpecs, ['TC-1']);
  assert.deepEqual(rec.reuse?.freshSpecs, []);
  assert.equal(rec.pages[0]!.provenance?.source, 'saved');
  assert.equal(rec.pages[0]!.snapshot, null);
  assert.deepEqual(validateExplorationRecord(rec, { runDir: runDir(root, second), specs: null }), []);

  // The evidence hash does not change, so generation is reused too: the whole run needs no agent before execution.
  assert.equal(explorationEvidenceHash(rec, 'TC-1'), explorationEvidenceHash(readRecord(root, first), 'TC-1'));
  const gen = stageCommand(root, 'generate', 'plan', [second], {});
  assert.deepEqual((gen.value as any).summary, { generate: 0, reuse: 1 });
});

test('--revalidate, --fresh and --no-cache switch coverage off for the run', (t) => {
  const root = tmpRoot(t);
  const spec = mkSpec('TC-1', ['open login']);
  firstRunWithGeneratedTest(root, spec);

  const revalidate = newRun(root, [spec]);
  assert.equal(call(root, 'plan', revalidate, { revalidate: true }).value.specs[0].action, 'revalidate');
  assert.equal(call(root, 'plan', revalidate).value.specs[0].action, 'revalidate', 'the choice sticks to the run');

  const fresh = newRun(root, [spec]);
  assert.equal(call(root, 'plan', fresh, { fresh: true }).value.specs[0].action, 'explore');

  const noCache = newRun(root, [spec]);
  assert.equal(call(root, 'plan', noCache, { 'no-cache': true }).value.specs[0].action, 'revalidate');
});

test('coverage needs the generated test to be current: an edited test, a changed test case or stale evidence is not covered', (t) => {
  const root = tmpRoot(t);
  const spec = mkSpec('TC-1', ['open login']);
  const first = firstRunWithGeneratedTest(root, spec);
  const planned = (specs: TestSpec[]) => call(root, 'plan', newRun(root, specs)).value.specs[0];

  assert.equal(planned([spec]).action, 'covered');

  writeFile(root, SPEC_FILE, GENERATED('\n    await page.waitForTimeout(1);'));
  assert.equal(planned([spec]).action, 'revalidate', 'the test was edited after it was reviewed');

  writeFile(root, SPEC_FILE, GENERATED());
  assert.equal(planned([spec]).action, 'covered', 'restoring the reviewed test makes it current again');

  assert.equal(planned([mkSpec('TC-1', ['open login', 'sign in'])]).action, 'explore', 'the test case changed');

  call(root, 'invalidate', first, { page: '/login', reason: 'redesigned', locator: SIGN_IN });
  assert.equal(planned([spec]).action, 'explore', 'stale evidence is explored again');
});

test('coverage is not offered when no generated test was ever sealed', (t) => {
  const root = tmpRoot(t);
  const spec = mkSpec('TC-1', ['open login']);
  const first = newRun(root, [spec]);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);
  assert.equal(call(root, 'plan', newRun(root, [spec])).value.specs[0].action, 'revalidate');
});

test('a covered test case stays valid when a fresh exploration of another case covers the same page', (t) => {
  const root = tmpRoot(t);
  const spec = mkSpec('TC-1', ['open login']);
  const other = mkSpec('TC-2', ['open login', 'sign in']);
  const first = newRun(root, [spec]);
  writeFresh(root, first, ['TC-1']);
  call(root, 'assemble', first);
  writeFile(root, SPEC_FILE, GENERATED());
  sealGenerated(root, first, spec);

  const second = newRun(root, [spec, other]);
  const plan = call(root, 'plan', second).value;
  assert.deepEqual(plan.specs.map((s: any) => [s.testId, s.action]), [['TC-1', 'covered'], ['TC-2', 'explore']]);
  // The explorer lists only what TC-2 uses; TC-1's saved locators are carried onto that page.
  writeFresh(root, second, ['TC-2'], { locators: [SIGN_IN], withEmail: false });
  const res = call(root, 'assemble', second);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  const rec = readRecord(root, second);
  assert.deepEqual(rec.reuse?.coveredSpecs, ['TC-1']);
  assert.ok(rec.pages[0]!.elements.some((e) => e.candidateLocator === EMAIL), 'TC-1 locator carried over');
  assert.deepEqual(validateExplorationRecord(rec, { runDir: runDir(root, second), specs: null }), []);
});

// ---------- known pages: a new test case starts from what the store knows ----------

// What the explorer writes for a new test case that only uses the saved login page: no pages, steps pointing at `saved:/login`.
function writeSeeded(root: string, runId: string, specIds: string[], opts: { locators?: string[]; page?: string } = {}): void {
  const record = {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: `explore-${runId}`, baseUrl: BASE,
    startedAt: '2026-10-21T00:00:00Z', endedAt: '2026-10-21T00:05:00Z', pages: [],
    specs: specIds.map((testId) => ({
      testId, status: 'explored', uncertainties: [], notes: null,
      steps: [{ index: 1, observed: 'login form shown', pageId: `saved:${opts.page ?? '/login'}`, locators: opts.locators ?? [EMAIL, SIGN_IN] }],
    })),
    avoidedActions: [],
  };
  writeDep(root, `runs/${runId}/exploration/fresh.json`, JSON.stringify(record));
}

function seededStore(t: Parameters<typeof tmpRoot>[0]) {
  const root = tmpRoot(t);
  const known = [mkSpec('TC-1', ['open login']), mkSpec('TC-2', ['open login', 'sign in'])];
  const first = newRun(root, known);
  writeFresh(root, first, ['TC-1', 'TC-2']);
  assert.equal(call(root, 'assemble', first).code, 0);
  return { root, known, added: mkSpec('TC-3', ['open login', 'reset password']) };
}

test('a new test case in a known module gets the saved pages as a hint, not as evidence', (t) => {
  const { root, known, added } = seededStore(t);
  const plan = call(root, 'plan', newRun(root, [...known, added])).value;
  const tc3 = plan.specs.find((s: any) => s.testId === 'TC-3');
  assert.equal(tc3.action, 'explore');
  assert.deepEqual(tc3.knownPages, ['/login']);
  assert.deepEqual(plan.knownPages, ['/login'], 'the session reply names the pages; the locator digest goes to the explorer brief');
  assert.equal(plan.specs.find((s: any) => s.testId === 'TC-1').knownPages, undefined, 'only test cases that must be explored get hints');
});

test('a new test case reuses a known page once a snapshot from this run confirms its locators', (t) => {
  const { root, known, added } = seededStore(t);
  const second = newRun(root, [...known, added]);
  call(root, 'plan', second);
  call(root, 'revalidate', second, { page: '/login', file: writeSnapshot(root, second, 'login.aria.yml', LOGIN_SNAPSHOT) });
  writeSeeded(root, second, ['TC-3']);
  const res = call(root, 'assemble', second);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  assert.deepEqual(res.value.reuse.seededPages, ['/login']);

  const rec = readRecord(root, second);
  assert.match(rec.reuse!.reasons['TC-3']!, /known pages reused after revalidation: \/login/);
  assert.deepEqual(rec.reuse!.freshSpecs, ['TC-3']);
  assert.deepEqual(rec.reuse!.freshPages, [], 'nothing was re-observed');
  const page = rec.pages.find((p) => p.id === rec.specs.find((s) => s.testId === 'TC-3')!.steps[0]!.pageId)!;
  assert.equal(page.provenance?.source, 'reused');
  assert.deepEqual(page.elements.map((e) => e.candidateLocator).sort(), [EMAIL, SIGN_IN].sort());
  assert.deepEqual(validateExplorationRecord(rec, { runDir: runDir(root, second), specs: null }), []);

  // The new case's evidence is saved: the next run revalidates it like any other instead of exploring it again.
  const third = newRun(root, [...known, added]);
  assert.equal(call(root, 'plan', third).value.specs.find((s: any) => s.testId === 'TC-3').action, 'revalidate');
});

test('a saved page is refused for a new test case until it is revalidated, and for locators the snapshot does not show', (t) => {
  const { root, known, added } = seededStore(t);
  const second = newRun(root, [...known, added]);
  writeSeeded(root, second, ['TC-3']);
  const early = call(root, 'assemble', second);
  assert.equal(early.code, 2);
  assert.ok(early.value.issues.some((i: string) => /TC-3 step 1: saved page \/login has no snapshot from this run/.test(i)), JSON.stringify(early.value));

  // The Email field is gone in the new snapshot, so the page cannot stand in for it.
  call(root, 'revalidate', second, { page: '/login', file: writeSnapshot(root, second, 'login.aria.yml', '- button "Sign in"\n') });
  writeSeeded(root, second, ['TC-3']);
  const late = call(root, 'assemble', second);
  assert.equal(late.code, 2);
  assert.ok(late.value.issues.some((i: string) => /locator getByLabel\('Email'\) is not a verified saved element|is missing/.test(i)), JSON.stringify(late.value));
});

test('a saved page that is not in the store, or an unlisted locator on it, is refused with a way forward', (t) => {
  const { root, known, added } = seededStore(t);
  const second = newRun(root, [...known, added]);
  writeSeeded(root, second, ['TC-3'], { page: '/checkout' });
  const unknown = call(root, 'assemble', second);
  assert.equal(unknown.code, 2);
  assert.match(unknown.value.issues.join('\n'), /saved page \/checkout is not in the store; list the page/);

  call(root, 'revalidate', second, { page: '/login', file: writeSnapshot(root, second, 'login.aria.yml', LOGIN_SNAPSHOT) });
  writeSeeded(root, second, ['TC-3'], { locators: ["getByLabel('Password')"] });
  const unlisted = call(root, 'assemble', second);
  assert.equal(unlisted.code, 2);
  assert.match(unlisted.value.issues.join('\n'), /Password.*is not a verified saved element; observe it/);
});

test('saved: page references are only accepted in fresh.json, never in a finished exploration record', (t) => {
  const { root, known } = seededStore(t);
  const second = newRun(root, known);
  const bad = {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: null, session: null, baseUrl: BASE, startedAt: 'a', endedAt: 'b', pages: [],
    specs: [{ testId: 'TC-1', status: 'explored', uncertainties: [], notes: null, steps: [{ index: 1, observed: 'x', pageId: 'saved:/login', locators: [] }] }],
    avoidedActions: [],
  };
  assert.match(validateExplorationRecord(bad, { runDir: runDir(root, second), specs: null }).join(), /unknown pageId "saved:\/login"/);
  assert.deepEqual(validateExplorationRecord(bad, { runDir: runDir(root, second), specs: null, allowSaved: true }), []);
});

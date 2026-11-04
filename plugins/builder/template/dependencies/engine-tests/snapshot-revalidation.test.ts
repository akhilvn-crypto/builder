import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stageCommand } from '../engine/cli/stage-commands.ts';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import type { ExplorationRecord } from '../engine/pipeline/exploration.ts';
import { loadStore } from '../engine/pipeline/exploration-store.ts';
import { createRun } from '../engine/pipeline/run-manager.ts';
import { buildJobs, judgeSnapshot, snapshotName, type SnapshotResult } from '../engine/pipeline/snapshot-revalidation.ts';
import { slugify, type TestSpec } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeDep, writeFile, writeRunSpecs } from './helpers.ts';

const BASE = 'https://test.example.com';
const SIGN_IN = "getByRole('button', { name: 'Sign in' })";
const EMAIL = "getByLabel('Email')";
const LOGIN = '- textbox "Email"\n- button "Sign in"\n';

function mkSpec(id: string): TestSpec {
  return {
    id, title: `${id} title`, source: { path: 'input/cases.md', line: 1, originalId: id, sheet: null }, suite: 'Auth', module: 'Auth', moduleSlug: slugify('Auth'), priority: null, tags: [],
    preconditions: [], steps: [{ index: 1, action: 'open login', expected: null }], expectedResults: ['something observable'], testData: [], ambiguities: [], status: 'ready',
  };
}

const call = (root: string, action: string, runId: string, values: Record<string, unknown> = {}) => {
  const r = stageCommand(root, 'explore', action, [runId], values);
  return { code: r.code, value: r.value as Record<string, any> };
};

function newRun(root: string, specs: TestSpec[]): string {
  const { runId } = createRun(root, { command: 'generate-tests', config: validConfig() });
  writeRunSpecs(root, runId, specs);
  return runId;
}

// A stand-in for @playwright/test: a "browser" that serves canned accessibility snapshots from <root>/fake-site.json, keyed by path.
// { redirectTo } makes a page land elsewhere, { status } sets the HTTP status, { ariaAfter } is what the page shows from its second visit on.
function fakePlaywright(root: string, site: Record<string, { aria: string; ariaAfter?: string; status?: number; redirectTo?: string }>): void {
  writeFile(root, 'fake-site.json', JSON.stringify(site));
  writeFile(root, 'node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', main: 'index.js' }));
  writeFile(root, 'node_modules/@playwright/test/index.js', `
const fs = require('node:fs'); const path = require('node:path');
const root = ${JSON.stringify(root)};
const site = () => JSON.parse(fs.readFileSync(path.join(root, 'fake-site.json'), 'utf8'));
// Visits are counted on disk: the retry is another process.
const counts = path.join(root, 'fake-visits.json');
const visits = fs.existsSync(counts) ? JSON.parse(fs.readFileSync(counts, 'utf8')) : {};
function page(o) {
  let url = ''; let entry = null;
  return {
    async goto(u) {
      const p = new URL(u).pathname; visits[p] = (visits[p] || 0) + 1; fs.writeFileSync(counts, JSON.stringify(visits));
      const e = site()[p]; entry = e;
      if (e && e.redirectTo) { url = new URL(e.redirectTo, u).href; entry = site()[e.redirectTo]; } else url = u;
      return { status: () => (e && e.status) || 200 };
    },
    locator() { return { async ariaSnapshot() { const p = new URL(url).pathname; return visits[p] > 1 && entry.ariaAfter ? entry.ariaAfter : entry.aria; } }; },
    async screenshot() {}, async waitForLoadState() {}, async waitForTimeout() {},
    async title() { return ''; }, url() { return url; },
  };
}
exports.chromium = { async launch() { return { async newContext(o) { return { async newPage() { return page(o); }, async close() {} }; }, async close() {} }; } };
`);
}

// What the explorer would have recorded on an earlier run: one login page with two locators, used by every test case given.
function seedStore(root: string, specs: TestSpec[]): void {
  const first = newRun(root, specs);
  writeDep(root, `runs/${first}/exploration/login.aria.yml`, LOGIN);
  const el = (role: string, name: string, locator: string) => ({ role, name, testId: null, candidateLocator: locator, confidence: 'high', notes: null });
  writeDep(root, `runs/${first}/exploration/fresh.json`, JSON.stringify({
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: `explore-${first}`, baseUrl: BASE,
    startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:05:00Z',
    pages: [{ id: 'login', url: `${BASE}/login`, title: 'Login', snapshot: 'exploration/login.aria.yml', screenshot: null, elements: [el('textbox', 'Email', EMAIL), el('button', 'Sign in', SIGN_IN)] }],
    specs: specs.map((s) => ({ testId: s.id, status: 'explored', uncertainties: [], notes: null, steps: [{ index: 1, observed: 'login form shown', pageId: 'login', locators: [EMAIL, SIGN_IN] }] })),
    avoidedActions: [],
  }));
  assert.equal(call(root, 'assemble', first).code, 0);
}

const specs = [mkSpec('TC-1'), mkSpec('TC-2')];
const verifiedCount = (root: string): number => {
  const state = loadStore(root, BASE);
  assert.ok(state.status === 'ok');
  return state.store.pages['/login']!.elements.filter((e) => e.status === 'verified').length;
};

// ---------- the decision ----------

const stored = {
  key: '/login', url: '/login', title: null, evidence: { snapshot: null, screenshot: null },
  elements: [EMAIL, SIGN_IN].map((l, i) => ({
    role: i === 0 ? 'textbox' : 'button', name: i === 0 ? 'Email' : 'Sign in', testId: null, candidateLocator: l, confidence: 'high', notes: null,
    runId: 'r', observedAt: 'x', lastRevalidatedAt: null, status: 'verified', staleReason: null, staleAt: null,
  })),
} as never;
const reached = (over: Partial<SnapshotResult> = {}): SnapshotResult => ({ key: '/login', ok: true, url: `${BASE}/login`, status: 200, title: '', snapshot: 'x', error: null, ...over });
const judge = (result: SnapshotResult, text: string, needed = [EMAIL, SIGN_IN]) => judgeSnapshot({ key: '/login', baseUrl: BASE, result, page: stored, needed, snapshotText: text });

test('a snapshot proves a page only when it landed there and shows every needed locator once', () => {
  const ok = judge(reached(), LOGIN);
  assert.ok(ok.commit);
  assert.deepEqual(Object.keys(ok.commit ? ok.checks : {}), [EMAIL, SIGN_IN]);

  const redirected = judge(reached({ url: `${BASE}/signin` }), LOGIN);
  assert.ok(!redirected.commit && /landed on \/signin, not \/login/.test(redirected.reason) && !redirected.retry, 'a redirect is never compared, even if the other page looks right');
  assert.ok(!judge(reached({ status: 503 }), LOGIN).commit);
  assert.ok(!judge(reached({ ok: false, url: null, error: 'net::ERR_CONNECTION_REFUSED' }), '').commit);
  assert.ok(!judge(reached({ url: 'https://other.example.com/login' }), LOGIN).commit, 'another origin is never the saved page');

  const missing = judge(reached(), '- textbox "Email"\n');
  assert.ok(!missing.commit && missing.retry && missing.notPresent.join() === SIGN_IN);
  assert.match(missing.commit ? '' : missing.reason, /nothing was invalidated/);
  const twice = judge(reached(), '- textbox "Email"\n- button "Sign in"\n- button "Sign in"\n');
  assert.ok(!twice.commit && !twice.retry, 'waiting does not make an ambiguous locator unique');
});

test('only the present elements of a page are recorded, and a page with no needed locators only has to be reachable', () => {
  const extra = judge(reached(), '- textbox "Email"\n- button "Sign in"\n', [SIGN_IN]);
  assert.ok(extra.commit && Object.keys(extra.checks).length === 2);
  const partial = judge(reached(), '- button "Sign in"\n', [SIGN_IN]);
  assert.ok(partial.commit);
  assert.deepEqual(Object.keys(partial.commit ? partial.checks : {}), [SIGN_IN], 'Email is not in this snapshot: neither confirmed nor invalidated');
  assert.ok(judge(reached(), '', []).commit);
});

test('jobs name an absolute URL and a safe file for each page', () => {
  const jobs = buildJobs([{ key: '/app#/orders', url: '/app#/orders' }, { key: '/', url: '/' }], BASE, (k) => path.join('out', snapshotName(k)));
  assert.deepEqual(jobs.map((j) => j.url), [`${BASE}/app#/orders`, `${BASE}/`]);
  assert.deepEqual(jobs.map((j) => path.basename(j.out)), ['app-orders.aria.yml', 'root.aria.yml']);
});

// ---------- the command ----------

test('explore snapshot revalidates saved pages without an agent, and assemble then needs no fresh.json', (t) => {
  const root = tmpRoot(t);
  seedStore(root, specs);
  fakePlaywright(root, { '/login': { aria: LOGIN } });
  const run = newRun(root, specs);
  assert.deepEqual(call(root, 'plan', run).value.summary, { explore: 0, revalidate: 2, reuse: 0, covered: 0 });

  const r = call(root, 'snapshot', run);
  assert.equal(r.code, 0, JSON.stringify(r.value));
  assert.deepEqual(r.value.pages.map((p: any) => [p.page, p.outcome, p.presentElements]), [['/login', 'revalidated', 2]]);
  assert.deepEqual(r.value.summary, { explore: 0, revalidate: 0, reuse: 2, covered: 0 });
  assert.equal(r.value.explorerNeeded, false);
  assert.equal(r.value.unavailable, undefined);
  assert.ok(existsSync(path.join(runDir(root, run), 'exploration/snapshots/login.aria.yml')), 'the snapshot is this run’s evidence');

  const res = call(root, 'assemble', run);
  assert.equal(res.code, 0, JSON.stringify(res.value));
  const rec = JSON.parse(readFileSync(path.join(runDir(root, run), 'exploration/exploration.json'), 'utf8')) as ExplorationRecord;
  assert.deepEqual(rec.reuse?.reusedSpecs, ['TC-1', 'TC-2']);
  assert.equal(rec.pages[0]!.provenance?.source, 'reused');
  assert.equal(rec.pages[0]!.snapshot, 'exploration/snapshots/login.aria.yml');
});

test('a page that redirects is left for the explorer and nothing is invalidated', (t) => {
  const root = tmpRoot(t);
  seedStore(root, specs);
  // The login page now bounces to /signin, which happens to show the same controls: still not the saved page.
  fakePlaywright(root, { '/login': { aria: '', redirectTo: '/signin' }, '/signin': { aria: LOGIN } });
  const run = newRun(root, specs);
  call(root, 'plan', run);

  const r = call(root, 'snapshot', run);
  assert.equal(r.value.pages[0].outcome, 'left-for-explorer');
  assert.match(r.value.pages[0].reason, /landed on \/signin, not \/login/);
  assert.equal(r.value.explorerNeeded, true);
  assert.deepEqual(r.value.pagesLeft, ['/login']);
  assert.deepEqual(r.value.summary, { explore: 0, revalidate: 2, reuse: 0, covered: 0 });
  assert.equal(verifiedCount(root), 2);
  assert.equal(call(root, 'assemble', run).code, 2, 'unrevalidated evidence is still refused');
});

test('a locator that is not in the loaded page is inconclusive, not stale; the explorer path still invalidates', (t) => {
  const root = tmpRoot(t);
  seedStore(root, specs);
  fakePlaywright(root, { '/login': { aria: '- textbox "Email"\n- button "Log in"\n' } });
  const run = newRun(root, specs);
  call(root, 'plan', run);

  const r = call(root, 'snapshot', run);
  assert.equal(r.value.pages[0].outcome, 'left-for-explorer');
  assert.match(r.value.pages[0].reason, /nothing was invalidated/);
  assert.equal(verifiedCount(root), 2, 'both saved elements are untouched');
  assert.deepEqual(r.value.summary, { explore: 0, revalidate: 2, reuse: 0, covered: 0 }, 'the test cases still wait for a real revalidation');

  // The explorer, who can reach any state, decides. With the same snapshot, `explore revalidate` does invalidate.
  const file = 'exploration/snapshots/login.aria.yml';
  const rv = call(root, 'revalidate', run, { page: '/login', file });
  assert.equal(rv.value.elements[SIGN_IN].state, 'missing');
  assert.equal(verifiedCount(root), 1);
});

test('a page that was still rendering is snapshotted once more before it is given up on', (t) => {
  const root = tmpRoot(t);
  seedStore(root, specs);
  fakePlaywright(root, { '/login': { aria: '- textbox "Email"\n', ariaAfter: LOGIN } });
  const run = newRun(root, specs);
  call(root, 'plan', run);

  const r = call(root, 'snapshot', run);
  assert.equal(r.value.pages[0].outcome, 'revalidated', JSON.stringify(r.value));
  assert.deepEqual(r.value.summary, { explore: 0, revalidate: 0, reuse: 2, covered: 0 });
});

test('without an installed @playwright/test the command says so and leaves every page for the explorer', (t) => {
  const root = tmpRoot(t);
  seedStore(root, specs);
  const run = newRun(root, specs);
  call(root, 'plan', run);

  const r = call(root, 'snapshot', run);
  assert.equal(r.code, 0);
  assert.match(r.value.unavailable, /@playwright\/test is not installed/);
  assert.equal(r.value.pages[0].outcome, 'left-for-explorer');
  assert.equal(r.value.explorerNeeded, true);
  assert.equal(verifiedCount(root), 2);
});

test('with nothing to revalidate the command does nothing', (t) => {
  const root = tmpRoot(t);
  const run = newRun(root, specs);
  const r = call(root, 'snapshot', run);
  assert.equal(r.code, 0);
  assert.deepEqual(r.value.pages, []);
  assert.equal(r.value.explorerNeeded, true, 'the test cases have no saved evidence, so they are explored');
});

// Cross-run artifact reuse: the cache primitives, normalized-spec reuse, generation and review reuse, invalidation of exactly
// the affected downstream artifacts (down to which page objects a test imports), rejection of corrupt entries, and parallel
// batch safety.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  decide, entryPath, hashValue, readEntry, readLedger, recordDecisions, summarizeLedger, writeEntry,
} from '../engine/pipeline/artifact-cache.ts';
import type { ExplorationRecord } from '../engine/pipeline/exploration.ts';
import {
  buildBatches, explorationEvidenceHash, mergeGeneration, planGeneration, testBlockHash, testDependencyHash, type GenerationPlan,
} from '../engine/pipeline/generation-reuse.ts';
import { GENERATED_HEADER, type GenerationManifest } from '../engine/pipeline/generation.ts';
import { planReview, refreshAfterHeal, sealReview, typecheckKey } from '../engine/pipeline/review-reuse.ts';
import { parseSpecsCached } from '../engine/pipeline/specs-cache.ts';
import type { ReviewReport } from '../engine/pipeline/static-review.ts';
import { listInputFiles, parseInputs } from '../engine/pipeline/test-case-parser.ts';
import type { TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

const CASES = `# Shop
## TC-1: Home page shows its heading
### Steps
1. Open the home page -> Expected: The heading "Home" is visible

## TC-2: Sign in button is available
### Steps
1. Open the login page -> Expected: A "Sign in" button is visible
`;

const TEST_FILE = 'tests/shop.spec.ts';
const LOGIN_PAGE = 'pages/LoginPage.ts';
const HOME_PAGE = 'pages/HomePage.ts';

const SPEC_FILE = `${GENERATED_HEADER}
import { test, expect } from '../fixtures/test.ts';
import { HomePage } from '../pages/HomePage.ts';
import { LoginPage } from '../pages/LoginPage.ts';

test.describe('Shop', () => {
  test('[TC-1] Home page shows its heading', { annotation: { type: 'testId', description: 'TC-1' } }, async ({ page }) => {
    await new HomePage(page).open();
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  });

  test('[TC-2] Sign in button is available', { annotation: { type: 'testId', description: 'TC-2' } }, async ({ page }) => {
    await new LoginPage(page).open();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
`;

const config = () => ({ ...validConfig(), input: { testCasesPath: 'input/test-cases' } });
// Without `rules` this is a project scaffolded before rule fingerprints existed (cache keys fall back to the plugin version).
const SCAFFOLD = (version: string, rules?: { generator: string; reviewer: string }) => JSON.stringify({ pluginVersion: version, language: 'typescript', ...(rules ? { rules } : {}) });

function record(over: { homeName?: string } = {}): ExplorationRecord {
  const el = (role: string, name: string) => ({ role, name, testId: null, candidateLocator: `getByRole('${role}', { name: '${name}' })`, confidence: 'high' as const, notes: null });
  return {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '1', session: 's', baseUrl: 'https://test.example.com',
    startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:01:00Z',
    pages: [
      { id: 'p-home', url: '/', title: 'Home', snapshot: null, screenshot: null, elements: [el('heading', over.homeName ?? 'Home')] },
      { id: 'p-login', url: '/login', title: 'Login', snapshot: null, screenshot: null, elements: [el('button', 'Sign in')] },
    ],
    specs: [
      { testId: 'TC-1', status: 'explored', steps: [{ index: 1, observed: 'saw it', pageId: 'p-home', locators: [el('heading', over.homeName ?? 'Home').candidateLocator] }], uncertainties: [], notes: null },
      { testId: 'TC-2', status: 'explored', steps: [{ index: 1, observed: 'saw it', pageId: 'p-login', locators: [el('button', 'Sign in').candidateLocator] }], uncertainties: [], notes: null },
    ],
    avoidedActions: [],
  };
}

// A project with parsed specs and a generated test file, as it looks after test_generation.
function project(t: { after: (fn: () => void) => void }) {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeDep(root, 'input/test-cases/shop.md', CASES);
  writeDep(root, 'state/scaffold.json', SCAFFOLD('1.0.0'));
  writeFile(root, TEST_FILE, SPEC_FILE);
  writeFile(root, 'fixtures/test.ts', 'export const fixtures = 1;\n');
  writeFile(root, 'tsconfig.json', '{}\n');
  writeFile(root, HOME_PAGE, 'export class HomePage { open() { return 1; } }\n');
  writeFile(root, LOGIN_PAGE, "import { shared } from '../helpers/shared.ts';\nexport class LoginPage { open() { return shared; } }\n");
  writeFile(root, 'helpers/shared.ts', 'export const shared = 1;\n');
  const specs: TestSpecDocument = parseInputs(base, listInputFiles(base, 'input/test-cases')).document;
  const generation: GenerationManifest = {
    schemaVersion: 1, generatedAt: '2026-10-20T00:00:00Z', language: 'typescript', sharedFilesChanged: [], excluded: [],
    tests: specs.specs.map((s) => ({ testId: s.id, file: TEST_FILE, title: `[${s.id}] ${s.title}` })),
  };
  return { root, base, specs, generation, cfg: config(), record: record() };
}

const cleanReport = (): ReviewReport => ({
  schemaVersion: 1, reviewedAt: '2026-10-20T00:00:00Z', files: [TEST_FILE], typecheck: { ran: true, ok: true, output: null }, findings: [],
});

function seal(p: ReturnType<typeof project>, runId = '20261020-000000-aaaaaa') {
  const plan = planReview({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation }).plan;
  const res = sealReview({
    rootDir: p.root, runId, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation, report: cleanReport(), plan, reviewerRan: true,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

const plan = (p: ReturnType<typeof project>, extra: Partial<Parameters<typeof planGeneration>[0]> = {}) =>
  planGeneration({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, ...extra });

const actions = (p: ReturnType<typeof project>, extra = {}) => Object.fromEntries(plan(p, extra).plan.specs.map((s) => [s.testId, s.action]));

// ---- primitives ----

test('an unchanged validated entry is reused; any input or version change rebuilds with the reason', (t) => {
  const root = tmpRoot(t);
  const key = { inputs: { src: 'h1' }, versions: { parser: 'v1' } };
  assert.equal(decide(root, 'specs', 'a', key).reason, 'no cached artifact yet');
  writeEntry(root, { kind: 'specs', name: 'a', ...key, payload: { x: 1 }, by: 'test', runId: 'r1' });
  assert.equal(decide(root, 'specs', 'a', key).action, 'reuse');

  const input = decide(root, 'specs', 'a', { ...key, inputs: { src: 'h2' } });
  assert.deepEqual([input.action, input.changed], ['rebuild', ['inputs.src']]);
  const version = decide(root, 'specs', 'a', { ...key, versions: { parser: 'v2' } });
  assert.deepEqual([version.action, version.changed, version.reason], ['rebuild', ['versions.parser'], 'the test-case parser changed']);
  assert.match(decide(root, 'specs', 'a', { inputs: { src: 'h1', extra: 'x' }, versions: key.versions }).reason, /extra/);
});

test('the cache lives under dependencies/state, outside the framework folder', (t) => {
  const root = tmpRoot(t);
  assert.equal(path.relative(dependenciesDir(root), entryPath(root, 'specs', 'a')).split(path.sep).join('/'), 'state/artifact-cache/specs/a.json');
});

test('corrupt, truncated, tampered or unvalidated entries are rejected, never reused', (t) => {
  const root = tmpRoot(t);
  const key = { inputs: { src: 'h1' }, versions: {} };
  const file = entryPath(root, 'specs', 'a');
  const write = () => writeEntry(root, { kind: 'specs', name: 'a', ...key, payload: { x: 1 }, by: 'test', runId: 'r1' });

  write();
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40)); // truncated mid-write
  assert.match(decide(root, 'specs', 'a', key).reason, /rejected: .*not valid JSON/);

  write();
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...entry, payload: { x: 2 } })); // edited without updating the hash
  assert.match(decide(root, 'specs', 'a', key).reason, /payload does not match its recorded hash/);

  writeFileSync(file, JSON.stringify({ ...entry, validation: { status: 'pending' } }));
  assert.match(decide(root, 'specs', 'a', key).reason, /never validated/);

  writeFileSync(file, JSON.stringify({ ...entry, schemaVersion: 99 }));
  assert.match(decide(root, 'specs', 'a', key).reason, /unsupported cache schemaVersion/);

  writeFileSync(file, JSON.stringify({ ...entry, name: 'other' }));
  assert.equal(readEntry(root, 'specs', 'a').status, 'corrupt');

  write();
  assert.match(decide(root, 'specs', 'a', key, () => ['the cached file is gone']).reason, /no longer valid: the cached file is gone/);
  assert.equal(hashValue({ b: 1, a: 2 }), hashValue({ a: 2, b: 1 }), 'hashing is key-order independent');
});

test('the ledger keeps the latest decision per artifact and summarizes hits, misses and reasons', (t) => {
  const root = tmpRoot(t);
  const d = (name: string, action: 'reuse' | 'rebuild', reason: string) => ({ kind: 'generation' as const, name, action, reason, changed: [] });
  recordDecisions(root, [d('TC-1', 'rebuild', 'no cached artifact yet'), d('TC-2', 'reuse', 'unchanged')]);
  recordDecisions(root, [d('TC-1', 'reuse', 'unchanged')]); // re-planning replaces, it does not double count
  const s = summarizeLedger(readLedger(root));
  assert.deepEqual([s.hits, s.misses], [2, 0]);
  assert.deepEqual(s.byKind.generation, { hits: 2, misses: 0 });
});

// ---- normalized specifications ----

test('unchanged input reuses the normalized specs; an edit, a mapping change, a parser or schema change re-parses; errors are not cached', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  const input = writeDep(root, 'input/test-cases/shop.md', CASES);
  const first = parseSpecsCached(root, base, 'r1', 'input/test-cases');
  assert.equal(first.decision.action, 'rebuild');
  const second = parseSpecsCached(root, base, 'r2', 'input/test-cases');
  assert.equal(second.decision.action, 'reuse');
  assert.deepEqual(second.document, first.document);
  assert.deepEqual(second.credentials, [], 'secret values are never cached');

  assert.equal(parseSpecsCached(root, base, 'r3', 'input/test-cases', { useCache: false }).decision.action, 'rebuild');

  writeFileSync(input, CASES.replaceAll('Sign in', 'Log in'));
  const edited = parseSpecsCached(root, base, 'r4', 'input/test-cases');
  assert.equal(edited.decision.action, 'rebuild');
  assert.deepEqual(edited.decision.changed, ['inputs.input/test-cases/shop.md']);
  assert.match(edited.document.specs[1]!.steps[0]!.expected ?? '', /Log in/);
  assert.equal(edited.document.specs[0]!.title, first.document.specs[0]!.title);

  writeDep(root, 'state/input-mapping.json', JSON.stringify({ schemaVersion: 1, tables: { 'input/other.csv': { skip: true } } }));
  assert.deepEqual(parseSpecsCached(root, base, 'r5', 'input/test-cases').decision.changed, ['inputs.(column mappings)'], 'a changed column mapping re-parses');

  const file = entryPath(root, 'specs', edited.decision.name);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, why] of [['parser', /parser changed/], ['specSchema', /schema changed/]] as const) {
    writeFileSync(file, JSON.stringify({ ...entry, versions: { ...entry.versions, [key]: 'older' } }));
    assert.match(parseSpecsCached(root, base, 'r6', 'input/test-cases').decision.reason, why);
  }

  const broken = tmpRoot(t);
  writeDep(broken, 'input/test-cases/bad.csv', 'title,steps\nonly,columns\n');
  parseSpecsCached(broken, dependenciesDir(broken), 'r1', 'input/test-cases');
  assert.equal(parseSpecsCached(broken, dependenciesDir(broken), 'r2', 'input/test-cases').decision.action, 'rebuild', 'a parse with errors is never reused');
});

// ---- generation reuse ----

test('generated tests are reused only after a sealed review, and only while everything they depend on is unchanged', (t) => {
  const p = project(t);
  assert.deepEqual(actions(p), { 'TC-1': 'generate', 'TC-2': 'generate' }, 'nothing is reusable before a review sealed it');
  seal(p);
  assert.deepEqual(actions(p), { 'TC-1': 'reuse', 'TC-2': 'reuse' });
  assert.deepEqual(plan(p).plan.batches, [], 'nothing left for the generator agent');
  assert.deepEqual(actions(p, { force: true }), { 'TC-1': 'generate', 'TC-2': 'generate' });
  assert.deepEqual(actions(p, { useCache: false }), { 'TC-1': 'generate', 'TC-2': 'generate' });
});

test('changing one test case regenerates only that test, in its module file', (t) => {
  const p = project(t);
  seal(p);
  const specs = structuredClone(p.specs);
  specs.specs[1]!.steps[0]!.action = 'Open the sign-in page';
  const r = plan({ ...p, specs });
  assert.deepEqual(Object.fromEntries(r.plan.specs.map((s) => [s.testId, s.action])), { 'TC-1': 'reuse', 'TC-2': 'generate' });
  assert.match(r.plan.specs[1]!.reason, /test case changed/);
  assert.deepEqual(r.plan.batches.map((b) => [b.targetFile, b.testIds]), [[TEST_FILE, ['TC-2']]], 'the module file that already holds the reused test');
});

test('changed application evidence regenerates only the tests that relied on it', (t) => {
  const p = project(t);
  seal(p);
  const changed = record({ homeName: 'Welcome' }); // the home page heading was renamed
  assert.equal(explorationEvidenceHash(changed, 'TC-2'), explorationEvidenceHash(p.record, 'TC-2'));
  assert.notEqual(explorationEvidenceHash(changed, 'TC-1'), explorationEvidenceHash(p.record, 'TC-1'));
  const r = plan({ ...p, record: changed });
  assert.deepEqual(Object.fromEntries(r.plan.specs.map((s) => [s.testId, s.action])), { 'TC-1': 'generate', 'TC-2': 'reuse' });
  assert.match(r.plan.specs[0]!.reason, /application evidence/);
  // Narrative wording and run-local page ids are not evidence.
  const reworded = record();
  reworded.specs[0]!.steps[0]!.observed = 'a completely different description';
  reworded.pages[0]!.id = 'another-id';
  reworded.specs[0]!.steps[0]!.pageId = 'another-id';
  assert.equal(explorationEvidenceHash(reworded, 'TC-1'), explorationEvidenceHash(p.record, 'TC-1'));
});

test('a test depends only on the framework files it imports: another module\'s page object does not touch it', (t) => {
  const p = project(t);
  seal(p);
  const before = { 'TC-1': testDependencyHash(p.root, TEST_FILE, 'TC-1'), 'TC-2': testDependencyHash(p.root, TEST_FILE, 'TC-2') };
  assert.notEqual(before['TC-1'], before['TC-2'], 'each test hashes the files its own block uses');

  writeFile(p.root, 'pages/CartPage.ts', 'export class CartPage {}\n'); // a page object of some other module
  assert.deepEqual(actions(p), { 'TC-1': 'reuse', 'TC-2': 'reuse' });

  writeFile(p.root, LOGIN_PAGE, "import { shared } from '../helpers/shared.ts';\nexport class LoginPage { open() { return shared + 1; } }\n");
  assert.deepEqual(actions(p), { 'TC-1': 'reuse', 'TC-2': 'generate' }, 'only the test using LoginPage');
  assert.match(plan(p).plan.specs[1]!.reason, /a framework file the test imports changed/);
  writeFile(p.root, LOGIN_PAGE, "import { shared } from '../helpers/shared.ts';\nexport class LoginPage { open() { return shared; } }\n");

  writeFile(p.root, 'helpers/shared.ts', 'export const shared = 2;\n'); // imported by LoginPage, so reached transitively
  assert.deepEqual(actions(p), { 'TC-1': 'reuse', 'TC-2': 'generate' });
  writeFile(p.root, 'helpers/shared.ts', 'export const shared = 1;\n');

  writeFile(p.root, 'fixtures/test.ts', 'export const fixtures = 2;\n'); // every test uses test()/expect
  assert.deepEqual(actions(p), { 'TC-1': 'generate', 'TC-2': 'generate' });
});

test('a plugin update that leaves the rule files unchanged keeps generated tests and reviews; changed rules invalidate only their role', (t) => {
  const p = project(t);
  const rules = { generator: 'g1', reviewer: 'r1' };
  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('1.0.0', rules));
  seal(p);
  const review = () => planReview({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation });
  assert.equal(plan(p).plan.summary.reuse, 2);
  assert.deepEqual(review().plan.summary, { review: 0, skip: 2 });

  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('2.0.0', rules));
  assert.equal(plan(p).plan.summary.reuse, 2, 'a new plugin version with identical rules reuses the generated tests');
  assert.deepEqual(review().plan.summary, { review: 0, skip: 2 }, 'and the reviews');

  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('2.0.0', { ...rules, reviewer: 'r2' }));
  assert.equal(plan(p).plan.summary.reuse, 2, 'changed reviewer rules do not regenerate tests');
  assert.match(review().plan.tests[0]!.reason, /reviewer rules changed/);

  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('2.0.0', { ...rules, generator: 'g2' }));
  assert.deepEqual(plan(p).plan.specs.map((s) => s.reason), ['generator rules changed', 'generator rules changed']);
});

test('without rule fingerprints a new plugin version or new compiler settings invalidate every generated test; a hand-edited test is regenerated', (t) => {
  const p = project(t);
  seal(p);
  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('1.1.0'));
  assert.deepEqual(plan(p).plan.specs.map((s) => s.reason), ['generator rules changed', 'generator rules changed']);
  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('1.0.0'));
  assert.equal(plan(p).plan.summary.reuse, 2, 'restoring the version makes the cache valid again');

  writeFile(p.root, 'tsconfig.json', '{ "compilerOptions": {} }\n');
  assert.match(plan(p).plan.specs[0]!.reason, /shared framework files changed/);
  writeFile(p.root, 'tsconfig.json', '{}\n');

  writeFileSync(path.join(p.root, TEST_FILE), SPEC_FILE.replace("name: 'Sign in'", "name: 'Log in'"));
  const r = plan(p);
  assert.deepEqual(Object.fromEntries(r.plan.specs.map((s) => [s.testId, s.action])), { 'TC-1': 'reuse', 'TC-2': 'generate' });
  assert.match(r.plan.specs[1]!.reason, /modified since it was reviewed/);

  writeFileSync(path.join(p.root, TEST_FILE), SPEC_FILE.replace(GENERATED_HEADER, '// mine now')); // ownership handed to the user
  assert.match(plan(p).plan.specs[0]!.reason, /no longer owned by the pipeline/);
  writeFileSync(path.join(p.root, TEST_FILE), '');
  assert.match(plan(p).plan.specs[0]!.reason, /no longer (owned by the pipeline|in)/);
});

test('a healed test keeps its cache entry in step with the healed source', (t) => {
  const p = project(t);
  seal(p);
  writeFileSync(path.join(p.root, TEST_FILE), SPEC_FILE.replace("name: 'Sign in'", "name: 'Log in'"));
  assert.equal(plan(p).plan.specs[1]!.action, 'generate');
  assert.equal(refreshAfterHeal(p.root, 'TC-2', TEST_FILE, 'r2'), true);
  assert.equal(plan(p).plan.specs[1]!.action, 'reuse', 'the healed source is the validated one');
  assert.equal(refreshAfterHeal(p.root, 'TC-9', TEST_FILE, 'r2'), false);
});

// ---- batches and merging ----

test('batches are one per module and own that module\'s file, even when a handwritten file holds the usual name', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeDep(root, 'input/test-cases/many.md', `# Checkout\n## CO-1: pay\n### Steps\n1. Pay -> Expected: Paid\n\n# Login\n## LG-1: sign in\n### Steps\n1. Sign in -> Expected: In\n## LG-2: sign out\n### Steps\n1. Sign out -> Expected: Out\n`);
  writeFile(root, 'tests/login.spec.ts', "import { test } from '@playwright/test';\n"); // handwritten: no generated header
  const specs = parseInputs(base, listInputFiles(base, 'input/test-cases')).document;
  const entry = (testId: string, module: string, action: 'generate' | 'reuse') => ({ testId, module, action, reason: '', changed: [], file: null });
  const batches = buildBatches([entry('CO-1', 'Checkout', 'generate'), entry('LG-1', 'Login', 'generate'), entry('LG-2', 'Login', 'reuse')], specs, 'typescript', root);
  assert.deepEqual(batches.map((b) => [b.batchId, b.testIds, b.targetFile]), [
    ['b1', ['CO-1'], 'tests/checkout.spec.ts'],
    ['b2', ['LG-1'], 'tests/login.generated.spec.ts'],
  ]);
  assert.equal(new Set(batches.map((b) => b.targetFile)).size, batches.length);
});

function batchManifest(tests: [string, string][], shared: string[] = []) {
  return JSON.stringify({ schemaVersion: 1, generatedAt: 'x', language: 'typescript', sharedFilesChanged: shared, excluded: [], tests: tests.map(([id, file]) => ({ testId: id, file, title: `[${id}] x` })) });
}

test('mergeGeneration folds batches and reused tests into one valid manifest', (t) => {
  const p = project(t);
  seal(p);
  const specs = structuredClone(p.specs);
  specs.specs[1]!.steps[0]!.action = 'Open the sign-in page';
  const { plan: pl } = plan({ ...p, specs });
  const runDir = path.join(p.base, 'runs/20261020-000000-aaaaaa');
  writeDep(p.root, 'runs/20261020-000000-aaaaaa/generation/manifest-b1.json', batchManifest([['TC-2', TEST_FILE]], ['pages/LoginPage.ts']));
  const merged = mergeGeneration({ rootDir: p.root, runDir, specs, config: p.cfg, plan: pl });
  assert.equal(merged.ok, true, JSON.stringify(merged.issues));
  if (!merged.ok) return;
  assert.deepEqual(merged.manifest.tests.map((x) => x.testId), ['TC-1', 'TC-2']);
  assert.deepEqual(merged.manifest.reuse, { generatedTests: ['TC-2'], reusedTests: ['TC-1'] });
  assert.deepEqual(merged.manifest.sharedFilesChanged, ['pages/LoginPage.ts']);
});

test('mergeGeneration refuses overlapping batch writes instead of letting one overwrite the other', (t) => {
  const p = project(t);
  const runDir = path.join(p.base, 'runs/20261020-000000-aaaaaa');
  const pl: GenerationPlan = {
    schemaVersion: 1, generatedAt: 'x', language: 'typescript', summary: { generate: 2, reuse: 0 },
    specs: [], batches: [
      { batchId: 'b1', modules: ['Shop'], testIds: ['TC-1'], targetFile: TEST_FILE, manifest: 'generation/manifest-b1.json' },
      { batchId: 'b2', modules: ['Shop2'], testIds: ['TC-2'], targetFile: 'tests/shop2.spec.ts', manifest: 'generation/manifest-b2.json' },
    ],
  };
  const put = (id: string, body: string) => writeDep(p.root, `runs/20261020-000000-aaaaaa/generation/manifest-${id}.json`, body);
  const merge = () => mergeGeneration({ rootDir: p.root, runDir, specs: p.specs, config: p.cfg, plan: pl });

  put('b1', batchManifest([['TC-1', TEST_FILE]], ['pages/Base.ts']));
  put('b2', batchManifest([['TC-2', TEST_FILE]], ['pages/Base.ts'])); // wrong file, same shared change
  const r = merge();
  assert.equal(r.ok, false);
  const text = r.issues.join('\n');
  assert.match(text, /wrote tests\/shop.spec.ts but owns only tests\/shop2.spec.ts/);
  assert.match(text, /both batch b1 and batch b2/);
  assert.match(text, /shared file pages\/Base.ts was changed by both/);

  put('b2', batchManifest([['TC-1', 'tests/shop2.spec.ts']])); // claims another batch's test
  assert.match(merge().issues.join('\n'), /TC-1 was generated by both batch b1 and batch b2/);
});

// ---- review reuse ----

test('a sealed review lets the reviewer skip unchanged tests; any relevant change reviews them again', (t) => {
  const p = project(t);
  const review = (extra = {}) => planReview({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation, ...extra });
  assert.equal(review().plan.summary.review, 2);
  seal(p);
  assert.deepEqual(review().plan.summary, { review: 0, skip: 2 });
  assert.deepEqual(review({ force: true }).plan.summary, { review: 2, skip: 0 });

  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('2.0.0'));
  assert.match(review().plan.tests[0]!.reason, /reviewer rules changed/);
  writeDep(p.root, 'state/scaffold.json', SCAFFOLD('1.0.0'));

  writeFileSync(path.join(p.root, TEST_FILE), SPEC_FILE.replace("name: 'Home'", "name: 'Home page'"));
  const after = review().plan;
  assert.deepEqual(after.tests.map((x) => x.action), ['review', 'skip']);
  assert.deepEqual(after.filesToReview, [TEST_FILE]);

  writeFile(p.root, HOME_PAGE, 'export class HomePage { open() { return 2; } }\n');
  writeFileSync(path.join(p.root, TEST_FILE), SPEC_FILE);
  assert.deepEqual(review().plan.tests.map((x) => x.action), ['review', 'skip'], 'a changed page object re-reviews the tests that use it');
});

test('sealing is refused while semantic review is pending, a skipped test changed, or critical findings are open; major findings withhold only their test', (t) => {
  const p = project(t);
  const reviewPlan = planReview({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation }).plan;
  const base = { rootDir: p.root, runId: '20261020-000000-aaaaaa', specs: p.specs, record: p.record, config: p.cfg, generation: p.generation, plan: reviewPlan };

  const pending = sealReview({ ...base, report: cleanReport(), reviewerRan: false });
  assert.equal(pending.ok, false);
  assert.match(pending.issues.join(' '), /semantic review of TC-1, TC-2 has not happened/);

  const critical = cleanReport();
  critical.findings = [{ id: 'S1', severity: 'critical', file: TEST_FILE, line: 3, rule: 'no-only', message: 'x', status: 'open', source: 'static' }];
  assert.equal(sealReview({ ...base, report: critical, reviewerRan: true }).ok, false);

  // A major finding on TC-2's lines only withholds TC-2.
  const lineOfTc2 = SPEC_FILE.split('\n').findIndex((l) => l.includes('[TC-2]')) + 2;
  const major = cleanReport();
  major.findings = [{ id: 'R1', severity: 'major', file: TEST_FILE, line: lineOfTc2, rule: 'weak-assertion', message: 'x', status: 'open', source: 'reviewer' }];
  const res = sealReview({ ...base, report: major, reviewerRan: true });
  assert.deepEqual([res.ok, res.sealed], [true, ['TC-1']]);
  assert.match(res.notSealed[0]!.reason, /open major finding R1/);
  assert.deepEqual(actions(p), { 'TC-1': 'reuse', 'TC-2': 'generate' });

  // After a seal, a fix round changes something a skipped test relies on: sealing again demands a fresh plan.
  const skipPlan = planReview({ rootDir: p.root, specs: p.specs, record: p.record, config: p.cfg, generation: p.generation }).plan;
  assert.equal(skipPlan.tests[0]!.action, 'skip');
  writeFile(p.root, HOME_PAGE, 'export class HomePage { open() { return 3; } }\n');
  const stale = sealReview({ ...base, plan: skipPlan, report: cleanReport(), reviewerRan: true });
  assert.equal(stale.ok, false);
  assert.match(stale.issues.join(' '), /TC-1 changed after the review plan was made: run "review plan" again/);
});

test('the typecheck cache key follows every file the framework project check reads and the tool versions', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'tests/a.spec.ts', 'export {};\n');
  writeFile(root, 'node_modules/typescript/package.json', JSON.stringify({ version: '7.0.2' }));
  const k1 = typecheckKey(root);
  assert.deepEqual(typecheckKey(root), k1);
  writeFile(root, 'tests/a.spec.ts', 'export const x = 1;\n');
  assert.notEqual(typecheckKey(root).inputs.tree, k1.inputs.tree);
  const k2 = typecheckKey(root);
  writeFile(root, 'pages/Some.ts', 'export {};\n');
  assert.notEqual(typecheckKey(root).inputs.tree, k2.inputs.tree, 'page objects are part of the check');
  writeFile(dependenciesDir(root), 'engine/config/x.ts', 'export {};\n');
  const k3 = typecheckKey(root);
  writeFile(dependenciesDir(root), 'engine/config/x.ts', 'export const y = 1;\n');
  assert.notEqual(typecheckKey(root).inputs.tree, k3.inputs.tree, 'the engine config code the tsconfig includes is part of it');
  writeFile(root, 'node_modules/typescript/package.json', JSON.stringify({ version: '7.0.3' }));
  assert.notEqual(typecheckKey(root).inputs.typescript, k1.inputs.typescript);
  assert.equal(testBlockHash(root, 'tests/missing.spec.ts', 'TC-1'), null);
});

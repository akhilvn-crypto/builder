import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import { buildPlaywrightArgs, normalizeReport, runPlaywright, type ExecutionResults } from '../engine/pipeline/execution.ts';
import { checkLocatorExpression, validateExplorationRecord } from '../engine/pipeline/exploration.ts';
import { buildFailureAnalysis, classifyResult, reclassify } from '../engine/pipeline/failure-classifier.ts';
import { GENERATED_HEADER, validateGenerationManifest } from '../engine/pipeline/generation.ts';
import { guardPatch, lineDiff, matcherCalls } from '../engine/pipeline/healing-guard.ts';
import { assertHealableFile } from '../engine/pipeline/healing.ts';
import { validateInput } from '../engine/pipeline/input-validation.ts';
import { computeFinalTests, countOutcomes } from '../engine/pipeline/reporting.ts';
import { createRun, updateStage } from '../engine/pipeline/run-manager.ts';
import { reviewSource } from '../engine/pipeline/static-review.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { redact } from '../engine/utils/redact.ts';
import { toRootRelative } from '../engine/utils/paths.ts';
import { ERRORS, pwReport, tmpRoot, validConfig, writeDep, writeFile, type FakeTest } from './helpers.ts';

const NOW = new Date('2026-10-20T00:00:00Z');

function results(root: string, tests: FakeTest[], label = 'initial'): ExecutionResults {
  return normalizeReport(pwReport(root, tests), { rootDir: root, runId: 'r', label, secrets: [], now: NOW });
}

test('redact masks secret values', () => {
  assert.equal(redact('user hunter2 logged hunter2', ['hunter2', '']), 'user *** logged ***');
});

test('scaffolded test-data helpers (framework twin): requireEnv never returns empty and redact matches the engine', async () => {
  // The framework helpers exist in the language the project was scaffolded with.
  const dir = path.resolve(import.meta.dirname, '..', '..', 'automation', 'helpers');
  const file = existsSync(path.join(dir, 'test-data.ts')) ? 'test-data.ts' : 'test-data.js';
  const h = (await import(pathToFileURL(path.join(dir, file)).href)) as {
    requireEnv: (name: string, env?: Record<string, string>) => string;
    redact: (text: string, secrets: string[]) => string;
    uniqueSuffix: (prefix?: string) => string;
  };
  assert.throws(() => h.requireEnv('X_PW', {}), /Missing required environment variable X_PW/);
  assert.equal(h.requireEnv('X_PW', { X_PW: 'v' }), 'v');
  assert.equal(h.redact('user hunter2 logged hunter2', ['hunter2', '']), redact('user hunter2 logged hunter2', ['hunter2', '']));
  assert.notEqual(h.uniqueSuffix('a'), h.uniqueSuffix('a'));
});

test('toRootRelative accepts input paths written from the project root, absolute, or dependencies-relative', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  const cwd = path.dirname(root); // the project root, as when the user runs the command from there
  writeDep(root, 'input/test-cases/a.md', '# x');
  assert.equal(toRootRelative(base, 'input/test-cases/a.md', cwd), 'input/test-cases/a.md');
  assert.equal(toRootRelative(base, 'dependencies/input/test-cases/a.md', cwd), 'input/test-cases/a.md');
  assert.equal(toRootRelative(base, path.join(base, 'input', 'test-cases', 'a.md'), cwd), 'input/test-cases/a.md');
  assert.equal(toRootRelative(base, '../outside.md', cwd), '../outside.md', 'escaping paths are left for validation to reject');
  assert.equal(toRootRelative(base, 'missing/x.md', cwd), 'missing/x.md');
});

// ---------- input validation ----------

test('input validation copies originals into the run and fails clearly on bad input', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/a.md', '## TC-1: A\n### Steps\n1. Go -> Expected: Shown\n');
  writeDep(root, 'input/test-cases/notes.txt', 'ignored');
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  const dir = runDir(root, runId);
  const base = dependenciesDir(root);
  // A file that is not .md/.csv/.xlsx is rejected, not skipped: the other file is still read and copied, but the input is not ok.
  const r = validateInput(base, dir, 'input/test-cases');
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsupported, ['input/test-cases/notes.txt']);
  assert.match(r.errors.find((e) => e.path.endsWith('notes.txt'))!.message, /unsupported file type "\.txt".*\.md, \.csv, \.xlsx/);
  assert.ok(existsSync(path.join(dir, 'input', 'input', 'test-cases', 'a.md')));
  rmSync(path.join(base, 'input/test-cases/notes.txt'));
  const clean = validateInput(base, dir, 'input/test-cases');
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.statusCounts, { valid: 1, warning: 0, needs_clarification: 0, invalid: 0 });
  assert.equal(validateInput(base, dir, 'missing/dir').ok, false);
  assert.match(validateInput(base, dir, '../outside').errors[0]!.message, /inside dependencies\//);
});

// ---------- exploration / generation contracts ----------

test('CLI element refs and non-locators are rejected as durable locators', () => {
  assert.equal(checkLocatorExpression("getByRole('button', { name: 'Sign in' })"), null);
  assert.equal(checkLocatorExpression("page.getByTestId('save')"), null);
  assert.match(checkLocatorExpression('e15')!, /temporary CLI element reference/);
  assert.match(checkLocatorExpression("locator('aria-ref=e7')")!, /temporary CLI element reference/);
  assert.match(checkLocatorExpression('#login > div:nth-child(2)')!, /not a Playwright locator/);
});

test('exploration record must cover every ready spec and explain partial coverage', (t) => {
  const root = tmpRoot(t);
  const specs = { specs: [{ id: 'TC-1', status: 'ready' }, { id: 'TC-2', status: 'ready' }, { id: 'TC-3', status: 'needs_clarification' }] } as never;
  const rec = {
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '0.1', session: 's', baseUrl: 'http://x', startedAt: '', endedAt: '',
    pages: [{ id: 'login', url: '/login', title: null, snapshot: 'exploration/login.yml', screenshot: null, elements: [] }],
    specs: [{ testId: 'TC-1', status: 'partial', steps: [{ index: 1, observed: 'x', pageId: 'login', locators: ["getByLabel('Email')"] }], uncertainties: [], notes: null }],
    avoidedActions: [],
  };
  const issues = validateExplorationRecord(rec, { runDir: root, specs });
  assert.ok(issues.some((i) => /snapshot "exploration\/login.yml" does not exist/.test(i)));
  assert.ok(issues.some((i) => /TC-1 is partial but lists no uncertainties/.test(i)));
  assert.ok(issues.some((i) => /ready spec TC-2 has no exploration entry/.test(i)));
  assert.ok(!issues.some((i) => /TC-3/.test(i)), 'specs needing clarification are not explored');
});

test('generation manifest enforces location, traceability and no generation of blocked specs', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'tests/login.spec.ts', `${GENERATED_HEADER}
test('[TC-1] Login', async () => {});`);
  writeFile(root, 'tests/x.spec.ts', "test('[TC-2] X', async () => {}); // handwritten: no generated marker");
  const specs = { specs: [{ id: 'TC-1', status: 'ready' }, { id: 'TC-2', status: 'needs_clarification' }, { id: 'TC-3', status: 'ready' }] } as never;
  const issues = validateGenerationManifest({
    schemaVersion: 1, generatedAt: '', language: 'typescript', sharedFilesChanged: [], excluded: [],
    tests: [
      { testId: 'TC-1', file: 'tests/login.spec.ts', title: '[TC-1] Login' },
      { testId: 'TC-2', file: 'tests/x.spec.ts', title: '[TC-2] X' },
    ],
  }, { rootDir: root, specs });
  assert.ok(issues.some((i) => /TC-2: "tests\/x.spec.ts" lacks the "@builder:generated" header/.test(i)));
  assert.ok(issues.some((i) => /TC-2 needs clarification and must not be generated/.test(i)));
  assert.ok(issues.some((i) => /ready spec TC-3 is neither generated nor excluded/.test(i)));
});

test('healing only touches pipeline-generated files under tests/', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'tests/gen.spec.ts', `${GENERATED_HEADER}
test('[TC-1] A', async () => {});`);
  writeFile(root, 'tests/mine.spec.ts', "test('[TC-2] B', async () => {});");
  writeFile(root, 'pages/LoginPage.ts', `${GENERATED_HEADER}
export class LoginPage {}`);
  assert.doesNotThrow(() => assertHealableFile(root, 'tests/gen.spec.ts'));
  assert.throws(() => assertHealableFile(root, 'tests/mine.spec.ts'), /not pipeline-generated/);
  assert.throws(() => assertHealableFile(root, 'pages/LoginPage.ts'), /not under tests\//);
  assert.throws(() => assertHealableFile(root, 'tests/missing.spec.ts'), /does not exist/);
});

// ---------- static review ----------

const GOOD_TEST = `import { test, expect } from '../fixtures/test.ts';
import { requireEnv } from '../helpers/test-data.ts';

test('[TC-001] Valid user can sign in', { annotation: { type: 'testId', description: 'TC-001' } }, async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill(requireEnv('TEST_USER_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
`;

test('static review passes a conventional test', () => {
  assert.deepEqual(reviewSource('tests/a.spec.ts', GOOD_TEST), []);
});

test('page objects get the line-level safety rules only (no fixture import, title or assertion requirements)', () => {
  const page = `import { BasePage } from './BasePage.ts';
export class CartPage extends BasePage {
  readonly path = '/cart';
  readonly total = this.page.getByTestId('cart-total');
  async settle() { await this.page.waitForTimeout(500); }
}`;
  const rules = reviewSource('pages/CartPage.ts', page, 'support').map((f) => f.rule);
  assert.deepEqual(rules, ['no-wait-for-timeout'], 'only the sleep is flagged; a page object needs no test(), title or expect()');
  assert.ok(reviewSource('pages/CartPage.ts', page).some((f) => f.rule === 'no-tests'), 'the same file reviewed as a test is rejected');
});

test('static review flags skips, sleeps, CLI refs, secrets, missing IDs and missing assertions', () => {
  const bad = `import { test, expect } from '@playwright/test';
test.skip('[TC-1] a', async ({ page }) => {});
test('no id here', async ({ page }) => {
  await page.goto('https://prod.example.com/login');
  await page.waitForTimeout(3000);
  await page.locator('aria-ref=e12').click();
  await page.getByLabel('Password').fill('S3cretPass!');
});
`;
  const rules = reviewSource('tests/b.spec.ts', bad).map((f) => `${f.severity}:${f.rule}`);
  for (const r of ['critical:no-skip', 'critical:no-cli-element-ref', 'critical:no-hardcoded-secret', 'critical:test-id-title',
    'critical:has-assertion', 'major:no-wait-for-timeout', 'major:no-absolute-url', 'major:use-shared-fixtures']) {
    assert.ok(rules.includes(r), `expected ${r} in ${rules.join(', ')}`);
  }
});

// ---------- execution ----------

test('playwright args escape test IDs for --grep and pass retries', () => {
  assert.deepEqual(buildPlaywrightArgs({ files: ['tests/a.spec.ts'], testIds: ['TC-1', 'TC-2'], retries: 0, projects: ['chromium'] }),
    ['test', 'tests/a.spec.ts', '--grep', '\\[TC-1\\]|\\[TC-2\\]', '--project', 'chromium', '--retries', '0']);
  assert.deepEqual(buildPlaywrightArgs({ headed: true }), ['test', '--headed']);
});

test('report normalization maps IDs, outcomes, evidence paths and redacts secrets', (t) => {
  const root = tmpRoot(t);
  const shot = path.join(root, 'test-results', 'r', 'initial', 'a', 'shot.png');
  const raw = pwReport(root, [
    { title: '[TC-1] ok', file: 'a.spec.ts', status: 'expected', results: [{ status: 'passed' }] },
    { title: '[TC-2] flaky', file: 'a.spec.ts', status: 'flaky', results: [{ status: 'failed', error: ERRORS.notFound }, { status: 'passed' }] },
    { title: '[TC-3] fails', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: 'password hunter2 rejected', attachments: [{ name: 'screenshot', contentType: 'image/png', path: shot }] }] },
    { title: 'handwritten thing', file: 'b.spec.ts', status: 'skipped', results: [{ status: 'skipped' }] },
  ]);
  const r = normalizeReport(raw, { rootDir: root, runId: 'r', label: 'initial', secrets: ['hunter2'], now: NOW });
  assert.deepEqual(r.tests.map((x) => [x.key, x.outcome]), [
    ['TC-1@chromium', 'passed'], ['TC-2@chromium', 'flaky'], ['TC-3@chromium', 'failed'], ['untagged:tests/b.spec.ts:handwritten thing@chromium', 'skipped'],
  ]);
  assert.deepEqual(r.stats, { total: 4, passed: 1, failed: 1, flaky: 1, skipped: 1 });
  assert.equal(r.tests[2]!.file, 'tests/a.spec.ts');
  assert.equal(r.tests[2]!.attempts[0]!.errors[0]!.message, 'password *** rejected');
  assert.equal(r.tests[2]!.attempts[0]!.attachments[0]!.path, 'test-results/r/initial/a/shot.png');
  assert.equal(r.runnerError, null);
});

test('runner errors are separated from test failures', (t) => {
  const root = tmpRoot(t);
  const r = normalizeReport(pwReport(root, [], ['Error: config/automation.config.json is invalid']), { rootDir: root, runId: 'r', label: 'initial', secrets: [], now: NOW });
  assert.match(r.runnerError!, /config\/automation.config.json is invalid/);
  const { runId } = createRun(root, { command: 'run-tests' });
  const missing = runPlaywright(root, validConfig(), { runId, label: 'initial' });
  assert.equal(missing.runnerError, '@playwright/test is not installed in the project');
});

// ---------- classification ----------

test('classifier separates script, application, environment, data and flaky causes', (t) => {
  const root = tmpRoot(t);
  const r = results(root, [
    { title: '[A-1] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.notFound }] },
    { title: '[A-2] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.mismatch }] },
    { title: '[A-3] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.network }] },
    { title: '[A-4] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.missingEnv }] },
    { title: '[A-5] x', file: 'a.spec.ts', status: 'flaky', results: [{ status: 'failed', error: ERRORS.notFound }, { status: 'passed' }] },
    { title: '[A-6] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.strict }] },
    { title: '[A-7] x', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: 'Error: something odd' }] },
  ]);
  const got = r.tests.map((x) => { const c = classifyResult(x); return `${x.testId}:${c.category}:${c.confidence}`; });
  assert.deepEqual(got, [
    'A-1:script_defect:medium', 'A-2:application_defect:medium', 'A-3:environment_issue:high', 'A-4:test_data_or_precondition:high',
    'A-5:flaky_or_intermittent:high', 'A-6:script_defect:high', 'A-7:inconclusive:low',
  ]);
  const analysis = buildFailureAnalysis(r, NOW);
  assert.deepEqual(analysis.failures.filter((f) => f.healingEligible).map((f) => f.testId), ['A-1', 'A-6']);
  assert.throws(() => reclassify(analysis, 'A-2', 'script_defect', 'high', ' '), /rationale/);
  const re = reclassify(analysis, 'A-7', 'application_defect', 'medium', 'screenshot shows a 500 page');
  assert.equal(re.failures.find((f) => f.testId === 'A-7')!.classifiedBy, 'agent');
});

// ---------- healing guard ----------

test('guard accepts a locator-only repair', () => {
  const after = GOOD_TEST.replace("getByRole('button', { name: 'Sign in' })", "getByRole('button', { name: 'Log in' })");
  const g = guardPatch(GOOD_TEST, after, 'TC-001');
  assert.equal(g.ok, true, g.violations.join('; '));
  assert.equal(g.changedLines, 2);
  assert.match(g.diff, /-7: .*Sign in[\s\S]*\+7: .*Log in/);
});

test('guard rejects weakened assertions, skips, sleeps and swallowed failures', () => {
  const cases: [string, RegExp][] = [
    [GOOD_TEST.replace(".toBeVisible()", ".toBeAttached()"), /matcher changed or removed: \.toBeVisible\(\)/],
    [GOOD_TEST.replace(/  await expect[^\n]*\n/, ''), /assertions removed/],
    [GOOD_TEST.replace("test('[TC-001]", "test.skip('[TC-001]"), /adds test.skip/],
    [GOOD_TEST.replace("  await page.goto('/login');", "  await page.goto('/login');\n  await page.waitForTimeout(500);"), /arbitrary sleep/],
    [GOOD_TEST.replace(/  (await expect[^\n]*)\n/, '  try { $1 } catch {}\n'), /catch block/],
    [GOOD_TEST.replace('[TC-001] ', ''), /title prefix was removed/],
    [GOOD_TEST, /no change was made/],
  ];
  for (const [after, re] of cases) {
    const g = guardPatch(GOOD_TEST, after, 'TC-001');
    assert.equal(g.ok, false);
    assert.ok(g.violations.some((v) => re.test(v)), `${re} not in ${g.violations.join('; ')}`);
  }
  assert.deepEqual(matcherCalls("expect(x).not.toHaveText('a'); expect(y).toHaveURL(/dash/)"), ["not.toHaveText('a')", 'toHaveURL(/dash/)']);
  assert.equal(lineDiff('a\nb\nc', 'a\nc').changed, 1);
});

// ---------- final outcomes ----------

test('final outcomes: flaky stays flaky, healed needs a passing rerun, regression failures win, unrun specs are blocked', (t) => {
  const root = tmpRoot(t);
  const initial = results(root, [
    { title: '[T-1] a', file: 'a.spec.ts', status: 'expected', results: [{ status: 'passed' }] },
    { title: '[T-2] b', file: 'a.spec.ts', status: 'flaky', results: [{ status: 'failed', error: ERRORS.notFound }, { status: 'passed' }] },
    { title: '[T-3] c', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.notFound }] },
    { title: '[T-4] d', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.mismatch }] },
    { title: '[T-5] e', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.notFound }] },
  ]);
  const analysis = buildFailureAnalysis(initial, NOW);
  const regression = results(root, [
    { title: '[T-1] a', file: 'a.spec.ts', status: 'unexpected', results: [{ status: 'failed', error: ERRORS.notFound }] },
    { title: '[T-3] c', file: 'a.spec.ts', status: 'expected', results: [{ status: 'passed' }] },
  ], 'regression');
  const healing = { schemaVersion: 1 as const, entries: [{ testId: 'T-3', outcome: 'healed' }, { testId: 'T-5', outcome: 'still_failing' }] } as never;
  const specs = { specs: [{ id: 'T-9', title: 'unclear', status: 'needs_clarification', ambiguities: [{ message: 'no expected result is stated' }] }] } as never;
  const tests = computeFinalTests({ results: initial, analysis, healing, regression, specs, generation: null });
  assert.deepEqual(tests.map((x) => `${x.testId}:${x.outcome}`), ['T-1:failed', 'T-2:flaky', 'T-3:healed', 'T-4:failed', 'T-5:failed', 'T-9:blocked']);
  assert.equal(tests[0]!.note, 'failed in regression validation');
  const counts = countOutcomes(tests);
  assert.deepEqual(counts, { total: 6, passed: 0, failed: 3, flaky: 1, healed: 1, blocked: 1, skipped: 0, unresolved: 3 });
  // T-4 is a reported application defect (failed, not unresolved); T-1, T-5 and T-9 need follow-up.
});

// ---------- stage contract gate ----------

test('a stage cannot complete without its required, valid artifact', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/a.md', '## TC-1: A\n### Steps\n1. Click\n'); // no expected result
  const { runId } = createRun(root, { command: 'playwright-pipeline' });
  const dir = runDir(root, runId);
  for (const s of ['preflight', 'configuration'] as const) {
    updateStage(root, runId, s, 'running');
    if (s === 'configuration') {
      const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, config: validConfig() }));
    }
    updateStage(root, runId, s, 'completed');
  }
  updateStage(root, runId, 'input_validation', 'running');
  assert.throws(() => updateStage(root, runId, 'input_validation', 'completed'), /required artifact "inputValidation" is not registered/);
  validateInput(dependenciesDir(root), dir, 'input/test-cases');
  updateStage(root, runId, 'input_validation', 'completed', { artifacts: { inputValidation: 'input-validation.json' } });

  updateStage(root, runId, 'test_analysis', 'running');
  writeFileSync(path.join(dir, 'test-specs.json'), JSON.stringify({ schemaVersion: 1, generatedAt: NOW.toISOString(), sources: [{ path: 'a.md', sha256: 'x', format: 'markdown' }], specs: [] }));
  assert.throws(() => updateStage(root, runId, 'test_analysis', 'completed', { artifacts: { testSpecs: 'test-specs.json' } }), /specs is empty/);
});

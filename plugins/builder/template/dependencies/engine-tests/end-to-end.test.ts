// Drives the real CLI through every stage of /playwright-pipeline. Playwright itself is replaced by a
// stand-in at node_modules/@playwright/test/cli.js that replays canned JSON reports per execution
// label, so these scenarios run without installing Playwright or opening a browser.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_HEADER } from '../engine/pipeline/generation.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { ERRORS, pwReport, tmpRoot, validConfig, writeDep, writeFile, type FakeTest } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');

const FAKE_PLAYWRIGHT = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const label = process.env.PIPELINE_LABEL;
mkdirSync('fake-pw', { recursive: true });
appendFileSync('fake-pw/calls.log', label + ' ' + process.argv.slice(2).join(' ') + '\\n');
const scenario = 'fake-pw/' + label + '.json';
if (!existsSync(scenario)) { console.error('no scenario for ' + label); process.exit(3); }
const s = JSON.parse(readFileSync(scenario, 'utf8'));
const dir = path.join('reports', process.env.PIPELINE_RUN_ID, label);
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'results.json'), JSON.stringify(s.report));
for (const [rel, content] of Object.entries(s.files ?? {})) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}
process.exit(s.exitCode);
`;

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  let json: any = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { code: r.status, json, stderr: r.stderr };
}

function must(root: string, ...args: string[]) {
  const r = cli(root, ...args);
  assert.equal(r.code, 0, `${args.join(' ')} -> ${r.code}\n${JSON.stringify(r.json, null, 2)}\n${r.stderr}`);
  return r.json;
}

function scenario(root: string, label: string, tests: FakeTest[], files: Record<string, string> = { 'html/index.html': '<html>report</html>' }) {
  const failed = tests.some((t) => t.status === 'unexpected');
  writeFile(root, `fake-pw/${label}.json`, JSON.stringify({ exitCode: failed ? 1 : 0, report: pwReport(root, tests), files }));
}

const pass = (id: string, title: string): FakeTest => ({ title: `[${id}] ${title}`, file: 'app.spec.js', status: 'expected', results: [{ status: 'passed' }] });
const fail = (id: string, title: string, error: string): FakeTest => ({ title: `[${id}] ${title}`, file: 'app.spec.js', status: 'unexpected', results: [{ status: 'failed', error }] });

const CASES = `# Demo
## TC-1: Home page shows its heading
### Steps
1. Open the home page -> Expected: The heading "Home" is visible

## TC-2: Sign in button is available
### Steps
1. Open the login page
2. Look at the form -> Expected: A "Sign in" button is visible

## TC-3: Dashboard title
### Steps
1. Open the dashboard -> Expected: The title is "Dashboard"

## TC-4: Search results load
### Steps
1. Search for "shoes" -> Expected: Results are listed

## TC-5: Unclear case
### Steps
1. Do something
`;

const SPEC_FILE = `${GENERATED_HEADER}
import { test, expect } from '../fixtures/test.js';

test('[TC-1] Home page shows its heading', { annotation: { type: 'testId', description: 'TC-1' } }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('[TC-2] Sign in button is available', { annotation: { type: 'testId', description: 'TC-2' } }, async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
});

test('[TC-3] Dashboard title', { annotation: { type: 'testId', description: 'TC-3' } }, async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
});

test('[TC-4] Search results load', { annotation: { type: 'testId', description: 'TC-4' } }, async ({ page }) => {
  await page.goto('/search?q=shoes');
  await expect(page.getByRole('list', { name: 'Results' })).toBeVisible();
});
`;

// A project configured through the CLI, with the stand-in Playwright and test cases in place.
function setupProject(t: { after: (fn: () => void) => void }, reporters = ['html', 'json'], extra: Record<string, unknown> = {}) {
  const root = tmpRoot(t);
  writeFile(root, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(root, 'node_modules/@playwright/test/cli.js', FAKE_PLAYWRIGHT);
  writeDep(root, 'input/test-cases/demo.md', CASES);
  const cfg = { ...validConfig(), language: 'javascript', reporters, ...extra };
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(cfg)));
  return root;
}

function stage(root: string, runId: string, name: string, status: string, ...artifacts: string[]) {
  return must(root, 'run', 'stage', runId, name, status, ...artifacts.flatMap((a) => ['--artifact', a]));
}

// preflight -> configuration -> input_validation -> test_analysis
function startRun(root: string): string {
  const runId: string = must(root, 'run', 'create', '--command', 'playwright-pipeline').runId;
  stage(root, runId, 'preflight', 'running');
  stage(root, runId, 'preflight', 'completed');
  stage(root, runId, 'configuration', 'running');
  must(root, 'run', 'set-config', runId);
  stage(root, runId, 'configuration', 'completed');
  stage(root, runId, 'input_validation', 'running');
  must(root, 'input', 'validate', runId);
  stage(root, runId, 'input_validation', 'completed', 'inputValidation=input-validation.json');
  stage(root, runId, 'test_analysis', 'running');
  const specs = must(root, 'specs', 'parse', runId);
  assert.deepEqual(specs.counts, { total: 5, ready: 4, needsClarification: 1 });
  assert.equal(specs.needsClarification[0].id, 'TC-5');
  stage(root, runId, 'test_analysis', 'completed', 'canonicalCases=canonical-test-cases.json', 'testSpecs=test-specs.json');
  return runId;
}

// exploration (as the explorer agent would record it) -> generation -> review
function exploreGenerateReview(root: string, runId: string) {
  const runDir = `runs/${runId}`;
  stage(root, runId, 'application_exploration', 'running');
  writeDep(root, `${runDir}/exploration/home.aria.yml`, '- heading "Home" [level=1]\n');
  writeDep(root, `${runDir}/exploration/exploration.json`, JSON.stringify({
    schemaVersion: 1, tool: 'playwright-cli', toolVersion: '0.1.0', session: `explore-${runId}`, baseUrl: 'https://test.example.com',
    startedAt: '2026-10-20T00:00:00Z', endedAt: '2026-10-20T00:05:00Z',
    pages: [{ id: 'home', url: '/', title: 'Home', snapshot: 'exploration/home.aria.yml', screenshot: null,
      elements: [{ role: 'heading', name: 'Home', testId: null, candidateLocator: "getByRole('heading', { name: 'Home' })", confidence: 'high', notes: null }] }],
    specs: ['TC-1', 'TC-2', 'TC-3', 'TC-4'].map((id) => ({ testId: id, status: 'explored', steps: [{ index: 1, observed: 'seen', pageId: 'home', locators: [] }], uncertainties: [], notes: null })),
    avoidedActions: [],
  }));
  must(root, 'explore', 'validate', runId);
  stage(root, runId, 'application_exploration', 'completed', 'exploration=exploration/exploration.json');

  stage(root, runId, 'test_generation', 'running');
  writeFile(root, 'tests/app.spec.js', SPEC_FILE);
  writeDep(root, `${runDir}/generation-manifest.json`, JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-10-20T00:06:00Z', language: 'javascript', sharedFilesChanged: [],
    tests: [['TC-1', 'Home page shows its heading'], ['TC-2', 'Sign in button is available'], ['TC-3', 'Dashboard title'], ['TC-4', 'Search results load']]
      .map(([id, title]) => ({ testId: id, file: 'tests/app.spec.js', title: `[${id}] ${title}` })),
    excluded: [],
  }));
  writeDep(root, `${runDir}/generation-report.md`, '# Generation\n4 tests generated; TC-5 not generated (needs clarification).\n');
  must(root, 'generate', 'validate', runId);
  stage(root, runId, 'test_generation', 'completed', 'generationManifest=generation-manifest.json', 'generationReport=generation-report.md');

  stage(root, runId, 'script_review', 'running');
  const review = must(root, 'review', 'static', runId);
  assert.equal(review.typecheck.ok, true);
  assert.deepEqual(review.open, []);
  stage(root, runId, 'script_review', 'completed', 'reviewReport=review-report.json');
}

test('end to end: a passing test, a healed broken locator, a genuine failure kept failing, a flaky test, a blocked case', (t) => {
  const root = setupProject(t);
  const runId = startRun(root);
  exploreGenerateReview(root, runId);

  // Initial execution: TC-2's locator is stale, TC-3 hits a real application bug, TC-4 is flaky.
  scenario(root, 'initial', [
    pass('TC-1', 'Home page shows its heading'),
    fail('TC-2', 'Sign in button is available', ERRORS.notFound),
    fail('TC-3', 'Dashboard title', ERRORS.mismatch),
    { title: '[TC-4] Search results load', file: 'app.spec.js', status: 'flaky', results: [{ status: 'failed', error: ERRORS.notFound }, { status: 'passed' }] },
  ]);
  stage(root, runId, 'execution', 'running');
  const exec = must(root, 'exec', 'run', runId, '--label', 'initial');
  assert.deepEqual(exec.stats, { total: 4, passed: 1, failed: 2, flaky: 1, skipped: 0 });
  stage(root, runId, 'execution', 'completed', 'executionResults=execution-results.json');

  stage(root, runId, 'failure_triage', 'running');
  const triage = must(root, 'triage', 'run', runId);
  assert.deepEqual(triage.eligibleForHealing, ['TC-2@chromium']);
  assert.equal(triage.failures.find((f: any) => f.testId === 'TC-3').category, 'application_defect');
  assert.equal(triage.failures.find((f: any) => f.testId === 'TC-4').category, 'flaky_or_intermittent');
  stage(root, runId, 'failure_triage', 'completed', 'failureAnalysis=failure-analysis.json');

  stage(root, runId, 'healing', 'running');
  // The application defect is not eligible: the healer must leave it failing.
  const refused = cli(root, 'heal', 'begin', runId, 'TC-3', '--test-file', 'tests/app.spec.js');
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.stderr).message, /not eligible for healing \(application_defect/);

  // Attempt 1 tries to weaken the assertion: the guard rejects it and the file is reverted.
  const specPath = path.join(root, 'tests/app.spec.js');
  const begin1 = must(root, 'heal', 'begin', runId, 'TC-2', '--test-file', 'tests/app.spec.js');
  assert.equal(begin1.attempt, 1);
  writeFileSync(specPath, SPEC_FILE.replace("getByRole('button', { name: 'Login' })).toBeVisible()", "getByRole('button', { name: 'Login' })).toBeAttached()"));
  assert.equal(cli(root, 'heal', 'check', runId, 'TC-2', '--attempt', '1', '--test-file', 'tests/app.spec.js').code, 2);
  const rec1 = must(root, 'heal', 'record', runId, 'TC-2', '--attempt', '1', '--test-file', 'tests/app.spec.js', '--rationale', 'button renamed');
  assert.equal(rec1.outcome, 'rejected_by_guard');
  assert.equal(readFileSync(specPath, 'utf8'), SPEC_FILE, 'rejected patch reverted');

  // Attempt 2 fixes only the locator; the targeted rerun passes.
  const begin2 = must(root, 'heal', 'begin', runId, 'TC-2', '--test-file', 'tests/app.spec.js');
  assert.equal(begin2.rerunLabel, 'heal-TC-2-2');
  writeFileSync(specPath, SPEC_FILE.replace("{ name: 'Login' }", "{ name: 'Sign in' }"));
  assert.equal(must(root, 'heal', 'check', runId, 'TC-2', '--attempt', '2', '--test-file', 'tests/app.spec.js').ok, true);
  scenario(root, 'heal-TC-2-2', [pass('TC-2', 'Sign in button is available')]);
  must(root, 'exec', 'run', runId, '--label', 'heal-TC-2-2', '--test-id', 'TC-2', '--retries', '0');
  const rec2 = must(root, 'heal', 'record', runId, 'TC-2', '--attempt', '2', '--test-file', 'tests/app.spec.js',
    '--rationale', 'snapshot shows the button is now named "Sign in"; matches spec step 2', '--evidence', `exploration/home.aria.yml`);
  assert.equal(rec2.outcome, 'healed');
  assert.match(readFileSync(path.join(root, 'fake-pw/calls.log'), 'utf8'), /heal-TC-2-2 test --grep \\\[TC-2\\\] --retries 0/);

  // Limit: a third attempt for TC-2 is refused.
  const third = cli(root, 'heal', 'begin', runId, 'TC-2', '--test-file', 'tests/app.spec.js');
  assert.equal(third.code, 2);
  assert.equal(third.json.limitReached, true);
  const finish = must(root, 'heal', 'finish', runId);
  assert.deepEqual(finish.healedFiles, ['tests/app.spec.js']);
  stage(root, runId, 'healing', 'completed', 'healingLog=healing-log.json');

  stage(root, runId, 'regression_validation', 'running');
  scenario(root, 'regression', [
    pass('TC-1', 'Home page shows its heading'),
    pass('TC-2', 'Sign in button is available'),
    fail('TC-3', 'Dashboard title', ERRORS.mismatch),
    pass('TC-4', 'Search results load'),
  ]);
  must(root, 'exec', 'run', runId, '--label', 'regression', '--test-file', 'tests/app.spec.js');
  stage(root, runId, 'regression_validation', 'completed', 'regressionResults=regression-results.json');

  stage(root, runId, 'report_generation', 'running');
  const report = must(root, 'report', 'build', runId);
  assert.deepEqual(report.counts, { total: 5, passed: 1, failed: 1, flaky: 1, healed: 1, blocked: 1, skipped: 0, unresolved: 1 });
  assert.deepEqual(report.reporters.map((r: any) => `${r.name}:${r.status}`), ['html:generated', 'json:generated']);
  assert.deepEqual(report.unresolved.map((u: any) => u.key), ['TC-5@-']);
  stage(root, runId, 'report_generation', 'completed', 'summary=summary.json', 'summaryMarkdown=summary.md');

  stage(root, runId, 'finalization', 'running');
  assert.throws(() => { stage(root, runId, 'finalization', 'completed'); }, /test counts were not recorded/);
  must(root, 'run', 'finalize', runId);
  const done = stage(root, runId, 'finalization', 'completed');
  assert.equal(done.status, 'completed');
  assert.equal(must(root, 'run', 'show', runId).manifest.testCounts.healed, 1);

  const md = readFileSync(path.join(dependenciesDir(root), `runs/${runId}/summary.md`), 'utf8');
  assert.match(md, /\| 5 \| 1 \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(md, /\| \[TC-3\] Dashboard title \| chromium \| failed \| application_defect/);
  const log = JSON.parse(readFileSync(path.join(dependenciesDir(root), `runs/${runId}/healing-log.json`), 'utf8'));
  assert.deepEqual(log.entries.map((e: any) => `${e.attempt}:${e.outcome}:${e.reverted}`), ['1:rejected_by_guard:true', '2:healed:false']);
  assert.match(log.entries[1].diff, /-11: .*Login[\s\S]*\+11: .*Sign in/);
});

test('report generation failure is visible and blocks a clean finish', (t) => {
  const root = setupProject(t, ['html', 'json', 'junit']);
  const runId = startRun(root);
  exploreGenerateReview(root, runId);
  scenario(root, 'initial', [pass('TC-1', 'a'), pass('TC-2', 'b'), pass('TC-3', 'c'), pass('TC-4', 'd')]); // no junit.xml written
  stage(root, runId, 'execution', 'running');
  must(root, 'exec', 'run', runId);
  stage(root, runId, 'execution', 'completed', 'executionResults=execution-results.json');
  stage(root, runId, 'failure_triage', 'running');
  must(root, 'triage', 'run', runId);
  stage(root, runId, 'failure_triage', 'completed', 'failureAnalysis=failure-analysis.json');
  stage(root, runId, 'healing', 'skipped');
  stage(root, runId, 'regression_validation', 'skipped');
  stage(root, runId, 'report_generation', 'running');
  const r = cli(root, 'report', 'build', runId);
  assert.equal(r.code, 2);
  assert.equal(r.json.reporters.find((x: any) => x.name === 'junit').status, 'failed');
  assert.ok(existsSync(path.join(dependenciesDir(root), `runs/${runId}/summary.md`)), 'summary still written');
  const blocked = cli(root, 'run', 'stage', runId, 'report_generation', 'completed', '--artifact', 'summary=summary.json', '--artifact', 'summaryMarkdown=summary.md');
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stderr).kind, 'contract');
  const failed = stage(root, runId, 'report_generation', 'failed');
  assert.equal(failed.status, 'failed', 'run is failed, not completed');
});

test('the evidence-pdf reporter writes the evidence page and reports missing rendering tools instead of claiming a PDF', (t) => {
  const root = setupProject(t, ['html', 'json', 'allure', 'evidence-pdf'], {
    reporting: { mode: 'audit', stepScreenshots: true }, evidence: { video: 'on', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  });
  const runId = startRun(root);
  exploreGenerateReview(root, runId);
  scenario(root, 'initial', [pass('TC-1', 'a'), pass('TC-2', 'b'), pass('TC-3', 'c'), pass('TC-4', 'd')]);
  stage(root, runId, 'execution', 'running');
  must(root, 'exec', 'run', runId);
  stage(root, runId, 'execution', 'completed', 'executionResults=execution-results.json');
  stage(root, runId, 'failure_triage', 'running');
  must(root, 'triage', 'run', runId);
  stage(root, runId, 'failure_triage', 'completed', 'failureAnalysis=failure-analysis.json');
  stage(root, runId, 'healing', 'skipped');
  stage(root, runId, 'regression_validation', 'skipped');
  stage(root, runId, 'report_generation', 'running');
  const r = cli(root, 'report', 'build', runId);
  // The stand-in has no real @playwright/test or Chromium, so the PDF cannot be rendered: that must be visible.
  assert.equal(r.code, 2);
  const pdf = r.json.reporters.find((x: any) => x.name === 'evidence-pdf');
  assert.equal(pdf.status, 'missing_dependency');
  assert.equal(pdf.path, null);
  assert.match(pdf.detail, /@playwright\/test is required to render the PDF/);
  assert.deepEqual(r.json.reporters.filter((x: any) => x.name !== 'evidence-pdf').map((x: any) => x.status), ['generated', 'generated', 'missing_dependency'], 'allure results are absent');
  const page = path.join(root, 'reports', runId, 'evidence-report', 'evidence-report.html');
  assert.ok(existsSync(page), 'the evidence page is still written');
  assert.match(readFileSync(page, 'utf8'), /Test evidence report/);
  assert.ok(!existsSync(path.join(root, 'reports', runId, 'evidence-report', 'evidence-report.pdf')));
});

test('a runner/config error fails execution instead of reporting test results', (t) => {
  const root = setupProject(t);
  const runId = startRun(root);
  exploreGenerateReview(root, runId);
  stage(root, runId, 'execution', 'running');
  const r = cli(root, 'exec', 'run', runId); // no scenario: stand-in exits 3 without a report
  assert.equal(r.code, 2);
  assert.match(r.json.runnerError, /runner produced no JSON report \(exit code 3\)/);
  assert.equal(cli(root, 'run', 'stage', runId, 'execution', 'completed', '--artifact', 'executionResults=execution-results.json').code, 1);
});

test('malformed input blocks input validation with a clear reason', (t) => {
  const root = setupProject(t);
  writeDep(root, 'input/test-cases/demo.md', '# Just a title, no cases\n');
  writeDep(root, 'input/test-cases/bad.csv', 'Name,Notes\nx,y\n');
  const runId: string = must(root, 'run', 'create', '--command', 'generate-tests').runId;
  for (const s of ['preflight', 'configuration']) {
    stage(root, runId, s, 'running');
    if (s === 'configuration') must(root, 'run', 'set-config', runId);
    stage(root, runId, s, 'completed');
  }
  stage(root, runId, 'input_validation', 'running');
  const r = cli(root, 'input', 'validate', runId);
  assert.equal(r.code, 2);
  const messages = r.json.report.errors.map((e: any) => `${e.path}: ${e.message}`).join('\n');
  assert.match(messages, /bad\.csv.*no steps or expected-result column/s);
  assert.match(messages, /demo.md: no test cases found/);
  const blocked = stage(root, runId, 'input_validation', 'blocked');
  assert.equal(blocked.status, 'blocked');
});

test('declined installation is recorded, blocks the run, and the run resumes later', (t) => {
  const root = setupProject(t);
  const runId: string = must(root, 'run', 'create', '--command', 'run-tests').runId;
  stage(root, runId, 'preflight', 'running');
  must(root, 'deps', 'record', '--dependency', 'browser:chromium', '--action', 'declined', '--reason', 'Run generated tests', '--run', runId);
  const m = must(root, 'run', 'stage', runId, 'preflight', 'blocked', '--message', 'chromium browser install declined');
  assert.equal(m.status, 'blocked');
  assert.equal(must(root, 'run', 'show', runId).manifest.setupChanges[0].action, 'declined');
  const resumed = must(root, 'run', 'resume', runId);
  assert.equal(resumed.next, 'preflight');
  stage(root, runId, 'preflight', 'running');
  assert.equal(stage(root, runId, 'preflight', 'completed').currentStage, 'configuration');
});

test('/heal-tests works from an earlier run without modifying it', (t) => {
  const root = setupProject(t);
  const src = startRun(root);
  exploreGenerateReview(root, src);
  scenario(root, 'initial', [pass('TC-1', 'a'), fail('TC-2', 'Sign in button is available', ERRORS.notFound), pass('TC-3', 'c'), pass('TC-4', 'd')]);
  stage(root, src, 'execution', 'running');
  must(root, 'exec', 'run', src);
  stage(root, src, 'execution', 'completed', 'executionResults=execution-results.json');
  const srcResults = readFileSync(path.join(dependenciesDir(root), `runs/${src}/execution-results.json`), 'utf8');

  const heal: string = must(root, 'run', 'create', '--command', 'heal-tests', '--from-run', src).runId;
  for (const s of ['preflight', 'configuration']) {
    stage(root, heal, s, 'running');
    if (s === 'configuration') must(root, 'run', 'set-config', heal);
    stage(root, heal, s, 'completed');
  }
  stage(root, heal, 'failure_triage', 'running');
  const triage = must(root, 'triage', 'run', heal);
  assert.equal(triage.resultsFrom, src);
  assert.deepEqual(triage.eligibleForHealing, ['TC-2@chromium']);
  assert.equal(readFileSync(path.join(dependenciesDir(root), `runs/${src}/execution-results.json`), 'utf8'), srcResults);
  assert.equal(cli(root, 'run', 'create', '--command', 'heal-tests', '--from-run', '20990101-000000-abcdef').code, 1, 'unknown source run is refused');
});

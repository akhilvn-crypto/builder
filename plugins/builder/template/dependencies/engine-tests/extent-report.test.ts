// The "extent" report: one self-contained HTML page built from the normalized results, only when it is selected, with every value
// escaped, screenshots embedded, steps shown when the fixture recorded them, and report generation kept apart from test outcomes.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../engine/config/schema.ts';
import type { Attempt, ExecutionResults, TestResult } from '../engine/pipeline/execution.ts';
import type { EvidenceInputs } from '../engine/pipeline/evidence-report.ts';
import { MAX_EMBEDDED_IMAGE_BYTES, buildExtentReport, extentReportDir } from '../engine/pipeline/extent-report.ts';
import { buildSummary, computeFinalTests, countOutcomes } from '../engine/pipeline/reporting.ts';
import type { RunManifest } from '../engine/pipeline/run-manager.ts';
import { STEP_LOG_ATTACHMENT, STEP_LOG_SCHEMA_VERSION, type StepEvidenceLog } from '../engine/pipeline/step-evidence.ts';
import type { TestSpec, TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';

const RUN_ID = '20261020-120000-abc123';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const manifest = { runId: RUN_ID, command: 'run-tests', artifacts: {} } as unknown as RunManifest;

function spec(id: string, over: Partial<TestSpec> = {}): TestSpec {
  return {
    id, title: `Title of ${id}`, source: { path: 'input/x.md', line: 1, originalId: id, sheet: null }, suite: null, module: 'Login', moduleSlug: 'login',
    priority: 'High', tags: ['smoke'], preconditions: ['The user exists'], steps: [{ index: 1, action: 'Open the login page', expected: null }],
    expectedResults: ['The heading "Dashboard" is visible'], testData: [], ambiguities: [], status: 'ready', ...over,
  };
}
const specs = (...list: TestSpec[]): TestSpecDocument => ({ schemaVersion: 2, generatedAt: '2026-10-20T00:00:00Z', sources: [], specs: list });

interface AttemptOptions { status?: string; error?: string; steps?: { title: string; status?: 'passed' | 'failed'; error?: string }[]; log?: boolean; own?: boolean; video?: boolean }

function attempt(root: string, dir: string, o: AttemptOptions = {}): Attempt {
  const attachments: Attempt['attachments'] = [];
  const add = (name: string, file: string, contentType: string, body: Buffer | string) => {
    const rel = `test-results/${RUN_ID}/initial/${dir}/${file}`;
    writeFile(root, rel, body as string);
    attachments.push({ name, contentType, path: rel });
  };
  if (o.log) {
    add('final', 'attachments/final-0123.jpg', 'image/jpeg', PNG_1PX);
    const log: StepEvidenceLog = {
      schemaVersion: STEP_LOG_SCHEMA_VERSION, testTitle: 't',
      steps: (o.steps ?? []).map((s, i) => ({ index: i + 1, depth: 0, title: s.title, status: s.status ?? 'passed', startedAt: '2026-10-20T12:00:00.000Z', durationMs: 100 + i, error: s.error ?? null })),
      final: { status: o.status ?? 'passed', screenshot: 'final', screenshotNote: null },
    };
    add(STEP_LOG_ATTACHMENT, 'attachments/step-evidence-log-0123.json', 'application/json', JSON.stringify(log));
  }
  if (o.own) add('screenshot', 'test-failed-1.png', 'image/png', PNG_1PX);
  if (o.video) add('video', 'video.webm', 'video/webm', Buffer.alloc(2048, 7));
  const status = o.status ?? 'passed';
  return { retry: 0, status, durationMs: 500, errors: status === 'failed' ? [{ message: o.error ?? 'expect(locator).toBeVisible() failed', stack: null, location: null }] : [], attachments };
}

const result = (id: string, outcome: TestResult['outcome'], attempts: Attempt[]): TestResult =>
  ({ key: `${id}@chromium`, testId: id, title: `[${id}] Title of ${id}`, file: 'tests/login.spec.ts', line: 7, project: 'chromium', outcome, attempts });

const resultsOf = (tests: TestResult[]): ExecutionResults => ({
  schemaVersion: 1, runId: RUN_ID, label: 'initial', executedAt: '2026-10-20T12:00:00Z', command: [], exitCode: 0, runnerError: null,
  rawReport: null, runnerLog: '', stats: { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 }, tests,
});

function inputs(root: string, r: ExecutionResults, doc: TestSpecDocument | null, secrets: string[] = []): EvidenceInputs {
  const tests = computeFinalTests({ results: r, analysis: null, healing: null, regression: null, specs: doc, generation: null });
  return { rootDir: root, manifest, config: { ...validConfig(), reporters: ['json', 'extent'] }, tests, counts: countOutcomes(tests), results: r, regression: null, specs: doc, secrets, now: new Date('2026-10-20T12:30:00Z') };
}

const read = (root: string): string => readFileSync(path.join(extentReportDir(root, RUN_ID), 'index.html'), 'utf8');

test('"extent" is a valid reporter on its own, with no mode, no video and no step evidence', () => {
  assert.equal(validateConfig({ ...validConfig(), reporters: ['json', 'extent'] }).ok, true);
  assert.equal(validateConfig({ ...validConfig(), reporters: ['json', 'html', 'extent'], reporting: { mode: 'standard' } }).ok, true);
});

test('one HTML file with the dashboard, every test, its steps, errors and screenshots', (t) => {
  const root = tmpRoot(t);
  const r = resultsOf([
    result('TC-1', 'passed', [attempt(root, 'a', { log: true, steps: [{ title: 'Open the login page' }, { title: 'Sign in' }] })]),
    result('TC-2', 'failed', [attempt(root, 'b', { status: 'failed', log: true, steps: [{ title: 'Sign in', status: 'failed', error: 'Timeout 5000ms exceeded' }] })]),
    result('TC-3', 'passed', [attempt(root, 'c', { own: true })]),
  ]);
  const status = buildExtentReport(inputs(root, r, specs(spec('TC-1'), spec('TC-2'), spec('TC-3'), spec('TC-4', { status: 'needs_clarification' }))));
  assert.deepEqual([status.name, status.status], ['extent', 'generated']);
  assert.equal(status.path, `reports/${RUN_ID}/extent-report/index.html`);
  assert.match(status.detail ?? '', /4 tests, 3 recorded steps, 3 screenshots/);

  const html = read(root);
  assert.match(html, /^<!doctype html>/);
  for (const id of ['TC-1', 'TC-2', 'TC-3', 'TC-4']) assert.ok(html.includes(`[${id}]`), `${id} is listed`);
  assert.match(html, /Sign in/);
  assert.match(html, /Timeout 5000ms exceeded/);
  assert.match(html, /data-status="failed"/);
  assert.match(html, /data-status="blocked"/, 'a test that never ran is listed as blocked, not dropped');
  assert.equal((html.match(/<img src="data:image\/(jpeg|png);base64,/g) ?? []).length, 3, 'screenshots are embedded, so the file stands alone');
  assert.ok(!/(src|href)="https?:/.test(html), 'no external request: nothing is loaded from the network');
  assert.ok(!/<script src=/.test(html));
});

test('every value is HTML-escaped, so test data and error text cannot inject markup', (t) => {
  const root = tmpRoot(t);
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const r = resultsOf([result('TC-1', 'failed', [attempt(root, 'a', { status: 'failed', error: evil, log: true, steps: [{ title: evil, status: 'failed', error: evil }] })])]);
  buildExtentReport(inputs(root, r, specs(spec('TC-1', { title: evil, module: evil, tags: [evil] }))));
  const html = read(root);
  assert.ok(!html.includes('<script>alert(1)'), 'raw markup is never emitted');
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, 'the only script is the report\'s own');
});

test('secrets are masked in step titles, errors and the page', (t) => {
  const root = tmpRoot(t);
  const r = resultsOf([result('TC-1', 'failed', [attempt(root, 'a', { status: 'failed', error: 'login failed for hunter2pass', log: true, steps: [{ title: 'Type hunter2pass', status: 'failed', error: 'bad hunter2pass' }] })])]);
  buildExtentReport(inputs(root, r, specs(spec('TC-1')), ['hunter2pass']));
  assert.ok(!read(root).includes('hunter2pass'));
});

test('without a step log the report says what Playwright recorded and still lists the test case steps; videos are linked, not embedded', (t) => {
  const root = tmpRoot(t);
  const r = resultsOf([result('TC-1', 'failed', [attempt(root, 'a', { status: 'failed', own: true, video: true })])]);
  buildExtentReport(inputs(root, r, specs(spec('TC-1'))));
  const html = read(root);
  assert.match(html, /Screenshot recorded by Playwright/);
  assert.match(html, /Steps in the test case/);
  assert.match(html, /Open the login page/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/test-results\/[^"]*video\.webm"/, 'a relative link to the recording');
  assert.ok(!html.includes('data:video'), 'videos are never embedded');
});

test('an oversized screenshot is not embedded and the report says so', (t) => {
  const root = tmpRoot(t);
  const r = resultsOf([result('TC-1', 'failed', [attempt(root, 'a', { status: 'failed', own: true })])]);
  const big = Buffer.alloc(MAX_EMBEDDED_IMAGE_BYTES + 1, 1);
  writeFileSync(path.join(root, `test-results/${RUN_ID}/initial/a/test-failed-1.png`), big);
  assert.equal(buildExtentReport(inputs(root, r, specs(spec('TC-1')))).status, 'generated');
  assert.match(read(root), /could not be embedded \(missing or larger than 5\.0 MB\)/);
});

test('a report that cannot be written is a failed reporter, never an exception and never a test failure', (t) => {
  const root = tmpRoot(t);
  writeFile(root, `reports/${RUN_ID}`, 'a file where the report folder should be');
  const status = buildExtentReport(inputs(root, resultsOf([result('TC-1', 'passed', [attempt(root, 'a')])]), specs(spec('TC-1'))));
  assert.equal(status.status, 'failed');
  assert.match(status.detail ?? '', /Extent report failed/);
});

test('report build produces the Extent report only when it is selected, next to the other selected reports', (t) => {
  const root = tmpRoot(t);
  writeFile(root, `reports/${RUN_ID}/initial/results.json`, '{"suites":[]}');
  writeFile(root, `reports/${RUN_ID}/initial/html/index.html`, '<html>report</html>');
  const r = resultsOf([result('TC-1', 'passed', [attempt(root, 'a')]), result('TC-2', 'failed', [attempt(root, 'b', { status: 'failed' })])]);
  const build = (reporters: string[]) => buildSummary({
    rootDir: root, runDir: path.join(dependenciesDir(root), 'runs', RUN_ID), manifest, config: { ...validConfig(), reporters } as never, results: r, analysis: null, healing: null,
    regression: null, specs: specs(spec('TC-1'), spec('TC-2')), generation: null,
  });

  const without = build(['json', 'html']);
  assert.deepEqual(without.reporters.map((x) => x.name), ['json', 'html']);
  assert.equal(existsSync(extentReportDir(root, RUN_ID)), false, 'an unselected report is not built');

  const withExtent = build(['json', 'html', 'extent']);
  assert.deepEqual(withExtent.reporters.map((x) => `${x.name}:${x.status}`), ['json:generated', 'html:generated', 'extent:generated']);
  const extent = withExtent.reporters.find((x) => x.name === 'extent')!;
  assert.ok((extent.bytes ?? 0) > 0 && extent.files === 1);
  assert.deepEqual([withExtent.counts.passed, withExtent.counts.failed, withExtent.reportGeneration.ok], [1, 1, true], 'a failing test does not make the report fail');
  assert.match(readFileSync(path.join(dependenciesDir(root), 'runs', RUN_ID, 'summary.md'), 'utf8'), /- extent: generated — reports\/.*extent-report\/index\.html/);
});

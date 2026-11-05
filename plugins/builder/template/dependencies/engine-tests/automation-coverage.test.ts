// The automation coverage report: every test case is either automated (a script exists and ran) or not automated with a reason
// taken from the record that caused it; nothing is silently missing; the page is one self-contained file with every value escaped.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REASON_CODES, buildCoverage, coverageHtmlPath, renderCoverageHtml, validateAutomationCoverage, type CoverageInputs,
} from '../engine/pipeline/automation-coverage.ts';
import { CANONICAL_SCHEMA_VERSION, documentValidation, validationOf, type CanonicalCase, type CanonicalDocument } from '../engine/pipeline/canonical.ts';
import type { HandoffCase, HandoffDocument } from '../engine/pipeline/design-handoff.ts';
import type { ExecutionResults, TestResult } from '../engine/pipeline/execution.ts';
import type { GenerationManifest } from '../engine/pipeline/generation.ts';
import type { FinalTest } from '../engine/pipeline/reporting.ts';
import { initialStages } from '../engine/pipeline/state-manager.ts';
import type { Ambiguity } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const RUN_ID = '20261105-100000-abc123';

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  let json: any = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { code: r.status, json, stderr: r.stderr };
}

function canonicalCase(id: string, title: string, ambiguities: Ambiguity[] = [], module = 'Login', row = 2): CanonicalCase {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION, testCaseId: id, title, module, moduleSlug: module.toLowerCase(), suite: null,
    preconditions: [], steps: [{ stepNumber: 1, action: 'Open the page' }], expectedResults: ['It loads'], testData: [], priority: null, tags: [],
    source: { file: 'input/test-cases/login.xlsx', fileName: 'login.xlsx', format: 'xlsx', sheet: 'Login', row, endRow: row, line: null, endLine: null, heading: null, originalId: id },
    metadata: {}, validation: validationOf(ambiguities),
  };
}

const canonicalOf = (cases: CanonicalCase[], errors: { path: string; message: string }[] = [], findings: Parameters<typeof documentValidation>[2] = []): CanonicalDocument =>
  ({ schemaVersion: CANONICAL_SCHEMA_VERSION, generatedAt: 'x', sources: [], validation: documentValidation(cases, errors, findings), testCases: cases });

const generation = (tests: string[], excluded: { testId: string; reason: string }[] = []): GenerationManifest => ({
  schemaVersion: 1, generatedAt: 'x', language: 'typescript', sharedFilesChanged: [], excluded,
  tests: tests.map((id) => ({ testId: id, file: 'tests/login.spec.ts', title: `[${id}] title` })),
});

const result = (id: string, outcome: TestResult['outcome'], project = 'chromium'): TestResult =>
  ({ key: `${id}@${project}`, testId: id, title: `[${id}] t`, file: 'tests/login.spec.ts', line: 1, project, outcome, attempts: [] });

const execution = (tests: TestResult[], runnerError: string | null = null): ExecutionResults => ({
  schemaVersion: 1, runId: RUN_ID, label: 'initial', executedAt: 'x', command: [], exitCode: 0, runnerError, rawReport: null, runnerLog: 'x',
  stats: { passed: 0, failed: 0, flaky: 0, skipped: 0, total: tests.length }, tests,
});

const final = (id: string, outcome: FinalTest['outcome'], extra: Partial<FinalTest> = {}): FinalTest =>
  ({ key: `${id}@chromium`, testId: id, title: id, project: 'chromium', outcome, category: null, note: null, evidence: [], ...extra });

const manifest = (stages: Record<string, { status: string; message: string | null }> = {}): CoverageInputs['manifest'] => {
  const s = initialStages('playwright-pipeline');
  for (const [name, v] of Object.entries(stages)) (s as any)[name] = { ...(s as any)[name], ...v };
  // /builder:do-automation runs are ordinary playwright-pipeline runs
  return { runId: RUN_ID, command: 'playwright-pipeline', status: 'completed', stages: s };
};

const handoffCase = (over: Partial<HandoffCase>): HandoffCase => ({
  title: 't', module: 'Login', storyIds: ['US-001'], covers: [], techniques: [], scenarioKey: null, designFile: 'f', verdict: 'automatable',
  reasons: [], importedFile: null, importedSha256: null, ...over,
});
const handoffOf = (cases: Record<string, HandoffCase>): HandoffDocument => ({
  schemaVersion: 1, createdAt: '', designRunId: 'design-1', designRunStatus: 'completed', inputPath: 'input/test-cases/design', warnings: [], stories: {}, cases,
  readiness: { schemaVersion: 1, generatedAt: '', summary: { total: 0, automatable: 0, automatable_with_prerequisites: 0, manual: 0, blocked: 0 }, cases: [], missingEnvVars: [], overridden: [] },
});

const missing = (message: string): Ambiguity => ({ kind: 'missing_expected_result', message, stepIndex: 2 });

// A realistic mix: every way a case can end up automated or not.
function mixedRun(): CoverageInputs {
  const canonical = canonicalOf([
    canonicalCase('TC-1', 'Valid login', [], 'Login', 2),
    canonicalCase('TC-2', 'Wrong password', [], 'Login', 3),
    canonicalCase('TC-3', 'Reset password', [missing('Step 2 has no expected result')], 'Account', 4),
    canonicalCase('TC-4', '', [{ kind: 'untitled_case', message: 'The case has no title', stepIndex: null }], 'Account', 5),
    canonicalCase('TC-5', 'Export report', [], 'Reports', 6),
    canonicalCase('TC-6', 'Change language', [], 'Account', 7),
    canonicalCase('TC-7', 'Dark mode', [], 'Account', 8),
    canonicalCase('TC-8', 'Remember me', [], 'Login', 9),
  ], [{ path: 'input/test-cases/broken.xlsx', message: 'not a valid workbook' }],
  [{ severity: 'blocking', kind: 'ambiguous_column_mapping', file: 'input/test-cases/legacy.xlsx', sheet: 'Old', message: 'two columns could be the steps' }]);
  return {
    manifest: manifest(),
    canonical, specs: null,
    handoff: handoffOf({
      'MAN-1': handoffCase({ title: 'Solve the CAPTCHA', verdict: 'manual', reasons: [{ code: 'captcha', message: 'A CAPTCHA is designed to stop automated clients.' }] }),
      'TC-1': handoffCase({ storyIds: ['US-001', 'US-002'], importedFile: 'input/test-cases/design/a.md' }),
    }),
    generation: generation(['TC-1', 'TC-2', 'TC-6', 'TC-7', 'TC-8'], [{ testId: 'TC-5', reason: 'the export needs a download dialog the framework cannot drive' }]),
    execution: execution([result('TC-1', 'passed'), result('TC-2', 'failed'), result('TC-6', 'skipped'), result('TC-8', 'flaky')]),
    finalTests: [
      final('TC-1', 'passed'), final('TC-2', 'failed', { category: 'application_defect', note: 'login returns 500' }),
      final('TC-6', 'skipped'), final('TC-8', 'flaky', { note: 'passed only after retry' }),
    ],
  };
}

test('every case is automated or not automated, and every not-automated case says why', () => {
  const report = buildCoverage(mixedRun());
  const by = Object.fromEntries(report.cases.map((c) => [c.testId, c]));

  assert.equal(report.summary.total, 9, 'the 8 cases plus the manual case that was never imported');
  assert.equal(report.summary.automated + report.summary.notAutomated, report.summary.total);
  assert.deepEqual(validateAutomationCoverage(report), []);

  // automated: a script exists and ran. A failing script is still automation.
  assert.deepEqual([by['TC-1']!.status, by['TC-1']!.result], ['automated', 'passed']);
  assert.deepEqual([by['TC-2']!.status, by['TC-2']!.result], ['automated', 'failed']);
  assert.match(by['TC-2']!.resultNote!, /application defect/);
  assert.deepEqual([by['TC-8']!.status, by['TC-8']!.result], ['automated', 'flaky']);
  assert.deepEqual(by['TC-1']!.stories, ['US-001', 'US-002']);
  assert.equal(by['TC-1']!.script!.file, 'tests/login.spec.ts');

  const reason = (id: string) => by[id]!.reason!;
  assert.equal(reason('MAN-1').code, 'manual');
  assert.match(reason('MAN-1').details.join(' '), /CAPTCHA/);
  assert.match(reason('MAN-1').action, /design-test-n-automation.*--override-manual MAN-1/);
  assert.equal(reason('TC-3').code, 'needs_clarification');
  assert.match(reason('TC-3').details.join(' '), /Step 2 has no expected result/);
  assert.equal(reason('TC-4').code, 'invalid');
  assert.equal(reason('TC-5').code, 'not_generated');
  assert.match(reason('TC-5').details.join(' '), /download dialog/);
  assert.equal(reason('TC-6').code, 'skipped');
  assert.equal(reason('TC-7').code, 'not_run');

  for (const c of report.cases) {
    if (c.status === 'not_automated') {
      assert.ok(c.reason && c.reason.detail.length > 0 && c.reason.action.length > 0, `${c.testId} has a full reason`);
      assert.equal(c.result, null);
    } else {
      assert.equal(c.reason, null);
    }
  }
  assert.deepEqual(report.summary.byReason, { manual: 1, needs_clarification: 1, invalid: 1, not_in_run: 0, not_generated: 1, skipped: 1, not_run: 1, run_stopped: 0 });
  assert.deepEqual(report.summary.byResult, { passed: 1, failed: 1, flaky: 1, healed: 0 });
  assert.equal(report.summary.automatedPercent, Math.round((3 / 9) * 1000) / 10);

  // input the parser could not read is listed, not lost
  assert.deepEqual(report.inputProblems.map((p) => p.kind).sort(), ['ambiguous_column_mapping', 'unreadable_file']);
  assert.deepEqual(report.cases.map((c) => c.testId), ['MAN-1', 'TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6', 'TC-7', 'TC-8']);
});

test('a skipped project does not hide a browser that ran, and healed counts as automated', () => {
  const i = mixedRun();
  i.finalTests = [
    final('TC-1', 'passed'), final('TC-1', 'skipped', { project: 'firefox', key: 'TC-1@firefox' }),
    final('TC-2', 'healed', { note: 'script defect repaired; rerun passed' }),
    final('TC-6', 'skipped'), final('TC-6', 'skipped', { project: 'firefox', key: 'TC-6@firefox' }),
  ];
  const by = Object.fromEntries(buildCoverage(i).cases.map((c) => [c.testId, c]));
  assert.equal(by['TC-1']!.result, 'passed');
  assert.equal(by['TC-2']!.result, 'healed');
  assert.equal(by['TC-6']!.reason!.code, 'skipped', 'skipped everywhere means it verified nothing');
});

test('a run that stopped early explains the cases that never got a script, naming the stage', () => {
  const canonical = canonicalOf([canonicalCase('TC-1', 'Valid login'), canonicalCase('TC-2', 'Needs data', [missing('no data')])]);
  const report = buildCoverage({
    manifest: { ...manifest({ application_exploration: { status: 'blocked', message: 'TEST_PASSWORD has no value in automation/.env' } }), status: 'blocked' },
    canonical, specs: null, handoff: null, generation: null, execution: null, finalTests: null,
  });
  const by = Object.fromEntries(report.cases.map((c) => [c.testId, c]));
  assert.equal(report.stoppedAt!.stage, 'application_exploration');
  assert.equal(by['TC-1']!.reason!.code, 'run_stopped');
  assert.match(by['TC-1']!.reason!.details.join(' '), /application_exploration.*blocked.*TEST_PASSWORD/);
  assert.match(by['TC-1']!.reason!.action, /\/builder:do-automation resume 20261105-100000-abc123/);
  assert.equal(by['TC-2']!.reason!.code, 'needs_clarification', 'a case that was never going to be automated keeps its own reason');
  assert.equal(report.summary.automated, 0);
  const html = renderCoverageHtml(report);
  assert.match(html, /This run stopped at “application_exploration”/);
});

test('a script that was generated but never executed is run_stopped, not silently counted', () => {
  const report = buildCoverage({
    manifest: manifest({ execution: { status: 'failed', message: 'runner crashed' } }), canonical: canonicalOf([canonicalCase('TC-1', 'Valid login')]),
    specs: null, handoff: null, generation: generation(['TC-1']), execution: null, finalTests: null,
  });
  assert.equal(report.cases[0]!.reason!.code, 'run_stopped');
  assert.match(report.cases[0]!.reason!.detail, /generated, but the tests were never executed/);
});

test('with only test-specs.json (older runs) the report still works', () => {
  const report = buildCoverage({
    manifest: manifest(), canonical: null, handoff: null, generation: generation(['A-1']), execution: execution([result('A-1', 'passed')]), finalTests: [final('A-1', 'passed')],
    specs: {
      schemaVersion: 2, generatedAt: 'x', sources: [],
      specs: [
        { id: 'A-1', title: 'one', source: { path: 'input/a.md', line: 3, originalId: 'A-1', sheet: null }, suite: null, module: 'M', moduleSlug: 'm', priority: null, tags: [], preconditions: [], steps: [], expectedResults: [], testData: [], ambiguities: [], status: 'ready' },
        { id: 'A-2', title: 'two', source: { path: 'input/a.md', line: 9, originalId: 'A-2', sheet: null }, suite: null, module: 'M', moduleSlug: 'm', priority: null, tags: [], preconditions: [], steps: [], expectedResults: [], testData: [], ambiguities: [missing('no expected result')], status: 'needs_clarification' },
      ],
    },
  });
  assert.deepEqual(report.cases.map((c) => [c.testId, c.status]), [['A-1', 'automated'], ['A-2', 'not_automated']]);
  assert.match(report.cases[1]!.reason!.details.join(' '), /no expected result/);
});

test('secrets in a runner error are masked, and nothing is invented when there is nothing to explain', () => {
  const i: CoverageInputs = {
    manifest: manifest(), canonical: canonicalOf([canonicalCase('TC-1', 'Valid login'), canonicalCase('TC-2', 'Second')]), specs: null, handoff: null,
    generation: generation(['TC-1']), execution: execution([], 'login failed for hunter2-secret at the page'), finalTests: [], secrets: ['hunter2-secret'],
  };
  const report = buildCoverage(i);
  const by = Object.fromEntries(report.cases.map((c) => [c.testId, c]));
  assert.equal(by['TC-1']!.reason!.code, 'not_run');
  assert.doesNotMatch(JSON.stringify(report), /hunter2-secret/);
  assert.match(by['TC-1']!.reason!.details.join(' '), /\*\*\*/);
  assert.equal(by['TC-2']!.reason!.code, 'not_generated');
  assert.match(by['TC-2']!.reason!.detail, /recorded no reason/);
});

test('no test cases at all gives an honest empty report', () => {
  const report = buildCoverage({ manifest: manifest(), canonical: canonicalOf([], [{ path: 'input/x.xlsx', message: 'unreadable' }]), specs: null, handoff: null, generation: null, execution: null, finalTests: null });
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.automatedPercent, null);
  const html = renderCoverageHtml(report);
  assert.match(html, /There are no test cases to report on/);
  assert.match(html, /Input that did not become test cases \(1\)/);
});

test('the page is self-contained, escapes every value and filters by reason', () => {
  const i = mixedRun();
  i.canonical!.testCases[0]!.title = '<img src=x onerror=alert(1)> & "quoted"';
  i.canonical!.testCases[0]!.module = 'Log<in>';
  const html = renderCoverageHtml(buildCoverage(i));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
  assert.match(html, /Log&lt;in&gt;/);
  assert.doesNotMatch(html, /https?:\/\//, 'no external request and no link to anywhere');
  assert.match(html, /Content-Security-Policy/);
  for (const code of REASON_CODES) assert.match(html, new RegExp(`<option value="${code}">`), `the filter offers ${code}`);
  assert.match(html, /data-status="not_automated" data-reason="manual"/);
  assert.match(html, /To automate it:/);
  assert.match(html, /Why cases were not automated/);
  assert.match(html, /<tr class="case automated" data-status="automated"/);
});

test('"report coverage" writes the JSON and the page for a run that stopped early', (t) => {
  const root = tmpRoot(t);
  const created = cli(root, 'run', 'create', '--command', 'playwright-pipeline');
  assert.equal(created.code, 0, created.stderr + JSON.stringify(created.json));
  const runId: string = created.json.runId;
  const dir = path.join(dependenciesDir(root), 'runs', runId);
  writeFileSync(path.join(dir, 'canonical-test-cases.json'), JSON.stringify(canonicalOf([
    canonicalCase('TC-1', 'Valid login'), canonicalCase('TC-2', 'Unclear', [missing('Step 2 has no expected result')]),
  ])));

  const r = cli(root, 'report', 'coverage', runId);
  assert.equal(r.code, 0, r.stderr + JSON.stringify(r.json));
  assert.equal(r.json.total, 2);
  assert.equal(r.json.automated, 0);
  assert.equal(r.json.byReason.needs_clarification, 1);
  assert.equal(r.json.byReason.run_stopped, 1);
  assert.equal(r.json.html, `reports/${runId}/automation-coverage/index.html`);

  const page = coverageHtmlPath(root, runId);
  assert.ok(existsSync(page));
  assert.match(readFileSync(page, 'utf8'), /Step 2 has no expected result/);
  const saved = JSON.parse(readFileSync(path.join(dir, 'automation-coverage.json'), 'utf8'));
  assert.deepEqual(validateAutomationCoverage(saved), []);
});

test('validateAutomationCoverage refuses a report that has a case without its reason', () => {
  const report = buildCoverage(mixedRun());
  const broken = JSON.parse(JSON.stringify(report));
  broken.cases.find((c: any) => c.testId === 'TC-3').reason = null;
  assert.match(validateAutomationCoverage(broken).join(' '), /TC-3: not automated without a reason/);
});

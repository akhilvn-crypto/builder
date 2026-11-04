// The evidence-pdf report: step-log parsing, the model/HTML built from step evidence and videos, the PDF step (with an injected
// renderer, so no browser is needed) including the embedded videos, and the reporting integration.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../engine/config/schema.ts';
import type { Attempt, ExecutionResults, TestResult } from '../engine/pipeline/execution.ts';
import {
  buildEvidenceModel, buildEvidenceReport, evidenceReportDir, renderEvidenceHtml, type EvidenceInputs, type PdfRenderer, type VideoPreparer,
} from '../engine/pipeline/evidence-report.ts';
import { listEmbeddedFiles } from '../engine/pipeline/pdf-embed.ts';
import { buildSummary, computeFinalTests, countOutcomes } from '../engine/pipeline/reporting.ts';
import type { RunManifest } from '../engine/pipeline/run-manager.ts';
import { STEP_LOG_ATTACHMENT, STEP_LOG_SCHEMA_VERSION, parseStepLog, type StepEvidenceLog } from '../engine/pipeline/step-evidence.ts';
import type { TestSpec, TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';
import { pdfWithLinks } from './pdf-fixture.ts';

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

function specs(...list: TestSpec[]): TestSpecDocument {
  return { schemaVersion: 2, generatedAt: '2026-10-20T00:00:00Z', sources: [], specs: list };
}

interface AttemptOptions {
  retry?: number;
  status?: string;
  log?: Partial<StepEvidenceLog> | null; // null = the fixture left no step log
  steps?: { title: string; status?: 'passed' | 'failed'; error?: string }[];
  final?: boolean; // the fixture's final-state screenshot (default true)
  video?: boolean | number; // Playwright's recording(s) of the test (default one)
  ownScreenshot?: boolean; // a screenshot Playwright attached itself (evidence.screenshot)
}

const videoBytes = (dir: string, n: number): Buffer => Buffer.concat([Buffer.from(`WEBM-${dir}-${n}-`), Buffer.alloc(2000, n + 1)]);

// Writes what a run leaves behind for one attempt (copied attachments, the log, the recording) and returns the Attempt as the
// normalized execution results hold it.
function attempt(root: string, dir: string, o: AttemptOptions): Attempt {
  const attachments: Attempt['attachments'] = [];
  const add = (name: string, file: string, contentType: string, body: Buffer | string) => {
    const rel = `test-results/${RUN_ID}/initial/${dir}/${file}`;
    writeFile(root, rel, body as string);
    attachments.push({ name, contentType, path: rel });
  };
  if (o.log !== null) {
    const steps = (o.steps ?? []).map((s, i) => ({
      index: i + 1, depth: 0, title: s.title, status: s.status ?? 'passed', startedAt: '2026-10-20T12:00:00.000Z', durationMs: 120 + i, error: s.error ?? null,
    }));
    const hasFinal = o.final !== false;
    if (hasFinal) add('final', 'attachments/final-0123456789abcdef.jpg', 'image/jpeg', PNG_1PX);
    const log: StepEvidenceLog = {
      schemaVersion: STEP_LOG_SCHEMA_VERSION, testTitle: 't', steps,
      final: { status: o.status ?? 'passed', screenshot: hasFinal ? 'final' : null, screenshotNote: hasFinal ? null : 'the page was already closed' }, ...o.log,
    };
    add(STEP_LOG_ATTACHMENT, 'attachments/step-evidence-log-0123456789abcdef.json', 'application/json', JSON.stringify(log));
  }
  if (o.ownScreenshot) add('screenshot', 'test-failed-1.png', 'image/png', PNG_1PX);
  const videos = o.video === false ? 0 : typeof o.video === 'number' ? o.video : 1;
  for (let n = 1; n <= videos; n++) add('video', videos > 1 ? `video-${n}.webm` : 'video.webm', 'video/webm', videoBytes(dir, n));
  return { retry: o.retry ?? 0, status: o.status ?? 'passed', durationMs: 500, errors: o.status === 'failed' ? [{ message: 'expect(locator).toBeVisible() failed', stack: null, location: null }] : [], attachments };
}

function result(id: string, outcome: TestResult['outcome'], attempts: Attempt[]): TestResult {
  return { key: `${id}@chromium`, testId: id, title: `[${id}] Title of ${id}`, file: 'tests/login.spec.ts', line: 7, project: 'chromium', outcome, attempts };
}

function results(tests: TestResult[]): ExecutionResults {
  return {
    schemaVersion: 1, runId: RUN_ID, label: 'initial', executedAt: '2026-10-20T12:00:00Z', command: [], exitCode: 0, runnerError: null,
    rawReport: null, runnerLog: '', stats: { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 }, tests,
  };
}

function inputs(root: string, r: ExecutionResults, doc: TestSpecDocument | null, secrets: string[] = []): EvidenceInputs {
  const tests = computeFinalTests({ results: r, analysis: null, healing: null, regression: null, specs: doc, generation: null });
  return {
    rootDir: root, manifest, config: { ...validConfig(), reporters: ['json', 'evidence-pdf'] }, tests, counts: countOutcomes(tests),
    results: r, regression: null, specs: doc, secrets, now: new Date('2026-10-20T12:30:00Z'),
  };
}

const fakePdf: PdfRenderer = (_root, _html, pdf) => { writeFileSync(pdf, '%PDF-1.7\nfake'); return { ok: true, output: '' }; };

// Prints the way Chromium does: every link in the HTML becomes a Link annotation carrying its absolute address.
const printingPdf: PdfRenderer = (_root, html, pdf) => {
  const links = [...readFileSync(html, 'utf8').matchAll(/href="([^"]*#evidence-video-\d+)"/g)].map((m) => `file:///C:/project/${m[1]!.replace(/^(\.\.\/)+/, '')}`);
  writeFileSync(pdf, pdfWithLinks(links));
  return { ok: true, output: '' };
};

test('"evidence-pdf" is accepted only in audit mode with step evidence and a video for every test', () => {
  const audit = {
    ...validConfig(), reporters: ['html', 'json', 'allure', 'evidence-pdf'], reporting: { mode: 'audit', stepScreenshots: true },
    evidence: { video: 'on', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  };
  assert.equal(validateConfig(audit).ok, true);
  assert.equal(validateConfig({ ...audit, reporting: { mode: 'audit' } }).ok, false, 'step evidence is opt-in and the PDF needs it');
  assert.equal(validateConfig({ ...audit, reporting: { mode: 'full' } }).ok, false);
  assert.equal(validateConfig({ ...validConfig(), reporters: ['html', 'json', 'evidence-pdf'] }).ok, false, 'no mode, no PDF');
  for (const video of ['off', 'retain-on-failure']) {
    const r = validateConfig({ ...audit, evidence: { ...audit.evidence, video } });
    assert.equal(r.ok, false, `video "${video}" leaves passing tests without a recording`);
    assert.match(r.issues.map((x) => x.message).join(), /evidence\.video must be "on"/);
  }
});

test('parseStepLog accepts a log and rejects other shapes; per-step screenshot fields of older logs are ignored', () => {
  const good = { schemaVersion: 1, testTitle: 'x', final: { status: 'passed', screenshot: 'final' }, steps: [{ index: 2, title: 'b', status: 'failed' }, { index: 1, title: 'a', status: 'passed', screenshot: 'step-01' }] };
  const parsed = parseStepLog(good)!;
  assert.deepEqual(parsed.steps.map((s) => [s.index, s.status]), [[1, 'passed'], [2, 'failed']], 'ordered by index, missing fields defaulted');
  assert.ok(!('screenshot' in parsed.steps[0]!), 'steps carry no screenshot any more');
  assert.equal(parsed.final.screenshot, 'final');
  assert.equal(parseStepLog({ ...good, schemaVersion: 2 }), null);
  assert.equal(parseStepLog({ ...good, steps: [{ title: 5 }] }), null);
  assert.equal(parseStepLog(null), null);
});

test('the model gives each attempt its steps, ONE final-state screenshot and ONE video, and counts them', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open the login page' }, { title: 'Enter the credentials' }] })])]);
  const m = buildEvidenceModel(inputs(root, r, specs(spec('TC-1'))));
  const a = m.tests[0]!.attempts[0]!;
  assert.deepEqual(a.steps.map((s) => [s.index, s.title, s.status]), [[1, 'Open the login page', 'passed'], [2, 'Enter the credentials', 'passed']]);
  assert.ok(a.final?.image);
  assert.equal(a.videos.length, 1);
  assert.deepEqual(m.totals, { tests: 1, steps: 2, screenshots: 1, videos: 1 });
  assert.deepEqual(m.gaps, []);
  assert.equal(m.tests[0]!.module, 'Login');
  assert.deepEqual(m.tests[0]!.expectedResults, ['The heading "Dashboard" is visible']);
  const v = a.videos[0]!;
  assert.equal(v.token, 'evidence-video-1');
  assert.equal(v.fileName, 'TC-1-chromium-initial-attempt1.webm', 'named after the test, browser project and attempt');
  assert.equal(v.mime, 'video/webm');
  assert.equal(v.source, `test-results/${RUN_ID}/initial/tc1/video.webm`);
  assert.equal(readFileSync(v.file).length, v.bytes);
});

test('HTML lists the steps, then the video, then the final-state screenshot, with no per-step images; text is escaped', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Type <script>alert(1)</script> & go' }, { title: 'Second' }] })])]);
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, r, specs(spec('TC-1')))));
  assert.ok(!html.includes('<script>alert'), 'step titles are escaped');
  assert.match(html, /Type &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; go/);
  assert.equal(html.match(/<img /g)!.length, 1, 'one final-state screenshot, nothing per step');
  const stepOne = html.indexOf('Type &lt;script'), stepTwo = html.indexOf('>Second<'), video = html.indexOf('class="video"'), shot = html.indexOf('<img ');
  assert.ok(stepOne < stepTwo && stepTwo < video && video < shot, 'steps, then the video, then the final state');
  assert.match(html, /Execution video/);
  assert.match(html, /stored inside this PDF as the attachment <span class="mono">TC-1-chromium-initial-attempt1\.webm<\/span>/);
  assert.match(html, /<a class="play" href="[^"]*video\.webm#evidence-video-1"/, 'the play icon is the link pdf-embed replaces by the file');
  assert.doesNotMatch(html, /<video|<embed|<object/, 'a video tag would not survive printing; the embedding is done on the PDF');
  assert.match(html, /1 video\(s\) embedded/);
  assert.match(html, /Playing the videos/);
  assert.match(html, /The heading &quot;Dashboard&quot; is visible/);
  assert.match(html, /Steps in the test case/);
  assert.doesNotMatch(html, /src="(?!data:)/, 'no external or file references for images: the HTML is self-contained');
});

test('a failed attempt shows the failing step, its error, the failure state and its own video; retries are separate attempts', (t) => {
  const root = tmpRoot(t);
  const failing = (retry: number) => attempt(root, `tc2-${retry}`, { retry, status: 'failed', steps: [{ title: 'Open' }, { title: 'Expected: heading', status: 'failed', error: 'expect(locator).toBeVisible() failed' }] });
  const r = results([result('TC-2', 'failed', [failing(0), failing(1)])]);
  const m = buildEvidenceModel(inputs(root, r, specs(spec('TC-2'))));
  const html = renderEvidenceHtml(m);
  assert.match(html, /Initial run · attempt 1 of 2/);
  assert.match(html, /Initial run · attempt 2 of 2/);
  assert.match(html, /<span class="badge failed">FAILED<\/span>/);
  assert.match(html, /Failure state/);
  assert.equal(html.match(/<pre class="err">expect\(locator\)\.toBeVisible\(\) failed<\/pre>/g)!.length, 2, 'the step error is shown once per attempt, not repeated as the attempt error');
  assert.deepEqual(m.tests[0]!.attempts.flatMap((a) => a.videos.map((v) => [v.token, v.fileName])), [
    ['evidence-video-1', 'TC-2-chromium-initial-attempt1.webm'], ['evidence-video-2', 'TC-2-chromium-initial-attempt2.webm'],
  ], 'every attempt has its own video, matched to it by name and token');
});

test('the attempt error is not repeated when a step already shows it, even with Playwright\'s "Error: " prefix', (t) => {
  const root = tmpRoot(t);
  const a = attempt(root, 'tc10', { status: 'failed', steps: [{ title: 'Expected', status: 'failed', error: 'expect(locator).toBeVisible() failed\n\nLocator: x' }] });
  a.errors = [{ message: 'Error: expect(locator).toBeVisible() failed\n\nLocator: x\n    at body (file.ts:1:1)', stack: null, location: null }];
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, results([result('TC-10', 'failed', [a])]), specs(spec('TC-10')))));
  assert.equal(html.match(/<pre class="err">/g)!.length, 1);
});

test('every video belongs to its own test and run: tokens and file names are unique across tests and the regression run', (t) => {
  const root = tmpRoot(t);
  const regressionAttempt = attempt(root, 'tc1-regression', {});
  const initial = results([result('TC-1', 'failed', [attempt(root, 'tc1', { status: 'failed' })]), result('TC-2', 'passed', [attempt(root, 'tc2', {})])]);
  const base = inputs(root, initial, specs(spec('TC-1'), spec('TC-2')));
  const m = buildEvidenceModel({ ...base, regression: { ...results([result('TC-1', 'passed', [regressionAttempt])]), label: 'regression' } });
  const videos = m.tests.flatMap((x) => x.attempts.flatMap((a) => a.videos));
  assert.equal(videos.length, 3);
  assert.equal(new Set(videos.map((v) => v.token)).size, 3);
  assert.deepEqual(videos.map((v) => v.fileName), ['TC-1-chromium-initial-attempt1.webm', 'TC-1-chromium-regression-attempt1.webm', 'TC-2-chromium-initial-attempt1.webm']);
  assert.deepEqual(videos.map((v) => path.basename(path.dirname(v.file))), ['tc1', 'tc1-regression', 'tc2'], 'each points at its own recording');
});

test('a test that opened several pages lists each recording', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-8', 'passed', [attempt(root, 'tc8', { video: 2 })])]);
  const m = buildEvidenceModel(inputs(root, r, specs(spec('TC-8'))));
  assert.deepEqual(m.tests[0]!.attempts[0]!.videos.map((v) => v.fileName), ['TC-8-chromium-initial-attempt1-video1.webm', 'TC-8-chromium-initial-attempt1-video2.webm']);
  assert.match(renderEvidenceHtml(m), /video 2 of 2/);
});

test('an attempt error that no step shows (a failure outside any step) is still shown', (t) => {
  const root = tmpRoot(t);
  const a = attempt(root, 'tc7', { status: 'failed', steps: [{ title: 'Open' }] });
  a.errors = [{ message: 'Error: locator.click: Timeout 5000ms exceeded', stack: null, location: null }];
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, results([result('TC-7', 'failed', [a])]), specs(spec('TC-7')))));
  assert.match(html, /<pre class="err">Error: locator\.click: Timeout 5000ms exceeded<\/pre>/);
});

test('missing evidence is reported as a gap, never silently dropped', (t) => {
  const root = tmpRoot(t);
  const noLog = attempt(root, 'tc3', { log: null, video: false });
  const noShotNoVideo = attempt(root, 'tc4', { steps: [{ title: 'Only step' }], final: false, video: false });
  const r = results([result('TC-3', 'passed', [noLog]), result('TC-4', 'passed', [noShotNoVideo])]);
  const doc = specs(spec('TC-3'), spec('TC-4'), spec('TC-5'));
  const m = buildEvidenceModel(inputs(root, r, doc));
  assert.deepEqual(m.gaps.map((g) => g.replace(/ \(Initial run · attempt 1\)/, '')), [
    'TC-3: no step evidence was recorded (the test may not import fixtures/test, fixtures/test may predate the evidence-pdf reporter (run init --update), or the reporter was not configured when it ran)',
    'TC-3: no video was recorded (the report needs evidence.video "on", and a test that never opens a page has nothing to record)',
    'TC-4: no final-state screenshot — the page was already closed',
    'TC-4: no video was recorded (the report needs evidence.video "on", and a test that never opens a page has nothing to record)',
  ]);
  const html = renderEvidenceHtml(m);
  assert.match(html, /Evidence gaps \(4\)/);
  assert.match(html, /No step evidence was recorded for this attempt/);
  assert.match(html, /No screenshot: the page was already closed/);
  assert.match(html, /No video was recorded for this attempt/);
  assert.doesNotMatch(html, /Playing the videos/, 'nothing to explain when no video is in the report');
  const blocked = m.tests.find((x) => x.testId === 'TC-5')!;
  assert.equal(blocked.outcome, 'blocked');
  assert.match(html, /This test was not executed/);
});

test('without the fixture, the screenshot Playwright attached itself stands in for the final state', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-9', 'failed', [attempt(root, 'tc9', { log: null, status: 'failed', ownScreenshot: true })])]);
  const m = buildEvidenceModel(inputs(root, r, specs(spec('TC-9'))));
  assert.ok(m.tests[0]!.attempts[0]!.final?.image?.endsWith('test-failed-1.png'));
  assert.equal(m.totals.screenshots, 1);
});

test('secret values are masked in step titles, errors and attempt errors', (t) => {
  const root = tmpRoot(t);
  const a = attempt(root, 'tc6', { status: 'failed', steps: [{ title: 'Enter hunter2secret', status: 'failed', error: 'could not type hunter2secret' }] });
  a.errors = [{ message: 'password hunter2secret rejected', stack: null, location: null }];
  const r = results([result('TC-6', 'failed', [a])]);
  const html = renderEvidenceHtml(buildEvidenceModel(inputs(root, r, specs(spec('TC-6')), ['hunter2secret'])));
  assert.doesNotMatch(html, /hunter2secret/);
  assert.match(html, /Enter \*\*\*/);
});

test('the PDF step: generated, renderer failures, missing tooling and an invalid PDF are told apart', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }], video: false })])]);
  const i = inputs(root, r, specs(spec('TC-1')));
  const dir = evidenceReportDir(root, RUN_ID);

  const ok = buildEvidenceReport(i, fakePdf);
  assert.equal(ok.status, 'generated');
  assert.equal(ok.name, 'evidence-pdf');
  assert.equal(ok.path, `reports/${RUN_ID}/evidence-report/evidence-report.pdf`);
  assert.match(ok.detail!, /1 tests, 1 steps, 1 screenshots, 0 videos embedded/);
  assert.ok(existsSync(path.join(dir, 'evidence-report.html')));

  const stale = buildEvidenceReport(i, () => ({ ok: false, output: 'boom\nPage.pdf: Target closed' }));
  assert.equal(stale.status, 'failed');
  assert.match(stale.detail!, /PDF rendering failed: boom \| Page\.pdf: Target closed/);
  assert.ok(!existsSync(path.join(dir, 'evidence-report.pdf')), 'a previous PDF is removed so a failed build cannot leave a stale one');

  assert.equal(buildEvidenceReport(i, () => ({ ok: false, missing: 'browser', output: '' })).status, 'missing_dependency');
  assert.match(buildEvidenceReport(i, () => ({ ok: false, missing: 'playwright', output: '' })).detail!, /@playwright\/test is required/);

  const bad = buildEvidenceReport(i, (_r, _h, pdf) => { writeFileSync(pdf, 'not a pdf'); return { ok: true, output: '' }; });
  assert.equal(bad.status, 'failed');
  assert.match(bad.detail!, /no valid PDF/);
});

test('the videos are stored inside the PDF itself, byte for byte, at the place of their play icon', (t) => {
  const root = tmpRoot(t);
  const r = results([
    result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })]),
    result('TC-2', 'failed', [attempt(root, 'tc2', { status: 'failed', steps: [{ title: 'Open' }] })]),
  ]);
  const i = inputs(root, r, specs(spec('TC-1'), spec('TC-2')));
  const status = buildEvidenceReport(i, printingPdf);
  assert.equal(status.status, 'generated', status.detail ?? '');
  assert.match(status.detail!, /2 tests, 2 steps, 2 screenshots, 2 videos embedded/);

  const pdf = readFileSync(path.join(root, status.path!));
  const { files, annotations } = listEmbeddedFiles(pdf);
  assert.equal(annotations, 2, 'one play icon per video');
  const sha = (file: string) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
  assert.deepEqual(files.map((f) => [f.name, f.mime, f.sha256]).sort(), [
    ['TC-1-chromium-initial-attempt1.webm', 'video/webm', sha(`test-results/${RUN_ID}/initial/tc1/video.webm`)],
    ['TC-2-chromium-initial-attempt1.webm', 'video/webm', sha(`test-results/${RUN_ID}/initial/tc2/video.webm`)],
  ]);
  assert.ok(pdf.includes(videoBytes('tc1', 1)), 'the recording\'s bytes are inside the PDF, not a path to them');
  assert.ok(!pdf.toString('latin1').includes('file:///C:/project'), 'no local path of the machine that built the report is left in the PDF');
});

// A stand-in for the ffmpeg conversion: writes a small MP4-looking file per recording and marks it playable.
const mp4Bytes = (n: number): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(3000, n + 9)]);
const convertingAll: VideoPreparer = (videos, outDir) => {
  videos.forEach((v, n) => {
    const file = path.join(outDir, 'videos', v.fileName.replace(/\.webm$/, '.mp4'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, mp4Bytes(n));
    v.playable = { file, fileName: path.basename(file), mime: 'video/mp4', bytes: mp4Bytes(n).length };
  });
  return { playable: videos.length, note: null };
};

test('with MP4 conversions the videos play inside the PDF: a player per video that points at the stored MP4', (t) => {
  const root = tmpRoot(t);
  const r = results([
    result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })]),
    result('TC-2', 'failed', [attempt(root, 'tc2', { status: 'failed', steps: [{ title: 'Open' }] })]),
  ]);
  const i = inputs(root, r, specs(spec('TC-1'), spec('TC-2')));
  const status = buildEvidenceReport(i, printingPdf, undefined, convertingAll);
  assert.equal(status.status, 'generated', status.detail ?? '');
  assert.match(status.detail!, /2 videos embedded \(2 play inside the PDF in Acrobat\/Reader, 0 attachment only\)/);

  const pdf = readFileSync(path.join(root, status.path!));
  const back = listEmbeddedFiles(pdf);
  assert.deepEqual(back.players.map((p) => p.name).sort(), ['TC-1-chromium-initial-attempt1.mp4', 'TC-2-chromium-initial-attempt1.mp4']);
  assert.equal(back.annotations, 0, 'no attachment-only icon is left');
  assert.deepEqual(back.files.map((f) => f.mime), ['video/mp4', 'video/mp4']);
  assert.ok(!pdf.includes(videoBytes('tc1', 1)), 'the WebM is replaced by the MP4 in the PDF');

  const html = readFileSync(path.join(evidenceReportDir(root, RUN_ID), 'evidence-report.html'), 'utf8');
  assert.match(html, /<div class="video inline"><a class="play"/);
  assert.match(html, /<b>All 2 videos play inside this PDF\.<\/b>/);
  assert.match(html, /Adobe Acrobat \/ Reader/);
  assert.ok(existsSync(path.join(evidenceReportDir(root, RUN_ID), 'videos', 'TC-1-chromium-initial-attempt1.mp4')), 'the MP4s stay next to the report');
});

test('a recording that cannot be converted stays a WebM attachment and the report says why', (t) => {
  const root = tmpRoot(t);
  const r = results([
    result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })]),
    result('TC-2', 'passed', [attempt(root, 'tc2', { steps: [{ title: 'Open' }] })]),
  ]);
  const i = inputs(root, r, specs(spec('TC-1'), spec('TC-2')));
  const onlyFirst: VideoPreparer = (videos, outDir) => {
    convertingAll([videos[0]!], outDir);
    return { playable: 1, note: 'Conversion to MP4 failed for 1 video(s): ffmpeg could not convert video.webm.' };
  };
  const status = buildEvidenceReport(i, printingPdf, undefined, onlyFirst);
  assert.equal(status.status, 'generated', status.detail ?? '');
  assert.match(status.detail!, /\(1 play inside the PDF in Acrobat\/Reader, 1 attachment only\)/);
  assert.match(status.detail!, /1 video\(s\) are attachments only.*ffmpeg could not convert/);

  const back = listEmbeddedFiles(readFileSync(path.join(root, status.path!)));
  assert.equal(back.players.length, 1);
  assert.equal(back.annotations, 1);
  assert.deepEqual(back.files.map((f) => f.mime).sort(), ['video/mp4', 'video/webm']);
  const html = readFileSync(path.join(evidenceReportDir(root, RUN_ID), 'evidence-report.html'), 'utf8');
  assert.match(html, /1 of 2 videos play inside this PDF/);
  assert.match(html, /WebM file attachment/);
});

test('without ffmpeg the videos stay attachments, the cover page says how to get playback, and nothing is installed', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })])]);
  const i = inputs(root, r, specs(spec('TC-1')));
  const none: VideoPreparer = () => ({ playable: 0, note: 'To play them inside the page the report needs an ffmpeg with libx264, which was not found (ffmpeg could not be run).' });
  const status = buildEvidenceReport(i, printingPdf, undefined, none);
  assert.equal(status.status, 'generated');
  assert.match(status.detail!, /\(0 play inside the PDF in Acrobat\/Reader, 1 attachment only\).*needs an ffmpeg with libx264/);
  const html = readFileSync(path.join(evidenceReportDir(root, RUN_ID), 'evidence-report.html'), 'utf8');
  assert.match(html, /needs an ffmpeg with libx264/);
  assert.doesNotMatch(html, /video inline/);

  // a preparer that throws is also just a fallback
  const boom = buildEvidenceReport(i, printingPdf, undefined, () => { throw new Error('disk full'); });
  assert.equal(boom.status, 'generated');
  assert.match(boom.detail!, /Conversion to MP4 failed: disk full/);
});

test('if the videos cannot be embedded the report fails loudly instead of quietly shipping a PDF without them', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })])]);
  const status = buildEvidenceReport(inputs(root, r, specs(spec('TC-1'))), fakePdf);
  assert.equal(status.status, 'failed');
  assert.equal(status.path, null);
  assert.match(status.detail!, /the videos could not be embedded in the PDF: no startxref/);
});

test('a report with evidence gaps is still generated, with the gap count in the detail', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-3', 'passed', [attempt(root, 'tc3', { log: null, video: false })])]);
  const status = buildEvidenceReport(inputs(root, r, specs(spec('TC-3'))), fakePdf);
  assert.equal(status.status, 'generated');
  assert.match(status.detail!, /2 evidence gap\(s\) listed on the cover page/);
});

test('report build lists evidence-pdf next to the Playwright reporters and writes it into the summary', (t) => {
  const root = tmpRoot(t);
  const r = results([result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })])]);
  writeFile(root, `reports/${RUN_ID}/initial/results.json`, '{}');
  const runDir = path.join(root, '..', 'dependencies', 'runs', RUN_ID);
  const summary = buildSummary({
    rootDir: root, runDir, manifest, config: { ...validConfig(), reporters: ['json', 'evidence-pdf'] },
    results: r, analysis: null, healing: null, regression: null, specs: specs(spec('TC-1')), generation: null, pdfRenderer: printingPdf,
  });
  assert.deepEqual(summary.reporters.map((x) => `${x.name}:${x.status}`), ['json:generated', 'evidence-pdf:generated']);
  assert.match(readFileSync(path.join(runDir, 'summary.md'), 'utf8'), /- evidence-pdf: generated — reports\/.*evidence-report\.pdf \(1 tests, 1 steps, 1 screenshots, 1 videos embedded/);
});

// The run order is not the ID order (sign-in tests run last, dependent chains stay together), so the lists read by ID.
function outOfOrderRun(root: string) {
  const r = results([
    result('TC-2', 'failed', [attempt(root, 'tc2', { status: 'failed', steps: [{ title: 'Open' }] })]),
    result('TC-10', 'failed', [attempt(root, 'tc10', { status: 'failed', steps: [{ title: 'Open' }] })]),
    result('TC-1', 'passed', [attempt(root, 'tc1', { steps: [{ title: 'Open' }] })]),
  ]);
  return { r, doc: specs(spec('TC-1'), spec('TC-2'), spec('TC-5'), spec('TC-10')) };
}

test('the evidence report lists tests by ID (natural order) and keeps each execution position as a note', (t) => {
  const root = tmpRoot(t);
  const { r, doc } = outOfOrderRun(root);
  const m = buildEvidenceModel(inputs(root, r, doc));
  assert.deepEqual(m.tests.map((x) => [x.testId, x.runOrder]), [['TC-1', 3], ['TC-2', 1], ['TC-5', null], ['TC-10', 2]], 'TC-10 after TC-5, not after TC-1; TC-5 never ran');
  assert.equal(m.executed, 3);
  const html = renderEvidenceHtml(m);
  const order = ['TC-1', 'TC-2', 'TC-5', 'TC-10'].map((id) => html.indexOf(`<section class="test`) >= 0 ? html.indexOf(`<span class="mono">[${id}]</span>`) : -1);
  assert.ok(order.every((n) => n > 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'the per-test sections follow the ID order too');
  assert.match(html, /<td class="mono">TC-2<\/td><td><a href="#t1">Title of TC-2<\/a> <span class="muted order">ran 1st of 3<\/span>/, 'anchors still follow the execution order');
  assert.match(html, /<td class="mono">TC-1<\/td><td><a href="#t3">Title of TC-1<\/a> <span class="muted order">ran 3rd of 3<\/span>/);
  assert.match(html, /<dt>Execution order<\/dt><dd>ran 2nd of 3<\/dd>/);
  assert.doesNotMatch(html, /TC-5<\/td><td><a href="#t4">Title of TC-5<\/a> <span class="muted order">/, 'a test that never ran has no position');
});

test('summary.md lists the tests needing attention by ID with the execution position; summary.json stays in execution order', (t) => {
  const root = tmpRoot(t);
  const { r, doc } = outOfOrderRun(root);
  writeFile(root, `reports/${RUN_ID}/initial/results.json`, '{}');
  const runDir = path.join(root, '..', 'dependencies', 'runs', RUN_ID);
  const summary = buildSummary({
    rootDir: root, runDir, manifest, config: { ...validConfig(), reporters: ['json'] }, results: r, analysis: null, healing: null, regression: null, specs: doc, generation: null,
  });
  assert.deepEqual(summary.tests.map((x) => x.testId), ['TC-2', 'TC-10', 'TC-1', 'TC-5'], 'the machine-readable list is unchanged');
  assert.deepEqual(summary.tests.map((x) => x.runOrder), [1, 2, 3, null]);
  const md = readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  const rows = md.split('\n').filter((l) => /^\| \[TC-/.test(l));
  assert.deepEqual(rows.map((l) => /\[(TC-\d+)\]/.exec(l)![1]), ['TC-2', 'TC-5', 'TC-10']);
  assert.match(rows[0]!, /ran 1st of 3 \|$/);
  assert.match(rows[2]!, /ran 2nd of 3 \|$/);
  assert.doesNotMatch(rows[1]!, /ran \d/, 'TC-5 is blocked: it never ran');
});

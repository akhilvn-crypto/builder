// report_generation: final per-test outcomes, counts, reporter verification and the run summary.
// The custom evidence-pdf and extent reporters are built by evidence-report.ts / extent-report.ts and listed alongside the Playwright reporters.
// Summary files in the run directory (dependencies/runs/<run-id>/): summary.json (machine-readable) and summary.md.
// Reporter output itself lives in automation/reports/<run-id>/<label>/.
//
// Everything here is derived from the normalized execution results (never from an agent's narrative), and only the reporters
// the user selected are verified or built. Test outcomes and report generation are kept apart: a reporter that failed is a
// `reportGeneration` problem, a test that failed is a `counts` problem, and neither is reported as the other.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig, Reporter, ReportMode } from '../config/schema.ts';
import { readJson, sha256File, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { ARTIFACTS, EVIDENCE_DIR, REPORTS_DIR, reportsDirFor, runDir } from './artifact-manager.ts';
import { secretValuesFor } from './env-file.ts';
import { readCreatedData, summarizeData, type Leftover } from './created-data.ts';
import { buildEvidenceReport, type PdfRenderer } from './evidence-report.ts';
import { buildExtentReport } from './extent-report.ts';
import type { ExecutionResults, Outcome } from './execution.ts';
import type { Category, FailureAnalysis } from './failure-classifier.ts';
import type { GenerationManifest } from './generation.ts';
import type { HealingLog } from './healing.ts';
import type { RunManifest, TestCounts } from './run-manager.ts';
import { runSupervised } from './supervised-run.ts';
import type { TestSpecDocument } from './test-spec.ts';
import { compareTestIds, runOrderNote, sortedByTestId } from './test-order.ts';

export const SUMMARY_SCHEMA_VERSION = 1;
const MAX_LISTED_LEFTOVERS = 50;
export type FinalOutcome = Outcome | 'healed' | 'blocked';

export interface FinalTest {
  key: string;
  testId: string;
  title: string;
  project: string;
  outcome: FinalOutcome;
  category: Category | null;
  note: string | null;
  evidence: string[];
  // 1-based position in the execution results (the order the tests actually ran); null for a test that never ran.
  // Optional so summaries written before it existed stay valid. The lists in the reports are shown by test ID instead.
  runOrder?: number | null;
}

export interface ReporterStatus {
  name: Reporter;
  status: 'generated' | 'failed' | 'missing_dependency';
  path: string | null; // relative to automation/
  detail: string | null;
  // What the reporter cost, so artifact volume and generation time can be measured.
  durationMs?: number;
  bytes?: number;
  files?: number;
}

export interface RunSummary {
  schemaVersion: typeof SUMMARY_SCHEMA_VERSION;
  runId: string;
  command: string;
  generatedAt: string;
  counts: TestCounts;
  categories: Partial<Record<Category, number>>;
  healing: { attempts: number; healed: number; stillFailing: number; rejectedByGuard: number };
  tests: FinalTest[];
  unresolved: { key: string; reason: string }[];
  reporters: ReporterStatus[];
  runnerError: string | null;
  mode: ReportMode | null; // reporting.mode, null when none is configured
  // Report generation, kept apart from test outcomes: ok is false when a selected reporter did not produce its files.
  reportGeneration: { ok: boolean; durationMs: number; failed: { name: Reporter; status: ReporterStatus['status']; detail: string | null }[]; bytes: number; files: number };
  // Test data the run created (absent when it created none): what was removed and what is still there, with how to delete it.
  // Informational: leftovers never change a test outcome or fail the run.
  testData?: { created: number; removed: number; leftovers: Leftover[]; truncated: number };
  // The normalized results the reports were built from.
  generatedFrom: { executionResultsSha256: string | null; regressionResultsSha256: string | null };
  paths: Record<string, string>; // relative to automation/ ("../dependencies/runs/..." for run state)
}

export interface OutcomeInputs {
  results: ExecutionResults | null;
  analysis: FailureAnalysis | null;
  healing: HealingLog | null;
  regression: ExecutionResults | null;
  specs: TestSpecDocument | null;
  generation: GenerationManifest | null;
}

export function computeFinalTests(i: OutcomeInputs): FinalTest[] {
  const healed = new Set((i.healing?.entries ?? []).filter((e) => e.outcome === 'healed').map((e) => e.testId));
  const category = new Map((i.analysis?.failures ?? []).map((f) => [f.key, f.category]));
  const regression = new Map((i.regression?.tests ?? []).map((t) => [t.key, t]));
  const out: FinalTest[] = [];
  const seenIds = new Set<string>();

  for (const [position, t] of (i.results?.tests ?? []).entries()) {
    seenIds.add(t.testId);
    let outcome: FinalOutcome = t.outcome;
    let note: string | null = null;
    if (t.outcome === 'flaky') note = 'passed only after retry';
    if (t.outcome === 'failed' && healed.has(t.testId)) { outcome = 'healed'; note = 'script defect repaired; rerun passed'; }
    const reg = regression.get(t.key);
    if (reg && reg.outcome === 'failed' && outcome !== 'failed') {
      note = outcome === 'healed' ? 'failed in regression validation after healing' : 'failed in regression validation';
      outcome = 'failed';
    } else if (reg && outcome === 'healed' && reg.outcome !== 'passed') {
      note = `healed, but regression outcome was ${reg.outcome}`;
    }
    out.push({
      key: t.key, testId: t.testId, title: t.title, project: t.project, outcome,
      category: outcome === 'passed' ? null : category.get(t.key) ?? null,
      note,
      evidence: t.attempts.flatMap((a) => a.attachments.map((x) => x.path)),
      runOrder: position + 1,
    });
  }

  // Specs that never ran are blocked, with the reason — never silently dropped.
  const excluded = new Map((i.generation?.excluded ?? []).map((e) => [e.testId, e.reason]));
  for (const s of i.specs?.specs ?? []) {
    if (seenIds.has(s.id)) continue;
    const reason = s.status === 'needs_clarification'
      ? `needs clarification: ${s.ambiguities.map((a) => a.message).join('; ')}`
      : excluded.get(s.id) ?? (i.results ? 'generated test produced no result' : 'not executed');
    out.push({ key: `${s.id}@-`, testId: s.id, title: s.title, project: '-', outcome: 'blocked', category: null, note: reason, evidence: [], runOrder: null });
  }
  return out;
}

export function countOutcomes(tests: FinalTest[]): TestCounts {
  const c: TestCounts = { total: tests.length, passed: 0, failed: 0, flaky: 0, healed: 0, blocked: 0, skipped: 0, unresolved: 0 };
  for (const t of tests) {
    c[t.outcome]++;
    if (isUnresolved(t)) c.unresolved++;
  }
  return c;
}

// Unresolved = needs human follow-up on the automation: blocked, or failed for any reason other than
// a confirmed application defect (which is a reported product bug, not an automation problem).
function isUnresolved(t: FinalTest): boolean {
  return t.outcome === 'blocked' || (t.outcome === 'failed' && t.category !== 'application_defect');
}

// ---- reporters ----

export interface AllureRunner {
  (resultsDir: string, outDir: string, rootDir: string): { ok: boolean; output: string };
}

export const defaultAllureRunner: AllureRunner = (resultsDir, outDir, rootDir) => {
  const pkg = readJson(path.join(rootDir, 'node_modules', 'allure', 'package.json'));
  if (pkg.ok) {
    const bin = (pkg.value as { bin?: string | Record<string, string> }).bin;
    const rel = typeof bin === 'string' ? bin : bin?.allure;
    if (rel) {
      // Supervised: allure may start a Java process, which must not outlive a timed-out or killed report build.
      const r = runSupervised(process.execPath, [path.join(rootDir, 'node_modules', 'allure', rel), 'generate', resultsDir, '-o', outDir], { cwd: rootDir, timeoutMs: 10 * 60_000, role: 'allure' });
      return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.slice(-4000) };
    }
  }
  // Global CLI. Paths are generated by the pipeline (run dir), never user input.
  const r = runSupervised(`allure generate "${resultsDir}" -o "${outDir}"`, [], { cwd: rootDir, timeoutMs: 10 * 60_000, shell: true, role: 'allure' });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.slice(-4000) };
};

function nonEmptyFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
}

function footprint(abs: string): { bytes: number; files: number } {
  if (!existsSync(abs)) return { bytes: 0, files: 0 };
  const st = statSync(abs);
  if (st.isFile()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const d of readdirSync(abs, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    files++;
    bytes += statSync(path.join(d.parentPath, d.name)).size;
  }
  return { bytes, files };
}

// Everything on disk that belongs to a reporter, whether or not it succeeded (a failed reporter still left files).
function reporterFiles(name: Reporter, dir: string, rootDir: string, status: ReporterStatus): string[] {
  switch (name) {
    case 'json': return [path.join(dir, 'results.json')];
    case 'html': return [path.join(dir, 'html')];
    case 'junit': return [path.join(dir, 'junit.xml')];
    case 'allure': return [path.join(dir, 'allure-results'), path.join(dir, 'allure-report')];
    case 'extent':
    case 'evidence-pdf': return status.path ? [path.dirname(path.join(rootDir, status.path))] : [];
  }
}

// The reports the pipeline builds itself after the run (the others are written by Playwright while the tests run).
export interface BuiltReports {
  evidencePdf?: () => ReporterStatus;
  extent?: () => ReporterStatus;
}

export function verifyReporters(rootDir: string, runId: string, config: AutomationConfig, label: string, allure: AllureRunner, built: BuiltReports = {}): ReporterStatus[] {
  const dir = reportsDirFor(rootDir, runId, label);
  const rel = (p: string) => toPosixRelative(rootDir, p);
  const verifyOne = (name: Reporter): ReporterStatus => {
    if (name === 'json') {
      const p = path.join(dir, 'results.json');
      const ok = readJson(p).ok;
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'results.json missing or invalid' };
    }
    if (name === 'html') {
      const p = path.join(dir, 'html', 'index.html');
      const ok = nonEmptyFile(p);
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'html/index.html not found' };
    }
    if (name === 'junit') {
      const p = path.join(dir, 'junit.xml');
      const ok = nonEmptyFile(p) && /<testsuites?[\s>]/.test(readFileSync(p, 'utf8').slice(0, 2000));
      return { name, status: ok ? 'generated' : 'failed', path: ok ? rel(p) : null, detail: ok ? null : 'junit.xml missing or not JUnit XML' };
    }
    if (name === 'evidence-pdf') {
      return built.evidencePdf ? built.evidencePdf() : { name, status: 'failed', path: null, detail: 'evidence report was not built' };
    }
    if (name === 'extent') {
      return built.extent ? built.extent() : { name, status: 'failed', path: null, detail: 'Extent report was not built' };
    }
    // allure
    const resultsDir = path.join(dir, 'allure-results');
    if (!existsSync(resultsDir) || readdirSync(resultsDir).length === 0) {
      return { name, status: 'missing_dependency', path: null, detail: 'no allure-results: is allure-playwright installed and approved?' };
    }
    const outDir = path.join(dir, 'allure-report');
    const r = allure(resultsDir, outDir, rootDir);
    const index = path.join(outDir, 'index.html');
    if (r.ok && nonEmptyFile(index)) return { name, status: 'generated', path: rel(index), detail: null };
    return { name, status: 'failed', path: null, detail: `allure generate failed: ${r.output.trim().split('\n').slice(-3).join(' | ') || 'no index.html produced'}` };
  };
  return config.reporters.map((name) => {
    const started = Date.now();
    const status = verifyOne(name);
    const size = reporterFiles(name, dir, rootDir, status).map(footprint).reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), { bytes: 0, files: 0 });
    return { ...status, durationMs: Date.now() - started, ...size };
  });
}

// ---- summary ----

export interface BuildSummaryInput extends OutcomeInputs {
  rootDir: string;
  runDir: string; // the summary is written here
  reporterRunId?: string; // whose reporter output to verify, if another run executed the tests
  manifest: RunManifest;
  config: AutomationConfig;
  label?: string; // execution label whose reporter output is verified (default "initial")
  allure?: AllureRunner;
  pdfRenderer?: PdfRenderer; // renders the evidence-pdf report; default uses the project's Playwright + Chromium
  now?: Date;
}

export function buildSummary(i: BuildSummaryInput): RunSummary {
  const started = Date.now();
  const tests = computeFinalTests(i);
  const counts = countOutcomes(tests);
  const categories: Partial<Record<Category, number>> = {};
  for (const t of tests) if (t.category) categories[t.category] = (categories[t.category] ?? 0) + 1;
  const entries = i.healing?.entries ?? [];
  const label = i.label ?? 'initial';
  const reporterRunId = i.reporterRunId ?? i.manifest.runId;
  const reporters = i.results && existsSync(reportsDirFor(i.rootDir, reporterRunId, label))
    ? verifyReporters(i.rootDir, reporterRunId, i.config, label, i.allure ?? defaultAllureRunner, (() => {
      // Both pipeline-built reports are made from the same inputs: the final outcomes and the normalized execution results.
      const inputs = () => ({
        rootDir: i.rootDir, manifest: i.manifest, config: i.config, tests, counts, results: i.results, regression: i.regression, specs: i.specs,
        secrets: secretValuesFor(i.rootDir, i.config.auth.credentialEnvVars), now: i.now ?? new Date(),
      });
      return { evidencePdf: () => buildEvidenceReport(inputs(), i.pdfRenderer), extent: () => buildExtentReport(inputs()) };
    })())
    : i.config.reporters.map((name): ReporterStatus => ({ name, status: 'failed', path: null, detail: `no execution output for label "${label}" in this run` }));
  const rel = (p: string) => toPosixRelative(i.rootDir, p);
  const summary: RunSummary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runId: i.manifest.runId,
    command: i.manifest.command,
    generatedAt: (i.now ?? new Date()).toISOString(),
    counts,
    categories,
    healing: {
      attempts: entries.length,
      healed: entries.filter((e) => e.outcome === 'healed').length,
      stillFailing: entries.filter((e) => e.outcome === 'still_failing').length,
      rejectedByGuard: entries.filter((e) => e.outcome === 'rejected_by_guard').length,
    },
    tests,
    unresolved: tests.filter(isUnresolved).map((t) => ({ key: t.key, reason: t.note ?? t.category ?? 'failed' })),
    reporters,
    runnerError: i.results?.runnerError ?? null,
    mode: i.config.reporting?.mode ?? null,
    reportGeneration: { ok: true, durationMs: 0, failed: [], bytes: 0, files: 0 },
    generatedFrom: {
      executionResultsSha256: hashIfPresent(i.results ? resultsFile(runDir(i.rootDir, reporterRunId), 'initial') : null),
      regressionResultsSha256: hashIfPresent(path.join(i.runDir, ARTIFACTS.regressionResults)),
    },
    paths: {
      runDir: rel(i.runDir),
      evidence: rel(path.join(i.rootDir, EVIDENCE_DIR, i.manifest.runId)),
      reports: rel(path.join(i.rootDir, REPORTS_DIR, i.manifest.runId)),
      ...Object.fromEntries(Object.entries(i.manifest.artifacts).map(([k, v]) => [k, rel(path.join(i.runDir, v))])),
    },
  };
  const created = readCreatedData(i.runDir);
  if (created.length > 0) {
    const data = summarizeData(created, i.config);
    summary.testData = { created: data.total, removed: data.removed, leftovers: data.leftovers.slice(0, MAX_LISTED_LEFTOVERS), truncated: Math.max(0, data.leftovers.length - MAX_LISTED_LEFTOVERS) };
  }
  summary.reportGeneration = {
    ok: reporters.every((r) => r.status === 'generated'),
    durationMs: Date.now() - started,
    failed: reporters.filter((r) => r.status !== 'generated').map((r) => ({ name: r.name, status: r.status, detail: r.detail })),
    bytes: reporters.reduce((n, r) => n + (r.bytes ?? 0), 0),
    files: reporters.reduce((n, r) => n + (r.files ?? 0), 0),
  };
  mkdirSync(i.runDir, { recursive: true });
  writeJsonAtomic(path.join(i.runDir, ARTIFACTS.summary), summary);
  writeFileSync(path.join(i.runDir, ARTIFACTS.summaryMarkdown), renderSummaryMarkdown(summary));
  return summary;
}

function resultsFile(runDirectory: string, label: string): string {
  return label === 'initial' ? path.join(runDirectory, ARTIFACTS.executionResults) : path.join(runDirectory, ARTIFACTS.rerunsDir, `${label}.json`);
}

function hashIfPresent(file: string | null): string | null {
  return file && existsSync(file) ? sha256File(file) : null;
}

const kb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024))} KB`);

export function reportersOk(s: RunSummary): boolean {
  return s.reporters.every((r) => r.status === 'generated');
}

export function renderSummaryMarkdown(s: RunSummary): string {
  const c = s.counts;
  const lines = [
    `# Test run ${s.runId}`,
    '',
    `Command: \`/${s.command}\` · generated ${s.generatedAt}`,
    '',
    '| Total | Passed | Failed | Flaky (recovered) | Healed | Blocked | Skipped | Unresolved |',
    '|---|---|---|---|---|---|---|---|',
    `| ${c.total} | ${c.passed} | ${c.failed} | ${c.flaky} | ${c.healed} | ${c.blocked} | ${c.skipped} | ${c.unresolved} |`,
    '',
    'Flaky tests passed only after a retry and are not counted as passed.',
    '',
  ];
  if (s.runnerError) lines.push(`**Runner error:** ${s.runnerError}`, '');
  const cats = Object.entries(s.categories);
  if (cats.length) lines.push('## Failure categories', '', ...cats.map(([k, v]) => `- ${k}: ${v}`), '');
  lines.push('## Healing', '', `Attempts: ${s.healing.attempts} · healed: ${s.healing.healed} · still failing: ${s.healing.stillFailing} · rejected by guard: ${s.healing.rejectedByGuard}`, '');
  // Listed by test ID; where each test fell in the execution order is a note, not the sort key.
  const executed = s.tests.filter((t) => t.runOrder != null).length;
  const notPassed = sortedByTestId(s.tests.filter((t) => t.outcome !== 'passed'));
  if (notPassed.length) {
    lines.push('## Tests needing attention', '', '| Test | Project | Outcome | Category | Note |', '|---|---|---|---|---|');
    for (const t of notPassed) {
      const note = [t.note, runOrderNote(t.runOrder, executed)].filter(Boolean).join(' · ');
      lines.push(`| ${(t.title.startsWith(`[${t.testId}]`) ? t.title : `[${t.testId}] ${t.title}`).replace(/\|/g, '\\|')} | ${t.project} | ${t.outcome} | ${t.category ?? ''} | ${note.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (s.unresolved.length) lines.push('## Unresolved', '', ...[...s.unresolved].sort((a, b) => compareTestIds(a.key, b.key)).map((u) => `- ${u.key}: ${u.reason}`), '');
  if (s.testData) {
    const d = s.testData;
    lines.push('## Test data', '', `Created ${d.created} record(s) · removed ${d.removed} · still there ${d.leftovers.length + d.truncated}`, '');
    if (d.leftovers.length > 0) {
      lines.push('These records were created by the run and could not be removed automatically. They can be deleted:', '');
      for (const l of d.leftovers) lines.push(`- ${l.entity} "${l.identifier}"${l.testId ? ` (${l.testId})` : ''} — ${l.reason}; ${l.canBeDeletedBy ? `delete: ${l.canBeDeletedBy}` : 'no removal path is known, delete it by hand'}`);
      if (d.truncated > 0) lines.push(`- … and ${d.truncated} more (see created-data/ in the run folder)`);
      lines.push('');
    }
  }
  const g = s.reportGeneration;
  lines.push(
    '## Reports', '',
    `Mode: ${s.mode ?? 'not set (reporters used as chosen)'} · generated in ${(g.durationMs / 1000).toFixed(1)} s · ${g.files} file(s), ${kb(g.bytes)}`,
    `Report generation: ${g.ok ? 'ok' : `FAILED for ${g.failed.map((f) => f.name).join(', ')} — this is not a test failure`}`, '',
    ...s.reporters.map((r) => `- ${r.name}: ${r.status}${r.path ? ` — ${r.path}` : ''}${r.detail ? ` (${r.detail})` : ''}${r.bytes ? ` · ${kb(r.bytes)}` : ''}`), '',
  );
  lines.push('## Paths', '', ...Object.entries(s.paths).map(([k, v]) => `- ${k}: ${v}`), '');
  return lines.join('\n');
}

export function validateSummary(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['summary must be an object'];
  const s = v as Partial<RunSummary>;
  const issues: string[] = [];
  if (s.schemaVersion !== SUMMARY_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!s.counts || !Array.isArray(s.tests)) return [...issues, 'counts and tests are required'];
  if (s.counts.total !== s.tests.length) issues.push('counts.total does not match tests');
  for (const r of s.reporters ?? []) if (r.status !== 'generated') issues.push(`reporter ${r.name} ${r.status}: ${r.detail ?? ''}`);
  return issues;
}

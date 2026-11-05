// The automation coverage report: for every test case the user supplied (or the design stages handed over), was it automated, and
// if not, why not.
//
//   dependencies/runs/<run-id>/automation-coverage.json         the data (this module's AutomationCoverage)
//   automation/reports/<run-id>/automation-coverage/index.html  the page to open (one self-contained file, no external requests)
//
// "Automated" has one meaning here: a runnable Playwright script exists for the case AND Playwright ran it (passed, failed, flaky
// or healed). Whether it passed is a separate column: a script that fails because the application is broken is still automation.
// Everything else is "not automated", and every such case carries a reason code, a plain-language explanation taken from the record
// that caused it (the validator's blocking issues, the readiness rule, the generator's exclusion, the runner error), and the next step.
//
// It is a join of records the pipeline already keeps (canonical test cases, design handoff, generation manifest, execution results,
// the final per-test outcomes). Nothing is inferred or invented: when no record explains a case, the reason says exactly that.
// Unlike the run summary, it also covers cases that never became a spec (manual, unclear, invalid) and input the parser could not
// turn into cases at all, so the totals are the cases the user brought, not only the ones that got far enough to be counted.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../utils/fs.ts';
import { redactAll } from '../utils/redact.ts';
import { formatIst } from '../utils/time.ts';
import { ARTIFACTS, REPORTS_DIR, assertRunId } from './artifact-manager.ts';
import type { CanonicalCase, CanonicalDocument, ValidationStatus } from './canonical.ts';
import type { HandoffCase, HandoffDocument } from './design-handoff.ts';
import type { ExecutionResults } from './execution.ts';
import type { GenerationManifest } from './generation.ts';
import type { FinalOutcome, FinalTest } from './reporting.ts';
import type { RunManifest } from './run-manager.ts';
import { BLOCKING_AMBIGUITIES, type TestSpecDocument } from './test-spec.ts';
import { compareTestIds } from './test-order.ts';

export const COVERAGE_SCHEMA_VERSION = 1;
export const COVERAGE_DIR = 'automation-coverage';
export const COVERAGE_HTML = 'index.html';

export function coverageHtmlPath(rootDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(rootDir, REPORTS_DIR, runId, COVERAGE_DIR, COVERAGE_HTML);
}

// ---- reasons ----

export const REASON_CODES = [
  'manual', 'needs_clarification', 'invalid', 'not_in_run', 'not_generated', 'skipped', 'not_run', 'run_stopped',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_LABEL: Record<ReasonCode, string> = {
  manual: 'Needs a person (manual)',
  needs_clarification: 'Test case needs clarification',
  invalid: 'Test case is invalid',
  not_in_run: 'Not part of this run',
  not_generated: 'No script was generated',
  skipped: 'Script was skipped when it ran',
  not_run: 'Script has no execution result',
  run_stopped: 'Run stopped before it got here',
};

// What each reason means, in the words the report shows once per reason (not per case).
export const REASON_MEANING: Record<ReasonCode, string> = {
  manual: 'The readiness rules judged the case as something a script cannot do reliably (for example a CAPTCHA, a code sent to a phone or mailbox, or a subjective judgement), so it was left for manual execution.',
  needs_clarification: 'The test case is missing or contradicts something the automation needs (a step, an expected result, data, a column). The pipeline never guesses, so it was held back.',
  invalid: 'The test case cannot be identified as written (for example it has no title), so nothing can be generated or traced from it.',
  not_in_run: 'The case is known from the test design hand-over, but it is not among the test cases this run imported.',
  not_generated: 'The case was ready, but the generator wrote no script for it. The recorded reason says why.',
  skipped: 'A script exists, but Playwright skipped it when it ran, so it verified nothing.',
  not_run: 'A script exists, but the runner returned no result for it.',
  run_stopped: 'The run stopped (blocked, failed or cancelled) at an earlier stage, so the case never reached the point of having a script that ran.',
};

export interface Reason {
  code: ReasonCode;
  label: string;
  detail: string; // one sentence naming the cause for this case
  details: string[]; // the individual records behind it (blocking issues, readiness rules); may be empty
  action: string; // what to do to get it automated
}

export type CoverageStatus = 'automated' | 'not_automated';
export type AutomatedResult = 'passed' | 'failed' | 'flaky' | 'healed';
const RESULT_RANK: Record<AutomatedResult, number> = { passed: 1, healed: 2, flaky: 3, failed: 4 };

export interface CoverageCase {
  testId: string;
  title: string;
  module: string;
  stories: string[];
  source: string | null; // "<file> · row 4" / "<file> · line 12" / "<file> · sheet 'Login' row 4"
  status: CoverageStatus;
  result: AutomatedResult | null; // set when status is automated
  resultNote: string | null; // e.g. why it failed (category) or that it passed only after a retry
  script: { file: string; title: string } | null;
  reason: Reason | null; // set when status is not_automated
}

export interface InputProblem {
  file: string;
  sheet: string | null;
  kind: string;
  message: string;
}

export interface AutomationCoverage {
  schemaVersion: typeof COVERAGE_SCHEMA_VERSION;
  generatedAt: string;
  runId: string;
  command: string;
  runStatus: string;
  designRunId: string | null;
  stoppedAt: { stage: string; status: string; message: string | null } | null;
  summary: {
    total: number;
    automated: number;
    notAutomated: number;
    automatedPercent: number | null; // one decimal; null when there are no cases
    byResult: Record<AutomatedResult, number>;
    byReason: Record<ReasonCode, number>;
  };
  modules: { name: string; total: number; automated: number; notAutomated: number }[];
  cases: CoverageCase[];
  // Input the parser could not turn into test cases at all (unreadable file, table whose columns could not be read). The cases in
  // it, if any, are not in `cases`, so they are listed here instead of silently missing.
  inputProblems: InputProblem[];
}

export interface CoverageInputs {
  manifest: Pick<RunManifest, 'runId' | 'command' | 'status' | 'stages'>;
  now?: Date;
  canonical: CanonicalDocument | null;
  specs: TestSpecDocument | null;
  handoff: HandoffDocument | null;
  generation: GenerationManifest | null;
  execution: ExecutionResults | null;
  // The final per-test outcomes (healing and regression applied), as in summary.json. Null when nothing ran.
  finalTests: FinalTest[] | null;
  secrets?: readonly string[];
}

// ---- the case universe ----

interface Base {
  id: string;
  title: string;
  module: string;
  source: string | null;
  validation: ValidationStatus | null; // null: known only from the design hand-over
  blocking: string[];
  handoff: HandoffCase | null;
}

function sourceLabel(c: CanonicalCase): string {
  const s = c.source;
  const where = s.row != null ? `row ${s.row}` : s.line != null ? `line ${s.line}` : '';
  return [s.file, s.sheet ? `sheet "${s.sheet}"` : '', where].filter(Boolean).join(' · ');
}

function baseCases(i: CoverageInputs): Base[] {
  const handoff = i.handoff?.cases ?? {};
  const out = new Map<string, Base>();
  if (i.canonical) {
    for (const c of i.canonical.testCases) {
      out.set(c.testCaseId, {
        id: c.testCaseId, title: c.title, module: c.module, source: sourceLabel(c), validation: c.validation.status,
        blocking: c.validation.blocking.map((b) => `${b.code}${b.stepNumber != null ? ` (step ${b.stepNumber})` : ''}: ${b.message}`),
        handoff: handoff[c.testCaseId] ?? null,
      });
    }
  } else if (i.specs) {
    // Older runs have only test-specs.json: ready = automatable, anything else needs clarification.
    for (const s of i.specs.specs) {
      out.set(s.id, {
        id: s.id, title: s.title, module: s.module,
        source: `${s.source.path}${s.source.sheet ? ` · sheet "${s.source.sheet}"` : ''}${s.source.line ? ` · ${s.source.sheet ? 'row' : 'line'} ${s.source.line}` : ''}`,
        validation: s.status === 'ready' ? 'valid' : 'needs_clarification',
        blocking: s.ambiguities.filter((a) => BLOCKING_AMBIGUITIES.includes(a.kind)).map((a) => `${a.kind}${a.stepIndex != null ? ` (step ${a.stepIndex})` : ''}: ${a.message}`),
        handoff: handoff[s.id] ?? null,
      });
    }
  }
  // Cases the design handed over but this run never imported (the manual ones are withheld on purpose).
  for (const [id, h] of Object.entries(handoff)) {
    if (!out.has(id)) out.set(id, { id, title: h.title, module: h.module, source: h.designFile, validation: null, blocking: [], handoff: h });
  }
  return [...out.values()];
}

// ---- classification ----

function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stoppedAt(m: CoverageInputs['manifest']): AutomationCoverage['stoppedAt'] {
  for (const [stage, rec] of Object.entries(m.stages)) {
    if (rec.status === 'blocked' || rec.status === 'failed' || rec.status === 'cancelled') return { stage, status: rec.status, message: rec.message };
  }
  return null;
}

function reasonOf(code: ReasonCode, detail: string, details: string[], action: string): Reason {
  return { code, label: REASON_LABEL[code], detail, details, action };
}

export function buildCoverage(i: CoverageInputs): AutomationCoverage {
  const secrets = i.secrets ?? [];
  const clean = (s: string): string => redactAll(s, secrets);
  const resume = ['do-automation', 'design-test-n-automation'].includes(i.manifest.command) ? i.manifest.command : 'do-automation';
  const resumeCmd = `/builder:${resume} resume ${i.manifest.runId}`;
  const stop = stoppedAt(i.manifest);
  const scripts = new Map((i.generation?.tests ?? []).map((t) => [t.testId, t]));
  const excluded = new Map((i.generation?.excluded ?? []).map((e) => [e.testId, e.reason]));
  const ranFile = new Map((i.execution?.tests ?? []).map((t) => [t.testId, { file: t.file, title: t.title }]));

  // Per test: the final outcome across browsers/projects. Skipped in every project means it verified nothing.
  const rows = new Map<string, FinalTest[]>();
  for (const t of i.finalTests ?? []) {
    if (t.project === '-' || t.outcome === 'blocked') continue; // never ran: the reasons below say why
    rows.set(t.testId, [...(rows.get(t.testId) ?? []), t]);
  }
  const resultOf = (id: string): { result: AutomatedResult; note: string | null } | 'skipped' | null => {
    const mine = rows.get(id);
    if (!mine || mine.length === 0) return null;
    const ran = mine.filter((t): t is FinalTest & { outcome: AutomatedResult } => t.outcome !== 'skipped');
    if (ran.length === 0) return 'skipped';
    const worst = ran.reduce((a, b) => (RESULT_RANK[b.outcome] > RESULT_RANK[a.outcome] ? b : a));
    const note = [worst.category ? `category: ${worst.category.replace(/_/g, ' ')}` : '', worst.note ?? ''].filter(Boolean).join(' · ');
    return { result: worst.outcome, note: note ? clean(note) : null };
  };

  const cases: CoverageCase[] = baseCases(i).map((b): CoverageCase => {
    const script = scripts.get(b.id) ?? ranFile.get(b.id) ?? null;
    const common = { testId: b.id, title: b.title, module: b.module, stories: b.handoff?.storyIds ?? [], source: b.source, script: script ? { file: script.file, title: script.title } : null };
    const notAutomated = (reason: Reason): CoverageCase => ({ ...common, status: 'not_automated', result: null, resultNote: null, reason });

    // 1. The case itself cannot be automated (decided before any script exists).
    if (b.handoff?.verdict === 'manual' && !scripts.has(b.id) && !rows.has(b.id)) {
      return notAutomated(reasonOf('manual', 'Judged as needing a person; left out of the automation on purpose.',
        b.handoff.reasons.map((r) => r.message),
        `Run it by hand. If the blocker can be worked around in the test environment, choose to automate ${b.id} anyway when /builder:design-test-n-automation asks about manual cases (it hands the case over with --override-manual ${b.id}).`));
    }
    if (b.validation === 'invalid') {
      return notAutomated(reasonOf('invalid', 'The test case cannot be identified as written.', b.blocking,
        'Fix the case in its source file (a title is required), then resume the run so the input is read again.'));
    }
    if (b.validation === 'needs_clarification' || (b.validation === null && b.handoff?.verdict === 'blocked')) {
      const details = b.validation === null ? (b.handoff?.reasons.map((r) => r.message) ?? []) : b.blocking;
      return notAutomated(reasonOf('needs_clarification', 'A person must answer something before this case can be automated.', details,
        'Answer the open point in the test case (or choose a mapping for its columns), then resume the run so the input is read again.'));
    }
    if (b.validation === null) {
      return notAutomated(reasonOf('not_in_run', 'Known from the test design hand-over, but not among the test cases this run imported.', [],
        'Start /builder:design-test-n-automation again so the hand-over is redone and the case is imported.'));
    }

    // 2. The case is ready: did it get a script, and did the script run?
    const r = resultOf(b.id);
    if (r && r !== 'skipped') {
      return { ...common, status: 'automated', result: r.result, resultNote: r.note, reason: null };
    }
    if (r === 'skipped') {
      return notAutomated(reasonOf('skipped', 'Playwright skipped the script, so it verified nothing.',
        ['A common cause is a case it depends on failing, or a test marked skip.'], `Find out why it was skipped, then rerun: ${resumeCmd}`));
    }
    if (script && i.execution) {
      const err = i.execution.runnerError ? clean(firstLine(i.execution.runnerError)) : null;
      return notAutomated(reasonOf('not_run', `The script ${script.file} exists, but the runner returned no result for it.`,
        err ? [`Runner error: ${err}`] : [], `Look at the runner log of the run, fix the cause, then rerun: ${resumeCmd}`));
    }
    if (script) {
      return notAutomated(reasonOf('run_stopped', `The script ${script.file} was generated, but the tests were never executed.`,
        stop ? [`The run stopped at "${stop.stage}" (${stop.status})${stop.message ? `: ${clean(firstLine(stop.message))}` : ''}`] : [], `Resume the run: ${resumeCmd}`));
    }
    const why = excluded.get(b.id);
    if (why !== undefined) {
      return notAutomated(reasonOf('not_generated', 'The generator chose not to write a script for this case.', [clean(why)],
        'Remove the cause named above (in the test case or the application), then resume the run so the script is generated.'));
    }
    if (i.generation) {
      return notAutomated(reasonOf('not_generated', 'The generator finished without a script for this case and recorded no reason.', [],
        `Check generation-report.md in the run folder, then resume the run: ${resumeCmd}`));
    }
    return notAutomated(reasonOf('run_stopped', 'The run stopped before test generation, so no script exists yet.',
      stop ? [`The run stopped at "${stop.stage}" (${stop.status})${stop.message ? `: ${clean(firstLine(stop.message))}` : ''}`] : ['Test generation has not run yet.'],
      `Resume the run: ${resumeCmd}`));
  });
  cases.sort((a, b) => compareTestIds(a.testId, b.testId));

  const byReason = Object.fromEntries(REASON_CODES.map((c) => [c, 0])) as Record<ReasonCode, number>;
  const byResult: Record<AutomatedResult, number> = { passed: 0, failed: 0, flaky: 0, healed: 0 };
  const modules = new Map<string, { name: string; total: number; automated: number; notAutomated: number }>();
  for (const c of cases) {
    if (c.reason) byReason[c.reason.code]++;
    if (c.result) byResult[c.result]++;
    const m = modules.get(c.module) ?? { name: c.module, total: 0, automated: 0, notAutomated: 0 };
    m.total++;
    if (c.status === 'automated') m.automated++; else m.notAutomated++;
    modules.set(c.module, m);
  }
  const automated = cases.filter((c) => c.status === 'automated').length;

  const problems: InputProblem[] = [];
  for (const e of i.canonical?.validation.errors ?? []) problems.push({ file: e.path, sheet: null, kind: 'unreadable_file', message: clean(e.message) });
  for (const f of i.canonical?.validation.findings ?? []) {
    if (f.severity === 'blocking') problems.push({ file: f.file, sheet: f.sheet, kind: f.kind, message: clean(f.message) });
  }

  return {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    generatedAt: (i.now ?? new Date()).toISOString(),
    runId: i.manifest.runId,
    command: i.manifest.command,
    runStatus: i.manifest.status,
    designRunId: i.handoff?.designRunId ?? null,
    stoppedAt: stop,
    summary: {
      total: cases.length, automated, notAutomated: cases.length - automated,
      automatedPercent: cases.length === 0 ? null : Math.round((automated / cases.length) * 1000) / 10,
      byResult, byReason,
    },
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    cases,
    inputProblems: problems,
  };
}

export function validateAutomationCoverage(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['automation coverage must be an object'];
  const r = v as Partial<AutomationCoverage>;
  const issues: string[] = [];
  if (r.schemaVersion !== COVERAGE_SCHEMA_VERSION) issues.push('unsupported automation coverage schemaVersion');
  if (!Array.isArray(r.cases) || !r.summary) return [...issues, 'cases and summary are required'];
  if (r.summary.total !== r.cases.length) issues.push('summary.total does not match cases');
  for (const c of r.cases) {
    if (c.status === 'not_automated' && !c.reason) issues.push(`${c.testId}: not automated without a reason`);
    if (c.status === 'automated' && !c.result) issues.push(`${c.testId}: automated without a result`);
  }
  return issues;
}

// ---- files ----

export function writeCoverageFiles(rootDir: string, runDirectory: string, report: AutomationCoverage): { json: string; html: string } {
  mkdirSync(runDirectory, { recursive: true });
  const json = path.join(runDirectory, ARTIFACTS.automationCoverage);
  writeJsonAtomic(json, report);
  const html = coverageHtmlPath(rootDir, report.runId);
  mkdirSync(path.dirname(html), { recursive: true });
  writeFileSync(html, renderCoverageHtml(report));
  return { json, html };
}

// ---- the page ----

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const e = escapeHtml;

const RESULT_LABEL: Record<AutomatedResult, string> = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', healed: 'Healed' };
const pct = (n: number, total: number): string => (total === 0 ? '0' : ((n / total) * 100).toFixed(1).replace(/\.0$/, ''));

const CSS = `
:root { --bg:#f3f5f8; --card:#fff; --ink:#1d2733; --muted:#5d6b7b; --line:#dbe1e8; --soft:#eef1f5; --accent:#2a6fdb;
  --ok:#1e8a46; --okbg:#e7f5ec; --no:#b3261e; --nobg:#fdf0ef; --warn:#b26a00; --info:#2a6fdb; }
:root[data-theme="dark"] { --bg:#14181e; --card:#1d242d; --ink:#e6ebf1; --muted:#9aa7b6; --line:#2d3743; --soft:#242d38; --accent:#6ea3ff;
  --ok:#4cc47a; --okbg:#18281f; --no:#ff7b72; --nobg:#2c1b1b; --warn:#e0a44a; --info:#6ea3ff; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.mono { font-family: Consolas, "Courier New", monospace; font-size: 12px; } .muted { color: var(--muted); }
header.top { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; padding: 12px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
header.top h1 { font-size: 17px; margin: 0; flex: 1 1 260px; } header.top h1 small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.tool { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
main { max-width: 1180px; margin: 0 auto; padding: 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card b { display: block; font-size: 26px; line-height: 1.2; } .card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card.ok b { color: var(--ok); } .card.no b { color: var(--no); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 14px; overflow-x: auto; }
.panel h2 { font-size: 14px; margin: 0 0 10px; } .panel p { margin: 4px 0; }
.bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--soft); } .bar i { display: block; height: 100%; }
.bar .a { background: var(--ok); } .bar .n { background: var(--no); }
.banner { border: 1px solid var(--warn); border-left-width: 5px; border-radius: 8px; background: var(--card); padding: 10px 14px; margin-bottom: 14px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--soft); font-weight: 600; white-space: nowrap; } th.num { text-align: right; } td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.badge { display: inline-block; border-radius: 4px; padding: 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .03em; color: #fff; white-space: nowrap; }
.badge.automated { background: var(--ok); } .badge.not_automated { background: var(--no); }
.res { display: inline-block; font-size: 12px; margin-top: 4px; } .res.passed { color: var(--ok); } .res.failed { color: var(--no); } .res.flaky, .res.healed { color: var(--warn); }
.chip { display: inline-block; font-size: 11px; background: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; margin: 2px 4px 0 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.toolbar select, .toolbar input { font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; }
.toolbar input { flex: 1 1 220px; min-width: 180px; }
tr.case.automated td:first-child { border-left: 4px solid var(--ok); } tr.case.not_automated td:first-child { border-left: 4px solid var(--no); }
.why { background: var(--nobg); border-radius: 6px; padding: 8px 12px; } .why b { color: var(--no); }
.why ul { margin: 4px 0 0 18px; padding: 0; } .why .todo { margin-top: 6px; color: var(--muted); } .why .todo b { color: var(--ink); }
dl.reasons { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; } dl.reasons dt { font-weight: 600; } dl.reasons dd { margin: 0; }
.empty { padding: 24px; text-align: center; color: var(--muted); } [hidden] { display: none !important; }
`;

const SCRIPT = `
(function () {
  var root = document.documentElement;
  try { var saved = localStorage.getItem('coverage-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (x) {}
  var $ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var theme = document.getElementById('theme');
  if (theme) theme.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('coverage-theme', next); } catch (x) {}
  });
  var f = { status: '', reason: '', module: '', q: '' };
  function apply() {
    var shown = 0;
    $('tr.case').forEach(function (r) {
      var ok = (!f.status || r.dataset.status === f.status) && (!f.reason || r.dataset.reason === f.reason) &&
        (!f.module || r.dataset.module === f.module) && (!f.q || r.dataset.search.indexOf(f.q) !== -1);
      r.hidden = !ok; if (ok) shown++;
    });
    document.getElementById('none').hidden = shown !== 0;
    document.getElementById('count').textContent = shown + ' shown';
  }
  [['f-status', 'status'], ['f-reason', 'reason'], ['f-module', 'module']].forEach(function (p) {
    var el = document.getElementById(p[0]);
    if (el) el.addEventListener('change', function () { f[p[1]] = el.value; apply(); });
  });
  var q = document.getElementById('f-q');
  if (q) q.addEventListener('input', function () { f.q = q.value.trim().toLowerCase(); apply(); });
  $('[data-jump]').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      var s = document.getElementById('f-status'), r = document.getElementById('f-reason');
      s.value = 'not_automated'; r.value = a.dataset.jump; f.status = s.value; f.reason = r.value; apply();
      document.getElementById('cases').scrollIntoView();
    });
  });
  apply();
})();
`;

function caseRow(c: CoverageCase): string {
  const search = [c.testId, c.title, c.module, c.stories.join(' '), c.source ?? '', c.reason?.label ?? '', c.reason?.detail ?? '', ...(c.reason?.details ?? [])].join(' ').toLowerCase();
  const stories = c.stories.map((s) => `<span class="chip">${e(s)}</span>`).join('');
  const outcome = c.status === 'automated' && c.result
    ? `<div><span class="res ${c.result}"><b>${RESULT_LABEL[c.result]}</b></span>${c.resultNote ? ` <span class="muted">· ${e(c.resultNote)}</span>` : ''}</div>`
      + `<div class="mono muted">${c.script ? e(c.script.file) : ''}</div>`
    : c.reason
      ? `<div class="why"><b>${e(c.reason.label)}</b><p>${e(c.reason.detail)}</p>${
        c.reason.details.length > 0 ? `<ul>${c.reason.details.map((d) => `<li>${e(d)}</li>`).join('')}</ul>` : ''
      }<p class="todo"><b>To automate it:</b> ${e(c.reason.action)}</p></div>`
      : '';
  return `<tr class="case ${c.status}" data-status="${c.status}" data-reason="${c.reason?.code ?? ''}" data-module="${e(c.module)}" data-search="${e(search)}">`
    + `<td><b>${e(c.testId)}</b><br>${e(c.title)}<div>${stories}</div>${c.source ? `<div class="mono muted">${e(c.source)}</div>` : ''}</td>`
    + `<td>${e(c.module)}</td>`
    + `<td><span class="badge ${c.status}">${c.status === 'automated' ? 'AUTOMATED' : 'NOT AUTOMATED'}</span></td>`
    + `<td>${outcome}</td></tr>`;
}

export function renderCoverageHtml(r: AutomationCoverage): string {
  const s = r.summary;
  const reasonsUsed = REASON_CODES.filter((c) => s.byReason[c] > 0);
  const moduleNames = r.modules.map((m) => m.name);
  const stopBanner = r.stoppedAt
    ? `<div class="banner"><b>This run stopped at “${e(r.stoppedAt.stage)}” (${e(r.stoppedAt.status)}).</b>${r.stoppedAt.message ? ` ${e(r.stoppedAt.message)}` : ''}<br>`
      + `<span class="muted">Cases that had not got far enough are listed as “Run stopped before it got here”. Resume the run to continue.</span></div>`
    : '';
  const reasonBlock = reasonsUsed.length === 0
    ? `<p>${s.total === 0 ? 'There are no test cases to report on.' : 'Every test case was automated.'}</p>`
    : `<dl class="reasons">${reasonsUsed.map((c) =>
      `<dt><a href="#cases" data-jump="${c}">${e(REASON_LABEL[c])}</a><br><span class="muted">${s.byReason[c]} case${s.byReason[c] === 1 ? '' : 's'}</span></dt><dd>${e(REASON_MEANING[c])}</dd>`).join('')}</dl>`;
  const problems = r.inputProblems.length === 0 ? '' : `<div class="panel"><h2>Input that did not become test cases (${r.inputProblems.length})</h2>`
    + `<p class="muted">The cases in these files or tables are not in the counts above, because the pipeline could not read them as test cases.</p>`
    + `<table><thead><tr><th>File</th><th>Sheet</th><th>Problem</th><th>Detail</th></tr></thead><tbody>${r.inputProblems.map((p) =>
      `<tr><td class="mono">${e(p.file)}</td><td>${p.sheet ? e(p.sheet) : '—'}</td><td>${e(p.kind.replace(/_/g, ' '))}</td><td>${e(p.message)}</td></tr>`).join('')}</tbody></table></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Automation coverage — ${e(r.runId)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <h1>Automation coverage<small>Run ${e(r.runId)} · /${e(r.command)} · run ${e(r.runStatus)} · generated ${e(formatIst(r.generatedAt))}${r.designRunId ? ` · test design run ${e(r.designRunId)}` : ''}</small></h1>
  <button class="tool" id="theme" type="button">Light / dark</button>
</header>
<main>
${stopBanner}
<div class="cards">
  <div class="card"><b>${s.total}</b><span>Test cases</span></div>
  <div class="card ok"><b>${s.automated}</b><span>Automated</span></div>
  <div class="card no"><b>${s.notAutomated}</b><span>Not automated</span></div>
  <div class="card"><b>${s.automatedPercent === null ? '—' : `${s.automatedPercent}%`}</b><span>Automation coverage</span></div>
  <div class="card"><b>${s.byResult.passed}</b><span>Automated and passing</span></div>
  <div class="card"><b>${s.byResult.failed + s.byResult.flaky}</b><span>Automated, failing or flaky</span></div>
</div>
<div class="panel">
  <h2>Automated vs not automated</h2>
  <div class="bar" role="img" aria-label="${s.automated} automated, ${s.notAutomated} not automated"><i class="a" style="width:${pct(s.automated, s.total)}%"></i><i class="n" style="width:${pct(s.notAutomated, s.total)}%"></i></div>
  <p class="muted">Automated means a Playwright script exists and was executed (result: ${RESULT_LABEL.passed.toLowerCase()} ${s.byResult.passed}, ${RESULT_LABEL.healed.toLowerCase()} ${s.byResult.healed}, ${RESULT_LABEL.flaky.toLowerCase()} ${s.byResult.flaky}, ${RESULT_LABEL.failed.toLowerCase()} ${s.byResult.failed}). A failing script is still automation: it shows the application or the script needs attention, not that the case is missing.</p>
</div>
<div class="panel">
  <h2>Why cases were not automated</h2>
  ${reasonBlock}
</div>
${problems}
<div class="panel">
  <h2>By module</h2>
  <table><thead><tr><th>Module</th><th class="num">Test cases</th><th class="num">Automated</th><th class="num">Not automated</th></tr></thead><tbody>${
    r.modules.map((m) => `<tr><td>${e(m.name)}</td><td class="num">${m.total}</td><td class="num">${m.automated}</td><td class="num">${m.notAutomated}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No test cases.</td></tr>'
  }</tbody></table>
</div>
<div class="panel" id="cases">
  <h2>Test cases</h2>
  <div class="toolbar">
    <select id="f-status" aria-label="Status"><option value="">All statuses</option><option value="automated">Automated</option><option value="not_automated">Not automated</option></select>
    <select id="f-reason" aria-label="Reason"><option value="">Any reason</option>${REASON_CODES.map((c) => `<option value="${c}">${e(REASON_LABEL[c])}</option>`).join('')}</select>
    <select id="f-module" aria-label="Module"><option value="">All modules</option>${moduleNames.map((m) => `<option value="${e(m)}">${e(m)}</option>`).join('')}</select>
    <input id="f-q" type="search" placeholder="Search id, title, story, reason" aria-label="Search">
    <span id="count" class="muted"></span>
  </div>
  <table>
    <thead><tr><th>Test case</th><th>Module</th><th>Status</th><th>Result or reason</th></tr></thead>
    <tbody>${r.cases.map(caseRow).join('\n')}</tbody>
  </table>
  <div id="none" class="empty" hidden>No test case matches the filter.</div>
</div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

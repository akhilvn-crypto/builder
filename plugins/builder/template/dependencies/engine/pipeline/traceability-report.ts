// End-to-end traceability for a run that started from test design:
//
//   Story → Acceptance criterion → Test scenario → Test case → Automation script → Execution result
//
// Everything is a join of records the pipeline already keeps: the design handoff (story, criterion, scenario and case links
// recorded by the design stages), the generation manifest (case → test file and title) and the execution results (case → outcome).
// Nothing is inferred: a link that is missing is reported as a gap, not filled in.

import type { ExecutionResults, Outcome } from './execution.ts';
import type { GenerationManifest } from './generation.ts';
import type { HandoffDocument } from './design-handoff.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const TRACEABILITY_SCHEMA_VERSION = 1;

export const CASE_STATES = ['passed', 'failed', 'flaky', 'skipped', 'not_run', 'not_generated', 'blocked', 'manual'] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const CRITERION_STATES = ['passed', 'failing', 'flaky', 'incomplete', 'manual_only', 'uncovered'] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

export interface TraceCase {
  testId: string;
  title: string;
  storyIds: string[];
  covers: string[];
  scenario: { key: string | null; techniques: string[] };
  designFile: string;
  importedFile: string | null;
  readiness: string;
  readinessReasons: string[];
  script: { file: string; title: string } | null;
  result: { outcome: Outcome; label: string } | null;
  state: CaseState;
  note: string | null;
}

export interface TraceCriterion {
  label: string;
  kind: string;
  text: string | null;
  state: CriterionState;
  cases: string[];
  manualCases: string[];
}

export interface TraceStory {
  id: string;
  title: string | null;
  designFile: string;
  criteria: TraceCriterion[];
  cases: string[];
}

export interface TraceabilityReport {
  schemaVersion: typeof TRACEABILITY_SCHEMA_VERSION;
  generatedAt: string;
  runId: string;
  designRunId: string;
  summary: {
    stories: number;
    criteria: number;
    criteriaByState: Record<CriterionState, number>;
    cases: number;
    casesByState: Record<CaseState, number>;
  };
  stories: TraceStory[];
  cases: TraceCase[];
  gaps: string[];
}

export interface TraceInputs {
  runId: string;
  now?: Date;
  handoff: HandoffDocument;
  specs: TestSpecDocument | null;
  generation: GenerationManifest | null;
  execution: ExecutionResults | null;
  regression: ExecutionResults | null;
}

const SEVERITY: Record<Outcome, number> = { failed: 3, flaky: 2, skipped: 1, passed: 0 };

// The worst outcome of a case across browsers/projects.
function outcomeOf(results: ExecutionResults | null, testId: string): { outcome: Outcome; label: string } | null {
  if (!results) return null;
  const mine = results.tests.filter((t) => t.testId === testId);
  if (mine.length === 0) return null;
  const worst = mine.reduce((a, b) => (SEVERITY[b.outcome] > SEVERITY[a.outcome] ? b : a));
  return { outcome: worst.outcome, label: results.label };
}

export function buildTraceability(i: TraceInputs): TraceabilityReport {
  const specStatus = new Map((i.specs?.specs ?? []).map((s) => [s.id, s.status]));
  const scripts = new Map((i.generation?.tests ?? []).map((t) => [t.testId, t]));
  const excluded = new Map((i.generation?.excluded ?? []).map((e) => [e.testId, e.reason]));
  const gaps: string[] = [];

  const cases: TraceCase[] = Object.entries(i.handoff.cases).map(([testId, c]) => {
    const script = scripts.get(testId);
    // A healed test's latest word is its regression run; otherwise the initial execution.
    const result = outcomeOf(i.regression, testId) ?? outcomeOf(i.execution, testId);
    let state: CaseState;
    let note: string | null = null;
    if (c.verdict === 'manual') {
      state = 'manual';
      note = 'needs a person; not automated';
    } else if (specStatus.get(testId) === 'needs_clarification' || c.verdict === 'blocked') {
      state = 'blocked';
      note = 'the test case needs clarification';
    } else if (!script) {
      state = 'not_generated';
      note = excluded.get(testId) ?? 'no automation script was generated';
      gaps.push(`${testId}: no automation script (${note})`);
    } else if (!result) {
      state = 'not_run';
      note = 'the script has no execution result';
      gaps.push(`${testId}: the script ${script.file} has no execution result`);
    } else {
      state = result.outcome;
    }
    return {
      testId, title: c.title, storyIds: c.storyIds, covers: c.covers,
      scenario: { key: c.scenarioKey, techniques: c.techniques },
      designFile: c.designFile, importedFile: c.importedFile, readiness: c.verdict, readinessReasons: c.reasons.map((r) => r.message),
      script: script ? { file: script.file, title: script.title } : null,
      result, state, note,
    };
  });
  const byId = new Map(cases.map((c) => [c.testId, c]));

  const stories: TraceStory[] = Object.entries(i.handoff.stories).map(([id, s]) => {
    const criteria: TraceCriterion[] = s.criteria.map((cr) => {
      const key = `${id}#${cr.label}`;
      const covering = cases.filter((c) => c.covers.includes(key));
      const automated = covering.filter((c) => c.state !== 'manual');
      const manual = covering.filter((c) => c.state === 'manual');
      let state: CriterionState;
      if (covering.length === 0) state = 'uncovered';
      else if (automated.length === 0) state = 'manual_only';
      else if (automated.some((c) => c.state === 'failed')) state = 'failing';
      else if (automated.some((c) => c.state === 'flaky')) state = 'flaky';
      else if (automated.every((c) => c.state === 'passed')) state = 'passed';
      else state = 'incomplete';
      if (state === 'uncovered') gaps.push(`${id}#${cr.label}: no test case covers this criterion`);
      return { label: cr.label, kind: cr.kind, text: cr.text, state, cases: automated.map((c) => c.testId), manualCases: manual.map((c) => c.testId) };
    });
    // Cases of the story that name no criterion at all are still part of the story.
    return { id, title: s.title, designFile: s.designFile, criteria, cases: s.caseIds.filter((c) => byId.has(c)) };
  });

  const count = <K extends string>(keys: readonly K[], values: K[]): Record<K, number> => {
    const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
    for (const v of values) out[v] += 1;
    return out;
  };
  return {
    schemaVersion: TRACEABILITY_SCHEMA_VERSION,
    generatedAt: (i.now ?? new Date()).toISOString(),
    runId: i.runId,
    designRunId: i.handoff.designRunId,
    summary: {
      stories: stories.length,
      criteria: stories.reduce((n, s) => n + s.criteria.length, 0),
      criteriaByState: count(CRITERION_STATES, stories.flatMap((s) => s.criteria.map((c) => c.state))),
      cases: cases.length,
      casesByState: count(CASE_STATES, cases.map((c) => c.state)),
    },
    stories, cases, gaps,
  };
}

export function validateTraceabilityReport(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['traceability report must be an object'];
  const r = v as Partial<TraceabilityReport>;
  const issues: string[] = [];
  if (r.schemaVersion !== TRACEABILITY_SCHEMA_VERSION) issues.push('unsupported traceability schemaVersion');
  if (!Array.isArray(r.stories) || !Array.isArray(r.cases) || !Array.isArray(r.gaps)) issues.push('stories, cases and gaps must be arrays');
  return issues;
}

const cell = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderTraceabilityMarkdown(r: TraceabilityReport): string {
  const L: string[] = [];
  L.push(`# Traceability — run ${r.runId}`, '', `Story → Acceptance criterion → Test scenario → Test case → Automation script → Execution result`, '');
  L.push(`Test design run: \`${r.designRunId}\` · generated ${r.generatedAt}`, '');
  L.push(`Stories ${r.summary.stories} · criteria ${r.summary.criteria} · test cases ${r.summary.cases}`, '');
  L.push('| Case result | Count |', '|---|---|', ...CASE_STATES.filter((s) => r.summary.casesByState[s] > 0).map((s) => `| ${s} | ${r.summary.casesByState[s]} |`), '');
  for (const s of r.stories) {
    L.push(`## ${s.id}${s.title ? ` — ${cell(s.title)}` : ''}`, '', `Design file: \`${s.designFile}\``, '');
    L.push('| Criterion | Statement | State | Test cases | Manual |', '|---|---|---|---|---|');
    for (const c of s.criteria) L.push(`| ${c.label} | ${cell(c.text) || '—'} | ${c.state} | ${c.cases.join(', ') || '—'} | ${c.manualCases.join(', ') || '—'} |`);
    L.push('');
  }
  L.push('## Test cases', '', '| Case | Stories | Covers | Scenario | Script | Result | State |', '|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    const scenario = [c.scenario.techniques.join('+'), c.scenario.key].filter(Boolean).join(' · ') || '—';
    L.push(`| ${c.testId} — ${cell(c.title)} | ${c.storyIds.join(', ') || '—'} | ${c.covers.map((x) => x.split('#')[1]).join(', ') || '—'} | ${cell(scenario)} | ${c.script ? `\`${c.script.file}\`` : '—'} | ${c.result ? c.result.outcome : '—'} | ${c.state}${c.note ? ` (${cell(c.note)})` : ''} |`);
  }
  L.push('');
  if (r.gaps.length > 0) L.push('## Gaps', '', ...r.gaps.map((g) => `- ${g}`), '');
  const manual = r.cases.filter((c) => c.state === 'manual');
  if (manual.length > 0) {
    L.push('## Left for manual execution', '', ...manual.flatMap((c) => [`- **${c.testId}** — ${cell(c.title)}`, ...c.readinessReasons.map((m) => `  - ${m}`)]), '');
  }
  return L.join('\n');
}

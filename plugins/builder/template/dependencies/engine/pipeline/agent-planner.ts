// Decides, in code, which stages need an agent and hands each agent only the bounded, structured input it needs.
//
// Model reasoning is kept for judgment (ambiguous requirements, unfamiliar UI, generation and semantic review, unclear
// failures, repairs). Everything predictable runs through the CLI: parsing, validation, hashing, running tests,
// classifying clear-cut failures, assembling reports. A decision always says why, so a skipped agent is auditable.
//
// Usage is recorded in <run>/agents.json: decisions per stage and the invocations the orchestrator reports.
// Token counts are stored only when the orchestrator passes them; they are never estimated.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { withFileLock } from '../utils/lock.ts';
import { ARTIFACTS } from './artifact-manager.ts';
import type { ExplorationRecord } from './exploration.ts';
import type { ExplorationPlan } from './exploration-reuse.ts';
import type { FailureAnalysis, FailureEntry } from './failure-classifier.ts';
import type { GenerationPlan } from './generation-reuse.ts';
import { GENERATED_HEADER } from './generation.ts';
import type { GenerationManifest } from './generation.ts';
import type { ReviewPlan } from './review-reuse.ts';
import type { ReviewReport } from './static-review.ts';
import { testBlocks } from './static-review.ts';
import type { StageName } from './state-manager.ts';
import type { TestSpec, TestSpecDocument } from './test-spec.ts';

export const AGENT_USAGE_SCHEMA_VERSION = 1;
export const BRIEF_SCHEMA_VERSION = 1;
// A brief is a summary, not a transcript: lists are cut to this many items and the cut is reported.
export const MAX_BRIEF_ITEMS = 25;
export const MAX_BRIEF_BYTES = 40_000;

export const AGENT_BY_STAGE: Partial<Record<StageName, string>> = {
  test_analysis: 'test-analyst',
  application_exploration: 'application-explorer',
  test_generation: 'playwright-generator',
  script_review: 'test-reviewer',
  failure_triage: 'failure-healer',
  healing: 'failure-healer',
};

// Stages whose work never needs a model. Listed so the plan can say so explicitly.
export const DETERMINISTIC_STAGES: readonly StageName[] = [
  'preflight', 'configuration', 'input_validation', 'execution', 'regression_validation', 'report_generation', 'finalization',
];

export interface Brief {
  name: string; // file name stem under briefs/
  content: Record<string, unknown>;
}

export interface AgentDecision {
  stage: StageName;
  agent: string | null; // null = run deterministically
  invocations: number; // how many agent calls the plan asks for (parallel batches count separately)
  reason: string;
  commands: string[]; // deterministic CLI steps to run (before / instead of the agent)
  briefs: string[]; // run-relative paths of the structured inputs
}

export interface PlannerInput {
  stage: StageName;
  rootDir: string;
  specs: TestSpecDocument | null;
  explorationPlan: ExplorationPlan | null;
  exploration: ExplorationRecord | null;
  generationPlan: GenerationPlan | null;
  generation: GenerationManifest | null;
  reviewPlan: ReviewPlan | null;
  reviewReport: ReviewReport | null;
  analysis: FailureAnalysis | null;
  attemptsByTest: Record<string, number>;
  maxAttempts: number | null;
  // How spreadsheet/CSV tables were read (input-validation.json). A table that was skipped, unresolved or left columns out
  // may hide test content, which only a judgment call can settle; so may one with two equally good columns for a field
  // (`ambiguous`) or columns read from their content (`inferred`). Both are optional so an older report stays readable.
  // null when the report is not available.
  inputTables: {
    path: string; sheet: string | null; status: string; reason: string | null; ignoredColumns: string[];
    ambiguous?: unknown[]; inferred?: unknown[];
  }[] | null;
}

function cut<T>(items: T[], max = MAX_BRIEF_ITEMS): { items: T[]; omitted: number } {
  return { items: items.slice(0, max), omitted: Math.max(0, items.length - max) };
}

function specBrief(s: TestSpec) {
  return {
    id: s.id, title: s.title, module: s.module, preconditions: s.preconditions,
    // Present only for a case that needs other cases to have run first: they are explored first, and generated before it in one serial group.
    ...(s.dependsOn?.length ? { dependsOn: s.dependsOn } : {}),
    steps: s.steps.map((st) => ({ index: st.index, action: st.action, expected: st.expected })),
    expectedResults: s.expectedResults,
    testData: s.testData.map((d) => ({ name: d.name, envVar: d.envVar, literal: d.declaredLiteral ? d.value : null })), // never secret values
  };
}

function evidenceFor(record: ExplorationRecord | null, testId: string) {
  const entry = record?.specs.find((s) => s.testId === testId);
  if (!record || !entry) return null;
  const used = new Set(entry.steps.map((s) => s.pageId).filter((x): x is string => x !== null));
  return {
    status: entry.status,
    steps: entry.steps,
    uncertainties: entry.uncertainties,
    pages: record.pages.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, url: p.url, title: p.title, snapshot: p.snapshot, elements: p.elements.map((e) => ({ role: e.role, name: e.name, candidateLocator: e.candidateLocator, confidence: e.confidence })) })),
  };
}

// A failure the heuristics classified with high confidence as something no agent can change needs no confirmation.
export function needsConfirmation(f: FailureEntry): boolean {
  if (f.classifiedBy === 'agent') return false;
  if (f.confidence === 'high' && f.category !== 'script_defect') return false;
  return true; // medium/low confidence, inconclusive, or a script defect that may be repaired: look at the evidence first
}

function failureBrief(f: FailureEntry) {
  return {
    key: f.key, testId: f.testId, file: f.file, line: f.line, project: f.project, outcome: f.outcome,
    category: f.category, confidence: f.confidence, signals: f.signals, healingEligible: f.healingEligible,
    errorExcerpt: f.errorExcerpt.split('\n').slice(0, 8).join('\n'),
    evidence: f.evidence.slice(0, 6),
  };
}

export function planAgentStage(i: PlannerInput): { decision: AgentDecision; briefs: Brief[] } {
  const none = (reason: string, commands: string[] = []) => ({
    decision: { stage: i.stage, agent: null, invocations: 0, reason, commands, briefs: [] } satisfies AgentDecision,
    briefs: [] as Brief[],
  });
  const agent = AGENT_BY_STAGE[i.stage] ?? null;
  const withAgent = (invocations: number, reason: string, briefs: Brief[], commands: string[] = []) => ({
    decision: { stage: i.stage, agent, invocations, reason, commands, briefs: briefs.map((b) => `${ARTIFACTS.briefsDir}/${b.name}.json`) } satisfies AgentDecision,
    briefs,
  });

  if (DETERMINISTIC_STAGES.includes(i.stage)) {
    return none(i.stage === 'execution' || i.stage === 'regression_validation'
      ? 'running tests is a CLI call; a runner error is reported, not repaired by an agent'
      : 'fully deterministic: no judgment is involved', []);
  }

  switch (i.stage) {
    case 'test_analysis': {
      if (!i.specs) return none('test-specs.json is missing: run "specs parse" first', ['specs parse']);
      const unclear = i.specs.specs.filter((s) => s.status === 'needs_clarification' || s.ambiguities.length > 0);
      const tableNotes = (i.inputTables ?? []).filter((t) => t.status !== 'ok' || t.ignoredColumns.length > 0 || (t.ambiguous?.length ?? 0) > 0 || (t.inferred?.length ?? 0) > 0);
      if (unclear.length === 0 && tableNotes.length === 0) return none(`all ${i.specs.specs.length} test cases parsed without ambiguity and every input table was read cleanly`);
      const c = cut(unclear);
      return withAgent(1, `${unclear.length} of ${i.specs.specs.length} test cases are ambiguous${tableNotes.length > 0 ? `, and ${tableNotes.length} input table(s) were skipped, left columns out, had two equally good columns for a field, or had columns read from their content` : ''}`, [{
        name: 'test-analysis',
        content: {
          stage: i.stage, ambiguous: c.items.map((s) => ({ ...specBrief(s), source: s.source, status: s.status, ambiguities: s.ambiguities })), omitted: c.omitted,
          tables: cut(tableNotes).items,
        },
      }]);
    }

    case 'application_exploration': {
      const plan = i.explorationPlan;
      if (!plan) return none('no exploration plan yet', ['explore plan']);
      const todo = plan.specs.filter((s) => s.action !== 'reuse' && s.action !== 'covered');
      if (todo.length === 0 && plan.pagesToRevalidate.length === 0) {
        return none((plan.summary.covered ?? 0) > 0
          ? `every test case has saved evidence: ${plan.summary.reuse} revalidated in this run, ${plan.summary.covered} covered by a still-valid generated test (its execution is the check)`
          : 'every test case has saved evidence that was already revalidated in this run', ['explore assemble']);
      }
      const c = cut(todo);
      return withAgent(1, `${todo.length} test case(s) need fresh exploration or revalidation; ${plan.summary.reuse + (plan.summary.covered ?? 0)} reuse saved evidence`, [{
        name: 'exploration',
        content: {
          stage: i.stage, baseUrl: plan.baseUrl, specs: c.items, omitted: c.omitted, pagesToRevalidate: plan.pagesToRevalidate,
          // Saved pages the `explore` test cases probably visit (listed per spec in `knownPages`): confirm with one snapshot, then name as saved:<key>.
          knownPages: (plan.knownPages ?? []).filter((k) => c.items.some((s) => s.knownPages?.includes(k.key))),
          testCases: c.items.map((p) => i.specs?.specs.find((s) => s.id === p.testId)).filter((s): s is TestSpec => !!s).map(specBrief),
        },
      }]);
    }

    case 'test_generation': {
      const plan = i.generationPlan;
      if (!plan) return none('no generation plan yet', ['generate plan']);
      if (plan.batches.length === 0) return none(`all ${plan.summary.reuse} generated tests are unchanged and still valid`, ['generate assemble']);
      const briefs = plan.batches.map((b): Brief => {
        // Tests rebuilt only because the engine changed: their earlier version is still in the file and is the starting point.
        const redesign = Object.fromEntries(plan.specs.filter((e) => b.testIds.includes(e.testId) && e.previous).map((e) => [e.testId, { previousFile: e.previous, why: e.reason }]));
        return {
          name: `generation-${b.batchId}`,
          content: {
            stage: i.stage, batchId: b.batchId, language: plan.language, targetFile: b.targetFile, writeManifestTo: b.manifest,
            rules: [
              `write only ${b.targetFile}; never edit another test file`,
              `the file starts with this header line, exactly: ${GENERATED_HEADER}`,
              'report any shared file you had to change in sharedFilesChanged (another batch may not change the same one)',
              'keep the other tests already in the target file exactly as they are',
              ...(Object.keys(redesign).length > 0 ? ['a test listed under redesign already exists in the target file and its test case and evidence are unchanged: edit that test in place, changing only what its `why` requires (keep its flow and the locators the evidence still supports), instead of writing it from scratch'] : []),
            ],
            testCases: b.testIds.map((id) => i.specs?.specs.find((s) => s.id === id)).filter((s): s is TestSpec => !!s).map(specBrief),
            evidence: Object.fromEntries(b.testIds.map((id) => [id, evidenceFor(i.exploration, id)])),
            ...(Object.keys(redesign).length > 0 ? { redesign } : {}),
          },
        };
      });
      return withAgent(plan.batches.length, `${plan.summary.generate} test(s) must be generated (${plan.summary.reuse} reused), in ${plan.batches.length} independent batch(es)`, briefs, ['generate assemble']);
    }

    case 'script_review': {
      const plan = i.reviewPlan;
      if (!plan) return none('no review plan yet: run "review static" and "review plan"', ['review static', 'review plan']);
      const todo = plan.tests.filter((t) => t.action === 'review');
      if (todo.length === 0) return none(`all ${plan.tests.length} tests have a valid earlier review and are unchanged`, ['review seal']);
      const c = cut(todo);
      return withAgent(1, `${todo.length} test(s) have no valid earlier review; ${plan.summary.skip} are skipped`, [{
        name: 'review',
        content: {
          stage: i.stage, files: plan.filesToReview, tests: c.items, omitted: c.omitted,
          testCases: c.items.map((t) => i.specs?.specs.find((s) => s.id === t.testId)).filter((s): s is TestSpec => !!s).map(specBrief),
          staticFindings: cut((i.reviewReport?.findings ?? []).filter((f) => f.status === 'open' && plan.filesToReview.includes(f.file))).items,
        },
      }], ['review seal']);
    }

    case 'failure_triage': {
      if (!i.analysis) return none('no failure analysis yet', ['triage run']);
      if (i.analysis.failures.length === 0) return none('no failed or flaky tests');
      const open = i.analysis.failures.filter(needsConfirmation);
      if (open.length === 0) return none(`all ${i.analysis.failures.length} failure(s) were classified with high confidence from clear evidence`);
      const c = cut(open);
      return withAgent(1, `${open.length} of ${i.analysis.failures.length} failure(s) need their classification confirmed against the evidence`, [{
        name: 'triage',
        content: {
          stage: i.stage, failures: c.items.map(failureBrief), omitted: c.omitted,
          testCases: [...new Set(c.items.map((f) => f.testId))].map((id) => i.specs?.specs.find((s) => s.id === id)).filter((s): s is TestSpec => !!s).map(specBrief),
        },
      }]);
    }

    case 'healing': {
      if (!i.analysis) return none('no failure analysis yet', ['triage run']);
      const eligible = i.analysis.failures.filter((f) => f.healingEligible);
      if (eligible.length === 0) return none('no failure is an eligible script defect', ['heal finish']);
      const briefs = eligible.map((f): Brief => {
        const file = path.join(i.rootDir, f.file);
        const block = existsSync(file) ? testBlocks(readFileSync(file, 'utf8')).find((b) => b.testId === f.testId) : undefined;
        const used = i.attemptsByTest[f.testId] ?? 0;
        return {
          name: `healing-${f.testId.replace(/[^\w.-]/g, '_')}`,
          content: {
            stage: i.stage, failure: failureBrief(f), attemptsUsed: used, attemptsRemaining: i.maxAttempts === null ? null : Math.max(0, i.maxAttempts - used),
            test: block ? { file: f.file, startLine: block.startLine, endLine: block.endLine, source: block.text.slice(0, 6000) } : { file: f.file, source: null },
            testCase: ((s) => (s ? specBrief(s) : null))(i.specs?.specs.find((x) => x.id === f.testId)),
            evidence: evidenceFor(i.exploration, f.testId),
            rules: ['change locators or waits only; never remove or weaken an assertion', 'minimal diff', 'run heal begin before editing and heal check/record after'],
          },
        };
      });
      return withAgent(eligible.length, `${eligible.length} eligible script defect(s); tests in the same file must be healed one after another`, briefs);
    }

    default:
      return none(`stage ${i.stage} has no agent`);
  }
}

// ---- brief size guard ----

export function briefBytes(b: Brief): number {
  return Buffer.byteLength(JSON.stringify(b.content));
}

// Last line of defence: a brief over the limit has its biggest list entries dropped rather than being forwarded whole.
export function boundBrief(b: Brief): { brief: Brief; truncated: boolean } {
  let content = b.content;
  let truncated = false;
  for (let guard = 0; guard < 20 && Buffer.byteLength(JSON.stringify(content)) > MAX_BRIEF_BYTES; guard++) {
    const key = Object.entries(content).filter(([, v]) => Array.isArray(v) && v.length > 1).sort((a, c) => JSON.stringify(c[1]).length - JSON.stringify(a[1]).length)[0]?.[0];
    if (!key) break;
    const arr = content[key] as unknown[];
    content = { ...content, [key]: arr.slice(0, Math.ceil(arr.length / 2)), truncated: true };
    truncated = true;
  }
  return { brief: { ...b, content: { schemaVersion: BRIEF_SCHEMA_VERSION, ...content } }, truncated };
}

// ---- usage file ----

export interface Invocation {
  stage: StageName;
  agent: string;
  at: string;
  inputTokens: number | null;
  outputTokens: number | null;
  brief: string | null;
}

export interface AgentUsage {
  schemaVersion: typeof AGENT_USAGE_SCHEMA_VERSION;
  decisions: Partial<Record<StageName, AgentDecision & { decidedAt: string }>>;
  invocations: Invocation[];
}

export function readAgentUsage(runDirectory: string): AgentUsage {
  const r = readJson(path.join(runDirectory, ARTIFACTS.agentUsage));
  const v = r.ok ? (r.value as Partial<AgentUsage>) : null;
  return v && v.schemaVersion === AGENT_USAGE_SCHEMA_VERSION && v.decisions && Array.isArray(v.invocations)
    ? (v as AgentUsage) : { schemaVersion: AGENT_USAGE_SCHEMA_VERSION, decisions: {}, invocations: [] };
}

function updateUsage(runDirectory: string, change: (u: AgentUsage) => AgentUsage): AgentUsage {
  const file = path.join(runDirectory, ARTIFACTS.agentUsage);
  return withFileLock(`${file}.lock`, () => {
    const next = change(readAgentUsage(runDirectory));
    writeJsonAtomic(file, next);
    return next;
  });
}

export function recordDecision(runDirectory: string, d: AgentDecision, now: Date = new Date()): void {
  updateUsage(runDirectory, (u) => ({ ...u, decisions: { ...u.decisions, [d.stage]: { ...d, decidedAt: now.toISOString() } } }));
}

export function recordInvocation(runDirectory: string, inv: Omit<Invocation, 'at'>, now: Date = new Date()): Invocation {
  const entry: Invocation = { ...inv, at: now.toISOString() };
  updateUsage(runDirectory, (u) => ({ ...u, invocations: [...u.invocations, entry] }));
  return entry;
}

export interface AgentMetrics {
  invocations: number;
  byStage: Record<string, number>;
  byAgent: Record<string, number>;
  stagesRunDeterministically: string[]; // stages where a plan avoided the agent
  inputTokens: number | null; // null unless every invocation reported its tokens
  outputTokens: number | null;
}

export function summarizeUsage(u: AgentUsage): AgentMetrics {
  const byStage: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const inv of u.invocations) {
    byStage[inv.stage] = (byStage[inv.stage] ?? 0) + 1;
    byAgent[inv.agent] = (byAgent[inv.agent] ?? 0) + 1;
  }
  const sum = (pick: (x: Invocation) => number | null): number | null =>
    u.invocations.length > 0 && u.invocations.every((x) => pick(x) !== null) ? u.invocations.reduce((a, x) => a + pick(x)!, 0) : null;
  return {
    invocations: u.invocations.length, byStage, byAgent,
    stagesRunDeterministically: Object.values(u.decisions).filter((d) => d!.agent === null).map((d) => d!.stage),
    inputTokens: sum((x) => x.inputTokens), outputTokens: sum((x) => x.outputTokens),
  };
}

// Test ledger (dependencies/state/ledger/<origin>.json): one entry per automated test case, tying together what the pipeline knows
// about it - the test case, where its exploration evidence lives, the generated test file, its review, and how it last ran.
//
// It is an INDEX, not a fourth cache. The authorities stay where they are (the observation store, the artifact cache, the run
// directories). Nothing is ever reused because the ledger says so; the ledger only
//   1. remembers the pointers and the engine/rule versions each test was built with (`ledger update`), and
//   2. answers up front, before any agent is chosen, "what would this run have to redo for each test, and why?" (`ledger plan`),
//      by asking the same deciders the stages use (exploration-reuse.ts, generation-reuse.ts, review-reuse.ts). So the preview and
//      the stages cannot disagree, and a stale or hand-edited ledger can only make the preview wrong, never skip work.
// Execution history is kept for context (last outcome, last known pass). It is never used to skip running a test.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readScaffold } from '../config/scaffold.ts';
import type { AutomationConfig } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { withFileLock } from '../utils/lock.ts';
import { readEntry } from './artifact-cache.ts';
import { GENERATION_SCHEMA_VERSION, type GenerationManifest } from './generation.ts';
import type { ExplorationRecord } from './exploration.ts';
import { planExploration, savedRecord } from './exploration-reuse.ts';
import { originOf, specFingerprint, storePath, type ObservationStore, type StoreState } from './exploration-store.ts';
import {
  asPayload, buildBatches, decideGeneration, explorationEvidenceHash, generationStillCurrent, ruleVersions, type PlanEntry,
} from './generation-reuse.ts';
import { planReview, reviewVersions } from './review-reuse.ts';
import type { FinalOutcome, RunSummary } from './reporting.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_DIRNAME = 'ledger'; // inside dependencies/state/ (git-ignored, local to the machine)
const MAX_HISTORY = 5;

export interface LedgerExploration {
  status: string; // explored | blocked | ... as the store recorded it
  runId: string; // run that observed it
  observedAt: string;
  pages: string[]; // page keys the evidence is tied to; the page index below is derived from these
  store: string; // observation store file, relative to the project root (the old run directory may be pruned; the store is not)
  evidenceHash: string | null; // what a generated test relied on (explorationEvidenceHash)
}

export interface LedgerGenerated {
  file: string; // relative to automation/
  title: string;
  testSha256: string;
  runId: string; // run that sealed it
  pluginVersion: string; // plugin that was installed when it was sealed
  generatorRules: string;
  framework: string;
}

export interface LedgerReview {
  runId: string;
  reviewedBy: string;
  reviewerRules: string;
  staticReview: string;
}

export interface LedgerExecution {
  runId: string;
  executedAt: string;
  outcome: FinalOutcome; // the worst outcome across browsers/projects
  category: string | null;
  projects: number;
}

export interface LedgerTest {
  testId: string;
  title: string;
  module: string;
  inputFile: string | null; // test-case file it came from, relative to dependencies/
  specFingerprint: string;
  exploration: LedgerExploration | null;
  generated: LedgerGenerated | null;
  review: LedgerReview | null;
  lastExecution: LedgerExecution | null;
  lastPassed: { runId: string; executedAt: string } | null;
  history: { runId: string; executedAt: string; outcome: FinalOutcome }[]; // newest last, capped
  updatedAt: string;
  updatedByRun: string;
}

export interface TestLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  origin: string;
  updatedAt: string;
  engine: { pluginVersion: string; generatorRules: string; reviewerRules: string };
  tests: Record<string, LedgerTest>;
}

export type LedgerState =
  | { status: 'ok'; ledger: TestLedger }
  | { status: 'missing'; reason: string }
  | { status: 'corrupt'; reason: string };

// ---- storage ----

export function ledgerPath(rootDir: string, baseUrl: string): string {
  // Same file name as the observation store of the origin, so the two are obviously a pair.
  return path.join(stateDir(rootDir), LEDGER_DIRNAME, path.basename(storePath(rootDir, baseUrl)));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateLedger(v: unknown, origin: string): string[] {
  if (!isObj(v)) return ['ledger must be a JSON object'];
  const issues: string[] = [];
  if (v.schemaVersion !== LEDGER_SCHEMA_VERSION) issues.push(`unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}`);
  if (v.origin !== origin) issues.push(`ledger is for ${JSON.stringify(v.origin)}, not ${origin}`);
  if (!isObj(v.engine)) issues.push('engine must be an object');
  if (!isObj(v.tests)) issues.push('tests must be an object');
  else {
    for (const [id, t] of Object.entries(v.tests)) {
      if (!isObj(t) || t.testId !== id || typeof t.specFingerprint !== 'string' || !Array.isArray(t.history)) issues.push(`test "${id}" is malformed`);
    }
  }
  return issues;
}

export function loadLedger(rootDir: string, baseUrl: string): LedgerState {
  const origin = originOf(baseUrl);
  if (!origin) return { status: 'corrupt', reason: `invalid base URL "${baseUrl}"` };
  const r = readJson(ledgerPath(rootDir, baseUrl));
  if (!r.ok) {
    return r.reason === 'not_found'
      ? { status: 'missing', reason: 'no ledger for this environment yet' }
      : { status: 'corrupt', reason: r.message };
  }
  const issues = validateLedger(r.value, origin);
  return issues.length > 0 ? { status: 'corrupt', reason: issues.join('; ') } : { status: 'ok', ledger: r.value as TestLedger };
}

export function updateLedger<T>(
  rootDir: string, baseUrl: string, change: (state: LedgerState) => { ledger: TestLedger | null; result: T },
): T {
  const file = ledgerPath(rootDir, baseUrl);
  return withFileLock(`${file}.lock`, () => {
    const out = change(loadLedger(rootDir, baseUrl));
    if (out.ledger) {
      mkdirSync(path.dirname(file), { recursive: true }); // lazily, so a project never gets an empty ledger dir
      writeJsonAtomic(file, out.ledger);
    }
    return out.result;
  });
}

// ---- recording what a run left behind ----

// Worst first: a test that failed in one browser is a failing test.
const SEVERITY: FinalOutcome[] = ['failed', 'blocked', 'flaky', 'skipped', 'healed', 'passed'];

export function worstOutcome(outcomes: FinalOutcome[]): FinalOutcome | null {
  return SEVERITY.find((o) => outcomes.includes(o)) ?? null;
}

export interface RecordInput {
  rootDir: string; // automation/
  runId: string;
  baseUrl: string;
  specs: TestSpecDocument;
  generation: GenerationManifest | null;
  exploration: ExplorationRecord | null; // this run's record (evidence hash); null when the run did not get that far
  store: StoreState;
  summary: RunSummary | null; // only a run that executed tests has one
  previous: TestLedger | null;
  now: string;
}

export interface RecordResult {
  ledger: TestLedger;
  recorded: string[]; // test IDs whose entry was written or refreshed
}

export function recordRun(i: RecordInput): RecordResult {
  const origin = originOf(i.baseUrl);
  if (!origin) throw new Error(`invalid base URL "${i.baseUrl}"`);
  const scaffold = readScaffold(i.rootDir);
  const pluginVersion = scaffold?.pluginVersion ?? 'unknown';
  const gen = ruleVersions(i.rootDir);
  const rev = { reviewerRules: 'unknown', staticReview: 'unknown', ...reviewVersions(i.rootDir) };
  const projectRoot = path.dirname(path.dirname(stateDir(i.rootDir)));
  const storeFile = toPosixRelative(projectRoot, storePath(i.rootDir, i.baseUrl));
  const store: ObservationStore | null = i.store.status === 'ok' ? i.store.store : null;

  const outcomesBy = new Map<string, { outcomes: FinalOutcome[]; category: string | null }>();
  for (const t of i.summary?.tests ?? []) {
    const e = outcomesBy.get(t.testId) ?? { outcomes: [], category: null };
    e.outcomes.push(t.outcome);
    if (t.category && (e.category === null || t.outcome === 'failed')) e.category = t.category;
    outcomesBy.set(t.testId, e);
  }

  const tests: Record<string, LedgerTest> = { ...(i.previous?.tests ?? {}) };
  const recorded: string[] = [];
  for (const spec of i.specs.specs) {
    if (spec.status !== 'ready') continue;
    const before = tests[spec.id] ?? null;
    const fingerprint = specFingerprint(spec);
    // Everything below belongs to a specific version of the test case: a changed case starts a new entry (its history is kept).
    const same = before !== null && before.specFingerprint === fingerprint;

    const saved = store?.specs[spec.id];
    const exploration: LedgerExploration | null = saved && saved.fingerprint === fingerprint
      ? {
        status: saved.exploration.status, runId: saved.runId, observedAt: saved.observedAt,
        pages: [...new Set(saved.exploration.steps.map((s) => s.pageId).filter((p): p is string => p !== null))],
        store: storeFile,
        evidenceHash: i.exploration ? explorationEvidenceHash(i.exploration, spec.id) : same ? before.exploration?.evidenceHash ?? null : null,
      }
      : null;

    // Sealed (validated) generation and review only: an unreviewed test is not knowledge worth pointing at.
    const g = readEntry(i.rootDir, 'generation', spec.id);
    const payload = g.status === 'ok' ? asPayload(g.entry.payload) : null;
    const generated: LedgerGenerated | null = g.status === 'ok' && payload && g.entry.inputs.spec === fingerprint
      ? {
        file: payload.file, title: payload.title, testSha256: payload.testSha256, runId: g.entry.runId,
        // A test carried over from an earlier run keeps the plugin version that built it, not the one that merely reused it.
        pluginVersion: before?.generated?.runId === g.entry.runId ? before.generated.pluginVersion : pluginVersion,
        generatorRules: g.entry.versions.generatorRules ?? gen.generatorRules, framework: g.entry.versions.framework ?? gen.framework,
      }
      : null;
    const r = readEntry(i.rootDir, 'review', spec.id);
    const review: LedgerReview | null = r.status === 'ok' && r.entry.inputs.spec === fingerprint
      ? {
        runId: r.entry.runId, reviewedBy: String((r.entry.payload as { reviewedBy?: unknown } | null)?.reviewedBy ?? 'unknown'),
        reviewerRules: r.entry.versions.reviewerRules ?? rev.reviewerRules, staticReview: r.entry.versions.staticReview ?? rev.staticReview,
      }
      : null;

    let lastExecution = same ? before.lastExecution : null;
    let lastPassed = same ? before.lastPassed : null;
    let history = before?.history ?? [];
    const ran = outcomesBy.get(spec.id);
    const outcome = ran ? worstOutcome(ran.outcomes) : null;
    if (i.summary && ran && outcome) {
      lastExecution = { runId: i.runId, executedAt: i.summary.generatedAt, outcome, category: ran.category, projects: ran.outcomes.length };
      if (outcome === 'passed') lastPassed = { runId: i.runId, executedAt: i.summary.generatedAt };
      history = [...history.filter((h) => h.runId !== i.runId), { runId: i.runId, executedAt: i.summary.generatedAt, outcome }].slice(-MAX_HISTORY);
    }

    const next: LedgerTest = {
      testId: spec.id, title: spec.title, module: spec.module, inputFile: spec.source.path, specFingerprint: fingerprint,
      exploration, generated, review, lastExecution, lastPassed, history, updatedAt: i.now, updatedByRun: i.runId,
    };
    // An unchanged entry is not rewritten, so `updatedAt` means "last time something about this test changed".
    const { updatedAt: _a, updatedByRun: _b, ...a } = next;
    const { updatedAt: _c, updatedByRun: _d, ...b } = before ?? ({} as LedgerTest);
    if (JSON.stringify(a) !== JSON.stringify(b)) { tests[spec.id] = next; recorded.push(spec.id); }
  }
  return {
    ledger: { schemaVersion: LEDGER_SCHEMA_VERSION, origin, updatedAt: i.now, engine: { pluginVersion, generatorRules: gen.generatorRules, reviewerRules: rev.reviewerRules }, tests },
    recorded,
  };
}

// ---- the up-front plan ----

export const VERDICTS = ['unchanged', 're-review', 'redesign', 'explore', 'new'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface LayerPlan {
  action: string; // exploration: explore|revalidate|covered; generation: reuse|generate; review: reuse|review
  reason: string;
}

export interface LedgerPlanTest {
  testId: string;
  title: string;
  module: string;
  verdict: Verdict;
  why: string;
  exploration: LayerPlan;
  generation: LayerPlan & { changed: string[]; file: string | null };
  review: LayerPlan;
  builtWith: { pluginVersion: string; runId: string } | null; // from the ledger; informational
  lastExecution: LedgerExecution | null;
  lastPassed: { runId: string; executedAt: string } | null;
}

export interface LedgerPlan {
  schemaVersion: 1;
  generatedAt: string;
  baseUrl: string;
  ledger: { status: LedgerState['status']; reason: string | null; tests: number };
  enginePluginVersion: string;
  summary: Record<Verdict, number>;
  // What the stages will have to spend because of this. revalidateOnlyTests need one snapshot each page, which `explore snapshot` takes without an agent
  // when it can prove the page; only the pages it cannot prove (and freshTests) reach the explorer.
  work: { explorer: { freshTests: number; revalidateOnlyTests: number }; generatorBatches: number; reviewerTests: number };
  causes: Record<string, number>; // reason -> tests
  tests: LedgerPlanTest[];
}

export interface PreviewInput {
  rootDir: string;
  specs: TestSpecDocument;
  config: AutomationConfig;
  baseUrl: string;
  store: StoreState;
  ledger: LedgerState;
  now: string;
}

export function previewReuse(i: PreviewInput): LedgerPlan {
  const versions = ruleVersions(i.rootDir);
  const ready = i.specs.specs.filter((s) => s.status === 'ready');
  const ledgerTests = i.ledger.status === 'ok' ? i.ledger.ledger.tests : {};
  const pluginNow = readScaffold(i.rootDir)?.pluginVersion ?? 'unknown';
  // Nothing has been revalidated yet, so a test is never `reuse` here: it is explore, revalidate (one snapshot) or covered (none).
  const explorationPlan = planExploration({
    specs: i.specs, baseUrl: i.baseUrl, state: i.store, revalidation: null, forceFresh: false, now: i.now,
    coverage: (spec, record) => generationStillCurrent({ rootDir: i.rootDir, config: i.config }, spec, record, versions),
  });
  const exploreBy = new Map(explorationPlan.specs.map((p) => [p.testId, p]));
  const store = i.store.status === 'ok' ? i.store.store : null;

  const batchEntries: PlanEntry[] = [];
  const tests = ready.map((spec): LedgerPlanTest => {
    const ex = exploreBy.get(spec.id)!;
    const known = ledgerTests[spec.id];
    const builtWith = known?.generated ? { pluginVersion: known.generated.pluginVersion, runId: known.generated.runId } : null;
    const base = { testId: spec.id, title: spec.title, module: spec.module, builtWith, lastExecution: known?.lastExecution ?? null, lastPassed: known?.lastPassed ?? null };

    if (ex.action === 'explore' || !store) {
      const unseen = !known && !store?.specs[spec.id];
      batchEntries.push({ testId: spec.id, module: ex.module, action: 'generate', reason: 'after exploration', changed: [], file: null });
      return {
        ...base, verdict: unseen ? 'new' : 'explore',
        why: unseen ? 'not seen before: explore, generate, review' : `evidence must be re-observed: ${ex.reason}`,
        exploration: { action: 'explore', reason: ex.reason },
        generation: { action: 'generate', reason: 'after exploration', changed: [], file: null },
        review: { action: 'review', reason: 'after generation' },
      };
    }

    // The evidence is known: ask the generation and review deciders what they would do with it as it stands.
    const record = savedRecord(store, spec.id, i.baseUrl, i.now);
    const gen = decideGeneration({ rootDir: i.rootDir, config: i.config }, spec, record, versions);
    const payload = gen.entry ? asPayload(gen.entry.payload) : null;
    const generation = { action: gen.action === 'reuse' ? 'reuse' : 'generate', reason: gen.reason, changed: gen.changed, file: payload?.file ?? null };
    batchEntries.push({ testId: spec.id, module: ex.module, action: generation.action as PlanEntry['action'], reason: gen.reason, changed: gen.changed, file: generation.file });
    const exploration = { action: ex.action, reason: ex.reason };

    if (gen.action !== 'reuse' || !payload) {
      return {
        ...base, verdict: 'redesign', why: `exploration is reused; only the test is rebuilt: ${gen.reason}`,
        exploration, generation, review: { action: 'review', reason: 'after regeneration' },
      };
    }
    const manifest: GenerationManifest = {
      schemaVersion: GENERATION_SCHEMA_VERSION, generatedAt: i.now, language: i.config.language,
      tests: [{ testId: spec.id, file: payload.file, title: payload.title }], excluded: [], sharedFilesChanged: [],
    };
    const review = planReview({ rootDir: i.rootDir, specs: { ...i.specs, specs: [spec] }, record, config: i.config, generation: manifest, now: new Date(i.now) }).plan.tests[0];
    const reviewPlan = { action: review?.action ?? 'review', reason: review?.reason ?? 'no review plan' };
    return reviewPlan.action === 'skip'
      ? { ...base, verdict: 'unchanged', why: 'case, evidence, test and review are all unchanged', exploration, generation, review: { action: 'reuse', reason: reviewPlan.reason } }
      : { ...base, verdict: 're-review', why: `test is unchanged; review is redone: ${reviewPlan.reason}`, exploration, generation, review: reviewPlan };
  });

  const summary = Object.fromEntries(VERDICTS.map((v) => [v, tests.filter((t) => t.verdict === v).length])) as Record<Verdict, number>;
  const causes: Record<string, number> = {};
  for (const t of tests) {
    if (t.verdict === 'unchanged') continue;
    const key = t.verdict === 'redesign' ? t.generation.reason : t.verdict === 're-review' ? t.review.reason : t.exploration.reason;
    causes[key] = (causes[key] ?? 0) + 1;
  }
  return {
    schemaVersion: 1, generatedAt: i.now, baseUrl: i.baseUrl,
    ledger: { status: i.ledger.status, reason: i.ledger.status === 'ok' ? null : i.ledger.reason, tests: Object.keys(ledgerTests).length },
    enginePluginVersion: pluginNow,
    summary,
    work: {
      explorer: {
        freshTests: tests.filter((t) => t.exploration.action === 'explore').length,
        revalidateOnlyTests: tests.filter((t) => t.exploration.action === 'revalidate').length,
      },
      generatorBatches: buildBatches(batchEntries, i.specs, i.config.language, i.rootDir).length,
      reviewerTests: tests.filter((t) => t.review.action === 'review').length,
    },
    causes, tests,
  };
}

// ---- reading the ledger back ----

// page key -> the tests whose evidence is tied to it. Derived on demand, so it can never disagree with the entries.
export function pageIndex(ledger: TestLedger): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of Object.values(ledger.tests)) for (const p of t.exploration?.pages ?? []) (out[p] ??= []).push(t.testId);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sort()]));
}


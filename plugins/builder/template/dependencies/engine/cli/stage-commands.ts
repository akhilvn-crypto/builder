// CLI handlers for stage work: deterministic steps the orchestrator and stage agents call.
// Each handler writes its artifact inside the run dir and returns the relative path to register
// with `run stage <runId> <stage> completed --artifact <name>=<path>`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/load-config.ts';
import { syncFromSavedConfig } from '../config/playwright-config.ts';
import { isAbsoluteOrEscaping, type AutomationConfig } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { inputBaseDir } from '../utils/layout.ts';
import { toRootRelative } from '../utils/paths.ts';
import {
  CACHE_KINDS, decide, readEntry, readLedger, recordDecisions, stripEntry, summarizeLedger, writeEntry, type CacheDecision,
} from '../pipeline/artifact-cache.ts';
import {
  AGENT_BY_STAGE, boundBrief, planAgentStage, readAgentUsage, recordDecision, recordInvocation, summarizeUsage, type PlannerInput,
} from '../pipeline/agent-planner.ts';
import { clearAuthState, inspectAuthState, runWithAuthState, statePath } from '../pipeline/auth-state.ts';
import { runSupervised } from '../pipeline/supervised-run.ts';
import { buildJobs, judgeSnapshot, snapshotName, type Judgement, type SnapshotResult } from '../pipeline/snapshot-revalidation.ts';
import { resolveExecutionPlan, sessionPlan } from '../pipeline/execution-plan.ts';
import { ARTIFACTS, runDir } from '../pipeline/artifact-manager.ts';
import { checkSpecsAgainstCanonical, validateCanonicalDocument, type CanonicalDocument } from '../pipeline/canonical.ts';
import { resultsPathFor, runPlaywright, saveResults, type ExecutionResults } from '../pipeline/execution.ts';
import { cleanupAll, cleanupRun, sweepRun } from '../pipeline/process-cleanup.ts';
import { recordExternally, readCreatedData, summarizeData, updateRecords, type RecordStatus } from '../pipeline/created-data.ts';
import { readSweepHistory, sweepData, sweepDataSafely } from '../pipeline/data-cleanup.ts';
import { missingEnvMessage, missingEnvVars, readEnvValues, referencedEnvVars, secretValuesFor, syncEnvFiles } from '../pipeline/env-file.ts';
import { validateExplorationRecord, type ExplorationRecord } from '../pipeline/exploration.ts';
import {
  REVALIDATION_SCHEMA_VERSION, applyRevalidation, assembleExploration, checkElements, emptyFreshRecord, emptyRevalidation, planExploration,
  type ExplorationPlan, type Revalidation,
} from '../pipeline/exploration-reuse.ts';
import {
  invalidateFromFailures, loadStore, markStale, pageKey, updateStore, type ExecutionInvalidation,
} from '../pipeline/exploration-store.ts';
import {
  CATEGORIES, CONFIDENCES, buildFailureAnalysis, reclassify, saveFailureAnalysis, validateFailureAnalysis,
  type Category, type Confidence, type FailureAnalysis,
} from '../pipeline/failure-classifier.ts';
import { generationStillCurrent, mergeGeneration, planGeneration, type GenerationPlan } from '../pipeline/generation-reuse.ts';
import { PAGE_OBJECTS_DIR, validateGenerationManifest, type GenerationManifest } from '../pipeline/generation.ts';
import {
  checkAttempt, eligibleFailure, ensureHealingLog, healLabel, readHealingLog, recordAttempt, revertAttempt, snapshotForAttempt,
} from '../pipeline/healing.ts';
import { attachHandoffToRun, designStatus, handOver, type HandoffDocument } from '../pipeline/design-handoff.ts';
import { assessReadiness } from '../pipeline/readiness.ts';
import { buildTraceability, renderTraceabilityMarkdown } from '../pipeline/traceability-report.ts';
import { buildCoverage, writeCoverageFiles } from '../pipeline/automation-coverage.ts';
import { listInputFiles, parseInputs } from '../pipeline/test-case-parser.ts';
import { applyMapping, inspectInput } from '../pipeline/input-inspect.ts';
import { IMPORT_DIR, cleanSourcePath, importInput } from '../pipeline/input-import.ts';
import { loadMappings } from '../pipeline/input-table.ts';
import { validateInput } from '../pipeline/input-validation.ts';
import { buildBaseline, buildRunMetrics, compareRuns, writeRunMetrics } from '../pipeline/metrics.ts';
import { planModules, writeNormalizedInput } from '../pipeline/modules.ts';
import { buildSummary, computeFinalTests, reportersOk, type FinalTest, type RunSummary } from '../pipeline/reporting.ts';
import {
  HealingLimitError, loadManifest, mutateManifest, pruneRuns, recordHealingAttempt, setTestCounts, type RunManifest,
} from '../pipeline/run-manager.ts';
import { planReview, refreshAfterHeal, sealReview, typecheckKey, type ReviewPlan } from '../pipeline/review-reuse.ts';
import { parseSpecsCached } from '../pipeline/specs-cache.ts';
import { loadLedger, pageIndex, previewReuse, recordRun, updateLedger } from '../pipeline/test-ledger.ts';
import { isStageName } from '../pipeline/state-manager.ts';
import { type ChainSpec } from '../pipeline/session-layout.ts';
import {
  REVIEW_SCHEMA_VERSION, SEVERITIES, reviewFiles, type ReviewFinding, type ReviewReport, type Severity,
} from '../pipeline/static-review.ts';
import { validateTestSpecDocument, type TestSpec, type TestSpecDocument } from '../pipeline/test-spec.ts';
import { redact } from '../utils/redact.ts';

export class UsageError extends Error {}

// The saved configuration (the one the test fixtures read), so the sweep and the in-test cleanup follow the same rules.
export function savedConfig(root: string): AutomationConfig | null {
  const state = loadConfig(root);
  return state.status === 'valid' ? state.config : null;
}

export interface Values {
  path?: string;
  file?: string;
  label?: string;
  'test-id'?: string[];
  'test-file'?: string[];
  project?: string[];
  retries?: string;
  headed?: boolean;
  category?: string;
  confidence?: string;
  rationale?: string;
  evidence?: string[];
  attempt?: string;
  status?: string;
  note?: string;
  column?: string[];
  sheet?: string;
  'header-row'?: string;
  module?: string;
  'module-from'?: string;
  skip?: boolean;
  clear?: boolean;
  from?: string;
  overwrite?: boolean;
  'no-cache'?: boolean;
  force?: boolean;
  agent?: string;
  'input-tokens'?: string;
  'output-tokens'?: string;
  fresh?: boolean;
  revalidate?: boolean;
  write?: boolean;
  page?: string;
  locator?: string;
  reason?: string;
  'dry-run'?: boolean;
  entity?: string;
  identifier?: string;
  hint?: string;
  story?: string; // comma-separated story IDs
  'override-manual'?: string; // comma-separated test case IDs
  apply?: boolean;
}

export interface Result {
  value: unknown;
  code: number;
}

const ok = (value: unknown): Result => ({ value, code: 0 });
const notReady = (value: unknown): Result => ({ value, code: 2 });

function need(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`missing argument: ${name}`);
  return v;
}

interface RunCtx {
  root: string;
  runId: string;
  dir: string;
  manifest: RunManifest;
}

function run(root: string, runId: string | undefined): RunCtx {
  const id = need(runId, 'runId');
  const loaded = loadManifest(root, id);
  if (!loaded.ok) throw new Error(`manifest for ${id} is invalid: ${loaded.issues.join('; ')}`);
  return { root, runId: id, dir: runDir(root, id), manifest: loaded.manifest };
}

// setTestCounts rewrote the manifest after `run()` loaded it, so reload before deriving metrics.
function loadFresh(r: RunCtx): RunManifest {
  const loaded = loadManifest(r.root, r.runId);
  if (!loaded.ok) throw new Error(`manifest for ${r.runId} is invalid: ${loaded.issues.join('; ')}`);
  return loaded.manifest;
}

function configOf(r: RunCtx): AutomationConfig {
  if (!r.manifest.config) throw new Error(`run ${r.runId} has no configuration yet (configuration stage not done)`);
  return r.manifest.config;
}

function readArtifact<T>(dir: string, rel: string): T | null {
  const j = readJson(path.join(dir, rel));
  return j.ok ? (j.value as T) : null;
}

// This run's artifact, else the source run's (for /heal-tests and /run-tests working from an earlier run).
function artifactWithSource<T>(r: RunCtx, rel: string): { value: T | null; from: string | null } {
  const own = readArtifact<T>(r.dir, rel);
  if (own) return { value: own, from: r.runId };
  if (r.manifest.sourceRunId) {
    const src = readArtifact<T>(runDir(r.root, r.manifest.sourceRunId), rel);
    if (src) return { value: src, from: r.manifest.sourceRunId };
  }
  return { value: null, from: null };
}

// The test specs generation, exploration and review may use: test-specs.json, and only when it is exactly what this run's canonical
// test cases project to. A spec file that was edited by hand, or that does not come from validated canonical test cases, is refused.
function validatedSpecs(r: RunCtx): { specs: TestSpecDocument | null; issues: string[] } {
  const pick = (dir: string) => ({ specs: readArtifact<TestSpecDocument>(dir, ARTIFACTS.testSpecs), canonical: readArtifact<CanonicalDocument>(dir, ARTIFACTS.canonicalCases) });
  let found = pick(r.dir);
  if (!found.specs && r.manifest.sourceRunId) found = pick(runDir(r.root, r.manifest.sourceRunId));
  if (!found.specs) return { specs: null, issues: [`${ARTIFACTS.testSpecs} is missing or not valid JSON`] };
  if (!found.canonical) return { specs: null, issues: [`${ARTIFACTS.canonicalCases} is missing: test cases must be normalized first (run "specs parse")`] };
  const issues = [...validateCanonicalDocument(found.canonical), ...checkSpecsAgainstCanonical(found.canonical, found.specs)];
  return issues.length > 0 ? { specs: null, issues } : { specs: found.specs, issues: [] };
}

// Run-directory subfolders (exploration/) are created on first write, not when the run is created.
function writeInRun(r: RunCtx, rel: string, data: unknown): void {
  const abs = path.join(r.dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeJsonAtomic(abs, data);
}

function readRevalidation(r: RunCtx): Revalidation {
  const saved = readArtifact<Revalidation>(r.dir, ARTIFACTS.explorationRevalidation);
  // A missing or unreadable file proves nothing, so no saved evidence counts as revalidated.
  return saved && saved.schemaVersion === REVALIDATION_SCHEMA_VERSION && typeof saved.pages === 'object' && saved.pages !== null ? saved : emptyRevalidation();
}

function previousPlan(r: RunCtx): ExplorationPlan | null {
  return readArtifact<ExplorationPlan>(r.dir, ARTIFACTS.explorationPlan);
}

// "Covered" test cases (unchanged, with a still-current generated test) are decided against the artifact cache. --revalidate,
// --fresh and --no-cache turn that off for the run, and the choice sticks to the run like --fresh does.
function coverageOptions(r: RunCtx) {
  const config = configOf(r);
  return { coverage: (spec: TestSpec, record: ExplorationRecord) => generationStillCurrent({ rootDir: r.root, config }, spec, record) };
}

// Recomputes the explore/revalidate/covered/reuse decisions from the store and this run's revalidation, and saves them.
function currentPlan(r: RunCtx, forceFresh: boolean, skipCoverage = false): { plan: ExplorationPlan | null; issues: string[] } {
  const { specs, issues } = validatedSpecs(r);
  if (!specs) return { plan: null, issues };
  const baseUrl = configOf(r).app.baseUrl;
  const prior = previousPlan(r);
  const fresh = forceFresh || (prior?.forcedFresh ?? false);
  const plan = planExploration({
    specs, baseUrl, state: loadStore(r.root, baseUrl), revalidation: readRevalidation(r),
    forceFresh: fresh, skipCoverage: fresh || skipCoverage || (prior?.skipCoverage ?? false), ...coverageOptions(r), now: new Date().toISOString(),
  });
  writeInRun(r, ARTIFACTS.explorationPlan, plan);
  return { plan, issues: [] };
}

const SNAPSHOT_DIR = 'exploration/snapshots'; // this run's deterministic snapshots (relative to the run dir)
const SNAPSHOT_SETTLE_MS = [0, 2000]; // extra wait before the first snapshot and before the one retry of a page that looked incomplete

interface PageOutcome {
  page: string;
  outcome: 'revalidated' | 'left-for-explorer';
  snapshot: string | null;
  presentElements?: number;
  reason?: string;
}

// Commits one page's revalidation from a snapshot the pipeline took itself, if the snapshot is allowed to prove it (see
// snapshot-revalidation.ts). Never invalidates anything: a page that does not check out is left as it was for the explorer.
function commitSnapshot(r: RunCtx, baseUrl: string, key: string, needed: string[], result: SnapshotResult): { judgement: Judgement; file: string | null } {
  const file = result.snapshot !== null ? `${SNAPSHOT_DIR}/${snapshotName(key)}` : null;
  const now = new Date().toISOString();
  const judgement = updateStore<Judgement>(r.root, baseUrl, (state) => {
    const no = (reason: string): { store: null; result: Judgement } => ({ store: null, result: { commit: false, reason, retry: false, notPresent: [] } });
    if (state.status !== 'ok') return no(`no usable observation store: ${state.reason}`);
    const saved = state.store.pages[key];
    if (!saved) return no(`page ${key} is not in the store`);
    const text = file !== null && existsSync(path.join(r.dir, file)) ? readFileSync(path.join(r.dir, file), 'utf8') : '';
    const j = judgeSnapshot({ key, baseUrl, result, page: saved, needed, snapshotText: text });
    return { store: j.commit ? applyRevalidation(state.store, key, j.checks, r.runId, now) : null, result: j };
  });
  if (judgement.commit && file !== null) {
    const revalidation = readRevalidation(r);
    revalidation.pages[key] = { revalidatedAt: now, snapshot: file, elements: judgement.checks };
    writeInRun(r, ARTIFACTS.explorationRevalidation, revalidation);
  }
  return { judgement, file };
}

// Writes what this run left behind into the test ledger. The ledger is an index over the store, the cache and the run, so a failure
// here is reported but never blocks a stage; a corrupt ledger is rebuilt from what those hold (its execution history is lost).
function recordLedger(r: RunCtx): { recorded: string[]; tests: number; rebuilt?: string } | { skipped: string } {
  const { specs } = validatedSpecs(r);
  if (!specs) return { skipped: 'the run has no validated test cases yet' };
  if (!r.manifest.config) return { skipped: 'the run has no configuration yet' };
  const baseUrl = r.manifest.config.app.baseUrl;
  const store = loadStore(r.root, baseUrl);
  const generation = artifactWithSource<GenerationManifest>(r, ARTIFACTS.generationManifest).value;
  const exploration = readArtifact<ExplorationRecord>(r.dir, ARTIFACTS.exploration);
  const summary = readArtifact<RunSummary>(r.dir, ARTIFACTS.summary);
  return updateLedger(r.root, baseUrl, (state) => {
    const done = recordRun({
      rootDir: r.root, runId: r.runId, baseUrl, specs, generation, exploration, store, summary,
      previous: state.status === 'ok' ? state.ledger : null, now: new Date().toISOString(),
    });
    return {
      ledger: done.recorded.length > 0 || state.status !== 'ok' ? done.ledger : null,
      result: { recorded: done.recorded, tests: Object.keys(done.ledger.tests).length, ...(state.status === 'corrupt' ? { rebuilt: state.reason } : {}) },
    };
  });
}

// Called after a stage that settles what a test is built from (script_review) or how it ran (report_generation), and at finalization.
export function updateLedgerAfterStage(root: string, runId: string, stage: string, status: string): void {
  if (status !== 'completed' || (stage !== 'script_review' && stage !== 'report_generation')) return;
  try {
    recordLedger(run(root, runId));
  } catch {
    // Derived data: the next stage or `ledger update` records it again.
  }
}

// Locators that failed to resolve in execution make the saved observations unproven.
function invalidateObservations(r: RunCtx, analysis: FailureAnalysis): ExecutionInvalidation[] {
  const baseUrl = r.manifest.config?.app.baseUrl;
  if (!baseUrl) return [];
  return updateStore(r.root, baseUrl, (state) => {
    if (state.status !== 'ok') return { store: null, result: [] };
    const result = invalidateFromFailures(state.store, analysis, new Date().toISOString());
    return { store: result.invalidated.length > 0 ? result.store : null, result: result.invalidated };
  });
}

// The environment the tests will see: .env values, with the real environment winning (as in `env run`).
function envWithDotEnv(root: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(readEnvValues(root)), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}

// The worker plan for a run. A PW_WORKERS in the environment counts as an explicit request, as it does for Playwright itself.
function planFor(root: string, config: AutomationConfig) {
  const env = envWithDotEnv(root);
  const requested = env.PW_WORKERS && /^\d+$/.test(env.PW_WORKERS) ? Number(env.PW_WORKERS) : null;
  const plan = resolveExecutionPlan(requested === null ? config : { ...config, execution: { ...config.execution, workers: requested } }, env);
  const session = sessionPlan(root, config);
  return session ? { ...plan, session, warnings: [...plan.warnings, ...session.notes.filter((n) => /not tagged @own-session/.test(n))] } : plan;
}

const csv = (s: string | undefined): string[] | undefined => (s === undefined ? undefined : s.split(',').map((x) => x.trim()).filter(Boolean));

// The traceability report of a run that started from a design handoff: written next to the summary.
function writeTraceability(r: RunCtx): { ok: true; summary: unknown; gaps: string[] } | { ok: false; issue: string } {
  const handoff = artifactWithSource<HandoffDocument>(r, ARTIFACTS.designHandoff).value;
  if (!handoff) return { ok: false, issue: `${ARTIFACTS.designHandoff} is missing from the run: the traceability report needs the design handoff the run was created from` };
  const report = buildTraceability({
    runId: r.runId, handoff,
    specs: artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value,
    generation: artifactWithSource<GenerationManifest>(r, ARTIFACTS.generationManifest).value,
    execution: artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults).value,
    regression: readArtifact<ExecutionResults>(r.dir, ARTIFACTS.regressionResults),
  });
  writeJsonAtomic(path.join(r.dir, ARTIFACTS.traceabilityReport), report);
  writeFileSync(path.join(r.dir, ARTIFACTS.traceabilityMarkdown), renderTraceabilityMarkdown(report));
  return { ok: true, summary: report.summary, gaps: report.gaps };
}

// The automation coverage report: every test case, automated or not, with the reason. Works at any point of a run (a run that stopped
// early gets one too), from whatever records exist; the page is written next to the other reports. Derived data: it never fails a run.
function writeCoverage(root: string, r: RunCtx, finalTests: FinalTest[] | null): { ok: true; html: string; json: string; summary: unknown } | { ok: false; issue: string } {
  try {
    const execution = artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults).value;
    const specs = artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value;
    const generation = artifactWithSource<GenerationManifest>(r, ARTIFACTS.generationManifest).value;
    const config = r.manifest.config;
    const tests = finalTests ?? (execution ? computeFinalTests({
      results: execution, analysis: readArtifact<FailureAnalysis>(r.dir, ARTIFACTS.failureAnalysis), healing: readArtifact(r.dir, ARTIFACTS.healingLog),
      regression: readArtifact<ExecutionResults>(r.dir, ARTIFACTS.regressionResults), specs, generation,
    }) : null);
    const report = buildCoverage({
      manifest: r.manifest,
      canonical: artifactWithSource<CanonicalDocument>(r, ARTIFACTS.canonicalCases).value,
      specs, generation, execution, finalTests: tests,
      handoff: artifactWithSource<HandoffDocument>(r, ARTIFACTS.designHandoff).value,
      secrets: config ? secretValuesFor(root, config.auth.credentialEnvVars) : [],
    });
    const files = writeCoverageFiles(root, r.dir, report);
    return { ok: true, html: toPosixRelative(root, files.html), json: toPosixRelative(r.dir, files.json), summary: { total: report.summary.total, automated: report.summary.automated, notAutomated: report.summary.notAutomated, automatedPercent: report.summary.automatedPercent, byReason: report.summary.byReason, inputProblems: report.inputProblems.length } };
  } catch (err) {
    return { ok: false, issue: (err as Error).message };
  }
}

function inputPathOf(r: RunCtx, v: Values): string {
  return v.path ?? configOf(r).input.testCasesPath;
}

export function stageCommand(root: string, group: string, action: string | undefined, rest: string[], v: Values): Result {
  switch (`${group} ${action}`) {
    case 'input validate': {
      const r = run(root, rest[0]);
      const inputPath = inputPathOf(r, v);
      const report = validateInput(inputBaseDir(root), r.dir, inputPath, new Date(), loadMappings(root));
      // Record input files and hashes on the manifest for traceability.
      mutateManifest(root, r.runId, (m) => ({ ...m, inputs: report.files.map((f) => ({ path: f.path, sha256: f.sha256 })) }));
      // The full report (with every file hash) is saved as the artifact; the session only needs what to act on.
      const shown = {
        inputPath: report.inputPath, files: report.files.map((f) => f.path), unsupported: report.unsupported, errors: report.errors,
        tables: report.tables, moduleCounts: report.moduleCounts, caseCount: report.caseCount, ok: report.ok,
      };
      return { value: { ok: report.ok, artifact: ARTIFACTS.inputValidation, report: shown }, code: report.ok ? 0 : 2 };
    }

    // Converts the user's test cases, wherever they are, into the pipeline's format under dependencies/input/test-cases/.
    case 'input import': {
      const result = importInput(inputBaseDir(root), cleanSourcePath(need(v.from ?? rest[0], '--from <file-or-folder>')), loadMappings(root), { overwrite: v.overwrite === true });
      // The converted files hold env:VAR references, so the values the source contained must reach .env now (existing values win).
      const env = result.ok && !result.alreadyInPlace
        ? syncEnvFiles(root, new Map(result.credentials.map((c) => [c.envVar, c.value])), referencedEnvVars(result.document))
        : null;
      const { credentials, document, ...shown } = result;
      return {
        value: {
          ...shown,
          // The folder to pass as --input / --path from here on.
          path: IMPORT_DIR,
          env: env && { ...env, detected: credentials.map((c) => c.envVar), action: missingEnvMessage(root, env.missing) },
        },
        code: result.ok ? 0 : 2,
      };
    }

    // How the user's own CSV/Excel layout is read (headers, mapped fields, ignored columns, modules). No cell values.
    case 'input inspect': {
      const state = loadConfig(root);
      const inputPath = v.path ?? (state.status === 'valid' ? state.config.input.testCasesPath : undefined);
      if (!inputPath) throw new UsageError('input inspect --path <file-or-folder> (no configured input path yet)');
      const inspection = inspectInput(inputBaseDir(root), inputPath, loadMappings(root));
      return { value: inspection, code: inspection.ok ? 0 : 2 };
    }

    // Saves how one table's columns map to test-case fields, for layouts the built-in column names do not recognise.
    case 'input map': {
      const base = inputBaseDir(root);
      const file = toRootRelative(base, need(rest[0], 'file'));
      const result = applyMapping(base, root, loadMappings(root), {
        file, sheet: v.sheet ?? null, columns: v.column ?? [],
        headerRow: v['header-row'] === undefined ? undefined : Number(v['header-row']),
        module: v.module, moduleFrom: v['module-from'], skip: v.skip === true, clear: v.clear === true,
      });
      return { value: result, code: result.ok ? 0 : 2 };
    }

    case 'specs parse': {
      const r = run(root, rest[0]);
      const inputPath = inputPathOf(r, v);
      const base = inputBaseDir(root);
      const { canonical, document, errors, unsupported, tables, credentials, decision } = parseSpecsCached(root, base, r.runId, inputPath, { useCache: !v['no-cache'] });
      recordDecisions(r.dir, [decision]);
      // The canonical test cases first; test-specs.json is their projection and carries their hash.
      writeJsonAtomic(path.join(r.dir, ARTIFACTS.canonicalCases), canonical);
      writeJsonAtomic(path.join(r.dir, ARTIFACTS.testSpecs), document);
      // The same cases in the pipeline's own Markdown format, one file per module: a record of how the input was understood.
      const metadataById = new Map(canonical.testCases.map((c) => [c.testCaseId, c.metadata]));
      const normalized = writeNormalizedInput(path.join(r.dir, ARTIFACTS.normalizedInputDir), document, (id) => metadataById.get(id));
      const issues = [...validateCanonicalDocument(canonical), ...validateTestSpecDocument(document)];
      const ready = document.specs.filter((s) => s.status === 'ready');
      const blocked = document.specs.filter((s) => s.status === 'needs_clarification');
      const statusOf = new Map(canonical.testCases.map((c) => [c.testCaseId, c.validation.status]));
      // Credentials and emails found in the test cases go to automation/.env; only names leave this function.
      const env = syncEnvFiles(root, new Map(credentials.map((c) => [c.envVar, c.value])), referencedEnvVars(document));
      const value = {
        ok: issues.length === 0 && errors.length === 0 && ready.length > 0,
        artifact: ARTIFACTS.testSpecs,
        // Register both with the stage: --artifact canonicalCases=<path> --artifact testSpecs=<path>
        canonicalArtifact: ARTIFACTS.canonicalCases,
        validation: { status: canonical.validation.status, counts: canonical.validation.counts, findings: canonical.validation.findings },
        counts: { total: document.specs.length, ready: ready.length, needsClarification: blocked.length },
        modules: normalized.map((m) => ({
          module: m.module, moduleSlug: m.moduleSlug, cases: m.cases,
          ready: ready.filter((s) => s.moduleSlug === m.moduleSlug).length,
          normalizedFile: `${ARTIFACTS.normalizedInputDir}/${m.file}`,
        })),
        // Spreadsheet/CSV layouts: which header fed which field, and the columns that were left out (so nothing is dropped silently).
        tables: tables.map((t) => ({ path: t.path, sheet: t.sheet, status: t.status, reason: t.reason, headerLine: t.headerLine, mapped: t.mapped, ignoredColumns: t.ignoredColumns, ambiguous: t.ambiguous, inferred: t.inferred, suggestions: t.suggestions, moduleFrom: t.moduleFrom, sections: t.sections, titlePrefixes: t.titlePrefixes, cases: t.cases })),
        needsClarification: blocked.map((s) => ({ id: s.id, title: s.title, status: statusOf.get(s.id), source: s.source, ambiguities: s.ambiguities })),
        warnings: canonical.testCases.flatMap((c) => c.validation.warnings.map((w) => ({ id: c.testCaseId, ...w }))),
        env: {
          ...env,
          detected: credentials.map((c) => ({ envVar: c.envVar, usedBy: document.specs.filter((s) => s.testData.some((d) => d.envVar === c.envVar)).map((s) => s.id) })),
          action: missingEnvMessage(root, env.missing),
        },
        errors, unsupported, issues,
        cache: stripEntry(decision),
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    // Is test-specs.json exactly what this run's canonical test cases say, and which cases may be automated?
    case 'specs check': {
      const r = run(root, rest[0]);
      const { specs, issues } = validatedSpecs(r);
      const canonical = artifactWithSource<CanonicalDocument>(r, ARTIFACTS.canonicalCases).value;
      const automatable = canonical?.testCases.filter((c) => c.validation.status === 'valid' || c.validation.status === 'warning').length ?? 0;
      const value = {
        ok: specs !== null && automatable > 0,
        issues: specs === null ? issues : automatable === 0 ? ['no test case is valid: every case needs clarification or is invalid'] : [],
        validation: canonical ? { status: canonical.validation.status, counts: canonical.validation.counts } : null,
        notAutomatable: canonical?.testCases.filter((c) => c.validation.status === 'needs_clarification' || c.validation.status === 'invalid')
          .map((c) => ({ id: c.testCaseId, status: c.validation.status, blocking: c.validation.blocking.map((b) => b.message) })) ?? [],
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    // The module plan: one test file per module, with the file name to use and which specs to generate or hold back.
    case 'specs modules': {
      const r = run(root, rest[0]);
      const doc = artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value;
      if (!doc) return notReady({ ok: false, issues: [`no ${ARTIFACTS.testSpecs} in this run or its source run; run "specs parse" first`] });
      return ok({ ok: true, language: configOf(r).language, modules: planModules(doc, configOf(r).language, root) });
    }

    // Run a command with automation/.env loaded into its environment (the real environment wins). The shell the agent
    // works in does not load .env, and sourcing it in a shell would expand `$` and backticks inside values. Output is
    // returned as JSON with every known secret value masked.
    case 'env run': {
      const [command, ...args] = rest;
      if (!command) throw new UsageError('env run -- <command> [args...]  (quote $VAR with single quotes so the child shell expands it)');
      const real = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v));
      const state = loadConfig(root);
      const configured = state.status === 'valid' ? state.config.auth.credentialEnvVars : [];
      const r = spawnSync(command, args, {
        env: { ...Object.fromEntries(readEnvValues(root)), ...real }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000,
      });
      const secrets = secretValuesFor(root, configured);
      const value = {
        ok: r.status === 0 && !r.error,
        exitCode: r.status,
        stdout: redact(r.stdout ?? '', secrets),
        stderr: redact(r.stderr ?? '', secrets),
        error: r.error ? redact(r.error.message, secrets) : null,
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    case 'env check': {
      const r = run(root, rest[0]);
      const specs = artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value;
      if (!specs) return notReady({ ok: false, issues: [`no ${ARTIFACTS.testSpecs} in this run or its source run; run "specs parse" first`] });
      const names = referencedEnvVars(specs);
      const missing = missingEnvVars(root, names);
      return { value: { ok: missing.length === 0, required: names, missing, action: missingEnvMessage(root, missing) }, code: missing.length ? 2 : 0 };
    }

    case 'explore validate': {
      const r = run(root, rest[0]);
      const record = readArtifact(r.dir, ARTIFACTS.exploration);
      if (!record) return notReady({ ok: false, issues: [`${ARTIFACTS.exploration} is missing or not valid JSON`] });
      const issues = validateExplorationRecord(record, { runDir: r.dir, specs: readArtifact<TestSpecDocument>(r.dir, ARTIFACTS.testSpecs) });
      return { value: { ok: issues.length === 0, artifact: ARTIFACTS.exploration, issues }, code: issues.length ? 2 : 0 };
    }

    case 'explore plan': {
      const r = run(root, rest[0]);
      const { plan, issues } = currentPlan(r, Boolean(v.fresh), Boolean(v.revalidate) || Boolean(v['no-cache']));
      if (!plan) return notReady({ ok: false, issues });
      // The locator digests of known pages go to the explorer's brief, not into the session: here only which pages they are.
      return ok({ ok: true, artifact: ARTIFACTS.explorationPlan, ...plan, knownPages: plan.knownPages.map((p) => p.key) });
    }

    case 'explore revalidate': {
      const r = run(root, rest[0]);
      const baseUrl = configOf(r).app.baseUrl;
      const key = pageKey(need(v.page, '--page'), baseUrl);
      if (key === null) throw new UsageError(`--page must be a path or URL on ${baseUrl}`);
      const file = need(v.file, '--file');
      if (isAbsoluteOrEscaping(file)) throw new UsageError('--file must be relative to the run directory');
      const snapshotAbs = path.join(r.dir, file);
      if (!existsSync(snapshotAbs)) throw new UsageError(`snapshot ${file} does not exist in the run directory`);
      const now = new Date().toISOString();
      const outcome = updateStore<{ issues: string[] } | { checks: ReturnType<typeof checkElements> }>(root, baseUrl, (state) => {
        if (state.status !== 'ok') return { store: null, result: { issues: [`no usable observation store: ${state.reason}`] } };
        const saved = state.store.pages[key];
        if (!saved) return { store: null, result: { issues: [`page ${key} is not in the store; explore it fresh`] } };
        const checks = checkElements(saved, readFileSync(snapshotAbs, 'utf8'));
        return { store: applyRevalidation(state.store, key, checks, r.runId, now), result: { checks } };
      });
      if ('issues' in outcome) return notReady({ ok: false, issues: outcome.issues });
      const checks = outcome.checks;
      const revalidation = readRevalidation(r);
      revalidation.pages[key] = { revalidatedAt: now, snapshot: file, elements: checks };
      writeInRun(r, ARTIFACTS.explorationRevalidation, revalidation);
      const plan = currentPlan(r, false).plan!;
      return ok({
        ok: true, page: key, elements: checks,
        // Test cases on this page and what happens to them now.
        specs: plan.specs.filter((s) => s.pages.includes(key) || s.action === 'explore'),
        summary: plan.summary,
      });
    }

    // Revalidates the plan's pages without an agent: one headless snapshot per page, taken now, checked against the saved locators.
    // A page that cannot be proven this way (redirected, needs an interaction, a locator not found) is left untouched for the explorer.
    case 'explore snapshot': {
      const r = run(root, rest[0]);
      const config = configOf(r);
      const baseUrl = config.app.baseUrl;
      const first = currentPlan(r, false);
      if (!first.plan) return notReady({ ok: false, issues: first.issues });
      const todo = first.plan.pagesToRevalidate;
      if (todo.length === 0) return ok({ ok: true, pages: [], note: 'no saved page needs a snapshot', summary: first.plan.summary, explorerNeeded: first.plan.summary.explore > 0 });

      // Saved login state is used only when auth-state.ts says it is good; otherwise the page is opened logged out, and a redirect to the
      // login page is caught by the landed-on check instead of being compared.
      const auth = inspectAuthState(root, config);
      const stateFile = auth.decision === 'reuse' ? statePath(root) : null;
      const snapshotsAbs = path.join(r.dir, SNAPSHOT_DIR);
      mkdirSync(snapshotsAbs, { recursive: true });
      const toolPath = path.join(import.meta.dirname, '..', 'tools', 'aria-snapshot.ts');
      const needed = new Map(todo.map((p) => [p.key, p.locators]));
      const outcomes = new Map<string, PageOutcome>();
      let pending = todo.map((p) => ({ key: p.key, url: p.url }));
      let unavailable: string | null = null;

      for (const settleMs of SNAPSHOT_SETTLE_MS) {
        if (pending.length === 0 || unavailable) break;
        const jobsFile = path.join(snapshotsAbs, 'jobs.json');
        writeJsonAtomic(jobsFile, buildJobs(pending, baseUrl, (k) => path.join(snapshotsAbs, snapshotName(k))));
        const ran = runSupervised(process.execPath, [toolPath, '--batch', jobsFile, '--framework', root, '--settle-ms', String(settleMs), ...(stateFile ? ['--storage-state', stateFile] : [])], {
          cwd: root, timeoutMs: Math.min(300_000, 60_000 + pending.length * 20_000), ledgerDir: r.dir, role: 'explore:snapshot',
        });
        let results: SnapshotResult[] | null = null;
        try { results = (JSON.parse(ran.stdout) as { results?: SnapshotResult[] }).results ?? null; } catch { /* reported below */ }
        if (!results) {
          unavailable = ran.error?.message ?? (ran.stderr.trim().split('\n')[0] || `the snapshot tool exited with ${ran.status}`);
          break;
        }
        const retry: typeof pending = [];
        for (const res of results) {
          const { judgement, file } = commitSnapshot(r, baseUrl, res.key, needed.get(res.key) ?? [], res);
          if (judgement.commit) {
            outcomes.set(res.key, { page: res.key, outcome: 'revalidated', snapshot: file, presentElements: Object.keys(judgement.checks).length });
          } else if (judgement.retry && settleMs === SNAPSHOT_SETTLE_MS[0]) {
            retry.push(pending.find((p) => p.key === res.key)!);
          } else {
            outcomes.set(res.key, { page: res.key, outcome: 'left-for-explorer', snapshot: file, reason: judgement.reason });
          }
        }
        pending = retry;
      }
      for (const p of pending) outcomes.set(p.key, { page: p.key, outcome: 'left-for-explorer', snapshot: null, reason: unavailable ?? 'no snapshot was taken' });

      const plan = currentPlan(r, false).plan!;
      return ok({
        ok: true, pages: todo.map((p) => outcomes.get(p.key)!), summary: plan.summary,
        ...(unavailable ? { unavailable: `the deterministic snapshot could not run (${unavailable}); the explorer takes these snapshots instead` } : {}),
        auth: { approach: auth.approach, used: stateFile !== null, status: auth.status },
        explorerNeeded: plan.specs.some((s) => s.action === 'explore' || s.action === 'revalidate'),
        pagesLeft: plan.pagesToRevalidate.map((p) => p.key),
      });
    }

    case 'explore assemble': {
      const r = run(root, rest[0]);
      const { specs, issues: specIssues } = validatedSpecs(r);
      if (!specs) return notReady({ ok: false, issues: specIssues });
      const baseUrl = configOf(r).app.baseUrl;
      let fresh = readArtifact(r.dir, ARTIFACTS.explorationFresh);
      if (!fresh) {
        // No explorer ran. That is only legitimate when every test case reuses revalidated evidence or is covered.
        const planned = currentPlan(r, false).plan;
        if (planned && planned.specs.every((s) => s.action === 'reuse' || s.action === 'covered')) fresh = emptyFreshRecord(baseUrl, new Date().toISOString());
      }
      if (!fresh) return notReady({ ok: false, issues: [`${ARTIFACTS.explorationFresh} is missing or not valid JSON; write what you observed this run there first`] });
      const result = updateStore(root, baseUrl, (state) => {
        const assembled = assembleExploration({
          runId: r.runId, runDir: r.dir, specs, baseUrl, state,
          revalidation: readRevalidation(r), fresh, forceFresh: previousPlan(r)?.forcedFresh ?? false,
          skipCoverage: (previousPlan(r)?.forcedFresh ?? false) || (previousPlan(r)?.skipCoverage ?? false), ...coverageOptions(r), now: new Date().toISOString(),
        });
        return { store: assembled.ok ? assembled.store : null, result: assembled };
      });
      writeInRun(r, ARTIFACTS.explorationPlan, result.plan);
      if (!result.ok) return notReady({ ok: false, issues: result.issues, summary: result.plan.summary });
      writeInRun(r, ARTIFACTS.exploration, result.record);
      // Exploration reuse is decided by exploration-reuse.ts; the ledger just makes it visible next to the other caches.
      recordDecisions(r.dir, result.plan.specs.map((p): CacheDecision => ({
        kind: 'exploration', name: p.testId, action: result.record.reuse?.reusedSpecs.includes(p.testId) ? 'reuse' : 'rebuild',
        reason: result.record.reuse?.reasons[p.testId] ?? p.reason, changed: [],
      })));
      return ok({ ok: true, artifact: ARTIFACTS.exploration, reuse: result.record.reuse, store: result.plan.store });
    }

    case 'explore invalidate': {
      const r = run(root, rest[0]);
      const baseUrl = configOf(r).app.baseUrl;
      const key = pageKey(need(v.page, '--page'), baseUrl);
      if (key === null) throw new UsageError(`--page must be a path or URL on ${baseUrl}`);
      const reason = `${r.runId}: ${need(v.reason, '--reason')}`;
      const marked = updateStore<{ issues: string[] } | { changed: number }>(root, baseUrl, (state) => {
        if (state.status !== 'ok') return { store: null, result: { issues: [`no usable observation store: ${state.reason}`] } };
        const m = markStale(state.store, key, v.locator ?? null, reason, new Date().toISOString());
        return { store: m.changed > 0 ? m.store : null, result: { changed: m.changed } };
      });
      if ('issues' in marked) return notReady({ ok: false, issues: marked.issues });
      return ok({ ok: true, page: key, locator: v.locator ?? null, invalidatedElements: marked.changed });
    }

    case 'explore store': {
      const r = run(root, rest[0]);
      const state = loadStore(root, configOf(r).app.baseUrl);
      if (state.status !== 'ok') return ok({ ok: true, store: state });
      const elements = Object.values(state.store.pages).flatMap((p) => p.elements);
      return ok({
        ok: true, status: 'ok', updatedAt: state.store.updatedAt,
        pages: Object.keys(state.store.pages).length, specs: Object.keys(state.store.specs).length,
        elements: { verified: elements.filter((e) => e.status === 'verified').length, stale: elements.filter((e) => e.status === 'stale').length },
        recentInvalidations: state.store.invalidations.slice(-10),
      });
    }

    case 'generate plan': {
      const r = run(root, rest[0]);
      const { specs, issues: specIssues } = validatedSpecs(r);
      if (!specs) return notReady({ ok: false, issues: specIssues });
      const { plan, decisions } = planGeneration({
        rootDir: root, specs, record: readArtifact<ExplorationRecord>(r.dir, ARTIFACTS.exploration), config: configOf(r),
        force: Boolean(v.force), useCache: !v['no-cache'],
      });
      writeInRun(r, ARTIFACTS.generationPlan, plan);
      recordDecisions(r.dir, decisions);
      return ok({
        ok: true, artifact: ARTIFACTS.generationPlan, summary: plan.summary, batches: plan.batches,
        reuse: plan.specs.filter((p) => p.action === 'reuse').map((p) => p.testId),
        generate: plan.specs.filter((p) => p.action === 'generate').map((p) => ({ testId: p.testId, reason: p.reason })),
      });
    }

    // Folds batch manifests (parallel generation) and reused tests into the single generation-manifest.json.
    case 'generate assemble': {
      const r = run(root, rest[0]);
      const { specs, issues: specIssues } = validatedSpecs(r);
      if (!specs) return notReady({ ok: false, issues: specIssues });
      const merged = mergeGeneration({
        rootDir: root, runDir: r.dir, specs, config: configOf(r), plan: readArtifact<GenerationPlan>(r.dir, ARTIFACTS.generationPlan),
      });
      if (!merged.ok) return notReady({ ok: false, issues: merged.issues });
      writeJsonAtomic(path.join(r.dir, ARTIFACTS.generationManifest), merged.manifest);
      const report = path.join(r.dir, ARTIFACTS.generationReport);
      if (!existsSync(report)) {
        const reuse = merged.manifest.reuse;
        const list = (ids: string[] | undefined) => ids?.join(', ') || 'none';
        writeFileSync(report, ['# Generation', '', `Generated now: ${list(reuse?.generatedTests)}`, `Reused unchanged from earlier runs: ${list(reuse?.reusedTests)}`, ''].join('\n'));
      }
      return ok({ ok: true, artifacts: [ARTIFACTS.generationManifest, ARTIFACTS.generationReport], tests: merged.manifest.tests.length, reuse: merged.manifest.reuse });
    }

    case 'generate validate': {
      const r = run(root, rest[0]);
      const g = readArtifact(r.dir, ARTIFACTS.generationManifest);
      if (!g) return notReady({ ok: false, issues: [`${ARTIFACTS.generationManifest} is missing or not valid JSON`] });
      const checked = validatedSpecs(r);
      const issues = [...checked.issues.filter((m) => !m.endsWith('is missing or not valid JSON')), ...validateGenerationManifest(g, { rootDir: root, specs: checked.specs })];
      if (!existsSync(path.join(r.dir, ARTIFACTS.generationReport))) issues.push(`${ARTIFACTS.generationReport} is missing`);
      return { value: { ok: issues.length === 0, artifacts: [ARTIFACTS.generationManifest, ARTIFACTS.generationReport], issues }, code: issues.length ? 2 : 0 };
    }

    case 'review static':
      return reviewStatic(run(root, rest[0]), !v['no-cache']);

    case 'review plan': {
      const r = run(root, rest[0]);
      const { specs, issues: specIssues } = validatedSpecs(r);
      const generation = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
      if (!specs || !generation) return notReady({ ok: false, issues: [...specIssues, ...(generation ? [] : [`${ARTIFACTS.generationManifest} is required`])] });
      const { plan, decisions } = planReview({
        rootDir: root, specs, record: readArtifact<ExplorationRecord>(r.dir, ARTIFACTS.exploration), config: configOf(r), generation,
        force: Boolean(v.force), useCache: !v['no-cache'],
      });
      writeJsonAtomic(path.join(r.dir, ARTIFACTS.reviewPlan), plan);
      recordDecisions(r.dir, decisions);
      return ok({
        ok: true, artifact: ARTIFACTS.reviewPlan, summary: plan.summary, filesToReview: plan.filesToReview,
        skip: plan.tests.filter((t) => t.action === 'skip').map((t) => t.testId),
        review: plan.tests.filter((t) => t.action === 'review').map((t) => ({ testId: t.testId, reason: t.reason })),
      });
    }

    // Records a finished, clean review so the next run can skip unchanged tests.
    case 'review seal': {
      const r = run(root, rest[0]);
      const { specs, issues: specIssues } = validatedSpecs(r);
      const generation = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
      const report = readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport);
      if (!specs || !generation || !report) return notReady({ ok: false, issues: [...specIssues, ...(generation && report ? [] : [`${ARTIFACTS.generationManifest} and ${ARTIFACTS.reviewReport} are required`])] });
      if (v['no-cache']) return ok({ ok: true, sealed: [], notSealed: [], note: 'cache disabled: nothing recorded' });
      const reviewerRan = readAgentUsage(r.dir).invocations.some((x) => x.stage === 'script_review' && x.agent === 'test-reviewer');
      const res = sealReview({
        rootDir: root, runId: r.runId, specs, record: readArtifact<ExplorationRecord>(r.dir, ARTIFACTS.exploration), config: configOf(r),
        generation, report, plan: readArtifact<ReviewPlan>(r.dir, ARTIFACTS.reviewPlan), reviewerRan,
      });
      return { value: res, code: res.ok ? 0 : 2 };
    }

    case 'review add': {
      const r = run(root, rest[0]);
      const report = loadReview(r);
      const raw = JSON.parse(readFileSync(need(v.file, '--file'), 'utf8')) as Partial<ReviewFinding>[];
      if (!Array.isArray(raw)) throw new UsageError('--file must contain a JSON array of findings');
      const added = raw.map((f, i): ReviewFinding => {
        if (!(SEVERITIES as readonly unknown[]).includes(f.severity)) throw new UsageError(`finding ${i}: severity must be one of ${SEVERITIES.join(', ')}`);
        if (!f.file || !f.rule || !f.message) throw new UsageError(`finding ${i}: file, rule and message are required`);
        return { id: `R${String(report.findings.filter((x) => x.source === 'reviewer').length + i + 1).padStart(3, '0')}`, severity: f.severity as Severity, file: f.file, line: f.line ?? null, rule: f.rule, message: f.message, status: 'open', source: 'reviewer' };
      });
      return saveReview(r, { ...report, findings: [...report.findings, ...added] });
    }

    case 'review resolve': {
      const r = run(root, rest[0]);
      const id = need(rest[1], 'findingId');
      const status = need(v.status, '--status');
      if (status !== 'fixed' && status !== 'accepted') throw new UsageError('--status must be fixed or accepted');
      const report = loadReview(r);
      const f = report.findings.find((x) => x.id === id);
      if (!f) throw new UsageError(`no finding ${id}`);
      if (f.source === 'static') throw new UsageError('static findings resolve by fixing the code and re-running "review static"');
      if (status === 'accepted' && f.severity === 'critical') throw new UsageError('critical findings must be fixed, not accepted');
      return saveReview(r, { ...report, findings: report.findings.map((x) => (x.id === id ? { ...x, status, message: v.note ? `${x.message} — ${v.note}` : x.message } : x)) });
    }

    case 'exec run': {
      const r = run(root, rest[0]);
      const label = v.label ?? 'initial';
      // A previous result is history, never the current result: every execution runs the tests.
      recordDecisions(r.dir, [{ kind: 'execution', name: label, action: 'rebuild', reason: 'execution results are never reused across runs', changed: [] }]);
      // Catches a config saved before a dependency (e.g. allure-playwright) was installed; a hand-edited file is left as it is.
      syncFromSavedConfig(root);
      const config = configOf(r);
      const executionPlan = planFor(root, config);
      const options = {
        runId: r.runId, label,
        files: v['test-file'], testIds: v['test-id'], projects: v.project,
        retries: v.retries === undefined ? undefined : Number(v.retries),
        headed: v.headed ? true : undefined,
      };
      // Saved login state is checked first; a rejected session is replaced and the tests run again (once). The worker count
      // is the plan's (it needs the per-worker accounts from .env, which the generated Playwright config reads only at run time).
      const results = {
        ...runWithAuthState(root, config, {
          runOnce: (extra) => runPlaywright(root, config, { ...options, extraEnv: { PW_WORKERS: String(executionPlan.workers), ...extra } }),
        }),
        executionPlan,
      };
      const file = saveResults(r.dir, results);
      if (results.authState) writeInRun(r, ARTIFACTS.authState, { label, ...results.authState });
      const value = {
        ok: results.runnerError === null,
        artifact: toPosixRelative(r.dir, file),
        label, exitCode: results.exitCode, runnerError: results.runnerError, stats: results.stats,
        executionPlan: { workers: executionPlan.workers, fullyParallel: executionPlan.fullyParallel, isolation: executionPlan.isolation, limits: executionPlan.limits, warnings: executionPlan.warnings, ...(executionPlan.session ? { session: executionPlan.session } : {}) },
        authState: results.authState ?? null,
        notPassed: results.tests.filter((t) => t.outcome !== 'passed').map((t) => ({ key: t.key, outcome: t.outcome, file: t.file, line: t.line })),
        runnerLog: results.runnerLog,
      };
      return { value, code: value.ok ? 0 : 2 };
    }

    // What the next execution would do about workers and saved login state, without running anything.
    case 'exec plan': {
      const r = run(root, rest[0]);
      const config = configOf(r);
      return ok({ ok: true, executionPlan: planFor(root, config), authState: inspectAuthState(root, config) });
    }

    case 'auth check': {
      const state = loadConfig(root);
      if (state.status !== 'valid') return notReady({ ok: false, issues: state.issues });
      return ok({ ok: true, ...inspectAuthState(root, state.config) });
    }

    // Explicit cleanup: removes the saved session and its record. The next run logs in again.
    case 'auth clear': {
      return ok({ ok: true, removed: clearAuthState(root) });
    }

    // Stops what a run left running (its browser sessions and the processes the pipeline recorded). `ok` is false when something could
    // not be stopped or the process list could not be read: the report never claims a clean machine it did not check.
    case 'cleanup run': {
      // Only the run id is needed (not a loadable manifest): the runs that most need a cleanup may be the broken ones.
      const report = cleanupRun(root, need(rest[0], 'runId'), { trigger: 'cleanup run', dryRun: v['dry-run'] === true });
      return { value: report, code: report.ok ? 0 : 2 };
    }

    // ---- test data the run created (created-data.ts / data-cleanup.ts) ----

    // Removes what the run's tests and explorer created and the tests did not already remove, through the ways config.cleanup declares,
    // in an allowed non-production environment only. Leftovers are listed, never an error: the user decides what to do with them.
    case 'cleanup data': {
      const runId = need(rest[0], 'runId');
      const report = sweepData(root, runId, savedConfig(root), { trigger: 'cleanup data', dryRun: v['dry-run'] === true });
      return ok({ ok: true, ...report });
    }

    case 'cleanup status': {
      const runId = need(rest[0], 'runId');
      const summary = summarizeData(readCreatedData(runDir(root, runId)), savedConfig(root));
      const last = readSweepHistory(runDir(root, runId)).at(-1);
      return ok({ ok: true, ...summary, lastSweep: last ? { trigger: last.trigger, at: last.at, ran: last.ran } : null });
    }

    // The explorer (or anyone) registers a record they created while exploring, so it can be removed with the rest.
    case 'cleanup record': {
      const runId = need(rest[0], 'runId');
      if (!existsSync(runDir(root, runId))) throw new UsageError(`no run folder for ${runId}`);
      const entity = need(v.entity, '--entity');
      const identifier = need(v.identifier, '--identifier');
      try {
        const rec = recordExternally(runDir(root, runId), { entity, identifier, hint: v.hint ?? null });
        return ok({ ok: true, id: rec.id, entity: rec.entity, identifier: rec.identifier });
      } catch (err) {
        return notReady({ ok: false, issues: [(err as Error).message] });
      }
    }

    // The data-cleaner agent reports the outcome of a deletion it did through the UI.
    case 'cleanup resolve': {
      const runId = need(rest[0], 'runId');
      const id = need(rest[1], 'recordId');
      const status = need(v.status, '--status');
      if (status !== 'deleted' && status !== 'verified_gone' && status !== 'failed') throw new UsageError('--status must be deleted, verified_gone or failed');
      if (status === 'failed' && !v.note) throw new UsageError('--note is required with --status failed (what went wrong)');
      if (!readCreatedData(runDir(root, runId)).some((r) => r.id === id)) return notReady({ ok: false, issues: [`no record ${id} in run ${runId}`] });
      updateRecords(runDir(root, runId), new Map([[id, { status: status as RecordStatus, removedBy: status === 'failed' ? null : 'ui-agent', error: status === 'failed' ? v.note! : null }]]));
      return ok({ ok: true, id, status });
    }

    case 'cleanup all': {
      const report = cleanupAll(root, { trigger: 'cleanup all', dryRun: v['dry-run'] === true });
      return { value: report, code: report.ok ? 0 : 2 };
    }

    case 'triage run': {
      const r = run(root, rest[0]);
      const src = artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults);
      if (!src.value) return notReady({ ok: false, issues: ['no execution results in this run or its source run'] });
      if (src.value.runnerError) return notReady({ ok: false, issues: [`source execution had a runner error: ${src.value.runnerError}`] });
      // Tests that did not run because a test they depend on failed are reported as blocked, not as failures of their own.
      const specs = validatedSpecs(r).specs;
      const dependsOn = new Map((specs?.specs ?? []).filter((s) => s.dependsOn?.length).map((s) => [s.id, s.dependsOn!]));
      const analysis = buildFailureAnalysis(src.value, new Date(), dependsOn);
      saveFailureAnalysis(path.join(r.dir, ARTIFACTS.failureAnalysis), analysis);
      const invalidatedObservations = invalidateObservations(r, analysis);
      return ok({
        ok: true, artifact: ARTIFACTS.failureAnalysis, resultsFrom: src.from, failures: analysis.failures.map(brief),
        eligibleForHealing: analysis.failures.filter((f) => f.healingEligible).map((f) => f.key),
        blockedByDependency: (analysis.blocked ?? []).map((b) => ({ key: b.key, blockedBy: b.blockedBy })),
        invalidatedObservations,
      });
    }

    case 'triage classify': {
      const r = run(root, rest[0]);
      const key = need(rest[1], 'key');
      const category = need(v.category, '--category') as Category;
      const confidence = need(v.confidence, '--confidence') as Confidence;
      if (!CATEGORIES.includes(category)) throw new UsageError(`--category must be one of ${CATEGORIES.join(', ')}`);
      if (!CONFIDENCES.includes(confidence)) throw new UsageError(`--confidence must be one of ${CONFIDENCES.join(', ')}`);
      const analysis = loadAnalysis(r);
      const updated = reclassify(analysis, key, category, confidence, need(v.rationale, '--rationale'));
      saveFailureAnalysis(path.join(r.dir, ARTIFACTS.failureAnalysis), updated);
      return ok({ ok: true, failure: brief(updated.failures.find((f) => f.key === key || f.testId === key)!) });
    }

    case 'heal begin': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const file = need(v['test-file']?.[0], '--test-file');
      const failure = eligibleFailure(loadAnalysis(r), testId);
      let reserved: { attempt: number; remaining: number };
      try {
        reserved = recordHealingAttempt(root, r.runId, testId);
      } catch (err) {
        if (err instanceof HealingLimitError) return notReady({ ok: false, limitReached: true, message: err.message });
        throw err;
      }
      const snap = snapshotForAttempt(root, r.dir, testId, reserved.attempt, file);
      return ok({ ok: true, ...reserved, snapshot: toPosixRelative(r.dir, snap), rerunLabel: healLabel(testId, reserved.attempt), failure: brief(failure) });
    }

    case 'heal check': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const guard = checkAttempt(root, r.dir, testId, Number(need(v.attempt, '--attempt')), need(v['test-file']?.[0], '--test-file'));
      return { value: guard, code: guard.ok ? 0 : 2 };
    }

    case 'heal revert': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      revertAttempt(root, r.dir, testId, Number(need(v.attempt, '--attempt')), need(v['test-file']?.[0], '--test-file'));
      return ok({ ok: true, reverted: true });
    }

    case 'heal record': {
      const r = run(root, rest[0]);
      const testId = need(rest[1], 'testId');
      const attempt = Number(need(v.attempt, '--attempt'));
      const rerunFile = resultsPathFor(r.dir, healLabel(testId, attempt));
      const rerun = readArtifact<ExecutionResults>(r.dir, toPosixRelative(r.dir, rerunFile));
      const entry = recordAttempt(root, r.dir, {
        testId, attempt, file: need(v['test-file']?.[0], '--test-file'),
        rationale: need(v.rationale, '--rationale'), evidence: v.evidence ?? [],
        failure: eligibleFailure(loadAnalysis(r), testId),
        rerun, rerunFile: rerun ? toPosixRelative(r.dir, rerunFile) : null,
      });
      // The healed source is the one that passed its rerun: keep a cached generation in step with it.
      if (entry.outcome === 'healed') refreshAfterHeal(root, testId, entry.file, r.runId);
      const remaining = (r.manifest.healing.maxAttemptsPerTest ?? 0) - attempt;
      return ok({ ok: true, artifact: ARTIFACTS.healingLog, outcome: entry.outcome, reverted: entry.reverted, guard: entry.guard, attemptsRemaining: Math.max(0, remaining) });
    }

    case 'heal finish': {
      const r = run(root, rest[0]);
      ensureHealingLog(r.dir);
      const log = readHealingLog(r.dir);
      return ok({ ok: true, artifact: ARTIFACTS.healingLog, healedTests: [...new Set(log.entries.filter((e) => e.outcome === 'healed').map((e) => e.testId))], healedFiles: [...new Set(log.entries.filter((e) => e.outcome === 'healed').map((e) => e.file))] });
    }

    case 'report build': {
      const r = run(root, rest[0]);
      const config = configOf(r);
      const results = artifactWithSource<ExecutionResults>(r, ARTIFACTS.executionResults);
      const summary = buildSummary({
        rootDir: root, runDir: r.dir,
        reporterRunId: results.from ?? r.runId,
        manifest: r.manifest, config,
        results: results.value,
        analysis: readArtifact<FailureAnalysis>(r.dir, ARTIFACTS.failureAnalysis),
        healing: readArtifact(r.dir, ARTIFACTS.healingLog),
        regression: readArtifact<ExecutionResults>(r.dir, ARTIFACTS.regressionResults),
        specs: artifactWithSource<TestSpecDocument>(r, ARTIFACTS.testSpecs).value,
        generation: artifactWithSource<GenerationManifest>(r, ARTIFACTS.generationManifest).value,
      });
      // A run that started from test design also gets the story -> ... -> result chain, from the same files.
      // The report is part of the design command's contract; for any other run that carries a design link it is a bonus, never a failure.
      const designRun = r.manifest.command === 'design-test-n-automation';
      const trace = designRun || r.manifest.design || artifactWithSource<HandoffDocument>(r, ARTIFACTS.designHandoff).value ? writeTraceability(r) : null;
      // Every run also gets the automation coverage page (which test cases were automated, which were not and why). It is derived
      // from the same files and never makes the report build fail.
      const coverage = writeCoverage(root, r, summary.tests);
      const good = reportersOk(summary) && !summary.runnerError && (trace === null || trace.ok || !designRun);
      // Report generation and test outcomes are separate questions: a broken reporter says nothing about the tests, and
      // failing tests say nothing about whether the reports could be built.
      const value = {
        ok: good,
        artifacts: [ARTIFACTS.summary, ARTIFACTS.summaryMarkdown, ...(coverage.ok ? [ARTIFACTS.automationCoverage] : []), ...(trace?.ok ? [ARTIFACTS.traceabilityReport, ARTIFACTS.traceabilityMarkdown] : [])],
        coverage: coverage.ok ? { html: coverage.html, json: coverage.json, ...(coverage.summary as object) } : { error: coverage.issue },
        ...(trace ? { traceability: trace.ok ? { summary: trace.summary, gaps: trace.gaps } : { error: trace.issue } } : {}),
        mode: summary.mode,
        reportGeneration: summary.reportGeneration,
        counts: summary.counts, reporters: summary.reporters, unresolved: summary.unresolved, runnerError: summary.runnerError,
      };
      return { value, code: good ? 0 : 2 };
    }

    // Automation coverage at any point of a run: which test cases are automated, which are not, and the reason for each. "report build"
    // writes it too; run this one when a run stopped (blocked, failed) before report_generation, or to refresh it.
    case 'report coverage': {
      const r = run(root, rest[0]);
      const finalSummary = readArtifact<RunSummary>(r.dir, ARTIFACTS.summary);
      const c = writeCoverage(root, r, finalSummary?.tests ?? null);
      if (!c.ok) return notReady({ ok: false, issues: [c.issue] });
      return ok({ ok: true, artifact: ARTIFACTS.automationCoverage, html: c.html, json: c.json, ...(c.summary as object) });
    }

    case 'run finalize': {
      const r = run(root, rest[0]);
      const summary = readArtifact<{ counts: Parameters<typeof setTestCounts>[2] }>(r.dir, ARTIFACTS.summary);
      if (summary) setTestCounts(root, r.runId, summary.counts);
      const pruned = pruneRuns(root, r.manifest.config?.retention.keepRuns ?? null, r.runId);
      // Metrics are derived data: failing to write them must never block finalization.
      let metrics: { file: string; slowest: unknown } | { error: string };
      try {
        const written = writeRunMetrics(root, loadFresh(r), new Date());
        metrics = { file: written.file, slowest: written.metrics.slowest };
      } catch (err) {
        metrics = { error: (err as Error).message };
      }
      // Nothing of this run may stay running: its browser sessions and anything the runner left behind are stopped here, and the
      // result says what was found. A failed cleanup never blocks finalization, but it is reported.
      const cleanup = sweepRun(root, r.runId, 'run finalize') ?? { trigger: 'run finalize', stopped: 0, sessions: [], stillRunning: [] };
      // The same for test data: a last sweep, and the list of what is still there (informational: it never blocks finalization).
      const data = sweepDataSafely(root, r.runId, savedConfig(root), { trigger: 'run finalize' });
      // The last chance to record how this run ended in the test ledger (derived data: never blocks finalization either).
      updateLedgerAfterStage(root, r.runId, 'report_generation', 'completed');
      return ok({ ok: true, counts: summary?.counts ?? null, pruned, summary: summary ? toPosixRelative(path.dirname(root), path.join(r.dir, ARTIFACTS.summaryMarkdown)) : null, metrics, cleanup, ...(data ? { data } : {}) });
    }

    case 'run metrics': {
      const r = run(root, rest[0]);
      if (v.write) {
        const written = writeRunMetrics(root, r.manifest);
        return ok({ ...written.metrics, file: written.file });
      }
      return ok(buildRunMetrics(root, r.manifest));
    }

    // Is the candidate run really better than the baseline? Correctness first, then time.
    case 'run compare':
      return ok(compareRuns(root, need(rest[0], 'baselineRunId'), need(rest[1], 'candidateRunId')));

    // Slowest-stage report over the given runs (default: every run on disk).
    case 'run baseline':
      return ok(buildBaseline(root, rest));

    // ---- test design -> automation ----

    // What the design stages left, and whether an earlier handoff is still current. Read-only.
    case 'design status': {
      const s = designStatus(root);
      return { value: s, code: s.ok ? 0 : 2 };
    }

    // Automation readiness. With --path: the cases at that input path (any supported format). Without: the design's saved stories
    // (--story narrows them), exactly as a handoff would judge them, but nothing is written.
    case 'design readiness': {
      if (v.path) {
        const base = inputBaseDir(root);
        const files = listInputFiles(base, v.path);
        const parsed = parseInputs(base, files, new Date(), loadMappings(root));
        if (parsed.errors.length > 0) return notReady({ ok: false, issues: parsed.errors.map((e) => `${e.path}: ${e.message}`) });
        const present = new Set([...readEnvValues(root)].filter(([, val]) => val !== '').map(([k]) => k));
        const report = assessReadiness(parsed.document, { presentEnvVars: present, overrides: new Set(csv(v['override-manual']) ?? []) });
        return ok({ ok: true, source: v.path, readiness: report });
      }
      const res = handOver(root, { stories: csv(v.story), overrideManual: csv(v['override-manual']), apply: false });
      return { value: { ...res, dryRun: true }, code: res.ok ? 0 : 2 };
    }

    // Hands the chosen stories' test cases to the automation stages. Without --apply nothing is written.
    case 'design handoff': {
      const res = handOver(root, { stories: csv(v.story), overrideManual: csv(v['override-manual']), apply: v.apply === true });
      return { value: v.apply === true ? res : { ...res, dryRun: true, next: 'run again with --apply to import the cases' }, code: res.ok ? 0 : 2 };
    }

    // Refresh the run's snapshot of the handoff after the handoff was redone (only while the run has not finished).
    case 'design attach': {
      const r = run(root, rest[0]);
      if (!r.manifest.design) return notReady({ ok: false, issues: [`run ${r.runId} was not created from a design handoff (run create --design)`] });
      if (r.manifest.status === 'completed') return notReady({ ok: false, issues: [`run ${r.runId} is completed; start a new run for the new handoff`] });
      const a = attachHandoffToRun(root, r.dir);
      if (!a.ok) return notReady({ ok: false, issues: a.issues });
      mutateManifest(root, r.runId, (m) => ({ ...m, design: { handoffSha256: a.sha256, designRunId: a.designRunId } }));
      return ok({ ok: true, runId: r.runId, designRunId: a.designRunId, note: 'a stage that already completed on the older handoff keeps its result; run "specs parse" again so the analysis follows the new input' });
    }

    // Story -> criterion -> scenario -> case -> script -> result for a run. Also built by "report build".
    case 'design trace': {
      const r = run(root, rest[0]);
      const t = writeTraceability(r);
      if (!t.ok) return notReady({ ok: false, issues: [t.issue] });
      return ok({ ok: true, artifacts: [ARTIFACTS.traceabilityReport, ARTIFACTS.traceabilityMarkdown], summary: t.summary, gaps: t.gaps });
    }

    case 'agents plan': {
      const r = run(root, rest[0]);
      const stage = need(rest[1], 'stage');
      if (!isStageName(stage)) throw new UsageError(`unknown stage ${JSON.stringify(stage)}`);
      const input: PlannerInput = {
        stage, rootDir: root,
        specs: readArtifact<TestSpecDocument>(r.dir, ARTIFACTS.testSpecs),
        explorationPlan: readArtifact<ExplorationPlan>(r.dir, ARTIFACTS.explorationPlan),
        exploration: readArtifact<ExplorationRecord>(r.dir, ARTIFACTS.exploration),
        generationPlan: readArtifact<GenerationPlan>(r.dir, ARTIFACTS.generationPlan),
        generation: readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest),
        reviewPlan: readArtifact<ReviewPlan>(r.dir, ARTIFACTS.reviewPlan),
        reviewReport: readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport),
        analysis: artifactWithSource<FailureAnalysis>(r, ARTIFACTS.failureAnalysis).value,
        attemptsByTest: r.manifest.healing.attemptsByTest, maxAttempts: r.manifest.healing.maxAttemptsPerTest,
        inputTables: readArtifact<{ tables?: PlannerInput['inputTables'] }>(r.dir, ARTIFACTS.inputValidation)?.tables ?? null,
      };
      const { decision, briefs } = planAgentStage(input);
      const truncated: string[] = [];
      for (const b of briefs) {
        const bounded = boundBrief(b);
        if (bounded.truncated) truncated.push(b.name);
        writeInRun(r, `${ARTIFACTS.briefsDir}/${b.name}.json`, bounded.brief.content);
      }
      recordDecision(r.dir, decision);
      return ok({ ok: true, ...decision, truncatedBriefs: truncated });
    }

    // The orchestrator reports each agent call it makes (and the tokens, only when it knows them).
    case 'agents record': {
      const r = run(root, rest[0]);
      const stage = need(rest[1], 'stage');
      if (!isStageName(stage)) throw new UsageError(`unknown stage ${JSON.stringify(stage)}`);
      // The plugin's agents are also addressed as "builder:<name>"; both spellings name the same agent.
      const agent = need(v.agent, '--agent').replace(/^builder:/, '');
      const expected = AGENT_BY_STAGE[stage];
      if (!expected) throw new UsageError(`stage ${stage} has no agent`);
      if (agent !== expected) throw new UsageError(`stage ${stage} is handled by ${expected}, not ${agent}`);
      const tokens = (x: string | undefined): number | null => {
        if (x === undefined) return null;
        if (!/^\d+$/.test(x)) throw new UsageError('token counts must be non-negative integers');
        return Number(x);
      };
      const inv = recordInvocation(r.dir, { stage, agent, inputTokens: tokens(v['input-tokens']), outputTokens: tokens(v['output-tokens']), brief: v.file ?? null });
      return ok({ ok: true, recorded: inv });
    }

    case 'agents show': {
      const r = run(root, rest[0]);
      const usage = readAgentUsage(r.dir);
      return ok({ ok: true, ...summarizeUsage(usage), decisions: usage.decisions });
    }

    case 'cache status': {
      const r = run(root, rest[0]);
      const ledger = readLedger(r.dir);
      // Hits are counted; only the rebuilds are listed with their reasons.
      return ok({ ok: true, ...summarizeLedger(ledger), rebuilt: ledger.decisions.filter((d) => d.action === 'rebuild').map(({ at: _at, ...d }) => d) });
    }

    // Look at one cached artifact without using it: its inputs, versions and recorded validation.
    case 'cache inspect': {
      const kind = need(rest[0], 'kind');
      const name = need(rest[1], 'name');
      if (!(CACHE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`kind must be one of ${CACHE_KINDS.join(', ')}`);
      const read = readEntry(root, kind as (typeof CACHE_KINDS)[number], name);
      if (read.status !== 'ok') return ok({ ok: true, ...read });
      const { payload: _payload, ...meta } = read.entry;
      return ok({ ok: true, status: 'ok', entry: meta });
    }

    // What the test ledger says each test case needs this run, before any stage runs. A preview built from the same deciders the
    // stages use (nothing is reused because of it); it tells the orchestrator how much exploration, generation and review is ahead.
    case 'ledger plan': {
      const r = run(root, rest[0]);
      const { specs, issues } = validatedSpecs(r);
      if (!specs) return notReady({ ok: false, issues });
      const config = configOf(r);
      const baseUrl = config.app.baseUrl;
      const plan = previewReuse({ rootDir: root, specs, config, baseUrl, store: loadStore(root, baseUrl), ledger: loadLedger(root, baseUrl), now: new Date().toISOString() });
      writeInRun(r, ARTIFACTS.ledgerPlan, plan);
      const MAX_LISTED = 40;
      const work = plan.tests.filter((t) => t.verdict !== 'unchanged');
      return ok({
        ok: true, artifact: ARTIFACTS.ledgerPlan, ledger: plan.ledger, summary: plan.summary, work: plan.work, causes: plan.causes,
        unchanged: plan.tests.filter((t) => t.verdict === 'unchanged').map((t) => t.testId),
        needWork: work.slice(0, MAX_LISTED).map((t) => ({
          testId: t.testId, verdict: t.verdict, why: t.why, builtWith: t.builtWith?.pluginVersion ?? null, lastOutcome: t.lastExecution?.outcome ?? null,
        })),
        omitted: Math.max(0, work.length - MAX_LISTED),
      });
    }

    case 'ledger update': {
      const r = run(root, rest[0]);
      return ok({ ok: true, ...recordLedger(r) });
    }

    // The ledger as it stands: every automated test with where its evidence, test file and last execution are.
    case 'ledger show': {
      const baseUrl = rest[0] ? configOf(run(root, rest[0])).app.baseUrl : savedConfig(root)?.app.baseUrl;
      if (!baseUrl) throw new UsageError('ledger show <runId> (or save the configuration first)');
      const state = loadLedger(root, baseUrl);
      if (state.status !== 'ok') return ok({ ok: true, status: state.status, reason: state.reason });
      const l = state.ledger;
      const one = v['test-id']?.[0];
      if (one) {
        const t = l.tests[one];
        return t ? ok({ ok: true, test: t }) : notReady({ ok: false, issues: [`${one} is not in the ledger`] });
      }
      const MAX_LISTED = 100;
      const all = Object.values(l.tests).sort((a, b) => a.testId.localeCompare(b.testId, undefined, { numeric: true }));
      return ok({
        ok: true, status: 'ok', origin: l.origin, updatedAt: l.updatedAt, engine: l.engine, tests: all.length,
        listed: all.slice(0, MAX_LISTED).map((t) => ({
          testId: t.testId, title: t.title, module: t.module, file: t.generated?.file ?? null, explored: t.exploration?.runId ?? null,
          pages: t.exploration?.pages.length ?? 0, sealed: t.generated?.runId ?? null, built: t.generated?.pluginVersion ?? null,
          lastOutcome: t.lastExecution?.outcome ?? null, lastRun: t.lastExecution?.runId ?? null, lastPassedRun: t.lastPassed?.runId ?? null,
        })),
        omitted: Math.max(0, all.length - MAX_LISTED),
        pages: pageIndex(l),
      });
    }

    default:
      throw new UsageError(`unknown command: ${group} ${action ?? ''}`.trim());
  }
}

function brief(f: FailureAnalysis['failures'][number]) {
  return { key: f.key, testId: f.testId, file: f.file, line: f.line, category: f.category, confidence: f.confidence, signals: f.signals, healingEligible: f.healingEligible, classifiedBy: f.classifiedBy, errorExcerpt: f.errorExcerpt.split('\n').slice(0, 6).join('\n'), evidence: f.evidence };
}

function loadAnalysis(r: RunCtx): FailureAnalysis {
  const a = readArtifact<FailureAnalysis>(r.dir, ARTIFACTS.failureAnalysis);
  if (!a) throw new Error(`no ${ARTIFACTS.failureAnalysis} in run ${r.runId}; run "triage run" first`);
  const issues = validateFailureAnalysis(a);
  if (issues.length) throw new Error(`${ARTIFACTS.failureAnalysis} is invalid: ${issues.join('; ')}`);
  return a;
}

// ---- review ----

function loadReview(r: RunCtx): ReviewReport {
  const existing = readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport);
  if (!existing) throw new Error(`no ${ARTIFACTS.reviewReport}; run "review static" first`);
  return existing;
}

// Page objects the generator added or changed (manifest.sharedFilesChanged). Reviewed with the line-level rules only.
function supportFiles(r: RunCtx): string[] {
  const g = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
  const files = (g?.sharedFilesChanged ?? []).map((f) => String(f).replace(/\\/g, '/'));
  // Page objects, and the login setup (it is reviewed as support code: it holds no tests).
  const setup = AUTH_SETUP_DIR_FILE;
  const found = existsSync(path.join(r.root, 'auth'))
    ? readdirSync(path.join(r.root, 'auth')).map((n) => `auth/${n}`).filter((f) => setup.test(f))
    : [];
  return [...new Set([...files, ...found])]
    .filter((f) => (f.startsWith(`${PAGE_OBJECTS_DIR}/`) || setup.test(f)) && /\.(?:ts|js)$/.test(f) && !isAbsoluteOrEscaping(f) && existsSync(path.join(r.root, f)))
    .sort();
}

const AUTH_SETUP_DIR_FILE = /^auth\/[^/]+\.setup\.(?:ts|js)$/;

// The dependency chains of each generated file, from the specs and where the generator put each test.
function chainsByFile(r: RunCtx): Map<string, ChainSpec[]> {
  const out = new Map<string, ChainSpec[]>();
  const { specs } = validatedSpecs(r);
  const g = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
  if (!specs || !g) return out;
  const fileOf = new Map(g.tests.map((t) => [t.testId, t.file]));
  for (const plan of planModules(specs, configOf(r).language, r.root)) {
    for (const chain of plan.chains) {
      const file = fileOf.get(chain.ids[0]!);
      if (file) out.set(file, [...(out.get(file) ?? []), chain]);
    }
  }
  return out;
}

function generatedFiles(r: RunCtx): string[] {
  const g = readArtifact<GenerationManifest>(r.dir, ARTIFACTS.generationManifest);
  if (!g) throw new Error(`no ${ARTIFACTS.generationManifest}; generation has not produced a manifest`);
  return [...new Set(g.tests.map((t) => t.file))].sort();
}

export function typecheckGenerated(root: string, language: AutomationConfig['language'], files: string[]): ReviewReport['typecheck'] {
  if (language === 'javascript') {
    const failures = files
      .map((f) => ({ f, r: spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' }) }))
      .filter(({ r }) => r.status !== 0);
    return { ran: true, ok: failures.length === 0, output: failures.map(({ f, r }) => `${f}: ${r.stderr}`).join('\n') || null };
  }
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) return { ran: false, ok: null, output: 'typescript is not installed' };
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ran: true, ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 8000) || null };
}

// The project type check is the slow part of a review. A passing result is reused while nothing it reads has changed.
function cachedTypecheck(r: RunCtx, files: string[], useCache: boolean): ReviewReport['typecheck'] {
  const language = configOf(r).language;
  if (language === 'javascript') return typecheckGenerated(r.root, language, files); // a per-file syntax check is cheap
  const key = typecheckKey(r.root);
  const decision: CacheDecision = useCache
    ? decide(r.root, 'typecheck', 'framework', key)
    : { kind: 'typecheck', name: 'framework', action: 'rebuild', reason: 'the artifact cache was bypassed (--no-cache)', changed: [] };
  recordDecisions(r.dir, [decision]);
  if (decision.action === 'reuse') return { ran: true, ok: true, output: null, cached: true };
  const result = typecheckGenerated(r.root, language, files);
  // Keyed by the files as they were before the check ran, and only a pass is ever kept.
  if (result.ran && result.ok === true) writeEntry(r.root, { kind: 'typecheck', name: 'framework', ...key, payload: { ok: true, files: files.length }, by: 'review static', runId: r.runId });
  return result;
}

function reviewStatic(r: RunCtx, useCache: boolean): Result {
  const testFiles = generatedFiles(r);
  const support = supportFiles(r);
  const files = [...testFiles, ...support];
  const fresh = reviewFiles(r.root, testFiles, support, chainsByFile(r));
  // Saved login state needs the setup that creates (and re-checks) it.
  if (configOf(r).auth.approach === 'storage-state' && !support.some((f) => AUTH_SETUP_DIR_FILE.test(f))) {
    fresh.push({
      id: 'S000-auth', severity: 'critical', file: 'auth/', line: null, rule: 'auth-setup-missing', status: 'open', source: 'static',
      message: 'auth.approach is "storage-state" but there is no auth/*.setup file that signs in and saves the session; the tests would start without a login',
    });
  }
  const prev = readArtifact<ReviewReport>(r.dir, ARTIFACTS.reviewReport);
  const freshKeys = new Set(fresh.map(findingKey));
  // Static findings from an earlier pass that no longer reproduce are marked fixed (kept for the audit trail).
  const carried = (prev?.findings ?? []).flatMap((f): ReviewFinding[] => {
    if (f.source === 'reviewer') return [f];
    return freshKeys.has(findingKey(f)) || f.status === 'fixed' ? [] : [{ ...f, status: 'fixed' }];
  });
  const prevFixed = (prev?.findings ?? []).filter((f) => f.source === 'static' && f.status === 'fixed');
  const report: ReviewReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    reviewedAt: new Date().toISOString(),
    files,
    typecheck: cachedTypecheck(r, files, useCache),
    findings: [...fresh, ...carried, ...prevFixed],
  };
  return saveReview(r, report);
}

function findingKey(f: ReviewFinding): string {
  return `${f.file}:${f.line}:${f.rule}`;
}

function saveReview(r: RunCtx, report: ReviewReport): Result {
  writeJsonAtomic(path.join(r.dir, ARTIFACTS.reviewReport), report);
  writeFileSync(path.join(r.dir, ARTIFACTS.reviewSummary), renderReview(report));
  const blocking = report.findings.filter((f) => f.severity === 'critical' && f.status !== 'fixed');
  const typecheckOk = report.typecheck.ran && report.typecheck.ok === true;
  const value = {
    ok: blocking.length === 0 && typecheckOk,
    artifacts: [ARTIFACTS.reviewReport, ARTIFACTS.reviewSummary],
    typecheck: report.typecheck,
    open: report.findings.filter((f) => f.status === 'open').map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, rule: f.rule, message: f.message })),
  };
  return { value, code: value.ok ? 0 : 2 };
}

function renderReview(r: ReviewReport): string {
  const lines = [`# Script review`, '', `Reviewed ${r.reviewedAt}: ${r.files.join(', ')}`, '', `Typecheck: ${r.typecheck.ran ? (r.typecheck.ok ? 'passed' : 'FAILED') : 'not run'}`, ''];
  if (r.typecheck.ok === false && r.typecheck.output) lines.push('```', r.typecheck.output, '```', '');
  lines.push('| ID | Severity | Status | Location | Rule | Message |', '|---|---|---|---|---|---|');
  for (const f of r.findings) lines.push(`| ${f.id} | ${f.severity} | ${f.status} | ${f.file}:${f.line ?? '-'} | ${f.rule} | ${f.message.replace(/\|/g, '\\|')} |`);
  return lines.join('\n') + '\n';
}

// Generation reuse and parallel generation batches.
//
// `planGeneration` decides per ready test case whether the generated test from an earlier run can stand (its test case, its
// application evidence, the plugin's generator rules and everything the test imports are unchanged, and the test in the file is
// byte-for-byte what was reviewed) or must be generated again. Only tests that must be generated go to the generator agent,
// grouped into one batch per module file, so batches own disjoint files and can run in parallel without overwriting each other.
// `mergeGeneration` folds the batch manifests and the reused tests into the single generation-manifest.json.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping, type AutomationConfig } from '../config/schema.ts';
import { readJson } from '../utils/fs.ts';
import {
  FRAMEWORK_FILES, decide, fingerprintFiles, hashText, hashValue, normalizeSource, readEntry, rulesVersion, type CacheDecision,
} from './artifact-cache.ts';
import { ARTIFACTS } from './artifact-manager.ts';
import type { ExplorationRecord } from './exploration.ts';
import { moduleOf } from './exploration-reuse.ts';
import { pageKey, specFingerprint } from './exploration-store.ts';
import {
  GENERATION_SCHEMA_VERSION, TESTS_DIR, isPipelineOwned, specFileExtension, validateGenerationManifest, type GenerationManifest,
} from './generation.ts';
import { planModules } from './modules.ts';
import { testBlocks } from './static-review.ts';
import type { TestSpec, TestSpecDocument } from './test-spec.ts';

export const GENERATION_PLAN_SCHEMA_VERSION = 1;

// What is stored for a generated test in the cache: where it lives and the hash of its own source block.
export interface GeneratedTestPayload {
  testId: string;
  file: string; // relative to automation/
  title: string;
  testSha256: string;
}

export interface PlanEntry {
  testId: string;
  module: string;
  action: 'generate' | 'reuse';
  reason: string;
  changed: string[];
  file: string | null; // where the reused test lives
  // A test that must be rebuilt but whose earlier version is still in its file: the generator edits that test instead of writing it
  // from nothing (what changed is in `reason`). Absent for a new test, a test case that changed, and a forced regeneration.
  previous?: string;
}

export interface GenerationBatch {
  batchId: string;
  modules: string[];
  testIds: string[];
  targetFile: string; // the only test file this batch may write (the module's file from "specs modules")
  manifest: string; // run-relative path where the batch's agent writes its manifest
}

export interface GenerationPlan {
  schemaVersion: typeof GENERATION_PLAN_SCHEMA_VERSION;
  generatedAt: string;
  language: AutomationConfig['language'];
  specs: PlanEntry[];
  batches: GenerationBatch[];
  summary: { generate: number; reuse: number };
}

// ---- hashing what a generated test depends on ----

// The observed evidence a test case's generated test relied on: its steps, the page each ran on and, for every locator a step
// names, what was observed for it. Run-local page ids, free-text narrative, the way pages were split and elements other test
// cases recorded on the same page are left out, so two explorations of the same thing hash the same. (Generators use only
// the locators their test case's steps list; see the playwright-generator agent.)
export function explorationEvidenceHash(record: ExplorationRecord | null, testId: string): string {
  if (!record) return 'no-exploration';
  const entry = record.specs.find((s) => s.testId === testId);
  if (!entry) return 'no-entry';
  const byId = new Map(record.pages.map((p) => [p.id, p]));
  const keyOf = (id: string | null): string | null => {
    const p = id === null ? undefined : byId.get(id);
    return p ? pageKey(p.url, record.baseUrl) ?? p.url : null;
  };
  return hashValue({
    status: entry.status,
    steps: entry.steps.map((s) => ({
      index: s.index,
      page: keyOf(s.pageId),
      locators: [...s.locators].sort().map((loc) => {
        const e = s.pageId === null ? undefined : byId.get(s.pageId)?.elements.find((x) => x.candidateLocator === loc);
        return [loc, e?.role ?? null, e?.name ?? null, e?.testId ?? null, e?.confidence ?? null].join('|');
      }),
    })),
  });
}

export function ruleVersions(rootDir: string): { generatorRules: string; framework: string } {
  return { generatorRules: rulesVersion(rootDir, 'generator'), framework: fingerprintFiles(rootDir, FRAMEWORK_FILES) };
}

// ---- what a test imports ----

const IMPORT_CLAUSE = /\b(?:import|export)\s+([\s\S]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const LOCAL_SPECIFIERS = ['', '.ts', '.js', '/index.ts', '/index.js'];

// The names an import clause binds: `{ a, b as c }` -> a, c; `X, { a }` -> X, a; `* as ns` -> ns. Type-only names are kept (harmless).
function boundNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([\s\S]*?)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const t = part.replace(/^\s*type\s+/, '').trim();
      if (t) names.push(t.split(/\s+as\s+/).pop()!.trim());
    }
  }
  const rest = clause.replace(/\{[\s\S]*?\}/, '');
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (ns) names.push(ns[1]!);
  const def = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, ''));
  if (def) names.push(def[1]!);
  return names;
}

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

function resolveLocal(rootDir: string, fromFile: string, spec: string): string | null {
  const base = path.resolve(rootDir, path.dirname(fromFile), spec);
  for (const suffix of LOCAL_SPECIFIERS) {
    const candidate = `${base}${suffix}`;
    const rel = path.relative(rootDir, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // engine code is covered by the plugin version
    if (isFile(candidate) && /\.(?:ts|js)$/.test(candidate)) return rel.split(path.sep).join('/');
  }
  return null;
}

// Hash of the framework files one test actually uses: the files its block names through its imports (fixtures, page objects,
// helpers), and everything those import in turn. A change to an unrelated page object or to another module's helper does not
// touch it. 'no-file' when the test is not found, which never matches a recorded hash.
export function testDependencyHash(rootDir: string, file: string, testId: string): string {
  if (isAbsoluteOrEscaping(file) || !existsSync(path.join(rootDir, file))) return 'no-file';
  const source = readFileSync(path.join(rootDir, file), 'utf8');
  const block = testBlocks(source).find((b) => b.testId === testId);
  if (!block) return 'no-file';

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (rel: string | null) => {
    if (rel && !seen.has(rel) && seen.size < 200) { seen.add(rel); queue.push(rel); }
  };
  for (const m of source.matchAll(IMPORT_CLAUSE)) {
    if (boundNames(m[1]!).some((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(block.text))) enqueue(resolveLocal(rootDir, file, m[2]!));
  }
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    for (const m of readFileSync(path.join(rootDir, rel), 'utf8').matchAll(IMPORT_CLAUSE)) enqueue(resolveLocal(rootDir, rel, m[2]!));
  }
  const h = [...seen].sort().map((rel) => `${rel}\0${normalizeSource(readFileSync(path.join(rootDir, rel), 'utf8'))}`);
  return hashText(h.join('\n\0\n'));
}

export function generationInputs(spec: TestSpec, record: ExplorationRecord | null, config: AutomationConfig, deps: string): Record<string, string> {
  return {
    spec: specFingerprint(spec), evidence: explorationEvidenceHash(record, spec.id), language: config.language, authApproach: config.auth.approach, deps,
    // Which file the test lives in follows its chain, so moving into or out of a cross-module chain regenerates it.
    ...(spec.layout ? { layout: spec.layout.moduleSlug } : {}),
  };
}

// Hash of one test's source block inside a file; null when the file or the test is not there.
export function testBlockHash(rootDir: string, file: string, testId: string): string | null {
  if (isAbsoluteOrEscaping(file) || !existsSync(path.join(rootDir, file))) return null;
  const block = testBlocks(readFileSync(path.join(rootDir, file), 'utf8')).find((b) => b.testId === testId);
  return block ? hashText(normalizeSource(block.text)) : null;
}

export function asPayload(v: unknown): GeneratedTestPayload | null {
  const p = v as Partial<GeneratedTestPayload> | null;
  return p && typeof p.testId === 'string' && typeof p.file === 'string' && typeof p.title === 'string' && typeof p.testSha256 === 'string' ? (p as GeneratedTestPayload) : null;
}

// The cached test must still be in a pipeline-owned test file, exactly as it was when it was reviewed.
export function checkGeneratedPayload(rootDir: string, testId: string, language: AutomationConfig['language']) {
  return (raw: unknown): string[] => {
    const p = asPayload(raw);
    if (!p || p.testId !== testId) return ['cached record is malformed'];
    if (!p.file.startsWith(`${TESTS_DIR}/`) || !p.file.endsWith(specFileExtension(language))) return [`${p.file} is not a ${language} test file under ${TESTS_DIR}/`];
    if (!existsSync(path.join(rootDir, p.file))) return [`${p.file} no longer exists`];
    if (!isPipelineOwned(readFileSync(path.join(rootDir, p.file), 'utf8'))) return [`${p.file} is no longer owned by the pipeline (its generated header was removed)`];
    const now = testBlockHash(rootDir, p.file, testId);
    if (now === null) return [`${testId} is no longer in ${p.file}`];
    return now === p.testSha256 ? [] : [`${testId} in ${p.file} was modified since it was reviewed`];
  };
}

// ---- plan ----

export interface PlanInput {
  rootDir: string; // automation/
  specs: TestSpecDocument;
  record: ExplorationRecord | null;
  config: AutomationConfig;
  force?: boolean;
  useCache?: boolean;
  now?: Date;
}

// Reuse or rebuild for one test case's generated test, with the reason.
export function decideGeneration(
  i: { rootDir: string; config: AutomationConfig; force?: boolean; useCache?: boolean }, spec: TestSpec, record: ExplorationRecord | null,
  versions = ruleVersions(i.rootDir),
): CacheDecision {
  const prior = readEntry(i.rootDir, 'generation', spec.id);
  const priorFile = prior.status === 'ok' ? asPayload(prior.entry.payload)?.file ?? null : null;
  const inputs = generationInputs(spec, record, i.config, priorFile ? testDependencyHash(i.rootDir, priorFile, spec.id) : 'no-file');
  const check = checkGeneratedPayload(i.rootDir, spec.id, i.config.language);
  // The cached test is gone from its file: say that, rather than reporting its (now unreadable) imports as changed.
  const gone = prior.status === 'ok' && inputs.deps === 'no-file' ? check(prior.entry.payload) : [];
  return i.force || i.useCache === false
    ? { kind: 'generation', name: spec.id, action: 'rebuild', reason: i.force ? 'regeneration was requested' : 'the artifact cache is disabled', changed: [] }
    : gone.length > 0
      ? { kind: 'generation', name: spec.id, action: 'rebuild', reason: `cached artifact no longer valid: ${gone.join('; ')}`, changed: [] }
      : decide(i.rootDir, 'generation', spec.id, { inputs, versions }, check);
}

// For the exploration planner: why this test case's generated test would be reused as it stands if the saved evidence were
// handed over unchanged (null when it would be regenerated, so the evidence has to be looked at again).
export function generationStillCurrent(
  i: { rootDir: string; config: AutomationConfig }, spec: TestSpec, record: ExplorationRecord, versions = ruleVersions(i.rootDir),
): string | null {
  const d = decideGeneration(i, spec, record, versions);
  const file = d.action === 'reuse' && d.entry ? asPayload(d.entry.payload)?.file : null;
  return file ? `the generated test in ${file} is unchanged and still valid; this run's execution re-checks its locators` : null;
}

// The earlier version of a test that is being rebuilt only because the engine around it changed (rules, framework, a file it imports,
// its evidence format) - not because its test case changed, which makes the old steps wrong.
function previousTestFile(rootDir: string, spec: TestSpec, d: CacheDecision): string | null {
  if (d.changed.length === 0 || d.changed.includes('inputs.spec')) return null;
  const prior = readEntry(rootDir, 'generation', spec.id);
  const payload = prior.status === 'ok' ? asPayload(prior.entry.payload) : null;
  return payload && testBlockHash(rootDir, payload.file, spec.id) !== null ? payload.file : null;
}

export function planGeneration(i: PlanInput): { plan: GenerationPlan; decisions: CacheDecision[] } {
  const versions = ruleVersions(i.rootDir);
  const decisions: CacheDecision[] = [];
  const entries: PlanEntry[] = i.specs.specs.filter((s) => s.status === 'ready').map((spec) => {
    const d = decideGeneration(i, spec, i.record, versions);
    decisions.push(d);
    const payload = d.entry ? asPayload(d.entry.payload) : null;
    const previous = d.action === 'rebuild' && !i.force && i.useCache !== false ? previousTestFile(i.rootDir, spec, d) : null;
    return {
      testId: spec.id, module: moduleOf(spec), action: d.action === 'reuse' ? 'reuse' : 'generate', reason: d.reason, changed: d.changed, file: payload?.file ?? null,
      ...(previous ? { previous } : {}),
    };
  });
  const plan: GenerationPlan = {
    schemaVersion: GENERATION_PLAN_SCHEMA_VERSION,
    generatedAt: (i.now ?? new Date()).toISOString(),
    language: i.config.language,
    specs: entries,
    batches: buildBatches(entries, i.specs, i.config.language, i.rootDir),
    summary: { generate: entries.filter((e) => e.action === 'generate').length, reuse: entries.filter((e) => e.action === 'reuse').length },
  };
  return { plan, decisions };
}

// One batch per module that has tests to generate. Its target is the module's one test file (`specs modules` decides the
// name, and never reuses a handwritten file), so two batches can never write the same file.
export function buildBatches(entries: PlanEntry[], specs: TestSpecDocument, language: AutomationConfig['language'], rootDir: string): GenerationBatch[] {
  const fileOf = new Map(planModules(specs, language, rootDir).map((m) => [m.module, m.file]));
  const byModule = new Map<string, string[]>();
  for (const e of entries) if (e.action === 'generate') byModule.set(e.module, [...(byModule.get(e.module) ?? []), e.testId]);
  return [...byModule]
    .map(([module, testIds]) => ({ module, testIds, targetFile: fileOf.get(module) ?? `${TESTS_DIR}/${module}${specFileExtension(language)}` }))
    .sort((a, b) => a.targetFile.localeCompare(b.targetFile))
    .map((b, n) => {
      const batchId = `b${n + 1}`;
      return { batchId, modules: [b.module], testIds: b.testIds, targetFile: b.targetFile, manifest: `${ARTIFACTS.generationDir}/manifest-${batchId}.json` };
    });
}

// ---- merge ----

export interface MergeInput {
  rootDir: string;
  runDir: string;
  specs: TestSpecDocument;
  config: AutomationConfig;
  plan: GenerationPlan | null;
  now?: Date;
}

export type MergeResult =
  | { ok: true; manifest: GenerationManifest; issues: [] }
  | { ok: false; issues: string[]; manifest: null };

function readPartial(file: string): { manifest: Partial<GenerationManifest> | null; problem: string | null } {
  const r = readJson(file);
  if (!r.ok) return { manifest: null, problem: r.reason === 'not_found' ? null : r.message };
  const m = r.value as Partial<GenerationManifest> | null;
  if (typeof m !== 'object' || m === null || !Array.isArray(m.tests)) return { manifest: null, problem: `${path.basename(file)} must be a generation manifest with a tests array` };
  return { manifest: m, problem: null };
}

type TestEntry = GenerationManifest['tests'][number];

export function mergeGeneration(i: MergeInput): MergeResult {
  const issues: string[] = [];
  const tests = new Map<string, TestEntry>();
  const excluded = new Map<string, { testId: string; reason: string }>();
  const shared = new Set<string>();

  const base = readPartial(path.join(i.runDir, ARTIFACTS.generationManifest));
  if (base.problem) issues.push(base.problem);
  for (const t of base.manifest?.tests ?? []) tests.set(t.testId, t);
  for (const e of base.manifest?.excluded ?? []) excluded.set(e.testId, e);
  for (const f of base.manifest?.sharedFilesChanged ?? []) shared.add(f);

  // Batch manifests: each belongs to one batch and must stay inside what the plan gave it.
  const dir = path.join(i.runDir, ARTIFACTS.generationDir);
  const batchFiles = existsSync(dir) ? readdirSync(dir).filter((f) => /^manifest-[\w-]+\.json$/.test(f)).sort() : [];
  const claimedBy = new Map<string, string>(); // testId or file -> batch
  const sharedBy = new Map<string, string>();
  for (const f of batchFiles) {
    const batchId = f.replace(/^manifest-|\.json$/g, '');
    const part = readPartial(path.join(dir, f));
    if (part.problem) { issues.push(part.problem); continue; }
    const batch = i.plan?.batches.find((b) => b.batchId === batchId);
    if (i.plan && !batch) { issues.push(`${f}: the plan has no batch "${batchId}"`); continue; }
    for (const t of part.manifest!.tests ?? []) {
      const prev = claimedBy.get(`test:${t.testId}`);
      if (prev && prev !== batchId) issues.push(`${t.testId} was generated by both batch ${prev} and batch ${batchId}`);
      claimedBy.set(`test:${t.testId}`, batchId);
      const fileOwner = claimedBy.get(`file:${t.file}`);
      if (fileOwner && fileOwner !== batchId) issues.push(`${t.file} was written by both batch ${fileOwner} and batch ${batchId}; rerun these batches one after another`);
      claimedBy.set(`file:${t.file}`, batchId);
      if (batch && !batch.testIds.includes(t.testId)) issues.push(`batch ${batchId} generated ${t.testId}, which is not in its plan`);
      if (batch && t.file !== batch.targetFile) issues.push(`batch ${batchId} wrote ${t.file} but owns only ${batch.targetFile}`);
      tests.set(t.testId, t);
      excluded.delete(t.testId);
    }
    for (const e of part.manifest!.excluded ?? []) if (!tests.has(e.testId)) excluded.set(e.testId, e);
    for (const sf of part.manifest!.sharedFilesChanged ?? []) {
      const prev = sharedBy.get(sf);
      if (prev && prev !== batchId) issues.push(`shared file ${sf} was changed by both batch ${prev} and batch ${batchId}; rerun these batches one after another`);
      sharedBy.set(sf, batchId);
      shared.add(sf);
    }
  }

  // Reused tests: only entries the plan marked reusable and that are not regenerated now.
  const reused: string[] = [];
  for (const p of i.plan?.specs ?? []) {
    if (p.action !== 'reuse' || tests.has(p.testId) || !p.file) continue;
    const block = testBlockHash(i.rootDir, p.file, p.testId);
    if (block === null) { issues.push(`${p.testId}: reused test is missing from ${p.file}`); continue; }
    const title = testBlocks(readFileSync(path.join(i.rootDir, p.file), 'utf8')).find((b) => b.testId === p.testId)!.title;
    tests.set(p.testId, { testId: p.testId, file: p.file, title });
    excluded.delete(p.testId);
    reused.push(p.testId);
  }
  if (issues.length > 0) return { ok: false, issues, manifest: null };

  const order = new Map(i.specs.specs.map((s, n) => [s.id, n]));
  const manifest: GenerationManifest = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generatedAt: (i.now ?? new Date()).toISOString(),
    language: i.config.language,
    tests: [...tests.values()].sort((a, b) => (order.get(a.testId) ?? 1e9) - (order.get(b.testId) ?? 1e9)),
    excluded: [...excluded.values()],
    sharedFilesChanged: [...shared].sort(),
    reuse: { generatedTests: [...tests.keys()].filter((id) => !reused.includes(id)), reusedTests: reused },
  };
  const invalid = validateGenerationManifest(manifest, { rootDir: i.rootDir, specs: i.specs });
  return invalid.length > 0 ? { ok: false, issues: invalid, manifest: null } : { ok: true, manifest, issues: [] };
}

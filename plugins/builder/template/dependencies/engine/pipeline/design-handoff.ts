// The hand-over from test design to test automation.
//
// The test-design stages (story analysis, coverage design, test-case generation; plugin `test-design/`) write one validated
// Markdown file per user story under <project>/test-design/test-cases/ and keep their own checkpoint in
// <project>/test-design/state/. This module is the only thing that reads that state from the engine. It:
//   1. checks that the design output is there and unchanged since the design run recorded it (hashes, ids, traceability),
//   2. parses the chosen stories' cases with the pipeline's own parser and assesses automation readiness,
//   3. imports the cases that can be automated into dependencies/input/test-cases/design/ (cases that need a person are listed
//      with the reason and are not imported; the pipeline never receives them),
//   4. records everything in dependencies/state/design-handoff.json, which a run snapshots, so the story → criterion → scenario →
//      test case link survives for the traceability report.
// Nothing here edits a design file, and nothing publishes anything.

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readEnvValues, referencedEnvVars, syncEnvFiles, type EnvSyncReport } from './env-file.ts';
import { importInput } from './input-import.ts';
import { loadMappings } from './input-table.ts';
import { assessReadiness, type CaseReadiness, type ReadinessReason, type ReadinessReport, type Verdict } from './readiness.ts';
import { parseInputs } from './test-case-parser.ts';
import { readJson, sha256File, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { inputBaseDir, stateDir } from '../utils/layout.ts';

export const HANDOFF_SCHEMA_VERSION = 1;
export const DESIGN_DIRNAME = 'test-design';
export const HANDOFF_FILE = 'design-handoff.json'; // in dependencies/state/, and (a snapshot) in a run directory
export const HANDOFF_IMPORT_DIR = 'input/test-cases/design'; // relative to dependencies/

export interface CriterionRef {
  label: string; // AC-1, BR-1, NFR-1
  kind: 'acceptance_criterion' | 'business_rule' | 'non_functional';
  text: string | null; // null when the story analysis is not available
}

export interface HandoffStory {
  title: string | null;
  designFile: string; // relative to the project folder
  designFileSha256: string;
  sourceFile: string | null;
  sourceSha256: string | null; // the story fingerprint the cases were generated from
  editedSinceSave: boolean; // the design file differs from what the design run recorded: a person edited it
  criteria: CriterionRef[];
  caseIds: string[];
}

export interface HandoffCase {
  title: string;
  module: string;
  storyIds: string[];
  covers: string[]; // "<storyId>#<label>"
  techniques: string[];
  scenarioKey: string | null;
  designFile: string;
  verdict: Verdict;
  reasons: ReadinessReason[];
  importedFile: string | null; // relative to dependencies/; null for a case that is not handed over
  importedSha256: string | null;
}

export interface HandoffDocument {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  createdAt: string;
  designRunId: string;
  designRunStatus: string;
  inputPath: string; // relative to dependencies/; the folder to use as the run's test-case path
  stories: Record<string, HandoffStory>;
  cases: Record<string, HandoffCase>;
  readiness: ReadinessReport;
  warnings: string[];
}

export interface HandoffOptions {
  stories?: string[]; // story IDs to hand over; default: every saved story
  overrideManual?: string[]; // case IDs to automate although they were flagged as manual
  apply?: boolean; // false = plan only, nothing is written
  now?: Date;
}

export interface HandoffResult {
  ok: boolean;
  applied: boolean;
  issues: string[];
  warnings: string[];
  designRunId: string | null;
  stories: string[];
  notHandedOver: { story: string; reason: string }[];
  readiness: ReadinessReport['summary'] | null;
  manual: { id: string; title: string; storyIds: string[]; reasons: ReadinessReason[] }[];
  blocked: { id: string; title: string; reasons: ReadinessReason[] }[];
  imported: { created: string[]; updated: string[]; unchanged: string[]; removed: string[] };
  missingEnvVars: string[];
  env: EnvSyncReport | null;
  inputPath: string;
  handoffFile: string | null;
}

// ---- locations ----

export const projectDirOf = (rootDir: string): string => path.dirname(rootDir);
export const designDirOf = (rootDir: string): string => path.join(projectDirOf(rootDir), DESIGN_DIRNAME);
export const handoffPathOf = (rootDir: string): string => path.join(stateDir(rootDir), HANDOFF_FILE);

// ---- reading the design state ----

interface WorkflowStory {
  status?: string;
  sourceFile?: string;
  testCaseFile?: { path?: string; sha256?: string; caseCount?: number; sourceSha256?: string };
  testCaseIds?: string[];
}
interface DesignWorkflow { runId?: string; status?: string; stories?: Record<string, WorkflowStory> }
interface DesignTraceability {
  stories?: Record<string, { sourceFile?: string; title?: string; criteria?: string[]; testCaseFile?: string }>;
  cases?: Record<string, { title?: string; module?: string | null; storyIds?: string[]; covers?: string[]; techniques?: string[]; scenarioKey?: string }>;
}

function readObject<T>(file: string, what: string, issues: string[]): T | null {
  const r = readJson(file);
  if (!r.ok) {
    issues.push(r.reason === 'not_found' ? `${what} is missing (${file}): run the test-design stages first` : r.message);
    return null;
  }
  if (typeof r.value !== 'object' || r.value === null || Array.isArray(r.value)) { issues.push(`${what} is not a JSON object`); return null; }
  return r.value as T;
}

const KIND_OF: Record<string, CriterionRef['kind']> = { AC: 'acceptance_criterion', BR: 'business_rule', NFR: 'non_functional' };

function criteriaOf(designDir: string, storyId: string, labels: string[]): CriterionRef[] {
  const analysis = readJson(path.join(designDir, 'state', 'analysis', `${storyId}.json`));
  const texts = new Map<string, string>();
  if (analysis.ok && typeof analysis.value === 'object' && analysis.value !== null) {
    const a = analysis.value as Record<string, unknown>;
    for (const key of ['acceptance_criteria_interpretation', 'business_rules', 'relevant_non_functional_expectations']) {
      const list = a[key];
      if (Array.isArray(list)) for (const e of list) {
        const x = e as { label?: unknown; text?: unknown };
        if (typeof x.label === 'string' && typeof x.text === 'string') texts.set(x.label, x.text);
      }
    }
  }
  const all = [...new Set([...labels, ...texts.keys()])];
  const order = (l: string) => ['AC', 'BR', 'NFR'].indexOf(l.split('-')[0]!);
  return all
    .sort((a, b) => order(a) - order(b) || Number(a.split('-')[1]) - Number(b.split('-')[1]))
    .map((label) => ({ label, kind: KIND_OF[label.split('-')[0]!] ?? 'acceptance_criterion', text: texts.get(label) ?? null }));
}

export function readHandoff(rootDir: string): { ok: true; doc: HandoffDocument } | { ok: false; issues: string[] } {
  const r = readJson(handoffPathOf(rootDir));
  if (!r.ok) return { ok: false, issues: [r.reason === 'not_found' ? 'there is no design handoff yet: run "design handoff --apply"' : r.message] };
  const issues = validateHandoffDocument(r.value);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, doc: r.value as HandoffDocument };
}

// ---- status ----

export interface DesignStatus {
  ok: boolean;
  designFolder: boolean;
  issues: string[];
  designRunId: string | null;
  designRunStatus: string | null;
  stories: { id: string; status: string; file: string | null; cases: number; fileExists: boolean; editedSinceSave: boolean; handedOver: boolean }[];
  handoff: { exists: boolean; current: boolean | null; issues: string[]; stories: string[] };
}

export function designStatus(rootDir: string): DesignStatus {
  const dir = designDirOf(rootDir);
  const issues: string[] = [];
  const out: DesignStatus = {
    ok: false, designFolder: existsSync(dir), issues, designRunId: null, designRunStatus: null, stories: [],
    handoff: { exists: false, current: null, issues: [], stories: [] },
  };
  if (!out.designFolder) { issues.push(`no ${DESIGN_DIRNAME}/ folder in the project: run /builder:generate-test-cases first`); return out; }
  const wf = readObject<DesignWorkflow>(path.join(dir, 'state', 'workflow.json'), 'the test-design checkpoint (state/workflow.json)', issues);
  if (!wf) return out;
  out.designRunId = wf.runId ?? null;
  out.designRunStatus = wf.status ?? null;
  const handed = readHandoff(rootDir);
  const handedStories = handed.ok ? new Set(Object.keys(handed.doc.stories)) : new Set<string>();
  for (const [id, s] of Object.entries(wf.stories ?? {})) {
    const rel = s.testCaseFile?.path ?? null;
    const abs = rel ? path.join(projectDirOf(rootDir), rel) : null;
    const recorded = s.testCaseFile?.sha256;
    const exists = abs !== null && existsSync(abs);
    out.stories.push({
      id, status: s.status ?? 'unknown', file: rel, cases: s.testCaseFile?.caseCount ?? s.testCaseIds?.length ?? 0, fileExists: exists,
      editedSinceSave: abs !== null && exists && recorded !== undefined && sha256File(abs) !== recorded, handedOver: handedStories.has(id),
    });
  }
  out.handoff.exists = handed.ok || existsSync(handoffPathOf(rootDir));
  if (handed.ok) {
    const check = handoffCurrentIssues(rootDir, handed.doc);
    out.handoff = { exists: true, current: check.length === 0, issues: check, stories: [...handedStories] };
  } else if (out.handoff.exists) {
    out.handoff.issues = handed.issues;
  }
  out.ok = true;
  return out;
}

// The handoff is only usable while what it recorded is still what is on disk.
export function handoffCurrentIssues(rootDir: string, doc: HandoffDocument): string[] {
  const issues: string[] = [];
  const project = projectDirOf(rootDir);
  const base = inputBaseDir(rootDir);
  for (const [id, s] of Object.entries(doc.stories)) {
    const abs = path.join(project, s.designFile);
    if (!existsSync(abs)) issues.push(`story ${id}: ${s.designFile} is gone`);
    else if (sha256File(abs) !== s.designFileSha256) issues.push(`story ${id}: ${s.designFile} changed after the handoff; hand it over again`);
  }
  for (const [id, c] of Object.entries(doc.cases)) {
    if (c.importedFile === null) continue;
    const abs = path.join(base, c.importedFile);
    if (!existsSync(abs)) issues.push(`test case ${id}: ${c.importedFile} is gone`);
    else if (sha256File(abs) !== c.importedSha256) issues.push(`test case ${id}: ${c.importedFile} was edited after the handoff`);
  }
  return issues;
}

// ---- the handoff ----

const STORY_OF_FILE = /^(.+)-testcase\.md$/;

export function handOver(rootDir: string, opts: HandoffOptions = {}): HandoffResult {
  const now = opts.now ?? new Date();
  const project = projectDirOf(rootDir);
  const designDir = designDirOf(rootDir);
  const base = inputBaseDir(rootDir);
  const issues: string[] = [];
  const warnings: string[] = [];
  const result: HandoffResult = {
    ok: false, applied: false, issues, warnings, designRunId: null, stories: [], notHandedOver: [], readiness: null, manual: [], blocked: [],
    imported: { created: [], updated: [], unchanged: [], removed: [] }, missingEnvVars: [], env: null, inputPath: HANDOFF_IMPORT_DIR, handoffFile: null,
  };

  if (!existsSync(designDir)) { issues.push(`no ${DESIGN_DIRNAME}/ folder in the project: run /builder:generate-test-cases first`); return result; }
  const wf = readObject<DesignWorkflow>(path.join(designDir, 'state', 'workflow.json'), 'the test-design checkpoint (state/workflow.json)', issues);
  const trace = readObject<DesignTraceability>(path.join(designDir, 'state', 'traceability.json'), 'the test-design traceability (state/traceability.json)', issues);
  if (!wf || !trace) return result;
  result.designRunId = wf.runId ?? null;

  // 1. Which stories, and are their files there?
  const saved = Object.entries(wf.stories ?? {}).filter(([, s]) => s.status === 'saved' && s.testCaseFile?.path);
  const wanted = opts.stories && opts.stories.length > 0 ? opts.stories : saved.map(([id]) => id);
  const known = new Set(Object.keys(wf.stories ?? {}));
  // With no explicit choice every saved story is handed over; say which stories were left out and why.
  const considered = opts.stories && opts.stories.length > 0 ? wanted : [...known];
  for (const id of considered) {
    if (!known.has(id)) { issues.push(`story ${id} is not part of the test-design run`); continue; }
    const s = wf.stories![id]!;
    if (s.status !== 'saved' || !s.testCaseFile?.path) result.notHandedOver.push({ story: id, reason: `its test design is "${s.status ?? 'unknown'}", not saved: finish it with /builder:generate-test-cases (it resumes)` });
  }
  const selected = wanted.filter((id) => saved.some(([sid]) => sid === id));
  if (selected.length === 0) issues.push(opts.stories?.length ? 'none of the chosen stories has saved test cases' : 'no story has saved test cases yet');
  if (issues.length > 0) return result;

  const files: { story: string; rel: string; abs: string }[] = [];
  const stories: Record<string, HandoffStory> = {};
  for (const id of selected) {
    const s = wf.stories![id]!;
    const rel = s.testCaseFile!.path!;
    const abs = path.join(project, rel);
    if (!existsSync(abs)) { issues.push(`story ${id}: ${rel} is missing although the design run saved it`); continue; }
    const sha = sha256File(abs);
    const edited = s.testCaseFile!.sha256 !== undefined && sha !== s.testCaseFile!.sha256;
    if (edited) warnings.push(`story ${id}: ${rel} was edited by hand after it was saved; the edited version is handed over`);
    const labels = trace.stories?.[id]?.criteria ?? [];
    stories[id] = {
      title: trace.stories?.[id]?.title ?? null, designFile: rel, designFileSha256: sha,
      sourceFile: s.sourceFile ?? trace.stories?.[id]?.sourceFile ?? null, sourceSha256: s.testCaseFile!.sourceSha256 ?? null,
      editedSinceSave: edited, criteria: criteriaOf(designDir, id, labels), caseIds: [],
    };
    files.push({ story: id, rel, abs });
  }
  if (issues.length > 0) return result;

  // 2. Parse the chosen files together (so an ID used in two files is caught) and assess readiness.
  const parsed = parseInputs(base, files.map((f) => f.abs), now, loadMappings(rootDir));
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) issues.push(`${e.path}: ${e.message}`);
    return result;
  }
  const dup = parsed.document.specs.filter((s) => s.source.originalId !== null && s.id !== s.source.originalId);
  for (const s of dup) issues.push(`test case ${s.source.originalId} appears more than once across the chosen files; test IDs must be unique`);
  if (issues.length > 0) return result;

  const storyOfFile = (specPath: string): string | null => {
    const m = STORY_OF_FILE.exec(path.basename(specPath));
    return m && stories[m[1]!] ? m[1]! : null;
  };
  const storyIdsOf = (id: string): string[] => {
    const t = trace.cases?.[id];
    if (t?.storyIds?.length) return t.storyIds;
    const spec = parsed.document.specs.find((s) => s.id === id);
    const fromFile = spec ? storyOfFile(spec.source.path) : null;
    return fromFile ? [fromFile] : [];
  };
  const envValues = readEnvValues(rootDir);
  const present = new Set([...envValues].filter(([, v]) => v !== '').map(([k]) => k));
  for (const name of Object.keys(process.env)) if (process.env[name]) present.add(name);
  const readiness = assessReadiness(parsed.document, { now, presentEnvVars: present, overrides: new Set(opts.overrideManual ?? []), storyIdsOf });
  result.readiness = readiness.summary;
  result.missingEnvVars = readiness.missingEnvVars;
  const byId = new Map(readiness.cases.map((c) => [c.id, c]));
  const unknownOverrides = (opts.overrideManual ?? []).filter((id) => !byId.has(id));
  if (unknownOverrides.length > 0) issues.push(`--override-manual names unknown test case(s): ${unknownOverrides.join(', ')}`);
  if (issues.length > 0) return result;

  // 3. Build the document (cases keep the design's story/criterion/scenario links).
  const cases: Record<string, HandoffCase> = {};
  for (const spec of parsed.document.specs) {
    const r = byId.get(spec.id) as CaseReadiness;
    const t = trace.cases?.[spec.id];
    const sid = storyIdsOf(spec.id);
    if (!t) warnings.push(`test case ${spec.id} is in ${spec.source.path} but the design traceability does not know it (added by hand?); it is linked to its story file only`);
    const designFile = files.find((f) => storyOfFile(spec.source.path) === f.story)?.rel ?? files[0]!.rel;
    cases[spec.id] = {
      title: spec.title, module: spec.module, storyIds: sid, covers: t?.covers ?? [], techniques: t?.techniques ?? [], scenarioKey: t?.scenarioKey ?? null,
      designFile, verdict: r.verdict, reasons: r.reasons, importedFile: null, importedSha256: null,
    };
    for (const s of sid) if (stories[s]) stories[s]!.caseIds.push(spec.id);
    if (r.verdict === 'manual') result.manual.push({ id: spec.id, title: spec.title, storyIds: sid, reasons: r.reasons });
    if (r.verdict === 'blocked') result.blocked.push({ id: spec.id, title: spec.title, reasons: r.reasons });
  }
  result.stories = selected;
  const handed = Object.entries(cases).filter(([, c]) => c.verdict !== 'manual').map(([id]) => id);
  const include = new Set(handed);

  // Not applying: report what would happen.
  const previous = readHandoff(rootDir);
  if (!opts.apply) {
    result.ok = true;
    return result;
  }

  // 4. Import the cases that can be automated. Files this handoff wrote earlier and nobody edited are replaced; anything else is a conflict.
  const prevCases: Record<string, HandoffCase> = previous.ok ? previous.doc.cases : {};
  const owned = (rel: string): boolean => {
    const entry = Object.values(prevCases).find((c) => c.importedFile === rel);
    const abs = path.join(base, rel);
    return entry !== undefined && existsSync(abs) && sha256File(abs) === entry.importedSha256;
  };
  const importAll = (overwrite: boolean) => files.map((f) => importInput(base, f.abs, loadMappings(rootDir), { destDir: HANDOFF_IMPORT_DIR, include: (id) => include.has(id), overwrite, now }));
  let imports = importAll(false);
  const conflicts = imports.flatMap((i) => i.files.filter((f) => f.state === 'conflict').map((f) => f.file));
  if (conflicts.length > 0) {
    const foreign = conflicts.filter((c) => !owned(c));
    if (foreign.length > 0) {
      issues.push(`${foreign.join(', ')} already exist in ${HANDOFF_IMPORT_DIR}/ with different content that this handoff did not write (edited by hand?); nothing was written. Move or delete them, then hand over again`);
      return result;
    }
    imports = importAll(true);
  }
  for (const i of imports) {
    if (!i.ok) { for (const e of i.errors) issues.push(`${e.path}: ${e.message}`); }
  }
  if (issues.length > 0) return result;
  for (const i of imports) for (const f of i.files) {
    (f.state === 'created' ? result.imported.created : f.state === 'updated' ? result.imported.updated : result.imported.unchanged).push(f.file);
    const c = cases[f.id];
    if (c) { c.importedFile = f.file; c.importedSha256 = sha256File(path.join(base, f.file)); }
  }
  // Credentials found in the cases (the design cases use env: references, so this is normally empty).
  const creds = new Map(imports.flatMap((i) => i.credentials).map((c) => [c.envVar, c.value]));
  result.env = syncEnvFiles(rootDir, creds, referencedEnvVars(parsed.document));

  // 5. Remove what an earlier handoff imported and this one no longer hands over (regenerated away, now manual, story left out).
  for (const [id, c] of Object.entries(prevCases)) {
    if (c.importedFile === null || cases[id]?.importedFile === c.importedFile) continue;
    const abs = path.join(base, c.importedFile);
    if (!existsSync(abs)) continue;
    if (sha256File(abs) === c.importedSha256) { rmSync(abs); result.imported.removed.push(c.importedFile); }
    else warnings.push(`${c.importedFile} is no longer part of the design but was edited after it was imported, so it was kept`);
  }

  const doc: HandoffDocument = {
    schemaVersion: HANDOFF_SCHEMA_VERSION, createdAt: now.toISOString(), designRunId: wf.runId ?? 'unknown', designRunStatus: wf.status ?? 'unknown',
    inputPath: HANDOFF_IMPORT_DIR, stories, cases, readiness, warnings,
  };
  mkdirSync(stateDir(rootDir), { recursive: true });
  writeJsonAtomic(handoffPathOf(rootDir), doc);
  result.handoffFile = toPosixRelative(project, handoffPathOf(rootDir));
  result.applied = true;
  result.ok = true;
  return result;
}

// Snapshot of the current handoff into a run, so the run's traceability always uses exactly what it was created from.
export function attachHandoffToRun(rootDir: string, dir: string): { ok: true; sha256: string; designRunId: string } | { ok: false; issues: string[] } {
  const h = readHandoff(rootDir);
  if (!h.ok) return h;
  const stale = handoffCurrentIssues(rootDir, h.doc);
  if (stale.length > 0) return { ok: false, issues: stale };
  const target = path.join(dir, HANDOFF_FILE);
  copyFileSync(handoffPathOf(rootDir), target);
  return { ok: true, sha256: sha256File(target), designRunId: h.doc.designRunId };
}

// ---- validation ----

export function validateHandoffDocument(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['design handoff must be a JSON object'];
  const d = v as Partial<HandoffDocument>;
  const issues: string[] = [];
  if (d.schemaVersion !== HANDOFF_SCHEMA_VERSION) issues.push('unsupported design handoff schemaVersion');
  if (typeof d.designRunId !== 'string' || d.designRunId === '') issues.push('designRunId is missing');
  if (typeof d.stories !== 'object' || d.stories === null) issues.push('stories is missing');
  if (typeof d.cases !== 'object' || d.cases === null) return [...issues, 'cases is missing'];
  if (typeof d.inputPath !== 'string') issues.push('inputPath is missing');
  for (const [id, c] of Object.entries(d.cases)) {
    if (!Array.isArray(c.storyIds)) issues.push(`${id}: storyIds must be an array`);
    if (c.verdict === 'manual' && c.importedFile !== null) issues.push(`${id}: a manual case must not be imported`);
    if (c.verdict !== 'manual' && c.importedFile === null) issues.push(`${id}: a case that is handed over needs its imported file`);
  }
  if (!d.readiness || !Array.isArray(d.readiness.cases)) issues.push('readiness is missing');
  return issues;
}

// Is the run's snapshot still the handoff on disk, and is that handoff still what the design recorded? Shown when a run is resumed.
export function designLinkStatus(rootDir: string, snapshotSha256: string): { current: boolean; issues: string[] } {
  const live = readHandoff(rootDir);
  if (!live.ok) return { current: false, issues: live.issues };
  const issues = handoffCurrentIssues(rootDir, live.doc);
  if (sha256File(handoffPathOf(rootDir)) !== snapshotSha256) issues.push('the design handoff was redone after this run was created; "design attach <runId>" brings the run up to date');
  return { current: issues.length === 0, issues };
}

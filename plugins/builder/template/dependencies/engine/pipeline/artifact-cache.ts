// Cross-run artifact cache (dependencies/state/artifact-cache/<kind>/<name>.json). It lets a later run skip expensive work
// (parsing, generation, review, typecheck) when everything the artifact was derived from is unchanged.
//
// Rules this module enforces:
//  - An entry is only ever written for an artifact that passed validation (`validation.status === 'valid'`).
//  - An entry is only reused when its recorded inputs AND rule/schema versions equal the current ones, its payload
//    still hashes to the recorded artifactHash (no partial or hand-edited entry), and the caller's own validator
//    accepts the payload. Anything else is a rebuild with the reason recorded.
//  - Execution results are never cached: a previous result is history, not the current result.
//  - Every decision is appended to the run's cache-decisions.json so reuse is visible and auditable.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readScaffold } from '../config/scaffold.ts';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { withFileLock } from '../utils/lock.ts';
import { ARTIFACTS } from './artifact-manager.ts';

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_DIRNAME = 'artifact-cache'; // inside dependencies/state/ (git-ignored, local to the machine)
export const CACHE_KINDS = ['specs', 'generation', 'review', 'typecheck'] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

export interface CacheEntry {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  kind: CacheKind;
  name: string;
  inputs: Record<string, string>; // what the artifact was derived from, as hashes/ids
  versions: Record<string, string>; // parser/rule/schema/framework fingerprints
  artifactHash: string; // sha256 of the canonical payload
  payload: unknown;
  validation: { status: 'valid'; validatedAt: string; by: string };
  createdAt: string;
  runId: string;
}

// ---- hashing ----

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function hashValue(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex');
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Line endings and trailing whitespace must not change a hash (Windows checkouts, editors).
export function normalizeSource(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();
}

export interface FileSet {
  files?: string[]; // files relative to automation/; a missing file hashes as "absent" (its absence is part of the input)
  dirs?: string[]; // directories relative to automation/, walked recursively
  extensions?: string[]; // limits dirs, e.g. ['.ts', '.js']
}

function listFileSet(rootDir: string, set: FileSet): string[] {
  const out = new Set(set.files ?? []);
  for (const d of set.dirs ?? []) {
    const abs = path.join(rootDir, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const e of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!e.isFile() || (set.extensions && !set.extensions.includes(path.extname(e.name)))) continue;
      out.add(path.relative(rootDir, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
    }
  }
  return [...out].sort();
}

// One hash over a set of files: path + normalized content, so renames and edits both change it.
export function fingerprintFiles(rootDir: string, set: FileSet): string {
  const h = createHash('sha256');
  for (const rel of listFileSet(rootDir, set)) {
    const abs = path.join(rootDir, rel);
    h.update(`${rel}\0`);
    h.update(existsSync(abs) && statSync(abs).isFile() ? normalizeSource(readFileSync(abs, 'utf8')) : '<absent>');
    h.update('\0');
  }
  return h.digest('hex');
}

// Fingerprint of the code that produces an artifact (e.g. the parser): any edit to it invalidates what it produced.
export function fingerprintSources(...urls: URL[]): string {
  const h = createHash('sha256');
  for (const u of urls) h.update(normalizeSource(readFileSync(u, 'utf8'))).update('\0');
  return h.digest('hex');
}

// ---- versions of the things artifacts depend on ----

export const PARSER_VERSION = fingerprintSources(
  new URL('./test-case-parser.ts', import.meta.url), new URL('./test-spec.ts', import.meta.url),
  new URL('./input-table.ts', import.meta.url), new URL('../utils/xlsx.ts', import.meta.url),
  new URL('./canonical.ts', import.meta.url), new URL('./column-inference.ts', import.meta.url), new URL('./markdown-table.ts', import.meta.url),
  new URL('./dependencies.ts', import.meta.url),
);
export const STATIC_REVIEW_VERSION = fingerprintSources(new URL('./static-review.ts', import.meta.url), new URL('./session-layout.ts', import.meta.url));

// The generator and reviewer rules (agents and skills) ship with the plugin, not with the project, so init records a
// fingerprint of the rule files each role depends on when it scaffolds or updates the project. A plugin update that does not
// change those files keeps what they produced; one that does invalidates it. Projects scaffolded before the fingerprints
// existed fall back to the plugin version (every update invalidates) until their next `init --update`.
export function rulesVersion(rootDir: string, role: 'generator' | 'reviewer'): string {
  const s = readScaffold(rootDir);
  if (!s) return 'unknown';
  return s.rules ? s.rules[role] : `plugin:${s.pluginVersion}`;
}

// Compiler settings shared by every generated test. Everything else a test depends on is found from its own imports
// (see testDependencyHash in generation-reuse.ts), so adding a page object for one module does not touch the others.
export const FRAMEWORK_FILES: FileSet = { files: ['tsconfig.json', 'jsconfig.json'] };
// Everything the framework's TypeScript project check reads (automation/tsconfig.json also includes the engine config code).
export const TYPECHECK_FILES: FileSet = {
  files: ['playwright.config.ts', 'tsconfig.json'],
  dirs: ['fixtures', 'pages', 'helpers', 'auth', 'test-data', 'tests', '../dependencies/engine/config'],
  extensions: ['.ts'],
};

export function packageVersion(rootDir: string, pkg: string): string {
  const r = readJson(path.join(rootDir, 'node_modules', ...pkg.split('/'), 'package.json'));
  const v = r.ok ? (r.value as { version?: unknown }).version : null;
  return typeof v === 'string' ? v : 'not-installed';
}

// ---- entries ----

export function entryPath(rootDir: string, kind: CacheKind, name: string): string {
  const safe = name.replace(/[^\w.-]/g, '_');
  return path.join(stateDir(rootDir), CACHE_DIRNAME, kind, `${safe}.json`);
}

export type EntryRead = { status: 'ok'; entry: CacheEntry } | { status: 'missing' } | { status: 'corrupt'; reason: string };

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

// A partial, hand-edited or truncated entry is reported as corrupt, never accepted.
export function readEntry(rootDir: string, kind: CacheKind, name: string): EntryRead {
  const r = readJson(entryPath(rootDir, kind, name));
  if (!r.ok) return r.reason === 'not_found' ? { status: 'missing' } : { status: 'corrupt', reason: r.message };
  const e = r.value as Partial<CacheEntry> | null;
  if (typeof e !== 'object' || e === null) return { status: 'corrupt', reason: 'entry is not an object' };
  if (e.schemaVersion !== CACHE_SCHEMA_VERSION) return { status: 'corrupt', reason: `unsupported cache schemaVersion ${JSON.stringify(e.schemaVersion)}` };
  if (e.kind !== kind || e.name !== name) return { status: 'corrupt', reason: 'entry does not belong to this kind/name' };
  if (!isStringRecord(e.inputs) || !isStringRecord(e.versions)) return { status: 'corrupt', reason: 'inputs/versions are malformed' };
  if (e.validation?.status !== 'valid') return { status: 'corrupt', reason: 'entry was never validated' };
  if (typeof e.artifactHash !== 'string' || hashValue(e.payload) !== e.artifactHash) return { status: 'corrupt', reason: 'payload does not match its recorded hash' };
  return { status: 'ok', entry: e as CacheEntry };
}

export interface NewEntry {
  kind: CacheKind;
  name: string;
  inputs: Record<string, string>;
  versions: Record<string, string>;
  payload: unknown;
  by: string; // what validated it, e.g. "review seal"
  runId: string;
  now?: Date;
}

export function writeEntry(rootDir: string, e: NewEntry): CacheEntry {
  const at = (e.now ?? new Date()).toISOString();
  const entry: CacheEntry = {
    schemaVersion: CACHE_SCHEMA_VERSION, kind: e.kind, name: e.name, inputs: e.inputs, versions: e.versions,
    artifactHash: hashValue(e.payload), payload: e.payload, validation: { status: 'valid', validatedAt: at, by: e.by },
    createdAt: at, runId: e.runId,
  };
  const file = entryPath(rootDir, e.kind, e.name);
  withFileLock(`${file}.lock`, () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, entry);
  });
  return entry;
}

// ---- decisions ----

export interface CacheDecision {
  kind: CacheKind | 'exploration' | 'execution';
  name: string;
  action: 'reuse' | 'rebuild';
  reason: string;
  changed: string[]; // which inputs/versions differ, empty for a hit or a first build
  entry?: CacheEntry; // present on reuse
}

function diff(prefix: string, recorded: Record<string, string>, current: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...keys].filter((k) => recorded[k] !== current[k]).map((k) => `${prefix}.${k}`).sort();
}

const REASONS: Record<string, string> = {
  parser: 'the test-case parser changed',
  specSchema: 'the test-spec schema changed',
  generatorRules: 'generator rules changed',
  reviewerRules: 'reviewer rules changed',
  staticReview: 'static review rules changed',
  framework: 'shared framework files changed',
  language: 'the language changed',
  authApproach: 'the authentication approach changed',
  spec: 'the test case changed',
  evidence: 'the application evidence for this test case changed',
  testBlock: 'the generated test was modified or replaced',
  deps: 'a framework file the test imports changed (fixture, page object or helper)',
  tree: 'a file in the type-checked project changed',
  typescript: 'the TypeScript version changed',
  playwright: 'the Playwright version changed',
};

function explain(changed: string[]): string {
  const parts = changed.map((c) => {
    const key = c.split('.').slice(1).join('.');
    return REASONS[key] ?? (c.startsWith('inputs.') ? `input ${key} changed` : `${c} changed`);
  });
  return [...new Set(parts)].join('; ');
}

// Decides whether `name` can be reused for the current inputs. `validatePayload` is the caller's own check of the cached
// payload against reality (e.g. the generated test still exists unmodified); it returns issues, empty = fine.
export function decide(
  rootDir: string,
  kind: CacheKind,
  name: string,
  current: { inputs: Record<string, string>; versions: Record<string, string> },
  validatePayload?: (payload: unknown) => string[],
): CacheDecision {
  const read = readEntry(rootDir, kind, name);
  if (read.status === 'missing') return { kind, name, action: 'rebuild', reason: 'no cached artifact yet', changed: [] };
  if (read.status === 'corrupt') return { kind, name, action: 'rebuild', reason: `cached artifact rejected: ${read.reason}`, changed: [] };
  const changed = [...diff('versions', read.entry.versions, current.versions), ...diff('inputs', read.entry.inputs, current.inputs)];
  if (changed.length > 0) return { kind, name, action: 'rebuild', reason: explain(changed), changed };
  const issues = validatePayload?.(read.entry.payload) ?? [];
  if (issues.length > 0) return { kind, name, action: 'rebuild', reason: `cached artifact no longer valid: ${issues.join('; ')}`, changed: [] };
  return { kind, name, action: 'reuse', reason: `unchanged since ${read.entry.runId}`, changed: [], entry: read.entry };
}

// ---- per-run ledger ----

export const LEDGER_SCHEMA_VERSION = 1;

export interface LedgerEntry {
  at: string;
  kind: CacheDecision['kind'];
  name: string;
  action: CacheDecision['action'];
  reason: string;
  changed: string[];
}

export interface Ledger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  decisions: LedgerEntry[];
}

export function readLedger(runDirectory: string): Ledger {
  const r = readJson(path.join(runDirectory, ARTIFACTS.cacheDecisions));
  const v = r.ok ? (r.value as Partial<Ledger>) : null;
  return v && v.schemaVersion === LEDGER_SCHEMA_VERSION && Array.isArray(v.decisions) ? (v as Ledger) : { schemaVersion: LEDGER_SCHEMA_VERSION, decisions: [] };
}

// Latest decision per kind+name wins, so re-planning a stage replaces its earlier decisions instead of double counting.
export function recordDecisions(runDirectory: string, decisions: CacheDecision[], now: Date = new Date()): void {
  if (decisions.length === 0) return;
  const file = path.join(runDirectory, ARTIFACTS.cacheDecisions);
  withFileLock(`${file}.lock`, () => {
    const ledger = readLedger(runDirectory);
    const at = now.toISOString();
    const incoming = decisions.map((d): LedgerEntry => ({ at, kind: d.kind, name: d.name, action: d.action, reason: d.reason, changed: d.changed }));
    const replaced = new Set(incoming.map((d) => `${d.kind}:${d.name}`));
    mkdirSync(runDirectory, { recursive: true });
    writeJsonAtomic(file, { ...ledger, decisions: [...ledger.decisions.filter((d) => !replaced.has(`${d.kind}:${d.name}`)), ...incoming] });
  });
}

export function summarizeLedger(ledger: Ledger): { hits: number; misses: number; byKind: Record<string, { hits: number; misses: number }>; rebuildReasons: Record<string, number> } {
  const byKind: Record<string, { hits: number; misses: number }> = {};
  const rebuildReasons: Record<string, number> = {};
  let hits = 0;
  let misses = 0;
  for (const d of ledger.decisions) {
    const k = (byKind[d.kind] ??= { hits: 0, misses: 0 });
    if (d.action === 'reuse') { k.hits++; hits++; } else { k.misses++; misses++; rebuildReasons[d.reason] = (rebuildReasons[d.reason] ?? 0) + 1; }
  }
  return { hits, misses, byKind, rebuildReasons };
}

export function stripEntry(d: CacheDecision): Omit<CacheDecision, 'entry'> {
  const { entry: _entry, ...rest } = d;
  return rest;
}

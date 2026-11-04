// Persistent store of structured exploration observations (dependencies/state/exploration-store/<origin>.json).
// Observations are evidence, not truth: nothing here is trusted until it is revalidated against a
// fresh snapshot in the current run (exploration-reuse.ts), and anything that fails is marked stale
// with a recorded reason. Live CLI element refs are never stored — only semantic locators.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { withFileLock } from '../utils/lock.ts';
import type { ObservedElement, SpecExploration } from './exploration.ts';
import type { FailureAnalysis } from './failure-classifier.ts';
import type { TestSpec } from './test-spec.ts';

export const STORE_SCHEMA_VERSION = 1;
export const STORE_DIRNAME = 'exploration-store'; // inside dependencies/state/ (git-ignored, local to the machine)
const MAX_INVALIDATION_LOG = 50;

export interface StoredElement extends ObservedElement {
  runId: string; // run that observed it
  observedAt: string;
  lastRevalidatedAt: string | null;
  status: 'verified' | 'stale';
  staleReason: string | null;
  staleAt: string | null;
}

export interface StoredPage {
  key: string; // page identity, see pageKey()
  url: string; // path as observed (origin-less)
  title: string | null;
  elements: StoredElement[];
  // Informational, relative to the project root. The old run directory may have been pruned; never relied on.
  evidence: { snapshot: string | null; screenshot: string | null };
}

export interface StoredSpec {
  fingerprint: string; // of the test case content the observation was made for
  runId: string;
  observedAt: string;
  exploration: SpecExploration; // step.pageId holds a page key, not a run-local id
}

export interface Invalidation {
  at: string;
  pageKey: string;
  locator: string | null;
  reason: string;
}

export interface ObservationStore {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  origin: string;
  updatedAt: string;
  pages: Record<string, StoredPage>;
  specs: Record<string, StoredSpec>;
  invalidations: Invalidation[]; // most recent last, capped
}

export type StoreState =
  | { status: 'ok'; store: ObservationStore }
  | { status: 'missing'; reason: string }
  | { status: 'corrupt'; reason: string };

export function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function storePath(rootDir: string, baseUrl: string): string {
  const origin = originOf(baseUrl);
  if (!origin) throw new Error(`invalid base URL "${baseUrl}"`);
  return path.join(stateDir(rootDir), STORE_DIRNAME, `${createHash('sha256').update(origin).digest('hex').slice(0, 12)}.json`);
}

// Page identity: path (trailing slash trimmed) plus an SPA hash route. Query strings are ignored.
// Returns null for a URL on another origin: only the configured environment is ever recorded.
export function pageKey(url: string, baseUrl: string): string | null {
  const origin = originOf(baseUrl);
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(url, baseUrl);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/';
  return u.hash.startsWith('#/') ? `${p}${u.hash}` : p;
}

// What the observation was made for. Any change to the case means the evidence may not cover it any more.
export function specFingerprint(spec: TestSpec): string {
  const canonical = {
    title: spec.title,
    module: spec.module,
    preconditions: spec.preconditions,
    // Only added when present, so a case without dependencies keeps the fingerprint it had before dependencies existed.
    ...(spec.dependsOn && spec.dependsOn.length > 0 ? { dependsOn: spec.dependsOn } : {}),
    steps: spec.steps.map((s) => [s.action, s.expected]),
    expectedResults: spec.expectedResults,
    testData: spec.testData.map((d) => [d.name, d.envVar, d.declaredLiteral ? d.value : null]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function emptyStore(origin: string, now: string): ObservationStore {
  return { schemaVersion: STORE_SCHEMA_VERSION, origin, updatedAt: now, pages: {}, specs: {}, invalidations: [] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateStore(v: unknown, origin: string): string[] {
  if (!isObj(v)) return ['store must be a JSON object'];
  const issues: string[] = [];
  if (v.schemaVersion !== STORE_SCHEMA_VERSION) issues.push(`unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}`);
  if (v.origin !== origin) issues.push(`store is for ${JSON.stringify(v.origin)}, not ${origin}`);
  if (!isObj(v.pages)) issues.push('pages must be an object');
  else {
    for (const [key, p] of Object.entries(v.pages)) {
      if (!isObj(p) || p.key !== key || !Array.isArray(p.elements)) { issues.push(`page "${key}" is malformed`); continue; }
      for (const e of p.elements as unknown[]) {
        if (!isObj(e) || typeof e.candidateLocator !== 'string' || (e.status !== 'verified' && e.status !== 'stale')) {
          issues.push(`page "${key}" has a malformed element`);
          break;
        }
      }
    }
  }
  if (!isObj(v.specs)) issues.push('specs must be an object');
  else {
    for (const [id, s] of Object.entries(v.specs)) {
      if (!isObj(s) || typeof s.fingerprint !== 'string' || !isObj(s.exploration)) issues.push(`spec "${id}" is malformed`);
    }
  }
  if (!Array.isArray(v.invalidations)) issues.push('invalidations must be an array');
  return issues;
}

// A partial or corrupt store is reported, never accepted.
export function loadStore(rootDir: string, baseUrl: string): StoreState {
  const origin = originOf(baseUrl);
  if (!origin) return { status: 'corrupt', reason: `invalid base URL "${baseUrl}"` };
  const r = readJson(storePath(rootDir, baseUrl));
  if (!r.ok) {
    return r.reason === 'not_found'
      ? { status: 'missing', reason: 'no observation store for this environment yet' }
      : { status: 'corrupt', reason: r.message };
  }
  const issues = validateStore(r.value, origin);
  if (issues.length > 0) return { status: 'corrupt', reason: issues.join('; ') };
  return { status: 'ok', store: r.value as ObservationStore };
}

export function saveStore(rootDir: string, baseUrl: string, store: ObservationStore): void {
  const file = storePath(rootDir, baseUrl);
  mkdirSync(path.dirname(file), { recursive: true }); // lazily, so a project never gets an empty store dir
  writeJsonAtomic(file, store);
}

// Read-modify-write of the store under a lock, so concurrent runs (parallel analysis by module) cannot lose each
// other's observations. `change` returns the store to save, or null to leave the file untouched.
export function updateStore<T>(
  rootDir: string,
  baseUrl: string,
  change: (state: StoreState) => { store: ObservationStore | null; result: T },
): T {
  return withFileLock(`${storePath(rootDir, baseUrl)}.lock`, () => {
    const out = change(loadStore(rootDir, baseUrl));
    if (out.store) saveStore(rootDir, baseUrl, out.store);
    return out.result;
  });
}

// ---- invalidation ----

function withInvalidation(store: ObservationStore, entries: Invalidation[], now: string): ObservationStore {
  return { ...store, updatedAt: now, invalidations: [...store.invalidations, ...entries].slice(-MAX_INVALIDATION_LOG) };
}

// Marks matching elements (or the whole page when `locator` is null) stale. Idempotent: an element that is
// already stale keeps its first reason.
export function markStale(store: ObservationStore, key: string, locator: string | null, reason: string, now: string): { store: ObservationStore; changed: number } {
  const page = store.pages[key];
  if (!page) return { store, changed: 0 };
  let changed = 0;
  const elements = page.elements.map((e) => {
    if (e.status === 'stale' || (locator !== null && e.candidateLocator !== locator)) return e;
    changed++;
    return { ...e, status: 'stale' as const, staleReason: reason, staleAt: now };
  });
  if (changed === 0) return { store, changed };
  const next = { ...store, pages: { ...store.pages, [key]: { ...page, elements } } };
  return { store: withInvalidation(next, [{ at: now, pageKey: key, locator, reason }], now), changed };
}

// Playwright prints locators with normalised spacing; compare ignoring whitespace runs and a `page.` prefix.
export function normalizeLocator(expr: string): string {
  return expr.trim().replace(/^page\./, '').replace(/\s+/g, ' ');
}

export function locatorsInError(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/^\s*Locator:\s*(.+)$/gm)) found.add(normalizeLocator(m[1]!));
  for (const m of text.matchAll(/waiting for (?:locator\()?(getBy\w+\(.+?\)(?:\.\w+\(.*?\))*)\)?\s*$/gm)) found.add(normalizeLocator(m[1]!));
  return [...found];
}

const LOCATOR_SIGNALS = ['locator found no element', 'locator matches multiple elements'];

export interface ExecutionInvalidation {
  pageKey: string;
  locator: string;
  testId: string;
  reason: string;
}

// A locator that failed to resolve in execution is evidence the saved observation no longer holds
// (whether the cause turns out to be a script defect or an application change — either way the
// observation is unproven and is re-explored next time).
export function invalidateFromFailures(
  store: ObservationStore,
  analysis: FailureAnalysis,
  now: string,
): { store: ObservationStore; invalidated: ExecutionInvalidation[] } {
  let current = store;
  const invalidated: ExecutionInvalidation[] = [];
  for (const f of analysis.failures) {
    if (!f.signals.some((s) => LOCATOR_SIGNALS.includes(s))) continue;
    const failing = new Set(locatorsInError(f.errorExcerpt));
    if (failing.size === 0) continue;
    for (const page of Object.values(current.pages)) {
      for (const e of page.elements) {
        if (e.status === 'stale' || !failing.has(normalizeLocator(e.candidateLocator))) continue;
        const reason = `execution (${analysis.sourceRunId}, ${f.testId}): ${f.signals[0]}`;
        const r = markStale(current, page.key, e.candidateLocator, reason, now);
        if (r.changed > 0) {
          current = r.store;
          invalidated.push({ pageKey: page.key, locator: e.candidateLocator, testId: f.testId, reason });
        }
      }
    }
  }
  return { store: current, invalidated };
}

// Exploration reuse: decide per test case whether saved observations can stand in for a fresh
// exploration, check them against a snapshot taken in the current run, and assemble the final
// exploration record. Pure functions over the store, test specs and run files; the CLI does the I/O.
//
// Rules this module enforces:
//  - Reuse is never granted from the store alone. Every reused page needs a revalidation snapshot
//    from this run, and every locator a reused test case relies on must be found in it exactly once.
//    The one exception is "covered": an unchanged test case whose evidence is consistent and verified AND whose generated
//    test is still current (same evidence, same rules, reviewed, untouched) needs no exploration at all - the run's own
//    execution is the check, and a locator that fails to resolve there makes the evidence stale for the next run.
//  - A changed test case, an unknown/stale/ambiguous locator, or a changed environment means that
//    test case is explored again. Reasons are recorded either way.
//  - Only semantic locators are stored or reused; CLI element refs never are.

import {
  EXPLORATION_SCHEMA_VERSION, savedPageKey, validateExplorationRecord,
  type ExplorationRecord, type ObservedElement, type ObservedPage, type ReuseSummary, type SpecExploration,
} from './exploration.ts';
import {
  emptyStore, markStale, originOf, pageKey, specFingerprint,
  type ObservationStore, type StoreState, type StoredElement, type StoredPage,
} from './exploration-store.ts';
import { layoutModule, type TestSpec, type TestSpecDocument } from './test-spec.ts';

export const REVALIDATION_SCHEMA_VERSION = 1;
const RUN_EVIDENCE_PREFIX = 'dependencies/runs'; // where a run's files live, relative to the project root
export const PLAN_SCHEMA_VERSION = 1;

// ---- revalidation against a fresh accessibility snapshot ----

export interface AriaNode {
  role: string;
  name: string | null;
}

// Parses Playwright's YAML aria snapshot (`- button "Sign in" [ref=e12]`, `- heading "Home" [level=1]:`).
// Only the role and accessible name are read; regex/unnamed nodes keep name = null.
export function parseAriaSnapshot(text: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s+([a-z][a-z0-9]*)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    if (!m) continue;
    nodes.push({ role: m[1]!, name: m[2] === undefined ? null : m[2].replace(/\\(["\\])/g, '$1') });
  }
  return nodes;
}

export const ELEMENT_STATES = ['present', 'missing', 'ambiguous', 'unverifiable'] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export interface ElementCheck {
  state: ElementState;
  detail: string | null;
}

export interface PageRevalidation {
  revalidatedAt: string;
  snapshot: string; // relative to the run dir
  elements: Record<string, ElementCheck>; // keyed by candidateLocator
}

export interface Revalidation {
  schemaVersion: typeof REVALIDATION_SCHEMA_VERSION;
  pages: Record<string, PageRevalidation>;
}

export const emptyRevalidation = (): Revalidation => ({ schemaVersion: REVALIDATION_SCHEMA_VERSION, pages: {} });

export function checkElements(page: StoredPage, snapshotText: string): Record<string, ElementCheck> {
  const nodes = parseAriaSnapshot(snapshotText);
  const out: Record<string, ElementCheck> = {};
  for (const e of page.elements) {
    if (e.status === 'stale') continue; // already invalidated; reported by the plan, not re-checked
    if (e.role === null || e.name === null) {
      // Test-id-only (or unnamed) controls do not appear in an aria snapshot, so they cannot be proven.
      out[e.candidateLocator] = { state: 'unverifiable', detail: 'no role+name to look for in an accessibility snapshot' };
      continue;
    }
    const count = nodes.filter((n) => n.role === e.role && n.name === e.name).length;
    out[e.candidateLocator] = count === 1 ? { state: 'present', detail: null }
      : count === 0 ? { state: 'missing', detail: `no ${e.role} named "${e.name}" in the current snapshot` }
      : { state: 'ambiguous', detail: `${count} ${e.role} elements named "${e.name}" in the current snapshot` };
  }
  return out;
}

// Records the result and invalidates what failed. Present elements get a fresh revalidation time.
export function applyRevalidation(
  store: ObservationStore, key: string, checks: Record<string, ElementCheck>, runId: string, now: string,
): ObservationStore {
  let next = store;
  for (const [locator, c] of Object.entries(checks)) {
    if (c.state === 'missing' || c.state === 'ambiguous') {
      next = markStale(next, key, locator, `revalidation (${runId}): ${c.detail}`, now).store;
    }
  }
  const page = next.pages[key];
  if (!page) return next;
  const elements = page.elements.map((e) => (checks[e.candidateLocator]?.state === 'present' ? { ...e, lastRevalidatedAt: now } : e));
  return { ...next, updatedAt: now, pages: { ...next.pages, [key]: { ...page, elements } } };
}

// ---- plan ----

export const ACTIONS = ['explore', 'revalidate', 'reuse', 'covered'] as const;
export type Action = (typeof ACTIONS)[number];

export interface PlanSpec {
  testId: string;
  module: string;
  action: Action;
  reason: string;
  pages: string[]; // page keys the saved evidence covers (empty for `explore`)
  knownPages?: string[]; // `explore` only: store pages this test case probably visits (see knownPagesFor)
}

// What the store knows about a page, as handed to the explorer so it confirms the page instead of re-observing it.
export interface KnownPage {
  key: string;
  url: string;
  title: string | null;
  locators: { locator: string; role: string | null; name: string | null }[]; // verified elements only
}

const MAX_KNOWN_PAGES = 8; // per test case
const MAX_KNOWN_LOCATORS = 30; // per page

export interface ExplorationPlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  generatedAt: string;
  baseUrl: string;
  store: { status: StoreState['status']; reason: string | null };
  forcedFresh: boolean;
  skipCoverage: boolean; // "covered" was switched off (--revalidate, --fresh or --no-cache): saved evidence is revalidated instead
  // Test cases grouped by module (suite). sharedPages are explored or revalidated once for the whole group.
  groups: { module: string; specIds: string[]; sharedPages: string[] }[];
  specs: PlanSpec[];
  pagesToRevalidate: { key: string; url: string; locators: string[] }[];
  // Pages with verified saved elements that `explore` test cases probably visit. Not trusted: the explorer takes one snapshot per page it
  // really visits, calls `explore revalidate`, and may then name the page as `saved:<key>` in its steps (see exploration.ts).
  knownPages: KnownPage[];
  summary: Record<Action, number>;
}

// The module a case is generated under: its dependency chain's when the chain spans modules, else its own.
export const moduleOf = (s: TestSpec): string => layoutModule(s);

interface Ref {
  key: string;
  locator: string | null; // null = the page itself must still be reachable
}

function refsOf(exploration: SpecExploration): Ref[] {
  const refs: Ref[] = [];
  for (const st of exploration.steps) {
    if (st.pageId === null) continue;
    refs.push({ key: st.pageId, locator: null });
    for (const l of st.locators) refs.push({ key: st.pageId, locator: l });
  }
  return refs;
}

export interface PlanInput {
  specs: TestSpecDocument;
  baseUrl: string;
  state: StoreState;
  revalidation: Revalidation | null;
  forceFresh: boolean;
  now: string;
  // Returns why this test case's generated test is still current (null = it is not, or cannot be shown to be), given the
  // evidence as the store would hand it over. Left out = nothing is ever "covered".
  coverage?: (spec: TestSpec, record: ExplorationRecord) => string | null;
  skipCoverage?: boolean;
}

function classify(spec: TestSpec, input: PlanInput): Omit<PlanSpec, 'testId' | 'module'> & { needs: Ref[] } {
  const explore = (reason: string) => ({ action: 'explore' as const, reason, pages: [], needs: [] });
  if (input.forceFresh) return explore('fresh exploration was requested');
  if (input.state.status !== 'ok') return explore(`${input.state.reason}`);
  const store = input.state.store;
  const saved = store.specs[spec.id];
  if (!saved) return explore('no saved evidence for this test case');
  if (saved.fingerprint !== specFingerprint(spec)) return explore('the test case changed since its evidence was recorded');
  if (saved.exploration.status !== 'explored') return explore(`earlier exploration was ${saved.exploration.status}`);

  const refs = refsOf(saved.exploration);
  if (refs.length === 0) return explore('saved evidence is not tied to any page');
  let pending = false;
  for (const ref of refs) {
    const page = store.pages[ref.key];
    if (!page) return explore(`page ${ref.key} is not in the store`);
    const element = ref.locator === null ? null : page.elements.find((e) => e.candidateLocator === ref.locator);
    if (ref.locator !== null) {
      if (!element) return explore(`locator ${ref.locator} on ${ref.key} is not in the store`);
      if (element.status === 'stale') return explore(`locator ${ref.locator} on ${ref.key} is stale: ${element.staleReason}`);
    }
    const rev = input.revalidation?.pages[ref.key];
    if (!rev) { pending = true; continue; }
    if (ref.locator === null) continue;
    const check = rev.elements[ref.locator];
    if (!check) return explore(`locator ${ref.locator} on ${ref.key} was not covered by this run's revalidation`);
    if (check.state !== 'present') return explore(`locator ${ref.locator} on ${ref.key} is ${check.state}: ${check.detail ?? 'cannot be proven'}`);
  }
  const pages = [...new Set(refs.map((r) => r.key))];
  if (pending && input.coverage && !input.skipCoverage) {
    const why = input.coverage(spec, savedRecord(store, spec.id, input.baseUrl, input.now));
    if (why) return { action: 'covered', reason: why, pages, needs: refs };
  }
  return pending
    ? { action: 'revalidate', reason: 'unchanged test case with saved evidence; needs a snapshot from this run', pages, needs: refs }
    : { action: 'reuse', reason: `saved evidence from ${saved.runId} revalidated in this run`, pages, needs: refs };
}

export function planExploration(input: PlanInput): ExplorationPlan {
  const ready = input.specs.specs.filter((s) => s.status === 'ready');
  const classified = ready.map((s) => ({ spec: s, c: classify(s, input) }));
  const savedStore = input.state.status === 'ok' ? input.state.store : null;
  const knownFor = savedStore ? knownPagesFor(savedStore, ready) : () => [] as string[];
  const specs: PlanSpec[] = classified.map(({ spec, c }) => {
    const known = c.action === 'explore' ? knownFor(spec) : [];
    return { testId: spec.id, module: moduleOf(spec), action: c.action, reason: c.reason, pages: c.pages, ...(known.length > 0 ? { knownPages: known } : {}) };
  });
  const knownKeys = [...new Set(specs.flatMap((s) => s.knownPages ?? []))];
  const knownPages = savedStore ? knownKeys.map((k) => digestOf(savedStore.pages[k]!)) : [];

  const wanted = new Map<string, Set<string>>(); // page key -> locators needed, for specs still pending
  for (const { c } of classified) {
    if (c.action !== 'revalidate') continue;
    for (const ref of c.needs) {
      if (input.revalidation?.pages[ref.key]) continue;
      const set = wanted.get(ref.key) ?? new Set<string>();
      if (ref.locator !== null) set.add(ref.locator);
      wanted.set(ref.key, set);
    }
  }
  const store = input.state.status === 'ok' ? input.state.store : null;
  const pagesToRevalidate = [...wanted].map(([key, locators]) => ({ key, url: store?.pages[key]?.url ?? key, locators: [...locators] }));

  const modules = [...new Set(specs.map((s) => s.module))];
  const groups = modules.map((module) => {
    const inModule = specs.filter((s) => s.module === module);
    const usage = new Map<string, number>();
    for (const s of inModule) for (const p of s.pages) usage.set(p, (usage.get(p) ?? 0) + 1);
    return { module, specIds: inModule.map((s) => s.testId), sharedPages: [...usage].filter(([, n]) => n > 1).map(([k]) => k) };
  });

  const summary: Record<Action, number> = { explore: 0, revalidate: 0, reuse: 0, covered: 0 };
  for (const s of specs) summary[s.action]++;
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatedAt: input.now,
    baseUrl: input.baseUrl,
    store: { status: input.state.status, reason: input.state.status === 'ok' ? null : input.state.reason },
    forcedFresh: input.forceFresh,
    skipCoverage: input.skipCoverage ?? false,
    groups, specs, pagesToRevalidate, knownPages, summary,
  };
}

const verifiedElements = (p: StoredPage): StoredElement[] => p.elements.filter((e) => e.status === 'verified');

function digestOf(p: StoredPage): KnownPage {
  return {
    key: p.key, url: p.url, title: p.title,
    locators: verifiedElements(p).slice(0, MAX_KNOWN_LOCATORS).map((e) => ({ locator: e.candidateLocator, role: e.role, name: e.name })),
  };
}

// Which saved pages a test case that must be explored will probably visit, so the explorer starts from what is known instead of from
// nothing: the pages its own earlier evidence used (a changed case), the pages its module neighbours use, and pages most cases pass
// through (login). A hint only - nothing here is reused until the explorer revalidates the page and a step names it.
function knownPagesFor(store: ObservationStore, ready: TestSpec[]): (spec: TestSpec) => string[] {
  const keysOf = (id: string): string[] => {
    const saved = store.specs[id];
    return saved ? [...new Set(refsOf(saved.exploration).map((r) => r.key))] : [];
  };
  const usage = new Map<string, number>();
  for (const id of Object.keys(store.specs)) for (const k of keysOf(id)) usage.set(k, (usage.get(k) ?? 0) + 1);
  const shared = [...usage].filter(([, n]) => n > 1).map(([k]) => k);
  return (spec) => {
    const neighbours = ready.filter((s) => s.id !== spec.id && moduleOf(s) === moduleOf(spec)).flatMap((s) => keysOf(s.id));
    return [...new Set([...keysOf(spec.id), ...neighbours, ...shared])]
      .filter((k) => store.pages[k] && verifiedElements(store.pages[k]!).length > 0)
      .slice(0, MAX_KNOWN_PAGES);
  };
}

// The evidence for one test case exactly as the store holds it, shaped like an exploration record (pages keyed by their store
// key). It is what assemble hands over for a covered test case, so the same evidence hash comes out of both.
export function savedRecord(store: ObservationStore, testId: string, baseUrl: string, now: string): ExplorationRecord {
  const saved = store.specs[testId]!;
  const keys = [...new Set(refsOf(saved.exploration).map((r) => r.key))];
  const ids = new Map(keys.map((k) => [k, `saved-${slug(k)}`]));
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION, tool: 'playwright-cli', toolVersion: null, session: null, baseUrl, startedAt: now, endedAt: now,
    pages: keys.map((k) => {
      const p = store.pages[k];
      return {
        id: ids.get(k)!, url: p?.url ?? k, title: p?.title ?? null, snapshot: null, screenshot: null,
        elements: (p?.elements ?? []).filter((e) => e.status === 'verified').map(toObservedElement), provenance: { source: 'saved' as const },
      };
    }),
    specs: [{ ...saved.exploration, steps: saved.exploration.steps.map((s) => ({ ...s, pageId: s.pageId === null ? null : ids.get(s.pageId)! })) }],
    avoidedActions: [],
  };
}

// ---- assemble ----

export interface AssembleInput {
  runId: string;
  runDir: string;
  specs: TestSpecDocument;
  baseUrl: string;
  state: StoreState;
  revalidation: Revalidation;
  fresh: unknown; // exploration/fresh.json as written by the explorer
  forceFresh: boolean;
  now: string;
  coverage?: PlanInput['coverage'];
  skipCoverage?: boolean;
}

export type AssembleResult =
  | { ok: true; record: ExplorationRecord; store: ObservationStore; plan: ExplorationPlan }
  | { ok: false; issues: string[]; plan: ExplorationPlan };

// What "nothing was explored" looks like, for runs where every test case reuses or is covered by saved evidence and no
// explorer ran. Assemble accepts it in place of the explorer's fresh.json.
export function emptyFreshRecord(baseUrl: string, now: string): ExplorationRecord {
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION, tool: 'playwright-cli', toolVersion: null, session: null, baseUrl, startedAt: now, endedAt: now,
    pages: [], specs: [], avoidedActions: [],
  };
}

const slug = (key: string): string => key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';

function toStoredElement(e: ObservedElement, runId: string, at: string): StoredElement {
  return { ...e, runId, observedAt: at, lastRevalidatedAt: null, status: 'verified', staleReason: null, staleAt: null };
}

function toObservedElement(e: StoredElement): ObservedElement {
  return { role: e.role, name: e.name, testId: e.testId, candidateLocator: e.candidateLocator, confidence: e.confidence, notes: e.notes };
}

export function assembleExploration(input: AssembleInput): AssembleResult {
  const plan = planExploration({ specs: input.specs, baseUrl: input.baseUrl, state: input.state, revalidation: input.revalidation, forceFresh: input.forceFresh, now: input.now, coverage: input.coverage, skipCoverage: input.skipCoverage });
  const freshIssues = validateExplorationRecord(input.fresh, { runDir: input.runDir, specs: null, allowSaved: true });
  if (freshIssues.length > 0) return { ok: false, issues: freshIssues.map((i) => `fresh.json: ${i}`), plan };
  const fresh = input.fresh as ExplorationRecord;
  const issues: string[] = [];
  const seeded = seededRefs(fresh, input.state, input.revalidation, issues);

  const freshIds = new Set(fresh.specs.map((s) => s.testId));
  const reusedSpecs: string[] = [];
  const coveredSpecs: string[] = [];
  const reasons: Record<string, string> = {};
  for (const p of plan.specs) {
    if (freshIds.has(p.testId)) {
      const base = p.action === 'explore' ? p.reason : `explored fresh (saved evidence was available: ${p.reason})`;
      const from = seeded.bySpec.get(p.testId);
      reasons[p.testId] = from ? `${base}; known pages reused after revalidation: ${[...from].join(', ')}` : base;
      continue;
    }
    if (p.action === 'reuse') { reusedSpecs.push(p.testId); reasons[p.testId] = p.reason; continue; }
    if (p.action === 'covered') { reusedSpecs.push(p.testId); coveredSpecs.push(p.testId); reasons[p.testId] = `covered: ${p.reason}`; continue; }
    issues.push(`${p.testId}: ${p.action === 'explore' ? `needs fresh exploration (${p.reason})` : 'saved evidence has not been revalidated yet (snapshot its pages and run "explore revalidate")'}`);
  }
  if (issues.length > 0) return { ok: false, issues, plan };

  // Pages. Fresh observations win for a page both sides cover; reused specs are remapped onto them.
  const store = input.state.status === 'ok' ? input.state.store : emptyStore(originOf(input.baseUrl) ?? input.baseUrl, input.now);
  const keyToId = new Map<string, string>();
  const pages: ObservedPage[] = fresh.pages.map((p) => {
    const key = pageKey(p.url, input.baseUrl);
    if (key !== null && !keyToId.has(key)) keyToId.set(key, p.id);
    return { ...p, provenance: { source: 'fresh' as const } };
  });
  const usedIds = new Set(pages.map((p) => p.id));
  const reusedKeys = [...new Set([...reusedSpecs.flatMap((id) => refsOf(store.specs[id]!.exploration).map((r) => r.key)), ...seeded.keys])];
  for (const key of reusedKeys) {
    if (keyToId.has(key)) continue;
    const saved = store.pages[key]!;
    const rev = input.revalidation.pages[key]; // absent for a page only covered test cases use
    let id = `reused-${slug(key)}`;
    while (usedIds.has(id)) id += '-r';
    usedIds.add(id);
    keyToId.set(key, id);
    const present = saved.elements.filter((e) => e.status === 'verified' && (rev ? rev.elements[e.candidateLocator]?.state === 'present' : true));
    const fromRunId = present[0]?.runId ?? store.specs[reusedSpecs[0]!]?.runId;
    pages.push({
      id, url: saved.url, title: saved.title,
      snapshot: rev ? rev.snapshot : null, screenshot: null, // evidence from this run, not a path into a possibly pruned old run
      elements: present.map(toObservedElement),
      provenance: rev ? { source: 'reused', fromRunId, revalidatedAt: rev.revalidatedAt } : { source: 'saved', fromRunId },
    });
  }

  const reusedEntries: SpecExploration[] = reusedSpecs.map((id) => {
    const e = store.specs[id]!.exploration;
    return { ...e, steps: e.steps.map((s) => ({ ...s, pageId: s.pageId === null ? null : keyToId.get(s.pageId)! })) };
  });
  // Steps a fresh test case pointed at a saved page (`saved:<key>`) now point at the revalidated page.
  const freshEntries: SpecExploration[] = fresh.specs.map((e) => ({
    ...e, steps: e.steps.map((s) => { const key = savedPageKey(s.pageId); return key === null ? s : { ...s, pageId: keyToId.get(key)! }; }),
  }));
  // A fresh page that stands in for a saved one may not list everything the saved test case's steps name: carry those over.
  const keyOfId = new Map([...keyToId].map(([k, id]) => [id, k]));
  for (const entry of [...reusedEntries, ...freshEntries.filter((e) => seeded.bySpec.has(e.testId))]) {
    for (const st of entry.steps) {
      const page = st.pageId === null ? undefined : pages.find((p) => p.id === st.pageId);
      if (!page) continue;
      for (const loc of st.locators) {
        if (page.elements.some((e) => e.candidateLocator === loc)) continue;
        const stored = store.pages[keyOfId.get(page.id) ?? '']?.elements.find((e) => e.candidateLocator === loc && e.status === 'verified');
        if (stored) page.elements.push(toObservedElement(stored));
        else issues.push(`${entry.testId}: saved locator ${loc} could not be carried onto page ${page.id}`);
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues, plan };

  const record: ExplorationRecord = {
    ...fresh,
    pages,
    specs: [...freshEntries, ...reusedEntries],
    reuse: summarize(plan, reusedSpecs, coveredSpecs, fresh, pages, reasons, input.baseUrl, [...seeded.keys]),
  };
  const mergedIssues = validateExplorationRecord(record, { runDir: input.runDir, specs: input.specs });
  if (mergedIssues.length > 0) return { ok: false, issues: mergedIssues, plan };

  return { ok: true, record, store: updateStore(store, input, fresh), plan };
}

function summarize(
  plan: ExplorationPlan, reusedSpecs: string[], coveredSpecs: string[], fresh: ExplorationRecord, pages: ObservedPage[], reasons: Record<string, string>, baseUrl: string,
  seededPages: string[],
): ReuseSummary {
  const keyOf = (p: ObservedPage) => pageKey(p.url, baseUrl) ?? p.url;
  return {
    reusedSpecs,
    ...(coveredSpecs.length > 0 ? { coveredSpecs } : {}),
    freshSpecs: plan.specs.map((s) => s.testId).filter((id) => !reusedSpecs.includes(id)),
    reusedPages: pages.filter((p) => p.provenance?.source === 'reused' || p.provenance?.source === 'saved').map(keyOf),
    freshPages: fresh.pages.map(keyOf),
    ...(seededPages.length > 0 ? { seededPages } : {}),
    reasons,
  };
}

// The saved pages that freshly explored test cases name as `saved:<key>`. Each must be in the store and revalidated in this run, and
// every locator the step names must have come out `present` there - the same bar a reused test case has to clear.
function seededRefs(
  fresh: ExplorationRecord, state: StoreState, revalidation: Revalidation, issues: string[],
): { keys: Set<string>; bySpec: Map<string, Set<string>> } {
  const keys = new Set<string>();
  const bySpec = new Map<string, Set<string>>();
  for (const s of fresh.specs) {
    for (const st of s.steps) {
      const key = savedPageKey(st.pageId);
      if (key === null) continue;
      const where = `${s.testId} step ${st.index}: saved page ${key}`;
      const page = state.status === 'ok' ? state.store.pages[key] : undefined;
      const rev = revalidation.pages[key];
      if (!page) { issues.push(`${where} is not in the store; list the page and its elements in fresh.json instead`); continue; }
      if (!rev) { issues.push(`${where} has no snapshot from this run: snapshot it and run "explore revalidate --page ${key}"`); continue; }
      let ok = true;
      for (const loc of st.locators) {
        const element = page.elements.find((e) => e.candidateLocator === loc);
        const check = rev.elements[loc];
        if (!element || element.status !== 'verified') issues.push(`${where}: locator ${loc} is not a verified saved element; observe it and list it in fresh.json`);
        else if (check?.state !== 'present') issues.push(`${where}: locator ${loc} is ${check?.state ?? 'not checked'} in this run's snapshot${check?.detail ? ` (${check.detail})` : ''}`);
        else continue;
        ok = false;
      }
      if (!ok) continue;
      keys.add(key);
      bySpec.set(s.testId, (bySpec.get(s.testId) ?? new Set<string>()).add(key));
    }
  }
  return { keys, bySpec };
}

// Folds this run's fresh observations into the store. Elements are merged by locator so evidence for
// other test cases on the same page is kept; a fresh observation of a locator makes it verified again.
function updateStore(store: ObservationStore, input: AssembleInput, fresh: ExplorationRecord): ObservationStore {
  const pages = { ...store.pages };
  const idToKey = new Map<string, string>();
  for (const p of fresh.pages) {
    const key = pageKey(p.url, input.baseUrl);
    if (key === null) continue; // other origin: never recorded
    idToKey.set(p.id, key);
    const existing = pages[key];
    const incoming = p.elements.map((e) => toStoredElement(e, input.runId, fresh.endedAt));
    const kept = (existing?.elements ?? []).filter((e) => !incoming.some((n) => n.candidateLocator === e.candidateLocator));
    pages[key] = {
      key,
      url: pagePath(p.url, input.baseUrl),
      title: p.title ?? existing?.title ?? null,
      elements: [...kept, ...incoming],
      evidence: {
        snapshot: p.snapshot ? `${RUN_EVIDENCE_PREFIX}/${input.runId}/${p.snapshot}` : existing?.evidence.snapshot ?? null,
        screenshot: p.screenshot ? `${RUN_EVIDENCE_PREFIX}/${input.runId}/${p.screenshot}` : existing?.evidence.screenshot ?? null,
      },
    };
  }

  const specs = { ...store.specs };
  const bySpec = new Map(input.specs.specs.map((s) => [s.id, s]));
  for (const entry of fresh.specs) {
    const spec = bySpec.get(entry.testId);
    if (!spec) continue;
    const steps = entry.steps.map((s) => ({ ...s, pageId: s.pageId === null ? null : idToKey.get(s.pageId) ?? savedPageKey(s.pageId) ?? undefined }));
    // Evidence on a page outside the configured origin cannot be re-checked later, so it is not saved.
    if (entry.status !== 'explored' || steps.some((s) => s.pageId === undefined)) { delete specs[entry.testId]; continue; }
    specs[entry.testId] = {
      fingerprint: specFingerprint(spec), runId: input.runId, observedAt: fresh.endedAt,
      exploration: { ...entry, steps: steps as SpecExploration['steps'] },
    };
  }
  // Reused spec entries are left as they are: they keep their original run and observation time.
  return { ...store, updatedAt: input.now, pages, specs };
}

// Origin-less path of a page URL, keeping an SPA hash route (matches the page key's identity rules).
function pagePath(url: string, baseUrl: string): string {
  const u = new URL(url, baseUrl);
  return u.pathname + (u.hash.startsWith('#/') ? u.hash : '');
}

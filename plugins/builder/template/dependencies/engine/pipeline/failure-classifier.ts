// Heuristic first-pass classification of failed/flaky results. The failure-healer agent confirms or
// overrides each one with evidence (via `triage classify`) before any repair is attempted.

import { writeJsonAtomic } from '../utils/fs.ts';
import { GENERIC_LOGGED_OUT } from './auth-state.ts';
import type { ExecutionResults, TestResult } from './execution.ts';

export const CATEGORIES = [
  'script_defect', 'application_defect', 'environment_issue', 'test_data_or_precondition', 'flaky_or_intermittent', 'inconclusive',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

interface Rule {
  category: Category;
  confidence: Confidence;
  signal: string;
  test: RegExp | ((text: string) => boolean);
}

// The locator resolved to nothing: an assertion reporting "<element(s) not found>", or an action
// timeout whose call log never shows "locator resolved to". A value mismatch also logs
// "waiting for getBy…", so that phrase alone proves nothing.
function locatorNotFound(text: string): boolean {
  if (/element\(s\) not found|resolved to 0 elements/i.test(text)) return true;
  return /\b(?:locator|page)\.\w+: Timeout \d+ms exceeded/i.test(text) && !/locator resolved to/i.test(text);
}

// Ordered: the first matching rule wins. Environment problems are checked before locator problems,
// because a down service also produces "element not found".
const RULES: Rule[] = [
  { category: 'environment_issue', confidence: 'high', signal: 'browser not installed', test: /Executable doesn't exist|browserType\.launch|Please run the following command to download new browsers/i },
  { category: 'environment_issue', confidence: 'high', signal: 'network/DNS failure', test: /net::ERR_(?:NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_RESET|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|TIMED_OUT|CERT)|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i },
  { category: 'environment_issue', confidence: 'medium', signal: 'server error response', test: /\b(?:502|503|504)\b.*(?:Bad Gateway|Service Unavailable|Gateway Timeout)|http 5\d\d:/i },
  { category: 'test_data_or_precondition', confidence: 'high', signal: 'missing environment variable', test: /Missing required environment variable/ },
  { category: 'test_data_or_precondition', confidence: 'medium', signal: 'auth state missing/expired', test: /storage-state\.json|ENOENT.*[\\/]auth[\\/]|storageState/i },
  { category: 'script_defect', confidence: 'high', signal: 'script error', test: /\b(?:SyntaxError|ReferenceError|TypeError: [^\n]*is not a function|Cannot find module)\b/ },
  { category: 'script_defect', confidence: 'high', signal: 'locator matches multiple elements', test: /strict mode violation/i },
  // Medium only: the control may have been renamed (script defect) or be genuinely missing (app defect).
  // The healer must confirm against current UI evidence before repairing.
  { category: 'script_defect', confidence: 'medium', signal: 'locator found no element', test: locatorNotFound },
  { category: 'application_defect', confidence: 'medium', signal: 'assertion value mismatch', test: /Expected(?: string| pattern| substring| value)?:[\s\S]*Received(?: string| value)?:/ },
  { category: 'application_defect', confidence: 'low', signal: 'assertion failed', test: /expect\(.*\)\.(?:to|not)/ },
];

function matches(rule: Rule, text: string): boolean {
  return typeof rule.test === 'function' ? rule.test(text) : rule.test.test(text);
}

export interface Classification {
  category: Category;
  confidence: Confidence;
  signals: string[];
}

export function classifyResult(t: TestResult): Classification {
  if (t.outcome === 'flaky') return { category: 'flaky_or_intermittent', confidence: 'high', signals: ['passed only after retry'] };
  const firstFailure = t.attempts.find((a) => a.errors.length > 0) ?? t.attempts[0];
  const text = (firstFailure?.errors ?? []).map((e) => `${e.message}\n${e.stack ?? ''}`).join('\n');
  if (firstFailure?.status === 'timedOut' && !text) return { category: 'inconclusive', confidence: 'low', signals: ['test timeout without a specific error'] };
  for (const r of RULES) if (matches(r, text)) return { category: r.category, confidence: r.confidence, signals: [r.signal] };
  return { category: 'inconclusive', confidence: 'low', signals: ['no known failure pattern'] };
}

export interface FailureEntry {
  key: string;
  testId: string;
  title: string;
  file: string;
  line: number;
  project: string;
  outcome: TestResult['outcome'];
  category: Category;
  confidence: Confidence;
  signals: string[];
  errorExcerpt: string;
  evidence: string[]; // attachment paths, relative to automation/
  classifiedBy: 'heuristic' | 'agent';
  rationale: string | null;
  healingEligible: boolean;
}

export const FAILURE_ANALYSIS_SCHEMA_VERSION = 1;

// A test that did not run because a test it depends on failed (or was itself blocked). It is not a failure of its own: fix the
// test it names first, then run it again.
export interface BlockedEntry {
  key: string;
  testId: string;
  blockedBy: string[]; // test IDs, the ones that failed or were blocked
}

export interface FailureAnalysis {
  schemaVersion: typeof FAILURE_ANALYSIS_SCHEMA_VERSION;
  analyzedAt: string;
  sourceRunId: string;
  sourceLabel: string;
  failures: FailureEntry[];
  blocked?: BlockedEntry[];
}

// Only a script defect with at least medium confidence may be repaired.
export function isHealingEligible(category: Category, confidence: Confidence): boolean {
  return category === 'script_defect' && confidence !== 'low';
}

// Skipped tests whose prerequisites failed. `dependsOn` maps a test ID to the test IDs it needs (from the specs); a skipped test is
// only called blocked when a test it depends on really did not pass, so a skip for any other reason stays a skip.
export function blockedByDependencies(results: ExecutionResults, dependsOn: ReadonlyMap<string, readonly string[]>): BlockedEntry[] {
  const notPassed = new Set(results.tests.filter((t) => t.outcome === 'failed').map((t) => t.testId));
  const blocked: BlockedEntry[] = [];
  const done = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of results.tests) {
      if (t.outcome !== 'skipped' || done.has(t.key)) continue;
      const by = (dependsOn.get(t.testId) ?? []).filter((d) => notPassed.has(d));
      if (by.length === 0) continue;
      done.add(t.key);
      notPassed.add(t.testId);
      blocked.push({ key: t.key, testId: t.testId, blockedBy: by });
      changed = true;
    }
  }
  return blocked;
}

export function buildFailureAnalysis(results: ExecutionResults, now = new Date(), dependsOn: ReadonlyMap<string, readonly string[]> = new Map()): FailureAnalysis {
  const lostLoginIds = new Set(results.authState?.lostLoginTests ?? []);
  const failures = results.tests
    .filter((t) => t.outcome === 'failed' || t.outcome === 'flaky')
    .map((t): FailureEntry => {
      let c = classifyResult(t);
      // Logged out although a fresh login was done in this run: the account or its credentials are the problem, not the
      // test script, so it is never offered for repair.
      // (The login step signs in again whenever a saved session is refused, so a test that still ends logged out was logged out by
      // something else: another test that signed in or out as the same account, a session that is cut short, or wrong credentials.)
      if (results.authState && t.outcome === 'failed' && !t.ownSession && (lostLoginIds.has(t.testId) || t.attempts.some((a) => a.errors.some((e) => GENERIC_LOGGED_OUT.test(`${e.message}\n${e.stack ?? ''}`))))) {
        c = { category: 'test_data_or_precondition', confidence: 'high', signals: ['logged out although the login was checked or renewed just before the run (the account, its credentials, a session that ends early, or another test signing in or out as the same account)'] };
      }
      const failed = t.attempts.find((a) => a.errors.length > 0);
      return {
        key: t.key, testId: t.testId, title: t.title, file: t.file, line: t.line, project: t.project, outcome: t.outcome,
        ...c,
        errorExcerpt: (failed?.errors[0]?.message ?? '').slice(0, 1500),
        evidence: t.attempts.flatMap((a) => a.attachments.map((x) => x.path)),
        classifiedBy: 'heuristic',
        rationale: null,
        healingEligible: isHealingEligible(c.category, c.confidence),
      };
    });
  const blocked = blockedByDependencies(results, dependsOn);
  return { schemaVersion: FAILURE_ANALYSIS_SCHEMA_VERSION, analyzedAt: now.toISOString(), sourceRunId: results.runId, sourceLabel: results.label, failures, ...(blocked.length > 0 ? { blocked } : {}) };
}

// Agent override after looking at the evidence. A rationale is mandatory.
export function reclassify(analysis: FailureAnalysis, key: string, category: Category, confidence: Confidence, rationale: string): FailureAnalysis {
  if (!rationale.trim()) throw new Error('a rationale citing the evidence is required to reclassify');
  let target = analysis.failures.find((f) => f.key === key);
  if (!target) {
    const byId = analysis.failures.filter((f) => f.testId === key);
    if (byId.length === 0) throw new Error(`no failure with key or testId "${key}"`);
    if (byId.length > 1) throw new Error(`"${key}" failed in several projects; pass the full key (${byId.map((m) => m.key).join(', ')})`);
    target = byId[0]!;
  }
  const failures = analysis.failures.map((f) =>
    f === target ?{ ...f, category, confidence, rationale, classifiedBy: 'agent' as const, healingEligible: isHealingEligible(category, confidence) } : f);
  return { ...analysis, failures };
}

export function saveFailureAnalysis(file: string, a: FailureAnalysis): void {
  writeJsonAtomic(file, a);
}

export function validateFailureAnalysis(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['failure analysis must be an object'];
  const a = v as Partial<FailureAnalysis>;
  const issues: string[] = [];
  if (a.schemaVersion !== FAILURE_ANALYSIS_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Array.isArray(a.failures)) return [...issues, 'failures must be an array'];
  for (const f of a.failures) {
    if (!(CATEGORIES as readonly unknown[]).includes(f.category)) issues.push(`${f.key}: invalid category`);
    if (!(CONFIDENCES as readonly unknown[]).includes(f.confidence)) issues.push(`${f.key}: invalid confidence`);
    if (f.healingEligible !== isHealingEligible(f.category, f.confidence)) issues.push(`${f.key}: healingEligible is inconsistent with category/confidence`);
    if (f.classifiedBy === 'agent' && !f.rationale) issues.push(`${f.key}: agent classification needs a rationale`);
  }
  return issues;
}

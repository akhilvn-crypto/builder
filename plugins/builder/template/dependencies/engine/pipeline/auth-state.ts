// Reliable reuse of saved login state (Playwright storageState).
//
// Reusing a saved login avoids a UI login in every run, but a stale session makes every test fail for a reason unrelated to
// the application under test. So saved state is trusted only after it has been checked:
//   exists and well-formed, created by this pipeline for this origin, young enough, cookies not expired, and (when a probe
//   path is configured) still accepted by the application. Anything else means "refresh": the setup project logs in again.
// If state that looked fine is rejected during a run, the cause is diagnosed as authentication and the run is repeated once
// with a fresh login (controlled recovery) instead of reporting a wall of unrelated failures.
//
// Nothing here prints or stores cookie, token or password values; reports contain only names, counts, ages and statuses.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { AUTH_DIR, AUTH_STATE_FILE } from '../config/playwright-config.ts';
import { DEFAULT_AUTH_STATE_MAX_AGE_HOURS, type AutomationConfig } from '../config/schema.ts';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { isIgnored } from '../utils/gitignore.ts';
import { defaultProbeRunner, type ProbeResult, type ProbeRunner } from './auth-probe.ts';
import type { ExecutionResults, TestResult } from './execution.ts';

export const AUTH_META_FILE = `${AUTH_DIR}/storage-state.meta.json`;
export const AUTH_META_SCHEMA_VERSION = 1;

export const AUTH_STATUSES = [
  'not_applicable', 'absent', 'unreadable', 'no_age_record', 'origin_mismatch', 'too_old', 'expired', 'rejected_by_app', 'unverifiable', 'valid',
] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export interface AuthStateReport {
  approach: AutomationConfig['auth']['approach'];
  status: AuthStatus;
  decision: 'reuse' | 'refresh' | 'not_applicable';
  reason: string;
  ageHours: number | null;
  maxAgeHours: number;
  cookies: { total: number; expired: number; session: number } | null;
  probe: { configured: boolean; outcome: ProbeResult['outcome'] | 'not_run'; httpStatus: number | null };
  // True only when the application itself confirmed the state. Otherwise reuse rests on age and cookie expiry alone.
  verifiedByApplication: boolean;
  warnings: string[];
  gitignored: { env: boolean; state: boolean; meta: boolean };
}

interface Meta {
  schemaVersion: typeof AUTH_META_SCHEMA_VERSION;
  createdAt: string;
  origin: string;
  credentialEnvVars: string[]; // names only
}

interface StoredCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
}

export const statePath = (rootDir: string): string => path.join(rootDir, AUTH_STATE_FILE);
export const metaPath = (rootDir: string): string => path.join(rootDir, AUTH_META_FILE);

function readState(rootDir: string): { ok: true; cookies: StoredCookie[] } | { ok: false; reason: string } {
  const r = readJson(statePath(rootDir));
  if (!r.ok) return { ok: false, reason: r.reason === 'not_found' ? 'absent' : 'the saved state is not valid JSON' };
  const v = r.value as { cookies?: unknown; origins?: unknown } | null;
  if (typeof v !== 'object' || v === null || !Array.isArray(v.cookies) || !Array.isArray(v.origins)) return { ok: false, reason: 'the saved state is not a Playwright storage state' };
  const bad = (v.cookies as StoredCookie[]).some((c) => typeof c !== 'object' || c === null || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string' || typeof c.expires !== 'number');
  return bad ? { ok: false, reason: 'the saved state has malformed cookies' } : { ok: true, cookies: v.cookies as StoredCookie[] };
}

function readMeta(rootDir: string): Meta | null {
  const r = readJson(metaPath(rootDir));
  if (!r.ok) return null;
  const m = r.value as Partial<Meta>;
  return m.schemaVersion === AUTH_META_SCHEMA_VERSION && typeof m.createdAt === 'string' && !Number.isNaN(Date.parse(m.createdAt)) && typeof m.origin === 'string' ? (m as Meta) : null;
}

export interface InspectOptions {
  now?: Date;
  probe?: ProbeRunner;
}

export function inspectAuthState(rootDir: string, config: AutomationConfig, opts: InspectOptions = {}): AuthStateReport {
  const now = opts.now ?? new Date();
  const settings = config.auth.state ?? {};
  const maxAgeHours = settings.maxAgeHours ?? DEFAULT_AUTH_STATE_MAX_AGE_HOURS;
  const base: AuthStateReport = {
    approach: config.auth.approach, status: 'not_applicable', decision: 'not_applicable', reason: `auth.approach is "${config.auth.approach}": no saved state is used`,
    ageHours: null, maxAgeHours, cookies: null, probe: { configured: Boolean(settings.probePath), outcome: 'not_run', httpStatus: null }, verifiedByApplication: false, warnings: [],
    gitignored: { env: isIgnored(rootDir, '.env'), state: isIgnored(rootDir, AUTH_STATE_FILE), meta: isIgnored(rootDir, AUTH_META_FILE) },
  };
  if (config.auth.approach !== 'storage-state') return base;

  const refresh = (status: AuthStatus, reason: string, extra: Partial<AuthStateReport> = {}): AuthStateReport => ({ ...base, ...extra, status, decision: 'refresh', reason });
  if (!base.gitignored.state) base.warnings.push(`${AUTH_STATE_FILE} is not covered by .gitignore: add ".auth/" so saved sessions are never committed`);

  const state = readState(rootDir);
  if (!state.ok) {
    return state.reason === 'absent'
      ? refresh('absent', 'no saved authentication state yet: the setup project will log in')
      : refresh('unreadable', `${state.reason}: it will be replaced by a fresh login`);
  }
  const meta = readMeta(rootDir);
  if (!meta) return refresh('no_age_record', 'the saved state was not created by this pipeline, so its age is unknown: logging in again');
  const origin = new URL(config.app.baseUrl).origin;
  if (meta.origin !== origin) return refresh('origin_mismatch', `the saved state was created for ${meta.origin}, not ${origin}: logging in again`);

  const ageHours = Math.max(0, (now.getTime() - Date.parse(meta.createdAt)) / 3_600_000);
  const nowSeconds = now.getTime() / 1000;
  const persistent = state.cookies.filter((c) => (c.expires as number) > 0);
  const expired = persistent.filter((c) => (c.expires as number) <= nowSeconds).length;
  const cookies = { total: state.cookies.length, expired, session: state.cookies.length - persistent.length };
  const common = { ageHours: Math.round(ageHours * 10) / 10, cookies };

  if (ageHours > maxAgeHours) return refresh('too_old', `the saved state is ${common.ageHours}h old (limit ${maxAgeHours}h): logging in again`, common);
  if (persistent.length > 0 && expired === persistent.length && cookies.session === 0) {
    return refresh('expired', 'every saved cookie has expired: logging in again', common);
  }
  if (expired > 0) base.warnings.push(`${expired} of ${cookies.total} saved cookies have expired`);

  if (settings.probePath) {
    const probe = (opts.probe ?? defaultProbeRunner)({ baseUrl: config.app.baseUrl, probePath: settings.probePath, stateFile: statePath(rootDir), loggedOutPattern: settings.loggedOutPattern ?? null });
    const probeInfo = { configured: true, outcome: probe.outcome, httpStatus: probe.httpStatus };
    if (probe.outcome === 'rejected') return refresh('rejected_by_app', `the application no longer accepts the saved session (${probe.detail ?? 'rejected'}): logging in again`, { ...common, probe: probeInfo });
    if (probe.outcome !== 'ok') return refresh('unverifiable', `the saved session could not be confirmed (${probe.detail ?? probe.outcome}): logging in again`, { ...common, probe: probeInfo });
    return { ...base, ...common, probe: probeInfo, status: 'valid', decision: 'reuse', verifiedByApplication: true, reason: `the application accepted the saved session (age ${common.ageHours}h)` };
  }
  base.warnings.push('no auth.state.probePath is configured, so the application was not asked: reuse rests on age and cookie expiry only');
  return { ...base, ...common, status: 'valid', decision: 'reuse', reason: `saved state is ${common.ageHours}h old with unexpired cookies (limit ${maxAgeHours}h)` };
}

// Records when and for which origin the state was created, so a later run can judge its age. Names only, no values.
export function writeAuthMeta(rootDir: string, config: AutomationConfig, now: Date = new Date()): void {
  const meta: Meta = { schemaVersion: AUTH_META_SCHEMA_VERSION, createdAt: now.toISOString(), origin: new URL(config.app.baseUrl).origin, credentialEnvVars: config.auth.credentialEnvVars };
  mkdirSync(path.dirname(metaPath(rootDir)), { recursive: true });
  writeJsonAtomic(metaPath(rootDir), meta);
}

// Explicit cleanup of saved login state (the session itself and its record). Returns what was removed.
export function clearAuthState(rootDir: string): string[] {
  const removed: string[] = [];
  for (const [rel, abs] of [[AUTH_STATE_FILE, statePath(rootDir)], [AUTH_META_FILE, metaPath(rootDir)]] as const) {
    if (existsSync(abs) && statSync(abs).isFile()) {
      rmSync(abs, { force: true });
      removed.push(rel);
    }
  }
  return removed;
}

// ---- running tests with managed state ----

export interface AuthRunInfo {
  decision: 'reuse' | 'refresh';
  status: AuthStatus;
  reason: string;
  verifiedByApplication: boolean;
  recovered: boolean; // the first attempt was rejected and the tests were run again after a fresh login
  setup: 'passed' | 'failed' | 'not_run';
  // What the login step did: 'reused' the saved session (the application accepted it just before the tests), 'signed_in' (it had to
  // sign in: no usable session, or the saved one was refused at that moment), or 'not_run'.
  gate: 'reused' | 'signed_in' | 'not_run';
  // Tests (not the ones that sign in themselves) that ended on a login page or failed as logged out, in the final results.
  lostLoginTests: string[];
  diagnosis: string | null;
  warnings: string[];
}

export const GENERIC_LOGGED_OUT = /\b401\b|unauthori[sz]ed|session (?:has )?expired|(?:redirect\w*|navigat\w+) to [^\n]*(?:log-?in|sign-?in)/i;
// A page address that is a login page: /login, /signin, /sign-in, /auth, /sso ... as a path segment.
export const GENERIC_LOGIN_URL = /\/(?:log-?in|sign-?in|sign_in|auth|sso|session\/new)(?:[/?#]|$)/i;

// Did this test fail because it was logged out? Two independent signals, either is enough: the error says so, or the page it
// ended on (recorded by the diagnostics fixture) is a login page. A test that signs in itself is not judged: ending on the
// login page can be exactly what it checks.
export function lostLogin(t: TestResult, config: AutomationConfig): boolean {
  if (t.outcome !== 'failed' || t.ownSession) return false;
  const configured = config.auth.state?.loggedOutPattern;
  const errorPattern = configured ? new RegExp(configured, 'i') : GENERIC_LOGGED_OUT;
  const urlPattern = configured ? new RegExp(configured, 'i') : GENERIC_LOGIN_URL;
  return t.attempts.some((a) => a.errors.some((e) => errorPattern.test(`${e.message}\n${e.stack ?? ''}`)) || (a.finalUrl !== undefined && urlPattern.test(a.finalUrl)));
}

// Tests that failed in a way that points at being logged out. Only meaningful when saved state was reused.
export function authRejectedTests(results: ExecutionResults, config: AutomationConfig): TestResult[] {
  return results.tests.filter((t) => lostLogin(t, config));
}

// A fingerprint of the saved state file (null when absent), to tell whether the login step replaced the session during a run.
// Only the hash is kept; nothing of the content leaves this function.
export function stateFingerprint(rootDir: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(statePath(rootDir))).digest('hex');
  } catch {
    return null;
  }
}

export interface ManagedRunOptions extends InspectOptions {
  // Runs Playwright once with the given extra environment and returns the normalized results.
  runOnce: (env: NodeJS.ProcessEnv) => ExecutionResults;
}

function setupOutcome(results: ExecutionResults, rootDir: string): AuthRunInfo['setup'] {
  if (results.authSetup) return results.authSetup.outcome === 'passed' && readState(rootDir).ok ? 'passed' : 'failed';
  return readState(rootDir).ok ? 'passed' : 'failed';
}

export function runWithAuthState(rootDir: string, config: AutomationConfig, opts: ManagedRunOptions): ExecutionResults {
  if (config.auth.approach !== 'storage-state') return opts.runOnce({});
  const now = opts.now ?? new Date();
  const report = inspectAuthState(rootDir, config, opts);
  const info = (over: Partial<AuthRunInfo>): AuthRunInfo => ({
    decision: report.decision === 'reuse' ? 'reuse' : 'refresh', status: report.status, reason: report.reason, verifiedByApplication: report.verifiedByApplication,
    recovered: false, setup: 'not_run', gate: 'not_run', lostLoginTests: [], diagnosis: null, warnings: report.warnings, ...over,
  });
  const lost = (r: ExecutionResults): string[] => [...new Set(authRejectedTests(r, config).map((t) => t.testId))];

  if (report.decision !== 'reuse') {
    clearAuthState(rootDir); // never leave state we have just judged unusable where a failed login could resurrect it
    const results = opts.runOnce({ PIPELINE_AUTH_STATE: 'refresh' });
    const setup = setupOutcome(results, rootDir);
    if (setup === 'passed') writeAuthMeta(rootDir, config, now);
    return { ...results, authState: info({ setup, gate: setup === 'passed' ? 'signed_in' : 'not_run', lostLoginTests: lost(results) }) };
  }

  // The state looked fine on paper. The login step still asks the application before the tests start and signs in again when the
  // session is refused, so a session that ended since it was saved never reaches a test.
  const before = stateFingerprint(rootDir);
  const first = opts.runOnce({ PIPELINE_AUTH_STATE: 'reuse' });
  const firstSetup = setupOutcome(first, rootDir);
  const replaced = firstSetup === 'passed' && stateFingerprint(rootDir) !== before;
  if (replaced) writeAuthMeta(rootDir, config, now); // a new session was saved: its age starts now
  const rejected = authRejectedTests(first, config);
  // After a sign-in that just happened, being logged out means the account, not the saved session: a rerun would not change it.
  if (rejected.length === 0 || replaced) {
    return { ...first, authState: info({ setup: firstSetup, gate: replaced ? 'signed_in' : 'reused', lostLoginTests: lost(first) }) };
  }

  // The login step accepted the session but the tests were treated as logged out anyway: replace it and run again, once.
  clearAuthState(rootDir);
  const second = opts.runOnce({ PIPELINE_AUTH_STATE: 'refresh' });
  const setup = setupOutcome(second, rootDir);
  if (setup === 'passed') writeAuthMeta(rootDir, config, now);
  const diagnosis = `saved authentication state was rejected during the run (${rejected.length} test(s) ended logged out: ${rejected.map((t) => t.testId).slice(0, 5).join(', ')}); it was discarded, a fresh login was done and the tests were run again`;
  return { ...second, authState: info({ decision: 'refresh', status: 'rejected_by_app', reason: diagnosis, recovered: true, setup, gate: setup === 'passed' ? 'signed_in' : 'not_run', lostLoginTests: lost(second), diagnosis }) };
}

export function summarizeSecretsHandling(rootDir: string): { env: boolean; state: boolean; meta: boolean } {
  return { env: isIgnored(rootDir, '.env'), state: isIgnored(rootDir, AUTH_STATE_FILE), meta: isIgnored(rootDir, AUTH_META_FILE) };
}


// How many Playwright workers run, and how much runs in parallel inside a file, decided from what the project has
// declared about shared state. Pure: the same inputs give the same plan, so playwright.config.ts (inside Playwright) and
// the CLI (which records the plan with the results) always agree.
//
// Principles: start conservative and let measurement justify more; never run more workers than there are independent
// accounts when tests may change shared data; make every limit visible with its reason.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutomationConfig, IsolationMode } from '../config/schema.ts';
import { scanSessionTests, sessionSummary } from './session-layout.ts';

// Used when execution.workers is not set. Deliberately not Playwright's CPU-based default: more workers are only worth
// it after run-to-run measurements (see `run compare`) show no loss of correctness.
export const CONSERVATIVE_DEFAULT_WORKERS = 2;

export interface AccountPool {
  envVar: string; // credential variable the pool belongs to (NAME)
  size: number; // how many NAME_1..NAME_N are defined
}

export interface ExecutionPlan {
  workers: number;
  fullyParallel: boolean; // tests inside one file may also run in parallel
  isolation: IsolationMode | 'unspecified';
  requestedWorkers: number | null;
  workersSource: 'config' | 'default';
  limits: string[]; // why the worker count is lower than requested
  warnings: string[];
  accountPool: AccountPool[] | null; // only for per-worker-accounts
  // What the generated tests ask of the run beyond workers: tests that sign in themselves and chains that must run in order.
  session?: SessionPlan;
}

export interface SessionPlan {
  ownSessionTests: number; // tagged @own-session: start signed out and run last, in their own project
  // Start signed out but are not tagged (tests generated before the tag existed): they run alongside the others and can end their session.
  untaggedSignedOut: string[];
  serialGroups: number; // test.describe.serial groups: dependent tests that run in order on one worker
  notes: string[];
}

// Reads the generated spec files (tests/) for the two things that change how a run is ordered. Nothing here runs a test.
export function sessionPlan(rootDir: string, config: AutomationConfig): SessionPlan | null {
  const dir = path.join(rootDir, 'tests');
  const files = existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.spec\.(?:ts|js)$/.test(d.name)).map((d) => path.join(d.parentPath, d.name)) : [];
  let ownSessionTests = 0;
  let serialGroups = 0;
  const untaggedSignedOut: string[] = [];
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    const s = sessionSummary(source);
    ownSessionTests += s.ownSession;
    serialGroups += s.serialGroups;
    for (const t of scanSessionTests(source)) if (t.signedOut && !t.tagged) untaggedSignedOut.push(t.testId ?? t.title);
  }
  const storageState = config.auth.approach === 'storage-state';
  const notes: string[] = [];
  if (storageState && ownSessionTests > 0) {
    notes.push(`${ownSessionTests} test(s) sign in themselves (@own-session): they start signed out and run after every other test, so signing in again cannot end the session the others use`);
    if (config.browsers.length > 1) notes.push(`the @own-session tests run in ${config.browsers[0]} only (Playwright allows one teardown project)`);
  }
  if (storageState && untaggedSignedOut.length > 0) {
    notes.push(`${untaggedSignedOut.length} test(s) start signed out but are not tagged @own-session (${untaggedSignedOut.slice(0, 5).join(', ')}): they run alongside the tests that share the saved login, and signing in again as the same account can end that session. Generate the tests again (generate-tests) or add the tag`);
  }
  if (serialGroups > 0) notes.push(`${serialGroups} group(s) of dependent tests run in order, each on one worker; when one test fails the later ones in its group are skipped (reported as blocked)`);
  return !storageState && serialGroups === 0 ? null : { ownSessionTests, untaggedSignedOut, serialGroups, notes };
}

// NAME_1, NAME_2, ... counted while consecutive. Names only; values are never read here.
export function accountPool(envVars: readonly string[], env: NodeJS.ProcessEnv): AccountPool[] {
  return envVars.map((envVar) => {
    let size = 0;
    while (env[`${envVar}_${size + 1}`] !== undefined && env[`${envVar}_${size + 1}`] !== '') size++;
    return { envVar, size };
  });
}

export function resolveExecutionPlan(config: AutomationConfig, env: NodeJS.ProcessEnv, cpus: number = os.availableParallelism()): ExecutionPlan {
  const requested = config.execution.workers;
  const isolation = config.execution.isolation ?? 'unspecified';
  const limits: string[] = [];
  const warnings: string[] = [];
  let workers = requested ?? Math.min(CONSERVATIVE_DEFAULT_WORKERS, Math.max(1, cpus));
  if (requested !== null && requested > cpus) warnings.push(`${requested} workers requested on a machine with ${cpus} CPUs: measure before keeping this`);

  let pool: AccountPool[] | null = null;
  if (isolation === 'serial') {
    if (workers > 1) limits.push('isolation "serial": tests run one after another');
    workers = 1;
  } else if (isolation === 'per-worker-accounts') {
    pool = accountPool(config.auth.credentialEnvVars, env);
    const size = pool.length === 0 ? 0 : Math.min(...pool.map((p) => p.size));
    const incomplete = pool.filter((p) => p.size === 0).map((p) => p.envVar);
    if (size === 0) {
      limits.push(`isolation "per-worker-accounts" but no per-worker credentials were found (${incomplete.map((n) => `${n}_1`).join(', ')}): running one worker`);
      workers = 1;
    } else if (workers > size) {
      limits.push(`only ${size} account(s) defined for every credential: limited to ${size} worker(s)`);
      workers = size;
    }
  } else if (isolation === 'unspecified' && requested !== null && requested > 1 && config.auth.approach !== 'none') {
    warnings.push('several workers share one account; set execution.isolation ("shared-readonly" if tests never change shared data, "serial" if they do) to confirm this is safe');
  }

  return {
    workers, fullyParallel: isolation === 'shared-readonly' || isolation === 'per-worker-accounts', isolation,
    requestedWorkers: requested, workersSource: requested === null ? 'default' : 'config', limits, warnings, accountPool: pool,
  };
}

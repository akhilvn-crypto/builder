// The sweep after a run: removes the test data that is still listed in the run's created-data/ ledger. It only ever acts on that
// ledger (never a search, never a wildcard), only when cleanup.mode is "sweep" in an allowed non-production environment, and
// never more than cleanup.maxDeletesPerRun records. How a record is removed comes from config.cleanup.entities, which the user declared:
//   api  -> one HTTP call to the app's own origin (endpoints are never guessed), optionally checked afterwards;
//   ui   -> handed to the data-cleaner agent, which removes it through the app and reports back with `cleanup resolve`;
//   none -> reported as left behind, with what is known about removing it.
// Whatever is not removed is listed with the reason, so the user can delete it by hand.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig, CleanupEntity } from '../config/schema.ts';
import { DEFAULT_MAX_DELETES_PER_RUN } from '../config/schema.ts';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { withFileLock } from '../utils/lock.ts';
import { redactAll } from '../utils/redact.ts';
import { stateDir } from '../utils/layout.ts';
import { ARTIFACTS, runDir } from './artifact-manager.ts';
import {
  cleanupGuard, leftoverLines, readCreatedData, summarizeData, updateRecords, SAFE_IDENTIFIER,
  type CleanupGuard, type CreatedRecord, type DataSummary, type LoadedRecord, type RecordStatus,
} from './created-data.ts';

export const DATA_CLEANUP_SCHEMA_VERSION = 1;
export const ADHOC_LEDGER_DIR = 'adhoc-data'; // inside dependencies/state/
const KEEP_SWEEPS = 10;
const MAX_UI_TASKS = 25;
const HTTP_TIMEOUT_MS = 15_000;

// One HTTP request, answered synchronously (the CLI is synchronous). The default runs it in a child process that reads the request
// (including the header values, which therefore never appear on a command line) from stdin.
export type Fetcher = (req: { url: string; method: string; headers: Record<string, string>; timeoutMs: number }) => { status: number };

export interface SweepOptions {
  trigger: string;
  dryRun?: boolean;
  fetch?: Fetcher;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface SweepAction {
  id: string;
  entity: string;
  identifier: string;
  action: 'api_delete' | 'needs_ui' | 'no_cleanup_path' | 'blocked' | 'already_removed';
  result: RecordStatus;
  detail: string | null;
}

export interface UiTask {
  id: string;
  entity: string;
  identifier: string;
  how: string; // the hint: where and how this record is removed in the UI
  testId: string | null;
}

export interface SweepReport {
  trigger: string;
  at: string;
  dryRun: boolean;
  ran: boolean; // false: the guard did not allow deleting, so nothing was attempted
  guard: Pick<CleanupGuard, 'allowed' | 'mode' | 'environment' | 'reason'>;
  actions: SweepAction[];
  uiTasks: UiTask[]; // at most MAX_UI_TASKS: the data-cleaner agent gets a bounded brief, the rest follow after it reports
  uiTasksOmitted: number;
  summary: { total: number; removed: number; byStatus: DataSummary['byStatus']; leftovers: number };
  leftoverLines: string[];
}

interface History {
  schemaVersion: typeof DATA_CLEANUP_SCHEMA_VERSION;
  sweeps: SweepReport[];
}

function historyFile(runDirectory: string): string {
  return path.join(runDirectory, ARTIFACTS.dataCleanup);
}

export function readSweepHistory(runDirectory: string): SweepReport[] {
  const j = readJson(historyFile(runDirectory));
  if (!j.ok || typeof j.value !== 'object' || j.value === null) return [];
  const h = j.value as Partial<History>;
  return h.schemaVersion === DATA_CLEANUP_SCHEMA_VERSION && Array.isArray(h.sweeps) ? h.sweeps : [];
}

function saveSweep(runDirectory: string, report: SweepReport): void {
  withFileLock(path.join(runDirectory, '.data-cleanup.lock'), () => {
    const history: History = { schemaVersion: DATA_CLEANUP_SCHEMA_VERSION, sweeps: [...readSweepHistory(runDirectory), report].slice(-KEEP_SWEEPS) };
    writeJsonAtomic(historyFile(runDirectory), history);
  });
}

const CHILD = [
  "const req = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "const c = new AbortController(); const t = setTimeout(() => c.abort(), req.timeoutMs);",
  "fetch(req.url, { method: req.method, headers: req.headers, redirect: 'manual', signal: c.signal })",
  ".then((r) => { process.stdout.write(JSON.stringify({ status: r.status })); })",
  ".catch((e) => { process.stdout.write(JSON.stringify({ error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) })); })",
  ".finally(() => clearTimeout(t));",
].join('\n');

const realFetch: Fetcher = (req) => {
  const r = spawnSync(process.execPath, ['-e', CHILD], { input: JSON.stringify(req), encoding: 'utf8', timeout: req.timeoutMs + 5_000, windowsHide: true });
  if (r.error) throw new Error(r.error.message);
  let answer: { status?: number; error?: string };
  try {
    answer = JSON.parse(r.stdout) as { status?: number; error?: string };
  } catch {
    throw new Error('the request helper gave no answer');
  }
  if (answer.error === 'timeout') throw Object.assign(new Error('timeout'), { name: 'AbortError' });
  if (typeof answer.status !== 'number') throw new Error(answer.error ?? 'no status');
  return { status: answer.status };
};

// The path with the identifier in, on the app's own origin. Anything that would leave the origin is refused.
export function resolveUrl(baseUrl: string, template: string, identifier: string): URL | null {
  if (!SAFE_IDENTIFIER.test(identifier)) return null;
  const base = new URL(baseUrl);
  const url = new URL(template.replace('{id}', encodeURIComponent(identifier)), base.origin);
  return url.origin === base.origin ? url : null;
}

function headersFor(api: NonNullable<CleanupEntity['api']>, env: NodeJS.ProcessEnv): { headers: Record<string, string> } | { missing: string } {
  const headers: Record<string, string> = {};
  for (const [name, variable] of Object.entries(api.headersFromEnv ?? {})) {
    const value = env[variable];
    if (value === undefined || value === '') return { missing: variable };
    headers[name] = value;
  }
  return { headers };
}

function call(fetcher: Fetcher, url: URL, method: string, headers: Record<string, string>): number {
  return fetcher({ url: url.toString(), method, headers, timeoutMs: HTTP_TIMEOUT_MS }).status;
}

const GONE = (status: number): boolean => status === 404 || status === 410;

function secretsOf(config: AutomationConfig, env: NodeJS.ProcessEnv): string[] {
  const names = [...config.auth.credentialEnvVars, ...Object.values(config.cleanup?.entities ?? {}).flatMap((e) => Object.values(e.api?.headersFromEnv ?? {}))];
  return names.map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function removeThroughApi(
  r: LoadedRecord, api: NonNullable<CleanupEntity['api']>, config: AutomationConfig, o: { fetcher: Fetcher; env: NodeJS.ProcessEnv; dryRun: boolean },
): { result: RecordStatus; detail: string | null } {
  const url = resolveUrl(config.app.baseUrl, api.path, r.identifier);
  if (!url) return { result: 'failed', detail: 'the identifier or path does not stay on the app origin' };
  if (o.dryRun) return { result: r.status, detail: `would ${api.method} ${url.pathname}` };
  const h = headersFor(api, o.env);
  if ('missing' in h) return { result: 'failed', detail: `environment variable ${h.missing} is not set` };
  try {
    const status = call(o.fetcher, url, api.method, h.headers);
    if (!((status >= 200 && status < 300) || GONE(status))) return { result: 'failed', detail: `${api.method} ${url.pathname} answered ${status}` };
    if (!api.verifyPath) return { result: 'deleted', detail: `${api.method} ${url.pathname} answered ${status}` };
    const check = resolveUrl(config.app.baseUrl, api.verifyPath, r.identifier);
    if (!check) return { result: 'deleted', detail: 'deleted; the verify path was not usable' };
    const seen = call(o.fetcher, check, 'GET', h.headers);
    return GONE(seen)
      ? { result: 'verified_gone', detail: `${api.method} ${url.pathname} answered ${status}; GET answers ${seen}` }
      : { result: 'failed', detail: `deleted, but GET ${check.pathname} still answers ${seen}` };
  } catch (err) {
    const e = err as Error;
    return { result: 'failed', detail: e.name === 'AbortError' ? `no answer within ${HTTP_TIMEOUT_MS}ms` : e.message };
  }
}

// Records a sweep still has to look at: not removed, and not already handed to the agent unless asked again.
const OPEN: readonly RecordStatus[] = ['pending', 'failed', 'no_cleanup_path', 'blocked'];

export function sweepData(rootDir: string, runId: string, config: AutomationConfig | null, opts: SweepOptions): SweepReport {
  return sweepLedger(runDir(rootDir, runId), config, opts);
}

// A plain `playwright test` (npm run test:adhoc / test:ui, npx playwright test) has no run, so its ledger lives here instead.
export function adhocLedgerDir(rootDir: string): string {
  return path.join(stateDir(rootDir), ADHOC_LEDGER_DIR);
}

export function sweepAdhoc(rootDir: string, config: AutomationConfig | null, opts: SweepOptions): SweepReport {
  return sweepLedger(adhocLedgerDir(rootDir), config, opts);
}

export function sweepLedger(dir: string, config: AutomationConfig | null, opts: SweepOptions): SweepReport {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;
  const fetcher = opts.fetch ?? realFetch;
  const now = opts.now ?? new Date();
  const guard = cleanupGuard(config);
  const records = existsSync(dir) ? readCreatedData(dir) : [];
  const actions: SweepAction[] = [];
  const uiTasks: UiTask[] = [];
  const patches = new Map<string, Partial<Pick<CreatedRecord, 'status' | 'removedBy' | 'error'>>>();
  const sweeping = guard.allowed && guard.mode === 'sweep' && config !== null;

  if (sweeping) {
    const secrets = secretsOf(config, env);
    const limit = config.cleanup?.maxDeletesPerRun ?? DEFAULT_MAX_DELETES_PER_RUN;
    let tried = 0;
    for (const r of records.filter((x) => OPEN.includes(x.status) || x.status === 'needs_ui')) {
      const entity = config.cleanup?.entities?.[r.entity];
      const note = (action: SweepAction['action'], result: RecordStatus, detail: string | null): void => {
        actions.push({ id: r.id, entity: r.entity, identifier: r.identifier, action, result, detail: detail ? redactAll(detail, secrets) : null });
      };
      if (r.status === 'needs_ui') { // already handed to the agent: it stays on the list until the agent reports
        uiTasks.push({ id: r.id, entity: r.entity, identifier: r.identifier, how: r.hint ?? entity?.ui?.hint ?? '', testId: r.testId });
        continue;
      }
      if (tried >= limit) {
        note('blocked', 'blocked', `more than cleanup.maxDeletesPerRun (${limit}) records; the rest are left for you`);
        patches.set(r.id, { status: 'blocked', error: `over the per-run limit of ${limit} deletions` });
        continue;
      }
      if (entity?.api) {
        tried++;
        const out = removeThroughApi(r, entity.api, config, { fetcher, env, dryRun });
        note('api_delete', out.result, out.detail);
        if (!dryRun) patches.set(r.id, { status: out.result, removedBy: out.result === 'failed' ? null : 'api', error: out.result === 'failed' ? redactAll(out.detail ?? 'failed', secrets) : null });
        continue;
      }
      const how = r.hint ?? entity?.ui?.hint ?? null;
      if (entity?.ui || r.hint) {
        note('needs_ui', 'needs_ui', how);
        uiTasks.push({ id: r.id, entity: r.entity, identifier: r.identifier, how: how ?? '', testId: r.testId });
        if (!dryRun) patches.set(r.id, { status: 'needs_ui', error: null });
        continue;
      }
      note('no_cleanup_path', 'no_cleanup_path', 'no api or ui way to remove this entity is declared in config.cleanup.entities');
      if (!dryRun && r.status !== 'no_cleanup_path') patches.set(r.id, { status: 'no_cleanup_path', error: null });
    }
    if (!dryRun) updateRecords(dir, patches, now);
  }

  // Blocked records (cleanup off, wrong environment) keep their reason in the ledger already; a sweep that is not allowed changes nothing.
  const after = existsSync(dir) ? readCreatedData(dir) : records;
  const summary = summarizeData(after, config);
  const report: SweepReport = {
    trigger: opts.trigger, at: now.toISOString(), dryRun, ran: sweeping,
    guard: { allowed: guard.allowed, mode: guard.mode, environment: guard.environment, reason: guard.reason ?? (guard.mode === 'test' ? 'cleanup.mode is "test": each test removes its own data, there is no sweep after the run' : null) },
    actions, uiTasks: uiTasks.slice(0, MAX_UI_TASKS), uiTasksOmitted: Math.max(0, uiTasks.length - MAX_UI_TASKS),
    summary: { total: summary.total, removed: summary.removed, byStatus: summary.byStatus, leftovers: summary.leftovers.length },
    leftoverLines: leftoverLines(summary),
  };
  // Nothing to say (no data was created, nothing was attempted): keep the ledger quiet.
  if (!dryRun && existsSync(dir) && (records.length > 0 || actions.length > 0)) saveSweep(dir, report);
  return report;
}

// What the CLI prints after a stage: nothing when no data was ever created.
export interface DataBrief {
  trigger: string;
  created: number;
  removed: number;
  leftovers: number;
  needsUi: number;
  note?: string;
  lines: string[];
}

export function briefOfSweep(r: SweepReport): DataBrief | null {
  if (r.summary.total === 0) return null;
  return {
    trigger: r.trigger, created: r.summary.total, removed: r.summary.removed, leftovers: r.summary.leftovers, needsUi: r.uiTasks.length + r.uiTasksOmitted,
    ...(r.guard.reason && r.summary.leftovers > 0 ? { note: r.guard.reason } : {}),
    lines: r.leftoverLines,
  };
}

// Never throws: a cleanup problem must not undo the state change that triggered it.
export function sweepDataSafely(rootDir: string, runId: string, config: AutomationConfig | null, opts: SweepOptions): DataBrief | null {
  try {
    return briefOfSweep(sweepData(rootDir, runId, config, opts));
  } catch (err) {
    return { trigger: opts.trigger, created: 0, removed: 0, leftovers: 0, needsUi: 0, note: `data cleanup failed: ${(err as Error).message}`, lines: [] };
  }
}

// Stages after which test data may exist: any that runs tests, and every stage that stops the run.
const RUNS_TESTS = ['execution', 'healing', 'regression_validation'];
const ENDED = ['completed', 'failed', 'blocked', 'cancelled', 'skipped'];

export function dataSweepTrigger(stage: string, status: string): string | null {
  if (RUNS_TESTS.includes(stage) && ENDED.includes(status)) return `${stage} ${status}`;
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') return `${stage} ${status}`;
  return null;
}

// The test data a run created, and what became of it. Tests (through the `cleanup` fixture) and the explorer (through
// `cleanup record`) register every record they create; the record is written to the run's created-data/ folder BEFORE anything
// tries to delete it, so a test that times out or a worker that dies still leaves a trace. Deleting happens in two places:
//   - in the test, right after it ends (CleanupSession.run, LIFO), when the test registered an undo (mode "test" only);
//   - in a sweep after the run (data-cleanup.ts), for whatever is still listed here, through a way the user declared. The sweep runs
//     once every test has finished (mode "sweep" only): after the stage in a pipeline run, after `npm run test:adhoc` / `test:ui` for a plain run.
// Only what is listed here is ever deleted, and only in an environment the user allowed (never production). No Playwright import.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig, CleanupMode } from '../config/schema.ts';
import { PRODUCTION_ENVIRONMENT } from '../config/schema.ts';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { withFileLock } from '../utils/lock.ts';
import { ARTIFACTS } from './artifact-manager.ts';

export const CREATED_DATA_SCHEMA_VERSION = 1;

// pending: registered, deletion not confirmed. deleted / verified_gone: removed (the latter also checked absent afterwards).
// failed: a deletion was tried and did not work. no_cleanup_path: nothing known removes it. needs_ui: waits for the data-cleaner agent.
// blocked: cleanup was not allowed (mode, environment or the per-run cap), so nothing was tried.
export const RECORD_STATUSES = ['pending', 'deleted', 'verified_gone', 'failed', 'no_cleanup_path', 'needs_ui', 'blocked'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export const REMOVED: readonly RecordStatus[] = ['deleted', 'verified_gone'];

export type RecordSource = 'test' | 'explorer';
export type RemovedBy = 'test' | 'api' | 'ui-agent';

export interface CreatedRecord {
  id: string; // unique within the run: <file key>.<n>
  entity: string; // the kind of record, e.g. "order" (keys config.cleanup.entities)
  identifier: string; // what the app knows it by: the unique name the test gave it, or the id it returned
  hint: string | null; // how a person removes it, for the "can be deleted" list
  registeredAt: string;
  status: RecordStatus;
  removedBy: RemovedBy | null;
  error: string | null; // why it is not removed (redacted, short)
  updatedAt: string;
}

export interface CreatedDataFile {
  schemaVersion: typeof CREATED_DATA_SCHEMA_VERSION;
  source: RecordSource;
  label: string; // the execution label ("initial", "regression", ...) or "exploration"
  testKey: string | null; // file + title of the test (null for the explorer)
  testId: string | null;
  retry: number;
  records: CreatedRecord[];
}

export interface LoadedRecord extends CreatedRecord {
  file: string; // absolute path of the file that holds it
  source: RecordSource;
  label: string;
  testKey: string | null;
  testId: string | null;
  retry: number;
}

// An identifier goes into a URL path and into reports: plain characters only.
export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,120}$/;
export const ENTITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

const dataDir = (runDirectory: string): string => path.join(runDirectory, ARTIFACTS.createdData);
const lockFor = (runDirectory: string): string => path.join(runDirectory, '.created-data.lock');

export function fileKeyOf(parts: string): string {
  const slug = parts.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'test';
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

function oneLine(text: string, max = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---- reading and writing ----

export function readCreatedData(runDirectory: string): LoadedRecord[] {
  const base = dataDir(runDirectory);
  if (!existsSync(base)) return [];
  const out: LoadedRecord[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.json')) {
        const j = readJson(abs);
        if (!j.ok || typeof j.value !== 'object' || j.value === null) continue;
        const f = j.value as Partial<CreatedDataFile>;
        if (f.schemaVersion !== CREATED_DATA_SCHEMA_VERSION || !Array.isArray(f.records)) continue;
        for (const r of f.records) {
          if (!r || typeof r.id !== 'string' || typeof r.entity !== 'string' || typeof r.identifier !== 'string') continue;
          out.push({
            ...r, file: abs, source: f.source ?? 'test', label: f.label ?? '', testKey: f.testKey ?? null, testId: f.testId ?? null, retry: f.retry ?? 0,
          });
        }
      }
    }
  };
  walk(base);
  return out.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.id.localeCompare(b.id));
}

function writeFile(file: string, doc: CreatedDataFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, doc);
}

// Changes records in place (by id), under the run's lock, so a sweep and the CLI never overwrite each other.
export function updateRecords(runDirectory: string, patches: Map<string, Partial<Pick<CreatedRecord, 'status' | 'removedBy' | 'error'>>>, now = new Date()): number {
  if (patches.size === 0 || !existsSync(dataDir(runDirectory))) return 0;
  return withFileLock(lockFor(runDirectory), () => {
    let changed = 0;
    const byFile = new Map<string, LoadedRecord[]>();
    for (const r of readCreatedData(runDirectory)) {
      if (patches.has(r.id)) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
    }
    for (const file of byFile.keys()) {
      const j = readJson(file);
      if (!j.ok) continue;
      const doc = j.value as CreatedDataFile;
      doc.records = doc.records.map((r) => {
        const p = patches.get(r.id);
        if (!p) return r;
        changed++;
        return { ...r, ...p, error: p.error === undefined ? r.error : p.error === null ? null : oneLine(p.error), updatedAt: now.toISOString() };
      });
      writeFile(file, doc);
    }
    return changed;
  });
}

export interface NewRecord {
  entity: string;
  identifier: string;
  hint?: string | null;
}

export function validateNewRecord(r: NewRecord): string | null {
  if (!ENTITY_NAME.test(r.entity)) return `entity "${r.entity}" must be a short word (letters, digits, - and _)`;
  if (!SAFE_IDENTIFIER.test(r.identifier)) return `identifier "${r.identifier}" may only use letters, digits and . _ : @ - (max 121 characters)`;
  return null;
}

function newRecord(fileKey: string, n: number, r: NewRecord, status: RecordStatus, error: string | null, now: Date): CreatedRecord {
  return {
    id: `${fileKey}.${n}`, entity: r.entity, identifier: r.identifier, hint: r.hint ? oneLine(r.hint, 200) : null,
    registeredAt: now.toISOString(), status, removedBy: null, error: error ? oneLine(error) : null, updatedAt: now.toISOString(),
  };
}

// The explorer (or anyone using the CLI) records a record they created: its own small file, written once.
export function recordExternally(runDirectory: string, r: NewRecord, now = new Date()): CreatedRecord {
  const problem = validateNewRecord(r);
  if (problem) throw new Error(problem);
  const key = fileKeyOf(`${r.entity}-${r.identifier}`);
  const rec = newRecord(key, 1, r, 'pending', null, now);
  const doc: CreatedDataFile = { schemaVersion: CREATED_DATA_SCHEMA_VERSION, source: 'explorer', label: 'exploration', testKey: null, testId: null, retry: 0, records: [rec] };
  writeFile(path.join(dataDir(runDirectory), 'exploration', `${key}.json`), doc);
  return rec;
}

// ---- may data be deleted here? ----

export interface CleanupGuard {
  allowed: boolean;
  mode: CleanupMode | 'unset';
  environment: string | null;
  reason: string | null; // why not, when not allowed
}

// The one place that decides whether data may be deleted: a valid config that turns cleanup on, in an environment the user listed
// and that is not production. Anything else is "blocked", never an error and never a deletion.
export function cleanupGuard(config: AutomationConfig | null): CleanupGuard {
  if (!config) return { allowed: false, mode: 'unset', environment: null, reason: 'the pipeline configuration is missing or invalid' };
  const environment = config.app.environment;
  const cleanup = config.cleanup;
  if (!cleanup) return { allowed: false, mode: 'unset', environment, reason: 'cleanup is not configured (config.cleanup is absent)' };
  if (PRODUCTION_ENVIRONMENT.test(environment.trim())) {
    return { allowed: false, mode: cleanup.mode, environment, reason: `environment "${environment}" is a production environment: test data is never deleted there` };
  }
  const listed = cleanup.allowedEnvironments.some((e) => e.trim().toLowerCase() === environment.trim().toLowerCase());
  if (!listed) {
    return { allowed: false, mode: cleanup.mode, environment, reason: `environment "${environment}" is not in cleanup.allowedEnvironments (${cleanup.allowedEnvironments.join(', ') || 'empty'})` };
  }
  return { allowed: true, mode: cleanup.mode, environment, reason: null };
}

// ---- inside a test ----

export interface RegisterInput extends NewRecord {
  // Removes the record through the app, as the test itself did to create it. Absent: nothing in the test removes it (the sweep may).
  undo?: () => Promise<void> | void;
  // Returns true when the record is gone. Optional; when it says so the record is `verified_gone`.
  verify?: () => Promise<boolean> | boolean;
}

export interface SessionOptions {
  runDirectory: string | null; // null: not part of a pipeline run (plain Playwright): nothing is written
  label: string;
  testKey: string;
  testId: string | null;
  retry: number;
  guard: CleanupGuard;
  redact?: (text: string) => string;
  undoTimeoutMs?: number;
  now?: () => Date;
}

export interface SessionOutcome {
  id: string;
  entity: string;
  identifier: string;
  status: RecordStatus;
  error: string | null;
}

const DEFAULT_UNDO_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// One test attempt's registrations. `register` writes the ledger file at once; `run` (after the test, also a failed or timed-out one)
// undoes the records in reverse order and never throws: a cleanup problem is reported, it does not turn a passing test into a failure.
export class CleanupSession {
  private readonly opts: SessionOptions;
  private readonly key: string;
  private readonly items: { record: CreatedRecord; undo?: RegisterInput['undo']; verify?: RegisterInput['verify'] }[] = [];

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.key = fileKeyOf(`${opts.testId ?? opts.testKey}-r${opts.retry}`);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private file(): string | null {
    return this.opts.runDirectory ? path.join(dataDir(this.opts.runDirectory), this.opts.label, `${this.key}.json`) : null;
  }

  private save(): void {
    const file = this.file();
    if (!file) return;
    writeFile(file, {
      schemaVersion: CREATED_DATA_SCHEMA_VERSION, source: 'test', label: this.opts.label, testKey: this.opts.testKey, testId: this.opts.testId,
      retry: this.opts.retry, records: this.items.map((i) => i.record),
    });
  }

  register(input: RegisterInput): void {
    const problem = validateNewRecord(input);
    if (problem) throw new Error(`cleanup.register: ${problem}`);
    const noPath = input.undo === undefined;
    const status: RecordStatus = !this.opts.guard.allowed ? 'blocked' : noPath ? 'no_cleanup_path' : 'pending';
    const record = newRecord(this.key, this.items.length + 1, input, status, !this.opts.guard.allowed ? this.opts.guard.reason : null, this.now());
    this.items.push({ record, undo: input.undo, verify: input.verify });
    this.save(); // before anything can go wrong with the test
  }

  get records(): readonly CreatedRecord[] {
    return this.items.map((i) => i.record);
  }

  // Mode "sweep": nothing is deleted while tests are still running (a later test may need the record); the ledger keeps it pending and
  // the sweep after the last test removes it through the declared API or UI.
  async run(): Promise<SessionOutcome[]> {
    const redact = this.opts.redact ?? ((t: string) => t);
    const timeout = this.opts.undoTimeoutMs ?? DEFAULT_UNDO_TIMEOUT_MS;
    const deferred = this.opts.guard.mode === 'sweep';
    for (const item of deferred ? [] : [...this.items].reverse()) {
      const r = item.record;
      if (r.status !== 'pending' || !item.undo) continue;
      try {
        await withTimeout(Promise.resolve(item.undo()), timeout);
        r.status = 'deleted';
        r.removedBy = 'test';
        r.error = null;
        if (item.verify) {
          try {
            if (await withTimeout(Promise.resolve(item.verify()), timeout)) r.status = 'verified_gone';
            else { r.status = 'failed'; r.error = 'the undo finished but the record is still there'; }
          } catch (err) {
            r.error = redact(oneLine(`deleted, but the check afterwards failed: ${(err as Error).message}`)); // stays "deleted": the undo itself worked
          }
        }
      } catch (err) {
        r.status = 'failed';
        r.error = redact(oneLine((err as Error).message || String(err)));
      }
      r.updatedAt = this.now().toISOString();
    }
    this.save();
    // A record still pending is waiting for the sweep (mode "sweep"): not a problem the test should report.
    return this.items.filter((i) => i.record.status !== 'pending')
      .map((i) => ({ id: i.record.id, entity: i.record.entity, identifier: i.record.identifier, status: i.record.status, error: i.record.error }));
  }
}

// ---- summaries ----

export interface Leftover {
  id: string;
  entity: string;
  identifier: string;
  status: RecordStatus;
  testId: string | null;
  reason: string; // why it was not removed
  canBeDeletedBy: string | null; // what the user can do to remove it
}

export interface DataSummary {
  total: number;
  removed: number;
  byStatus: Partial<Record<RecordStatus, number>>;
  leftovers: Leftover[];
}

export function describeRemoval(r: Pick<CreatedRecord, 'hint' | 'entity'>, config: AutomationConfig | null): string | null {
  const entity = config?.cleanup?.entities?.[r.entity];
  if (r.hint) return r.hint;
  if (entity?.ui) return entity.ui.hint;
  if (entity?.api) return `${entity.api.method} ${entity.api.path.replace('{id}', '<identifier>')}`;
  return null;
}

export function summarizeData(records: readonly LoadedRecord[], config: AutomationConfig | null): DataSummary {
  const byStatus: Partial<Record<RecordStatus, number>> = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const leftovers = records.filter((r) => !REMOVED.includes(r.status)).map((r): Leftover => ({
    id: r.id, entity: r.entity, identifier: r.identifier, status: r.status, testId: r.testId,
    reason: r.error ?? (r.status === 'no_cleanup_path' ? 'no way to remove it is known' : r.status === 'needs_ui' ? 'waits for removal through the UI' : 'not removed'),
    canBeDeletedBy: describeRemoval(r, config),
  }));
  return { total: records.length, removed: records.length - leftovers.length, byStatus, leftovers };
}

// What the end-of-run summary and the console show: counts and a bounded list, never the whole ledger.
export function leftoverLines(summary: DataSummary, limit = 20): string[] {
  const lines = summary.leftovers.slice(0, limit).map((l) => {
    const how = l.canBeDeletedBy ? ` — can be deleted: ${l.canBeDeletedBy}` : ' — no removal path is known; delete it by hand';
    return `${l.entity} "${l.identifier}"${l.testId ? ` (${l.testId})` : ''}: ${l.reason}${how}`;
  });
  if (summary.leftovers.length > limit) lines.push(`… and ${summary.leftovers.length - limit} more (see created-data/ in the run folder)`);
  return lines;
}

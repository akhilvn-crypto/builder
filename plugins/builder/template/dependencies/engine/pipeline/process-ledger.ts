// The processes a run started, so they can be stopped later even when the process that started them is gone (crash, Ctrl+C,
// closed terminal). processes.json in the run directory lists them with their start time (a pid alone is not an identity: pids
// are reused) and keeps the last cleanups. A process that is not listed here, and is not a named playwright-cli session of the
// run, is never stopped by the pipeline.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { withFileLock } from '../utils/lock.ts';
import type { ProcRef } from '../utils/process-tree.ts';
import { ARTIFACTS } from './artifact-manager.ts';

export const LEDGER_SCHEMA_VERSION = 1;
const KEEP_CLEANUPS = 10;

export interface LedgerEntry extends ProcRef {
  name: string;
  role: string; // what it was started for, e.g. "playwright:initial", "evidence-pdf", "allure"
  owner: ProcRef | null; // the supervising process; while it is alive the entry is still in use
  recordedAt: string;
}

export interface CleanupRecord {
  at: string;
  trigger: string;
  stopped: { pid: number; name: string; role: string }[];
  sessions: { name: string; closed: 'gracefully' | 'forced' | 'not_stopped' | 'pending' }[]; // pending: seen in a dry run
  stillRunning: { pid: number; name: string; role: string }[];
  tempProfilesRemoved: number;
}

export interface Ledger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  entries: LedgerEntry[];
  cleanups: CleanupRecord[];
}

export function emptyLedger(): Ledger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [], cleanups: [] };
}

export function ledgerFile(runDirectory: string): string {
  return path.join(runDirectory, ARTIFACTS.processes);
}

function lockFor(runDirectory: string): string {
  return path.join(runDirectory, '.processes.lock');
}

// A missing or unreadable ledger is an empty one: it only ever adds safety, never state the run depends on.
export function readLedger(runDirectory: string): Ledger {
  const j = readJson(ledgerFile(runDirectory));
  if (!j.ok || typeof j.value !== 'object' || j.value === null) return emptyLedger();
  const v = j.value as Partial<Ledger>;
  if (v.schemaVersion !== LEDGER_SCHEMA_VERSION) return emptyLedger();
  const entry = (e: unknown): e is LedgerEntry => {
    const x = e as Partial<LedgerEntry> | null;
    return !!x && Number.isInteger(x.pid) && typeof x.started === 'number' && typeof x.name === 'string' && typeof x.role === 'string';
  };
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    entries: Array.isArray(v.entries) ? v.entries.filter(entry) : [],
    cleanups: Array.isArray(v.cleanups) ? v.cleanups : [],
  };
}

function update(runDirectory: string, change: (ledger: Ledger) => Ledger): void {
  if (!existsSync(runDirectory)) return; // not a run directory (for example a stand-alone tool call): nothing to record into
  withFileLock(lockFor(runDirectory), () => {
    writeJsonAtomic(ledgerFile(runDirectory), change(readLedger(runDirectory)));
  });
}

export function recordProcesses(runDirectory: string, entries: LedgerEntry[]): void {
  if (entries.length === 0) return;
  update(runDirectory, (ledger) => {
    const have = new Set(ledger.entries.map((e) => `${e.pid}:${e.started}`));
    return { ...ledger, entries: [...ledger.entries, ...entries.filter((e) => !have.has(`${e.pid}:${e.started}`))] };
  });
}

// Drops the entries that are no longer running and appends the cleanup to the history.
export function finishCleanup(runDirectory: string, running: ProcRef[], record: CleanupRecord | null): void {
  update(runDirectory, (ledger) => {
    const keep = new Set(running.map((r) => `${r.pid}:${r.started}`));
    return {
      ...ledger,
      entries: ledger.entries.filter((e) => keep.has(`${e.pid}:${e.started}`)),
      cleanups: record ? [...ledger.cleanups, record].slice(-KEEP_CLEANUPS) : ledger.cleanups,
    };
  });
}

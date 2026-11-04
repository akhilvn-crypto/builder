// Cross-process advisory lock for read-modify-write of shared state files (run manifests, the observation
// store, the artifact cache, agent usage). The CLI is invoked as separate processes, so parallel workers
// (batched generation, concurrent stage agents) can race on the same file; a lock directory makes each
// update atomic. mkdir is atomic on every OS, so no dependency is needed.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class LockTimeoutError extends Error {}

export interface LockOptions {
  timeoutMs?: number; // how long to wait for the lock
  staleMs?: number; // a lock older than this belongs to a crashed holder and is broken
}

const DEFAULTS = { timeoutMs: 15_000, staleMs: 30_000 };
const OWNER_FILE = 'owner.json';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(lockDir: string): string | null {
  try {
    return (JSON.parse(readFileSync(path.join(lockDir, OWNER_FILE), 'utf8')) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

function lockAge(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null; // gone
  }
}

// Moves a stale lock aside (rename is atomic, so only one contender wins) and discards it. If the moved lock turns out
// to be a live one that another process re-created in the meantime, it is put back.
function breakStale(lockDir: string, observed: string | null): void {
  const aside = `${lockDir}.stale-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockDir, aside);
  } catch {
    return; // someone else broke it or released it
  }
  if (observed !== null && readOwner(aside) !== observed) {
    try {
      renameSync(aside, lockDir);
      return;
    } catch {
      // the lock was re-created again; fall through and drop the copy we hold
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

// Runs fn while holding the lock at `lockPath` (a directory path that must not be used for anything else).
export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const { timeoutMs, staleMs } = { ...DEFAULTS, ...opts };
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let wait = 5; ; wait = Math.min(wait * 2, 80)) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(path.join(lockPath, OWNER_FILE), JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
      } catch (err) {
        rmSync(lockPath, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = lockAge(lockPath);
      if (age !== null && age > staleMs) breakStale(lockPath, readOwner(lockPath));
      else if (Date.now() >= deadline) throw new LockTimeoutError(`could not lock ${path.basename(lockPath)} within ${timeoutMs}ms (held by another process)`);
      else sleepSync(wait + Math.floor(Math.random() * wait));
    }
  }
  try {
    return fn();
  } finally {
    // Only release a lock that is still ours: if it was broken as stale, someone else may hold it now.
    if (readOwner(lockPath) === token) rmSync(lockPath, { recursive: true, force: true });
  }
}

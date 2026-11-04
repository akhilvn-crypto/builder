// Finding and stopping the processes the pipeline starts, without installing anything. A browser, a worker or a dev server
// started by a test run is a child of the runner; when the runner is killed (timeout, interrupt) or exits without cleaning up,
// those children are left running. This module lists processes, follows parent links (also through a parent that has already
// exited) and stops an explicit set of them. It never stops a process by name alone: callers pass processes they can attribute
// to a run (descendants of something the pipeline started, or a named playwright-cli session of that run).

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  started: number; // epoch ms; with the pid it identifies one process (pids are reused)
}

export interface ProcRef {
  pid: number;
  started: number;
}

// How far two start times may differ and still be the same process (ps reports whole seconds).
export const START_SLACK_MS = 1500;

export interface ProcessOps {
  list(): ProcInfo[];
  // Stops exactly these processes. No tree walking.
  kill(pids: number[]): void;
  // Stops a process and everything below it, found from a fresh listing.
  killTree(pid: number): void;
  sleep(ms: number): void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- listing ----

// One line of single-quoted PowerShell (no double quotes, so it survives argument quoting unchanged).
const WINDOWS_LIST_COMMAND = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
  "$rows = @(Get-CimInstance Win32_Process | ForEach-Object {",
  "$s = 0; if ($_.CreationDate) { $s = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() };",
  "[pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; n = [string]$_.Name; c = [string]$_.CommandLine; s = $s } });",
  "ConvertTo-Json -InputObject $rows -Compress",
].join(' ');

export function parseWindowsList(json: string): ProcInfo[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json.trim().replace(/^﻿/, ''));
  } catch {
    return [];
  }
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const out: ProcInfo[] = [];
  for (const r of list as { p?: number; q?: number; n?: string; c?: string; s?: number }[]) {
    if (typeof r.p === 'number' && typeof r.q === 'number') out.push({ pid: r.p, ppid: r.q, name: r.n ?? '', cmd: r.c ?? '', started: r.s ?? 0 });
  }
  return out;
}

// `ps -axo pid=,ppid=,lstart=,args=` lines, e.g. "  412     1 Tue Oct 21 11:40:21 2026 /usr/bin/node cliDaemon.js explore-x".
export function parsePsList(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[4] ?? '';
    const first = (cmd.split(/\s+/)[0] ?? '').replace(/^["']|["']$/g, '');
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(first), cmd, started: Date.parse(m[3]!) || 0 });
  }
  return out;
}

export function listProcesses(): ProcInfo[] {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_COMMAND], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    return r.status === 0 ? parseWindowsList(r.stdout ?? '') : [];
  }
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return r.status === 0 ? parsePsList(r.stdout ?? '') : [];
}

// ---- relations ----

export function sameProcess(ref: ProcRef, p: ProcInfo): boolean {
  return ref.pid === p.pid && Math.abs(ref.started - p.started) <= START_SLACK_MS;
}

// The processes of `refs` that are still running (same pid and start time: a reused pid is a different process).
export function aliveOf(refs: ProcRef[], all: ProcInfo[]): ProcInfo[] {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const found: ProcInfo[] = [];
  for (const ref of refs) {
    const p = byPid.get(ref.pid);
    if (p && sameProcess(ref, p)) found.push(p);
  }
  return found;
}

// Everything below `roots`, following parent links. A parent that has already exited still counts as long as it is one of the
// roots: Windows keeps the parent pid of an orphan. A candidate must have started after its parent, and a root whose pid now
// belongs to a different process is ignored, so a reused pid is never mistaken for the old parent. The roots themselves are not
// part of the result. Parents come before their children.
export function descendantsOf(roots: ProcRef[], all: ProcInfo[]): ProcInfo[] {
  const running = new Map(all.map((p) => [p.pid, p]));
  const known = new Map<number, number>(roots.filter((r) => { const p = running.get(r.pid); return !p || sameProcess(r, p); }).map((r) => [r.pid, r.started]));
  const children = new Map<number, ProcInfo[]>();
  for (const p of all) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const found: ProcInfo[] = [];
  const queue = [...known.keys()];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentStarted = known.get(parent) ?? 0;
    for (const c of children.get(parent) ?? []) {
      if (known.has(c.pid) || c.pid === parent) continue;
      if (c.started + START_SLACK_MS < parentStarted) continue; // older than its supposed parent: a reused pid
      known.set(c.pid, c.started);
      found.push(c);
      queue.push(c.pid);
    }
  }
  return found;
}

// This process and its ancestors (the shell, the editor, Claude Code): never stopped by a cleanup.
export function protectedPids(all: ProcInfo[], self = process.pid): Set<number> {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const out = new Set<number>([self]);
  for (let p = byPid.get(self); p && !out.has(p.ppid) && p.ppid > 0; p = byPid.get(p.ppid)) out.add(p.ppid);
  return out;
}

// ---- stopping ----

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone, or not ours to signal
  }
}

export const defaultProcessOps: ProcessOps = {
  list: listProcesses,
  kill(pids) {
    if (pids.length === 0) return;
    if (process.platform !== 'win32') {
      for (const pid of pids) signal(pid, 'SIGTERM');
      sleepSync(400);
    }
    for (const pid of pids) signal(pid, 'SIGKILL'); // on Windows this ends the process outright
  },
  killTree(pid) {
    const all = listProcesses();
    const root = all.find((p) => p.pid === pid);
    const below = root ? descendantsOf([root], all) : [];
    if (process.platform !== 'win32') signal(-pid, 'SIGKILL'); // the process group of a command started detached (tools/supervise.ts)
    for (const p of [...below].reverse()) signal(p.pid, 'SIGKILL'); // deepest first
    signal(pid, 'SIGKILL');
  },
  sleep: sleepSync,
};

export interface TerminateResult {
  stopped: ProcInfo[];
  stillRunning: ProcInfo[]; // survived two attempts (for example access denied)
  skipped: ProcInfo[]; // protected: this process or one of its ancestors
}

// Stops `targets`, then checks that they are gone. Targets are matched by pid + start time again at the end, so a pid
// that was reused in the meantime is never reported as "still running".
export function terminate(targets: ProcInfo[], ops: ProcessOps = defaultProcessOps, all: ProcInfo[] = ops.list()): TerminateResult {
  const guard = protectedPids(all);
  const skipped = targets.filter((p) => guard.has(p.pid));
  const todo = targets.filter((p) => !guard.has(p.pid));
  if (todo.length === 0) return { stopped: [], stillRunning: [], skipped };
  const survivors = (): ProcInfo[] => aliveOf(todo, ops.list());
  ops.kill(todo.map((p) => p.pid));
  ops.sleep(300);
  let left = survivors();
  if (left.length > 0) {
    ops.kill(left.map((p) => p.pid));
    ops.sleep(500);
    left = survivors();
  }
  const leftPids = new Set(left.map((p) => p.pid));
  return { stopped: todo.filter((p) => !leftPids.has(p.pid)), stillRunning: left, skipped };
}

// ---- browser profile folders ----

const PROFILE_NAME = /^playwright_(?:chromium|firefox|webkit)dev_profile-[A-Za-z0-9]+$/;

// A browser that is stopped forcefully cannot remove its temporary profile folder. Removes the ones named in the command lines
// of the stopped processes, and only Playwright's own temporary profiles directly inside the temp folder.
export function removeTempProfiles(procs: ProcInfo[], tmpDir = os.tmpdir()): number {
  let tmpReal: string;
  try {
    tmpReal = realpathSync.native(tmpDir);
  } catch {
    return 0;
  }
  const dirs = new Set<string>();
  for (const p of procs) {
    const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(p.cmd);
    const dir = m?.[1] ?? m?.[2];
    if (dir && PROFILE_NAME.test(path.basename(dir))) dirs.add(dir);
  }
  let removed = 0;
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      if (realpathSync.native(path.dirname(dir)) !== tmpReal) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      // the folder is gone, or still locked: leaving a temp folder behind is harmless
    }
  }
  return removed;
}

// Runs one command and leaves nothing of it running. The command's output goes straight through (stdio is inherited), its exit
// code is returned, and:
//   - on a timeout or an interrupt the whole tree below the command is stopped, not just the command itself (a plain timeout kills
//     only the direct child, so a test runner's browsers and servers would live on);
//   - after the command ends, anything it started and left behind (a browser, a dev server, a worker) is stopped;
//   - while it runs, the processes below it are recorded in the run's processes.json (--ledger), so a later cleanup can still stop
//     them if this supervisor itself is killed.
// Only processes found below the command are touched, never anything else on the machine.
//
//   node dependencies/engine/tools/supervise.ts [--timeout <ms>] [--ledger <run dir>] [--role <text>] [--report <file>] [--shell]
//                                               [--poll <ms>] -- <command> [args...]
//
// Exit code: the command's, 124 on timeout, 130 when interrupted, 127 when the command could not be started.
// --report writes {pid, timedOut, interrupted, spawnError, reaped, stillRunning} as JSON for the caller.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { recordProcesses, type LedgerEntry } from '../pipeline/process-ledger.ts';
import {
  aliveOf, defaultProcessOps, descendantsOf, removeTempProfiles, terminate, type ProcInfo, type ProcRef,
} from '../utils/process-tree.ts';

const sep = process.argv.indexOf('--', 2);
if (sep < 0 || sep === process.argv.length - 1) {
  process.stderr.write('usage: node supervise.ts [--timeout <ms>] [--ledger <run dir>] [--role <text>] [--report <file>] [--shell] [--poll <ms>] -- <command> [args...]\n');
  process.exit(64);
}
const { values } = parseArgs({
  args: process.argv.slice(2, sep),
  options: { timeout: { type: 'string' }, ledger: { type: 'string' }, role: { type: 'string' }, report: { type: 'string' }, shell: { type: 'boolean' }, poll: { type: 'string' } },
});
const [command, ...commandArgs] = process.argv.slice(sep + 1) as [string, ...string[]];
const timeoutMs = values.timeout ? Number(values.timeout) : 0;
const pollMs = values.poll ? Math.max(500, Number(values.poll)) : 5000;
const role = values.role ?? 'command';
const ops = defaultProcessOps;

const spawnedAt = Date.now();
const child = values.shell
  ? spawn([command, ...commandArgs].join(' '), { stdio: 'inherit', windowsHide: true, shell: true })
  : spawn(command, commandArgs, { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });

// ---- what has been seen below the command ----

const refs = new Map<number, ProcRef>(child.pid === undefined ? [] : [[child.pid, { pid: child.pid, started: spawnedAt }]]);
const infos = new Map<number, ProcInfo>();
let owner: ProcRef | null = null;

function observe(all: ProcInfo[]): void {
  if (all.length === 0) return;
  if (owner === null) {
    const me = all.find((p) => p.pid === process.pid);
    if (me) owner = { pid: me.pid, started: me.started };
  }
  const fresh: ProcInfo[] = [];
  const root = all.find((p) => p.pid === child.pid && p.ppid === process.pid);
  if (root && !infos.has(root.pid)) {
    infos.set(root.pid, root);
    refs.set(root.pid, root);
    fresh.push(root);
  }
  for (const p of descendantsOf([...refs.values()], all)) {
    if (infos.has(p.pid)) continue;
    infos.set(p.pid, p);
    refs.set(p.pid, p);
    fresh.push(p);
  }
  if (values.ledger && fresh.length > 0) {
    const at = new Date().toISOString();
    const entries: LedgerEntry[] = fresh.map((p) => ({ pid: p.pid, started: p.started, name: p.name, role, owner, recordedAt: at }));
    try {
      recordProcesses(values.ledger, entries);
    } catch {
      // the ledger is a safety net; failing to write it must not stop the command
    }
  }
}

// What of the command is still running: everything seen that is alive, and anything new below it.
function remaining(all: ProcInfo[]): ProcInfo[] {
  const roots = [...refs.values()];
  return [...new Map([...aliveOf(roots, all), ...descendantsOf(roots, all)].map((p) => [p.pid, p])).values()];
}

// ---- stopping ----

const reaped: { pid: number; name: string }[] = [];
const stillRunning: { pid: number; name: string }[] = [];

function stopRemaining(hard: boolean): void {
  const before = ops.list();
  observe(before);
  const targets = remaining(before);
  if (hard && child.pid !== undefined) ops.killTree(child.pid); // the OS's own tree walk, which does not depend on the listing
  const after = hard ? ops.list() : before;
  const alive = aliveOf(targets, after);
  const result = alive.length > 0 ? terminate(alive, ops, after) : { stopped: [], stillRunning: [] as ProcInfo[], skipped: [] as ProcInfo[] };
  const leftPids = new Set(result.stillRunning.map((p) => p.pid));
  for (const p of targets) (leftPids.has(p.pid) ? stillRunning : reaped).push({ pid: p.pid, name: p.name });
  removeTempProfiles(targets);
}

// ---- lifecycle ----

let timedOut = false;
let interrupted = false;
let spawnError: string | null = null;
let finished = false;
let childCode: number | null = null;
let timer: NodeJS.Timeout | undefined;
let poller: NodeJS.Timeout | undefined;

function describe(list: { pid: number; name: string }[]): string {
  return list.slice(0, 6).map((p) => `${p.name} ${p.pid}`).join(', ') + (list.length > 6 ? `, +${list.length - 6} more` : '');
}

function finish(): never {
  if (finished) process.exit(1);
  finished = true;
  clearTimeout(timer);
  clearTimeout(poller);
  if (!timedOut && !interrupted) stopRemaining(false);
  if (timedOut) process.stderr.write(`[supervise] ${role}: timed out after ${timeoutMs}ms; stopped the command and ${reaped.length} process(es) below it${reaped.length ? ` (${describe(reaped)})` : ''}\n`);
  else if (interrupted) process.stderr.write(`[supervise] ${role}: interrupted; stopped the command and ${reaped.length} process(es) below it\n`);
  else if (reaped.length > 0) process.stderr.write(`[supervise] ${role}: stopped ${reaped.length} process(es) the command left running (${describe(reaped)})\n`);
  if (stillRunning.length > 0) process.stderr.write(`[supervise] ${role}: could not stop ${stillRunning.length} process(es): ${describe(stillRunning)}\n`);
  if (values.report) {
    try {
      writeFileSync(values.report, JSON.stringify({ pid: child.pid ?? null, timedOut, interrupted, spawnError, reaped, stillRunning }));
    } catch {
      // the caller falls back to the exit code
    }
  }
  process.exit(spawnError ? 127 : timedOut ? 124 : interrupted ? 130 : (childCode ?? 1));
}

child.on('error', (err) => {
  spawnError = err.message;
  finish();
});
child.on('exit', (code) => {
  childCode = code;
  finish();
});

if (timeoutMs > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    stopRemaining(true);
    finish();
  }, timeoutMs);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    interrupted = true;
    stopRemaining(true);
    finish();
  });
}

// Record the command right away (a supervisor that is killed early still leaves it in the ledger), then keep watching.
const watch = (): void => {
  observe(ops.list());
  poller = setTimeout(watch, pollMs);
};
watch();

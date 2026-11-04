// Leaves nothing running after a run. Two kinds of processes belong to a run and are stopped here:
//   - what the pipeline started itself (the Playwright runner and the browsers/servers below it, report tools): listed in the
//     run's processes.json by the supervisor (tools/supervise.ts), together with their start time;
//   - the browser session the explorer opened with `playwright-cli -s=<name> open`: a detached daemon (cliDaemon.js <name>) that
//     keeps its browser alive until someone closes it. Only sessions whose name contains the run id are the run's.
// Anything else, including the user's own browsers and dev servers, is never touched. A session is closed through the CLI first,
// so the browser shuts down cleanly; whatever is still running afterwards is stopped. The result says what was stopped and, if
// something could not be, what is still running: a cleanup never claims more than it checked.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dependenciesDir } from '../utils/layout.ts';
import {
  aliveOf, defaultProcessOps, descendantsOf, removeTempProfiles, terminate, type ProcInfo, type ProcRef, type ProcessOps,
} from '../utils/process-tree.ts';
import { RUN_ID_PATTERN, runDir, runsDir } from './artifact-manager.ts';
import { finishCleanup, readLedger, type CleanupRecord } from './process-ledger.ts';

export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const DAEMON = /[\\/]cliDaemon\.js["']?\s+["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?(?:\s|$)/;

export interface CliSession {
  name: string;
  proc: ProcInfo;
}

// playwright-cli keeps each named browser session in a node process running cliDaemon.js with the session name as its argument.
export function cliSessions(all: ProcInfo[]): CliSession[] {
  const out: CliSession[] = [];
  for (const p of all) {
    if (!/^node(?:\.exe)?$/i.test(p.name)) continue;
    const m = DAEMON.exec(p.cmd);
    if (m) out.push({ name: m[1]!, proc: p });
  }
  return out;
}

export interface CleanupOps extends ProcessOps {
  // Asks playwright-cli to close the named session. True when the CLI reported success.
  closeSession(name: string): boolean;
}

function closeCliSession(rootDir: string, name: string): boolean {
  if (!SESSION_NAME.test(name)) return false; // the name goes into a command line: only plain names
  const win = process.platform === 'win32';
  const local = path.join(rootDir, 'node_modules', '.bin', win ? 'playwright-cli.cmd' : 'playwright-cli');
  const exe = existsSync(local) ? local : 'playwright-cli';
  const cwd = existsSync(dependenciesDir(rootDir)) ? dependenciesDir(rootDir) : undefined;
  const r = win
    ? spawnSync(`"${exe}" -s=${name} close`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 20_000, cwd })
    : spawnSync(exe, [`-s=${name}`, 'close'], { encoding: 'utf8', timeout: 20_000, cwd });
  return r.status === 0;
}

export function defaultCleanupOps(rootDir: string): CleanupOps {
  return { ...defaultProcessOps, closeSession: (name) => closeCliSession(rootDir, name) };
}

export interface StoppedProcess {
  pid: number;
  name: string;
  role: string;
}

export interface CleanupReport {
  ok: boolean; // nothing attributable to the run is left running, and the process list could be read
  trigger: string;
  dryRun: boolean;
  unavailable: boolean; // the process list could not be read, so nothing could be checked
  stopped: StoppedProcess[]; // with dryRun: what would be stopped
  sessions: CleanupRecord['sessions'];
  stillRunning: StoppedProcess[];
  tempProfilesRemoved: number;
}

export interface CleanupOptions {
  trigger: string;
  dryRun?: boolean;
  ops?: CleanupOps;
  now?: Date;
}

interface Scope {
  dirs: string[]; // run directories whose ledgers count
  ownsSession(name: string): boolean;
}

const brief = (p: ProcInfo, role: string): StoppedProcess => ({ pid: p.pid, name: p.name, role });

function sweep(rootDir: string, scope: Scope, opts: CleanupOptions): CleanupReport {
  const ops = opts.ops ?? defaultCleanupOps(rootDir);
  const dryRun = opts.dryRun === true;
  let all = ops.list();
  const base = { trigger: opts.trigger, dryRun, stopped: [], sessions: [], stillRunning: [], tempProfilesRemoved: 0 };
  if (all.length === 0) return { ...base, ok: false, unavailable: true };

  // Processes the pipeline recorded. An entry whose supervisor is still running is in use right now: the supervisor stops it itself.
  const roleByPid = new Map<number, string>();
  const ledgers = scope.dirs.map((dir) => ({ dir, ledger: readLedger(dir) }));
  const inUse = new Set<string>();
  const recorded: ProcRef[] = [];
  for (const { ledger } of ledgers) {
    for (const e of ledger.entries) {
      if (e.owner && aliveOf([e.owner], all).length > 0) {
        inUse.add(`${e.pid}:${e.started}`);
        continue;
      }
      recorded.push(e);
      roleByPid.set(e.pid, e.role);
    }
  }

  // The run's browser sessions: closed through the CLI first.
  const sessions = cliSessions(all).filter((s) => scope.ownsSession(s.name));
  for (const s of sessions) roleByPid.set(s.proc.pid, `playwright-cli session ${s.name}`);
  const graceful = new Set<string>();
  if (!dryRun && sessions.length > 0) {
    for (const s of sessions) if (ops.closeSession(s.name)) graceful.add(s.name);
    ops.sleep(700);
    all = ops.list();
  }

  // Roots: what is recorded and still running, plus every session daemon (also one that just exited: its browser may be orphaned).
  const roots: ProcRef[] = [...recorded, ...sessions.map((s) => s.proc)];
  const rootProcs = aliveOf(roots, all);
  const below = descendantsOf(roots, all);
  for (const p of below) roleByPid.set(p.pid, roleByPid.get(p.ppid) ?? 'child process');
  const targets = [...new Map([...rootProcs, ...below].map((p) => [p.pid, p])).values()];
  const roleOf = (p: ProcInfo) => roleByPid.get(p.pid) ?? 'child process';

  const sessionResult = (stoppedPids: Set<number>, leftPids: Set<number>): CleanupRecord['sessions'] =>
    sessions.map((s) => ({
      name: s.name,
      closed: leftPids.has(s.proc.pid) ? 'not_stopped' : stoppedPids.has(s.proc.pid) ? 'forced' : graceful.has(s.name) || aliveOf([s.proc], all).length === 0 ? 'gracefully' : 'not_stopped',
    }));

  if (dryRun) {
    return {
      ...base, ok: true, unavailable: false,
      stopped: targets.map((p) => brief(p, roleOf(p))),
      sessions: sessions.map((s) => ({ name: s.name, closed: 'pending' as const })),
    };
  }

  const result = terminate(targets, ops, all);
  const stoppedPids = new Set(result.stopped.map((p) => p.pid));
  const leftPids = new Set(result.stillRunning.map((p) => p.pid));
  const profiles = removeTempProfiles(result.stopped);
  const sessionsOut = sessionResult(stoppedPids, leftPids);
  const report: CleanupReport = {
    ...base, ok: result.stillRunning.length === 0, unavailable: false,
    stopped: result.stopped.map((p) => brief(p, roleOf(p))),
    sessions: sessionsOut,
    stillRunning: result.stillRunning.map((p) => brief(p, roleOf(p))),
    tempProfilesRemoved: profiles,
  };

  // Record it in each run's ledger: forget what is gone, keep what is still running or in use by a live supervisor.
  const something = report.stopped.length > 0 || report.stillRunning.length > 0 || sessionsOut.length > 0;
  const record: CleanupRecord = {
    at: (opts.now ?? new Date()).toISOString(), trigger: opts.trigger,
    stopped: report.stopped, sessions: sessionsOut, stillRunning: report.stillRunning, tempProfilesRemoved: profiles,
  };
  for (const { dir, ledger } of ledgers) {
    if (ledger.entries.length === 0 && !something) continue;
    const keep = ledger.entries.filter((e) => inUse.has(`${e.pid}:${e.started}`) || leftPids.has(e.pid));
    finishCleanup(dir, keep, something ? record : null);
  }
  return report;
}

// Stops everything that belongs to one run.
export function cleanupRun(rootDir: string, runId: string, opts: CleanupOptions): CleanupReport {
  return sweep(rootDir, { dirs: [runDir(rootDir, runId)], ownsSession: (name) => name.includes(runId) }, opts);
}

// Stops what earlier runs of this project left behind (for example after a crash or a closed terminal). Only the runs that exist in
// dependencies/runs/ count, and only their recorded processes and their sessions: other browsers and servers are not touched.
export function cleanupAll(rootDir: string, opts: CleanupOptions): CleanupReport {
  const base = runsDir(rootDir);
  const ids = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && RUN_ID_PATTERN.test(d.name)).map((d) => d.name) : [];
  return sweep(rootDir, { dirs: ids.map((id) => runDir(rootDir, id)), ownsSession: (name) => ids.some((id) => name.includes(id)) }, opts);
}

// ---- automatic cleanup at the end of a stage ----

const ENDED = ['completed', 'failed', 'blocked', 'cancelled', 'skipped'];

// When a stage change should leave the run clean: the exploration stage ends (its browser session must be closed), any stage that
// stops the run (failed, blocked, cancelled) and finalization.
export function cleanupTrigger(stage: string, status: string): string | null {
  if (stage === 'application_exploration' && ENDED.includes(status)) return `${stage} ${status}`;
  if (status === 'failed' || status === 'blocked' || status === 'cancelled') return `${stage} ${status}`;
  if (stage === 'finalization' && status === 'completed') return 'finalization completed';
  return null;
}

export interface CleanupBrief {
  trigger: string;
  stopped: number;
  sessions: string[];
  stillRunning: string[];
  error?: string;
}

export function briefOf(r: CleanupReport): CleanupBrief {
  return {
    trigger: r.trigger,
    stopped: r.stopped.length,
    sessions: r.sessions.map((s) => `${s.name}: ${s.closed}`),
    stillRunning: r.stillRunning.map((p) => `${p.name} (${p.pid}) ${p.role}`),
    ...(r.unavailable ? { error: 'the process list could not be read; nothing was checked' } : {}),
  };
}

// Never throws and stays silent when there was nothing to clean: a failed cleanup must not undo the state change that triggered it.
export function sweepAfterStage(rootDir: string, runId: string, stage: string, status: string, ops?: CleanupOps): CleanupBrief | null {
  const trigger = cleanupTrigger(stage, status);
  return trigger ? sweepRun(rootDir, runId, trigger, ops) : null;
}

export function sweepRun(rootDir: string, runId: string, trigger: string, ops?: CleanupOps): CleanupBrief | null {
  try {
    const report = cleanupRun(rootDir, runId, { trigger, ops });
    const shown = briefOf(report);
    return shown.stopped > 0 || shown.sessions.length > 0 || shown.stillRunning.length > 0 || shown.error ? shown : null;
  } catch (err) {
    return { trigger, stopped: 0, sessions: [], stillRunning: [], error: (err as Error).message };
  }
}

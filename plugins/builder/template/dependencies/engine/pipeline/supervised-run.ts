// A synchronous "run this command" that leaves nothing of it running. It is spawnSync, except that the command runs under
// tools/supervise.ts: on a timeout the whole process tree is stopped (spawnSync alone stops only the direct child, so the browsers
// and servers below a test runner would live on), and whatever the command leaves behind is stopped when it ends.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SupervisedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer?: number;
  shell?: boolean; // run `command` (plus args) as one shell command line; only for command lines the pipeline built itself
  ledgerDir?: string; // the run directory whose processes.json records what the command starts
  role?: string; // what the command is for, e.g. "playwright:initial"
}

export interface SupervisedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  reaped: { pid: number; name: string }[]; // processes the command left running and that were stopped
  stillRunning: { pid: number; name: string }[];
}

export function superviseToolPath(): string {
  return path.join(import.meta.dirname, '..', 'tools', 'supervise.ts');
}

interface SuperviseReport {
  timedOut?: boolean;
  interrupted?: boolean;
  spawnError?: string | null;
  reaped?: { pid: number; name: string }[];
  stillRunning?: { pid: number; name: string }[];
}

function readReport(file: string): SuperviseReport {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SuperviseReport;
  } catch {
    return {}; // the supervisor did not get to write it; the exit code and output still say what happened
  } finally {
    rmSync(file, { force: true });
  }
}

// How long past the supervisor's own timeout the outer call waits before giving up on the supervisor itself.
const BACKSTOP_MS = 60_000;

export function runSupervised(command: string, args: string[], o: SupervisedOptions): SupervisedResult {
  const report = path.join(os.tmpdir(), `pw-supervise-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
  const flags = [
    '--timeout', String(o.timeoutMs), '--report', report,
    ...(o.ledgerDir ? ['--ledger', o.ledgerDir] : []),
    ...(o.role ? ['--role', o.role] : []),
    ...(o.shell ? ['--shell'] : []),
  ];
  const r = spawnSync(process.execPath, [superviseToolPath(), ...flags, '--', command, ...args], {
    cwd: o.cwd, env: o.env, encoding: 'utf8', windowsHide: true, maxBuffer: o.maxBuffer ?? 64 * 1024 * 1024, timeout: o.timeoutMs + BACKSTOP_MS,
  });
  const rep = readReport(report);
  const timedOut = rep.timedOut === true;
  let error = r.error;
  if (!error && timedOut) error = new Error(`timed out after ${o.timeoutMs}ms (the command and the processes below it were stopped)`);
  if (!error && rep.spawnError) error = new Error(`could not start the command: ${rep.spawnError}`);
  return {
    status: timedOut ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error, timedOut,
    reaped: rep.reaped ?? [], stillRunning: rep.stillRunning ?? [],
  };
}

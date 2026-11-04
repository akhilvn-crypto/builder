// Nothing of a run may stay running: what the supervisor, the ledger and the cleanup stop, and (as important) what they must
// leave alone. The first half uses a simulated process table so every attribution rule is checked without touching real
// processes; the second half starts real child processes to prove that orphans are reaped and a timeout stops the whole tree.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runDir } from '../engine/pipeline/artifact-manager.ts';
import {
  briefOf, cleanupAll, cleanupRun, cleanupTrigger, cliSessions, sweepAfterStage, type CleanupOps,
} from '../engine/pipeline/process-cleanup.ts';
import { ledgerFile, readLedger, recordProcesses } from '../engine/pipeline/process-ledger.ts';
import { runSupervised } from '../engine/pipeline/supervised-run.ts';
import {
  descendantsOf, listProcesses, parsePsList, parseWindowsList, protectedPids, type ProcInfo,
} from '../engine/utils/process-tree.ts';
import { tmpRoot } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const R1 = '20261021-100000-aaaaaa';
const R2 = '20261021-100000-bbbbbb';
const T0 = Date.now() - 600_000;

// ---- parsing and relations ----

test('the Windows and ps listings are parsed, including a single process and a missing command line', () => {
  const one = parseWindowsList('{"p":4,"q":0,"n":"System","c":null,"s":1760000000000}');
  assert.deepEqual(one, [{ pid: 4, ppid: 0, name: 'System', cmd: '', started: 1760000000000 }]);
  assert.deepEqual(parseWindowsList('not json'), []);
  assert.equal(parseWindowsList('[{"p":1,"q":0,"n":"a","c":"x","s":1},{"p":2,"q":1,"n":"b","c":"y","s":2}]').length, 2);

  const ps = parsePsList([
    '  412     1 Tue Oct 21 11:40:21 2026 /usr/bin/node /opt/cli/cliDaemon.js explore-x',
    ' 9001   412 Tue Oct 21 11:40:25 2026 /usr/bin/chromium --headless',
    'garbage line',
  ].join('\n'));
  assert.equal(ps.length, 2);
  assert.equal(ps[0]!.name, 'node');
  assert.equal(ps[0]!.cmd, '/usr/bin/node /opt/cli/cliDaemon.js explore-x');
  assert.equal(ps[1]!.ppid, 412);
  assert.ok(ps[1]!.started > ps[0]!.started);
});

const proc = (pid: number, ppid: number, name: string, cmd: string, started = T0): ProcInfo => ({ pid, ppid, name, cmd, started });

test('descendants follow parent links through a parent that has exited, and ignore a reused pid', () => {
  const all = [
    proc(11, 10, 'chrome.exe', 'chrome', T0 + 1000), // child of the dead root 10
    proc(12, 11, 'chrome.exe', 'chrome --renderer', T0 + 2000), // grandchild
    proc(13, 10, 'old.exe', 'a process that started before the root: pid 10 was reused', T0 - 5000),
    proc(20, 1, 'unrelated.exe', 'unrelated', T0),
  ];
  const found = descendantsOf([{ pid: 10, started: T0 }], all);
  assert.deepEqual(found.map((p) => p.pid), [11, 12], 'parents come before their children; the older process and the unrelated one are left out');
});

test('this process and its ancestors are protected', () => {
  const all = [proc(process.pid, 50, 'node', 'node'), proc(50, 40, 'shell', 'sh'), proc(40, 0, 'editor', 'code'), proc(77, 1, 'x', 'x')];
  assert.deepEqual([...protectedPids(all)].sort((a, b) => a - b), [40, 50, process.pid].sort((a, b) => a - b));
});

test('playwright-cli sessions are recognised only as node processes running cliDaemon.js', () => {
  const sessions = cliSessions([
    proc(1, 0, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@playwright\\cli\\node_modules\\playwright-core\\lib\\entry\\cliDaemon.js explore-' + R1),
    proc(2, 0, 'node', '/usr/bin/node /opt/cli/lib/entry/cliDaemon.js "my-session"'),
    proc(3, 0, 'chrome.exe', 'chrome.exe --note cliDaemon.js explore-' + R1),
    proc(4, 0, 'node.exe', 'node.exe some-other-script.js explore-' + R1),
  ]);
  assert.deepEqual(sessions.map((s) => [s.proc.pid, s.name]), [[1, `explore-${R1}`], [2, 'my-session']]);
});

// ---- cleanup against a simulated machine ----

interface World {
  ops: CleanupOps;
  table(): ProcInfo[];
  closed: string[];
}

function world(initial: ProcInfo[], o: { closeWorks?: boolean; killWorks?: boolean; listWorks?: boolean } = {}): World {
  let table = [...initial];
  const closed: string[] = [];
  const dropTree = (rootPid: number) => {
    const root = table.find((p) => p.pid === rootPid);
    if (!root) return;
    const gone = new Set([rootPid, ...descendantsOf([root], table).map((p) => p.pid)]);
    table = table.filter((p) => !gone.has(p.pid));
  };
  const ops: CleanupOps = {
    list: () => (o.listWorks === false ? [] : table.map((p) => ({ ...p }))),
    kill: (pids) => { if (o.killWorks !== false) table = table.filter((p) => !pids.includes(p.pid)); },
    killTree: () => {},
    sleep: () => {},
    closeSession: (name) => {
      closed.push(name);
      if (o.closeWorks === false) return false;
      const d = cliSessions(table).find((s) => s.name === name);
      if (d) dropTree(d.proc.pid);
      return true;
    },
  };
  return { ops, table: () => table, closed };
}

const daemon = (pid: number, session: string) => proc(pid, 1, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\@playwright\\cli\\lib\\entry\\cliDaemon.js ${session}`);

function machine(): ProcInfo[] {
  return [
    daemon(100, `explore-${R1}`),
    proc(101, 100, 'chrome.exe', 'chrome.exe --headless --user-data-dir=C:\\somewhere\\profile', T0 + 500),
    daemon(200, `explore-${R2}`),
    proc(201, 200, 'chrome.exe', 'chrome.exe --headless', T0 + 500),
    proc(300, 1, 'chrome.exe', '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'), // the user's own browser
    daemon(400, 'my-own-session'), // a session that is not any run's
    proc(500, 1, 'node.exe', 'node.exe playwright/cli.js test', T0), // the runner recorded in run 1's ledger
    proc(501, 500, 'chrome.exe', 'chrome.exe --remote-debugging-pipe', T0 + 700), // its browser (not recorded)
    proc(502, 501, 'chrome.exe', 'chrome.exe --type=renderer', T0 + 900),
  ];
}

function setup(t: { after: (fn: () => void) => void }, ledgerOwner: { pid: number; started: number } | null = null): string {
  const root = tmpRoot(t);
  for (const id of [R1, R2]) mkdirSync(runDir(root, id), { recursive: true });
  recordProcesses(runDir(root, R1), [{ pid: 500, started: T0, name: 'node.exe', role: 'playwright:initial', owner: ledgerOwner, recordedAt: new Date().toISOString() }]);
  return root;
}

test('cleanup closes the run\'s browser session through the CLI and stops what the runner left, and nothing else', (t) => {
  const root = setup(t);
  const w = world(machine());
  const r = cleanupRun(root, R1, { trigger: 'test', ops: w.ops });
  assert.equal(r.ok, true);
  assert.deepEqual(w.closed, [`explore-${R1}`], 'only this run\'s session is closed');
  assert.deepEqual(r.sessions, [{ name: `explore-${R1}`, closed: 'gracefully' }]);
  assert.deepEqual(r.stopped.map((p) => p.pid).sort(), [500, 501, 502], 'the recorded runner and what is below it');
  assert.equal(r.stopped.find((p) => p.pid === 501)!.role, 'playwright:initial', 'children carry the role of what started them');
  assert.deepEqual(w.table().map((p) => p.pid).sort((a, b) => a - b), [200, 201, 300, 400], 'another run\'s session, the user\'s browser and an unrelated session are untouched');

  const ledger = readLedger(runDir(root, R1));
  assert.deepEqual(ledger.entries, [], 'stopped processes are forgotten');
  assert.equal(ledger.cleanups.length, 1);
  assert.equal(ledger.cleanups[0]!.trigger, 'test');
});

test('a session that does not close when asked is stopped, with its browser', (t) => {
  const root = setup(t);
  const w = world(machine(), { closeWorks: false });
  const r = cleanupRun(root, R1, { trigger: 'test', ops: w.ops });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sessions, [{ name: `explore-${R1}`, closed: 'forced' }]);
  assert.ok([100, 101].every((pid) => r.stopped.some((p) => p.pid === pid)), 'the daemon and its browser');
  assert.equal(w.table().some((p) => p.pid === 100 || p.pid === 101), false);
  assert.equal(w.table().some((p) => p.pid === 200), true, 'run 2\'s session is still there');
});

test('a process that cannot be stopped is reported, never counted as stopped', (t) => {
  const root = setup(t);
  const w = world(machine(), { killWorks: false });
  const r = cleanupRun(root, R1, { trigger: 'test', ops: w.ops });
  assert.equal(r.ok, false);
  assert.ok(r.stillRunning.length > 0);
  assert.equal(r.stopped.length, 0);
  assert.equal(readLedger(runDir(root, R1)).entries.length, 1, 'still recorded, so a later cleanup tries again');
  assert.equal(briefOf(r).stillRunning.length, r.stillRunning.length);
});

test('a dry run only reports', (t) => {
  const root = setup(t);
  const w = world(machine());
  const before = w.table().length;
  const r = cleanupRun(root, R1, { trigger: 'test', dryRun: true, ops: w.ops });
  assert.equal(r.dryRun, true);
  assert.equal(w.table().length, before);
  assert.deepEqual(w.closed, []);
  assert.deepEqual(r.sessions, [{ name: `explore-${R1}`, closed: 'pending' }]);
  assert.ok(r.stopped.some((p) => p.pid === 500));
  assert.equal(readLedger(runDir(root, R1)).entries.length, 1, 'the ledger is untouched');
});

test('when the process list cannot be read, the cleanup says so instead of claiming success', (t) => {
  const root = setup(t);
  const r = cleanupRun(root, R1, { trigger: 'test', ops: world(machine(), { listWorks: false }).ops });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.match(briefOf(r).error ?? '', /could not be read/);
});

test('a recorded process whose supervisor is still running is left to that supervisor', (t) => {
  const root = setup(t, { pid: 900, started: T0 - 1000 });
  const w = world([...machine(), proc(900, 1, 'node.exe', 'node supervise.ts', T0 - 1000)]);
  const r = cleanupRun(root, R1, { trigger: 'test', ops: w.ops });
  assert.equal(r.stopped.some((p) => p.pid >= 500 && p.pid <= 502), false);
  assert.equal(readLedger(runDir(root, R1)).entries.length, 1, 'the entry stays while its supervisor lives');
});

test('a recorded pid that now belongs to a different process is not touched', (t) => {
  const root = setup(t);
  const reused = machine().map((p) => (p.pid === 500 ? { ...p, started: T0 + 10 * 60_000, cmd: 'notepad.exe' } : p));
  const w = world(reused);
  const r = cleanupRun(root, R1, { trigger: 'test', ops: w.ops });
  assert.equal(r.stopped.length, 0, 'neither the new owner of the pid nor its children are mistaken for the run\'s processes');
  assert.deepEqual([500, 501, 502].filter((pid) => !w.table().some((p) => p.pid === pid)), []);
  assert.deepEqual(readLedger(runDir(root, R1)).entries, [], 'the stale entry is dropped');
});

test('cleanup all covers every run of the project but only the sessions that belong to a run', (t) => {
  const root = setup(t);
  const w = world(machine());
  const r = cleanupAll(root, { trigger: 'test', ops: w.ops });
  assert.equal(r.ok, true);
  assert.deepEqual(w.closed.sort(), [`explore-${R1}`, `explore-${R2}`]);
  assert.deepEqual(w.table().map((p) => p.pid).sort((a, b) => a - b), [300, 400], 'the user\'s browser and the unrelated session remain');
});

test('the cleanup runs when exploration ends, when a stage stops the run and at finalization, and not otherwise', () => {
  assert.equal(cleanupTrigger('application_exploration', 'completed'), 'application_exploration completed');
  assert.equal(cleanupTrigger('application_exploration', 'running'), null);
  assert.equal(cleanupTrigger('execution', 'failed'), 'execution failed');
  assert.equal(cleanupTrigger('script_review', 'blocked'), 'script_review blocked');
  assert.equal(cleanupTrigger('healing', 'cancelled'), 'healing cancelled');
  assert.equal(cleanupTrigger('finalization', 'completed'), 'finalization completed');
  assert.equal(cleanupTrigger('execution', 'completed'), null);
  assert.equal(cleanupTrigger('test_generation', 'running'), null);
});

test('the automatic sweep is silent when there was nothing to stop and brief when there was', (t) => {
  const root = setup(t);
  const quiet = world([proc(300, 1, 'chrome.exe', 'chrome.exe')]);
  assert.equal(sweepAfterStage(root, R1, 'application_exploration', 'completed', quiet.ops), null);
  assert.equal(sweepAfterStage(root, R1, 'execution', 'completed', quiet.ops), null, 'no trigger for a normal stage');

  const busy = world(machine());
  const brief = sweepAfterStage(setup(t), R1, 'application_exploration', 'completed', busy.ops);
  assert.ok(brief);
  assert.equal(brief.stopped, 3);
  assert.deepEqual(brief.sessions, [`explore-${R1}: gracefully`]);
  assert.deepEqual(brief.stillRunning, []);
});

// ---- real processes ----

const SLEEP = 'setTimeout(() => {}, 600000)';
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Starts a process that does nothing for ten minutes, detached from this one; killed after the test whatever happens.
function sleeper(t: { after: (fn: () => void) => void }): number {
  const c = spawn(process.execPath, ['-e', SLEEP], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  t.after(() => { try { process.kill(c.pid!, 'SIGKILL'); } catch { /* already gone */ } });
  return c.pid!;
}

// A command that starts a detached grandchild, prints its pid and (unless it exits straight away) keeps running itself.
// Single quotes only and one line, so the script survives being passed through two command lines unchanged.
const withGrandchild = (stayAlive: boolean) => [
  '-e',
  `const c = require('node:child_process').spawn(process.execPath, ['-e', '${SLEEP}'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid); ${stayAlive ? SLEEP : ''}`,
];

test('a command that leaves a process behind does not: it is stopped when the command ends', (t) => {
  const root = tmpRoot(t);
  const dir = runDir(root, R1);
  mkdirSync(dir, { recursive: true });
  const r = runSupervised(process.execPath, withGrandchild(false), { timeoutMs: 60_000, ledgerDir: dir, role: 'playwright:initial' });
  const grandchild = Number(r.stdout.trim());
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(r.status, 0);
  assert.ok(grandchild > 0, 'the command printed its grandchild\'s pid');
  assert.equal(alive(grandchild), false, 'the grandchild was stopped');
  assert.ok(r.reaped.some((p) => p.pid === grandchild), 'and reported');
  assert.match(r.stderr, /stopped \d+ process\(es\) the command left running/);
  assert.equal(r.stillRunning.length, 0);
});

test('a timeout stops the command and everything below it, not just the command', (t) => {
  const root = tmpRoot(t);
  const dir = runDir(root, R1);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const r = runSupervised(process.execPath, withGrandchild(true), { timeoutMs: 3000, ledgerDir: dir, role: 'playwright:initial' });
  const grandchild = Number(r.stdout.trim());
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(r.timedOut, true);
  assert.match(r.error?.message ?? '', /timed out after 3000ms/);
  assert.equal(r.status, null);
  assert.ok(Date.now() - started < 30_000, 'it did not wait for the ten-minute sleepers');
  assert.equal(alive(grandchild), false, 'the grandchild is gone too');
  assert.ok(r.reaped.length >= 2, 'the command and its grandchild were stopped');
  // Whatever the supervisor recorded while it ran is the safety net for a supervisor that is itself killed.
  assert.ok(existsSync(ledgerFile(dir)));
});

test('the command\'s exit code and output pass through unchanged', (t) => {
  const r = runSupervised(process.execPath, ['-e', "console.log('out'); console.error('err'); process.exit(3)"], { timeoutMs: 30_000 });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^out/);
  assert.match(r.stderr, /err/);
  assert.equal(r.timedOut, false);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.reaped, []);
});

test('a command that cannot be started is an error, not a hang', () => {
  const r = runSupervised('this-command-does-not-exist-anywhere', [], { timeoutMs: 30_000 });
  assert.ok(r.error);
  assert.match(r.error!.message, /could not start/);
});

test('cleanup run (CLI) stops a recorded process that is still running, and a dry run does not', (t) => {
  const root = tmpRoot(t);
  const dir = runDir(root, R1);
  mkdirSync(dir, { recursive: true });
  const pid = sleeper(t);
  const info = listProcesses().find((p) => p.pid === pid);
  assert.ok(info, 'the sleeper is visible in the process list');
  recordProcesses(dir, [{ pid, started: info.started, name: info.name, role: 'playwright:initial', owner: null, recordedAt: new Date().toISOString() }]);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
    return { code: r.status, json: JSON.parse(r.stdout) as { ok: boolean; stopped: { pid: number; role: string }[]; dryRun: boolean } };
  };

  const dry = cli('cleanup', 'run', R1, '--dry-run');
  assert.equal(dry.json.dryRun, true);
  assert.ok(dry.json.stopped.some((p) => p.pid === pid));
  assert.equal(alive(pid), true, 'a dry run stops nothing');

  const real = cli('cleanup', 'run', R1);
  assert.equal(real.code, 0);
  assert.ok(real.json.stopped.some((p) => p.pid === pid && p.role === 'playwright:initial'));
  assert.equal(alive(pid), false);
  assert.deepEqual(JSON.parse(readFileSync(ledgerFile(dir), 'utf8')).entries, []);

  const again = cli('cleanup', 'run', R1);
  assert.equal(again.code, 0);
  assert.deepEqual(again.json.stopped, [], 'running it twice is harmless');
});

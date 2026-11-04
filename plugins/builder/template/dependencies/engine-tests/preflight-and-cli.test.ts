import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../engine/config/load-config.ts';
import { appendDependencyChange, readDependencyLog } from '../engine/pipeline/dependency-log.ts';
import { runPreflight, type PreflightDeps } from '../engine/pipeline/preflight.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');

// Fake environment: nothing installed, no external commands found. Records every command run.
function fakeDeps(calls: string[], available: Record<string, string> = {}): PreflightDeps {
  return {
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return cmd in available ? { ok: true, stdout: available[cmd]! } : { ok: false, stdout: '' };
    },
    env: { LOCALAPPDATA: 'Z:\\nonexistent', PLAYWRIGHT_BROWSERS_PATH: path.join('nonexistent', 'browsers') },
    nodeVersion: '24.21.0',
  };
}

test('preflight on an empty project reports missing deps with proposals, and runs no install', (t) => {
  const root = tmpRoot(t);
  const calls: string[] = [];
  const r = runPreflight(root, fakeDeps(calls, { npm: '11.0.0' }));
  assert.equal(r.ready, false);
  assert.equal(r.config.status, 'absent');
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(byId['node']!.status, 'ok');
  assert.equal(byId['@playwright/test']!.status, 'missing');
  assert.equal(byId['@playwright/test']!.installCommand, 'npm install --save-dev --save-exact @playwright/test');
  assert.equal(byId['browser:chromium']!.status, 'missing');
  assert.equal(byId['allure-cli']!.required, false, 'allure not required unless selected');
  // only version probes, never installs
  assert.ok(calls.every((c) => / --version$/.test(c)), calls.join('\n'));
  assert.ok(!calls.some((c) => /install/.test(c)));
});

test('preflight marks allure required only when selected, and detects a global CLI', (t) => {
  const root = tmpRoot(t);
  const cfg = validConfig();
  cfg.reporters = ['html', 'json', 'allure'];
  saveConfig(root, cfg);
  const r = runPreflight(root, fakeDeps([], { npm: '11.0.0', 'playwright-cli': '0.1.22' }));
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(byId['allure-playwright']!.required, true);
  assert.equal(byId['@playwright/cli']!.status, 'ok');
  assert.equal(byId['@playwright/cli']!.location, 'global');
  assert.equal(r.config.status, 'valid');
});

test('preflight does not enforce a Node version floor', (t) => {
  const root = tmpRoot(t);
  const deps = { ...fakeDeps([], { npm: '1' }), nodeVersion: '22.18.0' };
  const node = runPreflight(root, deps).checks.find((c) => c.id === 'node')!;
  assert.equal(node.status, 'ok');
  assert.equal(node.version, '22.18.0');
});

test('preflight detects project-local packages', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'node_modules/@playwright/test/package.json', JSON.stringify({ version: '1.99.0' }));
  const r = runPreflight(root, fakeDeps([], { npm: '11.0.0' }));
  const pw = r.checks.find((c) => c.id === '@playwright/test')!;
  assert.equal(pw.status, 'ok');
  assert.equal(pw.version, '1.99.0');
  assert.equal(pw.installCommand, null);
});

test('dependency log records declines and validates installs', (t) => {
  const root = tmpRoot(t);
  appendDependencyChange(root, {
    timestamp: 'x', dependency: '@playwright/test', action: 'declined', version: null, command: null,
    reason: 'test runner', runId: null,
  });
  assert.equal(readDependencyLog(root).length, 1);
  assert.throws(() => appendDependencyChange(root, {
    timestamp: 'x', dependency: 'allure', action: 'installed', version: '3', command: null, reason: 'r', runId: null,
  }), /command is required/);
});

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test('CLI: config check -> save -> run lifecycle', (t) => {
  const root = tmpRoot(t);
  assert.equal(cli(root, 'config', 'check').code, 2);

  const cfgFile = writeFile(root, 'cfg.json', JSON.stringify(validConfig()));
  assert.equal(cli(root, 'config', 'save', '--file', cfgFile).code, 0);
  assert.equal(cli(root, 'config', 'check').code, 0);

  const created = cli(root, 'run', 'create', '--command', 'run-tests');
  assert.equal(created.code, 0, created.stderr);
  const runId: string = created.json.runId;

  assert.equal(cli(root, 'run', 'stage', runId, 'preflight', 'running').code, 0);
  assert.equal(cli(root, 'run', 'stage', runId, 'preflight', 'completed').code, 0);
  assert.equal(cli(root, 'run', 'stage', runId, 'configuration', 'running').code, 0);
  assert.equal(cli(root, 'run', 'set-config', runId).code, 0);
  const done = cli(root, 'run', 'stage', runId, 'configuration', 'completed');
  assert.equal(done.json.currentStage, 'execution');

  const bad = cli(root, 'run', 'stage', runId, 'finalization', 'running');
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.stderr).kind, 'transition');

  const dep = cli(root, 'deps', 'record', '--dependency', '@playwright/test', '--action', 'installed',
    '--version', '1.99.0', '--cmd', 'npm install --save-dev --save-exact @playwright/test', '--reason', 'runner', '--run', runId);
  assert.equal(dep.code, 0, dep.stderr);
  const shown = cli(root, 'run', 'show', runId);
  assert.equal(shown.json.manifest.setupChanges[0].dependency, '@playwright/test');
  assert.equal(readDependencyLog(root).length, 1);

  assert.equal(cli(root, 'run', 'healing-attempt', runId, 'TC-1').code, 0);
  assert.equal(cli(root, 'run', 'healing-attempt', runId, 'TC-1').code, 0);
  const limit = cli(root, 'run', 'healing-attempt', runId, 'TC-1');
  assert.equal(limit.code, 2);
  assert.equal(limit.json.limitReached, true);
});

test('CLI: state changes print a short status, compact; the full manifest is only in `run show`', (t) => {
  const root = tmpRoot(t);
  const created = cli(root, 'run', 'create', '--command', 'run-tests');
  assert.deepEqual(Object.keys(created.json).sort(), ['command', 'currentStage', 'inputFiles', 'ok', 'runId', 'sourceRunId', 'status']);
  const runId: string = created.json.runId;

  const raw = spawnSync(process.execPath, [CLI, 'run', 'stage', runId, 'preflight', 'running', '--root', root], { encoding: 'utf8' }).stdout;
  assert.equal(raw.trim().split('\n').length, 1, 'one line of JSON, not indented');
  assert.ok(raw.length < 400, `stage reply is short (${raw.length} bytes)`);
  const reply = JSON.parse(raw);
  assert.equal(reply.stage.name, 'preflight');
  assert.equal(reply.stage.status, 'running');
  assert.equal('stages' in reply, false, 'no per-stage dump');

  const pretty = spawnSync(process.execPath, [CLI, 'run', 'stage', runId, 'preflight', 'completed', '--pretty', '--root', root], { encoding: 'utf8' }).stdout;
  assert.ok(pretty.split('\n').length > 3, '--pretty indents');
  assert.ok(Object.keys(cli(root, 'run', 'show', runId).json.manifest.stages).length > 10, 'run show still has the whole manifest');
});

test('CLI: config save refuses invalid input and keeps the existing file', (t) => {
  const root = tmpRoot(t);
  const good = writeFile(root, 'good.json', JSON.stringify(validConfig()));
  cli(root, 'config', 'save', '--file', good);
  const bad = writeFile(root, 'bad.json', JSON.stringify({ ...validConfig(), token: 'abc' }));
  const r = cli(root, 'config', 'save', '--file', bad);
  assert.equal(r.code, 2);
  assert.equal(r.json.issues[0].path, 'token');
  const saved = JSON.parse(readFileSync(path.join(root, 'config', 'automation.config.json'), 'utf8'));
  assert.equal('token' in saved, false);
});

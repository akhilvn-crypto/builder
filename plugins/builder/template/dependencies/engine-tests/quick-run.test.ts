// `npm test` goes through quick-run.ts, so a plain test command leaves a run folder, results and reports like /run-tests.
// Playwright is replaced by a stand-in that replays a canned JSON report (no browser, nothing installed).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { pwReport, tmpRoot, validConfig, writeFile, type FakeTest } from './helpers.ts';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli');

const FAKE_PLAYWRIGHT = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
appendFileSync('fake-pw-calls.log', [process.env.PIPELINE_RUN_ID ?? 'no-run', ...process.argv.slice(2)].join(' ') + String.fromCharCode(10));
const s = JSON.parse(readFileSync('fake-pw.json', 'utf8'));
const dir = process.env.PIPELINE_RUN_ID ? path.join('reports', process.env.PIPELINE_RUN_ID, process.env.PIPELINE_LABEL) : path.join('reports', 'adhoc');
mkdirSync(path.join(dir, 'html'), { recursive: true });
writeFileSync(path.join(dir, 'results.json'), JSON.stringify(s.report));
writeFileSync(path.join(dir, 'html', 'index.html'), '<html>report</html>');
process.exit(s.exitCode);
`;

const pass = (id: string): FakeTest => ({ title: `[${id}] works`, file: 'app.spec.js', status: 'expected', results: [{ status: 'passed' }] });
const fail = (id: string): FakeTest => ({ title: `[${id}] breaks`, file: 'app.spec.js', status: 'unexpected', results: [{ status: 'failed', error: 'Error: expect(locator).toBeVisible() failed' }] });

function project(t: { after: (fn: () => void) => void }, tests: FakeTest[], configured = true) {
  const root = tmpRoot(t);
  writeFile(root, 'package.json', JSON.stringify({ type: 'module' }));
  writeFile(root, 'node_modules/@playwright/test/cli.js', FAKE_PLAYWRIGHT);
  // What preflight looks for: the package, and the browser build its manifest names, in the browser cache.
  writeFile(root, 'node_modules/@playwright/test/package.json', JSON.stringify({ version: '1.99.0' }));
  writeFile(root, 'node_modules/playwright-core/browsers.json', JSON.stringify({ browsers: [{ name: 'chromium', revision: '1000' }, { name: 'chromium-headless-shell', revision: '1000' }] }));
  for (const d of ['chromium-1000', 'chromium_headless_shell-1000']) writeFile(root, `browsers/${d}/.keep`, '');
  writeFile(root, 'fake-pw.json', JSON.stringify({ exitCode: tests.some((x) => x.status === 'unexpected') ? 1 : 0, report: pwReport(root, tests) }));
  if (configured) {
    const cfg = { ...validConfig(), language: 'javascript' };
    const r = spawnSync(process.execPath, [path.join(ENGINE, 'pipeline.ts'), 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(cfg)), '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  return root;
}

function quickRun(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(ENGINE, 'quick-run.ts'), ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers') } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runs(root: string): string[] {
  const dir = path.join(dependenciesDir(root), 'runs');
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'manifest.json'))) : [];
}

test('a passing suite creates a finished run-tests run with results, summary and reports', (t) => {
  const root = project(t, [pass('TC-1'), pass('TC-2')]);
  const r = quickRun(root);
  assert.equal(r.code, 0, r.out + r.err);
  const [runId] = runs(root);
  assert.ok(runId, 'a run folder was created');
  const dir = path.join(dependenciesDir(root), 'runs', runId!);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.command, 'run-tests');
  assert.equal(manifest.status, 'completed');
  for (const f of ['execution-results.json', 'failure-analysis.json', 'summary.json', 'summary.md']) assert.ok(existsSync(path.join(dir, f)), f);
  assert.ok(existsSync(path.join(root, 'reports', runId!, 'initial', 'results.json')));
  assert.match(r.out, /total 2 · passed 2 · failed 0/);
  assert.match(readFileSync(path.join(root, 'fake-pw-calls.log'), 'utf8'), new RegExp(`^${runId} test`));
});

test('a failing test is recorded and makes npm test fail, while the run is still finished', (t) => {
  const root = project(t, [pass('TC-1'), fail('TC-2')]);
  const r = quickRun(root);
  assert.equal(r.code, 1);
  const [runId] = runs(root);
  const manifest = JSON.parse(readFileSync(path.join(dependenciesDir(root), 'runs', runId!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.testCounts.failed, 1);
  assert.match(r.out, /failed: TC-2@chromium/);
});

test('test files, --project and --retries are passed through to the runner', (t) => {
  const root = project(t, [pass('TC-1')]);
  writeFile(root, 'tests/app.spec.js', '// test\n');
  const r = quickRun(root, 'tests/app.spec.js', '--project', 'chromium', '--retries', '0');
  assert.equal(r.code, 0, r.out + r.err);
  const call = readFileSync(path.join(root, 'fake-pw-calls.log'), 'utf8');
  assert.match(call, /test tests\/app\.spec\.js --project chromium --retries 0/);
});

test('--headed is passed to the runner and the run is still recorded', (t) => {
  const root = project(t, [pass('TC-1')]);
  const r = quickRun(root, '--headed');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(readFileSync(path.join(root, 'fake-pw-calls.log'), 'utf8'), /test .*--headed/);
  assert.equal(runs(root).length, 1);
});

test('a runner error fails the execution stage and the run records why', (t) => {
  const root = project(t, []);
  const r = quickRun(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /execution failed: .*no tests were found/);
  const [runId] = runs(root);
  const manifest = JSON.parse(readFileSync(path.join(dependenciesDir(root), 'runs', runId!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.stages.execution.status, 'failed');
});

test('an unconfigured project runs plain Playwright and says no run was recorded', (t) => {
  const root = project(t, [pass('TC-1')], false);
  const r = quickRun(root);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /not configured/);
  assert.deepEqual(runs(root), []);
  assert.match(readFileSync(path.join(root, 'fake-pw-calls.log'), 'utf8'), /^no-run test/);
});

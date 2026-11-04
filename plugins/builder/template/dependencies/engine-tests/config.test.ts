import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { configPath, loadConfig, saveConfig } from '../engine/config/load-config.ts';
import { UNCONFIGURED, renderPlaywrightConfig, syncFromSavedConfig } from '../engine/config/playwright-config.ts';
import { validateConfig, type AutomationConfig } from '../engine/config/schema.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

test('valid config passes validation', () => {
  const r = validateConfig(validConfig());
  assert.equal(r.ok, true);
});

test('missing material choices are reported as "missing", not invented', () => {
  const { language, evidence, ...rest } = validConfig();
  const r = validateConfig({ ...rest, app: { environment: 'qa' } });
  assert.equal(r.ok, false);
  const missing = r.issues.filter((i) => i.kind === 'missing').map((i) => i.path).sort();
  assert.deepEqual(missing, ['app.baseUrl', 'evidence', 'language']);
});

test('invalid values are reported with paths', () => {
  const c = validConfig() as unknown as Record<string, any>;
  c.language = 'python';
  c.evidence.trace = 'sometimes';
  c.app.baseUrl = 'ftp://x';
  c.browsers = ['chromium', 'chromium'];
  c.healing.maxAttemptsPerTest = 3;
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  const paths = r.issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ['app.baseUrl', 'browsers', 'evidence.trace', 'healing.maxAttemptsPerTest', 'language']);
  assert.ok(r.issues.every((i) => i.kind === 'invalid'));
});

test('unknown keys are rejected so secrets cannot be persisted', () => {
  const c = { ...validConfig(), password: 'hunter2' };
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]?.path, 'password');
});

test('credentials embedded in baseUrl are rejected', () => {
  const c = validConfig();
  c.app.baseUrl = 'https://user:pass@test.example.com';
  assert.equal(validateConfig(c).ok, false);
});

test('credentialEnvVars must be variable names, not values', () => {
  const c = validConfig();
  c.auth.credentialEnvVars = ['TEST_USER_PASSWORD'];
  assert.equal(validateConfig(c).ok, true);
  c.auth.credentialEnvVars = ['s3cret value!'];
  assert.equal(validateConfig(c).ok, false);
});

test('json reporter is mandatory for pipeline state', () => {
  const c = validConfig();
  c.reporters = ['html'];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.match(r.issues[0]!.message, /must include "json"/);
});

test('input path must stay inside the project', () => {
  for (const bad of ['../outside', 'C:\\abs\\path', '/etc/x']) {
    const c = validConfig();
    c.input.testCasesPath = bad;
    assert.equal(validateConfig(c).ok, false, bad);
  }
});

test('absent config file -> status "absent" with missing issues', (t) => {
  const root = tmpRoot(t);
  const s = loadConfig(root, { env: {} });
  assert.equal(s.status, 'absent');
  assert.ok('issues' in s && s.issues.some((i) => i.path === 'language' && i.kind === 'missing'));
});

test('malformed JSON file -> status "invalid"', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'config/automation.config.json', '{ not json');
  assert.equal(loadConfig(root, { env: {} }).status, 'invalid');
});

test('saveConfig persists only valid config and fills non-material defaults', (t) => {
  const root = tmpRoot(t);
  const { execution, healing, retention, ...partial } = validConfig();
  assert.deepEqual(saveConfig(root, partial), { ok: true });
  const saved = JSON.parse(readFileSync(configPath(root), 'utf8'));
  assert.equal(saved.healing.maxAttemptsPerTest, 2);
  assert.equal(saved.execution.retries, 1);

  const bad = saveConfig(root, { ...partial, language: 'cobol' });
  assert.equal(bad.ok, false);
  // previous valid file untouched
  assert.equal(JSON.parse(readFileSync(configPath(root), 'utf8')).language, 'typescript');
});

test('scaffold language is the single source: seeded when absent, locked when saved', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'state/scaffold.json', JSON.stringify({ pluginVersion: '0.3.0', language: 'javascript' }));

  // No config file yet: language is not reported missing because init already asked.
  const absent = loadConfig(root, { env: {} });
  assert.equal(absent.status, 'absent');
  assert.ok('issues' in absent && !absent.issues.some((i) => i.path === 'language'));
  assert.ok(absent.sources.includes('dependencies/state/scaffold.json'));

  // A candidate without a language inherits the scaffold's; a conflicting one is rejected.
  const { language, ...partial } = validConfig();
  assert.deepEqual(saveConfig(root, partial), { ok: true });
  assert.equal(JSON.parse(readFileSync(configPath(root), 'utf8')).language, 'javascript');
  const conflict = saveConfig(root, { ...partial, language: 'typescript' });
  assert.equal(conflict.ok, false);
  assert.ok(!conflict.ok && conflict.issues.some((i) => i.path === 'language' && /fixed by the scaffold/.test(i.message)));

  // A config file edited out from under the scaffold is flagged on load.
  writeFile(root, 'config/automation.config.json', JSON.stringify({ ...partial, language: 'typescript' }));
  const drifted = loadConfig(root, { env: {} });
  assert.equal(drifted.status, 'invalid');
  assert.ok('issues' in drifted && drifted.issues.some((i) => i.path === 'language'));
});

test('precedence: defaults < file < env < arguments', (t) => {
  const root = tmpRoot(t);
  saveConfig(root, validConfig());

  const fileOnly = loadConfig(root, { env: {} });
  assert.equal(fileOnly.status, 'valid');
  assert.equal(fileOnly.status === 'valid' && fileOnly.config.app.baseUrl, 'https://test.example.com');

  const withEnv = loadConfig(root, { env: { PW_BASE_URL: 'https://env.example.com', PW_RETRIES: '3' } });
  assert.ok(withEnv.status === 'valid');
  assert.equal(withEnv.config.app.baseUrl, 'https://env.example.com');
  assert.equal(withEnv.config.execution.retries, 3);
  assert.equal(withEnv.config.app.environment, 'qa', 'sibling keys survive a deep merge');
  assert.deepEqual(withEnv.sources, ['defaults', 'config/automation.config.json', 'env:PW_BASE_URL', 'env:PW_RETRIES']);

  const withArgs = loadConfig(root, {
    env: { PW_BASE_URL: 'https://env.example.com' },
    overrides: { app: { baseUrl: 'https://arg.example.com' } },
  });
  assert.ok(withArgs.status === 'valid');
  assert.equal(withArgs.config.app.baseUrl, 'https://arg.example.com');
});

test('invalid env override is surfaced, not ignored', (t) => {
  const root = tmpRoot(t);
  saveConfig(root, validConfig());
  const s = loadConfig(root, { env: { PW_WORKERS: 'many' } });
  assert.equal(s.status, 'invalid');
  assert.ok('issues' in s && s.issues.some((i) => i.path === 'execution.workers'));
});

// ---------- config -> playwright.config ----------

test('playwright.config is a plain Playwright config with the approved values as literals', () => {
  const cfg = { ...validConfig(), browsers: ['chromium', 'firefox'] as ('chromium' | 'firefox')[], reporters: ['html', 'json', 'junit', 'allure', 'evidence-pdf'] as const };
  const text = renderPlaywrightConfig({ ...cfg, reporters: [...cfg.reporters] }, { allure: false });
  assert.match(text, /import \{ defineConfig, devices \} from '@playwright\/test';/);
  assert.doesNotMatch(text, /dependencies|loadConfig|playwright-settings/, 'self-contained: no link to the pipeline engine');
  assert.match(text, /baseURL: process\.env\.PW_BASE_URL \|\| 'https:\/\/test\.example\.com'/);
  assert.match(text, /timeout: 30000,/);
  assert.match(text, /screenshot: 'only-on-failure',\n\s+video: 'retain-on-failure',\n\s+trace: 'retain-on-failure',/);
  assert.match(text, /\['json', \{ outputFile: `reports\/\$\{scope\}\/results\.json` \}\]/);
  assert.match(text, /outputDir: `\.\/test-results\/\$\{scope\}`/);
  assert.match(text, /\['html', .*\],\n\s+\['json', .*\],\n\s+\['junit'/, 'reporters follow the configured order');
  assert.doesNotMatch(text, /allure-playwright/, 'allure is not enabled while its adapter is missing');
  assert.match(text, /\{ name: 'chromium', use: \{ \.\.\.devices\['Desktop Chrome'\] \} \}/);
  assert.match(text, /\{ name: 'firefox', use: \{ \.\.\.devices\['Desktop Firefox'\] \} \}/);
  assert.match(text, /testMatch: '\*\*\/\*\.spec\.ts'/);
  assert.match(renderPlaywrightConfig({ ...cfg, reporters: [...cfg.reporters] }, { allure: true }), /allure-playwright/);
  assert.match(renderPlaywrightConfig({ ...validConfig(), language: 'javascript' }, { allure: false }), /testMatch: '\*\*\/\*\.spec\.js'/);
});

test('storage-state auth: the setup project always runs first, and tests that sign in themselves run last', () => {
  const cfg = validConfig();
  cfg.auth = { approach: 'storage-state', credentialEnvVars: ['TEST_USER_PASSWORD'] };
  const text = renderPlaywrightConfig(cfg, { allure: false });
  // The login step is never left out: it re-checks a saved session in this run, so no test starts on a session that has ended.
  assert.doesNotMatch(text, /reuseSavedLogin/);
  assert.match(text, /\{ name: 'setup', testDir: '\.\/auth', testMatch: '\*\*\/\*\.setup\.ts', teardown: 'own-session' \},/);
  // Playwright resolves a relative storageState against the working directory, so it is anchored to the config's folder.
  assert.match(text, /storageState: `\$\{import\.meta\.dirname\}\/auth\/storage-state\.json` \}, dependencies: \['setup'\], grepInvert: \/@own-session\/ \},/);
  // Tests tagged @own-session start signed out and are the teardown of the setup project: they run after everything that shares the login.
  assert.match(text, /\{ name: 'own-session', use: \{ \.\.\.devices\['Desktop Chrome'\] \}, grep: \/@own-session\/ \},/);
  assert.ok(text.indexOf("name: 'setup'") < text.indexOf("name: 'chromium'"), 'setup is listed before the browsers');
  const plain = renderPlaywrightConfig(validConfig(), { allure: false });
  assert.doesNotMatch(plain, /setup|own-session|reuseSavedLogin/, 'no saved login: no setup, no signed-out project');
});

test('workers and in-file parallelism come from the execution plan', () => {
  const text = (execution: Partial<AutomationConfig['execution']>) => renderPlaywrightConfig({ ...validConfig(), execution: { ...validConfig().execution, ...execution } }, { allure: false });
  assert.match(text({}), /fullyParallel: false,[\s\S]*Number\(process\.env\.PW_WORKERS\) : 2,/, 'conservative by default');
  assert.match(text({ workers: 4, isolation: 'shared-readonly' }), /fullyParallel: true,[\s\S]*: 4,/);
  assert.match(text({ workers: 4, isolation: 'serial' }), /fullyParallel: false,[\s\S]*: 1,/);
});

test('config save writes playwright.config; a hand-edited file is kept, --force rewrites it', (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'playwright.config.ts');
  writeFileSync(file, `// builder:config sha256=${UNCONFIGURED}\nexport default {};\n`);

  saveConfig(root, validConfig());
  assert.equal(syncFromSavedConfig(root)?.status, 'written', 'the unconfigured scaffold file is replaced');
  assert.match(readFileSync(file, 'utf8'), /test\.example\.com/);
  assert.equal(syncFromSavedConfig(root)?.status, 'unchanged');

  // A saved setting changes and the file is still as generated: it follows.
  saveConfig(root, { ...validConfig(), execution: { workers: 2, retries: 0, timeoutMs: 45_000, isolation: 'shared-readonly' } });
  assert.equal(syncFromSavedConfig(root)?.status, 'written');
  assert.match(readFileSync(file, 'utf8'), /timeout: 45000,[\s\S]*Number\(process\.env\.PW_WORKERS\) : 2,/);

  // The user edits it: later saves leave it alone.
  writeFileSync(file, readFileSync(file, 'utf8').replace('fullyParallel: true', 'fullyParallel: false'));
  saveConfig(root, { ...validConfig(), execution: { workers: null, retries: 3, timeoutMs: 30_000, isolation: 'shared-readonly' } });
  const kept = syncFromSavedConfig(root);
  assert.equal(kept?.status, 'kept');
  assert.match(kept?.detail ?? '', /edited by hand/);
  assert.match(readFileSync(file, 'utf8'), /fullyParallel: false/);

  assert.equal(syncFromSavedConfig(root, { force: true })?.status, 'written');
  assert.match(readFileSync(file, 'utf8'), /fullyParallel: true/);
});

test('PW_* environment overrides are read by the generated file at run time, never baked in', (t) => {
  const root = tmpRoot(t);
  saveConfig(root, validConfig());
  const prior = process.env.PW_BASE_URL;
  process.env.PW_BASE_URL = 'https://override.example.com';
  try {
    syncFromSavedConfig(root);
  } finally {
    if (prior === undefined) delete process.env.PW_BASE_URL;
    else process.env.PW_BASE_URL = prior;
  }
  assert.doesNotMatch(readFileSync(path.join(root, 'playwright.config.ts'), 'utf8'), /override\.example\.com/);
});

test('syncFromSavedConfig does nothing without a valid saved config', (t) => {
  const root = tmpRoot(t);
  assert.equal(syncFromSavedConfig(root), null);
  assert.equal(existsSync(path.join(root, 'playwright.config.ts')), false);
});

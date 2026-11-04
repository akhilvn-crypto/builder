// Read-only environment inspection. NEVER installs anything.
// Each missing dependency carries a proposed install command that the setup skill must
// present to the user and get explicit approval for, one dependency at a time.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type ConfigState } from '../config/load-config.ts';
import { readScaffold, type Scaffold } from '../config/scaffold.ts';
import type { AutomationConfig } from '../config/schema.ts';
import { AUTH_DIR, AUTH_STATE_FILE } from '../config/playwright-config.ts';
import { readJson } from '../utils/fs.ts';
import { isIgnored } from '../utils/gitignore.ts';

export type CheckStatus = 'ok' | 'missing' | 'error';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  required: boolean; // required given the current (or recommended) configuration
  version: string | null;
  location: 'project' | 'global' | 'system' | null;
  purpose: string;
  installCommand: string | null; // proposal only — requires explicit user approval
  detail: string | null;
}

export interface PreflightReport {
  checkedAt: string;
  rootDir: string;
  platform: string;
  ready: boolean; // every required check is ok and config is valid
  checks: PreflightCheck[];
  scaffold: Scaffold | null; // language chosen at init; null for an unscaffolded/legacy folder
  config: { status: ConfigState['status']; issues: { path: string; kind: string; message: string }[]; sources: string[] };
}

export interface PreflightDeps {
  run: (cmd: string, args: string[]) => { ok: boolean; stdout: string };
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
}

const defaultDeps: PreflightDeps = {
  run: (cmd, args) => {
    // A shell resolves npm/.cmd shims on Windows. cmd/args are fixed literals, never user input.
    const r = spawnSync([cmd, ...args].join(' '), { encoding: 'utf8', shell: true, timeout: 30_000, windowsHide: true });
    return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
  },
  env: process.env,
  nodeVersion: process.versions.node,
};

function localPackageVersion(rootDir: string, pkg: string): string | null {
  const r = readJson(path.join(rootDir, 'node_modules', ...pkg.split('/'), 'package.json'));
  if (!r.ok) return null;
  const v = (r.value as { version?: unknown }).version;
  return typeof v === 'string' ? v : null;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

// Default Playwright browser cache location per OS, unless PLAYWRIGHT_BROWSERS_PATH overrides it.
export function browsersCacheDir(env: NodeJS.ProcessEnv): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') return override;
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
}

interface BrowsersJson {
  browsers: { name: string; revision: string }[];
}

function checkBrowsers(rootDir: string, config: AutomationConfig | null, env: NodeJS.ProcessEnv): PreflightCheck[] {
  const wanted: string[] = [...(config?.browsers ?? ['chromium'])];
  // The evidence PDF is printed by Chromium, whatever browsers the tests run in.
  if (config?.reporters.includes('evidence-pdf') && !wanted.includes('chromium')) wanted.push('chromium');
  const purpose = (b: string) => (config && !config.browsers.includes(b as never) ? 'Render the evidence PDF' : 'Run generated tests');
  const manifest = readJson(path.join(rootDir, 'node_modules', 'playwright-core', 'browsers.json'));
  if (!manifest.ok) {
    return wanted.map((b) => ({
      id: `browser:${b}`,
      label: `Playwright ${b} browser`,
      status: 'missing' as const,
      required: true,
      version: null,
      location: null,
      purpose: purpose(b),
      installCommand: `npx playwright install ${b}`,
      detail: 'Cannot determine the required browser revision until @playwright/test is installed in the project.',
    }));
  }
  const cache = browsersCacheDir(env);
  const entries = (manifest.value as BrowsersJson).browsers;
  return wanted.map((b) => {
    // Chromium headless runs use chromium_headless_shell in recent Playwright versions.
    const names = b === 'chromium' ? ['chromium', 'chromium-headless-shell'] : [b];
    const missing: string[] = [];
    const revisions: string[] = [];
    for (const n of names) {
      const entry = entries.find((e) => e.name === n);
      if (!entry) continue;
      revisions.push(`${n}@${entry.revision}`);
      const dir = path.join(cache, `${n.replace(/-/g, '_')}-${entry.revision}`);
      if (!existsSync(dir)) missing.push(dir);
    }
    return {
      id: `browser:${b}`,
      label: `Playwright ${b} browser`,
      status: missing.length === 0 && revisions.length > 0 ? 'ok' : 'missing',
      required: true,
      version: revisions.join(', ') || null,
      location: missing.length === 0 ? 'system' : null,
      purpose: purpose(b),
      installCommand: missing.length === 0 ? null : `npx playwright install ${b}`,
      detail: missing.length === 0 ? `cache: ${cache}` : `missing: ${missing.join(', ')}`,
    } satisfies PreflightCheck;
  });
}

export function runPreflight(rootDir: string, deps: PreflightDeps = defaultDeps): PreflightReport {
  const cfgState = loadConfig(rootDir, { env: deps.env });
  const config = cfgState.status === 'valid' ? cfgState.config : null;
  const checks: PreflightCheck[] = [];

  const nodeMajor = Number(deps.nodeVersion.split('.')[0]);
  checks.push({
    id: 'node',
    label: 'Node.js',
    // No version floor: this code is already running, so the installed Node can execute it.
    status: 'ok',
    required: true,
    version: deps.nodeVersion,
    location: 'system',
    purpose: 'Runtime for the pipeline (native TypeScript execution) and Playwright',
    installCommand: null,
    detail: null,
  });

  const npm = deps.run('npm', ['--version']);
  checks.push({
    id: 'npm',
    label: 'npm',
    status: npm.ok ? 'ok' : 'missing',
    required: true,
    version: npm.ok ? firstLine(npm.stdout) : null,
    location: 'system',
    purpose: 'Project package manager (package-lock.json)',
    installCommand: null,
    detail: existsSync(path.join(rootDir, 'package-lock.json')) ? 'package-lock.json present' : 'no lockfile yet',
  });

  const scaffold = readScaffold(rootDir);
  const usesTs = (config?.language ?? scaffold?.language ?? 'typescript') === 'typescript';
  const tsVersion = localPackageVersion(rootDir, 'typescript');
  checks.push({
    id: 'typescript',
    label: 'TypeScript compiler',
    status: tsVersion ? 'ok' : 'missing',
    required: usesTs,
    version: tsVersion,
    location: tsVersion ? 'project' : null,
    purpose: 'Type-check framework code and generated tests',
    installCommand: tsVersion ? null : 'npm install --save-dev --save-exact typescript @types/node@' + nodeMajor,
    detail: null,
  });

  const pwTest = localPackageVersion(rootDir, '@playwright/test');
  checks.push({
    id: '@playwright/test',
    label: 'Playwright Test',
    status: pwTest ? 'ok' : 'missing',
    required: true,
    version: pwTest,
    location: pwTest ? 'project' : null,
    purpose: 'Test runner for generated tests',
    installCommand: pwTest ? null : 'npm install --save-dev --save-exact @playwright/test',
    detail: null,
  });

  checks.push(...checkBrowsers(rootDir, config, deps.env));

  const cliLocal = localPackageVersion(rootDir, '@playwright/cli');
  let cliGlobal: string | null = null;
  if (!cliLocal) {
    const r = deps.run('playwright-cli', ['--version']);
    cliGlobal = r.ok ? firstLine(r.stdout) : null;
  }
  const exploreWithCli = (config?.exploration.tool ?? 'playwright-cli') === 'playwright-cli';
  checks.push({
    id: '@playwright/cli',
    label: 'Playwright CLI (exploration)',
    status: cliLocal || cliGlobal ? 'ok' : 'missing',
    required: exploreWithCli,
    version: cliLocal ?? cliGlobal,
    location: cliLocal ? 'project' : cliGlobal ? 'global' : null,
    purpose: 'Agent-driven application exploration (snapshots, locator discovery)',
    installCommand: cliLocal ? null : 'npm install --save-dev --save-exact @playwright/cli',
    detail: !cliLocal && cliGlobal ? 'Only a global install was found; a project-local pinned install is preferred for reproducibility.' : null,
  });

  const wantsAllure = config?.reporters.includes('allure') ?? false;
  const allureAdapter = localPackageVersion(rootDir, 'allure-playwright');
  checks.push({
    id: 'allure-playwright',
    label: 'Allure Playwright adapter',
    status: allureAdapter ? 'ok' : 'missing',
    required: wantsAllure,
    version: allureAdapter,
    location: allureAdapter ? 'project' : null,
    purpose: 'Write Allure results from Playwright Test',
    installCommand: allureAdapter ? null : 'npm install --save-dev --save-exact allure-playwright',
    detail: null,
  });
  const allureLocal = localPackageVersion(rootDir, 'allure');
  let allureGlobal: string | null = null;
  if (!allureLocal) {
    const r = deps.run('allure', ['--version']);
    allureGlobal = r.ok ? firstLine(r.stdout) : null;
  }
  checks.push({
    id: 'allure-cli',
    label: 'Allure report CLI',
    status: allureLocal || allureGlobal ? 'ok' : 'missing',
    required: wantsAllure,
    version: allureLocal ?? allureGlobal,
    location: allureLocal ? 'project' : allureGlobal ? 'global' : null,
    purpose: 'Generate the Allure HTML report from allure-results',
    installCommand: allureLocal || allureGlobal ? null : 'npm install --save-dev --save-exact allure',
    detail: 'Verify current Allure CLI guidance before installing (Allure 3 ships as the npm "allure" package).',
  });

  // Secrets and saved sessions must never be committed. Required as soon as the configuration uses either.
  const usesSecrets = config !== null && (config.auth.credentialEnvVars.length > 0 || config.auth.approach === 'storage-state');
  const unprotected = [['.env', '.env'], [AUTH_STATE_FILE, `saved login state (${AUTH_DIR}/)`]].filter(([file]) => !isIgnored(rootDir, file!)).map(([, label]) => label!);
  checks.push({
    id: 'secrets-ignored',
    label: 'Secrets excluded from version control',
    status: unprotected.length === 0 ? 'ok' : 'error',
    required: usesSecrets,
    version: null,
    location: 'project',
    purpose: `Credentials (.env) and saved login sessions (${AUTH_DIR}/) must never be committed`,
    installCommand: null,
    detail: unprotected.length === 0 ? null : `not covered by automation/.gitignore: ${unprotected.join(', ')}. Add ".env" and "${AUTH_DIR}/storage-state*.json" to it.`,
  });

  const configOk = cfgState.status === 'valid';
  return {
    checkedAt: new Date().toISOString(),
    rootDir,
    platform: `${process.platform}-${process.arch}`,
    scaffold,
    ready: configOk && checks.every((c) => !c.required || c.status === 'ok'),
    checks,
    config: {
      status: cfgState.status,
      issues: cfgState.status === 'valid' ? [] : cfgState.issues,
      sources: cfgState.sources,
    },
  };
}

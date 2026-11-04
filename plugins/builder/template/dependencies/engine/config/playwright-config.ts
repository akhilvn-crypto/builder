// Writes automation/playwright.config.{ts,js} as an ordinary Playwright config (the same shape `npm init playwright`
// creates) with the approved values from config/automation.config.json filled in as plain literals. Pure rendering plus
// one small file sync; no @playwright/test import, so it is unit-tested without Playwright installed.
//
// The file belongs to the user: edit it like any Playwright config. It is rewritten from automation.config.json only
// while it is still as this module wrote it. A header line carries a hash of the generated text; if the file no longer
// matches it, someone edited it by hand and it is left alone (unless forced).
//
// Output stays inside the framework folders from playwright_framework_structure.md. When the executor sets
// PIPELINE_RUN_ID and PIPELINE_LABEL, reporter output goes to reports/<run-id>/<label>/ and evidence (screenshots,
// video, traces) to test-results/<run-id>/<label>/. A plain `npx playwright test` uses reports/adhoc/ and
// test-results/adhoc/, so it never wipes a pipeline run's evidence (Playwright cleans its outputDir on start).
//
// Saved login state (auth.approach "storage-state"): the `setup` project ALWAYS runs first and every browser project depends on it,
// so no test can start before the login exists. The executor sets PIPELINE_AUTH_STATE=reuse once it has checked the saved state's
// age (pipeline/auth-state.ts); the setup (helpers/auth reuseOrSignIn) then asks the application whether the saved session is still
// accepted and signs in again if not. Anything else (including a plain `npx playwright test`) signs in.
// Tests that sign in themselves are tagged @own-session and start signed out. They run in the `own-session` project, which is the
// teardown of `setup`: Playwright runs it after every project that depends on `setup` has finished, pass or fail, so signing in
// again as the same account can never end the session a test is still using. (A project can have only one teardown, so with
// several browsers these tests run in the first browser only.)
// Workers and in-file parallelism come from pipeline/execution-plan.ts (a conservative default; PW_WORKERS, which the
// executor sets after reading the per-worker accounts from .env, overrides the number).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADHOC_SCOPE, EVIDENCE_DIR, REPORTS_DIR } from '../pipeline/artifact-manager.ts';
import { resolveExecutionPlan } from '../pipeline/execution-plan.ts';
import { OWN_SESSION_TAG } from '../pipeline/session-layout.ts';
import { loadConfig } from './load-config.ts';
import type { AutomationConfig, Browser } from './schema.ts';

export const AUTH_DIR = 'auth'; // login setup (*.setup.*) and the saved storage state; the state file is git-ignored
export const AUTH_STATE_FILE = `${AUTH_DIR}/storage-state.json`;
export const SETUP_PROJECT = 'setup'; // signs in; every browser project depends on it
export const OWN_SESSION_PROJECT = 'own-session'; // tests that sign in themselves; the teardown of the setup project, so they run last

const MARKER = '// builder:config sha256=';
// Shipped in the scaffold before any configuration exists: nothing is hand-edited yet, so the first render replaces it.
export const UNCONFIGURED = 'unconfigured';

const DEVICE: Record<Browser, string> = { chromium: 'Desktop Chrome', firefox: 'Desktop Firefox', webkit: 'Desktop Safari' };

export interface RenderOptions {
  allure: boolean; // allure-playwright is installed; the reporter is only listed when it can be loaded
}

function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function bodyHash(text: string): string {
  const body = text.split('\n').filter((l) => !l.startsWith(MARKER)).join('\n');
  return createHash('sha256').update(body).digest('hex');
}

export function renderPlaywrightConfig(config: AutomationConfig, opts: RenderOptions): string {
  const ext = config.language === 'typescript' ? 'ts' : 'js';
  const storageState = config.auth.approach === 'storage-state';

  const reporters = ["['list']"];
  for (const r of config.reporters) {
    if (r === 'json') reporters.push(`['json', { outputFile: \`${REPORTS_DIR}/\${scope}/results.json\` }]`);
    else if (r === 'html') reporters.push(`['html', { outputFolder: \`${REPORTS_DIR}/\${scope}/html\`, open: 'never' }]`);
    else if (r === 'junit') reporters.push(`['junit', { outputFile: \`${REPORTS_DIR}/\${scope}/junit.xml\` }]`);
    else if (r === 'allure' && opts.allure) {
      reporters.push(`['allure-playwright', { resultsDir: \`${REPORTS_DIR}/\${scope}/allure-results\`, detail: true, suiteTitle: true }]`);
    }
    // 'evidence-pdf' has no Playwright reporter: Playwright records the per-test video (evidence.video "on"), the fixture records
    // the step log and a final-state screenshot, and report_generation builds the PDF with the videos embedded.
  }

  // The fallback worker count when nothing sets PW_WORKERS: the plan without per-worker accounts (they are read from .env at run time).
  const plan = resolveExecutionPlan(config, {}, Number.MAX_SAFE_INTEGER);
  const projects: string[] = [];
  if (storageState) {
    projects.push(`    { name: ${q(SETUP_PROJECT)}, testDir: ${q(`./${AUTH_DIR}`)}, testMatch: ${q(`**/*.setup.${ext}`)}, teardown: ${q(OWN_SESSION_PROJECT)} },`);
  }
  for (const b of config.browsers) {
    projects.push(storageState
      ? `    { name: ${q(b)}, use: { ...devices[${q(DEVICE[b])}], storageState: \`\${import.meta.dirname}/${AUTH_STATE_FILE}\` }, dependencies: [${q(SETUP_PROJECT)}], grepInvert: /${OWN_SESSION_TAG}/ },`
      : `    { name: ${q(b)}, use: { ...devices[${q(DEVICE[b])}] } },`);
  }
  // Signed-out tests: no saved login, and they run last (see the note at the top of this file).
  if (storageState) projects.push(`    { name: ${q(OWN_SESSION_PROJECT)}, use: { ...devices[${q(DEVICE[config.browsers[0]!])}] }, grep: /${OWN_SESSION_TAG}/ },`);

  const lines = [
    '// Playwright Test configuration. Written by the Builder pipeline from config/automation.config.json and',
    '// meant to be read and edited like any Playwright config. While this file is unchanged the pipeline refreshes it when a',
    '// setting changes; once you edit it, the pipeline leaves it alone (`config render --force` rewrites it).',
    MARKER,
    '',
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    '// Secrets live in .env (git-ignored). Node\'s built-in loader; no dotenv dependency.',
    'try {',
    '  process.loadEnvFile(`${import.meta.dirname}/.env`);',
    '} catch {',
    '  // no .env file: credentials may come from the real environment',
    '}',
    '',
    `// Pipeline runs write to ${REPORTS_DIR}/<run id>/<label>; a plain \`npx playwright test\` writes to ${REPORTS_DIR}/${ADHOC_SCOPE}.`,
    'const scope = process.env.PIPELINE_RUN_ID',
    "  ? `${process.env.PIPELINE_RUN_ID}/${process.env.PIPELINE_LABEL ?? 'initial'}`",
    `  : ${q(ADHOC_SCOPE)};`,
    '',
    'export default defineConfig({',
    "  testDir: './tests',",
    `  testMatch: ${q(`**/*.spec.${ext}`)},`,
    `  outputDir: \`./${EVIDENCE_DIR}/\${scope}\`,`,
    `  timeout: ${config.execution.timeoutMs},`,
    `  fullyParallel: ${plan.fullyParallel},`,
    '  forbidOnly: true,',
    `  retries: process.env.PW_RETRIES ? Number(process.env.PW_RETRIES) : ${config.execution.retries},`,
    `  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : ${plan.workers},`,
    '  reporter: [',
    ...reporters.map((r) => `    ${r},`),
    '  ],',
    '  use: {',
    `    baseURL: process.env.PW_BASE_URL || ${q(config.app.baseUrl)},`,
    "    testIdAttribute: 'data-testid',",
    `    screenshot: ${q(config.evidence.screenshot)},`,
    `    video: ${q(config.evidence.video)},`,
    `    trace: ${q(config.evidence.trace)},`,
    '  },',
    '  projects: [',
    ...projects,
    '  ],',
    '});',
    '',
  ];
  const text = lines.join('\n');
  return text.replace(MARKER, `${MARKER}${bodyHash(text)}`);
}

export type SyncStatus = 'written' | 'unchanged' | 'kept';

export interface SyncResult {
  status: SyncStatus;
  file: string;
  // 'kept': the file differs from what the pipeline wrote, so it was treated as hand-edited and not touched.
  detail?: string;
}

// Brings automation/playwright.config.* in line with the saved config, unless the user has edited it.
export function syncPlaywrightConfig(rootDir: string, config: AutomationConfig, opts: { force?: boolean } = {}): SyncResult {
  const ext = config.language === 'typescript' ? 'ts' : 'js';
  const file = path.join(rootDir, `playwright.config.${ext}`);
  const next = renderPlaywrightConfig(config, { allure: existsSync(path.join(rootDir, 'node_modules', 'allure-playwright', 'package.json')) });

  const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === next) return { status: 'unchanged', file };
  if (current !== null && !opts.force) {
    const recorded = current.split('\n').find((l) => l.startsWith(MARKER))?.slice(MARKER.length).trim();
    const pristine = recorded === UNCONFIGURED || (recorded !== undefined && recorded === bodyHash(current));
    if (!pristine) {
      return { status: 'kept', file, detail: `${path.basename(file)} was edited by hand, so the saved settings were not applied to it. Update it yourself, or run "config render --force" to rewrite it from automation.config.json.` };
    }
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, file);
  return { status: 'written', file };
}

// Same, from the saved file alone. PW_* environment overrides are deliberately left out: the generated file reads them
// itself at run time, so they must not be baked in as literals. Null when the saved config is absent or invalid.
export function syncFromSavedConfig(rootDir: string, opts: { force?: boolean } = {}): SyncResult | null {
  const state = loadConfig(rootDir, { env: {} });
  return state.status === 'valid' ? syncPlaywrightConfig(rootDir, state.config, opts) : null;
}

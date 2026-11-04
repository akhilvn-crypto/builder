// Shared Playwright Test fixtures. Generated and handwritten tests import { test, expect } from here.
//
//   import { test, expect } from '../fixtures/test.js';
//   test('[TC-001] Valid user can sign in', { annotation: { type: 'testId', description: 'TC-001' } }, async ({ page }) => { ... });
//
// `diagnostics` (auto): collects console errors, page errors and failed requests, and attaches them
// (secret-redacted) only when the test does not end with its expected status. It also attaches "final-url" then: the address the
// page ended on, without query or fragment. The pipeline uses it to tell a test that was sent back to the login page (the
// session ended) from one that failed for another reason.
//
// `stepEvidence` (auto, only in audit mode with reporting.stepScreenshots and the "evidence-pdf" reporter): wraps `test.step`
// so that every step records its outcome, duration and error, and takes ONE final-state screenshot when the test ends. The
// journey itself is Playwright's own per-test video (evidence.video "on"), which report_generation embeds in the evidence PDF
// next to the screenshot. Without that reporter nothing is captured, so normal runs pay nothing for it. Password inputs and
// reporting.maskSelectors are masked in the screenshot.
// evidence-fixture-revision: 4 (init --update uses this marker to tell a current copy from an older one)
//
// `cleanup` (opt-in): see its definition below.
//
// Add project-wide fixtures here (e.g. an authenticated API client) with test.extend; keep them app-agnostic.

import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { loadConfig } from '../../dependencies/engine/config/load-config.ts';
import { startCleanup } from '../../dependencies/engine/pipeline/cleanup-fixture.ts';
import { redactionEnvVars } from '../../dependencies/engine/pipeline/env-file.ts';
import { redactSensitive } from '../../dependencies/engine/utils/redact.ts';
import {
  SCREENSHOT_MIME, SCREENSHOT_QUALITY, STEP_LOG_ATTACHMENT, STEP_LOG_DIR, STEP_LOG_FILE, STEP_LOG_SCHEMA_VERSION,
} from '../../dependencies/engine/pipeline/step-evidence.ts';
import { redact, secretValues } from '../helpers/test-data.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// Configured credential variables plus the ones the pipeline created in .env from the test cases.
/** @returns {string[]} */
function credentialEnvVars() {
  const state = loadConfig(ROOT);
  return redactionEnvVars(ROOT, state.status === 'valid' ? state.config.auth.credentialEnvVars : []);
}

// Decided once per worker, when this file is loaded.
const EVIDENCE = (() => {
  const state = loadConfig(ROOT);
  if (state.status !== 'valid' || !state.config.reporters.includes('evidence-pdf')) return null;
  return { maskSelectors: ['input[type="password"]', ...(state.config.reporting?.maskSelectors ?? [])] };
})();

/**
 * The test currently running in this worker (a worker runs one test at a time).
 * @typedef {{ page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, entries: object[], counter: number, depth: number }} Recording
 */
/** @type {Recording | null} */
let recording = null;

const ANSI = /\u001b\[[0-9;]*m/g;

/** @param {string} text */
function clean(text) {
  return redactSensitive(redact(text.replace(ANSI, ''), secretValues(credentialEnvVars())));
}

// Attaches a file by path. Playwright copies it into the attempt's attachments/ folder; the scratch original is then removed
// so the evidence is stored once (only when the copy exists, in case a Playwright version references the original).
/**
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} name
 * @param {string} file
 * @param {string} contentType
 */
async function attachFile(testInfo, name, file, contentType) {
  await testInfo.attach(name, { path: file, contentType });
  if (testInfo.attachments.at(-1)?.path !== file) rmSync(file, { force: true });
}

// Takes the final-state screenshot and attaches it (so the HTML/Allure reports show it too). `name` is also what the step log
// refers to it by; it stays short because Playwright puts it in the file path and Windows paths are limited to 260 characters.
/**
 * @param {Recording} r
 * @param {string} name
 * @returns {Promise<{ screenshot: string | null, note: string | null }>}
 */
async function capture(r, name) {
  if (r.page.isClosed()) return { screenshot: null, note: 'the page was already closed' };
  try {
    const file = r.testInfo.outputPath(STEP_LOG_DIR, `${name}.jpg`);
    const mask = (EVIDENCE?.maskSelectors ?? []).map((selector) => r.page.locator(selector));
    await r.page.screenshot({ path: file, type: 'jpeg', quality: SCREENSHOT_QUALITY, animations: 'disabled', caret: 'hide', timeout: 5_000, mask, maskColor: '#555555' });
    await attachFile(r.testInfo, name, file, SCREENSHOT_MIME);
    return { screenshot: name, note: null };
  } catch (err) {
    return { screenshot: null, note: clean(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) };
  }
}

/**
 * @template T
 * @param {string} title
 * @param {() => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function recordStep(title, body) {
  const r = recording;
  if (!r) return body();
  const index = ++r.counter;
  const depth = r.depth++;
  const startedAt = new Date();
  /** @type {string | null} */
  let error = null;
  try {
    return await body();
  } catch (err) {
    error = clean(err instanceof Error ? err.message : String(err)).slice(0, 1500);
    throw err;
  } finally {
    const durationMs = Date.now() - startedAt.getTime();
    r.depth--;
    r.entries.push({
      index, depth, title: clean(title), status: error === null ? 'passed' : 'failed', startedAt: startedAt.toISOString(),
      durationMs, error,
    });
  }
}

/**
 * The page's address without query or fragment (they can carry tokens); null when the page is already gone.
 * @param {import('@playwright/test').Page} page
 * @returns {string | null}
 */
function finalUrlOf(page) {
  if (page.isClosed()) return null;
  try {
    const u = new URL(page.url());
    return `${u.origin}${u.pathname}`;
  } catch {
    return null; // about:blank and the like
  }
}

const extended = base.extend({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      /** @type {string[]} */
      const lines = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') lines.push(`console.${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => lines.push(`requestfailed: ${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`));
      page.on('response', (r) => {
        if (r.status() >= 500) lines.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        const finalUrl = finalUrlOf(page);
        if (finalUrl) await testInfo.attach('final-url', { body: finalUrl, contentType: 'text/plain' });
        if (lines.length > 0) {
          const body = redactSensitive(redact(lines.join('\n'), secretValues(credentialEnvVars())));
          await testInfo.attach('diagnostics', { body, contentType: 'text/plain' });
        }
      }
    },
    { auto: true },
  ],

  stepEvidence: [
    async ({ page }, use, testInfo) => {
      if (!EVIDENCE) {
        await use();
        return;
      }
      /** @type {Recording} */
      const r = { page, testInfo, entries: [], counter: 0, depth: 0 };
      recording = r;
      try {
        await use();
      } finally {
        recording = null;
        const final = await capture(r, 'final');
        const log = {
          schemaVersion: STEP_LOG_SCHEMA_VERSION,
          testTitle: clean(testInfo.title),
          steps: [...r.entries].sort((a, b) => a.index - b.index),
          final: { status: testInfo.status ?? 'unknown', screenshot: final.screenshot, screenshotNote: final.note },
        };
        const file = testInfo.outputPath(STEP_LOG_DIR, STEP_LOG_FILE);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(log, null, 2));
        await attachFile(testInfo, STEP_LOG_ATTACHMENT, file, 'application/json');
        try {
          rmdirSync(path.dirname(file)); // only succeeds when the scratch folder is empty
        } catch {
          // something is still in it (or it is gone): leave it
        }
      }
    },
    { auto: true },
  ],
  // `cleanup` (opt-in: a test lists it as a parameter): records what the test creates and removes it when the test ends, also when it
  // failed or timed out. `cleanup.register({ entity, identifier, undo })` right after creating something; `undo` deletes it the way the
  // app allows. Records are written to the run's created-data/ folder first, so the post-run sweep can still find them. Deleting only
  // happens when config.cleanup allows it for this environment (never production). A cleanup problem is attached, never a test failure.
  cleanup: async ({ page }, use, testInfo) => {
    void page; // depends on the page so this fixture is torn down while the page is still open
    const session = startCleanup(ROOT, testInfo, (text) => redactSensitive(redact(text, secretValues(credentialEnvVars()))));
    await use(session);
    const outcome = await session.run();
    const problems = outcome.filter((o) => o.status !== 'deleted' && o.status !== 'verified_gone');
    if (problems.length > 0) {
      const body = problems.map((o) => `${o.entity} "${o.identifier}": ${o.status}${o.error ? ` (${o.error})` : ''}`).join('\n');
      await testInfo.attach('data-cleanup', { body, contentType: 'text/plain' });
    }
  },
});

// Record every test.step when evidence is wanted (test.step.skip is kept as it is). Any other use of `test` is untouched.
if (EVIDENCE) {
  const originalStep = extended.step;
  const recorded = (title, body, options) => originalStep(title, (info) => recordStep(title, () => body(info)), options);
  extended.step = Object.assign(recorded, { skip: originalStep.skip });
}

export const test = extended;
export { expect };

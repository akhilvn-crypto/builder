// Exploration fallback when the Playwright CLI is unavailable or not approved, and the deterministic page snapshotter behind
// `explore snapshot`. Uses only the already-installed @playwright/test: opens a URL headless, saves its accessibility snapshot
// (and, in single mode, a screenshot), then closes. Navigation only — no clicks, no form input.
//
//   node dependencies/engine/tools/aria-snapshot.ts --url http://localhost:4173/login --out runs/<id>/exploration/login
//   node dependencies/engine/tools/aria-snapshot.ts --batch <jobs.json> [--storage-state <file>] [--settle-ms <n>]
//
// --framework <dir> names the folder @playwright/test is resolved from (default: automation/ next to this tool's dependencies/ folder).
// --out is relative to the dependencies/ folder, whatever the caller's working directory is (an absolute path is used as it is).
// @playwright/test is resolved from automation/ (where it is installed), not from this file's location.
//
// Batch mode takes one browser for many pages. The jobs file is a JSON array of { "key": string, "url": string, "out": string }
// (out = snapshot file path). It prints { ok, results: [{ key, ok, url, status, title, snapshot, error }] }. A page that cannot be
// reached is reported with ok:false; whether the page it landed on is the page that was asked for is the caller's decision.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEPENDENCIES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_FRAMEWORK = path.join(path.dirname(DEPENDENCIES), 'automation');
const rel = (abs: string) => path.relative(DEPENDENCIES, abs).split(path.sep).join('/');

interface Page {
  goto(url: string, o: { waitUntil: 'load' }): Promise<{ status(): number } | null>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  screenshot(o: { path: string; fullPage: boolean }): Promise<unknown>;
  waitForLoadState(state: 'networkidle', o: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  title(): Promise<string>;
  url(): string;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(): Promise<{ newContext(o: { storageState?: string }): Promise<Context>; close(): Promise<void> }> };
}

const { values } = parseArgs({
  options: {
    url: { type: 'string' }, out: { type: 'string' }, batch: { type: 'string' },
    'storage-state': { type: 'string' }, 'settle-ms': { type: 'string' }, framework: { type: 'string' },
  },
});
const FRAMEWORK = values.framework ? path.resolve(values.framework) : DEFAULT_FRAMEWORK; // the pipeline passes the project root it runs against
const single = Boolean(values.url && values.out);
if (!single && !values.batch) {
  process.stderr.write('usage: node dependencies/engine/tools/aria-snapshot.ts --url <url> --out <path-without-extension>\n'
    + '       node dependencies/engine/tools/aria-snapshot.ts --batch <jobs.json> [--storage-state <file>] [--settle-ms <n>]\n');
  process.exit(1);
}

let playwright: Playwright;
try {
  playwright = createRequire(path.join(FRAMEWORK, 'package.json'))('@playwright/test') as Playwright;
} catch {
  process.stderr.write(`@playwright/test is not installed in ${FRAMEWORK}\n`);
  process.exit(1);
}

// Gives a single-page app a moment to render what it fetches after `load`. Best effort: a page that never goes idle (polling,
// websockets) is snapshotted as it is, after the extra settle time.
async function settle(page: Page, extraMs: number): Promise<void> {
  try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* never idle: take it as it is */ }
  if (extraMs > 0) await page.waitForTimeout(extraMs);
}

interface Job { key: string; url: string; out: string }
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

const browser = await playwright.chromium.launch();
try {
  if (single) {
    const out = path.resolve(DEPENDENCIES, values.out!);
    const page = await (await browser.newContext({})).newPage();
    const response = await page.goto(values.url!, { waitUntil: 'load' });
    const snapshot = await page.locator('body').ariaSnapshot();
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(`${out}.aria.yml`, snapshot + '\n');
    await page.screenshot({ path: `${out}.png`, fullPage: true });
    process.stdout.write(JSON.stringify({
      ok: true, url: page.url(), status: response?.status() ?? null, title: await page.title(),
      snapshot: rel(`${out}.aria.yml`), screenshot: rel(`${out}.png`),
    }, null, 2) + '\n');
  } else {
    const jobs = JSON.parse(readFileSync(path.resolve(DEPENDENCIES, values.batch!), 'utf8')) as Job[];
    const settleMs = Math.max(0, Number(values['settle-ms'] ?? 0) || 0);
    const state = values['storage-state'] ? { storageState: path.resolve(values['storage-state']) } : {};
    const results = [];
    for (const job of jobs) {
      // One context per page: nothing one page sets (cookies, storage) can change what the next one shows.
      const context = await browser.newContext(state);
      try {
        const page = await context.newPage();
        const response = await page.goto(job.url, { waitUntil: 'load' });
        await settle(page, settleMs);
        const snapshot = await page.locator('body').ariaSnapshot();
        const out = path.resolve(DEPENDENCIES, job.out);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, snapshot + '\n');
        results.push({ key: job.key, ok: true, url: page.url(), status: response?.status() ?? null, title: await page.title(), snapshot: rel(out), error: null });
      } catch (e) {
        results.push({ key: job.key, ok: false, url: null, status: null, title: null, snapshot: null, error: message(e) });
      } finally {
        await context.close();
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + '\n');
  }
} finally {
  await browser.close();
}

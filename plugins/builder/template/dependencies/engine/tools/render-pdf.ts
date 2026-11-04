// Renders an HTML file to an A4 PDF with the already-installed @playwright/test (headless Chromium). Used by the
// evidence-pdf report; opens only the local file it is given and makes no other requests.
//
//   node dependencies/engine/tools/render-pdf.ts --html <file.html> --pdf <out.pdf> [--footer <text>] [--root <automation dir>]
//
// Exit 0 on success. On failure the last output line is JSON {"ok":false,"reason":"playwright_missing|browser_missing|error",
// "message":...} so the caller can tell a missing tool (needs the user's approval to install) from a real error.
// @playwright/test is resolved from the framework folder (--root, default the sibling automation/), where it is installed.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

interface Page {
  goto(url: string, o: { waitUntil: 'load' }): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, o?: { timeout: number }): Promise<unknown>;
  emulateMedia(o: { media: 'print' }): Promise<void>;
  pdf(o: Record<string, unknown>): Promise<unknown>;
}
interface Playwright {
  chromium: { launch(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> };
}

function fail(reason: 'playwright_missing' | 'browser_missing' | 'error', message: string): never {
  process.stderr.write(`${JSON.stringify({ ok: false, reason, message })}\n`);
  process.exit(reason === 'error' ? 1 : 3);
}

const { values } = parseArgs({ options: { html: { type: 'string' }, pdf: { type: 'string' }, footer: { type: 'string', default: '' }, root: { type: 'string' } } });
if (!values.html || !values.pdf) fail('error', 'usage: node render-pdf.ts --html <file.html> --pdf <out.pdf> [--footer <text>] [--root <automation dir>]');
// dependencies/engine/tools -> dependencies -> <project>/automation
const FRAMEWORK = values.root
  ? path.resolve(values.root)
  : path.join(path.dirname(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')), 'automation');

let playwright: Playwright;
try {
  playwright = createRequire(path.join(FRAMEWORK, 'package.json'))('@playwright/test') as Playwright;
} catch {
  fail('playwright_missing', `@playwright/test is not installed in ${FRAMEWORK}`);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const footer = `<div style="font:8px Helvetica,Arial,sans-serif;color:#5b6675;width:100%;padding:0 12mm;display:flex;justify-content:space-between">`
  + `<span>Test evidence report · ${escapeHtml(values.footer ?? '')}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

let browser: Awaited<ReturnType<Playwright['chromium']['launch']>>;
try {
  browser = await playwright.chromium.launch();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  fail(/Executable doesn't exist|browserType\.launch/i.test(message) ? 'browser_missing' : 'error', message.split('\n')[0]!);
}
let failure: string | null = null;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve(values.html!)).href, { waitUntil: 'load' });
  // Every screenshot must be decoded before printing, or the PDF gets blank boxes.
  await page.waitForFunction('Array.from(document.images).every((i) => i.complete)', undefined, { timeout: 120_000 });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: path.resolve(values.pdf!), format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>', footerTemplate: footer, preferCSSPageSize: true,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, pdf: path.resolve(values.pdf!) })}\n`);
} catch (err) {
  failure = err instanceof Error ? err.message.split('\n')[0]! : String(err);
} finally {
  await browser.close();
}
if (failure !== null) fail('error', failure);

// Shared Playwright Test fixtures. Generated and handwritten tests import { test, expect } from here.
//
//   import { test, expect } from '../fixtures/test.ts';
//   test('[TC-001] Valid user can sign in', { annotation: { type: 'testId', description: 'TC-001' } }, async ({ page }) => { ... });
//
// `diagnostics` (auto): collects console errors, page errors and failed requests, and attaches them
// (secret-redacted) only when the test does not end with its expected status.
//
// Add project-wide fixtures here (e.g. an authenticated API client) with test.extend; keep them app-agnostic.

import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { loadConfig } from '../../dependencies/engine/config/load-config.ts';
import { redactionEnvVars } from '../../dependencies/engine/pipeline/env-file.ts';
import { redact, secretValues } from '../helpers/test-data.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

// Configured credential variables plus the ones the pipeline created in .env from the test cases.
function credentialEnvVars(): string[] {
  const state = loadConfig(ROOT);
  return redactionEnvVars(ROOT, state.status === 'valid' ? state.config.auth.credentialEnvVars : []);
}

export const test = base.extend<{ diagnostics: void }>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const lines: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') lines.push(`console.${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => lines.push(`requestfailed: ${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`));
      page.on('response', (r) => {
        if (r.status() >= 500) lines.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
        const body = redact(lines.join('\n'), secretValues(credentialEnvVars()));
        await testInfo.attach('diagnostics', { body, contentType: 'text/plain' });
      }
    },
    { auto: true },
  ],
});

export { expect };

// Playwright Test configuration. Written by the Builder pipeline from config/automation.config.json and
// meant to be read and edited like any Playwright config. While this file is unchanged the pipeline refreshes it when a
// setting changes; once you edit it, the pipeline leaves it alone (`config render --force` rewrites it).
// builder:config sha256=unconfigured

import { defineConfig, devices } from '@playwright/test';

// Secrets live in .env (git-ignored). Node's built-in loader; no dotenv dependency.
try {
  process.loadEnvFile(`${import.meta.dirname}/.env`);
} catch {
  // no .env file: credentials may come from the real environment
}

// Pipeline runs write to reports/<run id>/<label>; a plain `npx playwright test` writes to reports/adhoc.
const scope = process.env.PIPELINE_RUN_ID
  ? `${process.env.PIPELINE_RUN_ID}/${process.env.PIPELINE_LABEL ?? 'initial'}`
  : 'adhoc';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: `./test-results/${scope}`,
  timeout: 30000,
  fullyParallel: true,
  forbidOnly: true,
  retries: process.env.PW_RETRIES ? Number(process.env.PW_RETRIES) : 1,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: `reports/${scope}/results.json` }],
    ['html', { outputFolder: `reports/${scope}/html`, open: 'never' }],
  ],
  use: {
    baseURL: process.env.PW_BASE_URL,
    testIdAttribute: 'data-testid',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

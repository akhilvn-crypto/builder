// Starts the cleanup session of one test attempt for the `cleanup` fixture (fixtures/test.*). Kept here, not in the fixture, so the
// TypeScript and JavaScript fixtures share it and the pipeline can test it without Playwright.

import { existsSync } from 'node:fs';
import { loadConfig } from '../config/load-config.ts';
import { CleanupSession, cleanupGuard } from './created-data.ts';
import { RUN_ID_PATTERN, runDir } from './artifact-manager.ts';
import { adhocLedgerDir } from './data-cleanup.ts';

export interface TestInfoLike {
  file: string;
  title: string;
  retry: number;
}

// Inside a pipeline run (PIPELINE_RUN_ID, set by the runner) registrations are written to that run's created-data/ folder and the
// pipeline sweeps after the stage. Outside one (plain `npx playwright test`, npm run test:adhoc / test:ui) they go to the ad hoc ledger
// in mode "sweep", and `npm run test:adhoc` / `test:ui` sweep it once every test has finished; in mode "test" nothing is written and
// each test's undo runs right after the test.
export function startCleanup(rootDir: string, info: TestInfoLike, redact: (text: string) => string, env: NodeJS.ProcessEnv = process.env): CleanupSession {
  const state = loadConfig(rootDir);
  const config = state.status === 'valid' ? state.config : null;
  const guard = cleanupGuard(config);
  const runId = env.PIPELINE_RUN_ID;
  const dir = runId && RUN_ID_PATTERN.test(runId) ? runDir(rootDir, runId) : null;
  const sweeps = guard.mode === 'sweep';
  const idMatch = /^\[([^\]]+)\]/.exec(info.title);
  return new CleanupSession({
    runDirectory: dir && existsSync(dir) ? dir : runId ? null : sweeps ? adhocLedgerDir(rootDir) : null,
    label: env.PIPELINE_LABEL && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(env.PIPELINE_LABEL) ? env.PIPELINE_LABEL : 'adhoc',
    testKey: `${info.file.replaceAll('\\', '/').split('/').slice(-2).join('/')}:${info.title}`,
    testId: idMatch ? idMatch[1]! : null,
    retry: info.retry,
    guard,
    redact,
  });
}

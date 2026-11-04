// `npm run test:adhoc` / `npm run test:ui` entry point: plain Playwright with no pipeline run (results go to reports/adhoc/), followed by
// the test data cleanup. Every argument is passed to `playwright test` unchanged, and the exit code is Playwright's own: a cleanup
// problem is printed, it never changes the result.
//
// Why a wrapper: the cleanup must wait until every test has finished, and playwright.config stays a standard config that does not
// link to the pipeline engine, so the sweep cannot be a globalTeardown. (`npm test` records a run; the pipeline sweeps after its
// execution stage.) A bare `npx playwright test` is not swept; what it registered is swept by the next run of this wrapper.
//
// Usage: node dependencies/engine/cli/adhoc-run.ts [playwright test options ...] [--root <dir>]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightCliPath } from '../pipeline/execution.ts';
import { sweepAfterAdhocRun } from '../pipeline/adhoc-sweep.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..', 'automation');

export function main(argv: string[]): number {
  const at = argv.indexOf('--root');
  const root = path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1]! : DEFAULT_ROOT);
  const passthrough = at >= 0 ? argv.filter((_, i) => i !== at && i !== at + 1) : argv;

  const cli = playwrightCliPath(root);
  if (!existsSync(cli)) {
    process.stderr.write(`@playwright/test is not installed in ${root}. Install it from there (npm install), then run the tests again.\n`);
    return 2;
  }
  const r = spawnSync(process.execPath, [cli, 'test', ...passthrough], { cwd: root, stdio: 'inherit', env: process.env });
  sweepAfterAdhocRun(root, (line) => process.stdout.write(`${line}\n`));
  return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

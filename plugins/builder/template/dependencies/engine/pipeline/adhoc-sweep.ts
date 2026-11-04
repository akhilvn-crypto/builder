// The sweep after a plain Playwright invocation (npm run test:adhoc / test:ui), which has no run: removes the test data the tests
// registered in the ad hoc ledger (cleanup mode "sweep"), once every test has finished. Whatever is still there from
// an earlier invocation that never got this far (a plain `npx playwright test`) is swept too. Never throws; prints what is left.

import { loadConfig } from '../config/load-config.ts';
import { sweepAdhoc, type SweepOptions } from './data-cleanup.ts';

export function sweepAfterAdhocRun(root: string, print: (line: string) => void, opts: Partial<SweepOptions> = {}): void {
  try {
    const state = loadConfig(root);
    const report = sweepAdhoc(root, state.status === 'valid' ? state.config : null, { trigger: 'after plain playwright test', ...opts });
    if (report.summary.total === 0) return;
    const removed = report.actions.filter((a) => a.result === 'deleted' || a.result === 'verified_gone').length;
    print(`Test data: ${removed} removed after the tests, ${report.summary.leftovers} left.`);
    if (!report.ran && report.guard.reason && report.summary.leftovers > 0) print(`  not removed: ${report.guard.reason}`);
    for (const line of report.leftoverLines) print(`  ${line}`);
    if (report.uiTasks.length > 0) print(`  ${report.uiTasks.length} record(s) can only be removed through the app's UI (a pipeline run hands those to the data-cleaner agent); delete them by hand as listed above.`);
  } catch (err) {
    print(`Test data cleanup could not run: ${(err as Error).message}`);
  }
}

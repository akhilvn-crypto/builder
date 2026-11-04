// `npm test` entry point: runs the tests as a complete `run-tests` pipeline run, so a plain test command leaves the same
// record as /builder:run-tests — a run folder (dependencies/runs/<run id>/), normalized results, failure
// triage, and the configured reports and evidence (reports/<run id>/, test-results/<run id>/).
//
// It is only a sequence of the CLI's own commands (preflight -> configuration -> execution -> failure_triage ->
// report_generation -> finalization). Anything that needs judgment (an agent's failure review, healing) stays in the slash
// commands; run /builder:heal-tests <run id> afterwards for the script defects it lists.
//
// Usage: node dependencies/engine/cli/quick-run.ts [test file ...] [--project p]... [--retries n] [--headed] [--test-id id]... [--root <dir>]
// Exit codes: 0 = every test passed and the reports were built, 1 = a test did not pass or a step failed, 2 = not runnable.
//
// Not configured yet (no valid automation.config.json): there is nothing to record a run against, so the tests run with plain
// Playwright into reports/adhoc/ and this says so. `npm run test:adhoc` does that on purpose, with no run.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load-config.ts';
import { ADHOC_SCOPE, REPORTS_DIR } from '../pipeline/artifact-manager.ts';
import { playwrightCliPath } from '../pipeline/execution.ts';
import { toRootRelative } from '../utils/paths.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'pipeline.ts');
const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..', 'automation');

interface Step {
  code: number | null;
  json: any;
  stderr: string;
}

function say(line = ''): void {
  process.stdout.write(line + '\n');
}

function step(root: string, ...args: string[]): Step {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  let json: any = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null: the stderr/exit code carry the failure */ }
  return { code: r.status, json, stderr: r.stderr };
}

function why(s: Step): string {
  if (s.stderr) {
    try { return String(JSON.parse(s.stderr.trim().split('\n').pop()!).message); } catch { return s.stderr.trim().slice(0, 500); }
  }
  const j = s.json ?? {};
  const issues = j.issues ?? j.blockers ?? j.report?.errors;
  return Array.isArray(issues) && issues.length ? issues.map((i: unknown) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ') : `exit code ${s.code}`;
}

// Plain Playwright with no run: used only when the project is not configured.
function adhoc(root: string, files: string[], passthrough: string[]): number {
  const cli = playwrightCliPath(root);
  if (!existsSync(cli)) {
    process.stderr.write(`@playwright/test is not installed in ${root}. Install it from there (npm install), then run the tests again.\n`);
    return 2;
  }
  const r = spawnSync(process.execPath, [cli, 'test', ...files, ...passthrough], { cwd: root, stdio: 'inherit', env: process.env });
  return r.status ?? 1;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      project: { type: 'string', multiple: true },
      retries: { type: 'string' },
      headed: { type: 'boolean' },
      'test-id': { type: 'string', multiple: true },
    },
  });
  const root = path.resolve(values.root ?? DEFAULT_ROOT);
  const files = positionals.map((p) => toRootRelative(root, p));
  const passthrough = [
    ...(values.project ?? []).flatMap((p) => ['--project', p]),
    ...(values.retries !== undefined ? ['--retries', values.retries] : []),
    ...(values.headed ? ['--headed'] : []),
  ];

  const config = loadConfig(root);
  if (config.status !== 'valid') {
    say('The pipeline is not configured yet (automation.config.json is missing or invalid), so there is no run to record.');
    say(`Running the tests with plain Playwright; results go to ${REPORTS_DIR}/${ADHOC_SCOPE}/ only. Set the project up with /builder:playwright-pipeline to get run folders and evidence.`);
    return adhoc(root, files, passthrough);
  }

  // The run, with the stages this command does not perform already marked skipped.
  const created = step(root, 'run', 'create', '--command', 'run-tests');
  const runId: string | undefined = created.json?.runId;
  if (created.code !== 0 || !runId) {
    process.stderr.write(`Could not create a run: ${why(created)}\n`);
    return 2;
  }
  const stage = (name: string, status: string, message?: string, ...artifacts: string[]) =>
    step(root, 'run', 'stage', runId, name, status, ...(message ? ['--message', message] : []), ...artifacts.flatMap((a) => ['--artifact', a]));
  // Marks the stage failed/blocked, says why, and stops.
  const stop = (name: string, status: 'failed' | 'blocked', message: string): number => {
    stage(name, 'running'); // a stage that has not started cannot end failed; ignored when it is already running
    stage(name, status, message);
    say(`\n${name} ${status}: ${message}`);
    say(`Run ${runId} is recorded in dependencies/runs/${runId}/ (resume with /builder:run-tests resume ${runId}).`);
    return name === 'preflight' || name === 'configuration' ? 2 : 1;
  };

  stage('preflight', 'running');
  const pre = step(root, 'preflight');
  if (pre.code !== 0) {
    const missing = (pre.json?.checks ?? []).filter((c: any) => c.required && c.status !== 'ok').map((c: any) => `${c.id}: ${c.detail ?? c.status}${c.installCommand ? ` (needs approval: ${c.installCommand})` : ''}`);
    return stop('preflight', 'blocked', `preflight is not ready${missing.length ? ` — ${missing.join('; ')}` : ''}`);
  }
  stage('preflight', 'completed');

  stage('configuration', 'running');
  const cfg = step(root, 'run', 'set-config', runId);
  if (cfg.code !== 0) return stop('configuration', 'blocked', why(cfg));
  stage('configuration', 'completed');

  // Execution. A runner error (no tests found, config error, crash) fails the stage; failing tests do not.
  stage('execution', 'running');
  say(`Run ${runId}: running the tests…`);
  const exec = step(root, 'exec', 'run', runId, '--label', 'initial',
    ...files.flatMap((f) => ['--test-file', f]),
    ...(values['test-id'] ?? []).flatMap((id) => ['--test-id', id]),
    ...(values.project ?? []).flatMap((p) => ['--project', p]),
    ...(values.retries !== undefined ? ['--retries', values.retries] : []),
    ...(values.headed ? ['--headed'] : []));
  if (exec.code !== 0 && exec.code !== 2) return stop('execution', 'failed', why(exec));
  const e = exec.json ?? {};
  if (e.runnerError) return stop('execution', 'failed', `${e.runnerError}${e.runnerLog ? ` (log: ${REPORTS_DIR}/${runId}/initial/runner.log)` : ''}`);
  stage('execution', 'completed', undefined, `executionResults=${e.artifact ?? 'execution-results.json'}`);
  if (e.authState?.warnings?.length) for (const w of e.authState.warnings) say(`  auth: ${w}`);

  stage('failure_triage', 'running');
  const triage = step(root, 'triage', 'run', runId);
  if (triage.code !== 0) return stop('failure_triage', 'failed', why(triage));
  stage('failure_triage', 'completed', undefined, `failureAnalysis=${triage.json?.artifact ?? 'failure-analysis.json'}`);

  stage('report_generation', 'running');
  const report = step(root, 'report', 'build', runId);
  const reportOk = report.code === 0;
  if (report.json?.artifacts) stage('report_generation', reportOk ? 'completed' : 'failed', reportOk ? undefined : 'a configured report was not generated', ...(reportOk ? ['summary=summary.json', 'summaryMarkdown=summary.md'] : []));
  else return stop('report_generation', 'failed', why(report));

  // Finalization needs the report's counts; if a reporter failed the stage cannot complete, but the run still shows what ran.
  let finalized = false;
  if (reportOk) {
    stage('finalization', 'running');
    const fin = step(root, 'run', 'finalize', runId);
    if (fin.code === 0) { stage('finalization', 'completed'); finalized = true; } else stage('finalization', 'failed', why(fin));
  }

  // ---- what happened ----
  const counts = report.json?.counts ?? e.stats ?? {};
  say('');
  say(`Run ${runId}${finalized ? '' : ' (not finalized)'}`);
  say(`  total ${counts.total ?? 0} · passed ${counts.passed ?? 0} · failed ${counts.failed ?? 0} · flaky ${counts.flaky ?? 0} · skipped ${counts.skipped ?? 0}`);
  for (const t of e.notPassed ?? []) say(`  ${t.outcome}: ${t.key} (${t.file}:${t.line})`);
  say('  reports:');
  for (const r of report.json?.reporters ?? []) say(`    ${r.name}: ${r.status}${r.path ? ` — ${r.path}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
  say(`  run folder: dependencies/runs/${runId}/ (summary.md, execution-results.json, failure-analysis.json)`);
  say(`  evidence:   automation/test-results/${runId}/initial/`);
  if ((triage.json?.eligibleForHealing ?? []).length) say(`  ${triage.json.eligibleForHealing.length} failure(s) look like script defects: /builder:heal-tests ${runId}`);

  const clean = (counts.failed ?? 0) === 0 && (counts.flaky ?? 0) === 0;
  return clean && reportOk && finalized ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // npm test records a run, so it takes only test files, --project, --retries, --headed and --test-id; anything else is plain Playwright.
    const hint = (err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      ? '\nnpm test accepts test files, --project, --retries, --headed and --test-id. For other Playwright options use "npm run test:adhoc -- <options>" (no run is recorded).'
      : '';
    process.stderr.write(`${(err as Error).message}${hint}\n`);
    process.exitCode = 1;
  }
}

// Runs Playwright Test for a run and normalizes the JSON reporter output into execution results
// keyed by source test ID. The executor never edits test code.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import { readJson, toPosixRelative, writeJsonAtomic } from '../utils/fs.ts';
import { redactAll } from '../utils/redact.ts';
import { ARTIFACTS, assertExecutionLabel, reportsDirFor, runDir } from './artifact-manager.ts';
import type { AuthRunInfo } from './auth-state.ts';
import { secretValuesFor } from './env-file.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import { OWN_SESSION_TAG } from './session-layout.ts';
import { runSupervised } from './supervised-run.ts';

export const EXECUTION_SCHEMA_VERSION = 1;
export const OUTCOMES = ['passed', 'failed', 'flaky', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface AttemptError {
  message: string;
  stack: string | null;
  location: { file: string; line: number } | null;
}

export interface Attempt {
  retry: number;
  status: string; // passed | failed | timedOut | interrupted | skipped
  durationMs: number;
  errors: AttemptError[];
  attachments: { name: string; contentType: string; path: string }[]; // relative to automation/
  // The page's address (no query or fragment) when the test did not finish as expected; set by the diagnostics fixture. It is how a
  // test that was sent back to the login page is recognised without depending on the wording of its error.
  finalUrl?: string;
}

export interface TestResult {
  key: string; // `${testId}@${project}` — unique per run
  testId: string;
  title: string;
  file: string; // relative to automation/
  line: number;
  project: string;
  outcome: Outcome; // flaky = failed first, passed on retry; never counted as passed
  attempts: Attempt[];
  // Tagged @own-session: the test signs in itself, so a login page at the end is expected and is not a lost session.
  ownSession?: boolean;
}

export interface ExecutionResults {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  runId: string;
  label: string;
  executedAt: string;
  command: string[];
  exitCode: number | null;
  // Set when the runner itself failed (config error, crash, no report) — distinct from test failures.
  runnerError: string | null;
  rawReport: string | null; // path of Playwright's JSON report, relative to automation/
  runnerLog: string; // relative to automation/
  stats: Record<Outcome, number> & { total: number };
  tests: TestResult[];
  // The login step that precedes the tests when saved authentication state is used. It is infrastructure, not a test:
  // it is not counted in `stats`, but its failure is a runner error.
  authSetup?: { outcome: 'passed' | 'failed' | 'skipped'; error: string | null };
  // How saved login state was handled (reused, refreshed, recovered). Never contains cookie or token values.
  authState?: AuthRunInfo;
  // The worker count and isolation rules this run used, and why.
  executionPlan?: ExecutionPlan;
}

// ---- running ----

export interface RunOptions {
  runId: string;
  label: string;
  files?: string[]; // test files, relative to automation/
  testIds?: string[]; // narrows to titles starting with "[ID]"
  projects?: string[];
  retries?: number; // override, e.g. 0 for healing reruns so a retry can't mask the result
  headed?: boolean; // show the browser window; the run, reports and evidence are the same as headless
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv; // added to the runner's environment (e.g. PIPELINE_AUTH_STATE, PW_WORKERS)
}

export interface Spawner {
  (
    cmd: string, args: string[],
    // ledgerDir/role: where the processes the runner starts are recorded, and what they are for (see process-ledger.ts)
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; ledgerDir?: string; role?: string },
  ): { status: number | null; stdout: string; stderr: string; error?: Error };
}

// The runner starts browsers, workers and possibly a web server. A plain spawnSync timeout stops only the runner itself and leaves
// those running, so the runner runs under the supervisor: a timeout stops the whole tree, and what the runner leaves behind is stopped.
const defaultSpawner: Spawner = (cmd, args, opts) => {
  const r = runSupervised(cmd, args, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, ledgerDir: opts.ledgerDir, role: opts.role });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
};

export function playwrightCliPath(rootDir: string): string {
  return path.join(rootDir, 'node_modules', '@playwright', 'test', 'cli.js');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPlaywrightArgs(o: Pick<RunOptions, 'files' | 'testIds' | 'projects' | 'retries' | 'headed'>): string[] {
  const args = ['test', ...(o.files ?? [])];
  if (o.testIds && o.testIds.length) args.push('--grep', o.testIds.map((id) => escapeRegex(`[${id}]`)).join('|'));
  for (const p of o.projects ?? []) args.push('--project', p);
  if (o.retries !== undefined) args.push('--retries', String(o.retries));
  if (o.headed) args.push('--headed');
  return args;
}

export function runPlaywright(rootDir: string, config: AutomationConfig, o: RunOptions, spawn: Spawner = defaultSpawner, env: NodeJS.ProcessEnv = process.env, now = new Date()): ExecutionResults {
  assertExecutionLabel(o.label);
  const cli = playwrightCliPath(rootDir);
  const reportsDir = reportsDirFor(rootDir, o.runId, o.label);
  mkdirSync(reportsDir, { recursive: true });
  const runnerLogAbs = path.join(reportsDir, 'runner.log');
  const rawReportAbs = path.join(reportsDir, 'results.json');
  const args = buildPlaywrightArgs(o);
  const secrets = secretValuesFor(rootDir, config.auth.credentialEnvVars, env);

  if (!existsSync(cli)) {
    writeFileSync(runnerLogAbs, `@playwright/test is not installed (${cli} missing)\n`);
    return emptyResults(rootDir, o, args, null, '@playwright/test is not installed in the project', runnerLogAbs, now);
  }
  const r = spawn(process.execPath, [cli, ...args], {
    cwd: rootDir,
    env: { ...env, ...o.extraEnv, PIPELINE_RUN_ID: o.runId, PIPELINE_LABEL: o.label, FORCE_COLOR: '0' },
    timeoutMs: o.timeoutMs ?? 60 * 60_000,
    ledgerDir: runDir(rootDir, o.runId), role: `playwright:${o.label}`,
  });
  writeFileSync(runnerLogAbs, redactAll(`$ playwright ${args.join(' ')}\n\n${r.stdout}\n${r.stderr}`, secrets));

  const report = readJson(rawReportAbs);
  if (!report.ok) {
    const why = r.error ? r.error.message : `exit code ${r.status}`;
    return emptyResults(rootDir, o, args, r.status, `runner produced no JSON report (${why}); see ${toPosixRelative(rootDir, runnerLogAbs)}`, runnerLogAbs, now);
  }
  const results = normalizeReport(report.value, { rootDir, runId: o.runId, label: o.label, secrets, now });
  return {
    ...results,
    command: ['playwright', ...args],
    exitCode: r.status,
    rawReport: toPosixRelative(rootDir, rawReportAbs),
    runnerLog: toPosixRelative(rootDir, runnerLogAbs),
    runnerError: results.runnerError ?? (r.status !== 0 && r.status !== 1 ? `unexpected runner exit code ${r.status}` : null),
  };
}

function emptyResults(rootDir: string, o: RunOptions, args: string[], exitCode: number | null, runnerError: string, runnerLogAbs: string, now: Date): ExecutionResults {
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION, runId: o.runId, label: o.label, executedAt: now.toISOString(),
    command: ['playwright', ...args], exitCode, runnerError, rawReport: null, runnerLog: toPosixRelative(rootDir, runnerLogAbs),
    stats: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }, tests: [],
  };
}

// Where normalized results for a label are stored inside the run.
export function resultsPathFor(runDirectory: string, label: string): string {
  if (label === 'initial') return path.join(runDirectory, ARTIFACTS.executionResults);
  if (label === 'regression') return path.join(runDirectory, ARTIFACTS.regressionResults);
  return path.join(runDirectory, ARTIFACTS.rerunsDir, `${label}.json`);
}

export function saveResults(runDirectory: string, results: ExecutionResults): string {
  const p = resultsPathFor(runDirectory, results.label);
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomic(p, results);
  return p;
}

// ---- normalizing Playwright's JSON reporter output ----

interface PwError { message?: string; stack?: string; location?: { file: string; line: number } }
interface PwResult { retry?: number; status?: string; duration?: number; error?: PwError; errors?: PwError[]; attachments?: { name: string; contentType: string; path?: string; body?: string }[] }
interface PwTest { projectName?: string; annotations?: { type: string; description?: string }[]; expectedStatus?: string; status?: string; results?: PwResult[] }
interface PwSpec { title: string; file?: string; line?: number; tags?: string[]; tests?: PwTest[] }
interface PwSuite { title?: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { config?: { rootDir?: string }; suites?: PwSuite[]; errors?: PwError[] }

// Reserved Playwright project that logs in and writes the storage state (see playwright-config.ts).
export const SETUP_PROJECT = 'setup';
export const FINAL_URL_ATTACHMENT = 'final-url';
const ANSI = /\u001b\[[0-9;]*m/g;
const TITLE_ID = /^\[([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]/;

export function testIdFor(title: string, annotations: PwTest['annotations'], file: string): string {
  const a = annotations?.find((x) => x.type === 'testId' && x.description);
  if (a) return a.description!;
  const m = TITLE_ID.exec(title);
  return m ? m[1]! : `untagged:${file}:${title}`;
}

// The address the diagnostics fixture attached. The attachment is a small text body, which the JSON report carries as base64.
function finalUrlOf(r: PwResult): { finalUrl?: string } {
  const a = (r.attachments ?? []).find((x) => x.name === FINAL_URL_ATTACHMENT && typeof x.body === 'string');
  const url = a ? Buffer.from(a.body!, 'base64').toString('utf8').trim().slice(0, 300) : '';
  return url ? { finalUrl: url } : {};
}

function outcomeOf(t: PwTest): Outcome {
  if (t.status === 'flaky') return 'flaky';
  if (t.status === 'skipped') return 'skipped';
  if (t.status === 'expected') return 'passed';
  return 'failed';
}

export function normalizeReport(raw: unknown, ctx: { rootDir: string; runId: string; label: string; secrets: string[]; now: Date }): ExecutionResults {
  const report = raw as PwReport;
  const testRoot = report.config?.rootDir ?? path.join(ctx.rootDir, 'tests');
  const clean = (s: string | undefined) => redactAll((s ?? '').replace(ANSI, ''), ctx.secrets);
  const rel = (p: string) => toPosixRelative(ctx.rootDir, path.isAbsolute(p) ? p : path.join(testRoot, p));
  const tests: TestResult[] = [];
  const setup: { outcome: Outcome; error: string | null }[] = [];

  const walk = (suite: PwSuite, inheritedFile: string | undefined) => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      const specFile = rel(spec.file ?? file ?? 'unknown');
      for (const t of spec.tests ?? []) {
        const project = t.projectName || 'default';
        if (project === SETUP_PROJECT) {
          const failure = (t.results ?? []).flatMap((r) => (r.errors?.length ? r.errors : r.error ? [r.error] : [])).find((e) => e.message);
          setup.push({ outcome: outcomeOf(t), error: failure ? clean(failure.message).slice(0, 1000) : null });
          continue;
        }
        const testId = testIdFor(spec.title, t.annotations, specFile);
        tests.push({
          key: `${testId}@${project}`,
          testId,
          title: spec.title,
          file: specFile,
          line: spec.line ?? 0,
          project,
          outcome: outcomeOf(t),
          ...(spec.tags?.includes(OWN_SESSION_TAG) || spec.title.includes(OWN_SESSION_TAG) || project === 'own-session' ? { ownSession: true } : {}),
          attempts: (t.results ?? []).map((r) => ({
            retry: r.retry ?? 0,
            status: r.status ?? 'unknown',
            durationMs: r.duration ?? 0,
            ...finalUrlOf(r),
            errors: (r.errors?.length ? r.errors : r.error ? [r.error] : []).map((e) => ({
              message: clean(e.message).slice(0, 4000),
              stack: e.stack ? clean(e.stack).slice(0, 4000) : null,
              location: e.location ? { file: rel(e.location.file), line: e.location.line } : null,
            })),
            attachments: (r.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, contentType: a.contentType, path: rel(a.path!) })),
          })),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const s of report.suites ?? []) walk(s, undefined);

  const stats = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const t of tests) stats[t.outcome]++;
  const topErrors = (report.errors ?? []).map((e) => clean(e.message)).filter(Boolean);
  const authSetup: ExecutionResults['authSetup'] = setup.length === 0 ? undefined : {
    outcome: setup.some((s) => s.outcome === 'failed') ? 'failed' : setup.every((s) => s.outcome === 'skipped') ? 'skipped' : 'passed',
    error: setup.find((s) => s.error)?.error ?? null,
  };
  const setupError = authSetup?.outcome === 'failed' ? `authentication setup failed${authSetup.error ? `: ${authSetup.error.split('\n')[0]}` : ''}` : null;
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    runId: ctx.runId,
    label: ctx.label,
    executedAt: ctx.now.toISOString(),
    command: [],
    exitCode: null,
    runnerError: topErrors.length ? `runner errors: ${topErrors.join(' | ').slice(0, 4000)}` : setupError ?? (tests.length === 0 ? 'no tests were found or run' : null),
    rawReport: null,
    runnerLog: '',
    stats,
    tests,
    ...(authSetup ? { authSetup } : {}),
  };
}

export function validateExecutionResults(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['execution results must be an object'];
  const r = v as Partial<ExecutionResults>;
  const issues: string[] = [];
  if (r.schemaVersion !== EXECUTION_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Array.isArray(r.tests)) return [...issues, 'tests must be an array'];
  if (r.runnerError) issues.push(`runner error: ${r.runnerError}`);
  const keys = new Set<string>();
  for (const t of r.tests) {
    if (keys.has(t.key)) issues.push(`duplicate result key ${t.key} (two tests share a test ID in the same project)`);
    keys.add(t.key);
    if (!(OUTCOMES as readonly unknown[]).includes(t.outcome)) issues.push(`${t.key}: invalid outcome`);
  }
  return issues;
}

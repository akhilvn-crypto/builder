// Typed schema and validator for config/automation.config.json.
// The config holds approved, NON-SECRET choices only. Unknown keys are rejected,
// which also prevents secrets from being smuggled into the committed file.

export const CONFIG_SCHEMA_VERSION = 1;

export const LANGUAGES = ['typescript', 'javascript'] as const;
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
// Values map 1:1 to Playwright Test `use.video`, `use.screenshot`, `use.trace` modes.
export const VIDEO_MODES = ['off', 'on', 'retain-on-failure'] as const;
export const SCREENSHOT_MODES = ['off', 'on', 'only-on-failure'] as const;
export const TRACE_MODES = ['off', 'on', 'on-first-retry', 'retain-on-failure'] as const;
// 'evidence-pdf' is the pipeline's own report: a PDF with, per test, the executed steps, one embedded execution video and one
// final-state screenshot. It is built after the run by report_generation, not by a Playwright reporter.
// 'extent' is the pipeline's own Extent-style HTML report (dashboard, filterable test list, steps, errors, screenshots), also built after
// the run from the normalized results: no package is needed. 'junit' is still valid in older configs but is not offered in setup.
export const REPORTERS = ['html', 'json', 'allure', 'junit', 'extent', 'evidence-pdf'] as const;
// How much reporting a run produces; see MODE_PROFILES in reporting-mode.ts.
export const REPORT_MODES = ['standard', 'full', 'audit'] as const;
// What parallel workers may assume about shared application state (see execution-plan.ts).
export const ISOLATION_MODES = ['serial', 'shared-readonly', 'per-worker-accounts'] as const;
export const AUTH_APPROACHES = ['none', 'ui-login', 'storage-state'] as const;
export const EXPLORATION_TOOLS = ['playwright-cli', 'none'] as const;
// When the data the tests created is removed (no `cleanup` block = it is not removed): "test" = each test removes it right after it
// finishes; "sweep" = nothing is removed while tests run, one sweep removes it once every test has finished (tests just register what
// they create; see created-data.ts).
export const CLEANUP_MODES = ['sweep', 'test'] as const;
export const CLEANUP_API_METHODS = ['DELETE', 'POST', 'PUT', 'PATCH'] as const;
export const DEFAULT_MAX_DELETES_PER_RUN = 50;
// Environments that data is never deleted in, whatever the config allows.
export const PRODUCTION_ENVIRONMENT = /^(prod|production|prd|live)$/i;

export const MAX_HEALING_ATTEMPTS_CAP = 2;

export type Language = (typeof LANGUAGES)[number];
export type Browser = (typeof BROWSERS)[number];
export type VideoMode = (typeof VIDEO_MODES)[number];
export type ScreenshotMode = (typeof SCREENSHOT_MODES)[number];
export type TraceMode = (typeof TRACE_MODES)[number];
export type Reporter = (typeof REPORTERS)[number];
export type AuthApproach = (typeof AUTH_APPROACHES)[number];
export type ExplorationTool = (typeof EXPLORATION_TOOLS)[number];
export type ReportMode = (typeof REPORT_MODES)[number];
export type IsolationMode = (typeof ISOLATION_MODES)[number];
export type CleanupMode = (typeof CLEANUP_MODES)[number];

// How one kind of created record can be removed. Declared by the user (or confirmed by them after the explorer observed it): endpoints
// are never guessed. Without `api`, the sweep falls back to `ui`; without either, the record is reported as left behind.
export interface CleanupEntity {
  api?: {
    method: (typeof CLEANUP_API_METHODS)[number];
    path: string; // on the app's origin, with {id} where the record's identifier goes, e.g. /api/orders/{id}
    headersFromEnv?: Record<string, string>; // header name -> env var NAME holding the value (never the value)
    verifyPath?: string; // GET on this path (same {id}) must answer 404/410 once the record is gone
  };
  ui?: { hint: string }; // how a person or the data-cleaner agent removes it through the UI, taken from the app or the test case
}

export const DEFAULT_AUTH_STATE_MAX_AGE_HOURS = 8;

export interface AutomationConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  language: Language;
  packageManager: 'npm';
  app: {
    baseUrl: string;
    environment: string;
  };
  input: {
    testCasesPath: string;
  };
  browsers: Browser[];
  evidence: {
    video: VideoMode;
    screenshot: ScreenshotMode;
    trace: TraceMode;
  };
  reporters: Reporter[];
  auth: {
    approach: AuthApproach;
    // Names of environment variables holding credentials. Never the values.
    credentialEnvVars: string[];
    // Only with approach "storage-state": how saved login state is checked before it is trusted.
    state?: {
      maxAgeHours?: number; // older state is replaced by a fresh login (default DEFAULT_AUTH_STATE_MAX_AGE_HOURS)
      probePath?: string; // a path on the app that requires login; used to confirm the saved state is still accepted
      loggedOutPattern?: string; // regex (source) that identifies a redirect/error caused by being logged out
    };
  };
  exploration: {
    tool: ExplorationTool;
  };
  execution: {
    workers: number | null; // null = a conservative default (execution-plan.ts), not Playwright's CPU-based default
    retries: number;
    timeoutMs: number;
    // What parallel tests may assume about shared state. Absent = unspecified: tests in one file run in order.
    isolation?: IsolationMode;
  };
  // Absent = the reporters and evidence above are used as chosen, with no mode rules applied.
  reporting?: {
    mode: ReportMode;
    // Audit only: record step evidence (the step log and a final-state screenshot per test) for the evidence PDF. Opt-in because it
    // adds files to every test. The key keeps its original name so existing configs stay valid.
    stepScreenshots?: boolean;
    // CSS selectors masked in the final-state screenshot (password inputs are always masked).
    maskSelectors?: string[];
  };
  // Absent = no data cleanup (older configs stay valid). A material choice: asked in setup, never defaulted.
  cleanup?: {
    mode: CleanupMode;
    // Environment names (app.environment) cleanup may run in. Never a production name; the run's environment must be listed.
    allowedEnvironments: string[];
    maxDeletesPerRun?: number; // safety cap for the sweep (default DEFAULT_MAX_DELETES_PER_RUN)
    entities?: Record<string, CleanupEntity>;
  };
  healing: {
    maxAttemptsPerTest: number;
  };
  retention: {
    keepRuns: number | null; // null = keep all runs
  };
}

// Recommendations offered during setup. These are NOT silently applied for material choices.
export const RECOMMENDED = {
  language: 'typescript',
  evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporters: ['html', 'json', 'allure'],
} as const satisfies Partial<Record<keyof AutomationConfig, unknown>>;

// Defaults for non-material settings. Applied beneath the config file in precedence.
export const DEFAULTS = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  packageManager: 'npm',
  browsers: ['chromium'],
  auth: { approach: 'none', credentialEnvVars: [] },
  exploration: { tool: 'playwright-cli' },
  execution: { workers: null, retries: 1, timeoutMs: 30_000 },
  healing: { maxAttemptsPerTest: MAX_HEALING_ATTEMPTS_CAP },
  retention: { keepRuns: null },
} as const;

export interface ConfigIssue {
  path: string;
  kind: 'missing' | 'invalid';
  message: string;
}

export type ValidationResult =
  | { ok: true; config: AutomationConfig; issues: [] }
  | { ok: false; issues: ConfigIssue[] };

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  issues: ConfigIssue[] = [];

  missing(path: string, message: string): void {
    this.issues.push({ path, kind: 'missing', message });
  }

  invalid(path: string, message: string): void {
    this.issues.push({ path, kind: 'invalid', message });
  }

  object(parent: Obj, key: string, path: string, allowed: readonly string[]): Obj | undefined {
    const v = parent[key];
    if (v === undefined) {
      this.missing(path, `${path} is required`);
      return undefined;
    }
    if (!isObj(v)) {
      this.invalid(path, `${path} must be an object`);
      return undefined;
    }
    this.unknownKeys(v, path, allowed);
    return v;
  }

  unknownKeys(v: Obj, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(v)) {
      if (!allowed.includes(k)) this.invalid(path ? `${path}.${k}` : k, `unknown key "${k}"`);
    }
  }

  oneOf<T extends string>(parent: Obj, key: string, path: string, values: readonly T[]): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required (one of: ${values.join(', ')})`);
    if (typeof v !== 'string' || !values.includes(v as T)) {
      this.invalid(path, `${path} must be one of: ${values.join(', ')} (got ${JSON.stringify(v)})`);
    }
  }

  nonEmptyString(parent: Obj, key: string, path: string): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required`);
    if (typeof v !== 'string' || v.trim() === '') this.invalid(path, `${path} must be a non-empty string`);
  }

  int(parent: Obj, key: string, path: string, min: number, max: number, nullable = false): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required`);
    if (v === null && nullable) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.invalid(path, `${path} must be an integer between ${min} and ${max}${nullable ? ' or null' : ''}`);
    }
  }

  setOf<T extends string>(parent: Obj, key: string, path: string, values: readonly T[], minItems: number): void {
    const v = parent[key];
    if (v === undefined) return this.missing(path, `${path} is required (subset of: ${values.join(', ')})`);
    if (!Array.isArray(v) || v.length < minItems) {
      return this.invalid(path, `${path} must be an array with at least ${minItems} item(s)`);
    }
    const seen = new Set<unknown>();
    for (const item of v) {
      if (typeof item !== 'string' || !values.includes(item as T)) {
        this.invalid(path, `${path} contains unsupported value ${JSON.stringify(item)} (allowed: ${values.join(', ')})`);
      } else if (seen.has(item)) {
        this.invalid(path, `${path} contains duplicate value "${item}"`);
      }
      seen.add(item);
    }
  }
}

const TOP_KEYS = [
  'schemaVersion', 'language', 'packageManager', 'app', 'input', 'browsers', 'evidence',
  'reporters', 'auth', 'exploration', 'execution', 'healing', 'retention', 'reporting', 'cleanup',
] as const;

// Configs saved by 0.15-0.17 used four cleanup modes. They keep working: "in-test" and "in-test+sweep" removed data in each test, so they
// become "test"; "off" meant no cleanup, so the block goes. Anything else is left for the validator to reject.
function upgradeLegacyCleanup(raw: unknown): unknown {
  if (!isObj(raw) || !isObj(raw.cleanup)) return raw;
  const mode = raw.cleanup.mode;
  if (mode === 'off') {
    const { cleanup: _dropped, ...rest } = raw;
    return rest;
  }
  if (mode === 'in-test' || mode === 'in-test+sweep') return { ...raw, cleanup: { ...raw.cleanup, mode: 'test' } };
  return raw;
}

export function validateConfig(candidate: unknown): ValidationResult {
  const raw = upgradeLegacyCleanup(candidate);
  const c = new Checker();
  if (!isObj(raw)) {
    return { ok: false, issues: [{ path: '', kind: 'invalid', message: 'config must be a JSON object' }] };
  }
  c.unknownKeys(raw, '', TOP_KEYS);

  if (raw.schemaVersion === undefined) c.missing('schemaVersion', 'schemaVersion is required');
  else if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    c.invalid('schemaVersion', `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${CONFIG_SCHEMA_VERSION})`);
  }
  c.oneOf(raw, 'language', 'language', LANGUAGES);
  c.oneOf(raw, 'packageManager', 'packageManager', ['npm'] as const);

  const app = c.object(raw, 'app', 'app', ['baseUrl', 'environment']);
  if (app) {
    if (app.baseUrl === undefined) c.missing('app.baseUrl', 'app.baseUrl is required');
    else if (!isHttpUrl(app.baseUrl)) c.invalid('app.baseUrl', 'app.baseUrl must be an absolute http(s) URL');
    else if (hasUrlCredentials(app.baseUrl)) c.invalid('app.baseUrl', 'app.baseUrl must not embed credentials');
    c.nonEmptyString(app, 'environment', 'app.environment');
  }

  const input = c.object(raw, 'input', 'input', ['testCasesPath']);
  if (input) {
    c.nonEmptyString(input, 'testCasesPath', 'input.testCasesPath');
    if (typeof input.testCasesPath === 'string' && isAbsoluteOrEscaping(input.testCasesPath)) {
      c.invalid('input.testCasesPath', 'input.testCasesPath must be a relative path inside dependencies/ (e.g. input/test-cases)');
    }
  }

  c.setOf(raw, 'browsers', 'browsers', BROWSERS, 1);

  const evidence = c.object(raw, 'evidence', 'evidence', ['video', 'screenshot', 'trace']);
  if (evidence) {
    c.oneOf(evidence, 'video', 'evidence.video', VIDEO_MODES);
    c.oneOf(evidence, 'screenshot', 'evidence.screenshot', SCREENSHOT_MODES);
    c.oneOf(evidence, 'trace', 'evidence.trace', TRACE_MODES);
  }

  c.setOf(raw, 'reporters', 'reporters', REPORTERS, 1);
  if (Array.isArray(raw.reporters) && !raw.reporters.includes('json')) {
    c.invalid('reporters', 'reporters must include "json": the pipeline reads raw JSON results');
  }

  const auth = c.object(raw, 'auth', 'auth', ['approach', 'credentialEnvVars', 'state']);
  if (auth) {
    if (auth.state !== undefined) checkAuthState(c, auth);
    c.oneOf(auth, 'approach', 'auth.approach', AUTH_APPROACHES);
    const vars = auth.credentialEnvVars;
    if (vars === undefined) c.missing('auth.credentialEnvVars', 'auth.credentialEnvVars is required (may be empty)');
    else if (!Array.isArray(vars) || vars.some((n) => typeof n !== 'string' || !ENV_VAR_NAME.test(n))) {
      c.invalid('auth.credentialEnvVars', 'auth.credentialEnvVars must list environment variable NAMES (e.g. TEST_USER_PASSWORD), never values');
    }
  }

  const exploration = c.object(raw, 'exploration', 'exploration', ['tool']);
  if (exploration) c.oneOf(exploration, 'tool', 'exploration.tool', EXPLORATION_TOOLS);

  const execution = c.object(raw, 'execution', 'execution', ['workers', 'retries', 'timeoutMs', 'isolation']);
  if (execution) {
    c.int(execution, 'workers', 'execution.workers', 1, 64, true);
    c.int(execution, 'retries', 'execution.retries', 0, 5);
    c.int(execution, 'timeoutMs', 'execution.timeoutMs', 1_000, 600_000);
    if (execution.isolation !== undefined) c.oneOf(execution, 'isolation', 'execution.isolation', ISOLATION_MODES);
  }
  if (isObj(execution) && execution.isolation === 'per-worker-accounts' && isObj(auth)) {
    if (auth.approach === 'storage-state') {
      c.invalid('execution.isolation', 'per-worker-accounts cannot use one shared storage-state file; use auth.approach "ui-login" with per-worker credentials, or isolation "serial"/"shared-readonly"');
    }
    if (Array.isArray(auth.credentialEnvVars) && auth.credentialEnvVars.length === 0) {
      c.invalid('execution.isolation', 'per-worker-accounts needs auth.credentialEnvVars (each one needs NAME_1..NAME_N variants)');
    }
  }

  const healing = c.object(raw, 'healing', 'healing', ['maxAttemptsPerTest']);
  if (healing) c.int(healing, 'maxAttemptsPerTest', 'healing.maxAttemptsPerTest', 0, MAX_HEALING_ATTEMPTS_CAP);

  const retention = c.object(raw, 'retention', 'retention', ['keepRuns']);
  if (retention) c.int(retention, 'keepRuns', 'retention.keepRuns', 1, 10_000, true);

  const reporting = raw.reporting === undefined ? undefined : c.object(raw, 'reporting', 'reporting', ['mode', 'stepScreenshots', 'maskSelectors']);
  if (reporting) checkReporting(c, raw, reporting);
  else if (raw.reporting === undefined && Array.isArray(raw.reporters) && raw.reporters.includes('evidence-pdf')) {
    c.invalid('reporters', 'the evidence-pdf reporter belongs to reporting.mode "audit" with reporting.stepScreenshots true');
  }

  if (raw.cleanup !== undefined) checkCleanup(c, raw);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, config: raw as unknown as AutomationConfig, issues: [] };
}

const ENTITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;
const API_PATH = /^\/(?!\/)[^\s?#]*$/;

function checkCleanup(c: Checker, raw: Obj): void {
  const cleanup = c.object(raw, 'cleanup', 'cleanup', ['mode', 'allowedEnvironments', 'maxDeletesPerRun', 'entities']);
  if (!cleanup) return;
  c.oneOf(cleanup, 'mode', 'cleanup.mode', CLEANUP_MODES);
  const envs = cleanup.allowedEnvironments;
  if (envs === undefined) c.missing('cleanup.allowedEnvironments', 'cleanup.allowedEnvironments is required (the environment names data may be deleted in)');
  else if (!Array.isArray(envs) || envs.some((e) => typeof e !== 'string' || e.trim() === '')) {
    c.invalid('cleanup.allowedEnvironments', 'cleanup.allowedEnvironments must be a list of environment names');
  } else {
    if (envs.length === 0) c.invalid('cleanup.allowedEnvironments', 'cleanup.allowedEnvironments must list at least one non-production environment');
    if (envs.some((e) => PRODUCTION_ENVIRONMENT.test((e as string).trim()))) c.invalid('cleanup.allowedEnvironments', 'test data is never deleted in a production environment');
  }
  if (cleanup.maxDeletesPerRun !== undefined) c.int(cleanup, 'maxDeletesPerRun', 'cleanup.maxDeletesPerRun', 1, 1_000);
  if (cleanup.entities === undefined) return;
  if (!isObj(cleanup.entities)) return c.invalid('cleanup.entities', 'cleanup.entities must be an object keyed by entity name');
  for (const [name, entity] of Object.entries(cleanup.entities)) {
    const at = `cleanup.entities.${name}`;
    if (!ENTITY_NAME.test(name)) c.invalid(at, 'an entity name is a short word (letters, digits, - and _)');
    if (!isObj(entity)) { c.invalid(at, `${at} must be an object`); continue; }
    c.unknownKeys(entity, at, ['api', 'ui']);
    if (entity.api === undefined && entity.ui === undefined) c.invalid(at, `${at} needs an "api" or a "ui" way to remove the record`);
    if (entity.ui !== undefined) {
      if (!isObj(entity.ui)) c.invalid(`${at}.ui`, `${at}.ui must be an object`);
      else {
        c.unknownKeys(entity.ui, `${at}.ui`, ['hint']);
        if (typeof entity.ui.hint !== 'string' || entity.ui.hint.trim() === '') c.invalid(`${at}.ui.hint`, `${at}.ui.hint must describe how the record is removed in the UI`);
      }
    }
    if (entity.api === undefined) continue;
    const api = entity.api;
    if (!isObj(api)) { c.invalid(`${at}.api`, `${at}.api must be an object`); continue; }
    c.unknownKeys(api, `${at}.api`, ['method', 'path', 'headersFromEnv', 'verifyPath']);
    c.oneOf(api, 'method', `${at}.api.method`, CLEANUP_API_METHODS);
    if (typeof api.path !== 'string' || !API_PATH.test(api.path) || api.path.split('{id}').length !== 2) {
      c.invalid(`${at}.api.path`, `${at}.api.path must be a path on the app starting with "/" and containing {id} once (no host, no query)`);
    }
    if (api.verifyPath !== undefined && (typeof api.verifyPath !== 'string' || !API_PATH.test(api.verifyPath) || api.verifyPath.split('{id}').length !== 2)) {
      c.invalid(`${at}.api.verifyPath`, `${at}.api.verifyPath must be a path starting with "/" and containing {id} once`);
    }
    if (api.headersFromEnv !== undefined) {
      const h = api.headersFromEnv;
      if (!isObj(h) || Object.entries(h).some(([k, v]) => !HEADER_NAME.test(k) || typeof v !== 'string' || !ENV_VAR_NAME.test(v))) {
        c.invalid(`${at}.api.headersFromEnv`, `${at}.api.headersFromEnv maps header names to environment variable NAMES (e.g. { "Authorization": "API_TOKEN" }), never values`);
      }
    }
  }
}

function checkAuthState(c: Checker, auth: Obj): void {
  const state = auth.state;
  if (!isObj(state)) return c.invalid('auth.state', 'auth.state must be an object');
  c.unknownKeys(state, 'auth.state', ['maxAgeHours', 'probePath', 'loggedOutPattern']);
  if (auth.approach !== 'storage-state') c.invalid('auth.state', 'auth.state only applies to auth.approach "storage-state"');
  if (state.maxAgeHours !== undefined) c.int(state, 'maxAgeHours', 'auth.state.maxAgeHours', 1, 720);
  if (state.probePath !== undefined && (typeof state.probePath !== 'string' || !/^\/[^\s]*$/.test(state.probePath) || state.probePath.startsWith('//'))) {
    c.invalid('auth.state.probePath', 'auth.state.probePath must be a path on the app starting with "/" (no host)');
  }
  if (state.loggedOutPattern !== undefined) {
    try {
      if (typeof state.loggedOutPattern !== 'string' || state.loggedOutPattern === '') throw new Error('empty');
      new RegExp(state.loggedOutPattern);
    } catch {
      c.invalid('auth.state.loggedOutPattern', 'auth.state.loggedOutPattern must be a valid regular expression');
    }
  }
}

// Report modes bound how much is produced. They only constrain what the user already chose; nothing is added silently.
function checkReporting(c: Checker, raw: Obj, reporting: Obj): void {
  c.oneOf(reporting, 'mode', 'reporting.mode', REPORT_MODES);
  if (reporting.stepScreenshots !== undefined && typeof reporting.stepScreenshots !== 'boolean') c.invalid('reporting.stepScreenshots', 'reporting.stepScreenshots must be true or false');
  const masks = reporting.maskSelectors;
  if (masks !== undefined && (!Array.isArray(masks) || masks.some((m) => typeof m !== 'string' || m.trim() === ''))) {
    c.invalid('reporting.maskSelectors', 'reporting.maskSelectors must be a list of CSS selectors');
  }
  const mode = reporting.mode;
  const reporters = Array.isArray(raw.reporters) ? raw.reporters : [];
  const has = (r: string) => reporters.includes(r);
  // Which reports are produced is the user's selection (reporters); the mode only bounds the evidence volume and the heavier reporters.
  if (mode === 'standard') {
    for (const r of ['allure', 'evidence-pdf']) if (has(r)) c.invalid('reporting.mode', `mode "standard" is failure-focused; "${r}" needs mode "full" or "audit"`);
    // Standard keeps artifact volume down: nothing is recorded for tests that pass.
    const ev = isObj(raw.evidence) ? raw.evidence : {};
    if (ev.video === 'on' || ev.screenshot === 'on' || ev.trace === 'on') {
      c.invalid('evidence', 'mode "standard" is failure-focused: use off/retain-on-failure/only-on-failure, or choose mode "full" or "audit" to record every test');
    }
  }
  if (reporting.stepScreenshots === true && mode !== 'audit') c.invalid('reporting.stepScreenshots', 'step screenshots are an audit-mode option');
  if (has('evidence-pdf')) {
    if (mode !== 'audit') c.invalid('reporters', 'the evidence-pdf reporter needs reporting.mode "audit"');
    if (reporting.stepScreenshots !== true) c.invalid('reporting.stepScreenshots', 'the evidence-pdf reporter needs reporting.stepScreenshots true (it records the step log and the final-state screenshot)');
    const ev = isObj(raw.evidence) ? raw.evidence : {};
    if (ev.video !== 'on') c.invalid('evidence.video', 'the evidence-pdf reporter embeds one execution video per test, so evidence.video must be "on" (a failure-only recording leaves passing tests without one)');
  }
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasUrlCredentials(v: string): boolean {
  const u = new URL(v);
  return u.username !== '' || u.password !== '';
}

export function isAbsoluteOrEscaping(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..');
}

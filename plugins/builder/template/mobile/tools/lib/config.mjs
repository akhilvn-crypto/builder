// Framework paths, the saved configuration (non-secret) and how a run gets its variables.
//
//   <fw>/config/mobile.config.json        approved settings (no secrets)      written only through `config save`
//   <fw>/config/environments/<env>.json   non-secret per-environment values   passed to Maestro with -e NAME=value
//   <fw>/.env                             secrets (git-ignored)               passed through the process environment
//                                                                             as MAESTRO_<NAME>, never on a command line

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  CliError, deepMerge, ensureDir, parseEnvText, readJson, readText, toPosix, writeFileAtomic, writeJson,
} from './util.mjs';

export const FRAMEWORK_DIR = 'mobile-automation';
export const REPORT_FORMATS = ['html', 'junit'];
export const SECRET_PREFIX = 'MAESTRO_';
/** Variables the runner always supplies to Maestro. */
export const BUILTIN_VARS = ['APP_ID', 'PLATFORM', 'ENVIRONMENT'];

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  app: { root: '.', name: null },
  platforms: {
    android: { enabled: false, appId: null, artifact: null, variant: null },
    ios: { enabled: false, bundleId: null, artifact: null, variant: null },
  },
  environments: { default: null },
  flows: { appIdMode: 'env' },
  testCases: { sources: [] },
  execution: { flowTimeoutSec: 300, requirePhysicalDevice: true, failFast: false },
  secrets: { passing: 'env' },
  reporting: { formats: ['html', 'junit'] },
  devices: { android: { preferred: null }, ios: { preferred: null } },
};

/**
 * Work out where the framework lives. `root` is the project root the user selected; the framework folder is
 * <root>/mobile-automation unless --dir says otherwise, or unless this file is the project copy of the tools
 * (<fw>/tools/lib/config.mjs), in which case <fw> is where the tools are.
 */
export function makeContext({ root, dir, here }) {
  const projectRoot = path.resolve(root ?? process.cwd());
  let fw;
  if (dir) fw = path.resolve(projectRoot, dir);
  else {
    const toolsParent = path.resolve(here, '..', '..');
    const isProjectCopy = path.basename(path.resolve(here, '..')) === 'tools'
      && existsSync(path.join(toolsParent, 'state', 'scaffold.json'));
    fw = isProjectCopy ? toolsParent : path.join(projectRoot, FRAMEWORK_DIR);
  }
  const p = {
    config: path.join(fw, 'config', 'mobile.config.json'),
    envDir: path.join(fw, 'config', 'environments'),
    envFile: path.join(fw, '.env'),
    envExample: path.join(fw, '.env.example'),
    state: path.join(fw, 'state'),
    flows: path.join(fw, 'flows'),
    commonFlows: path.join(fw, 'flows', 'common'),
    tests: path.join(fw, 'tests'),
    testData: path.join(fw, 'test-data'),
    reports: path.join(fw, 'reports'),
    artifacts: path.join(fw, 'artifacts'),
    docs: path.join(fw, 'docs'),
  };
  p.scaffold = path.join(p.state, 'scaffold.json');
  p.traceability = path.join(p.state, 'traceability.json');
  p.specs = path.join(p.state, 'test-specs.json');
  p.setup = path.join(p.state, 'setup.json');
  p.validation = path.join(p.state, 'device-validation.json');
  p.healLog = path.join(p.state, 'healing-log.json');
  p.identifiers = path.join(p.state, 'identifiers.json');
  p.semantics = path.join(p.docs, 'semantics-requests.md');
  return {
    root: projectRoot,
    fw,
    p,
    rel: (abs) => toPosix(path.relative(projectRoot, abs)),
    relFw: (abs) => toPosix(path.relative(fw, abs)),
    scaffolded: existsSync(p.scaffold),
  };
}

export function requireScaffold(ctx) {
  if (!ctx.scaffolded) {
    throw new CliError(`The mobile framework is not set up in ${ctx.rel(ctx.fw) || '.'} (state/scaffold.json is missing). Run /builder:mobile-init (or /builder:build-mobile-automation) first.`, { needsInput: 'scaffold' });
  }
}

// ---------------------------------------------------------------- config file

const ANDROID_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadConfig(ctx) {
  const saved = readJson(ctx.p.config, null);
  return saved ? deepMerge(DEFAULT_CONFIG, saved) : null;
}

/** → { status: 'valid'|'absent'|'invalid', issues: [{ field, kind: 'missing'|'invalid', message }] } */
export function checkConfig(cfg) {
  if (!cfg) return { status: 'absent', issues: [{ field: 'config', kind: 'missing', message: 'No saved configuration yet (config/mobile.config.json).' }] };
  const issues = [];
  const add = (field, kind, message) => issues.push({ field, kind, message });
  const { android, ios } = cfg.platforms ?? {};
  if (!android?.enabled && !ios?.enabled) add('platforms', 'missing', 'Choose at least one platform in scope (android and/or ios).');
  if (android?.enabled) {
    if (!android.appId) add('platforms.android.appId', 'missing', 'The Android application ID (applicationId) is required.');
    else if (!ANDROID_ID.test(android.appId)) add('platforms.android.appId', 'invalid', `"${android.appId}" is not a valid Android application ID (for example com.example.app).`);
  }
  if (ios?.enabled) {
    if (!ios.bundleId) add('platforms.ios.bundleId', 'missing', 'The iOS bundle identifier is required.');
    else if (!IOS_ID.test(ios.bundleId)) add('platforms.ios.bundleId', 'invalid', `"${ios.bundleId}" is not a valid iOS bundle identifier.`);
  }
  if (!cfg.environments?.default) add('environments.default', 'missing', 'Name the target environment the runs are recorded against (for example staging).');
  else if (!ENV_NAME.test(cfg.environments.default)) add('environments.default', 'invalid', 'The environment name may use letters, digits, ".", "_" and "-".');
  if (!['env', 'literal'].includes(cfg.flows?.appIdMode)) add('flows.appIdMode', 'invalid', 'flows.appIdMode must be "env" or "literal".');
  else if (cfg.flows.appIdMode === 'literal' && android?.enabled && ios?.enabled && android.appId !== ios.bundleId) {
    add('flows.appIdMode', 'invalid', 'appIdMode "literal" needs one identifier for both platforms; use "env" when the Android application ID and the iOS bundle ID differ.');
  }
  if (!['env', 'cli-arg'].includes(cfg.secrets?.passing)) add('secrets.passing', 'invalid', 'secrets.passing must be "env" or "cli-arg".');
  const fmts = cfg.reporting?.formats;
  if (!Array.isArray(fmts) || fmts.some((f) => !REPORT_FORMATS.includes(f))) add('reporting.formats', 'invalid', `reporting.formats may contain only: ${REPORT_FORMATS.join(', ')}.`);
  const t = cfg.execution?.flowTimeoutSec;
  if (!Number.isInteger(t) || t < 30 || t > 3600) add('execution.flowTimeoutSec', 'invalid', 'execution.flowTimeoutSec must be a whole number of seconds between 30 and 3600.');
  if (!Array.isArray(cfg.testCases?.sources) || cfg.testCases.sources.some((s) => typeof s !== 'string')) add('testCases.sources', 'invalid', 'testCases.sources must be a list of paths.');
  const issuesOnly = issues;
  return { status: issuesOnly.length ? 'invalid' : 'valid', issues: issuesOnly };
}

/** Merge `patch` into the saved config. Values that are wrong are refused; values still missing are reported, not invented. */
export function saveConfig(ctx, patch) {
  const base = loadConfig(ctx) ?? DEFAULT_CONFIG;
  const merged = deepMerge(base, patch);
  const check = checkConfig(merged);
  const bad = check.issues.filter((i) => i.kind === 'invalid');
  if (bad.length) throw new CliError(`Configuration not saved: ${bad.map((i) => i.message).join(' ')}`, { details: { issues: bad } });
  writeJson(ctx.p.config, merged);
  return { saved: true, file: ctx.rel(ctx.p.config), ...checkConfig(merged), config: merged };
}

export function platformIdentifier(cfg, platform) {
  return platform === 'ios' ? cfg.platforms.ios.bundleId : cfg.platforms.android.appId;
}

export function enabledPlatforms(cfg) {
  return ['android', 'ios'].filter((p) => cfg.platforms?.[p]?.enabled);
}

// ---------------------------------------------------------------- environments and secrets

export function listEnvironments(ctx) {
  try {
    return readdirSync(ctx.p.envDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
}

export function loadEnvironment(ctx, name) {
  const file = path.join(ctx.p.envDir, `${name}.json`);
  if (!existsSync(file)) return { file, exists: false, vars: {} };
  const data = readJson(file, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CliError(`${ctx.rel(file)} must be a JSON object of NAME: "value" pairs.`);
  }
  const vars = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CliError(`${ctx.rel(file)}: "${k}" is not a valid variable name.`);
    if (/^MAESTRO_/.test(k) || /(pass(word)?|secret|token|api[_-]?key|otp)/i.test(k)) {
      throw new CliError(`${ctx.rel(file)}: "${k}" looks like a secret. Secrets belong in ${ctx.relFw(ctx.p.envFile)} (git-ignored), not in a committed environment file.`);
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new CliError(`${ctx.rel(file)}: "${k}" must be a string, number or boolean.`);
    vars[k] = String(v);
  }
  return { file, exists: true, vars };
}

export function loadSecretsFile(ctx) {
  const text = readText(ctx.p.envFile, null);
  return text === null ? {} : parseEnvText(text);
}

/** `NAME` → `MAESTRO_NAME` (already prefixed names are kept). */
export const flowVariableFor = (name) => (name.startsWith(SECRET_PREFIX) ? name : `${SECRET_PREFIX}${name}`);

/**
 * Everything a run passes to Maestro. `referenced` is the set of ${VARIABLES} the selected flows use (and do not define
 * themselves). Returns the -e values, the child process environment, the secret values (for redaction) and what is missing.
 */
export function resolveRunVariables(ctx, cfg, { platform, environment, referenced = new Set() }) {
  const env = loadEnvironment(ctx, environment);
  const builtins = { APP_ID: platformIdentifier(cfg, platform), PLATFORM: platform, ENVIRONMENT: environment };
  const vars = { ...env.vars, ...builtins };
  const file = loadSecretsFile(ctx);
  const secrets = {};
  const missing = [];
  for (const name of [...referenced].sort()) {
    if (name in vars) continue;
    if (name.startsWith(SECRET_PREFIX)) {
      const bare = name.slice(SECRET_PREFIX.length);
      const value = file[name] || file[bare] || process.env[name] || '';
      if (value) secrets[name] = value; else missing.push(name);
    } else missing.push(name);
  }
  const childEnv = { ...process.env };
  const cliArgs = [];
  for (const [k, v] of Object.entries(vars)) cliArgs.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(secrets)) {
    if (cfg.secrets?.passing === 'cli-arg') cliArgs.push('-e', `${k}=${v}`);
    else childEnv[k] = v;
  }
  return {
    environment, environmentFile: env.exists ? ctx.rel(env.file) : null, vars, secretNames: Object.keys(secrets),
    secretValues: Object.values(secrets), missing, childEnv, cliArgs,
  };
}

/** Add `NAME=` lines (no values) to .env and .env.example for variables the test cases reference. */
export function syncEnvFiles(ctx, names) {
  const added = [];
  for (const [file, header] of [[ctx.p.envExample, '# Copy to .env and fill in. .env is git-ignored. Names only here, never values.\n'], [ctx.p.envFile, '# Secrets for the mobile tests. Git-ignored. Never commit or paste these.\n']]) {
    const current = readText(file, null);
    const present = current === null ? {} : parseEnvText(current);
    const missing = names.filter((n) => !(n in present));
    if (current === null || missing.length) {
      ensureDir(path.dirname(file));
      const body = (current ?? header).replace(/\s*$/, '\n') + missing.map((n) => `${n}=\n`).join('');
      writeFileAtomic(file, body);
      if (missing.length) added.push(...missing.map((n) => `${path.basename(file)}:${n}`));
    }
  }
  return added;
}

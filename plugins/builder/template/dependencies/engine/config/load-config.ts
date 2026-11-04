// Resolves the effective configuration.
//
// Precedence (lowest -> highest):
//   1. DEFAULTS (non-material settings only) + the language chosen at init (dependencies/state/scaffold.json)
//   2. config/automation.config.json (approved, persisted choices)
//   3. environment variables (see ENV_OVERRIDES)
//   4. explicit command arguments
//
// Objects merge key-by-key; arrays and scalars are replaced wholesale.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { readScaffold } from './scaffold.ts';
import { DEFAULTS, validateConfig, type AutomationConfig, type ConfigIssue } from './schema.ts';

export const CONFIG_RELATIVE_PATH = 'config/automation.config.json';

type Json = Record<string, unknown>;

// Environment variable -> config path. Values are parsed per `parse`.
export const ENV_OVERRIDES: ReadonlyArray<{ env: string; path: string; parse: (v: string) => unknown }> = [
  { env: 'PW_BASE_URL', path: 'app.baseUrl', parse: (v) => v },
  { env: 'PW_ENVIRONMENT', path: 'app.environment', parse: (v) => v },
  { env: 'PW_BROWSERS', path: 'browsers', parse: (v) => v.split(',').map((s) => s.trim()).filter(Boolean) },
  { env: 'PW_WORKERS', path: 'execution.workers', parse: parseIntOrRaw },
  { env: 'PW_RETRIES', path: 'execution.retries', parse: parseIntOrRaw },
];

// Keep invalid numeric input as-is so validation reports it rather than silently dropping it.
function parseIntOrRaw(v: string): unknown {
  return /^-?\d+$/.test(v.trim()) ? Number(v) : v;
}

export function configPath(rootDir: string): string {
  return path.join(rootDir, CONFIG_RELATIVE_PATH);
}

export type ConfigState =
  | { status: 'valid'; config: AutomationConfig; sources: string[] }
  | { status: 'absent'; issues: ConfigIssue[]; sources: string[] }
  | { status: 'invalid'; issues: ConfigIssue[]; sources: string[] };

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  overrides?: Json; // explicit command arguments, already shaped like the config
}

export function loadConfig(rootDir: string, opts: LoadOptions = {}): ConfigState {
  const env = opts.env ?? process.env;
  const sources = ['defaults'];
  const file = readJson(configPath(rootDir));
  if (!file.ok && file.reason === 'parse_error') {
    return { status: 'invalid', issues: [{ path: '', kind: 'invalid', message: file.message }], sources };
  }
  let merged: Json = structuredClone(DEFAULTS) as unknown as Json;
  const scaffold = readScaffold(rootDir);
  if (scaffold) {
    merged.language = scaffold.language;
    sources.push('dependencies/state/scaffold.json');
  }
  if (file.ok) {
    if (!isPlainObject(file.value)) {
      return { status: 'invalid', issues: [{ path: '', kind: 'invalid', message: 'config file must contain a JSON object' }], sources };
    }
    merged = deepMerge(merged, file.value);
    sources.push(CONFIG_RELATIVE_PATH);
  }
  for (const o of ENV_OVERRIDES) {
    const raw = env[o.env];
    if (raw !== undefined && raw !== '') {
      setPath(merged, o.path, o.parse(raw));
      sources.push(`env:${o.env}`);
    }
  }
  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    merged = deepMerge(merged, opts.overrides);
    sources.push('arguments');
  }
  const result = validateConfig(merged);
  const drift = scaffold && merged.language !== scaffold.language ? [languageDrift(scaffold.language)] : [];
  if (result.ok && drift.length === 0) return { status: 'valid', config: result.config, sources };
  return { status: file.ok ? 'invalid' : 'absent', issues: [...(result.ok ? [] : result.issues), ...drift], sources };
}

// Would `saveConfig` accept this candidate? Nothing is written.
export function checkCandidate(rootDir: string, candidate: unknown): { ok: true; config: AutomationConfig } | { ok: false; issues: ConfigIssue[] } {
  const scaffold = readScaffold(rootDir);
  const seed = structuredClone(DEFAULTS) as unknown as Json;
  if (scaffold) seed.language = scaffold.language;
  const merged = isPlainObject(candidate) ? deepMerge(seed, candidate) : candidate;
  const result = validateConfig(merged);
  const drift = scaffold && isPlainObject(merged) && merged.language !== scaffold.language ? [languageDrift(scaffold.language)] : [];
  if (!result.ok || drift.length > 0) return { ok: false, issues: [...(result.ok ? [] : result.issues), ...drift] };
  return { ok: true, config: result.config };
}

// Persist approved choices. Validates the full config first; never writes an invalid file.
export function saveConfig(rootDir: string, candidate: unknown): { ok: true } | { ok: false; issues: ConfigIssue[] } {
  const result = checkCandidate(rootDir, candidate);
  if (!result.ok) return result;
  const target = configPath(rootDir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeJsonAtomic(target, result.config);
  return { ok: true };
}

// The scaffolded files (fixtures, playwright.config, page objects) are in one language; config must match them.
function languageDrift(scaffolded: string): ConfigIssue {
  return {
    path: 'language',
    kind: 'invalid',
    message: `language is fixed by the scaffold (${scaffolded}); to switch, scaffold a fresh automation/ folder with the other language`,
  };
}

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

function setPath(obj: Json, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]!] = value;
}

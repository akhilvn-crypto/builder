// Reads and updates automation/.env, the git-ignored home of every credential and account detail the tests use.
//
// The pipeline owns the plumbing, the user owns the values:
//   - values found in the test cases are written to .env automatically (never over a value the user already set),
//   - names the specs reference but nobody has a value for get an empty entry and are reported as `missing`,
//   - .env.example only ever receives names,
//   - reports and CLI output carry names only, never values.
// Pure Node; no Playwright import.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';
export const MANAGED_ENV_FILE = 'managed-env.json'; // in dependencies/state/: names of the variables the pipeline created

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const PLAIN_VALUE = /^[A-Za-z0-9_.@+/:,~%^*!?-]+$/;
const HEADER = '# Added by builder from the test cases. Fill in any empty value; this file is git-ignored.';

export function envFilePath(rootDir: string): string {
  return path.join(rootDir, ENV_FILE);
}

// Format a value so Node's process.loadEnvFile reads it back unchanged; null when no quoting style can hold it.
export function quoteEnvValue(value: string): string | null {
  if (/[\r\n]/.test(value)) return null;
  if (PLAIN_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  return null;
}

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === '`') {
    const end = v.indexOf(q, 1);
    if (end > 0) return q === '"' ? v.slice(1, end).replace(/\\n/g, '\n') : v.slice(1, end);
  }
  if (v.startsWith('#')) return '';
  const comment = v.search(/\s#/);
  return (comment >= 0 ? v.slice(0, comment) : v).trim();
}

export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE.exec(line);
    if (m) out.set(m[1]!, unquote(m[2]!));
  }
  return out;
}

export function readEnvValues(rootDir: string): Map<string, string> {
  const file = envFilePath(rootDir);
  return existsSync(file) ? parseEnvText(readFileSync(file, 'utf8')) : new Map();
}

// ---- names the pipeline manages (for redaction) ----

export function readManagedEnvVars(rootDir: string): string[] {
  const j = readJson(path.join(stateDir(rootDir), MANAGED_ENV_FILE));
  const vars = j.ok ? (j.value as { vars?: unknown }).vars : null;
  return Array.isArray(vars) ? vars.filter((v): v is string => typeof v === 'string') : [];
}

function saveManagedEnvVars(rootDir: string, names: readonly string[]): void {
  const merged = [...new Set([...readManagedEnvVars(rootDir), ...names])].sort();
  mkdirSync(stateDir(rootDir), { recursive: true });
  writeJsonAtomic(path.join(stateDir(rootDir), MANAGED_ENV_FILE), { schemaVersion: 1, vars: merged });
}

// Variables whose values must never appear in logs or reports: the configured ones plus those the pipeline created.
export function redactionEnvVars(rootDir: string, configured: readonly string[]): string[] {
  return [...new Set([...configured, ...readManagedEnvVars(rootDir)])];
}

// The secret values to mask. A value comes from the real environment, else from .env (the CLI does not load .env itself).
export function secretValuesFor(rootDir: string, configured: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const fromFile = readEnvValues(rootDir);
  return redactionEnvVars(rootDir, configured)
    .map((n) => env[n] || fromFile.get(n))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ---- what the specs need ----

export function referencedEnvVars(doc: TestSpecDocument, onlyReady = true): string[] {
  const names = doc.specs
    .filter((s) => !onlyReady || s.status === 'ready')
    .flatMap((s) => s.testData.flatMap((d) => (d.envVar ? [d.envVar] : [])));
  return [...new Set(names)];
}

// Names with no non-empty value in the real environment or in .env.
export function missingEnvVars(rootDir: string, names: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const fromFile = readEnvValues(rootDir);
  return names.filter((n) => !(env[n] || fromFile.get(n)));
}

// ---- writing ----

export interface EnvSyncReport {
  created: string[]; // written to .env with the value found in the test cases
  filled: string[]; // existing empty entries that received the value from the test cases
  unchanged: string[]; // already held the same value
  keptExisting: string[]; // .env already held a different value: left alone, so the tests use the .env value
  placeholders: string[]; // referenced by the specs, no value anywhere: empty entry added for the user to fill in
  exampleAdded: string[]; // names added to .env.example
  gitignoreUpdated: boolean; // `.env` was not git-ignored; a rule was added
  missing: string[]; // still no value anywhere: the user must add these to .env
}

function ensureGitignored(rootDir: string): boolean {
  const file = path.join(rootDir, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some((l) => /^\/?\.env(?:\*|\.\*)?$/.test(l.trim()))) return false;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : eol}.env${eol}`);
  return true;
}

function addExampleNames(rootDir: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const file = path.join(rootDir, ENV_EXAMPLE_FILE);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const present = parseEnvText(text);
  const added = names.filter((n) => !present.has(n));
  if (added.length === 0) return [];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lead = text === '' || text.endsWith('\n') ? '' : eol;
  writeFileSync(file, `${text}${lead}${added.map((n) => `${n}=`).join(eol)}${eol}`);
  return added;
}

// Apply detected values and referenced names to .env / .env.example. Existing user values always win.
export function syncEnvFiles(
  rootDir: string,
  detected: ReadonlyMap<string, string>,
  referenced: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EnvSyncReport {
  const file = envFilePath(rootDir);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const lineOf = new Map<string, number>();
  lines.forEach((l, i) => { const m = ENV_LINE.exec(l); if (m) lineOf.set(m[1]!, i); });
  const current = parseEnvText(text);

  const report: EnvSyncReport = { created: [], filled: [], unchanged: [], keptExisting: [], placeholders: [], exampleAdded: [], gitignoreUpdated: false, missing: [] };
  const appended: string[] = [];
  for (const [name, value] of detected) {
    const quoted = quoteEnvValue(value);
    if (quoted === null) continue; // the parser never hands these over; guard anyway
    const held = current.get(name);
    if (held === undefined) { appended.push(`${name}=${quoted}`); report.created.push(name); }
    else if (held === '') { lines[lineOf.get(name)!] = `${name}=${quoted}`; report.filled.push(name); }
    else if (held === value) report.unchanged.push(name);
    else report.keptExisting.push(name);
  }
  for (const name of referenced) {
    if (detected.has(name) || current.has(name)) continue;
    appended.push(`${name}=`);
    report.placeholders.push(name);
  }
  if (appended.length > 0 && !text.includes(HEADER)) appended.unshift(...(lines.length ? [''] : []), HEADER);

  const changed = appended.length > 0 || report.filled.length > 0;
  if (changed) {
    report.gitignoreUpdated = ensureGitignored(rootDir);
    writeFileSync(file, [...lines, ...appended].join(eol) + eol, { mode: 0o600 });
  }
  const names = [...new Set([...detected.keys(), ...referenced])];
  report.exampleAdded = addExampleNames(rootDir, names);
  if (detected.size > 0) saveManagedEnvVars(rootDir, [...detected.keys()]);
  report.missing = missingEnvVars(rootDir, names, env);
  return report;
}

// Message for the orchestrator to show the user. Names and file location only.
export function missingEnvMessage(rootDir: string, missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  const rel = path.join(path.basename(rootDir), ENV_FILE).split(path.sep).join('/');
  return `Add a value for ${missing.join(', ')} in ${rel} (the entries are already there, just empty), then resume. Do not paste values into the chat.`;
}

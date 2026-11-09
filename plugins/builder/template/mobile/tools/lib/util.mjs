// Shared helpers for the Maestro mobile tooling: JSON output, safe file writes, process execution with timeouts,
// secret redaction. No dependencies; runs on any Node >= 18.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Error that maps to a CLI exit code. `needsInput` tells the orchestrator which answer is missing (exit 2). */
export class CliError extends Error {
  constructor(message, { code = 1, needsInput, details } = {}) {
    super(message);
    this.exitCode = needsInput ? 2 : code;
    this.needsInput = needsInput;
    this.details = details;
  }
}

export const toPosix = (p) => p.split(path.sep).join('/');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function slug(text, max = 60) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'item').slice(0, max).replace(/-+$/g, '') || 'item';
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(file, fallback = null) {
  try { return readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function readJson(file, fallback = null) {
  const text = readText(file);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Write through a temp file so a crash never leaves half a state file. */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export const writeJson = (file, obj) => writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);

export function walkFiles(dir, { skip = [], maxDepth = 12 } = {}) {
  const found = [];
  const visit = (current, depth) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) visit(full, depth + 1); } else found.push(full);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) visit(dir, 0);
  return found.sort();
}

/** `.env`-style text → { NAME: value }. Comments and blank lines are ignored; surrounding quotes are removed. */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Returns a function that replaces every secret value (4+ characters) in a string with ***. */
export function makeRedactor(secrets) {
  const values = [...new Set((secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 4))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let result = String(text ?? '');
    for (const v of values) result = result.split(v).join('***');
    return result;
  };
}

/** Compact timestamp for run ids: 20260109-134501. */
export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function homeDir() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }

// ---------------------------------------------------------------- finding and running programs

const isWin = process.platform === 'win32';

/** Resolve a program name to a file: PATH (with PATHEXT on Windows) first, then the extra directories. */
export function which(name, extraDirs = []) {
  const exts = isWin ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return null;
}

function quoteForCmd(arg) {
  if (/[\r\n"%]/.test(arg)) {
    throw new CliError(`Argument contains a character that cannot be passed safely to a Windows batch file (", % or a newline): ${arg.slice(0, 40)}`);
  }
  return /[\s&|<>()^,;=!]/.test(arg) || arg === '' ? `"${arg}"` : arg;
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) {
      // absolute path: a restricted PATH (CI, tests) must not stop a timed-out process from being killed
      const taskkill = path.join(process.env.SystemRoot || process.env.windir || 'C:\Windows', 'System32', 'taskkill.exe');
      const k = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => { try { process.kill(pid); } catch { /* already gone */ } });
    } else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
  } catch { /* already gone */ }
}

/**
 * Run a program to completion. Never throws for a non-zero exit; resolves { code, stdout, stderr, timedOut, spawnError }.
 * `file` must be a resolved path (see which()). On Windows .cmd/.bat files go through cmd.exe.
 */
export function run(file, args = [], { cwd, env, timeoutMs = 120000, input, onData } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const needsShell = isWin && /\.(cmd|bat)$/i.test(file);
      if (needsShell) {
        const line = [file, ...args].map(quoteForCmd).join(' ');
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
          cwd, env: env ?? process.env, windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        child = spawn(file, args, { cwd, env: env ?? process.env, windowsHide: true, detached: !isWin, stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (d) => { const s = d.toString(); stdout += s; onData?.(s, 'stdout'); });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; onData?.(s, 'stderr'); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, spawnError: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export const isWindows = isWin;

// ---------------------------------------------------------------- cli plumbing

export function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** Tiny argv parser: --flag, --key value, --key=value, repeated keys become arrays, the rest are positionals. */
export function parseArgv(argv, { booleans = [], arrays = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq));
    let value;
    if (booleans.includes(key)) value = eq === -1 ? true : a.slice(eq + 1) !== 'false';
    else if (eq !== -1) value = a.slice(eq + 1);
    else { value = argv[i + 1]; i += 1; if (value === undefined) throw new CliError(`--${key} needs a value`); }
    if (arrays.includes(key)) (flags[key] ??= []).push(value); else flags[key] = value;
  }
  return { flags, positionals };
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

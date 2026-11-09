#!/usr/bin/env node
// Scaffolds the Maestro mobile automation framework into <root>/mobile-automation (or --dir), next to — never inside —
// the Playwright `automation/` and `dependencies/` folders, which it does not read or change.
//
//   mobile-automation/
//     tools/        plugin-managed CLI (maestro-cli.mjs + lib/). Refreshed only with --update.
//     config/  flows/common/  tests/  test-data/  docs/  state/   created once; yours afterwards
//     .gitignore  .env.example  README.md
//
// Never installs anything, never overwrites a file you may have edited (only --update refreshes tools/, only --force
// rewrites the rest), and is safe to rerun.
//
// Usage: node <plugin>/scripts/mobile-init.mjs [--root <dir>] [--dir mobile-automation] [--update] [--force] [--dry-run]
// Output: JSON summary on stdout. Exit 0 ok · 1 error · 2 an answer is missing (root).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(PLUGIN_ROOT, 'template', 'mobile');
const PLUGIN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;

const { values } = parseArgs({
  options: {
    root: { type: 'string' }, dir: { type: 'string', default: 'mobile-automation' },
    update: { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  },
});

const projectRoot = path.resolve(values.root ?? process.cwd());
const fw = path.resolve(projectRoot, values.dir);
const dry = values['dry-run'];
const summary = {
  ok: true, projectRoot, frameworkFolder: path.relative(projectRoot, fw).split(path.sep).join('/'), pluginVersion: PLUGIN_VERSION, dryRun: dry,
  created: [], overwritten: [], skipped: [], merged: [], removed: [], warnings: [],
};

class NeedsInput extends Error { constructor(field, message) { super(message); this.field = field; } }

const rel = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/');
const walk = (abs) => (statSync(abs).isDirectory() ? readdirSync(abs).flatMap((n) => walk(path.join(abs, n))) : [abs]);

function write(dest, content, kind) {
  if (!dry) { mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, content); }
  summary[kind].push(rel(dest));
}

/** Create a user-owned file once. */
function createOnce(dest, content) {
  if (!existsSync(dest)) return write(dest, content, 'created');
  if (values.force && readFileSync(dest, 'utf8') !== content) return write(dest, content, 'overwritten');
  summary.skipped.push(rel(dest));
}

/** Plugin-managed file: created when absent, replaced only with --update / --force. */
function managed(dest, content) {
  if (!existsSync(dest)) return write(dest, content, 'created');
  if (readFileSync(dest, 'utf8') === content) return summary.skipped.push(rel(dest));
  if (values.update || values.force) return write(dest, content, 'overwritten');
  summary.skipped.push(rel(dest));
  if (!summary.warnings.some((w) => w.startsWith('tools/ differs'))) {
    summary.warnings.push('tools/ differs from this plugin version and was left alone. Run with --update to refresh the plugin-managed CLI (your flows and config are never touched).');
  }
}

function checkRootIsNotSandboxScratch() {
  if (values.root !== undefined) return;
  const mnt = path.join(projectRoot, 'mnt');
  if (!existsSync(mnt) || !statSync(mnt).isDirectory()) return;
  if (['.git', 'package.json', 'pubspec.yaml', 'automation', 'dependencies', path.basename(fw)].some((n) => existsSync(path.join(projectRoot, n)))) return;
  const candidates = readdirSync(mnt, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(mnt, e.name).split(path.sep).join('/'));
  summary.candidateRoots = candidates;
  throw new NeedsInput('root', `The working directory (${projectRoot}) looks like a Cowork session folder, not the user's project: it has a mnt/ folder and no project files. Pass --root <the folder the user attached>${candidates.length ? ` (candidates: ${candidates.join(', ')})` : ''}.`);
}

function mergeClaudeMd() {
  const dest = path.join(projectRoot, 'CLAUDE.md');
  const block = readFileSync(path.join(TEMPLATE, 'CLAUDE.mobile.md'), 'utf8');
  const marker = '<!-- builder-mobile:start -->';
  if (!existsSync(dest)) return write(dest, block, 'created');
  const current = readFileSync(dest, 'utf8');
  if (current.includes(marker)) {
    if (!values.update && !values.force) return summary.skipped.push('CLAUDE.md');
    return write(dest, current.replace(/<!-- builder-mobile:start -->[\s\S]*?<!-- builder-mobile:end -->\n?/, block), 'merged');
  }
  write(dest, `${current.replace(/\s*$/, '\n')}\n${block}`, 'merged');
}

try {
  if (!existsSync(projectRoot)) throw new Error(`root does not exist: ${projectRoot}`);
  checkRootIsNotSandboxScratch();
  if (path.relative(projectRoot, fw).startsWith('..')) throw new Error('--dir must be inside the project root.');
  for (const protectedName of ['automation', 'dependencies']) {
    if (path.resolve(fw) === path.join(projectRoot, protectedName)) throw new Error(`--dir cannot be "${protectedName}": that folder belongs to the Playwright framework.`);
  }

  // plugin-managed tools
  const toolsSrc = path.join(TEMPLATE, 'tools');
  const toolsDest = path.join(fw, 'tools');
  const wanted = new Set();
  for (const file of walk(toolsSrc)) {
    const relPath = path.relative(toolsSrc, file);
    wanted.add(relPath);
    managed(path.join(toolsDest, relPath), readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  if (existsSync(toolsDest) && (values.update || values.force)) {
    for (const file of walk(toolsDest)) {
      const relPath = path.relative(toolsDest, file);
      if (!wanted.has(relPath)) { if (!dry) rmSync(file); summary.removed.push(rel(file)); }
    }
  }

  // user-owned framework files
  const fwSrc = path.join(TEMPLATE, 'framework');
  const rename = { gitignore: '.gitignore', 'env.example': '.env.example' };
  for (const file of walk(fwSrc)) {
    const relPath = path.relative(fwSrc, file);
    const dir = path.dirname(relPath);
    const base = rename[path.basename(relPath)] ?? path.basename(relPath);
    createOnce(path.join(fw, dir === '.' ? '' : dir, base), readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
  for (const d of ['flows/common', 'tests', 'test-data', 'config/environments', 'docs', 'state']) {
    if (!dry) mkdirSync(path.join(fw, d), { recursive: true });
  }

  // record
  const scaffoldFile = path.join(fw, 'state', 'scaffold.json');
  const previous = existsSync(scaffoldFile) ? JSON.parse(readFileSync(scaffoldFile, 'utf8')) : null;
  const toolsVersion = JSON.parse(readFileSync(path.join(toolsSrc, 'version.json'), 'utf8')).toolsVersion;
  const record = { pluginVersion: PLUGIN_VERSION, toolsVersion, createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!previous) write(scaffoldFile, `${JSON.stringify(record, null, 2)}\n`, 'created');
  else if (values.update || values.force) write(scaffoldFile, `${JSON.stringify({ ...previous, ...record }, null, 2)}\n`, 'overwritten');
  else summary.skipped.push(rel(scaffoldFile));
  if (previous && previous.toolsVersion !== toolsVersion && !(values.update || values.force)) {
    summary.warnings.push(`The framework was created with tools ${previous.toolsVersion}; this plugin ships ${toolsVersion}. Run /builder:mobile-init --update to refresh tools/.`);
  }

  mergeClaudeMd();

  summary.next = [
    'Nothing was installed and no device was touched.',
    `Run /builder:build-mobile-automation to continue: it checks Maestro, Java and the Android/iOS tooling, finds your devices, and asks before installing or changing anything.`,
    `Configuration is saved with: node ${summary.frameworkFolder}/tools/maestro-cli.mjs config save …`,
  ];
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (err) {
  const needs = err instanceof NeedsInput ? { needsInput: err.field } : {};
  process.stdout.write(`${JSON.stringify({ ...summary, ok: false, ...needs, error: err.message }, null, 2)}\n`);
  process.exitCode = err instanceof NeedsInput ? 2 : 1;
}

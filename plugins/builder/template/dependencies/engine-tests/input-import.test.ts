// `input import`: the user's test cases, from any path and in their own layout, become the pipeline's Markdown under
// dependencies/input/test-cases/, with credentials moved to automation/.env and the original left alone.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeFile, writeXlsx } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  let json: any = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { code: r.status, json, stderr: r.stderr };
}

function must(root: string, ...args: string[]) {
  const r = cli(root, ...args);
  assert.equal(r.code, 0, `${args.join(' ')} -> ${r.code}\n${JSON.stringify(r.json, null, 2)}\n${r.stderr}`);
  return r.json;
}

// The user's workbook lives outside the project, in a folder of its own, with its own column names.
function project(t: { after: (fn: () => void) => void }) {
  const root = tmpRoot(t);
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(validConfig())));
  const outside = path.join(path.dirname(root), 'users-qa-folder');
  const workbook = writeXlsx(outside, 'cases.xlsx', [
    { name: 'Login', rows: [['Test Case ID', 'Scenario', 'Procedure', 'Expected Result', 'Test Data'], ['LOG-1', 'Valid sign in', 'Open the login page', 'The login page is shown', 'password: Sup3r-secret']] },
    { name: 'Create Project', rows: [['Test Case ID', 'Scenario', 'Procedure', 'Expected Result'], ['PRJ-1', 'Create a project', 'Click "New project"', 'The project form opens']] },
  ]);
  return { root, outside, workbook, dest: path.join(dependenciesDir(root), 'input', 'test-cases') };
}

test('import converts a workbook from any path to one Markdown file per test case and moves the password to .env', (t) => {
  const { root, workbook, dest } = project(t);
  const before = readFileSync(workbook);

  const r = must(root, 'input', 'import', '--from', workbook);
  assert.equal(r.path, 'input/test-cases');
  assert.deepEqual(r.files.map((f: any) => [f.file, f.id, f.state]), [
    ['input/test-cases/LOG-1.md', 'LOG-1', 'created'],
    ['input/test-cases/PRJ-1.md', 'PRJ-1', 'created'],
  ]);
  assert.deepEqual(r.counts, { total: 2, valid: 2, warning: 0, needsClarification: 0, invalid: 0, ready: 2 });
  assert.deepEqual(r.env.created, ['TEST_PASSWORD']);
  assert.deepEqual(r.tables.map((x: any) => x.path), ['cases.xlsx', 'cases.xlsx'], 'files are named relative to the source, not as ../../..');
  assert.deepEqual(r.othersInFolder, []);
  assert.ok(!JSON.stringify(r).includes('Sup3r-secret'), 'no value in the output');

  const md = readFileSync(path.join(dest, 'LOG-1.md'), 'utf8');
  assert.match(md, /^# Login\n/);
  assert.match(md, /## LOG-1: Valid sign in/);
  assert.match(md, /- password: env:TEST_PASSWORD/);
  assert.ok(!md.includes('Sup3r-secret'));
  assert.match(readFileSync(path.join(root, '.env'), 'utf8'), /TEST_PASSWORD=Sup3r-secret/);

  assert.deepEqual(readFileSync(workbook), before, 'the original is only read');
  assert.deepEqual(readdirSync(dest).sort(), ['LOG-1.md', 'PRJ-1.md'], 'only converted files are saved');
});

test('the converted folder parses to the same cases as the original', (t) => {
  const { root, workbook } = project(t);
  const viaOriginal = must(root, 'input', 'inspect', '--path', workbook);
  must(root, 'input', 'import', '--from', workbook);
  const viaImport = must(root, 'input', 'inspect', '--path', 'input/test-cases');
  const shape = (x: any) => x.modules.map((m: any) => [m.module, m.cases]).sort(); // folders are read alphabetically, a workbook in sheet order
  assert.deepEqual(shape(viaImport), shape(viaOriginal));
  assert.equal(viaImport.ok, true);

  const runId: string = must(root, 'run', 'create', '--command', 'generate-tests', '--input', 'input/test-cases').runId;
  for (const [stage, status] of [['preflight', 'running'], ['preflight', 'completed'], ['configuration', 'running']]) must(root, 'run', 'stage', runId, stage!, status!);
  must(root, 'run', 'set-config', runId);
  const parse = must(root, 'specs', 'parse', runId, '--path', 'input/test-cases');
  assert.deepEqual(parse.counts, { total: 2, ready: 2, needsClarification: 0 });
  assert.deepEqual(parse.env.missing, [], 'the password is already in .env, nothing to ask the user');
});

test('importing again is a no-op; a changed file is a conflict until --overwrite', (t) => {
  const { root, workbook, dest } = project(t);
  must(root, 'input', 'import', '--from', workbook);
  const again = must(root, 'input', 'import', '--from', workbook);
  assert.deepEqual(again.files.map((f: any) => f.state), ['unchanged', 'unchanged']);

  // Anything else already in the folder is read by the pipeline too, so the import says so.
  writeFileSync(path.join(dest, 'older-grouping.md'), '# Older\n\n## OLD-1: Old case\n### Steps\n1. Open\n### Expected Results\n- Shown\n');
  assert.deepEqual(must(root, 'input', 'import', '--from', workbook).othersInFolder, ['input/test-cases/older-grouping.md']);
  rmSync(path.join(dest, 'older-grouping.md'));

  writeFileSync(path.join(dest, 'LOG-1.md'), '# Login\n\n## LOG-1: Edited by hand\n### Steps\n1. Open\n### Expected Results\n- Shown\n');
  const refused = cli(root, 'input', 'import', '--from', workbook);
  assert.equal(refused.code, 2);
  assert.match(refused.json.errors[0].message, /LOG-1\.md already exist with different content; nothing was written/);
  assert.match(readFileSync(path.join(dest, 'LOG-1.md'), 'utf8'), /Edited by hand/);

  const forced = must(root, 'input', 'import', '--from', workbook, '--overwrite');
  assert.deepEqual(forced.files.map((f: any) => f.state), ['updated', 'unchanged']);
  assert.match(readFileSync(path.join(dest, 'LOG-1.md'), 'utf8'), /Valid sign in/);
});

test('a layout the engine cannot read writes nothing; input map fixes it and import then succeeds', (t) => {
  const { root, outside } = project(t);
  const odd = writeXlsx(outside, 'odd.xlsx', [{ name: 'Cases', rows: [['Code', 'What', 'How', 'Outcome'], ['A-1', 'Open the app', 'Visit the home page', 'Home page shown']] }]);
  const refused = cli(root, 'input', 'import', '--from', odd);
  assert.equal(refused.code, 2);
  assert.match(refused.json.errors[0].message, /columns: "Code", "What", "How", "Outcome"/);
  assert.ok(!existsSync(path.join(dependenciesDir(root), 'input', 'test-cases')), 'no partial output');

  must(root, 'input', 'map', odd, '--sheet', 'Cases', '--column', 'id=Code', '--column', 'title=What', '--column', 'steps=How', '--column', 'expected=Outcome');
  const ok = must(root, 'input', 'import', '--from', odd);
  assert.deepEqual(ok.counts, { total: 1, valid: 1, warning: 0, needsClarification: 0, invalid: 0, ready: 1 });
});

test('a case that is not ready is still imported and reported; a missing path and a quoted path are handled', (t) => {
  const { root, outside } = project(t);
  mkdirSync(outside, { recursive: true });
  const md = path.join(outside, 'incomplete.md');
  writeFileSync(md, '# Settings\n\n## SET-1: Change language\n### Steps\n1. Open settings\n');
  const r = must(root, 'input', 'import', '--from', `"${md}"`);
  assert.deepEqual(r.counts, { total: 1, valid: 0, warning: 0, needsClarification: 1, invalid: 0, ready: 0 });
  assert.equal(r.needsClarification[0].id, 'SET-1');
  assert.ok(existsSync(path.join(dependenciesDir(root), 'input', 'test-cases', 'SET-1.md')));

  const missing = cli(root, 'input', 'import', '--from', path.join(outside, 'nope.xlsx'));
  assert.equal(missing.code, 2);
  assert.match(missing.json.errors[0].message, /path does not exist/);
});

test('files already in input/test-cases are not converted twice; a non-Markdown file there is explained', (t) => {
  const { root, dest, workbook } = project(t);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'login.md'), '# Login\n\n## LOG-1: Sign in\n### Steps\n1. Open the login page\n### Expected Results\n- The login page is shown\n');
  const same = must(root, 'input', 'import', '--from', dest);
  assert.equal(same.alreadyInPlace, true);
  assert.equal(same.counts.total, 1);

  writeFileSync(path.join(dest, 'extra.xlsx'), readFileSync(workbook));
  const mixed = cli(root, 'input', 'import', '--from', path.join(dest, 'extra.xlsx'));
  assert.equal(mixed.code, 2);
  assert.match(mixed.json.errors[0].message, /inside input\/test-cases\/ but is not Markdown/);
});

test('numbering that restarts on every sheet gets sheet-prefixed IDs, so every case has its own valid ID and file', (t) => {
  const { root, outside, dest } = project(t);
  const sheet = (n: string) => ({ name: n, rows: [['S. No.', 'Module', 'Scenarios', 'Test Steps', 'Expected Result'], ['TC001', n, `Open ${n}`, 'Open the page', 'The page is shown'], ['TC002', n, `Close ${n}`, 'Close the page', 'The page is closed']] });
  const book = writeXlsx(outside, 'restart.xlsx', [sheet('Admin'), sheet('Target Block')]);
  const r = must(root, 'input', 'import', '--from', book);
  assert.deepEqual(r.counts, { total: 4, valid: 4, warning: 0, needsClarification: 0, invalid: 0, ready: 4 });
  assert.deepEqual(r.files.map((f: any) => f.id), ['ADMIN-TC001', 'ADMIN-TC002', 'TARGET-BLOCK-TC001', 'TARGET-BLOCK-TC002']);
  assert.deepEqual(readdirSync(dest).sort(), ['ADMIN-TC001.md', 'ADMIN-TC002.md', 'TARGET-BLOCK-TC001.md', 'TARGET-BLOCK-TC002.md']);
  assert.match(readFileSync(path.join(dest, 'TARGET-BLOCK-TC002.md'), 'utf8'), /^# Target Block\n\n## TARGET-BLOCK-TC002: Close Target Block/);
  assert.equal(must(root, 'input', 'inspect', '--path', 'input/test-cases').ok, true);
});

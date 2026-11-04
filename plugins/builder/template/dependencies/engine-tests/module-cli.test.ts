// The module-by-module flow through the real CLI: inspect/map the user's layout, parse into modules, plan one file per
// module, and validate that generation kept to it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_HEADER } from '../engine/pipeline/generation.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile, writeXlsx } from './helpers.ts';

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

function project(t: { after: (fn: () => void) => void }) {
  const root = tmpRoot(t);
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(validConfig())));
  // Their own column names, one sheet per module, and a password in the data column.
  writeXlsx(dependenciesDir(root), 'input/test-cases/regression.xlsx', [
    { name: 'Login', rows: [['Code', 'Scenario', 'Procedure', 'Expected Outcome', 'Test Data'], ['LOG-1', 'Valid sign in', 'Open the login page', 'The login page is shown', 'password: Sup3r-secret']] },
    { name: 'Create Project', rows: [['Code', 'Scenario', 'Procedure', 'Expected Outcome'], ['PRJ-1', 'Create a project', 'Click "New project"', 'The project form opens']] },
  ]);
  return root;
}

test('inspect shows how the workbook is read, map fixes what it could not, and nothing leaks a cell value', (t) => {
  const root = project(t);
  const first = must(root, 'input', 'inspect', '--path', 'input/test-cases');
  assert.deepEqual(first.tables.map((x: any) => x.ignoredColumns), [['Code'], ['Code']], 'a column the engine does not know is reported, not silently dropped');

  for (const sheet of ['Login', 'Create Project']) {
    must(root, 'input', 'map', 'input/test-cases/regression.xlsx', '--sheet', sheet, '--column', 'id=Code', '--column', 'title=Scenario');
  }
  const ok = must(root, 'input', 'inspect', '--path', 'input/test-cases');
  assert.deepEqual(ok.modules.map((m: any) => [m.module, m.cases]), [['Login', 1], ['Create Project', 1]]);
  assert.ok(!JSON.stringify(ok).includes('Sup3r-secret'));
  assert.ok(existsSync(path.join(dependenciesDir(root), 'state', 'input-mapping.json')));

  const refused = cli(root, 'input', 'map', 'input/test-cases/regression.xlsx', '--sheet', 'Login', '--column', 'steps=No such header');
  assert.equal(refused.code, 2);
  assert.match(refused.json.message, /not saved: mapped column "No such header"/);
});

test('specs parse groups by module, writes the normalized Markdown and keeps the password out of it', (t) => {
  const root = project(t);
  for (const sheet of ['Login', 'Create Project']) {
    must(root, 'input', 'map', 'input/test-cases/regression.xlsx', '--sheet', sheet, '--column', 'id=Code', '--column', 'title=Scenario');
  }
  const runId: string = must(root, 'run', 'create', '--command', 'generate-tests').runId;
  for (const [stage, status] of [['preflight', 'running'], ['preflight', 'completed'], ['configuration', 'running']]) must(root, 'run', 'stage', runId, stage!, status!);
  must(root, 'run', 'set-config', runId);
  const parse = must(root, 'specs', 'parse', runId);
  assert.deepEqual(parse.modules.map((m: any) => [m.moduleSlug, m.cases, m.ready, m.normalizedFile]), [
    ['login', 1, 1, 'normalized-input/login.md'],
    ['create-project', 1, 1, 'normalized-input/create-project.md'],
  ]);
  assert.deepEqual(parse.tables.map((x: any) => [x.sheet, x.status, x.moduleFrom]), [['Login', 'ok', 'sheet'], ['Create Project', 'ok', 'sheet']]);
  const md = readFileSync(path.join(dependenciesDir(root), 'runs', runId, 'normalized-input', 'login.md'), 'utf8');
  assert.ok(!md.includes('Sup3r-secret'));
  assert.match(md, /- password: env:TEST_PASSWORD/);

  const plan = must(root, 'specs', 'modules', runId);
  assert.deepEqual(plan.modules.map((m: any) => [m.moduleSlug, m.file, m.ready]), [
    ['login', 'tests/login.spec.ts', ['LOG-1']],
    ['create-project', 'tests/create-project.spec.ts', ['PRJ-1']],
  ]);

  // Generation puts both modules in one file: refused, with the reason.
  const body = (id: string, title: string) => `test('[${id}] ${title}', async () => {});\n`;
  writeFile(root, 'tests/everything.spec.ts', `${GENERATED_HEADER}\n${body('LOG-1', 'Valid sign in')}${body('PRJ-1', 'Create a project')}`);
  const manifest = (files: [string, string][]) => JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-10-20T00:00:00Z', language: 'typescript', sharedFilesChanged: [], excluded: [],
    tests: files.map(([id, file]) => ({ testId: id, file, title: `[${id}] x` })),
  });
  writeDep(root, `runs/${runId}/generation-report.md`, '# report\n');
  writeDep(root, `runs/${runId}/generation-manifest.json`, manifest([['LOG-1', 'tests/everything.spec.ts'], ['PRJ-1', 'tests/everything.spec.ts']]));
  const mixed = cli(root, 'generate', 'validate', runId);
  assert.equal(mixed.code, 2);
  assert.match(mixed.json.issues.join('\n'), /"tests\/everything\.spec\.ts" mixes tests from 2 modules \(login, create-project\)/);

  // One file per module, named as the plan says: accepted.
  writeFile(root, 'tests/login.spec.ts', `${GENERATED_HEADER}\n${body('LOG-1', 'Valid sign in')}`);
  writeFile(root, 'tests/create-project.spec.ts', `${GENERATED_HEADER}\n${body('PRJ-1', 'Create a project')}`);
  writeDep(root, `runs/${runId}/generation-manifest.json`, manifest([['LOG-1', 'tests/login.spec.ts'], ['PRJ-1', 'tests/create-project.spec.ts']]));
  must(root, 'generate', 'validate', runId);
});

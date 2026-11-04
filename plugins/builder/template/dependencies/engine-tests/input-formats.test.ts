import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GENERATED_HEADER, moduleLayoutIssues } from '../engine/pipeline/generation.ts';
import { applyMapping, inspectInput } from '../engine/pipeline/input-inspect.ts';
import { emptyMappings, loadMappings } from '../engine/pipeline/input-table.ts';
import { planModules, writeNormalizedInput } from '../engine/pipeline/modules.ts';
import { listInputFiles, parseInputs } from '../engine/pipeline/test-case-parser.ts';
import { slugify, validateTestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { readXlsx } from '../engine/utils/xlsx.ts';
import { buildXlsx, tmpRoot, writeDep, writeFile, writeXlsx } from './helpers.ts';

function parseAll(root: string, input = 'input/test-cases') {
  const base = dependenciesDir(root);
  return parseInputs(base, listInputFiles(base, input), new Date('2026-10-20T00:00:00Z'));
}

// A workbook as a team would actually keep it: a cover sheet, a title block above the headers, their own column names,
// an ID repeated on every step row, and columns the pipeline has no use for.
function teamWorkbook(root: string): void {
  writeXlsx(dependenciesDir(root), 'input/test-cases/release-1.xlsx', [
    { name: 'Cover', rows: [['Project X regression pack'], ['Version 1.4']] },
    {
      name: 'Login',
      rows: [
        ['Login module - test cases'],
        ['S.No', 'TC No', 'Scenario', 'Procedure', 'Expected Outcome', 'Actual Result', 'Status'],
        ['1', 'LOG-01', 'Valid user signs in', '1. Open the login page\n2. Click "Sign in"', 'The login page is shown\nThe dashboard is shown', null, 'Pass'],
        ['2', 'LOG-02', 'Wrong password is rejected', 'Click "Sign in" with a wrong password', 'The error "Invalid credentials" is shown', null, 'Fail'],
      ],
    },
    {
      name: 'Create Project',
      rows: [
        ['Test ID', 'Test Name', 'Test Steps', 'Expected Result', 'Priority'],
        ['PRJ-01', 'Create a project', 'Click "New project"', 'The project form opens', 'High'],
        ['PRJ-01', 'Create a project', 'Enter a name and save', 'The project appears in the list', 'High'],
        ['PRJ-02', 'Name is required', 'Save with an empty name', 'The error "Name is required" is shown', 'Medium'],
      ],
    },
  ]);
}

test('an Excel workbook in the team’s own layout normalizes into per-module specs', (t) => {
  const root = tmpRoot(t);
  teamWorkbook(root);
  const { document, errors, tables } = parseAll(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(validateTestSpecDocument(document), []);
  assert.deepEqual(document.sources.map((s) => s.format), ['xlsx']);
  assert.deepEqual(document.specs.map((s) => [s.id, s.module, s.moduleSlug]), [
    ['LOG-01', 'Login', 'login'],
    ['LOG-02', 'Login', 'login'],
    ['PRJ-01', 'Create Project', 'create-project'],
    ['PRJ-02', 'Create Project', 'create-project'],
  ]);
  for (const s of document.specs) assert.equal(s.status, 'ready', `${s.id}: ${JSON.stringify(s.ambiguities)}`);

  const [log1, , prj1] = document.specs;
  assert.deepEqual(log1!.source, { path: 'input/test-cases/release-1.xlsx', line: 3, originalId: 'LOG-01', sheet: 'Login' });
  assert.deepEqual(log1!.steps.map((s) => [s.action, s.expected]), [
    ['Open the login page', 'The login page is shown'],
    ['Click "Sign in"', 'The dashboard is shown'],
  ]);
  assert.equal(prj1!.steps.length, 2, 'rows repeating the ID continue the case instead of starting a duplicate');
  assert.equal(prj1!.priority, 'High');

  const login = tables.find((x) => x.sheet === 'Login')!;
  assert.equal(login.headerLine, 2, 'the title block above the headers is skipped');
  assert.deepEqual(login.mapped, { id: 'TC No', title: 'Scenario', steps: 'Procedure', expected: 'Expected Outcome' });
  assert.deepEqual(login.ignoredColumns, ['S.No', 'Actual Result', 'Status'], 'unmapped columns are reported, not dropped silently');
  assert.equal(login.moduleFrom, 'sheet');
  const cover = tables.find((x) => x.sheet === 'Cover')!;
  assert.equal(cover.status, 'skipped');
});

test('a module column wins over the sheet name, and an empty cell inherits the module above', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/all.csv', [
    'Feature,TC ID,Test Case,Steps,Expected Result',
    'Login,TC-1,Sign in,Open login,Login is shown',
    ',TC-2,Sign out,Click sign out,Login is shown',
    'Create Project,TC-3,Create,Click new,Form opens',
  ].join('\n'));
  const { document, tables } = parseAll(root);
  assert.deepEqual(document.specs.map((s) => [s.id, s.module]), [['TC-1', 'Login'], ['TC-2', 'Login'], ['TC-3', 'Create Project']]);
  assert.equal(tables[0]!.moduleFrom, 'column');
});

test('without a module column, sheet or heading the file name is the module', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/User Profile.csv', 'ID,Title,Steps,Expected\nUP-1,Edit name,Click edit,Name field opens\n');
  writeDep(root, 'input/test-cases/checkout_flow.md', '## CF-1: Pay\n### Steps\n1. Click pay -> Expected: Receipt shown\n');
  writeXlsx(dependenciesDir(root), 'input/test-cases/search.xlsx', [{ name: 'Sheet1', rows: [['ID', 'Title', 'Steps', 'Expected'], ['SE-1', 'Find', 'Type a word', 'Results are shown']] }]);
  const { document } = parseAll(root);
  assert.deepEqual(document.specs.map((s) => [s.id, s.module, s.moduleSlug]).sort(), [
    ['CF-1', 'checkout_flow', 'checkout-flow'],
    ['SE-1', 'search', 'search'],
    ['UP-1', 'User Profile', 'user-profile'],
  ]);
});

test('a Markdown "# heading" is the module, and several headings in one file make several modules', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/mixed.md', [
    '# Login', '## L-1: Sign in', '### Steps', '1. Open -> Expected: Shown',
    '# Create Project', '## P-1: Create', '### Steps', '1. Click new -> Expected: Form opens',
  ].join('\n'));
  const { document } = parseAll(root);
  assert.deepEqual(document.specs.map((s) => s.moduleSlug), ['login', 'create-project']);
});

test('a layout the built-in names do not cover is reported, then fixed with a saved mapping', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeDep(root, 'input/test-cases/odd.csv', 'Ref,What to check,How,Result should be\nX-1,Greeting,Open the home page,A greeting is shown\n');

  const before = parseAll(root);
  assert.equal(before.document.specs.length, 0);
  assert.match(before.errors[0]!.message, /no steps or expected-result column recognised.*"Ref", "What to check", "How", "Result should be".*input map/s);

  const bad = applyMapping(base, root, emptyMappings(), { file: 'input/test-cases/odd.csv', sheet: null, columns: ['steps=Nope'], skip: false, clear: false });
  assert.equal(bad.ok, false, 'a header that is not in the file is refused, and nothing is saved');
  assert.deepEqual(loadMappings(root), emptyMappings());

  const mapped = applyMapping(base, root, emptyMappings(), {
    file: 'input/test-cases/odd.csv', sheet: null, columns: ['id=Ref', 'title=What to check', 'steps=How', 'expected=Result should be'], skip: false, clear: false,
  });
  assert.equal(mapped.ok, true);
  const after = parseInputs(base, listInputFiles(base, 'input/test-cases'), new Date(), loadMappings(root));
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.document.specs.map((s) => [s.id, s.title, s.steps[0]!.expected]), [['X-1', 'Greeting', 'A greeting is shown']]);

  const cleared = applyMapping(base, root, loadMappings(root), { file: 'input/test-cases/odd.csv', sheet: null, columns: [], skip: false, clear: true });
  assert.equal(cleared.ok, true);
  assert.deepEqual(loadMappings(root), emptyMappings());
});

test('a saved mapping can fix the header row, name the module and skip a sheet', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeXlsx(base, 'input/test-cases/pack.xlsx', [
    { name: 'Notes', rows: [['Steps to follow when updating this file'], ['Expected turnaround: 2 days']] },
    { name: 'Cases', rows: [['ID', 'Title', 'Steps', 'Expected Result'], ['C-1', 'One', 'Do it', 'It is done']] },
  ]);
  // "Notes" mentions steps/expected only in prose, so the engine skips it by itself; skipping it explicitly is also accepted.
  const first = inspectInput(base, 'input/test-cases', emptyMappings());
  assert.equal(first.ok, true);
  assert.deepEqual(first.modules.map((m) => m.module), ['pack'], 'the generic sheet name "Cases" is not a better module than the file name');
  const named = applyMapping(base, root, emptyMappings(), { file: 'input/test-cases/pack.xlsx', sheet: 'Cases', columns: [], module: 'Billing', skip: false, clear: false });
  assert.equal(named.ok, true);
  const skipped = applyMapping(base, root, loadMappings(root), { file: 'input/test-cases/pack.xlsx', sheet: 'Notes', columns: [], skip: true, clear: false });
  assert.equal(skipped.ok, true);
  const after = inspectInput(base, 'input/test-cases', loadMappings(root));
  assert.deepEqual(after.modules.map((m) => m.module), ['Billing']);
  assert.equal(after.tables.find((x) => x.sheet === 'Notes')!.reason, 'skipped by the saved input mapping');
});

test('inspect output carries headers and counts but never cell values', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/secret.csv', 'ID,Title,Steps,Expected,Test Data\nS-1,Sign in,Type it,Welcome,password: hunter2-very-secret\n');
  const out = JSON.stringify(inspectInput(dependenciesDir(root), 'input/test-cases', emptyMappings()));
  assert.ok(!out.includes('hunter2'), 'no cell value leaks into the inspection');
});

test('files the engine cannot read say what to do instead; corrupt workbooks fail clearly', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/legacy.xls', 'binary');
  writeDep(root, 'input/test-cases/broken.xlsx', 'not a zip');
  writeDep(root, 'input/test-cases/notes.txt', 'ignored');
  const { errors, unsupported } = parseAll(root);
  assert.deepEqual(unsupported, ['input/test-cases/legacy.xls', 'input/test-cases/notes.txt']);
  assert.match(errors.find((e) => e.path.endsWith('legacy.xls'))!.message, /save as \.xlsx/);
  assert.match(errors.find((e) => e.path.endsWith('notes.txt'))!.message, /unsupported file type "\.txt".*\.md, \.csv, \.xlsx/);
  assert.match(errors.find((e) => e.path.endsWith('broken.xlsx'))!.message, /not a valid \.xlsx/);
});

test('xlsx reader: entities, multi-line cells, sparse columns and sheet order', () => {
  const sheets = readXlsx(buildXlsx([
    { name: 'A & B', rows: [['x < y', 'line1\nline2', null, 'after gap']] },
    { name: 'Second', rows: [[null, 'only second column']] },
  ]));
  assert.deepEqual(sheets.map((s) => s.name), ['A & B', 'Second']);
  assert.deepEqual(sheets[0]!.rows[0]!.cells, ['x < y', 'line1\nline2', '', 'after gap']);
  assert.deepEqual(sheets[1]!.rows[0]!.cells, ['', 'only second column']);
});

test('the normalized Markdown is the same cases in the pipeline format, with no secrets, and parses back identically', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeXlsx(base, 'input/test-cases/pack.xlsx', [{
    name: 'Login',
    rows: [
      ['TC ID', 'Scenario', 'Test Data', 'Test Steps', 'Expected Result', 'Priority', 'Tags'],
      ['L-1', 'Valid sign in', 'email: qa.user@example.com\npassword: s3cret-pass\nplan: Premium', 'Enter {email} in Email\nEnter {password} in Password\nClick "Sign in"', 'Email accepted\nPassword accepted\nThe dashboard is shown', 'High', 'smoke, auth'],
    ],
  }]);
  const { document } = parseAll(root);
  const dir = path.join(base, 'normalized');
  const written = writeNormalizedInput(dir, document);
  assert.deepEqual(written.map((w) => w.file), ['login.md']);
  const md = readFileSync(path.join(dir, 'login.md'), 'utf8');
  assert.ok(!md.includes('s3cret-pass') && !md.includes('qa.user@example.com'), 'credentials stay in .env, never in the normalized file');
  assert.match(md, /^# Login\n/);
  assert.match(md, /- email: env:TEST_EMAIL/);

  const again = parseInputs(base, [path.join(dir, 'login.md')]).document.specs;
  const strip = (specs: typeof document.specs) => specs.map((s) => ({ id: s.id, title: s.title, module: s.module, priority: s.priority, tags: s.tags, steps: s.steps, expectedResults: s.expectedResults, testData: s.testData, status: s.status }));
  assert.deepEqual(strip(again), strip(document.specs));
});

test('module plan: one file per module, never over a handwritten test', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/m.md', [
    '# Login', '## L-1: A', '### Steps', '1. x -> Expected: y',
    '# Create Project', '## P-1: B', '### Steps', '1. x -> Expected: y', '## P-2: C', '### Steps', '1. x',
    '# Reports', '## R-1: D', '### Steps', '1. x -> Expected: y',
  ].join('\n'));
  writeFile(root, 'tests/login.spec.ts', "import { test } from '@playwright/test';\ntest('hand', async () => {});\n");
  writeFile(root, 'tests/reports.spec.ts', `${GENERATED_HEADER}\n`);
  const { document } = parseAll(root);
  const plan = planModules(document, 'typescript', root);
  assert.deepEqual(plan.map((m) => [m.moduleSlug, m.file, m.fileState]), [
    ['login', 'tests/login.generated.spec.ts', 'handwritten-renamed'],
    ['create-project', 'tests/create-project.spec.ts', 'new'],
    ['reports', 'tests/reports.spec.ts', 'pipeline-owned'],
  ]);
  const projects = plan.find((m) => m.moduleSlug === 'create-project')!;
  assert.deepEqual(projects.ready, ['P-1']);
  assert.deepEqual(projects.needsClarification, ['P-2']);
  assert.equal(planModules(document, 'javascript', root)[1]!.file, 'tests/create-project.spec.js');
});

test('generation must keep every module in its own single file', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/m.md', [
    '# Login', '## L-1: A', '### Steps', '1. x -> Expected: y', '## L-2: A2', '### Steps', '1. x -> Expected: y',
    '# Reports', '## R-1: D', '### Steps', '1. x -> Expected: y',
  ].join('\n'));
  const { document } = parseAll(root);
  const entry = (testId: string, file: string) => ({ testId, file });
  assert.deepEqual(moduleLayoutIssues([entry('L-1', 'tests/login.spec.ts'), entry('L-2', 'tests/login.spec.ts'), entry('R-1', 'tests/reports.spec.ts')], document), []);
  const mixed = moduleLayoutIssues([entry('L-1', 'tests/all.spec.ts'), entry('L-2', 'tests/all.spec.ts'), entry('R-1', 'tests/all.spec.ts')], document);
  assert.match(mixed[0]!, /"tests\/all\.spec\.ts" mixes tests from 2 modules \(login, reports\)/);
  const split = moduleLayoutIssues([entry('L-1', 'tests/login-a.spec.ts'), entry('L-2', 'tests/login-b.spec.ts'), entry('R-1', 'tests/reports.spec.ts')], document);
  assert.match(split[0]!, /module "login" is split over 2 files/);
});

test('module slugs are stable file names', () => {
  assert.equal(slugify('Create Project'), 'create-project');
  assert.equal(slugify('  Login / Sign-in (SSO) '), 'login-sign-in-sso');
  assert.equal(slugify('Café Ünïcode'), 'cafe-unicode');
  assert.equal(slugify('!!!'), 'general');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});

// Test-case sheets often carry module headings as single-cell rows between the cases ("Login", then its cases, then "Search").
test('heading rows inside a table name the modules; they are not cases, and an ID-shaped lone cell still is one', (t) => {
  const root = tmpRoot(t);
  const base = dependenciesDir(root);
  writeXlsx(base, 'input/test-cases/pack.xlsx', [{
    name: 'Testcases',
    rows: [
      ['Test Case ID', 'Test Case Title', 'Test Steps', 'Expected Result'],
      ['Login'],
      ['TC-1', 'Login - valid user', 'Open the page', 'The page is shown'],
      ['TC-2', 'Login - wrong password', 'Open the page', 'The error is shown'],
      ['Search functionality'],
      ['TC-3', 'Search - basic', 'Type a word', 'Results are shown'],
      ['TC-9'],
    ],
  }]);
  const first = parseAll(root);
  assert.deepEqual(first.document.specs.map((s) => [s.id, s.module, s.status]), [
    ['TC-1', 'Login', 'ready'], ['TC-2', 'Login', 'ready'], ['TC-3', 'Search functionality', 'ready'], ['TC-9', 'Search functionality', 'needs_clarification'],
  ]);
  const table = first.tables[0]!;
  assert.equal(table.moduleFrom, 'section');
  assert.deepEqual(table.sections, ['Login', 'Search functionality']);
  assert.deepEqual(table.titlePrefixes, [{ prefix: 'Login', cases: 2 }, { prefix: 'Search', cases: 1 }]);

  // The user may prefer the "<prefix> - " part of each title as the module.
  const mapped = applyMapping(base, root, emptyMappings(), { file: 'input/test-cases/pack.xlsx', sheet: 'Testcases', columns: [], moduleFrom: 'title-prefix', skip: false, clear: false });
  assert.equal(mapped.ok, true);
  const again = parseInputs(base, listInputFiles(base, 'input/test-cases'), new Date(), loadMappings(root));
  assert.deepEqual(again.document.specs.map((s) => [s.id, s.module]), [['TC-1', 'Login'], ['TC-2', 'Login'], ['TC-3', 'Search'], ['TC-9', 'Search functionality']]);
  assert.equal(applyMapping(base, root, loadMappings(root), { file: 'input/test-cases/pack.xlsx', sheet: 'Testcases', columns: [], moduleFrom: 'nonsense', skip: false, clear: false }).ok, false);
});

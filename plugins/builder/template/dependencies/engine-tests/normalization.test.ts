// Test-case normalization: Markdown, CSV and Excel in any supported layout become one canonical, versioned, validated document,
// and nothing downstream reads the original files. Covers the three formats and their equivalence, unfamiliar and ambiguous
// headers, multi-case / multi-row input, missing information, malformed input, traceability, metadata, strict file types, and
// the gate that keeps cases which are not valid away from generation.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_SCHEMA_VERSION, canonicalHash, checkSpecsAgainstCanonical, projectSpecs, validateCanonicalDocument,
  type CanonicalCase, type CanonicalDocument,
} from '../engine/pipeline/canonical.ts';
import { applyMapping, inspectInput } from '../engine/pipeline/input-inspect.ts';
import { emptyMappings, loadMappings } from '../engine/pipeline/input-table.ts';
import { listInputFiles, parseInputs, parseMarkdown } from '../engine/pipeline/test-case-parser.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile, writeXlsx } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const NOW = new Date('2026-10-21T00:00:00Z');

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

// The message of a failed CLI call (it prints {ok:false, kind, message} on stderr).
const failure = (r: { stderr: string }): string => {
  try { return (JSON.parse(r.stderr) as { message: string }).message; } catch { return r.stderr; }
};

function normalize(root: string, input = 'input/test-cases', mappings = emptyMappings()) {
  const base = dependenciesDir(root);
  return parseInputs(base, listInputFiles(base, input), NOW, mappings);
}

// What two inputs must agree on to be "the same test cases": everything except where they were read from.
function essence(c: CanonicalCase) {
  const { source: _source, metadata: _metadata, suite: _suite, ...rest } = c;
  return rest;
}

// ---------- the three formats, one canonical result ----------

const MARKDOWN = `# Login

## LG-1: Valid sign in
Priority: High
Tags: smoke, auth
### Preconditions
- A registered user exists
### Steps
1. Open the login page
2. Click "Sign in"
### Expected Results
- The dashboard is shown

## LG-2: Wrong password
Priority: Medium
Tags: auth
### Preconditions
- A registered user exists
### Steps
1. Click "Sign in" with a wrong password -> Expected: The error "Invalid credentials" is shown
`;

const MARKDOWN_TABLE = `# Login

| Test ID | Scenario | Pre-requisites | Procedure | Expected Outcome | Priority | Tags |
|---|---|---|---|---|---|---|
| LG-1 | Valid sign in | A registered user exists | 1. Open the login page<br>2. Click "Sign in" | The dashboard is shown | High | smoke, auth |
| LG-2 | Wrong password | A registered user exists | Click "Sign in" with a wrong password | The error "Invalid credentials" is shown | Medium | auth |
`;

const CSV = `Module,Case No,Title,Preconditions,Steps,Expected Result,Priority,Labels
Login,LG-1,Valid sign in,A registered user exists,"1. Open the login page
2. Click ""Sign in""",The dashboard is shown,High,"smoke, auth"
Login,LG-2,Wrong password,A registered user exists,"Click ""Sign in"" with a wrong password","The error ""Invalid credentials"" is shown",Medium,auth
`;

const XLSX_ROWS = [
  ['Feature', 'Ref', 'Name', 'Prerequisites', 'Test Procedure', 'Expected Behaviour', 'Prio', 'Keywords'],
  ['Login', 'LG-1', 'Valid sign in', 'A registered user exists', '1. Open the login page\n2. Click "Sign in"', 'The dashboard is shown', 'High', 'smoke, auth'],
  ['Login', 'LG-2', 'Wrong password', 'A registered user exists', 'Click "Sign in" with a wrong password', 'The error "Invalid credentials" is shown', 'Medium', 'auth'],
];

test('equivalent test cases in Markdown, a Markdown table, CSV and Excel normalize to the same canonical cases', (t) => {
  const root = tmpRoot(t);
  const layouts = {
    markdown: 'sections.md', markdownTable: 'table.md', csv: 'cases.csv', xlsx: 'cases.xlsx',
  } as const;
  writeDep(root, `in/md/${layouts.markdown}`, MARKDOWN);
  writeDep(root, `in/mdtable/${layouts.markdownTable}`, MARKDOWN_TABLE);
  writeDep(root, `in/csv/${layouts.csv}`, CSV);
  writeXlsx(dependenciesDir(root), `in/xlsx/${layouts.xlsx}`, [{ name: 'Sheet1', rows: XLSX_ROWS }]);

  const results = Object.fromEntries(['md', 'mdtable', 'csv', 'xlsx'].map((k) => [k, normalize(root, `in/${k}`)]));
  for (const [k, r] of Object.entries(results)) {
    assert.deepEqual(r.errors, [], k);
    assert.deepEqual(validateCanonicalDocument(r.canonical), [], k);
    assert.equal(r.canonical.schemaVersion, CANONICAL_SCHEMA_VERSION);
    assert.deepEqual(r.canonical.validation.counts, { valid: 2, warning: 0, needs_clarification: 0, invalid: 0 }, k);
  }
  const baseline = results.md!.canonical.testCases.map(essence);
  assert.equal(baseline.length, 2);
  assert.deepEqual(baseline[0]!.steps, [{ stepNumber: 1, action: 'Open the login page' }, { stepNumber: 2, action: 'Click "Sign in"' }]);
  assert.deepEqual(baseline[1]!.steps, [{ stepNumber: 1, action: 'Click "Sign in" with a wrong password', expectedResult: 'The error "Invalid credentials" is shown' }]);
  for (const k of ['mdtable', 'csv', 'xlsx']) {
    assert.deepEqual(results[k]!.canonical.testCases.map(essence), baseline, `${k} differs from the Markdown form`);
  }
  // ... while each keeps its own place of origin.
  assert.deepEqual(results.xlsx!.canonical.testCases.map((c) => [c.source.format, c.source.sheet, c.source.row]), [['xlsx', 'Sheet1', 2], ['xlsx', 'Sheet1', 3]]);
  assert.deepEqual(results.csv!.canonical.testCases.map((c) => [c.source.format, c.source.row]), [['csv', 2], ['csv', 4]]);
  assert.deepEqual(results.md!.canonical.testCases.map((c) => [c.source.format, c.source.line]), [['markdown', 3], ['markdown', 14]]);
  assert.deepEqual(results.mdtable!.canonical.testCases.map((c) => [c.source.format, c.source.line, c.source.row]), [['markdown', 5, null], ['markdown', 6, null]]);
});

test('the canonical document has the documented shape and test-specs.json is exactly its projection', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/a.md', MARKDOWN);
  const r = normalize(root);
  const c = r.canonical.testCases[0]!;
  assert.deepEqual(Object.keys(c).sort(), [
    'expectedResults', 'metadata', 'module', 'moduleSlug', 'preconditions', 'priority', 'schemaVersion', 'source', 'steps', 'suite', 'tags',
    'testCaseId', 'testData', 'title', 'validation',
  ]);
  assert.equal(c.schemaVersion, '1.0.0');
  assert.equal(c.testCaseId, 'LG-1');
  assert.deepEqual(Object.keys(c.source).sort(), ['endLine', 'endRow', 'file', 'fileName', 'format', 'heading', 'line', 'originalId', 'row', 'sheet']);
  assert.equal(c.source.fileName, 'a.md');
  assert.deepEqual(r.document, projectSpecs(r.canonical));
  assert.deepEqual(checkSpecsAgainstCanonical(r.canonical, r.document), []);
  // The hash ignores the timestamp, so normalizing the same input again gives the same hash.
  assert.equal(canonicalHash(normalize(root).canonical), canonicalHash({ ...r.canonical, generatedAt: '2030-01-01T00:00:00Z' }));
});

// ---------- structure inferred, or asked about ----------

test('unfamiliar headers are read from what the columns hold, reported as inferred, and keep the rest as metadata', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/odd.csv', [
    'Ref,What we test,How,Should see,Owner',
    'LG-1,Valid login,"1. Open the login page\n2. Click Sign in",The dashboard is shown,Ann',
    'LG-2,Wrong password,Click Sign in with a wrong password,The error is shown,Bob',
    'LG-3,Locked account,Enter a locked account then click Sign in,The locked message is displayed,Cy',
  ].join('\n') + '\n');
  const r = normalize(root);
  assert.deepEqual(r.errors, []);
  const table = r.tables[0]!;
  assert.deepEqual(table.inferred.map((s) => [s.field, s.header]), [['steps', 'How'], ['expected', 'Should see']]);
  assert.ok(table.inferred.every((s) => s.confidence >= 0.9));
  assert.deepEqual(table.suggestions.map((s) => [s.field, s.header]), [['title', 'What we test']], 'a title is proposed, never applied from content alone');
  assert.deepEqual(r.canonical.testCases.map((c) => c.validation.status), ['valid', 'valid', 'valid']);
  assert.equal(r.canonical.validation.status, 'warning', 'reading by content is a non-blocking finding');
  assert.equal(r.canonical.validation.findings[0]!.kind, 'inferred_columns');
  assert.match(r.canonical.validation.findings[0]!.message, /Also possible, not applied: title="What we test"/);
  const first = r.canonical.testCases[0]!;
  assert.deepEqual(first.steps.map((s) => s.action), ['Open the login page', 'Click Sign in']);
  assert.deepEqual(first.metadata, { 'What we test': 'Valid login', Owner: 'Ann' }, 'unmapped columns are kept, not dropped');
});

test('a layout that cannot be read confidently is a question, not a guess; the answer is saved and reused', (t) => {
  const root = tmpRoot(t);
  // Nothing in here reads as steps or as an outcome: the engine must not pick columns to get a pass.
  writeDep(root, 'input/test-cases/vague.csv', 'Code,Alpha,Beta\nV-1,foo,bar\nV-2,baz,qux\n');
  const r = normalize(root);
  assert.equal(r.canonical.testCases.length, 0);
  assert.equal(r.canonical.validation.status, 'invalid');
  assert.match(r.errors[0]!.message, /missing column\(s\)|no steps or expected-result column/);
  assert.match(r.errors[0]!.message, /input map/);
  assert.ok(!JSON.stringify(r).includes('foo'), 'no cell value in the report');

  const base = dependenciesDir(root);
  const saved = applyMapping(base, root, loadMappings(root), {
    file: 'input/test-cases/vague.csv', sheet: null, columns: ['id=Code', 'steps=Alpha', 'expected=Beta'], skip: false, clear: false,
  });
  assert.equal(saved.ok, true);
  const again = normalize(root, 'input/test-cases', loadMappings(root));
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.canonical.testCases.map((c) => [c.testCaseId, c.steps[0]!.action, c.expectedResults.length + (c.steps[0]!.expectedResult ? 1 : 0)]), [['V-1', 'foo', 1], ['V-2', 'baz', 1]]);
  assert.equal(inspectInput(base, 'input/test-cases', loadMappings(root)).ok, true);
});

test('two columns that fit a field equally well hold the cases back until a person says which one', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/two-steps.csv', 'ID,Title,Steps,Test Steps,Expected Result\nA-1,One,Do a,Do b,Shown\nA-2,Two,Do c,Do d,Shown\n');
  const r = normalize(root);
  assert.deepEqual(r.tables[0]!.ambiguous, [{ field: 'steps', headers: ['Steps', 'Test Steps'] }]);
  assert.deepEqual(r.canonical.testCases.map((c) => c.validation.status), ['needs_clarification', 'needs_clarification']);
  assert.deepEqual(r.canonical.testCases[0]!.validation.blocking.map((b) => b.code), ['ambiguous_column_mapping']);
  assert.equal(r.canonical.validation.findings[0]!.severity, 'blocking');
  assert.match(r.canonical.validation.findings[0]!.message, /which column is the steps\?.*input map/);
  assert.equal(inspectInput(dependenciesDir(root), 'input/test-cases', emptyMappings()).questions.length, 1);
  assert.equal(r.canonical.testCases[0]!.metadata['Test Steps'], 'Do b', 'the column that was not chosen is kept');

  applyMapping(dependenciesDir(root), root, loadMappings(root), { file: 'input/test-cases/two-steps.csv', sheet: null, columns: ['steps=Test Steps'], skip: false, clear: false });
  const answered = normalize(root, 'input/test-cases', loadMappings(root));
  assert.deepEqual(answered.canonical.testCases.map((c) => [c.validation.status, c.steps[0]!.action]), [['valid', 'Do b'], ['valid', 'Do d']]);
  assert.deepEqual(answered.canonical.validation.findings, []);
});

test('of two equally named columns, an empty one is not a rival, and a description does not outrank a title', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/ok.csv', 'ID,Test Case Title,Test Description,Steps,Test Steps,Expected Result\nA-1,One,Longer text,Do a,,Shown\n');
  const r = normalize(root);
  assert.deepEqual(r.tables[0]!.ambiguous, []);
  assert.equal(r.canonical.testCases[0]!.title, 'One');
  assert.equal(r.canonical.testCases[0]!.steps[0]!.action, 'Do a');
  assert.equal(r.canonical.testCases[0]!.metadata['Test Description'], 'Longer text');
});

// ---------- many cases, many rows, many sheets ----------

test('several sheets, several cases per sheet, and cases whose steps span rows keep their rows and their data', (t) => {
  const root = tmpRoot(t);
  writeXlsx(dependenciesDir(root), 'input/test-cases/book.xlsx', [
    { name: 'Cover', rows: [['Regression pack'], ['v1']] },
    {
      name: 'Cart',
      rows: [
        ['Test ID', 'Test Name', 'Test Steps', 'Test Data', 'Expected Result', 'Status'],
        ['CRT-1', 'Add item', 'Open the shop', 'item: apple', 'Shop is shown', 'Pass'],
        ['CRT-1', 'Add item', 'Add {item} to cart', null, 'Cart has the item', 'Pass'],
        [null, null, 'Open cart', 'qty: 2', 'Cart shows 2', null],
        ['CRT-2', 'Empty cart', 'Open cart', null, 'The cart is empty', 'Fail'],
      ],
    },
    { name: 'Checkout', rows: [['Test ID', 'Test Name', 'Test Steps', 'Expected Result'], ['CHK-1', 'Pay', 'Click Pay', 'Receipt is shown']] },
  ]);
  const r = normalize(root);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.canonical.testCases.map((c) => [c.testCaseId, c.module, c.steps.length]), [['CRT-1', 'Cart', 3], ['CRT-2', 'Cart', 1], ['CHK-1', 'Checkout', 1]]);
  const [crt1, crt2] = r.canonical.testCases;
  assert.deepEqual([crt1!.source.row, crt1!.source.endRow, crt1!.source.sheet], [2, 4, 'Cart']);
  assert.deepEqual([crt2!.source.row, crt2!.source.endRow], [5, 5]);
  assert.deepEqual(crt1!.steps[0]!.testData?.map((d) => d.name), ['item'], 'a step carries the data on its own row');
  assert.deepEqual(crt1!.steps[1]!.testData?.map((d) => d.name), ['item'], 'and the data its text refers to');
  assert.deepEqual(crt1!.steps[2]!.testData?.map((d) => [d.name, d.value]), [['qty', '2']]);
  assert.deepEqual(crt1!.testData.map((d) => d.name), ['item', 'qty']);
  assert.equal(crt1!.steps[1]!.expectedResult, 'Cart has the item');
  assert.deepEqual(crt1!.metadata, { Status: 'Pass' });
  assert.equal(crt2!.metadata.Status, 'Fail');
  assert.equal(r.tables.find((x) => x.sheet === 'Cover')!.status, 'skipped');
});

// ---------- validation statuses ----------

test('every case gets one explicit status, with blocking errors kept apart from warnings, and nothing is invented', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/mix.csv', [
    'ID,Title,Steps,Expected Result',
    ',,Click Orphan,Nothing is identified', // before any case: it cannot belong to one
    'M-1,Complete,Click Go,The page opens',
    'M-2,Vague,Click Go,It works correctly',
    'M-3,No expectation,Click Go,',
    'M-4,No steps,,The page opens',
  ].join('\n') + '\n');
  const r = normalize(root);
  const byId = Object.fromEntries(r.canonical.testCases.map((c) => [c.testCaseId, c]));
  assert.equal(byId['M-1']!.validation.status, 'valid');
  assert.equal(byId['M-2']!.validation.status, 'warning');
  assert.deepEqual(byId['M-2']!.validation.warnings.map((w) => w.code), ['vague_expected_result']);
  assert.deepEqual(byId['M-2']!.validation.blocking, []);
  assert.equal(byId['M-3']!.validation.status, 'needs_clarification');
  assert.deepEqual(byId['M-3']!.validation.blocking.map((b) => b.code), ['missing_expected_result']);
  assert.deepEqual(byId['M-3']!.expectedResults, [], 'a missing expected result is left empty, not written for the user');
  assert.equal(byId['M-4']!.validation.status, 'needs_clarification');
  const untitled = r.canonical.testCases.find((c) => c.validation.status === 'invalid')!;
  assert.deepEqual(untitled.validation.blocking.map((b) => b.code), ['untitled_case']);
  assert.deepEqual(r.canonical.validation.counts, { valid: 1, warning: 1, needs_clarification: 2, invalid: 1 });
  assert.equal(r.canonical.validation.status, 'invalid');
  assert.deepEqual(validateCanonicalDocument(r.canonical), []);

  // In test-specs.json only valid and warning cases are ready.
  const ready = r.document.specs.filter((s) => s.status === 'ready').map((s) => s.id);
  assert.deepEqual(ready, ['M-1', 'M-2']);
});

test('credentials in the data never reach the canonical document, and credential-like columns are redacted in metadata', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/secrets.csv', [
    'ID,Title,Steps,Expected Result,Test Data,Password,Notes',
    'S-1,Sign in,Type the password,Welcome,user password: hunter2-very-secret,another-secret-value,Ask qa.user@example.com first',
  ].join('\n') + '\n');
  const r = normalize(root);
  const json = JSON.stringify(r.canonical) + JSON.stringify(r.document);
  assert.ok(!json.includes('hunter2-very-secret'), 'test data value');
  assert.ok(!json.includes('another-secret-value'), 'value under a credential-like header');
  assert.ok(!json.includes('qa.user@example.com'), 'email address');
  assert.equal(r.canonical.testCases[0]!.metadata.Password, '[redacted]');
  assert.equal(r.canonical.testCases[0]!.metadata.Notes, 'Ask [redacted email] first');
  assert.equal(r.canonical.testCases[0]!.testData[0]!.envVar, 'TEST_USER_PASSWORD');
  assert.deepEqual(r.credentials.map((c) => c.envVar), ['TEST_USER_PASSWORD'], 'the value goes to .env through the caller only');
});

// ---------- malformed input ----------

test('malformed input is reported with the file and a way forward, and produces no trusted cases', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/quote.csv', 'ID,Title,Steps,Expected\nQ-1,"unterminated,Click,Shown\n');
  writeDep(root, 'input/test-cases/broken.xlsx', 'not a zip');
  writeDep(root, 'input/test-cases/empty.md', '# Just a title\n\nSome prose and no cases.\n');
  writeDep(root, 'input/test-cases/headers-only.csv', 'ID,Title,Steps,Expected\n');
  writeDep(root, 'input/test-cases/half.md', '| ID | Steps |\n|---|---|\n| H-1 | Click |\n');
  const r = normalize(root);
  const msg = (f: string) => r.errors.find((e) => e.path.endsWith(f))?.message ?? '';
  assert.match(msg('quote.csv'), /unterminated quoted field/);
  assert.match(msg('broken.xlsx'), /not a valid \.xlsx/);
  assert.match(msg('empty.md'), /no test cases found/);
  assert.match(msg('headers-only.csv'), /no data rows|no test-case table/);
  assert.match(msg('half.md'), /no expected result column recognised.*input map/s, 'a table of cases that cannot be read is an error, not silently dropped');
  assert.equal(r.canonical.testCases.length, 0);
  assert.equal(r.canonical.validation.status, 'invalid');
  assert.ok(validateCanonicalDocument(r.canonical).length > 0, 'such a document can never pass the stage contract');
});

// ---------- strict file types ----------

test('only .md, .csv and .xlsx are read; every other extension is rejected with what to do instead', (t) => {
  const root = tmpRoot(t);
  const cases: [string, RegExp][] = [
    ['cases.tsv', /save it as \.csv/], ['cases.markdown', /rename the file to \.md/], ['cases.xls', /save as \.xlsx/],
    ['cases.txt', /\.md file/], ['cases.docx', /Word document/], ['cases.json', /JSON/], ['cases.bin', /convert the test cases to one of these formats/],
  ];
  for (const [file, hint] of cases) {
    writeDep(root, `input/${file}`, 'x');
    const r = normalize(root, `input/${file}`);
    assert.equal(r.canonical.testCases.length, 0, file);
    assert.equal(r.canonical.validation.status, 'invalid', file);
    assert.deepEqual(r.unsupported, [`input/${file}`], file);
    const message = r.errors[0]!.message;
    assert.match(message, /^unsupported file type "\.\w+": test cases are read from \.md, \.csv, \.xlsx files only\. To fix: /, file);
    assert.match(message, hint, file);
  }
  // The same through the CLI, for a single file and for a folder holding a stray one.
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(validConfig())));
  const single = cli(root, 'input', 'import', '--from', path.join(dependenciesDir(root), 'input', 'cases.tsv'));
  assert.equal(single.code, 2);
  assert.match(JSON.stringify(single.json.errors), /unsupported file type \\"\.tsv\\"/);
  assert.deepEqual(single.json.files, [], 'nothing was written');
  writeDep(root, 'only/a.md', '## T-1: One\n### Steps\n1. Go -> Expected: Shown\n');
  writeDep(root, 'only/notes.txt', 'stray');
  const folder = cli(root, 'input', 'import', '--from', path.join(dependenciesDir(root), 'only'));
  assert.equal(folder.code, 2, 'a folder with a stray file is rejected as a whole, so nothing half-converted is written');
});

// ---------- Markdown variations ----------

test('Markdown: other labels, case headings at any depth, bare IDs with a Title line, step and data tables, metadata and notes', () => {
  const cases = parseMarkdown(`# Checkout

## Payment
### TC-10: Pay by card
**Pre-requisites:**
- A cart with one item
**Procedure:**
1. Open the cart
2. Click Pay
**Expected Outcome:**
- The receipt is shown
Jira: ABC-1

### TC-11
Title: Pay with a voucher
### Test Data
| Field | Value |
|---|---|
| voucher | literal:SAVE10 |
### Steps
| # | Action | Expected Result |
|---|---|---|
| 1 | Enter {voucher} | The discount is shown |
| 2 | Click Pay | The receipt is shown |
### Metadata
- Reviewed by: Dana
`);
  assert.deepEqual(cases.map((c) => [c.originalId, c.title, c.suite]), [['TC-10', 'Pay by card', 'Payment'], ['TC-11', 'Pay with a voucher', 'Payment']]);
  const [a, b] = cases;
  assert.deepEqual(a!.preconditions, ['A cart with one item']);
  assert.deepEqual(a!.steps.map((s) => s.action), ['Open the cart', 'Click Pay']);
  assert.deepEqual(a!.expectedResults, ['The receipt is shown']);
  assert.deepEqual(a!.metadata, { Jira: 'ABC-1' }, 'an unindented "Key: value" after a list is a new field, not more of the expected result');
  assert.deepEqual(b!.steps.map((s) => [s.action, s.expected]), [['Enter {voucher}', 'The discount is shown'], ['Click Pay', 'The receipt is shown']]);
  assert.deepEqual(b!.testData.map((d) => [d.name, d.value, d.declaredLiteral]), [['voucher', 'SAVE10', true]]);
  assert.deepEqual(b!.metadata, { 'Reviewed by': 'Dana' });
  assert.ok(a!.endLine > a!.line, 'the case spans its lines');
});

test('a Markdown case with a "Steps" table is not mistaken for a table of cases', () => {
  const [c] = parseMarkdown('## TC-1: Table steps\n### Steps\n| Step | Expected |\n|---|---|\n| Click Go | Shown |\n');
  assert.deepEqual(c!.steps.map((s) => [s.action, s.expected]), [['Click Go', 'Shown']]);
});

// ---------- the gate ----------

const CASES_WITH_INVALID = `ID,Title,Steps,Expected Result
,,Click Orphan,Not identified
G-1,Good one,Click Go,The page opens
G-2,No expectation,Click Go,
`;

function runUntilAnalysis(root: string): string {
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify({ ...validConfig(), language: 'javascript' })));
  const runId: string = must(root, 'run', 'create', '--command', 'playwright-pipeline').runId;
  const stage = (name: string, status: string, ...artifacts: string[]) => must(root, 'run', 'stage', runId, name, status, ...artifacts.flatMap((a) => ['--artifact', a]));
  stage('preflight', 'running'); stage('preflight', 'completed');
  stage('configuration', 'running'); must(root, 'run', 'set-config', runId); stage('configuration', 'completed');
  stage('input_validation', 'running'); must(root, 'input', 'validate', runId);
  stage('input_validation', 'completed', 'inputValidation=input-validation.json');
  stage('test_analysis', 'running');
  return runId;
}

test('only valid and warning cases reach generation; invalid and unclear ones are held back and listed', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/gate.csv', CASES_WITH_INVALID);
  const runId = runUntilAnalysis(root);
  const parse = must(root, 'specs', 'parse', runId);
  assert.deepEqual(parse.validation.counts, { valid: 1, warning: 0, needs_clarification: 1, invalid: 1 });
  assert.deepEqual(parse.needsClarification.map((n: any) => n.status).sort(), ['invalid', 'needs_clarification']);
  assert.equal(parse.needsClarification.find((n: any) => n.status === 'needs_clarification').id, 'G-2');
  assert.equal(parse.canonicalArtifact, 'canonical-test-cases.json');

  const runDir = path.join(dependenciesDir(root), 'runs', runId);
  const canonical: CanonicalDocument = JSON.parse(readFileSync(path.join(runDir, 'canonical-test-cases.json'), 'utf8'));
  assert.equal(canonical.testCases.length, 3);
  must(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'canonicalCases=canonical-test-cases.json', '--artifact', 'testSpecs=test-specs.json');

  const modules = must(root, 'specs', 'modules', runId).modules;
  assert.deepEqual(modules.map((m: any) => [m.ready, m.needsClarification.length]), [[['G-1'], 2]]);
  assert.deepEqual(must(root, 'specs', 'check', runId).notAutomatable.map((n: any) => n.status).sort(), ['invalid', 'needs_clarification']);
});

test('test-specs.json edited by hand, or without canonical test cases, stops the pipeline', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/gate.csv', CASES_WITH_INVALID);
  const runId = runUntilAnalysis(root);
  must(root, 'specs', 'parse', runId);
  const runDir = path.join(dependenciesDir(root), 'runs', runId);
  const specsFile = path.join(runDir, 'test-specs.json');
  const original = readFileSync(specsFile, 'utf8');

  // Marking a blocked case ready by hand: the hash no longer matches the canonical test cases.
  const doc = JSON.parse(original);
  doc.specs.find((s: any) => s.id === 'G-2').status = 'ready';
  doc.specs.find((s: any) => s.id === 'G-2').ambiguities = [];
  writeFileSync(specsFile, JSON.stringify(doc));
  const tampered = cli(root, 'specs', 'check', runId);
  assert.equal(tampered.code, 2);
  assert.match(JSON.stringify(tampered.json.issues), /differs from the canonical test cases/);
  const plan = cli(root, 'generate', 'plan', runId);
  assert.equal(plan.code, 2, 'generation is refused');
  assert.match(JSON.stringify(plan.json.issues), /canonical test cases/);
  const completing = cli(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'canonicalCases=canonical-test-cases.json', '--artifact', 'testSpecs=test-specs.json');
  assert.equal(completing.code, 1);
  assert.match(failure(completing), /differs from the canonical test cases|does not come from/);

  // A specs file with no link to the canonical document at all.
  const { canonical: _link, ...unlinked } = JSON.parse(original);
  writeFileSync(specsFile, JSON.stringify(unlinked));
  assert.match(JSON.stringify(cli(root, 'generate', 'plan', runId).json.issues), /hash mismatch/);

  // The stage cannot complete without the canonical artifact.
  writeFileSync(specsFile, original);
  const missing = cli(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'testSpecs=test-specs.json');
  assert.equal(missing.code, 1);
  assert.match(failure(missing), /required artifact "canonicalCases" is not registered/);
});

test('the stage cannot complete when no case is valid, or when the input changed after it was normalized', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/none.csv', 'ID,Title,Steps,Expected Result\nN-1,No expectation,Click Go,\n');
  const runId = runUntilAnalysis(root);
  const parse = cli(root, 'specs', 'parse', runId);
  assert.equal(parse.code, 2);
  const blocked = cli(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'canonicalCases=canonical-test-cases.json', '--artifact', 'testSpecs=test-specs.json');
  assert.match(failure(blocked), /no test case is valid/);

  writeDep(root, 'input/test-cases/none.csv', 'ID,Title,Steps,Expected Result\nN-1,Now complete,Click Go,Shown\n');
  const stale = cli(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'canonicalCases=canonical-test-cases.json', '--artifact', 'testSpecs=test-specs.json');
  assert.match(failure(stale), /changed \(or is gone\) since it was normalized: run "specs parse" again/);
  must(root, 'specs', 'parse', runId);
  must(root, 'run', 'stage', runId, 'test_analysis', 'completed', '--artifact', 'canonicalCases=canonical-test-cases.json', '--artifact', 'testSpecs=test-specs.json');
});

test('the validator rejects a canonical case that is marked valid while it has blocking issues, and a status that does not fit', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/a.md', '## TC-1: A\n### Steps\n1. Click\n');
  const { canonical } = normalize(root);
  assert.equal(canonical.testCases[0]!.validation.status, 'needs_clarification');
  const lying = structuredClone(canonical);
  lying.testCases[0]!.validation.status = 'valid';
  assert.ok(validateCanonicalDocument(lying).some((m) => /validation\.status must be "needs_clarification"/.test(m)));
  const noSteps = structuredClone(canonical) as any;
  noSteps.testCases[0].steps = [{ stepNumber: 2, action: 'x' }];
  assert.ok(validateCanonicalDocument(noSteps).some((m) => /steps\[0\] must be/.test(m)));
  const wrongVersion = { ...structuredClone(canonical), schemaVersion: '0.9.0' };
  assert.ok(validateCanonicalDocument(wrongVersion).some((m) => /unsupported canonical schemaVersion/.test(m)));
});

// ---------- import keeps the origin ----------

test('input import keeps where each case came from, and metadata survives the round trip', (t) => {
  const root = tmpRoot(t);
  must(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(validConfig())));
  const outside = path.join(path.dirname(root), 'qa-folder');
  const workbook = writeXlsx(outside, 'regression.xlsx', [
    { name: 'Login', rows: [['Test ID', 'Test Name', 'Test Steps', 'Expected Result', 'Status', 'Steps'], ['LOG-1', 'Sign in', 'Open the login page', 'The login page is shown', 'Pass', 'legacy text']] },
  ]);
  must(root, 'input', 'import', '--from', workbook);
  const md = readFileSync(path.join(dependenciesDir(root), 'input', 'test-cases', 'LOG-1.md'), 'utf8');
  assert.match(md, /### Metadata\n- Status: Pass\n- Steps: legacy text\n- Imported from: regression\.xlsx > Login, row 2/);
  const back = normalize(root);
  assert.deepEqual(back.errors, []);
  const c = back.canonical.testCases[0]!;
  assert.deepEqual(c.steps.map((s) => s.action), ['Open the login page'], 'a metadata key called "Steps" is not read as the steps');
  assert.deepEqual(c.metadata, { Status: 'Pass', Steps: 'legacy text', 'Imported from': 'regression.xlsx > Login, row 2' });
  assert.equal(c.source.fileName, 'LOG-1.md');
});

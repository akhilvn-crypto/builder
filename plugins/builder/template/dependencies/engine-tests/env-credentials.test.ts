// Credentials and emails found in test cases are moved to automation/.env automatically; the user only
// has to fill in what is missing. Values never reach test-specs.json, CLI output or .env.example.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  missingEnvVars, parseEnvText, quoteEnvValue, readManagedEnvVars, redactionEnvVars, secretValuesFor, syncEnvFiles,
} from '../engine/pipeline/env-file.ts';
import { parseInputs } from '../engine/pipeline/test-case-parser.ts';
import { validateTestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'cli', 'pipeline.ts');
const STEPS = ['### Steps', '1. Sign in -> Expected: The dashboard is shown'];

function parse(root: string, ...cases: string[]) {
  const f = writeDep(root, 'input/a.md', cases.join('\n'));
  return parseInputs(path.dirname(f).replace(/[\\/]input$/, ''), [f]);
}

test('password, username and email literals become env var references; the value is handed back, not stored', (t) => {
  const root = tmpRoot(t);
  const { document, credentials } = parse(root,
    '## TC-1: Sign in', '### Test Data', '- email: qa.user@example.com', '- password: hunter2', '- username: qa-admin', '- plan: Premium', ...STEPS);
  assert.deepEqual(validateTestSpecDocument(document), []);
  const [spec] = document.specs;
  assert.equal(spec!.status, 'ready');
  assert.deepEqual(spec!.testData.map((d) => [d.name, d.envVar, d.value]), [
    ['email', 'TEST_EMAIL', null], ['password', 'TEST_PASSWORD', null], ['username', 'TEST_USERNAME', null], ['plan', null, 'Premium'],
  ]);
  assert.deepEqual(credentials, [
    { envVar: 'TEST_EMAIL', value: 'qa.user@example.com' }, { envVar: 'TEST_PASSWORD', value: 'hunter2' }, { envVar: 'TEST_USERNAME', value: 'qa-admin' },
  ]);
  const json = JSON.stringify(document);
  for (const secret of ['hunter2', 'qa.user@example.com', 'qa-admin']) assert.ok(!json.includes(secret), `${secret} must not be in test-specs.json`);
});

test('an email under any field name is treated as account data; look-alike names and opt-outs are left alone', (t) => {
  const root = tmpRoot(t);
  const { document, credentials } = parse(root,
    '## TC-1: Mixed', '### Test Data',
    '- recipient: friend@example.com', '- passengers: 2', '- wrong password: literal:nope-123', '- login email: env:MY_LOGIN', ...STEPS);
  const byName = Object.fromEntries(document.specs[0]!.testData.map((d) => [d.name, d]));
  assert.equal(byName['recipient']!.envVar, 'TEST_RECIPIENT');
  assert.equal(byName['passengers']!.value, '2', '"passengers" is not a password');
  assert.deepEqual(byName['wrong password'], { name: 'wrong password', value: 'nope-123', envVar: null, declaredLiteral: true });
  assert.equal(byName['login email']!.envVar, 'MY_LOGIN', 'an explicit env: reference is kept as written');
  assert.deepEqual(credentials.map((c) => c.envVar), ['TEST_RECIPIENT']);
});

test('different values for the same field name get case-specific variables; explicit env: names are never reused', (t) => {
  const root = tmpRoot(t);
  const { document, credentials } = parse(root,
    '## TC-1: First', '### Test Data', '- password: first-pass', ...STEPS,
    '## TC-2: Second', '### Test Data', '- password: second-pass', ...STEPS,
    '## TC-3: Same as first', '### Test Data', '- password: first-pass', ...STEPS,
    '## TC-4: Own name', '### Test Data', '- email: env:TEST_EMAIL', ...STEPS,
    '## TC-5: Detected email', '### Test Data', '- email: other@example.com', ...STEPS);
  const envOf = (i: number) => document.specs[i]!.testData[0]!.envVar;
  assert.deepEqual([0, 1, 2].map(envOf), ['TEST_PASSWORD', 'TEST_PASSWORD_TC_2', 'TEST_PASSWORD']);
  assert.equal(envOf(3), 'TEST_EMAIL');
  assert.equal(envOf(4), 'TEST_EMAIL_TC_5', 'TEST_EMAIL belongs to the name the user wrote in TC-4');
  assert.equal(credentials.length, 3);
});

test('an email typed inside a step becomes a {placeholder} backed by an env var', (t) => {
  const root = tmpRoot(t);
  const { document, credentials } = parse(root,
    '## TC-1: Inline', '### Test Data', '- email: qa@example.com',
    '### Steps', '1. Enter qa@example.com in the Email field', '2. Enter second@example.com in the Cc field -> Expected: Cc shows second@example.com',
    '### Expected Results', '- A mail was sent to qa@example.com');
  const [spec] = document.specs;
  assert.equal(spec!.steps[0]!.action, 'Enter {email} in the Email field', 'reuses the entry that already holds this address');
  assert.equal(spec!.steps[1]!.action, 'Enter {email 2} in the Cc field');
  assert.equal(spec!.steps[1]!.expected, 'Cc shows {email 2}');
  assert.deepEqual(spec!.expectedResults, ['A mail was sent to {email}']);
  assert.equal(spec!.status, 'ready', 'the new placeholder is defined in Test Data');
  assert.deepEqual(spec!.testData.map((d) => d.envVar), ['TEST_EMAIL', 'TEST_EMAIL_2']);
  assert.deepEqual(credentials.map((c) => c.value), ['qa@example.com', 'second@example.com']);
});

test('a value that cannot be stored in a .env file stays blocked with a clear reason', (t) => {
  const root = tmpRoot(t);
  const { document, credentials } = parse(root, '## TC-1: Odd', '### Test Data', '- password: a\'b"c`d', ...STEPS);
  assert.deepEqual(credentials, []);
  assert.deepEqual(document.specs[0]!.ambiguities.map((a) => a.kind), ['possible_secret_literal']);
  assert.equal(document.specs[0]!.status, 'needs_clarification');
});

test('quoteEnvValue output round-trips through the .env reader', () => {
  for (const v of ['plain', 'has space', 'a#b', "it's", 'say "hi"', 'p@ss w0rd!', ' padded ', 'a\\nb']) {
    const q = quoteEnvValue(v);
    assert.notEqual(q, null, v);
    assert.equal(parseEnvText(`K=${q}`).get('K'), v, v);
  }
  assert.equal(quoteEnvValue('two\nlines'), null);
});

test('syncEnvFiles writes values to .env, names to .env.example, protects the file, and never overwrites the user', (t) => {
  const root = tmpRoot(t);
  writeFile(root, '.env', 'PW_BASE_URL=https://x.example\r\nTEST_PASSWORD=\r\nTEST_EMAIL=mine@example.com\r\n');
  writeFile(root, '.env.example', 'PW_BASE_URL=\n');
  const detected = new Map([['TEST_PASSWORD', 'hunter2'], ['TEST_EMAIL', 'qa@example.com'], ['TEST_NOTE', 'has space']]);
  const r = syncEnvFiles(root, detected, ['TEST_PASSWORD', 'TEST_EMAIL', 'TEST_NOTE', 'MY_LOGIN'], {});
  assert.deepEqual(r.filled, ['TEST_PASSWORD']);
  assert.deepEqual(r.keptExisting, ['TEST_EMAIL']);
  assert.deepEqual(r.created, ['TEST_NOTE']);
  assert.deepEqual(r.placeholders, ['MY_LOGIN']);
  assert.deepEqual(r.missing, ['MY_LOGIN'], 'only the entry nobody has a value for is missing');
  assert.equal(r.gitignoreUpdated, true);

  const env = readFileSync(path.join(root, '.env'), 'utf8');
  assert.ok(env.includes('\r\n') && !/[^\r]\n/.test(env), 'line endings are preserved');
  assert.deepEqual(Object.fromEntries(parseEnvText(env)), {
    PW_BASE_URL: 'https://x.example', TEST_PASSWORD: 'hunter2', TEST_EMAIL: 'mine@example.com', TEST_NOTE: 'has space', MY_LOGIN: '',
  });
  const example = readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.ok(!/hunter2|qa@example\.com|has space/.test(example), '.env.example only receives names');
  assert.deepEqual([...parseEnvText(example).keys()], ['PW_BASE_URL', 'TEST_PASSWORD', 'TEST_EMAIL', 'TEST_NOTE', 'MY_LOGIN']);
  assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.env$/m);

  const again = syncEnvFiles(root, detected, ['TEST_PASSWORD', 'TEST_EMAIL', 'TEST_NOTE', 'MY_LOGIN'], {});
  assert.deepEqual([again.created, again.filled, again.placeholders, again.exampleAdded, again.gitignoreUpdated], [[], [], [], [], false], 'a second sync changes nothing');
  assert.deepEqual(again.unchanged, ['TEST_PASSWORD', 'TEST_NOTE']);
});

test('missing means no value in .env or the real environment', (t) => {
  const root = tmpRoot(t);
  writeFile(root, '.env', 'A=1\nB=\n');
  assert.deepEqual(missingEnvVars(root, ['A', 'B', 'C', 'D'], { D: 'from-env' }), ['B', 'C']);
  assert.deepEqual(syncEnvFiles(root, new Map(), ['A', 'B', 'C'], {}).missing, ['B', 'C']);
});

test('auto-created variables are redacted from logs even though the config does not list them', (t) => {
  const root = tmpRoot(t);
  syncEnvFiles(root, new Map([['TEST_PASSWORD', 'hunter2']]), ['TEST_PASSWORD'], {});
  assert.deepEqual(readManagedEnvVars(root), ['TEST_PASSWORD']);
  assert.deepEqual(redactionEnvVars(root, ['OTHER']), ['OTHER', 'TEST_PASSWORD']);
  assert.deepEqual(secretValuesFor(root, ['OTHER'], {}), ['hunter2'], 'the value is read from .env, which the CLI does not load');
});

test('env run gives a command the .env values and masks them in its output', (t) => {
  const root = tmpRoot(t);
  writeFile(root, '.env', "TEST_PASSWORD=hunter2\nTEST_NOTE='has space'\n");
  syncEnvFiles(root, new Map([['TEST_PASSWORD', 'hunter2']]), [], {}); // registers TEST_PASSWORD as pipeline-managed
  const script = "console.log(process.env.TEST_PASSWORD.length, process.env.TEST_NOTE, process.env.TEST_PASSWORD); console.error('bad ' + process.env.TEST_PASSWORD); process.exit(3)";
  const r = spawnSync(process.execPath, [CLI, 'env', 'run', '--root', root, '--', process.execPath, '-e', script], { encoding: 'utf8', env: { ...process.env, TEST_NOTE: '' } });
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, 'a failing command is reported, not hidden');
  assert.equal(out.exitCode, 3);
  assert.equal(out.stdout.trim(), '7 has space ***', 'the child saw the .env values; the secret is masked, the plain value is not');
  assert.equal(out.stderr.trim(), 'bad ***');
  assert.ok(!r.stdout.includes('hunter2'));
});

function cli(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  let json: any = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('specs parse creates .env entries; env check names what the user still has to fill in', (t) => {
  const root = tmpRoot(t);
  writeFile(root, 'package.json', JSON.stringify({ type: 'module' }));
  writeDep(root, 'input/login.md', [
    '## TC-1: Valid sign in', '### Test Data', '- email: qa@example.com', '- password: hunter2', '### Steps', '1. Sign in -> Expected: Dashboard',
    '## TC-2: Existing account', '### Test Data', '- email: env:TEST_ADMIN_EMAIL', '### Steps', '1. Sign in -> Expected: Dashboard',
  ].join('\n'));
  const save = cli(root, 'config', 'save', '--file', writeFile(root, 'cfg.json', JSON.stringify(validConfig())));
  assert.equal(save.code, 0, save.stdout);
  const runId: string = cli(root, 'run', 'create', '--command', 'playwright-pipeline').json.runId;

  const parsed = cli(root, 'specs', 'parse', runId, '--path', 'input/login.md');
  assert.equal(parsed.code, 0, parsed.stdout + parsed.stderr);
  assert.ok(!/hunter2|qa@example\.com/.test(parsed.stdout), 'CLI output carries names only');
  assert.deepEqual(parsed.json.env.created, ['TEST_EMAIL', 'TEST_PASSWORD']);
  assert.deepEqual(parsed.json.env.placeholders, ['TEST_ADMIN_EMAIL']);
  assert.deepEqual(parsed.json.env.missing, ['TEST_ADMIN_EMAIL']);
  assert.deepEqual(parsed.json.env.detected, [{ envVar: 'TEST_EMAIL', usedBy: ['TC-1'] }, { envVar: 'TEST_PASSWORD', usedBy: ['TC-1'] }]);
  assert.match(parsed.json.env.action, /TEST_ADMIN_EMAIL in automation\/\.env/);
  assert.ok(!parsed.json.env.action.includes('hunter2'));

  const specsFile = path.join(root, '..', 'dependencies', 'runs', runId, 'test-specs.json');
  assert.ok(!/hunter2|qa@example\.com/.test(readFileSync(specsFile, 'utf8')), 'test-specs.json holds no values');

  const blocked = cli(root, 'env', 'check', runId);
  assert.equal(blocked.code, 2);
  assert.deepEqual(blocked.json.missing, ['TEST_ADMIN_EMAIL']);

  // The user adds the one missing value; everything else was already in place.
  const envPath = path.join(root, '.env');
  writeFileSync(envPath, readFileSync(envPath, 'utf8').replace('TEST_ADMIN_EMAIL=', 'TEST_ADMIN_EMAIL=admin@example.com'));
  const ready = cli(root, 'env', 'check', runId);
  assert.equal(ready.code, 0, ready.stdout);
  assert.deepEqual(ready.json.required, ['TEST_EMAIL', 'TEST_PASSWORD', 'TEST_ADMIN_EMAIL']);

  const reparsed = cli(root, 'specs', 'parse', runId, '--path', 'input/login.md');
  assert.deepEqual(reparsed.json.env.created, [], 're-running specs parse is idempotent');
  assert.deepEqual(reparsed.json.env.missing, []);
  assert.ok(existsSync(path.join(root, '.env.example')));
});

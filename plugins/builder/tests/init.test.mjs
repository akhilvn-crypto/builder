// Layout contract of scripts/init.mjs. Run from the repository root: node --test plugins/builder/tests/init.test.mjs
//
// automation/ must contain only the framework (playwright_framework_structure.md); everything else belongs in
// dependencies/. A project scaffolded by 0.2.x (everything inside automation/) must migrate to that layout.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as jsHelpers from '../template/framework/javascript/helpers/test-data.js';
import * as tsHelpers from '../template/framework/typescript/helpers/test-data.ts';

const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init.mjs');

// Everything the framework structure (or the framework's own tooling) allows at the top of automation/.
const ALLOWED_IN_AUTOMATION = new Set([
  'pages', 'tests', 'helpers', 'fixtures', 'test-data', 'config', 'auth', 'reports', 'test-results',
  'playwright.config.ts', 'playwright.config.js', 'package.json', 'package-lock.json', 'node_modules',
  'tsconfig.json', 'jsconfig.json', '.gitignore', '.env', '.env.example', 'README.md',
]);
// What the scaffolder itself may create up front (optional folders appear only when used).
const SCAFFOLDED_AUTOMATION = ['pages', 'tests', 'helpers', 'fixtures', 'config'];
const FORBIDDEN_IN_AUTOMATION = ['engine', 'docs', 'demo', 'input', 'output', 'runs', 'state', 'utils', 'engine-tests'];

function project(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function init(root, ...args) {
  const r = spawnSync(process.execPath, [INIT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

const names = (dir) => readdirSync(dir).sort();

test('refuses to scaffold into a Cowork session folder (cwd with mnt/ and no project files) unless --root is given', (t) => {
  const session = project(t);
  mkdirSync(path.join(session, 'mnt', 'MyProject'), { recursive: true });
  mkdirSync(path.join(session, 'mnt', '.local-plugins'), { recursive: true });
  const r = spawnSync(process.execPath, [INIT, '--language', 'typescript'], { cwd: session, encoding: 'utf8' });
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(json.needsInput, 'root');
  assert.deepEqual(json.candidateRoots, [path.join(session, 'mnt', 'MyProject').split(path.sep).join('/')]);
  assert.ok(!existsSync(path.join(session, 'automation')), 'nothing was written to the session folder');

  const ok = spawnSync(process.execPath, [INIT, '--language', 'typescript', '--root', path.join(session, 'mnt', 'MyProject')], { cwd: session, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(existsSync(path.join(session, 'mnt', 'MyProject', 'automation', 'tests')));
  assert.ok(existsSync(path.join(session, 'mnt', 'MyProject', 'dependencies', 'engine', 'cli', 'pipeline.ts')));
});

for (const language of ['typescript', 'javascript']) {
  test(`${language}: automation/ holds the framework only, the pipeline lives in dependencies/`, (t) => {
    const root = project(t);
    const { code, json } = init(root, '--language', language, '--with-demo', '--with-pipeline-tests');
    assert.equal(code, 0, JSON.stringify(json));

    const inAutomation = names(path.join(root, 'automation'));
    assert.deepEqual(inAutomation.filter((n) => !ALLOWED_IN_AUTOMATION.has(n)), [], 'only framework entries in automation/');
    for (const d of SCAFFOLDED_AUTOMATION) assert.ok(inAutomation.includes(d), `automation/${d}/ exists`);
    for (const d of FORBIDDEN_IN_AUTOMATION) assert.ok(!inAutomation.includes(d), `automation/${d}/ must not exist`);
    for (const d of ['test-data', 'auth', 'reports', 'test-results']) assert.ok(!inAutomation.includes(d), `optional automation/${d}/ is not pre-created`);
    assert.deepEqual(names(path.join(root, 'automation', 'tests')).filter((n) => n !== '.gitkeep'), [], 'tests/ is flat: no generated/ or handwritten/ subfolders');

    const inDependencies = names(path.join(root, 'dependencies'));
    for (const d of ['engine', 'docs', 'input', 'state', 'demo', 'engine-tests']) assert.ok(inDependencies.includes(d), `dependencies/${d}/ exists`);
    assert.ok(!inDependencies.includes('node_modules'), 'dependencies/ has no node_modules');
    const scaffold = JSON.parse(readFileSync(path.join(root, 'dependencies', 'state', 'scaffold.json'), 'utf8'));
    assert.equal(scaffold.language, language);
    assert.match(scaffold.rules.generator, /^[0-9a-f]{64}$/, 'generator rule fingerprint recorded');
    assert.match(scaffold.rules.reviewer, /^[0-9a-f]{64}$/, 'reviewer rule fingerprint recorded');
    assert.notEqual(scaffold.rules.generator, scaffold.rules.reviewer);
    const updated = init(root, '--update');
    assert.equal(updated.code, 0, JSON.stringify(updated.json));
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'dependencies', 'state', 'scaffold.json'), 'utf8')).rules, scaffold.rules, 'fingerprints are stable across an update');

    // The framework's mandatory helpers/ folder replaces utils/, and nothing imports the old name.
    assert.ok(existsSync(path.join(root, 'automation', 'helpers', language === 'typescript' ? 'test-data.ts' : 'test-data.js')));
    const fixture = readFileSync(path.join(root, 'automation', 'fixtures', language === 'typescript' ? 'test.ts' : 'test.js'), 'utf8');
    assert.match(fixture, /\.\.\/helpers\/test-data\./);
    assert.match(fixture, /\.\.\/\.\.\/dependencies\/engine\/config\/load-config\.ts/);

    // npm scripts: framework scripts in automation/, pipeline scripts in dependencies/.
    const fwScripts = JSON.parse(readFileSync(path.join(root, 'automation', 'package.json'), 'utf8')).scripts;
    const depScripts = JSON.parse(readFileSync(path.join(root, 'dependencies', 'package.json'), 'utf8')).scripts;
    assert.ok(fwScripts.test && !fwScripts.pipeline && !fwScripts['test:pipeline']);
    // npm test records a run through the pipeline CLI; plain Playwright is test:adhoc.
    assert.equal(fwScripts.test, 'node ../dependencies/engine/cli/quick-run.ts');
    // plain Playwright goes through adhoc-run.ts so the test data it registered is removed once every test has finished.
    assert.equal(fwScripts['test:adhoc'], 'node ../dependencies/engine/cli/adhoc-run.ts');
    assert.equal(fwScripts['test:ui'], 'node ../dependencies/engine/cli/adhoc-run.ts --ui');
    assert.equal(fwScripts['test:headed'], 'node ../dependencies/engine/cli/quick-run.ts --headed');
    assert.ok(depScripts.pipeline && depScripts.test && depScripts['demo:app']);

    // Generated output is ignored in the framework; run state is ignored in dependencies.
    assert.match(readFileSync(path.join(root, 'automation', '.gitignore'), 'utf8'), /^reports\/$/m);
    assert.match(readFileSync(path.join(root, 'automation', '.gitignore'), 'utf8'), /^test-results\/$/m);
    assert.match(readFileSync(path.join(root, 'dependencies', '.gitignore'), 'utf8'), /^runs\/$/m);

    // Re-running changes nothing except re-stamping the scaffold record.
    const again = init(root, '--language', language, '--with-demo', '--with-pipeline-tests');
    assert.deepEqual([again.json.created, again.json.moved, again.json.removed, again.json.merged], [[], [], [], []]);
  });
}

test('the language is required the first time and cannot be switched', (t) => {
  const root = project(t);
  const missing = init(root);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.needsInput, 'language');
  assert.equal(init(root, '--language', 'typescript').code, 0);
  const switched = init(root, '--language', 'javascript');
  assert.equal(switched.code, 1);
  assert.match(switched.json.error, /cannot be switched/);
});

// A minimal project as plugin 0.2.x scaffolded it: everything inside automation/.
function legacyProject(t) {
  const root = project(t);
  const at = (rel, text) => {
    const file = path.join(root, 'automation', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  at('engine/cli/pipeline.ts', '// old engine\n');
  at('docs/test-spec-schema.md', '# old docs\n');
  at('tsconfig.engine.json', '{}\n');
  at('tests/pipeline/old.test.ts', "import '../../engine/x.ts';\n");
  at('input/test-cases/login.md', '## TC-1: Login\n');
  at('output/runs/20261019-083012-abc123/manifest.json', '{}\n');
  at('config/scaffold.json', JSON.stringify({ pluginVersion: '0.2.0', language: 'typescript' }));
  at('config/dependency-log.json', '[]\n');
  at('config/automation.config.json', '{"keep":"me"}\n');
  at('utils/test-data.ts', 'export const x = 1;\n');
  at('fixtures/test.ts', "import { loadConfig } from '../engine/config/load-config.ts';\nimport { redact } from '../utils/test-data.ts';\n");
  at('tests/generated/a.spec.ts', "import { requireEnv } from '../../utils/test-data.ts';\n");
  at('tests/handwritten/mine.spec.ts', "import { requireEnv } from '../../utils/test-data.ts';\n");
  at('tests/setup/auth.setup.ts', "await context.storageState({ path: '.auth/storage-state.json' });\n");
  at('package.json', JSON.stringify({
    name: 'x', type: 'module',
    scripts: { pipeline: 'node engine/cli/pipeline.ts', 'test:pipeline': 'node --test "tests/pipeline/**/*.test.ts"', validate: 'npm run typecheck:engine && npm run test:pipeline', test: 'playwright test', 'test:headed': 'playwright test --headed' },
  }));
  return root;
}

test('migration: a 0.2.x layout is moved to automation/ + dependencies/ without losing user files', (t) => {
  const root = legacyProject(t);
  const dry = init(root, '--dry-run');
  assert.equal(dry.code, 0, JSON.stringify(dry.json));
  assert.equal(dry.json.migratedFromLegacyLayout, true);
  assert.ok(existsSync(path.join(root, 'automation', 'engine')), 'dry run changes nothing');

  const { code, json } = init(root, '--with-pipeline-tests');
  assert.equal(code, 0, JSON.stringify(json));
  const a = (rel) => path.join(root, 'automation', rel);
  const d = (rel) => path.join(root, 'dependencies', rel);

  const left = names(path.join(root, 'automation'));
  assert.deepEqual(left.filter((n) => !ALLOWED_IN_AUTOMATION.has(n)), [], `unexpected in automation/: ${left}`);
  assert.ok(existsSync(a('auth/auth.setup.ts')) && !existsSync(a('tests/setup')), 'login setup moved to auth/');
  assert.ok(!existsSync(a('tests/generated')) && !existsSync(a('tests/handwritten')), 'tests/ is flat');

  // Pipeline data moved, not lost.
  assert.equal(readFileSync(d('input/test-cases/login.md'), 'utf8'), '## TC-1: Login\n');
  assert.ok(existsSync(d('runs/20261019-083012-abc123/manifest.json')));
  assert.ok(existsSync(d('state/dependency-log.json')) && existsSync(d('state/scaffold.json')));
  assert.equal(JSON.parse(readFileSync(d('state/scaffold.json'), 'utf8')).pluginVersion, JSON.parse(readFileSync(path.resolve(path.dirname(INIT), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.ok(existsSync(d('engine/utils/layout.ts')), 'engine refreshed to this plugin version');
  assert.ok(existsSync(d('engine-tests/end-to-end.test.ts')) && !existsSync(a('tests/pipeline')));

  // User files kept, with their imports updated to the new layout.
  assert.equal(readFileSync(a('config/automation.config.json'), 'utf8'), '{"keep":"me"}\n');
  assert.match(readFileSync(a('helpers/test-data.ts'), 'utf8'), /export const x = 1/);
  assert.match(readFileSync(a('fixtures/test.ts'), 'utf8'), /'\.\.\/\.\.\/dependencies\/engine\/config\/load-config\.ts'/);
  assert.match(readFileSync(a('fixtures/test.ts'), 'utf8'), /\.\.\/helpers\/test-data\.ts/);
  const generated = readFileSync(a('tests/a.spec.ts'), 'utf8');
  const handwritten = readFileSync(a('tests/mine.spec.ts'), 'utf8');
  assert.match(generated, /^\/\/ @builder:generated/, 'moved generated spec gets the ownership header');
  assert.doesNotMatch(handwritten, /@builder:generated/, 'handwritten spec stays unmarked');
  for (const text of [generated, handwritten]) assert.match(text, /from '\.\.\/helpers\/test-data\.ts'|'\.\.\/helpers\/test-data\.ts'/);
  assert.match(readFileSync(a('auth/auth.setup.ts'), 'utf8'), /'auth\/storage-state\.json'/);

  // Old engine scripts left automation/package.json and exist in dependencies/package.json.
  const fw = JSON.parse(readFileSync(a('package.json'), 'utf8')).scripts;
  assert.deepEqual([fw.pipeline, fw['test:pipeline'], fw.validate], [undefined, undefined, undefined]);
  assert.equal(fw.test, 'playwright test');
  assert.ok(JSON.parse(readFileSync(d('package.json'), 'utf8')).scripts.pipeline);
  assert.ok(json.warnings.some((w) => /moved to dependencies\/runs/.test(w)));

  // Idempotent: a second run is a no-op.
  const again = init(root, '--with-pipeline-tests');
  assert.equal(again.json.migratedFromLegacyLayout, false);
  assert.deepEqual([again.json.moved, again.json.removed, again.json.rewritten], [[], [], []]);
});

test('flattening: tests/generated + tests/handwritten of a 0.3.0 project move into tests/, clashes are kept and reported', (t) => {
  const root = project(t);
  assert.equal(init(root, '--language', 'typescript').code, 0);
  const at = (rel, text) => {
    const file = path.join(root, 'automation', rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  at('tests/generated/login.spec.ts', "import { test } from '../../fixtures/test.ts';\n");
  at('tests/generated/clash.spec.ts', "// generated clash\n");
  at('tests/handwritten/clash.spec.ts', "// handwritten clash\n");
  at('tests/handwritten/sub/deep.spec.ts', "import { test } from '../../../fixtures/test.ts';\nimport { helper } from '../local.ts';\n");
  at('tests/handwritten/local.ts', 'export const helper = 1;\n');

  const { code, json } = init(root, '--language', 'typescript');
  assert.equal(code, 0, JSON.stringify(json));
  const a = (rel) => path.join(root, 'automation', rel);
  assert.match(readFileSync(a('tests/login.spec.ts'), 'utf8'), /^\/\/ @builder:generated[^\n]*\nimport \{ test \} from '\.\.\/fixtures\/test\.ts';/);
  // Nested handwritten file: only the import that left the old folder lost a level.
  assert.equal(readFileSync(a('tests/sub/deep.spec.ts'), 'utf8'), "import { test } from '../../fixtures/test.ts';\nimport { helper } from '../local.ts';\n");
  assert.ok(existsSync(a('tests/local.ts')));
  // The name clash: first mover (generated) wins nothing silently; the handwritten file is not overwritten.
  assert.equal(readFileSync(a('tests/clash.spec.ts'), 'utf8').includes('// handwritten clash'), true);
  assert.ok(existsSync(a('tests/generated/clash.spec.ts')), 'clashing generated file stays where it was');
  assert.ok(json.warnings.some((w) => /clash\.spec\.ts was not moved/.test(w)));
  assert.ok(!existsSync(a('tests/handwritten')));
});

// ---- --update and the stepEvidence fixture (evidence-pdf reporter) ----

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data');

for (const [language, ext] of [['typescript', 'ts'], ['javascript', 'js']]) {
  test(`${language}: --update refreshes an unmodified older fixtures/test.${ext} and leaves a customised one alone`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const fixture = path.join(root, 'automation', 'fixtures', `test.${ext}`);
    const shipped = readFileSync(path.join(DATA, `fixture-0.6.0.${ext}.txt`), 'utf8');
    assert.doesNotMatch(shipped, /stepEvidence/);

    // Unmodified older copy (also with Windows line endings): a plain run keeps it, --update replaces it.
    writeFileSync(fixture, shipped.replace(/\n/g, '\r\n'));
    assert.ok(!init(root).json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.doesNotMatch(readFileSync(fixture, 'utf8'), /stepEvidence/, 'no flag: untouched');
    const updated = init(root, '--update');
    assert.ok(updated.json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.match(readFileSync(fixture, 'utf8'), /stepEvidence/);

    // Customised copy: never replaced, the user is told how to get the fixture.
    const custom = `${shipped}\n// my own fixture\n`;
    writeFileSync(fixture, custom);
    const kept = init(root, '--update');
    assert.equal(readFileSync(fixture, 'utf8'), custom);
    assert.ok(!kept.json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.ok(kept.json.warnings.some((w) => w.includes(`test.${ext} was customised`) && w.includes('final-state screenshot')), JSON.stringify(kept.json.warnings));

    // A copy that already has the current fixture is left alone silently.
    writeFileSync(fixture, `${custom}// evidence-fixture-revision: 4\n`);
    const quiet = init(root, '--update');
    assert.ok(!quiet.json.warnings.some((w) => w.includes('customised')));
  });

  test(`${language}: --update also brings the unmodified 0.8.0 fixtures/test.${ext} up to date (masked step screenshots, redaction)`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const fixture = path.join(root, 'automation', 'fixtures', `test.${ext}`);
    const shipped = readFileSync(path.join(DATA, `fixture-0.8.0.${ext}.txt`), 'utf8');
    assert.match(shipped, /stepEvidence/);
    assert.doesNotMatch(shipped, /maskSelectors/);
    writeFileSync(fixture, shipped);
    assert.ok(init(root, '--update').json.overwritten.includes(`automation/fixtures/test.${ext}`));
    const current = readFileSync(fixture, 'utf8');
    assert.match(current, /maskSelectors/);
    assert.match(current, /redactSensitive/);
    assert.match(current, /input\[type="password"\]/, 'password fields are always masked in the screenshot');
  });

  test(`${language}: --update brings the unmodified 0.9.0 fixtures/test.${ext} (a screenshot per step) to one final-state screenshot`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const fixture = path.join(root, 'automation', 'fixtures', `test.${ext}`);
    const shipped = readFileSync(path.join(DATA, `fixture-0.9.0.${ext}.txt`), 'utf8');
    assert.match(shipped, /maskSelectors/);
    assert.match(shipped, /step-\$\{String\(index\)/, 'the 0.9.0 fixture took a screenshot per step');
    writeFileSync(fixture, shipped.replace(/\n/g, '\r\n'));
    assert.ok(init(root, '--update').json.overwritten.includes(`automation/fixtures/test.${ext}`));
    const current = readFileSync(fixture, 'utf8');
    assert.match(current, /evidence-fixture-revision: 4/);
    assert.doesNotMatch(current, /step-\$\{String\(index\)/, 'no screenshot per step any more');
    assert.match(current, /capture\(r, 'final'\)/, 'the final-state screenshot is still taken');
    assert.match(current, /input\[type="password"\]/);
    // The current fixture is then left alone.
    assert.ok(!init(root, '--update').json.overwritten.includes(`automation/fixtures/test.${ext}`));
  });

  test(`${language}: --update brings the unmodified 0.14.0 fixtures/test.${ext} up to date (adds the opt-in cleanup fixture); a customised copy is told how`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const fixture = path.join(root, 'automation', 'fixtures', `test.${ext}`);
    const shipped = readFileSync(path.join(DATA, `fixture-0.14.0.${ext}.txt`), 'utf8');
    assert.match(shipped, /evidence-fixture-revision: 2/);
    assert.doesNotMatch(shipped, /cleanup/);
    writeFileSync(fixture, shipped.replace(/\n/g, '\r\n'));
    assert.ok(init(root, '--update').json.overwritten.includes(`automation/fixtures/test.${ext}`));
    const current = readFileSync(fixture, 'utf8');
    assert.match(current, /evidence-fixture-revision: 4/);
    assert.match(current, /startCleanup\(/);
    assert.match(current, /cleanup\.register|cleanup: async/);
    assert.match(current, /session\.run\(\)/, 'the undo functions run after the test');

    // A customised 0.14.0 copy is never touched; the warning names the new fixture.
    writeFileSync(fixture, `${shipped}\n// my own fixture\n`);
    const kept = init(root, '--update');
    assert.ok(!kept.json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.ok(kept.json.warnings.some((w) => w.includes(`test.${ext} was customised`) && w.includes('cleanup')), JSON.stringify(kept.json.warnings));
  });

  test(`${language}: --update brings the unmodified 0.18.2 fixtures/test.${ext} up to date (adds the final-url attachment) and adds helpers/auth`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const fixture = path.join(root, 'automation', 'fixtures', `test.${ext}`);
    const shipped = readFileSync(path.join(DATA, `fixture-0.18.2.${ext}.txt`), 'utf8');
    assert.match(shipped, /evidence-fixture-revision: 3/);
    assert.doesNotMatch(shipped, /final-url/);
    writeFileSync(fixture, shipped.replace(/\n/g, '\r\n'));
    // An older project has no helpers/auth: --update adds the file without touching the helpers it already has.
    rmSync(path.join(root, 'automation', 'helpers', `auth.${ext}`));
    const updated = init(root, '--update');
    assert.ok(updated.json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.ok(updated.json.created.includes(`automation/helpers/auth.${ext}`), JSON.stringify(updated.json.created));
    assert.ok(!updated.json.overwritten.includes(`automation/helpers/test-data.${ext}`));
    const current = readFileSync(fixture, 'utf8');
    assert.match(current, /evidence-fixture-revision: 4/);
    assert.match(current, /testInfo\.attach\('final-url'/, 'a failed test records the page it ended on');
    assert.match(readFileSync(path.join(root, 'automation', 'helpers', `auth.${ext}`), 'utf8'), /export async function reuseOrSignIn/);

    // A customised 0.18.2 copy is never touched; the warning names the new attachment.
    writeFileSync(fixture, `${shipped}\n// my own fixture\n`);
    const kept = init(root, '--update');
    assert.ok(!kept.json.overwritten.includes(`automation/fixtures/test.${ext}`));
    assert.ok(kept.json.warnings.some((w) => w.includes(`test.${ext} was customised`) && w.includes('final-url')), JSON.stringify(kept.json.warnings));
  });
}

for (const [language, ext] of [['typescript', 'ts'], ['javascript', 'js']]) {
  test(`${language}: playwright.config is a self-contained standard config; --update never overwrites it`, (t) => {
    const root = project(t);
    assert.equal(init(root, '--language', language).code, 0);
    const file = path.join(root, 'automation', `playwright.config.${ext}`);
    const scaffolded = readFileSync(file, 'utf8');
    assert.match(scaffolded, /import \{ defineConfig, devices \} from '@playwright\/test';/);
    assert.doesNotMatch(scaffolded, /dependencies|loadConfig|playwright-settings/, 'no link back to the pipeline engine');
    assert.doesNotMatch(scaffolded, /https?:\/\//, 'no base URL is invented before the user approves one');

    // Saving settings fills the file with them.
    const cfg = {
      schemaVersion: 1, language, packageManager: 'npm', app: { baseUrl: 'https://qa.example.com', environment: 'qa' },
      input: { testCasesPath: 'input/test-cases' }, browsers: ['chromium'],
      evidence: { video: 'off', screenshot: 'only-on-failure', trace: 'off' }, reporters: ['json'],
      auth: { approach: 'none', credentialEnvVars: [] }, exploration: { tool: 'none' },
      execution: { workers: null, retries: 2, timeoutMs: 20000, isolation: 'shared-readonly' }, healing: { maxAttemptsPerTest: 2 }, retention: { keepRuns: null },
    };
    const cfgFile = path.join(root, 'cfg.json');
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'dependencies', 'engine', 'cli', 'pipeline.ts'), ...args, '--root', path.join(root, 'automation')], { encoding: 'utf8' });
    const saved = cli('config', 'save', '--file', cfgFile);
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    assert.equal(JSON.parse(saved.stdout).playwrightConfig.status, 'written');
    const filled = readFileSync(file, 'utf8');
    assert.match(filled, /qa\.example\.com/);
    assert.match(filled, /timeout: 20000,/);

    // --update leaves the user's file alone, and a later save keeps a hand edit.
    writeFileSync(file, filled.replace('fullyParallel: true', 'fullyParallel: false'));
    assert.equal(init(root, '--update').code, 0);
    assert.match(readFileSync(file, 'utf8'), /fullyParallel: false/);
    assert.equal(JSON.parse(cli('config', 'save', '--file', cfgFile).stdout).playwrightConfig.status, 'kept');
    assert.equal(JSON.parse(cli('config', 'render', '--force').stdout).playwrightConfig.status, 'written');
    assert.match(readFileSync(file, 'utf8'), /fullyParallel: true/);
  });
}

test('migration: the thin playwright.config wrapper of 0.6.x is replaced and its engine module removed', (t) => {
  const root = project(t);
  assert.equal(init(root, '--language', 'typescript').code, 0);
  const file = path.join(root, 'automation', 'playwright.config.ts');
  writeFileSync(file, "import { playwrightSettings } from '../dependencies/engine/config/playwright-settings.ts';\n");
  writeFileSync(path.join(root, 'dependencies', 'engine', 'config', 'playwright-settings.ts'), '// old\n');
  const r = init(root, '--update');
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.doesNotMatch(readFileSync(file, 'utf8'), /playwright-settings/);
  assert.ok(!existsSync(path.join(root, 'dependencies', 'engine', 'config', 'playwright-settings.ts')));
});

// ---- test-data helpers shipped in the framework (per-worker accounts, worker-tagged unique data) ----

for (const [language, h] of [['typescript', tsHelpers], ['javascript', jsHelpers]]) {
  test(`${language}: helpers give each worker its own account when a pool exists and fall back to the shared one`, () => {
    assert.equal(h.workerEnvName('TEST_USER_EMAIL', 0), 'TEST_USER_EMAIL_1');
    const env = { TEST_USER_EMAIL: 'shared@x.test', TEST_USER_EMAIL_2: 'second@x.test' };
    assert.equal(h.requireWorkerEnv('TEST_USER_EMAIL', 1, env), 'second@x.test');
    assert.equal(h.requireWorkerEnv('TEST_USER_EMAIL', 0, env), 'shared@x.test');
    assert.throws(() => h.requireWorkerEnv('NOPE', 0, {}), /Missing required environment variable NOPE/);
    assert.match(h.uniqueSuffix('order', 3), /^order-w3-/);
    assert.match(h.uniqueSuffix('order'), /^order-[a-z0-9]+-[0-9a-f]{6}$/);
  });
}

test('the framework ignores secrets and saved logins, and the pipeline ignores its local caches', () => {
  const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'template');
  const framework = readFileSync(path.join(template, 'framework', 'common', 'gitignore'), 'utf8');
  for (const line of ['.env', 'auth/storage-state*.json', '**/storage-state*.json']) assert.ok(framework.split(/\r?\n/).includes(line), line);
  const dependencies = readFileSync(path.join(template, 'dependencies', 'gitignore'), 'utf8');
  for (const line of ['runs/', 'state/exploration-store/', 'state/artifact-cache/', 'state/ledger/']) assert.ok(dependencies.split(/\r?\n/).includes(line), line);
});

test('--update moves an unedited "playwright test" npm test script to the recorded run, and leaves an edited one alone', (t) => {
  const root = legacyProject(t);
  init(root, '--with-pipeline-tests'); // migrates to automation/ + dependencies/; the old scripts are kept without --update
  const pkgFile = path.join(root, 'automation', 'package.json');
  const scripts = () => JSON.parse(readFileSync(pkgFile, 'utf8')).scripts;
  assert.equal(scripts().test, 'playwright test');
  assert.equal(scripts()['test:headed'], 'playwright test --headed');

  init(root, '--update');
  assert.equal(scripts().test, 'node ../dependencies/engine/cli/quick-run.ts');
  assert.equal(scripts()['test:headed'], 'node ../dependencies/engine/cli/quick-run.ts --headed');
  assert.equal(scripts()['test:adhoc'], 'node ../dependencies/engine/cli/adhoc-run.ts');
  assert.equal(scripts()['test:ui'], 'node ../dependencies/engine/cli/adhoc-run.ts --ui');

  const edited = JSON.parse(readFileSync(pkgFile, 'utf8'));
  edited.scripts.test = 'playwright test --workers=1';
  writeFileSync(pkgFile, JSON.stringify(edited, null, 2));
  const { json } = init(root, '--update');
  assert.equal(scripts().test, 'playwright test --workers=1');
  assert.ok(json.warnings.some((w) => /script "test" already exists/.test(w)));
});

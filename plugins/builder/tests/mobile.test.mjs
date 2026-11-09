// Tests of the Maestro mobile tooling: node --test plugins/builder/tests/mobile.test.mjs
//
// No phone and no Maestro install is needed: the CLI runs against fake `maestro` and `adb` programs (tests/mobile-helpers.mjs).
// What is checked is everything the plugin owns — discovery, configuration, test-case parsing, traceability, validation, device
// handling, execution bookkeeping, classification, reporting and the repair guard — and that the Playwright folders are never touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  EMULATOR, MOBILE_INIT, PHONE, PLUGIN, TEMPLATE_CLI, Project, makeFakeBin, newProject, pathWith, tempDir, testFlow,
} from './mobile-helpers.mjs';

const lib = (name) => import(pathToFileURL(path.join(PLUGIN, 'template', 'mobile', 'tools', 'lib', `${name}.mjs`)).href);
const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ------------------------------------------------------------------ YAML reader

test('yaml: parses a Maestro flow (header, commands, flow collections, block scalars) with line numbers', async () => {
  const { parseYamlStream, lineOfItem, lineOfKey } = await lib('yaml');
  const r = parseYamlStream(`# comment
appId: \${APP_ID}
name: "[TC-1] Valid: sign in"   # trailing
tags: [smoke, "auth"]
env:
  USER: abc
---
- launchApp:
    clearState: true
- tapOn: "Sign in"
- runFlow:
    file: ../common/x.yaml
    env: {A: 1, B: 'x y'}
- evalScript: |
    output.x = 1
    output.y = 2
- back
`);
  const [header, commands] = r.documents.map((d) => d.value);
  assert.equal(header.appId, '${APP_ID}');
  assert.equal(header.name, '[TC-1] Valid: sign in');
  assert.deepEqual(header.tags, ['smoke', 'auth']);
  assert.deepEqual(commands[2], { runFlow: { file: '../common/x.yaml', env: { A: 1, B: 'x y' } } });
  assert.equal(commands[3].evalScript, 'output.x = 1\noutput.y = 2');
  assert.equal(commands[4], 'back');
  assert.equal(lineOfItem(commands, 1), 10);
  assert.equal(lineOfKey(header, 'tags'), 4);
});

test('yaml: tabs, duplicate keys, unclosed collections and anchors are reported with a line', async () => {
  const { parseYamlStream, YamlError } = await lib('yaml');
  for (const [text, re, unsupported] of [['a: 1\na: 2', /duplicate key "a"/, false], ['a:\n\tb: 1', /tabs/, false], ['a: [1, 2', /not closed/, false], ['- a\nb: 1', /unexpected content/, false], ['a: &x 1', /anchors/, true]]) {
    assert.throws(() => parseYamlStream(text), (e) => e instanceof YamlError && re.test(e.message) && e.unsupported === unsupported && e.line >= 1);
  }
});

// ------------------------------------------------------------------ test-case parsing

const CASES_MD = `# Authentication
User Story ID: US-001

## TC-001: Valid user can sign in
Priority: Critical
Tags: smoke, auth

### Preconditions
- An active test account exists

### Test Data
- email: env:TEST_USER_EMAIL
- password: env:TEST_USER_PASSWORD
- wrong_password: literal:wrong-pass-1

### Steps
1. Open the login page
2. Enter {email} in the Email field
3. Click the "Sign in" button -> Expected: The dashboard is displayed

### Expected Results
- The heading "Dashboard" is visible

## TC-002: Passcode shortcut
Tags: manual

### Steps
1. Use the fingerprint sensor

### Expected Results
- The app unlocks
`;

test('testcases: canonical Markdown is read with data kinds, tags, hashes and manual detection; CSV works too', async () => {
  const { parseMarkdownCases, parseCsvCases } = await lib('testcases');
  const cases = parseMarkdownCases(CASES_MD, 'test-design/test-cases/US-001-testcase.md');
  assert.equal(cases.length, 2);
  const [a, b] = cases;
  assert.equal(a.id, 'TC-001');
  assert.equal(a.storyId, 'US-001');
  assert.equal(a.module, 'Authentication');
  assert.equal(a.priority, 'Critical');
  assert.deepEqual(a.tags, ['smoke', 'auth']);
  assert.deepEqual(a.data.map((d) => [d.name, d.kind]), [['email', 'env'], ['password', 'env'], ['wrong_password', 'literal']]);
  assert.equal(a.data[0].flowVariable, 'MAESTRO_TEST_USER_EMAIL');
  assert.equal(a.steps[2].expected, 'The dashboard is displayed');
  assert.equal(a.status, 'valid');
  assert.equal(a.automation, 'automatable');
  assert.equal(b.automation, 'manual');
  assert.notEqual(a.hash, b.hash);
  assert.equal(parseMarkdownCases(CASES_MD, 'x.md')[0].hash, a.hash, 'the hash depends on the case text only');

  const csv = parseCsvCases('Test Case ID,Title,Test Steps,Expected Result,Priority\nTC-9,Open settings,"1. Tap Settings\n2. Tap Profile",Profile is shown,High\n', 'cases.csv');
  assert.equal(csv.problems.length, 0);
  assert.equal(csv.cases[0].steps.length, 2);
  assert.equal(csv.cases[0].expected[0], 'Profile is shown');
  const noSteps = parseCsvCases('ID,Title\nTC-1,x\n', 'bad.csv');
  assert.match(noSteps.problems.join(' '), /no column named like "steps"/);
});

// ------------------------------------------------------------------ scaffold

test('scaffold: creates the structure, touches no Playwright folder, reruns without overwriting, --update refreshes tools only', (t) => {
  const root = tempDir(t);
  mkdirSync(path.join(root, 'automation'), { recursive: true });
  writeFileSync(path.join(root, 'automation', 'keep.txt'), 'playwright');
  writeFileSync(path.join(root, 'CLAUDE.md'), '# My project\n');
  const run = (...args) => { const r = spawnSync(process.execPath, [MOBILE_INIT, '--root', root, ...args], { encoding: 'utf8' }); return { code: r.status, json: JSON.parse(r.stdout) }; };

  const dry = run('--dry-run');
  assert.ok(dry.json.created.length > 20);
  assert.ok(!existsSync(path.join(root, 'mobile-automation')), 'dry run writes nothing');

  const first = run();
  assert.equal(first.code, 0);
  const fw = path.join(root, 'mobile-automation');
  for (const p of ['tools/maestro-cli.mjs', 'tools/lib/run.mjs', 'flows/common/launch-app.yaml', 'tests/smoke.yaml', 'tests/critical.yaml', 'tests/regression.yaml', 'config/environments', 'test-data', 'docs/flow-conventions.md', 'state/scaffold.json', '.gitignore', '.env.example', 'README.md']) {
    assert.ok(existsSync(path.join(fw, p)), `${p} exists`);
  }
  assert.equal(read(path.join(root, 'automation', 'keep.txt')), 'playwright');
  assert.ok(!existsSync(path.join(root, 'dependencies')), 'does not create the Playwright dependencies folder');
  assert.match(read(path.join(root, 'CLAUDE.md')), /^# My project[\s\S]*<!-- builder-mobile:start -->[\s\S]*<!-- builder-mobile:end -->/);
  assert.match(read(path.join(fw, '.gitignore')), /^\.env$/m);

  writeFileSync(path.join(fw, 'flows', 'common', 'launch-app.yaml'), '# mine\n');
  writeFileSync(path.join(fw, 'tools', 'maestro-cli.mjs'), '// old tools\n');
  const again = run();
  assert.equal(again.json.created.length, 0);
  assert.equal(read(path.join(fw, 'flows', 'common', 'launch-app.yaml')), '# mine\n', 'user file untouched');
  assert.equal(read(path.join(fw, 'tools', 'maestro-cli.mjs')), '// old tools\n', 'tools untouched without --update');
  assert.match(again.json.warnings.join(' '), /--update/);

  const upd = run('--update');
  assert.ok(upd.json.overwritten.includes('mobile-automation/tools/maestro-cli.mjs'));
  assert.notEqual(read(path.join(fw, 'tools', 'maestro-cli.mjs')), '// old tools\n');
  assert.equal(read(path.join(fw, 'flows', 'common', 'launch-app.yaml')), '# mine\n', '--update never touches user files');
  assert.equal(readJson(path.join(fw, 'state', 'scaffold.json')).toolsVersion, readJson(path.join(PLUGIN, 'template', 'mobile', 'tools', 'version.json')).toolsVersion);
});

test('scaffold: refuses the Playwright folders and a Cowork session folder; tools version follows the plugin version', (t) => {
  const root = tempDir(t);
  const bad = spawnSync(process.execPath, [MOBILE_INIT, '--root', root, '--dir', 'automation'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /belongs to the Playwright framework/);

  const session = tempDir(t);
  mkdirSync(path.join(session, 'mnt', 'MyProject'), { recursive: true });
  const r = spawnSync(process.execPath, [MOBILE_INIT], { cwd: session, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).needsInput, 'root');
  assert.ok(!existsSync(path.join(session, 'mobile-automation')));

  assert.equal(readJson(path.join(PLUGIN, 'template', 'mobile', 'tools', 'version.json')).toolsVersion, readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json')).version);
});

// ------------------------------------------------------------------ discovery

function flutterFixture(root) {
  const w = (rel, content) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, content); };
  w('shop_app/pubspec.yaml', 'name: shop_app\nversion: 2.3.1+7\ndependencies:\n  flutter:\n    sdk: flutter\n');
  w('shop_app/android/app/build.gradle', `android {\n  namespace "com.acme.shop"\n  defaultConfig { applicationId "com.acme.shop" }\n  productFlavors {\n    staging { applicationIdSuffix ".staging" }\n    prod { }\n  }\n}\n`);
  w('shop_app/ios/Runner.xcodeproj/project.pbxproj', 'PRODUCT_BUNDLE_IDENTIFIER = com.acme.shop;\nPRODUCT_BUNDLE_IDENTIFIER = com.acme.shop.RunnerTests;\n');
  w('shop_app/lib/login.dart', "Semantics(identifier: 'login_submit_button', child: ElevatedButton(key: Key('x')));\nSemantics(identifier: \"login_email_field\", child: TextField());\n");
  w('shop_app/build/app/outputs/flutter-apk/app-debug.apk', 'apk');
  w('shop_app/integration_test/app_test.dart', '// test');
  w('test-design/test-cases/US-001-testcase.md', CASES_MD);
}

test('discover: finds the Flutter app, ids, flavors, builds, identifiers and existing test input without writing anything', (t) => {
  const p = newProject(t, { configure: false });
  flutterFixture(p.root);
  const before = readdirSync(p.root).sort();
  const r = p.run(['discover']);
  assert.equal(r.code, 0, r.stdout);
  const f = r.json.flutter;
  assert.equal(f.root, 'shop_app');
  assert.equal(f.name, 'shop_app');
  assert.deepEqual(f.android.applicationIds, ['com.acme.shop']);
  assert.deepEqual(f.android.flavors, ['staging', 'prod']);
  assert.match(f.android.notes.join(' '), /applicationIdSuffix/);
  assert.deepEqual(f.ios.bundleIds, ['com.acme.shop']);
  assert.deepEqual(f.ios.testBundleIds, ['com.acme.shop.RunnerTests']);
  assert.equal(f.builds[0].platform, 'android');
  assert.match(f.builds[0].path, /app-debug\.apk$/);
  assert.equal(f.accessibility.identifiers, 2);
  assert.equal(f.accessibility.keys, 1);
  assert.equal(f.existingTests.integrationTest, true);
  assert.equal(r.json.automation.testDesignOutput, 'test-design/test-cases');
  assert.deepEqual(readdirSync(p.root).sort(), before, 'discovery is read-only');
});

test('the CLI accepts --root before or after the command, and runs from the plugin copy before the project has its own', (t) => {
  const p = newProject(t, { configure: false });
  flutterFixture(p.root);
  const lead = spawnSync(process.execPath, [TEMPLATE_CLI, '--root', p.root, 'discover'], { encoding: 'utf8', cwd: tempDir(t) });
  assert.equal(JSON.parse(lead.stdout).flutter.name, 'shop_app');
  const trail = spawnSync(process.execPath, [TEMPLATE_CLI, 'preflight', '--platform', 'android', `--root=${p.root}`], { encoding: 'utf8', env: p.env() });
  assert.equal(JSON.parse(trail.stdout).checks.find((c) => c.id === 'maestro').status, 'ok');
  const help = spawnSync(process.execPath, [TEMPLATE_CLI, 'help'], { encoding: 'utf8' });
  assert.ok(Object.keys(JSON.parse(help.stdout).commands).length > 15);
});

test('discover: several Flutter apps are reported as ambiguous, none is chosen', (t) => {
  const p = newProject(t, { configure: false });
  flutterFixture(p.root);
  mkdirSync(path.join(p.root, 'other_app', 'android'), { recursive: true });
  writeFileSync(path.join(p.root, 'other_app', 'pubspec.yaml'), 'name: other_app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  const r = p.run(['discover']);
  assert.equal(r.json.ambiguous, true);
  assert.equal(r.json.flutter, null);
  assert.equal(r.json.candidates.length, 2);
  assert.equal(p.run(['discover', '--app', 'shop_app']).json.flutter.name, 'shop_app');
});

// ------------------------------------------------------------------ configuration

test('config: material choices are never defaulted; wrong values are refused; a complete config is valid', (t) => {
  const p = newProject(t, { configure: false });
  const absent = p.run(['config', 'check']);
  assert.equal(absent.code, 2);
  assert.equal(absent.json.status, 'absent');

  const partial = p.run(['config', 'save', '--json', JSON.stringify({ platforms: { android: { enabled: true } } })]);
  assert.equal(partial.code, 2);
  assert.deepEqual(partial.json.issues.map((i) => i.field).sort(), ['environments.default', 'platforms.android.appId']);

  const bad = p.run(['config', 'save', '--json', JSON.stringify({ platforms: { android: { appId: 'not an id' } } })]);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /not a valid Android application ID/);

  const ok = p.run(['config', 'save', '--json', JSON.stringify({ platforms: { android: { enabled: true, appId: 'com.acme.shop' } }, environments: { default: 'staging' } })]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.status, 'valid');
  assert.equal(readJson(path.join(p.fw, 'config', 'mobile.config.json')).execution.requirePhysicalDevice, true);

  const mismatch = p.run(['config', 'save', '--json', JSON.stringify({ platforms: { ios: { enabled: true, bundleId: 'com.acme.shop.ios' } }, flows: { appIdMode: 'literal' } })]);
  assert.equal(mismatch.code, 1, 'literal appId mode cannot serve two different identifiers');
});

test('config: environment files may not carry secrets', async (t) => {
  const p = newProject(t);
  p.write('mobile-automation/config/environments/leaky.json', JSON.stringify({ API_TOKEN: 'abc' }));
  const { loadEnvironment, makeContext } = await lib('config');
  const ctx = makeContext({ root: p.root, here: path.join(PLUGIN, 'x', 'y') });
  assert.throws(() => loadEnvironment(ctx, 'leaky'), /looks like a secret/);
});

// ------------------------------------------------------------------ cases, mapping, change detection

test('cases + map: new cases are planned, a registered flow is unchanged, a source edit regenerates or asks for review', (t) => {
  const p = newProject(t);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD);
  const parsed = p.run(['cases', 'parse']);
  assert.equal(parsed.code, 0, parsed.stdout);
  assert.equal(parsed.json.total, 2);
  assert.deepEqual(parsed.json.manual, ['TC-002']);
  assert.deepEqual(parsed.json.envNames, ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD']);

  let plan = p.run(['map', 'plan']).json;
  assert.deepEqual(plan.items.map((i) => [i.id, i.action]), [['TC-001', 'generate'], ['TC-002', 'skip']]);
  assert.match(plan.items[1].reason, /manual/i);

  p.writeFlow('authentication/tc-001-valid-user-can-sign-in.yaml', testFlow({ id: 'TC-001' }));
  const reg = p.run(['map', 'register', '--test', 'TC-001', '--flow', 'flows/authentication/tc-001-valid-user-can-sign-in.yaml']);
  assert.equal(reg.code, 0, reg.stdout);
  plan = p.run(['map', 'plan']).json;
  assert.equal(plan.items[0].state, 'unchanged');
  assert.equal(plan.counts.generate, 0);

  const wrongId = p.run(['map', 'register', '--test', 'TC-002', '--flow', 'flows/authentication/tc-001-valid-user-can-sign-in.yaml']);
  assert.equal(wrongId.code, 1);
  assert.match(wrongId.json.error, /says "# testCase: TC-001"/);

  // the test case changes: the untouched generated flow may be regenerated
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD.replace('The heading "Dashboard" is visible', 'The heading "Home" is visible'));
  plan = p.run(['map', 'plan']).json;
  assert.equal(plan.items[0].state, 'source_changed');
  assert.equal(plan.items[0].action, 'regenerate');
  assert.deepEqual(p.run(['map', 'changes']).json.changed, [{ id: 'TC-001', flow: 'flows/authentication/tc-001-valid-user-can-sign-in.yaml', action: 'regenerate' }]);

  // ...but a flow a person edited is never overwritten: review
  p.writeFlow('authentication/tc-001-valid-user-can-sign-in.yaml', `${testFlow({ id: 'TC-001' })}# my edit\n`);
  plan = p.run(['map', 'plan']).json;
  assert.equal(plan.items[0].action, 'review');
  assert.match(plan.items[0].reason, /edited by hand/);

  // a case removed from the source is reported, its flow kept
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD.split('## TC-002')[0]);
  plan = p.run(['map', 'plan']).json;
  assert.ok(plan.items.find((i) => i.id === 'TC-001'));
  assert.equal(plan.removed.length, 0);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD.replace('TC-001', 'TC-100').replace(/## TC-002[\s\S]*/, ''));
  plan = p.run(['map', 'plan']).json;
  assert.deepEqual(plan.removed.map((r) => r.id), ['TC-001']);
  assert.equal(existsSync(path.join(p.fw, 'flows/authentication/tc-001-valid-user-can-sign-in.yaml')), true);
});

test('map: a case recorded as blocked keeps its reason and is offered again; manual cases are never generated', (t) => {
  const p = newProject(t);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD);
  p.run(['cases', 'parse']);
  const blocked = p.run(['map', 'register', '--test', 'TC-001', '--status', 'blocked', '--reason', 'No stable id for the Sign in button']);
  assert.equal(blocked.code, 0, blocked.stdout);
  assert.equal(blocked.json.flow, null);
  assert.deepEqual(p.run(['map', 'status']).json.cases.map((c) => [c.id, c.status, c.reason]), [['TC-001', 'blocked', 'No stable id for the Sign in button']]);
  const plan = p.run(['map', 'plan']).json;
  assert.equal(plan.items[0].state, 'blocked_before');
  assert.equal(plan.items[0].action, 'generate');
  assert.match(plan.items[0].reason, /No stable id/);
  assert.equal(plan.counts.retryBlocked, 1);
  assert.equal(plan.items[1].action, 'skip');
  assert.equal(p.run(['map', 'register', '--test', 'TC-001', '--status', 'whatever']).code, 1);
  assert.equal(p.run(['map', 'register', '--test', 'TC-001']).code, 1, 'a mapped case needs its flow');
});

test('env sync adds names (never values) to .env and .env.example', (t) => {
  const p = newProject(t);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD);
  const r = p.run(['env', 'sync']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.variables.map((v) => v.flowVariable), ['MAESTRO_TEST_USER_EMAIL', 'MAESTRO_TEST_USER_PASSWORD']);
  assert.match(read(path.join(p.fw, '.env.example')), /^TEST_USER_EMAIL=$/m);
  const env = read(path.join(p.fw, '.env'));
  assert.match(env, /^TEST_PASSWORD=Sup3rSecret!x$/m, 'existing values are kept');
  assert.match(env, /^TEST_USER_EMAIL=$/m);
  assert.ok(!r.stdout.includes('Sup3rSecret'), 'values are never printed');
});

// ------------------------------------------------------------------ validation

test('validate: a good flow passes; each rule catches its defect with file and line', (t) => {
  const p = newProject(t);
  p.writeFlow('auth/tc-001-good.yaml', testFlow({ id: 'TC-001' }));
  assert.equal(p.run(['validate']).code, 0);

  const bad = (name, body, extra = {}) => p.writeFlow(`bad/${name}.yaml`, testFlow({ id: name.toUpperCase(), body, ...extra }));
  bad('tc-coords', '- tapOn:\n    point: 50%,50%\n- assertVisible: Home\n');
  bad('tc-coords-ok', '# coordinates: reason: the map has no accessibility nodes\n- tapOn:\n    point: 50%,50%\n- assertVisible: Home\n');
  bad('tc-noassert', '- tapOn:\n    id: a\n');
  bad('tc-secret', '- tapOn:\n    id: password_field\n- inputText: hunter22\n- assertVisible: Home\n');
  bad('tc-secret-literal', '- tapOn:\n    id: password_field\n- inputText: wrong-pass-1   # literal:wrong-pass-1\n- assertVisible: Home\n');
  bad('tc-optional', '- assertVisible:\n    text: Home\n    optional: true\n');
  bad('tc-missing-ref', '- runFlow: ../common/nope.yaml\n- assertVisible: Home\n');
  bad('tc-index', '- tapOn:\n    text: Item\n    index: 2\n- assertVisible: Home\n');
  bad('tc-back', '- back\n- assertVisible: Home\n');
  bad('tc-yaml', '- tapOn: [unclosed\n');
  p.writeFlow('bad/tc-appid.yaml', testFlow({ id: 'TC-APPID' }).replace('${APP_ID}', 'com.other.app'));
  p.writeFlow('bad/tc-nolink.yaml', testFlow({ id: 'TC-NOLINK' }).replace('# testCase: TC-NOLINK\n', ''));
  p.writeFlow('bad/tc-dup.yaml', testFlow({ id: 'TC-001' }));

  const r = p.run(['validate']);
  assert.equal(r.code, 2);
  const codes = (file) => (r.json.files.find((f) => f.file.endsWith(file))?.issues ?? []).map((i) => `${i.severity}:${i.code}`);
  assert.ok(codes('tc-coords.yaml').includes('error:coordinates_without_reason'));
  assert.deepEqual(codes('tc-coords-ok.yaml').filter((c) => c.startsWith('error')), []);
  assert.ok(codes('tc-coords-ok.yaml').includes('warning:coordinates_used'));
  assert.ok(codes('tc-noassert.yaml').includes('error:no_assertions'));
  assert.ok(codes('tc-secret.yaml').includes('error:hardcoded_secret'));
  assert.deepEqual(codes('tc-secret-literal.yaml').filter((c) => c.startsWith('error')), [], 'a literal: value is allowed');
  assert.ok(codes('tc-optional.yaml').includes('error:assertion_optional'));
  assert.ok(codes('tc-missing-ref.yaml').includes('error:runflow_missing'));
  assert.ok(codes('tc-index.yaml').includes('warning:index_without_reason'));
  assert.ok(codes('tc-back.yaml').includes('warning:platform_specific'));
  assert.ok(codes('tc-yaml.yaml').includes('error:yaml_syntax'));
  assert.ok(codes('tc-appid.yaml').includes('error:app_id_mismatch'));
  assert.ok(codes('tc-nolink.yaml').includes('error:testcase_link_missing'));
  assert.ok(codes('tc-dup.yaml').includes('error:testcase_duplicate') || codes('tc-001-good.yaml').includes('error:testcase_duplicate'));
  const line = r.json.files.find((f) => f.file.endsWith('tc-coords.yaml')).issues.find((i) => i.code === 'coordinates_without_reason').line;
  assert.ok(Number.isInteger(line) && line > 6, 'issues carry a line number');
  assert.equal(r.json.files.some((f) => f.file.includes('launch-app')), false, 'a clean subflow produces no findings');
});

test('validate: a runFlow cycle is an error', (t) => {
  const p = newProject(t);
  p.writeFlow('common/a.yaml', 'appId: ${APP_ID}\n---\n- runFlow: b.yaml\n');
  p.writeFlow('common/b.yaml', 'appId: ${APP_ID}\n---\n- runFlow: a.yaml\n');
  const r = p.run(['validate']);
  assert.equal(r.code, 2);
  assert.ok(JSON.stringify(r.json.files).includes('runflow_cycle'));
});

// ------------------------------------------------------------------ preflight and devices

test('preflight: reports versions and the flags the installed Maestro offers; names what is missing and why, installs nothing', (t) => {
  const p = newProject(t, { configure: false });
  const r = p.run(['preflight', '--platform', 'android']);
  const byId = Object.fromEntries(r.json.checks.map((c) => [c.id, c]));
  assert.equal(byId.maestro.status, 'ok');
  assert.equal(byId.maestro.version, '1.99.0');
  assert.equal(byId.adb.status, 'ok');
  assert.equal(r.json.capabilities.helpRead, true);
  assert.equal(r.json.capabilities.root.device, true);
  assert.equal(r.json.capabilities.test.debugOutput, true);
  assert.equal(r.json.capabilities.test.testOutputDir, false, 'a flag the help does not list is not assumed');
  assert.equal(r.json.capabilities.commands.hierarchy, true);

  // no Maestro, no adb on PATH
  const none = new Project(p.root, path.dirname(process.execPath), p.state);
  const missing = none.run(['preflight', '--platform', 'android']);
  assert.equal(missing.code, 2);
  const ids = missing.json.missing.map((m) => m.id);
  assert.ok(ids.includes('maestro') && ids.includes('adb'));
  assert.match(missing.json.missing.find((m) => m.id === 'maestro').purpose, /Runs the YAML flows/);
  assert.ok(missing.json.missing.find((m) => m.id === 'maestro').hint);
});

test('preflight: iOS is reported unsupported on a non-Mac host instead of being faked', (t) => {
  if (process.platform === 'darwin') return t.skip('Mac host');
  const p = newProject(t, { configure: false });
  const r = p.run(['preflight', '--platform', 'ios']);
  assert.equal(r.json.checks.find((c) => c.id === 'xcode').status, 'unsupported');
  const d = p.run(['devices', '--platform', 'ios']);
  assert.equal(d.code, 2);
  assert.match(d.json.ios.blocker, /need a Mac/);
  assert.ok(d.json.ios.connectSteps.length > 0);
});

test('devices: physical vs emulator, authorisation states with exact fixes, and connect steps when no phone is attached', (t) => {
  const p = newProject(t, { configure: false });
  p.devices = [PHONE, EMULATOR, { id: 'ZZ99', state: 'unauthorized' }, { id: 'YY88', state: 'offline' }];
  const r = p.run(['devices', '--platform', 'android']);
  assert.equal(r.code, 0);
  const d = Object.fromEntries(r.json.android.devices.map((x) => [x.id, x]));
  assert.equal(d.R5CT1234ABC.kind, 'physical');
  assert.equal(d.R5CT1234ABC.model, 'Pixel 7');
  assert.equal(d.R5CT1234ABC.osVersion, '14');
  assert.equal(d.R5CT1234ABC.authorised, true);
  assert.equal(d['emulator-5554'].kind, 'emulator');
  assert.equal(d.ZZ99.authorised, false);
  assert.match(d.ZZ99.fix.join(' '), /Allow USB debugging/);
  assert.match(d.YY88.fix.join(' '), /adb kill-server/);
  assert.equal(r.json.android.physicalReady, 1);

  p.devices = [EMULATOR];
  const none = p.run(['devices', '--platform', 'android']);
  assert.equal(none.code, 2, 'an emulator alone is not a physical device');
  assert.equal(none.json.android.physicalReady, 0);
  assert.match(none.json.android.connectSteps.join(' '), /USB debugging/);
});

test('device verify: needs Maestro to read the device and the app to be installed', (t) => {
  const p = newProject(t);
  const ok = p.run(['device', 'verify', '--platform', 'android']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(ok.json.checks.map((c) => [c.id, c.ok]), [['detected', true], ['authorised', true], ['maestro_reachable', true], ['app_installed', true]]);
  assert.equal(ok.json.app.versionName, '1.2.3');

  p.devices = [{ ...PHONE, packages: [] }];
  const noApp = p.run(['device', 'verify', '--platform', 'android']);
  assert.equal(noApp.code, 2);
  assert.equal(noApp.json.checks.find((c) => c.id === 'app_installed').ok, false);

  p.devices = [PHONE];
  p.extraEnv.FAKE_HIERARCHY_FAIL = '1';
  const stuck = p.run(['device', 'verify', '--platform', 'android']);
  assert.equal(stuck.code, 2);
  assert.equal(stuck.json.checks.find((c) => c.id === 'maestro_reachable').ok, false);
});

test('app install needs an explicit approval and installs only on a connected, authorised device', (t) => {
  const p = newProject(t);
  p.write('build/app.apk', 'apk');
  const refused = p.run(['app', 'install', '--platform', 'android', '--device', PHONE.id, '--artifact', 'build/app.apk']);
  assert.equal(refused.code, 2);
  assert.equal(refused.json.needsInput, 'approval');
  const done = p.run(['app', 'install', '--platform', 'android', '--device', PHONE.id, '--artifact', 'build/app.apk', '--approved']);
  assert.equal(done.code, 0, done.stdout);
  assert.equal(done.json.ok, true);
});

// ------------------------------------------------------------------ run

const calls = (p) => (existsSync(path.join(p.state, 'maestro-calls.jsonl')) ? read(path.join(p.state, 'maestro-calls.jsonl')).trim().split('\n').map((l) => JSON.parse(l)) : []);

test('run: a passing smoke flow on a physical device records metadata, evidence, reports and physical-device validation; secrets stay off the command line and out of logs', (t) => {
  const p = newProject(t);
  p.writeFlow('auth/tc-001-sign-in.yaml', testFlow({ id: 'TC-001', fake: 'print-secret' }));
  const r = p.run(['run', '--platform', 'android', '--suite', 'smoke']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'passed');
  assert.equal(r.json.device.physical, true);
  assert.equal(r.json.device.model, 'Pixel 7');
  assert.equal(r.json.app.versionName, '1.2.3');
  assert.equal(r.json.maestro.version, '1.99.0');
  assert.equal(r.json.validation.validated, true);

  const dir = path.join(p.fw, 'reports', r.json.runId);
  const run = readJson(path.join(dir, 'run.json'));
  assert.equal(run.environment, 'staging');
  assert.equal(run.platform, 'android');
  assert.equal(run.scope.description, 'suite smoke');
  assert.deepEqual(run.scope.flows, ['flows/auth/tc-001-sign-in.yaml']);
  for (const f of ['summary.md', 'summary.json', 'report.html', 'junit.xml', 'results.json', 'coverage.json']) assert.ok(existsSync(path.join(dir, f)), f);
  assert.equal(readJson(path.join(p.fw, 'state', 'device-validation.json')).platforms.android.validated, true);

  const call = calls(p).find((c) => c.mode === 'print-secret');
  assert.equal(call.device, PHONE.id);
  assert.equal(call.secretInEnv, true, 'the secret reaches Maestro through the process environment');
  assert.ok(!call.argv.join(' ').includes('Sup3rSecret'), 'and never through the command line');
  assert.ok(call.argv.includes('APP_ID=com.example.app') && call.argv.includes('BASE_URL=https://staging.example.test'));
  const log = read(path.join(p.fw, 'artifacts', r.json.runId, readdirSync(path.join(p.fw, 'artifacts', r.json.runId))[0], 'maestro.log'));
  assert.ok(!log.includes('Sup3rSecret'));
  assert.match(log, /typed \*\*\*/);
  assert.ok(!r.stdout.includes('Sup3rSecret'));
  assert.equal(r.json.report.coverage.total, 0);
});

test('run: a failing flow is classified, keeps its evidence, and does not stop or erase the others', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001-pass.yaml', testFlow({ id: 'TC-001' }));
  p.writeFlow('a/tc-002-notfound.yaml', testFlow({ id: 'TC-002', fake: 'element-not-found' }));
  p.writeFlow('a/tc-003-assert.yaml', testFlow({ id: 'TC-003', fake: 'assert' }));
  p.writeFlow('a/tc-004-launch.yaml', testFlow({ id: 'TC-004', fake: 'launch-fail' }));
  p.writeFlow('a/tc-005-pass.yaml', testFlow({ id: 'TC-005' }));
  const r = p.run(['run', '--platform', 'android', '--feature', 'a']);
  assert.equal(r.code, 0, 'failing tests are a completed execution, not a tool error');
  assert.equal(r.json.outcome, 'failed');
  assert.deepEqual(r.json.counts, { total: 5, passed: 2, failed: 3, skipped: 0, notRun: 0 });
  const by = Object.fromEntries(r.json.results.map((x) => [x.testCase, x]));
  assert.equal(by['TC-001'].status, 'passed');
  assert.equal(by['TC-005'].status, 'passed', 'the run continued after failures');
  assert.deepEqual([by['TC-002'].category, by['TC-002'].confidence], ['automation', 'medium']);
  assert.deepEqual([by['TC-003'].category, by['TC-003'].confidence, by['TC-003'].needsConfirmation], ['application', 'low', true]);
  assert.equal(by['TC-004'].category, 'environment');

  const results = readJson(path.join(p.fw, 'reports', r.json.runId, 'results.json'));
  const failed = results.find((x) => x.testCase === 'TC-002');
  assert.match(failed.failedCommand.description, /Tap on id: login_button/);
  assert.ok(failed.artifacts.some((a) => a.endsWith('maestro.log')));
  assert.ok(failed.artifacts.some((a) => a.endsWith('.png')), 'a failure screenshot is kept');
  assert.ok(failed.artifacts.some((a) => a.endsWith('hierarchy-at-failure.json')), 'the hierarchy of the failing screen is kept for diagnosis');
  assert.ok(existsSync(path.join(p.fw, results.find((x) => x.testCase === 'TC-001').folder, 'maestro.log')), 'the passing flow keeps its artifacts');
  assert.match(read(path.join(p.fw, 'reports', r.json.runId, 'junit.xml')), /<failure type="automation"/);
  assert.equal(p.run(['run', '--platform', 'android', '--feature', 'a', '--strict']).code, 1, '--strict turns failures into a failing exit code');
});

test('run: a project path with spaces works (flow paths are quoted for the Windows batch launcher)', (t) => {
  const p = newProject(t, { spaced: true });
  p.writeFlow('a/tc-001.yaml', testFlow({ id: 'TC-001' }));
  const r = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.outcome, 'passed');
  assert.ok(calls(p).at(-1).flow.includes('my mobile project'));
});

test('run: an emulator alone is refused; with --allow-emulator it runs but is not physical-device validation', (t) => {
  const p = newProject(t);
  p.devices = [EMULATOR];
  p.writeFlow('a/tc-001.yaml', testFlow({ id: 'TC-001' }));
  const refused = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(refused.code, 2);
  assert.equal(refused.json.needsInput, 'physical_device');
  assert.match(refused.json.error, /real physical device/);
  assert.ok(refused.json.connectSteps.length > 0);

  const ran = p.run(['run', '--platform', 'android', '--all', '--allow-emulator']);
  assert.equal(ran.code, 0, ran.stdout);
  assert.equal(ran.json.outcome, 'passed');
  assert.equal(ran.json.device.physical, false);
  assert.equal(ran.json.validation.validated, false);
  assert.match(ran.json.validation.reason, /not physical-device validation/);
  assert.match(read(path.join(p.fw, 'reports', ran.json.runId, 'summary.md')), /does \*\*not\*\* count as physical-device validation/);
  assert.match(read(path.join(p.fw, 'reports', ran.json.runId, 'report.html')), /does not count as physical-device validation/);
  const status = p.run(['validation', 'status']);
  assert.equal(status.json.fullyValidated, false);
  assert.equal(status.json.platforms[0].physicalDeviceValidated, false);
});

test('run: several physical devices are never guessed; a missing app or missing secret stops before any flow runs', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001.yaml', testFlow({ id: 'TC-001' }));
  p.devices = [PHONE, { ...PHONE, id: 'SECOND99' }];
  const many = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(many.code, 2);
  assert.equal(many.json.needsInput, 'device');
  assert.equal(many.json.devices.length, 2);
  assert.equal(p.run(['run', '--platform', 'android', '--all', '--device', 'SECOND99', '--plan']).json.device.id, 'SECOND99');

  p.devices = [{ ...PHONE, packages: [] }];
  const noApp = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(noApp.code, 2);
  assert.equal(noApp.json.needsInput, 'app_install');
  assert.equal(calls(p).filter((c) => c.mode).length, 0, 'no flow was started');

  p.devices = [PHONE];
  writeFileSync(path.join(p.fw, '.env'), '');
  const noSecret = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(noSecret.code, 2);
  assert.equal(noSecret.json.needsInput, 'env');
  assert.deepEqual(noSecret.json.missing, ['MAESTRO_TEST_PASSWORD']);
  assert.ok(!JSON.stringify(noSecret.json).includes('Sup3rSecret'));
});

test('run: invalid flows stop the run before it reaches the device', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001.yaml', testFlow({ id: 'TC-001', body: '- tapOn:\n    id: a\n' }));
  const r = p.run(['run', '--platform', 'android', '--all']);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /Validation found/);
  assert.equal(calls(p).length, 0);
  assert.ok(!existsSync(path.join(p.fw, 'reports')) || readdirSync(path.join(p.fw, 'reports')).length === 0, 'no run folder for a run that never started');
});

test('run: losing the device mid-run is a device failure; the remaining flows are "not run" and earlier evidence is kept', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001-pass.yaml', testFlow({ id: 'TC-001' }));
  p.writeFlow('a/tc-002-lose.yaml', testFlow({ id: 'TC-002', fake: 'lose-device' }));
  p.writeFlow('a/tc-003-after.yaml', testFlow({ id: 'TC-003' }));
  const r = p.run(['run', '--platform', 'android', '--feature', 'a']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.status, 'incomplete');
  assert.equal(r.json.outcome, 'failed');
  const by = Object.fromEntries(r.json.results.map((x) => [x.testCase, x]));
  assert.equal(by['TC-001'].status, 'passed');
  assert.deepEqual([by['TC-002'].status, by['TC-002'].category], ['failed', 'device']);
  assert.deepEqual([by['TC-003'].status, by['TC-003'].category], ['not_run', 'device']);
  assert.equal(r.json.counts.notRun, 1);
});

test('run: a flow that hangs is stopped at the time limit and reported, not left running', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001-hang.yaml', testFlow({ id: 'TC-001', fake: 'hang' }));
  p.writeFlow('a/tc-002-after.yaml', testFlow({ id: 'TC-002' }));
  const r = p.run(['run', '--platform', 'android', '--feature', 'a', '--timeout', '2']);
  const by = Object.fromEntries(r.json.results.map((x) => [x.testCase, x]));
  assert.equal(by['TC-001'].status, 'failed');
  assert.equal(by['TC-001'].category, 'unclassified');
  assert.match(by['TC-001'].reason, /time limit/);
  assert.equal(by['TC-002'].status, 'passed');
});

test('run: selection by flow, test case ID and tag; platform-specific flows are skipped on the other platform; subflows cannot be run', (t) => {
  const p = newProject(t);
  p.writeFlow('a/tc-001.yaml', testFlow({ id: 'TC-001', tags: ['smoke', 'regression'] }));
  p.writeFlow('a/tc-002.yaml', testFlow({ id: 'TC-002', tags: ['regression'] }));
  p.writeFlow('a/tc-003.ios.yaml', testFlow({ id: 'TC-003', tags: ['regression'] }));
  const plan = (...a) => p.run(['run', '--platform', 'android', '--plan', ...a]);
  assert.deepEqual(plan('--suite', 'smoke').json.flows, ['flows/a/tc-001.yaml']);
  assert.deepEqual(plan('--suite', 'regression').json.flows, ['flows/a/tc-001.yaml', 'flows/a/tc-002.yaml']);
  assert.deepEqual(plan('--suite', 'regression').json.skipped.map((s) => s.rel), ['flows/a/tc-003.ios.yaml']);
  assert.deepEqual(plan('--test', 'TC-002').json.flows, ['flows/a/tc-002.yaml']);
  assert.deepEqual(plan('--flow', 'flows/a/tc-001.yaml').json.flows, ['flows/a/tc-001.yaml']);
  assert.deepEqual(plan('--tag', 'smoke').json.flows, ['flows/a/tc-001.yaml']);
  const sub = plan('--flow', 'flows/common/launch-app.yaml');
  assert.equal(sub.code, 1);
  assert.match(sub.json.error, /reusable subflow/);
  const none = p.run(['run', '--platform', 'android']);
  assert.equal(none.json.needsInput, 'scope');
  assert.equal(calls(p).length, 0, '--plan never starts a flow');
});

// ------------------------------------------------------------------ reports and coverage

test('report: coverage lists every test case as automated or not (with the reason); formats can be changed', (t) => {
  const p = newProject(t);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD + `\n## TC-003: Needs steps\n\n### Expected Results\n- Something\n`);
  p.run(['cases', 'parse']);
  p.writeFlow('authentication/tc-001-sign-in.yaml', testFlow({ id: 'TC-001' }));
  p.run(['map', 'register', '--test', 'TC-001', '--flow', 'flows/authentication/tc-001-sign-in.yaml']);
  const r = p.run(['run', '--platform', 'android', '--all']);
  const cov = p.run(['report', 'coverage', r.json.runId]).json;
  assert.equal(cov.total, 3);
  assert.equal(cov.automated, 1);
  assert.deepEqual(cov.rows.map((x) => [x.id, x.automated, x.reason ?? x.result]), [['TC-001', true, 'passed'], ['TC-002', false, 'manual'], ['TC-003', false, 'needs_clarification']]);
  assert.match(read(path.join(p.fw, 'reports', r.json.runId, 'summary.md')), /1 of 3 test cases have a flow/);

  const off = p.run(['report', 'formats', '--set', 'junit']);
  assert.deepEqual(off.json.formats, ['junit']);
  const rebuilt = p.run(['report', 'build', r.json.runId]);
  assert.deepEqual(rebuilt.json.written.sort(), ['coverage.json', 'junit.xml', 'summary.json', 'summary.md']);
  assert.equal(p.run(['report', 'formats', '--set', 'pdf']).code, 1, 'unknown formats are refused');
  assert.equal(p.run(['report', 'list']).json.runs[0].runId, r.json.runId);
});

// ------------------------------------------------------------------ repair guard

const HEAL_FLOW = testFlow({
  id: 'TC-001',
  body: '- runFlow: ../common/launch-app.yaml\n- tapOn:\n    id: login_button\n- assertVisible:\n    id: home_title\n',
});
const HIERARCHY = JSON.stringify({ attributes: {}, children: [{ attributes: { 'resource-id': 'login_submit_button', text: 'Sign in' }, children: [] }] });

function healSetup(t) {
  const p = newProject(t);
  p.writeFlow('a/tc-001.yaml', HEAL_FLOW);
  p.write('mobile-automation/artifacts/h.json', HIERARCHY);
  return p;
}

test('heal: a selector id repair proven by the real hierarchy is accepted, logged, and keeps the flow regenerable', (t) => {
  const p = healSetup(t);
  p.write('test-design/test-cases/US-001-testcase.md', CASES_MD);
  p.run(['cases', 'parse']);
  p.run(['map', 'register', '--test', 'TC-001', '--flow', 'flows/a/tc-001.yaml']);
  const start = p.run(['heal', 'start', 'run1', '--flow', 'flows/a/tc-001.yaml']);
  assert.equal(start.json.attemptsLeft, 1);
  p.writeFlow('a/tc-001.yaml', HEAL_FLOW.replace('login_button', 'login_submit_button'));
  const check = p.run(['heal', 'check', 'run1', '--flow', 'flows/a/tc-001.yaml', '--evidence', 'mobile-automation/artifacts/h.json', '--rationale', 'The app renamed the id of the same Sign in button.']);
  assert.equal(check.code, 0, check.stdout);
  assert.deepEqual(check.json.changes.map((c) => [c.from, c.to]), [['login_button', 'login_submit_button']]);
  const fin = p.run(['heal', 'finish', 'run1', '--flow', 'flows/a/tc-001.yaml', '--result', 'passed', '--rerun', 'run2']);
  assert.equal(fin.json.outcome, 'healed');
  assert.match(read(path.join(p.fw, 'flows/a/tc-001.yaml')), /login_submit_button/);
  assert.equal(readJson(path.join(p.fw, 'state', 'healing-log.json')).entries.at(-1).outcome, 'healed');
  assert.equal(p.run(['map', 'plan']).json.items[0].state, 'unchanged', 'the repaired flow is still considered as generated');
});

test('heal: every repair that is not a proven selector change is reverted automatically', (t) => {
  const p = healSetup(t);
  const flowPath = 'flows/a/tc-001.yaml';
  let n = 0;
  const attempt = (edit, extra = ['--evidence', 'mobile-automation/artifacts/h.json', '--rationale', 'because']) => {
    const runId = `run-${n += 1}`;
    const s = p.run(['heal', 'start', runId, '--flow', flowPath]);
    if (s.code !== 0) return s;
    p.writeFlow('a/tc-001.yaml', edit(HEAL_FLOW));
    return p.run(['heal', 'check', runId, '--flow', flowPath, ...extra]);
  };
  const reverted = (r, re) => { assert.equal(r.code, 2, r.stdout); assert.equal(r.json.reverted, true); assert.match(r.json.violations.join(' | '), re); assert.equal(read(path.join(p.fw, flowPath)), HEAL_FLOW, 'the original flow is restored'); };

  reverted(attempt((f) => f.replace('    id: home_title\n', '')), /entries became|keys changed|structure changed/);               // assertion deleted
  reverted(attempt((f) => f.replace('id: home_title', 'text: Home\n    optional: true')), /keys changed/);                                  // weakened with optional
  reverted(attempt((f) => f.replace('login_button', 'login_submit_button').replace('- runFlow', '- back\n- runFlow')), /entries became/);  // extra command
  reverted(attempt((f) => f.replace('login_button', 'point_free_text')), /does not appear in the captured screen hierarchy/);          // not proven on the real screen
  reverted(attempt((f) => f.replace('login_button', 'login_submit_button'), ['--rationale', 'x']), /screen evidence is required/);       // no evidence
  reverted(attempt((f) => f.replace('login_button', 'login_submit_button'), ['--evidence', 'mobile-automation/artifacts/h.json']), /rationale is required/);
});

test('heal: a failed re-run restores the flow; the attempt limit holds; a hand-written flow is never repaired', (t) => {
  const p = healSetup(t);
  const flowPath = 'flows/a/tc-001.yaml';
  p.run(['heal', 'start', 'r', '--flow', flowPath]);
  p.writeFlow('a/tc-001.yaml', HEAL_FLOW.replace('login_button', 'login_submit_button'));
  assert.equal(p.run(['heal', 'check', 'r', '--flow', flowPath, '--evidence', 'mobile-automation/artifacts/h.json', '--rationale', 'same button']).code, 0);
  assert.equal(p.run(['heal', 'finish', 'r', '--flow', flowPath, '--result', 'failed']).json.outcome, 'reverted');
  assert.equal(read(path.join(p.fw, flowPath)), HEAL_FLOW);
  assert.equal(p.run(['heal', 'start', 'r', '--flow', flowPath]).code, 0);
  assert.equal(p.run(['heal', 'check', 'r', '--flow', flowPath, '--evidence', 'mobile-automation/artifacts/h.json', '--rationale', 'x']).code, 2, 'unchanged flow is not a repair');
  const third = p.run(['heal', 'start', 'r', '--flow', flowPath]);
  assert.equal(third.code, 1);
  assert.match(third.json.error, /already used its 2 repair attempts/);

  p.writeFlow('a/tc-002-mine.yaml', testFlow({ id: 'TC-002', header: false }));
  const mine = p.run(['heal', 'start', 'r2', '--flow', 'flows/a/tc-002-mine.yaml']);
  assert.equal(mine.code, 1);
  assert.match(mine.json.error, /yours and is never repaired/);
});

// ------------------------------------------------------------------ inspection and semantics

test('inspect hierarchy lists selector candidates and the clickable controls that have no id; semantics requests are recorded once', (t) => {
  const p = newProject(t);
  const r = p.run(['inspect', 'hierarchy', '--platform', 'android', '--name', 'login screen']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.candidates.find((c) => c.id === 'login_submit_button'), { id: 'login_submit_button', text: 'Sign in', label: null, hint: null, clickable: true, className: 'Button' });
  assert.deepEqual(r.json.interactiveWithoutId, ['Forgot password?']);
  assert.ok(existsSync(path.join(p.root, r.json.saved)));

  const add = (extra = []) => p.run(['semantics', 'add', '--screen', 'Login', '--control', 'Forgot password link', '--suggested-id', 'login_forgot_password_link', '--reason', 'only text, which is translated', ...extra]);
  assert.equal(add().json.id, 'SEM-1');
  assert.equal(add().json.added, false, 'the same request is not added twice');
  const second = p.run(['semantics', 'add', '--screen', 'Home', '--control', 'Menu', '--suggested-id', 'home_menu_button', '--reason', 'icon only', '--test', 'TC-007']);
  assert.equal(second.json.id, 'SEM-2');
  assert.deepEqual(p.run(['semantics', 'list']).json.requests.map((x) => [x.id, x.suggestedId, x.status]), [['SEM-1', 'login_forgot_password_link', 'open'], ['SEM-2', 'home_menu_button', 'open']]);
});

test('identifiers scan reads Semantics identifiers from the Dart code', (t) => {
  const p = newProject(t);
  flutterFixture(p.root);
  const r = p.run(['identifiers', 'scan', '--app', 'shop_app', '--write']);
  assert.deepEqual(r.json.identifiers.map((i) => i.id), ['login_email_field', 'login_submit_button']);
  assert.ok(existsSync(path.join(p.fw, 'state', 'identifiers.json')));
});

// ------------------------------------------------------------------ classification table

test('classify: the rule table keeps ambiguous readings at low confidence', async () => {
  const { classifyFailure } = await lib('classify');
  const c = (log, more = {}) => classifyFailure({ exitCode: 1, log, ...more });
  assert.equal(c('adb: no devices/emulators found').category, 'device');
  assert.equal(c('io.grpc.StatusRuntimeException: UNAVAILABLE: io exception').category, 'device');
  assert.equal(c('Failed to parse flow: unknown command "tapon"').category, 'automation');
  assert.equal(c('ReferenceError: MAESTRO_X is not defined').category, 'automation');
  assert.equal(c('the app has crashed').category, 'application');
  assert.equal(c('Unable to launch app com.x').category, 'environment');
  assert.deepEqual([c('Assertion is false: "Dashboard" is visible').category, c('Assertion is false: "Dashboard" is visible').confidence], ['application', 'low']);
  assert.equal(c('Element not found: Text matching regex: Login').category, 'automation');
  assert.equal(c('something odd').category, 'unclassified');
  assert.equal(classifyFailure({ exitCode: null, spawnError: 'ENOENT', log: '' }).category, 'environment');
});

// ------------------------------------------------------------------ existing Playwright side unchanged

test('the plugin manifest and the Playwright scaffolder are untouched by the mobile feature', () => {
  const init = read(path.join(PLUGIN, 'scripts', 'init.mjs'));
  assert.ok(!/mobile/i.test(init), 'init.mjs does not mention mobile');
  const claudeBlock = read(path.join(PLUGIN, 'template', 'CLAUDE.builder.md'));
  assert.ok(!/builder-mobile/.test(claudeBlock));
  assert.ok(existsSync(path.join(PLUGIN, 'template', 'dependencies', 'engine', 'cli', 'pipeline.ts')));
});

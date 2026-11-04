// Test design -> automation: the handoff of the design stages' test cases, automation readiness, the run contract for
// /design-test-n-automation, and the story -> ... -> result traceability. The design stages themselves are the plugin's Python
// tooling (test-design/); here a design folder is written by hand in the shape those tools leave.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../engine/config/load-config.ts';
import { designDirOf } from '../engine/pipeline/design-handoff.ts';
import type { HandoffDocument } from '../engine/pipeline/design-handoff.ts';
import { assessCase, assessReadiness } from '../engine/pipeline/readiness.ts';
import { checkStageOutputs } from '../engine/pipeline/stage-contracts.ts';
import { createRun } from '../engine/pipeline/run-manager.ts';
import { buildTraceability, renderTraceabilityMarkdown } from '../engine/pipeline/traceability-report.ts';
import type { TestSpec } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';
import { tmpRoot, validConfig, writeDep, writeFile } from './helpers.ts';

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

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const LOGIN_FILE = [
  '# Login', 'User Story ID: US-001', '',
  '## AUTO-aaaa1111: Valid user signs in', 'Priority: High', '',
  '### Test Data', '- email: env:TEST_USER_EMAIL', '- password: env:TEST_USER_PASSWORD', '',
  '### Steps', '1. Open the login page', '2. Enter {email} in the Email field', '3. Enter {password} in the Password field', '4. Click the "Sign in" button -> Expected: The dashboard is displayed', '',
  '### Expected Results', '- The heading "Dashboard" is visible', '',
  '## AUTO-bbbb2222: Wrong password shows an error', '',
  '### Test Data', '- email: env:TEST_USER_EMAIL', '- password: literal:not-the-password-1', '',
  '### Steps', '1. Open the login page', '2. Enter {email} in the Email field', '3. Enter {password} in the Password field', '4. Click the "Sign in" button', '',
  '### Expected Results', '- The message "Invalid email or password" is displayed', '',
  '## AUTO-cccc3333: Bot sign in is stopped by the CAPTCHA', '',
  '### Steps', '1. Open the login page', '2. Solve the CAPTCHA shown under the form', '',
  '### Expected Results', '- The sign in is refused', '',
].join('\n');

interface Design { project: string; designDir: string; workflow: any; trace: any }

// <project>/test-design/ the way the design stages leave it: one saved story with three cases.
function design(t: { after: (fn: () => void) => void }, file = LOGIN_FILE) {
  const root = tmpRoot(t);
  const project = path.dirname(root);
  const designDir = designDirOf(root);
  writeFile(designDir, 'test-cases/US-001-testcase.md', file);
  writeFile(designDir, 'state/analysis/US-001.json', JSON.stringify({
    story_id: 'US-001', story_summary: 'Login', behaviour_to_validate: ['sign in'], analysis_complete: true,
    acceptance_criteria_interpretation: [{ label: 'AC-1', text: 'A valid user reaches the dashboard' }, { label: 'AC-2', text: 'A wrong password shows an error' }, { label: 'AC-3', text: 'Bots are stopped' }],
    business_rules: [{ label: 'BR-1', text: 'Five failed attempts lock the account' }],
  }));
  const workflow = {
    version: 1, runId: 'run-20261101-100000', status: 'completed', projectRoot: project, sourceFiles: ['stories/detailed_stories.md'],
    currentPhase: 'done', createdAt: 'x', updatedAt: 'x',
    stories: { 'US-001': { status: 'saved', sourceFile: 'stories/detailed_stories.md', testCaseIds: ['AUTO-aaaa1111', 'AUTO-bbbb2222', 'AUTO-cccc3333'],
      testCaseFile: { path: 'test-design/test-cases/US-001-testcase.md', sha256: sha(file), caseCount: 3, sourceSha256: 'src1' } },
      'US-002': { status: 'pending' } },
  };
  const trace = {
    version: 1,
    stories: { 'US-001': { sourceFile: 'stories/detailed_stories.md', title: 'Registered user login', criteria: ['AC-1', 'AC-2', 'AC-3', 'BR-1'], status: 'analysed', testCaseFile: 'test-design/test-cases/US-001-testcase.md' } },
    cases: {
      'AUTO-aaaa1111': { title: 'Valid user signs in', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-1'], techniques: ['positive'], scenarioKey: 'k1' },
      'AUTO-bbbb2222': { title: 'Wrong password shows an error', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-2'], techniques: ['negative'], scenarioKey: 'k2' },
      'AUTO-cccc3333': { title: 'Bot sign in is stopped by the CAPTCHA', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-3'], techniques: ['negative'], scenarioKey: 'k3' },
    },
  };
  writeFile(designDir, 'state/workflow.json', JSON.stringify(workflow));
  writeFile(designDir, 'state/traceability.json', JSON.stringify(trace));
  saveConfig(root, validConfig());
  return { root, project, designDir, workflow, trace } as Design & { root: string };
}

const designed = (d: Design & { root: string }) => path.join(d.designDir, 'test-cases', 'US-001-testcase.md');
const imported = (root: string) => path.join(dependenciesDir(root), 'input', 'test-cases', 'design');

// ---------- readiness ----------

function spec(over: Partial<TestSpec>): TestSpec {
  return {
    id: 'T-1', title: 'A case', source: { path: 'input/x.md', line: 1, originalId: 'T-1', sheet: null }, suite: null, module: 'M', moduleSlug: 'm',
    priority: null, tags: [], preconditions: [], steps: [{ index: 1, action: 'Open the home page', expected: null }], expectedResults: ['The heading is visible'],
    testData: [], ambiguities: [], status: 'ready', ...over,
  };
}

test('readiness: a plain case is automatable', () => {
  const r = assessCase(spec({}));
  assert.equal(r.verdict, 'automatable');
  assert.deepEqual(r.workflows, ['navigate: home page']);
});

test('readiness: cases that need a person are manual, each with its reason', () => {
  const cases: [string, string, string][] = [
    ['Solve the CAPTCHA', 'captcha', 'a CAPTCHA'],
    ['Enter the one-time code sent by SMS', 'out_of_band_code', 'a code delivered outside the browser'],
    ['Open the email and click the link in the email', 'mailbox', 'a real mailbox'],
    ['Print the receipt on the printer', 'physical_device', 'hardware'],
    ['Wait for 3 days', 'long_elapsed_time', 'days'],
  ];
  for (const [action, code] of cases) {
    const r = assessCase(spec({ steps: [{ index: 1, action, expected: null }] }));
    assert.equal(r.verdict, 'manual', action);
    assert.ok(r.reasons.some((x) => x.code === code), `${action}: ${JSON.stringify(r.reasons)}`);
  }
  assert.equal(assessCase(spec({ tags: ['Manual'] })).verdict, 'manual');
  assert.equal(assessCase(spec({ expectedResults: ['The page looks good'] })).reasons[0]?.code, 'subjective_judgement');
});

test('readiness: the user can override a manual flag, and the override is recorded', () => {
  const s = spec({ id: 'T-9', steps: [{ index: 1, action: 'Solve the CAPTCHA', expected: null }] });
  const r = assessReadiness({ schemaVersion: 2, generatedAt: '', sources: [], specs: [s] }, { overrides: new Set(['T-9']) });
  assert.equal(r.cases[0]!.verdict, 'automatable_with_prerequisites');
  assert.deepEqual(r.overridden, ['T-9']);
});

test('readiness: preconditions, dependencies and unset env values are prerequisites; incomplete cases are blocked', () => {
  const s = spec({
    preconditions: ['An active account exists'], dependsOn: ['T-0'],
    testData: [{ name: 'password', value: null, envVar: 'TEST_PASSWORD', declaredLiteral: false }],
  });
  const r = assessCase(s, { presentEnvVars: new Set() });
  assert.equal(r.verdict, 'automatable_with_prerequisites');
  assert.deepEqual(r.prerequisites.missingEnvVars, ['TEST_PASSWORD']);
  assert.deepEqual(r.reasons.map((x) => x.code), ['has_preconditions', 'depends_on_cases', 'missing_env_vars']);
  assert.ok(r.workflows.includes('authentication') && r.workflows.includes('dependency chain (runs in order)'));
  assert.equal(assessCase(s, { presentEnvVars: new Set(['TEST_PASSWORD']) }).prerequisites.missingEnvVars.length, 0);

  const b = assessCase(spec({ status: 'needs_clarification', ambiguities: [{ kind: 'missing_expected_result', message: 'no expected result', stepIndex: null }] }));
  assert.equal(b.verdict, 'blocked');
  assert.equal(b.reasons[0]!.code, 'missing_expected_result');
});

// ---------- handoff ----------

test('design status explains a project without test design', (t) => {
  const root = tmpRoot(t);
  const r = cli(root, 'design', 'status');
  assert.equal(r.code, 2);
  assert.match(r.json.issues[0], /no test-design\/ folder/);
});

test('handoff without --apply judges readiness and writes nothing', (t) => {
  const d = design(t);
  const r = must(d.root, 'design', 'handoff');
  assert.equal(r.dryRun, true);
  assert.equal(r.applied, false);
  assert.deepEqual(r.stories, ['US-001']);
  assert.deepEqual(r.readiness, { total: 3, automatable: 0, automatable_with_prerequisites: 2, manual: 1, blocked: 0 });
  assert.deepEqual(r.manual.map((m: any) => m.id), ['AUTO-cccc3333']);
  assert.ok(r.manual[0].reasons.some((x: any) => x.code === 'captcha'));
  assert.deepEqual(r.notHandedOver.map((n: any) => n.story), ['US-002']);
  assert.equal(existsSync(imported(d.root)), false);
  assert.equal(existsSync(path.join(dependenciesDir(d.root), 'state', 'design-handoff.json')), false);
});

test('handoff --apply imports only the cases that can be automated, keeps the design links, and is idempotent', (t) => {
  const d = design(t);
  const r = must(d.root, 'design', 'handoff', '--apply');
  assert.equal(r.applied, true);
  assert.equal(r.inputPath, 'input/test-cases/design');
  assert.deepEqual(readdirSync(imported(d.root)).sort(), ['AUTO-aaaa1111.md', 'AUTO-bbbb2222.md']);
  assert.deepEqual(r.missingEnvVars, ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD']);

  const doc = JSON.parse(readFileSync(path.join(dependenciesDir(d.root), 'state', 'design-handoff.json'), 'utf8')) as HandoffDocument;
  assert.equal(doc.designRunId, 'run-20261101-100000');
  assert.deepEqual(doc.stories['US-001']!.caseIds, ['AUTO-aaaa1111', 'AUTO-bbbb2222', 'AUTO-cccc3333']);
  assert.deepEqual(doc.stories['US-001']!.criteria.map((c) => [c.label, c.kind, c.text]), [
    ['AC-1', 'acceptance_criterion', 'A valid user reaches the dashboard'],
    ['AC-2', 'acceptance_criterion', 'A wrong password shows an error'],
    ['AC-3', 'acceptance_criterion', 'Bots are stopped'],
    ['BR-1', 'business_rule', 'Five failed attempts lock the account'],
  ]);
  const c1 = doc.cases['AUTO-aaaa1111']!;
  assert.deepEqual([c1.storyIds, c1.covers, c1.techniques, c1.scenarioKey, c1.module], [['US-001'], ['US-001#AC-1'], ['positive'], 'k1', 'Login']);
  assert.equal(c1.importedFile, 'input/test-cases/design/AUTO-aaaa1111.md');
  assert.equal(doc.cases['AUTO-cccc3333']!.importedFile, null);
  assert.equal(doc.cases['AUTO-cccc3333']!.verdict, 'manual');

  // the design file is never touched
  assert.equal(readFileSync(designed(d), 'utf8'), LOGIN_FILE);
  // the second time nothing changes
  const again = must(d.root, 'design', 'handoff', '--apply');
  assert.deepEqual(again.imported.created, []);
  assert.equal(again.imported.unchanged.length, 2);
});

test('a regenerated case replaces its unedited import; a case the design dropped is removed; hand edits are never overwritten', (t) => {
  const d = design(t);
  must(d.root, 'design', 'handoff', '--apply');
  const changed = LOGIN_FILE.replace('The message "Invalid email or password" is displayed', 'The message "Invalid credentials" is displayed');
  writeFileSync(designed(d), changed);
  d.workflow.stories['US-001'].testCaseFile.sha256 = sha(changed);
  writeFile(d.designDir, 'state/workflow.json', JSON.stringify(d.workflow));
  const r = must(d.root, 'design', 'handoff', '--apply');
  assert.deepEqual(r.imported.updated, ['input/test-cases/design/AUTO-bbbb2222.md']);
  assert.match(readFileSync(path.join(imported(d.root), 'AUTO-bbbb2222.md'), 'utf8'), /Invalid credentials/);

  // a person edits an imported copy; the design then changes that same case again: refused, nothing written
  const copy = path.join(imported(d.root), 'AUTO-bbbb2222.md');
  writeFileSync(copy, readFileSync(copy, 'utf8') + '\n- Note: edited by a person\n');
  const again = LOGIN_FILE.replace('The message "Invalid email or password" is displayed', 'The message "Try again" is displayed');
  writeFileSync(designed(d), again);
  d.workflow.stories['US-001'].testCaseFile.sha256 = sha(again);
  writeFile(d.designDir, 'state/workflow.json', JSON.stringify(d.workflow));
  const refused = cli(d.root, 'design', 'handoff', '--apply');
  assert.equal(refused.code, 2);
  assert.match(refused.json.issues[0], /AUTO-bbbb2222\.md already exist.*did not write/);
  assert.match(readFileSync(copy, 'utf8'), /edited by a person/);

  // the design drops the second case: the first stays, the edited copy is kept with a warning
  const dropped = LOGIN_FILE.replace(/## AUTO-bbbb2222[\s\S]*?(?=## AUTO-cccc3333)/, '');
  writeFileSync(designed(d), dropped);
  d.workflow.stories['US-001'].testCaseFile.sha256 = sha(dropped);
  writeFile(d.designDir, 'state/workflow.json', JSON.stringify(d.workflow));
  const pruned = must(d.root, 'design', 'handoff', '--apply');
  assert.deepEqual(pruned.imported.removed, []);
  assert.ok(pruned.warnings.some((w: string) => /AUTO-bbbb2222\.md.*edited after it was imported, so it was kept/.test(w)));
  assert.equal(existsSync(path.join(imported(d.root), 'AUTO-aaaa1111.md')), true);
});

test('a design file edited by hand after it was saved is handed over with a warning; a missing one is refused', (t) => {
  const d = design(t);
  writeFileSync(designed(d), LOGIN_FILE + '\n');
  const r = must(d.root, 'design', 'handoff');
  assert.ok(r.warnings.some((w: string) => /edited by hand after it was saved/.test(w)));

  const gone = design(t);
  rmSync(designed(gone));
  const bad = cli(gone.root, 'design', 'handoff');
  assert.equal(bad.code, 2);
  assert.match(bad.json.issues[0], /is missing although the design run saved it/);
});

test('story selection hands over only the chosen stories and rejects unknown ones', (t) => {
  const d = design(t);
  const bad = cli(d.root, 'design', 'handoff', '--story', 'US-404');
  assert.equal(bad.code, 2);
  assert.match(bad.json.issues[0], /US-404 is not part of the test-design run/);
  const pending = cli(d.root, 'design', 'handoff', '--story', 'US-002');
  assert.equal(pending.code, 2);
  assert.match(pending.json.notHandedOver[0].reason, /not saved/);
  const ok = must(d.root, 'design', 'handoff', '--story', 'US-001');
  assert.deepEqual(ok.stories, ['US-001']);
});

test('--override-manual lets the user automate a flagged case and refuses unknown IDs', (t) => {
  const d = design(t);
  const r = must(d.root, 'design', 'handoff', '--apply', '--override-manual', 'AUTO-cccc3333');
  assert.deepEqual(r.manual, []);
  assert.ok(existsSync(path.join(imported(d.root), 'AUTO-cccc3333.md')));
  const bad = cli(d.root, 'design', 'handoff', '--override-manual', 'NOPE-1');
  assert.equal(bad.code, 2);
});

test('readiness of any input path works without a design run', (t) => {
  const root = tmpRoot(t);
  writeDep(root, 'input/test-cases/x.md', '# X\n\n## X-1: Check the inbox\n\n### Steps\n1. Open the email and read it\n\n### Expected Results\n- The code is shown\n');
  const r = must(root, 'design', 'readiness', '--path', 'input/test-cases');
  assert.equal(r.readiness.summary.manual, 1);
});

// ---------- the run ----------

test('a design run needs a current handoff, keeps a snapshot, and its first stage contract requires it', (t) => {
  const d = design(t);
  const refused = cli(d.root, 'run', 'create', '--command', 'design-test-n-automation');
  assert.equal(refused.code, 2);
  assert.match(refused.json.issues[0], /no design handoff yet/);

  must(d.root, 'design', 'handoff', '--apply');
  const created = must(d.root, 'run', 'create', '--command', 'design-test-n-automation');
  assert.equal(created.designRunId, 'run-20261101-100000');
  assert.equal(created.inputFiles, 2);
  const runDirPath = path.join(dependenciesDir(d.root), 'runs', created.runId);
  assert.ok(existsSync(path.join(runDirPath, 'design-handoff.json')));
  const manifest = JSON.parse(readFileSync(path.join(runDirPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.design.designRunId, 'run-20261101-100000');

  // the analysis stage may not complete without the handoff registered, and not once the inputs moved on
  const m = createRun(d.root, { command: 'design-test-n-automation', inputPaths: ['input/test-cases/design'] });
  const issues = checkStageOutputs('test_analysis', { rootDir: d.root, runDir: path.join(dependenciesDir(d.root), 'runs', m.runId), manifest: m, artifacts: {} });
  assert.ok(issues.includes('required artifact "designHandoff" is not registered'), issues.join('\n'));
  const plain = createRun(d.root, { command: 'playwright-pipeline', inputPaths: ['input/test-cases/design'] });
  const plainIssues = checkStageOutputs('test_analysis', { rootDir: d.root, runDir: path.join(dependenciesDir(d.root), 'runs', plain.runId), manifest: plain, artifacts: {} });
  assert.ok(!plainIssues.some((i) => i.includes('designHandoff')), 'other commands are unchanged');

  // editing an imported case after the handoff makes the handoff stale: a new run is refused until it is redone
  writeFileSync(path.join(imported(d.root), 'AUTO-aaaa1111.md'), readFileSync(path.join(imported(d.root), 'AUTO-aaaa1111.md'), 'utf8') + '\n');
  const stale = cli(d.root, 'run', 'create', '--command', 'design-test-n-automation');
  assert.equal(stale.code, 2);
  assert.match(stale.json.issues[0], /was edited after the handoff/);
  assert.equal(cli(d.root, 'design', 'status').json.handoff.current, false);
});

test('resuming a design run reports whether the design it started from is still current', (t) => {
  const d = design(t);
  must(d.root, 'design', 'handoff', '--apply');
  const created = must(d.root, 'run', 'create', '--command', 'design-test-n-automation');
  const ok = must(d.root, 'run', 'resume', created.runId);
  assert.deepEqual(ok.design, { current: true, issues: [] });
  const next = LOGIN_FILE.replace('Valid user signs in', 'Valid user signs in successfully');
  writeFileSync(designed(d), next);
  const moved = must(d.root, 'run', 'resume', created.runId);
  assert.equal(moved.design.current, false);
  assert.match(moved.design.issues.join(' '), /changed after the handoff/);
});

// ---------- traceability ----------

test('traceability joins story, criterion, scenario, case, script and result, and reports every gap', () => {
  const handoff: HandoffDocument = {
    schemaVersion: 1, createdAt: '', designRunId: 'run-1', designRunStatus: 'completed', inputPath: 'input/test-cases/design', warnings: [],
    readiness: { schemaVersion: 1, generatedAt: '', summary: { total: 4, automatable: 4, automatable_with_prerequisites: 0, manual: 0, blocked: 0 }, cases: [], missingEnvVars: [], overridden: [] },
    stories: {
      'US-001': {
        title: 'Login', designFile: 'test-design/test-cases/US-001-testcase.md', designFileSha256: 'x', sourceFile: null, sourceSha256: null, editedSinceSave: false,
        caseIds: ['T-1', 'T-2', 'T-3', 'T-4'],
        criteria: [
          { label: 'AC-1', kind: 'acceptance_criterion', text: 'valid login works' },
          { label: 'AC-2', kind: 'acceptance_criterion', text: 'wrong password rejected' },
          { label: 'AC-3', kind: 'acceptance_criterion', text: 'captcha' },
          { label: 'AC-4', kind: 'acceptance_criterion', text: 'nobody covers this' },
        ],
      },
    },
    cases: {
      'T-1': { title: 'valid', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-1'], techniques: ['positive'], scenarioKey: 'k1', designFile: 'f', verdict: 'automatable', reasons: [], importedFile: 'input/test-cases/design/T-1.md', importedSha256: 'a' },
      'T-2': { title: 'wrong', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-2'], techniques: ['negative'], scenarioKey: 'k2', designFile: 'f', verdict: 'automatable', reasons: [], importedFile: 'input/test-cases/design/T-2.md', importedSha256: 'a' },
      'T-3': { title: 'captcha', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-3'], techniques: ['negative'], scenarioKey: 'k3', designFile: 'f', verdict: 'manual', reasons: [{ code: 'captcha', message: 'A CAPTCHA is designed to stop automated clients' }], importedFile: null, importedSha256: null },
      'T-4': { title: 'no script', module: 'Login', storyIds: ['US-001'], covers: ['US-001#AC-2'], techniques: ['boundary'], scenarioKey: 'k4', designFile: 'f', verdict: 'automatable', reasons: [], importedFile: 'input/test-cases/design/T-4.md', importedSha256: 'a' },
    },
  };
  const result = (testId: string, outcome: 'passed' | 'failed' | 'flaky' | 'skipped') => ({ key: `${testId}@chromium`, testId, title: `[${testId}]`, file: 'tests/login.spec.ts', line: 1, project: 'chromium', outcome, attempts: [] });
  const exec = { schemaVersion: 1, runId: 'r', label: 'initial', executedAt: '', command: [], exitCode: 1, runnerError: null, rawReport: null, runnerLog: '', stats: { passed: 1, failed: 1, flaky: 0, skipped: 0, total: 2 }, tests: [result('T-1', 'passed'), result('T-2', 'failed')] } as any;
  const report = buildTraceability({
    runId: 'r', handoff, specs: null, execution: exec, regression: null,
    generation: { schemaVersion: 1, generatedAt: '', language: 'typescript', sharedFilesChanged: [], excluded: [{ testId: 'T-4', reason: 'no stable locator' }],
      tests: [{ testId: 'T-1', file: 'tests/login.spec.ts', title: '[T-1] valid' }, { testId: 'T-2', file: 'tests/login.spec.ts', title: '[T-2] wrong' }] },
  });
  const state = Object.fromEntries(report.cases.map((c) => [c.testId, c.state]));
  assert.deepEqual(state, { 'T-1': 'passed', 'T-2': 'failed', 'T-3': 'manual', 'T-4': 'not_generated' });
  const crit = Object.fromEntries(report.stories[0]!.criteria.map((c) => [c.label, c.state]));
  assert.deepEqual(crit, { 'AC-1': 'passed', 'AC-2': 'failing', 'AC-3': 'manual_only', 'AC-4': 'uncovered' });
  assert.deepEqual(report.stories[0]!.criteria[2]!.manualCases, ['T-3']);
  assert.ok(report.gaps.some((g) => /US-001#AC-4: no test case covers/.test(g)));
  assert.ok(report.gaps.some((g) => /T-4: no automation script \(no stable locator\)/.test(g)));
  const c1 = report.cases.find((c) => c.testId === 'T-1')!;
  assert.deepEqual([c1.scenario, c1.script, c1.result], [{ key: 'k1', techniques: ['positive'] }, { file: 'tests/login.spec.ts', title: '[T-1] valid' }, { outcome: 'passed', label: 'initial' }]);

  // a healed test's regression result is the latest word
  const regression = { ...exec, label: 'regression', tests: [result('T-2', 'passed')] };
  const healed = buildTraceability({ runId: 'r', handoff, specs: null, execution: exec, regression, generation: { schemaVersion: 1, generatedAt: '', language: 'typescript', sharedFilesChanged: [], excluded: [], tests: [{ testId: 'T-1', file: 'a', title: '[T-1]' }, { testId: 'T-2', file: 'a', title: '[T-2]' }, { testId: 'T-4', file: 'a', title: '[T-4]' }] } });
  assert.equal(healed.cases.find((c) => c.testId === 'T-2')!.state, 'passed');
  assert.equal(healed.cases.find((c) => c.testId === 'T-4')!.state, 'not_run');

  const md = renderTraceabilityMarkdown(report);
  assert.match(md, /Story → Acceptance criterion → Test scenario → Test case → Automation script → Execution result/);
  assert.match(md, /## Left for manual execution[\s\S]*T-3[\s\S]*CAPTCHA/);
});

test('any run can be linked to the handoff with --design, and "design trace" writes the traceability files from the run', (t) => {
  const d = design(t);
  must(d.root, 'design', 'handoff', '--apply');
  const plain = must(d.root, 'run', 'create', '--command', 'generate-tests');
  assert.equal(plain.designRunId, undefined, 'a run without --design is exactly as before');
  assert.equal(cli(d.root, 'design', 'trace', plain.runId).code, 2);

  const created = must(d.root, 'run', 'create', '--command', 'generate-tests', '--design');
  assert.equal(created.designRunId, 'run-20261101-100000');
  assert.equal(created.inputFiles, 2, 'the design input folder is the default input');
  const dir = path.join(dependenciesDir(d.root), 'runs', created.runId);
  writeFileSync(path.join(dir, 'generation-manifest.json'), JSON.stringify({
    schemaVersion: 1, generatedAt: '', language: 'typescript', sharedFilesChanged: [], excluded: [],
    tests: [{ testId: 'AUTO-aaaa1111', file: 'tests/login.spec.ts', title: '[AUTO-aaaa1111] Valid user signs in' }, { testId: 'AUTO-bbbb2222', file: 'tests/login.spec.ts', title: '[AUTO-bbbb2222] Wrong password' }],
  }));
  writeFileSync(path.join(dir, 'execution-results.json'), JSON.stringify({
    schemaVersion: 1, runId: created.runId, label: 'initial', executedAt: '', command: [], exitCode: 0, runnerError: null, rawReport: null, runnerLog: '',
    stats: { passed: 2, failed: 0, flaky: 0, skipped: 0, total: 2 },
    tests: ['AUTO-aaaa1111', 'AUTO-bbbb2222'].map((id) => ({ key: `${id}@chromium`, testId: id, title: id, file: 'tests/login.spec.ts', line: 1, project: 'chromium', outcome: 'passed', attempts: [] })),
  }));
  const r = must(d.root, 'design', 'trace', created.runId);
  assert.deepEqual(r.summary.casesByState, { passed: 2, failed: 0, flaky: 0, skipped: 0, not_run: 0, not_generated: 0, blocked: 0, manual: 1 });
  assert.deepEqual(r.summary.criteriaByState, { passed: 2, failing: 0, flaky: 0, incomplete: 0, manual_only: 1, uncovered: 1 });
  assert.ok(r.gaps.some((g: string) => /US-001#BR-1: no test case covers/.test(g)));
  const md = readFileSync(path.join(dir, 'traceability-report.md'), 'utf8');
  assert.match(md, /AUTO-cccc3333[\s\S]*CAPTCHA/);
  assert.match(md, /AC-1 \| A valid user reaches the dashboard \| passed/);
});

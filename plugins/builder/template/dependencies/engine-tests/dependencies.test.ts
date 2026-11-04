// Dependent test cases (a case needs another to have run first) and tests that sign in themselves (they start signed out and run
// last). Dependencies come only from what the input states; the engine orders and checks them, it never guesses.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkSpecsAgainstCanonical, validateCanonicalDocument } from '../engine/pipeline/canonical.ts';
import { buildChains, chainLayouts, cycleMembers, type DependencyNode } from '../engine/pipeline/dependencies.ts';
import { blockedByDependencies } from '../engine/pipeline/failure-classifier.ts';
import { sessionPlan } from '../engine/pipeline/execution-plan.ts';
import { moduleLayoutIssues } from '../engine/pipeline/generation.ts';
import { planModules } from '../engine/pipeline/modules.ts';
import { chainIssues, ownSessionIssues, scanSessionTests } from '../engine/pipeline/session-layout.ts';
import { reviewSource } from '../engine/pipeline/static-review.ts';
import { parseInputs } from '../engine/pipeline/test-case-parser.ts';
import { validateTestSpecDocument } from '../engine/pipeline/test-spec.ts';
import type { ExecutionResults, TestResult } from '../engine/pipeline/execution.ts';
import { tmpRoot, validConfig, writeFile } from './helpers.ts';

const NOW = new Date('2026-10-22T00:00:00Z');

function parse(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const project = path.dirname(tmpRoot(t));
  const abs = Object.entries(files).map(([name, text]) => writeFile(project, `input/${name}`, text));
  return { project, ...parseInputs(project, abs.sort(), NOW) };
}

const CASE = (id: string, title: string, extra = '') => `## ${id}: ${title}\n${extra}Steps:\n1. Do the thing\nExpected Result: It works as stated\n`;

const MARKDOWN = [
  '# Login', CASE('TC-001', 'Sign in'),
  '# Projects', CASE('TC-002', 'Create a project', 'Depends on: TC-001\n'), CASE('TC-003', 'Edit the project', 'Depends on: TC-002\n'),
  '# Reports', CASE('TC-004', 'Open the report'),
].join('\n');

test('"Depends on" is read into the canonical case, in any layout the input uses', (t) => {
  const md = parse(t, { 'cases.md': MARKDOWN });
  assert.deepEqual(md.errors, []);
  const byId = Object.fromEntries(md.canonical.testCases.map((c) => [c.testCaseId, c]));
  assert.equal(byId['TC-001']!.dependsOn, undefined, 'no dependency, no field');
  assert.deepEqual(byId['TC-002']!.dependsOn, ['TC-001']);
  assert.deepEqual(byId['TC-003']!.dependsOn, ['TC-002']);
  assert.deepEqual(validateCanonicalDocument(md.canonical), []);
  assert.deepEqual(checkSpecsAgainstCanonical(md.canonical, md.document), []);

  const csv = parse(t, { 'cases.csv': 'ID,Title,Module,Steps,Expected Result,Depends On\nTC-1,Sign in,Login,1. Open,Signed in,\nTC-2,Create,Projects,1. Click,Created,"TC-1"\nTC-3,Edit,Projects,1. Click,Saved,TC-1 and TC-2\n' });
  assert.deepEqual(csv.errors, []);
  assert.deepEqual(csv.canonical.testCases.map((c) => c.dependsOn ?? null), [null, ['TC-1'], ['TC-1', 'TC-2']]);
  assert.equal(csv.tables[0]!.mapped.depends, 'Depends On', 'the column was recognised, not left out');
});

test('a dependency chain across modules gets a file of its own; a chain inside one module stays in the module\'s file', (t) => {
  const { document } = parse(t, { 'cases.md': MARKDOWN });
  const bySpec = Object.fromEntries(document.specs.map((s) => [s.id, s]));
  // TC-001 (Login) -> TC-002 -> TC-003 (Projects): spans two modules.
  for (const id of ['TC-001', 'TC-002', 'TC-003']) assert.deepEqual(bySpec[id]!.layout, { module: 'Chain TC-001', moduleSlug: 'chain-tc-001' }, id);
  assert.equal(bySpec['TC-004']!.layout, undefined);
  assert.equal(bySpec['TC-002']!.module, 'Projects', 'the source module is kept');
  assert.deepEqual(validateTestSpecDocument(document), []);

  const root = tmpRoot(t);
  const plans = planModules(document, 'typescript', root);
  const chain = plans.find((p) => p.moduleSlug === 'chain-tc-001')!;
  assert.deepEqual([chain.file, chain.ready, chain.chains], ['tests/chain-tc-001.spec.ts', ['TC-001', 'TC-002', 'TC-003'], [{ id: 'TC-001', ids: ['TC-001', 'TC-002', 'TC-003'] }]]);
  assert.deepEqual(plans.map((p) => p.moduleSlug).sort(), ['chain-tc-001', 'reports'], 'the modules emptied by the chain have no file of their own');

  // generate validate: the chain is one file; splitting it up is refused
  const together = [{ testId: 'TC-001', file: 'tests/chain-tc-001.spec.ts' }, { testId: 'TC-002', file: 'tests/chain-tc-001.spec.ts' }, { testId: 'TC-003', file: 'tests/chain-tc-001.spec.ts' }, { testId: 'TC-004', file: 'tests/reports.spec.ts' }];
  assert.deepEqual(moduleLayoutIssues(together, document), []);
  const split = together.map((x) => (x.testId === 'TC-003' ? { ...x, file: 'tests/projects.spec.ts' } : x));
  assert.match(moduleLayoutIssues(split, document).join('\n'), /module "chain-tc-001" is split over 2 files/);

  // a chain inside one module is not moved: the module's file holds it, in order
  const same = parse(t, { 'cases.md': ['# Projects', CASE('TC-010', 'Create'), CASE('TC-011', 'Edit', 'Depends on: TC-010\n'), CASE('TC-012', 'Independent')].join('\n') });
  assert.ok(same.document.specs.every((s) => s.layout === undefined));
  const [projects] = planModules(same.document, 'typescript', root);
  assert.deepEqual([projects!.moduleSlug, projects!.chains], ['projects', [{ id: 'TC-010', ids: ['TC-010', 'TC-011'] }]]);
});

test('references that cannot be ordered block the case instead of being guessed', (t) => {
  const md = parse(t, {
    'cases.md': [
      '# A',
      CASE('TC-1', 'Needs something unknown', 'Depends on: TC-99\n'),
      CASE('TC-2', 'Loop one', 'Depends on: TC-3\n'), CASE('TC-3', 'Loop two', 'Depends on: TC-2\n'),
      CASE('TC-4', 'Needs the loop', 'Depends on: TC-2\n'),
      CASE('TC-5', 'Needs itself', 'Depends on: TC-5\n'),
      CASE('TC-6', 'Fine'),
    ].join('\n'),
  });
  const status = Object.fromEntries(md.document.specs.map((s) => [s.id, s]));
  const kinds = (id: string) => status[id]!.ambiguities.map((a) => a.kind);
  assert.deepEqual(kinds('TC-1'), ['unresolved_dependency']);
  assert.match(status['TC-1']!.ambiguities[0]!.message, /"TC-99".*not a test ID or title/);
  assert.ok(kinds('TC-2').includes('dependency_cycle') && kinds('TC-3').includes('dependency_cycle'));
  assert.ok(kinds('TC-4').includes('dependency_not_ready'), 'a case that needs a blocked case is blocked too');
  assert.ok(kinds('TC-5').includes('dependency_cycle'), 'a case cannot depend on itself');
  for (const id of ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5']) assert.equal(status[id]!.status, 'needs_clarification', id);
  assert.equal(status['TC-6']!.status, 'ready');
  assert.deepEqual(validateTestSpecDocument(md.document), []);
});

test('a precondition that names another case is read as a dependency, with a warning, never silently', (t) => {
  const md = parse(t, {
    'cases.md': ['# A', CASE('TC-1', 'Create'), `## TC-2: Edit\n### Preconditions\n- TC-1 has been run and a project exists\nSteps:\n1. Edit\nExpected Result: Saved\n`].join('\n'),
  });
  const two = md.document.specs.find((s) => s.id === 'TC-2')!;
  assert.deepEqual(two.dependsOn, ['TC-1']);
  assert.deepEqual(two.ambiguities.map((a) => a.kind), ['dependency_inferred']);
  assert.equal(two.status, 'ready', 'a warning, not a question');
});

test('chains: prerequisites first, stable order, loops left out', () => {
  const n = (id: string, mod: string, dependsOn?: string[]): DependencyNode => ({ id, module: mod, moduleSlug: mod.toLowerCase(), dependsOn });
  const nodes = [n('C', 'M2', ['B']), n('A', 'M1'), n('B', 'M1', ['A']), n('X', 'M3'), n('L1', 'M4', ['L2']), n('L2', 'M4', ['L1'])];
  assert.deepEqual(buildChains(nodes).map((c) => [c.ids, c.crossModule]), [[['A', 'B', 'C'], true]]);
  assert.deepEqual([...cycleMembers(nodes)].sort(), ['L1', 'L2']);
  assert.deepEqual([...chainLayouts(nodes).keys()].sort(), ['A', 'B', 'C']);
  // two independent chains stay two chains
  assert.equal(buildChains([n('A', 'M'), n('B', 'M', ['A']), n('C', 'M'), n('D', 'M', ['C'])]).length, 2);
});

const SIGNED_OUT = "test.use({ storageState: { cookies: [], origins: [] } });";

test('a test that starts signed out must carry @own-session, and the tag needs the signed-out override', () => {
  const ok = `import { test, expect } from '../fixtures/test.ts';
test.describe('Login', () => {
  test.describe('signed out', () => {
    ${SIGNED_OUT}
    test('[TC-1] signs in', { tag: ['@own-session'] }, async ({ page }) => { await expect(page).toHaveURL(/x/); });
  });
  test('[TC-2] uses the saved login', async ({ page }) => { await expect(page).toHaveURL(/x/); });
});
`;
  assert.deepEqual(ownSessionIssues(ok), []);
  assert.deepEqual(scanSessionTests(ok).map((s) => [s.testId, s.signedOut, s.tagged]), [['TC-1', true, true], ['TC-2', false, false]]);

  const untagged = ok.replace("{ tag: ['@own-session'] }, ", '');
  assert.deepEqual(ownSessionIssues(untagged).map((i) => i.rule), ['own-session-tag']);
  const tagOnly = ok.replace(SIGNED_OUT, '// signed out? no');
  assert.deepEqual(ownSessionIssues(tagOnly).map((i) => i.rule), ['own-session-override']);
  // a braces-in-text trap: the "}" in the title and the comment must not close the scope
  const tricky = ok.replace('signs in', 'signs in {then} out } ').replace(SIGNED_OUT, `${SIGNED_OUT} // } not a brace`);
  assert.deepEqual(ownSessionIssues(tricky), []);
  // a file-level override applies to the whole file
  assert.deepEqual(ownSessionIssues(`${SIGNED_OUT}\ntest('[TC-9] x', { tag: ['@own-session'] }, async () => {});\n`), []);
  assert.deepEqual(reviewSource('tests/login.spec.ts', untagged).filter((f) => f.rule === 'own-session-tag').map((f) => f.severity), ['major']);
});

test('dependent tests must be in order, inside one serial group', () => {
  const chains = [{ id: 'TC-1', ids: ['TC-1', 'TC-2'] }];
  const good = `test.describe('Projects', () => {
  test.describe.serial('chain TC-1', () => {
    test('[TC-1] create', async () => { expect(1).toBe(1); });
    test('[TC-2] edit', async () => { expect(1).toBe(1); });
  });
});
`;
  assert.deepEqual(chainIssues(good, chains), []);
  const configured = good.replace("test.describe.serial('chain TC-1', () => {", "test.describe('chain TC-1', () => {\n    test.describe.configure({ mode: 'serial' });");
  assert.deepEqual(chainIssues(configured, chains), [], 'switching the group to serial mode is as good as describe.serial');
  const parallel = good.replace('describe.serial(', 'describe(');
  assert.deepEqual(chainIssues(parallel, chains).map((i) => [i.rule, i.severity]), [['chain-serial', 'critical']]);
  const reversed = `test.describe.serial('c', () => {
  test('[TC-2] edit', async () => { expect(1).toBe(1); });
  test('[TC-1] create', async () => { expect(1).toBe(1); });
});
`;
  assert.deepEqual(chainIssues(reversed, chains).map((i) => i.rule), ['chain-order']);
  // two serial groups in a row: the group that closed earlier does not count for a test outside it
  const split = `test.describe.serial('a', () => {
  test('[TC-1] create', async () => { expect(1).toBe(1); });
});
test.describe.serial('b', () => {
  test('[TC-2] edit', async () => { expect(1).toBe(1); });
});
`;
  assert.deepEqual(chainIssues(split, chains).map((i) => i.rule), ['chain-serial']);
  assert.deepEqual(reviewSource('tests/p.spec.ts', parallel, 'test', chains).filter((f) => f.rule === 'chain-serial').length, 1);
});

test('the login setup must use the helper that re-checks the saved session', () => {
  const plain = "import { test as setup } from '../fixtures/test.ts';\nsetup('authenticate', async ({ page }) => { await page.goto('/'); });\n";
  assert.deepEqual(reviewSource('auth/auth.setup.ts', plain, 'support').filter((f) => f.rule === 'auth-gate').map((f) => f.severity), ['major']);
  const gated = "import { reuseOrSignIn } from '../helpers/auth.ts';\nsetup('authenticate', async ({ browser, baseURL }) => { await reuseOrSignIn({ browser, baseURL, stateFile: 's', check: async () => {}, signIn: async () => {} }); });\n";
  assert.deepEqual(reviewSource('auth/auth.setup.ts', gated, 'support').filter((f) => f.rule === 'auth-gate'), []);
  assert.deepEqual(reviewSource('pages/LoginPage.ts', plain, 'support').filter((f) => f.rule === 'auth-gate'), [], 'only the setup file');
});

test('the execution plan says what the generated tests ask of the run, and warns about signed-out tests that carry no tag', (t) => {
  const root = tmpRoot(t);
  const config = { ...validConfig(), auth: { approach: 'storage-state' as const, credentialEnvVars: [] } };
  writeFile(root, 'tests/login.spec.ts', `test.describe('Login', () => {
  ${SIGNED_OUT}
  test('[TC-1] signs in', { tag: ['@own-session'] }, async () => { expect(1).toBe(1); });
});
`);
  writeFile(root, 'tests/projects.spec.ts', `test.describe.serial('chain TC-2', () => {
  test('[TC-2] create', async () => { expect(1).toBe(1); });
  test('[TC-3] edit', async () => { expect(1).toBe(1); });
});
`);
  const ok = sessionPlan(root, config)!;
  assert.deepEqual([ok.ownSessionTests, ok.serialGroups, ok.untaggedSignedOut], [1, 1, []]);
  assert.match(ok.notes.join('\n'), /1 test\(s\) sign in themselves \(@own-session\).*run after every other test/);
  assert.match(ok.notes.join('\n'), /1 group\(s\) of dependent tests run in order/);
  assert.doesNotMatch(ok.notes.join('\n'), /first browser/);
  assert.match(sessionPlan(root, { ...config, browsers: ['chromium', 'firefox'] })!.notes.join('\n'), /run in chromium only/);

  // an older generated test starts signed out without the tag: the plan names it
  writeFile(root, 'tests/old.spec.ts', `${SIGNED_OUT}\ntest('[TC-9] old login test', async () => { expect(1).toBe(1); });\n`);
  const old = sessionPlan(root, config)!;
  assert.deepEqual(old.untaggedSignedOut, ['TC-9']);
  assert.match(old.notes.join('\n'), /not tagged @own-session \(TC-9\)/);

  // without a saved login only the serial groups matter; with nothing to say there is no plan section
  assert.equal(sessionPlan(root, validConfig())!.notes.length, 1);
  assert.equal(sessionPlan(tmpRoot(t), validConfig()), null);
});

const result = (testId: string, outcome: TestResult['outcome']): TestResult => ({
  key: `${testId}@chromium`, testId, title: `[${testId}] x`, file: 'tests/a.spec.ts', line: 1, project: 'chromium', outcome, attempts: [],
});

test('tests skipped because a test they depend on failed are reported as blocked, not as passes or failures of their own', () => {
  const run = { tests: [result('A', 'failed'), result('B', 'skipped'), result('C', 'skipped'), result('D', 'skipped'), result('E', 'passed')] } as unknown as ExecutionResults;
  const deps = new Map([['B', ['A']], ['C', ['B']], ['E', ['A']]]);
  assert.deepEqual(blockedByDependencies(run, deps).map((b) => [b.testId, b.blockedBy]), [['B', ['A']], ['C', ['B']]]);
  // D was skipped for some other reason and has no dependency: it stays a plain skip
  assert.equal(blockedByDependencies(run, deps).some((b) => b.testId === 'D'), false);
});

// Script-review reuse. Two things are expensive in script_review: the TypeScript project check and the reviewer agent.
//  - The project check is cached against a hash of every file it reads plus the TypeScript/Playwright versions, and only
//    a passing check is ever cached.
//  - The reviewer agent only needs to look at generated tests that have no valid earlier review: same test source, same
//    test case, same application evidence, same static rules and plugin (reviewer) rules, same imported framework files.
//    `review plan` lists them.
// `review seal` records a finished review (and the generated tests it covered) so the next run can skip them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AutomationConfig } from '../config/schema.ts';
import {
  FRAMEWORK_FILES, STATIC_REVIEW_VERSION, TYPECHECK_FILES, decide, fingerprintFiles, packageVersion, readEntry, rulesVersion, writeEntry,
  type CacheDecision,
} from './artifact-cache.ts';
import type { ExplorationRecord } from './exploration.ts';
import { moduleOf } from './exploration-reuse.ts';
import { specFingerprint } from './exploration-store.ts';
import { explorationEvidenceHash, generationInputs, ruleVersions, testBlockHash, testDependencyHash, type GeneratedTestPayload } from './generation-reuse.ts';
import type { GenerationManifest } from './generation.ts';
import { testBlocks, validateReviewReport, type ReviewReport } from './static-review.ts';
import type { TestSpecDocument } from './test-spec.ts';

export const REVIEW_PLAN_SCHEMA_VERSION = 1;

export interface ReviewPlanEntry {
  testId: string;
  module: string;
  file: string;
  action: 'review' | 'skip';
  reason: string;
  changed: string[];
}

export interface ReviewPlan {
  schemaVersion: typeof REVIEW_PLAN_SCHEMA_VERSION;
  generatedAt: string;
  tests: ReviewPlanEntry[];
  // Files holding at least one test that needs the reviewer: what the agent is asked to read.
  filesToReview: string[];
  summary: { review: number; skip: number };
}

export interface ReviewCtx {
  rootDir: string;
  specs: TestSpecDocument;
  record: ExplorationRecord | null;
  config: AutomationConfig;
  generation: GenerationManifest;
}

export function reviewVersions(rootDir: string): Record<string, string> {
  return { staticReview: STATIC_REVIEW_VERSION, reviewerRules: rulesVersion(rootDir, 'reviewer'), framework: fingerprintFiles(rootDir, FRAMEWORK_FILES) };
}

export function reviewInputs(c: ReviewCtx, testId: string, file: string): Record<string, string> | null {
  const spec = c.specs.specs.find((s) => s.id === testId);
  const block = testBlockHash(c.rootDir, file, testId);
  if (!spec || block === null) return null;
  return { testBlock: block, spec: specFingerprint(spec), evidence: explorationEvidenceHash(c.record, testId), deps: testDependencyHash(c.rootDir, file, testId) };
}

export function planReview(c: ReviewCtx & { force?: boolean; useCache?: boolean; now?: Date }): { plan: ReviewPlan; decisions: CacheDecision[] } {
  const versions = reviewVersions(c.rootDir);
  const decisions: CacheDecision[] = [];
  const tests = c.generation.tests.map((t): ReviewPlanEntry => {
    const spec = c.specs.specs.find((s) => s.id === t.testId);
    const inputs = reviewInputs(c, t.testId, t.file);
    const d: CacheDecision = c.force || c.useCache === false
      ? { kind: 'review', name: t.testId, action: 'rebuild', reason: c.force ? 'a fresh review was requested' : 'the artifact cache is disabled', changed: [] }
      : !inputs ? { kind: 'review', name: t.testId, action: 'rebuild', reason: `${t.testId} was not found in ${t.file}`, changed: [] }
      : decide(c.rootDir, 'review', t.testId, { inputs, versions });
    decisions.push(d);
    return { testId: t.testId, module: spec ? moduleOf(spec) : t.file, file: t.file, action: d.action === 'reuse' ? 'skip' : 'review', reason: d.reason, changed: d.changed };
  });
  const review = tests.filter((t) => t.action === 'review');
  return {
    plan: {
      schemaVersion: REVIEW_PLAN_SCHEMA_VERSION,
      generatedAt: (c.now ?? new Date()).toISOString(),
      tests,
      filesToReview: [...new Set(review.map((t) => t.file))].sort(),
      summary: { review: review.length, skip: tests.length - review.length },
    },
    decisions,
  };
}

// ---- seal ----

export interface SealInput extends ReviewCtx {
  runId: string;
  report: ReviewReport;
  plan: ReviewPlan | null;
  reviewerRan: boolean; // the test-reviewer agent was recorded for this stage
  now?: Date;
}

export interface SealResult {
  ok: boolean;
  issues: string[];
  sealed: string[];
  notSealed: { testId: string; reason: string }[];
}

export function sealReview(i: SealInput): SealResult {
  const issues = validateReviewReport(i.report);
  const pending = (i.plan?.tests ?? []).filter((t) => t.action === 'review' && i.generation.tests.some((g) => g.testId === t.testId)).map((t) => t.testId);
  if (pending.length > 0 && !i.reviewerRan) {
    issues.push(`semantic review of ${pending.join(', ')} has not happened: delegate to test-reviewer (and record it with "agents record") before sealing`);
  }
  const versions = reviewVersions(i.rootDir);
  // A test the plan skipped must still match its earlier review: a fix round may have changed it or something it relies on.
  const stale = (i.plan?.tests ?? []).filter((p) => p.action === 'skip').filter((p) => {
    const inputs = reviewInputs(i, p.testId, p.file);
    return !inputs || decide(i.rootDir, 'review', p.testId, { inputs, versions }).action !== 'reuse';
  }).map((p) => p.testId);
  if (stale.length > 0) issues.push(`${stale.join(', ')} changed after the review plan was made: run "review plan" again`);
  if (issues.length > 0) return { ok: false, issues, sealed: [], notSealed: [] };

  const rules = ruleVersions(i.rootDir);
  const sealed: string[] = [];
  const notSealed: SealResult['notSealed'] = [];
  for (const t of i.generation.tests) {
    const source = readFileSync(path.join(i.rootDir, t.file), 'utf8');
    const block = testBlocks(source).find((b) => b.testId === t.testId);
    const inputs = reviewInputs(i, t.testId, t.file);
    const spec = i.specs.specs.find((s) => s.id === t.testId);
    if (!block || !inputs || !spec) { notSealed.push({ testId: t.testId, reason: `not found in ${t.file}` }); continue; }
    // An open major finding on this test (or one that applies to its whole file) means it was not accepted as good.
    const open = i.report.findings.find((f) => f.file === t.file && f.status === 'open' && (f.severity === 'critical' || f.severity === 'major')
      && (f.line === null || (f.line >= block.startLine && f.line < block.endLine)));
    if (open) { notSealed.push({ testId: t.testId, reason: `open ${open.severity} finding ${open.id} (${open.rule})` }); continue; }

    const payload: GeneratedTestPayload = { testId: t.testId, file: t.file, title: t.title, testSha256: inputs.testBlock! };
    writeEntry(i.rootDir, {
      kind: 'generation', name: t.testId, inputs: generationInputs(spec, i.record, i.config, inputs.deps!), versions: rules, payload, by: 'review seal', runId: i.runId, now: i.now,
    });
    writeEntry(i.rootDir, {
      kind: 'review', name: t.testId, inputs, versions, payload: { testId: t.testId, file: t.file, reviewedBy: i.reviewerRan ? 'static+reviewer' : 'carried' },
      by: 'review seal', runId: i.runId, now: i.now,
    });
    sealed.push(t.testId);
  }
  return { ok: true, issues: [], sealed, notSealed };
}

// A healed test passed its rerun, so its new source is the validated one: move the cached hash to it. A test without a
// cached generation is left alone (nothing to keep in step).
export function refreshAfterHeal(rootDir: string, testId: string, file: string, runId: string, now: Date = new Date()): boolean {
  const hash = testBlockHash(rootDir, file, testId);
  const read = readEntry(rootDir, 'generation', testId);
  if (hash === null || read.status !== 'ok') return false;
  const old = read.entry.payload as GeneratedTestPayload;
  writeEntry(rootDir, {
    kind: 'generation', name: testId, inputs: read.entry.inputs, versions: read.entry.versions,
    payload: { ...old, file, testSha256: hash }, by: 'heal record', runId, now,
  });
  return true;
}

// ---- typecheck ----

export function typecheckKey(rootDir: string): { inputs: Record<string, string>; versions: Record<string, string> } {
  return {
    inputs: { tree: fingerprintFiles(rootDir, TYPECHECK_FILES), typescript: packageVersion(rootDir, 'typescript'), playwright: packageVersion(rootDir, '@playwright/test') },
    versions: {},
  };
}

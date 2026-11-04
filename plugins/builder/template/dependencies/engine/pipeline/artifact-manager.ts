// Run directory layout and artifact path rules.
//
// Pipeline state lives in dependencies/runs/<run-id>/ (the run directory). Artifact paths stored in the manifest
// are always relative to it. Playwright's own output is framework output and goes to the framework folders,
// scoped per run: automation/reports/<run-id>/<label>/ and automation/test-results/<run-id>/<label>/.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAbsoluteOrEscaping } from '../config/schema.ts';
import { dependenciesDir } from '../utils/layout.ts';

export const RUNS_RELATIVE_DIR = 'runs'; // inside dependencies/
export const REPORTS_DIR = 'reports'; // framework folder: reporter output (html, json, junit, allure)
export const EVIDENCE_DIR = 'test-results'; // framework folder: Playwright outputDir (screenshots, video, traces)
export const ADHOC_SCOPE = 'adhoc'; // output scope of a plain `playwright test` outside the pipeline

// Well-known artifact names. Only registered once the file actually exists.
export const ARTIFACTS = {
  manifest: 'manifest.json',
  inputValidation: 'input-validation.json',
  inputCopyDir: 'input', // verbatim copy of the original test-case files
  canonicalCases: 'canonical-test-cases.json', // every test case in the canonical schema, with its validation status (canonical.ts)
  testSpecs: 'test-specs.json', // projected from canonicalCases; the file generation, exploration and review read
  normalizedInputDir: 'normalized-input', // the test cases re-written in the pipeline's Markdown format, one file per module
  explorationDir: 'exploration',
  exploration: 'exploration/exploration.json',
  explorationPlan: 'exploration/exploration-plan.json', // per-test-case explore/revalidate/reuse decisions
  explorationFresh: 'exploration/fresh.json', // what the explorer observed in this run (input to `explore assemble`)
  explorationRevalidation: 'exploration/revalidation.json', // saved observations re-checked against this run's snapshots
  generationDir: 'generation', // generation plan and per-batch manifests (parallel generation)
  generationPlan: 'generation/plan.json', // per test case: generate | reuse, with reasons, and one batch per module file
  generationManifest: 'generation-manifest.json',
  generationReport: 'generation-report.md',
  reviewPlan: 'review-plan.json', // which tests still need the reviewer agent, which have a valid earlier review
  reviewReport: 'review-report.json',
  reviewSummary: 'review-report.md',
  executionResults: 'execution-results.json',
  failureAnalysis: 'failure-analysis.json',
  healingDir: 'healing', // per-attempt before-snapshots
  healingLog: 'healing-log.json',
  regressionResults: 'regression-results.json',
  rerunsDir: 'reruns', // normalized results of targeted reruns, one file per label
  summary: 'summary.json',
  summaryMarkdown: 'summary.md',
  designHandoff: 'design-handoff.json', // snapshot of the test-design handoff this run was created from (design-handoff.ts)
  traceabilityReport: 'traceability-report.json', // story -> criterion -> scenario -> case -> script -> result (traceability-report.ts)
  traceabilityMarkdown: 'traceability-report.md',
  metrics: 'metrics.json', // derived from the manifest + artifacts; safe to regenerate
  ledgerPlan: 'ledger-plan.json', // what the test ledger says each test needs this run (a preview; the stages still decide), see test-ledger.ts
  cacheDecisions: 'cache-decisions.json', // every reuse/rebuild decision of this run, with reasons
  agentUsage: 'agents.json', // which stages needed an agent, which ran deterministically, recorded invocations
  briefsDir: 'briefs', // bounded structured inputs handed to stage agents
  authState: 'auth-state.json', // how stored authentication state was handled for this run (no secrets)
  processes: 'processes.json', // processes the run started (test runner, browsers, report tools) and what was stopped afterwards
  createdData: 'created-data', // one file per test attempt (or explorer record): the test data the run created and what became of it
  dataCleanup: 'data-cleanup.json', // the sweeps that removed (or could not remove) that data, with what is left
} as const;

// Execution labels name one Playwright invocation inside a run: "initial", "heal-TC-001-1", "regression".
export const EXECUTION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export function assertExecutionLabel(label: string): void {
  if (!EXECUTION_LABEL_PATTERN.test(label)) throw new Error(`invalid execution label "${label}"`);
}

// Reporter output of one Playwright invocation: automation/reports/<run-id>/<label>/
export function reportsDirFor(rootDir: string, runId: string, label: string): string {
  assertRunId(runId);
  assertExecutionLabel(label);
  return path.join(rootDir, REPORTS_DIR, runId, label);
}

// Evidence (Playwright outputDir) of one invocation: automation/test-results/<run-id>/<label>/
export function evidenceDirFor(rootDir: string, runId: string, label: string): string {
  assertRunId(runId);
  assertExecutionLabel(label);
  return path.join(rootDir, EVIDENCE_DIR, runId, label);
}

export function runsDir(rootDir: string): string {
  return path.join(dependenciesDir(rootDir), RUNS_RELATIVE_DIR);
}

export function runDir(rootDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(runsDir(rootDir), runId);
}

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id "${runId}" (expected YYYYMMDD-HHMMSS-xxxxxx)`);
}

export function checkArtifactPath(runDirectory: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.trim() === '') return 'artifact path must be a non-empty string';
  if (isAbsoluteOrEscaping(rel)) return `artifact path "${rel}" must be relative to the run directory`;
  const abs = path.join(runDirectory, rel);
  if (!existsSync(abs)) return `artifact "${rel}" does not exist`;
  const st = statSync(abs);
  if (st.isFile() && st.size === 0) return `artifact "${rel}" is empty`;
  return null;
}

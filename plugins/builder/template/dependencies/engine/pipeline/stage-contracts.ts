// What each stage must produce before it may be marked `completed`.
// updateStage() enforces this, so a stage never advances on a missing or invalid artifact.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJson, sha256File } from '../utils/fs.ts';
import { inputBaseDir } from '../utils/layout.ts';
import { handoffCurrentIssues, validateHandoffDocument, type HandoffDocument } from './design-handoff.ts';
import { validateAutomationCoverage } from './automation-coverage.ts';
import { validateCanonicalDocument, checkSpecsAgainstCanonical, isAutomatable, type CanonicalDocument } from './canonical.ts';
import { validateExecutionResults } from './execution.ts';
import { validateExplorationRecord } from './exploration.ts';
import { validateFailureAnalysis } from './failure-classifier.ts';
import { validateGenerationManifest } from './generation.ts';
import { validateHealingLog } from './healing.ts';
import { validateInputValidationReport } from './input-validation.ts';
import { validateSummary } from './reporting.ts';
import type { RunManifest } from './run-manager.ts';
import type { Command, StageName } from './state-manager.ts';
import { validateReviewReport } from './static-review.ts';
import { validateTestSpecDocument, type TestSpecDocument } from './test-spec.ts';
import { validateTraceabilityReport } from './traceability-report.ts';

// Artifact names (manifest.artifacts keys) each stage must have registered to complete.
export const STAGE_REQUIRED_ARTIFACTS: Partial<Record<StageName, readonly string[]>> = {
  input_validation: ['inputValidation'],
  test_analysis: ['canonicalCases', 'testSpecs'],
  application_exploration: ['exploration'],
  test_generation: ['generationManifest', 'generationReport'],
  script_review: ['reviewReport'],
  execution: ['executionResults'],
  failure_triage: ['failureAnalysis'],
  healing: ['healingLog'],
  regression_validation: ['regressionResults'],
  report_generation: ['summary', 'summaryMarkdown'],
};

// Artifacts a command needs on top of its stages' own. A /design-test-n-automation run starts from a test-design handoff (the
// inputs must still be what the design recorded when the analysis stage completes) and ends with the traceability report.
export const COMMAND_REQUIRED_ARTIFACTS: Partial<Record<Command, Partial<Record<StageName, readonly string[]>>>> = {
  'design-test-n-automation': { test_analysis: ['designHandoff'], report_generation: ['traceabilityReport', 'traceabilityMarkdown'] },
};

interface Ctx {
  rootDir: string;
  runDir: string;
  manifest: RunManifest;
  artifacts: Record<string, string>; // merged: existing + being registered now
}

type Validator = (value: unknown, ctx: Ctx) => string[];

function loadSpecs(ctx: Ctx): TestSpecDocument | null {
  const rel = ctx.artifacts.testSpecs;
  if (!rel) return null;
  const r = readJson(path.join(ctx.runDir, rel));
  return r.ok ? (r.value as TestSpecDocument) : null;
}

function loadCanonical(ctx: Ctx): CanonicalDocument | null {
  const rel = ctx.artifacts.canonicalCases;
  if (!rel) return null;
  const r = readJson(path.join(ctx.runDir, rel));
  return r.ok ? (r.value as CanonicalDocument) : null;
}

const JSON_VALIDATORS: Record<string, Validator> = {
  inputValidation: (v) => validateInputValidationReport(v),
  // The canonical test cases are the gate: they must be valid, describe the input files as they are now, and include at least
  // one case that may be automated.
  canonicalCases: (v, ctx) => {
    const issues = validateCanonicalDocument(v);
    if (issues.length > 0) return issues;
    const doc = v as CanonicalDocument;
    if (doc.validation.errors.length > 0) issues.push(`the input has errors: ${doc.validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    if (!doc.testCases.some((c) => isAutomatable(c.validation.status))) issues.push('no test case is valid: every case needs clarification or is invalid');
    for (const src of doc.sources) {
      const abs = path.join(inputBaseDir(ctx.rootDir), src.path);
      if (!existsSync(abs) || sha256File(abs) !== src.sha256) issues.push(`${src.path} changed (or is gone) since it was normalized: run "specs parse" again`);
    }
    return issues;
  },
  // test-specs.json must be exactly the projection of the canonical test cases registered with it.
  testSpecs: (v, ctx) => {
    const issues = validateTestSpecDocument(v);
    if (issues.length > 0) return issues;
    const canonical = loadCanonical(ctx);
    if (!canonical) return ['the canonical test cases (canonicalCases) must be registered with the specs: they are the only accepted source'];
    return checkSpecsAgainstCanonical(canonical, v as TestSpecDocument);
  },
  exploration: (v, ctx) => validateExplorationRecord(v, { runDir: ctx.runDir, specs: loadSpecs(ctx) }),
  generationManifest: (v, ctx) => validateGenerationManifest(v, { rootDir: ctx.rootDir, specs: loadSpecs(ctx) }),
  reviewReport: (v) => validateReviewReport(v),
  executionResults: (v) => validateExecutionResults(v),
  failureAnalysis: (v) => validateFailureAnalysis(v),
  healingLog: (v, ctx) => validateHealingLog(v, ctx.manifest.healing.maxAttemptsPerTest),
  // Regression runs may contain genuine failures; only the runner itself must have worked.
  regressionResults: (v) => validateExecutionResults(v),
  summary: (v) => validateSummary(v),
  designHandoff: (v, ctx) => {
    const issues = validateHandoffDocument(v);
    return issues.length > 0 ? issues : handoffCurrentIssues(ctx.rootDir, v as HandoffDocument);
  },
  traceabilityReport: (v) => validateTraceabilityReport(v),
  // Optional for every command (not in the required lists): checked whenever it is registered.
  automationCoverage: (v) => validateAutomationCoverage(v),
};

export function checkStageOutputs(stage: StageName, ctx: Ctx): string[] {
  const issues: string[] = [];
  const required = [...(STAGE_REQUIRED_ARTIFACTS[stage] ?? []), ...(COMMAND_REQUIRED_ARTIFACTS[ctx.manifest.command]?.[stage] ?? [])];
  for (const name of required) {
    const rel = ctx.artifacts[name];
    if (!rel) { issues.push(`required artifact "${name}" is not registered`); continue; }
    if (!rel.endsWith('.json')) continue; // existence/non-empty already checked by checkArtifactPath
    const r = readJson(path.join(ctx.runDir, rel));
    if (!r.ok) { issues.push(`artifact "${name}": ${r.message}`); continue; }
    const validate = JSON_VALIDATORS[name];
    if (validate) issues.push(...validate(r.value, ctx).map((m) => `${name}: ${m}`));
  }
  if (stage === 'finalization' && ctx.artifacts.summary && ctx.manifest.testCounts === null) {
    issues.push('test counts were not recorded (run "run finalize" first)');
  }
  return issues;
}

export class StageContractError extends Error {}

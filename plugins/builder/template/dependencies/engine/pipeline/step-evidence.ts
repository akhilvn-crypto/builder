// Step evidence: the contract between the shared test fixture (which records every executed test.step while a test runs and
// takes one final-state screenshot) and the evidence-pdf report (which lays them out afterwards, next to the test's video).
//
// Per test attempt the fixture attaches one JPEG (attachment name "final") and the log itself under STEP_LOG_ATTACHMENT.
// Playwright copies path attachments into the attempt's attachments/ folder, so the log refers to the screenshot by its
// attachment NAME, and the report finds the file through the attempt's attachment list. The journey video is Playwright's own
// "video" attachment (evidence.video "on"), not part of this log. Logs written by older fixtures also carry a screenshot per
// step; those fields are ignored.
// Pure; no Playwright import (the fixtures import this file, so keep it dependency-free).

export const STEP_LOG_SCHEMA_VERSION = 1;
export const STEP_LOG_ATTACHMENT = 'step-evidence-log';
export const STEP_LOG_DIR = 'step-evidence'; // scratch folder in the test output dir; emptied once Playwright has copied the files
export const STEP_LOG_FILE = 'steps.json';
export const SCREENSHOT_MIME = 'image/jpeg';
export const SCREENSHOT_QUALITY = 85;

export interface StepEvidenceEntry {
  index: number; // 1-based, in the order the steps started
  depth: number; // 0 = top-level test.step, 1 = a step inside a step, ...
  title: string;
  status: 'passed' | 'failed';
  startedAt: string; // ISO
  durationMs: number;
  error: string | null; // first lines of the failure, secrets masked
}

export interface StepEvidenceLog {
  schemaVersion: typeof STEP_LOG_SCHEMA_VERSION;
  testTitle: string;
  steps: StepEvidenceEntry[];
  // The page as the test ended: after the last assertion, or at the failure.
  final: { status: string; screenshot: string | null; screenshotNote: string | null };
}

// Returns the validated log, or null when the value is not a log this version understands.
export function parseStepLog(v: unknown): StepEvidenceLog | null {
  if (typeof v !== 'object' || v === null) return null;
  const l = v as Partial<StepEvidenceLog>;
  if (l.schemaVersion !== STEP_LOG_SCHEMA_VERSION || !Array.isArray(l.steps) || typeof l.final !== 'object' || l.final === null) return null;
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const steps: StepEvidenceEntry[] = [];
  for (const s of l.steps as Partial<StepEvidenceEntry>[]) {
    if (typeof s !== 'object' || s === null || typeof s.title !== 'string') return null;
    steps.push({
      index: Number.isInteger(s.index) ? s.index! : steps.length + 1,
      depth: Number.isInteger(s.depth) && s.depth! >= 0 ? s.depth! : 0,
      title: s.title,
      status: s.status === 'failed' ? 'failed' : 'passed',
      startedAt: str(s.startedAt) ?? '',
      durationMs: typeof s.durationMs === 'number' ? s.durationMs : 0,
      error: str(s.error),
    });
  }
  return {
    schemaVersion: STEP_LOG_SCHEMA_VERSION,
    testTitle: str(l.testTitle) ?? '',
    steps: steps.sort((a, b) => a.index - b.index),
    final: { status: str(l.final.status) ?? 'unknown', screenshot: str(l.final.screenshot), screenshotNote: str(l.final.screenshotNote) },
  };
}

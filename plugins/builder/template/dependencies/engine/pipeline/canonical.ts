// Canonical test-case schema: the one shape every supported input (Markdown, CSV, Excel) is normalized into, and the only
// thing the rest of the pipeline trusts. Written to dependencies/runs/<run-id>/canonical-test-cases.json.
//
// `test-specs.json` (the file generation, exploration and review read) is a pure projection of this document: it is produced
// by `projectSpecs` and carries the canonical document's hash, so a spec file that was edited by hand, or that came from a
// different input, no longer matches and the pipeline refuses to continue (`checkSpecsAgainstCanonical`).
// Versioned independently from test-specs.json; documented in docs/test-spec-schema.md.

import { canonicalJson, hashValue } from './artifact-cache.ts';
import { chainLayouts } from './dependencies.ts';
import {
  AMBIGUITY_KINDS, BLOCKING_AMBIGUITIES, INPUT_FORMATS, TEST_ID_PATTERN, TEST_SPEC_SCHEMA_VERSION, slugify, validateTestSpecDocument,
  type Ambiguity, type AmbiguityKind, type InputFormat, type SourceFile, type SpecStatus, type TestDataRef, type TestSpec, type TestSpecDocument,
} from './test-spec.ts';

export const CANONICAL_SCHEMA_VERSION = '1.0.0';

// valid: nothing to report. warning: usable, with a non-blocking remark. needs_clarification: a person must answer something
// before the case can be automated. invalid: the case cannot be identified or used as written.
export const VALIDATION_STATUSES = ['valid', 'warning', 'needs_clarification', 'invalid'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

// Issue kinds that make a case `invalid` rather than `needs_clarification`.
export const INVALID_KINDS: readonly AmbiguityKind[] = ['untitled_case'];

export interface CanonicalSource {
  file: string; // relative to dependencies/, posix
  fileName: string;
  format: InputFormat;
  sheet: string | null; // worksheet name (.xlsx)
  row: number | null; // first spreadsheet row / CSV record line of the case; null for Markdown
  endRow: number | null; // last row that belongs to the case (multi-row cases)
  line: number | null; // Markdown line of the case heading, or of the table row; null for CSV/Excel
  endLine: number | null;
  heading: string | null; // Markdown heading or spreadsheet heading row the case sits under
  originalId: string | null; // ID as written in the source, if any
}

export interface CanonicalStep {
  stepNumber: number; // 1-based
  action: string; // original wording
  testData?: TestDataRef[]; // data this step uses (its own row's data, plus {name} placeholders it mentions)
  expectedResult?: string; // step-level expected result, original wording
}

export interface CanonicalIssue {
  code: AmbiguityKind;
  severity: 'blocking' | 'warning';
  message: string;
  stepNumber: number | null;
}

export interface CaseValidation {
  status: ValidationStatus;
  blocking: CanonicalIssue[];
  warnings: CanonicalIssue[];
}

export interface CanonicalCase {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  testCaseId: string; // stable ID used in test titles, results and healing records
  title: string;
  module: string; // the feature area; one test file is generated per module
  moduleSlug: string; // always slugify(module)
  suite: string | null; // the Markdown "# heading" the case sat under (informational)
  preconditions: string[];
  // testCaseIds of the cases that must run before this one (resolved from the "depends on" column/label or a precondition that
  // names another case). Absent when there are none.
  dependsOn?: string[];
  steps: CanonicalStep[];
  expectedResults: string[]; // case-level expected results, original wording
  testData: TestDataRef[]; // case-level data; credentials are env var references, never values
  priority: string | null;
  tags: string[];
  source: CanonicalSource;
  metadata: Record<string, string>; // source information no canonical field claims (header or label -> text); credentials redacted
  validation: CaseValidation;
}

export interface TableFinding {
  severity: 'blocking' | 'warning';
  kind: 'ambiguous_column_mapping' | 'inferred_columns' | 'unresolved_table';
  file: string;
  sheet: string | null;
  message: string;
  fields?: string[];
  headers?: string[];
}

export interface DocumentValidation {
  status: ValidationStatus;
  counts: Record<ValidationStatus, number>;
  errors: { path: string; message: string }[]; // unreadable or unsupported files: nothing from them is trusted
  findings: TableFinding[]; // how each table was read, where the reading needed a person or a second look
}

export interface CanonicalDocument {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  generatedAt: string;
  sources: SourceFile[];
  validation: DocumentValidation;
  testCases: CanonicalCase[];
}

// ---------- validation status ----------

export function issueOf(a: Ambiguity): CanonicalIssue {
  return { code: a.kind, severity: BLOCKING_AMBIGUITIES.includes(a.kind) ? 'blocking' : 'warning', message: a.message, stepNumber: a.stepIndex };
}

export function validationOf(ambiguities: Ambiguity[]): CaseValidation {
  const issues = ambiguities.map(issueOf);
  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const status: ValidationStatus = blocking.some((i) => INVALID_KINDS.includes(i.code)) ? 'invalid'
    : blocking.length > 0 ? 'needs_clarification'
    : warnings.length > 0 ? 'warning' : 'valid';
  return { status, blocking, warnings };
}

// Only valid and warning cases may be automated.
export function isAutomatable(status: ValidationStatus): boolean {
  return status === 'valid' || status === 'warning';
}

const WORST: ValidationStatus[] = ['invalid', 'needs_clarification', 'warning', 'valid'];

export function documentValidation(
  cases: CanonicalCase[], errors: DocumentValidation['errors'], findings: TableFinding[],
): DocumentValidation {
  const counts: Record<ValidationStatus, number> = { valid: 0, warning: 0, needs_clarification: 0, invalid: 0 };
  for (const c of cases) counts[c.validation.status]++;
  const seen = new Set<ValidationStatus>(cases.map((c) => c.validation.status));
  if (errors.length > 0) seen.add('invalid');
  if (findings.some((f) => f.severity === 'blocking')) seen.add('needs_clarification');
  if (findings.some((f) => f.severity === 'warning')) seen.add('warning');
  return { status: WORST.find((s) => seen.has(s)) ?? 'invalid', counts, errors, findings };
}

// ---------- projection to test-specs.json ----------

export function specStatusOf(status: ValidationStatus): SpecStatus {
  return isAutomatable(status) ? 'ready' : 'needs_clarification';
}

export function projectSpec(c: CanonicalCase): TestSpec {
  const ambiguities: Ambiguity[] = [...c.validation.blocking, ...c.validation.warnings]
    .map((i) => ({ kind: i.code, message: i.message, stepIndex: i.stepNumber }));
  return {
    id: c.testCaseId,
    title: c.title,
    source: { path: c.source.file, line: c.source.row ?? c.source.line ?? 0, originalId: c.source.originalId, sheet: c.source.sheet },
    suite: c.suite,
    module: c.module,
    moduleSlug: c.moduleSlug,
    priority: c.priority,
    tags: c.tags,
    preconditions: c.preconditions,
    ...(c.dependsOn && c.dependsOn.length > 0 ? { dependsOn: c.dependsOn } : {}),
    steps: c.steps.map((s) => ({ index: s.stepNumber, action: s.action, expected: s.expectedResult ?? null })),
    expectedResults: c.expectedResults,
    testData: c.testData,
    ambiguities,
    status: specStatusOf(c.validation.status),
  };
}

// The hash ignores generatedAt, so re-normalizing unchanged input gives the same hash.
export function canonicalHash(doc: CanonicalDocument): string {
  const { generatedAt: _ignored, ...rest } = doc;
  return hashValue(rest);
}

export function projectSpecs(doc: CanonicalDocument): TestSpecDocument {
  const specs = doc.testCases.map(projectSpec);
  // A dependency chain across modules is generated in one file of its own; every member says so.
  const layouts = chainLayouts(specs);
  return {
    schemaVersion: TEST_SPEC_SCHEMA_VERSION,
    generatedAt: doc.generatedAt,
    sources: doc.sources,
    canonical: { schemaVersion: doc.schemaVersion, sha256: canonicalHash(doc) },
    specs: layouts.size === 0 ? specs : specs.map((s) => (layouts.has(s.id) ? { ...s, layout: layouts.get(s.id)! } : s)),
  };
}

// Is this test-specs document exactly what the canonical document projects to? Anything else was edited or came from elsewhere.
export function checkSpecsAgainstCanonical(canonical: CanonicalDocument, specs: TestSpecDocument): string[] {
  const issues: string[] = [];
  const hash = canonicalHash(canonical);
  if (specs.canonical?.sha256 !== hash) {
    issues.push('test-specs.json does not come from the canonical test cases of this run (hash mismatch): run "specs parse" again; do not edit test-specs.json by hand');
    return issues;
  }
  if (canonicalJson(specs.specs) !== canonicalJson(projectSpecs(canonical).specs)) {
    issues.push('test-specs.json differs from the canonical test cases it was derived from: run "specs parse" again; do not edit test-specs.json by hand');
  }
  return issues;
}

// ---------- structural validation ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

function checkDataRef(d: unknown, at: string, issues: string[]): void {
  if (!isObj(d) || typeof d.name !== 'string') return void issues.push(`${at} needs a name`);
  const hasValue = typeof d.value === 'string';
  const hasEnv = typeof d.envVar === 'string';
  if (hasValue === hasEnv) issues.push(`${at} "${d.name}" must have exactly one of value or envVar`);
  if (hasEnv && !ENV_VAR_NAME.test(d.envVar as string)) issues.push(`${at} "${d.name}" envVar must be an env var NAME`);
}

function checkIssues(list: unknown, severity: CanonicalIssue['severity'], at: string, issues: string[]): void {
  if (!Array.isArray(list)) return void issues.push(`${at} must be an array`);
  for (const i of list) {
    if (!isObj(i) || !(AMBIGUITY_KINDS as readonly unknown[]).includes(i.code) || typeof i.message !== 'string' || i.severity !== severity) {
      issues.push(`${at} has an invalid entry ${JSON.stringify(i)}`);
    }
  }
}

export function validateCanonicalDocument(v: unknown): string[] {
  if (!isObj(v)) return ['canonical test cases must be a JSON object'];
  const issues: string[] = [];
  if (v.schemaVersion !== CANONICAL_SCHEMA_VERSION) issues.push(`unsupported canonical schemaVersion ${JSON.stringify(v.schemaVersion)} (expected ${CANONICAL_SCHEMA_VERSION})`);
  if (typeof v.generatedAt !== 'string' || Number.isNaN(Date.parse(v.generatedAt))) issues.push('generatedAt must be a timestamp');
  if (!Array.isArray(v.sources) || v.sources.length === 0) issues.push('sources must list at least one input file');
  else {
    for (const s of v.sources) {
      if (!isObj(s) || typeof s.path !== 'string' || typeof s.sha256 !== 'string' || !(INPUT_FORMATS as readonly unknown[]).includes(s.format)) {
        issues.push(`invalid source entry ${JSON.stringify(s)}`);
      }
    }
  }
  if (!isObj(v.validation) || !(VALIDATION_STATUSES as readonly unknown[]).includes(v.validation.status)) issues.push('validation.status must be one of ' + VALIDATION_STATUSES.join(', '));
  if (!Array.isArray(v.testCases)) return [...issues, 'testCases must be an array'];
  if (v.testCases.length === 0) issues.push('testCases is empty: no test cases were found in the input');

  const ids = new Set<string>();
  v.testCases.forEach((c, i) => {
    const at = `testCases[${i}]`;
    if (!isObj(c)) return void issues.push(`${at} must be an object`);
    if (c.schemaVersion !== CANONICAL_SCHEMA_VERSION) issues.push(`${at}.schemaVersion must be ${CANONICAL_SCHEMA_VERSION}`);
    if (typeof c.testCaseId !== 'string' || !TEST_ID_PATTERN.test(c.testCaseId)) issues.push(`${at}.testCaseId ${JSON.stringify(c.testCaseId)} is not a valid test ID`);
    else if (ids.has(c.testCaseId)) issues.push(`${at}.testCaseId "${c.testCaseId}" is not unique`);
    else ids.add(c.testCaseId);
    if (typeof c.title !== 'string' || c.title.trim() === '') issues.push(`${at}.title is required`);
    if (typeof c.module !== 'string' || c.module.trim() === '') issues.push(`${at}.module is required`);
    else if (c.moduleSlug !== slugify(c.module)) issues.push(`${at}.moduleSlug must be "${slugify(c.module)}"`);
    if (!isStrArray(c.preconditions) || !isStrArray(c.expectedResults) || !isStrArray(c.tags)) issues.push(`${at}: preconditions, expectedResults and tags must be string arrays`);
    if (!(c.priority === null || typeof c.priority === 'string')) issues.push(`${at}.priority must be a string or null`);
    if (c.dependsOn !== undefined && (!isStrArray(c.dependsOn) || c.dependsOn.length === 0)) issues.push(`${at}.dependsOn must be a non-empty array of test IDs when present`);

    const s = c.source;
    if (!isObj(s) || typeof s.file !== 'string' || typeof s.fileName !== 'string' || !(INPUT_FORMATS as readonly unknown[]).includes(s.format)) {
      issues.push(`${at}.source must have file, fileName and format`);
    } else if (s.format === 'markdown' ? !Number.isInteger(s.line) : !Number.isInteger(s.row)) {
      issues.push(`${at}.source must locate the case (${s.format === 'markdown' ? 'line' : 'row'})`);
    }

    if (!Array.isArray(c.steps)) issues.push(`${at}.steps must be an array`);
    else c.steps.forEach((st, j) => {
      if (!isObj(st) || st.stepNumber !== j + 1 || typeof st.action !== 'string') return void issues.push(`${at}.steps[${j}] must be {stepNumber: ${j + 1}, action, testData?, expectedResult?}`);
      if (st.expectedResult !== undefined && typeof st.expectedResult !== 'string') issues.push(`${at}.steps[${j}].expectedResult must be a string when present`);
      if (st.testData !== undefined) {
        if (!Array.isArray(st.testData)) issues.push(`${at}.steps[${j}].testData must be an array when present`);
        else st.testData.forEach((d, k) => checkDataRef(d, `${at}.steps[${j}].testData[${k}]`, issues));
      }
    });
    if (!Array.isArray(c.testData)) issues.push(`${at}.testData must be an array`);
    else c.testData.forEach((d, k) => checkDataRef(d, `${at}.testData[${k}]`, issues));
    if (!isObj(c.metadata) || !Object.values(c.metadata).every((x) => typeof x === 'string')) issues.push(`${at}.metadata must map names to strings`);

    const val = c.validation;
    if (!isObj(val)) return void issues.push(`${at}.validation is required`);
    checkIssues(val.blocking, 'blocking', `${at}.validation.blocking`, issues);
    checkIssues(val.warnings, 'warning', `${at}.validation.warnings`, issues);
    if (Array.isArray(val.blocking) && Array.isArray(val.warnings)) {
      // status must agree with the issues, so a blocked case can't be marked valid by hand
      const derived = validationOf([...(val.blocking as CanonicalIssue[]), ...(val.warnings as CanonicalIssue[])].map((x) => ({ kind: x.code, message: x.message, stepIndex: x.stepNumber }))).status;
      if (val.status !== derived) issues.push(`${at}.validation.status must be "${derived}" given its issues (got ${JSON.stringify(val.status)})`);
    }
  });

  // The test-specs view must be derivable from this document (catches a document the projection cannot represent).
  if (issues.length === 0) issues.push(...validateTestSpecDocument(projectSpecs(v as unknown as CanonicalDocument)).filter((m) => !m.startsWith('specs is empty')));
  return issues;
}

export function automatableCases(doc: CanonicalDocument): CanonicalCase[] {
  return doc.testCases.filter((c) => isAutomatable(c.validation.status));
}

// Deterministic checks on generated test source. The test-reviewer agent runs these first, then
// adds judgement-based findings. Findings go in review-report.json.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_REF_PATTERN } from './exploration.ts';
import { chainIssues, ownSessionIssues, type ChainSpec } from './session-layout.ts';

export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const FINDING_STATUSES = ['open', 'fixed', 'accepted'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface ReviewFinding {
  id: string;
  severity: Severity;
  file: string; // relative to automation/
  line: number | null;
  rule: string;
  message: string;
  status: FindingStatus;
  source: 'static' | 'reviewer';
}

interface LineRule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
}

const LINE_RULES: LineRule[] = [
  { rule: 'no-only', severity: 'critical', pattern: /\.only\s*\(/, message: '.only() would silently skip every other test' },
  { rule: 'no-skip', severity: 'critical', pattern: /\btest\.(?:skip|fixme)\s*\(/, message: 'tests must not be skipped by generated code' },
  { rule: 'no-expected-failure', severity: 'critical', pattern: /\btest\.fail\s*\(/, message: 'test.fail() inverts the result and hides failures' },
  { rule: 'no-cli-element-ref', severity: 'critical', pattern: CLI_REF_PATTERN, message: 'temporary Playwright CLI element reference used as a locator' },
  { rule: 'no-wait-for-timeout', severity: 'major', pattern: /\.waitForTimeout\s*\(/, message: 'arbitrary sleep; rely on auto-waiting or a web-first assertion' },
  { rule: 'no-xpath', severity: 'major', pattern: /locator\(\s*['"`](?:\/\/|xpath=)/, message: 'XPath locator is brittle; prefer getByRole/getByLabel/getByTestId' },
  { rule: 'no-absolute-url', severity: 'major', pattern: /\.goto\(\s*['"`]https?:\/\//, message: 'absolute URL; navigate relative to the configured baseURL' },
  { rule: 'no-ts-suppress', severity: 'major', pattern: /@ts-(?:ignore|nocheck|expect-error)/, message: 'type errors must be fixed, not suppressed' },
  { rule: 'no-soft-only', severity: 'minor', pattern: /expect\.soft\s*\(/, message: 'soft assertion: confirm the spec allows the test to continue after this check' },
  { rule: 'no-force', severity: 'minor', pattern: /force\s*:\s*true/, message: 'force: true bypasses actionability checks and can hide real defects' },
  { rule: 'positional-locator', severity: 'minor', pattern: /\.(?:nth\(\d+\)|first\(\)|last\(\))/, message: 'positional locator; prefer a unique semantic locator' },
  { rule: 'css-structure-locator', severity: 'minor', pattern: /locator\(\s*['"`][^'"`]*(?::nth-child|>\s|\.css-|\[class)/, message: 'structural CSS selector is brittle' },
];

const SECRET_WORD = /password|passwd|pwd|secret|token|api[_-]?key/i;
// `password = 'x…'`, `{ token: 'x…' }`, or typing a literal on a line that mentions a secret field.
function hasSecretLiteral(line: string): boolean {
  if (/(?:password|passwd|pwd|secret|token|api[_-]?key)\w*['"`]?\s*[:=]\s*['"`][^'"`\s]{4,}['"`]/i.test(line)) return true;
  return SECRET_WORD.test(line) && /\.(?:fill|type|pressSequentially)\(\s*['"`][^'"`]{4,}['"`]/.test(line);
}
const TEST_CALL = /\btest\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const AUTH_SETUP_FILE = /(?:^|\/)auth\/[^/]+\.setup\.(?:ts|js)$/;
const SHARED_FIXTURE_IMPORT = /from\s+['"][^'"]*fixtures\/test(?:\.ts|\.js)?['"]/;

// kind "support" = page objects written by the generator: only the line-level safety rules apply
// (no tests, titles or fixture import are expected there).
// `chains`: dependency chains whose tests are all in this file (see dependencies.ts), checked for order and a serial group.
export function reviewSource(file: string, source: string, kind: 'test' | 'support' = 'test', chains: ChainSpec[] = []): ReviewFinding[] {
  const findings: Omit<ReviewFinding, 'id'>[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, i) => {
    if (/^\s*\/\//.test(text)) return;
    for (const r of LINE_RULES) {
      if (r.pattern.test(text)) findings.push({ severity: r.severity, file, line: i + 1, rule: r.rule, message: r.message, status: 'open', source: 'static' });
    }
    if (hasSecretLiteral(text) &&!/process\.env|requireEnv\(/.test(text)) {
      findings.push({ severity: 'critical', file, line: i + 1, rule: 'no-hardcoded-secret', message: 'credential-looking literal; read it with requireEnv() from an env var', status: 'open', source: 'static' });
    }
  });

  if (kind === 'support') {
    // The login setup must check the saved session before trusting it, so a stale one is replaced instead of failing every test.
    if (AUTH_SETUP_FILE.test(file) && !/reuseOrSignIn\s*\(/.test(source)) {
      findings.push({
        severity: 'major', file, line: null, rule: 'auth-gate',
        message: 'the login setup must call reuseOrSignIn(...) from helpers/auth: it reuses the saved session only after the application accepts it, and signs in again otherwise',
        status: 'open', source: 'static',
      });
    }
    return withIds(file, findings);
  }

  if (!SHARED_FIXTURE_IMPORT.test(source)) {
    findings.push({ severity: 'major', file, line: null, rule: 'use-shared-fixtures', message: 'import { test, expect } from fixtures/test, not directly from @playwright/test', status: 'open', source: 'static' });
  }

  // Per-test checks: every test has a "[ID] " title prefix and at least one assertion.
  // `test(` only — test.describe(/test.step( don't match because the "(" must follow "test" directly.
  const calls = [...source.matchAll(TEST_CALL)];
  if (calls.length === 0) findings.push({ severity: 'critical', file, line: null, rule: 'no-tests', message: 'file defines no tests', status: 'open', source: 'static' });
  calls.forEach((m, k) => {
    const line = source.slice(0, m.index).split(/\r?\n/).length;
    const title = m[2]!;
    if (!/^\[[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*\] /.test(title)) {
      findings.push({ severity: 'critical', file, line, rule: 'test-id-title', message: `test title "${title}" must start with "[<testId>] " for traceability`, status: 'open', source: 'static' });
    }
    const body = source.slice(m.index, calls[k + 1]?.index ?? source.length);
    if (!/\bexpect(?:\.soft)?\s*\(/.test(body)) {
      findings.push({ severity: 'critical', file, line, rule: 'has-assertion', message: `test "${title}" has no assertion`, status: 'open', source: 'static' });
    }
    // A test that makes unique data creates records. They must be registered so they are removed (or reported as left behind).
    if (/\buniqueSuffix\s*\(/.test(body) && !/\bcleanup\.register\s*\(/.test(body)) {
      findings.push({
        severity: 'major', file, line, rule: 'register-created-data',
        message: `test "${title}" creates data with uniqueSuffix() but never calls cleanup.register(...): add the cleanup fixture and register each record (with an undo when the app can remove it), or accept this finding with a note that no cleanup path exists`,
        status: 'open', source: 'static',
      });
    }
  });

  for (const i of [...ownSessionIssues(source), ...chainIssues(source, chains)]) {
    findings.push({ severity: i.severity, file, line: i.line, rule: i.rule, message: i.message, status: 'open', source: 'static' });
  }

  return withIds(file, findings);
}

function withIds(file: string, findings: Omit<ReviewFinding, 'id'>[]): ReviewFinding[] {
  return findings.map((f, i) => ({ ...f, id: `S${String(i + 1).padStart(3, '0')}-${path.basename(file)}` }));
}

export interface TestBlock {
  testId: string | null; // from the "[ID] " title prefix
  title: string;
  startLine: number; // 1-based
  endLine: number;
  text: string; // from this test( call up to the next one
}

// Splits a spec file into its test() blocks, the same way reviewSource attributes assertions to tests. Used to hash and
// locate one test inside a file that holds several.
export function testBlocks(source: string): TestBlock[] {
  const calls = [...source.matchAll(TEST_CALL)];
  return calls.map((m, k) => {
    const end = calls[k + 1]?.index ?? source.length;
    const title = m[2]!;
    return {
      testId: /^\[([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\] /.exec(title)?.[1] ?? null,
      title,
      startLine: source.slice(0, m.index).split(/\r?\n/).length,
      endLine: source.slice(0, end).split(/\r?\n/).length,
      text: source.slice(m.index, end),
    };
  });
}

export function reviewFiles(rootDir: string, files: string[], supportFiles: string[] = [], chainsByFile: ReadonlyMap<string, ChainSpec[]> = new Map()): ReviewFinding[] {
  return [
    ...files.flatMap((f) => reviewSource(f, readFileSync(path.join(rootDir, f), 'utf8'), 'test', chainsByFile.get(f) ?? [])),
    ...supportFiles.flatMap((f) => reviewSource(f, readFileSync(path.join(rootDir, f), 'utf8'), 'support')),
  ];
}

export const REVIEW_SCHEMA_VERSION = 1;

export interface ReviewReport {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  reviewedAt: string;
  files: string[];
  typecheck: { ran: boolean; ok: boolean | null; output: string | null; cached?: boolean };
  findings: ReviewFinding[];
}

export function validateReviewReport(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['review report must be an object'];
  const r = v as Partial<ReviewReport>;
  const issues: string[] = [];
  if (r.schemaVersion !== REVIEW_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!Array.isArray(r.files) || r.files.length === 0) issues.push('files must list the reviewed files');
  if (!Array.isArray(r.findings)) return [...issues, 'findings must be an array'];
  for (const f of r.findings) {
    if (!(SEVERITIES as readonly unknown[]).includes(f.severity) || !(FINDING_STATUSES as readonly unknown[]).includes(f.status)) {
      issues.push(`finding ${f.id}: invalid severity/status`);
    }
    if (f.severity === 'critical' && f.status === 'open') issues.push(`critical finding ${f.id} (${f.rule}) at ${f.file}:${f.line ?? '?'} is still open`);
    if (f.severity === 'critical' && f.status === 'accepted') issues.push(`critical finding ${f.id} cannot be accepted; it must be fixed`);
  }
  if (!r.typecheck || r.typecheck.ran !== true) issues.push('typecheck of generated tests did not run');
  else if (r.typecheck.ok !== true) issues.push('typecheck of generated tests failed');
  return issues;
}

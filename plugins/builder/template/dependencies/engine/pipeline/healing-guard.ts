// Guards a healing patch: compares a test file before and after the repair.
// Locators (the subject of expect(...) and of actions) may change; assertions may not be weakened.

export interface GuardResult {
  ok: boolean;
  violations: string[];
  warnings: string[];
  changedLines: number;
  diff: string;
}

export const MAX_MINIMAL_CHANGED_LINES = 25;

// `.toHaveText('x')`, `.not.toBeVisible()` … with one level of nested parentheses in the arguments.
const MATCHER = /\.\s*(not\s*\.\s*)?(to[A-Z]\w*)\s*\(((?:[^()]|\([^()]*\))*)\)/g;

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function matcherCalls(source: string): string[] {
  return [...source.matchAll(MATCHER)].map((m) => `${m[1] ? 'not.' : ''}${m[2]}(${norm(m[3]!)})`);
}

function count(source: string, re: RegExp): number {
  return source.match(re)?.length ?? 0;
}

function multisetMissing(before: string[], after: string[]): string[] {
  const pool = new Map<string, number>();
  for (const a of after) pool.set(a, (pool.get(a) ?? 0) + 1);
  const missing: string[] = [];
  for (const b of before) {
    const n = pool.get(b) ?? 0;
    if (n > 0) pool.set(b, n - 1);
    else missing.push(b);
  }
  return missing;
}

const FORBIDDEN_ADDITIONS: { re: RegExp; message: string }[] = [
  { re: /\btest\.(?:skip|fixme)\s*\(/g, message: 'adds test.skip/test.fixme' },
  { re: /\.only\s*\(/g, message: 'adds .only()' },
  { re: /\btest\.fail\s*\(/g, message: 'adds test.fail()' },
  { re: /\.waitForTimeout\s*\(/g, message: 'adds an arbitrary sleep (waitForTimeout)' },
  { re: /@ts-(?:ignore|nocheck|expect-error)/g, message: 'suppresses type errors' },
  { re: /\bcatch\s*[({]/g, message: 'adds a catch block, which can swallow assertion failures' },
  { re: /expect\.soft\s*\(/g, message: 'converts to soft assertions' },
];

export function guardPatch(before: string, after: string, testId: string): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!after.includes(`[${testId}]`)) violations.push(`the "[${testId}]" title prefix was removed (traceability)`);
  const expectsBefore = count(before, /\bexpect\s*\(/g);
  const expectsAfter = count(after, /\bexpect\s*\(/g);
  if (expectsAfter < expectsBefore) violations.push(`assertions removed: expect( count went from ${expectsBefore} to ${expectsAfter}`);

  const missing = multisetMissing(matcherCalls(before), matcherCalls(after));
  for (const m of missing) violations.push(`assertion matcher changed or removed: .${m}`);

  for (const f of FORBIDDEN_ADDITIONS) {
    if (count(after, f.re) > count(before, f.re)) violations.push(f.message);
  }
  if (count(after, /force\s*:\s*true/g) > count(before, /force\s*:\s*true/g)) warnings.push('adds force: true; justify it with evidence');

  const { diff, changed } = lineDiff(before, after);
  if (changed === 0) violations.push('no change was made');
  if (changed > MAX_MINIMAL_CHANGED_LINES) warnings.push(`${changed} changed lines — a repair should be minimal`);
  return { ok: violations.length === 0, violations, warnings, changedLines: changed, diff };
}

// Minimal LCS line diff: "-"/"+" lines with 1-based line numbers. Test files are small.
export function lineDiff(before: string, after: string): { diff: string; changed: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const dp: number[] = new Array((n + 1) * (m + 1)).fill(0);
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)]! + 1 : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let changed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    if (i < n && (j >= m || dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!)) { out.push(`-${i + 1}: ${a[i]}`); i++; changed++; }
    else { out.push(`+${j + 1}: ${b[j]}`); j++; changed++; }
  }
  return { diff: out.join('\n'), changed };
}

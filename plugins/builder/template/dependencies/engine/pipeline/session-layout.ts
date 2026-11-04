// How generated tests relate to the saved login and to each other, read from the test source (no Playwright import).
//
//  - A test that signs in (or out, or changes the session) itself must start signed out: it overrides the project's storage state
//    with `test.use({ storageState: { cookies: [], origins: [] } })` and carries the tag @own-session. The generated Playwright
//    config runs @own-session tests in their own project AFTER every test that shares the saved login, because signing in again
//    as the same account can end the session the others are using.
//  - A chain of dependent test cases is written inside one `test.describe.serial(...)` group, prerequisites first.
//
// These checks are line/brace based, not a parser: they blank comments and strings first so braces in text don't count, and they
// report only what is certain.

export const OWN_SESSION_TAG = '@own-session';
const SIGNED_OUT = /storageState\s*:\s*\{\s*cookies\s*:\s*\[\s*\]\s*,\s*origins\s*:\s*\[\s*\]\s*\}/;
const TEST_CALL = /\btest\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const TEST_USE = /\btest\.use\s*\(/g;

// The same text with the inside of comments, strings and template literals replaced by spaces (newlines kept), so a "{" in text
// is never mistaken for code.
export function blank(source: string): string {
  const out = source.split('');
  let i = 0;
  const wipe = (from: number, to: number) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < source.length) {
    const c = source[i]!;
    const n = source[i + 1];
    if (c === '/' && n === '/') { const e = source.indexOf('\n', i); const end = e === -1 ? source.length : e; wipe(i, end); i = end; continue; }
    if (c === '/' && n === '*') { const e = source.indexOf('*/', i + 2); const end = e === -1 ? source.length : e + 2; wipe(i, end); i = end; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let k = i + 1;
      while (k < source.length && source[k] !== c) k += source[k] === '\\' ? 2 : 1;
      wipe(i + 1, k);
      i = k + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

export interface Scope { start: number; end: number } // offsets of the "{" and its matching "}"

// The innermost { ... } that contains `index`, or null at file level.
export function enclosingScope(blanked: string, index: number): Scope | null {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = blanked[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        let d = 0;
        for (let j = i; j < blanked.length; j++) {
          if (blanked[j] === '{') d++;
          else if (blanked[j] === '}' && --d === 0) return { start: i, end: j };
        }
        return { start: i, end: blanked.length };
      }
      depth--;
    }
  }
  return null;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split(/\r?\n/).length;

export interface SessionTest {
  testId: string | null;
  title: string;
  line: number;
  index: number;
  tagged: boolean; // carries @own-session
  signedOut: boolean; // sits inside a scope that resets the storage state
}

const idOf = (title: string): string | null => /^\[([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]/.exec(title)?.[1] ?? null;

export function scanSessionTests(source: string): SessionTest[] {
  const blanked = blank(source);
  // Scopes (or the whole file) where the saved login is switched off.
  const resets: (Scope | 'file')[] = [];
  for (const m of source.matchAll(TEST_USE)) {
    const open = m.index! + m[0].length;
    // the call's argument text, up to the matching ")" in blanked source (strings are blank, so "(" ")" inside them don't count)
    let depth = 1;
    let end = open;
    for (; end < blanked.length && depth > 0; end++) depth += blanked[end] === '(' ? 1 : blanked[end] === ')' ? -1 : 0;
    if (SIGNED_OUT.test(source.slice(open, end))) resets.push(enclosingScope(blanked, m.index!) ?? 'file');
  }
  const calls = [...source.matchAll(TEST_CALL)];
  return calls.map((m, k) => {
    const index = m.index!;
    const head = source.slice(index, calls[k + 1]?.index ?? source.length);
    const details = head.slice(0, Math.max(head.indexOf('=>'), head.indexOf('function'), 0) || 600);
    const signedOut = resets.some((r) => r === 'file' || (index > r.start && index < r.end));
    return { testId: idOf(m[2]!), title: m[2]!, line: lineOf(source, index), index, tagged: details.includes(OWN_SESSION_TAG), signedOut };
  });
}

export interface SessionIssue { rule: string; severity: 'major' | 'critical'; line: number; message: string }

// Tag and storage-state override must agree for every test.
export function ownSessionIssues(source: string): SessionIssue[] {
  const issues: SessionIssue[] = [];
  for (const t of scanSessionTests(source)) {
    if (t.signedOut && !t.tagged) {
      issues.push({
        rule: 'own-session-tag', severity: 'major', line: t.line,
        message: `test "${t.title}" starts signed out (storageState reset) but is not tagged ${OWN_SESSION_TAG}: it would run alongside tests that share the saved login, and signing in again can end their session. Add tag: ['${OWN_SESSION_TAG}'] to the test`,
      });
    }
    if (t.tagged && !t.signedOut) {
      issues.push({
        rule: 'own-session-override', severity: 'major', line: t.line,
        message: `test "${t.title}" is tagged ${OWN_SESSION_TAG} but does not start signed out: wrap it in a scope with test.use({ storageState: { cookies: [], origins: [] } }), or remove the tag`,
      });
    }
  }
  return issues;
}

export interface ChainSpec { id: string; ids: string[] }

// Smallest { } scope that contains every offset, or null when they only share the file.
function commonScope(blanked: string, indexes: number[]): Scope | null {
  let scope = enclosingScope(blanked, indexes[0]!);
  while (scope && !indexes.every((i) => i > scope!.start && i < scope!.end)) scope = enclosingScope(blanked, scope.start);
  return scope;
}

// A chain's tests are in dependency order inside one serial group. Serial mode is what makes the later tests wait for the earlier
// ones on the same worker and skip when one fails; without it they could start together on different workers.
export function chainIssues(source: string, chains: ChainSpec[]): SessionIssue[] {
  const blanked = blank(source);
  const tests = scanSessionTests(source);
  const issues: SessionIssue[] = [];
  for (const chain of chains) {
    const found = chain.ids.map((id) => tests.find((t) => t.testId === id));
    const missing = chain.ids.filter((_, i) => !found[i]);
    if (missing.length > 0) continue; // a missing test is reported by generate validate
    const members = found as SessionTest[];
    const first = members[0]!;
    if (members.some((t, i) => i > 0 && t.index < members[i - 1]!.index)) {
      issues.push({
        rule: 'chain-order', severity: 'critical', line: first.line,
        message: `tests ${chain.ids.join(' -> ')} depend on each other but are not written in that order: a test must come after the test it depends on`,
      });
    }
    const scope = commonScope(blanked, members.map((t) => t.index));
    let serial = false;
    if (scope) {
      // The call that opens the scope is the last "describe" before its "{"; or the scope switches to serial mode as it starts.
      const heading = blanked.slice(Math.max(0, scope.start - 300), scope.start);
      const opener = heading.slice(Math.max(0, heading.lastIndexOf('describe')));
      const configured = /describe\s*\.\s*configure\s*\(\s*\{\s*mode\s*:\s*['"]serial['"]/.test(source.slice(scope.start, scope.start + 200));
      serial = /^describe\s*\.\s*serial\s*\(/.test(opener) || configured;
    }
    if (!serial) {
      issues.push({
        rule: 'chain-serial', severity: 'critical', line: first.line,
        message: `tests ${chain.ids.join(' -> ')} depend on each other and must be inside one test.describe.serial(...) group (or test.describe.configure({ mode: 'serial' })), so they run in order on one worker and the rest are skipped if one fails`,
      });
    }
  }
  return issues;
}

// Summary of a spec file for the execution plan: how many tests start signed out, and the serial groups it contains.
export function sessionSummary(source: string): { ownSession: number; serialGroups: number } {
  return { ownSession: scanSessionTests(source).filter((t) => t.tagged).length, serialGroups: [...blank(source).matchAll(/\bdescribe\s*\.\s*serial\s*\(/g)].length };
}

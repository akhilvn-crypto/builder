// Automation readiness: for each test case, can it be automated, what has to be in place first, and, when it cannot be
// automated, why. Pure functions over the parsed specs; nothing here reads or writes a file. The verdicts are deterministic
// (a documented rule table), so the same cases always give the same report and the reasons can be shown to the user as they are.

import type { TestSpec, TestSpecDocument } from './test-spec.ts';

export const READINESS_SCHEMA_VERSION = 1;

// automatable: nothing to arrange first. automatable_with_prerequisites: can be automated once the listed prerequisites exist.
// manual: needs a human (or something a browser test cannot do). blocked: the case itself is incomplete, a person must clarify it.
export const VERDICTS = ['automatable', 'automatable_with_prerequisites', 'manual', 'blocked'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReadinessReason {
  code: string;
  message: string;
}

export interface DataNeed {
  name: string;
  kind: 'env' | 'literal' | 'inline';
  envVar: string | null;
  present: boolean | null; // env: is there a value in automation/.env or the environment; other kinds: null
}

export interface CaseReadiness {
  id: string;
  title: string;
  module: string;
  storyIds: string[];
  verdict: Verdict;
  reasons: ReadinessReason[];
  prerequisites: {
    preconditions: string[];
    dependsOn: string[];
    testData: DataNeed[];
    missingEnvVars: string[];
  };
  workflows: string[];
}

export interface ReadinessReport {
  schemaVersion: typeof READINESS_SCHEMA_VERSION;
  generatedAt: string;
  summary: Record<Verdict, number> & { total: number };
  cases: CaseReadiness[];
  // Names the cases need and nobody has given a value yet (names only).
  missingEnvVars: string[];
  // Cases the user decided to automate although a rule flagged them as manual.
  overridden: string[];
}

// Why a case cannot be run by a browser test. Matched against the title, steps, expected results and preconditions.
interface ManualRule {
  code: string;
  pattern: RegExp;
  message: string;
}

export const MANUAL_RULES: readonly ManualRule[] = [
  { code: 'captcha', pattern: /\b(?:re)?captcha\b/i, message: 'A CAPTCHA is designed to stop automated clients; it needs a test-environment bypass or a person.' },
  {
    code: 'out_of_band_code',
    pattern: /\b(?:otp|one[- ]time\s+(?:pass(?:word|code)|code|pin)|sms\s+(?:code|message|text)|verification\s+code|two[- ]factor|2fa|mfa|authenticator\s+app)\b/i,
    message: 'The case depends on a code delivered outside the browser (SMS, e-mail or an authenticator app) that the test cannot read.',
  },
  {
    code: 'mailbox',
    pattern: /\b(?:check|open|read)\s+(?:the\s+|your\s+|an?\s+)?(?:e-?mail|inbox|mailbox)\b|\bclick\s+(?:the\s+)?(?:link|button)\s+in\s+the\s+e-?mail\b|\breceives?\s+an?\s+e-?mail\b/i,
    message: 'The case needs a real mailbox to be read; a browser test has no access to one.',
  },
  {
    code: 'physical_device',
    pattern: /\b(?:printer|printout|barcode\s+scanner|webcam|camera|fingerprint|biometric|face\s*id|usb|bluetooth|nfc|smart\s*card|physical\s+(?:device|card|token))\b/i,
    message: 'The case needs physical hardware that a browser test cannot operate.',
  },
  {
    code: 'real_device',
    pattern: /\b(?:phone\s+call|push\s+notification|native\s+(?:ios|android)\s+app|on\s+(?:an?\s+)?(?:ios|android)\s+device)\b/i,
    message: 'The case needs a real phone or a native app; a browser test cannot drive it.',
  },
  {
    code: 'subjective_judgement',
    pattern: /\b(?:looks?\s+(?:good|right|correct|nice)|visually\s+(?:appealing|pleasing|correct)|pixel[- ]perfect|matches\s+the\s+(?:design|mock-?up)|aesthetic|feels?\s+(?:fast|smooth|responsive))\b/i,
    message: 'The expected result is a human judgement (appearance or feel) that has no assertable value.',
  },
  {
    code: 'long_elapsed_time',
    pattern: /\bwait(?:s|ing)?\s+(?:for\s+)?(?:\d+|a|one|two|three|several)\s+(?:hour|day|week|month)s?\b|\b(?:next|following)\s+(?:day|week|month)\b|\bovernight\b|\bnightly\b|\bscheduled\s+job\b|\bcron\b/i,
    message: 'The case depends on hours or days passing, or on a scheduled job; it does not fit one test run.',
  },
  {
    code: 'load_or_security_testing',
    pattern: /\b(?:load\s+test|stress\s+test|penetration\s+test|pen[- ]?test|\d+\s+(?:concurrent|simultaneous)\s+users)\b/i,
    message: 'The case needs a load or security testing tool, not a functional browser test.',
  },
  {
    code: 'declared_manual',
    pattern: /\b(?:manual(?:ly)?\s+(?:test|check|verif\w*|step)|verify\s+manually|tester\s+(?:must|should)\s+manually)\b/i,
    message: 'The case itself says it is to be done manually.',
  },
];

export interface AssessOptions {
  now?: Date;
  // Variable names that have a value in automation/.env or the environment. null = unknown (nothing is reported missing).
  presentEnvVars?: ReadonlySet<string> | null;
  // Case IDs the user chose to automate even though a rule flagged them as manual.
  overrides?: ReadonlySet<string>;
  // Story IDs per case (from the design traceability); cases not listed get an empty list.
  storyIdsOf?: (id: string) => string[];
}

const LOGIN = /\b(?:sign|log)[ -]?in\b|\blog[ -]?in\s+page\b|\bauthenticat/i;
const NAVIGATE = /^(?:open|go\s+to|navigate\s+to|visit)\s+(?:the\s+)?(.+?)\s*$/i;
const CREATES = /\b(?:create|add|register|submit|save|upload|place)\b/i;

function textOf(s: TestSpec): string {
  return [
    s.title, ...s.preconditions, ...s.steps.map((x) => `${x.action} ${x.expected ?? ''}`), ...s.expectedResults,
  ].join('\n');
}

export function workflowsOf(s: TestSpec): string[] {
  const out: string[] = [];
  const logsIn = s.steps.some((x) => LOGIN.test(x.action)) || s.testData.some((d) => d.envVar !== null && /pass|user|e-?mail/i.test(d.name));
  if (logsIn) out.push('authentication');
  const targets: string[] = [];
  for (const step of s.steps) {
    const m = NAVIGATE.exec(step.action);
    if (m && !targets.includes(m[1]!)) targets.push(m[1]!);
  }
  for (const t of targets.slice(0, 3)) out.push(`navigate: ${t}`);
  if (s.steps.some((x) => CREATES.test(x.action))) out.push('creates data (cleanup applies)');
  if ((s.dependsOn ?? []).length > 0) out.push('dependency chain (runs in order)');
  return out;
}

function dataNeeds(s: TestSpec, present: ReadonlySet<string> | null): DataNeed[] {
  return s.testData.map((d) => {
    if (d.envVar !== null) return { name: d.name, kind: 'env' as const, envVar: d.envVar, present: present === null ? null : present.has(d.envVar) };
    return { name: d.name, kind: d.declaredLiteral ? 'literal' as const : 'inline' as const, envVar: null, present: null };
  });
}

export function assessCase(s: TestSpec, o: AssessOptions = {}): CaseReadiness {
  const present = o.presentEnvVars ?? null;
  const data = dataNeeds(s, present);
  const missing = [...new Set(data.filter((d) => d.kind === 'env' && d.present === false).map((d) => d.envVar!))];
  const reasons: ReadinessReason[] = [];
  const base = {
    id: s.id, title: s.title, module: s.module, storyIds: o.storyIdsOf?.(s.id) ?? [],
    prerequisites: { preconditions: s.preconditions, dependsOn: s.dependsOn ?? [], testData: data, missingEnvVars: missing },
    workflows: workflowsOf(s),
  };

  if (s.status === 'needs_clarification') {
    for (const a of s.ambiguities) reasons.push({ code: a.kind, message: a.message });
    return { ...base, verdict: 'blocked', reasons };
  }

  const text = textOf(s);
  const flagged: ReadinessReason[] = MANUAL_RULES.filter((r) => r.pattern.test(text)).map((r) => ({ code: r.code, message: r.message }));
  if (s.tags.some((t) => t.toLowerCase() === 'manual')) flagged.unshift({ code: 'tagged_manual', message: 'The case is tagged "manual".' });
  if (flagged.length > 0) {
    if (o.overrides?.has(s.id)) {
      return {
        ...base, verdict: 'automatable_with_prerequisites',
        reasons: [{ code: 'manual_flag_overridden', message: `Flagged as manual (${flagged.map((f) => f.code).join(', ')}) but the user chose to automate it; expect it to need a test-environment workaround.` }],
      };
    }
    return { ...base, verdict: 'manual', reasons: flagged };
  }

  if (s.preconditions.length > 0) reasons.push({ code: 'has_preconditions', message: `Needs in place first: ${s.preconditions.join('; ')}` });
  if ((s.dependsOn ?? []).length > 0) reasons.push({ code: 'depends_on_cases', message: `Runs after ${(s.dependsOn ?? []).join(', ')} and is reported as blocked if one of them fails.` });
  if (missing.length > 0) reasons.push({ code: 'missing_env_vars', message: `No value yet for ${missing.join(', ')}: add them to automation/.env before the application is explored.` });
  return { ...base, verdict: reasons.length > 0 ? 'automatable_with_prerequisites' : 'automatable', reasons };
}

export function assessReadiness(doc: TestSpecDocument, o: AssessOptions = {}): ReadinessReport {
  const cases = doc.specs.map((s) => assessCase(s, o));
  const summary = { total: cases.length, automatable: 0, automatable_with_prerequisites: 0, manual: 0, blocked: 0 };
  for (const c of cases) summary[c.verdict] += 1;
  return {
    schemaVersion: READINESS_SCHEMA_VERSION,
    generatedAt: (o.now ?? new Date()).toISOString(),
    summary,
    cases,
    missingEnvVars: [...new Set(cases.flatMap((c) => c.prerequisites.missingEnvVars))].sort(),
    overridden: cases.filter((c) => c.reasons.some((r) => r.code === 'manual_flag_overridden')).map((c) => c.id),
  };
}

export function validateReadinessReport(v: unknown): string[] {
  if (typeof v !== 'object' || v === null) return ['readiness report must be an object'];
  const r = v as Partial<ReadinessReport>;
  const issues: string[] = [];
  if (r.schemaVersion !== READINESS_SCHEMA_VERSION) issues.push('unsupported readiness schemaVersion');
  if (!Array.isArray(r.cases)) return [...issues, 'cases must be an array'];
  for (const c of r.cases) {
    if (!c || typeof c.id !== 'string') { issues.push('a readiness case has no id'); continue; }
    if (!(VERDICTS as readonly string[]).includes(c.verdict)) issues.push(`${c.id}: unknown verdict ${JSON.stringify(c.verdict)}`);
    if (c.verdict === 'manual' && (!Array.isArray(c.reasons) || c.reasons.length === 0)) issues.push(`${c.id}: a manual case must say why`);
  }
  return issues;
}

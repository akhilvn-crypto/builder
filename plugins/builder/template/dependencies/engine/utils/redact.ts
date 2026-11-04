// Secret masking shared by the pipeline engine. The Playwright-facing twin lives in the scaffolded framework
// (helpers/test-data.*) so generated tests never import engine code.

// Replace every occurrence of the given secret values (min length 3) with "***".
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

// Credential-shaped text that must never reach a log or report even when it is not one of the configured secrets:
// authorization headers, cookie headers, JSON Web Tokens and token-like key=value pairs.
const SENSITIVE: [RegExp, string][] = [
  [/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[^\s'",;]+/gi, '$1***'],
  [/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***'],
  [/\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|session(?:id)?|sid|csrf[_-]?token|x-auth-token)["']?\s*[:=]\s*["']?)[^\s"'&,;]{6,}/gi, '$1***'],
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const [re, to] of SENSITIVE) out = out.replace(re, to);
  return out;
}

// Configured secret values first (exact), then credential-shaped patterns.
export function redactAll(text: string, secrets: readonly string[]): string {
  return redactSensitive(redact(text, secrets));
}

// Checks whether the application still accepts a saved Playwright storage state, by requesting one protected path with the
// state's cookies. Runs as a small child process (the pipeline is synchronous) and prints one JSON line:
//   {"outcome":"ok|rejected|unreachable|error","httpStatus":200,"detail":"..."}
// Cookie values are used for the request only; they are never printed, logged or returned. Only the status code and the
// redirect target path are looked at, never the response body.
//
//   node src/pipeline/auth-probe.ts --base-url <url> --path <protected path> --state <file> [--logged-out <regex>]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface ProbeArgs {
  baseUrl: string;
  probePath: string;
  stateFile: string; // absolute
  loggedOutPattern: string | null;
}

export interface ProbeResult {
  outcome: 'ok' | 'rejected' | 'unreachable' | 'error';
  httpStatus: number | null;
  detail: string | null;
}

export type ProbeRunner = (args: ProbeArgs) => ProbeResult;

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure?: boolean;
}

// The Cookie header a browser would send for `url`: matching domain and path, not expired, Secure only over https.
export function cookieHeaderFor(url: URL, cookies: StoredCookie[], nowSeconds: number): string {
  return cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, '').toLowerCase();
      const host = url.hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) return false;
      if (!url.pathname.startsWith(c.path || '/')) return false;
      if (c.secure && url.protocol !== 'https:') return false;
      return c.expires === -1 || c.expires > nowSeconds;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// Decides from the status and redirect target alone. A redirect away from the protected path is how most apps send a
// logged-out visitor to a login page; so are 401/403.
export function evaluateProbeResponse(
  status: number, location: string | null, probePath: string, loggedOutPattern: string | null,
): ProbeResult {
  const pattern = loggedOutPattern ? new RegExp(loggedOutPattern, 'i') : null;
  if (status >= 200 && status < 300) return { outcome: 'ok', httpStatus: status, detail: null };
  if (status === 401 || status === 403) return { outcome: 'rejected', httpStatus: status, detail: `the application answered ${status} to the saved session` };
  if (status >= 300 && status < 400) {
    let target = location ?? '';
    try {
      target = new URL(target, 'http://placeholder').pathname;
    } catch {
      // keep the raw value
    }
    const samePath = target.replace(/\/+$/, '') === probePath.replace(/\/+$/, '');
    if (pattern?.test(location ?? '') || !samePath) {
      return { outcome: 'rejected', httpStatus: status, detail: `redirected away from ${probePath} to ${target || 'another location'}` };
    }
    return { outcome: 'ok', httpStatus: status, detail: null };
  }
  if (status === 404) return { outcome: 'error', httpStatus: status, detail: `${probePath} was not found: check auth.state.probePath` };
  return { outcome: 'unreachable', httpStatus: status, detail: `the application answered ${status}` };
}

export async function probeState(args: ProbeArgs, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<ProbeResult> {
  let state: { cookies?: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(args.stateFile, 'utf8'));
  } catch {
    return { outcome: 'error', httpStatus: null, detail: 'the saved state could not be read' };
  }
  const url = new URL(args.probePath, args.baseUrl);
  if (url.origin !== new URL(args.baseUrl).origin) return { outcome: 'error', httpStatus: null, detail: 'probe path must stay on the configured origin' };
  const cookie = cookieHeaderFor(url, Array.isArray(state.cookies) ? state.cookies : [], now.getTime() / 1000);
  try {
    const res = await fetchImpl(url, { redirect: 'manual', headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    return evaluateProbeResponse(res.status, res.headers.get('location'), url.pathname, args.loggedOutPattern);
  } catch (err) {
    return { outcome: 'unreachable', httpStatus: null, detail: `could not reach the application: ${(err as Error).name}` };
  }
}

export const defaultProbeRunner: ProbeRunner = (args) => {
  const script = fileURLToPath(import.meta.url);
  const argv = [script, '--base-url', args.baseUrl, '--path', args.probePath, '--state', args.stateFile, ...(args.loggedOutPattern ? ['--logged-out', args.loggedOutPattern] : [])];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  try {
    return JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '') as ProbeResult;
  } catch {
    return { outcome: 'error', httpStatus: null, detail: 'the probe did not produce a result' };
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, path: { type: 'string' }, state: { type: 'string' }, 'logged-out': { type: 'string' } } });
  const result = values['base-url'] && values.path && values.state
    ? await probeState({ baseUrl: values['base-url'], probePath: values.path, stateFile: values.state, loggedOutPattern: values['logged-out'] ?? null })
    : ({ outcome: 'error', httpStatus: null, detail: 'usage: auth-probe.ts --base-url <url> --path <path> --state <file>' } satisfies ProbeResult);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

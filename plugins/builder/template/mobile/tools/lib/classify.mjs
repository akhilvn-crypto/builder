// Failure classification: application | automation | device | environment | unclassified.
//
// A rule table over what Maestro actually printed (and its debug commands file, when present). It is deliberately
// conservative: a reading that could be two things gets confidence "low" and needsConfirmation, so a person or the
// healer agent looks at the screenshot before anything is reported as an application defect or "fixed".

import { existsSync, readFileSync } from 'node:fs';
import { toPosix, walkFiles } from './util.mjs';
import path from 'node:path';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

export const CATEGORY_MEANING = {
  application: 'The app did not behave as the test case expects (wrong result, crash). Report it as an application defect once confirmed.',
  automation: 'The flow, its selectors or its variables are wrong or out of date. Fix the flow (or the app\'s accessibility ids).',
  device: 'The phone/emulator or its connection failed (offline, unauthorised, driver, storage). Fix the device and run again.',
  environment: 'The test environment is not ready (app not installed or cannot launch, backend unreachable, build missing).',
  unclassified: 'Not enough evidence to say. Read the screenshot and the log.',
};

const DEVICE = [
  /no (?:android )?devices?(?:\/emulators?)? (?:found|connected|attached)/i, /device '?[\w:.-]*'? not found/i, /\bdevice (is )?offline\b/i, /device unauthorized|error: device unauthorized/i,
  /adb server (didn'?t|did not) ack|failed to start (adb )?daemon|cannot connect to daemon/i, /unable to connect to (the )?(device|emulator)/i,
  /StatusRuntimeException:\s*UNAVAILABLE|io exception|UNAVAILABLE: /i, /maestro driver|failed to (install|start) (the )?(maestro )?(driver|instrumentation)/i,
  /INSTALL_FAILED_|INSUFFICIENT_STORAGE|insufficient storage/i, /device (disconnected|lost|was removed)/i, /connection refused.*(7001|7002)|ConnectException.*7001/i,
  /instrumentation.*(crash|not running|fail)/i, /xcodebuild.*failed|simulator.*not booted|unable to boot/i,
];
const ENVIRONMENT = [
  /unable to launch app|failed to launch app|could not launch|couldn'?t find a launchable activity|activity class .* does not exist/i,
  /app .* (is )?not installed|package .* (not found|is not installed)|unknown package/i, /UnknownHost|unable to resolve host|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network is unreachable/i,
  /\b50[234]\b.*(gateway|unavailable|timeout)|service unavailable|bad gateway/i,
];
const CRASH = [/app(lication)? (has )?(crashed|stopped)|process (died|crashed)|\bANR\b|application not responding|unfortunately,? .* has stopped/i];
const AUTOMATION_ALWAYS = [
  /failed to parse|invalid (flow|yaml)|yaml.*(error|exception)|unknown (command|property)|unrecognized (field|property)|unexpected (token|key)/i,
  /flow file .*(not found|does not exist)|no such file or directory|runFlow.*not found/i, /syntaxerror|jsexception|referenceerror|script (error|failed)/i,
  /(variable|reference).{0,40}(not defined|undefined|unresolved)|is not defined/i, /(not supported|unsupported) on (ios|android|this platform)/i,
];
const ELEMENT_NOT_FOUND = [/element not found/i, /no (visible )?elements? (found|match)/i, /unable to find (a )?view|could not find (a )?(view|element)/i];
const ASSERTION = [/assertion is false/i, /assert(ion)? failed/i, /expected .* to be visible|is not visible/i];

/** Pull the failing command out of Maestro's debug commands file(s) or, failing that, its log. */
export function failedCommandFrom({ debugDir, log }) {
  if (debugDir && existsSync(debugDir)) {
    for (const f of walkFiles(debugDir, { maxDepth: 2 }).filter((x) => /commands.*\.json$/i.test(path.basename(x)))) {
      try {
        const entries = JSON.parse(readFileSync(f, 'utf8'));
        const list = Array.isArray(entries) ? entries : [];
        const bad = list.find((e) => /FAILED/i.test(String(e?.metadata?.status ?? '')));
        if (bad?.command && typeof bad.command === 'object') {
          const name = Object.keys(bad.command)[0];
          const body = bad.command[name];
          const summary = body && typeof body === 'object'
            ? Object.entries(body).filter(([, v]) => v !== null && typeof v !== 'object' && v !== '').slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ')
            : '';
          const rawName = name.replace(/Command$/, '').replace(/^./, (c) => c.toLowerCase());
          return { name: rawName, description: `${rawName}${summary ? ` (${summary})` : ''}`, message: bad.metadata?.error?.message ?? null, source: 'commands-json' };
        }
      } catch { /* try the next file */ }
    }
  }
  const m = /(?:❌|\[Failed\]|FAILED)\s+(.+)$/m.exec(stripAnsi(log));
  if (m) {
    const description = m[1].trim();
    const name = /^(?:Tap on|Long press on|Double tap on)/i.test(description) ? 'tapOn'
      : /^Assert/i.test(description) ? 'assert' : /^Input text/i.test(description) ? 'inputText' : /^Launch app/i.test(description) ? 'launchApp'
        : /^Scroll/i.test(description) ? 'scroll' : /^Run flow/i.test(description) ? 'runFlow' : null;
    return { name, description, message: null, source: 'log' };
  }
  return null;
}

export function classifyFailure({ exitCode, timedOut = false, spawnError = null, log = '', debugDir = null }) {
  const text = stripAnsi(log);
  const failed = failedCommandFrom({ debugDir, log: text });
  const haystack = `${text}\n${failed?.message ?? ''}`;
  const excerpt = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-15).join('\n');
  const make = (category, confidence, reason, hint = null) => ({
    category, confidence, reason, hint, needsConfirmation: confidence !== 'high', failedCommand: failed, excerpt,
  });
  if (spawnError) return make('environment', 'high', `Maestro could not be started: ${spawnError}`, 'Check that the Maestro CLI is installed and on PATH (preflight).');
  if (DEVICE.some((re) => re.test(haystack))) return make('device', 'high', 'Maestro could not talk to the device (connection, driver or storage).', 'Run `device verify`; reconnect or restart the device and run again.');
  if (AUTOMATION_ALWAYS.some((re) => re.test(haystack))) return make('automation', 'high', 'The flow or its variables are invalid or reference something that does not exist.', 'Run `validate`; define the missing variable or fix the YAML.');
  if (CRASH.some((re) => re.test(haystack))) return make('application', 'high', 'The app crashed or stopped responding during the flow.', 'Capture the device log; report as an application defect after confirming.');
  if (ENVIRONMENT.some((re) => re.test(haystack))) return make('environment', 'medium', 'The app could not be launched or a backend/network error was reported.', 'Check the installed build and appId (`device verify`) and that the test environment is reachable from the device.');
  const isAssertion = ASSERTION.some((re) => re.test(haystack)) || failed?.name === 'assert' || /^assert/i.test(failed?.name ?? '');
  const notFound = ELEMENT_NOT_FOUND.some((re) => re.test(haystack));
  if (isAssertion) {
    return make('application', 'low', 'An expected outcome was not observed after the earlier steps succeeded.', 'Open the failure screenshot: if the screen is right but the selector is not, it is an automation issue; if the screen is wrong, it is an application defect.');
  }
  if (notFound) {
    return make('automation', 'medium', `The element the flow tried to use was not found on screen${failed ? ` (${failed.description})` : ''}.`, 'Run `inspect hierarchy` on that screen. If only the id/label changed, fix the selector; if the screen or navigation changed, review the test case before touching the flow.');
  }
  if (timedOut) return make('unclassified', 'low', 'The flow did not finish within the time limit.', 'Look at the last screenshot and the log: a hung app, a slow environment and a wait that never succeeds look the same from outside.');
  if (exitCode !== 0) return make('unclassified', 'low', `Maestro exited with code ${exitCode} without a message this tool recognises.`, 'Read the log excerpt and the screenshot.');
  return make('unclassified', 'low', 'No failure found.');
}

export const relPosix = (from, to) => toPosix(path.relative(from, to));

// Deterministic validation of Maestro flows before anything runs: YAML, structure, references, selectors,
// assertions, secrets, app identifiers, traceability. No LLM, no device, no Maestro needed (Maestro's own
// `check-syntax` is added on top when the installed CLI offers it).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_VARS, SECRET_PREFIX, platformIdentifier } from './config.mjs';
import {
  KNOWN_COMMANDS, analyzeFlow, collectVariables, flowReferences, isSubflowPath, listFlowFiles, selectorsOf,
  walkCommands,
} from './flows.mjs';
import { toPosix } from './util.mjs';
import { lineOfKey } from './yaml.mjs';

const SECRET_NAME = /(pass(word)?|pwd|secret|token|otp|pin|cvv|api[_-]?key)/i;
const ANDROID_ONLY = new Set(['back']);
const IOS_ONLY = new Set(['clearKeychain']);
const CLASSIFICATION_TAGS = ['smoke', 'regression', 'critical'];

function hasReason(flow, line, word) {
  if (!line) return false;
  // a comment on the line above, on the command's own lines (point:/index: sit a line or two below "- tapOn:")
  const re = new RegExp(`#.*\\b${word}\\b.*\\breason\\b|#\\s*reason\\s*:`, 'i');
  return flow.lines.slice(Math.max(0, line - 2), line + 3).some((l) => re.test(l));
}

/**
 * Validate every flow (or the given analyses). Returns
 * { ok, errors, warnings, files: [{ file, kind, issues: [{ severity, code, message, line }] }], variables }.
 * `variables` lists, per flow, the ${NAME}s it needs from outside (not defined by its own env header).
 */
export function validateFlows(ctx, cfg, { flows, check = {} } = {}) {
  const all = listFlowFiles(ctx);
  const allAnalyses = new Map(all.map((f) => [f.rel, null]));
  const analysis = (abs) => {
    const rel = toPosix(path.relative(ctx.fw, abs));
    if (!allAnalyses.get(rel)) allAnalyses.set(rel, analyzeFlow(ctx, abs));
    return allAnalyses.get(rel);
  };
  const targets = flows ?? all.map((f) => analysis(f.abs));
  const idsSeen = new Map();
  const files = [];
  const variables = {};
  const configuredIds = ['android', 'ios'].filter((p) => cfg?.platforms?.[p]?.enabled).map((p) => platformIdentifier(cfg, p));
  const configEnvNames = new Set(check.environmentVariables ?? []);

  for (const flow of targets) {
    const issues = [];
    const add = (severity, code, message, line = null) => issues.push({ severity, code, message, line });
    const isTest = flow.kind === 'test';

    if (flow.yamlError) {
      add('error', flow.yamlError.unsupported ? 'yaml_unsupported' : 'yaml_syntax', flow.yamlError.message.replace(/^line \d+: /, ''), flow.yamlError.line);
      files.push({ file: flow.rel, kind: flow.kind, issues });
      continue;
    }

    // ---- header
    if (isTest) {
      if (!flow.header) add('error', 'header_missing', 'A test flow needs a header above "---" with at least appId.', 1);
      else if (!flow.appId) add('error', 'app_id_missing', 'The header has no appId.', flow.headerLine);
      if (!flow.name) add('warning', 'name_missing', 'The header has no name (shown in reports).', flow.headerLine);
    }
    if (flow.appId && !/^\$\{\w+\}$/.test(flow.appId)) {
      if (cfg?.flows?.appIdMode === 'env') add('warning', 'app_id_literal', `appId is written out (${flow.appId}) but flows.appIdMode is "env": use \${APP_ID} so Android and iOS share the flow.`, lineOfKey(flow.header, 'appId'));
      if (configuredIds.length && !configuredIds.includes(flow.appId)) {
        add('error', 'app_id_mismatch', `appId ${flow.appId} is not one of the configured application identifiers (${configuredIds.join(', ')}).`, lineOfKey(flow.header, 'appId'));
      }
    }
    if (flow.appId === '${APP_ID}' && cfg?.flows?.appIdMode === 'literal') {
      add('warning', 'app_id_env_in_literal_mode', 'flows.appIdMode is "literal" but this flow uses ${APP_ID}.', lineOfKey(flow.header, 'appId'));
    }

    // ---- commands
    if (!flow.commands || flow.commands.length === 0) add('error', 'commands_missing', 'The flow has no commands.', flow.headerLine ?? 1);

    // ---- traceability and classification (test flows)
    if (isTest) {
      if (!flow.testCase) {
        add(flow.generated ? 'error' : 'warning', 'testcase_link_missing', 'No "# testCase: <ID>" header comment: the flow cannot be traced to a test case.', 1);
      } else if (idsSeen.has(flow.testCase)) {
        add('error', 'testcase_duplicate', `Test case ${flow.testCase} is also linked from ${idsSeen.get(flow.testCase)}.`, 1);
      } else idsSeen.set(flow.testCase, flow.rel);
      if (flow.tags.length === 0) add('warning', 'tags_missing', 'No tags: add smoke and/or regression (and critical, high, security where they apply) so suites can select the flow.', flow.headerLine);
      else if (!flow.tags.some((t) => CLASSIFICATION_TAGS.includes(t))) add('warning', 'classification_missing', `None of the tags ${CLASSIFICATION_TAGS.join(', ')} is set, so no suite will pick this flow up.`, lineOfKey(flow.header, 'tags'));
    }

    // ---- walk
    let asserts = 0;
    const needed = new Set();
    let previousTap = null;
    const visit = (cmd, state) => {
      if (cmd.shape === 'multi') add('error', 'command_shape', `A list entry holds several commands (${cmd.name}); each "- command" must stand alone (check the indentation).`, cmd.line);
      else if (cmd.shape === 'empty' || cmd.shape === 'invalid') add('error', 'command_shape', 'Empty or invalid command entry.', cmd.line);
      else if (!KNOWN_COMMANDS.has(cmd.name)) add('warning', 'unknown_command', `"${cmd.name}" is not a command this validator knows; check the spelling or the installed Maestro version.`, cmd.line);
      if (cmd.name.startsWith('assert')) asserts += 1;
      if (cmd.name === 'assertVisible' && cmd.value && typeof cmd.value === 'object' && cmd.value.optional === true) {
        add('error', 'assertion_optional', 'An assertion marked optional never fails, so it asserts nothing. Remove optional: true.', cmd.line);
      }
      if (ANDROID_ONLY.has(cmd.name) && !state.platformGuarded && !flow.platform && !flow.tags.includes('android-only')) {
        add('warning', 'platform_specific', `"${cmd.name}" only works on Android. Put it in a runFlow with "when: platform: Android", a *.android.yaml flow or the android-only tag.`, cmd.line);
      }
      if (cmd.name === 'pressKey' && String(cmd.value).toLowerCase() === 'back' && !state.platformGuarded && !flow.platform && !flow.tags.includes('android-only')) {
        add('warning', 'platform_specific', 'pressKey: Back only works on Android. Isolate it behind "when: platform: Android".', cmd.line);
      }
      if (IOS_ONLY.has(cmd.name) && !state.platformGuarded && !flow.platform && !flow.tags.includes('ios-only')) {
        add('warning', 'platform_specific', `"${cmd.name}" only works on iOS. Isolate it behind "when: platform: iOS".`, cmd.line);
      }
      for (const s of selectorsOf(cmd)) {
        const sel = s.selector;
        if (sel && typeof sel === 'object') {
          if ('point' in sel) {
            const reason = hasReason(flow, cmd.line, 'coordinates');
            add(reason ? 'warning' : 'error', reason ? 'coordinates_used' : 'coordinates_without_reason',
              reason ? 'Coordinates are a last resort; the reason is documented.' : 'Coordinate selector without a reason. Use an accessibility id or text; if coordinates are truly the only option add a comment "# coordinates: reason: <why>" on or above the line.', cmd.line);
          }
          if ('index' in sel && !hasReason(flow, cmd.line, 'index')) {
            add('warning', 'index_without_reason', 'Index selectors depend on element order. Prefer an id, or add "# index: reason: <why the order is stable>".', cmd.line);
          }
          if (s.role === 'assert' && sel.optional === true) add('error', 'assertion_optional', 'An optional assertion never fails.', cmd.line);
        }
      }
      // hardcoded secrets typed into a secret-looking field
      // a value the test case itself declares as `literal:` (a deliberately fake password in a negative test) is marked "# literal" on its line
      const markedLiteral = /#.*\bliteral\b/i.test(flow.lines[(cmd.line ?? 1) - 1] ?? '');
      if (cmd.name === 'inputText' && typeof cmd.value === 'string' && !cmd.value.includes('${') && previousTap && !markedLiteral) {
        const label = [previousTap.id, previousTap.text].filter((x) => typeof x === 'string').join(' ');
        if (SECRET_NAME.test(label)) add('error', 'hardcoded_secret', `A literal value is typed into "${label.trim().slice(0, 40)}", which looks like a secret field. Reference an environment variable (\${${SECRET_PREFIX}NAME}) instead.`, cmd.line);
      }
      if (cmd.name === 'tapOn') previousTap = typeof cmd.value === 'string' ? { text: cmd.value } : (cmd.value ?? null);
      else if (!['inputText', 'hideKeyboard', 'eraseText'].includes(cmd.name)) previousTap = null;
      if (['openLink', 'inputText'].includes(cmd.name) && typeof cmd.value === 'string' && /^https?:\/\//i.test(cmd.value) && !cmd.value.includes('${')) {
        add('warning', 'hardcoded_environment_value', 'A fixed URL is written into the flow. Put environment-specific values in config/environments/<env>.json and reference ${NAME}.', cmd.line);
      }
      if (['runScript', 'evalScript'].includes(cmd.name)) {
        const script = typeof cmd.value === 'string' ? cmd.value : '';
        if (/\b(sleep|setTimeout|Thread\.sleep)\b/.test(script)) add('warning', 'fixed_sleep', 'A fixed wait in a script. Wait for an element with extendedWaitUntil or an assertion instead.', cmd.line);
      }
    };
    walkCommands(flow.commands, visit);
    walkCommands(flow.header?.onFlowStart, visit);
    walkCommands(flow.header?.onFlowComplete, visit);

    if (isTest && flow.commands?.length && asserts === 0) {
      add('error', 'no_assertions', 'The flow asserts nothing itself. Add assertVisible / assertNotVisible / assertTrue for each expected result, in this file (not only inside a shared subflow).', flow.headerLine ?? 1);
    }

    // ---- references
    for (const ref of flowReferences(flow)) {
      const target = path.resolve(path.dirname(flow.abs), ref.file);
      if (!existsSync(target)) { add('error', 'runflow_missing', `runFlow target not found: ${ref.file}`, ref.line); continue; }
      if (!toPosix(target).startsWith(toPosix(ctx.p.flows))) add('warning', 'runflow_outside_flows', `runFlow target ${ref.file} is outside flows/.`, ref.line);
      else if (isTest && !isSubflowPath(toPosix(path.relative(ctx.p.flows, target))) && !/\.ya?ml$/i.test(target)) add('warning', 'runflow_not_yaml', `runFlow target ${ref.file} is not a YAML file.`, ref.line);
    }

    // ---- variables
    const used = new Set();
    collectVariables(flow.commands, used);
    collectVariables(flow.header, used);
    for (const name of used) {
      if (flow.envDefined.has(name)) continue;
      needed.add(name);
    }
    const builtin = new Set([...BUILTIN_VARS, ...configEnvNames]);
    for (const name of needed) {
      if (builtin.has(name) || name.startsWith(SECRET_PREFIX)) continue;
      if (flow.kind === 'subflow') continue; // a subflow's variables come from the flow that runs it
      add('warning', 'unknown_variable', `\${${name}} is not defined by the flow's env header, the environment file or the runner. Define it or rename it (secrets are \${${SECRET_PREFIX}NAME}).`, null);
    }
    variables[flow.rel] = [...needed].sort();

    // ---- semantics requests pending
    if (flow.semanticsRequests.length) add('warning', 'semantics_pending', `Waiting for Flutter accessibility changes: ${[...new Set(flow.semanticsRequests)].join(', ')} (see docs/semantics-requests.md). The selector used is provisional.`, null);

    files.push({ file: flow.rel, kind: flow.kind, issues });
  }

  // ---- cycles through runFlow (checked over the whole workspace graph reachable from the targets)
  const cycleReported = new Set();
  const findCycle = (abs, stack) => {
    const rel = toPosix(path.relative(ctx.fw, abs));
    if (stack.includes(rel)) return [...stack.slice(stack.indexOf(rel)), rel];
    const a = analysis(abs);
    if (a.yamlError) return null;
    for (const ref of flowReferences(a)) {
      const t = path.resolve(path.dirname(abs), ref.file);
      if (!existsSync(t) || !/\.ya?ml$/i.test(t)) continue;
      const c = findCycle(t, [...stack, rel]);
      if (c) return c;
    }
    return null;
  };
  for (const flow of targets) {
    if (flow.yamlError) continue;
    const cycle = findCycle(flow.abs, []);
    if (cycle && !cycleReported.has(cycle.join('>'))) {
      cycleReported.add(cycle.join('>'));
      files.find((f) => f.file === flow.rel)?.issues.push({ severity: 'error', code: 'runflow_cycle', message: `runFlow cycle: ${cycle.join(' → ')}`, line: null });
    }
  }

  const count = (sev) => files.reduce((n, f) => n + f.issues.filter((i) => i.severity === sev).length, 0);
  return { ok: count('error') === 0, errors: count('error'), warnings: count('warning'), flows: files.length, files, variables };
}

/** Variables the selected flows need from outside, following runFlow into subflows (their own env: maps excluded). */
export function referencedVariables(ctx, flows) {
  const needed = new Set();
  const seen = new Set();
  const visit = (abs, inherited) => {
    const a = analyzeFlow(ctx, abs);
    if (a.yamlError || seen.has(`${abs}|${[...inherited].join(',')}`)) return;
    seen.add(`${abs}|${[...inherited].join(',')}`);
    const defined = new Set([...inherited, ...a.envDefined]);
    const used = new Set();
    collectVariables(a.commands, used);
    collectVariables(a.header, used);
    for (const n of used) if (!defined.has(n)) needed.add(n);
    const walk = (cmd) => {
      if (cmd.name !== 'runFlow' || !cmd.value || typeof cmd.value !== 'object' || typeof cmd.value.file !== 'string') return;
      const target = path.resolve(path.dirname(abs), cmd.value.file);
      const passed = cmd.value.env && typeof cmd.value.env === 'object' ? Object.keys(cmd.value.env) : [];
      if (existsSync(target)) visit(target, new Set([...defined, ...passed]));
    };
    walkCommands(a.commands, walk);
  };
  for (const f of flows) visit(f.abs, new Set());
  return needed;
}

export function summarizeIssues(result, { max = 40 } = {}) {
  const lines = [];
  for (const f of result.files) {
    for (const i of f.issues) lines.push(`${i.severity.toUpperCase()} ${f.file}${i.line ? `:${i.line}` : ''} [${i.code}] ${i.message}`);
  }
  return lines.slice(0, max);
}

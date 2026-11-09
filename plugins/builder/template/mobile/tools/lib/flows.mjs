// Reading Maestro flow files: header, commands, selectors, references, variables; and choosing which flows a run uses.
//
// Conventions (see docs/flow-conventions.md in the framework):
//   flows/common/**         reusable subflows, never run on their own
//   flows/<feature>/*.yaml  one focused test flow each; the header comment `# testCase: <ID>` links it to its test case
//   file.android.yaml / file.ios.yaml, or tags android-only / ios-only: platform-specific flows
//   tests/<suite>.yaml      suite definitions (includeTags / excludeTags / flows globs); not Maestro flows

import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError, readText, sha256, toPosix, walkFiles } from './util.mjs';
import { lineOfItem, lineOfKey, parseYamlStream, YamlError } from './yaml.mjs';

export const GENERATED_MARKER = '@builder:generated';

export const KNOWN_COMMANDS = new Set([
  'launchApp', 'stopApp', 'killApp', 'clearState', 'clearKeychain', 'tapOn', 'longPressOn', 'doubleTapOn', 'inputText',
  'inputRandomText', 'inputRandomNumber', 'inputRandomEmail', 'inputRandomPersonName', 'eraseText', 'hideKeyboard',
  'pressKey', 'back', 'scroll', 'scrollUntilVisible', 'swipe', 'assertVisible', 'assertNotVisible', 'assertTrue',
  'assertScreenshot', 'assertWithAI', 'assertNoDefectsWithAI', 'extendedWaitUntil', 'waitForAnimationToEnd',
  'takeScreenshot', 'startRecording', 'stopRecording', 'openLink', 'runFlow', 'runScript', 'evalScript', 'repeat',
  'retry', 'copyTextFrom', 'pasteText', 'setLocation', 'setOrientation', 'setAirplaneMode', 'toggleAirplaneMode',
  'travel', 'addMedia', 'setPermissions', 'extractTextWithAI', 'defineVariables', 'setClipboard',
]);

export const SELECTOR_COMMANDS = new Set(['tapOn', 'longPressOn', 'doubleTapOn', 'assertVisible', 'assertNotVisible', 'copyTextFrom']);
const RELATIVE_KEYS = ['below', 'above', 'leftOf', 'rightOf', 'childOf', 'containsChild', 'containsDescendants'];

export const isSubflowPath = (relToFlows) => /^common\//.test(relToFlows);
export const platformOfFile = (file) => (/\.android\.ya?ml$/i.test(file) ? 'android' : /\.ios\.ya?ml$/i.test(file) ? 'ios' : null);

export function listFlowFiles(ctx) {
  return walkFiles(ctx.p.flows)
    .filter((f) => /\.ya?ml$/i.test(f) && path.basename(f).toLowerCase() !== 'config.yaml')
    .map((abs) => {
      const relToFlows = toPosix(path.relative(ctx.p.flows, abs));
      return { abs, rel: toPosix(path.relative(ctx.fw, abs)), relToFlows, kind: isSubflowPath(relToFlows) ? 'subflow' : 'test' };
    });
}

/** Normalise one list entry into { name, value, line }; a command is `name`, or `{ name: value }`. */
export function commandOf(entry, list, index) {
  const line = lineOfItem(list, index);
  if (typeof entry === 'string') return { name: entry, value: null, line, shape: 'ok' };
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const keys = Object.keys(entry);
    if (keys.length === 1) return { name: keys[0], value: entry[keys[0]], line: lineOfKey(entry, keys[0]) ?? line, shape: 'ok' };
    return { name: keys.join('+'), value: entry, line, shape: keys.length === 0 ? 'empty' : 'multi' };
  }
  return { name: String(entry), value: null, line, shape: 'invalid' };
}

/**
 * Visit every command, including those nested in runFlow/repeat/retry blocks and the header hooks.
 * visit(cmd, ctx) where ctx = { depth, platformGuarded, parent }.
 */
export function walkCommands(commands, visit, state = { depth: 0, platformGuarded: false, parent: null }) {
  if (!Array.isArray(commands)) return;
  commands.forEach((entry, i) => {
    const cmd = commandOf(entry, commands, i);
    visit(cmd, state);
    if (cmd.shape !== 'ok' || !cmd.value || typeof cmd.value !== 'object') return;
    const v = cmd.value;
    const guarded = state.platformGuarded || (cmd.name === 'runFlow' && v.when && typeof v.when === 'object' && 'platform' in v.when);
    const next = { depth: state.depth + 1, platformGuarded: guarded, parent: cmd.name };
    if (['runFlow', 'repeat', 'retry'].includes(cmd.name) && Array.isArray(v.commands)) walkCommands(v.commands, visit, next);
  });
}

/** Selectors carried by a command: [{ selector, role, line, key }]. Relative selectors (below: …) are returned too. */
export function selectorsOf(cmd) {
  const out = [];
  const push = (selector, role, key) => out.push({ selector, role, line: cmd.line, key });
  const expand = (selector, role, key) => {
    push(selector, role, key);
    if (selector && typeof selector === 'object') {
      for (const rk of RELATIVE_KEYS) if (selector[rk] && typeof selector[rk] === 'object') expand(selector[rk], role, rk);
    }
  };
  if (SELECTOR_COMMANDS.has(cmd.name)) expand(cmd.value, cmd.name.startsWith('assert') ? 'assert' : 'action', cmd.name);
  else if (cmd.name === 'scrollUntilVisible' && cmd.value?.element) expand(cmd.value.element, 'action', 'element');
  else if (cmd.name === 'extendedWaitUntil' && cmd.value) {
    if (cmd.value.visible) expand(cmd.value.visible, 'wait', 'visible');
    if (cmd.value.notVisible) expand(cmd.value.notVisible, 'wait', 'notVisible');
  }
  return out;
}

const VAR_RE = /\$\{([^}]*)\}/g;

/** Simple ${NAME} references in every string below `node`. Expressions (${a + b}, ${output.x}) are not variable names. */
export function collectVariables(node, into = new Set()) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(VAR_RE)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1].trim())) into.add(m[1].trim());
  } else if (Array.isArray(node)) node.forEach((n) => collectVariables(n, into));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collectVariables(n, into));
  return into;
}

function headerComments(text) {
  const info = { generated: false, testCase: null, source: null, semanticsRequests: [] };
  const lines = text.split(/\r?\n/);
  for (const l of lines.slice(0, 20)) {
    if (!/^\s*#/.test(l)) continue;
    if (l.includes(GENERATED_MARKER)) info.generated = true;
    let m = /^\s*#\s*testCase:\s*(\S+)/.exec(l);
    if (m) info.testCase = m[1];
    m = /^\s*#\s*source:\s*(.+?)\s*$/.exec(l);
    if (m) info.source = m[1];
  }
  for (const l of lines) {
    const m = /#\s*semantics-request:\s*([A-Za-z0-9-]+)/.exec(l);
    if (m) info.semanticsRequests.push(m[1]);
  }
  return info;
}

/** Read and analyse one flow file. Never throws for bad YAML: the problem is returned in `yamlError`. */
export function analyzeFlow(ctx, abs) {
  const text = readText(abs, '');
  const rel = toPosix(path.relative(ctx.fw, abs));
  const relToFlows = toPosix(path.relative(ctx.p.flows, abs));
  const flow = {
    abs, rel, relToFlows, kind: isSubflowPath(relToFlows) ? 'subflow' : 'test', text, hash: sha256(text), lines: text.split(/\r?\n/),
    yamlError: null, header: null, commands: null, headerLine: null, name: null, appId: null, tags: [], envDefined: new Set(),
    platform: platformOfFile(abs), ...headerComments(text),
  };
  let parsed;
  try { parsed = parseYamlStream(text); } catch (err) {
    if (err instanceof YamlError) { flow.yamlError = { message: err.message, line: err.line, unsupported: err.unsupported }; return flow; }
    throw err;
  }
  const docs = parsed.documents;
  const isList = (d) => Array.isArray(d.value);
  if (docs.length === 1 && isList(docs[0])) flow.commands = docs[0].value;
  else if (docs.length >= 2) {
    const header = docs[0].value;
    if (header !== null && (typeof header !== 'object' || Array.isArray(header))) {
      flow.yamlError = { message: 'The part before "---" must be a mapping (appId, name, tags, env).', line: docs[0].line };
    } else flow.header = header;
    if (isList(docs[1])) flow.commands = docs[1].value;
    else if (docs[1].value === null) flow.commands = [];
    else flow.yamlError ??= { message: 'The part after "---" must be a list of commands (lines starting with "- ").', line: docs[1].line };
    if (docs.length > 2) flow.yamlError ??= { message: 'A flow has one "---" separator: header above, commands below.', line: docs[2].line };
  } else if (docs.length === 1 && docs[0].value && typeof docs[0].value === 'object') {
    flow.header = docs[0].value;
    flow.commands = [];
  }
  const h = flow.header;
  if (h) {
    flow.headerLine = docs[0].line;
    flow.name = typeof h.name === 'string' ? h.name : null;
    flow.appId = typeof h.appId === 'string' ? h.appId : null;
    flow.tags = Array.isArray(h.tags) ? h.tags.map(String) : (typeof h.tags === 'string' ? [h.tags] : []);
    if (h.env && typeof h.env === 'object') flow.envDefined = new Set(Object.keys(h.env));
  }
  return flow;
}

/** The relative file references (runFlow) of a flow with the line each one is on. */
export function flowReferences(flow) {
  const refs = [];
  const visit = (cmd) => {
    if (cmd.name !== 'runFlow' || cmd.shape !== 'ok') return;
    const v = cmd.value;
    if (typeof v === 'string') refs.push({ file: v, line: cmd.line });
    else if (v && typeof v === 'object' && typeof v.file === 'string') refs.push({ file: v.file, line: cmd.line });
  };
  walkCommands(flow.commands, visit);
  walkCommands(flow.header?.onFlowStart, visit);
  walkCommands(flow.header?.onFlowComplete, visit);
  return refs;
}

// ---------------------------------------------------------------- suites and selection

export function readSuite(ctx, name) {
  const file = path.join(ctx.p.tests, `${name}.yaml`);
  const text = readText(file, null);
  if (text === null) {
    const known = walkFiles(ctx.p.tests).filter((f) => /\.ya?ml$/i.test(f)).map((f) => path.basename(f).replace(/\.ya?ml$/i, ''));
    throw new CliError(`Suite "${name}" does not exist (tests/${name}.yaml). Available: ${known.join(', ') || 'none'}.`, { needsInput: 'suite' });
  }
  let doc;
  try { doc = parseYamlStream(text).documents[0].value ?? {}; } catch (err) { throw new CliError(`tests/${name}.yaml: ${err.message}`); }
  const list = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  return {
    name: String(doc.name ?? name), description: doc.description ?? '', file: toPosix(path.relative(ctx.fw, file)),
    includeTags: list(doc.includeTags), excludeTags: list(doc.excludeTags), flows: list(doc.flows),
  };
}

export function listSuites(ctx) {
  return walkFiles(ctx.p.tests).filter((f) => /\.ya?ml$/i.test(f)).map((f) => path.basename(f).replace(/\.ya?ml$/i, '')).sort();
}

function globToRegex(glob) {
  const g = toPosix(glob).replace(/^flows\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function resolveFlowArg(ctx, arg) {
  const candidates = [path.resolve(ctx.root, arg), path.resolve(ctx.fw, arg), path.resolve(ctx.p.flows, arg)];
  for (const c of candidates) if (existsSync(c) && /\.ya?ml$/i.test(c)) return c;
  return null;
}

/**
 * Choose the flows for a run. `sel` = { flow[], testId[], feature[], suite, tag[], all }. Selectors are combined (union).
 * Returns { selected: [analysis], skipped: [{ rel, reason }], scope: { description } }.
 */
export function selectFlows(ctx, sel, { platform, traceability } = {}) {
  const all = listFlowFiles(ctx).filter((f) => f.kind === 'test').map((f) => analyzeFlow(ctx, f.abs));
  const byRel = new Map(all.map((f) => [f.rel, f]));
  const chosen = new Map();
  const parts = [];
  const add = (f) => chosen.set(f.rel, f);

  if (sel.all) { all.forEach(add); parts.push('all flows'); }
  for (const arg of sel.flow ?? []) {
    const abs = resolveFlowArg(ctx, arg);
    if (!abs) throw new CliError(`Flow not found: ${arg}`, { needsInput: 'flow' });
    const rel = toPosix(path.relative(ctx.fw, abs));
    if (!rel.startsWith('flows/')) throw new CliError(`${arg} is not under flows/.`);
    if (isSubflowPath(toPosix(path.relative(ctx.p.flows, abs)))) throw new CliError(`${rel} is a reusable subflow (flows/common/); run the test flows that use it.`);
    add(byRel.get(rel) ?? analyzeFlow(ctx, abs));
    parts.push(`flow ${rel}`);
  }
  for (const id of sel.testId ?? []) {
    const mapped = traceability?.cases?.[id]?.flow;
    const f = (mapped && byRel.get(mapped)) || all.find((x) => x.testCase === id);
    if (!f) throw new CliError(`No flow is linked to test case ${id}.`, { needsInput: 'testId' });
    add(f);
    parts.push(`test case ${id}`);
  }
  for (const feature of sel.feature ?? []) {
    const hits = all.filter((f) => f.relToFlows.startsWith(`${feature.replace(/^\/|\/$/g, '')}/`));
    if (!hits.length) throw new CliError(`No flows in feature "${feature}".`, { needsInput: 'feature' });
    hits.forEach(add);
    parts.push(`feature ${feature}`);
  }
  for (const tag of sel.tag ?? []) {
    all.filter((f) => f.tags.includes(tag)).forEach(add);
    parts.push(`tag ${tag}`);
  }
  if (sel.suite) {
    const suite = readSuite(ctx, sel.suite);
    const globs = suite.flows.map(globToRegex);
    for (const f of all) {
      const byTag = suite.includeTags.length > 0 && f.tags.some((t) => suite.includeTags.includes(t));
      const byGlob = globs.some((re) => re.test(f.relToFlows));
      const unrestricted = suite.includeTags.length === 0 && suite.flows.length === 0;
      if ((byTag || byGlob || unrestricted) && !f.tags.some((t) => suite.excludeTags.includes(t))) add(f);
    }
    parts.push(`suite ${suite.name}`);
  }
  if (parts.length === 0) {
    throw new CliError('Choose what to run: --flow <file>, --test <ID>, --feature <name>, --suite <name> or --all.', { needsInput: 'scope' });
  }

  const selected = [];
  const skipped = [];
  for (const f of [...chosen.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const filePlatform = f.platform;
    const tagPlatform = f.tags.includes('android-only') ? 'android' : f.tags.includes('ios-only') ? 'ios' : null;
    const only = filePlatform ?? tagPlatform;
    if (platform && only && only !== platform) skipped.push({ rel: f.rel, reason: `${only}-only flow, run is on ${platform}` });
    else selected.push(f);
  }
  return { selected, skipped, scope: { description: parts.join(' + '), selectors: sel } };
}

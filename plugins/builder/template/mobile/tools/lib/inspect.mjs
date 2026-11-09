// Looking at the real screen (`maestro hierarchy`) and recording accessibility changes the Flutter team has to make.
//
// Maestro finds elements through the accessibility tree. When a control has no stable id the answer is a documented
// request for a Semantics identifier in the app, not a fragile selector hidden in a flow.

import path from 'node:path';
import { detectCapabilities, withDevice } from './preflight.mjs';
import { CliError, ensureDir, nowIso, readText, run, slug, stamp, toPosix, writeFileAtomic, writeJson } from './util.mjs';

function firstJson(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const end = text.lastIndexOf(text[start] === '{' ? '}' : ']');
  if (end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  const a = node.attributes ?? {};
  out.push({
    id: a['resource-id'] || a.id || '', text: a.text || '', accessibilityText: a.accessibilityText || a['content-desc'] || '', hint: a.hintText || '',
    className: a.class || '', clickable: String(a.clickable) === 'true', enabled: a.enabled === undefined ? null : String(a.enabled) === 'true',
    focused: String(a.focused) === 'true', bounds: a.bounds || '',
  });
  for (const c of node.children ?? []) flatten(c, out);
  return out;
}

/** Capture the hierarchy of the screen the device shows now and boil it down to selector candidates. */
export async function inspectHierarchy(ctx, tools, { deviceId, name = 'screen', limit = 120 }) {
  if (!tools.maestro) throw new CliError('The Maestro CLI was not found.', { needsInput: 'maestro' });
  const caps = await detectCapabilities(tools.maestro);
  const r = await run(tools.maestro, withDevice(caps, deviceId, ['hierarchy']), { timeoutMs: 90000 });
  if (r.code !== 0) throw new CliError(`maestro hierarchy failed: ${(r.stderr || r.stdout || r.spawnError || '').trim().split(/\r?\n/).slice(-3).join(' ')}`, { needsInput: 'device' });
  const json = firstJson(r.stdout);
  if (!json) throw new CliError('maestro hierarchy printed no JSON; the installed version may use another format.');
  const dir = ensureDir(path.join(ctx.p.artifacts, 'hierarchy'));
  const file = path.join(dir, `${slug(name, 40)}-${stamp()}.json`);
  writeFileAtomic(file, `${JSON.stringify(json, null, 2)}\n`);
  const nodes = flatten(json);
  const seen = new Set();
  const candidates = [];
  for (const n of nodes) {
    if (!n.id && !n.text && !n.accessibilityText) continue;
    const key = `${n.id}|${n.text}|${n.accessibilityText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ id: n.id || null, text: n.text || null, label: n.accessibilityText || null, hint: n.hint || null, clickable: n.clickable, className: n.className || null });
  }
  const interactiveWithoutId = nodes.filter((n) => n.clickable && !n.id && (n.text || n.accessibilityText)).map((n) => n.text || n.accessibilityText);
  return {
    saved: toPosix(path.relative(ctx.root, file)), elements: nodes.length, withId: candidates.filter((c) => c.id).length,
    candidates: candidates.slice(0, limit), truncated: candidates.length > limit,
    interactiveWithoutId: [...new Set(interactiveWithoutId)].slice(0, 40),
    note: 'Prefer id. A clickable element without an id needs a Semantics identifier in the app: record it with "semantics add".',
  };
}

// ---------------------------------------------------------------- semantics requests

const HEADER = `# Flutter accessibility requests

Maestro finds elements through the accessibility tree. Each row asks the Flutter team to expose a stable identifier
(\`Semantics(identifier: '...')\`) so the flow can use an id instead of text, an index or coordinates.
Flows that wait for a request carry a \`# semantics-request: SEM-n\` comment and use a provisional selector until it is done.

| ID | Screen | Control | Suggested identifier | Why | Test case | Status | Requested |
|---|---|---|---|---|---|---|---|
`;

export function listSemantics(ctx) {
  const text = readText(ctx.p.semantics, '');
  return text.split(/\r?\n/).filter((l) => /^\|\s*SEM-\d+/.test(l)).map((l) => {
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    return { id: c[0], screen: c[1], control: c[2], suggestedId: c[3].replace(/^`|`$/g, ''), why: c[4], testCase: c[5], status: c[6], requested: c[7] };
  });
}

export function addSemantics(ctx, { screen, control, suggestedId, reason, testCase = '' }) {
  for (const [k, v] of Object.entries({ screen, control, suggestedId, reason })) if (!v) throw new CliError(`--${k === 'suggestedId' ? 'suggested-id' : k} is required.`);
  const existing = listSemantics(ctx);
  const dup = existing.find((e) => e.suggestedId === suggestedId && e.screen === screen);
  if (dup) return { added: false, id: dup.id, note: 'Already requested.' };
  const next = existing.reduce((m, e) => Math.max(m, Number(e.id.replace('SEM-', ''))), 0) + 1;
  const id = `SEM-${next}`;
  const clean = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const row = `| ${id} | ${clean(screen)} | ${clean(control)} | \`${clean(suggestedId)}\` | ${clean(reason)} | ${clean(testCase)} | open | ${nowIso().slice(0, 10)} |\n`;
  const current = readText(ctx.p.semantics, null);
  writeFileAtomic(ctx.p.semantics, (current ?? HEADER).replace(/\s*$/, '\n') + row);
  return { added: true, id, file: ctx.rel(ctx.p.semantics) };
}

export function saveIdentifierCatalog(ctx, scan) {
  writeJson(ctx.p.identifiers, { scannedAt: nowIso(), ...scan });
  return ctx.rel(ctx.p.identifiers);
}

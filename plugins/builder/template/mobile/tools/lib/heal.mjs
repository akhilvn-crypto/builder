// Bounded, audited repair of a generated flow's selectors.
//
// What may change: the id / text / label value of an existing selector, in a flow that still carries the
// "@builder:generated" header, to a value that is present in the real screen hierarchy captured as evidence.
// What may never change: the commands, their order, any other field (inputText values, optional, index, point …),
// the header, or the number of assertions. A repair that breaks a rule is reverted automatically. Every attempt is logged.
// Behaviour changes (a different screen or navigation) are not repaired here: the test case is reviewed first.

import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { analyzeFlow } from './flows.mjs';
import { loadTraceability } from './traceability.mjs';
import { CliError, ensureDir, nowIso, readJson, readText, slug, toPosix, writeJson } from './util.mjs';

export const MAX_ATTEMPTS_PER_FLOW = 2;
const SELECTOR_VALUE_KEYS = new Set(['id', 'text', 'label']);

const stateFile = (ctx, runId) => path.join(ctx.p.state, 'heal', slug(runId, 80), 'attempts.json');
const snapshotPath = (ctx, runId, flowRel, n) => path.join(ctx.p.state, 'heal', slug(runId, 80), `${slug(flowRel.replace(/\.ya?ml$/i, ''), 70)}.attempt${n}.orig.yaml`);

function resolveFlow(ctx, flowArg) {
  const abs = [path.resolve(ctx.fw, flowArg), path.resolve(ctx.root, flowArg)].find((c) => existsSync(c));
  if (!abs) throw new CliError(`Flow not found: ${flowArg}`);
  const rel = toPosix(path.relative(ctx.fw, abs));
  if (!rel.startsWith('flows/')) throw new CliError(`${flowArg} is not a flow under flows/.`);
  return { abs, rel };
}

/** Structural diff of two parsed flows → { changes: [{ path, from, to }], violations: [text] } */
export function diffFlows(a, b) {
  const changes = [];
  const violations = [];
  const walk = (x, y, where) => {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) { violations.push(`${where}: structure changed`); return; }
      if (x.length !== y.length) { violations.push(`${where}: ${x.length} entries became ${y.length}`); return; }
      x.forEach((v, i) => walk(v, y[i], `${where}[${i}]`));
      return;
    }
    if ((x && typeof x === 'object') !== (y && typeof y === 'object')) { violations.push(`${where}: structure changed`); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const kx = Object.keys(x);
      const ky = Object.keys(y);
      if (kx.join('\u0000') !== ky.join('\u0000')) { violations.push(`${where}: keys changed (${kx.join(',')} → ${ky.join(',')})`); return; }
      for (const k of kx) walk(x[k], y[k], `${where}.${k}`);
      return;
    }
    if (x === y) return;
    const key = where.split('.').pop();
    if (SELECTOR_VALUE_KEYS.has(key) && typeof x === 'string' && typeof y === 'string') changes.push({ path: where, from: x, to: y });
    else violations.push(`${where}: "${String(x)}" → "${String(y)}" is not a selector id/text/label change`);
  };
  walk(a, b, '$');
  return { changes, violations };
}

function flowDocument(ctx, abs) {
  const f = analyzeFlow(ctx, abs);
  return { f, doc: { header: f.header, commands: f.commands } };
}

export function healStart(ctx, runId, flowArg) {
  const { abs, rel } = resolveFlow(ctx, flowArg);
  const flow = analyzeFlow(ctx, abs);
  if (flow.yamlError) throw new CliError(`${rel} has a YAML error (${flow.yamlError.message}); fix that first, it is not a selector problem.`);
  if (!flow.generated) throw new CliError(`${rel} does not carry the ${'@builder:generated'} header, so it is yours and is never repaired automatically.`, { details: { ownership: 'user' } });
  const file = stateFile(ctx, runId);
  const attempts = readJson(file, {});
  const used = attempts[rel]?.length ?? 0;
  if (used >= MAX_ATTEMPTS_PER_FLOW) throw new CliError(`${rel} already used its ${MAX_ATTEMPTS_PER_FLOW} repair attempts in run ${runId}.`, { details: { attemptsLeft: 0 } });
  const n = used + 1;
  const snap = snapshotPath(ctx, runId, rel, n);
  ensureDir(path.dirname(snap));
  copyFileSync(abs, snap);
  attempts[rel] = [...(attempts[rel] ?? []), { attempt: n, startedAt: nowIso(), snapshot: toPosix(path.relative(ctx.fw, snap)), status: 'open' }];
  writeJson(file, attempts);
  return { flow: rel, attempt: n, attemptsLeft: MAX_ATTEMPTS_PER_FLOW - n, snapshot: toPosix(path.relative(ctx.fw, snap)) };
}

function revert(ctx, runId, rel, attempt) {
  const snap = snapshotPath(ctx, runId, rel, attempt);
  if (existsSync(snap)) copyFileSync(snap, path.join(ctx.fw, rel));
}

/** Check the edit made since healStart. On any violation the flow is restored from the snapshot. */
export function healCheck(ctx, runId, flowArg, { evidence, rationale }) {
  const { abs, rel } = resolveFlow(ctx, flowArg);
  const attempts = readJson(stateFile(ctx, runId), {});
  const open = attempts[rel]?.find((a) => a.status === 'open');
  if (!open) throw new CliError(`No repair attempt is open for ${rel} in run ${runId}. Run "heal start" first.`);
  const snap = snapshotPath(ctx, runId, rel, open.attempt);
  const before = flowDocument(ctx, snap);
  const after = flowDocument(ctx, abs);
  const violations = [];
  if (after.f.yamlError) violations.push(`the edited flow is no longer valid YAML (${after.f.yamlError.message})`);
  if (!after.f.generated) violations.push('the generated header was removed');
  if (!rationale || !rationale.trim()) violations.push('a rationale is required: what changed in the app and why this is the same control');
  let changes = [];
  if (!after.f.yamlError) {
    const d = diffFlows(before.doc, after.doc);
    changes = d.changes;
    violations.push(...d.violations);
    if (d.changes.length === 0 && d.violations.length === 0) violations.push('the flow was not changed');
  }
  const evidenceText = evidence ? readText(path.resolve(ctx.root, evidence), null) ?? readText(path.resolve(ctx.fw, evidence), null) : null;
  if (!evidenceText) violations.push('screen evidence is required: pass --evidence <hierarchy json captured with "inspect hierarchy">');
  else {
    for (const c of changes) {
      if (!c.to.includes('${') && !evidenceText.includes(c.to)) violations.push(`${c.path}: "${c.to}" does not appear in the captured screen hierarchy, so it is not proven to exist`);
    }
  }
  if (violations.length) {
    revert(ctx, runId, rel, open.attempt);
    open.status = 'reverted';
    open.violations = violations;
    writeJson(stateFile(ctx, runId), attempts);
    appendLog(ctx, { runId, flow: rel, attempt: open.attempt, outcome: 'reverted', violations, at: nowIso() });
    return { ok: false, reverted: true, violations };
  }
  open.status = 'checked';
  open.changes = changes;
  open.rationale = rationale;
  open.evidence = evidence;
  writeJson(stateFile(ctx, runId), attempts);
  return { ok: true, changes, next: 'Run the flow again, then "heal finish --result passed|failed".' };
}

function appendLog(ctx, entry) {
  const log = readJson(ctx.p.healLog, { schemaVersion: 1, entries: [] });
  log.entries.push(entry);
  writeJson(ctx.p.healLog, log);
}

/** Record the outcome of the re-run. A failed re-run restores the original flow. */
export function healFinish(ctx, runId, flowArg, { result, rerunId = null, note = null }) {
  if (!['passed', 'failed'].includes(result)) throw new CliError('--result must be passed or failed.');
  const { rel } = resolveFlow(ctx, flowArg);
  const attempts = readJson(stateFile(ctx, runId), {});
  const entry = attempts[rel]?.find((a) => a.status === 'checked');
  if (!entry) throw new CliError(`No checked repair is waiting for a result on ${rel}. Run "heal check" first.`);
  if (result === 'failed') revert(ctx, runId, rel, entry.attempt);
  entry.status = result === 'passed' ? 'healed' : 'reverted';
  entry.finishedAt = nowIso();
  writeJson(stateFile(ctx, runId), attempts);
  if (result === 'passed') {
    // the repaired flow is still pipeline-owned: keep its recorded hash current so it can be regenerated later
    const trace = loadTraceability(ctx);
    const caseEntry = Object.values(trace.cases).find((c) => c.flow === rel);
    if (caseEntry) { caseEntry.flowHash = analyzeFlow(ctx, path.join(ctx.fw, rel)).hash; writeJson(ctx.p.traceability, trace); }
  }
  appendLog(ctx, { runId, flow: rel, attempt: entry.attempt, outcome: entry.status, changes: entry.changes, rationale: entry.rationale, evidence: entry.evidence, rerunId, note, at: nowIso() });
  return { flow: rel, attempt: entry.attempt, outcome: entry.status, attemptsLeft: MAX_ATTEMPTS_PER_FLOW - (attempts[rel]?.length ?? 0) };
}

export function healStatus(ctx, runId) {
  const attempts = readJson(stateFile(ctx, runId), {});
  return { runId, flows: Object.entries(attempts).map(([flow, list]) => ({ flow, attempts: list.map((a) => ({ attempt: a.attempt, status: a.status, changes: a.changes ?? [], violations: a.violations ?? [] })), attemptsLeft: MAX_ATTEMPTS_PER_FLOW - list.length })) };
}

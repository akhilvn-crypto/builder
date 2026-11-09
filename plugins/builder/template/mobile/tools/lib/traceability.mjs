// Test case ↔ flow traceability and change detection.
//
// state/traceability.json records, per test case ID: where it came from (file, line, hash of its own text) and which flow
// was generated for it (path, hash of the flow when it was registered). Rerunning is safe because of two rules:
//   * a flow that carries the "@builder:generated" header and has not been edited since it was registered may be regenerated;
//   * anything else (edited by a person, header removed) is never overwritten: the plan says "review" and the user decides.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { analyzeFlow, listFlowFiles } from './flows.mjs';
import { CliError, nowIso, readJson, sha256, readText, toPosix, writeJson } from './util.mjs';

export function loadTraceability(ctx) {
  return readJson(ctx.p.traceability, null) ?? { schemaVersion: 1, cases: {} };
}

export const loadSpecs = (ctx) => readJson(ctx.p.specs, null);

export function saveSpecs(ctx, parsed) {
  const doc = {
    schemaVersion: 1,
    parsedAt: nowIso(),
    sources: parsed.sources,
    cases: parsed.cases,
  };
  writeJson(ctx.p.specs, doc);
  return doc;
}

/** Record that a flow now implements a test case (or that the case cannot be automated, with the reason). */
export function registerMapping(ctx, { testId, flow, status = 'mapped', reason = null }) {
  const specs = loadSpecs(ctx);
  const spec = specs?.cases?.find((c) => c.id === testId);
  if (!spec) throw new CliError(`Test case ${testId} is not in state/test-specs.json. Run "cases parse" first (the hash of its current text is recorded).`);
  if (!['mapped', 'blocked', 'manual'].includes(status)) throw new CliError('--status must be mapped, blocked or manual.');
  const trace = loadTraceability(ctx);
  const entry = {
    title: spec.title, module: spec.module, storyId: spec.storyId, priority: spec.priority, tags: spec.tags,
    source: spec.source, sourceHash: spec.hash, status, reason, flow: null, flowHash: null, generated: false, registeredAt: nowIso(),
  };
  if (status === 'mapped') {
    if (!flow) throw new CliError('--flow is required for a mapped test case.');
    const file = [path.resolve(ctx.fw, flow), path.resolve(ctx.root, flow)].find((c) => existsSync(c));
    if (!file) throw new CliError(`Flow not found: ${flow}`);
    const analysis = analyzeFlow(ctx, file);
    if (analysis.testCase && analysis.testCase !== testId) {
      throw new CliError(`${flow} says "# testCase: ${analysis.testCase}" but is being registered for ${testId}.`);
    }
    if (!analysis.testCase) throw new CliError(`${flow} has no "# testCase: ${testId}" header comment; add it so the link survives without the state file.`);
    entry.flow = toPosix(path.relative(ctx.fw, file));
    entry.flowHash = analysis.hash;
    entry.generated = analysis.generated;
  }
  trace.cases[testId] = entry;
  writeJson(ctx.p.traceability, trace);
  return { testId, ...entry };
}

/** What a (re)generation run has to do for each case, and why. Nothing is written. */
export function planGeneration(ctx, cases) {
  const trace = loadTraceability(ctx);
  const items = [];
  for (const c of cases) {
    const base = { id: c.id, title: c.title, module: c.module, priority: c.priority, source: `${c.source.file}:${c.source.line}` };
    const prev = trace.cases[c.id];
    if (c.automation === 'manual') { items.push({ ...base, state: 'manual', action: 'skip', reason: 'Tagged manual: needs a person.' }); continue; }
    if (c.status === 'needs_clarification') { items.push({ ...base, state: 'blocked', action: 'skip', reason: `Needs clarification: ${c.reasons.join('; ')}.` }); continue; }
    if (!prev || prev.status === 'blocked') {
      items.push({ ...base, state: prev ? 'blocked_before' : 'new', action: 'generate', reason: prev ? `Blocked earlier (${prev.reason ?? 'no reason recorded'}); try again.` : 'No flow yet.' });
      continue;
    }
    if (prev.status === 'manual') { items.push({ ...base, state: 'manual', action: 'skip', reason: prev.reason ?? 'Marked manual.' }); continue; }
    const flowAbs = prev.flow ? path.join(ctx.fw, prev.flow) : null;
    const exists = flowAbs && existsSync(flowAbs);
    const current = exists ? analyzeFlow(ctx, flowAbs) : null;
    const untouched = current && current.generated && current.hash === prev.flowHash;
    if (!exists) { items.push({ ...base, state: 'flow_missing', action: 'generate', flow: prev.flow, reason: 'The recorded flow file is gone.' }); continue; }
    if (prev.sourceHash !== c.hash) {
      items.push(untouched
        ? { ...base, state: 'source_changed', action: 'regenerate', flow: prev.flow, reason: 'The test case changed and the flow is still as generated.' }
        : { ...base, state: 'source_changed', action: 'review', flow: prev.flow, reason: 'The test case changed but the flow was edited by hand (or lost its generated header): compare them and update the flow yourself or remove the header to allow regeneration.' });
      continue;
    }
    items.push({ ...base, state: current.hash === prev.flowHash ? 'unchanged' : 'flow_edited', action: 'skip', flow: prev.flow,
      reason: current.hash === prev.flowHash ? 'Up to date.' : 'The test case is unchanged; the flow was edited since it was generated and is kept as is.' });
  }
  const ids = new Set(cases.map((c) => c.id));
  const removed = Object.entries(trace.cases)
    .filter(([id]) => !ids.has(id))
    .map(([id, e]) => ({ id, state: 'removed', action: 'review', flow: e.flow, reason: 'The test case is no longer in the sources. The flow is kept; delete it yourself if the test is retired.' }));
  const traced = new Set(Object.values(trace.cases).map((e) => e.flow).filter(Boolean));
  const unregistered = listFlowFiles(ctx).filter((f) => f.kind === 'test' && !traced.has(f.rel)).map((f) => {
    const a = analyzeFlow(ctx, f.abs);
    return { flow: f.rel, testCase: a.testCase, generated: a.generated };
  });
  const by = (key, v) => items.filter((i) => i[key] === v).length;
  return {
    total: cases.length,
    counts: {
      generate: by('action', 'generate'), regenerate: by('action', 'regenerate'), review: by('action', 'review') + removed.length,
      skip: by('action', 'skip'), unchanged: by('state', 'unchanged'), manual: by('state', 'manual'), blocked: by('state', 'blocked'),
      retryBlocked: by('state', 'blocked_before'),
    },
    items, removed, unregisteredFlows: unregistered,
  };
}

/** The test cases whose recorded source hash no longer matches, with the flows they affect. */
export function changesSince(ctx, cases) {
  const plan = planGeneration(ctx, cases);
  return {
    changed: plan.items.filter((i) => i.state === 'source_changed').map((i) => ({ id: i.id, flow: i.flow, action: i.action })),
    new: plan.items.filter((i) => i.state === 'new').map((i) => i.id),
    removed: plan.removed.map((r) => ({ id: r.id, flow: r.flow })),
  };
}

export function sourceTextHash(abs) {
  const t = readText(abs, null);
  return t === null ? null : sha256(t);
}

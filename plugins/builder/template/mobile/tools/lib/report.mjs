// Run reports, built only from what the run recorded on disk (run.json, results.json) and the traceability state:
//   reports/<runId>/summary.json  summary.md   always
//   reports/<runId>/report.html                reporting.formats includes "html"  (self-contained, evidence linked/embedded)
//   reports/<runId>/junit.xml                  reporting.formats includes "junit"
// Nothing is invented: a test case with no flow is listed as not automated with the recorded reason.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { CATEGORY_MEANING } from './classify.mjs';
import { loadSpecs, loadTraceability } from './traceability.mjs';
import { CliError, readJson, toPosix, writeFileAtomic, writeJson } from './util.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEsc = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function listRuns(ctx) {
  if (!existsSync(ctx.p.reports)) return [];
  return readdirSync(ctx.p.reports, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => {
      const run = readJson(path.join(ctx.p.reports, e.name, 'run.json'), null);
      return run ? { runId: e.name, startedAt: run.startedAt, platform: run.platform, outcome: run.outcome, status: run.status, counts: run.counts, scope: run.scope?.description } : null;
    }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function latestRunId(ctx) { return listRuns(ctx)[0]?.runId ?? null; }

/** Which test cases are automated, and how they did in this run. */
export function buildCoverage(ctx, results) {
  const specs = loadSpecs(ctx);
  const trace = loadTraceability(ctx);
  const byFlow = new Map(results.map((r) => [r.flow, r]));
  const ids = new Set([...(specs?.cases ?? []).map((c) => c.id), ...Object.keys(trace.cases)]);
  const rows = [];
  for (const id of [...ids].sort()) {
    const spec = specs?.cases?.find((c) => c.id === id);
    const t = trace.cases[id];
    const base = { id, title: spec?.title ?? t?.title ?? '', priority: spec?.priority ?? t?.priority ?? null };
    if (spec?.automation === 'manual' || t?.status === 'manual') { rows.push({ ...base, automated: false, reason: 'manual', detail: t?.reason ?? 'Tagged manual: needs a person.' }); continue; }
    if (spec?.status === 'needs_clarification') { rows.push({ ...base, automated: false, reason: 'needs_clarification', detail: spec.reasons.join('; ') }); continue; }
    if (!t) { rows.push({ ...base, automated: false, reason: 'no_flow', detail: 'No flow has been generated for this test case yet.' }); continue; }
    if (t.status === 'blocked') { rows.push({ ...base, automated: false, reason: 'blocked', detail: t.reason ?? 'Blocked.' }); continue; }
    const flowExists = t.flow && existsSync(path.join(ctx.fw, t.flow));
    if (!flowExists) { rows.push({ ...base, automated: false, reason: 'flow_missing', detail: `The recorded flow ${t.flow} no longer exists.` }); continue; }
    const r = byFlow.get(t.flow);
    rows.push({ ...base, automated: true, flow: t.flow, inRun: Boolean(r), result: r?.status ?? 'not_selected', category: r?.category ?? null });
  }
  const automated = rows.filter((r) => r.automated).length;
  const byReason = {};
  for (const r of rows.filter((x) => !x.automated)) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return { total: rows.length, automated, notAutomated: rows.length - automated, byReason, rows };
}

function relFromReport(ctx, runId, absOrRel) {
  return toPosix(path.relative(path.join(ctx.p.reports, runId), path.join(ctx.fw, absOrRel)));
}

function dataUri(file) {
  try {
    if (statSync(file).size > 1_500_000) return null;
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

function markdown(run, results, coverage, ctx) {
  const c = run.counts;
  const lines = [];
  lines.push(`# Mobile run ${run.runId}`, '');
  lines.push(`**Outcome: ${run.outcome.toUpperCase()}**  —  ${c.passed} passed, ${c.failed} failed, ${c.notRun} not run, ${c.skipped} skipped (of ${c.total})`, '');
  if (!run.device?.physical) {
    lines.push(`> This run used ${run.device?.kind ?? 'a non-physical target'}. It does **not** count as physical-device validation.`, '');
  }
  lines.push('| | |', '|---|---|');
  lines.push(`| Platform | ${run.platform}${run.device?.osVersion ? ` (OS ${run.device.osVersion})` : ''} |`);
  lines.push(`| Device | ${[run.device?.manufacturer, run.device?.model].filter(Boolean).join(' ') || run.device?.id} — id \`${run.device?.id}\`, ${run.device?.kind}, ${run.device?.transport} |`);
  lines.push(`| App | \`${run.app?.id}\`${run.app?.versionName ? ` ${run.app.versionName}` : ''}${run.app?.versionCode ? ` (build ${run.app.versionCode})` : ''} |`);
  lines.push(`| Environment | ${run.environment} |`);
  lines.push(`| Scope | ${run.scope?.description} |`);
  lines.push(`| Maestro | ${run.maestro?.version ?? 'unknown'} |`);
  lines.push(`| Started | ${run.startedAt} (${fmtMs(run.durationMs)}) |`, '');
  lines.push('## Flows', '', '| Flow | Test case | Result | Category | Time |', '|---|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.flow} | ${r.testCase ?? ''} | ${r.status} | ${r.category ?? ''}${r.needsConfirmation ? ' (confirm)' : ''} | ${fmtMs(r.durationMs)} |`);
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    lines.push('', '## Failures', '');
    for (const r of failed) {
      lines.push(`### ${r.flow}${r.testCase ? ` (${r.testCase})` : ''}`, '', `- Category: **${r.category}** (${r.confidence} confidence${r.needsConfirmation ? ', needs confirmation' : ''}) — ${r.reason}`);
      if (r.failedCommand?.description) lines.push(`- Failed command: ${r.failedCommand.description}`);
      if (r.hint) lines.push(`- Next: ${r.hint}`);
      lines.push(`- Evidence: ${r.artifacts.map((a) => `\`${a}\``).join(', ') || 'none captured'}`, '');
    }
  }
  lines.push('', '## Test case coverage', '', `${coverage.automated} of ${coverage.total} test cases have a flow.`, '');
  if (coverage.notAutomated) {
    lines.push('| Test case | Why not automated |', '|---|---|');
    for (const r of coverage.rows.filter((x) => !x.automated)) lines.push(`| ${r.id} ${r.title} | ${r.reason}: ${r.detail} |`);
  }
  lines.push('', `Evidence: ${ctx.rel(path.join(ctx.p.artifacts, run.runId))}/`, '');
  return lines.join('\n');
}

function html(run, results, coverage, ctx) {
  const c = run.counts;
  const badge = (s) => `<span class="b b-${String(s).replace(/\s+/g, '_').replace(/[^\w-]/g, '')}">${esc(s)}</span>`;
  const rows = results.map((r) => {
    const shot = r.status === 'failed' ? r.artifacts.find((a) => /\.png$/i.test(a)) : null;
    const uri = shot ? dataUri(path.join(ctx.fw, shot)) : null;
    const links = r.artifacts.map((a) => `<a href="${esc(relFromReport(ctx, run.runId, a))}">${esc(path.basename(a))}</a>`).join(' · ');
    return `<tr><td><b>${esc(r.name || r.flow)}</b><div class="s">${esc(r.flow)}${r.testCase ? ` · ${esc(r.testCase)}` : ''}</div></td><td>${badge(r.status)}</td>
<td>${r.category ? `${esc(r.category)}${r.needsConfirmation ? ' <i>(confirm)</i>' : ''}` : ''}</td><td>${esc(fmtMs(r.durationMs))}</td></tr>
${r.status === 'failed' ? `<tr class="d"><td colspan="4"><p>${esc(r.reason)}</p>${r.failedCommand?.description ? `<p><b>Failed command:</b> ${esc(r.failedCommand.description)}</p>` : ''}${r.hint ? `<p><b>Next:</b> ${esc(r.hint)}</p>` : ''}<pre>${esc(r.excerpt || '')}</pre>${uri ? `<img alt="failure screenshot" src="${uri}">` : ''}<p class="s">${links}</p></td></tr>` : (links ? `<tr class="d"><td colspan="4" class="s">${links}</td></tr>` : '')}`;
  }).join('\n');
  const cov = coverage.rows.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${r.automated ? badge(r.result === 'not_selected' ? 'not run' : r.result) : badge('not automated')}</td><td>${esc(r.automated ? r.flow : `${r.reason}: ${r.detail}`)}</td></tr>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mobile run ${esc(run.runId)}</title>
<style>
:root{--bg:#fff;--fg:#1c2330;--mut:#5b6678;--line:#dde2ea;--ok:#1a7f4b;--bad:#c0392b;--warn:#b7791f;--card:#f6f8fb}
@media (prefers-color-scheme:dark){:root{--bg:#12161d;--fg:#e6eaf0;--mut:#9aa6b8;--line:#2a3140;--card:#1a202b;--ok:#4cc38a;--bad:#ff7b6b;--warn:#e0b04c}}
body{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}.s{color:var(--mut);font-size:12px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
.b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line)}
.b-passed{color:var(--ok);border-color:var(--ok)}.b-failed{color:var(--bad);border-color:var(--bad)}.b-skipped,.b-not_run,.b-not_automated{color:var(--warn);border-color:var(--warn)}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px}.card b{font-size:22px;display:block}
.banner{background:var(--card);border-left:4px solid var(--warn);padding:10px 14px;margin:12px 0}
pre{background:var(--card);padding:8px;overflow:auto;max-height:220px;font-size:12px}img{max-width:320px;border:1px solid var(--line)}tr.d td{background:var(--card)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px}dt{color:var(--mut)}dd{margin:0}
</style></head><body>
<h1>Mobile run ${esc(run.runId)} — ${esc(run.outcome.toUpperCase())}</h1>
<div class="cards"><div class="card"><b>${c.passed}</b>passed</div><div class="card"><b>${c.failed}</b>failed</div><div class="card"><b>${c.notRun}</b>not run</div><div class="card"><b>${c.skipped}</b>skipped</div><div class="card"><b>${c.total}</b>total</div></div>
${run.device?.physical ? '' : `<div class="banner">This run used ${esc(run.device?.kind ?? 'a non-physical target')}. It does not count as physical-device validation.</div>`}
<dl><dt>Platform</dt><dd>${esc(run.platform)}${run.device?.osVersion ? ` · OS ${esc(run.device.osVersion)}` : ''}</dd>
<dt>Device</dt><dd>${esc([run.device?.manufacturer, run.device?.model].filter(Boolean).join(' '))} · <code>${esc(run.device?.id)}</code> · ${esc(run.device?.kind)} · ${esc(run.device?.transport)}</dd>
<dt>App</dt><dd><code>${esc(run.app?.id)}</code> ${esc(run.app?.versionName ?? '')} ${run.app?.versionCode ? `(build ${esc(run.app.versionCode)})` : ''}</dd>
<dt>Environment</dt><dd>${esc(run.environment)}</dd><dt>Scope</dt><dd>${esc(run.scope?.description)}</dd>
<dt>Maestro</dt><dd>${esc(run.maestro?.version ?? 'unknown')}</dd><dt>Started</dt><dd>${esc(run.startedAt)} · ${esc(fmtMs(run.durationMs))}</dd></dl>
<h2>Flows</h2><table><thead><tr><th>Flow</th><th>Result</th><th>Category</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Failure categories</h2><ul>${Object.entries(CATEGORY_MEANING).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join('')}</ul>
<h2>Test case coverage — ${coverage.automated} of ${coverage.total} have a flow</h2>
<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Flow / reason</th></tr></thead><tbody>${cov}</tbody></table>
</body></html>`;
}

function junit(run, results) {
  const failures = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'not_run').length;
  const total = results.reduce((s, r) => s + (r.durationMs ?? 0), 0) / 1000;
  const cases = results.map((r) => {
    const open = `<testcase classname="${xmlEsc(path.posix.dirname(r.flow))}" name="${xmlEsc(r.name || r.flow)}" time="${((r.durationMs ?? 0) / 1000).toFixed(3)}">`;
    if (r.status === 'failed') return `${open}<failure type="${xmlEsc(r.category)}" message="${xmlEsc(r.reason)}">${xmlEsc(r.excerpt)}</failure></testcase>`;
    if (r.status === 'skipped' || r.status === 'not_run') return `${open}<skipped message="${xmlEsc(r.reason ?? r.status)}"/></testcase>`;
    return `${open}</testcase>`;
  }).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="mobile-${xmlEsc(run.platform)}-${xmlEsc(run.environment)}" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${total.toFixed(3)}" timestamp="${xmlEsc(run.startedAt)}">
  <properties><property name="runId" value="${xmlEsc(run.runId)}"/><property name="device" value="${xmlEsc(run.device?.id)}"/><property name="physicalDevice" value="${run.device?.physical ? 'true' : 'false'}"/><property name="maestro" value="${xmlEsc(run.maestro?.version)}"/></properties>
  ${cases}
</testsuite>
</testsuites>
`;
}

export function buildReports(ctx, cfg, runId) {
  const dir = path.join(ctx.p.reports, runId);
  const run = readJson(path.join(dir, 'run.json'), null);
  const results = readJson(path.join(dir, 'results.json'), null);
  if (!run || !results) throw new CliError(`Run ${runId} has no run.json/results.json in ${ctx.rel(dir)}.`);
  const coverage = buildCoverage(ctx, results);
  const formats = cfg?.reporting?.formats ?? ['html', 'junit'];
  const written = [];
  writeJson(path.join(dir, 'summary.json'), {
    run, counts: run.counts, results: results.map(({ excerpt, ...r }) => r),
    coverage: { total: coverage.total, automated: coverage.automated, notAutomated: coverage.notAutomated, byReason: coverage.byReason },
  });
  written.push('summary.json');
  writeFileAtomic(path.join(dir, 'summary.md'), markdown(run, results, coverage, ctx));
  written.push('summary.md');
  writeJson(path.join(dir, 'coverage.json'), coverage);
  written.push('coverage.json');
  if (formats.includes('html')) { writeFileAtomic(path.join(dir, 'report.html'), html(run, results, coverage, ctx)); written.push('report.html'); }
  if (formats.includes('junit')) { writeFileAtomic(path.join(dir, 'junit.xml'), junit(run, results)); written.push('junit.xml'); }
  return {
    runId, dir: ctx.rel(dir), written, formats, outcome: run.outcome, counts: run.counts,
    coverage: { total: coverage.total, automated: coverage.automated, notAutomated: coverage.notAutomated, byReason: coverage.byReason },
    html: formats.includes('html') ? ctx.rel(path.join(dir, 'report.html')) : null,
    junit: formats.includes('junit') ? ctx.rel(path.join(dir, 'junit.xml')) : null,
  };
}

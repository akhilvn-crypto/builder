// The "extent" report: one self-contained HTML file in the style of an Extent Reports dashboard — run summary, pass/fail chart,
// per-module and failure-category breakdowns, and a filterable list of tests with their steps, errors and screenshots.
//
//   reports/<run-id>/extent-report/index.html
//
// This is the pipeline's own report, not the ExtentReports library: that library is Java/.NET and no maintained Playwright (Node)
// integration was found, so nothing is installed. The page is built after the run from the normalized execution results, like the
// evidence PDF, and reuses its model (step log when the shared fixture recorded one, Playwright's own screenshot otherwise). It has no
// external requests: CSS, the small script (tabs, filter, search, theme) and the screenshots are all inside the file. Videos are
// linked by relative path (Playwright's recordings stay in test-results/), never embedded.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toPosixRelative } from '../utils/fs.ts';
import { formatIst } from '../utils/time.ts';
import { REPORTS_DIR, assertRunId } from './artifact-manager.ts';
import {
  buildEvidenceModel, embedImage, escapeHtml as e,
  type AttemptView, type EvidenceInputs, type EvidenceModel, type ImageSource, type TestView, type VideoView,
} from './evidence-report.ts';
import type { ReporterStatus } from './reporting.ts';

export const EXTENT_REPORT_DIR = 'extent-report';
export const EXTENT_HTML = 'index.html';
// Screenshots above this size are linked by name instead of embedded, so one huge image cannot make the report unusable.
export const MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024;

export function extentReportDir(rootDir: string, runId: string): string {
  assertRunId(runId);
  return path.join(rootDir, REPORTS_DIR, runId, EXTENT_REPORT_DIR);
}

const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const stamp = formatIst;
const bytesLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const OUTCOMES = ['passed', 'failed', 'flaky', 'healed', 'blocked', 'skipped'] as const;
const LABEL: Record<string, string> = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', healed: 'Healed', blocked: 'Blocked', skipped: 'Skipped' };

const CSS = `
:root { --bg:#f3f5f8; --card:#fff; --ink:#1d2733; --muted:#5d6b7b; --line:#dbe1e8; --soft:#eef1f5; --accent:#2a6fdb;
  --passed:#1e8a46; --failed:#c62f26; --flaky:#b26a00; --healed:#2a6fdb; --blocked:#6b7787; --skipped:#6b7787; --errbg:#fdf0ef; --errline:#f0c9c5; --errink:#7a1b15; }
:root[data-theme="dark"] { --bg:#14181e; --card:#1d242d; --ink:#e6ebf1; --muted:#9aa7b6; --line:#2d3743; --soft:#242d38; --accent:#6ea3ff;
  --passed:#4cc47a; --failed:#ff7b72; --flaky:#e0a44a; --healed:#6ea3ff; --blocked:#9aa7b6; --skipped:#9aa7b6; --errbg:#2c1b1b; --errline:#5b2c2a; --errink:#ffb4ae; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); }
.mono { font-family: Consolas, "Courier New", monospace; } .muted { color: var(--muted); }
header.top { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
header.top h1 { font-size: 16px; margin: 0; flex: 1 1 220px; } header.top h1 small { font-weight: 400; color: var(--muted); }
.tabs { display: flex; gap: 4px; } .tabs button, .tool { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.tabs button[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; } .view[hidden] { display: none; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card b { display: block; font-size: 24px; line-height: 1.2; } .card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
.panel h2 { font-size: 14px; margin: 0 0 10px; }
.row2 { display: grid; grid-template-columns: minmax(0, 280px) minmax(0, 1fr); gap: 14px; } @media (max-width: 720px) { .row2 { grid-template-columns: minmax(0, 1fr); } } .panel { overflow-x: auto; }
.donut { display: block; margin: 0 auto; max-width: 220px; width: 100%; height: auto; } .legend { list-style: none; margin: 10px 0 0; padding: 0; }
.legend li { display: flex; align-items: center; gap: 8px; } .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; } .legend .n { margin-left: auto; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--soft); font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.badge { display: inline-block; border-radius: 4px; padding: 0 7px; font-size: 11px; font-weight: 700; letter-spacing: .03em; color: #fff; background: var(--blocked); white-space: nowrap; }
.badge.passed { background: var(--passed); } .badge.failed { background: var(--failed); } .badge.flaky { background: var(--flaky); } .badge.healed { background: var(--healed); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.toolbar input[type=search] { font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; min-width: 200px; flex: 1 1 200px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; } .chip { font: inherit; font-size: 12px; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 3px 11px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
details.test { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--blocked); border-radius: 8px; margin-bottom: 8px; }
details.test[data-status="passed"] { border-left-color: var(--passed); } details.test[data-status="failed"] { border-left-color: var(--failed); }
details.test[data-status="flaky"] { border-left-color: var(--flaky); } details.test[data-status="healed"] { border-left-color: var(--healed); }
details.test > summary { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 9px 12px; cursor: pointer; }
details.test > summary .title { flex: 1 1 260px; } .test-body { padding: 4px 14px 14px; border-top: 1px solid var(--line); }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 10px 0; } dl.meta dt { color: var(--muted); } dl.meta dd { margin: 0; word-break: break-word; }
.box { background: var(--soft); border-radius: 6px; padding: 8px 12px; margin: 8px 0; } .box ul, .box ol { margin: 4px 0 0 18px; padding: 0; }
.attempt { margin-top: 12px; } .attempt > h3 { font-size: 13px; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
table.steps td.s { width: 84px; } table.steps tr.failed td { background: var(--errbg); }
pre.err { white-space: pre-wrap; word-break: break-word; background: var(--errbg); border: 1px solid var(--errline); color: var(--errink); border-radius: 6px; padding: 8px; margin: 6px 0 0; font-size: 12px; }
figure { margin: 8px 0 0; } figure img { display: block; max-width: 100%; max-height: 320px; border: 1px solid var(--line); border-radius: 4px; cursor: zoom-in; } figure img.zoom { max-height: none; cursor: zoom-out; }
figcaption, .note { color: var(--muted); font-size: 12px; margin-top: 3px; }
.empty { padding: 24px; text-align: center; color: var(--muted); } [hidden] { display: none !important; }
`;

// Inline script: tabs, status filter, search, expand/collapse, theme, screenshot zoom. Reads only the page's own data attributes.
const SCRIPT = `
(function () {
  var root = document.documentElement;
  try { var saved = localStorage.getItem('extent-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (x) {}
  var one = function (s) { return document.querySelector(s); };
  var $ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  function show(name) {
    $('.view').forEach(function (v) { v.hidden = v.id !== name; });
    $('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.view === name)); });
  }
  $('.tabs button').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.view); }); });
  var status = 'all', query = '';
  function apply() {
    var shown = 0;
    $('details.test').forEach(function (d) {
      var ok = (status === 'all' || d.dataset.status === status) && (!query || d.dataset.search.indexOf(query) !== -1);
      d.hidden = !ok; if (ok) shown++;
    });
    one('#none').hidden = shown !== 0;
    one('#count').textContent = shown + ' shown';
  }
  $('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      status = c.dataset.status;
      $('.chip').forEach(function (o) { o.setAttribute('aria-pressed', String(o === c)); });
      apply();
    });
  });
  one('#q').addEventListener('input', function (ev) { query = ev.target.value.trim().toLowerCase(); apply(); });
  one('#expand').addEventListener('click', function () { $('details.test').forEach(function (d) { if (!d.hidden) d.open = true; }); });
  one('#collapse').addEventListener('click', function () { $('details.test').forEach(function (d) { d.open = false; }); });
  one('#theme').addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('extent-theme', next); } catch (x) {}
  });
  $('figure img').forEach(function (i) { i.addEventListener('click', function () { i.classList.toggle('zoom'); }); });
  $('a[data-goto]').forEach(function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault(); show('tests');
      var d = document.getElementById(a.dataset.goto); if (d) { d.hidden = false; d.open = true; d.scrollIntoView(); }
    });
  });
  show('dashboard'); apply();
})();
`;

// A screenshot as an <img>, or a note when it cannot be embedded.
function figure(src: ImageSource, file: string | null, caption: string, missing: string): string {
  if (!file) return `<div class="note">${e(missing)}</div>`;
  let url: string | null = null;
  try {
    url = statSync(file).size > MAX_EMBEDDED_IMAGE_BYTES ? null : src(file);
  } catch {
    url = null;
  }
  return url
    ? `<figure><img src="${url}" alt="${e(caption)}"><figcaption>${e(caption)} — click to enlarge</figcaption></figure>`
    : `<div class="note">${e(caption)} could not be embedded (missing or larger than ${bytesLabel(MAX_EMBEDDED_IMAGE_BYTES)}).</div>`;
}

function stepsTable(a: AttemptView): string {
  const rows = a.steps.map((s) => {
    const pad = Math.min(s.depth, 4) * 16;
    return `<tr class="${s.status}"><td class="num">${s.index}</td><td style="padding-left:${8 + pad}px">${e(s.title)}${s.error ? `<pre class="err">${e(s.error)}</pre>` : ''}</td>`
      + `<td class="s"><span class="badge ${s.status}">${s.status === 'passed' ? 'PASSED' : 'FAILED'}</span></td><td class="num">${e(seconds(s.durationMs))}</td></tr>`;
  }).join('');
  return `<table class="steps"><thead><tr><th>#</th><th>Executed step</th><th>Result</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function attemptBlock(a: AttemptView, src: ImageSource, videoHref: (v: VideoView) => string): string {
  const out = [`<div class="attempt"><h3>${e(a.label)} — <span class="badge ${a.status === 'passed' ? 'passed' : 'failed'}">${e(a.status.toUpperCase())}</span> <span class="muted">· ${e(seconds(a.durationMs))}</span></h3>`];
  if (a.steps.length) out.push(stepsTable(a));
  const shown = a.steps.map((s) => s.error).filter((x): x is string => !!x);
  const bare = (s: string) => s.replace(/^Error:\s*/, '');
  const same = (x: string, y: string) => bare(x).startsWith(bare(y).slice(0, 120)) || bare(y).startsWith(bare(x).slice(0, 120));
  const unshown = a.errors.filter((m) => !shown.some((s) => same(s, m)));
  if (unshown.length) out.push(`<pre class="err">${unshown.map(e).join('\n\n')}</pre>`);
  if (a.final) out.push(figure(src, a.final.image, a.hasStepLog ? 'Final state of the page' : 'Screenshot recorded by Playwright', a.final.note ?? 'No screenshot was recorded'));
  else out.push('<div class="note">No screenshot was recorded for this attempt.</div>');
  for (const v of a.videos) out.push(`<div class="note">Video: <a href="${e(videoHref(v))}">${e(v.source)}</a> (${e(bytesLabel(v.bytes))}, opens in a browser or media player; stays in the test-results folder)</div>`);
  out.push('</div>');
  return out.join('\n');
}

function testBlock(t: TestView, src: ImageSource, videoHref: (v: VideoView) => string): string {
  const last = t.attempts.at(-1);
  const meta: [string, string][] = [];
  if (t.module) meta.push(['Module', t.module]);
  meta.push(['Browser project', t.project]);
  if (t.priority) meta.push(['Priority', t.priority]);
  if (t.tags.length) meta.push(['Tags', t.tags.join(', ')]);
  if (t.file) meta.push(['Test file', t.file]);
  if (t.category) meta.push(['Failure category', t.category]);
  const search = [t.testId, t.title, t.module ?? '', t.project, t.category ?? '', t.tags.join(' ')].join(' ').toLowerCase();
  return `<details class="test" id="${e(t.anchor)}" data-status="${e(t.outcome)}" data-search="${e(search)}">`
    + `<summary><span class="badge ${t.outcome}">${e((LABEL[t.outcome] ?? t.outcome).toUpperCase())}</span><span class="title"><span class="mono">[${e(t.testId)}]</span> ${e(t.title)}</span>`
    + `<span class="muted">${e(t.module ?? '')}${t.module ? ' · ' : ''}${e(t.project)}${last ? ` · ${e(seconds(last.durationMs))}` : ''}</span></summary>`
    + `<div class="test-body">${t.note ? `<div class="note">${e(t.note)}</div>` : ''}`
    + `<dl class="meta">${meta.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>`
    + (t.preconditions.length ? `<div class="box"><b>Preconditions</b><ul>${t.preconditions.map((p) => `<li>${e(p)}</li>`).join('')}</ul></div>` : '')
    + (t.plannedSteps.length ? `<div class="box"><b>Steps in the test case</b><ol>${t.plannedSteps.map((s) => `<li>${e(s.action)}${s.expected ? ` <span class="muted">→ ${e(s.expected)}</span>` : ''}</li>`).join('')}</ol></div>` : '')
    + (t.attempts.length ? t.attempts.map((a) => attemptBlock(a, src, videoHref)).join('\n') : '<div class="box">This test was not executed, so there is no execution data.</div>')
    + (t.expectedResults.length ? `<div class="box"><b>Expected result${t.expectedResults.length > 1 ? 's' : ''}</b><ul>${t.expectedResults.map((x) => `<li>${e(x)}</li>`).join('')}</ul></div>` : '')
    + `</div></details>`;
}

// Ring chart as inline SVG: one arc per outcome, sized by its share of the tests.
function donut(counts: Record<string, number>, total: number): string {
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = total === 0 ? '' : OUTCOMES.filter((o) => counts[o]! > 0).map((o) => {
    const len = (counts[o]! / total) * c;
    const arc = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--${o})" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 70 70)"><title>${LABEL[o]}: ${counts[o]}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  const rate = total === 0 ? '–' : `${Math.round((counts.passed! / total) * 100)}%`;
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Test outcomes"><circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--soft)" stroke-width="18"/>${arcs}`
    + `<text x="70" y="68" text-anchor="middle" font-size="22" font-weight="700" fill="var(--ink)">${rate}</text><text x="70" y="86" text-anchor="middle" font-size="10" fill="var(--muted)">passed</text></svg>`;
}

export interface ExtentPage {
  html: string;
  totals: { tests: number; steps: number; screenshots: number };
}

export function renderExtentHtml(m: EvidenceModel, opts: { src?: ImageSource; videoHref?: (v: VideoView) => string } = {}): string {
  return renderExtentPage(m, opts).html;
}

export function renderExtentPage(m: EvidenceModel, opts: { src?: ImageSource; videoHref?: (v: VideoView) => string } = {}): ExtentPage {
  const src = opts.src ?? embedImage;
  const videoHref = opts.videoHref ?? ((v: VideoView) => v.href.split('#')[0]!);
  const counts: Record<string, number> = Object.fromEntries(OUTCOMES.map((o) => [o, m.tests.filter((t) => t.outcome === o).length]));
  const total = m.tests.length;
  const timeMs = m.tests.reduce((n, t) => n + t.attempts.reduce((k, a) => k + a.durationMs, 0), 0);

  const modules = new Map<string, Record<string, number>>();
  for (const t of m.tests) {
    const key = t.module ?? '(no module)';
    const row = modules.get(key) ?? Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    row[t.outcome] = (row[t.outcome] ?? 0) + 1;
    modules.set(key, row);
  }
  const categories = new Map<string, number>();
  for (const t of m.tests) if (t.category) categories.set(t.category, (categories.get(t.category) ?? 0) + 1);
  const attention = m.tests.filter((t) => t.outcome !== 'passed');

  const card = (label: string, value: string, cls = '') => `<div class="card"><b${cls ? ` style="color:var(--${cls})"` : ''}>${e(value)}</b><span>${e(label)}</span></div>`;
  const legend = OUTCOMES.map((o) => `<li><span class="dot" style="background:var(--${o})"></span>${LABEL[o]}<span class="n">${counts[o]}</span></li>`).join('');
  const moduleRows = [...modules.entries()].map(([name, r]) => `<tr><td>${e(name)}</td><td class="num">${OUTCOMES.reduce((n, o) => n + r[o]!, 0)}</td>`
    + OUTCOMES.slice(0, 4).map((o) => `<td class="num">${r[o]}</td>`).join('') + `<td class="num">${r.blocked! + r.skipped!}</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report ${e(m.runId)}</title><style>${CSS}</style></head>
<body>
<header class="top"><h1>Test report <small class="mono">${e(m.runId)}</small></h1>
<div class="tabs" role="tablist"><button data-view="dashboard" role="tab">Dashboard</button><button data-view="tests" role="tab">Tests (${total})</button><button data-view="environment" role="tab">Environment</button></div>
<button class="tool" id="theme" type="button">Light / dark</button></header>
<main>
<section class="view" id="dashboard">
<div class="cards">${card('Tests', String(total))}${card('Passed', String(counts.passed), 'passed')}${card('Failed', String(counts.failed), 'failed')}${card('Flaky', String(counts.flaky), 'flaky')}${card('Healed', String(counts.healed), 'healed')}${card('Blocked / skipped', String(counts.blocked! + counts.skipped!))}${card('Time in tests', seconds(timeMs))}</div>
<div class="row2"><div class="panel"><h2>Outcomes</h2>${donut(counts, total)}<ul class="legend">${legend}</ul></div>
<div class="panel"><h2>By module</h2>${modules.size ? `<table><thead><tr><th>Module</th><th>Tests</th><th>Passed</th><th>Failed</th><th>Flaky</th><th>Healed</th><th>Not run</th></tr></thead><tbody>${moduleRows}</tbody></table>` : '<div class="empty">No tests.</div>'}
<p class="note">Flaky tests passed only after a retry and are not counted as passed.</p></div></div>
${categories.size ? `<div class="panel"><h2>Failure categories</h2><table><tbody>${[...categories.entries()].map(([k, v]) => `<tr><td>${e(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table></div>` : ''}
<div class="panel"><h2>Needs attention (${attention.length})</h2>${attention.length
    ? `<table><thead><tr><th>Test</th><th>Result</th><th>Note</th></tr></thead><tbody>${attention.map((t) => `<tr><td><a href="#${e(t.anchor)}" data-goto="${e(t.anchor)}"><span class="mono">[${e(t.testId)}]</span> ${e(t.title)}</a></td><td><span class="badge ${t.outcome}">${e((LABEL[t.outcome] ?? t.outcome).toUpperCase())}</span></td><td>${e(t.note ?? t.category ?? '')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Every test passed.</div>'}</div>
</section>
<section class="view" id="tests" hidden>
<div class="toolbar"><input id="q" type="search" placeholder="Search id, title, module, tag" aria-label="Search tests">
<div class="chips"><button class="chip" type="button" data-status="all" aria-pressed="true">All</button>${OUTCOMES.filter((o) => counts[o]! > 0).map((o) => `<button class="chip" type="button" data-status="${o}" aria-pressed="false">${LABEL[o]} (${counts[o]})</button>`).join('')}</div>
<button class="tool" id="expand" type="button">Expand</button><button class="tool" id="collapse" type="button">Collapse</button><span class="muted" id="count"></span></div>
${m.tests.map((t) => testBlock(t, src, videoHref)).join('\n')}
<div class="empty" id="none" hidden>No test matches.</div>
</section>
<section class="view" id="environment" hidden><div class="panel"><h2>Run</h2><dl class="meta">
<dt>Run</dt><dd class="mono">${e(m.runId)} · /${e(m.command)}</dd><dt>Generated</dt><dd>${e(stamp(m.generatedAt))}</dd>
<dt>Environment</dt><dd>${e(m.environment)}</dd><dt>Base URL</dt><dd>${e(m.baseUrl)}</dd><dt>Browsers</dt><dd>${e(m.browsers.join(', '))}</dd>
<dt>Contents</dt><dd>${m.totals.tests} test(s), ${m.totals.steps} recorded step(s), ${m.totals.screenshots} screenshot(s)</dd></dl>
<p class="note">Screenshots show the page exactly as rendered, so data typed into visible fields appears in them. Times are IST.</p></div></section>
</main>
<script>${SCRIPT}</script>
</body></html>
`;
  return { html, totals: { tests: total, steps: m.totals.steps, screenshots: m.totals.screenshots } };
}

// Writes the report and checks the file. Never throws: a failure is reported as a status.
export function buildExtentReport(i: EvidenceInputs, src: ImageSource = embedImage): ReporterStatus {
  const name = 'extent' as const;
  try {
    const dir = extentReportDir(i.rootDir, i.manifest.runId);
    const file = path.join(dir, EXTENT_HTML);
    mkdirSync(dir, { recursive: true });
    const model = buildEvidenceModel(i);
    const page = renderExtentPage(model, { src, videoHref: (v) => path.relative(dir, v.file).split(path.sep).map(encodeURIComponent).join('/') });
    writeFileSync(file, page.html, 'utf8');
    const size = statSync(file).size;
    if (size === 0) return { name, status: 'failed', path: null, detail: 'the Extent report file is empty' };
    return {
      name, status: 'generated', path: toPosixRelative(i.rootDir, file),
      detail: `${page.totals.tests} tests, ${page.totals.steps} recorded steps, ${page.totals.screenshots} screenshots, ${bytesLabel(size)}`,
    };
  } catch (err) {
    return { name, status: 'failed', path: null, detail: `Extent report failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

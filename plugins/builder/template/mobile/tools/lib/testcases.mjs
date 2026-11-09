// Reading the test cases a flow is generated from. Two inputs, no guessing:
//   * Markdown in the Builder's canonical test-case format (what test design writes to test-design/test-cases/*.md)
//   * CSV with recognisable headers (id, title, steps, expected result, ...)
// Excel and other formats are not read here: export to CSV, or import them with the Playwright side's `input import`.
// Every case keeps its source file/line and a hash of its own text, so a later change is detected per case.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { flowVariableFor } from './config.mjs';
import { CliError, readText, sha256, toPosix, walkFiles } from './util.mjs';

const SECTION = { preconditions: 'preconditions', 'test data': 'data', steps: 'steps', 'expected results': 'expected' };
const SECRET_NAME = /(pass(word)?|pwd|secret|token|otp|pin|cvv|api[_-]?key)/i;

function parseDataValue(raw) {
  const v = raw.trim();
  if (/^env:/i.test(v)) { const name = v.slice(4).trim(); return { kind: 'env', env: name, flowVariable: flowVariableFor(name) }; }
  if (/^literal:/i.test(v)) return { kind: 'literal', value: v.slice(8) };
  return { kind: 'plain', value: v };
}

function finishCase(c, blockLines) {
  c.hash = sha256(blockLines.map((l) => l.replace(/\s+$/, '')).join('\n').trim());
  const inlineExpected = c.steps.filter((s) => s.expected).length;
  const reasons = [];
  if (c.steps.length === 0) reasons.push('no steps');
  if (c.expected.length === 0 && inlineExpected === 0) reasons.push('no expected results');
  const secretInPlain = c.data.filter((d) => d.kind === 'plain' && SECRET_NAME.test(d.name));
  if (secretInPlain.length) reasons.push(`test data ${secretInPlain.map((d) => d.name).join(', ')} looks like a secret but is not an env: reference`);
  c.status = reasons.length ? 'needs_clarification' : 'valid';
  c.reasons = reasons;
  c.automation = c.tags.map((t) => t.toLowerCase()).includes('manual') ? 'manual' : 'automatable';
  return c;
}

export function parseMarkdownCases(text, sourceRel) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const cases = [];
  let module = null;
  let storyId = null;
  let current = null;
  let block = [];
  let section = null;
  let expectStory = false;

  const close = () => { if (current) cases.push(finishCase(current, block)); current = null; block = []; section = null; };

  lines.forEach((raw, i) => {
    const no = i + 1;
    const line = raw.replace(/\s+$/, '');
    let m;
    if (/^#\s+\S/.test(line) && !line.startsWith('##')) {
      close(); module = line.replace(/^#\s+/, '').trim(); storyId = null; expectStory = true; return;
    }
    if ((m = /^User Story ID:\s*(\S+)/i.exec(line)) && (expectStory || !current)) { storyId = m[1]; expectStory = false; return; }
    if (line.trim() !== '') expectStory = false;
    if ((m = /^##\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*(.+)$/.exec(line))) {
      close();
      current = {
        id: m[1], title: m[2].trim(), module: module ?? path.basename(sourceRel).replace(/\.\w+$/, ''), storyId,
        priority: null, tags: [], dependsOn: [], preconditions: [], data: [], steps: [], expected: [],
        source: { file: sourceRel, line: no },
      };
      block = [line];
      return;
    }
    if (!current) return;
    block.push(line);
    if ((m = /^###\s+(.+)$/.exec(line))) { section = SECTION[m[1].trim().toLowerCase()] ?? null; return; }
    if (section === null) {
      if ((m = /^Priority:\s*(.+)$/i.exec(line))) current.priority = m[1].trim();
      else if ((m = /^Tags:\s*(.+)$/i.exec(line))) current.tags = m[1].split(',').map((t) => t.trim().replace(/^@/, '')).filter(Boolean);
      else if ((m = /^Depends on:\s*(.+)$/i.exec(line))) current.dependsOn = m[1].split(',').map((t) => t.trim()).filter(Boolean);
      return;
    }
    if (line.trim() === '') return;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (section === 'preconditions' && bullet) current.preconditions.push(bullet[1].trim());
    else if (section === 'data' && bullet) {
      const colon = bullet[1].indexOf(':');
      if (colon > 0) current.data.push({ name: bullet[1].slice(0, colon).trim(), ...parseDataValue(bullet[1].slice(colon + 1)) });
    } else if (section === 'expected' && bullet) current.expected.push(bullet[1].trim());
    else if (section === 'steps') {
      const step = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (step) {
        const parts = step[2].split(/\s*->\s*Expected:\s*/i);
        current.steps.push({ n: Number(step[1]), text: parts[0].trim(), ...(parts[1] ? { expected: parts.slice(1).join(' ').trim() } : {}) });
      }
    }
  });
  close();
  return cases;
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  id: ['id', 'test case id', 'testcase id', 'tc id', 'test id', 'case id'],
  title: ['title', 'test case title', 'test case name', 'name', 'summary', 'scenario', 'test scenario'],
  module: ['module', 'feature', 'area', 'component', 'section'],
  steps: ['steps', 'test steps', 'step', 'procedure'],
  expected: ['expected result', 'expected results', 'expected', 'expected outcome'],
  preconditions: ['preconditions', 'precondition', 'prerequisites', 'pre-conditions'],
  priority: ['priority', 'severity'],
  tags: ['tags', 'labels', 'type'],
  data: ['test data', 'data'],
};

export function parseCsvCases(text, sourceRel) {
  const delimiter = (text.split(/\r?\n/, 1)[0].match(/\t/g)?.length ?? 0) > (text.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows = parseCsv(text, delimiter);
  if (rows.length < 2) return { cases: [], problems: [`${sourceRel}: no data rows`] };
  const norm = (h) => h.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const headers = rows[0].map(norm);
  const column = {};
  const problems = [];
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const hits = headers.map((h, i) => (aliases.includes(h) ? i : -1)).filter((i) => i >= 0);
    if (hits.length > 1 && ['id', 'steps', 'expected'].includes(field)) problems.push(`${sourceRel}: two columns fit "${field}" (${hits.map((i) => rows[0][i]).join(' / ')}); rename one so the choice is unambiguous.`);
    if (hits.length) column[field] = hits[0];
  }
  for (const need of ['id', 'steps']) if (!(need in column)) problems.push(`${sourceRel}: no column named like "${need}" (found: ${rows[0].join(', ')}).`);
  if (problems.length) return { cases: [], problems };
  const cases = [];
  let current = null;
  const flush = () => { if (current) { cases.push(finishCase(current.c, [JSON.stringify(current.raw)])); current = null; } };
  rows.slice(1).forEach((r, idx) => {
    const get = (f) => (f in column ? (r[column[f]] ?? '').trim() : '');
    const id = get('id');
    if (id) {
      flush();
      current = {
        raw: r,
        c: {
          id, title: get('title') || id, module: get('module') || path.basename(sourceRel).replace(/\.\w+$/, ''), storyId: null,
          priority: get('priority') || null, tags: get('tags').split(/[,;]/).map((t) => t.trim().replace(/^@/, '')).filter(Boolean),
          dependsOn: [], preconditions: get('preconditions').split(/\n/).map((x) => x.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean),
          data: [], steps: [], expected: [], source: { file: sourceRel, line: idx + 2 },
        },
      };
    } else if (current) current.raw = [...current.raw, ...r];
    if (!current) return;
    const stepsCell = get('steps');
    if (stepsCell) {
      for (const part of stepsCell.split(/\n|(?<=\S)\s+(?=\d+[.)]\s)/)) {
        const t = part.replace(/^\s*(?:step\s*)?\d*[.):\-]?\s*/i, '').trim();
        if (t) current.c.steps.push({ n: current.c.steps.length + 1, text: t });
      }
    }
    const exp = get('expected');
    if (exp) for (const part of exp.split(/\n/)) { const t = part.replace(/^[-*\d.)\s]+/, '').trim(); if (t) current.c.expected.push(t); }
    const data = get('data');
    if (data) for (const part of data.split(/\n/)) {
      const colon = part.indexOf(':');
      if (colon > 0) current.c.data.push({ name: part.slice(0, colon).replace(/^[-*\s]+/, '').trim(), ...parseDataValue(part.slice(colon + 1)) });
    }
  });
  flush();
  return { cases, problems: [] };
}

// ---------------------------------------------------------------- sources

const IGNORED_NAMES = new Set(['readme.md', 'claude.md', 'changelog.md']);

export function resolveSources(ctx, cfg, explicit) {
  const wanted = explicit?.length ? explicit : (cfg?.testCases?.sources?.length ? cfg.testCases.sources : null);
  const candidates = wanted ?? [
    path.join(ctx.root, 'test-design', 'test-cases'),
    path.join(ctx.fw, 'test-cases'),
  ].filter((p) => existsSync(p)).map((p) => toPosix(path.relative(ctx.root, p)));
  if (!candidates.length) {
    throw new CliError('No test cases found. Give the path to Markdown (canonical test-case format) or CSV test cases: --source <file-or-folder>.', { needsInput: 'testCases' });
  }
  const files = [];
  for (const c of candidates) {
    const abs = path.resolve(ctx.root, c);
    if (!existsSync(abs)) throw new CliError(`Test-case source not found: ${c}`, { needsInput: 'testCases' });
    if (statSync(abs).isDirectory()) {
      walkFiles(abs, { skip: ['node_modules', '.git'] })
        .filter((f) => /\.(md|markdown|csv|tsv|xlsx)$/i.test(f) && !IGNORED_NAMES.has(path.basename(f).toLowerCase()))
        .forEach((f) => files.push(f));
    } else files.push(abs);
  }
  return { files: [...new Set(files)].sort(), sources: candidates };
}

/** Parse all sources → { cases, sources: [{ file, hash, cases[] }], problems[] }. */
export function loadTestCases(ctx, cfg, explicit) {
  const { files, sources } = resolveSources(ctx, cfg, explicit);
  const cases = [];
  const sourceInfo = [];
  const problems = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(ctx.root, abs));
    if (/\.xlsx$/i.test(abs)) {
      problems.push(`${rel}: Excel files are not read by the mobile tooling. Export the sheet to CSV, or import it first with the pipeline's "input import" (it writes Markdown), then point --source at that.`);
      continue;
    }
    const text = readText(abs, null);
    if (text === null) { problems.push(`${rel}: cannot be read`); continue; }
    let found;
    if (/\.(csv|tsv)$/i.test(abs)) {
      const r = parseCsvCases(text, rel);
      problems.push(...r.problems);
      found = r.cases;
    } else found = parseMarkdownCases(text, rel);
    if (found.length === 0 && !problems.some((p) => p.startsWith(rel))) problems.push(`${rel}: no test cases found (expected "## <ID>: <title>" headings).`);
    sourceInfo.push({ file: rel, hash: sha256(text), cases: found.map((c) => c.id) });
    cases.push(...found);
  }
  const seen = new Map();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`Duplicate test case ID ${c.id}: ${seen.get(c.id)} and ${c.source.file}:${c.source.line}.`);
    else seen.set(c.id, `${c.source.file}:${c.source.line}`);
  }
  const ids = new Set(cases.map((c) => c.id));
  for (const c of cases) for (const d of c.dependsOn) if (!ids.has(d)) problems.push(`${c.id} depends on ${d}, which is not among the supplied test cases.`);
  return { cases, sources: sourceInfo, sourcePaths: sources, problems };
}

/** Environment-variable names (bare, as written after env:) that the cases reference. */
export function envNamesOf(cases) {
  return [...new Set(cases.flatMap((c) => c.data.filter((d) => d.kind === 'env').map((d) => d.env)))].sort();
}

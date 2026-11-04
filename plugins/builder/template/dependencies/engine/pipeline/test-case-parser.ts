// Reads supplied test cases (Markdown, CSV, Excel .xlsx) and normalizes them into the canonical test-case document
// (canonical.ts); test-specs.json is projected from it. Wording is preserved verbatim; nothing is inferred beyond what the
// source states. Gaps are flagged as validation issues. Input formats are documented in docs/test-spec-schema.md.
//
// Three readers (Markdown, CSV, worksheet) produce one intermediate form, DraftCase; `normalizeCases` turns drafts into
// canonical cases. A new layout inside a supported format is handled by the column mapping (input-table.ts), never by
// changing anything downstream of the canonical document.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256File, toPosixRelative } from '../utils/fs.ts';
import { readXlsx } from '../utils/xlsx.ts';
import {
  CANONICAL_SCHEMA_VERSION, documentValidation, isAutomatable, projectSpecs, validationOf,
  type CanonicalCase, type CanonicalDocument, type CanonicalStep, type TableFinding,
} from './canonical.ts';
import { cycleMembers } from './dependencies.ts';
import { quoteEnvValue } from './env-file.ts';
import {
  hitOf, labelField, mappingFor, mappingQuestions, normalizeHeader, reportOf, resolveTable,
  type Field, type InputMappings, type ResolvedTable, type TableMapping, type TableReport, type TableRow,
} from './input-table.ts';
import { isTableLine, readTableBlock } from './markdown-table.ts';
import {
  TEST_ID_PATTERN, slugify,
  type Ambiguity, type InputFormat, type SourceFile, type TestDataRef, type TestSpecDocument,
} from './test-spec.ts';

// The only formats advertised and read. Anything else is rejected with an actionable message (see unsupportedMessage).
export const FORMAT_BY_EXTENSION: Record<string, InputFormat> = { '.md': 'markdown', '.csv': 'csv', '.xlsx': 'xlsx' };
export const SUPPORTED_EXTENSIONS = Object.keys(FORMAT_BY_EXTENSION);

// What to do with a file the engine does not read, by extension.
export const CONVERT_FIRST: Record<string, string> = {
  '.xls': 'legacy Excel format: open it in Excel and save as .xlsx (or export to .csv)',
  '.xlsm': 'macro-enabled workbook: save a copy as .xlsx (or export to .csv)',
  '.ods': 'OpenDocument spreadsheet: save as .xlsx or export to .csv',
  '.numbers': 'Numbers spreadsheet: export to .xlsx or .csv',
  '.tsv': 'tab-separated text: save it as .csv (or open it in Excel and save as .xlsx)',
  '.markdown': 'rename the file to .md',
  '.txt': 'plain text: put the test cases in a .md file (one "## <ID>: <title>" heading per case) or a .csv/.xlsx table',
  '.docx': 'Word document: copy the test cases into a .md file or a .xlsx/.csv table',
  '.doc': 'Word document: copy the test cases into a .md file or a .xlsx/.csv table',
  '.pdf': 'PDF: copy the test cases into a .md file or a .xlsx/.csv table',
  '.json': 'JSON: convert the test cases to a .csv/.xlsx table or a .md file',
};

export function unsupportedMessage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const hint = CONVERT_FIRST[ext] ?? 'convert the test cases to one of these formats, or move this file out of the input folder';
  return `unsupported file type ${ext ? `"${ext}"` : '(no extension)'}: test cases are read from ${SUPPORTED_EXTENSIONS.join(', ')} files only. To fix: ${hint}`;
}

export function detectFormat(file: string): InputFormat | null {
  return FORMAT_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

// One step before IDs, statuses and validation are finalized.
export interface DraftStep {
  action: string;
  expected: string | null;
  data: TestDataRef[]; // data written on this step's own row
}

// A case as a reader found it: the shared intermediate form of all three formats.
export interface DraftCase {
  originalId: string | null;
  title: string;
  untitled: boolean; // the source gave neither an ID nor a title
  line: number; // Markdown line, CSV record line or spreadsheet row where the case starts
  endLine: number; // ... and where it ends (multi-row cases)
  suite: string | null;
  heading: string | null; // spreadsheet heading row the case sits under
  module: string | null; // explicit module from a column, sheet or mapping; Markdown cases use their "# heading" (suite)
  sheet: string | null;
  priority: string | null;
  tags: string[];
  preconditions: string[];
  dependsOn: string[]; // test IDs (or titles) as the source wrote them; resolved against all cases once every file is read
  steps: DraftStep[];
  expectedResults: string[];
  testData: TestDataRef[];
  metadata: Record<string, string>; // source information no field claims
  issues: Ambiguity[]; // found while reading (e.g. ambiguous columns)
}

function draft(line: number, suite: string | null, originalId: string | null, title: string): DraftCase {
  return {
    originalId, title, untitled: false, line, endLine: line, suite, heading: null, module: null, sheet: null, priority: null, tags: [],
    preconditions: [], dependsOn: [], steps: [], expectedResults: [], testData: [], metadata: {}, issues: [],
  };
}

const ID_TITLE = /^\[?([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*)\]?\s*(?:[:–—-]\s*|\s+)(.+)$/;
const ENV_REF = /^(?:env:\s*|\$\{)([A-Z_][A-Z0-9_]*)\}?$/;
const SECRET_NAME = /passw(?:or)?d|pass(?:code|phrase)|\bpass\b|pwd|secret|token|api[_-]?key|credential/i;
const IDENTITY_NAME = /e-?mail|user[ _-]?(?:name|id)|^user$|^login$|^account$/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INLINE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const VAGUE = /\b(?:works?|working|functions?)\s+(?:correctly|properly|fine|as expected)\b|^as expected$|\bshould be (?:ok|fine|correct)\b/i;
const STEP_EXPECTED = /\s*(?:->|=>|→|\|)\s*expected(?:\s+result)?\s*:\s*/i;

function splitIdTitle(text: string): { id: string | null; title: string } {
  const m = ID_TITLE.exec(text.trim());
  if (m && TEST_ID_PATTERN.test(m[1]!)) return { id: m[1]!, title: m[2]!.trim() };
  return { id: null, title: text.trim() };
}

// A heading that is only an ID ("TC-01"): the title comes from a "Title:" line, else the ID is the title.
const isBareId = (text: string): boolean => TEST_ID_PATTERN.test(text.trim()) && /\d/.test(text);
const isIdHeading = (text: string): boolean => splitIdTitle(text).id !== null || isBareId(text);

export function parseDataItem(text: string): TestDataRef | null {
  const m = /^([^:=]+?)\s*[:=]\s*(.*)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  const raw = m[2]!.trim().replace(/^["'`](.*)["'`]$/, '$1');
  const env = ENV_REF.exec(raw);
  if (env) return { name, value: null, envVar: env[1]!, declaredLiteral: false };
  // "literal:" declares a deliberately non-secret value (e.g. a wrong password for a negative test).
  const literal = /^literal:\s*(.*)$/.exec(raw);
  return { name, value: literal ? literal[1]! : raw, envVar: null, declaredLiteral: literal !== null };
}

// A literal that is a credential or account detail: a password/token-style field, a username/email field, or any email address.
// Written as "literal:<value>" it is treated as deliberately fake and left alone (e.g. a wrong password for a negative test).
export function isCredentialData(d: TestDataRef): boolean {
  if (d.envVar !== null || d.declaredLiteral || d.value === null || d.value === '') return false;
  return SECRET_NAME.test(d.name) || IDENTITY_NAME.test(d.name) || EMAIL_VALUE.test(d.value);
}

export interface DetectedCredential {
  envVar: string;
  value: string; // in memory only: handed to the caller that writes .env, never stored in test-specs.json
}

// Picks env var names for detected values: TEST_<DATA_NAME>, then TEST_<DATA_NAME>_<CASE_ID> when two cases need the same
// name for different values. Names the user wrote as env:VAR are reserved, so a detected value never lands in them.
class EnvAllocator {
  readonly values = new Map<string, string>();
  private readonly reserved: Set<string>;
  constructor(reserved: Iterable<string>) { this.reserved = new Set(reserved); }

  assign(dataName: string, value: string, caseKey: string): string {
    const token = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const base = `TEST_${token(dataName).replace(/^TEST_/, '') || 'VALUE'}`;
    const suffix = token(caseKey);
    for (let n = 0; ; n++) {
      const name = n === 0 ? base : n === 1 ? `${base}_${suffix}` : `${base}_${suffix}_${n}`;
      if (this.reserved.has(name)) continue;
      const held = this.values.get(name);
      if (held === undefined) { this.values.set(name, value); return name; }
      if (held === value) return name;
    }
  }
}

// Replaces credential literals with env var references, and inline email addresses in steps with a {name} placeholder
// backed by a new Test Data entry. Values that cannot be stored in a .env file are left for checkCase to flag.
function extractCredentials(c: DraftCase, caseKey: string, alloc: EnvAllocator): void {
  const nameOfValue = new Map<string, string>(); // raw value -> data name, so inline repeats reuse the entry
  const convert = (d: TestDataRef): TestDataRef => {
    if (!isCredentialData(d) || quoteEnvValue(d.value!) === null) return d;
    nameOfValue.set(d.value!, d.name);
    return { name: d.name, value: null, envVar: alloc.assign(d.name, d.value!, caseKey), declaredLiteral: false };
  };
  c.testData = c.testData.map(convert);
  for (const s of c.steps) s.data = s.data.map(convert);
  const defined = new Set(c.testData.map((d) => d.name.toLowerCase()));
  const swap = (text: string): string => text.replace(INLINE_EMAIL, (email) => {
    let name = nameOfValue.get(email);
    if (!name) {
      name = 'email';
      for (let n = 2; defined.has(name.toLowerCase()); n++) name = `email ${n}`;
      defined.add(name.toLowerCase());
      nameOfValue.set(email, name);
      c.testData.push({ name, value: null, envVar: alloc.assign(name, email, caseKey), declaredLiteral: false });
    }
    return `{${name}}`;
  });
  c.steps = c.steps.map((s) => ({ action: swap(s.action), expected: s.expected === null ? null : swap(s.expected), data: s.data }));
  c.expectedResults = c.expectedResults.map(swap);
}

function splitAction(text: string): DraftStep {
  const parts = text.split(STEP_EXPECTED);
  if (parts.length >= 2) return { action: parts[0]!.trim(), expected: parts.slice(1).join(' ').trim() || null, data: [] };
  return { action: text.trim(), expected: null, data: [] };
}

export const cleanName = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Appends text to a metadata entry; repeated headings/labels add lines instead of replacing what was read.
function addMeta(c: DraftCase, key: string, value: string, joiner = '\n'): void {
  const k = cleanName(key);
  const v = value.trim();
  if (!k || !v) return;
  c.metadata[k] = c.metadata[k] === undefined ? v : c.metadata[k]!.split('\n').includes(v) ? c.metadata[k]! : `${c.metadata[k]}${joiner}${v}`;
}

// ---------- Markdown ----------

type Section = 'none' | 'preconditions' | 'depends' | 'data' | 'steps' | 'expected' | 'meta' | 'metadata';

// A heading or label that opens one of the case sections, by the same names table headers use ("Procedure", "Expected Outcome").
function sectionOf(label: string): Exclude<Section, 'none' | 'meta'> | null {
  const f = labelField(label.replace(/[*_:]/g, ''));
  return f === 'preconditions' || f === 'depends' || f === 'data' || f === 'steps' || f === 'expected' ? f : null;
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// "Steps:", "**Steps:**", "**Steps**:", "Expected Result: X"; \1 is the bold marker, if any.
const LABEL = /^\s*(\*\*|__)?([A-Za-z][A-Za-z0-9 /().&'-]*?)\1?\s*:\s*\1?\s*(.*)$/;

// "## Login module" followed by "### TC-01: ..." headings: the ## heading names a module, it is not a case itself.
function moduleHeadings(lines: string[]): Set<number> {
  const heads = lines.flatMap((l, i) => {
    const m = HEADING.exec(l);
    return m ? [{ i, level: m[1]!.length, text: m[2]!.trim() }] : [];
  });
  const out = new Set<number>();
  heads.forEach((h, k) => {
    if (h.level !== 2 || isIdHeading(h.text) || sectionOf(h.text)) return;
    for (let j = k + 1; j < heads.length && heads[j]!.level > 2; j++) {
      if (isIdHeading(heads[j]!.text)) { out.add(h.i); return; }
    }
  });
  return out;
}

// Columns of a steps table inside a case ("| Step | Action | Expected Result |"): the number column is not the action.
const STEP_NUMBER_HEADER = new Set(['', 'step', 'step no', 'step number', 'no', 'number', 's no', 'sl no', 'sr no', 'seq', 'sequence']);
function stepTableColumns(header: string[]): { action: number; expected: number; data: number } | null {
  const norm = header.map(normalizeHeader);
  const find = (field: Field, skip?: (h: string) => boolean) => norm.findIndex((h) => hitOf(h)?.field === field && !(skip?.(h) ?? false));
  let action = find('steps', (h) => STEP_NUMBER_HEADER.has(h));
  if (action < 0) action = norm.findIndex((h) => h === 'step'); // a lone "Step" column holding the text
  if (action < 0) return null;
  return { action, expected: find('expected'), data: find('data') };
}

const DATA_TABLE_HEADER = new Set(['field', 'name', 'key', 'parameter', 'variable', 'data', 'item', 'input']);

export interface MarkdownTable {
  resolved: ResolvedTable;
  parse: TableParse | null; // null when the table was not a case table
}

export interface MarkdownDocument {
  drafts: DraftCase[];
  tables: MarkdownTable[]; // case tables found (each a table of test cases); reported like CSV/worksheet tables
}

export function parseMarkdownDocument(text: string, mapping?: TableMapping): MarkdownDocument {
  const cases: DraftCase[] = [];
  const tables: MarkdownTable[] = [];
  let suite: string | null = null;
  let cur = null as DraftCase | null; // assigned inside startCase too, so it must not be narrowed to null
  let caseLevel = 0; // heading level of the current case: only deeper headings are its sections
  let section: Section = 'none';
  let metaKey = '';
  let lastIndent = 0;
  let afterItem = false; // the previous line of the case was a list item
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const modules = moduleHeadings(lines);

  const startCase = (lineNo: number, heading: string, level: number) => {
    const { id, title } = splitIdTitle(heading);
    cur = isBareId(heading) ? draft(lineNo, suite, heading.trim(), '') : draft(lineNo, suite, id, title);
    cases.push(cur);
    caseLevel = level;
    section = 'none';
    lastIndent = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.replace(/\s+$/, '');
    if (line.trim() === '') continue;

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const heading = h[2]!.trim();
      // A known section name opens a section of the current case when it is deeper than the case heading, or at any ### level
      // or below (a case heading at ### may keep its sections at ###); at ## it is a new case, as it always was.
      const known = cur && (level > caseLevel || level >= 3) ? sectionOf(heading) : null;
      if (known) { section = known; cur!.endLine = lineNo; }
      else if (level === 1) {
        if (isIdHeading(heading)) startCase(lineNo, heading, 1);
        else { suite = heading; cur = null; }
      } else if (level === 2) {
        if (modules.has(i)) { suite = heading; cur = null; }
        else startCase(lineNo, heading, 2);
      } else if (isIdHeading(heading)) startCase(lineNo, heading, level);
      else if (cur) {
        // "### Metadata" holds "- Key: value" source information (written by input import); any other unknown heading is one note.
        section = normalizeHeader(heading) === 'metadata' ? 'metadata' : 'meta';
        metaKey = heading;
        cur.endLine = lineNo;
      }
      continue;
    }

    // A pipe table: a table of test cases, or (inside a case) its steps or its data.
    if (isTableLine(line)) {
      const { rows, next } = readTableBlock(lines, i);
      i = next - 1;
      if (rows.length === 0) continue;
      const resolved = resolveTable(rows, mapping);
      // Inside a case, a table is a table of cases only when its headers say so; one whose "ID" was read from a 1, 2, 3 counter
      // column is the case's own steps table.
      if (resolved.status === 'ok' && (cur === null || resolved.inferred.length === 0)) {
        const parse = parseTable(rows, resolved, { sheet: null, mapping });
        for (const d of parse.drafts) { d.suite = suite; d.heading = d.heading ?? suite; cases.push(d); }
        tables.push({ resolved, parse });
        cur = null;
        section = 'none';
      } else if (cur) {
        const c: DraftCase = cur;
        const cols = stepTableColumns(rows[0]!.cells);
        if (section === 'data') {
          const first = normalizeHeader(rows[0]!.cells[0] ?? '');
          for (const r of rows.slice(DATA_TABLE_HEADER.has(first) ? 1 : 0)) {
            const d = r.cells.length >= 2 && (r.cells[0] ?? '') !== '' ? parseDataItem(`${r.cells[0]}: ${r.cells[1]}`) : null;
            if (d) c.testData.push(d);
          }
        } else if (cols) {
          for (const r of rows.slice(1)) addTableSteps(c, r.cells[cols.action] ?? '', cols.expected < 0 ? '' : r.cells[cols.expected] ?? '', cols.data < 0 ? [] : parseDataCell(r.cells[cols.data] ?? ''));
        }
        c.endLine = rows[rows.length - 1]!.line;
      } else if (resolved.status === 'unresolved') {
        tables.push({ resolved, parse: null }); // looks like test cases but cannot be read: reported, not dropped
      }
      continue;
    }

    if (!cur) continue; // prose outside any test case
    const c: DraftCase = cur;
    c.endLine = lineNo;
    const followsItem = afterItem;
    afterItem = false;

    // "Steps:" style labels, optionally with inline content ("Expected Result: X")
    const label = LABEL.exec(line);
    if (label && !LIST_ITEM.test(line) && !(label[3] ?? '').startsWith('//')) {
      const bold = label[1] !== undefined;
      const key = label[2]!.trim();
      const value = (label[3] ?? '').trim();
      const field = labelField(key);
      const named = field === 'id' || field === 'title' || field === 'module';
      if (field === 'priority') { c.priority = value || null; continue; }
      if (field === 'tags') { c.tags = splitList(value); continue; }
      if (field === 'preconditions' || field === 'depends' || field === 'steps' || field === 'expected' || field === 'data') {
        section = field;
        if (value) addToSection(c, field, value);
        continue;
      }
      if (named && value && (section === 'none' || bold)) {
        if (field === 'id' && c.originalId === null) c.originalId = value;
        else if (field === 'title' && c.title === '') c.title = value;
        else if (field === 'module') c.module = cleanName(value);
        else addMeta(c, key, value);
        continue;
      }
      // Any other "Key: value" right under the case heading (or in bold) is source information to keep, not a continuation.
      // ... and so is an unindented one straight after a list item: wrapped text is indented, a new field is not.
      if (!named && (section === 'none' || section === 'meta' || section === 'metadata' || bold || (followsItem && !/^\s/.test(lines[i]!) && key.split(' ').length <= 3))) {
        if (value) addMeta(c, key, value);
        else { section = 'meta'; metaKey = key; }
        continue;
      }
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1]!.length;
      const content = item[2]!.trim();
      const nestedExpected = /^expected(?:\s+result)?\s*:\s*(.*)$/i.exec(content);
      if (section === 'steps' && indent > lastIndent && nestedExpected && c.steps.length > 0) {
        const step = c.steps[c.steps.length - 1]!;
        step.expected = step.expected ? `${step.expected} ${nestedExpected[1]!.trim()}` : nestedExpected[1]!.trim();
        continue;
      }
      lastIndent = indent;
      afterItem = true;
      if (section === 'meta') addMeta(c, metaKey, content);
      else if (section === 'none' || section === 'metadata') {
        const kv = /^([A-Za-z][A-Za-z0-9 /().&'-]*?)\s*:\s+(.+)$/.exec(content);
        if (kv) addMeta(c, kv[1]!, kv[2]!);
        else addMeta(c, 'Notes', content);
      } else addToSection(c, section, content);
      continue;
    }

    // Plain continuation text: append to the previous item in the section.
    appendContinuation(c, section, metaKey, line.trim());
  }
  for (const c of cases) if (c.title === '') c.title = c.originalId ?? '';
  return { drafts: cases, tables };
}

export function parseMarkdown(text: string, mapping?: TableMapping): DraftCase[] {
  return parseMarkdownDocument(text, mapping).drafts;
}

function addToSection(c: DraftCase, s: Section, content: string): void {
  if (s === 'preconditions') c.preconditions.push(content);
  else if (s === 'depends') c.dependsOn.push(...splitDeps(content));
  else if (s === 'expected') c.expectedResults.push(content);
  else if (s === 'steps') c.steps.push(splitAction(content));
  else if (s === 'data') {
    const d = parseDataItem(content);
    if (d) c.testData.push(d);
  }
}

function appendContinuation(c: DraftCase, s: Section, metaKey: string, text: string): void {
  const join = (a: string) => `${a} ${text}`;
  if (s === 'preconditions' && c.preconditions.length) c.preconditions[c.preconditions.length - 1] = join(c.preconditions.at(-1)!);
  else if (s === 'expected') {
    if (c.expectedResults.length) c.expectedResults[c.expectedResults.length - 1] = join(c.expectedResults.at(-1)!);
    else c.expectedResults.push(text);
  } else if (s === 'steps' && c.steps.length) {
    const st = c.steps.at(-1)!;
    if (st.expected) st.expected = join(st.expected);
    else st.action = join(st.action);
  } else if (s === 'none') addMeta(c, 'Description', text, ' ');
  else if (s === 'meta') addMeta(c, metaKey, text);
}

function splitList(v: string): string[] {
  return v.split(/[,;]/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
}

// "TC-001, TC-002", "TC-001 and TC-002", one per line. Trailing prose is kept so an unreadable reference is reported as written.
function splitDeps(v: string): string[] {
  return v.split(/[,;\n]|\s+and\s+/i).map((s) => s.trim().replace(/^[-*•]\s*/, '').replace(/^\[(.*)\]$/, '$1').trim()).filter((s) => s !== '' && !/^(?:none|n\/a|na|nil|-|—)$/i.test(s));
}

// ---------- Tables (CSV and spreadsheet sheets) ----------

export function parseCsvRecords(text: string): TableRow[] {
  const src = text.replace(/^﻿/, '');
  // The delimiter is the one used most across the first lines (a title block above the header may have none).
  const head = src.split(/\r?\n/).slice(0, 10).join('\n');
  const count = (re: RegExp) => head.match(re)?.length ?? 0;
  const delim = [[',', count(/,/g)], [';', count(/;/g)], ['\t', count(/\t/g)]].sort((a, b) => (b[1] as number) - (a[1] as number))[0]![0] as string;
  const records: TableRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { cells.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cells.push(cell);
      if (cells.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells });
      cells = []; cell = '';
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (quoted) throw new Error(`unterminated quoted field starting on line ${recordLine}`);
  cells.push(cell);
  if (cells.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells });
  return records;
}

// "1. Open", "2) Open", "Step 3: Open", "- Open", "• Open" -> "Open"
const NUMBERED = /^\s*(?:step\s*\d+\s*[-–:.)]?|\d+\s*[.):]|[-*•])\s*/i;

function cellLines(v: string): string[] {
  return v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Sheet names that say nothing about the feature under test; the file name is used for the module instead.
const GENERIC_SHEET = /^(?:sheet\s*\d*|test\s*cases?|tests?|test\s*suite|cases|data|main)$/i;

export interface TableParse {
  drafts: DraftCase[];
  moduleFrom: TableReport['moduleFrom'];
  sections: string[];
  titlePrefixes: TableReport['titlePrefixes'];
}

const TITLE_PREFIX = /^(.+?)\s+[-–—]\s+\S/;
const titlePrefixOf = (title: string): string | null => {
  const m = TITLE_PREFIX.exec(title);
  return m ? cleanName(m[1]!) : null;
};

// A heading row inside the table: only its first (ID) cell is filled and it reads as a name, not as an ID ("SMS login
// accessibility", "Blog Subscription/Subscription"; an ID-shaped value such as TC-9 is an incomplete case instead).
function sectionLabel(cells: string[], idColumn: number | undefined): string | null {
  if (idColumn === undefined) return null;
  const filled = cells.map((c, i) => [c.trim(), i] as const).filter(([c]) => c !== '');
  if (filled.length !== 1 || filled[0]![1] !== idColumn) return null;
  const text = filled[0]![0];
  return TEST_ID_PATTERN.test(text) && /\d/.test(text) ? null : cleanName(text);
}

function parseDataCell(cell: string): TestDataRef[] {
  const out: TestDataRef[] = [];
  for (const d of cell.split(/\r?\n|;/)) {
    const ref = d.trim() ? parseDataItem(d) : null;
    if (ref) out.push(ref);
  }
  return out;
}

// Turns the rows below a resolved header into cases. A row that starts a case has an ID or a title; a row with neither,
// or one repeating the previous case's ID, continues it (one step per row, as in merged-cell layouts).
export function parseTable(rows: TableRow[], t: ResolvedTable, opts: { sheet: string | null; mapping?: TableMapping }): TableParse {
  const get = (cells: string[], key: Field) => {
    const i = t.columns[key];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };
  const fixed = opts.mapping?.module ? cleanName(opts.mapping.module) : null;
  const sheetModule = opts.sheet !== null && !GENERIC_SHEET.test(opts.sheet.trim()) ? cleanName(opts.sheet) : null;
  const source = opts.mapping?.moduleSource;
  let moduleFrom: TableReport['moduleFrom'] = null;
  let columnModule: string | null = null;
  let sectionModule: string | null = null;
  const sections: string[] = [];

  // Columns no field claims keep their text as metadata (under the header's own name), so nothing is dropped silently.
  const used = new Set(Object.values(t.columns));
  const names = new Map<number, string>();
  t.header.forEach((h, i) => {
    if (h.trim() === '' || used.has(i)) return;
    let name = cleanName(h);
    for (let n = 2; [...names.values()].includes(name); n++) name = `${cleanName(h)} (${n})`;
    names.set(i, name);
  });
  const collect = (c: DraftCase, cells: string[]) => {
    for (const [i, name] of names) addMeta(c, name, cells[i] ?? '');
  };
  const mappingIssues = (): Ambiguity[] => t.ambiguous.map((a) => ({
    kind: 'ambiguous_column_mapping', stepIndex: null,
    message: `the ${a.field} could be any of ${a.headers.map((h) => JSON.stringify(h)).join(' or ')}; say which with "input map" (nothing is guessed)`,
  }));

  const drafts: DraftCase[] = [];
  let cur: DraftCase | null = null;
  for (const { line, cells } of rows.slice(t.headerIndex + 1)) {
    const section = sectionLabel(cells, t.columns.id);
    if (section !== null) {
      sectionModule = section;
      if (!sections.includes(section)) sections.push(section);
      cur = null; // a continuation row never carries over a heading
      continue;
    }
    const id = get(cells, 'id');
    const title = get(cells, 'title');
    const repeatsId = cur !== null && id !== '' && id === cur.originalId && (title === '' || title === cur.title);
    const rowData = parseDataCell(get(cells, 'data'));
    if ((id || title || !cur) && !repeatsId) {
      const cell = cleanName(get(cells, 'module'));
      if (cell) columnModule = cell; // an empty module cell inherits the one above (merged or filled-down column)
      // The first source that has a value wins; "section" (heading rows) is the default for a table that has them.
      const sources: [NonNullable<TableReport['moduleFrom']>, string | null][] = [
        ['mapping', fixed], ['column', columnModule],
        ['title-prefix', source === 'title-prefix' ? titlePrefixOf(title) : null],
        ['sheet', source === 'sheet' ? sheetModule : null],
        ['section', sectionModule], ['sheet', sheetModule],
      ];
      const [from, module] = sources.find(([, name]) => name !== null) ?? [null, null];
      moduleFrom ??= from;
      cur = draft(line, null, id || null, title || id || `Row ${line}`);
      cur.untitled = !id && !title;
      cur.module = module;
      cur.heading = sectionModule;
      cur.sheet = opts.sheet;
      cur.priority = get(cells, 'priority') || null;
      cur.tags = splitList(get(cells, 'tags'));
      cur.dependsOn = splitDeps(get(cells, 'depends'));
      cur.preconditions = cellLines(get(cells, 'preconditions')).map((l) => l.replace(NUMBERED, ''));
      cur.testData.push(...rowData);
      cur.issues = mappingIssues();
      drafts.push(cur);
    } else if (cur) {
      // A continuation row may bring its own data; the same name and value already read for this case is not repeated.
      for (const d of rowData) {
        if (!cur.testData.some((x) => x.name === d.name && x.value === d.value && x.envVar === d.envVar)) cur.testData.push(d);
      }
    }
    cur!.endLine = line;
    collect(cur!, cells);
    addTableSteps(cur!, get(cells, 'steps'), get(cells, 'expected'), rowData);
  }
  // Prefixes shared by several cases ("Home page - ..."), offered as an alternative way to name the modules.
  const prefixCounts = new Map<string, number>();
  for (const d of drafts) {
    const p = titlePrefixOf(d.title);
    if (p) prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  const shared = [...prefixCounts.values()].some((n) => n >= 2);
  const titlePrefixes = shared ? [...prefixCounts].slice(0, 30).map(([prefix, cases]) => ({ prefix, cases })) : [];
  return { drafts, moduleFrom, sections, titlePrefixes };
}

export function parseCsv(text: string, mapping?: TableMapping): DraftCase[] {
  const rows = parseCsvRecords(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const t = resolveTable(rows, mapping);
  if (t.status !== 'ok') throw new Error(`${t.reason}; found columns: ${t.header.filter((h) => h.trim()).map((h) => JSON.stringify(h.trim())).join(', ')}`);
  return parseTable(rows, t, { sheet: null, mapping }).drafts;
}

// One row may hold one step (multi-row cases) or a numbered list of steps (single-row cases). `data` is what the row's own
// Test Data cell holds; it belongs to the step when the row is exactly one step.
function addTableSteps(c: DraftCase, stepsCell: string, expectedCell: string, data: TestDataRef[] = []): void {
  const steps = cellLines(stepsCell).map((l) => l.replace(NUMBERED, ''));
  const expected = cellLines(expectedCell).map((l) => l.replace(NUMBERED, ''));
  if (steps.length === 0) {
    if (expected.length) c.expectedResults.push(...expected);
    return;
  }
  if (steps.length === 1) {
    c.steps.push({ action: steps[0]!, expected: expected.length ? expected.join(' ') : null, data });
    return;
  }
  if (expected.length === steps.length) {
    steps.forEach((s, i) => c.steps.push({ action: s, expected: expected[i]!, data: [] }));
    return;
  }
  // Counts don't line up: keep expected results at case level rather than guess a pairing.
  for (const s of steps) c.steps.push({ action: s, expected: null, data: [] });
  c.expectedResults.push(...expected);
}

// ---------- Normalization ----------

// Spreadsheet cases are keyed by sheet too, so the same title on two sheets stays two cases. Markdown/CSV IDs are unchanged.
function autoId(sourcePath: string, title: string, sheet: string | null = null): string {
  const where = sheet === null ? sourcePath : `${sourcePath}#${sheet}`;
  return `AUTO-${createHash('sha256').update(`${where}\n${title.trim().toLowerCase()}`).digest('hex').slice(0, 8)}`;
}

// The module a case belongs to: its explicit module (column, sheet, mapping), else its Markdown "# heading", else the file name.
function moduleOf(c: DraftCase, sourcePath: string): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  return cleanName(c.module ?? c.suite ?? '') || cleanName(stem) || 'General';
}

function checkCase(c: DraftCase): Ambiguity[] {
  const out: Ambiguity[] = [];
  if (c.untitled) out.push({ kind: 'untitled_case', message: 'the source gives this case neither an ID nor a title, so it cannot be identified; add one', stepIndex: null });
  if (c.steps.length === 0) out.push({ kind: 'missing_steps', message: 'no steps found', stepIndex: null });
  c.steps.forEach((s, i) => {
    if (!s.action) out.push({ kind: 'empty_step', message: `step ${i + 1} has no action`, stepIndex: i + 1 });
  });
  const anyExpected = c.expectedResults.length > 0 || c.steps.some((s) => s.expected);
  if (!anyExpected) out.push({ kind: 'missing_expected_result', message: 'no expected result is stated; it will not be invented', stepIndex: null });
  const vague = [...c.expectedResults, ...c.steps.map((s) => s.expected ?? '')].filter((e) => e && VAGUE.test(e));
  for (const v of vague) out.push({ kind: 'vague_expected_result', message: `"${v}" is not specific enough to assert`, stepIndex: null });
  const defined = new Set(c.testData.map((d) => d.name.toLowerCase()));
  c.steps.forEach((s, i) => {
    for (const m of `${s.action} ${s.expected ?? ''}`.matchAll(/\{([A-Za-z][\w .-]*)\}/g)) {
      if (!defined.has(m[1]!.toLowerCase())) {
        out.push({ kind: 'undefined_data_reference', message: `step ${i + 1} references {${m[1]}} but Test Data does not define it`, stepIndex: i + 1 });
      }
    }
  });
  // Credentials are moved to env vars before this runs, so what is left here could not be stored in a .env file.
  for (const d of c.testData) {
    if (isCredentialData(d)) {
      out.push({ kind: 'possible_secret_literal', message: `test data "${d.name}" looks like a credential but could not be moved to .env automatically (multi-line or unquotable value); put it in .env yourself and write env:VAR_NAME`, stepIndex: null });
    }
  }
  return out;
}

// Workbooks restart their numbering on every sheet ("TC001" on all of them) and often number with bare counters ("1").
// Such an ID is prefixed with its sheet (or file) name so it is unique and a valid test ID: "Target Block" + "TC001" -> TARGET-BLOCK-TC001.
function qualifyId(originalId: string, where: string): string | null {
  const slug = slugify(where).toUpperCase().slice(0, 30).replace(/-+$/, '');
  const prefix = /^[A-Z]/.test(slug) ? slug : `S${slug}`;
  const own = originalId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `${prefix}-${own}`;
  return own !== '' && TEST_ID_PATTERN.test(id) ? id : null;
}

const METADATA_VALUE_LIMIT = 2000;

// Source information kept for traceability must not become a place where credentials land: a value under a password-like or
// account-like name, or any email address, is replaced before it is saved.
function safeMetadata(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    const value = SECRET_NAME.test(k) || IDENTITY_NAME.test(k) ? '[redacted]' : v.replace(INLINE_EMAIL, '[redacted email]');
    out[k] = value.length > METADATA_VALUE_LIMIT ? `${value.slice(0, METADATA_VALUE_LIMIT)}…` : value;
  }
  return out;
}

const dataKey = (d: TestDataRef): string => `${d.name.toLowerCase()}\0${d.envVar ?? ''}\0${d.value ?? ''}`;

// The data a step uses: what its own row wrote, plus every {name} its text mentions that the case defines.
function stepData(s: DraftStep, caseData: TestDataRef[]): TestDataRef[] {
  const out = new Map<string, TestDataRef>();
  for (const d of s.data) out.set(dataKey(d), d);
  for (const m of `${s.action} ${s.expected ?? ''}`.matchAll(/\{([A-Za-z][\w .-]*)\}/g)) {
    const d = caseData.find((x) => x.name.toLowerCase() === m[1]!.toLowerCase());
    if (d) out.set(dataKey(d), d);
  }
  return [...out.values()];
}

export function normalizeCases(drafts: DraftCase[], sourcePath: string, format: InputFormat, seen: Map<string, CanonicalCase[]>): CanonicalCase[] {
  const table = format !== 'markdown';
  return drafts.map((c) => {
    const ambiguities = [...c.issues, ...checkCase(c)];
    let key = c.originalId ?? autoId(sourcePath, c.title, c.sheet);
    if (c.originalId !== null) {
      const where = c.sheet ?? path.basename(sourcePath, path.extname(sourcePath));
      // Only a workbook restarts its numbering per sheet; the same ID in two Markdown/CSV files is still a duplicate to flag.
      const usedElsewhere = c.sheet !== null && (seen.get(key) ?? []).some((p) => p.source.file !== sourcePath || p.source.sheet !== c.sheet);
      if (!TEST_ID_PATTERN.test(key) || usedElsewhere) key = qualifyId(key, where) ?? autoId(sourcePath, c.title, c.sheet);
    }
    let id = key;
    const prior = seen.get(key);
    if (prior) {
      // Both cases are flagged; the later one gets a suffixed ID so IDs stay unique.
      const msg = `ID "${key}" is used by more than one test case`;
      const dup: Ambiguity = { kind: 'duplicate_id', message: msg, stepIndex: null };
      for (const p of prior) {
        if (!p.validation.blocking.some((i) => i.code === 'duplicate_id')) {
          p.validation = validationOf([...p.validation.blocking, ...p.validation.warnings].map((i) => ({ kind: i.code, message: i.message, stepIndex: i.stepNumber })).concat(dup));
        }
      }
      ambiguities.push(dup);
      id = `${key}-dup${prior.length + 1}`;
    }
    const steps: CanonicalStep[] = c.steps.map((s, i) => {
      const data = stepData(s, c.testData);
      return {
        stepNumber: i + 1, action: s.action,
        ...(data.length > 0 ? { testData: data } : {}),
        ...(s.expected ? { expectedResult: s.expected } : {}),
      };
    });
    const module = moduleOf(c, sourcePath);
    const canonical: CanonicalCase = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      testCaseId: id,
      title: c.title,
      module,
      moduleSlug: slugify(module),
      suite: c.suite,
      preconditions: c.preconditions,
      steps,
      expectedResults: c.expectedResults,
      testData: c.testData,
      priority: c.priority,
      tags: c.tags,
      source: {
        file: sourcePath, fileName: path.basename(sourcePath), format, sheet: c.sheet,
        row: table ? c.line : null, endRow: table ? c.endLine : null,
        line: table ? null : c.line, endLine: table ? null : c.endLine,
        heading: c.heading ?? c.suite, originalId: c.originalId,
      },
      metadata: safeMetadata(c.metadata),
      validation: validationOf(ambiguities),
    };
    seen.set(key, [...(prior ?? []), canonical]);
    return canonical;
  });
}

// ---------- Dependencies between cases ----------

const ID_TOKEN = /[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9_-]*/g;
const shorten = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

function addAmbiguity(c: CanonicalCase, a: Ambiguity): void {
  const existing = [...c.validation.blocking, ...c.validation.warnings].map((i) => ({ kind: i.code, message: i.message, stepIndex: i.stepNumber }));
  if (existing.some((e) => e.kind === a.kind && e.message === a.message)) return;
  c.validation = validationOf([...existing, a]);
}

// Turns what the sources wrote after "Depends on" (and test IDs named in preconditions) into testCaseIds, and blocks the cases
// whose dependencies cannot be honoured: unknown or ambiguous references, loops, and cases that rely on a case that is itself blocked.
// A dependency is never guessed from the steps.
export function resolveDependencies(cases: CanonicalCase[], draftOf: Map<CanonicalCase, DraftCase>): void {
  const key = (s: string): string => s.trim().toLowerCase();
  const byId = new Map<string, CanonicalCase[]>();
  const byTitle = new Map<string, CanonicalCase[]>();
  const index = (m: Map<string, CanonicalCase[]>, k: string, c: CanonicalCase) => m.set(k, [...(m.get(k) ?? []), c]);
  for (const c of cases) {
    index(byId, key(c.testCaseId), c);
    if (c.source.originalId && key(c.source.originalId) !== key(c.testCaseId)) index(byId, key(c.source.originalId), c);
    index(byTitle, key(c.title), c);
  }
  // The same ID on several sheets: the case on the referring case's own sheet/file is the one meant.
  const pick = (from: CanonicalCase, found: CanonicalCase[] | undefined): CanonicalCase[] => {
    const all = [...new Set(found ?? [])];
    if (all.length <= 1) return all;
    const local = all.filter((o) => o.source.file === from.source.file && o.source.sheet === from.source.sheet);
    return local.length === 1 ? local : all;
  };

  for (const c of cases) {
    const resolved: string[] = [];
    for (const token of draftOf.get(c)?.dependsOn ?? []) {
      const found = pick(c, byId.get(key(token)));
      const match = found.length > 0 ? found : pick(c, byTitle.get(key(token)));
      if (match.length === 1) resolved.push(match[0]!.testCaseId);
      else {
        addAmbiguity(c, {
          kind: 'unresolved_dependency', stepIndex: null,
          message: match.length === 0
            ? `depends on "${shorten(token)}", which is not a test ID or title in the input; name the test ID it needs`
            : `depends on "${shorten(token)}", which matches ${match.length} test cases (${match.map((m) => m.testCaseId).slice(0, 4).join(', ')}); name one test ID`,
        });
      }
    }
    // A precondition that names another case is read as a dependency, and says so: it is the author's own wording, but the order
    // it implies is worth a second look.
    for (const p of c.preconditions) {
      for (const m of p.matchAll(ID_TOKEN)) {
        const found = pick(c, byId.get(key(m[0])));
        if (found.length !== 1 || found[0] === c || resolved.includes(found[0]!.testCaseId)) continue;
        resolved.push(found[0]!.testCaseId);
        addAmbiguity(c, {
          kind: 'dependency_inferred', stepIndex: null,
          message: `a precondition names ${found[0]!.testCaseId}, so it is run first; if that is not meant as a dependency, reword the precondition, and if it is, add it to a "Depends on" column to confirm`,
        });
      }
    }
    const unique = [...new Set(resolved)];
    if (unique.length > 0) c.dependsOn = unique;
  }

  const nodes = cases.map((c) => ({ id: c.testCaseId, module: c.module, moduleSlug: c.moduleSlug, dependsOn: c.dependsOn }));
  const cyclic = cycleMembers(nodes);
  for (const c of cases) {
    if (cyclic.has(c.testCaseId)) addAmbiguity(c, { kind: 'dependency_cycle', stepIndex: null, message: `it is part of a loop of dependencies (${(c.dependsOn ?? []).join(', ')}); no order can satisfy it` });
  }
  // Spread "cannot be automated yet" to everything that needs such a case, until nothing changes.
  const byTestId = new Map(cases.map((c) => [c.testCaseId, c]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of cases) {
      for (const d of c.dependsOn ?? []) {
        const dep = byTestId.get(d);
        if (!dep || isAutomatable(dep.validation.status)) continue;
        const before = c.validation.blocking.length;
        addAmbiguity(c, { kind: 'dependency_not_ready', stepIndex: null, message: `it depends on ${d}, which cannot be automated until its own questions are answered` });
        if (c.validation.blocking.length !== before) changed = true;
      }
    }
  }
}

export interface ParseError {
  path: string;
  message: string;
}

// Input paths are relative to baseDir (the dependencies/ folder).
export function listInputFiles(baseDir: string, inputPath: string): string[] {
  const abs = path.resolve(baseDir, inputPath);
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.startsWith('~$')) // dot files, and Excel's lock files for open workbooks
    .map((d) => path.join(d.parentPath, d.name))
    .sort();
}

export interface ParsedInputs {
  // The normalized result. `document` (test-specs.json) is projected from `canonical`; nothing else is read downstream.
  canonical: CanonicalDocument;
  document: TestSpecDocument;
  errors: ParseError[];
  unsupported: string[]; // files with an extension that is not read; each also appears in `errors`
  // One entry per CSV file / worksheet / Markdown case table: how its columns were read, what was left out, and where each case's module came from.
  tables: TableReport[];
  // Credential/email literals found in the input, already replaced by env var names in `document`.
  // Contains values: the caller writes them to .env and must not print or store them elsewhere.
  credentials: DetectedCredential[];
}

interface RawTable { sheet: string | null; rows: TableRow[] }

function readTables(abs: string, format: 'csv' | 'xlsx'): RawTable[] {
  if (format === 'csv') return [{ sheet: null, rows: parseCsvRecords(readFileSync(abs, 'utf8')) }];
  return readXlsx(readFileSync(abs)).map((s) => ({ sheet: s.name, rows: s.rows }));
}

const percent = (n: number): string => `${Math.round(n * 100)}%`;

export function parseInputs(baseDir: string, files: string[], now: Date = new Date(), mappings?: InputMappings): ParsedInputs {
  const sources: SourceFile[] = [];
  const errors: ParseError[] = [];
  const unsupported: string[] = [];
  const tables: TableReport[] = [];
  const seen = new Map<string, CanonicalCase[]>();
  const parsed: { rel: string; format: InputFormat; drafts: DraftCase[] }[] = [];

  // Reports one table and, when it cannot be read, the question that settles it. Returns whether its cases may be read.
  const report = (rel: string, sheet: string | null, t: ResolvedTable, mapping: TableMapping | undefined, fileErrors: ParseError[], isFile: boolean, parse: TableParse | null): TableReport => {
    const r: TableReport = { ...reportOf(rel, sheet, t), moduleFrom: null, sections: [], titlePrefixes: [], cases: 0 };
    tables.push(r);
    const where = sheet === null ? rel : `${rel} (sheet "${sheet}")`;
    // A standalone CSV is the user's test-case file by definition; only a workbook sheet may be a cover page or notes.
    const notATable = isFile && t.status === 'skipped' && !mapping?.skip;
    if (t.status === 'unresolved' || notATable) {
      const questions = mappingQuestions(r);
      fileErrors.push({
        path: rel,
        message: `${where}: ${t.reason}. Columns found: ${r.headers.map((h) => JSON.stringify(h)).join(', ') || 'none'}. ${questions.length > 0 ? `${questions.join(' ')} ` : ''}Map them with "input map" (see "input inspect")`,
      });
    }
    if (parse) {
      r.cases = parse.drafts.length;
      r.moduleFrom = parse.moduleFrom ?? 'file';
      r.sections = parse.sections;
      r.titlePrefixes = parse.titlePrefixes;
    }
    return r;
  };

  for (const abs of files) {
    const rel = toPosixRelative(baseDir, abs);
    const format = detectFormat(abs);
    if (!format) {
      errors.push({ path: rel, message: unsupportedMessage(abs) });
      unsupported.push(rel);
      continue;
    }
    try {
      let drafts: DraftCase[];
      if (format === 'markdown') {
        const mapping = mappingFor(mappings, rel, null);
        const md = parseMarkdownDocument(readFileSync(abs, 'utf8'), mapping);
        drafts = md.drafts;
        const fileErrors: ParseError[] = [];
        for (const t of md.tables) report(rel, null, t.resolved, mapping, fileErrors, false, t.parse);
        errors.push(...fileErrors);
        if (drafts.length === 0) {
          if (fileErrors.length === 0) errors.push({ path: rel, message: 'no test cases found (each case needs a "## <ID>: <title>" heading, or a table with ID/title, steps and expected-result columns)' });
          continue;
        }
      } else {
        drafts = [];
        const fileErrors: ParseError[] = [];
        for (const raw of readTables(abs, format)) {
          const mapping = mappingFor(mappings, rel, raw.sheet);
          const t = resolveTable(raw.rows, mapping);
          const table = t.status === 'ok' ? parseTable(raw.rows, t, { sheet: raw.sheet, mapping }) : null;
          report(rel, raw.sheet, t, mapping, fileErrors, raw.sheet === null && raw.rows.length > 0, table);
          if (table) drafts.push(...table.drafts);
        }
        errors.push(...fileErrors);
        if (drafts.length === 0) {
          if (fileErrors.length === 0) {
            const mine = tables.filter((x) => x.path === rel);
            const why = mine.map((x) => `${x.sheet === null ? '' : `sheet "${x.sheet}": `}${x.reason ?? 'no data rows'}${x.headers.length ? ` (columns: ${x.headers.map((h) => JSON.stringify(h)).join(', ')})` : ''}`).join('; ');
            errors.push({ path: rel, message: mine.some((x) => x.status === 'ok') ? 'no data rows' : `no test-case table found: ${why || 'the file is empty'}` });
          }
          continue;
        }
      }
      sources.push({ path: rel, sha256: sha256File(abs), format });
      parsed.push({ rel, format, drafts });
    } catch (err) {
      errors.push({ path: rel, message: (err as Error).message });
    }
  }

  // After every file is read, so names the user wrote as env:VAR anywhere in the input are reserved first.
  const alloc = new EnvAllocator(parsed.flatMap((p) => p.drafts.flatMap((c) => [...c.testData, ...c.steps.flatMap((s) => s.data)].flatMap((d) => (d.envVar ? [d.envVar] : [])))));
  const testCases: CanonicalCase[] = [];
  const draftOf = new Map<CanonicalCase, DraftCase>();
  for (const { rel, format, drafts } of parsed) {
    for (const c of drafts) extractCredentials(c, c.originalId ?? autoId(rel, c.title, c.sheet), alloc);
    const normalized = normalizeCases(drafts, rel, format, seen);
    normalized.forEach((n, i) => draftOf.set(n, drafts[i]!));
    testCases.push(...normalized);
  }
  resolveDependencies(testCases, draftOf);

  // Where reading a table needed a person (or a second look), at the level of the whole input.
  const findings: TableFinding[] = [];
  for (const t of tables) {
    if (t.ambiguous.length > 0) {
      findings.push({
        severity: 'blocking', kind: 'ambiguous_column_mapping', file: t.path, sheet: t.sheet, message: mappingQuestions(t).join(' '),
        fields: t.ambiguous.map((a) => a.field), headers: t.ambiguous.flatMap((a) => a.headers),
      });
    }
    if (t.inferred.length > 0) {
      findings.push({
        severity: 'warning', kind: 'inferred_columns', file: t.path, sheet: t.sheet,
        message: `no header named ${t.inferred.map((s) => s.field).join(', ')}; read from content: ${t.inferred.map((s) => `${s.field}=${JSON.stringify(s.header)} (${percent(s.confidence)})`).join(', ')}.${t.suggestions.length > 0 ? ` Also possible, not applied: ${t.suggestions.map((s) => `${s.field}=${JSON.stringify(s.header)} (${percent(s.confidence)})`).join(', ')}.` : ''} Confirm with "input map" if this is wrong`,
        fields: t.inferred.map((s) => s.field), headers: t.inferred.map((s) => s.header),
      });
    }
  }

  const canonical: CanonicalDocument = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sources,
    validation: documentValidation(testCases, errors, findings),
    testCases,
  };
  return {
    canonical,
    document: projectSpecs(canonical),
    errors,
    unsupported,
    tables,
    credentials: [...alloc.values].map(([envVar, value]) => ({ envVar, value })),
  };
}

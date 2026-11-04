// `input inspect` and `input map`: see how the user's own CSV/Excel layout is read, and teach the pipeline a layout its
// built-in column names do not cover. Output carries headers, module names and counts, never cell values, because test
// cases can contain credentials and this output goes to the agent and the chat.

import path from 'node:path';
import { FIELDS, MODULE_SOURCES, mappingKey, mappingQuestions, saveMappings, type Field, type InputMappings, type TableMapping, type TableReport } from './input-table.ts';
import { detectFormat, listInputFiles, parseInputs, unsupportedMessage, type ParseError } from './test-case-parser.ts';
import { toPosixRelative } from '../utils/fs.ts';

export interface InputInspection {
  files: { path: string; format: string | null }[];
  tables: TableReport[];
  // What a person still has to answer about how a table is read (ambiguous columns, proposals for unmapped ones), as sentences.
  questions: string[];
  modules: { module: string; moduleSlug: string; cases: number; sources: string[] }[];
  errors: ParseError[];
  unsupported: string[];
  ok: boolean;
}

export function inspectInput(baseDir: string, inputPath: string, mappings: InputMappings): InputInspection {
  const files = listInputFiles(baseDir, inputPath);
  const parsed = parseInputs(baseDir, files, new Date(), mappings);
  const modules = new Map<string, InputInspection['modules'][number]>();
  for (const s of parsed.document.specs) {
    const m = modules.get(s.moduleSlug) ?? { module: s.module, moduleSlug: s.moduleSlug, cases: 0, sources: [] };
    m.cases++;
    const src = s.source.sheet ? `${s.source.path} [${s.source.sheet}]` : s.source.path;
    if (!m.sources.includes(src)) m.sources.push(src);
    modules.set(s.moduleSlug, m);
  }
  return {
    files: files.map((f) => ({ path: toPosixRelative(baseDir, f), format: detectFormat(f) })),
    tables: parsed.tables,
    questions: parsed.tables.flatMap(mappingQuestions),
    modules: [...modules.values()],
    errors: parsed.errors,
    unsupported: parsed.unsupported,
    ok: parsed.errors.length === 0 && parsed.document.specs.length > 0 && !parsed.tables.some((t) => t.ambiguous.length > 0),
  };
}

export interface MapRequest {
  file: string; // relative to dependencies/
  sheet: string | null; // null: a CSV file, or every sheet of a workbook
  columns: string[]; // "field=Header text"
  headerRow?: number;
  module?: string;
  moduleFrom?: string; // section | sheet | title-prefix
  skip: boolean;
  clear: boolean;
}

export type MapResult =
  | { ok: true; key: string; mapping: TableMapping | null; tables: TableReport[] }
  | { ok: false; message: string; tables?: TableReport[] };

export function applyMapping(baseDir: string, rootDir: string, current: InputMappings, req: MapRequest): MapResult {
  const abs = path.resolve(baseDir, req.file);
  const format = detectFormat(abs);
  if (format === null) return { ok: false, message: `${req.file}: ${unsupportedMessage(abs)}` };
  const key = mappingKey(toPosixRelative(baseDir, abs), req.sheet);

  const next: InputMappings = { ...current, tables: { ...current.tables } };
  if (req.clear) {
    delete next.tables[key];
    saveMappings(rootDir, next);
    return { ok: true, key, mapping: null, tables: inspectInput(baseDir, req.file, next).tables };
  }

  const columns: Partial<Record<Field, string>> = {};
  for (const spec of req.columns) {
    const eq = spec.indexOf('=');
    const field = spec.slice(0, eq).trim();
    const header = spec.slice(eq + 1).trim();
    if (eq <= 0 || !header) return { ok: false, message: `--column must be field="Header text" (got "${spec}")` };
    if (!(FIELDS as readonly string[]).includes(field)) return { ok: false, message: `unknown field "${field}" (fields: ${FIELDS.join(', ')})` };
    columns[field as Field] = header;
  }
  const mapping: TableMapping = { ...current.tables[key] };
  if (Object.keys(columns).length) mapping.columns = { ...mapping.columns, ...columns };
  if (req.headerRow !== undefined) {
    if (!Number.isInteger(req.headerRow) || req.headerRow < 1) return { ok: false, message: '--header-row must be a positive row number' };
    mapping.headerRow = req.headerRow;
  }
  if (req.module) mapping.module = req.module;
  if (req.moduleFrom !== undefined) {
    if (!(MODULE_SOURCES as readonly string[]).includes(req.moduleFrom)) return { ok: false, message: `--module-from must be one of: ${MODULE_SOURCES.join(', ')}` };
    mapping.moduleSource = req.moduleFrom as (typeof MODULE_SOURCES)[number];
  }
  if (req.skip) mapping.skip = true;
  else delete mapping.skip;
  if (!mapping.columns && mapping.headerRow === undefined && !mapping.module && !mapping.moduleSource && !mapping.skip) {
    return { ok: false, message: 'nothing to save: give --column, --header-row, --module, --module-from or --skip (or --clear to remove a saved mapping)' };
  }

  next.tables[key] = mapping;
  const inspection = inspectInput(baseDir, req.file, next);
  const mine = inspection.tables.filter((t) => (req.sheet === null ? true : t.sheet === req.sheet));
  if (req.sheet !== null && mine.length === 0) return { ok: false, message: `sheet "${req.sheet}" was not found in ${req.file}`, tables: inspection.tables };
  // A mapping aimed at one table (a CSV, or a named sheet) must make it readable; a workbook-wide one only must not break a sheet.
  const targeted = format !== 'xlsx' || req.sheet !== null;
  const broken = req.skip ? undefined : mine.find((t) => (targeted ? t.status !== 'ok' : t.status === 'unresolved'));
  if (broken) return { ok: false, message: `not saved: ${broken.reason}`, tables: mine };
  saveMappings(rootDir, next);
  return { ok: true, key, mapping, tables: mine };
}

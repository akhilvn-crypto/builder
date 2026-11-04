// `input import`: take the user's test cases from wherever they keep them (any path, any supported layout), convert them to
// the pipeline's own Markdown format and save them under dependencies/input/test-cases/, one file per test case. The original
// is only read, never changed or copied. Pure Node; the CLI handler does the .env sync, because the converted files hold
// env:VAR references instead of the credential values the source may contain.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InputMappings } from './input-table.ts';
import { renderCaseMarkdown } from './modules.ts';
import { detectFormat, listInputFiles, parseInputs, type DetectedCredential, type ParseError } from './test-case-parser.ts';
import { TEST_SPEC_SCHEMA_VERSION, type TestSpecDocument } from './test-spec.ts';

// Relative to dependencies/, like every other input path.
export const IMPORT_DIR = 'input/test-cases';

export interface ImportedFile {
  file: string; // relative to dependencies/; one file per test case, named <id>.md
  id: string;
  module: string;
  state: 'created' | 'updated' | 'unchanged' | 'conflict';
}

export interface ImportResult {
  ok: boolean;
  source: string;
  destination: string; // IMPORT_DIR
  alreadyInPlace: boolean; // the source is already Markdown inside the destination folder: nothing to convert
  files: ImportedFile[];
  counts: { total: number; valid: number; warning: number; needsClarification: number; invalid: number; ready: number }; // ready = valid + warning
  needsClarification: { id: string; title: string; status: string; ambiguities: { kind: string; message: string }[] }[]; // needs_clarification and invalid
  renamedIds: { id: string; originalId: string }[]; // duplicate source IDs get a -dupN suffix, so they are unique in the converted files
  // Other test-case files already in the destination folder (not written by this import): the pipeline reads them too.
  othersInFolder: string[];
  tables: ReturnType<typeof parseInputs>['tables'];
  errors: ParseError[];
  unsupported: string[];
  // Not for output: the CLI writes these to .env. Contains values.
  credentials: DetectedCredential[];
  document: TestSpecDocument;
}

// Users paste paths with surrounding quotes ("C:\Users\me\cases.xlsx") and `~` is not expanded by every shell.
export function cleanSourcePath(raw: string, cwd: string = process.cwd()): string {
  const unquoted = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
  return path.resolve(cwd, unquoted);
}

function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const eol = (s: string): string => s.replace(/\r\n/g, '\n');

export interface ImportOptions {
  overwrite?: boolean;
  now?: Date;
  // Where the converted files go, relative to dependencies/. Default IMPORT_DIR. The design-to-automation handoff uses its own
  // sub-folder so cases a person imported by hand and cases that came from the test design never share a folder.
  destDir?: string;
  // Convert only these cases (by ID). Default: every case found. The other cases are read (and validated) but not written.
  include?: (id: string) => boolean;
}

export function importInput(baseDir: string, sourceAbs: string, mappings: InputMappings, opts: ImportOptions = {}): ImportResult {
  const destDir = opts.destDir ?? IMPORT_DIR;
  const destAbs = path.join(baseDir, destDir);
  const empty = {
    source: sourceAbs, destination: destDir, alreadyInPlace: false, files: [] as ImportedFile[],
    counts: { total: 0, valid: 0, warning: 0, needsClarification: 0, invalid: 0, ready: 0 }, needsClarification: [], renamedIds: [], othersInFolder: [] as string[], tables: [],
    errors: [] as ParseError[], unsupported: [] as string[], credentials: [] as DetectedCredential[],
    document: { schemaVersion: TEST_SPEC_SCHEMA_VERSION, generatedAt: (opts.now ?? new Date()).toISOString(), sources: [], specs: [] } as TestSpecDocument,
  };
  const fail = (message: string, more: Partial<ImportResult> = {}): ImportResult => ({ ...empty, ...more, ok: false, errors: [...(more.errors ?? []), { path: sourceAbs, message }] });

  if (!existsSync(sourceAbs)) return fail('path does not exist');

  // Files under the destination are what the pipeline reads already; converting them again would read every case twice.
  const inDest = isInside(destAbs, sourceAbs);
  const all = listInputFiles(baseDir, sourceAbs);
  const toRead = inDest ? all : all.filter((f) => !isInside(destAbs, f)); // a source folder that contains the destination
  if (toRead.length === 0) return fail(`no files found${statSync(sourceAbs).isDirectory() ? ' in this folder' : ''}`);
  const parsed = parseInputs(baseDir, toRead, opts.now, mappings);

  // The parser names files relative to dependencies/ ("../../../Users/me/cases.xlsx"); show them relative to the source instead.
  const shown = (rel: string): string => {
    const abs = path.resolve(baseDir, rel);
    return statSync(sourceAbs).isDirectory() ? path.relative(sourceAbs, abs).split(path.sep).join('/') || path.basename(abs) : path.basename(abs);
  };
  const relOf = (abs: string): string => path.relative(baseDir, abs).split(path.sep).join('/');
  const tell = (e: ParseError): ParseError => {
    const rel = toRelPaths.find((r) => e.path === r);
    return rel === undefined ? e : { path: shown(rel), message: e.message.split(rel).join(shown(rel)) };
  };
  const toRelPaths = toRead.map(relOf);

  const base: ImportResult = {
    ...empty, document: parsed.document, tables: parsed.tables.map((t) => ({ ...t, path: shown(t.path) })),
    errors: parsed.errors.map(tell), unsupported: parsed.unsupported.map(shown), credentials: parsed.credentials, ok: false,
  };
  const specs = parsed.document.specs;
  const byId = new Map(parsed.canonical.testCases.map((c) => [c.testCaseId, c]));
  const counts = parsed.canonical.validation.counts;
  base.counts = {
    total: specs.length, valid: counts.valid, warning: counts.warning, needsClarification: counts.needs_clarification, invalid: counts.invalid,
    ready: counts.valid + counts.warning,
  };
  base.needsClarification = specs.filter((s) => s.status === 'needs_clarification')
    .map((s) => ({ id: s.id, title: s.title, status: byId.get(s.id)?.validation.status ?? 'needs_clarification', ambiguities: s.ambiguities.map((a) => ({ kind: a.kind, message: a.message })) }));
  base.renamedIds = specs.filter((s) => s.source.originalId && s.id !== s.source.originalId).map((s) => ({ id: s.id, originalId: s.source.originalId! }));

  if (toRead.every((f) => detectFormat(f) === null)) {
    base.errors.push({ path: sourceAbs, message: `no supported test-case files (supported: .md, .csv, .xlsx; found ${toRead.length} file(s))` });
  }
  // Nothing is written from a partly readable source: a half-converted set would look complete.
  if (base.errors.length > 0 || specs.length === 0) {
    if (base.errors.length === 0) base.errors.push({ path: sourceAbs, message: 'no test cases found' });
    return base;
  }

  if (inDest) {
    if (toRead.every((f) => detectFormat(f) === 'markdown')) return { ...base, ok: true, alreadyInPlace: true, credentials: [] };
    return { ...base, credentials: [], errors: [{ path: sourceAbs, message: `this is inside ${destDir}/ but is not Markdown; move it to another folder and import it from there, so the converted files and the original are not both read` }] };
  }

  const out: ImportedFile[] = [];
  const writes: { abs: string; content: string }[] = [];
  // One file per test case, named after its ID, so a single case can be found and edited on its own.
  for (const s of specs) {
    if (opts.include && !opts.include(s.id)) continue;
    const abs = path.join(destAbs, `${s.id}.md`);
    // Where the case came from is kept in its metadata, so the converted file still points at the original sheet and row.
    const c = byId.get(s.id)!;
    const origin = `${c.source.fileName}${c.source.sheet ? ` > ${c.source.sheet}` : ''}, ${c.source.row !== null ? `row ${c.source.row}` : `line ${c.source.line}`}`;
    const content = renderCaseMarkdown(s, { ...c.metadata, 'Imported from': origin });
    const rel = `${destDir}/${s.id}.md`;
    const row = { file: rel, id: s.id, module: s.module };
    if (!existsSync(abs)) { out.push({ ...row, state: 'created' }); writes.push({ abs, content }); }
    else if (eol(readFileSync(abs, 'utf8')) === eol(content)) out.push({ ...row, state: 'unchanged' });
    else if (opts.overwrite) { out.push({ ...row, state: 'updated' }); writes.push({ abs, content }); }
    else out.push({ ...row, state: 'conflict' });
  }
  const written = new Set(out.map((f) => path.basename(f.file)));
  base.othersInFolder = existsSync(destAbs)
    ? listInputFiles(baseDir, destAbs).filter((f) => detectFormat(f) !== null && !written.has(path.basename(f))).map((f) => relOf(f))
    : [];
  const conflicts = out.filter((f) => f.state === 'conflict');
  if (conflicts.length > 0) {
    return {
      ...base, files: out, credentials: [],
      errors: [{ path: destDir, message: `${conflicts.map((c) => c.file).join(', ')} already exist with different content; nothing was written. Re-run with --overwrite to replace them, or import from a different source` }],
    };
  }
  mkdirSync(destAbs, { recursive: true });
  for (const w of writes) writeFileSync(w.abs, w.content);
  return { ...base, ok: true, files: out };
}

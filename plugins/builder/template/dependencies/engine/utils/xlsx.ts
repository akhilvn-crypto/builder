// Minimal .xlsx reader built on node:zlib only (an .xlsx is a zip of XML parts), so no dependency has to be installed.
// Reads sheet names and cell text; styles, formulas and charts are ignored. A formula cell yields its cached value.
// Merged cells are NOT expanded: only the top-left cell of a merged range holds a value, which is what a test-case
// table wants (an ID merged over several step rows means "these rows continue one case").

import { inflateRawSync } from 'node:zlib';

const MAX_PART_BYTES = 64 * 1024 * 1024;

export interface Sheet {
  name: string;
  // Rows that hold at least one value, in sheet order. `line` is the 1-based sheet row number.
  rows: { line: number; cells: string[] }[];
}

export class XlsxError extends Error {}

interface ZipEntry { method: number; compressedSize: number; size: number; offset: number }

function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('not a valid .xlsx file (no zip directory; a password-protected or legacy .xls workbook cannot be read: save it as .xlsx or .csv)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('corrupt .xlsx zip directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readPart(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  if (e.size > MAX_PART_BYTES) throw new XlsxError(`${name} is too large to read`);
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new XlsxError(`corrupt .xlsx entry ${name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
  throw new XlsxError(`unsupported zip compression in ${name}`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_, dec, hex, name) =>
    name ? ENTITIES[name]! : String.fromCodePoint(Number(dec ?? parseInt(hex, 16))));
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : null;
}

// Concatenated text of every <t> in a fragment (rich text splits one string over several runs). Phonetic hints are dropped.
function textOf(fragment: string): string {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += decode(m[1] ?? '');
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] ?? '') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => textOf(m[1] ?? ''));
}

function parseSheet(xml: string, strings: string[]): Sheet['rows'] {
  const rows: Sheet['rows'] = [];
  let nextLine = 1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const line = Number(attr(rm[1]!, 'r') ?? nextLine);
    nextLine = line + 1;
    const cells: string[] = [];
    let col = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1]!, 'r');
      if (ref) col = columnIndex(ref);
      const type = attr(cm[1]!, 't');
      const body = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = v === undefined ? '' : (strings[Number(v)] ?? '');
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = decode(v);
      while (cells.length < col) cells.push('');
      cells[col] = value;
      col++;
    }
    if (cells.some((c) => c.trim() !== '')) rows.push({ line, cells });
  }
  return rows;
}

function resolveTarget(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

export function readXlsx(buf: Buffer): Sheet[] {
  const entries = readZipDirectory(buf);
  const workbook = readPart(buf, entries, 'xl/workbook.xml');
  if (!workbook) throw new XlsxError('not an Excel workbook (xl/workbook.xml is missing)');
  const rels = new Map<string, string>();
  for (const m of (readPart(buf, entries, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, resolveTarget(target));
  }
  const strings = sharedStrings(readPart(buf, entries, 'xl/sharedStrings.xml'));
  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const target = rels.get(attr(m[0], 'r:id') ?? '');
    if (!name || !target) continue;
    // Hidden sheets are usually lookup lists or drafts; they are still read, and the caller reports every sheet it uses.
    const xml = readPart(buf, entries, target);
    if (xml === null) continue; // a chartsheet or a missing part holds no cells
    sheets.push({ name, rows: parseSheet(xml, strings) });
  }
  if (sheets.length === 0) throw new XlsxError('the workbook has no readable sheets');
  return sheets;
}

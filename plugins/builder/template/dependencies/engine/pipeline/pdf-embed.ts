// Embeds files (the evidence videos) in a PDF that Chromium already printed, without a PDF library.
//
// Chromium cannot embed media when it prints, so the report HTML puts a small link where each video belongs
// (<a href="...#evidence-video-N">) and Chromium turns it into a /Link annotation with that address. This module then appends a
// PDF *incremental update* (ISO 32000-1 §7.5.6) that
//   1. stores each video as an /EmbeddedFile stream (the bytes are inside the PDF, not referenced by path or URL),
//   2. replaces the matching /Link annotation, in place and at the same position, by
//        - a /FileAttachment annotation with a play icon (the viewer opens the file with another program), or, for an item marked
//          `inline` (H.264 MP4), by a /Screen annotation with a Rendition action (ISO 32000-1 §13.2): the click plays the clip
//          inside that rectangle of the page, in viewers that implement multimedia (Adobe Acrobat / Reader; browser PDF viewers
//          never play embedded video),
//   3. lists the files in the catalog's /Names /EmbeddedFiles tree (so viewers show them in their Attachments panel).
// Pages and the original objects are never rewritten, only appended to, so the printed report is untouched.
//
// Skia (Chromium's PDF backend) writes a classic cross-reference table and plain dictionaries; that is what this reads. Any other
// layout (xref streams, an existing /Names entry) is reported, never guessed at. listEmbeddedFiles() is an independent reader used
// to verify the result. Pure Node; no dependencies.

import { createHash } from 'node:crypto';

export class PdfEmbedError extends Error {}

export interface EmbedItem {
  token: string; // marker after the "#" in the Link annotation's URI, e.g. "evidence-video-3"
  fileName: string; // shown by the viewer; reduced to [A-Za-z0-9._-]
  description: string;
  mime: string; // e.g. "video/webm"
  data: Buffer;
  inline?: boolean; // play inside the page (needs a format viewers play natively: H.264 MP4) instead of opening it as an attachment
}

export interface EmbedResult {
  pdf: Buffer;
  embedded: number; // files stored in the PDF
  annotated: number; // page annotations turned into attachment icons or players
  players: number; // of those, the ones that play the clip inside the page (Screen annotation with a Rendition action)
  unplaced: string[]; // tokens whose link was not found in the PDF (the file is attached, but has no icon on a page)
  attachmentList: boolean; // false when the catalog already had /Names and the Attachments-panel list was left alone
}

export interface EmbeddedFileInfo {
  name: string;
  size: number;
  sha256: string;
  mime: string | null;
}

// ---- a minimal PDF object reader ----

const DELIM = '/[]<>()%';
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';

function skipSpace(s: string, i: number): number {
  for (;;) {
    while (i < s.length && isSpace(s[i])) i++;
    if (s[i] !== '%') return i;
    while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
  }
}

function tokenEnd(s: string, i: number): number {
  while (i < s.length && !isSpace(s[i]) && !DELIM.includes(s[i]!)) i++;
  return i;
}

// Index just past the value that starts at (or after whitespace from) `i`.
function valueEnd(s: string, i: number): number {
  i = skipSpace(s, i);
  const c = s[i];
  if (c === undefined) throw new PdfEmbedError('unexpected end of a PDF object');
  if (c === '<' && s[i + 1] === '<') {
    i += 2;
    for (;;) {
      i = skipSpace(s, i);
      if (s[i] === '>' && s[i + 1] === '>') return i + 2;
      if (s[i] !== '/') throw new PdfEmbedError('malformed PDF dictionary');
      i = valueEnd(s, tokenEnd(s, i + 1));
    }
  }
  if (c === '[') {
    i++;
    for (;;) {
      i = skipSpace(s, i);
      if (s[i] === ']') return i + 1;
      i = valueEnd(s, i);
    }
  }
  if (c === '(') {
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) return i + 1;
    }
    throw new PdfEmbedError('unterminated PDF string');
  }
  if (c === '<') {
    const end = s.indexOf('>', i);
    if (end < 0) throw new PdfEmbedError('unterminated PDF hex string');
    return end + 1;
  }
  if (c === '/') return tokenEnd(s, i + 1);
  let end = tokenEnd(s, i);
  if (end === i) throw new PdfEmbedError(`unexpected "${c}" in a PDF object`);
  // "12 0 R" is one value (an indirect reference).
  if (/^\d+$/.test(s.slice(i, end))) {
    const g = skipSpace(s, end);
    const gEnd = tokenEnd(s, g);
    if (/^\d+$/.test(s.slice(g, gEnd))) {
      const r = skipSpace(s, gEnd);
      if (s[r] === 'R' && tokenEnd(s, r) === r + 1) end = r + 1;
    }
  }
  return end;
}

// Top-level keys (without the slash) of the dictionary that starts at s[0], mapped to the raw text of their values.
function parseDict(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = skipSpace(s, 0);
  if (s[i] !== '<' || s[i + 1] !== '<') throw new PdfEmbedError('expected a PDF dictionary');
  i += 2;
  for (;;) {
    i = skipSpace(s, i);
    if (s[i] === '>' && s[i + 1] === '>') return out;
    if (s[i] !== '/') throw new PdfEmbedError('malformed PDF dictionary');
    const keyEnd = tokenEnd(s, i + 1);
    const valueStart = skipSpace(s, keyEnd);
    const end = valueEnd(s, valueStart);
    out.set(s.slice(i + 1, keyEnd), s.slice(valueStart, end));
    i = end;
  }
}

const refNumber = (v: string | undefined): number | null => {
  const m = v ? /^(\d+)\s+\d+\s+R$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : null;
};

function decodeLiteral(raw: string): string {
  const body = raw.trim().slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && body[i + 1] !== undefined && body[i + 1]! >= '0' && body[i + 1]! <= '7') oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 255);
    } else if (n === '\n') { /* line continuation */ } else if (n === '\r') { if (body[i + 1] === '\n') i++; } else out += n;
  }
  return out;
}

interface XrefEntry { offset: number; gen: number }
interface Xref {
  entries: Map<number, XrefEntry>;
  size: number;
  trailer: Map<string, string>; // the newest trailer
  startxref: number;
}

function readXref(pdf: Buffer): Xref {
  const tail = pdf.toString('latin1', Math.max(0, pdf.length - 2048));
  const found = [...tail.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!found) throw new PdfEmbedError('no startxref: not a complete PDF');
  const startxref = Number(found[1]);
  const entries = new Map<number, XrefEntry>();
  const freed = new Set<number>();
  const seen = new Set<number>();
  let newest: Map<string, string> | null = null;
  let size = 0;
  let offset: number | null = startxref;
  while (offset !== null) {
    if (seen.has(offset) || offset < 0 || offset >= pdf.length) throw new PdfEmbedError('the cross-reference chain is damaged');
    seen.add(offset);
    if (pdf.toString('latin1', offset, offset + 4) !== 'xref') throw new PdfEmbedError('the PDF uses a cross-reference stream, which this embedder does not read');
    const trailerAt = pdf.indexOf('trailer', offset, 'latin1');
    if (trailerAt < 0) throw new PdfEmbedError('the cross-reference table has no trailer');
    const toks = pdf.toString('latin1', offset + 4, trailerAt).trim().split(/\s+/);
    for (let k = 0; k < toks.length;) {
      const first = Number(toks[k++]);
      const count = Number(toks[k++]);
      if (!Number.isInteger(first) || !Number.isInteger(count)) throw new PdfEmbedError('malformed cross-reference table');
      for (let j = 0; j < count; j++) {
        const off = Number(toks[k++]);
        const gen = Number(toks[k++]);
        const type = toks[k++];
        const num = first + j;
        if (entries.has(num) || freed.has(num)) continue; // a newer section already decided this object
        if (type === 'n') entries.set(num, { offset: off, gen });
        else freed.add(num);
      }
    }
    const startAt = pdf.indexOf('startxref', trailerAt, 'latin1');
    const trailer = parseDict(pdf.toString('latin1', trailerAt + 7, startAt < 0 ? Math.min(pdf.length, trailerAt + 4096) : startAt));
    newest ??= trailer;
    size = Math.max(size, Number(trailer.get('Size') ?? 0));
    offset = trailer.has('Prev') ? Number(trailer.get('Prev')) : null;
  }
  return { entries, size: Math.max(size, ...[...entries.keys()].map((n) => n + 1)), trailer: newest!, startxref };
}

// The text of a small non-stream object ("<<…>>" or another value), or null if it is a stream or too large to be one.
function smallObject(pdf: Buffer, e: XrefEntry, num: number): string | null {
  const win = pdf.toString('latin1', e.offset, Math.min(pdf.length, e.offset + 4096));
  const m = /^\s*(\d+)\s+\d+\s+obj\s*([\s\S]*?)\s*endobj/.exec(win);
  if (!m || Number(m[1]) !== num || /\bstream\b/.test(m[2]!)) return null;
  return m[2]!;
}

const hexText = (s: string): string => `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
const literal = (s: string): string => `(${s.replace(/[\\()]/g, '\\$&')})`;

// ---- embedding ----

const ICON_SIZE = 24;
// A blue square with a white play triangle; stretched by the viewer to the annotation's rectangle.
const ICON = `q 0.12 0.37 0.66 rg 0 0 ${ICON_SIZE} ${ICON_SIZE} re f 1 1 1 rg 8 6 m 8 18 l 19 12 l f Q`;
// What a player shows before it is clicked: a dark 16:9 panel with a white play triangle (the report reserves a 16:9 box for it).
const POSTER_W = 160;
const POSTER_H = 90;
const POSTER = `q 0.09 0.13 0.2 rg 0 0 ${POSTER_W} ${POSTER_H} re f 1 1 1 rg 66 29 m 66 61 l 100 45 l f Q`;

// Page object number of every annotation listed in a page's /Annots (the Screen annotation names its page).
function annotationPages(pdf: Buffer, xref: Xref): Map<number, number> {
  const pages = new Map<number, number>();
  for (const [num, e] of xref.entries) {
    const text = smallObject(pdf, e, num);
    if (!text || !/\/Type\s*\/Page\b/.test(text)) continue;
    let annots: string | undefined;
    try { annots = parseDict(text).get('Annots'); } catch { continue; }
    const through = refNumber(annots);
    if (through !== null) {
      const target = xref.entries.get(through);
      annots = target ? smallObject(pdf, target, through) ?? undefined : undefined;
    }
    for (const m of annots?.matchAll(/(\d+)\s+\d+\s+R/g) ?? []) pages.set(Number(m[1]), num);
  }
  return pages;
}

export function embedFiles(pdf: Buffer, items: EmbedItem[]): EmbedResult {
  if (items.length === 0) return { pdf, embedded: 0, annotated: 0, players: 0, unplaced: [], attachmentList: true };
  const names = items.map((i) => safeName(i.fileName));
  if (new Set(names).size !== names.length) throw new PdfEmbedError('attachment file names must be unique');
  if (new Set(items.map((i) => i.token)).size !== items.length) throw new PdfEmbedError('attachment tokens must be unique');

  const xref = readXref(pdf);
  const rootNum = refNumber(xref.trailer.get('Root'));
  const rootEntry = rootNum === null ? undefined : xref.entries.get(rootNum);
  const rootText = rootNum === null || !rootEntry ? null : smallObject(pdf, rootEntry, rootNum);
  if (rootNum === null || !rootEntry || !rootText) throw new PdfEmbedError('the PDF catalog could not be read');
  const catalog = parseDict(rootText);

  const chunks: Buffer[] = [];
  let pos = pdf.length;
  const push = (b: Buffer | string) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    pos += buf.length;
  };
  const written = new Map<number, XrefEntry>();
  const object = (num: number, gen: number, body: Buffer | string) => {
    written.set(num, { offset: pos, gen });
    push(`${num} ${gen} obj\n`);
    push(body);
    push('\nendobj\n');
  };
  push(pdf[pdf.length - 1] === 0x0a ? '' : '\n');

  // New objects: the shared icon, then a stream and a file specification per file.
  let next = xref.size;
  const iconNum = next++;
  object(iconNum, 0, `<</Type /XObject /Subtype /Form /BBox [0 0 ${ICON_SIZE} ${ICON_SIZE}] /Resources <<>> /Length ${ICON.length}>>\nstream\n${ICON}\nendstream`);
  const posterNum = items.some((i) => i.inline) ? next++ : null;
  if (posterNum !== null) {
    object(posterNum, 0, `<</Type /XObject /Subtype /Form /BBox [0 0 ${POSTER_W} ${POSTER_H}] /Resources <<>> /Length ${POSTER.length}>>\nstream\n${POSTER}\nendstream`);
  }
  const specs: { token: string; name: string; item: EmbedItem; spec: number; rendition: number | null }[] = [];
  items.forEach((item, n) => {
    const stream = next++;
    const spec = next++;
    let md5 = '';
    try { md5 = ` /CheckSum <${createHash('md5').update(item.data).digest('hex')}>`; } catch { /* md5 unavailable (FIPS mode): the checksum is optional */ }
    const mime = item.mime.replace(/[^A-Za-z0-9.+\-/]/g, '').replace('/', '#2F');
    object(stream, 0, Buffer.concat([
      Buffer.from(`<</Type /EmbeddedFile /Subtype /${mime} /Params <</Size ${item.data.length}${md5}>> /Length ${item.data.length}>>\nstream\n`, 'latin1'),
      item.data,
      Buffer.from('\nendstream', 'latin1'),
    ]));
    object(spec, 0, `<</Type /Filespec /F ${literal(names[n]!)} /UF ${hexText(names[n]!)} /Desc ${hexText(item.description)} /EF <</F ${stream} 0 R /UF ${stream} 0 R>>>>`);
    // A clip that points at the stored file and a rendition that plays it inside the annotation (window type 3 = "the screen
    // annotation"); the permission lets the viewer hand the bytes to its media player through a temporary file.
    let rendition: number | null = null;
    if (item.inline) {
      const clip = next++;
      rendition = next++;
      const cleanMime = item.mime.replace(/[^A-Za-z0-9.+\-/]/g, '');
      object(clip, 0, `<</Type /MediaClip /S /MCD /N ${literal(names[n]!)} /CT ${literal(cleanMime)} /D ${spec} 0 R /P <</TF (TEMPACCESS)>>>>`);
      object(rendition, 0, `<</Type /Rendition /S /MR /N ${literal(names[n]!)} /C ${clip} 0 R /P <</Type /MediaPlayParams /BE <</C true /A true /F 0>>>> /SP <</Type /MediaScreenParams /BE <</W 3>>>>>>`);
    }
    specs.push({ token: item.token, name: names[n]!, item, spec, rendition });
  });
  const pageOf = items.some((i) => i.inline) ? annotationPages(pdf, xref) : new Map<number, number>();

  // Swap each marked Link annotation for a FileAttachment annotation at the same place (same object number). The superseded Link
  // objects stay in the file as unreachable bytes; their addresses (the builder's local paths) are blanked in place, same length.
  const placed = new Set<string>();
  const scrub: { from: number; to: number }[] = [];
  let annotated = 0;
  let players = 0;
  for (const [num, e] of xref.entries) {
    const text = smallObject(pdf, e, num);
    if (!text || !/\/Subtype\s*\/Link\b/.test(text) || !text.includes('#evidence-')) continue;
    const dict = parseDict(text);
    const action = dict.get('A');
    const uriRaw = action && action.trim().startsWith('<<') ? parseDict(action).get('URI') : undefined;
    const uri = uriRaw && uriRaw.trim().startsWith('(') ? decodeLiteral(uriRaw) : '';
    const hit = specs.find((s) => uri.endsWith(`#${s.token}`));
    const rect = dict.get('Rect');
    if (!hit || !rect) continue;
    if (hit.rendition !== null && posterNum !== null) {
      const page = pageOf.get(num);
      object(num, e.gen, `<</Type /Annot /Subtype /Screen /F 4 /Rect ${rect}${page === undefined ? '' : ` /P ${page} 0 R`} /Contents ${hexText(hit.item.description)} `
        + `/AP <</N ${posterNum} 0 R>> /A <</Type /Action /S /Rendition /OP 0 /R ${hit.rendition} 0 R /AN ${num} 0 R>>>>`);
      players++;
    } else {
      object(num, e.gen, `<</Type /Annot /Subtype /FileAttachment /F 4 /Rect ${rect} /Name /PushPin /C [0.12 0.37 0.66] /Contents ${hexText(hit.item.description)} /FS ${hit.spec} 0 R /AP <</N ${iconNum} 0 R>>>>`);
    }
    placed.add(hit.token);
    annotated++;
    const at = pdf.indexOf(uriRaw!, e.offset, 'latin1');
    if (at >= 0) scrub.push({ from: at + 1, to: at + uriRaw!.length - 1 }); // inside the parentheses
  }

  // Attachments panel: /Names /EmbeddedFiles. An existing /Names is not merged (it is rare in Chromium output); say so instead.
  const attachmentList = !catalog.has('Names');
  if (attachmentList) {
    const sorted = [...specs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const tree = `/Names <</EmbeddedFiles <</Names [${sorted.map((s) => `${literal(s.name)} ${s.spec} 0 R`).join(' ')}]>>>>`;
    const end = rootText.lastIndexOf('>>');
    object(rootNum, rootEntry.gen, `${rootText.slice(0, end).trimEnd()}\n${tree}>>`);
  }

  // The update's own cross-reference section and trailer.
  const xrefAt = pos;
  const nums = [...written.keys()].sort((a, b) => a - b);
  let table = 'xref\n';
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    table += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const w = written.get(nums[k]!)!;
      table += `${String(w.offset).padStart(10, '0')} ${String(w.gen).padStart(5, '0')} n \n`;
    }
    i = j + 1;
  }
  const info = xref.trailer.get('Info');
  const id = xref.trailer.get('ID');
  push(`${table}trailer\n<</Size ${next} /Root ${rootNum} 0 R${info ? ` /Info ${info}` : ''}${id ? ` /ID ${id}` : ''} /Prev ${xref.startxref}>>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = Buffer.concat([pdf, ...chunks]);
  for (const r of scrub) out.fill(0x78, r.from, r.to); // "x"
  return {
    pdf: out, embedded: items.length, annotated, players,
    unplaced: items.filter((i) => !placed.has(i.token)).map((i) => i.token), attachmentList,
  };
}

// ---- verification ----

// Reads the files stored in a PDF the way a viewer finds them: through the catalog's /Names /EmbeddedFiles tree and through
// FileAttachment annotations. Returns each file's size and SHA-256 over the bytes actually inside the PDF.
// `players` lists the Screen annotations that play a stored clip inside the page, each with the name of the file it plays (followed
// from the annotation's Rendition action through the rendition and media clip to the file specification).
export function listEmbeddedFiles(pdf: Buffer): { files: EmbeddedFileInfo[]; annotations: number; players: { name: string | null }[] } {
  const xref = readXref(pdf);
  const get = (num: number | null): string | null => {
    const e = num === null ? undefined : xref.entries.get(num);
    return num === null || !e ? null : smallObject(pdf, e, num);
  };
  const asDict = (v: string | undefined): Map<string, string> | null => {
    if (!v) return null;
    const n = refNumber(v);
    const text = n === null ? v : get(n);
    return text && text.trim().startsWith('<<') ? parseDict(text) : null;
  };
  const specs = new Map<number, string>(); // filespec object -> name from the tree (or '' when found through an annotation)

  const catalog = asDict(xref.trailer.get('Root'));
  const tree = asDict(asDict(catalog?.get('Names') ?? undefined)?.get('EmbeddedFiles'));
  const pairs = tree?.get('Names');
  if (pairs) {
    const inner = pairs.trim().slice(1, -1);
    for (let i = 0; i < inner.length;) {
      i = skipSpace(inner, i);
      if (i >= inner.length) break;
      const keyEnd = valueEnd(inner, i);
      const valEnd = valueEnd(inner, keyEnd);
      const spec = refNumber(inner.slice(keyEnd, valEnd).trim());
      if (spec !== null) specs.set(spec, decodeLiteral(inner.slice(i, keyEnd)));
      i = valEnd;
    }
  }

  let annotations = 0;
  const players: { name: string | null }[] = [];
  for (const [num, e] of xref.entries) {
    const text = smallObject(pdf, e, num);
    if (!text) continue;
    if (/\/Subtype\s*\/Screen\b/.test(text) && text.includes('/Rendition')) {
      const action = asDict(parseDict(text).get('A'));
      const clip = asDict(asDict(action?.get('R'))?.get('C'));
      const specNum = refNumber(clip?.get('D'));
      const file = asDict(clip?.get('D'));
      players.push({ name: file?.get('F') ? decodeLiteral(file.get('F')!) : null });
      if (specNum !== null && !specs.has(specNum)) specs.set(specNum, '');
      continue;
    }
    if (!/\/Subtype\s*\/FileAttachment\b/.test(text)) continue;
    annotations++;
    const fs = refNumber(parseDict(text).get('FS'));
    if (fs !== null && !specs.has(fs)) specs.set(fs, '');
  }

  const files: EmbeddedFileInfo[] = [];
  for (const [specNum, treeName] of specs) {
    const spec = asDict(`${specNum} 0 R`);
    const ef = asDict(spec?.get('EF'));
    const streamNum = refNumber(ef?.get('F'));
    const entry = streamNum === null ? undefined : xref.entries.get(streamNum);
    if (!spec || streamNum === null || !entry) continue;
    const head = pdf.toString('latin1', entry.offset, Math.min(pdf.length, entry.offset + 2048));
    const open = /^\s*\d+\s+\d+\s+obj\s*/.exec(head);
    if (!open) continue;
    const dictText = head.slice(open[0].length);
    const dict = parseDict(dictText);
    const afterDict = open[0].length + valueEnd(dictText, 0);
    const kw = /^\s*stream\r?\n/.exec(head.slice(afterDict));
    const length = Number(dict.get('Length'));
    if (!kw || !Number.isInteger(length)) continue;
    const start = entry.offset + afterDict + kw[0].length;
    const data = pdf.subarray(start, start + length);
    const name = spec.get('F') ? decodeLiteral(spec.get('F')!) : treeName;
    files.push({ name, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), mime: dict.get('Subtype')?.replace(/^\//, '').replace('#2F', '/') ?? null });
  }
  return { files, annotations, players };
}

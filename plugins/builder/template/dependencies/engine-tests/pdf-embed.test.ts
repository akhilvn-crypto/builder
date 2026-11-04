// pdf-embed: files are stored inside an existing PDF through an appended update; the printed pages are never rewritten.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PdfEmbedError, embedFiles, listEmbeddedFiles, type EmbedItem } from '../engine/pipeline/pdf-embed.ts';
import { pdfWithLinks } from './pdf-fixture.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const item = (n: number, over: Partial<EmbedItem> = {}): EmbedItem => ({
  token: `evidence-video-${n}`, fileName: `TC-${n}.webm`, description: `Execution video ${n}`, mime: 'video/webm', data: Buffer.alloc(5000, n), ...over,
});
const link = (n: number) => `file:///C:/work/test-results/tc${n}/video.webm#evidence-video-${n}`;

test('every file is stored in the PDF, readable back byte for byte, and its link becomes an attachment icon', () => {
  const original = pdfWithLinks([link(1), link(2)]);
  const items = [item(1), item(2)];
  const r = embedFiles(original, items);
  assert.deepEqual([r.embedded, r.annotated, r.unplaced, r.attachmentList], [2, 2, [], true]);

  const back = listEmbeddedFiles(r.pdf);
  assert.equal(back.annotations, 2);
  assert.deepEqual(back.files.map((f) => [f.name, f.size, f.sha256, f.mime]).sort(), items.map((i) => [i.fileName, i.data.length, sha(i.data), 'video/webm']).sort());
  assert.ok(r.pdf.includes(items[0]!.data), 'the bytes are inside the PDF');

  const text = r.pdf.toString('latin1');
  assert.ok(!text.includes('C:/work'), 'the superseded links no longer carry the builder\'s local paths');
  assert.equal([...text.matchAll(/\/Subtype \/FileAttachment/g)].length, 2);
  assert.match(text, /\/Rect \[10 700 30 720\]/, 'the icon takes the link\'s place on the page');
});

test('the update is appended: the original bytes are untouched (bar the blanked link addresses) and a new cross-reference section chains to the old one', () => {
  const original = pdfWithLinks([link(1)]);
  const r = embedFiles(original, [item(1)]);
  const blanked = Buffer.from(original.toString('latin1').replace(/\(file:\/\/\/[^)]*\)/g, (m) => `(${'x'.repeat(m.length - 2)})`), 'latin1');
  assert.ok(r.pdf.subarray(0, original.length).equals(blanked), 'the printed report is a byte-for-byte prefix, with only the dead link addresses overwritten by x');
  const tail = r.pdf.toString('latin1', original.length);
  assert.match(tail, new RegExp(`/Prev ${original.toString('latin1').match(/startxref\s+(\d+)/)![1]}`));
  const start = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail)![1]);
  assert.equal(r.pdf.toString('latin1', start, start + 4), 'xref', 'startxref points at the new section');
  // Every entry of the new section points at the object it names.
  for (const m of tail.slice(start - original.length).matchAll(/^(\d+) 1\n(\d{10}) 00000 n /gm)) {
    assert.ok(r.pdf.toString('latin1', Number(m[2]), Number(m[2]) + 12).startsWith(`${m[1]} 0 obj`), `object ${m[1]} sits at its offset`);
  }
});

test('a second update on top of the first still reads back (cross-reference chains)', () => {
  const first = embedFiles(pdfWithLinks([link(1), link(2)]), [item(1)]);
  assert.deepEqual(first.unplaced, []);
  const second = embedFiles(first.pdf, [item(2)]);
  assert.equal(second.attachmentList, false, 'the catalog already has /Names from the first update, which is not merged');
  assert.deepEqual(second.unplaced, []);
  const names = listEmbeddedFiles(second.pdf).files.map((f) => f.name).sort();
  assert.deepEqual(names, ['TC-1.webm', 'TC-2.webm'], 'the second file is still found through its page icon');
});

test('a link nobody asked for is left alone, and a file without a link is attached and reported', () => {
  const r = embedFiles(pdfWithLinks(['https://example.com/docs', link(1)]), [item(1), item(7)]);
  assert.equal(r.annotated, 1);
  assert.deepEqual(r.unplaced, ['evidence-video-7']);
  const text = r.pdf.toString('latin1');
  assert.match(text, /https:\/\/example\.com\/docs/, 'ordinary links survive');
  assert.deepEqual(listEmbeddedFiles(r.pdf).files.map((f) => f.name).sort(), ['TC-1.webm', 'TC-7.webm'], 'still stored and listed in the Attachments panel');
});

test('file names are made safe, and data that looks like PDF syntax does not confuse the reader', () => {
  const tricky = Buffer.from('endstream\nendobj\n99 0 obj\n<</Type /Catalog>>\nstartxref\n0\n%%EOF\n');
  const r = embedFiles(pdfWithLinks([link(1)]), [item(1, { fileName: 'TC 1/ünï (attempt).webm', data: tricky })]);
  const [f] = listEmbeddedFiles(r.pdf).files;
  assert.equal(f!.name, 'TC_1__n___attempt_.webm');
  assert.equal(f!.sha256, sha(tricky));
});

test('names must be unique, and unsupported or damaged PDFs are refused rather than guessed at', () => {
  const pdf = pdfWithLinks([link(1), link(2)]);
  assert.throws(() => embedFiles(pdf, [item(1), item(2, { fileName: 'TC-1.webm' })]), PdfEmbedError);
  assert.throws(() => embedFiles(pdf, [item(1), item(1, { fileName: 'other.webm' })]), PdfEmbedError);
  assert.throws(() => embedFiles(pdfWithLinks([link(1)], { xrefStream: true }), [item(1)]), /cross-reference stream/);
  assert.throws(() => embedFiles(Buffer.from('%PDF-1.4\nnothing else'), [item(1)]), /no startxref/);
  assert.throws(() => embedFiles(pdf.subarray(0, pdf.length - 40), [item(1)]), PdfEmbedError);
  assert.equal(embedFiles(pdf, []).pdf, pdf, 'nothing to embed: the PDF is returned as it is');
});

test('an existing /Names entry is left alone and reported; the page icons still carry the files', () => {
  const r = embedFiles(pdfWithLinks([link(1)], { extraCatalog: '/Names <</Dests 9 0 R>>' }), [item(1)]);
  assert.equal(r.attachmentList, false);
  assert.equal(r.annotated, 1);
  assert.deepEqual(listEmbeddedFiles(r.pdf).files.map((f) => f.name), ['TC-1.webm']);
});

test('an inline item becomes a Screen annotation with a Rendition action that plays the stored MP4 inside the page', () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(3000, 7)]);
  const r = embedFiles(pdfWithLinks([link(1), link(2)]), [
    item(1, { fileName: 'TC-1.mp4', mime: 'video/mp4', data: mp4, inline: true }),
    item(2), // stays an attachment next to it
  ]);
  assert.deepEqual([r.embedded, r.annotated, r.players, r.unplaced], [2, 2, 1, []]);

  const back = listEmbeddedFiles(r.pdf);
  assert.deepEqual(back.players, [{ name: 'TC-1.mp4' }], 'annotation -> action -> rendition -> media clip -> file specification');
  assert.equal(back.annotations, 1, 'the other video is still a file-attachment icon');
  assert.deepEqual(back.files.map((f) => [f.name, f.mime, f.sha256]).sort(), [['TC-1.mp4', 'video/mp4', sha(mp4)], ['TC-2.webm', 'video/webm', sha(item(2).data)]]);

  const text = r.pdf.toString('latin1');
  assert.match(text, /\/Subtype \/Screen/);
  assert.match(text, /\/S \/Rendition \/OP 0 \/R \d+ 0 R \/AN \d+ 0 R/);
  assert.match(text, /\/Type \/MediaClip \/S \/MCD \/N \(TC-1\.mp4\) \/CT \(video\/mp4\) \/D \d+ 0 R/);
  assert.match(text, /\/W 3/, 'plays in the annotation\'s own rectangle');
  assert.match(text, /\/P 3 0 R/, 'the annotation names its page');
  assert.match(text, /\/Rect \[10 700 30 720\]/, 'the player takes the link\'s place');
  assert.ok(!text.includes('C:/work'), 'the builder\'s local paths are gone');
  assert.ok(r.pdf.includes(mp4), 'the MP4 bytes are inside the PDF');
});

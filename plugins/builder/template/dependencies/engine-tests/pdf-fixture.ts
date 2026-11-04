// Builds small but structurally real PDFs for the embedding tests: a classic cross-reference table and plain dictionaries, the
// same layout Chromium's PDF backend (Skia) writes.

export interface PdfOptions {
  extraCatalog?: string; // appended to the catalog dictionary, e.g. "/Names << >>"
  xrefStream?: boolean; // end the file with a cross-reference *stream* section instead of a table
}

// A one-page PDF with a Link annotation per URI (object 4 and up).
export function pdfWithLinks(uris: string[], o: PdfOptions = {}): Buffer {
  const annots = uris.map((_, n) => `${4 + n} 0 R`).join(' ');
  const bodies = [
    `<</Type /Catalog /Pages 2 0 R${o.extraCatalog ? ` ${o.extraCatalog}` : ''}>>`,
    '<</Type /Pages /Count 1 /Kids [3 0 R]>>',
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 595.92 842.88] /Annots [${annots}]>>`,
    ...uris.map((u, n) => `<</Type /Annot\n/Subtype /Link\n/F 4\n/Border [0 0 0]\n/Rect [${10 + n * 30} 700 ${30 + n * 30} 720]\n/A <</Type /Action\n/S /URI\n/URI (${u.replace(/[\\()]/g, '\\$&')})>>>>`),
  ];
  let out = '%PDF-1.4\n%\xd3\xeb\xe9\xe1\n';
  const offsets: number[] = [];
  bodies.forEach((b, n) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${n + 1} 0 obj\n${b}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  if (o.xrefStream) {
    out += `${bodies.length + 1} 0 obj\n<</Type /XRef /Size ${bodies.length + 2} /W [1 4 1] /Root 1 0 R /Length 0>>\nstream\n\nendstream\nendobj\n`;
  } else {
    out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<</Size ${bodies.length + 1}\n/Root 1 0 R>>\n`;
  }
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

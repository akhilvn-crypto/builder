// Markdown pipe tables ("| ID | Title | Steps |") read into the same row shape a CSV or worksheet gives, so the one column-mapping
// and table-parsing path (input-table.ts, test-case-parser.ts) serves all three formats.

import type { TableRow } from './input-table.ts';

export const isTableLine = (line: string): boolean => line.trim().startsWith('|');

const SEPARATOR = /^\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?$/;

// "a \| b | c<br>d" -> ["a | b", "c\nd"]
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') { cell += '|'; i++; }
    else if (ch === '|') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.replace(/<br\s*\/?>/gi, '\n').trim());
}

// Rows of one table block (consecutive pipe lines starting at `start`, a 0-based index into `lines`), without the separator
// line. `line` of each row is the 1-based Markdown line, so a case read from a table row keeps its source location.
export function readTableBlock(lines: string[], start: number): { rows: TableRow[]; next: number } {
  const rows: TableRow[] = [];
  let i = start;
  for (; i < lines.length && isTableLine(lines[i]!); i++) {
    const text = lines[i]!.trim();
    if (SEPARATOR.test(text) && text.includes('-')) continue;
    const cells = splitCells(text);
    if (cells.some((c) => c !== '')) rows.push({ line: i + 1, cells });
  }
  return { rows, next: i };
}

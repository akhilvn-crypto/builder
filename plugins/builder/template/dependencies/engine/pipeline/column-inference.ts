// Content-based reading of table columns whose header the built-in names do not recognise. It looks at what a column holds
// (numbered lists, imperative verbs, "should be shown" wording, ID-shaped values) and proposes which field it is, with a
// confidence. Nothing is guessed silently: only a proposal at or above AUTO_APPLY_CONFIDENCE is applied (and reported as an
// inferred column); everything else is offered as a suggestion for a person to confirm with `input map`.
// Output carries headers, field names and counts, never cell values, because test cases can contain credentials.

import type { Field, TableRow } from './input-table.ts';

export const AUTO_APPLY_CONFIDENCE = 0.9; // steps, expected and id only: a title is never applied from content alone
export const SUGGEST_CONFIDENCE = 0.6;
const SAMPLE_ROWS = 200;

export interface ColumnSuggestion {
  field: Field;
  header: string;
  index: number;
  confidence: number; // 0..1
  reason: string; // what about the column's content points to this field (no cell values)
}

const LIST_MARKER = /^\s*(?:step\s*\d+\s*[-–:.)]?|\d+\s*[.):]|[-*•])\s*\S/im;
const IMPERATIVE = /^\W*(?:\d+\s*[.):]\s*)?(?:click|tap|press|enter|type|select|choose|open|navigate|go to|log ?in|login|sign ?in|sign ?up|fill|submit|verify|check|visit|launch|scroll|hover|upload|download|search|enable|disable|toggle|add|create|delete|remove|edit|save|close|expand|collapse)\b/i;
const OUTCOME = /\b(?:should|shall|must|will|is|are|gets?|displayed|shown|appears?|visible|redirect(?:ed|s)?|errors?|success(?:fully|ful)?|messages?|navigates?|opens?|enabled|disabled|created|saved|updated|deleted|allowed|blocked)\b/i;
const ID_LIKE = /^[A-Za-z]{0,10}[-_ ]?\d{1,6}$/;

function ratio(values: string[], test: (v: string) => boolean): number {
  return values.length === 0 ? 0 : values.filter(test).length / values.length;
}

const round = (n: number): number => Math.round(n * 100) / 100;

// Proposes fields for the columns no header name claimed, for the fields still missing. A column is proposed for at most one field.
export function suggestColumns(rows: TableRow[], headerIndex: number, claimed: ReadonlySet<number>, missing: readonly Field[]): ColumnSuggestion[] {
  const header = rows[headerIndex]?.cells ?? [];
  const body = rows.slice(headerIndex + 1, headerIndex + 1 + SAMPLE_ROWS);
  const all: ColumnSuggestion[] = [];

  header.forEach((h, index) => {
    const name = h.trim();
    if (name === '' || claimed.has(index)) return;
    const values = body.map((r) => (r.cells[index] ?? '').trim()).filter(Boolean);
    if (values.length < 2) return; // too little content to read anything from
    const listLike = ratio(values, (v) => LIST_MARKER.test(v) || v.split(/\r?\n/).filter((l) => l.trim()).length >= 2);
    const imperative = ratio(values, (v) => IMPERATIVE.test(v.split(/\r?\n/)[0] ?? ''));
    const outcome = ratio(values, (v) => OUTCOME.test(v));
    const idShaped = ratio(values, (v) => ID_LIKE.test(v));
    const unique = new Set(values.map((v) => v.toLowerCase())).size / values.length;
    const shortSingle = ratio(values, (v) => v.length <= 120 && !/\n/.test(v) && !/^\d+$/.test(v));

    const steps = Math.max(listLike, imperative) * (1 - 0.5 * Math.max(0, outcome - imperative));
    // Expected-result wording is outcome wording that does not start with an instruction.
    const expected = outcome * (1 - imperative);
    const id = idShaped * unique;
    const title = Math.min(0.85, unique * shortSingle * (1 - idShaped));

    const push = (field: Field, confidence: number, reason: string) => {
      if (missing.includes(field) && confidence >= SUGGEST_CONFIDENCE) all.push({ field, header: name, index, confidence: round(confidence), reason });
    };
    push('steps', steps, `${Math.round(Math.max(listLike, imperative) * 100)}% of its cells are numbered/multi-line lists or start with an instruction verb`);
    push('expected', expected, `${Math.round(outcome * 100)}% of its cells read as outcomes ("should", "is shown", "error", ...) rather than instructions`);
    push('id', id, `${Math.round(idShaped * 100)}% of its values look like IDs and ${Math.round(unique * 100)}% are unique`);
    push('title', title, `short, single-line, ${Math.round(unique * 100)}% unique values`);
  });

  // Best proposal per field, then each column used once (highest confidence wins it).
  const chosen: ColumnSuggestion[] = [];
  for (const s of [...all].sort((a, b) => b.confidence - a.confidence)) {
    if (chosen.some((c) => c.field === s.field || c.index === s.index)) continue;
    chosen.push(s);
  }
  return chosen.sort((a, b) => a.index - b.index);
}

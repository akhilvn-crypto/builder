// A small YAML reader for Maestro flows (no dependencies).
//
// Supported: comments, multi-document files separated by `---`, block mappings and sequences (including `- key: value`
// compact maps), quoted and plain scalars, single- and multi-line flow collections ([a, b], {a: b}), block scalars (| and >).
// Not supported (reported as `unsupported`, never guessed): anchors/aliases (&, *), tags (!), complex keys (?),
// multi-line quoted or plain scalars. Indentation by tabs and duplicate keys are errors, as in YAML itself.
//
// Values are plain JS (objects, arrays, strings, numbers, booleans, null). Line numbers are kept on the side:
// lineOfKey(map, key) and lineOfItem(list, index), so validators can report file:line.

export class YamlError extends Error {
  constructor(message, line, unsupported = false) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line ?? null;
    this.unsupported = unsupported;
  }
}

const META = new WeakMap();
export const lineOfKey = (map, key) => META.get(map)?.keys?.[key] ?? META.get(map)?.line ?? null;
export const lineOfItem = (list, i) => META.get(list)?.items?.[i] ?? META.get(list)?.line ?? null;
export const lineOf = (node) => META.get(node)?.line ?? null;

const OPEN_PREV = new Set([':', '-', '[', '{', ',']);

/** Remove a trailing comment (a # at line start or after whitespace, outside quotes). */
function stripComment(text) {
  let quote = null;
  let prev = null; // previous non-space character
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i += 1; continue; }
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i += 1; continue; }
        quote = null; prev = c;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (prev === null || OPEN_PREV.has(prev))) { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
    if (!/\s/.test(c)) prev = c;
  }
  return text;
}

/** Index of the `:` that separates a key from its value, or -1. */
function findKeyColon(s) {
  let quote = null;
  let depth = 0;
  let prev = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i += 1; continue; }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { i += 1; continue; }
        quote = null; prev = c;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (prev === null || OPEN_PREV.has(prev))) { quote = c; continue; }
    if (c === '[' || c === '{') { if (i === 0) return -1; depth += 1; }
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ':' && depth <= 0 && (i === s.length - 1 || /\s/.test(s[i + 1]))) return i;
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

function unquote(raw, line) {
  const q = raw[0];
  let out = '';
  let i = 1;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (q === '"' && c === '\\') {
      const n = raw[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0', ' ': ' ' };
      if (n === 'u') { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)); i += 5; continue; }
      if (n in map) { out += map[n]; i += 1; continue; }
      throw new YamlError(`unknown escape \\${n} in double-quoted string`, line);
    }
    if (c === q) {
      if (q === "'" && raw[i + 1] === "'") { out += "'"; i += 1; continue; }
      break;
    }
    out += c;
  }
  if (raw[i] !== q) throw new YamlError('unterminated quoted string (multi-line quoted strings are not supported)', line, true);
  const rest = raw.slice(i + 1).trim();
  if (rest) throw new YamlError(`unexpected text after quoted string: ${rest.slice(0, 30)}`, line);
  return out;
}

function plainScalar(s) {
  if (s === '' || s === '~' || /^null$/i.test(s)) return null;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^[-+]?\d+$/.test(s) && Math.abs(Number(s)) <= Number.MAX_SAFE_INTEGER && !/^[-+]?0\d/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function checkIndicator(s, line) {
  const c = s[0];
  if (c === '&' || c === '*') throw new YamlError('anchors and aliases are not supported', line, true);
  if (c === '!') throw new YamlError('tags are not supported', line, true);
  if (c === '?' && /^\?(\s|$)/.test(s)) throw new YamlError('complex keys are not supported', line, true);
  if (c === '@' || c === '`') throw new YamlError(`a plain value cannot start with "${c}" (quote it)`, line);
}

class FlowReader {
  constructor(text, line) { this.s = text; this.i = 0; this.line = line; }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1; }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === '"' || c === "'") return this.quoted();
    return this.plain();
  }
  quoted() {
    const q = this.s[this.i];
    let j = this.i + 1;
    for (; j < this.s.length; j++) {
      if (q === '"' && this.s[j] === '\\') { j += 1; continue; }
      if (this.s[j] === q) { if (q === "'" && this.s[j + 1] === "'") { j += 1; continue; } break; }
    }
    if (this.s[j] !== q) throw new YamlError('unterminated quoted string', this.line, true);
    const raw = this.s.slice(this.i, j + 1);
    this.i = j + 1;
    return unquote(raw, this.line);
  }
  plain() {
    const start = this.i;
    while (this.i < this.s.length && !',]}'.includes(this.s[this.i])) {
      if (this.s[this.i] === ':' && (this.i + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.i + 1]))) break;
      this.i += 1;
    }
    const text = this.s.slice(start, this.i).trim();
    if (text) checkIndicator(text, this.line);
    return plainScalar(text);
  }
  seq() {
    this.i += 1;
    const out = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new YamlError('flow sequence is not closed', this.line);
      if (this.s[this.i] === ']') { this.i += 1; break; }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i += 1;
      else if (this.s[this.i] !== ']') throw new YamlError(`expected "," or "]" in flow sequence`, this.line);
    }
    META.set(out, { line: this.line, items: out.map(() => this.line) });
    return out;
  }
  map() {
    this.i += 1;
    const out = {};
    const keys = {};
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) throw new YamlError('flow mapping is not closed', this.line);
      if (this.s[this.i] === '}') { this.i += 1; break; }
      const key = String(this.value());
      this.ws();
      if (this.s[this.i] !== ':') throw new YamlError(`expected ":" after key "${key}" in flow mapping`, this.line);
      this.i += 1;
      if (key in out) throw new YamlError(`duplicate key "${key}"`, this.line);
      this.ws();
      out[key] = (this.s[this.i] === ',' || this.s[this.i] === '}') ? null : this.value();
      keys[key] = this.line;
      this.ws();
      if (this.s[this.i] === ',') this.i += 1;
      else if (this.s[this.i] !== '}') throw new YamlError(`expected "," or "}" in flow mapping`, this.line);
    }
    META.set(out, { line: this.line, keys });
    return out;
  }
}

function flowBalanced(text) {
  let depth = 0;
  let quote = null;
  let prev = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i += 1; continue; }
      if (c === quote) { if (quote === "'" && text[i + 1] === "'") { i += 1; continue; } quote = null; }
      continue;
    }
    if ((c === '"' || c === "'") && (prev === null || OPEN_PREV.has(prev))) { quote = c; continue; }
    if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    if (!/\s/.test(c)) prev = c;
  }
  return depth <= 0;
}

function parseDocument(rawLines) {
  // rawLines: [{ raw, no }]
  const content = [];
  rawLines.forEach((l, idx) => {
    if (/^\s*\t/.test(l.raw) && l.raw.trim() !== '' && !l.raw.trim().startsWith('#')) {
      throw new YamlError('tabs cannot be used for indentation', l.no);
    }
    const noComment = stripComment(l.raw).replace(/\s+$/, '');
    if (noComment.trim() === '') return;
    const indent = noComment.length - noComment.trimStart().length;
    content.push({ indent, text: noComment.trim(), no: l.no, idx });
  });
  if (content.length === 0) return { value: null, line: null };

  let pos = 0;
  const cur = () => content[pos];

  function scalarFromText(text, line) {
    checkIndicator(text, line);
    if (text[0] === '"' || text[0] === "'") return unquote(text, line);
    return plainScalar(text);
  }

  function valueFromText(text, line, parentIndent) {
    if (text[0] === '[' || text[0] === '{') {
      let joined = text;
      while (!flowBalanced(joined)) {
        pos += 1;
        if (pos >= content.length) throw new YamlError('flow collection is not closed', line);
        joined += ` ${content[pos].text}`;
      }
      const reader = new FlowReader(joined, line);
      const v = reader.value();
      reader.ws();
      if (reader.i < joined.length) throw new YamlError(`unexpected text after flow collection: ${joined.slice(reader.i, reader.i + 30)}`, line);
      return v;
    }
    if (/^[|>][+-]?\d*[+-]?$/.test(text)) return blockScalar(text, parentIndent);
    return scalarFromText(text, line);
  }

  function blockScalar(indicator, parentIndent) {
    const startIdx = content[pos].idx;
    const lines = [];
    let last = startIdx;
    let blockIndent = null;
    for (let i = startIdx + 1; i < rawLines.length; i++) {
      const raw = rawLines[i].raw;
      if (raw.trim() === '') { lines.push(''); last = i; continue; }
      const ind = raw.length - raw.trimStart().length;
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      lines.push(raw.slice(Math.min(blockIndent, ind)));
      last = i;
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    while (pos + 1 < content.length && content[pos + 1].idx <= last) pos += 1;
    const folded = indicator[0] === '>';
    return folded ? lines.join(' ').replace(/ {2,}/g, ' ') : lines.join('\n');
  }

  function parseBlock(indent) {
    const line = cur();
    if (line.text === '-' || line.text.startsWith('- ')) return parseSeq(indent);
    return parseMap(indent);
  }

  function parseSeq(indent) {
    const out = [];
    const items = [];
    const startLine = cur().no;
    while (pos < content.length && cur().indent === indent && (cur().text === '-' || cur().text.startsWith('- '))) {
      const line = cur();
      const rest = line.text.slice(1).trimStart();
      const offset = line.text.length - rest.length;
      items.push(line.no);
      if (rest === '') {
        pos += 1;
        if (pos < content.length && cur().indent > indent) out.push(parseBlock(cur().indent));
        else out.push(null);
        continue;
      }
      if (rest === '-' || rest.startsWith('- ')) {
        content[pos] = { ...line, indent: indent + offset, text: rest };
        out.push(parseSeq(indent + offset));
        continue;
      }
      if (rest[0] !== '[' && rest[0] !== '{' && findKeyColon(rest) !== -1) {
        content[pos] = { ...line, indent: indent + offset, text: rest };
        out.push(parseMap(indent + offset));
        continue;
      }
      out.push(valueFromText(rest, line.no, indent));
      pos += 1;
    }
    META.set(out, { line: startLine, items });
    return out;
  }

  function parseMap(indent) {
    const out = {};
    const keys = {};
    const startLine = cur().no;
    while (pos < content.length && cur().indent === indent) {
      const line = cur();
      if (line.text === '-' || line.text.startsWith('- ')) break;
      const colon = findKeyColon(line.text);
      if (colon === -1) throw new YamlError(`expected "key: value" but found "${line.text.slice(0, 40)}"`, line.no);
      const rawKey = line.text.slice(0, colon).trim();
      checkIndicator(rawKey, line.no);
      const key = (rawKey[0] === '"' || rawKey[0] === "'") ? unquote(rawKey, line.no) : rawKey;
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      const rest = line.text.slice(colon + 1).trim();
      keys[key] = line.no;
      if (rest === '') {
        pos += 1;
        if (pos < content.length && cur().indent > indent) out[key] = parseBlock(cur().indent);
        else if (pos < content.length && cur().indent === indent && (cur().text === '-' || cur().text.startsWith('- '))) out[key] = parseSeq(indent);
        else out[key] = null;
        continue;
      }
      out[key] = valueFromText(rest, line.no, indent);
      pos += 1;
    }
    META.set(out, { line: startLine, keys });
    return out;
  }

  const first = cur();
  const value = parseBlock(first.indent);
  if (pos < content.length) {
    throw new YamlError(`unexpected content or indentation: "${cur().text.slice(0, 40)}"`, cur().no);
  }
  return { value, line: first.no };
}

/**
 * Parse a file that may hold several `---`-separated documents.
 * Returns { documents: [{ value, line }], separators } where `separators` counts the `---` lines.
 */
export function parseYamlStream(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const groups = [[]];
  let separators = 0;
  lines.forEach((raw, i) => {
    if (/^---\s*(#.*)?$/.test(raw)) { separators += 1; groups.push([]); return; }
    if (/^\.\.\.\s*$/.test(raw)) return;
    groups[groups.length - 1].push({ raw, no: i + 1 });
  });
  const documents = groups.map((g) => parseDocument(g));
  return { documents, separators };
}

/** Parse a single-document YAML text. */
export function parseYaml(text) {
  const { documents } = parseYamlStream(text);
  return documents.length === 1 ? documents[0].value : documents.map((d) => d.value);
}

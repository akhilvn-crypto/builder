// Minimal .gitignore check: is a project-relative file excluded from version control? Enough to prove that secrets and
// saved authentication state are ignored; it is not a full gitignore implementation (no nested .gitignore files, no
// character classes). When in doubt it answers "not ignored", which makes the caller warn rather than assume safety.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Patterns without a slash match at any depth; anchored ones only from the project root.
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}$`);
}

export function isIgnored(rootDir: string, relPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  const file = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = file.split('/');
  let ignored = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let pattern = negate ? line.slice(1) : line;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const re = patternToRegExp(pattern);
    // A directory pattern ignores everything below it, so test each leading path of the file.
    const candidates = dirOnly ? parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')) : parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    if (candidates.some((c) => re.test(c))) ignored = !negate;
  }
  return ignored;
}

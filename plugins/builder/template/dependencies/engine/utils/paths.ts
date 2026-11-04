import { existsSync } from 'node:fs';
import path from 'node:path';

// Pipeline paths are relative to a base folder (automation/ for test files, dependencies/ for test-case input), but
// callers usually run from the project root and may write "automation/tests/login.spec.ts" or
// "dependencies/input/test-cases/login.md". Return the base-relative form when the
// path exists relative to the root, or exists relative to the caller's cwd inside the root; otherwise unchanged
// (later validation reports it as missing/escaping).
export function toRootRelative(root: string, p: string, cwd: string = process.cwd()): string {
  const posix = (rel: string) => rel.split(path.sep).join('/');
  const inside = (rel: string) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (path.isAbsolute(p)) {
    const rel = path.relative(root, p);
    return inside(rel) ? posix(rel) : p;
  }
  if (existsSync(path.resolve(root, p))) return p;
  const fromCwd = path.resolve(cwd, p);
  const rel = path.relative(root, fromCwd);
  return inside(rel) && existsSync(fromCwd) ? posix(rel) : p;
}

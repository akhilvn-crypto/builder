// Cached test-case normalization. The key is the content of every input file, the saved column mappings, and the parser and
// schema versions, so an edit to a test-case file, a changed mapping, a parser change or a schema change each cause a re-parse;
// nothing else does.
//
// Secrets are never cached: the credential values found in the test cases are returned only by a real parse. On a cache hit
// `credentials` is empty, so the values the first parse wrote to automation/.env stay as they are, and a name that has lost its
// value is reported as missing (re-run with --no-cache to read the values from the test cases again).

import { sha256File, toPosixRelative } from '../utils/fs.ts';
import { PARSER_VERSION, decide, hashText, hashValue, writeEntry, type CacheDecision } from './artifact-cache.ts';
import { loadMappings } from './input-table.ts';
import { CANONICAL_SCHEMA_VERSION, projectSpecs, validateCanonicalDocument } from './canonical.ts';
import { listInputFiles, parseInputs, type ParsedInputs } from './test-case-parser.ts';
import { TEST_SPEC_SCHEMA_VERSION } from './test-spec.ts';

type Cached = Pick<ParsedInputs, 'canonical' | 'unsupported' | 'tables'>;

export interface ParsedSpecs extends ParsedInputs {
  decision: CacheDecision;
}

export function specsCacheName(inputPath: string): string {
  return hashText(inputPath.replace(/\\/g, '/')).slice(0, 12);
}

function asPayload(v: unknown): Cached | null {
  const p = v as Partial<Cached> | null;
  return p && typeof p === 'object' && p.canonical && Array.isArray(p.unsupported) && Array.isArray(p.tables) ? (p as Cached) : null;
}

// `rootDir` is the framework folder (automation/); test-case input is read relative to `baseDir` (dependencies/).
export function parseSpecsCached(
  rootDir: string, baseDir: string, runId: string, inputPath: string, opts: { useCache?: boolean; now?: Date } = {},
): ParsedSpecs {
  const files = listInputFiles(baseDir, inputPath);
  const mappings = loadMappings(rootDir);
  const inputs: Record<string, string> = {
    ...Object.fromEntries(files.map((f) => [toPosixRelative(baseDir, f), sha256File(f)])),
    '(column mappings)': hashValue(mappings),
  };
  const key = { inputs, versions: { parser: PARSER_VERSION, specSchema: String(TEST_SPEC_SCHEMA_VERSION), canonicalSchema: CANONICAL_SCHEMA_VERSION } };
  const name = specsCacheName(inputPath);

  const decision: CacheDecision = opts.useCache === false
    ? { kind: 'specs', name, action: 'rebuild', reason: 'the artifact cache was bypassed (--no-cache)', changed: [] }
    : decide(rootDir, 'specs', name, key, (raw) => {
      const p = asPayload(raw);
      if (!p) return ['cached record is malformed'];
      const issues = validateCanonicalDocument(p.canonical);
      // The document must describe exactly the files on disk now.
      for (const src of p.canonical.sources) if (inputs[src.path] !== src.sha256) issues.push(`${src.path} differs from the cached copy`);
      return issues;
    });

  if (decision.action === 'reuse') {
    const p = asPayload(decision.entry!.payload)!;
    return { canonical: p.canonical, document: projectSpecs(p.canonical), errors: [], unsupported: p.unsupported, tables: p.tables, credentials: [], decision };
  }

  const parsed = parseInputs(baseDir, files, opts.now, mappings);
  // Only a clean, valid normalization is worth keeping; a parse with errors must be redone after the input is fixed.
  if (parsed.errors.length === 0 && validateCanonicalDocument(parsed.canonical).length === 0) {
    writeEntry(rootDir, {
      kind: 'specs', name, ...key, payload: { canonical: parsed.canonical, unsupported: parsed.unsupported, tables: parsed.tables } satisfies Cached,
      by: 'specs parse', runId, now: opts.now,
    });
  }
  return { ...parsed, decision };
}

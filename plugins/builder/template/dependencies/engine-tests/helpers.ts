import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { AutomationConfig } from '../engine/config/schema.ts';
import { CANONICAL_SCHEMA_VERSION, documentValidation, projectSpecs, validationOf, type CanonicalCase, type CanonicalDocument } from '../engine/pipeline/canonical.ts';
import type { TestSpec, TestSpecDocument } from '../engine/pipeline/test-spec.ts';
import { dependenciesDir } from '../engine/utils/layout.ts';

// A throwaway project: <tmp>/automation is the framework root the engine receives, <tmp>/dependencies its sibling.
export function tmpRoot(t: { after: (fn: () => void) => void }): string {
  const project = mkdtempSync(path.join(os.tmpdir(), 'pw-pipeline-test-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const root = path.join(project, 'automation');
  mkdirSync(root);
  return root;
}

export function validConfig(): AutomationConfig {
  return {
    schemaVersion: 1,
    language: 'typescript',
    packageManager: 'npm',
    app: { baseUrl: 'https://test.example.com', environment: 'qa' },
    input: { testCasesPath: 'input/test-cases' },
    browsers: ['chromium'],
    evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    reporters: ['html', 'json'],
    auth: { approach: 'none', credentialEnvVars: [] },
    exploration: { tool: 'playwright-cli' },
    execution: { workers: null, retries: 1, timeoutMs: 30_000 },
    healing: { maxAttemptsPerTest: 2 },
    retention: { keepRuns: null },
  };
}

export function writeFile(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// Same, under the project's dependencies/ folder (test-case input, run state, bookkeeping).
export function writeDep(root: string, rel: string, content: string): string {
  return writeFile(dependenciesDir(root), rel, content);
}

// Realistic Playwright error messages for classifier/healing tests.
export const ERRORS = {
  notFound: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Sign in' })\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByRole('button', { name: 'Sign in' })",
  mismatch: "Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByRole('heading', { level: 1 })\nExpected string: \"Dashboard\"\nReceived string: \"Something went wrong\"\n\nCall log:\n  - waiting for getByRole('heading', { level: 1 })\n    9 × locator resolved to <h1>Something went wrong</h1>",
  network: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4173/',
  strict: "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements",
  missingEnv: 'MissingEnvError: Missing required environment variable TEST_USER_PASSWORD. Set it in .env',
} as const;

export interface FakeTest {
  title: string;
  file: string; // relative to tests/
  line?: number;
  project?: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: { status: string; error?: string; attachments?: { name: string; contentType: string; path: string }[] }[];
}

// Shape of Playwright's JSON reporter output (only the fields the pipeline reads).
export function pwReport(root: string, tests: FakeTest[], errors: string[] = []): unknown {
  const byFile = new Map<string, FakeTest[]>();
  for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  return {
    config: { rootDir: path.join(root, 'tests') },
    suites: [...byFile].map(([file, ts]) => ({
      title: file, file,
      specs: ts.map((t) => ({
        title: t.title, file, line: t.line ?? 3,
        tests: [{
          projectName: t.project ?? 'chromium', annotations: [], expectedStatus: 'passed', status: t.status,
          results: t.results.map((r, i) => ({
            retry: i, status: r.status, duration: 10,
            errors: r.error ? [{ message: r.error, stack: r.error }] : [],
            attachments: r.attachments ?? [],
          })),
        }],
      })),
    })),
    errors: errors.map((message) => ({ message })),
    stats: {},
  };
}

// Deterministic clock: each call advances one second.
export function fakeClock(start = '2026-10-19T08:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

// ---- .xlsx fixtures: a real workbook (zip of XML parts) built in memory, so the engine's reader is tested without any dependency ----

export interface SheetData { name: string; rows: (string | null)[][]; hidden?: boolean }

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function zip(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

// Strings go in sharedStrings.xml, as Excel writes them; `null` leaves a cell empty (so later cells keep their column).
export function buildXlsx(sheets: SheetData[]): Buffer {
  const shared: string[] = [];
  const sst = (s: string) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const parts: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach((s, i) => {
    const rows = s.rows.map((cells, r) => `<row r="${r + 1}">${cells.map((c, ci) => (c === null ? '' : `<c r="${col(ci)}${r + 1}" t="s"><v>${sst(c)}</v></c>`)).join('')}</row>`).join('');
    parts[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${shared.map((t) => `<si><t xml:space="preserve">${xmlEscape(t)}</t></si>`).join('')}</sst>`;
  return zip(parts);
}

export function writeXlsx(root: string, rel: string, sheets: SheetData[]): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, buildXlsx(sheets));
  return abs;
}

// Specs as the tests build them by hand, as a canonical document: the pipeline only accepts specs that project from one.
export function canonicalFromSpecs(specs: TestSpec[], generatedAt = '2026-10-20T00:00:00Z'): CanonicalDocument {
  const testCases = specs.map((s): CanonicalCase => ({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    testCaseId: s.id, title: s.title, module: s.module, moduleSlug: s.moduleSlug, suite: s.suite,
    preconditions: s.preconditions, expectedResults: s.expectedResults, testData: s.testData, priority: s.priority, tags: s.tags,
    steps: s.steps.map((st) => ({ stepNumber: st.index, action: st.action, ...(st.expected ? { expectedResult: st.expected } : {}) })),
    source: {
      file: s.source.path, fileName: s.source.path.split('/').pop()!, format: s.source.sheet ? 'xlsx' : 'markdown', sheet: s.source.sheet,
      row: s.source.sheet ? s.source.line : null, endRow: s.source.sheet ? s.source.line : null,
      line: s.source.sheet ? null : s.source.line, endLine: s.source.sheet ? null : s.source.line, heading: s.suite, originalId: s.source.originalId,
    },
    metadata: {},
    validation: validationOf(s.ambiguities),
  }));
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION, generatedAt,
    sources: [{ path: specs[0]?.source.path ?? 'input/cases.md', sha256: 'x', format: 'markdown' }],
    validation: documentValidation(testCases, [], []), testCases,
  };
}

// canonical-test-cases.json and the test-specs.json projected from it, written into a run.
export function writeRunSpecs(root: string, runId: string, specs: TestSpec[]): TestSpecDocument {
  const canonical = canonicalFromSpecs(specs);
  const doc = projectSpecs(canonical);
  writeDep(root, `runs/${runId}/canonical-test-cases.json`, JSON.stringify(canonical));
  writeDep(root, `runs/${runId}/test-specs.json`, JSON.stringify(doc));
  return doc;
}

// Modules: the unit generated tests are organised by. Every spec belongs to one module (a feature area such as "Login" or
// "Create Project"), and the generator writes one test file per module instead of one file for everything.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Language } from '../config/schema.ts';
import { TESTS_DIR, isPipelineOwned, specFileExtension } from './generation.ts';
import { chainsInLayoutModule } from './dependencies.ts';
import { layoutModule, layoutModuleSlug, type TestSpec, type TestSpecDocument } from './test-spec.ts';

export interface ModulePlan {
  module: string; // display name, used for test.describe(...)
  moduleSlug: string;
  file: string; // the one test file for this module, relative to automation/
  fileState: 'new' | 'pipeline-owned' | 'handwritten-renamed'; // handwritten-renamed: <slug>.spec.* is a handwritten file, so another name is used
  ready: string[]; // spec IDs to generate
  needsClarification: string[]; // spec IDs that must not be generated
  sources: string[]; // input files (with sheet) the module's cases came from
  // Dependency chains inside this file, prerequisites first (only the ids to generate). Each is written inside ONE serial group,
  // in this order, so the tests run in order on one worker and the rest are skipped when one fails.
  chains: { id: string; ids: string[] }[];
}

export function groupByModule(specs: TestSpec[], slugOf: (s: TestSpec) => string = (s) => s.moduleSlug): Map<string, TestSpec[]> {
  const groups = new Map<string, TestSpec[]>();
  for (const s of specs) {
    const key = slugOf(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return groups;
}

// One test file per module. A file name already used by a handwritten test is never reused: the module gets
// "<slug>.generated.spec.<ext>" (then -2, -3, ...) so the pipeline never overwrites something it does not own.
export function planModules(doc: TestSpecDocument, language: Language, rootDir: string): ModulePlan[] {
  const ext = specFileExtension(language);
  const plans: ModulePlan[] = [];
  const nodes = doc.specs.map((s) => ({ id: s.id, module: s.module, moduleSlug: s.moduleSlug, dependsOn: s.dependsOn }));
  const layoutSlug = new Map(doc.specs.map((s) => [s.id, layoutModuleSlug(s)]));
  const isReady = new Set(doc.specs.filter((s) => s.status === 'ready').map((s) => s.id));
  for (const [slug, specs] of groupByModule(doc.specs, layoutModuleSlug)) {
    let file = `${TESTS_DIR}/${slug}${ext}`;
    let owned = false;
    let renamed = false;
    for (let n = 1; existsSync(path.join(rootDir, file)); n++) {
      if (isPipelineOwned(readFileSync(path.join(rootDir, file), 'utf8'))) { owned = true; break; }
      renamed = true;
      file = `${TESTS_DIR}/${slug}.generated${n === 1 ? '' : `-${n}`}${ext}`;
    }
    plans.push({
      module: layoutModule(specs[0]!),
      moduleSlug: slug,
      file,
      fileState: owned ? 'pipeline-owned' : renamed ? 'handwritten-renamed' : 'new',
      ready: specs.filter((s) => s.status === 'ready').map((s) => s.id),
      needsClarification: specs.filter((s) => s.status === 'needs_clarification').map((s) => s.id),
      sources: [...new Set(specs.map((s) => (s.source.sheet ? `${s.source.path} [${s.source.sheet}]` : s.source.path)))],
      chains: chainsInLayoutModule(nodes, (n) => layoutSlug.get(n.id)!, slug)
        .map((c) => ({ id: c.id, ids: c.ids.filter((id) => isReady.has(id)) }))
        .filter((c) => c.ids.length >= 2),
    });
  }
  return plans;
}

// ---------- canonical Markdown (the pipeline's own input format) ----------

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Source information the canonical schema keeps as metadata is written under a reserved "### Metadata" heading, so reading the
// file back restores it (a key such as "Steps" can then never be mistaken for the section of that name).
const metaKey = (k: string): string => k.replace(/[^A-Za-z0-9 /().&'-]/g, ' ').replace(/\s+/g, ' ').trim();

export type MetadataOf = (id: string) => Record<string, string> | undefined;

function renderSpec(s: TestSpec, metadata?: Record<string, string>): string[] {
  const out = [`## ${s.id}: ${oneLine(s.title)}`];
  if (s.priority) out.push(`Priority: ${oneLine(s.priority)}`);
  if (s.tags.length) out.push(`Tags: ${s.tags.join(', ')}`);
  if (s.preconditions.length) out.push('### Preconditions', ...s.preconditions.map((p) => `- ${oneLine(p)}`));
  if (s.dependsOn?.length) out.push(`Depends on: ${s.dependsOn.join(', ')}`);
  if (s.testData.length) {
    out.push('### Test Data');
    for (const d of s.testData) out.push(`- ${d.name}: ${d.envVar !== null ? `env:${d.envVar}` : d.declaredLiteral ? `literal:${d.value}` : d.value}`);
  }
  if (s.steps.length) {
    out.push('### Steps');
    for (const st of s.steps) out.push(`${st.index}. ${oneLine(st.action)}${st.expected ? ` -> Expected: ${oneLine(st.expected)}` : ''}`);
  }
  if (s.expectedResults.length) out.push('### Expected Results', ...s.expectedResults.map((e) => `- ${oneLine(e)}`));
  const meta = Object.entries(metadata ?? {}).flatMap(([k, v]) => (/^[A-Za-z]/.test(metaKey(k)) && oneLine(v) ? [`- ${metaKey(k)}: ${oneLine(v)}`] : []));
  if (meta.length) out.push('### Metadata', ...meta);
  return out;
}

// One module as a Markdown file in the format `specs parse` reads natively. Built from the parsed specs, so credentials
// appear as env:VAR references (never values) and inline emails as {placeholders}.
export function renderModuleMarkdown(module: string, specs: TestSpec[], metadataOf?: MetadataOf): string {
  const lines = [`# ${oneLine(module)}`, ''];
  for (const s of specs) lines.push(...renderSpec(s, metadataOf?.(s.id)), '');
  return lines.join('\n');
}

// One case as its own Markdown file (the module heading is kept so the case lands in the same module when it is read back).
export function renderCaseMarkdown(spec: TestSpec, metadata?: Record<string, string>): string {
  return [`# ${oneLine(spec.module)}`, '', ...renderSpec(spec, metadata), ''].join('\n');
}

export interface NormalizedFile { module: string; moduleSlug: string; file: string; cases: number }

// Writes <dir>/<slug>.md for every module. The run keeps these as the record of how the original input was understood;
// copy one into the input folder to continue in the canonical format.
export function writeNormalizedInput(dir: string, doc: TestSpecDocument, metadataOf?: MetadataOf): NormalizedFile[] {
  rmSync(dir, { recursive: true, force: true }); // a re-parse must not leave files of modules that no longer exist
  mkdirSync(dir, { recursive: true });
  return [...groupByModule(doc.specs)].map(([slug, specs]) => {
    const file = `${slug}.md`;
    writeFileSync(path.join(dir, file), renderModuleMarkdown(specs[0]!.module, specs, metadataOf));
    return { module: specs[0]!.module, moduleSlug: slug, file, cases: specs.length };
  });
}

// dependencies/state/scaffold.json is written once by /builder:init. It records the language the user chose
// while scaffolding the framework (the files on disk are language-specific), so setup never asks again
// and config can never drift from the scaffolded files.

import path from 'node:path';
import { readJson } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { LANGUAGES, type Language } from './schema.ts';

export const SCAFFOLD_FILE = 'scaffold.json'; // inside dependencies/state/

export interface Scaffold {
  pluginVersion: string;
  language: Language;
  // Fingerprints of the plugin's generator and reviewer rule files, written by init. Absent in projects scaffolded by
  // plugin 0.19.0 and earlier (their cache keys fall back to pluginVersion until the next init --update).
  rules: { generator: string; reviewer: string } | null;
}

export function readScaffold(rootDir: string): Scaffold | null {
  const r = readJson(path.join(stateDir(rootDir), SCAFFOLD_FILE));
  if (!r.ok || typeof r.value !== 'object' || r.value === null) return null;
  const v = r.value as Partial<Scaffold>;
  if (!(LANGUAGES as readonly unknown[]).includes(v.language)) return null;
  const r2 = v.rules as Partial<NonNullable<Scaffold['rules']>> | null | undefined;
  const rules = r2 && typeof r2.generator === 'string' && typeof r2.reviewer === 'string' ? { generator: r2.generator, reviewer: r2.reviewer } : null;
  return { pluginVersion: typeof v.pluginVersion === 'string' ? v.pluginVersion : 'unknown', language: v.language as Language, rules };
}

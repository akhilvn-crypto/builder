// Where things live. The project has two sibling folders:
//
//   automation/     the Playwright framework only (pages/, tests/, helpers/, fixtures/, config/, reports/,
//                   test-results/, auth/, test-data/, playwright.config.*, package.json, README.md).
//                   Every `rootDir` / `--root` in the engine is this folder.
//   dependencies/   everything the pipeline needs that is not framework: the engine, docs, the test-case input
//                   folder, run state (runs/) and bookkeeping (state/).
//
// This is the only module that knows the folder name; derive every dependencies/ path from here.

import path from 'node:path';

export const DEPENDENCIES_DIRNAME = 'dependencies';

export function dependenciesDir(rootDir: string): string {
  return path.join(path.dirname(rootDir), DEPENDENCIES_DIRNAME);
}

// Test-case files are read relative to dependencies/ (e.g. "input/test-cases/login.md").
export function inputBaseDir(rootDir: string): string {
  return dependenciesDir(rootDir);
}

// Pipeline bookkeeping that is not framework configuration: scaffold.json, dependency-log.json.
export function stateDir(rootDir: string): string {
  return path.join(dependenciesDir(rootDir), 'state');
}

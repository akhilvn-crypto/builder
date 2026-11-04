// Audit log of dependency/setup decisions made with the user's explicit answer.
// Project-level file: dependencies/state/dependency-log.json. Entries are append-only.
// Declines are recorded for audit only; they never suppress asking again later.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../utils/fs.ts';
import { stateDir } from '../utils/layout.ts';
import { withFileLock } from '../utils/lock.ts';

export const DEPENDENCY_LOG_FILE = 'dependency-log.json'; // inside dependencies/state/

export const DEPENDENCY_ACTIONS = ['installed', 'declined', 'already_present', 'removed'] as const;
export type DependencyAction = (typeof DEPENDENCY_ACTIONS)[number];

export interface DependencyChange {
  timestamp: string;
  dependency: string; // e.g. "@playwright/test", "chromium browser", "allure CLI"
  action: DependencyAction;
  version: string | null; // verified version after install, when known
  command: string | null; // exact command run, when installed/removed
  reason: string; // why it was needed
  runId: string | null;
}

export function dependencyLogPath(rootDir: string): string {
  return path.join(stateDir(rootDir), DEPENDENCY_LOG_FILE);
}

export function readDependencyLog(rootDir: string): DependencyChange[] {
  const r = readJson(dependencyLogPath(rootDir));
  if (!r.ok) {
    if (r.reason === 'not_found') return [];
    throw new Error(r.message);
  }
  if (!Array.isArray(r.value)) throw new Error(`${DEPENDENCY_LOG_FILE} must contain a JSON array`);
  return r.value as DependencyChange[];
}

export function validateDependencyChange(v: Partial<DependencyChange>): string[] {
  const errors: string[] = [];
  if (!v.dependency || typeof v.dependency !== 'string') errors.push('dependency is required');
  if (!v.action || !(DEPENDENCY_ACTIONS as readonly string[]).includes(v.action)) {
    errors.push(`action must be one of: ${DEPENDENCY_ACTIONS.join(', ')}`);
  }
  if (!v.reason || typeof v.reason !== 'string') errors.push('reason is required');
  if ((v.action === 'installed' || v.action === 'removed') && !v.command) {
    errors.push(`command is required when action is ${v.action}`);
  }
  return errors;
}

export function appendDependencyChange(rootDir: string, change: DependencyChange): void {
  const errors = validateDependencyChange(change);
  if (errors.length > 0) throw new Error(`invalid dependency change: ${errors.join('; ')}`);
  mkdirSync(path.dirname(dependencyLogPath(rootDir)), { recursive: true });
  withFileLock(`${dependencyLogPath(rootDir)}.lock`, () => {
    const log = readDependencyLog(rootDir);
    log.push(change);
    writeJsonAtomic(dependencyLogPath(rootDir), log);
  });
}

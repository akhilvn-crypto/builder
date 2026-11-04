// Test-data helpers shared by generated and handwritten tests. No Playwright import.

import { randomBytes } from 'node:crypto';

export class MissingEnvError extends Error {}

/**
 * Read a required value (usually a credential) from the environment. Never log the value.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireEnv(name, env = process.env) {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new MissingEnvError(`Missing required environment variable ${name}. Set it in .env (see .env.example); never hard-code it.`);
  }
  return v;
}

/**
 * Unique suffix for records a test creates, so parallel tests and reruns don't collide. Pass the worker's
 * `testInfo.parallelIndex` to also keep data created by different workers visibly apart.
 * @param {string} [prefix]
 * @param {number} [workerIndex]
 * @returns {string}
 */
export function uniqueSuffix(prefix = 't', workerIndex = undefined) {
  const worker = workerIndex === undefined ? '' : `w${workerIndex}-`;
  return `${prefix}-${worker}${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Per-worker accounts: with execution.isolation "per-worker-accounts" each parallel worker needs its own login, supplied as
 * NAME_1 .. NAME_N next to NAME (worker 0 uses NAME_1). The names are env var NAMES; values are read, never logged.
 * @param {string} base
 * @param {number} parallelIndex
 * @returns {string}
 */
export function workerEnvName(base, parallelIndex) {
  return `${base}_${parallelIndex + 1}`;
}

/**
 * The worker's own variable when a pool is configured; otherwise the single shared one.
 * @param {string} base
 * @param {number} parallelIndex
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function requireWorkerEnv(base, parallelIndex, env = process.env) {
  const pooled = workerEnvName(base, parallelIndex);
  if (env[pooled] !== undefined && env[pooled] !== '') return requireEnv(pooled, env);
  return requireEnv(base, env);
}

/**
 * Replace every occurrence of the given secret values (min length 3) with "***".
 * @param {string} text
 * @param {readonly string[]} secrets
 * @returns {string}
 */
export function redact(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

/**
 * @param {readonly string[]} envVarNames
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function secretValues(envVarNames, env = process.env) {
  return envVarNames.map((n) => env[n]).filter((v) => typeof v === 'string' && v.length > 0);
}

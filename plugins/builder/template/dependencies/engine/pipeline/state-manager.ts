// Pipeline stages, statuses, and the rules for moving between them.
// Pure functions only: persistence lives in run-manager.ts.

export const STAGES = [
  'preflight',
  'configuration',
  'input_validation',
  'test_analysis',
  'application_exploration',
  'test_generation',
  'script_review',
  'execution',
  'failure_triage',
  'healing',
  'regression_validation',
  'report_generation',
  'finalization',
] as const;
export type StageName = (typeof STAGES)[number];

// `skipped` = not applicable by explicit policy (e.g. command scope, no eligible failures).
export const STAGE_STATUSES = ['pending', 'running', 'completed', 'failed', 'blocked', 'skipped', 'cancelled'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

const TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  pending: ['running', 'skipped', 'blocked', 'cancelled'],
  running: ['completed', 'failed', 'blocked', 'cancelled'],
  // Blocked/failed stages may be retried on resume once the cause is resolved.
  blocked: ['running', 'cancelled'],
  failed: ['running', 'cancelled'],
  completed: [],
  skipped: [],
  cancelled: [],
};

export const COMMANDS = ['playwright-pipeline', 'generate-tests', 'run-tests', 'heal-tests', 'design-test-n-automation'] as const;
export type Command = (typeof COMMANDS)[number];

// Stages each command performs. Others are marked `skipped` when the run is created.
export const COMMAND_STAGES: Record<Command, readonly StageName[]> = {
  'playwright-pipeline': STAGES,
  // Test design runs before the run is created (its own checkpoint under test-design/state/); the run then covers the same 13 stages,
  // with the design handoff and the traceability report as extra required artifacts (stage-contracts.ts).
  'design-test-n-automation': STAGES,
  'generate-tests': [
    'preflight', 'configuration', 'input_validation', 'test_analysis',
    'application_exploration', 'test_generation', 'script_review', 'finalization',
  ],
  'run-tests': ['preflight', 'configuration', 'execution', 'failure_triage', 'report_generation', 'finalization'],
  'heal-tests': [
    'preflight', 'configuration', 'failure_triage', 'healing',
    'regression_validation', 'report_generation', 'finalization',
  ],
};

export const RUN_STATUSES = ['in_progress', 'completed', 'failed', 'blocked', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// One start->end span of a stage. A stage that is retried after failing/blocking has several.
export interface StageAttempt {
  startedAt: string;
  endedAt: string;
  status: Exclude<StageStatus, 'pending' | 'running' | 'skipped'>; // how the attempt ended
  interrupted: boolean; // true = recovered after the process died, not ended by an explicit transition
  message: string | null;
}

export interface StageRecord {
  status: StageStatus;
  startedAt: string | null;
  endedAt: string | null;
  message: string | null;
  artifacts: string[]; // relative to the run directory
  // Finished attempts, oldest first. Absent in manifests written before metrics existed.
  attempts?: StageAttempt[];
}

export type StageMap = Record<StageName, StageRecord>;

export class TransitionError extends Error {}

export function isStageName(v: unknown): v is StageName {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v);
}

export function isStageStatus(v: unknown): v is StageStatus {
  return typeof v === 'string' && (STAGE_STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: StageStatus, to: StageStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function initialStages(command: Command): StageMap {
  const scope = COMMAND_STAGES[command];
  const map = {} as StageMap;
  for (const s of STAGES) {
    const inScope = scope.includes(s);
    map[s] = {
      status: inScope ? 'pending' : 'skipped',
      startedAt: null,
      endedAt: null,
      message: inScope ? null : `not part of /${command}`,
      artifacts: [],
    };
  }
  return map;
}

// Applies a transition, enforcing allowed moves and stage ordering.
// A stage may only start once every earlier stage is completed or skipped, which also
// guarantees at most one stage is running at a time.
export function applyTransition(
  stages: StageMap,
  stage: StageName,
  to: StageStatus,
  now: string,
  message: string | null = null,
): StageMap {
  const current = stages[stage];
  if (!canTransition(current.status, to)) {
    throw new TransitionError(`stage "${stage}": cannot move from ${current.status} to ${to}`);
  }
  if (to === 'running') {
    const idx = STAGES.indexOf(stage);
    const unfinished = STAGES.slice(0, idx).filter((s) => !isSettled(stages[s].status));
    if (unfinished.length > 0) {
      throw new TransitionError(`stage "${stage}" cannot start: earlier stage(s) not finished: ${unfinished.join(', ')}`);
    }
  }
  const next: StageRecord = { ...current, status: to, message: message ?? (to === 'running' ? null : current.message) };
  if (to === 'running') {
    next.startedAt = now;
    next.endedAt = null;
  } else {
    next.endedAt = now;
    // Leaving `running` closes an attempt; keep it so retries do not erase earlier durations.
    if (current.status === 'running' && current.startedAt !== null) {
      const status = to as StageAttempt['status']; // running -> {completed|failed|blocked|cancelled} only
      const attempt: StageAttempt = { startedAt: current.startedAt, endedAt: now, status, interrupted: false, message: next.message };
      next.attempts = [...(current.attempts ?? []), attempt];
    }
  }
  return { ...stages, [stage]: next };
}

function isSettled(s: StageStatus): boolean {
  return s === 'completed' || s === 'skipped';
}

// The run is only `completed` when every stage is completed or skipped.
// Anything unfinished is `in_progress`, so a partial run is never mistaken for a finished one.
export function deriveRunStatus(stages: StageMap): RunStatus {
  const statuses = STAGES.map((s) => stages[s].status);
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.every(isSettled)) return 'completed';
  return 'in_progress';
}

export function nextStage(stages: StageMap): StageName | null {
  return STAGES.find((s) => !isSettled(stages[s].status)) ?? null;
}

// A stage left `running` by a previous process was interrupted. Mark it failed so that
// resuming re-runs it from a known state instead of trusting partial output.
export function recoverInterrupted(stages: StageMap, now: string): { stages: StageMap; recovered: StageName[] } {
  let out = stages;
  const recovered: StageName[] = [];
  for (const s of STAGES) {
    if (out[s].status === 'running') {
      out = applyTransition(out, s, 'failed', now, 'interrupted: stage was running when the previous process stopped');
      // Distinguish "the process died" from a stage that reported its own failure.
      const attempts = (out[s].attempts ?? []).map((a, i, all) => (i === all.length - 1 ? { ...a, interrupted: true } : a));
      out = { ...out, [s]: { ...out[s], attempts } };
      recovered.push(s);
    }
  }
  return { stages: out, recovered };
}

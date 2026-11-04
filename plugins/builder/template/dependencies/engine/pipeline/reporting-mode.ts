// Reports are what the user selects in setup: Playwright's default report, Allure, the Extent report, the evidence PDF (JSON is
// always kept for the pipeline). Only the selected ones are produced. The report mode (reporting.mode) only bounds the evidence
// volume around that selection, so reporters are never generated or installed behind the user's back.
//
//   standard  failure-focused screenshots/traces; no Allure or evidence PDF         default development runs
//   full      any evidence settings; video retained for failures; Allure allowed     team testing and CI
//   audit     full + opt-in step evidence and the evidence PDF                       formal sign-off
//
// Validation of a configuration against its mode lives in config/schema.ts; this file turns a mode (or a selection of reports)
// into a plan the setup flow and `report build` can show, and into a preset the user can approve and save.

import type { AutomationConfig, Reporter, ReportMode, VideoMode } from '../config/schema.ts';

export interface ModeProfile {
  mode: ReportMode;
  intendedFor: string;
  reporters: readonly Reporter[]; // the reports `mode-preset` proposes for the mode (the selection in config.reporters is what counts)
  evidence: AutomationConfig['evidence']; // suggested Playwright evidence settings
  needs: readonly string[]; // optional software the mode relies on (each needs its own approval to install)
  volume: string; // what to expect on disk
}

export const MODE_PROFILES: Record<ReportMode, ModeProfile> = {
  standard: {
    mode: 'standard', intendedFor: 'default development runs', reporters: ['json', 'html'],
    evidence: { video: 'off', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    needs: [], volume: 'small: files exist only for tests that failed',
  },
  full: {
    mode: 'full', intendedFor: 'team testing and CI', reporters: ['json', 'html', 'allure'],
    evidence: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    needs: ['allure-playwright', 'allure CLI'], volume: 'moderate: Allure results plus videos of failed tests',
  },
  audit: {
    mode: 'audit', intendedFor: 'formal sign-off or audit', reporters: ['json', 'html', 'allure'],
    evidence: { video: 'retain-on-failure', screenshot: 'on', trace: 'retain-on-failure' },
    needs: ['allure-playwright', 'allure CLI'], volume: 'large: a screenshot per test, plus a video per test with the evidence PDF',
  },
};

export interface ModePreset {
  mode: ReportMode;
  reporters: Reporter[];
  evidence: AutomationConfig['evidence'];
  reporting: NonNullable<AutomationConfig['reporting']>;
  needs: string[];
  optIn: { stepScreenshots: boolean; evidencePdf: boolean };
  notes: string[];
}

// What to propose for a mode. Step screenshots and the evidence PDF are opt-in even in audit mode.
export function presetFor(mode: ReportMode, opts: { stepScreenshots?: boolean; evidencePdf?: boolean } = {}): ModePreset {
  const p = MODE_PROFILES[mode];
  const evidencePdf = mode === 'audit' && Boolean(opts.evidencePdf);
  const stepScreenshots = mode === 'audit' && (Boolean(opts.stepScreenshots) || evidencePdf);
  const notes = [`${p.mode}: ${p.intendedFor}; ${p.volume}`];
  if (mode === 'audit' && !stepScreenshots) notes.push('step evidence and the evidence PDF are off: they add files to every test; enable them only for sign-off');
  if (evidencePdf) notes.push('the evidence PDF is rendered with Chromium from the project\'s Playwright; screenshots and videos show visible page data, password fields are masked in the screenshots only');
  // The PDF embeds one video per test, so every test is recorded (not only the failures).
  if (evidencePdf) notes.push('evidence.video is "on" so every test has a video to embed: runs are slower and larger than with failure-only video');
  return {
    mode,
    reporters: [...p.reporters, ...(evidencePdf ? (['evidence-pdf'] as const) : [])],
    evidence: { ...p.evidence, ...(evidencePdf ? { video: 'on' as const } : {}) },
    reporting: { mode, ...(stepScreenshots ? { stepScreenshots: true } : {}) },
    needs: [...p.needs],
    optIn: { stepScreenshots, evidencePdf },
    notes,
  };
}

// The reports a user can pick in setup, in the order they are listed. `json` is not among them: it is always added (pipeline state).
export const SELECTABLE_REPORTERS = ['html', 'allure', 'extent', 'evidence-pdf'] as const;
export type SelectableReporter = (typeof SELECTABLE_REPORTERS)[number];

export const REPORTER_LABELS: Record<SelectableReporter, string> = {
  html: 'Playwright default report',
  allure: 'Allure report',
  extent: 'Extent report',
  'evidence-pdf': 'Evidence PDF',
};

// What to save for a selection of reports: exactly those reports plus `json`, and whatever each one needs to have data to show.
// The mode follows from the selection instead of being asked: the evidence PDF needs audit (step evidence + a video of every
// test), Allure needs full, anything else stays failure-focused standard. Nothing is installed here.
export function presetForReporters(selected: readonly string[]): ModePreset {
  const unknown = selected.filter((r) => !(SELECTABLE_REPORTERS as readonly string[]).includes(r));
  if (unknown.length > 0) throw new Error(`unknown report(s): ${unknown.join(', ')}; choose from ${SELECTABLE_REPORTERS.join(', ')}`);
  const has = (r: SelectableReporter) => selected.includes(r);
  const mode: ReportMode = has('evidence-pdf') ? 'audit' : has('allure') ? 'full' : 'standard';
  const base = presetFor(mode, { evidencePdf: has('evidence-pdf') });
  const needs: string[] = [];
  if (has('allure')) needs.push('allure-playwright', 'allure CLI');
  if (has('evidence-pdf')) needs.push('chromium (renders the PDF)');
  const notes = [`${mode}: ${MODE_PROFILES[mode].volume}`];
  if (has('extent')) notes.push('the Extent report is built from the run results after the tests (no package, one HTML file); it shows steps when the step log exists (evidence PDF selected) and Playwright\'s own screenshots otherwise');
  if (has('evidence-pdf')) notes.push(...base.notes.slice(1));
  if (selected.length === 0) notes.push('no report selected: only the JSON results the pipeline reads are written');
  return { ...base, reporters: ['json', ...SELECTABLE_REPORTERS.filter(has)], needs, notes };
}

export interface ReporterUpdate {
  selected: SelectableReporter[];
  before: string[]; // the reports in the saved config
  added: SelectableReporter[];
  removed: SelectableReporter[];
  changed: boolean;
  candidate: Record<string, unknown>; // the saved config with only reporters, reporting and evidence replaced
  changes: string[]; // one line per setting that differs, with the reason when the selection forces it
  needs: string[];
  notes: string[];
}

// Change the reports of a saved configuration later on. Everything but reporters, reporting and evidence stays as saved;
// those three follow the new selection (same rules as setup). Evidence the user chose is kept unless the selection makes it
// invalid or pointless: the evidence PDF forces video "on", and without it a video kept "on" only for the PDF goes back to
// failure-only (`video` overrides that), and "standard" cannot record everything. A legacy report (junit) is kept untouched.
export function updateReporters(current: Record<string, unknown>, selected: readonly string[], opts: { video?: VideoMode } = {}): ReporterUpdate {
  const preset = presetForReporters(selected);
  const has = (r: SelectableReporter) => selected.includes(r);
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const before = Array.isArray(current.reporters) ? current.reporters.filter((r): r is string => typeof r === 'string') : [];
  const isSelectable = (r: string): r is SelectableReporter => (SELECTABLE_REPORTERS as readonly string[]).includes(r);
  const legacy = before.filter((r) => r !== 'json' && !isSelectable(r));
  const reporters = [...preset.reporters, ...legacy];

  const reasons: Record<string, string> = {};
  const evidence = { ...preset.evidence, ...obj(current.evidence) } as AutomationConfig['evidence'];
  const hadPdf = before.includes('evidence-pdf');
  if (has('evidence-pdf') && evidence.video !== 'on') {
    reasons['evidence.video'] = 'the Evidence PDF embeds one video per test';
    evidence.video = 'on';
  } else if (!has('evidence-pdf') && hadPdf && evidence.video === 'on') {
    reasons['evidence.video'] = 'video of every test was only needed by the Evidence PDF';
    evidence.video = 'retain-on-failure';
  }
  if (opts.video !== undefined && opts.video !== evidence.video) {
    reasons['evidence.video'] = 'as requested';
    evidence.video = opts.video;
  }
  if (preset.mode === 'standard') {
    const standard = { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' } as const;
    for (const k of ['video', 'screenshot', 'trace'] as const) {
      if (evidence[k] === 'on' && !(k === 'video' && opts.video !== undefined)) {
        reasons[`evidence.${k}`] = 'the standard mode is failure-focused and cannot record every test';
        (evidence as Record<string, string>)[k] = standard[k];
      }
    }
  }
  const masks = obj(current.reporting).maskSelectors;
  const reporting = { ...preset.reporting, ...(Array.isArray(masks) ? { maskSelectors: masks } : {}) };

  const candidate = { ...current, reporters, evidence, reporting };
  const oldEvidence = obj(current.evidence);
  const oldReporting = obj(current.reporting);
  const show = (v: unknown) => (v === undefined ? 'unset' : Array.isArray(v) ? v.join(', ') : String(v));
  const diff = (label: string, was: unknown, now: unknown, why?: string): string[] =>
    show(was) === show(now) ? [] : [`${label}: ${show(was)} -> ${show(now)}${why ? ` (${why})` : ''}`];
  const modeWhy = `follows from the selection: ${MODE_PROFILES[preset.mode].intendedFor}`;
  const changes = [
    ...diff('reporters', before, reporters),
    ...diff('reporting.mode', oldReporting.mode, reporting.mode, modeWhy),
    ...diff('reporting.stepScreenshots', oldReporting.stepScreenshots ?? false, reporting.stepScreenshots ?? false, 'the step log and final-state screenshot are recorded only for the Evidence PDF'),
    ...(['video', 'screenshot', 'trace'] as const).flatMap((k) => diff(`evidence.${k}`, oldEvidence[k], evidence[k], reasons[`evidence.${k}`])),
  ];
  const chosen = (list: readonly string[]) => SELECTABLE_REPORTERS.filter((r) => list.includes(r));
  const wasChosen = chosen(before);
  const now = chosen(reporters);
  return {
    selected: now,
    before,
    added: now.filter((r) => !wasChosen.includes(r)),
    removed: wasChosen.filter((r) => !now.includes(r)),
    changed: changes.length > 0,
    candidate,
    changes,
    needs: preset.needs,
    notes: [...preset.notes, ...(legacy.length > 0 ? [`${legacy.join(', ')} stays as saved: it is no longer offered, but it was not removed`] : [])],
  };
}

export interface ReportPlan {
  mode: ReportMode | null; // null = no mode configured: the reporters and evidence are used as chosen
  reporters: Reporter[];
  evidence: AutomationConfig['evidence'];
  stepScreenshots: boolean;
  evidencePdf: boolean;
  // Software the selected reporters need beyond Playwright Test. Resolved against preflight, never installed here.
  requires: { id: string; reporter: Reporter; why: string }[];
  notes: string[];
}

export function reportPlan(config: AutomationConfig): ReportPlan {
  const requires: ReportPlan['requires'] = [];
  if (config.reporters.includes('allure')) {
    requires.push({ id: 'allure-playwright', reporter: 'allure', why: 'writes Allure results from Playwright Test' });
    requires.push({ id: 'allure-cli', reporter: 'allure', why: 'builds the Allure HTML report' });
  }
  if (config.reporters.includes('evidence-pdf')) {
    requires.push({ id: 'browser:chromium', reporter: 'evidence-pdf', why: 'renders the evidence PDF' });
  }
  const mode = config.reporting?.mode ?? null;
  return {
    mode,
    reporters: [...config.reporters],
    evidence: config.evidence,
    stepScreenshots: config.reporting?.stepScreenshots === true,
    evidencePdf: config.reporters.includes('evidence-pdf'),
    requires,
    notes: mode ? [`${mode}: ${MODE_PROFILES[mode].volume}`] : ['no reporting mode is configured; reporters and evidence are used exactly as chosen'],
  };
}

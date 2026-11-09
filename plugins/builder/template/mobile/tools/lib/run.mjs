// Executing flows with the Maestro CLI.
//
// One `maestro test` process per flow, so a failed flow never stops or erases the others: every flow has its own
// artifacts/<runId>/<flow>/ folder (log, Maestro debug output, screenshots) and its own result. Device, app and
// environment facts are recorded in reports/<runId>/run.json. A run on an emulator/simulator is allowed but is never
// recorded as physical-device validation.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { classifyFailure, stripAnsi } from './classify.mjs';
import { loadEnvironment, platformIdentifier, resolveRunVariables, enabledPlatforms } from './config.mjs';
import { CliError, ensureDir, makeRedactor, nowIso, readJson, run, slug, stamp, toPosix, walkFiles, writeFileAtomic, writeJson } from './util.mjs';
import {
  adbRun, androidAppInfo, detectCapabilities, iosAppInfo, listAndroidDevices, listDevices, resolveTools, verifyDevice, withDevice, CONNECT_STEPS,
} from './preflight.mjs';
import { buildReports } from './report.mjs';
import { referencedVariables, validateFlows } from './validate.mjs';

const ARTIFACT_EXT = /\.(png|jpe?g|mp4|webm|json|xml|txt|log|html)$/i;

/** Choose the device for a run. Never guesses between several physical devices. */
export async function chooseDevice(ctx, cfg, tools, { platform, deviceId, allowEmulator }) {
  const listing = (await listDevices(tools, [platform]))[platform];
  if (platform === 'ios' && listing.supported === false) {
    throw new CliError(listing.blocker, { needsInput: 'platform', details: { blocker: listing.blocker, platform } });
  }
  if (platform === 'android' && !tools.adb) throw new CliError('adb was not found, so Android devices cannot be detected. Install the Android platform-tools (see preflight).', { needsInput: 'adb' });
  const all = listing.devices;
  const ready = all.filter((d) => d.authorised);
  if (deviceId) {
    const d = all.find((x) => x.id === deviceId);
    if (!d) throw new CliError(`Device ${deviceId} is not connected.`, { needsInput: 'device', details: { devices: all, connectSteps: CONNECT_STEPS[platform] } });
    if (!d.authorised) throw new CliError(`Device ${deviceId} is "${d.state}".`, { needsInput: 'device', details: { device: d, fix: d.fix } });
    return d;
  }
  const preferred = cfg.devices?.[platform]?.preferred;
  if (preferred) {
    const d = ready.find((x) => x.id === preferred);
    if (d) return d;
  }
  const physical = ready.filter((d) => d.kind === 'physical');
  if (physical.length === 1) return physical[0];
  if (physical.length > 1) throw new CliError('More than one physical device is connected; choose one.', { needsInput: 'device', details: { devices: physical } });
  if (all.length && !ready.length) {
    throw new CliError('A device is connected but cannot be used yet.', { needsInput: 'device', details: { devices: all, fix: all.find((d) => d.fix)?.fix } });
  }
  const virtual = ready.filter((d) => d.kind !== 'physical');
  if (virtual.length && (allowEmulator || !cfg.execution?.requirePhysicalDevice)) {
    if (virtual.length === 1) return virtual[0];
    throw new CliError('More than one emulator/simulator is running; choose one.', { needsInput: 'device', details: { devices: virtual } });
  }
  throw new CliError(
    virtual.length
      ? `Only ${virtual.map((d) => d.kind).join('/')} targets are available. This framework is validated on a real physical device; connect one, or pass --allow-emulator to run anyway (the run will be marked as not physical-device validation).`
      : `No ${platform} device is connected.`,
    { needsInput: 'physical_device', details: { available: virtual, connectSteps: CONNECT_STEPS[platform] } },
  );
}

function artifactKind(file) {
  if (/\.png$|\.jpe?g$/i.test(file)) return 'screenshot';
  if (/\.mp4$|\.webm$/i.test(file)) return 'recording';
  if (/\.log$/i.test(file)) return 'log';
  return 'data';
}

async function captureAndroidScreenshot(tools, deviceId, into) {
  if (!tools.adb) return null;
  const remote = '/sdcard/builder-mobile-failure.png';
  const a = await adbRun(tools.adb, ['-s', deviceId, 'shell', 'screencap', '-p', remote]);
  if (a.code !== 0) return null;
  const local = path.join(into, 'device-screen-at-failure.png');
  const b = await adbRun(tools.adb, ['-s', deviceId, 'pull', remote, local]);
  await adbRun(tools.adb, ['-s', deviceId, 'shell', 'rm', remote]);
  return b.code === 0 && existsSync(local) ? local : null;
}

/**
 * params: { platform, selection: { selected, skipped, scope }, environment, deviceId, allowEmulator, label, failFast,
 *           skipVerify, plan, onProgress }
 */
export async function executeRun(ctx, cfg, params) {
  const { platform, selection, environment } = params;
  const progress = params.onProgress ?? (() => {});
  const tools = resolveTools();
  if (!tools.maestro) {
    throw new CliError('The Maestro CLI was not found. Run preflight to see what is missing; nothing is installed without your approval.', { needsInput: 'maestro', details: { hint: 'preflight' } });
  }
  if (!enabledPlatforms(cfg).includes(platform)) throw new CliError(`${platform} is not in scope in the saved configuration.`, { needsInput: 'platform' });
  const appId = platformIdentifier(cfg, platform);

  // 1. flows must be valid before anything touches a device
  const validation = validateFlows(ctx, cfg, { flows: selection.selected, check: { environmentVariables: Object.keys(loadEnvironment(ctx, environment).vars) } });
  if (!validation.ok) {
    throw new CliError(`Validation found ${validation.errors} error(s) in the selected flows; nothing was run.`, { code: 2, details: { validation: { errors: validation.errors, files: validation.files.filter((f) => f.issues.some((i) => i.severity === 'error')) } } });
  }
  if (selection.selected.length === 0) throw new CliError('No flows were selected for this platform.', { needsInput: 'scope', details: { skipped: selection.skipped } });

  // 2. variables and secrets (names only are ever reported)
  const vars = resolveRunVariables(ctx, cfg, { platform, environment, referenced: referencedVariables(ctx, selection.selected) });
  if (vars.missing.length) {
    throw new CliError(`Missing values for: ${vars.missing.join(', ')}. Add them to ${ctx.relFw(ctx.p.envFile)} (secrets, git-ignored) or config/environments/${environment}.json (non-secret).`, { needsInput: 'env', details: { missing: vars.missing } });
  }

  // 3. the device, and proof that Maestro can drive it and the app is on it
  const caps = await detectCapabilities(tools.maestro);
  const device = await chooseDevice(ctx, cfg, tools, params);
  let appInfo = { installed: null };
  if (!params.skipVerify) {
    const v = await verifyDevice(tools, caps, { platform, device, appId });
    if (!v.ready) {
      const appMissing = v.checks.find((c) => c.id === 'app_installed' && c.ok === false);
      throw new CliError(appMissing && v.checks.filter((c) => c.ok === false).length === 1
        ? `${appId} is not installed on ${device.model ?? device.id}.`
        : `The device is not ready: ${v.checks.filter((c) => c.ok === false).map((c) => `${c.id} (${c.detail})`).join('; ')}.`,
      { needsInput: appMissing && v.checks.filter((c) => c.ok === false).length === 1 ? 'app_install' : 'device', details: { checks: v.checks, device, artifact: cfg.platforms[platform].artifact } });
    }
    appInfo = v.app ?? appInfo;
  } else if (platform === 'android') appInfo = await androidAppInfo(tools.adb, device.id, appId);
  else appInfo = await iosAppInfo(tools, device, appId);

  const mv = await run(tools.maestro, ['--version'], { timeoutMs: 60000 });
  const maestroVersion = /(\d+\.\d+(?:\.\d+)?)/.exec(`${mv.stdout}\n${mv.stderr}`)?.[1] ?? null;

  if (params.plan) {
    return {
      plan: true, platform, environment, device, app: { id: appId, ...appInfo }, maestro: { version: maestroVersion },
      flows: selection.selected.map((f) => f.rel), skipped: selection.skipped, scope: selection.scope.description,
      secretsFrom: vars.secretNames, validationWarnings: validation.warnings,
    };
  }

  // 4. run
  const runId = `${stamp()}-${platform}${params.label ? `-${slug(params.label, 24)}` : ''}`;
  const reportDir = ensureDir(path.join(ctx.p.reports, runId));
  const artifactRoot = ensureDir(path.join(ctx.p.artifacts, runId));
  const redact = makeRedactor(vars.secretValues);
  const startedAt = nowIso();
  const t0 = Date.now();
  const meta = {
    runId, status: 'running', outcome: null, startedAt, finishedAt: null, durationMs: null, platform, environment,
    device: { id: device.id, model: device.model ?? device.name ?? null, manufacturer: device.manufacturer ?? null, osVersion: device.osVersion ?? null, kind: device.kind, physical: device.kind === 'physical', transport: device.transport },
    app: { id: appId, versionName: appInfo.versionName ?? null, versionCode: appInfo.versionCode ?? null, artifact: cfg.platforms[platform].artifact ?? null },
    maestro: { version: maestroVersion, path: tools.maestro },
    host: { platform: process.platform },
    scope: { description: selection.scope.description, flows: selection.selected.map((f) => f.rel), selectors: selection.scope.selectors },
    secretsPassing: cfg.secrets.passing, counts: null,
  };
  writeJson(path.join(reportDir, 'run.json'), meta);

  const results = [];
  const pad = String(selection.selected.length).length;
  let aborted = null;
  for (const [i, flow] of selection.selected.entries()) {
    const folder = `${String(i + 1).padStart(pad, '0')}-${slug(flow.relToFlows.replace(/\.ya?ml$/i, ''), 70)}`;
    const dir = ensureDir(path.join(artifactRoot, folder));
    const base = { flow: flow.rel, testCase: flow.testCase, name: flow.name, tags: flow.tags, folder: toPosix(path.relative(ctx.fw, dir)) };
    if (aborted) { results.push({ ...base, status: 'not_run', category: aborted.category, reason: aborted.reason, artifacts: [], durationMs: 0 }); continue; }
    const debugDir = path.join(dir, 'debug');
    const args = ['test'];
    if (caps.test.debugOutput) args.push('--debug-output', debugDir);
    if (caps.test.testOutputDir) args.push('--test-output-dir', path.join(dir, 'output'));
    args.push(...vars.cliArgs, flow.abs);
    const started = Date.now();
    progress(`[${i + 1}/${selection.selected.length}] ${flow.rel} …`);
    const r = await run(tools.maestro, withDevice(caps, device.id, args), { cwd: dir, env: vars.childEnv, timeoutMs: (params.timeoutSec ?? cfg.execution.flowTimeoutSec) * 1000 });
    const durationMs = Date.now() - started;
    const log = redact(stripAnsi(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`));
    writeFileAtomic(path.join(dir, 'maestro.log'), log);
    const passed = r.code === 0 && !r.timedOut && !r.spawnError;
    const result = { ...base, status: passed ? 'passed' : 'failed', exitCode: r.code, timedOut: r.timedOut, durationMs };
    if (!passed) {
      let c = classifyFailure({ exitCode: r.code, timedOut: r.timedOut, spawnError: r.spawnError, log, debugDir });
      // failure evidence: a screen capture and the hierarchy of the screen the flow stopped on
      const hasShot = walkFiles(dir).some((f) => /\.png$/i.test(f));
      if (!hasShot && platform === 'android' && c.category !== 'device') await captureAndroidScreenshot(tools, device.id, dir);
      if (c.category !== 'device' && (!caps.helpRead || caps.commands.hierarchy)) {
        const h = await run(tools.maestro, withDevice(caps, device.id, ['hierarchy']), { timeoutMs: 60000 });
        if (h.code === 0 && /[{[]/.test(h.stdout)) writeFileAtomic(path.join(dir, 'hierarchy-at-failure.json'), h.stdout);
      }
      // did the device disappear? then this is a device failure, and the rest cannot run
      if (platform === 'android' && c.category !== 'device') {
        const now = await listAndroidDevices(tools.adb);
        const still = now.devices.find((d) => d.id === device.id && d.authorised);
        if (!still) {
          c = { ...c, category: 'device', confidence: 'high', needsConfirmation: false, reason: `The device ${device.id} is no longer connected (was: ${c.reason})`, hint: 'Reconnect and authorise the device, then run again; flows that already passed keep their evidence.' };
        }
      }
      Object.assign(result, { category: c.category, confidence: c.confidence, needsConfirmation: c.needsConfirmation, reason: c.reason, hint: c.hint, failedCommand: c.failedCommand, excerpt: redact(c.excerpt) });
      if (c.category === 'device' && !(await deviceIsUsable(tools, platform, device.id))) aborted = { category: 'device', reason: 'Not run: the device became unavailable during the run.' };
    }
    result.artifacts = walkFiles(dir).filter((f) => ARTIFACT_EXT.test(f)).map((f) => toPosix(path.relative(ctx.fw, f)));
    results.push(result);
    progress(`    ${result.status}${result.category ? ` (${result.category})` : ''} ${Math.round(durationMs / 1000)}s`);
    writeJson(path.join(reportDir, 'results.json'), results);
    if (!passed && params.failFast && !aborted) aborted = { category: result.category, reason: 'Not run: stopped after the first failure (--fail-fast).' };
  }
  for (const s of selection.skipped) results.push({ flow: s.rel, status: 'skipped', reason: s.reason, artifacts: [], durationMs: 0, tags: [] });

  const counts = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    notRun: results.filter((r) => r.status === 'not_run').length,
  };
  Object.assign(meta, {
    status: aborted ? 'incomplete' : 'completed', finishedAt: nowIso(), durationMs: Date.now() - t0, counts,
    outcome: counts.failed === 0 && counts.notRun === 0 && counts.passed > 0 ? 'passed' : (aborted && counts.failed === 0 ? 'incomplete' : 'failed'),
  });
  writeJson(path.join(reportDir, 'results.json'), results);
  writeJson(path.join(reportDir, 'run.json'), meta);
  const validationRecord = recordDeviceValidation(ctx, meta, results);
  const report = buildReports(ctx, cfg, runId);
  return { runId, outcome: meta.outcome, status: meta.status, counts, device: meta.device, app: meta.app, maestro: meta.maestro, environment, validation: validationRecord, report, results: results.map((r) => ({ flow: r.flow, testCase: r.testCase, status: r.status, category: r.category ?? null, confidence: r.confidence ?? null, needsConfirmation: r.needsConfirmation ?? false, reason: r.reason ?? null, durationMs: r.durationMs })) };
}

async function deviceIsUsable(tools, platform, id) {
  if (platform !== 'android') return true;
  const now = await listAndroidDevices(tools.adb);
  return now.devices.some((d) => d.id === id && d.authorised);
}

/**
 * Physical-device validation is recorded only for a run on a physical device in which at least one flow tagged `smoke`
 * passed. An emulator/simulator run never counts, however many flows passed.
 */
export function recordDeviceValidation(ctx, meta, results) {
  const file = ctx.p.validation;
  const all = readJson(file, { schemaVersion: 1, platforms: {} });
  const smokePassed = results.filter((r) => r.status === 'passed' && r.tags?.includes('smoke'));
  const entry = {
    runId: meta.runId, at: meta.finishedAt, device: meta.device, app: meta.app, maestro: meta.maestro.version, environment: meta.environment,
    physical: meta.device.physical, smokeFlowsPassed: smokePassed.map((r) => r.flow), outcome: meta.outcome,
  };
  let validated = false;
  let reason;
  if (!meta.device.physical) reason = `Run on ${meta.device.kind}: not physical-device validation.`;
  else if (smokePassed.length === 0) reason = 'No flow tagged smoke passed on the physical device in this run.';
  else { validated = true; reason = `${smokePassed.length} smoke flow(s) passed on a physical device.`; }
  const previous = all.platforms[meta.platform];
  if (validated || !previous) all.platforms[meta.platform] = { validated, reason, ...entry };
  else all.platforms[meta.platform] = { ...previous, lastRun: { ...entry, validated, reason } };
  writeJson(file, all);
  return { platform: meta.platform, validated, reason };
}

export function validationStatus(ctx, cfg) {
  const rec = readJson(ctx.p.validation, { platforms: {} });
  const platforms = enabledPlatforms(cfg).map((p) => {
    const r = rec.platforms[p];
    return {
      platform: p, physicalDeviceValidated: Boolean(r?.validated),
      detail: r ? `${r.validated ? 'validated' : 'not validated'}: ${r.reason}${r.runId ? ` (run ${r.runId})` : ''}` : 'No run recorded yet.',
      device: r?.device ?? null, app: r?.app ?? null, runId: r?.runId ?? null,
    };
  });
  return { platforms, fullyValidated: platforms.length > 0 && platforms.every((p) => p.physicalDeviceValidated) };
}

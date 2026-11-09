#!/usr/bin/env node
// Maestro mobile automation CLI — the deterministic half of the /builder:*mobile* commands (the counterpart of pipeline.ts).
//
//   node mobile-automation/tools/maestro-cli.mjs <group> <action> [options]      (from the project root)
//
// JSON on stdout, progress on stderr. Exit 0 ok · 2 something is missing or invalid (see needsInput / issues) · 1 error.
// It never installs anything and never edits application code. Run `help` for the command list.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkConfig, enabledPlatforms, listEnvironments, loadConfig, makeContext, requireScaffold, saveConfig, syncEnvFiles, loadEnvironment,
  platformIdentifier, resolveRunVariables,
} from './lib/config.mjs';
import { discover, scanIdentifiers } from './lib/discover.mjs';
import { analyzeFlow, listFlowFiles, listSuites, readSuite, selectFlows } from './lib/flows.mjs';
import { healCheck, healFinish, healStart, healStatus } from './lib/heal.mjs';
import { addSemantics, inspectHierarchy, listSemantics, saveIdentifierCatalog } from './lib/inspect.mjs';
import {
  CONNECT_STEPS, detectCapabilities, installApp, listDevices, preflight, resolveTools, verifyDevice,
} from './lib/preflight.mjs';
import { buildReports, latestRunId, listRuns } from './lib/report.mjs';
import { chooseDevice, executeRun, validationStatus } from './lib/run.mjs';
import { envNamesOf, loadTestCases } from './lib/testcases.mjs';
import { changesSince, loadSpecs, loadTraceability, planGeneration, registerMapping, saveSpecs } from './lib/traceability.mjs';
import { CliError, nowIso, parseArgv, printJson, readJson, run as runProgram, toPosix, writeJson } from './lib/util.mjs';
import { referencedVariables, summarizeIssues, validateFlows } from './lib/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_VERSION = readJson(path.join(HERE, 'version.json'), { toolsVersion: 'dev' }).toolsVersion;

const BOOLEANS = ['all', 'plan', 'fail-fast', 'skip-verify', 'allow-emulator', 'approved', 'write', 'strict', 'maestro', 'verified'];
const ARRAYS = ['flow', 'test', 'feature', 'tag', 'source', 'platform', 'set'];

const HELP = {
  tool: `maestro-cli ${TOOLS_VERSION}`,
  commands: {
    'discover [--app <flutter dir>]': 'find the Flutter app, identifiers, flavors, builds, existing tests (read-only)',
    'preflight [--platform android|ios]': 'tool versions, Maestro capabilities, missing prerequisites with purpose and install hint (read-only)',
    'devices [--platform android|ios]': 'connected devices (physical/emulator), authorisation state, exact steps when none',
    'device verify --platform p [--device id]': 'proof the device is usable: authorised, Maestro can read it, app installed',
    'app install --platform p --device id --artifact path --approved': 'install a build on the device (only after the user approved)',
    'config check|show|save --json <patch> | --file <patch.json>': 'validated, non-secret configuration',
    'env sync | env check [--platform p --env name ...]': 'secret/variable names the test cases and flows need (names only, never values)',
    'cases parse [--source path ...]': 'read test cases (Markdown canonical format / CSV) into state/test-specs.json',
    'map plan | map register --test ID (--flow path | --status blocked|manual --reason text) | map changes | map status': 'test case ↔ flow traceability and change detection',
    'validate [--flow path ...] [--all] [--maestro]': 'YAML, references, selectors, assertions, secrets, appId, traceability',
    'suites': 'suite definitions in tests/ and the flows each one selects',
    'run --platform p (--flow f | --test ID | --feature name | --suite name | --all) [--env name] [--device id] [--plan] [--fail-fast] [--allow-emulator] [--timeout sec] [--strict]': 'execute flows one by one; evidence kept per flow',
    'report build [<runId>] | report list | report coverage [<runId>] | report formats [--set html,junit]': 'reports from recorded results',
    'validation status': 'is each in-scope platform validated on a real physical device?',
    'inspect hierarchy --device id [--name screen]': 'capture the real screen hierarchy and list selector candidates',
    'identifiers scan [--write]': 'accessibility identifiers already exposed by the Flutter code',
    'semantics add|list': 'record / list Flutter accessibility changes the app needs',
    'heal start|check|finish|status <runId> --flow f': 'bounded, audited selector repair (generated flows only)',
    'setup record --tool name --action installed|declined|present [--command text]': 'log a prerequisite decision in state/setup.json',
  },
};

function fail(err) {
  const body = { ok: false, error: err.message };
  if (err instanceof CliError) {
    if (err.needsInput) body.needsInput = err.needsInput;
    if (err.details) Object.assign(body, err.details);
    process.exitCode = err.exitCode;
  } else { body.error = `Unexpected error: ${err.stack ?? err.message}`; process.exitCode = 1; }
  printJson(body);
}

const progress = (line) => process.stderr.write(`${line}\n`);
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

async function main() {
  // --root and --dir may stand anywhere (before the command too), so take them out first
  const argv = process.argv.slice(2);
  const pre = {};
  for (const key of ['root', 'dir']) {
    const i = argv.findIndex((a) => a === `--${key}` || a.startsWith(`--${key}=`));
    if (i === -1) continue;
    if (argv[i].includes('=')) { pre[key] = argv[i].slice(key.length + 3); argv.splice(i, 1); } else { pre[key] = argv[i + 1]; argv.splice(i, 2); }
  }
  const [group, action, ...rest] = argv;
  if (!group || group === 'help' || group === '--help') return printJson(HELP);
  const { flags, positionals } = parseArgv([action, ...rest].filter((x) => x !== undefined), { booleans: BOOLEANS, arrays: ARRAYS });
  // actions are positional for groups that have them; for single-word commands the "action" may be a flag
  const hasAction = action && !action.startsWith('--');
  const args = hasAction ? positionals.slice(1) : positionals;
  const sub = hasAction ? action : null;
  const ctx = makeContext({ root: pre.root, dir: pre.dir, here: HERE });
  const platformFlags = flags.platform ?? [];
  const platformOne = one(flags.platform);

  const needConfig = () => {
    requireScaffold(ctx);
    const cfg = loadConfig(ctx);
    const check = checkConfig(cfg);
    if (check.status !== 'valid') throw new CliError(`The configuration is ${check.status}: ${check.issues.map((i) => i.message).join(' ')}`, { needsInput: 'config', details: { issues: check.issues } });
    return cfg;
  };
  const platformsInScope = () => (platformFlags.length ? platformFlags : (loadConfig(ctx) ? enabledPlatforms(loadConfig(ctx)) : []));

  switch (group) {
    case 'discover': {
      printJson({ ok: true, ...discover(ctx, { app: flags.app }) });
      return;
    }

    case 'preflight': {
      const platforms = platformFlags.length ? platformFlags : platformsInScope();
      const result = await preflight({ platforms });
      const { tools, ...shown } = result;
      printJson({ ok: true, ...shown, tools: Object.fromEntries(Object.entries(tools).filter(([k]) => k !== 'sdkDirs')) });
      if (!result.ready) process.exitCode = 2;
      return;
    }

    case 'devices': {
      const platforms = platformFlags.length ? platformFlags : (platformsInScope().length ? platformsInScope() : ['android']);
      const tools = resolveTools();
      const found = await listDevices(tools, platforms);
      const out = { ok: true };
      for (const p of platforms) {
        const d = found[p];
        const physical = d.devices.filter((x) => x.kind === 'physical' && x.authorised);
        out[p] = { ...d, physicalReady: physical.length, ...(physical.length === 0 ? { connectSteps: CONNECT_STEPS[p] } : {}) };
      }
      printJson(out);
      if (platforms.some((p) => out[p].physicalReady === 0)) process.exitCode = 2;
      return;
    }

    case 'device': {
      if (sub !== 'verify') throw new CliError('Usage: device verify --platform android|ios [--device id]');
      const cfg = needConfig();
      const platform = platformOne ?? (enabledPlatforms(cfg).length === 1 ? enabledPlatforms(cfg)[0] : null);
      if (!platform) throw new CliError('Say which platform: --platform android|ios', { needsInput: 'platform' });
      const tools = resolveTools();
      const device = await chooseDevice(ctx, cfg, tools, { platform, deviceId: flags.device, allowEmulator: flags['allow-emulator'] });
      const caps = await detectCapabilities(tools.maestro);
      const v = await verifyDevice(tools, caps, { platform, device, appId: platformIdentifier(cfg, platform) });
      printJson({ ok: v.ready, platform, device, ...v, physical: device.kind === 'physical' });
      if (!v.ready) process.exitCode = 2;
      return;
    }

    case 'app': {
      if (sub !== 'install') throw new CliError('Usage: app install --platform p --device id --artifact <path> --approved');
      const cfg = needConfig();
      if (!flags.approved) throw new CliError('Installing an app changes the device. Ask the user first, then repeat with --approved.', { needsInput: 'approval' });
      const platform = platformOne;
      if (!platform || !flags.device || !flags.artifact) throw new CliError('--platform, --device and --artifact are required.');
      const artifact = path.resolve(ctx.root, flags.artifact);
      if (!existsSync(artifact)) throw new CliError(`Build not found: ${flags.artifact}`, { needsInput: 'artifact' });
      const tools = resolveTools();
      const device = (await listDevices(tools, [platform]))[platform].devices.find((d) => d.id === flags.device);
      if (!device?.authorised) throw new CliError(`Device ${flags.device} is not connected and authorised.`, { needsInput: 'device' });
      const r = await installApp(tools, { platform, device, artifact });
      printJson({ ok: r.ok, platform, device: device.id, artifact: toPosix(path.relative(ctx.root, artifact)), appId: platformIdentifier(cfg, platform), ...r });
      if (!r.ok) process.exitCode = 1;
      return;
    }

    case 'config': {
      requireScaffold(ctx);
      if (sub === 'check') {
        const cfg = loadConfig(ctx);
        printJson({ ok: true, ...checkConfig(cfg), environments: listEnvironments(ctx) });
        if (checkConfig(cfg).status !== 'valid') process.exitCode = 2;
        return;
      }
      if (sub === 'show') { printJson({ ok: true, config: loadConfig(ctx), environments: listEnvironments(ctx) }); return; }
      if (sub === 'save') {
        let patch;
        if (flags.file) patch = readJson(path.resolve(ctx.root, flags.file), null);
        else if (flags.json) { try { patch = JSON.parse(flags.json); } catch { throw new CliError('--json is not valid JSON.'); } }
        if (!patch || typeof patch !== 'object') throw new CliError('Give the settings to save as --json \'{...}\' or --file patch.json.');
        const r = saveConfig(ctx, patch);
        printJson({ ok: true, ...r });
        if (r.status !== 'valid') process.exitCode = 2;
        return;
      }
      throw new CliError('Usage: config check|show|save');
    }

    case 'env': {
      const cfg = needConfig();
      if (sub === 'sync') {
        const parsed = loadTestCases(ctx, cfg, flags.source);
        const names = envNamesOf(parsed.cases);
        const added = syncEnvFiles(ctx, names);
        printJson({ ok: true, variables: names.map((n) => ({ testCaseName: n, flowVariable: `MAESTRO_${n.replace(/^MAESTRO_/, '')}` })), added, note: `Fill in the values in ${ctx.relFw(ctx.p.envFile)}. Values are never printed or committed.` });
        return;
      }
      if (sub === 'check') {
        const platform = platformOne ?? enabledPlatforms(cfg)[0];
        const environment = one(flags.env) ?? cfg.environments.default;
        const selection = selectFlows(ctx, { all: true }, { platform });
        const vars = resolveRunVariables(ctx, cfg, { platform, environment, referenced: referencedVariables(ctx, selection.selected) });
        printJson({ ok: vars.missing.length === 0, environment, environmentFile: vars.environmentFile, provided: Object.keys(vars.vars), secretsAvailable: vars.secretNames, missing: vars.missing });
        if (vars.missing.length) process.exitCode = 2;
        return;
      }
      throw new CliError('Usage: env sync | env check');
    }

    case 'cases': {
      const cfg = loadConfig(ctx);
      if (sub !== 'parse' && sub !== 'list') throw new CliError('Usage: cases parse [--source path ...] | cases list');
      if (sub === 'list') {
        const s = loadSpecs(ctx);
        if (!s) throw new CliError('No parsed test cases yet. Run "cases parse".', { needsInput: 'testCases' });
        printJson({ ok: true, parsedAt: s.parsedAt, cases: s.cases.map((c) => ({ id: c.id, title: c.title, module: c.module, priority: c.priority, tags: c.tags, status: c.status, automation: c.automation })) });
        return;
      }
      requireScaffold(ctx);
      const parsed = loadTestCases(ctx, cfg, flags.source);
      saveSpecs(ctx, parsed);
      if (flags.source?.length) saveConfig(ctx, { testCases: { sources: parsed.sourcePaths } });
      const bad = parsed.cases.filter((c) => c.status !== 'valid');
      printJson({
        ok: parsed.problems.length === 0 || parsed.cases.length > 0, specs: ctx.rel(ctx.p.specs), total: parsed.cases.length,
        valid: parsed.cases.length - bad.length, needsClarification: bad.map((c) => ({ id: c.id, reasons: c.reasons })),
        manual: parsed.cases.filter((c) => c.automation === 'manual').map((c) => c.id), envNames: envNamesOf(parsed.cases),
        sources: parsed.sources.map((s) => ({ file: s.file, cases: s.cases.length })), problems: parsed.problems,
        cases: parsed.cases.map((c) => ({ id: c.id, title: c.title, module: c.module, priority: c.priority, tags: c.tags, status: c.status })),
      });
      if (parsed.cases.length === 0) process.exitCode = 2;
      return;
    }

    case 'map': {
      requireScaffold(ctx);
      if (sub === 'register') {
        printJson({ ok: true, ...registerMapping(ctx, { testId: one(flags.test), flow: flags.flow?.[0], status: flags.status, reason: flags.reason }) });
        return;
      }
      if (sub === 'status') {
        const trace = loadTraceability(ctx);
        printJson({ ok: true, cases: Object.entries(trace.cases).map(([id, e]) => ({ id, title: e.title, status: e.status, flow: e.flow, reason: e.reason })) });
        return;
      }
      const specs = loadSpecs(ctx);
      if (!specs) throw new CliError('Run "cases parse" first.', { needsInput: 'testCases' });
      // re-read the sources so a change since the last parse is seen
      const cfg = loadConfig(ctx);
      let cases = specs.cases;
      try { const fresh = loadTestCases(ctx, cfg, flags.source); cases = fresh.cases; saveSpecs(ctx, fresh); } catch { /* sources gone: use the saved parse */ }
      if (sub === 'plan') { printJson({ ok: true, ...planGeneration(ctx, cases) }); return; }
      if (sub === 'changes') { printJson({ ok: true, ...changesSince(ctx, cases) }); return; }
      throw new CliError('Usage: map plan|register|changes|status');
    }

    case 'validate': {
      requireScaffold(ctx);
      const cfg = loadConfig(ctx);
      const files = flags.flow?.length
        ? flags.flow.map((f) => { const abs = [path.resolve(ctx.fw, f), path.resolve(ctx.root, f)].find((c) => existsSync(c)); if (!abs) throw new CliError(`Flow not found: ${f}`); return analyzeFlow(ctx, abs); })
        : undefined;
      const envNames = cfg ? Object.keys(loadEnvironment(ctx, cfg.environments?.default ?? '_').vars) : [];
      const result = validateFlows(ctx, cfg, { flows: files, check: { environmentVariables: envNames } });
      const out = { ok: result.ok, flows: result.flows, errors: result.errors, warnings: result.warnings, summary: summarizeIssues(result), files: result.files.filter((f) => f.issues.length) };
      if (flags.maestro) {
        const tools = resolveTools();
        const caps = await detectCapabilities(tools.maestro);
        out.maestroCheckSyntax = caps.commands['check-syntax'] ? [] : 'not available in the installed Maestro; the built-in validation above was used';
        if (caps.commands['check-syntax']) {
          for (const f of (files ?? listFlowFiles(ctx).filter((x) => x.kind === 'test').map((x) => analyzeFlow(ctx, x.abs)))) {
            const r = await runProgram(tools.maestro, ['check-syntax', f.abs], { timeoutMs: 60000 });
            out.maestroCheckSyntax.push({ flow: f.rel, ok: r.code === 0, message: r.code === 0 ? null : `${r.stdout}${r.stderr}`.trim().slice(0, 300) });
            if (r.code !== 0) { out.ok = false; process.exitCode = 2; }
          }
        }
      }
      printJson(out);
      if (!result.ok) process.exitCode = 2;
      return;
    }

    case 'suites': {
      requireScaffold(ctx);
      const out = listSuites(ctx).map((name) => {
        const s = readSuite(ctx, name);
        let flows = [];
        try { flows = selectFlows(ctx, { suite: name }).selected.map((f) => f.rel); } catch { /* no flows yet */ }
        return { name, description: s.description, includeTags: s.includeTags, excludeTags: s.excludeTags, flows };
      });
      printJson({ ok: true, suites: out });
      return;
    }

    case 'run': {
      const cfg = needConfig();
      const platform = platformOne ?? (enabledPlatforms(cfg).length === 1 ? enabledPlatforms(cfg)[0] : null);
      if (!platform) throw new CliError('Both platforms are in scope; choose one: --platform android|ios.', { needsInput: 'platform' });
      const trace = loadTraceability(ctx);
      const selection = selectFlows(ctx, { flow: flags.flow, testId: flags.test, feature: flags.feature, suite: flags.suite, tag: flags.tag, all: flags.all }, { platform, traceability: trace });
      const result = await executeRun(ctx, cfg, {
        platform, selection, environment: one(flags.env) ?? cfg.environments.default, deviceId: flags.device, allowEmulator: flags['allow-emulator'],
        label: flags.label, failFast: flags['fail-fast'] || cfg.execution.failFast, skipVerify: flags['skip-verify'], plan: flags.plan, onProgress: progress,
        timeoutSec: flags.timeout ? Number(flags.timeout) : undefined,
      });
      printJson({ ok: true, ...result });
      if (!result.plan && flags.strict && result.outcome !== 'passed') process.exitCode = 1;
      return;
    }

    case 'report': {
      requireScaffold(ctx);
      const cfg = loadConfig(ctx);
      if (sub === 'list') { printJson({ ok: true, runs: listRuns(ctx) }); return; }
      if (sub === 'formats') {
        if (flags.set !== undefined) {
          const formats = csv(one(flags.set)).filter((f) => f !== 'none');
          const r = saveConfig(ctx, { reporting: { formats } });
          printJson({ ok: true, formats: r.config.reporting.formats, note: 'Applies to the next report build; summary.md, summary.json and coverage.json are always written.' });
        } else printJson({ ok: true, formats: cfg?.reporting?.formats ?? [], available: ['html', 'junit'], always: ['summary.json', 'summary.md', 'coverage.json'] });
        return;
      }
      const runId = args[0] ?? latestRunId(ctx);
      if (!runId) throw new CliError('There is no run yet.', { needsInput: 'run' });
      if (sub === 'build') { printJson({ ok: true, ...buildReports(ctx, cfg, runId) }); return; }
      if (sub === 'coverage') {
        const cov = readJson(path.join(ctx.p.reports, runId, 'coverage.json'), null) ?? (buildReports(ctx, cfg, runId), readJson(path.join(ctx.p.reports, runId, 'coverage.json'), null));
        printJson({ ok: true, runId, ...cov });
        return;
      }
      throw new CliError('Usage: report build [runId] | list | coverage [runId] | formats');
    }

    case 'validation': {
      const cfg = needConfig();
      printJson({ ok: true, ...validationStatus(ctx, cfg) });
      return;
    }

    case 'inspect': {
      const cfg = needConfig();
      const platform = platformOne ?? enabledPlatforms(cfg)[0];
      const tools = resolveTools();
      const device = await chooseDevice(ctx, cfg, tools, { platform, deviceId: flags.device, allowEmulator: flags['allow-emulator'] });
      printJson({ ok: true, device: device.id, ...(await inspectHierarchy(ctx, tools, { deviceId: device.id, name: flags.name })) });
      return;
    }

    case 'identifiers': {
      const cfg = loadConfig(ctx);
      const appRoot = path.resolve(ctx.root, flags.app ?? cfg?.app?.root ?? '.');
      const scan = scanIdentifiers(appRoot);
      let saved = null;
      if (flags.write) { requireScaffold(ctx); saved = saveIdentifierCatalog(ctx, scan); }
      printJson({ ok: true, stats: scan.stats, count: scan.identifiers.length, identifiers: scan.identifiers.slice(0, 400), saved });
      return;
    }

    case 'semantics': {
      requireScaffold(ctx);
      if (sub === 'list') { printJson({ ok: true, requests: listSemantics(ctx) }); return; }
      if (sub === 'add') {
        printJson({ ok: true, ...addSemantics(ctx, { screen: flags.screen, control: flags.control, suggestedId: flags['suggested-id'], reason: flags.reason, testCase: flags.test ? one(flags.test) : '' }) });
        return;
      }
      throw new CliError('Usage: semantics add --screen S --control C --suggested-id id --reason R [--test ID] | semantics list');
    }

    case 'heal': {
      requireScaffold(ctx);
      const runId = args[0];
      if (!runId) throw new CliError('Usage: heal start|check|finish|status <runId> --flow <file>');
      const flow = flags.flow?.[0];
      if (sub === 'status') { printJson({ ok: true, ...healStatus(ctx, runId) }); return; }
      if (!flow) throw new CliError('--flow is required.');
      if (sub === 'start') { printJson({ ok: true, ...healStart(ctx, runId, flow) }); return; }
      if (sub === 'check') {
        const r = healCheck(ctx, runId, flow, { evidence: flags.evidence, rationale: flags.rationale });
        printJson({ ok: r.ok, ...r });
        if (!r.ok) process.exitCode = 2;
        return;
      }
      if (sub === 'finish') { printJson({ ok: true, ...healFinish(ctx, runId, flow, { result: flags.result, rerunId: flags.rerun, note: flags.note }) }); return; }
      throw new CliError('Usage: heal start|check|finish|status');
    }

    case 'setup': {
      requireScaffold(ctx);
      if (sub !== 'record') throw new CliError('Usage: setup record --tool name --action installed|declined|present [--command text] [--version v]');
      const log = readJson(ctx.p.setup, { schemaVersion: 1, decisions: [], verified: null });
      if (flags.tool) {
        if (!['installed', 'declined', 'present'].includes(flags.action)) throw new CliError('--action must be installed, declined or present.');
        log.decisions.push({ at: nowIso(), tool: flags.tool, action: flags.action, command: flags.command ?? null, version: flags.version ?? null });
      }
      if (flags.verified) {
        const pf = await preflight({ platforms: platformsInScope() });
        log.verified = { at: nowIso(), host: pf.host, tools: pf.checks.map((c) => ({ id: c.id, status: c.status, version: c.version })), maestroCapabilities: pf.capabilities };
      }
      writeJson(ctx.p.setup, log);
      printJson({ ok: true, file: ctx.rel(ctx.p.setup), decisions: log.decisions.length, verified: Boolean(log.verified) });
      return;
    }

    case 'version': printJson({ ok: true, toolsVersion: TOOLS_VERSION, node: process.version }); return;

    default:
      throw new CliError(`Unknown command "${group}". Run "help".`);
  }
}

main().catch(fail);

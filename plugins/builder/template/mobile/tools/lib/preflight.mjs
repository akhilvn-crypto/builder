// Tool detection, Maestro capability detection, device discovery and device verification.
// Everything here is read-only except installApp(), which the caller may use only after the user approved it.
// Nothing is installed on the machine; missing tools are reported with their purpose and an install hint.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, isWindows, run, which } from './util.mjs';

const HOME = homeDir();
const TOOL_TIMEOUT = 60000;

export function resolveTools() {
  const sdkDirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(HOME, 'Library', 'Android', 'sdk'), path.join(HOME, 'Android', 'Sdk')].filter(Boolean);
  return {
    maestro: which('maestro', [path.join(HOME, '.maestro', 'bin')]),
    adb: which('adb', sdkDirs.map((d) => path.join(d, 'platform-tools'))),
    emulator: which('emulator', sdkDirs.map((d) => path.join(d, 'emulator'))),
    java: which('java', process.env.JAVA_HOME ? [path.join(process.env.JAVA_HOME, 'bin')] : []),
    flutter: which('flutter'),
    xcodebuild: process.platform === 'darwin' ? which('xcodebuild') : null,
    xcrun: process.platform === 'darwin' ? which('xcrun') : null,
    sdkDirs,
  };
}

const firstVersion = (text) => /(\d+\.\d+(?:\.\d+)?(?:[.+-][\w.]+)?)/.exec(text ?? '')?.[1] ?? null;

async function versionOf(file, args, pick = firstVersion, timeoutMs = TOOL_TIMEOUT) {
  if (!file) return { version: null, raw: '' };
  const r = await run(file, args, { timeoutMs });
  const raw = `${r.stdout}\n${r.stderr}`.trim();
  return { version: pick(raw), raw, code: r.code, timedOut: r.timedOut, spawnError: r.spawnError };
}

const javaMajor = (text) => {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
};

/** Which flags the installed Maestro CLI offers. Read from its own --help output, never assumed from a version number. */
export async function detectCapabilities(maestro) {
  const caps = { helpRead: false, root: {}, test: {}, commands: {} };
  if (!maestro) return caps;
  const [root, test] = await Promise.all([run(maestro, ['--help'], { timeoutMs: TOOL_TIMEOUT }), run(maestro, ['test', '--help'], { timeoutMs: TOOL_TIMEOUT })]);
  const rootHelp = `${root.stdout}\n${root.stderr}`;
  const testHelp = `${test.stdout}\n${test.stderr}`;
  caps.helpRead = /usage/i.test(rootHelp) || /usage/i.test(testHelp);
  const has = (text, flag) => new RegExp(`(^|[\\s,\\[])${flag}(?=[\\s=,\\]<]|$)`, 'm').test(text);
  for (const f of ['device', 'udid']) { caps.root[f] = has(rootHelp, `--${f}`); caps.test[f] = has(testHelp, `--${f}`); }
  for (const [key, flag] of [['format', '--format'], ['output', '--output'], ['debugOutput', '--debug-output'], ['testOutputDir', '--test-output-dir'],
    ['includeTags', '--include-tags'], ['excludeTags', '--exclude-tags'], ['env', '--env'], ['config', '--config'], ['shards', '--shard-split'],
    ['continuous', '--continuous'], ['analyze', '--analyze']]) caps.test[key] = has(testHelp, flag);
  caps.test.envShort = has(testHelp, '-e');
  for (const c of ['check-syntax', 'hierarchy', 'studio', 'start-device', 'record']) caps.commands[c] = new RegExp(`^\\s*${c}\\b`, 'm').test(rootHelp);
  if (!caps.helpRead) caps.note = 'Could not read the Maestro help output; defaults will be used and verified when a flow runs.';
  return caps;
}

/** Put the device selector where this Maestro version accepts it: maestro [--device X] test … */
export function withDevice(caps, deviceId, args) {
  if (!deviceId) return args;
  if (caps.root.device) return ['--device', deviceId, ...args];
  if (caps.root.udid) return ['--udid', deviceId, ...args];
  if (args[0] === 'test' && caps.test.device) return ['test', '--device', deviceId, ...args.slice(1)];
  if (args[0] === 'test' && caps.test.udid) return ['test', '--udid', deviceId, ...args.slice(1)];
  return ['--udid', deviceId, ...args]; // help could not be read: the long-standing global option
}

// ---------------------------------------------------------------- devices

export const CONNECT_STEPS = {
  android: [
    'On the phone: Settings → About phone → tap "Build number" 7 times to enable Developer options.',
    'Settings → System → Developer options → turn on "USB debugging" (some phones also need "Install via USB" / "USB debugging (Security settings)").',
    'Connect the phone to this computer with a data-capable USB cable and unlock the screen.',
    'Accept the "Allow USB debugging?" prompt on the phone (tick "Always allow from this computer").',
    'Windows only: install the phone maker\'s USB driver (or the Google USB driver) if the device does not appear.',
    'Check with: adb devices   (the phone must be listed as "device", not "unauthorized" or "offline").',
  ],
  ios: [
    'A Mac with Xcode is required for a physical iPhone; this is not possible from Windows or Linux.',
    'Connect the iPhone with a cable, unlock it, and tap "Trust This Computer".',
    'On the iPhone enable Developer Mode: Settings → Privacy & Security → Developer Mode (the phone restarts).',
    'Install a correctly signed build of the app (development provisioning profile that includes this device).',
    'Check with: xcrun xctrace list devices   (the iPhone must be listed under "Devices").',
    'Then `device verify` shows whether the installed Maestro can drive the phone; if it cannot, that is a Maestro/platform limit to report, not something to work around.',
  ],
};

const ANDROID_FIX = {
  unauthorized: [
    'Unlock the phone and look for the "Allow USB debugging?" prompt; tick "Always allow from this computer" and tap Allow.',
    'No prompt? Developer options → "Revoke USB debugging authorizations", unplug and replug, then run: adb kill-server && adb start-server',
  ],
  offline: [
    'Unplug and replug the USB cable (use a data cable) and unlock the phone.',
    'Run: adb kill-server && adb start-server',
    'On the phone switch USB debugging off and on again.',
  ],
  'no permissions': ['Linux: add a udev rule for the phone or run adb with the right group (plugdev); then adb kill-server && adb start-server.'],
  authorizing: ['Wait for the prompt on the phone and accept it.'],
};

export async function adbRun(adb, args, opts = {}) {
  return run(adb, args, { timeoutMs: 30000, ...opts });
}

export async function listAndroidDevices(adb) {
  if (!adb) return { available: false, devices: [] };
  const r = await adbRun(adb, ['devices', '-l']);
  if (r.spawnError || r.code !== 0) return { available: true, error: (r.stderr || r.spawnError || `adb exited with ${r.code}`).trim(), devices: [] };
  const devices = [];
  for (const line of r.stdout.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions|recovery|sideload|bootloader)\b\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, id, state, rest] = m;
    const detail = Object.fromEntries([...rest.matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    const d = {
      id, platform: 'android', state, authorised: state === 'device',
      kind: id.startsWith('emulator-') ? 'emulator' : 'physical',
      transport: id.startsWith('emulator-') ? 'emulator' : (/^usb/.test(rest) || 'usb' in detail ? 'usb' : (id.includes(':') || id.includes('_adb-tls') ? 'wifi' : 'usb')),
      model: detail.model?.replace(/_/g, ' ') ?? null, manufacturer: null, osVersion: null, sdk: null,
    };
    if (state === 'device') {
      const p = await adbRun(adb, ['-s', id, 'shell', 'getprop']);
      const props = Object.fromEntries([...p.stdout.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/gm)].map((x) => [x[1], x[2]]));
      d.model = props['ro.product.model'] || d.model;
      d.manufacturer = props['ro.product.manufacturer'] || null;
      d.osVersion = props['ro.build.version.release'] || null;
      d.sdk = props['ro.build.version.sdk'] || null;
      if (props['ro.kernel.qemu'] === '1' || props['ro.boot.qemu'] === '1' || /^(goldfish|ranchu)$/.test(props['ro.hardware'] ?? '')) { d.kind = 'emulator'; d.transport = 'emulator'; }
    } else d.fix = ANDROID_FIX[state] ?? [`The device is in state "${state}"; reconnect it and run: adb kill-server && adb start-server`];
    devices.push(d);
  }
  return { available: true, devices };
}

export async function listIosDevices(tools) {
  if (process.platform !== 'darwin') {
    return { available: false, supported: false, blocker: `Physical iOS devices need a Mac with Xcode (this host is ${process.platform}).`, devices: [] };
  }
  if (!tools.xcrun) return { available: false, supported: true, blocker: 'xcrun was not found: install Xcode and its command-line tools.', devices: [] };
  const r = await run(tools.xcrun, ['xctrace', 'list', 'devices'], { timeoutMs: TOOL_TIMEOUT });
  const devices = [];
  let section = null;
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^==\s*(.+?)\s*==$/.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const m = /^(.+?)\s+\(([\d.]+)\)\s+\(([0-9A-Fa-f-]{20,})\)$/.exec(line);
    if (!m || !section) continue;
    const [, name, osVersion, id] = m;
    if (section === 'devices' || section === 'devices offline') {
      devices.push({ id, platform: 'ios', name, model: name, osVersion, kind: 'physical', state: section === 'devices' ? 'device' : 'offline', authorised: section === 'devices', transport: 'usb' });
    } else if (section === 'simulators') devices.push({ id, platform: 'ios', name, model: name, osVersion, kind: 'simulator', state: 'available', authorised: true, transport: 'simulator' });
  }
  // developer mode, when devicectl can tell
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mobile-devicectl-'));
  try {
    const out = path.join(dir, 'devices.json');
    const d = await run(tools.xcrun, ['devicectl', 'list', 'devices', '--json-output', out], { timeoutMs: TOOL_TIMEOUT });
    if (d.code === 0 && existsSync(out)) {
      const json = JSON.parse(readFileSync(out, 'utf8'));
      for (const item of json?.result?.devices ?? []) {
        const udid = item.hardwareProperties?.udid ?? item.identifier;
        const match = devices.find((x) => x.id === udid);
        if (match) {
          match.developerMode = item.deviceProperties?.developerModeStatus ?? null;
          match.model = item.hardwareProperties?.marketingName ?? match.model;
          match.devicectlId = item.identifier;
        }
      }
    }
  } catch { /* devicectl is optional */ } finally { rmSync(dir, { recursive: true, force: true }); }
  return { available: true, supported: true, devices };
}

export async function listDevices(tools, platforms) {
  const result = {};
  if (platforms.includes('android')) result.android = await listAndroidDevices(tools.adb);
  if (platforms.includes('ios')) result.ios = await listIosDevices(tools);
  return result;
}

// ---------------------------------------------------------------- app on device

export async function androidAppInfo(adb, deviceId, appId) {
  const r = await adbRun(adb, ['-s', deviceId, 'shell', 'pm', 'list', 'packages', appId]);
  const installed = r.stdout.split(/\r?\n/).some((l) => l.trim() === `package:${appId}`);
  const info = { installed, versionName: null, versionCode: null };
  if (installed) {
    const d = await adbRun(adb, ['-s', deviceId, 'shell', 'dumpsys', 'package', appId]);
    info.versionName = /versionName=(\S+)/.exec(d.stdout)?.[1] ?? null;
    info.versionCode = /versionCode=(\d+)/.exec(d.stdout)?.[1] ?? null;
  }
  return info;
}

export async function iosAppInfo(tools, device, bundleId) {
  if (!tools.xcrun || !device?.devicectlId) return { installed: null, note: 'Installed apps can only be listed with devicectl on a Mac; the launch step of the flow is the proof.' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mobile-devicectl-'));
  try {
    const out = path.join(dir, 'apps.json');
    const r = await run(tools.xcrun, ['devicectl', 'device', 'info', 'apps', '--device', device.devicectlId, '--json-output', out], { timeoutMs: 120000 });
    if (r.code !== 0 || !existsSync(out)) return { installed: null, note: 'devicectl could not list the apps.' };
    const apps = JSON.parse(readFileSync(out, 'utf8'))?.result?.apps ?? [];
    const app = apps.find((a) => a.bundleIdentifier === bundleId);
    return { installed: Boolean(app), versionName: app?.version ?? null, versionCode: app?.bundleVersion ?? null };
  } catch { return { installed: null, note: 'devicectl output could not be read.' }; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Install a build. Only call this after the user approved installing on that specific device. */
export async function installApp(tools, { platform, device, artifact }) {
  if (platform === 'android') {
    if (!tools.adb) return { ok: false, error: 'adb not found' };
    const r = await adbRun(tools.adb, ['-s', device.id, 'install', '-r', '-t', artifact], { timeoutMs: 600000 });
    return { ok: r.code === 0 && /Success/i.test(r.stdout), output: (r.stdout + r.stderr).trim().slice(-600) };
  }
  if (!tools.xcrun) return { ok: false, error: 'xcrun not found (a Mac with Xcode is required)' };
  const r = await run(tools.xcrun, ['devicectl', 'device', 'install', 'app', '--device', device.devicectlId ?? device.id, artifact], { timeoutMs: 600000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim().slice(-600) };
}

/**
 * Is the device usable for Maestro? A device that is merely listed is not enough: Maestro must be able to read its
 * screen (hierarchy) and the application must be installed.
 */
export async function verifyDevice(tools, caps, { platform, device, appId, probeTimeoutSec = 120 }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  add('detected', Boolean(device), device ? `${device.model ?? device.name ?? device.id} (${device.id})` : 'no such device');
  if (!device) return { ready: false, checks };
  add('authorised', device.authorised, device.authorised ? 'authorised for debugging' : `state "${device.state}"`);
  if (platform === 'ios' && device.kind === 'physical' && device.developerMode) add('developer_mode', /enabled/i.test(device.developerMode), `Developer Mode: ${device.developerMode}`);
  if (!device.authorised) return { ready: false, checks, fix: device.fix };
  if (!tools.maestro) { add('maestro_reachable', false, 'Maestro CLI not found'); return { ready: false, checks }; }
  const probe = await run(tools.maestro, withDevice(caps, device.id, ['hierarchy']), { timeoutMs: probeTimeoutSec * 1000 });
  const reachable = probe.code === 0 && /[{[]/.test(probe.stdout);
  add('maestro_reachable', reachable, reachable ? 'Maestro read the screen of the device' : (probe.timedOut ? `timed out after ${probeTimeoutSec}s` : (probe.stderr || probe.stdout || probe.spawnError || `exit ${probe.code}`).trim().split(/\r?\n/).slice(-3).join(' ')));
  let app;
  if (platform === 'android') app = await androidAppInfo(tools.adb, device.id, appId);
  else app = await iosAppInfo(tools, device, appId);
  add('app_installed', app.installed === null ? null : app.installed, app.installed === null ? (app.note ?? 'could not be checked') : app.installed ? `${appId}${app.versionName ? ` ${app.versionName}` : ''}` : `${appId} is not installed on the device`);
  const ready = checks.every((c) => c.ok !== false);
  return { ready, checks, app };
}

// ---------------------------------------------------------------- the tool report

const INSTALL = {
  maestro: isWindows
    ? 'Download maestro.zip from https://github.com/mobile-dev-inc/maestro/releases/latest, extract it, and add its "bin" folder to PATH. Maestro needs Java 17 or newer.'
    : 'curl -fsSL "https://get.maestro.mobile.dev" | bash   (or: brew tap mobile-dev-inc/tap && brew install maestro). Maestro needs Java 17 or newer.',
  java: 'Install a JDK 17 or newer (for example Eclipse Temurin) and make sure `java -version` works.',
  adb: 'Install Android Studio, or the Android SDK command-line tools and "platform-tools", and set ANDROID_HOME (adb lives in platform-tools).',
  flutter: 'Install the Flutter SDK: https://docs.flutter.dev/get-started/install (only needed to build the app, not to run flows).',
  xcode: 'Install Xcode from the Mac App Store, then run: xcode-select --install',
};

export async function preflight({ platforms = [] } = {}) {
  const tools = resolveTools();
  const checks = [];
  const add = (c) => checks.push(c);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add({ id: 'node', name: 'Node.js', status: nodeMajor >= 18 ? 'ok' : 'error', required: true, version: process.versions.node, location: process.execPath, purpose: 'Runs this tooling (needs 18 or newer).' });

  const [mv, jv, fv, av] = await Promise.all([
    versionOf(tools.maestro, ['--version']),
    versionOf(tools.java, ['-version'], (t) => (javaMajor(t) === null ? null : `${/version "([^"]+)"/.exec(t)?.[1] ?? javaMajor(t)}`)),
    tools.flutter ? versionOf(tools.flutter, ['--version'], (t) => /Flutter\s+(\d+\.\d+\.\d+)/.exec(t)?.[1] ?? null, 120000) : { version: null },
    versionOf(tools.adb, ['version'], (t) => /version\s+(\d+\.\d+\.\d+)/.exec(t)?.[1] ?? firstVersion(t)),
  ]);
  const jMajor = jv.raw ? javaMajor(jv.raw) : null;
  add({ id: 'maestro', name: 'Maestro CLI', status: tools.maestro ? (mv.version ? 'ok' : 'warning') : 'missing', required: true, version: mv.version, location: tools.maestro, purpose: 'Runs the YAML flows on the device.', hint: tools.maestro ? undefined : INSTALL.maestro });
  add({ id: 'java', name: 'Java (JDK)', status: tools.java ? (jMajor !== null && jMajor < 17 ? 'warning' : 'ok') : 'missing', required: true, version: jv.version, location: tools.java, purpose: 'Maestro is a Java application (needs 17 or newer).', hint: tools.java ? (jMajor !== null && jMajor < 17 ? 'Java is older than 17; install JDK 17 or newer.' : undefined) : INSTALL.java });
  add({ id: 'flutter', name: 'Flutter SDK', status: tools.flutter ? 'ok' : 'missing', required: false, version: fv.version, location: tools.flutter, purpose: 'Builds the app (flutter build apk / ios). Not needed to run flows against an installed build.', hint: tools.flutter ? undefined : INSTALL.flutter });
  if (platforms.includes('android') || platforms.length === 0) {
    add({ id: 'adb', name: 'Android platform-tools (adb)', status: tools.adb ? 'ok' : 'missing', required: platforms.includes('android'), version: av.version, location: tools.adb, purpose: 'Detects Android devices, installs and inspects the app.', hint: tools.adb ? undefined : INSTALL.adb });
  }
  if (platforms.includes('ios')) {
    if (process.platform !== 'darwin') {
      add({ id: 'xcode', name: 'Xcode', status: 'unsupported', required: true, location: null, purpose: 'iOS devices and simulators are driven through Xcode.', hint: `Not available on ${process.platform}: iOS needs a Mac.` });
    } else {
      const xv = await versionOf(tools.xcodebuild, ['-version']);
      add({ id: 'xcode', name: 'Xcode', status: tools.xcodebuild ? 'ok' : 'missing', required: true, version: xv.version, location: tools.xcodebuild, purpose: 'iOS devices and simulators are driven through Xcode.', hint: tools.xcodebuild ? undefined : INSTALL.xcode });
    }
  }
  const capabilities = await detectCapabilities(tools.maestro);
  const missing = checks.filter((c) => c.required && c.status !== 'ok').map((c) => ({ id: c.id, name: c.name, status: c.status, purpose: c.purpose, hint: c.hint }));
  return {
    ready: missing.length === 0, host: { platform: process.platform, arch: process.arch, release: os.release() },
    checks, missing, capabilities, tools,
  };
}

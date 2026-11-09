// Helpers for tests/mobile.test.mjs: a scaffolded project in a temp folder and fake `maestro` / `adb` programs
// (plain Node scripts on PATH) so the CLI can be exercised end to end without a phone or a Maestro install.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MOBILE_INIT = path.join(PLUGIN, 'scripts', 'mobile-init.mjs');
export const TEMPLATE_CLI = path.join(PLUGIN, 'template', 'mobile', 'tools', 'maestro-cli.mjs');
const isWin = process.platform === 'win32';

export function tempDir(t, prefix = 'mobile-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_MAESTRO = String.raw`
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const log = (e) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(e) + '\n'); };
let a = [...args];
let device = null;
while (a[0] === '--device' || a[0] === '--udid') { device = a[1]; a = a.slice(2); }
const cmd = a[0];
if (args[0] === '--version') { console.log('1.99.0'); process.exit(0); }
if (args[0] === '--help') {
  console.log('Usage: maestro [-v] [--device=<deviceId>] [COMMAND]\nCommands:\n  test          Test a Flow or set of Flows\n  hierarchy     Print out the view hierarchy\n  studio        Launch Maestro Studio\n  check-syntax  Validate a flow');
  process.exit(0);
}
if (cmd === 'test' && a.includes('--help')) {
  console.log('Usage: maestro test [OPTIONS] <flowFile>\n      --debug-output=<path>\n      --format=<format>\n  -e, --env=<env>\n      --include-tags=<tags>\n      --exclude-tags=<tags>');
  process.exit(0);
}
if (cmd === 'hierarchy') {
  if (process.env.FAKE_HIERARCHY_FAIL) { console.error('Failed to connect to device'); process.exit(1); }
  if (process.env.FAKE_HIERARCHY) { process.stdout.write(fs.readFileSync(process.env.FAKE_HIERARCHY, 'utf8')); process.exit(0); }
  console.log(JSON.stringify({ attributes: {}, children: [
    { attributes: { 'resource-id': 'login_submit_button', text: 'Sign in', clickable: 'true', class: 'Button' }, children: [] },
    { attributes: { text: 'Forgot password?', clickable: 'true' }, children: [] },
  ] }));
  process.exit(0);
}
if (cmd === 'test') {
  const flow = a[a.length - 1];
  const text = fs.readFileSync(flow, 'utf8');
  const mode = (/# fake: (\S+)/.exec(text) || [])[1] || 'pass';
  log({ device, argv: args, secretInEnv: !!process.env.MAESTRO_TEST_PASSWORD, cwd: process.cwd(), flow, mode });
  const di = a.indexOf('--debug-output');
  const fail = (lines, code = 1) => {
    if (di >= 0) { fs.mkdirSync(a[di + 1], { recursive: true }); fs.writeFileSync(path.join(a[di + 1], 'screenshot-failed.png'), Buffer.from('89504e470d0a1a0a', 'hex')); }
    lines.forEach((l) => console.log(l)); process.exit(code);
  };
  console.log('Running on ' + device);
  if (mode === 'pass') { console.log(' [Passed] Launch app'); process.exit(0); }
  if (mode === 'print-secret') { console.log('typed ' + process.env.MAESTRO_TEST_PASSWORD); process.exit(0); }
  if (mode === 'element-not-found') fail([' [Failed] Tap on id: login_button', 'Element not found: Id matching regex: login_button']);
  if (mode === 'assert') fail([' [Failed] Assert that id: home_title is visible', 'Assertion is false: id: home_title is visible']);
  if (mode === 'launch-fail') fail(['Unable to launch app com.example.app']);
  if (mode === 'lose-device') { fs.writeFileSync(path.join(process.env.FAKE_STATE, 'device-gone'), '1'); fail(['Device offline']); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  process.exit(0);
}
if (cmd === 'check-syntax') { process.exit(0); }
console.error('fake maestro: unsupported ' + args.join(' '));
process.exit(1);
`;

const FAKE_ADB = String.raw`
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const gone = process.env.FAKE_STATE && fs.existsSync(path.join(process.env.FAKE_STATE, 'device-gone'));
const devices = gone ? [] : JSON.parse(process.env.FAKE_ADB_DEVICES || '[]');
if (a[0] === 'version') { console.log('Android Debug Bridge version 1.0.41'); process.exit(0); }
if (a[0] === 'devices') {
  console.log('List of devices attached');
  for (const d of devices) console.log(d.id + '\t' + d.state + (d.state === 'device' ? ' usb:1-1 product:p model:' + (d.model || 'Pixel_7').replace(/ /g, '_') + ' device:d transport_id:1' : ''));
  process.exit(0);
}
if (a[0] === '-s') {
  const d = devices.find((x) => x.id === a[1]);
  if (!d) { console.error('error: device ' + a[1] + ' not found'); process.exit(1); }
  const rest = a.slice(2);
  if (rest[0] === 'shell' && rest[1] === 'getprop') {
    const p = Object.assign({ 'ro.product.model': d.model || 'Pixel 7', 'ro.product.manufacturer': 'Google', 'ro.build.version.release': '14', 'ro.build.version.sdk': '34', 'ro.hardware': 'tensor' }, d.props || {});
    for (const [k, v] of Object.entries(p)) console.log('[' + k + ']: [' + v + ']');
    process.exit(0);
  }
  if (rest[0] === 'shell' && rest[1] === 'pm') { (d.packages || []).filter((p) => p === rest[4]).forEach((p) => console.log('package:' + p)); process.exit(0); }
  if (rest[0] === 'shell' && rest[1] === 'dumpsys') { console.log('    versionCode=42 minSdk=24\n    versionName=1.2.3'); process.exit(0); }
  if (rest[0] === 'shell') process.exit(0);
  if (rest[0] === 'pull') { fs.writeFileSync(rest[2], 'png'); process.exit(0); }
  if (rest[0] === 'install') { console.log('Success'); process.exit(0); }
}
process.exit(0);
`;

/** Create fake maestro + adb in <dir>/fake-bin and return the directory. */
export function makeFakeBin(dir, { maestro = true, adb = true } = {}) {
  const bin = path.join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const tool = (name, source) => {
    const js = path.join(bin, `${name}.js`);
    writeFileSync(js, source);
    if (isWin) writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    else {
      writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
  };
  if (maestro) tool('maestro', FAKE_MAESTRO);
  if (adb) tool('adb', FAKE_ADB);
  return bin;
}

export const PHONE = { id: 'R5CT1234ABC', state: 'device', model: 'Pixel 7', packages: ['com.example.app'] };
export const EMULATOR = { id: 'emulator-5554', state: 'device', model: 'sdk gphone64', props: { 'ro.kernel.qemu': '1' }, packages: ['com.example.app'] };

/** PATH with the fake tools first and nothing else that could provide maestro/adb (Node's own folder stays). */
export function pathWith(bin) {
  return [bin, path.dirname(process.execPath)].join(path.delimiter);
}

export class Project {
  constructor(root, bin, state) { this.root = root; this.bin = bin; this.state = state; this.devices = [PHONE]; this.extraEnv = {}; }
  get fw() { return path.join(this.root, 'mobile-automation'); }
  get cli() { return path.join(this.fw, 'tools', 'maestro-cli.mjs'); }
  env() {
    return {
      ...process.env, PATH: pathWith(this.bin), FAKE_ADB_DEVICES: JSON.stringify(this.devices), FAKE_STATE: this.state,
      FAKE_LOG: path.join(this.state, 'maestro-calls.jsonl'), ANDROID_HOME: '', ANDROID_SDK_ROOT: '', HOME: this.state, USERPROFILE: this.state, ...this.extraEnv,
    };
  }
  run(args, { cli = this.cli, cwd = this.root } = {}) {
    const r = spawnSync(process.execPath, [cli, ...args, '--root', this.root], { encoding: 'utf8', env: this.env(), cwd });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  }
  write(rel, content) {
    const file = path.join(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }
  writeFlow(rel, content) { return this.write(path.join('mobile-automation', 'flows', rel), content); }
  saveConfig(patch) {
    const r = this.run(['config', 'save', '--json', JSON.stringify(patch)]);
    if (r.code !== 0) throw new Error(`config save failed: ${r.stdout}`);
    return r.json;
  }
}

/** A scaffolded project with a valid Android configuration, the fake tools on PATH and one physical phone connected. */
export function newProject(t, { configure = true, bin = {}, spaced = false } = {}) {
  let root = tempDir(t);
  if (spaced) { root = path.join(root, 'my mobile project'); mkdirSync(root, { recursive: true }); }
  const state = tempDir(t, 'mobile-fake-state-');
  const fakeBin = makeFakeBin(state, bin);
  const init = spawnSync(process.execPath, [MOBILE_INIT, '--root', root], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`scaffold failed: ${init.stdout}`);
  const p = new Project(root, fakeBin, state);
  if (configure) {
    p.saveConfig({ platforms: { android: { enabled: true, appId: 'com.example.app' } }, environments: { default: 'staging' } });
    p.write('mobile-automation/config/environments/staging.json', JSON.stringify({ BASE_URL: 'https://staging.example.test' }));
    p.write('mobile-automation/.env', 'TEST_PASSWORD=Sup3rSecret!x\n');
  }
  return p;
}

export const testFlow = ({ id = 'TC-001', fake = 'pass', tags = ['smoke', 'regression'], body = null, header = true } = {}) => `${header ? '# @builder:generated — owned by the pipeline (regenerated from its test case). Delete this line to take ownership.\n' : ''}# testCase: ${id}
# fake: ${fake}
appId: \${APP_ID}
name: "[${id}] Flow ${id}"
tags: [${tags.join(', ')}]
---
${body ?? `- runFlow: ../common/launch-app.yaml
- tapOn:
    id: some_button
- inputText: \${MAESTRO_TEST_PASSWORD}
- assertVisible:
    id: some_title
`}`;

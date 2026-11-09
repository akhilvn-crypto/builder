// Read-only discovery of the Flutter application: where it is, its Android/iOS identifiers and flavors, existing builds,
// existing tests and automation, and which accessibility identifiers the Dart code already exposes. Writes nothing.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readText, toPosix, walkFiles } from './util.mjs';

const SKIP_DIRS = ['node_modules', '.dart_tool', 'build', '.git', 'Pods', '.gradle', '.idea', '.symlinks', 'ephemeral', 'reports', 'artifacts'];

function pubspecInfo(file) {
  const text = readText(file, '');
  const top = (key) => new RegExp(`^${key}:\\s*["']?([^"'\\r\\n#]+?)["']?\\s*(?:#.*)?$`, 'm').exec(text)?.[1]?.trim() ?? null;
  return {
    name: top('name'),
    version: top('version'),
    isFlutter: /^\s+flutter:\s*\r?\n\s+sdk:\s*flutter\b/m.test(text),
  };
}

function braceBlock(text, startIdx) {
  let depth = 0;
  for (let i = text.indexOf('{', startIdx); i < text.length && i !== -1; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(text.indexOf('{', startIdx) + 1, i); }
  }
  return '';
}

function androidInfo(appRoot) {
  const dir = path.join(appRoot, 'android', 'app');
  const gradle = ['build.gradle.kts', 'build.gradle'].map((f) => path.join(dir, f)).find((f) => existsSync(f));
  if (!existsSync(path.join(appRoot, 'android'))) return { present: false };
  const info = { present: true, buildFile: gradle ? toPosix(path.relative(appRoot, gradle)) : null, applicationIds: [], namespace: null, flavors: [], notes: [] };
  if (!gradle) { info.notes.push('android/app/build.gradle(.kts) not found'); return info; }
  const text = readText(gradle, '');
  const ids = [...text.matchAll(/applicationId\s*(?:=\s*)?["']([^"']+)["']/g)].map((m) => m[1]);
  info.applicationIds = [...new Set(ids)];
  if (/applicationId\s*(?:=\s*)?[^"'\s]/.test(text) && ids.length === 0) info.notes.push('applicationId is computed in the Gradle file; read it from the installed app or ask the app team');
  info.namespace = /namespace\s*(?:=\s*)?["']([^"']+)["']/.exec(text)?.[1] ?? null;
  const pf = text.indexOf('productFlavors');
  if (pf !== -1) {
    const body = braceBlock(text, pf);
    // top-level entries of the block: name { … } / create("name") { … } / register("name") { … }
    let depth = 0;
    let buf = '';
    const names = [];
    for (const ch of body) {
      if (ch === '{') { if (depth === 0) names.push(buf); depth += 1; buf = ''; } else if (ch === '}') depth -= 1;
      else if (depth === 0) buf += ch;
    }
    for (const raw of names) {
      const m = /(?:create|register|getByName)\(\s*["'](\w+)["']\s*\)\s*$/.exec(raw.trim()) ?? /([A-Za-z_]\w*)\s*$/.exec(raw.trim());
      if (m) info.flavors.push(m[1]);
    }
    const suffixes = [...text.matchAll(/applicationIdSuffix\s*(?:=\s*)?["']([^"']+)["']/g)].map((m) => m[1]);
    if (suffixes.length) info.notes.push(`applicationIdSuffix used (${[...new Set(suffixes)].join(', ')}): the installed id differs from the base id`);
  }
  return info;
}

function iosInfo(appRoot) {
  const proj = path.join(appRoot, 'ios', 'Runner.xcodeproj', 'project.pbxproj');
  if (!existsSync(path.join(appRoot, 'ios'))) return { present: false };
  const info = { present: true, bundleIds: [], testBundleIds: [], schemes: [], notes: [] };
  const text = readText(proj, null);
  if (text === null) { info.notes.push('ios/Runner.xcodeproj/project.pbxproj not found'); return info; }
  const ids = [...new Set([...text.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?\s*;/g)].map((m) => m[1]))];
  info.bundleIds = ids.filter((i) => !/\.RunnerTests$/.test(i));
  info.testBundleIds = ids.filter((i) => /\.RunnerTests$/.test(i));
  if (info.bundleIds.some((i) => i.includes('$('))) info.notes.push('a bundle identifier is built from build settings ($(...)); read the resolved value from the .xcconfig files or the built app');
  const schemeDir = path.join(appRoot, 'ios', 'Runner.xcodeproj', 'xcshareddata', 'xcschemes');
  if (existsSync(schemeDir)) info.schemes = readdirSync(schemeDir).filter((f) => f.endsWith('.xcscheme')).map((f) => f.replace(/\.xcscheme$/, ''));
  return info;
}

function builds(appRoot) {
  const out = [];
  const add = (abs, platform, type) => {
    try {
      const st = statSync(abs);
      out.push({ path: toPosix(path.relative(appRoot, abs)), platform, type, sizeBytes: st.isDirectory() ? null : st.size, modified: st.mtime.toISOString() });
    } catch { /* gone */ }
  };
  const apkRoot = path.join(appRoot, 'build', 'app', 'outputs');
  for (const f of walkFiles(apkRoot, { maxDepth: 5 })) if (/\.apk$/i.test(f) && !/unaligned/i.test(f)) add(f, 'android', 'apk');
  for (const f of walkFiles(apkRoot, { maxDepth: 5 })) if (/\.aab$/i.test(f)) add(f, 'android', 'aab (cannot be installed directly)');
  const iosRoot = path.join(appRoot, 'build', 'ios');
  if (existsSync(iosRoot)) {
    for (const kind of ['iphoneos', 'iphonesimulator']) {
      const d = path.join(iosRoot, kind);
      if (existsSync(d)) for (const e of readdirSync(d)) if (e.endsWith('.app')) add(path.join(d, e), 'ios', kind === 'iphoneos' ? 'app (device)' : 'app (simulator only)');
    }
    for (const f of walkFiles(path.join(iosRoot, 'ipa'), { maxDepth: 1 })) if (/\.ipa$/i.test(f)) add(f, 'ios', 'ipa');
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** `identifier: 'x'` values in Dart (Semantics(identifier: …)). These are what Maestro sees as id on Android and iOS. */
export function scanIdentifiers(appRoot, { limit = 3000 } = {}) {
  const libDir = path.join(appRoot, 'lib');
  const identifiers = new Map();
  const stats = { dartFiles: 0, semanticsWidgets: 0, semanticsLabels: 0, keys: 0 };
  for (const f of walkFiles(libDir, { skip: SKIP_DIRS }).filter((x) => x.endsWith('.dart'))) {
    stats.dartFiles += 1;
    const text = readText(f, '');
    stats.semanticsWidgets += (text.match(/\bSemantics\s*\(/g) ?? []).length;
    stats.semanticsLabels += (text.match(/\b(?:semanticsLabel|label)\s*:\s*['"]/g) ?? []).length;
    stats.keys += (text.match(/\b(?:Value)?Key\s*\(\s*['"]/g) ?? []).length;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bidentifier\s*:\s*['"]([^'"$]+)['"]/g)) {
        if (identifiers.size < limit && !identifiers.has(m[1])) identifiers.set(m[1], { id: m[1], file: toPosix(path.relative(appRoot, f)), line: i + 1 });
      }
    });
  }
  return { stats, identifiers: [...identifiers.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function findPubspecs(root, depth = 4) {
  return walkFiles(root, { skip: [...SKIP_DIRS, 'android', 'ios', 'macos', 'linux', 'windows', 'web', 'lib', 'test'], maxDepth: depth })
    .filter((f) => path.basename(f) === 'pubspec.yaml');
}

export function discover(ctx, { app } = {}) {
  const result = { projectRoot: ctx.root, flutter: null, candidates: [], ambiguous: false };
  const explicit = app ? path.resolve(ctx.root, app) : null;
  const pubspecs = explicit ? [path.join(explicit, 'pubspec.yaml')].filter((f) => existsSync(f)) : findPubspecs(ctx.root);
  const apps = pubspecs.map((f) => ({ file: f, dir: path.dirname(f), ...pubspecInfo(f) })).filter((a) => a.isFlutter);
  const withPlatforms = apps.filter((a) => existsSync(path.join(a.dir, 'android')) || existsSync(path.join(a.dir, 'ios')));
  const pool = withPlatforms.length ? withPlatforms : apps;
  result.candidates = pool.map((a) => ({ root: toPosix(path.relative(ctx.root, a.dir)) || '.', name: a.name, version: a.version }));
  if (pool.length === 0) {
    result.note = explicit
      ? `No Flutter pubspec.yaml found in ${toPosix(path.relative(ctx.root, explicit)) || '.'}.`
      : 'No Flutter app found under the project root (looked for pubspec.yaml with "sdk: flutter" up to 4 levels deep). Give the app folder with --app.';
  } else if (pool.length > 1) {
    result.ambiguous = true;
    result.note = 'More than one Flutter app was found: ask which one is under test and pass it as --app.';
  }
  if (pool.length === 1 || (explicit && pool.length >= 1)) {
    const chosen = pool[0];
    const appRoot = chosen.dir;
    const sem = scanIdentifiers(appRoot);
    result.flutter = {
      root: toPosix(path.relative(ctx.root, appRoot)) || '.', name: chosen.name, version: chosen.version,
      android: androidInfo(appRoot), ios: iosInfo(appRoot),
      builds: builds(appRoot),
      accessibility: { ...sem.stats, identifiers: sem.identifiers.length, sample: sem.identifiers.slice(0, 8).map((i) => i.id) },
      existingTests: {
        integrationTest: existsSync(path.join(appRoot, 'integration_test')),
        widgetTests: existsSync(path.join(appRoot, 'test')),
        maestroFolders: ['.maestro', 'maestro'].filter((d) => existsSync(path.join(appRoot, d))),
      },
    };
  }
  const here = (...p) => path.join(ctx.root, ...p);
  result.automation = {
    mobileFramework: existsSync(ctx.p.scaffold) ? ctx.rel(ctx.fw) : null,
    playwrightFramework: existsSync(here('automation')) && existsSync(here('dependencies')),
    testDesignOutput: existsSync(here('test-design', 'test-cases')) ? 'test-design/test-cases' : null,
  };
  return result;
}

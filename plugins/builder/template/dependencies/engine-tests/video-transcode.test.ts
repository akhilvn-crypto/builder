// video-transcode: an ffmpeg that is already installed turns the WebM recordings into H.264 MP4; nothing is ever installed here.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { convertToMp4, findFfmpeg, looksLikeMp4, type RunTool } from '../engine/pipeline/video-transcode.ts';
import { tmpRoot } from './helpers.ts';

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

test('findFfmpeg takes FFMPEG_PATH when set, else ffmpeg on the PATH, and needs libx264', () => {
  const asked: string[] = [];
  const run = (stdout: string, status = 0): RunTool => (command) => { asked.push(command); return { status, stdout, stderr: '' }; };

  assert.deepEqual(findFfmpeg({}, run(' V....D libx264   H.264')), { ok: true, command: 'ffmpeg' });
  assert.deepEqual(findFfmpeg({ FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe' }, run(' V....D libx264')), { ok: true, command: 'C:\\tools\\ffmpeg.exe' });
  assert.deepEqual(asked, ['ffmpeg', 'C:\\tools\\ffmpeg.exe'], 'a set FFMPEG_PATH is the only candidate');

  const noX264 = findFfmpeg({}, run(' V....D libvpx-vp9\n VF...D png'));
  assert.equal(noX264.ok, false);
  assert.match(!noX264.ok ? noX264.reason : '', /no libx264/);

  const missing = findFfmpeg({ FFMPEG_PATH: 'nowhere' }, () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }));
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.reason : '', /nowhere could not be run.*FFMPEG_PATH/);
});

test('convertToMp4 asks for H.264 yuv420p with even sizes and an up-front index, writes atomically and reuses a newer MP4', (t) => {
  const root = tmpRoot(t);
  const source = path.join(root, 'in', 'video.webm');
  const target = path.join(root, 'out', 'videos', 'video.mp4');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'webm');

  const calls: string[][] = [];
  const run: RunTool = (_command, args) => {
    calls.push(args);
    writeFileSync(args.at(-1)!, MP4_HEAD); // ffmpeg writes the temporary name given last
    return { status: 0, stdout: '', stderr: '' };
  };

  const r = convertToMp4('ffmpeg', source, target, run);
  assert.deepEqual([r.ok, r.reason, r.bytes], [true, null, MP4_HEAD.length]);
  assert.ok(looksLikeMp4(readFileSync(target)));
  assert.ok(!existsSync(`${target}.partial`), 'the temporary file is renamed away');
  const args = calls[0]!.join(' ');
  for (const needle of ['-c:v libx264', '-pix_fmt yuv420p', '-movflags +faststart', '-an', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', 'fps=25', `-i ${source}`]) {
    assert.ok(args.includes(needle), needle);
  }

  assert.equal(convertToMp4('ffmpeg', source, target, run).ok, true);
  assert.equal(calls.length, 1, 'an MP4 newer than its source is not converted again');
});

test('a failing or empty conversion leaves no MP4 behind and says why', (t) => {
  const root = tmpRoot(t);
  const source = path.join(root, 'v.webm');
  writeFileSync(source, 'webm');

  const failing = convertToMp4('ffmpeg', source, path.join(root, 'o', 'a.mp4'), () => ({ status: 1, stdout: '', stderr: 'Unknown encoder libx264\nConversion failed!' }));
  assert.equal(failing.ok, false);
  assert.match(failing.reason!, /could not convert v\.webm.*Conversion failed/);
  assert.ok(!existsSync(path.join(root, 'o', 'a.mp4')));

  const empty = convertToMp4('ffmpeg', source, path.join(root, 'o', 'b.mp4'), (_command, args) => { writeFileSync(args.at(-1)!, ''); return { status: 0, stdout: '', stderr: '' }; });
  assert.equal(empty.ok, false);
  assert.ok(!existsSync(path.join(root, 'o', 'b.mp4')));
  assert.ok(!existsSync(path.join(root, 'o', 'b.mp4.partial')));

  assert.equal(looksLikeMp4(Buffer.from('not an mp4 at all')), false);
});

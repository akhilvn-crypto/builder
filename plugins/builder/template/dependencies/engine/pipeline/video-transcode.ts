// Turns Playwright's WebM recordings into H.264 MP4, the one video format PDF viewers play inside a page (the evidence PDF's
// in-page players, see pdf-embed.ts). It uses an ffmpeg that is ALREADY on the machine (the FFMPEG_PATH variable, else `ffmpeg` on
// the PATH) and never installs one: Playwright's own bundled ffmpeg can only write VP8/VP9, and adding a transcoder is a dependency
// the user has to approve. Without a usable ffmpeg every function says why, and the report keeps the WebM as a file attachment.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export type FfmpegProbe = { ok: true; command: string } | { ok: false; reason: string };

export type RunTool = (command: string, args: string[], timeoutMs: number) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

const defaultRun: RunTool = (command, args, timeoutMs) => spawnSync(command, args, {
  encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
});

export const FFMPEG_HOWTO = 'install an ffmpeg build that includes libx264 (for example from ffmpeg.org) and put it on the PATH or set FFMPEG_PATH, then build the report again';

// The first ffmpeg that runs and can encode H.264.
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env, run: RunTool = defaultRun): FfmpegProbe {
  const fromEnv = env.FFMPEG_PATH?.trim();
  const candidates = fromEnv ? [fromEnv] : ['ffmpeg'];
  const problems: string[] = [];
  for (const command of candidates) {
    const r = run(command, ['-hide_banner', '-encoders'], 20_000);
    if (r.error || r.status !== 0) {
      problems.push(`${command} could not be run`);
      continue;
    }
    if (!/\blibx264\b/.test(r.stdout ?? '')) {
      problems.push(`${command} has no libx264 encoder`);
      continue;
    }
    return { ok: true, command };
  }
  return { ok: false, reason: `${problems.join('; ')}${fromEnv ? ' (from FFMPEG_PATH)' : ''}` };
}

export interface Mp4Result {
  ok: boolean;
  file: string;
  bytes: number;
  reason: string | null;
}

// Main-profile H.264, yuv420p, constant 25 fps, even dimensions, no audio, index up front. Written to a temporary name and renamed,
// so an interrupted run never leaves a half-written MP4 that a later build would trust. An MP4 newer than its source is reused.
export function convertToMp4(command: string, source: string, target: string, run: RunTool = defaultRun): Mp4Result {
  const fail = (reason: string): Mp4Result => ({ ok: false, file: target, bytes: 0, reason });
  try {
    if (existsSync(target) && statSync(target).size > 0 && statSync(target).mtimeMs >= statSync(source).mtimeMs) {
      return { ok: true, file: target, bytes: statSync(target).size, reason: null };
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    const r = run(command, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-an',
      '-vf', 'fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '28',
      '-movflags', '+faststart', '-f', 'mp4', partial,
    ], 10 * 60_000);
    if (r.error || r.status !== 0 || !existsSync(partial) || statSync(partial).size === 0) {
      rmSync(partial, { force: true });
      const detail = `${r.error?.message ?? ''} ${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      return fail(`ffmpeg could not convert ${path.basename(source)}${detail ? `: ${detail}` : ''}`);
    }
    rmSync(target, { force: true });
    renameSync(partial, target);
    return { ok: true, file: target, bytes: statSync(target).size, reason: null };
  } catch (err) {
    return fail(`converting ${path.basename(source)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// An MP4 starts with a box header whose type is "ftyp".
export function looksLikeMp4(head: Buffer): boolean {
  return head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp';
}

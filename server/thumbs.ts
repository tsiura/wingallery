// Thumbnails and HEIC previews. Each is made on first use, by vipsthumbnail (photos, HEIC) or ffmpeg (video posters), and kept as a JPEG under
// DATA_DIR/cache, never next to the media. However many requests ask for the same file at once, one job makes it, and only a few jobs run together.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { MediaKind } from '../shared/types.ts';
import type { Config } from './config.ts';
import { HttpError } from './http.ts';
import { pLimit } from './limit.ts';
import { log } from './log.ts';
import { runProcess } from './proc.ts';
import type { RunFn } from './proc.ts';

interface Version { size: number; mtimeMs: number }

// Both resolve with the path of a cache file. `rel` is the path below MEDIA_ROOT, the same for everyone who may see the file; with its size and
// mtime it names the cache file, so an edited file gets a new one. A picture that can't be made is an HttpError 422 (Review Focus 2).
export interface Thumbnailer {
  thumb(abs: string, rel: string, st: Version, kind: MediaKind): Promise<string>;
  preview(abs: string, rel: string, st: Version): Promise<string>;
}

// -vf: at most 480 px either way, the aspect ratio kept, a small clip not enlarged.
const POSTER_SCALE = "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease";

// Members upload these files, so a tool is only ever handed an absolute path (locate() makes them): a relative one could be read as an option (`-i`).
function absolute(abs: string): string {
  if (!isAbsolute(abs)) throw new Error(`Not an absolute path: ${abs}`);
  return abs;
}

// ponytail: the cache is never pruned (an edited file leaves its old thumbnail behind), and a file that fails is tried again on every request. Prune by
// age, or remember failures for a while, if either shows up. vipsthumbnail reads %s in the -o path as the input's name: DATA_DIR must not hold one.
export function createThumbnailer(cfg: Config, run: RunFn = runProcess): Thumbnailer {
  const limit = pLimit(Math.min(4, availableParallelism()));
  const inflight = new Map<string, Promise<string>>();

  // The outcome of a tool is a picture, a non-empty file at `out`. Anything else is thrown as it came.
  async function runInto(cmd: string, args: string[], out: string, timeoutMs: number): Promise<void> {
    await run(cmd, args, timeoutMs);
    const made = await stat(out).catch(() => null);
    if (!made || made.size === 0) throw new Error(`${cmd} left no picture`);
  }

  // A picture we can't make is a 422 for the client and a line in the log for the owner. A tool that is not installed, one killed at its timeout and one
  // that crashed would otherwise look like a corrupt file: grey icons and nothing to go on. What a tool says is cut, so a hostile file can't fill the log.
  async function produce(rel: string, cmd: string, args: string[], out: string, timeoutMs: number): Promise<void> {
    try {
      await runInto(cmd, args, out, timeoutMs);
    } catch (err) {
      log('error', { message: 'Preview tool failed', cmd, rel, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
      throw new HttpError(422, 'No preview available');
    }
  }

  // The output argument comes last. vips takes the JPEG options in brackets after the file name.
  const vips = (rel: string, abs: string, tmp: string, side: number, quality: number, timeoutMs: number) =>
    produce(rel, 'vipsthumbnail', [absolute(abs), '--size', `${side}x${side}>`, '-o', `${tmp}[Q=${quality},strip]`], tmp, timeoutMs);

  // The frame at 1 s. A clip shorter than that has none there (ffmpeg exits non-zero or leaves nothing), so its first frame is tried next (F3); the
  // first try's failure is how such a clip is handled, not a fault, so only the last one's is reported.
  // ffmpeg opens whatever the file says it is, whatever its name (a member chooses that), so it is held to what a poster needs. Only the file protocol may
  // be opened (R3). And only the MP4/MOV and Matroska/WebM demuxers may read it: a "video" that is really a DASH manifest would otherwise name a file of
  // another share, and its poster would be a frame of that file. The four video extensions are one or the other of those, so no format is forced.
  async function poster(rel: string, abs: string, tmp: string): Promise<void> {
    const grab = (ss: string) => ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska', '-ss', ss, '-i', absolute(abs),
      '-frames:v', '1', '-vf', POSTER_SCALE, '-q:v', '5', '-y', tmp];
    await runInto('ffmpeg', grab('1'), tmp, 30_000).catch(() => produce(rel, 'ffmpeg', grab('0'), tmp, 30_000));
  }

  // The tool writes next to the final name under a temp name of its own, so a reader never sees half a file and a crash leaves no bad one.
  async function fill(dir: string, final: string, make: (tmp: string) => Promise<void>): Promise<string> {
    if (await stat(final).then((s) => s.isFile() && s.size > 0, () => false)) return final;
    await mkdir(dir, { recursive: true });
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp.jpg`;
    try {
      await limit(() => make(tmp));
      await rename(tmp, final);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return final;
  }

  function cached(sub: 'thumbs' | 'previews', rel: string, st: Version, make: (tmp: string) => Promise<void>): Promise<string> {
    const dir = join(cfg.dataDir, 'cache', sub);
    const final = join(dir, createHash('sha1').update(`${rel}\0${st.size}\0${st.mtimeMs}`).digest('hex') + '.jpg');
    let job = inflight.get(final);
    if (!job) {
      job = fill(dir, final, make).finally(() => inflight.delete(final));
      inflight.set(final, job);
    }
    return job;
  }

  return {
    thumb: (abs, rel, st, kind) => cached('thumbs', rel, st, (tmp) => (kind === 'video' ? poster(rel, abs, tmp) : vips(rel, abs, tmp, 480, 80, 30_000))),
    preview: (abs, rel, st) => cached('previews', rel, st, (tmp) => vips(rel, abs, tmp, 2560, 85, 60_000)),
  };
}

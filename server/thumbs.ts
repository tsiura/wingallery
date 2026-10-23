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

  // A tool that exits non-zero, times out, isn't installed or leaves no picture behind means a file we can't show.
  async function produce(cmd: string, args: string[], out: string, timeoutMs: number): Promise<void> {
    try {
      await run(cmd, args, timeoutMs);
      if ((await stat(out)).size === 0) throw new Error('empty output');
    } catch {
      throw new HttpError(422, 'No preview available');
    }
  }

  // The output argument comes last. vips takes the JPEG options in brackets after the file name.
  const vips = (abs: string, tmp: string, side: number, quality: number, timeoutMs: number) =>
    produce('vipsthumbnail', [absolute(abs), '--size', `${side}x${side}>`, '-o', `${tmp}[Q=${quality},strip]`], tmp, timeoutMs);

  // The frame at 1 s. A clip shorter than that has none there (ffmpeg exits non-zero or leaves nothing), so its first frame is tried next (F3).
  // Only the file protocol may be opened (R3): a crafted video must not make ffmpeg reach out to the network or anything else.
  async function poster(abs: string, tmp: string): Promise<void> {
    const grab = (ss: string) => produce('ffmpeg', ['-v', 'error', '-protocol_whitelist', 'file', '-ss', ss, '-i', absolute(abs),
      '-frames:v', '1', '-vf', POSTER_SCALE, '-q:v', '5', '-y', tmp], tmp, 30_000);
    await grab('1').catch(() => grab('0'));
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
    thumb: (abs, rel, st, kind) => cached('thumbs', rel, st, (tmp) => (kind === 'video' ? poster(abs, tmp) : vips(abs, tmp, 480, 80, 30_000))),
    preview: (abs, rel, st) => cached('previews', rel, st, (tmp) => vips(abs, tmp, 2560, 85, 60_000)),
  };
}

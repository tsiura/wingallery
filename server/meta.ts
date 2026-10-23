// Size in pixels, date taken and duration of a photo or video: read from the file (EXIF, image headers, ffprobe) and cached in media_meta,
// keyed by path and valid while the file's size and mtime stay as they were. A file that can't be read leaves its fields null; it never throws.

import { open } from 'node:fs/promises';
import exifr from 'exifr';
import { imageSize } from 'image-size';
import type { MediaKind, Meta } from '../shared/types.ts';
import type { DB } from './db.ts';
import { pLimit } from './limit.ts';
import { mediaTypeOf } from './mediatypes.ts';
import { runProcess } from './proc.ts';
import type { RunFn } from './proc.ts';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

// EXIF holds the camera's wall clock as 'YYYY:MM:DD HH:mm:ss', with no zone. It stays a string from file to JSON (R2): as a Date it would be
// read in the host's timezone. Null when it is no date; a camera whose clock was never set writes '0000:00:00 00:00:00' or blanks.
export function exifToWallClock(s: string): string | null {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

// An instant (ms since the epoch) as the wall clock of this process's timezone, in the same shape. Stands in when a file has no date of its own.
export function instantToWallClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// translateValues:false keeps Orientation a number; reviveValues:false keeps DateTimeOriginal the raw string (R2).
const EXIF = { pick: ['DateTimeOriginal', 'Orientation', 'ExifImageWidth', 'ExifImageHeight'], translateValues: false, reviveValues: false };

const HEAD_BYTES = 512 * 1024;   // all that image-size's own file reader looks at, and more than exifr needs

// The first bytes of a photo. exifr and image-size both parse these in memory, so the file is opened once and closed here. Handing exifr the
// path instead leaves its file handle open when the file is shorter than two bytes, which Node reports when it collects it (DEP0137).
async function readHead(abs: string): Promise<Buffer> {
  const file = await open(abs, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

// A file may not be what its name says, and each reader fails in its own way on that: what one can't read stays null (Review Focus 2).
async function attempt<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function photoMeta(abs: string, mtimeMs: number): Promise<Meta> {
  const head = await attempt(() => readHead(abs));
  const exif = head ? await attempt(() => exifr.parse(head, EXIF)) : null;
  let width: number | null = null, height: number | null = null;
  // image-size misreads HEIC/HEIF that carry a 'clap' crop (our sample is 64x48 and comes out 63x64), so their EXIF size goes first (R1).
  if (mediaTypeOf(abs)?.convert) [width, height] = [positive(exif?.ExifImageWidth), positive(exif?.ExifImageHeight)];
  if (head && (width === null || height === null)) {
    const size = await attempt(() => imageSize(head));
    [width, height] = [positive(size?.width), positive(size?.height)];
  }
  const turn = exif?.Orientation;
  if (typeof turn === 'number' && turn >= 5 && turn <= 8) [width, height] = [height, width];   // turned by a quarter: shown the other way round
  const taken = typeof exif?.DateTimeOriginal === 'string' ? exifToWallClock(exif.DateTimeOriginal) : null;
  return { width, height, takenAt: taken ?? instantToWallClock(mtimeMs), duration: null };
}

// The first video stream and the container, as JSON. Rotation is a side-data entry, or on older files the `rotate` tag.
const PROBE = ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:format_tags=creation_time'];

interface Probe {
  streams?: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
  format?: { duration?: string; tags?: { creation_time?: string } };
}

async function videoMeta(abs: string, mtimeMs: number, run: RunFn): Promise<Meta> {
  // ffprobe missing, a file it can't read or output that isn't JSON: the video is listed without size and duration
  const probe = await attempt<Probe | null>(async () => JSON.parse(await run('ffprobe', [...PROBE, abs], 15_000)));
  const stream = probe?.streams?.[0];
  let width = positive(stream?.width), height = positive(stream?.height);
  const rotation = Number(stream?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? stream?.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = Number(probe?.format?.duration);   // NaN when absent or 'N/A'
  const created = Date.parse(probe?.format?.tags?.creation_time ?? '');
  return {
    width, height,
    takenAt: instantToWallClock(Number.isFinite(created) ? created : mtimeMs),
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
  };
}

export function extractMeta(abs: string, kind: MediaKind, mtimeMs: number, run: RunFn = runProcess): Promise<Meta> {
  return kind === 'video' ? videoMeta(abs, mtimeMs, run) : photoMeta(abs, mtimeMs);
}

const extractLimit = pLimit(4);

interface MetaRow { size: number; mtime_ms: number; width: number | null; height: number | null; taken_at: string; duration_s: number | null }

// `rel` is the path below MEDIA_ROOT: the cache key, the same for every user who can see the file. A row is good while size and mtime match.
export async function getMeta(db: DB, abs: string, rel: string, st: { size: number; mtimeMs: number }, kind: MediaKind): Promise<Meta> {
  const mtime = Math.floor(st.mtimeMs);
  const row = db.prepare('select size, mtime_ms, width, height, taken_at, duration_s from media_meta where rel_path = ?').get(rel) as MetaRow | undefined;
  if (row && row.size === st.size && row.mtime_ms === mtime) return { width: row.width, height: row.height, takenAt: row.taken_at, duration: row.duration_s };
  const meta = await extractLimit(() => extractMeta(abs, kind, st.mtimeMs));
  db.prepare('insert or replace into media_meta (rel_path, size, mtime_ms, width, height, taken_at, duration_s) values (?, ?, ?, ?, ?, ?, ?)')
    .run(rel, st.size, mtime, meta.width, meta.height, meta.takenAt, meta.duration);
  return meta;
}

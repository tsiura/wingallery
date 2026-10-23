// Size in pixels, date taken and duration of a photo or video, cached in media_meta by path and valid while the file's size and mtime stay as
// they were. Photos are parsed in worker threads (metaworker.ts), videos by ffprobe, a subprocess with a timeout. Either way a file that can't be
// read, or that takes too long, leaves its fields null: it never throws, and it never freezes the server.

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { MediaKind, Meta } from '../shared/types.ts';
import type { DB } from './db.ts';
import { pLimit } from './limit.ts';
import { log } from './log.ts';
import type { PhotoResult, WorkerMessage } from './metaworker.ts';
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

interface Job { abs: string; rel: string; resolve: (result: PhotoResult | null) => void }

// Parses photos in worker threads, one job per worker at a time and the rest queued behind them. A worker that takes longer than timeoutMs, throws
// or dies is terminated, and a new one starts when a job next needs it; its job is answered with null. The photo is then listed without size and
// date, which is stored like any other parse failure, so the folder doesn't freeze again on its next listing. Workers start on the first job.
// A job that reads a HEIC by path (metaworker.ts says so before it starts) is the one that may be slow on a busy disk: it gets pathTimeoutMs instead,
// counted from that notice. So a crafted small file that freezes the parser costs the short timeout, not the long one.
export class PhotoPool {
  timeoutMs: number;
  pathTimeoutMs: number;
  #entry: URL;
  #size: number;
  #all = new Set<Worker>();
  #idle: Worker[] = [];
  #busy = new Map<Worker, { job: Job; timer: NodeJS.Timeout }>();
  #queue: Job[] = [];

  constructor(entry: URL, size: number, timeoutMs: number, pathTimeoutMs = timeoutMs) {
    this.#entry = entry;
    this.#size = size;
    this.timeoutMs = timeoutMs;
    this.pathTimeoutMs = pathTimeoutMs;
  }

  // How many workers are alive, idle or busy.
  get live(): number {
    return this.#all.size;
  }

  // `rel` names the file in the log when the job is given up on. null: it was, or its worker died.
  run(abs: string, rel: string): Promise<PhotoResult | null> {
    return new Promise((resolve) => {
      this.#queue.push({ abs, rel, resolve });
      this.#dispatch();
    });
  }

  // Ends the idle workers. A busy one finishes its job first: this never fails a job.
  async stop(): Promise<void> {
    await Promise.all(this.#idle.slice().map((worker) => this.#retire(worker)));
  }

  #dispatch(): void {
    while (this.#queue.length > 0) {
      let worker = this.#idle.pop();
      if (!worker && this.#all.size < this.#size) {
        try {
          worker = this.#spawn();
        } catch (err) {
          const job = this.#queue.shift()!;
          log('error', { message: 'Photo metadata worker did not start', rel: job.rel, error: String(err) });
          job.resolve(null);
          continue;
        }
      }
      if (!worker) return;   // all busy: the queue waits for one to finish
      this.#start(worker, this.#queue.shift()!);
    }
  }

  #spawn(): Worker {
    const worker = new Worker(this.#entry);
    worker.unref();   // an idle worker must not keep the process alive; a busy one is ref'd for the length of its job
    this.#all.add(worker);
    worker.on('message', (message: WorkerMessage) => (message === 'by-path' ? this.#byPath(worker) : this.#finish(worker, message)));
    worker.on('error', (err) => this.#giveUp(worker, 'crashed', err));
    worker.on('exit', () => this.#giveUp(worker, 'crashed'));
    return worker;
  }

  #start(worker: Worker, job: Job): void {
    worker.ref();
    this.#busy.set(worker, { job, timer: setTimeout(() => this.#giveUp(worker, 'timed out'), this.timeoutMs) });
    worker.postMessage({ abs: job.abs });
  }

  // The job is about to read its file by path: the clock starts again, with the longer timeout.
  #byPath(worker: Worker): void {
    const busy = this.#busy.get(worker);
    if (!busy) return;   // given up on in the meantime
    clearTimeout(busy.timer);
    busy.timer = setTimeout(() => this.#giveUp(worker, 'timed out'), this.pathTimeoutMs);
  }

  #finish(worker: Worker, result: PhotoResult | null): void {
    const busy = this.#busy.get(worker);
    if (!busy) return;   // given up on in the meantime
    clearTimeout(busy.timer);
    this.#busy.delete(worker);
    worker.unref();
    this.#idle.push(worker);
    busy.job.resolve(result);
    this.#dispatch();
  }

  // A worker that ran out of time or died: terminated, and its job answered with null.
  #giveUp(worker: Worker, why: 'timed out' | 'crashed', err?: unknown): void {
    if (!this.#all.has(worker)) return;   // already retired: this is the exit that follows a terminate, or the exit that follows an error
    const busy = this.#busy.get(worker);
    void this.#retire(worker);
    if (busy) {
      log('error', { message: `Photo metadata ${why}`, rel: busy.job.rel, ...(err === undefined ? {} : { error: String(err) }) });
      busy.job.resolve(null);
    }
    this.#dispatch();
  }

  #retire(worker: Worker): Promise<number> {
    const busy = this.#busy.get(worker);
    if (busy) clearTimeout(busy.timer);
    this.#busy.delete(worker);
    this.#all.delete(worker);
    const at = this.#idle.indexOf(worker);
    if (at >= 0) this.#idle.splice(at, 1);
    return worker.terminate();
  }
}

// Up to four workers, fewer on a machine with fewer cores. A job is given up on after 3 s, or after 10 s once it reads a HEIC by path. Tests shorten both.
export const photoPool = new PhotoPool(new URL('./metaworker.ts', import.meta.url), Math.min(4, availableParallelism()), 3_000, 10_000);

async function photoMeta(abs: string, mtimeMs: number, rel: string): Promise<Meta> {
  const found = await photoPool.run(abs, rel);
  const taken = found?.exifDate ? exifToWallClock(found.exifDate) : null;
  return { width: found?.width ?? null, height: found?.height ?? null, takenAt: taken ?? instantToWallClock(mtimeMs), duration: null };
}

// The first video stream and the container, as JSON. Rotation is a side-data entry, or on older files the `rotate` tag.
// Members upload these files, so ffprobe may open the input and nothing else (-protocol_whitelist file): a crafted file can't make it reach a network URL.
const PROBE = ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:format_tags=creation_time',
  '-protocol_whitelist', 'file'];

interface Probe {
  streams?: { width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
  format?: { duration?: string; tags?: { creation_time?: string } };
}

async function videoMeta(abs: string, mtimeMs: number, run: RunFn): Promise<Meta> {
  let probe: Probe | null = null;
  try {
    probe = JSON.parse(await run('ffprobe', [...PROBE, abs], 15_000));
  } catch {
    // ffprobe missing, a file it can't read or output that isn't JSON: the video is listed without size and duration
  }
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

// `rel` only names the file in the log when a photo is given up on; a direct call can leave it out.
export function extractMeta(abs: string, kind: MediaKind, mtimeMs: number, run: RunFn = runProcess, rel = abs): Promise<Meta> {
  return kind === 'video' ? videoMeta(abs, mtimeMs, run) : photoMeta(abs, mtimeMs, rel);
}

const extractLimit = pLimit(4);

interface MetaRow { size: number; mtime_ms: number; width: number | null; height: number | null; taken_at: string; duration_s: number | null }

// `rel` is the path below MEDIA_ROOT: the cache key, the same for every user who can see the file. A row is good while size and mtime match.
export async function getMeta(db: DB, abs: string, rel: string, st: { size: number; mtimeMs: number }, kind: MediaKind): Promise<Meta> {
  const mtime = Math.floor(st.mtimeMs);
  const row = db.prepare('select size, mtime_ms, width, height, taken_at, duration_s from media_meta where rel_path = ?').get(rel) as MetaRow | undefined;
  if (row && row.size === st.size && row.mtime_ms === mtime) return { width: row.width, height: row.height, takenAt: row.taken_at, duration: row.duration_s };
  const meta = await extractLimit(() => extractMeta(abs, kind, st.mtimeMs, runProcess, rel));
  db.prepare('insert or replace into media_meta (rel_path, size, mtime_ms, width, height, taken_at, duration_s) values (?, ?, ?, ?, ?, ?, ?)')
    .run(rel, st.size, mtime, meta.width, meta.height, meta.takenAt, meta.duration);
  return meta;
}

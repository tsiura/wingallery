// Size in pixels, date taken and duration of a photo or video, cached in media_meta by path and valid while the file's size and mtime stay as
// they were. Photos are parsed in worker threads (metaworker.ts), videos by ffprobe, a subprocess with a timeout. Either way a file that can't be
// read, or that takes too long, leaves its fields null: it never throws, and it never freezes the server. What a parse finds is stored, a failure
// included. A photo that only took too long, or whose worker died, is not: that says little about the file (see giveUps).

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
// or dies is terminated, and a new one starts when a job next needs it; its job is answered with null (an answer of a worker is never null). The photo
// is then listed without size and date, and getMeta remembers that for a while instead of storing it. Workers start on the first job.
// The clock of a job starts when its worker says it is ready, with its modules loaded: thread start-up, and the disk the modules come from, are not
// the job's time. A worker that is not ready within startTimeoutMs is given up on like one that crashed.
// A job that reads a HEIC by path (metaworker.ts says so before it starts) is the one that may be slow on a busy disk: it gets pathTimeoutMs instead,
// counted from that notice. So a crafted small file that freezes the parser costs the short timeout, not the long one.
export class PhotoPool {
  timeoutMs: number;
  pathTimeoutMs: number;
  startTimeoutMs: number;
  #entry: URL;
  #size: number;
  #all = new Set<Worker>();
  #idle: Worker[] = [];
  #up = new Set<Worker>();                                                   // the workers that have said they are ready
  #starting = new Map<Worker, NodeJS.Timeout>();                             // the start-up limit of each worker that has not
  #busy = new Map<Worker, { job: Job; timer: NodeJS.Timeout | undefined }>();   // no timer: the job is waiting for its worker to be ready
  #queue: Job[] = [];

  constructor(entry: URL, size: number, timeoutMs: number, pathTimeoutMs = timeoutMs, startTimeoutMs = 30_000) {
    this.#entry = entry;
    this.#size = size;
    this.timeoutMs = timeoutMs;
    this.pathTimeoutMs = pathTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
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
    this.#starting.set(worker, setTimeout(() => this.#giveUp(worker, 'worker not ready in time'), this.startTimeoutMs));
    worker.on('message', (message: WorkerMessage) => this.#onMessage(worker, message));
    worker.on('error', (err) => this.#giveUp(worker, 'crashed', err));
    worker.on('exit', () => this.#giveUp(worker, 'crashed'));
    return worker;
  }

  // The job goes to its worker at once; its clock starts now if the worker is up, else when it says so.
  #start(worker: Worker, job: Job): void {
    worker.ref();
    this.#busy.set(worker, { job, timer: this.#up.has(worker) ? this.#clock(worker, this.timeoutMs) : undefined });
    worker.postMessage({ abs: job.abs });
  }

  #clock(worker: Worker, ms: number): NodeJS.Timeout {
    return setTimeout(() => this.#giveUp(worker, 'timed out'), ms);
  }

  #onMessage(worker: Worker, message: WorkerMessage): void {
    if (!this.#all.has(worker)) return;   // given up on in the meantime
    this.#isUp(worker);                   // any word from the worker means its modules are loaded, 'ready' being the one that says only that
    if (message === 'by-path') this.#byPath(worker);
    else if (message !== 'ready') this.#finish(worker, message);
  }

  #isUp(worker: Worker): void {
    if (this.#up.has(worker)) return;
    this.#up.add(worker);
    clearTimeout(this.#starting.get(worker));
    this.#starting.delete(worker);
    const busy = this.#busy.get(worker);
    if (busy && busy.timer === undefined) busy.timer = this.#clock(worker, this.timeoutMs);
  }

  // The job is about to read its file by path: the clock starts again, with the longer timeout.
  #byPath(worker: Worker): void {
    const busy = this.#busy.get(worker);
    if (!busy) return;
    clearTimeout(busy.timer);
    busy.timer = this.#clock(worker, this.pathTimeoutMs);
  }

  #finish(worker: Worker, result: PhotoResult): void {
    const busy = this.#busy.get(worker);
    if (!busy) return;   // given up on in the meantime
    clearTimeout(busy.timer);
    this.#busy.delete(worker);
    worker.unref();
    this.#idle.push(worker);
    busy.job.resolve(result);
    this.#dispatch();
  }

  // A worker that ran out of time, was never ready or died: terminated, and its job answered with null.
  #giveUp(worker: Worker, why: 'timed out' | 'crashed' | 'worker not ready in time', err?: unknown): void {
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
    clearTimeout(this.#starting.get(worker));
    this.#starting.delete(worker);
    this.#up.delete(worker);
    this.#busy.delete(worker);
    this.#all.delete(worker);
    const at = this.#idle.indexOf(worker);
    if (at >= 0) this.#idle.splice(at, 1);
    return worker.terminate();
  }
}

// Up to four workers, fewer on a machine with fewer cores. A job is given up on after 3 s, or after 10 s once it reads a HEIC by path. Tests shorten both.
export const photoPool = new PhotoPool(new URL('./metaworker.ts', import.meta.url), Math.min(4, availableParallelism()), 3_000, 10_000);

// What a photo is listed with when nothing could be read from it: no size, and its mtime for a date.
const unread = (mtimeMs: number): Meta => ({ width: null, height: null, takenAt: instantToWallClock(mtimeMs), duration: null });

// `gaveUp`: the pool gave up on the photo, so `meta` stands in for what was never read and is no finding about the file.
interface Extracted { meta: Meta; gaveUp: boolean }

async function photoMeta(abs: string, mtimeMs: number, rel: string): Promise<Extracted> {
  const found = await photoPool.run(abs, rel);
  if (found === null) return { meta: unread(mtimeMs), gaveUp: true };
  const taken = found.exifDate ? exifToWallClock(found.exifDate) : null;
  return { meta: { width: found.width, height: found.height, takenAt: taken ?? instantToWallClock(mtimeMs), duration: null }, gaveUp: false };
}

// The first video stream and the container, as JSON. Rotation is a side-data entry, or on older files the `rotate` tag.
// Members upload these files, so ffprobe may open the input and nothing else (-protocol_whitelist file): a crafted file can't make it reach a network URL.
// It also picks its demuxer by what a file holds, not by its name, and a manifest or playlist would name other files to read (a DASH one, with the path
// of a video in another share, gets its size and length out of ffprobe): only the MP4/MOV and Matroska/WebM demuxers may read it. The four video
// extensions are one or the other, so no format is forced.
const PROBE = ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:format_tags=creation_time',
  '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska'];

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

async function extract(abs: string, kind: MediaKind, mtimeMs: number, run: RunFn, rel: string): Promise<Extracted> {
  return kind === 'video' ? { meta: await videoMeta(abs, mtimeMs, run), gaveUp: false } : photoMeta(abs, mtimeMs, rel);
}

// `rel` only names the file in the log when a photo is given up on; a direct call can leave it out.
export async function extractMeta(abs: string, kind: MediaKind, mtimeMs: number, run: RunFn = runProcess, rel = abs): Promise<Meta> {
  return (await extract(abs, kind, mtimeMs, run, rel)).meta;
}

// The photos the pool gave up on (a timeout or a crash), by path, size and mtime, and until when. Such a give-up says little about the file: a NAS disk
// that has spun down takes 5 to 10 s to answer, and a date lost to that would be lost for good if it were stored. So it is only remembered, in memory,
// for a while. A file that really freezes the parser then doesn't hold up every listing, and when the window is over the next listing tries again.
// Tests shorten windowMs.
class GiveUps {
  windowMs = 10 * 60_000;
  #until = new Map<string, number>();

  has(key: string, now = Date.now()): boolean {
    return (this.#until.get(key) ?? 0) > now;
  }

  add(key: string, now = Date.now()): void {
    for (const [k, until] of this.#until) if (until <= now) this.#until.delete(k);   // what is over is forgotten, so the map holds the last window only
    this.#until.set(key, now + this.windowMs);
  }

  clear(): void {
    this.#until.clear();
  }
}
export const giveUps = new GiveUps();

const extractLimit = pLimit(4);

interface MetaRow { size: number; mtime_ms: number; width: number | null; height: number | null; taken_at: string; duration_s: number | null }

// `rel` is the path below MEDIA_ROOT: the cache key, the same for every user who can see the file. A row is good while size and mtime match.
export async function getMeta(db: DB, abs: string, rel: string, st: { size: number; mtimeMs: number }, kind: MediaKind): Promise<Meta> {
  const mtime = Math.floor(st.mtimeMs);
  const row = db.prepare('select size, mtime_ms, width, height, taken_at, duration_s from media_meta where rel_path = ?').get(rel) as MetaRow | undefined;
  if (row && row.size === st.size && row.mtime_ms === mtime) return { width: row.width, height: row.height, takenAt: row.taken_at, duration: row.duration_s };
  const key = `${rel}\0${st.size}\0${mtime}`;
  if (giveUps.has(key)) return unread(st.mtimeMs);   // the pool gave up on this very file a moment ago: no new try yet
  const { meta, gaveUp } = await extractLimit(() => extract(abs, kind, st.mtimeMs, runProcess, rel));
  if (gaveUp) {
    giveUps.add(key);
    return meta;
  }
  db.prepare('insert or replace into media_meta (rel_path, size, mtime_ms, width, height, taken_at, duration_s) values (?, ?, ?, ?, ?, ?, ?)')
    .run(rel, st.size, mtime, meta.width, meta.height, meta.takenAt, meta.duration);
  return meta;
}

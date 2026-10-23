// Worker thread for meta.ts: reads the size and date of one photo at a time. exifr and image-size parse bytes anyone can upload, and exifr can spin
// forever on a crafted HEIC (a box of length 0 after ftyp: heif.mjs adds 0 to its offset for good, and only awaits values that are already there,
// so not even timers run). In a thread of its own that costs one worker, which the main thread terminates when the job takes too long.

import { open } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import exifr from 'exifr';
import { imageSize } from 'image-size';
import { mediaTypeOf } from './mediatypes.ts';

// What a job answers. exifDate is DateTimeOriginal as the camera wrote it; meta.ts turns it into a wall clock, or uses the mtime.
export interface PhotoResult { width: number | null; height: number | null; exifDate: string | null }

// What a worker posts: 'ready' once, when its modules are loaded (the pool starts the clock of the job it has sent it then); 'by-path', before the slow
// part of a job, when this job is about to read its file by path (the pool then gives it the longer timeout); and the answer to a job. An answer is never
// null: that is what the pool makes of a job it had to give up on.
export type WorkerMessage = PhotoResult | 'ready' | 'by-path';

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

// translateValues:false keeps Orientation a number; reviveValues:false keeps DateTimeOriginal the raw string (R2).
const EXIF = { pick: ['DateTimeOriginal', 'Orientation', 'ExifImageWidth', 'ExifImageHeight'], translateValues: false, reviveValues: false };

const HEAD_BYTES = 512 * 1024;   // all that image-size's own file reader looks at

// exifr reads as many bytes as the file says its Exif data has (a HEIC iloc extent, a PNG chunk length), clamped only to the file's size, and
// copies its whole buffer each time it reads past the end. A crafted file costs it several times its size in memory, and many small boxes make
// the copying quadratic in time. JPEG, PNG, WebP and GIF keep their Exif at the start, so they are parsed from the head. Only a HEIC may keep its
// Exif item anywhere in mdat, so one longer than the head goes to exifr by path, up to this size.
// ponytail: measured at this cap, a crafted HEIC (a chain of 2 to 4 KiB boxes, 4.0 MiB) took one job +110 to +125 MB of resident memory, about 30 times
// its size, and four jobs at once +0.5 to +0.63 GB. The workers kept most of it (+0.34 to +0.52 GB three seconds later; ending them gave most of it
// back). At the 16 MiB this cap replaced, four such jobs took +1.0 GB. Time is bounded by the pool's timeouts, which terminate this thread. A HEIC
// over the cap is read from its head only, so a late Exif item is lost and the date falls back to the mtime; raise the cap if phones' files need it.
const EXIF_PATH_MAX = 4 * 1024 * 1024;

// The first bytes of a photo and its size, from one open that is closed here. image-size parses the head in memory, and so does exifr for a file
// that fits in it: given the path of a file under two bytes, exifr leaves its file handle open, which Node reports when it collects it (DEP0137).
async function readHead(abs: string): Promise<{ head: Buffer; size: number }> {
  const file = await open(abs, 'r');
  try {
    const { size } = await file.stat();
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    return { head: buffer.subarray(0, bytesRead), size };
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

async function photoMeta(abs: string): Promise<PhotoResult> {
  const src = await attempt(() => readHead(abs));
  if (!src) return { width: null, height: null, exifDate: null };
  const heif = mediaTypeOf(abs)?.convert === true;
  const byPath = heif && src.size > HEAD_BYTES && src.size <= EXIF_PATH_MAX;
  if (byPath) post('by-path');   // the one read that can take long: the pool allows it more time
  const exif = await attempt(() => exifr.parse(byPath ? abs : src.head, EXIF));
  let width: number | null = null, height: number | null = null;
  // image-size misreads HEIC/HEIF that carry a 'clap' crop (our sample is 64x48 and comes out 63x64), so their EXIF size goes first (R1).
  if (heif) [width, height] = [positive(exif?.ExifImageWidth), positive(exif?.ExifImageHeight)];
  if (width === null || height === null) {
    const dims = await attempt(() => imageSize(src.head));
    [width, height] = [positive(dims?.width), positive(dims?.height)];
  }
  const turn = exif?.Orientation;
  if (typeof turn === 'number' && turn >= 5 && turn <= 8) [width, height] = [height, width];   // turned by a quarter: shown the other way round
  return { width, height, exifDate: typeof exif?.DateTimeOriginal === 'string' ? exif.DateTimeOriginal : null };
}

if (!parentPort) throw new Error('metaworker.ts is a worker thread, started by meta.ts');
const port = parentPort;
const post = (message: WorkerMessage): void => port.postMessage(message);
port.on('message', ({ abs }: { abs: string }) => {
  // photoMeta guards every read itself, so a rejection is a bug, not a finding about the file: left unhandled it ends this worker, and the pool gives
  // the job up (logged, not stored).
  photoMeta(abs).then(post);
});
post('ready');

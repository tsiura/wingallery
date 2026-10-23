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

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

// translateValues:false keeps Orientation a number; reviveValues:false keeps DateTimeOriginal the raw string (R2).
const EXIF = { pick: ['DateTimeOriginal', 'Orientation', 'ExifImageWidth', 'ExifImageHeight'], translateValues: false, reviveValues: false };

const HEAD_BYTES = 512 * 1024;   // all that image-size's own file reader looks at

// exifr reads as many bytes as the file says its Exif data has (a HEIC iloc extent, a PNG chunk length), clamped only to the file's size, and
// copies its whole buffer each time it reads past the end. A crafted file costs it several times its size in memory, and many small boxes make
// the copying quadratic in time. JPEG, PNG, WebP and GIF keep their Exif at the start, so they are parsed from the head. Only a HEIC may keep its
// Exif item anywhere in mdat, so one longer than the head goes to exifr by path, up to this size.
// ponytail: measured, a crafted HEIC just under this cap (63 boxes of 256 KiB, 15.8 MiB) took one job +110 to +130 MB of resident memory and four
// jobs at once +650 MB, 7 to 10 times its size, and the workers kept it (+240 MB three seconds later; ending them gave it back). Time is bounded by
// the pool's job timeout, which terminates this thread. Lower the cap if that matters more than a late Exif item in a big HEIC (phones write a few MB).
const EXIF_PATH_MAX = 16 * 1024 * 1024;

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
  const exif = await attempt(() => exifr.parse(heif && src.size > HEAD_BYTES && src.size <= EXIF_PATH_MAX ? abs : src.head, EXIF));
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
port.on('message', ({ abs }: { abs: string }) => {
  photoMeta(abs).then((result) => port.postMessage(result), () => port.postMessage(null));
});

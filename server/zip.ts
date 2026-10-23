// The zip download: a selection of files and folders, streamed as one zip. What goes in is what the listings show, media files and folders, with no hidden
// name and no symlink (readVisible, G5). Every disk path comes from locate() (its abs), never from a client string and never from loc.rel (G8).

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { Me } from '../shared/types.ts';
import type { App } from './app.ts';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';
import { ROOT_NAME, readVisible } from './listing.ts';
import { log } from './log.ts';
import { mediaTypeOf } from './mediatypes.ts';
import { nextFreeName } from './names.ts';
import { contentDisposition } from './send.ts';
import { locate } from './vpath.ts';

// One thing the request selected: a folder, or a media file. `vpath` is what the client called it, which gives its name in the zip.
interface Top { vpath: string; abs: string; isDir: boolean; mtime: Date }
// One entry of the zip: a file (abs), or a folder with nothing in it (no abs; the name ends in '/').
interface Piece { name: string; abs?: string; mtime?: Date }

const unseen = (e: unknown) => ['ENOENT', 'ENOTDIR', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');
// null when the entry has gone, or may not be reached, since it was listed. lstat unless asked to follow: a symlink is what it is, not what it points at.
const statOrNull = (abs: string, follow = false): Promise<Stats | null> =>
  (follow ? stat(abs) : lstat(abs)).catch((e) => { if (unseen(e)) return null; throw e; });
const notFound = () => new HttpError(404, 'Not found');
// The format reads a backslash as a separator, and a disk name may hold one: a\..\x would climb out of the folder it is unpacked into.
const safe = (name: string) => name.replace(/\\/g, '_');
const leaf = (vpath: string) => vpath.slice(vpath.lastIndexOf('/') + 1) || ROOT_NAME;
const parent = (vpath: string) => vpath.slice(0, vpath.lastIndexOf('/'));

// `name`, or the first "name (n)" that no entry of the folder has (R2): the zip never holds an entry twice.
function free(taken: Set<string>, name: string): string {
  let out = name;
  for (let n = 1; taken.has(out); n++) out = nextFreeName(name, n);
  taken.add(out);
  return out;
}

// The selection as it is on disk: each item is a folder or a media file that the listings show, or the request is refused (404) before a byte is sent.
// An item repeated, or inside another selected folder, comes with that folder once (G11): the request names the items, and the walk must not run again for each.
// ponytail: items are the same by disk path, which an alias in another letter case keeps; on a case-insensitive mount '/Fam/XMAS' and '/Fam/xmas' are two items.
// Compare the dev and ino of folders if that is ever abused.
async function pick(app: App, user: Me, paths: string[]): Promise<Top[]> {
  const picked = new Map<string, Top>();   // by disk path
  for (const path of new Set(paths)) {
    const loc = await locate(app, user, path);
    if (loc.abs === null) throw notFound();   // a member's root is no folder on disk (G8)
    const st = await statOrNull(loc.abs, loc.isProtected);   // the folder of a share may be a link, which the listings follow; nothing below it is
    const isDir = st?.isDirectory() === true;
    const isMedia = st?.isFile() === true && mediaTypeOf(basename(loc.abs)) !== null;
    if (!st || !(isDir || isMedia)) throw notFound();
    if (!picked.has(loc.abs)) picked.set(loc.abs, { vpath: loc.vpath, abs: loc.abs, isDir, mtime: st.mtime });
  }
  const inside = (abs: string) => {
    for (let dir = dirname(abs); dir !== dirname(dir); dir = dirname(dir)) if (picked.has(dir)) return true;
    return false;
  };
  return [...picked.values()].filter((t) => !inside(t.abs));
}

// The media files of a folder and everything below it, as entries named `prefix/…`, and the folders with nothing in them. A folder that has gone, or that the
// server may not read, counts as empty, as it does in the listings.
async function walk(abs: string, prefix: string, out: Piece[]): Promise<void> {
  const { dirs, files } = await readVisible(abs).catch((e) => { if (unseen(e)) return { dirs: [], files: [] }; throw e; });
  if (dirs.length === 0 && files.length === 0) out.push({ name: prefix + '/' });
  const taken = new Set<string>();
  const stats = await Promise.all(files.map((f) => statOrNull(join(abs, f.name))));
  files.forEach((f, i) => {
    const st = stats[i];
    if (st?.isFile()) out.push({ name: `${prefix}/${free(taken, safe(f.name))}`, abs: join(abs, f.name), mtime: st.mtime });
  });
  for (const d of dirs) await walk(join(abs, d), `${prefix}/${free(taken, safe(d))}`, out);
}

// A file is opened when its turn comes, which can be long after the folder was read, so never through a symlink put there since (the walk skipped them).
// It is the one open file that is checked and then read: what was checked is what is sent.
// ponytail: only the file itself is guarded; a folder swapped for a symlink since the walk is followed, as in vpath.ts: it takes someone who can write to the media disk.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

async function openRead(abs: string): Promise<Readable> {
  const file = await open(abs, OPEN_FLAGS);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Not a regular file: ${abs}`);
    return file.createReadStream();   // closes the file when it ends, fails or is destroyed
  } catch (err) {
    await file.close();
    throw err;
  }
}

// ponytail: the whole list is kept, and yazl keeps a record of every entry for the central directory: some hundreds of bytes each, so a selection of a few hundred
// thousand files costs a few hundred MB. Refuse a selection above some count if a library ever gets there.
export async function streamZip(ctx: Ctx, app: App, user: Me, paths: string[]): Promise<void> {
  if (paths.length === 0) throw new HttpError(400, 'Invalid path');   // no path at all is '' and fails as an invalid one
  const tops = await pick(app, user, paths);
  const pieces: Piece[] = [];
  const names = new Set<string>();
  for (const t of tops) {
    // Items from different folders can have one name; a name like C:x is a drive to the format.
    const name = free(names, safe(leaf(t.vpath)).replace(/^([a-zA-Z]):/, '$1_'));
    if (t.isDir) await walk(t.abs, name, pieces);
    else pieces.push({ name, abs: t.abs, mtime: t.mtime });
  }
  // A folder is named for itself; a file, or several items, for the folder they are taken from (the first one's, if they differ).
  const first = tops[0];
  const zipName = `${leaf(tops.length === 1 && first.isDir ? first.vpath : parent(first.vpath))}.zip`;
  await send(ctx, user, zipName, pieces);
}

// Everything that can answer with a status is behind us. From the first byte on a failure can only cut the download short, and it must never be thrown into
// the pipeline, which would try to answer a response that is half sent (R3).
async function send(ctx: Ctx, user: Me, zipName: string, pieces: Piece[]): Promise<void> {
  const { res } = ctx;
  // The client may have left while the folders were read, and a response that is gone can't take a pipe (nothing to log, nothing to send).
  if (res.destroyed) return;
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as Readable;
  // yazl cannot be told to stop, and a file it was reading stays open for good once nobody takes its bytes: the file in hand is closed here when the zip is over.
  let reading: Readable | undefined;
  let stopped = false;
  const fail = (err: Error) => out.destroy(err);
  zip.on('error', fail);
  res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': contentDisposition('attachment', zipName) });
  const done = pipeline(out, res);
  try {
    for (const { name, abs, mtime } of pieces) {
      if (abs === undefined) {
        zip.addEmptyDirectory(name);
        continue;
      }
      zip.addReadStreamLazy(name, { compress: false, mtime }, (next) => {
        openRead(abs).then((file) => {
          if (stopped) {
            file.destroy();
            return;
          }
          reading = file.on('error', fail);   // yazl does not listen for it
          next(null, file);
        }).catch(fail);
      });
    }
    zip.end();
  } catch (err) {
    fail(err as Error);
  }
  try {
    await done;
  } catch (err) {
    // A client that leaves mid-download is no fault of ours. Anything else is, and the half-sent body can only be cut off.
    if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log('error', { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, during: 'zip', by: user.username });
      res.destroy();
    }
  } finally {
    stopped = true;
    reading?.destroy();
  }
}

// Chunked uploads. A file arrives in pieces (the client sends 8 MiB, the server takes up to CHUNK_MAX) because Traefik cuts a request that runs longer
// than 60 s. The pieces go into a hidden `.upload-<id>` file in the target folder, so a partial file is never listed; the last piece gives it its name,
// and never over a file that is there. Every disk path after the start comes from the uploads row, which this module wrote: never from the id in a
// URL (R1), and temp_abs is only ever a path built here (R2), since removeUser removes whatever it holds.
// A chunk is held in memory until it is written, so the route refuses what it can without reading the body, and reads the rest a few at a time.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Me } from '../shared/types.ts';
import type { App } from './app.ts';
import type { DB } from './db.ts';
import { mapFsError, mutationQueue, taken } from './fsops.ts';
import { HttpError } from './http.ts';
import { pLimit } from './limit.ts';
import { invalidateStats } from './listing.ts';
import { log } from './log.ts';
import { checkMagic, mediaTypeOf } from './mediatypes.ts';
import { nextFreeName, sanitizeUploadName } from './names.ts';
import { childAbs, locate, requireRight } from './vpath.ts';

export const CHUNK_MAX = 16 * 1024 * 1024;
// A chunk request reads its whole body into memory (up to CHUNK_MAX) and writes it, all inside one of these. So at most 4 bodies, 64 MiB, are held at a
// time across all users; the other chunk requests wait with their bodies unread. A client that trickles its body keeps its slot until Node's
// requestTimeout cuts it (5 minutes by default).
export const chunkSlots = pLimit(4);
const MB = 1024 * 1024;
const DAY_MS = 86_400_000;
const MAGIC_BYTES = 12;   // what checkMagic can look at: the WebP signature ends at byte 12
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);   // a disk that can't hard-link (exFAT/FAT, some SMB), or not from here to there
const GONE_OR_FULL = new Set(['ENOENT', 'ENOTDIR', 'ENOSPC', 'EDQUOT']);   // what ends an upload, as opposed to failing one chunk

interface UploadRow { id: string; user_id: number; dir_abs: string; temp_abs: string; name: string; size: number; received: number; updated_at: number }
type ChunkResult = { received: number } | { done: true; name: string };

const code = (e: unknown): string => (e as NodeJS.ErrnoException | null | undefined)?.code ?? '';
const forget = (db: DB, id: string) => db.prepare('delete from uploads where id = ?').run(id);

// R1: the id comes from a URL and is only a key. An upload that is not this user's is a 404, as one that is not there.
function ownUpload(db: DB, id: string, userId: number): UploadRow {
  const row = db.prepare('select * from uploads where id = ? and user_id = ?').get(id, userId) as UploadRow | undefined;
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

// The row goes first, so that the client is done with the upload even when the temp file can't be removed (a read-only folder, a fault of the disk). A
// file that stays is logged with its path, for the owner to remove by hand, as removeUser does. It only ever removes the stored path (R2).
async function dropUpload(db: DB, row: UploadRow): Promise<void> {
  forget(db, row.id);
  await rm(row.temp_abs, { force: true }).catch((e) =>
    log('error', { message: `Could not remove the upload temp file ${row.temp_abs}: ${e instanceof Error ? e.message : String(e)}` }));
}

// What a failed disk call on the stored paths means. R4: a folder renamed, moved or deleted since the start takes the temp file along or away, so the
// stored paths lead nowhere: a 404 and the row goes, and the folder is never made again. A full disk ends the upload too, and frees what it held.
// Anything else fails this request only. mapFsError has the answers.
async function failed(db: DB, row: UploadRow, e: unknown): Promise<never> {
  if (GONE_OR_FULL.has(code(e))) await dropUpload(db, row);
  return mapFsError(e);
}

// The checks of a start, in order: the right to create in `dir`, a name that is a photo or a video once sanitized, and a size from 1 byte up to
// MAX_UPLOAD_MB. Then the row and the empty temp file.
export async function startUpload(app: App, user: Me, input: { dir: string; name: string; size: number }): Promise<{ id: string }> {
  const loc = await locate(app, user, input.dir);
  requireRight(loc, 'create');
  const dir = loc.abs;
  if (dir === null) throw new HttpError(403, "You don't have permission to do that");   // only a member's root has no disk path, and the right refuses it (G8)
  const name = sanitizeUploadName(input.name);
  if (!mediaTypeOf(name)) throw new HttpError(415, 'Only photos and videos can be uploaded');
  const { size } = input;
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'File is empty');   // the field is untrusted (G6): no number of bytes counts as none
  const max = app.cfg.maxUploadBytes;
  if (size > max) throw new HttpError(413, `File is larger than the ${max / MB} MB limit`);
  const id = randomBytes(16).toString('hex');
  const temp = childAbs(loc, `.upload-${id}`);
  // The row first: a crash between the two leaves a row for the sweep to find, not a temp file nothing knows about.
  app.db.prepare('insert into uploads (id, user_id, dir_abs, temp_abs, name, size, received, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, user.id, dir, temp, name, size, Date.now());
  try {
    await writeFile(temp, '', { flag: 'wx' });
  } catch (e) {
    forget(app.db, id);
    mapFsError(e);
  }
  return { id };
}

// R3: `body` goes in at `position` and is never appended, so what a crash left past `received` (the database runs with synchronous = NORMAL, and can
// lag the disk) is written over. The chunk that completes the file cuts it at the declared size, which takes away what is left of such a tail, and then
// syncs it: the file is about to get the name it will be found by, and a power cut after that must not leave it short.
// A write can stop short of what it was given, so it goes on until the chunk is in. The temp file is opened by its name, but never through a symlink.
// ponytail: a symlink swapped in for a parent folder wins the race, as in vpath.ts: only someone who can write to the media disk can do that.
async function putChunk(path: string, body: Buffer, position: number, size: number): Promise<void> {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    for (let done = 0; done < body.length;) {
      const { bytesWritten } = await file.write(body, done, body.length - done, position + done);
      if (bytesWritten === 0) throw Object.assign(new Error('A write to the upload temp file made no progress'), { code: 'EIO' });
      done += bytesWritten;
    }
    if (position + body.length === size) {
      await file.truncate(size);
      await file.sync();
    }
  } finally {
    await file.close();
  }
}

// The first of "name.ext", "name (1).ext", "name (2).ext", ... that is free is taken, and returned. A hard link fails with EEXIST when the name is in
// use, whoever took it and whenever, so nothing is replaced. A disk that can't hard-link (exFAT/FAT, some SMB) has no such call: there each name is
// asked with taken(), and the first free one gets a rename(). The temp file is complete by now, so a name is never seen half written, and the
// queue keeps the app's own changes from taking the name between the question and the rename.
// ponytail: another writer on such a disk (Samba, Syncthing) can still take the name in that gap, and rename() replaces it silently; Node has no
// RENAME_NOREPLACE, and nothing short of a lock that writer respects too closes the gap.
async function place(temp: string, dir: string, name: string): Promise<string> {
  let linkable = true;
  for (let n = 0; ; n++) {
    const to = n ? nextFreeName(name, n) : name;
    const at = join(dir, to);
    if (linkable) {
      try {
        await link(temp, at);
        return to;
      } catch (e) {
        if (code(e) === 'EEXIST') continue;
        if (!NO_LINKS.has(code(e))) throw e;
        linkable = false;   // and the name tried just now is asked below
      }
    }
    if (!(await taken(at))) {
      await rename(temp, at);
      return to;
    }
  }
}

// The last chunk is in. This puts a new name into the tree, so it takes its turn in the queue (G10), like every change that checks a name and then
// uses it. Nothing in here may wait for the queue again.
// ponytail: the file is synced but its folder is not, so a power cut right after the finish can still lose the name; sync the folder as well if
// that ever shows.
function finalize(app: App, user: Me, row: UploadRow): Promise<{ done: true; name: string }> {
  return mutationQueue(async () => {
    let name: string;
    try {
      name = await place(row.temp_abs, row.dir_abs, row.name);
    } catch (e) {
      return failed(app.db, row, e);
    }
    await dropUpload(app.db, row);   // the file is in place: what happens to the temp name is no failure of the upload
    invalidateStats();
    log('upload', { by: user.username, path: relative(app.cfg.mediaRoot, join(row.dir_abs, name)), size: row.size });
    return { done: true as const, name };
  });
}

// What can be told without the body: the upload is this user's (404), and the chunk starts where the last one ended (409). The route asks before it
// reads a byte, so that a request that can't be taken costs neither a buffer nor a slot. writeChunk asks again, since the upload may have moved on
// while the request waited for a slot and sent its body.
export function checkChunk(app: App, user: Me, id: string, offset: number) {
  const row = ownUpload(app.db, id, user.id);
  if (offset !== row.received) throw new HttpError(409, 'Upload out of sync');
  return row;
}

// One chunk, which must start where the last one ended. The first is checked against the type its name claims. The chunk that completes the file ends
// the upload ({ done, name }), the others answer how much is in. A finish that failed leaves the upload whole, and an empty chunk at the end runs it again.
export async function writeChunk(app: App, user: Me, id: string, offset: number, body: Buffer): Promise<ChunkResult> {
  const row = checkChunk(app, user, id, offset);
  if (offset === 0 && !checkMagic(row.name, body.subarray(0, MAGIC_BYTES))) {
    await dropUpload(app.db, row);
    throw new HttpError(415, "File content doesn't match its type");
  }
  const received = offset + body.length;
  if (received > row.size) throw new HttpError(400, 'Upload is larger than declared');
  try {
    await putChunk(row.temp_abs, body, offset, row.size);
  } catch (e) {
    return failed(app.db, row, e);
  }
  // Two requests can carry the same chunk (a retry while the first is still running); only the one that moves `received` on goes any further.
  const moved = app.db.prepare('update uploads set received = ?, updated_at = ? where id = ? and received = ?').run(received, Date.now(), row.id, offset);
  if (moved.changes === 0) throw new HttpError(409, 'Upload out of sync');
  return received === row.size ? finalize(app, user, row) : { received };
}

export async function cancelUpload(app: App, user: Me, id: string): Promise<void> {
  await dropUpload(app.db, ownUpload(app.db, id, user.id));
}

// Uploads nobody has sent a chunk to for 24 h. Their rows go with their temp files; the count is how many were stale.
export async function cleanupUploads(db: DB, now = Date.now(), olderThanMs = DAY_MS): Promise<number> {
  const stale = db.prepare('select * from uploads where updated_at < ?').all(now - olderThanMs) as unknown as UploadRow[];
  for (const row of stale) await dropUpload(db, row);
  return stale.length;
}

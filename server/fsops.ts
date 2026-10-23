// The changes a user makes to the folder tree: a new folder, a new name, a new place. The rights, the protection of the roots and the move
// boundary are checked here, once, for all three. Every disk path comes from locate() (its abs, or childAbs below it), never from a client string.

import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import type { Me } from '../shared/types.ts';
import type { App } from './app.ts';
import { HttpError } from './http.ts';
import { pLimit } from './limit.ts';
import { invalidateStats } from './listing.ts';
import { log } from './log.ts';
import { mediaTypeOf } from './mediatypes.ts';
import { splitExt, validateName } from './names.ts';
import { rewriteSharePaths } from './shares.ts';
import { childAbs, locate, requireRight, requireUnprotected } from './vpath.ts';
import type { Loc } from './vpath.ts';

const EXISTS = 'A file or folder with that name already exists';
const notFound = () => new HttpError(404, 'Not found');

// What a failed fs call means to the client. A missing folder, or a file where a folder was expected (ENOTDIR), is "not found" as in the listings.
// EXDEV (R1) is a move across mounts, which a symlink between top-level folders can ask for: it would be a copy, so it isn't done.
// Anything else is a fault of ours and is rethrown.
export function mapFsError(e: unknown): never {
  switch ((e as NodeJS.ErrnoException | null | undefined)?.code) {
    case 'EROFS': case 'EACCES': case 'EPERM': throw new HttpError(409, 'This folder is read-only on disk');
    case 'ENOSPC': throw new HttpError(507, 'Disk is full');
    case 'EEXIST': case 'ENOTEMPTY': throw new HttpError(409, EXISTS);
    case 'ENOENT': case 'ENOTDIR': throw notFound();
    case 'EXDEV': throw new HttpError(400, 'Items can only be moved within the same shared folder');
    default: throw e;
  }
}

// One change to the tree at a time. rename() replaces a file silently, so "the name is free" and the rename must not be split by another request,
// and neither may the share rewrite, the rename and its revert. Another writer on the disk can still slip in between: Node has no RENAME_NOREPLACE.
// ponytail: one queue for every share; a queue per top-level folder if changes ever wait on each other.
const one = pLimit(1);

// Whether anything is at `abs`, a dangling symlink included.
const taken = (abs: string): Promise<boolean> => lstat(abs).then(() => true, (e) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? false : mapFsError(e)));

// Only a member's root has no disk path, and the rights and protection checks refuse it before anyone asks for one (G8).
function diskPath(loc: Loc): string {
  if (loc.abs === null) throw new HttpError(403, "You don't have permission to do that");
  return loc.abs;
}

const extOf = (name: string) => splitExt(name)[1].toLowerCase();

interface Source { loc: Loc; abs: string; name: string; isDir: boolean }

// The entry a rename or move works on: the user may update it, it is not a root, and it is what the listings show, a folder or a media file.
// A symlink never is, whatever it points at (R2), and neither is a file of another kind.
async function sourceAt(app: App, user: Me, path: string): Promise<Source> {
  const loc = await locate(app, user, path);
  requireRight(loc, 'update');
  requireUnprotected(loc);
  const abs = diskPath(loc);
  const st = await lstat(abs).catch(mapFsError);
  const name = basename(abs);
  const isDir = st.isDirectory();
  if (!isDir && !(st.isFile() && mediaTypeOf(name))) throw notFound();
  return { loc, abs, name, isDir };
}

// Renames `from` to `to`, which must be free, and keeps the shares of a folder, and of the folders inside it, pointing at it. The shares are
// rewritten before the rename (R3): a clash with another share of the same user (UNIQUE) is a 409 with the disk untouched, and if the
// rename fails the shares go back.
async function relocate(app: App, user: Me, event: 'rename' | 'move', from: string, to: string, isDir: boolean): Promise<void> {
  if (await taken(to)) throw new HttpError(409, EXISTS);
  const oldRel = relative(app.cfg.mediaRoot, from), newRel = relative(app.cfg.mediaRoot, to);
  let shares = 0;
  if (isDir) {
    try {
      shares = rewriteSharePaths(app.db, oldRel, newRel);
    } catch (e) {
      throw (e as { errcode?: number }).errcode === 2067 ? new HttpError(409, EXISTS) : e;   // 2067 = SQLITE_CONSTRAINT_UNIQUE, as in shares.ts
    }
  }
  try {
    await rename(from, to);
  } catch (e) {
    if (shares > 0) rewriteSharePaths(app.db, newRel, oldRel);
    mapFsError(e);
  }
  invalidateStats();
  log(event, { by: user.username, from: oldRel, to: newRel });
}

export function makeFolder(app: App, user: Me, parent: string, name: string): Promise<{ name: string }> {
  return one(async () => {
    const loc = await locate(app, user, parent);
    requireRight(loc, 'create');
    const bad = validateName(name);
    if (bad) throw new HttpError(400, bad);
    const abs = childAbs(loc, name);
    await mkdir(abs).catch(mapFsError);   // EEXIST, also for a symlink of that name
    invalidateStats();
    log('mkdir', { by: user.username, path: relative(app.cfg.mediaRoot, abs) });
    return { name };
  });
}

export function renameItem(app: App, user: Me, path: string, name: string): Promise<{ name: string }> {
  return one(async () => {
    const src = await sourceAt(app, user, path);
    const bad = validateName(name);
    if (bad) throw new HttpError(400, bad);
    if (!src.isDir && extOf(name) !== extOf(src.name)) throw new HttpError(400, "File extension can't be changed");
    const parent = await locate(app, user, path.slice(0, path.lastIndexOf('/')));   // an item that can be renamed lies below a root, so this is a folder
    await relocate(app, user, 'rename', src.abs, childAbs(parent, name), src.isDir);
    return { name };
  });
}

async function moveOne(app: App, user: Me, path: string, to: string): Promise<void> {
  const src = await sourceAt(app, user, path);
  const dest = await locate(app, user, to);
  // A member moves within one share, the administrator within one top-level folder. The roots have no scope (null), so nothing moves to them.
  if (dest.scope !== src.loc.scope) throw new HttpError(400, 'Items can only be moved within the same shared folder');
  if (src.isDir) {
    // Real paths: the destination can be a symlink that leads back into the folder, which rename() would refuse with EINVAL.
    const [from, into] = await Promise.all([realpath(src.abs), realpath(diskPath(dest))]).catch(mapFsError);
    if (into === from || into.startsWith(from + sep)) throw new HttpError(400, "Can't move a folder into itself");
  }
  await relocate(app, user, 'move', src.abs, childAbs(dest, src.name), src.isDir);
}

// Item by item, in order. The first error ends it, and what moved before stays moved. Each item takes its turn in the queue on its own,
// so a long selection doesn't keep everyone else waiting.
export async function moveItems(app: App, user: Me, paths: string[], to: string): Promise<{ moved: number }> {
  let moved = 0;
  for (const path of paths) {
    await one(() => moveOne(app, user, path, to));
    moved++;
  }
  return { moved };
}

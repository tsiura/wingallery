// vpath.ts

// The one place a client path becomes a disk path. A member sends `/<alias>/<sub>`, the admin sends `/<sub>` under MEDIA_ROOT.
// Every endpoint that touches files goes through resolve() or locate(); nothing else turns a request string into a path on disk.

import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Me, Rights } from '../shared/types.ts';
import type { App } from './app.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { HttpError } from './http.ts';
import { isHiddenName } from './names.ts';

export interface ShareRow { id: number; userId: number; alias: string; relPath: string; create: boolean; update: boolean; delete: boolean }

// abs is the joined path, not the realpath, and is null only at a member's virtual root. rel is relative to MEDIA_ROOT ('' at the roots).
// scope is the move boundary: the member's share folder, or the admin's top-level folder (null at the roots).
export interface Loc { vpath: string; abs: string | null; rel: string; rights: Rights; isProtected: boolean; scope: string | null; share: ShareRow | null }

const FORBIDDEN = "You don't have permission to do that";
const invalid = () => new HttpError(400, 'Invalid path');
const notFound = () => new HttpError(404, 'Not found');

// Only a clean absolute virtual path gets through: no empty, `.` or `..` segment (so no trailing slash either), no NUL or backslash, no hidden name.
// `.` and `..` are named although isHiddenName covers them: traversal must not depend on the hidden-name rule staying as it is.
export function splitVpath(vpath: string): string[] {
  if (typeof vpath !== 'string' || !vpath.startsWith('/')) throw invalid();   // the type is only a promise: request fields are untrusted (G6)
  if (vpath === '/') return [];
  const segs = vpath.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || /[\0\\]/.test(s) || isHiddenName(s))) throw invalid();
  return segs;
}

export function sharesForUser(db: DB, userId: number): ShareRow[] {
  const rows = db.prepare('select id, user_id, alias, rel_path, can_create, can_update, can_delete from shares where user_id = ? order by id').all(userId) as
    { id: number; user_id: number; alias: string; rel_path: string; can_create: number; can_update: number; can_delete: number }[];
  return rows.map((r) => ({ id: r.id, userId: r.user_id, alias: r.alias, relPath: r.rel_path, create: !!r.can_create, update: !!r.can_update, delete: !!r.can_delete }));
}

// Aliases match whatever the letter case, but an exact match wins: SQLite's NOCASE folds ASCII only, so 'Дача' and 'дача' can both be stored.
function pickShare(shares: ShareRow[], name: string): ShareRow | null {
  const lower = name.toLowerCase();
  return shares.find((s) => s.alias === name) ?? shares.find((s) => s.alias.toLowerCase() === lower) ?? null;
}

// The "nothing there" outcomes of realpath. Anything else (EIO, EMFILE, ...) is a fault of ours and stays a 500.
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EACCES']);
function missing(err: unknown): never {
  throw MISSING.has((err as NodeJS.ErrnoException).code ?? '') ? notFound() : err;
}

// `shares` are the user's own, and ignored for the admin. The result is always fresh: callers may change its rights object.
export async function resolve(cfg: Config, user: Me, shares: ShareRow[], vpath: string): Promise<Loc> {
  const segs = splitVpath(vpath);
  const isAdmin = user.role === 'admin';
  let share: ShareRow | null = null;
  if (!isAdmin) {
    if (segs.length === 0) return { vpath, abs: null, rel: '', rights: { create: false, update: false, delete: false }, isProtected: true, scope: null, share: null };
    share = pickShare(shares, segs[0]);
    if (!share) throw notFound();
  }
  const base = share ? join(cfg.mediaRoot, share.relPath) : cfg.mediaRoot;
  // One string, not spread segments: join(...segs) with 130k or so segments overflows the stack, and the client picks the path.
  const abs = join(base, (share ? segs.slice(1) : segs).join('/'));

  const [real, baseReal, mediaReal] = await Promise.all([realpath(abs), realpath(base), realpath(cfg.mediaRoot)]).catch(missing);
  // Containment is judged on realpaths. A share lies strictly inside MEDIA_ROOT (MEDIA_ROOT itself can't be shared); the path lies inside its share.
  if (share && !baseReal.startsWith(mediaReal + sep)) throw notFound();
  if (real !== baseReal && !real.startsWith(baseReal + sep)) throw notFound();
  // A symlink inside a share must not lead into a hidden folder (.gallery-trash, @eaDir, ...) either.
  if (relative(mediaReal, real).split(sep).some(isHiddenName)) throw notFound();
  // ponytail: realpath is checked, then the joined path is used, so a symlink swapped in between wins the race. Only someone who can write
  // to the media disk can do that (the app never makes symlinks); closing it needs openat2(RESOLVE_BENEATH), which Node doesn't expose.

  const writable = isAdmin && segs.length > 0;   // MEDIA_ROOT is read-only for everyone
  return {
    vpath, abs, rel: relative(cfg.mediaRoot, abs),
    rights: share ? { create: share.create, update: share.update, delete: share.delete } : { create: writable, update: writable, delete: writable },
    isProtected: segs.length <= 1,   // the roots, and the top-level folders (mount points) or share folders just below them
    scope: share ? base : segs.length > 0 ? join(cfg.mediaRoot, segs[0]) : null,
    share,
  };
}

// Shares are read on every call, never cached, so a rights change shows on the user's next request.
export async function locate(app: App, user: Me, vpath: string): Promise<Loc> {
  return resolve(app.cfg, user, user.role === 'admin' ? [] : sharesForUser(app.db, user.id), vpath);
}

// The disk path of the entry `name` in the folder `loc`. Callers have already run validateName; this is the last guard before
// `name` reaches fs, so it only insists on one plain segment.
export function childAbs(loc: Loc, name: string): string {
  if (loc.abs === null) throw new HttpError(403, FORBIDDEN);
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw invalid();
  return join(loc.abs, name);
}

export function requireRight(loc: Loc, right: keyof Rights): void {
  if (!loc.rights[right]) throw new HttpError(403, FORBIDDEN);
}

export function requireUnprotected(loc: Loc): void {
  if (loc.isProtected) throw new HttpError(403, "This folder can't be renamed, moved or deleted");
}

export const joinVpath = (parent: string, name: string): string => (parent === '/' ? '' : parent) + '/' + name;

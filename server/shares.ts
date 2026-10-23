// The administrator's side of the access model: which disk folder goes to which user, under which alias, with which rights.
// A folder is picked with the resolver every other request goes through (F13.1); what is stored here is what that resolver reads.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Me, ShareInfo } from '../shared/types.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { HttpError, str } from './http.ts';
import { byName, isHiddenName, validateAlias } from './names.ts';
import { resolve, sharesForUser } from './vpath.ts';
import type { ShareRow } from './vpath.ts';

export interface ShareInput { relPath: string; alias: string; create: boolean; update: boolean; delete: boolean }
export type SharePatch = Partial<Omit<ShareInput, 'relPath'>>;

const PICK = 'Pick a folder inside the media folder';
const notFound = () => new HttpError(404, 'Not found');
const taken = (alias: string) => new HttpError(409, `This user already has a folder named "${alias}"`);
const errcode = (err: unknown) => (err as { errcode?: number }).errcode;
// A right that is absent stays as it is; one that is present counts only when it is exactly true (G6).
const flag = (v: unknown, current: boolean) => (v === undefined ? current : v === true);

// The folder `rel` below MEDIA_ROOT ('' is MEDIA_ROOT itself). resolve() decides what is hidden, missing or a way out (400, 404); this
// only insists on a folder. The disk path is loc.abs, never built from loc.rel (G8).
async function folderAt(cfg: Config, admin: Me, rel: string): Promise<{ abs: string; rel: string }> {
  const loc = await resolve(cfg, admin, [], '/' + rel);
  if (loc.abs === null || !(await stat(loc.abs)).isDirectory()) throw new HttpError(400, PICK);
  return { abs: loc.abs, rel: loc.rel };
}

// A share as the administrator sees it: where it lies on disk, and whether that is a folder at the moment (it can be unmounted or deleted).
async function info(cfg: Config, row: ShareRow): Promise<ShareInfo> {
  const diskPath = join(cfg.mediaRoot, row.relPath);
  return { ...row, diskPath, available: await stat(diskPath).then((s) => s.isDirectory(), () => false) };
}

export function getShare(db: DB, id: number): ShareRow | null {
  const owner = db.prepare('select user_id from shares where id = ?').get(id) as { user_id: number } | undefined;
  return (owner && sharesForUser(db, owner.user_id).find((s) => s.id === id)) ?? null;
}

function checkedAlias(v: unknown): string {
  const alias = str(v);
  const bad = validateAlias(alias);
  if (bad) throw new HttpError(400, bad);
  return alias;
}

// An alias is unique per user whatever the letter case. SQLite's NOCASE folds ASCII only, so its UNIQUE index lets 'Дача' and 'дача' both
// in; the lower-cased comparison here is what catches them (R5), and the index stays as the last word.
function aliasTaken(db: DB, userId: number, alias: string, exceptId: number | null): boolean {
  const lower = alias.toLowerCase();
  return sharesForUser(db, userId).some((s) => s.id !== exceptId && s.alias.toLowerCase() === lower);
}

// The fields usually come straight from a request body, so each is checked at run time (G6): a non-string counts as '', a boolean that is not true as false.
export async function addShare(cfg: Config, db: DB, admin: Me, userId: number, input: ShareInput): Promise<ShareInfo> {
  const relPath = str(input.relPath);
  if (relPath === '') throw new HttpError(400, PICK);   // MEDIA_ROOT itself can't be shared
  const folder = await folderAt(cfg, admin, relPath);
  const alias = checkedAlias(input.alias);
  // Nothing is awaited from here to the insert, so no other request can take the alias or the folder in between.
  if (aliasTaken(db, userId, alias, null)) throw taken(alias);
  const rights = { create: input.create === true, update: input.update === true, delete: input.delete === true };
  let id: number;
  try {
    id = Number(db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, ?, ?, ?)')
      .run(userId, alias, folder.rel, Number(rights.create), Number(rights.update), Number(rights.delete)).lastInsertRowid);
  } catch (err) {
    // 2067 = SQLITE_CONSTRAINT_UNIQUE (the message names the columns), 787 = SQLITE_CONSTRAINT_FOREIGNKEY: there is no such user
    if (errcode(err) === 2067) throw (err as Error).message.includes('shares.alias') ? taken(alias) : new HttpError(409, 'This folder is already shared with this user');
    if (errcode(err) === 787) throw notFound();
    throw err;
  }
  return info(cfg, { id, userId, alias, relPath: folder.rel, ...rights });
}

// Changes only the fields the patch names, and only when every named one is valid. The folder of a share never changes.
export async function updateShare(cfg: Config, db: DB, id: number, patch: SharePatch): Promise<ShareInfo> {
  const current = getShare(db, id);
  if (!current) throw notFound();
  const alias = patch.alias === undefined ? current.alias : checkedAlias(patch.alias);
  if (aliasTaken(db, current.userId, alias, id)) throw taken(alias);
  const next: ShareRow = { ...current, alias, create: flag(patch.create, current.create), update: flag(patch.update, current.update), delete: flag(patch.delete, current.delete) };
  try {
    db.prepare('update shares set alias = ?, can_create = ?, can_update = ?, can_delete = ? where id = ?')
      .run(alias, Number(next.create), Number(next.update), Number(next.delete), id);
  } catch (err) {
    if (errcode(err) === 2067) throw taken(alias);   // the alias is the only unique column this statement writes
    throw err;
  }
  return info(cfg, next);
}

export function removeShare(db: DB, id: number): void {
  if (db.prepare('delete from shares where id = ?').run(id).changes === 0) throw notFound();
}

export async function listShareInfo(cfg: Config, db: DB, userId: number): Promise<ShareInfo[]> {
  const list = await Promise.all(sharesForUser(db, userId).map((row) => info(cfg, row)));
  return list.sort((a, b) => byName(a.alias, b.alias));
}

// A folder was renamed or moved from `oldRel` to `newRel` (both below MEDIA_ROOT): the shares of that folder and of everything under it follow.
// Matched by spelling, in JS, not with LIKE, because _ and % are ordinary characters in folder names. Returns how many shares moved.
// Renames and moves don't use it any more: followFolder matches by folder, which spelling can't (case-insensitive disks, symlinks).
// ponytail: a new path that already is another share of the same user fails the UNIQUE index and moves none; drop the stale share if that ever shows.
export function rewriteSharePaths(db: DB, oldRel: string, newRel: string): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare('select id, rel_path from shares').all() as { id: number; rel_path: string }[];
    const hits = rows.filter((r) => r.rel_path === oldRel || r.rel_path.startsWith(oldRel + '/'));
    const update = db.prepare('update shares set rel_path = ? where id = ?');
    for (const r of hits) update.run(newRel + r.rel_path.slice(oldRel.length), r.id);
    db.exec('COMMIT');
    return hits.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// A share that moved with its folder: which one, and the path it had.
export interface MovedShare { id: number; oldRel: string }

// The folder a path names, as "device:inode", following links; read as BigInts so that no inode number is rounded. null when it can't be read,
// which is what a share of a folder that is gone (unavailable) comes to.
const folderId = (abs: string): Promise<string | null> => stat(abs, { bigint: true }).then((s) => `${s.dev}:${s.ino}`, () => null);

// The folder at `fromAbs`, `oldRel` below MEDIA_ROOT, is about to be renamed or moved to `newRel`: the shares of that folder and of everything below
// it follow, in one transaction. A clash with another share of the same user (UNIQUE) throws with nothing changed. Returns the shares that moved, so
// that a rename which then fails puts back exactly those (restoreShares), not whatever else lies at the path.
// Shares are matched by the folder they name, not by how their path is spelled: on a case-insensitive disk, or through a symlink, 'pics/Family/xmas'
// and 'pics/family/xmas' are one folder, and a share keeps the spelling it was made with. So each share is looked at through the first `depth` segments
// of its path, `depth` being that of the folder; if those are the folder, the share follows, and gets `newRel` plus what comes after them.
// A share whose folder is not there (unavailable) never matches, whether it is the first segments that are missing or only its own folder below the
// moved one: it stays at its path, where bringing the folder back (out of the bin, say) brings the share back. Other folders' shares are not touched.
// Two shares of one user that name the folder in two spellings end up on one path: that is a clash too.
// ponytail: a share that reaches the folder through a symlink of another depth ('fam/xmas' for 'pics/family/xmas') is not followed; stat every
// prefix of a path, not only the first `depth` segments, if that ever shows. A share added while this runs (a few stat calls) is missed too.
export async function followFolder(cfg: Config, db: DB, fromAbs: string, oldRel: string, newRel: string): Promise<MovedShare[]> {
  const source = await folderId(fromAbs);
  if (source === null) return [];
  const depth = oldRel.split('/').length;
  const heads = new Map<string, Promise<string | null>>();   // by the first `depth` segments: many shares sit in the same folders
  const rows = db.prepare('select id, rel_path from shares').all() as { id: number; rel_path: string }[];
  const hits = (await Promise.all(rows.map(async (r) => {
    const segs = r.rel_path.split('/');
    if (segs.length < depth) return null;
    const head = segs.slice(0, depth).join('/');
    let id = heads.get(head);
    if (!id) heads.set(head, id = folderId(join(cfg.mediaRoot, head)));
    if ((await id) !== source) return null;
    if (segs.length > depth && (await folderId(join(cfg.mediaRoot, r.rel_path))) === null) return null;   // its own folder is gone
    return { id: r.id, from: r.rel_path, to: [newRel, ...segs.slice(depth)].join('/') };
  }))).filter((h) => h !== null);
  if (hits.length === 0) return [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('update shares set rel_path = ? where id = ? and rel_path = ?');   // a share removed or changed meanwhile is left alone
    const moved = hits.filter((h) => update.run(h.to, h.id, h.from).changes === 1);
    db.exec('COMMIT');
    return moved.map((h) => ({ id: h.id, oldRel: h.from }));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Puts back the shares followFolder moved, by id and in one transaction: no other share is touched.
export function restoreShares(db: DB, moved: MovedShare[]): void {
  if (moved.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('update shares set rel_path = ? where id = ?');
    for (const m of moved) update.run(m.oldRel, m.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The folders of the media folder, for the folder picker: no files, no hidden names, no symlinks (G5).
export async function browseDisk(cfg: Config, admin: Me, rel: string): Promise<{ path: string; folders: string[] }> {
  const folder = await folderAt(cfg, admin, str(rel));
  const entries = await readdir(folder.abs, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !isHiddenName(e.name)).map((e) => e.name).sort(byName);
  return { path: folder.rel, folders };
}

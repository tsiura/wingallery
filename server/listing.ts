// Folder listings, the folder tree and recursive file lists, read live from disk. Every directory is read through readVisible(), the one place
// that decides what the gallery shows: no hidden names, no symlinks, only folders and media files (G5). Paths in and out are virtual.

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileEntry, FolderEntry, FolderNode, Listing, Me, SlideItem } from '../shared/types.ts';
import type { App } from './app.ts';
import { HttpError } from './http.ts';
import { mediaTypeOf } from './mediatypes.ts';
import type { MediaType } from './mediatypes.ts';
import { getMeta } from './meta.ts';
import { byName, isHiddenName } from './names.ts';
import { joinVpath, resolve, sharesForUser } from './vpath.ts';
import type { Loc, ShareRow } from './vpath.ts';

export const ROOT_NAME = 'Home Gallery';
const STATS_TTL_MS = 30_000;

const present = <T>(x: T | null): x is T => x !== null;
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;
const isGone = (err: unknown) => code(err) === 'ENOENT' || code(err) === 'ENOTDIR';   // nothing there, or a file where a folder was expected

interface Visible { dirs: string[]; files: { name: string; type: MediaType }[] }

// The folders and media files of a directory, each in natural name order.
export async function readVisible(abs: string): Promise<Visible> {
  const dirs: string[] = [];
  const files: Visible['files'] = [];
  for (const e of await readdir(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink() || isHiddenName(e.name)) continue;
    const type = e.isFile() ? mediaTypeOf(e.name) : null;
    if (e.isDirectory()) dirs.push(e.name);
    else if (type) files.push({ name: e.name, type });
  }
  return { dirs: dirs.sort(byName), files: files.sort((a, b) => byName(a.name, b.name)) };
}

// The folder a request names. It was resolved a moment ago, so a "gone" error means it is no folder (a file was named) or has gone since.
// Any other failure, EACCES too, is a fault of ours: fail() logs it with the path, and the owner fixes the permissions.
const readFolder = (abs: string) => readVisible(abs).catch((err) => { throw isGone(err) ? new HttpError(404, 'Not found') : err; });
// A folder met on the way down that has vanished meanwhile, or that the server may not read, counts as empty: one such folder must not take
// the listing of everything above it down too.
const readBelow = (abs: string): Promise<Visible> => readVisible(abs).catch((err) => {
  if (isGone(err) || code(err) === 'EACCES') return { dirs: [], files: [] };
  throw err;
});
// null when an entry vanished between readdir and stat: someone moved or deleted it just now.
const statGone = (abs: string): Promise<Stats | null> => stat(abs).catch((err) => { if (isGone(err)) return null; throw err; });

interface FolderStats { count: number; cover: string | null; hasChildren: boolean }

// Cached per folder for 30 s, so opening a folder doesn't walk everything below it again; invalidateStats() drops the lot after a change.
// The promise is what is cached, so requests that arrive during a walk share it.
// ponytail: entries are replaced when read, never swept. The map is bounded by the number of folders on disk.
const statsCache = new Map<string, { at: number; stats: Promise<FolderStats> }>();

export function invalidateStats(): void {
  statsCache.clear();
}

// count = media files at any depth. cover = the first of them in traversal order (the design's allFiles): a folder's own files, then each subfolder in turn.
async function walkStats(abs: string): Promise<FolderStats> {
  const { dirs, files } = await readBelow(abs);
  const subs = await Promise.all(dirs.map((d) => folderStats(join(abs, d))));
  const first = subs.findIndex((s) => s.cover !== null);
  return {
    count: files.length + subs.reduce((n, s) => n + s.count, 0),
    cover: files.length > 0 ? files[0].name : first >= 0 ? `${dirs[first]}/${subs[first].cover}` : null,
    hasChildren: dirs.length > 0,
  };
}

function folderStats(abs: string): Promise<FolderStats> {
  const hit = statsCache.get(abs);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;
  const entry = { at: Date.now(), stats: walkStats(abs) };
  statsCache.set(abs, entry);
  entry.stats.catch(() => { if (statsCache.get(abs) === entry) statsCache.delete(abs); });   // a failed walk is not remembered
  return entry.stats;
}

interface ShareDir { alias: string; abs: string | null; mtime: number }

// A share resolved the way every other request is. abs is null when its folder is gone, is no folder, leads out of the media folder or can't
// be reached; the member sees it greyed out as unavailable, whatever the reason.
async function shareDir(app: App, user: Me, share: ShareRow): Promise<ShareDir> {
  const unavailable = { alias: share.alias, abs: null, mtime: 0 };
  try {
    const { abs } = await resolve(app.cfg, user, [share], joinVpath('/', share.alias));
    const st = abs === null ? null : await stat(abs);
    return abs !== null && st?.isDirectory() ? { alias: share.alias, abs, mtime: Math.floor(st.mtimeMs) } : unavailable;
  } catch {
    return unavailable;
  }
}

// The member's shares in alias order.
const shareDirs = (app: App, user: Me): Promise<ShareDir[]> =>
  Promise.all(sharesForUser(app.db, user.id).sort((a, b) => byName(a.alias, b.alias)).map((share) => shareDir(app, user, share)));

async function shareEntries(app: App, user: Me): Promise<FolderEntry[]> {
  return Promise.all((await shareDirs(app, user)).map(async ({ alias, abs, mtime }): Promise<FolderEntry> => {
    if (abs === null) return { kind: 'folder', name: alias, mtime: 0, count: 0, cover: null, protected: true, unavailable: true };
    const { count, cover } = await folderStats(abs);
    return { kind: 'folder', name: alias, mtime, count, cover: cover === null ? null : joinVpath('/' + alias, cover), protected: true };
  }));
}

async function folderEntry(abs: string, name: string, vpath: string, isProtected: boolean): Promise<FolderEntry | null> {
  const [st, { count, cover }] = await Promise.all([statGone(abs), folderStats(abs)]);
  if (st === null) return null;
  return { kind: 'folder', name, mtime: Math.floor(st.mtimeMs), count, cover: cover === null ? null : joinVpath(vpath, cover), protected: isProtected };
}

async function fileEntry(app: App, abs: string, name: string, type: MediaType): Promise<FileEntry | null> {
  const st = await statGone(abs);
  if (!st?.isFile()) return null;
  const meta = await getMeta(app.db, abs, relative(app.cfg.mediaRoot, abs), st, type.kind);
  return { kind: type.kind, name, size: st.size, mtime: Math.floor(st.mtimeMs), ...meta, type: type.label };
}

// Folders first, then files, each in natural name order. At a member's root the entries are the shares, under their aliases.
export async function listFolder(app: App, user: Me, loc: Loc): Promise<Listing> {
  const name = loc.vpath.slice(loc.vpath.lastIndexOf('/') + 1) || ROOT_NAME;
  if (loc.abs === null) return { path: loc.vpath, name, rights: loc.rights, entries: await shareEntries(app, user) };
  const abs = loc.abs;
  const { dirs, files } = await readFolder(abs);
  const mountPoints = loc.rel === '';   // with an abs, rel is '' only at MEDIA_ROOT, whose folders are the mount points
  const [folders, items, writable] = await Promise.all([
    Promise.all(dirs.map((d) => folderEntry(join(abs, d), d, joinVpath(loc.vpath, d), mountPoints))),
    Promise.all(files.map((f) => fileEntry(app, join(abs, f.name), f.name, f.type))),
    access(abs, constants.W_OK).then(() => true, () => false),   // a read-only mount or a chmod 555 folder takes every right away
  ]);
  const r = loc.rights;
  return {
    path: loc.vpath, name,
    rights: { create: r.create && writable, update: r.update && writable, delete: r.delete && writable },
    entries: [...folders.filter(present), ...items.filter(present)],
  };
}

// The subfolders of a folder, for the tree. At a member's root they are the shares.
export async function listFolders(app: App, user: Me, loc: Loc): Promise<FolderNode[]> {
  if (loc.abs === null) {
    return Promise.all((await shareDirs(app, user)).map(async ({ alias, abs }): Promise<FolderNode> => {
      if (abs === null) return { name: alias, count: 0, hasChildren: false, unavailable: true };
      const { count, hasChildren } = await folderStats(abs);
      return { name: alias, count, hasChildren };
    }));
  }
  const abs = loc.abs;
  const { dirs } = await readFolder(abs);
  return Promise.all(dirs.map(async (name): Promise<FolderNode> => {
    const { count, hasChildren } = await folderStats(join(abs, name));
    return { name, count, hasChildren };
  }));
}

// Every media file below a folder, for a slideshow. At a member's root that is every available share in alias order, under one cap (F14.1).
export async function listFiles(app: App, user: Me, loc: Loc, cap = 5000): Promise<{ items: SlideItem[]; capped: boolean }> {
  const items: SlideItem[] = [];
  // Traversal order: a folder's own files, then each subfolder in turn. It stops at cap + 1 items; the extra one only proves there are more.
  async function walk(abs: string, vpath: string, { dirs, files }: Visible): Promise<void> {
    const take = files.slice(0, cap + 1 - items.length);
    const stats = await Promise.all(take.map((f) => statGone(join(abs, f.name))));
    take.forEach((f, i) => {
      const st = stats[i];
      if (st?.isFile()) items.push({ path: joinVpath(vpath, f.name), kind: f.type.kind, name: f.name, mtime: Math.floor(st.mtimeMs) });
    });
    for (const d of dirs) {
      if (items.length > cap) return;
      await walk(join(abs, d), joinVpath(vpath, d), await readBelow(join(abs, d)));
    }
  }
  if (loc.abs !== null) await walk(loc.abs, loc.vpath, await readFolder(loc.abs));
  else for (const { alias, abs } of await shareDirs(app, user)) if (abs !== null && items.length <= cap) await walk(abs, '/' + alias, await readBelow(abs));
  return { items: items.slice(0, cap), capped: items.length > cap };
}

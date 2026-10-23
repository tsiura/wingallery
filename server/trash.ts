// The Recycle Bin. A delete moves the item into a hidden .gallery-trash folder at the top of its top-level folder, so it stays on the same filesystem
// and the delete is one rename. Only the administrator lists, restores and purges what is there (the routes are in adminroutes.ts), and what is
// older than TRASH_DAYS goes on its own (main.ts). A delete is checked like a rename: the right, the roots, and what the listings show.
// Every disk path here comes from locate() (its abs) or from a row of the trash table, which this module wrote: never from a client string,
// and never from the id in a URL (R1).

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { DeletePreview, Me, TrashItem } from '../shared/types.ts';
import type { App } from './app.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { mapFsError, mutationQueue } from './fsops.ts';
import { HttpError } from './http.ts';
import { invalidateStats } from './listing.ts';
import { log } from './log.ts';
import { mediaTypeOf } from './mediatypes.ts';
import { isHiddenName, restoredName } from './names.ts';
import { locate, requireRight, requireUnprotected } from './vpath.ts';

export const TRASH_DIR = '.gallery-trash';
const DAY_MS = 86_400_000;
const notFound = () => new HttpError(404, 'Not found');

// top_rel is the top-level folder whose bin holds the item, original_rel where it lay: both relative to MEDIA_ROOT.
type TrashRow = { id: string; top_rel: string; original_rel: string; is_dir: number; size: number; hidden_files: number; deleted_by: string; deleted_at: number };

// The id comes from a URL, and the router has %-decoded it, so it can be '../../x': it is only a key here, and one that names no row is a 404.
function rowOf(db: DB, id: string): TrashRow {
  const row = db.prepare('select * from trash where id = ?').get(id) as TrashRow | undefined;
  if (!row) throw notFound();
  return row;
}

const binDir = (cfg: Config, row: TrashRow) => join(cfg.mediaRoot, row.top_rel, TRASH_DIR, row.id);
const forget = (db: DB, id: string) => db.prepare('delete from trash where id = ?').run(id);

// Whether anything is at `abs`, a dangling symlink included. The same check as fsops makes (which keeps its own to itself).
const taken = (abs: string): Promise<boolean> => lstat(abs).then(() => true, (e) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? false : mapFsError(e)));

interface Item { abs: string; rel: string; isDir: boolean; size: number }

// The entry a delete works on: the user may delete it, it is not a root, and it is what the listings show, a folder or a media file. A symlink
// never is, whatever it points at, and neither is a file of another kind (as for rename and move).
async function pick(app: App, user: Me, path: string): Promise<Item> {
  const loc = await locate(app, user, path);
  requireRight(loc, 'delete');
  requireUnprotected(loc);
  if (loc.abs === null) throw new HttpError(403, "You don't have permission to do that");   // only a member's root has no disk path, and the checks above refuse it (G8)
  const st = await lstat(loc.abs).catch(mapFsError);
  const isDir = st.isDirectory();
  if (!isDir && !(st.isFile() && mediaTypeOf(basename(loc.abs)))) throw notFound();
  return { abs: loc.abs, rel: loc.rel, isDir, size: st.size };
}

interface Weight { size: number; hidden: number }
const NOTHING: Weight = { size: 0, hidden: 0 };
const unseen = (e: unknown) => ['ENOENT', 'ENOTDIR', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '');

// What a folder holds: the bytes of its regular files, and how many of them the gallery doesn't show (G5): a hidden name, a type that isn't media,
// or anything below a hidden folder. They go to the bin with the folder, so they count; symlinks are never followed and don't. A folder that has
// gone, or that may not be read, counts as empty: these figures only inform, and the rename doesn't read the folder.
// ponytail: every folder and file of the tree is asked at once; a limit on that if a delete ever has to wait for a very large folder.
async function weigh(abs: string, inHidden = false): Promise<Weight> {
  const entries = await readdir(abs, { withFileTypes: true }).catch((e) => { if (unseen(e)) return []; throw e; });
  const parts = await Promise.all(entries.map(async (e): Promise<Weight> => {
    const path = join(abs, e.name);
    if (e.isSymbolicLink()) return NOTHING;
    if (e.isDirectory()) return weigh(path, inHidden || isHiddenName(e.name));
    if (!e.isFile()) return NOTHING;
    const st = await lstat(path).catch((err) => { if (unseen(err)) return null; throw err; });
    return st ? { size: st.size, hidden: inHidden || isHiddenName(e.name) || !mediaTypeOf(e.name) ? 1 : 0 } : NOTHING;
  }));
  return parts.reduce((sum, p) => ({ size: sum.size + p.size, hidden: sum.hidden + p.hidden }), NOTHING);
}

// The entry at `path` (checked, so a refusal comes first) and what it holds. Reads only, so it stays out of the mutation queue: a big folder
// takes its time here and not while everyone else's changes wait.
async function weighAt(app: App, user: Me, path: string): Promise<Weight> {
  const item = await pick(app, user, path);
  return item.isDir ? weigh(item.abs) : { size: item.size, hidden: 0 };
}

// The same checks as a delete, and what it would take with it: the files the gallery doesn't show, which the confirmation tells the user about.
export async function deletePreview(app: App, user: Me, paths: string[]): Promise<DeletePreview> {
  let hiddenFiles = 0;
  for (const path of paths) hiddenFiles += (await weighAt(app, user, path)).hidden;
  return { items: paths.length, hiddenFiles };
}

// The row goes in first, so that a failing insert moves nothing, and goes again if the rename fails: what is in the bin always has a row.
async function trashOne(app: App, user: Me, path: string, { size, hidden }: Weight): Promise<void> {
  const item = await pick(app, user, path);   // again, now that it is this one's turn: the tree and the rights may have changed while it waited
  const id = randomBytes(8).toString('hex');
  const top = item.rel.split('/')[0];   // an entry that can be deleted lies below a root, so rel has at least two segments (G8)
  const dir = join(app.cfg.mediaRoot, top, TRASH_DIR, id);
  app.db.prepare('insert into trash (id, top_rel, original_rel, is_dir, size, hidden_files, deleted_by, deleted_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, top, item.rel, Number(item.isDir), size, hidden, user.username, Date.now());
  try {
    await mkdir(dir, { recursive: true });
    await rename(item.abs, join(dir, basename(item.abs)));
  } catch (e) {
    forget(app.db, id);
    await rmdir(dir).catch(() => {});   // the folder made for it, empty; if it can't go, an empty folder in the bin is all that is left
    mapFsError(e);
  }
  invalidateStats();
  log('delete', { by: user.username, id, path: item.rel });
}

// The whole selection is checked first, so a protected folder or a name that isn't there refuses it with nothing moved. Then item by item, in
// order; each takes its turn in the queue on its own, so a long selection doesn't keep everyone else waiting. If the disk fails an item, the
// ones before it stay in the bin.
export async function trashItems(app: App, user: Me, paths: string[]): Promise<{ deleted: number }> {
  const weights: Weight[] = [];
  for (const path of paths) weights.push(await weighAt(app, user, path));
  for (let i = 0; i < paths.length; i++) await mutationQueue(() => trashOne(app, user, paths[i], weights[i]));
  return { deleted: paths.length };
}

export function listTrash(cfg: Config, db: DB): TrashItem[] {
  const rows = db.prepare('select * from trash order by deleted_at desc, id').all() as TrashRow[];
  return rows.map((r) => ({
    id: r.id, name: basename(r.original_rel), originalPath: join(cfg.mediaRoot, r.original_rel), isDir: !!r.is_dir,
    size: r.size, hiddenFiles: r.hidden_files, deletedBy: r.deleted_by, deletedAt: r.deleted_at,
  }));
}

// Back to where it was. Parent folders that have gone are made again, and a name that is taken now makes the item "name (restored).ext", then
// "name (restored 2).ext" and so on. A folder that held a share comes back to the path the share still has, which brings the share back.
// It checks a name and then renames into it, so it takes its turn in the queue (G10). `by` is the administrator, for the audit line.
// ponytail: the parent path is the one recorded at the delete, followed as it lies now. A symlink put into it since would be followed; only someone
// who can write to the media disk can do that (the app never makes one), as with the resolver's own race in vpath.ts.
export function restoreTrash(cfg: Config, db: DB, id: string, by?: string): Promise<{ restoredAs: string }> {
  return mutationQueue(async () => {
    const row = rowOf(db, id);
    const dir = binDir(cfg, row);
    const name = basename(row.original_rel);
    const parent = join(cfg.mediaRoot, dirname(row.original_rel));
    await lstat(join(dir, name)).catch(mapFsError);   // gone from the bin: a 404, and the row stays for the administrator to purge
    await mkdir(parent, { recursive: true }).catch(mapFsError);
    let to = name;
    for (let n = 1; await taken(join(parent, to)); n++) to = restoredName(name, n);
    await rename(join(dir, name), join(parent, to)).catch(mapFsError);
    forget(db, id);
    invalidateStats();
    const restoredAs = join(parent, to);
    log('restore', { by, id, path: relative(cfg.mediaRoot, restoredAs) });
    // The item is back and its row gone, so a bin folder that can't be removed is only an empty folder: logged, not a failed restore.
    await rm(dir, { recursive: true, force: true }).catch((e) => log('error', { message: `Could not remove the bin folder ${id}`, error: String(e) }));
    return { restoredAs };
  });
}

// For good: the files first, then the row, so that a purge that fails half way can be asked for again. It is in the queue because a restore of the
// same item must not meet it half way.
// ponytail: a big folder holds the queue while it is removed; rename it away inside the queue and remove it outside, if that ever shows.
export function purgeTrash(cfg: Config, db: DB, id: string, by?: string): Promise<void> {
  return mutationQueue(async () => {
    const row = rowOf(db, id);
    await rm(binDir(cfg, row), { recursive: true, force: true }).catch(mapFsError);
    forget(db, id);
    invalidateStats();
    log('purge', { by, id, path: row.original_rel });
  });
}

// Each item takes its own turn. One that can't be purged (its top-level folder is read-only on disk) doesn't keep the others in the bin: the first
// such error is thrown when the rest are done. A row that has gone meanwhile (restored, or purged by someone else) is not an error.
async function purgeAll(cfg: Config, db: DB, ids: string[], by?: string): Promise<number> {
  let purged = 0, failed: unknown;
  for (const id of ids) {
    try {
      await purgeTrash(cfg, db, id, by);
      purged++;
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) failed ??= e;
    }
  }
  if (failed) throw failed;
  return purged;
}

const idsOf = (rows: Record<string, unknown>[]) => rows.map((r) => r.id as string);

export async function emptyTrash(cfg: Config, db: DB, by?: string): Promise<void> {
  await purgeAll(cfg, db, idsOf(db.prepare('select id from trash').all()), by);
}

// Older than `days` days, so an item exactly that old stays until the next run. No `by`: nobody asked, the clock did.
export async function purgeExpired(cfg: Config, db: DB, days: number, now = Date.now()): Promise<number> {
  return purgeAll(cfg, db, idsOf(db.prepare('select id from trash where deleted_at < ?').all(now - days * DAY_MS)));
}

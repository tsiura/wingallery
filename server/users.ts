import { rm } from 'node:fs/promises';
import type { AdminUser, Me, Prefs, Role, ViewMode } from '../shared/types.ts';
import { hashPassword, revokeUserSessions, touchSession } from './auth.ts';   // auth.ts imports getMe back; each only calls the other inside functions, so the cycle is safe
import type { DB } from './db.ts';
import { HttpError, str } from './http.ts';
import { log } from './log.ts';

const isView = (v: unknown): v is ViewMode => v === 'large' || v === 'medium' || v === 'details';
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 20;

// Stored prefs are read leniently: anything missing or out of range falls back to its default.
export function parsePrefs(json: string): Prefs {
  let p: Partial<Prefs> | null = null;
  try { p = JSON.parse(json); } catch { /* unreadable prefs mean defaults */ }
  const view = p?.defaultView, secs = p?.slideSeconds;
  return { defaultView: isView(view) ? view : 'large', slideSeconds: isSeconds(secs) ? secs : 5 };
}

// Changes only the fields the patch names, and only when every named one is valid (a patch is all or nothing). The patch usually
// comes straight from a request body, so each value is checked at run time (G6); null is a value, not "absent".
export function setPrefs(db: DB, id: number, patch: Partial<Prefs>): Prefs {
  const { defaultView, slideSeconds } = patch;
  if ((defaultView !== undefined && !isView(defaultView)) || (slideSeconds !== undefined && !isSeconds(slideSeconds))) throw new HttpError(400, 'Invalid preferences');
  const current = getMe(db, id)?.prefs;
  if (!current) throw new HttpError(404, 'Not found');
  const prefs: Prefs = { defaultView: defaultView ?? current.defaultView, slideSeconds: slideSeconds ?? current.slideSeconds };
  db.prepare('update users set prefs = ? where id = ?').run(JSON.stringify(prefs), id);
  return prefs;
}

export function countUsers(db: DB): number {
  return (db.prepare('select count(*) as n from users').get() as { n: number }).n;
}

export function getMe(db: DB, id: number): Me | null {
  const r = db.prepare('select id, username, display_name, role, prefs from users where id = ?').get(id) as
    { id: number; username: string; display_name: string; role: Role; prefs: string } | undefined;
  return r ? { id: r.id, username: r.username, displayName: r.display_name, role: r.role, prefs: parsePrefs(r.prefs) } : null;
}

// The username column is NOCASE, so any letter case finds the account. The text is used as given, with no trimming:
// the login limiter keys on the same text, and the two must never disagree about which account an attempt targets.
export function findLogin(db: DB, username: string): { id: number; passwordHash: string } | null {
  const r = db.prepare('select id, password_hash from users where username = ?').get(str(username)) as { id: number; password_hash: string } | undefined;
  return r ? { id: r.id, passwordHash: r.password_hash } : null;
}

// The one password rule (eight characters, not eight UTF-16 units), checked before the slow hash. Anything but a string counts as ''.
function checkedPassword(v: unknown): string {
  const password = str(v);
  if ([...password].length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return password;
}

// Stores the new hash and ends the user's sessions, except `keepToken` (the one a user changes their own password from).
// That session has to be alive when the hash is done: if a reset or a sign-out ended it meanwhile, this change was started with a
// password or a cookie that no longer counts, and it must not overwrite what ended it (401, nothing stored).
// The check, the new hash and the revoke are one write transaction, started before the check reads anything: a reset from a second
// process (the CLI) then cannot land between them (R4a).
export async function setPassword(db: DB, id: number, password: string, keepToken: string | null = null): Promise<void> {
  const hash = await hashPassword(checkedPassword(password));
  db.exec('BEGIN IMMEDIATE');
  try {
    if (keepToken !== null && touchSession(db, keepToken)?.user.id !== id) throw new HttpError(401, 'Sign in required');
    if (db.prepare('update users set password_hash = ? where id = ?').run(hash, id).changes === 0) throw new HttpError(404, 'Not found');
    revokeUserSessions(db, id, keepToken);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The one username rule: trimmed, lower case, 2–32 of a-z 0-9 . _ -. Anything but a string counts as '' (G6).
function checkedUsername(v: unknown): string {
  const username = str(v).trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new HttpError(400, 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore');
  return username;
}

// The one display-name rule (R1): trimmed, the username when empty, at most 64 characters. Anything but a string counts as ''.
function checkedDisplayName(v: unknown, username: string): string {
  const displayName = str(v).trim() || username;
  if ([...displayName].length > 64) throw new HttpError(400, 'Display name is too long');
  return displayName;
}

// 2067 = SQLITE_CONSTRAINT_UNIQUE; the UNIQUE NOCASE index, not a prior lookup, decides, so two racing requests can't both win
function usernameTaken(err: unknown): never {
  if ((err as { errcode?: number }).errcode === 2067) throw new HttpError(409, 'That username is taken');
  throw err;
}

// The fields usually come straight from a request body, so each is checked at run time (G6). A role that isn't exactly 'admin' is 'member'.
export async function createUser(db: DB, input: { username: string; displayName: string; password: string; role: Role }): Promise<Me> {
  const username = checkedUsername(input.username);
  const displayName = checkedDisplayName(input.displayName, username);
  const hash = await hashPassword(checkedPassword(input.password));
  try {
    const { lastInsertRowid } = db.prepare('insert into users (username, display_name, role, password_hash, prefs, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(username, displayName, input.role === 'admin' ? 'admin' : 'member', hash, '{}', Date.now());
    return getMe(db, Number(lastInsertRowid))!;
  } catch (err) {
    usernameTaken(err);
  }
}

// --- the administrator's view of the accounts ---

type UserRow = { id: number; username: string; display_name: string; role: Role };
const adminUser = (r: UserRow): AdminUser => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role });

export function listUsers(db: DB): AdminUser[] {
  return (db.prepare('select id, username, display_name, role from users order by id').all() as UserRow[]).map(adminUser);
}

export function getAdminUser(db: DB, id: number): AdminUser | null {
  const r = db.prepare('select id, username, display_name, role from users where id = ?').get(id) as UserRow | undefined;
  return r ? adminUser(r) : null;
}

// The actor is who the request was made as, read before its body was. One who was demoted or removed since no longer counts. Together with
// "nobody changes their own role or removes themselves" this keeps an administrator when two of them act on each other at the same moment.
function requireStillAdmin(db: DB, actor: Me): void {
  if (getAdminUser(db, actor.id)?.role !== 'admin') throw new HttpError(403, 'Administrators only');
}

export type UserPatch = { username?: string; displayName?: string; role?: Role };

// Changes only the fields the patch names, and only when every named one is valid (a patch is all or nothing). Its values usually come
// straight from a request body, so each is checked at run time (G6); null is a value, not "absent". Unlike createUser, a role that is
// neither 'admin' nor 'member' is refused rather than guessed at: here a guess would demote someone.
export function updateUser(db: DB, actor: Me, id: number, patch: UserPatch): AdminUser {
  requireStillAdmin(db, actor);
  const current = getAdminUser(db, id);
  if (!current) throw new HttpError(404, 'Not found');
  const { role = current.role } = patch;
  if (role !== 'admin' && role !== 'member') throw new HttpError(400, 'Invalid JSON');
  const roleChanges = role !== current.role;
  if (roleChanges && id === actor.id) throw new HttpError(403, "You can't change your own role");
  const username = patch.username === undefined ? current.username : checkedUsername(patch.username);
  const displayName = patch.displayName === undefined ? current.displayName : checkedDisplayName(patch.displayName, username);
  try {
    db.prepare('update users set username = ?, display_name = ?, role = ? where id = ?').run(username, displayName, role, id);
  } catch (err) {
    usernameTaken(err);
  }
  if (roleChanges) revokeUserSessions(db, id);   // they sign in again as what they are now
  return { id, username, displayName, role };
}

// Deleting the row takes the user's sessions, shares and upload records with it (ON DELETE CASCADE). The row goes first, so access ends
// even when a temp file can't be removed; then the temp files of their unfinished uploads, which nothing else would ever clean up.
// By then the user is gone, so a temp file that stays (a read-only folder, a fault of the disk) is no failure of the removal: the caller must
// still answer 200 and write its audit line. Each file that stays is logged as an error, with its path, for the owner to remove by hand.
export async function removeUser(db: DB, actor: Me, id: number): Promise<void> {
  requireStillAdmin(db, actor);
  if (id === actor.id) throw new HttpError(403, "You can't remove yourself");
  const temps = (db.prepare('select temp_abs from uploads where user_id = ?').all(id) as { temp_abs: string }[]).map((r) => r.temp_abs);
  if (db.prepare('delete from users where id = ?').run(id).changes === 0) throw new HttpError(404, 'Not found');
  const removals = await Promise.allSettled(temps.map((path) => rm(path, { force: true })));
  for (const done of removals) {
    if (done.status === 'rejected') log('error', { message: `Could not remove an upload temp file of removed user ${id}: ${done.reason instanceof Error ? done.reason.message : String(done.reason)}` });
  }
}

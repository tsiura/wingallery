import type { Me, Prefs, Role, ViewMode } from '../shared/types.ts';
import { hashPassword, revokeUserSessions, touchSession } from './auth.ts';   // auth.ts imports getMe back; each only calls the other inside functions, so the cycle is safe
import type { DB } from './db.ts';
import { HttpError, str } from './http.ts';

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
export async function setPassword(db: DB, id: number, password: string, keepToken: string | null = null): Promise<void> {
  const hash = await hashPassword(checkedPassword(password));
  if (keepToken !== null && touchSession(db, keepToken)?.user.id !== id) throw new HttpError(401, 'Sign in required');
  if (db.prepare('update users set password_hash = ? where id = ?').run(hash, id).changes === 0) throw new HttpError(404, 'Not found');
  revokeUserSessions(db, id, keepToken);
}

// The fields usually come straight from a request body, so each is checked at run time (G6). A role that isn't exactly 'admin' is 'member'.
export async function createUser(db: DB, input: { username: string; displayName: string; password: string; role: Role }): Promise<Me> {
  const username = str(input.username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new HttpError(400, 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore');
  const displayName = str(input.displayName).trim() || username;
  if ([...displayName].length > 64) throw new HttpError(400, 'Display name is too long');
  const hash = await hashPassword(checkedPassword(input.password));
  try {
    const { lastInsertRowid } = db.prepare('insert into users (username, display_name, role, password_hash, prefs, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(username, displayName, input.role === 'admin' ? 'admin' : 'member', hash, '{}', Date.now());
    return getMe(db, Number(lastInsertRowid))!;
  } catch (err) {
    // 2067 = SQLITE_CONSTRAINT_UNIQUE; the UNIQUE NOCASE index, not a prior lookup, decides, so two racing requests can't both win
    if ((err as { errcode?: number }).errcode === 2067) throw new HttpError(409, 'That username is taken');
    throw err;
  }
}

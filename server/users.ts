import type { Me, Prefs, Role } from '../shared/types.ts';
import { hashPassword, str } from './auth.ts';   // auth.ts imports getMe back; each only calls the other inside functions, so the cycle is safe
import type { DB } from './db.ts';
import { HttpError } from './http.ts';

// Stored prefs are read leniently: anything missing or out of range falls back to its default.
export function parsePrefs(json: string): Prefs {
  let p: Partial<Prefs> | null = null;
  try { p = JSON.parse(json); } catch { /* unreadable prefs mean defaults */ }
  const view = p?.defaultView, secs = p?.slideSeconds;
  return {
    defaultView: view === 'large' || view === 'medium' || view === 'details' ? view : 'large',
    slideSeconds: typeof secs === 'number' && Number.isInteger(secs) && secs >= 2 && secs <= 20 ? secs : 5,
  };
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

// The fields usually come straight from a request body, so each is checked at run time (G6). A role that isn't exactly 'admin' is 'member'.
export async function createUser(db: DB, input: { username: string; displayName: string; password: string; role: Role }): Promise<Me> {
  const username = str(input.username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw new HttpError(400, 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore');
  const displayName = str(input.displayName).trim() || username;
  if ([...displayName].length > 64) throw new HttpError(400, 'Display name is too long');
  const password = str(input.password);
  if ([...password].length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const hash = await hashPassword(password);
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

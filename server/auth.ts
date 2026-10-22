import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Me } from '../shared/types.ts';
import type { DB } from './db.ts';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';
import { getMe } from './users.ts';   // users.ts imports hashPassword back; each only calls the other inside functions, so the cycle is safe

export const SESSION_COOKIE = 'hg_session';

// Request bodies are JSON, so a field typed string can be anything (G6): whatever is not a string counts as ''.
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// --- passwords: argon2id, stored as a PHC string ---

const argon2id = promisify(argon2);
const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id('argon2id', { message: pw, nonce: salt, parallelism: 1, tagLength: 32, memory: 19456, passes: 2 });
  return `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(hash)}`;
}

// The cost parameters come from the stored string, so old hashes keep verifying after the defaults above change.
export async function verifyPassword(pw: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64');
  const got = await argon2id('argon2id', { message: str(pw), nonce: Buffer.from(m[4], 'base64'), parallelism: +m[3], tagLength: want.length, memory: +m[1], passes: +m[2] });
  return timingSafeEqual(got, want);
}

// A real hash (of a password nobody knows) with the parameters above. Checking an unknown user against it costs the
// same as a wrong password, so response time doesn't reveal which usernames exist. server/test/auth.test.ts guards the cost.
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$TTwDncvJhaUR4e985lpkrA$DDOjw3CzF6Lkz1X42KpZxoH2OFyatilnGfaEtY9Mwco';

export async function burnPasswordCheck(pw: string): Promise<void> {
  await verifyPassword(pw, DUMMY_HASH);
}

// --- sessions: the cookie holds a random token, the database only its SHA-256 ---

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const lifetime = (remember: boolean) => (remember ? 30 * DAY : 12 * HOUR);

export function createSession(db: DB, userId: number, remember: boolean, ip: string, userAgent: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const persistent = remember === true;   // it comes from the login body: "false" or 1 must not mean a 30-day session
  db.prepare('insert into sessions (token_hash, user_id, remember, expires_at, last_seen_at, ip, user_agent) values (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, persistent ? 1 : 0, now + lifetime(persistent), now, ip, userAgent);
  return token;
}

// Null for an unknown or expired session (an expired one is deleted). A session seen more than a minute ago slides
// forward by its full lifetime; `refreshed` says the cookie needs re-sending, which only a persistent one does.
// ponytail: the row of a session nobody presents again stays until its user is removed; delete expired rows at login if the table ever matters.
export function touchSession(db: DB, token: string, now = Date.now()): { user: Me; remember: boolean; refreshed: boolean } | null {
  const hash = sha256(token);
  const s = db.prepare('select user_id, remember, expires_at, last_seen_at from sessions where token_hash = ?').get(hash) as
    { user_id: number; remember: number; expires_at: number; last_seen_at: number } | undefined;
  if (!s) return null;
  const user = s.expires_at > now ? getMe(db, s.user_id) : null;
  if (!user) {
    db.prepare('delete from sessions where token_hash = ?').run(hash);
    return null;
  }
  const remember = s.remember === 1;
  const slide = now - s.last_seen_at > MINUTE;
  if (slide) db.prepare('update sessions set last_seen_at = ?, expires_at = ? where token_hash = ?').run(now, now + lifetime(remember), hash);
  return { user, remember, refreshed: slide && remember };
}

export function revokeSession(db: DB, token: string): void {
  db.prepare('delete from sessions where token_hash = ?').run(sha256(token));
}

export function revokeUserSessions(db: DB, userId: number, exceptToken: string | null = null): void {
  db.prepare('delete from sessions where user_id = ? and token_hash is not ?').run(userId, exceptToken === null ? null : sha256(exceptToken));
}

export function sessionCookie(token: string, remember: boolean, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${remember === true ? '; Max-Age=2592000' : ''}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// --- brute-force limits (in memory; the app is a single process) ---

const WINDOW = 15 * MINUTE;   // both the username lock and the IP window
const USER_FAILS = 5, IP_FAILS = 20;
// Account names are at most 32 characters, so a longer one can't match an account; cutting it keeps a huge made-up name from becoming a huge key.
const key = (username: string) => str(username).slice(0, 64).toLowerCase();
const blocked = (ms: number): { ok: false; retryAfterMin: number } => ({ ok: false, retryAfterMin: Math.ceil(ms / MINUTE) });

// ponytail: keyed per address, so one IPv6 /64 can rotate through its addresses; key on the /64 if that ever shows up in the audit log.
export class LoginLimiter {
  private users = new Map<string, { fails: number; last: number }>();   // consecutive failures per username, until success or a quiet window
  private ips = new Map<string, number[]>();                            // the newest failure times per IP
  private swept = 0;

  // Blocked: a username after 5 failures, for 15 minutes from the last one; an IP with 20 failures inside the last 15 minutes.
  // Checking before a slow password check is not enough: a burst of parallel attempts all pass it before the first failure
  // lands. A handler must call check() again after the await and refuse, even a right password, if it now blocks.
  check(ip: string, username: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMin: number } {
    const u = this.users.get(key(username));
    if (u && u.fails >= USER_FAILS && now - u.last < WINDOW) return blocked(u.last + WINDOW - now);
    const recent = this.recent(ip, now);
    if (recent.length >= IP_FAILS) return blocked(recent[recent.length - IP_FAILS] + WINDOW - now);
    return { ok: true };
  }

  fail(ip: string, username: string, now = Date.now()): void {
    this.sweep(now);
    const k = key(username), u = this.users.get(k);
    this.users.set(k, { fails: u && now - u.last < WINDOW ? u.fails + 1 : 1, last: now });
    this.ips.set(ip, [...this.recent(ip, now), now].slice(-IP_FAILS));
  }

  // Only the username is cleared: logging in to one's own account must not reset the count for the address.
  succeed(username: string): void {
    this.users.delete(key(username));
  }

  private recent(ip: string, now: number): number[] {
    return (this.ips.get(ip) ?? []).filter((t) => now - t < WINDOW);
  }

  // Drops entries that can no longer block anyone, so a flood of made-up names or addresses can't fill memory.
  private sweep(now: number): void {
    if (now - this.swept < MINUTE) return;
    this.swept = now;
    for (const [k, u] of this.users) if (now - u.last >= WINDOW) this.users.delete(k);
    for (const [k, ts] of this.ips) if (now - ts[ts.length - 1] >= WINDOW) this.ips.delete(k);
  }
}

// --- guards for handlers ---

export function requireUser(ctx: Ctx): Me {
  if (!ctx.user) throw new HttpError(401, 'Sign in required');
  return ctx.user;
}

export function requireAdmin(ctx: Ctx): Me {
  const me = requireUser(ctx);
  if (me.role !== 'admin') throw new HttpError(403, 'Administrators only');
  return me;
}

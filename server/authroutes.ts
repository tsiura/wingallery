import { timingSafeEqual } from 'node:crypto';
import type { Prefs, SessionInfo } from '../shared/types.ts';
import type { App } from './app.ts';
import { burnPasswordCheck, clearSessionCookie, createSession, requireUser, revokeSession, sessionCookie, verifyPassword } from './auth.ts';
import { HttpError, readJson, str } from './http.ts';
import type { Ctx } from './http.ts';
import { log } from './log.ts';
import { countUsers, createUser, findLogin, getMe, setPassword, setPrefs } from './users.ts';

// Credentials are short, and strangers can reach these endpoints, so a small cap keeps them from buffering megabytes.
const BODY_LIMIT = 8 * 1024;

// The body must be a JSON object. Its fields are untrusted (G6): each one is read through str() or checked before it is used.
async function readObject(ctx: Ctx): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(ctx, BODY_LIMIT);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON');
  return body as Record<string, unknown>;
}

// Compared as bytes: strings of equal length can differ in bytes, and timingSafeEqual throws on unequal lengths.
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerAuthRoutes(app: App): void {
  const { cfg, db, limiter, router } = app;

  // 429 while the username or the address is locked. A password check takes a while, so a handler calls this before it and again after (R1).
  function checkLimit(ctx: Ctx, username: string): void {
    const c = limiter.check(ctx.ip, username);
    if (!c.ok) throw new HttpError(429, `Too many attempts, try again in ${c.retryAfterMin} minutes`);
  }

  function startSession(ctx: Ctx, userId: number, remember: boolean): void {
    const agent = (ctx.req.headers['user-agent'] ?? '').slice(0, 200);   // kept for the audit only, and a header can be as big as Node allows
    ctx.res.setHeader('Set-Cookie', sessionCookie(createSession(db, userId, remember, ctx.ip, agent), remember, cfg.cookieSecure));
  }

  router.add('GET', '/api/session', (ctx): SessionInfo => ({ user: ctx.user, setupRequired: countUsers(db) === 0 }));

  router.add('POST', '/api/login', async (ctx) => {
    const body = await readObject(ctx);
    const username = str(body.username), password = str(body.password);   // this very text goes to findLogin and to the limiter
    checkLimit(ctx, username);
    const found = findLogin(db, username);
    let right = false;
    if (found) right = await verifyPassword(password, found.passwordHash);
    else await burnPasswordCheck(password);   // an unknown name costs as much time as a wrong password
    checkLimit(ctx, username);                // guesses made while this one was hashing may have locked the name; a right password doesn't get past that
    // A reset ends every session. If the password was reset while this hash ran, the old one it just matched must not start a session that outlives the reset.
    // ponytail: that is settled inside this process; the CLI is another one and could still land between this read and the insert in startSession (microseconds); make the insert conditional on the hash if that ever shows.
    const current = right && found ? findLogin(db, username) : null;
    const user = found && current?.id === found.id && current.passwordHash === found.passwordHash ? getMe(db, found.id) : null;   // null as well when the account was removed meanwhile
    if (!user) {
      limiter.fail(ctx.ip, username);
      log('login_failed', { username: username.slice(0, 64), ip: ctx.ip });
      throw new HttpError(401, 'Wrong username or password');
    }
    limiter.succeed(username);
    startSession(ctx, user.id, body.remember === true);
    log('login', { username: user.username, ip: ctx.ip });
    return { user };
  });

  router.add('POST', '/api/logout', (ctx) => {
    if (ctx.token) revokeSession(db, ctx.token);
    if (ctx.user) log('logout', { username: ctx.user.username, ip: ctx.ip });
    ctx.res.setHeader('Set-Cookie', clearSessionCookie(cfg.cookieSecure));   // also without a session: the cookie goes either way
    return { ok: true };
  });

  router.add('POST', '/api/setup', async (ctx) => {
    const body = await readObject(ctx);
    if (countUsers(db) > 0) throw new HttpError(409, 'Already set up');   // before the token, so a used link says why
    const link = app.setupToken;
    if (link === null || !sameText(str(body.token), link)) throw new HttpError(403, 'Invalid setup link');
    // The link is taken before the slow hash, so a second request arriving meanwhile finds it gone: one link makes one administrator.
    app.setupToken = null;
    const admin = await createUser(db, { username: str(body.username), displayName: str(body.displayName), password: str(body.password), role: 'admin' })
      .catch((err) => { app.setupToken = link; throw err; });   // a typo in the form must not burn the link
    startSession(ctx, admin.id, true);
    log('setup', { username: admin.username, ip: ctx.ip });
    return { user: admin };
  });

  router.add('POST', '/api/me/password', async (ctx) => {
    const me = requireUser(ctx);
    const body = await readObject(ctx);
    // Checking the current password is a password oracle for whoever holds the cookie (a stolen session, a screen left open),
    // so it counts against the same lock as the login, and a right one clears the count as a login does.
    checkLimit(ctx, me.username);
    const row = findLogin(db, me.username);
    const right = row !== null && await verifyPassword(str(body.current), row.passwordHash);
    checkLimit(ctx, me.username);
    if (!right) {
      limiter.fail(ctx.ip, me.username);
      throw new HttpError(400, 'Current password is wrong');
    }
    limiter.succeed(me.username);
    await setPassword(db, me.id, str(body.next), ctx.token);   // this session stays, every other one ends; if it ended meanwhile, nothing is stored
    log('password_set', { username: me.username, ip: ctx.ip });
    return { ok: true };
  });

  router.add('PUT', '/api/me/prefs', async (ctx) => {
    const me = requireUser(ctx);
    const body = await readObject(ctx);
    return setPrefs(db, me.id, { defaultView: body.defaultView, slideSeconds: body.slideSeconds } as Partial<Prefs>);   // setPrefs checks the types
  });
}

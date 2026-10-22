import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BlockList } from 'node:net';
import {
  LoginLimiter, SESSION_COOKIE, burnPasswordCheck, clearSessionCookie, createSession, hashPassword, requireAdmin,
  requireUser, revokeSession, revokeUserSessions, sessionCookie, touchSession, verifyPassword,
} from '../auth.ts';
import { openDb } from '../db.ts';
import { countUsers, createUser, findLogin, getMe, parsePrefs } from '../users.ts';
import { startTestApp } from './helpers.ts';

const H = 3_600_000, D = 24 * H, M = 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const HINT = "Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES.";

test('password hashing', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.notEqual(h, await hashPassword('correct horse'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});
test('verifyPassword refuses anything but an argon2id v19 string', async () => {
  for (const bad of ['', 'plain', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g', '$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'])
    assert.equal(await verifyPassword('x', bad), false, bad);
});
test('burnPasswordCheck costs as much as a real check', async () => {
  const h = await hashPassword('x');
  const ms = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t; };
  const real = Math.min(await ms(() => verifyPassword('y', h)), await ms(() => verifyPassword('y', h)));
  // a malformed or cheaper dummy hash would answer almost at once, which tells an attacker the user does not exist
  assert.ok(await ms(() => burnPasswordCheck('y')) > real / 2, 'unknown users must not be answered faster than wrong passwords');
});
test('createUser validation', async () => {
  const db = openDb(':memory:');
  await createUser(db, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'admin' });
  await assert.rejects(createUser(db, { username: 'Alice', displayName: 'A', password: 'password123', role: 'member' }), { status: 409, message: 'That username is taken' });
  await assert.rejects(createUser(db, { username: 'Bad Name', displayName: 'B', password: 'password123', role: 'member' }), { status: 400 });
  await assert.rejects(createUser(db, { username: 'bob', displayName: 'B', password: 'short', role: 'member' }), { message: 'Password must be at least 8 characters' });
});
test('createUser: normalised username, display name rules, hashed password', async () => {
  const db = openDb(':memory:');
  const me = await createUser(db, { username: ' Alice.B ', displayName: '   ', password: 'password123', role: 'admin' });
  assert.deepEqual(me, { id: 1, username: 'alice.b', displayName: 'alice.b', role: 'admin', prefs: { defaultView: 'large', slideSeconds: 5 } });
  const row = db.prepare('select password_hash, prefs, created_at from users').get() as any;
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(row.prefs, '{}');
  assert.ok(Math.abs(row.created_at - Date.now()) < M);
  assert.equal(await verifyPassword('password123', row.password_hash), true);
  assert.equal((await createUser(db, { username: 'bob', displayName: '  Bob B.  ', password: '12345678', role: 'member' })).displayName, 'Bob B.');
  assert.equal((await createUser(db, { username: 'x'.repeat(32), displayName: 'x'.repeat(64), password: 'password123', role: 'member' })).displayName, 'x'.repeat(64));
  assert.equal((await createUser(db, { username: 'zz', displayName: 'Z', password: 'password123', role: 'member' })).username, 'zz');
  const badName = 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore';
  for (const username of ['', ' ', 'a', 'x'.repeat(33), 'a b', 'ä1', 'a/b', '../x', 'a\nb'])
    await assert.rejects(createUser(db, { username, displayName: 'X', password: 'password123', role: 'member' }), { status: 400, message: badName }, JSON.stringify(username));
  await assert.rejects(createUser(db, { username: 'carol', displayName: 'x'.repeat(65), password: 'password123', role: 'member' }), { status: 400 });
  // eight characters, not eight UTF-16 units
  await assert.rejects(createUser(db, { username: 'carol', displayName: 'C', password: '😀😀😀😀', role: 'member' }), { status: 400, message: 'Password must be at least 8 characters' });
  await assert.rejects(createUser(db, { username: ' ALICE.b', displayName: 'C', password: 'password123', role: 'member' }), { status: 409, message: 'That username is taken' });
  assert.equal(countUsers(db), 4);   // a rejected user leaves nothing behind
});
test('wrong-typed input counts as empty and never throws (G6)', async () => {
  const db = openDb(':memory:');
  const bad: any[] = [undefined, null, 5, true, {}, ['zed'], { toString: () => 'zed' }];
  const noName = 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore';
  for (const v of bad) {
    await assert.rejects(createUser(db, { username: v, displayName: 'X', password: 'password123', role: 'member' }), { status: 400, message: noName });
    await assert.rejects(createUser(db, { username: 'zed', displayName: 'X', password: v, role: 'member' }), { status: 400, message: 'Password must be at least 8 characters' });
  }
  assert.equal(countUsers(db), 0);
  const zed = await createUser(db, { username: 'zed', displayName: 5 as any, password: 'password123', role: ['admin'] as any });
  assert.deepEqual([zed.displayName, zed.role], ['zed', 'member']);               // no display name -> the username; a role that isn't 'admin' never promotes
  assert.equal((await createUser(db, { username: 'zoe', displayName: 'Zoe', password: 'password123', role: 'superuser' as any })).role, 'member');
  for (const v of bad) assert.equal(findLogin(db, v), null, String(v));
  const hash = findLogin(db, 'zed')!.passwordHash;
  for (const v of [undefined, 5, {}]) assert.equal(await verifyPassword(v as any, hash), false);
  await burnPasswordCheck(undefined as any);
  const l = new LoginLimiter();
  for (const v of bad.slice(0, 5)) { assert.deepEqual(l.check('1.1.1.1', v), { ok: true }); l.fail('1.1.1.1', v); }
  assert.equal(l.check('2.2.2.2', '').ok, false);   // all of them were the one empty username
});
test('only a literal true makes a session persistent (G6)', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, { username: 'aa', displayName: 'A', password: 'password123', role: 'member' });
  const span = (tok: string) => db.prepare('select remember, expires_at - last_seen_at as span from sessions where token_hash = ?').get(sha256(tok)) as any;
  for (const v of ['false', 'true', 1, 'yes', {}, null, undefined, 0, false] as any[]) {
    const tok = createSession(db, u.id, v, 'ip', 'ua');
    assert.deepEqual([span(tok).remember, span(tok).span], [0, 12 * H], String(v));
    assert.doesNotMatch(sessionCookie(tok, v, true), /Max-Age/, String(v));
  }
  const tok = createSession(db, u.id, true, 'ip', 'ua');
  assert.deepEqual([span(tok).remember, span(tok).span], [1, 30 * D]);
});
test('findLogin, getMe, countUsers', async () => {
  const db = openDb(':memory:');
  assert.deepEqual([countUsers(db), getMe(db, 1), findLogin(db, 'zed')], [0, null, null]);
  const u = await createUser(db, { username: 'zed', displayName: 'Zed', password: 'password123', role: 'member' });
  const login = findLogin(db, 'ZeD');
  assert.equal(login?.id, u.id);
  assert.equal(await verifyPassword('password123', login!.passwordHash), true);
  assert.equal(findLogin(db, 'zed '), null);   // no trimming here: the login limiter keys on the very same text
  assert.equal(findLogin(db, 'ze'), null);
  assert.deepEqual(getMe(db, u.id), u);
  assert.equal(countUsers(db), 1);
});
test('parsePrefs falls back to the defaults field by field', () => {
  const d = { defaultView: 'large', slideSeconds: 5 };
  for (const junk of ['{}', 'not json', '', 'null', '[1]', '5', '"details"']) assert.deepEqual(parsePrefs(junk), d, junk);
  assert.deepEqual(parsePrefs('{"defaultView":"details","slideSeconds":12}'), { defaultView: 'details', slideSeconds: 12 });
  assert.deepEqual(parsePrefs('{"defaultView":"medium","slideSeconds":2}'), { defaultView: 'medium', slideSeconds: 2 });
  assert.deepEqual(parsePrefs('{"defaultView":"grid","slideSeconds":1}'), d);
  assert.deepEqual(parsePrefs('{"defaultView":"medium","slideSeconds":"7"}'), { defaultView: 'medium', slideSeconds: 5 });
  assert.deepEqual(parsePrefs('{"defaultView":["large"],"slideSeconds":20}'), { defaultView: 'large', slideSeconds: 20 });
  for (const s of ['21', '2.5', 'null', '-5']) assert.deepEqual(parsePrefs(`{"slideSeconds":${s}}`), d, s);
});
test('sessions: idle, remember, sliding, revoke', async () => {
  const db = openDb(':memory:');
  // 'aa', not the plan's 'a': one character is below the 2-character username minimum (the pinned message says 2–32)
  const u = await createUser(db, { username: 'aa', displayName: 'A', password: 'password123', role: 'member' });
  const H = 3_600_000, D = 24 * H;
  const n = createSession(db, u.id, false, 'ip', 'ua');
  assert.equal(touchSession(db, n)?.user.username, 'aa');
  const created = Date.now();
  assert.ok(touchSession(db, n, created + 11 * H));
  assert.equal(touchSession(db, n, created + 11 * H + 12 * H + 61_000), null);
  const r = createSession(db, u.id, true, 'ip', 'ua');
  assert.ok(touchSession(db, r, created + 29 * D));                        // slides to +59d
  assert.ok(touchSession(db, r, created + 58 * D));
  assert.equal(touchSession(db, r, created + 58 * D + 31 * D), null);
  const keep = createSession(db, u.id, true, 'ip', 'ua'), drop = createSession(db, u.id, true, 'ip', 'ua');
  revokeUserSessions(db, u.id, keep);
  assert.ok(touchSession(db, keep)); assert.equal(touchSession(db, drop), null);
});
test('sessions: only the hash is stored; unknown, revoked and deleted-user sessions are dead', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, { username: 'aa', displayName: 'A', password: 'password123', role: 'member' });
  const tok = createSession(db, u.id, false, '10.0.0.1', 'agent/1');
  const row = db.prepare('select * from sessions').get() as any;
  assert.equal(tok.length, 43);   // 32 random bytes, base64url
  assert.equal(row.token_hash, sha256(tok));
  assert.deepEqual([row.user_id, row.remember, row.ip, row.user_agent, row.expires_at - row.last_seen_at], [u.id, 0, '10.0.0.1', 'agent/1', 12 * H]);
  assert.notEqual(createSession(db, u.id, false, 'ip', 'ua'), tok);
  for (const junk of ['nonsense', '', row.token_hash]) assert.equal(touchSession(db, junk), null, junk);   // the stored hash is not a credential
  revokeSession(db, tok);
  assert.equal(touchSession(db, tok), null);
  const gone = createSession(db, u.id, true, 'ip', 'ua');
  db.prepare('delete from users where id = ?').run(u.id);
  assert.equal(touchSession(db, gone), null);   // removing a user ends their sessions
  assert.equal((db.prepare('select count(*) as n from sessions').get() as any).n, 0);
});
test('sessions: sliding window, refreshed marker, expired rows are deleted', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, { username: 'aa', displayName: 'A', password: 'password123', role: 'member' });
  const other = await createUser(db, { username: 'bb', displayName: 'B', password: 'password123', role: 'member' });
  const col = (name: string, tok: string) => (db.prepare(`select ${name} as v from sessions where token_hash = ?`).get(sha256(tok)) as any)?.v;
  const r = createSession(db, u.id, true, 'ip', 'ua'), n = createSession(db, u.id, false, 'ip', 'ua'), o = createSession(db, other.id, true, 'ip', 'ua');
  const [rSeen, nSeen] = [col('last_seen_at', r), col('last_seen_at', n)];
  assert.deepEqual([touchSession(db, r)?.refreshed, touchSession(db, n)?.refreshed], [false, false]);   // just seen, nothing to slide
  assert.equal(touchSession(db, r, rSeen + 60_000)?.refreshed, false);                                  // "more than a minute", not "a minute"
  assert.equal(col('expires_at', r), rSeen + 30 * D);
  assert.deepEqual(touchSession(db, r, rSeen + 60_001), { user: u, remember: true, refreshed: true });
  assert.deepEqual(touchSession(db, n, nSeen + 60_001), { user: u, remember: false, refreshed: false }); // a session cookie has no Max-Age to renew
  assert.deepEqual([col('expires_at', r), col('expires_at', n)], [rSeen + 60_001 + 30 * D, nSeen + 60_001 + 12 * H]);
  assert.equal(touchSession(db, r, rSeen + 90_000)?.refreshed, false);                                  // renewed 30 s ago
  assert.equal(col('expires_at', r), rSeen + 60_001 + 30 * D);
  assert.equal(touchSession(db, n, nSeen + 60_001 + 12 * H), null);                                     // expires_at itself is already too late
  assert.equal(col('expires_at', n), undefined);                                                        // and the row is gone
  revokeUserSessions(db, u.id);
  assert.equal(touchSession(db, r, rSeen + 3 * M), null);
  assert.ok(touchSession(db, o, rSeen + 3 * M));                                                        // another user's session is untouched
});
test('session cookies', () => {
  assert.equal(SESSION_COOKIE, 'hg_session');
  assert.equal(sessionCookie('T', true, true), 'hg_session=T; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure');
  assert.equal(sessionCookie('T', false, false), 'hg_session=T; Path=/; HttpOnly; SameSite=Lax');
  assert.equal(clearSessionCookie(false), 'hg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  assert.equal(clearSessionCookie(true), 'hg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  assert.equal(sessionCookie('T', false, true), 'hg_session=T; Path=/; HttpOnly; SameSite=Lax; Secure');
});
test('login limiter', () => {
  const l = new LoginLimiter(), t = 1e12, M = 60_000;
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'bob', t);
  assert.deepEqual(l.check('2.2.2.2', 'bob', t), { ok: false, retryAfterMin: 15 });
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 15 * M + 1), { ok: true });
  for (let i = 0; i < 20; i++) l.fail('9.9.9.9', 'user' + i, t);
  assert.equal(l.check('9.9.9.9', 'someone', t + M).ok, false);
  l.fail('3.3.3.3', 'carol', t); l.succeed('carol');
  for (let i = 0; i < 4; i++) l.fail('3.3.3.3', 'carol', t);
  assert.equal(l.check('3.3.3.3', 'carol', t).ok, true);
});
test('login limiter: usernames are case-insensitive and the lock runs 15 minutes from the latest failure', () => {
  const l = new LoginLimiter(), t = 1e12;
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', i % 2 ? 'Bob' : 'bob', t + i * M);
  assert.deepEqual(l.check('2.2.2.2', 'BOB', t + 5 * M), { ok: false, retryAfterMin: 14 });
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 19 * M - 1), { ok: false, retryAfterMin: 1 });
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 19 * M), { ok: true });
  assert.deepEqual(l.check('2.2.2.2', 'alice', t + 5 * M), { ok: true });          // only that username is locked
  l.fail('1.1.1.1', 'bob', t + 19 * M);                                              // the count outlived the lock (R3a): this sixth failure locks again at once
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 19 * M), { ok: false, retryAfterMin: 15 });
  l.fail('1.1.1.1', 'bob', t + 20 * M);                                              // and every failure after it restarts the 15 minutes
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 20 * M), { ok: false, retryAfterMin: 15 });
  const long = 'x'.repeat(100_000);                                                  // a huge name is still one lockable key
  for (let i = 0; i < 5; i++) l.fail('5.5.5.5', long, t);
  assert.equal(l.check('6.6.6.6', long.toUpperCase(), t).ok, false);
});
test('login limiter: failures add up until a success however far apart, and success clears only the username', () => {
  const l = new LoginLimiter(), t = 1e12;
  for (let i = 0; i < 4; i++) l.fail('3.3.3.3', 'dan', t + i * 16 * M);              // 16 minutes apart: no lock is ever running when the next one comes
  assert.deepEqual(l.check('3.3.3.3', 'dan', t + 3 * 16 * M), { ok: true });          // four so far
  l.fail('3.3.3.3', 'dan', t + 4 * 16 * M);
  assert.deepEqual(l.check('4.4.4.4', 'dan', t + 4 * 16 * M), { ok: false, retryAfterMin: 15 });
  assert.deepEqual(l.check('4.4.4.4', 'dan', t + 5 * 16 * M), { ok: true });          // the lock runs out ...
  l.fail('3.3.3.3', 'dan', t + 5 * 16 * M);                                           // ... but one more wrong guess locks it again
  assert.equal(l.check('4.4.4.4', 'dan', t + 5 * 16 * M).ok, false);
  l.succeed('dan');
  assert.equal(l.check('4.4.4.4', 'dan', t + 5 * 16 * M).ok, true);
  for (let i = 0; i < 4; i++) l.fail('3.3.3.3', 'dan', t + 6 * 16 * M);
  assert.equal(l.check('4.4.4.4', 'dan', t + 6 * 16 * M).ok, true);                   // after a success the count starts from zero
  for (let i = 0; i < 20; i++) l.fail('9.9.9.9', 'u' + i, t + i * 1000);
  assert.deepEqual(l.check('9.9.9.9', 'x', t + 30_000), { ok: false, retryAfterMin: 15 });
  l.succeed('u1');                                                                   // logging in as someone else must not free the address
  assert.equal(l.check('9.9.9.9', 'x', t + 30_000).ok, false);
  assert.deepEqual(l.check('9.9.9.9', 'x', t + 15 * M - 1), { ok: false, retryAfterMin: 1 });
  assert.deepEqual(l.check('9.9.9.9', 'x', t + 15 * M), { ok: true });                // the oldest failure left the window
  assert.deepEqual(l.check('8.8.8.8', 'x', t + 30_000), { ok: true });
});
test('login limiter: the answer is the longer of the username wait and the address wait', () => {
  const l = new LoginLimiter(), t = 1e12;
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'bob', t - 14 * M);                   // bob: locked for 1 more minute
  for (let i = 0; i < 20; i++) l.fail('8.8.8.8', 'v' + i, t - 10 * M);                // 8.8.8.8: blocked for 5 more
  for (let i = 0; i < 5; i++) l.fail('3.3.3.3', 'amy', t);                            // amy: locked for 15 more
  for (let i = 0; i < 20; i++) l.fail('9.9.9.9', 'u' + i, t);                         // 9.9.9.9: blocked for 15 more
  assert.deepEqual(l.check('2.2.2.2', 'bob', t), { ok: false, retryAfterMin: 1 });    // one limit alone
  assert.deepEqual(l.check('8.8.8.8', 'nobody', t), { ok: false, retryAfterMin: 5 });
  assert.deepEqual(l.check('9.9.9.9', 'bob', t), { ok: false, retryAfterMin: 15 });   // both apply: the address wait is the longer
  assert.deepEqual(l.check('8.8.8.8', 'amy', t), { ok: false, retryAfterMin: 15 });   // both apply: the username wait is the longer
});
test('login limiter forgets idle entries, so made-up names and addresses cannot grow it forever', () => {
  const l = new LoginLimiter(), t = 1e12;
  for (let i = 0; i < 1000; i++) l.fail('7.7.' + (i >> 8) + '.' + (i & 255), 'name' + i, t);
  assert.deepEqual([(l as any).users.size, (l as any).ips.size], [1000, 1000]);
  l.fail('8.8.8.8', 'late', t + 16 * M);                                              // an address is forgotten after its 15 minute window ...
  assert.deepEqual([(l as any).users.size, (l as any).ips.size], [1001, 1]);          // ... a name's count has to outlive its lock (R3a)
  l.fail('8.8.8.8', 'x'.repeat(100_000), t + D - M);
  assert.equal((l as any).users.size, 1002);                                          // still a minute short of a day idle
  l.fail('8.8.8.8', 'last', t + D);
  assert.equal((l as any).users.size, 3);                                             // 'late', the long one and 'last' stay; the first 1000 were idle for a day
  assert.ok([...(l as any).users.keys()].every((k: string) => k.length <= 64));       // a huge name does not become a huge key
});
test('Origin check, trusted proxy and HSTS (Review Focus 4)', async (t) => {
  const trusted = new BlockList(); trusted.addAddress('127.0.0.1'); trusted.addAddress('::1', 'ipv6');
  const fwd = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gallery.example.com', origin: 'https://gallery.example.com' };
  for (const [proxies, status] of [[trusted, 200], [new BlockList(), 403]] as const) {
    const ta = await startTestApp({ trustedProxies: proxies }); t.after(() => ta.close());
    ta.app.router.add('POST', '/api/ping', () => ({ pong: true }));
    const r = await fetch(ta.url + '/api/ping', { method: 'POST', headers: { ...fwd, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, status);
    if (status === 200) assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
    else assert.match((await r.json()).error, /check TRUSTED_PROXIES/);
  }
});
test('Origin check: behind a trusted proxy a foreign Origin is still refused, with the TRUSTED_PROXIES hint', async (t) => {
  const trusted = new BlockList(); trusted.addAddress('127.0.0.1'); trusted.addAddress('::1', 'ipv6');
  const ta = await startTestApp({ trustedProxies: trusted }); t.after(() => ta.close());
  ta.app.router.add('POST', '/api/ping', () => ({ pong: true }));
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gallery.example.com', 'content-type': 'application/json' };
  const post = (origin: string) => fetch(ta.url + '/api/ping', { method: 'POST', headers: { ...headers, origin }, body: '{}' });
  const foreign = await post('https://evil.example');
  assert.deepEqual([foreign.status, await foreign.json()], [403, { error: HINT }]);
  assert.equal((await post('https://gallery.example.com')).status, 200);             // the proxy's own site is the one that passes
});
test('Origin check: only the exact site origin may change state, reads are not checked', async (t) => {
  const ta = await startTestApp({ trustedProxies: new BlockList() }); t.after(() => ta.close());
  const methods = ['POST', 'PUT', 'PATCH', 'DELETE'];
  for (const m of methods) ta.app.router.add(m, '/api/ping', () => ({ pong: m }));
  ta.app.router.add('GET', '/api/ping', () => ({ pong: 'GET' }));
  const send = (method: string, origin?: string) => fetch(ta.url + '/api/ping', { method, headers: origin === undefined ? {} : { origin } });
  const bad = [undefined, 'null', 'https://evil.example', ta.url.replace('http:', 'https:'), 'http://127.0.0.1:1', ta.url + '/', ta.url + '/x', ta.url + '.evil.example'];
  for (const method of methods) {
    for (const origin of bad) {
      const r = await send(method, origin);
      assert.deepEqual([r.status, await r.json()], [403, { error: HINT }], `${method} ${origin}`);
    }
    assert.deepEqual(await (await send(method, ta.url)).json(), { pong: method });
  }
  // a missing Origin is refused before routing, so even an unknown route answers 403 rather than 404 or 405
  assert.equal((await fetch(ta.url + '/api/nowhere', { method: 'POST' })).status, 403);
  // reads carry no Origin check, and X-Forwarded-* from an untrusted socket is ignored (no HSTS), not refused (Review Focus 4, G3)
  const spoof = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gallery.example.com', origin: 'https://evil.example' };
  const get = await fetch(ta.url + '/api/ping', { headers: spoof });
  assert.deepEqual([get.status, await get.json(), get.headers.get('strict-transport-security')], [200, { pong: 'GET' }, null]);
  assert.equal((await fetch(ta.url + '/api/ping', { method: 'HEAD', headers: spoof })).status, 200);
  const post = await fetch(ta.url + '/api/ping', { method: 'POST', headers: spoof });   // proto and host are not believed, so Origin cannot match
  assert.deepEqual([post.status, post.headers.get('strict-transport-security')], [403, null]);
});
test('pipeline loads the session user', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const u = await createUser(ta.db, { username: 'zed', displayName: 'Zed', password: 'password123', role: 'member' });
  ta.app.router.add('GET', '/api/whoami', (c) => ({ who: requireUser(c).username }));
  assert.equal((await ta.client().json('GET', '/api/whoami')).status, 401);
  const tok = createSession(ta.db, u.id, false, 'ip', 'ua');
  assert.deepEqual((await ta.client(`hg_session=${tok}`).json('GET', '/api/whoami')).body, { who: 'zed' });
  assert.equal((await fetch(ta.url + '/api/whoami', { method: 'POST' })).status, 403);   // no Origin
});
test('pipeline: requireUser/requireAdmin, bad cookies, expiry and the sliding cookie', async (t) => {
  const ta = await startTestApp({ cookieSecure: true }); t.after(() => ta.close());
  const root = await createUser(ta.db, { username: 'root', displayName: 'Root', password: 'password123', role: 'admin' });
  const mem = await createUser(ta.db, { username: 'mem', displayName: 'Mem', password: 'password123', role: 'member' });
  ta.app.router.add('GET', '/api/admin-only', (c) => ({ who: requireAdmin(c).username, token: c.token }));
  ta.app.router.add('GET', '/api/user-only', (c) => ({ who: requireUser(c).username }));
  const get = (path: string, cookie: string | null) => ta.client(cookie).req('GET', path);
  const adminTok = createSession(ta.db, root.id, false, 'ip', 'ua'), memTok = createSession(ta.db, mem.id, false, 'ip', 'ua');

  const anon = await get('/api/admin-only', null);
  assert.deepEqual([anon.status, await anon.json()], [401, { error: 'Sign in required' }]);
  const member = await get('/api/admin-only', `hg_session=${memTok}`);
  assert.deepEqual([member.status, await member.json()], [403, { error: 'Administrators only' }]);
  const admin = await get('/api/admin-only', `hg_session=${adminTok}`);
  assert.deepEqual([admin.status, await admin.json()], [200, { who: 'root', token: adminTok }]);
  assert.equal(admin.headers.get('set-cookie'), null);                       // nothing to renew yet
  assert.deepEqual(await (await get('/api/admin-only', `a=1; hg_session=${adminTok}; b=2`)).json(), { who: 'root', token: adminTok });

  // cookies that are not a live session leave the request anonymous, never an error
  for (const cookie of ['hg_session=nonsense', 'hg_session=', 'hg_session', `session=${adminTok}`, `HG_SESSION=${adminTok}`, `hg_session=${adminTok}x`, `hg_session=${sha256(adminTok)}`]) {
    const r = await get('/api/user-only', cookie);
    assert.deepEqual([r.status, await r.json(), r.headers.get('set-cookie')], [401, { error: 'Sign in required' }, null], cookie);
  }

  // expired: refused, and the row is gone
  ta.db.prepare('update sessions set expires_at = ? where token_hash = ?').run(Date.now() - 1, sha256(memTok));
  assert.equal((await get('/api/user-only', `hg_session=${memTok}`)).status, 401);
  assert.equal((ta.db.prepare('select count(*) as n from sessions where token_hash = ?').get(sha256(memTok)) as any).n, 0);

  // a remembered session unseen for a while gets its cookie renewed (Secure follows COOKIE_SECURE); a browser-session cookie does not
  const rememberTok = createSession(ta.db, root.id, true, 'ip', 'ua');
  const age = ta.db.prepare('update sessions set last_seen_at = last_seen_at - ?, expires_at = expires_at - ? where token_hash = ?');
  age.run(2 * M, 2 * M, sha256(rememberTok)); age.run(2 * M, 2 * M, sha256(adminTok));
  const renewed = await get('/api/user-only', `hg_session=${rememberTok}`);
  assert.equal(renewed.status, 200);
  assert.deepEqual(renewed.headers.getSetCookie(), [sessionCookie(rememberTok, true, true)]);
  assert.equal(renewed.headers.getSetCookie()[0], `hg_session=${rememberTok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`);
  const slid = (ta.db.prepare('select expires_at - last_seen_at as span from sessions where token_hash = ?').get(sha256(rememberTok)) as any).span;
  assert.equal(slid, 30 * D);
  assert.equal((await get('/api/user-only', `hg_session=${rememberTok}`)).headers.get('set-cookie'), null);   // renewed a moment ago
  const plain = await get('/api/user-only', `hg_session=${adminTok}`);
  assert.deepEqual([plain.status, plain.headers.get('set-cookie')], [200, null]);
});

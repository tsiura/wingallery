import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { clearSessionCookie, createSession, hashPassword, revokeUserSessions, touchSession, verifyPassword } from '../auth.ts';
import type { LoginLimiter } from '../auth.ts';
import { runCli } from '../cli.ts';
import { openDb } from '../db.ts';
import type { DB } from '../db.ts';
import { countUsers, createUser, findLogin, getMe, setPassword, setPrefs } from '../users.ts';
import { startTestApp, tempDir, testConfig, waitUntil } from './helpers.ts';
import type { TestApp } from './helpers.ts';

const USAGE = 'Usage: gallery set-password <username>';
const TOO_MANY = /^Too many attempts, try again in \d+ minutes$/;
const sessionCount = (db: DB) => (db.prepare('select count(*) as n from sessions').get() as { n: number }).n;
const cookieOf = (r: Response) => r.headers.getSetCookie()[0].split(';')[0];
const JSON_TYPE = { 'content-type': 'application/json' };   // for bodies that are not objects, which the client helper would not tag itself

// For tests that sign in through the API but don't look at the audit lines it prints.
const quiet = (t: TestContext) => { t.mock.method(console, 'log', () => {}); };

// console.log from here on: the raw lines, and the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  const events = () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
  return { lines, events };
}

// How many argon2 hashes a piece of work starts, counted as they start. A request's cost in hashes is exact, where its time is only a guess.
function countHashes(t: TestContext) {
  let started = 0;
  const hook = createHook({ init: (_id, type) => { if (type === 'ARGON2REQUEST') started++; } }).enable();
  t.after(() => { hook.disable(); });
  return async (work: () => Promise<unknown>) => { const before = started; await work(); return started - before; };
}

// Runs `landing` at the start of the second limiter check of the next request. That check is the first thing after the password hash,
// so this is a reset (or anything else) arriving while that request was hashing.
function landAfterHash(limiter: LoginLimiter, landing: () => void) {
  const check = limiter.check.bind(limiter);
  let calls = 0;
  limiter.check = (ip, username, now) => { if (++calls === 2) landing(); return check(ip, username, now); };
}

// `bodies` POSTed to `path`, each held back before its last byte until the server has received them all, so that they reach its first limiter check
// together, as the requests of a script on another machine do. Sent one after another from this process they would trickle in: starting a hash holds the
// event loop for some 20 ms, and by the time the rest are read the first results are back and have locked the address. Returns once they are let go.
async function together(ta: TestApp, path: string, bodies: object[], headers: Record<string, string>) {
  let arrived = 0;
  const count = () => { arrived++; };
  ta.app.server.on('request', count);
  const gates: (() => void)[] = [];
  const sent = bodies.map((body) => fetch(ta.url + path, {
    method: 'POST', duplex: 'half', headers: { origin: ta.url, 'content-type': 'application/json', ...headers },
    body: new ReadableStream({ start(c) { c.enqueue(Buffer.from(JSON.stringify(body))); gates.push(() => c.close()); } }),
  } as RequestInit).then(async (r) => ({ status: r.status, body: await r.json() })));
  const answers = Promise.all(sent);
  answers.catch(() => {});   // a test that fails before it looks at them must not end in an unhandled rejection as well
  await waitUntil(() => arrived === bodies.length, 5000);
  ta.app.server.off('request', count);
  assert.equal(arrived, bodies.length, 'the server did not receive them all');
  for (const open of gates) open();
  return { answers };
}

test('first-run setup', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const c = ta.client();
  assert.deepEqual((await c.json('GET', '/api/session')).body, { user: null, setupRequired: true });
  assert.deepEqual(await c.json('POST', '/api/setup', { token: 'x', username: 'root', displayName: 'Root', password: 'password123' }), { status: 403, body: { error: 'Invalid setup link' } });
  const r = await c.req('POST', '/api/setup', { token: ta.app.setupToken, username: 'root', displayName: 'Root', password: 'password123' });
  assert.equal(r.status, 200); assert.equal((await r.json()).user.role, 'admin');
  assert.match(r.headers.getSetCookie()[0], /^hg_session=.+Max-Age=2592000/);
  assert.equal(ta.app.setupToken, null);
  assert.equal((await c.json('POST', '/api/setup', { token: 'x', username: 'r2', displayName: 'R', password: 'password123' })).status, 409);
});
test('login, lockout, cookie flags, logout', async (t) => {
  const ta = await startTestApp({ cookieSecure: true }); t.after(() => ta.close());
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const c = ta.client();
  assert.deepEqual(await c.json('POST', '/api/login', { username: 'nobody', password: 'password123', remember: true }), { status: 401, body: { error: 'Wrong username or password' } });
  const ok = await c.req('POST', '/api/login', { username: 'PAPA', password: 'password123', remember: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.getSetCookie()[0].includes('Max-Age'), false);
  assert.match(ok.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Secure$/);
  const me = ta.client(ok.headers.getSetCookie()[0].split(';')[0]);
  assert.equal((await me.json('GET', '/api/session')).body.user.username, 'papa');
  await me.json('POST', '/api/logout');
  assert.equal((await me.json('GET', '/api/session')).body.user, null);
  for (let i = 0; i < 5; i++) await c.json('POST', '/api/login', { username: 'papa', password: 'bad-password', remember: false });
  const locked = await c.json('POST', '/api/login', { username: 'papa', password: 'password123', remember: false });
  assert.equal(locked.status, 429); assert.match(locked.body.error, /^Too many attempts, try again in \d+ minutes$/);
});
test('change password and prefs', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const { client: a } = await ta.addUser('mama', 'member');
  const other = await ta.login('mama', 'password123');     // second session
  assert.deepEqual(await a.json('POST', '/api/me/password', { current: 'nope-nope', next: 'newpassword1' }), { status: 400, body: { error: 'Current password is wrong' } });
  assert.equal((await a.json('POST', '/api/me/password', { current: 'password123', next: 'short' })).body.error, 'Password must be at least 8 characters');
  assert.equal((await a.json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  assert.equal((await other.json('GET', '/api/session')).body.user, null);
  assert.equal((await a.json('GET', '/api/session')).body.user.username, 'mama');
  assert.deepEqual((await a.json('PUT', '/api/me/prefs', { defaultView: 'details', slideSeconds: 7 })).body, { defaultView: 'details', slideSeconds: 7 });
  assert.equal((await a.json('PUT', '/api/me/prefs', { slideSeconds: 30 })).status, 400);
});
test('CLI set-password', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const { client } = await ta.addUser('alice', 'admin');
  const lines: string[] = []; t.mock.method(console, 'log', (s: string) => lines.push(s));
  assert.equal(await runCli(['set-password', 'alice'], ta.cfg, ta.db), 0);
  const pw = lines.join('\n').match(/New password for alice: (\S+)/)![1];
  assert.equal((await client.json('GET', '/api/session')).body.user, null);
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'alice', password: pw, remember: false })).status, 200);
  assert.equal(await runCli(['set-password', 'ghost'], ta.cfg, ta.db), 1);
});

test('setup: the link exists only while there are no users, and a mistake in the form does not burn it', async (t) => {
  const dir = await tempDir();
  const taken = openDb(':memory:');
  await createUser(taken, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'admin' });
  assert.equal(createApp(testConfig({ mediaRoot: dir, dataDir: dir }), taken).setupToken, null);

  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const token = ta.app.setupToken!, c = ta.client();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);                                          // 24 random bytes, base64url
  const form = { token, username: 'root', displayName: 'Root', password: 'password123' };
  assert.deepEqual(await c.json('POST', '/api/setup', { ...form, password: 'short' }), { status: 400, body: { error: 'Password must be at least 8 characters' } });
  assert.equal((await c.json('POST', '/api/setup', { ...form, username: 'Bad Name' })).status, 400);
  assert.equal(countUsers(ta.db), 0);
  assert.equal(ta.app.setupToken, token);                                              // still usable after those two
  // only the exact link opens it, whatever the type of what was sent: a wrong type is a wrong value, never a 500 (G6)
  const wrong = [undefined, null, 5, true, {}, [token], token + 'x', token.slice(1), token.toUpperCase(), 'é'.repeat(token.length), ''];
  for (const bad of wrong) assert.deepEqual(await c.json('POST', '/api/setup', { ...form, token: bad }), { status: 403, body: { error: 'Invalid setup link' } }, String(bad));
  for (const text of ['null', '[]', '"x"', '5', '{']) {
    const r = await c.req('POST', '/api/setup', text, JSON_TYPE);
    assert.deepEqual([r.status, await r.json()], [400, { error: 'Invalid JSON' }], text);
  }
  const plain = await c.req('POST', '/api/setup', 'token=x', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.deepEqual([plain.status, await plain.json()], [415, { error: 'Expected JSON' }]);
  assert.equal(countUsers(ta.db), 0);

  const ok = await c.req('POST', '/api/setup', { ...form, username: ' Root ' });
  assert.equal(ok.status, 200);
  assert.equal(ta.app.setupToken, null);
  const admin = ta.client(cookieOf(ok));
  const session = (await admin.json('GET', '/api/session')).body;
  assert.deepEqual(session, { user: { id: 1, username: 'root', displayName: 'Root', role: 'admin', prefs: { defaultView: 'large', slideSeconds: 5 } }, setupRequired: false });
  // the link no longer opens anything, and "already set up" is the answer whatever is sent
  assert.deepEqual(await c.json('POST', '/api/setup', form), { status: 409, body: { error: 'Already set up' } });
});
test('setup: a user made some other way closes it for good, even with the right link', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  await ta.addUser('papa', 'member');
  assert.notEqual(ta.app.setupToken, null);
  const r = await ta.client().json('POST', '/api/setup', { token: ta.app.setupToken, username: 'root', displayName: 'Root', password: 'password123' });
  assert.deepEqual(r, { status: 409, body: { error: 'Already set up' } });
  assert.deepEqual((await ta.client().json('GET', '/api/session')).body, { user: null, setupRequired: false });
  assert.equal(countUsers(ta.db), 1);
});
test('setup: two requests racing with the link create one administrator', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const token = ta.app.setupToken;
  const setup = (username: string) => ta.client().json('POST', '/api/setup', { token, username, displayName: username, password: 'password123' });
  const statuses = (await Promise.all([setup('first'), setup('second')])).map((r) => r.status).sort();
  assert.equal(statuses[0], 200);
  assert.ok(statuses[1] === 403 || statuses[1] === 409, String(statuses));            // the loser finds the link taken, or the instance already set up
  assert.equal(countUsers(ta.db), 1);
  assert.equal(sessionCount(ta.db), 1);
});

test('login: an unknown user and a wrong password look the same, odd input never reaches a 500 (G6)', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const c = ta.client();
  const wrong = await c.json('POST', '/api/login', { username: 'papa', password: 'nope-nope-nope', remember: true });
  assert.deepEqual(wrong, { status: 401, body: { error: 'Wrong username or password' } });
  assert.deepEqual(await c.json('POST', '/api/login', { username: 'ghost', password: 'nope-nope-nope', remember: true }), wrong);
  for (const body of [{}, { username: 5, password: {} }, { username: ['papa'], password: ['password123'] }, { username: 'papa', password: null }, { username: null, password: 'password123' }])
    assert.deepEqual(await c.json('POST', '/api/login', body), wrong, JSON.stringify(body));
  for (const text of ['null', '[]', '"papa"', '5', '{']) {
    const r = await c.req('POST', '/api/login', text, JSON_TYPE);
    assert.deepEqual([r.status, await r.json()], [400, { error: 'Invalid JSON' }], text);
  }
  const plain = await c.req('POST', '/api/login', 'username=papa', { 'content-type': 'text/plain' });
  assert.deepEqual([plain.status, await plain.json()], [415, { error: 'Expected JSON' }]);
  const big = await c.req('POST', '/api/login', { username: 'papa', password: 'x'.repeat(20_000) });
  assert.deepEqual([big.status, await big.json()], [413, { error: 'Request too large' }]);   // credentials are short; nothing here buffers megabytes
  assert.equal(sessionCount(ta.db), 0);

  const ok = await c.json('POST', '/api/login', { username: 'papa', password: 'password123', remember: true });
  assert.deepEqual(ok, { status: 200, body: { user: { id: 1, username: 'papa', displayName: 'Papa', role: 'member', prefs: { defaultView: 'large', slideSeconds: 5 } } } });
  // only a literal true asks for the 30 days
  const setCookie = async (remember: unknown) => (await c.req('POST', '/api/login', { username: 'papa', password: 'password123', remember })).headers.getSetCookie();
  assert.match((await setCookie(true))[0], /; Max-Age=2592000/);
  for (const remember of [false, 'true', 1, 'yes', null, undefined]) assert.doesNotMatch((await setCookie(remember))[0], /Max-Age/, String(remember));
  // the session row keeps the browser's name for the audit, cut to a sane size
  await c.req('POST', '/api/login', { username: 'papa', password: 'password123' }, { 'user-agent': 'x'.repeat(5000) });
  assert.equal((ta.db.prepare('select max(length(user_agent)) as n from sessions').get() as any).n, 200);
});
test('login: the lock is checked again after the slow password check (R1)', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  // The check before the hash passes; then the other guesses of a burst land while this request is still hashing.
  const l = ta.app.limiter, check = l.check.bind(l);
  let burst = false;
  l.check = (ip, username, now) => {
    const r = check(ip, username, now);
    if (burst) { burst = false; for (let i = 0; i < 5; i++) l.fail('203.0.113.7', username); }
    return r;
  };
  for (const username of ['papa', 'ghost']) {
    burst = true;
    const r = await ta.client().json('POST', '/api/login', { username, password: 'password123', remember: true });
    assert.equal(r.status, 429, username);                                             // the right password for papa, an unknown name for ghost: neither is told more
    assert.match(r.body.error, TOO_MANY);
  }
  assert.equal(sessionCount(ta.db), 0);
  // the current-password check of a signed-in user is a guess like any other
  const { client: mama } = await ta.addUser('mama', 'member');
  burst = true;
  const change = await mama.json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' });
  assert.equal(change.status, 429); assert.match(change.body.error, TOO_MANY);
  assert.equal(await verifyPassword('password123', findLogin(ta.db, 'mama')!.passwordHash), true);   // the old password stands
});
test('login: a burst of parallel guesses is answered at most five times', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const guess = (password: string) => ta.client().json('POST', '/api/login', { username: 'papa', password, remember: false });
  const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => guess('bad-password' + i)));
  const statuses = burst.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5, String(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 11, String(statuses));
  const late = await guess('password123');
  assert.equal(late.status, 429); assert.match(late.body.error, TOO_MANY);              // the right password is no use once the name is locked
  assert.equal(sessionCount(ta.db), 0);
});
test('login: a burst of parallel guesses from one address costs at most 20 hashes, and a right password inside it is refused', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const hashes = countHashes(t);
  const from = '203.0.113.50';
  const login = async (username: string, password: string, ip = from) => {
    const r = await ta.client().req('POST', '/api/login', { username, password, remember: false }, { 'x-forwarded-for': ip });
    return { status: r.status, body: await r.json() };
  };
  let answers: { status: number; body: any }[] = [];
  const cost = await hashes(async () => {
    // a hundred different names, so that no name is locked and only the address can stop them
    const guesses = Array.from({ length: 100 }, (_, i) => ({ username: 'guess' + i, password: 'bad-password', remember: false }));
    const burst = await together(ta, '/api/login', guesses, { 'x-forwarded-for': from });
    // The address has used up its twenty once they are hashing or have failed; either way they count, so the right password comes into a full house.
    await waitUntil(() => !ta.app.limiter.check(from, 'papa').ok);
    assert.equal(ta.app.limiter.check(from, 'papa').ok, false, 'the address was never used up');
    const right = login('papa', 'password123');
    answers = [...await burst.answers, await right];
  });
  const statuses = answers.map((a) => a.status);
  assert.equal(statuses.filter((s) => s === 401).length, 20, String(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 81, String(statuses));        // the other eighty guesses, and the right password
  assert.match(answers[100].body.error, TOO_MANY);
  assert.ok(cost <= 20, `${cost} hashes`);                                              // not a hash for each of the hundred
  assert.equal(sessionCount(ta.db), 0);
  assert.equal((await login('papa', 'password123')).status, 429);                      // the address stays shut ...
  assert.equal((await login('papa', 'password123', '203.0.113.51')).status, 200);      // ... and no other address, nor papa, is touched by it
});
test('password change: a burst of parallel guesses is answered at most five times and costs at most five hashes', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { client: mama } = await ta.addUser('mama', 'member');
  const hashes = countHashes(t);
  const change = (current: string) => mama.json('POST', '/api/me/password', { current, next: 'newpassword1' });
  let burst: { status: number }[] = [];
  const cost = await hashes(async () => {
    const guesses = Array.from({ length: 16 }, (_, i) => ({ current: 'wrong-guess-' + i, next: 'newpassword1' }));
    burst = await (await together(ta, '/api/me/password', guesses, { cookie: mama.cookie! })).answers;
  });
  const statuses = burst.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 400).length, 5, String(statuses));
  assert.equal(statuses.filter((s) => s === 429).length, 11, String(statuses));
  assert.ok(cost <= 5, `${cost} hashes`);
  assert.equal((await change('password123')).status, 429);                             // the name is locked: the right password is no use
  assert.equal(await verifyPassword('password123', findLogin(ta.db, 'mama')!.passwordHash), true);   // and it was not changed
});
test('login: the lock is per username and per address; a success clears the username', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  await ta.addUser('papa', 'member'); await ta.addUser('mama', 'member');
  const login = async (username: string, password: string, ip = '203.0.113.1') =>
    (await ta.client().req('POST', '/api/login', { username, password, remember: false }, { 'x-forwarded-for': ip })).status;
  for (let i = 0; i < 4; i++) assert.equal(await login('papa', 'bad-password'), 401);
  assert.equal(await login('papa', 'password123'), 200);
  for (let i = 0; i < 4; i++) assert.equal(await login('papa', 'bad-password'), 401);   // four again: the success started the count over
  assert.equal(await login('papa', 'password123'), 200);
  for (let i = 0; i < 5; i++) assert.equal(await login('papa', 'bad-password'), 401);
  assert.equal(await login('papa', 'password123'), 429);                               // locked, right password or not
  assert.equal(await login('papa', 'password123', '203.0.113.2'), 429);                // the lock follows the name, not the address
  assert.equal(await login('PAPA', 'password123'), 429);                               // letter case is no way round it ...
  assert.equal(await login('papa ', 'password123'), 401);                              // ... and a name is never trimmed, so a variant with spaces is just an unknown name:
  assert.equal(await login(' papa', 'password123'), 401);                              // it neither reaches the account nor gets a lock of its own to dodge the real one
  assert.equal(await login('mama', 'password123', '203.0.113.1'), 200);                // and no other name
  for (let i = 0; i < 20; i++) ta.app.limiter.fail('198.51.100.9', 'u' + i);           // (the limiter's own numbers are tested in auth.test.ts)
  assert.equal(await login('mama', 'password123', '198.51.100.9'), 429);               // an address that guessed too much is shut out for every name
  assert.equal(await login('mama', 'password123', '198.51.100.10'), 200);
});
test('a locked name costs no hash, and an unknown name costs as much as a wrong password', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { client: mama } = await ta.addUser('mama', 'member');
  await ta.addUser('papa', 'member');
  const hashes = countHashes(t);
  const login = (username: string, password: string) => ta.client().json('POST', '/api/login', { username, password, remember: false });
  const change = (current: string, next = 'newpassword1') => mama.json('POST', '/api/me/password', { current, next });
  assert.equal(await hashes(() => login('papa', 'bad-password')), 1);                    // a wrong password: one hash
  assert.equal(await hashes(() => login('ghost', 'bad-password')), 1);                   // an unknown name: one as well, so the time does not tell them apart
  assert.equal(await hashes(() => login('papa', 'password123')), 1);                     // and a right one
  assert.equal(await hashes(() => change('password123', 'short')), 1);                   // a bad new password is refused before it is hashed: only the current one cost a hash
  assert.equal(await hashes(() => ta.client().json('POST', '/api/login', { username: 'papa', password: 'x'.repeat(20_000) })), 0);   // a body that is too large costs none
  for (let i = 0; i < 5; i++) await login('papa', 'bad-password');
  assert.equal(await hashes(() => login('papa', 'password123')), 0);                     // locked: refused before any hash
  for (let i = 0; i < 5; i++) await change('bad-password');
  assert.equal(await hashes(() => change('password123')), 0);                            // the same for the password change
});
test('a password reset that lands while a login is hashing leaves no session behind', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const papa = await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const reset = await hashPassword('reset-by-admin');
  // the last, synchronous step of setPassword: the new hash is stored and every session ends
  landAfterHash(ta.app.limiter, () => { ta.db.prepare('update users set password_hash = ? where id = ?').run(reset, papa.id); revokeUserSessions(ta.db, papa.id); });
  const old = await ta.client().json('POST', '/api/login', { username: 'papa', password: 'password123', remember: true });
  assert.deepEqual(old, { status: 401, body: { error: 'Wrong username or password' } });   // the password it checked is not the password any more
  assert.equal(sessionCount(ta.db), 0);
  assert.equal((await (await ta.login('papa', 'reset-by-admin')).json('GET', '/api/session')).body.user.username, 'papa');
});
test('a set-password next to a login with the old password never leaves a live session', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  for (const username of ['aa', 'bb', 'cc', 'dd']) {
    await createUser(ta.db, { username, displayName: username, password: 'password123', role: 'member' });
    const cli = runCli(['set-password', username], ta.cfg, ta.db);                       // starts hashing the new password ...
    const login = await ta.client().json('POST', '/api/login', { username, password: 'password123', remember: true });   // ... while the old one is checked
    assert.equal(await cli, 0);
    assert.equal(sessionCount(ta.db), 0, `${username}: the login answered ${login.status}`);   // whichever finished first, the reset has the last word
  }
});
test('a reset that lands while a password change is hashing is not overwritten by it', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { id, client: mama } = await ta.addUser('mama', 'member');
  const reset = await hashPassword('reset-by-admin');
  landAfterHash(ta.app.limiter, () => { ta.db.prepare('update users set password_hash = ? where id = ?').run(reset, id); revokeUserSessions(ta.db, id); });
  const change = await mama.json('POST', '/api/me/password', { current: 'password123', next: 'attacker-choice' });
  assert.deepEqual(change, { status: 401, body: { error: 'Sign in required' } });       // the session it was made from ended with the reset
  const hash = findLogin(ta.db, 'mama')!.passwordHash;
  assert.equal(await verifyPassword('reset-by-admin', hash), true);
  assert.equal(await verifyPassword('attacker-choice', hash), false);
});
test('setPassword refuses a change made from a session that ended while it hashed', async () => {
  const db = openDb(':memory:');
  const alice = await createUser(db, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'member' });
  const bob = await createUser(db, { username: 'bob', displayName: 'Bob', password: 'password123', role: 'member' });
  const mine = createSession(db, alice.id, true, 'ip', 'ua'), his = createSession(db, bob.id, true, 'ip', 'ua');
  const pending = setPassword(db, alice.id, 'newpassword1', mine);                       // the hash is running ...
  revokeUserSessions(db, alice.id);                                                      // ... and the session it was made from ends
  await assert.rejects(pending, { status: 401, message: 'Sign in required' });
  for (const token of ['nonsense', his])                                                 // an unknown token, and someone else's session, are no session of Alice
    await assert.rejects(setPassword(db, alice.id, 'newpassword1', token), { status: 401, message: 'Sign in required' }, token);
  assert.equal(await verifyPassword('password123', findLogin(db, 'alice')!.passwordHash), true);   // nothing was stored
  assert.ok(touchSession(db, his));                                                      // and the other user's session is untouched
  const kept = createSession(db, alice.id, true, 'ip', 'ua');
  await setPassword(db, alice.id, 'newpassword1', kept);                                 // a live session of hers is what the change needs
  assert.ok(touchSession(db, kept));
});
test('password change: a right current password clears the username count, as a login does', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { client: a } = await ta.addUser('mama', 'member');
  const change = (current: string, next: string) => a.json('POST', '/api/me/password', { current, next });
  for (let i = 0; i < 4; i++) assert.equal((await change('wrong-' + i + '-pass', 'newpassword1')).status, 400);   // one more would lock the name
  assert.equal((await change('password123', 'newpassword1')).status, 200);               // the right one clears the count ...
  for (let i = 0; i < 4; i++) assert.equal((await change('wrong-' + i + '-pass', 'another-pass1')).status, 400);   // ... eight in all would have locked it by now
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'mama', password: 'newpassword1', remember: false })).status, 200);
});
test('TestApp.login: overlapping logins leave console.log as it was', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const before = console.log;
  t.after(() => { console.log = before; });                                              // whatever happens here, the rest of the file keeps its console
  for (const username of ['aa', 'bb', 'cc']) await createUser(ta.db, { username, displayName: username, password: 'password123', role: 'member' });
  for (let round = 0; round < 4; round++) {
    await Promise.all(['aa', 'bb', 'cc'].map((username) => ta.login(username, 'password123')));
    assert.equal(console.log, before, `still replaced after round ${round}`);
  }
});

test('logout ends only that session, is harmless without one, and is audited', async (t) => {
  const ta = await startTestApp({ cookieSecure: true }); t.after(() => ta.close());
  const { client: a } = await ta.addUser('papa', 'member');
  const b = await ta.login('papa', 'password123');
  const out = capture(t);
  const anon = await ta.client().req('POST', '/api/logout');
  assert.deepEqual([anon.status, await anon.json(), anon.headers.getSetCookie()], [200, { ok: true }, [clearSessionCookie(true)]]);
  assert.deepEqual(out.events(), []);                                                  // nobody signed out, nothing to audit
  const res = await a.req('POST', '/api/logout');
  assert.deepEqual([res.status, await res.json(), res.headers.getSetCookie()], [200, { ok: true }, [clearSessionCookie(true)]]);
  assert.deepEqual((await a.json('GET', '/api/session')).body, { user: null, setupRequired: false });
  assert.equal((await b.json('GET', '/api/session')).body.user.username, 'papa');       // another device stays signed in
  assert.equal(sessionCount(ta.db), 1);
  assert.deepEqual(out.events(), [{ event: 'logout', username: 'papa', ip: '127.0.0.1' }]);
});
test('audit log: one JSON line per event with the username and address, and never a secret', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const out = capture(t);
  const token = ta.app.setupToken!, c = ta.client();
  const setup = await c.req('POST', '/api/setup', { token, username: 'root', displayName: 'Root', password: 'password123' });
  const first = ta.client(cookieOf(setup));
  await c.json('POST', '/api/login', { username: 'Root', password: 'wrong-password', remember: false });
  await first.json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' });
  const login = await c.req('POST', '/api/login', { username: 'ROOT', password: 'newpassword1', remember: false });
  const second = ta.client(cookieOf(login));
  await second.json('POST', '/api/logout');
  assert.equal(await runCli(['set-password', 'root'], ta.cfg, ta.db), 0);
  const ip = '127.0.0.1';
  assert.deepEqual(out.events(), [
    { event: 'setup', username: 'root', ip },
    { event: 'login_failed', username: 'Root', ip },                                   // the name as typed
    { event: 'password_set', username: 'root', ip },
    { event: 'login', username: 'root', ip },                                          // the account's own spelling
    { event: 'logout', username: 'root', ip },
    { event: 'password_set', username: 'root', via: 'cli' },
  ]);
  const printed = out.lines.join('\n').match(/New password for root: (\S+)/)![1];
  const audit = out.lines.filter((l) => l.startsWith('{')).join('\n');
  for (const secret of ['password123', 'newpassword1', 'wrong-password', token, cookieOf(setup).split('=')[1], cookieOf(login).split('=')[1], printed])
    assert.ok(!audit.includes(secret), `the audit log holds a secret: ${secret}`);
});

test('password change: needs a session, throttles wrong guesses, and only the new password works afterwards', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { client: a } = await ta.addUser('mama', 'member');
  assert.deepEqual(await ta.client().json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' }), { status: 401, body: { error: 'Sign in required' } });
  // a wrong type is a wrong value (G6)
  assert.deepEqual(await a.json('POST', '/api/me/password', { current: 'password123', next: { x: 1 } }), { status: 400, body: { error: 'Password must be at least 8 characters' } });
  assert.deepEqual(await a.json('POST', '/api/me/password', { current: 5, next: 'newpassword1' }), { status: 400, body: { error: 'Current password is wrong' } });   // the first of five wrong ones
  for (const text of ['null', '[]', '5']) {
    const r = await a.req('POST', '/api/me/password', text, JSON_TYPE);
    assert.deepEqual([r.status, await r.json()], [400, { error: 'Invalid JSON' }], text);
  }
  // This endpoint is a password oracle for whoever holds the session cookie, so it shares the login lock.
  for (let i = 0; i < 4; i++) assert.equal((await a.json('POST', '/api/me/password', { current: 'wrong-' + i + '-pass', next: 'newpassword1' })).status, 400);
  const locked = await a.json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' });
  assert.equal(locked.status, 429); assert.match(locked.body.error, TOO_MANY);
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'mama', password: 'password123', remember: false })).status, 429);
  assert.equal(getMe(ta.db, 1)!.username, 'mama');
  assert.equal(await verifyPassword('password123', findLogin(ta.db, 'mama')!.passwordHash), true);   // the refused change changed nothing

  ta.app.limiter.succeed('mama');
  const other = await ta.login('mama', 'password123');
  const ok = await a.req('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' });
  assert.deepEqual([ok.status, await ok.json(), ok.headers.get('set-cookie')], [200, { ok: true }, null]);   // this session simply carries on
  assert.equal((await other.json('GET', '/api/session')).body.user, null);
  assert.equal((await a.json('GET', '/api/session')).body.user.username, 'mama');
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'mama', password: 'password123', remember: false })).status, 401);
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'mama', password: 'newpassword1', remember: false })).status, 200);
});
test('prefs: a patch changes only what it names, and a bad value changes nothing', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); quiet(t);
  const { client: a } = await ta.addUser('mama', 'member');
  assert.deepEqual(await ta.client().json('PUT', '/api/me/prefs', { slideSeconds: 7 }), { status: 401, body: { error: 'Sign in required' } });
  assert.deepEqual((await a.json('PUT', '/api/me/prefs', { slideSeconds: 7 })).body, { defaultView: 'large', slideSeconds: 7 });
  assert.deepEqual((await a.json('PUT', '/api/me/prefs', { defaultView: 'medium' })).body, { defaultView: 'medium', slideSeconds: 7 });
  assert.deepEqual((await a.json('PUT', '/api/me/prefs', {})).body, { defaultView: 'medium', slideSeconds: 7 });
  const bad = [{ defaultView: 'grid' }, { defaultView: 5 }, { defaultView: null }, { defaultView: ['large'] }, { slideSeconds: 1 }, { slideSeconds: 21 }, { slideSeconds: 2.5 },
    { slideSeconds: '7' }, { slideSeconds: null }, { slideSeconds: [7] }, { slideSeconds: true }, { defaultView: 'details', slideSeconds: 99 }];
  for (const prefs of bad) assert.deepEqual(await a.json('PUT', '/api/me/prefs', prefs), { status: 400, body: { error: 'Invalid preferences' } }, JSON.stringify(prefs));
  for (const text of ['null', '[]', '5']) {
    const r = await a.req('PUT', '/api/me/prefs', text, JSON_TYPE);
    assert.deepEqual([r.status, await r.json()], [400, { error: 'Invalid JSON' }], text);
  }
  for (const slideSeconds of [2, 20]) assert.equal((await a.json('PUT', '/api/me/prefs', { slideSeconds })).body.slideSeconds, slideSeconds);
  // all or nothing: the valid half of { details, 99 } was not stored, and the prefs belong to the user, not to the session
  assert.deepEqual((await (await ta.login('mama', 'password123')).json('GET', '/api/session')).body.user.prefs, { defaultView: 'medium', slideSeconds: 20 });
});

test('CLI set-password: a usage error changes nothing, the new password is random and ends every session', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const { client } = await ta.addUser('alice', 'admin');
  const second = await ta.login('alice', 'password123');
  const before = findLogin(ta.db, 'alice')!.passwordHash;
  const out = capture(t);
  for (const argv of [[], ['set-password'], ['set-password', 'ghost'], ['set-password', 'alice', 'extra'], ['reset', 'alice'], ['set-password', ''], ['--help']])
    assert.equal(await runCli(argv, ta.cfg, ta.db), 1, argv.join(' '));
  assert.deepEqual([...new Set(out.lines)], [USAGE]);                                 // only the usage text, and no password anywhere
  assert.equal(findLogin(ta.db, 'alice')!.passwordHash, before);
  assert.equal(sessionCount(ta.db), 2);

  assert.equal(await runCli(['set-password', 'ALICE'], ta.cfg, ta.db), 0);
  assert.equal(await runCli(['set-password', 'alice'], ta.cfg, ta.db), 0);
  const [one, two] = [...out.lines.join('\n').matchAll(/^New password for alice: (\S+)$/gm)].map((m) => m[1]);   // the account's spelling, not the typed one
  assert.match(one, /^[A-Za-z0-9_-]{16}$/); assert.match(two, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(one, two);
  assert.equal(sessionCount(ta.db), 0);
  assert.deepEqual([(await client.json('GET', '/api/session')).body.user, (await second.json('GET', '/api/session')).body.user], [null, null]);
  assert.equal(await verifyPassword(two, findLogin(ta.db, 'alice')!.passwordHash), true);
  assert.equal(await verifyPassword(one, findLogin(ta.db, 'alice')!.passwordHash), false);
});

test('setPassword and setPrefs', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'member' });
  const mine = createSession(db, u.id, true, 'ip', 'ua'), other = createSession(db, u.id, true, 'ip', 'ua');
  for (const bad of ['short', '😀😀😀😀', 5, null, undefined, {}] as any[])
    await assert.rejects(setPassword(db, u.id, bad), { status: 400, message: 'Password must be at least 8 characters' }, String(bad));
  await assert.rejects(setPassword(db, 999, 'password123'), { status: 404, message: 'Not found' });
  assert.equal(await verifyPassword('password123', findLogin(db, 'alice')!.passwordHash), true);
  assert.equal(sessionCount(db), 2);                                                   // a refused change ends no session
  await setPassword(db, u.id, 'newpassword1', mine);
  assert.equal(await verifyPassword('newpassword1', findLogin(db, 'alice')!.passwordHash), true);
  assert.ok(touchSession(db, mine)); assert.equal(touchSession(db, other), null);       // the kept token stays, the rest end
  await setPassword(db, u.id, 'another-pass1');
  assert.equal(touchSession(db, mine), null);                                          // no token to keep: nobody stays

  assert.deepEqual(setPrefs(db, u.id, { slideSeconds: 9 }), { defaultView: 'large', slideSeconds: 9 });
  assert.deepEqual(setPrefs(db, u.id, { defaultView: 'details' }), { defaultView: 'details', slideSeconds: 9 });
  assert.equal((db.prepare('select prefs from users where id = ?').get(u.id) as any).prefs, '{"defaultView":"details","slideSeconds":9}');
  assert.deepEqual(getMe(db, u.id)!.prefs, { defaultView: 'details', slideSeconds: 9 });
  for (const bad of [{ defaultView: 'x' }, { slideSeconds: 1 }, { slideSeconds: 21 }, { slideSeconds: 3.5 }, { defaultView: null }, { slideSeconds: NaN }] as any[])
    assert.throws(() => setPrefs(db, u.id, bad), { status: 400, message: 'Invalid preferences' }, JSON.stringify(bad));
  assert.throws(() => setPrefs(db, 999, { slideSeconds: 5 }), { status: 404, message: 'Not found' });
  assert.deepEqual(getMe(db, u.id)!.prefs, { defaultView: 'details', slideSeconds: 9 });
});
test('TestApp helpers: addUser, login and a memoized admin', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const root = await ta.admin();
  assert.equal(await ta.admin(), root);                                                // one admin, made once
  assert.deepEqual((await root.json('GET', '/api/session')).body.user, { id: 1, username: 'root', displayName: 'root', role: 'admin', prefs: { defaultView: 'large', slideSeconds: 5 } });
  const papa = await ta.addUser('papa', 'member');
  assert.equal((await papa.client.json('GET', '/api/session')).body.user.id, papa.id);
  assert.equal(getMe(ta.db, papa.id)!.role, 'member');
  const mama = await ta.addUser('mama', 'admin', 'another-pass1');
  assert.equal(getMe(ta.db, mama.id)!.role, 'admin');
  await assert.rejects(ta.login('mama', 'password123'), /401/);                        // a refused login throws, with the status in the message
  assert.match((await ta.login('mama', 'another-pass1')).cookie!, /^hg_session=[A-Za-z0-9_-]{43}$/);
  assert.equal(countUsers(ta.db), 3);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  });
}
test('main.ts: prints the setup link once, serves, keeps idle connections past Traefik\'s 90 s, and runs the CLI against the live database', async (t) => {
  const dataDir = await tempDir(), mediaRoot = await tempDir(), port = await freePort();
  const env = { ...process.env, DATA_DIR: dataDir, MEDIA_ROOT: mediaRoot, PORT: String(port), COOKIE_SECURE: 'false' };
  const node = ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', 'main.ts')];
  const server = spawn(process.execPath, node, { env });
  t.after(() => { server.kill(); });
  let out = '';
  server.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('"event":"listening"'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('"event":"listening"'), out);
  // F4: the printed line is the only place the link appears (Task 20 counts one match)
  const links = out.split('\n').filter((l) => l.includes('setup?token='));
  assert.equal(links.length, 1, out);
  assert.match(links[0], /^First run: open https:\/\/<your-domain>\/setup\?token=[A-Za-z0-9_-]{32} to create the admin account$/);

  const base = `http://127.0.0.1:${port}`;
  // Task 20 T1: Traefik reuses a backend connection for up to 90 s of idleness, so Node must not close it earlier (that is a sporadic 502)
  assert.equal((await fetch(base + '/healthz')).headers.get('keep-alive'), 'timeout=95');
  const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const setup = await post('/api/setup', { token: /token=(\S+)/.exec(links[0])![1], username: 'root', displayName: 'Root', password: 'password123' });
  assert.equal(setup.status, 200);
  const cookie = cookieOf(setup);
  const whoami = async () => (await (await fetch(base + '/api/session', { headers: { cookie } })).json()).user;
  assert.equal((await whoami()).username, 'root');

  // `docker exec ... gallery set-password` is a second process on the same database file
  const cli = (...argv: string[]) => spawnSync(process.execPath, [...node, ...argv], { env, encoding: 'utf8', timeout: 30_000 });
  const unknown = cli('set-password', 'nobody');
  assert.deepEqual([unknown.status, unknown.stdout.trim()], [1, USAGE], unknown.stderr);
  const reset = cli('set-password', 'root');
  assert.equal(reset.status, 0, reset.stderr);
  const password = /^New password for root: (\S{16})$/m.exec(reset.stdout)![1];
  assert.equal(await whoami(), null);                                                  // the running server sees the ended session at once
  assert.equal((await post('/api/login', { username: 'root', password, remember: false })).status, 200);
  assert.equal(out.split('\n').filter((l) => l.includes('setup?token=')).length, 1);  // the CLI is a different process, and the server printed nothing more

  server.kill('SIGTERM');
  const [code] = await once(server, 'exit');
  assert.equal(code, 0);
});

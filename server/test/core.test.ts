import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { HttpError, clientInfo, parseCookies, readBody, readForm, readJson } from '../http.ts';
import { startTestApp, tempDir } from './helpers.ts';

test('loadConfig defaults', () => {
  const c = loadConfig({});
  assert.equal(c.mediaRoot, '/media'); assert.equal(c.dataDir, '/data'); assert.equal(c.port, 8080);
  assert.equal(c.cookieSecure, true); assert.equal(c.maxUploadBytes, 10240 * 1024 * 1024); assert.equal(c.trashDays, 30);
  assert.equal(c.trustedProxies.check('172.18.0.2', 'ipv4'), true);
  assert.equal(c.trustedProxies.check('8.8.8.8', 'ipv4'), false);
  assert.equal(c.trustedProxies.check('fd00::1', 'ipv6'), true);
  assert.equal(c.webDist, join(import.meta.dirname, '../../web/dist'));
});
test('loadConfig overrides', () => {
  const c = loadConfig({ MEDIA_ROOT: '/m', DATA_DIR: '/d', PORT: '9', COOKIE_SECURE: 'false', MAX_UPLOAD_MB: '5', TRASH_DAYS: '7', TRUSTED_PROXIES: '203.0.113.7', WEB_DIST: '/w' });
  assert.deepEqual([c.mediaRoot, c.dataDir, c.port, c.cookieSecure, c.maxUploadBytes, c.trashDays], ['/m', '/d', 9, false, 5 * 1024 * 1024, 7]);
  assert.equal(c.trustedProxies.check('203.0.113.7', 'ipv4'), true);
  assert.equal(c.trustedProxies.check('172.18.0.2', 'ipv4'), false);
  assert.equal(c.webDist, '/w');
});
test('loadConfig rejects bad TRUSTED_PROXIES', () => {
  assert.throws(() => loadConfig({ TRUSTED_PROXIES: 'nope' }), /Invalid TRUSTED_PROXIES entry: nope/);
  assert.throws(() => loadConfig({ TRUSTED_PROXIES: '10.0.0.0/33' }), /Invalid TRUSTED_PROXIES entry: 10.0.0.0\/33/);
  assert.throws(() => loadConfig({ TRUSTED_PROXIES: '127.0.0.1,10.0.0.0/x' }), /Invalid TRUSTED_PROXIES entry: 10.0.0.0\/x/);
});
test('loadConfig rejects non-numeric limits', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT: abc/);
  assert.throws(() => loadConfig({ MAX_UPLOAD_MB: '-1' }), /Invalid MAX_UPLOAD_MB: -1/);
  assert.throws(() => loadConfig({ TRASH_DAYS: '1.5' }), /Invalid TRASH_DAYS: 1.5/);
});
test('openDb migrates once', async () => {
  const f = join(await tempDir(), 'g.db');
  const db = openDb(f);
  for (const t of ['users', 'shares', 'sessions', 'trash', 'media_meta', 'uploads'])
    assert.ok(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(t), t);
  assert.throws(() => db.exec("insert into shares (user_id, alias, rel_path) values (999, 'a', 'b')"), /FOREIGN KEY constraint failed/);
  assert.equal((db.prepare('pragma journal_mode').get() as any).journal_mode, 'wal');
  assert.equal((db.prepare('pragma busy_timeout').get() as any).timeout, 5000);
  db.close();
  assert.equal((openDb(f).prepare('pragma user_version').get() as any).user_version, 1);
});
test('healthz + security headers', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const r = await fetch(ta.url + '/healthz');
  assert.equal(r.status, 200); assert.equal(await r.text(), 'ok');
  assert.match(r.headers.get('content-security-policy')!, /^default-src 'self'; img-src 'self' blob: data:;/);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(r.headers.get('strict-transport-security'), null);
  // loopback is a trusted proxy in the test config, so its X-Forwarded-Proto counts
  const s = await fetch(ta.url + '/nope', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(s.status, 404);
  assert.equal(s.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(s.headers.get('x-frame-options'), 'DENY');
});
test('router: params, 404, 405, errors, readJson', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => { logged.push(line); });
  const r = ta.app.router;
  r.add('GET', '/api/x/:id', (c) => ({ id: c.params.id }));
  r.add('GET', '/api/boom', () => { throw new Error('x'); });
  r.add('GET', '/api/teapot', () => { throw new HttpError(418, 'short and stout'); });
  r.add('POST', '/api/echo', async (c) => readJson(c));
  const c = ta.client();
  assert.deepEqual((await c.json('GET', '/api/x/a%20b')).body, { id: 'a b' });
  const head = await c.req('HEAD', '/api/x/1');
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.deepEqual(await c.json('GET', '/api/nope'), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await c.json('GET', '/api/x/%zz'), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await c.json('DELETE', '/api/x/1'), { status: 405, body: { error: 'Method not allowed' } });
  assert.deepEqual(await c.json('GET', '/api/boom'), { status: 500, body: { error: 'Something went wrong' } });
  assert.match(logged.join('\n'), /"event":"error","message":"x","stack":"Error: x/);
  assert.deepEqual(await c.json('GET', '/api/teapot'), { status: 418, body: { error: 'short and stout' } });
  assert.equal((await c.req('POST', '/api/echo', 'hi', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await c.req('POST', '/api/echo', '{bad', { 'content-type': 'application/json' })).status, 400);
  const big = await c.req('POST', '/api/echo', 'x'.repeat(1_000_001), { 'content-type': 'application/json' });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('connection'), 'close');   // the unread rest of the body must not linger on a kept-alive socket
  assert.deepEqual((await c.json('POST', '/api/echo', { a: 1 })).body, { a: 1 });
});
test('only origin-form request targets are served', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const raw = (target: string) => new Promise<string>((resolve) => {
    const s = connect(Number(new URL(ta.url).port), '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => resolve(data));
  });
  for (const target of ['http://elsewhere.example/healthz', '*']) {
    const res = await raw(target);
    assert.match(res, /^HTTP\/1\.1 400 /);
    assert.match(res, /\{"error":"Invalid path"\}$/);
  }
  assert.match(await raw('//healthz'), /^HTTP\/1\.1 404 /);   // not read as host "healthz"
});
test('an error after the response started cuts the connection and the server keeps serving', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => { logged.push(line); });
  ta.app.router.add('GET', '/api/half', (c) => { c.res.writeHead(200); c.res.write('partial'); throw new Error('late'); });
  await assert.rejects(async () => (await fetch(ta.url + '/api/half')).text());
  assert.match(logged.join('\n'), /"event":"error","message":"late"/);
  assert.equal((await fetch(ta.url + '/healthz')).status, 200);
});
test('readBody / readForm: content type and size guards', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  ta.app.router.add('POST', '/api/chunk', async (c) => (await readBody(c, 4, 'application/octet-stream', 'Chunk too large')).length);
  ta.app.router.add('POST', '/api/form', async (c) => Object.fromEntries(await readForm(c)));
  const c = ta.client();
  const bin = { 'content-type': 'application/octet-stream' };
  assert.equal(await (await c.req('POST', '/api/chunk', Buffer.from('abcd'), bin)).text(), '4');
  const big = await c.req('POST', '/api/chunk', Buffer.from('abcde'), bin);
  assert.deepEqual([big.status, await big.json()], [413, { error: 'Chunk too large' }]);
  const text = await c.req('POST', '/api/chunk', 'abcd', { 'content-type': 'text/plain' });
  assert.deepEqual([text.status, await text.json()], [415, { error: 'Expected binary data' }]);
  // fetch adds ";charset=UTF-8" to URLSearchParams bodies; the media type must still match
  assert.deepEqual(await (await c.req('POST', '/api/form', new URLSearchParams({ a: '1', b: 'x y' }))).json(), { a: '1', b: 'x y' });
  const json = await c.req('POST', '/api/form', '{}', { 'content-type': 'application/json' });
  assert.deepEqual([json.status, await json.json()], [415, { error: 'Expected form data' }]);
});
test('clientInfo trusts forwarded headers only from trusted proxies', () => {
  const trusted = loadConfig({ TRUSTED_PROXIES: '10.0.0.0/8' }).trustedProxies;
  const req = (remote: string, headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress: remote }, headers: { host: 'gallery.local', ...headers } }) as unknown as IncomingMessage;
  const fwd = { 'x-forwarded-for': '203.0.113.9, 10.1.1.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'photos.example.com' };
  const viaProxy = { ip: '203.0.113.9', https: true, host: 'photos.example.com', origin: 'https://photos.example.com' };
  assert.deepEqual(clientInfo(req('10.0.0.5', fwd), trusted), viaProxy);
  assert.deepEqual(clientInfo(req('::ffff:10.0.0.5', fwd), trusted), viaProxy);
  // an untrusted socket cannot spoof anything
  assert.deepEqual(clientInfo(req('8.8.8.8', fwd), trusted), { ip: '8.8.8.8', https: false, host: 'gallery.local', origin: 'http://gallery.local' });
  // the rightmost untrusted hop wins, so a client-supplied leftmost entry is ignored; all trusted -> leftmost
  assert.equal(clientInfo(req('10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), trusted).ip, '203.0.113.9');
  assert.equal(clientInfo(req('10.0.0.5', { 'x-forwarded-for': '10.2.2.2, 10.3.3.3' }), trusted).ip, '10.2.2.2');
  // trusted proxy without forwarded headers; first value of multi-value headers
  assert.deepEqual(clientInfo(req('10.0.0.5'), trusted), { ip: '10.0.0.5', https: false, host: 'gallery.local', origin: 'http://gallery.local' });
  assert.deepEqual(clientInfo(req('10.0.0.5', { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'a.example, b.example' }), trusted),
    { ip: '10.0.0.5', https: true, host: 'a.example', origin: 'https://a.example' });
});
test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; hg_session=tok=en; junk; =x; b=2; a=3'), { a: '1', hg_session: 'tok=en', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});
test('pipeline gives handlers the client info; test client sends Origin on non-GET and the cookie', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const seen = (c: { req: IncomingMessage; ip: string; https: boolean; origin: string }) =>
    ({ ip: c.ip, https: c.https, origin: c.origin, reqOrigin: c.req.headers.origin ?? null, cookie: c.req.headers.cookie ?? null, type: c.req.headers['content-type'] ?? null });
  ta.app.router.add('GET', '/api/seen', seen);
  ta.app.router.add('POST', '/api/seen', seen);
  const c = ta.client('hg_session=abc');
  assert.deepEqual((await c.json('GET', '/api/seen')).body,
    { ip: '127.0.0.1', https: false, origin: ta.url, reqOrigin: null, cookie: 'hg_session=abc', type: null });
  assert.deepEqual((await c.json('POST', '/api/seen', { a: 1 })).body,
    { ip: '127.0.0.1', https: false, origin: ta.url, reqOrigin: ta.url, cookie: 'hg_session=abc', type: 'application/json' });
  const proxied = await ta.client().req('GET', '/api/seen', undefined, { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gallery.example.com' });
  assert.deepEqual(await proxied.json(), { ip: '203.0.113.9', https: true, origin: 'https://gallery.example.com', reqOrigin: null, cookie: null, type: null });
});

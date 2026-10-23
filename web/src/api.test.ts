import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, api, downloadUrl, thumbUrl, viewUrl } from './api.ts';

test('URL helpers build what the media routes take', () => {
  const v = '/Дача #2 (2024)/IMG 50%.jpg';
  const p = encodeURIComponent(v);
  assert.equal(thumbUrl(v, 1700000000000), `/media/thumb?path=${p}&v=1700000000000`);
  assert.equal(viewUrl(v), `/media/view?path=${p}`);
  assert.equal(downloadUrl(v), `/media/download?path=${p}`);
});

test('api: JSON in, JSON out, the server message in the error, and 401 tells the app', async (t) => {
  const events: string[] = [];
  const bus = new EventTarget();
  bus.addEventListener('gallery:unauthorized', () => events.push('unauthorized'));
  Object.assign(globalThis, { window: bus });
  const calls: [string, RequestInit | undefined][] = [];
  const reply = (status: number, body: string) => {
    t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(body, { status }); });
  };

  reply(200, '{"ok":true}');
  assert.deepEqual(await api('POST', '/api/x', { a: 1 }), { ok: true });
  assert.equal(calls[0][0], '/api/x');
  assert.equal(calls[0][1]?.method, 'POST');
  assert.equal(calls[0][1]?.body, '{"a":1}');
  assert.deepEqual(calls[0][1]?.headers, { 'content-type': 'application/json' });
  t.mock.restoreAll();

  reply(409, '{"error":"A file or folder with that name already exists"}');
  await assert.rejects(api('POST', '/api/mkdir', {}), (e) => e instanceof ApiError && e.status === 409 && e.message === 'A file or folder with that name already exists');
  assert.deepEqual(events, []);
  t.mock.restoreAll();

  reply(401, '{"error":"Sign in required"}');
  await assert.rejects(api('GET', '/api/list?path=%2F'), { status: 401, message: 'Sign in required' });
  assert.deepEqual(events, ['unauthorized']);
  await assert.rejects(api('POST', '/api/login', {}), { status: 401 });
  await assert.rejects(api('GET', '/api/session'), { status: 401 });
  assert.deepEqual(events, ['unauthorized'], 'a refused login or an anonymous session check is no expiry');
  t.mock.restoreAll();

  reply(502, '<html>Bad gateway</html>');
  await assert.rejects(api('GET', '/api/session'), { status: 502, message: 'Something went wrong' });
  t.mock.restoreAll();

  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api('GET', '/api/session'), { status: 0, message: "Can't reach the server" });
});

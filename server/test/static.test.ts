import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startTestApp, tempDir } from './helpers.ts';

test('SPA fallback and assets', async (t) => {
  const dist = await tempDir(); await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html>app'); await writeFile(join(dist, 'assets/x.js'), 'js');
  const ta = await startTestApp({ webDist: dist }); t.after(() => ta.close());
  const page = await fetch(ta.url + '/browse/Fam/x');
  assert.equal(await page.text(), '<!doctype html>app'); assert.equal(page.headers.get('cache-control'), 'private, no-cache');
  const js = await fetch(ta.url + '/assets/x.js');
  assert.equal(await js.text(), 'js'); assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await (await fetch(ta.url + '/assets/..%2F..%2Fpackage.json')).text(), '<!doctype html>app');
  assert.equal((await fetch(ta.url + '/api/nope')).status, 404);
});

test('the web files: types, a missing asset, HEAD, and nothing but GET', async (t) => {
  const dist = await tempDir(); await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html>app'); await writeFile(join(dist, 'assets/x.js'), 'js'); await writeFile(join(dist, 'assets/x.css'), 'a{}');
  const ta = await startTestApp({ webDist: dist }); t.after(() => ta.close());
  assert.equal((await fetch(ta.url + '/')).headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await fetch(ta.url + '/assets/x.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(ta.url + '/assets/x.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  // a stale file name, a folder, a bad %-escape, a NUL and a file used as a folder all end at the page, as a missing file does
  for (const p of ['/assets/gone.js', '/assets/', '/assets/%E0%A4%A', '/assets/x.js%00', '/assets/x.js/more']) assert.equal(await (await fetch(ta.url + p)).text(), '<!doctype html>app', p);
  const head = await fetch(ta.url + '/setup', { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length'), await head.text()], [200, '18', '']);
  // the API and the media routes keep their own JSON 404; the page answers to reads only
  for (const p of ['/api', '/api/nope', '/media/nope']) {
    const r = await fetch(ta.url + p);
    assert.deepEqual([r.status, await r.json()], [404, { error: 'Not found' }], p);
  }
  assert.deepEqual(await ta.client().json('POST', '/browse/x', {}), { status: 404, body: { error: 'Not found' } });
  assert.equal((await fetch(ta.url + '/', { headers: { cookie: 'hg_session=nonsense' } })).status, 200, 'the login page is for people without a session');
});

test('without a build the page says how to make one', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());   // webDist is a folder that doesn't exist
  const r = await fetch(ta.url + '/browse/x');
  assert.deepEqual([r.status, r.headers.get('content-type'), await r.text()], [404, 'text/plain; charset=utf-8', 'Web UI not built (run npm run build)']);
  assert.equal((await fetch(ta.url + '/assets/x.js')).status, 404);
  assert.equal((await fetch(ta.url + '/healthz')).status, 200);
});

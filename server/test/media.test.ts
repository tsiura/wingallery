import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { copyFile, open, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises';
import { createServer, validateHeaderValue } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { imageSize } from 'image-size';
import { HttpError } from '../http.ts';
import type { Ctx } from '../http.ts';
import type { RunFn } from '../proc.ts';
import { contentDisposition, sendFile } from '../send.ts';
import { createThumbnailer } from '../thumbs.ts';
import type { Thumbnailer } from '../thumbs.ts';
import { fixture, hasCommand, seedTree, startTestApp, tempDir } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mediaUrl = (route: string, path: string) => `/media/${route}?path=${encodeURIComponent(path)}`;
const thumbUrl = (path: string) => '/media/thumb?v=1&path=' + encodeURIComponent(path);
const bytesOf = async (r: Response) => Buffer.from(await r.arrayBuffer());
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const isJpeg = (bytes: Buffer) => bytes.subarray(0, 3).equals(JPEG_MAGIC);
const NO_PREVIEW = { status: 422, body: { error: 'No preview available' } };

let ta: TestApp, a: Client, papa: Client;

before(async () => {
  ta = await startTestApp();
  // pics/{a.jpg, notes.txt, .hidden.jpg, @eaDir/t.jpg, Album.jpg/ (a folder), Дача #2 (2024)/Фото 50%.jpg}, fam/x.jpg; fam/leak.jpg links to pics/a.jpg, fam/out.jpg to a file outside MEDIA_ROOT
  await seedTree(ta.media, ['pics/a.jpg', 'pics/Дача #2 (2024)/Фото 50%.jpg', 'pics/notes.txt', 'pics/.hidden.jpg', 'pics/@eaDir/t.jpg', 'pics/Album.jpg/', 'fam/x.jpg'],
    [[join(ta.media, 'pics/a.jpg'), 'fam/leak.jpg'], [process.execPath, 'fam/out.jpg']]);
  for (const [from, to] of [['clip.mp4', 'pics/v.mp4'], ['clip.mp4', 'pics/m.mov'], ['sample.heic', 'pics/s.heic'], ['corrupt.jpg', 'pics/corrupt.jpg']])
    await copyFile(fixture(from), join(ta.media, to));
  a = await ta.admin();
  const p = await ta.addUser('papa', 'member');
  papa = p.client;
  ta.db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, 0, 0, 0)').run(p.id, 'Fam', 'fam');
});
after(() => ta.close());

// A thumbnailer over a cache folder of its own, whose tools are `run`. A tool writes its picture to the last argument minus the [options] vips takes there.
const thumbsIn = (dataDir: string, run: RunFn): Thumbnailer => createThumbnailer({ ...ta.cfg, dataDir }, run);
const outOf = (args: string[]) => args.at(-1)!.replace(/\[.*$/, '');
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
// How many descriptors of this process are open on `file` (Linux only: the tests that use it skip themselves elsewhere).
const holdingOpen = (file: string) => readdirSync('/proc/self/fd').filter((fd) => { try { return readlinkSync('/proc/self/fd/' + fd) === file; } catch { return false; } }).length;

test('sendFile ranges, HEAD, 304, 416', async () => {
  const url = mediaUrl('download', '/pics/v.mp4');
  const size = (await stat(join(ta.media, 'pics/v.mp4'))).size;
  const full = await a.req('GET', url);
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(Number(full.headers.get('content-length')), size);
  assert.equal((await full.arrayBuffer()).byteLength, size);
  const part = await a.req('GET', url, undefined, { range: 'bytes=0-9' });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-9/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await (await a.req('GET', url, undefined, { range: 'bytes=-5' })).arrayBuffer()).byteLength, 5);
  const bad = await a.req('GET', url, undefined, { range: `bytes=${size}-` });
  assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
  assert.equal((await a.req('HEAD', url)).status, 200);
  assert.equal((await a.req('GET', url, undefined, { 'if-none-match': full.headers.get('etag')! })).status, 304);
});
test('a range returns the bytes asked for; one that is malformed, in another unit or one of several is ignored (RFC 9110)', async () => {
  const url = mediaUrl('download', '/pics/v.mp4');
  const whole = await bytesOf(await a.req('GET', url));
  const size = whole.length;
  const get = (range: string) => a.req('GET', url, undefined, { range });
  const ranged = async (range: string, from: number, to: number) => {
    const r = await get(range);
    assert.deepEqual([r.status, r.headers.get('content-range'), r.headers.get('content-length')], [206, `bytes ${from}-${to}/${size}`, String(to - from + 1)], range);
    assert.deepEqual(await bytesOf(r), whole.subarray(from, to + 1), range);
  };
  await ranged('bytes=0-9', 0, 9);
  await ranged('bytes=10-19', 10, 19);
  await ranged('bytes=100-', 100, size - 1);
  await ranged('bytes=-5', size - 5, size - 1);
  await ranged('bytes=0-', 0, size - 1);
  await ranged('bytes=0-999999999', 0, size - 1);      // an end past the file is cut to its last byte
  await ranged('bytes=-999999999', 0, size - 1);       // so is a suffix longer than the file
  await ranged('BYTES=1-2', 1, 2);                     // the unit is case-insensitive
  for (const range of ['bytes=5-2', 'bytes=0-4,6-9', 'items=0-4', 'bytes=abc', 'bytes=-', 'bytes=1-2-3', 'bytes=0-4, ', 'bytes=' + '9'.repeat(40) + '-'])
    assert.deepEqual([(await get(range)).status, range], [200, range]);
  // If-Range needs a strong validator to match, and the file has only a weak one: the whole file, never a piece of what may be another version
  const etag = (await a.req('HEAD', url)).headers.get('etag')!;
  for (const ifRange of [etag, etag.slice(2), 'Wed, 21 Oct 2015 07:28:00 GMT']) {
    const r = await a.req('GET', url, undefined, { range: 'bytes=0-9', 'if-range': ifRange });
    assert.deepEqual([r.status, (await r.arrayBuffer()).byteLength], [200, size], ifRange);
  }
  for (const range of ['bytes=-0', `bytes=${size}-`, `bytes=${size + 1000}-${size + 2000}`]) {
    const r = await get(range);
    assert.deepEqual([r.status, r.headers.get('content-range'), (await r.arrayBuffer()).byteLength], [416, `bytes */${size}`, 0], range);
  }
});
test('HEAD answers the headers of the GET and no body, and never reads the file', async (t) => {
  const url = mediaUrl('download', '/pics/v.mp4');
  const probe = await open(fixture('clip.mp4'));
  const reads = t.mock.method(Object.getPrototypeOf(probe), 'createReadStream');   // a spy on how sendFile reads a file
  await probe.close();
  const head = await a.req('HEAD', url);
  const ranged = await a.req('HEAD', url, undefined, { range: 'bytes=0-9' });
  assert.equal(reads.mock.callCount(), 0);
  const get = await a.req('GET', url);
  await get.arrayBuffer();
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(head.status, 200);
  for (const h of ['content-length', 'content-type', 'content-disposition', 'etag', 'accept-ranges', 'cache-control']) assert.equal(head.headers.get(h), get.headers.get(h), h);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.deepEqual([ranged.status, ranged.headers.get('content-length'), (await ranged.arrayBuffer()).byteLength], [206, '10', 0]);
});
test('ETag: weak, of size and mtime; If-None-Match matches it weakly, in a list or as *, and a changed file no longer matches', async () => {
  const file = join(ta.media, 'pics/etag.mp4');
  await copyFile(fixture('clip.mp4'), file);
  const url = mediaUrl('view', '/pics/etag.mp4');
  const first = await a.req('GET', url);
  await first.arrayBuffer();
  const etag = first.headers.get('etag')!;
  const st = await stat(file);
  assert.equal(etag, `W/"${st.size}-${st.mtimeMs}"`);
  for (const sent of [etag, etag.slice(2), `"nope", ${etag}`, `W/"1-1" , ${etag}`, '*']) {
    const r = await a.req('GET', url, undefined, { 'if-none-match': sent });
    assert.deepEqual([r.status, r.headers.get('etag'), r.headers.get('cache-control'), (await r.arrayBuffer()).byteLength], [304, etag, 'private, no-cache', 0], sent);
  }
  for (const sent of ['W/"1-1"', '"nope"', '']) assert.equal((await a.req('GET', url, undefined, { 'if-none-match': sent })).status, 200, sent);
  await writeFile(file, Buffer.concat([await readFile(fixture('clip.mp4')), Buffer.from('more')]));   // another size
  const changed = await a.req('GET', url, undefined, { 'if-none-match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  await changed.arrayBuffer();
});
test('an empty file: 200 with no bytes, and no range can be satisfied', async () => {
  await writeFile(join(ta.media, 'pics/empty.mp4'), '');
  const url = mediaUrl('download', '/pics/empty.mp4');
  const r = await a.req('GET', url);
  assert.deepEqual([r.status, r.headers.get('content-length'), (await r.arrayBuffer()).byteLength], [200, '0', 0]);
  for (const range of ['bytes=0-', 'bytes=-5']) assert.deepEqual([(await a.req('GET', url, undefined, { range })).status, range], [416, range]);
});
test('a client that hangs up mid-download costs no error line and no open file', { skip: !existsSync('/proc/self/fd'), timeout: 30_000 }, async (t) => {
  const big = join(ta.media, 'pics/huge.mov');
  await writeFile(big, '');
  await truncate(big, 512 * 1024 * 1024);   // sparse, so the server has far more to send than the socket takes
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  const gone = new Promise<void>((resolve) => ta.app.server.once('request', (_req, res) => { res.on('close', () => resolve()); }));   // the next request is the download
  const hangUp = new AbortController();
  const r = await fetch(ta.url + mediaUrl('download', '/pics/huge.mov'), { headers: { cookie: a.cookie! }, signal: hangUp.signal });
  assert.equal(r.status, 200);
  await r.body!.getReader().read();   // the server is streaming now
  assert.equal(holdingOpen(big), 1);
  hangUp.abort();
  await gone;
  await sleep(50);                    // the stream's failure reaches the handler a few ticks later
  assert.equal(holdingOpen(big), 0, 'the file is closed');
  assert.deepEqual(lines, []);
  assert.equal((await a.req('GET', mediaUrl('download', '/pics/a.jpg'))).status, 200, 'the server carries on');
});

test('a client that leaves while its thumbnail is still being made costs no error line, and the thumbnail is kept', async (t) => {
  const real = ta.app.thumbs;
  t.after(() => { ta.app.thumbs = real; });
  const dataDir = await tempDir();
  let made = 0;
  ta.app.thumbs = thumbsIn(dataDir, async (_cmd, args) => { made++; await sleep(150); await writeFile(outOf(args), Buffer.alloc(100_000)); return ''; });
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  const gone = new Promise<void>((resolve) => ta.app.server.once('request', (_req, res) => { res.on('close', () => resolve()); }));   // the next request is the thumbnail
  const hangUp = new AbortController();
  const pending = fetch(ta.url + thumbUrl('/pics/a.jpg'), { headers: { cookie: a.cookie! }, signal: hangUp.signal }).catch(() => null);
  await sleep(30);
  hangUp.abort();
  await Promise.all([gone, pending]);
  await sleep(300);   // the job has finished by now, and the handler has found nobody to send the picture to
  assert.deepEqual(lines, []);
  assert.equal(made, 1);
  assert.equal((await readdir(join(dataDir, 'cache/thumbs'))).length, 1);
  assert.equal((await a.req('GET', thumbUrl('/pics/a.jpg'))).status, 200, 'the next request is served from the cache');
  assert.equal(made, 1);
});
test('answers without a body close the file too (304, 416, HEAD)', { skip: !existsSync('/proc/self/fd') }, async () => {
  const url = mediaUrl('download', '/pics/v.mp4');
  const etag = (await a.req('HEAD', url)).headers.get('etag')!;
  for (let i = 0; i < 10; i++)
    for (const [method, headers] of [['GET', { 'if-none-match': etag }], ['GET', { range: 'bytes=99999999-' }], ['HEAD', {}], ['GET', { range: 'bytes=0-4' }]] as const)
      await (await a.req(method, url, undefined, headers)).arrayBuffer();
  await sleep(50);
  assert.equal(holdingOpen(join(ta.media, 'pics/v.mp4')), 0);
});

test('download name encoding (Review Focus 1)', async () => {
  const r = await a.req('GET', '/media/download?path=' + encodeURIComponent('/pics/Дача #2 (2024)/Фото 50%.jpg'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="____ 50%.jpg"; filename*=UTF-8''${encodeURIComponent('Фото 50%.jpg')}`);
});
test('contentDisposition: an ASCII fallback beside the percent-encoded UTF-8 name, and nothing that can break the header', () => {
  assert.equal(contentDisposition('attachment', 'a.jpg'), `attachment; filename="a.jpg"; filename*=UTF-8''a.jpg`);
  assert.equal(contentDisposition('inline', 'IMG 1.jpg'), `inline; filename="IMG 1.jpg"; filename*=UTF-8''IMG%201.jpg`);
  // a quote or backslash would end or escape the quoted string; control characters (CR LF above all) would end the header line
  assert.equal(contentDisposition('attachment', 'a"b\\c\r\nd\te\x00f\x7f.jpg'), `attachment; filename="a_b_c__d_e_f_.jpg"; filename*=UTF-8''a%22b%5Cc%0D%0Ad%09e%00f%7F.jpg`);
  // ' ( ) * are not RFC 5987 attr-chars, and encodeURIComponent leaves them alone
  assert.equal(contentDisposition('attachment', "it's (1)*.jpg"), `attachment; filename="it's (1)*.jpg"; filename*=UTF-8''it%27s%20%281%29%2A.jpg`);
  assert.equal(contentDisposition('attachment', 'a;b,c=d%e#f&g+h.jpg'), `attachment; filename="a;b,c=d%e#f&g+h.jpg"; filename*=UTF-8''a%3Bb%2Cc%3Dd%25e%23f%26g%2Bh.jpg`);
  assert.equal(contentDisposition('attachment', 'снимок 😀.png'), `attachment; filename="______ _.png"; filename*=UTF-8''${encodeURIComponent('снимок 😀.png')}`);
  // whatever the name holds, the result is a value Node accepts in a header
  for (const name of ['\n', '"', '\\', '\u2028', '\x1b[0m', 'x'.repeat(300)]) assert.doesNotThrow(() => validateHeaderValue('content-disposition', contentDisposition('attachment', name)), JSON.stringify(name));
});
test('download is the untouched original as an attachment with its own type, under the security headers', async () => {
  const r = await a.req('GET', mediaUrl('download', '/pics/m.mov'));
  assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'video/quicktime', 'private, no-cache']);
  assert.deepEqual([r.headers.get('x-content-type-options'), r.headers.get('x-frame-options'), r.headers.get('referrer-policy')], ['nosniff', 'DENY', 'same-origin']);
  assert.match(r.headers.get('content-security-policy')!, /^default-src 'self'; /);
  assert.match(r.headers.get('content-disposition')!, /^attachment; filename="m\.mov"; filename\*=UTF-8''m\.mov$/);
  assert.deepEqual(await bytesOf(r), await readFile(fixture('clip.mp4')));
  assert.equal((await a.req('GET', mediaUrl('download', '/pics/s.heic'))).headers.get('content-type'), 'image/heic');
});

test('view types and access control', async () => {
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/m.mov'))).headers.get('content-type'), 'video/mp4');
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/a.jpg'))).headers.get('content-type'), 'image/jpeg');
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics'))).status, 404);
  assert.equal((await papa.req('GET', '/media/download?path=' + encodeURIComponent('/pics/a.jpg'))).status, 404);   // papa only has 'Fam'
});
test('view: the original, inline, kept but asked about every time', async () => {
  const r = await a.req('GET', mediaUrl('view', '/pics/a.jpg'));
  assert.deepEqual([r.status, r.headers.get('cache-control'), r.headers.get('content-disposition'), r.headers.get('accept-ranges')], [200, 'private, no-cache', null, 'bytes']);
  assert.deepEqual(await bytesOf(r), await readFile(join(ta.media, 'pics/a.jpg')));
});
test('every media route refuses anonymous requests before it looks at the path (F15)', async () => {
  for (const route of ['thumb', 'view', 'download'])
    for (const path of ['/pics/a.jpg', '/pics', '../x', ''])
      assert.deepEqual(await ta.client().json('GET', route === 'thumb' ? thumbUrl(path) : mediaUrl(route, path)), { status: 401, body: { error: 'Sign in required' } }, route + path);
});
test('only media files are served: folders, other files, hidden names, links out of the share and the member root are refused', async () => {
  const NOT_FOUND = { status: 404, body: { error: 'Not found' } }, INVALID = { status: 400, body: { error: 'Invalid path' } };
  for (const route of ['thumb', 'view', 'download']) {
    const at = (path: string) => (route === 'thumb' ? thumbUrl(path) : mediaUrl(route, path));
    const dots = (route === 'thumb' ? '/media/thumb?v=1&path=' : `/media/${route}?path=`) + encodeURIComponent('/pics/') + '%2E%2E' + encodeURIComponent('/fam/x.jpg');   // %2E%2E: the server decodes it to ..
    for (const path of ['/', '/pics', '/pics/Album.jpg', '/pics/notes.txt', '/pics/missing.jpg']) assert.deepEqual(await a.json('GET', at(path)), NOT_FOUND, route + path);   // no file, a folder named like one, no media, or nothing there
    for (const path of ['/pics/.hidden.jpg', '/pics/@eaDir/t.jpg', '/pics/@eaDir', '/pics/../fam/x.jpg', '/pics/a.jpg/', '/pics\\a.jpg', '']) assert.deepEqual(await a.json('GET', at(path)), INVALID, route + path);
    assert.deepEqual(await a.json('GET', dots), INVALID, route + ' %2E%2E');
    assert.deepEqual(await a.json('GET', at('/fam/out.jpg')), NOT_FOUND, route);          // a link out of MEDIA_ROOT, which not even the administrator follows
    assert.deepEqual(await papa.json('GET', at('/')), NOT_FOUND, route);                  // the member root is no file
    assert.deepEqual(await papa.json('GET', at('/Fam/leak.jpg')), NOT_FOUND, route);      // a link to a file of another share
    assert.deepEqual(await papa.json('GET', at('/Fam/out.jpg')), NOT_FOUND, route);
    assert.deepEqual(await papa.json('GET', at('/pics/a.jpg')), NOT_FOUND, route);        // a share papa does not have
    assert.deepEqual(await papa.json('GET', at('/Fam/../pics/a.jpg')), INVALID, route);
  }
  assert.equal((await papa.req('GET', mediaUrl('download', '/Fam/x.jpg'))).status, 200);   // while their own file is theirs
  assert.equal((await papa.req('GET', mediaUrl('view', '/Fam/x.jpg'))).status, 200);
});

test('video thumbnail is generated once and cached', { skip: !hasCommand('ffmpeg') }, async () => {
  const tree = async () => (await readdir(ta.media, { recursive: true })).sort();
  const before = await tree();
  const r = await a.req('GET', '/media/thumb?v=1&path=' + encodeURIComponent('/pics/v.mp4'));
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.ok(isJpeg(await bytesOf(r)), 'a JPEG (R2)');
  const files = await readdir(join(ta.cfg.dataDir, 'cache/thumbs'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{40}\.jpg$/);
  const second = await a.req('GET', thumbUrl('/pics/v.mp4'));
  assert.equal(second.headers.get('etag'), r.headers.get('etag'), 'the same file again: nothing was made twice');
  await second.arrayBuffer();
  assert.deepEqual(await readdir(join(ta.cfg.dataDir, 'cache/thumbs')), files);
  assert.deepEqual(await tree(), before, 'nothing is written next to the media');
});
test('photo + HEIC thumbnails and HEIC preview', { skip: !hasCommand('vipsthumbnail') }, async () => {
  for (const p of ['/pics/a.jpg', '/pics/s.heic']) {
    const r = await a.req('GET', '/media/thumb?v=1&path=' + encodeURIComponent(p));
    assert.equal(r.status, 200, p);
    const bytes = await bytesOf(r);
    assert.ok(isJpeg(bytes), p + ' is a JPEG (R2)');
    const { width, height } = imageSize(bytes);
    assert.ok(width <= 480 && height <= 480, `${p} is ${width}x${height}`);
  }
  const v = await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/s.heic'));
  assert.equal(v.headers.get('content-type'), 'image/jpeg');
  const preview = await bytesOf(v);
  assert.ok(isJpeg(preview), 'the preview is a JPEG (R2)');
  const { width, height } = imageSize(preview);
  assert.ok(width <= 2560 && height <= 2560, `${width}x${height}`);
  assert.equal((await readdir(join(ta.cfg.dataDir, 'cache/previews'))).length, 1);
  assert.deepEqual(await a.json('GET', '/media/thumb?v=1&path=' + encodeURIComponent('/pics/corrupt.jpg')), { status: 422, body: { error: 'No preview available' } });
});
test('a poster of a bigger clip is scaled down to at most 480 px (R2)', { skip: !hasCommand('ffmpeg') }, async () => {
  const dir = await tempDir();
  await execFileP('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=1:r=5', '-pix_fmt', 'yuv420p', join(dir, 'big.mp4')]);
  await copyFile(join(dir, 'big.mp4'), join(ta.media, 'pics/big.mp4'));
  const r = await a.req('GET', thumbUrl('/pics/big.mp4'));
  assert.equal(r.status, 200);
  const bytes = await bytesOf(r);
  assert.ok(isJpeg(bytes));
  const { width, height } = imageSize(bytes);
  assert.ok(width <= 480 && height <= 480, `${width}x${height}`);
  assert.deepEqual([width, height], [480, 270]);
});
test('a video ffmpeg can not read is answered 422 and leaves nothing behind (Review Focus 2)', { skip: !hasCommand('ffmpeg') }, async () => {
  await writeFile(join(ta.media, 'pics/broken.mp4'), 'this is not a video');
  assert.deepEqual(await a.json('GET', thumbUrl('/pics/broken.mp4')), NO_PREVIEW);
  assert.deepEqual((await readdir(join(ta.cfg.dataDir, 'cache/thumbs'))).filter((n) => !/^[0-9a-f]{40}\.jpg$/.test(n)), []);
});
test('/media/view makes a JPEG preview of HEIC and HEIF, once, and serves every other photo as it is', async (t) => {
  const calls: string[][] = [];
  const real = ta.app.thumbs;
  t.after(() => { ta.app.thumbs = real; });
  ta.app.thumbs = thumbsIn(await tempDir(), async (cmd, args) => { calls.push([cmd, ...args]); await writeFile(outOf(args), Buffer.concat([JPEG_MAGIC, Buffer.from('preview')])); return ''; });
  await copyFile(fixture('sample.heic'), join(ta.media, 'pics/IMG_1.HEIF'));
  for (const path of ['/pics/s.heic', '/pics/IMG_1.HEIF']) {
    const r = await a.req('GET', mediaUrl('view', path));
    assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control'), r.headers.get('content-disposition')], [200, 'image/jpeg', 'private, no-cache', null], path);
    assert.deepEqual(await bytesOf(r), Buffer.concat([JPEG_MAGIC, Buffer.from('preview')]), path);
  }
  assert.equal((await a.req('GET', mediaUrl('view', '/pics/s.heic'))).status, 200);
  assert.equal(calls.length, 2, 'one preview per file');
  assert.deepEqual(calls[0].slice(0, 4), ['vipsthumbnail', join(ta.media, 'pics/s.heic'), '--size', '2560x2560>']);
  assert.equal((await a.req('GET', mediaUrl('view', '/pics/a.jpg'))).status, 200);
  assert.equal(calls.length, 2, 'a JPEG is not converted');
  assert.equal((await a.req('GET', thumbUrl('/pics/s.heic'))).status, 200);   // the thumbnail of the same HEIC is a file of its own
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].slice(0, 4), ['vipsthumbnail', join(ta.media, 'pics/s.heic'), '--size', '480x480>']);
});
test('a preview or thumbnail that can not be made is 422 on every route that makes one', async (t) => {
  const real = ta.app.thumbs;
  t.after(() => { ta.app.thumbs = real; });
  ta.app.thumbs = thumbsIn(await tempDir(), async () => { throw new Error('vipsthumbnail failed: not a known file format'); });
  assert.deepEqual(await a.json('GET', mediaUrl('view', '/pics/s.heic')), NO_PREVIEW);
  assert.deepEqual(await a.json('GET', thumbUrl('/pics/corrupt.jpg')), NO_PREVIEW);
  assert.deepEqual(await a.json('GET', thumbUrl('/pics/v.mp4')), NO_PREVIEW);
  assert.equal((await a.req('GET', mediaUrl('download', '/pics/corrupt.jpg'))).status, 200, 'the original is still there to download');
});

test('concurrent requests share one job', async () => {
  let calls = 0;
  const th = createThumbnailer(ta.cfg, async (_c, args) => { calls++; await new Promise((r) => setTimeout(r, 50)); await writeFile(args.at(-1)!.replace(/\[.*$/, ''), 'x'); return ''; });
  const st = { size: 1, mtimeMs: 1 };
  await Promise.all([th.thumb('/x.jpg', 'x.jpg', st, 'photo'), th.thumb('/x.jpg', 'x.jpg', st, 'photo')]);
  assert.equal(calls, 1);
  await th.thumb('/x.jpg', 'x.jpg', st, 'photo');   // later ones find the file (F12.3)
  await th.thumb('/x.jpg', 'x.jpg', st, 'photo');
  assert.equal(calls, 1);
});
test('cache files: named by path, size and mtime, under DATA_DIR/cache only, written through a temp name and renamed', async () => {
  const dataDir = await tempDir();
  const outs: string[] = [];
  const th = thumbsIn(dataDir, async (_c, args) => { outs.push(args.at(-1)!); await writeFile(outOf(args), 'x'); return ''; });
  const key = (rel: string, size: number, mtimeMs: number) => createHash('sha1').update(`${rel}\0${size}\0${mtimeMs}`).digest('hex') + '.jpg';
  const st = { size: 12, mtimeMs: 3.5 };
  const thumb = await th.thumb('/media/a/b.jpg', 'a/b.jpg', st, 'photo');
  const preview = await th.preview('/media/a/b.jpg', 'a/b.jpg', st);
  assert.equal(thumb, join(dataDir, 'cache/thumbs', key('a/b.jpg', 12, 3.5)));
  assert.equal(preview, join(dataDir, 'cache/previews', key('a/b.jpg', 12, 3.5)));
  assert.ok(outs[0].startsWith(thumb) && /^\.[0-9a-f]{12}\.tmp\.jpg\[Q=80,strip\]$/.test(outs[0].slice(thumb.length)), outs[0]);   // a temp name beside the file, in the same folder
  assert.deepEqual(await readdir(join(dataDir, 'cache/thumbs')), [key('a/b.jpg', 12, 3.5)], 'no temp file is left');
  assert.deepEqual(await readdir(join(dataDir, 'cache/previews')), [key('a/b.jpg', 12, 3.5)]);
  // another path, size or mtime is another file; the same ones are the same file
  const others = await Promise.all([th.thumb('/m/b.jpg', 'a/c.jpg', st, 'photo'), th.thumb('/m/b.jpg', 'a/b.jpg', { size: 13, mtimeMs: 3.5 }, 'photo'), th.thumb('/m/b.jpg', 'a/b.jpg', { size: 12, mtimeMs: 4 }, 'photo')]);
  assert.equal(new Set([thumb, ...others]).size, 4);
  assert.equal(outs.length, 5);
  assert.equal(await th.thumb('/elsewhere/b.jpg', 'a/b.jpg', st, 'photo'), thumb);
  assert.equal(outs.length, 5, 'the abs path is not part of the key: rel is');
});
test('the tool commands: absolute input, size bounds, JPEG quality, the output last, time limits (R3, F16)', async () => {
  const calls: { cmd: string; args: string[]; ms: number }[] = [];
  const th = thumbsIn(await tempDir(), async (cmd, args, ms) => { calls.push({ cmd, args, ms }); await writeFile(outOf(args), 'x'); return ''; });
  const st = { size: 1, mtimeMs: 1 };
  await th.thumb('/m/a.jpg', 'a.jpg', st, 'photo');
  await th.preview('/m/s.heic', 's.heic', st);
  await th.thumb('/m/v.mp4', 'v.mp4', st, 'video');
  const [photo, heic, video] = calls;
  assert.deepEqual([photo.cmd, photo.args.slice(0, 4), photo.ms], ['vipsthumbnail', ['/m/a.jpg', '--size', '480x480>', '-o'], 30_000]);
  assert.match(photo.args[4], /\.tmp\.jpg\[Q=80,strip\]$/);
  assert.deepEqual([heic.cmd, heic.args.slice(0, 4), heic.ms], ['vipsthumbnail', ['/m/s.heic', '--size', '2560x2560>', '-o'], 60_000]);
  assert.match(heic.args[4], /\.tmp\.jpg\[Q=85,strip\]$/);
  assert.equal(video.ms, 30_000);
  assert.equal(video.cmd, 'ffmpeg');
  // only the file protocol may be opened (R3), and it is set before -i; the first frame after one second; JPEG quality 5 (F16); the output last
  assert.deepEqual(video.args.slice(0, 8), ['-v', 'error', '-protocol_whitelist', 'file', '-ss', '1', '-i', '/m/v.mp4']);
  assert.deepEqual(video.args.slice(8, -1), ['-frames:v', '1', '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease", '-q:v', '5', '-y']);
  assert.match(video.args.at(-1)!, /\.tmp\.jpg$/);
  assert.ok(video.args.indexOf('-protocol_whitelist') < video.args.indexOf('-i'));
});
test('a poster is tried again from the first frame when ffmpeg fails or leaves nothing at -ss 1 (F3)', async () => {
  const st = { size: 1, mtimeMs: 1 };
  for (const [how, atOne] of [['exits non-zero', async () => { throw new Error('ffmpeg failed: exit 234'); }], ['leaves no file', async () => {}], ['leaves an empty file', async (out: string) => { await writeFile(out, ''); }]] as const) {
    const seeks: string[] = [];
    const th = thumbsIn(await tempDir(), async (_cmd, args) => {
      seeks.push(valueAfter(args, '-ss'));
      if (valueAfter(args, '-ss') === '1') await atOne(outOf(args));
      else await writeFile(outOf(args), JPEG_MAGIC);
      return '';
    });
    const file = await th.thumb('/m/short.mp4', 'short.mp4', st, 'video');
    assert.deepEqual(seeks, ['1', '0'], how);
    assert.ok(isJpeg(await readFile(file)), how);
  }
  // both fail: 422, once each, and nothing is cached
  const seeks: string[] = [];
  const dataDir = await tempDir();
  const th = thumbsIn(dataDir, async (_cmd, args) => { seeks.push(valueAfter(args, '-ss')); throw new Error('ffmpeg failed'); });
  await assert.rejects(th.thumb('/m/bad.mp4', 'bad.mp4', st, 'video'), (e: unknown) => e instanceof HttpError && e.status === 422 && e.message === 'No preview available');
  assert.deepEqual(seeks, ['1', '0']);
  assert.deepEqual(await readdir(join(dataDir, 'cache/thumbs')), []);
  // a photo is not retried
  const photoCalls: string[][] = [];
  const photos = thumbsIn(await tempDir(), async (_cmd, args) => { photoCalls.push(args); throw new Error('vipsthumbnail failed'); });
  await assert.rejects(photos.thumb('/m/bad.jpg', 'bad.jpg', st, 'photo'), (e: unknown) => e instanceof HttpError && e.status === 422);
  assert.equal(photoCalls.length, 1);
});
test('a tool that fails, times out, is missing or leaves nothing is 422; nothing is cached, so the next request tries again', async () => {
  const st = { size: 1, mtimeMs: 1 };
  const dataDir = await tempDir();
  let calls = 0;
  const writes = async (out: string) => { await writeFile(out, 'x'); };
  let behave: (out: string) => Promise<void> = async () => { throw new Error('vipsthumbnail failed: unable to call VipsForeignLoadHeif'); };
  const th = thumbsIn(dataDir, async (_cmd, args) => { calls++; await behave(outOf(args)); return ''; });
  const refused = (e: unknown) => e instanceof HttpError && e.status === 422 && e.message === 'No preview available';
  await assert.rejects(th.thumb('/m/a.jpg', 'a.jpg', st, 'photo'), refused);
  behave = async () => { throw new Error('spawn vipsthumbnail ENOENT'); };
  await assert.rejects(th.thumb('/m/a.jpg', 'a.jpg', st, 'photo'), refused);
  behave = async () => {};   // exits 0 without leaving the picture
  await assert.rejects(th.preview('/m/a.heic', 'a.heic', st), refused);
  behave = async (out) => { await writeFile(out, ''); };   // or an empty one
  await assert.rejects(th.thumb('/m/a.jpg', 'a.jpg', st, 'photo'), refused);
  assert.equal(calls, 4, 'a failure is not remembered');
  assert.deepEqual(await readdir(join(dataDir, 'cache/thumbs')), []);
  assert.deepEqual(await readdir(join(dataDir, 'cache/previews')), []);
  behave = writes;
  assert.equal(await readFile(await th.thumb('/m/a.jpg', 'a.jpg', st, 'photo'), 'utf8'), 'x', 'and then it works');
  // concurrent askers of a failing job all get the failure, and the job is not left in the way
  behave = async () => { await sleep(30); throw new Error('boom'); };
  const results = await Promise.allSettled([th.thumb('/m/b.jpg', 'b.jpg', st, 'photo'), th.thumb('/m/b.jpg', 'b.jpg', st, 'photo')]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 6, 'one job served both');
  behave = writes;
  assert.ok(await th.thumb('/m/b.jpg', 'b.jpg', st, 'photo'));
});
test('a path that is not absolute never reaches a tool', async () => {
  let calls = 0;
  const th = thumbsIn(await tempDir(), async () => { calls++; return ''; });
  const st = { size: 1, mtimeMs: 1 };
  for (const abs of ['-i', 'x.jpg', '../x.jpg', 'http://example.com/x.mp4']) {
    await assert.rejects(th.thumb(abs, 'x', st, 'video'), /absolute/, abs);
    await assert.rejects(th.preview(abs, 'x', st), /absolute/, abs);
  }
  assert.equal(calls, 0);
});
test('at most min(4, cores) tools run at once, and every job gets its turn', async () => {
  let running = 0, peak = 0, done = 0;
  const th = thumbsIn(await tempDir(), async (_cmd, args) => {
    running++; peak = Math.max(peak, running);
    await sleep(60);
    await writeFile(outOf(args), 'x');
    running--; done++;
    return '';
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => th.thumb(`/m/${i}.jpg`, `${i}.jpg`, { size: i, mtimeMs: 1 }, 'photo')));
  assert.equal(done, 12);
  assert.equal(peak, Math.min(4, availableParallelism()));
});

// A server of its own whose only route is `handle`, for calling sendFile as a later task will (the static files of the app). An HttpError is answered with its status.
async function miniServer(t: TestContext, handle: (ctx: Ctx) => Promise<void>): Promise<string> {
  const server = createServer((req, res) => {
    const ctx: Ctx = { req, res, url: new URL('http://localhost' + req.url), params: {}, ip: '', https: false, origin: '', user: null, token: null };
    handle(ctx).catch((err) => { res.statusCode = err instanceof HttpError ? err.status : 500; res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a renewed session cookie keeps a static file out of shared caches (R1)', async (t) => {
  const file = join(await tempDir(), 'app.js');
  await writeFile(file, 'console.log(1)');
  const base = await miniServer(t, async (ctx) => {
    if (ctx.url.pathname === '/renewed') ctx.res.setHeader('Set-Cookie', 'hg_session=x; Path=/; HttpOnly');
    const cache = ctx.url.pathname === '/revalidate' ? 'revalidate' : ctx.url.pathname === '/immutable' ? 'immutable' : 'static';
    await sendFile(ctx, file, { type: 'text/javascript', cache });
  });
  const cacheControl = async (path: string) => { const r = await fetch(base + path); await r.arrayBuffer(); return r.headers.get('cache-control'); };
  assert.equal(await cacheControl('/static'), 'public, max-age=31536000, immutable');
  assert.equal(await cacheControl('/renewed'), 'private, max-age=31536000, immutable');   // R1: same file and mode, but a live cookie rides along
  assert.equal(await cacheControl('/immutable'), 'private, max-age=31536000, immutable');
  assert.equal(await cacheControl('/revalidate'), 'private, no-cache');
});
test('sendFile sends regular files only', async (t) => {
  const dir = await tempDir();
  await writeFile(join(dir, 'f.txt'), 'hello');
  const base = await miniServer(t, (ctx) => sendFile(ctx, join(dir, ctx.url.pathname.slice(1)), { type: 'text/plain', cache: 'static' }));
  const r = await fetch(base + '/f.txt');
  assert.deepEqual([r.status, await r.text()], [200, 'hello']);
  assert.equal((await fetch(base + '/')).status, 404, 'a folder');
});

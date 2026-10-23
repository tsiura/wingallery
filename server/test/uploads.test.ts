import { after, before, mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { appendFile, chmod, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mutationQueue } from '../fsops.ts';
import { CHUNK_MAX, cleanupUploads } from '../uploads.ts';
import { fixture, seedTree, startTestApp } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

let ta: TestApp, admin: Client, editor: Client, papa: Client, jpg: Buffer;

const put = (c: Client, id: string, off: number, b: Buffer) => c.req('PUT', `/api/upload/${id}?offset=${off}`, b, { 'content-type': 'application/octet-stream' });
const startAs = (c: Client, body: unknown) => c.json('POST', '/api/upload/start', body);
const begin = async (dir: string, name: string, size = jpg.length): Promise<string> => {
  const r = await startAs(editor, { dir, name, size });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
};
const uploaded = async (dir: string, name: string, data = jpg) => (await put(editor, await begin(dir, name, data.length), 0, data)).json();
const row = (id: string) => ta.db.prepare('select * from uploads where id = ?').get(id) as any;
const openUploads = () => (ta.db.prepare('select count(*) as n from uploads').get() as { n: number }).n;
const exists = (rel: string) => stat(join(ta.media, rel)).then(() => true, () => false);
const temps = async (rel: string) => (await readdir(join(ta.media, rel))).filter((n) => n.startsWith('.upload-'));
const share = async (userId: number, alias: string, relPath: string, rights: string) => {
  const r = await admin.json('POST', `/api/admin/users/${userId}/shares`, { relPath, alias, create: rights.includes('c'), update: rights.includes('u'), delete: rights.includes('d') });
  assert.equal(r.status, 200);
};

// console.log from here on; the result gives the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  return () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
}

before(async () => {
  ta = await startTestApp({ maxUploadBytes: 1024 * 1024 });
  mock.method(console, 'log', () => {});   // the audit lines of the requests below; the tests that read them capture their own
  jpg = await readFile(fixture('exif-rot6.jpg'));
  await seedTree(ta.media, ['pics/family/a.jpg', 'pics/other/']);
  admin = await ta.admin();
  const [p, e] = [await ta.addUser('papa', 'member'), await ta.addUser('editor', 'member')];
  [papa, editor] = [p.client, e.client];
  await share(p.id, 'Fam', 'pics/family', '');
  await share(e.id, 'Fam', 'pics/family', 'cud'); await share(e.id, 'Other', 'pics/other', 'cud');
});
after(async () => { mock.restoreAll(); await ta.close(); });

test('chunked upload completes, no overwrite', async () => {
  const { body: { id } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'a.jpg', size: jpg.length });
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  assert.deepEqual(await temps('pics/family'), [`.upload-${id}`]);                                         // a partial file is there, and hidden
  assert.equal((await editor.json('GET', '/api/list?path=%2FFam')).body.entries.some((e: any) => e.name.startsWith('.upload-')), false);
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'a (1).jpg' });   // a.jpg already exists
  assert.deepEqual(await readFile(join(ta.media, 'pics/family/a (1).jpg')), jpg);
  assert.equal((await readdir(join(ta.media, 'pics/family'))).some((n) => n.startsWith('.upload-')), false);
  assert.equal(openUploads(), 0);
});
test('validation', async () => {
  const s = (body: object) => editor.json('POST', '/api/upload/start', body);
  assert.equal((await s({ dir: '/Fam', name: 'x.txt', size: 5 })).body.error, 'Only photos and videos can be uploaded');
  assert.equal((await s({ dir: '/Fam', name: 'x.jpg', size: 0 })).body.error, 'File is empty');
  assert.equal((await s({ dir: '/Fam', name: 'x.jpg', size: 2 * 1024 * 1024 })).body.error, 'File is larger than the 1 MB limit');   // test app maxUploadBytes = 1 MiB
  assert.equal((await papa.json('POST', '/api/upload/start', { dir: '/Fam', name: 'x.jpg', size: 5 })).status, 403);
  const { body: { id } } = await s({ dir: '/Fam', name: 'x.jpg', size: 8 });
  assert.equal((await put(editor, id, 4, Buffer.alloc(4))).status, 409);
  assert.equal((await put(papa, id, 0, Buffer.alloc(4))).status, 404);
  assert.equal((await (await put(editor, id, 0, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).json()).error, "File content doesn't match its type");
  const { body: { id: id2 } } = await s({ dir: '/Fam', name: '../..evil:name.jpg', size: 3 });
  const done = await (await put(editor, id2, 0, Buffer.from([0xff, 0xd8, 0xff]))).json();
  assert.ok(!done.name.includes('/') && !done.name.startsWith('.'));
});
test('two uploads of the same name (Review Focus 5)', async () => {
  const ids = await Promise.all([1, 2].map(async () => (await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'b.jpg', size: jpg.length })).body.id));
  const names = await Promise.all(ids.map(async (id) => (await (await put(editor, id, 0, jpg)).json()).name));
  assert.deepEqual(names.sort(), ['b (1).jpg', 'b.jpg']);
});
test('cancel and stale cleanup', async () => {
  const { body: { id } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'c.jpg', size: 10 });
  await editor.json('DELETE', `/api/upload/${id}`);
  const { body: { id: old } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'd.jpg', size: 10 });
  ta.db.prepare('update uploads set updated_at=? where id=?').run(Date.now() - 2 * 86_400_000, old);
  assert.equal(await cleanupUploads(ta.db), 1);
  assert.equal((await readdir(join(ta.media, 'pics/family'))).some((n) => n.startsWith('.upload-')), false);
});

test('uploads of one name never replace each other, whatever they hold, however many at once', async () => {
  const contents = [0, 1, 2, 3, 4].map((i) => Buffer.concat([jpg, Buffer.from(`-copy-${i}`)]));
  const names: string[] = (await Promise.all(contents.map((data) => uploaded('/Other', 'same.jpg', data)))).map((r) => r.name);
  assert.deepEqual([...names].sort(), ['same (1).jpg', 'same (2).jpg', 'same (3).jpg', 'same (4).jpg', 'same.jpg']);
  for (const [i, name] of names.entries()) assert.deepEqual(await readFile(join(ta.media, 'pics/other', name)), contents[i], name);
  assert.deepEqual(await temps('pics/other'), []);
});

test('every upload request needs a session (F15) and the right content type', async () => {
  const id = await begin('/Other', 'auth.jpg');
  const anon = ta.client();
  assert.deepEqual(await anon.json('POST', '/api/upload/start', { dir: '/Other', name: 'x.jpg', size: 5 }), { status: 401, body: { error: 'Sign in required' } });
  assert.equal((await put(anon, id, 0, jpg)).status, 401);
  assert.equal((await anon.json('DELETE', `/api/upload/${id}`)).status, 401);
  const asJson = await editor.req('PUT', `/api/upload/${id}?offset=0`, jpg, { 'content-type': 'application/json' });
  assert.deepEqual([asJson.status, await asJson.json()], [415, { error: 'Expected binary data' }]);
  const asText = await editor.req('POST', '/api/upload/start', '{}', { 'content-type': 'text/plain' });
  assert.deepEqual([asText.status, await asText.json()], [415, { error: 'Expected JSON' }]);
  assert.equal(row(id).received, 0);                                      // none of it touched the upload
  assert.deepEqual((await editor.json('DELETE', `/api/upload/${id}`)).body, { ok: true });
});

test('fields of the wrong type, and folders that are not there, get the pinned messages (G6, G8)', async () => {
  const before = openUploads();
  const raw = async (text: string) => { const r = await editor.req('POST', '/api/upload/start', text, { 'content-type': 'application/json' }); return [r.status, (await r.json()).error]; };
  const s = async (body: unknown) => { const r = await startAs(editor, body); return [r.status, r.body.error]; };
  const ok = { dir: '/Fam', name: 'x.jpg', size: 5 };
  assert.deepEqual(await s([]), [400, 'Invalid JSON']);
  assert.deepEqual(await raw('null'), [400, 'Invalid JSON']);
  assert.deepEqual(await s({ ...ok, dir: 5 }), [400, 'Invalid path']);
  assert.deepEqual(await s({ ...ok, name: ['x.jpg'] }), [415, 'Only photos and videos can be uploaded']);
  assert.deepEqual(await s({ ...ok, size: '5' }), [400, 'File is empty']);
  assert.deepEqual(await s({ ...ok, size: -3 }), [400, 'File is empty']);
  assert.deepEqual(await s({ ...ok, size: 1.5 }), [400, 'File is empty']);
  assert.deepEqual(await raw('{"dir":"/Fam","name":"x.jpg","size":1e999}'), [400, 'File is empty']);
  assert.deepEqual(await s({ ...ok, size: 1e30 }), [413, 'File is larger than the 1 MB limit']);
  assert.deepEqual(await s({ ...ok, dir: '/' }), [403, "You don't have permission to do that"]);          // a member's root has no disk path
  const root = await admin.json('POST', '/api/upload/start', { ...ok, dir: '/' });                         // and MEDIA_ROOT is read-only for everyone
  assert.deepEqual([root.status, root.body.error], [403, "You don't have permission to do that"]);
  assert.deepEqual(await s({ ...ok, dir: '/Fam/../Other' }), [400, 'Invalid path']);
  assert.deepEqual(await s({ ...ok, dir: '/Fam/.upload-x' }), [400, 'Invalid path']);
  assert.deepEqual(await s({ ...ok, dir: '/Fam/a.jpg' }), [404, 'Not found']);                             // a file is no folder
  assert.deepEqual(await s({ ...ok, dir: '/Nope' }), [404, 'Not found']);
  assert.equal(openUploads(), before);                                                                     // no refused start left a row behind
});

test('the chunk rules: out of sync, over the declared size, only the first chunk has its content checked (F6)', async () => {
  const id = await begin('/Other', 'rules.jpg', 8);
  const head = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);
  for (const off of ['4', '-1', 'abc', '1.5', '0x0', '', '99999999999999999999999']) {
    const r = await editor.req('PUT', `/api/upload/${id}?offset=${off}`, head, { 'content-type': 'application/octet-stream' });
    assert.deepEqual([r.status, await r.json()], [409, { error: 'Upload out of sync' }], `offset ${off}`);    // and no `received` in it
  }
  const noOffset = await editor.req('PUT', `/api/upload/${id}`, head, { 'content-type': 'application/octet-stream' });
  assert.deepEqual([noOffset.status, await noOffset.json()], [409, { error: 'Upload out of sync' }]);
  const tooMuch = await put(editor, id, 0, Buffer.concat([head, Buffer.alloc(1)]));
  assert.deepEqual([tooMuch.status, await tooMuch.json()], [400, { error: 'Upload is larger than declared' }]);
  assert.equal(row(id).received, 0);                                                                       // a refused chunk leaves the upload as it was
  assert.deepEqual(await (await put(editor, id, 0, head.subarray(0, 5))).json(), { received: 5 });
  assert.equal((await put(editor, id, 5, Buffer.alloc(4))).status, 400);                                   // 5 + 4 > 8
  assert.deepEqual(await (await put(editor, id, 5, Buffer.alloc(3))).json(), { done: true, name: 'rules.jpg' });   // no magic here: it is the first chunk's
});

test('a chunk over CHUNK_MAX is a 413 and the upload stays as it was; CHUNK_MAX itself is taken (F6)', async (t) => {
  const id = await begin('/Other', 'chunky.jpg');
  const tooBig = await put(editor, id, 0, Buffer.alloc(CHUNK_MAX + 1));
  assert.deepEqual([tooBig.status, await tooBig.json()], [413, { error: 'Chunk too large' }]);
  assert.equal(row(id).received, 0);
  assert.deepEqual(await (await put(editor, id, 0, jpg)).json(), { done: true, name: 'chunky.jpg' });   // and the same client goes on

  const cap = ta.cfg.maxUploadBytes;
  ta.cfg.maxUploadBytes = 2 * CHUNK_MAX; t.after(() => { ta.cfg.maxUploadBytes = cap; });
  const big = await begin('/Other', 'big.jpg', CHUNK_MAX + 3);
  const full = Buffer.alloc(CHUNK_MAX); jpg.copy(full);
  assert.deepEqual(await (await put(editor, big, 0, full)).json(), { received: CHUNK_MAX });
  assert.deepEqual(await (await put(editor, big, CHUNK_MAX, Buffer.alloc(3))).json(), { done: true, name: 'big.jpg' });
  assert.equal((await stat(join(ta.media, 'pics/other/big.jpg'))).size, CHUNK_MAX + 3);
});

test('an upload is its owner\'s alone: the id is a key, never a path (R1)', async () => {
  const id = await begin('/Fam', 'mine.jpg');
  await put(editor, id, 0, jpg.subarray(0, 100));
  const before = row(id);
  for (const other of [papa, admin]) {
    assert.deepEqual([(await put(other, id, 100, jpg.subarray(100))).status, (await other.json('DELETE', `/api/upload/${id}`)).status], [404, 404]);
  }
  assert.deepEqual(row(id), before);                                       // untouched by anyone else
  assert.deepEqual(await temps('pics/family'), [`.upload-${id}`]);
  for (const key of ['..%2F..%2Fx', '%2Fetc%2Fpasswd', 'x%00y', '0123456789abcdef0123456789abcdef', 'start']) {
    assert.deepEqual([(await put(editor, key, 0, jpg)).status, (await editor.json('DELETE', `/api/upload/${key}`)).status], [404, 404], key);
  }
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'mine.jpg' });
});

test('the temp path is built here from the folder and an id made here (R2); removing a user removes their temp files', async () => {
  const id = await begin('/Fam', '../../etc/passwd/x.jpg');
  const stored = row(id);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(stored.temp_abs, join(ta.media, 'pics/family', `.upload-${id}`));
  assert.equal(stored.dir_abs, join(ta.media, 'pics/family'));
  assert.ok(!stored.name.includes('/') && !stored.name.startsWith('.'), stored.name);
  assert.ok((await temps('pics/family')).includes(`.upload-${id}`));
  await editor.json('DELETE', `/api/upload/${id}`);

  const ghost = await ta.addUser('ghost', 'member');
  await share(ghost.id, 'Other', 'pics/other', 'c');
  const mine = (await startAs(ghost.client, { dir: '/Other', name: 'g.jpg', size: 5 })).body.id;
  assert.ok((await temps('pics/other')).includes(`.upload-${mine}`));
  assert.equal((await admin.json('DELETE', `/api/admin/users/${ghost.id}`)).status, 200);
  assert.equal((await temps('pics/other')).includes(`.upload-${mine}`), false);
  assert.equal(row(mine), undefined);
});

test('a chunk goes in at its offset, never appended, and the file is cut at the declared size (R3)', async () => {
  const id = await begin('/Other', 'crash.jpg');
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  // What a power cut can leave: more on the disk than the row says (the database runs with synchronous = NORMAL).
  await appendFile(row(id).temp_abs, Buffer.alloc(5000, 0xee));
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'crash.jpg' });
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/crash.jpg')), jpg);
});

test('two requests with the same chunk: one moves the upload on, the other is out of sync', async (t) => {
  const id = await begin('/Other', 'twice.jpg');
  const probe = await fsp.open(fixture('plain.png'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  // Both requests are let through the offset check before either of them writes, which is the order that matters here.
  const write = handles.write;
  let arrived = 0, openGate = () => {};
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const timer = setTimeout(openGate, 1000);                                // never a hang: the gate also opens by itself
  t.mock.method(handles, 'write', function (this: unknown, ...args: unknown[]) { if (++arrived === 2) openGate(); return gate.then(() => write.apply(this, args)); });
  const rs = await Promise.all([put(editor, id, 0, jpg.subarray(0, 100)), put(editor, id, 0, jpg.subarray(0, 50))]);
  clearTimeout(timer);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const { received } = await rs.find((r) => r.status === 200)!.json();
  assert.equal(row(id).received, received);                                // what the client was told is what the row says
  await editor.json('DELETE', `/api/upload/${id}`);
});

test('the temp file is never written through a symlink, and removing it removes the link only', async () => {
  const victim = join(ta.media, 'pics/other/victim.txt');
  await writeFile(victim, 'precious');
  const id = await begin('/Other', 'linked.jpg');
  const { temp_abs: temp } = row(id);
  await rm(temp); await symlink(victim, temp);
  assert.equal((await put(editor, id, 0, jpg)).status, 500);               // not a case a client can make: a fault of ours, and logged
  assert.equal(await readFile(victim, 'utf8'), 'precious');
  assert.equal((await editor.json('DELETE', `/api/upload/${id}`)).status, 200);
  assert.equal(await readFile(victim, 'utf8'), 'precious');
  assert.equal((await temps('pics/other')).includes(`.upload-${id}`), false);
});

test('an upload whose folder was renamed or deleted is a 404 and its row goes; the folder is not made again (R4)', async () => {
  await seedTree(ta.media, ['pics/other/r4/', 'pics/other/r4b/']);
  const id = await begin('/Other/r4', 'r4.jpg');
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  assert.equal((await editor.json('POST', '/api/rename', { path: '/Other/r4', name: 'r4-new' })).status, 200);   // the temp file goes along with its folder
  const gone = await put(editor, id, 100, jpg.subarray(100));
  assert.deepEqual([gone.status, await gone.json()], [404, { error: 'Not found' }]);
  assert.equal(row(id), undefined);
  assert.equal(await exists('pics/other/r4'), false);
  await rm(join(ta.media, 'pics/other/r4-new', `.upload-${id}`));         // what the rename took with it; nothing but the owner can find it

  const id2 = await begin('/Other/r4b', 'r4b.jpg');
  await put(editor, id2, 0, jpg.subarray(0, 100));
  assert.equal((await editor.json('POST', '/api/delete', { paths: ['/Other/r4b'] })).status, 200);
  const deleted = await put(editor, id2, 100, jpg.subarray(100));
  assert.deepEqual([deleted.status, await deleted.json()], [404, { error: 'Not found' }]);
  assert.equal(row(id2), undefined);
  assert.equal(await exists('pics/other/r4b'), false);
  assert.equal((await editor.json('DELETE', `/api/upload/${id2}`)).status, 404);
});

test('a finished upload drops the folder cache and is audited; the ones that do not finish are not (G9)', async (t) => {
  await seedTree(ta.media, ['pics/other/g9/sub/']);
  const count = async () => (await editor.json('GET', '/api/list?path=%2FOther%2Fg9')).body.entries.find((e: any) => e.name === 'sub').count;
  assert.equal(await count(), 0);                                          // cached for 30 s from here on
  const events = capture(t);
  await startAs(editor, { dir: '/Other/g9/sub', name: 'x.txt', size: 5 });                                  // refused
  const stopped = await begin('/Other/g9/sub', 'stopped.jpg');
  await editor.json('DELETE', `/api/upload/${stopped}`);                    // canceled
  const wrong = await begin('/Other/g9/sub', 'wrong.png');
  await put(editor, wrong, 0, jpg);                                         // wrong content
  assert.deepEqual(await uploaded('/Other/g9/sub', 'g9.jpg'), { done: true, name: 'g9.jpg' });
  assert.equal(await count(), 1);
  assert.deepEqual(events(), [{ event: 'upload', by: 'editor', path: 'pics/other/g9/sub/g9.jpg', size: jpg.length }]);
});

test('the last chunk waits in the mutation queue, and does not wait for itself (G10)', async () => {
  const id = await begin('/Other', 'queued.jpg');
  let release = () => {};
  const held = mutationQueue(() => new Promise<void>((resolve) => { release = resolve; }));
  try {
    const pending = put(editor, id, 0, jpg);
    assert.equal(await Promise.race([pending.then(() => 'done'), new Promise((resolve) => setTimeout(resolve, 300, 'waiting'))]), 'waiting');
    assert.equal(await exists('pics/other/queued.jpg'), false);
    release(); await held;
    assert.deepEqual(await (await pending).json(), { done: true, name: 'queued.jpg' });
  } finally {
    release();   // a failed assert must not leave the queue held for the tests after this one
  }
});

test('where the disk cannot hard-link, the file is copied, and still never over a name in use', async (t) => {
  const noLinks = t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  syncBuiltinESMExports();                                                  // the named import in uploads.ts follows the mock
  t.after(() => { noLinks.mock.restore(); syncBuiltinESMExports(); });
  const other = Buffer.concat([jpg, Buffer.from('other')]);
  assert.deepEqual(await uploaded('/Other', 'copy.jpg'), { done: true, name: 'copy.jpg' });
  assert.deepEqual(await uploaded('/Other', 'copy.jpg', other), { done: true, name: 'copy (1).jpg' });
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/copy.jpg')), jpg);
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/copy (1).jpg')), other);
  assert.ok(noLinks.mock.callCount() >= 3);
  assert.deepEqual(await temps('pics/other'), []);
});

test('a finish that failed leaves the upload whole, and an empty chunk at the end runs it again', async (t) => {
  const readOnly = t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); });
  syncBuiltinESMExports();
  t.after(() => { readOnly.mock.restore(); syncBuiltinESMExports(); });
  const id = await begin('/Other', 'retry.jpg');
  const failed = await put(editor, id, 0, jpg);
  assert.deepEqual([failed.status, await failed.json()], [409, { error: 'This folder is read-only on disk' }]);
  assert.equal(row(id).received, jpg.length);                                // all of it is in; only its name is missing
  assert.equal(await exists('pics/other/retry.jpg'), false);
  readOnly.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual(await (await put(editor, id, jpg.length, Buffer.alloc(0))).json(), { done: true, name: 'retry.jpg' });
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/retry.jpg')), jpg);
  assert.equal(row(id), undefined);
});

test('a full disk ends the upload: the temp file and the row go, and it is a 507', async (t) => {
  const probe = await fsp.open(fixture('plain.png'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const id = await begin('/Other', 'full.jpg');
  const noSpace = t.mock.method(handles, 'write', async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); });
  const r = await put(editor, id, 0, jpg);
  noSpace.mock.restore();
  assert.deepEqual([r.status, await r.json()], [507, { error: 'Disk is full' }]);
  assert.equal(row(id), undefined);
  assert.equal((await temps('pics/other')).includes(`.upload-${id}`), false);
});

test('a write that stops short is carried on, and one that makes no progress is a failure, not a hang', async (t) => {
  const probe = await fsp.open(fixture('plain.png'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const write = handles.write;
  const short = t.mock.method(handles, 'write', function (this: unknown, buf: Buffer, offset: number, length: number, position: number) {
    return write.call(this, buf, offset, Math.min(length, 7), position);          // never more than 7 bytes of what it was asked to write
  });
  assert.deepEqual(await uploaded('/Other', 'short.jpg'), { done: true, name: 'short.jpg' });
  const writes = short.mock.callCount();
  short.mock.restore();
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/short.jpg')), jpg);
  assert.equal(writes, Math.ceil(jpg.length / 7));                           // one write per 7 bytes, not one for the lot

  const id = await begin('/Other', 'stuck.jpg');
  const stuck = t.mock.method(handles, 'write', async (buf: Buffer) => ({ bytesWritten: 0, buffer: buf }));
  const r = await put(editor, id, 0, jpg);
  stuck.mock.restore();
  assert.equal(r.status, 500);
  assert.equal(stuck.mock.callCount(), 1);
  await editor.json('DELETE', `/api/upload/${id}`);
});

test('a folder that is read-only on disk is a 409, and leaves no row (Review Focus 3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await seedTree(ta.media, ['pics/other/ro/']);
  await chmod(join(ta.media, 'pics/other/ro'), 0o555); t.after(() => chmod(join(ta.media, 'pics/other/ro'), 0o755));
  const before = openUploads();
  assert.deepEqual(await startAs(editor, { dir: '/Other/ro', name: 'x.jpg', size: 5 }), { status: 409, body: { error: 'This folder is read-only on disk' } });
  assert.equal(openUploads(), before);
});

test('only stale uploads are swept, whether or not their temp file is still there', async () => {
  const fresh = await begin('/Other', 'fresh.jpg');
  assert.equal(await cleanupUploads(ta.db), 0);
  assert.deepEqual(await (await put(editor, fresh, 0, jpg)).json(), { done: true, name: 'fresh.jpg' });   // the sweep left it alone

  const [a, b] = [await begin('/Other', 'old-a.jpg'), await begin('/Other', 'old-b.jpg')];
  await rm(row(a).temp_abs);                                                // already gone: the row still goes
  assert.equal(await cleanupUploads(ta.db, Date.now() + 2 * 86_400_000), 2);
  assert.equal(await cleanupUploads(ta.db, Date.now() + 2 * 86_400_000), 0);
  assert.deepEqual([row(a), row(b)], [undefined, undefined]);
  assert.equal((await temps('pics/other')).length, 0);

  const edge = await begin('/Other', 'edge.jpg');
  ta.db.prepare('update uploads set updated_at = ? where id = ?').run(1_000, edge);
  assert.equal(await cleanupUploads(ta.db, 1_000 + 60_000, 60_000), 0);     // exactly that old: it stays until the next run
  assert.equal(await cleanupUploads(ta.db, 1_000 + 60_001, 60_000), 1);
});

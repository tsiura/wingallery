import { after, before, mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { appendFile, chmod, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
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
const share = async (userId: number, alias: string, relPath: string, rights: string): Promise<number> => {
  const r = await admin.json('POST', `/api/admin/users/${userId}/shares`, { relPath, alias, create: rights.includes('c'), update: rights.includes('u'), delete: rights.includes('d') });
  assert.equal(r.status, 200);
  return r.body.id;
};

// console.log from here on; the result gives the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  return () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
}

// The class behind every handle that fs.promises.open gives out, so that a test can make its writes fail or watch them.
async function fileHandles() {
  const probe = await fsp.open(fixture('plain.png'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  return handles;
}

// A chunk request made by hand. fetch can't declare a length it does not send, or stop with a body half way, and a test of what the server does before
// it reads a body, or while it reads one, needs both. The test ends `req` (or destroys it); `response` is the answer once there is one.
function rawPut(id: string, offset: number, declared: number, who: Client = editor) {
  const req = request(`${ta.url}/api/upload/${id}?offset=${offset}`, {
    method: 'PUT', agent: false,
    // keep-alive is asked for, so that a `close` in the answer is the server's doing and not the client's
    headers: { cookie: who.cookie!, origin: ta.url, connection: 'keep-alive', 'content-type': 'application/octet-stream', 'content-length': String(declared) },
  });
  const response = new Promise<{ status: number; connection: string | undefined; body: any }>((resolve, reject) => {
    const giveUp = setTimeout(() => req.destroy(new Error('no answer: the server is waiting for the body')), 5000).unref();   // a failure must not be a hang
    req.on('error', reject);
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (part) => { text += part; }).on('end', () => {
        clearTimeout(giveUp);
        resolve({ status: res.statusCode!, connection: res.headers.connection, body: JSON.parse(text) });
      });
    });
  });
  response.catch(() => {});   // a request the test destroys is not an unhandled rejection
  return { req, response };
}

// Chunk requests made by hand, one at a time, each with the server's view of it: `atServer` is the request as the server has it, once its handler has gone
// as far as it can without waiting for something (into the limiter's queue, or into the body). The server's own 'request' listener comes first, so
// that is where things stand when the one here runs. A request still open when the test ends is destroyed, so that it can't hold a slot for the tests after.
function byHand(t: TestContext) {
  const open: ReturnType<typeof rawPut>[] = [];
  const waiting: ((req: IncomingMessage) => void)[] = [];
  const tap = (req: IncomingMessage) => { if (req.method === 'PUT') waiting.shift()?.(req); };
  ta.app.server.on('request', tap);
  t.after(() => { ta.app.server.off('request', tap); for (const sent of open) sent.req.destroy(); });
  return async (id: string, offset: number, declared: number, body: Buffer, complete: boolean) => {
    const arrived = new Promise<IncomingMessage>((resolve) => { waiting.push(resolve); });
    const sent = rawPut(id, offset, declared);
    open.push(sent);
    if (complete) sent.req.end(body); else sent.req.write(body);
    return { ...sent, atServer: await arrived };
  };
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

test('a wrong owner or a wrong offset is refused before a byte of the body is read, whatever length the body declares', async () => {
  const id = await begin('/Other', 'early.jpg');
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  const declared = 100 * 1024 ** 3;                                        // 100 GiB, of which not one byte is ever sent
  for (const [who, key, offset, status, error] of [
    [papa, id, 100, 404, 'Not found'],                                      // somebody else's upload
    [admin, id, 100, 404, 'Not found'],
    [editor, 'no-such-upload', 0, 404, 'Not found'],
    [editor, id, 0, 409, 'Upload out of sync'],                             // not where the last chunk ended
    [editor, id, 101, 409, 'Upload out of sync'],
  ] as const) {
    const sent = rawPut(key, offset, declared, who);
    sent.req.flushHeaders();
    // An answer, though there is no body to read; and the connection closes with it, so that the 100 GiB is not read after it either.
    assert.deepEqual(await sent.response, { status, connection: 'close', body: { error } }, `${key} at ${offset}`);
    sent.req.destroy();
  }
  assert.equal(row(id).received, 100);                                      // none of it touched the upload
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'early.jpg' });
});

test('at most 4 chunk bodies are read at once, whoever sends them; the others wait unread', async (t) => {
  const send = byHand(t);
  const ids = await Promise.all([0, 1, 2, 3, 4].map((i) => begin('/Other', `slot${i}.jpg`)));
  // Four chunks under way: the head of each body is in and the rest is not, so each holds a slot.
  const holders = [];
  for (const id of ids.slice(0, 4)) holders.push(await send(id, 0, jpg.length, jpg.subarray(0, 100), false));
  // A fifth, with all of its body ready. It gets as far as the limiter and not a byte further.
  const fifth = await send(ids[4], 0, jpg.length, jpg, true);
  assert.equal(fifth.atServer.readableDidRead, false);
  for (let turn = 0; turn < 25; turn++) await new Promise((resolve) => setImmediate(resolve));   // time for anything that would read it to do so
  assert.equal(fifth.atServer.readableDidRead, false);
  // One of the four is done, and its slot goes to the fifth.
  holders[0].req.end(jpg.subarray(100));
  assert.equal((await holders[0].response).status, 200);
  assert.deepEqual((await fifth.response).body, { done: true, name: 'slot4.jpg' });
  assert.equal(fifth.atServer.readableDidRead, true);
  for (const holder of holders.slice(1)) {
    holder.req.end(jpg.subarray(100));
    assert.equal((await holder.response).status, 200);
  }
});

test('a chunk that waited for a slot is checked again when it gets one: a duplicate neither clobbers nor ends an upload that moved on', async (t) => {
  const send = byHand(t);
  const ids = await Promise.all([0, 1, 2, 3, 4].map((i) => begin('/Other', `dup${i}.jpg`)));
  const holders = [];
  for (const id of ids.slice(0, 4)) holders.push(await send(id, 0, jpg.length, jpg.subarray(0, 100), false));
  // Two chunks for the same place in the fifth upload. Both pass the check at the door, as nothing is in yet, and wait in turn: the real one first,
  // then one whose head is not a JPEG's, which would end the upload if it were taken for a first chunk.
  const first = await send(ids[4], 0, 100, jpg.subarray(0, 100), true);
  const second = await send(ids[4], 0, 100, Buffer.alloc(100, 0xee), true);
  holders[0].req.end(jpg.subarray(100));
  assert.equal((await holders[0].response).status, 200);
  assert.deepEqual((await first.response).body, { received: 100 });
  const { status, body } = await second.response;
  assert.deepEqual({ status, body }, { status: 409, body: { error: 'Upload out of sync' } });          // from the second look: it was refused after its body was read
  assert.equal(row(ids[4]).received, 100);                                  // it is still there, and
  assert.deepEqual((await readFile(row(ids[4]).temp_abs)).subarray(0, 100), jpg.subarray(0, 100));   // is still the real chunk's
  assert.deepEqual(await (await put(editor, ids[4], 100, jpg.subarray(100))).json(), { done: true, name: 'dup4.jpg' });
  for (const holder of holders.slice(1)) {
    holder.req.end(jpg.subarray(100));
    assert.equal((await holder.response).status, 200);
  }
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
  const handles = await fileHandles();
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

test('where the disk cannot hard-link, the whole file is renamed to the first free name, never over a name in use', async (t) => {
  const handles = await fileHandles();
  const syncs = t.mock.method(handles, 'sync');                            // only watched
  const noLinks = t.mock.method(fsp, 'link', async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  const copied = t.mock.method(fsp, 'copyFile');                           // only watched: nothing is copied any more
  const rename = fsp.rename;
  const seen: { temp: number; nameFree: boolean; synced: number }[] = [];
  const renamed = t.mock.method(fsp, 'rename', async (from: string, to: string) => {
    seen.push({ temp: (await stat(from)).size, nameFree: await stat(to).then(() => false, () => true), synced: syncs.mock.callCount() });
    return rename(from, to);
  });
  syncBuiltinESMExports();                                                  // the named imports in uploads.ts follow the mocks
  t.after(() => { for (const m of [syncs, noLinks, copied, renamed]) m.mock.restore(); syncBuiltinESMExports(); });
  await writeFile(join(ta.media, 'pics/other/ren.jpg'), 'not ours');         // there already
  const other = Buffer.concat([jpg, Buffer.from('other')]);
  assert.deepEqual(await uploaded('/Other', 'ren.jpg'), { done: true, name: 'ren (1).jpg' });
  assert.deepEqual(await uploaded('/Other', 'ren.jpg', other), { done: true, name: 'ren (2).jpg' });
  assert.equal(await readFile(join(ta.media, 'pics/other/ren.jpg'), 'utf8'), 'not ours');
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/ren (1).jpg')), jpg);
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/ren (2).jpg')), other);
  // When it is renamed the file is whole and synced, and the name it goes to is free: it is never seen half written, and nothing is replaced.
  assert.deepEqual(seen, [{ temp: jpg.length, nameFree: true, synced: 1 }, { temp: other.length, nameFree: true, synced: 2 }]);
  assert.equal(copied.mock.callCount(), 0);
  assert.deepEqual(await temps('pics/other'), []);
});

test('the file is synced once, after the cut at the declared size and before it gets its name (a power cut must not leave it short)', async (t) => {
  const handles = await fileHandles();
  const order: string[] = [];
  const watch = (object: any, method: string, label: string) => {
    const original = object[method];
    return t.mock.method(object, method, function (this: unknown, ...args: unknown[]) { order.push(label); return original.apply(this, args); });
  };
  const mocks = [watch(handles, 'truncate', 'cut'), watch(handles, 'sync', 'sync'), watch(fsp, 'link', 'link')];
  syncBuiltinESMExports();
  t.after(() => { for (const m of mocks) m.mock.restore(); syncBuiltinESMExports(); });
  const id = await begin('/Other', 'durable.jpg');
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  assert.deepEqual(order, []);                                              // not for a chunk that leaves the file short of its size
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'durable.jpg' });
  assert.deepEqual(order, ['cut', 'sync', 'link']);
});

test('a sync that fails fails the chunk: the file does not get its name, and the same chunk can be sent again', async (t) => {
  const handles = await fileHandles();
  const id = await begin('/Other', 'unsynced.jpg');
  const broken = t.mock.method(handles, 'sync', async () => { throw Object.assign(new Error('input/output error'), { code: 'EIO' }); });
  const failed = await put(editor, id, 0, jpg);
  broken.mock.restore();
  assert.equal(failed.status, 500);                                         // not "done": the bytes may not be on the disk
  assert.equal(await exists('pics/other/unsynced.jpg'), false);
  assert.equal(row(id).received, 0);
  assert.deepEqual(await (await put(editor, id, 0, jpg)).json(), { done: true, name: 'unsynced.jpg' });
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
  const handles = await fileHandles();
  const id = await begin('/Other', 'full.jpg');
  const noSpace = t.mock.method(handles, 'write', async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); });
  const r = await put(editor, id, 0, jpg);
  noSpace.mock.restore();
  assert.deepEqual([r.status, await r.json()], [507, { error: 'Disk is full' }]);
  assert.equal(row(id), undefined);
  assert.equal((await temps('pics/other')).includes(`.upload-${id}`), false);
});

test('a write that stops short is carried on, and one that makes no progress is a failure, not a hang', async (t) => {
  const handles = await fileHandles();
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

// An upload of `c` with its first 100 bytes in, so that its temp file is there.
const partial = async (c: Client, dir: string, name: string): Promise<string> => {
  const r = await startAs(c, { dir, name, size: jpg.length });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await (await put(c, r.body.id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  return r.body.id;
};
// The rest of an upload that the administrator ended: refused as an upload that is not there, and in the folder `rel` there is nothing, neither its temp
// file nor the file it would have become.
const refusedRest = async (c: Client, id: string, rel: string, offset = 100) => {
  const r = await put(c, id, offset, jpg.subarray(offset));
  assert.deepEqual([r.status, await r.json()], [404, { error: 'Not found' }], id);
  assert.equal(row(id), undefined, 'the row is gone');
  assert.deepEqual(await readdir(join(ta.media, rel)), [], 'nothing in the folder');
};
const patchShare = (id: number, body: object) => admin.json('PATCH', `/api/admin/shares/${id}`, body);

test('taking Create away from a share ends every upload its user had started: the next chunk is a 404, the temp file goes, no file lands (spec 4.2)', async () => {
  await seedTree(ta.media, ['pics/rights/', 'pics/keep/', 'pics/look/']);
  const sam = await ta.addUser('sam', 'member');
  const [rights, keep, look] = [await share(sam.id, 'Rights', 'pics/rights', 'cud'), await share(sam.id, 'Keep', 'pics/keep', 'cud'), await share(sam.id, 'Look', 'pics/look', 'ud')];
  const [a, b, theirs] = [await partial(sam.client, '/Rights', 'a.jpg'), await partial(sam.client, '/Keep', 'b.jpg'), await partial(editor, '/Fam', 'theirs.jpg')];
  // changes that take no Create away end nothing: another right, another name, Create ticked again
  assert.equal((await patchShare(keep, { alias: 'Keep2', update: false, create: true })).status, 200);
  assert.equal((await patchShare(look, { delete: false })).status, 200);
  assert.deepEqual(await (await put(sam.client, b, 100, jpg.subarray(100, 200))).json(), { received: 200 });
  // Create unticked: all of sam's uploads end, also the one into the other share (an upload does not record the share it started under) ...
  assert.equal((await patchShare(rights, { create: false })).body.create, false);
  await refusedRest(sam.client, a, 'pics/rights');
  await refusedRest(sam.client, b, 'pics/keep', 200);
  // ... and nobody else's: the editor's upload carries on to its end
  assert.deepEqual(await (await put(editor, theirs, 100, jpg.subarray(100))).json(), { done: true, name: 'theirs.jpg' });
  // A share that has no Create to take away takes no upload with it, and sam can start again where he still may
  const c = await partial(sam.client, '/Keep2', 'c.jpg');
  assert.equal((await patchShare(rights, { delete: false })).status, 200);                  // Create stays off
  assert.equal((await admin.json('DELETE', `/api/admin/shares/${look}`)).status, 200);      // a share without Create goes
  assert.deepEqual(await (await put(sam.client, c, 100, jpg.subarray(100))).json(), { done: true, name: 'c.jpg' });
  assert.equal((await startAs(sam.client, { dir: '/Rights', name: 'd.jpg', size: 5 })).status, 403);   // and what Create was taken from stays refused
});

test('removing a share that allowed Create ends every upload its user had started, in the same way', async () => {
  await seedTree(ta.media, ['pics/rm-a/', 'pics/rm-b/']);
  const lou = await ta.addUser('lou', 'member');
  const a = await share(lou.id, 'A', 'pics/rm-a', 'cud');
  await share(lou.id, 'B', 'pics/rm-b', 'c');
  const [x, y] = [await partial(lou.client, '/A', 'x.jpg'), await partial(lou.client, '/B', 'y.jpg')];
  assert.deepEqual(await admin.json('DELETE', `/api/admin/shares/${a}`), { status: 200, body: { ok: true } });
  await refusedRest(lou.client, x, 'pics/rm-a');
  await refusedRest(lou.client, y, 'pics/rm-b');
});

test('a temp file that cannot be removed does not fail the share change: the answer is 200, the upload is over, the file is logged with its path', { skip: process.getuid?.() === 0 }, async (t) => {
  const events = capture(t);
  await seedTree(ta.media, ['pics/stuck/']);
  const kim = await ta.addUser('kim', 'member');
  const stuck = await share(kim.id, 'Stuck', 'pics/stuck', 'c');
  const id = await partial(kim.client, '/Stuck', 's.jpg');
  const dir = join(ta.media, 'pics/stuck');
  await chmod(dir, 0o555); t.after(() => chmod(dir, 0o755));            // a file in a folder that can't be written can't be unlinked, as on a read-only mount
  const changed = await patchShare(stuck, { create: false });
  assert.deepEqual([changed.status, changed.body.create], [200, false]);
  assert.equal(row(id), undefined);                                      // the upload is over whatever happens to its file
  assert.deepEqual(await temps('pics/stuck'), [`.upload-${id}`]);        // which stays, and which the owner is told about:
  const all = events();
  assert.equal(all.filter((e) => e.event === 'share_updated').length, 1);   // the audit line is written as ever
  const errors = all.filter((e) => e.event === 'error').map((e) => String(e.message));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.ok(errors[0].includes(join(dir, `.upload-${id}`)) && errors[0].includes(`user ${kim.id}`), errors[0]);
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

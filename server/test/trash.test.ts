import { after, before, mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mutationQueue } from '../fsops.ts';
import { purgeExpired } from '../trash.ts';
import { seedTree, startTestApp } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

const NOT_FOUND = { status: 404, body: { error: 'Not found' } };
const INVALID_PATH = { error: 'Invalid path' };
const READ_ONLY = { status: 409, body: { error: 'This folder is read-only on disk' } };
const ADMINS_ONLY = { status: 403, body: { error: 'Administrators only' } };
const DAY = 86_400_000;

let ta: TestApp, admin: Client, papa: Client, editor: Client, mama: Client, mamaId: number;

const del = (c: Client, ...paths: string[]) => c.json('POST', '/api/delete', { paths });
const preview = (c: Client, ...paths: string[]) => c.json('POST', '/api/delete/preview', { paths });
const bin = async (): Promise<any[]> => (await admin.json('GET', '/api/admin/trash')).body.items;
const inBin = async (name: string) => (await bin()).find((i) => i.name === name);
const restore = (id: string) => admin.json('POST', `/api/admin/trash/${id}/restore`);
const exists = (rel: string) => stat(join(ta.media, rel)).then(() => true, () => false);
const clearBin = async () => assert.equal((await admin.json('DELETE', '/api/admin/trash')).status, 200);
const list = (c: Client, path: string) => c.json('GET', '/api/list?path=' + encodeURIComponent(path));

// console.log from here on; the result gives the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  return () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
}

// Holds the mutation queue, starts the request, shows it has not got anywhere (and what is still untouched), then lets go and gives its answer.
async function whileQueueHeld<T extends { status: number }>(request: () => Promise<T>, untouched: () => Promise<void>): Promise<T> {
  let release = () => {};
  const held = mutationQueue(() => new Promise<void>((resolve) => { release = resolve; }));
  try {
    const pending = request();
    assert.equal(await Promise.race([pending.then(() => 'done'), new Promise((resolve) => setTimeout(resolve, 200, 'waiting'))]), 'waiting');
    await untouched();
    release(); await held;
    return await pending;
  } finally {
    release();   // a failed assert must not leave the queue held for the tests after this one
  }
}

// The bytes of every regular file below `dir`, worked out here and not by the code under test.
async function treeSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) total += (await stat(join(e.parentPath, e.name))).size;
  return total;
}

before(async () => {
  ta = await startTestApp();
  mock.method(console, 'log', () => {});   // the audit lines of the requests below; the tests that read them capture their own
  await seedTree(ta.media, ['pics/family/a.jpg', 'pics/family/b.jpg', 'pics/family/c.jpg', 'pics/family/xmas/x.jpg',
    'pics/family/mixed/x.jpg', 'pics/family/mixed/y.jpg', 'pics/family/mixed/notes.txt', 'pics/family/mixed/.DS_Store', 'pics/other/', 'docs/trip/']);
  admin = await ta.admin();
  const [p, e, m] = [await ta.addUser('papa', 'member'), await ta.addUser('editor', 'member'), await ta.addUser('mama', 'member')];
  [papa, editor, mama, mamaId] = [p.client, e.client, m.client, m.id];
  const share = async (id: number, alias: string, relPath: string, rights: string) => {
    const r = await admin.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias, create: rights.includes('c'), update: rights.includes('u'), delete: rights.includes('d') });
    assert.equal(r.status, 200);
  };
  await share(p.id, 'Fam', 'pics/family', '');
  await share(e.id, 'Fam', 'pics/family', 'cud'); await share(e.id, 'Other', 'pics/other', 'cud'); await share(e.id, 'Docs', 'docs', 'cud');
  await share(m.id, 'Xmas', 'pics/family/xmas', '');
});
after(async () => { mock.restoreAll(); await ta.close(); });

test('delete moves into the top-level trash and records it', async () => {
  assert.deepEqual((await editor.json('POST', '/api/delete', { paths: ['/Fam/a.jpg'] })).body, { deleted: 1 });
  const listed = (await admin.json('GET', '/api/admin/trash')).body;
  assert.equal(listed.trashDays, ta.cfg.trashDays);                  // F16: the list carries the retention too
  const [row] = listed.items;
  assert.deepEqual([row.name, row.originalPath, row.isDir, row.deletedBy], ['a.jpg', join(ta.media, 'pics/family/a.jpg'), false, 'editor']);
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.ok(await stat(join(ta.media, 'pics', '.gallery-trash', row.id, 'a.jpg')));
  assert.equal((await editor.json('GET', '/api/list?path=' + encodeURIComponent('/Fam'))).body.entries.some((e: any) => e.name === 'a.jpg'), false);
});
test('rights, protection, preview counts', async () => {
  assert.equal((await papa.json('POST', '/api/delete', { paths: ['/Fam/b.jpg'] })).status, 403);
  assert.equal((await editor.json('POST', '/api/delete', { paths: ['/Fam'] })).status, 403);
  assert.deepEqual((await editor.json('POST', '/api/delete/preview', { paths: ['/Fam/mixed'] })).body, { items: 1, hiddenFiles: 2 });   // mixed/{x.jpg,y.jpg,notes.txt,.DS_Store}
  assert.equal((await papa.json('GET', '/api/admin/trash')).status, 403);
  assert.equal((await admin.json('GET', '/api/list?path=' + encodeURIComponent('/pics/.gallery-trash'))).status, 400);
});
test('restore: name clash, missing parent, share comes back', async () => {
  await editor.json('POST', '/api/delete', { paths: ['/Fam/xmas'] });                       // Mama's share root
  assert.equal((await admin.json('GET', `/api/admin/users/${mamaId}/shares`)).body[0].available, false);
  const items = (await admin.json('GET', '/api/admin/trash')).body.items as any[];
  await admin.json('POST', `/api/admin/trash/${items.find((i) => i.name === 'xmas').id}/restore`);
  assert.equal((await admin.json('GET', `/api/admin/users/${mamaId}/shares`)).body[0].available, true);
  await writeFile(join(ta.media, 'pics/family/a.jpg'), 'new');
  const r = await admin.json('POST', `/api/admin/trash/${items.find((i) => i.name === 'a.jpg').id}/restore`);
  assert.equal(r.body.restoredAs, join(ta.media, 'pics/family/a (restored).jpg'));

  // F12.2: the parent folder really is gone from the disk when the file comes back
  await seedTree(ta.media, ['pics/family/gone/deep/f.jpg']);
  await editor.json('POST', '/api/delete', { paths: ['/Fam/gone/deep/f.jpg'] });
  await rm(join(ta.media, 'pics/family/gone'), { recursive: true });
  assert.equal(await exists('pics/family/gone'), false);
  const back = await admin.json('POST', `/api/admin/trash/${(await bin()).find((i) => i.name === 'f.jpg').id}/restore`);
  assert.equal(back.body.restoredAs, join(ta.media, 'pics/family/gone/deep/f.jpg'));
  assert.ok((await stat(join(ta.media, 'pics/family/gone/deep/f.jpg'))).isFile());
});
test('purge, empty, expiry', async () => {
  await editor.json('POST', '/api/delete', { paths: ['/Fam/b.jpg', '/Fam/c.jpg'] });
  const [x, y] = (await admin.json('GET', '/api/admin/trash')).body.items as any[];
  ta.db.prepare('update trash set deleted_at=? where id=?').run(Date.now() - 31 * 86_400_000, x.id);
  assert.equal(await purgeExpired(ta.cfg, ta.db, 30), 1);
  await assert.rejects(stat(join(ta.media, 'pics', '.gallery-trash', x.id)));
  assert.ok(await stat(join(ta.media, 'pics', '.gallery-trash', y.id)));                    // the younger one stays
  await admin.json('DELETE', '/api/admin/trash');
  await assert.rejects(stat(join(ta.media, 'pics', '.gallery-trash', y.id)));
  assert.deepEqual((await admin.json('GET', '/api/admin/trash')).body.items, []);
});

test('an id names a row of the bin and nothing else (R1)', async () => {
  await seedTree(ta.media, ['x/keep.jpg', 'pics/other/r1/r1.jpg']);          // what a path built from the id would hit: <media>/pics/.gallery-trash/../../x
  await del(editor, '/Other/r1/r1.jpg');
  const before = await bin();
  for (const id of ['..%2F..%2Fx', '..%2F..%2Fx%2Fkeep.jpg', '0123456789abcdef', 'x%00y']) {
    assert.deepEqual(await admin.json('POST', `/api/admin/trash/${id}/restore`), NOT_FOUND, `restore ${id}`);
    assert.deepEqual(await admin.json('DELETE', `/api/admin/trash/${id}`), NOT_FOUND, `purge ${id}`);
  }
  assert.ok(await exists('x/keep.jpg'));
  assert.deepEqual(await bin(), before);
  assert.ok(await exists('pics/.gallery-trash/' + before.find((i) => i.name === 'r1.jpg').id + '/r1.jpg'));
});

test('delete, restore and purge are audited; delete and restore drop the folder cache (G9)', async (t) => {
  await seedTree(ta.media, ['pics/other/au/au-a.jpg', 'pics/other/au/sub/au-b.jpg']);
  const sub = async () => (await list(editor, '/Other/au')).body.entries.find((e: any) => e.name === 'sub').count;
  assert.equal(await sub(), 1);                                              // cached for 30 s from here on
  const events = capture(t);

  await del(editor, '/Other/au/sub/au-b.jpg');
  assert.equal(await sub(), 0);
  const b = await inBin('au-b.jpg');
  await restore(b.id);
  assert.equal(await sub(), 1);
  await del(editor, '/Other/au/au-a.jpg');
  const a = await inBin('au-a.jpg');
  await admin.json('DELETE', `/api/admin/trash/${a.id}`);
  await del(papa, '/Fam/b.jpg');                                             // refused: it changes nothing and is not audited

  assert.deepEqual(events(), [
    { event: 'delete', by: 'editor', id: b.id, path: 'pics/other/au/sub/au-b.jpg' },
    { event: 'restore', by: 'root', id: b.id, path: 'pics/other/au/sub/au-b.jpg' },
    { event: 'delete', by: 'editor', id: a.id, path: 'pics/other/au/au-a.jpg' },
    { event: 'purge', by: 'root', id: a.id, path: 'pics/other/au/au-a.jpg' },
  ]);
});

test('each top-level folder has its own bin, and the bin is never listed, counted or reachable', async () => {
  await seedTree(ta.media, ['pics/other/nb/nb.jpg', 'docs/trip/trip.jpg']);
  const count = async () => (await list(admin, '/pics')).body.entries.find((e: any) => e.name === 'other').count;
  const before = await count();
  assert.deepEqual((await del(editor, '/Other/nb/nb.jpg', '/Docs/trip/trip.jpg')).body, { deleted: 2 });
  const [nb, trip] = [await inBin('nb.jpg'), await inBin('trip.jpg')];
  assert.ok(await exists(`pics/.gallery-trash/${nb.id}/nb.jpg`));
  assert.ok(await exists(`docs/.gallery-trash/${trip.id}/trip.jpg`));
  assert.equal(await count(), before - 1);                                   // what is in the bin is not counted

  for (const path of ['/pics', '/pics/other', '/docs']) assert.ok(!(await list(admin, path)).body.entries.some((e: any) => e.name === '.gallery-trash'), path);
  assert.ok(!(await admin.json('GET', '/api/folders?path=%2Fpics')).body.some((f: any) => f.name === '.gallery-trash'));
  assert.ok(!(await admin.json('GET', '/api/admin/browse?path=pics')).body.folders.includes('.gallery-trash'));
  const files = (await admin.json('GET', '/api/files?path=%2Fpics')).body.items.map((i: any) => i.path);     // the recursive list, as the slideshow reads it
  assert.ok(files.length > 0 && !files.some((p: string) => p.includes('.gallery-trash') || p.endsWith('/nb/nb.jpg')));
  for (const path of ['/pics/.gallery-trash', `/pics/.gallery-trash/${nb.id}`, `/pics/.gallery-trash/${nb.id}/nb.jpg`, '/docs/.gallery-trash'])
    assert.deepEqual(await list(admin, path), { status: 400, body: INVALID_PATH }, path);
  assert.deepEqual(await list(editor, '/Other/.gallery-trash'), { status: 400, body: INVALID_PATH });
});

test('the administrator deletes below a top-level folder, never a top-level folder', async () => {
  await seedTree(ta.media, ['pics/other/ad/adm.jpg']);
  assert.deepEqual((await del(admin, '/pics/other/ad/adm.jpg')).body, { deleted: 1 });
  const row = await inBin('adm.jpg');
  assert.equal(row.deletedBy, 'root');
  assert.ok(await exists(`pics/.gallery-trash/${row.id}/adm.jpg`));
  assert.equal((await del(admin, '/pics')).body.error, "This folder can't be renamed, moved or deleted");
  assert.deepEqual((await del(admin, '/')).body, { error: "You don't have permission to do that" });
  assert.ok(await exists('pics'));
});

test('only what the gallery shows can be deleted, and only by a name it can resolve', async () => {
  await seedTree(ta.media, ['pics/other/rf/f.jpg', 'pics/other/rf/notes.txt', 'pics/other/rf/real/inner.jpg'], [['real', 'pics/other/rf/lnk'], ['f.jpg', 'pics/other/rf/lnk.jpg']]);
  const before = await bin();
  for (const path of ['/Other/rf/notes.txt', '/Other/rf/lnk', '/Other/rf/lnk.jpg', '/Other/rf/missing.jpg', '/Other/rf/f.jpg/x', '/Nowhere/f.jpg', '/Xmas/x.jpg'])
    assert.deepEqual([await del(editor, path), await preview(editor, path)], [NOT_FOUND, NOT_FOUND], path);
  for (const path of ['/Other/rf/.gallery-trash', '/Other/rf/real/../f.jpg', '/Other/rf/', 'Other/rf/f.jpg', '', '/Other/rf/a\\b.jpg'])
    assert.deepEqual([(await del(editor, path)).body, (await preview(editor, path)).body], [INVALID_PATH, INVALID_PATH], path);
  assert.equal((await del(mama, '/Xmas/x.jpg')).status, 403);                // she has no right to delete
  assert.deepEqual(await bin(), before);
  for (const rel of ['f.jpg', 'notes.txt', 'lnk', 'lnk.jpg', 'real/inner.jpg']) assert.ok(await exists('pics/other/rf/' + rel), rel);
});

test('a selection is refused as a whole before anything moves; after that it goes item by item', async () => {
  await seedTree(ta.media, ['pics/other/sel/sel1.jpg', 'pics/other/sel/sel2.jpg', 'pics/other/sel/seldir/p.jpg']);
  assert.deepEqual(await del(editor, '/Other/sel/sel1.jpg', '/Other/sel/missing.jpg'), NOT_FOUND);
  assert.deepEqual((await del(editor, '/Other/sel/sel1.jpg', '/Other')).body, { error: "This folder can't be renamed, moved or deleted" });
  assert.ok(await exists('pics/other/sel/sel1.jpg'));
  assert.deepEqual(await del(editor, '/Other/sel/sel1.jpg', '/Other/sel/sel2.jpg', '/Other/sel/seldir'), { status: 200, body: { deleted: 3 } });
  for (const name of ['sel1.jpg', 'sel2.jpg', 'seldir']) assert.ok(await inBin(name), name);
  assert.deepEqual(await readdir(join(ta.media, 'pics/other/sel')), []);
});

test('requests need a session and a JSON object with a list of strings (G6)', async () => {
  for (const route of ['delete', 'delete/preview'])
    assert.deepEqual(await ta.client().json('POST', '/api/' + route, { paths: [] }), { status: 401, body: { error: 'Sign in required' } }, route);
  const bad = (route: string, body: unknown) => editor.json('POST', '/api/' + route, body).then((r) => [r.status, r.body.error]);
  for (const route of ['delete', 'delete/preview']) {
    assert.deepEqual(await bad(route, { paths: '/Fam/mixed' }), [400, 'Invalid JSON'], route);
    assert.deepEqual(await bad(route, {}), [400, 'Invalid JSON'], route);
    assert.deepEqual(await bad(route, ['/Fam/mixed']), [400, 'Invalid JSON'], route);
    assert.deepEqual(await bad(route, { paths: [5] }), [400, 'Invalid path'], route);
    assert.deepEqual(await bad(route, { paths: [null] }), [400, 'Invalid path'], route);
    assert.deepEqual(await bad(route, { paths: [{ a: 1 }] }), [400, 'Invalid path'], route);
    const text = await editor.req('POST', '/api/' + route, JSON.stringify({ paths: [] }), { 'content-type': 'text/plain' });
    assert.deepEqual([text.status, await text.json()], [415, { error: 'Expected JSON' }], route);
    assert.equal((await editor.req('POST', '/api/' + route, { paths: [] }, { origin: 'https://evil.example' })).status, 403, route);
    assert.equal((await editor.req('GET', '/api/' + route)).status, 405, route);
  }
  assert.deepEqual(await del(editor), { status: 200, body: { deleted: 0 } });
  assert.deepEqual(await preview(editor), { status: 200, body: { items: 0, hiddenFiles: 0 } });
  assert.ok(await exists('pics/family/mixed/x.jpg'));
});

test('the bin is the administrator’s alone', async () => {
  await seedTree(ta.media, ['pics/other/ao/ao.jpg']);
  await del(editor, '/Other/ao/ao.jpg');
  const row = await inBin('ao.jpg');
  const routes = [['GET', '/api/admin/trash'], ['POST', `/api/admin/trash/${row.id}/restore`], ['DELETE', `/api/admin/trash/${row.id}`], ['DELETE', '/api/admin/trash']];
  for (const [who, c] of [['papa', papa], ['editor', editor], ['mama', mama]] as const)
    for (const [method, path] of routes) assert.deepEqual(await c.json(method, path), ADMINS_ONLY, `${who} ${method} ${path}`);
  for (const [method, path] of routes) assert.deepEqual(await ta.client().json(method, path), { status: 401, body: { error: 'Sign in required' } }, `${method} ${path}`);
  assert.ok(await exists(`pics/.gallery-trash/${row.id}/ao.jpg`));
  assert.ok(await inBin('ao.jpg'));
});

test('the preview and the row count every regular file the gallery hides, at any depth, and add up all sizes (G5)', async () => {
  await seedTree(ta.media, [
    'pics/other/hf/shown.jpg', 'pics/other/hf/up.JPG', 'pics/other/hf/sub/b.png',                                      // shown
    'pics/other/hf/sub/Thumbs.db', 'pics/other/hf/sub/.cache/c.jpg', 'pics/other/hf/@eaDir/d.jpg', 'pics/other/hf/doc.pdf',   // not shown
  ], [['shown.jpg', 'pics/other/hf/lnk.jpg'], ['sub', 'pics/other/hf/lnkdir']]);                                       // never followed, never counted
  const size = await treeSize(join(ta.media, 'pics/other/hf'));
  assert.deepEqual((await preview(editor, '/Other/hf')).body, { items: 1, hiddenFiles: 4 });
  assert.deepEqual((await preview(editor, '/Other/hf', '/Other/hf/shown.jpg')).body, { items: 2, hiddenFiles: 4 });
  assert.deepEqual((await preview(editor, '/Other/hf/shown.jpg')).body, { items: 1, hiddenFiles: 0 });
  assert.ok(await exists('pics/other/hf/doc.pdf'));                                                                 // a preview moves nothing

  await del(editor, '/Other/hf');
  const row = await inBin('hf');
  assert.deepEqual([row.isDir, row.hiddenFiles, row.size], [true, 4, size]);
  assert.equal(await treeSize(join(ta.media, 'pics/.gallery-trash', row.id, 'hf')), size);      // all of it went, hidden files too
  assert.ok(await exists(`pics/.gallery-trash/${row.id}/hf/doc.pdf`));
  assert.ok((await readdir(join(ta.media, 'pics/.gallery-trash', row.id, 'hf'))).includes('lnk.jpg'));   // and the links, as links

  await seedTree(ta.media, ['pics/other/hg/hg1.jpg']);
  const bytes = (await stat(join(ta.media, 'pics/other/hg/hg1.jpg'))).size;
  await del(editor, '/Other/hg/hg1.jpg');
  const file = await inBin('hg1.jpg');
  assert.deepEqual([file.isDir, file.hiddenFiles, file.size], [false, 0, bytes]);
});

test('restore: a taken name gets "(restored)", then "(restored 2)"; a folder too; asking twice is a 404', async () => {
  await seedTree(ta.media, ['pics/other/cl/cl1.jpg', 'pics/other/cl/cldir/p.jpg']);
  const original = await readFile(join(ta.media, 'pics/other/cl/cl1.jpg'));
  await del(editor, '/Other/cl/cl1.jpg', '/Other/cl/cldir');
  const [one, dir] = [await inBin('cl1.jpg'), await inBin('cldir')];
  assert.equal(dir.isDir, true);
  await writeFile(join(ta.media, 'pics/other/cl/cl1.jpg'), 'new');
  await writeFile(join(ta.media, 'pics/other/cl/cl1 (restored).jpg'), 'newer');
  await mkdir(join(ta.media, 'pics/other/cl/cldir'));

  assert.deepEqual(await restore(one.id), { status: 200, body: { restoredAs: join(ta.media, 'pics/other/cl/cl1 (restored 2).jpg') } });
  assert.deepEqual(await restore(dir.id), { status: 200, body: { restoredAs: join(ta.media, 'pics/other/cl/cldir (restored)') } });
  assert.deepEqual(await readFile(join(ta.media, 'pics/other/cl/cl1 (restored 2).jpg')), original);
  assert.deepEqual([await readFile(join(ta.media, 'pics/other/cl/cl1.jpg'), 'utf8'), await readFile(join(ta.media, 'pics/other/cl/cl1 (restored).jpg'), 'utf8')], ['new', 'newer']);
  assert.ok(await exists('pics/other/cl/cldir (restored)/p.jpg'));
  assert.deepEqual(await readdir(join(ta.media, 'pics/other/cl/cldir')), []);
  assert.deepEqual(await restore(one.id), NOT_FOUND);
  for (const id of [one.id, dir.id]) assert.equal(await exists('pics/.gallery-trash/' + id), false);   // the bin folder goes with the row
  assert.deepEqual((await bin()).filter((i) => [one.id, dir.id].includes(i.id)), []);
});

test('non-ASCII names round-trip through delete, the bin and restore (Review Focus 1)', async () => {
  await seedTree(ta.media, ['pics/other/uni/Дача #2 (2024)/IMG 50%.jpg']);
  const path = join(ta.media, 'pics/other/uni/Дача #2 (2024)/IMG 50%.jpg');
  assert.deepEqual((await del(editor, '/Other/uni/Дача #2 (2024)/IMG 50%.jpg')).body, { deleted: 1 });
  const row = await inBin('IMG 50%.jpg');
  assert.equal(row.originalPath, path);
  assert.deepEqual((await del(editor, '/Other/uni/Дача #2 (2024)')).body, { deleted: 1 });
  const folder = await inBin('Дача #2 (2024)');
  assert.deepEqual((await restore(folder.id)).body, { restoredAs: join(ta.media, 'pics/other/uni/Дача #2 (2024)') });
  assert.deepEqual((await restore(row.id)).body, { restoredAs: path });
  assert.ok((await stat(path)).isFile());
});

test('delete, restore and purge wait in the mutation queue (G10)', async () => {
  await seedTree(ta.media, ['pics/other/qu/q1.jpg', 'pics/other/qu/q2.jpg']);
  let r = await whileQueueHeld(() => del(editor, '/Other/qu/q1.jpg'), async () => assert.equal(await exists('pics/other/qu/q1.jpg'), true));
  assert.equal(r.status, 200);
  assert.equal(await exists('pics/other/qu/q1.jpg'), false);
  const row = await inBin('q1.jpg');
  r = await whileQueueHeld(() => restore(row.id), async () => assert.equal(await exists('pics/other/qu/q1.jpg'), false));
  assert.equal(r.status, 200);
  assert.equal(await exists('pics/other/qu/q1.jpg'), true);
  await del(editor, '/Other/qu/q2.jpg');
  const two = await inBin('q2.jpg');
  r = await whileQueueHeld(() => admin.json('DELETE', `/api/admin/trash/${two.id}`), async () => assert.ok(await exists('pics/.gallery-trash/' + two.id)));
  assert.equal(r.status, 200);
  assert.equal(await exists('pics/.gallery-trash/' + two.id), false);
});

test('two restores into one name at the same time: one gets the name, the other "(restored)", nothing is overwritten', async () => {
  const pairs = Array.from({ length: 10 }, (_, i) => i);
  await seedTree(ta.media, pairs.map((i) => `pics/other/cr/n${i}.jpg`));
  for (const i of pairs) {
    const file = join(ta.media, `pics/other/cr/n${i}.jpg`), renamed = join(ta.media, `pics/other/cr/n${i} (restored).jpg`);
    await writeFile(file, 'ONE'); await del(editor, `/Other/cr/n${i}.jpg`);
    await writeFile(file, 'TWO'); await del(editor, `/Other/cr/n${i}.jpg`);
    const ids = (await bin()).filter((r) => r.name === `n${i}.jpg`).map((r) => r.id);
    assert.equal(ids.length, 2, `pair ${i}`);
    assert.deepEqual((await Promise.all(ids.map(restore))).map((r) => r.status), [200, 200], `pair ${i}`);
    assert.deepEqual((await Promise.all([file, renamed].map((f) => readFile(f, 'utf8')))).sort(), ['ONE', 'TWO'], `pair ${i}`);
  }
});

test('an item that has left the bin on disk cannot be restored, but its row can be purged', async () => {
  await seedTree(ta.media, ['pics/other/vn/v.jpg']);
  await del(editor, '/Other/vn/v.jpg');
  const row = await inBin('v.jpg');
  await rm(join(ta.media, 'pics/.gallery-trash', row.id), { recursive: true });
  await rm(join(ta.media, 'pics/other/vn'), { recursive: true });
  assert.deepEqual(await restore(row.id), NOT_FOUND);
  assert.equal(await exists('pics/other/vn'), false);                       // no parent is made for an item that isn't there
  assert.ok(await inBin('v.jpg'));                                          // the row stays, for the administrator to purge
  assert.deepEqual((await admin.json('DELETE', `/api/admin/trash/${row.id}`)).body, { ok: true });
  assert.equal(await inBin('v.jpg'), undefined);
  assert.deepEqual(await admin.json('DELETE', `/api/admin/trash/${row.id}`), NOT_FOUND);
});

test('the bin lists the newest first, and items deleted at the same moment by id', async () => {
  await clearBin();
  const put = ta.db.prepare("insert into trash (id, top_rel, original_rel, is_dir, size, hidden_files, deleted_by, deleted_at) values (?, 'pics', ?, ?, ?, ?, 'someone', ?)");
  put.run('bb', 'pics/z/old.jpg', 0, 1, 0, 1000); put.run('ab', 'pics/z/same.jpg', 0, 2, 0, 3000); put.run('aa', 'pics/z/new', 1, 7, 3, 3000);
  const items = await bin();
  assert.deepEqual(items.map((i) => i.id), ['aa', 'ab', 'bb']);
  assert.deepEqual(items[0], { id: 'aa', name: 'new', originalPath: join(ta.media, 'pics/z/new'), isDir: true, size: 7, hiddenFiles: 3, deletedBy: 'someone', deletedAt: 3000 });
  ta.db.exec('delete from trash');
});

test('expiry is by age: older than TRASH_DAYS goes, the rest stays; the audit line names no user', async (t) => {
  await clearBin();
  await seedTree(ta.media, ['pics/other/ex/e1.jpg', 'pics/other/ex/e2.jpg']);
  await del(editor, '/Other/ex/e1.jpg', '/Other/ex/e2.jpg');
  const [e1, e2] = [await inBin('e1.jpg'), await inBin('e2.jpg')];
  const T = 1_000_000;
  ta.db.prepare('update trash set deleted_at = ? where id = ?').run(T, e1.id);
  ta.db.prepare('update trash set deleted_at = ? where id = ?').run(T + 1, e2.id);
  const events = capture(t);

  assert.equal(await purgeExpired(ta.cfg, ta.db, 30, T + 30 * DAY), 0);                         // exactly 30 days old is not older than 30 days
  assert.equal(await purgeExpired(ta.cfg, ta.db, 30, T + 30 * DAY + 1), 1);
  assert.deepEqual((await bin()).map((i) => i.id), [e2.id]);
  assert.equal(await exists('pics/.gallery-trash/' + e1.id), false);
  assert.ok(await exists('pics/.gallery-trash/' + e2.id));
  assert.deepEqual(events(), [{ event: 'purge', id: e1.id, path: 'pics/other/ex/e1.jpg' }]);
  assert.equal(await purgeExpired(ta.cfg, ta.db, 7, T + 30 * DAY + 2), 1);                       // a shorter retention
  assert.deepEqual(await bin(), []);
  assert.equal(await purgeExpired(ta.cfg, ta.db, 30), 0);                                        // an empty bin
});

test('a folder inside that the server may not read does not stop a delete or its preview', { skip: process.getuid?.() === 0 }, async (t) => {
  await seedTree(ta.media, ['pics/other/ur/ur1.jpg', 'pics/other/ur/locked/ur2.jpg']);
  const bytes = (await stat(join(ta.media, 'pics/other/ur/ur1.jpg'))).size;
  let locked = join(ta.media, 'pics/other/ur/locked');
  await chmod(locked, 0o000); t.after(() => chmod(locked, 0o755));                               // wherever it is by then: the bin can't purge it locked
  assert.deepEqual((await preview(editor, '/Other/ur')).body, { items: 1, hiddenFiles: 0 });      // what can't be read counts as empty
  assert.deepEqual((await del(editor, '/Other/ur')).body, { deleted: 1 });
  const row = await inBin('ur');
  locked = join(ta.media, 'pics/.gallery-trash', row.id, 'ur/locked');
  assert.deepEqual([row.isDir, row.size, row.hiddenFiles], [true, bytes, 0]);
  assert.equal(await exists('pics/other/ur'), false);
});

test('a folder that is read-only on disk: 409, and nothing is left behind', { skip: process.getuid?.() === 0 }, async (t) => {
  await seedTree(ta.media, ['pics/other/ro/ro-f.jpg', 'pics/other/ro/ro-g.jpg']);
  await del(editor, '/Other/ro/ro-g.jpg');                                                       // while it can still be written
  const folder = join(ta.media, 'pics/other/ro');
  const state = async () => [await bin(), await readdir(join(ta.media, 'pics/.gallery-trash'))];
  const before = await state();
  await chmod(folder, 0o555); t.after(() => chmod(folder, 0o755).catch(() => {}));
  assert.deepEqual(await del(editor, '/Other/ro/ro-f.jpg'), READ_ONLY);
  assert.deepEqual(await state(), before);                                                       // no row, no folder in the bin
  assert.ok(await exists('pics/other/ro/ro-f.jpg'));
  assert.deepEqual(await restore((await inBin('ro-g.jpg')).id), READ_ONLY);                     // ... and no way back into it
  assert.ok(await inBin('ro-g.jpg'));
  assert.equal(await exists('pics/other/ro/ro-g.jpg'), false);

  // a top-level folder that can't hold a bin of its own: the bin folder is what fails, before anything moves
  await seedTree(ta.media, ['rotop/ro-h.jpg']);
  const editorId = (ta.db.prepare("select id from users where username = 'editor'").get() as { id: number }).id;
  ta.db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, 1, 1, 1)').run(editorId, 'RoTop', 'rotop');
  await chmod(join(ta.media, 'rotop'), 0o555); t.after(() => chmod(join(ta.media, 'rotop'), 0o755).catch(() => {}));
  assert.deepEqual(await del(editor, '/RoTop/ro-h.jpg'), READ_ONLY);
  assert.deepEqual(await readdir(join(ta.media, 'rotop')), ['ro-h.jpg']);                       // not even an empty .gallery-trash
  assert.equal(await inBin('ro-h.jpg'), undefined);
});

test('an item that cannot be purged does not keep the others in the bin', { skip: process.getuid?.() === 0 }, async (t) => {
  await clearBin();
  await seedTree(ta.media, ['pics/other/pf/pf1.jpg', 'docs/trip/pf2.jpg']);
  await del(editor, '/Other/pf/pf1.jpg'); await del(editor, '/Docs/trip/pf2.jpg');
  const [one, two] = [await inBin('pf1.jpg'), await inBin('pf2.jpg')];
  const stuck = join(ta.media, 'pics/.gallery-trash', one.id);
  await chmod(stuck, 0o555); t.after(() => chmod(stuck, 0o755).catch(() => {}));
  const later = Date.now() + 31 * DAY;
  await assert.rejects(purgeExpired(ta.cfg, ta.db, 30, later), { status: 409, message: 'This folder is read-only on disk' });
  assert.deepEqual((await bin()).map((i) => i.id), [one.id]);
  assert.equal(await exists('docs/.gallery-trash/' + two.id), false);
  assert.deepEqual(await admin.json('DELETE', '/api/admin/trash'), READ_ONLY);                  // the same for "Empty"
  await chmod(stuck, 0o755);
  assert.equal(await purgeExpired(ta.cfg, ta.db, 30, later), 1);
  assert.deepEqual(await bin(), []);
});

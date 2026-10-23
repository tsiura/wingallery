import { after, before, mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fsops from '../fsops.ts';
import { HttpError } from '../http.ts';
import { seedTree, startTestApp } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

const NOT_FOUND = { status: 404, body: { error: 'Not found' } };
const EXISTS = { status: 409, body: { error: 'A file or folder with that name already exists' } };
const SAME_SHARE = { status: 400, body: { error: 'Items can only be moved within the same shared folder' } };
const INTO_ITSELF = { status: 400, body: { error: "Can't move a folder into itself" } };
const READ_ONLY = { status: 409, body: { error: 'This folder is read-only on disk' } };

let ta: TestApp, admin: Client, papa: Client, editor: Client, mama: Client, mamaId: number, papaId: number;

const post = (c: Client, route: string, body: unknown) => c.json('POST', `/api/${route}`, body);
const exists = (rel: string) => stat(join(ta.media, rel)).then(() => true, () => false);
// Shares that no folder-picking request could make: with no rights, Mama's unless another user is named, and possibly of a folder that is not there.
const addShare = (alias: string, relPath: string, userId = mamaId) =>
  ta.db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, 0, 0, 0)').run(userId, alias, relPath);
const shareOf = (alias: string) => ta.db.prepare('select rel_path from shares where alias = ?').get(alias)?.rel_path;

// console.log from here on; the result gives the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  return () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
}

before(async () => {
  ta = await startTestApp();
  mock.method(console, 'log', () => {});   // the audit lines of the requests below; the one test that reads them captures its own
  await seedTree(ta.media, ['pics/family/a.jpg', 'pics/family/c.jpg', 'pics/family/d.jpg', 'pics/family/xmas/sub/', 'pics/other/', 'pics/ro/']);
  admin = await ta.admin();
  const [p, e, m] = [await ta.addUser('papa', 'member'), await ta.addUser('editor', 'member'), await ta.addUser('mama', 'member')];
  [papa, editor, mama, mamaId, papaId] = [p.client, e.client, m.client, m.id, p.id];
  const share = async (id: number, alias: string, relPath: string, rights: string) => {
    const r = await admin.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias, create: rights.includes('c'), update: rights.includes('u'), delete: rights.includes('d') });
    assert.equal(r.status, 200);
  };
  await share(p.id, 'Fam', 'pics/family', 'c'); await share(p.id, 'RO', 'pics/ro', '');
  await share(e.id, 'Fam', 'pics/family', 'cud'); await share(e.id, 'Other', 'pics/other', 'cud');
  await share(m.id, 'Xmas', 'pics/family/xmas', '');
});
after(async () => { mock.restoreAll(); await ta.close(); });

test('mkdir rights and validation', async () => {
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'New' })).status, 200);
  assert.ok((await stat(join(ta.media, 'pics/family/New'))).isDirectory());
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'New' })).body.error, 'A file or folder with that name already exists');
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'a:b' })).status, 400);
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/RO', name: 'x' })).body.error, "You don't have permission to do that");
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/', name: 'x' })).status, 403);
  assert.equal((await admin.json('POST', '/api/mkdir', { path: '/', name: 'x' })).status, 403);
});
test('rename keeps extension, protects roots, rewrites shares', async () => {
  assert.deepEqual((await editor.json('POST', '/api/rename', { path: '/Fam/a.jpg', name: 'b.JPG' })).body, { name: 'b.JPG' });
  assert.equal((await editor.json('POST', '/api/rename', { path: '/Fam/b.JPG', name: 'b.png' })).body.error, "File extension can't be changed");
  assert.equal((await editor.json('POST', '/api/rename', { path: '/Fam', name: 'X' })).body.error, "This folder can't be renamed, moved or deleted");
  assert.equal((await admin.json('POST', '/api/rename', { path: '/pics', name: 'P' })).status, 403);
  await editor.json('POST', '/api/rename', { path: '/Fam/xmas', name: 'Christmas' });     // 'xmas' is Mama's share root
  assert.equal(ta.db.prepare('select rel_path from shares where alias=?').get('Xmas')!.rel_path, 'pics/family/Christmas');
});
test('move rules', async () => {
  assert.deepEqual((await editor.json('POST', '/api/move', { paths: ['/Fam/c.jpg'], to: '/Fam/Christmas' })).body, { moved: 1 });
  assert.equal((await editor.json('POST', '/api/move', { paths: ['/Fam/Christmas'], to: '/Fam/Christmas/sub' })).body.error, "Can't move a folder into itself");
  assert.equal((await editor.json('POST', '/api/move', { paths: ['/Fam/d.jpg'], to: '/Other' })).body.error, 'Items can only be moved within the same shared folder');
  assert.equal((await papa.json('POST', '/api/move', { paths: ['/Fam/d.jpg'], to: '/Fam/Christmas' })).status, 403);
});
test('read-only on disk (Review Focus 3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await chmod(join(ta.media, 'pics/family'), 0o555); t.after(() => chmod(join(ta.media, 'pics/family'), 0o755));
  assert.deepEqual(await editor.json('POST', '/api/mkdir', { path: '/Fam', name: 'Nope' }), { status: 409, body: { error: 'This folder is read-only on disk' } });
});

test('requests need a session, a JSON object, and fields of the right types (G6)', async () => {
  await seedTree(ta.media, ['pics/other/types/f.jpg']);
  for (const [route, body] of [['mkdir', { path: '/Other', name: 'x' }], ['rename', { path: '/Other/types/f.jpg', name: 'g.jpg' }], ['move', { paths: ['/Other/types/f.jpg'], to: '/Other' }]] as const)
    assert.deepEqual(await post(ta.client(), route, body), { status: 401, body: { error: 'Sign in required' } }, route);
  const text = await editor.req('POST', '/api/mkdir', JSON.stringify({ path: '/Other', name: 'x' }), { 'content-type': 'text/plain' });
  assert.deepEqual([text.status, await text.json()], [415, { error: 'Expected JSON' }]);
  const foreign = await editor.req('POST', '/api/mkdir', { path: '/Other', name: 'x' }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);

  const bad = (route: string, body: unknown) => post(editor, route, body).then((r) => [r.status, r.body.error]);
  assert.deepEqual(await bad('mkdir', { path: 5, name: 'x' }), [400, 'Invalid path']);
  assert.deepEqual(await bad('mkdir', { path: '/Other', name: 5 }), [400, "Name can't be empty"]);
  assert.deepEqual(await bad('mkdir', { path: '/Other' }), [400, "Name can't be empty"]);
  assert.deepEqual(await bad('mkdir', ['/Other']), [400, 'Invalid JSON']);
  assert.deepEqual(await bad('rename', { path: null, name: 'x' }), [400, 'Invalid path']);
  assert.deepEqual(await bad('rename', { path: '/Other/types/f.jpg', name: { a: 1 } }), [400, "Name can't be empty"]);
  assert.deepEqual(await bad('move', { paths: '/Other/types/f.jpg', to: '/Other' }), [400, 'Invalid JSON']);
  assert.deepEqual(await bad('move', { paths: [5], to: '/Other' }), [400, 'Invalid path']);
  assert.deepEqual(await bad('move', { paths: ['/Other/types/f.jpg'], to: 5 }), [400, 'Invalid path']);
  assert.deepEqual(await post(editor, 'move', { paths: [], to: '/Other' }), { status: 200, body: { moved: 0 } });
  assert.ok(await exists('pics/other/types/f.jpg'));
  assert.deepEqual(await readdir(join(ta.media, 'pics/other/types')), ['f.jpg']);
});

test('mkdir: names are validated, the parent must be a folder, Unicode names round-trip (Review Focus 1)', async () => {
  await seedTree(ta.media, ['pics/other/mk/f.jpg']);
  const mk = (path: string, name: string) => post(editor, 'mkdir', { path, name });
  const dacha = 'Дача #2 (2024)';
  assert.deepEqual(await mk('/Other/mk', dacha), { status: 200, body: { name: dacha } });
  assert.ok((await readdir(join(ta.media, 'pics/other/mk'))).includes(dacha));
  assert.ok((await editor.json('GET', '/api/list?path=' + encodeURIComponent('/Other/mk'))).body.entries.some((e: any) => e.name === dacha));
  assert.equal((await mk('/Other/mk/' + dacha, 'inner')).status, 200);
  assert.deepEqual(await mk('/Other/mk', 'f.jpg'), EXISTS);                      // a file has that name
  assert.deepEqual(await mk('/Other/missing', 'x'), NOT_FOUND);
  assert.deepEqual(await mk('/Other/mk/f.jpg', 'x'), NOT_FOUND);                 // a file is no place for a folder
  assert.deepEqual((await mk('/Other/mk/..', 'x')).body, { error: 'Invalid path' });
  assert.deepEqual((await mk('/Other/.gallery-trash', 'x')).body, { error: 'Invalid path' });
  assert.deepEqual((await mk('/Other/mk', '@eaDir')).body, { error: 'That name is reserved' });
  assert.deepEqual((await mk('/Other/mk', '.hidden')).body, { error: "Name can't start or end with a space or a dot" });
  assert.deepEqual((await mk('/Other/mk', 'x'.repeat(201))).body, { error: 'Name is too long' });
  assert.deepEqual((await readdir(join(ta.media, 'pics/other/mk'))).sort(), ['f.jpg', dacha]);
});

test('rename: the name must be free, only what the listings show can be renamed, never a symlink (R2)', async () => {
  await seedTree(ta.media, ['pics/other/rn/a.jpg', 'pics/other/rn/b.jpg', 'pics/other/rn/notes.txt', 'pics/other/rn/dir/', 'pics/other/rn/t/'],
    [['t', 'pics/other/rn/lnk'], ['a.jpg', 'pics/other/rn/lnk.jpg']]);                 // a link to a folder, and one to a file
  const rn = (name: string, to: string) => post(editor, 'rename', { path: '/Other/rn/' + name, name: to });
  assert.deepEqual(await rn('a.jpg', 'b.jpg'), EXISTS);
  assert.deepEqual(await rn('a.jpg', 'a.jpg'), EXISTS);                              // its own name is taken too
  assert.deepEqual(await rn('dir', 't'), EXISTS);
  assert.deepEqual(await rn('notes.txt', 'n.txt'), NOT_FOUND);
  assert.deepEqual(await rn('lnk', 'moved'), NOT_FOUND);
  assert.deepEqual(await rn('lnk.jpg', 'moved.jpg'), NOT_FOUND);
  assert.deepEqual(await rn('missing.jpg', 'x.jpg'), NOT_FOUND);
  assert.equal((await rn('.hidden', 'x')).body.error, 'Invalid path');
  assert.equal((await rn('a.jpg', 'noext')).body.error, "File extension can't be changed");
  assert.equal((await rn('a.jpg', 'a:b.jpg')).status, 400);
  assert.deepEqual((await readdir(join(ta.media, 'pics/other/rn'))).sort(), ['a.jpg', 'b.jpg', 'dir', 'lnk', 'lnk.jpg', 'notes.txt', 't']);
  assert.deepEqual(await rn('dir', 'dir.jpg'), { status: 200, body: { name: 'dir.jpg' } });   // a folder has no extension to keep
  assert.equal((await rn('b.jpg', 'Б.JPEG')).body.error, "File extension can't be changed");  // .jpeg is not .jpg
  assert.equal((await rn('b.jpg', 'Б 50%.JPG')).status, 200);
  await seedTree(ta.media, ['pics/ro/r.jpg']);
  assert.deepEqual(await post(papa, 'rename', { path: '/RO/r.jpg', name: 'x.jpg' }), { status: 403, body: { error: "You don't have permission to do that" } });
  assert.ok(await exists('pics/ro/r.jpg'));
});

test('a folder takes the shares inside it along; a clash with another share is a 409 that touches nothing (R3)', async () => {
  await seedTree(ta.media, ['pics/other/sh/src/deep/p.jpg', 'pics/other/sh/box/']);
  addShare('Top', 'pics/other/sh/src'); addShare('Deep', 'pics/other/sh/src/deep');
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/sh/src', name: 'dst' }), { status: 200, body: { name: 'dst' } });
  assert.deepEqual([shareOf('Top'), shareOf('Deep')], ['pics/other/sh/dst', 'pics/other/sh/dst/deep']);
  assert.deepEqual((await mama.json('GET', '/api/list?path=%2FDeep')).body.entries.map((e: any) => e.name), ['p.jpg']);   // the share still works

  addShare('Live', 'pics/other/sh/box'); addShare('Stale', 'pics/other/sh/gone');       // the folder of Stale is not there
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/sh/box', name: 'gone' }), EXISTS);
  assert.deepEqual([await exists('pics/other/sh/box'), await exists('pics/other/sh/gone')], [true, false]);
  assert.deepEqual([shareOf('Live'), shareOf('Stale')], ['pics/other/sh/box', 'pics/other/sh/gone']);
  assert.deepEqual(await post(editor, 'move', { paths: ['/Other/sh/box'], to: '/Other/sh/dst' }), { status: 200, body: { moved: 1 } });
  assert.equal(shareOf('Live'), 'pics/other/sh/dst/box');

  // all or none: the first share could move, the second would land on a share of the same user, so neither moves
  await seedTree(ta.media, ['pics/other/sh/two/a/', 'pics/other/sh/two/b/']);
  addShare('FirstOfTwo', 'pics/other/sh/two/a'); addShare('SecondOfTwo', 'pics/other/sh/two/b'); addShare('Taken', 'pics/other/sh/three/b');
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/sh/two', name: 'three' }), EXISTS);
  assert.deepEqual([shareOf('FirstOfTwo'), shareOf('SecondOfTwo')], ['pics/other/sh/two/a', 'pics/other/sh/two/b']);
});
test('a rename that fails on disk puts back exactly the shares it moved; shares of missing folders stay where they are (R3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await seedTree(ta.media, ['pics/other/rv/ro/src/p.jpg']);
  addShare('Rev', 'pics/other/rv/ro/src');
  // Papa's shares of folders that are not there: at the name the rename would give, below it, and at the name the move would give.
  // They are no part of what moves, so putting things back must not touch them (it would hand Papa the folder that stays).
  addShare('GoneAt', 'pics/other/rv/ro/dst', papaId); addShare('GoneBelow', 'pics/other/rv/ro/dst/deeper', papaId); addShare('GoneMove', 'pics/other/rv/src', papaId);
  await chmod(join(ta.media, 'pics/other/rv/ro'), 0o555); t.after(() => chmod(join(ta.media, 'pics/other/rv/ro'), 0o755));
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/rv/ro/src', name: 'dst' }), READ_ONLY);
  assert.deepEqual(await post(editor, 'move', { paths: ['/Other/rv/ro/src'], to: '/Other/rv' }), READ_ONLY);
  assert.deepEqual([shareOf('Rev'), shareOf('GoneAt'), shareOf('GoneBelow'), shareOf('GoneMove')],
    ['pics/other/rv/ro/src', 'pics/other/rv/ro/dst', 'pics/other/rv/ro/dst/deeper', 'pics/other/rv/src']);
  assert.deepEqual((await mama.json('GET', '/api/list?path=%2FRev')).body.entries.map((e: any) => e.name), ['p.jpg']);
});
test('shares of folders that are not there are never rewritten', async () => {
  await seedTree(ta.media, ['pics/other/uv/src/p.jpg', 'pics/other/uv/src/live/q.jpg']);
  addShare('LiveUv', 'pics/other/uv/src'); addShare('LiveInside', 'pics/other/uv/src/live');
  // Papa's: of folders beside the one that moves, at the name it gets, and below it (in the bin, say: restoring the folder is what brings these back)
  addShare('StaleSibling', 'pics/other/uv/gone', papaId); addShare('StaleBelow', 'pics/other/uv/gone/deeper', papaId); addShare('StaleAtName', 'pics/other/uv/dst', papaId);
  addShare('GoneInside', 'pics/other/uv/src/gone', papaId); addShare('GoneInsideDeep', 'pics/other/uv/src/gone/deeper', papaId);
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/uv/src', name: 'dst' }), { status: 200, body: { name: 'dst' } });
  assert.deepEqual([shareOf('LiveUv'), shareOf('LiveInside')], ['pics/other/uv/dst', 'pics/other/uv/dst/live']);
  assert.deepEqual([shareOf('StaleSibling'), shareOf('StaleBelow'), shareOf('StaleAtName'), shareOf('GoneInside'), shareOf('GoneInsideDeep')],
    ['pics/other/uv/gone', 'pics/other/uv/gone/deeper', 'pics/other/uv/dst', 'pics/other/uv/src/gone', 'pics/other/uv/src/gone/deeper']);   // StaleAtName keeps its path, which a folder now takes
});
test('shares follow the folder they name, not the spelling of their path (a symlinked prefix stands in for a case-insensitive disk)', async () => {
  await seedTree(ta.media, ['pics/other/id/real/xmas/sub/', 'pics/other/id/real/xmas/p.jpg', 'pics/other/id/real/other/q.jpg'], [['real', 'pics/other/id/lnk']]);
  // made through the symlink: the folder itself, and one below it; and one made by the real path
  addShare('ViaLink', 'pics/other/id/lnk/xmas'); addShare('ViaLinkSub', 'pics/other/id/lnk/xmas/sub'); addShare('ViaReal', 'pics/other/id/real/other');
  // Mama also has the same folder spelled the other way: both would end up on one path, which is a clash, and nothing moves
  addShare('Twin', 'pics/other/id/real/xmas');
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/id/real/xmas', name: 'Z' }), EXISTS);
  assert.deepEqual([shareOf('ViaLink'), shareOf('ViaLinkSub'), shareOf('Twin'), await exists('pics/other/id/real/xmas')], ['pics/other/id/lnk/xmas', 'pics/other/id/lnk/xmas/sub', 'pics/other/id/real/xmas', true]);
  ta.db.prepare('delete from shares where alias = ?').run('Twin');
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/id/real/xmas', name: 'Z' }), { status: 200, body: { name: 'Z' } });
  assert.deepEqual([shareOf('ViaLink'), shareOf('ViaLinkSub'), shareOf('ViaReal')], ['pics/other/id/real/Z', 'pics/other/id/real/Z/sub', 'pics/other/id/real/other']);
  assert.deepEqual((await mama.json('GET', '/api/list?path=%2FViaLink')).body.entries.map((e: any) => e.name), ['sub', 'p.jpg']);
  // and the other way round: renamed through the symlink, followed by the share made by the real path
  assert.deepEqual(await post(editor, 'rename', { path: '/Other/id/lnk/other', name: 'Y' }), { status: 200, body: { name: 'Y' } });
  assert.equal(shareOf('ViaReal'), 'pics/other/id/lnk/Y');
  assert.deepEqual((await mama.json('GET', '/api/list?path=%2FViaReal')).body.entries.map((e: any) => e.name), ['q.jpg']);
});

test('moving a shared folder into a sibling rewrites the other user\'s share (F15)', async () => {
  await seedTree(ta.media, ['pics/other/mv/shared/p.jpg', 'pics/other/mv/box/']);
  addShare('Moved', 'pics/other/mv/shared');
  assert.deepEqual(await post(editor, 'move', { paths: ['/Other/mv/shared'], to: '/Other/mv/box' }), { status: 200, body: { moved: 1 } });
  assert.equal(shareOf('Moved'), 'pics/other/mv/box/shared');
  assert.deepEqual((await mama.json('GET', '/api/list?path=%2FMoved')).body.entries.map((e: any) => e.name), ['p.jpg']);
});

test('move: one item after the other and the first error stops; nothing is overwritten; sources and targets are checked', async () => {
  await seedTree(ta.media, ['pics/other/mm/one/a.jpg', 'pics/other/mm/one/b.jpg', 'pics/other/mm/one/c.jpg', 'pics/other/mm/one/notes.txt', 'pics/other/mm/two/',
    'pics/other/mm/loop/inner/', 'pics/other/mm/file.jpg'], [['loop/inner', 'pics/other/mm/lnk'], ['../file.jpg', 'pics/other/mm/one/lnk.jpg']]);
  const mv = (paths: string[], to: string) => post(editor, 'move', { paths, to });
  const one = (n: string) => '/Other/mm/one/' + n, two = '/Other/mm/two';

  assert.deepEqual(await mv([one('a.jpg'), one('missing.jpg'), one('b.jpg')], two), NOT_FOUND);
  assert.deepEqual([await exists('pics/other/mm/two/a.jpg'), await exists('pics/other/mm/one/b.jpg')], [true, true]);   // a.jpg went, b.jpg did not

  await writeFile(join(ta.media, 'pics/other/mm/one/c.jpg'), 'ONE'); await writeFile(join(ta.media, 'pics/other/mm/two/c.jpg'), 'TWO');
  assert.deepEqual(await mv([one('c.jpg')], two), EXISTS);
  assert.deepEqual(await mv(['/Other/mm/two/c.jpg'], two), EXISTS);                  // into its own folder
  assert.deepEqual([await readFile(join(ta.media, 'pics/other/mm/one/c.jpg'), 'utf8'), await readFile(join(ta.media, 'pics/other/mm/two/c.jpg'), 'utf8')], ['ONE', 'TWO']);

  assert.deepEqual(await mv(['/Other/mm/lnk'], two), NOT_FOUND);                     // symlinks (R2) and files the listings hide stay where they are
  assert.deepEqual(await mv([one('lnk.jpg')], two), NOT_FOUND);
  assert.deepEqual(await mv([one('notes.txt')], two), NOT_FOUND);
  assert.deepEqual(await mv(['/Other/mm/file.jpg'], '/Other/mm/file.jpg'), NOT_FOUND);   // a file is no destination
  assert.deepEqual((await mv(['/Other/mm/file.jpg'], '/Other/mm/.gallery-trash')).body, { error: 'Invalid path' });
  assert.deepEqual(await mv(['/Other/mm/file.jpg'], '/'), SAME_SHARE);
  assert.deepEqual(await mv(['/Other/mm/file.jpg'], '/Fam'), SAME_SHARE);
  assert.deepEqual((await mv(['/Other'], two)).body, { error: "This folder can't be renamed, moved or deleted" });

  assert.deepEqual(await mv(['/Other/mm/loop'], '/Other/mm/loop'), INTO_ITSELF);
  assert.deepEqual(await mv(['/Other/mm/loop'], '/Other/mm/lnk'), INTO_ITSELF);      // lnk leads back into loop
  assert.deepEqual(await readdir(join(ta.media, 'pics/other/mm/loop')), ['inner']);
});

test('the administrator changes things below a top-level folder, never across them', async () => {
  await seedTree(ta.media, ['pics/other/ad/old/p.jpg', 'docs/']);
  addShare('AdminMoved', 'pics/other/ad/old');
  assert.deepEqual(await post(admin, 'mkdir', { path: '/pics/other/ad', name: 'new' }), { status: 200, body: { name: 'new' } });
  assert.equal((await post(admin, 'rename', { path: '/pics/other/ad/old', name: 'older' })).status, 200);
  assert.equal(shareOf('AdminMoved'), 'pics/other/ad/older');
  assert.deepEqual(await post(admin, 'move', { paths: ['/pics/other/ad/older'], to: '/docs' }), SAME_SHARE);
  assert.deepEqual(await post(admin, 'move', { paths: ['/pics/other/ad/older'], to: '/' }), SAME_SHARE);
  assert.deepEqual(await post(admin, 'move', { paths: ['/pics/other/ad/older'], to: '/pics/other/ad/new' }), { status: 200, body: { moved: 1 } });
  assert.equal(shareOf('AdminMoved'), 'pics/other/ad/new/older');
  assert.equal((await post(admin, 'rename', { path: '/docs', name: 'D' })).status, 403);   // a top-level folder is a mount point
});

test('two renames to one name at the same time: one wins, nothing is overwritten', async () => {
  const pairs = Array.from({ length: 20 }, (_, i) => i);
  await seedTree(ta.media, pairs.flatMap((i) => [`pics/other/cc/p${i}.jpg`, `pics/other/cc/q${i}.jpg`]));
  for (const i of pairs) {
    await writeFile(join(ta.media, `pics/other/cc/p${i}.jpg`), 'P'); await writeFile(join(ta.media, `pics/other/cc/q${i}.jpg`), 'Q');
    const rs = await Promise.all(['p', 'q'].map((n) => post(editor, 'rename', { path: `/Other/cc/${n}${i}.jpg`, name: `z${i}.jpg` })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], `pair ${i}`);
    const left = (await readdir(join(ta.media, 'pics/other/cc'))).filter((n) => [`p${i}.jpg`, `q${i}.jpg`, `z${i}.jpg`].includes(n));
    assert.deepEqual((await Promise.all(left.map((n) => readFile(join(ta.media, 'pics/other/cc', n), 'utf8')))).sort(), ['P', 'Q'], `pair ${i}`);
  }
});

test('two moves of one name into one folder at the same time: one wins, nothing is overwritten', async () => {
  const pairs = Array.from({ length: 20 }, (_, i) => i);
  await seedTree(ta.media, pairs.flatMap((i) => [`pics/other/cm/a${i}/x.jpg`, `pics/other/cm/b${i}/x.jpg`, `pics/other/cm/into${i}/`]));
  for (const i of pairs) {
    await writeFile(join(ta.media, `pics/other/cm/a${i}/x.jpg`), 'A'); await writeFile(join(ta.media, `pics/other/cm/b${i}/x.jpg`), 'B');
    const rs = await Promise.all(['a', 'b'].map((n) => post(editor, 'move', { paths: [`/Other/cm/${n}${i}/x.jpg`], to: `/Other/cm/into${i}` })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], `pair ${i}`);
    const left = await Promise.all([`a${i}`, `b${i}`, `into${i}`].map((d) => readFile(join(ta.media, 'pics/other/cm', d, 'x.jpg'), 'utf8').catch(() => '')));
    assert.deepEqual(left.filter(Boolean).sort(), ['A', 'B'], `pair ${i}`);
  }
});

test('every change drops the folder cache, and is audited (G9)', async (t) => {
  await seedTree(ta.media, ['pics/other/au/src/a.jpg', 'pics/other/au/box/']);
  const folders = async () => Object.fromEntries((await editor.json('GET', '/api/list?path=%2FOther%2Fau')).body.entries.map((e: any) => [e.name, [e.count, e.cover]]));
  const tree = async () => (await editor.json('GET', '/api/folders?path=%2FOther%2Fau')).body.find((f: any) => f.name === 'box').hasChildren;
  assert.deepEqual(await folders(), { src: [1, '/Other/au/src/a.jpg'], box: [0, null] });   // cached for 30 s from here on
  assert.equal(await tree(), false);
  const events = capture(t);

  await post(editor, 'move', { paths: ['/Other/au/src/a.jpg'], to: '/Other/au/box' });
  assert.deepEqual(await folders(), { src: [0, null], box: [1, '/Other/au/box/a.jpg'] });
  await post(editor, 'mkdir', { path: '/Other/au/box', name: 'inner' });
  assert.equal(await tree(), true);
  await post(editor, 'rename', { path: '/Other/au/box/a.jpg', name: 'b.jpg' });
  assert.deepEqual((await folders()).box, [1, '/Other/au/box/b.jpg']);
  await post(editor, 'rename', { path: '/Other/au/box/b.jpg', name: 'b.png' });          // refused: it changes nothing and is not audited

  assert.deepEqual(events(), [
    { event: 'move', by: 'editor', from: 'pics/other/au/src/a.jpg', to: 'pics/other/au/box/a.jpg' },
    { event: 'mkdir', by: 'editor', path: 'pics/other/au/box/inner' },
    { event: 'rename', by: 'editor', from: 'pics/other/au/box/a.jpg', to: 'pics/other/au/box/b.jpg' },
  ]);
});

test('the exported mutation queue is the one every change to the tree waits in', async (t) => {
  let release = () => {};
  t.after(() => release());                                // a failed assert must not leave the queue held for the tests after this one
  const held = fsops.mutationQueue(() => new Promise<void>((resolve) => { release = resolve; }));
  const queued = post(editor, 'mkdir', { path: '/Other', name: 'waits' });
  assert.equal(await Promise.race([queued.then(() => 'done'), new Promise((resolve) => setTimeout(resolve, 300, 'waiting'))]), 'waiting');
  assert.equal(await exists('pics/other/waits'), false);
  release(); await held;
  assert.equal((await queued).status, 200);
  assert.equal(await exists('pics/other/waits'), true);
});

test('a name that makes the whole path too long is a 400, not a 500', async () => {
  await seedTree(ta.media, ['pics/other/nl/']);
  const name = 'x'.repeat(200);
  let parent = '/Other/nl', depth = 0, last;
  do {
    last = await post(editor, 'mkdir', { path: parent, name });
    parent += '/' + name; depth++;
  } while (last.status === 200 && depth < 40);
  assert.deepEqual(last, { status: 400, body: { error: 'Name is too long' } });
  assert.ok(depth > 5, `it took ${depth} levels`);       // a deep tree: every folder that exists has a path that fits
});

test('mapFsError', () => {
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  const outcome = (e: unknown) => { try { fsops.mapFsError(e); } catch (err) { return err instanceof HttpError ? [err.status, err.message] : err; } };
  for (const [c, status, message] of [
    ['EROFS', 409, 'This folder is read-only on disk'], ['EACCES', 409, 'This folder is read-only on disk'], ['EPERM', 409, 'This folder is read-only on disk'],
    ['ENOSPC', 507, 'Disk is full'], ['EDQUOT', 507, 'Disk is full'], ['EEXIST', 409, 'A file or folder with that name already exists'],
    ['ENOTEMPTY', 409, 'A file or folder with that name already exists'], ['ENOENT', 404, 'Not found'], ['ENOTDIR', 404, 'Not found'],
    ['ENAMETOOLONG', 400, 'Name is too long'], ['EXDEV', 400, 'Items can only be moved within the same shared folder'],
  ] as const) assert.deepEqual(outcome(code(c)), [status, message], c);
  const other = code('EIO');
  assert.equal(outcome(other), other);                     // anything else is rethrown as it is
  assert.equal(outcome(undefined), undefined);
});

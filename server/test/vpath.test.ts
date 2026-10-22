import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Me } from '../../shared/types.ts';
import { createApp } from '../app.ts';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import { HttpError } from '../http.ts';
import { childAbs, joinVpath, locate, requireRight, requireUnprotected, resolve, sharesForUser, splitVpath } from '../vpath.ts';
import type { ShareRow } from '../vpath.ts';
import { tempDir, testConfig } from './helpers.ts';

const prefs = { defaultView: 'large', slideSeconds: 5 } as const;
const admin: Me = { id: 1, username: 'root', displayName: 'Root', role: 'admin', prefs };
const papa: Me = { id: 2, username: 'papa', displayName: 'Papa', role: 'member', prefs };
const share = (id: number, alias: string, relPath: string, create = false, update = false, del = false): ShareRow =>
  ({ id, userId: papa.id, alias, relPath, create, update, delete: del });
const shares = [share(1, 'Family photos', 'pics/family', true), share(2, 'test1-papa', 'pics/test1'), share(3, 'All', 'pics')];
const NOT_FOUND = { status: 404, message: 'Not found' };
const INVALID = { status: 400, message: 'Invalid path' };

let media: string, cfg: Config;

before(async () => {
  media = await tempDir();
  const outside = await tempDir();   // a folder next to MEDIA_ROOT, not inside it
  cfg = testConfig({ mediaRoot: media, dataDir: await tempDir() });
  for (const f of ['pics/family/xmas/a.jpg', 'pics/family/Дача #2 (2024)/IMG 50%.jpg', 'pics/family-extra/z.jpg', 'pics/test1/b.jpg',
    'pics/.hidden/x.jpg', 'pics/@eaDir/y.jpg', 'pics/$RECYCLE.BIN./x.jpg', 'other/secret.jpg']) {
    await mkdir(dirname(join(media, f)), { recursive: true });
    await writeFile(join(media, f), 'x');
  }
  await writeFile(join(outside, 'o.jpg'), 'x');
  const links: [string, string][] = [
    ['../../other', 'pics/family/escape'],         // leaves the share, stays inside MEDIA_ROOT
    ['xmas', 'pics/family/inside'],                // stays inside the share
    ['../family-extra', 'pics/family/sibling'],    // its real path starts with the share's real path, but is not below it
    ['loop', 'pics/family/loop'],                  // ELOOP
    ['.hidden', 'pics/peek'],                      // inside the "All" share, but lands in a hidden folder
    ['$RECYCLE.BIN.', 'pics/peek2'],               // the same, spelled the way vfat echoes a client's trailing dot back from realpath
    ['family', 'pics/viaLink'],                    // a share can sit on a symlink
    [outside, 'pics/out'],                         // leaves MEDIA_ROOT
    ['..', 'pics/self'],                           // is MEDIA_ROOT
  ];
  for (const [target, at] of links) await symlink(target, join(media, at));
});

test('member root is virtual and protected', async () => {
  const l = await resolve(cfg, papa, shares, '/');
  assert.deepEqual([l.abs, l.isProtected, l.rights], [null, true, { create: false, update: false, delete: false }]);
});
test('alias maps to disk with share rights', async () => {
  const l = await resolve(cfg, papa, shares, '/Family photos/xmas');
  assert.equal(l.abs, join(media, 'pics/family/xmas')); assert.equal(l.rel, 'pics/family/xmas');
  assert.deepEqual(l.rights, { create: true, update: false, delete: false });
  assert.equal(l.isProtected, false); assert.equal(l.scope, join(media, 'pics/family'));
  assert.equal((await resolve(cfg, papa, shares, '/Family photos')).isProtected, true);
});
test('overlapping shares use the alias in the path', async () =>
  assert.deepEqual((await resolve(cfg, papa, shares, '/All/family/xmas')).rights, { create: false, update: false, delete: false }));
test('rejects traversal, hidden, backslash, NUL', async () => {
  for (const p of ['/Family photos/../test1-papa', '/Family photos/./xmas', '/a//b', 'rel', '/All/.hidden/x.jpg', '/All/@eaDir', '/All\\..', '/a\0b'])
    await assert.rejects(resolve(cfg, papa, shares, p), { status: 400, message: 'Invalid path' }, p);
});
test('404 for unknown alias, missing path and symlink escape; inside symlink allowed', async () => {
  for (const p of ['/nope', '/Family photos/missing', '/Family photos/escape/secret.jpg'])
    await assert.rejects(resolve(cfg, papa, shares, p), { status: 404, message: 'Not found' }, p);
  assert.ok((await resolve(cfg, papa, shares, '/Family photos/inside/a.jpg')).abs);
});
test('admin sees MEDIA_ROOT; root and top-level are protected', async () => {
  const root = await resolve(cfg, admin, [], '/');
  assert.deepEqual([root.abs, root.isProtected, root.rights.create], [media, true, false]);
  const top = await resolve(cfg, admin, [], '/pics');
  assert.deepEqual([top.isProtected, top.rights, top.scope], [true, { create: true, update: true, delete: true }, join(media, 'pics')]);
  assert.equal((await resolve(cfg, admin, [], '/pics/family')).isProtected, false);
});
test('unicode and URL-special names (Review Focus 1)', async () =>
  assert.equal((await resolve(cfg, papa, shares, '/Family photos/Дача #2 (2024)/IMG 50%.jpg')).rel, 'pics/family/Дача #2 (2024)/IMG 50%.jpg'));
test('requireRight / requireUnprotected', async () => {
  const l = await resolve(cfg, papa, shares, '/test1-papa');
  assert.throws(() => requireRight(l, 'create'), { status: 403, message: "You don't have permission to do that" });
  assert.throws(() => requireUnprotected(l), { status: 403, message: "This folder can't be renamed, moved or deleted" });
});

// What the brief pins is above. Below: the rest of the resolver's contract, and the ways round it.

test('splitVpath', () => {
  assert.deepEqual(splitVpath('/'), []);
  assert.deepEqual(splitVpath('/Family photos/Дача #2 (2024)'), ['Family photos', 'Дача #2 (2024)']);
  for (const p of ['', 'a', '/a/', '//', '/a/..', '/.', '/a/.b', '/a/Thumbs.db', '/a/#RECYCLE', '/a/@eaDir.', '/a/$RECYCLE.BIN.', '/a/Thumbs.db ', '/a\\b', '/a/b\0'])
    assert.throws(() => splitVpath(p), INVALID, JSON.stringify(p));
  for (const p of [undefined, null, 5, ['/a'], { a: 1 }]) assert.throws(() => splitVpath(p as never), INVALID);   // request bodies are untrusted (G6)
});
test('the admin gets the same refusals', async () => {
  for (const p of ['/pics/../other', '/pics/./family', '/pics//family', '/pics/.hidden', '/pics/@eaDir/y.jpg'])
    await assert.rejects(resolve(cfg, admin, [], p), INVALID, p);
  await assert.rejects(resolve(cfg, admin, [], '/pics/missing'), NOT_FOUND);
  await assert.rejects(resolve({ ...cfg, mediaRoot: join(media, 'gone') }, admin, [], '/'), NOT_FOUND);   // MEDIA_ROOT itself not there
});
test('404 for a sibling that shares the prefix, a loop and a file used as a folder', async () => {
  for (const p of ['/Family photos/sibling', '/Family photos/sibling/z.jpg', '/Family photos/escape', '/Family photos/loop', '/Family photos/xmas/a.jpg/x'])
    await assert.rejects(resolve(cfg, papa, shares, p), NOT_FOUND, p);
});
test('a symlink into a hidden folder is refused', async () => {
  await assert.rejects(resolve(cfg, papa, shares, '/All/peek/x.jpg'), NOT_FOUND);
  await assert.rejects(resolve(cfg, admin, [], '/pics/peek'), NOT_FOUND);
  await assert.rejects(resolve(cfg, papa, shares, '/All/peek2/x.jpg'), NOT_FOUND);   // a trailing dot does not make it another folder
  await assert.rejects(resolve(cfg, admin, [], '/pics/peek2'), NOT_FOUND);
});
test('a share must lie strictly inside MEDIA_ROOT', async () => {
  const bad = [share(10, 'Out', 'pics/out'), share(11, 'Whole', 'pics/self'), share(12, 'Root', ''), share(13, 'Up', '..')];
  // /Out/o.jpg, /Whole/pics/family and /Root/pics/family exist: only the check on the share's own folder stops them
  for (const p of ['/Out', '/Out/o.jpg', '/Whole', '/Whole/pics/family', '/Root', '/Root/pics/family', '/Up'])
    await assert.rejects(resolve(cfg, papa, [...shares, ...bad], p), NOT_FOUND, p);
});
test('a share on a symlink inside MEDIA_ROOT works, with the link target as its limit', async () => {
  const linked = [share(20, 'Linked', 'pics/viaLink', true, true, true)];
  const l = await resolve(cfg, papa, linked, '/Linked/xmas/a.jpg');
  assert.deepEqual([l.abs, l.rel, l.scope], [join(media, 'pics/viaLink/xmas/a.jpg'), 'pics/viaLink/xmas/a.jpg', join(media, 'pics/viaLink')]);
  await assert.rejects(resolve(cfg, papa, linked, '/Linked/escape/secret.jpg'), NOT_FOUND);
});
test('the admin is held inside MEDIA_ROOT too, and MEDIA_ROOT may itself be a symlink', async () => {
  await assert.rejects(resolve(cfg, admin, [], '/pics/out/o.jpg'), NOT_FOUND);
  assert.ok((await resolve(cfg, admin, [], '/pics/family/escape/secret.jpg')).abs);   // ends inside MEDIA_ROOT: allowed
  const link = join(await tempDir(), 'media');
  await symlink(media, link);
  const viaLink = { ...cfg, mediaRoot: link };
  assert.equal((await resolve(viaLink, admin, [], '/pics/family/xmas')).abs, join(link, 'pics/family/xmas'));
  assert.equal((await resolve(viaLink, papa, shares, '/Family photos/xmas')).rel, 'pics/family/xmas');
  await assert.rejects(resolve(viaLink, papa, shares, '/Family photos/escape/secret.jpg'), NOT_FOUND);
  await assert.rejects(resolve(viaLink, admin, [], '/pics/out/o.jpg'), NOT_FOUND);
});
test('aliases ignore letter case, and an exact match wins', async () => {
  assert.equal((await resolve(cfg, papa, shares, '/family PHOTOS/xmas')).share?.id, 1);
  const twins = [share(30, 'Дача', 'pics/family'), share(31, 'дача', 'pics/test1')];   // SQLite's NOCASE folds ASCII only, so both can be stored
  assert.equal((await resolve(cfg, papa, twins, '/дача/b.jpg')).share?.id, 31);
  assert.equal((await resolve(cfg, papa, twins, '/Дача/xmas')).share?.id, 30);
  assert.equal((await resolve(cfg, papa, twins, '/ДАЧА/xmas')).share?.id, 30);   // no exact match: the first listed
});
test('each Loc carries its own rights object', async () => {
  (await resolve(cfg, papa, shares, '/Family photos/xmas')).rights.update = true;
  (await resolve(cfg, papa, shares, '/')).rights.delete = true;
  (await resolve(cfg, admin, [], '/')).rights.create = true;
  assert.equal((await resolve(cfg, papa, shares, '/Family photos/xmas')).rights.update, false);
  assert.equal((await resolve(cfg, papa, shares, '/')).rights.delete, false);
  assert.equal((await resolve(cfg, admin, [], '/')).rights.create, false);
  assert.equal(shares[0].update, false);
});
test('the share, scope and vpath of a Loc', async () => {
  const l = await resolve(cfg, papa, shares, '/test1-papa/b.jpg');
  assert.deepEqual([l.vpath, l.share, l.scope, l.isProtected], ['/test1-papa/b.jpg', shares[1], join(media, 'pics/test1'), false]);
  const root = await resolve(cfg, papa, shares, '/');
  assert.deepEqual([root.vpath, root.rel, root.share, root.scope], ['/', '', null, null]);
  const a = await resolve(cfg, admin, [], '/');
  assert.deepEqual([a.rel, a.share, a.scope], ['', null, null]);
  const top = await resolve(cfg, admin, [], '/pics/test1/b.jpg');
  assert.deepEqual([top.share, top.scope, top.rel], [null, join(media, 'pics'), 'pics/test1/b.jpg']);
});
test('only the exact role admin gets the admin view', async () => {
  for (const role of ['Admin', 'root', '', undefined]) {
    const l = await resolve(cfg, { ...papa, role: role as never }, shares, '/');
    assert.equal(l.abs, null, String(role));
    await assert.rejects(resolve(cfg, { ...papa, role: role as never }, shares, '/pics'), NOT_FOUND, String(role));
  }
});
test('overlong paths are a 404, not a crash', async () => {
  for (const p of ['/All/' + 'a'.repeat(300), '/All' + '/a'.repeat(200_000)])
    await assert.rejects(resolve(cfg, papa, shares, p), NOT_FOUND, `${p.length} chars`);
  await assert.rejects(resolve(cfg, admin, [], '/' + 'a'.repeat(300)), NOT_FOUND);
});
test('a folder the process may not enter is a fault of ours (500), not a 404', { skip: process.getuid?.() === 0 }, async (t) => {
  const locked = join(media, 'pics/test1/locked');
  await mkdir(join(locked, 'in'), { recursive: true });
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o755));
  // the same answer whether or not the target exists, so it tells a client nothing about what is behind the folder
  for (const p of ['/test1-papa/locked/in', '/test1-papa/locked/nope'])
    await assert.rejects(resolve(cfg, papa, shares, p), (e: NodeJS.ErrnoException) => !(e instanceof HttpError) && e.code === 'EACCES', p);
});
test('only "nothing there" errors become a 404; a real fault stays one', async () => {
  // a NUL in MEDIA_ROOT makes realpath throw ERR_INVALID_ARG_VALUE, which is not one of the missing-path codes
  await assert.rejects(resolve({ ...cfg, mediaRoot: media + '\0' }, admin, [], '/'), (e: Error) => !(e instanceof HttpError));
});
test('childAbs and joinVpath', async () => {
  const dir = await resolve(cfg, papa, shares, '/Family photos/xmas');
  assert.equal(childAbs(dir, 'New 1'), join(media, 'pics/family/xmas/New 1'));
  assert.equal(childAbs(dir, 'Дача #2'), join(media, 'pics/family/xmas/Дача #2'));
  for (const n of ['', '.', '..', 'a/b', '../x', 'a\\b', 'a\0b']) assert.throws(() => childAbs(dir, n), INVALID, JSON.stringify(n));
  assert.throws(() => childAbs(dir, undefined as never), INVALID);
  assert.throws(() => childAbs({ ...dir, abs: null }, 'x'), { status: 403, message: "You don't have permission to do that" });   // a member's virtual root has no folder
  assert.equal(joinVpath('/', 'a'), '/a');
  assert.equal(joinVpath('/Family photos', 'Дача #2 (2024)'), '/Family photos/Дача #2 (2024)');
  assert.equal((await resolve(cfg, papa, shares, joinVpath('/Family photos', 'xmas'))).abs, dir.abs);   // what joinVpath builds resolves again
});
test('requireRight and requireUnprotected let allowed requests through', async () => {
  const l = await resolve(cfg, papa, shares, '/Family photos/xmas');
  requireRight(l, 'create'); requireUnprotected(l);
  for (const right of ['update', 'delete'] as const) assert.throws(() => requireRight(l, right), { status: 403 }, right);
});
test('sharesForUser and locate read the shares on every call', async (t) => {
  const db = openDb(':memory:');
  const app = createApp(cfg, db);
  t.after(() => app.close());
  const user = db.prepare("insert into users (id, username, display_name, role, password_hash, created_at) values (?, ?, ?, ?, 'x', 0)");
  user.run(1, 'root', 'Root', 'admin'); user.run(2, 'papa', 'Papa', 'member'); user.run(3, 'mama', 'Mama', 'member');
  const add = db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, ?, ?, ?)');
  add.run(2, 'Family photos', 'pics/family', 1, 0, 0); add.run(2, 'test1-papa', 'pics/test1', 0, 0, 0); add.run(3, 'Mine', 'other', 0, 1, 0);

  assert.deepEqual(sharesForUser(db, 2), [
    { id: 1, userId: 2, alias: 'Family photos', relPath: 'pics/family', create: true, update: false, delete: false },
    { id: 2, userId: 2, alias: 'test1-papa', relPath: 'pics/test1', create: false, update: false, delete: false },
  ]);
  assert.deepEqual(sharesForUser(db, 1), []);

  assert.deepEqual((await locate(app, papa, '/Family photos/xmas')).rights, { create: true, update: false, delete: false });
  await assert.rejects(locate(app, papa, '/Mine'), NOT_FOUND);                                    // mama's alias is not papa's
  assert.deepEqual((await locate(app, { ...papa, id: 3 }, '/Mine')).rights, { create: false, update: true, delete: false });
  assert.equal((await locate(app, admin, '/pics/family')).rights.delete, true);                    // the admin needs no share rows

  db.prepare('update shares set can_update = 1 where id = 1').run();                               // a rights change shows on the next request
  assert.equal((await locate(app, papa, '/Family photos/xmas')).rights.update, true);
  db.prepare('delete from shares where id = 1').run();                                             // so does a removed share
  await assert.rejects(locate(app, papa, '/Family photos/xmas'), NOT_FOUND);
});
test('locate asks the database for members only', async () => {
  const closed = openDb(':memory:');
  closed.close();   // any query on it throws
  const app = { cfg, db: closed } as Parameters<typeof locate>[0];
  assert.equal((await locate(app, admin, '/pics')).abs, join(media, 'pics'));
  await assert.rejects(locate(app, papa, '/Family photos'), /not open/);
});

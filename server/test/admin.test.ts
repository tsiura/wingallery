import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSession, touchSession } from '../auth.ts';
import { openDb } from '../db.ts';
import { rewriteSharePaths } from '../shares.ts';
import { createUser, getMe, listUsers, removeUser, setPassword, updateUser } from '../users.ts';
import { locate } from '../vpath.ts';
import { fixture, seedTree, startTestApp, tempDir } from './helpers.ts';

// pics/family, pics/test1, pics/.hidden, other, a file pics/x.jpg and a symlink pics/link -> family
const TREE = ['pics/family/', 'pics/test1/', 'pics/.hidden/', 'other/', 'pics/x.jpg'];
const LINKS: [string, string][] = [['family', 'pics/link']];
const PICK = 'Pick a folder inside the media folder';
const NO_RIGHTS = { create: false, update: false, delete: false };
const BAD_NAME = 'Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore';
const NOT_FOUND = { status: 404, body: { error: 'Not found' } };

// For tests that change things through the API but don't look at the audit lines it prints.
const quiet = (t: TestContext) => { t.mock.method(console, 'log', () => {}); };

// console.log from here on; the result gives the audit events (JSON lines) without their timestamp.
function capture(t: TestContext) {
  const lines: string[] = [];
  t.mock.method(console, 'log', (s: unknown) => { lines.push(String(s)); });
  return () => lines.filter((l) => l.startsWith('{')).map((l) => { const { t: _time, ...event } = JSON.parse(l); return event; });
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test('admin endpoints are admin-only', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); await ta.admin();
  const { client: m } = await ta.addUser('papa', 'member');
  assert.equal((await ta.client().json('GET', '/api/admin/users')).status, 401);
  assert.deepEqual(await m.json('GET', '/api/admin/users'), { status: 403, body: { error: 'Administrators only' } });
});
test('every admin route refuses anonymous and member requests, and changes nothing', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); await ta.admin();
  const { client: m } = await ta.addUser('papa', 'member');
  await seedTree(ta.media, ['pics/']);   // so that the share below would work for an administrator
  const routes: [string, string, object?][] = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { username: 'new', displayName: 'N', password: 'password123', role: 'admin' }],
    ['PATCH', '/api/admin/users/2', { role: 'admin' }],
    ['POST', '/api/admin/users/1/password', { password: 'another-pass1' }],
    ['DELETE', '/api/admin/users/1'],
    ['GET', '/api/admin/users/1/shares'],
    ['POST', '/api/admin/users/2/shares', { relPath: 'pics', alias: 'P', ...NO_RIGHTS }],
    ['PATCH', '/api/admin/shares/1', { delete: true }],
    ['DELETE', '/api/admin/shares/1'],
    ['GET', '/api/admin/browse?path='],
  ];
  for (const [method, path, body] of routes) {
    assert.deepEqual(await ta.client().json(method, path, body), { status: 401, body: { error: 'Sign in required' } }, `anonymous ${method} ${path}`);
    assert.deepEqual(await m.json(method, path, body), { status: 403, body: { error: 'Administrators only' } }, `member ${method} ${path}`);
  }
  assert.deepEqual(listUsers(ta.db).map((u) => [u.username, u.role]), [['root', 'admin'], ['papa', 'member']]);
  assert.equal(ta.db.prepare('select count(*) n from shares').get()!.n, 0);
});
test('user management', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const made = await a.json('POST', '/api/admin/users', { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  assert.equal(made.status, 200);
  assert.equal((await a.json('POST', '/api/admin/users', { username: 'PAPA', displayName: 'X', password: 'password123', role: 'member' })).body.error, 'That username is taken');
  const me = (await a.json('GET', '/api/session')).body.user;
  assert.equal((await a.json('PATCH', `/api/admin/users/${me.id}`, { role: 'member' })).body.error, "You can't change your own role");
  assert.equal((await a.json('DELETE', `/api/admin/users/${me.id}`)).body.error, "You can't remove yourself");
  const papa = await ta.login('papa', 'password123');
  await a.json('POST', `/api/admin/users/${made.body.id}/password`, { password: 'another-pass1' });
  assert.equal((await papa.json('GET', '/api/session')).body.user, null);
  const papa2 = await ta.login('papa', 'another-pass1');
  assert.equal((await a.json('PATCH', `/api/admin/users/${made.body.id}`, { role: 'admin' })).body.role, 'admin');
  assert.equal((await papa2.json('GET', '/api/session')).body.user, null);
  // F12.1: papa has a share when he goes, so the count of zero shows that removing a user removes their shares
  await seedTree(ta.media, ['pics/']);
  assert.equal((await a.json('POST', `/api/admin/users/${made.body.id}/shares`, { relPath: 'pics', alias: 'Pics', ...NO_RIGHTS })).status, 200);
  assert.equal(ta.db.prepare('select count(*) n from shares').get()!.n, 1);
  assert.equal((await a.json('DELETE', `/api/admin/users/${made.body.id}`)).status, 200);
  assert.equal(ta.db.prepare('select count(*) n from shares').get()!.n, 0);
});
test('creating users follows the setup rules, and the list shows nothing secret', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const create = (body: unknown) => a.json('POST', '/api/admin/users', body);
  const ok = { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' };
  assert.deepEqual(await create({ ...ok, username: 'Bad Name' }), { status: 400, body: { error: BAD_NAME } });
  assert.deepEqual(await create({ ...ok, password: 'short' }), { status: 400, body: { error: 'Password must be at least 8 characters' } });
  assert.deepEqual(await create({ ...ok, displayName: 'x'.repeat(65) }), { status: 400, body: { error: 'Display name is too long' } });
  // fields of the wrong type are the pinned validation errors (G6), never a 500
  assert.deepEqual(await create({ ...ok, username: 5 }), { status: 400, body: { error: BAD_NAME } });
  assert.deepEqual(await create({ ...ok, password: 12345678 }), { status: 400, body: { error: 'Password must be at least 8 characters' } });
  assert.equal(listUsers(ta.db).length, 1);   // none of that created anyone
  const mama = await create({ ...ok, username: ' Mama ', displayName: '  ', role: 'ADMIN' });   // the name is normalised; only the exact role admin makes an administrator
  assert.deepEqual(mama, { status: 200, body: { id: mama.body.id, username: 'mama', displayName: 'mama', role: 'member' } });
  const papa = await create({ ...ok, role: 'admin' });
  assert.deepEqual(papa.body, { id: papa.body.id, username: 'papa', displayName: 'Papa', role: 'admin' });
  assert.deepEqual((await a.json('GET', '/api/admin/users')).body, [{ id: 1, username: 'root', displayName: 'root', role: 'admin' }, mama.body, papa.body]);
});
test('editing a user: username and display name rules, and which role changes end sessions', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id, client: papa } = await ta.addUser('papa', 'member');
  const me = (await a.json('GET', '/api/session')).body.user.id;
  const patch = (body: unknown, who = id) => a.json('PATCH', `/api/admin/users/${who}`, body);
  const signedIn = async (c = papa) => (await c.json('GET', '/api/session')).body.user !== null;

  // the display name is Task 4's rule: trimmed, the username when empty, at most 64 characters
  assert.equal((await patch({ displayName: '  Papa B.  ' })).body.displayName, 'Papa B.');
  for (const empty of ['', '   ', null, 5]) assert.equal((await patch({ displayName: empty })).body.displayName, 'papa', String(empty));   // not a string counts as '' (G6)
  assert.equal((await patch({ displayName: 'x'.repeat(64) })).status, 200);
  assert.deepEqual(await patch({ displayName: 'x'.repeat(65) }), { status: 400, body: { error: 'Display name is too long' } });
  assert.equal((await a.json('GET', '/api/admin/users')).body[1].displayName, 'x'.repeat(64));   // a refused patch changes nothing

  // a rename: the same rule as at creation, and an empty display name falls back to the new name
  assert.deepEqual(await patch({ username: ' Dad ', displayName: '' }), { status: 200, body: { id, username: 'dad', displayName: 'dad', role: 'member' } });
  assert.equal((await papa.json('GET', '/api/session')).body.user.username, 'dad');   // the session belongs to the account, not to the name
  await assert.rejects(ta.login('papa', 'password123'), /401/);
  await ta.login('dad', 'password123');
  assert.deepEqual(await patch({ username: 'ROOT' }), { status: 409, body: { error: 'That username is taken' } });
  for (const bad of ['a', 'Bad Name', '', null, 5]) assert.deepEqual(await patch({ username: bad }), { status: 400, body: { error: BAD_NAME } }, String(bad));
  assert.equal((await patch({ username: 'DAD' })).body.username, 'dad');   // the same name in other letters clashes with no one

  // roles: only a real change counts, and it ends that user's sessions
  for (const bad of ['bogus', 'Admin', 5, null]) assert.deepEqual(await patch({ role: bad }), { status: 400, body: { error: 'Invalid JSON' } }, String(bad));
  assert.equal((await patch({ displayName: 'Dad', role: 'member' })).status, 200);
  assert.equal(await signedIn(), true);
  assert.equal((await patch({ role: 'admin' })).body.role, 'admin');
  assert.equal(await signedIn(), false);
  const again = await ta.login('dad', 'password123');
  assert.equal((await patch({ role: 'member' })).body.role, 'member');
  assert.equal(await signedIn(again), false);   // a demotion ends them as well

  // an administrator may edit themselves, except their role
  assert.equal((await patch({ displayName: 'Boss', role: 'admin' }, me)).body.displayName, 'Boss');
  assert.deepEqual(await patch({ role: 'member' }, me), { status: 403, body: { error: "You can't change your own role" } });
  assert.equal(await signedIn(a), true);
  assert.deepEqual(await patch({ displayName: 'x' }, 999), NOT_FOUND);
  assert.deepEqual(await patch({}), { status: 200, body: { id, username: 'dad', displayName: 'Dad', role: 'member' } });
});
test('ids in the path are plain positive integers; anything else names no one', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  await seedTree(ta.media, ['pics/']);
  const share = { relPath: 'pics', alias: 'P', ...NO_RIGHTS };
  const routes = (id: string): [string, string, object?][] => [
    ['PATCH', `/api/admin/users/${id}`, { displayName: 'X' }], ['DELETE', `/api/admin/users/${id}`], ['POST', `/api/admin/users/${id}/password`, { password: 'another-pass1' }],
    ['GET', `/api/admin/users/${id}/shares`], ['POST', `/api/admin/users/${id}/shares`, share], ['PATCH', `/api/admin/shares/${id}`, { delete: true }], ['DELETE', `/api/admin/shares/${id}`],
  ];
  // 1%2F2 reaches the handler as "1/2"; 99 is a fine id that no one has
  for (const id of ['abc', '0', '-1', '01', '1.0', '1e0', '0x1', '%201', '1%2F2', '1%00', '9007199254740993', '99999999999999999999', '99'])
    for (const [method, path, body] of routes(id)) assert.deepEqual(await a.json(method, path, body), NOT_FOUND, `${method} ${path}`);
  assert.equal(ta.db.prepare('select count(*) n from shares').get()!.n, 0);
  assert.equal(listUsers(ta.db).length, 1);
});
test('removing a user takes their sessions, shares and upload temp files with them', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id: papa, client } = await ta.addUser('papa', 'member'); const { id: mama } = await ta.addUser('mama', 'member');
  await seedTree(ta.media, ['pics/', 'pics/.upload-p1', 'pics/.upload-m1']);
  const upload = (id: string, user: number, temp: string) => ta.db.prepare('insert into uploads (id, user_id, dir_abs, temp_abs, name, size, received, updated_at) values (?, ?, ?, ?, ?, 10, 5, 0)')
    .run(id, user, join(ta.media, 'pics'), join(ta.media, temp), 'a.jpg');
  upload('p1', papa, 'pics/.upload-p1'); upload('p2', papa, 'pics/.upload-gone'); upload('m1', mama, 'pics/.upload-m1');   // p2's file is not there any more
  for (const user of [papa, mama]) await a.json('POST', `/api/admin/users/${user}/shares`, { relPath: 'pics', alias: 'Pics', ...NO_RIGHTS });
  assert.equal((await a.json('DELETE', `/api/admin/users/${papa}`)).status, 200);
  assert.equal(await exists(join(ta.media, 'pics/.upload-p1')), false);
  assert.equal(await exists(join(ta.media, 'pics/.upload-m1')), true);   // someone else's upload stays
  assert.equal((await client.json('GET', '/api/session')).body.user, null);
  const owners = (table: string) => ta.db.prepare(`select user_id from ${table}`).all().map((r) => r.user_id);
  assert.deepEqual([owners('shares'), owners('uploads')], [[mama], [mama]]);
  assert.equal(ta.db.prepare('select count(*) n from sessions where user_id = ?').get(papa)!.n, 0);
  assert.deepEqual(await a.json('DELETE', `/api/admin/users/${papa}`), NOT_FOUND);
});
test('an administrator who was demoted or removed while their request was waiting can no longer demote or remove anyone', async () => {
  const db = openDb(':memory:');
  const create = (username: string, role: 'admin' | 'member') => createUser(db, { username, displayName: username, password: 'password123', role });
  const [one, two] = [await create('one', 'admin'), await create('two', 'admin')];
  // `two` is the Me that a request of theirs was authorised with; one acts on them before that request gets to its turn
  updateUser(db, one, two.id, { role: 'member' });
  assert.throws(() => updateUser(db, two, one.id, { role: 'member' }), { status: 403, message: 'Administrators only' });
  await assert.rejects(removeUser(db, two, one.id), { status: 403, message: 'Administrators only' });
  await removeUser(db, one, two.id);
  await assert.rejects(removeUser(db, two, one.id), { status: 403, message: 'Administrators only' });   // nor can one who is gone
  assert.deepEqual(listUsers(db).map((u) => [u.username, u.role]), [['one', 'admin']]);
});
test('shares', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  await seedTree(ta.media, TREE, LINKS);
  const { id } = await ta.addUser('papa', 'member'); const { id: mama } = await ta.addUser('mama', 'member');
  const s = await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/family', alias: 'Family photos', create: true, update: false, delete: false });
  assert.deepEqual(s.body, { id: s.body.id, userId: id, alias: 'Family photos', relPath: 'pics/family', diskPath: join(ta.media, 'pics/family'), create: true, update: false, delete: false, available: true });
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/test1', alias: 'family PHOTOS', create: false, update: false, delete: false })).body.error, 'This user already has a folder named "family PHOTOS"');
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/family', alias: 'Again', create: false, update: false, delete: false })).body.error, 'This folder is already shared with this user');
  assert.equal((await a.json('POST', `/api/admin/users/${mama}/shares`, { relPath: 'pics/family', alias: 'Family photos', create: false, update: false, delete: false })).status, 200);
  for (const [relPath, status] of [['', 400], ['../x', 400], ['pics/.hidden', 400], ['pics/missing', 404], ['pics/x.jpg', 400]] as const)
    assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias: 'Z' + status, create: false, update: false, delete: false })).status, status, relPath);
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/test1', alias: 'a/b', create: false, update: false, delete: false })).status, 400);
  assert.equal((await a.json('PATCH', `/api/admin/shares/${s.body.id}`, { delete: true })).body.delete, true);
  await rm(join(ta.media, 'pics/family'), { recursive: true });
  assert.equal((await a.json('GET', `/api/admin/users/${id}/shares`)).body[0].available, false);
  assert.equal(rewriteSharePaths(ta.db, 'pics', 'photos'), 2);
});
test('adding a share: the folder goes through the resolver, the answers stay the pinned ones', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id } = await ta.addUser('papa', 'member');
  const outside = await tempDir();
  await seedTree(ta.media, [...TREE, 'Дача #2 (2024)/IMG 50%.jpg', 'Дача #2 (2024)/sub/'], [...LINKS, [outside, 'pics/out']]);
  const add = (relPath: unknown, alias = 'Z') => a.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias, ...NO_RIGHTS });
  const invalid = { status: 400, body: { error: 'Invalid path' } };
  assert.deepEqual(await add(''), { status: 400, body: { error: PICK } });   // MEDIA_ROOT itself is not a folder to share
  assert.deepEqual(await add('pics/x.jpg'), { status: 400, body: { error: PICK } });
  assert.deepEqual(await add('pics/missing'), NOT_FOUND);
  assert.deepEqual(await add('pics/out'), NOT_FOUND);   // a symlink that leaves MEDIA_ROOT is not there for a share either
  for (const bad of ['../x', '..', '.', '/pics', 'pics/', 'pics//family', 'pics\\family', 'pics/\0', 'pics/.hidden', '.gallery-trash', '$RECYCLE.BIN/x']) assert.deepEqual(await add(bad), invalid, JSON.stringify(bad));
  for (const bad of [5, null, true, {}, ['pics']]) assert.deepEqual(await add(bad), { status: 400, body: { error: PICK } }, JSON.stringify(bad));   // G6
  assert.deepEqual(await a.json('GET', `/api/admin/users/${id}/shares`), { status: 200, body: [] });   // none of those added anything
  // alias rules are the name rules; a non-string alias is the empty one
  for (const [alias, error] of [['', "Name can't be empty"], [5, "Name can't be empty"], ['x'.repeat(65), 'Name is too long'], ['.hidden', "Name can't start or end with a space or a dot"], [' a', "Name can't start or end with a space or a dot"], ['a|b', 'Name can\'t contain any of: / \\ : * ? " < > |']] as const)
    assert.deepEqual(await add('pics/test1', alias as string), { status: 400, body: { error } }, JSON.stringify(alias));
  assert.equal((await add('pics/test1', 'x'.repeat(64))).status, 200);
  // non-ASCII and URL-special names go in and out unchanged
  const odd = await add('Дача #2 (2024)', 'Дача #2 (2024)');
  assert.deepEqual(odd.body, { id: odd.body.id, userId: id, alias: 'Дача #2 (2024)', relPath: 'Дача #2 (2024)', diskPath: join(ta.media, 'Дача #2 (2024)'), ...NO_RIGHTS, available: true });
  // truthy is not true (G6)
  const rights = await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'other', alias: 'Other', create: 'yes', update: 1, delete: true });
  assert.deepEqual([rights.body.create, rights.body.update, rights.body.delete], [false, false, true]);
  assert.deepEqual(await a.json('POST', '/api/admin/users/999/shares', { relPath: 'pics/family', alias: 'F', ...NO_RIGHTS }), NOT_FOUND);   // no such user
});
test('a share is unique per user whatever the letters, also where SQLite folds only ASCII (R5)', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id } = await ta.addUser('papa', 'member'); const { id: mama } = await ta.addUser('mama', 'member');
  await seedTree(ta.media, TREE);
  const add = (user: number, relPath: string, alias: string) => a.json('POST', `/api/admin/users/${user}/shares`, { relPath, alias, ...NO_RIGHTS });
  const first = await add(id, 'pics/family', 'Дача');
  assert.equal(first.status, 200);
  assert.deepEqual(await add(id, 'pics/test1', 'дача'), { status: 409, body: { error: 'This user already has a folder named "дача"' } });
  assert.equal((await add(id, 'pics/test1', 'ДАЧА')).status, 409);
  assert.equal((await add(mama, 'pics/test1', 'дача')).status, 200);   // another user's aliases don't count
  const second = await add(id, 'pics/test1', 'Другая');
  const rename = (share: number, alias: string) => a.json('PATCH', `/api/admin/shares/${share}`, { alias });
  assert.deepEqual(await rename(second.body.id, 'дАчА'), { status: 409, body: { error: 'This user already has a folder named "дАчА"' } });
  assert.equal((await rename(first.body.id, 'дача')).body.alias, 'дача');   // its own name in other letters is fine
  assert.equal((await rename(second.body.id, 'Дача')).status, 409);
});
test('editing a share: only what the patch names changes, the folder never does', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id } = await ta.addUser('papa', 'member');
  await seedTree(ta.media, ['pics/family/xmas/', 'pics/test1/']);
  const add = (relPath: string, alias: string, create = false) => a.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias, create, update: false, delete: false });
  const s1 = (await add('pics/family', 'Family photos', true)).body, s2 = (await add('pics/test1', 'Kids')).body;
  const patch = (share: number, body: unknown) => a.json('PATCH', `/api/admin/shares/${share}`, body);
  const rights = (b: any) => [b.create, b.update, b.delete];
  assert.deepEqual(rights((await patch(s1.id, { update: true })).body), [true, true, false]);
  assert.deepEqual(rights((await patch(s1.id, { create: false, delete: true })).body), [false, true, true]);
  assert.deepEqual(rights((await patch(s1.id, {})).body), [false, true, true]);
  assert.deepEqual(rights((await patch(s1.id, { update: 'yes', delete: null })).body), [false, false, false]);   // not true is false (G6)
  assert.deepEqual((await patch(s1.id, { alias: 'Holiday', relPath: 'other', userId: 99, id: 99, diskPath: '/etc' })).body, { ...s1, alias: 'Holiday', create: false, update: false, delete: false });
  assert.deepEqual(await patch(s1.id, { alias: 'kids' }), { status: 409, body: { error: 'This user already has a folder named "kids"' } });
  assert.equal((await patch(s1.id, { alias: 'HOLIDAY' })).body.alias, 'HOLIDAY');   // its own name in other letters
  for (const [alias, error] of [['a/b', 'Name can\'t contain any of: / \\ : * ? " < > |'], ['', "Name can't be empty"], [5, "Name can't be empty"], [null, "Name can't be empty"]] as const)
    assert.deepEqual(await patch(s1.id, { alias }), { status: 400, body: { error } }, String(alias));
  assert.deepEqual(await patch(999, { delete: true }), NOT_FOUND);
  assert.equal((await a.json('GET', `/api/admin/users/${id}/shares`)).body.find((s: any) => s.id === s1.id).alias, 'HOLIDAY');   // refused patches changed nothing
  // the rest of the system reads what is stored here: the resolver finds the folder through the alias, with the rights as patched
  const papa = getMe(ta.db, id)!;
  await patch(s1.id, { create: true });
  const loc = await locate(ta.app, papa, '/HOLIDAY/xmas');
  assert.deepEqual([loc.abs, loc.rights], [join(ta.media, 'pics/family/xmas'), { create: true, update: false, delete: false }]);
  assert.deepEqual(await a.json('DELETE', `/api/admin/shares/${s2.id}`), { status: 200, body: { ok: true } });
  assert.deepEqual(await a.json('DELETE', `/api/admin/shares/${s2.id}`), NOT_FOUND);
  assert.deepEqual((await a.json('GET', `/api/admin/users/${id}/shares`)).body.map((s: any) => s.alias), ['HOLIDAY']);
  await assert.rejects(locate(ta.app, papa, '/Kids'), { status: 404 });   // and what was removed is gone for the user at once
});
test('a share is listed by alias in natural order, and is available only while its folder is one', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id } = await ta.addUser('papa', 'member');
  const folderOf: Record<string, string> = { 'résumé': 'f1', resume: 'f2', b10: 'f3', b2: 'f4', a: 'f5' };
  await seedTree(ta.media, Object.values(folderOf).map((f) => f + '/'));
  for (const [alias, relPath] of Object.entries(folderOf)) await a.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias, ...NO_RIGHTS });
  const list = async () => (await a.json('GET', `/api/admin/users/${id}/shares`)).body.map((s: any) => [s.alias, s.available]);
  // 2 before 10; resume and résumé are one name to the collator, so the code-unit order breaks the tie (G7)
  assert.deepEqual(await list(), [['a', true], ['b2', true], ['b10', true], ['resume', true], ['résumé', true]]);
  await rm(join(ta.media, folderOf.a), { recursive: true });          // gone
  await rm(join(ta.media, folderOf.b2), { recursive: true });         // replaced by a file
  await writeFile(join(ta.media, folderOf.b2), 'not a folder');
  assert.deepEqual(await list(), [['a', false], ['b2', false], ['b10', true], ['resume', true], ['résumé', true]]);
});
test('rewriteSharePaths follows a renamed folder, in one transaction', () => {
  const db = openDb(':memory:');
  db.prepare("insert into users (username, display_name, role, password_hash, prefs, created_at) values ('a', 'A', 'member', 'x', '{}', 0), ('b', 'B', 'member', 'x', '{}', 0)").run();
  const add = (user: number, alias: string, rel: string) => db.prepare('insert into shares (user_id, alias, rel_path) values (?, ?, ?)').run(user, alias, rel);
  const rels = () => db.prepare('select rel_path from shares order by id').all().map((r) => r.rel_path);
  add(1, 'All', 'pics'); add(1, 'Family', 'pics/family'); add(2, 'Family', 'pics/family'); add(1, 'Extra', 'pics-extra/x'); add(1, 'Other', 'other'); add(2, 'Case', 'Pics/x');
  assert.equal(rewriteSharePaths(db, 'pics', 'photos'), 3);   // the folder itself and what is below it, for every user; not a sibling that shares the prefix, not another letter case
  assert.deepEqual(rels(), ['photos', 'photos/family', 'photos/family', 'pics-extra/x', 'other', 'Pics/x']);
  assert.equal(rewriteSharePaths(db, 'photos/family', 'photos/fam'), 2);
  assert.equal(rewriteSharePaths(db, 'nothing', 'x'), 0);
  add(2, 'Under', 'a_c'); add(2, 'Wild', 'abc/x'); add(2, 'Pct', '50%');
  assert.equal(rewriteSharePaths(db, 'a_c', 'z'), 1);   // _ and % are plain characters here
  assert.equal(rewriteSharePaths(db, '50%', 'half'), 1);
  assert.deepEqual(rels().slice(-3), ['z', 'abc/x', 'half']);
  add(1, 'One', 'k/one'); add(1, 'Two', 'k/two'); add(1, 'Taken', 'm/two');
  const before = rels();
  assert.throws(() => rewriteSharePaths(db, 'k', 'm'), /UNIQUE/);   // k/two would land on a share of the same user
  assert.deepEqual(rels(), before);                                // and then k/one did not move either
  assert.equal(db.isTransaction, false);
});
test('browse disk for the folder picker', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  await seedTree(ta.media, TREE, LINKS);
  assert.deepEqual((await a.json('GET', '/api/admin/browse?path=')).body, { path: '', folders: ['other', 'pics'] });
  assert.deepEqual((await a.json('GET', '/api/admin/browse?path=pics')).body, { path: 'pics', folders: ['family', 'test1'] });
  assert.equal((await a.json('GET', '/api/admin/browse?path=../')).status, 400);
});
test('browse lists folders only, in natural order, whatever the characters in their names', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  await seedTree(ta.media, ['b2/', 'B2/', 'b10/', 'a/', '.hid/', '@eaDir/', '$RECYCLE.BIN/', '#recycle/', 'lost+found/', 'file.jpg', 'Дача #2 (2024)/IMG 50%.jpg', 'Дача #2 (2024)/sub/', 'Дача #2 (2024)/50% done/'], [['a', 'link'], ['file.jpg', 'filelink']]);
  const browse = (path?: string) => a.json('GET', '/api/admin/browse' + (path === undefined ? '' : '?path=' + encodeURIComponent(path)));
  const root = ['a', 'B2', 'b2', 'b10', 'Дача #2 (2024)'];   // B2 and b2 are one name to the collator: the code-unit order breaks the tie (G7)
  assert.deepEqual((await browse()).body, { path: '', folders: root });                 // no path at all is the root, too
  assert.deepEqual((await browse('Дача #2 (2024)')).body, { path: 'Дача #2 (2024)', folders: ['50% done', 'sub'] });
  assert.deepEqual((await browse('a')).body, { path: 'a', folders: [] });
  assert.deepEqual(await browse('file.jpg'), { status: 400, body: { error: PICK } });
  assert.deepEqual(await browse('nothing'), NOT_FOUND);
  for (const bad of ['..', '../', 'a/..', '/a', 'a/', '.hid', 'a/.x', '@eaDir']) assert.deepEqual(await browse(bad), { status: 400, body: { error: 'Invalid path' } }, bad);
});
test('every change an administrator makes is logged with who made it (R3)', async (t) => {
  const events = capture(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  await seedTree(ta.media, ['pics/family/']);
  const by = { by: 'root', ip: '127.0.0.1' };
  assert.equal((await a.json('POST', '/api/admin/users', { username: 'x', displayName: 'X', password: 'password123', role: 'member' })).status, 400);   // a refused request leaves no line
  const papa = (await a.json('POST', '/api/admin/users', { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' })).body;
  await a.json('PATCH', `/api/admin/users/${papa.id}`, { displayName: 'Dad', role: 'admin' });
  await a.json('POST', `/api/admin/users/${papa.id}/password`, { password: 'another-pass1' });
  const share = (await a.json('POST', `/api/admin/users/${papa.id}/shares`, { relPath: 'pics/family', alias: 'Family', create: true, update: false, delete: false })).body;
  await a.json('PATCH', `/api/admin/shares/${share.id}`, { alias: 'Fam', delete: true });
  await a.json('DELETE', `/api/admin/shares/${share.id}`);
  await a.json('DELETE', `/api/admin/users/${papa.id}`);
  const fields = { username: 'papa', alias: 'Fam', relPath: 'pics/family', create: true, update: false, delete: true };
  assert.deepEqual(events(), [
    { event: 'user_created', id: papa.id, username: 'papa', role: 'member', ...by },
    { event: 'user_updated', id: papa.id, username: 'papa', role: 'admin', ...by },
    { event: 'password_set', username: 'papa', ...by },
    { event: 'share_added', id: share.id, ...fields, alias: 'Family', delete: false, ...by },
    { event: 'share_updated', id: share.id, ...fields, ...by },
    { event: 'share_removed', id: share.id, ...fields, ...by },
    { event: 'user_removed', id: papa.id, username: 'papa', ...by },
  ]);
});
test('request bodies must be small JSON objects (R2)', async (t) => {
  quiet(t);
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const send = async (method: string, path: string, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
    const r = await a.req(method, path, body, headers);
    return { status: r.status, body: await r.json() };
  };
  const targets: [string, string][] = [['POST', '/api/admin/users'], ['PATCH', '/api/admin/users/1'], ['POST', '/api/admin/users/1/password'], ['POST', '/api/admin/users/1/shares'], ['PATCH', '/api/admin/shares/1']];
  for (const [method, path] of targets) {
    for (const body of ['[]', 'null', '5', '"x"', 'true', '{"a":']) assert.deepEqual(await send(method, path, body), { status: 400, body: { error: 'Invalid JSON' } }, `${method} ${path} ${body}`);
    assert.deepEqual(await send(method, path, '{}', { 'content-type': 'text/plain' }), { status: 415, body: { error: 'Expected JSON' } }, `${method} ${path}`);
    assert.deepEqual(await send(method, path, JSON.stringify({ filler: 'x'.repeat(9000) })), { status: 413, body: { error: 'Request too large' } }, `${method} ${path}`);
  }
});
test('setPassword holds the write lock from the session check to the revoke (R4a)', async (t) => {
  const file = join(await tempDir(), 'gallery.db');
  const db = openDb(file), other = openDb(file);   // `other` stands for the CLI: a second connection to the same file
  t.after(() => { db.close(); other.close(); });
  other.exec('PRAGMA busy_timeout = 0');           // a write that meets a lock fails at once
  const alice = await createUser(db, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'member' });
  const mine = createSession(db, alice.id, true, 'ip', 'ua'), second = createSession(db, alice.id, true, 'ip', 'ua');
  // Before each statement setPassword prepares, the second connection tries to write. If setPassword holds the lock, that fails.
  const prepare = db.prepare.bind(db);
  const seen: string[] = [], slipped: string[] = [];
  const probe = () => {
    try { other.exec('update users set display_name = display_name'); return true; } catch (err) { assert.match((err as Error).message, /locked/); return false; }
  };
  db.prepare = (sql: string) => { seen.push(sql); if (probe()) slipped.push(sql); return prepare(sql); };
  await setPassword(db, alice.id, 'newpassword1', mine);
  assert.ok(seen.some((s) => s.startsWith('select')) && seen.some((s) => s.startsWith('update users')) && seen.some((s) => s.startsWith('delete from sessions')), seen.join('\n'));
  assert.deepEqual(slipped, [], 'the second connection got a write in between');
  // a refusal lets go of the lock again
  await assert.rejects(setPassword(db, alice.id, 'newpassword1', 'not-a-session'), { status: 401, message: 'Sign in required' });
  await assert.rejects(setPassword(db, 999, 'newpassword1'), { status: 404, message: 'Not found' });
  db.prepare = prepare;
  assert.equal(db.isTransaction, false);
  assert.equal(probe(), true);
  assert.ok(touchSession(db, mine)); assert.equal(touchSession(db, second), null);   // the kept session stays, the other one ended
});
test('seedTree: folders, real photo bytes and symlinks', async () => {
  const root = await tempDir();
  await seedTree(root, ['a/', 'a/b/c.jpg', 'a/d.png', 'e.mp4'], [['a', 'link']]);
  const [exif, png] = [await readFile(fixture('exif-rot6.jpg')), await readFile(fixture('plain.png'))];
  assert.deepEqual([await readFile(join(root, 'a/b/c.jpg')), await readFile(join(root, 'a/d.png')), await readFile(join(root, 'e.mp4'))], [exif, png, png]);
  assert.equal((await stat(join(root, 'a'))).isDirectory(), true);
  assert.equal((await lstat(join(root, 'link'))).isSymbolicLink(), true);
});

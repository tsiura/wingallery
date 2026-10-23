import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import fsp, { chmod, mkdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { requireUser } from '../auth.ts';
import { readForm } from '../http.ts';
import { ZIP_LIMIT, streamZip } from '../zip.ts';
import { seedTree, startTestApp } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

const FORM = 'application/x-www-form-urlencoded';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const zipNames = (buf: Buffer) => { const out: string[] = []; for (let i = buf.indexOf('PK\x01\x02', 0, 'latin1'); i !== -1; i = buf.indexOf('PK\x01\x02', i + 4, 'latin1')) out.push(buf.toString('utf8', i + 46, i + 46 + buf.readUInt16LE(i + 28))); return out; };
const zip = (c: Client, paths: string[], ct = 'application/x-www-form-urlencoded') => c.req('POST', '/media/zip', new URLSearchParams({ paths: JSON.stringify(paths) }).toString(), { 'content-type': ct });

// The central directory of a zip: for each entry its name, its compression method (0 = stored) and the modification time of its UT field, in seconds.
const central = (buf: Buffer) => {
  const out: { name: string; method: number; mtime: number | null }[] = [];
  for (let i = buf.indexOf('PK\x01\x02', 0, 'latin1'); i !== -1; i = buf.indexOf('PK\x01\x02', i + 4, 'latin1')) {
    const at = i + 46 + buf.readUInt16LE(i + 28);   // the extra field follows the name
    const ut = buf.readUInt16LE(i + 30) >= 9 && buf.readUInt16LE(at) === 0x5455;
    out.push({ name: buf.toString('utf8', i + 46, at), method: buf.readUInt16LE(i + 10), mtime: ut ? buf.readUInt32LE(at + 5) : null });
  }
  return out;
};
const bytesOf = async (r: Response) => Buffer.from(await r.arrayBuffer());
const namesOf = async (c: Client, paths: string[]) => {
  const r = await zip(c, paths);
  assert.equal(r.status, 200);
  return zipNames(await bytesOf(r)).sort();
};
// The name the download is saved under, decoded from the RFC 5987 part of the header.
const savedAs = async (c: Client, paths: string[]) => {
  const r = await zip(c, paths);
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  return decodeURIComponent(r.headers.get('content-disposition')!.split("filename*=UTF-8''")[1]);
};
const refused = async (r: Response) => [r.status, (await r.json()).error];
// Status, type and JSON body of an answer that is not a zip, for a test that expects an error: a zip in its place is a failed assert, not a parse error.
const answer = async (r: Response) => {
  const type = r.headers.get('content-type');
  return [r.status, type, type?.startsWith('application/json') ? await r.json() : null];
};
// The log lines written while the test runs, parsed; they do not reach the console.
const logged = (t: TestContext): Record<string, any>[] => {
  const lines: Record<string, any>[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(JSON.parse(line)); });
  return lines;
};
// How many descriptors of this process are open on `file` (Linux only: the tests that use it skip themselves elsewhere).
const holdingOpen = (file: string) => readdirSync('/proc/self/fd').filter((fd) => { try { return readlinkSync('/proc/self/fd/' + fd) === file; } catch { return false; } }).length;
// `n` empty folders in `dir`, made a few hundred at a time.
async function emptyFolders(dir: string, n: number) {
  for (let from = 0; from < n; from += 500)
    await Promise.all(Array.from({ length: Math.min(500, n - from) }, (_, i) => mkdir(join(dir, `d${String(from + i).padStart(5, '0')}`), { recursive: true })));
}
// A spy on readdir: the folders read under `root`, in order. `hold` runs just before each is read and can keep the walk waiting.
// listing.ts imports readdir by name, so the module has to be told that the property of fs/promises has changed.
function watchReads(t: TestContext, root: string, hold: (path: string) => Promise<void> | void = () => {}): string[] {
  const reads: string[] = [];
  const real = fsp.readdir;
  const spy = t.mock.method(fsp, 'readdir', async (path: any, ...rest: any[]) => {
    if (String(path).startsWith(root)) {
      reads.push(String(path));
      await hold(String(path));
    }
    return (real as any)(path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return reads;
}

let ta: TestApp, a: Client, papa: Client;

before(async () => {
  ta = await startTestApp();
  // pics/family/{a.jpg, notes.txt, xmas/{b.jpg, .DS_Store, c.txt, empty/, Дача #2 (2024)/IMG 50%.jpg}}, small/s.jpg.
  // xmas/ln leads out of the share, to other/, which holds a photo; inside.jpg leads to a.jpg, inside the share; lnk is a link to small/, shared as Linked.
  await seedTree(ta.media, ['pics/family/a.jpg', 'pics/family/notes.txt', 'pics/family/xmas/b.jpg', 'pics/family/xmas/.DS_Store', 'pics/family/xmas/c.txt',
    'pics/family/xmas/empty/', 'pics/family/xmas/Дача #2 (2024)/IMG 50%.jpg', 'small/s.jpg', 'other/x.jpg'],
  [['../../../other', 'pics/family/xmas/ln'], ['a.jpg', 'pics/family/inside.jpg'], ['small', 'lnk']]);
  a = await ta.admin();
  const p = await ta.addUser('papa', 'member');
  papa = p.client;
  const share = ta.db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, 0, 0, 0)');
  share.run(p.id, 'Fam', 'pics/family');
  share.run(p.id, 'Small', 'small');
  share.run(p.id, 'Linked', 'lnk');
});
after(() => ta.close());

test('zips media only, keeps folders, unicode names (Review Focus 1)', async () => {
  const r = await zip(papa, ['/Fam/xmas', '/Fam/a.jpg']);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition')!, /filename\*=UTF-8''Fam\.zip$/);
  assert.deepEqual(zipNames(Buffer.from(await r.arrayBuffer())).sort(), ['a.jpg', 'xmas/b.jpg', 'xmas/empty/', 'xmas/Дача #2 (2024)/IMG 50%.jpg'].sort());
});
test('single folder name, access control, content type', async () => {
  assert.match((await zip(papa, ['/Fam/xmas'])).headers.get('content-disposition')!, /xmas\.zip$/);
  assert.equal((await zip(papa, ['/Other/x.jpg'])).status, 404);
  assert.equal((await zip(papa, ['/Fam/a.jpg'], 'application/json')).status, 415);
});

test('anonymous: 401, whatever the body (F15)', async () => {
  const anon = ta.client();
  for (const ct of [FORM, 'application/json']) {
    const r = await zip(anon, ['/Fam/a.jpg'], ct);
    assert.deepEqual([r.status, await r.json()], [401, { error: 'Sign in required' }]);
  }
});

test('a form posted from another site, or with an empty origin, is refused', async () => {
  const body = new URLSearchParams({ paths: JSON.stringify(['/Fam/a.jpg']) }).toString();
  for (const origin of ['https://evil.example', 'null', ''])
    assert.deepEqual(await refused(await papa.req('POST', '/media/zip', body, { 'content-type': FORM, origin })), [403, "Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES."], origin);
});

test('a body that names nothing valid is refused before anything is streamed (G6)', async () => {
  const body = (paths: string) => papa.req('POST', '/media/zip', new URLSearchParams({ paths }).toString(), { 'content-type': FORM });
  assert.deepEqual(await refused(await papa.req('POST', '/media/zip', '', { 'content-type': FORM })), [400, 'Invalid JSON'], 'no paths at all');
  assert.deepEqual(await refused(await papa.req('POST', '/media/zip', 'paths=%5B', { 'content-type': FORM })), [400, 'Invalid JSON'], 'cut off in the middle');
  for (const wrong of ['nope', '{"a":1}', '"/Fam/a.jpg"', 'null', '7']) assert.deepEqual(await refused(await body(wrong)), [400, 'Invalid JSON'], wrong);
  for (const wrong of ['[]', '[1]', '[null]', '[["/Fam/a.jpg"]]', '[""]', '["Fam/a.jpg"]', '["/Fam/../x.jpg"]', '["/Fam/xmas/.DS_Store"]', '["/Fam/a.jpg", 5]'])
    assert.deepEqual(await refused(await body(wrong)), [400, 'Invalid path'], wrong);
});
test('what the listings do not show is not there to zip: 404, and the other items are not zipped either', async () => {
  assert.equal((await zip(papa, ['/Fam/a.jpg'])).status, 200, 'the same request, with a path that is there');
  // a member's root, a file of another kind, nothing, a file taken for a folder, a link out of the share, a link inside it, an alias that is not theirs
  for (const path of ['/', '/Fam/notes.txt', '/Fam/nope.jpg', '/Fam/a.jpg/x', '/Fam/xmas/ln', '/Fam/inside.jpg', '/Nope'])
    for (const paths of [[path], ['/Fam/a.jpg', path]]) assert.deepEqual(await refused(await zip(papa, paths)), [404, 'Not found'], JSON.stringify(paths));
});

test('the folder of a share may be a link, as the listings take it; a link below one is not followed', async () => {
  assert.deepEqual(await namesOf(papa, ['/Linked']), ['Linked/s.jpg']);
  assert.equal(await savedAs(papa, ['/Linked']), 'Linked.zip');
  assert.deepEqual(await namesOf(papa, ['/Fam/xmas']), ['xmas/b.jpg', 'xmas/empty/', 'xmas/Дача #2 (2024)/IMG 50%.jpg'], 'xmas/ln, which leads out of the share, is not in it');
});

test('two items that get one name: the later one is numbered, so the zip holds no entry twice (R2)', async () => {
  await seedTree(ta.media, ['lab/clash/one/x.jpg', 'lab/clash/two/x.jpg', 'lab/clash/x.jpg/inner.jpg']);   // x.jpg in two folders, and a folder named x.jpg
  const paths = ['/lab/clash/one/x.jpg', '/lab/clash/x.jpg', '/lab/clash/two/x.jpg', '/lab/clash/one/x.jpg'];
  assert.deepEqual(await namesOf(a, paths), ['x (1).jpg/inner.jpg', 'x (2).jpg', 'x.jpg']);
  assert.equal(await savedAs(a, paths), 'one.zip', 'the folder the first item is taken from');
});

test('a selection repeated, or inside another selected folder, is zipped once (G11)', async (t) => {
  const looked = t.mock.method(ta.db, 'prepare');   // a spy: every path that is resolved reads the user's shares
  assert.deepEqual(await namesOf(papa, Array(50).fill('/Fam/a.jpg')), ['a.jpg']);
  assert.equal(looked.mock.calls.filter((c) => /from shares/.test(String(c.arguments[0]))).length, 1, 'fifty copies of a path are resolved once');
  const xmas = ['xmas/b.jpg', 'xmas/empty/', 'xmas/Дача #2 (2024)/IMG 50%.jpg'].sort();
  const paths = ['/Fam/xmas', '/Fam/xmas', '/fam/xmas', '/Fam/xmas/b.jpg', '/Fam/xmas/Дача #2 (2024)', '/Fam/xmas/empty', '/FAM/xmas/b.jpg'];
  assert.deepEqual(await namesOf(papa, paths), xmas);
  assert.deepEqual(await namesOf(papa, paths.toReversed()), xmas, 'whichever comes first');
  assert.equal(await savedAs(papa, ['/Fam/xmas/b.jpg', '/Fam/xmas']), 'xmas.zip', 'what is left is one folder');
  assert.deepEqual(await namesOf(papa, ['/Fam/a.jpg', '/Fam/a.jpg', '/fam/a.jpg']), ['a.jpg']);
});

test('zip names: a folder is called what the user calls it, a selection what it is taken from, the roots by the gallery', async () => {
  assert.equal(await savedAs(papa, ['/Fam']), 'Fam.zip', 'the alias, not the folder on disk');
  assert.equal(await savedAs(papa, ['/Fam/a.jpg']), 'Fam.zip');
  assert.equal(await savedAs(papa, ['/Fam/xmas/b.jpg', '/Fam/xmas/Дача #2 (2024)']), 'xmas.zip');
  assert.equal(await savedAs(papa, ['/Fam/xmas/Дача #2 (2024)']), 'Дача #2 (2024).zip');
  assert.equal(await savedAs(papa, ['/Fam/xmas/Дача #2 (2024)/IMG 50%.jpg']), 'Дача #2 (2024).zip', 'a path with a space, a #, parentheses and a % goes through the form');
  assert.deepEqual(await namesOf(papa, ['/Fam/xmas/Дача #2 (2024)/IMG 50%.jpg']), ['IMG 50%.jpg']);
  assert.equal(await savedAs(papa, ['/Fam', '/Small']), 'Home Gallery.zip');
  assert.deepEqual(await namesOf(papa, ['/Fam/xmas/empty', '/Small']), ['Small/s.jpg', 'empty/']);
  assert.equal(await savedAs(a, ['/pics']), 'pics.zip');
  assert.equal(await savedAs(a, ['/pics', '/small']), 'Home Gallery.zip');
});
test('the administrator can zip the root: it is the gallery', async () => {
  const tb = await startTestApp();
  try {
    await seedTree(tb.media, ['p/a.jpg', 'q/']);
    const root = await tb.admin();
    assert.deepEqual(await namesOf(root, ['/', '/p']), ['Home Gallery/p/a.jpg', 'Home Gallery/q/']);
    assert.equal(await savedAs(root, ['/']), 'Home Gallery.zip');
    assert.deepEqual(await namesOf(root, ['/p', '/q']), ['p/a.jpg', 'q/']);
  } finally {
    await tb.close();
  }
});

test('names the zip format cannot hold are made safe, and still never meet; the others stay as they are', async () => {
  // a backslash is a separator to the format (a\..\x would climb out), and a name that starts like C:x is a path on a drive
  await seedTree(ta.media, ['lab/odd/a\\b.jpg', 'lab/odd/a_b.jpg', 'lab/odd/sub\\..\\x.jpg', 'lab/odd/C:top.jpg', 'lab/odd/d\\e/f.jpg', 'lab/odd/Ünï cödé (1) #2.jpg']);
  assert.deepEqual(await namesOf(a, ['/lab/odd']),
    ['odd/C:top.jpg', 'odd/Ünï cödé (1) #2.jpg', 'odd/a_b (1).jpg', 'odd/a_b.jpg', 'odd/d_e/f.jpg', 'odd/sub_.._x.jpg'].sort());
  assert.deepEqual(await namesOf(a, ['/lab/odd/C:top.jpg']), ['C_top.jpg']);
});

test('files are stored as they are, and keep the time they were taken', async () => {
  await seedTree(ta.media, ['lab/times/t.jpg']);
  const taken = new Date('2021-03-04T05:06:07Z');
  await utimes(join(ta.media, 'lab/times/t.jpg'), taken, taken);
  assert.deepEqual(central(await bytesOf(await zip(a, ['/lab/times']))), [{ name: 'times/t.jpg', method: 0, mtime: taken.getTime() / 1000 }]);
});

test('a file dated before 1970 is zipped, as a folder or by itself: yazl throws on such a time in the middle of the stream, and that ends the process', { timeout: 20_000 }, async () => {
  await seedTree(ta.media, ['lab/old/a.jpg', 'lab/old/b.jpg']);
  const then = new Date('1960-01-01T00:00:00Z');
  await utimes(join(ta.media, 'lab/old/a.jpg'), then, then);
  const inFolder = central(await bytesOf(await zip(a, ['/lab/old'])));
  assert.deepEqual(inFolder.map((e) => [e.name, e.mtime === 0]), [['old/a.jpg', true], ['old/b.jpg', false]], 'held at the epoch');
  assert.deepEqual(central(await bytesOf(await zip(a, ['/lab/old/a.jpg']))).map((e) => [e.name, e.mtime]), [['a.jpg', 0]]);
});

test('a folder the server may not read counts as empty, as in the listings', { skip: process.getuid?.() === 0 }, async (t) => {
  await seedTree(ta.media, ['lab/ro/ok.jpg', 'lab/ro/locked/x.jpg']);
  const locked = join(ta.media, 'lab/ro/locked');
  await chmod(locked, 0o000); t.after(() => chmod(locked, 0o755));
  assert.deepEqual(await namesOf(a, ['/lab/ro']), ['ro/locked/', 'ro/ok.jpg']);
  assert.deepEqual(await namesOf(a, ['/lab/ro/locked']), ['locked/']);
});

// A folder whose first file is far larger than the sockets between server and client hold, so the server is still reading it while the test acts.
// The second file sorts after it, and is opened only when the first has been sent.
async function bigFolder(name: string, mib: number) {
  await seedTree(ta.media, [`lab/${name}/z-late.jpg`]);
  const big = join(ta.media, `lab/${name}/a-big.mp4`);
  await writeFile(big, '');
  await truncate(big, mib * 1024 * 1024);   // sparse
  return { big, late: join(ta.media, `lab/${name}/z-late.jpg`) };
}
// fetch rather than the client: the test needs to hang up.
const post = (paths: string[], signal?: AbortSignal) =>
  fetch(ta.url + '/media/zip', { method: 'POST', headers: { cookie: a.cookie!, origin: ta.url, 'content-type': FORM }, body: new URLSearchParams({ paths: JSON.stringify(paths) }), signal });

test('a client that hangs up mid-zip costs no error line and no open file', { skip: !existsSync('/proc/self/fd'), timeout: 30_000 }, async (t) => {
  const { big } = await bigFolder('hang', 512);
  const lines = logged(t);
  const gone = new Promise<void>((resolve) => ta.app.server.once('request', (_req, res) => { res.on('close', () => resolve()); }));   // the next request is the zip
  const hangUp = new AbortController();
  const r = await post(['/lab/hang'], hangUp.signal);
  assert.equal(r.status, 200);
  await r.body!.getReader().read();   // the server is streaming now
  assert.equal(holdingOpen(big), 1);
  hangUp.abort();
  await gone;
  await sleep(50);                    // the stream's failure reaches the handler a few ticks later
  assert.equal(holdingOpen(big), 0, 'the file is closed');
  assert.deepEqual(lines, []);
  assert.equal((await zip(papa, ['/Fam/a.jpg'])).status, 200, 'the server carries on');
});

test('a client that has left stops the walk: no folder is read after it, and no error line is written (R3)', { timeout: 30_000 }, async (t) => {
  const root = join(ta.media, 'lab/wide');
  await emptyFolders(root, 300);
  const lines = logged(t);
  const gone = new Promise<void>((resolve) => ta.app.server.once('request', (_req, res) => { res.on('close', () => resolve()); }));   // the next request is the zip
  const hangUp = new AbortController();
  let first = true;
  // The first folder is not read until the client has hung up and the server has seen it, so the walk is certain to be under way when the client leaves.
  const reads = watchReads(t, root, async () => {
    if (!first) return;
    first = false;
    hangUp.abort();
    await gone;
  });
  await post(['/lab/wide'], hangUp.signal).catch(() => null);
  await gone;
  await sleep(100);   // a walk that went on would have read more of the 300 folders by now (a read takes well under a millisecond)
  assert.deepEqual(reads, [root], 'the folder that was being read, and no other');
  assert.deepEqual(lines, []);
  assert.equal((await zip(papa, ['/Fam/a.jpg'])).status, 200, 'the server carries on');
});

test('a photo followed by thousands of folders with nothing visible in them is zipped; yazl pumps a queued run of them by recursion, a frame each', { timeout: 60_000 }, async () => {
  // The photo comes first, and the folders queue behind it while it is read. About 6000 of them overflowed the stack here; 10000 leave room for another machine.
  await seedTree(ta.media, ['lab/runs/a.jpg']);
  await emptyFolders(join(ta.media, 'lab/runs'), 10_000);
  const names = await namesOf(a, ['/lab/runs']);
  assert.deepEqual([names.length, names.filter((n) => n.endsWith('/')).length, names.includes('runs/a.jpg')], [10_001, 10_000, true]);
});

test('more files and folders than the limit are refused with 413 before a byte is sent, and the walk stops as soon as it is passed', async (t) => {
  // the same route behind the same pipeline, with a small limit
  ta.app.router.add('POST', '/test/zip/:limit', async (ctx) => {
    const user = requireUser(ctx);
    await streamZip(ctx, ta.app, user, JSON.parse((await readForm(ctx)).get('paths')!), Number(ctx.params.limit));
  });
  const limited = (limit: number, paths: string[]) =>
    a.req('POST', `/test/zip/${limit}`, new URLSearchParams({ paths: JSON.stringify(paths) }).toString(), { 'content-type': FORM });
  // cap/ holds f1.jpg, f2.jpg and sub/ with g.jpg in it. Selecting cap/ is five things (the folder, its three entries and g.jpg); selecting the three entries is four.
  await seedTree(ta.media, ['lab/cap/f1.jpg', 'lab/cap/f2.jpg', 'lab/cap/sub/g.jpg']);
  const items = ['/lab/cap/f1.jpg', '/lab/cap/f2.jpg', '/lab/cap/sub'];
  const fit: [number, string[]][] = [[5, ['/lab/cap']], [4, items]];
  for (const [limit, paths] of fit) {
    const r = await limited(limit, paths);
    assert.equal(r.status, 200, `${limit} fit`);
    assert.equal(zipNames(await bytesOf(r)).length, 3);
  }
  const over: [number, string[]][] = [[4, ['/lab/cap']], [3, ['/lab/cap']], [3, items]];
  for (const [limit, paths] of over) {
    const r = await limited(limit, paths);
    assert.deepEqual(await answer(r), [413, 'application/json; charset=utf-8', { error: `Too many files for one download (limit ${limit})` }], `${limit} do not`);
  }
  // three folders of three files: with a limit of five the first folder is the last one read
  await seedTree(ta.media, ['a', 'b', 'c'].flatMap((d) => [1, 2, 3].map((n) => `lab/cap3/${d}/${n}.jpg`)));
  const reads = watchReads(t, join(ta.media, 'lab/cap3'));
  assert.equal((await limited(5, ['/lab/cap3'])).status, 413);
  assert.deepEqual(reads, [join(ta.media, 'lab/cap3'), join(ta.media, 'lab/cap3/a')]);
});

test('the limit is 20000 files and folders', { timeout: 60_000 }, async () => {
  assert.equal(ZIP_LIMIT, 20_000);
  const dir = join(ta.media, 'lab/limit');
  await mkdir(dir, { recursive: true });
  for (let from = 0; from <= ZIP_LIMIT; from += 500)   // 20001 photos: with the folder itself, one too many
    await Promise.all(Array.from({ length: Math.min(500, ZIP_LIMIT + 1 - from) }, (_, i) => writeFile(join(dir, `p${String(from + i).padStart(5, '0')}.jpg`), '')));
  assert.deepEqual(await answer(await zip(a, ['/lab/limit'])), [413, 'application/json; charset=utf-8', { error: 'Too many files for one download (limit 20000)' }]);
});

for (const [how, swap] of [
  ['removed', (late: string) => rm(late)],
  ['replaced by a symlink to another file', async (late: string) => { await rm(late); await symlink('a-big.mp4', late); }],
] as const) {
  test(`a file ${how} after the zip has started: the download is cut short, and one error line says which (R3)`, { skip: !existsSync('/proc/self/fd'), timeout: 30_000 }, async (t) => {
    const { big, late } = await bigFolder(`cut-${how.split(' ')[0]}`, 64);
    const lines = logged(t);
    const r = await post([`/lab/cut-${how.split(' ')[0]}`]);
    assert.equal(r.status, 200);
    const body = r.body!.getReader();
    await body.read();
    await sleep(100);   // the server has sent what the sockets take, and waits for us
    await swap(late);
    await assert.rejects(async () => { while (!(await body.read()).done); });   // a download that does not end like a zip: the connection is cut
    await sleep(50);
    const errors = lines.filter((l) => l.event === 'error');
    assert.equal(errors.length, 1, JSON.stringify(lines));
    assert.match(errors[0].message, /z-late\.jpg/);
    assert.equal(holdingOpen(big), 0, 'the file is closed');
    assert.equal((await zip(papa, ['/Fam/a.jpg'])).status, 200, 'the server carries on');
  });
}
test('a file the server may not open once the zip has started: cut short, one error line (R3)', { skip: process.getuid?.() === 0, timeout: 30_000 }, async (t) => {
  await seedTree(ta.media, ['lab/noread/a.jpg', 'lab/noread/b.jpg']);
  const locked = join(ta.media, 'lab/noread/b.jpg');
  await chmod(locked, 0o000); t.after(() => chmod(locked, 0o644));
  const lines = logged(t);
  await assert.rejects(async () => { await (await post(['/lab/noread'])).arrayBuffer(); });
  await sleep(50);
  assert.deepEqual(lines.filter((l) => l.event === 'error').map((l) => /EACCES.*b\.jpg/.test(l.message)), [true]);
});

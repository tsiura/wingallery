import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Me } from '../../shared/types.ts';
import { pLimit } from '../limit.ts';
import { invalidateStats, listFiles } from '../listing.ts';
import { exifToWallClock, extractMeta, getMeta, instantToWallClock } from '../meta.ts';
import { runProcess } from '../proc.ts';
import type { RunFn } from '../proc.ts';
import { getMe } from '../users.ts';
import { locate } from '../vpath.ts';
import { fixture, hasCommand, seedTree, startTestApp, tempDir } from './helpers.ts';
import type { Client, TestApp } from './helpers.ts';

const INVALID = { status: 400, body: { error: 'Invalid path' } };
const NOT_FOUND = { status: 404, body: { error: 'Not found' } };
const NOT_MEDIA = { status: 400, body: { error: 'Not a media file' } };

let ta: TestApp, papa: Client, papaMe: Me, admin: Client;

const get = (c: Client, route: string, path: string) => c.json('GET', `/api/${route}?path=${encodeURIComponent(path)}`);
const addShare = (userId: number, alias: string, relPath: string, create = false) =>
  ta.db.prepare('insert into shares (user_id, alias, rel_path, can_create, can_update, can_delete) values (?, ?, ?, ?, 0, 0)').run(userId, alias, relPath, Number(create));

// A HEIC shell with just the boxes exifr and image-size read: ispe says 64x64, as image-size misreads a cropped file; the Exif item says w x h
// and 2021-06-15 12:34:56. `pad` bytes of stand-in picture data come before the Exif item in mdat, as when a writer stores the Exif after the image.
function heicWithExif(w: number, h: number, orientation: number, pad = 0): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v, 4 * i)); return b; };
  const box = (type: string, ...body: Buffer[]) => { const data = Buffer.concat(body); return Buffer.concat([u32(8 + data.length), Buffer.from(type, 'latin1'), data]); };
  const tag = (id: number, type: number, value: number, count = 1) => Buffer.concat([u16(id), u16(type), u32(count), type === 3 ? Buffer.concat([u16(value), u16(0)]) : u32(value)]);
  const tiff = Buffer.concat([Buffer.from('MM\0*', 'latin1'), u32(8),
    u16(2), tag(0x0112, 3, orientation), tag(0x8769, 4, 38), u32(0),                 // IFD0 at 8: Orientation, and the pointer to the Exif IFD that follows
    u16(3), tag(0x9003, 2, 80, 20), tag(0xa002, 4, w), tag(0xa003, 4, h), u32(0),    // Exif IFD at 38: DateTimeOriginal (its 20 bytes lie at 80), ExifImageWidth, ExifImageHeight
    Buffer.from('2021:06:15 12:34:56\0', 'latin1')]);
  const exif = Buffer.concat([u32(0), tiff]);                          // exif_tiff_header_offset 0: the TIFF header follows at once
  const infe = (id: number, kind: string) => box('infe', u32(0x02000000), u16(id), u16(0), Buffer.from(kind + '\0', 'latin1'));
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const meta = (at: number) => box('meta', u32(0),
    box('iinf', u32(0), u16(2), infe(1, 'hvc1'), infe(2, 'Exif')),
    box('iloc', u32(0), Buffer.from([0x44, 0x00]), u16(1), u16(2), u16(0), u16(1), u32(at, exif.length)),
    box('iprp', box('ipco', box('ispe', u32(0, 64, 64)))));
  // the Exif item sits in mdat, past its 8-byte header and the padding
  return Buffer.concat([ftyp, meta(ftyp.length + meta(0).length + 8 + pad), box('mdat', Buffer.alloc(pad, 0xab), exif)]);
}

before(async () => {
  ta = await startTestApp();
  // pics/family/{a.jpg, notes.txt, .DS_Store, xmas/b.jpg, @eaDir/c.jpg, Дача #2 (2024)/IMG 50%.jpg}, pics/test1/; link pics/family/ln -> xmas
  await seedTree(ta.media, ['pics/family/a.jpg', 'pics/family/notes.txt', 'pics/family/.DS_Store', 'pics/family/xmas/b.jpg', 'pics/family/@eaDir/c.jpg',
    'pics/family/Дача #2 (2024)/IMG 50%.jpg', 'pics/test1/'], [['xmas', 'pics/family/ln']]);
  const p = await ta.addUser('papa', 'member');
  papa = p.client; papaMe = getMe(ta.db, p.id)!;
  // shares for papa: 'Family photos' -> pics/family (create), 'Gone' -> pics/gone (missing; addShare would refuse it, so SQL)
  addShare(p.id, 'Family photos', 'pics/family', true); addShare(p.id, 'Gone', 'pics/gone');
  admin = await ta.admin();
});
after(() => ta.close());

test('exif and wall-clock helpers', () => {
  assert.equal(exifToWallClock('2025:12:24 18:00:00'), '2025-12-24T18:00:00');
  assert.equal(exifToWallClock('0000:00:00 00:00:00'), null);
  assert.match(instantToWallClock(Date.UTC(2025, 6, 11, 10, 0, 0)), /^2025-07-11T\d\d:00:00$/);
});
test('exifToWallClock refuses what is not a date', () => {
  for (const s of ['', 'garbage', '    :  :     :  :  ', '0000:01:01 00:00:00', '2025:13:01 10:00:00', '2025:00:10 10:00:00', '2025:12:32 10:00:00', '2025:12:24 24:00:00', '2025:12:24 18:60:00', '2025:12:24 18:00:60'])
    assert.equal(exifToWallClock(s), null, s);
  assert.equal(exifToWallClock('1999:01:02 03:04:05'), '1999-01-02T03:04:05');
});
test('extractMeta: EXIF photo, plain PNG, video, corrupt file (Review Focus 2)', async () => {
  assert.deepEqual(await extractMeta(fixture('exif-rot6.jpg'), 'photo', 0), { width: 48, height: 64, takenAt: '2025-12-24T18:00:00', duration: null });
  const png = await extractMeta(fixture('plain.png'), 'photo', Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.deepEqual([png.width, png.height, png.takenAt], [32, 16, instantToWallClock(Date.UTC(2024, 0, 2, 3, 4, 5))]);
  const bad = await extractMeta(fixture('corrupt.jpg'), 'photo', 0);
  assert.deepEqual([bad.width, bad.height, bad.takenAt], [null, null, instantToWallClock(0)]);
});
test('extractMeta: video', { skip: !hasCommand('ffprobe') }, async () => {
  const v = await extractMeta(fixture('clip.mp4'), 'video', 0);
  assert.deepEqual([v.width, v.height], [320, 240]); assert.ok(Math.abs(v.duration! - 1) < 0.2);
});
test('extractMeta: ffprobe output decides size, rotation, duration and date', async () => {
  const calls: [string, string[], number][] = [];
  const probe = (out: object | string): RunFn => async (cmd, args, ms) => { calls.push([cmd, args, ms]); return typeof out === 'string' ? out : JSON.stringify(out); };
  const iphone = { streams: [{ width: 1920, height: 1080, tags: {}, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }],
    format: { duration: '2.500000', tags: { creation_time: '2025-07-11T10:00:00.000000Z' } } };
  assert.deepEqual(await extractMeta('/m/v.mov', 'video', 0, probe(iphone)),
    { width: 1080, height: 1920, takenAt: instantToWallClock(Date.UTC(2025, 6, 11, 10, 0, 0)), duration: 2.5 });
  // the whole command is pinned: -protocol_whitelist file comes before the input, so a crafted file can't make ffprobe open a network URL or anything but a file
  assert.deepEqual(calls[0], ['ffprobe', ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:format_tags=creation_time',
    '-protocol_whitelist', 'file', '/m/v.mov'], 15_000]);

  const rotateTag = await extractMeta('/m/v.mp4', 'video', 7, probe({ streams: [{ width: 640, height: 360, tags: { rotate: '270' } }], format: {} }));
  assert.deepEqual(rotateTag, { width: 360, height: 640, takenAt: instantToWallClock(7), duration: null });
  const upsideDown = await extractMeta('/m/v.mp4', 'video', 0, probe({ streams: [{ width: 640, height: 360, side_data_list: [{ rotation: 180 }] }], format: {} }));
  assert.deepEqual([upsideDown.width, upsideDown.height], [640, 360]);

  const nothing = { width: null, height: null, takenAt: instantToWallClock(9), duration: null };
  assert.deepEqual(await extractMeta('/m/v.mp4', 'video', 9, probe('not json')), nothing);
  assert.deepEqual(await extractMeta('/m/v.mp4', 'video', 9, async () => { throw new Error('ffprobe failed: nope'); }), nothing);
  assert.deepEqual(await extractMeta('/m/v.mp4', 'video', 9, probe({ streams: [{ width: 0, height: 0 }], format: { duration: 'N/A' } })), nothing);
  assert.deepEqual(await extractMeta('/m/a.mp4', 'video', 9, probe({ streams: [], format: { duration: '3.0' } })), { ...nothing, duration: 3 });   // no picture stream
});
test('extractMeta: HEIC takes its size from EXIF, then swaps for Orientation 5-8 (R1)', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'turned.heic'), heicWithExif(4000, 3000, 6));
  await writeFile(join(dir, 'level.HEIF'), heicWithExif(4000, 3000, 1));
  assert.deepEqual(await extractMeta(join(dir, 'turned.heic'), 'photo', 0), { width: 3000, height: 4000, takenAt: '2021-06-15T12:34:56', duration: null });
  const level = await extractMeta(join(dir, 'level.HEIF'), 'photo', 0);
  assert.deepEqual([level.width, level.height], [4000, 3000]);
  // no EXIF in the file: image-size answers (its reading of our cropped sample is off, so the numbers aren't pinned)
  const sample = await extractMeta(fixture('sample.heic'), 'photo', 0);
  assert.ok(Number.isInteger(sample.width) && sample.width! > 0 && Number.isInteger(sample.height) && sample.height! > 0);
  assert.equal(sample.takenAt, instantToWallClock(0));
});
test('extractMeta: a photo longer than the first 512 KB is still read in full, a HEIC with its Exif item past that too (R1)', async () => {
  // a writer may store the Exif item after the picture data, which in a full-size photo is megabytes into the file
  const dir = await tempDir();
  for (const pad of [600 * 1024, 3 * 1024 * 1024]) {
    const file = join(dir, `exif-after-${pad}.heic`);
    await writeFile(file, heicWithExif(4000, 3000, 6, pad));
    assert.deepEqual(await extractMeta(file, 'photo', 0), { width: 3000, height: 4000, takenAt: '2021-06-15T12:34:56', duration: null }, `Exif item ${pad} bytes in`);
  }
  const long = join(dir, 'long.jpg');
  await writeFile(long, Buffer.concat([await readFile(fixture('exif-rot6.jpg')), Buffer.alloc(600 * 1024)]));
  assert.deepEqual(await extractMeta(long, 'photo', 0), { width: 48, height: 64, takenAt: '2025-12-24T18:00:00', duration: null });
});

test('extractMeta leaves no file open, whatever the file holds', { skip: !existsSync('/proc/self/fd') }, async () => {
  // exifr given a path leaves its handle open for a file under two bytes; Node then warns when it collects it (DEP0137)
  const dir = await tempDir();
  await writeFile(join(dir, 'empty.jpg'), '');
  await writeFile(join(dir, 'one.png'), 'x');
  await writeFile(join(dir, 'big-garbage.jpg'), Buffer.alloc(600 * 1024, 0xab));   // longer than the head, so exifr is given the path
  await writeFile(join(dir, 'big-photo.jpg'), Buffer.concat([await readFile(fixture('exif-rot6.jpg')), Buffer.alloc(600 * 1024)]));
  const openFiles = () => readdirSync('/proc/self/fd').length;
  const before = openFiles();
  for (const f of [join(dir, 'empty.jpg'), join(dir, 'one.png'), join(dir, 'big-garbage.jpg'), join(dir, 'big-photo.jpg'), join(dir, 'missing.jpg'),
    fixture('corrupt.jpg'), fixture('plain.png'), fixture('exif-rot6.jpg'), fixture('sample.heic')]) await extractMeta(f, 'photo', 0);
  await new Promise((resolve) => setTimeout(resolve, 50));   // exifr doesn't wait for the close of a file it gave up on
  assert.ok(openFiles() <= before, `${openFiles() - before} file(s) left open`);
});

test('pLimit runs at most n at once, keeps every result and frees the slot of a failure', { timeout: 10_000 }, async () => {
  const limit = pLimit(3);
  let running = 0, peak = 0;
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => limit(async () => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return i;
  })));
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); assert.equal(peak, 3);
  const failed = await Promise.allSettled(Array.from({ length: 5 }, () => limit(() => Promise.reject(new Error('x')))));
  assert.deepEqual(failed.map((r) => r.status), Array(5).fill('rejected'));
  assert.equal(await limit(async () => 'still works'), 'still works');
});
test('runProcess returns stdout, and rejects with the command and its stderr', async () => {
  const node = process.execPath;
  assert.equal(await runProcess(node, ['-e', 'process.stdout.write("hi")'], 5000), 'hi');
  await assert.rejects(runProcess(node, ['-e', 'console.error("boom"); process.exit(3)'], 5000), { message: `${node} failed: boom\n` });
  const started = Date.now();
  await assert.rejects(runProcess(node, ['-e', 'setTimeout(() => {}, 20000)'], 200), (err: Error) => err.message.startsWith(`${node} failed: Command failed`));   // killed when the time is up
  assert.ok(Date.now() - started < 10_000);
  await assert.rejects(runProcess('no-such-command-here', [], 1000), { message: /^no-such-command-here failed: .*ENOENT/ });
});

test('member root lists aliases; hidden/unavailable handled', async (t) => {
  // tree: pics/family/{a.jpg, notes.txt, .DS_Store, xmas/b.jpg, @eaDir/c.jpg}, pics/test1/; link pics/family/ln -> xmas
  // shares for papa: 'Family photos' -> pics/family (create), 'Gone' -> pics/gone (missing)
  const root = (await papa.json('GET', '/api/list?path=' + encodeURIComponent('/'))).body;
  assert.equal(root.name, 'Home Gallery');
  assert.deepEqual(root.entries.map((e: any) => [e.name, e.count, e.protected, !!e.unavailable]), [['Family photos', 3, true, false], ['Gone', 0, true, true]]);
  assert.equal(root.entries[0].cover, '/Family photos/a.jpg');
  const fam = (await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos'))).body;
  assert.deepEqual(fam.entries.map((e: any) => [e.kind, e.name]), [['folder', 'xmas'], ['folder', 'Дача #2 (2024)'], ['photo', 'a.jpg']]);
  assert.deepEqual(fam.rights, { create: true, update: false, delete: false });
  const a = fam.entries.find((e: any) => e.name === 'a.jpg');
  assert.deepEqual([a.type, a.width, a.height, a.takenAt], ['JPEG image', 48, 64, '2025-12-24T18:00:00']);
  assert.ok(ta.db.prepare('select 1 from media_meta where rel_path=?').get('pics/family/a.jpg'));
});
test('folders and recursive files', async () => {
  assert.deepEqual((await papa.json('GET', '/api/folders?path=' + encodeURIComponent('/Family photos'))).body,
    [{ name: 'xmas', count: 1, hasChildren: false }, { name: 'Дача #2 (2024)', count: 1, hasChildren: false }]);
  const loc = await locate(ta.app, papaMe, '/Family photos');
  assert.deepEqual((await listFiles(ta.app, papaMe, loc)).items.map((i) => i.path), ['/Family photos/a.jpg', '/Family photos/xmas/b.jpg', '/Family photos/Дача #2 (2024)/IMG 50%.jpg']);
  assert.deepEqual(await listFiles(ta.app, papaMe, loc, 1).then((r) => [r.items.length, r.capped]), [1, true]);
});
test('read-only on disk forces rights off (Review Focus 3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await chmod(join(ta.media, 'pics/family'), 0o555); t.after(() => chmod(join(ta.media, 'pics/family'), 0o755));
  assert.deepEqual((await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos'))).body.rights, { create: false, update: false, delete: false });
});
test('unicode names list (Review Focus 1)', async () => {
  const r = await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos/Дача #2 (2024)'));
  assert.equal(r.body.entries[0].name, 'IMG 50%.jpg');
});

test('entries carry exactly what the Explorer renders', async () => {
  const fam = (await get(papa, 'list', '/Family photos')).body;
  assert.deepEqual([fam.path, fam.name], ['/Family photos', 'Family photos']);
  const entry = (name: string) => fam.entries.find((e: any) => e.name === name);
  const mtime = async (rel: string) => Math.floor((await stat(join(ta.media, rel))).mtimeMs);
  assert.deepEqual(entry('a.jpg'), { kind: 'photo', name: 'a.jpg', size: (await stat(join(ta.media, 'pics/family/a.jpg'))).size, mtime: await mtime('pics/family/a.jpg'),
    takenAt: '2025-12-24T18:00:00', width: 48, height: 64, duration: null, type: 'JPEG image' });
  assert.deepEqual(entry('xmas'), { kind: 'folder', name: 'xmas', mtime: await mtime('pics/family/xmas'), count: 1, cover: '/Family photos/xmas/b.jpg', protected: false });
  assert.equal(entry('Дача #2 (2024)').cover, '/Family photos/Дача #2 (2024)/IMG 50%.jpg');
  const sub = (await get(papa, 'list', '/Family photos/xmas')).body;
  assert.deepEqual([sub.name, sub.path, sub.rights, sub.entries.map((e: any) => e.name)], ['xmas', '/Family photos/xmas', { create: true, update: false, delete: false }, ['b.jpg']]);
});

test('every browsing route refuses anonymous requests (F15)', async () => {
  for (const route of ['list', 'folders', 'files', 'meta'])
    for (const path of ['/', '/Family photos', '../x'])   // who is asking comes before what is asked
      assert.deepEqual(await get(ta.client(), route, path), { status: 401, body: { error: 'Sign in required' } }, route + path);
});
test('bad paths: an encoded .. is 400, unknown and non-folders 404 (F15)', async () => {
  const dots = encodeURIComponent('/Family photos/') + '%2E%2E';   // encodeURIComponent leaves the dots alone, so this is the %2E%2E spelling
  for (const route of ['list', 'folders', 'files', 'meta']) assert.deepEqual(await papa.json('GET', `/api/${route}?path=${dots}`), INVALID, route);
  for (const path of ['/Family photos/.DS_Store', '/Family photos/@eaDir', 'Family photos', '/Family photos/', '']) assert.deepEqual(await get(papa, 'list', path), INVALID, path);
  assert.deepEqual(await papa.json('GET', '/api/list'), INVALID);   // no path at all
  for (const route of ['list', 'folders', 'files']) {
    assert.deepEqual(await get(papa, route, '/Nope'), NOT_FOUND, route);
    assert.deepEqual(await get(papa, route, '/Gone'), NOT_FOUND, route);                  // a share whose folder is missing
    assert.deepEqual(await get(papa, route, '/Family photos/a.jpg'), NOT_FOUND, route);   // a file is no folder
  }
});
test('meta: a media file answers, anything else is "Not a media file"', async () => {
  assert.deepEqual((await get(papa, 'meta', '/Family photos/a.jpg')).body, { width: 48, height: 64, takenAt: '2025-12-24T18:00:00', duration: null });
  for (const path of ['/', '/Family photos', '/Family photos/xmas', '/Family photos/notes.txt']) assert.deepEqual(await get(papa, 'meta', path), NOT_MEDIA, path);
  assert.deepEqual(await get(papa, 'meta', '/Family photos/missing.jpg'), NOT_FOUND);
  assert.deepEqual(await get(admin, 'meta', '/'), NOT_MEDIA);
  // a hidden name anywhere in the path is refused before the disk is asked, though .DS_Store and @eaDir/c.jpg exist
  for (const path of ['/Family photos/.DS_Store', '/Family photos/@eaDir', '/Family photos/@eaDir/c.jpg']) assert.deepEqual(await get(papa, 'meta', path), INVALID, path);
  for (const path of ['/pics/family/.DS_Store', '/pics/family/@eaDir/c.jpg']) assert.deepEqual(await get(admin, 'meta', path), INVALID, path);
});

test('getMeta: a cached row is good while size and mtime match, and is replaced when either changes', async () => {
  const rel = 'pics/family/a.jpg', abs = join(ta.media, rel), st = await stat(abs);
  const rows = () => ta.db.prepare('select * from media_meta where rel_path = ?').all(rel).length;
  const poison = () => ta.db.prepare('update media_meta set width = 999 where rel_path = ?').run(rel);
  await getMeta(ta.db, abs, rel, st, 'photo');
  poison();
  assert.equal((await getMeta(ta.db, abs, rel, st, 'photo')).width, 999);                                                    // served from the cache
  assert.equal((await getMeta(ta.db, abs, rel, { size: st.size, mtimeMs: st.mtimeMs + 1000 }, 'photo')).width, 48);          // mtime changed: read again
  poison();
  assert.equal((await getMeta(ta.db, abs, rel, { size: st.size + 1, mtimeMs: st.mtimeMs + 1000 }, 'photo')).width, 48);      // size changed: read again
  assert.equal(rows(), 1);
});

test('odd media never breaks a listing (Review Focus 2)', async () => {
  const dir = join(ta.media, 'pics/odd');
  await mkdir(dir, { recursive: true });
  for (const [from, to] of [['corrupt.jpg', 'bad.jpg'], ['sample.heic', 'phone.heic'], ['plain.png', 'plain.PNG'], ['clip.mp4', 'clip.mp4']]) await copyFile(fixture(from), join(dir, to));
  await writeFile(join(dir, 'fake.mp4'), 'this is not a video');
  await writeFile(join(dir, 'empty.png'), '');
  const r = await get(admin, 'list', '/pics/odd');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries.map((e: any) => [e.name, e.kind, e.type]), [
    ['bad.jpg', 'photo', 'JPEG image'], ['clip.mp4', 'video', 'MP4 video'], ['empty.png', 'photo', 'PNG image'], ['fake.mp4', 'video', 'MP4 video'],
    ['phone.heic', 'photo', 'HEIC image'], ['plain.PNG', 'photo', 'PNG image']]);
  const by = Object.fromEntries(r.body.entries.map((e: any) => [e.name, e]));
  for (const n of ['bad.jpg', 'empty.png', 'fake.mp4']) assert.deepEqual([by[n].width, by[n].height, by[n].duration, by[n].takenAt], [null, null, null, instantToWallClock(by[n].mtime)], n);
  assert.deepEqual([by['plain.PNG'].width, by['plain.PNG'].height], [32, 16]);
  if (hasCommand('ffprobe')) assert.deepEqual([by['clip.mp4'].width, by['clip.mp4'].height], [320, 240]);
});

test('hidden names and symlinks are never listed or counted', async () => {
  await seedTree(ta.media, ['pics/hide/shown.jpg', 'pics/hide/real/in.jpg', 'pics/hide/.dot.jpg', 'pics/hide/.dotdir/x.jpg', 'pics/hide/@eaDir/x.jpg', 'pics/hide/#recycle/x.jpg',
    'pics/hide/#snapshot/x.jpg', 'pics/hide/$RECYCLE.BIN./x.jpg', 'pics/hide/System Volume Information/x.jpg', 'pics/hide/lost+found/x.jpg', 'pics/hide/Thumbs.db', 'pics/hide/desktop.ini',
    'pics/hide/notes.txt', 'pics/hide/raw.cr2'], [['shown.jpg', 'pics/hide/link.jpg'], ['real', 'pics/hide/linkdir'], ['nowhere.jpg', 'pics/hide/dangling.jpg']]);
  invalidateStats();
  const r = (await get(admin, 'list', '/pics/hide')).body;
  assert.deepEqual(r.entries.map((e: any) => [e.kind, e.name]), [['folder', 'real'], ['photo', 'shown.jpg']]);
  assert.deepEqual((await get(admin, 'folders', '/pics/hide')).body, [{ name: 'real', count: 1, hasChildren: false }]);
  assert.deepEqual((await get(admin, 'files', '/pics/hide')).body.items.map((i: any) => i.path), ['/pics/hide/shown.jpg', '/pics/hide/real/in.jpg']);
  const pics = (await get(admin, 'list', '/pics')).body.entries.find((e: any) => e.name === 'hide');
  assert.deepEqual([pics.count, pics.cover], [2, '/pics/hide/shown.jpg']);
});
test('a subfolder the server may not read counts as empty; opening it directly is a logged fault', { skip: process.getuid?.() === 0 }, async (t) => {
  t.mock.method(console, 'log', () => {});   // the 500 at the end is logged
  await seedTree(ta.media, ['pics/ro/ok.jpg', 'pics/ro/locked/x.jpg']);
  const locked = join(ta.media, 'pics/ro/locked');
  await chmod(locked, 0o000); t.after(() => chmod(locked, 0o755));
  invalidateStats();
  const list = (await get(admin, 'list', '/pics/ro')).body;
  assert.deepEqual(list.entries.map((e: any) => [e.name, e.count ?? null]), [['locked', 0], ['ok.jpg', null]]);
  assert.deepEqual((await get(admin, 'folders', '/pics/ro')).body, [{ name: 'locked', count: 0, hasChildren: false }]);
  assert.deepEqual((await get(admin, 'files', '/pics/ro')).body.items.map((i: any) => i.path), ['/pics/ro/ok.jpg']);
  assert.deepEqual(await get(admin, 'list', '/pics/ro/locked'), { status: 500, body: { error: 'Something went wrong' } });
});
test('entries sort folders first, then in natural name order; names the collator ties go by code unit (G4, G7)', async () => {
  await seedTree(ta.media, ['pics/sort/img10.jpg', 'pics/sort/img2.jpg', 'pics/sort/IMG1.jpg', 'pics/sort/b.jpg', 'pics/sort/B.jpg', 'pics/sort/UPPER.JPG', 'pics/sort/zeta/', 'pics/sort/Alpha/', 'pics/sort/alpha/', 'pics/sort/10/', 'pics/sort/9/']);
  const names = (await get(admin, 'list', '/pics/sort')).body.entries.map((e: any) => e.name);
  assert.deepEqual(names, ['9', '10', 'Alpha', 'alpha', 'zeta', 'B.jpg', 'b.jpg', 'IMG1.jpg', 'img2.jpg', 'img10.jpg', 'UPPER.JPG']);
  assert.deepEqual((await get(admin, 'folders', '/pics/sort')).body.map((f: any) => f.name), ['9', '10', 'Alpha', 'alpha', 'zeta']);
  assert.deepEqual((await get(admin, 'files', '/pics/sort')).body.items.map((i: any) => i.name), ['B.jpg', 'b.jpg', 'IMG1.jpg', 'img2.jpg', 'img10.jpg', 'UPPER.JPG']);
});

test('the administrator browses MEDIA_ROOT: real names, top-level folders protected, hidden folders absent', async () => {
  await seedTree(ta.media, ['.gallery-trash/x.jpg']);
  const root = (await get(admin, 'list', '/')).body;
  assert.deepEqual([root.name, root.path, root.rights], ['Home Gallery', '/', { create: false, update: false, delete: false }]);
  assert.deepEqual(root.entries.map((e: any) => [e.name, e.protected]), [['pics', true]]);
  const pics = (await get(admin, 'list', '/pics')).body;
  assert.deepEqual([pics.name, pics.rights], ['pics', { create: true, update: true, delete: true }]);
  assert.equal(pics.entries.find((e: any) => e.name === 'family').protected, false);
  assert.deepEqual((await get(admin, 'folders', '/')).body.map((f: any) => f.name), ['pics']);
});

test('member root: files of every available share, in alias order, under one cap (F14.1)', async () => {
  const outside = await tempDir();
  await seedTree(outside, ['o.jpg']);
  await seedTree(ta.media, ['pics/test1/t.jpg']);
  await symlink(outside, join(ta.media, 'pics/out'));
  const mama = await ta.addUser('mama', 'member');
  const mamaMe = getMe(ta.db, mama.id)!;
  // out: a share on a symlink that leads out of the media folder; File: a share on a file
  for (const [alias, rel] of [['Zebra', 'pics/test1'], ['Alpha', 'pics/family'], ['Gone', 'pics/gone'], ['Out', 'pics/out'], ['File', 'pics/family/a.jpg']]) addShare(mama.id, alias, rel);
  invalidateStats();

  const all = ['/Alpha/a.jpg', '/Alpha/xmas/b.jpg', '/Alpha/Дача #2 (2024)/IMG 50%.jpg', '/Zebra/t.jpg'];
  const viaApi = (await get(mama.client, 'files', '/')).body;
  assert.deepEqual([viaApi.items.map((i: any) => i.path), viaApi.capped], [all, false]);
  assert.deepEqual(viaApi.items[0], { path: '/Alpha/a.jpg', kind: 'photo', name: 'a.jpg', mtime: Math.floor((await stat(join(ta.media, 'pics/family/a.jpg'))).mtimeMs) });

  const root = await locate(ta.app, mamaMe, '/');
  const run = (cap: number) => listFiles(ta.app, mamaMe, root, cap).then((r) => [r.items.map((i) => i.path), r.capped]);
  assert.deepEqual(await run(4), [all, false]);                // fits exactly
  assert.deepEqual(await run(3), [all.slice(0, 3), true]);     // the cap falls on the share boundary
  assert.deepEqual(await run(2), [all.slice(0, 2), true]);     // one cap for all shares: a cap per share would let Zebra's file through too

  assert.deepEqual((await get(mama.client, 'folders', '/')).body, [
    { name: 'Alpha', count: 3, hasChildren: true },
    { name: 'File', count: 0, hasChildren: false, unavailable: true },
    { name: 'Gone', count: 0, hasChildren: false, unavailable: true },
    { name: 'Out', count: 0, hasChildren: false, unavailable: true },
    { name: 'Zebra', count: 1, hasChildren: false }]);
  const list = (await get(mama.client, 'list', '/')).body;
  assert.deepEqual(list.entries.map((e: any) => [e.name, e.count, e.protected, !!e.unavailable]),
    [['Alpha', 3, true, false], ['File', 0, true, true], ['Gone', 0, true, true], ['Out', 0, true, true], ['Zebra', 1, true, false]]);
  assert.deepEqual([list.entries[1].cover, list.entries[1].mtime], [null, 0]);
});

test('recursive lists are capped at 5000 items', { timeout: 60_000 }, async () => {
  for (let d = 0; d < 50; d++) {
    const dir = join(ta.media, 'pics/many', 'd' + d);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, i + '.jpg'), 'x')));
  }
  let r = (await get(admin, 'files', '/pics/many')).body;
  assert.deepEqual([r.items.length, r.capped], [5000, false]);
  await writeFile(join(ta.media, 'pics/many/z.jpg'), 'x');   // the 5001st
  r = (await get(admin, 'files', '/pics/many')).body;
  assert.deepEqual([r.items.length, r.capped, r.items[0].path], [5000, true, '/pics/many/z.jpg']);   // a folder's own files come first
});

test('folder counts and covers are cached for a while; invalidateStats() drops them', async () => {
  await seedTree(ta.media, ['pics/cache/x.jpg']);
  invalidateStats();
  const count = async () => (await get(admin, 'list', '/pics')).body.entries.find((e: any) => e.name === 'cache').count;
  assert.equal(await count(), 1);
  await seedTree(ta.media, ['pics/cache/y.jpg']);
  assert.equal(await count(), 1);   // the walk from a moment ago
  invalidateStats();
  assert.equal(await count(), 2);
});

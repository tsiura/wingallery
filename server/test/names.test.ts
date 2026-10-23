import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHiddenName, validateName, validateAlias, sanitizeUploadName, splitExt, nextFreeName, restoredName, naturalCompare, byName } from '../names.ts';
import { checkMagic, mediaTypeOf } from '../mediatypes.ts';

test('hidden names', () => {
  for (const n of ['.DS_Store', '.gallery-trash', '.upload-ab', '@eaDir', '#recycle', '#snapshot', '$RECYCLE.BIN', 'System Volume Information', 'lost+found', 'Thumbs.db', 'thumbs.db', 'desktop.ini'])
    assert.equal(isHiddenName(n), true, n);
  for (const n of ['IMG_1.jpg', 'Дача #2 (2024)']) assert.equal(isHiddenName(n), false, n);
});
// vfat and exFAT drop trailing dots when they look a name up (Windows drops spaces too), so '$RECYCLE.BIN.' opens '$RECYCLE.BIN'.
test('hidden names ignore trailing dots and spaces', () => {
  for (const n of ['$RECYCLE.BIN.', '@eaDir. ', 'Thumbs.db..', 'System Volume Information ', 'lost+found. .'])
    assert.equal(isHiddenName(n), true, n);
  // only dots and spaces are ignored: a hidden name plus any other character is another name
  for (const n of ['IMG_1.jpg', 'Thumbs.db.bak', 'desktop.ini.txt', 'a. b', 'Дача #2 (2024).', 'Thumbs.db~', '@eaDirs', 'lost+found2', '#recycle_'])
    assert.equal(isHiddenName(n), false, n);
});
test('isHiddenName stays linear on long runs of spaces and dots', () => {
  const t = performance.now();
  for (const n of [' '.repeat(100_000) + 'a', ' .'.repeat(50_000) + 'a', 'a' + ' '.repeat(100_000), 'a' + ' .'.repeat(50_000)])
    assert.equal(isHiddenName(n), false);
  for (const n of ['Thumbs.db' + ' '.repeat(100_000), '@eaDir' + ' .'.repeat(50_000)]) assert.equal(isHiddenName(n), true);
  assert.ok(performance.now() - t < 500);
});
test('validateName', () => {
  assert.equal(validateName(''), "Name can't be empty");
  assert.equal(validateName('x'.repeat(201)), 'Name is too long');
  for (const n of ['a:b', 'a/b', 'a\\b', 'a*', 'a?', 'a"', 'a<', 'a>', 'a|', 'a\u0001'])
    assert.equal(validateName(n), 'Name can\'t contain any of: / \\ : * ? " < > |', n);
  for (const n of [' a', 'a ', '.a', 'a.']) assert.equal(validateName(n), "Name can't start or end with a space or a dot", n);
  assert.equal(validateName('Thumbs.db'), 'That name is reserved');
  assert.equal(validateName('Дача #2 (2024)'), null); assert.equal(validateName('IMG 50%.jpg'), null);
  assert.equal(validateAlias('x'.repeat(65)), 'Name is too long'); assert.equal(validateAlias('test1-papa'), null);
});
test('sanitizeUploadName', () => {
  assert.equal(sanitizeUploadName('a/b\\c:d.jpg'), 'a_b_c_d.jpg');
  assert.equal(sanitizeUploadName('..hidden.jpg'), 'hidden.jpg');
  assert.equal(sanitizeUploadName(' x.jpg '), 'x.jpg');
  assert.equal(sanitizeUploadName(''), 'file');
  const long = sanitizeUploadName('я'.repeat(150) + '.jpg');
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.jpg'));
});
test('sanitizeUploadName stays linear on long runs of spaces and dots', () => {
  const t = performance.now();
  assert.equal(sanitizeUploadName('a' + ' '.repeat(100_000) + 'b.jpg'), 'a' + ' '.repeat(195) + '.jpg');
  assert.equal(sanitizeUploadName('a' + '.'.repeat(100_000) + 'b.jpg'), 'a' + '.'.repeat(195) + '.jpg');
  assert.ok(performance.now() - t < 500);
});
test('name helpers', () => {
  assert.deepEqual(splitExt('a.b.JPG'), ['a.b', '.JPG']); assert.deepEqual(splitExt('noext'), ['noext', '']);
  assert.equal(nextFreeName('IMG.jpg', 1), 'IMG (1).jpg'); assert.equal(nextFreeName('folder', 2), 'folder (2)');
  assert.equal(restoredName('x.jpg', 1), 'x (restored).jpg'); assert.equal(restoredName('x.jpg', 2), 'x (restored 2).jpg');
});
test('naturalCompare', () => {
  assert.deepEqual(['b10', 'b2', 'a'].sort(naturalCompare), ['a', 'b2', 'b10']);
});
test('byName: natural order, and names the collator ties go by code unit, so a sort never depends on the input order (G7)', () => {
  const want = ['a', 'B', 'b', 'IMG1', 'img2', 'img10'];   // B and b tie in the collator: 'B' < 'b' as code units
  for (const input of [want, [...want].reverse(), ['img10', 'b', 'IMG1', 'B', 'a', 'img2']]) assert.deepEqual([...input].sort(byName), want);
});
test('media types', () => {
  assert.deepEqual(mediaTypeOf('A.JPG'), { kind: 'photo', mime: 'image/jpeg', label: 'JPEG image' });
  assert.equal(mediaTypeOf('b.heic')?.convert, true);
  assert.deepEqual([mediaTypeOf('c.MOV')?.kind, mediaTypeOf('c.MOV')?.mime, mediaTypeOf('c.MOV')?.viewMime], ['video', 'video/quicktime', 'video/mp4']);
  assert.equal(mediaTypeOf('d.txt'), null); assert.equal(mediaTypeOf('e.svg'), null);
});
test('magic bytes', () => {
  const b = (...x: (number | string)[]) => Buffer.concat(x.map((v) => typeof v === 'string' ? Buffer.from(v, 'latin1') : Buffer.from([v])));
  assert.equal(checkMagic('a.jpg', b(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(checkMagic('a.jpg', b(0x89, 'PNG\r\n\x1a\n')), false);
  assert.equal(checkMagic('a.png', b(0x89, 'PNG\r\n\x1a\n')), true);
  assert.equal(checkMagic('a.gif', b('GIF89a')), true);
  assert.equal(checkMagic('a.webp', b('RIFF\0\0\0\0WEBP')), true);
  assert.equal(checkMagic('a.mp4', b('\0\0\0\x18ftypisom')), true);
  assert.equal(checkMagic('a.heic', b('\0\0\0\x18ftypheic')), true);
  assert.equal(checkMagic('a.mov', b('\0\0\0\x08wide')), true);
  assert.equal(checkMagic('a.webm', b(0x1a, 0x45, 0xdf, 0xa3)), true);
  assert.equal(checkMagic('a.txt', b('hello')), false);
});

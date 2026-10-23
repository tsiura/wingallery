import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry, Rights } from '../../../shared/types.ts';
import { actionsFor, baseLength, deleteWords, downloadPlan, mostActions, scopeRootOf } from './actions.ts';

const R = (c: boolean, u: boolean, d: boolean): Rights => ({ create: c, update: u, delete: d });
const file = { kind: 'photo', name: 'a.jpg' } as Entry, prot = { kind: 'folder', name: 'Fam', protected: true } as Entry;

test('actionsFor', () => {
  assert.deepEqual(actionsFor(R(true, false, false), []), { upload: true, newFolder: true, rename: false, move: false, delete: false, download: false });
  assert.deepEqual(actionsFor(R(false, true, true), [file]), { upload: false, newFolder: false, rename: true, move: true, delete: true, download: true });
  assert.equal(actionsFor(R(false, true, true), [file, file]).rename, false);
  assert.deepEqual([actionsFor(R(true, true, true), [prot]).move, actionsFor(R(true, true, true), [prot]).delete], [false, false]);
});

test('actionsFor: a protected folder in the selection takes rename, move and delete away, whatever else is selected, and leaves download', () => {
  const all = actionsFor(R(true, true, true), [file, prot]);
  assert.deepEqual([all.rename, all.move, all.delete, all.download], [false, false, false, true]);
  assert.equal(actionsFor(R(true, true, true), [prot]).rename, false);
  // no right, no action: the selection does not matter
  assert.deepEqual(actionsFor(R(false, false, false), [file]), { upload: false, newFolder: false, rename: false, move: false, delete: false, download: true });
  assert.deepEqual(actionsFor(R(false, true, false), [file, file]), { upload: false, newFolder: false, rename: false, move: true, delete: false, download: true });
});

test('mostActions: Upload and New folder, Rename and Move, Delete, and the Download that anyone has', () => {
  assert.equal(mostActions(R(true, true, true)), 6);
  assert.equal(mostActions(R(false, false, false)), 1);
  assert.deepEqual([R(true, false, false), R(false, true, false), R(false, false, true)].map(mostActions), [3, 3, 2]);
  assert.deepEqual([R(true, true, false), R(false, true, true), R(true, false, true)].map(mostActions), [5, 4, 4]);
});

test('baseLength: what a rename selects, so that typing leaves the extension (the server splits at the last dot, as splitExt does)', () => {
  assert.equal(baseLength('IMG_0001.jpg'), 8);
  assert.equal(baseLength('a.b.jpg'), 3);
  assert.equal(baseLength('Дача #2 (2024).mp4'), 'Дача #2 (2024)'.length);
  assert.equal(baseLength('Family'), 6);          // a folder, or a name with no extension: all of it
  assert.equal(baseLength('.hidden'), 7);         // a leading dot is no extension
  assert.equal(baseLength(''), 0);
});

test('scopeRootOf: a move stays inside the first segment of the path (a member\'s share, an administrator\'s top-level folder)', () => {
  assert.equal(scopeRootOf('/'), null);
  assert.equal(scopeRootOf('/Fam'), '/Fam');
  assert.equal(scopeRootOf('/Fam/2024/Summer'), '/Fam');
  assert.equal(scopeRootOf('/Дача #2 (2024)/IMG 50%'), '/Дача #2 (2024)');
});

test('deleteWords: the count, the files the gallery does not show, and for a member who cannot bring them back himself, who can', () => {
  assert.deepEqual(deleteWords({ items: 3, hiddenFiles: 0 }, false), { message: 'Move 3 items to the Recycle Bin?' });
  assert.deepEqual(deleteWords({ items: 1, hiddenFiles: 0 }, false), { message: 'Move 1 item to the Recycle Bin?' });
  assert.deepEqual(deleteWords({ items: 2, hiddenFiles: 12 }, false),
    { message: 'Move 2 items to the Recycle Bin?', detail: "…and 12 other files the gallery doesn't show." });
  assert.deepEqual(deleteWords({ items: 2, hiddenFiles: 0 }, true), { message: 'Move 2 items to the Recycle Bin?', detail: 'The admin can restore them.' });
  assert.deepEqual(deleteWords({ items: 1, hiddenFiles: 1 }, true),
    { message: 'Move 1 item to the Recycle Bin?', detail: "…and 1 other file the gallery doesn't show.\nThe admin can restore it." });
  assert.deepEqual(deleteWords({ items: 4, hiddenFiles: 12 }, true).detail, "…and 12 other files the gallery doesn't show.\nThe admin can restore them.");
});

const photo = (name: string) => ({ kind: 'photo', name, size: 1 }) as Entry;
const folder = (name: string) => ({ kind: 'folder', name, protected: false }) as Entry;

test('downloadPlan: one file as it is, anything else as a zip', () => {
  assert.deepEqual(downloadPlan('/Fam', [photo('a.jpg')], 5), { kind: 'file', path: '/Fam/a.jpg' });
  assert.deepEqual(downloadPlan('/Fam', [folder('Sub')], 5), { kind: 'zip', paths: ['/Fam/Sub'] });
  assert.deepEqual(downloadPlan('/Fam', [photo('a.jpg'), folder('Sub')], 5), { kind: 'zip', paths: ['/Fam/a.jpg', '/Fam/Sub'] });
  assert.deepEqual(downloadPlan('/', [folder('Fam')], 3), { kind: 'zip', paths: ['/Fam'] });
});

test('downloadPlan: when everything in the folder is selected the folder itself is sent, except at the root, which is no folder on disk to a member', () => {
  assert.deepEqual(downloadPlan('/Fam', [photo('a.jpg'), photo('b.jpg')], 2), { kind: 'zip', paths: ['/Fam'] });
  assert.deepEqual(downloadPlan('/Fam', [photo('a.jpg'), photo('b.jpg')], 3), { kind: 'zip', paths: ['/Fam/a.jpg', '/Fam/b.jpg'] });
  assert.deepEqual(downloadPlan('/', [folder('A'), folder('B')], 2), { kind: 'zip', paths: ['/A', '/B'] });
  assert.deepEqual(downloadPlan('/Fam', [photo('a.jpg')], 1), { kind: 'file', path: '/Fam/a.jpg' });          // one item is that item, not its folder
  assert.deepEqual(downloadPlan('/Fam', [folder('Sub')], 1), { kind: 'zip', paths: ['/Fam/Sub'] });
});

test('downloadPlan: a selection too long for the 1 MB form is refused, unless it is the whole folder, which is short', () => {
  const many = Array.from({ length: 20000 }, (_, i) => photo(`IMG_${i}_${'x'.repeat(40)}.jpg`));
  assert.deepEqual(downloadPlan('/Fam', many.slice(0, 19999), 20000), { kind: 'too-many' });
  assert.deepEqual(downloadPlan('/Fam', many, 20000), { kind: 'zip', paths: ['/Fam'] });
  // what counts is the form as the browser encodes it (a Cyrillic letter is six bytes there), not the characters
  const cyrillic = Array.from({ length: 6000 }, (_, i) => photo(`Дача_${i}_${'ж'.repeat(20)}.jpg`));   // about 170 bytes each in the form, but only 40 characters
  assert.ok(JSON.stringify(cyrillic.map((e) => `/Fam/${e.name}`)).length < 900_000);
  assert.deepEqual(downloadPlan('/Fam', cyrillic, 9999), { kind: 'too-many' });
  assert.equal(downloadPlan('/Fam', cyrillic.slice(0, 100), 9999).kind, 'zip');
});

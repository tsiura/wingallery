import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry } from '../../../shared/types.ts';
import { statusCount, statusSel } from './status.ts';

const folder = (name: string): Entry => ({ kind: 'folder', name, mtime: 0, count: 5, cover: null, protected: false });
const file = (name: string, kind: 'photo' | 'video', size: number): Entry =>
  ({ kind, name, size, mtime: 0, takenAt: '2026-03-14T09:00:00', width: null, height: null, duration: null, type: kind === 'photo' ? 'JPEG image' : 'MP4 video' });

const entries = [folder('Travel'), file('a.jpg', 'photo', 1_800_000), file('b.jpg', 'photo', 2_300_000), file('c.mp4', 'video', 40_000_000), file('d.png', 'photo', 512_400)];

test('the count: items, and photos and videos when there are files, as the design words it', () => {
  assert.equal(statusCount(entries), '5 items  ·  3 photos, 1 videos');
  assert.equal(statusCount([folder('A'), folder('B')]), '2 items');   // folders only: no photos part
  assert.equal(statusCount([]), '0 items');
  assert.equal(statusCount([file('a.mp4', 'video', 1)]), '1 items  ·  0 photos, 1 videos');
});

test('the selection: how many, and the size of the files among them', () => {
  assert.equal(statusSel(entries, []), '');
  assert.equal(statusSel(entries, ['a.jpg']), '1 selected  ·  1.8 MB');
  assert.equal(statusSel(entries, ['d.png']), '1 selected  ·  512 KB');
  assert.equal(statusSel(entries, ['a.jpg', 'b.jpg', 'c.mp4']), '3 selected  ·  44.1 MB');
  assert.equal(statusSel(entries, ['Travel']), '1 selected');                        // a folder has no size of its own
  assert.equal(statusSel(entries, ['Travel', 'a.jpg']), '2 selected  ·  1.8 MB');    // only the file is added up
  assert.equal(statusSel(entries, ['gone.jpg']), '1 selected');                      // a name that is not in the list adds nothing
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry, FileEntry } from '../../../shared/types.ts';
import { cycleSort, sortEntries } from './sort.ts';
import type { SortKey } from './sort.ts';

const f = (name: string, mtime = 0): Entry => ({ kind: 'folder', name, mtime, count: 0, cover: null, protected: false });
const p = (name: string, takenAt: string, size: number, w: number | null = null, h: number | null = null): FileEntry => ({ kind: 'photo', name, size, mtime: 0, takenAt, width: w, height: h, duration: null, type: 'JPEG image' });
const names = (es: Entry[]) => es.map((e) => e.name);

test('sortEntries', () => {
  const es = [p('IMG_10.jpg', '2025-01-02T00:00:00', 5, 4, 3), f('B'), p('IMG_2.jpg', '2025-01-01T00:00:00', 9), f('a')];
  assert.deepEqual(sortEntries(es, 'name', 1).map((e) => e.name), ['a', 'B', 'IMG_2.jpg', 'IMG_10.jpg']);
  assert.deepEqual(sortEntries(es, 'name', -1).map((e) => e.name), ['B', 'a', 'IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'date', -1).filter((e) => e.kind !== 'folder').map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'size', 1).slice(2).map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'dims', 1).slice(2).map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(['name', 'date', 'size'].map((k) => cycleSort(k as SortKey)), ['date', 'size', 'name']);
});

test('names that differ only in case are ordered by code unit, so the order is the same whatever order the list came in; descending is its mirror', () => {
  const a = p('img_2.jpg', '2025-01-01T00:00:00', 1), b = p('IMG_2.jpg', '2025-01-01T00:00:00', 1), c = p('img_10.jpg', '2025-01-01T00:00:00', 1);
  assert.deepEqual(names(sortEntries([a, b, c], 'name', 1)), ['IMG_2.jpg', 'img_2.jpg', 'img_10.jpg']);
  assert.deepEqual(names(sortEntries([c, a, b], 'name', 1)), ['IMG_2.jpg', 'img_2.jpg', 'img_10.jpg']);
  assert.deepEqual(names(sortEntries([a, b, c], 'name', -1)), ['img_10.jpg', 'img_2.jpg', 'IMG_2.jpg']);
});

test('folders stay first under every key and direction; their date is their mtime', () => {
  const es = [p('a.jpg', '2025-01-01T00:00:00', 1), f('Old', 100), f('New', 200)];
  for (const key of ['name', 'date', 'type', 'size', 'dims'] as SortKey[]) {
    for (const dir of [1, -1] as const) assert.deepEqual(names(sortEntries(es, key, dir)).slice(2), ['a.jpg'], `${key} ${dir}`);
  }
  assert.deepEqual(names(sortEntries(es, 'date', 1)), ['Old', 'New', 'a.jpg']);
  assert.deepEqual(names(sortEntries(es, 'date', -1)), ['New', 'Old', 'a.jpg']);
});

test('an item with no value for the key goes last in either direction; equal values keep the name order, also when descending', () => {
  const t = '2025-01-01T00:00:00';
  const es = [p('b.jpg', t, 5), p('a.jpg', t, 5, 2, 2), p('d.jpg', t, 5, 1, 1), p('c.jpg', t, 5, 3, 1)];   // dims: b none, a 4, d 1, c 3
  assert.deepEqual(names(sortEntries(es, 'dims', 1)), ['d.jpg', 'c.jpg', 'a.jpg', 'b.jpg']);
  assert.deepEqual(names(sortEntries(es, 'dims', -1)), ['a.jpg', 'c.jpg', 'd.jpg', 'b.jpg']);
  assert.deepEqual(names(sortEntries(es, 'size', 1)), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  assert.deepEqual(names(sortEntries(es, 'size', -1)), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  const half = p('h.jpg', t, 5, 7, null);                                                                    // a width alone is no dimensions
  assert.deepEqual(names(sortEntries([half, ...es], 'dims', 1)).slice(-2), ['b.jpg', 'h.jpg']);
});

test('type sorts by its label, and does not change the list it is given', () => {
  const video: FileEntry = { ...p('v.mp4', '2025-01-01T00:00:00', 1), kind: 'video', type: 'MP4 video' };
  const png: FileEntry = { ...p('p.png', '2025-01-01T00:00:00', 1), type: 'PNG image' };
  const es: Entry[] = [video, p('j.jpg', '2025-01-01T00:00:00', 1), png];
  assert.deepEqual(names(sortEntries(es, 'type', 1)), ['j.jpg', 'v.mp4', 'p.png']);
  assert.deepEqual(names(sortEntries(es, 'type', -1)), ['p.png', 'v.mp4', 'j.jpg']);
  assert.deepEqual(names(es), ['v.mp4', 'j.jpg', 'p.png']);
});

test('the toolbar cycles name, date, size; a key that is not in the cycle (type, dimensions) goes back to name', () => {
  assert.equal(cycleSort('type'), 'name');
  assert.equal(cycleSort('dims'), 'name');
});

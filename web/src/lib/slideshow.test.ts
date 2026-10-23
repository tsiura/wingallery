import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Entry, Meta, SlideItem } from '../../../shared/types.ts';
import {
  advance, CAPPED_NOTE, defaultScope, filterPool, joinPool, metaLine, poolSources, shuffled, SLIDE_CAP, slidesOf, step, swipeDelta, toggled,
} from './slideshow.ts';

test('slideshow helpers', () => {
  assert.equal(defaultScope(2), 'selected'); assert.equal(defaultScope(1), 'folder');
  const items = [{ kind: 'photo' }, { kind: 'video' }] as SlideItem[];
  assert.deepEqual(filterPool(items, false).map((i) => i.kind), ['photo']);
  const s = shuffled([1, 2, 3, 4], () => 0); assert.deepEqual([...s].sort(), [1, 2, 3, 4]); assert.notDeepEqual(s, [1, 2, 3, 4]);
  assert.equal(step(2, 3, 1, false, true), null); assert.equal(step(2, 3, 1, true, true), 0);
  assert.equal(step(2, 3, 1, false, false), 0); assert.equal(step(0, 3, -1, false, false), 2);
});

test('defaultScope: Selected when more than one item is selected, as the design does (one selected item is just the cursor)', () => {
  assert.deepEqual([0, 1, 2, 30].map(defaultScope), ['folder', 'folder', 'selected', 'selected']);
});

test('filterPool: videos out when they are off, the order kept, the input left alone', () => {
  const items = [{ kind: 'video', name: 'a' }, { kind: 'photo', name: 'b' }, { kind: 'video', name: 'c' }, { kind: 'photo', name: 'd' }] as SlideItem[];
  assert.deepEqual(filterPool(items, true).map((i) => i.name), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterPool(items, false).map((i) => i.name), ['b', 'd']);
  assert.equal(items.length, 4);
  assert.deepEqual(filterPool([], false), []);
});

test('shuffled: every item once, a new array, the input untouched; the random source decides the order', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffled(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(shuffled([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);                  // always the first slot: the Fisher-Yates swap of the last with the first, down the line
  assert.deepEqual(shuffled([1, 2, 3, 4], () => 0.999999), [1, 2, 3, 4]);          // always the last slot: every item swaps with itself
  assert.deepEqual(shuffled([], () => 0.5), []);
  assert.deepEqual(shuffled(['x']), ['x']);
  // none is lost or doubled whatever the source says
  let n = 0;
  const odd = shuffled(Array.from({ length: 50 }, (_, i) => i), () => ((n += 7) % 13) / 13);
  assert.deepEqual([...odd].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));
  // and with the real random source the order does change now and then (50 items: the chance of the same order is 1 in 50!)
  assert.notDeepEqual(shuffled(Array.from({ length: 50 }, (_, i) => i)), Array.from({ length: 50 }, (_, i) => i));
});

test('step: the next and the previous, wrapping on a manual step; an automatic step past the end stops unless the show loops', () => {
  assert.deepEqual([step(0, 3, 1, false, false), step(1, 3, 1, false, false), step(2, 3, 1, false, false)], [1, 2, 0]);   // Next on the last wraps, loop or not
  assert.deepEqual([step(2, 3, -1, false, false), step(1, 3, -1, false, false), step(0, 3, -1, false, false)], [1, 0, 2]);
  assert.deepEqual([step(0, 3, 1, false, true), step(1, 3, 1, false, true)], [1, 2]);                                   // not at the end: the timer just goes on
  assert.equal(step(2, 3, 1, false, true), null);                                                                       // the end: stop
  assert.equal(step(2, 3, 1, true, true), 0);                                                                           // loop: round again
  assert.deepEqual([step(0, 1, 1, false, true), step(0, 1, 1, true, true), step(0, 1, 1, false, false), step(0, 1, -1, false, false)], [null, 0, 0, 0]);
});

test('advance and toggled: the show\'s position; a step restarts the slide and the stage, a toggle only the progress; the end stops the show where it is', () => {
  const s = { idx: 1, playing: true, run: 4, lap: 7 };
  assert.deepEqual(advance(s, 1, true, 3, false), { idx: 2, playing: true, run: 5, lap: 8 });
  assert.deepEqual(advance(s, -1, false, 3, false), { idx: 0, playing: true, run: 5, lap: 8 });
  assert.deepEqual(advance({ ...s, idx: 2 }, 1, true, 3, false), { idx: 2, playing: false, run: 4, lap: 7 });             // the last one, no loop: paused, nothing else moves
  assert.deepEqual(advance({ ...s, idx: 2 }, 1, true, 3, true), { idx: 0, playing: true, run: 5, lap: 8 });
  assert.deepEqual(advance({ ...s, idx: 2, playing: false }, 1, false, 3, false), { idx: 0, playing: false, run: 5, lap: 8 });   // a hand on Next wraps, and a paused show stays paused
  assert.deepEqual(toggled(s), { idx: 1, playing: false, run: 5, lap: 7 });
  assert.deepEqual(toggled(toggled(s)), { idx: 1, playing: true, run: 6, lap: 7 });
});

test('swipeDelta: more than 50 px sideways is a swipe; to the left is the next one, to the right the previous one', () => {
  assert.equal(swipeDelta(-51), 1);
  assert.equal(swipeDelta(-300), 1);
  assert.equal(swipeDelta(51), -1);
  assert.equal(swipeDelta(300), -1);
  assert.equal(swipeDelta(50), null);
  assert.equal(swipeDelta(-50), null);
  assert.equal(swipeDelta(0), null);
});

test('metaLine: when it was taken, and how big', () => {
  const meta = (width: number | null, height: number | null): Meta => ({ width, height, takenAt: '2026-03-14T09:05:00', duration: null });
  assert.equal(metaLine(meta(4032, 3024)), 'Mar 14, 2026  09:05 · 4032 × 3024');
  assert.equal(metaLine(meta(null, null)), 'Mar 14, 2026  09:05');            // a photo the server could not measure
  assert.equal(metaLine(meta(4032, null)), 'Mar 14, 2026  09:05');
});

const slide = (path: string, kind: SlideItem['kind'] = 'photo'): SlideItem => ({ path, kind, name: path.slice(path.lastIndexOf('/') + 1), mtime: 7 });
const file = (name: string, kind: 'photo' | 'video' = 'photo') => ({ kind, name, size: 1, mtime: 7 }) as Entry;
const dir = (name: string, extra: object = {}) => ({ kind: 'folder', name, mtime: 1, count: 3, cover: null, protected: false, ...extra }) as Entry;

test('slidesOf: the files of a folder as the viewer plays them: folders left out, the order kept, each with its path', () => {
  assert.deepEqual(slidesOf('/Fam', [dir('Sub'), file('b.jpg'), file('a.mp4', 'video')]), [slide('/Fam/b.jpg'), slide('/Fam/a.mp4', 'video')]);
  assert.deepEqual(slidesOf('/', [dir('Fam')]), []);
  assert.deepEqual(slidesOf('/Fam', []), []);
});

test('poolSources: the whole folder is its own files; with subfolders the folder is walked; selected is the selected files, then the selected folders walked', () => {
  const entries = [dir('Sub'), file('a.jpg'), file('b.mp4', 'video')];
  const folder = (subfolders: boolean) => ({ scope: 'folder', subfolders }) as const;
  assert.deepEqual(poolSources(folder(false), '/Fam', entries, []), { own: [slide('/Fam/a.jpg'), slide('/Fam/b.mp4', 'video')], walk: [], cap: false });
  assert.deepEqual(poolSources(folder(true), '/Fam', entries, []), { own: [], walk: ['/Fam'], cap: true });
  assert.deepEqual(poolSources(folder(true), '/', [dir('Fam'), dir('Travel')], []), { own: [], walk: ['/'], cap: true });          // a member's root: every share
  const picked = [dir('Sub'), file('a.jpg'), dir('Other'), file('b.mp4', 'video')];
  assert.deepEqual(poolSources({ scope: 'selected', subfolders: false }, '/Fam', entries, picked),
    { own: [slide('/Fam/a.jpg'), slide('/Fam/b.mp4', 'video')], walk: ['/Fam/Sub', '/Fam/Other'], cap: true });                   // subfolders is not asked: a folder is played whole
  assert.deepEqual(poolSources({ scope: 'selected', subfolders: true }, '/Fam', entries, picked).walk, ['/Fam/Sub', '/Fam/Other']);
  // a share whose folder is gone has nothing to walk
  assert.deepEqual(poolSources({ scope: 'selected', subfolders: false }, '/', entries, [dir('Gone', { unavailable: true }), dir('Fam')]).walk, ['/Fam']);
  // Selected with nothing selected is the folder (the design falls back the same way)
  assert.deepEqual(poolSources({ scope: 'selected', subfolders: false }, '/Fam', entries, []), poolSources(folder(false), '/Fam', entries, []));
  // the names are paths: a name with a hash and a percent sign is one name
  assert.deepEqual(poolSources(folder(false), '/Дача #2 (2024)', [file('IMG 50%.jpg')], []).own.map((i) => i.path), ['/Дача #2 (2024)/IMG 50%.jpg']);
});

test('joinPool: what the folders walked gave, after the known files, under one cap that says so; null while a folder has not answered', () => {
  const walked = { '/A': { items: [slide('/A/1.jpg'), slide('/A/2.jpg')], capped: false }, '/B': { items: [slide('/B/1.jpg')], capped: false } };
  assert.deepEqual(joinPool({ own: [slide('/x.jpg')], walk: ['/A', '/B'], cap: true }, walked),
    { items: [slide('/x.jpg'), slide('/A/1.jpg'), slide('/A/2.jpg'), slide('/B/1.jpg')], capped: false });
  assert.equal(joinPool({ own: [], walk: ['/A', '/C'], cap: true }, walked), null);
  assert.deepEqual(joinPool({ own: [slide('/x.jpg')], walk: [], cap: false }, {}), { items: [slide('/x.jpg')], capped: false });

  const many = (dirName: string, n: number) => Array.from({ length: n }, (_, i) => slide(`/${dirName}/${i}.jpg`));
  // a walk the server cut short says so
  assert.equal(joinPool({ own: [], walk: ['/A'], cap: true }, { '/A': { items: many('A', SLIDE_CAP), capped: true } })!.capped, true);
  // two folders that fit one cap each do not fit it together: the first 5000, in order, and the note
  const both = joinPool({ own: [slide('/x.jpg')], walk: ['/A', '/B'], cap: true }, { '/A': { items: many('A', 3000), capped: false }, '/B': { items: many('B', 3000), capped: false } })!;
  assert.equal(both.items.length, SLIDE_CAP);
  assert.equal(both.capped, true);
  assert.deepEqual([both.items[0].path, both.items[1].path, both.items[3000].path, both.items[4999].path], ['/x.jpg', '/A/0.jpg', '/A/2999.jpg', '/B/1998.jpg']);
  // exactly the cap is not over it
  assert.equal(joinPool({ own: many('s', SLIDE_CAP), walk: [], cap: true }, {})!.capped, false);
  assert.equal(joinPool({ own: many('s', SLIDE_CAP + 1), walk: [], cap: true }, {})!.capped, true);
  // the folder's own files are not a recursive list: all of them play
  assert.equal(joinPool({ own: many('s', SLIDE_CAP + 10), walk: [], cap: false }, {})!.items.length, SLIDE_CAP + 10);
  assert.equal(CAPPED_NOTE, 'Showing the first 5000 items.');
});

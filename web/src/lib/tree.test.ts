import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FolderNode } from '../../../shared/types.ts';
import { treeRows } from './tree.ts';

const loaded: Record<string, FolderNode[]> = {
  '/': [{ name: 'Family', count: 40, hasChildren: true }, { name: 'Gone', count: 0, hasChildren: false, unavailable: true }, { name: 'Дача #2', count: 7, hasChildren: false }],
  '/Family': [{ name: 'Birthdays', count: 9, hasChildren: false }, { name: 'Summer house', count: 14, hasChildren: true }],
  '/Family/Summer house': [{ name: 'Pool', count: 2, hasChildren: false }],
};
const kidsOf = (path: string) => loaded[path];
const brief = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.active ? ' *' : ''}`);

test('the root alone until its folders have arrived, with a chevron because nobody knows yet', () => {
  const rows = treeRows('/', new Set(['/']), () => undefined);
  assert.deepEqual(rows, [{ path: '/', name: 'Home Gallery', depth: 0, count: 0, expandable: true, open: true, active: true, unavailable: false }]);
});

test('rows are the open folders, depth first, each under its own path', () => {
  assert.deepEqual(brief(treeRows('/', new Set(['/']), kidsOf)), ['Home Gallery *', '  Family', '  Gone', '  Дача #2']);
  const rows = treeRows('/Family/Summer house', new Set(['/', '/Family', '/Family/Summer house']), kidsOf);
  assert.deepEqual(brief(rows), ['Home Gallery', '  Family', '    Birthdays', '    Summer house *', '      Pool', '  Gone', '  Дача #2']);
  assert.deepEqual(rows.map((r) => r.path), ['/', '/Family', '/Family/Birthdays', '/Family/Summer house', '/Family/Summer house/Pool', '/Gone', '/Дача #2']);
});

test('a folder that is closed hides what is below it, and what was loaded below a closed folder stays out of the way', () => {
  const rows = treeRows('/', new Set(['/', '/Family/Summer house']), kidsOf);   // Family is closed: its Summer house being "open" shows nothing
  assert.deepEqual(brief(rows), ['Home Gallery *', '  Family', '  Gone', '  Дача #2']);
  assert.equal(rows[1].open, false);
});

test('counts, chevrons and unavailable folders', () => {
  const rows = treeRows('/Gone', new Set(['/', '/Family']), kidsOf);
  assert.equal(rows[0].count, 47);                                                   // the root adds up its folders: it has no count of its own
  assert.deepEqual(rows.map((r) => r.count), [47, 40, 9, 14, 0, 7]);
  assert.deepEqual(rows.map((r) => r.expandable), [true, true, false, true, false, false]);
  const gone = rows.find((r) => r.name === 'Gone')!;
  assert.deepEqual([gone.unavailable, gone.expandable, gone.active], [true, false, true]);
  assert.equal(rows.filter((r) => r.unavailable).length, 1);
});

test('a root with no folders has no chevron', () => {
  const [root] = treeRows('/', new Set(['/']), () => []);
  assert.deepEqual([root.expandable, root.count], [false, 0]);
});

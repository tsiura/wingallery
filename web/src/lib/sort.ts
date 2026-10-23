// How a folder's items are ordered (design lines 523-524 SORTS, 614-625 rawItems, 730 cycleSort).

import type { Entry } from '../../../shared/types.ts';

export type SortKey = 'name' | 'date' | 'type' | 'size' | 'dims';

export const SORT_LABELS: Record<SortKey, string> = { name: 'Name', date: 'Date taken', type: 'Type', size: 'Size', dims: 'Dimensions' };

// The toolbar's button steps through these three; the other two keys are for the Details headers, and the button takes them back to name.
const CYCLE: SortKey[] = ['name', 'date', 'size'];
export const cycleSort = (key: SortKey): SortKey => CYCLE[(CYCLE.indexOf(key) + 1) % CYCLE.length];

// The server's naturalCompare (server/names.ts): the numbers in a name are numbers (IMG_2 before IMG_10) and case does not count. Names that differ only
// in case still get an order, by code unit, so that the list looks the same whatever order it arrived in.
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: Entry, b: Entry): number => natural(a.name, b.name) || codeUnits(a.name, b.name);

// What an entry is ordered by; null: it has none. A folder's date is its mtime, and it has no size or dimensions.
function valueOf(e: Entry, key: SortKey): string | number | null {
  if (key === 'name') return e.name;
  if (key === 'date') return e.kind === 'folder' ? e.mtime : e.takenAt;
  if (key === 'type') return e.kind === 'folder' ? 'File folder' : e.type;
  if (e.kind === 'folder') return null;
  return key === 'size' ? e.size : e.width !== null && e.height !== null ? e.width * e.height : null;
}

// A new list: folders first whatever the key and the direction, each group in order. Items with no value for the key come last either way, and items
// with equal values go by name, also when the direction is descending (as Explorer does).
export function sortEntries(entries: Entry[], key: SortKey, dir: 1 | -1): Entry[] {
  const text = key === 'type' ? natural : codeUnits;   // a type is a label like a name; a date taken is a wall clock of one width, so its text order is its time order
  const within = (a: Entry, b: Entry): number => {
    if (key === 'name') return byName(a, b) * dir;
    const x = valueOf(a, key), y = valueOf(b, key);
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : text(String(x), String(y));
    return r * dir || byName(a, b);
  };
  return [...entries].sort((a, b) => Number(a.kind !== 'folder') - Number(b.kind !== 'folder') || within(a, b));
}

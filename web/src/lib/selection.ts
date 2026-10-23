// What is selected, and where the arrow keys go, over one list of items. An item is its name; `order` is the names in the order they are shown.

export interface Sel {
  selected: string[];       // in list order
  anchor: string | null;    // where a Shift+click range starts: the item last clicked plainly or with Ctrl
}

export interface Mods { ctrl: boolean; shift: boolean }

export const NO_SELECTION: Sel = { selected: [], anchor: null };

const only = (name: string): Sel => ({ selected: [name], anchor: name });

// Click: only that item. Ctrl/Cmd+click: toggle it. Shift+click: the range from the anchor to it, which replaces the selection (with Ctrl, joins it) and
// keeps the anchor. With no anchor in the list, Shift+click is a click.
export function applyClick(sel: Sel, order: string[], name: string, mods: Mods): Sel {
  if (mods.shift) {
    const from = order.indexOf(sel.anchor ?? ''), to = order.indexOf(name);
    if (from < 0 || to < 0) return only(name);
    const picked = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    if (mods.ctrl) for (const n of sel.selected) picked.add(n);
    return { selected: order.filter((n) => picked.has(n)), anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const picked = new Set(sel.selected);
    if (!picked.delete(name)) picked.add(name);
    return { selected: order.filter((n) => picked.has(n)), anchor: name };
  }
  return only(name);
}

export const selectAll = (order: string[]): Sel => ({ selected: [...order], anchor: order[0] ?? null });

// The selection without the items that are not in the list (a search hid them, a reload lost them): an action on the selection must never reach an
// item that is out of sight. The same object when nothing goes.
export function pruneSel(sel: Sel, order: string[]): Sel {
  const here = new Set(order);
  const selected = sel.selected.filter((n) => here.has(n));
  return selected.length === sel.selected.length ? sel : { selected, anchor: sel.anchor };
}

// Where an arrow key takes the focus from item `at` of `count`, in a grid `columns` wide (a list is a grid of one). Null for any other key. The ends stay put,
// except that Down from the row above a short last row ends on the last item. With no item focused (`at` < 0) the arrows start at the first.
export function arrowTo(key: string, at: number, count: number, columns: number): number | null {
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -columns : key === 'ArrowDown' ? columns : 0;
  if (step === 0 || count === 0) return null;
  if (at < 0) return 0;
  const to = at + step;
  if (to >= 0 && to < count) return to;
  return step > 1 && Math.floor(at / columns) < Math.floor((count - 1) / columns) ? count - 1 : at;
}

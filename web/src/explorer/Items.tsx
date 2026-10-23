import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, KeyboardEvent } from 'react';
import type { Entry, FileEntry, ViewMode } from '../../../shared/types.ts';
import { thumbUrl } from '../api.ts';
import { fmtDate, fmtDur, fmtEpoch, fmtSize } from '../lib/format.ts';
import { joinV } from '../lib/route.ts';
import { arrowTo } from '../lib/selection.ts';
import type { Mods, Sel } from '../lib/selection.ts';
import { SORT_LABELS } from '../lib/sort.ts';
import type { SortKey } from '../lib/sort.ts';
import { Button } from '../ui/controls.tsx';
import { useNarrow } from '../ui/hooks.ts';
import { Icon, ITEM_FOLDER } from '../ui/Icon.tsx';

const TOGGLE: Mods = { ctrl: true, shift: false };
const LONG_PRESS_MS = 500;
const DRIFT_PX = 10;                                                                       // a finger that moves further than this during a press is scrolling
const COLUMNS = 'minmax(0,2.4fr) minmax(0,1.4fr) minmax(0,.9fr) minmax(0,.7fr) minmax(0,.9fr)';   // Name, Date taken, Type, Size, Dimensions
const COLUMNS_PHONE = 'minmax(0,2.4fr) minmax(0,1.4fr)';                                   // a phone has room for the first two
const KEYS = Object.keys(SORT_LABELS) as SortKey[];                                        // the columns, in the order the labels are written
const UNAVAILABLE = 'This folder is unavailable.';
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

// A folder shows when it was changed (a share whose folder is gone has no time), a file when it was taken.
const dateOf = (e: Entry): string => (e.kind === 'folder' ? (e.mtime > 0 ? fmtEpoch(e.mtime) : '') : fmtDate(e.takenAt));
const dimsOf = (e: FileEntry): string => (e.width !== null && e.height !== null ? `${e.width} × ${e.height}` : '');

// How many tiles the browser fitted into a row (auto-fill: it isn't known until the grid is laid out).
const columnsOf = (grid: HTMLElement | null): number => (grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1);

// Whether the image at `src` has failed to load. A new `src` is a new image, so a thumbnail made later gets its chance.
function useBroken(src: string | null): [broken: boolean, markBroken: () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  return [src !== null && failed === src, () => setFailed(src)];
}

// The tick of selection mode.
function Tick({ on, size }: { on: boolean; size: number }) {
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, flexShrink: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
      border: `1.5px solid ${on ? '#005fb8' : '#8a8f99'}`, background: on ? '#005fb8' : 'rgba(255,255,255,.88)',
    }}>{on && <Icon name="check" size={size - 6} />}</span>
  );
}

// The server's thumbnail of a photo or video (design lines 156-164 and 191-192). Where it has none (it answers 422 for a file it can't read) a plain box with
// a picture or film icon stands in, and a video keeps its duration.
function Thumb({ entry, src, small }: { entry: FileEntry; src: string; small?: boolean }) {
  const [broken, markBroken] = useBroken(src);
  const video = entry.kind === 'video';
  const over: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' };
  const radius = small ? 3 : 4;
  return (
    <div style={{ position: 'relative', flexShrink: 0, width: small ? 28 : '100%', height: small ? 22 : '100%' }}>
      {broken
        ? <div style={{ ...over, borderRadius: radius, background: '#e8ebf0', color: '#8a8f99' }}><Icon name={video ? 'video' : 'photo'} size={small ? 14 : 32} /></div>
        : <img src={src} alt="" loading="lazy" draggable={false} onError={markBroken} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: radius, background: '#e8ebf0' }} />}
      {video && !broken && (
        <div style={over}>
          {small
            ? <svg width="10" height="10" viewBox="0 0 16 16"><path d="M4 2v12l10-6z" fill="#fff" stroke="rgba(0,0,0,.4)" strokeWidth="1" /></svg>
            : <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(20,22,26,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 16 16"><path d="M5 3v10l8-5z" fill="#fff" /></svg>
              </div>}
        </div>
      )}
      {video && !small && entry.duration !== null && (
        <div style={{ position: 'absolute', right: 6, bottom: 6, padding: '1px 6px', borderRadius: 4, background: 'rgba(20,22,26,.72)', color: '#fff', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {fmtDur(entry.duration)}
        </div>
      )}
    </div>
  );
}

// The folder of the tile views (design lines 149-153): its back, the cover photo in it (when it has one, and the server could make a thumbnail of it) and
// the front over the lower part of the cover.
function FolderArt({ cover }: { cover: string | null }) {
  const [broken, markBroken] = useBroken(cover);
  return (
    <div style={{ position: 'relative', width: '86%', height: '82%' }}>
      <svg viewBox="0 0 100 76" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <path d="M0 6a5 5 0 015-5h28l8 8h54a5 5 0 015 5v57a5 5 0 01-5 5H5a5 5 0 01-5-5z" fill={ITEM_FOLDER.back} />
      </svg>
      {cover !== null && !broken && (
        <img src={cover} alt="" loading="lazy" draggable={false} onError={markBroken}
          style={{ position: 'absolute', left: '10%', top: '16%', width: '80%', height: '58%', objectFit: 'cover', borderRadius: 3, border: '2px solid #fff', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
      )}
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '58%' }}>
        <path d="M0 5a5 5 0 015-5h90a5 5 0 015 5v40a5 5 0 01-5 5H5a5 5 0 01-5-5z" fill={ITEM_FOLDER.front} fillOpacity=".96" />
      </svg>
    </div>
  );
}

interface ItemProps { entry: Entry; vpath: string; picking: boolean; checked: boolean; dom: HTMLAttributes<HTMLDivElement> }

// One item of the Large and Medium views (design lines 146-168). `dom` is what makes it an option of the list: role, focus, clicks.
function Tile({ entry, vpath, picking, checked, dom }: ItemProps) {
  const gone = entry.kind === 'folder' && entry.unavailable === true;
  return (
    <div {...dom} title={gone ? UNAVAILABLE : entry.name} style={{
      padding: '8px 8px 10px', borderRadius: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: gone ? 0.5 : undefined,
    }}>
      <div style={{ width: '100%', aspectRatio: '4 / 3', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {entry.kind === 'folder'
          ? <FolderArt cover={entry.cover === null ? null : thumbUrl(entry.cover, entry.mtime)} />
          : <Thumb entry={entry} src={thumbUrl(joinV(vpath, entry.name), entry.mtime)} />}
        {picking && <span style={{ position: 'absolute', top: 6, left: 6 }}><Tick on={checked} size={22} /></span>}
      </div>
      <div style={{ width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 12, lineHeight: '16px', ...ellipsis }}>{entry.name}</div>
        {entry.kind === 'folder' && <div style={{ fontSize: 11, lineHeight: '14px', color: '#6b6f78', ...ellipsis }}>{gone ? 'Unavailable' : `${entry.count} items`}</div>}
      </div>
    </div>
  );
}

// One item of the Details table (design lines 184-201). A folder has a date and a type, and no size or dimensions (spec 5.2.12).
function Row({ entry, vpath, picking, checked, dom, phone }: ItemProps & { phone: boolean }) {
  const gone = entry.kind === 'folder' && entry.unavailable === true;
  const cell: CSSProperties = { padding: '0 8px', color: '#5c616b', ...ellipsis };
  return (
    <div {...dom} title={gone ? UNAVAILABLE : entry.name} style={{
      display: 'grid', gridTemplateColumns: phone ? COLUMNS_PHONE : COLUMNS, height: 36, alignItems: 'center', borderRadius: 4,
      scrollMarginTop: 34, opacity: gone ? 0.5 : undefined,   // the sticky header is 34 px: a row that is scrolled to must stop below it
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px', minWidth: 0 }}>
        {picking && <Tick on={checked} size={20} />}
        {entry.kind === 'folder'
          ? <Icon name="folderItem" size={22} />
          : <Thumb entry={entry} src={thumbUrl(joinV(vpath, entry.name), entry.mtime)} small />}
        <span style={ellipsis}>{entry.name}</span>
      </div>
      <div style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{dateOf(entry)}</div>
      {!phone && (
        <>
          <div style={cell}>{entry.kind === 'folder' ? 'File folder' : entry.type}</div>
          <div style={{ ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{entry.kind === 'folder' ? '' : fmtSize(entry.size)}</div>
          <div style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{entry.kind === 'folder' ? '' : dimsOf(entry)}</div>
        </>
      )}
    </div>
  );
}

// The folder's items as tiles or as the Details table (design lines 137-207). `entries` are what is shown, in order, and `sel` is which of them are selected;
// Explorer owns both, and answers `onClick` (a click on an item, with the modifier keys), `onSelectAll`, `onClear` (a click on the empty space), `onOpen`
// and, for the keys that act on the selection (Delete, F2), `onKey`.
//
// With a mouse: click selects, Ctrl/Cmd+click toggles, Shift+click selects a range, double-click opens. With a finger a tap opens, and a long press
// (500 ms) starts selection mode: the items get a tick, a tap toggles, and it ends when nothing is selected any more or with "Done". There is no flag for
// the mode: it is a selection while the last press (anywhere in the page) was a finger's, so "Select all" by finger starts it too.
// With the keyboard: the arrows move the focus, Enter opens the focused item, Space toggles it, Ctrl/Cmd+A selects all.
export function Items({ entries, vpath, view, sortKey, sortDir, onSort, sel, onClick: select, onSelectAll, onOpen, onClear, onKey }: {
  entries: Entry[]; vpath: string; view: ViewMode; sortKey: SortKey; sortDir: 1 | -1; onSort(key: SortKey): void;
  sel: Sel; onClick(name: string, mods: Mods): void; onSelectAll(): void; onOpen(entry: Entry): void; onClear(): void; onKey?(e: KeyboardEvent<HTMLElement>): void;
}) {
  const phone = useNarrow();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);                                  // its children are the items
  const [cursor, setCursor] = useState<string | null>(null);                  // the item that last had the focus: Tab comes back to it
  const [touch, setTouch] = useState(false);                                  // the last press anywhere was a finger's
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);   // a finger that is down on an item and may be long-pressing it
  const longPressed = useRef(false);                                          // the finger that is lifting had pressed long: the click it makes is not a tap
  const picked = useMemo(() => new Set(sel.selected), [sel.selected]);
  const selecting = touch && sel.selected.length > 0;
  const stop = entries.some((e) => e.name === cursor) ? cursor : entries[0]?.name;   // the one item in the Tab order

  function endPress(): void {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  useEffect(() => {
    const note = (e: PointerEvent) => setTouch(e.pointerType === 'touch');
    document.addEventListener('pointerdown', note, true);
    return () => { document.removeEventListener('pointerdown', note, true); endPress(); };
  }, []);

  // A folder just opened has lost the item that opened it. The keys work on this pane, so it takes the focus, unless something else (the search box, the tree) has it.
  useEffect(() => { if (document.activeElement === document.body) scroller.current?.focus({ preventScroll: true }); }, []);

  const domOf = (entry: Entry): HTMLAttributes<HTMLDivElement> => {
    const name = entry.name;
    return {
      role: 'option', className: 'item', tabIndex: name === stop ? 0 : -1, 'aria-selected': picked.has(name),
      onFocus: () => setCursor(name),
      onPointerDown: (e) => {
        longPressed.current = false;
        if (e.pointerType !== 'touch') return;
        endPress();
        press.current = {
          x: e.clientX, y: e.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            longPressed.current = true;
            if (selecting || !picked.has(name)) select(name, TOGGLE);   // in selection mode a long press is a tap; out of it, the item joins the selection
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove: (e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRIFT_PX) endPress();
      },
      onPointerUp: endPress, onPointerCancel: endPress, onPointerLeave: endPress,
      onClick: (e) => {
        e.stopPropagation();                                                // a click on an item is not one on the empty space, which clears the selection
        if (longPressed.current) { longPressed.current = false; return; }
        if (!touch) select(name, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
        else if (selecting) select(name, TOGGLE);
        else onOpen(entry);                                                 // F14.3: outside selection mode a tap opens
      },
      onDoubleClick: () => { if (!touch) onOpen(entry); },                  // a double tap has opened the item with its first
      onContextMenu: (e) => { if (touch) e.preventDefault(); },             // the menu that a long press brings up (save image...) is not wanted
    };
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!el && e.target !== e.currentTarget) return;                        // the column headers are buttons with keys of their own
    const items = Array.from(list.current?.children ?? []) as HTMLElement[];
    const at = el ? items.indexOf(el) : -1;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); onSelectAll(); return; }
    if (mod || e.altKey) return;                                            // Alt+Left is the browser's Back
    if (e.key === 'Enter' || e.key === ' ') {
      if (at < 0) return;
      e.preventDefault();
      if (e.key === 'Enter') onOpen(entries[at]); else select(entries[at].name, TOGGLE);
    } else if (e.key === 'Delete' || e.key === 'F2') {
      onKey?.(e);
    } else {
      const to = arrowTo(e.key, at, entries.length, view === 'details' ? 1 : columnsOf(list.current));
      if (to === null) return;
      e.preventDefault();
      items[at < 0 ? entries.findIndex((en) => en.name === stop) : to]?.focus();   // from the pane itself the arrows land on the item Tab would
    }
  }

  const rows = view === 'details';
  const listProps = { ref: list, role: 'listbox', 'aria-multiselectable': true, 'aria-label': 'Items' } as const;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scroller} tabIndex={-1} onClick={onClear} onKeyDown={onKeyDown} style={{ flex: 1, minHeight: 0, overflow: 'auto', outline: 'none' }}>
        {rows ? (
          <div style={{ minWidth: phone ? undefined : 640 }}>
            <div style={{
              position: 'sticky', top: 0, zIndex: 1, background: '#fff', display: 'grid', gridTemplateColumns: phone ? COLUMNS_PHONE : COLUMNS,
              padding: '0 12px', height: 34, alignItems: 'stretch', borderBottom: '1px solid #eceef2', color: '#4a4e57',
            }}>
              {KEYS.slice(0, phone ? 2 : KEYS.length).map((key) => {
                const on = key === sortKey;
                return (
                  <button key={key} type="button" className="col-head" onClick={(e) => { e.stopPropagation(); onSort(key); }}
                    aria-label={on ? `${SORT_LABELS[key]}, sorted ${sortDir > 0 ? 'ascending' : 'descending'}` : SORT_LABELS[key]}>
                    <span>{SORT_LABELS[key]}</span>
                    <span aria-hidden="true" style={{ fontSize: 10, color: '#005fb8' }}>{on ? (sortDir > 0 ? '▲' : '▼') : ''}</span>
                  </button>
                );
              })}
            </div>
            <div {...listProps} style={{ padding: '4px 12px 12px' }}>
              {entries.map((entry) => <Row key={entry.name} entry={entry} vpath={vpath} picking={selecting} checked={picked.has(entry.name)} dom={domOf(entry)} phone={phone} />)}
            </div>
          </div>
        ) : (
          <div {...listProps} style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${view === 'large' ? 210 : 140}px, 1fr))`, gap: 4, padding: 12 }}>
            {entries.map((entry) => <Tile key={entry.name} entry={entry} vpath={vpath} picking={selecting} checked={picked.has(entry.name)} dom={domOf(entry)} />)}
          </div>
        )}
      </div>
      {selecting && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 12px', background: '#e5eef8', borderTop: '1px solid #cfe0f3' }}>
          <span style={{ fontWeight: 600 }}>{sel.selected.length} selected</span>
          <Button variant="primary" onClick={onClear}>Done</Button>
        </div>
      )}
    </div>
  );
}

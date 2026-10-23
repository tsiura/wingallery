import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { FolderNode } from '../../../shared/types.ts';
import { api, q } from '../api.ts';
import { crumbsOf } from '../lib/route.ts';
import { treeRows } from '../lib/tree.ts';
import type { TreeRow } from '../lib/tree.ts';
import { useNarrow } from '../ui/hooks.ts';
import { Chevron, Icon } from '../ui/Icon.tsx';

const DRAWER: CSSProperties = { position: 'fixed', top: 0, bottom: 0, left: 0, width: 280, zIndex: 20, padding: '8px 8px 12px', background: '#eef1f5', transition: 'transform .2s ease-out' };

// The folder tree (design lines 86-100): "Home Gallery" and, under each open folder, its subfolders with their recursive media counts.
// A folder's subfolders are asked for when it is opened, and kept until `refreshKey` changes. On a phone the tree is a drawer over the page, shown while `open`.
export function Sidebar({ vpath, open, onNavigate, onClose, refreshKey }: { vpath: string; open: boolean; onNavigate(vpath: string): void; onClose(): void; refreshKey: number }) {
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['/']));
  // Subfolders by path. `key` is the refreshKey they were read under: once it is out of date they still show, until the new answer replaces them.
  const [loaded, setLoaded] = useState<Readonly<Record<string, { key: number; nodes: FolderNode[] }>>>({});
  const asked = useRef({ key: refreshKey, paths: new Set<string>() });   // what has been requested under the current key
  const tree = useRef<HTMLDivElement>(null);

  // The folders above the one that is open are opened (and can be closed again by hand afterwards).
  useEffect(() => {
    setExpanded((prev) => {
      const missing = crumbsOf(vpath).slice(0, -1).map((c) => c.vpath).filter((path) => !prev.has(path));
      return missing.length > 0 ? new Set([...prev, ...missing]) : prev;
    });
  }, [vpath]);

  // Each open folder is asked for once per key. Nothing is cancelled: an answer for an older key must not replace a newer one, and that is all that is checked.
  useEffect(() => {
    if (asked.current.key !== refreshKey) asked.current = { key: refreshKey, paths: new Set() };
    const round = asked.current;
    for (const path of expanded) {
      if (round.paths.has(path)) continue;
      round.paths.add(path);
      api<FolderNode[]>('GET', `/api/folders?path=${q(path)}`).then(
        (nodes) => setLoaded((prev) => ((prev[path]?.key ?? -1) > refreshKey ? prev : { ...prev, [path]: { key: refreshKey, nodes } })),
        () => { round.paths.delete(path); },   // a folder that can't be read shows nothing below it, and is asked for again the next time the tree changes
      );
    }
  }, [expanded, refreshKey]);

  // A drawer that has just opened takes the focus, on the open folder, so that the keyboard works inside it and not on the page behind.
  useEffect(() => {
    if (narrow && open) tree.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [narrow, open]);

  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, open, onClose]);

  const toggle = (path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  const rows = treeRows(vpath, expanded, (path) => loaded[path]?.nodes);
  const tabStop = rows.some((r) => r.active) ? vpath : '/';   // Tab lands on the open folder; the arrow keys go from there

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    const go = (to: Element | null) => (to as HTMLElement | null)?.focus();
    if (e.key === 'Enter' || e.key === ' ') { if (!row.unavailable) onNavigate(row.path); }
    else if (e.key === 'ArrowRight') { if (row.expandable && !row.open) toggle(row.path); }
    else if (e.key === 'ArrowLeft') { if (row.open) toggle(row.path); }
    else if (e.key === 'ArrowDown') go(e.currentTarget.nextElementSibling);
    else if (e.key === 'ArrowUp') go(e.currentTarget.previousElementSibling);
    else return;
    e.preventDefault();
  };

  return (
    <>
      {narrow && open && <div onClick={onClose} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 19, background: 'rgba(20,24,32,.32)' }} />}
      <div ref={tree} role="tree" aria-label="Folders" inert={narrow && !open} style={{
        overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1,
        ...(narrow
          ? { ...DRAWER, transform: open ? 'none' : 'translateX(-100%)', boxShadow: open ? '0 0 32px rgba(0,0,0,.28)' : 'none' }
          : { width: 232, flexShrink: 0, padding: '4px 8px 12px' }),
      }}>
        {rows.map((row) => (
          <div key={row.path} role="treeitem" className="tree-row" aria-level={row.depth + 1} aria-selected={row.active}
            aria-expanded={row.expandable ? row.open : undefined} aria-disabled={row.unavailable || undefined}
            tabIndex={row.path === tabStop ? 0 : -1} title={row.unavailable ? 'This folder is unavailable.' : row.name}
            style={{ paddingLeft: 4 + row.depth * 14 }}
            onClick={() => { if (!row.unavailable) onNavigate(row.path); }} onKeyDown={(e) => onKeyDown(e, row)}>
            <span className="tree-chev" onClick={(e) => { e.stopPropagation(); toggle(row.path); }}
              style={{ visibility: row.expandable ? 'visible' : 'hidden', transform: row.open ? 'rotate(90deg)' : 'none' }}>
              <Chevron size={10} color="#5c616b" width={1.4} />
            </span>
            <span style={{ display: 'flex', opacity: row.unavailable ? 0.4 : 1 }}><Icon name="folder" /></span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
            {row.count > 0 && <span style={{ color: '#8a8f99', fontSize: 11 }}>{row.count}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

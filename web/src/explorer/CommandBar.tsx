import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { crumbsOf, nameOf, ROOT_NAME } from '../lib/route.ts';
import { useNarrow } from '../ui/hooks.ts';
import { Chevron, Icon } from '../ui/Icon.tsx';

// Back, forward, up, the breadcrumbs and the search box (design lines 56-83). On a phone it also holds the ☰ that opens the folder drawer,
// and the search box is an icon until it is tapped; while it is out, it takes the place of the buttons and the breadcrumbs.
export function CommandBar({ vpath, canBack, canForward, onBack, onForward, onUp, onNavigate, query, onQuery, onMenu }: {
  vpath: string; canBack: boolean; canForward: boolean; onBack(): void; onForward(): void; onUp(): void; onNavigate(vpath: string): void;
  query: string; onQuery(query: string): void; onMenu(): void;
}) {
  const narrow = useNarrow();
  const [tapped, setTapped] = useState(false);
  const trail = useRef<HTMLElement>(null);
  const crumbs = crumbsOf(vpath);
  const placeholder = `Search ${vpath === '/' ? ROOT_NAME : nameOf(vpath)}`;
  const searching = !narrow || tapped || query !== '';   // a query that is filtering the folder keeps its box in sight

  useEffect(() => { setTapped(false); }, [vpath]);   // a folder starts with the icon again
  // The address bar is only as wide as the screen leaves it, and the folder you are in is the end of the path: keep the end in view.
  useLayoutEffect(() => { if (trail.current) trail.current.scrollLeft = trail.current.scrollWidth; }, [vpath, searching]);

  const closeSearch = () => { onQuery(''); setTapped(false); };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 8px', flexShrink: 0 }}>
      {narrow && <button type="button" className="bar-btn sq" title="Folders" onClick={onMenu}><Icon name="menu" /></button>}
      {!(narrow && searching) && (
        <>
          <div style={{ display: 'flex', gap: 2 }}>
            <button type="button" className="bar-btn sq" title="Back" disabled={!canBack} onClick={onBack}><Icon name="back" /></button>
            <button type="button" className="bar-btn sq" title="Forward" disabled={!canForward} onClick={onForward}><Icon name="forward" /></button>
            <button type="button" className="bar-btn sq" title="Up" disabled={vpath === '/'} onClick={onUp}><Icon name="up" /></button>
          </div>
          <nav ref={trail} aria-label="Breadcrumb" className="crumbs" style={{
            flex: 1, minWidth: 0, height: 32, display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px', overflowX: 'auto',
            background: '#fff', border: '1px solid #dcdfe5', borderRadius: 6,
          }}>
            <span style={{ display: 'flex', marginRight: 4 }}><Icon name="folderFlat" /></span>
            {crumbs.map((c, i) => (
              <div key={c.vpath} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <Chevron size={12} color="#8a8f99" width={1.2} />
                <button type="button" className="crumb" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onClick={() => onNavigate(c.vpath)}>{c.name}</button>
              </div>
            ))}
          </nav>
        </>
      )}
      {searching ? (
        <div className="search" style={{
          flex: narrow ? 1 : '0 1 240px', minWidth: narrow ? 0 : 120, height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
          background: '#fff', border: '1px solid #dcdfe5', borderRadius: 6,
        }}>
          <input value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
            placeholder={placeholder} aria-label={placeholder} autoComplete="off" spellCheck={false} autoFocus={narrow}
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: '#1b1b1f' }} />
          {narrow
            ? <button type="button" className="bar-btn" title="Close search" onClick={closeSearch} style={{ width: 24, height: 24, padding: 0 }}><Icon name="close" size={12} /></button>
            : <span style={{ display: 'flex', color: '#6b6f78' }}><Icon name="search" size={14} /></span>}
        </div>
      ) : (
        <button type="button" className="bar-btn sq" title="Search" onClick={() => setTapped(true)}><Icon name="search" /></button>
      )}
    </div>
  );
}

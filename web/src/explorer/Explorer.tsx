import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Entry, Listing, Me, ViewMode } from '../../../shared/types.ts';
import { api, q } from '../api.ts';
import { canBack, canForward, placeAt, popped, pushed } from '../lib/nav.ts';
import { browseHref, joinV, parentOf, vpathFromLocation } from '../lib/route.ts';
import { applyClick, NO_SELECTION, pruneSel, selectAll } from '../lib/selection.ts';
import type { Mods, Sel } from '../lib/selection.ts';
import { cycleSort, sortEntries } from '../lib/sort.ts';
import type { SortKey } from '../lib/sort.ts';
import { CommandBar } from './CommandBar.tsx';
import { Items } from './Items.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TitleBar } from './TitleBar.tsx';
import { Toolbar } from './Toolbar.tsx';

// What the pane says when there is nothing to show: the design's text for an empty folder.
function Message({ children }: { children: ReactNode }) {
  return <div style={{ padding: '64px 24px', textAlign: 'center', color: '#6b6f78' }}>{children}</div>;
}

// The window's frame: title bar, command bar, folder tree and status bar around the folder that the address names. The address is the folder: every
// move pushes /browse/<path> onto the browser's history and Back, Forward and a reload come back here.
// `onMeChange` is for the settings window, which changes the signed-in user's own preferences.
export function Explorer({ me, onSignOut }: { me: Me; onMeChange(me: Me): void; onSignOut(): Promise<void> }) {
  const [vpath, setVpath] = useState(() => vpathFromLocation(location.pathname));
  const [place, setPlace] = useState(() => placeAt(history.state));
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<ViewMode>(me.prefs.defaultView);   // the Settings window edits the preference; the toolbar's switch is for this visit only
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [sel, setSel] = useState<Sel>(NO_SELECTION);
  const at = useRef(vpath);      // the folder the Explorer is in, for code that outlives a render (a reload that ends after you moved on)
  const newest = useRef(0);      // the number of the latest listing request: only its answer is used

  async function load(path: string): Promise<void> {
    const mine = ++newest.current;
    try {
      const next = await api<Listing>('GET', `/api/list?path=${q(path)}`);
      if (mine === newest.current) { setListing(next); setError(null); }
    } catch (err) {
      if (mine === newest.current) { setListing(null); setError((err as Error).message); }
    }
  }

  // For whatever changes what is on disk: the folder's listing and the tree (its counts, its folders) are read again. Resolves when the listing is in.
  async function reload(): Promise<void> {
    setRefreshKey((k) => k + 1);
    await load(at.current);
  }

  // Every way of arriving at a folder (a click, Back, an address typed in) ends here: what belonged to the folder left behind goes, and the new one is read.
  function show(path: string): void {
    at.current = path;
    setVpath(path);
    setListing(null);
    setError(null);
    setQuery('');
    setSel(NO_SELECTION);
    setDrawerOpen(false);
    void load(path);
  }

  function navigate(path: string): void {
    if (path === at.current) { setDrawerOpen(false); void reload(); return; }   // the folder you are in: read it again, as Explorer does
    history.pushState({ idx: place.idx + 1 }, '', browseHref(path));
    setPlace(pushed(place));
    show(path);
  }

  useEffect(() => {
    void load(at.current);
    const onPop = (e: PopStateEvent) => { setPlace((p) => popped(p, e.state)); show(vpathFromLocation(location.pathname)); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const up = () => { const parent = parentOf(vpath); if (parent !== null) navigate(parent); };
  const noShares = me.role === 'member' && vpath === '/' && listing?.entries.length === 0;   // a member's root lists their shares, and there are none

  // What the pane shows: the folder's items that the search lets through, in the order asked for. Only what is in sight can be selected, so a search that
  // hides a selected item (or a reload that loses it) takes it out of the selection too: an action on the selection never reaches what you can't see.
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => sortEntries(listing ? listing.entries.filter((e) => e.name.toLowerCase().includes(needle)) : [], sort.key, sort.dir),
    [listing, needle, sort],
  );
  const order = useMemo(() => shown.map((e) => e.name), [shown]);
  const live = useMemo(() => pruneSel(sel, order), [sel, order]);
  const rights = listing?.rights;
  const readOnly = vpath !== '/' && rights !== undefined && !rights.create && !rights.update && !rights.delete;

  const click = (name: string, mods: Mods) => setSel((s) => applyClick(pruneSel(s, order), order, name, mods));
  const everything = () => setSel(selectAll(order));
  // A folder opens here; a file will open in the viewer, which is its own piece of work, so for now it does nothing. A share whose folder is gone can't be opened.
  const open = (entry: Entry) => { if (entry.kind === 'folder' && !entry.unavailable) navigate(joinV(vpath, entry.name)); };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#eef1f5', overflow: 'hidden' }}>
      {/* The settings window is its own piece of work; until it exists the account menu's entries only close the menu. */}
      <TitleBar me={me} onOpenSettings={() => {}} onSignOut={onSignOut} />
      <CommandBar vpath={vpath} canBack={canBack(place)} canForward={canForward(place)} onBack={() => history.back()} onForward={() => history.forward()} onUp={up}
        onNavigate={navigate} query={query} onQuery={setQuery} onMenu={() => setDrawerOpen(true)} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Sidebar vpath={vpath} open={drawerOpen} onNavigate={navigate} onClose={() => setDrawerOpen(false)} refreshKey={refreshKey} />
        <main style={{
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff', borderTopLeftRadius: 8,
          border: '1px solid #e1e4ea', borderRight: 'none', borderBottom: 'none',
        }}>
          {error === null && !noShares && (
            <Toolbar view={view} onView={setView} sortKey={sort.key} sortDir={sort.dir}
              onCycleSort={() => setSort((s) => ({ key: cycleSort(s.key), dir: 1 }))}
              allSelected={live.selected.length > 0} onSelectAll={() => (live.selected.length > 0 ? setSel(NO_SELECTION) : everything())}
              onSlideshow={() => {}} readOnly={readOnly} />
          )}
          {listing && shown.length > 0 ? (
            <Items entries={shown} vpath={vpath} view={view} sortKey={sort.key} sortDir={sort.dir}
              onSort={(key) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
              sel={live} onClick={click} onSelectAll={everything} onOpen={open} onClear={() => setSel((s) => (s.selected.length > 0 ? NO_SELECTION : s))} />
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {error !== null ? (
                <Message>
                  <div>This folder is unavailable.</div>
                  <div style={{ marginTop: 8 }}><a href={browseHref('/')} onClick={(e) => { e.preventDefault(); navigate('/'); }}>Go to Home Gallery</a></div>
                </Message>
              ) : noShares ? <Message>No folders are shared with you yet.</Message>
                : listing ? <Message>{needle ? `No items match “${query.trim()}”.` : 'This folder is empty.'}</Message> : null}
            </div>
          )}
          {listing && <StatusBar entries={shown} all={listing.entries} selected={live.selected} />}
        </main>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import type { DeletePreview, Entry, Listing, Me, ViewMode } from '../../../shared/types.ts';
import { api, downloadUrl, q, submitZip } from '../api.ts';
import { actionsFor, deleteWords, downloadPlan, mostActions, NO_ACTIONS, scopeRootOf } from '../lib/actions.ts';
import { canBack, canForward, placeAt, popped, pushed } from '../lib/nav.ts';
import { browseHref, joinV, parentOf, vpathFromLocation } from '../lib/route.ts';
import { applyClick, NO_SELECTION, pruneSel, selectAll } from '../lib/selection.ts';
import type { Mods, Sel } from '../lib/selection.ts';
import { cycleSort, sortEntries } from '../lib/sort.ts';
import type { SortKey } from '../lib/sort.ts';
import { createUploadQueue, filesOf } from '../lib/upload.ts';
import type { UploadProgress } from '../lib/upload.ts';
import { Icon } from '../ui/Icon.tsx';
import { CommandBar } from './CommandBar.tsx';
import { ConfirmDialog, MoveDialog, PromptDialog } from './Dialogs.tsx';
import { Items } from './Items.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { TitleBar } from './TitleBar.tsx';
import { Toolbar, ToolbarActions } from './Toolbar.tsx';
import { UploadPanel } from './UploadPanel.tsx';

const FOLDERS_NOT_UPLOADED = "Folders can't be uploaded — select files instead.";
const TOO_MANY_SELECTED = 'Too many items selected — download the folder instead';

// What the pane says when there is nothing to show: the design's text for an empty folder.
function Message({ children }: { children: ReactNode }) {
  return <div style={{ padding: '64px 24px', textAlign: 'center', color: '#6b6f78' }}>{children}</div>;
}

// A line over the items about what could not be done, until it is dismissed or the user goes elsewhere.
function Notice({ children, onDismiss }: { children: ReactNode; onDismiss(): void }) {
  return (
    <div role="alert" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#fdecea', borderBottom: '1px solid #f3c9c6', color: '#a4373a' }}>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      <button type="button" className="bar-btn" title="Dismiss" aria-label="Dismiss" onClick={onDismiss} style={{ width: 24, height: 24, padding: 0, flexShrink: 0 }}><Icon name="close" size={12} /></button>
    </div>
  );
}

// R4: a click on a link that says "download", not a navigation. When the server refuses (404) the browser shows a failed download and the app stays where it is.
function saveFile(vpath: string): void {
  const link = document.createElement('a');
  link.href = downloadUrl(vpath);
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

// The dialog that is open, if any, with what it is about. A delete is about the paths that were asked about, which are the ones it deletes (not whatever is
// selected by the time the user says yes).
type Open = { kind: 'newFolder' } | { kind: 'rename'; entry: Entry } | { kind: 'move' } | { kind: 'delete'; paths: string[]; preview: DeletePreview };

// The window's frame: title bar, command bar, folder tree and status bar around the folder that the address names. The address is the folder: every
// move pushes /browse/<path> onto the browser's history and Back, Forward and a reload come back here.
// The actions on the folder's items (upload, new folder, rename, move, delete, download) are here too: the bar's buttons and the keys ask, the dialogs answer.
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
  const [rawSel, setRawSel] = useState<Sel>(NO_SELECTION);   // what was clicked, including names that a search or a reload has since taken out of sight: never act on it, `live` is the selection
  const [dialog, setDialog] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [dragging, setDragging] = useState(false);   // files are being dragged over the pane
  const at = useRef(vpath);      // the folder the Explorer is in, for code that outlives a render (a reload that ends after you moved on)
  const newest = useRef(0);      // the number of the latest listing request: only its answer is used
  const pane = useRef<HTMLDivElement>(null);       // the items pane, which the keys work on
  const picker = useRef<HTMLInputElement>(null);   // the file input behind the Upload button
  // The queue lives as long as the Explorer. It is made once, with the first render's `reload`, which is as good as any later one: it only touches refs and setters.
  // When it runs empty the folder is read again, if a file went up: a drop that all failed (a connection that is gone) must not end in a failed reload, which
  // would replace the folder with "unavailable".
  const [queue] = useState(() => createUploadQueue({ onChange: setUploads, onIdle: (uploaded) => { if (uploaded > 0) void reload(); } }));

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

  // After something was changed on disk: the folder is read again, and `select` (a new or renamed item) is the selection, or nothing is. Not if the user has moved on.
  async function changed(select?: string): Promise<void> {
    const here = at.current;
    await reload();
    if (at.current === here) setRawSel(select === undefined ? NO_SELECTION : { selected: [select], anchor: select });
  }

  // Every way of arriving at a folder (a click, Back, an address typed in) ends here: what belonged to the folder left behind goes (a dialog about its items too), and the new one is read.
  function show(path: string): void {
    at.current = path;
    setVpath(path);
    setListing(null);
    setError(null);
    setQuery('');
    setRawSel(NO_SELECTION);
    setDialog(null);
    setNotice(null);
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

  // A file dropped on anything but the pane would open in this tab and take the app, and the uploads in it, away. The pane's own handlers have already answered.
  useEffect(() => {
    const refuse = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (e.type !== 'drop') e.dataTransfer.dropEffect = 'none';
    };
    const events = ['dragenter', 'dragover', 'drop'] as const;
    for (const type of events) document.addEventListener(type, refuse);
    return () => { for (const type of events) document.removeEventListener(type, refuse); };
  }, []);

  // R7: when a dialog is over, however it ended, the keys (arrows, Ctrl+A, Delete, F2) work again without a click: the focus goes to the items pane. This runs after
  // the dialog's own cleanup, which gives the focus back to the button or item that opened it.
  const dialogOpen = dialog !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !dialogOpen) focusPane();
    wasOpen.current = dialogOpen;
  }, [dialogOpen]);

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
  const live = useMemo(() => pruneSel(rawSel, order), [rawSel, order]);
  const picked = useMemo(() => {
    const byName = new Map(shown.map((e) => [e.name, e]));
    return live.selected.flatMap((name) => byName.get(name) ?? []);
  }, [shown, live]);
  const rights = listing?.rights;
  const readOnly = vpath !== '/' && rights !== undefined && !rights.create && !rights.update && !rights.delete;
  const actions = rights ? actionsFor(rights, picked) : NO_ACTIONS;   // R5: from `picked`, the selection that is in sight, and so is every action below
  const scopeRoot = scopeRootOf(vpath);

  const click = (name: string, mods: Mods) => setRawSel((s) => applyClick(pruneSel(s, order), order, name, mods));
  const everything = () => setRawSel(selectAll(order));
  // A folder opens here; a file will open in the viewer, which is its own piece of work, so for now it does nothing. A share whose folder is gone can't be opened.
  const open = (entry: Entry) => { if (entry.kind === 'folder' && !entry.unavailable) navigate(joinV(vpath, entry.name)); };

  const pathOf = (name: string) => joinV(vpath, name);
  const closeDialog = () => setDialog(null);
  // With no pane yet (the folder is empty, the files are on their way) the focus is let go instead: the pane takes it when it appears, as it does in a folder that was
  // just opened (Items), unless the user has put it somewhere else by then.
  function focusPane(): void {
    if (pane.current) pane.current.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
  }

  // Opens the dialog of an action, from the bar or from a key; a notice about an earlier action is not wanted any more.
  function ask(next: Open): void {
    setNotice(null);
    setDialog(next);
  }

  // The confirmation says what will go, so it is asked first: how many items, and how many files the gallery doesn't show go with the folders among them.
  async function startDelete(): Promise<void> {
    setNotice(null);
    const here = at.current;
    const paths = picked.map((e) => pathOf(e.name));
    try {
      const preview = await api<DeletePreview>('POST', '/api/delete/preview', { paths });
      if (at.current === here) setDialog({ kind: 'delete', paths, preview });
    } catch (err) {
      if (at.current === here) { setNotice((err as Error).message); focusPane(); }
    }
  }

  // One file is saved as it is; anything else is a zip. The zip's failure can only be told as "Download failed": the error page is the browser's, not ours (api.ts).
  function download(): void {
    setNotice(null);
    const plan = downloadPlan(vpath, picked, listing?.entries.length ?? 0);
    if (plan.kind === 'file') saveFile(plan.path);
    else if (plan.kind === 'zip') submitZip(plan.paths, setNotice);
    else setNotice(TOO_MANY_SELECTED);
    focusPane();
  }

  // The keys that act on the selection, from the items pane (Items passes on Delete and F2).
  function onKey(e: KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Delete' && actions.delete) { e.preventDefault(); void startDelete(); }
    else if (e.key === 'F2' && actions.rename) { e.preventDefault(); ask({ kind: 'rename', entry: picked[0] }); }
  }

  // Files dragged over the pane. Only files count (the page's own images and text are dragged too), and without the right to create here, the drop is refused.
  // The answer is given on entering as well as over: a browser that keeps to the specification to the letter takes only an entered target for a drop target.
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  function onDragOver(e: DragEvent<HTMLElement>): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = actions.upload ? 'copy' : 'none';
    if (actions.upload) setDragging(true);
  }
  // Leaving for a child of the pane is a leave too, so the pointer's place says whether it left the pane. A drag that is cancelled (Esc) leaves from inside it: the
  // mouse moving again, which it can't while the drag lasts, says it is over (`onMouseMove` below).
  function onDragLeave(e: DragEvent<HTMLElement>): void {
    const box = e.currentTarget.getBoundingClientRect();
    if (e.clientX <= box.left || e.clientX >= box.right || e.clientY <= box.top || e.clientY >= box.bottom) setDragging(false);
  }
  function onDrop(e: DragEvent<HTMLElement>): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (!actions.upload) return;
    const { files, folders } = filesOf(e.dataTransfer);
    setNotice(folders ? FOLDERS_NOT_UPLOADED : null);
    queue.add(files, vpath);
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#eef1f5', overflow: 'hidden' }}>
      {/* The settings window is its own piece of work; until it exists the account menu's entries only close the menu. */}
      <TitleBar me={me} onOpenSettings={() => {}} onSignOut={onSignOut} />
      <CommandBar vpath={vpath} canBack={canBack(place)} canForward={canForward(place)} onBack={() => history.back()} onForward={() => history.forward()} onUp={up}
        onNavigate={navigate} query={query} onQuery={setQuery} onMenu={() => setDrawerOpen(true)} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Sidebar vpath={vpath} open={drawerOpen} onNavigate={navigate} onClose={() => setDrawerOpen(false)} refreshKey={refreshKey} />
        <main onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onMouseMove={dragging ? () => setDragging(false) : undefined} style={{
          flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#fff', borderTopLeftRadius: 8,
          border: '1px solid #e1e4ea', borderRight: 'none', borderBottom: 'none', outline: dragging ? '2px dashed #005fb8' : undefined, outlineOffset: -6,
        }}>
          {error === null && !noShares && (
            <Toolbar view={view} onView={setView} sortKey={sort.key} sortDir={sort.dir}
              onCycleSort={() => setSort((s) => ({ key: cycleSort(s.key), dir: 1 }))}
              allSelected={live.selected.length > 0} onSelectAll={() => (live.selected.length > 0 ? setRawSel(NO_SELECTION) : everything())}
              onSlideshow={() => {}} readOnly={readOnly}>
              <ToolbarActions actions={actions} many={rights !== undefined && mostActions(rights) >= 4}
                on={{
                  upload: () => picker.current?.click(), newFolder: () => ask({ kind: 'newFolder' }), rename: () => ask({ kind: 'rename', entry: picked[0] }),
                  move: () => ask({ kind: 'move' }), delete: () => void startDelete(), download,
                }} />
            </Toolbar>
          )}
          {notice !== null && <Notice onDismiss={() => setNotice(null)}>{notice}</Notice>}
          {listing && shown.length > 0 ? (
            <Items entries={shown} vpath={vpath} view={view} sortKey={sort.key} sortDir={sort.dir}
              onSort={(key) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))} pane={pane} onKey={onKey}
              sel={live} onClick={click} onSelectAll={everything} onOpen={open} onClear={() => setRawSel((s) => (s.selected.length > 0 ? NO_SELECTION : s))} />
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
      {actions.upload && (
        <input ref={picker} type="file" multiple accept="image/*,video/*,.heic,.heif" hidden
          onChange={(e) => { setNotice(null); queue.add(Array.from(e.target.files ?? []), vpath); e.target.value = ''; focusPane(); }} />
      )}
      {uploads.length > 0 && <UploadPanel items={uploads} onCancel={queue.cancel} onClose={queue.clear} />}
      {dialog?.kind === 'newFolder' && (
        <PromptDialog title="New folder" label="Name" initial="New folder" submitLabel="Create" onClose={closeDialog}
          onSubmit={async (name) => { await api('POST', '/api/mkdir', { path: vpath, name }); await changed(name); }} />
      )}
      {dialog?.kind === 'rename' && (
        <PromptDialog title="Rename" label="Name" initial={dialog.entry.name} selectBase={dialog.entry.kind !== 'folder'} submitLabel="Rename" onClose={closeDialog}
          onSubmit={async (name) => {
            if (name === dialog.entry.name) return;
            await api('POST', '/api/rename', { path: pathOf(dialog.entry.name), name });
            await changed(name);
          }} />
      )}
      {dialog?.kind === 'move' && scopeRoot !== null && (
        <MoveDialog scopeRoot={scopeRoot} onClose={closeDialog} onMove={async (to) => {
          const paths = picked.map((e) => pathOf(e.name));   // the selection as it is now: after a move that stopped half way, what is left of it
          if (paths.length === 0) return;
          try {
            await api('POST', '/api/move', { paths, to });
          } catch (err) {
            await reload();   // the items before the one that failed have moved
            throw err;
          }
          await changed();
        }} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title="Delete" {...deleteWords(dialog.preview, me.role === 'member')} confirmLabel="Delete" onClose={closeDialog} onConfirm={async () => {
          try {
            await api('POST', '/api/delete', { paths: dialog.paths });
          } catch (err) {
            await reload();   // the items before the one that failed are in the Recycle Bin
            throw err;
          }
          await changed();
        }} />
      )}
    </div>
  );
}

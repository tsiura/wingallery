import { useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { DeletePreview, Entry, Me } from '../../../shared/types.ts';
import { api, saveFile, submitZip } from '../api.ts';
import { deleteWords, downloadPlan, ZIP_LIMIT } from '../lib/actions.ts';
import type { ActionState } from '../lib/actions.ts';
import { joinV } from '../lib/route.ts';
import { useAfterClose } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { ConfirmDialog, MoveDialog, PromptDialog } from './Dialogs.tsx';

const TOO_MANY_SELECTED = 'Too many items selected — download the folder instead';
const TOO_MANY_FILES = `Too many files for one download (limit ${ZIP_LIMIT})`;   // the server's own words (413), which a zip in a hidden iframe can't pass on

// A line over the items about what could not be done, until it is dismissed or the user goes elsewhere (the settings window uses it for a change that was refused).
export function Notice({ children, onDismiss }: { children: ReactNode; onDismiss(): void }) {
  return (
    <div role="alert" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#fdecea', borderBottom: '1px solid #f3c9c6', color: '#a4373a' }}>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      <button type="button" className="bar-btn" title="Dismiss" aria-label="Dismiss" onClick={onDismiss} style={{ width: 24, height: 24, padding: 0, flexShrink: 0 }}><Icon name="close" size={12} /></button>
    </div>
  );
}

// The dialog that is open, if any, with what it is about. A delete is about the paths that were asked about, which are the ones it deletes (not whatever is
// selected by the time the user says yes).
type Open = { kind: 'newFolder' } | { kind: 'rename'; entry: Entry } | { kind: 'move' } | { kind: 'delete'; paths: string[]; preview: DeletePreview };

// The actions on the folder's items (new folder, rename, move, delete, download; Upload is `Uploads`): the bar's buttons and the keys ask, the dialogs answer.
// `picked` is the selection that is in sight and the only one acted on, `actions` what the user's rights and that selection allow, `folderSize` how many items the
// folder has, `at` the folder the Explorer is in (for code that outlives a render), `reload` and `changed` read the folder again, `focusPane` gives the keys back.
// Returns the line about what could not be done (`notice`) and the open dialog (`dialogs`) to render, the handlers (`on` for the bar, `onKey` for the items pane)
// and `reset`, which the Explorer calls when it moves to another folder: a dialog about the old folder's items goes, and so does the line about them.
export function useFileActions({ role, vpath, at, picked, actions, folderSize, scopeRoot, reload, changed, focusPane }: {
  role: Me['role']; vpath: string; at: RefObject<string>; picked: Entry[]; actions: ActionState; folderSize: number; scopeRoot: string | null;
  reload(): Promise<void>; changed(select?: string): Promise<void>; focusPane(): void;
}) {
  const [dialog, setDialog] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // R7: when a dialog is over, however it ended, the keys (arrows, Ctrl+A, Delete, F2) work again without a click: the focus goes to the items pane. This runs after
  // the dialog's own cleanup, which gives the focus back to the button or item that opened it.
  useAfterClose(dialog !== null, focusPane);

  const pathOf = (name: string) => joinV(vpath, name);
  const closeDialog = () => setDialog(null);

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
  // So the limits the server would refuse it for are checked first (R4), and nothing is posted.
  function download(): void {
    setNotice(null);
    const plan = downloadPlan(vpath, picked, folderSize);
    if (plan.kind === 'file') saveFile(plan.path);
    else if (plan.kind === 'zip') submitZip(plan.paths, setNotice);
    else setNotice(plan.kind === 'too-many' ? TOO_MANY_SELECTED : TOO_MANY_FILES);
    focusPane();
  }

  // The keys that act on the selection, from the items pane (Items passes on Delete and F2).
  function onKey(e: KeyboardEvent<HTMLElement>): void {
    if (e.key === 'Delete' && actions.delete) { e.preventDefault(); void startDelete(); }
    else if (e.key === 'F2' && actions.rename) { e.preventDefault(); ask({ kind: 'rename', entry: picked[0] }); }
  }

  return {
    notice: notice !== null && <Notice onDismiss={() => setNotice(null)}>{notice}</Notice>,
    dialogs: (
      <>
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
          <ConfirmDialog title="Delete" {...deleteWords(dialog.preview, role === 'member')} confirmLabel="Delete" onClose={closeDialog} onConfirm={async () => {
            try {
              await api('POST', '/api/delete', { paths: dialog.paths });
            } catch (err) {
              await reload();   // the items before the one that failed are in the Recycle Bin
              throw err;
            }
            await changed();
          }} />
        )}
      </>
    ),
    on: {
      newFolder: () => ask({ kind: 'newFolder' }), rename: () => ask({ kind: 'rename', entry: picked[0] }), move: () => ask({ kind: 'move' }),
      delete: () => void startDelete(), download,
    },
    onKey,
    setNotice,
    reset: () => { setDialog(null); setNotice(null); },
  };
}

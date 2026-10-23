// The dialogs of the file actions, in the look of the design's modal (lines 218-266). Each is rendered by Explorer for as long as it is wanted: mounted means open,
// and `onClose` is what Esc, the backdrop and the Cancel button ask for (G12). While a request is out the buttons and fields are disabled, not the close.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import type { FolderNode } from '../../../shared/types.ts';
import { api, q } from '../api.ts';
import { baseLength } from '../lib/actions.ts';
import { joinV, nameOf } from '../lib/route.ts';
import { Button, Dialog, Field } from '../ui/controls.tsx';
import { Chevron, Icon } from '../ui/Icon.tsx';

// The card: a title (and a line under it), the body, and the buttons in the grey strip. A form, so that Enter in a field is a click on the submit button.
// `gap` is the space between the parts of the body: 14 px, and the slideshow's window has 18 px (design line 227).
export function Frame({ title, sub, gap = 14, footer, onSubmit, children, ref }: {
  title: string; sub?: ReactNode; gap?: number; footer: ReactNode; onSubmit(): void; children: ReactNode; ref?: Ref<HTMLFormElement>;
}) {
  return (
    <form ref={ref} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <div style={{ padding: '22px 24px 6px' }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
        {sub && <div style={{ color: '#5c616b', marginTop: 4 }}>{sub}</div>}
      </div>
      <div style={{ padding: '14px 24px 20px', display: 'flex', flexDirection: 'column', gap }}>{children}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '16px 24px', background: '#f1f3f6', borderTop: '1px solid #e6e8ec' }}>{footer}</div>
    </form>
  );
}

// What a dialog shows when the server refuses: its own words, in red. The dialog stays open, so the user can change the name and try again.
export const Alert = ({ message }: { message: string }) => (message ? <div role="alert" style={{ color: '#a4373a' }}>{message}</div> : null);

// A request in a dialog: `busy` while it is out, the server's message in `error` when it is refused, and `onClose` once it has gone through.
export function useSubmit(action: () => Promise<void>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await action();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

export const Footer = ({ busy, ready = true, label, onClose }: { busy: boolean; ready?: boolean; label: string; onClose(): void }) => (
  <>
    <Button onClick={onClose} disabled={busy}>Cancel</Button>
    <Button variant="primary" type="submit" disabled={busy || !ready}>{label}</Button>
  </>
);

// A name to type (new folder, rename). `onSubmit` makes the request, and throws what the server said when it is refused. With `selectBase` the name without its
// extension is selected, so that typing over it keeps the extension. With `secret` the box is a password box for the account of that username (a new password
// for a user); the username is in the form, out of sight, for the browser's password manager.
export function PromptDialog({ title, label, initial, selectBase, secret, submitLabel, onSubmit, onClose }: {
  title: string; label: string; initial: string; selectBase?: boolean; secret?: { username: string }; submitLabel: string; onSubmit(value: string): Promise<void>; onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const { busy, error, submit } = useSubmit(() => onSubmit(value), onClose);
  const form = useRef<HTMLFormElement>(null);
  // Dialog opens itself in its own effect, which runs before this one (a child's does), and a field can be selected once the dialog is open.
  useEffect(() => {
    const field = form.current?.querySelector<HTMLInputElement>('input:not([hidden])');
    field?.focus();
    field?.setSelectionRange(0, selectBase ? baseLength(initial) : initial.length);
  }, []);
  return (
    <Dialog label={title} onClose={onClose}>
      <Frame ref={form} title={title} onSubmit={submit} footer={<Footer busy={busy} label={submitLabel} onClose={onClose} />}>
        {secret && <input type="text" name="username" value={secret.username} autoComplete="username" readOnly hidden />}
        <Field label={label} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'new-password' : 'off'} spellCheck={false} />
        <Alert message={error} />
      </Frame>
    </Dialog>
  );
}

// A question with a button for the answer (delete). `detail` is lines under the question. Enter confirms.
export function ConfirmDialog({ title, message, detail, confirmLabel, onConfirm, onClose }: {
  title: string; message: string; detail?: string; confirmLabel: string; onConfirm(): Promise<void>; onClose(): void;
}) {
  const { busy, error, submit } = useSubmit(onConfirm, onClose);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLElement>('[type="submit"]')?.focus(); }, []);
  return (
    <Dialog label={title} onClose={onClose}>
      <Frame ref={form} title={title} onSubmit={submit} footer={<Footer busy={busy} label={confirmLabel} onClose={onClose} />}>
        <div>{message}</div>
        {detail && <div style={{ color: '#5c616b', whiteSpace: 'pre-line' }}>{detail}</div>}
        <Alert message={error} />
      </Frame>
    </Dialog>
  );
}

interface Row { path: string; name: string; depth: number; expandable: boolean; open: boolean; failed: boolean }

// The folders under `root`, as a tree to choose one from. A folder's subfolders are asked for (/api/folders) when it is opened. The root is open at the start.
function FolderPicker({ root, chosen, onChoose, frozen }: { root: string; chosen: string | null; onChoose(path: string): void; frozen: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([root]));
  const [kids, setKids] = useState<Readonly<Record<string, FolderNode[] | null>>>({});   // null: the folder could not be read
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const path of open) {
      if (asked.current.has(path)) continue;
      asked.current.add(path);
      api<FolderNode[]>('GET', `/api/folders?path=${q(path)}`).then(
        (nodes) => setKids((k) => ({ ...k, [path]: nodes })),
        () => setKids((k) => ({ ...k, [path]: null })),
      );
    }
  }, [open]);

  const toggle = (path: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  const rows: Row[] = [];
  const walk = (path: string, name: string, depth: number, node: FolderNode | null) => {
    const list = kids[path];
    rows.push({ path, name, depth, open: open.has(path), failed: list === null, expandable: node ? node.hasChildren : list === undefined || (list?.length ?? 0) > 0 });
    if (open.has(path) && list) for (const kid of list) walk(joinV(path, kid.name), kid.name, depth + 1, kid);
  };
  walk(root, nameOf(root), 0, null);
  const stop = rows.some((r) => r.path === chosen) ? chosen : root;   // the one row that Tab lands on: the chosen folder, unless a closed folder hides it

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: Row) => {
    const go = (to: Element | null) => (to as HTMLElement | null)?.focus();
    if (e.key === 'Enter' || e.key === ' ') onChoose(row.path);
    else if (e.key === 'ArrowRight') { if (row.expandable && !row.open) toggle(row.path); }
    else if (e.key === 'ArrowLeft') { if (row.open) toggle(row.path); }
    else if (e.key === 'ArrowDown') go(e.currentTarget.nextElementSibling);
    else if (e.key === 'ArrowUp') go(e.currentTarget.previousElementSibling);
    else return;
    e.preventDefault();
  };

  return (
    <div role="tree" aria-label="Folders" inert={frozen} style={{
      height: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: 4, background: '#fff', border: '1px solid #dcdfe5', borderRadius: 6,
    }}>
      {rows.map((row) => (
        <div key={row.path} role="treeitem" className="tree-row" aria-level={row.depth + 1} aria-selected={row.path === chosen} aria-expanded={row.expandable ? row.open : undefined}
          tabIndex={row.path === stop ? 0 : -1} style={{ paddingLeft: 4 + row.depth * 14 }}
          onClick={() => onChoose(row.path)} onKeyDown={(e) => onKeyDown(e, row)}>
          <span className="tree-chev" onClick={(e) => { e.stopPropagation(); toggle(row.path); }}
            style={{ visibility: row.expandable ? 'visible' : 'hidden', transform: row.open ? 'rotate(90deg)' : 'none' }}>
            <Chevron size={10} color="#5c616b" width={1.4} />
          </span>
          <span style={{ display: 'flex' }}><Icon name="folder" /></span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
          {row.failed && <span style={{ color: '#a4373a', fontSize: 11 }}>Can't be read</span>}
        </div>
      ))}
    </div>
  );
}

// Where to move the selection to: the folders under `scopeRoot` (a member's share, an administrator's top-level folder: items move no further). `onMove` makes the
// request with the folder chosen, and throws what the server said when it is refused (the folder holds an item of that name, the folder is the item itself...).
export function MoveDialog({ scopeRoot, onMove, onClose }: { scopeRoot: string; onMove(to: string): Promise<void>; onClose(): void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit(() => onMove(chosen!), onClose);
  return (
    <Dialog label="Move to" onClose={onClose}>
      <Frame title="Move to…" sub="Choose the folder to move the selection into." onSubmit={() => { if (chosen !== null) void submit(); }}
        footer={<Footer busy={busy} ready={chosen !== null} label="Move here" onClose={onClose} />}>
        <FolderPicker root={scopeRoot} chosen={chosen} onChoose={setChosen} frozen={busy} />
        <Alert message={error} />
      </Frame>
    </Dialog>
  );
}

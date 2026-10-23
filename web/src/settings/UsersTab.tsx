// Settings, Users & access (design lines 353-437, with the mockup's Shared folders table of screen 3 where the design has its folder-access tree, spec 5.2.6):
// the users at the left, the chosen one at the right, and under both the folders shared with them: that table needs more room than the panel has. Every edit is
// saved as it is made, and `onSaved` says so.

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AdminUser, Me, Role, ShareInfo } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Alert, ConfirmDialog, Footer, Frame, PromptDialog, useSubmit } from '../explorer/Dialogs.tsx';
import { cleanUsername, userCount, userSub } from '../lib/settings.ts';
import { Avatar, Button, Dialog, Field, Path, Seg } from '../ui/controls.tsx';
import { useLoad, useNarrow } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { AddFolderDialog } from './AddFolderDialog.tsx';

const ROLES: [Role, string][] = [['admin', 'Administrator'], ['member', 'Member']];
const card = { background: '#fff', border: '1px solid #e3e6eb', borderRadius: 8 } as const;
const label = { fontSize: 12, color: '#4a4e57' } as const;
const muted = { color: '#6b6f78' } as const;
const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
const sectionHead = { padding: '16px 16px 6px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } as const;
const retry = (message: string, onRetry: () => void) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><Alert message={message} /><Button onClick={onRetry}>Try again</Button></div>
);

// A text box that saves when it is left or Enter is pressed in it.
const enterLeaves = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };

// Display name, username, initial password and role of a new user. `onCreated` is told of the user the server made.
function AddUserDialog({ onCreated, onClose }: { onCreated(user: AdminUser): void; onClose(): void }) {
  const [form, setForm] = useState<{ displayName: string; username: string; password: string; role: Role }>({ displayName: '', username: '', password: '', role: 'member' });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const { busy, error, submit } = useSubmit(async () => { onCreated(await api<AdminUser>('POST', '/api/admin/users', form)); }, onClose);
  return (
    <Dialog label="Add user" onClose={onClose}>
      <Frame title="Add user" onSubmit={submit} footer={<Footer busy={busy} label="Add user" onClose={onClose} />}>
        <Field label="Display name" value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} disabled={busy} autoComplete="off" />
        <Field label="Username" value={form.username} onChange={(e) => set({ username: cleanUsername(e.target.value) })} disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false} />
        <Field label="Password" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} disabled={busy} autoComplete="new-password" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>Role</span>
          <Seg options={ROLES} value={form.role} onChange={(role) => set({ role })} style={{ alignSelf: 'flex-start' }} />
        </div>
        <Alert message={error} />
      </Frame>
    </Dialog>
  );
}

// A row of the Shared folders: its alias and rights save as they are changed. The folder itself can't be changed (remove the share, share the other folder).
type SharePatch = { alias?: string; create?: boolean; update?: boolean; delete?: boolean };

function ShareRow({ share, onPatch, onRemove }: { share: ShareInfo; onPatch(share: ShareInfo, patch: SharePatch): Promise<boolean>; onRemove(share: ShareInfo): void }) {
  const [alias, setAlias] = useState(share.alias);
  // A refusal puts the box back as it was.
  const commit = async () => { if (alias !== share.alias && !(await onPatch(share, { alias }))) setAlias(share.alias); };
  const box = (right: 'create' | 'update' | 'delete', name: string) => (
    <td className="c" data-label={name}>
      <input type="checkbox" checked={share[right]} aria-label={`${name} in ${share.alias}`} onChange={(e) => { void onPatch(share, { [right]: e.target.checked }); }} />
    </td>
  );
  return (
    <tr>
      <td>
        <input className="field" value={alias} aria-label={`Alias of ${share.diskPath}`} autoComplete="off" spellCheck={false} style={{ width: '100%', minWidth: 100 }}
          onChange={(e) => setAlias(e.target.value)} onBlur={() => void commit()} onKeyDown={enterLeaves} />
      </td>
      <td className="path">
        {!share.available && <span role="img" aria-label="Folder not found on disk" title="Folder not found on disk" style={{ color: '#8a5a00' }}>⚠ </span>}
        <Path text={share.diskPath} />
      </td>
      {box('create', 'Create')}
      <td className="c" data-label="Read"><input type="checkbox" checked disabled aria-label={`Read in ${share.alias}, always on`} title="Read is always on" /></td>
      {box('update', 'Update')}
      {box('delete', 'Delete')}
      <td><button type="button" className="bar-btn" onClick={() => onRemove(share)} style={{ height: 28, padding: '0 8px', color: '#a4373a' }}>Remove</button></td>
    </tr>
  );
}

// What is shared with a member (the mockup's screen 3), as a card of its own under the list and the panel. A share's answer is not read back into the table: only
// what was asked for is changed, so that two quick changes can't undo each other.
function SharesSection({ user, onSaved }: { user: AdminUser; onSaved(): void }) {
  const { data: shares, error: loadError, set, reload } = useLoad(() => api<ShareInfo[]>('GET', `/api/admin/users/${user.id}/shares`));
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const narrow = useNarrow();

  async function patch(share: ShareInfo, change: SharePatch): Promise<boolean> {
    setError('');
    try {
      await api('PATCH', `/api/admin/shares/${share.id}`, change);
      set((list) => list?.map((s) => (s.id === share.id ? { ...s, ...change } : s)));
      onSaved();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  async function remove(share: ShareInfo): Promise<void> {
    setError('');
    try {
      await api('DELETE', `/api/admin/shares/${share.id}`);
      set((list) => list?.filter((s) => s.id !== share.id));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ ...card, gridColumn: '1 / -1', minWidth: 0 }}>
      <div style={sectionHead}>
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>Shared folders</span>
          <span style={{ fontSize: 12, color: '#5c616b' }}>Appear in {user.displayName}'s root under alias. Rights cover all subfolders.</span>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)} style={{ height: narrow ? undefined : 28, padding: '0 10px' }}>+ Add folder</Button>
      </div>
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shares === undefined ? (loadError ? retry(loadError, reload) : <div style={muted}>Loading…</div>)
          : shares.length === 0 ? <div style={muted}>No folders are shared with {user.displayName} yet.</div>
            : (
              <div className="rtable-box">
                <table className="rtable">
                  <thead>
                    <tr>
                      <th>Alias (what {user.displayName} sees)</th><th>Folder on disk</th>
                      {['Create', 'Read', 'Update', 'Delete'].map((right) => <th key={right} className="c">{right}</th>)}
                      <th><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>{shares.map((s) => <ShareRow key={s.id} share={s} onPatch={patch} onRemove={(share) => void remove(share)} />)}</tbody>
                </table>
              </div>
            )}
        <Alert message={error} />
        <div style={{ fontSize: 12, color: '#5c616b' }}>Create = upload + new folder · Read = browse, view, slideshow, download (always on) · Update = rename, move · Delete = delete</div>
      </div>
      {adding && <AddFolderDialog user={user} onAdded={() => { reload(); onSaved(); }} onClose={() => setAdding(false)} />}
    </div>
  );
}

// The panel of one user. It is `key`ed by the user, so a field never keeps what was typed for the one before.
function UserPanel({ user, self, onChanged, onRemoved, onSaved }: {
  user: AdminUser; self: boolean; onChanged(id: number, patch: Partial<AdminUser>): void; onRemoved(id: number): void; onSaved(): void;
}) {
  const narrow = useNarrow();
  const [name, setName] = useState(user.displayName);
  const [login, setLogin] = useState(user.username);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'password' | 'remove' | null>(null);

  // A refusal puts the box back as it was and says why; what the server answers is what the box shows (it trims the names).
  async function saveName(): Promise<void> {
    if (name === user.displayName) return;
    setError('');
    try {
      const next = (await api<AdminUser>('PATCH', `/api/admin/users/${user.id}`, { displayName: name })).displayName;
      setName(next);
      onChanged(user.id, { displayName: next });
    } catch (err) {
      setName(user.displayName);
      setError((err as Error).message);
    }
  }
  async function saveLogin(): Promise<void> {
    if (login === user.username) return;
    setError('');
    try {
      const next = (await api<AdminUser>('PATCH', `/api/admin/users/${user.id}`, { username: login })).username;
      setLogin(next);
      onChanged(user.id, { username: next });
    } catch (err) {
      setLogin(user.username);
      setError((err as Error).message);
    }
  }
  async function saveRole(role: Role): Promise<void> {
    setError('');
    try {
      onChanged(user.id, { role: (await api<AdminUser>('PATCH', `/api/admin/users/${user.id}`, { role })).role });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderBottom: '1px solid #eceef2' }}>
        <Avatar id={user.id} name={user.displayName} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, ...ellipsis }}>{user.displayName}</div>
          <div style={{ fontSize: 12, color: '#5c616b', ...ellipsis }}>@{user.username}</div>
        </div>
        {!self && <Button variant="danger" onClick={() => setDialog('remove')} style={{ height: narrow ? undefined : 30, padding: '0 12px' }}>Remove user</Button>}
      </div>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Display name" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} onBlur={() => void saveName()} onKeyDown={enterLeaves} />
        <Field label="Username" value={login} autoComplete="off" autoCapitalize="none" spellCheck={false}
          onChange={(e) => setLogin(cleanUsername(e.target.value))} onBlur={() => void saveLogin()} onKeyDown={enterLeaves} />
        {!self && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>Password</span>
            <Button onClick={() => setDialog('password')}>Set new password</Button>
          </div>
        )}
      </div>
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={label}>Role</span>
        {self
          ? <div style={{ color: '#5c616b' }}>Administrator · you can't change your own role.</div>
          : <Seg options={ROLES} value={user.role} onChange={(role) => void saveRole(role)} style={{ alignSelf: 'flex-start' }} />}
        {error && <Alert message={error} />}
      </div>
      {user.role === 'admin' && (
        <>
          <div style={{ ...sectionHead, borderTop: '1px solid #eceef2' }}><span style={{ fontWeight: 600 }}>Folder access</span></div>
          <div style={{ margin: '6px 16px 16px', padding: '12px 14px', borderRadius: 6, background: '#eef4fb', color: '#1b3a5c', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ display: 'flex', color: '#005fb8' }}><Icon name="shield" /></span>
            Administrators have full access to every folder.
          </div>
        </>
      )}
      {dialog === 'password' && (
        <PromptDialog title="Set new password" label={`New password for ${user.displayName}`} initial="" secret={{ username: user.username }} submitLabel="Set password"
          onClose={() => setDialog(null)} onSubmit={async (password) => { await api('POST', `/api/admin/users/${user.id}/password`, { password }); onSaved(); }} />
      )}
      {dialog === 'remove' && (
        <ConfirmDialog title="Remove user" message={`Remove ${user.displayName}?`} confirmLabel="Remove user" onClose={() => setDialog(null)}
          detail={'They are signed out, and the folders shared with them are no longer shared.\nNothing on the disk is touched.'}
          onConfirm={async () => { await api('DELETE', `/api/admin/users/${user.id}`); onRemoved(user.id); }} />
      )}
    </div>
  );
}

export function UsersTab({ me, onMeChange, onSaved }: { me: Me; onMeChange(me: Me): void; onSaved(): void }) {
  const narrow = useNarrow();
  const { data: users, error, set, reload } = useLoad(() => api<AdminUser[]>('GET', '/api/admin/users'));
  const [chosen, setChosen] = useState<number | null>(null);   // until a user is picked: the first one who is not you (you come here for the others)
  const [adding, setAdding] = useState(false);

  if (users === undefined) return error ? retry(error, reload) : <div style={muted}>Loading…</div>;
  const user = users.find((u) => u.id === chosen) ?? users.find((u) => u.id !== me.id) ?? users[0];

  // The server has changed a user: the list shows them as they are now, and so does the rest of the app when it is oneself (the title bar).
  function changed(id: number, patch: Partial<AdminUser>): void {
    set((list) => list?.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    if (id === me.id) onMeChange({ ...me, ...patch });
    onSaved();
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '220px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: '#5c616b', fontSize: 12 }}>{userCount(users.length)}</span>
          <Button variant="primary" onClick={() => setAdding(true)} style={{ height: narrow ? undefined : 28, padding: '0 10px' }}>+ Add user</Button>
        </div>
        <div style={{ ...card, padding: 4, display: 'flex', flexDirection: narrow ? 'row' : 'column', gap: 2, overflowX: 'auto' }}>
          {users.map((u) => (
            <button key={u.id} type="button" className="pick-row" aria-current={u.id === user.id} onClick={() => setChosen(u.id)} style={narrow ? { width: 'auto', minWidth: 150 } : undefined}>
              <Avatar id={u.id} name={u.displayName} size={30} />
              <div style={{ minWidth: 0 }}>
                <div style={ellipsis}>{u.displayName}</div>
                <div style={{ fontSize: 12, color: '#5c616b', whiteSpace: 'nowrap' }}>{userSub(u.role, u.id === me.id)}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <UserPanel key={`user-${user.id}`} user={user} self={user.id === me.id} onChanged={changed} onSaved={onSaved}
        onRemoved={(id) => { set((list) => list?.filter((u) => u.id !== id)); onSaved(); }} />
      {user.role === 'member' && <SharesSection key={`shares-${user.id}`} user={user} onSaved={onSaved} />}
      {adding && <AddUserDialog onClose={() => setAdding(false)} onCreated={(created) => { set((list) => list && [...list, created]); setChosen(created.id); onSaved(); }} />}
    </div>
  );
}

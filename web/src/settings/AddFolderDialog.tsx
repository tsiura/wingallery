// "Share folder with <name>" (access-model mockup, screen 4): look through the media folder, name the folder as the user will see it, tick what they may do.
// Rendered by whoever wants it for as long as it is wanted: mounted means open (G12).

import { useEffect, useRef, useState } from 'react';
import type { AdminUser, ShareInfo } from '../../../shared/types.ts';
import { api, q } from '../api.ts';
import { Alert, Footer, Frame, useSubmit } from '../explorer/Dialogs.tsx';
import { crumbsOf, joinV, nameOf, parentOf } from '../lib/route.ts';
import { Dialog, Field } from '../ui/controls.tsx';
import { Chevron, Icon } from '../ui/Icon.tsx';

const ROOT_LABEL = 'Media folder';   // the API gives no absolute path (F11), so the top of the trail is named for what it is
const RIGHTS = [['create', 'Create'], ['read', 'Read'], ['update', 'Update'], ['delete', 'Delete']] as const;

// The folder that is open is the one to share, and it is highlighted: a click on a folder in the list opens it, `↑ ..` and the trail go back up. The media folder
// itself can't be shared (spec 4.2), so there is nothing to share until a folder is open. Paths are written as the Explorer writes them ('/' is the media folder), and
// the server's own are those without the first slash. `onAdded` is told of the share the server made.
export function AddFolderDialog({ user, onAdded, onClose }: { user: AdminUser; onAdded(share: ShareInfo): void; onClose(): void }) {
  const [at, setAt] = useState('/');
  const [folders, setFolders] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [typed, setTyped] = useState<string | null>(null);   // the alias as typed; until the first key it is the name of the open folder
  const [rights, setRights] = useState({ create: false, update: false, delete: false });
  const newest = useRef(0);   // the number of the latest request to the server: only its answer is used
  const chosen = at !== '/';
  const alias = typed ?? (chosen ? nameOf(at) : '');

  // The place on screen changes only when the server has answered, so the trail, the list and the highlight always agree; a refusal leaves them as they were.
  function open(path: string): void {
    const mine = ++newest.current;
    api<{ path: string; folders: string[] }>('GET', `/api/admin/browse?path=${q(path.slice(1))}`).then(
      (res) => { if (mine === newest.current) { setAt('/' + res.path); setFolders(res.folders); setLoadError(''); } },
      (err: Error) => { if (mine === newest.current) setLoadError(err.message); },
    );
  }
  useEffect(() => { open('/'); }, []);

  const { busy, error, submit } = useSubmit(async () => {
    onAdded(await api<ShareInfo>('POST', `/api/admin/users/${user.id}/shares`, { relPath: at.slice(1), alias, ...rights }));
  }, onClose);

  const crumbs = crumbsOf(at);
  const parent = parentOf(at);
  const indent = chosen ? 22 : 0;   // the folders in the list sit under the highlighted one
  return (
    <Dialog label="Share folder" width={560} onClose={onClose}>
      <Frame title={`Share folder with ${user.displayName}`} sub="Open the folder to share, name it and choose what they may do."
        onSubmit={() => { if (chosen) void submit(); }} footer={<Footer busy={busy} ready={chosen} label="Share" onClose={onClose} />}>
        <nav aria-label="Breadcrumb" className="crumbs" inert={busy} style={{
          height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px', overflowX: 'auto', background: '#fff', border: '1px solid #dcdfe5', borderRadius: 6,
        }}>
          <span style={{ display: 'flex', marginRight: 4 }}><Icon name="folderFlat" /></span>
          {crumbs.map((c, i) => (
            <div key={c.vpath} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <Chevron size={12} color="#8a8f99" width={1.2} />
              <button type="button" className="crumb" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onClick={() => open(c.vpath)}>{i === 0 ? ROOT_LABEL : c.name}</button>
            </div>
          ))}
        </nav>
        <div role="group" aria-label="Folders" inert={busy} style={{
          height: 200, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1, padding: 4, background: '#fff', border: '1px solid #dcdfe5', borderRadius: 6,
        }}>
          {parent !== null && (
            <button type="button" className="pick-row" aria-label="Up one folder" onClick={() => open(parent)} style={{ padding: '6px 8px' }}><span>↑ ..</span></button>
          )}
          {chosen && (
            <div className="pick-row" aria-current="true" style={{ padding: '6px 8px', cursor: 'default', fontWeight: 600, background: '#dde6f2', boxShadow: 'inset 3px 0 0 #005fb8' }}>
              <Icon name="folderItem" /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(at)}</span>
            </div>
          )}
          {folders === null ? (
            !loadError && <div style={{ padding: '6px 8px', color: '#6b6f78' }}>Loading…</div>
          ) : folders.length === 0 ? (
            <div style={{ padding: `6px 8px 6px ${8 + indent}px`, color: '#6b6f78' }}>No folders inside.</div>
          ) : folders.map((name) => (
            <button key={name} type="button" className="pick-row" onClick={() => open(joinV(at, name))} style={{ padding: `6px 8px 6px ${8 + indent}px` }}>
              <Icon name="folderItem" /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </button>
          ))}
        </div>
        <Alert message={loadError} />
        <Field label={`Alias shown to ${user.displayName}`} value={alias} onChange={(e) => setTyped(e.target.value)} disabled={busy || !chosen} autoComplete="off" spellCheck={false} />
        <div role="group" aria-label="Rights" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {RIGHTS.map(([right, label]) => (
            <label key={right} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {right === 'read'
                ? <input type="checkbox" checked disabled />
                : <input type="checkbox" checked={rights[right]} disabled={busy} onChange={(e) => setRights((r) => ({ ...r, [right]: e.target.checked }))} />}
              {label}
            </label>
          ))}
        </div>
        <Alert message={error} />
      </Frame>
    </Dialog>
  );
}

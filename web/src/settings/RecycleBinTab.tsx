// Settings, Recycle Bin (spec 4.4; the design has no such tab): what was deleted from the gallery, for the administrator to bring back or delete for good.
// The server keeps the list; a row that this page acts on is taken out of it only once the server has said yes.

import { useState } from 'react';
import type { TrashItem } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Alert, ConfirmDialog } from '../explorer/Dialogs.tsx';
import { fmtEpoch, fmtSize, plural } from '../lib/format.ts';
import { hiddenNote, locationOf, trashNote } from '../lib/settings.ts';
import { Button, Path } from '../ui/controls.tsx';
import { useLoad } from '../ui/hooks.ts';

type Bin = { items: TrashItem[]; trashDays: number };
type Open = { kind: 'purge'; item: TrashItem } | { kind: 'empty' };

const itemUrl = (item: TrashItem) => `/api/admin/trash/${encodeURIComponent(item.id)}`;

export function RecycleBinTab() {
  const { data: bin, error: loadError, set, reload } = useLoad(() => api<Bin>('GET', '/api/admin/trash'));
  const [dialog, setDialog] = useState<Open | null>(null);
  const [restoring, setRestoring] = useState(false);   // a restore is out: it takes its turn behind the other changes to the disk, so one at a time
  const [error, setError] = useState('');
  const [restored, setRestored] = useState('');
  const without = (id: string) => set((b) => b && { ...b, items: b.items.filter((i) => i.id !== id) });
  const forget = () => { setError(''); setRestored(''); };   // what the line above the table says is about the last thing done

  if (bin === undefined) {
    return loadError
      ? <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><Alert message={loadError} /><Button onClick={reload}>Try again</Button></div>
      : <div style={{ color: '#6b6f78' }}>Loading…</div>;
  }

  async function restore(item: TrashItem): Promise<void> {
    setRestoring(true);
    forget();
    try {
      const { restoredAs } = await api<{ restoredAs: string }>('POST', `${itemUrl(item)}/restore`);
      without(item.id);
      setRestored(`Restored to ${restoredAs}`);
    } catch (err) {
      setError((err as Error).message);
      reload();   // the item may be gone since the list was read
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ color: '#5c616b' }}>{trashNote(bin.trashDays)}</span>
        <Button variant="danger" onClick={() => setDialog({ kind: 'empty' })} disabled={bin.items.length === 0}>Empty Recycle Bin</Button>
      </div>
      <Alert message={error} />
      {restored && <div role="status" style={{ color: '#2f7d32', overflowWrap: 'anywhere' }}>{restored}</div>}
      {bin.items.length === 0 ? (
        <div style={{ padding: '48px 16px', textAlign: 'center', color: '#6b6f78', background: '#fff', border: '1px solid #e3e6eb', borderRadius: 8 }}>The Recycle Bin is empty.</div>
      ) : (
        <div className="rtable-box" style={{ background: '#fff', border: '1px solid #e3e6eb', borderRadius: 8, padding: '4px 8px' }}>
          <table className="rtable">
            <thead>
              <tr><th style={{ minWidth: 120 }}>Name</th><th>Original location</th><th>Deleted by</th><th style={{ minWidth: 92 }}>Deleted on</th><th>Size</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {bin.items.map((item) => (
                <tr key={item.id}>
                  <td style={{ overflowWrap: 'anywhere' }}>
                    <div>{item.name}</div>
                    {item.hiddenFiles > 0 && <div style={{ fontSize: 12, color: '#8a5a00' }}><span aria-hidden="true">⚠</span> {hiddenNote(item.hiddenFiles)}</div>}
                  </td>
                  <td data-label="Original location"><span className="path"><Path text={locationOf(item)} /></span></td>
                  <td data-label="Deleted by" style={{ overflowWrap: 'anywhere' }}>{item.deletedBy}</td>
                  <td data-label="Deleted on">{fmtEpoch(item.deletedAt)}</td>
                  <td data-label="Size" style={{ whiteSpace: 'nowrap' }}>{fmtSize(item.size)}</td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <Button onClick={() => void restore(item)} disabled={restoring} style={{ padding: '0 12px' }}>Restore</Button>
                      <Button variant="danger" onClick={() => setDialog({ kind: 'purge', item })} style={{ padding: '0 12px' }}>Delete permanently</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog?.kind === 'purge' && (
        <ConfirmDialog title="Delete permanently" message={`Delete “${dialog.item.name}” permanently?`} detail="It can't be restored." confirmLabel="Delete" onClose={() => setDialog(null)}
          onConfirm={async () => {
            const { id } = dialog.item;
            forget();
            try {
              await api('DELETE', itemUrl(dialog.item));
            } catch (err) {
              reload();
              throw err;
            }
            without(id);
          }} />
      )}
      {dialog?.kind === 'empty' && (
        <ConfirmDialog title="Empty Recycle Bin" message={`Delete ${plural(bin.items.length, 'item', 'items')} permanently?`} detail="They can't be restored." confirmLabel="Empty Recycle Bin"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            forget();
            try {
              await api('DELETE', '/api/admin/trash');
            } catch (err) {
              reload();   // the items before the one that failed are gone
              throw err;
            }
            set((b) => b && { ...b, items: [] });
          }} />
      )}
    </div>
  );
}

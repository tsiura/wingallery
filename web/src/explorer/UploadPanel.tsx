import type { CSSProperties } from 'react';
import { fmtSize } from '../lib/format.ts';
import { uploadSummary } from '../lib/upload.ts';
import type { UploadProgress } from '../lib/upload.ts';
import { useNarrow } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

export type { UploadProgress } from '../lib/upload.ts';

const muted: CSSProperties = { color: '#6b6f78', fontSize: 12 };
const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

// What the second line of an upload says. The server may have saved the file under another name (" (1)" when the name was taken): that is the name shown.
function Status({ upload: u }: { upload: UploadProgress }) {
  if (u.state === 'queued') return <div style={muted}>Waiting…</div>;
  if (u.state === 'cancelled') return <div style={muted}>Cancelled</div>;
  if (u.state === 'error') return <div role="alert" style={{ color: '#a4373a', fontSize: 12 }}>{u.error}</div>;
  if (u.state === 'done') return <div style={muted}>{u.finalName !== undefined && u.finalName !== u.name ? `Saved as ${u.finalName}` : 'Uploaded'}</div>;
  const percent = u.size > 0 ? Math.round((u.sent / u.size) * 100) : 0;
  return (
    <>
      <div style={muted}>Uploading… {percent > 0 ? `${percent}%` : ''}</div>
      <div role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        style={{ height: 4, marginTop: 4, borderRadius: 2, background: '#e1e4ea', overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', background: '#005fb8', transition: 'width .2s' }} />
      </div>
    </>
  );
}

// The uploads of this visit: each file with how far it is, and a Cancel for those that are waiting or running. It can be closed once none is. `items` is the
// queue's list (lib/upload.ts), whose index `onCancel` takes. Over the bottom right corner of the window; on a phone, at the bottom of it, in the flow of the page
// (Explorer renders it last), so that it pushes the items up and covers nothing: not the selection's "Done" bar, not the status bar.
export function UploadPanel({ items, onCancel, onClose }: { items: UploadProgress[]; onCancel(i: number): void; onClose(): void }) {
  const phone = useNarrow();
  const active = items.some((u) => u.state === 'queued' || u.state === 'uploading');
  return (
    <section aria-label="Uploads" style={{
      ...(phone
        ? { flexShrink: 0, margin: '8px 12px 12px', maxHeight: '40%' }
        : { position: 'fixed', right: 16, bottom: 16, zIndex: 30, width: 340, maxWidth: 'calc(100% - 32px)', maxHeight: 'min(60%, 420px)' }),
      display: 'flex', flexDirection: 'column', background: '#fbfbfc', borderRadius: 10, overflow: 'hidden', boxShadow: '0 12px 32px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06)',
    }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 8px 0 16px', borderBottom: '1px solid #eceef2' }}>
        <div role="status" style={{ flex: 1, fontWeight: 600 }}>{uploadSummary(items)}</div>
        {!active && <button type="button" className="bar-btn sq" title="Close" aria-label="Close uploads" onClick={onClose} style={{ width: 28, height: 28, padding: 0 }}><Icon name="close" size={12} /></button>}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: '4px 0', overflow: 'auto' }}>
        {items.map((u, i) => (
          <li key={i} style={{ padding: '6px 16px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
              <span title={u.name} style={{ flex: 1, minWidth: 0, ...ellipsis }}>{u.name}</span>
              <span style={{ ...muted, whiteSpace: 'nowrap' }}>{fmtSize(u.size)}</span>
              {(u.state === 'queued' || u.state === 'uploading') && (
                <button type="button" className="bar-btn" aria-label={`Cancel ${u.name}`} onClick={() => onCancel(i)} style={{ height: 24, padding: '0 8px', fontSize: 12 }}>Cancel</button>
              )}
            </div>
            <Status upload={u} />
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Me } from '../../../shared/types.ts';
import { Avatar } from '../ui/controls.tsx';
import { Logo } from '../ui/Icon.tsx';

export type SettingsTab = 'general' | 'users' | 'trash';

// The top strip (design lines 25-55): the app, the address it is served from, and the account menu.
export function TitleBar({ me, onOpenSettings, onSignOut }: { me: Me; onOpenSettings(tab: SettingsTab): void; onSignOut(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const admin = me.role === 'admin';

  const close = () => { setOpen(false); setError(''); };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); button.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // The window that opens next hands the focus back to whatever had it, and that must be the button, not a menu item that is about to go.
  const pick = (tab: SettingsTab) => { close(); button.current?.focus(); onOpenSettings(tab); };
  // When the server refuses, the menu stays and says why. When it agrees, the app swaps this page for the login.
  const signOut = () => { setError(''); onSignOut().catch((err: Error) => setError(err.message)); };

  const items: [label: string, run: () => void][] = [['Settings', () => pick('general')]];
  if (admin) items.push(['Users & access', () => pick('users')], ['Recycle Bin', () => pick('trash')]);
  items.push(['Sign out', signOut]);

  return (
    <header style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px 0 16px', flexShrink: 0, position: 'relative', zIndex: 15 }}>
      <Logo />
      <h1 style={{ margin: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>Home Gallery</h1>
      <div style={{ color: '#6b6f78', fontSize: 12, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{location.host}</div>
      <div style={{ flex: 1 }} />
      <div style={{ position: 'relative' }}>
        <button ref={button} type="button" className="bar-btn" title="Account" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}
          style={{ height: 32, gap: 8, padding: '0 6px 0 10px' }}>
          <span style={{ fontSize: 12, color: '#4a4e57', whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.displayName}</span>
          <Avatar id={me.id} name={me.displayName} />
        </button>
        {open && (
          <>
            <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 1 }} />
            <div style={{
              position: 'absolute', right: 0, top: 38, zIndex: 2, width: 240, background: '#fbfbfc', borderRadius: 8, padding: 4,
              boxShadow: '0 12px 32px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06)', animation: 'popIn .14s ease-out',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 12px', borderBottom: '1px solid #eceef2', marginBottom: 4 }}>
                <Avatar id={me.id} name={me.displayName} size={36} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{me.displayName}</div>
                  <div style={{ fontSize: 12, color: '#5c616b' }}>{admin ? 'Administrator' : 'Member'}</div>
                </div>
              </div>
              {items.map(([label, run]) => <button key={label} type="button" className="menu-item" onClick={run}>{label}</button>)}
              {error && <div role="alert" style={{ padding: '6px 10px 8px', color: '#a4373a' }}>{error}</div>}
            </div>
          </>
        )}
      </div>
    </header>
  );
}

// Settings, General (design lines 297-351, without its Library section: the media folder is the server's setting, spec 5.2.5): what the user's own browsing starts
// with, and the account: who is signed in, the password, sign out.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Me, Prefs, ViewMode } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Alert } from '../explorer/Dialogs.tsx';
import { roleName } from '../lib/settings.ts';
import { Button, Field, Seg } from '../ui/controls.tsx';

const VIEWS: [ViewMode, string][] = [['large', 'Large icons'], ['medium', 'Medium icons'], ['details', 'Details']];

// A titled card; its rows are `Row`s.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ background: '#fff', border: '1px solid #e3e6eb', borderRadius: 8 }}>{children}</div>
    </div>
  );
}

// One line of a card: what it is about at the left, its control at the right. On a narrow screen the control wraps under the text.
function Row({ label, first, children }: { label: string; first?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px', flexWrap: 'wrap', borderTop: first ? undefined : '1px solid #eceef2' }}>
      <div style={{ flex: 1, minWidth: 180 }}>{label}</div>
      {children}
    </div>
  );
}

// Current password and a new one. The server's answer is the message: what it refused with, or "Password changed" (this session stays, every other one ends).
// The username is in the form, out of sight, for the browser's password manager to know whose password this is.
function ChangePassword({ username }: { username: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      await api('POST', '/api/me/password', { current, next });
      setCurrent('');
      setNext('');
      setResult({ ok: true, text: 'Password changed' });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const typed = (set: (value: string) => void) => (e: { target: { value: string } }) => { set(e.target.value); setResult(null); };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', borderTop: '1px solid #eceef2' }}>
      <div>Change password</div>
      <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Field label="Current password" type="password" autoComplete="current-password" value={current} onChange={typed(setCurrent)} />
        <Field label="New password" type="password" autoComplete="new-password" value={next} onChange={typed(setNext)} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button type="submit" disabled={busy || current === '' || next === ''}>Change password</Button>
        {result && (result.ok
          ? <span role="status" style={{ color: '#2f7d32' }}>{result.text}</span>
          : <Alert message={result.text} />)}
      </div>
    </form>
  );
}

// The slider moves the number while it is dragged (React's onChange is the browser's `input`) and asks the server when the browser says `change`: it is let go of, keyed
// or set by assistive technology. (No pointer event is promised for the thumb of a slider on a phone.) If the server refuses, it goes back to what the server has.
function SlideTime({ seconds, save }: { seconds: number; save(patch: Partial<Prefs>): Promise<boolean> }) {
  const [shown, setShown] = useState(seconds);
  const range = useRef<HTMLInputElement>(null);
  const kept = useRef(seconds);                // what the server has
  const ask = useRef<() => void>(undefined);   // the newest closure, for the listener below, which is put on the slider once
  ask.current = () => {
    const next = Number(range.current!.value);
    if (next !== kept.current) void save({ slideSeconds: next }).then((ok) => { if (ok) kept.current = next; else setShown(kept.current); });
  };
  useEffect(() => {
    const slider = range.current!;
    const onChange = () => ask.current?.();
    slider.addEventListener('change', onChange);
    return () => slider.removeEventListener('change', onChange);
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input ref={range} type="range" min={2} max={20} step={1} value={shown} aria-label="Default slide time" style={{ width: 160 }} onChange={(e) => setShown(Number(e.target.value))} />
      <span style={{ width: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#005fb8', fontWeight: 600 }}>{shown} s</span>
    </div>
  );
}

// `onMeChange` takes the user with their new preferences, `onSaved` and `onFailed` are told when the server has kept a change and when it has refused one (the window shows
// both: the tab may have been left by the time the answer comes), `onSignOut` ends the session (and the app shows the login).
export function GeneralTab({ me, onMeChange, onSaved, onFailed, onSignOut }: {
  me: Me; onMeChange(me: Me): void; onSaved(): void; onFailed(message: string): void; onSignOut(): Promise<void>;
}) {
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');

  async function save(patch: Partial<Prefs>): Promise<boolean> {
    try {
      onMeChange({ ...me, prefs: await api<Prefs>('PUT', '/api/me/prefs', patch) });
      onSaved();
      return true;
    } catch (err) {
      onFailed((err as Error).message);
      return false;
    }
  }

  function signOut(): void {
    setLeaving(true);
    setLeaveError('');
    onSignOut().catch((err: Error) => { setLeaveError(err.message); setLeaving(false); });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section title="Browsing">
        <Row label="Default view" first>
          <Seg options={VIEWS} value={me.prefs.defaultView} onChange={(defaultView) => { void save({ defaultView }); }} />
        </Row>
        <Row label="Default slide time">
          <SlideTime seconds={me.prefs.slideSeconds} save={save} />
        </Row>
      </Section>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Section title="Account">
          <Row label={`Signed in as ${me.displayName} · ${roleName(me.role)}`} first>
            <Button onClick={signOut} disabled={leaving}>Sign out</Button>
          </Row>
          <ChangePassword username={me.username} />
        </Section>
        <Alert message={leaveError} />
      </div>
    </div>
  );
}

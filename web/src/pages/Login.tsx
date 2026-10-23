import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Me } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Button, Field, Toggle } from '../ui/controls.tsx';
import { Logo } from '../ui/Icon.tsx';

// The card the sign-in, the first-run setup and a failed start all sit in: the logo, the name, and a line under it.
export function AuthCard({ subtitle, children }: { subtitle?: string; children?: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 18, padding: '28px 28px 24px', background: '#fff', borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.06)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <Logo size={32} />
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Home Gallery</h1>
          {subtitle && <div style={{ color: '#5c616b' }}>{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

// What a form shows when the server refuses it: the server's own words, in red under the button.
export function FormError({ message }: { message: string }) {
  return message ? <div role="alert" style={{ color: '#a4373a' }}>{message}</div> : null;
}

export function Login({ onDone }: { onDone(user: Me): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: Me }>('POST', '/api/login', { username: username.trim(), password, remember });   // a phone keyboard likes to add a space
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required
          value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Toggle label="Remember me" checked={remember} onChange={setRemember} />
        <Button variant="primary" type="submit" disabled={busy}>Sign in</Button>
        <FormError message={error} />
      </form>
    </AuthCard>
  );
}

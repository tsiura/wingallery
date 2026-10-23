import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Me } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Button, Field } from '../ui/controls.tsx';
import { AuthCard, FormError } from './Login.tsx';

// The first run: the link in the container log carries the token, and the form makes the administrator.
export function Setup({ onDone }: { onDone(user: Me): void }) {
  const token = new URLSearchParams(location.search).get('token');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token) return <AuthCard subtitle="Open the setup link printed in the container log." />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: Me }>('POST', '/api/setup', { token, username, displayName, password });
      onDone(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard subtitle="Create the administrator account">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Display name" name="displayName" autoComplete="name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required
          value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button variant="primary" type="submit" disabled={busy}>Create admin account</Button>
        <FormError message={error} />
      </form>
    </AuthCard>
  );
}

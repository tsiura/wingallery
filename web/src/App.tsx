import { useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types.ts';
import { api } from './api.ts';
import { Explorer } from './explorer/Explorer.tsx';
import { isBrowsePath } from './lib/route.ts';
import { AuthCard, Login } from './pages/Login.tsx';
import { Setup } from './pages/Setup.tsx';
import { Button } from './ui/controls.tsx';

// Decides what the address shows: the first-run setup, the login, or the Explorer.
export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);

  // Whatever the address was (/setup?token=..., /), somebody who is in sees /browse/...; the address is put right before the Explorer reads it.
  const enter = (next: SessionInfo) => {
    if (next.user && !isBrowsePath(location.pathname)) history.replaceState(null, '', '/browse/');
    setSession(next);
  };

  useEffect(() => {
    api<SessionInfo>('GET', '/api/session').then(enter, (err: Error) => setFailure(err.message));
  }, [attempt]);

  // The server says the session has ended (any 401 but the login's own): back to the login, at the same address.
  useEffect(() => {
    const ended = () => setSession((s) => s && { ...s, user: null });
    window.addEventListener('gallery:unauthorized', ended);
    return () => window.removeEventListener('gallery:unauthorized', ended);
  }, []);

  async function signOut() {
    await api('POST', '/api/logout');
    setSession((s) => s && { ...s, user: null });
  }

  if (failure) return <AuthCard subtitle={failure}><Button variant="primary" onClick={() => { setFailure(''); setAttempt(attempt + 1); }}>Try again</Button></AuthCard>;
  if (!session) return null;
  if (session.setupRequired) return <Setup onDone={(user) => enter({ user, setupRequired: false })} />;
  if (!session.user) return <Login onDone={(user) => enter({ user, setupRequired: false })} />;
  return <Explorer me={session.user} onMeChange={(user) => setSession((s) => s && { ...s, user })} onSignOut={signOut} />;
}

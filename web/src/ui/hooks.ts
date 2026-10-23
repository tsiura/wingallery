import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// Follows a CSS media query, e.g. '(max-width: 699px)'.
export function useMediaQuery(q: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(q);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [q]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(q).matches);
}

export const useNarrow = (): boolean => useMediaQuery('(max-width: 699px)');   // phones: the tree is a drawer, search is an icon
export const useWide = (): boolean => useMediaQuery('(min-width: 1100px)');    // the view switch shows its labels

// Reads something from the server when the component appears, and again on `reload`. `data` stays what it was while a new answer is on its way; `set` is for what the
// caller changes itself (a row it removed). An answer that comes after the component has gone is dropped.
export function useLoad<T>(load: () => Promise<T>): { data: T | undefined; error: string; set: Dispatch<SetStateAction<T | undefined>>; reload(): void } {
  const [data, set] = useState<T>();
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    let wanted = true;
    load().then((next) => { if (wanted) { set(next); setError(''); } }, (err: Error) => { if (wanted) setError(err.message); });
    return () => { wanted = false; };
  }, [round]);
  return { data, error, set, reload: () => setRound((n) => n + 1) };
}

// A flag that is on for `ms` after the latest `flash`: the "Saved" that shows next to a title and goes by itself.
export function useFlash(ms: number): [on: boolean, flash: () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

// Calls `then` each time `open` goes from true to false, once the effects of whatever closed have run (a dialog's own cleanup gives the focus back to what opened it).
export function useAfterClose(open: boolean, then: () => void): void {
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !open) then();
    was.current = open;
  }, [open]);
}

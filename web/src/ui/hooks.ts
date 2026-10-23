import { useCallback, useSyncExternalStore } from 'react';

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

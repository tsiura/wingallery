// Where the Explorer is in the browser's history. Each folder the app opens is a pushed entry that carries its own number, { idx }, in history.state;
// the entry the app began on carries nothing and counts as 0. The toolbar's Back and Forward are enabled by these numbers alone, so they never leave the app.

export interface Place {
  idx: number;   // the entry the page is on
  max: number;   // the furthest entry this page has seen: Forward goes there
}

// A whole number from zero up, or 0 for whatever else is in the state (nothing, or something another script wrote).
const idxOf = (state: unknown): number => {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : 0;
};

// At load. A reload keeps the entry's state, so the number survives it; the entries ahead of it are not known until they are visited.
export const placeAt = (state: unknown): Place => ({ idx: idxOf(state), max: idxOf(state) });

// After history.pushState({ idx: p.idx + 1 }): a push throws away every entry that was ahead.
export const pushed = (p: Place): Place => ({ idx: p.idx + 1, max: p.idx + 1 });

// After a popstate (Back, Forward, a jump through the history list): `state` is the state of the entry arrived at.
export const popped = (p: Place, state: unknown): Place => ({ idx: idxOf(state), max: Math.max(p.max, idxOf(state)) });

export const canBack = (p: Place): boolean => p.idx > 0;
export const canForward = (p: Place): boolean => p.idx < p.max;

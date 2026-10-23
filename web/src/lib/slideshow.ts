// What the viewer and the slideshow decide without a browser: the options, which files a show plays and in what order, where a step goes, and what a swipe is.

import type { Entry, FileEntry, Meta, SlideItem } from '../../../shared/types.ts';
import { fmtDate } from './format.ts';
import { joinV } from './route.ts';

export interface ShowConfig {
  seconds: number;                                   // how long a photo stays (the slider allows 2 to 20)
  transition: 'fade' | 'slide' | 'none';
  shuffle: boolean;
  loop: boolean;                                     // from the last one back to the first, instead of stopping
  videos: boolean;
  subfolders: boolean;                               // the whole folder takes in what is below it
  scope: 'folder' | 'selected';
}

// A recursive list holds at most this many items (the server stops at it too), and says so (F16).
export const SLIDE_CAP = 5000;
export const CAPPED_NOTE = `Showing the first ${SLIDE_CAP} items.`;

// More than one selected item is a choice to play just those; one is only where the cursor is (design `openModal`).
export const defaultScope = (selectedCount: number): ShowConfig['scope'] => (selectedCount > 1 ? 'selected' : 'folder');

// A slide with what is known about it already. A folder's listing says when its files were taken and how big they are, so a slide made from it carries that as
// `meta` and the viewer does not ask the server again; the files of /api/files (a recursive list) come without, and are asked for (GET /api/meta) when shown.
export interface PlayItem extends SlideItem { meta?: Meta }

export const filterPool = <T extends SlideItem>(items: T[], videos: boolean): T[] => (videos ? items : items.filter((i) => i.kind !== 'video'));

// Fisher-Yates, on a copy.
export function shuffled<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The place after a step of `delta` from `idx` in a show of `len` (design `step`). A hand on Prev or Next wraps round; the timer, or a video that ended
// (`auto`), does not go past the end of a show that does not loop: null, the show stops where it is.
export function step(idx: number, len: number, delta: 1 | -1, loop: boolean, auto: boolean): number | null {
  let i = idx + delta;
  if (i >= len) {
    if (!loop && auto) return null;
    i = 0;
  }
  if (i < 0) i = len - 1;
  return i;
}

// Where a show is: the item it shows (`idx`), whether it goes on by itself, and two counters that say when to start something over. `run` restarts the slide's
// progress bar (every step and every Play or Pause), `lap` the stage and its transition (every step, and not a Pause).
export interface Run { idx: number; playing: boolean; run: number; lap: number }

export function advance(s: Run, delta: 1 | -1, auto: boolean, len: number, loop: boolean): Run {
  const idx = step(s.idx, len, delta, loop, auto);
  return idx === null ? { ...s, playing: false } : { ...s, idx, run: s.run + 1, lap: s.lap + 1 };
}

export const toggled = (s: Run): Run => ({ ...s, playing: !s.playing, run: s.run + 1 });

// What Play and Pause (the button, Space) act on. `viewer`: a file was opened, and nothing goes on by itself until Play is pressed on a photo; `film`: a film is on stage with
// controls of its own; `showPlaying`: the show (the advance to the next item) is playing; `filmPlaying`: the film is. In the viewer a film's controls are its own: Space and the
// button pause and resume the film and leave the advance alone. A photo has no controls, so there they arm and disarm the advance. In a slideshow they pause and resume the
// show and the film with it: the film follows what the show becomes.
export function playAction(viewer: boolean, film: boolean, showPlaying: boolean, filmPlaying: boolean): { show: boolean; clip: 'play' | 'pause' | null } {
  if (!film) return { show: true, clip: null };
  if (viewer) return { show: false, clip: filmPlaying ? 'pause' : 'play' };
  return { show: true, clip: showPlaying ? 'pause' : 'play' };
}

// Whether the button shows "playing" (is a Pause button): in the viewer a film's own state, since the film is what the button is for there; otherwise the show's.
export const isPlaying = (viewer: boolean, film: boolean, showPlaying: boolean, filmPlaying: boolean): boolean => (viewer && film ? filmPlaying : showPlaying);

// Whether a film that has ended goes on to the next item: a slideshow that is playing does, a viewer never moves by itself.
export const advancesAfterFilm = (viewer: boolean, showPlaying: boolean): boolean => !viewer && showPlaying;

// Whether a play() that was rejected was refused by the browser's autoplay policy (a film with sound that no finger started): only then is it played again without sound.
// Any other rejection is something else: a pause() between loadedmetadata and canplay rejects the pending play() with AbortError, and a film that was paused is to stay
// paused, with its sound.
export const refusedAutoplay = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'NotAllowedError';

// A finger that moved further than this sideways has swiped.
const SWIPE_PX = 50;

// Which way a swipe of `dx` pixels (to the right is positive) steps: to the left shows the next one, to the right the previous one.
export const swipeDelta = (dx: number): 1 | -1 | null => (Math.abs(dx) > SWIPE_PX ? (dx < 0 ? 1 : -1) : null);

// "Mar 14, 2026  09:05 · 4032 × 3024"; a photo that could not be measured has the date only.
export function metaLine(meta: Meta): string {
  const date = fmtDate(meta.takenAt);
  return meta.width !== null && meta.height !== null ? `${date} · ${meta.width} × ${meta.height}` : date;
}

const isFile = (e: Entry): e is FileEntry => e.kind !== 'folder';

// The files among `entries`, which are the items of the folder `vpath`, as the show plays them, each with what the listing knows about it.
export const slidesOf = (vpath: string, entries: readonly Entry[]): PlayItem[] =>
  entries.filter(isFile).map((e) => ({
    path: joinV(vpath, e.name), kind: e.kind, name: e.name, mtime: e.mtime,
    meta: { takenAt: e.takenAt, width: e.width, height: e.height, duration: e.duration },
  }));

// What /api/files answered for a folder (slides without `meta`), or what was put together from that and the listing.
export interface Pool { items: PlayItem[]; capped: boolean }

// What a show is made of before "Include videos" and "Shuffle": the files that the folder's listing gives already (`own`), then the folders that /api/files has to
// walk (`walk`), and whether the whole is held to SLIDE_CAP (`cap`: every list that is recursive, or put together; not the plain files of one folder).
// The whole folder is its files, or with subfolders the folder walked (a member's root, `/`, is walked too: it walks every share). Selected is the selected files,
// then the selected folders, always walked; with nothing selected it is the folder, as in the design. A share whose folder is gone has nothing to walk.
export interface PoolSources { own: PlayItem[]; walk: string[]; cap: boolean }

export function poolSources(cfg: Pick<ShowConfig, 'scope' | 'subfolders'>, vpath: string, entries: readonly Entry[], picked: readonly Entry[]): PoolSources {
  if (cfg.scope === 'selected' && picked.length > 0) {
    return { own: slidesOf(vpath, picked), walk: picked.flatMap((e) => (e.kind === 'folder' && !e.unavailable ? [joinV(vpath, e.name)] : [])), cap: true };
  }
  if (cfg.subfolders) return { own: [], walk: [vpath], cap: true };
  return { own: slidesOf(vpath, entries), walk: [], cap: false };
}

// The sources put together, in order, under the cap (F16). `walked` is what /api/files has answered so far, by folder; null while a folder to walk has not.
export function joinPool({ own, walk, cap }: PoolSources, walked: Readonly<Record<string, Pool>>): Pool | null {
  const answers: Pool[] = [];
  for (const path of walk) {
    if (!walked[path]) return null;
    answers.push(walked[path]);
  }
  const items = [...own, ...answers.flatMap((a) => a.items)];
  return cap ? { items: items.slice(0, SLIDE_CAP), capped: items.length > SLIDE_CAP || answers.some((a) => a.capped) } : { items, capped: false };
}

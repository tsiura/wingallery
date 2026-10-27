import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Entry, FileEntry, Listing, Me } from '../../../shared/types.ts';
import { api, q } from '../api.ts';
import { CAPPED_NOTE, defaultScope, filterPool, joinPool, poolSources, shuffled, slidesOf } from '../lib/slideshow.ts';
import type { PlayItem, Pool, ShowConfig } from '../lib/slideshow.ts';
import { Player } from './Player.tsx';
import { SlideshowModal } from './SlideshowModal.tsx';

const DEFAULTS = { transition: 'fade', shuffle: false, loop: true, videos: true, subfolders: false, scope: 'folder' } as const;   // design line 530; the slide time is the user's preference

// The window that asks how to play, or the stage with what it plays.
type Phase = { kind: 'ask' } | { kind: 'play'; items: PlayItem[]; start: number; autoplay: boolean };

// The viewer and the slideshow as the Explorer has them: the options window (Slideshow in the bar), the stage over the files of the folder (a file opened), and the
// files in between. `sorted` are the folder's items in the order the pane shows them, whatever the search, `shown` the ones the search lets through, `picked` the
// selection that is in sight. Returns what to render (`ui`), whether any of it is open (`active`), and `configure` (the bar's button), `view` (a file was opened) and
// `close` (the Explorer moved to another folder) to call. The options are kept for as long as the Explorer lives; the slide time follows the preference until the slider is moved.
export function useSlideshow({ me, vpath, listing, sorted, shown, picked }: {
  me: Me; vpath: string; listing: Listing | null; sorted: Entry[]; shown: Entry[]; picked: Entry[];
}) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [patch, setPatch] = useState<Partial<ShowConfig>>({});               // what the user has changed
  const [walked, setWalked] = useState<Record<string, Pool>>({});            // what /api/files said, by folder, since the options window was opened
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const opening = useRef(0);                                               // which opening of the options window we are in: an answer for an earlier one is not wanted
  const asked = useRef(new Set<string>());
  const cfg: ShowConfig = { ...DEFAULTS, seconds: me.prefs.slideSeconds, ...patch };

  // What the options as they are would play: the files the listing gives and the folders still to be read from the server (a recursive list, a member's root: R3).
  const sources = phase?.kind === 'ask' ? poolSources(cfg, vpath, sorted, picked) : null;
  useEffect(() => {
    if (!sources) return;
    const mine = opening.current;
    for (const path of sources.walk) {
      if (asked.current.has(path)) continue;
      asked.current.add(path);
      api<Pool>('GET', `/api/files?path=${q(path)}`).then(
        (pool) => { if (mine === opening.current) setWalked((w) => ({ ...w, [path]: pool })); },
        (err: Error) => { if (mine === opening.current) setFailure({ path, message: err.message }); },
      );
    }
  });
  const pool = sources ? joinPool(sources, walked) : null;                    // null while a folder has not answered
  const failed = failure !== null && sources?.walk.includes(failure.path) ? failure.message : undefined;

  const close = () => { opening.current++; setPhase(null); };

  // Each time the window is opened its answers start over (the folder may have changed), the options for what is selected and where the files are are worked out again, and
  // the rest stay as they were left. Subfolders go on by themselves in a folder with no files of its own (design `openModal`).
  function configure(): void {
    if (!listing) return;
    opening.current++;
    asked.current.clear();
    setWalked({});
    setFailure(null);
    setPatch((p) => ({ ...p, scope: defaultScope(picked.length), subfolders: (p.subfolders ?? DEFAULTS.subfolders) || !sorted.some((e) => e.kind !== 'folder') }));
    setPhase({ kind: 'ask' });
  }

  function start(): void {
    if (!pool) return;
    const items = filterPool(pool.items, cfg.videos);
    if (items.length > 0) setPhase({ kind: 'play', items: cfg.shuffle ? shuffled(items) : items, start: 0, autoplay: true });
  }

  // R2: a file opened plays the folder's files as the pane shows them, from that file, and waits for Play.
  function view(entry: FileEntry): void {
    const items = slidesOf(vpath, shown);
    const at = items.findIndex((i) => i.name === entry.name);
    if (at >= 0) setPhase({ kind: 'play', items, start: at, autoplay: false });
  }

  const onCfg = (p: Partial<ShowConfig>) => setPatch((prev) => ({ ...prev, ...p }));
  let ui: ReactNode = null;
  if (phase?.kind === 'ask') {
    ui = (
      <SlideshowModal folderName={listing?.name ?? ''} selectedCount={picked.length} cfg={cfg} onCfg={onCfg} onStart={start} onClose={close}
        poolCount={failed !== undefined ? 0 : pool ? filterPool(pool.items, cfg.videos).length : null} note={pool?.capped ? CAPPED_NOTE : undefined} error={failed} />
    );
  } else if (phase?.kind === 'play') {
    ui = <Player items={phase.items} start={phase.start} autoplay={phase.autoplay} cfg={cfg} onCfg={onCfg} onClose={close} />;
  }
  return { ui, active: phase !== null, configure, view, close };
}

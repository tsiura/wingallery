// The viewer and the slideshow's stage (design lines 445-473): a dark window over the page with the picture or the film, its name, when it was taken and how big, the counter,
// the buttons and the progress bar. A modal <dialog> like the others (G12), so the page behind is inert, the focus stays inside and Esc closes it.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, SyntheticEvent, TouchEvent } from 'react';
import type { Meta } from '../../../shared/types.ts';
import { api, q, saveFile, viewUrl } from '../api.ts';
import { advance, advancesAfterFilm, asksFirst, isPlaying, metaLine, playAction, refusedAutoplay, swipeDelta, toggled } from '../lib/slideshow.ts';
import type { PlayItem, Run, ShowConfig } from '../lib/slideshow.ts';
import { Button, Dialog } from '../ui/controls.tsx';
import { useNarrow } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import type { IconName } from '../ui/Icon.tsx';
import { PlayModal } from './SlideshowModal.tsx';

const ANIMATIONS = { fade: 'ssFade .6s ease', slide: 'ssSlide .45s cubic-bezier(.2,.7,.2,1)', none: 'none' } as const;   // design line 711
const FULL: CSSProperties = { width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', margin: 0, borderRadius: 0, background: '#0b0c0e', color: '#fff', boxShadow: 'none', animation: 'none' };
const CONTROLS_PX = 64;   // the strip along the bottom of a film that its own controls take (the seek bar, the volume): a finger there is not swiping

type Action = { kind: 'step'; delta: 1 | -1; auto: boolean } | { kind: 'toggle' };

// A button of the top bar (the design's close button, line 453).
function BarButton({ icon, label, title, onClick }: { icon: IconName; label: string; title: string; onClick(): void }) {
  return <button type="button" className="pl-btn" title={title} aria-label={label} onClick={onClick}><Icon name={icon} size={icon === 'close' ? 14 : 16} /></button>;
}

// What the stage says when the browser cannot show the item: in words and with a way to get the file anyway.
function Unshowable({ message, onDownload }: { message: string; onDownload(): void }) {
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 24, textAlign: 'center', color: '#c9ccd2' }}>
      <div>{message}</div>
      <Button onClick={onDownload}>Download</Button>
    </div>
  );
}

// `items` are shown from `items[start]`. With `autoplay` it is a slideshow: it goes on by itself (a photo after `cfg.seconds`, a film when it ends) and Play and Pause (the
// button, Space) act on the show and on the film with it. Without, it is the viewer, for a file that was opened: nothing goes on by itself, but a film does play by itself
// when it is shown, and has the button and Space to itself (the button shows whether it plays, and when it ends the viewer stays on it); on a photo Play arms the advance to
// the next one and Pause disarms it, and the first Play asks for the slide time and the effect (`onCfg` keeps them). The keys are ← → (step), Space (play or pause) and Esc (close); on a touch screen a swipe steps. A photo is a plain <img> from /media/view
// (a HEIC is served as a JPEG there) and a film a <video controls>; the browser that cannot show one says so, and the Download button is in the bar always (F14.2).
// A slide that comes with its `meta` (when it was taken, how big) has no need to ask the server for it.
export function Player({ items, start, autoplay, cfg, onCfg, onClose }: {
  items: PlayItem[]; start: number; autoplay: boolean; cfg: ShowConfig; onCfg(patch: Partial<ShowConfig>): void; onClose(): void;
}) {
  const phone = useNarrow();
  const viewer = !autoplay;
  const len = items.length;
  const [s, dispatch] = useReducer(
    (state: Run, a: Action) => (a.kind === 'toggle' ? toggled(state) : advance(state, a.delta, a.auto, len, cfg.loop)),
    { idx: Math.max(0, Math.min(start, len - 1)), playing: autoplay, run: 0, lap: 0 },
  );
  const cur = items[s.idx];
  const film = cur.kind === 'video';
  const [failed, setFailed] = useState<string | null>(null);        // the path of the item that the browser could not show
  const [fetched, setFetched] = useState<Readonly<Record<string, Meta>>>({});   // what /api/meta said about the items that had no meta of their own, kept for a show that comes round again
  const [played, setPlayed] = useState({ lap: 0, fraction: 0 });     // how far the film of this lap has played
  const [clipState, setClipState] = useState({ lap: 0, playing: false });   // whether the film of this lap plays, as its own events said last
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  const [asking, setAsking] = useState(false);                       // the Play window is open
  const [chosen, setChosen] = useState(false);                       // it was answered in this viewer: Play just plays
  const asked = useRef(new Set<string>());                            // the paths that /api/meta has been asked about
  const clip = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);                          // where the finger that may be swiping went down
  const broken = failed === cur.path;
  const live = film && !broken;                                       // a film is on stage, with controls of its own
  const timed = !live;                                                // a film runs until it ends; a photo, or what could not be shown, for `cfg.seconds`
  const playing = isPlaying(viewer, live, s.playing, clipState.lap === s.lap && clipState.playing);   // what the button shows
  const filmBar = live && playing;
  const known = cur.meta ?? fetched[cur.path];

  // A film that is taken out of the page goes on loading until the browser gets round to throwing it away, which for a long film is a good part of a phone's video
  // fetched for nothing. Taking its source away and loading again is what stops it, so the source is given and taken away here, as a pair (and not as a prop that
  // nothing would give back after a development build's trial unmount). A ref that returns a function is not called with null when the film goes.
  const path = cur.path;
  const holdClip = useCallback((video: HTMLVideoElement | null) => {
    clip.current = video;
    if (!video) return;
    video.src = viewUrl(path);
    return () => {
      clip.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [path]);

  // The dialog is open once its own effect has run, and this one runs after it (it belongs to a component above it). The focus goes to the stage and not to the first
  // button, so that Space and Enter are not pressed on Download.
  useEffect(() => { root.current?.focus(); }, []);

  // The timer: a photo stays for `seconds` while the show plays. Every step and every Play or Pause (`run`) starts it again.
  useEffect(() => {
    if (!s.playing || !timed) return;
    const timer = setTimeout(() => dispatch({ kind: 'step', delta: 1, auto: true }), cfg.seconds * 1000);
    return () => clearTimeout(timer);
  }, [s.idx, s.playing, s.run, timed, cfg.seconds]);

  // The next photo is fetched while this one is on show, so that it is there when it is wanted.
  useEffect(() => {
    const next = items[(s.idx + 1) % len];
    if (next.kind === 'photo') new Image().src = viewUrl(next.path);
  }, [s.idx]);

  // The line under the name: when it was taken and how big. A slide from the listing has it already; the others are asked for, once (also when the user steps back and
  // forth before the answer is in, or a development build runs this effect twice), and the answer is kept by path. A request that failed may be made again.
  useEffect(() => {
    if (known || asked.current.has(path)) return;
    asked.current.add(path);
    api<Meta>('GET', `/api/meta?path=${q(path)}`).then(
      (value) => setFetched((f) => ({ ...f, [path]: value })),
      () => { asked.current.delete(path); },   // no line is better than a wrong one
    );
  }, [path]);

  // Play or Pause, from the button and from the key: on the show, on the film, or on both (`playAction` says which, in the viewer and in a slideshow).
  function togglePlay(): void {
    const video = clip.current;
    const act = playAction(viewer, live, s.playing, video !== null && !video.paused);
    if (asksFirst(viewer, act.show, s.playing, chosen)) return setAsking(true);
    if (act.show) dispatch({ kind: 'toggle' });
    if (video && act.clip === 'play') video.play().catch(() => {});
    else if (video && act.clip === 'pause') video.pause();
  }

  // Window level, because the focus can be anywhere in the window: on the stage, on a button, on the film. A film that has the focus keeps Space for itself.
  // Firefox presses a focused button when the key comes up, which a prevented key down does not stop. While the Play window is open the keys are its own.
  useEffect(() => {
    if (asking) return;
    const space = (e: KeyboardEvent) => e.key === ' ' && !(e.target instanceof HTMLVideoElement);
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // Alt+Left is the browser's Back
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); dispatch({ kind: 'step', delta: e.key === 'ArrowRight' ? 1 : -1, auto: false }); }
      else if (space(e)) { e.preventDefault(); if (!e.repeat) togglePlay(); }
    };
    const up = (e: KeyboardEvent) => { if (space(e)) e.preventDefault(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [s.playing, live, asking, chosen]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});   // closing the viewer leaves the window as it was found
    };
  }, []);

  // The stage goes full screen, not the page: a modal <dialog> is in the top layer, and the page (document.documentElement) put there after it would cover it.
  const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : root.current!.requestFullscreen()).catch(() => {});

  function onTouchStart(e: TouchEvent<HTMLElement>): void {
    const t = e.touches[0];
    const onControls = e.target instanceof HTMLVideoElement && t.clientY > e.target.getBoundingClientRect().bottom - CONTROLS_PX;
    touch.current = e.touches.length === 1 && !onControls ? t.clientX : null;   // two fingers are a pinch
  }
  function onTouchEnd(e: TouchEvent<HTMLElement>): void {
    const from = touch.current;
    touch.current = null;
    const delta = from === null || e.touches.length > 0 ? null : swipeDelta(e.changedTouches[0].clientX - from);
    if (delta) dispatch({ kind: 'step', delta, auto: false });
  }

  let stage: ReactNode;
  if (cur.kind === 'photo') {
    stage = broken
      ? <Unshowable message="This photo can't be shown" onDownload={() => saveFile(cur.path)} />
      : <img src={viewUrl(cur.path)} alt={cur.name} draggable={false} onError={() => setFailed(cur.path)}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', borderRadius: 2 }} />;
  } else {
    // A phone's HEVC film in a browser that has no decoder for it can play its sound and show no picture, and then there is no error, only a picture of size 0.
    // A film that autoplay does not start (iOS, where a film that no finger started may not play with its sound) would hold a show up for good: it is asked to play,
    // and if the browser refuses that it plays without sound, which the controls can turn on. Only that refusal: a film that was paused while it was loading has its
    // play() rejected too (AbortError), and is to stay paused, with its sound.
    const sync = (e: SyntheticEvent<HTMLVideoElement>) => setClipState({ lap: s.lap, playing: !e.currentTarget.paused });
    stage = broken
      ? <Unshowable message="This browser can't play this video" onDownload={() => saveFile(cur.path)} />
      : <video ref={holdClip} controls autoPlay playsInline onPlay={sync} onPause={sync}
          onEnded={(e) => { sync(e); if (advancesAfterFilm(viewer, s.playing)) dispatch({ kind: 'step', delta: 1, auto: true }); }}
          onError={() => setFailed(cur.path)}
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            if (video.videoWidth === 0) setFailed(cur.path);
            else video.play().catch((err) => { if (refusedAutoplay(err)) { video.muted = true; video.play().catch(() => {}); } });
          }}
          onTimeUpdate={(e) => setPlayed({ lap: s.lap, fraction: e.currentTarget.duration > 0 ? e.currentTarget.currentTime / e.currentTarget.duration : 0 })}
          style={{ maxWidth: '100%', maxHeight: '100%', background: '#000' }} />;
  }

  // The bar: the film's progress while a film plays, the slide's time while a photo does, and where the item is among the others when nothing plays.
  const width = filmBar ? `${(played.lap === s.lap ? played.fraction : 0) * 100}%` : playing ? undefined : `${((s.idx + 1) / len) * 100}%`;
  const when = known ? metaLine(known).replace(' · ', '\u00a0· ') : '';   // a line that wraps on a phone breaks after the dot, not before it

  return (
    <Dialog label="Viewer" onClose={onClose} style={FULL}>
      <div ref={root} tabIndex={-1} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0b0c0e', outline: 'none' }}>
        <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: phone ? '0 8px 0 16px' : '0 16px' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: phone ? 'column' : 'row', alignItems: phone ? 'flex-start' : 'center', gap: phone ? 0 : 12 }}>
            <div title={cur.name} style={{ fontWeight: 600, minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur.name}</div>
            <div style={{ color: '#9a9fa8', fontSize: 12, minWidth: 0, maxWidth: '100%', ...(phone ? { lineHeight: '15px', maxHeight: 30, overflow: 'hidden', textWrap: 'balance' } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}>{when}</div>
          </div>
          <div style={{ color: '#9a9fa8', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{s.idx + 1} / {len}</div>
          <BarButton icon="download" label="Download" title="Download" onClick={() => saveFile(cur.path)} />
          {document.fullscreenEnabled && (
            <BarButton icon="fullscreen" label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen} />
          )}
          <BarButton icon="close" label="Close" title="Close (Esc)" onClick={onClose} />
        </div>
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; }}
          style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', touchAction: 'pan-y pinch-zoom', userSelect: 'none', WebkitUserSelect: 'none' }}>
          <div key={s.lap} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: phone ? 0 : '0 72px', animation: ANIMATIONS[cfg.transition] }}>
            {stage}
          </div>
        </div>
        <div style={{ height: 72, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <button type="button" className="pl-round" title="Previous (←)" aria-label="Previous" onClick={() => dispatch({ kind: 'step', delta: -1, auto: false })}><Icon name="prev" /></button>
          <button type="button" className="pl-round main" title="Play / Pause (Space)" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}><Icon name={playing ? 'pause' : 'play'} /></button>
          <button type="button" className="pl-round" title="Next (→)" aria-label="Next" onClick={() => dispatch({ kind: 'step', delta: 1, auto: false })}><Icon name="next" /></button>
        </div>
        <div style={{ height: 3, flexShrink: 0, background: 'rgba(255,255,255,.1)' }}>
          <div key={s.run} aria-hidden="true"
            style={{
              height: '100%', background: '#4ca0ff', width, transition: filmBar ? 'width .25s linear' : undefined,
              animation: playing && !filmBar ? `ssProg ${cfg.seconds}s linear forwards` : 'none',
            }} />
        </div>
      </div>
      {asking && (
        <PlayModal cfg={cfg} onCfg={onCfg} onClose={() => setAsking(false)}
          onStart={() => { setAsking(false); setChosen(true); dispatch({ kind: 'toggle' }); }} />
      )}
    </Dialog>
  );
}

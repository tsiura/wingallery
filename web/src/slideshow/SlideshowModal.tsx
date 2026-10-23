// The window that asks how to play a slideshow (design lines 216-268). Rendered by whoever wants it asked for as long as it is wanted: mounted means open (G12).

import type { ShowConfig } from '../lib/slideshow.ts';
import { Alert, Frame } from '../explorer/Dialogs.tsx';
import { Button, Dialog, Seg, Toggle } from '../ui/controls.tsx';

const TRANSITIONS: [ShowConfig['transition'], string][] = [['fade', 'Fade'], ['slide', 'Slide'], ['none', 'None']];
const TOGGLES: [key: 'shuffle' | 'loop' | 'videos' | 'subfolders', label: string][] = [
  ['shuffle', 'Shuffle'], ['loop', 'Loop'], ['videos', 'Include videos'], ['subfolders', 'Include subfolders'],
];
const section = { display: 'flex', flexDirection: 'column', gap: 8 } as const;

// `poolCount` is how many items the options as they are now would play (null while that is being counted: a recursive list is read from the server), and with 0 there
// is nothing to start. `note` is a line under it (a list that was cut short), `error` what went wrong in getting the list. Play (the scope) is offered only when
// something is selected (`selectedCount`).
export function SlideshowModal({ folderName, poolCount, selectedCount, cfg, onCfg, onStart, onClose, note, error }: {
  folderName: string; poolCount: number | null; selectedCount: number; cfg: ShowConfig; onCfg(patch: Partial<ShowConfig>): void; onStart(): void; onClose(): void;
  note?: string; error?: string;
}) {
  const items = poolCount === null ? 'counting…' : `${poolCount} ${poolCount === 1 ? 'item' : 'items'}`;
  return (
    <Dialog label="Start slideshow" onClose={onClose}>
      <Frame title="Start slideshow" gap={18} onSubmit={() => { if (poolCount) onStart(); }}
        sub={<>{folderName} · {items}{note && <div style={{ fontSize: 12, marginTop: 2 }}>{note}</div>}</>}
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!poolCount}>Start</Button></>}>
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 600 }}>Slide time</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#005fb8', fontWeight: 600 }}>{cfg.seconds} seconds</span>
          </div>
          <input type="range" min={2} max={20} step={1} value={cfg.seconds} aria-label="Slide time" onChange={(e) => onCfg({ seconds: Number(e.target.value) })} style={{ width: '100%' }} />
        </div>
        {selectedCount > 0 && (
          <div style={section}>
            <span style={{ fontWeight: 600 }}>Play</span>
            <Seg fill plain value={cfg.scope} onChange={(scope) => onCfg({ scope })} options={[['folder', 'Whole folder'], ['selected', `Selected (${selectedCount})`]]} />
          </div>
        )}
        <div style={section}>
          <span style={{ fontWeight: 600 }}>Transition</span>
          <Seg fill plain value={cfg.transition} onChange={(transition) => onCfg({ transition })} options={TRANSITIONS} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {TOGGLES.map(([key, label]) => (
            <Toggle key={key} label={label} checked={cfg[key]} onChange={(on) => onCfg({ [key]: on })} style={{ borderTop: '1px solid #eceef2' }} />
          ))}
        </div>
        <Alert message={error ?? ''} />
      </Frame>
    </Dialog>
  );
}

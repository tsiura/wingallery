import type { CSSProperties } from 'react';
import type { Entry } from '../../../shared/types.ts';
import { statusCount, statusSel } from '../lib/status.ts';

const clip: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

// The strip under the items (design lines 208-215): what the folder holds, and what is selected. `selected` are entry names. `entries` are the items shown
// (a search narrows them) and `all` the whole folder, which is where the photos and videos are counted.
export function StatusBar({ entries, all = entries, selected }: { entries: Entry[]; all?: Entry[]; selected: string[] }) {
  return (
    <div style={{ height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', borderTop: '1px solid #eceef2', color: '#5c616b', fontSize: 12 }}>
      <span style={clip}>{statusCount(entries, all)}</span>
      <span style={clip}>{statusSel(entries, selected)}</span>
    </div>
  );
}

import type { ReactNode } from 'react';
import type { ViewMode } from '../../../shared/types.ts';
import { SORT_LABELS } from '../lib/sort.ts';
import type { SortKey } from '../lib/sort.ts';
import { useWide } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import type { IconName } from '../ui/Icon.tsx';

const VIEWS: [key: ViewMode, label: string][] = [['large', 'Large icons'], ['medium', 'Medium icons'], ['details', 'Details']];   // a view's key is also its icon's name

// A button of the bar, the icon and its words (design lines 110-117). The actions that Explorer puts into the bar's `children` use it too.
export function ToolButton({ icon, label, onClick }: { icon: IconName; label: string; onClick(): void }) {
  return <button type="button" className="tool-btn" onClick={onClick}><Icon name={icon} size={14} />{label}</button>;
}

// The bar over the items (design lines 103-135): the slideshow, the sort, select all/none, the "Read only" badge, then whatever the caller puts in `children`
// (the actions the user's rights allow), and the view switch at the far end. The switch has labels only when the window is wide.
// `allSelected` is whether the second button offers "Select none": the design says so as soon as anything is selected, not only when all of it is.
export function Toolbar({ view, onView, sortKey, sortDir, onCycleSort, allSelected, onSelectAll, onSlideshow, readOnly, children }: {
  view: ViewMode; onView(view: ViewMode): void; sortKey: SortKey; sortDir: 1 | -1; onCycleSort(): void;
  allSelected: boolean; onSelectAll(): void; onSlideshow(): void; readOnly: boolean; children?: ReactNode;
}) {
  const wide = useWide();
  return (
    <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid #eceef2', overflowX: 'auto', overflowY: 'hidden' }}>
      <button type="button" className="tool-btn primary" onClick={onSlideshow}><Icon name="play" size={14} />Slideshow</button>
      <div style={{ width: 1, height: 20, flexShrink: 0, margin: '0 4px', background: '#e1e4ea' }} />
      <ToolButton icon="sort" label={`Sort: ${SORT_LABELS[sortKey]} ${sortDir > 0 ? '↑' : '↓'}`} onClick={onCycleSort} />
      <ToolButton icon="select" label={allSelected ? 'Select none' : 'Select all'} onClick={onSelectAll} />
      {readOnly && (
        <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', flexShrink: 0, borderRadius: 12, background: '#f1f3f6', color: '#4a4e57', fontSize: 12, whiteSpace: 'nowrap' }}>
          <Icon name="lock" size={12} />Read only
        </div>
      )}
      {children}
      <div style={{ flex: 1 }} />
      <div role="group" aria-label="View" style={{ display: 'flex', gap: 2, padding: 2, flexShrink: 0, borderRadius: 7, background: '#f1f3f6' }}>
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" className="view-btn" title={label} aria-label={label} aria-pressed={key === view} onClick={() => onView(key)}>
            <Icon name={key} size={14} />{wide && <span>{label}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

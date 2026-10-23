import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { ViewMode } from '../../../shared/types.ts';
import type { ActionState } from '../lib/actions.ts';
import { SORT_LABELS } from '../lib/sort.ts';
import type { SortKey } from '../lib/sort.ts';
import { useMediaQuery, useNarrow, useWide } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import type { IconName } from '../ui/Icon.tsx';

const VIEWS: [key: ViewMode, label: string][] = [['large', 'Large icons'], ['medium', 'Medium icons'], ['details', 'Details']];   // a view's key is also its icon's name

// A button of the bar, the icon and its words (design lines 110-117). The actions that Explorer puts into the bar's `children` use it too. `iconOnly` keeps the
// words for the tooltip and the screen reader.
export function ToolButton({ icon, label, onClick, iconOnly }: { icon: IconName; label: string; onClick(): void; iconOnly?: boolean }) {
  return (
    <button type="button" className="tool-btn" title={iconOnly ? label : undefined} aria-label={iconOnly ? label : undefined} onClick={onClick}>
      <Icon name={icon} size={14} />{!iconOnly && label}
    </button>
  );
}

const Divider = () => <div style={{ width: 1, height: 20, flexShrink: 0, margin: '0 4px', background: '#e1e4ea' }} />;

// What the actions are called, in the order the bar shows them, in groups: what adds, what changes, what takes. An action's name is also its icon's.
const GROUPS: [action: keyof ActionState, label: string][][] = [
  [['upload', 'Upload'], ['newFolder', 'New folder']],
  [['rename', 'Rename'], ['move', 'Move to…'], ['delete', 'Delete']],
  [['download', 'Download']],
];

// The buttons of the actions that the user's rights and the selection allow (spec 5.2.2: the others are hidden, not greyed out), each group behind a divider and
// a group with nothing to show without one. They go into the bar's `children`, so on a phone they scroll sideways with the rest of it, with their words.
// `many` says that the rights allow four or more actions at once (`mostActions`). With their words those need about 1400 px next to the rest of the bar, which only
// a window of 1640 px has: below that (and not on a phone) they are icons with the words in the tooltip, as in Windows 11, so that the bar does not run over and
// push the view switch out of sight. The rights decide this, not the selection, so the bar keeps its look while the selection changes.
export function ToolbarActions({ actions, many, on }: { actions: ActionState; many: boolean; on: Record<keyof ActionState, () => void> }) {
  const phone = useNarrow();
  const roomy = useMediaQuery('(min-width: 1640px)');
  const iconOnly = many && !phone && !roomy;
  return GROUPS.map((group) => group.filter(([action]) => actions[action])).map((shown) => shown.length > 0 && (
    <Fragment key={shown[0][0]}>
      <Divider />
      {shown.map(([action, label]) => <ToolButton key={action} icon={action} label={label} iconOnly={iconOnly} onClick={on[action]} />)}
    </Fragment>
  ));
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
      <Divider />
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

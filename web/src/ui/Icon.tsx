// The design's icons as inline SVG (16x16 grid), and the app's logo. Strokes and fills take the text colour (`color`), except the folders, which are yellow
// (`folderFlat` is the address bar's, in one tone; `folder` is the tree's, `folderItem` the item list's, a little deeper: design lines 187 and 424).
// The icons the design doesn't have (settings, user, upload, newFolder, rename, move, delete, download, menu, fullscreen, photo, video, check) are drawn the
// same way.

import type { ReactNode } from 'react';

export type IconName =
  | 'folder' | 'folderItem' | 'folderFlat' | 'back' | 'forward' | 'up' | 'search' | 'play' | 'pause' | 'prev' | 'next' | 'close' | 'large' | 'medium' | 'details'
  | 'sort' | 'select' | 'lock' | 'settings' | 'user' | 'upload' | 'newFolder' | 'rename' | 'move' | 'delete' | 'download' | 'menu' | 'fullscreen' | 'photo' | 'video'
  | 'check';

const line = (width: number, shapes: ReactNode) => (
  <g fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">{shapes}</g>
);
const solid = (shapes: ReactNode) => <g fill="currentColor">{shapes}</g>;

const FOLDER_OUTLINE = 'M1.5 4.5a1 1 0 011-1h3.6l1.4 1.4h6a1 1 0 011 1v6.6a1 1 0 01-1 1h-11a1 1 0 01-1-1z';
const FOLDER_FRONT = 'M1.5 6.5h13v5.9a1 1 0 01-1 1h-11a1 1 0 01-1-1z';
const TRAY = 'M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2';

// The back and the front of a folder in the item list (the Items view draws its big folder tile in the same two colours).
export const ITEM_FOLDER = { back: '#e9b33f', front: '#f7cd62' } as const;
const folder = (back: string, front: string) => <><path d={FOLDER_OUTLINE} fill={back} /><path d={FOLDER_FRONT} fill={front} /></>;

const ICONS: Record<IconName, ReactNode> = {
  folder: folder('#f2bf4b', '#f8d36f'),
  folderItem: folder(ITEM_FOLDER.back, ITEM_FOLDER.front),
  folderFlat: <path d={FOLDER_OUTLINE} fill="#f2bf4b" />,
  back: line(1.3, <path d="M13 8H3M7 4L3 8l4 4" />),
  forward: line(1.3, <path d="M3 8h10M9 4l4 4-4 4" />),
  up: line(1.3, <path d="M8 13V3M4 7l4-4 4 4" />),
  search: line(1.3, <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>),
  play: solid(<path d="M4.5 2.8v10.4a.6.6 0 00.9.5l8.2-5.2a.6.6 0 000-1L5.4 2.3a.6.6 0 00-.9.5z" />),
  pause: solid(<><rect x="3.5" y="2.5" width="3" height="11" rx="1" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" /></>),
  prev: line(1.6, <path d="M10 3L5 8l5 5" />),
  next: line(1.6, <path d="M6 3l5 5-5 5" />),
  close: line(1.5, <path d="M3 3l10 10M13 3L3 13" />),
  large: line(1.2, <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>),
  medium: solid(<>{[2, 6.5, 11].flatMap((y) => [2, 6.5, 11].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3" rx=".6" />))}</>),
  details: line(1.2, <path d="M2 3.5h12M2 8h12M2 12.5h12" />),
  sort: line(1.2, <path d="M4 2.5v11M1.8 11.2L4 13.5l2.2-2.3M9 4h5M9 8h3.5M9 12h2" />),
  select: line(1.2, <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 8.2l2 2 4-4.2" /></>),
  lock: line(1.3, <><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>),
  settings: line(1.4, <><path d="M2 4.5h6M12 4.5h2M2 11.5h2M8 11.5h6" /><circle cx="10" cy="4.5" r="1.8" /><circle cx="6" cy="11.5" r="1.8" /></>),
  user: line(1.4, <><circle cx="8" cy="5.3" r="2.6" /><path d="M2.8 14c.3-2.7 2.4-4.4 5.2-4.4s4.9 1.7 5.2 4.4" /></>),
  upload: line(1.5, <path d={`M8 10.5v-8M4.8 5.5L8 2.3l3.2 3.2${TRAY}`} />),
  newFolder: line(1.4, <><path d={FOLDER_OUTLINE} /><path d="M8 7v4M6 9h4" /></>),
  rename: line(1.4, <><path d="M11 2.5L13.5 5l-8 8H3v-2.5z" /><path d="M9.5 4L12 6.5" /></>),
  move: line(1.5, <path d="M2 8h8M7.5 4.8L10.7 8l-3.2 3.2M13.5 3v10" />),
  delete: line(1.4, <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.8 7v4M9.2 7v4" />),
  download: line(1.5, <path d={`M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2${TRAY}`} />),
  menu: line(1.5, <path d="M2 4h12M2 8h12M2 12h12" />),
  fullscreen: line(1.5, <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />),
  photo: line(1.3, <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M3.5 11l3-3.2 2.2 2.2 1.6-1.6L13 11" /></>),
  video: line(1.3, <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M6.6 6v4l3.4-2z" /></>),
  check: line(1.8, <path d="M3.5 8.5l3 3 6-6.5" />),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>{ICONS[name]}</svg>;
}

// The small chevron of the folder tree and the breadcrumbs: the design draws it on a 12-unit grid, in its own sizes, greys and stroke widths.
export function Chevron({ size, color, width }: { size: number; color: string; width: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" stroke={color} strokeWidth={width} fill="none" strokeLinecap="round" />
    </svg>
  );
}

// The title-bar logo of the design (18 px: a 5 px radius and an 11 px glyph), at any size.
export function Logo({ size = 18 }: { size?: number }) {
  const glyph = (size * 11) / 18;
  return (
    <div style={{ width: size, height: size, borderRadius: (size * 5) / 18, background: '#005fb8', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width={glyph} height={glyph} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="#fff" strokeWidth="1.6" />
        <path d="M3.5 11l3-3.2 2.2 2.2 1.6-1.6L13 11" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

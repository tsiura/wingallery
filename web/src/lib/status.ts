// The status bar's two texts, worded as the design does (statusCount, statusSel; the design says "1 items" too).

import type { Entry } from '../../../shared/types.ts';
import { fmtSize } from './format.ts';

// "12 items  ·  9 photos, 3 videos"; a folder with no files in it has no second part.
export function statusCount(entries: readonly Entry[]): string {
  const photos = entries.filter((e) => e.kind === 'photo').length;
  const videos = entries.filter((e) => e.kind === 'video').length;
  return `${entries.length} items` + (photos + videos > 0 ? `  ·  ${photos} photos, ${videos} videos` : '');
}

// "3 selected  ·  5.2 MB", or nothing when nothing is selected. `selected` are entry names; the size is the files' among them (a folder has none).
export function statusSel(entries: readonly Entry[], selected: readonly string[]): string {
  if (selected.length === 0) return '';
  const names = new Set(selected);
  const size = entries.reduce((sum, e) => (e.kind !== 'folder' && names.has(e.name) ? sum + e.size : sum), 0);
  return `${selected.length} selected` + (size > 0 ? `  ·  ${fmtSize(size)}` : '');
}

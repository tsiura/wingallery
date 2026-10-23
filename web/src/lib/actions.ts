// What the toolbar's actions are for: which of them the user's rights and the selection allow, the words of the delete confirmation, and what a download sends.

import type { DeletePreview, Entry, Rights } from '../../../shared/types.ts';
import { joinV } from './route.ts';

export interface ActionState { upload: boolean; newFolder: boolean; rename: boolean; move: boolean; delete: boolean; download: boolean }

export const NO_ACTIONS: ActionState = { upload: false, newFolder: false, rename: false, move: false, delete: false, download: false };

// Spec 5.2.2: an action the user lacks is hidden. The roots of shares and the top-level folders ("protected") can't be renamed, moved or deleted by anyone;
// one of them in the selection takes those three away, whatever else is selected. Download needs only something to download (read is always there).
export function actionsFor(rights: Rights, selected: Entry[]): ActionState {
  const some = selected.length > 0;
  const free = !selected.some((e) => e.kind === 'folder' && e.protected);
  return {
    upload: rights.create,
    newFolder: rights.create,
    rename: rights.update && selected.length === 1 && free,
    move: rights.update && some && free,
    delete: rights.delete && some && free,
    download: some,
  };
}

// How many actions these rights can show at once, with one ordinary item selected. The toolbar decides how to lay its buttons out by this and not by what is
// selected, so that it keeps its look while the selection changes.
export const mostActions = (rights: Rights): number => (rights.create ? 2 : 0) + (rights.update ? 2 : 0) + (rights.delete ? 1 : 0) + 1;

// How much of a name a rename selects, so that typing over it leaves the extension alone. The server splits at the last dot too (splitExt): a name with only a
// leading dot has no extension.
export function baseLength(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

// The folder that a move stays inside: a member moves within one share (its alias is the first segment), an administrator within one top-level folder. The root has none.
export function scopeRootOf(vpath: string): string | null {
  const first = vpath.split('/')[1];
  return first ? '/' + first : null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// The confirmation of a delete (spec 4.4): how many items go to the Recycle Bin, how many files that the gallery doesn't show go with the folders among them,
// and, for a member, who can bring them back. `detail` is lines, joined with a newline.
export function deleteWords({ items, hiddenFiles }: DeletePreview, member: boolean): { message: string; detail?: string } {
  const lines: string[] = [];
  if (hiddenFiles > 0) lines.push(`…and ${plural(hiddenFiles, 'other file', 'other files')} the gallery doesn't show.`);
  if (member) lines.push(`The admin can restore ${items === 1 ? 'it' : 'them'}.`);
  const message = `Move ${plural(items, 'item', 'items')} to the Recycle Bin?`;
  return lines.length > 0 ? { message, detail: lines.join('\n') } : { message };
}

// The server reads the zip form with a 1 MB cap (about 10-17k paths); this stays under it.
const ZIP_FORM_LIMIT = 900_000;

export type DownloadPlan = { kind: 'file'; path: string } | { kind: 'zip'; paths: string[] } | { kind: 'too-many' };

// One file is downloaded as it is, anything else as a zip. When everything in the folder (`folderSize` items) is selected, the folder itself is sent instead of
// every item in it: a whole folder can have more items than the form can carry. Not at the root: a member's root is no folder on disk. A selection whose form,
// as the browser encodes it, is too long is refused.
export function downloadPlan(vpath: string, picked: Entry[], folderSize: number): DownloadPlan {
  if (picked.length === 1 && picked[0].kind !== 'folder') return { kind: 'file', path: joinV(vpath, picked[0].name) };
  const paths = picked.length > 1 && picked.length === folderSize && vpath !== '/' ? [vpath] : picked.map((e) => joinV(vpath, e.name));
  return new URLSearchParams({ paths: JSON.stringify(paths) }).toString().length > ZIP_FORM_LIMIT ? { kind: 'too-many' } : { kind: 'zip', paths };
}

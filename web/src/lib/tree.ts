// The sidebar's rows: the root, and under each open folder its subfolders, depth first.

import type { FolderNode } from '../../../shared/types.ts';
import { joinV, ROOT_NAME } from './route.ts';

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  count: number;         // media files at any depth; 0 is shown as nothing
  expandable: boolean;   // has a chevron
  open: boolean;
  active: boolean;       // the folder the Explorer is in
  unavailable: boolean;  // a share whose folder is gone: greyed out, can't be opened
}

// `kidsOf(path)` is what has been loaded of a folder's subfolders; undefined means it has not been asked for yet.
// The root has no count of its own, so it adds up its folders.
export function treeRows(vpath: string, expanded: ReadonlySet<string>, kidsOf: (path: string) => readonly FolderNode[] | undefined): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (path: string, name: string, depth: number, node: FolderNode | null): void => {
    const kids = kidsOf(path);
    const open = expanded.has(path);
    rows.push({
      path, name, depth, open,
      count: node ? node.count : (kids?.reduce((sum, k) => sum + k.count, 0) ?? 0),
      expandable: node ? node.hasChildren : kids === undefined || kids.length > 0,   // the root can't know before its folders have arrived
      active: path === vpath,
      unavailable: node?.unavailable === true,
    });
    if (open && kids) for (const kid of kids) walk(joinV(path, kid.name), kid.name, depth + 1, kid);
  };
  walk('/', ROOT_NAME, 0, null);
  return rows;
}

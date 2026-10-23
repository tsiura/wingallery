// The words and the small rules of the settings window.

import type { Role, TrashItem } from '../../../shared/types.ts';
import { plural } from './format.ts';

export const roleName = (role: Role): string => (role === 'admin' ? 'Administrator' : 'Member');

// The line under a user's name in the list: the role, and which one is you.
export const userSub = (role: Role, self: boolean): string => roleName(role) + (self ? ' · You' : '');

export const userCount = (n: number): string => plural(n, 'user', 'users');

// The design takes the spaces out of a username and lowers its case as it is typed (spec 5.2.6); the server does the same and then holds it to 2-32 of a-z 0-9 . _ -.
export const cleanUsername = (typed: string): string => typed.replace(/\s/g, '').toLowerCase();

// The number of days is the server's (TRASH_DAYS), not a constant of the page.
export const trashNote = (days: number): string => `Items are deleted for good after ${plural(days, 'day', 'days')}.`;

export const hiddenNote = (n: number): string => `Contains ${plural(n, 'hidden file', 'hidden files')}`;

// The folder an item was deleted from: the server gives its original path with the name at the end (a POSIX path, as the server runs in a container).
export function locationOf({ originalPath }: Pick<TrashItem, 'originalPath'>): string {
  const slash = originalPath.lastIndexOf('/');
  return slash > 0 ? originalPath.slice(0, slash) : slash === 0 ? '/' : '.';
}

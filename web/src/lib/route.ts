// The address bar's side of the Explorer: /browse/<segments> and the virtual path the API takes.

const BROWSE = '/browse';

// /browse and everything below it.
export const isBrowsePath = (pathname: string): boolean => pathname === BROWSE || pathname.startsWith(BROWSE + '/');

// A bad %-escape in a hand-typed address stays as typed; the server then says there is no such folder.
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Anything outside /browse is the root, and so are empty segments (a trailing or doubled slash).
export function vpathFromLocation(pathname: string): string {
  if (!isBrowsePath(pathname)) return '/';
  return '/' + pathname.slice(BROWSE.length).split('/').filter(Boolean).map(decode).join('/');
}

export function browseHref(vpath: string): string {
  return BROWSE + vpath.split('/').map(encodeURIComponent).join('/');   // '/' gives '/browse/'
}

export function parentOf(vpath: string): string | null {
  return vpath === '/' ? null : vpath.slice(0, vpath.lastIndexOf('/')) || '/';
}

export const nameOf = (vpath: string): string => vpath.slice(vpath.lastIndexOf('/') + 1);

export const joinV = (parent: string, name: string): string => (parent === '/' ? '' : parent) + '/' + name;

// What the root of every tree is called, an admin's media folder and a member's list of shares alike (the server says the same in a listing's `name`).
export const ROOT_NAME = 'Home Gallery';

// The root, then every folder down to `vpath`, each with the path that opens it: the breadcrumbs.
export function crumbsOf(vpath: string): { name: string; vpath: string }[] {
  const crumbs = [{ name: ROOT_NAME, vpath: '/' }];
  for (const name of vpath.split('/').filter(Boolean)) crumbs.push({ name, vpath: joinV(crumbs[crumbs.length - 1].vpath, name) });
  return crumbs;
}

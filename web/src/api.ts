// The one door to the server: JSON calls that throw the server's own message, and the URLs of the media routes.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Same-origin, so the browser sends the cookie, and the Origin the server wants on anything but a read. Status 0 is no answer at all.
// A 401 from anywhere but the sign-in and the session check means the session has ended: the app listens for the event and shows the login page.
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    text = await res.text();
  } catch {
    throw new ApiError(0, "Can't reach the server");
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: an error page from something in front of the server
  }
  if (!res.ok) {
    const route = path.split('?')[0];
    if (res.status === 401 && route !== '/api/login' && route !== '/api/session') window.dispatchEvent(new Event('gallery:unauthorized'));
    const message = (data as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof message === 'string' ? message : 'Something went wrong');
  }
  return data as T;
}

export const q = (vpath: string): string => encodeURIComponent(vpath);

export const thumbUrl = (vpath: string, mtime: number): string => `/media/thumb?path=${q(vpath)}&v=${mtime}`;   // v: a new file gets a new URL, so the cached thumbnail never goes stale
export const viewUrl = (vpath: string): string => `/media/view?path=${q(vpath)}`;
export const downloadUrl = (vpath: string): string => `/media/download?path=${q(vpath)}`;

// Saves one media file as it is on disk: a click on a link that says "download", never `location.href`, which would take the page away when the server refuses (404).
// The browser then shows a failed download and the app stays where it is.
export function saveFile(vpath: string): void {
  const link = document.createElement('a');
  link.href = downloadUrl(vpath);
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

let zips = 0;

// Downloads a zip of the given virtual paths. A form POST (the selection can be too long for a URL) into a hidden iframe: a zip is a download and never renders,
// so the page stays as it is, but an error answered before the first byte (JSON, 404) would take over a window it was posted to. In the iframe it can only
// load, and a load means exactly that: onError('Download failed').
export function submitZip(paths: string[], onError?: (message: string) => void): void {
  const frame = document.createElement('iframe');
  frame.name = `zip-${++zips}`;
  frame.hidden = true;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/media/zip';
  form.target = frame.name;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'paths';
  field.value = JSON.stringify(paths);
  form.append(field);
  document.body.append(frame, form);
  const cleanUp = () => { frame.remove(); form.remove(); };
  frame.addEventListener('load', () => { cleanUp(); onError?.('Download failed'); });
  form.submit();
  // A download that has begun doesn't need its frame any more, and nothing says when that is: give the server ten minutes to answer.
  setTimeout(cleanUp, 10 * 60_000);
}

// The web app's own files: the built page and its hashed assets, from cfg.webDist. Every other address a browser may be given (/browse/..., /setup) is the
// page, which reads its address itself.

import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Config } from './config.ts';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';
import { sendFile } from './send.ts';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
};

// False for a missing file, for a folder, and for a name that can't be one (a file used as a folder, a NUL).
const isFile = (abs: string): Promise<boolean> => stat(abs).then((st) => st.isFile(), () => false);

// The file a /assets/... path names, or null when there is none or the path leads out of webDist.
async function assetPath(webDist: string, pathname: string): Promise<string | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;   // a bad %-escape
  }
  const root = resolve(webDist);
  const abs = resolve(root, rel);
  return abs.startsWith(root + sep) && await isFile(abs) ? abs : null;
}

// For a request no route took. Reads outside /api and /media get the page (or an asset); everything else is the same 404 as before the web app existed.
export async function serveWeb(ctx: Ctx, cfg: Config): Promise<void> {
  const { pathname } = ctx.url;
  const method = ctx.req.method;
  if ((method !== 'GET' && method !== 'HEAD') || /^\/(api|media)(\/|$)/.test(pathname)) throw new HttpError(404, 'Not found');
  if (pathname.startsWith('/assets/')) {
    const abs = await assetPath(cfg.webDist, pathname);
    // An asset that isn't there is answered with the page, like any other address. A tab that still asks for the file names of an older build gets HTML where it
    // wanted a script, which a browser refuses to run, so it breaks loudly and a reload fixes it.
    if (abs) return sendFile(ctx, abs, { type: TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream', cache: 'static' });
  }
  const index = join(cfg.webDist, 'index.html');
  if (!await isFile(index)) {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('Web UI not built (run npm run build)');
    return;
  }
  return sendFile(ctx, index, { type: 'text/html; charset=utf-8', cache: 'revalidate' });
}

// Sends one file from disk the way the gallery wants every file sent: HEAD, a weak ETag with 304, one byte range, and the cache and download headers.
// The caller has decided that this client may have this file; sendFile only moves the bytes.

import { open } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';

type CacheMode = 'immutable' | 'revalidate' | 'static';

const CACHE: Record<CacheMode, string> = {
  immutable: 'private, max-age=31536000, immutable',   // thumbnails: the URL carries the version of the file
  revalidate: 'private, no-cache',                     // originals and previews: kept, but the browser asks again before each use
  static: 'public, max-age=31536000, immutable',       // the app's own files, whose names change with their content
};

// `filename` is a plain-ASCII fallback for old clients: no quote or backslash to end or escape the string, and no control character (CR, LF) to end
// the header line. `filename*` (RFC 5987) carries the real name in UTF-8; encodeURIComponent leaves ' ( ) * alone, which an attr-char may not be.
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// If-None-Match against our ETag, weakly (RFC 9110 13.1.2): W/ counts for nothing on either side, and * matches anything that exists.
function notModified(header: string | undefined, etag: string): boolean {
  return (header ?? '').split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.slice(2));
}

// The one range of a `bytes=` header, with `end` inclusive. 'unsatisfiable' when it starts past the end of the file. null when the file is to be sent
// whole: no header, another unit, several ranges or a malformed one, all of which a server may ignore (RFC 9110 14.2). Numbers over 15 digits are malformed.
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(?:(\d{1,15})-(\d{1,15})?|-(\d{1,15}))$/i.exec(header ?? '');
  if (!m) return null;
  if (m[3] !== undefined) {   // bytes=-n: the last n bytes
    const n = Number(m[3]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== undefined && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === undefined ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

export async function sendFile(ctx: Ctx, abs: string, opts: { type: string; download?: string; cache: CacheMode }): Promise<void> {
  const { req, res } = ctx;
  // One open file: the size in the headers and the bytes that follow are of the same file, even if the name is swapped meanwhile.
  const file = await open(abs, 'r');
  try {
    const st = await file.stat();
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    // The client may have left while its thumbnail was being made, and a response that is gone can't take a pipe (nothing to log, nothing to send).
    if (res.destroyed) return;
    const etag = `W/"${st.size}-${st.mtimeMs}"`;
    // The pipeline may renew the session cookie on any response. A shared cache must never store one that carries it (R1).
    const cache = res.hasHeader('set-cookie') ? CACHE[opts.cache].replace('public', 'private') : CACHE[opts.cache];
    if (notModified(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': cache });
      res.end();
      return;
    }
    // If-Range asks for the range only if the client's copy is still the file, which only a strong validator can tell (RFC 9110 13.1.5). Ours is weak
    // and there is no Last-Modified, so nothing can match: a client that sends one gets the whole file, which is always right.
    const range = parseRange(req.headers['if-range'] === undefined ? req.headers.range : undefined, st.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${st.size}`, 'content-length': 0 });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: st.size - 1 };
    const headers: OutgoingHttpHeaders = { 'content-type': opts.type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', etag, 'cache-control': cache };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    if (opts.download !== undefined) headers['content-disposition'] = contentDisposition('attachment', opts.download);
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || st.size === 0) {
      res.end();
      return;
    }
    try {
      await pipeline(file.createReadStream({ start, end }), res);
    } catch (err) {
      // A viewer who seeks in a video, or leaves, hangs up on the transfer all the time; that is no fault of ours. Anything else is, and fail() logs it.
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
    }
  } finally {
    await file.close();   // the read stream closes it too when it ends; closing twice is harmless
  }
}

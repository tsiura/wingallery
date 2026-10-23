// The endpoints the UI loads every image and video from: the thumbnail, the viewable version and the download of one media file. Each handler starts
// with requireUser, before it looks at the path; the path then goes through locate(), like every request that touches files.

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { App } from './app.ts';
import { requireUser } from './auth.ts';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';
import { mediaTypeOf } from './mediatypes.ts';
import type { MediaType } from './mediatypes.ts';
import { sendFile } from './send.ts';
import { locate } from './vpath.ts';

// The file a request names, or 404: only a regular file with a media extension is ever served, whatever else lies in the share.
// No path at all is '' and fails as an invalid one.
async function mediaFile(app: App, ctx: Ctx): Promise<{ abs: string; rel: string; name: string; st: Stats; type: MediaType }> {
  const user = requireUser(ctx);
  const loc = await locate(app, user, ctx.url.searchParams.get('path') ?? '');
  const name = loc.abs === null ? '' : basename(loc.abs);
  const type = mediaTypeOf(name);
  if (loc.abs === null || !type) throw new HttpError(404, 'Not found');
  const st = await stat(loc.abs);
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  return { abs: loc.abs, rel: loc.rel, name, st, type };
}

export function registerMediaRoutes(app: App): void {
  const { router } = app;

  // The URL carries the file's version (`v`), which only keeps the browser's copy from outliving the file: what is served is always made
  // from the file as it is now.
  router.add('GET', '/media/thumb', async (ctx) => {
    const f = await mediaFile(app, ctx);
    await sendFile(ctx, await app.thumbs.thumb(f.abs, f.rel, f.st, f.type.kind), { type: 'image/jpeg', cache: 'immutable' });
  });

  router.add('GET', '/media/view', async (ctx) => {
    const f = await mediaFile(app, ctx);
    if (f.type.convert) await sendFile(ctx, await app.thumbs.preview(f.abs, f.rel, f.st), { type: 'image/jpeg', cache: 'revalidate' });
    else await sendFile(ctx, f.abs, { type: f.type.viewMime ?? f.type.mime, cache: 'revalidate' });
  });

  router.add('GET', '/media/download', async (ctx) => {
    const f = await mediaFile(app, ctx);
    await sendFile(ctx, f.abs, { type: f.type.mime, download: f.name, cache: 'revalidate' });
  });
}

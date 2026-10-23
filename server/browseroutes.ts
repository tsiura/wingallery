// The browsing endpoints: one folder, the folder tree, a recursive file list and one file's metadata. Each handler starts with requireUser,
// before it looks at the path; the path then goes through locate(), like every request that touches files.

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { App } from './app.ts';
import { requireUser } from './auth.ts';
import { HttpError } from './http.ts';
import type { Ctx } from './http.ts';
import { listFiles, listFolder, listFolders } from './listing.ts';
import { mediaTypeOf } from './mediatypes.ts';
import { getMeta } from './meta.ts';
import { locate } from './vpath.ts';

// No path at all is '' and fails as an invalid one.
const pathOf = (ctx: Ctx) => ctx.url.searchParams.get('path') ?? '';

export function registerBrowseRoutes(app: App): void {
  const { db, router } = app;

  router.add('GET', '/api/list', async (ctx) => {
    const user = requireUser(ctx);
    return listFolder(app, user, await locate(app, user, pathOf(ctx)));
  });

  router.add('GET', '/api/folders', async (ctx) => {
    const user = requireUser(ctx);
    return listFolders(app, user, await locate(app, user, pathOf(ctx)));
  });

  router.add('GET', '/api/files', async (ctx) => {
    const user = requireUser(ctx);
    return listFiles(app, user, await locate(app, user, pathOf(ctx)));
  });

  router.add('GET', '/api/meta', async (ctx) => {
    const user = requireUser(ctx);
    const loc = await locate(app, user, pathOf(ctx));
    const notMedia = () => new HttpError(400, 'Not a media file');
    if (loc.abs === null) throw notMedia();   // a member's root
    const st = await stat(loc.abs);
    const type = mediaTypeOf(basename(loc.abs));
    if (!st.isFile() || !type) throw notMedia();
    return getMeta(db, loc.abs, loc.rel, st, type.kind);
  });
}

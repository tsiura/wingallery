// The endpoints that change the folder tree: new folder, rename, move, delete. Each handler starts with requireUser, before it reads the body; the
// paths then go through locate() in fsops and trash, like every request that touches files.

import type { App } from './app.ts';
import { requireUser } from './auth.ts';
import { makeFolder, moveItems, renameItem } from './fsops.ts';
import { HttpError, readObject, str } from './http.ts';
import { deletePreview, trashItems } from './trash.ts';

// A path and a name: a small cap keeps these from buffering megabytes. A move names a whole selection, so it keeps the default cap.
const SMALL = 16 * 1024;

export function registerFileRoutes(app: App): void {
  const { router } = app;

  router.add('POST', '/api/mkdir', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx, SMALL);
    return makeFolder(app, user, str(body.path), str(body.name));
  });

  router.add('POST', '/api/rename', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx, SMALL);
    return renameItem(app, user, str(body.path), str(body.name));
  });

  router.add('POST', '/api/move', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx);
    if (!Array.isArray(body.paths)) throw new HttpError(400, 'Invalid JSON');
    return moveItems(app, user, body.paths.map(str), str(body.to));
  });

  // What the confirmation says: how many items, and how many files the gallery doesn't show go with the folders among them.
  router.add('POST', '/api/delete/preview', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx);
    if (!Array.isArray(body.paths)) throw new HttpError(400, 'Invalid JSON');
    return deletePreview(app, user, body.paths.map(str));
  });

  // Into the Recycle Bin, not away: only the administrator can bring an item back.
  router.add('POST', '/api/delete', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx);
    if (!Array.isArray(body.paths)) throw new HttpError(400, 'Invalid JSON');
    return trashItems(app, user, body.paths.map(str));
  });
}

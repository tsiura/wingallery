// The endpoints that change the folder tree: new folder, rename, move, delete, upload. Each handler starts with requireUser, before it reads the body;
// the paths then go through locate() in fsops, trash and uploads, like every request that touches files.

import type { App } from './app.ts';
import { requireUser } from './auth.ts';
import { makeFolder, moveItems, renameItem } from './fsops.ts';
import { HttpError, readBody, readObject, str } from './http.ts';
import { deletePreview, trashItems } from './trash.ts';
import { CHUNK_MAX, cancelUpload, startUpload, writeChunk } from './uploads.ts';

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

  // A file goes up in chunks (uploads.ts): start names the folder, the name and the size, and each chunk then goes in where the one before ended.
  router.add('POST', '/api/upload/start', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readObject(ctx, SMALL);
    return startUpload(app, user, { dir: str(body.dir), name: str(body.name), size: typeof body.size === 'number' ? body.size : 0 });
  });

  router.add('PUT', '/api/upload/:id', async (ctx) => {
    const user = requireUser(ctx);
    const chunk = await readBody(ctx, CHUNK_MAX, 'application/octet-stream', 'Chunk too large');
    const offset = ctx.url.searchParams.get('offset') ?? '';
    return writeChunk(app, user, ctx.params.id, /^\d+$/.test(offset) ? Number(offset) : -1, chunk);   // -1 never fits: the answer is 409
  });

  router.add('DELETE', '/api/upload/:id', async (ctx) => {
    const user = requireUser(ctx);
    await cancelUpload(app, user, ctx.params.id);
    return { ok: true };
  });
}

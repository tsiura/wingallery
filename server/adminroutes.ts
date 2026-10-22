// The administrator's endpoints: users, their passwords and shares, and the folder picker. Each handler starts with requireAdmin,
// before it looks at the id, the body or anything else; every change is logged with the administrator who made it (R3).

import type { AdminUser } from '../shared/types.ts';
import type { App } from './app.ts';
import { requireAdmin } from './auth.ts';
import { HttpError, readObject, str } from './http.ts';
import type { Ctx } from './http.ts';
import { log } from './log.ts';
import { addShare, browseDisk, getShare, listShareInfo, removeShare, updateShare } from './shares.ts';
import type { ShareInput, SharePatch } from './shares.ts';
import { createUser, getAdminUser, listUsers, removeUser, setPassword, updateUser } from './users.ts';
import type { UserPatch } from './users.ts';
import type { ShareRow } from './vpath.ts';

// These bodies are a few short fields, so a small cap keeps them from buffering megabytes.
const BODY_LIMIT = 8 * 1024;
const notFound = () => new HttpError(404, 'Not found');

// The router has %-decoded the id, so "1%2F2" arrives as "1/2". An id is a positive integer in plain digits; anything else names no one.
function idParam(ctx: Ctx): number {
  const id = Number(ctx.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || String(id) !== ctx.params.id) throw notFound();
  return id;
}

export function registerAdminRoutes(app: App): void {
  const { cfg, db, router } = app;

  function targetUser(id: number): AdminUser {
    const user = getAdminUser(db, id);
    if (!user) throw notFound();
    return user;
  }

  // What the audit line of a share event says about the share: whose it is, and what it is now.
  const shareFields = (s: ShareRow) =>
    ({ id: s.id, username: getAdminUser(db, s.userId)?.username, alias: s.alias, relPath: s.relPath, create: s.create, update: s.update, delete: s.delete });

  router.add('GET', '/api/admin/users', (ctx) => {
    requireAdmin(ctx);
    return listUsers(db);
  });

  router.add('POST', '/api/admin/users', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readObject(ctx, BODY_LIMIT);
    const { id, username, displayName, role } = await createUser(db, {
      username: str(body.username), displayName: str(body.displayName), password: str(body.password), role: body.role === 'admin' ? 'admin' : 'member',
    });
    log('user_created', { id, username, role, by: admin.username, ip: ctx.ip });
    return { id, username, displayName, role };
  });

  router.add('PATCH', '/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const body = await readObject(ctx, BODY_LIMIT);
    const user = updateUser(db, admin, id, { username: body.username, displayName: body.displayName, role: body.role } as UserPatch);   // updateUser checks the types
    log('user_updated', { id, username: user.username, role: user.role, by: admin.username, ip: ctx.ip });
    return user;
  });

  // A password set here ends every session of that user, an administrator's own included; one's own password is changed from the account screen.
  router.add('POST', '/api/admin/users/:id/password', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const body = await readObject(ctx, BODY_LIMIT);
    const user = targetUser(id);
    await setPassword(db, id, str(body.password));
    log('password_set', { username: user.username, by: admin.username, ip: ctx.ip });
    return { ok: true };
  });

  router.add('DELETE', '/api/admin/users/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const user = targetUser(id);   // read before the removal: the name is gone after it
    await removeUser(db, admin, id);
    log('user_removed', { id, username: user.username, by: admin.username, ip: ctx.ip });
    return { ok: true };
  });

  router.add('GET', '/api/admin/users/:id/shares', (ctx) => {
    requireAdmin(ctx);
    const id = idParam(ctx);
    targetUser(id);
    return listShareInfo(cfg, db, id);
  });

  router.add('POST', '/api/admin/users/:id/shares', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const body = await readObject(ctx, BODY_LIMIT);
    const share = await addShare(cfg, db, admin, id,
      { relPath: body.relPath, alias: body.alias, create: body.create, update: body.update, delete: body.delete } as ShareInput);   // addShare checks the types
    log('share_added', { ...shareFields(share), by: admin.username, ip: ctx.ip });
    return share;
  });

  router.add('PATCH', '/api/admin/shares/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const body = await readObject(ctx, BODY_LIMIT);
    const share = await updateShare(cfg, db, id, { alias: body.alias, create: body.create, update: body.update, delete: body.delete } as SharePatch);   // updateShare checks the types
    log('share_updated', { ...shareFields(share), by: admin.username, ip: ctx.ip });
    return share;
  });

  router.add('DELETE', '/api/admin/shares/:id', (ctx) => {
    const admin = requireAdmin(ctx);
    const id = idParam(ctx);
    const share = getShare(db, id);
    if (!share) throw notFound();
    removeShare(db, id);
    log('share_removed', { ...shareFields(share), by: admin.username, ip: ctx.ip });
    return { ok: true };
  });

  router.add('GET', '/api/admin/browse', (ctx) => browseDisk(cfg, requireAdmin(ctx), ctx.url.searchParams.get('path') ?? ''));
}

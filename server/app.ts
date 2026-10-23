import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { registerAdminRoutes } from './adminroutes.ts';
import { LoginLimiter, SESSION_COOKIE, sessionCookie, touchSession } from './auth.ts';
import { registerAuthRoutes } from './authroutes.ts';
import { registerBrowseRoutes } from './browseroutes.ts';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { registerFileRoutes } from './fileroutes.ts';
import { HttpError, Router, clientInfo, parseCookies, securityHeaders, sendJson } from './http.ts';
import type { Ctx } from './http.ts';
import { log } from './log.ts';
import { registerMediaRoutes } from './mediaroutes.ts';
import { photoPool } from './meta.ts';
import { serveWeb } from './static.ts';
import { createThumbnailer } from './thumbs.ts';
import type { Thumbnailer } from './thumbs.ts';
import { countUsers } from './users.ts';

// setupToken is the first-run link: set when the database has no users, cleared once the administrator exists.
export interface App { cfg: Config; db: DB; router: Router; limiter: LoginLimiter; thumbs: Thumbnailer; server: Server; setupToken: string | null; close(): Promise<void> }

function fail(res: ServerResponse, err: unknown): void {
  const known = err instanceof HttpError;
  if (!known) log('error', { message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();   // a half-sent body can't be fixed up, only cut off
    return;
  }
  // The body of a rejected request may be unread. Connection: close lets Node drop it once this response is out;
  // destroying the request first would kill the socket before the client sees the 413.
  if (known && err.status === 413) res.setHeader('Connection', 'close');
  sendJson(res, known ? err.status : 500, { error: known ? err.message : 'Something went wrong' });
}

// Does not listen. close() also closes the database it was given.
export function createApp(cfg: Config, db: DB): App {
  const router = new Router();
  const limiter = new LoginLimiter();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const info = clientInfo(req, cfg.trustedProxies);
      securityHeaders(res, info.https);
      // Origin-form targets only. Gluing the target onto a fixed base (instead of resolving it against one)
      // keeps `//x` from being read as a host.
      if (!req.url?.startsWith('/')) throw new HttpError(400, 'Invalid path');
      const url = new URL('http://localhost' + req.url);
      const ctx: Ctx = { req, res, url, params: {}, ip: info.ip, https: info.https, origin: info.origin, user: null, token: null };

      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }

      // CSRF: anything but a read must say it comes from this very site, so a request without an Origin is refused too.
      // ctx.origin is built from the forwarded headers only when the socket is a trusted proxy (clientInfo).
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== ctx.origin)
        throw new HttpError(403, "Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES.");

      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const session = token ? touchSession(db, token) : null;
      if (token && session) {
        ctx.user = session.user;
        ctx.token = token;
        if (session.refreshed) res.setHeader('Set-Cookie', sessionCookie(token, true, cfg.cookieSecure));   // keeps the 30 days sliding
      }

      const found = router.match(req.method ?? 'GET', url.pathname);
      if (found === null) {
        await serveWeb(ctx, cfg);   // the web app's page and files; it answers 404 for whatever isn't a read outside /api and /media
        return;
      }
      if (found === 'method') throw new HttpError(405, 'Method not allowed');
      ctx.params = found.params;
      const out = await found.handler(ctx);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (err) {
      fail(res, err);
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  let closing: Promise<void> | undefined;
  const app: App = {
    cfg, db, router, limiter, thumbs: createThumbnailer(cfg), server,
    setupToken: countUsers(db) === 0 ? randomBytes(24).toString('base64url') : null,
    close: () => closing ??= new Promise<void>((resolve) => {
      // stops accepting and drops idle keep-alive sockets; requests in flight finish first, and then the photo workers that are idle end too
      server.close(() => { db.close(); void photoPool.stop().then(() => resolve()); });
    }),
  };
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerBrowseRoutes(app);
  registerFileRoutes(app);
  registerMediaRoutes(app);
  return app;
}

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { HttpError, Router, clientInfo, securityHeaders, sendJson } from './http.ts';
import type { Ctx } from './http.ts';
import { log } from './log.ts';

export interface App { cfg: Config; db: DB; router: Router; server: Server; close(): Promise<void> }

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

      const found = router.match(req.method ?? 'GET', url.pathname);
      if (found === null) throw new HttpError(404, 'Not found');
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
  return {
    cfg, db, router, server,
    close: () => closing ??= new Promise<void>((resolve) => {
      // stops accepting and drops idle keep-alive sockets; requests in flight finish first
      server.close(() => { db.close(); resolve(); });
    }),
  };
}

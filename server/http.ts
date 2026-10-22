import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { BlockList } from 'node:net';
import type { Me } from '../shared/types.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>;
  ip: string; https: boolean; origin: string; user: Me | null; token: string | null;
}
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route { method: string; segs: string[]; handler: Handler }
type Match = { handler: Handler; params: Record<string, string> };

// Binds the pattern's `:name` segments, decoded. Null when the path doesn't fit.
function bind(segs: string[], parts: string[]): Record<string, string> | null {
  if (segs.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].startsWith(':')) {
      if (segs[i] !== parts[i]) return null;
    } else if (!parts[i]) {
      return null;
    } else {
      try { params[segs[i].slice(1)] = decodeURIComponent(parts[i]); } catch { return null; }   // bad %-escape
    }
  }
  return params;
}

// The first route registered that fits wins.
export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, h: Handler): void {
    this.#routes.push({ method, segs: pattern.split('/'), handler: h });
  }

  // 'method' = the path exists, but not for this method. HEAD falls back to the GET route.
  match(method: string, pathname: string): Match | 'method' | null {
    const parts = pathname.split('/');
    let known = false;
    let viaGet: Match | undefined;
    for (const r of this.#routes) {
      const params = bind(r.segs, parts);
      if (!params) continue;
      known = true;
      if (r.method === method) return { handler: r.handler, params };
      if (method === 'HEAD' && r.method === 'GET') viaGet ??= { handler: r.handler, params };
    }
    return viaGet ?? (known ? 'method' : null);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

const EXPECTED: Record<string, string> = {
  'application/json': 'Expected JSON',
  'application/octet-stream': 'Expected binary data',
  'application/x-www-form-urlencoded': 'Expected form data',
};

export async function readBody(ctx: Ctx, limit: number, contentType: string, tooLarge = 'Request too large'): Promise<Buffer> {
  const type = (ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== contentType) throw new HttpError(415, EXPECTED[contentType] ?? `Expected ${contentType}`);
  const chunks: Buffer[] = [];
  let size = 0;
  // Bailing out must leave the request alone: destroying it kills the socket and the client never sees the 413.
  // The error response sets Connection: close, which makes Node drop whatever is left unread.
  for await (const chunk of ctx.req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(ctx: Ctx, limit = 1_000_000): Promise<T> {
  const body = await readBody(ctx, limit, 'application/json');
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export async function readForm(ctx: Ctx, limit = 1_000_000): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(ctx, limit, 'application/x-www-form-urlencoded')).toString('utf8'));
}

// Request bodies are JSON, so a field typed string can be anything (G6): whatever is not a string counts as ''.
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
  + "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function securityHeaders(res: ServerResponse, https: boolean): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const unmap = (addr: string) => addr.replace(/^::ffff:/i, '');

function isTrusted(trusted: BlockList, addr: string): boolean {
  const version = isIP(addr);
  return version !== 0 && trusted.check(addr, version === 4 ? 'ipv4' : 'ipv6');
}

// Comma-separated header (Node joins repeats) -> trimmed, non-empty values.
function values(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v.join(',') : v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// X-Forwarded-* count only when the socket peer is a trusted proxy.
export function clientInfo(req: IncomingMessage, trusted: BlockList): { ip: string; https: boolean; host: string; origin: string } {
  const peer = unmap(req.socket.remoteAddress ?? '');
  let ip = peer;
  let https = false;
  let host = req.headers.host ?? '';
  if (isTrusted(trusted, peer)) {
    const hops = values(req.headers['x-forwarded-for']).map(unmap);
    ip = hops.findLast((h) => !isTrusted(trusted, h)) ?? hops[0] ?? peer;
    https = values(req.headers['x-forwarded-proto'])[0]?.toLowerCase() === 'https';
    host = values(req.headers['x-forwarded-host'])[0] ?? host;
  }
  return { ip, https, host, origin: `${https ? 'https' : 'http'}://${host}` };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    if (eq > 0 && name && !Object.hasOwn(out, name)) out[name] = part.slice(eq + 1).trim();   // first one wins
  }
  return out;
}

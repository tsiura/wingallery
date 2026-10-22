import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { BlockList } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import type { App } from '../app.ts';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import type { DB } from '../db.ts';

const dirs: string[] = [];
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// A fresh directory, removed when the test process exits.
export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hg-')));
  dirs.push(dir);
  return dir;
}

// True when `cmd` can be started from PATH, so a test of an external tool (libvips, ffmpeg) can skip itself.
export function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ['-version'], { stdio: 'ignore' }).error === undefined;
}

// Absolute path of a file in server/test/fixtures.
export function fixture(name: string): string {
  return join(import.meta.dirname, 'fixtures', name);
}

export function testConfig(over: Partial<Config> & { mediaRoot: string; dataDir: string }): Config {
  const trustedProxies = new BlockList();
  trustedProxies.addAddress('127.0.0.1', 'ipv4');
  trustedProxies.addAddress('::1', 'ipv6');
  return {
    port: 0, cookieSecure: false, maxUploadBytes: 50 * 1024 * 1024, trashDays: 30, trustedProxies,
    webDist: join(over.dataDir, 'web-dist'),
    ...over,
  };
}

export interface Client {
  cookie: string | null;
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
}

export interface TestApp {
  url: string; app: App; cfg: Config; db: DB; media: string;
  client(cookie?: string | null): Client;
  close(): Promise<void>;
}

const isJsonBody = (b: unknown) =>
  b !== null && typeof b === 'object' && (Array.isArray(b) || Object.getPrototypeOf(b) === Object.prototype);

function makeClient(url: string, cookie: string | null): Client {
  const client: Client = {
    cookie,
    async req(method, path, body, headers = {}) {
      const h = new Headers(headers);
      if (method !== 'GET' && !h.has('origin')) h.set('origin', url);
      if (client.cookie && !h.has('cookie')) h.set('cookie', client.cookie);
      let payload = body as BodyInit | undefined;
      if (isJsonBody(body)) {
        payload = JSON.stringify(body);
        if (!h.has('content-type')) h.set('content-type', 'application/json');
      }
      return fetch(url + path, { method, headers: h, body: payload });
    },
    async json(method, path, body) {
      const r = await client.req(method, path, body);
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
  return client;
}

// Listens on 127.0.0.1, port 0. Fresh media and data dirs unless `over` names them.
export async function startTestApp(over: Partial<Config> = {}): Promise<TestApp> {
  const mediaRoot = over.mediaRoot ?? await tempDir();
  const dataDir = over.dataDir ?? await tempDir();
  const cfg = testConfig({ ...over, mediaRoot, dataDir });
  const db = openDb(join(dataDir, 'gallery.db'));
  const app = createApp(cfg, db);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    url, app, cfg, db, media: cfg.mediaRoot,
    client: (cookie = null) => makeClient(url, cookie),
    async close() {
      app.server.closeAllConnections();   // a test that left a response unread must not hang the run
      await app.close();
    },
  };
}

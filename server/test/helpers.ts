import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { BlockList } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Role } from '../../shared/types.ts';
import { createApp } from '../app.ts';
import type { App } from '../app.ts';
import type { Config } from '../config.ts';
import { openDb } from '../db.ts';
import type { DB } from '../db.ts';
import { createUser } from '../users.ts';

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

// Builds a media tree under `root`. A name ending in `/` is a folder; any other is a file holding a real photo (exif-rot6.jpg for a name
// ending in .jpg, plain.png for the rest). `links` are [target, at] pairs, as symlink(target, at) takes them, with `at` relative to `root`.
export async function seedTree(root: string, files: string[], links: [string, string][] = []): Promise<void> {
  const [png, jpg] = await Promise.all([readFile(fixture('plain.png')), readFile(fixture('exif-rot6.jpg'))]);
  for (const f of files) {
    const abs = join(root, f);
    await mkdir(f.endsWith('/') ? abs : dirname(abs), { recursive: true });
    if (!f.endsWith('/')) await writeFile(abs, f.endsWith('.jpg') ? jpg : png);
  }
  for (const [target, at] of links) await symlink(target, join(root, at));
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
  addUser(username: string, role: Role, password?: string): Promise<{ id: number; client: Client }>;   // created directly, then signed in through the API
  login(username: string, password: string): Promise<Client>;                                          // a new session each time; throws when refused
  admin(): Promise<Client>;                                                                            // the administrator `root`, made on first use
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

// Signing in is set-up in the helpers, so the server's `login` audit line is kept out of the test output (a test that wants audit lines mocks console.log itself).
// The first login in flight takes console.log away and the last one to finish gives it back, so logins that overlap, in one app or in several, restore it once.
// ponytail: this swaps the global console.log; give log() a sink of its own if a test ever needs these lines.
let signingIn = 0, printed = console.log;

// Listens on 127.0.0.1, port 0. Fresh media and data dirs unless `over` names them.
export async function startTestApp(over: Partial<Config> = {}): Promise<TestApp> {
  const mediaRoot = over.mediaRoot ?? await tempDir();
  const dataDir = over.dataDir ?? await tempDir();
  const cfg = testConfig({ ...over, mediaRoot, dataDir });
  const db = openDb(join(dataDir, 'gallery.db'));
  const app = createApp(cfg, db);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function login(username: string, password: string): Promise<Client> {
    if (signingIn++ === 0) { printed = console.log; console.log = () => {}; }
    try {
      const r = await makeClient(url, null).req('POST', '/api/login', { username, password, remember: true });
      if (r.status !== 200) throw new Error(`login as ${username} was refused: ${r.status} ${await r.text()}`);
      return makeClient(url, r.headers.getSetCookie()[0].split(';')[0]);
    } finally {
      if (--signingIn === 0) console.log = printed;
    }
  }
  async function addUser(username: string, role: Role, password = 'password123') {
    const me = await createUser(db, { username, displayName: username, password, role });
    return { id: me.id, client: await login(me.username, password) };
  }
  let admin: Promise<Client> | undefined;
  return {
    url, app, cfg, db, media: cfg.mediaRoot,
    client: (cookie = null) => makeClient(url, cookie),
    addUser, login,
    admin: () => admin ??= addUser('root', 'admin').then((u) => u.client),
    async close() {
      app.server.closeAllConnections();   // a test that left a response unread must not hang the run
      await app.close();
    },
  };
}

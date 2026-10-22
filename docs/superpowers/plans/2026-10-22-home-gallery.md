# Home Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, Windows-Explorer-style photo/video gallery. The admin shares disk folders with users under aliases with inherited Create/Read/Update/Delete rights. It runs as one Docker container behind Traefik.

**Architecture:** A Node 24 TypeScript server runs directly with Node's type stripping (no build step) on plain `node:http` with a tiny router. It keeps users, shares, sessions, trash and metadata in SQLite (`node:sqlite`). It resolves every client path through one virtual-path resolver (`server/vpath.ts`) that maps `/<alias>/<sub>` to disk and enforces rights. libvips and ffmpeg run as subprocesses for thumbnails, HEIC conversion and video metadata. The React SPA (Vite) is served by the same process and ports the design in `docs/design/Gallery Explorer.dc.html`.

**Tech Stack:** Node.js 24 (`node:http`, `node:sqlite`, `crypto.argon2`, `node:test`), TypeScript 7 (type-check only), React 19, Vite 8, yazl 3, exifr 7, image-size 2, libvips 8.16 (+ libheif HEVC plugin), ffmpeg 7.1, Debian trixie.

**Spec:** `docs/superpowers/specs/2026-10-22-home-gallery-design.md` (approved). Visual source of truth: `docs/design/Gallery Explorer.dc.html`.
- That file is a template: `{{ x }}` interpolations, `<sc-if value>` and `<sc-for list as>`.
- Its values come from `renderVals()` and `settingsVals()` in the `<script>` block, lines 475–762.
- Section line ranges:

  | Section | Lines |
  |---|---|
  | keyframes `<style>` | 10–22 |
  | Title bar | 25–55 |
  | Command bar | 56–83 |
  | Sidebar | 86–100 |
  | Toolbar | 103–136 |
  | Items | 137–207 |
  | Status bar | 208–215 |
  | Slideshow config modal | 216–268 |
  | Settings | 269–444 |
  | Slideshow player | 445–473 |

- Access-model mockup: `docs/design/access-model-mockup.html`.

## Global Constraints

- Runtime: Node 24. The Docker base is `node:24.22.1-trixie-slim`; local dev needs Node ≥ 24.7 (`crypto.argon2`). Start Node with `--disable-warning=ExperimentalWarning`.
- TypeScript is executed by Node type stripping. So:
  - Only erasable syntax: no `enum`, `namespace` or constructor parameter properties.
  - Relative imports carry the `.ts`/`.tsx` extension.
  - Type-only imports use `import type`.
  - `tsc --noEmit` is the type check; there is no emit step for the server.
- Allowed runtime deps:
  - Server: `yazl@3`, `exifr@7`, `image-size@2`.
  - Web: `react@19`, `react-dom@19`.
  - Dev: `vite@8`, `@vitejs/plugin-react@6`, `typescript@7`, `@types/react@19`, `@types/react-dom@19`, `@types/node@24`, `@types/yazl@3`.
  - Anything else needs a written reason in the task's commit message.
- Tests use only `node --test` with `node:test` + `node:assert/strict`. Test files are `*.test.ts` and must not import `.tsx`.
- Env vars and defaults:
  - `MEDIA_ROOT=/media`, `DATA_DIR=/data`, `PORT=8080`
  - `TRUSTED_PROXIES=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7`
  - `COOKIE_SECURE=true` (only the literal `false` disables it)
  - `MAX_UPLOAD_MB=10240`, `TRASH_DAYS=30`
  - `WEB_DIST` defaults to `<repo>/web/dist`.
- Media types, matched case-insensitively by extension:
  - Photos: `.jpg .jpeg .png .webp .gif .heic .heif`
  - Videos: `.mp4 .m4v .mov .webm`
  - Anything else is invisible.
- Hidden names are matched case-insensitively and are never listed, counted, zipped or served:
  - any name starting with `.`
  - `@eaDir`, `#recycle`, `#snapshot`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`, `Thumbs.db`, `desktop.ini`
  - Symlinks are never listed.
- Paths: every endpoint that touches files resolves the client path with `resolve()` / `locate()` from `server/vpath.ts`. Members never send or receive disk paths.
- Sessions:
  - Cookie `hg_session`: HttpOnly, SameSite=Lax, Path=/, plus `Secure` when `COOKIE_SECURE`.
  - "Remember me" means `Max-Age=2592000` (30 days, sliding). Otherwise a browser-session cookie with 12 h idle expiry.
  - Passwords: argon2id `m=19456,t=2,p=1`, minimum 8 chars.
- Brute force:
  - 5 failures for a username lock it for 15 min.
  - 20 failures from one IP within 15 min block that IP until the window frees.
- State-changing requests:
  - Must be non-GET with `Origin` equal to `${proto}://${host}`.
  - JSON bodies require `application/json`; upload chunks `application/octet-stream`; the zip form `application/x-www-form-urlencoded`.
- Thumbnails are at most 480×480 JPEG Q80. HEIC/HEIF previews are at most 2560×2560 JPEG Q85. The cache lives only under `${DATA_DIR}/cache`; nothing is ever written next to media.
- Uploads:
  - The client sends 8 MiB chunks; the server rejects chunks over 16 MiB.
  - Temp file is `.upload-<id>` in the target folder; stale after 24 h.
  - Never overwrite: a collision becomes `name (1).ext`, `name (2).ext`, …
- Recycle Bin: `<MEDIA_ROOT>/<top-level>/.gallery-trash/<id>/<name>`. Admin-only list, restore and purge; auto-purge after `TRASH_DAYS`.
- Recursive slideshow lists are capped at 5000 items.
- UI copy is English; the look follows the design (`Segoe UI Variable Text` → `system-ui`, accent `#005fb8`, background `#eef1f5`). No external requests: no CDN, fonts or analytics.
- Security headers on every response, exactly:
  - `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: same-origin`
  - `X-Frame-Options: DENY`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - When the request arrived via HTTPS: `Strict-Transport-Security: max-age=31536000`.
- Audit log: one JSON line per event on stdout via `log(event, fields)`. Events:
  - `login`, `login_failed`, `logout`, `setup`
  - `user_created`, `user_updated`, `user_removed`, `password_set`
  - `share_added`, `share_updated`, `share_removed`
  - `mkdir`, `rename`, `move`, `delete`, `restore`, `purge`, `upload`

**Pinned error messages.** The server returns `{ "error": "<message>" }`; tests assert these exact strings.

| Status | Message |
|---|---|
| 400 | `Invalid path` · `Invalid JSON` · `Password must be at least 8 characters` · `Username must be 2–32 characters: lowercase letters, digits, dot, dash or underscore` · `Current password is wrong` · `Pick a folder inside the media folder` · `File extension can't be changed` · `Items can only be moved within the same shared folder` · `Can't move a folder into itself` · `File is empty` · `Upload is larger than declared` · `Invalid preferences` · `Not a media file` · plus the `validateName` messages from Task 3 |
| 401 | `Sign in required` · `Wrong username or password` |
| 403 | `Administrators only` · `You don't have permission to do that` · `This folder can't be renamed, moved or deleted` · `Invalid setup link` · `You can't change your own role` · `You can't remove yourself` · `Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES.` |
| 404 | `Not found` |
| 405 | `Method not allowed` |
| 409 | `That username is taken` · `This user already has a folder named "<alias>"` · `This folder is already shared with this user` · `A file or folder with that name already exists` · `This folder is read-only on disk` · `Already set up` · `Upload out of sync` |
| 413 | `Request too large` · `Chunk too large` · `File is larger than the <N> MB limit` |
| 415 | `Expected JSON` · `Expected binary data` · `Expected form data` · `Only photos and videos can be uploaded` · `File content doesn't match its type` |
| 422 | `No preview available` |
| 429 | `Too many attempts, try again in <N> minutes` |
| 500 | `Something went wrong` |
| 507 | `Disk is full` |

## Review Focus

1. **Non-ASCII and URL-special names** (`Дача #2 (2024)/IMG 50%.jpg`) must round-trip through browse URLs, `/media/download` `Content-Disposition` (RFC 5987 `filename*`) and zip entry names. Tests are pinned in Tasks 6, 8, 9 and 13.
2. **Corrupt or odd media** (a `.jpg` that isn't a JPEG, a photo without EXIF) must not break a folder listing. Fields fall back to `null` / mtime, and the thumbnail endpoint answers 422 so the UI can show an icon. Tests in Tasks 8 and 9.
3. **Read-only folders on disk** (a `:ro` mount, chmod 555) show all rights as false in the listing, and mutations answer 409 `This folder is read-only on disk` instead of 500. Tests in Tasks 8 and 10; skipped when running as root.
4. **Proxy misconfiguration.** A request carrying `X-Forwarded-*` from an IP outside `TRUSTED_PROXIES` must be refused with the TRUSTED_PROXIES hint, not with an opaque error. The same request from a trusted proxy passes and gets HSTS. Test in Task 4.
5. **Two people uploading the same file name at the same time** both succeed as `b.jpg` and `b (1).jpg`, and nothing is overwritten. Test in Task 12.

---

### Task 1: Project scaffold, config, DB, HTTP core

**Files:**
- Create: `package.json`, `tsconfig.json`, `shared/types.ts`, `server/config.ts`, `server/db.ts`, `server/log.ts`, `server/http.ts`, `server/app.ts`, `server/main.ts`, `server/test/helpers.ts`, `server/test/core.test.ts`
- Modify: `.gitignore` (append `dev-data/`)

**Interfaces:**
- Produces:
  - `shared/types.ts` holds all API types (exact; later tasks import them):
    ```ts
    export type Role = 'admin' | 'member';
    export type ViewMode = 'large' | 'medium' | 'details';
    export interface Prefs { defaultView: ViewMode; slideSeconds: number }          // defaults { 'large', 5 }
    export interface Me { id: number; username: string; displayName: string; role: Role; prefs: Prefs }
    export interface SessionInfo { user: Me | null; setupRequired: boolean }
    export interface Rights { create: boolean; update: boolean; delete: boolean }   // read is implied
    export type MediaKind = 'photo' | 'video';
    export interface FolderEntry { kind: 'folder'; name: string; mtime: number; count: number; cover: string | null; protected: boolean; unavailable?: boolean }
    export interface FileEntry { kind: MediaKind; name: string; size: number; mtime: number; takenAt: string; width: number | null; height: number | null; duration: number | null; type: string }
    export type Entry = FolderEntry | FileEntry;
    export interface Listing { path: string; name: string; rights: Rights; entries: Entry[] }
    export interface FolderNode { name: string; count: number; hasChildren: boolean; unavailable?: boolean }
    export interface Meta { width: number | null; height: number | null; takenAt: string; duration: number | null }
    export interface SlideItem { path: string; kind: MediaKind; name: string; mtime: number }
    export interface AdminUser { id: number; username: string; displayName: string; role: Role }
    export interface ShareInfo { id: number; userId: number; alias: string; relPath: string; diskPath: string; create: boolean; update: boolean; delete: boolean; available: boolean }
    export interface TrashItem { id: string; name: string; originalPath: string; isDir: boolean; size: number; hiddenFiles: number; deletedBy: string; deletedAt: number }
    export interface DeletePreview { items: number; hiddenFiles: number }
    ```
    `takenAt` is a zone-less wall-clock string `YYYY-MM-DDTHH:mm:ss`. `mtime` is epoch ms. `cover` is a virtual path.
  - `server/config.ts`: `interface Config { mediaRoot: string; dataDir: string; port: number; trustedProxies: BlockList; cookieSecure: boolean; maxUploadBytes: number; trashDays: number; webDist: string }`; `loadConfig(env?: NodeJS.ProcessEnv): Config`.
  - `server/db.ts`: `type DB = DatabaseSync`; `openDb(file: string): DB`.
  - `server/log.ts`: `log(event: string, fields?: Record<string, unknown>): void`. Prints `JSON.stringify({ t: ISO time, event, ...fields })`.
  - `server/http.ts`:
    - `class HttpError extends Error { status: number }`, constructed as `new HttpError(status, message)`.
    - `interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; ip: string; https: boolean; origin: string; user: Me | null; token: string | null }`
    - `type Handler = (ctx: Ctx) => unknown | Promise<unknown>`. A non-undefined return value is sent as JSON 200 unless the response already started.
    - `class Router { add(method: string, pattern: string, h: Handler): void; match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null }`. Patterns are `/`-segments; `:name` captures one decoded segment.
    - `sendJson(res, status, body)`, `readJson<T>(ctx, limit = 1_000_000): Promise<T>`, `readBody(ctx, limit: number, contentType: string): Promise<Buffer>`, `readForm(ctx, limit = 1_000_000): Promise<URLSearchParams>`
    - `securityHeaders(res, https: boolean)`, `clientInfo(req, trusted: BlockList): { ip: string; https: boolean; host: string; origin: string }`, `parseCookies(header: string | undefined): Record<string, string>`
  - `server/app.ts`: `interface App { cfg: Config; db: DB; router: Router; server: http.Server; close(): Promise<void> }`; `createApp(cfg: Config, db: DB): App` (does not listen).
  - `server/test/helpers.ts`:
    - `tempDir(): Promise<string>`
    - `testConfig(over: Partial<Config> & { mediaRoot: string; dataDir: string }): Config` with defaults `cookieSecure: false`, `port: 0`, `maxUploadBytes: 50 MiB`, `trashDays: 30`, trusted `127.0.0.1` + `::1`.
    - `startTestApp(over?: Partial<Config>): Promise<TestApp>` creates temp media/data dirs and listens on port 0; `url` is `http://127.0.0.1:<port>`, so the `Host`-derived origin matches the `Origin` the client sends.
    - `interface TestApp { url: string; app: App; cfg: Config; db: DB; media: string; client(cookie?: string | null): Client; close(): Promise<void> }`
    - `interface Client { cookie: string | null; req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>; json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> }`. `req` sends `Origin: <url>` on non-GET, the cookie if set, and JSON-encodes plain-object bodies with `application/json`.

- [ ] **Step 1: Install and configure**

```bash
npm init -y && npm pkg set type=module private=true name=home-gallery
npm i yazl@3 exifr@7 image-size@2 react@19 react-dom@19
npm i -D typescript@7 @types/node@24 @types/yazl@3 @types/react@19 @types/react-dom@19 vite@8 @vitejs/plugin-react@6
npm pkg set scripts.test="node --disable-warning=ExperimentalWarning --test" scripts.typecheck="tsc --noEmit" scripts.start="node --disable-warning=ExperimentalWarning server/main.ts"
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx",
    "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["node"],
    "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true
  },
  "include": ["server", "shared", "web/src", "vite.config.ts"]
}
```

- [ ] **Step 2: Write the failing tests** in `server/test/core.test.ts`

```ts
test('loadConfig defaults', () => {
  const c = loadConfig({});
  assert.equal(c.mediaRoot, '/media'); assert.equal(c.dataDir, '/data'); assert.equal(c.port, 8080);
  assert.equal(c.cookieSecure, true); assert.equal(c.maxUploadBytes, 10240 * 1024 * 1024); assert.equal(c.trashDays, 30);
  assert.equal(c.trustedProxies.check('172.18.0.2', 'ipv4'), true);
  assert.equal(c.trustedProxies.check('8.8.8.8', 'ipv4'), false);
});
test('loadConfig overrides', () => {
  const c = loadConfig({ MEDIA_ROOT: '/m', DATA_DIR: '/d', PORT: '9', COOKIE_SECURE: 'false', MAX_UPLOAD_MB: '5', TRASH_DAYS: '7', TRUSTED_PROXIES: '203.0.113.7' });
  assert.deepEqual([c.mediaRoot, c.dataDir, c.port, c.cookieSecure, c.maxUploadBytes, c.trashDays], ['/m', '/d', 9, false, 5 * 1024 * 1024, 7]);
  assert.equal(c.trustedProxies.check('203.0.113.7', 'ipv4'), true);
});
test('loadConfig rejects bad TRUSTED_PROXIES', () =>
  assert.throws(() => loadConfig({ TRUSTED_PROXIES: 'nope' }), /Invalid TRUSTED_PROXIES entry: nope/));
test('openDb migrates once', async () => {
  const f = join(await tempDir(), 'g.db');
  const db = openDb(f);
  for (const t of ['users', 'shares', 'sessions', 'trash', 'media_meta', 'uploads'])
    assert.ok(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(t), t);
  db.close();
  assert.equal((openDb(f).prepare('pragma user_version').get() as any).user_version, 1);
});
test('healthz + security headers', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const r = await fetch(ta.url + '/healthz');
  assert.equal(r.status, 200); assert.equal(await r.text(), 'ok');
  assert.match(r.headers.get('content-security-policy')!, /^default-src 'self'; img-src 'self' blob: data:;/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('strict-transport-security'), null);
});
test('router: params, 404, 405, errors, readJson', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const r = ta.app.router;
  r.add('GET', '/api/x/:id', (c) => ({ id: c.params.id }));
  r.add('GET', '/api/boom', () => { throw new Error('x'); });
  r.add('GET', '/api/teapot', () => { throw new HttpError(418, 'short and stout'); });
  r.add('POST', '/api/echo', async (c) => readJson(c));
  const c = ta.client();
  assert.deepEqual((await c.json('GET', '/api/x/a%20b')).body, { id: 'a b' });
  assert.deepEqual(await c.json('GET', '/api/nope'), { status: 404, body: { error: 'Not found' } });
  assert.deepEqual(await c.json('DELETE', '/api/x/1'), { status: 405, body: { error: 'Method not allowed' } });
  assert.deepEqual(await c.json('GET', '/api/boom'), { status: 500, body: { error: 'Something went wrong' } });
  assert.deepEqual(await c.json('GET', '/api/teapot'), { status: 418, body: { error: 'short and stout' } });
  assert.equal((await c.req('POST', '/api/echo', 'hi', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await c.req('POST', '/api/echo', '{bad', { 'content-type': 'application/json' })).status, 400);
  assert.equal((await c.req('POST', '/api/echo', 'x'.repeat(1_000_001), { 'content-type': 'application/json' })).status, 413);
  assert.deepEqual((await c.json('POST', '/api/echo', { a: 1 })).body, { a: 1 });
});
```

- [ ] **Step 3: Run tests, expect failure**

Run: `npm test`
Expected: FAIL, cannot find module `../config.ts` (and others).

- [ ] **Step 4: Implement**
  - `server/config.ts` per the Interfaces block and the Global Constraints defaults. `TRUSTED_PROXIES` entries are CIDR (`addSubnet`) or bare IP (`addAddress`), IPv4 or IPv6 by `net.isIP`.
  - `server/db.ts`: `openDb` sets `PRAGMA foreign_keys=ON`, `busy_timeout=5000`, and `journal_mode=WAL` when the file isn't `:memory:`. It applies `MIGRATIONS[i]` for `i >= user_version` inside a transaction, then sets `user_version`. Migration 1, exactly:
    ```sql
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','member')), password_hash TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE TABLE shares (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias TEXT NOT NULL COLLATE NOCASE, rel_path TEXT NOT NULL, can_create INTEGER NOT NULL DEFAULT 0, can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0, UNIQUE (user_id, alias), UNIQUE (user_id, rel_path));
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remember INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
    CREATE TABLE trash (id TEXT PRIMARY KEY, top_rel TEXT NOT NULL, original_rel TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER NOT NULL,
      hidden_files INTEGER NOT NULL, deleted_by TEXT NOT NULL, deleted_at INTEGER NOT NULL);
    CREATE TABLE media_meta (rel_path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, width INTEGER, height INTEGER,
      taken_at TEXT NOT NULL, duration_s REAL);
    CREATE TABLE uploads (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, dir_abs TEXT NOT NULL,
      temp_abs TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    ```
  - `server/http.ts`:
    - Write `HttpError`'s `status` as an explicit field (not a parameter property).
    - `clientInfo`: strip a `::ffff:` prefix from `req.socket.remoteAddress`. If that address is trusted: ip = the rightmost `X-Forwarded-For` entry that is not trusted (the leftmost if all are), `https` = first `X-Forwarded-Proto` value is `https`, host = first `X-Forwarded-Host` value or `Host`. Otherwise: ip = the socket address, `https = false`, host = `Host`. `origin = (https ? 'https' : 'http') + '://' + host`.
    - Body readers reject on the wrong content type (415, messages per table) and over the limit (413 `Request too large`, destroying the stream).
  - `server/app.ts`, request pipeline in order:
    1. Run `clientInfo`, then `securityHeaders`.
    2. `GET /healthz` → `ok` (text/plain).
    3. Router match → handler. `'method'` → 405. No match → 404 JSON (any path in Task 1; Task 14 adds the SPA fallback for non-`/api`, non-`/media` GETs).
    4. Errors: `HttpError` → its status + message. Anything else → `log('error', { message, stack })` + 500.
  - `server/main.ts`: `loadConfig()`, `openDb(join(cfg.dataDir, 'gallery.db'))` (mkdir `dataDir` first), `createApp`, `server.listen(cfg.port)`, `log('listening', { port })`. On SIGTERM/SIGINT run `close()` and exit.
  - `server/test/helpers.ts` per the Interfaces block.

- [ ] **Step 5: Run tests, expect pass**

Run: `npm test && npm run typecheck`
Expected: all tests pass and `tsc` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold server core (config, sqlite schema, http router, security headers)"
```

---

### Task 2: Docker base image, test image, media fixtures (verifies HEIC early)

**Files:**
- Create: `Dockerfile` (stages `base`, `test`; Task 20 adds `build` and `runtime`), `.dockerignore`, `server/test/fixtures/{exif-rot6.jpg,plain.png,clip.mp4,sample.heic,corrupt.jpg}`, `server/test/tools.test.ts`
- Modify: `server/test/helpers.ts`, `package.json` (script `test:docker`)

**Interfaces:**
- Produces: `hasCommand(cmd: string): boolean` and `fixture(name: string): string` (absolute path) in `helpers.ts`; Docker image tag `home-gallery-test`.

- [ ] **Step 1: Write `Dockerfile` stages and `.dockerignore`**

```dockerfile
FROM node:24.22.1-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends libvips-tools libheif-plugin-libde265 ffmpeg tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS test
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples libheif-plugin-x265 \
 && rm -rf /var/lib/apt/lists/*
```
`.dockerignore`: `node_modules`, `dev-data`, `data`, `.superpowers`, `.git`, `web/dist`, `*.zip`.
Script:

```bash
npm pkg set scripts.test:docker='docker build --target test -t home-gallery-test . && docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app home-gallery-test node --disable-warning=ExperimentalWarning --test'
```

- [ ] **Step 2: Generate and commit the fixtures** (one-time; run from the repo root)

```bash
F=server/test/fixtures; mkdir -p $F
python3 -I -c "from PIL import Image; im=Image.new('RGB',(64,48),(200,80,40)); ex=Image.Exif(); ex[0x0112]=6; ex.get_ifd(0x8769)[0x9003]='2025:12:24 18:00:00'; im.save('$F/exif-rot6.jpg', exif=ex)"
ffmpeg -v error -f lavfi -i color=c=blue:s=32x16 -frames:v 1 $F/plain.png
ffmpeg -v error -f lavfi -i testsrc=s=320x240:d=1:r=10 -c:v libx264 -pix_fmt yuv420p -movflags +faststart $F/clip.mp4
printf 'not really a jpeg' > $F/corrupt.jpg
docker build --target test -t home-gallery-test . && docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/$F:/f" home-gallery-test \
  sh -c 'ffmpeg -v error -f lavfi -i testsrc=s=64x48 -frames:v 1 /tmp/s.png && heif-enc -q 50 /tmp/s.png -o /f/sample.heic'
```

- [ ] **Step 3: Write `server/test/tools.test.ts`**

```ts
test('vipsthumbnail decodes HEIC', { skip: !hasCommand('vipsthumbnail') }, async () => {
  const out = join(await tempDir(), 't.jpg');
  await execFileP('vipsthumbnail', [fixture('sample.heic'), '--size', '480x480>', '-o', out + '[Q=80,strip]']);
  assert.ok((await stat(out)).size > 0);
});
test('ffmpeg grabs a poster frame', { skip: !hasCommand('ffmpeg') }, async () => {
  const out = join(await tempDir(), 'p.jpg');
  await execFileP('ffmpeg', ['-v', 'error', '-ss', '0', '-i', fixture('clip.mp4'), '-frames:v', '1', '-y', out]);
  assert.ok((await stat(out)).size > 0);
});
```

- [ ] **Step 4: Run locally and in Docker**

Run: `npm test`
Expected: the ffmpeg test passes; the vips test is reported as skipped (no libvips on the host).
Run: `npm run test:docker`
Expected: all tests pass, including `vipsthumbnail decodes HEIC` (not skipped).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "build: docker base/test images with libvips+HEIF and ffmpeg; media fixtures"
```

---

### Task 3: Names and media types

**Files:**
- Create: `server/names.ts`, `server/mediatypes.ts`, `server/test/names.test.ts`

**Interfaces:**
- Produces:
  - `names.ts`:
    - `isHiddenName(name: string): boolean`
    - `validateName(name: string, maxBytes = 200): string | null` (error message or null)
    - `validateAlias(alias: string): string | null` (64-char limit, same rules)
    - `sanitizeUploadName(name: string): string`
    - `splitExt(name: string): [string, string]`
    - `nextFreeName(name: string, n: number): string`
    - `restoredName(name: string, n: number): string`
  - `mediatypes.ts`:
    - `interface MediaType { kind: MediaKind; mime: string; label: string; viewMime?: string; convert?: boolean }`
    - `MEDIA_TYPES: Record<string, MediaType>`
    - `mediaTypeOf(name: string): MediaType | null`
    - `checkMagic(name: string, head: Buffer): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
test('hidden names', () => {
  for (const n of ['.DS_Store', '.gallery-trash', '.upload-ab', '@eaDir', '#recycle', '#snapshot', '$RECYCLE.BIN', 'System Volume Information', 'lost+found', 'Thumbs.db', 'thumbs.db', 'desktop.ini'])
    assert.equal(isHiddenName(n), true, n);
  for (const n of ['IMG_1.jpg', 'Дача #2 (2024)']) assert.equal(isHiddenName(n), false, n);
});
test('validateName', () => {
  assert.equal(validateName(''), "Name can't be empty");
  assert.equal(validateName('x'.repeat(201)), 'Name is too long');
  for (const n of ['a:b', 'a/b', 'a\\b', 'a*', 'a?', 'a"', 'a<', 'a>', 'a|', 'a\u0001'])
    assert.equal(validateName(n), 'Name can\'t contain any of: / \\ : * ? " < > |', n);
  for (const n of [' a', 'a ', '.a', 'a.']) assert.equal(validateName(n), "Name can't start or end with a space or a dot", n);
  assert.equal(validateName('Thumbs.db'), 'That name is reserved');
  assert.equal(validateName('Дача #2 (2024)'), null); assert.equal(validateName('IMG 50%.jpg'), null);
  assert.equal(validateAlias('x'.repeat(65)), 'Name is too long'); assert.equal(validateAlias('test1-papa'), null);
});
test('sanitizeUploadName', () => {
  assert.equal(sanitizeUploadName('a/b\\c:d.jpg'), 'a_b_c_d.jpg');
  assert.equal(sanitizeUploadName('..hidden.jpg'), 'hidden.jpg');
  assert.equal(sanitizeUploadName(' x.jpg '), 'x.jpg');
  assert.equal(sanitizeUploadName(''), 'file');
  const long = sanitizeUploadName('я'.repeat(150) + '.jpg');
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.jpg'));
});
test('name helpers', () => {
  assert.deepEqual(splitExt('a.b.JPG'), ['a.b', '.JPG']); assert.deepEqual(splitExt('noext'), ['noext', '']);
  assert.equal(nextFreeName('IMG.jpg', 1), 'IMG (1).jpg'); assert.equal(nextFreeName('folder', 2), 'folder (2)');
  assert.equal(restoredName('x.jpg', 1), 'x (restored).jpg'); assert.equal(restoredName('x.jpg', 2), 'x (restored 2).jpg');
});
test('media types', () => {
  assert.deepEqual(mediaTypeOf('A.JPG'), { kind: 'photo', mime: 'image/jpeg', label: 'JPEG image' });
  assert.equal(mediaTypeOf('b.heic')?.convert, true);
  assert.deepEqual([mediaTypeOf('c.MOV')?.kind, mediaTypeOf('c.MOV')?.mime, mediaTypeOf('c.MOV')?.viewMime], ['video', 'video/quicktime', 'video/mp4']);
  assert.equal(mediaTypeOf('d.txt'), null); assert.equal(mediaTypeOf('e.svg'), null);
});
test('magic bytes', () => {
  const b = (...x: (number | string)[]) => Buffer.concat(x.map((v) => typeof v === 'string' ? Buffer.from(v, 'latin1') : Buffer.from([v])));
  assert.equal(checkMagic('a.jpg', b(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(checkMagic('a.jpg', b(0x89, 'PNG\r\n\x1a\n')), false);
  assert.equal(checkMagic('a.png', b(0x89, 'PNG\r\n\x1a\n')), true);
  assert.equal(checkMagic('a.gif', b('GIF89a')), true);
  assert.equal(checkMagic('a.webp', b('RIFF\0\0\0\0WEBP')), true);
  assert.equal(checkMagic('a.mp4', b('\0\0\0\x18ftypisom')), true);
  assert.equal(checkMagic('a.heic', b('\0\0\0\x18ftypheic')), true);
  assert.equal(checkMagic('a.mov', b('\0\0\0\x08wide')), true);
  assert.equal(checkMagic('a.webm', b(0x1a, 0x45, 0xdf, 0xa3)), true);
  assert.equal(checkMagic('a.txt', b('hello')), false);
});
```

- [ ] **Step 2: Run, expect failure.** Run: `node --test server/test/names.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**
  - Rule order in `validateName`: empty → too long (UTF-8 bytes; chars for `validateAlias`) → invalid chars (incl. `\x00-\x1f\x7f`) → leading/trailing space or dot → reserved (`isHiddenName` set members).
  - `sanitizeUploadName`:
    1. Replace invalid and control chars with `_`.
    2. Trim spaces, then strip leading dots.
    3. Cut the base to fit 200 bytes while keeping the extension (whole code points).
    4. Empty result → `file`.
  - Media type table: `.jpg/.jpeg` `JPEG image`, `.png` `PNG image`, `.webp` `WebP image`, `.gif` `GIF image`, `.heic` `HEIC image` (convert), `.heif` `HEIF image` (convert), `.mp4` `MP4 video`, `.m4v` `M4V video` (mime `video/x-m4v`, viewMime `video/mp4`), `.mov` `MOV video` (mime `video/quicktime`, viewMime `video/mp4`), `.webm` `WebM video`.
  - Magic signatures:
    - JPEG: `FF D8 FF`
    - PNG: 8-byte signature
    - GIF: `GIF87a` / `GIF89a`
    - WebP: `RIFF` at 0 + `WEBP` at 8
    - heic/heif/mp4/m4v: `ftyp` at 4
    - mov: `ftyp|moov|mdat|wide|free|skip` at 4
    - webm: `1A 45 DF A3`

- [ ] **Step 4: Run, expect pass.** Run: `node --test server/test/names.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: name validation, hidden-name rules, media type table"`

---

### Task 4: Auth primitives and the request pipeline (Origin check, session loading)

**Files:**
- Create: `server/auth.ts`, `server/users.ts`, `server/test/auth.test.ts`
- Modify: `server/app.ts`

**Interfaces:**
- Consumes: `Ctx`, `HttpError`, `clientInfo` (Task 1).
- Produces:
  - `auth.ts`:
    - `SESSION_COOKIE = 'hg_session'`
    - `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, phc: string): Promise<boolean>`
    - `burnPasswordCheck(pw: string): Promise<void>` (verifies against a fixed dummy hash for unknown users)
    - `createSession(db, userId: number, remember: boolean, ip: string, userAgent: string): string` (returns the token)
    - `touchSession(db, token: string, now = Date.now()): { user: Me; remember: boolean; refreshed: boolean } | null`
    - `revokeSession(db, token: string): void`, `revokeUserSessions(db, userId: number, exceptToken?: string | null): void`
    - `sessionCookie(token: string, remember: boolean, secure: boolean): string`, `clearSessionCookie(secure: boolean): string`
    - `class LoginLimiter { check(ip: string, username: string, now?: number): { ok: true } | { ok: false; retryAfterMin: number }; fail(ip: string, username: string, now?: number): void; succeed(username: string): void }`
    - `requireUser(ctx: Ctx): Me`, `requireAdmin(ctx: Ctx): Me`
  - `users.ts` (first part):
    - `parsePrefs(json: string): Prefs`
    - `countUsers(db): number`, `getMe(db, id: number): Me | null`
    - `findLogin(db, username: string): { id: number; passwordHash: string } | null`
    - `createUser(db, input: { username: string; displayName: string; password: string; role: Role }): Promise<Me>` (validates; 409 duplicate, case-insensitive)
  - `App` gains `limiter: LoginLimiter`.

- [ ] **Step 1: Write the failing tests**

```ts
test('password hashing', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.notEqual(h, await hashPassword('correct horse'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});
test('createUser validation', async () => {
  const db = openDb(':memory:');
  await createUser(db, { username: 'alice', displayName: 'Alice', password: 'password123', role: 'admin' });
  await assert.rejects(createUser(db, { username: 'Alice', displayName: 'A', password: 'password123', role: 'member' }), { status: 409, message: 'That username is taken' });
  await assert.rejects(createUser(db, { username: 'Bad Name', displayName: 'B', password: 'password123', role: 'member' }), { status: 400 });
  await assert.rejects(createUser(db, { username: 'bob', displayName: 'B', password: 'short', role: 'member' }), { message: 'Password must be at least 8 characters' });
});
test('sessions: idle, remember, sliding, revoke', async () => {
  const db = openDb(':memory:');
  const u = await createUser(db, { username: 'a', displayName: 'A', password: 'password123', role: 'member' });
  const H = 3_600_000, D = 24 * H;
  const n = createSession(db, u.id, false, 'ip', 'ua');
  assert.equal(touchSession(db, n)?.user.username, 'a');
  const created = Date.now();
  assert.ok(touchSession(db, n, created + 11 * H));
  assert.equal(touchSession(db, n, created + 11 * H + 12 * H + 61_000), null);
  const r = createSession(db, u.id, true, 'ip', 'ua');
  assert.ok(touchSession(db, r, created + 29 * D));                        // slides to +59d
  assert.ok(touchSession(db, r, created + 58 * D));
  assert.equal(touchSession(db, r, created + 58 * D + 31 * D), null);
  const keep = createSession(db, u.id, true, 'ip', 'ua'), drop = createSession(db, u.id, true, 'ip', 'ua');
  revokeUserSessions(db, u.id, keep);
  assert.ok(touchSession(db, keep)); assert.equal(touchSession(db, drop), null);
});
test('session cookies', () => {
  assert.equal(sessionCookie('T', true, true), 'hg_session=T; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure');
  assert.equal(sessionCookie('T', false, false), 'hg_session=T; Path=/; HttpOnly; SameSite=Lax');
  assert.equal(clearSessionCookie(false), 'hg_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});
test('login limiter', () => {
  const l = new LoginLimiter(), t = 1e12, M = 60_000;
  for (let i = 0; i < 5; i++) l.fail('1.1.1.1', 'bob', t);
  assert.deepEqual(l.check('2.2.2.2', 'bob', t), { ok: false, retryAfterMin: 15 });
  assert.deepEqual(l.check('2.2.2.2', 'bob', t + 15 * M + 1), { ok: true });
  for (let i = 0; i < 20; i++) l.fail('9.9.9.9', 'user' + i, t);
  assert.equal(l.check('9.9.9.9', 'someone', t + M).ok, false);
  l.fail('3.3.3.3', 'carol', t); l.succeed('carol');
  for (let i = 0; i < 4; i++) l.fail('3.3.3.3', 'carol', t);
  assert.equal(l.check('3.3.3.3', 'carol', t).ok, true);
});
test('Origin check, trusted proxy and HSTS (Review Focus 4)', async (t) => {
  const trusted = new BlockList(); trusted.addAddress('127.0.0.1'); trusted.addAddress('::1', 'ipv6');
  const fwd = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gallery.example.com', origin: 'https://gallery.example.com' };
  for (const [proxies, status] of [[trusted, 200], [new BlockList(), 403]] as const) {
    const ta = await startTestApp({ trustedProxies: proxies }); t.after(() => ta.close());
    ta.app.router.add('POST', '/api/ping', () => ({ pong: true }));
    const r = await fetch(ta.url + '/api/ping', { method: 'POST', headers: { ...fwd, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, status);
    if (status === 200) assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
    else assert.match((await r.json()).error, /check TRUSTED_PROXIES/);
  }
});
test('pipeline loads the session user', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const u = await createUser(ta.db, { username: 'zed', displayName: 'Zed', password: 'password123', role: 'member' });
  ta.app.router.add('GET', '/api/whoami', (c) => ({ who: requireUser(c).username }));
  assert.equal((await ta.client().json('GET', '/api/whoami')).status, 401);
  const tok = createSession(ta.db, u.id, false, 'ip', 'ua');
  assert.deepEqual((await ta.client(`hg_session=${tok}`).json('GET', '/api/whoami')).body, { who: 'zed' });
  assert.equal((await fetch(ta.url + '/api/whoami', { method: 'POST' })).status, 403);   // no Origin
});
```

- [ ] **Step 2: Run, expect failure.** `node --test server/test/auth.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**
  - Hashing: `promisify(crypto.argon2)('argon2id', { message, nonce: randomBytes(16), parallelism: 1, tagLength: 32, memory: 19456, passes: 2 })`. PHC string: unpadded base64 for salt and hash. `verifyPassword` parses the parameters from the string and compares with `timingSafeEqual`.
  - Sessions:
    - Token: `randomBytes(32).toString('base64url')`; store `sha256` hex.
    - On create: `expires_at = now + (remember ? 30 d : 12 h)`.
    - `touchSession`: delete and return null when expired. If `now - last_seen_at > 60_000`, bump `last_seen_at` and `expires_at` the same way, and set `refreshed = remember`.
  - Limiter: keys use the lowercased username. Per-username consecutive failures, lock 15 min at 5. Per-IP failure timestamps in a 15-min window, blocked at ≥ 20. `retryAfterMin = ceil(ms / 60000)`.
  - Pipeline additions in `app.ts`, after headers:
    - Non-GET/HEAD requests whose `Origin` ≠ `ctx.origin` → 403 with the TRUSTED_PROXIES message.
    - Then read the cookie → `touchSession` → `ctx.user`/`ctx.token`. When `refreshed`, re-send `sessionCookie(token, true, cfg.cookieSecure)`.
  - `requireUser` → 401 `Sign in required`; `requireAdmin` → 401 or 403 `Administrators only`.
  - `createUser`:
    - username trimmed and lowercased, must match `/^[a-z0-9._-]{2,32}$/`
    - displayName trimmed, 1–64 chars, falling back to the username
    - password ≥ 8
    - `created_at = Date.now()`, prefs `'{}'`

- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: argon2id passwords, sessions, login limiter, origin check"`

---

### Task 5: Auth endpoints, first-run setup, account endpoints, CLI

**Files:**
- Create: `server/authroutes.ts`, `server/cli.ts`, `server/test/authroutes.test.ts`
- Modify: `server/users.ts`, `server/app.ts`, `server/main.ts`, `server/test/helpers.ts`

**Interfaces:**
- Consumes: Task 4 auth and users functions.
- Produces:
  - Endpoints:
    - `GET /api/session` → `SessionInfo`
    - `POST /api/login {username, password, remember}` → `{ user: Me }` + cookie
    - `POST /api/logout` → `{ ok: true }` + cleared cookie
    - `POST /api/setup {token, username, displayName, password}` → `{ user: Me }` + cookie (remember = true)
    - `POST /api/me/password {current, next}` → `{ ok: true }`
    - `PUT /api/me/prefs {defaultView?, slideSeconds?}` → `Prefs`
  - `users.ts`: `setPassword(db, id: number, password: string, keepToken?: string | null): Promise<void>` (validates and revokes the other sessions) and `setPrefs(db, id: number, patch: Partial<Prefs>): Prefs` (view ∈ the three modes, slideSeconds an integer 2–20, else 400 `Invalid preferences`).
  - `App` gains `setupToken: string | null` (24 random bytes base64url, set only when `countUsers() === 0`).
  - `cli.ts`: `runCli(argv: string[], cfg: Config, db: DB): Promise<number>`. `set-password <username>` prints `New password for <username>: <16-char base64url>`, revokes all sessions and returns 0. Unknown user or command prints usage and returns 1.
  - `helpers.ts` gains `TestApp.addUser(username: string, role: Role, password = 'password123'): Promise<{ id: number; client: Client }>` (creates the user and logs in via the API) and `TestApp.admin(): Promise<Client>` (memoized admin `root`).

- [ ] **Step 1: Write the failing tests**

```ts
test('first-run setup', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const c = ta.client();
  assert.deepEqual((await c.json('GET', '/api/session')).body, { user: null, setupRequired: true });
  assert.deepEqual(await c.json('POST', '/api/setup', { token: 'x', username: 'root', displayName: 'Root', password: 'password123' }), { status: 403, body: { error: 'Invalid setup link' } });
  const r = await c.req('POST', '/api/setup', { token: ta.app.setupToken, username: 'root', displayName: 'Root', password: 'password123' });
  assert.equal(r.status, 200); assert.equal((await r.json()).user.role, 'admin');
  assert.match(r.headers.getSetCookie()[0], /^hg_session=.+Max-Age=2592000/);
  assert.equal(ta.app.setupToken, null);
  assert.equal((await c.json('POST', '/api/setup', { token: 'x', username: 'r2', displayName: 'R', password: 'password123' })).status, 409);
});
test('login, lockout, cookie flags, logout', async (t) => {
  const ta = await startTestApp({ cookieSecure: true }); t.after(() => ta.close());
  await createUser(ta.db, { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  const c = ta.client();
  assert.deepEqual(await c.json('POST', '/api/login', { username: 'nobody', password: 'password123', remember: true }), { status: 401, body: { error: 'Wrong username or password' } });
  const ok = await c.req('POST', '/api/login', { username: 'PAPA', password: 'password123', remember: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.getSetCookie()[0].includes('Max-Age'), false);
  assert.match(ok.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax; Secure$/);
  const me = ta.client(ok.headers.getSetCookie()[0].split(';')[0]);
  assert.equal((await me.json('GET', '/api/session')).body.user.username, 'papa');
  await me.json('POST', '/api/logout');
  assert.equal((await me.json('GET', '/api/session')).body.user, null);
  for (let i = 0; i < 5; i++) await c.json('POST', '/api/login', { username: 'papa', password: 'bad-password', remember: false });
  const locked = await c.json('POST', '/api/login', { username: 'papa', password: 'password123', remember: false });
  assert.equal(locked.status, 429); assert.match(locked.body.error, /^Too many attempts, try again in \d+ minutes$/);
});
test('change password and prefs', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const { client: a } = await ta.addUser('mama', 'member');
  const other = await ta.login('mama', 'password123');     // second session
  assert.deepEqual(await a.json('POST', '/api/me/password', { current: 'nope-nope', next: 'newpassword1' }), { status: 400, body: { error: 'Current password is wrong' } });
  assert.equal((await a.json('POST', '/api/me/password', { current: 'password123', next: 'short' })).body.error, 'Password must be at least 8 characters');
  assert.equal((await a.json('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  assert.equal((await other.json('GET', '/api/session')).body.user, null);
  assert.equal((await a.json('GET', '/api/session')).body.user.username, 'mama');
  assert.deepEqual((await a.json('PUT', '/api/me/prefs', { defaultView: 'details', slideSeconds: 7 })).body, { defaultView: 'details', slideSeconds: 7 });
  assert.equal((await a.json('PUT', '/api/me/prefs', { slideSeconds: 30 })).status, 400);
});
test('CLI set-password', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close());
  const { client } = await ta.addUser('alice', 'admin');
  const lines: string[] = []; t.mock.method(console, 'log', (s: string) => lines.push(s));
  assert.equal(await runCli(['set-password', 'alice'], ta.cfg, ta.db), 0);
  const pw = lines.join('\n').match(/New password for alice: (\S+)/)![1];
  assert.equal((await client.json('GET', '/api/session')).body.user, null);
  assert.equal((await ta.client().json('POST', '/api/login', { username: 'alice', password: pw, remember: false })).status, 200);
  assert.equal(await runCli(['set-password', 'ghost'], ta.cfg, ta.db), 1);
});
```
`TestApp.login(username, password)` posts to `/api/login` and returns a cookie client (add it to `helpers.ts` with `addUser`).

- [ ] **Step 2: Run, expect failure.** `node --test server/test/authroutes.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - Login:
    1. `limiter.check` → 429 when blocked.
    2. Look up the user. Verify the password, or call `burnPasswordCheck` for unknown users.
    3. On failure: `limiter.fail`, `log('login_failed', { username, ip })`, 401.
    4. On success: `limiter.succeed`, create the session, set the cookie, `log('login', …)`.
  - Setup: compare the token with `timingSafeEqual` (lengths checked first). Create an admin, clear the token, log in with remember.
  - `main.ts`:
    - With args, run `process.exit(await runCli(process.argv.slice(2), cfg, db))`.
    - When `app.setupToken` is set, print `First run: open https://<your-domain>/setup?token=<token> to create the admin account` and also `log('setup_link', { path })`.

- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: login/logout/setup/account endpoints and set-password CLI"`

---

### Task 6: Virtual path resolver (core security)

**Files:**
- Create: `server/vpath.ts`, `server/test/vpath.test.ts`

**Interfaces:**
- Consumes: `isHiddenName` (Task 3), `HttpError`, `Config`, `Me`, `Rights`.
- Produces:
  - `interface ShareRow { id: number; userId: number; alias: string; relPath: string; create: boolean; update: boolean; delete: boolean }`
  - `interface Loc { vpath: string; abs: string | null; rel: string; rights: Rights; isProtected: boolean; scope: string | null; share: ShareRow | null }`
    - `abs` is null only at a member's virtual root.
    - `rel` is relative to `mediaRoot`, `''` at the roots.
    - `scope` is the move boundary: the member share root's abs, or the admin's top-level abs.
  - `splitVpath(vpath: string): string[]`: 400 `Invalid path` for no leading `/`, empty / `.` / `..` segments, NUL, `\`, or hidden names. `'/'` returns `[]`.
  - `sharesForUser(db: DB, userId: number): ShareRow[]`
  - `resolve(cfg: Config, user: Me, shares: ShareRow[], vpath: string): Promise<Loc>`: 404 `Not found` for an unknown alias, a missing path or a realpath escape.
  - `locate(app: App, user: Me, vpath: string): Promise<Loc>` (loads shares for members)
  - `childAbs(loc: Loc, name: string): string`
  - `requireRight(loc: Loc, right: keyof Rights): void` → 403 `You don't have permission to do that`
  - `requireUnprotected(loc: Loc): void` → 403 `This folder can't be renamed, moved or deleted`
  - `joinVpath(parent: string, name: string): string`

- [ ] **Step 1: Write the failing tests.** Build this fixture tree in `before()`:
  - Media: `pics/family/xmas/a.jpg`, `pics/family/Дача #2 (2024)/IMG 50%.jpg`, `pics/test1/b.jpg`, `pics/.hidden/x.jpg`, `pics/@eaDir/y.jpg`, `other/secret.jpg`.
  - Symlinks: `pics/family/escape → ../../other` and `pics/family/inside → xmas`.
  - Users: `admin = { id: 1, role: 'admin', … }` and `papa = { id: 2, role: 'member', … }`.
  - Papa's shares: `[{ id: 1, alias: 'Family photos', relPath: 'pics/family', create: true, update: false, delete: false }, { id: 2, alias: 'test1-papa', relPath: 'pics/test1', all false }, { id: 3, alias: 'All', relPath: 'pics', all false }]`.

```ts
test('member root is virtual and protected', async () => {
  const l = await resolve(cfg, papa, shares, '/');
  assert.deepEqual([l.abs, l.isProtected, l.rights], [null, true, { create: false, update: false, delete: false }]);
});
test('alias maps to disk with share rights', async () => {
  const l = await resolve(cfg, papa, shares, '/Family photos/xmas');
  assert.equal(l.abs, join(media, 'pics/family/xmas')); assert.equal(l.rel, 'pics/family/xmas');
  assert.deepEqual(l.rights, { create: true, update: false, delete: false });
  assert.equal(l.isProtected, false); assert.equal(l.scope, join(media, 'pics/family'));
  assert.equal((await resolve(cfg, papa, shares, '/Family photos')).isProtected, true);
});
test('overlapping shares use the alias in the path', async () =>
  assert.deepEqual((await resolve(cfg, papa, shares, '/All/family/xmas')).rights, { create: false, update: false, delete: false }));
test('rejects traversal, hidden, backslash, NUL', async () => {
  for (const p of ['/Family photos/../test1-papa', '/Family photos/./xmas', '/a//b', 'rel', '/All/.hidden/x.jpg', '/All/@eaDir', '/All\\..', '/a\0b'])
    await assert.rejects(resolve(cfg, papa, shares, p), { status: 400, message: 'Invalid path' }, p);
});
test('404 for unknown alias, missing path and symlink escape; inside symlink allowed', async () => {
  for (const p of ['/nope', '/Family photos/missing', '/Family photos/escape/secret.jpg'])
    await assert.rejects(resolve(cfg, papa, shares, p), { status: 404, message: 'Not found' }, p);
  assert.ok((await resolve(cfg, papa, shares, '/Family photos/inside/a.jpg')).abs);
});
test('admin sees MEDIA_ROOT; root and top-level are protected', async () => {
  const root = await resolve(cfg, admin, [], '/');
  assert.deepEqual([root.abs, root.isProtected, root.rights.create], [media, true, false]);
  const top = await resolve(cfg, admin, [], '/pics');
  assert.deepEqual([top.isProtected, top.rights, top.scope], [true, { create: true, update: true, delete: true }, join(media, 'pics')]);
  assert.equal((await resolve(cfg, admin, [], '/pics/family')).isProtected, false);
});
test('unicode and URL-special names (Review Focus 1)', async () =>
  assert.equal((await resolve(cfg, papa, shares, '/Family photos/Дача #2 (2024)/IMG 50%.jpg')).rel, 'pics/family/Дача #2 (2024)/IMG 50%.jpg'));
test('requireRight / requireUnprotected', async () => {
  const l = await resolve(cfg, papa, shares, '/test1-papa');
  assert.throws(() => requireRight(l, 'create'), { status: 403, message: "You don't have permission to do that" });
  assert.throws(() => requireUnprotected(l), { status: 403, message: "This folder can't be renamed, moved or deleted" });
});
```

- [ ] **Step 2: Run, expect failure.** `node --test server/test/vpath.test.ts` → FAIL.

- [ ] **Step 3: Implement `resolve`**
  1. `splitVpath`.
  2. Admin: base = `mediaRoot`. Member: the first segment picks the share by case-insensitive alias match (none → 404); base = `mediaRoot/share.relPath`.
  3. abs = join(base, ...rest).
  4. `realpath(abs)` and `realpath(base)`; ENOENT → 404. Require `real === baseReal || real.startsWith(baseReal + sep)`. The base's realpath must likewise lie inside `realpath(mediaRoot)`; otherwise 404.
  5. Rights:
     - member: the share flags
     - admin: all true, except all false at `mediaRoot`
     - member virtual root: all false
  6. `isProtected` = member root, `mediaRoot`, a path with exactly one admin segment, or a member path with exactly one segment.
  7. `scope` = member share base, or admin `mediaRoot/<first segment>`.

- [ ] **Step 4: Run, expect pass.** `node --test server/test/vpath.test.ts` → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: virtual path resolver with alias mapping, rights and escape checks"`

---

### Task 7: Admin — users and shares

**Files:**
- Create: `server/shares.ts`, `server/adminroutes.ts`, `server/test/admin.test.ts`
- Modify: `server/users.ts`, `server/app.ts`

**Interfaces:**
- Consumes: `ShareRow`, `sharesForUser`, `splitVpath` (Task 6); `validateAlias`, `isHiddenName` (Task 3).
- Produces:
  - `users.ts`:
    - `listUsers(db): AdminUser[]`
    - `updateUser(db, actor: Me, id: number, patch: { username?: string; displayName?: string; role?: Role }): AdminUser` (role change on self → 403 `You can't change your own role`; a real role change runs `revokeUserSessions(db, id)`)
    - `removeUser(db, actor: Me, id: number): Promise<void>` (self → 403 `You can't remove yourself`; also unlinks that user's `uploads.temp_abs` files)
    - Self-protection already guarantees at least one admin, so there is no separate last-admin check.
  - `shares.ts`:
    - `addShare(cfg, db, userId: number, input: { relPath: string; alias: string; create: boolean; update: boolean; delete: boolean }): Promise<ShareInfo>`
    - `updateShare(cfg, db, id: number, patch: Partial<{ alias: string; create: boolean; update: boolean; delete: boolean }>): Promise<ShareInfo>`
    - `removeShare(db, id: number): void`
    - `listShareInfo(cfg, db, userId: number): Promise<ShareInfo[]>` (sorted by alias)
    - `rewriteSharePaths(db, oldRel: string, newRel: string): number`
    - `browseDisk(cfg, rel: string): Promise<{ path: string; folders: string[] }>`
    - `diskPath = join(cfg.mediaRoot, relPath)`; `available` = it is a directory now.
  - Endpoints (all `requireAdmin`):
    - `GET /api/admin/users`, `POST /api/admin/users {username, displayName, password, role}`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/password {password}`, `DELETE /api/admin/users/:id`
    - `GET|POST /api/admin/users/:id/shares`, `PATCH|DELETE /api/admin/shares/:id`
    - `GET /api/admin/browse?path=<rel>`
    - Log events `user_*`, `password_set`, `share_*`.

- [ ] **Step 1: Write the failing tests.** Media tree: `pics/family`, `pics/test1`, `pics/.hidden`, `other`, a file `pics/x.jpg`, and a symlink `pics/link → family`.

```ts
test('admin endpoints are admin-only', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); await ta.admin();
  const { client: m } = await ta.addUser('papa', 'member');
  assert.equal((await ta.client().json('GET', '/api/admin/users')).status, 401);
  assert.deepEqual(await m.json('GET', '/api/admin/users'), { status: 403, body: { error: 'Administrators only' } });
});
test('user management', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const made = await a.json('POST', '/api/admin/users', { username: 'papa', displayName: 'Papa', password: 'password123', role: 'member' });
  assert.equal(made.status, 200);
  assert.equal((await a.json('POST', '/api/admin/users', { username: 'PAPA', displayName: 'X', password: 'password123', role: 'member' })).body.error, 'That username is taken');
  const me = (await a.json('GET', '/api/session')).body.user;
  assert.equal((await a.json('PATCH', `/api/admin/users/${me.id}`, { role: 'member' })).body.error, "You can't change your own role");
  assert.equal((await a.json('DELETE', `/api/admin/users/${me.id}`)).body.error, "You can't remove yourself");
  const papa = await ta.login('papa', 'password123');
  await a.json('POST', `/api/admin/users/${made.body.id}/password`, { password: 'another-pass1' });
  assert.equal((await papa.json('GET', '/api/session')).body.user, null);
  const papa2 = await ta.login('papa', 'another-pass1');
  assert.equal((await a.json('PATCH', `/api/admin/users/${made.body.id}`, { role: 'admin' })).body.role, 'admin');
  assert.equal((await papa2.json('GET', '/api/session')).body.user, null);
  assert.equal((await a.json('DELETE', `/api/admin/users/${made.body.id}`)).status, 200);
  assert.equal(ta.db.prepare('select count(*) n from shares').get()!.n, 0);
});
test('shares', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  const { id } = await ta.addUser('papa', 'member'); const { id: mama } = await ta.addUser('mama', 'member');
  const s = await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/family', alias: 'Family photos', create: true, update: false, delete: false });
  assert.deepEqual(s.body, { id: s.body.id, userId: id, alias: 'Family photos', relPath: 'pics/family', diskPath: join(ta.media, 'pics/family'), create: true, update: false, delete: false, available: true });
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/test1', alias: 'family PHOTOS', create: false, update: false, delete: false })).body.error, 'This user already has a folder named "family PHOTOS"');
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/family', alias: 'Again', create: false, update: false, delete: false })).body.error, 'This folder is already shared with this user');
  assert.equal((await a.json('POST', `/api/admin/users/${mama}/shares`, { relPath: 'pics/family', alias: 'Family photos', create: false, update: false, delete: false })).status, 200);
  for (const [relPath, status] of [['', 400], ['../x', 400], ['pics/.hidden', 400], ['pics/missing', 404], ['pics/x.jpg', 400]] as const)
    assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath, alias: 'Z' + status, create: false, update: false, delete: false })).status, status, relPath);
  assert.equal((await a.json('POST', `/api/admin/users/${id}/shares`, { relPath: 'pics/test1', alias: 'a/b', create: false, update: false, delete: false })).status, 400);
  assert.equal((await a.json('PATCH', `/api/admin/shares/${s.body.id}`, { delete: true })).body.delete, true);
  await rm(join(ta.media, 'pics/family'), { recursive: true });
  assert.equal((await a.json('GET', `/api/admin/users/${id}/shares`)).body[0].available, false);
  assert.equal(rewriteSharePaths(ta.db, 'pics', 'photos'), 2);
});
test('browse disk for the folder picker', async (t) => {
  const ta = await startTestApp(); t.after(() => ta.close()); const a = await ta.admin();
  assert.deepEqual((await a.json('GET', '/api/admin/browse?path=')).body, { path: '', folders: ['other', 'pics'] });
  assert.deepEqual((await a.json('GET', '/api/admin/browse?path=pics')).body, { path: 'pics', folders: ['family', 'test1'] });
  assert.equal((await a.json('GET', '/api/admin/browse?path=../')).status, 400);
});
```
(Create the media tree inside each test via a helper `seedTree(ta.media, [...])` added to `helpers.ts`: `seedTree(root: string, files: string[], links?: [string, string][]): Promise<void>`. Entries ending in `/` are folders; files get the bytes of `fixture('plain.png')`, or of `exif-rot6.jpg` when the name ends in `.jpg`.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/admin.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `addShare` validates:
    1. `relPath` via `splitVpath('/' + relPath)`. An empty relPath → 400 `Pick a folder inside the media folder`.
    2. The path must exist (404) and be a directory (400 `Pick a folder inside the media folder`), with its realpath inside `mediaRoot`.
    3. The alias via `validateAlias`.
    4. Uniqueness → map SQLite `UNIQUE` errors to the two 409 messages.
  - `rewriteSharePaths`: in JS, select the rows where `rel_path === old || rel_path.startsWith(old + '/')` and update them in one transaction.
  - `browseDisk`: list non-hidden, non-symlink directories, sorted with `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`.

- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: admin user and share management with disk folder picker"`

---

### Task 8: Media metadata and browsing endpoints

**Files:**
- Create: `server/limit.ts`, `server/proc.ts`, `server/meta.ts`, `server/listing.ts`, `server/browseroutes.ts`, `server/test/browse.test.ts`
- Modify: `server/app.ts`

**Interfaces:**
- Consumes: `locate`, `Loc`, `joinVpath` (Task 6); `mediaTypeOf`, `isHiddenName` (Task 3).
- Produces:
  - `limit.ts`: `pLimit(n: number): <T>(fn: () => Promise<T>) => Promise<T>`.
  - `proc.ts`: `type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string>`; `runProcess: RunFn` (execFile, no shell, `maxBuffer` 10 MB; rejects with `Error(cmd + ' failed: ' + stderr)`).
  - `meta.ts`:
    - `exifToWallClock(s: string): string | null`
    - `instantToWallClock(ms: number): string` (process-local TZ)
    - `extractMeta(abs: string, kind: MediaKind, mtimeMs: number, run?: RunFn): Promise<Meta>`
    - `getMeta(db, abs: string, rel: string, st: { size: number; mtimeMs: number }, kind: MediaKind): Promise<Meta>` (cache row keyed by `rel_path` and valid when size and mtime match; upsert otherwise; extraction concurrency 4)
  - `listing.ts`:
    - `listFolder(app: App, user: Me, loc: Loc): Promise<Listing>`
    - `listFolders(app, user, loc): Promise<FolderNode[]>`
    - `listFiles(loc: Loc, cap = 5000): Promise<{ items: SlideItem[]; capped: boolean }>`
    - `invalidateStats(): void`
  - Endpoints (all `requireUser`):
    - `GET /api/list?path=` → `Listing`
    - `GET /api/folders?path=` → `FolderNode[]`
    - `GET /api/files?path=` → `{ items, capped }` (recursive)
    - `GET /api/meta?path=` → `Meta` (400 `Not a media file` for folders and other files)

- [ ] **Step 1: Write the failing tests**

```ts
test('exif and wall-clock helpers', () => {
  assert.equal(exifToWallClock('2025:12:24 18:00:00'), '2025-12-24T18:00:00');
  assert.equal(exifToWallClock('0000:00:00 00:00:00'), null);
  assert.match(instantToWallClock(Date.UTC(2025, 6, 11, 10, 0, 0)), /^2025-07-11T\d\d:00:00$/);
});
test('extractMeta: EXIF photo, plain PNG, video, corrupt file (Review Focus 2)', async () => {
  assert.deepEqual(await extractMeta(fixture('exif-rot6.jpg'), 'photo', 0), { width: 48, height: 64, takenAt: '2025-12-24T18:00:00', duration: null });
  const png = await extractMeta(fixture('plain.png'), 'photo', Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.deepEqual([png.width, png.height, png.takenAt], [32, 16, instantToWallClock(Date.UTC(2024, 0, 2, 3, 4, 5))]);
  const bad = await extractMeta(fixture('corrupt.jpg'), 'photo', 0);
  assert.deepEqual([bad.width, bad.height, bad.takenAt], [null, null, instantToWallClock(0)]);
});
test('extractMeta: video', { skip: !hasCommand('ffprobe') }, async () => {
  const v = await extractMeta(fixture('clip.mp4'), 'video', 0);
  assert.deepEqual([v.width, v.height], [320, 240]); assert.ok(Math.abs(v.duration! - 1) < 0.2);
});
test('member root lists aliases; hidden/unavailable handled', async (t) => {
  // tree: pics/family/{a.jpg, notes.txt, .DS_Store, xmas/b.jpg, @eaDir/c.jpg}, pics/test1/; link pics/family/ln -> xmas
  // shares for papa: 'Family photos' -> pics/family (create), 'Gone' -> pics/gone (missing)
  const root = (await papa.json('GET', '/api/list?path=' + encodeURIComponent('/'))).body;
  assert.equal(root.name, 'Home Gallery');
  assert.deepEqual(root.entries.map((e: any) => [e.name, e.count, e.protected, !!e.unavailable]), [['Family photos', 3, true, false], ['Gone', 0, true, true]]);
  assert.equal(root.entries[0].cover, '/Family photos/a.jpg');
  const fam = (await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos'))).body;
  assert.deepEqual(fam.entries.map((e: any) => [e.kind, e.name]), [['folder', 'xmas'], ['folder', 'Дача #2 (2024)'], ['photo', 'a.jpg']]);
  assert.deepEqual(fam.rights, { create: true, update: false, delete: false });
  const a = fam.entries.find((e: any) => e.name === 'a.jpg');
  assert.deepEqual([a.type, a.width, a.height, a.takenAt], ['JPEG image', 48, 64, '2025-12-24T18:00:00']);
  assert.ok(ta.db.prepare('select 1 from media_meta where rel_path=?').get('pics/family/a.jpg'));
});
test('folders and recursive files', async () => {
  assert.deepEqual((await papa.json('GET', '/api/folders?path=' + encodeURIComponent('/Family photos'))).body,
    [{ name: 'xmas', count: 1, hasChildren: false }, { name: 'Дача #2 (2024)', count: 1, hasChildren: false }]);
  const loc = await locate(ta.app, papaMe, '/Family photos');
  assert.deepEqual((await listFiles(loc)).items.map((i) => i.path), ['/Family photos/a.jpg', '/Family photos/xmas/b.jpg', '/Family photos/Дача #2 (2024)/IMG 50%.jpg']);
  assert.deepEqual(await listFiles(loc, 1).then((r) => [r.items.length, r.capped]), [1, true]);
});
test('read-only on disk forces rights off (Review Focus 3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await chmod(join(ta.media, 'pics/family'), 0o555); t.after(() => chmod(join(ta.media, 'pics/family'), 0o755));
  assert.deepEqual((await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos'))).body.rights, { create: false, update: false, delete: false });
});
test('unicode names list (Review Focus 1)', async () => {
  const r = await papa.json('GET', '/api/list?path=' + encodeURIComponent('/Family photos/Дача #2 (2024)'));
  assert.equal(r.body.entries[0].name, 'IMG 50%.jpg');
});
```
(Create `ta`, `papa`, `papaMe` and the tree in a `before()` with `seedTree`; add `Дача #2 (2024)/IMG 50%.jpg` under `pics/family`. The `xmas` order assumes folders first, then natural name order.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/browse.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - Photo metadata:
    - `exifr.parse(abs, { pick: ['DateTimeOriginal', 'Orientation'], translateValues: false, reviveValues: false })` and `imageSizeFromFile(abs)` (from `image-size/fromFile`). Each is wrapped in try/catch → null.
    - Swap width/height when `Orientation` ∈ 5–8.
  - Video metadata:
    - `ffprobe -v error -print_format json -select_streams v:0 -show_entries stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration:format_tags=creation_time <abs>` with a 15 s timeout.
    - Swap width/height when `|rotation|` is 90 or 270.
    - `takenAt` from `creation_time` via `instantToWallClock`.
  - `takenAt` fallback is always `instantToWallClock(mtimeMs)`.
  - Traversal order for counts, `cover` and `listFiles` is the design's `allFiles`: a folder's own media files in natural name order first, then each subfolder (natural order), recursively. Display order in `listFolder` is different: folders first, then files (design `rawItems`).
  - Folder stats (`count` = recursive media count, `cover` = first media file in traversal order, `hasChildren`):
    - Walk with `readdir(withFileTypes)`, skipping hidden names, symlinks and non-media files.
    - Cache in a `Map<abs, { at, stats }>` for 30 s. `invalidateStats()` clears it.
  - `listFolder`:
    - Member root: one `FolderEntry` per share sorted by alias. `unavailable: true` when `stat` fails or isn't a directory. `protected: true`.
    - Otherwise: read the directory. Folders get `protected: false` except when the loc is the admin `mediaRoot` (top-level folders → `true`).
    - Files get `getMeta`.
    - Sort: folders first, then natural name order.
    - `rights` = `loc.rights` ANDed with `access(abs, W_OK)` succeeding.
    - `name` = the last segment or `Home Gallery` at `/`.

- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: folder listing, recursive counts/covers, EXIF/ffprobe metadata cache"`

---

### Task 9: Thumbnails, previews and file serving

**Files:**
- Create: `server/send.ts`, `server/thumbs.ts`, `server/mediaroutes.ts`, `server/test/media.test.ts`
- Modify: `server/app.ts` (`App.thumbs`)

**Interfaces:**
- Consumes: `RunFn`, `runProcess`, `pLimit` (Task 8); `locate` (Task 6); `mediaTypeOf` (Task 3).
- Produces:
  - `send.ts`:
    - `sendFile(ctx: Ctx, abs: string, opts: { type: string; download?: string; cache: 'immutable' | 'revalidate' | 'static' }): Promise<void>`. It handles HEAD, a weak ETag `W/"<size>-<mtimeMs>"` with 304 on `If-None-Match`, one byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`) → 206 with `Content-Range`, unsatisfiable → 416 with `Content-Range: bytes */<size>`, and `Accept-Ranges: bytes`.
    - Cache headers: `immutable` → `Cache-Control: private, max-age=31536000, immutable`; `revalidate` → `private, no-cache`; `static` → `public, max-age=31536000, immutable`.
    - `contentDisposition(kind: 'inline' | 'attachment', name: string): string` → `<kind>; filename="<ASCII fallback: non-ASCII, ", \ and control chars replaced by _>"; filename*=UTF-8''<encodeURIComponent, plus ' ( ) * percent-encoded>`.
  - `thumbs.ts`:
    - `interface Thumbnailer { thumb(abs: string, rel: string, st: { size: number; mtimeMs: number }, kind: MediaKind): Promise<string>; preview(abs: string, rel: string, st: { size: number; mtimeMs: number }): Promise<string> }` (both return a cache file path)
    - `createThumbnailer(cfg: Config, run: RunFn = runProcess): Thumbnailer`
  - Endpoints (`requireUser`; the path must be a media file, else 404):
    - `GET /media/thumb?path=&v=` → JPEG, immutable
    - `GET /media/view?path=` → HEIC/HEIF as a JPEG preview; others as the original with `viewMime ?? mime`, inline, revalidate
    - `GET /media/download?path=` → the original as an attachment with `mime`
    - Thumbnail/preview failure → 422 `No preview available`

- [ ] **Step 1: Write the failing tests**

```ts
test('sendFile ranges, HEAD, 304, 416', async (t) => {
  // seed 'pics/v.mp4' = fixture clip.mp4; admin client a
  const url = '/media/download?path=' + encodeURIComponent('/pics/v.mp4');
  const size = (await stat(join(ta.media, 'pics/v.mp4'))).size;
  const full = await a.req('GET', url);
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(Number(full.headers.get('content-length')), size);
  const part = await a.req('GET', url, undefined, { range: 'bytes=0-9' });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 0-9/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await (await a.req('GET', url, undefined, { range: 'bytes=-5' })).arrayBuffer()).byteLength, 5);
  const bad = await a.req('GET', url, undefined, { range: `bytes=${size}-` });
  assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
  assert.equal((await a.req('HEAD', url)).status, 200);
  assert.equal((await a.req('GET', url, undefined, { 'if-none-match': full.headers.get('etag')! })).status, 304);
});
test('download name encoding (Review Focus 1)', async () => {
  const r = await a.req('GET', '/media/download?path=' + encodeURIComponent('/pics/Дача #2 (2024)/Фото 50%.jpg'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="____ 50%.jpg"; filename*=UTF-8''${encodeURIComponent('Фото 50%.jpg')}`);
});
test('view types and access control', async () => {
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/m.mov'))).headers.get('content-type'), 'video/mp4');
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/a.jpg'))).headers.get('content-type'), 'image/jpeg');
  assert.equal((await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics'))).status, 404);
  assert.equal((await papa.req('GET', '/media/download?path=' + encodeURIComponent('/pics/a.jpg'))).status, 404);   // papa only has 'Fam'
});
test('video thumbnail is generated once and cached', { skip: !hasCommand('ffmpeg') }, async () => {
  const r = await a.req('GET', '/media/thumb?v=1&path=' + encodeURIComponent('/pics/v.mp4'));
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await readdir(join(ta.cfg.dataDir, 'cache/thumbs'))).length, 1);
});
test('photo + HEIC thumbnails and HEIC preview', { skip: !hasCommand('vipsthumbnail') }, async () => {
  for (const p of ['/pics/a.jpg', '/pics/s.heic']) assert.equal((await a.req('GET', '/media/thumb?v=1&path=' + encodeURIComponent(p))).status, 200, p);
  const v = await a.req('GET', '/media/view?path=' + encodeURIComponent('/pics/s.heic'));
  assert.equal(v.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await a.json('GET', '/media/thumb?v=1&path=' + encodeURIComponent('/pics/corrupt.jpg')), { status: 422, body: { error: 'No preview available' } });
});
test('concurrent requests share one job', async () => {
  let calls = 0;
  const th = createThumbnailer(ta.cfg, async (_c, args) => { calls++; await new Promise((r) => setTimeout(r, 50)); await writeFile(args.at(-1)!.replace(/\[.*$/, ''), 'x'); return ''; });
  const st = { size: 1, mtimeMs: 1 };
  await Promise.all([th.thumb('/x.jpg', 'x.jpg', st, 'photo'), th.thumb('/x.jpg', 'x.jpg', st, 'photo')]);
  assert.equal(calls, 1);
});
```
(Seed: `pics/a.jpg`, `pics/v.mp4` (clip.mp4), `pics/m.mov` (clip.mp4 bytes), `pics/s.heic` (sample.heic), `pics/corrupt.jpg`, `pics/Дача #2 (2024)/Фото 50%.jpg`, `fam/x.jpg`. Papa has the share `Fam → fam`.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/media.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - Cache key: `sha1(rel + '\0' + size + '\0' + mtimeMs)`. Files go to `cache/thumbs/<key>.jpg` and `cache/previews/<key>.jpg`. Write to `<final>.<rand>.tmp.jpg`, then rename.
  - In-flight `Map<key, Promise>` for dedupe; a limiter of `Math.min(4, availableParallelism())`.
  - Commands (the output arg is always last):
    - photo: `vipsthumbnail <abs> --size 480x480> -o <tmp>[Q=80,strip]` (30 s)
    - video: `ffmpeg -v error -ss 1 -i <abs> -frames:v 1 -vf scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease -y <tmp>` (30 s). If the output is missing or empty, retry with `-ss 0`.
    - HEIC preview: `vipsthumbnail <abs> --size 2560x2560> -o <tmp>[Q=85,strip]` (60 s)
  - Any failure → `HttpError(422, 'No preview available')`.

- [ ] **Step 4: Run, expect pass.** `npm test`, then `npm run test:docker`. Expected: PASS; in Docker the vips test runs, not skipped.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: thumbnails, HEIC previews, range-capable media serving"`

---

### Task 10: Create folder, rename, move

**Files:**
- Create: `server/fsops.ts`, `server/fileroutes.ts`, `server/test/fsops.test.ts`
- Modify: `server/app.ts`

**Interfaces:**
- Consumes: `locate`, `requireRight`, `requireUnprotected`, `childAbs`, `joinVpath` (Task 6); `validateName`, `splitExt` (Task 3); `rewriteSharePaths` (Task 7); `invalidateStats` (Task 8).
- Produces:
  - `fsops.ts`:
    - `mapFsError(e: unknown): never`:
      - `EROFS`/`EACCES`/`EPERM` → 409 `This folder is read-only on disk`
      - `ENOSPC` → 507 `Disk is full`
      - `EEXIST`/`ENOTEMPTY` → 409 `A file or folder with that name already exists`
      - `ENOENT` → 404
      - anything else is rethrown
    - `makeFolder(app, user: Me, parent: string, name: string): Promise<{ name: string }>`
    - `renameItem(app, user, path: string, name: string): Promise<{ name: string }>`
    - `moveItems(app, user, paths: string[], to: string): Promise<{ moved: number }>`
  - Endpoints (`requireUser`, JSON):
    - `POST /api/mkdir {path, name}`
    - `POST /api/rename {path, name}`
    - `POST /api/move {paths, to}`
- Rules:
  - mkdir needs `create` on the parent. The `mediaRoot` level and the member root have `create` false → 403.
  - rename/move need `update` and an unprotected item.
  - Files keep their extension: compare lowercased `splitExt`; a mismatch → 400 `File extension can't be changed`.
  - The target name must not exist (`lstat` first → 409), then `fs.rename`.
  - Move:
    - Every source and the target must share one `scope`, else 400 `Items can only be moved within the same shared folder`.
    - The target must not be the source or inside it → 400 `Can't move a folder into itself`.
    - Items are processed in order and the first error is thrown; items moved before it stay moved.
  - Every successful rename/move of a folder calls `rewriteSharePaths(oldRel, newRel)`. Every mutation calls `invalidateStats()` and `log(...)`.

- [ ] **Step 1: Write the failing tests**

```ts
test('mkdir rights and validation', async () => {
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'New' })).status, 200);
  assert.ok((await stat(join(ta.media, 'pics/family/New'))).isDirectory());
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'New' })).body.error, 'A file or folder with that name already exists');
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/Fam', name: 'a:b' })).status, 400);
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/RO', name: 'x' })).body.error, "You don't have permission to do that");
  assert.equal((await papa.json('POST', '/api/mkdir', { path: '/', name: 'x' })).status, 403);
  assert.equal((await admin.json('POST', '/api/mkdir', { path: '/', name: 'x' })).status, 403);
});
test('rename keeps extension, protects roots, rewrites shares', async () => {
  assert.deepEqual((await editor.json('POST', '/api/rename', { path: '/Fam/a.jpg', name: 'b.JPG' })).body, { name: 'b.JPG' });
  assert.equal((await editor.json('POST', '/api/rename', { path: '/Fam/b.JPG', name: 'b.png' })).body.error, "File extension can't be changed");
  assert.equal((await editor.json('POST', '/api/rename', { path: '/Fam', name: 'X' })).body.error, "This folder can't be renamed, moved or deleted");
  assert.equal((await admin.json('POST', '/api/rename', { path: '/pics', name: 'P' })).status, 403);
  await editor.json('POST', '/api/rename', { path: '/Fam/xmas', name: 'Christmas' });     // 'xmas' is Mama's share root
  assert.equal(ta.db.prepare('select rel_path from shares where alias=?').get('Xmas')!.rel_path, 'pics/family/Christmas');
});
test('move rules', async () => {
  assert.deepEqual((await editor.json('POST', '/api/move', { paths: ['/Fam/c.jpg'], to: '/Fam/Christmas' })).body, { moved: 1 });
  assert.equal((await editor.json('POST', '/api/move', { paths: ['/Fam/Christmas'], to: '/Fam/Christmas/sub' })).body.error, "Can't move a folder into itself");
  assert.equal((await editor.json('POST', '/api/move', { paths: ['/Fam/d.jpg'], to: '/Other' })).body.error, 'Items can only be moved within the same shared folder');
  assert.equal((await papa.json('POST', '/api/move', { paths: ['/Fam/d.jpg'], to: '/Fam/Christmas' })).status, 403);
});
test('read-only on disk (Review Focus 3)', { skip: process.getuid?.() === 0 }, async (t) => {
  await chmod(join(ta.media, 'pics/family'), 0o555); t.after(() => chmod(join(ta.media, 'pics/family'), 0o755));
  assert.deepEqual(await editor.json('POST', '/api/mkdir', { path: '/Fam', name: 'Nope' }), { status: 409, body: { error: 'This folder is read-only on disk' } });
});
```
Setup in `before()`:
- `papa` has `Fam → pics/family` (create only) and `RO → pics/ro` (read only).
- `editor` has `Fam → pics/family` (create, update, delete) and `Other → pics/other` (all).
- `mama` has `Xmas → pics/family/xmas`.
- Files: `pics/family/{a.jpg,c.jpg,d.jpg,xmas/,xmas/sub/}`, `pics/other/`, `pics/ro/`.

- [ ] **Step 2: Run, expect failure.** `node --test server/test/fsops.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces rules.
- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: create folder, rename, move with share path rewrite"`

---

### Task 11: Recycle Bin

**Files:**
- Create: `server/trash.ts`, `server/test/trash.test.ts`
- Modify: `server/fileroutes.ts`, `server/adminroutes.ts`, `server/main.ts`

**Interfaces:**
- Consumes: `locate`, `requireRight`, `requireUnprotected` (Task 6); `mapFsError` (Task 10); `restoredName` (Task 3); `invalidateStats` (Task 8).
- Produces:
  - `trash.ts`:
    - `TRASH_DIR = '.gallery-trash'`
    - `deletePreview(app, user, paths: string[]): Promise<DeletePreview>`. `hiddenFiles` counts regular files inside the selected folders that the gallery doesn't show: hidden names or non-media extensions, recursively.
    - `trashItems(app, user, paths: string[]): Promise<{ deleted: number }>`
    - `listTrash(cfg, db): TrashItem[]` (newest first)
    - `restoreTrash(cfg, db, id: string): Promise<{ restoredAs: string }>` (the absolute display path)
    - `purgeTrash(cfg, db, id: string): Promise<void>`, `emptyTrash(cfg, db): Promise<void>`
    - `purgeExpired(cfg, db, days: number, now = Date.now()): Promise<number>`
  - Endpoints:
    - `POST /api/delete/preview {paths}` → `DeletePreview`
    - `POST /api/delete {paths}` → `{ deleted }` (needs `delete` + unprotected)
    - Admin: `GET /api/admin/trash`, `POST /api/admin/trash/:id/restore`, `DELETE /api/admin/trash/:id`, `DELETE /api/admin/trash`
  - `main.ts`: run `purgeExpired(cfg, db, cfg.trashDays)` at start and every 24 h (`setInterval(...).unref()`).

- [ ] **Step 1: Write the failing tests**

```ts
test('delete moves into the top-level trash and records it', async () => {
  assert.deepEqual((await editor.json('POST', '/api/delete', { paths: ['/Fam/a.jpg'] })).body, { deleted: 1 });
  const [row] = (await admin.json('GET', '/api/admin/trash')).body;
  assert.deepEqual([row.name, row.originalPath, row.isDir, row.deletedBy], ['a.jpg', join(ta.media, 'pics/family/a.jpg'), false, 'editor']);
  assert.ok(await stat(join(ta.media, 'pics', '.gallery-trash', row.id, 'a.jpg')));
  assert.equal((await editor.json('GET', '/api/list?path=' + encodeURIComponent('/Fam'))).body.entries.some((e: any) => e.name === 'a.jpg'), false);
});
test('rights, protection, preview counts', async () => {
  assert.equal((await papa.json('POST', '/api/delete', { paths: ['/Fam/b.jpg'] })).status, 403);
  assert.equal((await editor.json('POST', '/api/delete', { paths: ['/Fam'] })).status, 403);
  assert.deepEqual((await editor.json('POST', '/api/delete/preview', { paths: ['/Fam/mixed'] })).body, { items: 1, hiddenFiles: 2 });   // mixed/{x.jpg,y.jpg,notes.txt,.DS_Store}
  assert.equal((await papa.json('GET', '/api/admin/trash')).status, 403);
  assert.equal((await admin.json('GET', '/api/list?path=' + encodeURIComponent('/pics/.gallery-trash'))).status, 400);
});
test('restore: name clash, missing parent, share comes back', async () => {
  await editor.json('POST', '/api/delete', { paths: ['/Fam/xmas'] });                       // Mama's share root
  assert.equal((await admin.json('GET', `/api/admin/users/${mamaId}/shares`)).body[0].available, false);
  const items = (await admin.json('GET', '/api/admin/trash')).body as any[];
  await admin.json('POST', `/api/admin/trash/${items.find((i) => i.name === 'xmas').id}/restore`);
  assert.equal((await admin.json('GET', `/api/admin/users/${mamaId}/shares`)).body[0].available, true);
  await writeFile(join(ta.media, 'pics/family/a.jpg'), 'new');
  const r = await admin.json('POST', `/api/admin/trash/${items.find((i) => i.name === 'a.jpg').id}/restore`);
  assert.equal(r.body.restoredAs, join(ta.media, 'pics/family/a (restored).jpg'));
});
test('purge, empty, expiry', async () => {
  await editor.json('POST', '/api/delete', { paths: ['/Fam/b.jpg', '/Fam/c.jpg'] });
  const [x, y] = (await admin.json('GET', '/api/admin/trash')).body as any[];
  ta.db.prepare('update trash set deleted_at=? where id=?').run(Date.now() - 31 * 86_400_000, x.id);
  assert.equal(await purgeExpired(ta.cfg, ta.db, 30), 1);
  await assert.rejects(stat(join(ta.media, 'pics', '.gallery-trash', x.id)));
  await admin.json('DELETE', '/api/admin/trash');
  assert.deepEqual((await admin.json('GET', '/api/admin/trash')).body, []);
});
```
(Users: `editor` has `Fam → pics/family` with all rights; `papa` has `Fam` read-only; `mama` has `Xmas → pics/family/xmas`. Files: `pics/family/{a.jpg,b.jpg,c.jpg,xmas/x.jpg,mixed/{x.jpg,y.jpg,notes.txt,.DS_Store}}`.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/trash.test.ts` → FAIL.
- [ ] **Step 3: Implement**
  - Trash id: `randomBytes(8).toString('hex')`. Create `join(mediaRoot, top, TRASH_DIR, id)`, then rename the item into it.
  - The row stores `top_rel`, `original_rel`, `size` (recursive file sizes), `hidden_files` and the `deleted_by` username.
  - Restore: create parent folders as needed. On a clash, try `restoredName(name, 1..)` until free. Rename back, then remove the row and the id dir.
  - Purge: `rm(dir, { recursive: true, force: true })` plus delete the row.
  - All of these call `invalidateStats()` and `log`.
- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: recycle bin with restore, purge and daily expiry"`

---

### Task 12: Chunked uploads

**Files:**
- Create: `server/uploads.ts`, `server/test/uploads.test.ts`
- Modify: `server/fileroutes.ts`, `server/main.ts`

**Interfaces:**
- Consumes: `locate`, `requireRight` (Task 6); `sanitizeUploadName`, `nextFreeName`, `mediaTypeOf`, `checkMagic` (Task 3); `mapFsError` (Task 10); `invalidateStats` (Task 8).
- Produces:
  - `uploads.ts`:
    - `CHUNK_MAX = 16 * 1024 * 1024`
    - `startUpload(app, user: Me, input: { dir: string; name: string; size: number }): Promise<{ id: string }>`
    - `writeChunk(app, user: Me, id: string, offset: number, body: Buffer): Promise<{ received: number } | { done: true; name: string }>`
    - `cancelUpload(app, user: Me, id: string): Promise<void>`
    - `cleanupUploads(db, now = Date.now(), olderThanMs = 86_400_000): Promise<number>`
  - Endpoints:
    - `POST /api/upload/start {dir, name, size}` → `{ id }`
    - `PUT /api/upload/:id?offset=N` (body `application/octet-stream`, limit `CHUNK_MAX` → 413 `Chunk too large`)
    - `DELETE /api/upload/:id` → `{ ok: true }`
  - `main.ts`: run `cleanupUploads` hourly (`unref`).
- Rules:
  - start:
    1. `create` right on `dir`.
    2. `mediaTypeOf(sanitized name)` must exist → else 415 `Only photos and videos can be uploaded`.
    3. `size > 0` → else 400 `File is empty`.
    4. `size ≤ maxUploadBytes` → else 413 `File is larger than the <MAX_UPLOAD_MB> MB limit`.
    5. Create the temp file `<dir>/.upload-<id>` with flag `wx` (`id = randomBytes(16).hex`) and insert the row.
  - chunk:
    - The row must belong to the user, else 404.
    - `offset !== received` → 409 `{ error: 'Upload out of sync', received }`.
    - At offset 0, `checkMagic` on the body head; a failure removes the temp file and row → 415 `File content doesn't match its type`.
    - Chunks exceeding the declared size → 400 `Upload is larger than declared`.
    - Write errors go through `mapFsError`. On `ENOSPC`, remove the temp file and the row first.
  - finalize when `received === size`:
    1. For `n = 0..`: name = `n ? nextFreeName(name, n) : name`; `fs.link(temp, final)`. `EEXIST` → next n. `EPERM`/`ENOTSUP`/`EXDEV` → `copyFile(temp, final, COPYFILE_EXCL)`.
    2. Unlink the temp file, delete the row, `invalidateStats`, `log('upload')`.

- [ ] **Step 1: Write the failing tests**

```ts
const put = (c: Client, id: string, off: number, b: Buffer) => c.req('PUT', `/api/upload/${id}?offset=${off}`, b, { 'content-type': 'application/octet-stream' });
test('chunked upload completes, no overwrite', async () => {
  const jpg = await readFile(fixture('exif-rot6.jpg'));
  const { body: { id } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'a.jpg', size: jpg.length });
  assert.deepEqual(await (await put(editor, id, 0, jpg.subarray(0, 100))).json(), { received: 100 });
  assert.deepEqual(await (await put(editor, id, 100, jpg.subarray(100))).json(), { done: true, name: 'a (1).jpg' });   // a.jpg already exists
  assert.deepEqual(await readFile(join(ta.media, 'pics/family/a (1).jpg')), jpg);
  assert.equal((await readdir(join(ta.media, 'pics/family'))).some((n) => n.startsWith('.upload-')), false);
});
test('validation', async () => {
  const s = (body: object) => editor.json('POST', '/api/upload/start', body);
  assert.equal((await s({ dir: '/Fam', name: 'x.txt', size: 5 })).body.error, 'Only photos and videos can be uploaded');
  assert.equal((await s({ dir: '/Fam', name: 'x.jpg', size: 0 })).body.error, 'File is empty');
  assert.equal((await s({ dir: '/Fam', name: 'x.jpg', size: 2 * 1024 * 1024 })).body.error, 'File is larger than the 1 MB limit');   // test app maxUploadBytes = 1 MiB
  assert.equal((await papa.json('POST', '/api/upload/start', { dir: '/Fam', name: 'x.jpg', size: 5 })).status, 403);
  const { body: { id } } = await s({ dir: '/Fam', name: 'x.jpg', size: 8 });
  assert.equal((await put(editor, id, 4, Buffer.alloc(4))).status, 409);
  assert.equal((await put(papa, id, 0, Buffer.alloc(4))).status, 404);
  assert.equal((await (await put(editor, id, 0, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).json()).error, "File content doesn't match its type");
  const { body: { id: id2 } } = await s({ dir: '/Fam', name: '../..evil:name.jpg', size: 3 });
  const done = await (await put(editor, id2, 0, Buffer.from([0xff, 0xd8, 0xff]))).json();
  assert.ok(!done.name.includes('/') && !done.name.startsWith('.'));
});
test('two uploads of the same name (Review Focus 5)', async () => {
  const jpg = await readFile(fixture('exif-rot6.jpg'));
  const ids = await Promise.all([1, 2].map(async () => (await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'b.jpg', size: jpg.length })).body.id));
  const names = await Promise.all(ids.map(async (id) => (await (await put(editor, id, 0, jpg)).json()).name));
  assert.deepEqual(names.sort(), ['b (1).jpg', 'b.jpg']);
});
test('cancel and stale cleanup', async () => {
  const { body: { id } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'c.jpg', size: 10 });
  await editor.json('DELETE', `/api/upload/${id}`);
  const { body: { id: old } } = await editor.json('POST', '/api/upload/start', { dir: '/Fam', name: 'd.jpg', size: 10 });
  ta.db.prepare('update uploads set updated_at=? where id=?').run(Date.now() - 2 * 86_400_000, old);
  assert.equal(await cleanupUploads(ta.db), 1);
  assert.equal((await readdir(join(ta.media, 'pics/family'))).some((n) => n.startsWith('.upload-')), false);
});
```
(Test app: `maxUploadBytes: 1024 * 1024`. `editor` has `Fam → pics/family` with all rights, `papa` has it read-only; `pics/family/a.jpg` exists.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/uploads.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the rules. Append with `fs.open(temp, 'r+')` and `write(body, 0, len, offset)`; update `received` and `updated_at`.
- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: chunked uploads with magic check and no-overwrite naming"`

---

### Task 13: Zip download

**Files:**
- Create: `server/zip.ts`, `server/test/zip.test.ts`
- Modify: `server/mediaroutes.ts`

**Interfaces:**
- Consumes: `locate` (Task 6); `mediaTypeOf`, `isHiddenName` (Task 3); `contentDisposition` (Task 9).
- Produces:
  - `streamZip(ctx: Ctx, app: App, user: Me, paths: string[]): Promise<void>`
  - Endpoint `POST /media/zip`: form field `paths` = JSON array of virtual paths, body read via `readForm`.
- Rules:
  - All paths are resolved first; any failure → its error status before streaming.
  - Files: media only (`addFile(abs, name, { compress: false })`).
  - Folders: walk recursively, skipping hidden names, symlinks and non-media files. Entries go under `<folder name>/…`; an empty folder → `addEmptyDirectory`.
  - Zip name: a single folder → `<folder>.zip`; otherwise the parent folder's name + `.zip`; at a root → `Home Gallery.zip`.
  - Headers: `Content-Type: application/zip` and `contentDisposition('attachment', zipName)`.

- [ ] **Step 1: Write the failing tests**

```ts
const zipNames = (buf: Buffer) => { const out: string[] = []; for (let i = buf.indexOf('PK\x01\x02', 0, 'latin1'); i !== -1; i = buf.indexOf('PK\x01\x02', i + 4, 'latin1')) out.push(buf.toString('utf8', i + 46, i + 46 + buf.readUInt16LE(i + 28))); return out; };
const zip = (c: Client, paths: string[], ct = 'application/x-www-form-urlencoded') => c.req('POST', '/media/zip', new URLSearchParams({ paths: JSON.stringify(paths) }).toString(), { 'content-type': ct });
test('zips media only, keeps folders, unicode names (Review Focus 1)', async () => {
  const r = await zip(papa, ['/Fam/xmas', '/Fam/a.jpg']);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition')!, /filename\*=UTF-8''Fam\.zip$/);
  assert.deepEqual(zipNames(Buffer.from(await r.arrayBuffer())).sort(), ['a.jpg', 'xmas/b.jpg', 'xmas/empty/', 'xmas/Дача #2 (2024)/IMG 50%.jpg'].sort());
});
test('single folder name, access control, content type', async () => {
  assert.match((await zip(papa, ['/Fam/xmas'])).headers.get('content-disposition')!, /xmas\.zip$/);
  assert.equal((await zip(papa, ['/Other/x.jpg'])).status, 404);
  assert.equal((await zip(papa, ['/Fam/a.jpg'], 'application/json')).status, 415);
});
```
(Files: `pics/family/{a.jpg,notes.txt,xmas/b.jpg,xmas/.DS_Store,xmas/c.txt,xmas/empty/,xmas/Дача #2 (2024)/IMG 50%.jpg}`, plus a symlink `pics/family/xmas/ln → ../../../other`. `papa` has `Fam → pics/family`.)

- [ ] **Step 2: Run, expect failure.** `node --test server/test/zip.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `new yazl.ZipFile()`: add the entries, `zip.outputStream.pipe(ctx.res)`, then `zip.end()`.
- [ ] **Step 4: Run, expect pass.** `npm test` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: streamed zip download of selections and folders"`

---

### Task 14: Web scaffold, SPA serving, login and setup pages

**Files:**
- Create:
  - Root: `vite.config.ts`
  - Web: `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`
  - Libs: `web/src/lib/route.ts`, `web/src/lib/format.ts`
  - UI kit: `web/src/ui/app.css`, `web/src/ui/Icon.tsx`, `web/src/ui/controls.tsx`, `web/src/ui/hooks.ts`
  - Pages: `web/src/pages/Login.tsx`, `web/src/pages/Setup.tsx`
  - Server: `server/static.ts`
  - Script: `scripts/seed-dev.sh`
  - Tests: `web/src/lib/route.test.ts`, `web/src/lib/format.test.ts`, `server/test/static.test.ts`
- Modify: `server/app.ts` (SPA fallback), `package.json` (scripts `dev:server`, `dev:web`, `build`, `seed`)

**Interfaces:**
- Produces:
  - `api.ts`:
    - `class ApiError extends Error { status: number }`
    - `api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>`. It throws `ApiError(server message)`. On 401 (except from `/api/login` and `/api/session`) it dispatches `window` event `gallery:unauthorized`.
    - `q(vpath: string): string` (encodeURIComponent)
    - `thumbUrl(vpath: string, mtime: number): string`, `viewUrl(vpath: string): string`, `downloadUrl(vpath: string): string`
    - `submitZip(paths: string[]): void` (hidden form POST to `/media/zip`)
  - `route.ts`:
    - `vpathFromLocation(pathname: string): string` (`/browse` or `/browse/` → `/`; segments decoded)
    - `browseHref(vpath: string): string` (each segment `encodeURIComponent`)
    - `parentOf(vpath: string): string | null`, `nameOf(vpath: string): string`, `joinV(parent: string, name: string): string`
  - `format.ts`:
    - `fmtDate(wallClock: string): string`, design format: `Mar 14, 2026  09:00` (two spaces, 24 h, en-US)
    - `fmtSize(bytes: number): string`: ≥ 1e9 → `x.x GB`, ≥ 1e6 → `x.x MB`, else `N KB` rounded
    - `fmtDur(seconds: number): string` (`m:ss`)
    - `initials(name: string): string`
    - `avatarColor(id: number): string` (design palette `['#005fb8', '#8a5a00', '#2f7d32', '#a4373a', '#5c2e91', '#00737a']`, index `id % 6`)
  - `controls.tsx`: `Seg` (segmented control, design `SEG` look), `Toggle` (design toggle), `Button` (`variant: 'primary' | 'default'`), `Avatar`, `Dialog` (centered card with `popIn` animation; Esc closes).
  - `hooks.ts`: `useMediaQuery(q: string): boolean`; `useNarrow()` = `(max-width: 699px)`; `useWide()` = `(min-width: 1100px)`.
  - `Icon.tsx`: `Icon({ name, size })` with the inline SVG paths from the design (folder, back, forward, up, search, play, pause, prev, next, close, large, medium, details, sort, select, settings, user, upload, newFolder, rename, move, delete, download, menu, fullscreen). Icons the design lacks are drawn in the same 16×16, 1.4–1.6 stroke style.
  - `server/static.ts`: `serveWeb(ctx: Ctx, cfg: Config): Promise<void>`. `GET /assets/*` → files from `webDist` via `sendFile` with cache `static`. Any other non-`/api`, non-`/media` GET → `index.html` with cache `revalidate`. Paths are normalized and must stay inside `webDist`. A missing `webDist` → 404 text `Web UI not built (run npm run build)`.
  - `App.tsx` boot:
    1. `GET /api/session`.
    2. `setupRequired` → `<Setup>`, which reads `token` from the query; without a token it shows `Open the setup link printed in the container log.`
    3. `user === null` → `<Login>` (keeps the current URL).
    4. Otherwise render `<Explorer me={user}>`. In this task, a placeholder showing `Signed in as …` with a Sign out button. If the path isn't under `/browse`, `history.replaceState` to `/browse/`.
    5. Listen for `gallery:unauthorized` → set the user to null.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/route.test.ts
test('route helpers', () => {
  assert.equal(vpathFromLocation('/browse'), '/'); assert.equal(vpathFromLocation('/browse/'), '/');
  assert.equal(vpathFromLocation('/browse/Family%20photos/%D0%94%D0%B0%D1%87%D0%B0%20%232'), '/Family photos/Дача #2');
  assert.equal(browseHref('/Family photos/IMG 50%'), '/browse/Family%20photos/IMG%2050%25');
  assert.equal(parentOf('/a/b'), '/a'); assert.equal(parentOf('/a'), '/'); assert.equal(parentOf('/'), null);
  assert.equal(nameOf('/a/b'), 'b'); assert.equal(joinV('/', 'a'), '/a'); assert.equal(joinV('/a', 'b'), '/a/b');
});
// web/src/lib/format.test.ts
test('formatting matches the design', () => {
  assert.equal(fmtDate('2026-03-14T09:00:00'), 'Mar 14, 2026  09:00');
  assert.equal(fmtSize(1.8e6), '1.8 MB'); assert.equal(fmtSize(2.5e9), '2.5 GB'); assert.equal(fmtSize(512_400), '512 KB');
  assert.equal(fmtDur(98), '1:38'); assert.equal(fmtDur(9), '0:09');
  assert.equal(initials('Alex Morgan'), 'AM'); assert.equal(initials('papa'), 'P'); assert.equal(initials(''), '?');
  assert.equal(avatarColor(7), '#8a5a00');
});
// server/test/static.test.ts
test('SPA fallback and assets', async (t) => {
  const dist = await tempDir(); await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html>app'); await writeFile(join(dist, 'assets/x.js'), 'js');
  const ta = await startTestApp({ webDist: dist }); t.after(() => ta.close());
  const page = await fetch(ta.url + '/browse/Fam/x');
  assert.equal(await page.text(), '<!doctype html>app'); assert.equal(page.headers.get('cache-control'), 'private, no-cache');
  const js = await fetch(ta.url + '/assets/x.js');
  assert.equal(await js.text(), 'js'); assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await (await fetch(ta.url + '/assets/..%2F..%2Fpackage.json')).text(), '<!doctype html>app');
  assert.equal((await fetch(ta.url + '/api/nope')).status, 404);
});
```

- [ ] **Step 2: Run, expect failure.** `npm test` → FAIL for these three files.
- [ ] **Step 3: Implement**
  - `vite.config.ts`: `root: 'web'`, `plugins: [react()]`, `build: { outDir: 'dist', emptyOutDir: true }`, `server.proxy` for `/api`, `/media` and `/healthz` → `http://localhost:8080` with the default `changeOrigin: false`.
  - Scripts:

```bash
npm pkg set scripts.dev:server="MEDIA_ROOT=dev-data/media DATA_DIR=dev-data/data COOKIE_SECURE=false node --watch --disable-warning=ExperimentalWarning server/main.ts" scripts.dev:web="vite" scripts.build="vite build" scripts.seed="sh scripts/seed-dev.sh"
```

  - `scripts/seed-dev.sh` creates the following with `ffmpeg` (JPEG frames from `testsrc`/`mandelbrot` at 1600×1200 with different `-ss` offsets; 3-second MP4s):
    - `dev-data/media/photos/{Travel/{Iceland 2026,Lisbon 2025},Family/{Birthdays,Summer house},Camera roll}`, with 6–20 photos and 1–2 videos each
    - `dev-data/media/photos/Family/notes.txt`
    - one `Дача #2 (2024)` folder
  - CSS: `app.css` holds the design's keyframes (lines 10–22), the base font/colors, `:focus-visible` outlines and phone media queries; the rest of the styling is inline, copied from the design.
  - Login: centered white card on `#eef1f5` with the app icon (title-bar logo at 32 px), "Home Gallery", Username, Password, "Remember me" (Toggle, on by default), and a primary "Sign in" button. Errors show the server message in red below the button.
  - Setup: same card plus a Display name field, button "Create admin account".

- [ ] **Step 4: Run tests and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, and `web/dist/index.html` exists.

- [ ] **Step 5: Manual check**
  1. `npm run seed`, then `npm run dev:server` (note the setup link in the log) and `npm run dev:web`.
  2. Open `http://localhost:5173/setup?token=<token>`, create the admin, and see the placeholder "Signed in as …".
  3. Sign out, then sign in with a wrong password → "Wrong username or password".

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat(web): vite/react scaffold, SPA serving, login and first-run setup"`

---

### Task 15: Explorer shell — title bar, command bar, folder tree, status bar, routing

**Files:**
- Create: `web/src/explorer/Explorer.tsx`, `web/src/explorer/TitleBar.tsx`, `web/src/explorer/CommandBar.tsx`, `web/src/explorer/Sidebar.tsx`, `web/src/explorer/StatusBar.tsx`
- Modify: `web/src/App.tsx` (render `Explorer`)

**Interfaces:**
- Consumes: `api`, `route.ts`, `format.ts`, `controls.tsx`, `Icon`, `hooks.ts` (Task 14); `/api/list`, `/api/folders` (Task 8).
- Produces:
  - `Explorer({ me, onMeChange, onSignOut })` owns the state: `vpath` (from `location`), `listing: Listing | null`, `error: string | null`, `query`, `drawerOpen`, `refreshKey: number`, plus `reload(): Promise<void>` for later tasks.
  - `TitleBar({ me, onOpenSettings(tab: 'general' | 'users' | 'trash'), onSignOut })`: the menu has Settings, Users & access (admin), Recycle Bin (admin) and Sign out. The host text is `location.host`.
  - `CommandBar({ vpath, canBack, canForward, onBack, onForward, onUp, onNavigate(vpath), query, onQuery, onMenu })`
  - `Sidebar({ vpath, open, onNavigate, onClose, refreshKey })`: the root node is "Home Gallery" with children from `GET /api/folders?path=`, lazily loaded on expand and cached per path until `refreshKey` changes. The active path's ancestors auto-expand. Unavailable nodes are greyed and not clickable.
  - `StatusBar({ entries: Entry[], selected: string[] })`: `"<n> items  ·  <p> photos, <v> videos"` and `"<k> selected  ·  <size>"`, per the design's `statusCount`/`statusSel`.
- Behavior:
  - Navigation does `history.pushState({ idx }, '', browseHref(v))`. `popstate` sets `vpath` from `location`. `canBack`/`canForward` come from `idx` vs. the maximum pushed `idx`. Back/forward call `history.back()`/`history.forward()`.
  - Breadcrumbs: "Home Gallery" › segments.
  - The search box placeholder is `Search <folder name>` and filters `listing.entries` by case-insensitive substring (applied in Task 16's Items).
  - A list error (e.g. 404) shows `This folder is unavailable.` with a "Go to Home Gallery" link.
  - A member with no shares sees `No folders are shared with you yet.` at the root.
  - Phones (`useNarrow()`): the sidebar renders as a left drawer (fixed, 280 px, backdrop) toggled by a ☰ button shown at the start of the command bar; the search box collapses to an icon that expands on click.

- [ ] **Step 1: Implement** the components, porting markup and inline styles from design lines 25–100 and 208–215.
- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run build`
Expected: no errors.
Manual (dev servers from Task 14, logged in as admin; member views are checked in Task 19):
  1. The tree shows `photos` with recursive counts. Expanding works.
  2. Clicking a folder updates the URL to `/browse/photos/Travel`.
  3. Browser back/forward and the toolbar back/forward/up work.
  4. Breadcrumbs navigate.
  5. Reloading the page restores the folder.
  6. At width 600 px the tree is a drawer behind ☰.

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(web): explorer shell with tree, breadcrumbs, history routing"`

---

### Task 16: Items view, sorting, selection, keyboard

**Files:**
- Create: `web/src/lib/sort.ts`, `web/src/lib/selection.ts`, `web/src/explorer/Items.tsx`, `web/src/explorer/Toolbar.tsx`, tests `web/src/lib/sort.test.ts`, `web/src/lib/selection.test.ts`
- Modify: `web/src/explorer/Explorer.tsx`

**Interfaces:**
- Produces:
  - `sort.ts`:
    - `type SortKey = 'name' | 'date' | 'type' | 'size' | 'dims'`
    - `sortEntries(entries: Entry[], key: SortKey, dir: 1 | -1): Entry[]`: folders always first. Name compares naturally (numeric, base sensitivity). Date compares files by `takenAt` and folders by `mtime`. Type compares the `type` label (folders `File folder`). Size compares files only. Dims compares `width*height`, nulls last.
    - `cycleSort(key: SortKey): SortKey`: name → date → size → name (design `cycleSort`).
    - `SORT_LABELS: Record<SortKey, string>` = Name, Date taken, Type, Size, Dimensions.
  - `selection.ts`:
    - `interface Sel { selected: string[]; anchor: string | null }`
    - `applyClick(sel: Sel, order: string[], name: string, mods: { ctrl: boolean; shift: boolean }): Sel`
    - `selectAll(order: string[]): Sel`
  - `Toolbar({ view, onView, sortKey, sortDir, onCycleSort, allSelected, onSelectAll, onSlideshow, readOnly, children })`: `children` is the slot Task 17 fills with action buttons. View labels show only when `useWide()`.
  - `Items({ entries, vpath, view, sortKey, sortDir, onSort(key), sel, onClick(name, mods), onOpen(entry), onClear, onKey(e) })`:
    - Large tiles use `minmax(210px,1fr)`, medium `minmax(140px,1fr)` (design `VIEWS`).
    - Images use `thumbUrl(path, mtime)` with `loading="lazy"`. On error, swap to the generic photo/video icon.
    - Video tiles carry a `fmtDur` badge. Folder tiles show the cover thumbnail inside the folder shape (design lines 137–207), or a plain folder when `cover === null`.
    - Details table columns follow the design. On phones only Name and Date taken show.
    - Folders (spec 5.2.12): Date = `mtime`, Type `File folder`, Size and Dimensions blank. Folder tiles show `<count> items` under the name. A folder's cover thumbnail uses `thumbUrl(cover, entry.mtime)`.
- Behavior:
  - Clicking empty space clears the selection.
  - Keys on the items container:
    - arrows move focus (the grid uses the computed column count; details moves ±1)
    - Enter opens
    - Ctrl/Cmd+A selects all
    - Space toggles the focused item
    - Delete and F2 call `onKey`, which Task 17 handles
  - On phones, long-press (500 ms) enters selection mode, where taps toggle and checkboxes show. Leaving it: an empty selection or the "Done" button.
  - `view` starts from `me.prefs.defaultView`. The view switch changes only the current session (prefs are edited in Settings).
  - The "Read only" badge shows when `!rights.create && !rights.update && !rights.delete` and the path isn't `/`.
  - Empty states: `This folder is empty.` and `No items match “<query>”.`

- [ ] **Step 1: Write the failing tests**

```ts
// sort.test.ts
const f = (name: string, mtime = 0): Entry => ({ kind: 'folder', name, mtime, count: 0, cover: null, protected: false });
const p = (name: string, takenAt: string, size: number, w: number | null = null, h: number | null = null): Entry => ({ kind: 'photo', name, size, mtime: 0, takenAt, width: w, height: h, duration: null, type: 'JPEG image' });
test('sortEntries', () => {
  const es = [p('IMG_10.jpg', '2025-01-02T00:00:00', 5, 4, 3), f('B'), p('IMG_2.jpg', '2025-01-01T00:00:00', 9), f('a')];
  assert.deepEqual(sortEntries(es, 'name', 1).map((e) => e.name), ['a', 'B', 'IMG_2.jpg', 'IMG_10.jpg']);
  assert.deepEqual(sortEntries(es, 'name', -1).map((e) => e.name), ['B', 'a', 'IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'date', -1).filter((e) => e.kind !== 'folder').map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'size', 1).slice(2).map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(sortEntries(es, 'dims', 1).slice(2).map((e) => e.name), ['IMG_10.jpg', 'IMG_2.jpg']);
  assert.deepEqual(['name', 'date', 'size'].map((k) => cycleSort(k as SortKey)), ['date', 'size', 'name']);
});
// selection.test.ts
test('click, ctrl, shift', () => {
  const order = ['a', 'b', 'c', 'd'];
  let s = applyClick({ selected: [], anchor: null }, order, 'b', { ctrl: false, shift: false });
  assert.deepEqual(s, { selected: ['b'], anchor: 'b' });
  s = applyClick(s, order, 'd', { ctrl: true, shift: false }); assert.deepEqual(s.selected, ['b', 'd']);
  s = applyClick(s, order, 'b', { ctrl: true, shift: false }); assert.deepEqual(s.selected, ['d']);
  s = applyClick({ selected: ['b'], anchor: 'b' }, order, 'd', { ctrl: false, shift: true }); assert.deepEqual(s, { selected: ['b', 'c', 'd'], anchor: 'b' });
  assert.deepEqual(selectAll(order).selected, order);
});
```

- [ ] **Step 2: Run, expect failure.** `node --test web/src/lib/sort.test.ts web/src/lib/selection.test.ts` → FAIL.
- [ ] **Step 3: Implement** the libs, then `Toolbar` and `Items`, porting design lines 103–207.
- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.
Manual:
  1. The three views render per the design.
  2. Sort cycles and the Details headers toggle ▲/▼.
  3. Ctrl+click and Shift+click selection works, and the status bar shows `N selected · size`.
  4. Arrow keys move focus and Enter opens a folder.
  5. Search filters.
  6. `notes.txt` never shows.
  7. Phone width: long-press selects.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): tiles/details views, natural sort, selection and keyboard"`

---

### Task 17: File actions — upload, new folder, rename, move, delete, download

**Files:**
- Create: `web/src/lib/actions.ts`, `web/src/lib/upload.ts`, `web/src/explorer/Dialogs.tsx`, `web/src/explorer/UploadPanel.tsx`, tests `web/src/lib/actions.test.ts`, `web/src/lib/upload.test.ts`
- Modify: `web/src/explorer/Explorer.tsx`, `web/src/explorer/Toolbar.tsx`

**Interfaces:**
- Consumes: `/api/mkdir`, `/api/rename`, `/api/move` (Task 10); `/api/delete/preview`, `/api/delete` (Task 11); `/api/upload/*` (Task 12); `submitZip`, `downloadUrl` (Task 14).
- Produces:
  - `actions.ts`:
    - `interface ActionState { upload: boolean; newFolder: boolean; rename: boolean; move: boolean; delete: boolean; download: boolean }`
    - `actionsFor(rights: Rights, selected: Entry[]): ActionState`. upload/newFolder = `rights.create`. rename = `rights.update` with exactly one unprotected item. move = `rights.update` with ≥ 1 item and none protected. delete = `rights.delete` with ≥ 1 item and none protected. download = ≥ 1 item.
  - `upload.ts`:
    - `CHUNK = 8 * 1024 * 1024`
    - `uploadFile(file: { name: string; size: number; slice(a: number, b: number): Blob }, dir: string, onProgress: (sent: number) => void, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string>` (returns the final name)
    - Flow: `POST /api/upload/start`, then sequential `PUT`s with `content-type: application/octet-stream`. On abort → `DELETE /api/upload/:id` and throw `AbortError`. A non-OK response → throw `Error(server message)`.
  - `Dialogs.tsx`:
    - `PromptDialog({ title, label, initial, selectBase, submitLabel, onSubmit(value): Promise<void>, onClose })`. With `selectBase`, the name without its extension is preselected; server errors show inline.
    - `ConfirmDialog({ title, message, detail?, confirmLabel, onConfirm, onClose })`
    - `MoveDialog({ scopeRoot, onMove(to: string): Promise<void>, onClose })` (folder tree under `scopeRoot` via `/api/folders`)
  - `UploadPanel({ items: UploadProgress[], onCancel(i: number), onClose })`, with `interface UploadProgress { name: string; size: number; sent: number; state: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'; error?: string; finalName?: string }`
- Behavior:
  - Toolbar buttons appear only when their action flag is true: Upload, New folder | Rename, Move to…, Delete | Download.
  - Upload: a hidden `<input type=file multiple accept="image/*,video/*,.heic,.heif">` and drag-and-drop onto the content pane (directories are ignored with the message `Folders can't be uploaded — select files instead.`). The queue runs 2 at a time. When it finishes: `reload()` and bump `refreshKey`.
  - Scope root for Move: for members, the first segment of `vpath` (the alias); for admins, the first segment too (the top-level folder).
  - Delete:
    1. Call preview.
    2. Confirm message `Move <n> item(s) to the Recycle Bin?`, plus a detail line `…and <h> other files the gallery doesn't show.` when `h > 0`.
    3. For members also: `The admin can restore them.`
    4. Then `POST /api/delete`.
  - Download: one file → `location.href = downloadUrl(...)`; otherwise `submitZip(paths)`.
  - Keys: Delete → delete flow; F2 → rename (when allowed).

- [ ] **Step 1: Write the failing tests**

```ts
// actions.test.ts
const R = (c: boolean, u: boolean, d: boolean): Rights => ({ create: c, update: u, delete: d });
const file = { kind: 'photo', name: 'a.jpg' } as Entry, prot = { kind: 'folder', name: 'Fam', protected: true } as Entry;
test('actionsFor', () => {
  assert.deepEqual(actionsFor(R(true, false, false), []), { upload: true, newFolder: true, rename: false, move: false, delete: false, download: false });
  assert.deepEqual(actionsFor(R(false, true, true), [file]), { upload: false, newFolder: false, rename: true, move: true, delete: true, download: true });
  assert.equal(actionsFor(R(false, true, true), [file, file]).rename, false);
  assert.deepEqual([actionsFor(R(true, true, true), [prot]).move, actionsFor(R(true, true, true), [prot]).delete], [false, false]);
});
// upload.test.ts
test('uploadFile sends 8 MiB chunks in order', async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    if (url === '/api/upload/start') return Response.json({ id: 'U' });
    const off = Number(new URL(url, 'http://x').searchParams.get('offset')), len = (init!.body as Blob).size;
    return Response.json(off + len === 2 * CHUNK + 5 ? { done: true, name: 'v (1).mp4' } : { received: off + len });
  }) as typeof fetch;
  const sent: number[] = [];
  const name = await uploadFile(new Blob([new Uint8Array(2 * CHUNK + 5)]) as any as File, '/Fam', (s) => sent.push(s), new AbortController().signal, fake);
  assert.equal(name, 'v (1).mp4');
  assert.deepEqual(calls.slice(1), [`PUT /api/upload/U?offset=0`, `PUT /api/upload/U?offset=${CHUNK}`, `PUT /api/upload/U?offset=${2 * CHUNK}`]);
  assert.deepEqual(sent, [CHUNK, 2 * CHUNK, 2 * CHUNK + 5]);
});
test('uploadFile surfaces server errors and cancels on abort', async () => {
  const err = (async () => Response.json({ error: 'Only photos and videos can be uploaded' }, { status: 415 })) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['x']) as any, '/Fam', () => {}, new AbortController().signal, err), { message: 'Only photos and videos can be uploaded' });
  const ac = new AbortController(); const seen: string[] = [];
  const slow = (async (url: string, init?: RequestInit) => { seen.push(`${init?.method} ${url}`); if (url === '/api/upload/start') { ac.abort(); return Response.json({ id: 'Z' }); } return Response.json({ ok: true }); }) as typeof fetch;
  await assert.rejects(uploadFile(new Blob(['x']) as any, '/Fam', () => {}, ac.signal, slow), { name: 'AbortError' });
  assert.ok(seen.includes('DELETE /api/upload/Z'));
});
```
(`uploadFile` takes the name from `file.name`, falling back to `file` for the nameless Blobs these tests pass.)

- [ ] **Step 2: Run, expect failure.** `node --test web/src/lib/actions.test.ts web/src/lib/upload.test.ts` → FAIL.
- [ ] **Step 3: Implement** the libs, then the dialogs, panel and wiring.
- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.
Manual (admin):
  1. Create a folder.
  2. Upload 3 files by button and 2 by drag-and-drop; the progress panel shows and the duplicate name becomes `(1)`.
  3. Rename keeps the extension.
  4. Move to a subfolder works.
  5. Delete shows the hidden-file note for `Family`.
  6. Downloading one file gives the original; downloading two gives a zip.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): upload, new folder, rename, move, delete, download actions"`

---

### Task 18: Viewer and slideshow

**Files:**
- Create: `web/src/lib/slideshow.ts`, `web/src/slideshow/SlideshowModal.tsx`, `web/src/slideshow/Player.tsx`, test `web/src/lib/slideshow.test.ts`
- Modify: `web/src/explorer/Explorer.tsx`

**Interfaces:**
- Consumes: `/api/files`, `/api/meta` (Task 8); `viewUrl`, `downloadUrl`, `thumbUrl` (Task 14).
- Produces:
  - `slideshow.ts`:
    - `interface ShowConfig { seconds: number; transition: 'fade' | 'slide' | 'none'; shuffle: boolean; loop: boolean; videos: boolean; subfolders: boolean; scope: 'folder' | 'selected' }`
    - `defaultScope(selectedCount: number): 'folder' | 'selected'` (> 1 → selected)
    - `filterPool(items: SlideItem[], videos: boolean): SlideItem[]`
    - `shuffled<T>(items: T[], rand?: () => number): T[]` (Fisher–Yates, new array)
    - `step(idx: number, len: number, delta: 1 | -1, loop: boolean, auto: boolean): number | null`. Wraps on manual steps; returns `null` when an automatic step passes the end without loop (design `step()`).
  - `SlideshowModal({ folderName, poolCount, selectedCount, cfg, onCfg(patch), onStart, onClose })`: ports design lines 216–268, including `Start` disabled (opacity .4) when `poolCount === 0` and the subtitle `<folder> · <n> items`.
  - `Player({ items: SlideItem[], start: number, autoplay: boolean, cfg: ShowConfig, onClose })`: ports design lines 445–473.
- Behavior:
  - Pool:
    - Whole folder without subfolders → the listing's files.
    - Subfolders → `GET /api/files?path=` (capped; when `capped`, show `Showing the first 5000 items.`).
    - Selected → selected files plus `/api/files` of each selected folder.
    - Then `filterPool`, then `shuffled` if shuffle is on.
  - Defaults: `seconds` from `me.prefs.slideSeconds`; `subfolders` defaults to `prev || !hasOwnFiles`.
  - Player:
    - Photos: `<img src={viewUrl}>` with the design's `ssFade`/`ssSlide` animation. The meta line `<fmtDate> · <w × h>` comes from `GET /api/meta` when not already known. The next photo is preloaded via `new Image()`.
    - Videos: `<video src={viewUrl} controls autoPlay playsInline>`. `ended` → `step(+1, auto)`. `error` → the message `This browser can't play this video` + a Download button. While playing, the progress bar follows `currentTime/duration`.
    - Timer: only for photos while playing (`seconds`).
    - Keys: ← → Space Esc. Touch: swipe |dx| > 50 px → prev/next.
    - Fullscreen button → `document.documentElement.requestFullscreen()` / `exitFullscreen()`.
    - Counter `i / n`.
  - Double-click on a file opens `Player` with the current folder's files (sorted as displayed), `autoplay=false`, at that index.

- [ ] **Step 1: Write the failing tests**

```ts
test('slideshow helpers', () => {
  assert.equal(defaultScope(2), 'selected'); assert.equal(defaultScope(1), 'folder');
  const items = [{ kind: 'photo' }, { kind: 'video' }] as SlideItem[];
  assert.deepEqual(filterPool(items, false).map((i) => i.kind), ['photo']);
  const s = shuffled([1, 2, 3, 4], () => 0); assert.deepEqual([...s].sort(), [1, 2, 3, 4]); assert.notDeepEqual(s, [1, 2, 3, 4]);
  assert.equal(step(2, 3, 1, false, true), null); assert.equal(step(2, 3, 1, true, true), 0);
  assert.equal(step(2, 3, 1, false, false), 0); assert.equal(step(0, 3, -1, false, false), 2);
});
```

- [ ] **Step 2: Run, expect failure.** `node --test web/src/lib/slideshow.test.ts` → FAIL.
- [ ] **Step 3: Implement** the lib, modal and player.
- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.
Manual:
  1. The slideshow over `Iceland 2026` with fade, then slide, then shuffle works.
  2. A video plays to its end, then the show advances.
  3. Loop off stops at the end.
  4. Include subfolders from `photos` works.
  5. A double-clicked photo opens paused, and arrow keys move.
  6. Swipe works in Chrome devtools mobile emulation.
  7. Fullscreen toggles.
  8. Spec risk 2: play a real phone HEVC `.mov` in Chrome and Firefox and record the result in the commit message.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(web): viewer and slideshow with video playback and fallbacks"`

---

### Task 19: Settings — General, Users & access, Recycle Bin

**Files:**
- Create: `web/src/settings/Settings.tsx`, `web/src/settings/GeneralTab.tsx`, `web/src/settings/UsersTab.tsx`, `web/src/settings/AddFolderDialog.tsx`, `web/src/settings/RecycleBinTab.tsx`
- Modify: `web/src/explorer/Explorer.tsx`, `web/src/explorer/TitleBar.tsx`

**Interfaces:**
- Consumes:
  - `PUT /api/me/prefs`, `POST /api/me/password`, `POST /api/logout` (Task 5)
  - `/api/admin/users*`, `/api/admin/shares/*`, `/api/admin/browse` (Task 7)
  - `/api/admin/trash*` (Task 11)
- Produces:
  - `Settings({ me, tab, onTab, onClose, onMeChange(me: Me) })` is the window from design lines 269–444. Tabs: General; and for admins only, Users & access and Recycle Bin.
- Behavior:
  - General:
    - Browsing: the default view (`Seg`, 3 options) and the default slide time (range 2–20, label `<n> s`) save on change via `PUT /api/me/prefs`.
    - Account: `Signed in as <name> · <role>`; a Change password form (current, new) shows the server errors inline and `Password changed` on success; Sign out.
    - The design's Library section is removed.
  - Users & access (admin):
    - The left list shows `<n> users`, `+ Add user` and the users with Avatar, name and `Administrator`/`Member` (`· You` for self).
    - Add user opens a `PromptDialog`-style form: Display name, Username, Password, Role.
    - The right panel edits Display name and Username on blur (PATCH). It has `Set new password` (prompt) and Role (`Seg`; for self, locked with the text `Administrator · you can't change your own role.`). `Remove user` (not for self) asks for confirmation.
    - Members: the **Shared folders** table (Alias editable inline and saved on blur/Enter; Folder on disk shown monospace; Create / Read (locked, checked) / Update / Delete checkboxes saved on change; Remove). The caption is `Appear in <name>'s root under alias. Rights cover all subfolders.` An unavailable share gets a ⚠ and the title `Folder not found on disk`. The button is `+ Add folder`.
    - Admin users: the text `Administrators have full access to every folder.`
    - Every save flashes `Saved` for 1.5 s next to the section title.
  - AddFolderDialog: breadcrumb of `MEDIA_ROOT` + a folder list from `/api/admin/browse?path=` (click to enter, `↑ ..` to go up, selected highlight). Alias defaults to the selected folder's name. Rights checkboxes have Read locked on. Buttons: Cancel and Share (disabled until a folder is selected). Server errors show inline. This follows mockup screen 4.
  - Recycle Bin (admin):
    - Table columns: Name, Original location, Deleted by, Deleted on (`fmtDate(instantToWallClock)` — format the epoch in the browser via `new Date(ms)`), Size, and a ⚠ `Contains <n> hidden files` when `hiddenFiles > 0`.
    - Row actions: Restore and Delete permanently (confirm). An `Empty Recycle Bin` button confirms first. Note text: `Items are deleted for good after 30 days.`
- [ ] **Step 1: Implement** the components.
- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run build`
Expected: no errors.
Manual (admin, then as the member):
  1. Add user `papa`.
  2. Share `photos/Family` as `Family photos` with Create, and `photos/Travel` as `Trips` read-only.
  3. Rename an alias inline.
  4. Sign in as papa in a private window: the root shows only `Family photos` and `Trips`; `Trips` shows `Read only` and no action buttons; `Family photos` shows Upload and New folder only.
  5. As admin, remove the `Trips` share: papa's next refresh no longer shows it.
  6. Papa can't open `/browse/photos` by typing the URL (unavailable message).
  7. Delete as an editor user, then restore from the Recycle Bin.
  8. Change your own password: other browser sessions are signed out.

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(web): settings with users, shares, folder picker and recycle bin"`

---

### Task 20: Production image, compose file, README

**Files:**
- Create: `docker/gallery`, `compose.yaml`, `README.md`
- Modify: `Dockerfile` (add the `build` and `runtime` stages)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Image `home-gallery`: `CMD ["node","--disable-warning=ExperimentalWarning","server/main.ts"]` and `gallery set-password <user>` inside the container.

- [ ] **Step 1: Extend the `Dockerfile`**

```dockerfile
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production MEDIA_ROOT=/media DATA_DIR=/data PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/web/dist ./web/dist
COPY docker/gallery /usr/local/bin/gallery
RUN chmod 755 /usr/local/bin/gallery && rm -rf server/test
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
```
`docker/gallery`: `#!/bin/sh` + `exec node --disable-warning=ExperimentalWarning /app/server/main.ts "$@"`.

- [ ] **Step 2: Write `compose.yaml`**

Placeholders are marked with `# CHANGE`.
```yaml
services:
  gallery:
    build: .
    restart: unless-stopped
    user: "1000:1000"            # CHANGE: output of `id -u`:`id -g` — must own ./data and be able to write shared folders
    environment:
      TZ: Europe/Moscow          # CHANGE: your timezone (used for video/file dates)
    volumes:
      - ./data:/data
      - /home/user/pictures:/media/pictures      # CHANGE: one line per folder; add :ro if nobody gets Create/Update/Delete there
    networks: [traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik           # CHANGE: your Traefik network name
      - traefik.http.routers.gallery.rule=Host(`gallery.example.com`)   # CHANGE
      - traefik.http.routers.gallery.entrypoints=websecure              # CHANGE if different
      - traefik.http.routers.gallery.tls.certresolver=letsencrypt       # CHANGE: your resolver name
      - traefik.http.services.gallery.loadbalancer.server.port=8080
networks:
  traefik:
    external: true               # CHANGE: name of your existing Traefik network
```

- [ ] **Step 3: Write `README.md`**

Sections:
1. What it is (one paragraph).
2. Requirements (Docker; Traefik with a domain).
3. Setup:
   - `mkdir data && sudo chown 1000:1000 data`
   - edit `compose.yaml`
   - `docker compose up -d --build`
   - `docker compose logs gallery | grep setup?token` and open the link
4. Adding folders: one bind mount per folder under `/media/<name>`; `:ro` for view-only folders; the container user needs write access for Create/Update/Delete.
5. Traefik on another machine: replace `networks` and `labels` with `ports: ["<LAN-IP>:8080:8080"]`, add the Traefik file-provider snippet (router + service `http://<host-ip>:8080`), and set `TRUSTED_PROXIES=<traefik-ip>`.
6. Running on the laptop and the NAS: one gallery per machine, each with its own subdomain.
7. Sync tools: add `.gallery-trash` and `.upload-*` to Syncthing / Synology Drive ignore lists.
8. Password reset: `docker compose exec gallery gallery set-password <user>`.
9. Backup: copy `data/` (`data/cache` is optional).
10. Settings table: every env var with its default.

- [ ] **Step 4: Verify the image**

```bash
docker build -t home-gallery . \
&& docker rm -f hg-smoke 2>/dev/null; mkdir -p /tmp/hg-data && docker run -d --name hg-smoke -u "$(id -u):$(id -g)" -e COOKIE_SECURE=false \
   -p 127.0.0.1:18080:8080 -v /tmp/hg-data:/data -v "$PWD/dev-data/media/photos:/media/photos" home-gallery \
&& timeout 90 sh -c 'until [ "$(docker inspect --format "{{.State.Health.Status}}" hg-smoke)" = healthy ]; do sleep 2; done' && echo healthy \
&& docker logs hg-smoke 2>&1 | grep -c 'setup?token='
```
Expected: `healthy` and `1`.
Then: `docker exec hg-smoke gallery set-password nobody; echo $?` → usage text and `1`.
Run `npm run test:docker` → PASS.
Clean up: `docker rm -f hg-smoke`.

- [ ] **Step 5: Commit** `git add -A && git commit -m "build: production image, compose file for Traefik, README"`

---

### Task 21: End-to-end smoke run

**Files:**
- Create: `docs/smoke-checklist.md`

- [ ] **Step 1: Write the checklist.** Group it by role, one line per check with its expected result:
  - **Setup:** the setup link works once; a second visit → "Already set up".
  - **Admin:**
    - add 2 users and shares with different rights
    - the folder picker hides `@eaDir` and dot folders
    - the Recycle Bin restores
  - **Member read-only:** sees only aliases, never a `/media` path (check the page source and API responses in devtools); opening a hand-typed `/browse/<other alias or folder>` shows the unavailable message.
  - **Member with Create/Update/Delete:** upload (incl. a 200 MB video so Traefik's 60 s timeout would matter), rename, move, delete.
  - **Media:**
    - JPEG portrait orientation
    - HEIC thumbnail and view
    - MP4 and MOV playback, Range seeking
    - a corrupt file shows an icon
  - **Slideshow:** all options.
  - **Phone:** drawer, long-press, swipe.
  - **Security:**
    - a cookie without `Secure` only when `COOKIE_SECURE=false`
    - 6 wrong logins → lockout message
    - response headers match the Global Constraints list
- [ ] **Step 2: Run it** against the container from Task 20 (`http://127.0.0.1:18080`, with `COOKIE_SECURE=false`). Fix any failure in the owning task's files with a test where the failure is server-side. Tick every line.
- [ ] **Step 3: Commit** `git add -A && git commit -m "docs: end-to-end smoke checklist (all passing)"`

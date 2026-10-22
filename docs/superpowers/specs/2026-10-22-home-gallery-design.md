# Home Gallery — design

Date: 2026-10-22 · Status: approved by owner 2026-10-22 · Repo dir: `win-gallery`

Sources:
- Visual design: `docs/design/Gallery Explorer.dc.html` (template + logic; `support.js` is the mockup runtime, `.thumbnail` a WebP preview). It is the source of truth for look and feel.
- Access-model mockup agreed during brainstorming: `docs/design/access-model-mockup.html` (screens 1–4).

Tags: **[owner]** = decided or confirmed by the owner. **[call]** = Claude's call, not discussed; owner may override.

## 1. What this is and why

A self-hosted photo and video gallery that looks and behaves like Windows 11 File Explorer. The owner keeps family photos and videos on their own disks (NAS, laptop) and wants family and friends (wife, parents, friends) to browse them from anywhere over the internet. Each person sees only the folders the owner gave them, under names the owner chose, and can do only what the owner allowed. The Explorer look is deliberate: every relative already knows how a Windows folder works.

Success looks like:
- A parent opens `https://gallery.<domain>` on their PC or phone, logs in once, sees a root containing only their folders (by alias), opens photos, plays videos, runs a slideshow.
- The owner adds a user and shares a disk folder with an alias and rights in under a minute.
- Nobody reaches anything outside what was shared with them — not via URLs, thumbnails, downloads, symlinks or the recycle bin.

## 2. Goals, non-goals, anti-goals

Goals
1. Explorer-style browsing as in the design: folder tree, breadcrumbs, back/forward/up, search in folder, Large icons / Medium icons / Details, sort, multi-select, status bar. [owner]
2. Viewer and slideshow with the design's options. [owner]
3. Admin-managed users and per-user shares: real disk folder → alias → CRUD rights inherited by all subfolders. [owner]
4. Safe to expose to the internet behind the owner's existing Traefik and domain. [owner]
5. One Docker container that runs on the NAS or the laptop (x86 or ARM); all app state in one `/data` volume. [owner]

Non-goals (v1)
- Video transcoding; a video the browser can't play gets a Download button. [owner]
- 2FA. [owner]
- Languages other than English. [owner]
- Library-wide indexing, albums, tags, faces, maps, recursive or global search. [call]
- Public/anonymous share links, native mobile apps, auto-upload from phones. [call]
- Photo editing (rotate, crop), RAW formats. [call]
- Right-click context menus, drag-and-drop moving, rubber-band selection, uploading whole folders. [call]
- Members restoring from the Recycle Bin (admin only); admin "view as user" preview. [call]
- iPhone Live Photo pairing: the owner uses Android, so a HEIC+MOV pair shows as two files. Playing the motion part of Android motion photos is also out; they show as stills. [owner]

Anti-goals — failure even if everything else works
- A member reaching any file or folder outside their shares, or learning a real disk path.
- Originals lost or silently changed: a delete that can't be undone, an upload that overwrites, caches or thumbnails written into the media folders.
- A folder with a few hundred photos feeling slow to open.
- Parents fighting the UI: repeated logins, confusing errors, things that break on a phone.

## 3. Constraints

- Runs in Docker on the owner's NAS or laptop; host model/OS must not matter. NAS CPU may be weak → no heavy processing beyond thumbnails and HEIC conversion. [owner]
- Owner already runs Traefik (v3 assumed) with a domain pointed at their network; TLS terminates at Traefik. [owner]
- Traefik v3 entrypoints default `transport.respondingTimeouts.readTimeout` to 60 s for reading the whole request including the body. Any single upload request longer than 60 s is cut, so uploads must be chunked (7.4) to work with a default Traefik. [call; verified in Traefik docs]
- Content: mostly Android phone photos and videos (JPEG, sometimes HEIF; MP4 with H.264 or HEVC). HEIC and MOV are still supported because relatives with iPhones may upload them. The biggest folders hold a few hundred files; total library likely thousands to tens of thousands. [owner]
- Media volumes may contain NAS system folders (`@eaDir`, `#recycle`, `#snapshot`); they must stay invisible. [call]

## 4. Access model

### 4.1 Roles
- **Admin** [owner]: sees every folder the container can reach (everything under `MEDIA_ROOT`, real names), has full rights, manages users, shares and the Recycle Bin. Several admins are allowed (design's role toggle). An admin can't change their own role or remove themselves (as in design). [call] The last admin can't be removed or demoted.
- **Member** [owner]: sees a virtual root "Home Gallery" listing only their shares, each under its alias. Real paths are never shown.

### 4.2 Shares [owner unless tagged]
A share = (user, disk folder, alias, rights).
- Disk folder: any folder under `MEDIA_ROOT`. [call] `MEDIA_ROOT` itself can't be shared; the path is stored relative to `MEDIA_ROOT`.
- Alias: the name the member sees in their root. It belongs to that one share, so the same disk folder can go to Mama as "Holidays" and to Papa as "test1-papa" with different rights. [call] Unique per user (case-insensitive); 1–64 chars; none of `/ \ : * ? " < > |`; no leading/trailing space or dot.
- Rights: Create, Read, Update, Delete. Read is always on.
- Rights apply to the shared folder and everything below it. No per-subfolder overrides; for different rights deeper down, the admin shares that subfolder separately under its own alias.
- [call] Overlapping shares for one user (e.g. `pictures` as "All" read-only plus `pictures/family` as "Family" read+create) are allowed. Each alias is its own entry point, and the rights of the alias used in the requested path apply.
- [call] Share and rights changes take effect on the user's next request (checked per request, never cached in the session).

### 4.3 What each right allows [owner]

| Right | Allows |
|---|---|
| Read (always) | browse, thumbnails, view, slideshow, download originals (single file, or zip of a selection/folder) |
| Create | upload files, create folders |
| Update | rename files and folders; move them to another folder in the same share |
| Delete | delete files and folders (into the Recycle Bin) |

Rules [call]:
- `MEDIA_ROOT` itself is read-only for everyone: no uploads, new folders, renames or deletes at that level. Its entries are mount points, and anything written there would land in the container's throwaway filesystem.
- Top-level folders under `MEDIA_ROOT` (mount points) can't be renamed, moved or deleted by anyone. A member can't rename, move or delete the root of their own share.
- Members move only within one share. Admins move only within one top-level folder, because a cross-mount move would be a copy.
- Renaming or moving a folder that is, or contains, another share's folder rewrites those shares' stored paths so they keep working. Deleting such a folder makes the affected shares "unavailable" until the folder is restored or the admin removes the share.
- A share whose folder is missing (unmounted, deleted outside the app) shows greyed out as unavailable to the member and with a warning in the admin's shares table.

### 4.4 Recycle Bin
[owner] The bin exists, the admin can restore or empty it, and items auto-purge after 30 days. The details below are [call]:
- Delete moves the item into a hidden `.gallery-trash` folder at the top of its top-level folder (`/media/<top>/.gallery-trash`). That keeps it on the same filesystem, so delete is an instant rename, like Windows' per-drive recycle bin. The DB records original path, deleted by, deleted at, size and type.
- The admin-only "Recycle Bin" settings tab lists items with Restore, Delete permanently and Empty. A member's delete confirmation says items go to the Recycle Bin and the admin can restore them.
- Restore recreates missing parent folders. If the original name is taken, the item comes back as "name (restored).ext".
- Deleting a folder moves the whole folder to the bin, including files the gallery hides (RAW, `.AAE`, documents), as Explorer does. The confirmation tells the member how many such files go with it ("…and 12 other files the gallery doesn't show"), and bin rows flag items that contain hidden files. [call]
- A daily job purges items older than `TRASH_DAYS` (default 30).
- `.gallery-trash` is never listed, counted, zipped or reachable through browse APIs.

## 5. UI

### 5.1 Kept from the design (unless changed in 5.2)
Look and feel per `docs/design/Gallery Explorer.dc.html`: Windows 11 / Fluent style, `Segoe UI Variable` → `system-ui` fallback, accent `#005fb8`, background `#eef1f5`, the design's spacing, icons and animations.
- Title bar: app icon, "Home Gallery", the real host name instead of "gallery.local", and the user avatar + name opening a menu: Settings, Users & access (admin), Sign out.
- Command bar: back, forward, up, clickable breadcrumbs, and "Search <folder>", which filters the current folder by name.
- Sidebar: folder tree with chevrons, recursive media counts and active-folder highlight.
- Toolbar: Slideshow (primary button), Sort (cycles name → date → size, with ↑/↓), Select all/none, the "Read only" badge, and the view switch (Large icons / Medium icons / Details; labels shown at ≥ 1100 px).
- Items:
  - Tiles: folder covers, photo thumbnails, and video tiles with a duration badge.
  - Details table: Name, Date taken, Type, Size, Dimensions. Clicking a header sorts by it; clicking again flips the direction.
  - Folders always come first.
  - Click selects, Ctrl/Cmd+click toggles, double-click opens (a folder navigates, a file opens the viewer), and clicking empty space clears the selection.
- Status bar: "N items · X photos, Y videos" and "N selected · size".
- Slideshow config modal:
  - Options: slide time 2–20 s, transition Fade/Slide/None, Shuffle, Loop, Include videos, Include subfolders, and scope Whole folder / Selected (N).
  - Scope defaults to Selected when more than one item is selected. Include subfolders turns on automatically when the folder has no files of its own.
  - The Selected scope includes everything inside selected folders.
- Slideshow player: full-window dark stage; name, date and dimensions; counter "i / n"; prev, play/pause, next, close; progress bar; keys ← → Space Esc.
- Settings window with tabs; empty states "This folder is empty." and "No items match "…".".

### 5.2 Changes and additions
1. **Root** [owner]: a member's root is the virtual "Home Gallery" listing their aliases; an admin's root is the contents of `MEDIA_ROOT`. The tree root is called "Home Gallery". [call] A member with no shares sees "No folders are shared with you yet."
2. **Actions by right**:
   - [owner] The toolbar shows Upload and New folder (Create), Rename and Move to… (Update), Delete (Delete), and Download (Read, when something is selected).
   - [call] Actions the user lacks are hidden, not greyed out.
   - [call] The "Read only" badge shows, as in the design, when the user has no Create/Update/Delete here or the folder isn't writable on disk (read-only mount).
   - [call] Keys: Delete, F2 (rename), Ctrl+A, Enter (open), arrow keys (move focus), Shift+click (range select).
   - [call] Upload: a button (multi-file picker) plus drag-and-drop of files onto the content pane, with a progress panel showing per-file progress and cancel.
   - [call] Rename: a dialog; the file extension can't be changed.
   - [call] Move to…: a dialog with the folder tree of the current share (admin: the current top-level folder).
   - [call] Delete: confirmation "Move N items to the Recycle Bin?".
   - [call] Download: a single file gives the original; several items or a folder give a streamed .zip with subfolders, no compression and hidden entries excluded.
3. **Viewer** [owner]: double-clicking a file opens the player paused at that file, over the current folder's files. It has a Download button.
   - Videos use native `<video controls>`.
   - [call] If the browser can't play a video (error event), show "This browser can't play this video" plus Download.
4. **Slideshow and videos**:
   - [owner] A video plays to its end, then the show advances. The progress bar follows the video.
   - [call] The next image is preloaded, and there is a Fullscreen button (Fullscreen API).
   - [call] Recursive item lists (Include subfolders, member root) are capped at 5 000 items, with a note when the cap is hit.
5. **Settings → General** [call]:
   - Remove the Library section (media folder path, rescan).
   - Keep Browsing (default view, default slide time), stored per user on the server.
   - Account: "Signed in as …", Change password (current + new), Sign out.
6. **Settings → Users & access** [owner, mockup screens 3–4]:
   - User list with Add user: display name, username, initial password, role. Usernames are lowercase without spaces, as in the design.
   - User panel: display name, username, Set new password, Role, Remove user.
   - The design's None/Read/Write "Folder access" tree is replaced by a **Shared folders** table. Columns: Alias (editable inline), Folder on disk (shown as `/media/...`), Create / Read (locked on) / Update / Delete checkboxes, Remove.
   - **Add folder** dialog: browse `MEDIA_ROOT` folders (breadcrumb + list, hidden folders excluded), alias defaulting to the folder name, rights checkboxes, Share button.
   - For admin users, the panel shows "Administrators have full access to every folder." instead of the table.
   - [call] Edits save immediately, like the design's live edits, with a brief "Saved" confirmation.
7. **Settings → Recycle Bin** (admin, new tab): see 4.4. [owner]
8. **Login page** [owner]: same visual language. A centered card with app icon, username, password, "Remember me" and Sign in.
   - [call] "Remember me" is checked by default. Errors read "Wrong username or password" and "Too many attempts, try again in N minutes".
9. **First run and recovery** [call]:
   - With no users in the DB, the server prints a one-time setup link `/setup?token=…` to the container log. That page creates the first admin and is unusable without the token.
   - Recovery: `docker exec <container> gallery set-password <username>` prints a new random password and ends that user's sessions.
10. **URLs** [call]: the address bar reflects the current folder (`/browse/<alias>/<sub>/…`). Back/forward use browser history, so bookmarks and browser buttons work.
11. **Phones (< 700 px)** [owner: must work on phones; details call]:
    - The tree becomes a ☰ drawer, search collapses to an icon, and the Details view shows Name and Date only.
    - Tap opens; long-press starts selection with checkboxes; swipe left/right in the player.
12. **Folder metadata** [call]: folder tiles and rows show a cover (the first media file found inside, depth-first) and a recursive media count. The Date column shows the folder's modified time; Size is blank, as in Windows Explorer.

## 6. Media handling

- Listed types [owner; gif, m4v and webm added as call]:
  - Photos: `.jpg .jpeg .png .webp .gif .heic .heif`
  - Videos: `.mp4 .m4v .mov .webm`
  - Extensions match case-insensitively. Everything else is hidden.
- Hidden entries [call]: names starting with `.`, plus `@eaDir`, `#recycle`, `#snapshot`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`, `Thumbs.db` and `desktop.ini`. They are never listed, counted, zipped or served.
- No scan or index [owner]: folders are read live from disk. A listing returns all entries at once; sorting and filtering happen client-side.
- Metadata [owner: EXIF date and rotation], cached in SQLite keyed by (path, size, mtime):
  - Photos: width and height after EXIF orientation. Date taken is EXIF DateTimeOriginal, falling back to the file mtime.
  - Videos: width and height after rotation, and duration. The date is the container creation time, falling back to mtime.
  - Type labels as in the design ("JPEG image", "HEIC image", "MP4 video", "MOV video", …).
- Thumbnails [owner: made on first view, cached in `/data`]:
  - One size, about 480 px on the longest side, generated on request. Video posters are a frame at about 1 s.
  - Generation is concurrency-limited (about the number of CPU cores, max 4), and concurrent requests for the same thumbnail share one job.
  - Stored under `/data/cache`, never next to the media.
  - URLs carry a version (mtime), so they can be served with `Cache-Control: private, max-age=31536000, immutable`.
- Viewing [owner; size cap is a call]:
  - JPEG, PNG, WebP and GIF originals are served directly; browsers apply EXIF orientation themselves.
  - HEIC/HEIF is converted on the server to JPEG (longest side ≤ 2560 px) and cached.
  - Download always gives the untouched original.
- Videos [owner]: originals are streamed with HTTP Range support. No transcoding.
- Performance target [call]: a 500-item folder lists in under 1 s warm and under 5 s cold. Thumbnails fill in progressively (`loading="lazy"`).

## 7. Security requirements
[owner] The list was confirmed; the specifics are [call].

### 7.1 Transport
- The app listens on plain HTTP inside the container. With Traefik on the same Docker host, it publishes no host port and is reachable only through Traefik's Docker network. With Traefik on another machine, the port is published on the host's LAN IP only (see 8).
- `X-Forwarded-For/Proto/Host` are trusted only from `TRUSTED_PROXIES` (CIDR list, default private ranges), so rate limits see the real client IP.
- The session cookie is `Secure` by default. `COOKIE_SECURE=false` exists for local HTTP testing only.

### 7.2 Authentication and sessions
- Passwords: argon2id via Node's built-in `crypto.argon2` (present in Node 24.13; scrypt is an acceptable fallback). Minimum 8 characters, no other composition rules.
- Session: a random 256-bit token in a cookie (HttpOnly, Secure, SameSite=Lax); only its hash is stored. "Remember me" gives 30 days, sliding. Without it: a browser-session cookie with 12 h idle expiry.
- Sessions end:
  - On logout.
  - On password change: all of the user's sessions, except the current one when users change their own password.
  - On role change or user removal.
- Brute force: failed-login counters per IP and per username, with temporary lockout. Example numbers: 5 failures per username → 15 min, 20 failures per IP per 15 min; builder picks the final ones.
  - Same generic error for an unknown user and a wrong password, with roughly constant timing.
- CSRF:
  - State changes only via non-GET requests with a JSON or upload content type and an `Origin` matching the request host.
  - SameSite=Lax is a second layer.

### 7.3 Authorization and paths (the core)
- One server-side resolver maps (user, virtual path) to (absolute disk path, rights, share). Every endpoint goes through it: listing, tree, thumbnails, previews, originals, downloads/zips, uploads, mutations, trash. Nothing accepts disk paths from members.
- It rejects empty, `.` and `..` segments, NUL, backslashes, hidden names and unknown aliases.
- After resolving, `realpath` must stay inside the share's real path, which blocks symlink escapes. The share's real path must stay inside `MEDIA_ROOT`'s real path. Zips skip symlinks that lead outside.
- Members never get disk paths in any response or error. Admin APIs check the role on every request.
- Mutations check the specific right (Create/Update/Delete) on the target. For a move, source and destination must be in the same share.

### 7.4 Uploads
- Chunked: the client sends each file in chunks of about 8–16 MB per request into a hidden temp file in the target folder (`.upload-<id>`), finalised by a rename after the last chunk.
  - Every request stays far under Traefik's 60 s default, and partial files are never visible.
  - Temp files abandoned for 24 h are removed.
- Allowed content: listed photo/video extensions only, plus a magic-byte check on the first chunk (JPEG, PNG, WebP, GIF, ISO-BMFF `ftyp` for HEIF/MP4/MOV, EBML for WebM). SVG and HTML are never accepted.
- Size cap per file: `MAX_UPLOAD_MB` (default 10240). A full disk gives a clear error and removes the temp file.
- Names are sanitised: no separators, control characters or leading dot, ≤ 200 bytes UTF-8.
- Uploads never overwrite: a name collision becomes "name (1).ext", "name (2).ext", … (Windows style).

### 7.5 Serving
- Files are served with the Content-Type from the allow-list plus `X-Content-Type-Options: nosniff`. Downloads use `Content-Disposition: attachment`.
- Headers:
  - Strict CSP: `default-src 'self'`, no third-party origins, `frame-ancestors 'none'`.
  - `Referrer-Policy: same-origin`.
  - HSTS when the request arrived over HTTPS.
- No external requests from browser or server: no CDNs, web fonts or analytics.

### 7.6 Processes and container
- libvips and ffmpeg run as subprocesses with timeouts, using argument arrays (no shell).
- The container runs as the owner's UID:GID (compose `user:`), never root, on a slim base image.
- Audit log to stdout as JSON lines: logins (success/failure + IP), admin changes, uploads, renames, moves, deletes, restores.

## 8. Deployment [owner unless tagged]

- One image from a multi-stage Dockerfile, built on the host with `docker compose up -d --build`. That works natively on amd64 and arm64 with no registry. [call]
- One gallery per machine [call; Claude's pick, owner didn't object]: each instance mounts only that machine's local folders. Sharing from both the NAS and the laptop means two instances on two subdomains. Network mounts (SMB/NFS) are not a design target: they may work, but a hung mount can stall the app.
- Volumes:
  - `/data`: SQLite DB and cache.
  - One or more media mounts under `/media`, e.g. `/home/user/pictures:/media/pictures`. Each mount is its own top-level folder under `/media`; the Recycle Bin relies on this layout. [call]
  - A mount may be `:ro` if nobody gets Create/Update/Delete on it. Write attempts on read-only mounts give a clear error.
- The compose file joins the owner's external Traefik network. Labels: router `Host(...)`, entrypoint `websecure`, `tls.certresolver=<name>`, service port. Domain, network, entrypoint and resolver names are placeholders the owner fills in.
- [call] Traefik may run on another machine in the LAN. Then the port is published on the host's LAN IP, Traefik routes to it through a file-provider snippet, and `TRUSTED_PROXIES` is set to Traefik's IP. The README covers both modes.
- [call] The README warns: if a sync or backup tool (Syncthing, Synology Drive, …) watches the media folders, add `.gallery-trash` and `.upload-*` to its ignore list.
- Env: `MEDIA_ROOT=/media`, `DATA_DIR=/data`, `PORT=8080`, `TRUSTED_PROXIES`, `COOKIE_SECURE=true`, `MAX_UPLOAD_MB=10240`, `TRASH_DAYS=30`.
- `GET /healthz` backs the Docker healthcheck. DB migrations run automatically on start.
- Backup = copy `/data` (the `cache` subfolder can be skipped).
- README covers: setup, the compose example, the first-run link, the password-reset CLI, and Traefik notes.

## 9. Tech stack
[owner] Accepted the proposal; the details are [call].
- Server: Node.js 24 LTS and TypeScript. The builder picks a small HTTP framework or plain `node:http`; keep dependencies few.
- DB: SQLite via the built-in `node:sqlite` (WAL mode). `better-sqlite3` is acceptable if `node:sqlite` causes trouble.
- Images: libvips CLI (`vipsthumbnail` / `vips`) with libheif and its HEVC decoder plugin for HEIC; ffmpeg/ffprobe for video posters and metadata. EXIF via vips headers or a small JS EXIF reader.
- Frontend: React, TypeScript and Vite, with the design ported into components and its inline SVG icons reused. No UI kit, no CSS framework.
- Base image: Debian slim Node 24 plus `libvips-tools`, the libheif HEVC plugin and `ffmpeg`.

## 10. Data sketch (builder may adjust)

- `users(id, username unique ci, display_name, role, password_hash, prefs_json, created_at)`
- `shares(id, user_id, alias, rel_path, can_create, can_update, can_delete)`, with unique `(user_id, lower(alias))` and unique `(user_id, rel_path)`
- `sessions(token_hash, user_id, expires_at, remember, last_seen_at, ip, user_agent)`
- `trash(id, original_rel_path, trash_rel_path, is_dir, size, deleted_by, deleted_at)`
- `media_meta(rel_path, size, mtime_ms, width, height, taken_at, duration_s)`
- Login-attempt counters can live in memory (single process).

## 11. Testing expectations [call]

Automated tests (builder picks the runner) cover at least:
- Path resolver: traversal, encoded `..`, symlink escape, hidden names, alias mapping, overlapping shares.
- Rights matrix per endpoint: member Create/Read/Update/Delete combinations, admin, anonymous.
- Auth: login, lockout, expiry, logout, session revocation, Origin check.
- Share path rewrite on rename/move.
- Recycle Bin: delete, restore, purge.
- Uploads: chunking, type/magic check, size cap, no overwrite.

UI: a written manual smoke checklist (login → browse → viewer → slideshow; admin → add user → share folder → member sees alias; upload/rename/move/delete per right). Automated browser tests are optional.

## 12. Left to the builder

- Framework and libraries within section 9.
- API routes and shapes; component structure.
- Exact numbers: lockout thresholds, chunk size, thumbnail size/format/quality, concurrency.
- Cache eviction, message wording, icon details, and phone layout beyond 5.2.11.

## 13. Verify early (risks)

1. HEIC decoding in the final image (iPhone grid-tiled HEIC, orientation) through libvips + libheif's HEVC plugin.
2. iPhone HEVC `.mov` playback in Chrome, Edge and Firefox on Windows and Android, including whether `.mov` must be served as `video/mp4` for Chrome.
3. `node:sqlite` and `crypto.argon2` are experimental in Node 24, so pin the exact Node version in the Dockerfile.
4. The container UID needs write access to mounts that get Create/Update/Delete.

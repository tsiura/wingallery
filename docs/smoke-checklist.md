# Home Gallery: end-to-end smoke checklist

Run on 2026-10-23 against the production image built from commit `b9f140a` (the tip of `worktree-home-gallery`), `COOKIE_SECURE=false`, one container, fresh data folder and a writable copy of the seed media (`npm run seed`, 89 files).

How it was run: every line below that is ticked was run headlessly, once. HTTP checks used `fetch` with a cookie jar; UI checks used headless Chrome 149 over the DevTools Protocol at 1280×720 (desktop) and 390×844 with touch emulation (phone), signed in through the real sign-in page. The driver scripts are throwaway and are not in the repo. Lines that need a person, a real phone or another browser are listed under **PENDING-HUMAN** at the end and are not ticked.

```bash
docker build -t home-gallery . && docker rm -f hg-smoke 2>/dev/null; D=$(mktemp -d); M=$(mktemp -d); cp -r dev-data/media/photos "$M/photos"
docker run -d --name hg-smoke -u "$(id -u):$(id -g)" -e COOKIE_SECURE=false -p 127.0.0.1:18080:8080 -v "$D:/data" -v "$M/photos:/media/photos" home-gallery
```

Test data added on top of the seed: for the picker, empty `@eaDir`, `.hidden-dir`, `#recycle`, `#snapshot`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found` beside the real folders (and `Travel/@eaDir`, `Travel/.thumbs`, `Travel/.hidden.jpg`, `Travel/Thumbs.db`); for media, `Camera roll/Fixtures/` with a rotated JPEG, EXIF Orientation 6/3/8 copies of a 1600×1200 test picture, the repo's HEIC, corrupt JPEG, PNG, MP4 and an MOV remux; a 208 MB MP4 made by stream-copy looping a seed clip (so it is real, playable H.264, 8 minutes); a second container (`hg-smoke-sec`, port 18081, `COOKIE_SECURE` unset, `TRUSTED_PROXIES=10.99.0.0/16`) for the secure-cookie and proxy checks. Users: `owner` (admin), `mama` (member), `papa` (member).

**Result: 47 headless checks ticked, 0 failed (❌), plus the PENDING-HUMAN list (one unticked line, F15b, and sections H1 to H5). 5 observations that are not failures are under "Observations".**

## Setup

- [x] **S0** The container turns `healthy` and prints one first-run link. Expect: `docker ps` shows `healthy` within 30 s; the log says `First run: open https://<your-domain>/setup?token=…`. Got: `healthy` after 8 s; both seen.
- [x] **S1** No users yet. Expect: `GET /api/session` is `{"user":null,"setupRequired":true}`; `/` without a token asks for the link. Got: both; the page says "Open the setup link printed in the container log."
- [x] **S2** A wrong token is refused and does not use up the link. Expect: 403 `Invalid setup link`, setup still open. Got: yes.
- [x] **S3** The setup link works. Expect: the form (display name, username, password) creates the administrator, signs in and lands on `/browse/`. Got: admin `owner` created and signed in; the root shows `photos` (94 items).
- [x] **S4** It works once. Expect (F18): a second visit to the same link, in a browser with no cookie, shows the sign-in page, not the setup form; `POST /api/setup` again answers 409 `Already set up`. Got: sign-in form (no "Create admin account" button); 409 `{"error":"Already set up"}`.
- [x] **S5** The audit log has one JSON line per event. Expect: `setup`, `login`, `login_failed`, `logout`, `user_created`, `share_added`, `mkdir`, `rename`, `move`, `delete`, `restore`, `upload` appear. Got: all twelve (19 `login`, 11 `login_failed`, 6 `upload`, 1 each of the rest but `user_created` 3, `share_added` 3, `logout` 2, `rename` 2). Not exercised here: `purge`, `user_updated`, `user_removed`, `password_set`, `share_updated`, `share_removed`.
- [x] **S6** The container stops promptly. Expect: with an idle keep-alive connection still open, `docker stop` ends it cleanly in seconds, not after the 95 s keep-alive. Got: 0.2 s, exit code 0 (tried on the second container).

## Admin

- [x] **A1** Sign out and sign in through the UI. Expect: Account menu → Sign out shows the sign-in page and clears the session cookie; signing in again opens the Explorer. Got: yes.
- [x] **A2** Add 2 users. Expect: Settings → Users & access → + Add user (Mama, Papa, role Member) puts both in the list. Got: Owner (Administrator), Mama (Member), Papa (Member); `GET /api/admin/users` agrees.
- [x] **A3** The folder picker hides `@eaDir` and dot folders. Expect: none of `@eaDir`, `.hidden-dir`, `#recycle`, `#snapshot`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`, `.thumbs`, `.gallery-trash` is offered, though all exist on disk. Got: `photos/` offers only Camera roll, Family, Travel, Visible Folder, Дача #2 (2024); `photos/Travel/` only Iceland 2026, Lisbon 2025; checked again after the first delete (`.gallery-trash` now exists), `/api/admin/browse?path=photos` and `/api/list?path=/photos` still hide it.
- [x] **A4** Shares with different rights. Expect: Mama gets `Trips` = `photos/Travel` (Read only); Papa gets `Camera` = `photos/Camera roll` (Create, Update, Delete) and `Family` = `photos/Family` (Read only). Got: made with + Add folder (picker, alias, rights ticks); the table and `/api/admin/users/:id/shares` show exactly that.
- [x] **A5** The Recycle Bin restores. Expect: what Papa deleted (W5) is listed with name, original location, deleted by, date and size; Restore puts it back. Got: one row `short-clip.mp4 · /media/photos/Camera roll · papa · 7 KB`; Restore: the row goes, the file is back in its folder and in the listing, and `.gallery-trash` is empty on disk.

## Member, read-only (Mama)

- [x] **R1** Sees only aliases. Expect: her root lists `Trips` only; the sidebar tree is Home Gallery → Trips → Iceland 2026 / Lisbon 2025. Got: yes (`Trips` 33 items).
- [x] **R2** Never a disk path (F18: a disk path such as `/media/photos/…`; `/media/thumb?…` URLs are expected). Expect: no `/media/photos`, `photos/Travel`, `.gallery-trash`, and none of the real folder names (Travel, Camera roll, Family, Дача, Visible Folder, @eaDir) in what her browser receives. Got: scanned the raw `index.html`, the rendered DOM, 7 API answers, the document, 2 scripts/styles and 20 image addresses (all `/media/thumb?path=/Trips/Iceland 2026/…`): no hit.
- [x] **R3** A hand-typed `/browse/<other alias or folder>` shows the unavailable message. Expect: "This folder is unavailable." with a "Go to Home Gallery" link and no items. Got: for `/browse/Camera` (Papa's alias), `/browse/Family`, `/browse/photos`, `/browse/photos/Travel`, `/browse/Travel`, `/browse/Trips/Nope` and `/browse/Trips/..%2FCamera`; the API answers 404 `Not found` (400 `Invalid path` for the `..` one).
- [x] **R4** Read-only means read-only. Expect: no Upload, New folder, Rename, Move or Delete buttons and a "Read only" badge; every write refused with 403 `You don't have permission to do that`; admin endpoints 403. Got: toolbar is Slideshow, Sort, Select, Download, view switch; `mkdir`, `rename`, `move`, `delete`, `upload/start` all 403 with that message; `/api/admin/users` and `/api/admin/trash` 403.
- [x] **R5** She can still download. Expect: file and zip. Got: `/media/download` 200 `attachment; filename="IMG_3101.jpg"; filename*=UTF-8''IMG_3101.jpg`; `POST /media/zip` of a folder 200 `application/zip`, 4.7 MB, starts with `PK`.

## Member with Create/Update/Delete (Papa)

- [x] **W0** Sees his two aliases, `Camera` and `Family`; in `Camera` the bar offers Upload and New folder, and Rename, Move to…, Delete, Download once a file is selected. Got: yes.
- [x] **W1** Upload by the file picker, and never overwrite. Expect: a photo and an MP4 upload, bytes identical, no `.upload-*` left; the same name again is saved as `name (1).ext`. Got: 2 uploaded, sha-256 identical on disk; the photo again became `new-photo (1).jpg` and the first stayed untouched. (First run's last wait used a wrong pattern, because the panel counts every upload of the visit; the `(1)` copy was then checked on disk: same sha-256.)
- [x] **W2** Upload a 200 MB video. Expect: it goes up in 8 MiB chunks, every request far under Traefik's 60 s, the file arrives intact. Got: 208,276,585 bytes (198.6 MiB, 483 s, 1280×720) through the UI, twice (the second copy was saved as `big200 (1).mp4` because the name was taken): 25 chunk PUTs, both copies sha-256 identical to the source, no temp file, the listing shows its size, duration and picture size, the poster is 200 `image/jpeg`. Timing by API (the same chunk protocol, a third copy): slowest chunk 19 ms, whole file 0.4 s on loopback. Per request the limit is 8 MiB in 60 s, about 1.1 Mbit/s of uplink; a slow link through the real Traefik is PENDING-HUMAN (E1).
- [x] **W3** Rename. Expect: a changed extension is refused with `File extension can't be changed`; a valid name renames. Got: `holiday.png` refused with exactly that message; `new-photo (1).jpg` → `holiday2.jpg`, listing and disk agree, the other upload untouched.
- [x] **W4** New folder and move. Expect: New folder creates it; Move to… offers only his own share and moves; a move into another share is refused. Got: `Smoke folder` created; the Move tree showed Camera, Fixtures, Smoke folder; Move here moved the file (disk and listing); a move to `/Family` → 400 `Items can only be moved within the same shared folder`; a delete inside read-only `/Family` → 403.
- [x] **W5** Delete goes to the bin. Expect: the dialog says "Move 1 item to the Recycle Bin? The admin can restore it."; the item leaves the folder and the listing and sits in `<top-level>/.gallery-trash/<id>/<name>`; a member can't open the bin. Got: gone from the folder, now `photos/.gallery-trash/2fdc7f0174b5721d/short-clip.mp4`; Papa on `/api/admin/trash` gets 403 `Administrators only`.

## Media

- [x] **M1** JPEG portrait orientation. Expect: EXIF Orientation 6, 8 (turned) and 3 (upside down) show upright in the thumbnail and in the view; the listing reports the turned size. Got: a 1600×1200 picture with Orientation 6/3/8: thumbnails 360×480, 480×360, 360×480, views 1200×1600, 1600×1200, 1200×1600, the four corner colours equal those of the correctly turned picture; listing says 1200×1600 for 6 and 8; the tile and the viewer show the portrait. A plain 1600×1200 JPEG's thumbnail is 480×360 (libvips works in the image).
- [x] **M2** HEIC thumbnail and view. Expect: `/media/thumb` and `/media/view` give a JPEG, download gives the original. Got: `sample.heic` thumbnail 200 `image/jpeg` 64×48, view 200 `image/jpeg` 64×48, download 200 byte-identical (`image/heic`); the tile and the viewer show it. The portrait iPhone HEIC is PENDING-HUMAN (H2).
- [x] **M3** MP4 playback and Range seeking. Expect: plays; `Range` answers 206 with the right bytes; 416 past the end; Chrome seeks. Got: `clip.mp4` plays (`video/mp4`); on the 208 MB file `bytes=0-99`, `bytes=100000000-100000099`, `bytes=-50`, `bytes=<size-10>-` all 206 with the right `Content-Range`, every byte equal to the file on disk; `bytes=<size>-` → 416 `bytes */208276585`; a plain GET says `Accept-Ranges: bytes`; in Chrome the 8-minute video seeks to 300 s with 6 Range answers (e.g. `bytes 129400832-208276584/208276585`) and plays on.
- [x] **M4** MOV playback. Expect: plays, served as `video/mp4`, Range works. Got: `clip.mov` (the MP4 clip remuxed with `ffmpeg -f mov`, H.264) plays, is served as `video/mp4`, `bytes=0-99` → 206.
- [x] **M5** A corrupt file shows an icon. Expect: `/media/thumb` 422 `No preview available`; the folder still lists everything; its tile shows an icon, not a broken image. Got: 422 `{"error":"No preview available"}`; all 9 entries listed (the corrupt row has width/height `null`); the tile has 0 `<img>` and one icon while the 8 other tiles show thumbnails.

## Slideshow

- [x] **SS1** The options window. Expect: Slideshow → "Start slideshow", the folder name and item count, Slide time, Transition (Fade, Slide, None), Shuffle, Loop, Include videos, Include subfolders; Include videos changes the count. Got: Iceland 2026 = 20 items, defaults 5 s, Fade, Shuffle off, Loop on, Include videos on, Include subfolders off; videos off → 18, on → 20; Cancel closes.
- [x] **SS2** Include subfolders. Expect: a folder with files only below it opens with it already on. Got: `Travel` opens at 33 items; off → 0 items and Start is disabled; on → 33 (Iceland 20 + Lisbon 13; the `@eaDir`, `.thumbs`, `.hidden.jpg`, `Thumbs.db` on disk are not counted); videos off → 30.
- [x] **SS3** Play scope. Expect: with several files selected the window offers Whole folder / Selected (N). Got: 3 selected → "Selected (3)" = 3 items, Whole folder = 20, back to Selected = 3.
- [x] **SS4** Shuffle. Expect: the show is not in name order and repeats nothing. Got: 12 slides of an 18-photo show, all different, not sorted (IMG_3140, 3122, 3104, 3107, 3146, …).
- [x] **SS5** Slide time, Pause/Play, keys, transitions. Expect: 2 s slides advance by themselves; Pause stops, Space resumes, ←/→ step; the stage animates for Fade and Slide and not for None; Full screen, Download, Close in the bar; Esc closes. Got: slider "2 seconds", next slide after 1.7 s; Pause → button turns into Play and nothing moves for 2.6 s; Space resumes; arrows step 4 → 3; animations `ssFade`, `ssSlide`, none; bar has Full screen, Download and Close.
- [x] **SS6** Loop. Expect: without Loop the show stops after the last slide, with Loop it goes round. Got: 3 photos at 2 s for 9.5 s: Loop off 1 → 2 → 3 and stops (Play button shown); Loop on 1 → 2 → 3 → 1 → 2 and goes on.
- [x] **SS7** Videos in a show. Expect: stepping onto a film plays it. Got: `VID_3158.mp4` (1280×720) plays with sound on, no muting needed in headless Chrome.

## Phone (390×844, touch emulation; the feel on real phones is PENDING-HUMAN, H1)

- [x] **P0** No sideways scroll. Expect: the page is as wide as the window. Got: scrollWidth 390 = innerWidth 390.
- [x] **P1** Drawer. Expect: the Folders button opens the tree as a drawer; choosing a folder navigates and closes it. Got: opens 280 px wide at the left edge (Home Gallery, Camera, Family); tapping Family opens `/browse/Family`, drawer closed.
- [x] **P2** Long-press. Expect: a press of about 500 ms selects the item without opening it; then taps toggle; Done ends selection mode. Got: a 750 ms press on `IMG_5015.jpg` selects it; a tap on `IMG_5018.jpg` adds it; the bottom bar says "2 selected" with a Done button, the toolbar offers Move to…, Delete, Download; Done clears the selection.
- [x] **P3** Tap and swipe in the viewer. Expect: a tap outside selection mode opens the item; swiping left shows the next, right the previous. Got: `IMG_5015.jpg` (4 / 26) → swipe left `IMG_5018.jpg` (5) → swipe right back to 4.
- [x] **P4** Swipe in a slideshow. Expect: the same swipe steps the show. Got: 1 → 2 → 1 of 26.

## Security

- [x] **X1** The session cookie has `Secure` unless `COOKIE_SECURE=false`. Expect: `HttpOnly; SameSite=Lax; Path=/`, `Max-Age=2592000` only with Remember me. Got: with `COOKIE_SECURE=false`: `hg_session=…; Path=/; HttpOnly; SameSite=Lax` (and `; Max-Age=2592000` with Remember me), no `Secure`. With `COOKIE_SECURE` unset (second container): the same plus `; Secure`.
- [x] **X2** Security headers on every response, exactly as in the Global Constraints. Expect: the CSP string, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and no HSTS over plain HTTP. Got: compared character for character on 17 responses: `/`, `/browse/`, `/healthz`, the JS and CSS assets, `/api/session`, a JSON listing, a thumbnail, a 206 video range, a download, the zip POST, and the errors 422, 404, 400, 405, 403 (wrong Origin), 415: identical every time.
- [x] **X3** HSTS and proxy trust. Expect: behind a trusted proxy (`X-Forwarded-Proto: https`) the response carries `Strict-Transport-Security: max-age=31536000` and the proxy's Origin is accepted; from an untrusted socket `X-Forwarded-*` is ignored (GET served, no HSTS) and a state-changing request gets the TRUSTED_PROXIES hint. Got: trusted: GET 200 + HSTS, POST with `Origin: https://gallery.example.com` reaches the login (401 `Wrong username or password`, not 403). Untrusted (second container): GET 200, no HSTS; POST 403 `Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES.`
- [x] **X4** Lockout, by API. Expect: 5 wrong passwords for a name lock it; the 6th attempt, even with the right password, gets 429 `Too many attempts, try again in 15 minutes`; other users are not affected. Got: `kid`: 401 `Wrong username or password` five times, 429 on the 6th and on the correct password after it; `owner` signed in normally meanwhile.
- [x] **X5** Lockout message in the UI. Expect: the 6th wrong sign-in shows the lockout message under the button. Got: five times "Wrong username or password", then "Too many attempts, try again in 15 minutes" (a name that does not exist behaves the same as a real one).
- [x] **X6** Zero console errors and zero CSP violations in every browser run (setup, second visit, sign-in, admin, Mama, Papa, media, slideshow, phone, Recycle Bin, lockout). Got: none. Only Chrome's own status lines for requests that fail on purpose: 401 ×5 and 429 (wrong passwords), 404 and 400 (hand-typed addresses, Mama), 422 (the corrupt thumbnail).

## Performance (F15)

- [x] **F15a** A 500-item folder lists in under 1 s warm and under 5 s cold. Expect: `GET /api/list` < 5 s the first time, < 1 s after. Got: 500 files (the five fixtures × 100: rotated JPEG, PNG, HEIC, corrupt JPEG, MP4): cold 1601 ms, then 10, 7 and 6 ms; 500 entries each time (400 with a size, the 100 corrupt ones without).
- [ ] **F15b** PENDING-HUMAN: a real iPhone portrait HEIC shows upright as thumbnail and view (H2). The JPEG orientation logic is covered by M1.

## Failures

None. During the run I had to fix my own driver scripts several times (a wrong regular expression for the upload panel's running count, an avatar initial in a row's text, option states that persist between openings of the slideshow window, a mouse click that ended touch selection mode on the phone, a canvas `getImageData` warning my own probe produced); each was a harness mistake, the app behaved as designed, and the lines above show the corrected re-runs.

## Observations (not failures)

1. Every request for a corrupt file's thumbnail re-runs `vipsthumbnail` and writes an `error` line to the log (`Preview tool failed`); there is no negative cache. 7 requests in this run gave 7 lines. A folder like the 500-item one (100 corrupt files) would spawn 100 processes and write 100 lines on every view. By design (`server/thumbs.ts` `produce()`); worth a short "failed recently" cache if corrupt files are common.
2. `Camera roll/Fixtures/sample.heic` is listed as 63×64 but decodes as 64×48. This is the repo's cropped HEIC sample; `server/test/browse.test.ts` says image-size misreads it, and real phone HEICs carry EXIF, so this is a fixture quirk. A real file is H2.
3. `POST /api/setup` signs the new administrator in with a 30-day cookie (`startSession(…, true)` in `server/authroutes.ts`), as if Remember me were ticked; every other sign-in follows the checkbox.
4. Slideshow defaults worth knowing: Loop is on, a folder with no files of its own opens with Include subfolders on, and the options stay while the Explorer stays open (`web/src/slideshow/useSlideshow.tsx`).
5. The floating upload panel sits over the bottom-right of the list and takes clicks until it is closed (its Close button appears when no upload is running).

## PENDING-HUMAN

Collected from the task reports (Tasks 4–20) and this run, grouped and deduplicated. Each needs a real device, another browser, a screen reader or the owner's own Traefik. Tick them off on the real system.

### H1. Real phones (iPhone Safari, Android Chrome)

Open the gallery over the home link on the phone (a normal sign-in), then:

1. Sign-in and setup pages: tap into the fields; the page must not zoom; the keyboard must not auto-capitalize the username; the password manager should offer to save after sign-in (and, in Settings, with the hidden username field of the two password forms).
2. Folder drawer: open it with the menu button, tap rows, tap the search icon (iOS: the keyboard must come up), swipe back from the screen edge (it must act like the toolbar's Back), scroll the breadcrumb sideways, watch the page height while the URL bar collapses. Bar buttons should be about 36 px, drawer rows 40 px.
3. Long-press a photo for about half a second: it must select, not scroll, and the browser's own long-press behaviour must stay away (iOS: no callout or text-selection magnifier; Android: no "download image" menu). Check tap-target sizes and the toolbar's sideways scroll with six labelled buttons.
4. Upload from the phone: Upload → camera roll (include a HEIC), the rename/new-folder dialogs with the on-screen keyboard open, the upload panel at the bottom, and "Done" while the panel is open.
5. Slideshow on iPhone Safari: start a show that includes films (do they play, muted if the sound is refused?), swipe feel, no "Full screen" button, the window against the collapsing URL bar and the home indicator, the edge swipe-back against a swipe on the stage. On Android Chrome: real swipes, and the film's seek bar against the 64 px strip at the bottom of the film.
6. Settings on the phone: drag the slide-time slider by touch (it saves when released), swipe the user chips sideways, check the stacked table cards (needs iOS 16+) and the Settings window height with the address bar.

### H2. Real phone media

1. Take a portrait photo with an iPhone (HEIC, hold the phone upright), upload it through the gallery or copy it into a shared folder. Expect it upright, with natural colours (Display P3), both as a thumbnail and when opened. (F15 second check.)
2. Put an iPhone `.mov` (HEVC, ideally HDR) and an Android `.mp4` in a folder. Expect a poster, a size and a duration in the listing for both. Open each in Chrome on Windows/Android and in Firefox: either it plays with a picture, or the stage says "This browser can't play this video" with a working Download. A black picture with sound is a bug. Also scrub it (drag the seek bar) in Chrome, Firefox and Safari: the iPhone HEVC `.mov` is served as `video/mp4` (spec section 13, risk 2).
3. Download a file whose name has Cyrillic, `#` and `%` (the seed has `Дача #2 (2024)/IMG 50%.jpg`) in Chrome, Firefox and Safari: the saved file name must be exactly that name.
4. Scroll a big folder fast (thousands of lazy thumbnails) while watching `docker compose logs -f gallery`: no error lines for cancelled requests.

### H3. Other browsers and desktop programs

1. Firefox and Safari, the zip download: select a folder, Download. It must save `<folder>.zip` without leaving the page and without "Download failed". Then select something, delete it in another tab, and download in the first: the refusal must be shown. (Chrome is verified.)
2. Open a downloaded zip of `Дача #2 (2024)` in Windows Explorer, macOS Archive Utility and 7-Zip: Cyrillic, `#` and `%` names intact, empty folders present, file dates right.
3. Firefox and Safari: drag files, and a whole folder, onto the list; the closed drawer must not be reachable by Tab (`inert`); the search box shows a focus ring; Back/Forward behave. Firefox: Space on a focused button in the slideshow bar toggles once, and Full screen works inside the window.
4. Any browser: in a dialog, a click on the dark backdrop closes it; selecting text in a field and letting go outside the card does not.
5. Windows (Edge and Chrome): with a selection, widen the window to between 1100 and 1279 px and look at the toolbar's own scrollbar, the icon-only buttons and their tooltips.
6. Look at Fade and Slide transitions and the progress bar on a real screen, and start a 5,000-item show over the home link (smooth preloading, one `/api/meta` request per photo).

### H4. Screen readers (VoiceOver, NVDA)

Sign in with a wrong password: the red message is read aloud. Then walk through: the folder tree (arrows, Enter, the closed drawer is skipped), the account menu, the breadcrumb, the item list (an option list with one tab stop; Details headers read "Size, sorted ascending"), the icon-only action buttons, the Move tree, the notices and the upload panel's status line, the two slideshow windows ("Start slideshow", "Viewer" and the bar's buttons), Settings (current tab, tables, dialogs, and the ⚠ tooltip "Folder not found on disk").

### H5. The owner's server (Traefik, certificates, NAS)

1. Real domain and certificate: the sign-in cookie must carry `Secure`, the response `Strict-Transport-Security`, and sign-in, rename and the zip download (a same-origin form POST) must work in a real browser over HTTPS.
2. Large uploads: upload a multi-GB video from a phone or a slow connection through your Traefik with the `readTimeout` raised as in the README. Each 8 MiB chunk must finish within Traefik's limit (about 1.1 Mbit/s of uplink for 60 s). Also fill the disk and check the "Disk is full" message in the panel.
3. Large downloads: stream a multi-GB zip for several minutes. The response is chunked without a `Content-Length`, so check the entrypoint's write and idle timeouts and that nothing buffers it.
4. NAS: build and start it on the Synology (Container Manager, Docker 24, arm64 if it is an ARM model). The build must pass, the container must turn `healthy` within about 30 s, and `user:` plus the bind mounts must match the NAS's own user and folder permissions.

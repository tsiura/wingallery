# Home Gallery

A self-hosted photo and video gallery that looks and behaves like Windows 11 File Explorer. Your photos and videos stay in your own folders, on a NAS or a laptop. You create accounts for family and friends and share folders with them under names you choose, with Create / Read / Update / Delete rights that apply to the folder and everything below it. Each person sees only what was shared with them. It runs as one Docker container behind your own Traefik and keeps everything it owns (users, shares, sessions, thumbnails) in one `data/` folder, never next to your photos. It lists photos (JPEG, PNG, WebP, GIF, HEIC/HEIF) and videos (MP4, M4V, MOV, WebM); every other file is invisible to it.

## Requirements

- Docker Engine 20.10.10 or newer with the Compose v2 plugin (`docker compose`). Older 20.10 releases cannot run the image: their default seccomp profile blocks `clone3`, which the glibc of the Debian 13 base image uses. The image is built on the machine that runs it, on amd64 or arm64; there is no registry to pull from.
- Synology Container Manager should work, but this has not been tried yet. It needs the Compose plugin, and you may have to put `sudo` in front of the `docker` commands below.
- Traefik (v3 assumed) that is already running, with a domain pointing at it, an HTTPS entrypoint and a certificate resolver. TLS ends at Traefik; the gallery speaks plain HTTP inside the container.
- The folders you want to share, on the disks of the machine that runs the container.

## Setup

1. Put the project on the machine that has the photo folders, and work in its folder, the one that contains `compose.yaml`:

   ```sh
   git clone <repo-url> home-gallery && cd home-gallery
   ```

   (`<repo-url>` is the address of your copy of this repository. Copying the project folder to the machine works too.)

2. Find the numbers the container will run under. As the account that owns your photo folders, run `id -u` and `id -g` and write the two numbers down; on a Synology NAS they are often `1026` and `100`. Below, `<uid>` and `<gid>` stand for them.

3. Create the data folder, owned by that account and closed to everyone else, because the database holds password hashes:

   ```sh
   mkdir data && sudo chown <uid>:<gid> data && sudo chmod 700 data
   ```

4. Edit `compose.yaml`. Every line marked `# CHANGE` is yours to fill in:

   | Line | What to put |
   |---|---|
   | `user` | `"<uid>:<gid>"`, the numbers from step 2. That account must own `./data` and, for any folder people may change, be able to write to it. |
   | `TZ` | Your timezone, for example `Europe/Berlin`. It is used for video and file dates. |
   | `volumes` | One line per folder you share. See [Adding folders](#adding-folders). |
   | `networks: [traefik]`, the `traefik.docker.network` label, and `traefik:` under `networks:` at the bottom | The name of the Docker network your Traefik is on (`docker network ls` lists them). It appears in these three places, each marked `# CHANGE`; use the same name in all three. |
   | `...routers.gallery.rule` | Your domain: ``Host(`gallery.example.com`)``. |
   | `...routers.gallery.entrypoints` | Your HTTPS entrypoint, usually `websecure`. |
   | `...routers.gallery.tls.certresolver` | The name of your certificate resolver, from Traefik's static configuration. |

5. Build and start it:

   ```sh
   docker compose up -d --build
   ```

   The first build takes a few minutes. `docker compose ps` shows `healthy` within about 30 seconds of the start. Traefik answers 404 for the gallery until then, because it routes only to healthy containers.

6. Create the administrator. While there are no users, the gallery prints a one-time setup link to its log when it starts:

   ```sh
   docker compose logs gallery | grep 'setup?token'
   ```

   The link reads `https://<your-domain>/setup?token=...`. Replace `<your-domain>` with your domain and open it to choose the administrator's username, display name and password (at least 8 characters). Pick a username that is not obvious, not `admin` or `root`: internet bots try those. The link stops working once the account exists. If the container restarts before you used it, the log has a new link; use the last one.

7. Sign in and open Settings, then Users & access. Use + Add user for each person. With that person selected, use + Add folder under Shared folders: pick a folder under `/media`, the name (alias) that person will see it under, and the rights (Read is always on).

## Adding folders

Each folder you share is one bind mount under `/media/<name>` in `compose.yaml`:

```yaml
    volumes:
      - ./data:/data
      - /home/user/pictures:/media/pictures
      - /home/user/videos:/media/videos:ro
```

- Every mount must be its own top-level folder directly under `/media`. The Recycle Bin relies on that layout: a deleted item goes to a hidden `.gallery-trash` folder at the top of its own mount, so that deleting is an instant rename on the same disk.
- Add `:ro` when nobody gets Create, Update or Delete there. A write attempt on a read-only mount is refused with a clear message.
- For people to upload, rename, move or delete, the container user (`user:` in `compose.yaml`) needs write access to the folder on the host.
- The administrator sees everything under `/media` with its real names. Members see only their shares, under the names you gave them.
- After adding or changing a mount, run `docker compose up -d` to recreate the container, then share the new folder in Settings.

**Disks.** exFAT, ext4 and btrfs are fine. NTFS is fine only when the volume has no 8.3 short names (on Windows, `fsutil 8dot3name query X:` tells, with X the drive letter); otherwise prefer ext4 or btrfs. **FAT32 (vfat) volumes are not supported**: their 8.3 short names (for example `GALLER~1`) can alias hidden folders. Do not mount an NTFS volume with ntfs-3g's `streams_interface=windows` option: it makes `name:stream` paths reach NTFS alternate data streams. The default is fine.

## Traefik

### Same machine (the default in `compose.yaml`)

The service joins Traefik's Docker network and publishes no port, so the only way in is through Traefik. Traefik finds it through the labels. The gallery believes the `X-Forwarded-*` headers only from `TRUSTED_PROXIES`, whose default is the private address ranges (Docker networks included). That is how it sees the real client address for its login limits, and knows the request came over HTTPS.

### Traefik on another machine

When Traefik runs on a different machine of your network, publish the gallery's port on this machine's LAN address and let Traefik route to it.

1. In `compose.yaml`, delete `networks: [traefik]`, the whole `labels:` list and the `networks:` block at the bottom. Then add the `ports:` line, and `TRUSTED_PROXIES` next to `TZ`:

   ```yaml
       ports: ["192.168.1.20:8080:8080"]   # CHANGE: this machine's LAN IP. Never 0.0.0.0: the port is plain HTTP.
       environment:
         TZ: Europe/Berlin
         TRUSTED_PROXIES: 192.168.1.5      # CHANGE: Traefik's IP
   ```

   Narrowing `TRUSTED_PROXIES` to Traefik means no other device of your network can claim to be a proxy and fake client addresses.

2. On the Traefik machine, add a file to the directory its file provider watches (dynamic configuration):

   ```yaml
   http:
     routers:
       gallery:
         rule: Host(`gallery.example.com`)    # CHANGE
         entryPoints: [websecure]             # CHANGE if different
         service: gallery
         tls:
           certResolver: letsencrypt          # CHANGE: your resolver name
     services:
       gallery:
         loadBalancer:
           servers:
             - url: http://192.168.1.20:8080  # CHANGE: this machine's LAN IP
   ```

### Slow uploads

Uploads are sent in 8 MiB chunks, so that every request stays far below Traefik's default `respondingTimeouts.readTimeout` of 60 seconds, which cuts any request that takes longer to arrive. A very slow uplink (about 1 Mbit/s) needs about 67 seconds for one chunk, and would be cut off. If family members upload over slow mobile links, raise that timeout on your HTTPS entrypoint in Traefik's static configuration:

```yaml
entryPoints:
  websecure:                       # CHANGE: the name of your HTTPS entrypoint
    address: ":<port>"             # CHANGE: keep the address your entrypoint already has. Do not copy 443: a Synology's DSM usually uses it already.
    transport:
      respondingTimeouts:
        readTimeout: 300s          # the default is 60s
```

(As a command-line flag: `--entryPoints.websecure.transport.respondingTimeouts.readTimeout=300s`.) It applies to every service behind that entrypoint. Traefik reads its static configuration only when it starts, so restart Traefik after you change it.

Do not go above 300s. The gallery's own server also cuts a request off after 5 minutes (Node's default `requestTimeout`), so a larger value helps nobody; 300s is enough for an uplink of about 0.25 Mbit/s.

### Folder names with `#`, `%`, `?` or `;`

The gallery keeps the open folder in the page address, with such characters encoded: `Trip #2` is `Trip%20%232` there. Some Traefik 3.6 releases (3.6.5, for one) refuse these addresses by default. You would notice it as a 400 error from Traefik when you reload, or open a link to, a folder with such a name; browsing inside the gallery keeps working. Traefik 3.6.7 and later allow them unless you turned that off. If it happens, allow them on your entrypoint, in the same `websecure` block of the static configuration, and restart Traefik:

```yaml
entryPoints:
  websecure:
    http:
      encodedCharacters:
        allowEncodedHash: true
        allowEncodedPercent: true
        allowEncodedQuestionMark: true
        allowEncodedSemicolon: true
```

## One gallery per machine

Run one gallery on each machine that holds photos, each mounting only that machine's local folders and each on its own subdomain, for example `nas.gallery.example.com` and `laptop.gallery.example.com`. Each has its own `data/`, so its own users and passwords. On the machine that does not run Traefik, follow [Traefik on another machine](#traefik-on-another-machine).

Network mounts (SMB, NFS) are not a design target. They may work, but a hung mount can stall the app.

## Sync tools

If Syncthing, Synology Drive or a similar tool watches your media folders, add these two names to its ignore list:

```
.gallery-trash
.upload-*
```

`.gallery-trash` is the Recycle Bin (deleted items stay there for `TRASH_DAYS` days, and a sync tool would keep copying them around). `.upload-*` are unfinished uploads, renamed to their real name when the last chunk arrives; leftovers older than 24 hours are removed. In Syncthing, put the two lines into `.stignore`.

## Password reset

```sh
docker compose exec gallery gallery set-password <username>
```

It prints a new random 16-character password and signs that user out everywhere. The person can choose their own under Settings, General, Change password. A username that does not exist prints the usage and exits with status 1.

- The command runs as a second process in the container. Its `password_set` audit line shows in the terminal where you ran it, not in `docker compose logs`.
- It cannot clear a login lock. After 5 failed attempts a username is locked for 15 minutes; the locks live in the running server's memory, are counted per username, and the failures stay until a successful sign-in, so someone who keeps trying can hold a lock for as long as they like. If the person still gets "Too many attempts" after the reset, **restart the container: `docker compose restart gallery` clears all login locks.**
- Use usernames that are not obvious: not `admin` or `root`. Internet bots try those, and would keep them locked.

## Backup

Copy the `data/` folder (as the account that owns it, or with `sudo`): it holds the database (users, shares, sessions, Recycle Bin records) and the thumbnail cache. `data/cache` is optional, it is rebuilt when needed. For a consistent copy of the database, stop the container while you copy: `docker compose stop gallery` before, `docker compose start gallery` after. Treat the copy as private: it holds password hashes.

Your photos and videos are not in `data/`. They are your own folders, backed up by whatever backs them up today. Items in the Recycle Bin are inside those folders, under `.gallery-trash`.

To restore, put `data/` back with the same owner and run `docker compose up -d`.

## Everyday commands

| Task | Command |
|---|---|
| Update after a new version | `git pull --rebase --autostash`, then `docker compose up -d --build`. The database upgrades itself on start. (With a copied folder instead of a clone: copy the new files over it, keeping your `compose.yaml`, and run the second command.) |
| Security updates of the image, about once a month | `docker compose build --pull --no-cache && docker compose up -d`. A plain `--build` reuses the cached layers, so ffmpeg, libvips and the other libraries that open the files people upload would never get Debian's security fixes. This rebuilds them from scratch and takes a few minutes. Afterwards, `docker image prune -f` removes the old image that nothing uses any more. |
| Follow the log | `docker compose logs -f gallery` |
| Stop / start | `docker compose stop gallery` / `docker compose start gallery` |

`git pull --rebase --autostash` keeps your edits to `compose.yaml` while the rest updates. If Git then says "Applying autostash resulted in conflicts", the new version changed a line you had edited: open `compose.yaml`, keep your values and delete the `<<<<<<<`, `=======` and `>>>>>>>` lines, then run `git reset` and `git stash drop`.

The log is the audit trail: one JSON line per event, with sign-ins and failed sign-ins (with the client address), user and share changes, uploads, renames, moves, deletes and restores. It lives in the container's Docker log. `compose.yaml` keeps the last 5 files of 10 MB, and the log starts again from empty whenever the container is recreated (by `up -d --build`, and by any change of `compose.yaml`). If the history should last, ship the Docker logs elsewhere with a logging driver or a log collector; the gallery writes no log file of its own.

The service has `restart: unless-stopped`, so it comes back after a reboot. It also comes back after a crash: the server deliberately stops on an error it does not understand instead of carrying on in an unknown state.

## Settings

Set these under `environment:` in `compose.yaml`. An unset or empty value means the default. A value that is not a plain whole number (and a bad `TRUSTED_PROXIES` entry) stops the server at start, with the reason in `docker compose logs gallery`.

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_ROOT` | `/media` | Where the media mounts live inside the container. The image sets it; leave it. |
| `DATA_DIR` | `/data` | Where the database and cache live inside the container. The image sets it; leave it. |
| `PORT` | `8080` | The port inside the container. Leave it: the image's health check and the Traefik label use 8080. |
| `TRUSTED_PROXIES` | `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7` | Comma-separated IPs or CIDR ranges the gallery believes `X-Forwarded-For/Proto/Host` from. Set it to Traefik's IP when Traefik is on another machine. |
| `COOKIE_SECURE` | `true` | Marks the session cookie `Secure`. Only the exact value `false` turns it off, for testing over plain HTTP; never do that behind a real domain. |
| `MAX_UPLOAD_MB` | `10240` | The largest single file that can be uploaded, in MB (10240 is 10 GB). |
| `TRASH_DAYS` | `30` | How many days a deleted item stays in the Recycle Bin before it is removed for good. At least 1: the server refuses to start with `0`, which would empty the bin at every start. |
| `WEB_DIST` | `/app/web/dist` | The folder with the built web app. The image already points at it; leave it. |
| `TZ` | `UTC` | Your timezone, for example `Europe/Berlin`. Not a gallery setting, but it decides the dates shown for videos and files; `compose.yaml` sets it. |

## If something is wrong

- **The container keeps restarting, and `docker compose logs gallery` ends with `Error: unable to open database file`.** The account in `user:` cannot write to `data/`. Docker creates `./data` as root when the folder does not exist yet, and a folder made with `sudo mkdir` has the same problem. Run `sudo chown <uid>:<gid> data` with the numbers from `user:` in `compose.yaml`, then `docker compose up -d`.
- **"Request origin doesn't match this site. If you use a reverse proxy, check TRUSTED_PROXIES."** The gallery received a request through a proxy it does not trust. With Traefik on the same machine the default is right. With Traefik on another machine, make sure `TRUSTED_PROXIES` contains the address Traefik connects from; if you cannot tell, remove the setting (the default covers every private address) and narrow it later.
- **Traefik answers 404 or 502.** Check `docker compose ps`: the container must be `healthy` and joined to Traefik's network, and the labels must name the right network.
- **"This folder is read-only on disk" on upload, rename or delete.** The mount has `:ro`, or the container user cannot write to the folder on the host.

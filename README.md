# commentarr-server

The comment server behind **[Commentarr](https://github.com/tuikat/commentarr)**: shared, timestamped comments for self-hosted Jellyfin.

> **You probably don't need this.** The Commentarr plugin uses the public server at **[comments.forester.dev](https://comments.forester.dev)** by default, and that's where everyone else's comments are. Run your own only if you want a **private** comment space (say, for a group of friends) that doesn't join the public conversation.

## Run it

One container, no external database (SQLite inside, nightly backups to the data folder).

```bash
git clone https://github.com/tuikat/commentarr-server && cd commentarr-server
docker build -t commentarr-server .
docker run -d --name commentarr --restart unless-stopped \
  -p 8790:8790 \
  -e ADMIN_TOKEN="$(openssl rand -base64 24)" \
  -v /path/to/commentarr-data:/data \
  commentarr-server
```

Put it behind HTTPS (a reverse proxy or a Cloudflare tunnel), because browsers on HTTPS Jellyfin servers can't call a plain-HTTP comment server. Then in Jellyfin: **Dashboard → Plugins → Commentarr → Comment server** = your address.

### Settings

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8790` | |
| `DATA_DIR` | `/data` | SQLite database and `backups/` (7 kept) |
| `ADMIN_TOKEN` | (none) | Enables `/admin`. Long and random. |
| `SITE_NAME` | `Commentarr` | Shown on the landing and admin pages |
| `TERMS_URL`, `PRIVACY_URL` | (none) | Linked from the landing page and returned by `/api/v1/info`. You need your own if you run a public server. |
| `AUTO_HIDE_REPORTS` | `3` | Hide a comment for review once people on this many different established servers report it |
| `REPORT_TRUST_HOURS` | `48` | A server counts towards automatic hiding only once it is this old and has posted something |
| `MAX_USERS_PER_SERVER` | `200` | Distinct people one media server can vouch for |
| `MAX_STREAMS`, `MAX_STREAMS_PER_IP` | `5000`, `12` | Open live-update connections, overall and per address |
| `TRUST_PROXY` | `1` | Read the client IP from `CF-Connecting-IP` / `X-Forwarded-For` (for rate limits). Set `0` if the server is reachable directly, without a proxy in front, or anyone could fake their address. |

### Moderating

- **`/admin`** (with `ADMIN_TOKEN`): open reports, search every comment, delete/restore, ban people or whole servers, and a global banned-word list.
- Every connected **Jellyfin admin** moderates for their own server from the plugin's settings: hide comments for their viewers, delete their own users' comments, ban their own users, keep their own banned-word list.
- Built in: per-person, per-server and per-address rate limits, a cap on people per media server, duplicate blocking, a 1,000-character limit, caps on live-update connections, and automatic hiding of comments reported from several established servers (fresh registrations can't brigade a comment away). Every deletion is recorded with who made it.

**If you run a server others can reach, you are responsible for what's posted on it.** Publish terms and a privacy notice, keep `/admin` behind extra protection (e.g. Cloudflare Access), and check reports.

## How it works

- **Servers** (`POST /api/v1/servers`) register once and get a key that never leaves the media server.
- The media server **vouches for each user** (`POST /api/v1/token`, `Authorization: Server <id>:<key>`) and passes the browser a 12-hour token. Users are stored as `sha256(server id + that server's user id)` with a display name, and nothing else.
- **Threads** are found by external ids (`movie/tmdb/603`, `movie/imdb/tt0133093`, `tv/tvdb/81189/s1e3`, `tv/tmdb/1396/s1e3`), so every copy of a title shares one thread. When two servers know a title by different ids, their threads are merged the first time both ids are seen together.
- **Live**: `GET /api/v1/stream` (server-sent events) pushes new and removed comments. Watching a title creates nothing until someone comments on it.
- **Related**: `GET /api/v1/related` returns the best comments from a show's other episodes, which the player uses to fill quiet stretches.

Run the end-to-end check against a running server: `ADMIN_TOKEN=… node --experimental-sqlite test/smoke.js http://127.0.0.1:8790`.

Requires Node ≥ 22.13 (built-in `node:sqlite`); no npm dependencies.

## Licence

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a public service, you must publish your changes. © Forester.

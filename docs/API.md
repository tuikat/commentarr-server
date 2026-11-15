# Commentarr API for app developers

This is for people building their own Jellyfin app (an Android TV client, a desktop player, anything
native) who want to show and post Commentarr comments without the Jellyfin web interface.

Everything here is a plain HTTPS + JSON API. There is no SDK to install and nothing that depends on
the web player.

- [How it fits together](#how-it-fits-together)
- [Stability promise](#stability-promise)
- [Step 1: get a comment token from Jellyfin](#step-1-get-a-comment-token-from-jellyfin)
- [Step 2: work out the title's ids](#step-2-work-out-the-titles-ids)
- [Step 3: call the comment server](#step-3-call-the-comment-server)
- [Endpoints](#endpoints)
- [Live updates](#live-updates-server-sent-events)
- [Moderation endpoints (server admins)](#moderation-endpoints-server-admins)
- [Building a good client](#building-a-good-client)
- [Testing](#testing)

## How it fits together

```
your app ──(Jellyfin login)──▶ Jellyfin + Commentarr plugin ──(server key)──▶ comment server
    │                               GET /Commentarr/Token                      POST /api/v1/token
    │                                      │
    │◀──────── { token, exp, serverUrl } ──┘
    │
    └──(Bearer token)──▶ comment server: read, post, like, report, live updates
```

- The **Commentarr plugin** runs on the user's Jellyfin server. It holds that server's secret key
  for the comment server and vouches for each signed-in user.
- Your app asks the plugin for a **comment token** (normal Jellyfin authentication), then talks to
  the **comment server** directly with it.
- Apps never register servers, never see the server key and never need their own account.
- Moderation stays with each Jellyfin server: its admins' blocks, bans and banned words apply in
  every app, because every token is issued through their server.

The public comment server is `https://comments.forester.dev`, but **always use the `serverUrl` the
plugin gives you**: a server can point at a self-hosted comment server instead.

## Stability promise

- Everything under `/api/v1/` and the plugin's `GET /Commentarr/Token` is a stable contract.
- v1 only ever **gains** things: new endpoints, new optional request fields, new response fields,
  new live event types. Write your client to **ignore fields and event types it doesn't know**.
- Anything that would break an existing client goes into `/api/v2/`, and v1 keeps working for at
  least 12 months after v2 ships. Breaking changes are announced in the
  [releases](https://github.com/tuikat/commentarr-server/releases) first.
- `GET /api/v1/info` returns the comment server's `version` if you need to feature-detect.

## Step 1: get a comment token from Jellyfin

Call the user's Jellyfin server with the app's normal Jellyfin authentication:

```http
GET /Commentarr/Token
Authorization: MediaBrowser Client="Your App", Device="Living Room", DeviceId="…", Version="1.2.3", Token="<jellyfin access token>"
```

```json
{
  "token": "eyJzaWQiOi…",
  "exp": 1794815746168,
  "serverUrl": "https://comments.forester.dev",
  "admin": false
}
```

| Field | Meaning |
| --- | --- |
| `token` | Bearer token for the comment server. Valid 12 hours. Treat it like a password: don't log it. |
| `exp` | Expiry, Unix time in **milliseconds**. Get a new token when it's less than a few minutes away. |
| `serverUrl` | The comment server to call. No trailing slash. |
| `admin` | `true` for Jellyfin administrators. Their token can also moderate their own server's comments. |

| Status | Meaning |
| --- | --- |
| `200` | Ready. |
| `401` | Not signed in to Jellyfin. |
| `404` | **Commentarr isn't installed on this server.** Hide your comments feature. This is the feature check. |
| `502` | The plugin couldn't reach the comment server. `{"error": "…"}` says why. Try again later. |

Cache the token per user and reuse it until it nears expiry: each Jellyfin server can issue 600
tokens an hour in total, shared by all its users and apps.

## Step 2: work out the title's ids

A comment thread belongs to a **film** or an **episode**, not to a file, so everyone with that
title shares it whatever version they have. Threads are found by public ids built from the item's
`ProviderIds` (and, for episodes, the **series'** `ProviderIds` plus season and episode numbers):

| Item | Id format | Example |
| --- | --- | --- |
| Film, TMDB | `movie/tmdb/<id>` | `movie/tmdb/603` |
| Film, IMDb | `movie/imdb/<tt id>` | `movie/imdb/tt0133093` |
| Episode, TVDB series id | `tv/tvdb/<series id>/s<season>e<episode>` | `tv/tvdb/81189/s1e3` |
| Episode, TMDB series id | `tv/tmdb/<series id>/s<season>e<episode>` | `tv/tmdb/1396/s1e3` |
| Episode, IMDb series id | `tv/imdb/<series tt id>/s<season>e<episode>` | `tv/imdb/tt0903747/s1e3` |

- Send **every id you have**, comma-separated, up to 6. The server links them, so a thread started
  by someone who only had a TMDB id is found by someone who only has TVDB.
- Lower case, no leading zeros in season or episode numbers (`s1e3`, not `S01E03`). Specials are
  season 0 (`s0e2`).
- Episodes use `ParentIndexNumber` (season) and `IndexNumber` (episode) from Jellyfin.
- An item with no provider ids can't have a thread. Say so rather than showing an empty one;
  refreshing its metadata in Jellyfin usually fixes it.

The web player's version of this is `idsFor()` in
[`client/adapter-jellyfin.js`](https://github.com/tuikat/commentarr/blob/main/client/adapter-jellyfin.js).

## Step 3: call the comment server

```http
GET {serverUrl}/api/v1/comments?ids=tv/tvdb/81189/s1e3,tv/tmdb/1396/s1e3
Authorization: Bearer <token>
```

- JSON in, JSON out, UTF-8. Send `Content-Type: application/json` with bodies.
- Send a `User-Agent` naming your app and version, so problems can be traced to the right client.
- CORS is open, so web-based apps work too.
- **Errors** always look like `{"error": "A sentence you can show the user."}`:

| Status | Meaning |
| --- | --- |
| `400` | Bad request: missing ids, empty comment, comment over 1,000 characters… |
| `401` | Token missing, invalid or expired. Get a new one (Step 1) and retry once. |
| `403` | Not allowed: the user is banned, their server is blocked, or it isn't their comment. |
| `404` | That comment no longer exists (deleted, hidden), or unknown endpoint. |
| `409` | Duplicate: the user posted exactly this in the last 24 hours. |
| `422` | Contains a banned word. |
| `429` | Rate limited. Back off; the message says roughly how. |
| `503` | Live updates are at capacity. Comments still load normally: poll instead. |

### Rate limits

Per user unless noted. Generous for people, tight for scripts.

| Action | Limit |
| --- | --- |
| Post a comment | 6 a minute, 120 a day; 20 a minute and 400 a day per IP address; 2,000 a day per Jellyfin server |
| Like / unlike | 60 a minute (120 per IP) |
| Report | 20 an hour (40 per IP) |
| Mark or unmark a spoiler | 30 a minute |
| Change name | 5 an hour |
| Open a live stream | 60 a minute and 12 open at once per IP |
| Tokens (via the plugin) | 600 an hour per Jellyfin server |

## Endpoints

All need `Authorization: Bearer <token>` except `GET /api/v1/info`.

### The comment object

```json
{
  "id": 5,
  "parentId": null,
  "body": "what's he doing here lol",
  "posMs": 931959,
  "runtimeMs": 1298005,
  "spoiler": false,
  "createdAt": 1794741795956,
  "likes": 0,
  "liked": false,
  "mine": false,
  "author": { "name": "forester", "server": "Forester", "sameServer": true },
  "canDelete": false,
  "canHide": false
}
```

| Field | Meaning |
| --- | --- |
| `id` | Comment id. |
| `parentId` | `null` for a top-level comment; the parent's id for a reply. Replies are one level deep. |
| `body` | Plain text, up to 1,000 characters, may contain line breaks. **Never render it as HTML.** |
| `posMs` | The moment it's pinned to, in milliseconds from the start, or `null` for a comment on the whole title. |
| `runtimeMs` | Length of the file the writer was watching, or `null`. Use it to spot a different cut (see below). |
| `spoiler` | The writer (or a moderator) marked it as a spoiler. Cover it until the user chooses to read it. |
| `createdAt` | Unix time in milliseconds. |
| `likes`, `liked` | Like count, and whether this user liked it. |
| `mine` | Written by this user. |
| `author.name` | Display name. Names are shared across every server and can change. |
| `author.server` | The writer's Jellyfin server's display name. |
| `author.sameServer` | Written by someone on the user's own server. |
| `canDelete` | This user can delete it (their own, or, for admins, their server's users'). |
| `canHide` | This user is an admin and can hide it for their whole server. |

### `GET /api/v1/me`

```json
{ "id": "9706015e14e65b4ba53e7e24ddbd2cb7", "name": "Sam", "admin": false, "canPost": true }
```

`canPost` is `false` when the user is banned by their server's admin or by the comment server: show
comments, hide the composer.

### `PUT /api/v1/me`

```json
{ "name": "Sam K" }
```

2 to 32 characters. Returns `{ "name": "Sam K" }`. People start with their Jellyfin user name.

### `GET /api/v1/comments?ids=…&sort=top|new`

```json
{
  "thread": { "id": 3, "title": "Family Guy S23E01 Fat Gun", "kind": "episode" },
  "comments": [ /* comment objects, replies included */ ]
}
```

- `thread` is `null` when nobody has commented yet.
- `sort=top` (default) puts liked comments and whole-title comments first; `sort=new` is newest
  first. For "by time" order, sort by `posMs` yourself.
- Returns everything visible to this user (up to 2,000), already filtered by their server's blocks,
  hidden comments and banned words. Group replies under their `parentId`.

### `GET /api/v1/related?ids=…&limit=12`

Episodes only. The best top-level comments from the **other episodes** of the same show, each with
an extra `"fromEpisode": "S23E02"`. Handy for filling a quiet stretch. `limit` is 1 to 30.

### `POST /api/v1/comments`

```json
{
  "ids": ["tv/tvdb/81189/s1e3", "tv/tmdb/1396/s1e3"],
  "title": "Breaking Bad S01E03",
  "body": "That scene though",
  "posMs": 1112000,
  "runtimeMs": 2900000,
  "parentId": null,
  "spoiler": false
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ids` | yes | As in Step 2 (array or comma-separated string). |
| `body` | yes | 1 to 1,000 characters. |
| `title` | no | Human title for moderators, e.g. `"Breaking Bad S01E03"`. Up to 200 characters. |
| `posMs` | no | Pin to this moment (milliseconds). Omit or `null` for the whole title. Ignored on replies. |
| `runtimeMs` | no | The length of the user's file. Please send it with pinned comments. |
| `parentId` | no | Reply to this comment (a reply to a reply attaches to the top-level comment). |
| `spoiler` | no | `true` to cover it for everyone until they choose to read it. |

Returns the new comment object. It also arrives on everyone's live stream, including yours: skip
ids you already have.

### `POST /api/v1/comments/{id}/like`

Toggles. Returns `{ "liked": true, "likes": 4 }`.

### `POST /api/v1/comments/{id}/report`

```json
{ "reason": "spam" }
```

`reason` is optional free text (up to 200 characters). Returns `{ "reported": true }`. Reports go to
the writer's server's admins and the comment server's moderators. A comment reported by people on
several established servers is hidden until a moderator looks.

### `DELETE /api/v1/comments/{id}`

Allowed when `canDelete` is true. Returns `{ "deleted": true }`. Replies under it disappear too.

### `POST /api/v1/comments/{id}/spoiler`

```json
{ "spoiler": true }
```

The writer, or an admin of the writer's server, can mark or unmark a spoiler after posting. Returns
`{ "spoiler": true }`.

### `GET /api/v1/info` (no token)

```json
{ "name": "Commentarr", "version": "1.2.0", "terms": "https://…", "privacy": "https://…", "stats": { … } }
```

If you show a link to terms or privacy, use these.

## Live updates (server-sent events)

```http
GET {serverUrl}/api/v1/stream?ids=tv/tvdb/81189/s1e3,tv/tmdb/1396/s1e3&token=<token>
Accept: text/event-stream
```

The token can go in the `Authorization` header or, for SSE libraries that can't set headers, the
`token` query parameter. Events:

| Event | `data` | What to do |
| --- | --- | --- |
| `comment` | a comment object | Add it, unless you already have that `id`. |
| `removed` | `{ "id": 12 }` | Remove it and its replies. |
| `spoiler` | `{ "id": 12, "spoiler": true }` | Update the flag. |

- Lines starting with `:` are keep-alive pings, every 25 seconds.
- Open **one stream per title being watched**, and close it when playback stops.
- On disconnect, reconnect after the `retry` hint (5 seconds) with backoff. After a long gap,
  reload `GET /comments` too, since events sent while disconnected are not replayed.
- On `429` or `503`, fall back to reloading `GET /comments` every 30 to 60 seconds.
- Ignore event types you don't recognise.

## Moderation endpoints (server admins)

Only with a token where `admin` is `true`, and only ever about that Jellyfin server. Optional: the
plugin's settings page in the Jellyfin dashboard already covers all of this.

| Endpoint | Does |
| --- | --- |
| `GET /api/v1/server/reports` | Open reports on comments this server's users wrote or reported. |
| `POST /api/v1/server/comments/{id}/hide` · `/unhide` | Hide a comment for everyone on this server. |
| `POST /api/v1/server/comments/{id}/delete` | Delete a comment written by this server's user, everywhere. |
| `POST /api/v1/server/comments/{id}/dismiss` | Close this server's reports on it. |
| `GET /api/v1/server/users` | This server's commenters. |
| `POST /api/v1/server/users/{uid}/ban` · `/unban` | Stop one of this server's users commenting. |
| `POST /api/v1/server/users/{uid}/block` · `/unblock` | Hide everything from an outside person for this server. |
| `GET` / `PUT /api/v1/server/words` | This server's banned words: `{ "words": ["…"] }`. |

## Building a good client

These keep Commentarr consistent and safe across apps. Please follow them.

**Must**

- **Render comment text as plain text.** Never as HTML or Markdown.
- **Cover spoilers.** When `spoiler` is `true`, don't show any of the body (not even blurred)
  until the user taps to read it.
- **Offer Report** on other people's comments, and **Delete** where `canDelete` is true. Moderation
  depends on people being able to report.
- **Use the `serverUrl` from the token**, never a hard-coded address.
- **Keep tokens private.** Don't log them or share them between users.

**Should**

- **Pinned comments appear at their moment.** Show a comment as playback passes its `posMs`, the way
  the web player's overlay does. Comments with `posMs: null` are about the whole title.
- **Different cuts.** If a pinned comment's `runtimeMs` differs from the user's file by more than 3%,
  it was written on another version (extended, theatrical…): don't pop it up at its moment, and if
  you list it, note that the moment may be off.
- **Pinning is opt-in.** Let the user choose to pin a comment to the current moment. Don't pin
  everything by default.
- **Let people change their display name** (`PUT /me`), since other servers see it.
- **Hide the plugin's "Comments" subtitle track** when you show comments natively. It's an external
  subtitle stream titled `Comments` whose `DeliveryUrl` contains `/Commentarr/Subtitles/`. It exists
  for apps without native support.
- **Send `runtimeMs`** with pinned comments.

**Nice**

- Turn times written in a comment (`12:34`, `1:02:10`) into links that seek there.
- Use `GET /related` to fill quiet stretches on episodes, labelled with `fromEpisode`.
- Credit Commentarr somewhere with a link to https://github.com/tuikat/commentarr. Not required,
  but appreciated.

## Testing

- **Any Jellyfin 10.11 server with the plugin** (Dashboard → Plugins → Repositories, add
  `https://raw.githubusercontent.com/tuikat/commentarr/main/manifest.json`) works against the
  public server. Please keep test comments to a title nobody watches, and delete them after.
- **Your own comment server** for heavy testing: run this repository with Docker (see the
  [README](../README.md)), then set the plugin's comment server address to it in **Dashboard →
  Plugins → Commentarr**.
- `test/smoke.js` in this repository exercises most of the API end to end and is a working example
  of every call.

Questions, or something missing for your app? Open an issue at
https://github.com/tuikat/commentarr-server/issues.

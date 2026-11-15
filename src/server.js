// Commentarr server: shared, timestamped comments for self-hosted media servers.
// Zero dependencies: node:http + node:sqlite. AGPL-3.0-or-later.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT || 8790);
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC = path.join(__dirname, '..', 'public');
const SITE_NAME = process.env.SITE_NAME || 'Commentarr';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';          // behind Cloudflare / a reverse proxy
const TERMS_URL = process.env.TERMS_URL || '';
const PRIVACY_URL = process.env.PRIVACY_URL || '';
const AUTO_HIDE_REPORTS = Number(process.env.AUTO_HIDE_REPORTS || 3);
// Only established servers count towards automatic hiding, so three fresh registrations
// can't make a comment vanish.
const REPORT_TRUST_AGE = Number(process.env.REPORT_TRUST_HOURS || 48) * 3600000;
const MAX_USERS_PER_SERVER = Number(process.env.MAX_USERS_PER_SERVER || 200);
const TOKEN_TTL = 12 * 3600 * 1000;
const MAX_BODY = 1000;
const MAX_NAME = 32;

const db = open(DATA);

// A per-install secret signs user tokens. Generated once, kept in the data folder.
const SECRET = (() => {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get('secret');
  if (row) return row.v;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('secret', s);
  return s;
})();

// ------------------------------------------------------------------ helpers --

const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + hmac(body);
}

function readToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > now() ? p : null;
  } catch { return null; }
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').trim().slice(0, MAX_NAME);
}

function cleanBody(s) {
  return String(s || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ids look like movie/tmdb/603, movie/imdb/tt0133093, tv/tvdb/81189/s1e3, tv/tmdb/1396/s1e3
const ALIAS = /^(movie\/(tmdb\/\d{1,9}|imdb\/tt\d{5,10})|tv\/(tvdb\/\d{1,9}|tmdb\/\d{1,9}|imdb\/tt\d{5,10})\/s\d{1,4}e\d{1,5})$/;
function parseIds(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => ALIAS.test(s));
  return [...new Set(list)].slice(0, 6);
}

// ------------------------------------------------------------- rate limits --
// Small in-memory sliding windows. Restarting the server forgives everyone, which is fine.
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(t);
  buckets.set(key, arr);
  return false;
}
setInterval(() => {
  const t = now();
  for (const [k, arr] of buckets) if (!arr.length || t - arr[arr.length - 1] > 86400000) buckets.delete(k);
}, 600000).unref();

// ------------------------------------------------------------------ banned words --

let wordCache = new Map();            // scope -> RegExp | null
function wordsFor(scope) {
  if (wordCache.has(scope)) return wordCache.get(scope);
  const words = db.prepare('SELECT word FROM banned_words WHERE scope = ?').all(scope).map((r) => r.word);
  const re = words.length
    ? new RegExp('(^|[^\\p{L}\\p{N}])(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'iu')
    : null;
  wordCache.set(scope, re);
  return re;
}
const hits = (scope, text) => { const re = wordsFor(scope); return !!(re && re.test(text)); };

// ------------------------------------------------------------------ threads --

function findThread(ids) {
  if (!ids.length) return null;
  const rows = db.prepare(`SELECT DISTINCT thread_id FROM aliases WHERE alias IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (!rows.length) return null;
  const keep = Math.min(...rows.map((r) => r.thread_id));
  // Two servers knew the same title by different ids and started two threads: fold them together.
  for (const r of rows) {
    if (r.thread_id === keep) continue;
    db.prepare('UPDATE comments SET thread_id = ? WHERE thread_id = ?').run(keep, r.thread_id);
    db.prepare('UPDATE aliases SET thread_id = ? WHERE thread_id = ?').run(keep, r.thread_id);
  }
  for (const a of ids) db.prepare('INSERT OR IGNORE INTO aliases (alias, thread_id) VALUES (?, ?)').run(a, keep);
  return keep;
}

function ensureThread(ids, title) {
  const found = findThread(ids);
  if (found) {
    if (title) db.prepare("UPDATE threads SET title = ? WHERE id = ? AND title = ''").run(title, found);
    return found;
  }
  const kind = ids[0].startsWith('movie/') ? 'movie' : 'episode';
  const { lastInsertRowid } = db.prepare('INSERT INTO threads (kind, title, created_at) VALUES (?, ?, ?)').run(kind, String(title || '').slice(0, 200), now());
  for (const a of ids) db.prepare('INSERT OR IGNORE INTO aliases (alias, thread_id) VALUES (?, ?)').run(a, Number(lastInsertRowid));
  return Number(lastInsertRowid);
}

// ---------------------------------------------------------------- shaping --

const COMMENT_SQL = `
  SELECT c.id, c.parent_id, c.body, c.pos_ms, c.runtime_ms, c.status, c.likes, c.created_at,
         c.user_id, c.server_id, u.name AS author, s.name AS server_name
  FROM comments c JOIN users u ON u.id = c.user_id JOIN servers s ON s.id = c.server_id`;

function visibleTo(viewer) {
  // what this viewer's server has hidden or blocked
  const hidden = new Set(db.prepare('SELECT comment_id FROM server_hidden WHERE server_id = ?').all(viewer.sid).map((r) => r.comment_id));
  const blocked = new Set(db.prepare('SELECT user_id FROM server_blocks WHERE server_id = ?').all(viewer.sid).map((r) => r.user_id));
  return (c) => c.status === 'visible'
    && !hidden.has(c.id)
    && !blocked.has(c.user_id)
    && !hits(viewer.sid, c.body);
}

function shape(c, viewer, likedSet) {
  const mine = c.user_id === viewer.uid;
  return {
    id: c.id,
    parentId: c.parent_id,
    body: c.body,
    posMs: c.pos_ms,
    runtimeMs: c.runtime_ms,
    createdAt: c.created_at,
    likes: c.likes,
    liked: likedSet.has(c.id),
    mine,
    author: { name: c.author, server: c.server_name, sameServer: c.server_id === viewer.sid },
    canDelete: mine || (viewer.adm && c.server_id === viewer.sid),
    canHide: !!viewer.adm,
  };
}

// ------------------------------------------------------------------ live (SSE) --

// Subscriptions are keyed by the ids a viewer knows the title by, so watching a title that has
// no comments yet creates nothing in the database. Publishing fans out to every alias of a thread.
const streams = new Map();            // alias -> Set<{res, viewer}>
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 5000);
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP || 12);
let streamCount = 0;
const streamsByIp = new Map();
function listeners(threadId) {
  const out = new Set();
  for (const r of db.prepare('SELECT alias FROM aliases WHERE thread_id = ?').all(threadId)) {
    const set = streams.get(r.alias);
    if (set) for (const e of set) out.add(e);
  }
  return out;
}
function publish(threadId, row) {
  const filters = new Map();           // one visibility check per media server, not per viewer
  for (const s of listeners(threadId)) {
    try {
      let ok = filters.get(s.viewer.sid);
      if (!ok) { ok = visibleTo(s.viewer); filters.set(s.viewer.sid, ok); }
      if (!ok(row)) continue;
      s.res.write(`event: comment\ndata: ${JSON.stringify(shape(row, s.viewer, new Set()))}\n\n`);
    } catch { /* closed */ }
  }
}
function publishRemoval(threadId, id) {
  for (const s of listeners(threadId)) { try { s.res.write(`event: removed\ndata: ${JSON.stringify({ id })}\n\n`); } catch { } }
}
setInterval(() => { const seen = new Set(); for (const set of streams.values()) for (const s of set) { if (seen.has(s)) continue; seen.add(s); try { s.res.write(': ping\n\n'); } catch { } } }, 25000).unref();

function markDeleted(id, by) {
  db.prepare("UPDATE comments SET status = 'deleted', deleted_at = ?, deleted_by = ? WHERE id = ?").run(now(), by, id);
  console.log(new Date().toISOString(), 'comment', id, 'deleted by', by);
}

// ------------------------------------------------------------------ http plumbing --

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('token') || '';
}

function viewerOf(req, url, required = true) {
  const p = readToken(bearer(req, url));
  if (!p) { if (required) fail(401, 'Sign-in expired. Reopen the player to refresh.'); return null; }
  const server = db.prepare('SELECT banned FROM servers WHERE id = ?').get(p.sid);
  if (!server || server.banned) fail(403, 'This server has been blocked from Commentarr.');
  return p;
}

function serverOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Server ([a-f0-9]{16,40}):([A-Za-z0-9_-]{20,80})$/.exec(h);
  if (!m) fail(401, 'Missing server key');
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(m[1]);
  if (!row || !safeEqual(row.key_hash, sha(m[2]))) fail(401, 'Unknown server');
  if (row.banned) fail(403, 'This server has been blocked from Commentarr.');
  db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').run(now(), row.id);
  return row;
}

function adminOf(req) {
  const h = req.headers.authorization || '';
  if (!ADMIN_TOKEN || !h.startsWith('Admin ') || !safeEqual(h.slice(6), ADMIN_TOKEN)) fail(401, 'Not an admin');
}

function serverAdminOf(req, url) {
  const v = viewerOf(req, url);
  if (!v.adm) fail(403, 'Only this server\'s administrators can do that');
  return v;
}

// ------------------------------------------------------------------ routes --

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/healthz', () => ({ ok: true, version: VERSION }));

route('GET', '/api/v1/info', () => ({
  name: SITE_NAME, version: VERSION, terms: TERMS_URL || null, privacy: PRIVACY_URL || null,
  stats: {
    comments: db.prepare("SELECT COUNT(*) n FROM comments WHERE status = 'visible'").get().n,
    servers: db.prepare('SELECT COUNT(*) n FROM servers WHERE banned = 0').get().n,
    titles: db.prepare("SELECT COUNT(DISTINCT thread_id) n FROM comments WHERE status = 'visible'").get().n,
  },
}));

// A media server registers once and keeps its key. The key never leaves that server.
route('POST', '/api/v1/servers', async (req) => {
  const ip = clientIp(req);
  if (limited('reg:' + ip, 5, 86400000)) fail(429, 'Too many registrations from this address today');
  const b = await readJson(req);
  const id = crypto.randomBytes(12).toString('hex');
  const key = crypto.randomBytes(32).toString('base64url');
  const kind = b.kind === 'plex-userscript' ? 'plex-userscript' : 'jellyfin';
  db.prepare('INSERT INTO servers (id, key_hash, name, kind, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, sha(key), cleanName(b.name) || 'Media server', kind, now(), now());
  return { serverId: id, serverKey: key };
});

// The media server vouches for one of its users and gets a short-lived token for their browser.
route('POST', '/api/v1/token', async (req) => {
  const server = serverOf(req);
  const b = await readJson(req);
  if (b.serverName) db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(cleanName(b.serverName) || server.name, server.id);
  const ext = String(b.userId || '').trim();
  if (!ext || ext.length > 100) fail(400, 'userId required');
  if (limited('tok:' + server.id, 600, 3600000)) fail(429, 'Slow down');
  // A media server is a household or a group of friends; thousands of distinct users is a sock-puppet farm.
  if (db.prepare('SELECT COUNT(*) n FROM users WHERE server_id = ?').get(server.id).n >= MAX_USERS_PER_SERVER
      && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(sha(server.id + ':' + String(b.userId || '').trim()).slice(0, 32))) {
    fail(429, 'This media server has reached the user limit for the shared comment server.');
  }
  const uid = sha(server.id + ':' + ext).slice(0, 32);
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!user) {
    const name = cleanName(b.name) || 'Viewer';
    db.prepare('INSERT INTO users (id, server_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(uid, server.id, name, now(), now());
    user = { id: uid, name, banned: 0 };
  } else {
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), uid);
  }
  const exp = now() + TOKEN_TTL;
  const token = signToken({ sid: server.id, uid, adm: !!b.admin, exp });
  return { token, exp, user: { id: uid, name: user.name } };
});

route('GET', '/api/v1/me', (req, url) => {
  const v = viewerOf(req, url);
  const u = db.prepare('SELECT name, banned FROM users WHERE id = ?').get(v.uid);
  const sb = db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(v.sid, v.uid);
  return { id: v.uid, name: u ? u.name : 'Viewer', admin: !!v.adm, canPost: !!u && !u.banned && !sb };
});

route('PUT', '/api/v1/me', async (req, url) => {
  const v = viewerOf(req, url);
  const b = await readJson(req);
  const name = cleanName(b.name);
  if (name.length < 2) fail(400, 'Names need at least 2 characters');
  if (hits('global', name) || hits(v.sid, name)) fail(422, 'That name isn\'t allowed here');
  if (limited('name:' + v.uid, 5, 3600000)) fail(429, 'You can change your name 5 times an hour');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, v.uid);
  return { name };
});

route('GET', '/api/v1/comments', (req, url) => {
  const v = viewerOf(req, url);
  const ids = parseIds(url.searchParams.get('ids'));
  if (!ids.length) fail(400, 'No recognised ids');
  const thread = findThread(ids);
  if (!thread) return { thread: null, comments: [] };
  const sort = url.searchParams.get('sort') === 'new' ? 'c.created_at DESC' : '(c.likes * 3 + (c.pos_ms IS NULL)) DESC, c.created_at DESC';
  const rows = db.prepare(`${COMMENT_SQL} WHERE c.thread_id = ? AND c.status = 'visible' ORDER BY ${sort} LIMIT 2000`).all(thread);
  const ok = visibleTo(v);
  const liked = new Set(db.prepare('SELECT l.comment_id FROM likes l JOIN comments c ON c.id = l.comment_id WHERE c.thread_id = ? AND l.user_id = ?').all(thread, v.uid).map((r) => r.comment_id));
  const t = db.prepare('SELECT id, title, kind FROM threads WHERE id = ?').get(thread);
  const shown = rows.filter(ok);
  const tops = new Set(shown.filter((c) => !c.parent_id).map((c) => c.id));
  // replies under a comment that is gone (deleted, hidden, filtered) go with it
  return { thread: t, comments: shown.filter((c) => !c.parent_id || tops.has(c.parent_id)).map((c) => shape(c, v, liked)) };
});

// The best comments on the rest of the show, for an episode whose own thread is quiet.
// Episodes of one show share an id prefix (tv/tvdb/75978/...), so this needs no extra lookups.
route('GET', '/api/v1/related', (req, url) => {
  const v = viewerOf(req, url);
  const ids = parseIds(url.searchParams.get('ids')).filter((a) => a.startsWith('tv/'));
  if (!ids.length) return { comments: [] };
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 12));
  const here = findThread(ids);
  const prefixes = [...new Set(ids.map((a) => a.replace(/s\d+e\d+$/, '')))];
  const threads = new Map();   // thread id -> episode label
  for (const p of prefixes) {
    for (const r of db.prepare('SELECT alias, thread_id FROM aliases WHERE alias LIKE ?').all(p + '%')) {
      if (r.thread_id === here || threads.has(r.thread_id)) continue;
      const m = /s(\d+)e(\d+)$/.exec(r.alias);
      if (m) threads.set(r.thread_id, 'S' + m[1].padStart(2, '0') + 'E' + m[2].padStart(2, '0'));
    }
  }
  if (!threads.size) return { comments: [] };
  const list = [...threads.keys()];
  const rows = db.prepare(`${COMMENT_SQL.replace('SELECT c.id,', 'SELECT c.thread_id, c.id,')} WHERE c.thread_id IN (${list.map(() => '?').join(',')}) AND c.status = 'visible' AND c.parent_id IS NULL
    ORDER BY c.likes DESC, c.created_at DESC LIMIT 200`).all(...list);
  const ok = visibleTo(v);
  return {
    comments: rows.filter(ok).slice(0, limit).map((c) => ({ ...shape(c, v, new Set()), fromEpisode: threads.get(c.thread_id) || null })),
  };
});

route('POST', '/api/v1/comments', async (req, url) => {
  const v = viewerOf(req, url);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(v.uid);
  if (!u || u.banned) fail(403, 'You can\'t post comments.');
  if (db.prepare('SELECT 1 FROM server_bans WHERE server_id = ? AND user_id = ?').get(v.sid, v.uid)) fail(403, 'Your server\'s admin has turned off commenting for you.');
  const b = await readJson(req);
  const ids = parseIds(b.ids);
  if (!ids.length) fail(400, 'This title has no TMDB, TVDB or IMDb id, so it can\'t have a shared thread yet.');
  const body = cleanBody(b.body);
  if (!body) fail(400, 'Write something first');
  if (body.length > MAX_BODY) fail(400, `Comments are limited to ${MAX_BODY} characters`);
  if (hits('global', body) || hits(v.sid, body)) fail(422, 'That comment contains a word that isn\'t allowed here.');
  const ip = clientIp(req);
  if (limited('c:' + v.uid, 6, 60000) || limited('cd:' + v.uid, 120, 86400000)) fail(429, 'You\'re commenting very fast. Try again in a minute.');
  if (limited('ci:' + ip, 20, 60000) || limited('cid:' + ip, 400, 86400000)) fail(429, 'A lot of comments are coming from your address. Try again later.');
  if (limited('cs:' + v.sid, 2000, 86400000)) fail(429, 'This server has hit today\'s comment limit.');
  // Exact repeats within a day are almost always spam.
  if (db.prepare("SELECT 1 FROM comments WHERE user_id = ? AND body = ? AND created_at > ? AND status != 'deleted'").get(v.uid, body, now() - 86400000)) fail(409, 'You already posted that.');

  const pos = Number.isFinite(b.posMs) && b.posMs >= 0 && b.posMs < 48 * 3600000 ? Math.round(b.posMs) : null;
  const runtime = Number.isFinite(b.runtimeMs) && b.runtimeMs > 0 && b.runtimeMs < 48 * 3600000 ? Math.round(b.runtimeMs) : null;
  const thread = ensureThread(ids, String(b.title || '').slice(0, 200));
  let parent = null;
  if (b.parentId != null) {
    const p = db.prepare("SELECT id, thread_id, parent_id FROM comments WHERE id = ? AND status = 'visible'").get(Number(b.parentId));
    if (!p || p.thread_id !== thread) fail(400, 'That comment is gone');
    parent = p.parent_id || p.id;     // one level of replies
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO comments (thread_id, user_id, server_id, parent_id, body, pos_ms, runtime_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(thread, v.uid, v.sid, parent, body, parent ? null : pos, runtime, now());
  const row = db.prepare(`${COMMENT_SQL} WHERE c.id = ?`).get(Number(lastInsertRowid));
  publish(thread, row);
  return shape(row, v, new Set());
});

route('POST', '/api/v1/comments/:id/like', (req, url, p) => {
  const v = viewerOf(req, url);
  const id = Number(p.id);
  const c = db.prepare("SELECT id FROM comments WHERE id = ? AND status = 'visible'").get(id);
  if (!c) fail(404, 'Comment not found');
  if (limited('l:' + v.uid, 60, 60000) || limited('li:' + clientIp(req), 120, 60000)) fail(429, 'Slow down');
  const had = db.prepare('SELECT 1 FROM likes WHERE comment_id = ? AND user_id = ?').get(id, v.uid);
  if (had) db.prepare('DELETE FROM likes WHERE comment_id = ? AND user_id = ?').run(id, v.uid);
  else db.prepare('INSERT INTO likes (comment_id, user_id) VALUES (?, ?)').run(id, v.uid);
  db.prepare('UPDATE comments SET likes = (SELECT COUNT(*) FROM likes WHERE comment_id = ?) WHERE id = ?').run(id, id);
  return { liked: !had, likes: db.prepare('SELECT likes FROM comments WHERE id = ?').get(id).likes };
});

route('POST', '/api/v1/comments/:id/report', async (req, url, p) => {
  const v = viewerOf(req, url);
  const id = Number(p.id);
  const c = db.prepare("SELECT id, thread_id, status FROM comments WHERE id = ? AND status = 'visible'").get(id);
  if (!c) fail(404, 'Comment not found');
  if (limited('r:' + v.uid, 20, 3600000) || limited('ri:' + clientIp(req), 40, 3600000)) fail(429, 'Slow down');
  const b = await readJson(req);
  db.prepare('INSERT OR IGNORE INTO reports (comment_id, user_id, server_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, v.uid, v.sid, String(b.reason || '').slice(0, 200), now());
  // Enough people from different servers agree: hide it until a moderator looks.
  const n = db.prepare(`SELECT COUNT(DISTINCT r.server_id) n FROM reports r JOIN servers s ON s.id = r.server_id
    WHERE r.comment_id = ? AND r.resolved = 0 AND s.banned = 0 AND s.created_at < ?
      AND EXISTS (SELECT 1 FROM comments c WHERE c.server_id = s.id AND c.status = 'visible')`).get(id, now() - REPORT_TRUST_AGE).n;
  if (n >= AUTO_HIDE_REPORTS) {
    db.prepare("UPDATE comments SET status = 'hidden' WHERE id = ?").run(id);
    publishRemoval(c.thread_id, id);
  }
  return { reported: true };
});

route('DELETE', '/api/v1/comments/:id', (req, url, p) => {
  const v = viewerOf(req, url);
  const c = db.prepare('SELECT id, thread_id, user_id, server_id FROM comments WHERE id = ?').get(Number(p.id));
  if (!c) fail(404, 'Comment not found');
  const allowed = c.user_id === v.uid || (v.adm && c.server_id === v.sid);
  if (!allowed) fail(403, 'You can only delete your own comments');
  markDeleted(c.id, c.user_id === v.uid ? 'author' : 'server-admin:' + v.sid);
  publishRemoval(c.thread_id, c.id);
  return { deleted: true };
});

route('GET', '/api/v1/stream', (req, url, p, res) => {
  const v = viewerOf(req, url);
  const ids = parseIds(url.searchParams.get('ids'));
  if (!ids.length) fail(400, 'No recognised ids');
  const ip = clientIp(req);
  if (limited('sse:' + ip, 60, 60000)) fail(429, 'Slow down');
  if (streamCount >= MAX_STREAMS) fail(503, 'Live updates are busy right now; comments still load normally.');
  if ((streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) fail(429, 'Too many open comment streams from this address.');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  const entry = { res, viewer: v };
  for (const a of ids) { if (!streams.has(a)) streams.set(a, new Set()); streams.get(a).add(entry); }
  streamCount++; streamsByIp.set(ip, (streamsByIp.get(ip) || 0) + 1);
  req.on('close', () => {
    for (const a of ids) { const s = streams.get(a); if (s) { s.delete(entry); if (!s.size) streams.delete(a); } }
    streamCount--; const n = (streamsByIp.get(ip) || 1) - 1; if (n > 0) streamsByIp.set(ip, n); else streamsByIp.delete(ip);
  });
  return undefined; // stays open
});

// ---- moderation for a media server's own administrators ----

function reportRows(where, args) {
  return db.prepare(`
    SELECT c.id, c.body, c.status, c.created_at, c.pos_ms, c.user_id, c.server_id,
           u.name AS author, s.name AS server_name, t.title,
           COUNT(r.user_id) AS reports, GROUP_CONCAT(NULLIF(r.reason, ''), ' · ') AS reasons
    FROM reports r
    JOIN comments c ON c.id = r.comment_id
    JOIN users u ON u.id = c.user_id
    JOIN servers s ON s.id = c.server_id
    JOIN threads t ON t.id = c.thread_id
    WHERE ${where}
    GROUP BY c.id ORDER BY reports DESC, c.created_at DESC LIMIT 200`).all(...args);
}

route('GET', '/api/v1/server/reports', (req, url) => {
  const v = serverAdminOf(req, url);
  // Comments reported by this server's users, or written by them and reported by anyone.
  const rows = reportRows("r.resolved = 0 AND c.status != 'deleted' AND (r.server_id = ? OR c.server_id = ?)", [v.sid, v.sid]);
  const hidden = new Set(db.prepare('SELECT comment_id FROM server_hidden WHERE server_id = ?').all(v.sid).map((r) => r.comment_id));
  return rows.map((r) => ({ ...r, ownUser: r.server_id === v.sid, hiddenHere: hidden.has(r.id) }));
});

route('POST', '/api/v1/server/comments/:id/:action', (req, url, p) => {
  const v = serverAdminOf(req, url);
  const id = Number(p.id);
  const c = db.prepare('SELECT id, thread_id, server_id FROM comments WHERE id = ?').get(id);
  if (!c) fail(404, 'Comment not found');
  switch (p.action) {
    case 'hide': db.prepare('INSERT OR IGNORE INTO server_hidden (server_id, comment_id) VALUES (?, ?)').run(v.sid, id); break;
    case 'unhide': db.prepare('DELETE FROM server_hidden WHERE server_id = ? AND comment_id = ?').run(v.sid, id); break;
    case 'delete':
      if (c.server_id !== v.sid) fail(403, 'You can delete comments from your own users. Hide this one for your server instead.');
      markDeleted(id, 'server-admin:' + v.sid);
      publishRemoval(c.thread_id, id);
      break;
    case 'dismiss': db.prepare('UPDATE reports SET resolved = 1 WHERE comment_id = ? AND server_id = ?').run(id, v.sid); break;
    default: fail(404, 'Unknown action');
  }
  return { ok: true };
});

route('GET', '/api/v1/server/users', (req, url) => {
  const v = serverAdminOf(req, url);
  return db.prepare(`
    SELECT u.id, u.name, u.created_at, u.last_seen,
      (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id AND c.status = 'visible') AS comments,
      EXISTS (SELECT 1 FROM server_bans b WHERE b.server_id = ? AND b.user_id = u.id) AS banned
    FROM users u WHERE u.server_id = ? ORDER BY u.last_seen DESC LIMIT 500`).all(v.sid, v.sid);
});

route('POST', '/api/v1/server/users/:uid/:action', (req, url, p) => {
  const v = serverAdminOf(req, url);
  const u = db.prepare('SELECT id, server_id FROM users WHERE id = ?').get(p.uid);
  if (!u) fail(404, 'User not found');
  switch (p.action) {
    case 'ban':
      if (u.server_id !== v.sid) fail(403, 'You can only ban your own users. Block this one instead.');
      db.prepare('INSERT OR IGNORE INTO server_bans (server_id, user_id) VALUES (?, ?)').run(v.sid, u.id); break;
    case 'unban': db.prepare('DELETE FROM server_bans WHERE server_id = ? AND user_id = ?').run(v.sid, u.id); break;
    case 'block': db.prepare('INSERT OR IGNORE INTO server_blocks (server_id, user_id) VALUES (?, ?)').run(v.sid, u.id); break;
    case 'unblock': db.prepare('DELETE FROM server_blocks WHERE server_id = ? AND user_id = ?').run(v.sid, u.id); break;
    default: fail(404, 'Unknown action');
  }
  return { ok: true };
});

function wordsGet(scope) { return db.prepare('SELECT word FROM banned_words WHERE scope = ? ORDER BY word').all(scope).map((r) => r.word); }
function wordsPut(scope, list) {
  const words = [...new Set((Array.isArray(list) ? list : []).map((w) => String(w).trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= 40))].slice(0, 500);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM banned_words WHERE scope = ?').run(scope);
    for (const w of words) db.prepare('INSERT INTO banned_words (scope, word) VALUES (?, ?)').run(scope, w);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  wordCache.delete(scope);
  return words;
}
route('GET', '/api/v1/server/words', (req, url) => ({ words: wordsGet(serverAdminOf(req, url).sid) }));
route('PUT', '/api/v1/server/words', async (req, url) => { const v = serverAdminOf(req, url); const b = await readJson(req, 65536); return { words: wordsPut(v.sid, b.words) }; });

// ---- the operator of this Commentarr server ----

route('GET', '/api/v1/admin/overview', (req) => {
  adminOf(req);
  return {
    comments: db.prepare("SELECT status, COUNT(*) n FROM comments GROUP BY status").all(),
    servers: db.prepare('SELECT COUNT(*) n FROM servers').get().n,
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    openReports: db.prepare('SELECT COUNT(DISTINCT comment_id) n FROM reports WHERE resolved = 0').get().n,
  };
});
route('GET', '/api/v1/admin/reports', (req) => { adminOf(req); return reportRows("r.resolved = 0 AND c.status != 'deleted'", []); });
route('GET', '/api/v1/admin/comments', (req, url) => {
  adminOf(req);
  const q = (url.searchParams.get('q') || '').trim();
  const rows = db.prepare(`${COMMENT_SQL.replace('FROM comments c', ', t.title, c.deleted_by, c.deleted_at FROM comments c JOIN threads t ON t.id = c.thread_id')}
    WHERE (? = '' OR c.body LIKE ? OR u.name LIKE ?) ORDER BY c.created_at DESC LIMIT 200`).all(q, `%${q}%`, `%${q}%`);
  return rows;
});
route('POST', '/api/v1/admin/comments/:id/:action', (req, url, p) => {
  adminOf(req);
  const id = Number(p.id);
  const c = db.prepare('SELECT id, thread_id FROM comments WHERE id = ?').get(id);
  if (!c) fail(404, 'Comment not found');
  if (p.action === 'delete') { markDeleted(id, 'operator'); publishRemoval(c.thread_id, id); }
  else if (p.action === 'restore') db.prepare("UPDATE comments SET status = 'visible', deleted_at = NULL, deleted_by = NULL WHERE id = ?").run(id);
  else fail(404, 'Unknown action');
  db.prepare('UPDATE reports SET resolved = 1 WHERE comment_id = ?').run(id);
  return { ok: true };
});
route('POST', '/api/v1/admin/users/:uid/:action', (req, url, p) => {
  adminOf(req);
  if (!['ban', 'unban'].includes(p.action)) fail(404, 'Unknown action');
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(p.action === 'ban' ? 1 : 0, p.uid);
  if (p.action === 'ban') db.prepare("UPDATE comments SET status = 'hidden' WHERE user_id = ? AND status = 'visible'").run(p.uid);
  return { ok: true };
});
route('GET', '/api/v1/admin/servers', (req) => {
  adminOf(req);
  return db.prepare(`SELECT s.id, s.name, s.kind, s.banned, s.created_at, s.last_seen,
    (SELECT COUNT(*) FROM users u WHERE u.server_id = s.id) users,
    (SELECT COUNT(*) FROM comments c WHERE c.server_id = s.id) comments
    FROM servers s ORDER BY s.last_seen DESC LIMIT 500`).all();
});
route('POST', '/api/v1/admin/servers/:sid/:action', (req, url, p) => {
  adminOf(req);
  if (!['ban', 'unban'].includes(p.action)) fail(404, 'Unknown action');
  db.prepare('UPDATE servers SET banned = ? WHERE id = ?').run(p.action === 'ban' ? 1 : 0, p.sid);
  if (p.action === 'ban') db.prepare("UPDATE comments SET status = 'hidden' WHERE server_id = ? AND status = 'visible'").run(p.sid);
  return { ok: true };
});
route('GET', '/api/v1/admin/words', (req) => { adminOf(req); return { words: wordsGet('global') }; });
route('PUT', '/api/v1/admin/words', async (req) => { adminOf(req); const b = await readJson(req, 65536); return { words: wordsPut('global', b.words) }; });

// ------------------------------------------------------------------ static --

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '/': 'index.html', '/admin': 'admin.html' };

function serveStatic(req, res, pathname) {
  let file = PAGES[pathname] || pathname.slice(1);
  if (!file || file.includes('..')) return false;
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  let body = fs.readFileSync(full);
  if (file.endsWith('.html')) {
    body = body.toString()
      .replaceAll('{{SITE_NAME}}', SITE_NAME)
      .replaceAll('{{TERMS_URL}}', TERMS_URL || '#')
      .replaceAll('{{PRIVACY_URL}}', PRIVACY_URL || '#')
      .replaceAll('{{VERSION}}', VERSION);
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(file === 'admin.html' ? { 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex' } : {}),
  });
  res.end(body);
  return true;
}

// ------------------------------------------------------------------ server --

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Any media server, on any domain, calls this API from its viewers' browsers.
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const out = await r.fn(req, url, m.groups || {}, res);
      if (out !== undefined) send(res, 200, out);
      return;
    }
    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { } return; }
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(new Date().toISOString(), req.method, url.pathname, e);
    send(res, 500, { error: 'Something went wrong on the comment server.' });
  }
});

server.listen(PORT, () => console.log(`${SITE_NAME} ${VERSION} listening on :${PORT} (data: ${DATA})${ADMIN_TOKEN ? '' : '; ADMIN_TOKEN not set, /admin disabled'}`));

// Nightly consistent backup next to the database (keeps 7).
function backup() {
  try {
    const dir = path.join(DATA, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `commentarr-${new Date().toISOString().slice(0, 10)}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    for (const f of all.slice(0, -7)) fs.unlinkSync(path.join(dir, f));
  } catch (e) { console.error('backup failed', e.message); }
}
setTimeout(backup, 60000).unref();
setInterval(backup, 6 * 3600000).unref();

// Deleted comments disappear from view at once; their rows are erased after 30 days (backups roll
// over after 7 more), so a deletion is final. Replies to a deleted comment go with it.
function purge() {
  try {
    const cutoff = now() - 30 * 86400000;
    const ids = db.prepare("SELECT id FROM comments WHERE status = 'deleted' AND COALESCE(deleted_at, created_at) < ?").all(cutoff).map((r) => r.id);
    if (!ids.length) return;
    db.exec('BEGIN');
    for (const id of ids) {
      for (const t of ['likes', 'reports']) db.prepare(`DELETE FROM ${t} WHERE comment_id = ?`).run(id);
      db.prepare('DELETE FROM server_hidden WHERE comment_id = ?').run(id);
      db.prepare('UPDATE comments SET parent_id = NULL WHERE parent_id = ?').run(id);
      db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    }
    db.exec('COMMIT');
    console.log(`purged ${ids.length} deleted comment(s)`);
  } catch (e) { try { db.exec('ROLLBACK'); } catch { } console.error('purge failed', e.message); }
}
setTimeout(purge, 90000).unref();
setInterval(purge, 24 * 3600000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });

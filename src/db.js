// SQLite storage. One file, WAL mode, no external database.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'commentarr.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS servers (
      id          TEXT PRIMARY KEY,
      key_hash    TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT 'jellyfin',      -- jellyfin | plex-userscript
      banned      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    -- A user is (server, that server's own user id), hashed. We never see usernames or emails.
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      server_id   TEXT NOT NULL REFERENCES servers(id),
      name        TEXT NOT NULL,
      banned      INTEGER NOT NULL DEFAULT 0,           -- banned everywhere (global admin)
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_server ON users(server_id);

    -- One thread per title (movie) or episode, whatever file or version people have.
    CREATE TABLE IF NOT EXISTS threads (
      id          INTEGER PRIMARY KEY,
      kind        TEXT NOT NULL,                         -- movie | episode
      title       TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );
    -- Every external id a thread is known by: movie/tmdb/603, tv/tvdb/81189/s1e3 ...
    CREATE TABLE IF NOT EXISTS aliases (
      alias       TEXT PRIMARY KEY,
      thread_id   INTEGER NOT NULL REFERENCES threads(id)
    );
    CREATE INDEX IF NOT EXISTS aliases_thread ON aliases(thread_id);

    CREATE TABLE IF NOT EXISTS comments (
      id          INTEGER PRIMARY KEY,
      thread_id   INTEGER NOT NULL REFERENCES threads(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      server_id   TEXT NOT NULL REFERENCES servers(id),
      parent_id   INTEGER REFERENCES comments(id),
      body        TEXT NOT NULL,
      pos_ms      INTEGER,                               -- pinned moment, or NULL for the whole title
      runtime_ms  INTEGER,                               -- the commenter's file length, to spot other cuts
      status      TEXT NOT NULL DEFAULT 'visible',       -- visible | hidden (auto/global review) | deleted
      likes       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id, status);
    CREATE INDEX IF NOT EXISTS comments_user ON comments(user_id);

    CREATE TABLE IF NOT EXISTS likes (
      comment_id  INTEGER NOT NULL REFERENCES comments(id),
      user_id     TEXT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      comment_id  INTEGER NOT NULL REFERENCES comments(id),
      user_id     TEXT NOT NULL,
      server_id   TEXT NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      resolved    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (comment_id, user_id)
    );

    -- A server admin hiding one comment, or everything from one outside user, for their own viewers.
    CREATE TABLE IF NOT EXISTS server_hidden (
      server_id   TEXT NOT NULL,
      comment_id  INTEGER NOT NULL,
      PRIMARY KEY (server_id, comment_id)
    );
    CREATE TABLE IF NOT EXISTS server_blocks (
      server_id   TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );
    -- A server admin banning one of their own users from posting.
    CREATE TABLE IF NOT EXISTS server_bans (
      server_id   TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );

    -- scope = 'global' or a server id
    CREATE TABLE IF NOT EXISTS banned_words (
      scope       TEXT NOT NULL,
      word        TEXT NOT NULL,
      PRIMARY KEY (scope, word)
    );

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  // migrations: who deleted a comment and when (for moderation history and the 30-day erase)
  for (const col of ['deleted_at INTEGER', 'deleted_by TEXT']) {
    try { db.exec(`ALTER TABLE comments ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  return db;
}

module.exports = { open };

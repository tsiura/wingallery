import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

// Append only: MIGRATIONS[i] takes the schema from user_version i to i + 1.
const MIGRATIONS: string[] = [
  `
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
  `,
];

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // NORMAL is safe with WAL: a power cut can lose the last commits but not corrupt the file. FULL syncs the disk on every commit, and this
    // connection is synchronous, so a cold folder (one metadata row per file) would stall every request for as many syncs as it has files.
    db.exec('PRAGMA synchronous = NORMAL');
  }
  const version = () => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version() < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // re-read inside the write lock: a second process may have migrated meanwhile
      for (let i = version(); i < MIGRATIONS.length; i++) db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

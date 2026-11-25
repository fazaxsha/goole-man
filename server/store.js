import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  cache_bytes INTEGER NOT NULL DEFAULT 0,
  site_bytes INTEGER NOT NULL DEFAULT 0,
  ext_bytes INTEGER NOT NULL DEFAULT 0,
  hist_bytes INTEGER NOT NULL DEFAULT 0,
  other_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  origin_count INTEGER NOT NULL DEFAULT 0,
  ext_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  stale_lock INTEGER NOT NULL DEFAULT 0,
  synced INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  mtime INTEGER NOT NULL DEFAULT 0,
  scanned_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS origins (
  profile_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  host TEXT NOT NULL,
  idb_bytes INTEGER NOT NULL DEFAULT 0,
  cookie_bytes INTEGER NOT NULL DEFAULT 0,
  cookie_count INTEGER NOT NULL DEFAULT 0,
  ls_bytes INTEGER NOT NULL DEFAULT 0,
  ls_keys INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, origin)
);
CREATE TABLE IF NOT EXISTS extensions (
  profile_id TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  bytes INTEGER NOT NULL DEFAULT 0,
  ext_path TEXT,
  unpacked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, ext_id)
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  profile_id TEXT,
  profile_name TEXT,
  detail TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'index.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const q = {
    upsertProfile: db.prepare(`
      INSERT INTO profiles (id, root, path, name, total_bytes, cache_bytes, site_bytes, ext_bytes,
        hist_bytes, other_bytes, file_count, origin_count, ext_count, locked, stale_lock, synced,
        error, mtime, scanned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        root=excluded.root, path=excluded.path, name=excluded.name,
        total_bytes=excluded.total_bytes, cache_bytes=excluded.cache_bytes,
        site_bytes=excluded.site_bytes, ext_bytes=excluded.ext_bytes,
        hist_bytes=excluded.hist_bytes, other_bytes=excluded.other_bytes,
        file_count=excluded.file_count, origin_count=excluded.origin_count,
        ext_count=excluded.ext_count, locked=excluded.locked, stale_lock=excluded.stale_lock,
        synced=excluded.synced, error=excluded.error, mtime=excluded.mtime,
        scanned_at=excluded.scanned_at`),
    delOrigins: db.prepare('DELETE FROM origins WHERE profile_id = ?'),
    delExtensions: db.prepare('DELETE FROM extensions WHERE profile_id = ?'),
    insOrigin: db.prepare(`INSERT INTO origins
      (profile_id, origin, host, idb_bytes, cookie_bytes, cookie_count, ls_bytes, ls_keys)
      VALUES (?,?,?,?,?,?,?,?)`),
    insExtension: db.prepare(`INSERT INTO extensions
      (profile_id, ext_id, name, version, enabled, bytes, ext_path, unpacked)
      VALUES (?,?,?,?,?,?,?,?)`),
    list: db.prepare('SELECT * FROM profiles ORDER BY total_bytes DESC'),
    get: db.prepare('SELECT * FROM profiles WHERE id = ?'),
    origins: db.prepare('SELECT * FROM origins WHERE profile_id = ? ORDER BY (idb_bytes + cookie_bytes + ls_bytes) DESC'),
    extensions: db.prepare('SELECT * FROM extensions WHERE profile_id = ? ORDER BY bytes DESC'),
    log: db.prepare('INSERT INTO actions (ts, kind, profile_id, profile_name, detail, bytes, status) VALUES (?,?,?,?,?,?,?)'),
    actions: db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?'),
    delProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),
    metaGet: db.prepare('SELECT v FROM meta WHERE k = ?'),
    metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    roots: db.prepare('SELECT DISTINCT root FROM profiles')
  };

  return {
    db,
    saveProfile(rec) {
      db.exec('BEGIN');
      try {
        q.upsertProfile.run(
          rec.id, rec.root, rec.path, rec.name,
          rec.total, rec.cache, rec.site, rec.ext, rec.hist, rec.other,
          rec.files, rec.origins.length, rec.extensions.length,
          rec.locked ? 1 : 0, rec.staleLock ? 1 : 0, rec.synced ? 1 : 0,
          rec.error ?? null, Math.round(rec.mtime || 0), Date.now()
        );
        q.delOrigins.run(rec.id);
        for (const o of rec.origins) {
          q.insOrigin.run(rec.id, o.origin, o.host, o.idb, o.cookieBytes, o.cookieCount, o.ls, o.lsKeys);
        }
        q.delExtensions.run(rec.id);
        for (const e of rec.extensions) {
          q.insExtension.run(rec.id, e.id, e.name, e.version, e.enabled ? 1 : 0, e.bytes, e.path, e.unpacked ? 1 : 0);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    listProfiles: () => q.list.all(),
    getProfile: (id) => q.get.get(id),
    getOrigins: (id) => q.origins.all(id),
    getExtensions: (id) => q.extensions.all(id),
    logAction(a) {
      q.log.run(Date.now(), a.kind, a.profileId ?? null, a.profileName ?? null, a.detail ?? '', a.bytes ?? 0, a.status ?? 'ok');
    },
    listActions: (limit = 200) => q.actions.all(limit),
    deleteProfile(id) {
      db.exec('BEGIN');
      try {
        q.delOrigins.run(id);
        q.delExtensions.run(id);
        q.delProfile.run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    roots: () => q.roots.all().map((r) => r.root),
    getMeta(k, fallback = null) {
      const row = q.metaGet.get(k);
      return row ? row.v : fallback;
    },
    setMeta(k, v) {
      q.metaSet.run(k, String(v));
    },
    close: () => db.close()
  };
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { internals, hostOf, decodeOrigin, resolveExtensionName } from './chrome.js';

const { treeSize, exists, readJson } = internals;

export const CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Media Cache',
  'Application Cache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache',
  'optimization_guide_model_store', 'component_crx_cache'
];

const COOKIE_DB = ['Network/Cookies', 'Cookies'];

function assertInside(root, target) {
  const base = path.resolve(root) + path.sep;
  const p = path.resolve(target);
  if (!p.startsWith(base)) throw new Error(`path di luar root: ${target}`);
  return p;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function newTrash(root, kind) {
  const dir = path.join(root, '_trash', `${stamp()}__${kind}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeManifest(dir, data) {
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(data, null, 2));
}

async function moveInto(root, trashDir, src, label) {
  const dest = path.join(trashDir, label);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(src, dest).catch(async (err) => {
    if (err.code !== 'EXDEV') throw err;
    await fsp.cp(src, dest, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  });
  return dest;
}

export async function planCache(profile) {
  const items = [];
  for (const rel of CACHE_DIRS) {
    const abs = path.join(profile.path, rel);
    if (!exists(abs)) continue;
    items.push({ rel, path: abs, bytes: await treeSize(abs) });
  }
  return items;
}

export async function cleanCache(store, profile, { dryRun } = {}) {
  if (profile.locked) throw new Error('profil sedang dipakai Chrome');
  const items = await planCache(profile);
  const bytes = items.reduce((n, i) => n + i.bytes, 0);
  if (dryRun) return { bytes, items: items.map(({ rel, bytes: b }) => ({ rel, bytes: b })) };

  const errors = [];
  let freed = 0;
  for (const item of items) {
    try {
      await fsp.rm(assertInside(profile.root, item.path), { recursive: true, force: true });
      freed += item.bytes;
    } catch (err) {
      errors.push({ rel: item.rel, error: err.message });
    }
  }
  store.logAction({
    kind: 'clean-cache', profileId: profile.id, profileName: profile.name,
    detail: `${items.length} folder cache`, bytes: freed, status: errors.length ? 'partial' : 'ok'
  });
  return { bytes: freed, errors, items: items.length };
}

function cookieVariants(origin) {
  const host = hostOf(origin);
  return [...new Set([host, `.${host}`])];
}

async function indexedDbTargets(profilePath, origins) {
  const base = path.join(profilePath, 'IndexedDB');
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  const wanted = new Set(origins);
  const stems = new Set();
  for (const e of entries) {
    const decoded = decodeOrigin(e.name);
    if (!decoded || !wanted.has(decoded.origin)) continue;
    stems.add(e.name.replace(/\.indexeddb\.(leveldb|blob)$/, ''));
  }
  const targets = [];
  for (const e of entries) {
    for (const stem of stems) {
      if (!e.name.startsWith(stem)) continue;
      targets.push({ name: e.name, path: path.join(base, e.name), bytes: await treeSize(path.join(base, e.name)) });
    }
  }
  return targets;
}

const lvl = { mod: null };
async function levelCtor() {
  if (lvl.mod !== null) return lvl.mod;
  try {
    const m = await import('classic-level');
    lvl.mod = m.ClassicLevel;
  } catch {
    lvl.mod = false;
  }
  return lvl.mod;
}

async function localStorageKeys(profilePath, origins) {
  const dir = path.join(profilePath, 'Local Storage', 'leveldb');
  if (!exists(dir)) return { keys: [], bytes: 0, available: true };
  const Ctor = await levelCtor();
  if (!Ctor) return { keys: [], bytes: 0, available: false };
  const prefixes = origins.map((o) => Buffer.from(`_${o}\u0000`));
  let db;
  const keys = [];
  let bytes = 0;
  try {
    db = new Ctor(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', readOnly: true });
    await db.open();
    for await (const [key, value] of db.iterator()) {
      if (!key.length || key[0] !== 0x5f) continue;
      if (!prefixes.some((pre) => key.subarray(0, pre.length).equals(pre))) continue;
      keys.push(Buffer.from(key));
      bytes += value.length;
    }
    return { keys, bytes, available: true };
  } catch {
    return { keys: [], bytes: 0, available: false, error: 'leveldb tidak bisa dibuka' };
  } finally {
    try { await db?.close(); } catch { /* sudah tertutup */ }
  }
}

export async function deleteSiteData(store, profile, origins, { dryRun } = {}) {
  if (profile.locked) throw new Error('profil sedang dipakai Chrome');
  if (!origins?.length) throw new Error('tidak ada origin yang dipilih');
  const root = profile.root;

  const cookieDbPath = COOKIE_DB.map((r) => path.join(profile.path, r)).find(exists) ?? null;
  let cookieCount = 0;
  let cookieBytes = 0;
  if (cookieDbPath) {
    try {
      const db = new DatabaseSync(cookieDbPath, { readOnly: true });
      const stmt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(encrypted_value)),0) AS b FROM cookies WHERE host_key = ? OR host_key = ?');
      for (const origin of origins) {
        const [h, dotH] = cookieVariants(origin);
        const row = stmt.get(h, dotH);
        cookieCount += Number(row?.n || 0);
        cookieBytes += Number(row?.b || 0);
      }
      db.close();
    } catch { /* DB tidak terbaca */ }
  }

  const idbTargets = await indexedDbTargets(profile.path, origins);
  const ls = await localStorageKeys(profile.path, origins);
  const idbBytes = idbTargets.reduce((n, t) => n + t.bytes, 0);

  const summary = {
    cookieCount, cookieBytes, cookieDbPath,
    idbDirs: idbTargets.map((t) => ({ name: t.name, bytes: t.bytes })),
    lsKeys: ls.keys.length, lsBytes: ls.bytes, lsAvailable: ls.available,
    bytes: cookieBytes + idbBytes + ls.bytes
  };
  if (dryRun) return summary;

  const trash = await newTrash(root, 'site-data');
  const details = { origins, cookieCount, cookieBytes, idbDirs: summary.idbDirs, lsKeys: summary.lsKeys, lsBytes: summary.lsBytes };

  if (cookieDbPath) {
    const backup = path.join(trash, `cookies-${path.basename(profile.path)}.db`);
    await fsp.copyFile(cookieDbPath, backup).catch(() => {});
    const db = new DatabaseSync(cookieDbPath);
    try {
      db.exec('BEGIN');
      const del = db.prepare('DELETE FROM cookies WHERE host_key = ? OR host_key = ?');
      for (const origin of origins) {
        const [h, dotH] = cookieVariants(origin);
        del.run(h, dotH);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* tidak ada transaksi */ }
      throw err;
    } finally {
      db.close();
    }
  }

  for (const t of idbTargets) {
    await moveInto(root, trash, assertInside(root, t.path), `indexeddb/${t.name}`);
  }

  if (ls.keys.length) {
    const dir = path.join(profile.path, 'Local Storage', 'leveldb');
    const Ctor = await levelCtor();
    if (Ctor) {
      const db = new Ctor(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
      await db.open();
      const ops = ls.keys.map((key) => ({ type: 'del', key }));
      for (let i = 0; i < ops.length; i += 500) await db.batch(ops.slice(i, i + 500));
      await db.close();
    }
  }

  await writeManifest(trash, { kind: 'site-data', at: new Date().toISOString(), profile: profile.path, ...details });
  store.logAction({
    kind: 'site-data', profileId: profile.id, profileName: profile.name,
    detail: `${origins.length} origin, ${cookieCount} cookie, ${summary.idbDirs.length} IndexedDB, ${ls.keys.length} key localStorage`,
    bytes: summary.bytes
  });
  return { ...summary, trash };
}

export async function planExtension(profile, extId, op) {
  const prefsPath = path.join(profile.path, 'Preferences');
  const prefs = readJson(prefsPath);
  const entry = prefs?.extensions?.settings?.[extId];
  if (!entry) throw new Error('extension tidak ditemukan di Preferences');
  return { prefsPath, prefs, entry, extDir: path.join(profile.path, 'Extensions', extId) };
}

export async function changeExtension(store, profile, extId, op, { dryRun } = {}) {
  if (profile.locked) throw new Error('profil sedang dipakai Chrome');
  const { prefsPath, prefs, entry, extDir } = await planExtension(profile, extId, op);
  const name = resolveExtensionName(entry.manifest ?? {}, extDir, extId);
  if (dryRun) return { name, enabled: entry.state === 1, op };

  const trash = await newTrash(profile.root, `ext-${op}`);
  await fsp.copyFile(prefsPath, path.join(trash, 'Preferences.bak'));

  if (op === 'enable') {
    entry.state = 1;
    delete entry.disable_reasons;
  } else if (op === 'disable') {
    entry.state = 0;
    entry.disable_reasons = [1];
  } else if (op === 'uninstall') {
    delete prefs.extensions.settings[extId];
  } else {
    throw new Error(`operasi tidak dikenal: ${op}`);
  }

  const tmp = `${prefsPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(prefs));
  await fsp.rename(tmp, prefsPath);

  if (op === 'uninstall') {
    for (const dir of [extDir, path.join(profile.path, 'Local Extension Settings', extId)]) {
      if (exists(dir)) await moveInto(profile.root, trash, assertInside(profile.root, dir), path.relative(profile.path, dir));
    }
  }
  await writeManifest(trash, { kind: `extension-${op}`, at: new Date().toISOString(), profile: profile.path, extId, name });
  store.logAction({
    kind: `extension-${op}`, profileId: profile.id, profileName: profile.name,
    detail: `${name} (${extId})`
  });
  return { name, op, trash };
}

function findSevenZip() {
  const candidates = [
    process.env.SEVENZIP,
    '7z', '7za', '7zz',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes(path.sep)) { if (exists(c)) return c; continue; }
    const found = (process.env.PATH ?? '').split(path.delimiter)
      .map((d) => path.join(d, process.platform === 'win32' ? `${c}.exe` : c))
      .find(exists);
    if (found) return found;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`${path.basename(cmd)} keluar dengan kode ${code}: ${stderr.slice(-400)}`));
    });
  });
}

const ARCHIVE_EXCLUDES = [
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Media Cache', 'Application Cache',
  'CacheStorage', 'ScriptCache', 'Crashpad', 'component_crx_cache',
  'optimization_guide_model_store'
];

export async function archiveProfile(store, profile, { password, includeCache } = {}) {
  if (profile.locked) throw new Error('profil sedang dipakai Chrome');
  const archiveDir = path.join(profile.root, '_archives');
  await fsp.mkdir(archiveDir, { recursive: true });
  const safeName = `${profile.name.replace(/[^\w.-]+/g, '_')}-${stamp()}`;
  const sevenZip = findSevenZip();

  if (password && !sevenZip) {
    throw new Error('arsip terenkripsi butuh 7-Zip terpasang (7z). Tanpa itu arsip dibuat tanpa password.');
  }

  if (sevenZip) {
    const out = path.join(archiveDir, `${safeName}.7z`);
    const args = ['a', '-t7z', '-mx=3', '-mmt=4', '-bso0', '-bsp0'];
    if (password) args.push(`-p${password}`, '-mhe=on');
    if (!includeCache) args.push(...ARCHIVE_EXCLUDES.map((e) => `-xr!${e}`));
    args.push(out, profile.path);
    await run(sevenZip, args);
    const size = (await fsp.stat(out)).size;
    store.logAction({
      kind: 'archive', profileId: profile.id, profileName: profile.name,
      detail: `${path.basename(out)}${password ? ' (terenkripsi)' : ''}`, bytes: size
    });
    return { archive: out, size, encrypted: Boolean(password) };
  }

  const out = path.join(archiveDir, `${safeName}.tar.gz`);
  const parent = path.dirname(profile.path);
  const args = ['-czf', out, '-C', parent];
  if (!includeCache) args.push(...ARCHIVE_EXCLUDES.flatMap((e) => ['--exclude', e]));
  args.push(path.basename(profile.path));
  await run('tar', args);
  const size = (await fsp.stat(out)).size;
  store.logAction({
    kind: 'archive', profileId: profile.id, profileName: profile.name,
    detail: path.basename(out), bytes: size
  });
  return { archive: out, size, encrypted: false };
}

export async function listTrash(root) {
  const base = path.join(root, '_trash');
  const out = [];
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const manifest = readJson(path.join(dir, 'manifest.json')) ?? { kind: e.name.split('__')[1] ?? 'unknown' };
    const bytes = await treeSize(dir);
    out.push({ name: e.name, path: dir, kind: manifest.kind, at: manifest.at ?? null, bytes, profile: manifest.profile ?? null });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function purgeTrash(root, days = 14) {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const base = path.join(root, '_trash');
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || st.mtimeMs > cutoff) continue;
    await fsp.rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, days };
}

export const actionInternals = { assertInside, moveInto, newTrash };

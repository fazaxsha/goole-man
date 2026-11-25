import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const CACHE_KEYS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Media Cache',
  'Application Cache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache',
  'optimization_guide_model_store', 'component_crx_cache', 'Crashpad', 'Safe Browsing',
  'GraphiteDawnCache', 'segmentation_platform', 'optimization_guide_hint_cache_store'
]);

const SITE_KEYS = new Set([
  'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'File System',
  'Network', 'Cookies', 'Cookies-journal', 'blob_storage', 'Service Worker',
  'Local Storage-journal', 'Session Storage-journal'
]);

const EXT_KEYS = new Set([
  'Extensions', 'Local Extension Settings', 'Extension State', 'Extension Rules',
  'Extension Scripts', 'Sync Extension Settings', 'Managed Extension Settings',
  'Extension Activity'
]);

const HIST_KEYS = new Set([
  'History', 'History-journal', 'History Provider Cache', 'Favicons',
  'Top Sites', 'Visited Links', 'Shortcuts', 'Network Action Predictor'
]);

const NON_PROFILE_DIRS = new Set([
  'Crashpad', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'BrowserMetrics',
  'component_crx_cache', 'Safe Browsing', 'MEIPreload', 'OptimizationHints',
  'segmentation_platform', 'WidevineCdm', 'hyphen-data', 'SSLErrorAssistant',
  'PKIMetadata', 'ZxcvbnData', 'Subresource Filter', 'FileTypePolicies',
  'TrustTokenKeyCommitments', 'OriginTrials', 'WasmTtsEngine', 'Screen AI',
  'SmartCardManager', 'CertificateRevocation', 'Crowd Deny', 'ActorSafetyLists',
  'OnDeviceHeadSuggestModel', 'FirstPartySetsPreloaded', 'AmountExtractionHeuristicRegexes',
  'CaptchaProviders', 'OptimizationHints', 'DesktopSharingHub', '_user_data'
]);

const exists = (p) => {
  try { fs.accessSync(p); return true; } catch { return false; }
};

export function profileId(profilePath) {
  return crypto.createHash('sha1').update(path.resolve(profilePath).toLowerCase()).digest('hex').slice(0, 16);
}

function normPath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

function looksLikeProfile(dir) {
  return exists(path.join(dir, 'Preferences')) ||
    exists(path.join(dir, 'Network', 'Cookies')) ||
    exists(path.join(dir, 'Cookies')) ||
    exists(path.join(dir, 'History'));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function runningProfiles() {
  const out = new Set();
  try {
    const raw = process.platform === 'win32'
      ? await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine"],
        { maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
      })
      : await new Promise((resolve, reject) => {
        execFile('ps', ['-eo', 'args='], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
    for (const line of raw.split(/\r?\n/)) {
      if (!/chrome|chromium/i.test(line)) continue;
      const udd = /--user-data-dir(?:=|\s+)"?([^"\s]+)"?/i.exec(line);
      if (!udd) continue;
      const prof = /--profile-directory(?:=|\s+)"?([^"\s]+)"?/i.exec(line);
      const base = udd[1].replace(/^"|"$/g, '');
      out.add(normPath(base));
      if (prof) out.add(normPath(path.join(base, prof[1].replace(/^"|"$/g, ''))));
    }
  } catch {
    // ps/powershell tidak tersedia: jatuh ke pengecekan SingletonLock saja
  }
  return out;
}

export function lockState(profilePath, running = new Set()) {
  if (running.has(normPath(profilePath))) return { locked: true, stale: false };
  const lock = path.join(profilePath, 'SingletonLock');
  let st;
  try { st = fs.lstatSync(lock); } catch { return { locked: false, stale: false }; }
  let target = null;
  try { target = fs.readlinkSync(lock); } catch { /* file biasa (Windows) */ }
  if (target) {
    const m = /^(.+)-(\d+)$/.exec(target);
    if (m) {
      const [, host, pid] = m;
      if (host === os.hostname()) {
        try {
          process.kill(Number(pid), 0);
          return { locked: true, stale: false };
        } catch {
          return { locked: false, stale: true };
        }
      }
      return { locked: false, stale: true };
    }
    return { locked: false, stale: true };
  }
  return { locked: st.isFile(), stale: st.isFile() };
}

export async function detectProfiles(root) {
  const names = new Map();
  const localState = readJson(path.join(root, 'Local State'));
  const infoCache = localState?.profile?.info_cache ?? {};
  for (const [dir, info] of Object.entries(infoCache)) {
    if (info?.name) names.set(dir, info.name);
  }

  const profiles = [];
  if (looksLikeProfile(root)) {
    const prefs = readJson(path.join(root, 'Preferences'));
    profiles.push({
      path: root,
      name: names.get(path.basename(root)) || prefs?.profile?.name || path.basename(root)
    });
    return profiles;
  }

  const entries = await listDir(root);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    if (NON_PROFILE_DIRS.has(e.name)) continue;
    const dir = path.join(root, e.name);
    if (!looksLikeProfile(dir)) continue;
    const prefs = readJson(path.join(dir, 'Preferences'));
    profiles.push({
      path: dir,
      name: names.get(e.name) || prefs?.profile?.name || e.name
    });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name, 'id', { numeric: true }));
}

export async function walkSizes(profilePath) {
  const sums = new Map();
  const stack = [''];
  let mtime = 0;
  let files = 0;
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(profilePath, rel) : profilePath;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(childRel); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = await fsp.stat(path.join(profilePath, childRel)); } catch { continue; }
      files += 1;
      if (st.mtimeMs > mtime) mtime = st.mtimeMs;
      const parts = childRel.split('/');
      const key = parts[0] === 'Service Worker' && parts[1] ? `Service Worker/${parts[1]}` : parts[0];
      sums.set(key, (sums.get(key) || 0) + st.size);
    }
  }
  return { sums, mtime, files };
}

export function classify(sums) {
  let cache = 0; let site = 0; let ext = 0; let hist = 0; let total = 0;
  for (const [key, bytes] of sums) {
    total += bytes;
    if (CACHE_KEYS.has(key)) cache += bytes;
    else if (SITE_KEYS.has(key)) site += bytes;
    else if (EXT_KEYS.has(key)) ext += bytes;
    else if (HIST_KEYS.has(key)) hist += bytes;
  }
  const other = Math.max(0, total - cache - site - ext - hist);
  return { cache, site, ext, hist, other, total };
}

export function decodeOrigin(dirName) {
  const stripped = dirName.replace(/\.indexeddb\.(leveldb|blob)$/, '');
  const portAt = stripped.lastIndexOf('_');
  if (portAt < 0) return null;
  const port = stripped.slice(portAt + 1);
  const rest = stripped.slice(0, portAt);
  const schemeAt = rest.indexOf('_');
  if (schemeAt < 0) return null;
  const scheme = rest.slice(0, schemeAt);
  const host = rest.slice(schemeAt + 1);
  if (!scheme || !host) return null;
  const portPart = port === '0' || port === '' ? '' : `:${port}`;
  return { origin: `${scheme}://${host}${portPart}`, host, scheme };
}

export function hostOf(origin) {
  return origin.replace(/^[a-z-]+:\/\//i, '').replace(/^\./, '').replace(/:\d+$/, '');
}

export async function readIndexedDbIndex(profilePath) {
  const base = path.join(profilePath, 'IndexedDB');
  const entries = await listDir(base);
  const byOrigin = new Map();
  const seen = new Set();
  for (const e of entries) {
    const decoded = decodeOrigin(e.name);
    if (!decoded) continue;
    const stem = e.name.replace(/\.indexeddb\.(leveldb|blob)$/, '');
    if (seen.has(stem)) continue;
    let bytes = 0;
    for (const sib of entries) {
      if (!sib.name.startsWith(stem)) continue;
      bytes += await treeSize(path.join(base, sib.name));
    }
    seen.add(stem);
    const prev = byOrigin.get(decoded.origin) ?? { origin: decoded.origin, host: decoded.host, idb: 0 };
    prev.idb += bytes;
    byOrigin.set(decoded.origin, prev);
  }
  return byOrigin;
}

async function treeSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { total += (await fsp.stat(p)).size; } catch { /* dilewati */ }
      }
    }
  }
  return total;
}

export function readCookies(profilePath) {
  const candidates = [
    path.join(profilePath, 'Network', 'Cookies'),
    path.join(profilePath, 'Cookies')
  ];
  const dbPath = candidates.find(exists);
  if (!dbPath) return { rows: [], dbPath: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT host_key AS host, COUNT(*) AS n,
             COALESCE(SUM(LENGTH(encrypted_value)), 0) AS bytes
      FROM cookies GROUP BY host_key`).all();
    return { rows, dbPath };
  } catch {
    return { rows: [], dbPath };
  } finally {
    try { db?.close(); } catch { /* sudah tertutup */ }
  }
}

let LevelCtor = null;
async function levelCtor() {
  if (LevelCtor !== null) return LevelCtor;
  try {
    const mod = await import('classic-level');
    LevelCtor = mod.ClassicLevel;
  } catch {
    LevelCtor = false;
  }
  return LevelCtor;
}

export async function readLocalStorage(profilePath) {
  const dir = path.join(profilePath, 'Local Storage', 'leveldb');
  if (!exists(dir)) return null;
  const Ctor = await levelCtor();
  if (!Ctor) return null;
  let db;
  try {
    db = new Ctor(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', readOnly: true });
    await db.open();
    const byOrigin = new Map();
    for await (const [key, value] of db.iterator()) {
      if (!key.length || key[0] !== 0x5f) continue;
      const nul = key.indexOf(0);
      if (nul < 3) continue;
      const origin = key.subarray(1, nul).toString('utf8');
      if (!/^[a-z-]+:\/\//i.test(origin)) continue;
      const prev = byOrigin.get(origin) ?? { origin, host: hostOf(origin), ls: 0, lsKeys: 0 };
      prev.ls += value.length;
      prev.lsKeys += 1;
      byOrigin.set(origin, prev);
    }
    return byOrigin;
  } catch {
    return null;
  } finally {
    try { await db?.close(); } catch { /* sudah tertutup */ }
  }
}

export function resolveExtensionName(manifest, extDir, id) {
  let name = manifest?.name ?? id;
  const msg = /^__MSG_(.+)__$/i.exec(name);
  if (!msg) return name;
  const locale = manifest?.default_locale ?? 'en';
  const messages = readJson(path.join(extDir, '_locales', locale, 'messages.json')) ??
    readJson(path.join(extDir, '_locales', 'en', 'messages.json'));
  const key = msg[1];
  return messages?.[key]?.message ?? messages?.[key.toLowerCase()]?.message ?? id;
}

export async function readExtensions(profilePath) {
  const prefs = readJson(path.join(profilePath, 'Preferences'));
  const settings = prefs?.extensions?.settings ?? {};
  const out = [];
  for (const [id, s] of Object.entries(settings)) {
    if (!s || typeof s !== 'object') continue;
    if (s.location === 5) continue;
    if (!s.manifest && !s.path) continue;
    const extDir = s.path && exists(s.path) ? s.path : path.join(profilePath, 'Extensions', id);
    const bytes = exists(extDir) ? await treeSize(extDir) : 0;
    const disabled = Array.isArray(s.disable_reasons) && s.disable_reasons.length > 0;
    out.push({
      id,
      name: resolveExtensionName(s.manifest, extDir, id),
      version: s.manifest?.version ?? '',
      enabled: s.state === 1 && !disabled,
      bytes,
      path: extDir,
      unpacked: s.location === 4 || s.from_webstore === false
    });
  }
  return { extensions: out, prefs };
}

export async function inspectProfile({ profilePath, name, root, running }) {
  const base = {
    id: profileId(profilePath),
    root,
    path: profilePath,
    name,
    total: 0, cache: 0, site: 0, ext: 0, hist: 0, other: 0,
    files: 0, mtime: 0, synced: false,
    origins: [], extensions: [], error: null
  };
  try {
    const walk = await walkSizes(profilePath);
    const sizes = classify(walk.sums);
    const [idb, ls, extInfo] = await Promise.all([
      readIndexedDbIndex(profilePath),
      readLocalStorage(profilePath),
      readExtensions(profilePath)
    ]);
    const cookies = readCookies(profilePath);
    const merged = new Map();
    const ensure = (origin, host) => {
      const key = `${origin}`;
      if (!merged.has(key)) merged.set(key, { origin, host, idb: 0, cookieBytes: 0, cookieCount: 0, ls: 0, lsKeys: 0 });
      return merged.get(key);
    };
    const byHost = new Map();
    for (const o of idb.values()) {
      const rec = ensure(o.origin, o.host);
      rec.idb = o.idb;
      byHost.set(o.host, rec.origin);
    }
    if (ls) {
      for (const o of ls.values()) {
        const existing = byHost.get(o.host);
        const rec = ensure(existing ?? o.origin, o.host);
        rec.ls += o.ls;
        rec.lsKeys += o.lsKeys;
        if (!byHost.has(o.host)) byHost.set(o.host, o.origin);
      }
    }
    for (const row of cookies.rows) {
      const host = String(row.host || '').replace(/^\./, '');
      if (!host) continue;
      const origin = byHost.get(host) ?? `https://${host}`;
      const rec = ensure(origin, host);
      rec.cookieBytes += Number(row.bytes || 0);
      rec.cookieCount += Number(row.n || 0);
      if (!byHost.has(host)) byHost.set(host, origin);
    }
    const lock = lockState(profilePath, running);
    const prefs = extInfo.prefs;
    return {
      ...base,
      ...sizes,
      files: walk.files,
      mtime: walk.mtime,
      synced: Array.isArray(prefs?.account_info) && prefs.account_info.length > 0,
      locked: lock.locked,
      staleLock: lock.stale,
      cookieDb: cookies.dbPath,
      origins: [...merged.values()],
      extensions: extInfo.extensions
    };
  } catch (err) {
    return { ...base, error: err?.message ?? String(err), ...lockState(profilePath, running) };
  }
}

export const internals = { treeSize, exists, readJson, normPath, CACHE_KEYS };

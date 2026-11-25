import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { scanRoot } from './scan.js';
import {
  cleanCache, deleteSiteData, changeExtension, archiveProfile,
  listTrash, purgeTrash, planCache, planExtension
} from './actions.js';
import { detectProfiles, inspectProfile, runningProfiles } from './chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const PORT = Number(argValue('port') ?? process.env.PORT ?? 3000);
const HOST = argValue('host') ?? '127.0.0.1';

const store = openStore(DATA_DIR);
if (!store.getMeta('root') && process.env.CHROME_ROOT) store.setMeta('root', process.env.CHROME_ROOT);
if (!store.getMeta('root') && argValue('root')) store.setMeta('root', argValue('root'));

const jobs = new Map();
const busy = new Set();

function newJob(kind, total = 0) {
  const job = { id: crypto.randomUUID(), kind, state: 'running', total, done: 0, current: null, startedAt: Date.now(), result: null, error: null };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (Date.now() - j.startedAt > 3600_000) jobs.delete(id);
  return job;
}

function serializeProfile(row, { withTotals = false } = {}) {
  const out = {
    id: row.id, name: row.name, path: row.path, root: row.root,
    total: row.total_bytes, cache: row.cache_bytes, site: row.site_bytes,
    ext: row.ext_bytes, hist: row.hist_bytes, other: row.other_bytes,
    files: row.file_count, origins: row.origin_count, extensions: row.ext_count,
    locked: Boolean(row.locked), staleLock: Boolean(row.stale_lock), synced: Boolean(row.synced),
    error: row.error, mtime: row.mtime, scannedAt: row.scanned_at
  };
  if (withTotals) out.total = row.total_bytes;
  return out;
}

function getRow(id) {
  const row = store.getProfile(id);
  if (!row) {
    const err = new Error('profil tidak ditemukan');
    err.status = 404;
    throw err;
  }
  return row;
}

async function rescanRows(rows, onProgress) {
  const running = await runningProfiles();
  const queue = rows.slice();
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift();
      try {
        const rec = await inspectProfile({ profilePath: row.path, name: row.name, root: row.root, running });
        store.saveProfile(rec);
      } catch { /* biarkan angka lama */ }
      onProgress?.(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
}

function startRescanJob(rows) {
  const job = newJob('rescan', rows.length);
  rescanRows(rows, (row) => { job.done += 1; job.current = row.name; })
    .then(() => { job.state = 'done'; job.finishedAt = Date.now(); })
    .catch((err) => { job.state = 'error'; job.error = err.message; job.finishedAt = Date.now(); });
  return job;
}

function withLock(key, fn) {
  if (busy.has(key)) {
    const err = new Error('aksi lain sedang berjalan untuk profil ini');
    err.status = 409;
    throw err;
  }
  busy.add(key);
  return Promise.resolve().then(fn).finally(() => busy.delete(key));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error('body terlalu besar'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function withServerMark(html) {
  const text = Buffer.isBuffer(html) ? html.toString('utf8') : html;
  if (text.includes('name="dock-server"')) return text;
  return text.replace('</head>', '<meta name="dock-server" content="1" />\n</head>');
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    if (path.extname(target) === '.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(withServerMark(data));
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  } catch {
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(withServerMark(html));
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

const routes = [
  ['GET', /^\/api\/config$/, async () => {
    const root = store.getMeta('root', '');
    return {
      root,
      dataDir: DATA_DIR,
      platform: process.platform,
      node: process.version,
      has7z: Boolean(process.env.SEVENZIP) || fs.existsSync('C:\\Program Files\\7-Zip\\7z.exe') || fs.existsSync('/usr/bin/7z'),
      lastScan: store.getMeta('lastScan', null)
    };
  }],
  ['POST', /^\/api\/config$/, async (req) => {
    const body = await readBody(req);
    const root = path.resolve(String(body.root ?? ''));
    const st = await fsp.stat(root).catch(() => null);
    if (!st?.isDirectory()) throw Object.assign(new Error('folder tidak ditemukan'), { status: 400 });
    const profiles = await detectProfiles(root);
    if (!profiles.length) throw Object.assign(new Error('tidak ada profil Chrome di folder itu'), { status: 400 });
    store.setMeta('root', root);
    return { root, found: profiles.length };
  }],
  ['GET', /^\/api\/profiles$/, async () => {
    const rows = store.listProfiles();
    const profiles = rows.map((r) => serializeProfile(r));
    const sum = (k) => profiles.reduce((n, p) => n + p[k], 0);
    return {
      root: store.getMeta('root', ''),
      profiles,
      stats: {
        count: profiles.length,
        total: sum('total'),
        cache: sum('cache'),
        site: sum('site'),
        ext: sum('ext'),
        locked: profiles.filter((p) => p.locked).length
      },
      lastScan: store.getMeta('lastScan', null)
    };
  }],
  ['GET', /^\/api\/profiles\/([a-f0-9]{16})$/, async (req, res, m) => {
    const row = getRow(m[1]);
    return {
      profile: serializeProfile(row),
      origins: store.getOrigins(row.id).map((o) => ({
        origin: o.origin, host: o.host, idb: o.idb_bytes, cookieBytes: o.cookie_bytes,
        cookieCount: o.cookie_count, ls: o.ls_bytes, lsKeys: o.ls_keys,
        total: o.idb_bytes + o.cookie_bytes + o.ls_bytes
      })),
      extensions: store.getExtensions(row.id).map((e) => ({
        id: e.ext_id, name: e.name, version: e.version, enabled: Boolean(e.enabled),
        bytes: e.bytes, path: e.ext_path, unpacked: Boolean(e.unpacked)
      }))
    };
  }],
  ['POST', /^\/api\/scan$/, async (req) => {
    const root = store.getMeta('root', '');
    if (!root) throw Object.assign(new Error('root belum diset'), { status: 400 });
    const running = [...jobs.values()].find((j) => j.kind === 'scan' && j.state === 'running');
    if (running) return { job: running };
    const job = newJob('scan');
    job.root = root;
    job.state = 'running';
    scanRoot({
      store, root,
      onProgress: (p) => { job.done = p.done; job.total = p.total; job.current = p.current; job.errors = p.errors; }
    }).then(async (result) => {
      job.state = 'done';
      job.result = result;
      job.finishedAt = Date.now();
      store.setMeta('lastScan', JSON.stringify({ at: Date.now(), found: result.found, errors: result.errors.length }));
      const rows = store.listProfiles();
      for (const r of rows) if (!fs.existsSync(r.path)) store.deleteProfile(r.id);
    }).catch((err) => {
      job.state = 'error';
      job.error = err.message;
      job.finishedAt = Date.now();
    });
    return { job };
  }],
  ['GET', /^\/api\/jobs\/([0-9a-f-]{36})$/, async (req, res, m) => {
    const job = jobs.get(m[1]);
    if (!job) throw Object.assign(new Error('job tidak ditemukan'), { status: 404 });
    return { job };
  }],
  ['POST', /^\/api\/actions\/clean-cache$/, async (req) => {
    const body = await readBody(req);
    const rows = (body.ids ?? []).map(getRow);
    const results = [];
    let total = 0;
    for (const row of rows) {
      const profile = { id: row.id, name: row.name, path: row.path, root: row.root, locked: Boolean(row.locked) };
      const key = `cache:${row.id}`;
      if (busy.has(key)) continue;
      if (body.dryRun) {
        const plan = await planCache(profile);
        const bytes = plan.reduce((n, i) => n + i.bytes, 0);
        total += bytes;
        results.push({ id: row.id, name: row.name, locked: profile.locked, bytes, items: plan.length });
      } else {
        const res = await withLock(key, () => cleanCache(store, profile, {}));
        total += res.bytes;
        results.push({ id: row.id, name: row.name, locked: false, bytes: res.bytes, errors: res.errors });
      }
    }
    let job = null;
    if (!body.dryRun && rows.length) job = startRescanJob(rows);
    return { dryRun: Boolean(body.dryRun), bytes: total, results, job };
  }],
  ['POST', /^\/api\/actions\/site-data$/, async (req) => {
    const body = await readBody(req);
    const row = getRow(body.id);
    const profile = { id: row.id, name: row.name, path: row.path, root: row.root, locked: Boolean(row.locked) };
    const origins = Array.isArray(body.origins) ? body.origins.slice(0, 500) : [];
    if (!origins.length) throw Object.assign(new Error('pilih minimal satu origin'), { status: 400 });
    const key = `site:${row.id}`;
    if (busy.has(key)) throw Object.assign(new Error('aksi lain sedang berjalan'), { status: 409 });
    const result = await withLock(key, () => deleteSiteData(store, profile, origins, { dryRun: Boolean(body.dryRun) }));
    let profileAfter = null;
    if (!body.dryRun) {
      await rescanRows([row]);
      profileAfter = serializeProfile(getRow(row.id));
    }
    return { dryRun: Boolean(body.dryRun), ...result, profile: profileAfter };
  }],
  ['POST', /^\/api\/actions\/extension$/, async (req) => {
    const body = await readBody(req);
    const row = getRow(body.id);
    const profile = { id: row.id, name: row.name, path: row.path, root: row.root, locked: Boolean(row.locked) };
    const op = String(body.op ?? '');
    if (!['enable', 'disable', 'uninstall'].includes(op)) throw Object.assign(new Error('operasi tidak valid'), { status: 400 });
    const key = `ext:${row.id}`;
    if (body.dryRun) {
      const plan = await planExtension(profile, body.extId, op);
      return { dryRun: true, name: plan.entry.manifest?.name ?? body.extId, op };
    }
    const result = await withLock(key, () => changeExtension(store, profile, body.extId, op, {}));
    await rescanRows([row]);
    return { dryRun: false, ...result, profile: serializeProfile(getRow(row.id)) };
  }],
  ['POST', /^\/api\/actions\/archive$/, async (req) => {
    const body = await readBody(req);
    const rows = (body.ids ?? []).map(getRow);
    if (!rows.length) throw Object.assign(new Error('tidak ada profil dipilih'), { status: 400 });
    const job = newJob('archive', rows.length);
    (async () => {
      const results = [];
      for (const row of rows) {
        const profile = { id: row.id, name: row.name, path: row.path, root: row.root, locked: Boolean(row.locked) };
        try {
          results.push({ id: row.id, name: row.name, ...(await archiveProfile(store, profile, {
            password: body.password ? String(body.password) : null,
            includeCache: Boolean(body.includeCache)
          })) });
        } catch (err) {
          results.push({ id: row.id, name: row.name, error: err.message });
        }
        job.done += 1;
        job.current = row.name;
      }
      job.result = results;
      job.state = 'done';
      job.finishedAt = Date.now();
    })().catch((err) => {
      job.state = 'error';
      job.error = err.message;
      job.finishedAt = Date.now();
    });
    return { job };
  }],
  ['GET', /^\/api\/actions$/, async (req, res, m, url) => {
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
    return { actions: store.listActions(limit) };
  }],
  ['GET', /^\/api\/trash$/, async () => {
    const root = store.getMeta('root', '');
    if (!root) return { items: [] };
    return { items: await listTrash(root) };
  }],
  ['POST', /^\/api\/trash\/purge$/, async (req) => {
    const body = await readBody(req);
    const root = store.getMeta('root', '');
    if (!root) throw Object.assign(new Error('root belum diset'), { status: 400 });
    const days = Number(body.days ?? 14);
    if (!Number.isFinite(days) || days < 1) throw Object.assign(new Error('hari harus >= 1'), { status: 400 });
    return purgeTrash(root, days);
  }]
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;
      const data = await handler(req, res, match, url);
      sendJson(res, 200, data);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'endpoint tidak ditemukan' });
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[${req.method} ${pathname}]`, err);
    sendJson(res, status, { error: err.message ?? 'kesalahan server' });
  }
});

server.listen(PORT, HOST, () => {
  const root = store.getMeta('root', '');
  console.log(`chrome-profile-dashboard  http://${HOST}:${PORT}`);
  console.log(`data   ${DATA_DIR}`);
  console.log(`root   ${root || '(belum diset — isi di UI)'}`);
});

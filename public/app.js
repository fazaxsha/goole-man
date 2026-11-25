const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const CARD_H = 186;
const GAP = 14;
const MIN_W = 264;
const TOP = 16;

const state = {
  root: '',
  profiles: [],
  stats: null,
  view: [],
  query: '',
  sort: 'size',
  onlyLocked: false,
  selected: new Set(),
  cols: 1,
  lastStart: -1,
  lastEnd: -1,
  detail: null,
  detailSel: new Set(),
  originQuery: '',
  scanning: false,
  config: null
};

const els = {
  rootInput: $('#rootInput'),
  rootForm: $('#rootForm'),
  scanBtn: $('#scanBtn'),
  search: $('#search'),
  sort: $('#sort'),
  onlyLocked: $('#onlyLocked'),
  viewCount: $('#viewCount'),
  selectAll: $('#selectAll'),
  gridWrap: $('#gridWrap'),
  grid: $('#grid'),
  spacer: $('#gridSpacer'),
  empty: $('#empty'),
  statbar: $('#statbar'),
  statCount: $('#statCount'),
  statTotal: $('#statTotal'),
  statCache: $('#statCache'),
  statSite: $('#statSite'),
  statExt: $('#statExt'),
  scanStatus: $('#scanStatus'),
  trashBtn: $('#trashBtn'),
  bulkbar: $('#bulkbar'),
  bulkText: $('#bulkText'),
  bulkCache: $('#bulkCache'),
  bulkArchive: $('#bulkArchive'),
  bulkClear: $('#bulkClear'),
  scrim: $('#scrim'),
  drawer: $('#drawer'),
  drawerTitle: $('#drawerTitle'),
  drawerPath: $('#drawerPath'),
  drawerBody: $('#drawerBody'),
  drawerClose: $('#drawerClose'),
  modal: $('#modal'),
  modalTitle: $('#modalTitle'),
  modalBody: $('#modalBody'),
  modalOk: $('#modalOk'),
  modalCancel: $('#modalCancel'),
  toasts: $('#toasts')
};

const fmtBytes = (n) => {
  const v0 = Number(n) || 0;
  if (v0 <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = v0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace('.', ',')} ${units[i]}`;
};
const fmtNum = (n) => Number(n || 0).toLocaleString('id-ID');

function relTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  if (diff < 0) return 'baru saja';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'baru saja';
  if (min < 60) return `${min} menit lalu`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} hari lalu`;
  const months = Math.floor(days / 30);
  return `${months} bulan lalu`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function toast(message, kind = 'ok', ttl = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), ttl);
}

async function api(pathname, options = {}) {
  const init = { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(pathname, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- dialog ---------- */
function closeModal() {
  els.modal.classList.add('hidden');
  els.modalOk.onclick = null;
  els.modalCancel.onclick = null;
}

function dialog({ title, body, okLabel = 'Lanjutkan', danger = true, collect }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    els.modalTitle.textContent = title;
    els.modalBody.innerHTML = body;
    els.modalOk.textContent = okLabel;
    els.modalOk.className = `btn ${danger ? 'danger' : 'primary'}`;
    els.modalCancel.onclick = () => done(null);
    els.modalOk.onclick = () => {
      let value = true;
      if (collect) {
        try { value = collect(); } catch (err) { toast(err.message, 'err'); return; }
        if (value === false) return;
      }
      done(value);
    };
    els.modal.classList.remove('hidden');
    const first = els.modalBody.querySelector('input, select, button');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

const confirmUI = (title, html, okLabel = 'Lanjutkan') =>
  dialog({ title, body: html, okLabel });

/* ---------- drawer ---------- */
function openDrawerShell(name, path) {
  els.drawerTitle.textContent = name;
  els.drawerPath.textContent = path;
  els.drawerBody.innerHTML = '<p class="skeleton">Memuat data profil…</p>';
  els.drawer.classList.remove('hidden');
  els.scrim.classList.remove('hidden');
  els.drawerClose.focus({ preventScroll: true });
}

function closeDrawer() {
  els.drawer.classList.add('hidden');
  els.scrim.classList.add('hidden');
  state.detail = null;
  state.detailSel.clear();
  state.originQuery = '';
}

async function openDetail(id) {
  const row = state.profiles.find((p) => p.id === id);
  if (!row) return;
  openDrawerShell(row.name, row.path);
  try {
    const data = await api(`/api/profiles/${id}`);
    state.detail = data;
    state.detailSel.clear();
    state.originQuery = '';
    paintDrawer();
  } catch (err) {
    els.drawerBody.innerHTML = `<p class="danger-text">${esc(err.message)}</p>`;
  }
}

const CATS = [
  ['cache', 'Cache (bisa dibuat ulang)', 'cache'],
  ['site', 'Data situs', 'site'],
  ['ext', 'Extension', 'ext'],
  ['hist', 'Riwayat', 'hist'],
  ['other', 'Lainnya', 'other']
];

function barHTML(p) {
  const total = p.total || 1;
  return CATS.map(([key, , cls]) => {
    const v = p[key] || 0;
    return v > 0 ? `<i class="${cls}" style="width:${(v / total * 100).toFixed(3)}%"></i>` : '';
  }).join('');
}

function paintDrawer() {
  const { profile: p, origins, extensions } = state.detail;
  const breakdown = CATS.map(([key, label, cls]) => {
    const v = p[key] || 0;
    if (!v) return '';
    return `<div class="bd-row"><i class="${cls}"></i><span class="name">${label}</span><span class="val">${fmtBytes(v)}</span></div>`;
  }).join('');

  const sync = p.synced ? '<span class="badge sync">sync aktif</span>' : '';
  const lock = p.locked ? '<span class="badge lock">sedang dipakai Chrome</span>' : '';

  els.drawerBody.innerHTML = `
    <div class="summary">
      <span class="big">${fmtBytes(p.total)}</span>
      <span class="muted">${fmtNum(p.files)} file · ${fmtNum(origins.length)} origin · ${fmtNum(extensions.length)} extension</span>
      ${sync}${lock}
    </div>
    <div class="bar">${barHTML(p)}</div>
    <div class="breakdown">${breakdown || '<div class="bd-row muted">Belum ada data</div>'}</div>

    <div class="note">
      Cache bisa dibuat ulang oleh Chrome. Data situs (cookie, IndexedDB, localStorage) membuat sesi login hilang.
      ${p.synced ? 'Profil ini login Chrome Sync: data lokal yang dihapus bisa muncul lagi setelah sinkronisasi.' : ''}
    </div>

    <div class="section">
      <div class="section-head">
        <h3>Data situs per origin</h3>
        <span class="spacer"></span>
        <button class="rowbtn" id="originAll" type="button">Pilih semua</button>
      </div>
      <div class="searchwrap" style="max-width:none;margin-bottom:8px">
        <input id="originSearch" type="search" placeholder="Cari origin…" value="${esc(state.originQuery)}" aria-label="Cari origin" />
      </div>
      <div class="table-wrap scroll">
        <table>
          <thead>
            <tr>
              <th class="pick-col"></th>
              <th>Origin</th>
              <th class="num">IndexedDB</th>
              <th class="num">Cookie</th>
              <th class="num">localStorage</th>
            </tr>
          </thead>
          <tbody id="originBody"></tbody>
        </table>
      </div>
      <div class="toolbar">
        <span class="muted" id="originSelInfo">0 dipilih</span>
        <span class="spacer"></span>
        <button class="btn danger small" id="originDelete" type="button" disabled>Hapus data terpilih</button>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>Extension (${extensions.length})</h3></div>
      <div id="extList"></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>Arsip</h3></div>
      <div class="btn-row">
        <button class="btn small" id="archiveBtn" type="button">Arsipkan profil ini</button>
        <button class="btn ghost small" id="cleanBtn" type="button">Bersihkan cache</button>
      </div>
      <p class="muted small" style="margin-top:8px">Arsip ditulis ke <span class="mono">${esc(p.root)}/_archives</span> tanpa folder cache. Pindahkan ke HDD/NAS setelah selesai.</p>
    </div>
  `;

  renderOriginTable();
  renderExtensions();
  bindDrawer(p);
}

function visibleOrigins() {
  const q = state.originQuery.trim().toLowerCase();
  const list = state.detail?.origins ?? [];
  return q ? list.filter((o) => o.origin.toLowerCase().includes(q)) : list;
}

function renderOriginTable() {
  const body = $('#originBody');
  if (!body) return;
  const list = visibleOrigins();
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="dim" style="padding:14px 10px">Tidak ada origin yang cocok.</td></tr>';
  } else {
    body.innerHTML = list.map((o) => `
      <tr data-origin="${esc(o.origin)}">
        <td class="pick-col">
          <label class="pick"><input type="checkbox" ${state.detailSel.has(o.origin) ? 'checked' : ''} />
          <span class="box"></span></label>
        </td>
        <td class="origin" title="${esc(o.origin)}">${esc(o.origin)}</td>
        <td class="num">${o.idb ? fmtBytes(o.idb) : '<span class="dim">—</span>'}</td>
        <td class="num">${o.cookieCount ? `${fmtNum(o.cookieCount)} <span class="dim">cookie</span>` : '<span class="dim">—</span>'}</td>
        <td class="num">${o.lsKeys ? `${fmtBytes(o.ls)} <span class="dim">${fmtNum(o.lsKeys)}k</span>` : '<span class="dim">—</span>'}</td>
      </tr>`).join('');
  }
  updateOriginToolbar();
}

function originSelectionBytes() {
  const all = state.detail?.origins ?? [];
  return all.filter((o) => state.detailSel.has(o.origin)).reduce((n, o) => n + (o.total || 0), 0);
}

function updateOriginToolbar() {
  const info = $('#originSelInfo');
  const btn = $('#originDelete');
  if (!info || !btn) return;
  const n = state.detailSel.size;
  info.textContent = `${n} dipilih${n ? ` · ${fmtBytes(originSelectionBytes())}` : ''}`;
  btn.disabled = n === 0;
}

function renderExtensions() {
  const wrap = $('#extList');
  if (!wrap) return;
  const list = state.detail?.extensions ?? [];
  if (!list.length) {
    wrap.innerHTML = '<p class="muted small" style="margin:0">Tidak ada extension terpasang.</p>';
    return;
  }
  wrap.innerHTML = list.map((e) => `
    <div class="extrow" data-ext="${esc(e.id)}">
      <div class="extname">
        <strong>${esc(e.name)}</strong>
        <span>${esc(e.version || '—')}${e.unpacked ? ' · unpacked' : ''}</span>
      </div>
      <span class="expsize">${fmtBytes(e.bytes)}</span>
      <label class="switch" title="${e.enabled ? 'Nonaktifkan' : 'Aktifkan'}">
        <input type="checkbox" ${e.enabled ? 'checked' : ''} data-act="toggle" />
        <span class="track"></span>
      </label>
      <button class="rowbtn" data-act="uninstall" type="button">Hapus</button>
    </div>`).join('');
}

function bindDrawer(p) {
  const search = $('#originSearch');
  search.addEventListener('input', () => {
    state.originQuery = search.value;
    renderOriginTable();
  });

  $('#originAll').addEventListener('click', () => {
    const list = visibleOrigins();
    const allSelected = list.every((o) => state.detailSel.has(o.origin));
    for (const o of list) {
      if (allSelected) state.detailSel.delete(o.origin);
      else state.detailSel.add(o.origin);
    }
    renderOriginTable();
  });

  $('#originBody').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-origin]');
    if (!tr) return;
    const origin = tr.dataset.origin;
    if (e.target.checked) state.detailSel.add(origin);
    else state.detailSel.delete(origin);
    updateOriginToolbar();
  });

  $('#originDelete').addEventListener('click', () => deleteSiteData(p));
  $('#cleanBtn').addEventListener('click', () => cleanOne(p));
  $('#archiveBtn').addEventListener('click', () => archiveOne(p));

  $('#extList').addEventListener('change', async (e) => {
    const row = e.target.closest('.extrow');
    if (!row) return;
    const extId = row.dataset.ext;
    const enabled = state.detail.extensions.find((x) => x.id === extId)?.enabled;
    await setExtension(p, extId, enabled ? 'disable' : 'enable');
  });

  $('#extList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="uninstall"]');
    if (!btn) return;
    const row = btn.closest('.extrow');
    const ext = state.detail.extensions.find((x) => x.id === row.dataset.ext);
    const ok = await confirmUI('Hapus extension?',
      `<p><strong>${esc(ext?.name ?? 'Extension')}</strong> akan dihapus dari profil ini.</p>
       <p class="muted small">Preferensi dan folder extension dipindah ke <span class="mono">_trash</span>, jadi masih bisa dikembalikan.</p>`,
      'Hapus extension');
    if (!ok) return;
    await setExtension(p, ext.id, 'uninstall');
  });
}

async function refreshDetail(p) {
  const data = await api(`/api/profiles/${p.id}`);
  state.detail = data;
  const keeps = new Set(state.detailSel);
  state.detailSel = new Set([...keeps].filter((o) => data.origins.some((x) => x.origin === o)));
  paintDrawer();
  await load();
  const fresh = state.profiles.find((x) => x.id === p.id);
  if (fresh) {
    els.drawerTitle.textContent = fresh.name;
    els.drawerPath.textContent = fresh.path;
  }
}

/* ---------- actions ---------- */
async function deleteSiteData(p) {
  const origins = [...state.detailSel];
  if (!origins.length) return;
  let plan;
  try {
    plan = await api('/api/actions/site-data', { method: 'POST', body: { id: p.id, origins, dryRun: true } });
  } catch (err) { toast(err.message, 'err'); return; }

  const rows = [
    ['Cookie', `${fmtNum(plan.cookieCount)} · ${fmtBytes(plan.cookieBytes)}`],
    ['IndexedDB', `${plan.idbDirs.length} folder · ${fmtBytes(plan.idbDirs.reduce((n, d) => n + d.bytes, 0))}`],
    ['localStorage', plan.lsAvailable ? `${fmtNum(plan.lsKeys)} key · ${fmtBytes(plan.lsBytes)}` : 'tidak terbaca (leveldb)']
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`).join('');

  const ok = await confirmUI('Hapus data situs?',
    `<p>${origins.length} origin akan dihapus dari <strong>${esc(p.name)}</strong>.</p>
     <p class="muted small">Semua sesi login di origin itu hilang. Chrome harus tertutup.</p>
     ${rows}
     <p class="muted small" style="margin-top:10px">Yang dibuang: cookie, IndexedDB, localStorage. Service worker cache tidak dipetakan per origin.</p>
     <div class="kv"><span>Total</span><strong>${fmtBytes(plan.bytes)}</strong></div>`,
    'Hapus data');
  if (!ok) return;

  try {
    const res = await api('/api/actions/site-data', { method: 'POST', body: { id: p.id, origins } });
    toast(`Terhapus: ${fmtNum(res.cookieCount)} cookie, ${res.idbDirs.length} IndexedDB, ${fmtNum(res.lsKeys)} key · ${fmtBytes(res.bytes)}`);
    state.detailSel.clear();
    await refreshDetail(p);
  } catch (err) { toast(err.message, 'err'); }
}

async function setExtension(p, extId, op) {
  try {
    const res = await api('/api/actions/extension', { method: 'POST', body: { id: p.id, extId, op } });
    toast(op === 'uninstall' ? `Extension dihapus: ${res.name}` : `Extension ${op === 'enable' ? 'diaktifkan' : 'dinonaktifkan'}: ${res.name}`);
    await refreshDetail(p);
  } catch (err) { toast(err.message, 'err'); }
}

async function cleanOne(p) {
  let plan;
  try {
    plan = await api('/api/actions/clean-cache', { method: 'POST', body: { ids: [p.id], dryRun: true } });
  } catch (err) { toast(err.message, 'err'); return; }
  if (plan.bytes === 0) { toast('Tidak ada folder cache yang bisa dibuang.', 'info'); return; }
  const ok = await confirmUI('Bersihkan cache?',
    `<p>${fmtBytes(plan.bytes)} cache akan dihapus dari <strong>${esc(p.name)}</strong>.</p>
     <p class="muted small">Cache dibuat ulang oleh Chrome saat dipakai. Cookie dan login tidak disentuh.</p>`,
    'Bersihkan');
  if (!ok) return;
  try {
    const res = await api('/api/actions/clean-cache', { method: 'POST', body: { ids: [p.id] } });
    toast(`Cache dibersihkan · ${fmtBytes(res.bytes)}`);
    await refreshDetail(p);
  } catch (err) { toast(err.message, 'err'); }
}

async function bulkClean() {
  const ids = [...state.selected];
  if (!ids.length) return;
  let plan;
  try {
    plan = await api('/api/actions/clean-cache', { method: 'POST', body: { ids, dryRun: true } });
  } catch (err) { toast(err.message, 'err'); return; }
  const skip = plan.results.filter((r) => r.locked).length;
  const ok = await confirmUI('Bersihkan cache massal?',
    `<p><strong>${fmtBytes(plan.bytes)}</strong> cache dari ${ids.length} profil.</p>
     <p class="muted small">${skip ? `${skip} profil sedang dipakai Chrome dan akan dilewati. ` : ''}Cookie dan login tidak disentuh.</p>`,
    'Bersihkan');
  if (!ok) return;
  try {
    els.bulkCache.disabled = true;
    const res = await api('/api/actions/clean-cache', { method: 'POST', body: { ids } });
    toast(`Cache dibersihkan · ${fmtBytes(res.bytes)}`);
    if (res.job) pollJob(res.job.id, () => {}, () => load());
    state.selected.clear();
    updateBulk();
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    els.bulkCache.disabled = false;
  }
}

async function archiveOne(p) {
  await archiveFlow([p.id]);
}

async function bulkArchive() {
  await archiveFlow([...state.selected]);
}

async function archiveFlow(ids) {
  if (!ids.length) return;
  const payload = await dialog({
    title: 'Arsipkan profil',
    body: `<p>${ids.length} profil akan dikompres ke <span class="mono">_archives</span>.</p>
      <label class="check"><input type="checkbox" id="archCache" /> Sertakan folder cache (arsip jauh lebih besar)</label>
      <label class="check" style="display:block;margin-top:12px">Password (opsional, butuh 7-Zip)
        <input type="password" id="archPass" autocomplete="new-password" placeholder="kosongkan untuk tanpa password" />
      </label>`,
    okLabel: 'Arsipkan',
    danger: false,
    collect: () => ({
      includeCache: $('#archCache')?.checked ?? false,
      password: $('#archPass')?.value || ''
    })
  });
  if (!payload) return;
  try {
    const { job } = await api('/api/actions/archive', { method: 'POST', body: { ids, ...payload } });
    toast('Arsip berjalan di latar belakang…', 'info');
    pollJob(job.id, () => {}, (done) => {
      const ok = (done.result ?? []).filter((r) => !r.error);
      const bad = (done.result ?? []).filter((r) => r.error);
      toast(`${ok.length} arsip selesai${bad.length ? `, ${bad.length} gagal` : ''}`, bad.length ? 'err' : 'ok');
    });
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- grid ---------- */
function applyView() {
  const q = state.query.trim().toLowerCase();
  let list = state.profiles.filter((p) => {
    if (state.onlyLocked && !p.locked) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
  });
  const sorters = {
    size: (a, b) => b.total - a.total,
    cache: (a, b) => b.cache - a.cache,
    site: (a, b) => b.site - a.site,
    recent: (a, b) => b.mtime - a.mtime,
    name: (a, b) => a.name.localeCompare(b.name, 'id', { numeric: true })
  };
  list = list.sort(sorters[state.sort] ?? sorters.size);
  state.view = list;
  els.viewCount.textContent = `${fmtNum(list.length)} profil · ${fmtBytes(list.reduce((n, p) => n + p.total, 0))}`;
  layout();
  renderVisible(true);
  els.empty.classList.toggle('hidden', state.profiles.length > 0);
  if (!state.profiles.length) renderEmpty();
}

function layout() {
  const width = els.grid.clientWidth || els.gridWrap.clientWidth - 32;
  state.cols = Math.max(1, Math.floor((width + GAP) / (MIN_W + GAP)));
  const rows = Math.ceil(state.view.length / state.cols);
  const rowH = CARD_H + GAP;
  els.spacer.style.height = `${Math.max(0, rows * rowH - GAP)}px`;
  state.rows = rows;
}

function cardHTML(p) {
  const total = p.total || 1;
  const legend = CATS
    .filter(([key]) => p[key] > 0)
    .slice(0, 4)
    .map(([key, label, cls]) => `<span><i class="${cls}"></i>${label.split(' ')[0].toLowerCase()} ${fmtBytes(p[key])}</span>`)
    .join('');
  const badges = [
    p.locked ? '<span class="badge lock">terkunci</span>' : '',
    p.synced ? '<span class="badge sync">sync</span>' : ''
  ].join('');
  const sel = state.selected.has(p.id);
  return `
    <article class="card ${sel ? 'selected' : ''}" data-id="${p.id}" tabindex="0" role="button" aria-label="Detail ${esc(p.name)}">
      <div class="card-top">
        <label class="pick" title="Pilih profil"><input type="checkbox" ${sel ? 'checked' : ''} data-pick />
          <span class="box"></span></label>
        <h3 title="${esc(p.path)}">${esc(p.name)}</h3>
        ${badges}
      </div>
      <div class="card-size">${fmtBytes(p.total).split(' ')[0]}<span>${fmtBytes(p.total).split(' ')[1] ?? ''}</span></div>
      <div class="bar">${barHTML(p)}</div>
      <div class="legend">${legend || '<span class="dim">belum ada data</span>'}</div>
      <div class="card-foot">
        <span class="chip">${fmtNum(p.origins)} origin</span>
        <span class="chip">${fmtNum(p.extensions)} ext</span>
        <span class="chip">${relTime(p.mtime)}</span>
        <button class="mini" data-act="cache" type="button">Bersihkan cache</button>
      </div>
    </article>`;
}

function renderVisible(force = false) {
  const rowH = CARD_H + GAP;
  const top = els.gridWrap.scrollTop;
  const start = Math.max(0, Math.floor((top - TOP) / rowH) - 1);
  const end = Math.min(state.rows, Math.ceil((top + els.gridWrap.clientHeight - TOP) / rowH) + 1);
  if (!force && start === state.lastStart && end === state.lastEnd) return;
  state.lastStart = start;
  state.lastEnd = end;
  els.grid.style.transform = `translateY(${start * rowH}px)`;
  const rows = [];
  for (let r = start; r < end; r += 1) {
    const slice = state.view.slice(r * state.cols, (r + 1) * state.cols);
    if (!slice.length) break;
    rows.push(`<div class="grid-row" style="grid-template-columns:repeat(${state.cols},minmax(0,1fr))">${slice.map(cardHTML).join('')}</div>`);
  }
  els.grid.innerHTML = rows.join('');
}

function renderEmpty() {
  const root = state.root;
  els.empty.innerHTML = `
    <div class="empty-card">
      <h2>${root ? 'Belum ada profil terbaca' : 'Tentukan folder profil Chrome'}</h2>
      <p>${root
        ? `Folder <span class="mono">${esc(root)}</span> belum berisi profil. Tekan Scan untuk membaca ulang.`
        : 'Tempel path User Data di kolom atas. Untuk setup satu folder per identitas, arahkan ke folder induk yang berisi banyak folder profil.'}</p>
      <p class="small muted">Windows: <code>%LOCALAPPDATA%\\Google\\Chrome\\User Data</code><br/>
      Linux: <code>~/.config/google-chrome</code><br/>
      macOS: <code>~/Library/Application Support/Google/Chrome</code></p>
      ${root ? '<button class="btn primary" id="emptyScan" type="button">Scan sekarang</button>' : ''}
    </div>`;
  const btn = $('#emptyScan');
  if (btn) btn.addEventListener('click', startScan);
}

/* ---------- selection ---------- */
function updateBulk() {
  const n = state.selected.size;
  els.bulkbar.classList.toggle('hidden', n === 0);
  if (!n) return;
  const bytes = state.profiles.filter((p) => state.selected.has(p.id)).reduce((acc, p) => acc + p.cache, 0);
  els.bulkText.textContent = `${n} dipilih · cache ${fmtBytes(bytes)}`;
}

/* ---------- jobs ---------- */
function pollJob(id, onTick, onDone) {
  const tick = async () => {
    try {
      const { job } = await api(`/api/jobs/${id}`);
      onTick?.(job);
      if (job.state === 'running') setTimeout(tick, 700);
      else onDone?.(job);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  tick();
}

function setScanning(on) {
  state.scanning = on;
  els.scanBtn.disabled = on;
  if (!on) els.scanStatus.innerHTML = '';
}

async function startScan() {
  if (state.scanning) return;
  try {
    const { job } = await api('/api/scan', { method: 'POST', body: {} });
    setScanning(true);
    pollJob(job.id, (j) => {
      const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
      els.scanStatus.innerHTML = `Memindai ${j.done}/${j.total} · ${esc(j.current ?? '')}
        <div class="progress"><i style="width:${pct}%"></i></div>`;
    }, async (j) => {
      setScanning(false);
      if (j.state === 'error') { toast(`Scan gagal: ${j.error}`, 'err'); return; }
      await load();
      toast(`Scan selesai · ${j.result?.scanned ?? 0} profil`);
    });
  } catch (err) {
    setScanning(false);
    toast(err.message, 'err');
  }
}

/* ---------- data ---------- */
async function load() {
  const data = await api('/api/profiles');
  state.root = data.root;
  state.profiles = data.profiles;
  state.stats = data.stats;
  els.rootInput.value = data.root || '';
  for (const id of [...state.selected]) {
    if (!data.profiles.some((p) => p.id === id)) state.selected.delete(id);
  }
  renderStats();
  applyView();
  updateBulk();
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  els.statCount.textContent = fmtNum(s.count);
  els.statTotal.textContent = fmtBytes(s.total);
  els.statCache.textContent = fmtBytes(s.cache);
  els.statSite.textContent = fmtBytes(s.site);
  els.statExt.textContent = fmtBytes(s.ext);
}

/* ---------- trash ---------- */
async function openTrash() {
  let data;
  try { data = await api('/api/trash'); } catch (err) { toast(err.message, 'err'); return; }
  const items = data.items ?? [];
  const rows = items.map((t) => `
    <div class="kv"><span>${esc(t.kind ?? 'sampah')} · ${esc((t.at ?? '').slice(0, 19).replace('T', ' '))}</span><strong>${fmtBytes(t.bytes)}</strong></div>`).join('');
  const value = await dialog({
    title: 'Sampah (_trash)',
    body: `<p class="muted small">Semua penghapusan data situs dan extension dipindah ke sini dulu, jadi masih bisa dikembalikan dengan menyalin folder kembali.</p>
      ${rows || '<p class="muted">Sampah kosong.</p>'}
      <label class="check" style="display:block;margin-top:14px">Hapus permanen yang lebih tua dari
        <input type="number" id="purgeDays" value="14" min="1" max="365" />
      </label>`,
    okLabel: 'Hapus permanen',
    collect: () => ({ days: Math.max(1, Number($('#purgeDays')?.value || 14)) })
  });
  if (!value) return;
  try {
    const res = await api('/api/trash/purge', { method: 'POST', body: { days: value.days } });
    toast(`${res.removed} item sampah dihapus permanen`);
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- events ---------- */
els.rootForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const root = els.rootInput.value.trim();
  if (!root) return;
  try {
    const res = await api('/api/config', { method: 'POST', body: { root } });
    state.root = res.root;
    toast(`${res.found} profil ditemukan`);
    await load();
    if (!state.profiles.length) await startScan();
    else await startScan();
  } catch (err) { toast(err.message, 'err'); }
});

els.scanBtn.addEventListener('click', startScan);

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  els.gridWrap.scrollTop = 0;
  applyView();
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  els.gridWrap.scrollTop = 0;
  applyView();
});

els.onlyLocked.addEventListener('change', () => {
  state.onlyLocked = els.onlyLocked.checked;
  els.gridWrap.scrollTop = 0;
  applyView();
});

els.selectAll.addEventListener('click', () => {
  const all = state.view.every((p) => state.selected.has(p.id));
  for (const p of state.view) {
    if (all) state.selected.delete(p.id);
    else state.selected.add(p.id);
  }
  els.selectAll.textContent = all ? 'Pilih semua' : 'Kosongkan';
  renderVisible(true);
  updateBulk();
});

els.bulkClear.addEventListener('click', () => {
  state.selected.clear();
  updateBulk();
  renderVisible(true);
});

els.bulkCache.addEventListener('click', bulkClean);
els.bulkArchive.addEventListener('click', bulkArchive);
els.trashBtn.addEventListener('click', openTrash);

els.grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.closest('.pick')) return;
  const id = card.dataset.id;
  const mini = e.target.closest('[data-act="cache"]');
  if (mini) {
    const profile = state.profiles.find((p) => p.id === id);
    if (profile) cleanOne(profile);
    return;
  }
  openDetail(id);
});

els.grid.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  openDetail(card.dataset.id);
});

els.grid.addEventListener('change', (e) => {
  if (!e.target.matches('[data-pick]')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.checked) state.selected.add(card.dataset.id);
  else state.selected.delete(card.dataset.id);
  card.classList.toggle('selected', e.target.checked);
  updateBulk();
});

els.gridWrap.addEventListener('scroll', () => {
  if (state.scrollRaf) return;
  state.scrollRaf = requestAnimationFrame(() => {
    state.scrollRaf = null;
    renderVisible();
  });
}, { passive: true });

window.addEventListener('resize', () => {
  layout();
  renderVisible(true);
});

els.drawerClose.addEventListener('click', closeDrawer);
els.scrim.addEventListener('click', () => { closeDrawer(); });

els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeModal();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.modal.classList.contains('hidden')) { closeModal(); return; }
  if (!els.drawer.classList.contains('hidden')) closeDrawer();
});

/* ---------- boot ---------- */
function offlineNotice(err) {
  els.grid.innerHTML = '';
  els.spacer.style.height = '0px';
  els.empty.classList.remove('hidden');
  els.empty.innerHTML = `
    <div class="empty-card">
      <h2>Butuh server lokal</h2>
      <p>Halaman ini dilayani sebagai file statis, jadi API pemindai tidak tersedia.</p>
      <p class="small muted">Di komputermu: <code>npm install</code> lalu <code>npm start</code>, buka <code>http://127.0.0.1:3000</code>.</p>
      ${err ? `<p class="small danger-text">${esc(err.message)}</p>` : ''}
    </div>`;
}

(async function boot() {
  if (!document.querySelector('meta[name="dock-server"]')) { offlineNotice(null); return; }
  try {
    state.config = await api('/api/config');
    els.rootInput.value = state.config.root || '';
    await load();
    if (state.root && !state.profiles.length) startScan();
  } catch (err) {
    offlineNotice(err);
  }
})();

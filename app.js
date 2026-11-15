/* RT Inventory — offline-first inventory PWA. All data lives in IndexedDB on this device. */
'use strict';
const APP_VERSION = '1.0.3';
const DB_NAME = 'rt-inventory';
const DB_VERSION = 1;
const INACTIVE = new Set(['sold', 'archived', 'merged_duplicate', 'removed']);
const STATUS_ORDER = ['in_stock', 'listed', 'draft_unpublished', 'research', 'sold', 'archived', 'merged_duplicate', 'removed'];
const STATUS_LABEL = { in_stock: 'In stock', listed: 'Listed', draft_unpublished: 'Draft', research: 'Research', sold: 'Sold', archived: 'Archived', merged_duplicate: 'Merged dup', removed: 'Removed' };
const CONDITIONS = ['New with tags', 'New in box', 'New without tags', 'Pre-owned — excellent', 'Pre-owned — good', 'Pre-owned — fair', 'For parts / not working', 'UNKNOWN'];
const PLATFORMS = ['eBay', 'Poshmark', 'Mercari', 'Vinted', 'Facebook Marketplace', 'Etsy', 'Depop', 'In person'];
const MAIN_FIELDS = ['title', 'brand', 'category', 'condition', 'status', 'current_price', 'floor_price', 'storage_location', 'size', 'notes'];
const MORE_FIELDS = ['description', 'research_status', 'date_acquired', 'cost_basis', 'source_job_number', 'listed_platforms', 'listing_urls', 'sold_price', 'sold_date', 'sold_platform'];
const PRICE_FIELDS = new Set(['current_price', 'floor_price', 'sold_price', 'lot_list_price', 'lot_floor_price']);
const PAGE = 60;
const FULL_MAX = 1200, THUMB_MAX = 240;

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

const state = {
  db: null, meta: {}, items: new Map(), thumbs: new Map(), photos: new Map(), // photos: sku -> [{id,thumb,created_at}]
  unsynced: 0,
  ui: JSON.parse(sessionStorage.getItem('rt-ui') || 'null') || { q: '', status: 'active', cat: '', price: '', photo: '', sort: 'sku' },
  homeScroll: 0, list: [], shown: 0, observer: null, draft: null, prepared: {},
};

/* ---------------- IndexedDB ---------------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('base', { keyPath: 'sku' });
      db.createObjectStore('items', { keyPath: 'sku' });
      db.createObjectStore('thumbs', { keyPath: 'sku' });
      const p = db.createObjectStore('photos', { keyPath: 'id' }); p.createIndex('sku', 'sku');
      const c = db.createObjectStore('changes', { keyPath: 'id', autoIncrement: true }); c.createIndex('sku', 'sku');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function tx(stores, mode = 'readonly') { return state.db.transaction(stores, mode); }
const done = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
async function getAll(store) { return reqP(tx([store]).objectStore(store).getAll()); }
async function getOne(store, key) { return reqP(tx([store]).objectStore(store).get(key)); }
async function setMeta(key, value) { const t = tx(['meta'], 'readwrite'); t.objectStore('meta').put({ key, value }); await done(t); state.meta[key] = value; }

async function loadAll() {
  const [meta, items, thumbs, photos, changes] = await Promise.all(['meta', 'items', 'thumbs', 'photos', 'changes'].map(getAll));
  state.meta = Object.fromEntries(meta.map((m) => [m.key, m.value]));
  if (!state.meta.device_id) await setMeta('device_id', 'dev-' + rand(10));
  state.items = new Map(items.map((i) => [i.sku, i]));
  state.thumbs = new Map(thumbs.map((t) => [t.sku, t.thumb]));
  state.photos = new Map();
  for (const p of photos.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!state.photos.has(p.sku)) state.photos.set(p.sku, []);
    state.photos.get(p.sku).push({ id: p.id, thumb: p.thumb, created_at: p.created_at });
  }
  state.unsynced = changes.filter((c) => !c.exported).length;
  state.prepared = {};
  updateBadge();
}

/* ---------------- helpers ---------------- */
function rand(n) { const a = crypto.getRandomValues(new Uint8Array(n)); return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); }
function nowISO() { const d = new Date(); const off = -d.getTimezoneOffset(); const s = off >= 0 ? '+' : '-'; const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(off / 60)}:${p(off % 60)}`; }
function today() { return nowISO().slice(0, 10); }
function isBlank(v) { return v === '' || v === null || v === undefined; }
function isUnknown(v) { return isBlank(v) || v === 'UNKNOWN' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v && !Array.isArray(v) && !Object.keys(v).length); }
function money(v) { if (isBlank(v) || v === 'UNKNOWN') return ''; const n = Number(v); return isFinite(n) ? '$' + (Number.isInteger(n) ? n : n.toFixed(2)) : String(v); }
function hasPrice(r) { return !isBlank(r.current_price) && r.current_price !== 'UNKNOWN' && isFinite(Number(r.current_price)); }
function hasPhoto(sku) { const it = state.items.get(sku); return (state.photos.get(sku) || []).length > 0 || (state.thumbs.has(sku) && !(it && it.meta && it.meta.hide_base_photo)); }
function tileThumb(sku) { const lp = state.photos.get(sku); if (lp && lp.length) return lp[0].thumb; const it = state.items.get(sku); return it && it.meta && it.meta.hide_base_photo ? null : state.thumbs.get(sku) || null; }
function skuNum(s) { const m = /(\d+)$/.exec(s || ''); return m ? parseInt(m[1], 10) : 0; }
function nextSku() { let max = state.meta.max_sku_num || 0; for (const k of state.items.keys()) max = Math.max(max, skuNum(k)); return 'RT-' + String(max + 1).padStart(4, '0'); }
function fmtField(k, v) {
  if (PRICE_FIELDS.has(k)) return money(v) || (isBlank(v) ? '' : String(v));
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return Object.entries(v).map(([a, b]) => `${a}: ${b}`).join('\n');
  return String(v ?? '');
}
function label(k) { return k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()); }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
function updateBadge() { const b = $('#syncBadge'); b.hidden = !state.unsynced; b.textContent = state.unsynced > 99 ? '99+' : state.unsynced; }
function saveUI() { sessionStorage.setItem('rt-ui', JSON.stringify(state.ui)); }
function setTitle(t, back) { $('#title').textContent = t; $('#backBtn').hidden = !back; }
function go(hash) { location.hash = hash; }
function diffs(oldR, newR) {
  const out = {}; const keys = new Set([...Object.keys(oldR || {}), ...Object.keys(newR || {})]);
  for (const k of keys) { const a = oldR ? oldR[k] : undefined, b = newR ? newR[k] : undefined; if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = { from: a ?? null, to: b ?? null }; }
  return out;
}
function categories() { const s = new Set(); for (const i of state.items.values()) if (!isUnknown(i.rec.category)) s.add(i.rec.category); return [...s].sort((a, b) => a.localeCompare(b)); }
function distinct(field, extra = []) { const s = new Set(extra); for (const i of state.items.values()) { const v = i.rec[field]; if (typeof v === 'string' && v && v !== 'UNKNOWN') s.add(v); } return [...s].sort((a, b) => a.localeCompare(b)); }
function statuses() { const s = new Set(STATUS_ORDER); for (const i of state.items.values()) if (i.rec.status) s.add(i.rec.status); return [...s]; }

/* ---------------- router ---------------- */
async function route() {
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  state.prevHash = state.curHash; state.curHash = location.hash || '#/';
  const h = location.hash.slice(1) || '/';
  const [, page, arg] = h.split('/');
  $('#addBtn').hidden = true;
  if (!state.meta.base_info && page !== 'sync') return renderWelcome();
  try {
    if (!page) return renderHome();
    if (page === 'item') return renderDetail(decodeURIComponent(arg));
    if (page === 'add') return renderForm(null);
    if (page === 'edit') return renderForm(decodeURIComponent(arg));
    if (page === 'sold') return renderSold(decodeURIComponent(arg));
    if (page === 'sync') return renderSync();
  } catch (e) { console.error(e); view().innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`; return; }
  renderHome();
}
function leaveHome() { if (!location.hash || location.hash === '#/' ) state.homeScroll = window.scrollY; }

/* ---------------- welcome ---------------- */
function renderWelcome() {
  setTitle('RT Inventory', false);
  view().innerHTML = `<div class="welcome">
    <img src="icons/icon-192.png" alt="">
    <h2>Welcome to RT Inventory</h2>
    <p>Your inventory is stored only on this phone. To start, import the data file Grok Bot sent you (it ends in <b>.rtinv.json</b>).</p>
    <button class="btn primary block" id="impBtn">Import data file</button>
    <p class="small">Tip: save the file to the Files app first, then pick it here.</p>
    ${installHint()}
  </div>`;
  $('#impBtn').onclick = () => $('#dataFile').click();
}
function isStandalone() { return window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }
function installHint() {
  if (isStandalone()) return '';
  return `<div class="warnbox"><b>Install on your iPhone:</b> in Safari tap the Share button, then <b>Add to Home Screen</b>. Open RT Inventory from the home-screen icon — Safari can clear data for websites that aren't installed and haven't been opened for a few weeks.</div>`;
}

/* ---------------- home ---------------- */
function filtered() {
  const u = state.ui; const q = u.q.trim().toLowerCase(); const toks = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const it of state.items.values()) {
    const r = it.rec;
    if (u.status === 'active' && INACTIVE.has(r.status)) continue;
    if (u.status === 'unsynced' && !(it.meta && it.meta.dirty)) continue;
    if (u.status && !['active', 'unsynced', 'all'].includes(u.status) && r.status !== u.status) continue;
    if (u.cat && r.category !== u.cat) continue;
    if (u.price === 'priced' && !hasPrice(r)) continue;
    if (u.price === 'unpriced' && hasPrice(r)) continue;
    if (u.photo === 'yes' && !hasPhoto(r.sku)) continue;
    if (u.photo === 'no' && hasPhoto(r.sku)) continue;
    if (toks.length) {
      const hay = `${r.sku} ${skuNum(r.sku)} ${r.title || ''} ${r.brand || ''}`.toLowerCase();
      if (!toks.every((t) => hay.includes(t))) continue;
    }
    out.push(it);
  }
  const p = (it) => (hasPrice(it.rec) ? Number(it.rec.current_price) : null);
  const s = u.sort;
  out.sort((a, b) => {
    if (s === 'sku_desc') return skuNum(b.sku) - skuNum(a.sku);
    if (s === 'price_desc' || s === 'price_asc') { const pa = p(a), pb = p(b); if (pa === null && pb === null) return skuNum(a.sku) - skuNum(b.sku); if (pa === null) return 1; if (pb === null) return -1; return s === 'price_desc' ? pb - pa : pa - pb; }
    if (s === 'edited') { const ea = (a.meta && a.meta.edited_at) || '', eb = (b.meta && b.meta.edited_at) || ''; if (ea !== eb) return eb.localeCompare(ea); return skuNum(b.sku) - skuNum(a.sku); }
    return skuNum(a.sku) - skuNum(b.sku);
  });
  return out;
}
function counts() {
  let active = 0, unpriced = 0, nophoto = 0;
  for (const it of state.items.values()) { if (INACTIVE.has(it.rec.status)) continue; active++; if (!hasPrice(it.rec)) unpriced++; if (!hasPhoto(it.sku)) nophoto++; }
  return { total: state.items.size, active, unpriced, nophoto };
}
function opt(v, t, cur) { return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`; }
function renderHome() {
  setTitle('RT Inventory', false); $('#addBtn').hidden = false;
  const u = state.ui; const c = counts();
  view().innerHTML = `
    <div class="stats">
      <div class="stat"><b>${c.active}</b><span>Active</span></div>
      <div class="stat"><b>${c.unpriced}</b><span>Unpriced</span></div>
      <div class="stat"><b>${c.nophoto}</b><span>No photo</span></div>
      <div class="stat"><b>${state.unsynced}</b><span>Unsynced</span></div>
    </div>
    <input class="search" id="q" type="search" placeholder="Search SKU, title, brand" value="${esc(u.q)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
    <div class="filters">
      <select id="fStatus" aria-label="Status">${opt('active', 'Active', u.status)}${opt('all', 'All statuses', u.status)}${opt('unsynced', 'Unsynced edits', u.status)}${statuses().map((s) => opt(s, STATUS_LABEL[s] || s, u.status)).join('')}</select>
      <select id="fCat" aria-label="Category">${opt('', 'All categories', u.cat)}${categories().map((s) => opt(s, s, u.cat)).join('')}</select>
      <select id="fPrice" aria-label="Price">${opt('', 'Any price', u.price)}${opt('priced', 'Priced', u.price)}${opt('unpriced', 'Unpriced', u.price)}</select>
      <select id="fPhoto" aria-label="Photo">${opt('', 'Any photo', u.photo)}${opt('yes', 'Has photo', u.photo)}${opt('no', 'No photo', u.photo)}</select>
      <select id="fSort" aria-label="Sort">${opt('sku', 'Sort: SKU ↑', u.sort)}${opt('sku_desc', 'Sort: SKU ↓', u.sort)}${opt('price_desc', 'Price high→low', u.sort)}${opt('price_asc', 'Price low→high', u.sort)}${opt('edited', 'Recently edited', u.sort)}</select>
    </div>
    <div class="resultline"><span id="nres"></span><button class="linkbtn" id="clr">Clear filters</button></div>
    <div class="grid" id="grid"></div><div class="sentinel" id="sentinel"></div>`;
  let deb;
  $('#q').addEventListener('input', (e) => { clearTimeout(deb); deb = setTimeout(() => { u.q = e.target.value; saveUI(); fillGrid(); }, 120); });
  for (const [id, k] of [['fStatus', 'status'], ['fCat', 'cat'], ['fPrice', 'price'], ['fPhoto', 'photo'], ['fSort', 'sort']]) $('#' + id).addEventListener('change', (e) => { u[k] = e.target.value; saveUI(); fillGrid(); });
  $('#clr').onclick = () => { Object.assign(u, { q: '', status: 'active', cat: '', price: '', photo: '', sort: 'sku' }); saveUI(); renderHome(); };
  $('#grid').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (t) { leaveHome(); go('#/item/' + encodeURIComponent(t.dataset.sku)); } });
  fillGrid(state.homeScroll);
}
function tileHTML(it) {
  const r = it.rec; const th = tileThumb(it.sku); const pr = money(r.current_price);
  return `<button class="tile" data-sku="${esc(it.sku)}">
    <div class="thumb">${th ? `<img loading="lazy" decoding="async" src="${th}" alt="">` : 'No photo'}</div>
    <div class="meta"><div class="row"><span class="sku">${esc(it.sku)}</span>${it.meta && it.meta.dirty ? '<span class="dot" title="Unsynced"></span>' : ''}</div>
    <div class="ttl">${esc(r.title || '(untitled)')}</div>
    <div class="row">${pr ? `<span class="price">${pr}</span>` : '<span class="price none">No price</span>'}<span class="pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status || '')}</span></div></div></button>`;
}
function fillGrid(restoreY) {
  state.list = filtered(); state.shown = 0;
  const g = $('#grid'); g.innerHTML = '';
  $('#nres').textContent = `${state.list.length} item${state.list.length === 1 ? '' : 's'}`;
  if (!state.list.length) g.innerHTML = '<div class="empty">No items match.</div>';
  const more = () => { const next = state.list.slice(state.shown, state.shown + PAGE); state.shown += next.length; g.insertAdjacentHTML('beforeend', next.map(tileHTML).join('')); };
  more();
  if (restoreY) { while (state.shown < state.list.length && document.body.scrollHeight < restoreY + innerHeight) more(); requestAnimationFrame(() => window.scrollTo(0, restoreY)); state.homeScroll = 0; }
  else window.scrollTo(0, 0);
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting) && state.shown < state.list.length) more(); }, { rootMargin: '800px' });
  state.observer.observe($('#sentinel'));
}

/* ---------------- detail ---------------- */
async function renderDetail(sku) {
  const it = state.items.get(sku);
  if (!it) { view().innerHTML = `<div class="empty">Item ${esc(sku)} not found.</div>`; setTitle('Not found', true); return; }
  setTitle(sku, true); const r = it.rec;
  const local = await reqP(tx(['photos']).objectStore('photos').index('sku').getAll(sku));
  local.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const imgs = local.map((p) => ({ src: p.full, label: 'Phone photo' }));
  if (state.thumbs.has(sku) && !(it.meta && it.meta.hide_base_photo)) imgs.push({ src: state.thumbs.get(sku), label: 'Catalog thumbnail' });
  const order = ['title', 'status', 'current_price', 'floor_price', 'brand', 'category', 'condition', 'size', 'storage_location', 'notes', 'description', 'research_status', 'listed_platforms', 'listing_urls', 'sold_price', 'sold_date', 'sold_platform', 'date_acquired', 'cost_basis', 'source_job_number'];
  const keys = [...order.filter((k) => k in r), ...Object.keys(r).filter((k) => !order.includes(k) && k !== 'sku')];
  const hist = await reqP(tx(['changes']).objectStore('changes').index('sku').getAll(sku));
  view().innerHTML = `
    ${imgs.length ? `<div class="hero"><img id="heroImg" src="${imgs[0].src}" alt=""></div>${imgs.length > 1 ? `<div class="strip">${imgs.map((m, i) => `<img data-i="${i}" class="${i ? '' : 'on'}" src="${m.src}" alt="">`).join('')}</div>` : ''}<p class="small" id="heroLbl">${esc(imgs[0].label)}</p>` : '<div class="hero"><div class="thumb">No photo</div></div>'}
    <div class="card">
      <div class="row"><span class="sku">${esc(sku)}</span><span class="pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></div>
      <h2 class="d-title">${esc(r.title || '(untitled)')}</h2>
      <div class="row"><span class="price">${money(r.current_price) || '<span class="price none">No price</span>'}</span>${hasPrice(r) && !isBlank(r.floor_price) ? `<span class="small">Floor ${money(r.floor_price)}</span>` : ''}</div>
      ${it.meta && it.meta.dirty ? '<div class="warnbox">This item has changes that haven’t been exported for sync yet.</div>' : ''}
      <div class="btnrow" style="margin-top:12px"><button class="btn primary" id="editBtn">Edit</button>${r.status !== 'sold' ? '<button class="btn" id="soldBtn">Mark sold</button>' : ''}</div>
    </div>
    <div class="card"><dl class="fields">${keys.filter((k) => k !== 'title').map((k) => { const v = fmtField(k, r[k]); const unk = isUnknown(r[k]); return `<dt>${esc(label(k))}</dt><dd class="${unk ? 'unk' : ''}">${unk ? '—' : esc(v)}</dd>`; }).join('')}</dl></div>
    ${hist.length ? `<div class="card"><h2>Changes on this phone</h2><div class="log">${hist.reverse().map(logLine).join('')}</div></div>` : ''}`;
  $('#editBtn').onclick = () => go('#/edit/' + encodeURIComponent(sku));
  const sb = $('#soldBtn'); if (sb) sb.onclick = () => go('#/sold/' + encodeURIComponent(sku));
  view().querySelectorAll('.strip img').forEach((el) => el.onclick = () => { $('#heroImg').src = imgs[el.dataset.i].src; $('#heroLbl').textContent = imgs[el.dataset.i].label; view().querySelectorAll('.strip img').forEach((x) => x.classList.toggle('on', x === el)); });
  window.scrollTo(0, 0);
}
function logLine(c) {
  const f = Object.keys(c.diffs || {});
  const ph = (c.photos_added || []).length ? ` +${c.photos_added.length} photo` : '';
  const rm = (c.photos_removed || []).length ? ` −${c.photos_removed.length} photo` : '';
  return `<div><b>${esc(c.sku)}</b> ${esc(c.action)} · ${esc((c.ts || '').replace('T', ' ').slice(0, 16))}${c.exported ? ' · synced' : ' · <b>unsynced</b>'}<br>${esc(f.slice(0, 8).join(', '))}${f.length > 8 ? '…' : ''}${ph}${rm}</div>`;
}

/* ---------------- add / edit form ---------------- */
function parseVal(k, raw, orig) {
  if (k === 'listed_platforms') { return raw.split(',').map((s) => s.trim()).filter(Boolean); }
  if (k === 'listing_urls') { const o = {}; raw.split('\n').forEach((line) => { const m = /^\s*([^:]+?)\s*:\s*(\S.*)$/.exec(line); if (m) o[m[1]] = m[2].trim(); }); return o; }
  const t = raw.trim();
  if (PRICE_FIELDS.has(k)) { if (t === '') return ''; const n = Number(t.replace(/[$,]/g, '')); return isFinite(n) ? n : t; }
  if (typeof orig === 'number') { const n = Number(t); return t !== '' && isFinite(n) ? n : t; }
  return t;
}
function inputFor(k, v, extra = '') {
  const val = isBlank(v) ? '' : fmtField(k, v).replace(/^\$/, '');
  const id = 'f_' + k;
  if (k === 'notes' || k === 'description' || k === 'listing_urls') return `<label class="fl"><span>${esc(label(k))}${k === 'listing_urls' ? ' (one per line: platform: url)' : ''}</span><textarea id="${id}" name="${k}">${esc(v === 'UNKNOWN' && k !== 'notes' ? 'UNKNOWN' : val)}</textarea></label>`;
  if (k === 'status') return `<label class="fl"><span>Status</span><select id="${id}" name="status">${statuses().map((s) => opt(s, STATUS_LABEL[s] ? `${STATUS_LABEL[s]} (${s})` : s, v || 'in_stock')).join('')}</select></label>`;
  const list = { category: 'dl_cat', condition: 'dl_cond', storage_location: 'dl_loc', brand: 'dl_brand', sold_platform: 'dl_plat', research_status: 'dl_rs' }[k];
  const type = PRICE_FIELDS.has(k) ? 'text" inputmode="decimal' : (k === 'sold_date' ? 'date' : 'text');
  return `<label class="fl"><span>${esc(label(k))}${PRICE_FIELDS.has(k) ? ' ($)' : ''}${k === 'listed_platforms' ? ' (comma-separated)' : ''}</span><input id="${id}" name="${k}" type="${type}" value="${esc(val)}" ${list ? `list="${list}"` : ''} autocomplete="off" ${extra}></label>`;
}
async function renderForm(sku) {
  const isNew = !sku; const it = isNew ? null : state.items.get(sku);
  if (!isNew && !it) { view().innerHTML = '<div class="empty">Not found.</div>'; return; }
  const newSku = isNew ? nextSku() : sku;
  const rec = isNew ? { sku: newSku, title: '', brand: '', category: '', condition: '', status: 'in_stock', current_price: '', floor_price: '', storage_location: '', size: '', notes: '' } : it.rec;
  setTitle(isNew ? `Add ${newSku}` : `Edit ${sku}`, true);
  const existing = isNew ? [] : await reqP(tx(['photos']).objectStore('photos').index('sku').getAll(sku));
  existing.sort((a, b) => a.created_at.localeCompare(b.created_at));
  state.draft = { sku: newSku, isNew, added: [], removed: new Set(), hideBase: !!(it && it.meta && it.meta.hide_base_photo), existing };
  const extras = isNew ? [] : Object.keys(rec).filter((k) => k !== 'sku' && !MAIN_FIELDS.includes(k) && !MORE_FIELDS.includes(k));
  view().innerHTML = `<form id="frm" novalidate>
    <div class="card"><h2>Photos</h2><div class="photos" id="phGrid"></div>
      <div class="btnrow"><button type="button" class="btn" id="camBtn">📷 Take photo</button><button type="button" class="btn" id="libBtn">🖼 Choose photos</button></div>
      <input type="file" id="camIn" accept="image/*,.heic,.heif,image/heic,image/heif" capture="environment" hidden><input type="file" id="libIn" multiple hidden>
      <p class="small" id="phMsg"></p></div>
    <div class="card">
      ${inputFor('title', rec.title, 'required enterkeyhint="next"')}
      <div class="two">${inputFor('current_price', rec.current_price)}${inputFor('floor_price', rec.floor_price)}</div>
      ${inputFor('brand', rec.brand)}${inputFor('category', rec.category)}${inputFor('condition', rec.condition)}${inputFor('status', rec.status)}
      ${inputFor('storage_location', rec.storage_location)}${inputFor('size', rec.size)}${inputFor('notes', rec.notes)}
      <details class="more"${isNew ? '' : ''}><summary>More fields</summary>
        ${MORE_FIELDS.map((k) => inputFor(k, rec[k] ?? (isNew ? '' : ''))).join('')}
        ${extras.map((k) => inputFor(k, rec[k])).join('')}
      </details>
    </div>
    <div class="stickybar"><button type="button" class="btn" id="cancelBtn">Cancel</button><button type="submit" class="btn primary" id="saveBtn">${isNew ? 'Add item' : 'Save'}</button></div>
    <datalist id="dl_cat">${categories().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl_cond">${distinct('condition', CONDITIONS).slice(0, 60).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl_loc">${distinct('storage_location').map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl_brand">${distinct('brand').map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl_plat">${PLATFORMS.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl_rs">${['needed', 'in progress', 'done', 'UNKNOWN'].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
  </form>`;
  drawPhotoGrid();
  $('#camBtn').onclick = () => $('#camIn').click();
  $('#libBtn').onclick = () => $('#libIn').click();
  const onFiles = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    $('#phMsg').textContent = `Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`;
    for (const f of files) {
      try { const p = await processImage(f); state.draft.added.push(p); drawPhotoGrid(); }
      catch (err) { console.error(err); toast('Could not read that photo: ' + err.message, 4000); }
    }
    $('#phMsg').textContent = '';
  };
  $('#camIn').onchange = onFiles; $('#libIn').onchange = onFiles;
  $('#cancelBtn').onclick = () => history.back();
  $('#frm').onsubmit = (e) => { e.preventDefault(); saveForm(rec); };
  if (isNew) setTimeout(() => $('#f_title').focus(), 50);
}
function drawPhotoGrid() {
  const d = state.draft; const g = $('#phGrid'); if (!g) return;
  const cells = [];
  d.existing.filter((p) => !d.removed.has(p.id)).forEach((p) => cells.push(`<div class="ph"><img src="${p.thumb}" alt=""><button type="button" data-rm="${esc(p.id)}" aria-label="Remove photo">×</button></div>`));
  d.added.forEach((p, i) => cells.push(`<div class="ph"><img src="${p.thumb}" alt=""><span class="tag">new</span><button type="button" data-rmnew="${i}" aria-label="Remove photo">×</button></div>`));
  if (!d.isNew && state.thumbs.has(d.sku) && !d.hideBase) cells.push(`<div class="ph"><img src="${state.thumbs.get(d.sku)}" alt=""><span class="tag">catalog</span><button type="button" data-rmbase="1" aria-label="Remove catalog photo">×</button></div>`);
  g.innerHTML = cells.join('') || '<p class="small">No photos yet.</p>';
  g.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { d.removed.add(b.dataset.rm); drawPhotoGrid(); });
  g.querySelectorAll('[data-rmnew]').forEach((b) => b.onclick = () => { d.added.splice(+b.dataset.rmnew, 1); drawPhotoGrid(); });
  g.querySelectorAll('[data-rmbase]').forEach((b) => b.onclick = () => { if (confirm('Hide the catalog photo for this item? (It will be flagged for unlinking at sync.)')) { d.hideBase = true; drawPhotoGrid(); } });
}
async function processImage(file) {
  let src, cleanup = () => {};
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); cleanup = () => src.close && src.close(); }
  catch (_) {
    const url = URL.createObjectURL(file);
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('unsupported image')); im.src = url; });
    cleanup = () => URL.revokeObjectURL(url);
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const draw = (max, q) => { const s = Math.min(1, max / Math.max(w, h)); const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, c.width, c.height); return { url: c.toDataURL('image/jpeg', q), w: c.width, h: c.height }; };
  const full = draw(FULL_MAX, 0.82), th = draw(THUMB_MAX, 0.6); cleanup();
  return { full: full.url, thumb: th.url, width: full.w, height: full.h, name: file.name || 'photo.jpg' };
}
async function saveForm(origRec) {
  const d = state.draft; const f = $('#frm');
  const title = $('#f_title').value.trim();
  if (!title) { toast('Title is required'); $('#f_title').focus(); return; }
  const newRec = d.isNew ? newRecordTemplate(d.sku) : JSON.parse(JSON.stringify(origRec));
  f.querySelectorAll('[name]').forEach((el) => {
    const k = el.name; const orig = origRec[k];
    const shown = isBlank(orig) ? '' : fmtField(k, orig).replace(/^\$/, '');
    if (!d.isNew && el.value === shown) return; // untouched: keep original type/value
    const v = parseVal(k, el.value, orig);
    if (d.isNew && v === '' && !PRICE_FIELDS.has(k) && k in newRec) return; // keep template defaults (UNKNOWN)
    if (d.isNew && v === '' && !(k in newRec)) return;
    if (d.isNew && Array.isArray(v) && !v.length) return;
    if (d.isNew && v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
    newRec[k] = v;
  });
  const df = diffs(d.isNew ? null : origRec, newRec);
  if (d.isNew) delete df.sku;
  const removedIds = [...d.removed];
  const baseRemoved = d.hideBase && !(state.items.get(d.sku)?.meta?.hide_base_photo);
  if (!d.isNew && !Object.keys(df).length && !d.added.length && !removedIds.length && !baseRemoved) { toast('No changes'); backToItem(d.sku); return; }
  if (d.isNew && state.items.has(d.sku)) { toast('SKU already exists — reopen Add'); return; }
  $('#saveBtn').disabled = true;
  const ts = nowISO();
  const t = tx(['items', 'photos', 'changes', 'meta'], 'readwrite');
  const added = d.added.map((p, i) => ({ id: `${d.sku}-${Date.now().toString(36)}${i}-${rand(4)}`, sku: d.sku, full: p.full, thumb: p.thumb, width: p.width, height: p.height, name: p.name, created_at: ts, exported: false }));
  added.forEach((p) => t.objectStore('photos').put(p));
  removedIds.forEach((id) => t.objectStore('photos').delete(id));
  const prev = state.items.get(d.sku);
  const meta = Object.assign({}, prev ? prev.meta : {}, { edited_at: ts, dirty: true, is_new: d.isNew || !!(prev && prev.meta && prev.meta.is_new) });
  if (d.hideBase) meta.hide_base_photo = true;
  const item = { sku: d.sku, rec: newRec, meta };
  t.objectStore('items').put(item);
  const ch = { ts, sku: d.sku, action: d.isNew ? 'add' : 'edit', diffs: df, photos_added: added.map((p) => p.id), photos_removed: [...removedIds.map((id) => ({ id })), ...(baseRemoved ? [{ source: 'catalog_thumbnail' }] : [])], exported: false, app_version: APP_VERSION };
  t.objectStore('changes').add(ch);
  if (d.isNew) t.objectStore('meta').put({ key: 'max_sku_num', value: Math.max(state.meta.max_sku_num || 0, skuNum(d.sku)) });
  await done(t);
  if (d.isNew) state.meta.max_sku_num = Math.max(state.meta.max_sku_num || 0, skuNum(d.sku));
  state.items.set(d.sku, item);
  const list = (state.photos.get(d.sku) || []).filter((p) => !d.removed.has(p.id)).concat(added.map((p) => ({ id: p.id, thumb: p.thumb, created_at: p.created_at })));
  state.photos.set(d.sku, list);
  state.unsynced++; state.prepared = {}; updateBadge();
  toast(d.isNew ? `Added ${d.sku}` : `Saved ${d.sku}`);
  backToItem(d.sku);
}
function backToItem(sku) {
  const h = '#/item/' + encodeURIComponent(sku);
  if (state.prevHash === h) history.back(); else location.replace(h);
}
function newRecordTemplate(sku) {
  return { sku, title: '', category: 'UNKNOWN', brand: 'UNKNOWN', description: 'UNKNOWN', condition: 'UNKNOWN', status: 'in_stock', listed_platforms: [], listing_urls: {}, current_price: '', floor_price: '',
    research_status: 'needed', date_acquired: 'UNKNOWN', cost_basis: 'UNKNOWN', source_job_number: 'UNKNOWN', storage_location: 'UNKNOWN', size: '', notes: '' };
}

/* ---------------- mark sold ---------------- */
function renderSold(sku) {
  const it = state.items.get(sku); if (!it) return renderHome();
  setTitle(`Sold ${sku}`, true);
  view().innerHTML = `<form id="sf" novalidate><div class="card"><h2>${esc(it.rec.title)}</h2>
    <p class="small">Listed at ${money(it.rec.current_price) || 'no price'}</p>
    <label class="fl"><span>Sold price ($)</span><input name="sold_price" id="s_price" inputmode="decimal" value="${esc(isBlank(it.rec.sold_price) ? '' : it.rec.sold_price)}"></label>
    <label class="fl"><span>Sold date</span><input type="date" name="sold_date" id="s_date" value="${esc(it.rec.sold_date || today())}"></label>
    <label class="fl"><span>Platform</span><input name="sold_platform" id="s_plat" list="dl_plat2" value="${esc(it.rec.sold_platform || (it.rec.listed_platforms || [])[0] || '')}" autocomplete="off"></label>
    <datalist id="dl_plat2">${PLATFORMS.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></div>
    <div class="stickybar"><button type="button" class="btn" id="sc">Cancel</button><button class="btn primary" type="submit">Mark sold</button></div></form>`;
  $('#sc').onclick = () => history.back();
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const nr = JSON.parse(JSON.stringify(it.rec));
    nr.status = 'sold'; nr.sold_price = parseVal('sold_price', $('#s_price').value); nr.sold_date = $('#s_date').value; nr.sold_platform = $('#s_plat').value.trim();
    const df = diffs(it.rec, nr); const ts = nowISO();
    const item = { sku, rec: nr, meta: Object.assign({}, it.meta, { edited_at: ts, dirty: true }) };
    const t = tx(['items', 'changes'], 'readwrite');
    t.objectStore('items').put(item);
    t.objectStore('changes').add({ ts, sku, action: 'mark_sold', diffs: df, photos_added: [], photos_removed: [], exported: false, app_version: APP_VERSION });
    await done(t);
    state.items.set(sku, item); state.unsynced++; state.prepared = {}; updateBadge();
    toast(`${sku} marked sold`); backToItem(sku);
  };
}

/* ---------------- export ---------------- */
function stamp() { return nowISO().slice(0, 16).replace(/[:T]/g, '-'); }
async function buildChangesExport(scope) {
  const all = await getAll('changes');
  const chosen = all.filter((c) => scope === 'all' || !c.exported).sort((a, b) => a.id - b.id);
  if (!chosen.length) return null;
  const skus = [...new Set(chosen.map((c) => c.sku))];
  const addSkus = new Set(chosen.filter((c) => c.action === 'add').map((c) => c.sku));
  const photoIds = new Set(chosen.flatMap((c) => c.photos_added || []));
  const photos = (await getAll('photos')).filter((p) => photoIds.has(p.id));
  const exportId = `${state.meta.device_id}-${stamp()}-${rand(4)}`;
  const obj = {
    format: 'rt-inventory-changes', version: 1, app_version: APP_VERSION, export_id: exportId, device_id: state.meta.device_id,
    exported_at: nowISO(), scope, base_generated_at: state.meta.base_info && state.meta.base_info.generated_at,
    summary: { changes: chosen.length, new_records: [...addSkus].filter((s) => state.items.has(s)).length, edited_records: skus.filter((s) => !addSkus.has(s)).length, photos: photos.length },
    changes: chosen.map(({ exported, export_id, ...c }) => c),
    new_records: [...addSkus].filter((s) => state.items.has(s)).map((s) => state.items.get(s).rec),
    edited_records: skus.filter((s) => !addSkus.has(s) && state.items.has(s)).map((s) => state.items.get(s).rec),
    photos: photos.map((p) => ({ id: p.id, sku: p.sku, filename: p.id + '.jpg', mime: 'image/jpeg', width: p.width, height: p.height, created_at: p.created_at, original_name: p.name, data_base64: p.full.split(',')[1] })),
  };
  const name = `rt-changes-${stamp()}.json`;
  return { obj, ids: chosen.map((c) => c.id), file: new File([JSON.stringify(obj)], name, { type: 'application/json' }), name };
}
async function buildBackup() {
  const [items, changes, photos, thumbs] = await Promise.all(['items', 'changes', 'photos', 'thumbs'].map(getAll));
  const obj = { format: 'rt-inventory-backup', version: 1, app_version: APP_VERSION, created_at: nowISO(), device_id: state.meta.device_id, base_info: state.meta.base_info, max_sku_num: state.meta.max_sku_num || 0,
    base: await getAll('base'), items, changes, photos, thumbs };
  const name = `rt-backup-${stamp()}.json`;
  return { obj, file: new File([JSON.stringify(obj)], name, { type: 'application/json' }), name };
}
async function shareOrDownload(p) {
  if (navigator.canShare && navigator.canShare({ files: [p.file] })) {
    try { await navigator.share({ files: [p.file], title: p.name }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; if (e.name === 'NotAllowedError') return 'needs-tap'; console.warn('share failed, downloading', e); }
  }
  const url = URL.createObjectURL(p.file); const a = document.createElement('a'); a.href = url; a.download = p.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); return 'downloaded';
}
async function markExported(ids, exportId) {
  const t = tx(['changes', 'items'], 'readwrite'); const cs = t.objectStore('changes'); const touched = new Set();
  for (const id of ids) { const c = await reqP(cs.get(id)); if (c && !c.exported) { c.exported = true; c.export_id = exportId; c.exported_at = nowISO(); cs.put(c); touched.add(c.sku); } }
  await done(t);
  const rest = (await getAll('changes')).filter((c) => !c.exported);
  const dirty = new Set(rest.map((c) => c.sku));
  const t2 = tx(['items'], 'readwrite');
  for (const sku of touched) { const it = state.items.get(sku); if (it && !dirty.has(sku)) { it.meta = Object.assign({}, it.meta, { dirty: false }); t2.objectStore('items').put(it); } }
  await done(t2);
  state.unsynced = rest.length; await setMeta('last_export', { at: nowISO(), export_id: exportId, count: ids.length }); updateBadge();
}
async function doExport(kind, btn) {
  try {
    let p = state.prepared[kind];
    if (!p) { btn.disabled = true; btn.textContent = 'Preparing…'; p = kind === 'backup' ? await buildBackup() : await buildChangesExport(kind === 'all' ? 'all' : 'unsynced'); state.prepared[kind] = p; btn.disabled = false; }
    if (!p) { toast('Nothing to export'); return renderSync(); }
    const res = await shareOrDownload(p);
    if (res === 'needs-tap') { btn.textContent = 'Ready — tap to share'; toast('File ready. Tap again to share.'); return; }
    if (res === 'cancelled') { toast('Export cancelled — nothing marked as synced'); return renderSync(); }
    if (kind !== 'backup') { await markExported(p.ids, p.obj.export_id); delete state.prepared[kind]; toast(`Exported ${p.ids.length} change${p.ids.length === 1 ? '' : 's'} — send the file to Grok Bot`, 4000); }
    else { await setMeta('last_backup', nowISO()); toast('Backup exported'); }
    state.prepared = {}; renderSync();
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, 5000); btn.disabled = false; }
}

/* ---------------- import ---------------- */
$('#dataFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  toast('Reading file…', 10000);
  try {
    const obj = JSON.parse(await f.text());
    if (obj.format === 'rt-inventory-data') await importData(obj);
    else if (obj.format === 'rt-inventory-backup') await restoreBackup(obj);
    else if (obj.format === 'rt-inventory-changes') toast('That is a sync export. Send it to Grok Bot instead of importing it here.', 5000);
    else toast('Not an RT Inventory data file.', 4000);
  } catch (err) { console.error(err); toast('Import failed: ' + err.message, 5000); }
});
async function importData(obj) {
  if (!Array.isArray(obj.records)) throw new Error('file has no records');
  const changes = (await getAll('changes')).sort((a, b) => a.id - b.id);
  const pending = changes.filter((c) => !c.exported);
  if (state.meta.base_info) {
    const msg = `Replace the inventory data with this file (${obj.records.length} records, made ${String(obj.generated_at || '').slice(0, 16).replace('T', ' ')})?` +
      (pending.length ? `\n\nYou have ${pending.length} unsynced change${pending.length === 1 ? '' : 's'} on this phone. They will be kept and re-applied on top of the new data, but it is safest to export them first.` : '\n\nAll your changes have been exported.');
    if (!confirm(msg)) { toast('Import cancelled'); return; }
  }
  const base = new Map(obj.records.map((r) => [r.sku, r]));
  const items = new Map([...base].map(([s, r]) => [s, { sku: s, rec: JSON.parse(JSON.stringify(r)), meta: {} }]));
  const oldItems = state.items;
  // local-only new items not yet in the new base: keep them as they are on the phone
  const keepSkus = new Set();
  for (const [s, it] of oldItems) if (it.meta && it.meta.is_new && !base.has(s)) { items.set(s, { sku: s, rec: it.rec, meta: Object.assign({}, it.meta) }); keepSkus.add(s); }
  // re-apply unsynced changes; renumber unsynced adds whose SKU now collides with the new base
  const renames = new Map(); let maxNum = Math.max(state.meta.max_sku_num || 0, ...[...items.keys()].map(skuNum));
  for (const c of pending) if (c.action === 'add' && base.has(c.sku) && !renames.has(c.sku)) { maxNum++; renames.set(c.sku, 'RT-' + String(maxNum).padStart(4, '0')); }
  const t = tx(['meta', 'base', 'items', 'thumbs', 'photos', 'changes'], 'readwrite');
  for (const [oldS, newS] of renames) {
    const it = oldItems.get(oldS); items.set(newS, { sku: newS, rec: Object.assign({}, it.rec, { sku: newS }), meta: Object.assign({}, it.meta, { dirty: true, renumbered_from: oldS }) }); keepSkus.add(newS);
    for (const c of changes.filter((x) => x.sku === oldS && !x.exported)) { c.sku = newS; if (c.diffs && c.diffs.sku) c.diffs.sku.to = newS; c.renumbered_from = oldS; t.objectStore('changes').put(c); }
    const ph = await reqP(t.objectStore('photos').index('sku').getAll(oldS));
    for (const p of ph) { p.sku = newS; t.objectStore('photos').put(p); }
  }
  for (const c of pending) {
    if (keepSkus.has(c.sku)) continue;
    const it = items.get(c.sku); if (!it) continue;
    for (const [k, d] of Object.entries(c.diffs || {})) { if (d.to === null) delete it.rec[k]; else it.rec[k] = d.to; }
    it.meta = Object.assign({}, it.meta, { dirty: true, edited_at: c.ts, is_new: c.action === 'add' });
    if ((c.photos_removed || []).some((p) => p.source)) it.meta.hide_base_photo = true;
  }
  for (const s of ['base', 'items', 'thumbs']) t.objectStore(s).clear();
  for (const r of obj.records) t.objectStore('base').put(r);
  for (const it of items.values()) t.objectStore('items').put(it);
  for (const [sku, v] of Object.entries(obj.thumbs || {})) t.objectStore('thumbs').put({ sku, thumb: v.thumb || v, source: v.source || '' });
  t.objectStore('meta').put({ key: 'base_info', value: { generated_at: obj.generated_at, record_count: obj.records.length, imported_at: nowISO(), file_version: obj.version } });
  t.objectStore('meta').put({ key: 'max_sku_num', value: maxNum });
  await done(t);
  await loadAll();
  toast(`Imported ${obj.records.length} records${pending.length ? `; kept ${pending.length} unsynced changes` : ''}${renames.size ? `; renumbered ${[...renames].map(([a, b]) => a + '→' + b).join(', ')}` : ''}`, 6000);
  go('#/'); route();
}
async function restoreBackup(obj) {
  if (!confirm(`Restore this backup from ${String(obj.created_at).slice(0, 16).replace('T', ' ')}? It replaces everything currently on this phone (${(obj.items || []).length} items, ${(obj.photos || []).length} photos).`)) return;
  const t = tx(['meta', 'base', 'items', 'thumbs', 'photos', 'changes'], 'readwrite');
  for (const s of ['base', 'items', 'thumbs', 'photos', 'changes']) t.objectStore(s).clear();
  (obj.base || []).forEach((r) => t.objectStore('base').put(r));
  (obj.items || []).forEach((r) => t.objectStore('items').put(r));
  (obj.thumbs || []).forEach((r) => t.objectStore('thumbs').put(r));
  (obj.photos || []).forEach((r) => t.objectStore('photos').put(r));
  (obj.changes || []).forEach((r) => t.objectStore('changes').put(r));
  t.objectStore('meta').put({ key: 'base_info', value: obj.base_info });
  t.objectStore('meta').put({ key: 'max_sku_num', value: obj.max_sku_num || 0 });
  await done(t); await loadAll(); toast('Backup restored'); go('#/'); route();
}

/* ---------------- sync page ---------------- */
async function renderSync() {
  setTitle('Sync & backup', true);
  const changes = (await getAll('changes')).sort((a, b) => b.id - a.id);
  const pending = changes.filter((c) => !c.exported);
  const nPhotos = [...state.photos.values()].reduce((a, b) => a + b.length, 0);
  let est = ''; try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1048576).toFixed(1)} MB used`; } catch (_) {}
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (_) {}
  const bi = state.meta.base_info; const le = state.meta.last_export;
  view().innerHTML = `
    <div class="card"><h2>Send changes to Grok Bot</h2>
      <p>${pending.length ? `<b>${pending.length}</b> unsynced change${pending.length === 1 ? '' : 's'} (${new Set(pending.map((c) => c.sku)).size} items).` : 'Everything has been exported.'}</p>
      <button class="btn primary block" id="expBtn" ${pending.length ? '' : 'disabled'}>Export changes for sync</button>
      <p class="small">Share the file to yourself (Mail, Messages or Save to Files), then send it to Grok Bot. ${le ? `Last export: ${esc(le.at.slice(0, 16).replace('T', ' '))}.` : ''}</p>
      ${changes.length ? '<button class="btn block" id="expAllBtn">Re-export all changes made on this phone</button>' : ''}
    </div>
    <div class="card"><h2>Backup</h2><p class="small">A full copy of everything on this phone, including your photos. Keep one in Files in case the phone's data is cleared.</p>
      <button class="btn block" id="bakBtn">Export full backup</button></div>
    <div class="card"><h2>Import</h2><p class="small">Import an updated data file from Grok Bot, or restore a backup. Unsynced changes are kept.</p>
      <button class="btn block" id="impBtn2">Import data file</button></div>
    <div class="card"><h2>This phone</h2>
      <p class="small">${bi ? `Data file from ${esc(String(bi.generated_at || '').slice(0, 16).replace('T', ' '))} · imported ${esc(String(bi.imported_at || '').slice(0, 16).replace('T', ' '))}` : 'No data imported yet.'}<br>
      ${state.items.size} items · ${nPhotos} phone photos · ${est}${persisted ? ' · storage protected' : ''}<br>App ${APP_VERSION}</p>
      ${installHint()}</div>
    ${changes.length ? `<div class="card"><h2>Change log</h2><div class="log">${changes.slice(0, 150).map(logLine).join('')}</div></div>` : ''}
    <div class="card"><h2>Erase</h2><p class="small">Remove all inventory data and photos from this phone.</p><button class="btn danger block" id="wipeBtn">Erase data on this phone</button></div>`;
  $('#expBtn').onclick = (e) => doExport('unsynced', e.currentTarget);
  const ea = $('#expAllBtn'); if (ea) ea.onclick = (e) => doExport('all', e.currentTarget);
  $('#bakBtn').onclick = (e) => doExport('backup', e.currentTarget);
  $('#impBtn2').onclick = () => $('#dataFile').click();
  $('#wipeBtn').onclick = async () => {
    if (!confirm(pending.length ? `You have ${pending.length} unsynced changes that will be lost. Erase everything?` : 'Erase all data on this phone?')) return;
    if (!confirm('This cannot be undone. Erase now?')) return;
    const t = tx(['meta', 'base', 'items', 'thumbs', 'photos', 'changes'], 'readwrite');
    for (const s of ['meta', 'base', 'items', 'thumbs', 'photos', 'changes']) t.objectStore(s).clear();
    await done(t); await loadAll(); toast('Erased'); go('#/'); route();
  };
  window.scrollTo(0, 0);
}

/* ---------------- boot ---------------- */
$('#backBtn').onclick = () => { if (history.length > 1) history.back(); else go('#/'); };
$('#syncBtn').onclick = () => { leaveHome(); go('#/sync'); };
$('#addBtn').onclick = () => { leaveHome(); go('#/add'); };
window.addEventListener('hashchange', route);
(async function boot() {
  try {
    state.db = await openDB(); await loadAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    route();
  } catch (e) { view().innerHTML = `<div class="card"><h2>Can’t open storage</h2><p>${esc(e.message)}</p><p class="small">Private Browsing blocks storage. Open RT Inventory in normal Safari or from the home screen.</p></div>`; }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
})();

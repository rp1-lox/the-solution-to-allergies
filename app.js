'use strict';

const RESULTS_PATH = 'data/results.json';
const KEYS = { results: 'as-results', gh: 'as-gh', dirty: 'as-dirty', cat: 'as-cat' };

const STATUSES = {
  reaction: { label: 'Reaction', dir: 'left' },
  intolerance: { label: 'Intolerance', dir: 'up' },
  safe: { label: 'Safe', dir: 'right' },
  untried: { label: 'Not tried', dir: 'down' },
};
const DIR_TO_STATUS = { left: 'reaction', right: 'safe', up: 'intolerance', down: 'untried' };
const SYMPTOMS = {
  hives: 'Hives', itching: 'Itching', rash: 'Rash', acne: 'Acne / pimples', swelling: 'Swelling',
  throat: 'Throat tightness', breathing: 'Trouble breathing', stomach: 'Stomach pain',
  nausea: 'Nausea / vomiting', diarrhea: 'Diarrhea', bloating: 'Bloating', headache: 'Headache',
  anaphylaxis: 'Anaphylaxis',
};
const SWIPE_THRESHOLD = 90;

let ingredients = [];
let results = {};          // id -> { status, symptoms, note, updated }; status null = cleared
let history = [];          // undo stack: { id, prev }
let busy = false;          // card animating out
let dragging = false;
let sheetId = null;
let rev = 0;               // bumps on every local change
let syncing = false;
let syncAgain = false;
let saveTimer = null;
let listFilter = 'all';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- storage ----------

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function ghConfig() {
  const saved = readLS(KEYS.gh, {});
  // Default to the repo this page is served from on GitHub Pages.
  const host = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repoFromPath = location.pathname.split('/').filter(Boolean)[0];
  return {
    owner: saved.owner || (host ? host[1] : 'rp1-lox'),
    repo: saved.repo || (host && repoFromPath ? repoFromPath : 'the-solution-to-allergies'),
    branch: saved.branch || 'main',
    token: saved.token || '',
  };
}
const hasToken = () => !!ghConfig().token;

function isDirty() { return readLS(KEYS.dirty, false); }
function setDirty(v) { writeLS(KEYS.dirty, v); }

function merge(a, b) {
  // Per ingredient, the newer entry wins; ties go to b.
  const out = { ...a };
  for (const [id, entry] of Object.entries(b || {})) {
    if (!out[id] || (entry.updated || 0) >= (out[id].updated || 0)) out[id] = entry;
  }
  return out;
}

function serialize(items) {
  const sorted = {};
  for (const id of Object.keys(items).sort()) sorted[id] = items[id];
  return JSON.stringify({ version: 1, items: sorted }, null, 1) + '\n';
}

// ---------- GitHub ----------

const b64encode = (s) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function ghRequest(method, body) {
  const { owner, repo, branch, token } = ghConfig();
  let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${RESULTS_PATH}`;
  if (method === 'GET') url += `?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ghLoad() {
  try {
    const j = await ghRequest('GET');
    return { sha: j.sha, items: JSON.parse(b64decode(j.content)).items || {} };
  } catch (e) {
    if (e.status === 404) return { sha: null, items: {} };
    throw e;
  }
}

async function sync() {
  if (!hasToken()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  clearTimeout(saveTimer);
  setSync('pending', 'Syncing…');
  try {
    for (let attempt = 0; ; attempt++) {
      const startRev = rev;
      const remote = await ghLoad();
      const before = serialize(results);
      results = merge(remote.items, results);
      if (serialize(results) !== before) { writeLS(KEYS.results, results); render(); }
      if (!isDirty()) break;
      if (serialize(results) === serialize(remote.items)) { if (rev === startRev) setDirty(false); break; }
      try {
        const answered = Object.values(results).filter((r) => r.status).length;
        await ghRequest('PUT', {
          message: `Update allergy results (${answered} answered)`,
          content: b64encode(serialize(results)),
          branch: ghConfig().branch,
          ...(remote.sha ? { sha: remote.sha } : {}),
        });
        if (rev === startRev) setDirty(false);
        break;
      } catch (e) {
        // Someone else wrote in between; reload and retry once.
        if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
        throw e;
      }
    }
    setSync(isDirty() ? 'pending' : 'ok', isDirty() ? 'Unsaved' : 'Saved to GitHub');
  } catch (e) {
    setSync('err', e.status === 401 ? 'Bad token' : 'Sync failed');
    console.error(e);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSave(0); }
  }
}

function scheduleSave(delay = 5000) {
  if (!hasToken()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(sync, delay);
}

function setSync(kind, text) {
  const el = $('#sync');
  el.className = `sync ${kind}`;
  el.textContent = text;
}

// ---------- state changes ----------

function setResult(id, entry) {
  results[id] = { ...entry, updated: Date.now() };
  rev++;
  writeLS(KEYS.results, results);
  setDirty(true);
  if (hasToken()) { setSync('pending', 'Unsaved'); scheduleSave(); }
}

const statusOf = (id) => results[id]?.status || null;

// ---------- swipe ----------

function deckItems() {
  const cat = $('#deck-cat').value;
  return ingredients.filter((i) => !statusOf(i.id) && (cat === 'all' || i.category === cat));
}

function renderCategorySelect() {
  const sel = $('#deck-cat');
  const current = sel.value || readLS(KEYS.cat, 'all');
  const remaining = (cat) => ingredients.filter((i) => !statusOf(i.id) && (cat === 'all' || i.category === cat)).length;
  const cats = [...new Set(ingredients.map((i) => i.category))];
  sel.innerHTML = [`<option value="all">All categories (${remaining('all')})</option>`]
    .concat(cats.map((c) => `<option value="${esc(c)}">${esc(c)} (${remaining(c)})</option>`)).join('');
  sel.value = [...sel.options].some((o) => o.value === current) ? current : 'all';
}

function cardHTML(item, behind) {
  const tags = item.tags.map((t) => `<span class="tag">${esc(t.replace('-', ' '))}</span>`).join('');
  return `<div class="card${behind ? ' behind' : ''}" data-id="${esc(item.id)}">
    <span class="stamp left">Reaction</span><span class="stamp right">Safe</span>
    <span class="stamp up">Intolerance</span><span class="stamp down">Not tried</span>
    <div class="cat">${esc(item.category)}</div>
    <div class="name">${esc(item.name)}</div>
    <div class="tags">${tags}</div>
  </div>`;
}

function renderDeck() {
  if (dragging || busy) return;
  const items = deckItems();
  const deck = $('#deck');
  deck.innerHTML = items.slice(0, 2).reverse().map((it, i, arr) => cardHTML(it, arr.length === 2 && i === 0)).join('');
  $('#empty').hidden = items.length > 0;
  $('#deck-count').textContent = `${items.length} left`;
  const top = topCard();
  if (top) attachDrag(top);
}

const topCard = () => $('#deck .card:not(.behind)');

function dirFrom(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > SWIPE_THRESHOLD ? 'right' : dx < -SWIPE_THRESHOLD ? 'left' : null;
  return dy < -SWIPE_THRESHOLD ? 'up' : dy > SWIPE_THRESHOLD ? 'down' : null;
}

function showStamp(card, dx, dy) {
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const dir = horiz ? (dx > 0 ? 'right' : 'left') : (dy < 0 ? 'up' : 'down');
  const strength = Math.min(1, (horiz ? Math.abs(dx) : Math.abs(dy)) / SWIPE_THRESHOLD);
  card.querySelectorAll('.stamp').forEach((s) => { s.style.opacity = s.classList.contains(dir) ? strength : 0; });
}

function attachDrag(card) {
  let pid = null, sx = 0, sy = 0, dx = 0, dy = 0;
  card.addEventListener('pointerdown', (e) => {
    if (busy || (e.button && e.button !== 0)) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    card.setPointerCapture(pid);
    card.classList.add('dragging');
    dragging = true;
  });
  card.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    showStamp(card, dx, dy);
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    dragging = false;
    card.classList.remove('dragging');
    const dir = dirFrom(dx, dy);
    if (dir) fling(card, dir);
    else { card.style.transform = ''; showStamp(card, 0, 0); }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function fling(card, dir) {
  if (!card || busy) return;
  busy = true;
  const id = card.dataset.id;
  const w = innerWidth, h = innerHeight;
  const [x, y] = { left: [-w, 0], right: [w, 0], up: [0, -h], down: [0, h] }[dir];
  showStamp(card, x, y);
  card.style.transform = `translate(${x}px, ${y}px) rotate(${x / 30}deg)`;
  card.style.opacity = '0';
  setTimeout(() => { busy = false; answer(id, DIR_TO_STATUS[dir]); }, 220);
}

function answer(id, status) {
  history.push({ id, prev: results[id] });
  setResult(id, { status, symptoms: [], note: '' });
  $('#undo').disabled = false;
  closeSheet();
  if (status === 'reaction' || status === 'intolerance') openSheet(id);
  render();
}

function undo() {
  const last = history.pop();
  if (!last) return;
  setResult(last.id, last.prev?.status ? last.prev : { status: null });
  $('#undo').disabled = history.length === 0;
  closeSheet();
  // Put the undone card back on top even if it's in another category.
  const item = ingredients.find((i) => i.id === last.id);
  if (item && $('#deck-cat').value !== 'all' && $('#deck-cat').value !== item.category) $('#deck-cat').value = 'all';
  render();
}

function chipsHTML(map, selected) {
  return Object.entries(map).map(([k, label]) =>
    `<button type="button" class="chip" data-key="${k}" aria-pressed="${selected.includes(k)}">${esc(label)}</button>`).join('');
}

function openSheet(id) {
  sheetId = id;
  const item = ingredients.find((i) => i.id === id);
  $('#sheet-title').textContent = `${item.name}: what happened?`;
  $('#sheet-symptoms').innerHTML = chipsHTML(SYMPTOMS, results[id].symptoms || []);
  $('#sheet-note').value = results[id].note || '';
  $('#sheet').hidden = false;
}
function closeSheet() { sheetId = null; $('#sheet').hidden = true; }

// ---------- list ----------

function renderSummary() {
  const counts = { reaction: 0, intolerance: 0, safe: 0, untried: 0 };
  for (const i of ingredients) { const s = statusOf(i.id); if (s) counts[s]++; }
  $('#summary').innerHTML = Object.entries(STATUSES).map(([k, s]) =>
    `<div class="stat"><b class="${k}-c">${counts[k]}</b><small>${s.label}</small></div>`).join('');
}

function renderFilter() {
  const opts = { all: 'All', ...Object.fromEntries(Object.entries(STATUSES).map(([k, s]) => [k, s.label])), none: 'Unanswered' };
  $('#status-filter').innerHTML = Object.entries(opts).map(([k, label]) =>
    `<button type="button" class="chip" data-key="${k}" aria-pressed="${listFilter === k}">${label}</button>`).join('');
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const groups = new Map();
  for (const item of ingredients) {
    const s = statusOf(item.id);
    if (listFilter === 'none' ? s : listFilter !== 'all' && s !== listFilter) continue;
    const hay = `${item.name} ${item.category} ${item.tags.join(' ')}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  if (!groups.size) { $('#list').innerHTML = '<p class="muted">No matches.</p>'; return; }
  $('#list').innerHTML = [...groups].map(([cat, items]) => `<div class="group"><h3>${esc(cat)}</h3>${items.map((item) => {
    const r = results[item.id];
    const detail = r?.status
      ? [STATUSES[r.status].label, ...(r.symptoms || []).map((k) => SYMPTOMS[k]), r.note].filter(Boolean).join(' · ')
      : 'Unanswered';
    return `<button class="item" data-id="${esc(item.id)}"><span class="dot ${r?.status || ''}"></span>
      <span class="grow">${esc(item.name)}<small>${esc(detail)}</small></span></button>`;
  }).join('')}</div>`).join('');
}

function openEdit(id) {
  const item = ingredients.find((i) => i.id === id);
  const r = results[id] || {};
  const dlg = $('#edit');
  dlg.dataset.id = id;
  dlg.returnValue = '';
  $('#edit-title').textContent = item.name;
  $('#edit-meta').textContent = [item.category, ...item.tags].join(' · ');
  $('#edit-status').innerHTML = chipsHTML(Object.fromEntries(Object.entries(STATUSES).map(([k, s]) => [k, s.label])), r.status ? [r.status] : []);
  $('#edit-symptoms').innerHTML = chipsHTML(SYMPTOMS, r.symptoms || []);
  $('#edit-note').value = r.note || '';
  dlg.showModal();
}

function closeEdit() {
  const dlg = $('#edit');
  const id = dlg.dataset.id;
  const pressed = (sel) => [...document.querySelectorAll(`${sel} .chip[aria-pressed="true"]`)].map((b) => b.dataset.key);
  if (dlg.returnValue === 'save') {
    const status = pressed('#edit-status')[0] || null;
    setResult(id, { status, symptoms: pressed('#edit-symptoms'), note: $('#edit-note').value.trim() });
  } else if (dlg.returnValue === 'clear') {
    setResult(id, { status: null });
  }
  render();
}

// ---------- settings ----------

function fillSettings() {
  const cfg = ghConfig();
  const f = $('#gh-form');
  for (const k of ['owner', 'repo', 'branch']) f.elements[k].value = cfg[k];
  f.elements.token.value = '';
  f.elements.token.placeholder = cfg.token ? 'Token saved (enter a new one to replace)' : 'github_pat_...';
}

function exportJSON() {
  const blob = new Blob([serialize(results)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'allergy-results.json' });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    results = merge(results, data.items || {});
    rev++;
    writeLS(KEYS.results, results);
    setDirty(true);
    render();
    scheduleSave(0);
    $('#gh-msg').textContent = 'Imported.';
  } catch {
    $('#gh-msg').textContent = 'Could not read that file.';
  }
}

// ---------- wiring ----------

function render() {
  renderCategorySelect();
  renderDeck();
  renderSummary();
  renderFilter();
  renderList();
}

function showView(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  if (name === 'settings') fillSettings();
}

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#deck-cat').addEventListener('change', (e) => { writeLS(KEYS.cat, e.target.value); renderDeck(); });
  document.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => fling(topCard(), b.dataset.dir)));
  $('#undo').addEventListener('click', undo);

  document.addEventListener('keydown', (e) => {
    if ($('#view-swipe').hidden || $('#edit').open || e.target.matches('input, select, textarea')) return;
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    if (dir) { e.preventDefault(); fling(topCard(), dir); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); undo(); }
  });

  $('#sheet-symptoms').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || !sheetId) return;
    chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
    const symptoms = [...$('#sheet-symptoms').querySelectorAll('[aria-pressed="true"]')].map((c) => c.dataset.key);
    setResult(sheetId, { ...results[sheetId], symptoms });
    renderList();
  });
  $('#sheet-note').addEventListener('input', (e) => {
    if (!sheetId) return;
    setResult(sheetId, { ...results[sheetId], note: e.target.value });
  });
  $('#sheet-note').addEventListener('change', renderList);
  $('#sheet-done').addEventListener('click', closeSheet);

  $('#search').addEventListener('input', renderList);
  $('#status-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    listFilter = chip.dataset.key;
    renderFilter();
    renderList();
  });
  $('#list').addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) openEdit(it.dataset.id); });

  $('#edit-status').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    $('#edit-status').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    chip.setAttribute('aria-pressed', on);
  });
  $('#edit-symptoms').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
  });
  $('#edit').addEventListener('close', closeEdit);

  $('#gh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const prev = ghConfig();
    writeLS(KEYS.gh, {
      owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim(),
      token: f.token.value.trim() || prev.token,
    });
    fillSettings();
    if (!hasToken()) { $('#gh-msg').textContent = 'Saved. Add a token to sync.'; return; }
    $('#gh-msg').textContent = 'Connecting…';
    try {
      await ghLoad();
      $('#gh-msg').textContent = 'Connected.';
      setDirty(true);
      sync();
    } catch (err) {
      $('#gh-msg').textContent = err.message;
      setSync('err', 'Sync failed');
    }
  });
  $('#gh-sync').addEventListener('click', () => (hasToken() ? sync() : ($('#gh-msg').textContent = 'Add a token first.')));
  $('#gh-forget').addEventListener('click', () => {
    writeLS(KEYS.gh, { ...ghConfig(), token: '' });
    fillSettings();
    setSync('', 'Local only');
    $('#gh-msg').textContent = 'Token removed from this browser.';
  });
  $('#export').addEventListener('click', exportJSON);
  $('#import').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isDirty() && hasToken()) sync();
  });
}

async function init() {
  wire();
  ingredients = await (await fetch('data/ingredients.json', { cache: 'no-store' })).json();
  results = readLS(KEYS.results, {});
  render();

  if (hasToken()) {
    sync();
  } else {
    // Read-only: pick up whatever is committed in the repo.
    try {
      const committed = await (await fetch(RESULTS_PATH, { cache: 'no-store' })).json();
      results = merge(committed.items || {}, results);
      writeLS(KEYS.results, results);
      render();
    } catch { /* no committed results yet */ }
    setSync('', 'Local only');
  }
}

init();

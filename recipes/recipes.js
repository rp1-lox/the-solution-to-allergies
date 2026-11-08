'use strict';

// Recipe viewer. Checks each ingredient against the same answers the main app uses:
// data/results.json in the repo, merged with anything newer saved in this browser.

const LS_RESULTS = 'as-results';   // same key as ../app.js
const LS_UNITS = 'rc-units';
const STATUS_LABEL = { reaction: 'Reaction', intolerance: 'Intolerance', safe: 'Safe', untried: 'Not tried' };
const RANK = { safe: 0, neutral: 0, ask: 1, avoid: 2 };

let data = null;
let names = {};      // ingredient id -> display name
let results = {};    // ingredient id -> { status, updated }
let units = 'us';

const $app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function merge(a, b) {
  const out = { ...a };
  for (const [id, entry] of Object.entries(b || {})) {
    if (!out[id] || (entry.updated || 0) >= (out[id].updated || 0)) out[id] = entry;
  }
  return out;
}

// ---------- checking ----------

const statusOf = (id) => (results[id] && results[id].status) || null;
function levelOf(status) {
  if (status === 'reaction' || status === 'intolerance') return 'avoid';
  if (status === 'safe') return 'safe';
  return 'ask'; // not tried, or not on the list at all
}

// Returns { level, status } for one ingredient line.
function checkItem(item) {
  if (!item.ids || !item.ids.length) return { level: 'neutral', status: null };
  const entries = item.ids.map((id) => ({ status: statusOf(id), level: levelOf(statusOf(id)) }));
  entries.sort((x, y) => RANK[x.level] - RANK[y.level]);
  // "any": one of the options is enough (e.g. lard OR olive oil), so take the best.
  return item.any ? entries[0] : entries[entries.length - 1];
}

function checkRecipe(items, safeText = 'Every ingredient is on your safe list') {
  const avoid = [], ask = [];
  for (const item of items) {
    if (item.optional) continue; // shown with its own dot, but doesn't decide the verdict
    const { level } = checkItem(item);
    if (level === 'avoid') avoid.push(item.item);
    else if (level === 'ask') ask.push(item.item);
  }
  if (avoid.length) return { level: 'avoid', text: `Contains something you avoid: ${avoid.join(', ')}` };
  if (ask.length) return { level: 'ask', text: `${ask.length} not tried yet: ${ask.join(', ')}` };
  return { level: 'safe', text: safeText };
}

const allItems = (r) => r.groups.flatMap((g) => g.items);
const badge = (v) => `<span class="badge ${v.level}">${v.level === 'safe' ? '✓' : v.level === 'ask' ? '?' : '✕'} ${esc(v.text)}</span>`;

// ---------- rendering ----------

const amazonUrl = (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
const FACILITY = {
  confirmed: 'Maker confirms an allergen-free facility',
  partial: 'Facility partly confirmed',
  unknown: 'Facility not confirmed: ask the maker',
};

function ingRow(item, checksById) {
  const { status } = checkItem(item);
  const dot = item.ids && item.ids.length ? (status || 'untried') : 'neutral';
  const qty = units === 'g' ? item.g : item.us;
  const listed = (item.ids || []).map((id) => `${names[id] || id}: ${STATUS_LABEL[statusOf(id)] || 'Not on your list'}`);
  const listLine = item.listNote || (listed.length ? `Your list: ${listed.join(item.any ? ' or ' : ' · ')}` : 'Plain ingredient, not on your list');
  const check = item.check && checksById[item.check];
  const shop = item.buy && data.shopping && data.shopping[item.buy];
  const inner = `
    <span class="dot ${dot}"></span>
    <span class="line">${qty ? `<b>${esc(qty)}</b>` : ''}${esc(item.item)}</span>
    <small>${esc(listLine)}</small>
    ${item.note ? `<small>${esc(item.note)}</small>` : ''}
    ${check ? `<small class="warn">Label check: ${esc(check.title)}</small>` : ''}
    ${shop ? `<small class="shop">Amazon: ${esc(shop.pick)} ↗</small>
    ${shop.confidence || shop.facility ? `<small class="facility ${esc(shop.confidence)}">${[FACILITY[shop.confidence], shop.facility].filter(Boolean).map(esc).join('. ')}</small>` : ''}` : ''}`;
  return shop
    ? `<a class="ing buy" href="${esc(amazonUrl(shop.query))}" target="_blank" rel="noopener" title="Search Amazon for ${esc(shop.pick)}">${inner}</a>`
    : `<div class="ing">${inner}</div>`;
}

function renderList() {
  const cards = data.recipes.map((r) => `
    <a class="rcard" href="#${esc(r.id)}">
      <img src="${esc(r.image)}" alt="" width="480" height="300">
      <div class="body">
        <span class="kind">${esc(r.kind)}</span>
        <h2>${esc(r.title)}</h2>
        <p class="muted">${esc(r.summary)}</p>
        ${badge(checkRecipe(allItems(r)))}
      </div>
    </a>`).join('');

  const store = data.storeBought.map((s) => {
    const v = s.items.length ? badge(checkRecipe(s.items, 'Listed ingredients are on your safe list')) : '<span class="badge avoid">✕ Not recommended</span>';
    const rows = s.items.map((i) => ingRow(i, {})).join('');
    return `<div class="store">
      <span class="kind">${esc(s.kind)}</span>
      <h3>${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</h3>
      ${v}
      <p>${esc(s.text)}</p>
      ${s.ask ? `<p class="muted">${esc(s.ask)}</p>` : ''}
      ${s.buy && data.shopping[s.buy] ? `<p><a href="${esc(amazonUrl(data.shopping[s.buy].query))}" target="_blank" rel="noopener">Search Amazon ↗</a></p>` : ''}
      ${rows ? `<details><summary>Ingredients</summary>${rows}</details>` : ''}
    </div>`;
  }).join('');

  $app.innerHTML = `
    <p class="intro muted">Yeast-free, rice-based recipes checked live against your answers in Allergy Swipe. Change an answer there and these update.</p>
    ${cards}
    <h2 class="section-title">Store-bought</h2>
    ${store}
    <h2 class="section-title">Sources</h2>
    <ul class="sources">${data.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul>`;
}

function renderRecipe(r) {
  const checksById = Object.fromEntries(data.labelChecks.map((c) => [c.id, c]));
  const groups = r.groups.map((g) => `
    <div class="ing-group">
      <h3>${esc(g.name)}</h3>
      ${g.items.map((i) => ingRow(i, checksById)).join('')}
    </div>`).join('');
  const steps = r.steps.map((s) => `
    <li><p>${esc(s.text)}</p>${s.image ? `<img src="${esc(s.image)}" alt="" width="240" height="160" loading="lazy">` : ''}</li>`).join('');
  const checks = r.checks.map((id) => checksById[id]).filter(Boolean)
    .map((c) => `<div class="check"><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div>`).join('');

  $app.innerHTML = `
    <div class="detail">
      <a class="back" href="#">← All recipes</a>
      <img class="hero" src="${esc(r.image)}" alt="" width="480" height="300">
      <h2>${esc(r.title)}</h2>
      <p class="muted" style="margin:0">${esc(r.summary)}</p>
      <div class="meta">${badge(checkRecipe(allItems(r)))}<span class="muted">${esc(r.yield)}</span></div>

      <h2 class="section-title">Ingredients</h2>
      <div class="units" role="group" aria-label="Units">
        <button data-units="us" aria-pressed="${units === 'us'}">Cups</button>
        <button data-units="g" aria-pressed="${units === 'g'}">Grams</button>
      </div>
      <div class="legend">
        <span><i class="dot safe"></i>Safe</span><span><i class="dot untried"></i>Not tried</span>
        <span><i class="dot reaction"></i>Reaction</span><span><i class="dot intolerance"></i>Intolerance</span>
        <span><i class="dot neutral" style="background:none;border:2px solid var(--border)"></i>Plain (water, salt)</span>
      </div>
      ${groups}

      <h2 class="section-title">Steps</h2>
      <ol class="steps">${steps}</ol>

      <h2 class="section-title">Label checks</h2>
      <div class="checks">${checks}</div>

      ${r.tips && r.tips.length ? `<h2 class="section-title">Tips</h2><ul class="tips">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <p class="foot muted">Tap an ingredient with an Amazon line to search Amazon for the brand picked for it. Results include other brands, so make sure the one you buy is the picked brand and re-read its label. Colors come from your answers in Allergy Swipe. A green dot means the ingredient is safe for you, not that every brand is. Read the label checks above.</p>
    </div>`;

  $app.querySelectorAll('[data-units]').forEach((b) => b.addEventListener('click', () => {
    units = b.dataset.units;
    writeLS(LS_UNITS, units);
    renderRecipe(r);
  }));
}

function route() {
  const ALIASES = { 'rice-loaf': 'rice-sub-rolls' }; // old link from before the loaf was replaced
  const raw = decodeURIComponent(location.hash.slice(1));
  const id = ALIASES[raw] || raw;
  const r = data.recipes.find((x) => x.id === id);
  if (r) { renderRecipe(r); document.title = `${r.title} · Recipes`; }
  else { renderList(); document.title = 'Safe Recipes'; }
  window.scrollTo(0, 0);
}

async function init() {
  units = readLS(LS_UNITS, 'us') === 'g' ? 'g' : 'us';
  try {
    const [recipes, ingredients] = await Promise.all([
      fetch('recipes.json', { cache: 'no-store' }).then((r) => r.json()),
      fetch('../data/ingredients.json', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    data = recipes;
    names = Object.fromEntries(ingredients.map((i) => [i.id, i.name]));
  } catch {
    $app.innerHTML = '<p>Couldn’t load the recipes. Try reloading.</p>';
    return;
  }
  let committed = {};
  try { committed = (await (await fetch('../data/results.json', { cache: 'no-store' })).json()).items || {}; } catch { /* none committed */ }
  results = merge(committed, readLS(LS_RESULTS, {}));

  route();
  window.addEventListener('hashchange', route);
}

init();

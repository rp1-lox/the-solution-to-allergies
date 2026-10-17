'use strict';

// ---------- engine (also runs in Node for tests) ----------

const Checker = (() => {
  const TRACE_RE = /(may contain|may also contain|may be present|traces? of|(?:processed|manufactured|made|produced|packaged|prepared) (?:in|on|with) (?:a )?(?:facility|shared equipment|equipment|the same equipment)|shared equipment|same equipment|cross[- ]contact)[^.\n]*/gi;

  const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`´]/g, '').replace(/[-/_]/g, ' ').replace(/\s+/g, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function variants(p) {
    const v = new Set([p, `${p}s`, `${p}es`]);
    if (/[^aeiou]y$/.test(p)) v.add(`${p.slice(0, -1)}ies`);
    return v;
  }

  function build(ingredients, rules) {
    const pats = new Map();
    const add = (phrase, entry, override) => {
      for (const v of variants(norm(phrase))) if (override || !pats.has(v)) pats.set(v, entry);
    };
    for (const i of ingredients) add(i.name, { is: [i.id] });
    for (const r of rules.rules) for (const m of r.match) add(m, r, true);
    for (const n of rules.neutral) add(n, { neutral: true }, true);
    const list = [...pats]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([p, entry]) => ({ p, entry, re: new RegExp(`(?<![a-z0-9])${escapeRe(p)}(?![a-z0-9])`, 'g') }));
    return { list, noise: new Set(rules.noise.map(norm)) };
  }

  // Longest phrases first; a matched span can't be reused by a shorter phrase
  // (so "coconut milk" never also counts as "milk").
  function matchAll(ctx, text) {
    const masked = Array(text.length).fill(false);
    const out = [];
    for (const { p, entry, re } of ctx.list) {
      if (!text.includes(p)) continue;
      re.lastIndex = 0;
      for (let m; (m = re.exec(text));) {
        const end = m.index + p.length;
        if (masked.slice(m.index, end).some(Boolean)) continue;
        masked.fill(true, m.index, end);
        out.push({ phrase: p, entry, at: m.index });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  function clean(token) {
    return norm(token)
      .replace(/\d+(\.\d+)?\s*%/g, ' ')
      .replace(/\b(or less of|or less|less than)\b/g, ' ')
      .replace(/^(contains|contain|ingredients?)\b/, ' ')
      .replace(/^\s*(and or|and|or|with|plus|of)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  }

  function split(text) {
    const trace = [];
    const main = text.replace(TRACE_RE, (m) => { trace.push(m); return ' . '; });
    const tokens = (s) => s.split(/[,;:()[\]{}.\n•*]+/).map(clean).filter(Boolean);
    return { main: tokens(main), trace: trace.map(clean).filter(Boolean) };
  }

  // statusOf(id) -> 'reaction' | 'intolerance' | 'safe' | 'untried' | null
  function level(entry, statusOf) {
    const each = entry.is.map((id) => {
      if (id === '?') return { id, v: 'unknown' };
      const s = statusOf(id);
      return { id, s, v: s === 'reaction' || s === 'intolerance' ? 'no' : s === 'safe' ? 'ok' : 'unknown' };
    });
    const vs = each.map((e) => e.v);
    let v;
    if (entry.any) v = vs.every((x) => x === 'no') ? 'no' : vs.every((x) => x === 'ok') ? 'ok' : 'caution';
    else v = vs.includes('no') ? 'no' : vs.every((x) => x === 'ok') ? 'ok' : 'caution';
    return { v, each };
  }

  function check(ctx, text, statusOf) {
    const { main, trace } = split(text);
    const items = [];
    const seen = new Set();
    const push = (item) => {
      const key = `${item.kind}|${item.phrase || item.text}`;
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    };
    for (const tok of main) {
      if (ctx.noise.has(tok)) continue;
      const ms = matchAll(ctx, tok);
      if (!ms.length) { push({ kind: 'main', text: tok, v: 'caution', unknown: true }); continue; }
      for (const m of ms) {
        if (m.entry.neutral) { push({ kind: 'main', text: tok, phrase: m.phrase, v: 'ignore' }); continue; }
        push({ kind: 'main', text: tok, phrase: m.phrase, entry: m.entry, ...level(m.entry, statusOf) });
      }
    }
    for (const tok of trace) {
      for (const m of matchAll(ctx, tok)) {
        if (m.entry.neutral) continue;
        const l = level(m.entry, statusOf);
        // Only warn about cross-contact with things you actually avoid.
        if (l.each.some((e) => e.v === 'no')) push({ kind: 'trace', text: tok, phrase: m.phrase, entry: m.entry, ...l, v: 'caution' });
      }
    }
    const overall = items.some((i) => i.v === 'no') ? 'no' : items.some((i) => i.v === 'caution') ? 'caution' : items.length ? 'ok' : null;
    return { overall, items };
  }

  return { build, check, norm };
})();

if (typeof module !== 'undefined') module.exports = Checker;

// ---------- UI ----------

if (typeof document !== 'undefined') {
  let ctx = null;
  let scanStop = null;
  const OFF_FIELDS = 'product_name,brands,ingredients_text_en,ingredients_text,allergens_tags,traces_tags';
  const VERDICT = {
    no: ['No', 'Contains something you avoid.'],
    caution: ['Caution', 'Nothing you avoid for sure, but some ingredients are unknown or vague.'],
    ok: ['Looks safe', 'Every ingredient is on your safe list.'],
  };

  const ready = fetch('data/rules.json', { cache: 'no-store' }).then((r) => r.json());

  async function ensureCtx() {
    if (!ctx && ingredients.length) ctx = Checker.build(ingredients, await ready);
    return ctx;
  }

  const nameOf = (id) => (id === '?' ? 'unknown source' : ingredients.find((i) => i.id === id)?.name || id);
  const labelOf = (s) => (s ? STATUSES[s].label : 'Unanswered');

  function itemHTML(it) {
    const single = it.entry && it.entry.is.length === 1 && it.entry.is[0] !== '?' ? it.entry.is[0] : null;
    let detail;
    if (it.unknown) detail = 'Not in your list';
    else if (it.v === 'ignore') detail = 'Not a food allergen';
    else {
      const parts = it.each.map((e) => `${nameOf(e.id)}${e.id === '?' ? '' : `: ${labelOf(e.s)}`}`);
      detail = (it.entry.any ? 'Could be ' : '') + parts.join(it.entry.any ? ' / ' : ', ');
      if (it.entry.note) detail += `. ${it.entry.note}`;
      if (it.kind === 'trace') detail = `May contain (shared equipment). ${detail}`;
    }
    const title = it.phrase && it.phrase !== it.text ? `${it.text} → ${it.phrase}` : it.text;
    const tag = single ? `button class="item" data-id="${esc(single)}"` : 'div class="item static"';
    return `<${tag}><span class="dot ${{ no: 'reaction', caution: 'intolerance', ok: 'safe' }[it.v] || ''}"></span>
      <span class="grow">${esc(title)}<small>${esc(detail)}</small></span></${single ? 'button' : 'div'}>`;
  }

  async function runCheck() {
    const text = $('#check-text').value;
    const out = $('#check-result');
    if (!text.trim()) { out.innerHTML = ''; return; }
    if (!(await ensureCtx())) return;
    const { overall, items } = Checker.check(ctx, text, statusOf);
    if (!overall) { out.innerHTML = ''; return; }
    const groups = [
      ['no', 'Avoid', items.filter((i) => i.v === 'no')],
      ['caution', 'Check', items.filter((i) => i.v === 'caution')],
      ['ok', 'Safe', items.filter((i) => i.v === 'ok')],
      ['ignore', 'Ignored', items.filter((i) => i.v === 'ignore')],
    ].filter(([, , list]) => list.length);
    out.innerHTML = `<div class="verdict ${overall}"><b>${VERDICT[overall][0]}</b><span>${VERDICT[overall][1]}</span></div>` +
      groups.map(([k, title, list]) => {
        const body = list.map(itemHTML).join('');
        return k === 'ok' || k === 'ignore'
          ? `<details class="group"><summary>${title} (${list.length})</summary>${body}</details>`
          : `<div class="group"><h3>${title} (${list.length})</h3>${body}</div>`;
      }).join('');
  }
  window.runCheck = runCheck;

  // ----- Open Food Facts -----

  async function lookup(code) {
    code = String(code).replace(/\D/g, '');
    if (!code) return;
    const msg = $('#check-msg');
    msg.textContent = 'Looking up…';
    $('#check-product').innerHTML = '';
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);
      const j = await res.json();
      const p = j.product;
      if (j.status !== 1 || !p) {
        msg.innerHTML = `Not found in Open Food Facts. Paste the ingredient list instead, or <a href="https://world.openfoodfacts.org/cgi/product.pl?type=add&code=${code}" target="_blank" rel="noopener">add it</a>.`;
        return;
      }
      const ingr = p.ingredients_text_en || p.ingredients_text || '';
      const tagWords = (tags) => (tags || []).map((t) => t.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ')).join(', ');
      let text = ingr;
      if (p.allergens_tags?.length) text += `\nAllergens: ${tagWords(p.allergens_tags)}.`;
      if (p.traces_tags?.length) text += `\nMay contain: ${tagWords(p.traces_tags)}.`;
      $('#check-text').value = text.trim();
      $('#check-product').innerHTML = `<a href="https://world.openfoodfacts.org/product/${code}" target="_blank" rel="noopener">${esc([p.product_name, p.brands].filter(Boolean).join(' · ') || code)}</a>`;
      msg.textContent = ingr ? '' : 'Found, but it has no ingredient list. Paste it from the package.';
      runCheck();
    } catch {
      msg.textContent = 'Lookup failed. Check your connection.';
    }
  }

  // ----- barcode scanning -----

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject });
      document.head.append(s);
    });
  }

  async function startScan() {
    const wrap = $('#scan');
    const video = $('#scan-video');
    const msg = $('#check-msg');
    msg.textContent = '';
    if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = 'No camera available. Type the barcode number instead.'; return; }
    wrap.hidden = false;
    const done = (code) => { stopScan(); lookup(code); };
    try {
      if ('BarcodeDetector' in window) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await video.play();
        const formats = await BarcodeDetector.getSupportedFormats();
        const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => formats.includes(f)) });
        let alive = true;
        scanStop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
        (async function loop() {
          while (alive) {
            const codes = await detector.detect(video).catch(() => []);
            if (codes.length) return done(codes[0].rawValue);
            await new Promise((r) => setTimeout(r, 200));
          }
        })();
      } else {
        if (!window.ZXing) await loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
        const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS,
          [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]]]);
        const reader = new ZXing.BrowserMultiFormatReader(hints);
        scanStop = () => reader.reset();
        await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (result) => {
          if (result) done(result.getText());
        });
      }
    } catch (e) {
      stopScan();
      msg.textContent = e.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Could not start the camera.';
    }
  }

  function stopScan() {
    if (scanStop) { scanStop(); scanStop = null; }
    $('#scan').hidden = true;
  }

  // ----- wiring -----

  let timer;
  $('#check-text').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runCheck, 250); });
  $('#check-clear').addEventListener('click', () => {
    $('#check-text').value = '';
    $('#check-product').innerHTML = '';
    $('#check-msg').textContent = '';
    runCheck();
  });
  $('#scan-start').addEventListener('click', startScan);
  $('#scan-stop').addEventListener('click', stopScan);
  $('#code-form').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#code').value); });
  $('#check-result').addEventListener('click', (e) => { const it = e.target.closest('button.item'); if (it) openEdit(it.dataset.id); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.view !== 'check') stopScan(); }));
}

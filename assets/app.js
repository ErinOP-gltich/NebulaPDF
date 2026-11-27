/* Nebula home page: the night-sky hero, tool grid and search, file routing and the tool screen.
   Theme, cursor and motion are in shell.js; tools themselves live in engine.js. */
let currentTool = null, uploadedFiles = [], lastFile = null, processed = 0;
const views = { dashboard: $('dashboard-view'), workspace: $('workspace-view') };

/* ---------- hero: a deep-field sky. Stars bend around the pointer like light around a mass; pages orbit
   the drop well and spiral into it while a file is dragged over the window. ---------- */
const ORBITS = [[.5, .3, '255,90,110', -.35, 1.2], [.72, .28, '255,181,71', .22, 1], [.98, .3, '47,224,208', -.12, .85], [1.28, .32, '139,124,255', .38, .6]];
const sky = (() => {
  const cv = $('sky'), ctx = cv.getContext('2d'), hero = cv.parentElement;
  let W = 0, H = 0, stars = [], pages = [], clouds = [], pull = 0, pullTo = 0, running = false, onScreen = true, comet = null;
  const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };
  const wellAt = () => { const r = $('well').getBoundingClientRect(), h = hero.getBoundingClientRect(); return { x: r.left - h.left + r.width / 2, y: r.top - h.top + r.height / 2 }; };

  function build() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    W = hero.clientWidth; H = hero.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // two cloud layers, painted once at quarter size; they drift with the pointer at different depths
    clouds = [
      [[.74, .4, .36, '255,90,110', .42], [.6, .64, .3, '255,181,71', .32], [.9, .72, .38, '47,224,208', .3], [.5, .26, .22, '130,100,255', .14]],
      [[.68, .5, .55, '255,120,90', .14], [.88, .28, .42, '47,224,208', .14], [.32, .78, .5, '255,181,71', .08]],
    ].map(blobs => {
      const c = document.createElement('canvas'), g = c.getContext('2d');
      c.width = Math.max(1, Math.ceil(W / 4)); c.height = Math.max(1, Math.ceil(H / 4));
      g.globalCompositeOperation = 'lighter';
      for (const [x, y, r, col, a] of blobs) {
        const R = r * Math.max(c.width, c.height), grad = g.createRadialGradient(x * c.width, y * c.height, 0, x * c.width, y * c.height, R);
        grad.addColorStop(0, `rgba(${col},${a})`); grad.addColorStop(.45, `rgba(${col},${a * .35})`); grad.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
      }
      g.globalCompositeOperation = 'destination-out'; // dark dust lanes
      for (let i = 0; i < 46; i++) {
        const x = Math.random() * c.width, y = Math.random() * c.height, R = Math.random() * c.width * .09 + 3, gr = g.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, 'rgba(0,0,0,.4)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(x - R, y - R, 2 * R, 2 * R);
      }
      return c;
    });
    const lite = W < 700 || matchMedia('(pointer: coarse)').matches;
    stars = Array.from({ length: Math.round(Math.min(lite ? 320 : 900, W * H / (lite ? 2200 : 1500))) }, () => ({
      x: Math.random() * W, y: Math.random() * H, z: Math.random() ** 2 * .9 + .1, p: Math.random() * 6.28,
      c: Math.random() < .14 ? (Math.random() < .5 ? 'rgb(255,205,150)' : 'rgb(160,240,232)') : 'rgb(236,240,255)',
    })).sort((a, b) => a.c < b.c ? -1 : 1);
    const span = Math.min(W, H);
    pages = Array.from({ length: W < 700 ? 7 : 12 }, () => ({
      a: Math.random() * 6.28, r: span * (.22 + Math.random() * .5), s: (Math.random() * .5 + .5) * (Math.random() < .5 ? -1 : 1),
      size: 14 + Math.random() * 20, rot: Math.random() * 6.28, vr: (Math.random() - .5) * .8, tilt: Math.random() * .45 + .35,
    }));
  }

  function page(x, y, s, rot, alpha) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = alpha;
    const w = s, h = s * 1.3, ear = s * .28;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2 - ear, -h / 2); ctx.lineTo(w / 2, -h / 2 + ear); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath();
    ctx.fillStyle = 'rgba(240,244,255,.07)'; ctx.fill();
    ctx.strokeStyle = 'rgba(240,244,255,.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(240,244,255,.32)';
    for (let i = 0; i < 4; i++) { const ly = -h / 2 + ear + 4 + i * (h - ear - 8) / 4; ctx.beginPath(); ctx.moveTo(-w / 2 + 4, ly); ctx.lineTo(w / 2 - 4 - (i === 3 ? w * .3 : 0), ly); ctx.stroke(); }
    ctx.restore();
  }

  function draw(now) {
    const t = now / 1000, c = wellAt();
    mouse.x += (mouse.tx - mouse.x) * .1; mouse.y += (mouse.ty - mouse.y) * .1;
    pull += (pullTo - pull) * .06;
    const near = mouse.x > -1000, px = near ? mouse.x / W - .5 : 0, py = near ? mouse.y / H - .5 : 0;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    clouds.forEach((cl, i) => {
      const d = 24 + i * 22, drift = Math.sin(t * .05 + i) * 10;
      ctx.drawImage(cl, -d - px * d + drift, -d - py * d, W + 2 * d, H + 2 * d);
    });
    // orbits: thin coloured arcs sweeping slowly around the drop well
    ctx.globalCompositeOperation = 'source-over';
    const span = Math.max(W, H) * .5;
    ORBITS.forEach(([k, flat, col, tilt, len], i) => {
      const a0 = t * .035 * (i % 2 ? 1 : -1) + i * 1.7, rx = span * k * (1 - pull * .3), ry = rx * flat;
      ctx.strokeStyle = `rgba(${col},.42)`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, tilt, a0, a0 + len * Math.PI); ctx.stroke();
      const ex = c.x + rx * Math.cos(a0 + len * Math.PI) * Math.cos(tilt) - ry * Math.sin(a0 + len * Math.PI) * Math.sin(tilt);
      const ey = c.y + rx * Math.cos(a0 + len * Math.PI) * Math.sin(tilt) + ry * Math.sin(a0 + len * Math.PI) * Math.cos(tilt);
      ctx.fillStyle = `rgba(${col},.95)`; ctx.beginPath(); ctx.arc(ex, ey, 2.4, 0, 7); ctx.fill();
    });
    ctx.globalCompositeOperation = 'lighter';
    let col = '';
    for (const s of stars) {
      let x = s.x - px * 40 * s.z, y = s.y - py * 26 * s.z;
      if (pull > .01) { // accretion: everything swirls toward the well
        const ax = x - c.x, ay = y - c.y, dist = Math.hypot(ax, ay), ang = Math.atan2(ay, ax) + pull * (t * .9 + 500 / (dist + 60)), nd = dist * (1 - pull * .45);
        x = c.x + Math.cos(ang) * nd; y = c.y + Math.sin(ang) * nd;
      }
      if (near) { // gravitational lens: light from behind the pointer is pushed out into a ring
        const dx = x - mouse.x, dy = y - mouse.y, d = Math.hypot(dx, dy) + .001;
        if (d < 260) { const push = Math.min(70, 3600 / d) * (1 - d / 260); x += dx / d * push; y += dy / d * push; }
      }
      const tw = .55 + .45 * Math.sin(t * 1.7 + s.p), sz = s.z * 1.7 + .35;
      if (s.c !== col) ctx.fillStyle = col = s.c;
      ctx.globalAlpha = (.22 + s.z * .78) * tw;
      ctx.fillRect(x, y, sz, sz);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const p of pages) {
      p.a += p.s * .0018 * (1 + pull * 7); p.rot += p.vr * .01 * (1 + pull * 4);
      const r = p.r * (1 - pull * .7), depth = (Math.sin(p.a) + 1) / 2;
      page(c.x + Math.cos(p.a) * r, c.y + Math.sin(p.a) * r * p.tilt, p.size * (.65 + depth * .55), p.rot, .2 + depth * .5);
    }
    if (!comet && Math.random() < .004) comet = { x: Math.random() * W, y: Math.random() * H * .5, vx: 7 + Math.random() * 5, vy: 2 + Math.random() * 3, life: 1 };
    if (comet) {
      const g = ctx.createLinearGradient(comet.x, comet.y, comet.x - comet.vx * 14, comet.y - comet.vy * 14);
      g.addColorStop(0, `rgba(255,236,200,${comet.life})`); g.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(comet.x, comet.y); ctx.lineTo(comet.x - comet.vx * 14, comet.y - comet.vy * 14); ctx.stroke();
      comet.x += comet.vx; comet.y += comet.vy; comet.life -= .012;
      if (comet.life <= 0) comet = null;
    }
  }
  let last = 0;
  function loop(now) {
    if (!running) return;
    if (now - last > 15) { last = now; draw(now); }
    requestAnimationFrame(loop);
  }
  function sync() {
    const go = onScreen && !document.hidden && !calm() && !views.dashboard.classList.contains('hidden');
    if (go && !running) { running = true; requestAnimationFrame(loop); }
    if (!go) { running = false; draw(performance.now()); }
  }
  hero.addEventListener('pointermove', e => { const r = hero.getBoundingClientRect(); mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top; if (mouse.x < -1000) { mouse.x = mouse.tx; mouse.y = mouse.ty; } });
  hero.addEventListener('pointerleave', () => { mouse.tx = mouse.ty = -1e4; mouse.x = mouse.y = -1e4; });
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }).observe(hero);
  // in light mode the nav turns to dark glass while it floats over the night sky
  new IntersectionObserver(([e]) => root.classList.toggle('nav-dark', e.isIntersecting), { rootMargin: '-30px 0px -92% 0px' }).observe(hero);
  document.addEventListener('visibilitychange', sync);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { build(); sync(); }, 150); });
  build();
  return { sync, pull: on => { pullTo = on ? 1 : 0; }, flash() { pull = 0; } };
})();

/* ---------- headline: letters ignite on load, and lean and warm as the pointer passes ---------- */
(() => {
  const h = $('headline'), text = h.textContent.trim();
  let i = 0;
  h.setAttribute('aria-label', text);
  // one line per sentence
  h.innerHTML = `<span aria-hidden="true">${text.split(' ').map((w, k, all) => `<span class="word">${[...w].map(ch => `<span class="ch" style="--i:${i++}">${ch}</span>`).join('')}</span>${w.endsWith('.') && k < all.length - 1 ? '<br>' : ' '}`).join('')}</span>`;
  const chars = [...h.querySelectorAll('.ch')];
  chars.at(-1).addEventListener('animationend', () => chars.forEach(c => { c.style.animation = 'none'; }), { once: true });
  if (!finePointer) return;
  const hero = h.closest('.hero');
  let raf = 0;
  hero.addEventListener('pointermove', e => {
    if (calm() || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const c of chars) {
        const r = c.getBoundingClientRect(), d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        const heat = Math.max(0, 1 - d / 220);
        c.classList.toggle('near', heat > 0);
        c.style.setProperty('--heat', heat.toFixed(2));
        c.style.setProperty('--lift', `${(-.07 * heat).toFixed(3)}em`);
        c.style.setProperty('--skew', `${(-10 * heat).toFixed(1)}deg`);
      }
    });
  });
  hero.addEventListener('pointerleave', () => chars.forEach(c => { c.classList.remove('near'); ['--heat', '--lift', '--skew'].forEach(p => c.style.removeProperty(p)); }));
})();

/* ---------- marquee: drifts on its own, runs faster and turns with scrolling ---------- */
(() => {
  const track = $('marquee');
  track.innerHTML = ['PDF', 'DOCX', 'XLSX', 'PPTX', 'JPG', 'PNG', 'WEBP', 'CSV', 'TXT', 'ODS', 'GIF'].map(w => `<span>${w}</span><i></i>`).join('').repeat(4);
  let x = 0, v = 0, lastY = scrollY, dir = 1;
  (function loop() {
    const dy = scrollY - lastY;
    lastY = scrollY;
    if (dy) dir = dy > 0 ? 1 : -1;
    v += (Math.min(40, Math.abs(dy)) - v) * .08;
    if (!calm()) {
      const w = track.scrollWidth / 4;
      x -= (.5 + v * .8) * dir;
      if (x < -w) x += w;
      if (x > 0) x -= w;
      track.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    requestAnimationFrame(loop);
  })();
})();

/* ---------- tool grid: a row of the most used tools, then every group under its own heading ---------- */
let filter = 'all';
// what goes in and what comes out, shown as tags on each card
const IO = { merge: 'PDF → PDF', split: 'PDF → PDF', remove: 'PDF → PDF', organize: 'PDF → PDF', rotate: 'PDF → PDF', compress: 'PDF → PDF', repair: 'PDF → PDF',
  ocr: 'PDF / Image → Text', jpg2pdf: 'Image → PDF', word2pdf: 'DOCX → PDF', excel2pdf: 'XLSX → PDF', text2pdf: 'Text → PDF', pdf2jpg: 'PDF → JPG / PNG',
  pdf2word: 'PDF → DOCX', pdf2ppt: 'PDF → PPTX', pdf2excel: 'PDF → XLSX', sign: 'PDF → PDF', edittext: 'PDF → PDF', fillform: 'PDF → PDF', numbers: 'PDF → PDF',
  watermark: 'PDF → PDF', crop: 'PDF → PDF', redact: 'PDF → PDF', protect: 'PDF → PDF', unlock: 'PDF → PDF',
  flatten: 'PDF → PDF', removeannots: 'PDF → PDF', headerfooter: 'PDF → PDF', bookmarks: 'PDF → PDF', findredact: 'PDF → PDF', compare: '2 PDFs → Report' };
const tagsOf = id => { const t = TOOLS[id]; return [IO[id], t.ai === 'device' ? 'On-device AI' : t.ai && 'AI', t.batch && 'Batch', t.multiple && 'Many files', /OCR/.test(t.desc) && 'OCR'].filter(Boolean); };
const groupName = g => GROUPS.find(x => x[0] === g)[1];
const card = (id, big = false) => { const t = TOOLS[id], n = String(Object.keys(TOOLS).indexOf(id) + 1).padStart(2, '0'); return `<button class="card cell reveal${big ? ' featured' : ''}" data-id="${id}" data-g="${t.group}" onclick="openTool('${id}', this)">
  ${big ? `<span class="cell-art"><span class="orb"></span><span class="card-icon">${icon(t.icon)}</span></span>` : ''}
  <span class="cell-top"><span class="num">${n}</span><span class="label">${groupName(t.group)}</span></span>
  ${big ? '' : `<span class="card-icon">${icon(t.icon)}</span>`}
  <span class="card-text"><span class="card-name">${t.name}</span><span class="card-desc">${t.desc}</span></span>
  <span class="tags">${tagsOf(id).map(x => `<span class="tag">${x}</span>`).join('')}${t.ai === 'both' ? '<span class="tag soon-tag">Coming soon</span>' : ''}</span>
  <span class="cell-foot label">Open tool${icon('open')}</span></button>`; };
const ids = Object.keys(TOOLS);
$('tools-count').textContent = `${ids.length} tools, ${GROUPS.length} groups`;
$('popular').innerHTML = `<header class="group-head"><h3>Most used</h3><span class="label">Start here</span></header><div class="grid grid-popular">${ids.filter(id => TOOLS[id].featured).map(id => card(id, true)).join('')}</div>`;
$('groups').innerHTML = GROUPS.map(([g, name]) => {
  const list = ids.filter(id => TOOLS[id].group === g || TOOLS[id].also?.includes(g));
  return `<section class="tool-group" data-g="${g}"><header class="group-head"><h3>${name}</h3><span class="label">${plural(list.length, 'tool')}</span></header><div class="grid">${list.map(id => card(id)).join('')}</div></section>`;
}).join('');
$('chips').innerHTML = [['all', 'All tools'], ...GROUPS].map(([g, n]) => `<button class="chip" data-g="${g}" aria-pressed="${g === 'all'}">${n}</button>`).join('');
$('chips').onclick = e => { const b = e.target.closest('[data-g]'); if (b) { filter = b.dataset.g; applyFilter(); } };
$('tool-search').oninput = applyFilter;
$('tool-search').placeholder = `Search ${ids.length} tools`;
const matches = (t, q) => !q || `${t.name} ${t.desc} ${t.keys}`.toLowerCase().includes(q);
function applyFilter() {
  const q = $('tool-search').value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('.tool-group').forEach(sec => {
    let n = 0;
    sec.querySelectorAll('.card').forEach(c => { const hit = (filter === 'all' || sec.dataset.g === filter) && matches(TOOLS[c.dataset.id], q); c.classList.toggle('hidden', !hit); n += hit; });
    sec.classList.toggle('hidden', !n);
    shown += n;
  });
  $('popular').classList.toggle('hidden', filter !== 'all' || !!q); // the shortcut row only on the full list
  document.querySelectorAll('#chips .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.g === filter));
  $('empty').classList.toggle('hidden', shown > 0);
}
// the light on each card follows the pointer
$('tools').addEventListener('pointermove', e => {
  for (const c of document.querySelectorAll('#tools .card:not(.hidden)')) {
    const r = c.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
});
// cards lean a few degrees toward the pointer
if (finePointer) {
  let tilted = null;
  $('tools').addEventListener('pointermove', e => {
    const c = calm() ? null : e.target.closest('.card');
    if (tilted && tilted !== c) { tilted.style.removeProperty('--rx'); tilted.style.removeProperty('--ry'); }
    tilted = c;
    if (!c) return;
    const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
    c.style.setProperty('--rx', `${(-py * 5).toFixed(2)}deg`);
    c.style.setProperty('--ry', `${(px * 6).toFixed(2)}deg`);
  });
  $('tools').addEventListener('pointerleave', () => { tilted?.style.removeProperty('--rx'); tilted?.style.removeProperty('--ry'); tilted = null; });
}

$('foot-word').parentElement.addEventListener('pointermove', e => {
  const r = $('foot-word').getBoundingClientRect();
  $('foot-word').style.setProperty('--mx', `${e.clientX - r.left}px`);
});

/* ---------- command palette (⌘K, Ctrl+K or /) ---------- */
let palSel = 0, palIds = [];
function openPalette() {
  $('pal-input').value = '';
  drawPalette();
  $('palette').showModal();
  $('pal-input').focus();
}
function drawPalette() {
  const q = $('pal-input').value.trim().toLowerCase();
  palIds = Object.keys(TOOLS).filter(id => matches(TOOLS[id], q));
  palSel = Math.min(palSel, Math.max(0, palIds.length - 1));
  $('pal-list').innerHTML = palIds.map((id, k) => `<li><button aria-selected="${k === palSel}" data-id="${id}"><span class="card-icon">${icon(TOOLS[id].icon)}</span><span>${TOOLS[id].name}<small>${GROUPS.find(g => g[0] === TOOLS[id].group)[1]}</small></span></button></li>`).join('') || '<li class="empty" style="padding:16px">No tool matches that.</li>';
  $('pal-list').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}
$('pal-input').oninput = () => { palSel = 0; drawPalette(); };
$('pal-input').onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palIds.length) % palIds.length; drawPalette(); }
  if (e.key === 'Enter' && palIds[palSel]) { $('palette').close(); openTool(palIds[palSel]); }
};
$('pal-list').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { $('palette').close(); openTool(b.dataset.id); } };
$('palette').onclick = e => { if (e.target === $('palette')) $('palette').close(); };
$('search-btn').onclick = openPalette;
addEventListener('keydown', e => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); openPalette(); }
});

/* ---------- files from anywhere: drop on the page, or "Choose a file", then pick a tool ---------- */
function pickAny() {
  const input = $('file-input');
  Object.assign(input, { accept: '.pdf,image/*,.docx,.xlsx,.xls,.csv,.ods,.txt,.md', multiple: true, value: '' });
  input.onchange = () => { route([...input.files]); input.value = ''; };
  input.click();
}
function route(files) {
  if (!files.length) return;
  const kind = kindOf(files[0]);
  if (!kind) return showToast(`${files[0].name} isn't a file Nebula can work with. Try a PDF, image, Word, Excel or text file.`, true);
  const same = files.filter(f => kindOf(f) === kind);
  let ids = SUGGEST[kind];
  if (kind === 'pdf' && same.length > 1) ids = ['merge', ...ids.filter(i => i !== 'merge')];
  if (ids.length === 1) return openTool(ids[0], null, same);
  $('router-file').textContent = same.length > 1 ? `${same.length} files: ${same.map(f => f.name).join(', ')}` : `${same[0].name}, ${kb(same[0].size)}`;
  $('router-grid').innerHTML = ids.map(id => `<button data-id="${id}">${icon(TOOLS[id].icon)}${TOOLS[id].name}</button>`).join('');
  $('router-grid').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { $('router').close(); openTool(b.dataset.id, null, same); } };
  $('router').showModal();
}
$('router').onclick = e => { if (e.target === $('router')) $('router').close(); };
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) { root.classList.add('dragging'); $('dropveil').classList.add('on'); sky.pull(true); }
});
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
const endDrag = () => { dragDepth = 0; root.classList.remove('dragging'); $('dropveil').classList.remove('on'); sky.pull(false); };
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) endDrag(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endDrag();
  const files = [...e.dataTransfer.files];
  if (!views.workspace.classList.contains('hidden') && TOOLS[currentTool]?.accept) handleFiles(files);
  else route(files);
});

/* ---------- views, with history so Back works ---------- */
let homeScroll = 0;
function swap(fn, shared) {
  if (!document.startViewTransition || calm()) return fn();
  if (shared) { shared.icon.style.viewTransitionName = 'tool-icon'; shared.name.style.viewTransitionName = 'tool-name'; }
  let done = false;
  const update = () => {
    if (done) return;
    done = true;
    if (shared) { shared.icon.style.viewTransitionName = ''; shared.name.style.viewTransitionName = ''; }
    fn();
    if (shared) { $('ws-icon').style.viewTransitionName = 'tool-icon'; $('tool-title').style.viewTransitionName = 'tool-name'; }
  };
  const vt = document.startViewTransition(update);
  // The browser only swaps views on its next painted frame. If it isn't painting (a background tab, a busy
  // machine), don't leave the user on the old screen: skip the animation and switch now.
  setTimeout(() => { if (!done) { vt.skipTransition(); update(); } }, 400);
  vt.ready.catch(() => {}); // an interrupted transition is fine: the new view is already in place
  vt.finished.finally(() => { $('ws-icon').style.viewTransitionName = ''; $('tool-title').style.viewTransitionName = ''; });
}
function showView(name) {
  Object.entries(views).forEach(([k, v]) => v.classList.toggle('hidden', k !== name));
  root.classList.toggle('on-tool', name === 'workspace');
  sky.sync();
}
function openTool(id, card, files) {
  if (views.workspace.classList.contains('hidden')) homeScroll = scrollY;
  const shared = card && { icon: card.querySelector('.card-icon'), name: card.querySelector('.card-name') };
  swap(() => { selectTool(id); showView('workspace'); scrollTo(0, 0); if (files?.length) handleFiles(files); }, shared);
  if (location.hash !== `#${id}`) history.pushState({ tool: id }, '', `#${id}`);
}
function goHome(push = true, to = '') {
  // the scroll happens inside the transition: one made after it would be undone when the transition lands
  swap(() => { showView('dashboard'); if (to) $(to).scrollIntoView(); else scrollTo(0, homeScroll); document.title = 'Nebula'; });
  if (push && location.hash) history.pushState({}, '', location.pathname + location.search);
}
addEventListener('popstate', () => {
  const id = location.hash.slice(1);
  if (TOOLS[id]) swap(() => { selectTool(id); showView('workspace'); scrollTo(0, 0); });
  else if (!views.workspace.classList.contains('hidden')) goHome(false); // in-page links (#tools) don't leave the home page
});
// Nav links to home-page sections also work from a tool screen.
function goHomeTo(e, id) {
  if (views.workspace.classList.contains('hidden')) return;
  e.preventDefault();
  goHome(true, id);
}

/* ---------- the tool screen ---------- */
function selectTool(id) {
  const t = TOOLS[id];
  currentTool = id;
  uploadedFiles = [];
  document.title = `${t.name} · Nebula`;
  $('ws-icon').innerHTML = icon(t.icon);
  $('tool-title').textContent = t.name;
  $('ws-crumb').textContent = `Tool ${String(Object.keys(TOOLS).indexOf(id) + 1).padStart(2, '0')} / ${groupName(t.group)}`;
  document.documentElement.dataset.g = t.group;
  $('tool-desc').textContent = t.desc;
  if (t.ai === 'both') $('tool-desc').insertAdjacentHTML('beforeend', `<span class="soon-pill">${icon('ai')}Claude (cloud) mode coming soon. This runs on your device for now.</span>`);
  const note = document.querySelector('.local-note');
  if (note) note.lastChild.textContent = 'Processed on this device. Nothing is uploaded.'; // AI tools in cloud mode change this
  $('tool-content').innerHTML = t.accept ? `<div id="drop-zone" class="drop" role="button" tabindex="0" data-cursor="drop">
      <span class="drop-icon">${icon('upload')}</span>
      <p class="drop-title"><span class="on-mouse">${t.drop || (t.multiple || t.batch ? 'Drop PDFs here' : 'Drop a PDF here')}</span><span class="on-touch">${t.accept === PDF ? (t.multiple || t.batch ? 'Tap to choose PDFs' : 'Tap to choose a PDF') : 'Tap to choose a file'}</span></p>
      <p class="drop-sub"><span class="on-mouse">or click to choose. </span>${t.note || (t.batch ? 'One PDF, or several to do them all at once.' : 'One PDF file.')}</p></div>
    <ol id="file-list" class="files${t.ordered ? ' numbered' : ''}"></ol>` : '';
  $('tool-options').innerHTML = '';
  $('tool-options').classList.add('hidden');
  $('result').classList.add('hidden');
  setLoading(false);
  drawPreview();
  if (t.accept) initDrop(t); else showToolOptions();
  need(...(t.libs || [])).catch(() => {}); // warm up libraries while the user picks a file
}
const resetTool = () => selectTool(currentTool);

function initDrop(t) {
  const zone = $('drop-zone'), input = $('file-input');
  const open = () => {
    Object.assign(input, { accept: t.accept, multiple: !!(t.multiple || t.batch), value: '' });
    input.onchange = () => { handleFiles([...input.files]); input.value = ''; };
    input.click();
  };
  zone.onclick = open;
  zone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  zone.ondragover = () => zone.classList.add('over');
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = () => zone.classList.remove('over');
}

function handleFiles(list) {
  const t = TOOLS[currentTool];
  if (!t.accept) return;
  const all = Array.from(list), files = all.filter(f => fits(f, t.accept));
  if (files.length < all.length) showToast(`${all.find(f => !fits(f, t.accept)).name} can't be used here. ${t.note || 'Choose a PDF.'}`, true);
  if (!files.length) return;
  uploadedFiles = t.multiple || t.batch ? [...uploadedFiles, ...files] : [files[0]];
  uploadedFiles.forEach(f => { delete f.status; });
  files.filter(isPdf).forEach(f => need('pdflib')
    .then(async () => { f.pages = (await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false })).getPageCount(); renderFileList(); drawMeta(); })
    .catch(() => {}));
  $('result').classList.add('hidden');
  renderFileList();
  showToolOptions(true);
  drawPreview();
}

function renderFileList() {
  const t = TOOLS[currentTool], list = $('file-list'), n = uploadedFiles.length;
  if (!list) return;
  list.innerHTML = uploadedFiles.map((f, i) => `<li class="file-item">
    <span class="file-badge"><span>${esc((f.name.split('.').pop() || '').slice(0, 4))}</span></span>
    <div><span class="file-name">${esc(f.name)}</span><span class="file-meta">${f.status ? `${f.status.ok ? '✓' : '✕'} ${esc(f.status.text)}` : `${f.pages ? `${plural(f.pages, 'page')}, ` : ''}${kb(f.size)}`}</span></div>
    <div class="file-actions">${t.ordered && n > 1 ? `
      <button class="icon-btn" onclick="moveFile(${i}, -1)" aria-label="Move ${esc(f.name)} up" ${i === 0 ? 'disabled' : ''}>${icon('arrow-up')}</button>
      <button class="icon-btn" onclick="moveFile(${i}, 1)" aria-label="Move ${esc(f.name)} down" ${i === n - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button>` : ''}
      <button class="icon-btn" onclick="removeFile(${i})" aria-label="Remove ${esc(f.name)}" data-cursor="remove">${icon('x')}</button></div></li>`).join('');
  $('drop-zone')?.classList.toggle('compact', n > 0);
}
function moveFile(i, d) {
  [uploadedFiles[i], uploadedFiles[i + d]] = [uploadedFiles[i + d], uploadedFiles[i]];
  renderFileList();
  drawPreview();
}
function removeFile(i) {
  uploadedFiles.splice(i, 1);
  renderFileList();
  drawPreview();
  if (!uploadedFiles.length) showToolOptions();
  else if (TOOLS[currentTool].batch && uploadedFiles.length === 1) showToolOptions(true);
}

// Options appear once there's something to work on. `fresh` = new file(s) just arrived.
function showToolOptions(fresh) {
  const t = TOOLS[currentTool], box = $('tool-options');
  if (t.accept && !uploadedFiles.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  if (!t.options) return;
  if (!((t.multiple || t.batch) && box.innerHTML)) { box.innerHTML = t.options(); box.classList.remove('hidden'); t.afterOptions?.(); }
  // per-file extras (page picker, stage, form) only make sense for one file; a batch uses the same settings for all
  if (t.batch && uploadedFiles.length > 1) { $('o-picker')?.replaceChildren(); return; }
  if (t.ready && fresh) need(...(t.libs || [])).then(() => t.ready(uploadedFiles)).catch(e => showToast(e.message, true));
}

/* the side panel: a look at the first file, and its details */
let previewToken = 0;
async function drawPreview() {
  const box = $('preview'), f = uploadedFiles[0], token = ++previewToken, t = TOOLS[currentTool];
  drawMeta();
  if (!f) { box.innerHTML = `<div class="preview-empty">${icon(t?.accept ? 'file-up' : t?.icon || 'file-text')}<span>${t?.accept ? 'Your file shows here' : 'Nothing to upload for this tool'}</span></div>`; return; }
  if (f.type.startsWith('image/')) {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    img.alt = '';
    img.onload = () => URL.revokeObjectURL(img.src);
    img.onerror = () => { box.innerHTML = `<div class="preview-empty">${icon('img')}<span class="mono">${esc(f.name)}</span></div>`; }; // HEIC: most browsers can't show it
    box.replaceChildren(img);
    return;
  }
  if (!isPdf(f)) { box.innerHTML = `<div class="preview-empty">${icon(kindOf(f) === 'sheet' ? 'sheet' : 'file-text')}<span class="mono">${esc(f.name)}</span></div>`; return; }
  box.innerHTML = `<div class="preview-empty"><span class="spin"></span></div>`;
  try {
    const view = await openView(f), w = (await view.getPage(1)).getViewport({ scale: 1 }).width;
    const c = await renderPage(view, 1, 300 * Math.min(devicePixelRatio, 2) / w);
    if (token === previewToken) box.replaceChildren(c);
  } catch (e) {
    if (token === previewToken) box.innerHTML = `<div class="preview-empty">${icon('lock-keyhole')}<span>${esc(e.message)}</span></div>`;
  }
}
function drawMeta() {
  const f = uploadedFiles[0], el = $('meta');
  if (!f) { el.innerHTML = ''; return; }
  const total = uploadedFiles.reduce((a, x) => a + x.size, 0);
  const rows = uploadedFiles.length > 1
    ? [['Files', uploadedFiles.length], ['Total size', kb(total)]]
    : [['File', esc(f.name)], ['Size', kb(f.size)], ...(f.pages ? [['Pages', f.pages]] : []), ['Type', esc((f.name.split('.').pop() || '').toUpperCase())]];
  el.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

/* running a tool */
function setLoading(on, text = 'Working…', frac) {
  const b = $('action-btn'), bar = $('bar');
  b.disabled = on;
  b.innerHTML = on ? `<span class="spin" aria-hidden="true"></span>${esc(text)}` : `${esc(TOOLS[currentTool]?.btn || '')}${icon('arrow-down')}`;
  bar.classList.toggle('hidden', !on);
  bar.classList.toggle('indeterminate', on && frac === undefined);
  bar.firstElementChild.style.width = frac === undefined ? '' : `${Math.round(frac * 100)}%`;
}
let batchAt = null; // [file number, of how many] while a batch runs
const progress = (text, frac) => batchAt
  ? setLoading(true, `${batchAt[0] + 1}/${batchAt[1]}: ${text}`, (batchAt[0] + (frac ?? .5)) / batchAt[1])
  : setLoading(true, text, frac);
// Run a tool on each file, collect the results, and save them as one zip.
async function runBatch(t) {
  const outs = [], fails = [];
  for (const [k, f] of uploadedFiles.entries()) {
    batchAt = [k, uploadedFiles.length];
    progress(f.name);
    saveSink = [];
    try {
      const msg = await t.run([f]);
      outs.push(...saveSink);
      f.status = { ok: true, text: msg };
    } catch (e) {
      f.status = { ok: false, text: e instanceof UserError ? e.message : `Failed: ${e.message || e}` };
      fails.push(f);
    }
    saveSink = null;
    renderFileList();
  }
  batchAt = null;
  if (!outs.length) throw new UserError(`None of the files worked. ${fails[0].status.text}`);
  const seen = {}; // two files can't share a name in the zip
  outs.forEach(o => { const n = (seen[o.name] = (seen[o.name] || 0) + 1); if (n > 1) o.name = o.name.replace(/(\.[^./]+)?$/, ` (${n})$1`); });
  await need('jszip');
  const zip = new JSZip();
  outs.forEach(o => zip.file(o.name, o.data));
  save(await zip.generateAsync({ type: 'blob' }), `nebula-${currentTool}-${uploadedFiles.length}-files.zip`);
  return `Done for ${uploadedFiles.length - fails.length} of ${plural(uploadedFiles.length, 'file')}${fails.length ? `. ${fails.length} failed; see the list` : ''}`;
}
let autoSaved = true; // false when the browser wouldn't let the download start by itself
window.onSaved = (file, auto) => { lastFile = file; autoSaved = auto; };

async function runTool() {
  const t = TOOLS[currentTool];
  if (t.accept && !uploadedFiles.length) return showToast(t.multiple ? 'Add your files first.' : 'Add a file first.', true);
  setLoading(true);
  lastFile = null;
  autoSaved = true;
  try {
    await need(...(t.libs || []));
    const msg = t.batch && uploadedFiles.length > 1 ? await runBatch(t) : await t.run(uploadedFiles);
    processed += Math.max(1, uploadedFiles.length);
    $('ro-files').textContent = processed;
    if (!t.quiet) { // chat shows its answers in place
      showResult(msg);
      if (lastFile && !autoSaved) {
        showToast(say(`${msg}. Click Download to save your file.`));
        $('again')?.classList.add('attention');
        $('again')?.scrollIntoView({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' });
        $('again')?.focus({ preventScroll: true });
      } else showToast(msg);
      // on a phone the result sits below the options: bring it into view
      if (matchMedia('(max-width: 980px)').matches) $('result').scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' });
    }
  } catch (e) {
    saveSink = null;
    batchAt = null;
    console.error(e);
    showToast(e instanceof UserError ? e.message
      : /WinAnsi|cannot encode/i.test(e.message) ? 'That text uses characters the built-in PDF font can’t show. Use Latin letters, numbers and common symbols.'
      : `Something went wrong: ${e.message || e}`, true);
  }
  setLoading(false);
}
function showResult(msg) {
  const box = $('result'), f = lastFile;
  const next = f ? (SUGGEST[kindOf(f)] || []).filter(id => id !== currentTool).slice(0, 4) : [];
  box.innerHTML = `<div class="result">
    <div class="result-head"><span class="result-check">${icon('check')}</span><div style="min-width:0"><p class="result-title">${esc(msg)}</p>${f ? `<p class="result-file">${esc(f.name)}, ${kb(f.size)}</p>` : ''}</div></div>
    ${f ? `<button class="btn" id="again">${icon('download')}Download ${esc(f.name.split('.').pop().toUpperCase())}</button><p class="hint">${autoSaved ? 'It’s downloading now. If your browser blocked it, use this button.' : say('This took a moment, so your browser needs one click to save it.')}</p>` : ''}
    ${next.length ? `<p class="next-label">Keep going with this file</p><div class="row">${next.map(id => `<button class="chip" data-id="${id}">${icon(TOOLS[id].icon)}${TOOLS[id].name}</button>`).join('')}</div>` : ''}</div>`;
  box.classList.remove('hidden');
  if (f) $('again').onclick = () => { save(f, f.name); $('again').classList.remove('attention'); };
  box.querySelectorAll('[data-id]').forEach(b => { b.onclick = () => openTool(b.dataset.id, null, [f]); });
}

let toastTimer;
function showToast(msg, error = false) {
  const t = $('toast');
  t.innerHTML = `${icon(error ? 'x' : 'check')}<span>${esc(msg)}</span>`;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 6500 : 3800);
}

/* ---------- privacy readout: what this tab has downloaded, and what it has sent (nothing) ---------- */
(() => {
  const update = () => {
    const res = performance.getEntriesByType('resource').filter(r => /cdnjs|jsdelivr|unpkg|gstatic|googleapis/.test(r.name));
    const bytes = res.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
    $('ro-down').textContent = bytes ? kb(bytes) : `${plural(res.length, 'file')}`;
  };
  update();
  try { new PerformanceObserver(update).observe({ type: 'resource', buffered: true }); } catch { setInterval(update, 3000); }
})();

/* ---------- offline app: service worker, saving the tools, installing ---------- */
const LIB_URLS = [...Object.values(CDN), PDFJS_WORKER];
async function offlineStatus() {
  if (!window.caches) return void ($('ro-offline').textContent = 'Not in this browser');
  const c = await caches.open('nebula-libs');
  const have = (await Promise.all(LIB_URLS.map(u => c.match(u, { ignoreVary: true })))).filter(Boolean).length;
  $('ro-offline').textContent = have === LIB_URLS.length ? 'Ready' : `${have} of ${LIB_URLS.length} parts saved`;
  $('offline-btn').classList.toggle('hidden', have === LIB_URLS.length);
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // keep this page's own files too, so the version you're using works offline
  const files = ['./', ...[...document.querySelectorAll('script[src^="assets/"], link[href^="assets/"]')].map(e => e.getAttribute('src') || e.getAttribute('href'))];
  // only fetch what isn't saved yet (versioned files never change), once the page has settled
  const keep = () => caches.open('nebula-shell').then(async c => {
    const missing = (await Promise.all(files.map(async f => (f === './' || !(await c.match(f))) && f))).filter(Boolean);
    await c.addAll(missing);
    for (const r of await c.keys()) { // drop the copies of older versions
      const u = new URL(r.url);
      if (u.pathname.includes('/assets/') && u.search && !files.some(f => r.url.endsWith(f))) c.delete(r);
    }
  }).catch(() => {});
  (window.requestIdleCallback || setTimeout)(keep, { timeout: 4000 });
}
offlineStatus();
$('offline-btn').onclick = async () => {
  const b = $('offline-btn'), c = await caches.open('nebula-libs');
  b.disabled = true;
  try {
    let k = 0;
    for (const u of LIB_URLS) {
      if (!(await c.match(u, { ignoreVary: true }))) await c.add(new Request(u, { mode: 'cors' }));
      $('ro-offline').textContent = `${++k} of ${LIB_URLS.length} parts saved`;
    }
    // the fonts (the stylesheet and the font files it points to); without them the page still works, in system fonts
    try {
      const css = document.querySelector('link[rel=stylesheet][href*="fonts.googleapis"]').href, text = await (await fetch(css)).text();
      await c.put(css, new Response(text, { headers: { 'Content-Type': 'text/css' } }));
      await Promise.all([...text.matchAll(/url\((https:[^)]+)\)/g)].map(m => c.add(new Request(m[1], { mode: 'cors' })).catch(() => {})));
    } catch { /* fonts are optional */ }
    showToast(`All ${Object.keys(TOOLS).length} tools now work offline. Reading scanned text needs one use online for each language.`);
  } catch { showToast('Saving stopped: check your connection and try again.', true); }
  b.disabled = false;
  offlineStatus();
};
let installPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('install-nav').classList.remove('hidden'); });
addEventListener('appinstalled', () => { installPrompt = null; $('install-nav').classList.add('hidden'); showToast('Nebula is installed. Open it like any other app.'); });
const install = async () => {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('install-nav').classList.add('hidden'); return; }
  if (matchMedia('(display-mode: standalone)').matches) return showToast('You’re already using the installed app.');
  showToast(/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'In Safari, tap Share, then Add to Home Screen.' : 'Open your browser’s menu and choose Install Nebula (or Add to Home Screen).');
};
$('install-nav').onclick = $('install-btn').onclick = install;
addEventListener('offline', () => showToast('You’re offline. Tools you’ve saved or used before still work.'));
addEventListener('online', () => showToast('Back online.'));
// the installed app can be chosen to open PDFs from the computer's files
if ('launchQueue' in window) launchQueue.setConsumer(async p => { const files = await Promise.all((p.files || []).map(h => h.getFile())); if (files.length) route(files); });

/* ---------- scroll ruler and section index: where you are on the home page ---------- */
(() => {
  const secs = [['top', document.querySelector('.hero')], ['tools', $('tools')], ];
  let queued = false;
  const tick = () => {
    queued = false;
    const max = root.scrollHeight - innerHeight, p = max > 0 ? Math.min(1, scrollY / max) : 0, hero = secs[0][1];
    const hp = calm() ? '0' : Math.min(1, Math.max(0, scrollY / (hero.offsetHeight || 1))).toFixed(3);
    let cur = 'top';
    for (const [k, el] of secs) if (el.getBoundingClientRect().top < innerHeight * .4) cur = k;
    if (root.classList.contains('on-tool')) cur = '';
    $('ruler-mark').style.top = `${p * 100}%`;
    $('ruler-pct').textContent = `${Math.round(p * 100)}%`;
    if (hero.style.getPropertyValue('--hp') !== hp) hero.style.setProperty('--hp', hp);
    document.querySelectorAll('[data-spy]').forEach(a => a.classList.toggle('active', a.dataset.spy === cur));
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(tick); } }, { passive: true });
  addEventListener('resize', tick);
  new MutationObserver(tick).observe(root, { attributes: true, attributeFilter: ['class'] });
  tick();
})();

$('action-btn').onclick = runTool; // the main button of every tool

/* ---------- start ---------- */
if (TOOLS[location.hash.slice(1)]) { selectTool(location.hash.slice(1)); showView('workspace'); }
// the readout owns up when an AI tool sends text to Claude
window.onCloudSend = n => { $('ro-sent').textContent = `${kb(n)} (to Claude)`; $('ro-sent').classList.remove('zero'); };

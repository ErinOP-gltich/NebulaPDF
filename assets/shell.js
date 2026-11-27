/* Nebula shell, shared by every page: theme, motion switch, cursor, button ripples and scroll reveals.
   Loaded after icons.js (and on the home page after the tools, before app.js). */
const byId = id => document.getElementById(id);
const root = document.documentElement;
const calm = () => root.classList.contains('calm') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(pointer: fine)').matches;
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon, el.className); });

/* ---------- theme: a circle of the new theme grows from the button ---------- */
function setTheme(next, e) {
  const apply = () => {
    root.dataset.theme = next;
    store.set('nebula-theme', next);
    document.querySelector('meta[name=theme-color]').content = next === 'dark' ? '#05060A' : '#F3F4F7';
  };
  if (!document.startViewTransition || calm()) return apply();
  const x = e?.clientX ?? innerWidth - 40, y = e?.clientY ?? 40, r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  let done = false;
  const once = () => { if (!done) { done = true; apply(); } };
  root.classList.add('theme-vt');
  const vt = document.startViewTransition(once);
  vt.finished.finally(() => root.classList.remove('theme-vt'));
  setTimeout(() => { if (!done) { vt.skipTransition(); once(); } }, 400); // same safety net as swap()
  vt.ready.then(() => root.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
    { duration: 1100, easing: 'cubic-bezier(.2, 0, 0, 1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
}
byId('theme-btn').onclick = e => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', e);

/* ---------- motion switch ---------- */
byId('calm-toggle').checked = root.classList.contains('calm');
byId('calm-toggle').onchange = e => { root.classList.toggle('calm', e.target.checked); store.set('nebula-calm', e.target.checked ? '1' : '0'); };

/* ---------- cursor: a dot, and a ring that trails it and changes with what it's over ---------- */
if (finePointer) {
  const cur = byId('cursor'), ring = cur.querySelector('.cursor-ring'), dot = cur.querySelector('.cursor-dot'), label = byId('cursor-label');
  root.classList.add('has-cursor');
  let x = -100, y = -100, rx = x, ry = y, seen = false, magnet = null, toneDue = false, toneAt = 0;
  // the cursor goes dark over light things: read the pixel of a canvas or image under it, else the first solid background
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  probe.canvas.width = probe.canvas.height = 1;
  const lum = draw => {
    try { probe.clearRect(0, 0, 1, 1); draw(); const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data; return a < 140 ? null : (.2126 * r + .7152 * g + .0722 * b) / 255; }
    catch { return null; } // cross-origin image
  };
  const lightUnder = () => {
    for (let n = document.elementFromPoint(x, y); n && n !== root; n = n.parentElement) {
      let l = null;
      if (n.tagName === 'CANVAS' || (n.tagName === 'IMG' && n.complete)) {
        const r = n.getBoundingClientRect(), w = n.naturalWidth || n.width, h = n.naturalHeight || n.height;
        if (w && r.width) l = lum(() => probe.drawImage(n, (x - r.left) * w / r.width, (y - r.top) * h / r.height, 1, 1, 0, 0, 1, 1));
      }
      if (l === null) { const c = getComputedStyle(n).backgroundColor; l = lum(() => { probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); }); }
      if (l !== null) return l > .62;
    }
    return root.dataset.theme === 'light';
  };
  addEventListener('scroll', () => { toneDue = true; wake(); }, { passive: true });
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    x = e.clientX; y = e.clientY; toneDue = true; wake();
    if (!seen) { rx = x; ry = y; seen = true; }
    cur.classList.remove('gone');
    dot.style.transform = `translate(${x}px, ${y}px)`;
    const t = e.target.closest?.('[data-cursor], a, button, label, select, summary, [role=button], input, textarea, .card');
    let state = '';
    if (t?.matches('input:not([type=checkbox]):not([type=range]), textarea')) state = 'text';
    else if (t) state = t.dataset.cursor || (t.disabled ? '' : 'hover');
    if (root.classList.contains('dragging')) state = 'drop';
    cur.dataset.state = state;
    label.textContent = state === 'drop' ? (root.classList.contains('dragging') ? 'Drop' : 'Open') : state === 'remove' ? 'Remove' : '';
    // primary buttons lean toward the pointer
    const m = calm() ? null : e.target.closest?.('.btn, .well');
    if (magnet && magnet !== m) magnet.style.translate = '';
    magnet = m;
    if (m) { const r = m.getBoundingClientRect(); m.style.translate = `${(x - r.left - r.width / 2) * .18}px ${(y - r.top - r.height / 2) * .25}px`; }
  }, { passive: true });
  addEventListener('pointerdown', () => cur.classList.add('down'));
  addEventListener('pointerup', () => cur.classList.remove('down'));
  root.addEventListener('mouseleave', () => cur.classList.add('gone'));
  let awake = false;
  const wake = () => { if (!awake) { awake = true; requestAnimationFrame(trail); } };
  function trail() {
    const k = calm() ? 1 : .2;
    rx += (x - rx) * k; ry += (y - ry) * k;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    const now = performance.now();
    if (toneDue && now - toneAt > 60) { toneDue = false; toneAt = now; cur.classList.toggle('on-light', lightUnder()); }
    if (toneDue || Math.abs(x - rx) + Math.abs(y - ry) > .3) requestAnimationFrame(trail);
    else awake = false;
  }
}

/* ---------- ripple on buttons ---------- */
addEventListener('pointerdown', e => {
  const b = e.target.closest('.btn, .btn-ghost, .chip');
  if (!b || calm()) return;
  const r = b.getBoundingClientRect(), size = Math.max(r.width, r.height) * 2.2, s = document.createElement('span');
  s.className = 'ripple';
  Object.assign(s.style, { width: `${size}px`, height: `${size}px`, left: `${e.clientX - r.left - size / 2}px`, top: `${e.clientY - r.top - size / 2}px` });
  if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
  b.style.overflow = 'hidden';
  b.append(s);
  setTimeout(() => s.remove(), 650);
});


/* ---------- things rise into view as you scroll (cards are added by app.js, which runs before this fires) ---------- */
const revealer = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealer.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.reveal').forEach(el => revealer.observe(el));
  document.querySelectorAll('.h2, .group-head h3').forEach(el => { el.classList.add('wipe'); revealer.observe(el); });
});

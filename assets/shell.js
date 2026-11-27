/* Nebula shell, shared by every page: theme, motion switch, button ripples and scroll reveals.
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

/* ---------- primary buttons lean toward the mouse ---------- */
if (finePointer) {
  let magnet = null;
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const m = calm() ? null : e.target.closest?.('.btn, .well');
    if (magnet && magnet !== m) magnet.style.translate = '';
    magnet = m;
    if (m) { const r = m.getBoundingClientRect(); m.style.translate = `${(e.clientX - r.left - r.width / 2) * .18}px ${(e.clientY - r.top - r.height / 2) * .25}px`; }
  }, { passive: true });
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

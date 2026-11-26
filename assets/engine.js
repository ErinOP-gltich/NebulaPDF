/* Nebula engine: library loading, PDF helpers, page layout analysis, the Word/Excel writers and the tools.
   Loaded before app.js. The page shell (app.js) provides progress(), showToast() and the tool screen. */

/* ---------- Libraries, loaded on demand ---------- */
const CDN = {
  pdflib: 'https://unpkg.com/@cantoo/pdf-lib@2.11.1/dist/pdf-lib.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  autotable: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js',
  pptx: 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
  heic2any: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
};
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class UserError extends Error {}
const loading = {};
// Loads scripts in order (autotable needs jspdf first), each only once.
const need = (...names) => names.reduce((p, n) => p.then(() => loading[n] ??= new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = CDN[n];
  s.onload = ok;
  s.onerror = () => { delete loading[n]; s.remove(); fail(new UserError('A tool library failed to load. Check your internet connection and try again.')); };
  document.head.append(s);
})), Promise.resolve());

/* ---------- Small helpers ---------- */
const $ = id => document.getElementById(id);
const val = id => $(id).value;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const stem = f => f.name.replace(/\.[^.]+$/, '');
const kb = n => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const fits = (f, accept) => accept.split(',').map(a => a.trim()).some(a =>
  a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
const MIME = {
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = name => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// During a batch run, results are collected here instead of downloaded one by one.
let saveSink = null;
// Every result goes through here, so the tool screen can offer it again and pass it to the next tool.
function save(data, name) {
  const file = new File([data], name, { type: mimeOf(name) });
  if (saveSink) { saveSink.push({ name, data: file }); return; }
  // Browsers only let a page start a download by itself for a few seconds after the user's last click. A long job
  // finishes after that, and the download would be silently blocked, so then we leave it to the Download button.
  if (navigator.userActivation && !navigator.userActivation.isActive) return window.onSaved?.(file, false);
  const url = URL.createObjectURL(file);
  // the link is put in the page for the click: Firefox and older Safari ignore clicks on links that aren't
  const a = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  window.onSaved?.(file, true);
}
async function saveMany(files, zipName) {
  if (saveSink) { files.forEach(f => saveSink.push({ name: `${zipName.replace(/\.zip$/, '')}/${f.name}`, data: f.data })); return; }
  if (files.length === 1) return save(files[0].data, files[0].name);
  await need('jszip');
  const zip = new JSZip();
  files.forEach(f => zip.file(f.name, f.data));
  save(await zip.generateAsync({ type: 'blob' }), zipName);
}

// "1-3, 5" -> [0, 1, 2, 4]
function parseRanges(str, count) {
  const out = [];
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new UserError(`"${part}" isn't a page or range. Use numbers like 1-3, 5.`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || a > b || b > count) throw new UserError(`Page ${part} doesn't exist. This PDF has ${plural(count, 'page')}.`);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  if (!out.length) throw new UserError('Enter the pages, like 1-3, 5.');
  return out;
}

/* ---------- PDF helpers ---------- */
async function openPdf(file) { // pdf-lib: for editing
  await need('pdflib');
  try { return await PDFLib.PDFDocument.load(await file.arrayBuffer()); }
  catch (e) {
    if (/encrypt|password/i.test(e.message)) throw new UserError(`${file.name} is password-protected. Remove the password with Unlock PDF first.`);
    throw new UserError(`${file.name} couldn't be read. If it's damaged, try Repair PDF.`);
  }
}
async function openView(file) { // PDF.js: for rendering and reading text
  await need('pdfjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  try { return await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch (e) {
    if (e.name === 'PasswordException') throw new UserError(`${file.name} is password-protected. Remove the password with Unlock PDF first.`);
    throw new UserError(`${file.name} couldn't be read. If it's damaged, try Repair PDF.`);
  }
}
// `patch(ctx)` can change the canvas context before PDF.js draws (used to leave text out).
async function renderPage(view, n, scale, patch) {
  const page = await view.getPage(n), vp = page.getViewport({ scale });
  const c = Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  const ctx = c.getContext('2d', { willReadFrequently: !!patch });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  patch?.(ctx);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
// Draw everything except upright text. Rotated text stays in the picture, since it can't become a normal line of text.
const withoutText = ctx => {
  for (const fn of ['fillText', 'strokeText']) {
    const orig = ctx[fn];
    ctx[fn] = function (...a) {
      const t = this.getTransform();
      if (!(t.a > 0 && Math.abs(t.b) < .05 * t.a)) return orig.apply(this, a);
    };
  }
};
// Render a page to JPEG; `draw` can paint on it first (used by Redact).
async function pageJpeg(view, n, dpi, q, draw) {
  const c = await renderPage(view, n, dpi / 72);
  draw?.(c.getContext('2d'), c);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  return { bytes: await blob.arrayBuffer(), w: c.width * 72 / dpi, h: c.height * 72 / dpi };
}
async function addImagePage(doc, part) {
  const img = await doc.embedJpg(part.bytes);
  doc.addPage([part.w, part.h]).drawImage(img, { x: 0, y: 0, width: part.w, height: part.h });
}
async function rasterize(view, dpi, q) {
  const out = await PDFLib.PDFDocument.create();
  for (let i = 1; i <= view.numPages; i++) {
    progress(`Page ${i} of ${view.numPages}`, i / view.numPages);
    await addImagePage(out, await pageJpeg(view, i, dpi, q));
  }
  return out.save();
}

// A page as the reader sees it, honouring /Rotate and the crop box.
// at(dx, dy) turns a point measured from the visible top-left (in pt) into PDF coordinates.
function frame(page) {
  const { x, y, width: W, height: H } = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const [o, R, D] = {
    0: [[x, y + H], [1, 0], [0, -1]], 90: [[x, y], [0, 1], [1, 0]],
    180: [[x + W, y], [-1, 0], [0, 1]], 270: [[x + W, y + H], [0, -1], [-1, 0]],
  }[r];
  return { r, w: r % 180 ? H : W, h: r % 180 ? W : H, at: (dx, dy) => ({ x: o[0] + R[0] * dx + D[0] * dy, y: o[1] + R[1] * dx + D[1] * dy }) };
}
// Draw text whose baseline starts at (dx, dy) in visible-page space; `turn` tilts it (degrees, counter-clockwise).
function drawLabel(page, text, dx, dy, { turn = 0, ...opts }) {
  const f = frame(page), p = f.at(dx, dy);
  page.drawText(text, { ...opts, x: p.x, y: p.y, rotate: PDFLib.degrees(f.r + turn) });
}

/* =====================================================================
   Page layout analysis (PDF to Word, PDF to Excel)
   Coordinates are points from the visible page's top-left, like the reader sees it.
   ===================================================================== */

// Word font for a PDF font: "ABCDEF+Calibri-BoldItalic" -> Calibri, bold, italic.
const FONT_MAP = [[/arial|helvetica|arimo|liberationsans|nimbussans/i, 'Arial'], [/times|tinos|liberationserif|nimbusrom/i, 'Times New Roman'],
  [/courier|cousine|liberationmono|nimbusmon/i, 'Courier New'], [/calibri|carlito/i, 'Calibri'], [/cambria|caladea/i, 'Cambria'],
  [/georgia/i, 'Georgia'], [/verdana/i, 'Verdana'], [/tahoma/i, 'Tahoma'], [/trebuchet/i, 'Trebuchet MS'], [/garamond/i, 'Garamond'],
  [/segoe/i, 'Segoe UI'], [/symbol/i, 'Symbol'], [/consolas/i, 'Consolas'], [/palatino|book ?antiqua/i, 'Palatino Linotype'], [/century/i, 'Century Gothic']];
function fontInfo(font, style) {
  const raw = (font?.name || '').replace(/^[A-Z]{6}\+/, '');
  const base = raw.split(/[-,]/)[0].replace(/(PSMT|MT|PS|Std|Pro|LT)$/, '');
  let family = FONT_MAP.find(([re]) => re.test(raw))?.[1];
  if (!family && /^[A-Za-z][A-Za-z ]{2,}$/.test(base) && !/^(F\d|T\d|g_d)/.test(base)) family = base.replace(/([a-z])([A-Z])/g, '$1 $2');
  family ||= { serif: 'Times New Roman', monospace: 'Courier New' }[style?.fontFamily] || 'Arial';
  return {
    family,
    bold: !!font?.bold || !!font?.black || /bold|black|heavy|semibold|demi/i.test(raw),
    italic: !!font?.italic || /italic|oblique/i.test(raw),
  };
}

const sameColor = (a, b, tol = 40) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;
// The most common colour in a block of pixels (quantised), i.e. the background behind some text.
function dominant(img, x0, y0, x1, y1, step = 1) {
  const counts = new Map();
  let best = [255, 255, 255], top = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4, k = (img.data[i] >> 4) << 8 | (img.data[i + 1] >> 4) << 4 | img.data[i + 2] >> 4;
    const c = (counts.get(k) || 0) + 1;
    counts.set(k, c);
    if (c > top) { top = c; best = [img.data[i], img.data[i + 1], img.data[i + 2]]; }
  }
  return best;
}
// The colour of text: the pixel furthest from the background inside its box.
function inkColor(img, S, it) {
  const x0 = Math.max(0, Math.floor(it.x0 * S)), x1 = Math.min(img.width, Math.ceil(it.x1 * S));
  const y0 = Math.max(0, Math.floor(it.top * S)), y1 = Math.min(img.height, Math.ceil(it.bottom * S));
  if (x1 <= x0 || y1 <= y0) return '000000';
  const bg = dominant(img, x0, y0, x1, y1, 2);
  let far = 0, ink = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4, d = Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]);
    if (d > far) { far = d; ink = [img.data[i], img.data[i + 1], img.data[i + 2]]; }
  }
  if (ink.every(v => v < 60)) return '000000';
  return ink.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Regions of ink (drawings, charts, logos) in a picture of the page, found on a 4 pt grid.
function inkRegions(img, S, bg, skip) {
  const g = 4, cw = Math.ceil(img.width / (g * S)), ch = Math.ceil(img.height / (g * S)), ink = new Uint8Array(cw * ch);
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const i = (y * img.width + x) * 4;
    if (!sameColor([img.data[i], img.data[i + 1], img.data[i + 2]], bg, 45)) ink[Math.floor(y / (g * S)) * cw + Math.floor(x / (g * S))] = 1;
  }
  for (const r of skip) for (let y = Math.floor(r.y / g); y <= Math.ceil((r.y + r.h) / g); y++) for (let x = Math.floor(r.x / g); x <= Math.ceil((r.x + r.w) / g); x++) {
    if (x >= 0 && y >= 0 && x < cw && y < ch) ink[y * cw + x] = 0;
  }
  const seen = new Uint8Array(cw * ch), regions = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    const r = { x0: cw, y0: ch, x1: 0, y1: 0, n: 0 }, queue = [s];
    seen[s] = 1;
    while (queue.length) {
      const k = queue.pop(), x = k % cw, y = (k - x) / cw;
      r.n++; r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x); r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { // join pieces up to two cells apart
        const nx = x + dx, ny = y + dy, nk = ny * cw + nx;
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && ink[nk] && !seen[nk]) { seen[nk] = 1; queue.push(nk); }
      }
    }
    regions.push({ x: r.x0 * g, y: r.y0 * g, w: (r.x1 - r.x0 + 1) * g, h: (r.y1 - r.y0 + 1) * g, fill: r.n / ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)) });
  }
  return regions;
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const inside = (it, r) => { const cx = (it.x0 + it.x1) / 2, cy = (it.top + it.bottom) / 2; return cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h; };
// Merge rectangles that overlap or nearly touch (images are often sliced into strips).
function mergeRects(rects, gap = 3) {
  const out = rects.map(r => ({ ...r }));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h) {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, vector: a.vector || b.vector };
        out.splice(j, 1);
        changed = true;
        j--;
      }
    }
  }
  return out;
}
const crop = (canvas, r, S) => {
  const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(r.w * S)), height: Math.max(1, Math.round(r.h * S)) });
  c.getContext('2d').drawImage(canvas, r.x * S, r.y * S, r.w * S, r.h * S, 0, 0, c.width, c.height);
  return c;
};
const canvasBytes = async (c, type, q) => new Uint8Array(await (await new Promise(r => c.toBlob(r, type, q))).arrayBuffer());

// Text recognition for scanned pages, shared across pages and started only when a page needs it.
function makeOcr(lang) {
  let worker;
  return {
    async recognize(canvas) {
      if (!worker) {
        await need('tesseract');
        worker = await Tesseract.createWorker();
        await worker.loadLanguage(lang);
        await worker.initialize(lang);
      }
      return (await worker.recognize(canvas)).data;
    },
    done: () => worker?.terminate(),
  };
}

/* Read one page: its words (with font, size and colour when `rich`), and, for `rich`, its pictures and a
   background picture without the text. `ocr` reads scanned pages that have no text of their own. */
async function analyzePage(view, n, { rich = false, fonts = false, ocr = null } = {}) {
  const { Util, OPS } = pdfjsLib;
  const page = await view.getPage(n), vp = page.getViewport({ scale: 1 });
  const out = { W: vp.width, H: vp.height, items: [], images: [], figures: [], background: null, hiddenText: false };

  if (rich) { // walk the drawing operations: where images go, and whether the text is invisible (an OCR layer)
    const ops = await page.getOperatorList(), stack = [];
    let ctm = [1, 0, 0, 1, 0, 0], mode = 0, shown = 0, hidden = 0;
    const TEXT = [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText];
    const place = m => {
      const p = [[0, 0], [1, 0], [0, 1], [1, 1]].map(q => Util.applyTransform(Util.applyTransform(q, m), vp.transform));
      const xs = p.map(q => q[0]), ys = p.map(q => q[1]), r = { x: Math.min(...xs), y: Math.min(...ys) };
      r.w = Math.max(...xs) - r.x; r.h = Math.max(...ys) - r.y;
      if (r.w > 8 && r.h > 8) out.images.push(r);
    };
    ops.fnArray.forEach((fn, i) => {
      const a = ops.argsArray[i];
      if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) { stack.push([ctm, mode]); if (fn !== OPS.save && a?.[0]) ctm = Util.transform(ctm, a[0]); }
      else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) [ctm, mode] = stack.pop() || [ctm, mode];
      else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
      else if (fn === OPS.setTextRenderingMode) mode = a[0];
      else if (TEXT.includes(fn)) mode === 3 || mode === 7 ? hidden++ : shown++;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) place(ctm);
      else if (fn === OPS.paintImageXObjectRepeat) for (let j = 0; j < a[3].length; j += 2) place(Util.transform(ctm, [a[1], 0, 0, a[2], a[3][j], a[3][j + 1]]));
    });
    out.hiddenText = hidden > 0 && hidden >= shown * 4;
  }

  if (fonts && !rich) await page.getOperatorList(); // loads the fonts, so their names and styles can be read
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (!it.str?.trim()) continue;
    const m = Util.transform(vp.transform, it.transform), size = Math.hypot(m[2], m[3]);
    if (size < 2 || !(m[0] > 0) || Math.abs(m[1]) > .05 * m[0]) continue; // ponytail: rotated text isn't extracted (it stays in the page picture)
    const st = tc.styles[it.fontName] || {};
    let font = { family: { serif: 'Times New Roman', monospace: 'Courier New' }[st.fontFamily] || 'Arial', bold: false, italic: false };
    if (rich || fonts) try { font = fontInfo(page.commonObjs.get(it.fontName), st); } catch { /* font not loaded: keep the generic one */ }
    const asc = st.ascent > .5 ? st.ascent : .8, desc = st.descent < 0 ? st.descent : -.2;
    const width = it.width > 0 ? it.width : size * it.str.length * .5, total = it.str.length;
    let off = 0;
    for (const part of it.str.split(/(\s{3,})/)) { // wide runs of spaces separate table cells
      const lead = part.length - part.trimStart().length;
      if (part.trim()) out.items.push({
        str: part.trim(), size, base: m[5], top: m[5] - asc * size, bottom: m[5] - desc * size,
        x0: m[4] + width * (off + lead) / total, x1: m[4] + width * (off + part.trimEnd().length) / total, ...font, hidden: out.hiddenText,
      });
      off += part.length;
    }
  }

  const needOcr = ocr && !out.items.length; // only pages with no text of their own are read as scans
  if (!rich && !needOcr) return out;

  const S = 2, full = await renderPage(view, n, S), fullImg = full.getContext('2d').getImageData(0, 0, full.width, full.height);
  if (needOcr) {
    progress(`Recognising text on page ${n}`);
    const data = await ocr.recognize(full);
    for (const line of data.lines) {
      const lh = (line.bbox.y1 - line.bbox.y0) / S, base = line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 / S : line.bbox.y1 / S;
      for (const w of line.words) {
        if (!w.text.trim() || w.confidence < 15) continue;
        out.items.push({ str: w.text.trim(), size: Math.max(6, lh * .78), base, top: w.bbox.y0 / S, bottom: w.bbox.y1 / S, x0: w.bbox.x0 / S, x1: w.bbox.x1 / S, family: 'Arial', bold: !!w.is_bold, italic: !!w.is_italic, hidden: true });
      }
    }
  }
  if (!rich) return out;

  for (const it of out.items) it.color = inkColor(fullImg, S, it);
  // Background: the page without its upright text; text that only exists inside a scan is painted over.
  const bare = await renderPage(view, n, S, withoutText), bctx = bare.getContext('2d'), bareImg0 = bctx.getImageData(0, 0, bare.width, bare.height);
  const pageBg = dominant(bareImg0, 0, 0, bare.width, bare.height, 7);
  for (const it of out.items.filter(i => i.hidden)) {
    const x0 = Math.max(0, Math.floor(it.x0 * S) - 2), y0 = Math.max(0, Math.floor(it.top * S) - 2);
    const x1 = Math.min(bare.width, Math.ceil(it.x1 * S) + 2), y1 = Math.min(bare.height, Math.ceil(it.bottom * S) + 2);
    if (x1 > x0 && y1 > y0) { bctx.fillStyle = `rgb(${dominant(bareImg0, x0, y0, x1, y1, 2)})`; bctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
  }
  const bareImg = bctx.getImageData(0, 0, bare.width, bare.height);
  const vectors = inkRegions(bareImg, S, pageBg, out.images);
  out.background = vectors.length || out.images.length ? bare : null;
  out.pageBg = pageBg;
  out.bareCanvas = bare;
  out.fullCanvas = full;
  out.S = S;
  out.vectors = vectors;
  return out;
}

// Group words into lines (shared baseline), and lines into segments split at wide gaps (columns, cells).
function toLines(items) {
  const lines = [];
  for (const it of [...items].sort((a, b) => a.base - b.base || a.x0 - b.x0)) {
    let ln;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) { // only recent lines can share a baseline
      if (Math.abs(lines[k].base - it.base) < Math.max(lines[k].size, it.size) * .35) { ln = lines[k]; break; }
    }
    if (ln) { ln.items.push(it); ln.size = Math.max(ln.size, it.size); ln.top = Math.min(ln.top, it.top); ln.bottom = Math.max(ln.bottom, it.bottom); }
    else lines.push({ base: it.base, size: it.size, top: it.top, bottom: it.bottom, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x0 - b.x0);
    l.segs = [];
    let cur;
    for (const it of l.items) {
      if (!cur || it.x0 - cur.x1 > l.size * 1.2) l.segs.push(cur = { x0: it.x0, x1: it.x1, items: [], line: l });
      cur.items.push(it);
      cur.x1 = Math.max(cur.x1, it.x1);
    }
    for (const s of l.segs) {
      s.text = joinWords(s.items);
      Object.assign(s, { top: l.top, bottom: l.bottom, base: l.base, size: Math.max(...s.items.map(i => i.size)) });
    }
    l.x0 = l.segs[0].x0;
    l.x1 = Math.max(...l.segs.map(s => s.x1));
  }
  return lines.sort((a, b) => a.base - b.base);
}
const spaceBefore = (p, it) => p && it.x0 - p.x1 > Math.min(p.size, it.size) * .15 && !p.str.endsWith(' ') && !it.str.startsWith(' ');
const joinWords = items => items.reduce((s, it, i) => s + (spaceBefore(items[i - 1], it) ? ' ' : '') + it.str, '');

// Tables: runs of lines with two or more cells, whose cells line up in columns ("whitespace rivers").
function findTables(lines) {
  const tables = [];
  let block = [];
  const flush = () => {
    if (block.length >= 2) {
      const spans = [];
      for (const s of block.flatMap(l => l.segs).sort((a, b) => a.x0 - b.x0)) {
        const last = spans.at(-1);
        if (last && s.x0 <= last.x1 + 1) last.x1 = Math.max(last.x1, s.x1);
        else spans.push({ x0: s.x0, x1: s.x1 });
      }
      const cols = spans.map(sp => block.flatMap(l => l.segs).filter(s => s.x0 >= sp.x0 - 1 && s.x0 <= sp.x1 + 1));
      const prose = cols.every(c => c.reduce((n, s) => n + s.text.length, 0) / c.length > 28); // side-by-side text columns, not a table
      if (spans.length >= 2 && !prose) {
        const rows = block.map(l => {
          const cells = spans.map(() => []);
          for (const s of l.segs) cells[Math.max(0, spans.findIndex(sp => s.x0 >= sp.x0 - 1 && s.x0 <= sp.x1 + 1))].push(s);
          return { line: l, cells };
        });
        // a row that only continues the cells above it (wrapped text) is folded into that row
        const pitch = median(rows.slice(1).map((r, i) => r.line.top - rows[i].line.top));
        const merged = [];
        for (const r of rows) {
          const prev = merged.at(-1), filled = r.cells.filter(c => c.length).length;
          if (prev && filled < spans.length && r.line.top - prev.line.top < pitch * .7) r.cells.forEach((c, k) => prev.cells[k].push(...c));
          else merged.push(r);
        }
        tables.push({ spans, rows: merged, top: block[0].top, bottom: block.at(-1).bottom, x0: spans[0].x0, x1: spans.at(-1).x1, lines: new Set(block) });
      }
    }
    block = [];
  };
  for (const l of lines) {
    const prev = block.at(-1);
    if (l.segs.length >= 2 && (!prev || l.top - prev.bottom < l.size * 2.5)) block.push(l);
    else { flush(); if (l.segs.length >= 2) block.push(l); }
  }
  flush();
  return tables;
}

/* Figures on a page: embedded images plus drawings (charts, diagrams, logos), ignoring tables and boxes around text. */
function findFigures(pg, tables) {
  const textArea = r => pg.items.filter(it => inside(it, r)).reduce((a, it) => a + (it.x1 - it.x0) * (it.bottom - it.top), 0);
  const vectors = (pg.vectors || []).filter(r =>
    r.w >= 36 && r.h >= 28 && !(r.w > pg.W * .92 && r.h > pg.H * .92) &&
    textArea(r) / (r.w * r.h) < .15 &&
    !tables.some(t => overlap(r, { x: t.x0, y: t.top, w: t.x1 - t.x0, h: t.bottom - t.top }) > .3 * (t.x1 - t.x0) * (t.bottom - t.top)))
    .map(r => ({ ...r, vector: true }));
  const figs = mergeRects([...pg.images, ...vectors]);
  // drawings take in the short labels right next to them (chart axes, legends), so they stay part of the picture
  for (const f of figs.filter(f => f.vector)) {
    for (let grew = true; grew;) {
      grew = false;
      for (const it of pg.items) {
        if (inside(it, f) || it.str.length > 14) continue;
        const near = it.x1 > f.x - 14 && it.x0 < f.x + f.w + 14 && it.bottom > f.y - 14 && it.top < f.y + f.h + 14;
        if (near) {
          const x = Math.min(f.x, it.x0 - 2), y = Math.min(f.y, it.top - 2);
          Object.assign(f, { x, y, w: Math.max(f.x + f.w, it.x1 + 2) - x, h: Math.max(f.y + f.h, it.bottom + 2) - y });
          grew = true;
        }
      }
    }
  }
  return figs.map(r => {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return { ...r, x, y, w: Math.min(pg.W, r.x + r.w) - x, h: Math.min(pg.H, r.y + r.h) - y };
  }).filter(r => r.w > 8 && r.h > 8);
}

/* ---------- Word (.docx) writer ---------- */
const xml = s => esc(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const tw = pt => Math.round(pt * 20);   // twentieths of a point
const emu = pt => Math.round(pt * 12700);

function docxWriter() {
  const media = [];
  let ids = 0;
  const graphic = (rid, w, h, id) => `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  return {
    media,
    addImage(bytes, ext) { const rid = `rIdImg${media.length + 1}`; media.push({ rid, name: `image${media.length + 1}.${ext}`, bytes }); return rid; },
    inline(rid, w, h) { const id = ++ids; return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic(rid, w, h, id)}</wp:inline></w:drawing></w:r>`; },
    anchor(rid, x, y, w, h, behind = true) {
      const id = ++ids;
      return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${behind ? id : 251658240 + id}" behindDoc="${behind ? 1 : 0}" locked="1" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(y)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic(rid, w, h, id)}</wp:anchor></w:drawing></w:r>`;
    },
    // A borderless text box at a fixed place on the page that never wraps and grows to fit its text.
    textBox(x, y, w, h, paragraph) {
      const id = ++ids;
      return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(y)}</wp:posOffset></wp:positionV><wp:extent cx="${emu(w)}" cy="${emu(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Text ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent>${paragraph}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>`;
    },
    async pack(body, sect) {
      await need('jszip');
      const zip = new JSZip(), NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
      const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
      zip.file('[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`);
      zip.file('word/settings.xml', `${head}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
      zip.file('_rels/.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
      zip.file('word/_rels/document.xml.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`);
      const border = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6ABB8"/>`;
      zip.file('word/styles.xml', `${head}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`).join('')}<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
      zip.file('word/document.xml', `${head}<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`);
      media.forEach(m => zip.file(`word/media/${m.name}`, m.bytes));
      return zip.generateAsync({ type: 'blob', mimeType: MIME.docx });
    },
  };
}
const sectXml = (W, H, m = { t: 0, r: 0, b: 0, l: 0 }) => `<w:sectPr><w:pgSz w:w="${tw(W)}" w:h="${tw(H)}"${W > H ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(m.t)}" w:right="${tw(m.r)}" w:bottom="${tw(m.b)}" w:left="${tw(m.l)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

// Runs of text with one style each. `fit` stretches letter spacing so each run is as wide as in the PDF.
const measurer = document.createElement('canvas').getContext('2d');
function runsXml(items, fit = false) {
  const runs = [];
  items.forEach((it, i) => {
    const space = spaceBefore(items[i - 1], it) ? ' ' : '';
    const key = [it.family, it.bold, it.italic, Math.round(it.size * 2), it.color].join('|'), last = runs.at(-1);
    if (last?.key === key) { last.text += space + it.str; last.x1 = it.x1; }
    else { if (last && space) last.text += ' '; runs.push({ key, it, text: it.str, x0: it.x0, x1: it.x1 }); }
  });
  return runs.map(({ it, text, x0, x1 }) => {
    const size = Math.round(it.size * 2) / 2, font = xml(it.family);
    let spacing = 0;
    if (fit && text.length > 1) {
      measurer.font = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}${size}px "${it.family}", Arial, sans-serif`;
      const diff = (x1 - x0) - measurer.measureText(text).width;
      if (Math.abs(diff) > (x1 - x0) * .02) spacing = Math.max(-30, Math.min(40, Math.round(diff / (text.length - 1) * 20)));
    }
    const rPr = `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${it.bold ? '<w:b/>' : ''}${it.italic ? '<w:i/>' : ''}${it.color && it.color !== '000000' ? `<w:color w:val="${it.color}"/>` : ''}${spacing ? `<w:spacing w:val="${spacing}"/>` : ''}<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>`;
    return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  }).join('');
}

/* The page picture with its paper made see-through, so it sits on Word's own page in light or dark mode.
   Pictures from the PDF stay solid, even where they're white. */
function paperless(pg) {
  const c = Object.assign(document.createElement('canvas'), { width: pg.background.width, height: pg.background.height }), ctx = c.getContext('2d');
  ctx.drawImage(pg.background, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, S = pg.S;
  const solid = pg.images.map(r => [r.x * S, r.y * S, (r.x + r.w) * S, (r.y + r.h) * S]);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (sameColor([d[i], d[i + 1], d[i + 2]], pg.pageBg, 30) && !solid.some(([a, b, e, f]) => x >= a && x < e && y >= b && y < f)) d[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* Exact layout: every page is its own Word page of the same size. The page's graphics sit behind as one picture;
   each piece of text is a text box at its exact place, with its original font, size and colour. Text boxes (not the
   older Word "frames") so that Pages, LibreOffice and Google Docs place them correctly too. */
async function wordExact(doc, pg, last) {
  let shapes = '';
  if (pg.background) shapes += doc.anchor(doc.addImage(await canvasBytes(paperless(pg), 'image/png'), 'png'), 0, 0, pg.W, pg.H);
  for (const l of toLines(pg.items)) for (const s of l.segs) {
    const top = s.base - s.size * .96; // with an exact line of 1.2 x size, the baseline sits about 0.96 x size below the top
    const x = Math.max(0, s.x0), w = Math.min(pg.W - x, (s.x1 - s.x0) * 1.08 + s.size + 6);
    shapes += doc.textBox(x, Math.max(0, top), w, s.size * 1.25,
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${tw(s.size * 1.2)}" w:lineRule="exact"/></w:pPr>${runsXml(s.items, true)}</w:p>`);
  }
  // all of the page's shapes hang off one tiny paragraph; the section break after it starts the next page
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${shapes}</w:p>` +
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${last ? '' : sectXml(pg.W, pg.H)}</w:pPr></w:p>`;
}

/* Flowing layout: real paragraphs, headings, tables and pictures in reading order, easiest to edit. */
async function wordFlow(doc, pg, ctx) {
  const lines = toLines(pg.items), tables = findTables(lines), figures = findFigures(pg, tables);
  const hasText = pg.items.length > 0;
  const figs = figures.filter(f => !(hasText && f.w * f.h > pg.W * pg.H * .85)); // a full-page picture behind text is decoration
  const used = new Set();
  for (const f of figs) if (f.vector) pg.items.forEach(it => inside(it, f) && used.add(it));
  // reading units: table blocks, figures, and the remaining text segments
  const units = [];
  for (const t of tables) units.push({ kind: 'table', t, top: t.top, x0: t.x0, x1: t.x1 });
  for (const f of figs) units.push({ kind: 'fig', f, top: f.y, x0: f.x, x1: f.x + f.w });
  for (const l of lines) if (![...tables].some(t => t.lines.has(l))) for (const s of l.segs) {
    const items = s.items.filter(it => !used.has(it));
    if (items.length) units.push({ kind: 'text', s: { ...s, items, text: joinWords(items) }, top: s.top, x0: items[0].x0, x1: Math.max(...items.map(i => i.x1)) });
  }
  const colX = columnSplit(units.filter(u => u.kind === 'text'), pg.W);
  units.sort((a, b) => a.top - b.top);
  const ordered = [];
  if (colX) { // two text columns: between full-width pieces, read the left column, then the right
    let left = [], right = [];
    const flush = () => { ordered.push(...left, ...right); left = []; right = []; };
    for (const u of units) {
      if (u.x1 <= colX + 2) left.push(u);
      else if (u.x0 >= colX - 2) right.push(u);
      else { flush(); ordered.push(u); }
    }
    flush();
  } else ordered.push(...units);

  const L = ctx.margin.l, R = pg.W - ctx.margin.r, textW = R - L;
  const colOf = u => !colX ? [L, R] : u.x1 <= colX + 2 ? [L, colX - 6] : u.x0 >= colX - 2 ? [colX + 6, R] : [L, R];
  let body = '', para = null;
  const flushPara = next => {
    if (!para) return;
    const p = para, [c0, c1] = p.col, cw = c1 - c0, first = p.segs[0], size = first.size;
    const x0 = Math.min(...p.segs.map(s => s.x0)), x1 = Math.max(...p.segs.map(s => s.x1));
    const mid = (x0 + x1) / 2, multi = p.segs.length > 1;
    let jc = '';
    if (!multi && Math.abs(mid - (c0 + c1) / 2) < cw * .04 && x0 - c0 > cw * .1) jc = 'center';
    else if (!multi && Math.abs(x1 - c1) < size * 1.5 && x0 - c0 > cw * .35) jc = 'right';
    else if (multi && p.segs.slice(0, -1).every(s => c1 - s.x1 < size * 2)) jc = 'both';
    const ratio = size / ctx.body, heading = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : ratio >= 1.12 && first.items.every(i => i.bold) && p.text.length < 120 ? 3 : 0;
    const ind = jc === 'center' || jc === 'right' ? 0 : Math.max(0, Math.min(...p.segs.slice(multi ? 1 : 0).map(s => s.x0)) - c0);
    const firstLine = multi ? first.x0 - c0 - ind : 0;
    const pitch = multi ? median(p.segs.slice(1).map((s, i) => s.base - p.segs[i].base)) : 0;
    const gap = next ? Math.max(0, Math.min(36, next.top - p.segs.at(-1).bottom)) : 6;
    const pPr = `${heading ? `<w:pStyle w:val="Heading${heading}"/>` : ''}<w:spacing w:before="0" w:after="${tw(gap)}"${pitch > size * .9 && pitch < size * 2.4 ? ` w:line="${tw(pitch)}" w:lineRule="exact"` : ''}/>${ind > 2 || Math.abs(firstLine) > 2 ? `<w:ind w:left="${tw(ind)}"${firstLine > 2 ? ` w:firstLine="${tw(firstLine)}"` : firstLine < -2 ? ` w:hanging="${tw(-firstLine)}"` : ''}/>` : ''}${jc ? `<w:jc w:val="${jc}"/>` : ''}`;
    // join lines: a hyphen at the end of a line followed by a lower-case word is a broken word
    const items = [];
    p.segs.forEach((s, k) => {
      const its = s.items.map(i => ({ ...i }));
      if (k && items.length) {
        const prev = items.at(-1);
        if (/[A-Za-z]-$/.test(prev.str) && /^\p{Ll}/u.test(its[0].str)) prev.str = prev.str.slice(0, -1);
        else prev.str += ' ';
        its[0] = { ...its[0], x0: -1e9 }; // never insert another space
      }
      items.push(...its);
    });
    body += `<w:p><w:pPr>${pPr}</w:pPr>${runsXml(items)}</w:p>`;
    para = null;
  };
  for (let k = 0; k < ordered.length; k++) {
    const u = ordered[k], next = ordered[k + 1];
    if (u.kind === 'text') {
      const s = u.s, col = colOf(u), prev = para?.segs.at(-1);
      const bullet = /^([•▪◦‣●○■□\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/.test(s.text);
      // the line above must run (nearly) full width: to the column edge, or about as far as this line does
      const full = prev && (col[1] - prev.x1 < prev.size * 6 || prev.x1 > s.x1 - prev.size * 5);
      const joins = prev && full && para.col[0] === col[0] && Math.abs(prev.size - s.size) < .6 && s.top - prev.bottom < prev.size * .9 &&
        Math.abs(s.x0 - para.segs[para.segs.length > 1 ? 1 : 0].x0) < s.size * 2.2 && !bullet;
      if (!joins) { flushPara(u); para = { segs: [], col, text: '' }; }
      para.segs.push(s);
      para.text += s.text;
      if (!next || next.kind !== 'text') flushPara(next);
    } else if (u.kind === 'fig') {
      // pictures side by side (overlapping rows) share one line, in left-to-right order
      const row = [u];
      while (ordered[k + 1]?.kind === 'fig' && ordered[k + 1].f.y < Math.max(...row.map(r => r.f.y + r.f.h)) - 4) row.push(ordered[++k]);
      row.sort((a, b) => a.f.x - b.f.x);
      const after = ordered[k + 1], [c0, c1] = colOf(u);
      const x0 = row[0].f.x, x1 = Math.max(...row.map(r => r.f.x + r.f.w)), bottom = Math.max(...row.map(r => r.f.y + r.f.h));
      const s = Math.min(1, (c1 - c0) * .97 / (x1 - x0), ...row.map(r => (pg.H - ctx.margin.t - ctx.margin.b) / r.f.h));
      let runs = '', cursor = x0;
      for (const { f } of row) {
        const photo = !f.vector, c = crop(f.vector ? pg.fullCanvas : pg.bareCanvas, f, pg.S);
        const rid = doc.addImage(await canvasBytes(c, photo ? 'image/jpeg' : 'image/png', .9), photo ? 'jpeg' : 'png');
        const gapPt = (f.x - cursor) * s;
        if (cursor !== x0 && gapPt > 2) runs += `<w:r><w:rPr><w:spacing w:val="${tw(gapPt - 3)}"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r>`;
        runs += doc.inline(rid, f.w * s, f.h * s);
        cursor = f.x + f.w;
      }
      const centered = Math.abs((x0 + x1) / 2 - (c0 + c1) / 2) < (c1 - c0) * .08;
      const gap = after ? Math.max(4, Math.min(24, after.top - bottom)) : 6;
      body += `<w:p><w:pPr><w:spacing w:before="0" w:after="${tw(gap)}"/>${centered ? '<w:jc w:val="center"/>' : x0 - c0 > 4 ? `<w:ind w:left="${tw(Math.max(0, Math.min(x0 - c0, c1 - c0 - (x1 - x0) * s)))}"/>` : ''}</w:pPr>${runs}</w:p>`;
    } else {
      // each column as wide as the gap to the next one, and never narrower than its text plus the cell padding
      const t = u.t, widths = t.spans.map((sp, i) => Math.max((t.spans[i + 1]?.x0 ?? 0) - sp.x0, sp.x1 - sp.x0 + 16)), sum = widths.reduce((a, b) => a + b, 0);
      const scale = Math.min(1, textW / sum), grid = widths.map(w => tw(w * scale));
      body += `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${grid.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${grid.map(g => `<w:gridCol w:w="${g}"/>`).join('')}</w:tblGrid>` +
        t.rows.map(r => `<w:tr>${r.cells.map((cell, i) => `<w:tc><w:tcPr><w:tcW w:w="${grid[i]}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runsXml(cell.flatMap((s, k) => k ? [{ ...s.items[0], str: ' ' + s.items[0].str, x0: -1e9 }, ...s.items.slice(1)] : s.items))}</w:p></w:tc>`).join('')}</w:tr>`).join('') +
        `</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="${tw(8)}"/></w:pPr></w:p>`;
    }
  }
  return body;
}
// A vertical gutter between two text columns, if the page has one.
function columnSplit(units, W) {
  if (units.length < 10) return null;
  const step = 2, bins = new Uint16Array(Math.ceil(W / step) + 1);
  units.forEach(u => { for (let x = Math.max(0, Math.floor(u.x0 / step)); x <= Math.min(bins.length - 1, Math.floor(u.x1 / step)); x++) bins[x]++; });
  let best = null, start = -1;
  const lo = Math.floor(W * .3 / step), hi = Math.ceil(W * .7 / step);
  for (let i = lo; i <= hi + 1; i++) {
    const free = i <= hi && bins[i] <= units.length * .05;
    if (free && start < 0) start = i;
    if (!free && start >= 0) { if ((i - start) * step >= 10 && (!best || i - start > best.len)) best = { len: i - start, x: (start + i) / 2 * step }; start = -1; }
  }
  if (!best) return null;
  const left = units.filter(u => u.x1 < best.x).length, right = units.filter(u => u.x0 > best.x).length;
  return left >= 4 && right >= 4 ? best.x : null;
}

/* ---------- Excel helpers ---------- */
const NUM = /^(\()?([-−+])?\s?([$€£₹¥])?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%)?(\))?$/;
// "1,200" -> 1200, "(3.50)" -> -3.5, "12%" -> 0.12 shown as a percentage, "007" stays text.
function typed(s) {
  const t = s.trim(), m = t.match(NUM);
  if (!m || (m[4].length > 1 && m[4][0] === '0')) return t;
  let v = parseFloat(m[4].replace(/,/g, '') + (m[5] || ''));
  if (m[2] === '-' || m[2] === '−' || (m[1] && m[7])) v = -v;
  if (m[6]) return { t: 'n', v: v / 100, z: m[5] ? '0.00%' : '0%' };
  if (m[3]) return { t: 'n', v, z: `"${m[3]}"#,##0${m[5] ? '.00' : ''}` };
  return m[4].includes(',') ? { t: 'n', v, z: m[5] ? '#,##0.00' : '#,##0' } : v;
}
// One page as spreadsheet rows: tables in their columns, other lines with each piece in its own cell.
function pageRows(pg) {
  const lines = toLines(pg.items), tables = findTables(lines), rows = [], done = new Set();
  for (const l of lines) {
    const t = tables.find(t => t.lines.has(l));
    if (!t) { rows.push(l.segs.map(s => typed(s.text))); continue; }
    if (done.has(t)) continue;
    done.add(t);
    if (rows.length && rows.at(-1).length) rows.push([]);
    for (const r of t.rows) rows.push(r.cells.map(c => typed(c.map(s => s.text).join(' '))));
    rows.push([]);
  }
  return rows;
}

/* ---------- Form snippets ---------- */
const sel = (id, label, opts) => `<label class="field"><span class="field-label">${label}</span><span class="select-wrap"><select id="${id}" class="input">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></span></label>`;
const inp = (id, label, attrs = '') => `<label class="field"><span class="field-label">${label}</span><input id="${id}" class="input" ${attrs}></label>`;
const check = (id, label, on = true) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span><span>${label}</span></label>`;
const row = (...fields) => `<div class="field-row">${fields.join('')}</div>`;
// On a touch screen, instructions talk about tapping, and leave out keyboard-only shortcuts.
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const say = t => !TOUCH ? t : t.replace(/\s*Shift-click picks a run\./g, '').replace(/ Press Enter when done, or Esc to undo\./g, ' Tap outside the line when done.')
  .replace(/\bClick/g, 'Tap').replace(/\bclick/g, 'tap');
const hint = t => `<p class="hint">${say(t)}</p>`;
// A segmented switch: marks the pressed button, and shows the panel named in data-show (hiding its siblings').
function segPick(btn) {
  const group = btn.closest('.seg');
  group.querySelectorAll('[data-k]').forEach(b => {
    b.setAttribute('aria-pressed', b === btn);
    const panel = $(`${group.id}-${b.dataset.k}`) || (group.id === 'o-wkind' && $(b.dataset.k === 'text' ? 'o-wtext' : 'o-wlogo'));
    panel?.classList.toggle('hidden', b !== btn);
  });
  group.dispatchEvent(new CustomEvent('pick', { detail: btn.dataset.k }));
}
const segValue = id => $(id)?.querySelector('[aria-pressed=true]')?.dataset.k;
const STAGE = `<div class="stage">
  <div class="stage-bar"><button type="button" class="chip" onclick="stageGo(-1)">${icon('chevron-left')}Previous</button><span id="stage-label" class="mono">Loading…</span><button type="button" class="chip" onclick="stageGo(1)">Next${icon('chevron-right')}</button></div>
  <div id="stage-page" class="stage-page" data-cursor="cross"><div id="stage-marks" class="stage-marks"></div></div>
</div>`;
const PDF = '.pdf,application/pdf';
const OCR_LANGS = [['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['hin', 'Hindi'], ['ara', 'Arabic'], ['chi_sim', 'Chinese (simplified)']];
const NO_TEXT = "This PDF has no text to convert, even after reading the scanned pages. Check the language setting, or try Read text (OCR).";

/* ---------- Page picker: thumbnails to click, kept in step with the page-range box ---------- */
const PICKER = '<div id="o-picker" class="picker"></div>';
// {1,2,3,5} -> "1-3, 5"
const rangesOf = nums => {
  const s = [...nums].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (s[j + 1] === s[j] + 1) j++; out.push(j > i ? `${s[i]}-${s[j]}` : `${s[i]}`); i = j; }
  return out.join(', ');
};
// "1-3, 5" -> {1,2,3,5}, ignoring anything that isn't a page yet (the box is being typed in)
const pagesIn = (str, n) => {
  const set = new Set();
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (m) for (let i = Math.max(1, +m[1]); i <= Math.min(n, +(m[2] || m[1])); i++) set.add(i);
  }
  return set;
};
const picker = { sel: new Set(), last: null, n: 0 };
async function pickerInit(file, mode = 'keep') {
  const box = $('o-picker'), input = $('o-ranges');
  if (!box || !input) return;
  const view = await openView(file);
  Object.assign(picker, { n: view.numPages, last: null, sel: pagesIn(input.value, view.numPages) });
  box.className = `picker ${mode}`;
  box.innerHTML = `<div class="picker-bar"><span class="label">${say(`${mode === 'remove' ? 'Click the pages to remove' : 'Click pages to choose them'}. Shift-click picks a run.`)}</span>
    <div class="row">${[['all', 'All'], ['none', 'None'], ['odd', 'Odd'], ['even', 'Even']].map(([k, t]) => `<button type="button" class="chip" data-p="${k}">${t}</button>`).join('')}</div></div>
    <div class="picks" id="o-picks"></div>`;
  const grid = $('o-picks');
  const paint = () => grid.querySelectorAll('[data-n]').forEach(b => { const on = picker.sel.has(+b.dataset.n); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  const sync = () => { input.value = rangesOf(picker.sel); paint(); };
  input.oninput = () => { picker.sel = pagesIn(input.value, picker.n); paint(); };
  box.querySelector('.picker-bar .row').onclick = e => {
    const k = e.target.closest('[data-p]')?.dataset.p;
    if (!k) return;
    picker.sel = new Set(k === 'none' ? [] : Array.from({ length: picker.n }, (_, i) => i + 1).filter(p => k === 'all' || (k === 'odd') === (p % 2 === 1)));
    sync();
  };
  grid.onclick = e => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    const p = +b.dataset.n;
    if (e.shiftKey && picker.last) {
      const on = !picker.sel.has(p);
      for (let i = Math.min(picker.last, p); i <= Math.max(picker.last, p); i++) on ? picker.sel.add(i) : picker.sel.delete(i);
    } else picker.sel.has(p) ? picker.sel.delete(p) : picker.sel.add(p);
    picker.last = p;
    sync();
  };
  for (let i = 1; i <= view.numPages; i++) {
    if (!grid.isConnected) return; // the user moved on to another file or tool
    const w = (await view.getPage(i)).getViewport({ scale: 1 }).width;
    const b = document.createElement('button');
    Object.assign(b, { type: 'button', className: 'pick' });
    b.dataset.n = i;
    b.setAttribute('aria-label', `Page ${i}`);
    b.innerHTML = `<span class="pick-img"></span><span class="pick-n mono">${i}</span><span class="pick-mark">${icon(mode === 'remove' ? 'x' : 'check')}</span>`;
    b.firstChild.append(await renderPage(view, i, 200 / w));
    grid.append(b);
    paint();
  }
}
// The pages a tool should work on: the box's pages, or every page when it's empty.
const pagesOr = (n, all = true) => val('o-ranges').trim() || !all ? parseRanges(val('o-ranges'), n) : Array.from({ length: n }, (_, i) => i);

/* ---------- The tools ---------- */
const GROUPS = [['organize', 'Organize'], ['optimize', 'Optimize'], ['to', 'Convert to PDF'], ['from', 'Convert from PDF'], ['edit', 'Edit & sign'], ['security', 'Security']];
const TOOLS = {
  merge: {
    group: 'organize', name: 'Merge PDFs', icon: 'combine', keys: 'combine join', featured: true,
    desc: 'Combine several PDFs into one, in the order you list them.',
    accept: PDF, multiple: true, ordered: true, note: 'Add two or more PDFs, then drag the arrows to set the order.',
    btn: 'Merge PDFs', libs: ['pdflib'],
    async run(files) {
      if (files.length < 2) throw new UserError('Add at least two PDFs to merge.');
      const out = await PDFLib.PDFDocument.create();
      for (const [k, f] of files.entries()) {
        progress(`Adding ${f.name}`, k / files.length);
        const src = await openPdf(f);
        (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
      }
      save(await out.save(), 'merged.pdf');
      return `Merged ${files.length} PDFs`;
    },
  },
  split: {
    group: 'organize', name: 'Split PDF', icon: 'split', keys: 'extract separate pages',
    desc: 'Pull out the pages you need, or break a PDF into separate files.',
    accept: PDF, btn: 'Split PDF', libs: ['pdflib'],
    options: () => row(
      sel('o-mode', 'How to split', [['pick', 'Chosen pages, as one PDF'], ['ranges', 'Each range as its own PDF'], ['every', 'Every page as its own PDF']]),
      inp('o-ranges', 'Pages', 'placeholder="1-3, 5" inputmode="numeric"')) + PICKER + hint('Several files download together as a .zip.'),
    async ready([f]) {
      $('o-mode').onchange = () => $('o-picker').classList.toggle('hidden', val('o-mode') === 'every');
      await pickerInit(f, 'keep');
    },
    async run([f]) {
      const src = await openPdf(f), n = src.getPageCount(), mode = val('o-mode');
      const make = async idx => {
        const d = await PDFLib.PDFDocument.create();
        (await d.copyPages(src, idx)).forEach(p => d.addPage(p));
        return d.save();
      };
      if (mode === 'pick') {
        save(await make(parseRanges(val('o-ranges'), n)), `${stem(f)}-pages.pdf`);
        return 'Split PDF saved';
      }
      const groups = mode === 'every' ? src.getPageIndices().map(i => [i])
        : val('o-ranges').split(',').filter(s => s.trim()).map(part => parseRanges(part, n));
      if (!groups.length) throw new UserError('Enter the ranges to split into, like 1-3, 4-6.');
      const out = [];
      for (const g of groups) out.push({ name: `${stem(f)}-${g[0] + 1}${g.length > 1 ? `-${g.at(-1) + 1}` : ''}.pdf`, data: await make(g) });
      await saveMany(out, `${stem(f)}-split.zip`);
      return `Split into ${plural(out.length, 'file')}`;
    },
  },
  remove: {
    group: 'organize', name: 'Remove pages', icon: 'file-minus', keys: 'delete',
    desc: "Delete the pages you don't need.",
    accept: PDF, btn: 'Remove pages', libs: ['pdflib'],
    options: () => inp('o-ranges', 'Pages to remove', 'placeholder="2, 7-9" inputmode="numeric"') + PICKER,
    ready: ([f]) => pickerInit(f, 'remove'),
    async run([f]) {
      const doc = await openPdf(f), n = doc.getPageCount();
      const drop = [...new Set(parseRanges(val('o-ranges'), n))];
      if (drop.length >= n) throw new UserError("You can't remove every page.");
      drop.sort((a, b) => b - a).forEach(i => doc.removePage(i));
      save(await doc.save(), `${stem(f)}-trimmed.pdf`);
      return `Removed ${plural(drop.length, 'page')}`;
    },
  },
  organize: {
    group: 'organize', name: 'Organize pages', icon: 'layout-grid', keys: 'reorder sort move delete rotate',
    desc: 'Reorder, turn or delete individual pages while you see them.',
    accept: PDF, btn: 'Save PDF', libs: ['pdflib', 'pdfjs'], wide: true,
    options: () => `<div id="o-thumbs" class="thumbs"><p class="hint">Loading pages…</p></div>`,
    async ready([f]) {
      const view = await openView(f);
      org = [];
      for (let i = 1; i <= view.numPages; i++) {
        const w = (await view.getPage(i)).getViewport({ scale: 1 }).width;
        org.push({ i: i - 1, rot: 0, c: await renderPage(view, i, 260 / w) });
        if (i === 1 || i % 8 === 0 || i === view.numPages) drawThumbs();
      }
      $('o-thumbs').onclick = e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const k = +b.dataset.k, act = b.dataset.act;
        if (act === 'del') org.length > 1 ? org.splice(k, 1) : showToast('A PDF needs at least one page.', true);
        if (act === 'rot') org[k].rot = (org[k].rot + 90) % 360;
        if (act === 'left' && k > 0) [org[k - 1], org[k]] = [org[k], org[k - 1]];
        if (act === 'right' && k < org.length - 1) [org[k + 1], org[k]] = [org[k], org[k + 1]];
        drawThumbs();
      };
    },
    async run([f]) {
      const src = await openPdf(f), out = await PDFLib.PDFDocument.create();
      const pages = await out.copyPages(src, org.map(p => p.i));
      pages.forEach((p, k) => { p.setRotation(PDFLib.degrees(p.getRotation().angle + org[k].rot)); out.addPage(p); });
      save(await out.save(), `${stem(f)}-organized.pdf`);
      return 'PDF saved';
    },
  },
  rotate: {
    group: 'organize', name: 'Rotate PDF', icon: 'rotate-cw', keys: 'turn orientation',
    desc: 'Turn all pages, or just the ones you pick, a quarter or half turn.',
    accept: PDF, btn: 'Rotate PDF', libs: ['pdflib', 'pdfjs'], batch: true,
    options: () => row(sel('o-angle', 'Turn pages', [['90', 'A quarter turn clockwise'], ['270', 'A quarter turn counter-clockwise'], ['180', 'Upside down']]),
      inp('o-ranges', 'Pages (empty for all)', 'placeholder="All pages" inputmode="numeric"')) + PICKER,
    ready: ([f]) => pickerInit(f, 'keep'),
    async run([f]) {
      const doc = await openPdf(f), angle = +val('o-angle'), pages = doc.getPages();
      pagesOr(pages.length).forEach(i => pages[i].setRotation(PDFLib.degrees(pages[i].getRotation().angle + angle)));
      save(await doc.save(), `${stem(f)}-rotated.pdf`);
      return 'Rotated';
    },
  },

  compress: {
    group: 'optimize', name: 'Compress PDF', icon: 'shrink', keys: 'reduce shrink size smaller optimize', featured: true,
    desc: 'Make a PDF smaller for email and uploads.',
    accept: PDF, btn: 'Compress PDF', libs: ['pdflib', 'pdfjs'], batch: true,
    options: () => sel('o-level', 'Compression', [['medium', 'Recommended: much smaller'], ['strong', 'Strong: smallest file'], ['light', 'Light: best quality'], ['lossless', 'Lossless: keeps the text']]) +
      hint('Recommended, Strong and Light save pages as images (lower quality for smaller files), so text can no longer be selected or searched. Lossless keeps the text but saves the least.'),
    async run([f]) {
      const level = val('o-level');
      const out = level === 'lossless'
        ? await (await openPdf(f)).save({ useObjectStreams: true })
        : await rasterize(await openView(f), ...{ light: [150, .8], medium: [110, .65], strong: [72, .5] }[level]);
      if (out.byteLength > f.size * .98) throw new UserError('This PDF is already compact: compressing it saves almost nothing, so nothing was saved. Try a stronger setting.');
      save(out, `${stem(f)}-compressed.pdf`);
      return `Compressed from ${kb(f.size)} to ${kb(out.byteLength)}, ${Math.round(100 - out.byteLength / f.size * 100)}% smaller`;
    },
  },
  repair: {
    group: 'optimize', name: 'Repair PDF', icon: 'wrench', keys: 'fix broken corrupt damaged recover',
    desc: "Rescue a PDF that won't open or shows errors.",
    accept: PDF, btn: 'Repair PDF', libs: ['pdflib'], batch: true,
    async run([f]) {
      try {
        const doc = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true, throwOnInvalidObject: false });
        save(await doc.save({ useObjectStreams: false }), `${stem(f)}-repaired.pdf`);
        return 'Repaired';
      } catch {
        let view;
        try { view = await openView(f); } catch { throw new UserError('This file is too damaged to recover.'); }
        save(await rasterize(view, 150, .85), `${stem(f)}-repaired.pdf`);
        return 'Repaired by rebuilding each page as an image';
      }
    },
  },
  ocr: {
    group: 'optimize', name: 'Read text (OCR)', icon: 'scan-text', keys: 'ocr scan recognize extract copy text image',
    desc: 'Pull editable text out of scanned PDFs and photos of documents.',
    accept: `${PDF},image/*`, note: 'A scanned PDF, or a JPG or PNG image', btn: 'Read text', libs: ['tesseract', 'pdfjs'],
    options: () => sel('o-lang', 'Language in the document', OCR_LANGS) +
      `<div id="o-out" class="field hidden"><span class="field-label">Text found</span><textarea id="o-result" class="input" readonly></textarea>
        <div class="row"><button type="button" class="chip" onclick="navigator.clipboard.writeText(val('o-result')).then(() => showToast('Copied'))">${icon('copy')}Copy</button>
        <button type="button" class="chip" onclick="save(val('o-result'), stem(uploadedFiles[0]) + '.txt')">${icon('download')}Download .txt</button></div></div>` +
      hint('The first run downloads the language data, which can take a moment.'),
    async run([f]) {
      let label = 'Reading';
      const worker = await Tesseract.createWorker({ logger: m => m.status === 'recognizing text' && progress(`${label} ${Math.round(m.progress * 100)}%`, m.progress) });
      try {
        progress('Loading the reader');
        await worker.loadLanguage(val('o-lang'));
        await worker.initialize(val('o-lang'));
        const view = isPdf(f) && await openView(f);
        const n = view ? view.numPages : 1, parts = [];
        for (let i = 1; i <= n; i++) {
          label = n > 1 ? `Reading page ${i} of ${n},` : 'Reading';
          const { data } = await worker.recognize(view ? await renderPage(view, i, 2.5) : f);
          parts.push(n > 1 ? `Page ${i}\n\n${data.text.trim()}` : data.text.trim());
        }
        $('o-result').value = parts.join('\n\n');
        $('o-out').classList.remove('hidden');
        return $('o-result').value.trim() ? 'Text read' : 'No text was found in this file';
      } finally { worker.terminate(); }
    },
  },

  jpg2pdf: {
    group: 'to', name: 'Images to PDF', icon: 'images', keys: 'jpg jpeg png photo picture scan heic webp',
    desc: 'Turn JPG, PNG and other images into a PDF, one image per page.',
    accept: 'image/*', multiple: true, ordered: true, drop: 'Drop images here', note: 'JPG, PNG, WebP or GIF. Use the arrows to set the order.',
    btn: 'Convert to PDF', libs: ['jspdf'],
    options: () => row(
      sel('o-size', 'Page size', [['fit', 'Same as each image'], ['a4', 'A4'], ['letter', 'US Letter']]),
      sel('o-orient', 'Orientation', [['auto', 'Match each image'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]),
      sel('o-margin', 'Margin', [['0', 'None'], ['24', 'Small'], ['48', 'Large']])),
    async run(files) {
      const { jsPDF } = window.jspdf, size = val('o-size'), orient = val('o-orient'), m = +val('o-margin');
      let doc;
      for (const [k, f] of files.entries()) {
        progress(`Image ${k + 1} of ${files.length}`, k / files.length);
        const bmp = await createImageBitmap(f).catch(() => { throw new UserError(`${f.name} isn't an image this browser can open.`); });
        let [pw, ph] = size === 'fit' ? [bmp.width * .75 + 2 * m, bmp.height * .75 + 2 * m] : size === 'a4' ? [595.28, 841.89] : [612, 792];
        if (size !== 'fit' && (orient === 'landscape' || (orient === 'auto' && bmp.width > bmp.height))) [pw, ph] = [ph, pw];
        const s = Math.min((pw - 2 * m) / bmp.width, (ph - 2 * m) / bmp.height), w = bmp.width * s, h = bmp.height * s;
        if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: pw > ph ? 'l' : 'p' });
        else doc.addPage([pw, ph], pw > ph ? 'l' : 'p');
        doc.addImage(toJpeg(bmp, bmp.width, bmp.height), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
      }
      save(doc.output('blob'), files.length === 1 ? `${stem(files[0])}.pdf` : 'images.pdf');
      return `Converted ${plural(files.length, 'image')}`;
    },
  },
  word2pdf: {
    group: 'to', name: 'Word to PDF', icon: 'file-text', keys: 'docx doc microsoft office',
    desc: 'Convert .docx documents, keeping headings, lists, tables and pictures. Complex layouts are simplified.',
    accept: '.docx', drop: 'Drop Word documents here', note: '.docx files (Word 2007 or newer). Add several to convert them all.', batch: true,
    btn: 'Convert to PDF', libs: ['mammoth', 'jspdf'],
    async run([f]) {
      const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
      const w = flow();
      const ownText = el => { const c = el.cloneNode(true); c.querySelectorAll('ul,ol').forEach(x => x.remove()); return c.textContent.trim(); };
      const list = (el, depth) => [...el.children].forEach((li, k) => {
        w.text(ownText(li), { indent: 18 + depth * 18, bullet: el.tagName === 'OL' ? `${k + 1}.` : '•', after: 3 });
        li.querySelectorAll(':scope > ul, :scope > ol').forEach(sub => list(sub, depth + 1));
      });
      for (const el of new DOMParser().parseFromString(html, 'text/html').body.children) {
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) w.text(el.textContent.trim(), { size: [22, 18, 15, 13, 12, 11][tag[1] - 1], style: 'bold', after: 8 });
        else if (tag === 'UL' || tag === 'OL') { list(el, 0); w.text('', { after: 2 }); }
        else if (tag === 'TABLE') { [...el.rows].forEach(r => w.text([...r.cells].map(c => c.textContent.trim()).join('   |   '), { size: 10, after: 3 })); w.text('', { after: 4 }); }
        else if (el.textContent.trim()) w.text(el.textContent.trim());
        for (const img of el.querySelectorAll('img')) {
          try { const i = await loadImg(img.src); w.image(toJpeg(i, i.naturalWidth, i.naturalHeight), i.naturalWidth * .75, i.naturalHeight * .75); } catch { /* unsupported image format (e.g. EMF): skip it */ }
        }
      }
      save(w.doc.output('blob'), `${stem(f)}.pdf`);
      return 'Converted to PDF';
    },
  },
  excel2pdf: {
    group: 'to', name: 'Excel to PDF', icon: 'sheet', keys: 'xlsx xls csv ods spreadsheet sheet table',
    desc: 'Turn each sheet of a spreadsheet into a clean table. The first row becomes the header.',
    accept: '.xlsx,.xls,.csv,.ods', drop: 'Drop spreadsheets here', note: '.xlsx, .xls, .csv or .ods. Add several to convert them all.', batch: true,
    btn: 'Convert to PDF', libs: ['xlsx', 'jspdf', 'autotable'],
    async run([f]) {
      const wb = XLSX.read(await f.arrayBuffer());
      const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      let first = true;
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }).filter(r => r.some(c => String(c).trim()));
        if (!rows.length) continue;
        if (!first) doc.addPage();
        first = false;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text(name, 40, 42);
        doc.autoTable({ head: [rows[0]], body: rows.slice(1), startY: 56, margin: 40, theme: 'grid',
          styles: { fontSize: 8, cellPadding: 4 }, headStyles: { fillColor: [28, 31, 46] } });
      }
      if (first) throw new UserError('This spreadsheet is empty.');
      save(doc.output('blob'), `${stem(f)}.pdf`);
      return 'Converted to PDF';
    },
  },
  text2pdf: {
    group: 'to', name: 'Text to PDF', icon: 'type', keys: 'txt type write notes code markdown',
    desc: 'Type or paste text, or open a .txt file, and save it as a PDF.',
    btn: 'Save as PDF', libs: ['jspdf'],
    options: () => `<label class="field"><span class="field-label">Text</span><textarea id="o-text" class="input tall" placeholder="Start typing or paste text here"></textarea></label>
      <div class="row"><button type="button" class="chip" onclick="openTextFile()">${icon('file-up')}Open a text file</button></div>` +
      row(sel('o-font', 'Font', [['helvetica', 'Sans serif'], ['times', 'Serif'], ['courier', 'Monospace']]),
        sel('o-fsize', 'Size', [['11', '11 pt'], ['10', '10 pt'], ['12', '12 pt'], ['14', '14 pt']])),
    async run() {
      const text = val('o-text');
      if (!text.trim()) throw new UserError('Type or paste some text first.');
      const w = flow(val('o-font'));
      text.split('\n').forEach(line => w.text(line, { size: +val('o-fsize'), after: 0 }));
      save(w.doc.output('blob'), 'document.pdf');
      return 'Saved as PDF';
    },
  },

  pdf2jpg: {
    group: 'from', name: 'PDF to images', icon: 'image', keys: 'jpg jpeg png picture export',
    desc: 'Save every page, or the pages you pick, as JPG or PNG images.',
    accept: PDF, btn: 'Convert to images', libs: ['pdfjs'], batch: true,
    options: () => row(sel('o-fmt', 'Format', [['jpeg', 'JPG'], ['png', 'PNG']]), sel('o-dpi', 'Quality', [['150', 'Standard (150 dpi)'], ['300', 'High (300 dpi)'], ['72', 'Small (72 dpi)']]),
      inp('o-ranges', 'Pages (empty for all)', 'placeholder="All pages" inputmode="numeric"')) + PICKER + hint('Several pages download together as a .zip.'),
    ready: ([f]) => pickerInit(f, 'keep'),
    async run([f]) {
      const view = await openView(f), fmt = val('o-fmt'), out = [], pick = pagesOr(view.numPages).map(i => i + 1);
      for (const [k, i] of pick.entries()) {
        progress(`Page ${i} of ${view.numPages}`, (k + 1) / pick.length);
        const c = await renderPage(view, i, +val('o-dpi') / 72);
        out.push({ name: `${stem(f)}-${i}.${fmt === 'jpeg' ? 'jpg' : 'png'}`, data: await new Promise(r => c.toBlob(r, `image/${fmt}`, .9)) });
      }
      await saveMany(out, `${stem(f)}-images.zip`);
      return `Saved ${plural(out.length, 'image')}`;
    },
  },
  pdf2word: {
    group: 'from', name: 'PDF to Word', icon: 'file-type', keys: 'docx doc editable microsoft', featured: true,
    desc: 'An editable .docx that keeps fonts, colours, pictures, tables and the page layout. Scanned pages are read with OCR.',
    accept: PDF, btn: 'Convert to Word', libs: ['pdfjs', 'jszip'], batch: true,
    options: () => sel('o-layout', 'Layout', [['exact', 'Exact: looks just like the PDF'], ['flow', 'Flowing: easiest to edit']]) +
      row(check('o-ocr', 'Read text on scanned pages'), sel('o-lang', 'Scan language', OCR_LANGS)) +
      hint('Exact keeps every line where it was, over a picture of the page’s graphics. Flowing rebuilds headings, paragraphs, tables and pictures so text reflows as you edit.'),
    async run([f]) {
      const view = await openView(f), exact = val('o-layout') === 'exact', ocr = $('o-ocr').checked ? makeOcr(val('o-lang')) : null;
      const doc = docxWriter(), pages = [];
      let body = '', any = false;
      try {
        for (let i = 1; i <= view.numPages; i++) {
          progress(`Reading page ${i} of ${view.numPages}`, (i - 1) / view.numPages);
          pages.push(await analyzePage(view, i, { rich: true, ocr }));
          any ||= pages.at(-1).items.length > 0 || !!pages.at(-1).background;
        }
      } finally { ocr?.done(); }
      if (!any) throw new UserError(NO_TEXT);
      // the most common text size is the body size; headings are measured against it
      const sizes = {};
      pages.forEach(p => p.items.forEach(it => { const k = Math.round(it.size * 2) / 2; sizes[k] = (sizes[k] || 0) + it.str.length; }));
      const bodySize = +Object.entries(sizes).sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
      const p0 = pages[0], xs = pages.flatMap(p => p.items.map(i => i.x0)), x1s = pages.flatMap(p => p.items.map(i => p.W - i.x1));
      const clampM = v => Math.max(28, Math.min(90, v));
      const margin = { l: clampM(xs.length ? Math.min(...xs) : 72), r: clampM(x1s.length ? Math.min(...x1s) : 72), t: 48, b: 48 };
      for (const [k, pg] of pages.entries()) {
        progress(`Writing page ${k + 1} of ${pages.length}`, k / pages.length);
        if (exact) body += await wordExact(doc, pg, k === pages.length - 1);
        else body += (k ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '') + await wordFlow(doc, pg, { body: bodySize, margin });
      }
      const last = pages.at(-1);
      save(await doc.pack(body || '<w:p/>', exact ? sectXml(last.W, last.H) : sectXml(p0.W, p0.H, margin)), `${stem(f)}.docx`);
      return 'Converted to Word';
    },
  },
  pdf2ppt: {
    group: 'from', name: 'PDF to PowerPoint', icon: 'presentation', keys: 'pptx slides presentation keynote',
    desc: 'Put each page on its own slide, as a picture.',
    accept: PDF, btn: 'Convert to PowerPoint', libs: ['pdfjs', 'pptx'], batch: true,
    async run([f]) {
      const view = await openView(f), pptx = new PptxGenJS();
      const vp = (await view.getPage(1)).getViewport({ scale: 1 }), W = vp.width / 72, H = vp.height / 72;
      pptx.defineLayout({ name: 'PDF', width: W, height: H });
      pptx.layout = 'PDF';
      for (let i = 1; i <= view.numPages; i++) {
        progress(`Page ${i} of ${view.numPages}`, i / view.numPages);
        const c = await renderPage(view, i, 1.6), iw = c.width / 115.2, ih = c.height / 115.2, s = Math.min(W / iw, H / ih);
        pptx.addSlide().addImage({ data: c.toDataURL('image/jpeg', .85), x: (W - iw * s) / 2, y: (H - ih * s) / 2, w: iw * s, h: ih * s });
      }
      progress('Packing the slides');
      save(await pptx.write({ outputType: 'blob' }), `${stem(f)}.pptx`);
      return 'Converted to PowerPoint';
    },
  },
  pdf2excel: {
    group: 'from', name: 'PDF to Excel', icon: 'table', keys: 'xlsx spreadsheet table data csv',
    desc: 'Tables land in real columns with real numbers. Scanned pages are read with OCR.',
    accept: PDF, btn: 'Convert to Excel', libs: ['pdfjs', 'xlsx'], batch: true,
    options: () => sel('o-sheets', 'Sheets', [['page', 'One sheet per page'], ['one', 'Everything on one sheet']]) +
      row(check('o-ocr', 'Read text on scanned pages'), sel('o-lang', 'Scan language', OCR_LANGS)) +
      hint('Numbers like 1,200, (3.50), $12 and 15% become values you can add up, with their formatting kept.'),
    async run([f]) {
      const view = await openView(f), wb = XLSX.utils.book_new(), ocr = $('o-ocr').checked ? makeOcr(val('o-lang')) : null, one = val('o-sheets') === 'one';
      const sheet = rows => {
        const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]);
        const widths = [];
        // size columns to table cells; a lone line of text can spill over empty cells, as it does in Excel
        rows.filter(r => r.length > 1).forEach(r => r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 8, Math.min(50, String(c?.v ?? c ?? '').length + 2)); }));
        ws['!cols'] = widths.map(wch => ({ wch }));
        return ws;
      };
      let all = [], any = false;
      try {
        for (let i = 1; i <= view.numPages; i++) {
          progress(`Page ${i} of ${view.numPages}`, (i - 1) / view.numPages);
          const rows = pageRows(await analyzePage(view, i, { ocr }));
          any ||= rows.some(r => r.length);
          if (one) all.push(...rows, []);
          else XLSX.utils.book_append_sheet(wb, sheet(rows), `Page ${i}`);
        }
      } finally { ocr?.done(); }
      if (!any) throw new UserError(NO_TEXT);
      if (one) XLSX.utils.book_append_sheet(wb, sheet(all), stem(f).slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Sheet1');
      save(new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })]), `${stem(f)}.xlsx`);
      return 'Converted to Excel';
    },
  },

  sign: {
    group: 'edit', name: 'Sign PDF', icon: 'signature', keys: 'signature esign autograph', featured: true, wide: true,
    desc: 'Draw your signature and place it anywhere on the document.',
    accept: PDF, btn: 'Save signed PDF', libs: ['pdflib', 'pdfjs'],
    options: () => `<div class="field"><span class="field-label">Draw your signature</span><canvas id="pad" class="pad" width="900" height="260" data-cursor="cross"></canvas>
        <div class="row"><button type="button" class="chip" onclick="$('pad').getContext('2d').clearRect(0, 0, 900, 260)">${icon('trash-2')}Clear</button></div></div>
      <label class="field"><span class="field-label">Signature width</span><input id="o-sigsize" type="range" min="10" max="60" value="28"></label>
      ${STAGE}${hint('Click the page to place your signature. Click a placed signature to remove it.')}`,
    async ready([f]) {
      padInit();
      await stageInit(f, 'point', a => {
        const s = padImage();
        if (!s) throw new UserError('Draw your signature in the box first.');
        const w = val('o-sigsize') / 100, h = w * s.ratio * stage.size.w / stage.size.h;
        return { kind: 'sign', img: s.url, x: a.x - w / 2, y: a.y - h / 2, w, h };
      });
    },
    async run([f]) {
      if (!stage.marks.length) throw new UserError('Click the page to place your signature first.');
      const doc = await openPdf(f), pages = doc.getPages(), cache = {};
      for (const m of stage.marks) {
        const img = cache[m.img] ??= await doc.embedPng(m.img), p = pages[m.page - 1], fr = frame(p);
        const pt = fr.at(m.x * fr.w, (m.y + m.h) * fr.h);
        p.drawImage(img, { x: pt.x, y: pt.y, width: m.w * fr.w, height: m.h * fr.h, rotate: PDFLib.degrees(fr.r) });
      }
      save(await doc.save(), `${stem(f)}-signed.pdf`);
      return 'Signed PDF saved';
    },
  },
  edittext: {
    group: 'edit', name: 'Edit PDF', icon: 'edit', keys: 'edit change text modify correct typo fix write type add annotate date whiteout white out erase', wide: true,
    desc: 'Change the existing text, add new text, or white out what you don’t want.',
    accept: PDF, btn: 'Save edited PDF', libs: ['pdflib', 'pdfjs'],
    options: () => `<div class="seg" role="group" aria-label="What to do" id="o-emode">
        <button type="button" class="seg-btn" data-m="edit" aria-pressed="true">${icon('edit')}Edit text</button>
        <button type="button" class="seg-btn" data-m="point" aria-pressed="false">${icon('text-aa')}Add text</button>
        <button type="button" class="seg-btn" data-m="white" aria-pressed="false">${icon('eraser')}White out</button></div>
      <div id="o-addopts" class="options-sub hidden">${inp('o-text', 'Text to add', 'placeholder="Your text"')}${row(sel('o-size', 'Size', [['12', '12 pt'], ['10', '10 pt'], ['14', '14 pt'], ['18', '18 pt'], ['24', '24 pt']]),
        sel('o-color', 'Colour', [['black', 'Black'], ['blue', 'Blue'], ['red', 'Red']]))}</div>
      ${STAGE}<p class="hint" id="o-ehint"></p>
      ${hint('Changed words are painted over, not deleted from the file. To remove sensitive text for good, use Redact PDF.')}`,
    async ready([f]) {
      const hints = { edit: 'Click any line of text to change it. Press Enter when done, or Esc to undo. Empty a line to delete it.', point: 'Type your text above, then click where it should start. Click placed text to remove it.', white: 'Drag over anything to cover it with the page colour. Click a box to remove it.' };
      const setMode = m => {
        stage.mode = m;
        document.querySelectorAll('#o-emode [data-m]').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === m));
        $('o-addopts').classList.toggle('hidden', m !== 'point');
        $('o-ehint').textContent = say(hints[m]);
        drawMarks();
      };
      $('o-emode').onclick = e => { const b = e.target.closest('[data-m]'); if (b) setMode(b.dataset.m); };
      stage.editable = true;
      await stageInit(f, 'edit', a => {
        const text = val('o-text').trim();
        if (!text) throw new UserError('Type the text to add first.');
        return { kind: 'text', text, size: +val('o-size'), color: val('o-color'), x: a.x, y: a.y };
      });
      setMode('edit');
    },
    async run([f]) {
      if (!stage.marks.length) throw new UserError('Make a change first: click a line to edit it, or switch to Add text or White out.');
      const doc = await openPdf(f), pages = doc.getPages(), fonts = {};
      const fontFor = (family = '', bold, italic) => {
        const base = /times|serif|georgia|garamond|cambria|palatino|book/i.test(family) ? 'TimesRoman' : /courier|mono|consolas/i.test(family) ? 'Courier' : 'Helvetica';
        const name = base + (bold ? 'Bold' : '') + (italic ? (base === 'TimesRoman' ? 'Italic' : 'Oblique') : '');
        return fonts[name] ??= doc.embedFont(PDFLib.StandardFonts[name]);
      };
      const hex = h => PDFLib.rgb(...[0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
      const cover = (p, x0, top, x1, bottom, color) => {
        const fr = frame(p), a = fr.at(x0, top), b = fr.at(x1, bottom);
        p.drawRectangle({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), color });
      };
      for (const m of stage.marks) {
        const p = pages[m.page - 1], fr = frame(p);
        if (m.kind === 'text') drawLabel(p, m.text, m.x * fr.w, m.y * fr.h + m.size * .8, { font: await fontFor(), size: m.size, color: PDFLib.rgb(...COLORS[m.color]) });
        if (m.kind === 'white') cover(p, m.x * fr.w, m.y * fr.h, (m.x + m.w) * fr.w, (m.y + m.h) * fr.h, hex(m.bg || 'FFFFFF'));
        if (m.kind === 'edit') {
          const s = m.seg;
          cover(p, s.x0 - 1, s.top - 1, s.x1 + 1.5, s.bottom + 1, hex(s.bg));
          if (m.text.trim()) drawLabel(p, m.text, s.x0, s.base, { font: await fontFor(s.family, s.bold, s.italic), size: s.size, color: hex(s.color) });
        }
      }
      save(await doc.save(), `${stem(f)}-edited.pdf`);
      return 'Edited PDF saved';
    },
  },
  fillform: {
    group: 'edit', name: 'Fill in a form', icon: 'form', keys: 'form fields fill acroform checkbox tick application',
    desc: 'Type into a PDF form’s fields, tick its boxes and choose its options, then save it, or flatten it so it can’t be changed.',
    accept: PDF, btn: 'Save filled form', libs: ['pdflib'],
    options: () => `<div id="o-form" class="form-fields"><p class="hint">Reading the form…</p></div>` + check('o-flatten', 'Flatten: make the answers part of the page, so they can’t be changed', false),
    async ready([f]) {
      const fields = (await openPdf(f)).getForm().getFields(), L = PDFLib, box = $('o-form');
      formFields = fields.map(fl => fl.getName());
      $('o-flatten').closest('.switch').classList.toggle('hidden', !fields.length);
      if (!fields.length) { box.innerHTML = hint('This PDF has no fillable fields. Use Edit PDF to type onto it instead.'); return; }
      const label = n => esc(n.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim());
      box.innerHTML = `<p class="label">${plural(fields.length, 'field')} in this form</p>` + fields.map((fl, i) => {
        const id = `ff-${i}`, name = label(fl.getName());
        if (fl instanceof L.PDFTextField) return fl.isMultiline()
          ? `<label class="field"><span class="field-label">${name}</span><textarea id="${id}" class="input">${esc(fl.getText() || '')}</textarea></label>`
          : `<label class="field"><span class="field-label">${name}</span><input id="${id}" class="input" value="${esc(fl.getText() || '')}"${fl.getMaxLength() ? ` maxlength="${fl.getMaxLength()}"` : ''}></label>`;
        if (fl instanceof L.PDFCheckBox) return check(id, name, fl.isChecked());
        if (fl instanceof L.PDFDropdown || fl instanceof L.PDFOptionList || fl instanceof L.PDFRadioGroup) {
          const opts = fl.getOptions(), cur = fl instanceof L.PDFRadioGroup ? fl.getSelected() : fl.getSelected()[0];
          return `<label class="field"><span class="field-label">${name}</span><span class="select-wrap"><select id="${id}" class="input"><option value="">(none)</option>${opts.map(o => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></span></label>`;
        }
        return `<p class="hint">${name}: a ${fl instanceof L.PDFSignature ? 'signature' : 'button'} field. Use Sign PDF for signatures.</p>`;
      }).join('');
    },
    async run([f]) {
      const doc = await openPdf(f), form = doc.getForm(), L = PDFLib;
      if (!form.getFields().length) throw new UserError('This PDF has no fillable fields. Use Edit PDF to type onto it instead.');
      formFields.forEach((name, i) => {
        const el = $(`ff-${i}`), fl = form.getField(name);
        if (!el) return;
        if (fl instanceof L.PDFTextField) fl.setText(el.value || undefined);
        else if (fl instanceof L.PDFCheckBox) el.checked ? fl.check() : fl.uncheck();
        else if (fl instanceof L.PDFRadioGroup) el.value ? fl.select(el.value) : fl.clear();
        else if (fl instanceof L.PDFDropdown || fl instanceof L.PDFOptionList) el.value ? fl.select(el.value) : fl.clear();
      });
      if ($('o-flatten').checked) form.flatten();
      save(await doc.save(), `${stem(f)}-filled.pdf`);
      return $('o-flatten').checked ? 'Form filled and flattened' : 'Form filled';
    },
  },
  numbers: {
    group: 'edit', name: 'Add page numbers', icon: 'list-ordered', keys: 'paginate numbering footer',
    desc: 'Number every page, in the position and style you choose.',
    accept: PDF, btn: 'Add page numbers', libs: ['pdflib'], batch: true,
    options: () => row(
      sel('o-pos', 'Position', [['bottom-center', 'Bottom center'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top center'], ['top-right', 'Top right'], ['top-left', 'Top left']]),
      sel('o-fmt', 'Style', [['n', '1'], ['page', 'Page 1'], ['of', 'Page 1 of 9'], ['slash', '1 / 9']]),
      inp('o-start', 'Start at', 'type="number" min="1" value="1"')),
    async run([f]) {
      const doc = await openPdf(f), font = await doc.embedFont(PDFLib.StandardFonts.Helvetica), pages = doc.getPages();
      const start = Math.max(1, parseInt(val('o-start')) || 1), last = pages.length + start - 1, [v, h] = val('o-pos').split('-'), size = 10, m = 28;
      pages.forEach((p, k) => {
        const n = k + start, label = { n: `${n}`, page: `Page ${n}`, of: `Page ${n} of ${last}`, slash: `${n} / ${last}` }[val('o-fmt')];
        const fr = frame(p), tw = font.widthOfTextAtSize(label, size);
        const dx = h === 'left' ? m : h === 'right' ? fr.w - m - tw : (fr.w - tw) / 2;
        drawLabel(p, label, dx, v === 'top' ? m + size * .7 : fr.h - m, { font, size, color: PDFLib.rgb(0, 0, 0) });
      });
      save(await doc.save(), `${stem(f)}-numbered.pdf`);
      return 'Page numbers added';
    },
  },
  watermark: {
    group: 'edit', name: 'Add watermark', icon: 'stamp', keys: 'stamp draft confidential logo brand image',
    desc: 'Stamp text such as DRAFT or CONFIDENTIAL, or your logo, across every page.',
    accept: PDF, btn: 'Add watermark', libs: ['pdflib'], batch: true,
    options: () => `<div class="seg" role="group" aria-label="Watermark type" id="o-wkind">
        <button type="button" class="seg-btn" data-k="text" aria-pressed="true" onclick="segPick(this)">${icon('type')}Text</button>
        <button type="button" class="seg-btn" data-k="logo" aria-pressed="false" onclick="segPick(this)">${icon('img')}Logo</button></div>
      <div id="o-wtext" class="options-sub">${inp('o-text', 'Watermark text', 'value="CONFIDENTIAL"')}${row(
        sel('o-angle', 'Direction', [['diag', 'Diagonal'], ['flat', 'Horizontal']]),
        sel('o-color', 'Colour', [['grey', 'Grey'], ['red', 'Red'], ['blue', 'Blue']]))}</div>
      <div id="o-wlogo" class="options-sub hidden">
        <label class="field"><span class="field-label">Logo image (PNG with a transparent background works best)</span><input id="o-logo" type="file" accept="image/*" class="input file-pick"></label>
        ${row(sel('o-lpos', 'Position', [['center', 'Centre'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left'], ['tile', 'Tiled across the page']]),
          sel('o-lsize', 'Size', [['.35', 'Medium'], ['.18', 'Small'], ['.6', 'Large']]))}</div>
      ${sel('o-opacity', 'Strength', [['.2', 'Faint'], ['.35', 'Medium'], ['.6', 'Strong'], ['1', 'Solid']])}`,
    async run([f]) {
      const logoMode = segValue('o-wkind') === 'logo', opacity = +val('o-opacity');
      const doc = await openPdf(f);
      if (logoMode) {
        const file = $('o-logo').files[0];
        if (!file) throw new UserError('Choose a logo image first.');
        const bmp = await createImageBitmap(file).catch(() => { throw new UserError(`${file.name} isn't an image this browser can open.`); });
        const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
        c.getContext('2d').drawImage(bmp, 0, 0);
        const img = await doc.embedPng(await canvasBytes(c, 'image/png')), pos = val('o-lpos'), k = +val('o-lsize');
        for (const p of doc.getPages()) {
          const fr = frame(p), w = Math.min(fr.w, fr.h) * (pos === 'tile' ? .22 : k), h = w * bmp.height / bmp.width, m = Math.min(fr.w, fr.h) * .05;
          const spots = pos === 'tile'
            ? Array.from({ length: Math.ceil(fr.h / (h * 2.2)) * Math.ceil(fr.w / (w * 1.8)) }, (_, i) => { const cols = Math.ceil(fr.w / (w * 1.8)); return [(i % cols) * w * 1.8 + (Math.floor(i / cols) % 2) * w * .9, Math.floor(i / cols) * h * 2.2 + m]; })
            : [{ center: [(fr.w - w) / 2, (fr.h - h) / 2], br: [fr.w - w - m, fr.h - h - m], bl: [m, fr.h - h - m], tr: [fr.w - w - m, m], tl: [m, m] }[pos]];
          for (const [x, y] of spots) {
            const pt = fr.at(x, y + h);
            p.drawImage(img, { x: pt.x, y: pt.y, width: w, height: h, rotate: PDFLib.degrees(fr.r), opacity });
          }
        }
        save(await doc.save(), `${stem(f)}-watermarked.pdf`);
        return 'Logo watermark added';
      }
      const text = val('o-text').trim();
      if (!text) throw new UserError('Enter the watermark text.');
      const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold), diag = val('o-angle') === 'diag';
      for (const p of doc.getPages()) {
        const fr = frame(p), a = diag ? Math.atan2(fr.h, fr.w) : 0, span = (diag ? Math.hypot(fr.w, fr.h) : fr.w) * .75;
        const size = Math.min(96, 96 * span / font.widthOfTextAtSize(text, 96)), tw = font.widthOfTextAtSize(text, size), capH = size * .7;
        // centre the text: step back half its length along its direction, and half its cap height along "up"
        const dir = [Math.cos(a), -Math.sin(a)], up = [-Math.sin(a), -Math.cos(a)];
        drawLabel(p, text, fr.w / 2 - dir[0] * tw / 2 - up[0] * capH / 2, fr.h / 2 - dir[1] * tw / 2 - up[1] * capH / 2,
          { font, size, turn: a * 180 / Math.PI, opacity, color: PDFLib.rgb(...COLORS[val('o-color')]) });
      }
      save(await doc.save(), `${stem(f)}-watermarked.pdf`);
      return 'Watermark added';
    },
  },
  crop: {
    group: 'edit', name: 'Crop PDF', icon: 'crop', keys: 'trim margins cut', wide: true,
    desc: 'Trim margins by drawing the area to keep. The same crop applies to every page.',
    accept: PDF, btn: 'Crop PDF', libs: ['pdflib', 'pdfjs'],
    options: () => `${STAGE}${hint('Drag across the page to mark the area to keep.')}`,
    ready: ([f]) => stageInit(f, 'crop'),
    async run([f]) {
      const m = stage.marks[0];
      if (!m) throw new UserError('Drag across the page to choose the area to keep.');
      const doc = await openPdf(f);
      for (const p of doc.getPages()) {
        const fr = frame(p), a = fr.at(m.x * fr.w, m.y * fr.h), b = fr.at((m.x + m.w) * fr.w, (m.y + m.h) * fr.h);
        p.setCropBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      }
      save(await doc.save(), `${stem(f)}-cropped.pdf`);
      return 'Cropped';
    },
  },
  redact: {
    group: 'edit', name: 'Redact PDF', icon: 'eye-off', keys: 'black out hide censor remove sensitive', wide: true,
    desc: 'Black out text and images for good, not just cover them up.',
    accept: PDF, btn: 'Save redacted PDF', libs: ['pdflib', 'pdfjs'],
    options: () => `${STAGE}${hint("Drag over anything to hide. Click a box to remove it. Pages you redact are flattened into images, so the hidden content can't be recovered.")}`,
    ready: ([f]) => stageInit(f, 'redact'),
    async run([f]) {
      if (!stage.marks.length) throw new UserError('Drag over the parts of the page to black out first.');
      const doc = await openPdf(f), out = await PDFLib.PDFDocument.create();
      for (let i = 0; i < doc.getPageCount(); i++) {
        const ms = stage.marks.filter(m => m.page === i + 1);
        if (!ms.length) { out.addPage((await out.copyPages(doc, [i]))[0]); continue; }
        progress(`Redacting page ${i + 1}`, i / doc.getPageCount());
        await addImagePage(out, await pageJpeg(stage.view, i + 1, 200, .9, (ctx, c) => {
          ctx.fillStyle = '#000';
          ms.forEach(m => ctx.fillRect(m.x * c.width, m.y * c.height, m.w * c.width, m.h * c.height));
        }));
      }
      save(await out.save(), `${stem(f)}-redacted.pdf`);
      return 'Redacted PDF saved';
    },
  },

  protect: {
    group: 'security', name: 'Protect PDF', icon: 'lock-keyhole', keys: 'password encrypt lock secure',
    desc: 'Add a password that is needed to open the file. Uses AES-256 encryption.',
    accept: PDF, btn: 'Protect PDF', libs: ['pdflib'], batch: true,
    options: () => row(inp('o-pw', 'Password', 'type="password" autocomplete="new-password"'), inp('o-pw2', 'Repeat password', 'type="password" autocomplete="new-password"')) +
      hint('Keep this password safe. Nobody, including Nebula, can recover it.'),
    async run([f]) {
      const pw = val('o-pw');
      if (!pw) throw new UserError('Choose a password.');
      if (pw !== val('o-pw2')) throw new UserError("The passwords don't match.");
      const doc = await openPdf(f);
      doc.encrypt({ userPassword: pw, ownerPassword: pw });
      save(await doc.save(), `${stem(f)}-protected.pdf`);
      return 'Protected';
    },
  },
  unlock: {
    group: 'security', name: 'Unlock PDF', icon: 'lock-keyhole-open', keys: 'password decrypt remove security unprotect',
    desc: 'Remove the password from a PDF you have the password for.',
    accept: PDF, btn: 'Unlock PDF', libs: ['pdflib'], batch: true,
    options: () => inp('o-pw', 'Current password', 'type="password" autocomplete="current-password"') +
      hint('Leave this blank if the PDF opens without a password but blocks printing or copying.'),
    async run([f]) {
      const bytes = await f.arrayBuffer();
      if (!(await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })).isEncrypted) throw new UserError("This PDF isn't password-protected.");
      let doc;
      try { doc = await PDFLib.PDFDocument.load(bytes, { password: val('o-pw') }); }
      catch { throw new UserError("That password didn't work."); }
      // Loading decrypts the pages, but the file's old encryption settings and old cross-reference data are carried
      // over as unused objects and written back, so the result would still look locked to some apps (and to our
      // own tools). Keep only the objects the document actually uses, starting from its root.
      const { PDFRef, PDFDict, PDFArray } = PDFLib, ctx = doc.context, used = new Set();
      const walk = o => {
        if (o instanceof PDFRef) { if (!used.has(o.tag)) { used.add(o.tag); walk(ctx.lookup(o)); } }
        else if (o instanceof PDFDict) o.values().forEach(walk);
        else if (o instanceof PDFArray) o.asArray().forEach(walk);
        else if (o?.dict instanceof PDFDict) walk(o.dict); // a stream
      };
      // the title, author and so on may sit in an older copy of the document's info record: keep them
      const { PDFName } = PDFLib, info = ctx.lookup(ctx.trailerInfo.Info);
      if (info instanceof PDFDict) for (const [, obj] of ctx.enumerateIndirectObjects()) {
        if (obj === info || !(obj instanceof PDFDict)) continue;
        for (const k of ['Title', 'Author', 'Subject', 'Keywords']) {
          const v = obj.get(PDFName.of(k));
          if (v && !info.has(PDFName.of(k))) info.set(PDFName.of(k), v);
        }
      }
      walk(ctx.trailerInfo.Root);
      walk(ctx.trailerInfo.Info);
      for (const [ref] of [...ctx.enumerateIndirectObjects()]) if (!used.has(ref.tag)) ctx.delete(ref);
      save(await doc.save(), `${stem(f)}-unlocked.pdf`);
      return 'Unlocked';
    },
  },
};
const COLORS = { black: [0, 0, 0], grey: [.45, .47, .5], red: [.8, .1, .1], blue: [.05, .2, .65] };
// What to offer after a tool finishes, or when a file is dropped on the home page.
const SUGGEST = {
  pdf: ['compress', 'merge', 'pdf2word', 'sign', 'split', 'organize', 'pdf2excel', 'protect', 'pdf2jpg', 'watermark', 'numbers', 'ocr'],
  image: ['jpg2pdf', 'ocr'], docx: ['word2pdf'], sheet: ['excel2pdf'], text: ['text2pdf'], pptx: [],
};
const kindOf = f => isPdf(f) ? 'pdf' : f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name) ? 'image' : /\.pptx$/i.test(f.name) ? 'pptx' : /\.docx$/i.test(f.name) ? 'docx' : /\.(xlsx|xls|csv|ods)$/i.test(f.name) ? 'sheet' : /\.(txt|md|log|json)$/i.test(f.name) ? 'text' : null;

/* ---------- Text layout for jsPDF (Text to PDF, Word to PDF) ---------- */
function flow(face = 'helvetica') {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 56;
  let y = M;
  const room = h => { if (y + h > H - M) { doc.addPage(); y = M; } };
  return {
    doc,
    text(str, { size = 11, style = 'normal', indent = 0, after = size * .6, bullet } = {}) {
      doc.setFont(face, style);
      doc.setFontSize(size);
      const lh = size * 1.4;
      doc.splitTextToSize(str.replace(/\t/g, '    ') || ' ', W - 2 * M - indent).forEach((line, k) => {
        room(lh);
        if (bullet && k === 0) doc.text(bullet, M + indent - 14, y + size);
        doc.text(line, M + indent, y + size);
        y += lh;
      });
      y += after;
    },
    image(src, w, h) {
      const s = Math.min(1, (W - 2 * M) / w, (H - 2 * M) / h);
      room(h * s);
      doc.addImage(src, 'JPEG', M, y, w * s, h * s);
      y += h * s + 12;
    },
  };
}
const toJpeg = (source, w, h) => {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return c.toDataURL('image/jpeg', .92);
};
const loadImg = src => new Promise((ok, fail) => Object.assign(new Image(), { onload() { ok(this); }, onerror: fail, src }));
function openTextFile() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.txt,.md,.csv,.json,.log,.xml,.html,.js,.css,.py,text/*' });
  input.onchange = async () => { if (input.files[0]) $('o-text').value = await input.files[0].text(); };
  input.click();
}

/* ---------- Organize thumbnails ---------- */
let org = [];
function drawThumbs() {
  $('o-thumbs').replaceChildren(...org.map((p, k) => {
    const fig = document.createElement('figure');
    fig.className = 'thumb';
    fig.innerHTML = `<div class="thumb-img"><span class="thumb-n mono">${p.i + 1}</span></div><figcaption>
      <button class="icon-btn" data-act="left" data-k="${k}" aria-label="Move page ${p.i + 1} earlier">${icon('chevron-left')}</button>
      <button class="icon-btn" data-act="rot" data-k="${k}" aria-label="Turn page ${p.i + 1}">${icon('rotate-cw')}</button>
      <button class="icon-btn" data-act="del" data-k="${k}" aria-label="Delete page ${p.i + 1}">${icon('trash-2')}</button>
      <button class="icon-btn" data-act="right" data-k="${k}" aria-label="Move page ${p.i + 1} later">${icon('chevron-right')}</button></figcaption>`;
    p.c.style.transform = `rotate(${p.rot}deg)`;
    fig.firstChild.append(p.c);
    return fig;
  }));
}

/* ---------- Page stage: shows one page; click or drag to place marks ---------- */
let formFields = [];
const stage = { view: null, page: 1, marks: [], size: { w: 1, h: 1 }, mode: 'point', place: null, editable: false, lines: {} };
async function stageInit(file, mode, place) {
  Object.assign(stage, { view: await openView(file), page: 1, marks: [], mode, place, lines: {} });
  stage.editable = currentTool === 'edittext'; // only Edit PDF makes the page's own text clickable
  $('stage-page').onpointerdown = stageDown;
  await stageRender();
}
async function stageRender() {
  const el = $('stage-page'), n = stage.page;
  const vp = (await stage.view.getPage(n)).getViewport({ scale: 1 });
  stage.size = { w: vp.width, h: vp.height };
  const c = await renderPage(stage.view, n, el.clientWidth * Math.min(devicePixelRatio, 2) / vp.width);
  el.querySelector('canvas')?.remove();
  el.prepend(c);
  el.style.setProperty('--pt', `${el.clientWidth / vp.width}px`);
  $('stage-label').textContent = `Page ${n} of ${stage.view.numPages}`;
  if (stage.editable && !stage.lines[n]) stage.lines[n] = await editLines(n, c, vp);
  drawMarks();
}
function stageGo(d) {
  const n = Math.min(stage.view.numPages, Math.max(1, stage.page + d));
  if (n !== stage.page) { stage.page = n; stageRender(); }
}
// The lines of text on a page, with their font, size, colour and the colour behind them, ready to be edited.
async function editLines(n, canvas, vp) {
  const pg = await analyzePage(stage.view, n, { fonts: true }), S = canvas.width / vp.width;
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), hexOf = c => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return toLines(pg.items).flatMap(l => l.segs).map(s => {
    const it = s.items[0], box = [Math.max(0, Math.floor(s.x0 * S)), Math.max(0, Math.floor(s.top * S)), Math.min(canvas.width, Math.ceil(s.x1 * S)), Math.min(canvas.height, Math.ceil(s.bottom * S))];
    return { page: n, x0: s.x0, x1: s.x1, top: s.top, bottom: s.bottom, base: s.base, size: s.size, text: s.text, family: it.family, bold: it.bold, italic: it.italic,
      color: inkColor(img, S, s), bg: box[2] > box[0] && box[3] > box[1] ? hexOf(dominant(img, ...box, 1)) : 'FFFFFF', W: vp.width, H: vp.height };
  });
}
const cssFont = s => `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}calc(var(--pt) * ${s.size}) / 1.2 ${/times|serif|georgia|garamond|cambria|palatino|book/i.test(s.family) ? 'Times, "Times New Roman", serif' : /courier|mono/i.test(s.family) ? '"Courier New", monospace' : 'Helvetica, Arial, sans-serif'}`;
const place = (d, s) => Object.assign(d.style, { left: `${s.x0 / s.W * 100}%`, top: `${(s.base - s.size * .96) / s.H * 100}%`, minWidth: `${(s.x1 - s.x0) / s.W * 100}%`, font: cssFont(s), color: `#${s.color}`, background: `#${s.bg}` });
function startEdit(s) {
  const mark = stage.marks.find(m => m.kind === 'edit' && m.seg === s), d = document.createElement('div');
  d.className = 'edit-box';
  try { d.contentEditable = 'plaintext-only'; } catch { d.contentEditable = 'true'; } // older browsers only know true
  d.spellcheck = false;
  d.textContent = mark ? mark.text : s.text;
  place(d, s);
  $('stage-marks').append(d);
  d.focus();
  getSelection().selectAllChildren(d);
  let done = false;
  const finish = keep => {
    if (done) return;
    done = true;
    const text = d.textContent.replace(/\s+/g, ' ').trim();
    stage.marks = stage.marks.filter(m => m !== mark);
    if (keep && text !== s.text) stage.marks.push({ kind: 'edit', page: s.page, seg: s, text });
    drawMarks();
  };
  d.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
  d.onblur = () => finish(true);
  d.onpointerdown = e => e.stopPropagation();
}
function drawMarks() {
  const edits = new Set(stage.marks.filter(m => m.kind === 'edit').map(m => m.seg));
  const lines = stage.editable && stage.mode === 'edit' ? (stage.lines[stage.page] || []).filter(s => !edits.has(s)).map(s => {
    const d = document.createElement('div');
    d.className = 'edit-line';
    Object.assign(d.style, { left: `${s.x0 / s.W * 100}%`, top: `${s.top / s.H * 100}%`, width: `${(s.x1 - s.x0) / s.W * 100}%`, height: `${(s.bottom - s.top) / s.H * 100}%` });
    d.title = 'Click to edit';
    d.dataset.cursor = 'text';
    d.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); startEdit(s); };
    return d;
  }) : [];
  $('stage-marks').replaceChildren(...lines, ...stage.marks.filter(m => m.all || m.page === stage.page).map(m => {
    const d = document.createElement('div');
    d.className = `mark mark-${m.kind}`;
    Object.assign(d.style, { left: `${m.x * 100}%`, top: `${m.y * 100}%` }, m.w && { width: `${m.w * 100}%`, height: `${m.h * 100}%` });
    if (m.kind === 'sign') d.innerHTML = `<img src="${m.img}" alt="Signature">`;
    if (m.kind === 'text') Object.assign(d.style, { fontSize: `calc(var(--pt) * ${m.size})`, color: `rgb(${COLORS[m.color].map(v => v * 255)})` }), d.textContent = m.text;
    if (m.kind === 'white') d.style.background = `#${m.bg || 'FFFFFF'}`;
    if (m.kind === 'edit') {
      place(d, m.seg);
      d.textContent = m.text || ' ';
      d.dataset.cursor = 'text';
      d.title = 'Click to change again';
      d.onpointerdown = e => { e.stopPropagation(); e.preventDefault(); startEdit(m.seg); };
      return d;
    }
    if (m.kind !== 'crop') { d.dataset.cursor = 'remove'; d.onpointerdown = e => { e.stopPropagation(); stage.marks.splice(stage.marks.indexOf(m), 1); drawMarks(); }; }
    return d;
  }));
}
function stageDown(e) {
  const el = $('stage-page'), box = el.getBoundingClientRect();
  const pt = ev => ({ x: Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (ev.clientY - box.top) / box.height)) });
  const a = pt(e);
  if (stage.mode === 'edit') return; // lines are clicked directly
  if (stage.mode === 'point') {
    try { stage.marks.push({ page: stage.page, ...stage.place(a) }); drawMarks(); } catch (err) { showToast(err.message, true); }
    return;
  }
  const m = { page: stage.page, kind: stage.mode, all: stage.mode === 'crop', x: a.x, y: a.y, w: 0, h: 0 };
  if (m.all) stage.marks = [];
  stage.marks.push(m);
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no pointer to capture */ }
  el.onpointermove = ev => {
    const b = pt(ev);
    Object.assign(m, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
    drawMarks();
  };
  el.onpointerup = () => {
    el.onpointermove = el.onpointerup = null;
    if (m.w < .01 || m.h < .01) stage.marks.splice(stage.marks.indexOf(m), 1);
    else if (m.kind === 'white') { // cover with the colour that's most common under the box
      const c = el.querySelector('canvas'), b = [m.x * c.width, m.y * c.height, (m.x + m.w) * c.width, (m.y + m.h) * c.height].map(Math.round);
      m.bg = dominant(c.getContext('2d').getImageData(0, 0, c.width, c.height), ...b, 2).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    drawMarks();
  };
}

/* ---------- Signature pad ---------- */
function padInit() {
  const c = $('pad'), ctx = c.getContext('2d', { willReadFrequently: true });
  const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--sig-ink').trim() || '#1a2a6c';
  Object.assign(ctx, { lineWidth: 6, lineCap: 'round', lineJoin: 'round' });
  const pos = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  c.onpointerdown = e => {
    try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    ctx.strokeStyle = ink();
    let last = pos(e);
    const seg = ev => { const p = pos(ev); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; };
    seg(e);
    c.onpointermove = seg;
  };
  c.onpointerup = () => { c.onpointermove = null; };
}
// The drawn signature, cropped to the ink, always in dark blue ink whatever the theme.
function padImage() {
  const c = $('pad'), { data, width: W, height: H } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const out = Object.assign(document.createElement('canvas'), { width: x1 - x0 + 1, height: y1 - y0 + 1 }), o = out.getContext('2d');
  o.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  o.globalCompositeOperation = 'source-in';
  o.fillStyle = '#13235e';
  o.fillRect(0, 0, out.width, out.height);
  return { url: out.toDataURL('image/png'), ratio: out.height / out.width };
}

// Open with ?selftest to check the parsers.
if (location.search.includes('selftest')) {
  const same = (a, b) => console.assert(JSON.stringify(a) === JSON.stringify(b), 'mismatch', a, b);
  same(parseRanges('1-3, 5', 9), [0, 1, 2, 4]);
  same(parseRanges(' 2 ', 2), [1]);
  for (const bad of ['4', '0', '3-1', 'a', '']) { let threw = false; try { parseRanges(bad, 3); } catch { threw = true; } console.assert(threw, 'parseRanges should reject', bad); }
  same(typed('1,200'), { t: 'n', v: 1200, z: '#,##0' });
  same(typed('(3.50)'), -3.5);
  same(typed('15%'), { t: 'n', v: .15, z: '0%' });
  same(typed('007'), '007');
  same(typed('$12.00'), { t: 'n', v: 12, z: '"$"#,##0.00' });
  same(typed('Apple'), 'Apple');
  console.log('selftest done');
}

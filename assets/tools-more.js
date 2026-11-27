/* Nebula: more PDF tools. Flatten, remove annotations, find & redact, compare, PowerPoint to PDF, plus Workflow (run tools one after another) and Studio (one workspace for a PDF).
   Also extends Merge (any file type), Sign (type or upload a signature) and Protect (permissions).
   Loaded after engine.js and before app.js; adds to its TOOLS. Everything runs on the device. */

/* ---------- small PDF-object helpers ---------- */
const pdfObj = () => { const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFHexString, PDFRawStream, PDFStream } = PDFLib; return { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFHexString, PDFRawStream, PDFStream, N: PDFName.of }; };
const nums = arr => arr?.asArray?.().map(n => n.asNumber?.() ?? 0);
const pageAnnots = page => { const { PDFArray, N } = pdfObj(); const a = page.node.lookup(N('Annots')); return a instanceof PDFArray ? a : null; };
const annotType = (doc, ref) => doc.context.lookup(ref)?.get?.(PDFLib.PDFName.of('Subtype'))?.toString().slice(1) || '';
const ANNOT_KINDS = {
  comments: ['Text', 'FreeText', 'Popup'],
  markup: ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment', 'Sound', 'Redact'],
  links: ['Link'],
};

// Draw an annotation's normal appearance into the page itself (the way a viewer would show it), so it can't be
// moved or deleted any more. Same mapping as the PDF spec: the appearance's box, after its own matrix, fills the Rect.
function bakeAnnotation(doc, page, ref) {
  const { PDFDict, PDFRawStream, PDFStream, N } = pdfObj(), ctx = doc.context, a = ctx.lookup(ref);
  if (!(a instanceof PDFDict)) return false;
  const flags = a.get(N('F'))?.asNumber?.() || 0;
  if (flags & (2 | 32)) return true; // hidden or no-view: nothing to draw, just drop it
  let ap = ctx.lookup(ctx.lookup(a.get(N('AP')))?.get?.(N('N')));
  if (ap instanceof PDFDict && !(ap instanceof PDFStream)) { const as = a.get(N('AS')); ap = as ? ctx.lookup(ap.get(as)) : null; } // appearance states
  const stream = ap instanceof PDFRawStream || ap instanceof PDFStream ? ap : null;
  const rect = nums(ctx.lookup(a.get(N('Rect'))));
  if (!stream || !rect) return false;
  const bbox = nums(ctx.lookup(stream.dict.get(N('BBox')))) || [0, 0, 1, 1], m = nums(ctx.lookup(stream.dict.get(N('Matrix')))) || [1, 0, 0, 1, 0, 0];
  const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const tx = Math.min(...pts.map(p => p[0])), ty = Math.min(...pts.map(p => p[1])), tw = Math.max(...pts.map(p => p[0])) - tx, th = Math.max(...pts.map(p => p[1])) - ty;
  const [x1, y1, x2, y2] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (!tw || !th) return true;
  const sx = (x2 - x1) / tw, sy = (y2 - y1) / th, apRef = a.get(N('AP')) && ctx.lookup(a.get(N('AP'))).get(N('N'));
  const xref = apRef instanceof PDFLib.PDFRef ? (ctx.lookup(apRef) === stream ? apRef : ctx.register(stream)) : ctx.register(stream);
  const name = page.node.newXObject('FlatAnnot', xref);
  page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(sx, 0, 0, sy, x1 - tx * sx, y1 - ty * sy), PDFLib.drawObject(name), PDFLib.popGraphicsState());
  return true;
}
function dropAnnots(doc, keep) { // keep(type) -> true to keep; returns how many were removed
  const { PDFArray, N } = pdfObj();
  let removed = 0;
  for (const page of doc.getPages()) {
    const annots = pageAnnots(page);
    if (!annots) continue;
    const kept = annots.asArray().filter(r => keep(annotType(doc, r), r, page) || !++removed);
    page.node.set(N('Annots'), doc.context.obj(kept));
    if (!kept.length) page.node.delete(N('Annots'));
  }
  return removed;
}

/* ---------- text on a page, as lines with character positions (find & redact, compare) ---------- */
async function pageLines(view, n) {
  const page = await view.getPage(n), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent();
  const lines = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const [a, b, c, d, e, f] = it.transform, size = Math.hypot(c, d) || Math.hypot(a, b);
    if (Math.abs(b) > Math.abs(a) * .2) { lines.push({ y: f, size, parts: [{ it, start: 0, size }], text: it.str, vp }); continue; } // turned text: its own line
    let line = lines.find(l => !l.turned && Math.abs(l.y - f) < size * .35 && Math.abs(l.size - size) < size * .5);
    if (!line) { line = { y: f, size, parts: [], text: '', vp }; lines.push(line); }
    const last = line.parts.at(-1);
    if (last && e - (last.it.transform[4] + last.it.width) > size * .15 && !/\s$/.test(line.text) && !/^\s/.test(it.str)) line.text += ' ';
    line.parts.push({ it, start: line.text.length, size });
    line.text += it.str;
  }
  lines.forEach(l => { l.parts.sort((p, q) => p.it.transform[4] - q.it.transform[4]); });
  return { lines: lines.sort((p, q) => q.y - p.y), vp };
}
// The box (0..1 of the visible page) around characters [s, e) of a line.
function lineBox(line, s, e) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of line.parts) {
    const len = p.it.str.length, a = Math.max(s, p.start), b = Math.min(e, p.start + len);
    if (a >= b) continue;
    const [, , , , ex, fy] = p.it.transform, w = p.it.width, h = p.size;
    const corners = [[ex + w * (a - p.start) / len, fy - h * .28], [ex + w * (b - p.start) / len, fy + h * .92]].map(([x, y]) => line.vp.convertToViewportPoint(x, y));
    corners.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
  }
  if (x0 === Infinity) return null;
  const pad = 1.5, W = line.vp.width, H = line.vp.height;
  return { x: (x0 - pad) / W, y: (y0 - pad) / H, w: (x1 - x0 + 2 * pad) / W, h: (y1 - y0 + 2 * pad) / H };
}

/* ---------- find & redact: what to look for ---------- */
const FIND_PRESETS = {
  email: [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'Email addresses'],
  phone: [/(?<!\w)(\+?\d[\d\s().-]{7,}\d)(?!\w)/g, 'Phone numbers'],
  card: [/\b(?:\d[ -]?){13,19}\b/g, 'Card and account numbers'],
  date: [/\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g, 'Dates'],
};
function findPatterns() {
  const words = val('o-find').split('\n').map(s => s.trim()).filter(Boolean), out = [];
  const flags = $('o-case').checked ? 'g' : 'gi', whole = $('o-whole').checked;
  for (const w of words) out.push(new RegExp(`${whole ? '(?<![\\p{L}\\p{N}])' : ''}${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}${whole ? '(?![\\p{L}\\p{N}])' : ''}`, `${flags}u`));
  for (const [k, [re]] of Object.entries(FIND_PRESETS)) if ($(`o-p-${k}`)?.checked) out.push(re);
  return out;
}
async function findMatches(view, patterns) {
  const hits = []; // { page, box, text }
  for (let n = 1; n <= view.numPages; n++) {
    progress(`Searching page ${n} of ${view.numPages}`, n / view.numPages * .5);
    const { lines } = await pageLines(view, n);
    for (const line of lines) for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of line.text.matchAll(re)) {
        if (!m[0].trim()) continue;
        const box = lineBox(line, m.index, m.index + m[0].length);
        if (box) hits.push({ page: n, box, text: m[0] });
      }
    }
  }
  return hits;
}

/* ---------- compare: a word diff (longest common subsequence) ---------- */
function wordDiff(a, b) {
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  if (A.length * B.length > 9e6) return null; // too long to diff word by word in the browser
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (k, w) => { const last = out.at(-1); if (last?.k === k) last.w.push(w); else out.push({ k, w: [w] }); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('-', A[i++]);
    else push('+', B[j++]);
  }
  while (i < n) push('-', A[i++]);
  while (j < m) push('+', B[j++]);
  return out;
}
const pageText = async (view, n) => (await pageLines(view, n)).lines.map(l => l.text).join('\n');

/* ---------- the tools ---------- */
Object.assign(TOOLS, {
  flatten: {
    group: 'security', name: 'Flatten PDF', icon: 'stack', keys: 'flatten forms fields annotations comments lock merge layers bake',
    desc: 'Bake form fields, comments and stamps into the page, so they print as shown and can’t be changed.',
    accept: PDF, btn: 'Flatten PDF', libs: ['pdflib'], batch: true,
    options: () => check('o-fforms', 'Form fields') + check('o-fannots', 'Comments, highlights, stamps and drawings') +
      hint('Links keep working. Anything flattened becomes part of the page.'),
    async run([f]) {
      const doc = await openPdf(f);
      let forms = 0, annots = 0;
      if ($('o-fforms').checked) {
        const form = doc.getForm();
        forms = form.getFields().length;
        if (forms) try { form.flatten({ updateFieldAppearances: true }); } catch { form.flatten({ updateFieldAppearances: false }); }
      }
      if ($('o-fannots').checked) {
        for (const page of doc.getPages()) {
          const list = pageAnnots(page);
          if (!list) continue;
          const keep = [];
          for (const r of list.asArray()) {
            const type = annotType(doc, r);
            if (type === 'Link' || type === 'Widget') { keep.push(r); continue; }
            if (type === 'Popup' || bakeAnnotation(doc, page, r)) annots++; else keep.push(r);
          }
          page.node.set(PDFLib.PDFName.of('Annots'), doc.context.obj(keep));
        }
      }
      if (!forms && !annots) throw new UserError('This PDF has no form fields or comments to flatten.');
      save(await doc.save(), `${stem(f)}-flattened.pdf`);
      return `Flattened ${[forms && plural(forms, 'form field'), annots && plural(annots, 'comment or mark')].filter(Boolean).join(' and ')}`;
    },
  },
  removeannots: {
    group: 'edit', name: 'Remove annotations', icon: 'eraser', keys: 'annotations comments notes highlights markup links remove delete clean',
    desc: 'Delete comments, highlights, drawings and stamps, and optionally links, in one go.',
    accept: PDF, btn: 'Remove annotations', libs: ['pdflib'], batch: true,
    options: () => check('o-acomments', 'Comments and notes') + check('o-amarkup', 'Highlights, drawings and stamps') + check('o-alinks', 'Links', false) +
      hint('Form fields are left alone. To lock them instead, use Flatten PDF.'),
    async run([f]) {
      const doc = await openPdf(f), drop = new Set([...$('o-acomments').checked ? ANNOT_KINDS.comments : [], ...$('o-amarkup').checked ? ANNOT_KINDS.markup : [], ...$('o-alinks').checked ? ANNOT_KINDS.links : []]);
      if (!drop.size) throw new UserError('Choose what to remove.');
      const removed = dropAnnots(doc, type => !drop.has(type));
      if (!removed) throw new UserError('No annotations of those kinds were found.');
      save(await doc.save(), `${stem(f)}-clean.pdf`);
      return `Removed ${plural(removed, 'annotation')}`;
    },
  },
  findredact: {
    group: 'security', name: 'Find & redact', icon: 'search', keys: 'redact search find black out hide email phone sensitive personal data gdpr censor',
    desc: 'Search for words, names, emails or phone numbers and black out every match for good.',
    accept: PDF, btn: 'Redact matches', libs: ['pdflib', 'pdfjs'], batch: true,
    options: () => `<label class="field"><span class="field-label">Words or phrases to hide, one per line</span><textarea id="o-find" class="input" placeholder="Jane Smith&#10;Account 4471"></textarea></label>
      <div class="field"><span class="field-label">Also find</span><div class="check-grid">${Object.entries(FIND_PRESETS).map(([k, [, l]]) => check(`o-p-${k}`, l, false)).join('')}</div></div>
      ${row(check('o-case', 'Match capitals exactly', false), check('o-whole', 'Whole words only', true))}
      <div class="row"><button type="button" class="chip" id="o-count">${icon('search')}Count matches</button><span class="hint" id="o-found"></span></div>
      ${hint('Pages with a match are rebuilt as images with the matches blacked out, so the hidden text can’t be recovered. Other pages keep their text.')}`,
    ready([f]) {
      $('o-count').onclick = async () => {
        const pats = findPatterns();
        if (!pats.length) return showToast('Type what to look for, or tick a kind of data.', true);
        $('o-found').textContent = 'Searching…';
        const hits = await findMatches(await openView(f), pats); setLoading(false);
        const pages = [...new Set(hits.map(h => h.page))];
        $('o-found').textContent = hits.length ? `${`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`} on ${plural(pages.length, 'page')}: ${pages.slice(0, 12).join(', ')}${pages.length > 12 ? '…' : ''}` : 'No matches.';
      };
    },
    async run([f]) {
      const pats = findPatterns();
      if (!pats.length) throw new UserError('Type what to look for, or tick a kind of data.');
      const view = await openView(f), hits = await findMatches(view, pats);
      if (!hits.length) throw new UserError('Nothing matched, so nothing was redacted.');
      const doc = await openPdf(f), out = await PDFLib.PDFDocument.create(), n = doc.getPageCount();
      for (let i = 0; i < n; i++) {
        const ms = hits.filter(h => h.page === i + 1);
        if (!ms.length) { out.addPage((await out.copyPages(doc, [i]))[0]); continue; }
        progress(`Redacting page ${i + 1}`, .5 + i / n * .5);
        await addImagePage(out, await pageJpeg(view, i + 1, 200, .9, (ctx, c) => {
          ctx.fillStyle = '#000';
          ms.forEach(({ box: b }) => ctx.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height));
        }));
      }
      save(await out.save(), `${stem(f)}-redacted.pdf`);
      return `Redacted ${`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`} on ${plural(new Set(hits.map(h => h.page)).size, 'page')}`;
    },
  },
  compare: {
    group: 'optimize', name: 'Compare PDFs', icon: 'copy', keys: 'compare difference diff changes versions redline revisions spot',
    desc: 'See what changed between two versions of a PDF: changed areas are highlighted, and changed words listed.',
    accept: PDF, multiple: true, ordered: true, quiet: true, wide: true, drop: 'Drop the two PDFs here', note: 'Add the older version first, then the newer one.',
    btn: 'Compare', libs: ['pdflib', 'pdfjs'],
    options: () => `<div id="o-report" class="compare-report"><p class="hint">${uploadedFiles.length < 2 ? 'Add the second PDF to compare.' : 'Press Compare to see the differences.'}</p></div>`,
    async run(files) {
      if (files.length !== 2) throw new UserError('Add exactly two PDFs: the older version first, then the newer one.');
      const [a, b] = await Promise.all(files.map(openView)), n = Math.max(a.numPages, b.numPages), box = $('o-report'), report = [];
      box.innerHTML = '';
      let changed = 0;
      for (let i = 1; i <= n; i++) {
        progress(`Comparing page ${i} of ${n}`, i / n);
        const ca = i <= a.numPages ? await renderPage(a, i, 1.4) : null, cb = i <= b.numPages ? await renderPage(b, i, 1.4) : null;
        const ta = ca ? await pageText(a, i) : '', tb = cb ? await pageText(b, i) : '';
        let share = 1;
        if (ca && cb) share = markChanges(ca, cb);
        const diff = ta === tb ? [] : wordDiff(ta, tb);
        const same = ca && cb && share < .0005 && ta === tb;
        if (same) continue;
        changed++;
        const sec = document.createElement('section');
        sec.className = 'cmp-page';
        sec.innerHTML = `<header><b>Page ${i}</b><span class="hint">${!ca ? 'Only in the newer version' : !cb ? 'Only in the older version' : `${Math.max(.1, share * 100).toFixed(1)}% of the page changed`}</span></header>
          <div class="cmp-pair"><figure><figcaption class="label">Older</figcaption></figure><figure><figcaption class="label">Newer</figcaption></figure></div>
          ${diff === null ? '<p class="hint">Too much text to list word by word.</p>' : diff.some(d => d.k !== '=') ? `<p class="cmp-text">${diff.map(d => d.k === '=' ? esc(d.w.length > 14 ? `${d.w.slice(0, 6).join(' ')} … ${d.w.slice(-6).join(' ')}` : d.w.join(' ')) : `<${d.k === '+' ? 'ins' : 'del'}>${esc(d.w.join(' '))}</${d.k === '+' ? 'ins' : 'del'}>`).join(' ')}</p>` : '<p class="hint">The words are the same; something else on the page changed (layout, pictures or drawings).</p>'}`;
        const figs = sec.querySelectorAll('figure');
        figs[0].append(ca || placeholder()); figs[1].append(cb || placeholder());
        box.append(sec);
        report.push({ i, ca, cb });
      }
      if (!changed) { box.innerHTML = `<p class="cmp-same">${icon('check')}No differences found: the pages look the same and have the same text.</p>`; return 'No differences'; }
      box.insertAdjacentHTML('afterbegin', `<div class="cmp-head"><p><b>${plural(changed, 'page')} changed</b> out of ${n}. Changed areas are outlined in red on the newer page; removed words are <del>struck out</del>, added words <ins>underlined</ins>.</p><button type="button" class="chip" id="o-cmp-pdf">${icon('download')}Download report as PDF</button></div>`);
      $('o-cmp-pdf').onclick = async () => {
        const out = await PDFLib.PDFDocument.create();
        for (const r of report) {
          const w = (r.ca?.width || 0) + (r.cb?.width || 0) + 30, h = Math.max(r.ca?.height || 0, r.cb?.height || 0) + 20;
          const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d');
          g.fillStyle = '#e9ebf0'; g.fillRect(0, 0, w, h);
          if (r.ca) g.drawImage(r.ca, 10, 10);
          if (r.cb) g.drawImage(r.cb, (r.ca?.width || 0) + 20, 10);
          const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', .85));
          await addImagePage(out, { bytes: await blob.arrayBuffer(), w: w * .5, h: h * .5 });
        }
        save(await out.save(), 'comparison.pdf');
      };
      return `${plural(changed, 'page')} changed`;
    },
  },
});
const placeholder = () => Object.assign(document.createElement('div'), { className: 'cmp-missing', textContent: 'No page' });
// Outline changed areas of the newer page in red (in blocks, so a moved word is one box, not a scatter of pixels).
// Returns the share of the page that changed.
function markChanges(ca, cb) {
  const w = Math.min(ca.width, cb.width), h = Math.min(ca.height, cb.height), B = 10;
  const da = ca.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data, db = cb.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const cols = Math.ceil(w / B), rows = Math.ceil(h / B), hot = new Uint8Array(cols * rows);
  let diff = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, d = Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]);
    if (d > 90) { diff++; hot[(y / B | 0) * cols + (x / B | 0)] = 1; }
  }
  const g = cb.getContext('2d');
  g.fillStyle = 'rgba(255, 60, 80, .16)'; g.strokeStyle = 'rgba(230, 30, 60, .9)'; g.lineWidth = 2;
  // join touching blocks into boxes
  const seen = new Uint8Array(hot.length);
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i] || seen[i]) continue;
    let x0 = i % cols, x1 = x0, y0 = i / cols | 0, y1 = y0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % cols, y = j / cols | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy, nj = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && hot[nj] && !seen[nj]) { seen[nj] = 1; stack.push(nj); }
      }
    }
    g.fillRect(x0 * B - 3, y0 * B - 3, (x1 - x0 + 1) * B + 6, (y1 - y0 + 1) * B + 6);
    g.strokeRect(x0 * B - 3, y0 * B - 3, (x1 - x0 + 1) * B + 6, (y1 - y0 + 1) * B + 6);
  }
  return diff / (w * h) + (ca.width !== cb.width || ca.height !== cb.height ? .01 : 0);
}

/* ---------- Protect: a password to open, and/or limits on printing, copying and editing ---------- */
Object.assign(TOOLS.protect, {
  desc: 'Lock a PDF with a password, or stop people printing, copying or editing it. AES-256 encryption.',
  keys: `${TOOLS.protect.keys} permissions restrict print copy edit`,
  options: () => sel('o-pmode', 'Protection', [['open', 'A password is needed to open it'], ['limit', 'Opens freely, but with limits']]) +
    row(inp('o-pw', 'Password', 'type="password" autocomplete="new-password"'), inp('o-pw2', 'Repeat password', 'type="password" autocomplete="new-password"')) +
    `<div class="field"><span class="field-label">Let people</span><div class="check-grid">${check('o-aprint', 'Print it')}${check('o-acopy', 'Copy text and pictures')}${check('o-aedit', 'Edit, comment and fill forms')}</div></div>` +
    hint('With limits, the password is the one that lifts them. Keep it safe: nobody, including Nebula, can recover it. Most PDF apps respect these limits, but they can’t stop screenshots.'),
  async run([f]) {
    const pw = val('o-pw'), open = val('o-pmode') === 'open';
    if (!pw) throw new UserError('Type a password first.');
    if (pw !== val('o-pw2')) throw new UserError("The passwords don't match.");
    const edit = $('o-aedit').checked, permissions = { printing: $('o-aprint').checked ? 'highResolution' : false, copying: $('o-acopy').checked, modifying: edit, annotating: edit, fillingForms: edit, documentAssembly: edit, contentAccessibility: true };
    if (!open && permissions.printing && permissions.copying && edit) throw new UserError('Untick at least one thing to limit, or choose a password to open it.');
    const doc = await openPdf(f);
    doc.encrypt({ userPassword: open ? pw : '', ownerPassword: pw, permissions });
    save(await doc.save(), `${stem(f)}-protected.pdf`);
    return open ? 'Protected with a password' : 'Limits added';
  },
});
TOOLS.unlock.desc = 'Take the password, or the limits on printing and copying, off a PDF, as long as you know the password.';

/* ---------- Sign: draw, type or upload a signature. Every mode paints the same #pad canvas, so placing and saving stay as they were ---------- */
const SIG_FONTS = [['Caveat', 'Casual'], ['Dancing Script', 'Flowing'], ['Great Vibes', 'Formal'], ['Homemade Apple', 'Handwritten']];
let sigFontsLoad;
const sigFonts = () => sigFontsLoad ??= new Promise(ok => document.head.append(Object.assign(document.createElement('link'), {
  rel: 'stylesheet', onload: ok, onerror: ok, // offline it falls back to the browser's cursive font
  href: 'https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&family=Homemade+Apple&display=swap' })));
const sigInk = () => getComputedStyle(document.documentElement).getPropertyValue('--sig-ink').trim() || '#1a2a6c';
let sigGen = 0;
async function sigType() {
  const gen = ++sigGen, text = val('o-sigtext').trim(), font = val('o-sigfont');
  await sigFonts();
  await document.fonts.load(`100px "${font}"`, text || 'a').catch(() => {});
  if (gen !== sigGen || segValue('o-sigmode') !== 'type') return; // a newer keystroke paints instead
  const c = $('pad'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!text) return;
  ctx.font = `150px "${font}", cursive`;
  const size = 150 * Math.min(1, c.width * .9 / ctx.measureText(text).width);
  Object.assign(ctx, { font: `${size}px "${font}", cursive`, fillStyle: sigInk(), textAlign: 'center', textBaseline: 'middle' });
  ctx.fillText(text, c.width / 2, c.height / 2);
}
// A photo or scan of a signature on paper: the paper turns clear, the ink stays.
async function sigUpload(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return showToast(`${file.name} isn't an image this browser can open.`, true);
  const c = $('pad'), ctx = c.getContext('2d'), k = Math.min(c.width * .95 / bmp.width, c.height * .9 / bmp.height);
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k), x = (c.width - w) >> 1, y = (c.height - h) >> 1;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, x, y, w, h);
  const img = ctx.getImageData(x, y, w, h), p = img.data, lum = i => p[i] * .3 + p[i + 1] * .59 + p[i + 2] * .11;
  let paper = 0, n = 0;
  for (let i = 0; i < p.length; i += 4) if (p[i + 3]) { paper += lum(i); n++; } // ink is a small share, so the mean is about the paper
  paper = n ? paper / n : 255;
  for (let i = 0; i < p.length; i += 4) p[i + 3] = Math.round(p[i + 3] * Math.min(1, Math.max(0, (paper - 30 - lum(i)) / 50)));
  ctx.putImageData(img, x, y);
}
const SIGN0 = { options: TOOLS.sign.options, ready: TOOLS.sign.ready };
Object.assign(TOOLS.sign, {
  desc: 'Draw, type or upload your signature and place it anywhere on the page.',
  keys: `${TOOLS.sign.keys} type name upload photo scan`,
  options: () => `<div class="seg" role="group" aria-label="How to sign" id="o-sigmode">
      <button type="button" class="seg-btn" data-k="draw" aria-pressed="true" onclick="segPick(this)">${icon('signature')}Draw</button>
      <button type="button" class="seg-btn" data-k="type" aria-pressed="false" onclick="segPick(this)">${icon('type')}Type</button>
      <button type="button" class="seg-btn" data-k="upload" aria-pressed="false" onclick="segPick(this)">${icon('img')}Upload</button></div>
    <div id="o-sigmode-type" class="options-sub hidden">${row(inp('o-sigtext', 'Your name', 'autocomplete="name" placeholder="Jane Doe"'), sel('o-sigfont', 'Style', SIG_FONTS))}</div>
    <div id="o-sigmode-upload" class="options-sub hidden"><label class="field"><span class="field-label">Photo or scan of your signature on white paper</span><input id="o-sigfile" type="file" accept="image/*" class="input file-pick"></label></div>
    ${SIGN0.options().replace('Draw your signature', 'Your signature')}`,
  async ready(files) {
    await SIGN0.ready(files);
    const clear = () => $('pad').getContext('2d').clearRect(0, 0, 900, 260);
    $('o-sigmode').addEventListener('pick', e => { clear(); if (e.detail === 'type') { sigType(); $('o-sigtext').focus(); } if (e.detail === 'upload' && $('o-sigfile').files[0]) sigUpload($('o-sigfile').files[0]); });
    $('o-sigtext').oninput = $('o-sigfont').onchange = sigType;
    $('o-sigfile').onchange = e => e.target.files[0] && sigUpload(e.target.files[0]);
  },
});

/* ---------- PowerPoint to PDF: each slide is drawn on a canvas from its XML (with what it inherits from its layout,
   master and theme), then becomes one page. Text, shapes, pictures and tables come across; charts and effects don't. ---------- */
const PT = 12700; // EMU in a point
const xkid = (el, ...path) => path.reduce((e, n) => e && [...e.children].find(c => c.localName === n), el);
const xkids = (el, n) => el ? [...el.children].filter(c => !n || c.localName === n) : [];
const xdeep = (el, n) => el?.getElementsByTagNameNS('*', n)[0];
const xnum = (el, a, d = 0) => el?.hasAttribute(a) ? +el.getAttribute(a) : d;
const first = (list, f) => { for (const e of list) { const v = e && f(e); if (v != null) return v; } };
const zipPath = (dir, t) => { if (t.startsWith('/')) return t.slice(1); const out = dir.split('/').filter(Boolean); for (const s of t.split('/')) s === '..' ? out.pop() : s && s !== '.' && out.push(s); return out.join('/'); };
const rgb2hsl = (r, g, b) => {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, l > .5 ? d / (2 - mx - mn) : d / (mx + mn), l];
};
const hsl2rgb = (h, s, l) => {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return 255 * (t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p); };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
};
const PRST_CLR = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500' };
// The colour inside a fill, a style reference or a gradient stop, with its tint, shade, brightness and transparency.
function pptColor(holder, S) {
  const c = xkids(holder).find(c => /Clr$/.test(c.localName));
  if (!c) return null;
  const v = c.getAttribute('val');
  const hex = c.localName === 'srgbClr' ? v : c.localName === 'sysClr' ? c.getAttribute('lastClr') || (v === 'window' ? 'FFFFFF' : '000000')
    : c.localName === 'schemeClr' ? S.scheme(v) : PRST_CLR[v] || '000000';
  let [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0), a = 1;
  for (const m of xkids(c)) {
    const k = xnum(m, 'val') / 1e5, n = m.localName;
    if (n === 'alpha') a = k;
    else if (n === 'shade') [r, g, b] = [r, g, b].map(x => x * k);
    else if (n === 'tint') [r, g, b] = [r, g, b].map(x => 255 - (255 - x) * k);
    else if (n === 'lumMod' || n === 'lumOff') { const [h, s, l] = rgb2hsl(r, g, b); [r, g, b] = hsl2rgb(h, s, n === 'lumMod' ? l * k : Math.min(1, l + k)); }
  }
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}
// A fill: null for none, a colour string, or { blip } for a picture fill. `ref` is the theme style used when the shape sets none.
function pptFill(el, S, ref) {
  for (const c of xkids(el)) {
    if (c.localName === 'noFill') return null;
    if (c.localName === 'solidFill') return pptColor(c, S);
    if (c.localName === 'gradFill') return pptColor(xdeep(c, 'gs'), S);
    if (c.localName === 'blipFill') return { blip: xdeep(c, 'blip')?.getAttribute('r:embed'), src: xdeep(c, 'srcRect') };
  }
  return ref && xnum(ref, 'idx') ? pptColor(ref, S) : null;
}
async function pptImage(S, part, rid) {
  const p = part.rels[rid], f = p && S.zip.file(p);
  if (!f) return null;
  return S.imgs[p] ??= f.async('blob').then(b => createImageBitmap(b)).catch(() => null); // EMF/WMF and other formats browsers can't draw are left out
}
async function pptDrawImage(ctx, S, part, fill, b) {
  const img = await pptImage(S, part, fill.blip);
  if (!img) return;
  const s = fill.src, [l, t, r, btm] = ['l', 't', 'r', 'b'].map(k => xnum(s, k) / 1e5);
  ctx.drawImage(img, img.width * l, img.height * t, img.width * (1 - l - r), img.height * (1 - t - btm), b.x, b.y, b.w, b.h);
}
// Traces the outline of a shape; returns false for lines, which have no inside to fill.
function pptPath(ctx, spPr, { x, y, w, h }) {
  const g = xkid(spPr, 'prstGeom'), cust = xkid(spPr, 'custGeom'), p = g?.getAttribute('prst') || (cust ? 'cust' : 'rect');
  ctx.beginPath();
  if (p === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 2 * Math.PI);
  else if (p === 'roundRect' && ctx.roundRect) { const gd = xdeep(g, 'gd'); ctx.roundRect(x, y, w, h, Math.min(w, h) * (gd ? +gd.getAttribute('fmla').split(' ')[1] / 1e5 : .16667)); }
  else if (/^(line|straightConnector1|.*Connector\d)$/.test(p)) { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); return false; }
  else if (p === 'triangle') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
  else if (p === 'rtTriangle') { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
  else if (p === 'diamond') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); }
  else if (p === 'cust') {
    for (const path of xkids(xdeep(cust, 'pathLst'), 'path')) {
      const sx = path.hasAttribute('w') ? w / (xnum(path, 'w') || 1) : 1 / PT, sy = path.hasAttribute('h') ? h / (xnum(path, 'h') || 1) : 1 / PT;
      const pt = e => [x + xnum(e, 'x') * sx, y + xnum(e, 'y') * sy];
      for (const c of xkids(path)) {
        const pts = xkids(c, 'pt').map(pt);
        if (c.localName === 'moveTo') ctx.moveTo(...pts[0]);
        else if (c.localName === 'lnTo') ctx.lineTo(...pts[0]);
        else if (c.localName === 'cubicBezTo') ctx.bezierCurveTo(...pts.flat());
        else if (c.localName === 'quadBezTo') ctx.quadraticCurveTo(...pts.flat());
        else if (c.localName === 'close') ctx.closePath();
      }
    }
  }
  else ctx.rect(x, y, w, h); // ponytail: other preset shapes (arrows, stars…) draw as their box; add outlines when someone needs them
  return true;
}
const WINGDINGS = { 'Ø': '➢', '§': '▪', q: '❑', ü: '✓', v: '❖', n: '■', l: '●', Ü: '➢', 'à': '➔' };
const fontStack = face => `"${face}", ${/Times|Georgia|Cambria|Garamond|Book|Serif/i.test(face) ? 'Georgia, serif' : 'Carlito, Arial, sans-serif'}`;
// Lays out and draws a text body inside box b. `chain(lvl)` lists the paragraph styles to fall back on, nearest first.
// With dry set it only measures, and returns the height the text needs.
function pptText(ctx, txBody, b, S, { chain, bodies = [], color, title, anchor: anchor0, ins: ins0, dry }) {
  const bodyList = [xkid(txBody, 'bodyPr'), ...bodies];
  const ins = (k, d) => first(bodyList, e => e.hasAttribute(k) ? xnum(e, k) / PT : null) ?? d;
  const { L, R, T, B } = ins0 || { L: ins('lIns', 7.2), R: ins('rIns', 7.2), T: ins('tIns', 3.6), B: ins('bIns', 3.6) };
  const anchor = anchor0 || first(bodyList, e => e.getAttribute('anchor')) || 't', wrap = first(bodyList, e => e.getAttribute('wrap')) !== 'none';
  const fit = xdeep(xkid(txBody, 'bodyPr'), 'normAutofit'), scale = xnum(fit, 'fontScale', 1e5) / 1e5, lnRed = xnum(fit, 'lnSpcReduction') / 1e5;
  const maxW = Math.max(1, b.w - L - R), lines = [], counters = {};
  const runStyle = (rPr, ch) => {
    const list = [rPr, ...ch.map(c => xkid(c, 'defRPr'))];
    const size = (first(list, e => e.hasAttribute('sz') ? xnum(e, 'sz') / 100 : null) ?? 18) * scale;
    const flag = k => first(list, e => e.hasAttribute(k) ? /^(1|true)$/.test(e.getAttribute(k)) : null) ?? false;
    let face = first(list, e => xkid(e, 'latin')?.getAttribute('typeface')) ?? (title ? '+mj-lt' : '+mn-lt');
    if (face.startsWith('+')) face = face.startsWith('+mj') ? S.fonts.major : S.fonts.minor;
    return { size, bold: flag('b'), italic: flag('i'), under: first(list, e => e.getAttribute('u')) > '' && first(list, e => e.getAttribute('u')) !== 'none',
      color: first(list.slice(0, -1), e => xkid(e, 'solidFill') && pptColor(xkid(e, 'solidFill'), S)) ?? color ?? first(list.slice(-1), e => xkid(e, 'solidFill') && pptColor(xkid(e, 'solidFill'), S)) ?? `#${S.scheme('tx1')}`, // the shape's theme style comes before the master's default
      font: `${flag('i') ? 'italic ' : ''}${flag('b') ? 'bold ' : ''}${size.toFixed(2)}px ${fontStack(face)}` };
  };
  for (const p of xkids(txBody, 'p')) {
    const pPr = xkid(p, 'pPr'), lvl = xnum(pPr, 'lvl'), ch = [pPr, ...chain(lvl)];
    const at = (k, d) => first(ch, e => e.hasAttribute(k) ? e.getAttribute(k) : null) ?? d;
    const algn = at('algn', 'l'), marL = +at('marL', 0) / PT, indent = +at('indent', 0) / PT;
    const sp = first(ch, e => xkid(e, 'lnSpc')), spc = sp && xkid(sp, 'spcPct') ? xnum(xkid(sp, 'spcPct'), 'val') / 1e5 : 1, spcPts = sp && xkid(sp, 'spcPts') ? xnum(xkid(sp, 'spcPts'), 'val') / 100 : 0;
    const bef = first(ch, e => xkid(e, 'spcBef'));
    const runs = [];
    for (const r of xkids(p)) {
      if (r.localName === 'r' || r.localName === 'fld') runs.push({ t: /slidenum/i.test(r.getAttribute('type') || '') ? String(S.num) : xkid(r, 't')?.textContent ?? '', st: runStyle(xkid(r, 'rPr'), ch) });
      else if (r.localName === 'br') runs.push({ br: true, st: runStyle(xkid(r, 'rPr'), ch) });
    }
    const endSt = runStyle(xkid(p, 'endParaRPr'), ch), hasText = runs.some(r => r.t?.trim());
    const bu = first(ch, e => xkid(e, 'buNone') ? 'none' : xkid(e, 'buChar') ? xkid(e, 'buChar').getAttribute('char') : xkid(e, 'buAutoNum') ? 'num' : null);
    counters[lvl] = bu === 'num' && hasText ? (counters[lvl] || 0) + 1 : 0;
    let bullet = hasText && bu && bu !== 'none' ? (bu === 'num' ? `${counters[lvl]}.` : bu) : '';
    if (bullet && /Wingdings/i.test(first(ch, e => xkid(e, 'buFont')?.getAttribute('typeface')) || '')) bullet = WINGDINGS[bullet] || '•';
    const pctBef = bef && xkid(bef, 'spcPct') ? xnum(xkid(bef, 'spcPct'), 'val') / 1e5 * (runs[0]?.st.size || endSt.size) : 0;
    const before = lines.length ? (bef && xkid(bef, 'spcPts') ? xnum(xkid(bef, 'spcPts'), 'val') / 100 : pctBef) : 0;
    const textX = bullet ? marL : marL + indent;
    let line = null;
    const open = firstLine => { line = { segs: [], w: 0, size: 0, x: firstLine ? textX : marL, algn, before: firstLine ? before : 0, spc, spcPts, bullet: firstLine ? bullet : '', bulletSt: runs.find(r => r.t)?.st || endSt, bulletX: marL + indent, cont: !firstLine }; lines.push(line); };
    open(true);
    for (const run of runs) {
      if (run.br) { line.size ||= run.st.size; open(false); continue; }
      ctx.font = run.st.font;
      for (const tok of run.t.split(/(\s+)/)) {
        if (!tok) continue;
        const w = ctx.measureText(tok).width, space = /^\s+$/.test(tok);
        if (wrap && !space && line.segs.length && line.x + line.w + w > maxW) open(false);
        if (space && !line.segs.length && line.cont) continue; // no leading space on wrapped lines
        line.segs.push({ t: tok, st: run.st, x: line.w, w });
        line.w += w;
        line.size = Math.max(line.size, run.st.size);
      }
    }
    if (!line.size) line.size = endSt.size;
  }
  const lh = l => (l.spcPts || l.size * 1.2 * l.spc * (1 - lnRed));
  const total = lines.reduce((s, l) => s + l.before + lh(l), 0);
  if (dry) return total + T + B;
  let y = anchor === 'ctr' ? b.y + T + (b.h - T - B - total) / 2 : anchor === 'b' ? b.y + b.h - B - total : b.y + T;
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    y += l.before;
    const base = y + l.size * (.9 + (Math.min(l.spc, 1.5) - 1) * .5), free = maxW - l.x - l.w;
    const x0 = b.x + L + l.x + (l.algn === 'ctr' ? free / 2 : l.algn === 'r' ? free : 0);
    if (l.bullet) { ctx.font = l.bulletSt.font; ctx.fillStyle = l.bulletSt.color; ctx.fillText(l.bullet, b.x + L + l.bulletX, base); }
    for (const s of l.segs) {
      ctx.font = s.st.font; ctx.fillStyle = s.st.color;
      ctx.fillText(s.t, x0 + s.x, base);
      if (s.st.under) ctx.fillRect(x0 + s.x, base + s.st.size * .1, s.w, Math.max(.5, s.st.size * .06));
    }
    y += lh(l);
  }
}
function pptTable(ctx, tbl, b, S) {
  const cols = xkids(xkid(tbl, 'tblGrid'), 'gridCol').map(c => xnum(c, 'w') / PT), pr = xkid(tbl, 'tblPr');
  const styled = !!xkid(pr, 'tableStyleId'), header = styled && pr.getAttribute('firstRow') === '1', band = styled && pr.getAttribute('bandRow') === '1', accent = S.scheme('accent1');
  const chain = lvl => [xkid(S.pres.root, 'defaultTextStyle', `lvl${lvl + 1}pPr`)];
  const ins = tcPr => ({ L: xnum(tcPr, 'marL', 91440) / PT, R: xnum(tcPr, 'marR', 91440) / PT, T: xnum(tcPr, 'marT', 45720) / PT, B: xnum(tcPr, 'marB', 45720) / PT });
  let y = b.y;
  xkids(tbl, 'tr').forEach((tr, ri) => {
    const cells = [];
    let x = b.x, ci = 0;
    for (const tc of xkids(tr, 'tc')) {
      const span = xnum(tc, 'gridSpan', 1), w = cols.slice(ci, ci + span).reduce((a, c) => a + c, 0);
      if (!tc.hasAttribute('hMerge') && !tc.hasAttribute('vMerge')) cells.push({ tc, tcPr: xkid(tc, 'tcPr'), x, w });
      x += w; ci += span;
    }
    // a row is at least as tall as its text needs (h="0" means "fit the text")
    const h = Math.max(xnum(tr, 'h') / PT, ...cells.map(c => xkid(c.tc, 'txBody') ? pptText(ctx, xkid(c.tc, 'txBody'), { x: c.x, y, w: c.w, h: 0 }, S, { chain, ins: ins(c.tcPr), dry: true }) : 0));
    for (const { tc, tcPr, x, w } of cells) {
      const head = header && ri === 0, own = xkids(tcPr).some(c => /Fill$/.test(c.localName)) ? pptFill(tcPr, S) : undefined;
      // without its own fill a cell takes PowerPoint's default table look: an accent header and banded rows
      const fill = own !== undefined ? own : !styled ? null : head ? `#${accent}` : band && (ri - header) % 2 === 0 ? `#${accent}33` : `#${accent}1a`;
      if (typeof fill === 'string') { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
      for (const [k, x1, y1, x2, y2] of [['lnT', x, y, x + w, y], ['lnB', x, y + h, x + w, y + h], ['lnL', x, y, x, y + h], ['lnR', x + w, y, x + w, y + h]]) {
        const ln = xkid(tcPr, k), color = ln ? (xkid(ln, 'solidFill') ? pptColor(xkid(ln, 'solidFill'), S) : null) : styled ? 'rgba(255,255,255,.9)' : null;
        if (!color) continue;
        ctx.strokeStyle = color; ctx.lineWidth = ln ? xnum(ln, 'w', 12700) / PT : 1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      const tx = xkid(tc, 'txBody');
      if (tx) pptText(ctx, tx, { x, y, w, h }, S, { chain, ins: ins(tcPr), color: head && own === undefined ? '#fff' : null, anchor: tcPr?.getAttribute('anchor') });
    }
    y += h;
  });
}
// The placeholder this one inherits from on the layout, then the master.
function pptInherit(S, ph) {
  const type = ph.getAttribute('type') || 'body', idx = ph.getAttribute('idx'), up = e => e.parentElement.parentElement.parentElement;
  const find = (part, byIdx) => {
    const all = [...(part?.root.getElementsByTagNameNS('*', 'ph') || [])];
    const norm = t => ({ ctrTitle: 'title', subTitle: 'body', obj: 'body' })[t] || t;
    const hit = (byIdx && idx != null && all.find(p => p.getAttribute('idx') === idx)) || all.find(p => (p.getAttribute('type') || 'body') === type) || all.find(p => norm(p.getAttribute('type') || 'body') === norm(type));
    return hit && up(hit);
  };
  return [find(S.layout, true), find(S.master, false)].filter(Boolean);
}
async function pptShape(ctx, el, part, S) {
  const ph = xdeep(el.firstElementChild, 'ph'), inh = ph ? pptInherit(S, ph) : [], spPr = xkid(el, 'spPr'), style = xkid(el, 'style');
  const xfrm = el.localName === 'graphicFrame' ? xkid(el, 'xfrm') : first([el, ...inh], s => xkid(s, 'spPr', 'xfrm'));
  if (!xfrm) return;
  const off = xkid(xfrm, 'off'), ext = xkid(xfrm, 'ext'), b = { x: xnum(off, 'x') / PT, y: xnum(off, 'y') / PT, w: xnum(ext, 'cx') / PT, h: xnum(ext, 'cy') / PT };
  ctx.save();
  const rot = xnum(xfrm, 'rot') / 60000, fh = xfrm.getAttribute('flipH') === '1', fv = xfrm.getAttribute('flipV') === '1';
  if (rot || fh || fv) { ctx.translate(b.x + b.w / 2, b.y + b.h / 2); ctx.rotate(rot * Math.PI / 180); ctx.scale(fh ? -1 : 1, fv ? -1 : 1); ctx.translate(-b.x - b.w / 2, -b.y - b.h / 2); }
  if (el.localName === 'pic') await pptDrawImage(ctx, S, part, { blip: xdeep(el, 'blip')?.getAttribute('r:embed'), src: xdeep(xkid(el, 'blipFill'), 'srcRect') }, b);
  else if (el.localName === 'graphicFrame') { const tbl = xdeep(el, 'tbl'); if (tbl) pptTable(ctx, tbl, b, S); }
  else {
    const closed = pptPath(ctx, spPr, b), fill = closed && pptFill(spPr, S, xkid(style, 'fillRef'));
    if (typeof fill === 'string') { ctx.fillStyle = fill; ctx.fill(); }
    else if (fill?.blip) { ctx.save(); ctx.clip(); await pptDrawImage(ctx, S, part, fill, b); ctx.restore(); pptPath(ctx, spPr, b); }
    const ln = xkid(spPr, 'ln'), lnRef = xkid(style, 'lnRef');
    const stroke = ln && xkid(ln, 'noFill') ? null : (ln && xkid(ln, 'solidFill') ? pptColor(xkid(ln, 'solidFill'), S) : xnum(lnRef, 'idx') ? pptColor(lnRef, S) : null);
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = xnum(ln, 'w', 9525) / PT; ctx.stroke(); }
    const tx = xkid(el, 'txBody'), type = ph?.getAttribute('type') || '', title = /title/i.test(type) && type !== 'subTitle';
    if (tx) pptText(ctx, tx, b, S, {
      title, color: pptColor(xkid(style, 'fontRef'), S), bodies: inh.map(s => xkid(s, 'txBody', 'bodyPr')),
      chain: lvl => { const k = `lvl${lvl + 1}pPr`; return [...[el, ...inh].map(s => xkid(s, 'txBody', 'lstStyle', k)), ph ? xkid(S.master.root, 'txStyles', title ? 'titleStyle' : type && type !== 'body' && type !== 'obj' && type !== 'subTitle' ? 'otherStyle' : 'bodyStyle', k) : xkid(S.pres.root, 'defaultTextStyle', k)]; },
    });
  }
  ctx.restore();
}
async function pptTree(ctx, tree, part, S, template) {
  for (const el of xkids(tree)) {
    const n = el.localName;
    if (n === 'grpSp') {
      const x = xkid(el, 'grpSpPr', 'xfrm'), [o, e, co, ce] = ['off', 'ext', 'chOff', 'chExt'].map(k => xkid(x, k));
      ctx.save();
      if (x) { ctx.translate(xnum(o, 'x') / PT, xnum(o, 'y') / PT); ctx.scale(xnum(e, 'cx', 1) / (xnum(ce, 'cx') || xnum(e, 'cx', 1)), xnum(e, 'cy', 1) / (xnum(ce, 'cy') || xnum(e, 'cy', 1))); ctx.translate(-xnum(co, 'x') / PT, -xnum(co, 'y') / PT); }
      await pptTree(ctx, el, part, S, template);
      ctx.restore();
    } else if (['sp', 'pic', 'cxnSp', 'graphicFrame'].includes(n)) {
      if (template && xdeep(el.firstElementChild, 'ph')) continue; // a layout's empty placeholders are prompts, not content
      try { await pptShape(ctx, el, part, S); } catch (e) { console.warn('Skipped a shape it could not draw', e); }
    }
  }
}
// Calls onSlide(canvas, widthPt, heightPt, n, total) for each slide that's shown; returns how many there were.
async function pptxSlides(file, onSlide) {
  await need('jszip');
  const zip = await JSZip.loadAsync(await file.arrayBuffer()).catch(() => { throw new UserError(`${file.name} isn't a PowerPoint file Nebula can read. Save it as .pptx and try again.`); });
  const cache = {}, parse = async f => new DOMParser().parseFromString(await f.async('text'), 'application/xml');
  const part = p => p ? cache[p] ??= (async () => {
    const f = zip.file(p);
    if (!f) return null;
    const doc = await parse(f), rf = zip.file(p.replace(/([^/]+)$/, '_rels/$1.rels')), rels = {};
    if (rf) for (const r of (await parse(rf)).documentElement.children) if (r.getAttribute('TargetMode') !== 'External') rels[r.getAttribute('Id')] = zipPath(p.replace(/[^/]+$/, ''), r.getAttribute('Target'));
    return { root: doc.documentElement, rels, rel: re => Object.values(rels).find(t => re.test(t)) };
  })() : Promise.resolve(null);
  const pres = await part('ppt/presentation.xml');
  if (!pres) throw new UserError(`${file.name} isn't a PowerPoint presentation.`);
  const sz = xdeep(pres.root, 'sldSz'), W = xnum(sz, 'cx', 9144000) / PT, H = xnum(sz, 'cy', 6858000) / PT;
  const paths = xkids(xdeep(pres.root, 'sldIdLst'), 'sldId').map(s => pres.rels[s.getAttribute('r:id')]).filter(Boolean);
  const K = Math.min(2, 4000 / Math.max(W, H)), imgs = {};
  let shown = 0;
  for (const [i, p] of paths.entries()) {
    const slide = await part(p);
    if (!slide || slide.root.getAttribute('show') === '0') continue; // hidden slides stay out, as in PowerPoint's own export
    const layout = await part(slide.rel(/slideLayouts\//)), master = await part(layout?.rel(/slideMasters\//)), theme = await part(master?.rel(/theme\//));
    const clrMap = xkid(master?.root, 'clrMap'), scheme = xdeep(theme?.root, 'clrScheme'), fontScheme = xdeep(theme?.root, 'fontScheme');
    const S = { zip, imgs, pres, layout, master, num: i + 1,
      fonts: { major: xkid(fontScheme, 'majorFont', 'latin')?.getAttribute('typeface') || 'Calibri Light', minor: xkid(fontScheme, 'minorFont', 'latin')?.getAttribute('typeface') || 'Calibri' },
      scheme: name => { const k = clrMap?.getAttribute(name) || name, e = xkid(scheme, k); return xkid(e, 'srgbClr')?.getAttribute('val') || xkid(e, 'sysClr')?.getAttribute('lastClr') || (/^(lt|bg)/.test(k) ? 'FFFFFF' : '000000'); } };
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(W * K), height: Math.round(H * K) }), ctx = c.getContext('2d');
    ctx.scale(K, K);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (const pt of [slide, layout, master]) {
      const bg = xkid(pt?.root, 'cSld', 'bg');
      if (!bg) continue;
      const fill = xkid(bg, 'bgPr') ? pptFill(xkid(bg, 'bgPr'), S) : pptFill(null, S, xkid(bg, 'bgRef'));
      if (typeof fill === 'string') { ctx.fillStyle = fill; ctx.fillRect(0, 0, W, H); }
      else if (fill?.blip) await pptDrawImage(ctx, S, pt, fill, { x: 0, y: 0, w: W, h: H });
      break;
    }
    if (slide.root.getAttribute('showMasterSp') !== '0') {
      if (master && layout?.root.getAttribute('showMasterSp') !== '0') await pptTree(ctx, xkid(master.root, 'cSld', 'spTree'), master, S, true);
      if (layout) await pptTree(ctx, xkid(layout.root, 'cSld', 'spTree'), layout, S, true);
    }
    await pptTree(ctx, xkid(slide.root, 'cSld', 'spTree'), slide, S, false);
    await onSlide(c, W, H, ++shown, paths.length);
  }
  return shown;
}
TOOLS.ppt2pdf = {
  group: 'to', name: 'PowerPoint to PDF', icon: 'presentation', keys: 'pptx slides presentation deck powerpoint keynote',
  desc: 'Turn .pptx slides into PDF pages, with their text, shapes, pictures and tables. Charts and animations are left out.',
  accept: '.pptx', drop: 'Drop PowerPoint files here', note: '.pptx files (PowerPoint 2007 or newer). Add several to convert them all.', batch: true,
  btn: 'Convert to PDF', libs: ['jszip', 'pdflib'],
  async run([f]) {
    const out = await PDFLib.PDFDocument.create();
    const n = await pptxSlides(f, async (c, W, H, i, total) => {
      progress(`Slide ${i} of ${total}`, i / total);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92));
      await addImagePage(out, { bytes: await blob.arrayBuffer(), w: W, h: H });
    });
    if (!n) throw new UserError('This presentation has no slides to show.');
    save(await out.save(), `${stem(f)}.pdf`);
    return `Converted ${plural(n, 'slide')}`;
  },
};
SUGGEST.pptx = ['ppt2pdf'];

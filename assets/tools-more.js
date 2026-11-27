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

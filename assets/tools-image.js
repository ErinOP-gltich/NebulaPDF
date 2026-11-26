/* Nebula: PDF metadata tools and the image tools. Loaded after engine.js; adds to its TOOLS and GROUPS.
   Everything here runs on the device. The two machine-learning tools (background removal, upscaling) download an
   open-source model the first time and keep it in the browser's cache. */

GROUPS.push(['image', 'Image tools']);

/* ---------- image helpers ---------- */
const IMG = 'image/*,.heic,.heif';
const isHeic = f => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type);
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const FORMATS = [['same', 'Same as the original'], ['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']];

// Any image the browser (or, for HEIC, the converter) can read, as an ImageBitmap.
async function decodeImage(f) {
  try { return await createImageBitmap(f); } catch { /* not natively readable: try the HEIC converter */ }
  if (isHeic(f)) {
    await need('heic2any');
    try {
      const out = await heic2any({ blob: f, toType: 'image/png' });
      return await createImageBitmap(Array.isArray(out) ? out[0] : out);
    } catch { throw new UserError(`${f.name} couldn't be read. It may be damaged, or use a HEIC feature the converter doesn't support.`); }
  }
  throw new UserError(`${f.name} isn't an image this browser can open.`);
}
function canvasOf(src, w = src.width, h = src.height, bg = null) {
  const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// Shrinking by more than half in one step looks soft and aliased: halve repeatedly, then do the last step.
function resample(src, w, h) {
  let cur = src;
  while (cur.width / 2 >= w * 1.0001 && cur.height / 2 >= h * 1.0001) cur = canvasOf(cur, cur.width / 2, cur.height / 2);
  return canvasOf(cur, w, h);
}
const outType = (f, choice) => choice && choice !== 'same' ? `image/${choice}` : (IMG_EXT[f.type] ? f.type : 'image/jpeg');
// JPG has no transparency: paint a background first, or transparent areas turn black.
const flatten = (c, type, bg = '#ffffff') => type === 'image/jpeg' ? canvasOf(c, c.width, c.height, bg) : c;
async function encodeImage(c, type, q = .9) {
  const blob = await new Promise(r => flatten(c, type).toBlob(r, type, q));
  if (!blob) throw new UserError('This image is too large for the browser to save. Try a smaller size.');
  return blob; // a browser that can't write the format falls back to PNG; blob.type says which
}
const saveImage = (blob, f, suffix) => save(blob, `${stem(f)}${suffix}.${IMG_EXT[blob.type] || 'png'}`);
const qualityField = (id = 'o-q', value = 85) => `<label class="field"><span class="field-label">Quality <b class="mono" id="${id}-v">${value}</b></span><input id="${id}" type="range" min="10" max="100" value="${value}" oninput="$('${id}-v').textContent = this.value"></label>`;
const pct = (a, b) => `${Math.round(100 - b / a * 100)}%`;

// Before/after comparison: drag the handle to wipe between the two.
function compareView(before, after) {
  const box = document.createElement('div');
  box.className = 'compare';
  box.innerHTML = `<div class="compare-frame"><div class="compare-before"></div><div class="compare-after"></div><div class="compare-handle"><span></span></div></div>
    <div class="row compare-legend"><span class="label">Before</span><span class="label">After</span></div>`;
  const frameEl = box.firstElementChild, b = canvasOf(before), a = canvasOf(after);
  frameEl.style.aspectRatio = `${after.width} / ${after.height}`;
  box.querySelector('.compare-before').append(b);
  box.querySelector('.compare-after').append(a);
  const set = x => { frameEl.style.setProperty('--cut', `${Math.min(100, Math.max(0, x))}%`); };
  set(50);
  frameEl.onpointerdown = e => {
    try { frameEl.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const move = ev => { const r = frameEl.getBoundingClientRect(); set((ev.clientX - r.left) / r.width * 100); };
    move(e);
    frameEl.onpointermove = move;
    frameEl.onpointerup = () => { frameEl.onpointermove = null; };
  };
  frameEl.dataset.cursor = 'cross';
  return box;
}

/* ---------- on-device machine learning (transformers.js, Apache-2.0) ---------- */
let TJS = null;
const transformers = () => TJS ??= import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm')
  .then(T => { T.env.allowLocalModels = false; return T; })
  .catch(() => { TJS = null; throw new UserError('The image AI library failed to load. Check your connection and try again.'); });
let gpuOk;
const hasWebGPU = async () => gpuOk ??= !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
// One progress line for a model that downloads as several files.
function downloadProgress(label) {
  const files = {};
  return p => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      progress(`${label} ${Math.round(l / t * 100)}% (${kb(t)}, first time only)`, l / t);
    }
  };
}

/* ---------- background removal: ormbg (Apache-2.0, an ISNet trained for this) ----------
   (BiRefNet needs 11 storage buffers per shader, more than Apple GPUs allow, and runs out of memory on the CPU.) */
let rmbg = null;
async function removeBackground(canvas) {
  const T = await transformers(), gpu = await hasWebGPU();
  rmbg ??= (async () => {
    const id = 'onnx-community/ormbg-ONNX';
    const model = await T.AutoModel.from_pretrained(id, { dtype: gpu ? 'fp16' : 'q8', device: gpu ? 'webgpu' : 'wasm', progress_callback: downloadProgress('Downloading the model') });
    const processor = await T.AutoProcessor.from_pretrained(id);
    return { model, processor };
  })().catch(e => { rmbg = null; throw e; });
  const { model, processor } = await rmbg;
  progress('Finding the subject');
  const { alphas } = await model(await processor(T.RawImage.fromCanvas(canvas)));
  const mask = await T.RawImage.fromTensor(alphas[0].mul(255).to('uint8')).resize(canvas.width, canvas.height);
  const out = canvasOf(canvas), ctx = out.getContext('2d'), px = ctx.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < mask.data.length; i++) px.data[i * 4 + 3] = mask.data[i];
  ctx.putImageData(px, 0, 0);
  return out;
}

/* ---------- upscaling: Swin2SR real-world 4× (Apache-2.0), done in tiles so big images don't run out of memory ----------
   (The older Xenova/swin2SR-classical exports fail in current onnxruntime with "Shape mismatch attempting to re-use buffer".) */
let upscaler = null;
async function upscale4(src, done, share) {
  const T = await transformers(), gpu = await hasWebGPU(), scale = 4;
  upscaler ??= T.pipeline('image-to-image', 'onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX',
    { dtype: gpu ? 'fp32' : 'q8', device: gpu ? 'webgpu' : 'wasm', progress_callback: downloadProgress('Downloading the model') }) // its fp16 files return wrong colours
    .catch(e => { upscaler = null; throw e; });
  const run = await upscaler;
  const TILE = 128, PAD = 8, W = src.width, H = src.height;
  const out = Object.assign(document.createElement('canvas'), { width: W * scale, height: H * scale }), octx = out.getContext('2d');
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    // each tile is read with a margin so the seams match, then only its core is kept
    const x0 = tx * TILE, y0 = ty * TILE, w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0);
    const ax = Math.max(0, x0 - PAD), ay = Math.max(0, y0 - PAD), aw = Math.min(W, x0 + w + PAD) - ax, ah = Math.min(H, y0 + h + PAD) - ay;
    const piece = Object.assign(document.createElement('canvas'), { width: aw, height: ah });
    piece.getContext('2d').drawImage(src, ax, ay, aw, ah, 0, 0, aw, ah);
    const res = await run(T.RawImage.fromCanvas(piece));
    const img = (Array.isArray(res) ? res[0] : res).toCanvas();
    octx.drawImage(img, (x0 - ax) * scale, (y0 - ay) * scale, w * scale, h * scale, x0 * scale, y0 * scale, w * scale, h * scale);
    done.n++;
    progress(`Upscaling ${Math.round(done.n / share * 100)}%`, done.n / share);
  }
  return out;
}

/* ---------- enhancement: classic image processing, no model ---------- */
// Box blur of radius r on one channel array (two passes of a running sum).
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0; const o = y * w;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / n; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
// Per-channel low/high points (0.5% / 99.5%) for an automatic levels and colour-balance fix.
function autoLevels(d) {
  const hist = [0, 1, 2].map(() => new Uint32Array(256)), n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; }
  return hist.map(hs => {
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hs[lo]) < n * .005; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hs[hi]) < n * .005; hi--);
    if (hi - lo < 32) return [0, 255]; // don't stretch a nearly flat channel
    const half = Math.max(hi - lo, 255 / 1.8) / 2, mid = (lo + hi) / 2; // at most 1.8× per channel, so low-contrast photos don't turn a colour
    return [mid - half, mid + half];
  });
}
function enhance(canvas, s) {
  const c = canvasOf(canvas), ctx = c.getContext('2d'), img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, w = c.width, h = c.height, N = w * h;
  const ch = [0, 1, 2].map(k => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = d[i * 4 + k]; return a; });
  if (s.auto) {
    const lv = autoLevels(d);
    ch.forEach((a, k) => { const [lo, hi] = lv[k], f = 255 / (hi - lo); for (let i = 0; i < N; i++) a[i] = (a[i] - lo) * f; });
  }
  const r = Math.max(1, Math.round(Math.min(w, h) / 600));
  if (s.denoise > 0) { // smooth only where neighbours are similar, so edges stay crisp
    const t = 6 + s.denoise * .4, k = s.denoise / 100;
    ch.forEach((a, i) => { const b = boxBlur(a, w, h, r); for (let j = 0; j < N; j++) { const diff = Math.abs(a[j] - b[j]); if (diff < t) a[j] += (b[j] - a[j]) * k * (1 - diff / t); } ch[i] = a; });
  }
  if (s.sharpen > 0) { // unsharp mask
    const k = s.sharpen / 50;
    ch.forEach(a => { const b = boxBlur(a, w, h, r); for (let j = 0; j < N; j++) a[j] += (a[j] - b[j]) * k; });
  }
  const bright = s.brightness * 1.6, con = (100 + s.contrast) / 100, sat = (100 + s.saturation) / 100, warm = s.warmth * .8;
  for (let i = 0; i < N; i++) {
    let R = ch[0][i] + warm, G = ch[1][i], B = ch[2][i] - warm;
    const L = .2126 * R + .7152 * G + .0722 * B;
    R = L + (R - L) * sat; G = L + (G - L) * sat; B = L + (B - L) * sat;
    d[i * 4] = (R - 128) * con + 128 + bright;
    d[i * 4 + 1] = (G - 128) * con + 128 + bright;
    d[i * 4 + 2] = (B - 128) * con + 128 + bright;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
const ENHANCE_SLIDERS = [['brightness', 'Brightness', -50, 50], ['contrast', 'Contrast', -50, 50], ['saturation', 'Colour', -100, 100], ['warmth', 'Warmth', -50, 50], ['sharpen', 'Sharpen', 0, 100], ['denoise', 'Reduce noise', 0, 100]];
const enhanceSettings = () => Object.fromEntries([['auto', $('o-auto').checked], ...ENHANCE_SLIDERS.map(([k]) => [k, +val(`o-${k}`)])]);

/* ---------- interactive crop box on an image ---------- */
const imgCrop = { bmp: null, box: null, ratio: 0 };
function drawCropBox() {
  const { bmp, box } = imgCrop, el = $('o-cropbox');
  if (!bmp || !el) return;
  Object.assign(el.style, { left: `${box.x / bmp.width * 100}%`, top: `${box.y / bmp.height * 100}%`, width: `${box.w / bmp.width * 100}%`, height: `${box.h / bmp.height * 100}%` });
  ['x', 'y', 'w', 'h'].forEach(k => { const i = $(`o-c${k}`); if (document.activeElement !== i) i.value = Math.round(box[k]); });
}
function cropFromInputs() {
  const { bmp } = imgCrop, v = k => Math.max(0, parseInt(val(`o-c${k}`)) || 0);
  let x = Math.min(v('x'), bmp.width - 1), y = Math.min(v('y'), bmp.height - 1), w = Math.max(1, v('w')), h = Math.max(1, v('h'));
  imgCrop.box = { x, y, w: Math.min(w, bmp.width - x), h: Math.min(h, bmp.height - y) };
  drawCropBox();
}
function setCropRatio(r) {
  imgCrop.ratio = r;
  const { bmp } = imgCrop;
  if (!r) return;
  let w = bmp.width, h = w / r;
  if (h > bmp.height) { h = bmp.height; w = h * r; }
  imgCrop.box = { x: (bmp.width - w) / 2, y: (bmp.height - h) / 2, w, h };
  drawCropBox();
}

/* ---------- the tools ---------- */
Object.assign(TOOLS, {
  pdfmeta: {
    group: 'security', name: 'View PDF metadata', icon: 'info', keys: 'metadata properties info author title producer creator dates version details inspect',
    desc: 'See the title, author, dates, page count, PDF version, page sizes and more hidden in a PDF.',
    accept: PDF, btn: 'Download as JSON', libs: ['pdflib'],
    options: () => `<dl class="meta-table" id="o-meta"><div><dt>Reading…</dt><dd></dd></div></dl>
      <div class="row"><button type="button" class="chip" onclick="navigator.clipboard.writeText(JSON.stringify(window.lastMeta, null, 2)).then(() => showToast('Copied'))">${icon('copy')}Copy as JSON</button></div>`,
    async ready([f]) {
      const m = window.lastMeta = await readMeta(f), fmt = v => v instanceof Date ? v.toLocaleString() : Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v === false ? 'No' : v ?? '—';
      $('o-meta').innerHTML = Object.entries(m).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(fmt(v))}</dd></div>`).join('');
    },
    async run([f]) {
      const m = window.lastMeta || await readMeta(f);
      save(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), `${stem(f)}-metadata.json`);
      return 'Metadata saved';
    },
  },
  pdfclean: {
    group: 'security', name: 'Remove PDF metadata', icon: 'broom', keys: 'metadata strip clean privacy author remove anonymize scrub xmp',
    desc: 'Make a privacy-clean copy: removes the title, author, software, dates and hidden XMP data.',
    accept: PDF, btn: 'Remove metadata', libs: ['pdflib'], batch: true,
    options: () => hint('Removes the document info (title, author, subject, keywords, creator, producer, dates), XMP metadata streams and editing-app leftovers. The pages themselves are unchanged.'),
    async run([f]) {
      const before = await readMeta(f);
      const doc = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { updateMetadata: false }).catch(e => {
        throw new UserError(/encrypt/i.test(e.message) ? `${f.name} is password-protected. Remove the password with Unlock PDF first.` : `${f.name} couldn't be read.`);
      });
      const { PDFName, PDFDict, PDFRawStream } = PDFLib, ctx = doc.context, META = PDFName.of('Metadata'), PIECE = PDFName.of('PieceInfo');
      let removed = 0;
      const info = ctx.lookup(ctx.trailerInfo.Info);
      if (info instanceof PDFDict) { removed += info.keys().length; for (const k of info.keys()) info.delete(k); }
      delete ctx.trailerInfo.Info;
      for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
        const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : null;
        if (!dict) continue;
        if (dict.get(PDFName.of('Type'))?.toString() === '/Metadata') { ctx.delete(ref); removed++; continue; }
        if (dict.has(META)) { dict.delete(META); removed++; }
        if (dict.has(PIECE)) { dict.delete(PIECE); removed++; }
      }
      save(await doc.save({ updateMetadata: false }), `${stem(f)}-clean.pdf`);
      const named = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'].filter(k => before[k]);
      return removed ? `Removed ${named.length ? named.join(', ').toLowerCase() + ' and other ' : ''}metadata` : 'This PDF had no metadata; saved a clean copy';
    },
  },

  imgresize: {
    group: 'image', name: 'Resize image', icon: 'resize', keys: 'resize scale dimensions width height pixels smaller bigger',
    desc: 'Resize images to exact pixel dimensions or by percentage.',
    accept: IMG, batch: true, drop: 'Drop images here', note: 'JPG, PNG, WebP, HEIC… Add several to resize them all.', btn: 'Resize',
    options: () => `<div class="seg" role="group" id="o-unit"><button type="button" class="seg-btn" data-k="px" aria-pressed="true" onclick="segPick(this)">Pixels</button><button type="button" class="seg-btn" data-k="pct" aria-pressed="false" onclick="segPick(this)">Percent</button></div>
      <div id="o-unit-px" class="options-sub">${row(inp('o-w', 'Width (px)', 'type="number" min="1" inputmode="numeric"'), inp('o-h', 'Height (px)', 'type="number" min="1" inputmode="numeric"'))}
        ${check('o-keep', 'Keep proportions (fit inside this size)')}</div>
      <div id="o-unit-pct" class="options-sub hidden">${inp('o-pct', 'Scale (%)', 'type="number" min="1" max="1000" value="50" inputmode="numeric"')}</div>
      ${row(sel('o-fmt', 'Save as', FORMATS), qualityField())}`,
    async ready([f]) {
      const b = await decodeImage(f), ratio = b.width / b.height;
      $('o-w').value = b.width; $('o-h').value = b.height;
      $('o-w').oninput = () => { if ($('o-keep').checked && +val('o-w')) $('o-h').value = Math.round(val('o-w') / ratio); };
      $('o-h').oninput = () => { if ($('o-keep').checked && +val('o-h')) $('o-w').value = Math.round(val('o-h') * ratio); };
    },
    async run([f]) {
      const b = await decodeImage(f);
      let w, h;
      if (segValue('o-unit') === 'pct') { const k = (parseFloat(val('o-pct')) || 100) / 100; w = b.width * k; h = b.height * k; }
      else {
        const W = parseInt(val('o-w')) || 0, H = parseInt(val('o-h')) || 0;
        if (!W && !H) throw new UserError('Enter a width or a height.');
        if ($('o-keep').checked) { const k = Math.min(W ? W / b.width : Infinity, H ? H / b.height : Infinity); w = b.width * k; h = b.height * k; }
        else { w = W || b.width; h = H || b.height; }
      }
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      if (w * h > 100e6) throw new UserError('That size is too large for the browser (over 100 megapixels).');
      const blob = await encodeImage(resample(b, w, h), outType(f, val('o-fmt')), val('o-q') / 100);
      saveImage(blob, f, `-${w}x${h}`);
      return `Resized to ${w} × ${h}`;
    },
  },
  imgcrop: {
    group: 'image', name: 'Crop image', icon: 'crop-img', keys: 'crop trim cut aspect ratio square',
    desc: 'Crop an image by dragging a box, or by exact position and size.', wide: true,
    accept: IMG, drop: 'Drop an image here', note: 'JPG, PNG, WebP, HEIC…', btn: 'Crop image',
    options: () => `${row(sel('o-ratio', 'Shape', [['0', 'Free'], ['1', 'Square 1:1'], ['1.3333', '4:3'], ['1.5', '3:2'], ['1.7778', '16:9'], ['0.75', '3:4'], ['0.5625', '9:16']]), sel('o-fmt', 'Save as', FORMATS))}
      <div class="img-stage" id="o-istage" data-cursor="cross"><div class="crop-box" id="o-cropbox"></div></div>
      ${row(inp('o-cx', 'X', 'type="number" min="0" inputmode="numeric"'), inp('o-cy', 'Y', 'type="number" min="0" inputmode="numeric"'), inp('o-cw', 'Width', 'type="number" min="1" inputmode="numeric"'), inp('o-ch', 'Height', 'type="number" min="1" inputmode="numeric"'))}
      ${hint('Drag across the image to draw the area to keep, or type exact numbers (in pixels).')}`,
    async ready([f]) {
      const bmp = imgCrop.bmp = await decodeImage(f), st = $('o-istage');
      imgCrop.box = { x: 0, y: 0, w: bmp.width, h: bmp.height };
      st.prepend(canvasOf(bmp, Math.min(bmp.width, 1600), Math.min(bmp.width, 1600) * bmp.height / bmp.width));
      st.style.aspectRatio = `${bmp.width} / ${bmp.height}`;
      st.style.setProperty('--ar', bmp.width / bmp.height); // tall photos stay within the screen
      ['x', 'y', 'w', 'h'].forEach(k => { $(`o-c${k}`).oninput = cropFromInputs; });
      $('o-ratio').onchange = () => setCropRatio(+val('o-ratio'));
      drawCropBox();
      st.onpointerdown = e => {
        const r = st.getBoundingClientRect(), at = ev => [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * bmp.width, Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) * bmp.height];
        const [ax, ay] = at(e);
        try { st.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
        st.onpointermove = ev => {
          let [bx, by] = at(ev), w = Math.abs(bx - ax), h = Math.abs(by - ay);
          if (imgCrop.ratio) { h = w / imgCrop.ratio; if (ay + (by < ay ? -h : h) < 0 || ay + (by < ay ? -h : h) > bmp.height) { h = by < ay ? ay : bmp.height - ay; w = h * imgCrop.ratio; } }
          const x = bx < ax ? ax - w : ax, y = by < ay ? ay - h : ay;
          imgCrop.box = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, bmp.width - Math.max(0, x)), h: Math.min(h, bmp.height - Math.max(0, y)) };
          drawCropBox();
        };
        st.onpointerup = () => { st.onpointermove = null; if (imgCrop.box.w < 2 || imgCrop.box.h < 2) { imgCrop.box = { x: 0, y: 0, w: bmp.width, h: bmp.height }; drawCropBox(); } };
      };
    },
    async run([f]) {
      const { bmp, box } = imgCrop;
      if (!bmp) throw new UserError('The image is still loading. Try again in a moment.');
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(box.w), height: Math.round(box.h) });
      c.getContext('2d').drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
      saveImage(await encodeImage(c, outType(f, val('o-fmt')), .92), f, '-cropped');
      return `Cropped to ${c.width} × ${c.height}`;
    },
  },
  imgcompress: {
    group: 'image', name: 'Compress image', icon: 'compress-img', keys: 'compress reduce shrink file size smaller optimize jpg webp',
    desc: 'Make images smaller for the web, email and uploads, with a quality slider.',
    accept: IMG, batch: true, drop: 'Drop images here', note: 'Add several to compress them all.', btn: 'Compress',
    options: () => row(sel('o-fmt', 'Save as', [['webp', 'WebP (smallest)'], ['jpeg', 'JPG'], ['same', 'Same as the original']]),
      sel('o-max', 'Largest side', [['0', 'Keep the size'], ['3840', '3840 px (4K)'], ['2560', '2560 px'], ['1920', '1920 px'], ['1280', '1280 px'], ['800', '800 px']])) + qualityField('o-q', 72) +
      hint('Lower quality means a smaller file. Around 70 is usually hard to tell from the original.'),
    async run([f]) {
      const b = await decodeImage(f), max = +val('o-max'), k = max ? Math.min(1, max / Math.max(b.width, b.height)) : 1;
      const blob = await encodeImage(resample(b, Math.round(b.width * k), Math.round(b.height * k)), outType(f, val('o-fmt')), val('o-q') / 100);
      if (blob.size >= f.size && k === 1 && blob.type === f.type) throw new UserError(`${f.name} is already compact: compressing it would make it bigger. Try a lower quality or WebP.`);
      saveImage(blob, f, '-compressed');
      return `${kb(f.size)} → ${kb(blob.size)}${blob.size < f.size ? `, ${pct(f.size, blob.size)} smaller` : ''}`;
    },
  },
  imgconvert: {
    group: 'image', name: 'Convert image', icon: 'convert', keys: 'convert change format png jpg jpeg webp gif bmp',
    desc: 'Convert images between JPG, PNG and WebP.',
    accept: IMG, batch: true, drop: 'Drop images here', note: 'Add several to convert them all.', btn: 'Convert',
    options: () => row(sel('o-fmt', 'Convert to', [['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']]), qualityField('o-q', 90)) +
      `<label class="field"><span class="field-label">Background for transparent areas (JPG only)</span><input id="o-bg" type="color" value="#ffffff" class="input color-pick"></label>`,
    async run([f]) {
      const type = `image/${val('o-fmt')}`, c = canvasOf(await decodeImage(f));
      const blob = await new Promise(r => (type === 'image/jpeg' ? canvasOf(c, c.width, c.height, val('o-bg')) : c).toBlob(r, type, val('o-q') / 100));
      saveImage(blob, f, '');
      return `Converted to ${(IMG_EXT[blob.type] || 'png').toUpperCase()}`;
    },
  },
  heic2jpg: {
    group: 'image', name: 'HEIC to JPG', icon: 'camera', keys: 'heic heif iphone photo convert jpg jpeg apple',
    desc: 'Turn iPhone HEIC photos into JPG images that open everywhere.',
    accept: '.heic,.heif,image/heic,image/heif', batch: true, drop: 'Drop HEIC photos here', note: '.heic or .heif files. Add several to convert them all.', btn: 'Convert to JPG',
    options: () => row(sel('o-fmt', 'Convert to', [['jpeg', 'JPG'], ['png', 'PNG']]), qualityField('o-q', 90)),
    async run([f]) {
      progress(`Reading ${f.name}`);
      const blob = await encodeImage(canvasOf(await decodeImage(f)), `image/${val('o-fmt')}`, val('o-q') / 100);
      saveImage(blob, f, '');
      return 'Converted';
    },
  },
  removebg: {
    group: 'image', also: ['ai'], name: 'Remove background', icon: 'cutout', keys: 'remove background cutout transparent png ai erase backdrop subject product',
    desc: 'Cut out the subject of a photo and get a transparent PNG. Runs on your device with an AI model.',
    accept: IMG, drop: 'Drop a photo here', note: 'JPG, PNG, WebP, HEIC…', btn: 'Remove background', ai: 'device',
    options: () => row(sel('o-bgmode', 'New background', [['none', 'Transparent'], ['#ffffff', 'White'], ['#000000', 'Black'], ['custom', 'A colour…']]),
      `<label class="field hidden" id="o-bgc-box"><span class="field-label">Colour</span><input id="o-bgc" type="color" value="#2fe0d0" class="input color-pick"></label>`) +
      `<div id="o-out"></div>` + hint('The first time, this downloads an open-source AI model (ormbg: 88 MB with a GPU, 44 MB without) and keeps it in your browser. Your photo never leaves your device.'),
    afterOptions() { $('o-bgmode').onchange = () => $('o-bgc-box').classList.toggle('hidden', val('o-bgmode') !== 'custom'); },
    async run([f]) {
      const src = await decodeImage(f), k = Math.min(1, 4096 / Math.max(src.width, src.height)), c = resample(src, Math.round(src.width * k), Math.round(src.height * k));
      let out = await removeBackground(c);
      const mode = val('o-bgmode'), bg = mode === 'custom' ? val('o-bgc') : mode;
      if (bg !== 'none') out = canvasOf(out, out.width, out.height, bg);
      $('o-out').replaceChildren(compareView(c, out));
      saveImage(await encodeImage(out, 'image/png'), f, '-cutout');
      return 'Background removed';
    },
  },
  upscale: {
    group: 'ai', also: ['image'], name: 'AI image upscaler', icon: 'upscale', keys: 'upscale enlarge super resolution enhance bigger sharper 2x 4x 8x ai',
    desc: 'Enlarge images 2×, 4× or 8× with an AI model that adds real detail instead of blur. Runs on your device.',
    accept: IMG, drop: 'Drop an image here', note: 'Works best on small images, up to about 1000 px.', btn: 'Upscale', ai: 'device',
    options: () => row(sel('o-scale', 'Enlarge', [['2', '2×'], ['4', '4×'], ['8', '8× (4× AI, then smooth 2×)']]), sel('o-fmt', 'Save as', [['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']])) +
      `<div id="o-out"></div>` + hint('Uses Swin2SR, an open-source super-resolution model trained on real photos (54 MB with a GPU, 19 MB without, downloaded once). It works through the picture in small tiles: a few seconds per tile with a GPU (WebGPU), much longer without one.'),
    async run([f]) {
      const b = await decodeImage(f), scale = +val('o-scale'), gpu = await hasWebGPU();
      // keep the result under about 36 megapixels, and the work reasonable (the CPU is around 8× slower than a GPU)
      const maxIn = Math.min(Math.floor(Math.sqrt(36e6 / (scale * scale))), gpu ? 1200 : 400);
      const k = Math.min(1, maxIn / Math.max(b.width, b.height)), src = resample(b, Math.round(b.width * k), Math.round(b.height * k));
      if (k < 1) showToast(`Large image: working from a ${src.width} × ${src.height} copy${gpu ? '' : ' (this browser has no WebGPU, so the AI runs on the slower CPU)'}.`);
      const done = { n: 0 }, x4 = await upscale4(src, done, Math.ceil(src.width / 128) * Math.ceil(src.height / 128));
      // one AI pass at 4×; 2× is that result scaled down (sharper than a 2× model), 8× is it scaled up smoothly
      const cur = scale === 4 ? x4 : scale === 2 ? resample(x4, src.width * 2, src.height * 2) : canvasOf(x4, src.width * 8, src.height * 8);
      const preview = resample(src, Math.min(cur.width, 1600), Math.min(cur.width, 1600) * src.height / src.width);
      $('o-out').replaceChildren(compareView(preview, resample(cur, preview.width, preview.height)));
      saveImage(await encodeImage(cur, `image/${val('o-fmt')}`, .92), f, `-${scale}x`);
      return `Upscaled to ${cur.width} × ${cur.height}`;
    },
  },
  enhance: {
    group: 'image', also: ['ai'], name: 'Image enhancer', icon: 'enhance', keys: 'enhance improve fix photo brightness contrast sharpen denoise noise colour color auto correct old ai',
    desc: 'Fix dull, dark or noisy photos: automatic levels and colour, then brightness, contrast, colour, warmth, sharpening and noise reduction.', wide: true,
    accept: IMG, drop: 'Drop a photo here', note: 'JPG, PNG, WebP, HEIC…', btn: 'Save image', ai: 'device',
    options: () => `${check('o-auto', 'Automatic levels and colour balance')}
      <div class="sliders">${ENHANCE_SLIDERS.map(([k, label, min, max]) => `<label class="field"><span class="field-label">${label} <b class="mono" id="o-${k}-v">0</b></span><input id="o-${k}" type="range" min="${min}" max="${max}" value="0"></label>`).join('')}</div>
      <div class="row"><button type="button" class="chip" id="o-reset">${icon('rotate-cw')}Reset</button></div>
      <div id="o-out"></div>${hint('Classic image processing, applied on your device. It makes photos clearer and better balanced; it does not redraw faces or invent detail.')}`,
    async ready([f]) {
      const b = await decodeImage(f), small = resample(b, Math.min(b.width, 900), Math.min(b.width, 900) * b.height / b.width);
      let queued = false;
      const redraw = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          ENHANCE_SLIDERS.forEach(([k]) => { $(`o-${k}-v`).textContent = val(`o-${k}`); });
          $('o-out').replaceChildren(compareView(small, enhance(small, enhanceSettings())));
        });
      };
      $('tool-options').querySelector('.sliders').oninput = redraw;
      $('o-auto').onchange = redraw;
      $('o-reset').onclick = () => { ENHANCE_SLIDERS.forEach(([k]) => { $(`o-${k}`).value = 0; }); $('o-auto').checked = true; redraw(); };
      redraw();
    },
    async run([f]) {
      progress('Enhancing');
      const out = enhance(canvasOf(await decodeImage(f)), enhanceSettings());
      saveImage(await encodeImage(out, outType(f, 'same'), .92), f, '-enhanced');
      return 'Enhanced image saved';
    },
  },
});
SUGGEST.image = ['removebg', 'imgcompress', 'imgresize', 'imgcrop', 'enhance', 'upscale', 'imgconvert', 'jpg2pdf', 'ocr'];
SUGGEST.pdf.push('pdfmeta', 'pdfclean');

// Everything a PDF's metadata says, as one plain object.
async function readMeta(f) {
  await need('pdflib');
  const bytes = new Uint8Array(await f.arrayBuffer()), head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => { throw new UserError(`${f.name} couldn't be read.`); });
  const { PDFName } = PDFLib, cat = doc.catalog, sizes = new Map();
  let pages = 0;
  try {
    for (const p of doc.getPages()) {
      pages++;
      const { width, height } = p.getSize(), key = `${Math.round(width)} × ${Math.round(height)} pt`;
      const name = [[595, 842, 'A4'], [612, 792, 'US Letter'], [612, 1008, 'US Legal'], [420, 595, 'A5'], [842, 1191, 'A3']].find(([w, h]) => Math.abs(Math.min(width, height) - w) < 3 && Math.abs(Math.max(width, height) - h) < 3);
      sizes.set(key + (name ? ` (${name[2]}${width > height ? ', landscape' : ''})` : ''), 1);
    }
  } catch { pages = doc.getPageCount(); }
  let fields = 0;
  try { fields = doc.getForm().getFields().length; } catch { /* no form */ }
  const get = fn => { try { return fn() ?? null; } catch { return null; } };
  return {
    File: f.name, 'File size': kb(f.size), Title: get(() => doc.getTitle()), Author: get(() => doc.getAuthor()), Subject: get(() => doc.getSubject()),
    Keywords: get(() => doc.getKeywords()), Creator: get(() => doc.getCreator()), Producer: get(() => doc.getProducer()),
    Created: get(() => doc.getCreationDate()), Modified: get(() => doc.getModificationDate()),
    'PDF version': cat.get(PDFName.of('Version'))?.toString().replace('/', '') || head.match(/%PDF-(\d\.\d)/)?.[1] || null,
    Pages: pages, 'Page sizes': [...sizes.keys()], Encrypted: doc.isEncrypted, 'Form fields': fields,
    'XMP metadata': cat.has(PDFName.of('Metadata')), Tagged: cat.has(PDFName.of('MarkInfo')),
    'Has attachments': !!get(() => cat.lookup(PDFName.of('Names'))?.has(PDFName.of('EmbeddedFiles'))),
    'Has JavaScript': !!get(() => cat.lookup(PDFName.of('Names'))?.has(PDFName.of('JavaScript'))) || cat.has(PDFName.of('OpenAction')),
  };
}

/* Nebula AI tools. Each can run two ways, chosen with the switch at the top of the tool:
   - On this device (default): an open-source language model (Qwen 3.5 2B) runs in the browser through WebLLM and
     WebGPU. Private and free; downloads about 1.1 GB once. Its context is small, so long documents are read in parts.
   - Claude (cloud): the document's text goes to /api/ai, which asks Claude. Better answers; the text leaves the device.
   OCR on the device uses Tesseract; tool suggestions on the device use word matching. Loaded after tools-image.js. */

GROUPS.push(['ai', 'AI tools']);

/* ---------- which engine ---------- */
const LOCAL_MODEL = 'Qwen3.5-2B-q4f16_1-MLC';
const LOCAL_CHARS = 11000;       // document text per on-device request (its window is 8k tokens, shared with the answer)
const CLOUD_CHARS = 290000;      // document text per Claude request (the server's cap is 300k)
const AI = { cloud: null, sent: 0 };
const store2 = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const enginePref = () => store2.get('nebula-ai') === 'cloud' ? 'cloud' : 'device';
async function cloudReady() {
  if (AI.cloud === null) {
    try { const r = await fetch('/api/ai', { cache: 'no-store' }); AI.cloud = r.ok && !!(await r.json()).ready; }
    catch { AI.cloud = false; }
  }
  return AI.cloud;
}
const ENGINE = `<div class="engine" id="o-engine-box">
  <div class="seg" role="group" aria-label="Where the AI runs" id="o-engine">
    <button type="button" class="seg-btn" data-k="device" onclick="pickEngine(this)">${icon('shield-check')}On this device</button>
    <button type="button" class="seg-btn" data-k="cloud" onclick="pickEngine(this)">${icon('ai')}Claude (cloud)<span class="soon"><span class="soon-w">Coming </span>soon</span></button>
  </div><p class="hint engine-note" id="o-engine-note"></p></div>`;
function pickEngine(btn) { store2.set('nebula-ai', btn.dataset.k); refreshEngine(); }
async function refreshEngine(onlyCloud) {
  const box = $('o-engine');
  if (!box) return;
  const t = TOOLS[currentTool], [gpu, cloud] = await Promise.all([hasWebGPU(), cloudReady()]);
  const choice = onlyCloud ? 'cloud' : cloud ? enginePref() : 'device'; // no key on the server yet: Claude shows "Coming soon"
  box.querySelectorAll('[data-k]').forEach(b => b.setAttribute('aria-pressed', b.dataset.k === choice));
  const cb = box.querySelector('[data-k=cloud]');
  cb.disabled = !cloud; cb.classList.toggle('is-soon', !cloud); cb.title = cloud ? '' : 'Claude (cloud) is coming soon';
  box.querySelector('[data-k=device]').classList.toggle('hidden', !!onlyCloud);
  const notes = {
    device: t.localNote || (gpu ? 'Private: nothing leaves your device. Runs Qwen 3.5, an open-source model, in your browser. The first time it downloads about 1.1 GB, then works offline.'
      : `This browser can’t run the on-device model yet. It needs WebGPU, which desktop Chrome, Edge and Safari 26 have.${cloud ? ' Or switch to Claude.' : ''}`),
    cloud: cloud ? `Sends ${t.cloudSends || 'the document’s text'} to Anthropic’s Claude for better, faster answers. Nebula itself doesn’t keep it.`
      : 'Claude in the cloud is coming soon. For now, this runs privately on your device.',
  };
  $('o-engine-note').textContent = notes[choice];
  $('o-engine-note').classList.toggle('warn', (choice === 'device' && !gpu && !t.localNote) || (choice === 'cloud' && !cloud));
  const note = document.querySelector('.local-note');
  if (note) note.lastChild.textContent = choice === 'cloud' ? 'Sent to Claude to process. Not stored by Nebula.' : 'Processed on this device. Nothing is uploaded.';
}
const useCloud = () => !!AI.cloud && (enginePref() === 'cloud' || !!TOOLS[currentTool]?.cloudOnly);

/* ---------- Claude, through /api/ai (server-sent events) ---------- */
async function cloud(task, body, onText) {
  if (!await cloudReady()) throw new UserError('Claude isn’t set up on this site yet. Switch to “On this device”.');
  const payload = JSON.stringify({ task, ...body });
  if (payload.length > 4_300_000) throw new UserError('This is too much to send in one request. Try a shorter document or fewer images.');
  progress('Asking Claude');
  const r = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  AI.sent += payload.length;
  window.onCloudSend?.(AI.sent);
  if (!r.ok || !r.body) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* not JSON */ }
    throw new UserError(msg || `The AI service returned an error (${r.status}).`);
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', acc = '', end = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!line.startsWith('data:')) continue;
      const ev = JSON.parse(line.slice(5));
      if (ev.error) throw new UserError(ev.error);
      if (ev.t) { acc += ev.t; onText?.(acc); }
      if (ev.done) end = ev;
    }
  }
  if (!end) throw new UserError('The connection to Claude dropped before the answer finished. Try again.');
  if (end.refusal) throw new UserError('Claude declined to work on this document.');
  if (end.stop === 'max_tokens' && body.json) throw new UserError('The answer was too long and got cut off. Try a shorter document or fewer items.');
  return acc;
}

/* ---------- the on-device model, through WebLLM (Apache-2.0) ---------- */
let llm = null;
async function localLLM() {
  if (!await hasWebGPU()) throw new UserError('This browser can’t run the on-device model (it needs WebGPU: desktop Chrome or Edge, or Safari 26). Switch to Claude, or use one of those browsers.');
  llm ??= (async () => {
    const W = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.89/+esm');
    return W.CreateMLCEngine(LOCAL_MODEL, {
      initProgressCallback: r => progress(r.progress < 1 ? `Loading the on-device model ${Math.round(r.progress * 100)}% (first time: about 1.1 GB)` : 'Model ready', r.progress),
    }, { context_window_size: 8192 });
  })().catch(e => { llm = null; throw new UserError(`The on-device model couldn’t start (${e.message || e}). Close other heavy tabs and try again, or switch to Claude.`); });
  return llm;
}
async function local(messages, { json, maxTokens = 1400, onText } = {}) {
  const eng = await localLLM();
  const req = { messages, max_tokens: maxTokens, temperature: .3, stream: true, extra_body: { enable_thinking: false } };
  if (json) req.response_format = { type: 'json_object', schema: JSON.stringify(json) };
  let acc = '';
  const clean = t => t.replace(/<think>[\s\S]*?(<\/think>\s*|$)/, ''); // Qwen still emits an empty thinking block
  for await (const ch of await eng.chat.completions.create(req)) {
    acc += ch.choices[0]?.delta?.content || '';
    onText?.(clean(acc));
  }
  return clean(acc);
}
const parseJSON = (s, who) => {
  try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); }
  catch { throw new UserError(who === 'cloud' ? 'Claude’s answer couldn’t be read. Try again.' : 'The on-device model gave an answer that couldn’t be read. Try again, or switch to Claude.'); }
};
const writing = acc => progress(`Writing… ${acc.length.toLocaleString()} characters`);

/* ---------- getting the text out of a document ---------- */
const DOC = `${PDF},.docx,.pptx,.txt,.md,text/plain`;
// The text of a PDF, Word, PowerPoint or text file, cut to `cap` characters, with a note saying what was left out.
async function docText(f, cap) {
  if (f.__text?.cap === cap) return f.__text;
  let parts = [], total = 0;
  if (isPdf(f)) {
    const view = await openView(f), n = view.numPages;
    let ocr = null;
    try {
      for (let i = 1; i <= n; i++) {
        progress(`Reading page ${i} of ${n}`, i / n);
        let pg = await analyzePage(view, i);
        if (!pg.items.length) { ocr ??= makeOcr('eng'); pg = await analyzePage(view, i, { ocr }); }
        parts.push(`--- Page ${i} ---\n${toLines(pg.items).map(l => l.segs.map(s => s.text).join('   ')).join('\n')}`);
      }
    } finally { ocr?.done(); }
    total = n;
  } else if (/\.docx$/i.test(f.name)) {
    await need('mammoth');
    parts = (await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value.split(/\n{2,}/);
  } else if (/\.pptx$/i.test(f.name)) {
    await need('jszip');
    const z = await JSZip.loadAsync(f), slides = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
    for (const [k, n] of slides.entries()) {
      const x = new DOMParser().parseFromString(await z.file(n).async('string'), 'application/xml');
      parts.push(`--- Slide ${k + 1} ---\n${[...x.getElementsByTagNameNS(NS_A, 'p')].map(p => [...p.getElementsByTagNameNS(NS_A, 't')].map(t => t.textContent).join('')).filter(Boolean).join('\n')}`);
    }
    total = slides.length;
  } else parts = (await f.text()).split(/\n{2,}/);
  let text = '', used = 0;
  for (const p of parts) {
    if (text.length + p.length + 2 > cap) break;
    text += (text ? '\n\n' : '') + p;
    used++;
  }
  if (!used && parts.length) { text = parts[0].slice(0, cap); used = 1; }
  const unit = isPdf(f) ? 'pages' : /\.pptx$/i.test(f.name) ? 'slides' : 'sections';
  const note = used < parts.length ? (total ? `Read the first ${used} of ${total} ${unit}: the rest is too long for ${cap === LOCAL_CHARS ? 'the on-device model at once' : 'one request'}.` : `Read the first ${Math.round(text.length / 1000)}k characters: the rest is too long for one request.`) : '';
  if (!text.trim()) throw new UserError('This document has no text to work with.');
  return f.__text = { text, note, cap };
}
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main', NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// Text in parts of about `size` characters, split at paragraph breaks.
function chunks(text, size) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}|(?=--- (?:Page|Slide) \d+ ---)/)) {
    if (cur && cur.length + para.length > size) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + para;
    while (cur.length > size * 1.4) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/* ---------- small renderers ---------- */
// A safe subset of Markdown: bold, italics, code, lists, paragraphs.
function md(s) {
  const inline = t => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  let html = '', list = null;
  for (const l of esc(s).split('\n')) {
    const m = l.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)/);
    if (m) {
      const tag = m[1] ? 'ol' : 'ul';
      if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; }
      html += `<li>${inline(m[2])}</li>`;
      continue;
    }
    if (list) { html += `</${list}>`; list = null; }
    if (/^#{1,6}\s/.test(l)) html += `<p class="md-h">${inline(l.replace(/^#+\s/, ''))}</p>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  return html + (list ? `</${list}>` : '');
}
const list = (items, cls = '') => items?.length ? `<ul class="${cls}">${items.map(i => `<li>${md(i).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>` : '<p class="hint">None.</p>';
const copyBtn = id => `<button type="button" class="chip" onclick="navigator.clipboard.writeText(window['${id}']).then(() => showToast('Copied'))">${icon('copy')}Copy</button>`;
const mdBtn = (id, name) => `<button type="button" class="chip" onclick="save(new Blob([window['${id}']], { type: 'text/markdown' }), '${name}')">${icon('download')}Download .md</button>`;
const noteBox = n => n ? `<p class="hint warn">${esc(n)}</p>` : '';
function scoreRing(score, label) {
  const s = Math.max(0, Math.min(100, Math.round(score))), C = 2 * Math.PI * 42;
  return `<div class="ring" style="--to:${C * (1 - s / 100)}; --c:${s >= 75 ? 'var(--teal)' : s >= 50 ? 'var(--gold)' : 'var(--rose)'}">
    <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" class="ring-bg"/><circle cx="50" cy="50" r="42" class="ring-fg" style="stroke-dasharray:${C}; stroke-dashoffset:${C}"/></svg>
    <span><b>${s}</b><small>${esc(label)}</small></span></div>`;
}
const outBox = () => $('o-ai');

/* ---------- output shapes for the on-device model (Claude's are on the server) ---------- */
const S_STR = { type: 'string' }, S_STRS = { type: 'array', items: S_STR };
const sObj = p => ({ type: 'object', properties: p, required: Object.keys(p) });
const LOCAL_SCHEMA = {
  summary: sObj({ title: S_STR, summary: S_STR, key_points: S_STRS, action_items: S_STRS }),
  resume: sObj({ score: { type: 'integer' }, verdict: S_STR, summary: S_STR, strengths: S_STRS, gaps: S_STRS, ats: sObj({ score: { type: 'integer' }, notes: S_STRS }), improvements: { type: 'array', items: sObj({ issue: S_STR, suggestion: S_STR, example: S_STR }) }, keywords_missing: S_STRS }),
  quiz: sObj({ title: S_STR, questions: { type: 'array', items: sObj({ question: S_STR, choices: S_STRS, answer: { type: 'integer' }, explanation: S_STR, where: S_STR }) } }),
  translate: sObj({ translations: S_STRS }),
};

/* ---------- quiz state (answers picked by the reader) ---------- */
let quiz = null;
function drawQuiz() {
  const q = quiz;
  outBox().innerHTML = `<div class="ai-card quiz${q.drawn ? ' still' : ''}">
    <div class="ai-head"><h3>${esc(q.title || 'Quiz')}</h3><span class="label">${plural(q.questions.length, 'question')}</span></div>
    ${noteBox(q.note)}
    <ol class="quiz-list">${q.questions.map((it, i) => `<li class="quiz-q${q.checked ? (q.picked[i] === it.answer ? ' right' : ' wrong') : ''}">
      <p class="quiz-text">${esc(it.question)}</p>
      <div class="quiz-choices">${it.choices.map((c, j) => `<button type="button" class="quiz-choice${q.picked[i] === j ? ' on' : ''}${q.checked && j === it.answer ? ' answer' : ''}" data-q="${i}" data-c="${j}" ${q.checked ? 'disabled' : ''}><span class="mono">${'ABCDEFG'[j]}</span>${esc(c)}</button>`).join('')}</div>
      ${q.checked ? `<p class="quiz-why">${icon(q.picked[i] === it.answer ? 'check' : 'x')}${esc(it.explanation)}${it.where ? ` <span class="label">${esc(it.where)}</span>` : ''}</p>` : ''}</li>`).join('')}</ol>
    <div class="row">${q.checked
      ? `<span class="quiz-score">${q.questions.filter((it, i) => q.picked[i] === it.answer).length} / ${q.questions.length} correct</span><button type="button" class="chip" data-act="retry">${icon('rotate-cw')}Try again</button>`
      : `<button type="button" class="btn btn-sm" data-act="check">${icon('check')}Check answers</button>`}
      <button type="button" class="chip" data-act="pdf">${icon('download')}PDF with answer key</button><button type="button" class="chip" data-act="csv">${icon('table')}CSV</button></div></div>`;
  q.drawn = true; // animate in once, not on every answer
  outBox().onclick = async e => {
    const c = e.target.closest('[data-c]'), act = e.target.closest('[data-act]')?.dataset.act;
    if (c) { q.picked[+c.dataset.q] = +c.dataset.c; drawQuiz(); }
    if (act === 'check') { q.checked = true; drawQuiz(); }
    if (act === 'retry') { q.checked = false; q.picked = []; drawQuiz(); }
    if (act === 'csv') {
      const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['#', 'Question', 'A', 'B', 'C', 'D', 'Answer', 'Explanation', 'Where'], ...q.questions.map((it, i) => [i + 1, it.question, ...[0, 1, 2, 3].map(k => it.choices[k] ?? ''), 'ABCD'[it.answer] || '', it.explanation, it.where])];
      save(new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), `${q.base}-quiz.csv`);
    }
    if (act === 'pdf') {
      await need('jspdf');
      const w = flow();
      w.text(q.title || 'Quiz', { size: 18, style: 'bold', after: 12 });
      q.questions.forEach((it, i) => {
        w.text(`${i + 1}. ${it.question}`, { style: 'bold', after: 4 });
        it.choices.forEach((ch, j) => w.text(`${'ABCDEFG'[j]}.  ${ch}`, { indent: 16, after: 2 }));
        w.text('', { after: 6 });
      });
      w.doc.addPage();
      w.text('Answer key', { size: 16, style: 'bold', after: 10 });
      q.questions.forEach((it, i) => w.text(`${i + 1}. ${'ABCDEFG'[it.answer] || '?'}: ${it.explanation}${it.where ? ` (${it.where})` : ''}`, { size: 10, after: 4 }));
      save(w.doc.output('blob'), `${q.base}-quiz.pdf`);
    }
  };
}

/* ---------- chat state ---------- */
const chat = { file: null, messages: [] };
function drawChat(streaming) {
  const box = $('o-chatlog');
  if (!box) return;
  box.innerHTML = chat.messages.length ? chat.messages.map((m, i) => `<div class="bubble ${m.role}${streaming && i === chat.messages.length - 1 ? ' live' : ''}">${m.role === 'user' ? esc(m.content) : md(m.content || '…')}</div>`).join('')
    : `<p class="hint">Ask anything about the document: “What are the deadlines?”, “Summarise section 3”, “Who signed it?”</p>`;
  box.scrollTop = box.scrollHeight;
}
// The parts of the document most related to a question (word overlap, weighted by rarity), for the small on-device model.
function relevant(text, question, budget) {
  const parts = chunks(text, 1200), words = s => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const df = new Map();
  parts.forEach(p => new Set(words(p)).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const q = new Set(words(question));
  const scored = parts.map((p, i) => ({ i, p, s: words(p).reduce((a, w) => a + (q.has(w) ? Math.log(1 + parts.length / df.get(w)) : 0), 0) }));
  const pick = scored.sort((a, b) => b.s - a.s);
  let out = [], used = 0;
  for (const c of pick) { if (used + c.p.length > budget) continue; out.push(c); used += c.p.length; }
  return out.sort((a, b) => a.i - b.i).map(c => c.p).join('\n\n…\n\n');
}

/* ---------- translation helpers ---------- */
const LANGS = ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Hindi', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Urdu', 'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Russian', 'Ukrainian', 'Polish', 'Turkish', 'Vietnamese', 'Indonesian', 'Thai', 'Greek', 'Hebrew', 'Swedish'];
// Translate a list of strings in batches; returns the same number of strings, in order.
async function translateAll(segments, target) {
  const cloudy = useCloud(), out = new Array(segments.length).fill(''), maxChars = cloudy ? 9000 : 1400, maxItems = cloudy ? 150 : 25;
  const todo = segments.map((s, i) => [i, s]).filter(([, s]) => s.trim());
  const batches = [];
  for (const it of todo) {
    const last = batches.at(-1);
    if (!last || last.n + it[1].length > maxChars || last.items.length >= maxItems) batches.push({ items: [it], n: it[1].length });
    else { last.items.push(it); last.n += it[1].length; }
  }
  for (const [k, b] of batches.entries()) {
    progress(`Translating part ${k + 1} of ${batches.length}`, k / batches.length);
    const texts = b.items.map(([, s]) => s);
    let got;
    if (cloudy) got = parseJSON(await cloud('translate', { json: true, params: { target, segments: texts } }), 'cloud').translations;
    else got = parseJSON(await local([{ role: 'system', content: `Translate each string in the JSON array into ${target}. Reply with JSON {"translations": [...]} with exactly one translation per input string, same order. Keep numbers, names and URLs.` }, { role: 'user', content: JSON.stringify(texts) }], { json: LOCAL_SCHEMA.translate, maxTokens: 2600 })).translations;
    if (!Array.isArray(got) || got.length !== texts.length) { // the model merged or split lines: do this batch one string at a time
      got = [];
      for (const t of texts) got.push(cloudy ? parseJSON(await cloud('translate', { json: true, params: { target, segments: [t] } }), 'cloud').translations?.[0] ?? t
        : await local([{ role: 'system', content: `Translate the user's text into ${target}. Reply with the translation only.` }, { role: 'user', content: t }], { maxTokens: 900 }));
    }
    b.items.forEach(([i], j) => { out[i] = got[j] ?? segments[i]; });
  }
  return out.map((t, i) => t || segments[i]);
}
// Translate the paragraphs of an Office XML part in place, keeping each paragraph's first run (its formatting).
async function translateXml(xmlText, ns, target) {
  const x = new DOMParser().parseFromString(xmlText, 'application/xml');
  const paras = [...x.getElementsByTagNameNS(ns, 'p')].filter(p => !p.getElementsByTagNameNS(ns, 'p').length);
  const runs = paras.map(p => [...p.getElementsByTagNameNS(ns, 't')]).filter(ts => ts.length && ts.map(t => t.textContent).join('').trim());
  const done = await translateAll(runs.map(ts => ts.map(t => t.textContent).join('')), target);
  runs.forEach((ts, i) => {
    ts[0].textContent = done[i];
    if (ns === NS_W) ts[0].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    ts.slice(1).forEach(t => { t.textContent = ''; });
  });
  return [new XMLSerializer().serializeToString(x), runs.length];
}

/* ---------- the tools ---------- */
Object.assign(TOOLS, {
  aisummary: {
    group: 'ai', name: 'AI PDF summarizer', icon: 'summary', keys: 'summarize summary tldr key points action items digest ai brief abstract', ai: 'both', featured: false,
    desc: 'Turn a long PDF into a short summary, key points and action items.',
    accept: DOC, drop: 'Drop a document here', note: 'PDF, Word, PowerPoint or text', btn: 'Summarize',
    options: () => ENGINE + row(sel('o-len', 'Length', [['medium', 'Medium'], ['short', 'Short'], ['detailed', 'Detailed']]), inp('o-focus', 'Focus on (optional)', 'placeholder="e.g. risks, dates, costs"')) + '<div id="o-ai"></div>',
    afterOptions: () => refreshEngine(),
    async run([f]) {
      const cloudy = useCloud(), d = await docText(f, cloudy ? CLOUD_CHARS : LOCAL_CHARS * 10);
      let r;
      if (cloudy) r = parseJSON(await cloud('summary', { json: true, name: f.name, text: d.text, params: { length: val('o-len'), focus: val('o-focus') } }, writing), 'cloud');
      else {
        const parts = chunks(d.text, LOCAL_CHARS), lens = { short: '3-5', medium: '5-8', detailed: '8-12' }[val('o-len')];
        let source = d.text;
        if (parts.length > 1) { // too long for one go: summarise each part, then summarise the notes
          const notes = [];
          for (const [i, p] of parts.entries()) {
            progress(`Reading part ${i + 1} of ${parts.length}`, i / parts.length);
            notes.push(await local([{ role: 'system', content: 'Summarize this part of a document as 4-8 short bullet points of facts. Only use what the text says.' }, { role: 'user', content: p }], { maxTokens: 500 }));
          }
          source = notes.join('\n');
        }
        progress('Writing the summary');
        r = parseJSON(await local([{ role: 'system', content: `You summarize documents. Reply in JSON with: title, summary (a paragraph), key_points (${lens} one-sentence takeaways), action_items (concrete next steps or deadlines; empty if none). Use only facts from the text.${val('o-focus') ? ` Focus on: ${val('o-focus')}.` : ''}` }, { role: 'user', content: source }], { json: LOCAL_SCHEMA.summary, maxTokens: 1500, onText: writing }));
      }
      window.aiText = `# ${r.title}\n\n${r.summary}\n\n## Key points\n${r.key_points.map(p => `- ${p}`).join('\n')}\n\n## Action items\n${r.action_items.length ? r.action_items.map(p => `- [ ] ${p}`).join('\n') : 'None.'}\n`;
      outBox().innerHTML = `<article class="ai-card">${noteBox(d.note)}<div class="ai-head"><h3>${esc(r.title)}</h3><span class="label">${cloudy ? 'Claude' : 'On-device'}</span></div>
        <div class="ai-prose">${md(r.summary)}</div>
        <h4>Key points</h4>${list(r.key_points, 'points')}<h4>Action items</h4>${list(r.action_items, 'todo')}
        <div class="row">${copyBtn('aiText')}${mdBtn('aiText', `${stem(f)}-summary.md`)}</div></article>`;
      return 'Summary ready';
    },
  },
  airesume: {
    group: 'ai', name: 'AI resume analyzer', icon: 'resume', keys: 'resume cv review ats job application feedback career hire score ai', ai: 'both',
    desc: 'Review a resume for strengths, gaps, ATS issues and concrete improvements, optionally against a job description.',
    accept: DOC, drop: 'Drop a resume here', note: 'PDF, Word or text', btn: 'Analyze resume',
    options: () => ENGINE + `<label class="field"><span class="field-label">Job description (optional, for a tailored review)</span><textarea id="o-job" class="input" placeholder="Paste the job ad here"></textarea></label><div id="o-ai"></div>`,
    afterOptions: () => refreshEngine(),
    async run([f]) {
      const cloudy = useCloud(), d = await docText(f, cloudy ? CLOUD_CHARS : LOCAL_CHARS), job = val('o-job').trim();
      progress('Reviewing');
      const r = cloudy ? parseJSON(await cloud('resume', { json: true, name: f.name, text: d.text, params: { job } }, writing), 'cloud')
        : parseJSON(await local([{ role: 'system', content: 'You are a recruiter. Review the resume honestly and specifically. Reply in JSON: score (0-100), verdict (one line), summary, strengths, gaps, ats {score 0-100, notes about layout, headings, keywords}, improvements [{issue, suggestion, example rewritten line}], keywords_missing.' },
          { role: 'user', content: `${d.text}${job ? `\n\nJob description:\n${job.slice(0, 3000)}` : ''}` }], { json: LOCAL_SCHEMA.resume, maxTokens: 2200, onText: writing }));
      window.aiText = `# Resume review: ${r.score}/100\n\n${r.verdict}\n\n${r.summary}\n\n## Strengths\n${r.strengths.map(s => `- ${s}`).join('\n')}\n\n## Gaps\n${r.gaps.map(s => `- ${s}`).join('\n')}\n\n## ATS (${r.ats.score}/100)\n${r.ats.notes.map(s => `- ${s}`).join('\n')}\n\n## Improvements\n${r.improvements.map(i => `- **${i.issue}**: ${i.suggestion}\n  - Example: ${i.example}`).join('\n')}\n\n## Missing keywords\n${r.keywords_missing.join(', ') || 'None.'}\n`;
      outBox().innerHTML = `<article class="ai-card">${noteBox(d.note)}
        <div class="resume-top">${scoreRing(r.score, 'overall')}${scoreRing(r.ats.score, 'ATS')}<div><h3>${esc(r.verdict)}</h3><div class="ai-prose">${md(r.summary)}</div></div></div>
        <div class="two-col"><div><h4>Strengths</h4>${list(r.strengths, 'points good')}</div><div><h4>Gaps</h4>${list(r.gaps, 'points bad')}</div></div>
        <h4>ATS notes</h4>${list(r.ats.notes, 'points')}
        <h4>Improvements</h4><div class="improve">${r.improvements.map(i => `<div class="improve-item"><b>${esc(i.issue)}</b><p>${esc(i.suggestion)}</p>${i.example ? `<p class="example">${esc(i.example)}</p>` : ''}</div>`).join('') || '<p class="hint">None.</p>'}</div>
        ${r.keywords_missing.length ? `<h4>Missing keywords</h4><div class="row">${r.keywords_missing.map(k => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''}
        <div class="row">${copyBtn('aiText')}${mdBtn('aiText', `${stem(f)}-review.md`)}</div></article>`;
      requestAnimationFrame(() => outBox().querySelectorAll('.ring').forEach(el => el.classList.add('go')));
      return `Scored ${r.score}/100`;
    },
  },
  aiocr: {
    group: 'ai', name: 'AI OCR', icon: 'eye', keys: 'ocr screenshot image text extract read handwriting scan copy ai vision', ai: 'both',
    desc: 'Pull clean, readable text out of screenshots, photos and scans, including tables.',
    accept: `${IMG},${PDF}`, multiple: true, drop: 'Drop screenshots or images here', note: 'Images, or a scanned PDF (up to 8 pages)', btn: 'Extract text',
    cloudSends: 'the images',
    localNote: 'Private: runs Tesseract text recognition on your device. Claude reads messy screenshots, handwriting and tables much better.',
    options: () => ENGINE + `<div id="o-ai"></div>`,
    afterOptions: () => refreshEngine(),
    async run(files) {
      const cloudy = useCloud(), images = [];
      for (const f of files) {
        if (isPdf(f)) {
          const view = await openView(f);
          for (let i = 1; i <= Math.min(view.numPages, 8) && images.length < 8; i++) images.push(await renderPage(view, i, 2));
        } else if (images.length < 8) images.push(canvasOf(await decodeImage(f)));
      }
      let text = '';
      if (cloudy) {
        const send = await Promise.all(images.map(async c => {
          const k = Math.min(1, 1600 / Math.max(c.width, c.height)), small = k < 1 ? resample(c, Math.round(c.width * k), Math.round(c.height * k)) : c;
          return { media_type: 'image/jpeg', data: (await new Promise(r => flatten(small, 'image/jpeg').toBlob(b => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); }, 'image/jpeg', .9))) };
        }));
        text = await cloud('ocr', { images: send }, acc => { writing(acc); $('o-ocrtext') && ($('o-ocrtext').value = acc); });
      } else {
        const ocr = makeOcr('eng');
        try {
          for (const [i, c] of images.entries()) { progress(`Reading image ${i + 1} of ${images.length}`, i / images.length); text += (i ? '\n---\n' : '') + (await ocr.recognize(c)).text.trim(); }
        } finally { ocr.done(); }
      }
      window.aiText = text.trim();
      outBox().innerHTML = `<div class="ai-card"><div class="ai-head"><h3>Text found</h3><span class="label">${cloudy ? 'Claude' : 'On-device'}</span></div>
        <textarea class="input tall" id="o-ocrtext" readonly>${esc(window.aiText)}</textarea>
        <div class="row">${copyBtn('aiText')}<button type="button" class="chip" onclick="save(new Blob([window.aiText], { type: 'text/plain' }), '${stem(files[0])}-text.txt')">${icon('download')}Download .txt</button></div></div>`;
      return window.aiText && window.aiText !== '(no text found)' ? 'Text extracted' : 'No text found';
    },
  },
  airecommend: {
    group: 'ai', name: 'AI tool finder', icon: 'compass', keys: 'recommend suggest which tool help find what should i use goal ai assistant', ai: 'both',
    desc: 'Describe what you want to do, and get the right Nebula tools for it.',
    btn: 'Find tools', cloudSends: 'what you type',
    localNote: 'Private: matches your words against the tools on your device. Claude understands goals described in your own words better.',
    options: () => ENGINE + `<label class="field"><span class="field-label">What do you want to do?</span><textarea id="o-goal" class="input" placeholder="e.g. I scanned a contract on my phone and need to sign it and email it under 2 MB"></textarea></label>
      <div class="row">${['Make my scanned PDF searchable', 'Get the tables from a PDF into a spreadsheet', 'Send a photo that is too big for email', 'Prepare my CV for a job'].map(g => `<button type="button" class="chip" onclick="$('o-goal').value = this.textContent; runTool()">${g}</button>`).join('')}</div><div id="o-ai"></div>`,
    afterOptions() { refreshEngine(); $('o-goal').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTool(); } }; },
    async run() {
      const goal = val('o-goal').trim();
      if (!goal) throw new UserError('Describe what you want to do first.');
      const catalog = Object.entries(TOOLS).filter(([id]) => id !== 'airecommend').map(([id, t]) => ({ id, name: t.name, desc: t.desc }));
      let picks, tip = '';
      if (useCloud()) ({ picks, tip } = parseJSON(await cloud('recommend', { json: true, params: { catalog, goal } }), 'cloud'));
      else { // word matching with a few synonyms
        const SYN = { shrink: 'compress', smaller: 'compress', size: 'compress', join: 'merge', combine: 'merge', scan: 'ocr', scanned: 'ocr', searchable: 'ocr', signature: 'sign', password: 'protect', table: 'excel', spreadsheet: 'excel', cv: 'resume', photo: 'image', picture: 'image', big: 'compress', large: 'compress', email: 'compress', mb: 'compress', translate: 'translate', summary: 'summarize', quiz: 'quiz', background: 'background', iphone: 'heic' };
        const words = goal.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
        const terms = [...new Set(words.flatMap(w => [w, SYN[w]].filter(Boolean)))];
        picks = catalog.map(t => {
          const hay = `${t.name} ${t.desc} ${TOOLS[t.id].keys}`.toLowerCase(), hit = terms.filter(w => hay.includes(w));
          return { id: t.id, s: hit.reduce((a, w) => a + (t.name.toLowerCase().includes(w) ? 3 : 1), 0), hit };
        }).filter(p => p.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(p => ({ id: p.id, reason: `Matches “${p.hit.slice(0, 3).join('”, “')}”.` }));
        if (!picks.length) throw new UserError('No tool matched those words. Try describing it differently, or switch to Claude.');
      }
      outBox().innerHTML = `<div class="ai-card"><div class="tool-picks">${picks.filter(p => TOOLS[p.id]).map((p, i) => `<button type="button" class="pick-card" data-id="${p.id}" style="--i:${i}">
        <span class="card-icon">${icon(TOOLS[p.id].icon)}</span><span><b>${esc(TOOLS[p.id].name)}</b><small>${esc(p.reason)}</small></span>${icon('open')}</button>`).join('')}</div>${tip ? `<p class="hint">${esc(tip)}</p>` : ''}</div>`;
      outBox().onclick = e => { const b = e.target.closest('[data-id]'); if (b) openTool(b.dataset.id); };
      return `Found ${plural(picks.length, 'tool')}`;
    },
  },
  aichat: {
    group: 'ai', name: 'Chat with PDF', icon: 'chat', keys: 'chat ask question answer pdf document talk ai assistant qa', ai: 'both', quiet: true, wide: true,
    desc: 'Ask questions about a PDF and get focused answers that point to the page.',
    accept: DOC, drop: 'Drop a document here', note: 'PDF, Word, PowerPoint or text', btn: 'Ask',
    options: () => ENGINE + `<div class="chatlog" id="o-chatlog" aria-live="polite"></div>
      <div class="chat-input"><textarea id="o-q" class="input" rows="2" placeholder="Ask a question about the document"></textarea></div><div id="o-ai"></div>`,
    afterOptions() {
      refreshEngine();
      if (chat.file !== uploadedFiles[0]) { chat.file = uploadedFiles[0]; chat.messages = []; }
      drawChat();
      $('o-q').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runTool(); } };
    },
    async run([f]) {
      const q = val('o-q').trim();
      if (!q) throw new UserError('Type a question first.');
      const cloudy = useCloud(), d = await docText(f, cloudy ? CLOUD_CHARS : LOCAL_CHARS * 30);
      chat.messages.push({ role: 'user', content: q }, { role: 'assistant', content: '' });
      $('o-q').value = '';
      drawChat(true);
      const last = chat.messages.at(-1), onText = acc => { last.content = acc; drawChat(true); };
      try {
        if (cloudy) await cloud('chat', { name: f.name, text: d.text, messages: chat.messages.slice(0, -1) }, onText);
        else {
          progress('Thinking');
          const context = relevant(d.text, `${q} ${chat.messages.slice(-4, -2).map(m => m.content).join(' ')}`, LOCAL_CHARS - 1500);
          await local([{ role: 'system', content: `Answer questions about a document using only these excerpts. If the excerpts don't say, say you couldn't find it. Be concise; cite pages like (p. 3) when the excerpts show page markers.\n\n${context}` },
            ...chat.messages.slice(-5, -1).map(m => ({ role: m.role, content: m.content.slice(0, 1500) }))], { maxTokens: 900, onText });
        }
      } catch (e) { chat.messages.splice(-2); drawChat(); $('o-q').value = q; throw e; }
      drawChat();
      if (d.note && chat.messages.length === 2) showToast(d.note);
      return 'Answered';
    },
  },
  aitranslate: {
    group: 'ai', name: 'AI document translator', icon: 'translate', keys: 'translate translation language docx pptx pdf txt convert localize ai', ai: 'both',
    desc: 'Translate PDF, Word, PowerPoint and text files, keeping the layout readable. Word and PowerPoint keep their formatting.',
    accept: `${PDF},.docx,.pptx,.txt,.md`, drop: 'Drop a document here', note: 'PDF, DOCX, PPTX or TXT', btn: 'Translate',
    options: () => ENGINE + row(sel('o-lang', 'Translate into', LANGS.map(l => [l, l])), inp('o-lang2', 'Or another language', 'placeholder="e.g. Swahili"')) +
      hint('Word and PowerPoint files keep their layout, styles and pictures. PDFs come back as an editable Word file with the text translated.') + '<div id="o-ai"></div>',
    afterOptions: () => refreshEngine(),
    async run([f]) {
      const target = val('o-lang2').trim() || val('o-lang'), ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'txt' || ext === 'md') {
        const lines = (await f.text()).split('\n'), out = await translateAll(lines, target);
        save(new Blob([out.join('\n')], { type: 'text/plain' }), `${stem(f)}-${target.split(' ')[0].toLowerCase()}.${ext}`);
        return `Translated into ${target}`;
      }
      if (ext === 'docx' || ext === 'pptx') {
        await need('jszip');
        const z = await JSZip.loadAsync(f), ns = ext === 'docx' ? NS_W : NS_A;
        const parts = Object.keys(z.files).filter(n => ext === 'docx' ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n) : /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
        let count = 0;
        for (const n of parts) {
          const [xmlOut, c] = await translateXml(await z.file(n).async('string'), ns, target);
          z.file(n, xmlOut);
          count += c;
        }
        if (!count) throw new UserError('This file has no text to translate.');
        save(await z.generateAsync({ type: 'blob', mimeType: MIME[ext] }), `${stem(f)}-${target.split(' ')[0].toLowerCase()}.${ext}`);
        return `Translated ${plural(count, 'paragraph')} into ${target}`;
      }
      // PDF: rebuild as a Word document of translated paragraphs (headings stay bold and larger)
      const view = await openView(f), pages = [];
      for (let i = 1; i <= view.numPages; i++) {
        progress(`Reading page ${i} of ${view.numPages}`, i / view.numPages);
        const pg = await analyzePage(view, i), lines = toLines(pg.items), paras = [];
        const body = median(lines.map(l => l.size)) || 11;
        // a new paragraph starts where the gap to the line above is clearly more than this page's usual line spacing
        const gaps = lines.slice(1).map((l, i) => l.top - lines[i].top).filter(d => d > 0).sort((x, y) => x - y), pitch = gaps[gaps.length >> 2] || body * 1.2; // lower quartile: most gaps are within paragraphs
        for (const l of lines) {
          const prev = paras.at(-1), txt = l.segs.map(s => s.text).join('   ');
          if (prev && Math.abs(prev.size - l.size) < .8 && l.top - prev.top < Math.max(pitch, l.size) * 1.35) { prev.text += ' ' + txt; prev.top = l.top; }
          else paras.push({ text: txt, size: l.size, top: l.top, head: l.size > body * 1.25 });
        }
        pages.push({ W: pg.W, H: pg.H, paras });
      }
      const all = pages.flatMap(p => p.paras);
      if (!all.length) throw new UserError('This PDF has no text to translate. If it is a scan, run Read text (OCR) first.');
      const done = await translateAll(all.map(p => p.text.replace(/(\p{L})- (\p{Ll})/gu, '$1$2')), target);
      let k = 0, bodyXml = '';
      pages.forEach((p, i) => {
        if (i) bodyXml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
        for (const para of p.paras) {
          const sz = Math.round(Math.min(40, Math.max(9, para.size)) * 2);
          bodyXml += `<w:p><w:pPr><w:spacing w:after="${para.head ? 160 : 120}"/></w:pPr><w:r><w:rPr>${para.head ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${xml(done[k++])}</w:t></w:r></w:p>`;
        }
      });
      const doc = docxWriter();
      save(await doc.pack(bodyXml, sectXml(pages[0].W, pages[0].H, { t: 56, r: 56, b: 56, l: 56 })), `${stem(f)}-${target.split(' ')[0].toLowerCase()}.docx`);
      return `Translated into ${target}`;
    },
  },
  aiquiz: {
    group: 'ai', name: 'AI quiz generator', icon: 'quiz', keys: 'quiz test questions exam study flashcards learn multiple choice ai', ai: 'both',
    desc: 'Turn a PDF into an interactive quiz with answers and explanations, then export it as PDF or CSV.',
    accept: DOC, drop: 'Drop a document here', note: 'PDF, Word, PowerPoint or text', btn: 'Generate quiz',
    options: () => ENGINE + row(sel('o-count', 'Questions', [['10', '10'], ['5', '5'], ['15', '15'], ['20', '20']]), sel('o-diff', 'Difficulty', [['medium', 'Medium'], ['easy', 'Easy'], ['hard', 'Hard']]), sel('o-kinds', 'Type', [['mcq', 'Multiple choice'], ['mixed', 'Mixed with true/false']])) + '<div id="o-ai"></div>',
    afterOptions: () => refreshEngine(),
    async run([f]) {
      const cloudy = useCloud(), count = +val('o-count');
      let r, note = '';
      if (cloudy) {
        const d = await docText(f, CLOUD_CHARS);
        note = d.note;
        r = parseJSON(await cloud('quiz', { json: true, name: f.name, text: d.text, params: { count, difficulty: val('o-diff'), kinds: val('o-kinds') } }, writing), 'cloud');
      } else {
        const d = await docText(f, LOCAL_CHARS * 20), parts = chunks(d.text, LOCAL_CHARS), n = Math.min(count, 10);
        // a sample from across the whole document, since the small model can read only part of it at once
        const sample = parts.length === 1 ? parts[0] : parts.filter((_, i) => i % Math.ceil(parts.length / 3) === 0).map(p => p.slice(0, Math.floor(LOCAL_CHARS / 3))).join('\n\n…\n\n');
        note = [d.note, parts.length > 1 ? 'The on-device model wrote questions from samples across the document.' : '', count > 10 ? 'The on-device model writes at most 10 questions at a time.' : ''].filter(Boolean).join(' ');
        progress('Writing questions');
        r = parseJSON(await local([{ role: 'system', content: `Write a quiz of ${n} ${val('o-diff')} questions from the text. Reply in JSON: title, questions [{question, choices (4 options${val('o-kinds') === 'mixed' ? ', or ["True","False"]' : ''}), answer (0-based index of the right choice), explanation, where (page or section)}]. Every answer must come from the text.` }, { role: 'user', content: sample }], { json: LOCAL_SCHEMA.quiz, maxTokens: 3500, onText: writing }));
      }
      const qs = (r.questions || []).filter(q => q.question && Array.isArray(q.choices) && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length);
      if (!qs.length) throw new UserError('No usable questions came back. Try again.');
      quiz = { title: r.title, questions: qs, picked: [], checked: false, note, base: stem(f) };
      drawQuiz();
      return `Quiz of ${plural(qs.length, 'question')} ready`;
    },
  },
});

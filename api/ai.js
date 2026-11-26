/* Nebula AI: a Vercel function that runs the AI tools on Claude.
   The browser sends a task name plus the document's text (or images) and a few settings; the prompts live here,
   so this endpoint can't be used as a general chatbot. Replies stream back as server-sent events:
     data: {"t": "...text..."}       a piece of the reply
     data: {"done": true, ...}       the end (stop reason, and a refusal category if Claude declined)
     data: {"error": "..."}          something went wrong after streaming started
   Needs ANTHROPIC_API_KEY in the Vercel project's environment variables. */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const TEXT_CAP = 300_000;          // characters of document text per request (about 75k tokens)
const IMAGE_CAP = 8;               // images per request
const IMAGE_BYTES = 1_500_000;     // per image, base64 length
const RATE = { windowMs: 10 * 60_000, max: 40 }; // requests per IP per window (per server instance)

/* ---------- output shapes (structured outputs) ---------- */
const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const SCHEMAS = {
  summary: obj({ title: str, summary: str, key_points: strs, action_items: strs }),
  resume: obj({
    score: { type: 'integer' }, verdict: str, summary: str, strengths: strs, gaps: strs,
    ats: obj({ score: { type: 'integer' }, notes: strs }),
    improvements: { type: 'array', items: obj({ issue: str, suggestion: str, example: str }) },
    keywords_missing: strs,
  }),
  translate: obj({ translations: strs }),
  quiz: obj({
    title: str,
    questions: { type: 'array', items: obj({ question: str, choices: strs, answer: { type: 'integer' }, explanation: str, where: str }) },
  }),
};

/* ---------- the tasks ---------- */
const doc = (name, text) => `<document name="${String(name || 'document').replace(/[<>"]/g, '').slice(0, 120)}">\n${text}\n</document>`;
const LENGTHS = { short: 'about 80 words and 3-5 key points', medium: 'about 200 words and 5-8 key points', detailed: 'about 450 words and 8-12 key points' };
const LEVELS = { easy: 'easy (recall of stated facts)', medium: 'medium (understanding and connecting ideas)', hard: 'hard (application, inference and edge cases)' };

const TASKS = {
  summary: {
    effort: 'medium', maxTokens: 16000, schema: () => SCHEMAS.summary,
    system: 'You summarize documents for busy readers. Write plain, specific prose grounded only in the document; never invent facts. ' +
      'Key points are the most important takeaways, each one sentence. Action items are concrete next steps, decisions or deadlines the document asks of its reader; return an empty list when there are none. ' +
      'Write in the same language as the document. Use Markdown only for emphasis inside strings, never headings.',
    content: (b) => `${doc(b.name, b.text)}\n\nSummarize this document in ${LENGTHS[b.params.length] || LENGTHS.medium}.` +
      (b.params.focus ? `\nFocus especially on: ${b.params.focus}` : ''),
  },
  resume: {
    effort: 'high', maxTokens: 16000, schema: () => SCHEMAS.resume,
    system: 'You are an experienced recruiter and resume coach. Review the resume honestly and specifically: quote or reference its actual content, and give feedback a candidate can act on. ' +
      'score is 0-100 for overall strength (for the job description if one is given). ats.score is 0-100 for how well an applicant tracking system would parse and rank it; ats.notes cover layout, headings, dates, keywords and file-format issues. ' +
      'improvements: each with the issue, the fix, and a rewritten example line. keywords_missing: important skills or terms the target role expects but the resume lacks (empty when no job description is given and none are obvious). ' +
      'Write in the same language as the resume.',
    content: (b) => `${doc(b.name, b.text)}` + (b.params.job ? `\n\n<job_description>\n${b.params.job}\n</job_description>\n\nReview this resume for the job above.` : '\n\nReview this resume.'),
  },
  ocr: {
    effort: 'low', maxTokens: 16000,
    system: 'You transcribe text from images. Output only the text in the images, exactly as written, in reading order, keeping line breaks. ' +
      'Render tables as Markdown tables and keep list markers. Mark anything illegible as [unclear]. No commentary, no preamble. If there is no text, reply with: (no text found)',
    content: (b) => [...b.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
      { type: 'text', text: b.images.length > 1 ? `Transcribe the text in these ${b.images.length} images, in order, separated by a line "---".` : 'Transcribe the text in this image.' }],
  },
  recommend: {
    effort: 'low', maxTokens: 4000,
    schema: (b) => obj({ picks: { type: 'array', items: obj({ id: { type: 'string', enum: b.params.catalog.map(t => t.id) }, reason: str }) }, tip: str }),
    system: 'You help people pick the right tool in Nebula, a set of PDF, image and AI tools. Choose the 1-3 tools from the catalog that best fit the goal, best first. ' +
      'Each reason is one short sentence saying why it fits this goal. tip is one short practical sentence (for example the order to use several tools in), or an empty string. Never suggest tools that are not in the catalog.',
    content: (b) => `<catalog>\n${b.params.catalog.map(t => `${t.id}: ${t.name} - ${t.desc}`).join('\n')}\n</catalog>\n\nMy goal: ${b.params.goal}`,
  },
  chat: {
    effort: 'medium', maxTokens: 16000, chat: true,
    system: 'You answer questions about the document the user shared. Base answers only on the document; if it does not say, reply that it does not. ' +
      'Be concise and direct. When the text has page markers like "--- Page 3 ---", cite pages as (p. 3). Use short Markdown (bold, lists) when it helps. Answer in the language of the question.',
  },
  translate: {
    effort: 'medium', maxTokens: 32000, schema: () => SCHEMAS.translate,
    system: 'You are a professional translator. Translate each string in the input array into the target language, faithfully and naturally, keeping the tone. ' +
      'Return exactly one translation per input string, in the same order, so the arrays have the same length. Keep numbers, names, URLs, email addresses, code and placeholders unchanged. ' +
      'Keep leading or trailing spaces and punctuation style. An empty or whitespace-only string stays as it is.',
    content: (b) => `Target language: ${b.params.target}\n\nInput (JSON array of ${b.params.segments.length} strings):\n${JSON.stringify(b.params.segments)}`,
  },
  quiz: {
    effort: 'medium', maxTokens: 16000, schema: () => SCHEMAS.quiz,
    system: 'You write quizzes that test understanding of a document. Every question must be answerable from the document alone. ' +
      'Each question has 4 choices (or exactly ["True", "False"] for true/false questions); answer is the 0-based index of the correct choice. Make wrong choices plausible. ' +
      'explanation says briefly why the answer is right, and where says where in the document it comes from (a page like "p. 4" when page markers exist, else a short section name). ' +
      'Write in the same language as the document.',
    content: (b) => `${doc(b.name, b.text)}\n\nWrite a quiz of ${b.params.count} ${LEVELS[b.params.difficulty] || LEVELS.medium} questions` +
      (b.params.kinds === 'mixed' ? ', mixing multiple-choice and true/false questions.' : ', all multiple-choice.'),
  },
};

/* ---------- checks ---------- */
const hits = new Map(); // ponytail: per-instance memory, so the limit is approximate across instances; a shared store (KV) if abuse appears
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.at(-1) > RATE.windowMs) hits.delete(k);
  return list.length > RATE.max;
}
function allowedOrigin(origin) {
  if (!origin) return true; // same-origin navigations and server-to-server calls have none
  try {
    const { hostname } = new URL(origin);
    const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'nebula-pdf.vercel.app' ||
      /^nebula-pdf(-[a-z0-9-]+)?\.vercel\.app$/.test(hostname) || extra.includes(hostname);
  } catch { return false; }
}
class BadInput extends Error {}
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
function readBody(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { throw new BadInput('The request was not valid JSON.'); } }
  if (!body || typeof body !== 'object') throw new BadInput('Missing request body.');
  const task = TASKS[body.task] ? body.task : null;
  if (!task) throw new BadInput('Unknown task.');
  const p = body.params && typeof body.params === 'object' ? body.params : {};
  const b = { task, name: clip(body.name, 200), text: '', images: [], messages: [], params: {} };
  if (typeof body.text === 'string') {
    if (body.text.length > TEXT_CAP) throw new BadInput('This document is too long for one request.');
    b.text = body.text;
  }
  if (Array.isArray(body.images)) {
    if (body.images.length > IMAGE_CAP) throw new BadInput(`Send at most ${IMAGE_CAP} images at once.`);
    b.images = body.images.map(i => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(i?.media_type) || typeof i.data !== 'string' || i.data.length > IMAGE_BYTES) throw new BadInput('An image was too large or not a supported type.');
      return { media_type: i.media_type, data: i.data };
    });
  }
  if (task === 'summary') b.params = { length: clip(p.length, 20), focus: clip(p.focus, 300) };
  if (task === 'resume') b.params = { job: clip(p.job, 15000) };
  if (task === 'quiz') b.params = { count: Math.min(20, Math.max(3, parseInt(p.count) || 10)), difficulty: clip(p.difficulty, 20), kinds: clip(p.kinds, 20) };
  if (task === 'recommend') {
    const catalog = Array.isArray(p.catalog) ? p.catalog.slice(0, 80).map(t => ({ id: clip(t?.id, 40), name: clip(t?.name, 80), desc: clip(t?.desc, 300) })).filter(t => /^[a-z0-9]+$/.test(t.id)) : [];
    if (!catalog.length) throw new BadInput('Missing tool list.');
    const goal = clip(p.goal, 1000).trim();
    if (!goal) throw new BadInput('Describe what you want to do.');
    b.params = { catalog, goal };
  }
  if (task === 'translate') {
    const segments = Array.isArray(p.segments) ? p.segments.slice(0, 500).map(s => clip(s, 4000)) : [];
    if (!segments.length) throw new BadInput('Nothing to translate.');
    if (segments.reduce((n, s) => n + s.length, 0) > 60_000) throw new BadInput('Too much text in one translation request.');
    b.params = { target: clip(p.target, 60).trim() || 'English', segments };
  }
  if (task === 'chat') {
    if (!b.text) throw new BadInput('Missing document text.');
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
    b.messages = msgs.map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: clip(m?.content, 8000) })).filter(m => m.content.trim());
    if (!b.messages.length || b.messages.at(-1).role !== 'user') throw new BadInput('Ask a question first.');
  }
  if (task === 'ocr' && !b.images.length) throw new BadInput('Add an image first.');
  if (['summary', 'resume', 'quiz'].includes(task) && !b.text.trim()) throw new BadInput('This document has no text to work with.');
  return b;
}

function buildRequest(b) {
  const t = TASKS[b.task];
  const req = {
    model: MODEL,
    max_tokens: t.maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if Claude Opus 5.5 declines on a safety classifier, the API retries on a fallback model
    output_config: { effort: t.effort, ...(t.schema ? { format: { type: 'json_schema', schema: t.schema(b) } } : {}) },
  };
  if (t.chat) {
    // the document goes in the system prompt and is cached, so follow-up questions cost a fraction of the first
    req.system = [{ type: 'text', text: t.system }, { type: 'text', text: doc(b.name, b.text), cache_control: { type: 'ephemeral' } }];
    req.messages = b.messages;
  } else {
    req.system = t.system;
    req.messages = [{ role: 'user', content: t.content(b) }];
  }
  return req;
}

const client = () => globalThis.__nebulaClaude || new Anthropic(); // the dev server can swap in a stand-in for testing
const sse = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return [502, 'The AI service rejected the server’s API key. The site owner needs to check ANTHROPIC_API_KEY.'];
  if (err instanceof Anthropic.RateLimitError) return [429, 'The AI service is busy right now. Try again in a minute.'];
  if (err instanceof Anthropic.BadRequestError) return [400, `The AI service couldn’t take this request: ${err.message}`];
  if (err instanceof Anthropic.APIConnectionError) return [502, 'Couldn’t reach the AI service. Try again.'];
  if (err instanceof Anthropic.APIError) return [502, `The AI service had a problem (${err.status ?? 'network'}). Try again.`];
  return [500, 'Something went wrong on the server.'];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ ready: !!(process.env.ANTHROPIC_API_KEY || globalThis.__nebulaClaude), model: MODEL });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!allowedOrigin(req.headers.origin)) return res.status(403).json({ error: 'This endpoint only serves the Nebula site.' });
  if (!process.env.ANTHROPIC_API_KEY && !globalThis.__nebulaClaude) return res.status(503).json({ error: 'AI isn’t set up on this site yet: the owner needs to add an ANTHROPIC_API_KEY.' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ error: 'Too many AI requests from you in a short time. Wait a few minutes and try again.' });

  let b;
  try { b = readBody(req.body); }
  catch (e) { return res.status(400).json({ error: e instanceof BadInput ? e.message : 'Bad request.' }); }

  let stream;
  try {
    stream = client().beta.messages.stream(buildRequest(b));
    res.on('close', () => { if (!res.writableEnded) stream.abort(); }); // the visitor left: stop paying for output
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') sse(res, { t: ev.delta.text });
    }
    const msg = await stream.finalMessage();
    sse(res, {
      done: true, stop: msg.stop_reason, model: msg.model,
      refusal: msg.stop_reason === 'refusal' ? (msg.stop_details?.category || 'policy') : null,
    });
    res.end();
  } catch (err) {
    if (stream?.aborted || res.writableEnded) return;
    console.error('ai error', err?.status, err?.message);
    const [status, message] = friendly(err);
    if (!res.headersSent) return res.status(status).json({ error: message });
    sse(res, { error: message });
    res.end();
  }
}

# Nebula

[![Deploy with Vercel](https://vercelbadge.vercel.app/api/aman/nebula-pdf)](https://nebula-pdf.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-16140F.svg)](https://opensource.org/licenses/MIT)
[![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-0B7FA8.svg)]()

**Zero uploads by default.**

Nebula is a suite of 42 PDF, image and AI tools that run in your browser. Your documents are processed on your device; no file is uploaded. Each tool loads the open-source library it needs the first time you use it, and the whole app can be installed and used offline.

The AI tools run an open-source model on your device too. Each one has an optional switch to use Claude instead, for better answers: only then does the document's text leave the device (see [AI tools](#-ai-tools)).

🌍 **Live Output:** [nebula-pdf.vercel.app](https://nebula-pdf.vercel.app)

---

## ✨ Tools

| Group | Tools |
|---|---|
| Organize | Merge PDFs, Split PDF, Remove pages, Organize pages (reorder, turn, delete), Rotate PDF |
| Optimize | Compress PDF (lossless or image-based), Repair PDF, Read text (OCR, images and scanned PDFs) |
| Convert to PDF | Images to PDF, Word to PDF, Excel to PDF, Text to PDF |
| Convert from PDF | PDF to images (JPG/PNG), PDF to Word, PDF to PowerPoint, PDF to Excel |
| Edit & sign | Sign PDF, Edit PDF (change existing text, add text, white out), Fill in a form, Add page numbers, Add watermark, Crop PDF, Redact PDF |
| Security | Protect PDF (AES-256), Unlock PDF, View PDF metadata, Remove PDF metadata |
| Image tools | Resize, Crop, Compress, Convert (JPG/PNG/WebP), HEIC to JPG, Remove background, Image enhancer |
| AI tools | AI PDF summarizer, AI resume analyzer, AI OCR, AI tool finder, Chat with PDF, AI document translator, AI quiz generator, AI image upscaler (2×/4×/8×), plus Remove background and Image enhancer |

**Batch:** Rotate, Compress, Repair, Word to PDF, Excel to PDF, PDF to images, PDF to Word, PDF to PowerPoint, PDF to Excel, page numbers, watermark, Protect, Unlock, Remove metadata and the image resize, compress, convert and HEIC tools take many files at once and return one zip, with a ✓ or ✕ and the reason for each file.

**Page picking:** Split, Remove pages, Rotate and PDF to images show every page as a thumbnail to click (Shift-click picks a run; All, None, Odd and Even shortcuts), kept in step with the page-range box. The result's first page is previewed beside the tool.

**Edit PDF:** click any line of existing text to retype it. It keeps its font style (bold, italic, serif, sans or mono), size and colour, on a patch of its own background colour. You can also add new text or white out areas. Changed words are painted over rather than removed from the file; Redact PDF removes text for good.

**Watermark:** text (DRAFT, CONFIDENTIAL…) at any angle and colour, or your logo in a corner, the centre or tiled, at the strength you pick.

**Metadata:** View PDF metadata shows title, author, dates, producer, PDF version, page sizes, encryption, forms, attachments and JavaScript, and saves it as JSON. Remove PDF metadata clears the document info and the XMP metadata stream, and keeps the pages untouched.

**Fill in a form:** fills a PDF's text fields, checkboxes, dropdowns, lists and radio buttons, and can flatten the answers into the page.

**Works offline:** a service worker (`sw.js`) keeps the site and every tool library on the device after first use; "Save tools for offline use" (in the footer of the home page) fetches them all at once. Text recognition works offline once it has been used online for that language. The app can be installed (`manifest.webmanifest`), and the installed app can open PDFs from your files.

**Downloads:** browsers only let a page start a download by itself for a few seconds after your last click. When a job takes longer (PDF to PowerPoint on a long PDF, a big batch), Nebula doesn't try and get silently blocked: the result panel's Download button asks for that one click.

Drop any file anywhere on the home page and Nebula suggests the tools that fit. After a tool finishes, its result can go straight into the next tool. Press `⌘K`, `Ctrl+K` or `/` to search tools from anywhere.

### PDF to Word and PDF to Excel

Both read each page's layout, not just its text (`analyzePage` in `assets/engine.js`):

* **Words** keep their font (mapped to the nearest Word font), size, bold, italic and colour (sampled from the rendered page).
* **Pictures** are found from the PDF's drawing operations; **drawings** (charts, diagrams, logos) are found as regions of ink in a picture of the page with the text left out, and keep their axis labels.
* **Tables** are found from text that lines up in columns, and wrapped cell text is folded back into its row.
* **Two-column pages** are read left column first.
* **Scanned pages** are read with OCR (optional, nine languages).

PDF to Word has two layouts:

* **Exact** (default): every page becomes a Word page of the same size. The page's graphics sit behind as one picture whose paper is see-through, so it suits Word's light and dark modes, and every line of text is an editable text box at its exact place, in its original font, size and colour. Text boxes (not Word's older "frames") so that Pages, LibreOffice and Google Docs place them correctly too; checked in Microsoft Word and Pages.
* **Flowing**: real paragraphs (lines joined, hyphenated words mended, alignment and indents kept), headings as Word heading styles, real Word tables, and pictures in reading order, side by side where they were. Best when you'll rewrite the text.

PDF to Excel puts tables into real columns and turns `1,200`, `(3.50)`, `$12` and `15%` into numbers with matching number formats, one sheet per page or all on one sheet.

**Not included**, because they need a server or a rendering engine the browser doesn't have: PowerPoint to PDF, HTML/URL to PDF, PDF/A conversion and PDF compare.

**Known limits:** image-based compression, Repair's fallback and Redact turn the affected pages into images. Rotated (vertical) text in PDF to Word stays part of the page picture in Exact layout and is left out of Flowing layout. Text written by Edit PDF, page numbers and watermarks uses the standard PDF fonts (Helvetica, Times, Courier), so it supports Latin characters only, and edited lines take the closest of those fonts rather than the original.

## 🤖 AI tools

Every text AI tool has a switch at the top: **On this device** (the default) or **Claude (cloud)**. The choice is remembered.

**On this device:** [Qwen 3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B) (Apache-2.0) runs in the browser with [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0) on the GPU. It needs WebGPU (desktop Chrome or Edge, or Safari 26), downloads about 1.1 GB the first time and then works offline. Its reading window is small, so long documents are read in parts: summaries are made part by part and then combined, chat answers from the passages that best match the question, and quizzes are written from samples across the document. When it can't read everything, the tool says so. OCR on the device uses Tesseract, and the tool finder matches your words against the tools.

**Claude (cloud):** the document's text (for OCR, the images) goes to `api/ai.js`, a Vercel function that asks Anthropic's Claude (`claude-opus-5-5`, with server-side fallback models) and streams the answer back. Nothing is stored by Nebula. The privacy readout shows how much was sent.

The image AI tools always run on the device with [transformers.js](https://huggingface.co/docs/transformers.js) (Apache-2.0): Remove background uses ormbg (Apache-2.0, 88 MB with a GPU, 44 MB without), the upscaler uses Swin2SR real-world 4× (Apache-2.0, 54 MB with a GPU, 19 MB without; 2× is its result scaled down, 8× is it scaled up smoothly). The image enhancer is classic image processing, no model.

### Setting up Claude (for the site owner)

1. In the [Anthropic Console](https://console.anthropic.com/), create an API key, and set a monthly spend limit under Billing → Limits.
2. In Vercel → your project → Settings → Environment Variables, add `ANTHROPIC_API_KEY` with that key, then redeploy.
   Until the key is there, the Claude option in each AI tool shows “Coming soon” and the tools run on the device. It switches on by itself once the key is set.
3. Optional: `ALLOWED_ORIGINS` (comma-separated) if the site is served from a domain other than `nebula-pdf.vercel.app`.

Without the key the site works as before and the Claude switch says it isn't set up. The endpoint only runs Nebula's fixed tasks (it can't be used as a general chatbot), only answers the site's own pages, limits each visitor to 40 requests per 10 minutes, and caps document size (about 300,000 characters, or 8 images). Claude Opus 5.5 costs $4 per million input tokens and $20 per million output tokens; a summary of a 20-page PDF is roughly 10,000 tokens in and 1,000 to 3,000 out (Claude's thinking counts as output), about 6 to 10 cents.

## 🎨 Design: "Deep Field"

Named after long-exposure space photographs. Dark by default with a light theme (the sun/moon button; the new theme grows as a circle from the button). The choice is remembered and applied before first paint.

* **Colour:** near-black space (`#05060A`) with the Hubble palette as accents: sulphur gold `#FFB547`, hydrogen rose `#FF5A6E`, oxygen teal `#2FE0D0`. In light mode the hero stays a night scene, set into the page as a rounded panel, and the nav turns to dark glass while it floats over it.
* **Type:** Instrument Serif for the headlines, Instrument Sans (its sister face) for text and controls, Geist Mono for file details. The scrolling format strip uses Anybody.
* **Icons:** Phosphor duotone, inlined in `assets/icons.js`; the soft layer takes the accent colour.
* **Hero:** a canvas night sky. Stars bend around the pointer like light around a mass, pages orbit the drop well and spiral into it while a file is dragged over the window, and the headline's letters lean and warm as the pointer passes.
* **Blueprint frame** (inspired by getartcraft.com): hairline rails at the content edges, ruled section bars ("01 / The tools") with crosshair marks, a full-width ruled nav with an inverted active item, a scroll ruler with a percentage and a section index on wide screens, and thin coloured orbit arcs in the hero.
* **Tool cards:** hairline cells, each with a numbered badge in its group's colour, the group name, format tags (PDF → DOCX, Batch, OCR) and an "Open tool" row; the four most used tools have larger cells with an illustration panel. Squared buttons and chips with small uppercase monospace labels.
* **Surfaces:** a light that follows the pointer over the cards, small tight shadows, ripples on buttons, and a custom cursor (a dot plus a trailing ring that grows over controls, shows "Open"/"Drop" over drop zones and becomes a crosshair over pages you draw on).
* **Motion** switches off with the system's reduce-motion setting, or with **Pause motion** in the footer.

## 🛠️ Press Components

Plain HTML, CSS and JavaScript, no build step:

| File | What's in it |
|---|---|
| `index.html` | The home page: the tools |
| `privacy.html`, `about.html` | The Privacy and About pages, served at `/privacy` and `/about` (`cleanUrls` in `vercel.json`) |
| `assets/nebula.css` | Design tokens (both themes) and every component |
| `assets/shell.js` | Shared by every page: theme, motion switch, cursor, button ripples, scroll reveals |
| `assets/app.js` | Home page: hero sky, tool grid, search, file routing and the tool screen |
| `assets/engine.js` | Library loading, PDF helpers, layout analysis, the Word/Excel writers and the 25 PDF tools |
| `assets/tools-image.js` | PDF metadata tools and the image tools |
| `assets/tools-ai.js` | The AI tools and the on-device / Claude switch |
| `api/ai.js` | The Claude endpoint (Vercel function; `package.json`, `vercel.json`) |
| `assets/icons.js` | The icons |
| `sw.js`, `manifest.webmanifest`, `assets/app-icons/` | Offline use and installing as an app |

Libraries load from CDNs on demand:

* **Editing PDFs:** [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (pdf-lib fork with encryption)
* **Rendering and text extraction:** [PDF.js](https://mozilla.github.io/pdf.js/)
* **Creating PDFs:** [jsPDF](https://github.com/parallax/jsPDF) + jsPDF-AutoTable
* **Word:** [Mammoth.js](https://github.com/mwilliamson/mammoth.js) (Word to PDF); PDF to Word writes .docx itself with [JSZip](https://stuk.github.io/jszip/)
* **Spreadsheets:** [SheetJS](https://sheetjs.com/)
* **Slides:** [PptxGenJS](https://gitbrent.github.io/PptxGenJS/)
* **OCR:** [Tesseract.js](https://tesseract.projectnaptha.com/)
* **HEIC photos:** [heic2any](https://github.com/alexcorvi/heic2any) (only when the browser can't open HEIC itself)
* **On-device AI:** [WebLLM](https://github.com/mlc-ai/web-llm) and [transformers.js](https://huggingface.co/docs/transformers.js)

Open the app with `?selftest` to run the parser checks (page ranges, spreadsheet numbers) in the console.

## 🚀 Run it locally

Nebula is static files plus one optional serverless function (`api/ai.js`) for the Claude switch. Everything else needs no Node.js, database or build step.

1. **Clone the repository:**

```bash
git clone https://github.com/ErinOP-gltich/NebulaPDF.git
cd NebulaPDF
```

2. **Serve the folder** with any static server (opening `index.html` straight from disk blocks some browser features):

```bash
python3 -m http.server 8000
```

   To try the Claude switch locally, run `npm install` and `vercel dev` with `ANTHROPIC_API_KEY` set instead.

   Or, in VS Code, install the **Live Server** extension, right-click `index.html` and choose "Open with Live Server".

3. **Open** `http://localhost:8000`.

## 🚢 Deploying

The live site is deployed from the `main` branch of this repository. When you change a file in `assets/`, bump the `?v=` number on its links in `index.html`, `privacy.html` and `about.html` in the same commit (these files are cached for a year), so visitors' browsers load the new version instead of a cached one.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome on the [issues page](https://github.com/ErinOP-gltich/NebulaPDF/issues).

1. Fork the project
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add an amazing feature'`)
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a pull request

## 📄 License

Distributed under the MIT License.

---

*Crafted with ❤️ by Aman.*

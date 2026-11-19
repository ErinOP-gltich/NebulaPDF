# NebulaPDF

[![Deploy with Vercel](https://vercelbadge.vercel.app/api/aman/nebula-pdf)](https://nebula-pdf.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-16140F.svg)](https://opensource.org/licenses/MIT)
[![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-0B7FA8.svg)]()

**Zero uploads. Zero servers.**

NebulaPDF is a suite of 24 PDF tools that runs entirely in your browser. Your documents are processed on your device; no file is ever uploaded. Each tool loads the open-source library it needs the first time you use it.

🌍 **Live Output:** [nebula-pdf.vercel.app](https://nebula-pdf.vercel.app)

---

## ✨ Tools

| Group | Tools |
|---|---|
| Organize | Merge PDFs, Split PDF, Remove pages, Organize pages (reorder, turn, delete), Rotate PDF |
| Optimize | Compress PDF (lossless or image-based), Repair PDF, Read text (OCR, images and scanned PDFs) |
| Convert to PDF | Images to PDF, Word to PDF, Excel to PDF, Text to PDF |
| Convert from PDF | PDF to images (JPG/PNG), PDF to Word, PDF to PowerPoint, PDF to Excel |
| Edit & sign | Sign PDF, Add text, Add page numbers, Add watermark, Crop PDF, Redact PDF |
| Security | Protect PDF (AES-256), Unlock PDF |

Drop any file anywhere on the home page and NebulaPDF suggests the tools that fit. After a tool finishes, its result can go straight into the next tool. Press `⌘K`, `Ctrl+K` or `/` to search tools from anywhere.

### PDF to Word and PDF to Excel

Both read each page's layout, not just its text (`analyzePage` in `assets/engine.js`):

* **Words** keep their font (mapped to the nearest Word font), size, bold, italic and colour (sampled from the rendered page).
* **Pictures** are found from the PDF's drawing operations; **drawings** (charts, diagrams, logos) are found as regions of ink in a picture of the page with the text left out, and keep their axis labels.
* **Tables** are found from text that lines up in columns, and wrapped cell text is folded back into its row.
* **Two-column pages** are read left column first.
* **Scanned pages** are read with OCR (optional, nine languages).

PDF to Word has two layouts:

* **Exact** (default): every page becomes a Word page of the same size. The page's graphics sit behind as one picture whose paper is see-through, so it suits Word's light and dark modes, and every line of text is an editable, positioned paragraph in its original font, size and colour.
* **Flowing**: real paragraphs (lines joined, hyphenated words mended, alignment and indents kept), headings as Word heading styles, real Word tables, and pictures in reading order, side by side where they were. Best when you'll rewrite the text.

PDF to Excel puts tables into real columns and turns `1,200`, `(3.50)`, `$12` and `15%` into numbers with matching number formats, one sheet per page or all on one sheet.

**Not included**, because they need a server or a rendering engine the browser doesn't have: PowerPoint to PDF, HTML/URL to PDF, PDF/A conversion, PDF compare, and AI translate/summarize.

**Known limits:** image-based compression, Repair's fallback and Redact turn the affected pages into images. Rotated (vertical) text in PDF to Word stays part of the page picture in Exact layout and is left out of Flowing layout. Text added with Add text, page numbers and watermarks uses the built-in Helvetica font, so it supports Latin characters only.

## 🎨 Design: "Deep Field"

Named after long-exposure space photographs. Dark by default with a light theme (the sun/moon button; the new theme grows as a circle from the button). The choice is remembered and applied before first paint.

* **Colour:** near-black space (`#05060A`) with the Hubble palette as accents: sulphur gold `#FFB547`, hydrogen rose `#FF5A6E`, oxygen teal `#2FE0D0`. In light mode the hero stays a night scene, set into the page as a rounded panel, and the nav turns to dark glass while it floats over it.
* **Type:** Instrument Serif for the headlines, Instrument Sans (its sister face) for text and controls, Geist Mono for file details. The scrolling format strip uses Anybody.
* **Icons:** Phosphor duotone, inlined in `assets/icons.js`; the soft layer takes the accent colour.
* **Hero:** a canvas night sky. Stars bend around the pointer like light around a mass, pages orbit the drop well and spiral into it while a file is dragged over the window, and the headline's letters lean and warm as the pointer passes.
* **Surfaces:** glass cards with a light and rim that follow the pointer, small tight shadows, ripples on buttons, and a custom cursor (a dot plus a trailing ring that grows over controls, shows "Open"/"Drop" over drop zones and becomes a crosshair over pages you draw on).
* **Motion** switches off with the system's reduce-motion setting, or with **Pause motion** in the footer.

## 🛠️ Press Components

Plain HTML, CSS and JavaScript, no build step:

| File | What's in it |
|---|---|
| `index.html` | The page |
| `assets/nebula.css` | Design tokens (both themes) and every component |
| `assets/app.js` | Theme, cursor, hero sky, tool grid, search, file routing and the tool screen |
| `assets/engine.js` | Library loading, PDF helpers, layout analysis, the Word/Excel writers and the 24 tools |
| `assets/icons.js` | The icons |

Libraries load from CDNs on demand:

* **Editing PDFs:** [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (pdf-lib fork with encryption)
* **Rendering and text extraction:** [PDF.js](https://mozilla.github.io/pdf.js/)
* **Creating PDFs:** [jsPDF](https://github.com/parallax/jsPDF) + jsPDF-AutoTable
* **Word:** [Mammoth.js](https://github.com/mwilliamson/mammoth.js) (Word to PDF); PDF to Word writes .docx itself with [JSZip](https://stuk.github.io/jszip/)
* **Spreadsheets:** [SheetJS](https://sheetjs.com/)
* **Slides:** [PptxGenJS](https://gitbrent.github.io/PptxGenJS/)
* **OCR:** [Tesseract.js](https://tesseract.projectnaptha.com/)

Open the app with `?selftest` to run the parser checks (page ranges, spreadsheet numbers) in the console.

## 🚀 Run it locally

NebulaPDF is static files only: no Node.js, database or build step.

1. **Clone the repository:**

```bash
git clone https://github.com/ErinOP-gltich/NebulaPDF.git
cd NebulaPDF
```

2. **Serve the folder** with any static server (opening `index.html` straight from disk blocks some browser features):

```bash
python3 -m http.server 8000
```

   Or, in VS Code, install the **Live Server** extension, right-click `index.html` and choose "Open with Live Server".

3. **Open** `http://localhost:8000`.

## 🚢 Deploying

The live site is deployed from the `main` branch of this repository. When you change a file in `assets/`, bump the `?v=` number on its link in `index.html` in the same commit, so visitors' browsers load the new version instead of a cached one.

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

# 🖨️ NebulaPDF: Press & Bindery

[![Deploy with Vercel](https://vercelbadge.vercel.app/api/aman/nebula-pdf)](https://nebula-pdf.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-16140F.svg)](https://opensource.org/licenses/MIT)
[![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-0B7FA8.svg)]()

**SYSTEM_STATUS: ONLINE. Zero uploads. Zero servers.**

NebulaPDF is a brutalist, print-shop-inspired suite of professional PDF tools that runs entirely in your browser. Engineered for absolute privacy, your documents are processed locally via a WebAssembly engine. No temporary files stored on external servers. Data never leaves your machine.

🌍 **Live Output:** [nebula-pdf.vercel.app](https://nebula-pdf.vercel.app)

---

## ✨ Press Capabilities

* **🔒 Absolute Privacy:** 100% client-side processing. Your files never touch a server.
* **👁️ Optical Reg (OCR):** Scan and extract text plates from raster images utilizing local ML (Tesseract.js).
* **✂️ Page Extractor:** Separate signatures. Pull specific page ranges from a master document to create a new file.
* **🔄 Orientation Fix:** Correct feed errors. Batch rotate all sheets in a document (90°, 180°, 270°).
* **📚 Bindery (Merge):** Stitch multiple files together. Sequence determines output order.
* **🖨️ Universal Press:** Plate generation. Convert Word (`.docx`), raw code logs, and image assets into PDF format.
* **⌨️ Direct Typeset:** Raw input interface to paste notes or code directly into the browser to typeset a clean document.

## 🛠️ Press Components

Built with a utilitarian focus on speed and local execution:

* **Canvas / Interface:** HTML5, [Tailwind CSS](https://tailwindcss.com/) (Space Grotesk & IBM Plex Mono)
* **Engine (PDF Ops):** [pdf-lib](https://pdf-lib.js.org/)
* **Typesetter (Generation):** [jsPDF](https://raw.githack.com/MrRio/jsPDF/master/docs/index.html)
* **Parser (DOCX):** [Mammoth.js](https://github.com/mwilliamson/mammoth.js)
* **Scanner (OCR):** [Tesseract.js](https://tesseract.projectnaptha.com/) (WASM)

## 🚀 Initialization (Local Development)

Because NebulaPDF is a purely static, client-side application, getting it running locally is incredibly simple. You don't need Node.js, databases, or build steps.

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/yourusername/nebula-pdf.git](https://github.com/yourusername/nebula-pdf.git)
   cd nebula-pdf
   
2. **Serve the files:**
   You just need a local web server to serve the `index.html` file (to avoid CORS issues with local file loading). You can use any static server. 
   
   Using Python:
```bash
   python3 -m http.server 8000

```

Using VS Code:

* Install the **Live Server** extension.
* Right-click `index.html` and select "Open with Live Server".

3. **Open in browser:**
Navigate to `http://localhost:8000`

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/yourusername/nebula-pdf/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

*Crafted with ❤️ by Aman.*

```

```

# 🌌 NebulaPDF

[![Deploy with Vercel](https://vercelbadge.vercel.app/api/aman/nebula-pdf)](https://nebula-pdf.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](https://opensource.org/licenses/MIT)
[![Client-Side](https://img.shields.io/badge/Architecture-100%25%20Client--Side-10b981.svg)]()

**Next-Gen Document Tools. Zero uploads. Zero servers.**

NebulaPDF is a modern, lightning-fast suite of professional PDF tools that runs entirely in your browser. Engineered for privacy and speed, your sensitive documents never leave your device. 

🌍 **Live Demo:** [nebula-pdf.vercel.app](https://nebula-pdf.vercel.app)

---

## ✨ Features

* **🔒 Privacy First:** 100% client-side processing using WebAssembly. No backend, no databases, no data harvesting.
* **👁️ AI Text Extraction (OCR):** Extract text from scanned documents and images using local machine learning (Tesseract.js).
* **📑 Universal Converter:** Seamlessly convert Word docs (`.docx`), Markdown, Code files, and Images into clean PDFs.
* **✂️ Extract & Split:** Pull specific pages (e.g., `1-3, 5`) out of massive PDFs to create new, optimized documents.
* **🔄 Rotate Pages:** Fix upside-down or sideways PDF files instantly.
* **🔗 Merge PDFs:** Stitch multiple PDF files together with drag-and-drop ordering.
* **📝 Quick Text-to-PDF:** A sleek, distraction-free environment to type notes or paste code and download instantly as a PDF.

## 🛠️ Tech Stack

NebulaPDF is built with modern, lightweight web technologies:

* **UI / Styling:** HTML5, [Tailwind CSS](https://tailwindcss.com/)
* **PDF Manipulation:** [pdf-lib](https://pdf-lib.js.org/)
* **PDF Generation:** [jsPDF](https://raw.githack.com/MrRio/jsPDF/master/docs/index.html)
* **DOCX Parsing:** [Mammoth.js](https://github.com/mwilliamson/mammoth.js)
* **Optical Character Recognition:** [Tesseract.js](https://tesseract.projectnaptha.com/) (WebAssembly port)
* **Icons:** FontAwesome

## 🚀 Getting Started (Local Development)

Because NebulaPDF is a purely static, client-side application, getting it running locally is incredibly simple. You don't need Node.js, databases, or build steps.

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/yourusername/nebula-pdf.git](https://github.com/yourusername/nebula-pdf.git)
   cd nebula-pdf

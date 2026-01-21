# UniConvert - Magic Document Converter

UniConvert is a lightweight, high-performance web-based tool designed to handle seamless conversions between **Word (.docx)**, **PDF**, and **Markdown** formats. Built with a focus on privacy and speed, all conversions happen entirely within your browser—your files never touch a server.

## 🚀 Key Features

- **Bidirectional Conversion**: Convert Word/PDF to Markdown and vice versa.
- **Local Processing**: Privacy-first architecture. All processing is done client-side.
- **Image Extraction**: Automatically extracts and handles images during conversion.
- **Live Preview**: Real-time Markdown rendering with scroll synchronization.
- **Modern UI**: Clean, responsive interface with drag-and-drop support.
- **Auto-Save**: Never lose your progress with local storage synchronization.

## 🛠️ Tech Stack

- **Framework**: [React 19](https://react.dev/) + [Vite](https://vitejs.dev/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Core Libraries**:
  - `mammoth.js`: Word to HTML conversion.
  - `turndown`: HTML to Markdown conversion.
  - `html-docx-js-typescript`: Markdown/HTML to Word conversion.
  - `pdfjs-dist`: PDF text and image extraction.
  - `marked`: High-speed Markdown parsing.

## 📥 Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18.0.0 or higher)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/uniconvert.git
   cd uniconvert
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   ```

## 📖 Usage Guide

1. **Upload**: Drag and drop a `.docx`, `.pdf`, or `.md` file into the upload zone, or click to select a file.
2. **Edit**: Once converted, you can edit the Markdown source in the left panel.
3. **Preview**: View the real-time rendered output in the right panel. Use the "Link" icon to toggle scroll synchronization.
4. **Export**: Use the header buttons to export your document as Word, Markdown, or print it as a PDF.

## 💝 Donation

If this project has saved you time or made your work easier, please consider supporting its development. Your voluntary contributions help keep the project maintained and updated!

| WeChat Pay | Alipay |
| :---: | :---: |
| <img src="./donate/wechat_qr.png" width="200" alt="WeChat Pay"/> | <img src="./donate/alipay_qr.png" width="200" alt="Alipay"/> |

*Thank you for your support!*

## 🤝 Contribution

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

## 📞 Support

If you encounter any issues or have questions, feel free to:
- Open an [Issue](https://github.com/your-username/uniconvert/issues)
- Reach out via GitHub Discussions

---
*Created with ❤️ for the open-source community.*

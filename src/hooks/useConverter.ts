import { useState, useEffect, useRef } from 'react';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { asBlob } from 'html-docx-js-typescript';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';

export type ConversionType = 'md-to-docx' | 'docx-to-md' | 'md-to-pdf';

// Initialize Turndown service with better configuration
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
});

// Remove non-content elements that might leak into the output
turndownService.remove(['style', 'script', 'head', 'meta', 'title']);

// Configure Turndown to ensure images are displayed correctly in preview
turndownService.addRule('images', {
    filter: 'img',
    replacement: function (_content, node) {
        const img = node as HTMLImageElement;
        const alt = img.alt || 'image';
        const src = img.getAttribute('src') || '';
        // Use standard Markdown image syntax so preview renders the image directly
        return `![${alt}](${src})`;
    }
});

export interface ExtractedImage {
    src: string;
    alt: string;
    title: string;
    id: string;
}

// Helper to decode Quoted-Printable encoding often found in MHT/Word HTML
function decodeQuotedPrintable(str: string): string {
    return str
        .replace(/=[\r\n]+/g, '') // Soft line breaks
        .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function useConverter() {
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversionLog, setConversionLog] = useState<string[]>([]);
  const [extractedImages, setExtractedImages] = useState<ExtractedImage[]>([]);
  
  // Track active Blob URLs to prevent memory leaks and premature revocation
  const activeUrlsRef = useRef<string[]>([]);

  // Cleanup Blob URLs on unmount only
  useEffect(() => {
    return () => {
      activeUrlsRef.current.forEach(url => {
        URL.revokeObjectURL(url);
      });
      activeUrlsRef.current = [];
    };
  }, []);

  // Helper to register a new Blob URL
  const registerBlobUrl = (url: string) => {
      activeUrlsRef.current.push(url);
      return url;
  };

  // Helper to clear previous Blob URLs
  const clearBlobUrls = () => {
      activeUrlsRef.current.forEach(url => {
          URL.revokeObjectURL(url);
      });
      activeUrlsRef.current = [];
  };

  const addLog = (msg: string) => {
      console.log(msg);
      setConversionLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const convertDocxToMd = async (file: File): Promise<string> => {
    setIsConverting(true);
    setError(null);
    setConversionLog([]); // Clear log on new conversion
    setExtractedImages([]); // Clear images state
    clearBlobUrls(); // Revoke old URLs
    addLog(`Starting conversion for: ${file.name}`);
    
    // Temporary storage for images during this conversion
    const currentImages: ExtractedImage[] = [];
    let imagesCommitted = false; 

    try {
      const arrayBuffer = await file.arrayBuffer();
      
      // Configure mammoth options
      const options: { styleMap: string[]; convertImage?: ReturnType<typeof mammoth.images.imgElement>; ignoreEmptyParagraphs?: boolean } = {
        // Custom style map to handle common Word styles
        styleMap: [
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='Heading 5'] => h5:fresh",
            "p[style-name='Heading 6'] => h6:fresh",
            "b => strong",
            "i => em",
            "u => u",
            "strike => del",
            "comment-reference => sup"
        ],
        ignoreEmptyParagraphs: false
      };
      
      // Try to handle images
      try {
          let imgCounter = 0;
          options.convertImage = mammoth.images.imgElement(function(image: { read: (encoding: string) => Promise<string>; contentType: string }) {
            return image.read("base64").then(function(imageBuffer: string) {
                try {
                    // Convert base64 to Blob to URL
                    const binaryString = window.atob(imageBuffer);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: image.contentType });
                    const url = URL.createObjectURL(blob);
                    registerBlobUrl(url); // Register
                    
                    imgCounter++;
                    const fileName = `image_${imgCounter}.${image.contentType.split('/')[1] || 'png'}`;
                    
                    addLog(`Processed image: ${fileName}`);
                    
                    const imgData = {
                        src: url,
                        alt: fileName,
                        title: fileName,
                        id: `img_${Date.now()}_${imgCounter}`
                    };
                    currentImages.push(imgData);

                    return {
                        src: url,
                        alt: fileName,
                        title: fileName // Use title to pass filename to turndown
                    };
                } catch (e) {
                    console.error("Image conversion error:", e);
                    // Fallback to base64 if blob fails
                    return {
                        src: "data:" + image.contentType + ";base64," + imageBuffer,
                        alt: "image_conversion_failed"
                    };
                }
            });
        });
      } catch (e) {
          addLog(`Mammoth image handler setup failed: ${e}`);
          console.warn("Mammoth image handler setup failed:", e);
      }

      console.log("Starting Mammoth conversion...");
      const result = await mammoth.convertToHtml({ arrayBuffer }, options);
      
      // Update state with collected images
      setExtractedImages(currentImages);
      imagesCommitted = true; // 标记为已提交

      
      // Log any warnings
      if (result.messages && result.messages.length > 0) {
          console.warn("Mammoth messages:", result.messages);
      }
      
      let html = result.value;
      const messages = (result.messages ?? []).map((m: { message: string }) => m.message).join('; ');
      let hasAltChunk = messages.includes("altChunk");
      
      // Fallback: if HTML is empty or very short (and we have warnings), try to extract raw text
      // This helps when the document structure is complex but text exists
      if (!html || html.trim().length < 100) {
          console.warn("Mammoth generated empty or scanty HTML, trying raw text extraction...");
          try {
            // Get a fresh buffer just in case
            const freshBuffer = await file.arrayBuffer();
            const rawResult = await mammoth.extractRawText({ arrayBuffer: freshBuffer });
            
            // Only use raw text if it actually found something significant
            if (rawResult.value && rawResult.value.trim().length > (html?.length || 0)) {
                // Use raw text, preserving basic line breaks
                 html = rawResult.value
                     .split('\n')
                     .map((line: string) => line.trim() ? `<p>${line}</p>` : '<br/>')
                     .join('');
                console.log("Raw text extraction successful, length:", html.length);
            }
          } catch (rawErr) {
             console.warn("Raw text extraction failed:", rawErr);
          }
      }

      console.log("Mammoth output HTML length:", html?.length || 0);

      // JSZip Fallback: If Mammoth failed or found altChunk with little content, try to extract embedded HTML directly
      // This specifically handles documents created by html-docx-js which use altChunk to embed HTML/MHT
      if (!html || html.trim().length === 0 || (hasAltChunk && html.trim().length < 500)) {
          console.log("Mammoth result insufficient, attempting JSZip fallback for embedded content...");
          addLog("Attempting deep scan for embedded HTML/MHT content...");
          try {
              const zip = await JSZip.loadAsync(file);
              
              // Find any HTML or MHT files in the word/ directory
              const embeddedFiles = Object.keys(zip.files).filter(path => 
                  path.startsWith('word/') && (path.endsWith('.html') || path.endsWith('.htm') || path.endsWith('.mht'))
              );

              // Extract images from word/media/ if any (for fixing broken paths)
              const mediaFiles = Object.keys(zip.files).filter(path => path.startsWith('word/media/'));
              const mediaMap: Record<string, string> = {};
              
              if (mediaFiles.length > 0) {
                  addLog(`Found ${mediaFiles.length} media files in package`);
                  for (const mediaPath of mediaFiles) {
                      try {
                          const blob = await zip.file(mediaPath)?.async('blob');
                          if (blob) {
                              const url = URL.createObjectURL(blob);
                              registerBlobUrl(url);
                              const fileName = mediaPath.split('/').pop();
                              if (fileName) {
                                  mediaMap[fileName] = url;
                              }
                          }
                      } catch (e) {
                          console.warn("Failed to extract media:", mediaPath, e);
                      }
                  }
              }
              
              if (embeddedFiles.length > 0) {
                  addLog(`Found embedded content files: ${embeddedFiles.join(', ')}`);
                  // Try the first found file
                  const targetFile = embeddedFiles[0];
                  let rawContent = await zip.file(targetFile)?.async("string") || "";
                  
                  if (rawContent) {
                      // Apply Quoted-Printable decoding if necessary (common in MHT or Word HTML)
                      // This fixes issues like '3D"https...' where '=' became '=3D'
                      if (rawContent.includes('=3D') || rawContent.includes('=\r\n')) {
                          try {
                              rawContent = decodeQuotedPrintable(rawContent);
                              addLog("Applied Quoted-Printable decoding");
                          } catch (e) {
                              console.warn("QP decoding failed", e);
                          }
                      }

                      // Attempt to fix broken image paths by mapping to extracted media
                      if (mediaFiles.length > 0) {
                          // Replace src="..." with blob URLs if filename matches
                          rawContent = rawContent.replace(/(<img[^>]+src=["'])([^"']*)(["'][^>]*>)/gi, (match, prefix, src, suffix) => {
                              if (src.startsWith('data:') || src.startsWith('http')) return match;
                              
                              // Extract potential filename from path (e.g. file:///C:/fake/image0.png -> image0.png)
                              const possibleName = src.split(/[/\\]/).pop();
                              if (possibleName && mediaMap[possibleName]) {
                                  addLog(`Fixed broken image path: ${src} -> ${possibleName}`);
                                  return `${prefix}${mediaMap[possibleName]}${suffix}`;
                              }
                              return match;
                          });
                      }

                      // If it's MHT, we need to extract images and the HTML part properly.
                      // html-docx-js and similar tools embed MHT with images as MIME parts.
                      if (targetFile.endsWith('.mht') || rawContent.includes('Content-Type: multipart/related')) {
                           addLog("Detected MHT format, parsing MIME parts...");
                           try {
                               // 1. Find boundary
                               const boundaryMatch = rawContent.match(/boundary="?([^"]+)"?/i);
                               if (boundaryMatch) {
                                   const boundary = boundaryMatch[1];
                                   const parts = rawContent.split(new RegExp(`--${boundary}(?:--)?`));
                                   
                                   let htmlPart = "";
                                   const mhtImages: Record<string, string> = {};
                                   
                                   parts.forEach(part => {
                                       const [rawHeaders, ...bodyParts] = part.split(/\r?\n\r?\n/);
                                       const body = bodyParts.join('\n\n'); 
                                       if (!body.trim()) return;

                                       const headers: Record<string, string> = {};
                                       rawHeaders.split(/\r?\n/).forEach(h => {
                                           const colonIndex = h.indexOf(':');
                                           if (colonIndex > -1) {
                                               const k = h.substring(0, colonIndex).trim().toLowerCase();
                                               const v = h.substring(colonIndex + 1).trim();
                                               if (k && v) headers[k] = v;
                                           }
                                       });
                                       
                                       const contentType = headers['content-type'] || '';
                                       const contentLocation = headers['content-location'] || '';
                                       const transferEncoding = headers['content-transfer-encoding'] || '';

                                       if (contentType.includes('text/html')) {
                                           htmlPart = body;
                                           if (transferEncoding.includes('quoted-printable')) {
                                               htmlPart = decodeQuotedPrintable(htmlPart);
                                           }
                                       } else if (contentType.includes('image/')) {
                                           if (contentLocation && body.trim()) {
                                               const base64 = body.replace(/\s/g, '');
                                               try {
                                                   const byteCharacters = atob(base64);
                                                   const byteNumbers = new Array(byteCharacters.length);
                                                   for (let i = 0; i < byteCharacters.length; i++) {
                                                       byteNumbers[i] = byteCharacters.charCodeAt(i);
                                                   }
                                                   const byteArray = new Uint8Array(byteNumbers);
                                                   const blob = new Blob([byteArray], {type: contentType});
                                                   const url = URL.createObjectURL(blob);
                                                   registerBlobUrl(url);
                                                   mhtImages[contentLocation] = url;
                                                   // Also map by filename if possible
                                                   const fileName = contentLocation.split(/[/\\]/).pop();
                                                   if (fileName) mhtImages[fileName] = url;
                                               } catch (e) {
                                                   console.warn('Failed to process MHT image part', e);
                                               }
                                           }
                                       }
                                   });
                                   
                                   if (htmlPart) {
                                       rawContent = htmlPart;
                                       // Replace images in HTML
                                       for (const [loc, url] of Object.entries(mhtImages)) {
                                           // 1. Try exact match
                                           rawContent = rawContent.split(loc).join(url);
                                           // 2. Try match by filename in file:/// paths
                                           // If loc is "file:///C:/fake/image0.png", we already mapped it.
                                           // But if mhtImages key is "image0.png", we need to replace src="...image0.png"
                                           // But careful not to break other things.
                                           // The regex replacement below (mediaMap) handles the filename matching logic better.
                                           // So we just merge mhtImages into mediaMap!
                                           const fileName = loc.split(/[/\\]/).pop();
                                           if (fileName) {
                                                mediaMap[fileName] = url;
                                           }
                                       }
                                       addLog(`Parsed MHT: found ${Object.keys(mhtImages).length} images`);
                                   }
                               }
                           } catch (mhtErr) {
                               console.warn("MHT parsing failed:", mhtErr);
                           }
                      }
 
                      // Re-run the broken path fixer with updated mediaMap (including MHT images)
                      if (Object.keys(mediaMap).length > 0) {
                          rawContent = rawContent.replace(/(<img[^>]+src=["'])([^"']*)(["'][^>]*>)/gi, (match, prefix, src, suffix) => {
                              if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http')) return match;
                              const possibleName = src.split(/[/\\]/).pop();
                              if (possibleName && mediaMap[possibleName]) {
                                  return `${prefix}${mediaMap[possibleName]}${suffix}`;
                              }
                              return match;
                          });
                      }

                      // If it's MHT, we need to extract the HTML part. 
                      // MHT is a MIME format. A simple heuristic is to look for <html ... </html>
                      if (targetFile.endsWith('.mht')) {
                          const htmlStart = rawContent.indexOf('<html');
                          const htmlEnd = rawContent.lastIndexOf('</html>');
                          if (htmlStart !== -1 && htmlEnd !== -1) {
                              rawContent = rawContent.substring(htmlStart, htmlEnd + 7);
                              addLog("Extracted HTML from MHT container");
                          }
                      }
                      
                      if (rawContent.length > 100) {
                          html = rawContent;
                          addLog(`Successfully recovered ${html.length} characters of content via deep scan`);
                          // Clear the altChunk warning since we handled it
                          hasAltChunk = false; 
                      }
                  }
              } else {
                  addLog("No embedded HTML files found in document structure");
              }
          } catch (zipErr) {
              console.warn("JSZip fallback failed:", zipErr);
              addLog(`Deep scan failed: ${zipErr}`);
          }
      }

      // Check if we actually got content
      if (!html || html.trim().length === 0) {
          if (hasAltChunk) {
              return `> ⚠️ **转换警告**\n>\n> 该文档包含不兼容的内容格式 (altChunk)，且无法提取任何文本。\n> 这通常是因为文档是由其他程序生成，或包含嵌入的 HTML 内容。\n>\n> **建议解决方案**：\n> 1. 用 Word 打开该文档\n> 2. 选择 "另存为" (Save As)\n> 3. 确保格式选择 "Word 文档 (*.docx)"\n> 4. 上传新的文档`;
          }
          return "> ⚠️ **转换失败**\n>\n> 无法从文档中提取任何内容。";
      }

      // Convert HTML to Markdown using Turndown
      let markdown = turndownService.turndown(html);
      
      // If we have content but also had altChunk warnings, prepend a notice
      if (hasAltChunk && markdown.length > 0) {
          markdown = `> ⚠️ **转换警告**\n> 检测到文档包含不兼容格式 (altChunk)，部分排版或内容可能丢失。\n\n---\n\n${markdown}`;
      }
      
      return markdown;
    } catch (err) {
      // 4. 新增：如果转换失败且图片未提交，手动清理
      if (!imagesCommitted) {
          currentImages.forEach(img => {
              if (img.src.startsWith('blob:')) {
                  URL.revokeObjectURL(img.src);
              }
          });
      }
      setError('Failed to convert DOCX to MD');
      console.error(err);
      throw err;
    } finally {
      setIsConverting(false);
    }
  };

  const convertMdToDocx = async (markdown: string): Promise<Blob> => {
    setIsConverting(true);
    setError(null);
    try {
      const html = await parseMarkdown(markdown);

      const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.6} img {max-width: 100%;}</style></head><body>${html}</body></html>`;
      // html-docx-js supports images if they are base64 or public URLs
      const blob = await asBlob(fullHtml);
      return blob as Blob;
    } catch (err) {
      setError('Failed to convert MD to DOCX');
      throw err;
    } finally {
      setIsConverting(false);
    }
  };

  const convertPdfToMd = async (file: File): Promise<string> => {
    setIsConverting(true);
    setError(null);
    setConversionLog([]);
    setExtractedImages([]); // Clear previous images
    clearBlobUrls(); // Revoke old URLs
    
    // Storage for all images across all pages
    const allExtractedImages: ExtractedImage[] = [];
    
    try {
      GlobalWorkerOptions.workerSrc = pdfWorker;

      const data = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocument({ data }).promise;

      const parts: string[] = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.0 });
        const pageHeight = viewport.height;
        
        // 1. Get Text Content
        const content = await page.getTextContent();
        const items = content.items as Array<{ str: string; transform: number[]; height?: number; width?: number }>;
        
        // --- Header/Footer Filter Configuration ---
        // Expand safety zone but apply smart filtering
        const HEADER_HEIGHT = 70; // Top 70px (High risk zone)
        const FOOTER_HEIGHT = 70; // Bottom 70px (High risk zone)
        const IGNORE_PATTERNS = [
             /about:blank/i, 
             /^\d+\s*\/\s*\d+$/, // "1 / 10"
             // /^\d+$/, // "1"  <-- Removed: Too aggressive, kills single digit titles/headers
             /^\(\d+\)$/, // "(1)"
             /^\s*Page\s*\d+/i, // "Page 1"
             /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/, // Date "2026/1/20"
             /(www\.|http:|https:)\S+/, // URL
             /\.com$/i, // Domain ending
         ];

        // 1.1 Calculate Base Font Size First (for smart filtering)
        const fontSizes: Record<number, number> = {};
        items.forEach(item => {
             const h = item.height || item.transform[3] || 10;
             const rounded = Math.round(h);
             fontSizes[rounded] = (fontSizes[rounded] || 0) + item.str.length;
        });
        
        let baseFontSize = 0;
        let maxCount = 0;
        for (const size in fontSizes) {
            if (fontSizes[size] > maxCount) {
                maxCount = fontSizes[size];
                baseFontSize = Number(size);
            }
        }
        if (baseFontSize === 0) baseFontSize = 10;

        // 2. Extract Images via OperatorList
        const ops = await page.getOperatorList();
        const imageInfos: { y: number; id: string; w: number; h: number }[] = [];
        const pageImages: ExtractedImage[] = []; // Images for this page only
        
        // Matrix multiplication helper
        const multiply = (m1: number[], m2: number[]) => {
            return [
                m1[0] * m2[0] + m1[1] * m2[2],
                m1[0] * m2[1] + m1[1] * m2[3],
                m1[2] * m2[0] + m1[3] * m2[2],
                m1[2] * m2[1] + m1[3] * m2[3],
                m1[4] * m2[0] + m1[5] * m2[2] + m1[4],
                m1[4] * m2[1] + m1[5] * m2[3] + m1[5]
            ];
        };

        let ctm = [1, 0, 0, 1, 0, 0]; // Identity matrix
        const transformStack: number[][] = [];

        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            const args = ops.argsArray[i];

            if (fn === OPS.save) {
                transformStack.push(ctm.slice());
            } else if (fn === OPS.restore) {
                if (transformStack.length > 0) {
                    ctm = transformStack.pop()!;
                }
            } else if (fn === OPS.transform) {
                // args is [scaleX, skewY, skewX, scaleY, translateX, translateY]
                ctm = multiply(ctm, args);
            } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
                const imgName = args[0];
                
                try {
                    let img;
                    if (fn === OPS.paintImageXObject) {
                        img = await page.objs.get(imgName);
                    } else {
                        img = imgName;
                    }

                    if (img) {
                        const width = img.width;
                        const height = img.height;
                        
                        // Calculate visual position
                        // Project (0,0) and (0,1) and (1,0) to find the top-most Y in viewport coordinates
                        // PDF images are drawn in unit square [0,1]x[0,1] transformed by CTM
                        const p00 = viewport.convertToViewportPoint(ctm[4], ctm[5]);
                        const p01 = viewport.convertToViewportPoint(ctm[2] + ctm[4], ctm[3] + ctm[5]);
                        const p10 = viewport.convertToViewportPoint(ctm[0] + ctm[4], ctm[1] + ctm[5]);
                        
                        // In viewport, Y=0 is top. So we want the min Y as the "top" of the image.
                        // However, our text logic uses "transform[5]" which is PDF Y (bottom-up).
                        // To be consistent with text lines logic below:
                        // Text logic: y = item.transform[5] (PDF Y).
                        // So we should use PDF Y here too.
                        // PDF Y Max is the visual top.
                        // Let's calc PDF Y.
                        const pdfY00 = ctm[5];
                        const pdfY01 = ctm[3] + ctm[5];
                        const pdfY10 = ctm[1] + ctm[5];
                        const pdfY11 = ctm[1] + ctm[3] + ctm[5];
                        
                        // We want the Y that represents the "visual top" of this image to insert it correctly before text that follows it.
                         // PDF Y coordinate system: 0 is bottom, increasing upwards.
                         // Higher Y = Higher on page (Top).
                         // Text sorting uses item.transform[5] which is Baseline.
                         // To match text visual order, we should probably use the Top Y of the image.
                         const visualTopY = Math.max(pdfY00, pdfY01, pdfY10, pdfY11);
                         const currentY = visualTopY;
 
                         const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        if (ctx) {
                            const imageData = ctx.createImageData(width, height);
                            
                            // Check for ImageBitmap first (fastest)
                            if (img.bitmap) {
                                ctx.drawImage(img.bitmap, 0, 0);
                            } else if (img instanceof ImageBitmap || img instanceof HTMLCanvasElement || img instanceof HTMLImageElement) {
                                ctx.drawImage(img as any, 0, 0);
                            } else if (img.data) {
                                // Handle raw data based on kind (Color Space)
                                // Kind: 1=Grayscale, 2=RGB, 3=CMYK
                                const kind = img.kind || 2; 
                                const data = img.data;
                                const len = width * height;

                                if (kind === 1) { // Grayscale
                                    for (let p = 0, d = 0; p < len; p++, d += 4) {
                                        const val = data[p];
                                        imageData.data[d] = val;
                                        imageData.data[d+1] = val;
                                        imageData.data[d+2] = val;
                                        imageData.data[d+3] = 255;
                                    }
                                    ctx.putImageData(imageData, 0, 0);
                                } else if (kind === 2) { // RGB
                                    if (data.length === len * 4) { // Already RGBA
                                        imageData.data.set(data);
                                    } else if (data.length === len * 3) { // RGB -> RGBA
                                        for (let p = 0, d = 0; p < data.length; p += 3, d += 4) {
                                            imageData.data[d] = data[p];
                                            imageData.data[d+1] = data[p+1];
                                            imageData.data[d+2] = data[p+2];
                                            imageData.data[d+3] = 255;
                                        }
                                    }
                                    ctx.putImageData(imageData, 0, 0);
                                } else if (kind === 3) { // CMYK
                                    // Simple CMYK to RGB
                                    for (let p = 0, d = 0; p < data.length; p += 4, d += 4) {
                                        const c = data[p];
                                        const m = data[p+1];
                                        const y = data[p+2];
                                        const k = data[p+3];
                                        
                                        // CMYK to RGB formula
                                        const r = 255 * (1 - c / 255) * (1 - k / 255);
                                        const g = 255 * (1 - m / 255) * (1 - k / 255);
                                        const b = 255 * (1 - y / 255) * (1 - k / 255);
                                        
                                        imageData.data[d] = r;
                                        imageData.data[d+1] = g;
                                        imageData.data[d+2] = b;
                                        imageData.data[d+3] = 255;
                                    }
                                    ctx.putImageData(imageData, 0, 0);
                                } else {
                                    // Try generic fallback assuming RGBA or RGB
                                     if (data.length === len * 4) {
                                         imageData.data.set(data);
                                         ctx.putImageData(imageData, 0, 0);
                                     } else {
                                         // Last resort: Gray
                                         for (let p = 0, d = 0; p < len; p++, d += 4) {
                                             const val = data[p] || 0;
                                             imageData.data[d] = val;
                                             imageData.data[d+1] = val;
                                             imageData.data[d+2] = val;
                                             imageData.data[d+3] = 255;
                                         }
                                         ctx.putImageData(imageData, 0, 0);
                                     }
                                }
                            }

                            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
                            if (blob) {
                                const url = URL.createObjectURL(blob);
                                registerBlobUrl(url); // Register

                                // Use a unique ID based on page and index to ensure uniqueness
                                const imgId = `pdf_img_${pageNumber}_${i}`;
                                
                                pageImages.push({
                                    src: url,
                                    alt: `Image ${imgId}`,
                                    title: '',
                                    id: imgId
                                });
                                
                                imageInfos.push({
                                    y: currentY,
                                    id: imgId,
                                    w: width,
                                    h: height
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Failed to extract image', imgName, e);
                }
            }
        }
        
        allExtractedImages.push(...pageImages);

        // 3. Group Text by Line (Y coordinate)
        const lines: { y: number; type: 'text' | 'image'; items?: typeof items; imageId?: string }[] = [];
        const Y_TOLERANCE = 4;

        // Add Text Lines
        if (items.length > 0) {
             for (const item of items) {
                // Skip empty items
                if (!item.str || item.str.trim().length === 0) continue;
                
                // Use Visual Top Y for text as well to match Image sorting
                // item.transform[5] is Baseline.
                // height is approx font size.
                const fontSize = item.height || item.transform[3] || 10;
                const y = item.transform[5] + (fontSize * 0.8); // Approx Cap Height
                
                // --- Filter: Header / Footer (Smart) ---
                // PDF coordinates: 0 is bottom, height is top.
                // Footer is near 0, Header is near height.
                const isEdge = y < FOOTER_HEIGHT || y > pageHeight - HEADER_HEIGHT;
                
                if (isEdge) {
                    // Smart Filter:
                    // 1. Matches ignore patterns (Date, URL, Page Num)
                    if (IGNORE_PATTERNS.some(p => p.test(item.str.trim()))) {
                        continue;
                    }
                    
                    // 2. Font size check: If it's significantly smaller than baseFontSize, it's likely noise
                    // But be careful not to kill small disclaimer text that might be important?
                    // Usually header/footer text is smaller.
                    // Let's say if it is < 90% of base font size.
                    const itemFontSize = item.height || item.transform[3] || 10;
                    if (itemFontSize < baseFontSize * 0.9) {
                        continue;
                    }
                    
                    // 3. If it is exactly baseFontSize or larger, we KEEP it (likely a title or main text that pushed to edge)
                }
                
                // --- Filter: Patterns (Global) ---
                // Even if not at edge, "about:blank" should go
                if (/about:blank/i.test(item.str)) {
                    continue;
                }

                let line = lines.find(l => l.type === 'text' && Math.abs(l.y - y) < Y_TOLERANCE);
                if (!line) {
                    line = { y, type: 'text', items: [] };
                    lines.push(line);
                }
                line.items?.push(item);
            }
        }
        
        // Add Image Lines
        imageInfos.forEach(img => {
            // Relaxed filter for images: only ignore if extremely close to edges (e.g. < 20px) 
            // to avoid filtering out legitimate top/bottom banner images
            if (img.y < 20 || img.y > pageHeight - 20) return;
            
            lines.push({
                y: img.y,
                type: 'image',
                imageId: img.id
            });
        });

        // 4. Sort All Lines (Top to Bottom)
        // PDF Y is bottom-up, so we sort descending Y to get top-to-bottom reading order
        lines.sort((a, b) => b.y - a.y);

        // 5. Build Markdown
        // ... (Font size calculation remains same, based on text lines only)
        const textLines = lines.filter(l => l.type === 'text');
        
        // Use the baseFontSize calculated earlier
        // const fontSizes: Record<number, number> = {};
        // ...
        
        // let baseFontSize = 0;
        // let maxCount = 0;
        // ...
        // if (baseFontSize === 0) baseFontSize = 10;

        // 5. Build Markdown with Smart Paragraph Merging
        // First pass: Process lines to calculate widths and prepare data
        let maxLineWidth = 0;
        const processedLines = lines.map(line => {
            if (line.type === 'image') return { type: 'image' as const, data: line };
            
            // Sort items by X coordinate to ensure correct reading order within the line
            if (line.items) {
                line.items.sort((a, b) => a.transform[4] - b.transform[4]);
            }

            let lineStr = '';
            let lastXEnd = -1;
            let startX = -1;
            let endX = -1;
            
            line.items!.forEach(item => {
                const itemX = item.transform[4];
                const itemWidth = item.width || 0;
                
                if (startX === -1 || itemX < startX) startX = itemX;
                if (itemX + itemWidth > endX) endX = itemX + itemWidth;

                if (lastXEnd >= 0) {
                    const gap = itemX - lastXEnd;
                    const fontSize = item.height || item.transform[3] || baseFontSize;
                    if (gap > fontSize * 0.25) {
                        lineStr += ' ';
                    }
                }
                lineStr += item.str;
                lastXEnd = itemX + itemWidth;
            });
            
            const lineWidth = endX - startX;
            if (lineWidth > maxLineWidth) maxLineWidth = lineWidth;
            
            // Heading Detection
            const maxLineFontSize = Math.max(...line.items!.map(i => i.height || i.transform[3] || 0));
            let prefix = '';
            
            if (Math.abs(maxLineFontSize - baseFontSize) > 1) { 
                if (maxLineFontSize >= baseFontSize * 1.8) {
                    prefix = '# ';
                } else if (maxLineFontSize >= baseFontSize * 1.4) {
                    prefix = '## ';
                } else if (maxLineFontSize >= baseFontSize * 1.15) {
                    prefix = '### ';
                }
            }
            
            return { type: 'text' as const, text: lineStr, prefix, lineWidth, data: line };
        });

        let pageText = '';
        let currentParagraph = '';
        
        const isCJK = (char: string) => {
            return /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char);
        };

        processedLines.forEach((line, index) => {
            if (line.type === 'image') {
                if (currentParagraph) {
                    pageText += currentParagraph + '\n\n';
                    currentParagraph = '';
                }
                const src = pageImages.find(i => i.id === line.data.imageId)?.src;
                if (src) {
                    pageText += `![Image](${src})\n\n`;
                }
                return;
            }
            
            const textLine = line as { type: 'text', text: string, prefix: string, lineWidth: number };
            
            if (textLine.prefix) {
                if (currentParagraph) {
                    pageText += currentParagraph + '\n\n';
                    currentParagraph = '';
                }
                pageText += textLine.prefix + textLine.text + '\n\n';
            } else {
                if (currentParagraph === '') {
                    currentParagraph = textLine.text;
                } else {
                    // Check previous line width to decide merge
                    const prevLine = processedLines[index - 1];
                    const prevWidth = (prevLine as any).lineWidth || 0;
                    
                    // If previous line was short (< 85% of max), it's likely a paragraph end
                    if (prevWidth < maxLineWidth * 0.85) {
                        pageText += currentParagraph + '\n\n';
                        currentParagraph = textLine.text;
                    } else {
                        // Merge lines
                        const lastChar = currentParagraph.slice(-1);
                        const firstChar = textLine.text[0];
                        
                        // Smart merge for CJK
                        if (isCJK(lastChar) && isCJK(firstChar)) {
                            currentParagraph += textLine.text;
                        } else {
                            if (lastChar === ' ' || firstChar === ' ') {
                                currentParagraph += textLine.text;
                            } else {
                                currentParagraph += ' ' + textLine.text;
                            }
                        }
                    }
                }
            }
        });
        
        if (currentParagraph) {
            pageText += currentParagraph + '\n\n';
        }
        
        if (pageText.trim()) {
            parts.push(pageText);
        }
      }

      setExtractedImages(allExtractedImages);
      return parts.join('\n\n');
    } catch (err) {
      // 4. If failed, clear images
      clearBlobUrls();
      setError('Failed to convert PDF to MD');
      console.error(err);
      throw err;
    } finally {
      setIsConverting(false);
    }
  };

  return {
    convertDocxToMd,
    convertMdToDocx,
    convertPdfToMd,
    isConverting,
    error,
    setError,
    conversionLog, // Export logs
    extractedImages
  };
}

async function parseMarkdown(md: string): Promise<string> {
  const { marked } = await import('marked');
  return marked.parse(md) as string;
}

import { useState, useRef, useEffect } from 'react';
import { useConverter } from './hooks/useConverter';
import { 
  FileText, Download, Code, Eye, Printer, 
  FileType, Trash2, FileUp, X, Loader2, Save, Image as ImageIcon,
  Link2, Link2Off, Zap
} from 'lucide-react';
import { marked } from 'marked';
import { cn } from './lib/utils';
import { ImageViewer } from './components/ImageViewer';

// Helper to convert Blob to Base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper to replace blob URLs with Base64 in Markdown
const processMarkdownForExport = async (markdown: string): Promise<string> => {
  // Match standard markdown images: ![alt](url)
  const blobUrlRegex = /!\[.*?\]\((blob:.*?)\)/g;
  let processedMarkdown = markdown;
  
  // Find all unique blob URLs to avoid fetching same image multiple times
  const matches = [...markdown.matchAll(blobUrlRegex)];
  const uniqueBlobUrls = new Set(matches.map(m => m[1]));
  
  for (const blobUrl of uniqueBlobUrls) {
    try {
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      const base64 = await blobToBase64(blob);
      // Replace all occurrences of this blob URL
      processedMarkdown = processedMarkdown.split(blobUrl).join(base64);
    } catch (e) {
      console.error(`Failed to convert image ${blobUrl} to Base64:`, e);
    }
  }
  
  return processedMarkdown;
};

// Helper to replace blob URLs with Base64 in HTML for printing
const processHtmlForPrint = async (html: string): Promise<string> => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const images = Array.from(doc.querySelectorAll('img'));
  
  if (images.length === 0) return html;

  console.log(`Found ${images.length} images to process for printing`);

  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute('src');
    if (src && src.startsWith('blob:')) {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
        const blob = await response.blob();
        const base64 = await blobToBase64(blob);
        img.setAttribute('src', base64);
        console.log(`Converted image to base64: ${base64.substring(0, 50)}...`);
      } catch (e) {
        console.error(`Failed to convert image ${src} to Base64:`, e);
      }
    }
  }));
  
  return doc.body.innerHTML;
};

function App() {
  const initialSavedContent = (() => localStorage.getItem('auto_save_content') ?? '')();
  const initialSavedName = (() => localStorage.getItem('auto_save_name') ?? 'document')();
  const initialSavedType = (() => {
    const t = localStorage.getItem('auto_save_type');
    return t === 'docx' || t === 'md' || t === 'pdf' ? t : null;
  })();

  const [markdown, setMarkdown] = useState<string>(initialSavedContent);
  const [activeTab, setActiveTab] = useState<'editor' | 'preview'>('editor');
  const [fileName, setFileName] = useState(initialSavedName);
  const [fileType, setFileType] = useState<'docx' | 'md' | 'pdf' | null>(initialSavedType);
  const [appError, setAppError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [isWelcome, setIsWelcome] = useState(!initialSavedContent);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>(initialSavedContent ? 'saved' : 'saved');
  const [selectedImage, setSelectedImage] = useState<{src: string; alt: string} | null>(null);
  const [showImagesPanel, setShowImagesPanel] = useState(false);
  // Sync scroll state
  const [isSyncScroll, setIsSyncScroll] = useState(() => localStorage.getItem('sync_scroll') !== 'false');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncScrollingRef = useRef<'editor' | 'preview' | null>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const latestMarkdownRef = useRef(markdown);
  const latestFileNameRef = useRef(fileName);
  const latestFileTypeRef = useRef(fileType);
  // Scroll memory
  const lastScrollPosRef = useRef<number>(Number(localStorage.getItem('last_scroll_pos') || 0));
  
  const { 
    convertDocxToMd, 
    convertMdToDocx, 
    convertPdfToMd, 
    isConverting, 
    error: converterError, 
    setError: setConverterError, 
    conversionLog,
    extractedImages 
  } = useConverter();

  const scheduleAutoSave = () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    setSaveStatus('saving');

    autoSaveTimerRef.current = setTimeout(() => {
      localStorage.setItem('auto_save_content', latestMarkdownRef.current);
      localStorage.setItem('auto_save_name', latestFileNameRef.current);
      const t = latestFileTypeRef.current;
      if (t) localStorage.setItem('auto_save_type', t);
      setSaveStatus('saved');
    }, 1000);
  };

  // Handle preview click to open image viewer
  useEffect(() => {
      const handlePreviewClick = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          // Check if clicked element is an image link (our custom format) or an actual image
          if (target.tagName === 'A' && target.classList.contains('text-indigo-600')) {
              e.preventDefault();
              const href = (target as HTMLAnchorElement).href;
              // Extract filename from previous sibling text node if possible, or use href
              setSelectedImage({ src: href, alt: 'Preview' });
          } else if (target.tagName === 'IMG') {
               // For standard markdown images
               const img = target as HTMLImageElement;
               setSelectedImage({ src: img.src, alt: img.alt });
          }
      };

      const previewEl = previewRef.current;
      if (previewEl) {
          previewEl.addEventListener('click', handlePreviewClick);
      }
      return () => {
          if (previewEl) {
              previewEl.removeEventListener('click', handlePreviewClick);
          }
      };
  }, [previewHtml]);

  // Helper to read text file with auto-encoding detection
  const readTextFile = async (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
              const buffer = e.target?.result as ArrayBuffer;
              try {
                  // Try UTF-8 first
                  const decoder = new TextDecoder('utf-8', { fatal: true });
                  const text = decoder.decode(buffer);
                  resolve(text);
              } catch (e) {
                  // Fallback to GBK
                  console.warn("UTF-8 decoding failed, trying GBK...", e);
                  try {
                      const decoder = new TextDecoder('gbk', { fatal: true });
                      const text = decoder.decode(buffer);
                      resolve(text);
                  } catch (gbkErr) {
                      // Fallback to default (utf-8 non-fatal)
                      console.warn("GBK decoding failed, trying default...", gbkErr);
                      const decoder = new TextDecoder('utf-8'); // Non-fatal
                      resolve(decoder.decode(buffer));
                  }
              }
          };
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsArrayBuffer(file);
      });
  };

  // Effects
  useEffect(() => {
    localStorage.setItem('sync_scroll', String(isSyncScroll));
  }, [isSyncScroll]);

  // Restore scroll position
  useEffect(() => {
      if (markdown && editorRef.current) {
          // Small delay to ensure content is rendered
          setTimeout(() => {
              if (editorRef.current) {
                  editorRef.current.scrollTop = lastScrollPosRef.current;
                  // Trigger sync to update preview
                  if (isSyncScroll) syncScroll('editor');
              }
          }, 100);
      }
  }, [markdown]); // Re-run when markdown loads (initial or file load)

  useEffect(() => {
    const parse = async () => {
        if (!markdown) {
            setPreviewHtml('');
            return;
        }
        const html = await marked.parse(markdown);
        const doc = new DOMParser().parseFromString(String(html), 'text/html');
        
        // Add specific styles for PDF page breaks if they exist
        // Replace <hr> that might be page breaks
        
        doc.querySelectorAll('img').forEach((img) => {
          img.setAttribute('referrerpolicy', 'no-referrer');
          img.setAttribute('loading', 'lazy');
        });
        setPreviewHtml(doc.body.innerHTML);
    };
    parse();
  }, [markdown]);

  // Handlers
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    processFile(file);
    // Reset input
    e.target.value = '';
  };

  const processFile = async (file: File) => {
    setAppError(null);
    const name = file.name.replace(/\.[^/.]+$/, "");
    setFileName(name);
    latestFileNameRef.current = name;

    const ext = file.name.toLowerCase().split('.').pop();
    let type: 'docx' | 'md' | 'pdf' | null = null;
    
    if (ext === 'docx') type = 'docx';
    else if (ext === 'md') type = 'md';
    else if (ext === 'pdf') type = 'pdf';

    if (!type) {
        setAppError('Unsupported file format. Please upload .docx, .pdf or .md');
        return;
    }

    setFileType(type);
    latestFileTypeRef.current = type;
    setIsWelcome(false); // Exit welcome screen immediately to show loading state

    try {
        if (type === 'docx') {
            const md = await convertDocxToMd(file);
            setMarkdown(md);
            latestMarkdownRef.current = md;
            setSaveStatus('unsaved');
            scheduleAutoSave();
        } else if (type === 'md') {
            const text = await readTextFile(file);
            setMarkdown(text);
            latestMarkdownRef.current = text;
            setSaveStatus('unsaved');
            scheduleAutoSave();
        } else if (type === 'pdf') {
            const md = await convertPdfToMd(file);
            setMarkdown(md);
            latestMarkdownRef.current = md;
            setSaveStatus('unsaved');
            scheduleAutoSave();
        }
    } catch (err) {
        console.error(err);
        const msg = err instanceof Error ? err.message : String(err);
        setAppError(`Conversion failed: ${msg}`);
        setIsWelcome(true); // Revert if failed
    }
  };

  const handleExportDocx = async () => {
    try {
      const processedMarkdown = await processMarkdownForExport(markdown);
      const blob = await convertMdToDocx(processedMarkdown);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setAppError('Export failed');
    }
  };

  const handleExportMd = async () => {
    const processedMarkdown = await processMarkdownForExport(markdown);
    const blob = new Blob([processedMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = async () => {
    // Show loading state or at least indicate something is happening
    const btn = document.activeElement as HTMLButtonElement;
    const originalText = btn?.innerText;
    if (btn) btn.innerText = 'Preparing...';

    try {
        const processedHtml = await processHtmlForPrint(previewHtml);
        
        // Use iframe for better compatibility and to avoid popup blockers
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        // visible but hidden off-screen to ensure rendering engines work
        iframe.style.visibility = 'hidden'; 
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow?.document;
        if (!doc) {
            alert('Print failed: Could not create print frame');
            return;
        }

        doc.open();
        doc.write(`
            <html>
            <head>
                <title>${fileName}</title>
                <style>
                    body { font-family: system-ui, sans-serif; padding: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto; }
                    img { max-width: 100%; display: block; margin: 10px 0; }
                    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    blockquote { border-left: 4px solid #ddd; padding-left: 1rem; color: #666; margin: 0; }
                    pre { background: #f4f4f4; padding: 1rem; border-radius: 4px; overflow-x: auto; }
                    
                    @media print {
                        body { padding: 0; }
                    }
                </style>
            </head>
            <body>
                ${processedHtml}
                <script>
                    window.onload = () => {
                        // Ensure images are decoded
                        setTimeout(() => {
                            window.print();
                        }, 800);
                    }
                </script>
            </body>
            </html>
        `);
        doc.close();

        // Cleanup after a delay to allow print dialog to work
        setTimeout(() => {
            if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
            }
        }, 60000);

    } catch (e) {
        console.error('Print preparation failed:', e);
        alert('Print preparation failed');
    } finally {
        if (btn) btn.innerText = originalText;
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
        processFile(file);
    }
  };

  const clearAll = () => {
      setMarkdown('');
      setFileName('document');
      setFileType(null);
      setAppError(null);
      setIsWelcome(true);
      setSaveStatus('saved');
      latestMarkdownRef.current = '';
      latestFileNameRef.current = 'document';
      latestFileTypeRef.current = null;
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      localStorage.removeItem('auto_save_content');
      localStorage.removeItem('auto_save_name');
      localStorage.removeItem('auto_save_type');
  };

  const syncScroll = (from: 'editor' | 'preview') => {
    if (!isSyncScroll) return;

    const fromEl = from === 'editor' ? editorRef.current : previewRef.current;
    const toEl = from === 'editor' ? previewRef.current : editorRef.current;
    if (!fromEl || !toEl) return;

    if (syncScrollingRef.current && syncScrollingRef.current !== from) return;
    syncScrollingRef.current = from;

    // Save scroll position
    if (from === 'editor') {
        lastScrollPosRef.current = fromEl.scrollTop;
        localStorage.setItem('last_scroll_pos', String(fromEl.scrollTop));
    }

    // Improved sync logic:
    // Instead of simple percentage, we try to match the "visual progress" more accurately
    // For editor (fixed line height), we can calculate the line number.
    // For preview, it's harder, but we can stick to percentage for now as "good enough" for mixed content,
    // or try to map paragraphs.
    
    const fromMax = fromEl.scrollHeight - fromEl.clientHeight;
    const toMax = toEl.scrollHeight - toEl.clientHeight;
    
    // Percentage based sync
    const ratio = fromMax > 0 ? fromEl.scrollTop / fromMax : 0;
    
    // Smooth scroll
    // If the difference is small, jump. If large, smooth? 
    // Actually, direct assignment is better for sync.
    toEl.scrollTop = ratio * Math.max(0, toMax);
      
    // Release lock after delay to prevent scroll loops
    setTimeout(() => {
        if (syncScrollingRef.current === from) {
            syncScrollingRef.current = null;
        }
    }, 50);
  };

  return (
    <div 
        className="h-screen flex flex-col bg-slate-50/50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
    >
      {/* Background Gradients */}
      <div className="fixed inset-0 -z-10 h-full w-full bg-white bg-[linear-gradient(to_right,#f0f0f0_1px,transparent_1px),linear-gradient(to_bottom,#f0f0f0_1px,transparent_1px)] bg-[size:6rem_4rem]"><div className="absolute bottom-0 left-0 right-0 top-0 bg-[radial-gradient(circle_500px_at_50%_200px,#C9EBFF,transparent)]"></div></div>

      {/* Header */}
      <header className="bg-white/70 backdrop-blur-md border-b border-slate-200/60 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3 cursor-pointer group" onClick={clearAll}>
                <div className="bg-gradient-to-br from-indigo-600 to-violet-600 p-2.5 rounded-xl text-white shadow-lg shadow-indigo-500/20 ring-1 ring-white/20 group-hover:scale-105 transition-transform duration-300">
                    <Zap size={20} className="fill-white/20" />
                </div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-900 to-slate-700 bg-clip-text text-transparent tracking-tight">
                    UniConvert
                </h1>
                {!isWelcome && (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 rounded-md text-xs font-medium text-slate-500">
                        {saveStatus === 'saving' ? (
                            <>
                                <Loader2 size={12} className="animate-spin" />
                                <span>Saving...</span>
                            </>
                        ) : saveStatus === 'saved' ? (
                            <>
                                <Save size={12} />
                                <span>Saved</span>
                            </>
                        ) : (
                            <span>Unsaved</span>
                        )}
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2">
                {!isWelcome && (
                    <>
                        {extractedImages.length > 0 && (
                            <button 
                                onClick={() => setShowImagesPanel(!showImagesPanel)}
                                className={cn(
                                    "p-2 rounded-lg transition-colors mr-2 hidden sm:flex items-center gap-2 text-sm font-semibold",
                                    showImagesPanel ? "bg-indigo-100 text-indigo-700" : "hover:bg-slate-100 text-slate-700"
                                )}
                                title="Toggle Image List"
                            >
                                <ImageIcon size={18} />
                                <span className="hidden lg:inline">{extractedImages.length} Images</span>
                            </button>
                        )}
                        <div className="hidden sm:flex items-center gap-2 mr-2">
                            <input 
                                value={fileName}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setFileName(v);
                                  latestFileNameRef.current = v;
                                  setSaveStatus('unsaved');
                                  scheduleAutoSave();
                                }}
                                className="px-3 py-1.5 text-sm bg-slate-100 border-transparent rounded-lg focus:bg-white focus:ring-2 focus:ring-indigo-500/20 outline-none transition-all w-40 text-slate-600 font-medium"
                            />
                            <span className="text-slate-400 text-sm">.{fileType || 'docx'}</span>
                        </div>

                        {fileType !== 'md' && (
                            <button 
                                onClick={handleExportMd}
                                disabled={!markdown}
                                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-95 rounded-lg transition-all shadow-md shadow-emerald-200 disabled:opacity-50 disabled:active:scale-100"
                            >
                                <FileText size={18} />
                                <span className="hidden sm:inline">Export MD</span>
                            </button>
                        )}

                        {fileType !== 'docx' && (
                            <button 
                                onClick={handleExportDocx}
                                disabled={isConverting || !markdown}
                                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:scale-95 rounded-lg transition-all shadow-md shadow-indigo-200 disabled:opacity-50 disabled:active:scale-100"
                            >
                                <Download size={18} />
                                <span className="hidden sm:inline">Export Word</span>
                            </button>
                        )}

                        {fileType !== 'pdf' && (
                            <button 
                                onClick={handlePrint}
                                disabled={!markdown}
                                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 active:scale-95 rounded-lg transition-all shadow-md shadow-rose-200 disabled:opacity-50 disabled:active:scale-100"
                            >
                                <Printer size={18} />
                                <span className="hidden sm:inline">Print PDF</span>
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 overflow-hidden flex flex-col relative">
        
        {/* Error Banner */}
        {(appError || converterError) && (
            <div className="w-full max-w-2xl mx-auto mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2 z-50 shadow-sm">
                <div className="mt-0.5 p-1 bg-red-100 rounded-full">
                    <X size={14} className="flex-shrink-0 cursor-pointer" onClick={() => { setAppError(null); setConverterError(null); }} />
                </div>
                <div className="flex-1">
                    <p className="font-semibold text-sm">Operation Failed</p>
                    <p className="text-sm opacity-90 mt-1">{appError || converterError}</p>
                    {conversionLog.length > 0 && (
                        <details className="mt-2 text-xs text-red-800/70 cursor-pointer">
                            <summary>View Logs</summary>
                            <pre className="mt-2 p-2 bg-red-100/50 rounded overflow-x-auto max-h-32">
                                {conversionLog.join('\n')}
                            </pre>
                        </details>
                    )}
                </div>
            </div>
        )}

        {/* Loading Overlay */}
        {isConverting && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-sm rounded-2xl animate-in fade-in">
                <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col items-center gap-4">
                    <Loader2 size={48} className="text-indigo-600 animate-spin" />
                    <p className="text-slate-600 font-medium">Converting...</p>
                </div>
            </div>
        )}

        {/* Welcome Screen */}
        {isWelcome && !isConverting && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 p-4 animate-in fade-in zoom-in-95 duration-500">
                <div 
                    className="w-full max-w-2xl bg-white/80 backdrop-blur-xl rounded-3xl border border-white/20 shadow-2xl p-12 text-center hover:scale-[1.01] transition-transform cursor-pointer group"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-8 group-hover:bg-indigo-100 transition-colors">
                        <FileUp size={48} className="text-indigo-600" />
                    </div>
                    <h2 className="text-4xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent mb-4">
                        Transform Documents Instantly
                    </h2>
                    <p className="text-slate-500 text-lg mb-8 max-w-md mx-auto">
                        Seamlessly convert between <span className="font-semibold text-indigo-600">Word</span>, <span className="font-semibold text-indigo-600">PDF</span>, and <span className="font-semibold text-indigo-600">Markdown</span>.
                        Drag & drop to experience the magic.
                    </p>
                    <div className="flex justify-center gap-4 text-sm text-slate-400 font-medium">
                        <span className="flex items-center gap-1"><FileType size={16}/> DOCX</span>
                        <span className="flex items-center gap-1"><FileText size={16}/> MD</span>
                        <span className="flex items-center gap-1"><Printer size={16}/> PDF</span>
                    </div>
                </div>
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept=".md,.docx,.pdf" 
                    onChange={handleFileUpload} 
                />
            </div>
        )}

        {/* Editor & Preview Split */}
        {!isWelcome && (
            <div className="flex-1 flex gap-6 h-full min-h-0">
                {/* Image List Panel (Left Side) */}
                {showImagesPanel && extractedImages.length > 0 && (
                    <div className="w-64 bg-white rounded-2xl shadow-sm border border-slate-200/60 overflow-hidden flex flex-col animate-in slide-in-from-left-4 duration-300 hidden md:flex">
                         <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 backdrop-blur-sm flex justify-between items-center">
                            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                                <ImageIcon size={14} /> Images ({extractedImages.length})
                            </span>
                            <button onClick={() => setShowImagesPanel(false)} className="text-slate-400 hover:text-slate-600">
                                <X size={14} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-3">
                            {extractedImages.map((img) => (
                                <div 
                                    key={img.id} 
                                    className="group relative rounded-lg overflow-hidden border border-slate-200 hover:border-indigo-300 transition-all cursor-pointer bg-slate-50"
                                    onClick={() => setSelectedImage({ src: img.src, alt: img.alt })}
                                >
                                    <div className="aspect-video w-full overflow-hidden bg-white flex items-center justify-center">
                                        <img src={img.src} alt={img.alt} className="max-w-full max-h-full object-contain group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                                    </div>
                                    <div className="p-2 text-xs truncate text-slate-600 font-medium group-hover:text-indigo-600 bg-white border-t border-slate-100">
                                        {img.title}
                                    </div>
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                                        <div className="bg-white/90 p-1.5 rounded-full shadow-sm text-indigo-600">
                                            <Eye size={16} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Editor */}
                <div className={cn(
                    "flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200/60 overflow-hidden transition-all h-full",
                    activeTab === 'editor' ? "flex" : "hidden md:flex"
                )}>
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center backdrop-blur-sm">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                            <Code size={14} /> Markdown Source
                        </span>
                        <div className="flex items-center gap-2">
                             <button 
                                onClick={() => setIsSyncScroll(!isSyncScroll)} 
                                className={cn(
                                    "text-slate-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50",
                                    isSyncScroll ? "text-indigo-600 bg-indigo-50" : ""
                                )} 
                                title={isSyncScroll ? "Disable Scroll Sync" : "Enable Scroll Sync"}
                            >
                                {isSyncScroll ? <Link2 size={16} /> : <Link2Off size={16} />}
                            </button>
                            <button onClick={clearAll} className="text-slate-400 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50" title="Clear">
                                <Trash2 size={16} />
                            </button>
                        </div>
                    </div>
                    <textarea
                        ref={editorRef}
                        className="flex-1 w-full p-8 resize-none focus:outline-none font-mono text-sm leading-6 text-slate-800 bg-slate-50/30 placeholder:text-slate-300"
                        value={markdown}
                        onChange={(e) => {
                          const v = e.target.value;
                          setMarkdown(v);
                          latestMarkdownRef.current = v;
                          setSaveStatus('unsaved');
                          scheduleAutoSave();
                        }}
                        onScroll={() => syncScroll('editor')}
                        placeholder="Type markdown here..."
                        spellCheck={false}
                    />
                </div>

                {/* Preview */}
                <div className={cn(
                    "flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200/60 overflow-hidden transition-all h-full",
                    activeTab === 'preview' ? "flex" : "hidden md:flex"
                )}>
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 backdrop-blur-sm flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
                            <Eye size={14} /> Live Preview
                        </span>
                         <button 
                                onClick={() => setIsSyncScroll(!isSyncScroll)} 
                                className={cn(
                                    "text-slate-400 hover:text-indigo-600 transition-colors p-1 rounded-md hover:bg-indigo-50 md:hidden",
                                    isSyncScroll ? "text-indigo-600 bg-indigo-50" : ""
                                )} 
                                title={isSyncScroll ? "Disable Scroll Sync" : "Enable Scroll Sync"}
                            >
                                {isSyncScroll ? <Link2 size={16} /> : <Link2Off size={16} />}
                            </button>
                    </div>
                    <div 
                        ref={previewRef}
                        className="flex-1 w-full p-8 overflow-y-auto prose prose-slate max-w-none prose-base font-sans prose-headings:font-sans prose-p:font-sans prose-li:font-sans prose-img:rounded-xl prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline prose-hr:border-2 prose-hr:border-dashed prose-hr:border-slate-300 prose-hr:my-12 prose-hr:relative prose-hr:after:content-['Page_Break'] prose-hr:after:absolute prose-hr:after:-top-3 prose-hr:after:left-1/2 prose-hr:after:-translate-x-1/2 prose-hr:after:bg-white prose-hr:after:px-2 prose-hr:after:text-xs prose-hr:after:text-slate-400 prose-hr:after:font-mono [&_*]:font-sans text-base leading-relaxed text-slate-900"
                        dangerouslySetInnerHTML={{ __html: previewHtml }}
                        onScroll={() => syncScroll('preview')}
                    />
                </div>
            </div>
        )}

      </main>

      {/* Mobile Tabs */}
      {!isWelcome && (
          <div className="md:hidden border-t border-slate-200 bg-white flex pb-safe">
            <button 
                onClick={() => setActiveTab('editor')}
                className={cn(
                    "flex-1 py-4 text-sm font-semibold text-center transition-colors relative",
                    activeTab === 'editor' ? "text-indigo-600" : "text-slate-500"
                )}
            >
                <div className="flex items-center justify-center gap-2">
                    <Code size={18} /> Editor
                </div>
                {activeTab === 'editor' && <div className="absolute top-0 left-0 right-0 h-0.5 bg-indigo-600"></div>}
            </button>
            <button 
                onClick={() => setActiveTab('preview')}
                className={cn(
                    "flex-1 py-4 text-sm font-semibold text-center transition-colors relative",
                    activeTab === 'preview' ? "text-indigo-600" : "text-slate-500"
                )}
            >
                <div className="flex items-center justify-center gap-2">
                    <Eye size={18} /> Preview
                </div>
                {activeTab === 'preview' && <div className="absolute top-0 left-0 right-0 h-0.5 bg-indigo-600"></div>}
            </button>
          </div>
      )}
      
      {(converterError || appError) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-500/90 backdrop-blur-md text-white px-6 py-3 rounded-full shadow-xl text-sm font-medium animate-in slide-in-from-bottom-5">
            {converterError || appError}
            <button onClick={() => { setAppError(null); setConverterError(null); }} className="ml-3 hover:text-red-100"><X size={14}/></button>
        </div>
      )}
      {/* Image Viewer Modal */}
      {selectedImage && (
        <ImageViewer 
          key={selectedImage.src}
          isOpen={true}
          onClose={() => setSelectedImage(null)}
          src={selectedImage.src}
          alt={selectedImage.alt}
        />
      )}
    </div>
  );
}

export default App;

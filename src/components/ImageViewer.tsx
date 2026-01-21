import { useState, useEffect, useRef } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download } from 'lucide-react';

interface ImageViewerProps {
  src: string;
  alt?: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ImageViewer({ src, alt, isOpen, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.5, 5));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.5, 0.5));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);
  
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y
    });
  };

  const handleMouseUp = () => setIsDragging(false);

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col animate-in fade-in duration-200">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-4 text-white bg-black/20 backdrop-blur-sm z-50">
        <h3 className="text-sm font-medium truncate max-w-[200px] sm:max-w-md">{alt || 'Image Preview'}</h3>
        <div className="flex items-center gap-2 sm:gap-4">
          <button onClick={handleZoomOut} className="p-2 hover:bg-white/10 rounded-full transition-colors" title="Zoom Out">
            <ZoomOut size={20} />
          </button>
          <span className="text-xs font-mono w-12 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={handleZoomIn} className="p-2 hover:bg-white/10 rounded-full transition-colors" title="Zoom In">
            <ZoomIn size={20} />
          </button>
          <div className="w-px h-6 bg-white/20 mx-2" />
          <button onClick={handleRotate} className="p-2 hover:bg-white/10 rounded-full transition-colors" title="Rotate">
            <RotateCw size={20} />
          </button>
          <a href={src} download={alt || 'image'} className="p-2 hover:bg-white/10 rounded-full transition-colors" title="Download">
            <Download size={20} />
          </a>
          <div className="w-px h-6 bg-white/20 mx-2" />
          <button onClick={onClose} className="p-2 hover:bg-red-500/80 rounded-full transition-colors" title="Close">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Image Area */}
      <div 
        className="flex-1 overflow-hidden flex items-center justify-center cursor-move p-4"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={(e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                if (e.deltaY < 0) handleZoomIn();
                else handleZoomOut();
            }
        }}
      >
        <img 
          src={src} 
          alt={alt} 
          className="transition-transform duration-200 ease-out max-w-none"
          style={{ 
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            maxHeight: '90vh',
            maxWidth: '90vw'
          }}
          draggable={false}
        />
      </div>
      
      {/* Footer hint */}
      <div className="p-4 text-center text-white/50 text-xs">
        Scroll to zoom • Drag to pan
      </div>
    </div>
  );
}

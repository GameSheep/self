import React, { useRef, useState, useEffect } from 'react';
import { PenTool, Eraser, RotateCcw, Download, Save, Check } from 'lucide-react';
import { HandwritingNote } from '../../types';

interface HandwritingCardProps {
  onSaveNote: (note: HandwritingNote) => void;
  savedNotes: HandwritingNote[];
  onDeleteNote: (id: string) => void;
}

export const HandwritingCard: React.FC<HandwritingCardProps> = ({
  onSaveNote,
  savedNotes,
  onDeleteNote
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [color, setColor] = useState('#f4f4f5');
  const [lineWidth, setLineWidth] = useState(3);
  const [isEraser, setIsEraser] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const historyRef = useRef<ImageData[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fill dark background
    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Save initial state
    historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
  }, []);

  const getCoordinates = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if ('touches' in e) {
      e.preventDefault();
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);
    const { x, y } = getCoordinates(e);

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = isEraser ? '#121316' : color;
    ctx.lineWidth = isEraser ? lineWidth * 4 : lineWidth;
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    if ('touches' in e) {
      e.preventDefault();
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { x, y } = getCoordinates(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (historyRef.current.length > 20) {
        historyRef.current.shift();
      }
    }
  };

  const handleUndo = () => {
    const canvas = canvasRef.current;
    if (!canvas || historyRef.current.length <= 1) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    historyRef.current.pop();
    const previous = historyRef.current[historyRef.current.length - 1];
    ctx.putImageData(previous, 0, 0);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dataUrl = canvas.toDataURL('image/png');
    const newNote: HandwritingNote = {
      id: `hw-${Date.now()}`,
      title: noteTitle.trim() || `手绘速记 (${new Date().toLocaleTimeString()})`,
      dataUrl,
      createdAt: Date.now()
    };

    onSaveNote(newNote);
    setSavedSuccess(true);
    setNoteTitle('');
    setTimeout(() => setSavedSuccess(false), 2000);
  };

  const colors = ['#f4f4f5', '#38bdf8', '#34d399', '#fbbf24', '#f43f5e'];

  return (
    <div className="p-5 rounded-2xl bg-[#121316] border border-[#22242a] shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <PenTool className="w-4 h-4 text-sky-400" />
            快速手写与架构画板
          </h2>
          <p className="text-xs text-zinc-500">
            支持鼠标与平板触控笔手写、绘制拓扑架构、灵感涂鸦并一键归档
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Colors */}
          <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
            {colors.map((c) => (
              <button
                key={c}
                onClick={() => {
                  setColor(c);
                  setIsEraser(false);
                }}
                className={`w-5 h-5 rounded-full transition-transform ${
                  color === c && !isEraser ? 'scale-110 ring-2 ring-white/50' : 'opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          {/* Stroke Width */}
          <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800 text-xs">
            {[2, 4, 8].map((w) => (
              <button
                key={w}
                onClick={() => setLineWidth(w)}
                className={`px-2 py-0.5 rounded ${lineWidth === w ? 'bg-zinc-800 text-white' : 'text-zinc-500'}`}
              >
                {w}px
              </button>
            ))}
          </div>

          {/* Eraser */}
          <button
            onClick={() => setIsEraser(!isEraser)}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1 transition-colors ${
              isEraser ? 'bg-zinc-800 border-zinc-600 text-white' : 'bg-zinc-900 border-zinc-800 text-zinc-400'
            }`}
            title="橡皮擦"
          >
            <Eraser className="w-3.5 h-3.5" />
          </button>

          {/* Undo */}
          <button
            onClick={handleUndo}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
            title="撤销一步"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Clear */}
          <button
            onClick={handleClear}
            className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-red-400 text-xs"
          >
            清屏
          </button>
        </div>
      </div>

      {/* Canvas Area */}
      <div className="relative border border-zinc-800/80 rounded-xl overflow-hidden shadow-inner bg-[#121316]">
        <canvas
          ref={canvasRef}
          width={800}
          height={320}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="w-full h-[260px] sm:h-[300px] cursor-crosshair touch-none"
        />
      </div>

      {/* Save Strip */}
      <div className="flex items-center justify-between gap-3 mt-3">
        <input
          type="text"
          value={noteTitle}
          onChange={(e) => setNoteTitle(e.target.value)}
          placeholder="给这幅手绘命名 (例如: 服务拓扑/今日草稿)..."
          className="flex-1 bg-zinc-900/80 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700"
        />
        <button
          onClick={handleSave}
          className="px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-900 hover:bg-white text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
        >
          {savedSuccess ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Save className="w-3.5 h-3.5" />}
          <span>{savedSuccess ? '已保存入库' : '保存为卡片'}</span>
        </button>
      </div>

      {/* Saved Notes Gallery */}
      {savedNotes.length > 0 && (
        <div className="mt-5 pt-4 border-t border-zinc-800/60">
          <h4 className="text-xs font-semibold text-zinc-400 mb-3">
            已归档的手写草图 ({savedNotes.length})
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {savedNotes.map((note) => (
              <div key={note.id} className="group relative rounded-lg border border-zinc-800/90 bg-zinc-900/60 overflow-hidden">
                <img src={note.dataUrl} alt={note.title} className="w-full h-24 object-cover" />
                <div className="p-2 flex items-center justify-between text-[11px] text-zinc-400">
                  <span className="truncate">{note.title}</span>
                  <button
                    onClick={() => onDeleteNote(note.id)}
                    className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-[10px]"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

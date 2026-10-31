import React, { useRef, useState, useEffect } from 'react';
import { PenTool, Eraser, RotateCcw, Download, Save, Check, Square, Circle, Minus } from 'lucide-react';
import { HandwritingNote } from '../../types';

interface HandwritingCardProps {
  onSaveNote: (note: HandwritingNote) => void;
  savedNotes: HandwritingNote[];
  onDeleteNote: (id: string) => void;
}

/** Canvas background — must match the eraser and the downscaled save, or holes appear. */
const CANVAS_BG = '#1b1e24';

/** Shape tools (7.2). 'pen' is freehand; the rest drag from one corner to the other. */
type DrawTool = 'pen' | 'rect' | 'ellipse' | 'line';

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
  const [tool, setTool] = useState<DrawTool>('pen');
  /** Anchor for a shape drag, plus the canvas as it looked before the preview. */
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeSnapshotRef = useRef<ImageData | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);
  /** Set when the save callback threw; the canvas is deliberately untouched. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const historyRef = useRef<ImageData[]>([]);
  const hasContentRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fill dark background
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Save initial state
    historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    hasContentRef.current = false;
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

    // Shape tool: remember the anchor and freeze the canvas, so dragging shows a live preview
    // and releasing commits exactly one shape.
    if (!isEraser && tool !== 'pen') {
      shapeStartRef.current = { x, y };
      shapeSnapshotRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return;
    }

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = isEraser ? CANVAS_BG : color;
    ctx.lineWidth = isEraser ? lineWidth * 4 : lineWidth;
  };

  /** Draw the shape preview from the stored anchor to the current point. */
  const drawShapePreview = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const start = shapeStartRef.current;
    const snapshot = shapeSnapshotRef.current;
    if (!start || !snapshot) return;
    ctx.putImageData(snapshot, 0, 0);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    if (tool === 'rect') {
      ctx.rect(start.x, start.y, x - start.x, y - start.y);
    } else if (tool === 'ellipse') {
      const cx = (start.x + x) / 2;
      const cy = (start.y + y) / 2;
      ctx.ellipse(cx, cy, Math.abs(x - start.x) / 2, Math.abs(y - start.y) / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    hasContentRef.current = true;
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
    if (!isEraser && tool !== 'pen') {
      drawShapePreview(ctx, x, y);
      return;
    }
    ctx.lineTo(x, y);
    ctx.stroke();
    hasContentRef.current = true;
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    shapeStartRef.current = null;
    shapeSnapshotRef.current = null;
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

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    historyRef.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    hasContentRef.current = false;
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!hasContentRef.current) {
      alert('画板还是空的，先画点内容再保存吧。');
      return;
    }

    // Downscale before storing: a full-resolution PNG in localStorage is the
    // fastest way to hit the ~5MB quota (which silently dropped other edits).
    const MAX_EDGE = 1280;
    let dataUrl = canvas.toDataURL('image/png');
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(canvas.width, canvas.height));
      if (scale < 1) {
        const out = document.createElement('canvas');
        out.width = Math.round(canvas.width * scale);
        out.height = Math.round(canvas.height * scale);
        const octx = out.getContext('2d');
        if (octx) {
          octx.fillStyle = CANVAS_BG;
          octx.fillRect(0, 0, out.width, out.height);
          octx.drawImage(canvas, 0, 0, out.width, out.height);
          dataUrl = out.toDataURL('image/png');
        }
      }
    } catch {}

    const newNote: HandwritingNote = {
      id: `hw-${Date.now()}`,
      title: noteTitle.trim() || `手绘速记 (${new Date().toLocaleTimeString()})`,
      dataUrl,
      createdAt: Date.now()
    };

    /**
     * The writer can fail (quota, blocked storage). When it does, the canvas and
     * the title must survive so the user can retry — clearing them on a failed
     * save was how a drawing could be lost with a green "已保存入库".
     */
    try {
      onSaveNote(newNote);
      setSaveError(null);
      setSavedSuccess(true);
      setNoteTitle('');
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      setSavedSuccess(false);
      setSaveError(err instanceof Error ? err.message : '保存失败，画布内容已保留，可重试');
    }
  };

  const colors = ['#f4f4f5', '#38bdf8', '#34d399', '#fbbf24', '#f43f5e'];

  return (
    <div className="p-5 rounded-2xl bg-sh-surface border border-sh-line shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-sh-fg flex items-center gap-2">
            <PenTool className="w-4 h-4 text-sh-info" />
            快速手写与架构画板
          </h2>
          <p className="text-xs text-sh-subtle">
            支持鼠标与平板触控笔手写、绘制拓扑架构、灵感涂鸦并一键归档
          </p>
        </div>

        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Shape tools (7.2): drag to draw, like a simple paint app. */}
          <div className="flex items-center gap-1 bg-sh-surface2 p-1 rounded-lg border border-sh-line text-xs">
            {(
              [
                ['pen', '画笔', PenTool],
                ['rect', '矩形', Square],
                ['ellipse', '椭圆', Circle],
                ['line', '直线', Minus]
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => {
                  setTool(id);
                  setIsEraser(false);
                }}
                data-tool={id}
                aria-pressed={tool === id && !isEraser}
                title={label}
                className={`p-1.5 rounded flex items-center gap-1 ${
                  tool === id && !isEraser ? 'bg-sh-surface text-sh-fg' : 'text-sh-muted hover:text-sh-fg'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* Colors */}
          <div className="flex items-center gap-1 bg-sh-surface2 p-1 rounded-lg border border-sh-line">
            {colors.map((c) => (
              <button
                key={c}
                onClick={() => {
                  setColor(c);
                  setIsEraser(false);
                }}
                aria-label={`选择颜色 ${c}`}
                aria-pressed={color === c && !isEraser}
                className={`w-5 h-5 rounded-full transition-transform ${
                  color === c && !isEraser ? 'scale-110 ring-2 ring-white/50' : 'opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          {/* Stroke Width */}
          <div className="flex items-center gap-1 bg-sh-surface2 p-1 rounded-lg border border-sh-line text-xs">
            {[2, 4, 8].map((w) => (
              <button
                key={w}
                onClick={() => setLineWidth(w)}
                aria-label={`线宽 ${w} 像素`}
                aria-pressed={lineWidth === w}
                className={`px-2 py-0.5 rounded ${lineWidth === w ? 'bg-sh-surface2 text-sh-accent-fg' : 'text-sh-subtle'}`}
              >
                {w}px
              </button>
            ))}
          </div>

          {/* Eraser */}
          <button
            onClick={() => setIsEraser(!isEraser)}
            className={`p-1.5 rounded-lg border text-xs flex items-center gap-1 transition-colors ${
              isEraser ? 'bg-sh-surface2 border-sh-line-strong text-sh-accent-fg' : 'bg-sh-surface2 border-sh-line text-sh-muted'
            }`}
            title="橡皮擦"
          >
            <Eraser className="w-3.5 h-3.5" />
          </button>

          {/* Undo */}
          <button
            onClick={handleUndo}
            className="p-1.5 rounded-lg bg-sh-surface2 border border-sh-line text-sh-muted hover:text-sh-fg"
            title="撤销一步"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Clear */}
          <button
            onClick={handleClear}
            className="px-2.5 py-1 rounded-lg bg-sh-surface2 border border-sh-line text-sh-muted hover:text-sh-danger text-xs"
          >
            清屏
          </button>
        </div>
      </div>

      {/* Canvas Area — big on purpose (7.2): the old 800×320 board was too small to draw on. */}
      <div className="relative border border-sh-line rounded-xl overflow-hidden shadow-inner bg-sh-surface">
        <canvas
          ref={canvasRef}
          width={1600}
          height={900}
          data-testid="drawing-canvas"
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="w-full h-[52vh] min-h-[420px] cursor-crosshair touch-none"
        />
      </div>

      {/* Save Strip */}
      <div className="flex items-center justify-between gap-3 mt-3">
        <input
          type="text"
          value={noteTitle}
          onChange={(e) => setNoteTitle(e.target.value)}
          placeholder="给这幅手绘命名 (例如: 服务拓扑/今日草稿)..."
          className="flex-1 bg-sh-surface2/80 border border-sh-line rounded-lg px-3 py-1.5 text-xs text-sh-fg focus:outline-none focus:border-sh-line-strong"
        />
        <button
          onClick={handleSave}
          data-testid="handwriting-save"
          className="px-3 py-1.5 rounded-lg bg-sh-accent text-sh-accent-fg hover:opacity-90 text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
        >
          {savedSuccess ? <Check className="w-3.5 h-3.5 text-sh-ok" /> : <Save className="w-3.5 h-3.5" />}
          <span>{savedSuccess ? '已保存入库' : saveError ? '重试保存' : '保存为卡片'}</span>
        </button>
      </div>

      {saveError && (
        <p
          className="mt-2 text-[11px] text-sh-danger leading-relaxed"
          data-testid="handwriting-save-error"
          role="alert"
        >
          {saveError} — 画布内容仍在，可修好存储问题后再次点击保存。
        </p>
      )}

      {/* Saved Notes Gallery */}
      {savedNotes.length > 0 && (
        <div className="mt-5 pt-4 border-t border-sh-line">
          <h4 className="text-xs font-semibold text-sh-muted mb-3">
            已归档的手写草图 ({savedNotes.length})
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {savedNotes.map((note) => (
              <div key={note.id} className="group relative rounded-lg border border-sh-line bg-sh-surface2/70 overflow-hidden">
                <img src={note.dataUrl} alt={note.title} className="w-full h-24 object-cover" />
                <div className="p-2 flex items-center justify-between text-[11px] text-sh-muted">
                  <span className="truncate">{note.title}</span>
                  <button
                    onClick={() => {
                      // A hand-drawn canvas is unrecoverable local data; one
                      // mis-tap must not erase it without asking.
                      if (!window.confirm(`确认删除手绘「${note.title}」？删除后不可恢复。`)) return;
                      onDeleteNote(note.id);
                    }}
                    aria-label={`删除手绘 ${note.title}`}
                    className="opacity-100 sm:opacity-0 group-hover:opacity-100 text-sh-subtle hover:text-sh-danger text-[10px]"
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

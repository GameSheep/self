import React from 'react';
import { PenTool } from 'lucide-react';
import type { HandwritingNote } from '../../types';
import { HandwritingCard } from '../../components/cards/HandwritingCard';
import { PageHeader } from '../../shared/ui';

export interface DrawingViewProps {
  handwritings: HandwritingNote[];
  onSave: (note: HandwritingNote) => void;
  onDelete: (id: string) => void;
}

/**
 * Hand drawing (P1-07).
 *
 * Saved drawings are library entries with an image attachment; the page says so
 * instead of talking about Base64 or buckets. An empty canvas is refused rather
 * than stored as a blank record, and a failed save keeps the canvas as-is.
 */
export const DrawingView: React.FC<DrawingViewProps> = ({ handwritings, onSave, onDelete }) => {
  return (
    <div data-testid="drawing-view">
      <PageHeader
        title="手绘"
        description="画完后保存为资料库中的一条手绘记录，可在资料库里按类型找到。空画布不会保存。"
      />
      <div className="flex items-center gap-1.5 text-[11px] text-sh-subtle mb-3">
        <PenTool className="w-3.5 h-3.5" aria-hidden />
        已保存 {handwritings.length} 张手绘
      </div>
      <HandwritingCard onSaveNote={onSave} savedNotes={handwritings} onDeleteNote={onDelete} />
    </div>
  );
};

export default DrawingView;

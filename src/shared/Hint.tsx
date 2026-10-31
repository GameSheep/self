import React, { useState } from 'react';
import { Info, X } from 'lucide-react';

/**
 * Explanatory text that can be dismissed — permanently, per browser.
 * Several panes carried a paragraph explaining how they work, on every visit. That is useful
 * the first time and noise afterwards: the user asked for it to show once. Dismissal is stored
 */
export function Hint({
  id,
  children,
  className = ''
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const key = `selfhub_hint_dismissed:${id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  if (hidden) return null;

  return (
    <div
      className={`flex items-start gap-2 rounded-xl border border-sh-line bg-sh-surface2/60 px-3 py-2 text-[11px] text-sh-muted leading-relaxed ${className}`}
      data-hint={id}
    >
      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sh-info" aria-hidden />
      <div className="flex-1 min-w-0">{children}</div>
      <button
        onClick={() => {
          try {
            localStorage.setItem(key, '1');
          } catch {
            /* storage unavailable: it will simply show again next time */
          }
          setHidden(true);
        }}
        aria-label="不再提示"
        title="不再提示"
        className="shrink-0 p-0.5 rounded hover:bg-sh-surface"
      >
        <X className="w-3.5 h-3.5" aria-hidden />
      </button>
    </div>
  );
}

export default Hint;

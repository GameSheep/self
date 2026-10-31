import React, { useEffect, useMemo } from 'react';
import { renderMarkdown, type MarkdownContext, type MarkdownHeading } from '../lib/markdown/render';

interface MarkdownProps {
  content: string;
  /** Must be memoised by the caller, otherwise the render is recomputed every time. */
  ctx?: MarkdownContext;
  className?: string;
  /** Reports the document outline (headings) for the TOC panel. */
  onHeadings?: (headings: MarkdownHeading[]) => void;
  /** Renders the frontmatter property block (reading view). */
  showFrontmatter?: boolean;
}

/**
 * Renders markdown as React elements — no innerHTML anywhere.
 * Memoised on (content, ctx) so typing in the editor only re-renders the preview
 * when the text actually changed.
 */
export const Markdown: React.FC<MarkdownProps> = React.memo(function Markdown({
  content,
  ctx,
  className,
  onHeadings,
  showFrontmatter = true
}) {
  const rendered = useMemo(() => renderMarkdown(content, ctx), [content, ctx]);

  // Report the outline without re-rendering on every identical result.
  const headingSignature = rendered.headings.map((h) => `${h.depth}:${h.id}`).join('|');
  useEffect(() => {
    onHeadings?.(rendered.headings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingSignature]);

  const hasProps = showFrontmatter && rendered.frontmatter && rendered.frontmatter.length > 0;

  return (
    <div className={`md-body ${className || ''}`}>
      {hasProps && (
        <div className="md-props">
          <div className="md-props-head">属性 (Frontmatter)</div>
          {rendered.frontmatter!.map((field) => (
            <div className="md-props-row" key={field.key}>
              <span className="md-props-key">{field.key}</span>
              <span className="md-props-val">
                {field.list && field.list.length > 0
                  ? field.list.map((item) => (
                      <span className="md-props-chip" key={item}>
                        {item}
                      </span>
                    ))
                  : field.value || <span className="text-sh-subtle">—</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {showFrontmatter && rendered.frontmatterRaw && (
        <pre className="md-raw-block" title="未能解析的 frontmatter，按原文显示">
          {rendered.frontmatterRaw}
        </pre>
      )}

      {rendered.nodes}

      {!content.trim() && <p className="md-p text-sh-subtle">暂无正文内容</p>}
    </div>
  );
});

export default Markdown;

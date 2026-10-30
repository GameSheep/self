/**
 * Markdown → React renderer.
 *
 * marked only tokenises; every node below is a real React element. There is no
 * `dangerouslySetInnerHTML` anywhere, so note content (including clips captured
 * from arbitrary web pages) cannot inject markup or scripts.
 */
import React, { useEffect, useState } from 'react';
import { marked, type Tokens } from 'marked';
import { splitFrontmatter, type FrontmatterField } from './frontmatter';
import { splitInlineEntities, resolveVaultKey, normalizeWikilinkTarget } from './entities';
import { highlightCode, type HlSpan } from './highlight';

export interface MarkdownHeading {
  depth: number;
  text: string;
  id: string;
}

export interface MarkdownContext {
  /** All vault keys, used to resolve [[wikilinks]] and relative images. */
  vaultKeys?: string[];
  /** Key of the note being rendered (relative link resolution). */
  currentKey?: string;
  /** Called when a [[wikilink]] is clicked. `resolvedKey` is null when unresolved. */
  onWikilink?: (target: string, resolvedKey: string | null, heading?: string) => void;
  /** Called when a #tag is clicked. */
  onTag?: (tag: string) => void;
  /** Called when the Nth task checkbox is toggled. */
  onToggleTask?: (taskIndex: number) => void;
  /** Load a vault object as a displayable URL (signed fetch → blob URL). */
  loadImage?: (key: string) => Promise<string | null>;
  /** Rendered inside code blocks; defaults to a copy button. */
  showCodeCopy?: boolean;
  className?: string;
}

export interface RenderedMarkdown {
  frontmatter: FrontmatterField[] | null;
  frontmatterRaw: string;
  nodes: React.ReactNode;
  headings: MarkdownHeading[];
}

interface RenderState {
  ctx: MarkdownContext;
  keys: string[];
  taskIndex: { value: number };
  headingIds: string[];
  headingIndex: { value: number };
  keySeed: { value: number };
}

/* ------------------------------------------------------------------ utils */

function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'section';
}

function dedupeSlugs(headings: { depth: number; text: string }[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((h) => {
    const slug = slugify(h.text);
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  });
}

function collectHeadings(tokens: Tokens.Generic[]): { depth: number; text: string }[] {
  return tokens
    .filter((t) => t.type === 'heading')
    .map((t) => ({ depth: (t as Tokens.Heading).depth, text: (t as Tokens.Heading).text }));
}

/* ---------------------------------------------------------------- code block */

function HlSpans({ spans }: { spans: HlSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.text !== undefined ? (
          <React.Fragment key={i}>{span.text}</React.Fragment>
        ) : (
          <span key={i} className={span.className}>
            {span.children ? <HlSpans spans={span.children} /> : null}
          </span>
        )
      )}
    </>
  );
}

function CodeBlock({ code, lang, showCopy }: { code: string; lang?: string; showCopy: boolean }) {
  const [copied, setCopied] = useState(false);
  const highlighted = React.useMemo(() => highlightCode(code, lang), [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked by focus/permission; do not claim success.
    }
  };

  return (
    <div className="md-code group">
      <div className="md-code-head">
        <span className="md-code-lang">{highlighted ? (lang || '').trim() || 'text' : (lang || '').trim() || 'text'}</span>
        {showCopy && (
          <button type="button" onClick={copy} className="md-code-copy">
            {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>
      <pre className="md-code-pre">
        <code>{highlighted ? <HlSpans spans={highlighted} /> : code}</code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------- images */

function MarkdownImage({
  src,
  alt,
  ctx
}: {
  src: string;
  alt: string;
  ctx: RenderState;
}) {
  const isRemote = /^(https?:|data:|blob:)/i.test(src);
  const [state, setState] = useState<{ url?: string; error?: string; loading: boolean }>({
    url: isRemote ? src : undefined,
    loading: !isRemote
  });

  // Destructure only the stable pieces of the render state: the parent recreates
  // `ctx` on every keystroke (renderMarkdown builds a fresh RenderState), and
  // depending on the whole object re-ran this effect per keystroke — every image
  // flickered back to the "读取中" placeholder while typing in split view.
  const loadImage = ctx.ctx.loadImage;
  const vaultKeys = ctx.keys;
  const currentKey = ctx.ctx.currentKey;

  useEffect(() => {
    if (isRemote) {
      setState({ url: src, loading: false });
      return;
    }
    let alive = true;
    const key = resolveVaultKey(src, vaultKeys, currentKey);
    if (!key || !loadImage) {
      setState({ loading: false, error: `未在库中找到附件：${src}` });
      return;
    }
    setState({ loading: true });
    loadImage(key)
      .then((url) => {
        if (!alive) return;
        setState(url ? { url, loading: false } : { loading: false, error: `附件读取失败：${key}` });
      })
      .catch(() => {
        if (alive) setState({ loading: false, error: `附件读取失败：${key}` });
      });
    return () => {
      alive = false;
    };
  }, [src, isRemote, loadImage, vaultKeys, currentKey]);

  if (state.loading) {
    return <span className="md-image-pending">正在从 OSS 读取图片…</span>;
  }
  if (state.error || !state.url) {
    return <span className="md-image-error" title={state.error}>{state.error || '图片不可用'}</span>;
  }
  return (
    <img src={state.url} alt={alt} className="md-image" loading="lazy" />
  );
}

/* ------------------------------------------------------------------ renderer */

function renderInline(tokens: Tokens.Generic[] | undefined, st: RenderState): React.ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  return tokens.map((token, index) => renderInlineToken(token, st, index));
}

function renderInlineToken(token: Tokens.Generic, st: RenderState, index: number): React.ReactNode {
  const key = `${token.type}-${index}`;

  switch (token.type) {
    case 'text': {
      const text = (token as Tokens.Text).text ?? '';
      const segments = splitInlineEntities(text);
      if (segments.length === 1 && segments[0].kind === 'text') {
        return <React.Fragment key={key}>{segments[0].text}</React.Fragment>;
      }
      return (
        <React.Fragment key={key}>
          {segments.map((seg, i) => {
            if (seg.kind === 'text') return <React.Fragment key={i}>{seg.text}</React.Fragment>;
            if (seg.kind === 'tag') {
              return (
                <button
                  key={i}
                  type="button"
                  className="md-tag"
                  onClick={() => st.ctx.onTag?.(seg.tag)}
                  title={`筛选标签 #${seg.tag}`}
                >
                  #{seg.tag}
                </button>
              );
            }
            const resolved = st.ctx.vaultKeys
              ? resolveVaultKey(seg.target, st.ctx.vaultKeys, st.ctx.currentKey)
              : null;
            return (
              <button
                key={i}
                type="button"
                className={resolved ? 'md-wikilink' : 'md-wikilink md-wikilink-missing'}
                onClick={() => st.ctx.onWikilink?.(seg.target, resolved, seg.heading)}
                title={resolved ? `打开 ${resolved}` : `库中未找到「${normalizeWikilinkTarget(seg.target)}」`}
              >
                {seg.alias}
              </button>
            );
          })}
        </React.Fragment>
      );
    }

    case 'escape':
      return <React.Fragment key={key}>{(token as Tokens.Escape).text}</React.Fragment>;

    case 'html':
      // Raw HTML is shown as text: rendering it would be an injection vector.
      return (
        <span key={key} className="md-raw-html">
          {(token as Tokens.HTML).text}
        </span>
      );

    case 'br':
      return <br key={key} />;

    case 'codespan':
      return (
        <code key={key} className="md-inline-code">
          {(token as Tokens.Codespan).text}
        </code>
      );

    case 'strong':
      return <strong key={key}>{renderInline((token as Tokens.Strong).tokens, st)}</strong>;

    case 'em':
      return <em key={key}>{renderInline((token as Tokens.Em).tokens, st)}</em>;

    case 'del':
      return <del key={key}>{renderInline((token as Tokens.Del).tokens, st)}</del>;

    case 'link': {
      const link = token as Tokens.Link;
      const href = link.href || '';
      const isAnchor = href.startsWith('#');
      const isRelativeDoc = !/^[a-z][a-z0-9+.-]*:/i.test(href) && /\.(md|markdown)$/i.test(href);
      if (isAnchor) {
        return (
          <a key={key} href={href} className="md-link" onClick={(e) => {
            e.preventDefault();
            st.ctx.onWikilink?.('', null, href.slice(1));
          }}>
            {link.tokens ? renderInline(link.tokens, st) : link.text}
          </a>
        );
      }
      if (isRelativeDoc) {
        const resolved = st.ctx.vaultKeys ? resolveVaultKey(href, st.ctx.vaultKeys, st.ctx.currentKey) : null;
        return (
          <button
            key={key}
            type="button"
            className={resolved ? 'md-wikilink' : 'md-wikilink md-wikilink-missing'}
            onClick={() => st.ctx.onWikilink?.(href, resolved)}
          >
            {link.tokens ? renderInline(link.tokens, st) : link.text}
          </button>
        );
      }
      // Protocol whitelist: note content (often clipped from arbitrary web
      // pages) is untrusted input, and marked does not sanitise hrefs — a
      // `javascript:` link would otherwise execute on click.
      const protocol = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      const safeProtocol = protocol == null || protocol === 'http' || protocol === 'https' || protocol === 'mailto';
      if (!safeProtocol) {
        return (
          <span key={key} className="md-link md-link-blocked" title="此链接协议不受支持，已禁用">
            {link.tokens ? renderInline(link.tokens, st) : link.text}
          </span>
        );
      }
      return (
        <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="md-link">
          {link.tokens ? renderInline(link.tokens, st) : link.text}
        </a>
      );
    }

    case 'image': {
      const img = token as Tokens.Image;
      return <MarkdownImage key={key} src={img.href || ''} alt={img.text || ''} ctx={st} />;
    }

    default: {
      // Unknown inline token: degrade to its text/raw rather than throwing.
      const anyToken = token as { text?: string; raw?: string; tokens?: Tokens.Generic[] };
      if (anyToken.tokens) return <React.Fragment key={key}>{renderInline(anyToken.tokens, st)}</React.Fragment>;
      return <React.Fragment key={key}>{anyToken.text ?? anyToken.raw ?? ''}</React.Fragment>;
    }
  }
}

const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/;

const CALLOUT_LABEL: Record<string, string> = {
  note: '说明',
  info: '信息',
  tip: '提示',
  hint: '提示',
  success: '完成',
  check: '完成',
  question: '问题',
  important: '重要',
  warning: '警告',
  caution: '注意',
  danger: '危险',
  error: '错误',
  bug: '缺陷',
  example: '示例',
  quote: '引用',
  abstract: '摘要',
  summary: '摘要',
  todo: '待办',
  failure: '失败',
  fail: '失败'
};

function calloutTone(type: string): string {
  const t = type.toLowerCase();
  if (['tip', 'hint', 'success', 'check', 'done'].includes(t)) return 'success';
  if (['warning', 'caution', 'important', 'attention'].includes(t)) return 'warning';
  if (['danger', 'error', 'bug', 'failure', 'fail'].includes(t)) return 'danger';
  if (['question', 'help', 'faq'].includes(t)) return 'question';
  if (['example', 'quote', 'abstract', 'summary', 'todo', 'info', 'note'].includes(t)) return t === 'info' ? 'info' : t === 'note' ? 'note' : 'quote';
  return 'note';
}

function renderBlocks(tokens: Tokens.Generic[] | undefined, st: RenderState): React.ReactNode[] {
  if (!tokens || tokens.length === 0) return [];
  const out: React.ReactNode[] = [];

  tokens.forEach((token, index) => {
    const key = `${token.type}-${index}-${st.keySeed.value++}`;

    switch (token.type) {
      case 'space':
        return;

      case 'heading': {
        const heading = token as Tokens.Heading;
        const id = st.headingIds[st.headingIndex.value++] || slugify(heading.text);
        const Tag = `h${Math.min(Math.max(heading.depth, 1), 6)}` as React.ElementType;
        out.push(
          <Tag key={key} id={id} className={`md-h md-h${heading.depth}`}>
            {renderInline(heading.tokens, st)}
          </Tag>
        );
        return;
      }

      case 'paragraph':
        out.push(
          <p key={key} className="md-p">
            {renderInline((token as Tokens.Paragraph).tokens, st)}
          </p>
        );
        return;

      case 'text':
        // Loose inline token (e.g. directly inside a list item).
        out.push(
          <React.Fragment key={key}>{renderInline((token as Tokens.Text).tokens ?? [token], st)}</React.Fragment>
        );
        return;

      case 'hr':
        out.push(<hr key={key} className="md-hr" />);
        return;

      case 'code':
        out.push(
          <CodeBlock
            key={key}
            code={(token as Tokens.Code).text}
            lang={(token as Tokens.Code).lang}
            showCopy={st.ctx.showCodeCopy !== false}
          />
        );
        return;

      case 'blockquote': {
        const quote = token as Tokens.Blockquote;
        const text = quote.text || '';
        const firstLineEnd = text.indexOf('\n');
        const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
        const match = CALLOUT_RE.exec(firstLine);

        if (match) {
          const type = match[1].toLowerCase();
          const fold = match[2];
          const title = match[3].trim() || CALLOUT_LABEL[type] || type;
          const rest = firstLineEnd === -1 ? '' : text.slice(firstLineEnd + 1);
          const bodyTokens = rest.trim() ? (marked.lexer(rest) as Tokens.Generic[]) : [];

          // Headings inside the callout get a fresh heading cursor: they are
          // re-lexed here, so consuming the top-level headingIds shifted every
          // later real heading's anchor to the wrong section. taskIndex stays
          // shared — toggle positions count all rendered tasks in order.
          const nestedSt: RenderState = { ...st, headingIds: [], headingIndex: { value: 0 } };
          const body = <div className="md-callout-body">{renderBlocks(bodyTokens, nestedSt)}</div>;

          if (fold === '-') {
            out.push(
              <details key={key} className={`md-callout md-callout-${calloutTone(type)}`}>
                <summary className="md-callout-title">{title}</summary>
                {body}
              </details>
            );
          } else {
            out.push(
              <div key={key} className={`md-callout md-callout-${calloutTone(type)}`}>
                <div className="md-callout-title">{title}</div>
                {body}
              </div>
            );
          }
          return;
        }

        out.push(
          <blockquote key={key} className="md-blockquote">
            {renderBlocks(quote.tokens, st)}
          </blockquote>
        );
        return;
      }

      case 'list': {
        const list = token as Tokens.List;
        const Tag = list.ordered ? 'ol' : 'ul';
        out.push(
          <Tag key={key} className={`md-list ${list.ordered ? 'md-list-ordered' : 'md-list-bullet'}`} start={list.ordered ? Number(list.start) || 1 : undefined}>
            {list.items.map((item, itemIndex) => {
              const itemKey = `${key}-i${itemIndex}`;
              if (item.task) {
                const thisIndex = st.taskIndex.value++;
                const bodyTokens = item.tokens.filter((t) => t.type !== 'checkbox');
                return (
                  <li key={itemKey} className="md-task">
                    <input
                      type="checkbox"
                      className="md-task-box"
                      checked={Boolean(item.checked)}
                      onChange={() => st.ctx.onToggleTask?.(thisIndex)}
                      disabled={!st.ctx.onToggleTask}
                    />
                    <span className={item.checked ? 'md-task-text md-task-done' : 'md-task-text'}>
                      {renderListItemBody(bodyTokens, st)}
                    </span>
                  </li>
                );
              }
              return (
                <li key={itemKey} className="md-li">
                  {renderListItemBody(item.tokens, st)}
                </li>
              );
            })}
          </Tag>
        );
        return;
      }

      case 'table': {
        const table = token as Tokens.Table;
        out.push(
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {table.header.map((cell, i) => (
                    <th key={i} style={{ textAlign: cell.align || undefined }}>
                      {renderInline(cell.tokens, st)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={{ textAlign: cell.align || undefined }}>
                        {renderInline(cell.tokens, st)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        return;
      }

      case 'html': {
        const raw = (token as Tokens.HTML).text || '';
        out.push(
          <pre key={key} className="md-raw-block" title="出于安全考虑，原始 HTML 以文本显示">
            {raw}
          </pre>
        );
        return;
      }

      case 'def':
        return;

      default: {
        const anyToken = token as { tokens?: Tokens.Generic[]; text?: string; raw?: string };
        if (anyToken.tokens) {
          out.push(<React.Fragment key={key}>{renderBlocks(anyToken.tokens, st)}</React.Fragment>);
        } else if (anyToken.text || anyToken.raw) {
          out.push(
            <p key={key} className="md-p">
              {anyToken.text || anyToken.raw}
            </p>
          );
        }
      }
    }
  });

  return out;
}

/** List items: unwrap a single paragraph so `<li>` does not get extra block spacing. */
function renderListItemBody(tokens: Tokens.Generic[] | undefined, st: RenderState): React.ReactNode {
  if (!tokens || tokens.length === 0) return null;
  return <>{renderBlocks(tokens, st)}</>;
}

/* -------------------------------------------------------------------- entry */

const MARKED_OPTIONS = { gfm: true, breaks: true, pedantic: false } as const;

/** Stable empty key list: `|| []` allocated a fresh array per render and kept
 * MarkdownImage's effect re-firing on every keystroke. */
const EMPTY_VAULT_KEYS: string[] = [];

export function renderMarkdown(content: string, ctx: MarkdownContext = {}): RenderedMarkdown {
  const { frontmatter, body } = splitFrontmatter(content);
  const tokens = marked.lexer(body, MARKED_OPTIONS) as Tokens.Generic[];

  const headings = collectHeadings(tokens);
  const headingIds = dedupeSlugs(headings);

  const st: RenderState = {
    ctx,
    keys: ctx.vaultKeys ?? EMPTY_VAULT_KEYS,
    taskIndex: { value: 0 },
    headingIds,
    headingIndex: { value: 0 },
    keySeed: { value: 0 }
  };

  const nodes = renderBlocks(tokens, st);

  return {
    frontmatter: frontmatter ? frontmatter.fields : null,
    frontmatterRaw: frontmatter && !frontmatter.parsed ? frontmatter.raw : '',
    nodes,
    headings: headings.map((h, i) => ({ ...h, id: headingIds[i] }))
  };
}

/** Flip the Nth task checkbox (`- [ ]` / `- [x]`) in the source markdown. */
export function toggleTaskInSource(markdown: string, taskIndex: number): string {
  const positions = collectTaskPositions(markdown);
  const target = positions[taskIndex];
  if (!target) return markdown;
  const checked = markdown.slice(target.start + 1, target.end - 1).toLowerCase() === 'x';
  return markdown.slice(0, target.start) + `[${checked ? ' ' : 'x'}]` + markdown.slice(target.end);
}

interface TaskPosition {
  start: number;
  end: number;
}

/**
 * Source offsets of every rendered task checkbox, in render order.
 *
 * The renderer counts tasks while walking `marked.lexer` output, so the toggle
 * must use the same walk. Scanning source lines with a regex disagreed in two
 * ways: `- [ ]` inside a code fence was counted but never rendered, and a task
 * inside a blockquote (`> - [ ]`) was rendered but never matched — clicking the
 * Nth checkbox then flipped the wrong task and corrupted the note.
 */
function collectTaskPositions(markdown: string): TaskPosition[] {
  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(markdown) as Tokens.Generic[];
  } catch {
    return [];
  }
  const positions: TaskPosition[] = [];

  /** Walk tokens whose raws tile the source from `startOffset`; returns the end. */
  const walk = (toks: Tokens.Generic[], startOffset: number): number => {
    let cursor = startOffset;
    for (const tok of toks) {
      const raw = tok.raw || '';
      let at = cursor;
      if (raw) {
        const found = markdown.indexOf(raw, cursor);
        if (found !== -1) {
          at = found;
          cursor = found + raw.length;
        }
      }
      if (tok.type === 'list') {
        const list = tok as unknown as Tokens.List;
        let itemCursor = at;
        for (const item of list.items) {
          const itemRaw = item.raw || '';
          const itemStart = itemRaw ? markdown.indexOf(itemRaw, itemCursor) : itemCursor;
          if (itemStart !== -1 && itemRaw) itemCursor = itemStart + itemRaw.length;
          if (item.task) {
            const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(itemRaw);
            if (m && itemStart !== -1) {
              const bracketStart = itemStart + m[1].length;
              positions.push({ start: bracketStart, end: bracketStart + m[2].length + 2 });
            }
          }
          if (item.tokens && item.tokens.length > 0) {
            walk(item.tokens as Tokens.Generic[], itemStart);
          }
        }
      } else if (tok.tokens && tok.tokens.length > 0) {
        cursor = walk(tok.tokens as Tokens.Generic[], at);
      }
    }
    return cursor;
  };

  walk(tokens, 0);
  return positions;
}

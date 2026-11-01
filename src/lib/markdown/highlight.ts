/**
 * Scoped syntax highlighting.
 * Only the languages notes actually contain are registered, instead of pulling
 * code content can never inject markup.
 */
import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';

const LANGUAGES: Record<string, LanguageFn> = {
  javascript,
  typescript,
  python,
  bash,
  json,
  yaml,
  sql,
  go,
  rust,
  java,
  xml,
  css,
  markdown,
  diff,
  ini
};

const ALIASES: Record<string, string[]> = {
  javascript: ['js', 'jsx', 'mjs', 'cjs', 'node'],
  typescript: ['ts', 'tsx'],
  python: ['py'],
  bash: ['sh', 'shell', 'zsh', 'console'],
  json: ['jsonc'],
  yaml: ['yml'],
  sql: ['mysql', 'postgres', 'postgresql', 'sqlite'],
  go: ['golang'],
  rust: ['rs'],
  java: ['kotlin'],
  xml: ['html', 'htm', 'svg', 'vue'],
  css: ['scss', 'less'],
  markdown: ['md'],
  diff: ['patch'],
  ini: ['toml', 'conf', 'properties']
};

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;
  for (const [name, loader] of Object.entries(LANGUAGES)) {
    try {
      hljs.registerLanguage(name, loader);
    } catch (err) {
      console.warn(`[Self-Hub] failed to register language ${name}`, err);
    }
  }
  for (const [name, aliases] of Object.entries(ALIASES)) {
    try {
      hljs.registerAliases(aliases, { languageName: name });
    } catch {
      // Aliases are a convenience; ignore conflicts.
    }
  }
}

export interface HlSpan {
  text?: string;
  className?: string;
  children?: HlSpan[];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Parse highlight.js output (`<span class="hljs-x">…</span>` + text) into a tree. */
export function parseHighlightHtml(html: string): HlSpan[] {
  const root: HlSpan[] = [];
  const stack: HlSpan[][] = [root];
  const tag = /<span class="([^"]*)">|<\/span>/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const pushText = (text: string) => {
    if (!text) return;
    stack[stack.length - 1].push({ text: decodeEntities(text) });
  };

  while ((match = tag.exec(html)) !== null) {
    pushText(html.slice(last, match.index));
    last = tag.lastIndex;

    if (match[1] !== undefined) {
      // Only accept highlight.js' own class names; anything else renders as text.
      const safeClass = /^hljs[\w\s-]*$/.test(match[1]) ? match[1] : undefined;
      const node: HlSpan = { className: safeClass, children: [] };
      stack[stack.length - 1].push(node);
      stack.push(node.children as HlSpan[]);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  pushText(html.slice(last));

  return root;
}

/**
 * Highlight `code`. Returns null when the language is unknown, so callers can
 * fall back to plain text.
 */
export function highlightCode(code: string, language?: string): HlSpan[] | null {
  registerAll();
  const lang = (language || '').trim().toLowerCase().split(/[\s:,]/)[0];
  if (!lang) return null;

  try {
    if (!hljs.getLanguage(lang)) return null;
    const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return parseHighlightHtml(value);
  } catch (err) {
    console.warn('[Self-Hub] highlight failed', err);
    return null;
  }
}

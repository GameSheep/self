import type { NavSite } from '../types';
import { looksLikeUrl, normalizeCapturedUrl } from './inbox';

/**
 * Turn pasted text into site candidates (2).
 * The user asked for "paste something, the AI recognises the site, then confirm where it goes".
 * Recognition here is deliberately **local and deterministic**: pull URLs out of the text, give
 * · paste must never require AI to be configured, and pasting a private URL into a classifier
 */

export interface RecognizedSite {
  url: string;
  host: string;
  /** Title offered in the confirm dialog; editable. */
  title: string;
  /** Best-guess category, matched against the user's existing categories when possible. */
  category: string;
}

/** Host → category keywords. First match wins; order is roughly "most specific first". */
const CATEGORY_HINTS: Array<{ match: RegExp; category: string }> = [
  { match: /github|gitlab|gitee|bitbucket|stackoverflow|npmjs|pypi/i, category: '技术开发' },
  { match: /docs|readthedocs|developer|api\.|mdn|dev\./i, category: '技术开发' },
  { match: /aliyun|cloudflare|vercel|netlify|aws|azure|tencentcloud|huaweicloud/i, category: '运维部署' },
  { match: /openai|anthropic|deepseek|gemini|huggingface/i, category: 'API与服务' },
  { match: /bilibili|youtube|youku|netflix|spotify/i, category: '影音' },
  { match: /zhihu|juejin|sspai|medium|blog|news|infoq|v2ex/i, category: '知识资讯' },
  { match: /taobao|jd\.com|amazon|shop|mall/i, category: '购物' }
];

const URL_PATTERN = /(https?:\/\/[^\s<>"'）)】]+|(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|io|dev|app|co|me|xyz|top|info|site|tech|ai|cc|tv|so|sh|fm|gg)(?:\/[^\s<>"'）)】]*)?)/gi;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function cleanUrl(raw: string): string {
  return normalizeCapturedUrl(raw.replace(/[.,;、。]+$/, ''));
}

/** A short, readable title from the surrounding text, falling back to the host. */
function titleFor(raw: string, url: string, host: string): string {
  const line = raw
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.includes(url) || (host && entry.includes(host)));
  if (!line) return host || url;
  const withoutUrl = line
    .replace(url, ' ')
    .replace(/https?:\/\//g, ' ')
    .replace(/^\s*[-*•\d.、)）]+\s*/, '')
    .replace(/[|｜:：\-–—]+\s*$/, '')
    .trim();
  return (withoutUrl || host || url).slice(0, 80);
}

function guessCategory(host: string, categories: string[]): string {
  const hint = CATEGORY_HINTS.find((entry) => entry.match.test(host));
  if (hint) {
    // Prefer the user's own category name when it already exists (case-insensitive match).
    const existing = categories.find((c) => c.toLowerCase() === hint.category.toLowerCase());
    return existing ?? hint.category;
  }
  return categories.find((c) => c !== '全部') ?? '常用工具';
}

/**
 * Recognise every distinct site in the pasted text.
 *
 * Deduplicated by URL: pasting the same link twice must not offer two rows.
 */
export function recognizePastedSites(raw: string, categories: string[] = []): RecognizedSite[] {
  const text = raw || '';
  const seen = new Set<string>();
  const out: RecognizedSite[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0];
    if (!candidate) continue;
    // A bare token must look like a URL by the same rule the inbox uses, so the two features
    // agree on what counts as a link.
    if (!/\//.test(candidate) && !looksLikeUrl(candidate)) continue;
    const url = cleanUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const host = hostOf(url);
    out.push({
      url,
      host,
      title: titleFor(text, candidate, host),
      category: guessCategory(url, categories)
    });
  }

  return out;
}

/** Convert confirmed candidates into nav sites (ids and timestamps assigned here). */
export function toNavSites(candidates: RecognizedSite[], now = Date.now()): NavSite[] {
  return candidates.map((candidate, index) => ({
    id: `site-${now}-${index}`,
    title: candidate.title.trim() || candidate.host,
    url: candidate.url,
    category: candidate.category,
    createdAt: now
  }));
}

/**
 * High-Speed Fuzzy & Pinyin Search Engine
 * Supports:
 */
import { PINYIN_CHARS, PINYIN_INITIALS } from './pinyinTable';

/**
 * char -> first letter of its pinyin, built once from the generated table.
 * The table covers the 6763 GB2312 hanzi (essentially all characters used in
 * modern Chinese text), replacing the previous 62-character hand-written map.
 */
let pinyinMap: Map<string, string> | null = null;

function getMap(): Map<string, string> {
  if (pinyinMap) return pinyinMap;
  const map = new Map<string, string>();
  // Both strings are indexed in parallel and the chars are sorted by code point.
  for (let i = 0; i < PINYIN_CHARS.length; i++) {
    map.set(PINYIN_CHARS[i], PINYIN_INITIALS[i]);
  }
  pinyinMap = map;
  return map;
}

/** Latin letters of the pinyin initials for a piece of text. */
export function getPinyinInitials(text: string): string {
  const map = getMap();
  let initials = '';
  for (const char of text) {
    const hit = map.get(char);
    if (hit) {
      initials += hit;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      // Latin/digits are their own initials, so "GitHub2" contributes "github2".
      initials += char.toLowerCase();
    }
  }
  return initials;
}

/**
 * Full pinyin is deliberately NOT generated: it would multiply the bundle size
 * for a feature (typing full pinyin) that initials already cover in practice.
 */
export function matchesQuery(targetText: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const t = targetText.toLowerCase();

  if (t.includes(q)) return true;

  const initials = getPinyinInitials(targetText);
  if (initials.includes(q)) return true;

  const queryTokens = q.split(/\s+/).filter(Boolean);
  return queryTokens.every((tok) => t.includes(tok) || initials.includes(tok));
}

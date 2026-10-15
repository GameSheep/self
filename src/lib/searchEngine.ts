/**
 * High-Speed Fuzzy & Pinyin Search Engine
 * Supports Chinese Pinyin Initials, Full Pinyin, English, and Full-Text Content
 */

// Common Chinese character to pinyin initial mapping
const PINYIN_MAP: Record<string, string> = {
  '阿': 'a', '里': 'li', '云': 'yun', '百': 'bai', '度': 'du', '腾': 'teng', '讯': 'xun',
  '微': 'wei', '信': 'xin', '香': 'xiang', '港': 'gang', '生': 'sheng', '产': 'chan',
  '服': 'fu', '务': 'wu', '器': 'qi', '部': 'bu', '署': 'shu', '控': 'kong', '制': 'zhi',
  '台': 'tai', '仓': 'cang', '库': 'ku', '掘': 'jue', '金': 'jin', '签': 'qian', '到': 'dao',
  '笔': 'bi', '记': 'ji', '安': 'an', '全': 'quan', '密': 'mi', '钥': 'yao',
  '提': 'ti', '醒': 'xing', '续': 'xu', '费': 'fei', '期': 'qi', '少': 'shao',
  '数': 'shu', '派': 'pai', '常': 'chang', '用': 'yong', '测': 'ce', '试': 'shi'
};

export function getPinyinInitials(text: string): string {
  let initials = '';
  for (const char of text) {
    if (PINYIN_MAP[char]) {
      initials += PINYIN_MAP[char][0];
    } else if (/[a-zA-Z0-9]/.test(char)) {
      initials += char.toLowerCase();
    }
  }
  return initials;
}

export function matchesQuery(targetText: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const t = targetText.toLowerCase();

  // 1. Direct substring match
  if (t.includes(q)) return true;

  // 2. Acronym / Pinyin initials match
  const initials = getPinyinInitials(targetText);
  if (initials.includes(q)) return true;

  // 3. Sub-word fuzzy match
  const queryTokens = q.split(/\s+/).filter(Boolean);
  return queryTokens.every(tok => t.includes(tok) || initials.includes(tok));
}

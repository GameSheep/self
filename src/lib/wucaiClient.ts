import { WucaiHighlight, WucaiConfig } from '../types';

export const SAMPLE_WUCAI_HIGHLIGHTS: WucaiHighlight[] = [];

/**
 * Format a Wucai highlight into standard Obsidian Markdown
 */
export function formatWucaiToObsidianMarkdown(hl: WucaiHighlight): { path: string; content: string } {
  const safeTitle = hl.pageTitle.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 40);
  const path = `Clippings/五彩划词-${safeTitle}.md`;
  
  const content = `---
title: "${hl.pageTitle}"
source: "${hl.pageUrl}"
color: "${hl.color}"
tags: [${(hl.tags || []).map(t => `"${t}"`).join(', ')}]
clipped_at: "${new Date(hl.createdAt).toISOString()}"
synced_from: "五彩划词助手"
---

# 📑 网页划词剪藏：${hl.pageTitle}

> **原文出处**: [${hl.pageTitle}](${hl.pageUrl})  
> **标注时间**: ${new Date(hl.createdAt).toLocaleString()}  
> **分类标签**: ${(hl.tags || []).map(t => `#${t}`).join(' ')}

---

### 📌 原文高亮摘录
> [!quote] 核心划线
> ${hl.text}

### 💡 个人想法与批注
${hl.note ? hl.note : '*暂无批注思考*'}

---
*由 Self-Hub 跨平台数据中枢自动同步至阿里云 OSS Obsidian 库*
`;

  return { path, content };
}

/**
 * Fetch Wucai highlights via OpenAPI token or cached data
 */
export async function fetchWucaiHighlights(
  config: WucaiConfig,
  current: WucaiHighlight[]
): Promise<WucaiHighlight[]> {
  if (current && current.length > 0) {
    return current;
  }

  // If user provided a real Wucai OpenAPI token
  if (config.enabled && config.token) {
    try {
      const res = await fetch('https://api.doc.wucai.site/openapi/v1/highlights', {
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Accept': 'application/json'
        }
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json();
        if (Array.isArray(data.items)) {
          return data.items.map((item: any) => ({
            id: item.id || `wc-${Date.now()}`,
            pageTitle: item.title || '网页划线',
            pageUrl: item.url || '',
            text: item.highlight_text || item.text || '',
            note: item.note || '',
            color: item.color || 'yellow',
            tags: item.tags || [],
            createdAt: item.created_at ? new Date(item.created_at).getTime() : Date.now()
          }));
        }
      }
    } catch (e) {
      console.warn('Wucai OpenAPI fetch failed, falling back to cached sample', e);
    }
  }

  return current || [];
}

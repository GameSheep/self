import { WucaiHighlight, WucaiConfig } from '../types';

const WUCAI_COLORS = ['yellow', 'green', 'blue', 'purple', 'red'] as const;

function normalizeWucaiColor(value: unknown): WucaiHighlight['color'] {
  return (WUCAI_COLORS as readonly string[]).includes(value as string)
    ? (value as WucaiHighlight['color'])
    : 'yellow';
}

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
 * Pull highlights from the Wucai OpenAPI and return only the records the app
 * does not already have.
 * Import-only, the same contract as `importExtensionAnnotations`: ids the app
 * · locally edited note can never be clobbered by the cloud copy.
 */
export async function fetchWucaiHighlights(
  config: WucaiConfig,
  knownIds: ReadonlySet<string>
): Promise<WucaiHighlight[]> {
  if (!config?.enabled || !config.token) return [];

  const res = await fetch('https://api.doc.wucai.site/openapi/v1/highlights', {
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`五彩接口返回 ${res.status}${res.status === 401 ? '（Token 无效或已过期）' : ''}`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.items)) {
    throw new Error('五彩接口返回了意外的数据格式');
  }

  const fresh: WucaiHighlight[] = [];
  for (const item of data.items) {
    const id = item && (typeof item.id === 'string' || typeof item.id === 'number') ? String(item.id) : '';
    const text = typeof item?.highlight_text === 'string' && item.highlight_text
      ? item.highlight_text
      : typeof item?.text === 'string' ? item.text : '';
    if (!id || !text || knownIds.has(id)) continue;
    fresh.push({
      id,
      pageTitle: typeof item.title === 'string' && item.title ? item.title : '网页划线',
      pageUrl: typeof item.url === 'string' ? item.url : '',
      text,
      note: typeof item.note === 'string' ? item.note : '',
      color: normalizeWucaiColor(item.color),
      tags: Array.isArray(item.tags) ? item.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
      createdAt: typeof item.created_at === 'string' && item.created_at && !Number.isNaN(new Date(item.created_at).getTime())
        ? new Date(item.created_at).getTime()
        : Date.now()
    });
  }
  return fresh;
}

import { YoudaoNote, YoudaoConfig } from '../types';

export const SAMPLE_YOUDAO_NOTES: YoudaoNote[] = [];

/**
 * Format Youdao note to Obsidian Markdown for direct OSS sync
 */
export function formatYoudaoToObsidianMarkdown(note: YoudaoNote): { path: string; content: string } {
  const safeTitle = note.title.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 40);
  const cleanFolder = note.folder.replace(/^\/+|\/+$/g, '');
  const path = `有道云迁移/${cleanFolder ? cleanFolder + '/' : ''}${safeTitle}.md`;

  const content = `---
title: "${note.title}"
folder: "${note.folder}"
synced_from: "有道云笔记"
synced_at: "${new Date().toISOString()}"
---

${note.content}

---
*由 Self-Hub 跨平台数据中枢从有道云笔记自动迁移至阿里云 OSS Obsidian 库*
`;

  return { path, content };
}

/**
 * Fetch Youdao notes or return cached state
 */
export async function fetchYoudaoNotes(
  config: YoudaoConfig,
  current: YoudaoNote[]
): Promise<YoudaoNote[]> {
  if (current && current.length > 0) {
    return current;
  }
  return current || [];
}

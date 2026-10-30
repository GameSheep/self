import { expect } from '@playwright/test';
import { seedState, baseState } from './helpers';

/** Shared markdown fixture used by the rendering and editor suites. */

export const RICH_NOTE_KEY = 'vault/渲染测试.md';

export const RICH_MARKDOWN = `---
title: 渲染测试
tags: [obsidian, markdown]
pinned: true
---

# 一级标题

正文 **粗体** *斜体* ~~删除线~~ \`行内码\` 与 [[另一篇笔记]]、[[不存在的笔记|缺失链接]] 以及 #标签 结尾。

## 二级标题

> [!note] 提示标题
> 标注块内容包含 **加粗**。

> [!warning]- 折叠警告
> 折叠里的内容

- [ ] 未完成任务
- [x] 已完成任务

1. 有序一
   - 嵌套无序
2. 有序二

| 姓名 | 年龄 | 城市 |
| :--- | :---: | ---: |
| 张三 | 30 | 北京 |

\`\`\`js
const answer = 42;
\`\`\`

![示意图](图片位置/a.png)

---

普通引用：
> 引用第一行
`;

/** Seed the rich note plus a wikilink target so both resolution paths are testable. */
export function seedRichNote(page: any, extraNotes: any[] = []) {
  return seedState(
    page,
    baseState({
      obsidianNotes: [
        {
          key: RICH_NOTE_KEY,
          title: '渲染测试',
          path: RICH_NOTE_KEY,
          size: RICH_MARKDOWN.length,
          lastModified: 1760000000000,
          content: RICH_MARKDOWN
        },
        {
          key: 'vault/另一篇笔记.md',
          title: '另一篇笔记',
          path: 'vault/另一篇笔记.md',
          size: 10,
          lastModified: 1760000000000,
          content: '# 另一篇\n'
        },
        ...extraNotes
      ]
    })
  );
}

export async function openInterop(page: any) {
  // 多平台数据互通 is now 资料库 → 来源与导入 (P1-05), reached by route rather than
  // by a module entry in the sidebar.
  await page.goto('/#/library?view=sources');
  await expect(page.locator('.md-body')).toBeVisible();
}

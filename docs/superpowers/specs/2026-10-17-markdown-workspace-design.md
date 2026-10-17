# Obsidian 级 Markdown 工作区设计

日期：2026-10-17
状态：已实现并验证
范围：「多平台数据互通」页的 Markdown 渲染 + 编辑体验

---

## 1. 背景与问题

「多平台数据互通」页此前把笔记正文当**纯文本**直接塞进 `<pre>` 渲染，而「深度知识文档」页另有一个约 200 行的手写解析器（`NotesView.MarkdownViewer`），只支持 h1–h3、引用、复选框、围栏代码块与粗体/行内码/链接。

由此产生三个问题：

1. 数据互通页完全没有 Markdown 渲染——表格、嵌套列表、图片、代码高亮都看不到；
2. 两套 Markdown 行为不一致（同一段文本在两个页面长得不一样）；
3. 手写解析器在嵌套列表、表格对齐、行内嵌套等场景正确率低，无法达到可用的阅读标准。

## 2. 决策记录

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 依赖策略 | 引入 `marked`（解析）+ `highlight.js`（高亮） | 自研解析器在嵌套结构上不可靠；marked 只做分词，渲染仍由我们控制 |
| 渲染方式 | token → React 元素，**不使用 `innerHTML`** | 五彩剪藏会带入任意网页的内容；不用 innerHTML 就从根上消除 XSS，也无需 DOMPurify |
| 编辑模式 | 编辑 / 分屏 / 预览 三模式 | 与 app 原有「实时分屏预览」承诺一致；比 contenteditable 的 Live Preview 风险低得多、可维护 |
| 语法范围 | 核心集（GFM + 高亮 + 双链 + 标签 + 标注块 + frontmatter + 大纲 + 图片） | 不做 KaTeX/Mermaid，避免 +770KB 的包体 |
| 高亮语言 | `highlight.js/lib/core` 按需注册 15 种 | 全量包约 900KB，按需约 100KB |

## 3. 架构

```
src/lib/markdown/
  frontmatter.ts   YAML frontmatter 剥离 + 极简解析（失败则原文展示）
  entities.ts      [[双链]] / #标签 的文本级切分与库内解析
  highlight.ts     hljs 按需注册 + 输出 HTML → 节点树解析
  render.tsx       token → React；产出 headings；任务清单写回源文本
src/components/
  Markdown.tsx         只读渲染组件（memo 化）
  MarkdownEditor.tsx   三模式编辑器、工具栏、快捷键、滚动同步、状态栏
src/components/OssTree.tsx  目录树（可折叠、分页、搜索，含内容命中）
```

### 关键设计：双链与标签在 text token 渲染时切分

`[[双链]]` 与 `#标签` **不是**用正则预处理整篇原文，而是在渲染 `text` token 时切分。

原因：marked 会把围栏代码、行内代码、普通链接解析成独立 token，因此 `text` token 恰好是双链与标签**可以合法出现**的唯一位置。这样：

- 代码块里的 `[[...]]` 不会被误转成链接；
- URL 里的 `#fragment` 不会被误认成标签；
- 无需担心转义（`\[\[`）与嵌套。

### 安全边界

- 全程不使用 `dangerouslySetInnerHTML`；
- highlight.js 返回的 HTML 由自写栈式解析器处理，**只接受 `hljs-*` 形式的 class**，其余一律按文本渲染；
- 原始 HTML（`<span>` 等）按文本显示并标注"出于安全考虑"；
- 链接一律带 `rel="noreferrer noopener"`。

## 4. 功能清单

- GFM 全量：标题、粗斜体、删除线、行内码、围栏代码块、引用、有序/无序/**嵌套列表**、任务列表、表格（含左/中/右对齐）、分隔线、自动链接、图片
- 代码高亮（js/ts/python/bash/json/yaml/sql/go/rust/java/xml/css/markdown/diff/ini）+ 语言标签 + 一键复制
- `[[笔记]]`、`[[笔记|别名]]`、`[[笔记#标题]]` → 库内跳转；未命中显示为红色缺失样式
- `#标签` → 可点击 chip，点击后作为搜索词过滤目录树
- `> [!note]` / `[!warning]` / `[!danger]` / `[!tip]` / `[!question]` / `[!success]` 标注块，`[!x]-` 支持折叠
- YAML frontmatter → Obsidian 风格「属性」表；列表值渲染为 chip；解析失败则原文展示
- 任务列表可勾选 → 改写源文本并标记「未保存」（不自动写云端）
- 图片：远端 URL 直连；**库内相对路径**经 OSS 签名拉取 → blob URL（内存缓存，离开页面回收）
- 文档大纲（由标题生成，点击滚动定位）
- 编辑器：工具栏 20 个操作、`Ctrl+B/I/K`、`Ctrl+Shift+K` 双链、`Tab`/`Shift+Tab` 缩进、`Ctrl+S` 保存、列表/引用 `Enter` 自动延续、空列表项自动退出、分屏双向滚动同步、模式记忆

## 5. 明确不做

数学公式（KaTeX）、Mermaid、Canvas、关系图谱、插件系统、块引用 `^block`、Live Preview（光标行源码+其余渲染）。

## 6. 性能

实测环境：真实 Bucket `uiuecho-obsidian` 中 338KB / 11.5 万字符的笔记（`WuCai/那些写小说产量很高的作者…`）。

| 指标 | 数值 |
| --- | --- |
| `marked.lexer` 解析 | **7.5ms** |
| 打字延迟（分屏模式，修复前） | 283ms |
| 打字延迟（分屏模式，修复后） | **147ms** |
| 115K 字符渲染总耗时 | 413ms（基线挂载 81ms → 净渲染约 332ms） |
| 真实 34KB 五彩笔记 | 17 标题 / 107 段落 / 15 列表 / 4 代码块 / 1 表格 / 13 条 frontmatter 属性 / 15 图片，无控制台错误 |

优化手段与选型：

- `highlightCode` 以 `(code, lang)` 记忆化，滚动/重渲染不重复高亮；
- `<Markdown>` 用 `React.memo`，`previewCtx` 的每个回调都是稳定身份（通过 `latestRef` 读取最新状态），避免按键击穿 memo；
- 分屏预览用 `useDeferredValue` 降到低优先级，状态栏显示「预览更新中…」；
- **阅读视图不延迟**：勾选任务复选框必须即时反馈（延迟会让勾选弹回）。

## 7. 与既有代码的集成

- `DataInteropView`：只读区 → `<Markdown>`；编辑器 → `<MarkdownEditor>`；保存链路沿用既有 `handleSaveObsidian`（已能如实反馈 OSS 失败）。
- `s3Client` 新增 `fetchOssObjectBlob()` 供图片/附件使用。
- `NotesView` 的 200 行手写解析器已删除，统一改用 `<Markdown>`（消除两套行为）。
- 顺带修复：`[[双链]]` 在目录树尚未加载时一律判为缺失（`vaultKeys` 现在合并 `obsidianNotes`）；从 OSS 刷新时云端列表为空会清空本地笔记元数据（现改为合并，保留仅本地存在的笔记）。

## 8. 测试

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `tests/e2e/markdown.spec.ts` | 14 | 标题/锚点、行内格式、frontmatter 属性表、双链（命中+缺失）、标签、标注块（普通+折叠）、任务清单、嵌套列表、表格对齐、代码高亮、引用分隔线、图片占位、签名图片→blob、大纲 |
| `tests/e2e/markdown-editor.spec.ts` | 11 | 三模式、工具栏加粗/标题、`Ctrl+B`、`Tab`、`Enter` 延续任务与有序列表、脏标记、分屏实时预览、任务勾选写回、`Ctrl+S` → PUT |

包体：JS 544.16 → 699.86 kB（gzip 144.76 → **195.72 kB**，+51KB）；CSS 39.84 → 48.98 kB（gzip +2.2KB）。

## 9. 风险与后续

| 风险 | 现状 |
| --- | --- |
| marked token 结构随版本变化 | 已 pin `marked@18.1.1`；渲染器对未知 token 回退为文本，不抛错 |
| 超长文档首次渲染约 0.4s | 已接受。若要进一步优化需分块渲染或虚拟滚动，属独立工作 |
| 高亮语言可裁剪 | 修改 `src/lib/markdown/highlight.ts` 的 `LANGUAGES` 即可，每减少一种约省 3–10KB |
| 标签检索范围 | 仅对**已加载正文**的笔记生效；完整标签索引需要扫描全库，未做 |

---

## 10. 追加：桶内文件操作（2026-10-17 第二轮）

产品视角复核后补齐的 5 个高频缺口，全部已实现并验证：

| 缺口 | 实现 |
| --- | --- |
| 写笔记时贴图无反应 | 编辑器 `onPaste` / `onDrop` → `putOssObject` 上传到附件目录（`{prefix}图片位置/`，文件名带时间戳）→ 自动插入 `![](路径)`；支持多文件，状态栏显示上传计数 |
| 文件/目录不能重命名或移动 | 行内 hover 操作 → 路径编辑弹窗；文件用服务端 COPY（`x-oss-copy-source` 参与签名）+ DELETE；目录用「先全部复制成功、再删源」的两段式，失败不丢数据；拒绝移动到自身子目录 |
| 附件是死的 | 点击图片附件在右侧签名拉取后预览（blob URL）；非图片非文本给出明确提示 |
| 没有"最近打开" | 最近 8 篇记在 localStorage，树上方 chip 直达 |
| 不能建目录/上传本地文件 | 工具栏「新建目录」（零字节 `dir/` 占位对象）与「上传文件」 |

关键实现细节：

- `generateOssAuthHeaders` 现接受额外 `x-oss-*` 头，排序后并入 CanonicalizedOSSHeaders（`x-oss-copy-source` 排在 `x-oss-date` 前）。已对真实 Bucket 验证 COPY 返回 200。
- `moveOssFolder` / `deleteOssFolder` 先列举再逐个处理，复制失败的对象不会删除源。
- 树行操作按钮改为**绝对定位覆盖**在大小/计数之上：此前 hover 时隐藏大小会让按钮左移到光标下，导致"点文件却弹出重命名"。

过程中发现并修复的两个真实缺陷：

1. **`npm run build` 被自己写坏**：源码里出现 `[-:T]` 正则字符类，被 Tailwind 的 content 扫描当成工具类生成非法 CSS，`lightningcss` 直接报错、构建失败。改用 `\D` 并避免在注释里写该字符类。
2. **前缀包裹时树是收起的**：前缀为 `vault/` 时根下只有一个目录，用户看到的是"一个关着的文件夹"。现在若根下仅有一个目录则自动展开。

测试：`tests/e2e/vault-ops.spec.ts`（7 条）覆盖粘贴上传、重命名 COPY、新建目录、图片预览、最近打开、上传按钮、目录移动自环保护。全量 60 条通过。

真实桶回归（扩展环境）：建目录 → 上传图片 → 刷新计数 → 重命名 → 删除目录 → 清理，最终对象总数回到 1951，确认无残留、无数据丢失。


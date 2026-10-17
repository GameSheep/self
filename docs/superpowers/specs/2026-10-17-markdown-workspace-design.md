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

---

## 11. 追加：数据安全（2026-10-17 第三轮）

产品复核后，剩余风险里最重的是**不可逆**的两项，本轮补齐：

### 11.1 保存冲突检测

场景：桌面 Obsidian 通过 Remotely Save 写回同一文件，网页端此时保存会**静默覆盖**对方的版本。

实现：

- 打开笔记时记录云端「冲突令牌」：`lastModified`（列表的 `LastModified`）+ `etag`（列表的 `ETag`）。
- 保存前先 `HEAD`，若云端 `Last-Modified` 比基线新（容差 1.5s），或 ETag 变化，则**中止写入**并返回 `conflict`。
- UI 弹出三选一对话框：**重新加载云端版本** / **仍然用我的版本覆盖**（显式 `force`）/ **先不保存**。未做选择前不写入任何字节。
- ETag 兜底：CORS 只暴露了 `ETag` 而未暴露 `Last-Modified` 时（网页版常见），仍能检测冲突。

### 11.2 回收站

- 删除不再直接抹掉：文件/目录被**复制到 `.trash/<原路径>`**（保留目录结构），复制成功后才删除原对象。
- `.trash/` 内的条目提供「从回收站恢复」动作（服务端复制回原路径 + 清理回收站副本），恢复失败不会动原文件。
- `.trash/` 内的再次删除才是永久删除，确认文案会明确区分。
- 目录删除同样两段式：先全部复制成功，再删源。

### 11.3 真实桶回归（扩展环境）

```json
{ "baseline_objects": 1951, "probe_created": 200, "probe_visible": true,
  "loaded_content": true, "external_write": 200,
  "conflict_dialog": true,
  "after_force_save_has_local_content": true,
  "original_after_delete": 404, "trash_has_copy": 200,
  "restore_button_visible": true, "restored_to_original": 200,
  "final_objects": 1951, "baseline_restored": true }
```

即：外部改写后保存**确实被拦截**；强制覆盖后内容正确；删除后原对象 404 而 `.trash/` 有副本；恢复后原路径 200；对象总数回到基线。

### 11.4 本轮回归测试

`tests/e2e/trash-conflict.spec.ts`（7 条）：删除进回收站、回收站恢复、冲突拦截且不写入、强制覆盖、无冲突正常保存、重新加载云端版本、ETag 兜底。

顺带修复：目录树展开此前是"根下仅一个目录才自动展开"的启发式，`.trash/` 出现后失效；改为按配置前缀显式展开。

---

## 12. 追加：全库全文搜索与反向链接（2026-10-17 第四轮）

### 12.1 问题

OSS 没有全文检索能力，目录树只认识文件名。库里有 1700 篇 Markdown，"哪篇提到过 Redis"这类问题只能逐篇打开。

### 12.2 方案

`src/lib/vaultIndex.ts`：本机 IndexedDB 全文索引（独立库 `self_hub_vault_index`，不动主数据，避免 schema 迁移风险）。

- **增量构建**：以列表里的 `LastModified` + `Size` 判断是否需要重抓，只抓新增/变化的笔记；并发 4，带进度回调与进度条。
- **抽取**：`extractTags()`（frontmatter `tags: [a,b]`、`tags:` 列表块、正文 `#tag`，并跳过围栏代码块避免 `#include` 噪声）；`extractWikilinks()`（跳过代码，归一化去掉别名与 `#标题`）。
- **检索**：标题 → 正文 → 标签（`#tag` 精确）→ 双链，返回带上下文的片段与命中偏移。
- **反向链接**：索引里哪篇的 `links` 指向当前笔记。

UI：「文件名 / 全文」范围切换、索引状态与「建立/更新索引」、进度条、结果列表（字段徽标 + 高亮片段）、笔记头下方的反向链接条。

### 12.3 真实库实测

```
对象 1951 → 索引 1700 篇，耗时 15.1 秒（并发 4）
搜索 "RAG Fusion" → 1 条命中 WuCai/RAG进阶…，片段与高亮正确
打开笔记正常
```

### 12.4 过程中修复的缺陷

片段高亮**偏移错位**：`makeSnippet` 先把片段里的连续空白折叠成一个空格，却仍用原始索引做偏移计算，导致高亮整体偏移（实测把 `Redis` 高亮成了 `edis `）。改为在最终片段中重新定位命中文本。

### 12.5 测试

`tests/e2e/vault-search.spec.ts`（9 条）：未建索引时引导、正文搜索+高亮、点击结果打开、`#标签` 精确检索、双链检索、文件名模式不走索引、反向链接显示/跳转/不显示。

### 12.6 观察

该用户的库以网页剪藏为主，几乎不含 `[[双链]]`，因此反向链接在实际数据里很少出现；价值主要在**正文检索**与**标签筛选**。反向链接功能保留，供以后建立手写笔记体系时使用。

---

## 13. 追加：索引接入全局搜索 + 自动增量更新（2026-10-17 第五轮）

### 13.1 Ctrl+K 接入全文索引

索引建好却只能在一个页面里用，等于没接上最高频入口。现在 `Ctrl+K` 面板会在打开时懒加载本地索引，把正文命中单独分组为「正文·<目录>」，回车即可跳转：

- 新增 `onSelectVaultNote(key)`，App 侧切换 tab 并传递 `focusVaultKey`；
- `DataInteropView` 监听 `focusVaultKey`，直接按 key 打开（含未加载过的笔记，会按需拉正文）。

### 13.2 自动增量更新

每次「从 OSS 刷新」后，若有已存在的索引且列表签名（对象数 + 最大 `LastModified`）变化，就在后台跑一次增量索引：只抓新增/变化的笔记，完成后提示「索引已增量更新（N 篇有变化）」。无变化时完全不发请求。

### 13.3 真实库实测

```
索引 1700 篇：14.1 秒
Ctrl+K 输入 "RAG Fusion" → 出现「正文·」分组
回车 → 跳转到数据互通页并打开目标笔记（正文包含 RAG）
再次刷新目录 → 已索引仍为 1700（无变化不重抓），无报错
```

### 13.4 测试

`tests/e2e/global-search-vault.spec.ts`（3 条）：Ctrl+K 正文命中并跳转、索引里没有的内容不误报、刷新后新增笔记自动进入索引。

---

## 14. 追加：服务器在线状态改为真实探测（2026-10-17 第六轮）

### 14.1 问题

新建服务器时三处代码直接写 `status: 'online'`（`AddItemModal`、`AiIngestModal`、`aiParser`），仪表盘的「N/M 运行中」因此是**编造的数据**——从没探测过任何端口。这是诚实性问题，不只是功能缺失。

### 14.2 方案

`src/lib/serverHealth.ts`：

- 类型新增 `'unknown'`：**未探测 ≠ 离线**，两者必须能区分。
- `probeUrlFor()`：优先 `healthUrl`，其次绑定域名；只有 IP+端口时返回 `null`（浏览器无法建立 TCP 连接，不能假装能测）。
- `checkServerHealth()`：8 秒超时；2xx / 401 / 403 都算在线（401/403 证明服务可达）；5xx 与超时算不可达；CORS 拦截时退化为 `no-cors` 探测——**能拿到 resolve 就说明主机有应答**，但明确标注「跨域被拦截，无法读取状态码」。
- 无地址可探测时返回 `unknown` 并说明原因，而不是猜一个状态。

UI：卡片上显示真实状态徽标（在线 / 不可达 / 未探测）+ 检测时间 + 探测结果；新增「检测」与「全部检测」；仪表盘把「运行中」改成「在线」，并单独显示「N 未探测」。新增服务器时表单增加「健康检查 URL（可选）」字段——否则只有绑定域名才能检测。

### 14.3 测试

`tests/e2e/server-health.spec.ts`（8 条）：默认未探测、检测成功记录延迟、401 算在线、5xx 不可达、无地址说明原因、全部检测、新建时填写健康 URL、仪表盘只计在线。

---

## 15. 追加：签到按日记录与到期通知（2026-10-17 第七轮）

### 15.1 签到：连续天数是编出来的

原实现只有 `streakDays`，每执行一次就 +1。同一天点两次 "打卡" 会变成连续 2 天，且没有任何"哪天签了 / 哪天漏了"的记录。

`src/lib/checkInHistory.ts`：

- 新增 `CheckInRun { date(YYYY-MM-DD, 本地), at, status, message }`，每个本地日期**只保留一条**（重复执行覆盖当天记录）。
- `computeStreak()` **由历史推导**而不是累加：今天签了就从今天往前数，今天没签但昨天签了也从昨天往前数（当天尚未执行的宽限）。
- `recentDays()` 产出最近 14 天状态，卡片上渲染成 14 个小方块（成功/失败/未签，今天带描边），并显示「今日已签」。
- 展示时优先用历史推导，避免旧数据里 `streakDays` 与历史不一致。

### 15.2 提醒：关掉页面就完全不会提醒

`src/lib/reminderNotifier.ts`：

- 到期前 3 天内 + 已过期的未完成项会推送系统通知；每项**每天最多一次**（localStorage 记账，多标签页不轰炸）。
- 未授权时返回 `blocked` 列表，由提醒页展示开启入口；明确写出浏览器限制：**仅在页面打开时提醒**，不承诺后台闹钟。
- 权限三态（granted / denied / unsupported）分别给出对应说明，而不是笼统提示。

### 15.3 测试

`tests/e2e/checkin-and-reminders.spec.ts`（7 条）：同日重复签到不累加、14 天记录反映真实状态、昨天签过今天没签仍算连续、授权后推送、同日刷新不重复、未授权给入口、已完成/远期不通知。

---

## 16. 追加：扩展内真实后台提醒（2026-10-17 第八轮）

### 16.1 问题

上一轮的提醒只能"页面打开时"生效——用户关掉标签页就再也没有提醒。而"提醒"这个词的承诺恰恰是**不需要盯着页面**。

### 16.2 方案

浏览器页面无法后台运行，但**扩展的 Service Worker 可以**（浏览器启动期间）。因此：

- `manifest.json` 增加 `alarms` 与 `notifications` 权限。
- `extension/background.js`：
  - `chrome.alarms.create('selfhub_reminder_check', { periodInMinutes: 30, delayInMinutes: 1 })`，在 `onInstalled` / 模块加载 / `onStartup` 时确保存在（浏览器重启会清空 alarm）。
  - 到期判定：未完成、`targetDate` 在未来 3 天内或已过期。
  - 每项**每个本地日期只通知一次**，账本存 `chrome.storage.local['selfhub_reminder_notified']`，并清理 30 天前的记录。
  - 点击通知打开应用页。
- `src/lib/extensionBridge.ts`：`publishRemindersToExtension()` 把提醒推给 worker（`PUBLISH_REMINDERS`），worker 收到后**立即检查一次**，不必等 30 分钟；`requestReminderCheck()` 供改期后手动触发。
- **避免重复通知**：在扩展环境内，页面侧的 `notifyDueReminders` 直接跳过，通知权归 worker。

### 16.3 真实扩展实测

```
alarms: ["selfhub_reminder_check"]
PUBLISH_REMINDERS → { success: true, due: 1, notified: 1, skipped: 0 }
notifications: 1（仅过期项；远期与已完成均未通知）
ledger: ["r-due_2026-10-17"]
同日再次 publish → { due: 1, notified: 0, skipped: 1 }
```

即：alarm 已注册、按需即时通知、只通知该通知的、当天不重复。

### 16.4 测试

`tests/e2e/checkin-and-reminders.spec.ts` 增加 2 条（共 9 条）：提醒会发布给后台 worker 且扩展内不重复通知、普通网页环境不会误发扩展消息。

### 16.5 过程中的一次失误（记录在案）

写 `extensionBridge.ts` 时我直接 `write` 覆盖了文件，而它**原本已存在**（负责把站点/批注镜像到 `chrome.storage.local`），等于删掉了一个正在工作的功能。构建前的 `tsc` 立刻报出 `Cannot find name 'mirrorStateToExtension'`，随后从 git 取回原实现并把提醒发布逻辑合并进去。教训：写文件前先确认是否已存在。

---

## 17. 追加：全文索引管理（2026-10-17 第九轮）

### 17.1 问题

索引只存在于 IndexedDB，界面上只有一行「已索引 N」。出问题（结构变更、数据损坏、想省空间）时唯一出路是清整站数据——这是全应用唯一"出问题后用户无法自救"的地方。

### 17.2 方案

- 索引面板：篇数、缓存正文字数、带标签篇数、最后更新时间、浏览器报告的本站存储用量。
- 三个动作：**更新索引**（增量）/ **重建索引**（清空重抓）/ **清除索引**（只删本机缓存，云端不受影响）。
- 元信息写在 `localStorage['selfhub_index_meta']`。
- **损坏自愈**：`loadIndex()` 读失败时自动重置索引库并重试一次，而不是让搜索永久失效。

### 17.3 修掉的一个真实缺陷

原 `resetIndexDatabase()` 直接 `indexedDB.deleteDatabase()`，而删除会被未关闭的连接**阻塞**；`onblocked` 里我也直接 resolve 了，于是"清除/重建"在库仍被占用时继续执行，写入落进一个即将被删除的数据库——表现为"界面显示已索引 2 篇，库里其实是 0 篇"。

改为：优先 `store.clear()`（无版本变更、不会阻塞），只有清不掉（结构损坏、store 不存在）才真正删库，且删库有超时兜底。

### 17.4 真实库实测

```
已索引笔记 1700 篇 | 缓存正文字数 421.4 万字 | 含标签 648 篇
最后更新 2026/10/17 18:41:45 | 本站已用存储 5.0 MB / 52 GB
清除后：已索引 0，IndexedDB docs 计数 0
```

面板最初把"云端对象大小之和"当作索引体积显示（6.7 MB），与浏览器报告的 5.0 MB 相互矛盾。改为报告**精确字符数**（4.21 亿字符的十分之一量级），字节数只引用浏览器自己的统计（IndexedDB 底层有压缩，二者本就不应相等）。

### 17.5 测试

`tests/e2e/index-management.spec.ts`（4 条）：面板数字、清除后库为空且回到引导态、重建后能重新搜到、数据库结构损坏时自动恢复。

---

## 18. 追加：全量状态云备份（2026-10-17 第十轮）

### 18.1 问题

页面叫「多平台数据互通」，但**只有 Obsidian 笔记真的在云上**。站点、提醒、项目、收件箱、批注、签到记录全部只存在本机 `localStorage`。换一台设备、清一次站点数据，这些就没了。

### 18.2 方案

`src/lib/stateBackup.ts`：

- 把整个 `HubState` 打包成 `{ version, updatedAt, deviceId, state }`，写入 `<prefix>.selfhub/state.json`（跟随目录前缀）。
- **防覆盖**：写之前先 `HEAD` 比对 `Last-Modified` 与"上次成功备份时记录的基线时间"。若云端更新（另一台设备写过），**不覆盖**，而是把本机快照另存到 `.selfhub/conflicts/state-<时间戳>-<设备>.json` 并如实告知。
- 自动备份：状态变化后 **5 秒防抖**合并成一次上传；首次渲染不写；未配置 OSS 时完全不发请求。
- 恢复：读取并校验云端快照（`validateHubState`），确认后覆盖本机；格式无法识别时明确报错而不是写入垃圾数据。
- `deviceId` 是每浏览器一次的随机标识，用于标注备份来源与冲突文件名。

UI：设置 →「备份与恢复」页新增一块：上次备份时间、当前状态、**立即备份**、**从云端恢复**。

### 18.3 测试暴露的产品缺陷

「立即备份」最初硬编码 `force=true`，即**无条件覆盖云端**——正好是这套机制要防的事。改为手动备份同样走冲突检查，冲突时弹出"云端更新，是否用本机覆盖"由用户决定。

### 18.4 真实桶实测

```json
{ "baseline_objects": 1951, "backup_status_before": "尚未自动备份",
  "backup_status_after": "刚刚备份", "remote_get_status": 200,
  "remote_envelope": { "version": 1, "has_state": true, "sites": 6, "device": "dev-77pjj9kfi5" },
  "theme_after_toggle": "light", "theme_after_restore": "dark",
  "objects_after_cleanup": 1951, "selfhub_prefix_left": 0, "baseline_restored": true }
```

即：备份真的落盘且结构正确；本机改成 light 后从云端恢复回 dark；探针数据已清理，桶内对象数回到基线。

### 18.5 测试

`tests/e2e/state-backup.spec.ts`（5 条）：状态变化自动备份、手动立即备份、云端更新时另存冲突副本而不覆盖、从云端恢复、未配置 OSS 时不发请求。

---

## 19. 追加：WebDAV 备份目标（2026-10-17 第十一轮）

### 19.1 起因

用户想用 InfiniCLOUD（原 TeraCloud）作为备份位置，一直连不上。排查过程本身就是一节"如何诚实报错"的课：

| 探测 | 结果 |
| --- | --- |
| `OPTIONS /dav/` | 200，`DAV: 1,2`（服务器活着） |
| `PROPFIND` 带三组不同密码 | **全部 401**（连错误密码也是 401，无法区分原因） |
| 跨域预检 | 200 但**没有任何 `Access-Control-Allow-Origin`** |
| 换用账号真实节点 `kurio.infini-cloud.net` | **207，读到 3 个条目** ✅ |

结论：403/401 时"密码错了"只是可能性之一——**URL 指向的节点不对**才是真因。旧地址 `toi.teracloud.jp` 是共享节点，账号实际在 `kurio.infini-cloud.net`。

### 19.2 实现

`src/lib/webdavClient.ts`：

- `testWebdav()` 用 PROPFIND 探测，把状态码翻译成可执行结论：401 →「应用密码 / 外部应用连接」，404 →「URL 是否以 /dav/ 结尾」，403 →「账号被禁止外部访问」，网络异常 →「可能是 CORS（普通网页会被拦截，需扩展环境）」。
- `putWebdavFile()` / `getWebdavFile()`，写入前逐级 `MKCOL`（405/409 视为已存在）。
- 全部请求带 Basic Auth，UTF-8 用户名用 TextEncoder 转 Base64（`btoa` 直接传非 Latin1 会抛错）。

接入备份体系：

- `backupStateToWebdav()` / `readStateBackupFromWebdav()` 复用同一套信封格式。
- WebDAV 没有可靠的响应头 mtime，冲突检测改为比较信封里的 `updatedAt` 与上次备份时间；更新则另存 `conflicts/` 不覆盖。
- `webdavConfig.enabled` 为真时**备份自动改走 WebDAV**，否则用 OSS。

### 19.3 真实账号实测

```
测试连接：✅ 连接成功，1052ms
保存配置：webdavConfig.enabled = true
立即备份：刚刚备份
主题 dark → 切成 light → 从云端恢复 → dark ✅

服务器侧：/dav/selfhub_sync/state.json 4258 字节
内容：{"version":1,"deviceId":"dev-8dlog6b8mk","state":{...theme:"dark"...}}  sites=6
清理后根目录只剩 2 个 welcome pdf
```

### 19.4 发现的冲突点（待决策）

探测时发现 `/dav/self/` 下有 `sites.json`(128 个站点) / `annotations.json` / `inbox.json` / `manifest.json`，`lastSyncTime` 与探测同一分钟——这是**用户自己浏览器里的扩展**（`pathPrefix = "self"`）在同步，不是本次代码所写，因此未删除。

于是现在存在两套并行同步：扩展的 SyncManager（`self/`，站点/批注/收件箱）与本应用的备份（`selfhub_sync/`，全量状态）。两者尚未打通，后续需要统一路径与数据边界。

### 19.5 测试

`tests/e2e/webdav.spec.ts`（8 条）：207 成功、401 归因、网络失败归因、缺字段不发请求、配置持久化、目标路径预览、启用后备份改走 WebDAV、云端更新时另存冲突副本。

---

## 20. 重构：配置收敛为声明式注册表（2026-10-17 第十二轮）

### 20.1 用户反馈

> 这些配置好乱啊，一会这个配置一会那个配置，整个系统很混乱，功能之间也非常的耦合，重构一下

排查后确认不是"摆放位置"的问题，而是**结构性重复**：

| 症状 | 根因 |
| --- | --- |
| 同一份配置要在多处维护 | 每个集成各写一段表单 JSX、各有一份 `useState` 镜像、各自判断"是否已配置" |
| 概览状态与表单不一致 | 概览里另抄了一份 `configured/detail` 判断逻辑 |
| 改 A 会覆盖 B | 底部「保存配置」把 `useState` 里的旧副本整体写回 state |
| 五彩 Token 两处可改 | 业务页弹窗与设置各存一份 |

### 20.2 方案：注册表驱动

新增 `src/lib/integrations.ts`，一个集成 = 一条声明：

```ts
{ id, title, description, section, fields[],
  read(state),            // 从 state 取值（唯一真相）
  write(state, values),   // 写回，保留无关字段
  isConfigured(state),    // 是否可用
  describe(state),        // 状态摘要
  target(state, draft) }  // 目标路径预览
```

- 设置界面由 `IntegrationCard` 按 `fields` 生成，**没有任何集成专属的表单代码**。
- 概览的状态板直接 `INTEGRATIONS.map(...)`，不再有第二份判断。
- 保存改为**字段失焦即保存** + 卡片上的显式保存按钮；底部按钮只做确认，不再写回缓存副本（这正是之前"旧值覆盖新值"的来源）。
- 新增一个连接 = 注册表加一条 + 一个 `HubState` 字段槽位，不再动设置界面。

### 20.3 过程中发现的真实缺陷

重构后跑测试时发现 DOM 里**同时存在两套 OSS/AI 表单**：旧的定制表单没被完全删除，与新的注册表卡片一起渲染。因为两者选择器不同（旧的是 placeholder，新的是 `data-field`），测试没报错——功能上却是两份输入框，正是用户抱怨的现象。

已删除旧表单与随之失效的 `ossBucket/aiProvider/...` 等 12 个 `useState`、4 个不再需要的更新回调 prop、以及失效的 import。

新增回归测试专门钉住这一点：**每个集成在设置里只能渲染一份表单**，字段数量也做断言。

### 20.4 结果

- 设置弹窗从 954 行降到约 590 行，配置相关逻辑集中在一个注册表里。
- `tests/e2e/settings-ia.spec.ts`（7 条）：概览状态、六分区可达、跳转、五彩唯一入口、**防重复表单**、备份唯一入口。
- 全量 120 条测试通过。

### 20.5 仍未解决（下一轮）

- `App.tsx`（约 970 行）仍是上帝组件：状态、副作用、所有业务回调与渲染都在一起，需要拆 `useHubState` / `useCloudBackup` / `useReminderNotifications`。
- 扩展 `options.html` 的同步配置与应用设置是两套存储（`chrome.storage` vs `localStorage`），路径也不同（`self/` vs `selfhub_sync/`）。












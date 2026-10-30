# 新标签页：可自定义模块面板

新标签页（`extension/newtab.html`）从一张写死的三栏，变成「模块面板」：每张卡片都能
拖动改大小、换位置、换数据来源，也能删掉或再加一张。

![新标签页模块面板](newtab-dashboard.png)

## 用户能做什么

| 操作 | 怎么做 | 存在哪 |
| --- | --- | --- |
| 改模块高度 | 拖卡片底边（或聚焦底边后按 ↑/↓，Shift 一次 64px） | `height`（px） |
| 改列宽 | 拖两栏之间的细线 | `columns[].fr`（比例） |
| 换位置 / 换栏 | 拖卡片标题（触屏用 `⋯` 里的上移 / 下移 / 移到左栏 / 移到右栏） | `column` + 数组顺序 |
| 换数据来源 | 卡片右上 `⋯` → 数据来源 | `source` |
| 加模块 | 每栏底部「＋ 添加模块」 | 新增 module |
| 删模块 | `⋯` → 删除模块 | 只删布局，不动数据 |
| 恢复默认 | 顶栏「重置布局」 | 覆盖为默认三栏 |

列宽存**比例**不存像素：窗口变宽时三栏按比例一起长，不会出现 1px 的缝或横向滚动条。
模块高度存像素：「我就要这么高」是明确意图，不该随窗口缩放。

## 模块类型

| 类型 | 内容 | 可选来源 |
| --- | --- | --- |
| `notes` 笔记 | 最近编辑的笔记 | 最近更新 / 指定文件夹 |
| `quicknote` 文本框 | 写完直接存成一条笔记 | 存到根目录 / 指定文件夹 |
| `capture` 记一笔 | 进收件箱，回工作台整理 | — |
| `pinned` 常用网站 | 点过 ☆ 的网站 | — |
| `sites` 全部网站 | 按分类成组，卡片套卡片 | 全部分类 / 只看某一类 |
| `checkins` 签到网站 | 一点就开的签到页 | — |
| `reminders` 提醒 | 按到期时间排序 | 全部 / 指定分类 |
| `annotations` 网页批注 | 最近划的词和批注 | 全部 / 指定网站 |

「网站」模块里是**卡片套卡片**：模块本身一张卡，每个分类一张子卡（`.subcard`），
每个网站还是一张卡（`.site-card`）。子卡按内容收缩，只有一两个网站的分类不会拉成
一条空荡荡的长卡。

## 文本框 → 笔记：为什么走队列

新标签页**不能直接写库**：工作台是 v2 负载 / v3 库的唯一写入方，第二个写入方正是
以前丢更新的原因。所以文本框把笔记追加到 `chrome.storage.local.selfhub_pending_notes`
（按 id 幂等），工作台打开或收到 `storage.onChanged` 时把它收进 `notes`，然后把这批
id 从队列里删掉（重新读队列再过滤，避免把导入期间新写的笔记一起清掉）。

- 新标签页会把自己刚写的笔记混进「笔记」模块显示，不用等工作台才看得到。
- 工作台没开着也不会丢：下次打开工作台时导入。
- 导入后队列清空，不会重复导入同一条。

## 代码结构

- `extension/newtab-dashboard.js` — 布局引擎：列宽 / 高度拖拽、HTML5 拖拽换位、
  添加 / 删除 / 数据来源弹层、`chrome.storage.local.selfhub_newtab_layout` 持久化。
  这一层不碰业务数据，模块内容由外部 `renderBody(module, bodyEl)` 画。
- `extension/newtab.js` — 数据读取（v2 负载 + v3 IndexedDB）、每个模块类型画什么、
  搜索、主题、待导入笔记队列。
- `extension/newtab.css` — 面板、拖拽条、模块卡、嵌套网站卡、文本框。
- `src/lib/extensionBridge.ts` — `readPendingNotes` / `acknowledgePendingNotes`。
- `src/App.tsx` — 启动 + `storage.onChanged` 时把队列收进 `notes`。

## 约束

1. 只有布局变化才重建 DOM；数据刷新（点 ☆、切来源）只重画 `body`，否则会丢焦点和滚动位置。
2. `chrome.storage.local` 里的常用网站 id，只有在**确实读到网站数据**时才裁剪失效项——
   数据没加载完就按「找不到就删」会清空用户的收藏。
3. 模块 `hidden` 必须显式写 `.module[hidden] { display: none }`：`.module` 是 flex 容器，
   会盖掉 `hidden` 的默认样式（签到模块没有站点时靠这条隐藏）。
4. 窄屏（≤1180px）单列堆叠，拖拽条隐藏、固定高度失效，避免手机上一屏一张卡。

## 验证

```powershell
npx playwright test --config=playwright.extension.config.ts
```

`tests/e2e/newtab-dashboard.spec.ts`（8 条）覆盖：拖高 / 拖列宽（刷新后仍在）、
拖标题换栏、加文本框并把内容变成笔记、按文件夹换来源、网站卡片套卡片与分类 chip、
文本框 → 打开工作台能看到这条笔记且队列清空、删模块持久化与重置布局。

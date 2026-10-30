# Self-Hub 功能矩阵（P0-01 代码核对）

日期：2026-10-18 ｜ 基线提交：`a1b8c37`（`feat(privacy): mask unlabelled high-entropy tokens before sending to cloud AI`）

**核对方法**：本矩阵不是把 `README.md`／`ROADMAP.md` 中的“已完成”抄过来，而是逐个打开源码读出来的：先读 `PRODUCT.md`、设计评审稿与实施计划，再读 `src/App.tsx`、`src/components/**`、`src/hooks/**`、`src/lib/**`、`extension/**` 与 `tests/e2e/**`，然后用 grep 反查每个模块是否真的有调用点（例如 `wucaiClient`／`youdaoClient` 的拉取函数、`vaultIndex` 的索引搜索、`automation.ts` 的调度、`cloudflareSync` 的读写者）。因此“入口”列给的是当前可达的 UI 入口或真实调用点；凡函数存在但没有任何调用者的能力，一律在“限制”列写明“未接线”，不列为可用。

> **基线口径（重要）**：所有行号与结论都以提交 `a1b8c37` 的内容为准，而不是磁盘上的工作树。核对期间该仓库正被并行修改：`README.md`、`src/components/Sidebar.tsx`、`src/components/modals/SettingsModal.tsx`、`src/hooks/useCloudBackup.ts`、`src/lib/extensionBridge.ts`、`src/lib/storage.ts`、`src/types/index.ts`、`src/index.css`、`tailwind.config.js` 有未提交改动，另有未跟踪的 `src/app/`、`src/domain/`、`src/shared/`、`src/lib/backupPolicy.ts`、`src/lib/schemaGeneration.ts`、`src/components/TopBar.tsx`、`tests/fixtures/`。这些改动**不在 `a1b8c37` 内**，因此本矩阵一律以 `git show a1b8c37:<path>` 的版本引用行号；工作树里已经先走一步的 P0-03／P1-09 实现见第 3.6 节，不计入当前能力。

## 1. 功能矩阵

| 能力 | 当前入口（文件:行） | 读写方式 | 数据源/存储位置 | 现有测试 | 真实支持范围与限制 |
| --- | --- | --- | --- | --- | --- |
| 常用网站/收藏：浏览、打开、访问计数 | `src/App.tsx:340`、`src/components/views/SitesView.tsx:165`、`src/components/cards/SiteCard.tsx` | 读 + 写（增/删/访问计数） | `HubState.sites` → `localStorage['self_hub_data_v2']`（`src/lib/storage.ts:5,267`）；镜像到 `chrome.storage.local.selfhub_sites`（`src/lib/extensionBridge.ts:126`） | `tests/e2e/crud.spec.ts`（新增网站刷新保留） | 可用。`sites` 无编辑路径：全仓只有 `addSite`/`deleteSite`/`visitSite`（`src/hooks/useSiteActions.ts:14,21,28`），没有 `updateSite`，所以改标题/改 URL 只能删了重建 |
| 分组（分类） | `src/components/views/SitesView.tsx:98`（按 `category` 分组）、`:56`（折叠） | 读；写只发生在新增与导入时 | `HubState.categories` + 每个 site 的 `category` 字段 | `tests/e2e/crud.spec.ts`（间接） | 分组折叠、按分类筛选可用；**不支持拖拽排序、不支持把已有网站移动到另一分组**。分组集合只在 `importBookmarks`/`useBatchImport` 里被动增长（`useSiteActions.ts:41`、`useBatchImport.ts:25`） |
| 导入书签（Chrome/GoTab HTML） | `src/components/views/SitesView.tsx:107`（`handleBookmarkUpload`）、`:184`（上传按钮） | 写（批量新增） | 本地 HTML 文件 → `HubState.sites` | `tests/e2e/crud.spec.ts`（间接） | 可用，URL 归一化去重（`SitesView.tsx:22,121`）。限制：只认 `.html` 且 `href` 以 `http` 开头的 `<a>`；无导入预览、无重复候选列表、无“撤销这一批”，导入结果只用 `alert` 回报条数 |
| 全局搜索（Ctrl+K） | `src/App.tsx:150`（快捷键）、`src/App.tsx:537`（挂载）、`src/components/GlobalSearch.tsx:44` | 读（不改数据） | 内存中的 `sites/servers/secrets/notes/reminders/obsidianNotes/projects/inbox` + IndexedDB 全文索引（`GlobalSearch.tsx:75,146`） | `tests/e2e/pinyin-search.spec.ts`、`tests/e2e/data-integrity.spec.ts`、`tests/e2e/global-search-vault.spec.ts` | 可用：模糊匹配 + 拼音首字母（`src/lib/searchEngine.ts:49`，6763 字表 `src/lib/pinyinTable.ts:14`）。限制：金库命中只给名称/掩码，需解锁后才解密复制；索引未建立时正文搜索为空 |
| 笔记（本地 Markdown） | `src/App.tsx:453`、`src/components/views/NotesView.tsx:34` | 读 + 写 | `HubState.notes` → localStorage 整包；同时异步镜像进 `self_hub_idb.notes`（`src/lib/indexedDb.ts:195`） | `tests/e2e/crud.spec.ts`、`tests/e2e/markdown.spec.ts`、`tests/e2e/markdown-editor.spec.ts`（编辑器在 `DataInteropView`） | 可用：三模式编辑器（分屏/源码/预览）、导出 `.md`、复制全文。限制：无附件、无历史版本、无置顶写入口（`pinned` 字段存在但没有 UI 可改） |
| 笔记草稿 | `src/components/views/NotesView.tsx:83`（检测）、`:103`（800ms 防抖写入）、`:124`（恢复） | 写 `localStorage['selfhub_note_draft']`，读回编辑器 | 独立 localStorage 键，不进 `HubState` | `tests/e2e/data-integrity.spec.ts`（草稿、取消确认） | 可用。限制：只有一份草稿（后写覆盖前写），不做多文档草稿；草稿不进备份包，也不跨设备 |
| 网页划线采集（扩展） | `extension/content.js:448`（应用内桥）、`extension/background.js:206`（`SAVE_ANNOTATION`） | 写 `chrome.storage.local.selfhub_annotations` | 扩展源 chrome.storage | `tests/e2e/checkin-and-reminders.spec.ts`（扩展消息桥，间接） | 可用：content script 生成 `<mark>` 高亮、写回 storage、按 URL 恢复。限制：**扩展库与应用库天然不同源**，应用不会反向读到新划线（只能靠用户手点“从扩展同步”） |
| 批注存储（`annotations`） | 无 UI 入口。类型 `src/types/index.ts:203`，只被 `src/lib/indexedDb.ts:202` 与 `src/lib/extensionBridge.ts:60` 读取 | 代码里没有任何写入者（全仓无 `addAnnotation`/`annotations: [...`） | `HubState.annotations` | 无 | **未接线/事实上的死集合**：没有任何应用内路径能创建、编辑或展示 `annotations`，它只会被镜像与落 IDB。应用内批注实际走的是 `wucaiHighlights` 集合（扩展导入后落在那里） |
| 五彩：Token 配置 | `src/lib/integrations.ts:193`（registry）、`src/components/modals/SettingsModal.tsx:438` | 写 `HubState.wucaiConfig` | localStorage 整包 | `tests/e2e/settings-ia.spec.ts`（保存后持久化、`enabled` 被置 true） | 可用。`write()` 里 `enabled: filled(token)`（`integrations.ts:205`）＝填了 Token 就启用，见第 3 节 |
| 五彩：导入/拉取真实状态 | 导入：`src/components/views/DataInteropView.tsx:1071`（从扩展拿批注，写入 `wucaiHighlights`）。客户端：`src/lib/wucaiClient.ts:46` | 只在应用内向 `wucaiHighlights` 写入（手工新增 `:1047`、编辑批注 `:1011`、删除 `:1020`、转 Markdown `:1025`） | `HubState.wucaiHighlights`；导出走 `formatWucaiToObsidianMarkdown`（`wucaiClient.ts:8`）→ OSS | 无（`settings-ia.spec.ts` 只覆盖 Token 表单，无任何拉取断言） | **拉取未接线**：`fetchWucaiHighlights` 定义于 `wucaiClient.ts:46`，但全仓没有任何调用者（`DataInteropView.tsx:89` 只 import 了 `formatWucaiToObsidianMarkdown`），所以即使填对 Token 也不会去 `api.doc.wucai.site` 取新内容。同时 `DataInteropView.tsx:2329` 在拓扑页对用户显示“状态: 已接入 (N 标注) / 活跃”，`:1943` 的 Token 弹窗已改成只引导去设置（`:2831`），不再本地保存 |
| 有道：真实状态 | 视图 `src/components/views/DataInteropView.tsx:2116`；客户端 `src/lib/youdaoClient.ts:8` | 只有本地增删改（`:1213` 新增、`:1180` 编辑、`:1233` 删除、`:1192` 转 OSS） | `HubState.youdaoNotes` | 无 | **拉取未接线**：`fetchYoudaoNotes`（`youdaoClient.ts:32`）没有任何调用者，且函数体本身也只 `return current`，不发请求。视图默认目录 `/工作/架构设计/`、引导文案让用户自己用外部工具 `youdaonote-pull` 导出（`DataInteropView.tsx:2137`），但拓扑页同样显示“状态: 已挂载 (N 篇文档) / 活跃”（`:2343`） |
| 收件箱：快速录入 | `src/App.tsx:308`、`src/components/views/InboxView.tsx:67`（`Ctrl+Enter` 提交 `:90`） | 写 `HubState.inbox` | localStorage；无扩展镜像（`mirrorStateToExtension` 只同步 sites/annotations） | `tests/e2e/crud.spec.ts`（存入并转笔记） | 可用。类型自动判定 `url`/`snippet`/`text`（`InboxView.tsx:71`） |
| 收件箱 → 转笔记/转收藏/关联项目 | `src/hooks/useInboxActions.ts:45`（转笔记）、`:67`（转收藏）、`:90`（关联项目）；UI `InboxView.tsx:429` | 写：新建目标条目 + 把原条目标 `processed` 并记 `targetType/targetId` | `HubState.notes` / `sites` / `inbox.status` | `tests/e2e/crud.spec.ts` | 可用。限制：**“重复转换不重复创建”只靠 UI 不再显示按钮**，没有按 `targetType/targetId` 回跳原目标的逻辑，也没有批量转换与部分失败报告 |
| AI 分拣：本地规则 | `src/components/modals/AiIngestModal.tsx:84`（`handleAnalyze`）、`src/lib/aiParser.ts:190`（`parseTextLocally`） | 只读输入文本，返回值先预览不落库 | 纯内存计算 | `tests/e2e/ai-privacy.spec.ts` | 可用，默认路径：`parseTextWithLLM` 在没有 Key 或未开云端时直接回落到本地规则（`aiParser.ts:332`） |
| AI 分拣：云端 | `AiIngestModal.tsx:96`（遮蔽）、`:99`（请求）、`src/lib/aiProviders.ts:179`（连接测试） | 读输入 → 出网 → 回填 → 用户确认后一次性写五个集合（`src/hooks/useBatchImport.ts:21`） | 第三方模型 API；不落新存储 | `tests/e2e/ai-diagnostics.spec.ts`、`tests/e2e/ai-privacy.spec.ts` | 可用但需显式开启（`AiConfig.cloudAiEnabled`，`types/index.ts:255`）。默认关闭；开启前 `maskSecrets`（`src/lib/secretMask.ts:77`）遮蔽密钥并在入库时本机还原，遮蔽只对本次发送生效 |
| 项目空间 | `src/App.tsx:322`、`src/components/views/ProjectsView.tsx:36` | 读 + 写（CRUD、关联、决策记录） | `HubState.projects`（`noteIds/siteIds/serverIds/reminderIds` 只存 ID 引用） | 无（仅 `tests/e2e/smoke.spec.ts` 渲染） | 可用。删除项目只清 `projects`，不级联删资料/服务器（`src/hooks/useNoteActions.ts:77`；确认文案 `ProjectsView.tsx:346`）。限制：关联是单向 ID 引用，**没有反向引用扫描**，资料侧看不到自己被哪个项目引用 |
| 服务器 | `src/App.tsx:353`、`src/components/cards/ServerCard.tsx:13` | 读 + 写（增/删；探测结果写回字段） | `HubState.servers` | `tests/e2e/server-health.spec.ts` | 可用。SSH 命令复制：有 `sshCommand` 用原文，否则拼 `ssh -p {sshPort||22} {sshUser||root}@{publicIp}`（`ServerCard.tsx:16`） |
| 服务器 HTTP 检测 | `src/App.tsx:365`（全部检测）、`ServerCard.tsx:31`（单台）；逻辑 `src/lib/serverHealth.ts:44` | 读（`fetch` 探测）+ 写（`status/lastCheckedAt/lastCheckMessage/lastLatencyMs`） | 浏览器 `fetch` → 目标 URL；结果存 `HubState.servers` | `tests/e2e/server-health.spec.ts`（含 401 算在线、5xx 不可达、无地址保持未探测） | 可用：8s 超时，CORS 失败退化为 `no-cors` 只证明“有人应答”。限制：探测地址只来自 `healthUrl` 或 `domain`（`serverHealth.ts:25`），**只有 IP 时明确返回“未探测”**；没有定时巡检与告警，只有一个 30 分钟闹钟（且那是提醒用的，`extension/background.js:38`） |
| 金库加解密 | 新建 `src/components/modals/AddItemModal.tsx`；展示/复制 `src/components/cards/SecretCard.tsx:44`、`src/components/views/DashboardOverview.tsx:54`；算法 `src/lib/crypto.ts:30,55,75` | 写密文，读时解密 | `HubState.secrets`（`encryptedValue/iv/salt/maskedPreview`）；主密码校验哈希在 `localStorage['self_hub_master_auth']`（`storage.ts:6,358`） | `tests/e2e/vault-and-backup.spec.ts`、`tests/e2e/vault-ops.spec.ts`、`tests/e2e/global-search-vault.spec.ts` | 可用：PBKDF2 100,000 次派生密钥 + AES-256-GCM；主密码校验另用 150,000 次 PBKDF2（`crypto.ts:104`）。限制：**每条凭据各自随机 salt**，改主密码需要逐条重加密，当前没有改主密码的功能 |
| 金库解锁/锁定与明文清理 | `src/components/modals/MasterKeyModal.tsx`；锁定 `src/App.tsx:188`；清明文 `src/components/cards/SecretCard.tsx:25`、`src/lib/crypto.ts:225`（派发 `selfhub:vault-locked`） | 写内存会话 + IndexedDB 包裹记录 | 解锁态只存 React state；设备密钥包裹体在 `self_hub_idb.metadata`（`src/lib/trustedDevice.ts`） | `tests/e2e/vault-and-backup.spec.ts`（锁定清明文、弹窗可交互） | 可用。锁定会清空卡片明文、派发全局事件并删除设备记录。限制：金库明文曾进入过的 React 状态不会被强制回收，页面级 XSS 仍能读到；`localStorage` 与 IDB 同源，不构成对同源脚本的防护 |
| 设备信任（30 天免密） | `src/App.tsx:63`（启动恢复）、`src/lib/crypto.ts:184,212`、`src/lib/trustedDevice.ts:95,122` | 写：随机设备密钥包裹主密码存 IDB；读：启动时解包 | `self_hub_idb.metadata` 的 `trusted_device_v1` | `tests/e2e/vault-and-backup.spec.ts`（刷新后仍解锁） | 可用，30 天到期即销毁。限制：只在本源有效；`clearTrustedSession()` 只清当前 origin 的记录 |
| 提醒（增删改、完成、续期） | `src/App.tsx:442`、`src/components/views/RemindersView.tsx:36`、`src/hooks/useReminderActions.ts:8` | 读 + 写 | `HubState.reminders` | `tests/e2e/crud.spec.ts`、`tests/e2e/data-integrity.spec.ts` | 可用：到期排序、逾期/近期/全部筛选（`RemindersView.tsx:99`）、完成切换、续期（`:183` `nextRenewal`）。限制：自动顺延只在**挂载时跑一次**（`RemindersView.tsx:80` 依赖数组为空），页面不重开就不会顺延；`toggleReminderComplete` 会写入类型里没定义的 `completedAt`（`useReminderActions.ts:39`） |
| 提醒周期（月末/跨时区） | `src/lib/dates.ts:61`（`advanceRecurringDate`）、`:89`（`nextRenewal`） | 纯函数 | 无 | `tests/e2e/data-integrity.spec.ts`（非法 recurring 不死循环、合法周期推进） | 可用但有语义缺口：用 `Date.setMonth(+1)`，**1 月 31 日的“每月”会跳到 3 月 3 日**（JS 日期溢出），既不夹到 2 月末也不报错；`MAX_STEPS=1200` 只防死循环。测试只覆盖了推进与非法值，**没有月末与闰年样本** |
| 提醒通知：网页版 | `src/hooks/useReminderNotifications.ts:30`、`src/lib/reminderNotifier.ts:111` | 读提醒 → 调 `Notification`；写“今天已通知”标记 | `localStorage['selfhub_reminder_notified_*']` | `tests/e2e/checkin-and-reminders.spec.ts` | 可用：60s 轮询一遍（`useReminderNotifications.ts:16`），窗口 3 天，每人每天最多一次。限制：**只在页面打开时生效**；权限被拒时只进 `blocked` 列表 |
| 提醒通知：扩展后台 | `src/lib/extensionBridge.ts:209`（发布）、`extension/background.js:43,92`（alarms） | App 写 `chrome.storage.local.selfhub_reminders` → worker 读并通知 | 扩展源 chrome.storage | `tests/e2e/checkin-and-reminders.spec.ts`（发布给 worker、普通网页不误发） | 可用：30 分钟周期闹钟，浏览器重启后重建（`background.js:56`）。限制：**扩展环境会主动关掉页内通知**（`useReminderNotifications.ts:32`），所以网页版与扩展版只有一条路径生效；关机不提醒 |
| 签到：HTTP 执行 | `src/App.tsx:465`、`src/components/cards/CheckInCard.tsx:13`、`src/lib/automation.ts:56` | 读（发起请求）+ 写（`lastRun/lastStatus/history/streakDays`） | `HubState.checkIns` | `tests/e2e/checkin-and-reminders.spec.ts` | 可用：15s 超时，除 HTTP 状态外还做业务判定（`automation.ts:19`，识别 `{"code":-1}` 之类 200 假成功） |
| 签到：仅打开页面 | `src/lib/automation.ts:73`（`type === 'redirect'`）、`src/lib/checkInHistory.ts:44` | 打开新标签页，写一条**不计入连续天数**的记录 | `HubState.checkIns.history` | `tests/e2e/checkin-and-reminders.spec.ts` | 可用且诚实：返回 `verified: false`（`automation.ts:78`），`recordRun` 里 `verified !== false` 才计天数（`checkInHistory.ts:44`），同一天只有一条记录。限制：打开页面本身无法证明签到成功，UI 只能显示“未校验” |
| 签到历史与连续天数 | `src/lib/checkInHistory.ts:14,42,70,95`；展示 `CheckInCard.tsx:28` | 读；streak 由 history 推导 | `HubState.checkIns.history`（每日一条，上限 120 条 `checkInHistory.ts:11`） | `tests/e2e/checkin-and-reminders.spec.ts`（重复签到不翻倍、14 天状态、隔天仍连续） | 可用：本地日历口径（`localDateKey`）。限制：**没有定时自动执行**——`automation.ts` 里没有任何 `setInterval`/`setTimeout` 调度，只有用户点按钮；用户脚本只生成文本（`automation.ts:173`） |
| 手绘 | `src/App.tsx:514`、`src/components/cards/HandwritingCard.tsx:11` | 写 PNG dataURL 进状态 | `HubState.handwritings[].dataUrl`（Base64 直接放在整包里） | `tests/e2e/crud.spec.ts`（保存卡片、空画板拦截） | 可用：撤销 20 步、清屏、1280px 降采样。限制：**没有独立附件存储**，PNG 直接进 localStorage 整包（`storage.ts` 5MB 配额压力点）；画布尺寸固定 800×320，没有打开已有手绘继续编辑的入口 |
| 远端文件树（OSS） | `src/App.tsx:493` → `DataInteropView.tsx:1333`；树 `src/components/OssTree.tsx:17` | 读 `listOssObjects`，分页拉全量 | 远端 OSS bucket（`obsidianConfig`） | `tests/e2e/oss-tree.spec.ts`、`tests/e2e/oss-signing.spec.ts` | 可用：跨页拉取（不止 1000 条）、多层目录、跨层搜索。限制：**树只是元数据**，正文要单独下载；OSS 凭据在 `HubState.obsidianConfig` 里明文存 localStorage |
| 远端文件读写与冲突 | `DataInteropView.tsx:911`（保存）、`:965`（删除）、`:532`（移入回收站）、`:583`（恢复）；底层 `src/lib/s3Client.ts:979,1109,718,776,497` | 读 + 写远端对象 | OSS 对象；冲突基据在内存 `At` ref（lastModified/etag） | `tests/e2e/trash-conflict.spec.ts`、`tests/e2e/vault-ops.spec.ts`（贴图上传、重命名 COPY+DELETE、新建目录、图片预览、移动目录拒绝进自身子目录） | 可用：保存前比对 `Last-Modified`/`ETag`，冲突弹窗给“覆盖/重载云端/另存”选项。限制：**服务端不提供 mtime 时冲突检测退化**；删除是软删除进 `.trash/`，回收站没有自动清理与容量上限 |
| OSS 全文索引 | `src/lib/vaultIndex.ts:251`（建）、`:385`（搜）、`:457`（反链）；入口 `DataInteropView.tsx:727,745,754`、`GlobalSearch.tsx:75` | 读 OSS 正文 → 写 IndexedDB `self_hub_vault_index` | 独立 IDB 库（与主库分离，`vaultIndex.ts:14`） | `tests/e2e/vault-search.spec.ts`、`tests/e2e/index-management.spec.ts`、`tests/e2e/global-search-vault.spec.ts` | 可用：正文/标签/双链/反链，索引损坏自愈（`vaultIndex.ts:153`）。限制：索引是**本机缓存**，换设备要重建；索引不加密，锁定金库不影响它；只索引 `.md`（`vaultIndex.ts:259`） |
| 整站云备份：OSS | `src/hooks/useCloudBackup.ts:25`、`src/lib/stateBackup.ts:177`；UI `SettingsModal.tsx`（`backup-now`/冲突提示） | 整包写远端 `.selfhub/state.json`，冲突时写 `.selfhub/conflicts/` | 远端 OSS；本机记录 `selfhub_last_backup_at`/`selfhub_backup_base_mtime`（`stateBackup.ts:20,22`） | `tests/e2e/state-backup.spec.ts`、`tests/e2e/security-and-features.spec.ts` | 可用：5s 防抖（`useCloudBackup.ts:23`）、v2 信封、上传前 `stripCredentials`（`stateBackup.ts:48`）剥掉 OSS Secret/WebDAV 密码/AI Key/五彩 Token/有道 Token+Cookie。限制：`secrets[]` 密文本体照传；剥的是**固定字段**，不覆盖笔记正文里手写的密钥 |
| 整站云备份（WebDAV） | 手动：`src/components/modals/SettingsModal.tsx:862`（`onBackupNow`）；客户端 `src/lib/stateBackup.ts:270`；连接测试 `src/lib/webdavClient.ts:83` | 读 + 写远端 `state.json` | WebDAV 目录（`webdavConfig.pathPrefix`） | `tests/e2e/webdav.spec.ts`（含 401/网络失败归因、目标路径预览、启用后 PUT 到 WebDAV、冲突另存） | **只有手动与连接测试**：`readStateBackupFromWebdav`（`stateBackup.ts:308`）**全仓没有调用者**，没有任何“从 WebDAV 恢复”的 UI；自动触发见第 2.1 节 |
| 扩展镜像同步（App → 扩展） | `src/App.tsx:136`、`src/lib/extensionBridge.ts:43` | 每次状态变更**无条件全量覆写** `chrome.storage.local.selfhub_sites` + `selfhub_annotations`（`extensionBridge.ts:78-89`） | 扩展源 chrome.storage | `tests/e2e/sync-dedup.spec.ts`（重叠警示、一键关扩展同步）、`tests/e2e/checkin-and-reminders.spec.ts` | 单向、**只写不读、无合并**：`a1b8c37` 里没有任何“先读远端再合并”的逻辑，扩展在应用打开期间新增的批注会被下一次镜像抹掉。限制：整集合覆写（非按条目 diff）；`sites` 连墓碑都没有 |
| 扩展旧 SyncManager | `extension/sync/sync-manager.js:76`；配置/状态暴露给应用 `src/lib/extensionBridge.ts:180`（`readExtensionSyncState`）、`:217`（`setExtensionSyncEnabled`）；UI `SettingsModal.tsx:601`（重叠警示）、`:623`（一键关闭） | 读 + 写 `chrome.storage.local` 与远端 `annotations.json`/`inbox.json`/`sites.json`/`quicknote.json`/`manifest.json` | 扩展自己的一套远端目录 | `tests/e2e/sync-dedup.spec.ts` | 仍在运行（默认 `autoSync: true`，`sync-manager.js:19`），有 60s 冷却、tombstone、LWW 合并与“批量删除保护”（`sync-manager.js:156`）。限制：与应用整站备份是**两套独立通道**，同一条收藏/批注会被写两次；应用只能读状态和开关 provider，不能改它的目录 |
| 导入/导出备份（明文 JSON） | `src/lib/storage.ts:376`（导出）、`:418`（导入）；UI `SettingsModal.tsx:771` | 读 + 写本地文件；导入前 `snapshotForRollback`（`storage.ts:389`） | 本地 `.json` 文件 | `tests/e2e/vault-and-backup.spec.ts`（导出可下载、缺字段旧备份不白屏） | 可用：导出含凭据（UI 会二次确认），导入会先校验再 `normalizeHubState`。限制：回滚快照存在 `sessionStorage`（`storage.ts:366`），**关标签页即失效**；导入是整包替换，不做差异预览 |
| 加密备份包 | `src/lib/crypto.ts:241`（导出）、`:269`（导入）；UI `SettingsModal.tsx:159` | 整包 AES-256-GCM 加密后落文件 | `.enc.json` 文件 | `tests/e2e/vault-and-backup.spec.ts` | 可用：PBKDF2+salt+iv 自包含，兼容旧明文格式并给出警告（`crypto.ts:294`）。限制：加密包与明文包用的是同一个 `state`，**同一个密码错就完全解不开**；没有分片/续传 |
| 回收站 | `src/components/OssTree.tsx:31`（恢复动作）、`DataInteropView.tsx:532,583`；前缀常量 `src/lib/s3Client.ts:439` | 写：`trashOssObject/Folder` 移到 `.trash/`；恢复写回原路径 | 远端 OSS `.trash/` 前缀 | `tests/e2e/trash-conflict.spec.ts` | 可用，只作用于 OSS 远端文件。限制：**本地笔记/收藏/项目/提醒没有回收站**，删除即真删；`.trash/` 不会被应用自动列出或清理 |
| 冲突（远端文件保存） | `DataInteropView.tsx:875`（冲突态）、`:911`（保存判定）、`:2484`（冲突弹窗） | 读远端 mtime/etag → 拦截写入 | 内存基据 + 远端对象头 | `tests/e2e/trash-conflict.spec.ts` | 可用：可选覆盖/重载/另存，ETag 兜底。限制：**只有远端 Markdown 有冲突处理**；本地 localStorage 整包只靠 `storage` 事件的跨标签页告警（`App.tsx:140,267`），另一标签页仍可能覆盖 |
| 跨标签页外部写入告警 | `src/App.tsx:140`（监听）、`:267`（横幅） | 只读告警，不自动合并 | `storage` 事件 + `self_hub_data_v2` | 无 | 可用但很弱：只提示“另一标签页改了同一份数据”并给“重新加载”，用户不点就会用当前版本覆盖 |
| IndexedDB 兜底 | 写：`src/lib/storage.ts:261` → `src/lib/indexedDb.ts:172`；重置：`SettingsModal.tsx:253`、用量：`:129` | **只写不读** | `self_hub_idb`（notes/sites/servers/secrets/reminders/inbox/projects/annotations/blobs/metadata） | `tests/e2e/vault-and-backup.spec.ts`（重置会清 IDB，库名修复） | **半个能力**：`loadStateFromIndexedDb`（`indexedDb.ts:216`）全仓无调用者，`loadHubState` 只读 localStorage（`storage.ts:236`），所以“IDB 兜底”实际不存在；即便调用，它也会丢 `checkIns`/`handwritings`/`obsidianNotes` 并把主题强制成 `dark`（`indexedDb.ts:234`）；`blobs`、`saveItemToDb`、`deleteItemFromDb` 均已建好但没有任何业务读写者 |
| 功能开关 | `src/lib/features.ts:57,86,89`；UI 打开设置：`SettingsModal.tsx:438`；切换处理：`src/App.tsx:625`、`src/components/OnboardingWizard.tsx` | 写 `HubState.features` | localStorage 整包 | `tests/e2e/security-and-features.spec.ts`、`tests/e2e/onboarding.spec.ts` | 可用：可关的 9 个模块关掉后从侧栏/顶栏消失，当前页会退回仪表盘（`App.tsx:107`）。限制：`dashboard/sites/reminders/obsidian` 是 `CORE_TABS`，永远可见——**五彩/有道共用 `obsidian` 标签，所以关掉五彩/有道开关仍看得到入口** |
| 跨环境数据边界 | `src/lib/extensionBridge.ts:38`（`isExtensionContext`）、`useReminderNotifications.ts:32`、`tests/e2e/sync-dedup.spec.ts`（“非扩展环境说明不适用”） | 读环境判断 | `globalThis.chrome` | `tests/e2e/sync-dedup.spec.ts` | 边界基本诚实：普通网页不假装能读写扩展库，也不发布扩展消息。限制：应用仍会**单向**镜像进扩展（同源时），所以“网页版与扩展是两个库”的说法在扩展内打开应用时并不成立 |
| 未接通配置：`cloudflareSync` | 只有类型与默认值：`src/types/index.ts:261,305`、`src/lib/storage.ts:134,229`、`src/lib/indexedDb.ts:250` | 无 | 无 | 无 | **死配置**：全仓没有任何代码读取 `cloudflareSync.workerUrl/syncKey/autoSync` 或调用同步，也没有 Settings 表单。可以安全地视为“尚未实现” |

## 2. 与旧文档不一致之处（证据）

以下每条都给出“结论 + 证据”。CONFIRMED 表示旧文档的说法在当前代码里成立（含行号已漂移但结论不变的情况）；NOT REPRODUCED 表示我去查了，但当前代码已经不是文档描述的样子。

### 2.1 `useCloudBackup.ts` 自动备份只认 OSS —— **CONFIRMED**

- 自动触发路径（`useEffect`）读的是 `state.obsidianConfig`，条件是 `enabled && bucket && accessKeyId`：
  - `src/hooks/useCloudBackup.ts:66-73`：`const cfg = state.obsidianConfig; if (!cfg?.enabled || !cfg.bucket || !cfg.accessKeyId || cfg.accessKeyId.includes('•••')) return;`
  - `:74-77`：通过后才 `setTimeout(runStateBackup, 5000)`。
- 而手动/通用入口（`runStateBackup`）是**双provider感知**的：先判 WebDAV（`:37`），不满足才回落到 OSS（`:40`）。
- 结论：只配 WebDAV 时，**手动“立即备份”可用，自动备份永不触发**。这是“手动与自动用了两套目标判定”的直接证据，与设计稿第 2 节表格 `useCloudBackup.ts:72` 一致（行号未变）。
- 测试缺口旁证：`tests/e2e/state-backup.spec.ts:119` 的自动备份用例只 mock 了 OSS（`:121 mockOss`）；`tests/e2e/webdav.spec.ts` 里只有手动 PUT（“启用 WebDAV 后「立即备份」会 PUT 到 WebDAV”）与冲突用例，**没有任何只配 WebDAV 等自动触发的测试**，全仓也没有等待 5s 防抖的用例（`waitForTimeout` 最大 1500ms）。

### 2.2 `integrations.ts` 的 `write()` 由字段存在推导 `enabled` —— **CONFIRMED**

- `src/lib/integrations.ts:95`（oss）：`enabled: filled(v.bucket ?? ...) && filled(v.accessKeyId ?? ...)`
- `:129`（webdav）：`enabled: filled(v.url ?? ...) && filled(v.username ?? ...)`
- `:205`（wucai）：`enabled: filled(v.token ?? ...)`
- `:228`（youdao）：`enabled: filled(v.token ?? ...)`
- 落库路径：`IntegrationCard.tsx:45`（失焦）与 `:92`（开关）→ `SettingsModal` 的 `onSaveIntegration` → `App.tsx:624` `applyIntegrationValues`。
- 结论：**填字段即启用**。最尖锐的一例是 WebDAV——只填 URL + 用户名（尚未填密码）就会把 `webdavConfig.enabled` 置为 `true`，而“已配置”徽标的另一条判定又要求密码（`integrations.ts:132`），于是同一个卡片会显示“已配置 = 否”但 `enabled = true`。测试里也把这一点当作既有行为固定下来了：`tests/e2e/settings-ia.spec.ts:85` 断言 `wucaiConfig.enabled === true` 仅因为填了 Token。

### 2.3 `IntegrationCard.tsx` 失焦保存 + 开关即时保存 —— **CONFIRMED**

- 失焦保存：`src/components/settings/IntegrationCard.tsx:44-46`（`handleBlur` 里 `if (dirty) onSave(...)`），绑定在 `:127`（select）与 `:142`（input）。
- 开关即时保存：`:86-93`，点击即 `onSave(def.id, next)`（`:92`），注释也写明“Toggles are dangerous-by-nature: persist immediately”。
- 底部“保存配置”**不写任何值**，只显示成功并关闭：`src/components/modals/SettingsModal.tsx:148-157`（`handleSaveConfigs` 只有 `setSavedSuccess(true)` + 1s 后 `onClose`），按钮在 `:926`。
- 结论：与设计稿“表单失焦保存、开关即时保存、底部按钮仅确认关闭”完全一致。
- 补充（设计稿未提但同源）：卡片自己的“保存”按钮文案在未改动时也显示“已保存”（`IntegrationCard.tsx:166`），且**没有“取消/放弃草稿”动作**——`draft` 只在 `persisted` 变化时被重置（`:30-32`），用户没有显式放弃修改的途径。

### 2.4 `features.ts` 的 `CORE_TABS` 与开关的影响范围 —— **CONFIRMED（并有一处更严重）**

- `src/lib/features.ts:86`：`export const CORE_TABS = ['dashboard', 'sites', 'reminders', 'obsidian'] as const;`
- `:89-93`：`isTabAllowed` 对 `CORE_TABS` 直接 `return true`，不受开关影响。
- 消费点：`src/components/Sidebar.tsx:91`、`src/components/Navbar.tsx:85`、`src/App.tsx:108`。
- 结论：`dashboard/sites/reminders/obsidian` 永远可见，符合旧文档“核心模块不可关闭”。
- 但更严重的一点旧文档没写清楚：**`wucai` 与 `youdao` 两个开关的 `tab` 都是 `obsidian`**（`features.ts:65,66`），而 `obsidian` 属于 `CORE_TABS`，所以关掉五彩/有道开关**不会**从导航移除“多平台数据互通”；`isTabAllowed` 在 `CORE_TABS` 分支就返回了，`FEATURE_DEFS` 里的定义根本走不到。`tests/e2e/security-and-features.spec.ts` 只验证了 inbox/projects 这类非核心模块，没有覆盖这两个开关。

### 2.5 `extensionBridge.ts` 整集合镜像 —— **CONFIRMED**

- 设计稿（第 2 节表格）称 `extensionBridge.ts:43` “把收藏和批注整集合镜像给扩展”，存在覆盖扩展新增记录的风险。**该行号与结论在 `a1b8c37` 上完全成立**：
  - `extensionBridge.ts:43` 正是 `export function mirrorStateToExtension(state: HubState): void`。
  - `:47-76` 把 `state.wucaiHighlights` 与 `state.annotations` 合成一个按 id 去重的 `Map`，**这份数据完全来自应用内存**。
  - `:78-89` 一次 `chromeApi.storage.local.set({ selfhub_sites: ..., selfhub_annotations: Array.from(byId.values()) })` —— 无条件、整集合覆写，既没有先 `get()` 远端，也没有 id 差集合并，也没有墓碑。
  - 调用点在每次持久化时触发：`src/App.tsx:130-137`（`saveHubState(state)` 之后立刻 `mirrorStateToExtension(state)`）。
- 结论：扩展 content script 在应用标签页打开期间存下的新批注，会在应用下一次状态变更时被整体覆盖掉；`sites` 同理，且连 `updatedAt` 比较都没有。这正是设计稿要求“迁移前双边取证”的那一条，也是 P0-03 需要专项复现的场景。
- 补充旁证：`tests/e2e/sync-dedup.spec.ts` 只覆盖“重叠警示／关闭扩展同步／跳转扩展设置页”，**没有任何断言检查应用镜像是否会吞掉扩展新增的批注**，所以这条风险目前没有测试保护。

### 2.6 五彩/有道能否真正拉取新内容 —— **CONFIRMED（都不能）**

- 五彩：`fetchWucaiHighlights` 定义在 `src/lib/wucaiClient.ts:46`，函数内部确实写了 `https://api.doc.wucai.site/openapi/v1/highlights` 的 GET（`:57-62`），但**全仓没有任何调用者**。`DataInteropView.tsx:89` 只导入了 `formatWucaiToObsidianMarkdown`。应用能写入 `wucaiHighlights` 的路径只有：手工新增（`:1047`）、编辑批注（`:1011`）、删除（`:1020`）、从扩展导入（`:1071`）。
- 有道：`fetchYoudaoNotes`（`src/lib/youdaoClient.ts:32`）不仅没有调用者，函数体本身就只有 `return current`，**连请求都没写**。
- 页面仍对用户宣称“已接通”：`DataInteropView.tsx:2329` 渲染 `状态: 已接入 (N 标注)` 与绿色“活跃”，`:2343` 渲染 `状态: 已挂载 (N 篇文档)` 与“活跃”——这两个数字只是本地数组长度，不代表任何远端连通性。
- 唯一的好消息是配置入口已收敛：五彩 Token 弹窗现在只提示“所有外部连接的配置统一收在设置里”，不再本地保存（`DataInteropView.tsx:2831-2851`），并有测试守住（`tests/e2e/settings-ia.spec.ts:74,88`）。
- 结论：**按 P0-01 验收口径，五彩/有道的“拉取”必须列为未接通、不得写成同步**。当前状态是“本地记录 + 手工录入 + 从扩展导入 + 转 Markdown 到 OSS”。

### 2.7 额外发现的“文档说完成但代码没接线”项

这几条不在给定候选清单里，但同属 P0-01 要求标注的范围。

- **`cloudflareSync` 是死配置（CONFIRMED）**：类型 `src/types/index.ts:261,305`、默认值 `src/lib/storage.ts:134` 与 `:229`、`src/lib/indexedDb.ts:250` 都种下了它，但没有任何读取者、调用者或设置表单。旧文档中若提到“Cloudflare Worker 同步”，当前代码里不存在。
- **`annotations` 是死集合（CONFIRMED）**：类型 `src/types/index.ts:203`、落 IDB `src/lib/indexedDb.ts:202`、镜像 `src/lib/extensionBridge.ts:60`，但**没有任何写入者**（全仓 grep `addAnnotation` / `annotations: [` 均无匹配），也没有任何视图渲染它。应用内“网页批注”实际存在 `wucaiHighlights` 里。
- **IndexedDB 只是单向副本（CONFIRMED）**：`loadStateFromIndexedDb`（`src/lib/indexedDb.ts:216`）无调用者；启动只走 `loadHubState()`（`src/lib/storage.ts:236`，只读 localStorage）。README 里“IndexedDB 兜底”的能力当前不存在。
- **README 的测试条数已过期（CONFIRMED）**：`README.md:79`（`a1b8c37`）写“`npm run test:e2e` # 21 条端到端用例”，实际 `tests/e2e/*.spec.ts` 共 24 个文件、155 条 `test(...)`。
- **月末周期有实际缺陷（CONFIRMED）**：`src/lib/dates.ts:68` 用 `next.setMonth(next.getMonth() + 1)`，1 月 31 日会推进到 3 月 3 日而不是 2 月末（JS 日期溢出），既没有夹取也没有提示；`tests/e2e/data-integrity.spec.ts` 只覆盖“非法 recurring 不死循环”和“合法周期推进到未来”，**没有月末/闰年样本**，属于计划 P1-07 明确要求补齐的场景。

### 2.8 未提交的工作树已经先走了一步（不计入本矩阵）

核对期间工作树（非 `a1b8c37`）已出现以下改动，说明 P0-03／P1-09 已有未提交实现，**下一轮核对时需要重新取基线**：

- `src/hooks/useCloudBackup.ts`（工作树版）：改为调用 `resolveBackupTarget()`（来自新的未跟踪文件 `src/lib/backupPolicy.ts`），自动与手动共用同一目标解析，第 2.1 条所述的 WebDAV 触发缺陷在工作树里已被修掉；同时 `BackupStatus` 增加 `disabled` 与 `lastTrigger`。
- `src/lib/extensionBridge.ts`（工作树版）：新增 `buildMirroredAnnotations()` 与 `extensionOnlyAnnotationIds()`，镜像前先 `get()` 远端并把“只有扩展知道的 id”合并进去，第 2.5 条的覆盖风险已被缓解；另加了 `checkWritable()` 写前守卫。
- `src/lib/schemaGeneration.ts`（未跟踪新文件）：P0-03 的写入代际标记；工作树版 `saveHubState` 也加了 `assertWritable()`（HEAD 版 `src/lib/storage.ts:255` 还没有这个守卫）。
- `src/app/routes.ts`＋`src/app/navigation.ts`（未跟踪新目录）：P1-01 的 Hash 路由与导航注册表，已定义“首页／快捷导航／资源与安全／凭证金库”等新命名。
- 这些改动**不在 `a1b8c37` 内，也没有任何文件 import 它们**（`src/App.tsx` 仍是 11 个 `activeTab` 的状态机），所以本矩阵不把它们当作已具备能力。

## 3. 未来入口映射

下表把当前模块对应到设计稿 §4 的旧入口映射，方便改版后按模块找人。最后一列给出当前代码位置，便于实施时直接定位。

| 当前模块 / 标签 | 新信息架构位置 | 保留能力（设计稿 §4） | 当前代码位置（实施入口） |
| --- | --- | --- | --- |
| `dashboard` 仪表盘总览 | 首页 | 常用网站、最近资料、提醒、资源摘要 | `src/components/views/DashboardOverview.tsx` |
| `sites` 网站与工作台 | 快捷导航 | 网站分组、访问、导入、编辑与排序 | `src/components/views/SitesView.tsx` |
| `inbox` 统一收件箱 | 收件箱 | 暂存、分类、转笔记、收藏、关联项目 | `src/components/views/InboxView.tsx`、`src/hooks/useInboxActions.ts` |
| `notes` 深度知识文档 | 资料库 → 笔记 | 本地编辑、预览、草稿 | `src/components/views/NotesView.tsx`、`src/lib/storage.ts` 草稿键 |
| `obsidian` 多平台数据互通 | 资料库 → 来源；设置 → 连接与任务 | OSS 文件树、阅读、写入、索引与来源导入 | `src/components/views/DataInteropView.tsx`、`src/components/OssTree.tsx`、`src/lib/s3Client.ts`、`src/lib/vaultIndex.ts`；设置侧 `src/lib/integrations.ts:56`（oss）、`:104`（webdav）、`:193`（wucai）、`:212`（youdao） |
| `projects` 自研项目空间 | 项目 | 项目信息、资料引用、资源和决策 | `src/components/views/ProjectsView.tsx`、`src/hooks/useNoteActions.ts:59` |
| `servers` 自研部署与主机 | 资源与安全 → 服务器 | 主机信息、SSH 命令、HTTP 检测 | `src/App.tsx:353`、`src/components/cards/ServerCard.tsx`、`src/lib/serverHealth.ts` |
| `secrets` 加密安全金库 | 资源与安全 → 凭证金库 | 加密、解锁、复制、锁定 | `src/App.tsx:397`、`src/components/cards/SecretCard.tsx`、`src/components/modals/MasterKeyModal.tsx`、`src/lib/crypto.ts`、`src/lib/trustedDevice.ts` |
| `reminders` 倒计时与续费 | 提醒 | 到期列表、续期、完成、周期 | `src/components/views/RemindersView.tsx`、`src/lib/dates.ts`、`src/lib/reminderNotifier.ts` |
| `checkin` 自动化与打卡 | 工具 → 签到 | 手动执行、打开目标、历史；定时另行启用 | `src/App.tsx:465`、`src/components/cards/CheckInCard.tsx`、`src/lib/automation.ts`、`src/lib/checkInHistory.ts` |
| `handwriting` 交互手绘白板 | 资料库 → 新建手绘；工具快捷入口 | 绘制、撤销、保存 PNG | `src/components/cards/HandwritingCard.tsx`、`src/hooks/useNoteActions.ts:34` |
| 设置（长弹窗） | 设置（独立路由） | 使用偏好、连接与任务、备份、设备、安全、维护 | `src/components/modals/SettingsModal.tsx`、`src/components/settings/IntegrationCard.tsx`、`src/lib/integrations.ts:16`（`SettingsSection`） |
| `extension/newtab`＋`sidepanel`（扩展内应用） | 由扩展后台统一执行写操作，共用扩展源仓库 | 采集、刷新、新标签页、完整应用读同一条资料 | `extension/newtab.js`、`extension/sidepanel.js`、`extension/background.js:188`（消息中枢）、`extension/sync/sync-manager.js:76` |

> 新信息架构的路由与导航注册表（`src/app/routes.ts`、`src/app/navigation.ts`）目前**只存在于未提交的工作树**，`a1b8c37` 中没有这两个文件；`SETTINGS_SECTIONS`、`NAV_ITEMS` 等新命名的行号见第 2.8 节，待其提交后再引用具体行号。

## 4. 建议的后续动作（不属于本任务交付）

- 把 `useCloudBackup.ts:72` 的自动触发条件改为复用 `runStateBackup` 的目标解析（设计稿 P1-09），并补一条“只配 WebDAV 也能自动备份”的 E2E。
- 五彩/有道：在 `wucaiClient` / `youdaoClient` 真正接入前，把 `DataInteropView.tsx:2329,2343` 的“已接入/已挂载/活跃”改成“本地数据 N 条（未连接）”这类如实文案。
- 给 `annotations` 与 `cloudflareSync` 二选一：要么补写入者与视图，要么从类型和 IDB schema 中移除，避免下一轮迁移带着死集合走。
- `features.ts:65,66` 让五彩/有道各指向自己的标签（或在 `isTabAllowed` 中对非核心子能力也生效），否则开关与入口不一致。
- `dates.ts:68` 的月末推进按 P1-07 改成夹取到当月最后一天，并补 1/31、2/29 样本。

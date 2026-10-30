# P0-02 全模块脱敏夹具与恢复样本

本目录是 `docs/SELF_HUB_IMPLEMENTATION_PLAN.md` 中 **P0-02「建立全模块脱敏夹具与恢复样本」** 的交付物：
四份 `HubState`（localStorage 键 `self_hub_data_v2`，schema v2）格式样本、一份注册表模块，
以及对应的 Playwright 回归用例 `tests/e2e/fixtures-migration.spec.ts`。

样本全部为虚构数据，可以用来反复演练「恢复正常数据 / 遇到脏数据 / 遇到坏 JSON」三条路径，
而不接触任何真实用户数据。

## 1. 文件清单与哈希

哈希同时给出两份，避免行尾差异造成误判：

- `raw sha256`：本工作区里文件的原始字节（当前工作区为 CRLF 行尾）。
- `LF sha256`：把行尾统一成 `LF` 后的哈希 —— 这是**内容身份**，跨平台稳定，推荐用来判断夹具是否被改动。

| 文件 | 行数 | 字节 | raw sha256 | LF sha256（内容身份） |
| --- | --- | --- | --- | --- |
| `v2-full.json` | 395 | 13406 | `8696dcb36ff3e611b1fe1bce68d2f43f37f9863de4bcbf916e8382579a50f17a` | `5e4d8f5abdcf54ecba1168db06a954933963a309529bda6a58f249596cd8e126` |
| `v2-messy.json` | 241 | 8688 | `8e7e4b9ad1837d71721944a9c3bd47683ee41fb60ac424cc6aad0aa5eb85e358` | `877ba1f0a5e5ec0f931b9769860845c13cf7895eb00e54f7a0b38cfcee207564` |
| `v2-minimal.json` | 32 | 717 | `ca7f3d939cf40e0a4971cd9ba0015c9771df31456531f4cf89370be51b1a38fe` | `ece9a5fcce0ed0b036ecf6164bdd6f685d4737aa9a2b614393469025bfe48855` |
| `v2-broken.json` | 20 | 539 | `d3a325dbc23c8d895e497f0e7ffd8572619b351bb97b66c0a551f0be10194bec` | `d730c528a18f44fbb6e0db1c4fd2846539d4029f6d4af86ab48626024deea1f2` |

四份样本都远小于 60KB；`v2-broken.json` 按设计不是合法 JSON，无法做字段统计。

## 2. 逐集合数量

`countCollections()` 统计 `HubState` 里 13 个数组型集合；`—` 表示该键在文件里**根本不存在**
（用于验证归一化补全，而不是被丢弃）。

| 集合 | v2-full | v2-messy | v2-minimal | 说明 |
| --- | --- | --- | --- | --- |
| `sites` | 3 | 2 | 1 | 必填集合 |
| `servers` | 2 | 1 | 0 | 必填集合 |
| `secrets` | 2 | 0 | 0 | 必填集合；密文是虚构标记的 Base64 |
| `checkIns` | 2 | 0 | — | 含 `history` 日运行记录（跨越月末） |
| `reminders` | 3 | 3 | 1 | 月末 / 闰日锚点 |
| `notes` | 2 | 2 | 1 | 含缺失附件引用 |
| `handwritings` | 1 | 1 | — | 合成 PNG dataUrl |
| `inbox` | 2 | 1 | — | |
| `projects` | 1 | 1 | — | 孤立引用只出现在 messy |
| `annotations` | 2 | 3 | — | 同 URL 不同批注出现在 messy |
| `obsidianNotes` | 2 | — | — | |
| `wucaiHighlights` | 2 | 1 | — | 与批注共享来源 ID（messy） |
| `youdaoNotes` | 1 | — | — | |

`v2-full.json` 另外覆盖了对象型字段：`obsidianConfig` / `wucaiConfig` / `youdaoConfig` /
`aiConfig` / `cloudflareSync` / `webdavConfig` / `backupPolicy` / `homeBlocks` /
`connectionTests` / `purposes` / `sampleBatch` / `features` / `gotabPrefs` / `categories`。

## 3. 凭据策略（验收：没有真实密钥入库）

- 所有密码、Token、密钥一律使用 `TESTKEY-not-a-real-secret-000X` 形态，域名一律 `.invalid`：
  `fixture.invalid`、`docs.fixture.invalid`、`sync.fixture.invalid`、`dav.fixture.invalid`，
  邮箱 `fixture-user@example.invalid`，服务器地址使用 RFC 5737 文档网段 `192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`。
- `secrets[].encryptedValue` / `iv` / `salt` 是**虚构标记的 Base64**，不是真实密文：
  `VEVTVEtFWS1ub3QtYS1yZWFsLXNlY3JldC0wMDAx` → `TESTKEY-not-a-real-secret-0001`，
  `RklYVFVSRS1JVi0wMDAx` → `FIXTURE-IV-0001`，`RklYVFVSRS1TQUxULTAwMDE=` → `FIXTURE-SALT-0001`。
- 用例 `夹具文件不含任何真实密钥形态，且凭据可反解为虚构标记` 会对四个文件做黑名单扫描
  （AWS `AKIA…`/`ASIA…`、PEM 私钥、`sk-…`、`ghp_…`、`AIza…`、阿里云 `LTAI…`、Slack `xox…`、JWT），
  并把密文反解校验为虚构标记；任何一条命中都会让 P0-02 验收失败。
- 大手绘 `dataUrl` 是**本地合成**的 96×64 PNG（解码后 437 字节，PNG 字节哈希
  `ac89a91b4ebf9afcaeebb160c5e3a6170f9eb39b0bc8fd6cbbf5eecd73619c3f`，`optimize=True`），
  没有任何外部素材或真实截图。

## 4. 用法

```ts
import { FIXTURES, seedFixture, countCollections } from '../fixtures/migrations';

await seedFixture(page, 'v2-full'); // addInitScript：每次导航都在应用脚本之前写入 localStorage
await page.goto('/');
const counts = countCollections(await readState(page));
```

`index.ts` 对外提供：

| 导出 | 作用 |
| --- | --- |
| `v2Full` / `v2Messy` / `v2Minimal` | 静态 import 的 JSON 对象（`v2-broken` 无法 import，见下） |
| `FIXTURES` | `{ id, file, purpose, expect, raw }` 注册表；`expect` 就是本文件第 5 节的可验收条目 |
| `seedFixture(page, id, { onboarded })` | 用与 `tests/e2e/helpers.ts#seedState` 相同的 `addInitScript` 方案播种；`v2-broken` 原样写入字符串 |
| `loadFixtureText` / `loadFixtureJson` / `fixturePath` / `fixturesDir` | 读磁盘原文 / 解析 JSON（坏样本会抛错） |
| `countCollections` / `absentCollections` | 逐集合计数 / 列出文件里缺失的集合 |
| `COLLECTION_KEYS` / `REQUIRED_COLLECTION_KEYS` / `OPTIONAL_COLLECTION_KEYS` | 集合名录 |

`v2-broken.json` 是**故意损坏**的文件，静态 JSON import 会在编译期报错，因此 `index.ts` 只用
`fs.readFileSync` 读它；`seedFixture` 对 `raw: true` 的样本直接写入原始字符串，不做 `JSON.stringify`。

## 5. 每个夹具练什么、预期结果

### 5.1 `v2-full.json` —— 完整状态往返（基线）

覆盖：13 个集合全部非空 + 全部配置对象；凭据全为虚构标记。

预期（`fixtures-migration.spec.ts` 断言）：

1. 应用启动后 `main` 可见，`pageerror` 为空。
2. 启动后 localStorage 里每个集合的数量与夹具一致；`reload` 之后再读一次仍然一致 —— 没有任何集合被静默丢弃。
3. `obsidianConfig.accessKeyId`、`wucaiConfig.token`、`youdaoConfig.token`、`aiConfig.provider`、
   `cloudflareSync.workerUrl`、`webdavConfig.username`、`gotabPrefs.wallpaperType` 原样保留。
4. `backupPolicy` / `homeBlocks` / `connectionTests` / `purposes` / `sampleBatch` 这些对象型字段 тоже往返，
   不会被默认值覆盖。
5. 夹具文件自身的 raw/LF 哈希与逐集合数量在「播种 → 读回」前后不变（见 5.5）。

### 5.2 `v2-messy.json` —— 脏数据存活

覆盖（计划要求的六类样本都在这里）：

| 场景 | 夹具落点 | 预期结果 |
| --- | --- | --- |
| 相同 URL、不同批注 | 两条 `annotations` 都指向 `https://annotated.fixture.invalid/article`，文本与颜色不同 | 两条都存活，不被去重（启动 + reload 后仍为 2 条，文本集合不同） |
| 来源 ID 碰撞 | `sites[0].id = servers[0].id = notes[0].id = src-0001`；`annotations[2].id = wucaiHighlights[0].id = wc-collide-0001` | 集合本身不丢数据；**明文导入会被校验拒绝**（见 5.6 与〈已知问题〉2） |
| 孤立引用 | 项目的 `noteIds` / `siteIds` / `serverIds` / `reminderIds` 指向 `ghost-*-9999`；`annotations[].projectId` 指向 `ghost-project-9999` | `#/projects` 正常渲染，项目详情可打开，幽灵 ID 不以条目形式出现，`pageerror` 为空 |
| 月末提醒 | `messy-rem-0001` 锚定 2026-10-31（`1793404800000`），`monthly`，`autoRollover: false` | 原值保留，不发生顺延；2 月没有 31 日也不会崩 |
| 闰日提醒 | `messy-rem-0002` 锚定 2028-02-29（`1835395200000`），`yearly`，`autoRollover: false` | 原值保留，ISO 时间正是 `2028-02-29T00:00:00.000Z` |
| 大手绘 | `handwritings[0].dataUrl` = 合成 96×64 PNG | 原样存活（字符串逐字节相等），`#/tools/drawing/new` 可渲染 |
| 缺失附件 | `notes[0].content` 引用 `../图片位置/missing-fixture-diagram.png` 与 `![[missing-fixture-attachment.pdf]]`，`attachments[]` 指向同一缺失键 | 笔记与引用原样保留；附件不存在是**预期**（附件属于 OSS 侧，夹具不伪造字节） |
| 未知 / 额外字段 | 根级 `legacyVersion`、`migratedFrom`、`customSections`、`legacyIdbMirror`、`extensionMirror`；条目级 `sites[0].legacySource`、`notes[0].attachments` | 文件里必须保留；应用首次持久化后会丢失 —— 见〈已知问题〉1 |

### 5.3 `v2-minimal.json` —— 归一化补全

只保留 `theme` + `validateHubState()` 认定的 5 个必填集合（`sites` / `servers` / `secrets` /
`reminders` / `notes`），其余键**完全不存在**（`absentCollections()` 恰好等于 8 个可选集合）。

预期：

1. 应用启动不白屏，`main` 可见，无 `pageerror`。
2. 8 个缺失集合在持久化后成为空数组 `[]`。
3. `categories` 缺失时回落为 `INITIAL_STATE` 的默认分类（首项 `全部`，**不是空数组**）。
4. 缺失的配置对象补默认值：`obsidianConfig.enabled === false`、`prefix === 'vault/'`、
   `aiConfig.provider === 'gemini'`、`cloudflareSync.enabled === false`、
   `webdavConfig.pathPrefix === 'selfhub_sync'`、`gotabPrefs.searchEngine === 'google'`。
5. 夹具自带的 3 个集合条目仍在（各 1 条）。

### 5.4 `v2-broken.json` —— 坏 JSON 兜底

`v2-broken.json` 在 `servers[0].notes` 的字符串中间被截断（没有闭合引号 / 括号 / 花括号），
`JSON.parse` 必定抛错，文件末尾不是 `}`。

实际行为（已按当前实现断言）：

1. 不白屏：`main` 仍然可见，坏数据没有被半应用（坏样本里的 `broken-site-0001` / `broken-srv-0001` 不出现在状态里）。
2. `loadHubState()` 的 `catch` 把原始字符串复制到抢救键 `self_hub_data_v2__corrupt_<timestamp>`，
   逐字节相等 —— 原始数据可事后取回。
3. 主键被写回归一化后的状态：`schemaVersion === 2`，13 个集合全部是数组（空集合是允许的）。
4. `reload` 后依然可用；因为本用例用 `addInitScript` 在每次导航前重新写入坏载荷，
   每次启动都会**再**生成一个抢救键（列表长度 ≥ 1，且每个键的值都等于坏载荷原文）。

### 5.5 夹具文件不被测试改动

对 `v2-full` / `v2-messy` / `v2-minimal` 各跑一条用例：记录文件哈希与逐集合数量 → 播种 → 启动 → `reload`
→ 再读磁盘文件与持久化状态。断言：文件哈希不变、逐集合数量不变、归一化后每个集合的数量**不小于**文件中的数量。
这样既守住「播种不会改动夹具文件和其中的计数」，也守住「归一化只能补全，不能删数据」。

### 5.6 加密导出 → 隔离环境恢复（计划第 3 条）

用例 `加密导出 → 隔离环境恢复：逐集合数量与文件哈希可记录` 用 `v2-full` 走完整链路：

1. 打开 `#/settings/data`，输入虚构主密码（`fixture-pass-not-a-real-secret`，不写入仓库外的任何地方），
   点「导出加密包」下载 `self-hub-encrypted-backup-<date>.enc.json`。
2. 记录产物：本次运行 `bytes=14133`、`sha256=c9ea139ea2fc8d5c6b2c78626ab4ebc185c3867c463c19ef4df23ca3c172434a`
   （密文含随机 salt/iv，**每次运行 hash 都不同**，所以用例把 hash 打印到测试输出并写进
   `testInfo.annotations['encrypted-export']`，而不是断言固定值）。
   `payload.summary` 与夹具逐集合数量必须一致：
   `sitesCount=3, notesCount=2, secretsCount=2, serversCount=2, projectsCount=1, remindersCount=3, inboxCount=2`。
3. 密文文件里不得出现明文标记：不含 `TESTKEY-not-a-real`、不含 `fixture.invalid`。
4. 隔离环境：`browser.newContext()` 新建**全新上下文**（只写 `selfhub_onboarded`，不播种任何夹具），
   确认它是干净档案（不含 `full-site-0001` / `full-note-0001`，计数与夹具不同），再把刚才的密文文件导入。
5. 断言：出现「✅ 加密备份已成功解密并恢复」提示，导入后 13 个集合的数量**逐个等于** `v2-full` 的数量。
6. 旧数据未被静默覆盖：导入前的状态被写入回滚快照 `self_hub_rollback_snapshot`，
   快照内容等于导入前读数、且不含夹具 ID。

## 6. 旧 IndexedDB / chrome.storage 格式样本

旧写入源的形状以字段形式内嵌在 `v2-messy.json`，作为迁移时必须识别、且**不能丢**的样本：

- `legacyIdbMirror`：旧 IndexedDB（`self_hub_idb` v1）的导出镜像 —— `metadata`（key/value）、
  `sites`（keyPath `id` 的记录）、`blobs`（二进制附件槽位）。
- `extensionMirror`：`chrome.storage.local` 镜像（`source: "chrome.storage.local"`、
  `capturedAt`、`payload.bookmarks` / `payload.annotations`）。
- 条目级 `legacySource: "extension-bookmarks"`、根级 `migratedFrom: "chrome.storage.local:fixture.legacy.mirror"`。

这些样本本身只描述格式（`blobs` 不含真实字节、`payload.annotations` 只引用夹具 ID）。
它们当前会在应用首次持久化时被丢弃，见〈已知问题〉1 —— 那正是 P0-03/P2 迁移需要先解决的问题。

## 已知问题

> 以下每条都写明了是「用例已断言」还是「代码阅读结论」。用例断言的都是**当前真实行为**，
> 不是期望行为；修复后请同步更新 `tests/e2e/fixtures-migration.spec.ts` 与本文件。

1. **【用例已断言】未知字段在应用首次持久化后被丢弃。**
   `normalizeHubState()`（`src/lib/storage.ts`）返回的是固定字段对象，只保留它认识的键。
   因此根级 `legacyVersion`、`customSections`、`legacyIdbMirror`、`extensionMirror` 以及条目级
   自定义字段（`sites[0].legacySource`、`notes[0].attachments`）在应用启动并 `saveHubState()` 之后
   就从 localStorage 消失了 —— 尽管它们仍在夹具文件里。
   影响：迁移前若旧写入代（扩展、旧标签页）在 v2 载荷里附加了自己的标记，这些标记会在第一次
   打开新版页面时被抹掉；P0-03「旧写入保护」与 P2 迁移不能依赖这类字段存活，也说明迁移前
   必须先冻结旧写者，而不是靠字段共存。
   用例：`【已知问题】根级未知字段在应用首次持久化后被丢弃`。

2. **【用例已断言】`validateHubState()` 的重复 ID 检查跨集合共用 `seenIds`。**
   `checkColl()` 对 sites / servers / secrets / notes / reminders / checkIns / handwritings /
   inbox / projects 共用一个 `Set`，于是「站点和笔记恰好用了同一个来源 ID」也会被报成
   `重复 ID`，整份明文备份被拒绝导入。
   v2-messy 里的 `src-0001`（站点 + 服务器 + 笔记）与 `wc-collide-0001`（批注 + 五彩划词）就是
   这种合法碰撞；用例验证的当前行为是：导入被拒绝（弹窗同时出现「重复 ID」与
   「恢复中止以保护现有数据」），**旧数据一条不少**。
   影响：来自扩展的数据源 ID 天然会跨集合复用，这类备份现在无法导入；正确做法应是在集合内判重，
   跨集合仅在真正写入同一 store 时才有意义。
   用例：`跨集合重复 ID 的明文导入被拒绝，现有数据原封不动`。

3. **【用例已断言】抢救键没有 UI 入口，且每次带着坏载荷启动都会新增一个。**
   损坏载荷被复制到 `self_hub_data_v2__corrupt_<timestamp>` 后，界面上没有任何入口列出、导出或恢复它；
   用户只能打开 DevTools 才能拿回数据。本次用例通过 `addInitScript` 在每次导航前重新写入坏载荷，
   所以每次启动都会产生一个新的抢救键（真实用户在一次启动后主键已被替换成正常状态，通常只会有一个，
   但坏加载重复发生时会持续堆积）。
   影响：数据虽然没丢，但「可恢复」目前只对开发者成立；建议在设置→数据里列出抢救快照并提供导出。

4. **【代码阅读结论，未由夹具覆盖】非数组集合会被静默清空，且不产生抢救副本。**
   `normalizeHubState()` 对 13 个集合一律用 `asArray()`：`sites: {}`、`notes: "…"` 这类
   类型错误（JSON 仍可解析）会被静默变成 `[]`，因为 `JSON.parse` 成功，
   `loadHubState()` 的 `catch` 不会触发，也就没有抢救键。
   建议：类型不符时至少写入一份抢救副本，或让校验把这类载荷判为需要人工确认。

5. **【环境提示，非产品缺陷】并发跑 Playwright 会互相踩 `test-results/` 与 5173 端口。**
   `playwright.config.ts` 的 trace/artifacts 目录是共享的，且 `webServer.reuseExistingServer: true`
   让所有并发运行共用同一个 Vite 进程。观测到的两种表现：
   （a）收尾时报 `browserContext.close: ENOENT ... .playwright-artifacts-*`；
   （b）某个并发运行结束时杀掉了共用的 Vite dev server，之后本套用例会连续出现
   `locator('main')` 找不到（页面根本没有可访问的服务器），整轮从某条用例起全部失败。
   这不是用例逻辑问题：待没有其它 `playwright test` / `vite` 进程后重跑，
   命令 `npx playwright test tests/e2e/fixtures-migration.spec.ts --reporter=list` 为 16 passed。
   跑 P0-02 用例时请串行执行，或先确认没有别的 `playwright test` / `vite` 进程。

## 8. 运行方式

```bash
npx playwright test tests/e2e/fixtures-migration.spec.ts --reporter=list
```

16 条用例：夹具注册表与文件完整性 5 条、`v2-full` 2 条、`v2-messy` 5 条、`v2-minimal` 1 条、
`v2-broken` 1 条、导入保护 1 条、清空存储兜底 1 条。

稳定性依赖两点，请勿在夹具里破坏：

- 所有 `createdAt` / `targetDate` 都是**固定 epoch 常量**，用例不做「当前时间」相关断言；
  月末（2026-10-31）与闰日（2028-02-29）提醒都设 `autoRollover: false`，
  所以 `RemindersView` 的自动顺延永远不会改写它们。
- `seedFixture()` 用 `addInitScript` 播种：**每次导航都会重新写入原始载荷**，应用随后用归一化结果覆盖主键。
  因此「reload 后读回」验证的是应用的持久化输出；但任何需要「干净环境」的用例必须新建
  `browser.newContext()`，而不能只清 localStorage（否则 init script 会把夹具再写回来）。

## 9. 与 P0-02 计划的对应

| 计划条目 | 落点 |
| --- | --- |
| 收集 v2 HubState / 旧 IDB / chrome.storage 格式样本，只用虚构凭据 | 四个 JSON 样本 + 第 6 节的 `legacyIdbMirror` / `extensionMirror` + 第 3 节凭据策略 |
| 相同 URL 不同批注、来源 ID 碰撞 | `v2-messy.json`：`ann-shared-0001/0002`、`src-0001`、`wc-collide-0001` |
| 孤立引用 | `v2-messy.json`：`ghost-*-9999` + `ghost-project-9999` |
| 月末提醒 | `v2-messy.json`：`messy-rem-0001`（2026-10-31）与 `messy-rem-0003`（2026-01-31） |
| 大手绘 | `v2-messy.json`：`messy-hw-0001` 合成 PNG |
| 缺失附件 | `v2-messy.json`：`notes[0].content` 与 `attachments[]` |
| 坏 JSON | `v2-broken.json` + 5.4 的抢救键断言 |
| 加密导出与恢复走通，记录各集合数量与文件 hash | 5.6 + 第 1 节哈希表 |
| 验收：无真实密钥 / 每种失败有预期 / 旧数据未被覆盖 | 第 3 节黑名单扫描、第 5 节逐条预期、5.6 与问题 2 的「旧数据原封不动」断言 |

# Self-Hub 代码审计、缺陷修复与回归测试报告

日期：2026-10-16
范围：`src/`（React 19 + Vite + TS 主体）、`extension/`（Chrome MV3 扩展）、构建与本地开发链路
方法：静态深读 + 真实浏览器（Playwright/Chromium）驱动复现 + 修复后回归

---

## 一、结论摘要

用户反馈"太多 bug、完全无法使用"，经审计与实机复现，确认存在 **3 类会直接导致"打不开/点不动/数据丢"的致命缺陷**，另有 8 项高危、14 项中危问题。全部致命与高危问题已修复，并补齐了 21 条 Playwright 回归测试（`npm run test:e2e`）。

修复前的实测数据（复现为事实，非推断）：

| 现象 | 修复前 | 修复后 |
| --- | --- | --- |
| `npm run dev` | **直接启动失败**（端口 3000 被 Windows 排除端口段占用 → `EACCES`） | 正常启动（默认 5173，可用 `PORT` 覆盖） |
| 金库锁定时新增凭据 | **解锁弹窗被录入弹窗完全盖住，无法输入** → 凭据录入 100% 阻塞 | 弹窗层级修正，可正常解锁并保存 |
| 导入缺少可选字段的旧备份 | **整页白屏**（`Cannot read properties of undefined (reading 'length')`），无错误边界 | 正常渲染，缺失集合自动补默认值 |
| "记住这台设备 30 天" | 刷新即失效（承诺虚假） | 刷新后仍解锁，30 天有效期，密码经设备密钥包裹存 IndexedDB |
| 提醒自动顺延 | `while` 无 else 分支 → 遇到非法 `recurring` **主线程死循环，标签页卡死** | 有界推进，非法周期直接跳过 |
| "重置所有数据" | 删的是 `SelfHubDB`，真实库名 `self_hub_idb` → **IndexedDB 明文残留** | 真实删除并验证 |
| 单次操作写盘次数 | **2 次**全量 `localStorage` 写入（React StrictMode 双调用 updater 内的副作用） | **1 次** |
| 300 个书签首屏 | **489ms** + **300 个外网 favicon 请求**（把每个书签域名发给 Google） | **177ms** + **0 个外网请求** |

---

## 二、致命缺陷（已修复）

### F1. 任何渲染异常都会导致整页白屏且无法自救
- 位置：`src/main.tsx`（无 ErrorBoundary）、`src/App.tsx:708`、`src/lib/storage.ts`
- 根因三重叠加：
  1. 全仓库没有 ErrorBoundary，任一视图抛错即整树卸载；
  2. 恢复备份走 `onRestoreState(restored)` → 直接 `setState`，绕过了 `loadHubState` 的 `{...INITIAL_STATE, ...parsed}` 合并；
  3. `validateHubState` 只校验 5 个数组，`importEncryptedBackup` 更是原样返回，缺 `checkIns`/`handwritings`/`categories`/`obsidianConfig` 的备份能通过校验。
- 实测复现：导入一份缺 4 个字段的备份 → `rootHtmlLen: 0`、`pageerror: Cannot read properties of undefined (reading 'length')`。
- 修复：
  - `src/lib/storage.ts` 新增 `normalizeHubState()`，对所有集合/嵌套配置做深合并与类型兜底；`loadHubState`、`importBackup`、`importEncryptedBackup` 统一走它；
  - `validateHubState` 覆盖全部集合与字段类型；
  - 新增 `src/components/ErrorBoundary.tsx`，提供"重新加载 / 导出原始数据 / 清空重置"三条自救路径，并同时在根节点（`main.tsx`）与每个视图（`App.tsx`，按 tab 分键）挂载。
- 验证：`tests/e2e/vault-and-backup.spec.ts` → 「导入缺少可选字段的旧备份不会白屏」；实证脚本 R2 从 `blank: true` 变为 `blank: false` 且无 page error。

### F2. 金库锁定时录入凭据被弹窗遮挡，功能完全阻塞
- 位置：`src/App.tsx`（MasterKeyModal 与 AddItemModal 同为 `z-50`，AddItemModal 在 DOM 中靠后），`src/components/modals/MasterKeyModal.tsx`
- 实测复现：在锁定态下提交凭据 → 解锁弹窗出现，但在其密码框中心点做命中测试，返回的是 AddItemModal 的输入框（`topElementIsPasswordInput: false`），真实用户点击落在被遮挡层上。
- 修复：解锁弹窗提升至 `z-[100]`；录入弹窗改为页内错误提示 + `onRequireUnlock()`；提交期间禁用按钮（PBKDF2 100k 迭代期间防重复提交）。
- 验证：回归测试断言"密码框中心点的最上层元素就是它自己"，并走完解锁→保存全流程。

### F3. 提醒自动顺延死循环，进页面即卡死
- 位置：`src/components/views/RemindersView.tsx:77-91`（原 `while (next.getTime() < nowTs)` 无 else 分支）
- 触发：`autoRollover: true` + 已过期 + `recurring` 为 union 外的真值字符串（只能来自导入备份，而备份校验不严）→ `next` 永不前进。
- 修复：`src/lib/dates.ts` 新增 `advanceRecurringDate()`，白名单校验周期、最多 1200 步硬上限，非法值返回 `null`；同时 `nextRenewal()` 处理"已过期需推进到下一个未来周期"与"一次性事项不虚构 +30 天"。
- 验证：回归测试注入 `recurring: 'daily'` + 400 天前到期，断言 UI 仍可点击、主线程未阻塞。

---

## 三、高危缺陷（已修复）

| # | 问题 | 位置 | 修复 |
| --- | --- | --- | --- |
| H1 | `saveHubState` 写在 `setState` updater 内：StrictMode 必然双调用 → 每次操作 **2 次**全量 `JSON.stringify` + `setItem` + IDB 事务；返回值被丢弃，配额超限后静默丢数据 | `App.tsx:61-67`、`storage.ts:174` | 持久化移入 `useEffect`（每次提交只写一次）；`saveHubState` 不再就地改写入参；配额失败在页面顶部显示常驻红色告警并直达导出备份 |
| H2 | 加密备份恢复只 `setState` 不落盘，"恢复成功"后刷新即回退 | `SettingsModal.tsx:145-149` | 统一由 App 的持久化 effect 落盘；并新增"撤销上次导入"回滚入口（此前快照只写不读） |
| H3 | "重置所有数据"删除的是不存在的 `SelfHubDB`，真实库 `self_hub_idb` 明文残留 | `SettingsModal.tsx:176` | 新增 `deleteAllDatabases()`（先关连接再删，带 `onblocked` 兜底）；实测重置后 IDB 中标记数据消失 |
| H4 | "记住这台设备（30 天免密）"只活在当前页面内存，`sessionStorage` 标记只写不读 | `crypto.ts:174-200` | 新增 `src/lib/trustedDevice.ts`：随机设备密钥 + AES-GCM 包裹主密码存 IndexedDB，30 天过期自动清理；锁定时一并销毁 |
| H5 | 锁定金库后卡片上的明文继续显示（本地 state 未清） | `SecretCard.tsx` | 监听 `masterPassword` 变化与 `selfhub:vault-locked` 事件清空明文；解密/复制失败不再一律当作"未解锁"，给出区分提示 |
| H6 | 笔记草稿保存后不清除 + 草稿归属不清 → "恢复草稿"会静默覆盖**另一篇**笔记正文 | `NotesView.tsx:67-122,199` | 保存成功后清除草稿；恢复草稿时同步切换选中项；编辑中切换/取消先确认；无草稿时复位提示 |
| H7 | 收件箱已分流条目可重复转换（重复造数据）；转换后紧接一次基于旧快照的更新把 `targetId` 抹成 `undefined`（溯源链断裂）；删除无确认 | `InboxView.tsx:378-405,483` | 转换按钮加已分流守卫与禁用态；移除多余的第二重更新，交由父组件写入 `targetType/targetId`；删除加确认；编辑不再清空既有 `url` |
| H8 | 签到把"打开页面"和任意 2xx 判为成功、无超时（请求悬挂则卡片永久转圈、"一键全签"永久阻塞）、错误一律报 CORS | `automation.ts` | 新增 15s 超时（`AbortSignal.timeout`）、URL 先校验、2xx 响应体业务码判定（`code/success/ok/error` + 未登录/失败文案）、`verified` 语义区分"已打开页面"与"已确认签到"；油猴脚本模板移除非法 `:contains()` 选择器改用文本匹配 |

---

## 四、中危与体验问题（已修复）

- **项目 → 关联笔记跳转失效**：`onNavigateTab('notes', id)` 的第二个参数被吞掉。已打通 `focusNoteId` 深链，全局搜索点击笔记结果也会定位到该篇。
- **提醒日期东八区错位一天**：`toISOString()`（UTC）与 `<input type="date">`（本地）混用。新增 `lib/dates.ts` 本地日期工具，创建/编辑/展示统一走本地日；"今天到期"不再显示 `D-0 天`。
- **`completed` 是死状态**：`onToggleComplete` 解构后从未使用。已在卡片上加入"标记完成/取消完成"入口。
- **弹窗状态不重置**：AddItemModal / MasterKeyModal / AiIngestModal / SettingsModal 关闭后残留上次输入（含已粘贴的明文密钥、红字报错）。统一在打开时重置。
- **设置页陈旧状态覆盖配置**：SettingsModal 常驻挂载且只在首次挂载取 props，打开时会用旧值覆盖真实配置，并无条件把 OSS 置为 `enabled: true`。已在打开时从 props 重新同步，`enabled` 按是否真正配置齐全计算。
- **AI 导入 Self-Hub 自身导出文件会把凭据加密成空串**（原值永久不可还原）：`ParsedSecret` 补齐加密字段，已是密文的原样保留，缺明文的跳过并提示，锁定金库时不再静默丢凭据。
- **书签导入**：同一文件无法二次选择、分类不注册到筛选条、重复导入产生重复条目、`reader.onerror` 缺失。已修复并加入 URL 归一化去重。
- **触屏删除按钮不可达**：`opacity-0 group-hover:opacity-100` 在触屏上永不显现（3 处）。补 `opacity-100 sm:opacity-0`。
- **手绘**：空画板会存出一张纯黑卡片；满分辨率 PNG 直塞 localStorage 是最快撑爆配额的方式。已阻止空保存并按 1280px 上限降采样。
- **多标签页互相整块覆盖**：新增 `storage` 事件监听与醒目告警条（含"重新加载"），避免静默丢失。**注意：这是"可见化 + 提示"，不是自动合并**，真正的冲突合并仍待做（见第六节）。
- **剪贴板失败仍提示成功**（SiteCard / NotesView / SecretCard / Sidepanel）：改为 `await` + `catch` 并给出失败提示。
- **复制/解密错误诊断**：区分"金库锁定"与"该凭据由另一主密码加密"，不再让用户陷入"解锁→正确→再失败"的死循环。

---

## 五、性能实测（同一脚本、同一环境、修复前后对比）

探针：`.audit/perf.py`（写入 `localStorage.setItem` 计数 + `requestAnimationFrame` 前后耗时）

```
修复前                                        修复后
setItem / 单次操作        2                   1
300 站点渲染             489.2 ms            177.4 ms
外网 favicon 请求        300                 0
校验和相同的单次新增      2 次写盘             1 次写盘
```

- **写放大**：StrictMode 下 updater 内副作用被双调用，是"每次编辑都写两遍全量 JSON"的直接原因。
- **外网请求**：`SiteCard` 原来对每个书签请求 `google.com/s2/favicons`。这对一个自我宣称"本地离线优先、无第三方追踪"的产品是隐私问题，且导入上千书签即上千请求。已改为纯本地确定性字母色块图标（无网络、无 404 噪音）。
- **大列表**：新增分页渲染（每页 60，按分类顺序分配预算 + "加载更多"），首屏只挂载可见部分。
- **搜索**：`SitesView` 用 `useDeferredValue` + `useMemo` 隔离输入与过滤；`SiteCard` 加 `React.memo`。

---

## 六、回归测试与运行方式

新增 21 条 Playwright 用例（`tests/e2e/`），覆盖冒烟、CRUD、金库、备份恢复、数据完整性、搜索定位：

```bash
npm run dev            # 本地开发（默认 http://127.0.0.1:5173）
npm run typecheck      # tsc --noEmit
npm run build          # tsc + vite build
npm run test:e2e       # 自动拉起 dev server 并跑完整回归（21 passed）
npm run test:e2e:ui    # 可视化调试
```

每条历史缺陷都对应一条会失败的回归断言，例如：

- `vault-and-backup.spec.ts` → 用 `document.elementFromPoint` 断言解锁弹窗确实是其密码框位置上的最上层元素（F2）；
- `vault-and-backup.spec.ts` → 导入缺字段备份后断言 `main` 仍可见、无 page error、`checkIns/handwritings/categories` 均为数组（F1）；
- `data-integrity.spec.ts` → 注入非法 `recurring` 后断言页面仍可点击（F3）；
- `data-integrity.spec.ts` → 保存笔记后断言草稿键为 `null`（H6）；
- `crud.spec.ts` → 收件箱转换后断言 `targetType/targetId` 仍在（H7）；
- `vault-and-backup.spec.ts` → 重置后直读 IndexedDB 断言标记数据已消失（H3）。

---

## 七、扩展（`extension/`）本次修复与遗留

已修复：

- **统一收件箱是"只写不读"的黑洞**：popup / 右键菜单 / 新标签页三处都提示"已保存"，但扩展内没有任何界面能看到它。侧边栏已新增「统一收件箱」页签（读取 `selfhub_inbox`，支持打开、删除、检索），并监听 `storage.onChanged` 实时刷新。
- **侧边栏列表与当前标签页脱节**：补 `tabs.onActivated/onUpdated` 监听；卡片跳转前校验 URL 是否属于当前标签，不再把消息发到错误标签页。
- **存储型 XSS**：侧边栏划线卡片原用 `innerHTML` 拼接任意网页选中的文本。已改为 `textContent`/`createElement` 构建。
- **"从扩展同步"丢来源 URL**：`DataInteropView` 读的是 `a.url`，扩展写的是 `a.pageUrl` → 每条导入批注的来源都是空串。已修正取值。
- **新标签页宫格永远是写死的 10 条**：网页端（在扩展内置 `app/index.html` 中打开时）新增 `src/lib/extensionBridge.ts`，把书签与批注镜像进 `chrome.storage.local.selfhub_sites / selfhub_annotations`，新标签页与侧边栏因此能看到真实数据。在普通浏览器标签页中该桥为空操作。

仍待处理（本次未做，需要单独排期）：

1. **划线锚点恢复机制形同虚设**（`content.js`）：锚点只写不读，恢复时按"全文首次命中"定位，跨节点选区与 SPA 路由切换后划线会错位或消失。这是划词产品的基本契约，建议改为 `prefix+text+suffix` 上下文匹配 + `MutationObserver` 等待正文。
2. **云端同步的静默数据丢失风险**（`sync/sync-manager.js`）：`getFile().catch(() => null)` 把"读取失败"当成"云端为空"，随后整文件覆盖上传；熔断仅覆盖 annotations 且本地 <10 条时不生效。建议区分 404 与读取失败、对每类实体做骤降判断、上传加乐观锁与远端备份。
3. **同步请求无超时**：状态机会永久停在"同步中"，建议 `AbortController` + 启动时复位超时的 `syncing`。
4. **云端数据与云凭据均为明文**，与设置页"端到端加密"文案不符：要么补 PBKDF2 + AES-GCM，要么改文案。
5. **S3 canonical URI 与原请求路径编码不一致**：`pathPrefix` 含中文/空格时必然 `SignatureDoesNotMatch`；`endpoint.includes(bucket)` 的 URL 风格判断在 `bucket='s3'` 这类取值下会丢 bucket 段。
6. 仓库根目录的 `extension.zip` 是**过期且结构错误的陷阱产物**（条目带 `extension/` 前缀、无 `app/`、`newtab.js` 为旧版）；应使用 `npm run package:extension` 产出的 `self-hub-chrome-extension.zip`。

---

## 八、已知限制（明确未修）

- **中文首字母检索覆盖不全**：`searchEngine.ts` 的 `PINYIN_MAP` 仅约 50 字，未收录汉字被直接丢弃，`rmkj`/`pzzn` 这类查询命中不了。修复需要完整拼音首字母表或引入离线拼音索引，属于独立工作量，本次未动。
- **多标签页冲突只提示不合并**：检测到别的标签页写入时给出告警与重新加载入口，但不会自动做集合级合并。
- **大列表只做分页渲染，未做虚拟滚动**：数万条时滚动性能仍需虚拟化。
- **`loadStateFromIndexedDb` 仍未被调用**：IDB 目前是"只写"的旁路备份；恢复路径仍以 localStorage 为准（配额告警文案已改为与事实一致）。
- **`updateState` 的 `useCallback` 尚未全覆盖**：`SiteCard` 的 `React.memo` 在部分回调上仍会被新函数引用击穿，收益已由分页渲染覆盖。

---

## 九、附录：阿里云 OSS 403 排查（2026-10-16 现场定位）

用户报告配置 OSS 后一直 403。对真实 Bucket（`self-hub` / `oss-cn-beijing.aliyuncs.com`）实测后确认原因，**并修正了最初"是 CORS 问题"的误判**：

### 9.1 关键前提：用户走的是扩展，不是域名

用户实际使用**扩展内置工作台**（`chrome-extension://<id>/app/index.html`）。扩展 `manifest.json` 声明了 `host_permissions: ["http://*/*","https://*/*"]`，覆盖 OSS 域名，因此 Chrome **对扩展页面豁免 CORS**。

实测证据（真实 Chromium 加载扩展后抓包）：请求只有一个 `GET`，**没有任何 `OPTIONS` 预检**，请求头里也没有 `Origin`。也就是说，**给 Bucket 配 CORS 规则对这条路径完全没有作用**——不要再往这个方向排查。

> 只有从 `http://127.0.0.1:5173`（dev server）或线上域名打开网页版时，CORS 才是必需的。

### 9.2 真正原因：`Date` 是 Fetch 禁止头，浏览器会静默丢弃

`Date` 在 Fetch 规范中属于 forbidden header name，浏览器不会发送它。OSS 因此返回：

```
403 AccessDenied — OSS authentication requires a valid Date.
```

这个缺陷**用 curl / PowerShell 无法复现**（它们会正常发送 `Date`），只有真实浏览器才暴露。旧版代码还把该 403 笼统显示为"请核对 AccessKey 权限"，把用户引向错误的排查方向。

经真实服务确认可用的签名方案：

```
发送头:  x-oss-date: <RFC1123 GMT>
StringToSign = VERB \n Content-MD5 \n Content-Type \n <x-oss-date>
               \n x-oss-date:<x-oss-date>\n
               \n /<bucket>/<key>
```

对照实验（同一 Bucket、同一密钥）：

| 方案 | 结果 |
| --- | --- |
| `x-oss-date` 头 + Date 行填其值 + 计入 CanonicalizedOSSHeaders | **200** |
| `x-oss-date` 头 + Date 行填其值（不计入 CanonicalizedOSSHeaders） | 403 SignatureDoesNotMatch |
| `x-oss-date` 头 + Date 行留空 + 计入 CanonicalizedOSSHeaders | 403 SignatureDoesNotMatch |
| 把查询参数并入签名（`/self-hub/?max-keys=1`） | 403 SignatureDoesNotMatch（OSS 回显的 StringToSign 证明查询参数不进签名） |

`prefix` / `max-keys` 等查询参数**不参与** V1 签名，签名资源路径只取 `/<bucket>/<key>` 是正确的。

### 9.3 在真实扩展环境中的前后对比

扩展包内嵌的是 `dist/` 构建产物，**源码修好不等于扩展修好**——必须重新执行 `npm run package:extension`，否则用户跑的仍是旧代码（这正是"配好 CORS 还是不行"的原因）。

| | 修复前（旧构建） | 修复后（重新打包） |
| --- | --- | --- |
| 扩展源 | `chrome-extension://mmiddjlp…` | 同左 |
| 预检 | 无（CORS 不参与） | 无 |
| 请求头 | 仅 `authorization`，无任何日期头 | `authorization` + `x-oss-date` |
| 连通测试 | 403 → 提示"请核对 AccessKey 权限" | **200 → ✅ 直连验证成功** |
| 写入笔记 | — | **PUT 200**（中文文件名 URL 编码为 `%E6%89%A9…`，签名用原始 Key） |
| 服务端复核 | — | 列表可见、GET 200 读回内容 |

Bucket 侧能力实测（测试对象均已清理，最终桶内 0 对象）：列表 200、写入 PUT 200、读取 GET 200、删除 DELETE 204。

### 9.5 多层目录树浏览（本次新增）

用户反馈"云端是多层级的，不能只搜索一层，页面也要 tree 格式显示桶里所有内容"。核查后确认原实现有两个硬伤：

1. **只发一页 `max-keys=200` 请求**，且完全没处理 `IsTruncated` / `NextMarker`。用户的桶有 **1951 个对象**，超出部分根本拿不到。
2. **前缀字段把内容过滤空了**：前缀填了桶里不存在的目录时，返回 0 条，界面却只说"该前缀下还没有 .md 文件"，让人以为云端是空的。

改造内容：

- `listOssObjects()`：按 `marker` 循环分页（每页 1000，安全上限 30 页），返回全部对象并附带 `matchedCount` / `bucketTotalCount` / `pages` / `truncated`。
- `buildOssTree()` / `filterOssTree()` / `countTreeFiles()`：把扁平 key 列表构建成树、按关键字剪枝（保留祖先目录）、统计文件与目录数。
- 新增 `src/components/OssTree.tsx`：目录可折叠、每层分页渲染（默认 100 项 + "加载更多"），避免 2000 个节点一次性挂载；搜索时自动展开命中路径。
- 选中文件时**按需拉取正文**（`fetchObsidianNoteContent` 此前从未被 UI 调用，选中的笔记其实看不到内容），并带加载中/失败状态。
- 前缀过滤为空但桶内确有对象时，明确提示"前缀把内容过滤空了"并给出桶内真实对象数 + 一键去清空前缀。
- 设置页前缀输入框补充说明：留空 = 列出整个 Bucket。

**过程中发现并修掉一个会让整个树功能静默失效的 bug**：`buildOssTree` 的目录递归在路径以 `/` 结尾时会**无限递归爆栈**（`'日记/'` 算出的父路径仍是 `'日记/'`），异常被 async handler 吞掉——表现为"摘要显示 1200 个对象、树却是空的"。修复方式是统一用**去掉尾部斜杠**的路径做索引，并在递归前先注册节点。

真实桶 + 真实扩展的实测结果：

```json
{ "tree_summary": "对象 1951",
  "pages": 2,
  "root_folders": ["个人研究 13","漏洞猎人 3","日记 4","图片位置 144","项目 6",
                   "重要 5","重要文件 1","ERP 1","textgenerator 1","unpacked 3","WuCai 571"],
  "notes_count": 1700 }
```

分页请求实测：第 1 页 `?max-keys=1000`，第 2 页 `?max-keys=1000&marker=日记%2F2023年%2F…`。

回归测试：`tests/e2e/oss-tree.spec.ts`（4 条：跨页拉取、树形展开+按需读正文、跨层级搜索、前缀过滤空提示）。

---

### 9.6 顺带修掉的相关缺陷

- `fetchObsidianNotes` 在请求失败或云端无 `.md` 时静默回退本地缓存，UI 却提示"已从阿里云 OSS 同步拉取" —— 现在返回 `source: 'oss' | 'oss-empty' | 'error' | 'cache'` 并据此提示。
- `saveObsidianNote` / `deleteObsidianNote` 恒返回 `success: true`，PUT/DELETE 失败也提示"已保存/已移除" —— 现在解析 OSS 错误文档（`<Code>`/`<Message>`/`<RequestId>`）并在消息中如实呈现，不再误导成权限问题。
- 对象 Key 未做 URL 编码：含 `#` 的笔记名会被浏览器当作 fragment，请求路径被截断且签名不符 —— 新增 `encodeOssKey()`（按路径段 `encodeURIComponent`，签名仍用原始 Key）。

### 9.5 回归测试

`tests/e2e/oss-signing.spec.ts`（3 条，含用 `node:crypto` 独立复算签名的断言）。已做反向验证：把代码改回 `Date` 时该用例会失败。

---

## 十、改动文件清单
新增：

- `src/components/ErrorBoundary.tsx` — 渲染错误自救边界
- `src/lib/dates.ts` — 本地日期/周期推进工具
- `src/lib/trustedDevice.ts` — 设备免密会话（IndexedDB 包裹存储）
- `src/lib/extensionBridge.ts` — 网页端 → 扩展 `chrome.storage` 镜像
- `playwright.config.ts`、`tests/e2e/{helpers.ts,smoke.spec.ts,crud.spec.ts,vault-and-backup.spec.ts,data-integrity.spec.ts}`

修改：

- `src/App.tsx`、`src/main.tsx`、`package.json`、`vite.config.ts`、`.gitignore`
- `src/lib/{storage.ts,crypto.ts,indexedDb.ts,automation.ts,aiParser.ts}`
- `src/components/modals/{AddItemModal,MasterKeyModal,SettingsModal,AiIngestModal}.tsx`
- `src/components/views/{SitesView,NotesView,RemindersView,InboxView,ProjectsView,DataInteropView}.tsx`
- `src/components/cards/{SiteCard,SecretCard,CheckInCard,HandwritingCard}.tsx`
- `extension/{sidepanel.html,sidepanel.js}`

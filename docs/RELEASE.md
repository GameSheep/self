# 发布 Chrome 扩展（版本 1.1.0）

> 目标：把 `C:\Code\self\self-hub-chrome-extension.zip` 作为 **1.1.0** 上传到 Chrome Web Store，
> 覆盖你已发布的 1.0.0。下面的每一步都在本机验证过。

## 0. 先在本地验证（可选，2 分钟）

```powershell
cd C:\Code\self
npm run build
npm run package:extension      # 会重新生成 extension/app 与 zip，并自检内嵌引用
```

自检输出应包含：`✅ 内嵌工作台校验通过（6 个引用全部存在，index.html 与 dist 一致）`。

想先在自己浏览器里试装：

1. `chrome://extensions` → 打开右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `C:\Code\self\extension`
3. 新标签页应该变成 Self-Hub；点页面里的入口可打开完整工作台

> 注意：解压安装的扩展和商店安装的扩展是**两个不同的扩展 ID**，`chrome.storage` 数据不互通。
> 本地试装只用来验证功能，不要在里面录入正式数据。

## 1. 上传新版本

1. 打开 [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole)
2. 选中 Self-Hub 这一项（当前线上 1.0.0）
3. 左侧 **「软件包」→「上传新软件包」**
4. 选择 `C:\Code\self\self-hub-chrome-extension.zip`
   - 包根目录直接是 `manifest.json`（已验证，不是嵌套文件夹）
   - `manifest.json` 的 `version` 为 **1.1.0**（必须大于线上 1.0.0，否则会报 "版本必须大于当前版本"）
5. 上传成功后会提示版本号，确认是 1.1.0

## 2. 填写审核信息

| 项目 | 建议内容 |
| --- | --- |
| 版本说明（What's new） | 见下方模板 |
| 权限说明 | **本次没有新增权限**（`permissions` 与 1.0.0 一致：activeTab / storage / unlimitedStorage / sidePanel / scripting / contextMenus / alarms / notifications），不需要重新论证 |
| 隐私政策 | 与已有条目保持一致（数据只存本机 + 用户自配的云端） |
| 截图 / 图标 | 若界面有变化，建议补一张新的新标签页截图 |

版本说明模板：

```
1.1.0
- 笔记支持多层文件夹树（新建/删除/移动），左侧目录更清晰
- 网页批注页改为展示窗口：可改自己的批注、删除、打开原始链接
- 远端笔记支持多个 OSS 桶，每个桶一张配置卡、标签独立
- 备份支持多目的地（WebDAV + OSS 各存一份）
- 修复：连接卡保存后仍提示「保存未生效」
- 隐藏有道云笔记相关入口（已导入的数据仍保留在本地与备份中）
- 阅读器与全局配色统一，浅色主题可读性修复
```

## 3. 提交与审核

1. 点 **「提交审核」**
2. 审核通常几小时到几天；期间不要修改包
3. 通过后会自动发布（若你选了"手动发布"，需在控制台点「发布」）

## 4. 发布后自检

1. 在商店页面确认版本是 1.1.0
2. 在**已安装 1.0.0 的浏览器**里等自动更新（通常几分钟到几小时），或 `chrome://extensions` 手动「检查更新」
3. 更新后确认：`chrome.storage` 里的书签/划线/设置**没有丢**（扩展更新不会清除 storage）
4. 新标签页 → 打开完整工作台 → 检查笔记文件夹、远端笔记多桶、批注页

## 5. 回滚

Chrome Web Store 不支持"回退版本号"，只能**发一个更高版本号**覆盖。所以：

- 上传前保留 `self-hub-chrome-extension.zip` 的副本（当前线上 1.0.0 的包也留一份）；
- 出问题时的做法是修好再发 1.1.1，而不是尝试撤回 1.1.0。

## 本版做了什么（隐私相关）

发布前已清除仓库与产物中的个人信息：

- 真实 TeraCloud 子域名 `toi.teracloud.jp` / `kurio.infini-cloud.net` → `https://your-host.example.com/dav/`
- 真实 OSS 桶名 `uiuecho-obsidian` → `example-obsidian-vault`
- 真实账号名 `gamesheep8246` → `example-user`
- 形似真实的 AccessKey → `LTAI5tEXAMPLE000000000`

验证方式：解包 zip 后对所有 `.js/.html/.json/.css` 全文检索上述串，结果为 **0 命中**。

## 附录：权限用途说明（Privacy practices 里要填的三个）

Chrome 审核要求对 `alarms` / `notifications` / `unlimitedStorage` 逐个说明用途。下面英文可直接粘贴
（后台界面是英文），中文是给你自己核对的，**内容与代码一一对应**，不是套话。

### 1. `alarms`

代码位置：`extension/background.js`（`ensureReminderAlarm` / `chrome.alarms.onAlarm`，周期 30 分钟）。

**EN（粘贴这段）**
```
Self-Hub stores reminders the user entered themselves (domain renewals, subscriptions, server expiry).
A repeating 30-minute alarm in the service worker checks that local list for items due within 3 days,
so a reminder still surfaces when no Self-Hub tab is open. The alarm only wakes the worker to read data
already stored on the device; it makes no network requests and transmits nothing.
```

**中文核对**：用户自己录入的到期提醒，靠 service worker 里 30 分钟一次的问询去比对"3 天内到期"；
没有这个定时器，只有打开页面时才可能提醒。它只唤醒后台读本机数据，不发网络请求、不上传。

### 2. `notifications`

代码位置：同上（`chrome.notifications.create`，`priority` 按剩余天数）。

**EN（粘贴这段）**
```
Used to display a local desktop notification when a reminder the user created becomes due within 3 days.
This is the only way a reminder can reach the user while the app tab is closed. Notifications are built
entirely on-device from the local reminder list, limited to at most one per reminder per day, and contain
no remote or advertising content.
```

**中文核对**：只用于"用户自己的提醒快到期"这一件事；纯本机生成、同一条每天最多一次、无广告无远端内容。

### 3. `unlimitedStorage`

代码位置：`extension/store.js`（IndexedDB：`annotations_v3` / `inbox_v3` / `bookmarks_v3` …）。

**EN（粘贴这段）**
```
All user content (bookmarks, page highlights and annotations, notes, inbox items) is stored locally in
IndexedDB. Annotations grow with every page the user highlights, and a personal library can exceed the
default per-extension storage quota, which would otherwise make new saves fail. unlimitedStorage only
lifts that local quota; nothing is uploaded to us — clouds are used only if the user configures their own
S3/OSS bucket or WebDAV server.
```

**中文核对**：内容全部存本机 IndexedDB；标注会随使用增长，超过默认配额就会写入失败；该权限只是解除本机配额，
开发者没有任何服务器，云端只有用户自己配的桶/WebDAV 才会用到。

### 如果审核还问其它权限

| 权限 | 一句话说明 |
| --- | --- |
| `storage` | 保存扩展自己的设置（搜索引擎、分类、上次同步时间）。 |
| `sidePanel` | 提供侧边栏，让用户在任意网页旁查看/编辑自己的划线。 |
| `scripting` + `activeTab` | 只在用户主动触发划线/采集时，向当前标签页注入脚本读取选中的文字。 |
| `contextMenus` | 右键菜单「保存到 Self-Hub」，同样是用户主动触发。 |
| `host_permissions` (`http://*/*`, `https://*/*`) | 划线需要面包屑化的页面上下文（标题/URL），且用户可能把库放在自己的任意 S3/WebDAV 域名下，无法预先枚举。 |

### 单一用途（Single purpose）可填

```
Self-Hub is a personal knowledge workspace: a new tab page plus a side panel that save bookmarks,
page highlights and notes to the user's own device (optionally their own cloud storage).
```


## 自定义域名部署与访问防护（Cloudflare Pages + Access）

> 2026-11 从「设置 > 隐私与安全」迁出——部署文档不属于隐私设置。

1. 本项目构建产物（`npm run build` 生成的 `dist` 目录）直接拖拽发布至 **Cloudflare Pages** 或任意静态托管服务即可秒级上线。
2. 在 Cloudflare Dashboard 绑定您的自定义域名（如 `my-hub.com`）。
3. 在 **Zero Trust > Access > Applications** 中为该域名添加门禁策略：设置规则为 *Include: Emails = 您的个人邮箱*。

效果：未经授权的访客打开该域名会被 Cloudflare 边缘直接拦截；只有输入您邮箱的 6 位临时验证码才能进入。

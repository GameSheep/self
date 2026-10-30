# P1 验收观察记录（UX-01～UX-12）

更新：2026-10-18 ｜ 对应[实施计划](SELF_HUB_IMPLEMENTATION_PLAN.md) P1-10 与[设计稿](superpowers/specs/2026-10-18-self-hub-redesign-design.md)第 12 节

本文件区分三类结论，避免把不同强度的证据混在一起：

- **自动化证据**：有可重复运行的 E2E 用例，命令与结果见[交接记录](SELF_HUB_PROGRESS.md)。
- **人工已核对**：本轮实际跑过页面或截图检查，但未做计时/成功率统计。
- **待人工观察**：需要真人按任务操作并记录完成时间、误入设置次数，本轮未做。

设计稿要求「在干净配置下做一次任务观察……记录成功率、误入设置次数与完成时间」。**本轮未做真人观察**，下表只给出自动化可覆盖的部分与截图为证的部分。

| 编号 | 场景 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| UX-01 | 无云配置首次使用：可添加网站、记录文本、编辑笔记、创建项目与提醒 | `p1-scenarios.spec.ts`「新装档案没有任何示例数据，也没有云配置依赖」；`p1-main-path.spec.ts` 全流程；`crud.spec.ts` | 自动化通过 |
| UX-02 | 从首页找常用网站：网站可直接打开，不先经过模块配置 | `p1-main-path.spec.ts`「首页可以直接打开常用网站，不经过模块配置」（新标签页 + 访问计数） | 自动化通过 |
| UX-03 | 快速记录：不强制选类型，提交后有本机保存反馈，刷新仍在 | `p1-main-path.spec.ts`「快速记录 → 收件箱 → 转为笔记 → 从资料库找回」；离线场景同样验证 | 自动化通过 |
| UX-04 | 找回资料：搜索结果能定位实际条目，说明全文索引覆盖范围 | `p1-main-path.spec.ts` 第 6 步（列表可定位）；`library-coverage` 明示搜索范围；`markdown.spec.ts` 14 条覆盖渲染 | 自动化通过（覆盖范围为「本机 + 已缓存正文」，未索引远端正文已明示） |
| UX-05 | 管理基础资源：可从导航进入服务器和金库，不要求切换产品模式 | `smoke.spec.ts`（13 条路由无控制台错误）；`aside [data-nav-child="servers"/"vault"]` 直接可见 | 自动化通过 |
| UX-06 | 设置 WebDAV 备份：单一引导完成测试、保存、启用、首次备份；只配 WebDAV 也自动触发 | `webdav.spec.ts`、`state-backup.spec.ts`（含仅 WebDAV 的自动触发用例，P1-09 验收项） | 自动化通过 |
| UX-07 | 取消连接修改：已保存配置与运行任务不变，草稿可放弃 | `connection-save.spec.ts` 前三条（离开不写、取消还原、保存才写） | 自动化通过 |
| UX-08 | 服务失败：本地已保存与远端失败同时可见，有重试或修复入口 | `p1-scenarios.spec.ts`「云端失败时本机保存与远端失败同时可见」 | 自动化通过 |
| UX-09 | 扩展与网页边界：用户能判断当前数据属于哪个环境，不出现无依据的「已同步」 | 设置「浏览器与设备」说明本机模式与采集权限；首页/设置均标注本机保存；`connectionState.ts` 不再把「已配置」当作「已同步」 | 自动化部分覆盖；**待人工观察**措辞是否足够清楚 |
| UX-10 | 恢复与迁移：有数量、冲突、缺失附件报告，失败不改当前有效数据 | `fixtures-migration.spec.ts` 16 条（含加密导出→隔离恢复逐集合计数、跨集合重复 ID 现在被接受、未知字段保留、坏载荷抢救、回滚快照） | 自动化通过（旧格式恢复的「数量/冲突报告」界面仍在 P2-06 范围） |
| UX-11 | 手机及键盘操作：可导航、搜索、查看、添加和处理提醒；焦点不被遮挡 | `p1-scenarios.spec.ts` 320px 无横向溢出；`navigation-menu.spec.ts` 窄屏与宽屏用例；截图 `p1-narrow-*.png` | 自动化部分覆盖；**待人工观察**焦点顺序与 200% 放大 |
| UX-12 | 全模块回归：网站、笔记、批注、项目、主机、凭证、提醒、签到、手绘、远端文件都有入口及验收 | `smoke.spec.ts` 13 条路由；各模块自有 spec；`p1-visual.spec.ts` 生成桌面/窄屏截图 | 自动化 + 截图；**待人工观察**「入口是否好找」 |

## 截图清单（人工复查用）

`docs/screenshots/` 下由 `p1-visual.spec.ts` 生成（1440×900 与 390×844）：

- 桌面：`p1-desktop-home`、`p1-desktop-navigation`、`p1-desktop-inbox`、`p1-desktop-library`、`p1-desktop-notes`、`p1-desktop-projects`、`p1-desktop-reminders`、`p1-desktop-servers`、`p1-desktop-assets`、`p1-desktop-vault-locked`、`p1-desktop-settings-connections`、`p1-desktop-settings-backup`
- 窄屏：`p1-narrow-home`、`p1-narrow-navigation`、`p1-narrow-library`、`p1-narrow-reminders`、`p1-narrow-checkins`
- 极窄：`p1-320-home`

重新生成：`npx playwright test tests/e2e/p1-visual.spec.ts`。

## 仍需人工完成的观察

以下三项必须在真机上由人操作，不能由自动化代替；本轮未做，不宣称已完成：

1. **干净配置下的五项任务观察**：打开网站、保存记录、查找笔记、找服务器、完成备份，记录成功率、误入设置次数与完成时间，并与旧版对照。
2. **键盘与放大**：Tab 顺序是否合理、焦点是否被浮层遮挡、200% 放大后核心操作是否仍可完成。
3. **扩展真实环境**：MV3 生命周期下的新标签页、采集与后台提醒；本轮所有扩展结论来自代码阅读与普通网页环境。

## P2 仍待解决（不在 P1 宣称范围）

- 本地事实来源仍是 `localStorage` 整包写入；事务、revision 与并发写入保护属 P2-01/P2-02。
- 扩展与网页仍是两个独立本机库，尚无受控命令与共享仓库；扩展整集合镜像仍在（已加只读拦截与合并保护），停写属 P2-04。
- 备份格式仍是 v2 明文清单 + 凭据剥离，不是 v3 加密 generation；恢复预览与冲突决策属 P2-05/P2-06。
- 首次访问前断网时按需加载的子包无法获取（无 service worker）；离线目前只保证「已打开过的页面继续可用」。
- 五彩与有道仍只能导入既有内容，真实拉取未接通（`fetchWucaiHighlights` / `fetchYoudaoNotes` 无调用者）。
- 主密码、设备信任与备份密码三者关系、以及金库密文的跨设备迁移，属 P2-03/P2-06。

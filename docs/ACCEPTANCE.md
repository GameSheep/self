# 验收清单：你要的三件事，现在怎么验证

更新：2026-10-19 ｜ 依据：P0–P2 的实施与自动化回归（当前 **343 条**端到端用例全绿）

这份文件只做一件事：把**你提出的需求**逐条对应到**可以亲手验证的证据**。每条都写明"怎么跑、应该看到什么"，不写"即将支持"。

先跑起来：

```bash
npm install          # 首次
npm run dev          # 打开 http://127.0.0.1:5173
```

数据都在本机（浏览器存储），**不会上传任何云端**；备份/恢复的云端测试只在你自己配置连接后才会发生。

---

## 一、快捷导航

| 你要的 | 现在能做的 | 证据（可运行） |
| --- | --- | --- |
| 常用网站 | 首页直接点开；卡片右键/⋯ 菜单可删除、复制链接；上移/下移/置顶/移动分组都会持久化 | `npx playwright test tests/e2e/navigation-menu.spec.ts` · `tests/e2e/p1-main-path.spec.ts` |
| 分组收藏 | 按分类分组展示；站内筛选即时匹配标题/描述/标签且**不发请求**；外部搜索**必须显式触发**并显示引擎名 | `tests/e2e/navigation-menu.spec.ts` |
| 书签导入 | 先预览数量/重复/未知字段，可整批撤销 | `tests/e2e/bookmark-import.spec.ts` |
| 新标签页 + 快速记录 | 扩展新标签页写入扩展库（不是自己写存储）；同一 `operationId` 重复提交只产生一条 | `tests/e2e/extension-protocol.spec.ts` |

手验路径：首页顶部输入框写一句 → 回车 →「已保存到本机」→ 收件箱里能看到这一条。

## 二、资料管理

| 你要的 | 现在能做的 | 证据（可运行） |
| --- | --- | --- |
| 笔记 | 新建/编辑/删除闭环；Markdown 编辑与预览、大纲、草稿恢复 | `tests/e2e/crud.spec.ts` · `tests/e2e/markdown.spec.ts` · `tests/e2e/markdown-editor.spec.ts` |
| 网页划线 / 批注 | 扩展采集划线（原文与我的批注分开存）；页面不匹配的采集会被拒绝（`PAGE_MISMATCH`） | `tests/e2e/extension-protocol.spec.ts` |
| 项目资料 | 项目关联笔记/收藏/服务器/提醒/凭证；**失效引用显式提示**；删除项目**不会**删掉资料；归档保留决策记录 | `tests/e2e/projects-refs.spec.ts` |
| 检索 | ⌘K/⌘P 统一检索：笔记正文、批注、收藏、服务器、提醒、项目、收件箱、手绘、金库名称、远端索引，**分组 + 命中片段 + 真实总数 + 覆盖说明**；支持拼音 | `tests/e2e/search-everything.spec.ts` · `tests/e2e/pinyin-search.spec.ts` · `tests/e2e/global-search-vault.spec.ts` |
| 远端笔记库 | OSS 目录树、全文索引（可取消）、反向链接、附件预览、重命名/移动（拒绝移动到自身子目录） | `tests/e2e/oss-tree.spec.ts` · `tests/e2e/vault-ops.spec.ts` · `tests/e2e/index-management.spec.ts` |

手验路径：⌘K 搜一个词 → 看到分组与片段 → 回车打开对应资料。

## 三、综合管理

| 你要的 | 现在能做的 | 证据（可运行） |
| --- | --- | --- |
| 服务器 | 新建默认"未探测"（不假装在线）；HTTP 检测、延迟、401 视为可达、5xx 不可达；无地址时说明原因 | `tests/e2e/server-health.spec.ts` |
| 凭证 | 金库独立解锁；列表在锁定时只显示名称与「需解锁」；明文只在解锁后复制；备份只含密文 | `tests/e2e/projects-refs.spec.ts` · `tests/e2e/connection-store.spec.ts` · `tests/e2e/p1-scenarios.spec.ts` |
| 域名 / 订阅 | 作为资源资产记录到期日与费用，与提醒联动 | `tests/e2e/reminder-recurrence.spec.ts` · `tests/e2e/smoke.spec.ts` |
| 提醒 | 逾期/近期/之后分档；完成与续期分开；月末与闰日正确；未授权通知时保留站内提醒 | `tests/e2e/reminder-recurrence.spec.ts` · `tests/e2e/checkin-and-reminders.spec.ts` |
| 签到 | 区分真实请求与仅打开页面；同一天不重复计连续天数；近 14 天记录与结果一致 | `tests/e2e/checkin-outcomes.spec.ts` · `tests/e2e/checkin-and-reminders.spec.ts` |
| 手绘 | 画板保存为卡片；空画板**不会**保存出空白卡片 | `tests/e2e/crud.spec.ts` |

## 你的 8 条执行要求

| 要求 | 现在的状态 | 证据 |
| --- | --- | --- |
| 1. 先核对差异、P0 再 P1 | P0（数据保护）与 P1（工作台）均已完成；每批的差异核对记录在交接记录里 | `docs/SELF_HUB_PROGRESS.md` 第 1–6 批 · `tests/e2e/data-integrity.spec.ts` · `salvage-payload.spec.ts` |
| 2. 首页打开网站 → 快速记录 → 收件箱 → 查找并打开资料 | 完整路径可用，且是自动化用例 | `tests/e2e/p1-main-path.spec.ts` |
| 3. 其余模块与设置重组都做，不是只做首页 | 七个设置分区、每个模块都有独立视图与用例 | `tests/e2e/settings-ia.spec.ts` · 本文件上两张表 |
| 4. 保护现有数据/草稿/凭证/远端文件 | 不覆盖旧数据；损坏载荷抢救；回收站与冲突副本；迁移前加密快照 | `data-integrity` · `salvage-payload` · `trash-conflict` · `fixtures-migration` · `vault-and-backup` · `restore-v3` |
| 5. 保存 / 测试 / 启用分开；只配 WebDAV 也能自动备份 | 三者是独立状态；仅 WebDAV 时自动备份确实会触发 | `tests/e2e/connection-save.spec.ts` · `tests/e2e/state-backup.spec.ts`（"只配置 WebDAV 时状态变化也会自动备份"） |
| 6. 按依赖推进、细节自决、重大变化才问 | 决策与理由写在每批记录里；没有擅自改需求 | `docs/SELF_HUB_PROGRESS.md` |
| 7. 每批跑检查并更新清单 | 每批都有：typecheck、专项用例、全量回归、首屏预算、剩余限制 | 同上（每批的"验证"表） |
| 8. P1 可运行版本供验收；P2/P3 不提前宣称 | 上面两节就是可验收的部分；P2 已完成，P3 **未开始**，能力清单里逐条写明"未实现" | `docs/SELF_HUB_CAPABILITIES.md` 的「明确未实现」 |

## 一条命令看全貌

```bash
npm run typecheck && npm run build          # 类型与构建
npx playwright test                          # 343 条端到端（约 11 分钟；会另起一个 preview 服务跑生产构建冒烟）
npm run measure:first-load                   # 首屏预算（当前 191.7 KB / 250 KB）
```

## 现在**没有**的东西（验收时请注意）

- **没有多设备同步**：没有服务端；跨设备只能导出加密包/迁移包手工搬。
- **没有切库的默认开启**：默认仍写 v2 整包；设置里可显式迁移到 v3 库（有加密快照与校验）。
- **没有 Obsidian 插件**；五彩/有道是「导入/手验」而不是自动拉取。
- **扩展的真机 worker 终止验收**与**连续 7 天真实使用观察**未做（需要真实机器与时间）。
- 详见 [能力与边界](SELF_HUB_CAPABILITIES.md) 的「明确未实现」。

---

## 这份清单自身的证据

写这份清单时我重跑了它引用的 10 个 spec（不是凭记忆写）：**72 条全部通过，2.6 分钟**。
其中与本文件直接对应的名字：

```
p1-main-path · navigation-menu · crud · server-health · projects-refs
checkin-and-reminders · state-backup · settings-ia · search-everything · data-integrity
```

最近一次全量回归：**343 passed / 0 failed（10.7 分钟）**。首屏：**191.9 KB / 3 chunk**（预算 250 KB）。

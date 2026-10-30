/**
 * P0-02 脱敏夹具注册表（tests/fixtures/migrations）
 *
 * 这里登记四个 v2 HubState 样本，供 Playwright 在“数据保护 / 迁移”场景下复用：
 * 完整的正常数据、刻意的脏数据、缺少全部可选集合的数据，以及损坏的 JSON。
 *
 * 约束：
 * - 夹具内全部为虚构凭据（`TESTKEY-not-a-real-secret-*`、`*.fixture.invalid`），不含任何真实密钥。
 * - 本模块不 import `tests/e2e/helpers.ts`：夹具目录与 e2e 目录的相对位置会在
 *   不同执行方式下变化，因此这里重复约 10 行 addInitScript 播种逻辑，保持零耦合。
 */
import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import v2FullJson from './v2-full.json' with { type: 'json' };
import v2MessyJson from './v2-messy.json' with { type: 'json' };
import v2MinimalJson from './v2-minimal.json' with { type: 'json' };

/** 与 src/lib/storage.ts 中的 STORAGE_KEY 一致（也与 tests/e2e/helpers.ts 相同）。 */
export const STORAGE_KEY = 'self_hub_data_v2';
/** 首启向导标记：夹具播种时默认写入，避免遮罩层挡住断言。 */
export const ONBOARDED_KEY = 'selfhub_onboarded';

export type FixtureId = 'v2-full' | 'v2-messy' | 'v2-minimal' | 'v2-broken';

export interface FixtureMeta {
  id: FixtureId;
  /** 文件名（相对 tests/fixtures/migrations/）。 */
  file: string;
  /** 这个样本练的是什么。 */
  purpose: string;
  /** 预期结果（人可读）。 */
  expect: string[];
  /** true 表示文件本身不是合法 JSON，必须原样写入 localStorage。 */
  raw: boolean;
}

/** localStorage 中应当出现的集合键（csv / 数组型）。 */
export const COLLECTION_KEYS = [
  'sites',
  'servers',
  'secrets',
  'checkIns',
  'reminders',
  'notes',
  'handwritings',
  'inbox',
  'projects',
  'annotations',
  'obsidianNotes',
  'wucaiHighlights',
  'youdaoNotes'
] as const;

export type CollectionKey = (typeof COLLECTION_KEYS)[number];

/** `validateHubState()` 认定的必填集合。 */
export const REQUIRED_COLLECTION_KEYS: CollectionKey[] = [
  'sites',
  'servers',
  'secrets',
  'reminders',
  'notes'
];

/** normalizeHubState() 会把缺失项补成空数组的集合。 */
export const OPTIONAL_COLLECTION_KEYS: CollectionKey[] = COLLECTION_KEYS.filter(
  (key) => !REQUIRED_COLLECTION_KEYS.includes(key)
);

export const v2Full: Record<string, any> = v2FullJson as Record<string, any>;
export const v2Messy: Record<string, any> = v2MessyJson as Record<string, any>;
export const v2Minimal: Record<string, any> = v2MinimalJson as Record<string, any>;

const FIXTURE_VALUES: Record<Exclude<FixtureId, 'v2-broken'>, Record<string, any>> = {
  'v2-full': v2Full,
  'v2-messy': v2Messy,
  'v2-minimal': v2Minimal
};

export const FIXTURES: FixtureMeta[] = [
  {
    id: 'v2-full',
    file: 'v2-full.json',
    purpose: '完整、真实感、全集合覆盖的 v2 HubState（全部凭据为虚构标记）。',
    expect: [
      '应用启动后 main 可见，无 pageerror',
      '站点 / 服务器 / 凭据 / 签到 / 提醒 / 笔记 / 手绘 / 收件箱 / 项目 / 批注各集合数量与夹具一致（没有任何集合被静默丢弃）',
      '配置类对象（obsidian / wucai / youdao / ai / cloudflare / webdav / gotab）字段被保留',
      '加密导出 → 清空环境 → 导入恢复后各集合数量仍与夹具一致'
    ],
    raw: false
  },
  {
    id: 'v2-messy',
    file: 'v2-messy.json',
    purpose:
      '脏数据样本：同 URL 不同批注、跨集合来源 ID 碰撞、孤立项目引用、月末与闰日提醒、大手绘 dataUrl、引用缺失附件的笔记、迁移不得丢弃的未知字段。',
    expect: [
      '应用启动后 main 可见',
      'URL 相同但文本不同的两条批注都存活',
      '孤立项目引用不会让「自研项目空间」崩溃（main 仍可见，项目名仍渲染）',
      '手绘条目（合成 PNG dataUrl）存活',
      '跨集合重复 ID 会被 validateHubState() 判为“重复 ID”，明文导入被拒绝且旧数据不被覆盖',
      '根级未知字段（legacyVersion / customSections / extensionMirror）在应用首次持久化后被丢弃（见 README 已知问题）'
    ],
    raw: false
  },
  {
    id: 'v2-minimal',
    file: 'v2-minimal.json',
    purpose: '只有必填集合、其余全部缺失的最小样本，用于验证 normalizeHubState() 补全。',
    expect: [
      '应用启动后不白屏，main 可见',
      '缺失的集合类字段被归一化为空数组',
      '缺失的 categories 回落为 INITIAL_STATE 默认分类（不是空数组）',
      '缺失的配置对象（obsidian / ai / cloudflare / webdav / gotab）被补为默认值'
    ],
    raw: false
  },
  {
    id: 'v2-broken',
    file: 'v2-broken.json',
    purpose: '故意截断、不是合法 JSON 的载荷，用于验证损坏数据的兜底与抢救。',
    expect: [
      'JSON.parse 必定失败（文件在对象中途被截断）',
      '播种后应用不白屏，main 仍可见，并按 INITIAL_STATE 渲染',
      '损坏载荷被复制到 self_hub_data_v2__corrupt_<timestamp> 抢救键，原始字节不丢失',
      '主键被写回归一化后的状态，应用可继续正常使用'
    ],
    raw: true
  }
];

export function getFixture(id: FixtureId): FixtureMeta {
  const entry = FIXTURES.find((f) => f.id === id);
  if (!entry) throw new Error(`Unknown migration fixture: ${id}`);
  return entry;
}

/** tests/fixtures/migrations 目录的绝对路径（从 cwd 向上查找，避免依赖 cwd 固定）。 */
export function fixturesDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'tests', 'fixtures', 'migrations');
    if (fs.existsSync(path.join(candidate, 'index.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Cannot locate tests/fixtures/migrations from cwd=${process.cwd()} (looked 8 levels up)`
  );
}

export function fixturePath(id: FixtureId): string {
  return path.join(fixturesDir(), getFixture(id).file);
}

/** 读取夹具文件的原始文本（v2-broken.json 只能这样读，它不是合法 JSON）。 */
export function loadFixtureText(id: FixtureId): string {
  return fs.readFileSync(fixturePath(id), 'utf-8');
}

/** 读取夹具文件并 JSON.parse；损坏样本会抛错，调用方需自行处理。 */
export function loadFixtureJson(id: FixtureId): Record<string, any> {
  return JSON.parse(loadFixtureText(id)) as Record<string, any>;
}

/** 统计任意 HubState 对象在 localStorage 中会出现的集合数量（缺失集合按 0 计）。 */
export function countCollections(state: Record<string, any> | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of COLLECTION_KEYS) {
    const value = state ? state[key] : undefined;
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

/** 原始样本里“根本没有这个键”的集合（用于验证归一化补全，而不是被丢弃）。 */
export function absentCollections(state: Record<string, any> | null | undefined): string[] {
  return COLLECTION_KEYS.filter((key) => !state || state[key] === undefined);
}

/**
 * 在应用启动前把夹具写入 localStorage。
 *
 * 与 tests/e2e/helpers.ts#seedState 使用同一套 addInitScript 方案：
 * 每次导航（含 reload）都会在页面脚本之前重新写入原始载荷，随后应用自身的
 * 挂载持久化会覆盖主键，因此“reload 后读回”读到的确实是应用的输出。
 */
export async function seedFixture(
  page: Page,
  id: FixtureId,
  options: { onboarded?: boolean } = {}
): Promise<void> {
  const entry = getFixture(id);
  const onboarded = options.onboarded ?? true;
  const value = entry.raw ? loadFixtureText(id) : JSON.stringify(FIXTURE_VALUES[id as Exclude<FixtureId, 'v2-broken'>]);
  await page.addInitScript(
    ([key, payload, flag]) => {
      window.localStorage.setItem(key as string, payload as string);
      if (flag) window.localStorage.setItem('selfhub_onboarded', '1');
    },
    [STORAGE_KEY, value, onboarded] as const
  );
}

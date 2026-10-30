/**
 * Explicit sample data (P1-03).
 *
 * The previous build seeded six example sites and a welcome note into every new
 * profile, which meant a first-time user's own library already contained data
 * they did not create — and the redesign explicitly forbids that ("示例数据必须
 * 在显式'体验示例'中创建，并可整批撤销，不污染正式库").
 *
 * So the samples live here, every id they create is recorded in
 * `state.sampleBatch`, and removing them deletes exactly those ids and nothing
 * else. A record the user edited is still removed, because it is still a sample
 * record — but a record the user created is never touched.
 */
import type {
  HubState,
  NavSite,
  QuickNote,
  ReminderItem,
  ServerDeployment
} from '../types';

export interface SampleBatch {
  sites: NavSite[];
  notes: QuickNote[];
  reminders: ReminderItem[];
  servers: ServerDeployment[];
}

const SAMPLE_PREFIX = 'sample-';

function stamp(): number {
  const base = Date.now();
  return base;
}

export function createSampleData(): SampleBatch {
  const now = stamp();
  return {
    sites: [
      {
        id: `${SAMPLE_PREFIX}site-github`,
        title: 'GitHub',
        url: 'https://github.com',
        category: '示例 · 技术开发',
        description: '示例条目：代码托管与开源协作平台',
        icon: 'Code2',
        tags: ['示Git'],
        pinned: true,
        visitCount: 0,
        createdAt: now
      },
      {
        id: `${SAMPLE_PREFIX}site-mdn`,
        title: 'MDN Web Docs',
        url: 'https://developer.mozilla.org',
        category: '示例 · 技术开发',
        description: '示例条目：Web 标准参考文档',
        icon: 'BookOpen',
        tags: ['示例'],
        pinned: true,
        visitCount: 0,
        createdAt: now
      },
      {
        id: `${SAMPLE_PREFIX}site-cloudflare`,
        title: 'Cloudflare 控制台',
        url: 'https://dash.cloudflare.com',
        category: '示例 · 运维',
        description: '示例条目：DNS 与边缘网络控制台',
        icon: 'Cloud',
        tags: ['示例'],
        pinned: false,
        visitCount: 0,
        createdAt: now
      }
    ],
    notes: [
      {
        id: `${SAMPLE_PREFIX}note-welcome`,
        title: '示例笔记：这个工作台怎么用',
        content: [
          '### 这是一条示例笔记',
          '',
          '它只用于演示，可以随时在首页点「移除示例数据」整批删除，不会影响你自己创建的内容。',
          '',
          '- 首页的「快速记录」会把内容先放进收件箱，不需要先选类型。',
          '- 收件箱里可以把一条记录转成笔记、收藏，或关联到项目。',
          '- 资料库把笔记、网页批注、手绘和远端文件放在同一个列表里。',
          '',
          '```bash',
          'npm run dev     # 本地开发',
          'npm run build   # 构建',
          '```'
        ].join('\n'),
        category: '示例',
        tags: ['示例', '入门'],
        pinned: false,
        updatedAt: now
      }
    ],
    reminders: [
      {
        id: `${SAMPLE_PREFIX}reminder-domain`,
        title: '示例提醒：域名续费',
        category: 'domain',
        targetDate: now + 20 * 24 * 60 * 60 * 1000,
        recurring: 'yearly',
        cost: '¥60 / 年',
        url: 'https://example.invalid/renew',
        notes: '示例条目，可直接删除。',
        completed: false,
        createdAt: now
      }
    ],
    servers: [
      {
        id: `${SAMPLE_PREFIX}server-demo`,
        name: '示例主机',
        publicIp: '203.0.113.10',
        env: 'dev',
        sshUser: 'root',
        sshPort: 22,
        status: 'unknown',
        notes: '示例条目：从未检测，因此不会显示为在线。',
        createdAt: now
      }
    ]
  };
}

/**
 * Merge the sample batch into a state, recording exactly which ids were added so
 * the batch can be removed later.
 */
export function applySampleData(state: HubState): HubState {
  const sample = createSampleData();
  const ids = [
    ...sample.sites.map((s) => s.id),
    ...sample.notes.map((n) => n.id),
    ...sample.reminders.map((r) => r.id),
    ...sample.servers.map((s) => s.id)
  ];
  const categories = new Set(state.categories || []);
  for (const site of sample.sites) categories.add(site.category);

  return {
    ...state,
    categories: Array.from(categories),
    sites: [...sample.sites, ...(state.sites || [])],
    notes: [...sample.notes, ...(state.notes || [])],
    reminders: [...sample.reminders, ...(state.reminders || [])],
    servers: [...sample.servers, ...(state.servers || [])],
    sampleBatch: [...(state.sampleBatch || []), ...ids]
  };
}

/**
 * Remove only the records this batch created. Anything the user made in the
 * meantime has a different id and is untouched.
 */
export function removeSampleData(state: HubState): { state: HubState; removed: number } {
  const ids = new Set(state.sampleBatch || []);
  if (ids.size === 0) return { state, removed: 0 };

  const before =
    (state.sites?.length || 0) +
    (state.notes?.length || 0) +
    (state.reminders?.length || 0) +
    (state.servers?.length || 0);

  const next: HubState = {
    ...state,
    sites: (state.sites || []).filter((s) => !ids.has(s.id)),
    notes: (state.notes || []).filter((n) => !ids.has(n.id)),
    reminders: (state.reminders || []).filter((r) => !ids.has(r.id)),
    servers: (state.servers || []).filter((s) => !ids.has(s.id)),
    sampleBatch: []
  };

  const after =
    (next.sites?.length || 0) +
    (next.notes?.length || 0) +
    (next.reminders?.length || 0) +
    (next.servers?.length || 0);

  return { state: next, removed: before - after };
}

/** True when sample records are still present. */
export function hasSampleData(state: HubState): boolean {
  return (state.sampleBatch?.length || 0) > 0;
}

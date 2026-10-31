/**
 * HubState shape and normalisation — the neutral half of `lib/storage`.
 * Split out for a build reason worth writing down: `lib/crypto` needs
 * `normalizeHubState` (a decrypted backup has to be coerced into a complete state before
 */
import { HubState, WucaiConfig, YoudaoConfig, GoTabPreferences } from '../types';
import { normalizeFeatures } from './features';
import { normalizeBackupPolicy } from './backupPolicy';
import { DEFAULT_HOME_BLOCKS, normalizeHomeBlocks } from '../domain/home';
import { CURRENT_GENERATION } from './schemaGeneration';

export const SCHEMA_VERSION = CURRENT_GENERATION;

export const INITIAL_STATE: HubState = {
  theme: 'dark',
  categories: ['全部', '常用工具', '技术开发', '运维部署', 'API与服务', '知识资讯'],
  // A new profile starts empty on purpose (P1-03): the previous build seeded six
  // example sites and a welcome note, so a first-time user's own library already
  // contained data they did not create. Examples are now created only from the
  // explicit 「体验示例」 action and can be removed as one batch
  // (see src/domain/sampleData.ts).
  sites: [],
  servers: [],
  secrets: [],
  domains: [],
  reminders: [],
  checkIns: [],
  notes: [],
  handwritings: [],
  obsidianConfig: {
    enabled: false,
    bucket: '',
    endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    region: 'oss-cn-hangzhou',
    accessKeyId: '',
    accessKeySecret: '',
    prefix: 'vault/'
  },
  obsidianNotes: [],
  wucaiConfig: {
    enabled: false,
    token: ''
  },
  wucaiHighlights: [],
  youdaoConfig: {
    enabled: false,
    token: '',
    cookie: ''
  },
  youdaoNotes: [],
  aiConfig: {
    provider: 'gemini',
    cloudAiEnabled: false,
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash'
  },
  cloudflareSync: {
    enabled: false,
    workerUrl: '',
    syncKey: '',
    autoSync: false
  },
  webdavConfig: {
    enabled: false,
    url: '',
    username: '',
    password: '',
    pathPrefix: 'selfhub_sync'
  },
  backupPolicy: {
    provider: 'auto',
    enabled: false,
    // New profiles also start on the legacy format: v3 needs a backup password
    // the user must establish first (§10.2 "升级新格式由用户明确启用").
    format: 'legacy'
  },
  homeBlocks: DEFAULT_HOME_BLOCKS.map((b) => ({ ...b })),
  connectionTests: {},
  purposes: {},
  sampleBatch: [],
  features: {
    inbox: true,
    projects: true,
    servers: true,
    secrets: true,
    notes: true,
    checkin: true,
    handwriting: true,
    wucai: true,
    youdao: true
  },
  inbox: [],
  projects: [],
  annotations: [],
  gotabPrefs: {
    searchEngine: 'google',
    wallpaperType: 'minimal',
    showQuickNotes: true,
    showProjects: true,
    dockLayout: 'comfortable'
  }
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mergeObject<T extends object>(defaults: T, value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
  return { ...defaults, ...(value as Partial<T>) };
}

/**
 * Keys `normalizeHubState` knows about. Anything else found at the root of a
 * stored payload is an unknown field and is preserved verbatim — the P2
 * migration requires that a round trip through P1 cannot delete data it does not
 * understand yet (old IndexedDB mirror keys, extension-imported collections,
 * hand-added fields).
 */
const KNOWN_ROOT_KEYS = new Set([
  'schemaVersion',
  'theme',
  'categories',
  'sites',
  'servers',
  'secrets',
  'domains',
  'checkIns',
  'reminders',
  'notes',
  'noteFolders',
  'handwritings',
  'inbox',
  'projects',
  'annotations',
  'obsidianNotes',
  'wucaiHighlights',
  'youdaoNotes',
  'obsidianConfig',
  'obsidianConnections',
  'wucaiConfig',
  'youdaoConfig',
  'aiConfig',
  'cloudflareSync',
  'webdavConfig',
  'backupPolicy',
  'homeBlocks',
  'newtabPreferences',
  'connectionTests',
  'purposes',
  'sampleBatch',
  'features',
  'gotabPrefs'
]);

/**
 * Keep only the parts of the new-tab preference object that can be handed back to the
 * extension. The layout is opaque here, but "opaque" must not mean "anything": a corrupted
 * or hand-edited backup could put a string where the dashboard engine expects an object,
 * and the engine would then render an empty dashboard on every new tab.
 */
function normalizeNewtabPreferences(value: unknown): HubState['newtabPreferences'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { layout?: unknown; pins?: unknown };
  const layout =
    raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)
      ? (raw.layout as Record<string, unknown>)
      : undefined;
  const pins = Array.isArray(raw.pins)
    ? raw.pins.filter((id: unknown): id is string => typeof id === 'string')
    : undefined;
  if (!layout && !pins) return undefined;
  return {
    ...(layout ? { layout } : {}),
    ...(pins ? { pins } : {})
  };
}

/**
 * Coerce arbitrary (possibly imported / legacy / hand-edited) data into a complete HubState.
 * Every consumer of a restored backup must go through this: importBackup() and
 * importEncryptedBackup() only validate a subset of the fields, so a backup missing
 * `checkIns`/`handwritings`/`obsidianConfig`/`categories` used to reach the views and
 * crash them (undefined.length) into a blank page.
 */
export function normalizeHubState(raw: unknown): HubState {
  const base: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  // Preserve fields this build does not model yet, so an unknown legacy
  // collection survives a load/save cycle instead of being silently dropped on
  // first persist.
  const unknownRoot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!KNOWN_ROOT_KEYS.has(key)) unknownRoot[key] = value;
  }

  const obsidianConfig = mergeObject(INITIAL_STATE.obsidianConfig, base.obsidianConfig);
  const webdavConfig = mergeObject(INITIAL_STATE.webdavConfig, base.webdavConfig);

  return {
    ...(unknownRoot as Partial<HubState>),
    schemaVersion: SCHEMA_VERSION,
    theme: base.theme === 'light' ? 'light' : 'dark',
    categories:
      Array.isArray(base.categories) && base.categories.length > 0
        ? base.categories.filter((c: unknown) => typeof c === 'string')
        : [...INITIAL_STATE.categories],
    sites: asArray(base.sites),
    servers: asArray(base.servers),
    secrets: asArray(base.secrets),
    domains: asArray(base.domains),
    checkIns: asArray(base.checkIns),
    reminders: asArray(base.reminders),
    notes: asArray(base.notes),
    noteFolders: asArray(base.noteFolders),
    handwritings: asArray(base.handwritings),
    inbox: asArray(base.inbox),
    projects: asArray(base.projects),
    annotations: asArray(base.annotations),
    obsidianNotes: asArray(base.obsidianNotes),
    obsidianConnections: asArray(base.obsidianConnections).length ? asArray(base.obsidianConnections) : undefined,
    wucaiHighlights: asArray(base.wucaiHighlights),
    youdaoNotes: asArray(base.youdaoNotes),
    obsidianConfig,
    wucaiConfig: mergeObject(INITIAL_STATE.wucaiConfig as WucaiConfig, base.wucaiConfig),
    youdaoConfig: mergeObject(INITIAL_STATE.youdaoConfig as YoudaoConfig, base.youdaoConfig),
    aiConfig: mergeObject(INITIAL_STATE.aiConfig, base.aiConfig),
    cloudflareSync: mergeObject(INITIAL_STATE.cloudflareSync, base.cloudflareSync),
    webdavConfig,
    // P1-09: the destination choice and the task switch are data, not something
    // re-derived from field presence at every call site.
    backupPolicy: normalizeBackupPolicy(base.backupPolicy, obsidianConfig, webdavConfig),
    homeBlocks: normalizeHomeBlocks(base.homeBlocks),
    // The new tab owns the shape of this object; the workbench only has to guarantee
    // that a round trip through load/save does not drop it. A backup that was taken
    // before this field existed simply has none, and a restore then leaves the
    // device's current layout alone.
    newtabPreferences: normalizeNewtabPreferences(base.newtabPreferences),
    connectionTests:
      base.connectionTests && typeof base.connectionTests === 'object' && !Array.isArray(base.connectionTests)
        ? (base.connectionTests as HubState['connectionTests'])
        : {},
    purposes:
      base.purposes && typeof base.purposes === 'object' && !Array.isArray(base.purposes)
        ? (base.purposes as Record<string, boolean>)
        : {},
    sampleBatch: Array.isArray(base.sampleBatch) ? base.sampleBatch.filter((id: unknown) => typeof id === 'string') : [],
    features: normalizeFeatures(base.features),
    gotabPrefs: mergeObject(INITIAL_STATE.gotabPrefs as GoTabPreferences, base.gotabPrefs)
  };
}

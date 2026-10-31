import type { CheckInTask } from '../types';

/**
 * Supported check-in sites (7.1).
 * These are the sites the common签到脚本 collections cover. The rule the user asked for is the
 * important part: **a supported site that the user has not configured is not shown in the task
 * · list**. This catalogue only offers them as one-click templates; the list stays "what you set
 */

export interface SupportedCheckInSite {
  id: string;
  name: string;
  url: string;
  /** Which project/collection this template came from, for honesty about its origin. */
  source: string;
  note: string;
}

export const SUPPORTED_CHECKIN_SITES: SupportedCheckInSite[] = [
  { id: 'aliyundrive', name: '阿里云盘', url: 'https://www.aliyundrive.com/signin', source: 'daily-checkin', note: '网页签到，需要手动点击' },
  { id: 'bilibili', name: '哔哩哔哩', url: 'https://www.bilibili.com/account/coin', source: 'daily-checkin', note: '投币页，仅打开' },
  { id: 'v2ex', name: 'V2EX', url: 'https://www.v2ex.com/mission/daily', source: 'daily-checkin', note: '每日任务，仅打开' },
  { id: 'smzdm', name: '什么值得买', url: 'https://www.smzdm.com/', source: 'daily-checkin', note: '签到入口在页面内' },
  { id: 'netease-music', name: '网易云音乐', url: 'https://music.163.com/', source: 'daily-checkin', note: '网页签到需登录' },
  { id: 'juejin', name: '掘金', url: 'https://juejin.cn/', source: 'daily-checkin', note: '签到入口在首页' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/', source: 'daily-checkin', note: '本身没有签到，用作每日访问记录' },
  { id: 'baidutieba', name: '百度贴吧', url: 'https://tieba.baidu.com/', source: 'daily-checkin', note: '需要登录后手动签到' }
];

/** A template the user has not configured yet (matched by URL). */
export function unconfiguredSites(tasks: CheckInTask[]): SupportedCheckInSite[] {
  const configured = new Set(tasks.map((task) => (task.url || '').replace(/\/+$/, '').toLowerCase()));
  return SUPPORTED_CHECKIN_SITES.filter((site) => !configured.has(site.url.replace(/\/+$/, '').toLowerCase()));
}

/** Build a manual (open-the-page) task from a template. Never claims an HTTP check-in. */
export function taskFromTemplate(site: SupportedCheckInSite, now = Date.now()): CheckInTask {
  return {
    id: `chk-${now}`,
    name: site.name,
    url: site.url,
    method: 'GET',
    type: 'redirect',
    enabled: false,
    createdAt: now
  };
}

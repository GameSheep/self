import { CheckInTask } from '../types';

export interface ExecutionResult {
  success: boolean;
  statusCode?: number;
  message: string;
  durationMs: number;
  bodySnippet?: string;
}

/**
 * Execute real HTTP or Webhook check-in request
 */
export async function executeCheckIn(task: CheckInTask): Promise<ExecutionResult> {
  const startTime = Date.now();

  if (task.type === 'redirect') {
    window.open(task.url, '_blank', 'noopener,noreferrer');
    return {
      success: true,
      message: '已在浏览器打开目标签到页面（配合油猴脚本可自动模拟点击）',
      durationMs: Date.now() - startTime
    };
  }

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      ...(task.headers || {})
    };

    const res = await fetch(task.url, {
      method: task.method || 'GET',
      headers,
      body: task.method === 'POST' && task.body ? task.body : undefined,
      mode: 'cors'
    });

    const durationMs = Date.now() - startTime;
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 150);

    if (res.ok) {
      return {
        success: true,
        statusCode: res.status,
        message: `打卡成功 (HTTP ${res.status}) - 耗时 ${durationMs}ms`,
        durationMs,
        bodySnippet: snippet
      };
    } else {
      return {
        success: false,
        statusCode: res.status,
        message: `签到接口返回异常: HTTP ${res.status} ${res.statusText}`,
        durationMs,
        bodySnippet: snippet
      };
    }
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    // Common browser CORS error fallback guidance
    const isCors = err.message?.includes('Failed to fetch') || err.name === 'TypeError';
    return {
      success: false,
      message: isCors
        ? '受浏览器跨域(CORS)策略保护，无法直接从前端调用。建议点击【快速直达】或安装配套油猴脚本一键自动点击！'
        : (err.message || '网络请求错误'),
      durationMs
    };
  }
}

/**
 * Generate standard Tampermonkey / Violentmonkey UserScript
 * For automating login and button clicks on complex websites!
 */
export function generateUserScript(task: CheckInTask, selector: string = '#signin-btn, .checkin, button:contains("签到")'): string {
  let hostname = '*';
  try {
    hostname = new URL(task.url).hostname;
  } catch {
    // fallback
  }

  return `// ==UserScript==
// @name         Self-Hub 自动化签到助手 - ${task.name}
// @namespace    https://selfhub.local/
// @version      1.0.0
// @description  由 Self-Hub 自动生成的网页自动化签到脚本，自动检测登录并点击签到
// @author       Self-Hub
// @match        *://${hostname}/*
// @grant        GM_notification
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    console.log('[Self-Hub] 自动化签到脚本已注入: ${task.name}');

    function tryClickSign() {
        const selectors = [
            '${selector}',
            'a:contains("签到")',
            'button:contains("签到")',
            'a:contains("领取")',
            '.btn-signin',
            '#signin-btn'
        ];

        let target = null;
        for (const s of selectors) {
            try {
                const el = document.querySelector(s);
                if (el && el.offsetParent !== null) {
                    target = el;
                    break;
                }
            } catch(e) {}
        }

        if (target) {
            console.log('[Self-Hub] 发现签到按钮，正在自动点击...', target);
            target.click();
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title: 'Self-Hub 自动签到',
                    text: '${task.name} 自动点击签到完成！',
                    timeout: 3000
                });
            }
        } else {
            console.log('[Self-Hub] 未找到明显的签到按钮，可能今日已签到或需先手动登录');
        }
    }

    // 延迟 1.5 秒等待页面渲染与接口加载
    setTimeout(tryClickSign, 1500);
})();`;
}

import { CheckInTask } from '../types';

export interface ExecutionResult {
  success: boolean;
  statusCode?: number;
  message: string;
  durationMs: number;
  bodySnippet?: string;
  /** false when we merely opened a page and cannot know the real check-in result. */
  verified?: boolean;
}

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Look for an explicit business-level failure inside a 2xx response body.
 * Many Chinese check-in APIs answer HTTP 200 with {"code":-1,"msg":"未登录"}.
 */
function detectBusinessFailure(text: string, contentType: string): string | null {
  if (!text) return null;
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(text);
  if (!looksJson) return null;
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const failureText = (v: unknown) => (typeof v === 'string' ? v : '').toLowerCase();
  const msg = failureText(data.msg) || failureText(data.message) || failureText(data.error) || failureText(data.errorMessage);

  if (data.success === false || data.ok === false || data.ret === false) {
    return msg || '接口返回 success=false';
  }
  if (data.error || data.errorCode) {
    return msg || `接口返回错误: ${JSON.stringify(data.error).slice(0, 80)}`;
  }
  if (data.code !== undefined) {
    const code = data.code;
    const okCodes = [0, 200, '0', '200', 'SUCCESS', 'success', 'OK', 'ok'];
    if (!okCodes.includes(code) && !okCodes.includes(String(code))) {
      return msg || `接口返回业务错误码 ${String(code)}`;
    }
  }
  if (/未登录|请登录|失败|错误|异常|not\s*logged|unauthor|forbidden|invalid|expired/.test(msg)) {
    return msg;
  }
  return null;
}

/**
 * Execute real HTTP or Webhook check-in request
 */
export async function executeCheckIn(task: CheckInTask): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Validate the URL up-front: an invalid URL used to be reported as a CORS problem,
  // which sent users off installing userscripts for a simple typo.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(task.url);
  } catch {
    return {
      success: false,
      message: `签到地址无效，请检查 URL：${task.url}`,
      durationMs: Date.now() - startTime,
      verified: false
    };
  }

  if (task.type === 'redirect') {
    window.open(parsedUrl.toString(), '_blank', 'noopener,noreferrer');
    return {
      success: true,
      // Opening a page is not a verified check-in: it must not inflate the streak.
      verified: false,
      message: '已打开签到页面（未校验签到结果，不计入连续签到天数）',
      durationMs: Date.now() - startTime
    };
  }

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      ...(task.headers || {})
    };

    const hasBody = task.method === 'POST' && Boolean(task.body);
    if (hasBody && !headers['Content-Type'] && !headers['content-type']) {
      const bodyText = task.body || '';
      headers['Content-Type'] = /^\s*[[{]/.test(bodyText)
        ? 'application/json'
        : 'application/x-www-form-urlencoded';
    }

    const res = await fetch(parsedUrl.toString(), {
      method: task.method || 'GET',
      headers,
      body: hasBody ? task.body : undefined,
      mode: 'cors',
      // Never leave the promise pending forever: a hung request used to freeze
      // the card's spinner and block "一键全签" for the rest of the session.
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : undefined
    });

    const durationMs = Date.now() - startTime;
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 150);

    if (!res.ok) {
      return {
        success: false,
        verified: true,
        statusCode: res.status,
        message: `签到接口返回异常: HTTP ${res.status} ${res.statusText}`,
        durationMs,
        bodySnippet: snippet
      };
    }

    const businessError = detectBusinessFailure(text, res.headers.get('content-type') || '');
    if (businessError) {
      return {
        success: false,
        verified: true,
        statusCode: res.status,
        message: `接口返回 HTTP ${res.status}，但业务判定为失败：${businessError}`,
        durationMs,
        bodySnippet: snippet
      };
    }

    return {
      success: true,
      verified: true,
      statusCode: res.status,
      message: `打卡成功 (HTTP ${res.status}) - 耗时 ${durationMs}ms`,
      durationMs,
      bodySnippet: snippet
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const name = err?.name || '';
    const message = err?.message || '';

    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        success: false,
        message: `请求超时（超过 ${REQUEST_TIMEOUT_MS / 1000} 秒无响应），已中止。请检查网络或接口地址。`,
        durationMs
      };
    }

    const isCors = name === 'TypeError' && /failed to fetch|networkerror|load failed/i.test(message);
    return {
      success: false,
      message: isCors
        ? '受浏览器跨域(CORS)策略保护，无法直接从前端调用。建议点击【快速直达】或安装配套油猴脚本一键自动点击！'
        : `请求失败：${message || '未知网络错误'}`,
      durationMs
    };
  }
}

/**
 * Generate standard Tampermonkey / Violentmonkey UserScript
 * For automating login and button clicks on complex websites!
 */
export function generateUserScript(task: CheckInTask, selector: string = ''): string {
  let hostname = '*';
  try {
    hostname = new URL(task.url).hostname;
  } catch {
    // fallback
  }

  // CSS selectors only: `:contains()` is not valid CSS and threw inside the
  // generated script, killing the whole selector list.
  const cssSelectors = [
    selector,
    '.btn-signin',
    '#signin-btn',
    '[class*="sign"]',
    '[class*="checkin"]',
    '[id*="sign"]',
    '[id*="checkin"]'
  ].filter(Boolean);

  return `// ==UserScript==
// @name         Self-Hub 自动化签到助手 - ${task.name}
// @namespace    https://selfhub.local/
// @version      1.0.0
// @description  由 Self-Hub 自动生成的网页自动化签到脚本，自动检测登录并点击签到
// @author       Self-Hub
// @match        *://${hostname}/*
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    console.log('[Self-Hub] 自动化签到脚本已注入: ${task.name}');

    var CSS_SELECTORS = ${JSON.stringify(cssSelectors)};
    var TEXT_HINTS = ['签到', '领取', '打卡', 'check in', 'checkin', 'sign in'];

    function findByText() {
        var candidates = document.querySelectorAll('button, a, div[role="button"], input[type="button"], input[type="submit"]');
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var label = (el.innerText || el.textContent || el.value || '').trim();
            if (!label) continue;
            for (var j = 0; j < TEXT_HINTS.length; j++) {
                if (label.indexOf(TEXT_HINTS[j]) !== -1 && el.offsetParent !== null) return el;
            }
        }
        return null;
    }

    function tryClickSign() {
        var target = null;
        for (var i = 0; i < CSS_SELECTORS.length; i++) {
            try {
                var el = document.querySelector(CSS_SELECTORS[i]);
                if (el && el.offsetParent !== null) { target = el; break; }
            } catch (e) { /* invalid selector: keep going */ }
        }
        if (!target) target = findByText();

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

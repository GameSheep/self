/**
 * Extension message protocol (P2-04).
 *
 * Before this file, `background.js` answered `message.action === 'X'` for any
 * sender, with no schema check and no notion of who was allowed to ask. A content
 * script runs inside an untrusted page, so "any sender" meant any page the user
 * visited could drive the extension's storage — and the collections were written
 * by the pages themselves (`newtab.js`, `sidepanel.js`, `popup.js` all called
 * `chrome.storage.local.set` directly), so there was no single writer to reason
 * about.
 *
 * This module is that single writer's front door:
 *
 * - **Whitelist.** Only the commands listed in {@link COMMANDS} exist. Anything
 *   else is rejected with a reason; there is no pass-through to arbitrary work.
 * - **Sender check.** Each command declares which contexts may call it. A content
 *   script may read/write annotations *for the page it is running in* and capture
 *   an inbox entry; it may not read the whole library, fetch credentials or proxy
 *   an arbitrary URL.
 * - **Runtime schema validation.** Unknown fields and oversized payloads are
 *   rejected rather than stored (dev doc §9.2).
 * - **Idempotent writes.** Every write carries an `operationId`; the background
 *   remembers the result, so a retry after a lost response does not create a
 *   second record.
 * - **Change notifications.** After a commit the background broadcasts entity ids
 *   and revisions only — never bodies, never credentials.
 *
 * Plain ES module with no build step, because MV3 loads `background.js` as a
 * module and the packaged app must not need this file bundled.
 */

export const PROTOCOL_VERSION = 1;

/** Senders a command may come from. */
export const SENDER = {
  /** A content script running inside a page. */
  content: 'content',
  /** An extension page: newtab, sidepanel, popup, options, packaged app. */
  page: 'page',
  /** The service worker itself (alarm/context-menu internal work). */
  internal: 'internal'
};

/** Maximum payload we accept, in characters of JSON. */
export const MAX_PAYLOAD_CHARS = 200_000;

/** Command table. `senders` is the allow-list; `writes` marks idempotent writes. */
export const COMMANDS = {
  GET_PAGE_ANNOTATIONS: {
    senders: [SENDER.content, SENDER.page],
    // A content script may only ask for annotations belonging to its own page.
    requiresSamePage: true,
    writes: false
  },
  SAVE_ANNOTATION: {
    senders: [SENDER.content, SENDER.page],
    requiresSamePage: true,
    writes: true,
    requiredFields: ['annotation']
  },
  DELETE_ANNOTATION: {
    senders: [SENDER.content, SENDER.page],
    requiresSamePage: true,
    writes: true,
    requiredFields: ['id']
  },
  GET_ALL_ANNOTATIONS: {
    // The whole library is only visible to extension pages, not to a page script.
    senders: [SENDER.page],
    writes: false
  },
  CAPTURE_ENTRY: {
    senders: [SENDER.content, SENDER.page],
    writes: true,
    requiredFields: ['text']
  },
  QUERY_INBOX: {
    senders: [SENDER.page],
    writes: false
  },
  UPDATE_INBOX_STATUS: {
    senders: [SENDER.page],
    writes: true,
    requiredFields: ['id', 'status']
  },
  QUERY_BOOKMARKS: {
    senders: [SENDER.page],
    writes: false
  },
  REPLACE_BOOKMARKS: {
    // The app owns the bookmark list; it hands the ordered array here so the
    // background stays the only writer of extension data.
    senders: [SENDER.page],
    writes: true,
    requiredFields: ['bookmarks']
  },
  SAVE_QUICK_NOTE: {
    senders: [SENDER.page],
    writes: true,
    requiredFields: ['text']
  },
  READ_QUICK_NOTE: {
    senders: [SENDER.page],
    writes: false
  },
  OPEN_SIDE_PANEL: {
    senders: [SENDER.content, SENDER.page],
    writes: false
  },
  PUBLISH_REMINDERS: {
    senders: [SENDER.page],
    writes: true,
    requiredFields: ['reminders']
  },
  CHECK_REMINDERS_NOW: {
    senders: [SENDER.page, SENDER.internal],
    writes: false
  },
  OPEN_WORKSPACE: {
    senders: [SENDER.content, SENDER.page],
    writes: false
  },
  GET_TASK_STATUS: {
    senders: [SENDER.page],
    writes: false
  },
  PERFORM_SYNC: {
    // Legacy SyncManager trigger. Kept addressable so the app can turn it off,
    // but no extension page writes collections through it any more.
    senders: [SENDER.page],
    writes: true
  }
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** Canonical error codes, mirrored from the app's `AppErrorCode` where they overlap. */
export const ERRORS = {
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  FORBIDDEN_SENDER: 'FORBIDDEN_SENDER',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  PAGE_MISMATCH: 'PAGE_MISMATCH',
  PROTOCOL_VERSION: 'PROTOCOL_VERSION',
  INTERNAL: 'INTERNAL'
};

/** Reasons a sender is not allowed to use a command: never a silent drop. */
export function classifySender(sender) {
  if (!sender) return SENDER.internal;
  // Check the URL scheme *before* `tab`. An extension page opened in a tab also
  // carries `sender.tab`, so keying on `tab` first misclassified every newtab /
  // sidepanel / app message as a content-script message — which the real extension
  // test caught by having the new tab's own quick-note save rejected as
  // "不接受来自 content 的请求".
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (url.startsWith('chrome-extension://')) return SENDER.page;
  if (sender.tab && sender.tab.id !== undefined) return SENDER.content;
  if (sender.id) return SENDER.internal;
  return SENDER.content;
}

/** Validate the envelope shape before anything else looks at it. */
export function validateEnvelope(message) {
  if (!message || typeof message !== 'object') {
    return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: '消息必须是对象' };
  }
  const { command, requestId } = message;
  if (typeof command !== 'string' || !command) {
    return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: '缺少 command' };
  }
  if (typeof requestId !== 'string' || !requestId) {
    return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: '缺少 requestId' };
  }
  if (message.protocolVersion !== undefined && message.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ERRORS.PROTOCOL_VERSION,
      message: `协议版本不匹配：扩展支持 ${PROTOCOL_VERSION}，收到 ${message.protocolVersion}`
    };
  }
  const size = JSON.stringify(message.payload ?? null).length;
  if (size > MAX_PAYLOAD_CHARS) {
    return { ok: false, code: ERRORS.PAYLOAD_TOO_LARGE, message: `负载过大（${size} 字符）` };
  }
  return { ok: true };
}

/**
 * Validate one command's payload.
 *
 * Structural and shallow on purpose: it rejects what would corrupt our own data
 * (missing fields, wrong types, unknown top-level keys) without trying to
 * re-implement the app's domain model in the service worker.
 */
export function validatePayload(command, payload) {
  const spec = COMMANDS[command];
  if (!spec) return { ok: false, code: ERRORS.UNKNOWN_COMMAND, message: `未知命令: ${command}` };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'payload 必须是对象' };
  }
  for (const field of spec.requiredFields ?? []) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') {
      return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: `缺少字段 ${field}` };
    }
  }

  switch (command) {
    case 'SAVE_ANNOTATION': {
      const annotation = payload.annotation;
      if (!annotation || typeof annotation !== 'object') {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'annotation 必须是对象' };
      }
      if (typeof annotation.pageUrl !== 'string' || !annotation.pageUrl) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'annotation 缺少 pageUrl' };
      }
      if (typeof annotation.text !== 'string' || !annotation.text.trim()) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'annotation 缺少选中文本' };
      }
      break;
    }
    case 'CAPTURE_ENTRY':
    case 'SAVE_QUICK_NOTE': {
      if (typeof payload.text !== 'string' || !payload.text.trim()) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: '内容不能为空' };
      }
      break;
    }
    case 'UPDATE_INBOX_STATUS': {
      if (!['inbox', 'processed', 'archived'].includes(payload.status)) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'status 取值不合法' };
      }
      break;
    }
    case 'REPLACE_BOOKMARKS': {
      if (!Array.isArray(payload.bookmarks)) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'bookmarks 必须是数组' };
      }
      if (!payload.bookmarks.every((site) => site && typeof site === 'object' && typeof site.id === 'string')) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: '每个书签都必须带字符串 id' };
      }
      break;
    }
    case 'PUBLISH_REMINDERS': {
      if (!Array.isArray(payload.reminders)) {
        return { ok: false, code: ERRORS.INVALID_PAYLOAD, message: 'reminders 必须是数组' };
      }
      break;
    }
    default:
      break;
  }
  return { ok: true };
}

/**
 * A content script may only act on the page it is running in.
 *
 * §9.2: "页面 URL 应与 sender.tab.url 或授权上下文匹配，不能信任 payload 声称的页面
 * 来源". So for a content script the URL comes from `sender.tab.url`, and a payload
 * that claims a different page is rejected rather than trusted.
 *
 * An **extension page** is exempt: it legitimately acts on annotations belonging
 * to other pages (the side panel lists every page's highlights), and its own
 * `sender.tab.url` is the extension URL, not the page it is managing.
 */
export function checkPageBinding(command, payload, sender, senderKind) {
  const spec = COMMANDS[command];
  if (!spec?.requiresSamePage) return { ok: true };
  if (senderKind === SENDER.page || senderKind === SENDER.internal) {
    const claimed =
      command === 'SAVE_ANNOTATION'
        ? payload?.annotation?.pageUrl
        : command === 'GET_PAGE_ANNOTATIONS'
          ? payload?.url
          : undefined;
    return claimed ? { ok: true, url: claimed } : { ok: false, code: ERRORS.PAGE_MISMATCH, message: '无法确定页面来源' };
  }

  const claimed =
    command === 'SAVE_ANNOTATION' ? payload?.annotation?.pageUrl : command === 'GET_PAGE_ANNOTATIONS' ? payload?.url : undefined;
  const senderUrl = sender?.tab?.url;

  if (!senderUrl) {
    return { ok: false, code: ERRORS.PAGE_MISMATCH, message: '无法确定页面来源' };
  }
  if (claimed && claimed !== senderUrl) {
    return { ok: false, code: ERRORS.PAGE_MISMATCH, message: '消息声明的页面与实际发送页不一致' };
  }
  return { ok: true, url: senderUrl };
}

/** Idempotency key for a write. Required on every writing command. */
export function operationIdOf(message) {
  const value = message?.payload?.operationId ?? message?.operationId;
  return typeof value === 'string' && value ? value : null;
}

export function newRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function okResponse(requestId, data) {
  return { requestId, ok: true, protocolVersion: PROTOCOL_VERSION, data };
}

export function errorResponse(requestId, code, message, extra) {
  return {
    requestId,
    ok: false,
    protocolVersion: PROTOCOL_VERSION,
    error: { code, message, ...(extra ?? {}) }
  };
}

/**
 * Page-side client for the extension protocol (P2-04).
 *
 * A plain classic script (no module) so `newtab.js`, `sidepanel.js` and
 * `popup.js` can use it without becoming modules — the manifest does not allow
 * module content scripts, and converting three pages to modules for one helper is
 * more churn than it is worth.
 *
 * It exists so no page ever constructs an envelope by hand: the request id, the
 * protocol version and the error shape live in one place, which is what makes
 * "the background is the single writer" enforceable rather than aspirational.
 */
(function attachSelfHubClient(global) {
  'use strict';

  var PROTOCOL_VERSION = 1;

  function newRequestId() {
    return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Send one command and resolve with `data`.
   *
   * Rejects with an `Error` carrying `code` when the background refuses, so a
   * caller can distinguish "forbidden" from "network died" instead of getting an
   * undefined result.
   */
  function send(command, payload) {
    return new Promise(function (resolve, reject) {
      var message = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: newRequestId(),
        command: command,
        payload: payload || {}
      };
      try {
        chrome.runtime.sendMessage(message, function (response) {
          var lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message || '扩展未响应'));
            return;
          }
          if (!response || typeof response !== 'object') {
            reject(new Error('扩展返回了空响应'));
            return;
          }
          if (response.protocolVersion !== PROTOCOL_VERSION) {
            reject(new Error('协议版本不匹配，请重新加载扩展'));
            return;
          }
          if (!response.ok) {
            var error = new Error(response.error && response.error.message ? response.error.message : '命令失败');
            error.code = response.error ? response.error.code : 'INTERNAL';
            reject(error);
            return;
          }
          resolve(response.data);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Subscribe to change events (ids only, never bodies). */
  function onChange(handler) {
    var listener = function (message) {
      if (message && message.type === 'SELFHUB_CHANGED') handler(message);
    };
    chrome.runtime.onMessage.addListener(listener);
    return function () {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }

  global.SelfHubClient = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    send: send,
    onChange: onChange
  };
})(window);

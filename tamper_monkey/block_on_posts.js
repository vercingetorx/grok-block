// ==UserScript==
// @name         Grok: block input_scroll only on post pages
// @match        https://grok.com/imagine*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.log('[TM] WS blocker script starting');

  const originalSend = WebSocket.prototype.send;

  function onPostPage() {
    // Adjust if their routing changes, but this matches:
    // https://grok.com/imagine/post/<uuid>
    return window.location.pathname.startsWith('/imagine/post/');
  }

  WebSocket.prototype.send = function (data) {
    let text = '';

    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      try {
        text = new TextDecoder().decode(data);
      } catch (_) {}
    } else if (data && data.buffer instanceof ArrayBuffer) {
      try {
        text = new TextDecoder().decode(data.buffer);
      } catch (_) {}
    } else {
      try {
        text = String(data);
      } catch (_) {}
    }

    if (text) {
      // Optional debug
      // console.log('[TM] WS SEND seen:', window.location.pathname, text.slice(0, 200));

      if (onPostPage()) {
        try {
          const obj = JSON.parse(text);

          if (
            obj &&
            obj.type === 'conversation.item.create' &&
            obj.item &&
            Array.isArray(obj.item.content) &&
            obj.item.content[0] &&
            obj.item.content[0].type === 'input_scroll'
          ) {
            console.log('[TM] BLOCK input_scroll on post page', obj);
            return; // block only on /imagine/post/...
          }
        } catch (_) {
          // non-JSON, ignore
        }
      }
    }

    return originalSend.call(this, data);
  };

  console.log('[TM] WS hook installed');
})();

// ==UserScript==
// @name         Grok: block input_scroll generations
// @match        https://grok.com/imagine/post/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.log('[TM] WS blocker script starting');

  const originalSend = WebSocket.prototype.send;

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
      console.log('[TM] WS SEND seen:', text.slice(0, 200));

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
          console.log('[TM] BLOCK input_scroll', obj);
          return; // do NOT send this scroll-triggered generation
        }
      } catch (_) {
        // non-JSON, ignore
      }
    }

    return originalSend.call(this, data);
  };

  console.log('[TM] WS hook installed');
})();

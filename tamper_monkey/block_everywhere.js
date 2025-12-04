// ==UserScript==
// @name         Grok: manual scroll generation (styled button)
// @match        https://grok.com/imagine*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  console.log('[TM] manual scroll script starting');

  const originalSend = WebSocket.prototype.send;

  // Store the last scroll-generated request from the current imagine page
  let lastScrollRequest = null;

  function onPostPage() {
    // /imagine/post/<uuid>
    return window.location.pathname.startsWith('/imagine/post/');
  }

  function onMainPage() {
    // main grid page is exactly /imagine (adjust if needed)
    return window.location.pathname === '/imagine';
  }

  // Patch WebSocket.prototype.send
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
      try {
        const obj = JSON.parse(text);

        const isInputScroll =
          obj &&
          obj.type === 'conversation.item.create' &&
          obj.item &&
          Array.isArray(obj.item.content) &&
          obj.item.content[0] &&
          obj.item.content[0].type === 'input_scroll';

        if (isInputScroll) {
          if (onPostPage() || onMainPage()) {
            // On main or post pages, capture instead of sending automatically.
            // The manual button will send this scroll in the current context.
            lastScrollRequest = { ws: this, data };
            console.log('[TM] CAPTURE input_scroll on imagine page', obj);
            return;
          }

          // Else: other routes, let it through
        }
      } catch (_) {
        // non-JSON payload, ignore
      }
    }

    return originalSend.call(this, data);
  };

  console.log('[TM] WS hook installed]');

  function injectStyles() {
    if (document.getElementById('grok-manual-generate-style')) return;
    const style = document.createElement('style');
    style.id = 'grok-manual-generate-style';
    style.textContent = `
      #grok-manual-generate-btn {
        position: fixed;
        bottom: 80px;
        right: 24px;
        padding: 12px 10px;
        font-size: 14px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #ffffff;
        background: #1e88e5;
        border: none;
        border-radius: 10px;
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25);
        cursor: pointer;
        z-index: 99999;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      #grok-manual-generate-btn:hover {
        background: #1565c0;
      }
      #grok-manual-generate-btn:active {
        transform: translateY(1px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      }
      #grok-manual-generate-btn-icon {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid #ffffff;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  }

  // Add a manual "Generate more" button on the main page
  function addButton() {
    if (!onMainPage() && !onPostPage()) return;

    injectStyles();

    let btn = document.getElementById('grok-manual-generate-btn');
    if (btn) return;

    btn = document.createElement('button');
    btn.id = 'grok-manual-generate-btn';
    btn.type = 'button';

    const icon = document.createElement('span');
    icon.id = 'grok-manual-generate-btn-icon';

    const label = document.createElement('span');
    label.textContent = 'Generate more images';

    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      if (!lastScrollRequest) {
        console.log('[TM] No captured input_scroll to send yet');
        return;
      }
      console.log('[TM] SENDING captured input_scroll', lastScrollRequest);
      originalSend.call(lastScrollRequest.ws, lastScrollRequest.data);
      // Optional: clear after send so one click = one batch
      lastScrollRequest = null;
    });

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }
})();

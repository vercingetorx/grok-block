// Injected into the page context by content.js
(() => {
  'use strict';

  console.log('[GrokHelperPage] injected');

  const defaults = {
    scrollMode: 'off', // 'off' | 'block-posts' | 'manual-main'
    downloaderEnabled: true,
    autoDownload: false
  };

  let settings = { ...defaults };

  // WebSocket + manual scroll state
  let wsPatched = false;
  let nativeSend = null;
  let lastScrollWs = null;
  let lastScrollData = null;

  // Manual "Generate more" button
  let manualBtn = null;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'GrokHelperExt') return;
    if (data.type === 'settings' && data.payload) {
      settings = { ...settings, ...data.payload };
      // Update manual button whenever scroll mode changes
      updateManualButton();
    }
  });

  function isPostPage() {
    return window.location.pathname.startsWith('/imagine/post/');
  }
  function isMainPage() {
    return window.location.pathname === '/imagine';
  }

  // ----------------------------
  // WebSocket hook
  // ----------------------------

  const discoveredImages = [];
  const recordsByHash = new Map();
  const recordsByKey = new Map();

  function patchWebSocket() {
    if (wsPatched) return;
    if (!window.WebSocket || !window.WebSocket.prototype.send) return;

    nativeSend = window.WebSocket.prototype.send;

    window.WebSocket.prototype.send = function patchedSend(data) {
      // Scroll control
      if (handleOutgoing(data, this)) {
        return;
      }

      // Image listener
      if (!this.__grokHelperPageHooked) {
        this.__grokHelperPageHooked = true;
        try {
          this.addEventListener('message', (evt) => {
            decodeData(evt.data, handleImageMessage);
          });
        } catch (_) {}
      }

      return nativeSend.call(this, data);
    };

    wsPatched = true;
    // console.log('[GrokHelperPage] WebSocket patched');
  }

  function handleOutgoing(data, ws) {
    if (!settings.scrollMode || settings.scrollMode === 'off') return false;

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
    }
    if (!text) return false;

    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return false;
    }

    const isInputScroll =
      obj &&
      obj.type === 'conversation.item.create' &&
      obj.item &&
      Array.isArray(obj.item.content) &&
      obj.item.content[0] &&
      obj.item.content[0].type === 'input_scroll';
    if (!isInputScroll) return false;

    if (settings.scrollMode === 'block-posts') {
      if (isPostPage()) {
        // console.log('[GrokHelperPage] Block input_scroll on post page', obj);
        return true;
      }
      return false;
    }

    if (settings.scrollMode === 'manual-main') {
      if (isPostPage() || isMainPage()) {
        // Capture but do not send; manual button can send later
        lastScrollWs = ws;
        lastScrollData = data;
        // console.log('[GrokHelperPage] Capture input_scroll (manual mode)', obj);
        return true;
      }
    }

    return false;
  }

  // ----------------------------
  // Image handling
  // ----------------------------

  function decodeData(data, cb) {
    if (typeof data === 'string') {
      cb(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        cb(new TextDecoder().decode(data));
      } catch (_) {}
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => cb(String(reader.result || ''));
      reader.readAsText(data);
      return;
    }
    try {
      cb(String(data));
    } catch (_) {}
  }

  function computeDataHash(str) {
    if (!str) return null;
    const commaIdx = str.indexOf(',');
    const base = commaIdx >= 0 ? str.slice(commaIdx + 1) : str;
    if (!base.length) return null;
    let hash = 0;
    const step = Math.max(1, Math.floor(base.length / 128));
    for (let i = 0; i < base.length; i += step) {
      hash = (hash * 33 + base.charCodeAt(i)) | 0;
    }
    return 'h' + (hash >>> 0).toString(36);
  }

  function handleImageMessage(text) {
    if (!settings.downloaderEnabled) return;
    if (!text) return;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!obj || obj.type !== 'image' || !obj.url) return;

    let dataUrl = null;
    if (typeof obj.src === 'string' && obj.src.startsWith('data:')) {
      dataUrl = obj.src;
    } else if (typeof obj.blob === 'string' && obj.blob.length > 0) {
      dataUrl = obj.blob.startsWith('data:')
        ? obj.blob
        : 'data:image/jpeg;base64,' + obj.blob;
    }
    const dataHash = dataUrl ? computeDataHash(dataUrl) : null;

    const imageId =
      obj.id ||
      obj.image_id ||
      (obj.url
        ? (() => {
            try {
              const u = new URL(obj.url);
              const parts = u.pathname.split('/').filter(Boolean);
              const last = parts[parts.length - 1] || '';
              return last.split('.')[0] || null;
            } catch (_) {
              return null;
            }
          })()
        : null);

    const key = imageId || obj.job_id || obj.url || dataHash;

    const pct =
      typeof obj.percentage_complete === 'number' ? obj.percentage_complete : null;

    if (!dataHash || !key) return;

    let record = recordsByKey.get(key) || null;
    if (record) {
      // If hash changed, update the hash mapping
      if (record.dataHash && record.dataHash !== dataHash) {
        const existing = recordsByHash.get(record.dataHash);
        if (existing === record) {
          recordsByHash.delete(record.dataHash);
        }
      }
      record.url = obj.url || record.url;
      record.prompt = obj.prompt || obj.full_prompt || record.prompt;
      record.dataHash = dataHash;
      record.imageId = imageId || record.imageId;
      record.pct = pct;
      recordsByHash.set(dataHash, record);
    } else {
      record = {
        url: obj.url,
        prompt: obj.prompt || obj.full_prompt || '',
        dataHash,
        imageId,
        pct,
        autoDownloaded: false,
        autoDownloadScheduled: false
      };
      discoveredImages.push(record);
      recordsByKey.set(key, record);
      recordsByHash.set(dataHash, record);
    }

    maybeAutoDownload(record);
    scanForImageTiles();
  }

  function maybeAutoDownload(record) {
    if (!settings.downloaderEnabled || !settings.autoDownload) return;
    if (typeof record.pct === 'number' && record.pct < 100) return;
    if (record.autoDownloaded || record.autoDownloadScheduled) return;
    record.autoDownloadScheduled = true;

    const delayMs = 2000;
    setTimeout(() => {
      if (!settings.downloaderEnabled || !settings.autoDownload) return;
      try {
        requestDownload(record.url, buildFilename(record));
        record.autoDownloaded = true;
      } catch (e) {
        // console.warn('[GrokHelperPage] Auto-download failed', e);
      }
    }, delayMs);
  }

  function buildFilename(record) {
    if (record.url) {
      try {
        const u = new URL(record.url);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1];
        if (last) return last;
      } catch (_) {
        const noQuery = record.url.split('?')[0];
        const idx = noQuery.lastIndexOf('/');
        if (idx !== -1 && idx + 1 < noQuery.length) {
          return noQuery.slice(idx + 1);
        }
      }
    }
    const base = record.prompt || 'grok_image';
    const safeBase = base.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'grok_image';
    const extMatch = (record.url || '').split('?')[0].match(/\.(png|jpe?g|webp|gif|bmp)$/i);
    const ext = extMatch ? extMatch[0] : '.png';
    return safeBase + ext;
  }

  function requestDownload(url, filename) {
    if (!url) return;
    window.postMessage(
      {
        source: 'GrokHelperPage',
        type: 'download',
        payload: { url, filename }
      },
      '*'
    );
  }

  // ----------------------------
  // DOM overlay for per-tile download
  // ----------------------------

  let domObserverStarted = false;

  function startDomObserver() {
    if (domObserverStarted) return;
    domObserverStarted = true;
    const observer = new MutationObserver(() => {
      scanForImageTiles();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scanForImageTiles();
  }

  function scanForImageTiles() {
    if (!settings.downloaderEnabled) return;
    const images = document.querySelectorAll(
      'img[alt="Generated image"][src^="data:image"]'
    );
    images.forEach((img) => {
      const tile =
        img.closest('div[role="listitem"], .group\\/media-post-masonry-card') ||
        img.parentElement;
      if (!tile) return;
      if (tile.querySelector('.grok-image-download-overlay')) return;

      const src = img.getAttribute('src') || '';
      const srcHash = computeDataHash(src);
      if (!srcHash) return;

      const record = recordsByHash.get(srcHash) || null;
      if (!record || !record.url) return;

      const overlay = document.createElement('div');
      overlay.className = 'grok-image-download-overlay';
      Object.assign(overlay.style, {
        position: 'absolute',
        top: '6px',
        right: '6px',
        zIndex: '10',
        pointerEvents: 'none'
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Download';
      Object.assign(btn.style, {
        pointerEvents: 'auto',
        border: 'none',
        padding: '3px 6px',
        borderRadius: '999px',
        background: '#1e88e5',
        color: '#f9fafb',
        cursor: 'pointer',
        fontSize: '11px'
      });
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        requestDownload(record.url, buildFilename(record));
      });
      overlay.appendChild(btn);
      if (getComputedStyle(tile).position === 'static') {
        tile.style.position = 'relative';
      }
      tile.appendChild(overlay);
    });
  }

  // ----------------------------
  // Manual "Generate more" button
  // ----------------------------

  function injectManualStyles() {
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

  function ensureManualButton() {
    if (manualBtn && document.body.contains(manualBtn)) return;

    injectManualStyles();

    manualBtn = document.createElement('button');
    manualBtn.id = 'grok-manual-generate-btn';
    manualBtn.type = 'button';

    const icon = document.createElement('span');
    icon.id = 'grok-manual-generate-btn-icon';

    const label = document.createElement('span');
    label.textContent = 'Generate more images';

    manualBtn.appendChild(icon);
    manualBtn.appendChild(label);

    manualBtn.addEventListener('click', () => {
      if (!lastScrollWs || !lastScrollData) {
        // console.log('[GrokHelperPage] No captured input_scroll to send yet');
        return;
      }
      if (!nativeSend) {
        patchWebSocket();
      }
      try {
        nativeSend.call(lastScrollWs, lastScrollData);
      } catch (e) {
        // console.warn('[GrokHelperPage] Failed to send captured scroll', e);
      }
      lastScrollWs = null;
      lastScrollData = null;
    });

    if (document.body) {
      document.body.appendChild(manualBtn);
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          if (manualBtn && !document.body.contains(manualBtn)) {
            document.body.appendChild(manualBtn);
          }
        },
        { once: true }
      );
    }
  }

  function removeManualButton() {
    if (manualBtn && manualBtn.parentNode) {
      manualBtn.parentNode.removeChild(manualBtn);
    }
    manualBtn = null;
    lastScrollWs = null;
    lastScrollData = null;
  }

  function updateManualButton() {
    if (settings.scrollMode === 'manual-main') {
      ensureManualButton();
    } else {
      removeManualButton();
    }
  }

  // ----------------------------
  // Init
  // ----------------------------

  function init() {
    patchWebSocket();
    startDomObserver();
    // Tell the extension bridge we are ready to receive settings
    try {
      window.postMessage(
        {
          source: 'GrokHelperPage',
          type: 'ready'
        },
        '*'
      );
    } catch (_) {}
  }

  init();
})();

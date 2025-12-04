// ==UserScript==
// @name         Grok: image downloader helper
// @match        https://grok.com/imagine*
// @run-at       document-start
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  console.log('[TM] Grok image downloader script starting');

  // Track discovered images to avoid duplicates
  const discoveredImages = [];
  const seenImageKeys = new Set();

  function decodeData(data, cb) {
    if (typeof data === 'string') {
      cb(data);
      return;
    }

    if (data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder().decode(data);
        cb(text);
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

  function handleServerMessageText(text) {
    if (!text) return;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return;
    }

    // Example from burner.txt:
    // {"type":"image", "url":"https://imagine-public.x.ai/...", "prompt":"a church", ...}
    if (!obj || obj.type !== 'image' || !obj.url) return;

    // The server may send intermediate progress messages (e.g. 0%, 50%, 100%).
    // Keep only "final" images: percentage_complete == null or 100.
    const pct =
      typeof obj.percentage_complete === 'number' ? obj.percentage_complete : null;
    if (pct !== null && pct < 100) {
      return;
    }

    console.log(
      '[TM] Grok image message seen',
      obj.url,
      obj.prompt || obj.full_prompt || '',
      'pct=',
      pct
    );

    const record = {
      url: obj.url,
      prompt: obj.prompt || obj.full_prompt || '',
      id: obj.id || obj.job_id || '',
      ts: Date.now(),
      blob: obj.blob || null
    };

    const key = record.id || record.url;
    if (key && seenImageKeys.has(key)) {
      // Duplicate "final" message for the same image; ignore to prevent UI clutter
      return;
    }
    if (key) {
      seenImageKeys.add(key);
    }

    discoveredImages.push(record);
    addImageToList(record);
    maybeAutoDownload(record);
  }

  function hookSocket(ws) {
    try {
      ws.addEventListener('message', (event) => {
        decodeData(event.data, handleServerMessageText);
      });
    } catch (e) {
      console.warn('[TM] Failed to hook WS message listener', e);
    }
  }

  // ---------------------------
  // WebSocket send hooking
  // ---------------------------

  const nativeSend = WebSocket && WebSocket.prototype && WebSocket.prototype.send;

  if (!nativeSend) {
    console.warn('[TM] WebSocket.send not available');
  } else {
    WebSocket.prototype.send = function patchedSend(data) {
      // Lazily hook incoming messages for this socket the first time it sends anything
      if (!this.__grokImageDownloaderHooked) {
        this.__grokImageDownloaderHooked = true;
        hookSocket(this);
      }
      return nativeSend.call(this, data);
    };
    console.log('[TM] WebSocket.send patched for image capture');
  }

  // ---------------------------
  // UI helpers
  // ---------------------------

  let autoDownloadEnabled = false;

  function ensureStyles() {
    if (document.getElementById('grok-image-downloader-style')) return;
    const style = document.createElement('style');
    style.id = 'grok-image-downloader-style';
    style.textContent = `
      #grok-image-downloader-panel {
        position: fixed;
        bottom: 16px;
        left: 16px;
        max-width: 320px;
        max-height: 260px;
        background: rgba(15, 23, 42, 0.95);
        color: #e5e7eb;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        padding: 8px 10px;
        border-radius: 10px;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #grok-image-downloader-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      #grok-image-downloader-title {
        font-size: 12px;
        font-weight: 600;
      }
      #grok-image-downloader-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
      }
      #grok-image-downloader-toggle input {
        width: 12px;
        height: 12px;
        cursor: pointer;
      }
      #grok-image-downloader-list {
        margin: 0;
        padding: 0;
        list-style: none;
        overflow-y: auto;
        max-height: 185px;
      }
      .grok-image-downloader-item {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
      }
      .grok-image-downloader-thumb {
        width: 32px;
        height: 32px;
        flex: 0 0 auto;
        border-radius: 6px;
        object-fit: cover;
        background: #111827;
      }
      .grok-image-downloader-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .grok-image-downloader-prompt {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .grok-image-downloader-actions {
        flex: 0 0 auto;
      }
      .grok-image-downloader-download {
        border: none;
        padding: 3px 6px;
        border-radius: 999px;
        background: #2563eb;
        color: #f9fafb;
        cursor: pointer;
        font-size: 11px;
      }
      .grok-image-downloader-download:hover {
        background: #1d4ed8;
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if (document.getElementById('grok-image-downloader-panel')) return;

    ensureStyles();

    const panel = document.createElement('div');
    panel.id = 'grok-image-downloader-panel';

    const header = document.createElement('div');
    header.id = 'grok-image-downloader-header';

    const title = document.createElement('div');
    title.id = 'grok-image-downloader-title';
    title.textContent = 'Grok image downloads';

    const controls = document.createElement('div');

    const toggleLabel = document.createElement('label');
    toggleLabel.id = 'grok-image-downloader-toggle';

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.addEventListener('change', () => {
      autoDownloadEnabled = toggleInput.checked;
      console.log('[TM] Auto-download images:', autoDownloadEnabled);
    });

    const toggleText = document.createElement('span');
    toggleText.textContent = 'Auto-download';

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleText);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.style.marginLeft = '8px';
    clearBtn.style.fontSize = '11px';
    clearBtn.style.padding = '3px 8px';
    clearBtn.style.borderRadius = '999px';
    clearBtn.style.border = 'none';
    clearBtn.style.cursor = 'pointer';
    clearBtn.style.background = '#374151';
    clearBtn.style.color = '#e5e7eb';
    clearBtn.addEventListener('click', () => {
      const listEl = document.getElementById('grok-image-downloader-list');
      if (listEl) {
        listEl.innerHTML = '';
      }
      discoveredImages.length = 0;
      seenImageKeys.clear();
      console.log('[TM] Cleared Grok image list');
    });

    controls.appendChild(toggleLabel);
    controls.appendChild(clearBtn);

    header.appendChild(title);
    header.appendChild(controls);

    const list = document.createElement('ul');
    list.id = 'grok-image-downloader-list';

    panel.appendChild(header);
    panel.appendChild(list);

    document.body.appendChild(panel);
  }

  function buildFilename(record) {
    // Prefer the filename already present in the URL, e.g.
    // https://.../35d0...ff4dc.png -> 35d0...ff4dc.png
    if (record.url) {
      try {
        const u = new URL(record.url);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1];
        if (last) return last;
      } catch (_) {
        // Fallback if URL constructor fails
        const noQuery = record.url.split('?')[0];
        const idx = noQuery.lastIndexOf('/');
        if (idx !== -1 && idx + 1 < noQuery.length) {
          return noQuery.slice(idx + 1);
        }
      }
    }

    // Fallback: construct a sane name from the prompt and ID
    const base = record.prompt || 'grok_image';
    const safeBase = base.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'grok_image';
    const extMatch = (record.url || '').split('?')[0].match(/\.(png|jpe?g|webp|gif|bmp)$/i);
    const ext = extMatch ? extMatch[0] : '.png';
    const suffix = record.id ? '-' + String(record.id).slice(0, 8) : '';
    return safeBase + suffix + ext;
  }

  // Build the URL to download from. For actual file saves we always
  // use the public image URL, never the in-band base64 blob, so the
  // downloaded file matches what Grok serves (size/format/metadata).
  function getDownloadUrl(record) {
    return record.url;
  }

  // Manual download (button click): prefer GM_download with the browser's
  // default download location; fall back to opening in a new tab if the
  // userscript manager does not provide GM_download.
  function triggerDownload(record) {
    const filename = buildFilename(record);
    const downloadUrl = getDownloadUrl(record);

    if (typeof GM_download === 'function') {
      try {
        GM_download({
          url: downloadUrl,
          name: filename,
          saveAs: false,
          onerror: (e) => {
            console.warn('[TM] GM_download manual failed, falling back', e);
            openInNewTab(record.url);
          }
        });
        return;
      } catch (e) {
        console.warn('[TM] GM_download manual threw, falling back', e);
        openInNewTab(record.url);
        return;
      }
    }

    openInNewTab(record.url);
  }

  function openInNewTab(url) {
    try {
      window.open(url, '_blank', 'noopener');
    } catch (_) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  // Auto-download: try to use the real "download" attribute so the browser
  // saves the file directly when possible. Some browsers may still ignore
  // this for cross-origin URLs and open a tab instead; that behavior is
  // controlled by the browser, not the script.
  function triggerAutoDownload(record) {
    const filename = buildFilename(record);
    const downloadUrl = getDownloadUrl(record);

    // Prefer Tampermonkey's GM_download if available, since it
    // can perform real background downloads without tab noise.
    if (typeof GM_download === 'function') {
      try {
        GM_download({
          url: downloadUrl,
          name: filename,
          saveAs: false,
          onerror: (e) => {
            console.warn('[TM] GM_download failed, falling back', e);
            // Fall through to DOM-based approach
            domAutoDownload(record, filename);
          }
        });
        return;
      } catch (e) {
        console.warn('[TM] GM_download threw, falling back', e);
        domAutoDownload(record, filename);
        return;
      }
    }

    // Fallback if GM_download is not present (other managers or disabled grant)
    domAutoDownload(record, filename);
  }

  function domAutoDownload(record, filename) {
    try {
      const a = document.createElement('a');
      a.href = getDownloadUrl(record);
      a.download = filename;
      // Use a new tab as the navigation target so that, even if the
      // browser ignores the download attribute for cross-origin URLs,
      // the main Grok page is not replaced.
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.warn('[TM] DOM auto-download failed, opening in new tab', e);
      triggerDownload(record);
    }
  }

  function maybeAutoDownload(record) {
    if (!autoDownloadEnabled) return;

    // Delay auto-download slightly so the public image URL has time
    // to become available on the CDN. No retries or fallbacks – just
    // a one-time delay before attempting the download.
    const delayMs = 2000;
    setTimeout(() => {
      if (!autoDownloadEnabled) return;
      try {
        triggerAutoDownload(record);
      } catch (e) {
        console.warn('[TM] Auto-download failed', e);
      }
    }, delayMs);
  }

  function addImageToList(record) {
    if (!document.body) return;
    ensurePanel();

    const list = document.getElementById('grok-image-downloader-list');
    if (!list) return;

    const item = document.createElement('li');
    item.className = 'grok-image-downloader-item';

    const img = document.createElement('img');
    img.className = 'grok-image-downloader-thumb';
    // Populate the thumbnail slightly after capture. This gives Grok a bit
    // of time to finish writing the blob/URL and avoids some "garbage" or
    // placeholder thumbs that can appear when we read it too early.
    const thumbDelayMs = 1500;
    setTimeout(() => {
      // If the panel or item has been removed in the meantime, abort.
      if (!document.body.contains(item)) return;
      // Prefer the base64 blob for thumbnails if provided; handle both raw
      // base64 and full data URLs.
      if (record.blob) {
        if (typeof record.blob === 'string' && record.blob.startsWith('data:')) {
          img.src = record.blob;
        } else {
          img.src = 'data:image/png;base64,' + record.blob;
        }
      } else {
        img.src = record.url;
      }
    }, thumbDelayMs);
    img.alt = record.prompt || 'Grok image';

    const meta = document.createElement('div');
    meta.className = 'grok-image-downloader-meta';

    const promptEl = document.createElement('div');
    promptEl.className = 'grok-image-downloader-prompt';
    promptEl.textContent = record.prompt || '(no prompt)';

    const actions = document.createElement('div');
    actions.className = 'grok-image-downloader-actions';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grok-image-downloader-download';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => {
      triggerDownload(record);
    });

    actions.appendChild(btn);
    meta.appendChild(promptEl);

    item.appendChild(img);
    item.appendChild(meta);
    item.appendChild(actions);

    list.insertBefore(item, list.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePanel);
  } else {
    ensurePanel();
  }
})();

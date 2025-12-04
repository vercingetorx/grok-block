// ==UserScript==
// @name         Grok: image downloader helper
// @match        https://grok.com/imagine*
// @run-at       document-start
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  console.log('[TM] Grok image downloader script starting');

  // Track discovered images for mapping and UI tally
  const discoveredImages = [];
  const recordsById = new Map();
  const recordsByKey = new Map();
  let capturedCount = 0;
  let capturedCountEl = null;

  // Queue of image records that have been seen from the WebSocket
  // but not yet associated with a tile/button in the DOM.
  const unboundRecords = [];

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

    const pct =
      typeof obj.percentage_complete === 'number' ? obj.percentage_complete : null;

    console.log(
      '[TM] Grok image message seen',
      obj.url,
      obj.prompt || obj.full_prompt || '',
      'pct=',
      pct
    );

    // Build a stable data URL representation (or equivalent) so we can
    // derive a hash that matches what the DOM uses for <img src="...">.
    let dataUrl = null;
    if (typeof obj.src === 'string' && obj.src.startsWith('data:')) {
      dataUrl = obj.src;
    } else if (typeof obj.blob === 'string' && obj.blob.length > 0) {
      if (obj.blob.startsWith('data:')) {
        dataUrl = obj.blob;
      } else {
        // Prefix is irrelevant for hashing; the base64 content is what matters.
        dataUrl = 'data:image/jpeg;base64,' + obj.blob;
      }
    }

    const dataHash = dataUrl ? computeDataHash(dataUrl) : null;

    let blobPrefix = null;
    if (typeof obj.blob === 'string' && obj.blob.length > 0) {
      const commaIdx = obj.blob.indexOf(',');
      const base = commaIdx >= 0 ? obj.blob.slice(commaIdx + 1) : obj.blob;
      blobPrefix = base.slice(0, 256);
    }

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
    let record = key ? recordsByKey.get(key) || null : null;

    if (record) {
      // Update existing record with the latest info (e.g. pct or url changes)
      record.url = obj.url || record.url;
      record.prompt = obj.prompt || obj.full_prompt || record.prompt;
      record.dataHash = dataHash || record.dataHash;
      record.imageId = imageId || record.imageId;
      record.pct = pct;
    } else {
      record = {
        url: obj.url,
        prompt: obj.prompt || obj.full_prompt || '',
        id: imageId || obj.job_id || '',
        ts: Date.now(),
        dataHash,
        imageId,
        pct,
        autoDownloaded: false,
        autoDownloadScheduled: false
      };

      discoveredImages.push(record);
      unboundRecords.push(record);
      if (record.imageId) {
        recordsById.set(record.imageId, record);
      }
      if (key) {
        recordsByKey.set(key, record);
      }
      incrementCapturedCount();
    }

    maybeAutoDownload(record);

    // Re-scan the DOM now that we have a new image record, so tiles
    // that were rendered before this WS message can still get buttons.
    try {
      scanForImageTiles();
    } catch (e) {
      console.warn('[TM] Error while rescanning tiles after image message', e);
    }
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
  let domObserverStarted = false;

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
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
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
      .grok-image-download-overlay {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 10;
        pointer-events: none;
      }
      .grok-image-download-overlay button {
        pointer-events: auto;
        border: none;
        padding: 3px 6px;
        border-radius: 999px;
        background: #1e88e5;
        color: #f9fafb;
        cursor: pointer;
        font-size: 11px;
      }
      .grok-image-download-overlay button:hover {
        background: #1565c0;
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
    header.appendChild(title);
    header.appendChild(toggleLabel);

    const counter = document.createElement('div');
    counter.id = 'grok-image-downloader-counter';
    counter.textContent = 'Captured: 0';
    capturedCountEl = counter;

    panel.appendChild(header);
    panel.appendChild(counter);

    document.body.appendChild(panel);
  }

  function incrementCapturedCount() {
    capturedCount += 1;
    if (capturedCountEl) {
      capturedCountEl.textContent = 'Captured: ' + capturedCount;
    }
  }

  // Compute a lightweight, deterministic hash from a data URL string.
  // We strip the "data:...," prefix and sample characters from the base64
  // payload so we don't need to keep the whole blob in memory.
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

  // ---------------------------
  // DOM observer to attach per-tile download buttons
  // ---------------------------

  function startDomObserver() {
    if (domObserverStarted || !window.MutationObserver) return;
    domObserverStarted = true;

    const observer = new MutationObserver(() => {
      try {
        scanForImageTiles();
      } catch (e) {
        console.warn('[TM] Error while scanning for Grok tiles', e);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Initial scan in case some tiles already exist.
    scanForImageTiles();
  }

  function scanForImageTiles() {
    // Use the existing "Make video" button as an anchor on each tile.
    const videoButtons = document.querySelectorAll('button[aria-label="Make video"]');
    videoButtons.forEach((btn) => {
      attachOverlayToTile(btn);
    });
  }

  function attachOverlayToTile(videoButton) {
    if (!videoButton) return;

    // Find the tile container that holds both the image and the bottom-right overlay.
    // We look upwards until we find an ancestor that contains an <img alt="Generated image">.
    let tile = videoButton.parentElement;
    while (tile && !tile.querySelector('img[alt="Generated image"]')) {
      tile = tile.parentElement;
    }
    if (!tile) return;

    const img = tile.querySelector('img[alt="Generated image"]');
    if (!img) return;

    // Match by hash of the data URL used for this tile's <img src="...">.
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:image')) return;

    const srcHash = computeDataHash(src);
    if (!srcHash) return;

    const record =
      discoveredImages.find((r) => r.dataHash && r.dataHash === srcHash) ||
      null;

    if (!record || !record.url) return;

    if (tile.querySelector('.grok-image-download-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'grok-image-download-overlay';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      triggerDownload(record);
    });

    overlay.appendChild(btn);
    tile.appendChild(overlay);

    // Optionally mark this record as no longer "unbound" if present in the queue.
    const idx = unboundRecords.indexOf(record);
    if (idx !== -1) {
      unboundRecords.splice(idx, 1);
    }
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

  // Build a CDN image URL directly from an imageId. This is used as a
  // fallback for manual per-tile downloads when we don't have a WebSocket
  // record, so the button still works for images that were present before
  // our WS hook saw any messages.
  function buildUrlFromImageId(imageId) {
    if (!imageId) return null;
    // Grok URLs observed so far look like:
    // https://imagine-public.x.ai/imagine-public/images/<imageId>.png
    return (
      'https://imagine-public.x.ai/imagine-public/images/' +
      imageId +
      '.png'
    );
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

    // Only auto-download when we have a "final-ish" image; intermediate
    // progress frames (e.g. 0%, 50%) are ignored for auto-download.
    if (typeof record.pct === 'number' && record.pct < 100) return;

    // Avoid scheduling multiple downloads for the same image.
    if (record.autoDownloaded || record.autoDownloadScheduled) return;
    record.autoDownloadScheduled = true;

    // Delay auto-download slightly so the public image URL has time
    // to become available on the CDN. No retries or fallbacks – just
    // a one-time delay before attempting the download.
    const delayMs = 2000;
    setTimeout(() => {
      if (!autoDownloadEnabled) return;
      try {
        triggerAutoDownload(record);
        record.autoDownloaded = true;
      } catch (e) {
        console.warn('[TM] Auto-download failed', e);
      }
    }, delayMs);
  }

  function addImageToList(record) {
    // No-op: we no longer maintain a thumbnail list in the panel,
    // but we keep this function name to avoid touching earlier logic.
    if (!document.body) return;
    ensurePanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensurePanel();
      startDomObserver();
    });
  } else {
    ensurePanel();
    startDomObserver();
  }
})();

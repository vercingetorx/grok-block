(() => {
  'use strict';

  const defaults = {
    scrollMode: 'off', // 'off' | 'block-posts' | 'manual-main'
    downloaderEnabled: true,
    autoDownload: false
  };

  let settings = { ...defaults };

  // Inject page script to patch WebSocket in page context
  injectPageScript();

  chrome.storage.local.get(defaults, (state) => {
    settings = { ...defaults, ...state };
    console.log('[GrokHelper] content script settings', settings);
    sendSettingsToPage();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needsUpdate = false;
    Object.keys(changes).forEach((k) => {
      if (k in defaults) {
        settings[k] = changes[k].newValue;
        needsUpdate = true;
      }
    });
    if (needsUpdate) {
      console.log('[GrokHelper] settings updated', settings);
      sendSettingsToPage();
    }
  });

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page_inject.js');
    script.type = 'text/javascript';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  function sendSettingsToPage() {
    window.postMessage(
      {
        source: 'GrokHelperExt',
        type: 'settings',
        payload: settings
      },
      '*'
    );
  }

  // Listen for messages from the injected page script
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'GrokHelperPage') return;

    if (data.type === 'ready') {
      // Page script is ready to receive settings; send current state.
      sendSettingsToPage();
      return;
    }

    if (data.type === 'download' && data.payload && data.payload.url) {
      const { url, filename } = data.payload;
      chrome.runtime.sendMessage({ type: 'download', url, filename }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn(
            '[GrokHelper] download error',
            chrome.runtime.lastError.message
          );
        } else if (resp && resp.ok === false) {
          console.warn('[GrokHelper] download error', resp.error);
        }
      });
    }
  });
})();

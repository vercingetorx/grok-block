const defaults = {
  scrollMode: 'off',
  downloaderEnabled: true,
  autoDownload: false
};

function restoreUI(state) {
  const mode = state.scrollMode || defaults.scrollMode;
  const downloaderEnabled =
    typeof state.downloaderEnabled === 'boolean'
      ? state.downloaderEnabled
      : defaults.downloaderEnabled;
  const autoDownload =
    typeof state.autoDownload === 'boolean'
      ? state.autoDownload
      : defaults.autoDownload;

  document
    .querySelectorAll('input[name="scrollMode"]')
    .forEach((el) => (el.checked = el.value === mode));

  document.getElementById('downloaderEnabled').checked = downloaderEnabled;
  document.getElementById('autoDownload').checked = autoDownload;
}

function readUI() {
  const modeEl = document.querySelector('input[name="scrollMode"]:checked');
  const scrollMode = modeEl ? modeEl.value : defaults.scrollMode;
  const downloaderEnabled = document.getElementById('downloaderEnabled').checked;
  const autoDownload = document.getElementById('autoDownload').checked;
  return { scrollMode, downloaderEnabled, autoDownload };
}

function saveState() {
  const state = readUI();
  chrome.storage.local.set(state);
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(defaults, (state) => {
    restoreUI(state);
  });

  document.querySelectorAll('input[name="scrollMode"]').forEach((el) => {
    el.addEventListener('change', saveState);
  });
  document.getElementById('downloaderEnabled').addEventListener('change', saveState);
  document.getElementById('autoDownload').addEventListener('change', saveState);
});

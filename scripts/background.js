/** ChatGPT Timeline - background service worker */

const DEFAULT_SETTINGS = {
  enabled: true,
  showSidebarTime: false,
  showMessageTimestamps: false,
  fontSize: 'small',
  openInBackground: true,
  launcherPosition: { x: 0.94, y: 0.76 },
  panelSize: { width: 580, height: 560 }
};

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[ChatGPT Timeline] Installed:', details.reason);
  if (details.reason === 'install') {
    chrome.storage.local.set(DEFAULT_SETTINGS);
  } else {
    chrome.storage.local.get(null, values => {
      const updates = {};
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (values[key] === undefined) updates[key] = value;
      }
      if (Object.keys(updates).length) chrome.storage.local.set(updates);
    });
  }
  chrome.storage.local.remove([
    'ct_data',
    'ct_ts',
    'conversationCache',
    'cacheTime',
    'dateFormat',
    'dateType',
    'openInNewTab'
  ]);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getSettings') {
    chrome.storage.local.get(DEFAULT_SETTINGS, sendResponse);
    return true;
  }
  if (message.action === 'saveSettings') {
    chrome.storage.local.set(message.settings, () => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'openInBackground') {
    try {
      const url = new URL(message.url);
      if (url.origin !== 'https://chatgpt.com') throw new Error('Unsupported URL');
      chrome.tabs.create({ url: url.href, active: false }, tab => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab?.id ?? null });
        }
      });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
});

console.log('[ChatGPT Timeline] Background worker ready');

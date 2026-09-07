document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle');
  const sidebarTimeToggle = document.getElementById('sidebarTimeToggle');
  const messageTimeToggle = document.getElementById('messageTimeToggle');
  const openInBackgroundToggle = document.getElementById('openInBackgroundToggle');
  const outsideCloseToggle = document.getElementById('outsideCloseToggle');
  const size = document.getElementById('size');
  const filenamePreset = document.getElementById('filenamePreset');
  const customTemplateWrap = document.getElementById('customTemplateWrap');
  const filenameTemplate = document.getElementById('filenameTemplate');
  const filenamePreview = document.getElementById('filenamePreview');
  const refresh = document.getElementById('refresh');
  const refreshText = document.getElementById('refreshText');
  const count = document.getElementById('count');
  const apiStatus = document.getElementById('apiStatus');
  const apiStatusText = document.getElementById('apiStatusText');

  function setToggle(el, on) {
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', String(on));
  }

  function setSidebarControlsEnabled(on) {
    size.disabled = !on;
  }

  const filenamePresets = {
    title: '{title}',
    date_title: '{created_date}_{title}',
    source_title: '{source}_{title}',
    date_source_title: '{created_date}_{source}_{title}'
  };

  function presetForTemplate(template) {
    const match = Object.entries(filenamePresets).find(([, value]) => value === template);
    return match?.[0] || 'custom';
  }

  function previewFilename(template) {
    const sample = {
      title: 'NocoBase 官方 Demo 分析',
      created_date: '2026-09-05',
      updated_date: '2026-09-07',
      source: 'FlowBase',
      conversation_id: 'abc123'
    };
    const value = String(template || '{title}').replace(/\{(title|created_date|updated_date|source|conversation_id)\}/g, (_, key) => sample[key]);
    return `${value || sample.title}.md`;
  }

  function updateFilenameUi(template) {
    const preset = presetForTemplate(template);
    filenamePreset.value = preset;
    customTemplateWrap.hidden = preset !== 'custom';
    filenameTemplate.value = preset === 'custom' ? template : '';
    filenamePreview.textContent = previewFilename(template);
  }

  function saveFilenameTemplate(template) {
    const value = String(template || '').trim() || '{title}';
    chrome.storage.local.set({ exportFilenameTemplate: value });
    filenamePreview.textContent = previewFilename(value);
  }

  chrome.storage.local.get(['enabled', 'showSidebarTime', 'showMessageTimestamps', 'openInBackground', 'closeOnOutsideClick', 'fontSize', 'exportFilenameTemplate'], values => {
    setToggle(toggle, values.enabled !== false);
    const showSidebarTime = values.showSidebarTime === true;
    setToggle(sidebarTimeToggle, showSidebarTime);
    setToggle(messageTimeToggle, values.showMessageTimestamps === true);
    setToggle(openInBackgroundToggle, values.openInBackground !== false);
    setToggle(outsideCloseToggle, values.closeOnOutsideClick !== false);
    setSidebarControlsEnabled(showSidebarTime);
    size.value = values.fontSize || 'small';
    updateFilenameUi(values.exportFilenameTemplate || '{title}');
  });

  function setStatus(ok, text) {
    apiStatus.className = `api-status ${ok ? 'ok' : 'err'}`;
    apiStatusText.textContent = text;
  }

  function pollStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab?.url?.includes('chatgpt.com')) {
        count.textContent = '–';
        setStatus(false, '请打开 ChatGPT');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, response => {
        if (chrome.runtime.lastError || !response) {
          count.textContent = '?';
          setStatus(false, '扩展尚未就绪');
          return;
        }
        count.textContent = response.directoryCount ?? 0;
        setStatus(Boolean(response.initialized), response.initialized ? '扩展已就绪' : '正在初始化');
      });
    });
  }

  function syncOnPopupOpen() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab?.id || !tab.url?.includes('chatgpt.com')) return;
      chrome.tabs.sendMessage(tab.id, { action: 'incrementalSync' }, response => {
        if (chrome.runtime.lastError || !response?.success) return;
        count.textContent = response.count ?? count.textContent;
      });
    });
  }

  toggle.addEventListener('click', () => {
    const enabled = !toggle.classList.contains('active');
    setToggle(toggle, enabled);
    chrome.storage.local.set({ enabled });
  });
  sidebarTimeToggle.addEventListener('click', () => {
    const showSidebarTime = !sidebarTimeToggle.classList.contains('active');
    setToggle(sidebarTimeToggle, showSidebarTime);
    setSidebarControlsEnabled(showSidebarTime);
    chrome.storage.local.set({ showSidebarTime });
  });
  messageTimeToggle.addEventListener('click', () => {
    const showMessageTimestamps = !messageTimeToggle.classList.contains('active');
    setToggle(messageTimeToggle, showMessageTimestamps);
    chrome.storage.local.set({ showMessageTimestamps });
  });
  openInBackgroundToggle.addEventListener('click', () => {
    const openInBackground = !openInBackgroundToggle.classList.contains('active');
    setToggle(openInBackgroundToggle, openInBackground);
    chrome.storage.local.set({ openInBackground });
  });
  outsideCloseToggle.addEventListener('click', () => {
    const closeOnOutsideClick = !outsideCloseToggle.classList.contains('active');
    setToggle(outsideCloseToggle, closeOnOutsideClick);
    chrome.storage.local.set({ closeOnOutsideClick });
  });
  size.addEventListener('change', () => chrome.storage.local.set({ fontSize: size.value }));
  filenamePreset.addEventListener('change', () => {
    const preset = filenamePreset.value;
    customTemplateWrap.hidden = preset !== 'custom';
    if (preset === 'custom') {
      const current = filenameTemplate.value.trim() || '{created_date}_{title}';
      filenameTemplate.value = current;
      saveFilenameTemplate(current);
      filenameTemplate.focus();
      return;
    }
    saveFilenameTemplate(filenamePresets[preset] || '{title}');
  });
  filenameTemplate.addEventListener('input', () => saveFilenameTemplate(filenameTemplate.value));

  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refreshText.textContent = '正在重建本地目录…';
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return reset();
      chrome.tabs.sendMessage(tabs[0].id, { action: 'refresh' }, response => {
        refreshText.textContent = response?.success
          ? `完成 · ${response.count ?? 0} 条聊天记录`
          : '刷新失败';
        pollStatus();
        setTimeout(reset, 1800);
      });
    });
  });

  function reset() {
    refresh.disabled = false;
    refreshText.textContent = '完整刷新 / 重建缓存';
  }

  syncOnPopupOpen();
  pollStatus();
  setInterval(pollStatus, 3000);
});

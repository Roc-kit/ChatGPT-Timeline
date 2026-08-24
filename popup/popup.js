document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('toggle');
  const sidebarTimeToggle = document.getElementById('sidebarTimeToggle');
  const messageTimeToggle = document.getElementById('messageTimeToggle');
  const outsideCloseToggle = document.getElementById('outsideCloseToggle');
  const size = document.getElementById('size');
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

  chrome.storage.local.get(['enabled', 'showSidebarTime', 'showMessageTimestamps', 'closeOnOutsideClick', 'fontSize'], values => {
    setToggle(toggle, values.enabled !== false);
    const showSidebarTime = values.showSidebarTime === true;
    setToggle(sidebarTimeToggle, showSidebarTime);
    setToggle(messageTimeToggle, values.showMessageTimestamps === true);
    setToggle(outsideCloseToggle, values.closeOnOutsideClick !== false);
    setSidebarControlsEnabled(showSidebarTime);
    size.value = values.fontSize || 'small';
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
  outsideCloseToggle.addEventListener('click', () => {
    const closeOnOutsideClick = !outsideCloseToggle.classList.contains('active');
    setToggle(outsideCloseToggle, closeOnOutsideClick);
    chrome.storage.local.set({ closeOnOutsideClick });
  });
  size.addEventListener('change', () => chrome.storage.local.set({ fontSize: size.value }));

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

  pollStatus();
  setInterval(pollStatus, 3000);
});

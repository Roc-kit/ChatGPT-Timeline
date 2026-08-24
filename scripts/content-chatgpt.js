/** ChatGPT Timeline – ChatGPT page integration */

(function () {
  'use strict';

  const INIT_DELAY_MS = 900;
  const RECHECK_MS = 30 * 1000;
  const BACKGROUND_SYNC_MS = 5 * 60 * 1000;
  const PANEL_OVERLAP = 8;
  const VIEWPORT_MARGIN = 10;
  const PANEL_MIN_WIDTH = 390;
  const PANEL_MIN_HEIGHT = 280;
  const PANEL_COMPACT_WIDTH = 500;
  const MESSAGE_TIMESTAMP_SOURCE_ATTR = 'data-ct-message-timestamps-enabled';

  const S = {
    ready: false,
    apiData: new Map(),
    apiLoaded: false,
    stamped: new WeakSet(),
    observer: null,
    timeline: null,
    launcher: null,
    launcherMoved: false,
    settings: {
      enabled: true,
      showSidebarTime: false,
      showMessageTimestamps: false,
      fontSize: 'small',
      openInBackground: true,
      closeOnOutsideClick: true,
      launcherPosition: { x: 0.94, y: 0.76 },
      panelSize: { width: 580, height: 560 }
    }
  };

  const log = (...args) => console.log('[ChatGPT Timeline]', ...args);

  function timestampValue(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value < 1e10 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function formatTime(value) {
    const ms = timestampValue(value);
    if (!ms) return '时间未知';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    const dayNumber = d.getDay() === 0 ? 7 : d.getDay();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} D${dayNumber}`;
  }

  function formatMessageTime(value) {
    const ms = timestampValue(value);
    if (!ms) return '';
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function allConvLinks() {
    return Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .filter(link => !link.closest('.chat-timeline-panel'));
  }

  function extractId(a) {
    const match = (a.getAttribute('href') || '').match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  }

  function removeMessageTimestamps() {
    document.querySelectorAll('[data-ct-message-timestamp]').forEach(el => el.remove());
  }

  function setMessageTimestampSourceEnabled(enabled) {
    if (enabled) {
      document.documentElement.setAttribute(MESSAGE_TIMESTAMP_SOURCE_ATTR, '1');
    } else {
      document.documentElement.removeAttribute(MESSAGE_TIMESTAMP_SOURCE_ATTR);
    }
  }

  function createMessageTimestamp(value, role = '') {
    const text = formatMessageTime(value);
    if (!text) return null;
    const span = document.createElement('span');
    span.className = [
      'chat-timeline-message-timestamp',
      role === 'assistant' ? 'chat-timeline-message-timestamp-assistant' : '',
      role === 'user' ? 'chat-timeline-message-timestamp-user' : ''
    ].filter(Boolean).join(' ');
    span.setAttribute('data-ct-message-timestamp', '1');
    span.textContent = text;
    return span;
  }

  function stampMessageTimestampElements() {
    let stamped = 0;
    for (const messageEl of document.querySelectorAll('[data-message-id]')) {
      if (messageEl.closest('.chat-timeline-panel')) continue;
      if (messageEl.querySelector(':scope > [data-ct-message-timestamp]')) continue;
      const value = Number(messageEl.getAttribute('data-ct-message-create-time'));
      if (!Number.isFinite(value) || value <= 0) continue;
      const role = messageEl.getAttribute('data-message-author-role') || '';
      const timestamp = createMessageTimestamp(value, role);
      if (!timestamp) continue;
      messageEl.insertBefore(timestamp, messageEl.firstChild);
      stamped++;
    }
    return stamped;
  }

  function stampMessageTimestamps() {
    if (!S.settings.enabled || !S.settings.showMessageTimestamps) {
      removeMessageTimestamps();
      return 0;
    }
    return stampMessageTimestampElements();
  }

  function makeBadge(text) {
    const badge = document.createElement('span');
    badge.setAttribute('data-chat-timeline', '1');
    badge.className = [
      'chat-timeline-badge',
      `chat-timeline-${S.settings.fontSize}`
    ].filter(Boolean).join(' ');
    badge.textContent = text;
    return badge;
  }

  function getSidebarTitleOffset(link) {
    const linkRect = link.getBoundingClientRect();
    if (!linkRect.width) return 12;

    // ChatGPT indents Project conversations differently from regular chats.
    // Measure the first visible title text instead of assuming one fixed left
    // padding, so our timestamp follows the native title indentation exactly.
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('[data-ct-holder]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (!rect.width || rect.left < linkRect.left || rect.left >= linkRect.right) continue;
      return Math.max(0, Math.round(rect.left - linkRect.left));
    }

    const paddingLeft = Number.parseFloat(getComputedStyle(link).paddingLeft);
    return Number.isFinite(paddingLeft) ? Math.max(0, Math.round(paddingLeft)) : 12;
  }

  function injectBadges(link, rec) {
    if (link.querySelector('[data-ct-holder]')) return false;
    const holder = document.createElement('span');
    holder.className = 'chat-timeline-holder';
    holder.setAttribute('data-ct-holder', '1');

    if (rec.createTime) holder.appendChild(makeBadge(formatTime(rec.createTime)));

    if (!holder.childElementCount) return false;
    link.classList.add('chat-timeline-decorated');
    link.style.setProperty('--ct-title-offset', `${getSidebarTitleOffset(link)}px`);
    link.appendChild(holder);
    return true;
  }

  function removeAllBadges() {
    document.querySelectorAll('[data-ct-holder]').forEach(el => el.remove());
    document.querySelectorAll('.chat-timeline-decorated').forEach(el =>
      {
        el.classList.remove('chat-timeline-decorated');
        el.style.removeProperty('--ct-title-offset');
      }
    );
    S.stamped = new WeakSet();
  }

  function stampAll() {
    if (!S.settings.enabled || !S.settings.showSidebarTime || !S.apiData.size) return 0;
    let count = 0;
    for (const link of allConvLinks()) {
      if (S.stamped.has(link) && link.querySelector('[data-ct-holder]')) continue;
      const id = extractId(link);
      if (!id) continue;
      const rec = S.apiData.get(id) || S.apiData.get(id.slice(0, 8));
      if (!rec) continue;
      if (injectBadges(link, rec)) {
        S.stamped.add(link);
        count++;
      }
    }
    return count;
  }

  async function reloadTimestampMap(forceFull = false) {
    const map = await window.APIHandler.getConversationTimestamps(forceFull);
    if (map?.size) {
      S.apiData = map;
      S.apiLoaded = true;
      removeAllBadges();
      if (S.settings.showSidebarTime) stampAll();
    }
    return map;
  }

  function applySyncedConversationRecords(records, statusText = '已完成后台增量同步') {
    S.apiData = new Map();
    for (const rec of records) {
      S.apiData.set(rec.id, rec);
      if (rec.id?.length > 8) S.apiData.set(rec.id.slice(0, 8), rec);
    }
    S.apiLoaded = true;

    if (S.settings.showSidebarTime) {
      removeAllBadges();
      stampAll();
    }

    if (S.timeline?.isConnected) {
      const list = S.timeline.querySelector('.chat-timeline-rows');
      const projectFilter = S.timeline.querySelector('.chat-timeline-project-filter');
      const createdSort = S.timeline.querySelector('.chat-timeline-created-sort');
      const status = S.timeline.querySelector('.chat-timeline-panel-status');
      const direction = createdSort?.getAttribute('aria-sort') === 'ascending' ? 'oldest' : 'newest';
      if (projectFilter) populateProjectFilter(projectFilter, records);
      if (list && projectFilter) renderTimelineRows(list, records, direction, projectFilter.value);
      if (status) status.textContent = `${records.length} 条 · ${statusText}`;
    }
  }

  async function incrementalSyncConversationList(statusText = '已完成增量同步') {
    const records = await window.APIHandler.syncConversationList(false);
    applySyncedConversationRecords(records, statusText);
    return records;
  }

  async function backgroundSyncConversationList() {
    if (!S.settings.enabled || document.hidden) return;
    try {
      await incrementalSyncConversationList('已完成后台增量同步');
    } catch (error) {
      log('Background sync failed:', error.message);
    }
  }

  function closeTimeline() {
    S.timeline?.remove();
    S.timeline = null;
    if (S.launcher) {
      S.launcher.classList.remove('chat-timeline-open');
      S.launcher.removeAttribute('data-panel-vertical');
      S.launcher.removeAttribute('data-panel-horizontal');
      S.launcher.setAttribute('aria-expanded', 'false');
      S.launcher.textContent = '☰';
      S.launcher.title = '聊天目录（可拖动）';
    }
  }

  function setupOutsideClose() {
    document.addEventListener('pointerdown', event => {
      if (!S.timeline || !S.settings.closeOnOutsideClick) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (S.timeline.contains(target) || S.launcher?.contains(target)) return;
      closeTimeline();
    });
  }

  function getLauncherPixelPosition() {
    const button = S.launcher;
    if (!button) return { left: 20, top: 80 };
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - button.offsetWidth - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - button.offsetHeight - VIEWPORT_MARGIN);
    return {
      left: Math.round(VIEWPORT_MARGIN + (maxLeft - VIEWPORT_MARGIN) * S.settings.launcherPosition.x),
      top: Math.round(VIEWPORT_MARGIN + (maxTop - VIEWPORT_MARGIN) * S.settings.launcherPosition.y)
    };
  }

  function placeLauncher() {
    if (!S.launcher) return;
    const { left, top } = getLauncherPixelPosition();
    S.launcher.style.left = `${left}px`;
    S.launcher.style.top = `${top}px`;
  }

  function saveLauncherPosition(left, top) {
    if (!S.launcher) return;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - S.launcher.offsetWidth - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - S.launcher.offsetHeight - VIEWPORT_MARGIN);
    const x = Math.max(0, Math.min(1, (left - VIEWPORT_MARGIN) / Math.max(1, maxLeft - VIEWPORT_MARGIN)));
    const y = Math.max(0, Math.min(1, (top - VIEWPORT_MARGIN) / Math.max(1, maxTop - VIEWPORT_MARGIN)));
    S.settings.launcherPosition = { x, y };
    chrome.storage.local.set({ launcherPosition: S.settings.launcherPosition });
  }

  function setupLauncherDrag(button) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true;
      S.launcherMoved = false;
      const rect = button.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      button.setPointerCapture(event.pointerId);
      button.classList.add('chat-timeline-dragging');
    });

    button.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) S.launcherMoved = true;
      const maxLeft = window.innerWidth - button.offsetWidth - VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - button.offsetHeight - VIEWPORT_MARGIN;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(maxLeft, startLeft + dx));
      const top = Math.max(VIEWPORT_MARGIN, Math.min(maxTop, startTop + dy));
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
      if (S.timeline) positionTimelinePanel();
    });

    const finish = event => {
      if (!dragging) return;
      dragging = false;
      button.classList.remove('chat-timeline-dragging');
      try { button.releasePointerCapture(event.pointerId); } catch (_) {}
      const rect = button.getBoundingClientRect();
      saveLauncherPosition(rect.left, rect.top);
      if (S.timeline) positionTimelinePanel();
    };
    button.addEventListener('pointerup', finish);
    button.addEventListener('pointercancel', finish);
  }

  function ensureFloatingButton() {
    if (S.launcher?.isConnected) return;
    const existing = document.querySelector('[data-chat-timeline-launcher]');
    if (existing) {
      S.launcher = existing;
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-timeline-launcher';
    button.setAttribute('data-chat-timeline-launcher', '1');
    button.setAttribute('aria-label', '打开聊天目录');
    button.setAttribute('aria-expanded', 'false');
    button.title = '聊天目录（可拖动）';
    button.textContent = '☰';
    button.addEventListener('click', event => {
      if (S.launcherMoved) {
        S.launcherMoved = false;
        event.preventDefault();
        return;
      }
      S.timeline ? closeTimeline() : openTimeline();
    });
    document.body.appendChild(button);
    S.launcher = button;
    placeLauncher();
    setupLauncherDrag(button);
  }

  function currentConversationId() {
    const match = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  }

  function currentConversationRecord() {
    const id = currentConversationId();
    if (!id) return null;
    const cached = [...S.apiData.values()].find(item => item?.id === id);
    return cached || { id, title: document.title.replace(/\s*[|·-]\s*ChatGPT.*$/i, '').trim() || 'ChatGPT 聊天记录' };
  }

  function ensureCurrentChatExportButton() {
    const id = currentConversationId();
    const existing = document.querySelector('[data-chat-timeline-current-export]');
    if (!id) {
      existing?.remove();
      return;
    }
    if (existing) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-timeline-current-export';
    button.setAttribute('data-chat-timeline-current-export', '1');
    button.textContent = '导出 MD';
    button.title = '导出当前 ChatGPT 聊天为 Markdown';
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const rec = currentConversationRecord();
      if (!rec) return;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = '导出中…';
      try {
        await exportConversationMarkdown(rec);
        button.textContent = '已导出';
        window.setTimeout(() => {
          if (button.isConnected) button.textContent = oldText;
        }, 1000);
      } catch (error) {
        button.textContent = '失败';
        button.title = `导出失败：${error.message}`;
        window.setTimeout(() => {
          if (button.isConnected) {
            button.textContent = oldText;
            button.title = '导出当前 ChatGPT 聊天为 Markdown';
          }
        }, 1600);
      } finally {
        button.disabled = false;
      }
    });
    document.body.appendChild(button);
  }

  function removeFloatingButton() {
    closeTimeline();
    S.launcher?.remove();
    S.launcher = null;
    document.querySelector('[data-chat-timeline-current-export]')?.remove();
  }

  function positionTimelinePanel() {
    if (!S.timeline || !S.launcher) return;
    const panel = S.timeline;
    const buttonRect = S.launcher.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    const buttonCenterY = buttonRect.top + buttonRect.height / 2;
    const buttonCenterX = buttonRect.left + buttonRect.width / 2;
    const vertical = buttonCenterY > window.innerHeight / 2 ? 'up' : 'down';
    const horizontal = buttonCenterX > window.innerWidth / 2 ? 'left' : 'right';

    // The launcher doubles as the panel's collapse handle. Make it fully
    // overlap the nearest panel corner so launcher + panel read as one UI.
    let top = vertical === 'up'
      ? buttonRect.bottom - panelRect.height
      : buttonRect.top;

    let left = horizontal === 'left'
      ? buttonRect.right - panelRect.width
      : buttonRect.left;

    top = Math.max(VIEWPORT_MARGIN, Math.min(window.innerHeight - panelRect.height - VIEWPORT_MARGIN, top));
    left = Math.max(VIEWPORT_MARGIN, Math.min(window.innerWidth - panelRect.width - VIEWPORT_MARGIN, left));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.dataset.vertical = vertical;
    panel.dataset.horizontal = horizontal;
    S.launcher.dataset.panelVertical = vertical;
    S.launcher.dataset.panelHorizontal = horizontal;
  }

  function applyPanelSize(panel) {
    const maxWidth = Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2);
    const maxHeight = Math.max(220, window.innerHeight - VIEWPORT_MARGIN * 2);
    const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
    const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
    const width = Math.max(minWidth, Math.min(maxWidth, Number(S.settings.panelSize?.width) || 580));
    const height = Math.max(minHeight, Math.min(maxHeight, Number(S.settings.panelSize?.height) || 560));
    panel.style.setProperty('width', `${Math.round(width)}px`, 'important');
    panel.style.setProperty('height', `${Math.round(height)}px`, 'important');
    panel.classList.toggle('chat-timeline-compact', width < PANEL_COMPACT_WIDTH);
  }

  function setupPanelResize(panel) {
    const directions = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const direction of directions) {
      const handle = document.createElement('div');
      handle.className = `chat-timeline-resize-handle chat-timeline-resize-${direction}`;
      handle.dataset.resizeDirection = direction;
      panel.appendChild(handle);

      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        const startRect = panel.getBoundingClientRect();
        handle.setPointerCapture(event.pointerId);
        panel.classList.add('chat-timeline-resizing');

        const move = moveEvent => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          let width = startRect.width;
          let height = startRect.height;
          if (direction.includes('e')) width = startRect.width + dx;
          if (direction.includes('w')) width = startRect.width - dx;
          if (direction.includes('s')) height = startRect.height + dy;
          if (direction.includes('n')) height = startRect.height - dy;

          const maxWidth = Math.max(240, window.innerWidth - VIEWPORT_MARGIN * 2);
          const maxHeight = Math.max(220, window.innerHeight - VIEWPORT_MARGIN * 2);
          const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
          const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
          width = Math.max(minWidth, Math.min(maxWidth, width));
          height = Math.max(minHeight, Math.min(maxHeight, height));
          panel.style.setProperty('width', `${Math.round(width)}px`, 'important');
          panel.style.setProperty('height', `${Math.round(height)}px`, 'important');
          panel.classList.toggle('chat-timeline-compact', width < PANEL_COMPACT_WIDTH);
          positionTimelinePanel();
        };

        const finish = finishEvent => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          panel.classList.remove('chat-timeline-resizing');
          try { handle.releasePointerCapture(finishEvent.pointerId); } catch (_) {}
          const rect = panel.getBoundingClientRect();
          S.settings.panelSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
          chrome.storage.local.set({ panelSize: S.settings.panelSize });
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      });
    }
  }

  function projectFilterKey(rec) {
    return rec.projectId || '__regular__';
  }

  function conversationSourceType(rec) {
    if (!rec.projectId) return 'regular';
    return String(rec.projectId).startsWith('g-p-') ? 'project' : 'gpt';
  }

  function conversationSourceName(rec) {
    const type = conversationSourceType(rec);
    if (type === 'regular') return '—';
    if (rec.projectName) return rec.projectName;
    return type === 'gpt' ? 'GPT' : '未命名项目';
  }

  function populateProjectFilter(select, records) {
    const selected = select.value || '__all__';
    const projects = new Map();
    let hasRegular = false;
    for (const rec of records) {
      if (rec.projectId) {
        const type = conversationSourceType(rec);
        const name = conversationSourceName(rec);
        projects.set(rec.projectId, {
          type,
          name,
          label: type === 'gpt' ? `GPT · ${name}` : `项目 · ${name}`
        });
      }
      else hasRegular = true;
    }
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '__all__';
    all.textContent = '来源 · 全部';
    select.appendChild(all);
    if (hasRegular) {
      const regular = document.createElement('option');
      regular.value = '__regular__';
      regular.textContent = '— · 普通聊天';
      select.appendChild(regular);
    }
    [...projects.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label, 'zh-CN'))
      .forEach(([id, source]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = source.label;
        select.appendChild(option);
    });
    select.value = [...select.options].some(option => option.value === selected) ? selected : '__all__';
  }

  function renderTimelineRows(container, records, direction = 'newest', projectFilter = '__all__') {
    const factor = direction === 'oldest' ? 1 : -1;
    const filtered = projectFilter === '__all__'
      ? records
      : records.filter(rec => projectFilterKey(rec) === projectFilter);
    const sorted = [...filtered].sort((a, b) => factor * (timestampValue(a.createTime) - timestampValue(b.createTime)));

    container.replaceChildren();
    for (const rec of sorted) {
      const row = document.createElement('a');
      row.className = 'chat-timeline-row';
      row.href = rec.href || `/c/${rec.id}`;
      row.addEventListener('click', event => {
        if (!S.settings.openInBackground) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        chrome.runtime.sendMessage({ action: 'openInBackground', url: row.href });
      });

      const date = document.createElement('span');
      date.className = 'chat-timeline-row-date';
      date.textContent = formatTime(rec.createTime);

      const title = document.createElement('span');
      title.className = 'chat-timeline-row-title';
      title.textContent = rec.title;

      const project = document.createElement('span');
      project.className = 'chat-timeline-row-project';
      project.textContent = conversationSourceName(rec);

      const exportCell = document.createElement('span');
      exportCell.className = 'chat-timeline-row-export';

      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'chat-timeline-export-button';
      exportButton.textContent = 'MD';
      exportButton.title = '导出该聊天为 Markdown';
      exportButton.setAttribute('aria-label', `导出 ${rec.title} 为 Markdown`);
      exportButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (exportButton.disabled) return;
        const oldText = exportButton.textContent;
        exportButton.disabled = true;
        exportButton.textContent = '…';
        try {
          await exportConversationMarkdown(rec);
          exportButton.textContent = '✓';
          window.setTimeout(() => {
            if (exportButton.isConnected) exportButton.textContent = oldText;
          }, 900);
        } catch (error) {
          exportButton.textContent = '!';
          exportButton.title = `导出失败：${error.message}`;
          window.setTimeout(() => {
            if (exportButton.isConnected) {
              exportButton.textContent = oldText;
              exportButton.title = '导出该聊天为 Markdown';
            }
          }, 1600);
        } finally {
          exportButton.disabled = false;
        }
      });
      exportCell.appendChild(exportButton);

      row.append(date, title, project, exportCell);
      container.appendChild(row);
    }
  }

  function currentBranchMessages(data) {
    const mapping = data?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];

    let nodeId = data.current_node;
    if (!nodeId || !mapping[nodeId]) {
      const candidates = Object.values(mapping)
        .filter(node => node?.message)
        .sort((a, b) => timestampValue(a.message?.create_time) - timestampValue(b.message?.create_time));
      return candidates.map(node => node.message);
    }

    const messages = [];
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (node.message) messages.push(node.message);
      nodeId = node.parent || null;
    }
    return messages.reverse();
  }

  function messageText(message) {
    const content = message?.content;
    if (!content) return '';
    if (typeof content.text === 'string') return content.text;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const chunks = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        chunks.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') chunks.push(part.text);
      else if (typeof part.content === 'string') chunks.push(part.content);
      else if (part.content_type === 'image_asset_pointer') chunks.push('[图片]');
      else if (part.content_type === 'audio_asset_pointer') chunks.push('[音频]');
    }
    return chunks.join('\n\n').trim();
  }

  function toolNameFromPath(path) {
    const value = String(path || '').trim();
    if (!value) return 'tool';
    const parts = value.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'tool';
  }

  function fenceForText(text, preferred = '') {
    const value = String(text || '');
    let fence = '```';
    while (value.includes(fence)) fence += '`';
    return `${fence}${preferred}\n${value}\n${fence}`;
  }

  function normalizeAssistantExportText(text) {
    const source = String(text || '').trim();
    if (!source || source[0] !== '{' || source[source.length - 1] !== '}') return source;

    let payload;
    try {
      payload = JSON.parse(source);
    } catch (_) {
      return source;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return source;
    if (typeof payload.path !== 'string' || !payload.args || typeof payload.args !== 'object') return source;

    const name = toolNameFromPath(payload.path);
    const args = payload.args;
    const sections = [`**工具调用：${name}**`];

    if (typeof args.patch === 'string' && args.patch.trim()) {
      sections.push(fenceForText(args.patch.trim(), 'diff'));
      return sections.join('\n\n');
    }

    const command = typeof args.cmd === 'string'
      ? args.cmd
      : (typeof args.command === 'string' ? args.command : '');
    if (command.trim()) {
      sections.push(fenceForText(command.trim(), 'bash'));
      return sections.join('\n\n');
    }

    const readableArgs = { ...args };
    delete readableArgs.workspaceId;
    if (Object.keys(readableArgs).length) {
      sections.push(fenceForText(JSON.stringify(readableArgs, null, 2), 'json'));
    }
    return sections.join('\n\n');
  }

  function roleHeading(role) {
    if (role === 'user') return '用户';
    if (role === 'assistant') return 'ChatGPT';
    if (role === 'system') return 'System';
    if (role === 'tool') return 'Tool';
    return role || '消息';
  }

  function sanitizeFilename(name) {
    const cleaned = String(name || 'ChatGPT 聊天记录')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    return (cleaned || 'ChatGPT 聊天记录').slice(0, 120);
  }

  function buildConversationMarkdown(data, fallbackTitle) {
    const title = data?.title || fallbackTitle || 'ChatGPT 聊天记录';
    const messages = currentBranchMessages(data)
      .filter(message => ['user', 'assistant'].includes(message?.author?.role))
      .map(message => ({
        role: message.author.role,
        text: message.author.role === 'assistant'
          ? normalizeAssistantExportText(messageText(message))
          : messageText(message)
      }))
      .filter(item => item.text);

    if (!messages.length) throw new Error('没有找到可导出的用户/助手消息');

    const body = messages.map(item => `## ${roleHeading(item.role)}\n\n${item.text}`).join('\n\n---\n\n');
    return `# ${title}\n\n${body}\n`;
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportConversationMarkdown(rec) {
    const data = await window.APIHandler.getConversation(rec.id);
    const markdown = buildConversationMarkdown(data, rec.title);
    const title = data?.title || rec.title || 'ChatGPT 聊天记录';
    downloadTextFile(`${sanitizeFilename(title)}.md`, markdown);
  }

  async function openTimeline() {
    closeTimeline();
    const panel = document.createElement('section');
    panel.className = 'chat-timeline-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '聊天目录');
    panel.innerHTML = `
      <div class="chat-timeline-panel-header">
        <strong>聊天目录</strong>
        <span class="chat-timeline-panel-status">正在读取本地目录…</span>
      </div>
      <div class="chat-timeline-panel-list">
        <div class="chat-timeline-columns">
          <button type="button" class="chat-timeline-created-sort" aria-label="按创建时间排序" aria-sort="descending">
            <span>创建时间</span><span class="chat-timeline-created-sort-icon">↓</span>
          </button>
          <span>标题</span>
          <select class="chat-timeline-project-filter" aria-label="按项目筛选">
            <option value="__all__">项目名称 · 全部</option>
          </select>
          <span class="chat-timeline-export-column-title">导出</span>
        </div>
        <div class="chat-timeline-rows"></div>
      </div>`;

    document.body.appendChild(panel);
    S.timeline = panel;
    S.launcher.classList.add('chat-timeline-open');
    S.launcher.setAttribute('aria-expanded', 'true');
    S.launcher.textContent = '−';
    S.launcher.title = '收起聊天目录（可拖动）';
    applyPanelSize(panel);
    setupPanelResize(panel);
    const status = panel.querySelector('.chat-timeline-panel-status');
    const list = panel.querySelector('.chat-timeline-rows');
    const createdSort = panel.querySelector('.chat-timeline-created-sort');
    const createdSortIcon = panel.querySelector('.chat-timeline-created-sort-icon');
    const projectFilter = panel.querySelector('.chat-timeline-project-filter');
    let sortDirection = 'newest';

    createdSort.addEventListener('click', async () => {
      sortDirection = sortDirection === 'newest' ? 'oldest' : 'newest';
      createdSortIcon.textContent = sortDirection === 'newest' ? '↓' : '↑';
      createdSort.setAttribute('aria-sort', sortDirection === 'newest' ? 'descending' : 'ascending');
      const cached = await window.APIHandler.getCachedConversationList();
      renderTimelineRows(list, cached, sortDirection, projectFilter.value);
    });
    projectFilter.addEventListener('change', async () => {
      const cached = await window.APIHandler.getCachedConversationList();
      renderTimelineRows(list, cached, sortDirection, projectFilter.value);
    });

    requestAnimationFrame(positionTimelinePanel);

    try {
      const cached = await window.APIHandler.getCachedConversationList();
      if (cached.length) {
        populateProjectFilter(projectFilter, cached);
        renderTimelineRows(list, cached, sortDirection, projectFilter.value);
        status.textContent = `本地已有 ${cached.length} 条，正在增量检查最新数据…`;
        requestAnimationFrame(positionTimelinePanel);
      } else {
        status.textContent = '首次使用，正在建立本地目录…';
      }

      const fresh = await window.APIHandler.syncConversationList(false);
      if (!S.timeline || S.timeline !== panel) return;
      populateProjectFilter(projectFilter, fresh);
      renderTimelineRows(list, fresh, sortDirection, projectFilter.value);
      status.textContent = `${fresh.length} 条 · 已完成增量同步`;
      requestAnimationFrame(positionTimelinePanel);
      if (S.settings.showSidebarTime) await reloadTimestampMap(false);
    } catch (e) {
      if (S.timeline === panel) status.textContent = `同步失败，已保留本地数据：${e.message}`;
    }
  }

  function setupObserver() {
    S.observer?.disconnect();
    let sidebarTimer = null;
    let messageTimer = null;
    S.observer = new MutationObserver(mutations => {
      const sidebarRelevant = mutations.some(mutation =>
        Array.from(mutation.addedNodes).some(node =>
          node.nodeType === 1 && (node.matches?.('a[href*="/c/"]') || node.querySelector?.('a[href*="/c/"]'))
        )
      );
      if (sidebarRelevant) {
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(() => {
          stampAll();
          ensureCurrentChatExportButton();
        }, 300);
      }

      if (S.settings.showMessageTimestamps) {
        const messageRelevant = mutations.some(mutation =>
          (mutation.type === 'attributes' && mutation.attributeName === 'data-ct-message-create-time') ||
          Array.from(mutation.addedNodes).some(node =>
            node.nodeType === 1 && (
              node.matches?.('[data-message-id], section[data-turn-id]') ||
              node.querySelector?.('[data-message-id]')
            )
          )
        );
        if (messageRelevant) {
          clearTimeout(messageTimer);
          messageTimer = setTimeout(() => {
            stampMessageTimestamps();
          }, 100);
        }
      }
    });
    S.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ct-message-create-time']
    });
  }

  async function loadSettings() {
    const values = await new Promise(resolve => {
      chrome.storage.local.get(
        ['enabled', 'showSidebarTime', 'showMessageTimestamps', 'fontSize', 'openInBackground', 'closeOnOutsideClick', 'launcherPosition', 'panelSize'],
        data => resolve(data || {})
      );
    });
    if (values.enabled !== undefined) S.settings.enabled = values.enabled;
    if (values.showSidebarTime !== undefined) S.settings.showSidebarTime = values.showSidebarTime;
    if (values.showMessageTimestamps !== undefined) S.settings.showMessageTimestamps = values.showMessageTimestamps;
    if (values.fontSize) S.settings.fontSize = values.fontSize;
    if (values.openInBackground !== undefined) S.settings.openInBackground = values.openInBackground;
    if (values.closeOnOutsideClick !== undefined) S.settings.closeOnOutsideClick = values.closeOnOutsideClick;
    if (values.launcherPosition?.x != null && values.launcherPosition?.y != null) {
      S.settings.launcherPosition = values.launcherPosition;
    }
    if (values.panelSize?.width && values.panelSize?.height) S.settings.panelSize = values.panelSize;
  }

  function setupMessages() {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (msg.action === 'refresh') {
        (async () => {
          await window.APIHandler.clearCache();
          const records = await window.APIHandler.syncConversationList(true);
          await reloadTimestampMap(false);
          respond({ success: true, count: records.length });
        })().catch(error => respond({ success: false, error: error.message }));
        return true;
      }
      if (msg.action === 'getStatus') {
        (async () => {
          const cached = await window.APIHandler.getCachedConversationList();
          respond({
            platform: 'chatgpt',
            initialized: S.ready,
            directoryCount: cached.length,
            badgeCount: document.querySelectorAll('[data-chat-timeline]').length,
            enabled: S.settings.enabled,
            apiLoaded: S.apiLoaded,
            apiSize: S.apiData.size
          });
        })().catch(() => respond({
          platform: 'chatgpt',
          initialized: S.ready,
          directoryCount: 0,
          enabled: S.settings.enabled
        }));
        return true;
      }
      if (msg.action === 'openTimeline') {
        openTimeline().then(() => respond({ success: true }));
        return true;
      }
      if (msg.action === 'incrementalSync') {
        incrementalSyncConversationList('已完成增量同步')
          .then(records => respond({ success: true, count: records.length }))
          .catch(error => respond({ success: false, error: error.message }));
        return true;
      }
      return false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let restamp = false;
      if (changes.enabled) {
        S.settings.enabled = changes.enabled.newValue;
        if (S.settings.enabled) {
          ensureFloatingButton();
          restamp = true;
        } else {
          removeAllBadges();
          removeMessageTimestamps();
          setMessageTimestampSourceEnabled(false);
          removeFloatingButton();
        }
      }
      if (changes.fontSize) { S.settings.fontSize = changes.fontSize.newValue; restamp = true; }
      if (changes.showSidebarTime) {
        S.settings.showSidebarTime = changes.showSidebarTime.newValue;
        if (S.settings.showSidebarTime) {
          reloadTimestampMap(false).catch(error => log('Sidebar timestamp load failed:', error.message));
          restamp = true;
        } else {
          removeAllBadges();
        }
      }
      if (changes.showMessageTimestamps) {
        S.settings.showMessageTimestamps = changes.showMessageTimestamps.newValue;
        setMessageTimestampSourceEnabled(S.settings.showMessageTimestamps);
        if (S.settings.showMessageTimestamps) {
          stampMessageTimestamps();
        } else {
          removeMessageTimestamps();
        }
      }
      if (changes.openInBackground) S.settings.openInBackground = changes.openInBackground.newValue;
      if (changes.closeOnOutsideClick) S.settings.closeOnOutsideClick = changes.closeOnOutsideClick.newValue;
      if (changes.panelSize?.newValue) S.settings.panelSize = changes.panelSize.newValue;
      if (restamp && S.settings.enabled) {
        removeAllBadges();
        stampAll();
      }
    });
  }

  async function init() {
    await loadSettings();
    if (!S.settings.enabled) { S.ready = true; return; }
    setMessageTimestampSourceEnabled(S.settings.showMessageTimestamps);
    ensureFloatingButton();
    setupOutsideClose();
    setupObserver();
    if (S.settings.showSidebarTime) {
      try {
        await reloadTimestampMap(false);
      } catch (e) {
        log('Initial timestamp load failed:', e.message);
      }
    }
    if (S.settings.showMessageTimestamps) {
      stampMessageTimestamps();
    }
    setInterval(() => {
      if (!S.settings.enabled) return;
      ensureFloatingButton();
      ensureCurrentChatExportButton();
      stampAll();
      if (S.settings.showMessageTimestamps) {
        stampMessageTimestamps();
      }
    }, RECHECK_MS);
    setInterval(backgroundSyncConversationList, BACKGROUND_SYNC_MS);
    window.addEventListener('resize', () => {
      placeLauncher();
      positionTimelinePanel();
    });
    S.ready = true;
    ensureCurrentChatExportButton();
  }

  setupMessages();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, INIT_DELAY_MS));
  } else {
    setTimeout(init, INIT_DELAY_MS);
  }
})();

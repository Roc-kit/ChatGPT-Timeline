(function () {
  'use strict';

  const INIT_KEY = Symbol.for('chat-timeline.message-timestamp-source');
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  const ATTR = 'data-ct-message-create-time';
  const ENABLED_ATTR = 'data-ct-message-timestamps-enabled';

  function enabled() {
    return document.documentElement.getAttribute(ENABLED_ATTR) === '1';
  }

  function messageFromFiber(element) {
    const fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;

    const messageId = element.getAttribute('data-message-id');
    let node = element[fiberKey];
    for (let depth = 0; depth < 20 && node; depth++, node = node.return) {
      const props = node.memoizedProps;
      const direct = props?.message;
      if (direct?.create_time && (!messageId || !direct.id || direct.id === messageId)) return direct;

      const messages = props?.messages;
      if (!Array.isArray(messages)) continue;
      const exact = messageId ? messages.find(message => message?.id === messageId && message?.create_time) : null;
      if (exact) return exact;
      if (!messageId || messages.length === 1) {
        const first = messages.find(message => message?.create_time);
        if (first) return first;
      }
    }
    return null;
  }

  function annotateMessage(element) {
    if (!(element instanceof HTMLElement)) return;
    if (element.hasAttribute(ATTR)) return;
    const message = messageFromFiber(element);
    const createTime = Number(message?.create_time);
    if (!Number.isFinite(createTime) || createTime <= 0) return;
    element.setAttribute(ATTR, String(createTime));
  }

  function scan() {
    if (!enabled()) return;
    document.querySelectorAll('[data-message-id]').forEach(annotateMessage);
  }

  let timer = null;
  const observer = new MutationObserver(mutations => {
    if (!enabled() && !mutations.some(mutation => mutation.attributeName === ENABLED_ATTR)) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 150);
  });

  const start = () => {
    scan();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [ENABLED_ATTR]
    });
    setInterval(scan, 5000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 600), { once: true });
  } else {
    setTimeout(start, 600);
  }
})();

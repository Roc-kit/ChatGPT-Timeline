/** ChatGPT Timeline – ChatGPT API and persistent directory cache */

const APIHandler = (function () {
  'use strict';

  const CFG = {
    TIMEOUT_MS: 12000,
    MAX_RETRIES: 3,
    RETRY_BASE_MS: 1500,
    PAGE_SIZE: 100,
    MAX_PAGES: 30,
    MAX_PROJECT_PAGES: 50,
    MAX_PROJECTS: 100,
    INTER_PAGE_MS: 250,
    TOKEN_TTL_MS: 10 * 60 * 1000,
    FETCH_LOCK_MS: 90 * 1000,
    MIN_SYNC_INTERVAL_MS: 60 * 1000
  };

  const K_DIRECTORY = 'ct_directory_v2';
  const K_DIRECTORY_TS = 'ct_directory_ts';
  const K_LOCK = 'ct_fetch_lock';

  let _token = null;
  let _tokenFetchedAt = 0;
  let _syncPromise = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const store = {
    get: keys => new Promise(resolve => {
      if (!chrome?.storage?.local) { resolve({}); return; }
      chrome.storage.local.get(keys, data => resolve(chrome.runtime.lastError ? {} : data));
    }),
    set: value => new Promise(resolve => {
      if (!chrome?.storage?.local) { resolve(); return; }
      chrome.storage.local.set(value, () => resolve());
    }),
    del: keys => new Promise(resolve => {
      if (!chrome?.storage?.local) { resolve(); return; }
      chrome.storage.local.remove(keys, () => resolve());
    })
  };

  function baseUrl() {
    return 'https://chatgpt.com/backend-api';
  }

  function timestampValue(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value < 1e10 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function sameUpdate(a, b) {
    return Boolean(a && b) && timestampValue(a.updateTime) === timestampValue(b.updateTime);
  }

  async function getToken() {
    if (_token && Date.now() - _tokenFetchedAt < CFG.TOKEN_TTL_MS) return _token;

    const resp = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Session ${resp.status}`);
    const data = await resp.json();
    _token = data?.accessToken || data?.access_token || null;
    _tokenFetchedAt = Date.now();
    if (!_token) throw new Error('Session response did not contain an access token');
    return _token;
  }

  async function fetchAuthedJson(token, url) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), CFG.TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        signal: ctrl.signal
      });
      if (resp.status === 401) {
        _token = null;
        _tokenFetchedAt = 0;
        throw new Error('401_UNAUTHORIZED');
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
      return resp.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function projectNameFromSidebarItem(item, gizmo) {
    return gizmo?.display?.name
      || gizmo?.name
      || item?.gizmo?.display?.name
      || item?.gizmo?.name
      || item?.display?.name
      || item?.name
      || item?.title
      || '未命名项目';
  }

  function recordFromItem(item, project = null) {
    const id = item?.id;
    if (!id) return null;
    const projectId = project?.id || item.gizmo_id || null;
    const shortUrl = project?.shortUrl || projectId;
    return {
      id,
      title: item.title || 'Untitled conversation',
      createTime: item.create_time ?? item.created_at ?? item.createTime ?? null,
      updateTime: item.update_time ?? item.updated_at ?? item.updateTime ?? null,
      href: projectId ? `/g/${shortUrl}/c/${id}` : `/c/${id}`,
      projectId,
      projectName: project?.name || item._chatTimelineProjectName || ''
    };
  }

  function sanitizeStoredRecord(item) {
    if (!item?.id) return null;
    return {
      id: String(item.id),
      title: String(item.title || 'Untitled conversation'),
      createTime: item.createTime ?? null,
      updateTime: item.updateTime ?? null,
      href: String(item.href || `/c/${item.id}`),
      projectId: item.projectId ? String(item.projectId) : null,
      projectName: String(item.projectName || '')
    };
  }

  async function readDirectory() {
    const data = await store.get([K_DIRECTORY]);
    if (!Array.isArray(data[K_DIRECTORY])) return [];
    return data[K_DIRECTORY].map(sanitizeStoredRecord).filter(Boolean);
  }

  async function writeDirectory(records) {
    const clean = records.map(sanitizeStoredRecord).filter(Boolean);
    clean.sort((a, b) => timestampValue(b.updateTime) - timestampValue(a.updateTime));
    await store.set({ [K_DIRECTORY]: clean, [K_DIRECTORY_TS]: Date.now() });
    return clean;
  }

  function buildTimestampMap(records) {
    const map = new Map();
    for (const item of records) {
      const rec = {
        id: item.id,
        createTime: item.createTime,
        updateTime: item.updateTime,
        timestamp: item.createTime ?? item.updateTime
      };
      map.set(item.id, rec);
      if (item.id.length > 8) map.set(item.id.slice(0, 8), rec);
    }
    return map;
  }

  async function fetchRegularIncremental(token, cachedMap, forceFull) {
    const changed = [];
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < CFG.MAX_PAGES && offset < total; page++) {
      const url = new URL(`${baseUrl()}/conversations`);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', String(CFG.PAGE_SIZE));
      url.searchParams.set('order', 'updated');
      const data = await fetchAuthedJson(token, url.toString());
      const items = Array.isArray(data) ? data : (data.items || data.conversations || []);
      if (page === 0 && Number.isFinite(data?.total)) total = data.total;

      let reachedKnownBoundary = false;
      for (const item of items) {
        const rec = recordFromItem(item);
        if (!rec) continue;
        const cached = cachedMap.get(rec.id);
        if (!forceFull && sameUpdate(cached, rec)) {
          reachedKnownBoundary = true;
          break;
        }
        changed.push(rec);
      }

      if (reachedKnownBoundary || items.length < CFG.PAGE_SIZE) break;
      offset += CFG.PAGE_SIZE;
      if (page < CFG.MAX_PAGES - 1) await sleep(CFG.INTER_PAGE_MS);
    }
    return changed;
  }

  async function fetchProjects(token) {
    const projects = [];
    let cursor = null;

    for (let page = 0; page < CFG.MAX_PROJECT_PAGES; page++) {
      const url = new URL(`${baseUrl()}/gizmos/snorlax/sidebar`);
      url.searchParams.set('owned_only', 'true');
      url.searchParams.set('conversations_per_gizmo', '0');
      if (cursor) url.searchParams.set('cursor', cursor);
      const data = await fetchAuthedJson(token, url.toString());
      const items = Array.isArray(data?.items) ? data.items : [];

      for (const item of items) {
        const gizmo = item?.gizmo?.gizmo ?? item?.gizmo ?? item;
        if (!gizmo?.id || !String(gizmo.id).startsWith('g-p-')) continue;
        projects.push({
          id: String(gizmo.id),
          shortUrl: String(gizmo.short_url || item?.gizmo?.short_url || item?.short_url || gizmo.id),
          name: projectNameFromSidebarItem(item, gizmo)
        });
        if (projects.length >= CFG.MAX_PROJECTS) break;
      }

      cursor = data?.cursor || null;
      if (!cursor || projects.length >= CFG.MAX_PROJECTS) break;
      await sleep(CFG.INTER_PAGE_MS);
    }
    return projects;
  }

  async function fetchProjectIncremental(token, project, cachedMap, forceFull) {
    const changed = [];
    let cursor = '0';

    for (let page = 0; page < CFG.MAX_PROJECT_PAGES; page++) {
      const url = new URL(`${baseUrl()}/gizmos/${encodeURIComponent(project.id)}/conversations`);
      url.searchParams.set('cursor', cursor);
      const data = await fetchAuthedJson(token, url.toString());
      const items = Array.isArray(data?.items) ? data.items : [];

      let reachedKnownBoundary = false;
      for (const item of items) {
        const rec = recordFromItem(item, project);
        if (!rec) continue;
        const cached = cachedMap.get(rec.id);
        if (!forceFull && sameUpdate(cached, rec)) {
          reachedKnownBoundary = true;
          break;
        }
        changed.push(rec);
      }

      const next = data?.cursor;
      if (reachedKnownBoundary || !next || items.length === 0) break;
      cursor = String(next);
      await sleep(CFG.INTER_PAGE_MS);
    }
    return changed;
  }

  async function acquireFetchLock() {
    const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const current = await store.get([K_LOCK]);
    const lock = current[K_LOCK];
    if (lock?.at && Date.now() - lock.at < CFG.FETCH_LOCK_MS) return null;
    await store.set({ [K_LOCK]: { owner, at: Date.now() } });
    const verify = await store.get([K_LOCK]);
    return verify[K_LOCK]?.owner === owner ? owner : null;
  }

  async function releaseFetchLock(owner) {
    const current = await store.get([K_LOCK]);
    if (current[K_LOCK]?.owner === owner) await store.del([K_LOCK]);
  }

  async function waitForOtherTabSync(previousTs) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const current = await store.get([K_DIRECTORY_TS]);
      if ((current[K_DIRECTORY_TS] || 0) > previousTs) return readDirectory();
    }
    return null;
  }

  async function runSync(forceFull) {
    const before = await store.get([K_DIRECTORY_TS]);
    const previousTs = before[K_DIRECTORY_TS] || 0;
    let lockOwner = await acquireFetchLock();

    if (!lockOwner) {
      const otherResult = await waitForOtherTabSync(previousTs);
      if (otherResult) return otherResult;
      lockOwner = await acquireFetchLock();
    }

    try {
      const existing = forceFull ? [] : await readDirectory();
      const cachedMap = new Map(existing.map(item => [item.id, item]));
      const resultMap = new Map(existing.map(item => [item.id, item]));

      let token = await getToken();
      for (let attempt = 0; attempt <= CFG.MAX_RETRIES; attempt++) {
        try {
          const regular = await fetchRegularIncremental(token, cachedMap, forceFull);
          for (const rec of regular) resultMap.set(rec.id, rec);

          const projects = await fetchProjects(token);
          for (const project of projects) {
            try {
              const changed = await fetchProjectIncremental(token, project, cachedMap, forceFull);
              for (const rec of changed) resultMap.set(rec.id, rec);

              // Project names can change even if conversation update_time does not.
              for (const [id, rec] of resultMap) {
                if (rec.projectId === project.id && rec.projectName !== project.name) {
                  resultMap.set(id, { ...rec, projectName: project.name, href: `/g/${project.shortUrl}/c/${id}` });
                }
              }
            } catch (e) {
              console.warn(`[ChatGPT Timeline] project ${project.id} sync skipped:`, e.message);
            }
            await sleep(CFG.INTER_PAGE_MS);
          }

          return writeDirectory([...resultMap.values()]);
        } catch (e) {
          if (e.message === '401_UNAUTHORIZED' && attempt === 0) {
            token = await getToken();
            continue;
          }
          if (attempt >= CFG.MAX_RETRIES) throw e;
          await sleep(CFG.RETRY_BASE_MS * Math.pow(2, attempt));
        }
      }
      return writeDirectory([...resultMap.values()]);
    } finally {
      if (lockOwner) await releaseFetchLock(lockOwner);
    }
  }

  async function syncConversationList(forceFull = false) {
    if (_syncPromise) return _syncPromise;
    if (!forceFull) {
      const state = await store.get([K_DIRECTORY, K_DIRECTORY_TS]);
      const hasDirectory = Array.isArray(state[K_DIRECTORY]) && state[K_DIRECTORY].length > 0;
      const age = Date.now() - (state[K_DIRECTORY_TS] || 0);
      if (hasDirectory && age >= 0 && age < CFG.MIN_SYNC_INTERVAL_MS) {
        return state[K_DIRECTORY].map(sanitizeStoredRecord).filter(Boolean);
      }
    }
    _syncPromise = runSync(forceFull);
    try {
      return await _syncPromise;
    } finally {
      _syncPromise = null;
    }
  }

  async function getCachedConversationList() {
    return readDirectory();
  }

  async function getConversationList(forceFull = false) {
    return syncConversationList(forceFull);
  }

  async function getConversationTimestamps(forceFull = false) {
    if (!forceFull) {
      const cached = await readDirectory();
      if (cached.length) return buildTimestampMap(cached);
    }
    const records = await syncConversationList(forceFull);
    return buildTimestampMap(records);
  }

  async function getConversation(conversationId) {
    if (!conversationId) throw new Error('Missing conversation id');
    const token = await getToken();
    return fetchAuthedJson(token, `${baseUrl()}/conversation/${encodeURIComponent(conversationId)}`);
  }

  async function clearCache() {
    await store.del([
      K_DIRECTORY,
      K_DIRECTORY_TS,
      K_LOCK,
      // Legacy keys from v2.1 and upstream versions.
      'ct_data',
      'ct_ts',
      'conversationCache',
      'cacheTime'
    ]);
  }

  return {
    getCachedConversationList,
    syncConversationList,
    getConversationList,
    getConversationTimestamps,
    getConversation,
    clearCache
  };
})();

if (typeof window !== 'undefined') window.APIHandler = APIHandler;

const listEl = document.getElementById('bookmark-list');
const itemTemplate = document.getElementById('item-template');

const SNAPSHOT_KEY = 'bookmarksBarSnapshotV1';
const SNAPSHOT_LOCAL_KEY = 'bookmarksBarSnapshotLocalV1';
const VIRTUAL_APPS_ID = 'virtual:apps';
const VIRTUAL_TAB_GROUPS_ID = 'virtual:tab-groups';
const VIRTUAL_TAB_GROUP_PREFIX = 'virtual:tab-group:';

const state = {
  rootFolderId: null,
  currentFolderId: null,
  path: [],
  topLevelFolders: [],
  nodesById: new Map(),
  clipboard: null,
  drag: null,
  contextNodeId: null,
};

const api = {
  getTree: () => chrome.bookmarks.getTree(),
  getChildren: (id) => chrome.bookmarks.getChildren(id),
  getSubTree: (id) => chrome.bookmarks.getSubTree(id),
  move: (id, destination) => chrome.bookmarks.move(id, destination),
  create: (payload) => chrome.bookmarks.create(payload),
  update: (id, changes) => chrome.bookmarks.update(id, changes),
  remove: (id) => chrome.bookmarks.remove(id),
  removeTree: (id) => chrome.bookmarks.removeTree(id),
  search: (query) => chrome.bookmarks.search(query),
  createTab: (payload) => chrome.tabs.create(payload),
  updateTab: (id, payload) => chrome.tabs.update(id, payload),
  queryTabs: (payload) => chrome.tabs.query(payload),
  groupTabs: (payload) => chrome.tabs.group(payload),
  queryTabGroups: (payload) => chrome.tabGroups.query(payload),
  updateTabGroup: (id, payload) => chrome.tabGroups.update(id, payload),
  createWindow: (payload) => chrome.windows.create(payload),
  storageGet: (key) => chrome.storage.local.get(key),
  storageSet: (obj) => chrome.storage.local.set(obj),
};

function isBookmark(node) {
  return typeof node?.url === 'string' && node.url.length > 0;
}

function isFolder(node) {
  return Boolean(node) && !isBookmark(node);
}

function isVirtualNode(node) {
  return typeof node?.id === 'string' && node.id.startsWith('virtual:');
}

function isVirtualFolderId(folderId) {
  return typeof folderId === 'string' && folderId.startsWith('virtual:');
}

function getFaviconUrl(url) {
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.toString();
}

function sortedByIndex(nodes) {
  return [...nodes].filter(Boolean).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function toSnapshotNode(node, parentId = null) {
  return {
    id: node.id,
    title: node.title,
    url: node.url,
    index: node.index,
    parentId,
    children: (node.children || []).map((child) => toSnapshotNode(child, node.id)),
  };
}

async function saveSnapshot(folderNode) {
  const snapshot = toSnapshotNode(folderNode, folderNode.parentId || null);
  try {
    localStorage.setItem(SNAPSHOT_LOCAL_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore local cache write failures
  }
  await api.storageSet({ [SNAPSHOT_KEY]: snapshot });
}

async function loadSnapshot() {
  const got = await api.storageGet(SNAPSHOT_KEY);
  return got[SNAPSHOT_KEY] || null;
}

function loadSnapshotSync() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getVirtualRootFolders() {
  const rootFolders = sortedByIndex(state.topLevelFolders).filter((node) => (
    node.id !== state.rootFolderId &&
    (node.id === '2' || node.id === '3' || /^(other|mobile) bookmarks$/i.test(node.title || ''))
  ));
  return [
    { id: VIRTUAL_APPS_ID, title: 'Apps Shortcut', index: -2, virtualType: 'apps' },
    { id: VIRTUAL_TAB_GROUPS_ID, title: 'Tab Groups', index: -1, virtualType: 'tab-groups-root' },
    ...rootFolders,
  ];
}

function isRootView() {
  return Boolean(state.rootFolderId) && state.currentFolderId === state.rootFolderId;
}

function renderCachedFirstPaintSync() {
  const cached = loadSnapshotSync();
  if (!cached || !cached.id) return false;
  hydrateNodes(cached);
  state.rootFolderId = cached.id;
  state.currentFolderId = cached.id;
  state.path = computePath(cached.id);
  renderList(cached.children || [], { includeRootVirtuals: false });
  return true;
}

async function loadRoot() {
  const [treeRoot] = await api.getTree();
  const rootChildren = treeRoot?.children || [];
  const bar = rootChildren.find((n) => n.id === '1') ||
    rootChildren.find((n) => /bookmark/i.test(n.title) && /bar/i.test(n.title)) ||
    rootChildren[0];
  if (!bar) {
    throw new Error('Bookmarks Bar was not found.');
  }

  state.rootFolderId = bar.id;
  state.topLevelFolders = rootChildren;
  hydrateNodes({ ...treeRoot, parentId: null });

  const subtree = await api.getSubTree(bar.id);
  const liveBar = subtree[0];
  hydrateNodes(liveBar);
  await saveSnapshot(liveBar);
  await enterFolder(liveBar.id, true);
}

async function enterFolder(folderId, replacePath = false) {
  if (folderId === VIRTUAL_APPS_ID) {
    await api.createTab({ url: 'chrome://apps/', active: true });
    window.close();
    return;
  }
  if (isVirtualFolderId(folderId)) {
    await enterVirtualFolder(folderId, replacePath);
    return;
  }

  const subtree = await api.getSubTree(folderId);
  const folder = subtree[0];
  if (!folder || !isFolder(folder)) {
    return;
  }

  hydrateNodes(folder);

  if (replacePath) {
    state.path = computePath(folder.id);
  } else {
    const currentIx = state.path.findIndex((n) => n.id === folder.id);
    if (currentIx >= 0) {
      state.path = state.path.slice(0, currentIx + 1);
    } else {
      state.path.push(folder);
    }
  }

  state.currentFolderId = folder.id;
  renderList(folder.children || []);
}

async function enterVirtualFolder(folderId, replacePath = false) {
  const folder = await getVirtualFolder(folderId);
  if (!folder) return;

  state.nodesById.set(folder.id, folder);
  (folder.children || []).forEach((child) => state.nodesById.set(child.id, { ...child, parentId: folder.id }));

  if (replacePath) {
    state.path = [state.nodesById.get(state.rootFolderId), folder].filter(Boolean);
  } else {
    const currentIx = state.path.findIndex((n) => n.id === folder.id);
    if (currentIx >= 0) {
      state.path = state.path.slice(0, currentIx + 1);
    } else {
      state.path.push(folder);
    }
  }

  state.currentFolderId = folder.id;
  renderList(folder.children || []);
}

async function getVirtualFolder(folderId) {
  if (folderId === VIRTUAL_TAB_GROUPS_ID) {
    const groups = await api.queryTabGroups({});
    const groupNodes = sortedByIndex(groups.map((group, index) => ({
      id: `${VIRTUAL_TAB_GROUP_PREFIX}${group.id}`,
      title: group.title || 'Unnamed Group',
      index,
      parentId: VIRTUAL_TAB_GROUPS_ID,
      virtualType: 'tab-group',
      tabGroupId: group.id,
      color: group.color,
    })));
    return {
      id: VIRTUAL_TAB_GROUPS_ID,
      title: 'Tab Groups',
      parentId: state.rootFolderId,
      virtualType: 'tab-groups-root',
      children: groupNodes,
    };
  }

  if (folderId.startsWith(VIRTUAL_TAB_GROUP_PREFIX)) {
    const groupId = Number(folderId.slice(VIRTUAL_TAB_GROUP_PREFIX.length));
    if (!Number.isFinite(groupId)) return null;
    const [group, tabs] = await Promise.all([
      api.queryTabGroups({}).then((groups) => groups.find((g) => g.id === groupId)),
      api.queryTabs({ groupId }),
    ]);
    const children = sortedByIndex(tabs.map((tab) => ({
      id: `virtual:tab:${tab.id}`,
      title: tab.title || tab.url || tab.pendingUrl || 'Untitled Tab',
      url: tab.url || tab.pendingUrl || '',
      index: tab.index,
      parentId: folderId,
      virtualType: 'tab',
      tabId: tab.id,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl,
    })));
    return {
      id: folderId,
      title: group?.title || 'Unnamed Group',
      parentId: VIRTUAL_TAB_GROUPS_ID,
      virtualType: 'tab-group',
      tabGroupId: groupId,
      color: group?.color,
      children,
    };
  }

  return null;
}

function computePath(folderId) {
  const path = [];
  let cur = state.nodesById.get(folderId);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? state.nodesById.get(cur.parentId) : null;
  }
  return path;
}

function hydrateNodes(root) {
  const walk = (node, parentId = null) => {
    state.nodesById.set(node.id, { ...node, parentId });
    if (node.children) {
      node.children.forEach((child) => walk(child, node.id));
    }
  };
  walk(root, root.parentId || null);
}

function createSeparator() {
  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  sep.setAttribute('role', 'separator');
  return sep;
}

function createBackItem() {
  const item = itemTemplate.content.firstElementChild.cloneNode(true);
  item.classList.add('back');
  item.draggable = false;
  const folder = state.nodesById.get(state.currentFolderId);
  item.querySelector('.item-icon').textContent = '\u2039';
  item.querySelector('.item-title').textContent = folder?.title || 'Back';
  item.querySelector('.item-meta').textContent = '';
  item.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    hideContextMenu();
    await goBack();
  });
  return item;
}

function createContextBackItem(node) {
  const item = itemTemplate.content.firstElementChild.cloneNode(true);
  item.classList.add('back');
  item.draggable = false;
  item.querySelector('.item-icon').textContent = '\u2039';
  item.querySelector('.item-title').textContent = node.title || node.url || 'Bookmark';
  item.querySelector('.item-meta').textContent = '';
  item.addEventListener('click', (ev) => {
    ev.stopPropagation();
    hideContextMenu();
  });
  return item;
}

function renderList(children, opts = {}) {
  listEl.innerHTML = '';

  const ordered = sortedByIndex(children);
  const showRootVirtuals = opts.includeRootVirtuals !== false && isRootView();
  const virtualFolders = showRootVirtuals ? getVirtualRootFolders() : [];

  if (!isRootView()) {
    listEl.append(createBackItem(), createSeparator());
  }

  virtualFolders.forEach((node) => {
    listEl.append(createItem(node, 'virtual-root'));
  });

  if (virtualFolders.length && ordered.length) {
    listEl.append(createSeparator());
  }

  if (!ordered.length) {
    if (virtualFolders.length) return;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No bookmarks in this folder';
    listEl.append(empty);
    return;
  }

  ordered.forEach((node) => {
    listEl.append(createItem(node));
  });
}

async function openBookmarkWithModifiers(node, ev = null) {
  if (!isBookmark(node)) return;

  if (node.virtualType === 'tab' && node.tabId) {
    await api.updateTab(node.tabId, { active: true });
    window.close();
    return;
  }

  const modifierOpenTab = Boolean(ev && (ev.metaKey || ev.ctrlKey || ev.button === 1));
  const openWindow = Boolean(ev && ev.shiftKey);

  if (openWindow) {
    await api.createWindow({ url: node.url });
    return;
  }

  if (modifierOpenTab) {
    await api.createTab({ url: node.url, active: false });
    return;
  }

  const [activeTab] = await api.queryTabs({ active: true, lastFocusedWindow: true });
  if (activeTab?.id) {
    await api.updateTab(activeTab.id, { url: node.url });
  } else {
    await api.createTab({ url: node.url, active: true });
  }
  window.close();
}

function createItem(node, source = 'main') {
  const item = itemTemplate.content.firstElementChild.cloneNode(true);
  const virtualRoot = source === 'virtual-root';
  const virtualNode = virtualRoot || isVirtualNode(node);
  if (!node) {
    item.classList.add('folder');
    item.querySelector('.item-title').textContent = 'Untitled';
    item.querySelector('.item-meta').textContent = '';
    return item;
  }

  item.classList.add(isFolder(node) ? 'folder' : 'bookmark');
  if (virtualNode) {
    item.classList.add('virtual-root');
    item.draggable = false;
  }
  item.dataset.nodeId = node.id;
  item.dataset.source = source;
  item.querySelector('.item-title').textContent = node.title || (node.url || 'Untitled');
  const iconEl = item.querySelector('.item-icon');

  if (isFolder(node)) {
    const count = node.children?.length ?? 0;
    item.querySelector('.item-meta').textContent = count ? String(count) : '';
  } else {
    item.querySelector('.item-meta').textContent = '';
    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = getFaviconUrl(node.url);
    favicon.alt = '';
    favicon.decoding = 'async';
    favicon.addEventListener('error', () => {
      favicon.remove();
      iconEl.classList.add('fallback');
    }, { once: true });
    iconEl.append(favicon);
  }

  item.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    hideContextMenu();
    if (isFolder(node)) {
      await enterFolder(node.id);
      return;
    }
    await openBookmarkWithModifiers(node, ev);
  });

  item.addEventListener('auxclick', async (ev) => {
    if (ev.button !== 1 || isFolder(node)) return;
    ev.preventDefault();
    ev.stopPropagation();
    await openBookmarkWithModifiers(node, ev);
  });

  item.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (virtualNode) return;
    openContextMenu(ev.clientX, ev.clientY, node);
  });

  item.addEventListener('dragstart', (ev) => {
    if (virtualNode) {
      ev.preventDefault();
      return;
    }
    state.drag = { id: node.id, sourceFolderId: state.currentFolderId };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', node.id);
  });

  item.addEventListener('dragend', () => {
    state.drag = null;
    document.querySelectorAll('.drop-before,.drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  });

  item.addEventListener('dragover', (ev) => {
    if (virtualNode) return;
    const nodeId = node?.id;
    if (!nodeId || !state.drag || state.drag.id === nodeId) return;
    ev.preventDefault();
    const rect = item.getBoundingClientRect();
    const above = ev.clientY - rect.top < rect.height / 2;
    item.classList.toggle('drop-before', above);
    item.classList.toggle('drop-after', !above);
    ev.dataTransfer.dropEffect = 'move';
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drop-before', 'drop-after');
  });

  item.addEventListener('drop', async (ev) => {
    if (virtualNode) return;
    ev.preventDefault();
    item.classList.remove('drop-before', 'drop-after');

    const nodeId = node?.id;
    const dragId = state.drag?.id;
    if (!nodeId || !dragId || dragId === nodeId) return;

    const children = sortedByIndex(await api.getChildren(state.currentFolderId));
    const targetIndex = children.findIndex((n) => n.id === nodeId);
    if (targetIndex < 0) return;

    const rect = item.getBoundingClientRect();
    const placeBefore = ev.clientY - rect.top < rect.height / 2;
    const nextIndex = placeBefore ? targetIndex : targetIndex + 1;

    await api.move(dragId, { parentId: state.currentFolderId, index: nextIndex });
    await refreshCurrent();
  });

  return item;
}

function hideContextMenu() {
  if (!state.contextNodeId) return;
  state.contextNodeId = null;
  renderCurrentFolderFromState();
}

function separator() {
  const el = document.createElement('div');
  el.className = 'menu-sep';
  return el;
}

function createContextAction(label, action, opts = {}) {
  const item = itemTemplate.content.firstElementChild.cloneNode(true);
  item.classList.add('context-action');
  item.draggable = false;
  item.querySelector('.item-icon').textContent = '';
  item.querySelector('.item-title').textContent = label;
  item.querySelector('.item-meta').textContent = '';
  if (opts.danger) item.classList.add('danger');
  if (opts.disabled) {
    item.classList.add('disabled');
    item.setAttribute('aria-disabled', 'true');
  }
  item.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (opts.disabled) return;
    if (opts.confirmMessage && !confirm(opts.confirmMessage())) return;
    state.contextNodeId = null;
    try {
      await action();
    } finally {
      if (opts.refresh !== false) {
        await refreshCurrent();
      } else {
        renderCurrentFolderFromState();
      }
      if (opts.closePopup) {
        window.close();
      }
    }
  });
  return item;
}

async function openAllInFolder(folderId, mode = 'tab', folderTitle = '') {
  const children = sortedByIndex(await api.getChildren(folderId));
  const urls = children.filter((c) => c.url).map((c) => c.url);
  if (!urls.length) return;

  if (mode === 'window') {
    await api.createWindow({ url: urls });
    return;
  }
  if (mode === 'incognito') {
    await api.createWindow({ url: urls, incognito: true });
    return;
  }
  if (mode === 'group') {
    const tabs = await Promise.all(urls.map((url) => api.createTab({ url, active: false })));
    const tabIds = tabs.map((tab) => tab.id).filter(Boolean);
    if (!tabIds.length) return;

    const groupId = await api.groupTabs({ tabIds });
    if (folderTitle) {
      await api.updateTabGroup(groupId, { title: folderTitle });
    }
    await api.updateTab(tabIds[0], { active: true });
    return;
  }

  const [first, ...rest] = urls;
  const [activeTab] = await api.queryTabs({ active: true, lastFocusedWindow: true });
  if (activeTab?.id) {
    await api.updateTab(activeTab.id, { url: first });
  } else {
    await api.createTab({ url: first, active: true });
  }
  await Promise.all(rest.map((url) => api.createTab({ url, active: false })));
}

function getBookmarkManagerUrl({ folderId = '', query = '' } = {}) {
  const url = new URL('chrome://bookmarks/');
  if (folderId) {
    url.searchParams.set('id', folderId);
  }
  if (query) {
    url.searchParams.set('q', query);
  }
  return url.toString();
}

function getBookmarkManagerNodeUrl(node) {
  if (isFolder(node)) {
    return getBookmarkManagerUrl({ folderId: node.id });
  }
  return getBookmarkManagerUrl({ query: node.url || node.title || '' });
}

function openContextMenu(_x, _y, node) {
  state.contextNodeId = node.id;
  listEl.innerHTML = '';

  const folder = isFolder(node);
  listEl.append(createContextBackItem(node), createSeparator());

  if (!folder) {
    listEl.append(createContextAction('Open in New Tab', () => api.createTab({ url: node.url, active: false }), { refresh: false }));
    listEl.append(createContextAction('Open in New Window', () => api.createWindow({ url: node.url }), { refresh: false }));
    listEl.append(createContextAction('Open in Incognito Window', () => api.createWindow({ url: node.url, incognito: true }), { refresh: false }));
    listEl.append(separator());
  } else {
    listEl.append(createContextAction('Open All', () => openAllInFolder(node.id, 'tab'), { refresh: false, closePopup: true }));
    listEl.append(createContextAction('Open All in New Window', () => openAllInFolder(node.id, 'window'), { refresh: false }));
    listEl.append(createContextAction('Open All in Incognito Window', () => openAllInFolder(node.id, 'incognito'), { refresh: false }));
    listEl.append(createContextAction('Open All in New Tab Group', () => openAllInFolder(node.id, 'group', node.title || 'Bookmarks'), { refresh: false, closePopup: true }));
    listEl.append(separator());
  }

  listEl.append(createContextAction('Edit...', async () => {
    const title = prompt(folder ? 'Edit folder name:' : 'Edit bookmark name:', node.title || '');
    if (title === null) return;
    await api.update(node.id, { title });
  }));
  listEl.append(createContextAction('Open in Bookmarks Manager', async () => {
    await api.createTab({ url: getBookmarkManagerNodeUrl(node), active: true });
  }, { refresh: false, closePopup: true }));
  listEl.append(separator());

  listEl.append(createContextAction('Cut', async () => {
    state.clipboard = { id: node.id, mode: 'cut' };
  }, { refresh: false }));
  listEl.append(createContextAction('Copy', async () => {
    state.clipboard = { id: node.id, mode: 'copy' };
  }, { refresh: false }));

  const canPaste = Boolean(state.clipboard);
  listEl.append(createContextAction('Paste', async () => {
    if (!state.clipboard) return;

    const destinationParentId = folder ? node.id : node.parentId;
    if (state.clipboard.mode === 'cut') {
      await api.move(state.clipboard.id, { parentId: destinationParentId });
      state.clipboard = null;
      return;
    }

    const [source] = await chrome.bookmarks.getSubTree(state.clipboard.id);
    await cloneNode(source, destinationParentId);
  }, { disabled: !canPaste }));
  listEl.append(separator());

  listEl.append(createContextAction('Delete', async () => {
    if (folder) {
      await api.removeTree(node.id);
    } else {
      await api.remove(node.id);
    }
  }, {
    confirmMessage: () => {
      const title = node.title || node.url || 'this item';
      return folder
        ? `Delete folder "${title}" and all of its contents?`
        : `Delete bookmark "${title}"?`;
    },
  }));
  listEl.append(separator());

  listEl.append(createContextAction('Add Page...', async () => {
    const title = prompt('Bookmark title:', 'New bookmark');
    if (!title) return;
    const url = prompt('Bookmark URL:', 'https://');
    if (!url) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title, url });
  }));

  listEl.append(createContextAction('Add Folder...', async () => {
    const title = prompt('Folder name:', 'New folder');
    if (!title) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title });
  }));
  listEl.append(separator());

  if (folder) {
    listEl.append(createContextAction('Sort by Name', async () => {
      const children = sortedByIndex(await api.getChildren(node.id));
      const sorted = [...children].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      await Promise.all(sorted.map((child, index) => api.move(child.id, { parentId: node.id, index })));
    }));
  }

  listEl.append(createContextAction('Open Bookmarks Manager', async () => {
    await api.createTab({ url: getBookmarkManagerUrl(), active: true });
  }, { refresh: false }));
}

async function cloneNode(sourceNode, parentId) {
  if (!sourceNode) return;
  if (sourceNode.url) {
    await api.create({ parentId, title: sourceNode.title, url: sourceNode.url });
    return;
  }

  const createdFolder = await api.create({ parentId, title: sourceNode.title });
  const children = sortedByIndex(sourceNode.children || []);
  for (const child of children) {
    await cloneNode(child, createdFolder.id);
  }
}

async function refreshCurrent() {
  if (!state.currentFolderId) return;
  if (isVirtualFolderId(state.currentFolderId)) {
    await enterVirtualFolder(state.currentFolderId, true);
    return;
  }
  const [treeRoot] = await api.getTree();
  state.topLevelFolders = treeRoot?.children || [];
  hydrateNodes({ ...treeRoot, parentId: null });
  await enterFolder(state.currentFolderId, true);
  const subtree = await api.getSubTree(state.currentFolderId);
  const folder = subtree[0];
  if (folder && folder.id === state.rootFolderId) {
    await saveSnapshot(folder);
  }
}

function renderCurrentFolderFromState() {
  if (isVirtualFolderId(state.currentFolderId)) {
    const folder = state.nodesById.get(state.currentFolderId);
    renderList(folder?.children || []);
    return;
  }
  const folder = state.nodesById.get(state.currentFolderId);
  renderList(folder?.children || []);
}

async function goBack() {
  if (state.contextNodeId) {
    hideContextMenu();
    return;
  }
  if (isRootView()) return;
  const previous = state.path.length > 1 ? state.path[state.path.length - 2] : null;
  const targetId = previous && previous.parentId !== null ? previous.id : state.rootFolderId;
  await enterFolder(targetId, true);
}

listEl.addEventListener('contextmenu', (ev) => {
  if (ev.target === listEl) {
    ev.preventDefault();
    const folder = state.nodesById.get(state.currentFolderId);
    if (folder) {
      openContextMenu(ev.clientX, ev.clientY, folder);
    }
  }
});

document.addEventListener('click', () => {
  hideContextMenu();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideContextMenu();
  }
});

let refreshTimer = null;
function queueRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshCurrent().catch(() => {});
  }, 80);
}

chrome.bookmarks.onCreated.addListener(queueRefresh);
chrome.bookmarks.onChanged.addListener(queueRefresh);
chrome.bookmarks.onMoved.addListener(queueRefresh);
chrome.bookmarks.onRemoved.addListener(queueRefresh);

window.__popupTest = {
  getState: () => ({
    rootFolderId: state.rootFolderId,
    currentFolderId: state.currentFolderId,
    contextOpen: Boolean(state.contextNodeId),
  }),
  renderNodes: (nodes) => {
    renderList(nodes);
    return true;
  },
  reorderByIds: async (sourceId, targetId, before = true) => {
    const children = sortedByIndex(await api.getChildren(state.currentFolderId));
    const targetIndex = children.findIndex((n) => n.id === targetId);
    if (targetIndex < 0) return false;
    const index = before ? targetIndex : targetIndex + 1;
    await api.move(sourceId, { parentId: state.currentFolderId, index });
    await refreshCurrent();
    return true;
  },
  clickOpenFolderById: async (folderId) => {
    const row = document.querySelector(`.item[data-node-id=\"${CSS.escape(folderId)}\"]`);
    const node = state.nodesById.get(folderId);
    if (!row || !node || !isFolder(node)) {
      return {
        opened: false,
        hasRow: Boolean(row),
        hasNode: Boolean(node),
        isFolder: isFolder(node),
        currentFolderId: state.currentFolderId,
      };
    }
    row.click();
    for (let i = 0; i < 20; i++) {
      if (state.currentFolderId === folderId) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    return {
      opened: state.currentFolderId === folderId,
      hasRow: true,
      hasNode: true,
      isFolder: true,
      currentFolderId: state.currentFolderId,
    };
  },
  refreshCurrent,
};

renderCachedFirstPaintSync();

loadRoot().catch((err) => {
  listEl.innerHTML = `<div class="empty">${String(err.message || err)}</div>`;
});

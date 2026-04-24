const listEl = document.getElementById('bookmark-list');
const crumbsEl = document.getElementById('crumbs');
const backBtn = document.getElementById('back-btn');
const refreshBtn = document.getElementById('refresh-btn');
const contextMenuEl = document.getElementById('context-menu');
const contextTitleEl = document.getElementById('context-title');
const contextItemsEl = document.getElementById('context-items');
const flyoutLayerEl = document.getElementById('flyout-layer');
const itemTemplate = document.getElementById('item-template');

const SNAPSHOT_KEY = 'bookmarksBarSnapshotV1';
const SNAPSHOT_LOCAL_KEY = 'bookmarksBarSnapshotLocalV1';

const state = {
  currentFolderId: null,
  path: [],
  nodesById: new Map(),
  clipboard: null,
  drag: null,
  flyoutTimers: new Map(),
  activeFlyouts: [],
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
  createWindow: (payload) => chrome.windows.create(payload),
  storageGet: (key) => chrome.storage.local.get(key),
  storageSet: (obj) => chrome.storage.local.set(obj),
};

function isFolder(node) {
  return !node.url;
}

function getFaviconUrl(url) {
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.toString();
}

function sortedByIndex(nodes) {
  return [...nodes].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
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

async function getBookmarksBar() {
  const [treeRoot] = await api.getTree();
  const children = treeRoot?.children || [];
  let bar = children.find((n) => n.id === '1');
  if (!bar) {
    bar = children.find((n) => /bookmark/i.test(n.title) && /bar/i.test(n.title)) || children[0];
  }
  if (!bar) {
    throw new Error('Bookmarks Bar was not found.');
  }
  return bar;
}

function renderCachedFirstPaintSync() {
  const cached = loadSnapshotSync();
  if (!cached || !cached.id) return false;
  hydrateNodes(cached);
  state.currentFolderId = cached.id;
  state.path = computePath(cached.id);
  renderCrumbs();
  renderList(cached.children || []);
  return true;
}

async function loadRoot() {
  const bar = await getBookmarksBar();
  const subtree = await api.getSubTree(bar.id);
  const liveBar = subtree[0];
  hydrateNodes(liveBar);
  await saveSnapshot(liveBar);
  await enterFolder(liveBar.id, true);
}

async function enterFolder(folderId, replacePath = false) {
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
  renderCrumbs();
  renderList(folder.children || []);
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

function renderCrumbs() {
  crumbsEl.textContent = state.path.map((n) => n.title || 'Bookmarks').join(' / ');
  backBtn.disabled = state.path.length <= 1;
}

function clearFlyouts() {
  state.activeFlyouts.forEach((el) => el.remove());
  state.activeFlyouts = [];
  state.flyoutTimers.forEach((t) => clearTimeout(t));
  state.flyoutTimers.clear();
}

function renderList(children) {
  clearFlyouts();
  listEl.innerHTML = '';

  const ordered = sortedByIndex(children);
  if (!ordered.length) {
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
  item.classList.add(isFolder(node) ? 'folder' : 'bookmark');
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
    openContextMenu(ev.clientX, ev.clientY, node);
  });

  item.addEventListener('dragstart', (ev) => {
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
    if (!state.drag || state.drag.id === node.id) return;
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
    ev.preventDefault();
    item.classList.remove('drop-before', 'drop-after');

    if (!state.drag || state.drag.id === node.id) return;

    const children = sortedByIndex(await api.getChildren(state.currentFolderId));
    const targetIndex = children.findIndex((n) => n.id === node.id);
    if (targetIndex < 0) return;

    const rect = item.getBoundingClientRect();
    const placeBefore = ev.clientY - rect.top < rect.height / 2;
    const nextIndex = placeBefore ? targetIndex : targetIndex + 1;

    await api.move(state.drag.id, { parentId: state.currentFolderId, index: nextIndex });
    await refreshCurrent();
  });

  if (isFolder(node)) {
    item.addEventListener('mouseenter', () => scheduleFlyout(item, node));
  }

  return item;
}

function scheduleFlyout(anchorEl, folderNode) {
  clearTimeout(state.flyoutTimers.get(folderNode.id));
  const timer = setTimeout(async () => {
    await openFlyout(anchorEl, folderNode, 0);
  }, 220);
  state.flyoutTimers.set(folderNode.id, timer);
}

async function openFlyout(anchorEl, folderNode, depth = 0) {
  const subtree = await api.getSubTree(folderNode.id);
  const folder = subtree[0];
  const children = sortedByIndex(folder.children || []);

  state.activeFlyouts.slice(depth).forEach((el) => el.remove());
  state.activeFlyouts = state.activeFlyouts.slice(0, depth);

  if (!children.length) return;

  const flyout = document.createElement('div');
  flyout.className = 'flyout';
  flyout.dataset.depth = String(depth);

  children.forEach((child) => {
    const row = createItem(child, 'flyout');
    row.draggable = false;
    if (isFolder(child)) {
      row.addEventListener('mouseenter', () => openFlyout(row, child, depth + 1));
    }
    flyout.append(row);
  });

  const rect = anchorEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 280, rect.right + 1 + depth * 3);
  const top = Math.max(0, Math.min(window.innerHeight - 360, rect.top));
  flyout.style.left = `${left}px`;
  flyout.style.top = `${top}px`;
  flyoutLayerEl.append(flyout);
  state.activeFlyouts.push(flyout);
}

function hideContextMenu() {
  contextMenuEl.hidden = true;
  contextItemsEl.innerHTML = '';
  state.contextNodeId = null;
}

function separator() {
  const el = document.createElement('div');
  el.className = 'context-sep';
  return el;
}

function createContextAction(label, action, opts = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'context-item';
  if (opts.danger) button.classList.add('danger');
  button.textContent = label;
  button.addEventListener('click', async () => {
    hideContextMenu();
    try {
      await action();
    } finally {
      if (opts.refresh !== false) {
        await refreshCurrent();
      }
      if (opts.closePopup) {
        window.close();
      }
    }
  });
  return button;
}

async function openAllInFolder(folderId, mode = 'tab') {
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

  const [first, ...rest] = urls;
  const [activeTab] = await api.queryTabs({ active: true, lastFocusedWindow: true });
  if (activeTab?.id) {
    await api.updateTab(activeTab.id, { url: first });
  } else {
    await api.createTab({ url: first, active: true });
  }
  await Promise.all(rest.map((url) => api.createTab({ url, active: false })));
}

function openContextMenu(x, y, node) {
  state.contextNodeId = node.id;
  contextTitleEl.textContent = node.title || node.url || 'Bookmark';
  contextItemsEl.innerHTML = '';

  const folder = isFolder(node);

  if (!folder) {
    contextItemsEl.append(createContextAction('Open', async () => {
      await openBookmarkWithModifiers(node, null);
    }, { refresh: false }));
    contextItemsEl.append(createContextAction('Open in New Tab', () => api.createTab({ url: node.url, active: false }), { refresh: false }));
    contextItemsEl.append(createContextAction('Open in New Window', () => api.createWindow({ url: node.url }), { refresh: false }));
    contextItemsEl.append(createContextAction('Open in Incognito Window', () => api.createWindow({ url: node.url, incognito: true }), { refresh: false }));
    contextItemsEl.append(separator());
  } else {
    contextItemsEl.append(createContextAction('Open All', () => openAllInFolder(node.id, 'tab'), { refresh: false, closePopup: true }));
    contextItemsEl.append(createContextAction('Open All in New Window', () => openAllInFolder(node.id, 'window'), { refresh: false }));
    contextItemsEl.append(createContextAction('Open All in Incognito Window', () => openAllInFolder(node.id, 'incognito'), { refresh: false }));
    contextItemsEl.append(separator());
  }

  contextItemsEl.append(createContextAction('Add New Bookmark', async () => {
    const title = prompt('Bookmark title:', 'New bookmark');
    if (!title) return;
    const url = prompt('Bookmark URL:', 'https://');
    if (!url) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title, url });
  }));

  contextItemsEl.append(createContextAction('Add New Folder', async () => {
    const title = prompt('Folder name:', 'New folder');
    if (!title) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title });
  }));

  contextItemsEl.append(separator());
  contextItemsEl.append(createContextAction('Cut', async () => {
    state.clipboard = { id: node.id, mode: 'cut' };
  }, { refresh: false }));
  contextItemsEl.append(createContextAction('Copy', async () => {
    state.clipboard = { id: node.id, mode: 'copy' };
  }, { refresh: false }));

  const canPaste = Boolean(state.clipboard);
  const paste = createContextAction('Paste', async () => {
    if (!state.clipboard) return;

    const destinationParentId = folder ? node.id : node.parentId;
    if (state.clipboard.mode === 'cut') {
      await api.move(state.clipboard.id, { parentId: destinationParentId });
      state.clipboard = null;
      return;
    }

    const [source] = await chrome.bookmarks.getSubTree(state.clipboard.id);
    await cloneNode(source, destinationParentId);
  });
  paste.disabled = !canPaste;
  contextItemsEl.append(paste);

  contextItemsEl.append(separator());
  contextItemsEl.append(createContextAction('Edit', async () => {
    const title = prompt('Edit title:', node.title || '');
    if (title === null) return;

    if (folder) {
      await api.update(node.id, { title });
      return;
    }

    const url = prompt('Edit URL:', node.url || '');
    if (url === null) return;
    await api.update(node.id, { title, url });
  }));

  if (folder) {
    contextItemsEl.append(createContextAction('Sort by Name', async () => {
      const children = sortedByIndex(await api.getChildren(node.id));
      const sorted = [...children].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      await Promise.all(sorted.map((child, index) => api.move(child.id, { parentId: node.id, index })));
    }));
  }

  contextItemsEl.append(createContextAction('Bookmark Manager', async () => {
    await api.createTab({ url: 'chrome://bookmarks/', active: true });
  }, { refresh: false }));

  contextItemsEl.append(createContextAction('Delete', async () => {
    if (folder) {
      await api.removeTree(node.id);
    } else {
      await api.remove(node.id);
    }
  }, { danger: true }));

  const maxLeft = window.innerWidth - 280;
  const maxTop = window.innerHeight - 360;
  contextMenuEl.style.left = `${Math.max(0, Math.min(maxLeft, x))}px`;
  contextMenuEl.style.top = `${Math.max(0, Math.min(maxTop, y))}px`;
  contextMenuEl.hidden = false;
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
  await enterFolder(state.currentFolderId, true);
  const subtree = await api.getSubTree(state.currentFolderId);
  const folder = subtree[0];
  if (folder) {
    await saveSnapshot(folder);
  }
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

backBtn.addEventListener('click', async () => {
  if (state.path.length <= 1) return;
  const previous = state.path[state.path.length - 2];
  await enterFolder(previous.id, true);
});

refreshBtn.addEventListener('click', refreshCurrent);

document.addEventListener('click', () => {
  hideContextMenu();
  clearFlyouts();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideContextMenu();
    clearFlyouts();
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
    currentFolderId: state.currentFolderId,
    flyoutCount: state.activeFlyouts.length,
    contextOpen: !contextMenuEl.hidden,
  }),
  reorderByIds: async (sourceId, targetId, before = true) => {
    const children = sortedByIndex(await api.getChildren(state.currentFolderId));
    const targetIndex = children.findIndex((n) => n.id === targetId);
    if (targetIndex < 0) return false;
    const index = before ? targetIndex : targetIndex + 1;
    await api.move(sourceId, { parentId: state.currentFolderId, index });
    await refreshCurrent();
    return true;
  },
  openFlyoutById: async (folderId) => {
    const row = document.querySelector(`.item[data-node-id=\"${CSS.escape(folderId)}\"]`);
    const node = state.nodesById.get(folderId);
    if (!row || !node || !isFolder(node)) return false;
    await openFlyout(row, node, 0);
    return true;
  },
  refreshCurrent,
};

renderCachedFirstPaintSync();

loadRoot().catch((err) => {
  listEl.innerHTML = `<div class="empty">${String(err.message || err)}</div>`;
});

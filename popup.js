const listEl = document.getElementById('bookmark-list');
const itemTemplate = document.getElementById('item-template');

const SNAPSHOT_KEY = 'bookmarksBarSnapshotV1';
const SNAPSHOT_LOCAL_KEY = 'bookmarksBarSnapshotLocalV1';
const SETTINGS_KEY = 'bookmarksBarSettingsV1';
const DRAG_FOLDER_ENTER_DELAY = 550;
const DROP_INTO_FOLDER_EDGE_RATIO = 0.25;
const DEFAULT_SETTINGS = {
  showOtherBookmarks: true,
  showMobileBookmarks: true,
};

const state = {
  rootFolderId: null,
  currentFolderId: null,
  path: [],
  topLevelFolders: [],
  nodesById: new Map(),
  clipboard: null,
  drag: null,
  lastDropIntent: null,
  dragFolderEnter: null,
  dragFolderEnterToken: 0,
  contextNodeId: null,
  settings: { ...DEFAULT_SETTINGS },
  suppressNextBookmarkRefresh: false,
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

async function loadSettings() {
  const got = await api.storageGet(SETTINGS_KEY);
  state.settings = { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}

async function saveSettings() {
  await api.storageSet({ [SETTINGS_KEY]: state.settings });
}

async function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  await saveSettings();
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

async function getVirtualRootFolders() {
  const rootFolders = sortedByIndex(state.topLevelFolders)
    .filter((node) => (
      node.id !== state.rootFolderId &&
      (
        (state.settings.showOtherBookmarks && (node.id === '2' || /^other bookmarks$/i.test(node.title || ''))) ||
        (state.settings.showMobileBookmarks && (node.id === '3' || /^mobile bookmarks$/i.test(node.title || '')))
      )
    ))
    .map((node) => {
      if (node.id === '2' || /^other bookmarks$/i.test(node.title || '')) {
        return { ...node, virtualType: 'other-bookmarks' };
      }
      if (node.id === '3' || /^mobile bookmarks$/i.test(node.title || '')) {
        return { ...node, virtualType: 'mobile-bookmarks' };
      }
      return node;
    });
  return rootFolders;
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
  await loadSettings();
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

async function enterFolder(folderId, replacePath = false, shouldContinue = () => true) {
  if (isVirtualFolderId(folderId)) {
    await enterVirtualFolder(folderId, replacePath);
    return;
  }

  const subtree = await api.getSubTree(folderId);
  if (!shouldContinue()) return;
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
  await renderList(folder.children || []);
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
  await renderList(folder.children || []);
}

async function getVirtualFolder(_folderId) {
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
  const parentFolderId = folder?.parentId || null;
  item.querySelector('.item-icon').textContent = '\u2039';
  item.querySelector('.item-title').textContent = folder?.title || 'Back';
  item.querySelector('.item-meta').textContent = '';
  item.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    hideContextMenu();
    await goBack();
  });
  item.addEventListener('dragover', (ev) => {
    if (!state.drag || !parentFolderId || isVirtualFolderId(state.currentFolderId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    clearLastDropIntent();
    clearDropMarkers();
    item.classList.add('drop-into');
    scheduleDragFolderEnter(parentFolderId);
    ev.dataTransfer.dropEffect = 'move';
  });
  item.addEventListener('dragleave', () => {
    cancelDragFolderEnter();
    clearDropMarkers();
  });
  item.addEventListener('drop', async (ev) => {
    if (!state.drag || !parentFolderId || isVirtualFolderId(state.currentFolderId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelDragFolderEnter();
    clearDropMarkers();

    const dragId = state.drag.id;
    const sourceFolderId = state.drag.sourceFolderId;
    const children = sortedByIndex(await api.getChildren(parentFolderId));
    const requestedIndex = children.filter((child) => child.id !== dragId).length;

    removeDraggedItemFromDom(dragId);
    state.suppressNextBookmarkRefresh = true;
    const moved = await api.move(dragId, { parentId: parentFolderId, index: requestedIndex });
    updateLocalMove(dragId, sourceFolderId, parentFolderId, moved.index ?? requestedIndex);
    if (state.drag) state.drag.sourceFolderId = parentFolderId;
  });
  return item;
}

function getEmptyMessage() {
  return 'No bookmarks in this folder';
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

async function renderList(children, opts = {}) {
  listEl.innerHTML = '';

  const ordered = sortedByIndex(children);
  const showRootVirtuals = opts.includeRootVirtuals !== false && isRootView();
  const virtualFolders = showRootVirtuals ? await getVirtualRootFolders() : [];

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
    empty.textContent = getEmptyMessage();
    listEl.append(empty);
    return;
  }

  ordered.forEach((node) => {
    listEl.append(createItem(node));
  });
}

async function openBookmarkWithModifiers(node, ev = null) {
  if (!isBookmark(node)) return;

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

function clearDropMarkers() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

function clearLastDropIntent() {
  state.lastDropIntent = null;
}

function cancelDragFolderEnter() {
  state.dragFolderEnterToken += 1;
  if (state.dragFolderEnter?.timer) {
    clearTimeout(state.dragFolderEnter.timer);
  }
  state.dragFolderEnter = null;
}

function scheduleDragFolderEnter(folderId) {
  if (!state.drag || state.drag.id === folderId || state.currentFolderId === folderId) return;
  if (state.dragFolderEnter?.folderId === folderId) return;

  cancelDragFolderEnter();
  const token = state.dragFolderEnterToken + 1;
  state.dragFolderEnterToken = token;
  state.dragFolderEnter = {
    folderId,
    timer: setTimeout(async () => {
      const shouldContinue = () => (
        state.dragFolderEnterToken === token &&
        Boolean(state.drag) &&
        state.drag.id !== folderId &&
        state.currentFolderId !== folderId
      );
      if (!shouldContinue()) return;
      clearDropMarkers();
      await enterFolder(folderId, false, shouldContinue);
      if (state.dragFolderEnterToken === token) {
        state.dragFolderEnter = null;
      }
    }, DRAG_FOLDER_ENTER_DELAY),
  };
}

function getNextDropTargetItem(item) {
  let next = item.nextElementSibling;
  while (next) {
    if (
      next.classList.contains('item') &&
      !next.classList.contains('virtual-root') &&
      !next.classList.contains('context-action') &&
      !next.classList.contains('back')
    ) {
      return next;
    }
    next = next.nextElementSibling;
  }
  return null;
}

function updateLocalMove(nodeId, sourceParentId, destinationParentId, index) {
  const sourceParent = state.nodesById.get(sourceParentId);
  const destinationParent = state.nodesById.get(destinationParentId);
  const node = state.nodesById.get(nodeId);
  if (!destinationParent?.children || !node) return;

  if (sourceParent?.children) {
    sourceParent.children = sortedByIndex(sourceParent.children).filter((child) => child.id !== nodeId);
    sourceParent.children.forEach((child, childIndex) => {
      child.index = childIndex;
      state.nodesById.set(child.id, child);
    });
    state.nodesById.set(sourceParentId, sourceParent);
  }

  const children = sortedByIndex(destinationParent.children).filter((child) => child.id !== nodeId);
  children.splice(index, 0, { ...node, parentId: destinationParentId, index });
  children.forEach((child, childIndex) => {
    child.index = childIndex;
    child.parentId = destinationParentId;
    state.nodesById.set(child.id, child);
  });
  destinationParent.children = children;
  state.nodesById.set(destinationParentId, destinationParent);
}

function moveDraggedItemInDom(dragId, targetItem, placeBefore) {
  let sourceItem = listEl.querySelector(`.item[data-node-id="${CSS.escape(dragId)}"]`);
  if (!sourceItem) {
    const node = state.nodesById.get(dragId);
    if (!node) return;
    sourceItem = createItem(node);
  }
  if (!targetItem || sourceItem === targetItem) return;
  if (placeBefore) {
    listEl.insertBefore(sourceItem, targetItem);
    return;
  }
  const nextItem = getNextDropTargetItem(targetItem);
  if (nextItem) {
    listEl.insertBefore(sourceItem, nextItem);
  } else {
    listEl.insertBefore(sourceItem, targetItem.nextSibling);
  }
}

function removeDraggedItemFromDom(dragId) {
  listEl.querySelector(`.item[data-node-id="${CSS.escape(dragId)}"]`)?.remove();
}

function updateFolderCounter(folderId) {
  const folder = state.nodesById.get(folderId);
  const row = listEl.querySelector(`.item[data-node-id="${CSS.escape(folderId)}"]`);
  const meta = row?.querySelector('.item-meta');
  if (folder?.children && meta) {
    meta.textContent = String(folder.children.length);
  }
}

function appendDraggedItemInDom(dragId) {
  const empty = listEl.querySelector(':scope > .empty');
  if (empty) empty.remove();

  let sourceItem = listEl.querySelector(`.item[data-node-id="${CSS.escape(dragId)}"]`);
  if (!sourceItem) {
    const node = state.nodesById.get(dragId);
    if (!node) return;
    sourceItem = createItem(node);
  }
  listEl.append(sourceItem);
}

function getDropIntent(node, item, clientY) {
  const rect = item.getBoundingClientRect();
  if (isFolder(node)) {
    const offset = clientY - rect.top;
    const edgeSize = rect.height * DROP_INTO_FOLDER_EDGE_RATIO;
    if (offset >= edgeSize && offset <= rect.height - edgeSize) {
      return { type: 'into' };
    }
  }
  return {
    type: 'reorder',
    placeBefore: clientY - rect.top < rect.height / 2,
  };
}

async function moveDragIntoFolder(folderId, drag = state.drag) {
  const dragId = drag?.id;
  const sourceFolderId = drag?.sourceFolderId;
  if (!dragId || !sourceFolderId) return false;

  const targetChildren = sortedByIndex(await api.getChildren(folderId));
  const requestedChildIndex = targetChildren.filter((child) => child.id !== dragId).length;

  removeDraggedItemFromDom(dragId);
  state.suppressNextBookmarkRefresh = true;
  const moved = await api.move(dragId, { parentId: folderId, index: requestedChildIndex });
  updateLocalMove(dragId, sourceFolderId, folderId, moved.index ?? requestedChildIndex);
  updateFolderCounter(folderId);
  if (state.drag) state.drag.sourceFolderId = folderId;
  return true;
}

async function moveDragRelativeToNode(targetNodeId, placeBefore, drag = state.drag) {
  const dragId = drag?.id;
  const sourceFolderId = drag?.sourceFolderId;
  if (!dragId || !sourceFolderId || dragId === targetNodeId) return false;

  const targetItem = listEl.querySelector(`.item[data-node-id="${CSS.escape(targetNodeId)}"]`);
  const children = sortedByIndex(await api.getChildren(state.currentFolderId));
  const targetIndex = children.findIndex((n) => n.id === targetNodeId);
  if (targetIndex < 0) return false;

  const requestedIndex = placeBefore ? targetIndex : targetIndex + 1;

  if (targetItem) {
    moveDraggedItemInDom(dragId, targetItem, placeBefore);
  }
  state.suppressNextBookmarkRefresh = true;
  const moved = await api.move(dragId, { parentId: state.currentFolderId, index: requestedIndex });
  updateLocalMove(dragId, sourceFolderId, state.currentFolderId, moved.index ?? requestedIndex);
  if (state.drag) state.drag.sourceFolderId = state.currentFolderId;
  return true;
}

async function moveDragToCurrentFolderEnd(drag = state.drag) {
  const dragId = drag?.id;
  const sourceFolderId = drag?.sourceFolderId;
  if (!dragId || !sourceFolderId) return false;

  const children = sortedByIndex(await api.getChildren(state.currentFolderId));
  const requestedIndex = children.filter((child) => child.id !== dragId).length;

  appendDraggedItemInDom(dragId);
  state.suppressNextBookmarkRefresh = true;
  const moved = await api.move(dragId, { parentId: state.currentFolderId, index: requestedIndex });
  updateLocalMove(dragId, sourceFolderId, state.currentFolderId, moved.index ?? requestedIndex);
  if (state.drag) state.drag.sourceFolderId = state.currentFolderId;
  return true;
}

async function performRememberedDrop(drag = state.drag) {
  const remembered = state.lastDropIntent;
  if (!drag || !remembered || remembered.folderId !== state.currentFolderId) return false;
  if (remembered.type === 'into') {
    return moveDragIntoFolder(remembered.targetNodeId, drag);
  }
  if (remembered.type === 'reorder') {
    return moveDragRelativeToNode(remembered.targetNodeId, remembered.placeBefore, drag);
  }
  return false;
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
    if (node.virtualType) item.classList.add(`virtual-${node.virtualType}`);
    item.draggable = false;
  }
  item.dataset.nodeId = node.id;
  item.dataset.source = source;
  item.querySelector('.item-title').textContent = node.title || (node.url || 'Untitled');
  const iconEl = item.querySelector('.item-icon');

  if (isFolder(node)) {
    const count = node.children?.length ?? 0;
    item.querySelector('.item-meta').textContent = String(count);
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
    if (virtualNode && !isFolder(node)) return;
    openContextMenu(ev.clientX, ev.clientY, node, { virtual: virtualNode });
  });

  item.addEventListener('dragstart', (ev) => {
    if (virtualNode) {
      ev.preventDefault();
      return;
    }
    clearLastDropIntent();
    state.drag = { id: node.id, sourceFolderId: state.currentFolderId };
    item.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', node.id);
    const rect = item.getBoundingClientRect();
    const dragImage = item.cloneNode(true);
    dragImage.classList.add('drag-image');
    dragImage.classList.remove('dragging', 'drop-before', 'drop-after', 'active');
    dragImage.removeAttribute('id');
    dragImage.style.width = `${rect.width}px`;
    dragImage.style.height = `${rect.height}px`;
    document.body.append(dragImage);
    ev.dataTransfer.setDragImage(
      dragImage,
      Math.max(0, Math.round(ev.clientX - rect.left)),
      Math.max(0, Math.round(ev.clientY - rect.top)),
    );
    requestAnimationFrame(() => dragImage.remove());
  });

  item.addEventListener('dragend', () => {
    cancelDragFolderEnter();
    state.drag = null;
    clearLastDropIntent();
    item.classList.remove('dragging');
    clearDropMarkers();
  });

  item.addEventListener('dragover', (ev) => {
    if (virtualNode) return;
    const nodeId = node?.id;
    if (!nodeId || !state.drag) return;
    ev.stopPropagation();
    if (state.drag.id === nodeId) {
      cancelDragFolderEnter();
      clearLastDropIntent();
      clearDropMarkers();
      return;
    }
    ev.preventDefault();
    clearDropMarkers();
    const intent = getDropIntent(node, item, ev.clientY);
    if (intent.type === 'into') {
      scheduleDragFolderEnter(node.id);
      state.lastDropIntent = { folderId: state.currentFolderId, type: 'into', targetNodeId: node.id };
    } else {
      cancelDragFolderEnter();
      state.lastDropIntent = {
        folderId: state.currentFolderId,
        type: 'reorder',
        targetNodeId: node.id,
        placeBefore: intent.placeBefore,
      };
    }
    if (intent.type === 'into') {
      item.classList.add('drop-into');
    } else if (intent.placeBefore) {
      item.classList.add('drop-before');
    } else {
      const nextItem = getNextDropTargetItem(item);
      if (nextItem) {
        nextItem.classList.add('drop-before');
      } else {
        item.classList.add('drop-after');
      }
    }
    ev.dataTransfer.dropEffect = 'move';
  });

  item.addEventListener('dragleave', () => {
    cancelDragFolderEnter();
    clearDropMarkers();
  });

  item.addEventListener('drop', async (ev) => {
    if (virtualNode) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelDragFolderEnter();
    clearLastDropIntent();
    clearDropMarkers();

    const nodeId = node?.id;
    const dragId = state.drag?.id;
    const sourceFolderId = state.drag?.sourceFolderId;
    if (!nodeId || !dragId || dragId === nodeId) return;

    const intent = getDropIntent(node, item, ev.clientY);
    if (intent.type === 'into') {
      await moveDragIntoFolder(node.id, { id: dragId, sourceFolderId });
      return;
    }

    await moveDragRelativeToNode(nodeId, intent.placeBefore, { id: dragId, sourceFolderId });
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
  item.querySelector('.item-icon').textContent = opts.checked ? '✓' : '';
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

function openContextMenu(_x, _y, node, opts = {}) {
  state.contextNodeId = node.id;
  listEl.innerHTML = '';

  const folder = isFolder(node);
  const virtualContext = Boolean(opts.virtual || isVirtualNode(node) || node.virtualType);
  const syntheticVirtualContext = virtualContext && isVirtualFolderId(node.id);
  const addEnabled = !virtualContext || (folder && !isVirtualFolderId(node.id));
  listEl.append(createContextBackItem(node), createSeparator());

  if (!folder) {
    listEl.append(createContextAction('Open in New Tab', () => api.createTab({ url: node.url, active: false }), { refresh: false }));
    listEl.append(createContextAction('Open in New Window', () => api.createWindow({ url: node.url }), { refresh: false }));
    listEl.append(createContextAction('Open in Incognito Window', () => api.createWindow({ url: node.url, incognito: true }), { refresh: false }));
    listEl.append(separator());
  } else {
    listEl.append(createContextAction('Open All', () => openAllInFolder(node.id, 'tab'), { refresh: false, closePopup: true, disabled: syntheticVirtualContext }));
    listEl.append(createContextAction('Open All in New Window', () => openAllInFolder(node.id, 'window'), { refresh: false, disabled: syntheticVirtualContext }));
    listEl.append(createContextAction('Open All in Incognito Window', () => openAllInFolder(node.id, 'incognito'), { refresh: false, disabled: syntheticVirtualContext }));
    listEl.append(separator());
  }

  listEl.append(createContextAction('Rename...', async () => {
    const title = prompt(folder ? 'Edit folder name:' : 'Edit bookmark name:', node.title || '');
    if (title === null) return;
    await api.update(node.id, { title });
  }, { disabled: virtualContext }));
  listEl.append(separator());

  listEl.append(createContextAction('Cut', async () => {
    state.clipboard = { id: node.id, mode: 'cut' };
  }, { refresh: false, disabled: virtualContext }));
  listEl.append(createContextAction('Copy', async () => {
    state.clipboard = { id: node.id, mode: 'copy' };
  }, { refresh: false, disabled: virtualContext }));

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
  }, { disabled: virtualContext || !canPaste }));
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
    disabled: virtualContext,
  }));
  listEl.append(separator());

  listEl.append(createContextAction('Add Page...', async () => {
    const title = prompt('Bookmark title:', 'New bookmark');
    if (!title) return;
    const url = prompt('Bookmark URL:', 'https://');
    if (!url) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title, url });
  }, { disabled: !addEnabled }));

  listEl.append(createContextAction('Add Folder...', async () => {
    const title = prompt('Folder name:', 'New folder');
    if (!title) return;
    const parentId = folder ? node.id : node.parentId;
    await api.create({ parentId, title });
  }, { disabled: !addEnabled }));
  listEl.append(separator());

  listEl.append(createContextAction(syntheticVirtualContext ? 'Open Bookmarks Manager' : 'Open in Bookmarks Manager', async () => {
    const url = syntheticVirtualContext ? getBookmarkManagerUrl() : getBookmarkManagerNodeUrl(node);
    await api.createTab({ url, active: true });
  }, { refresh: false, closePopup: true }));
  listEl.append(createContextAction('Show Other Bookmarks', async () => {
    await setSetting('showOtherBookmarks', !state.settings.showOtherBookmarks);
  }, { checked: state.settings.showOtherBookmarks }));
  listEl.append(createContextAction('Show Mobile Bookmarks', async () => {
    await setSetting('showMobileBookmarks', !state.settings.showMobileBookmarks);
  }, { checked: state.settings.showMobileBookmarks }));
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
    renderList(folder?.children || []).catch(() => {});
    return;
  }
  const folder = state.nodesById.get(state.currentFolderId);
  renderList(folder?.children || []).catch(() => {});
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

listEl.addEventListener('dragover', (ev) => {
  if (!state.drag || isVirtualFolderId(state.currentFolderId)) return;
  ev.preventDefault();
  cancelDragFolderEnter();
  ev.dataTransfer.dropEffect = 'move';
});

listEl.addEventListener('drop', async (ev) => {
  if (!state.drag || isVirtualFolderId(state.currentFolderId)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const dragSnapshot = { ...state.drag };
  cancelDragFolderEnter();
  clearDropMarkers();

  if (await performRememberedDrop(dragSnapshot)) {
    clearLastDropIntent();
    return;
  }

  await moveDragToCurrentFolderEnd(dragSnapshot);
  clearLastDropIntent();
});

document.addEventListener('dragover', (ev) => {
  if (!state.drag || isVirtualFolderId(state.currentFolderId)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', async (ev) => {
  if (!state.drag || isVirtualFolderId(state.currentFolderId)) return;
  ev.preventDefault();
  const dragSnapshot = { ...state.drag };
  cancelDragFolderEnter();
  clearDropMarkers();
  if (await performRememberedDrop(dragSnapshot)) {
    clearLastDropIntent();
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
  if (state.suppressNextBookmarkRefresh) {
    state.suppressNextBookmarkRefresh = false;
    return;
  }
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
    settings: { ...state.settings },
  }),
  renderNodes: async (nodes) => {
    await renderList(nodes);
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

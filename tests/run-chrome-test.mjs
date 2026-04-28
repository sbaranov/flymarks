import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const EXT_DIR = path.resolve(process.cwd());
const BROWSER_BIN = process.env.BROWSER_BIN ||
  '/Users/stas/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const HEADLESS = process.env.HEADLESS !== '0';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForJson(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class Cdp {
  constructor(wsUrl) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is unavailable. Run with: node --experimental-websocket tests/run-chrome-test.mjs');
    }
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async eval(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

function must(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

async function resolveExtensionIdFromProfile(profileDir, extDir, timeoutMs = 15000) {
  const prefFile = path.join(profileDir, 'Default', 'Preferences');
  const start = Date.now();
  const extPattern = new RegExp(`^${escapeRegExp(path.resolve(extDir))}/?$`);
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = fs.readFileSync(prefFile, 'utf8');
      const prefs = JSON.parse(raw);
      const settings = prefs?.extensions?.settings || {};
      for (const [id, meta] of Object.entries(settings)) {
        if (typeof meta?.path === 'string' && extPattern.test(path.resolve(meta.path))) {
          return id;
        }
      }
    } catch {
      // retry until profile/preferences are ready
    }
    await sleep(200);
  }
  throw new Error('Could not resolve extension id from profile Preferences.');
}

async function resolveExtensionIdFromTargets(cdp, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find((t) =>
      t.type === 'service_worker' &&
      t.url.startsWith('chrome-extension://') &&
      t.url.endsWith('/background.js'),
    );
    if (worker) {
      return worker.url.split('/')[2];
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const debugPort = await getFreePort();
  if (!fs.existsSync(BROWSER_BIN)) {
    throw new Error(`Chrome for Testing was not found at ${BROWSER_BIN}`);
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-ext-'));
  const chrome = spawn(
    BROWSER_BIN,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--disable-sync',
      '--disable-background-networking',
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      ...(HEADLESS ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const browserLogs = [];
  const keepLog = (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    browserLogs.push(...text.split('\n').filter(Boolean));
    if (browserLogs.length > 200) {
      browserLogs.splice(0, browserLogs.length - 200);
    }
  };
  chrome.stdout.on('data', keepLog);
  chrome.stderr.on('data', keepLog);

  let cdp;
  try {
    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready();

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    let extensionId = await resolveExtensionIdFromTargets(cdp, 7000);
    if (!extensionId) {
      extensionId = await resolveExtensionIdFromProfile(profileDir, EXT_DIR);
    }
    must(extensionId, 'Could not resolve extension id from targets or profile.');

    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const { targetId } = await cdp.send('Target.createTarget', { url: popupUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);

    const fixture = await cdp.eval(
      sessionId,
      `
      (async () => {
        const suffix = Date.now().toString(36);
        const names = {
          folder: 'CodexExtTest Folder ' + suffix,
          emptyFolder: 'CodexExtTest Empty Folder ' + suffix,
          child: 'CodexExtTest Child ' + suffix,
          a: 'CodexExtTest A ' + suffix,
          b: 'CodexExtTest B ' + suffix,
          c: 'CodexExtTest C ' + suffix,
        };

        const [treeRoot] = await chrome.bookmarks.getTree();
        const bar = (treeRoot.children || []).find((n) => n.id === '1') || treeRoot.children[0];
        const topLevelVirtuals = (treeRoot.children || [])
          .filter((n) => (
            n.id !== bar.id &&
            (n.id === '2' || n.id === '3' || /^(other|mobile) bookmarks$/i.test(n.title || ''))
          ))
          .map((n) => ({ id: n.id, title: n.title }));
        const existing = await chrome.bookmarks.search('CodexExtTest ');
        for (const node of existing) {
          try {
            if (node.url) await chrome.bookmarks.remove(node.id);
            else await chrome.bookmarks.removeTree(node.id);
          } catch {}
        }

        const folder = await chrome.bookmarks.create({ parentId: bar.id, title: names.folder });
        await chrome.bookmarks.create({ parentId: folder.id, title: names.child, url: 'https://example.com/child' });
        const emptyFolder = await chrome.bookmarks.create({ parentId: bar.id, title: names.emptyFolder });
        const a = await chrome.bookmarks.create({ parentId: bar.id, title: names.a, url: 'https://example.com/a' });
        const b = await chrome.bookmarks.create({ parentId: bar.id, title: names.b, url: 'https://example.com/b' });
        const c = await chrome.bookmarks.create({ parentId: bar.id, title: names.c, url: 'https://example.com/c' });

        return { names, ids: { folder: folder.id, emptyFolder: emptyFolder.id, a: a.id, b: b.id, c: c.id }, topLevelVirtuals };
      })();
      `,
    );

    await cdp.eval(
      sessionId,
      `
      (async () => {
        for (let i = 0; i < 50; i++) {
          if (window.__popupTest?.refreshCurrent) {
            await window.__popupTest.refreshCurrent();
            return true;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })();
      `,
    );

    const listRendered = await cdp.eval(
      sessionId,
      `
      (async () => {
        const wanted = [
          ${JSON.stringify(fixture.names.folder)},
          ${JSON.stringify(fixture.names.emptyFolder)},
          ${JSON.stringify(fixture.names.a)},
          ${JSON.stringify(fixture.names.b)},
          ${JSON.stringify(fixture.names.c)},
        ];
        for (let i = 0; i < 30; i++) {
          const ok = wanted.every((text) =>
            [...document.querySelectorAll('.item-title')].some((el) => el.textContent.includes(text))
          );
          if (ok) return true;
          await window.__popupTest?.refreshCurrent?.();
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })();
      `,
    );
    must(listRendered, 'Bookmark list did not render expected test entries.');

    const emptyFolderCounter = await cdp.eval(
      sessionId,
      `
      (() => {
        const row = [...document.querySelectorAll('#bookmark-list > .item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(${JSON.stringify(fixture.names.emptyFolder)})
        );
        return {
          found: Boolean(row),
          isFolder: row?.classList.contains('folder') || false,
          meta: row?.querySelector('.item-meta')?.textContent.trim() || '',
        };
      })();
      `,
    );
    must(
      emptyFolderCounter.found &&
        emptyFolderCounter.isFolder &&
        emptyFolderCounter.meta === '0',
      `Empty folder did not show a 0 counter: ${JSON.stringify(emptyFolderCounter)}`,
    );

    const rootNavigation = await cdp.eval(
      sessionId,
      `
      (async () => {
        const toolbarGone = !document.querySelector('.toolbar') &&
          !document.querySelector('#back-btn') &&
          !document.querySelector('#refresh-btn');

        const virtualTitles = ${JSON.stringify(['Apps', 'Tab Groups', ...fixture.topLevelVirtuals.map((n) => n.title)])};
        const rowTitles = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
          .map((el) => el.textContent.trim());
        const virtualsFirst = virtualTitles.every((title, index) => rowTitles[index] === title);

        const appsShortcut = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Apps');
        const appsCounter = appsShortcut?.querySelector('.item-meta')?.textContent.trim() || '';
        const appsIconClass = appsShortcut?.classList.contains('virtual-apps') || false;
        const orig = { create: chrome.tabs.create, close: window.close };
        const appsCalls = { create: null, closeCount: 0 };
        chrome.tabs.create = async (payload) => {
          appsCalls.create = payload;
          return { id: 777, ...payload };
        };
        window.close = () => { appsCalls.closeCount += 1; };
        appsShortcut?.click();
        await new Promise((r) => setTimeout(r, 80));
        chrome.tabs.create = orig.create;
        window.close = orig.close;

        const tabGroupsVirtual = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Tab Groups');
        const tabGroupsIconClass = tabGroupsVirtual?.classList.contains('virtual-tab-groups-root') || false;
        const otherBookmarks = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Other Bookmarks');
        const mobileBookmarks = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Mobile Bookmarks');
        const otherIconClass = otherBookmarks?.classList.contains('virtual-other-bookmarks') || false;
        const mobileIconClass = mobileBookmarks?.classList.contains('virtual-mobile-bookmarks') || false;
        tabGroupsVirtual.click();
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('#bookmark-list > .item.back')) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        const enteredVirtual = window.__popupTest.getState().currentFolderId === 'virtual:tab-groups';
        const virtualBackLabel = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim();
        const virtualEmptyText = document.querySelector('#bookmark-list > .empty')?.textContent.trim() || '';

        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        const backWorks = window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId &&
          !document.querySelector('#bookmark-list > .item.back');

        return {
          toolbarGone,
          virtualsFirst,
          appsCounter,
          appsIconClass,
          tabGroupsIconClass,
          otherIconClass,
          mobileIconClass,
          appsCalls,
          enteredVirtual,
          virtualBackLabel,
          virtualEmptyText,
          backWorks,
        };
      })();
      `,
    );
    const hasMobileBookmarksRoot = fixture.topLevelVirtuals.some((n) => n.title === 'Mobile Bookmarks');
    must(rootNavigation.toolbarGone, 'Popup toolbar/header is still rendered.');
    must(rootNavigation.virtualsFirst, `Virtual root folders were not rendered first: ${JSON.stringify(rootNavigation)}`);
    must(
      rootNavigation.appsCounter === '' &&
      rootNavigation.appsIconClass &&
      rootNavigation.tabGroupsIconClass &&
      rootNavigation.otherIconClass &&
      (!hasMobileBookmarksRoot || rootNavigation.mobileIconClass) &&
      rootNavigation.appsCalls.create?.url === 'chrome://apps/' &&
        rootNavigation.appsCalls.create?.active === true &&
        rootNavigation.appsCalls.closeCount > 0,
      `Apps did not open chrome://apps/: ${JSON.stringify(rootNavigation)}`,
    );
    must(rootNavigation.enteredVirtual !== false, `Virtual root folder did not open: ${JSON.stringify(rootNavigation)}`);
    must(
      rootNavigation.virtualBackLabel === 'Tab Groups',
      `Back row did not show current folder title: ${JSON.stringify(rootNavigation)}`,
    );
    must(
      rootNavigation.virtualEmptyText === 'No tab groups',
      `Empty Tab Groups folder did not show relevant text: ${JSON.stringify(rootNavigation)}`,
    );
    must(rootNavigation.backWorks, `Back row did not return to Bookmarks Bar root: ${JSON.stringify(rootNavigation)}`);

    const virtualFolderContextMenu = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const appsRow = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Apps'
        );
        appsRow?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 80,
          button: 2,
        }));
        await new Promise((r) => setTimeout(r, 80));

        const actions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((row) => ({
          label: row.querySelector('.item-title')?.textContent.trim(),
          disabled: row.classList.contains('disabled'),
        }));
        const byLabel = Object.fromEntries(actions.map((action) => [action.label, action]));
        const disabledThroughDelete = [
          'Open All',
          'Open All in New Window',
          'Open All in Incognito Window',
          'Open All in New Tab Group',
          'Rename...',
          'Cut',
          'Copy',
          'Paste',
          'Delete',
        ].every((label) => byLabel[label]?.disabled === true);
        const globalActionsEnabled = [
          'Open Bookmarks Manager',
          'Show Apps Shortcut',
          'Show Tab Groups',
          'Show Other Bookmarks',
          'Show Mobile Bookmarks',
        ].every((label) => byLabel[label]?.disabled === false);
        const addActionsDisabled = byLabel['Add Page...']?.disabled === true &&
          byLabel['Add Folder...']?.disabled === true;

        return {
          foundAppsRow: Boolean(appsRow),
          contextOpen: window.__popupTest.getState().contextOpen,
          separateOverlay: Boolean(document.querySelector('#context-menu')),
          actions,
          disabledThroughDelete,
          addActionsDisabled,
          globalActionsEnabled,
        };
      })();
      `,
    );
    must(
      virtualFolderContextMenu.foundAppsRow &&
        virtualFolderContextMenu.contextOpen &&
        !virtualFolderContextMenu.separateOverlay &&
        virtualFolderContextMenu.disabledThroughDelete &&
        virtualFolderContextMenu.addActionsDisabled &&
        virtualFolderContextMenu.globalActionsEnabled,
      `Virtual folder context menu mismatch: ${JSON.stringify(virtualFolderContextMenu)}`,
    );

    const realVirtualFolderOpenOptions = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const row = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((el) =>
          ['Other Bookmarks', 'Mobile Bookmarks'].includes(el.querySelector('.item-title')?.textContent.trim())
        );
        row?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 80,
          button: 2,
        }));
        await new Promise((r) => setTimeout(r, 80));
        const actions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((action) => ({
          label: action.querySelector('.item-title')?.textContent.trim(),
          disabled: action.classList.contains('disabled'),
        }));
        const byLabel = Object.fromEntries(actions.map((action) => [action.label, action]));
        const openOptionsEnabled = [
          'Open All',
          'Open All in New Window',
          'Open All in Incognito Window',
          'Open All in New Tab Group',
        ].every((label) => byLabel[label]?.disabled === false);

        return {
          foundRow: Boolean(row),
          title: row?.querySelector('.item-title')?.textContent.trim() || '',
          actions,
          openOptionsEnabled,
        };
      })();
      `,
    );
    must(
      realVirtualFolderOpenOptions.foundRow &&
        realVirtualFolderOpenOptions.openOptionsEnabled,
      `Other/Mobile Bookmarks virtual folder open options were disabled: ${JSON.stringify(realVirtualFolderOpenOptions)}`,
    );

    const virtualSettingToggles = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();

        const titles = () => [...document.querySelectorAll('#bookmark-list > .item .item-title')]
          .map((el) => el.textContent.trim());
        const clickToggle = async (label) => {
          const list = document.querySelector('#bookmark-list');
          list.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 40,
            button: 2,
          }));
          await new Promise((r) => setTimeout(r, 80));
          const action = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((row) =>
            row.querySelector('.item-title')?.textContent.trim() === label
          );
          const iconBefore = action?.querySelector('.item-icon')?.textContent.trim() || '';
          action?.click();
          await new Promise((r) => setTimeout(r, 120));
          return {
            found: Boolean(action),
            iconBefore,
            state: window.__popupTest.getState().settings,
            titles: titles(),
          };
        };

        const initial = { state: window.__popupTest.getState().settings, titles: titles() };
        const appsOff = await clickToggle('Show Apps Shortcut');
        const tabsOff = await clickToggle('Show Tab Groups');
        const otherOff = await clickToggle('Show Other Bookmarks');
        const mobileOff = await clickToggle('Show Mobile Bookmarks');
        const appsOn = await clickToggle('Show Apps Shortcut');
        const tabsOn = await clickToggle('Show Tab Groups');
        const otherOn = await clickToggle('Show Other Bookmarks');
        const mobileOn = await clickToggle('Show Mobile Bookmarks');

        return { initial, appsOff, tabsOff, otherOff, mobileOff, appsOn, tabsOn, otherOn, mobileOn };
      })();
      `,
    );
    must(
      virtualSettingToggles.initial.state.showAppsShortcut === true &&
        virtualSettingToggles.initial.state.showTabGroups === true &&
        virtualSettingToggles.initial.state.showOtherBookmarks === true &&
        virtualSettingToggles.initial.state.showMobileBookmarks === true &&
        virtualSettingToggles.initial.titles.includes('Apps') &&
        virtualSettingToggles.initial.titles.includes('Tab Groups') &&
        virtualSettingToggles.initial.titles.includes('Other Bookmarks') &&
        (!hasMobileBookmarksRoot || virtualSettingToggles.initial.titles.includes('Mobile Bookmarks')) &&
        virtualSettingToggles.appsOff.found &&
        virtualSettingToggles.appsOff.iconBefore === '✓' &&
        virtualSettingToggles.appsOff.state.showAppsShortcut === false &&
        !virtualSettingToggles.appsOff.titles.includes('Apps') &&
        virtualSettingToggles.tabsOff.found &&
        virtualSettingToggles.tabsOff.iconBefore === '✓' &&
        virtualSettingToggles.tabsOff.state.showTabGroups === false &&
        !virtualSettingToggles.tabsOff.titles.includes('Tab Groups') &&
        virtualSettingToggles.otherOff.found &&
        virtualSettingToggles.otherOff.iconBefore === '✓' &&
        virtualSettingToggles.otherOff.state.showOtherBookmarks === false &&
        !virtualSettingToggles.otherOff.titles.includes('Other Bookmarks') &&
        virtualSettingToggles.mobileOff.found &&
        virtualSettingToggles.mobileOff.iconBefore === '✓' &&
        virtualSettingToggles.mobileOff.state.showMobileBookmarks === false &&
        (!hasMobileBookmarksRoot || !virtualSettingToggles.mobileOff.titles.includes('Mobile Bookmarks')) &&
        virtualSettingToggles.appsOn.found &&
        virtualSettingToggles.appsOn.iconBefore === '' &&
        virtualSettingToggles.appsOn.state.showAppsShortcut === true &&
        virtualSettingToggles.appsOn.titles.includes('Apps') &&
        virtualSettingToggles.tabsOn.found &&
        virtualSettingToggles.tabsOn.iconBefore === '' &&
        virtualSettingToggles.tabsOn.state.showTabGroups === true &&
        virtualSettingToggles.tabsOn.titles.includes('Tab Groups') &&
        virtualSettingToggles.otherOn.found &&
        virtualSettingToggles.otherOn.iconBefore === '' &&
        virtualSettingToggles.otherOn.state.showOtherBookmarks === true &&
        virtualSettingToggles.otherOn.titles.includes('Other Bookmarks') &&
        virtualSettingToggles.mobileOn.found &&
        virtualSettingToggles.mobileOn.iconBefore === '' &&
        virtualSettingToggles.mobileOn.state.showMobileBookmarks === true &&
        (!hasMobileBookmarksRoot || virtualSettingToggles.mobileOn.titles.includes('Mobile Bookmarks')),
      `Virtual root settings did not toggle correctly: ${JSON.stringify(virtualSettingToggles)}`,
    );

    const tabGroupsVirtualFolder = await cdp.eval(
      sessionId,
      `
      (async () => {
        const firstTab = await chrome.tabs.create({ url: 'https://example.com/#codex-tab-group-a', active: false });
        const secondTab = await chrome.tabs.create({ url: 'https://example.com/#codex-tab-group-b', active: false });
        const groupId = await chrome.tabs.group({ tabIds: [firstTab.id, secondTab.id] });
        await chrome.tabGroups.update(groupId, { title: 'Codex Test Group' });
        await window.__popupTest.refreshCurrent();

        const tabGroupsRow = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Tab Groups'
        );
        const rootCounter = tabGroupsRow?.querySelector('.item-meta')?.textContent.trim();
        tabGroupsRow?.click();
        for (let i = 0; i < 20; i++) {
          const found = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
            .some((el) => el.textContent.trim() === 'Codex Test Group');
          if (found) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const groupVisible = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
          .some((el) => el.textContent.trim() === 'Codex Test Group');
        const groupRow = [...document.querySelectorAll('#bookmark-list > .item')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Codex Test Group'
        );
        const groupCounter = groupRow?.querySelector('.item-meta')?.textContent.trim();
        if (groupRow) {
          groupRow.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: 120,
            button: 2,
          }));
          await new Promise((r) => setTimeout(r, 80));
        }
        const renameAction = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Rename...'
        );
        const origRename = { prompt: window.prompt, update: chrome.bookmarks.update, updateGroup: chrome.tabGroups.update };
        const renameCalls = { prompt: null, bookmarkUpdate: null, tabGroupUpdate: null };
        window.prompt = (message, defaultValue) => {
          renameCalls.prompt = { message, defaultValue };
          return 'Renamed Codex Test Group';
        };
        chrome.bookmarks.update = async (id, changes) => {
          renameCalls.bookmarkUpdate = { id, changes };
          return { id, ...changes };
        };
        chrome.tabGroups.update = async (id, changes) => {
          renameCalls.tabGroupUpdate = { id, changes };
          return origRename.updateGroup(id, changes);
        };
        renameAction?.click();
        await new Promise((r) => setTimeout(r, 120));
        window.prompt = origRename.prompt;
        chrome.bookmarks.update = origRename.update;
        chrome.tabGroups.update = origRename.updateGroup;

        await window.__popupTest.refreshCurrent();
        const renamedGroupVisible = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
          .some((el) => el.textContent.trim() === 'Renamed Codex Test Group');
        const renamedGroupRow = [...document.querySelectorAll('#bookmark-list > .item')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Renamed Codex Test Group'
        );
        const renamedGroupCounter = renamedGroupRow?.querySelector('.item-meta')?.textContent.trim();
        renamedGroupRow?.click();
        for (let i = 0; i < 20; i++) {
          const found = [...document.querySelectorAll('#bookmark-list > .item.bookmark')].length >= 2;
          if (found) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const backLabel = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim();
        const tabRows = [...document.querySelectorAll('#bookmark-list > .item.bookmark')];
        const tabVisible = tabRows.length >= 2;

        const orig = { update: chrome.tabs.update, close: window.close };
        const calls = { update: null, closeCount: 0 };
        chrome.tabs.update = async (id, payload) => {
          calls.update = { id, payload };
          return { id, ...payload };
        };
        window.close = () => { calls.closeCount += 1; };
        tabRows[0]?.click();
        await new Promise((r) => setTimeout(r, 80));
        chrome.tabs.update = orig.update;
        window.close = orig.close;

        document.querySelector('#bookmark-list > .item.back')?.click();
        await new Promise((r) => setTimeout(r, 80));
        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          groupId,
          rootCounter,
          groupVisible,
          groupCounter,
          renameActionFound: Boolean(renameAction),
          renameActionDisabled: renameAction?.classList.contains('disabled') ?? null,
          renameCalls,
          renamedGroupVisible,
          renamedGroupCounter,
          backLabel,
          tabVisible,
          calls,
          returnedToRoot: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      tabGroupsVirtualFolder.groupVisible &&
        Number(tabGroupsVirtualFolder.rootCounter) >= 1 &&
        tabGroupsVirtualFolder.groupCounter === '2' &&
        tabGroupsVirtualFolder.renameActionFound &&
        tabGroupsVirtualFolder.renameActionDisabled === false &&
        tabGroupsVirtualFolder.renameCalls.prompt?.message === 'Edit folder name:' &&
        tabGroupsVirtualFolder.renameCalls.prompt?.defaultValue === 'Codex Test Group' &&
        tabGroupsVirtualFolder.renameCalls.bookmarkUpdate === null &&
        tabGroupsVirtualFolder.renameCalls.tabGroupUpdate?.id === tabGroupsVirtualFolder.groupId &&
        tabGroupsVirtualFolder.renameCalls.tabGroupUpdate?.changes?.title === 'Renamed Codex Test Group' &&
        tabGroupsVirtualFolder.renamedGroupVisible &&
        tabGroupsVirtualFolder.renamedGroupCounter === '2' &&
        tabGroupsVirtualFolder.backLabel === 'Renamed Codex Test Group' &&
        tabGroupsVirtualFolder.tabVisible &&
        tabGroupsVirtualFolder.calls.update?.payload?.active === true &&
        tabGroupsVirtualFolder.calls.closeCount > 0 &&
        tabGroupsVirtualFolder.returnedToRoot,
      `Tab Groups virtual folder did not navigate groups/tabs correctly: ${JSON.stringify(tabGroupsVirtualFolder)}`,
    );

    const unnamedTabGroupRenameDefault = await cdp.eval(
      sessionId,
      `
      (async () => {
        const tab = await chrome.tabs.create({ url: 'https://example.com/#codex-unnamed-tab-group', active: false });
        const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, { title: '' });
        await window.__popupTest.refreshCurrent();

        const tabGroupsRow = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Tab Groups'
        );
        if (!tabGroupsRow) {
          return { groupId, foundTabGroupsRow: false };
        }
        tabGroupsRow.click();
        for (let i = 0; i < 20; i++) {
          const found = [...document.querySelectorAll('#bookmark-list > .item')]
            .some((row) => row.dataset.nodeId === 'virtual:tab-group:' + groupId);
          if (found) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const unnamedRow = [...document.querySelectorAll('#bookmark-list > .item')].find((row) =>
          row.dataset.nodeId === 'virtual:tab-group:' + groupId
        );
        const displayTitle = unnamedRow?.querySelector('.item-title')?.textContent.trim() || '';
        if (!unnamedRow) {
          return {
            groupId,
            foundTabGroupsRow: true,
            foundUnnamedRow: false,
            rows: [...document.querySelectorAll('#bookmark-list > .item')].map((row) => ({
              nodeId: row.dataset.nodeId || '',
              title: row.querySelector('.item-title')?.textContent.trim() || '',
            })),
          };
        }
        unnamedRow.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));
        await new Promise((r) => setTimeout(r, 80));
        const renameAction = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((row) =>
          row.querySelector('.item-title')?.textContent.trim() === 'Rename...'
        );

        const origPrompt = window.prompt;
        const promptCall = { message: null, defaultValue: null };
        window.prompt = (message, defaultValue) => {
          promptCall.message = message;
          promptCall.defaultValue = defaultValue;
          return null;
        };
        renameAction?.click();
        await new Promise((r) => setTimeout(r, 80));
        window.prompt = origPrompt;

        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          groupId,
          displayTitle,
          renameActionFound: Boolean(renameAction),
          renameActionDisabled: renameAction?.classList.contains('disabled') ?? null,
          promptCall,
          returnedToRoot: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      unnamedTabGroupRenameDefault.displayTitle === 'Unnamed Group' &&
        unnamedTabGroupRenameDefault.renameActionFound &&
        unnamedTabGroupRenameDefault.renameActionDisabled === false &&
        unnamedTabGroupRenameDefault.promptCall.message === 'Edit folder name:' &&
        unnamedTabGroupRenameDefault.promptCall.defaultValue === '' &&
        unnamedTabGroupRenameDefault.returnedToRoot,
      `Unnamed tab group rename prompt did not preserve empty title: ${JSON.stringify(unnamedTabGroupRenameDefault)}`,
    );

    const malformedNodesHandled = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.renderNodes([
          null,
          { id: 'null-url', title: 'Null URL', url: null, index: 0 },
          { id: 'empty-url', title: 'Empty URL', url: '', index: 1 },
          { id: 'good-url', title: 'Good URL', url: 'https://example.com/good', index: 2 },
        ]);

        const rows = [...document.querySelectorAll('.item')];
        const nullUrl = rows.find((row) => row.querySelector('.item-title')?.textContent === 'Null URL');
        const emptyUrl = rows.find((row) => row.querySelector('.item-title')?.textContent === 'Empty URL');
        const goodUrl = rows.find((row) => row.querySelector('.item-title')?.textContent === 'Good URL');
        const ok = nullUrl?.classList.contains('folder') &&
          emptyUrl?.classList.contains('folder') &&
          goodUrl?.classList.contains('bookmark');

        await window.__popupTest.refreshCurrent();
        return Boolean(ok);
      })();
      `,
    );
    must(malformedNodesHandled, 'Malformed bookmark nodes were not rendered safely.');

    const popupWidthSizing = await cdp.eval(
      sessionId,
      `
      (async () => {
        const width = () => Math.round(document.documentElement.getBoundingClientRect().width);

        await window.__popupTest.renderNodes([
          { id: 'short-url', title: 'Short', url: 'https://example.com/short', index: 0 },
        ]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const shortWidth = width();

        await window.__popupTest.renderNodes([
          {
            id: 'long-url',
            title: 'CodexExtTest Extremely long bookmark title that should widen the popup until the configured maximum width',
            url: 'https://example.com/long',
            index: 0,
          },
        ]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const longWidth = width();

        await window.__popupTest.refreshCurrent();
        return { shortWidth, longWidth };
      })();
      `,
    );
    must(
      popupWidthSizing.shortWidth >= 260 && popupWidthSizing.shortWidth < 360,
      `Popup did not shrink for short content: ${JSON.stringify(popupWidthSizing)}`,
    );
    must(
      popupWidthSizing.longWidth > popupWidthSizing.shortWidth && popupWidthSizing.longWidth <= 560,
      `Popup did not expand within max width for long content: ${JSON.stringify(popupWidthSizing)}`,
    );

    const clickBehavior = await cdp.eval(
      sessionId,
      `
      (async () => {
        const targetText = ${JSON.stringify(fixture.names.a)};
        const row = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(targetText)
        );
        const orig = {
          query: chrome.tabs.query,
          update: chrome.tabs.update,
          create: chrome.tabs.create,
          close: window.close,
        };

        const calls = { updateUrl: null, createUrl: null, closeCount: 0 };
        chrome.tabs.query = async () => [{ id: 999 }];
        chrome.tabs.update = async (_id, payload) => { calls.updateUrl = payload.url; return {}; };
        chrome.tabs.create = async (payload) => { calls.createUrl = payload.url; return {}; };
        window.close = () => { calls.closeCount += 1; };

        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const normal = { ...calls };

        calls.updateUrl = null;
        calls.createUrl = null;
        calls.closeCount = 0;
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
        await new Promise((r) => setTimeout(r, 80));
        const meta = { ...calls };

        chrome.tabs.query = orig.query;
        chrome.tabs.update = orig.update;
        chrome.tabs.create = orig.create;
        window.close = orig.close;
        return { normal, meta };
      })();
      `,
    );
    must(
      clickBehavior.normal.updateUrl === 'https://example.com/a' &&
      clickBehavior.normal.createUrl === null &&
      clickBehavior.normal.closeCount > 0,
      `Normal click behavior mismatch: ${JSON.stringify(clickBehavior.normal)}`,
    );
    must(
      clickBehavior.meta.createUrl === 'https://example.com/a' &&
      clickBehavior.meta.updateUrl === null &&
      clickBehavior.meta.closeCount === 0,
      `Meta-click behavior mismatch: ${JSON.stringify(clickBehavior.meta)}`,
    );

    const renameBookmark = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const targetText = ${JSON.stringify(fixture.names.a)};
        const row = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(targetText)
        );

        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const renameBtn = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((el) =>
          el.textContent.trim() === 'Rename...'
        );
        if (!renameBtn) return { opened: false, hasRename: false };

        const orig = {
          prompt: window.prompt,
          update: chrome.bookmarks.update,
          create: chrome.tabs.create,
          close: window.close,
        };
        const calls = { prompts: [], update: null, create: null, closeCount: 0 };
        window.prompt = (message, defaultValue) => {
          calls.prompts.push({ message, defaultValue });
          return 'Renamed by test';
        };
        chrome.bookmarks.update = async (id, changes) => {
          calls.update = { id, changes };
          return { id, ...changes };
        };
        chrome.tabs.create = async (payload) => {
          calls.create = payload;
          return { id: 888, ...payload };
        };
        window.close = () => { calls.closeCount += 1; };

        renameBtn.click();
        await new Promise((r) => setTimeout(r, 80));

        window.prompt = orig.prompt;
        chrome.bookmarks.update = orig.update;
        chrome.tabs.create = orig.create;
        window.close = orig.close;

        return {
          opened: true,
          calls,
          contextOpen: window.__popupTest.getState().contextOpen,
        };
      })();
      `,
    );
    must(
      renameBookmark.opened &&
        renameBookmark.calls.prompts?.length === 1 &&
        renameBookmark.calls.prompts?.[0]?.message === 'Edit bookmark name:' &&
        renameBookmark.calls.prompts?.[0]?.defaultValue === fixture.names.a &&
        renameBookmark.calls.update?.id === fixture.ids.a &&
        renameBookmark.calls.update?.changes?.title === 'Renamed by test' &&
        !('url' in (renameBookmark.calls.update?.changes || {})) &&
        renameBookmark.calls.create === null &&
        renameBookmark.calls.closeCount === 0 &&
        !renameBookmark.contextOpen,
      `Rename did not update only the selected bookmark title locally: ${JSON.stringify(renameBookmark)}`,
    );

    const openBookmarksManager = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const targetText = ${JSON.stringify(fixture.names.a)};
        const row = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(targetText)
        );

        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const managerBtn = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((el) =>
          el.textContent.trim() === 'Open in Bookmarks Manager'
        );
        if (!managerBtn) return { opened: false, hasManager: false };

        const orig = {
          create: chrome.tabs.create,
          close: window.close,
        };
        const calls = { create: null, closeCount: 0 };
        chrome.tabs.create = async (payload) => {
          calls.create = payload;
          return { id: 888, ...payload };
        };
        window.close = () => { calls.closeCount += 1; };

        managerBtn.click();
        await new Promise((r) => setTimeout(r, 80));

        chrome.tabs.create = orig.create;
        window.close = orig.close;

        return {
          opened: true,
          calls,
          contextOpen: window.__popupTest.getState().contextOpen,
        };
      })();
      `,
    );
    const expectedBookmarkEditUrl = new URL('chrome://bookmarks/');
    expectedBookmarkEditUrl.searchParams.set('q', 'https://example.com/a');
    must(
      openBookmarksManager.opened &&
        openBookmarksManager.calls.create?.url === expectedBookmarkEditUrl.toString() &&
        openBookmarksManager.calls.create?.active === true &&
        openBookmarksManager.calls.closeCount > 0 &&
        !openBookmarksManager.contextOpen,
      `Open in Bookmarks Manager did not open Bookmark Manager for the selected node: ${JSON.stringify(openBookmarksManager)}`,
    );

    const openAllInTabGroup = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const folderText = ${JSON.stringify(fixture.names.folder)};
        const folderRow = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(folderText)
        );

        folderRow.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const actionLabels = [...document.querySelectorAll('#bookmark-list > .item.context-action .item-title')]
          .map((el) => el.textContent.trim());
        const groupBtn = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((el) =>
          el.textContent.trim() === 'Open All in New Tab Group'
        );
        if (!groupBtn) return { ok: false, actionLabels };

        const orig = {
          create: chrome.tabs.create,
          group: chrome.tabs.group,
          update: chrome.tabs.update,
          tabGroupUpdate: chrome.tabGroups.update,
          close: window.close,
        };
        const calls = { created: [], grouped: null, groupUpdate: null, activated: null, closeCount: 0 };
        chrome.tabs.create = async (payload) => {
          const tab = { id: 700 + calls.created.length, ...payload };
          calls.created.push(payload);
          return tab;
        };
        chrome.tabs.group = async (payload) => {
          calls.grouped = payload;
          return 321;
        };
        chrome.tabGroups.update = async (id, payload) => {
          calls.groupUpdate = { id, payload };
          return {};
        };
        chrome.tabs.update = async (id, payload) => {
          calls.activated = { id, payload };
          return {};
        };
        window.close = () => { calls.closeCount += 1; };

        groupBtn.click();
        await new Promise((r) => setTimeout(r, 120));

        chrome.tabs.create = orig.create;
        chrome.tabs.group = orig.group;
        chrome.tabs.update = orig.update;
        chrome.tabGroups.update = orig.tabGroupUpdate;
        window.close = orig.close;

        return {
          ok: true,
          actionLabels,
          calls,
          contextOpen: window.__popupTest.getState().contextOpen,
        };
      })();
      `,
    );
    must(
      openAllInTabGroup.ok &&
        openAllInTabGroup.actionLabels.includes('Open All in New Tab Group') &&
        openAllInTabGroup.actionLabels.includes('Rename...') &&
        !openAllInTabGroup.actionLabels.includes('Edit...') &&
        openAllInTabGroup.calls.created.length === 1 &&
        openAllInTabGroup.calls.created[0].url === 'https://example.com/child' &&
        openAllInTabGroup.calls.created[0].active === false &&
        JSON.stringify(openAllInTabGroup.calls.grouped?.tabIds) === JSON.stringify([700]) &&
        openAllInTabGroup.calls.groupUpdate?.id === 321 &&
        openAllInTabGroup.calls.groupUpdate?.payload?.title === fixture.names.folder &&
        openAllInTabGroup.calls.activated?.id === 700 &&
        openAllInTabGroup.calls.activated?.payload?.active === true &&
        openAllInTabGroup.calls.closeCount > 0 &&
        !openAllInTabGroup.contextOpen,
      `Open All in New Tab Group behavior mismatch: ${JSON.stringify(openAllInTabGroup)}`,
    );

    const deletedViaContext = await cdp.eval(
      sessionId,
      `
      (async () => {
        const targetText = ${JSON.stringify(fixture.names.b)};
        const row = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(targetText)
        );

        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const reusedPopup = window.__popupTest.getState().contextOpen &&
          !document.querySelector('#context-menu') &&
          [...document.querySelectorAll('#bookmark-list > .item.context-action')].length > 0;

        const actionLabels = [...document.querySelectorAll('#bookmark-list > .item.context-action .item-title')]
          .map((el) => el.textContent.trim());
        const deleteBtn = [...document.querySelectorAll('#bookmark-list > .item.context-action')].find((el) =>
          el.textContent.trim() === 'Delete'
        );
        if (!reusedPopup || !deleteBtn) {
          return { removed: false, reusedPopup, hasDelete: Boolean(deleteBtn), actionLabels };
        }

        const originalConfirm = window.confirm;
        const confirmMessages = [];
        window.confirm = (message) => {
          confirmMessages.push(message);
          return false;
        };
        deleteBtn.click();
        await new Promise((r) => setTimeout(r, 80));
        const exactTitleExists = async () => (
          await chrome.bookmarks.search(targetText)
        ).some((node) => node.title === targetText);
        const existsAfterCancel = await exactTitleExists();
        const contextStillOpen = window.__popupTest.getState().contextOpen;
        if (!existsAfterCancel || !contextStillOpen) {
          window.confirm = originalConfirm;
          return {
            removed: false,
            reusedPopup,
            hasDelete: true,
            actionLabels,
            confirmMessages,
            existsAfterCancel,
            contextStillOpen,
          };
        }

        window.confirm = (message) => {
          confirmMessages.push(message);
          return true;
        };
        deleteBtn.click();
        for (let i = 0; i < 20; i++) {
          const stillExists = await exactTitleExists();
          if (!stillExists) {
            window.confirm = originalConfirm;
            return {
              removed: true,
              reusedPopup,
              hasDelete: true,
              actionLabels,
              confirmMessages,
              existsAfterCancel,
              contextStillOpen,
            };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        window.confirm = originalConfirm;
        const matches = await chrome.bookmarks.search(targetText);
        return {
          removed: false,
          reusedPopup,
          hasDelete: true,
          actionLabels,
          confirmMessages,
          existsAfterCancel,
          contextStillOpen,
          matches: matches.map((node) => ({ id: node.id, title: node.title, url: node.url || null })),
        };
      })();
      `,
    );
    must(deletedViaContext.removed, `Context menu Delete did not remove bookmark: ${JSON.stringify(deletedViaContext)}`);
    must(
      JSON.stringify(deletedViaContext.actionLabels) === JSON.stringify([
        'Open in New Tab',
        'Open in New Window',
        'Open in Incognito Window',
        'Rename...',
        'Cut',
        'Copy',
        'Paste',
        'Delete',
        'Add Page...',
        'Add Folder...',
        'Open in Bookmarks Manager',
        'Show Apps Shortcut',
        'Show Tab Groups',
        'Show Other Bookmarks',
        'Show Mobile Bookmarks',
      ]),
      `Bookmark context menu labels were not Chrome-like: ${JSON.stringify(deletedViaContext.actionLabels)}`,
    );
    must(
      deletedViaContext.confirmMessages.length === 2 &&
        deletedViaContext.confirmMessages.every((message) => message.includes(fixture.names.b)),
      `Context menu Delete did not confirm with item name: ${JSON.stringify(deletedViaContext)}`,
    );

    const reordered = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await new Promise((r) => setTimeout(r, 120));
        const textC = ${JSON.stringify(fixture.names.c)};
        const textA = ${JSON.stringify(fixture.names.a)};

        const sourceRow = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(textC)
        );
        const targetRow = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(textA)
        );
        if (!sourceRow || !targetRow) {
          return { moved: false, hasSource: Boolean(sourceRow), hasTarget: Boolean(targetRow) };
        }
        const dataTransfer = new DataTransfer();
        const rect = sourceRow.getBoundingClientRect();
        const dragClientX = rect.left + 24;
        const dragClientY = rect.top + 12;
        const originalSetDragImage = DataTransfer.prototype.setDragImage;
        let dragImageCall = null;
        DataTransfer.prototype.setDragImage = function(image, x, y) {
          dragImageCall = { image, x, y };
          return originalSetDragImage.call(this, image, x, y);
        };
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: dragClientX,
          clientY: dragClientY,
          dataTransfer,
        }));
        DataTransfer.prototype.setDragImage = originalSetDragImage;
        const dragImage = document.querySelector('.drag-image');
        const dragImageStyle = dragImage ? getComputedStyle(dragImage) : null;
        sourceRow.classList.add('active');
        const rowStyle = getComputedStyle(sourceRow);
        const iconStyle = getComputedStyle(sourceRow.querySelector('.item-icon'));
        const metaStyle = getComputedStyle(sourceRow.querySelector('.item-meta'));
        const dragImageIcon = dragImage?.querySelector('.item-icon');
        const dragImageTitle = dragImage?.querySelector('.item-title');
        const iconAndTextWhileDragging = sourceRow.classList.contains('dragging') &&
          rowStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
          rowStyle.boxShadow === 'none' &&
          rowStyle.opacity === '1' &&
          iconStyle.opacity === '0' &&
          metaStyle.opacity === '0' &&
          Boolean(dragImageIcon) &&
          dragImageTitle?.textContent === sourceRow.querySelector('.item-title')?.textContent &&
          dragImageStyle?.backgroundColor === 'rgba(0, 0, 0, 0)' &&
          dragImageStyle?.boxShadow === 'none' &&
          dragImageCall?.image === dragImage &&
          dragImageCall?.x === 24 &&
          dragImageCall?.y === 12;
        sourceRow.classList.remove('active');

        const markerState = () => [...document.querySelectorAll('.drop-before,.drop-after')].map((row) => ({
          id: row.dataset.nodeId,
          before: row.classList.contains('drop-before'),
          after: row.classList.contains('drop-after'),
        }));
        const rows = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')]
          .filter((row) => !row.classList.contains('virtual-root') && row !== sourceRow);
        const lowerRow = targetRow;
        const lowerIndex = rows.indexOf(lowerRow);
        const upperRow = lowerIndex > 0 ? rows[lowerIndex - 1] : null;
        let singleMarkerPerGap = false;
        if (upperRow) {
          const upperRect = upperRow.getBoundingClientRect();
          const lowerRect = lowerRow.getBoundingClientRect();
          upperRow.dispatchEvent(new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: upperRect.left + 24,
            clientY: upperRect.bottom - 2,
            dataTransfer,
          }));
          const bottomOfUpperMarker = markerState();
          lowerRow.dispatchEvent(new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: lowerRect.left + 24,
            clientY: lowerRect.top + 2,
            dataTransfer,
          }));
          const topOfLowerMarker = markerState();
          singleMarkerPerGap = bottomOfUpperMarker.length === 1 &&
            topOfLowerMarker.length === 1 &&
            JSON.stringify(bottomOfUpperMarker) === JSON.stringify(topOfLowerMarker) &&
            topOfLowerMarker[0]?.id === lowerRow.dataset.nodeId &&
            topOfLowerMarker[0]?.before === true;
        }

        const list = document.querySelector('#bookmark-list');
        const domBeforeDrop = [...list.querySelectorAll(':scope > .item[data-node-id]')]
          .map((row) => row.dataset.nodeId);
        let largestRemovalBatch = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            largestRemovalBatch = Math.max(largestRemovalBatch, record.removedNodes.length);
          }
        });
        observer.observe(list, { childList: true });

        const targetRect = targetRow.getBoundingClientRect();
        targetRow.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: targetRect.left + 24,
          clientY: targetRect.top + 2,
          dataTransfer,
        }));
        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));
        const dragClassCleared = !sourceRow.classList.contains('dragging');

        const [treeRoot] = await chrome.bookmarks.getTree();
        const bar = (treeRoot.children || []).find((n) => n.id === '1') || treeRoot.children[0];
        let barChildren = [];
        for (let i = 0; i < 30; i++) {
          barChildren = await chrome.bookmarks.getChildren(bar.id);
          const currentNames = barChildren.map((n) => n.title);
          if (currentNames.indexOf(textC) < currentNames.indexOf(textA)) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        await new Promise((r) => setTimeout(r, 220));
        observer.disconnect();
        const names = barChildren.map((n) => n.title);
        const domAfterDrop = [...list.querySelectorAll(':scope > .item[data-node-id]')]
          .map((row) => row.dataset.nodeId);
        const domMovedWithoutRebuild = largestRemovalBatch <= 1 &&
          domBeforeDrop.length === domAfterDrop.length &&
          domAfterDrop.indexOf(sourceRow.dataset.nodeId) < domAfterDrop.indexOf(targetRow.dataset.nodeId);
        return {
          moved: names.indexOf(textC) < names.indexOf(textA),
          iconAndTextWhileDragging,
          singleMarkerPerGap,
          domMovedWithoutRebuild,
          dragClassCleared,
          names,
          largestRemovalBatch,
        };
      })();
      `,
    );
    must(
      reordered.moved &&
        reordered.iconAndTextWhileDragging &&
        reordered.singleMarkerPerGap &&
        reordered.domMovedWithoutRebuild &&
        reordered.dragClassCleared,
      `Drag-drop reorder or dragging style failed: ${JSON.stringify(reordered)}`,
    );

    const clickFolderNavigation = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await new Promise((r) => setTimeout(r, 300));
        const result = await window.__popupTest.clickOpenFolderById(${JSON.stringify(fixture.ids.folder)});
        for (let i = 0; i < 20; i++) {
          const state = window.__popupTest.getState();
          if (state.currentFolderId === ${JSON.stringify(fixture.ids.folder)}) {
            const backLabel = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim();
            const childVisible = [...document.querySelectorAll('.item-title')].some((el) =>
              el.textContent.includes(${JSON.stringify(fixture.names.child)})
            );
            document.querySelector('#bookmark-list > .item.back')?.click();
            for (let j = 0; j < 20; j++) {
              if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
              await new Promise((r) => setTimeout(r, 80));
            }
            return {
              ...result,
              backLabel,
              childVisible,
              backWorks: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
            };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { ...result, currentFolderId: window.__popupTest.getState().currentFolderId };
      })();
      `,
    );
    must(
      clickFolderNavigation.opened && clickFolderNavigation.childVisible && clickFolderNavigation.backWorks,
      `Click folder navigation did not show expected folder content: ${JSON.stringify(clickFolderNavigation)}`,
    );
    must(
      clickFolderNavigation.backLabel === fixture.names.folder,
      `Back row did not show clicked folder title: ${JSON.stringify(clickFolderNavigation)}`,
    );

    console.log(`PASS: Extension UI and interactions verified in live browser: ${BROWSER_BIN}`);
  } finally {
    try {
      cdp?.close();
    } catch {}
    globalThis.__BROWSER_LOGS__ = browserLogs;
    chrome.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  const logs = globalThis.__BROWSER_LOGS__ || [];
  if (logs.length) {
    console.error('BROWSER_LOG_TAIL:');
    for (const line of logs.slice(-40)) {
      console.error(line);
    }
  }
  process.exit(1);
});

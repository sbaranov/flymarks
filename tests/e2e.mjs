import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { findChromeForTesting } from '../scripts/chrome-for-testing.mjs';

const EXT_DIR = path.resolve(process.cwd());
const BROWSER_BIN = findChromeForTesting(EXT_DIR);
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
      throw new Error('WebSocket is unavailable. Run with: npm test');
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flymarks-ext-'));
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

        const virtualTitles = ${JSON.stringify(fixture.topLevelVirtuals.map((n) => n.title))};
        const rowTitles = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
          .map((el) => el.textContent.trim());
        const virtualsFirst = virtualTitles.every((title, index) => rowTitles[index] === title);

        const otherBookmarks = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Other Bookmarks');
        const mobileBookmarks = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')]
          .find((row) => row.querySelector('.item-title')?.textContent.trim() === 'Mobile Bookmarks');
        const otherIconClass = otherBookmarks?.classList.contains('virtual-other-bookmarks') || false;
        const mobileIconClass = mobileBookmarks?.classList.contains('virtual-mobile-bookmarks') || false;
        const appsAbsent = !rowTitles.includes('Apps');
        const tabGroupsAbsent = !rowTitles.includes('Tab Groups');

        return {
          toolbarGone,
          virtualsFirst,
          otherIconClass,
          mobileIconClass,
          appsAbsent,
          tabGroupsAbsent,
        };
      })();
      `,
    );
    const hasMobileBookmarksRoot = fixture.topLevelVirtuals.some((n) => n.title === 'Mobile Bookmarks');
    must(rootNavigation.toolbarGone, 'Popup toolbar/header is still rendered.');
    must(rootNavigation.virtualsFirst, `Virtual root folders were not rendered first: ${JSON.stringify(rootNavigation)}`);
    must(
      rootNavigation.otherIconClass &&
      rootNavigation.appsAbsent &&
      rootNavigation.tabGroupsAbsent &&
      (!hasMobileBookmarksRoot || rootNavigation.mobileIconClass),
      `Virtual root folders mismatch: ${JSON.stringify(rootNavigation)}`,
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
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('#bookmark-list > .item.context-action')) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        const actions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((action) => ({
          label: action.querySelector('.item-title')?.textContent.trim(),
          disabled: action.classList.contains('disabled'),
        }));
        const byLabel = Object.fromEntries(actions.map((action) => [action.label, action]));
        const openOptionPatterns = [
          /^Open All \\((\\d+)\\)$/,
          /^Open All \\((\\d+)\\) in New Window$/,
          /^Open All \\((\\d+)\\) in Incognito Window$/,
        ];
        const openOptionsMatchCount = openOptionPatterns.every((pattern) =>
          actions.some((action) => {
            const match = action.label.match(pattern);
            return match && action.disabled === (Number(match[1]) === 0);
          })
        );

        return {
          foundRow: Boolean(row),
          title: row?.querySelector('.item-title')?.textContent.trim() || '',
          actions,
          openOptionsMatchCount,
          protectedActionsDisabled: ['Rename...', 'Cut', 'Copy', 'Delete'].every((label) =>
            byLabel[label]?.disabled === true
          ),
          addActionsEnabled: ['Add Page...', 'Add Folder...'].every((label) =>
            byLabel[label]?.disabled === false
          ),
        };
      })();
      `,
    );
    must(
      realVirtualFolderOpenOptions.foundRow &&
        realVirtualFolderOpenOptions.openOptionsMatchCount &&
        realVirtualFolderOpenOptions.protectedActionsDisabled &&
        realVirtualFolderOpenOptions.addActionsEnabled,
      `Other/Mobile Bookmarks virtual folder open options did not match their counters: ${JSON.stringify(realVirtualFolderOpenOptions)}`,
    );

    const openedSpecialFolderProtectedActions = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const row = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((el) =>
          ['Other Bookmarks', 'Mobile Bookmarks'].includes(el.querySelector('.item-title')?.textContent.trim())
        );
        const title = row?.querySelector('.item-title')?.textContent.trim() || '';
        row?.click();
        for (let i = 0; i < 20; i++) {
          const state = window.__popupTest.getState();
          if (state.currentFolderId !== state.rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const backRow = document.querySelector('#bookmark-list > .item.back');
        backRow?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
          button: 2,
        }));
        const actions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((action) => ({
          label: action.querySelector('.item-title')?.textContent.trim(),
          disabled: action.classList.contains('disabled'),
        }));
        const byLabel = Object.fromEntries(actions.map((action) => [action.label, action]));
        const header = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim() || '';
        document.querySelector('#bookmark-list > .item.back')?.click();
        await new Promise((r) => setTimeout(r, 80));
        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          foundRow: Boolean(row),
          foundBackRow: Boolean(backRow),
          title,
          header,
          actions,
          protectedActionsDisabled: ['Rename...', 'Cut', 'Copy', 'Delete'].every((label) =>
            byLabel[label]?.disabled === true
          ),
          addActionsEnabled: ['Add Page...', 'Add Folder...'].every((label) =>
            byLabel[label]?.disabled === false
          ),
          returnedToRoot: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      openedSpecialFolderProtectedActions.foundRow &&
        openedSpecialFolderProtectedActions.foundBackRow &&
        openedSpecialFolderProtectedActions.header === openedSpecialFolderProtectedActions.title &&
        openedSpecialFolderProtectedActions.protectedActionsDisabled &&
        openedSpecialFolderProtectedActions.addActionsEnabled &&
        openedSpecialFolderProtectedActions.returnedToRoot,
      `Opened special folder context menu did not protect root actions: ${JSON.stringify(openedSpecialFolderProtectedActions)}`,
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
        const otherOff = await clickToggle('Show Other Bookmarks');
        const mobileOff = await clickToggle('Show Mobile Bookmarks');
        const otherOn = await clickToggle('Show Other Bookmarks');
        const mobileOn = await clickToggle('Show Mobile Bookmarks');

        return { initial, otherOff, mobileOff, otherOn, mobileOn };
      })();
      `,
    );
    must(
      virtualSettingToggles.initial.state.showAppsShortcut === undefined &&
        virtualSettingToggles.initial.state.showTabGroups === undefined &&
        virtualSettingToggles.initial.state.showOtherBookmarks === true &&
        virtualSettingToggles.initial.state.showMobileBookmarks === true &&
        !virtualSettingToggles.initial.titles.includes('Apps') &&
        !virtualSettingToggles.initial.titles.includes('Tab Groups') &&
        virtualSettingToggles.initial.titles.includes('Other Bookmarks') &&
        (!hasMobileBookmarksRoot || virtualSettingToggles.initial.titles.includes('Mobile Bookmarks')) &&
        virtualSettingToggles.otherOff.found &&
        virtualSettingToggles.otherOff.iconBefore === '✓' &&
        virtualSettingToggles.otherOff.state.showOtherBookmarks === false &&
        !virtualSettingToggles.otherOff.titles.includes('Other Bookmarks') &&
        virtualSettingToggles.mobileOff.found &&
        virtualSettingToggles.mobileOff.iconBefore === '✓' &&
        virtualSettingToggles.mobileOff.state.showMobileBookmarks === false &&
        (!hasMobileBookmarksRoot || !virtualSettingToggles.mobileOff.titles.includes('Mobile Bookmarks')) &&
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

    const virtualOnlyRootEmptyMessage = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.renderNodes([]);
        const rows = [...document.querySelectorAll('#bookmark-list > .item')].map((row) =>
          row.querySelector('.item-title')?.textContent.trim()
        );
        const emptyText = document.querySelector('#bookmark-list > .empty')?.textContent.trim() || '';
        const children = [...document.querySelector('#bookmark-list').children];
        const emptyIndex = children.findIndex((child) => child.classList.contains('empty'));
        const separatorBeforeEmpty = emptyIndex > 0 && children[emptyIndex - 1].classList.contains('menu-sep');
        await window.__popupTest.refreshCurrent();
        return { rows, emptyText, separatorBeforeEmpty };
      })();
      `,
    );
    must(
      virtualOnlyRootEmptyMessage.emptyText === 'No bookmarks in this folder' &&
        virtualOnlyRootEmptyMessage.separatorBeforeEmpty &&
        fixture.topLevelVirtuals.every((node, index) => virtualOnlyRootEmptyMessage.rows[index] === node.title),
      `Virtual-only root did not show the empty message: ${JSON.stringify(virtualOnlyRootEmptyMessage)}`,
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
        await window.__popupTest.refreshCurrent();
        const targetText = ${JSON.stringify(fixture.names.a)};
        const row = document.querySelector(${JSON.stringify(`.item[data-node-id="${fixture.ids.a}"]`)})
          || [...document.querySelectorAll('.item')].find((el) =>
            el.querySelector('.item-title')?.textContent.includes(targetText)
          );
        if (!row) {
          return {
            normal: { updateUrl: null, createUrl: null, closeCount: 0 },
            meta: { updateUrl: null, createUrl: null, closeCount: 0 },
            foundRow: false,
            titles: [...document.querySelectorAll('.item .item-title')].map((el) => el.textContent.trim()),
          };
        }
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
        const row = document.querySelector(${JSON.stringify(`.item[data-node-id="${fixture.ids.a}"]`)})
          || [...document.querySelectorAll('.item')].find((el) =>
            el.querySelector('.item-title')?.textContent.includes(targetText)
          );
        if (!row) return { opened: false, hasRow: false };

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
        const row = document.querySelector(${JSON.stringify(`.item[data-node-id="${fixture.ids.a}"]`)})
          || [...document.querySelectorAll('.item')].find((el) =>
            el.querySelector('.item-title')?.textContent.includes(targetText)
          );
        if (!row) return { opened: false, hasRow: false };

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

    const tabGroupActionsRemoved = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const folderText = ${JSON.stringify(fixture.names.folder)};
        const folderRow = [...document.querySelectorAll('.item.folder:not(.virtual-root)')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(folderText)
        ) || document.querySelector('.item.folder:not(.virtual-root)');
        if (!folderRow) {
          return {
            foundFolder: false,
            titles: [...document.querySelectorAll('.item .item-title')].map((el) => el.textContent.trim()),
          };
        }

        folderRow.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const actionLabels = [...document.querySelectorAll('#bookmark-list > .item.context-action .item-title')]
          .map((el) => el.textContent.trim());

        return {
          foundFolder: true,
          actionLabels,
        };
      })();
      `,
    );
    must(
      tabGroupActionsRemoved.foundFolder &&
        !tabGroupActionsRemoved.actionLabels.includes('Open All in New Tab Group') &&
        tabGroupActionsRemoved.actionLabels.includes('Open All (1)') &&
        tabGroupActionsRemoved.actionLabels.includes('Open All (1) in New Window') &&
        tabGroupActionsRemoved.actionLabels.includes('Open All (1) in Incognito Window') &&
        tabGroupActionsRemoved.actionLabels.includes('Rename...') &&
        !tabGroupActionsRemoved.actionLabels.includes('Edit...'),
      `Tab group actions were still present: ${JSON.stringify(tabGroupActionsRemoved)}`,
    );

    const emptyFolderOpenAllDisabled = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const folderRow = document.querySelector(${JSON.stringify(`.item[data-node-id="${fixture.ids.emptyFolder}"]`)});
        if (!folderRow) {
          return {
            foundFolder: false,
            titles: [...document.querySelectorAll('.item .item-title')].map((el) => el.textContent.trim()),
          };
        }

        folderRow.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 120,
          button: 2,
        }));

        const actions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((action) => ({
          label: action.querySelector('.item-title')?.textContent.trim(),
          disabled: action.classList.contains('disabled'),
          ariaDisabled: action.getAttribute('aria-disabled'),
        }));
        const expectedLabels = [
          'Open All (0)',
          'Open All (0) in New Window',
          'Open All (0) in Incognito Window',
        ];

        return {
          foundFolder: true,
          actions,
          openAllDisabled: expectedLabels.every((label) =>
            actions.some((action) =>
              action.label === label &&
              action.disabled &&
              action.ariaDisabled === 'true'
            )
          ),
        };
      })();
      `,
    );
    must(
      emptyFolderOpenAllDisabled.foundFolder &&
        emptyFolderOpenAllDisabled.openAllDisabled,
      `Empty folder Open All options were not disabled: ${JSON.stringify(emptyFolderOpenAllDisabled)}`,
    );

    const deletedViaContext = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const targetText = ${JSON.stringify(fixture.names.b)};
        const row = document.querySelector(${JSON.stringify(`.item[data-node-id="${fixture.ids.b}"]`)})
          || [...document.querySelectorAll('.item')].find((el) =>
            el.querySelector('.item-title')?.textContent.includes(targetText)
          );
        if (!row) {
          return {
            removed: false,
            hasRow: false,
            titles: [...document.querySelectorAll('.item .item-title')].map((el) => el.textContent.trim()),
          };
        }

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
        'Open in Bookmarks Manager',
        'Cut',
        'Copy',
        'Paste',
        'Delete',
        'Add Page...',
        'Add Folder...',
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
          iconStyle.opacity === '1' &&
          metaStyle.opacity === '1' &&
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
        list.dispatchEvent(new DragEvent('drop', {
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

    const currentFolderContextSurfaces = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await window.__popupTest.clickOpenFolderById(${JSON.stringify(fixture.ids.folder)});
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const backRow = document.querySelector('#bookmark-list > .item.back');
        backRow?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
          button: 2,
        }));
        const backMenuLabels = [...document.querySelectorAll('#bookmark-list > .item.context-action .item-title')]
          .map((el) => el.textContent.trim());
        const backMenuHeader = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim() || '';

        document.querySelector('#bookmark-list > .item.back')?.click();
        await new Promise((r) => setTimeout(r, 80));
        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        await window.__popupTest.clickOpenFolderById(${JSON.stringify(fixture.ids.emptyFolder)});
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.emptyFolder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }
        const emptyRow = document.querySelector('#bookmark-list > .empty');
        emptyRow?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 160,
          button: 2,
        }));
        const emptyMenuActions = [...document.querySelectorAll('#bookmark-list > .item.context-action')].map((action) => ({
          label: action.querySelector('.item-title')?.textContent.trim(),
          disabled: action.classList.contains('disabled'),
        }));
        const emptyMenuHeader = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim() || '';

        document.querySelector('#bookmark-list > .item.back')?.click();
        await new Promise((r) => setTimeout(r, 80));
        document.querySelector('#bookmark-list > .item.back')?.click();
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          foundBackRow: Boolean(backRow),
          backMenuHeader,
          backMenuLabels,
          foundEmptyRow: Boolean(emptyRow),
          emptyMenuHeader,
          emptyMenuActions,
          returnedToRoot: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      currentFolderContextSurfaces.foundBackRow &&
        currentFolderContextSurfaces.backMenuHeader === fixture.names.folder &&
        currentFolderContextSurfaces.backMenuLabels.includes('Open All (1)') &&
        currentFolderContextSurfaces.backMenuLabels.includes('Rename...') &&
        currentFolderContextSurfaces.foundEmptyRow &&
        currentFolderContextSurfaces.emptyMenuHeader === fixture.names.emptyFolder &&
        currentFolderContextSurfaces.emptyMenuActions.some((action) => action.label === 'Open All (0)' && action.disabled) &&
        currentFolderContextSurfaces.emptyMenuActions.some((action) => action.label === 'Rename...' && !action.disabled) &&
        currentFolderContextSurfaces.returnedToRoot,
      `Current folder context menu did not open from Back/empty rows: ${JSON.stringify(currentFolderContextSurfaces)}`,
    );

    const directDropIntoFolder = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await new Promise((r) => setTimeout(r, 120));

        const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.c)}
        );
        const folderRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.emptyFolder)}
        );
        if (!sourceRow || !folderRow) {
          return { moved: false, hasSource: Boolean(sourceRow), hasFolder: Boolean(folderRow) };
        }

        const dataTransfer = new DataTransfer();
        const sourceRect = sourceRow.getBoundingClientRect();
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: sourceRect.left + 24,
          clientY: sourceRect.top + 12,
          dataTransfer,
        }));

        const folderRect = folderRow.getBoundingClientRect();
        folderRow.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: folderRect.left + 24,
          clientY: folderRect.top + folderRect.height / 2,
          dataTransfer,
        }));
        const dropIntoStyle = getComputedStyle(folderRow);
        const dropIntoHighlight = folderRow.classList.contains('drop-into') &&
          !folderRow.classList.contains('drop-before') &&
          !folderRow.classList.contains('drop-after') &&
          dropIntoStyle.backgroundColor !== 'rgba(0, 0, 0, 0)';
        folderRow.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: folderRect.left + 24,
          clientY: folderRect.top + folderRect.height / 2,
          dataTransfer,
        }));
        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));
        await new Promise((r) => setTimeout(r, 700));

        let parentId = null;
        for (let i = 0; i < 30; i++) {
          const [node] = await chrome.bookmarks.get(${JSON.stringify(fixture.ids.c)});
          parentId = node?.parentId || null;
          if (parentId === ${JSON.stringify(fixture.ids.emptyFolder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const stillAtRoot = window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId;
        const sourceStillVisible = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')]
          .some((row) => row.dataset.nodeId === ${JSON.stringify(fixture.ids.c)});
        const folderCounter = folderRow.querySelector('.item-meta')?.textContent.trim();

        return {
          moved: parentId === ${JSON.stringify(fixture.ids.emptyFolder)},
          dropIntoHighlight,
          stillAtRoot,
          sourceStillVisible,
          folderCounter,
          parentId,
        };
      })();
      `,
    );
    must(
      directDropIntoFolder.moved &&
        directDropIntoFolder.dropIntoHighlight &&
        directDropIntoFolder.stillAtRoot &&
        !directDropIntoFolder.sourceStillVisible &&
        directDropIntoFolder.folderCounter === '1',
      `Direct drop onto a folder row did not move inside it: ${JSON.stringify(directDropIntoFolder)}`,
    );

    const directDropIntoVirtualRootFolder = await cdp.eval(
      sessionId,
      `
      (async () => {
        const source = await chrome.bookmarks.create({
          parentId: window.__popupTest.getState().rootFolderId,
          title: 'CodexExtTest Virtual Root Drop ' + Date.now().toString(36),
          url: 'https://example.com/virtual-root-drop',
        });
        try {
          await window.__popupTest.refreshCurrent();
          await new Promise((r) => setTimeout(r, 120));

          const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
            row.dataset.nodeId === source.id
          );
          const folderRow = [...document.querySelectorAll('#bookmark-list > .item.virtual-root[data-node-id]')].find((row) =>
            ['Other Bookmarks', 'Mobile Bookmarks'].includes(row.querySelector('.item-title')?.textContent.trim())
          );
          if (!sourceRow || !folderRow) {
            return { moved: false, hasSource: Boolean(sourceRow), hasFolder: Boolean(folderRow) };
          }

          const targetId = folderRow.dataset.nodeId;
          const dataTransfer = new DataTransfer();
          const sourceRect = sourceRow.getBoundingClientRect();
          sourceRow.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            clientX: sourceRect.left + 24,
            clientY: sourceRect.top + 12,
            dataTransfer,
          }));

          const folderRect = folderRow.getBoundingClientRect();
          folderRow.dispatchEvent(new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: folderRect.left + 24,
            clientY: folderRect.top + folderRect.height / 2,
            dataTransfer,
          }));
          const folderStyle = getComputedStyle(folderRow);
          const dropIntoHighlight = folderRow.classList.contains('drop-into') &&
            !folderRow.classList.contains('drop-before') &&
            !folderRow.classList.contains('drop-after') &&
            folderStyle.backgroundColor !== 'rgba(0, 0, 0, 0)';
          folderRow.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            clientX: folderRect.left + 24,
            clientY: folderRect.top + folderRect.height / 2,
            dataTransfer,
          }));
          sourceRow.dispatchEvent(new DragEvent('dragend', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }));

          let parentId = null;
          for (let i = 0; i < 30; i++) {
            const [node] = await chrome.bookmarks.get(source.id);
            parentId = node?.parentId || null;
            if (parentId === targetId) break;
            await new Promise((r) => setTimeout(r, 80));
          }

          const stillAtRoot = window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId;
          const sourceStillVisible = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')]
            .some((row) => row.dataset.nodeId === source.id);

          return {
            moved: parentId === targetId,
            dropIntoHighlight,
            stillAtRoot,
            sourceStillVisible,
            parentId,
            targetId,
          };
        } finally {
          try {
            await chrome.bookmarks.remove(source.id);
          } catch {}
        }
      })();
      `,
    );
    must(
      directDropIntoVirtualRootFolder.moved &&
        directDropIntoVirtualRootFolder.dropIntoHighlight &&
        directDropIntoVirtualRootFolder.stillAtRoot &&
        !directDropIntoVirtualRootFolder.sourceStillVisible,
      `Direct drop onto Other/Mobile Bookmarks did not move inside it: ${JSON.stringify(directDropIntoVirtualRootFolder)}`,
    );

    const folderEdgeHoverDoesNotNavigate = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await new Promise((r) => setTimeout(r, 120));

        const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.a)}
        );
        const folderRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.folder)}
        );
        if (!sourceRow || !folderRow) {
          return { stayedAtRoot: false, hasSource: Boolean(sourceRow), hasFolder: Boolean(folderRow) };
        }

        const dataTransfer = new DataTransfer();
        const sourceRect = sourceRow.getBoundingClientRect();
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: sourceRect.left + 24,
          clientY: sourceRect.top + 12,
          dataTransfer,
        }));

        const folderRect = folderRow.getBoundingClientRect();
        folderRow.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: folderRect.left + 24,
          clientY: folderRect.top + 2,
          dataTransfer,
        }));
        const blueLineOnly = folderRow.classList.contains('drop-before') &&
          !folderRow.classList.contains('drop-into');

        await new Promise((r) => setTimeout(r, 700));
        const stayedAtRoot = window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId;

        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

        return {
          stayedAtRoot,
          blueLineOnly,
          currentFolderId: window.__popupTest.getState().currentFolderId,
          rootFolderId: window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      folderEdgeHoverDoesNotNavigate.stayedAtRoot &&
        folderEdgeHoverDoesNotNavigate.blueLineOnly,
      `Folder edge hover incorrectly navigated while showing only reorder line: ${JSON.stringify(folderEdgeHoverDoesNotNavigate)}`,
    );

    const directDropIntoBack = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        await window.__popupTest.clickOpenFolderById(${JSON.stringify(fixture.ids.folder)});
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.querySelector('.item-title')?.textContent.includes(${JSON.stringify(fixture.names.child)})
        );
        const backRow = document.querySelector('#bookmark-list > .item.back');
        if (!sourceRow || !backRow) {
          return { moved: false, hasSource: Boolean(sourceRow), hasBack: Boolean(backRow) };
        }

        const dataTransfer = new DataTransfer();
        const sourceRect = sourceRow.getBoundingClientRect();
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: sourceRect.left + 24,
          clientY: sourceRect.top + 12,
          dataTransfer,
        }));

        const backRect = backRow.getBoundingClientRect();
        backRow.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: backRect.left + 24,
          clientY: backRect.top + backRect.height / 2,
          dataTransfer,
        }));
        const backStyle = getComputedStyle(backRow);
        const dropIntoHighlight = backRow.classList.contains('drop-into') &&
          backStyle.backgroundColor !== 'rgba(0, 0, 0, 0)';
        backRow.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: backRect.left + 24,
          clientY: backRect.top + backRect.height / 2,
          dataTransfer,
        }));
        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

        let parentId = null;
        for (let i = 0; i < 30; i++) {
          const matches = await chrome.bookmarks.search(${JSON.stringify(fixture.names.child)});
          const exact = matches.find((node) => node.title === ${JSON.stringify(fixture.names.child)});
          parentId = exact?.parentId || null;
          if (parentId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const stillInFolder = window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)};
        const sourceStillVisible = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')]
          .some((row) => row.querySelector('.item-title')?.textContent.includes(${JSON.stringify(fixture.names.child)}));

        return {
          moved: parentId === window.__popupTest.getState().rootFolderId,
          dropIntoHighlight,
          stillInFolder,
          sourceStillVisible,
          parentId,
          rootFolderId: window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      directDropIntoBack.moved &&
        directDropIntoBack.dropIntoHighlight &&
        directDropIntoBack.stillInFolder &&
        !directDropIntoBack.sourceStillVisible,
      `Direct drop onto Back did not move into parent folder: ${JSON.stringify(directDropIntoBack)}`,
    );

    const delayedBackDrag = await cdp.eval(
      sessionId,
      `
      (async () => {
        const created = await chrome.bookmarks.create({
          parentId: ${JSON.stringify(fixture.ids.folder)},
          title: 'CodexExtTest Back Hover ' + Date.now().toString(36),
          url: 'https://example.com/back-hover',
        });
        await window.__popupTest.refreshCurrent();
        if (window.__popupTest.getState().currentFolderId !== ${JSON.stringify(fixture.ids.folder)}) {
          await window.__popupTest.clickOpenFolderById(${JSON.stringify(fixture.ids.folder)});
        }
        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === created.id
        );
        const backRow = document.querySelector('#bookmark-list > .item.back');
        if (!sourceRow || !backRow) {
          return { enteredParent: false, moved: false, hasSource: Boolean(sourceRow), hasBack: Boolean(backRow) };
        }

        const dataTransfer = new DataTransfer();
        const sourceRect = sourceRow.getBoundingClientRect();
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: sourceRect.left + 24,
          clientY: sourceRect.top + 12,
          dataTransfer,
        }));

        const backRect = backRow.getBoundingClientRect();
        backRow.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: backRect.left + 24,
          clientY: backRect.top + backRect.height / 2,
          dataTransfer,
        }));

        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const enteredParent = window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId;
        document.querySelector('#bookmark-list').dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: document.querySelector('#bookmark-list').getBoundingClientRect().bottom - 4,
          dataTransfer,
        }));
        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

        let parentId = null;
        let visibleInParent = false;
        for (let i = 0; i < 30; i++) {
          const [node] = await chrome.bookmarks.get(created.id);
          parentId = node?.parentId || null;
          visibleInParent = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')]
            .some((row) => row.dataset.nodeId === created.id);
          if (parentId === window.__popupTest.getState().rootFolderId && visibleInParent) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          enteredParent,
          moved: parentId === window.__popupTest.getState().rootFolderId,
          visibleInParent,
          parentId,
          rootFolderId: window.__popupTest.getState().rootFolderId,
        };
      })();
      `,
    );
    must(
      delayedBackDrag.enteredParent &&
        delayedBackDrag.moved &&
        delayedBackDrag.visibleInParent,
      `Delayed drag over Back did not navigate to parent and continue dragging: ${JSON.stringify(delayedBackDrag)}`,
    );

    const delayedVirtualRootBackDrag = await cdp.eval(
      sessionId,
      `
      (async () => {
        await window.__popupTest.refreshCurrent();
        const virtualRow = [...document.querySelectorAll('#bookmark-list > .item.virtual-root')].find((row) =>
          ['Other Bookmarks', 'Mobile Bookmarks'].includes(row.querySelector('.item-title')?.textContent.trim())
        );
        if (!virtualRow) {
          return { enteredRoot: false, hasVirtualRow: false };
        }
        const virtualFolderId = virtualRow.dataset.nodeId;
        const created = await chrome.bookmarks.create({
          parentId: virtualFolderId,
          title: 'CodexExtTest Virtual Back Hover ' + Date.now().toString(36),
          url: 'https://example.com/virtual-back-hover',
        });

        try {
          virtualRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          for (let i = 0; i < 30; i++) {
            if (window.__popupTest.getState().currentFolderId === virtualFolderId) break;
            await new Promise((r) => setTimeout(r, 80));
          }

          const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
            row.dataset.nodeId === created.id
          );
          const backRow = document.querySelector('#bookmark-list > .item.back');
          if (!sourceRow || !backRow) {
            return {
              enteredRoot: false,
              hasVirtualRow: true,
              hasSource: Boolean(sourceRow),
              hasBack: Boolean(backRow),
              currentFolderId: window.__popupTest.getState().currentFolderId,
              virtualFolderId,
            };
          }

          const dataTransfer = new DataTransfer();
          const sourceRect = sourceRow.getBoundingClientRect();
          sourceRow.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            clientX: sourceRect.left + 24,
            clientY: sourceRect.top + 12,
            dataTransfer,
          }));

          const backRect = backRow.getBoundingClientRect();
          backRow.dispatchEvent(new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: backRect.left + 24,
            clientY: backRect.top + backRect.height / 2,
            dataTransfer,
          }));

          for (let i = 0; i < 30; i++) {
            if (window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId) break;
            await new Promise((r) => setTimeout(r, 80));
          }

          sourceRow.dispatchEvent(new DragEvent('dragend', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }));

          const rowTitles = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
            .map((el) => el.textContent.trim());
          return {
            enteredRoot: window.__popupTest.getState().currentFolderId === window.__popupTest.getState().rootFolderId,
            rootFolderVisible: rowTitles.includes(${JSON.stringify(fixture.names.folder)}),
            chromeRootHidden: !rowTitles.includes('Bookmarks Bar'),
            virtualRootsVisible: rowTitles.includes('Other Bookmarks') &&
              (!${JSON.stringify(hasMobileBookmarksRoot)} || rowTitles.includes('Mobile Bookmarks')),
            currentFolderId: window.__popupTest.getState().currentFolderId,
            rootFolderId: window.__popupTest.getState().rootFolderId,
            virtualFolderId,
            rowTitles,
          };
        } finally {
          try {
            await chrome.bookmarks.remove(created.id);
          } catch {}
        }
      })();
      `,
    );
    must(
      delayedVirtualRootBackDrag.enteredRoot &&
        delayedVirtualRootBackDrag.rootFolderVisible &&
        delayedVirtualRootBackDrag.chromeRootHidden &&
        delayedVirtualRootBackDrag.virtualRootsVisible,
      `Delayed drag over Back from Other/Mobile showed wrong parent view: ${JSON.stringify(delayedVirtualRootBackDrag)}`,
    );

    const dragIntoFolder = await cdp.eval(
      sessionId,
      `
      (async () => {
        const dropTarget = await chrome.bookmarks.create({
          parentId: ${JSON.stringify(fixture.ids.folder)},
          title: 'CodexExtTest Existing Target ' + Date.now().toString(36),
          url: 'https://example.com/existing-target',
        });
        await window.__popupTest.refreshCurrent();
        await new Promise((r) => setTimeout(r, 120));

        const sourceRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.a)}
        );
        const folderRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === ${JSON.stringify(fixture.ids.folder)}
        );
        if (!sourceRow || !folderRow) {
          return { entered: false, moved: false, hasSource: Boolean(sourceRow), hasFolder: Boolean(folderRow) };
        }

        const dataTransfer = new DataTransfer();
        const sourceRect = sourceRow.getBoundingClientRect();
        sourceRow.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          clientX: sourceRect.left + 24,
          clientY: sourceRect.top + 12,
          dataTransfer,
        }));

        const folderRect = folderRow.getBoundingClientRect();
        folderRow.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: folderRect.left + 24,
          clientY: folderRect.top + 12,
          dataTransfer,
        }));

        for (let i = 0; i < 20; i++) {
          if (window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)}) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        const entered = window.__popupTest.getState().currentFolderId === ${JSON.stringify(fixture.ids.folder)};
        const backLabel = document.querySelector('#bookmark-list > .item.back .item-title')?.textContent.trim();
        const childRow = [...document.querySelectorAll('#bookmark-list > .item[data-node-id]')].find((row) =>
          row.dataset.nodeId === dropTarget.id
        );
        const childRect = childRow?.getBoundingClientRect();
        childRow?.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: (childRect?.left || 0) + 24,
          clientY: (childRect?.top || 0) + 2,
          dataTransfer,
        }));
        sourceRow.dispatchEvent(new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

        let parentId = null;
        let visibleInFolder = false;
        for (let i = 0; i < 30; i++) {
          const [node] = await chrome.bookmarks.get(${JSON.stringify(fixture.ids.a)});
          parentId = node?.parentId || null;
          visibleInFolder = [...document.querySelectorAll('#bookmark-list > .item .item-title')]
            .some((el) => el.textContent.includes(${JSON.stringify(fixture.names.a)}));
          if (parentId === ${JSON.stringify(fixture.ids.folder)} && visibleInFolder) break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          entered,
          moved: parentId === ${JSON.stringify(fixture.ids.folder)},
          visibleInFolder,
          backLabel,
          hasChildRow: Boolean(childRow),
          currentFolderId: window.__popupTest.getState().currentFolderId,
          parentId,
        };
      })();
      `,
    );
    must(
      dragIntoFolder.entered &&
        dragIntoFolder.moved &&
        dragIntoFolder.visibleInFolder &&
        dragIntoFolder.hasChildRow &&
        dragIntoFolder.backLabel === fixture.names.folder,
      `Dragging over a folder did not enter and drop there: ${JSON.stringify(dragIntoFolder)}`,
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

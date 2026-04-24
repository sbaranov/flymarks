import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const EXT_DIR = path.resolve(process.cwd());
const CANDIDATE_BROWSERS = [
  process.env.BROWSER_BIN,
  '/tmp/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/tmp/chrome-for-testing/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].filter(Boolean);
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
  const browserBin = CANDIDATE_BROWSERS.find((bin) => fs.existsSync(bin));
  if (!browserBin) {
    throw new Error('No Chromium-based browser binary was found.');
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-ext-'));
  const chrome = spawn(
    browserBin,
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
          child: 'CodexExtTest Child ' + suffix,
          a: 'CodexExtTest A ' + suffix,
          b: 'CodexExtTest B ' + suffix,
          c: 'CodexExtTest C ' + suffix,
        };

        const [treeRoot] = await chrome.bookmarks.getTree();
        const bar = (treeRoot.children || []).find((n) => n.id === '1') || treeRoot.children[0];
        const existing = await chrome.bookmarks.search('CodexExtTest ');
        for (const node of existing) {
          try {
            if (node.url) await chrome.bookmarks.remove(node.id);
            else await chrome.bookmarks.removeTree(node.id);
          } catch {}
        }

        const folder = await chrome.bookmarks.create({ parentId: bar.id, title: names.folder });
        await chrome.bookmarks.create({ parentId: folder.id, title: names.child, url: 'https://example.com/child' });
        const a = await chrome.bookmarks.create({ parentId: bar.id, title: names.a, url: 'https://example.com/a' });
        const b = await chrome.bookmarks.create({ parentId: bar.id, title: names.b, url: 'https://example.com/b' });
        const c = await chrome.bookmarks.create({ parentId: bar.id, title: names.c, url: 'https://example.com/c' });

        return { names, ids: { folder: folder.id, a: a.id, b: b.id, c: c.id } };
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

    const malformedNodesHandled = await cdp.eval(
      sessionId,
      `
      (async () => {
        window.__popupTest.renderNodes([
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

        const deleteBtn = [...document.querySelectorAll('#context-items .context-item')].find((el) =>
          el.textContent.trim() === 'Delete'
        );
        deleteBtn.click();
        for (let i = 0; i < 20; i++) {
          const stillExists = (await chrome.bookmarks.search(targetText)).length > 0;
          if (!stillExists) return true;
          await new Promise((r) => setTimeout(r, 80));
        }
        return false;
      })();
      `,
    );
    must(deletedViaContext, 'Context menu Delete did not remove bookmark.');

    const reordered = await cdp.eval(
      sessionId,
      `
      (async () => {
        const textC = ${JSON.stringify(fixture.names.c)};
        const textA = ${JSON.stringify(fixture.names.a)};

        const sourceRow = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(textC)
        );
        const targetRow = [...document.querySelectorAll('.item')].find((el) =>
          el.querySelector('.item-title')?.textContent.includes(textA)
        );
        const moved = await window.__popupTest.reorderByIds(sourceRow.dataset.nodeId, targetRow.dataset.nodeId, true);
        if (!moved) return false;

        const [treeRoot] = await chrome.bookmarks.getTree();
        const bar = (treeRoot.children || []).find((n) => n.id === '1') || treeRoot.children[0];
        const barChildren = await chrome.bookmarks.getChildren(bar.id);
        const names = barChildren.map((n) => n.title);
        return names.indexOf(textC) < names.indexOf(textA);
      })();
      `,
    );
    must(reordered, 'Drag-drop reorder failed.');

    const hoverFlyout = await cdp.eval(
      sessionId,
      `
      (async () => {
        const opened = await window.__popupTest.openFlyoutById(${JSON.stringify(fixture.ids.folder)});
        if (!opened) return false;
        await new Promise((r) => setTimeout(r, 80));
        return window.__popupTest.getState().flyoutCount > 0;
      })();
      `,
    );
    must(hoverFlyout, 'Hover flyout did not open expected folder content.');

    console.log(`PASS: Extension UI and interactions verified in live browser: ${browserBin}`);
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

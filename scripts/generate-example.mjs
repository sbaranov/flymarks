import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoDir = path.resolve(process.cwd());
const browserBin = process.env.BROWSER_BIN ||
  path.join(os.homedir(), 'Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const outputPath = path.join(repoDir, 'example.png');
const htmlPath = path.join(os.tmpdir(), 'bookmarks-menu-popup-example.html');

const rows = [
  { type: 'apps', title: 'Apps' },
  { type: 'tab-groups', title: 'Tab Groups', count: 2 },
  { type: 'other', title: 'Other Bookmarks', count: 8 },
  { type: 'mobile', title: 'Mobile Bookmarks', count: 4 },
  { sep: true },
  { type: 'folder', title: 'Work', count: 12 },
  { type: 'folder', title: 'Personal', count: 6 },
  { type: 'bookmark', title: 'Google', favicon: 'https://www.google.com/s2/favicons?domain=google.com&sz=64' },
  { type: 'bookmark', title: 'YouTube', favicon: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=64' },
  { type: 'bookmark', title: 'Wikipedia', favicon: 'https://www.google.com/s2/favicons?domain=wikipedia.org&sz=64' },
  {
    type: 'bookmark',
    title: 'GitHub',
    favicon: 'https://github.githubassets.com/favicons/favicon.svg',
    iconClass: 'favicon-tile',
  },
  {
    type: 'bookmark',
    title: 'Stack Overflow',
    favicon: 'https://cdn.sstatic.net/Sites/stackoverflow/Img/apple-touch-icon.png?v=c78bd457575a',
  },
  { type: 'bookmark', title: 'Google Maps', favicon: 'https://www.google.com/s2/favicons?domain=maps.google.com&sz=64' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class Cdp {
  constructor(wsUrl) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is unavailable. Run with: npm run example');
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

  close() {
    this.ws.close();
  }
}

function iconMarkup(row) {
  if (row.type !== 'bookmark') return '<span class="glyph"></span>';

  return `<span class="favicon-frame ${row.iconClass || ''}"><img class="favicon" src="${row.faviconDataUrl}" alt=""></span>`;
}

async function inlineFavicons() {
  await Promise.all(rows.map(async (row) => {
    if (row.type !== 'bookmark') return;

    const res = await fetch(row.favicon);
    if (!res.ok) {
      throw new Error(`Could not download favicon for ${row.title}: ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || 'image/png';
    const bytes = Buffer.from(await res.arrayBuffer());
    row.faviconDataUrl = `data:${contentType};base64,${bytes.toString('base64')}`;
  }));
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Bookmarks Menu Example</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #2d2e31;
      --text: #e8eaed;
      --muted: #9aa0a6;
      --separator: rgba(232, 234, 237, 0.16);
      --font: 26px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html,
    body {
      margin: 0;
      width: 522px;
      min-height: 724px;
      overflow: hidden;
      background: transparent;
      font: var(--font);
      color: var(--text);
    }

    .popup {
      width: 522px;
      min-height: 724px;
      padding: 8px;
      background: var(--surface);
      border: 1px solid rgba(255,255,255,0.14);
    }

    .item {
      min-height: 56px;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 8px 24px;
      border-radius: 8px;
      white-space: nowrap;
    }

    .icon {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
    }

    .title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .count {
      color: var(--muted);
      font-size: 23px;
      padding-left: 16px;
    }

    .separator {
      height: 2px;
      margin: 8px 20px;
      background: var(--separator);
    }

    .favicon-frame {
      width: 32px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .favicon-frame.favicon-tile {
      border-radius: 6px;
      background: #fff;
    }

    .favicon {
      width: 32px;
      height: 32px;
      display: block;
      object-fit: contain;
    }

    .favicon-tile .favicon {
      width: 24px;
      height: 24px;
    }

    .apps .glyph {
      width: 6px;
      height: 6px;
      border-radius: 2px;
      background: currentColor;
      box-shadow:
        -10px -10px 0 currentColor,
        0 -10px 0 currentColor,
        10px -10px 0 currentColor,
        -10px 0 0 currentColor,
        10px 0 0 currentColor,
        -10px 10px 0 currentColor,
        0 10px 0 currentColor,
        10px 10px 0 currentColor;
    }

    .tab-groups .glyph {
      width: 28px;
      height: 28px;
      background: currentColor;
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Crect x='2.2' y='2.2' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='9' y='2.2' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='2.2' y='9' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='9' y='9' width='4.8' height='4.8' rx='0.7'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Crect x='2.2' y='2.2' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='9' y='2.2' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='2.2' y='9' width='4.8' height='4.8' rx='0.7'/%3E%3Crect x='9' y='9' width='4.8' height='4.8' rx='0.7'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
    }

    .other .glyph,
    .mobile .glyph,
    .folder .glyph {
      width: 32px;
      height: 32px;
      background: currentColor;
    }

    .other .glyph {
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M2.5 5.4h11v7.1c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V5.4Z'/%3E%3Cpath d='M4.2 5.4V3.5c0-.6.4-1 1-1h5.6c.6 0 1 .4 1 1v1.9'/%3E%3Cpath d='M6 7.8h4'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.4' stroke-linejoin='round'%3E%3Cpath d='M2.5 5.4h11v7.1c0 .6-.4 1-1 1h-9c-.6 0-1-.4-1-1V5.4Z'/%3E%3Cpath d='M4.2 5.4V3.5c0-.6.4-1 1-1h5.6c.6 0 1 .4 1 1v1.9'/%3E%3Cpath d='M6 7.8h4'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
    }

    .mobile .glyph {
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.35' stroke-linejoin='round'%3E%3Crect x='4.4' y='1.8' width='7.2' height='12.4' rx='1.2'/%3E%3Cpath d='M7 3.7h2'/%3E%3Cpath d='M7.4 12.1h1.2'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='none' stroke='black' stroke-width='1.35' stroke-linejoin='round'%3E%3Crect x='4.4' y='1.8' width='7.2' height='12.4' rx='1.2'/%3E%3Cpath d='M7 3.7h2'/%3E%3Cpath d='M7.4 12.1h1.2'/%3E%3C/g%3E%3C/svg%3E") center / 32px 32px no-repeat;
    }

    .folder .glyph {
      -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.05c.38 0 .74.17.98.46l.72.84H13c.69 0 1.25.56 1.25 1.25v6.2c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-7.5Z' fill='none' stroke='black' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") center / 36px 36px no-repeat;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.05c.38 0 .74.17.98.46l.72.84H13c.69 0 1.25.56 1.25 1.25v6.2c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-7.5Z' fill='none' stroke='black' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") center / 36px 36px no-repeat;
    }
  </style>
</head>
<body>
  <main class="popup" aria-label="Bookmarks Menu">
    ${rows.map((row) => row.sep ? '<div class="separator"></div>' : `
      <div class="item ${row.type}">
        <span class="icon">${iconMarkup(row)}</span>
        <span class="title">${row.title}</span>
        ${Number.isFinite(row.count) ? `<span class="count">${row.count}</span>` : ''}
      </div>
    `).join('')}
  </main>
</body>
</html>`;
}

async function main() {
  if (!fs.existsSync(browserBin)) {
    throw new Error(`Chrome for Testing was not found at ${browserBin}`);
  }

  await inlineFavicons();
  fs.writeFileSync(htmlPath, renderHtml());

  const debugPort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-menu-shot-'));
  const chrome = spawn(
    browserBin,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--headless=new',
      `file://${htmlPath}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let cdp;
  try {
    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready();

    const { targetId } = await cdp.send('Target.createTarget', { url: `file://${htmlPath}` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 522,
      height: 724,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await cdp.send('Page.navigate', { url: `file://${htmlPath}` }, sessionId);
    await sleep(500);

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    }, sessionId);
    fs.writeFileSync(outputPath, Buffer.from(shot.data, 'base64'));
    console.log(outputPath);
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
});

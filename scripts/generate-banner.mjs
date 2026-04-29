import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findChromeForTesting } from './chrome-for-testing.mjs';

const repoDir = path.resolve(process.cwd());
const browserBin = findChromeForTesting(repoDir);
const popupPath = path.join(repoDir, 'assets/preview.png');
const iconPath = path.join(repoDir, 'icons/icon32.png');
const outputPath = path.join(repoDir, 'assets/banner.png');
const htmlPath = path.join(os.tmpdir(), 'flymarks-listing-screenshot.html');
const viewport = { width: 640, height: 400 };

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
      throw new Error('WebSocket is unavailable. Run with: npm run banner');
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

function renderHtml(popupDataUrl, iconDataUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Flymarks Listing Screenshot</title>
  <style>
    * { box-sizing: border-box; }

    html,
    body {
      margin: 0;
      width: ${viewport.width}px;
      height: ${viewport.height}px;
      overflow: hidden;
      background: #0f1115;
      color: #e8eaed;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .stage {
      width: 100%;
      height: 100%;
      padding: 12px 22px;
      background:
        radial-gradient(circle at 16% 15%, rgba(66, 133, 244, 0.18), transparent 30%),
        linear-gradient(135deg, #15181e 0%, #0f1115 100%);
    }

    .browser {
      position: relative;
      width: 596px;
      height: 376px;
      overflow: hidden;
      border: 1px solid #30343b;
      border-radius: 10px;
      background: #202124;
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.45);
    }

    .toolbar {
      height: 46px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 14px;
      border-bottom: 1px solid #30343b;
      background: #2d2e31;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #5f6368;
    }

    .address {
      height: 28px;
      flex: 1;
      display: flex;
      align-items: center;
      padding: 0 12px;
      border-radius: 999px;
      background: #202124;
      color: #9aa0a6;
    }

    .toolbar-icon {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      color: #9aa0a6;
    }

    .toolbar-icon.active {
      border-radius: 5px;
      background: #3a3d41;
    }

    .extension-icon {
      width: 16px;
      height: 16px;
      display: block;
    }

    .page {
      position: absolute;
      inset: 46px 0 0;
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: 28px;
      padding: 32px;
      background: #181a1f;
    }

    .hero h1 {
      margin: 0 0 10px;
      font-size: 32px;
      line-height: 1.05;
      letter-spacing: 0;
    }

    .hero p {
      width: 230px;
      margin: 0 0 20px;
      color: #bdc1c6;
      font-size: 14px;
    }

    .bar {
      height: 12px;
      margin: 11px 0;
      border-radius: 999px;
      background: #30343b;
    }

    .bar.short { width: 72%; }
    .bar.medium { width: 88%; }
    .bar.long { width: 100%; }

    .preview {
      border: 1px solid #30343b;
      border-radius: 8px;
      padding: 14px;
      background: #202124;
    }

    .card {
      height: 46px;
      margin-bottom: 10px;
      border-radius: 7px;
      background: #2d2e31;
    }

    .popup {
      position: absolute;
      top: 16px;
      right: 42px;
      width: 261px;
      height: 362px;
      filter: drop-shadow(0 18px 26px rgba(0, 0, 0, 0.42));
    }

    .pin {
      position: absolute;
      top: 33px;
      right: 142px;
      width: 12px;
      height: 12px;
      transform: rotate(45deg);
      background: #2d2e31;
      border-left: 1px solid rgba(255,255,255,0.14);
      border-top: 1px solid rgba(255,255,255,0.14);
    }
  </style>
</head>
<body>
  <main class="stage">
    <section class="browser" aria-label="Flymarks in Chrome">
      <div class="toolbar">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
        <div class="address">example.com</div>
        <div class="toolbar-icon">★</div>
        <div class="toolbar-icon active"><img class="extension-icon" src="${iconDataUrl}" alt=""></div>
      </div>
      <div class="page">
        <div class="hero">
          <h1>Flymarks</h1>
          <p>A clean, compact dropdown for your Chrome bookmarks.</p>
          <div class="bar long"></div>
          <div class="bar medium"></div>
          <div class="bar short"></div>
        </div>
        <div class="preview">
          <div class="card"></div>
          <div class="card"></div>
          <div class="card"></div>
        </div>
      </div>
      <div class="pin"></div>
      <img class="popup" src="${popupDataUrl}" alt="">
    </section>
  </main>
</body>
</html>`;
}

async function main() {
  if (!fs.existsSync(browserBin)) {
    throw new Error(`Chrome for Testing was not found at ${browserBin}`);
  }
  if (!fs.existsSync(popupPath)) {
    throw new Error('assets/preview.png was not found. Run npm run preview first.');
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Extension icon was not found at ${iconPath}`);
  }

  const popupDataUrl = `data:image/png;base64,${fs.readFileSync(popupPath).toString('base64')}`;
  const iconDataUrl = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;
  fs.writeFileSync(htmlPath, renderHtml(popupDataUrl, iconDataUrl));

  const debugPort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flymarks-listing-'));
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
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await cdp.send('Page.navigate', { url: `file://${htmlPath}` }, sessionId);
    await sleep(300);

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

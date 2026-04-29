import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findChromeForTesting } from './chrome-for-testing.mjs';

const repoDir = path.resolve(process.cwd());
const fresh = process.argv.includes('--fresh');
const profileDir = fresh
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'flymarks-ext-manual.'))
  : path.join(os.tmpdir(), 'flymarks-ext-manual');
const browserBin = findChromeForTesting(repoDir);

const chrome = spawn(
  browserBin,
  [
    '--use-mock-keychain',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--load-extension=${repoDir}`,
  ],
  { stdio: 'inherit' },
);

chrome.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

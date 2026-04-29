import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoDir = path.resolve(process.cwd());
const distDir = path.join(repoDir, 'dist');
const zipPath = path.join(distDir, 'bookmarks-menu.zip');
const files = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

for (const file of files) {
  if (!fs.existsSync(path.join(repoDir, file))) {
    throw new Error(`Missing package file: ${file}`);
  }
}

execFileSync('zip', ['-q', '-X', zipPath, ...files], { cwd: repoDir, stdio: 'inherit' });
console.log(zipPath);
